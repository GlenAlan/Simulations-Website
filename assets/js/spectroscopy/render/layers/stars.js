// GPU sprites for everything that looks like a point in the sky, as instanced quads: stars, multiple stars, neutron
// stars, black holes' companions, quasars and supernovae. Other layers add detail on top of some of these. Home
// planets and rogue planets have their own layers (home_planets.js, rogue_planets.js).
//
// Colour comes from temperature, or the band's false colour. Brightness and size come from the body's glow in the
// band (data/band_table.js), so faint objects appear as you zoom in, in every band. A second instanced mesh draws thin
// diffraction spikes for the brightest, and is skipped entirely at Low.

import * as THREE from 'three';
import { bus } from '../../core/state.js';
import { BANDS } from '../../core/bands.js';
import { hashString } from '../../core/rng.js';
import { azAltToVec3 } from '../../core/sky.js';
import { blackBodyRGB } from '../../core/phys.js';
import { bandSkyBrightness } from '../../data/band_table.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { MIN_GLOW } from '../engine.js';

const POINT_KINDS = new Set(['star', 'binary', 'multiple', 'neutron_star', 'black_hole', 'quasar', 'supernova']);
const SKY_RADIUS = 1000;

export const SPLIT_LO = 6;     // Device pixels between two stars when they start to come apart...
export const SPLIT_HI = 13;    // ...and when they have

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
export function bodySoftness(body) {
    const star = body.star;
    if (star) {
        if (star.stage === 'giant' || star.stage === 'supergiant') return star.stage === 'supergiant' ? 1.7 : 1.4;
        if (star.stage === 'white_dwarf') return 0.55;
    }
    if (body.kind === 'neutron_star') return 0.5;
    if (body.kind === 'quasar') return 0.7;
    return 1;
}

// A body's glow is 1 at the zoom's limiting magnitude and 0.05 (not drawn) a little over 3 magnitudes fainter, in the
// magnitude scale of whichever band is showing. So every band shares one set of sprite shapes. engine.bodyShows applies
// the same rule to picking. Shared by the sprite and spike shaders so the two agree.
const SPRITE_GLSL = /* glsl */`
attribute vec3 aCentre;
attribute vec3 aColour;
attribute vec4 aBandA;
attribute float aBandB;
attribute float aSeed;
attribute float aSoft;
attribute float aFlux;
attribute float aDepth;
attribute vec2 aSplit;      // Degrees, in a multiple star: from its sibling, and between its own members. 0 where there are none
attribute float aSpike;     // 0 for a point that must never grow spikes
uniform float uDpr;
varying vec2 vUv;

float resolved(float deg) {
    return smoothstep(${SPLIT_LO.toFixed(1)}, ${SPLIT_HI.toFixed(1)}, radians(deg) * uPxPerRad * depthP(aDepth));
}

// A multiple star's point shows until it comes apart: its members (binaries.js) take over as it goes
float splitShows() {
    return (aSplit.x > 0.0 ? resolved(aSplit.x) : 1.0) * (1.0 - resolved(aSplit.y));
}

float skyGlow() {
    return clamp(bandAmount(aBandA, aBandB) * pow(10.0, 0.4 * (uLimitMag - 6.0)) * aFlux, 0.0, 400.0);
}

// Glow as magnitudes above the point where a sprite starts to be drawn: 0 up to about 9.75
float glowLevel(float glow) {
    return max(1.0857 * log(max(glow, ${MIN_GLOW.toFixed(3)})) + 3.25, 0.0);
}

// 1 at wide zoom, shrinking so that stars stay crisp points through a narrow field
float crispness() {
    return mix(0.62, 1.0, smoothstep(0.7, 2.0, log(uFov + 0.5) * 0.72));
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
    geometry.setAttribute('aCentre', data.centres);
    geometry.setAttribute('aColour', new THREE.InstancedBufferAttribute(data.colours, 3));
    geometry.setAttribute('aBandA', new THREE.InstancedBufferAttribute(data.bandA, 4));
    geometry.setAttribute('aBandB', new THREE.InstancedBufferAttribute(data.bandB, 1));
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(data.seeds, 1));
    geometry.setAttribute('aSoft', new THREE.InstancedBufferAttribute(data.soft, 1));
    geometry.setAttribute('aDepth', new THREE.InstancedBufferAttribute(data.depths, 1));
    geometry.setAttribute('aFlux', data.flux);
    geometry.setAttribute('aSplit', data.split);
    geometry.setAttribute('aSpike', new THREE.InstancedBufferAttribute(data.spike, 1));
    geometry.instanceCount = data.count;
}

export function createSprites(data) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    instancedAttributes(geometry, data);

    const material = skyMaterial({
        uniforms: { uDpr: { value: 1 } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            ${SPRITE_GLSL}
            varying vec3 vColour;
            varying vec4 vShape;    // Quad radius, core sigma, halo radius, halo strength (all device px, bar the last)
            varying float vPeak;
            void main() {
                float glow = skyGlow();
                float shows = splitShows();
                if (glow < ${MIN_GLOW.toFixed(3)} || uSkyFade <= 0.0 || shows <= 0.002) {
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    return;
                }
                float m = glowLevel(glow);
                // Fades in from nothing rather than popping as the zoom crosses its threshold
                float amount = smoothstep(0.0, 2.2, m) * uSkyFade * shows;

                vec3 dir = aCentre / ${SKY_RADIUS.toFixed(1)};
                float air = exp(-0.05 / (max(dir.y, 0.0) + 0.05));
                float glint = twinkle(dir, aSeed);
                float size = uDpr * crispness();

                // Never under about a pixel across, or a faint star would flicker as it crosses pixel boundaries
                float sigma = max((0.58 + 0.095 * m) * size * mix(1.0, aSoft, 0.55), 0.55 * uDpr);
                float haloR = sigma * (1.5 + 0.22 * m) * aSoft;
                // Faint stars have no halo worth drawing, and they are most of them: keep their quads tiny
                float quad = sigma * 3.0 + haloR * (2.5 + 0.42 * m) * smoothstep(2.5, 6.0, m);

                // Compressed: true flux would run to a thousand times this, and wash out the whole sky
                vPeak = 0.028 * pow(10.0, 0.293 * m) * amount * air * glint;
                float haloAmp = 0.0006 * m * m * m * amount * air * mix(1.0, glint, 0.5);
                vShape = vec4(quad, sigma, haloR, haloAmp);

                // Real colour shows in the halo: the core saturates to white in tone mapping
                vec3 c = aColour / max(max(aColour.r, aColour.g), aColour.b);
                vColour = bandColour(c);

                vUv = position.xy;
                vec4 clip = projectionMatrix * modelViewMatrix * vec4(aCentre, 1.0);
                clip.xy *= depthP(aDepth);
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
                float wing = 1.0 / (1.0 + r * r / (vShape.z * vShape.z));
                wing *= wing;
                float window = 1.0 - u * u;
                window *= window;
                vec3 tint = mix(vColour, vColour * vColour, 0.15);   // A little richer in the halo than the core
                gl_FragColor = vec4(vColour * vPeak * core + tint * vShape.w * wing * window, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.stars;
    return { mesh, geometry, material };
}

// Spikes: two long thin quads per star. Far cheaper than covering the whole square a spike reaches into.
export function createSpikes(data) {
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
            ${SPRITE_GLSL}
            varying vec3 vColour;
            const float ANGLE = 0.46;   // All spikes share one angle: they come from the telescope, not the star
            void main() {
                // Only the brightest, in visible light, fading in rather than popping
                float glow = clamp(aBandA.z * pow(10.0, 0.4 * (uLimitMag - 6.0)) * aFlux, 0.0, 400.0);
                float m = glowLevel(glow);
                float k = smoothstep(6.6, 8.4, m) * uBandW[2] * uSkyFade * aSpike * splitShows();
                if (k <= 0.002) {
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    return;
                }
                vec3 dir = aCentre / ${SKY_RADIUS.toFixed(1)};
                float air = exp(-0.05 / (max(dir.y, 0.0) + 0.05));
                float size = uDpr * crispness();
                float reach = m - 5.8;
                // White dwarfs and neutron stars stay tiny and sharp, however bright a narrow view makes them
                float len = (10.0 + 4.2 * reach * reach) * size * k * mix(0.45, 1.0, smoothstep(0.55, 1.0, aSoft));
                float width = (1.2 + 0.1 * m) * size * 3.0;
                vec3 c = aColour / max(max(aColour.r, aColour.g), aColour.b);
                vColour = c * k * air * twinkle(dir, aSeed) * (0.55 + 0.32 * reach);
                vUv = position.xy;

                float angle = ANGLE + position.z * 1.5707963;
                vec2 axis = vec2(cos(angle), sin(angle));
                vec2 side = vec2(-axis.y, axis.x);
                vec2 offset = axis * position.x * len + side * position.y * width;
                vec4 clip = projectionMatrix * modelViewMatrix * vec4(aCentre, 1.0);
                clip.xy *= depthP(aDepth);
                clip.xy += offset * 2.0 / uViewport * clip.w;
                gl_Position = clip;
            }`,
        fragmentShader: /* glsl */`
            varying vec2 vUv;
            varying vec3 vColour;
            void main() {
                float along = abs(vUv.x);
                // Thin across, with a slow rainbow along: light of each colour diffracts to a different length
                float across = exp(-vUv.y * vUv.y * 22.0);
                vec3 reach = pow(max(1.0 - along, 0.0) * vec3(1.0), vec3(1.7, 2.4, 3.3));
                float falloff = 1.0 / (1.0 + along * along * 26.0);
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
        centres: new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3),
        colours: new Float32Array(n * 3),
        bandA: new Float32Array(n * 4),
        bandB: new Float32Array(n),
        seeds: new Float32Array(n),
        soft: new Float32Array(n),
        depths: new Float32Array(n),
        // One value per star that another layer can change while the sim runs: see setSpriteFlux
        flux: new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1),
        split: new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2),
        spike: new Float32Array(n)
    };
    data.flux.setUsage(THREE.DynamicDrawUsage);
    data.split.setUsage(THREE.DynamicDrawUsage);
    const indexOf = new Map();
    bodies.forEach((body, i) => {
        indexOf.set(body.code, i);
        const v = azAltToVec3(body.sky.az, body.sky.alt);
        data.centres.array.set([v[0] * SKY_RADIUS, v[1] * SKY_RADIUS, v[2] * SKY_RADIUS], i * 3);
        data.colours.set(bodyColour(body), i * 3);
        // In BANDS order: radio, infrared, visible, ultraviolet here, and X-ray in aBandB
        const glow = BANDS.map((band) => bandSkyBrightness(body, band));
        data.bandA.set(glow.slice(0, 4), i * 4);
        data.bandB[i] = glow[4];
        data.seeds[i] = hashString(body.visual_seed || body.code) / 4294967296;
        data.soft[i] = bodySoftness(body);
        data.depths[i] = body.depth;
        // A black hole's companion sits inside the lens, which would bend its spikes into grey blocks round the disc
        data.spike[i] = body.kind === 'black_hole' ? 0 : 1;
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
        // glow by this factor. 1 is normal; 0 hides it.
        setSpriteFlux(code, factor) {
            const i = indexOf.get(code);
            if (i === undefined || data.flux.array[i] === factor) return;
            data.flux.array[i] = factor;
            data.flux.needsUpdate = true;
        },
        // A multiple star's point goes out as it comes apart into its members, at this separation in degrees
        setSpriteSplit(code, sepDeg) {
            const i = indexOf.get(code);
            if (i === undefined || data.split.array[i * 2 + 1] === sepDeg) return;
            data.split.array[i * 2 + 1] = sepDeg;
            data.split.needsUpdate = true;
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
