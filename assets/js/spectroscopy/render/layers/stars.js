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
import { azAltToVec3, limitingMag } from '../../core/sky.js';
import { blackBodyRGB } from '../../core/phys.js';
import { bandSkyBrightness } from '../../data/band_table.js';
import { skyMaterial, sharedUniforms, BAND_GLSL, ORDER } from '../shared.js';
import { MIN_GLOW } from '../engine.js';
import { travelPc } from '../../core/depth.js';

const POINT_KINDS = new Set(['star', 'binary', 'multiple', 'neutron_star', 'black_hole', 'quasar', 'supernova']);
const SKY_RADIUS = 1000;
const RAD = Math.PI / 180;

export const SPLIT_LO = 6;     // Device pixels between two stars when they start to come apart...
export const SPLIT_HI = 13;    // ...and when they have
const SPIKE_GLOW = 21.9;       // The glow at which a point's spikes start (glowLevel 6.6: see createSpikes)
const SPARE = 0.9;             // What can show is worked out with this much to spare in glow, and 2% in separation

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
attribute float aPc;        // Its distance, for a flight into a system: see travel() in render/shared.js
attribute vec2 aSplit;      // Degrees, in a multiple star: from its sibling, and between its own members. 0 where there are none
attribute float aSpike;     // 0 for a point that must never grow spikes
uniform float uDpr;
varying vec2 vUv;

// grow: how much a flight has brought it nearer (travelSize), which spreads a multiple's stars as zooming does
float resolved(float deg, float grow) {
    return smoothstep(${SPLIT_LO.toFixed(1)}, ${SPLIT_HI.toFixed(1)}, radians(deg) * uPxPerRad * depthP(aDepth) * grow);
}

// A multiple star's point shows until it comes apart: its members (binaries.js) take over as it goes
float splitShows(float grow) {
    return (aSplit.x > 0.0 ? resolved(aSplit.x, grow) : 1.0) * (1.0 - resolved(aSplit.y, grow));
}

// near: how much nearer a flight has brought it (travel), which brightens it as the inverse square
float skyGlow(float near) {
    return clamp(bandAmount(aBandA, aBandB) * pow(10.0, 0.4 * (uLimitMag - 6.0)) * aFlux * travelLight(near), 0.0, 400.0);
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
    geometry.setAttribute('aPc', new THREE.InstancedBufferAttribute(data.pcs, 1));
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
                vec3 centre = aCentre;
                float near = travel(centre, aPc);
                float glow = skyGlow(near);
                float shows = splitShows(travelSize(near));
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
                // X-ray sources are hard points in a black sky, not balls of cotton
                float haloR = sigma * (1.5 + 0.22 * m) * aSoft * mix(1.0, 0.6, uBandW[4]);
                // Faint stars have no halo worth drawing, and they are most of them: keep their quads tiny
                float quad = sigma * 3.0 + haloR * (2.5 + 0.42 * m) * smoothstep(2.5, 6.0, m);

                // Compressed: true flux would run to a thousand times this, and wash out the whole sky
                vPeak = 0.028 * pow(10.0, 0.293 * m) * amount * air * glint;
                float haloAmp = 0.0006 * m * m * m * amount * air * mix(1.0, glint, 0.5) * mix(1.0, 0.3, uBandW[4]);
                vShape = vec4(quad, sigma, haloR, haloAmp);

                // Real colour shows in the halo: the core saturates to white in tone mapping
                vec3 c = aColour / max(max(aColour.r, aColour.g), aColour.b);
                vColour = bandColour(c);

                vUv = position.xy;
                vec4 clip = projectionMatrix * modelViewMatrix * vec4(centre, 1.0);
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
                vec3 centre = aCentre;
                float near = travel(centre, aPc);
                float glow = clamp(aBandA.z * pow(10.0, 0.4 * (uLimitMag - 6.0)) * aFlux * travelLight(near), 0.0, 400.0);
                float m = glowLevel(glow);
                float k = smoothstep(6.6, 8.4, m) * uBandW[2] * uSkyFade * aSpike * splitShows(travelSize(near));
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
                vec4 clip = projectionMatrix * modelViewMatrix * vec4(centre, 1.0);
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

// Only the points that can show go to the GPU. The shaders above throw the rest away, but a slow GPU still pays for every
// one's vertices, and most of the sky's points are too faint to show until the zoom is well in, or are off the screen. So the
// sprites and spikes draw from a copy of the data that holds only the points that can show, by the shaders' own rules (skyGlow,
// splitShows and the spikes' start, with a little to spare) and inside the view with room for the widest halo. The copy is
// made for a little more than the view needs, a wider cone and a deeper limit, and made again only once the view has moved out
// of that. On a flight, which brightens and spreads what it nears, and away from the sky, every point is drawn.
//
// data is the owner's, in its own order, and stays so: a change to it is noticed when the owner calls changed(), or when it
// flags the drawn geometry's attribute as changed (attribute.needsUpdate), as a setter written for the plain sprites does.
// Every field of data is copied, so a field added to data and to instancedAttributes comes along. withSpikes: false for
// sprites alone.
const CONE_MORE = 0.25;         // The copy's cone is this share wider than the view's reach, and at least...
const CONE_MORE_MIN_DEG = 2;    // ...this many degrees wider
const HALO_PX = 120;            // Device pixels, per unit of pixel ratio, that a point's halo or spikes reach at most
const LIM_MORE = 0.5;           // The copy holds points this many magnitudes fainter than the limit...
const LIM_LESS = 1.5;           // ...and is made again for a view this much shallower
const SCALE_MORE = 1.2;         // Separations are judged for a view this much nearer or further

export function createSpriteSet(data, withSpikes = true) {
    const n = data.count;
    const drawn = { count: n };
    const copies = [];          // [the owner's array, the drawn copy, numbers per point]
    Object.entries(data).forEach(([key, value]) => {
        if (value && value.isBufferAttribute) {
            const copy = new THREE.InstancedBufferAttribute(new value.array.constructor(value.array.length), value.itemSize);
            copy.setUsage(THREE.DynamicDrawUsage);
            drawn[key] = copy;
            copies.push([value.array, copy.array, value.itemSize]);
        } else if (ArrayBuffer.isView(value)) {
            drawn[key] = new value.constructor(value.length);
            copies.push([value, drawn[key], n ? value.length / n : 1]);
        } else {
            drawn[key] = value;
        }
    });
    const sprites = createSprites(drawn);
    const spikes = withSpikes ? createSpikes(drawn) : null;
    sprites.geometry.instanceCount = 0;
    if (spikes) spikes.geometry.instanceCount = 0;
    const attributes = [];
    [sprites, spikes].forEach((part) => {
        if (!part) return;
        Object.values(part.geometry.attributes).forEach((attr) => {
            if (attr.isInstancedBufferAttribute && !attributes.includes(attr)) attributes.push(attr);
        });
    });
    const versions = new Map();
    const picked = new Int32Array(n);        // The owner's index of the point in each drawn slot...
    const slotOf = new Int32Array(n).fill(-1);   // ...and the other way, -1 if it isn't drawn
    const axis = new THREE.Vector3();
    let made = null;            // What the copy was made for
    let dirty = true;
    let spiked = 0;

    function changedOutside() {
        for (let k = 0; k < attributes.length; k++) if (versions.get(attributes[k]) !== attributes[k].version) return true;
        return false;
    }

    // Can the owner's i-th point show in the view the copy is made for? 0 no, 1 yes, 2 with spikes
    function test(i, m) {
        if (!m.still) return 2;
        const C = data.centres.array;
        const x = C[i * 3];
        const y = C[i * 3 + 1];
        const z = C[i * 3 + 2];
        if (x * m.axis.x + y * m.axis.y + z * m.axis.z < m.cosCone * Math.hypot(x, y, z)) return 0;
        const S = data.split.array;
        const apart = S[i * 2];
        if (apart > 0 && apart * m.ppd * SCALE_MORE <= SPLIT_LO * 0.98) return 0;
        if ((S[i * 2 + 1] * m.ppd) / SCALE_MORE >= SPLIT_HI * 1.02) return 0;
        const A = data.bandA;
        const f = data.flux.array[i] * m.gain;
        let glow = m.xray ? data.bandB[i] : 0;
        for (let k = 0; k < m.bands.length; k++) glow = Math.max(glow, A[i * 4 + m.bands[k]]);
        if (glow * f < MIN_GLOW) return 0;
        return withSpikes && m.visible && data.spike[i] > 0 && A[i * 4 + 2] * f >= SPIKE_GLOW ? 2 : 1;
    }

    function copyPoint(i, j) {
        for (let c = 0; c < copies.length; c++) {
            const [from, to, size] = copies[c];
            for (let e = 0; e < size; e++) to[j * size + e] = from[i * size + e];
        }
    }

    // Copies the points that can show into the drawn data, those with spikes first
    function make(still, frame, mask, reach, haloDeg) {
        const lim = limitingMag(frame.fov) + LIM_MORE;
        const cone = reach + haloDeg + Math.max(CONE_MORE_MIN_DEG, reach * CONE_MORE);
        const m = {
            still, mask, axis: axis.clone(), cone, cosCone: cone >= 180 ? -2 : Math.cos(cone * RAD), lim,
            gain: 10 ** (0.4 * (lim - 6)) / SPARE, ppd: frame.pxPerRad * RAD,
            bands: [0, 1, 2, 3].filter((b) => mask & (1 << b)), xray: !!(mask & 16), visible: !!(mask & 4)
        };
        let shown = 0;
        const rest = [];
        slotOf.fill(-1);
        for (let i = 0; i < n; i++) {
            const t = test(i, m);
            if (t === 2) picked[shown++] = i;
            else if (t === 1) rest.push(i);
        }
        spiked = shown;
        for (let k = 0; k < rest.length; k++) picked[shown++] = rest[k];
        for (let j = 0; j < shown; j++) {
            slotOf[picked[j]] = j;
            copyPoint(picked[j], j);
        }
        attributes.forEach((attr) => {
            attr.clearUpdateRanges();
            attr.addUpdateRange(0, Math.max(1, shown) * attr.itemSize);
            attr.needsUpdate = true;
            versions.set(attr, attr.version);
        });
        sprites.geometry.instanceCount = shown;
        if (spikes) spikes.geometry.instanceCount = spiked;
        made = m;
        dirty = false;
    }

    return {
        sprites,
        spikes,
        // The owner has changed its data: its i-th point's, or any of it. A drawn point that still shows as it did is
        // changed in place; anything else makes the copy again.
        changed(i) {
            if (i === undefined || !made || dirty) {
                dirty = true;
                return;
            }
            const j = slotOf[i];
            const t = test(i, made);
            if (j < 0 ? t > 0 : t !== (j < spiked ? 2 : 1)) {
                dirty = true;
                return;
            }
            if (j < 0) return;
            copyPoint(i, j);
            attributes.forEach((attr) => {
                attr.addUpdateRange(j * attr.itemSize, attr.itemSize);
                attr.needsUpdate = true;
                versions.set(attr, attr.version);
            });
        },
        // For tests: how many points are drawn now, and how many there are
        drawnCount: () => sprites.geometry.instanceCount,
        update(frame) {
            const t = sharedUniforms.uTravel.value;
            const still = frame.view === 'sky' && t.x === 0 && t.y === 0 && t.z === 0;
            const w = frame.bandW;
            let mask = 0;
            for (let b = 0; b < 5; b++) if (w[b] > 0) mask |= 1 << b;
            frame.camera.getWorldDirection(axis);
            // How far from the camera's axis the canvas reaches, with the lens's offset, and how far a halo reaches beyond it
            const tan = Math.tan(frame.fov * RAD * 0.5) / (frame.zoom || 1);
            const reach = Math.atan(Math.hypot(tan * (frame.width / frame.height) * (1 + Math.abs(frame.shiftX || 0)), tan * (1 + Math.abs(frame.shiftY || 0)))) / RAD;
            const haloDeg = (HALO_PX * frame.dpr) / (frame.pxPerRad * RAD);
            let again = dirty || !made || made.still !== still || changedOutside();
            if (!again && still) {
                const lim = limitingMag(frame.fov);
                const ppd = frame.pxPerRad * RAD;
                const need = reach + haloDeg;
                const moved = Math.acos(Math.max(-1, Math.min(1, axis.dot(made.axis)))) / RAD;
                again = made.mask !== mask || lim > made.lim || lim < made.lim - LIM_MORE - LIM_LESS
                    || ppd > made.ppd * SCALE_MORE || ppd < made.ppd / SCALE_MORE
                    || (made.cone < 180 && moved + need > made.cone) || made.cone > 2 * (need + Math.max(CONE_MORE_MIN_DEG, reach * CONE_MORE)) + 5;
            }
            if (again) make(still, frame, mask, reach, haloDeg);
        }
    };
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
        pcs: new Float32Array(n),
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
        data.pcs[i] = travelPc(body);
        // A black hole's companion sits inside the lens, which would bend its spikes into grey blocks round the disc
        data.spike[i] = body.kind === 'black_hole' ? 0 : 1;
    });

    // Only those that can show are drawn (createSpriteSet): data stays as it is, in the bodies' order
    const set = createSpriteSet(data);
    const { sprites, spikes } = set;
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
            set.update(frame);
        },
        // For a layer whose body changes brightness (a supernova) or draws its own sprite: multiplies the sprite's
        // glow by this factor. 1 is normal; 0 hides it.
        setSpriteFlux(code, factor) {
            const i = indexOf.get(code);
            if (i === undefined || data.flux.array[i] === factor) return;
            data.flux.array[i] = factor;
            set.changed(i);
        },
        // A multiple star's point goes out as it comes apart into its members, at this separation in degrees
        setSpriteSplit(code, sepDeg) {
            const i = indexOf.get(code);
            if (i === undefined || data.split.array[i * 2 + 1] === sepDeg) return;
            data.split.array[i * 2 + 1] = sepDeg;
            set.changed(i);
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
