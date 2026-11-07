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
    uViewport: { value: new THREE.Vector2(1, 1) } // Device pixels
};

// In the vertex or fragment shader:
//   aBandA = vec4(radio, ir, visible, uv) and aBandB = xray hold the object's strength in each band
//   bandAmount(a, b)       how strongly the object shows in the current mix of bands
//   bandColour(trueColour) its true colour in visible light, the band's false colour otherwise
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
