// How a galaxy's central black hole looks up close (render/system/nucleus_model.js is its system). The hole is the same
// picture as a stellar one (remnants.js createHole), with a slower disc: gas this far out round a hole this heavy takes days,
// not seconds, to go round. A feeding hole's disc is blazing and blue-white, a starved one's a dim, warm swirl. A radio-loud
// one has long jets. A feeding one also has its thick ring of dust round the disc: from the side it hides the disc (a
// type 2), from above it's a dark doughnut round it (a type 1). The dust glows in infrared, and in X-rays and radio is
// see-through.

import * as THREE from 'three';
import { sharedUniforms } from '../shared.js';

// Options for createHole, or null for anything that isn't a galaxy's hole
export function holeLook(body) {
    if (!body || body.kind !== 'nucleus') return null;
    const n = body.nucleus;
    return { jets: !!n.jets, glow: n.active ? 1.5 : 0.14, flow: 0.3, jetScale: 13 };
}

// Stylised, as every size is in the system view: the real ring lies far beyond the stars' orbits, but drawn there it would
// wall the view in. Here it sits just inside the nearest star's closest approach (nucleus_model.js supermassiveRadius).
const RING_RADIUS = 1.45;       // The dust ring's middle, in the hole's drawn radii (the disc's outer edge)...
const RING_TUBE = 0.32;         // ...and how thick it is

const RING_VERTEX = /* glsl */`
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vLocal;
void main() {
    vLocal = position;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
}`;

const RING_FRAGMENT = /* glsl */`
uniform float uBandW[5];
uniform vec3 uBandTint[5];
uniform vec3 uCentre;
uniform float uReveal;
uniform float uSeed;
varying vec3 vNormal;
varying vec3 vWorld;
varying vec3 vLocal;

float hash(vec3 p) {
    p = fract(p * 0.3183099 + uSeed);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

void main() {
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 toEye = normalize(cameraPosition - vWorld);
    // Lit by the disc in the middle: its inner wall glows, its outside is dark
    float lit = max(dot(n, normalize(uCentre - vWorld)), 0.0);
    float fine = noise(vLocal * 9.0 + 3.1);
    float clumps = 0.35 + 1.3 * noise(vLocal * 3.5) * fine;
    // Thin at the edges seen side-on, and ragged there: a cloud of dust, not a solid ring
    float face = abs(dot(n, toEye));
    float body = smoothstep(0.05, 0.5, face * (0.6 + 0.8 * fine));
    // The outside is lit only faintly, by the galaxy's stars all round
    vec3 visible = vec3(0.07, 0.04, 0.025) * (0.16 + 1.8 * lit * lit * lit) * clumps;
    float warm = (0.25 + 1.4 * lit) * clumps;
    vec3 colour = visible * uBandW[2] + visible * 0.4 * uBandW[3] + uBandTint[1] * warm * 0.7 * uBandW[1];
    // Dust stops visible, ultraviolet and infrared light, but X-rays and radio go through it. It's thinner in places.
    float patchy = 0.72 + 0.28 * smoothstep(0.2, 0.7, clumps);
    float solid = clamp(uBandW[1] + uBandW[2] + uBandW[3], 0.0, 1.0) * mix(0.35, 0.9, body) * patchy;
    gl_FragColor = vec4(colour * uReveal * body, solid * uReveal);
}`;

// The ring of dust round a feeding hole's disc. Drawn before the hole, writing depth, so its near side hides what's behind
// it and its far side is behind the disc. Null for a quiet hole, which has none.
export function createDustRing(body, hole) {
    if (!body || body.kind !== 'nucleus' || !body.nucleus.active) return null;
    const geometry = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 20, 72);
    const material = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthWrite: true,
        side: THREE.DoubleSide,
        vertexShader: RING_VERTEX,
        fragmentShader: RING_FRAGMENT,
        uniforms: {
            uBandW: sharedUniforms.uBandW,
            uBandTint: sharedUniforms.uBandTint,
            uCentre: { value: new THREE.Vector3() },
            uReveal: { value: 1 },
            uSeed: { value: (body.code.charCodeAt(0) % 17) / 17 }
        }
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3.4;     // Just before the hole's picture
    // The torus's own axis is z: turn it onto the disc's
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hole.normal);
    return {
        object: mesh,
        update({ reveal, radius, position }) {
            const shown = reveal > 0.001;
            mesh.visible = shown;
            if (!shown) return;
            mesh.position.set(position[0], position[1], position[2]);
            mesh.scale.setScalar(radius);
            material.uniforms.uCentre.value.set(position[0], position[1], position[2]);
            // While it's still faint, or in a band it doesn't stop, it mustn't hide the disc
            const w = sharedUniforms.uBandW.value;
            material.uniforms.uReveal.value = reveal;
            material.depthWrite = reveal > 0.6 && w[1] + w[2] + w[3] > 0.5;
        },
        dispose() {
            geometry.dispose();
            material.dispose();
        }
    };
}
