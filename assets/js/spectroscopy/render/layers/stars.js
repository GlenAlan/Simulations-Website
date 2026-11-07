// GPU sprites for everything that looks like a point in the sky, as instanced quads: stars, multiple stars, neutron
// stars, black holes' companions, quasars and supernovae. Other layers add detail on top of some of these. Home
// planets and rogue planets have their own layers (home_planets.js, rogue_planets.js).
//
// Colour comes from temperature. Brightness and size come from how far a body's magnitude is above the zoom's
// limit, so faint stars appear as you zoom in. Other bands use the body's strength in that band and the band's tint.
// A second instanced mesh draws thin diffraction spikes for the brightest, skipped entirely at Low.

import * as THREE from 'three';
import { bus } from '../../core/state.js';
import { hashString } from '../../core/rng.js';
import { azAltToVec3 } from '../../core/sky.js';
import { blackBodyRGB } from '../../core/phys.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';

const POINT_KINDS = new Set(['star', 'binary', 'multiple', 'neutron_star', 'black_hole', 'quasar', 'supernova']);
const SKY_RADIUS = 1000;

// A body's colour: the mix of its stars' black-body colours, weighted by how much light each gives
function bodyColour(body) {
    if (body.star) return blackBodyRGB(body.star.teff_K);
    if (body.stars && body.stars.length) {
        const sum = [0, 0, 0];
        let total = 0;
        body.stars.forEach((member) => {
            const weight = Math.max(1e-4, member.star.luminosity_Lsun || 1);
            const c = blackBodyRGB(member.star.teff_K);
            sum[0] += c[0] * weight;
            sum[1] += c[1] * weight;
            sum[2] += c[2] * weight;
            total += weight;
        });
        return sum.map((c) => c / total);
    }
    if (body.black_hole) return blackBodyRGB(body.black_hole.companion.star.teff_K);
    if (body.kind === 'quasar') return blackBodyRGB(20000);
    if (body.kind === 'neutron_star') return blackBodyRGB((body.neutron_star && body.neutron_star.teff_K) || 30000);
    if (body.kind === 'supernova') return blackBodyRGB(12000);
    return blackBodyRGB(6000);
}

// Giants look soft and swollen; white dwarfs and neutron stars tiny and sharp. 1 is an ordinary star.
function bodySoftness(body) {
    const star = body.star;
    if (star) {
        if (star.stage === 'giant' || star.stage === 'supergiant') return star.stage === 'supergiant' ? 1.7 : 1.4;
        if (star.stage === 'white_dwarf') return 0.55;
    }
    if (body.kind === 'neutron_star') return 0.5;
    if (body.kind === 'quasar') return 0.7;
    return 1;
}

// The magnitude scale: e is how many magnitudes above the zoom's limit, compressed so that a -2 star doesn't wash
// out the sky. Shared by the sprite and spike shaders so the two agree.
const LEVEL_GLSL = /* glsl */`
attribute vec3 aCentre;
attribute vec3 aColour;
attribute float aMag;
attribute vec4 aBandA;
attribute float aBandB;
attribute float aSeed;
attribute float aSoft;
attribute float aFlux;
uniform float uDpr;
varying vec2 vUv;

// 1 at the widest zoom, shrinking so that stars stay crisp points through a narrow field
float crispness() {
    return mix(0.62, 1.0, smoothstep(0.7, 2.0, log(uFov + 0.5) * 0.72));
}

float visibleLevel(float mag, float strength) {
    float margin = uLimitMag - mag;
    return strength > 0.01 ? margin + 2.5 * log(strength + 1e-5) * 0.4343 * 0.5 : -1.0;
}

// In other bands the strength is all there is. Compressed, so 0.02 is a dim dot and 1.0 is a beacon.
float otherLevel(vec4 a, float b) {
    float s = a.x * uBandW[0] + a.y * uBandW[1] + a.w * uBandW[3] + b * uBandW[4];
    float total = max(uBandW[0] + uBandW[1] + uBandW[3] + uBandW[4], 1e-4);
    s /= total;
    return s > 0.01 ? 0.9 + 9.0 * pow(s, 0.55) : -1.0;
}

// How much the air scintillates a star: stronger towards the horizon
float twinkle(vec3 dir, float seed) {
    if (uTwinkle <= 0.0) return 1.0;
    float amount = mix(0.07, 0.42, exp(-max(dir.y, 0.0) / 0.32));
    float a = sin(uTime * (2.1 + seed * 2.9) + seed * 71.0);
    float b = sin(uTime * (3.7 + seed * 4.3) + seed * 23.0);
    return 1.0 + uTwinkle * amount * (0.6 * a + 0.4 * b * a);
}
`;

function instancedAttributes(geometry, data) {
    geometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(data.centres, 3));
    geometry.setAttribute('aColour', new THREE.InstancedBufferAttribute(data.colours, 3));
    geometry.setAttribute('aMag', new THREE.InstancedBufferAttribute(data.mags, 1));
    geometry.setAttribute('aBandA', new THREE.InstancedBufferAttribute(data.bandA, 4));
    geometry.setAttribute('aBandB', new THREE.InstancedBufferAttribute(data.bandB, 1));
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(data.seeds, 1));
    geometry.setAttribute('aSoft', new THREE.InstancedBufferAttribute(data.soft, 1));
    geometry.setAttribute('aFlux', data.flux);
    geometry.instanceCount = data.count;
}

function createSprites(data) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    instancedAttributes(geometry, data);

    const material = skyMaterial({
        uniforms: { uDpr: { value: 1 } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            ${LEVEL_GLSL}
            varying vec3 vColour;
            varying vec4 vShape;    // Quad radius, core sigma, halo radius, halo strength (all device px, bar the last)
            varying float vPeak;
            void main() {
                float wVis = uBandW[2];
                float levelVis = visibleLevel(aMag, aBandA.z);
                float levelOther = otherLevel(aBandA, aBandB);
                // A level below zero means not shown in that band
                float amountVis = wVis * smoothstep(0.0, 1.3, levelVis);
                float amountOther = (1.0 - wVis) * smoothstep(0.0, 0.9, levelOther);
                float amount = (amountVis + amountOther) * aFlux * uSkyFade;
                if (amount <= 0.002) {
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    return;
                }
                float e = clamp(mix(max(levelOther, 0.0), max(levelVis, 0.0), wVis), 0.0, 9.5);
                e += 2.5 * log(max(aFlux, 0.01)) * 0.4343;
                e = max(e, 0.0);

                vec3 dir = aCentre / ${SKY_RADIUS.toFixed(1)};
                float air = exp(-0.05 / (max(dir.y, 0.0) + 0.05));
                float glint = twinkle(dir, aSeed);
                float size = uDpr * crispness();

                float sigma = (0.68 + 0.115 * e) * size * mix(1.0, aSoft, 0.55);
                float haloR = sigma * (2.1 + 0.28 * e) * aSoft;
                float quad = sigma * 3.0 + haloR * (3.0 + 0.5 * e);

                vPeak = (0.16 + 0.28 * pow(10.0, 0.19 * e)) * amount * air * glint;
                float haloAmp = (0.005 + 0.0085 * e * e) * amount * air * mix(1.0, glint, 0.5);
                vShape = vec4(quad, sigma, haloR, haloAmp);

                // Real colour shows in the halo: the core saturates to white in tone mapping
                vec3 c = aColour / max(max(aColour.r, aColour.g), aColour.b);
                vColour = bandColour(c);

                vUv = position.xy;
                vec4 clip = projectionMatrix * modelViewMatrix * vec4(aCentre, 1.0);
                clip.xy += position.xy * quad * 2.0 / uViewport * clip.w;
                gl_Position = clip;
            }`,
        fragmentShader: /* glsl */`
            varying vec2 vUv;
            varying vec3 vColour;
            varying vec4 vShape;
            varying float vPeak;
            void main() {
                float u = length(vUv);
                if (u >= 1.0) discard;
                float r = u * vShape.x;
                float core = exp(-r * r / (2.0 * vShape.y * vShape.y));
                // Moffat wings: the soft glow real optics put around a star
                float wing = 1.0 / pow(1.0 + r * r / (vShape.z * vShape.z), 1.75);
                float window = 1.0 - u * u;
                window *= window;
                vec3 tint = mix(vColour, vColour * vColour, 0.35);   // A little richer in the halo than the core
                gl_FragColor = vec4(vColour * vPeak * core + tint * vShape.w * wing * window, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.stars;
    return { mesh, geometry, material };
}

// Spikes: two long thin quads per star. Far cheaper than covering the whole square a spike reaches into.
function createSpikes(data) {
    const geometry = new THREE.InstancedBufferGeometry();
    // position.xy = along, across; z picks which of the two arms
    const arms = [];
    [0, 1].forEach((arm) => arms.push(-1, -1, arm, 1, -1, arm, 1, 1, arm, -1, 1, arm));
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arms), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    instancedAttributes(geometry, data);

    const material = skyMaterial({
        uniforms: { uDpr: { value: 1 } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            ${LEVEL_GLSL}
            varying vec3 vColour;
            varying float vLength;
            varying float vWidth;
            const float ANGLE = 0.46;   // All spikes share one angle: they come from the telescope, not the star
            void main() {
                float levelVis = visibleLevel(aMag, aBandA.z) + 2.5 * log(max(aFlux, 0.01)) * 0.4343;
                float e = clamp(levelVis, 0.0, 9.0);
                // Only the brightest, in visible light, fading in rather than popping
                float k = smoothstep(5.6, 7.6, e) * uBandW[2] * uSkyFade;
                if (k <= 0.002) {
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    return;
                }
                vec3 dir = aCentre / ${SKY_RADIUS.toFixed(1)};
                float air = exp(-0.05 / (max(dir.y, 0.0) + 0.05));
                float size = uDpr * crispness();
                vLength = (12.0 + 7.0 * (e - 5.0) * (e - 5.0)) * size * k;
                vWidth = (1.2 + 0.12 * e) * size * 3.0;
                vec3 c = aColour / max(max(aColour.r, aColour.g), aColour.b);
                vColour = c * k * air * twinkle(dir, aSeed) * (0.32 + 0.22 * (e - 5.0));
                vUv = position.xy;

                float angle = ANGLE + position.z * 1.5707963;
                vec2 axis = vec2(cos(angle), sin(angle));
                vec2 side = vec2(-axis.y, axis.x);
                vec2 offset = axis * position.x * vLength + side * position.y * vWidth;
                vec4 clip = projectionMatrix * modelViewMatrix * vec4(aCentre, 1.0);
                clip.xy += offset * 2.0 / uViewport * clip.w;
                gl_Position = clip;
            }`,
        fragmentShader: /* glsl */`
            varying vec2 vUv;
            varying vec3 vColour;
            varying float vLength;
            varying float vWidth;
            void main() {
                float along = abs(vUv.x);
                // Thin across, with a slow rainbow along: light of each colour diffracts to a different length
                float across = exp(-vUv.y * vUv.y * 22.0);
                vec3 reach = pow(max(1.0 - along, 0.0) * vec3(1.0), vec3(1.7, 2.4, 3.3));
                float falloff = 1.0 / (1.0 + along * along * 60.0);
                vec3 ripple = 1.0 + 0.22 * cos(along * 26.0 + vec3(0.0, 2.1, 4.2));
                gl_FragColor = vec4(vColour * reach * ripple * across * falloff, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.stars + 1;
    return { mesh, geometry, material };
}

export function createStarsLayer(engine, app) {
    const bodies = app.universe.bodies.filter((b) => POINT_KINDS.has(b.kind));
    const n = bodies.length;
    const data = {
        count: n,
        centres: new Float32Array(n * 3),
        colours: new Float32Array(n * 3),
        mags: new Float32Array(n),
        bandA: new Float32Array(n * 4),
        bandB: new Float32Array(n),
        seeds: new Float32Array(n),
        soft: new Float32Array(n),
        // One value per star that another layer can change while the sim runs: see setSpriteFlux
        flux: new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1)
    };
    data.flux.setUsage(THREE.DynamicDrawUsage);
    const indexOf = new Map();
    bodies.forEach((body, i) => {
        indexOf.set(body.code, i);
        const v = azAltToVec3(body.sky.az, body.sky.alt);
        data.centres.set([v[0] * SKY_RADIUS, v[1] * SKY_RADIUS, v[2] * SKY_RADIUS], i * 3);
        data.colours.set(bodyColour(body), i * 3);
        data.mags[i] = body.brightness.mag;
        data.bandA.set([body.bands.radio, body.bands.ir, body.bands.visible, body.bands.uv], i * 4);
        data.bandB[i] = body.bands.xray;
        data.seeds[i] = hashString(body.visual_seed || body.code) / 4294967296;
        data.soft[i] = bodySoftness(body);
    });

    const sprites = createSprites(data);
    const spikes = createSpikes(data);
    engine.scene.add(sprites.mesh);
    engine.scene.add(spikes.mesh);

    const applyQuality = (level) => { spikes.mesh.visible = level !== 'low'; };
    applyQuality(app.qualityLevel);
    const unbindQuality = bus.on('quality', ({ level }) => applyQuality(level));

    return {
        id: 'stars',
        update(frame) {
            sprites.material.uniforms.uDpr.value = frame.dpr;
            spikes.material.uniforms.uDpr.value = frame.dpr;
        },
        // For a layer whose body changes brightness (a supernova) or draws its own sprite: multiplies the sprite's
        // brightness by this factor. 1 is normal; 0 hides it.
        setSpriteFlux(code, factor) {
            const i = indexOf.get(code);
            if (i === undefined || data.flux.array[i] === factor) return;
            data.flux.array[i] = factor;
            data.flux.needsUpdate = true;
        },
        dispose() {
            unbindQuality();
            [sprites, spikes].forEach((part) => {
                engine.scene.remove(part.mesh);
                part.geometry.dispose();
                part.material.dispose();
            });
        }
    };
}
