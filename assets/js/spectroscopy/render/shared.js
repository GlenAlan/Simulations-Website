// Uniforms and GLSL shared by every sky material, so that all layers cross-fade between bands together.
// Add `...sharedUniforms` to a ShaderMaterial's uniforms and BAND_GLSL to its shader; the engine keeps them current.

import * as THREE from 'three';
import { BANDS, BAND_INFO } from '../core/bands.js';

export const sharedUniforms = {
    uTime: { value: 0 },            // Seconds; stops changing nothing else, so use uTwinkle for optional motion
    uTwinkle: { value: 1 },         // 0 with Reduce motion: multiply decorative motion by this
    uBandW: { value: BANDS.map((b) => (b === 'visible' ? 1 : 0)) }, // Weights of the five bands, summing to 1
    uBandTint: { value: BANDS.map((b) => new THREE.Vector3(...BAND_INFO[b].tint)) },
    uFov: { value: 80 },            // Vertical field of view (degrees)
    uPxPerRad: { value: 1000 },     // Device pixels per radian at the centre of the view
    uLimitMag: { value: 6 },        // Faintest visible-band magnitude drawn at this zoom (core/sky.js)
    uSkyFade: { value: 1 },         // 1 in the sky; falls to 0 while flying into a planetary system
    uViewport: { value: new THREE.Vector2(1, 1) }, // Device pixels
    uParallaxLog: { value: 0 },     // Always 0 now: a telescope's pan or zoom shows no parallax (core/depth.js)
    // A flight into a system really travels: xyz is where the traveller has got to, in parsecs from Earth along the line to
    // the system, and w is the distance of the system itself. All 0 at rest. See travel() below.
    uTravel: { value: new THREE.Vector4(0, 0, 0, 0) },
    uDomeFade: { value: 1 }         // The dome (sky glow, Milky Way, horizon): falls to 0 as a flight leaves the galaxy
};

const TRAVEL_LIGHT_MOST = 25;       // A point passed close by brightens by the inverse square, but by 3.5 magnitudes at most
const TRAVEL_SIZE_MOST = 12;        // Something with a size grows as it comes nearer, but to 12 times at most

// In the vertex or fragment shader:
//   aBandA = vec4(radio, ir, visible, uv) and aBandB = xray hold the object's strength in each band
//   bandAmount(a, b)       how strongly the object shows in the current mix of bands
//   bandColour(trueColour) its true colour in visible light, the band's false colour otherwise
//   depthP(d)              always 1 now (core/depth.js): the sky no longer fakes parallax as the view pans or zooms
//   travel(p, pc)          where the traveller sees a thing on a flight into a system: see below
export const BAND_GLSL = /* glsl */`
uniform float uBandW[5];
uniform vec3 uBandTint[5];
uniform float uTime;
uniform float uTwinkle;
uniform float uFov;
uniform float uPxPerRad;
uniform float uLimitMag;
uniform float uSkyFade;
uniform vec2 uViewport;
uniform float uParallaxLog;
uniform vec4 uTravel;
uniform float uDomeFade;

float depthP(float d) {
    return exp(d * uParallaxLog);
}

// A flight into a system leaves Earth for the system's star, and what's seen moves as it really would. travel(p, pc) takes
// p, where a thing pc parsecs from Earth sits on the sky's sphere (any length), moves it to where the traveller sees it, at
// the same length, and returns how much nearer the thing now is: its distance from Earth over its distance from the
// traveller. At rest, and for whatever is at the system's own distance (the system itself, whose look the system view
// takes over), it leaves p exactly as it was and returns 1. Every layer gives it each thing's distance as an attribute,
// aPc, set from travelPc() in core/depth.js.
float travel(inout vec3 p, float pc) {
    if (uTravel.xyz == vec3(0.0) || abs(pc - uTravel.w) <= pc * 1e-6) return 1.0;
    float r = length(p);
    vec3 q = p * (pc / r) - uTravel.xyz;
    float d = max(length(q), pc * 1e-4);
    p = q * (r / d);
    return pc / d;
}

// What being nearer does to the light of a point: the inverse square, held in so that nothing blows out
float travelLight(float near) {
    return min(near * near, ${TRAVEL_LIGHT_MOST.toFixed(1)});
}

// ... and to the size of something with a size. Its surface stays as bright, so a bigger thing gives more light.
float travelSize(float near) {
    return min(near, ${TRAVEL_SIZE_MOST.toFixed(1)});
}

// Something with a size thins away as the flight passes right through it, rather than standing at its largest
float travelThrough(float near) {
    return 1.0 - smoothstep(${(TRAVEL_SIZE_MOST * 0.5).toFixed(1)}, ${TRAVEL_SIZE_MOST.toFixed(1)}, near);
}

float bandAmount(vec4 a, float b) {
    return a.x * uBandW[0] + a.y * uBandW[1] + a.z * uBandW[2] + a.w * uBandW[3] + b * uBandW[4];
}

vec3 bandColour(vec3 trueColour) {
    return uBandTint[0] * uBandW[0] + uBandTint[1] * uBandW[1] + trueColour * uBandW[2]
        + uBandTint[3] * uBandW[3] + uBandTint[4] * uBandW[4];
}
`;

// On most Windows machines WebGL shaders end up in Direct3D's compiler. It unrolls any loop whose count it can work out,
// and inlines everything inside, so that a shader of nested noise takes seconds to compile. Long loops add this to
// their bound: it's always 0 (a uniform nobody sets), but the compiler can't know that, and so leaves them as real loops.
export const LOOP_ZERO_GLSL = /* glsl */`
uniform int uLoopZero;
`;

// Sky layers draw in this order with their Object3D.renderOrder. Everything is additive except the horizon.
export const ORDER = {
    background: 0,
    bandSky: 2,
    nebulae: 10,
    galaxies: 12,
    clusters: 14,
    supernovae: 16,
    stars: 20,
    exotic: 24,
    comets: 26,
    overlays: 50,
    horizon: 90
};

// A material for sky objects: additive, no depth, and left in linear HDR for the engine's tone mapping.
export function skyMaterial(params) {
    return new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        ...params,
        uniforms: { ...sharedUniforms, ...(params.uniforms || {}) }
    });
}

// Which pixel size a thing of the given angular size (degrees) would be at this zoom
export function pixelsOf(sizeDeg, frame) {
    return (sizeDeg * Math.PI / 180) * frame.pxPerRad;
}

// The shaders' travel(), for what is placed from JavaScript: moves v (a THREE.Vector3, any length) to where the traveller
// sees a thing pc parsecs away in that direction, and returns how much nearer it is. Leaves v alone at rest.
export function travelPoint(v, pc) {
    const t = sharedUniforms.uTravel.value;
    if ((t.x === 0 && t.y === 0 && t.z === 0) || !(pc > 0) || Math.abs(pc - t.w) <= pc * 1e-6) return 1;
    const r = v.length();
    const k = pc / r;
    const qx = v.x * k - t.x;
    const qy = v.y * k - t.y;
    const qz = v.z * k - t.z;
    const d = Math.max(Math.hypot(qx, qy, qz), pc * 1e-4);
    v.set((qx * r) / d, (qy * r) / d, (qz * r) / d);
    return pc / d;
}

export function travelSize(near) {
    return Math.min(near, TRAVEL_SIZE_MOST);
}
