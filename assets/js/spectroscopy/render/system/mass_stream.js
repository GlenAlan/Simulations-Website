// Gas falling from one star of an interacting pair onto the other: a curved stream of particles and a small
// accretion disc with a hot spot where the stream lands. Placed from the pair's live positions each frame, so it
// turns with the pair and stays on the orbit the spectra use.

import * as THREE from 'three';
import { blackBodyRGB } from '../../core/phys.js';
import { sharedUniforms, BAND_GLSL } from '../shared.js';
import { NOISE_GLSL, getNoiseTexture } from './star_surface.js';

const COUNT = { low: 60, medium: 120, high: 200 };

const STREAM_VERTEX = /* glsl */`
attribute float aU;
attribute float aJitter;
uniform vec3 uP0;
uniform vec3 uP1;
uniform vec3 uP2;
uniform float uFlow;
uniform float uPxPerWorld;
uniform float uSize;
uniform float uDpr;
varying float vU;
varying float vClump;
void main() {
    float u = fract(aU + uFlow);
    vClump = 0.45 + 1.1 * aJitter * aJitter;     // Uneven, so the stream reads as lumps of gas on the move
    float m = 1.0 - u;
    vec3 p = m * m * uP0 + 2.0 * m * u * uP1 + u * u * uP2;
    // A little spread sideways, narrowing as the gas is pulled in
    p += vec3(sin(aJitter * 6.28), 0.0, cos(aJitter * 6.28)) * uSize * (0.35 * m + 0.1) * aJitter;
    vU = u;
    vec4 view = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * view;
    gl_PointSize = max(1.5, uSize * uPxPerWorld * (1.0 - 0.5 * u) / max(0.001, -view.z)) * uDpr;
}`;

const STREAM_FRAGMENT = /* glsl */`
${BAND_GLSL}
uniform vec3 uColourA;
uniform vec3 uColourB;
uniform float uFade;
varying float vU;
varying float vClump;
void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float g = exp(-r * r * 5.0);
    float ends = smoothstep(0.0, 0.06, vU) * (1.0 - smoothstep(0.9, 1.0, vU));
    vec3 c = bandColour(mix(uColourA, uColourB, vU * vU));
    gl_FragColor = vec4(c * g * ends * (0.12 + vU * 0.3) * vClump * uFade, 1.0);
}`;

const DISC_VERTEX = /* glsl */`
varying vec2 vQ;
void main() {
    vQ = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DISC_FRAGMENT = /* glsl */`
${BAND_GLSL}
${NOISE_GLSL}
uniform vec3 uColour;
uniform vec3 uRim;
uniform float uInner;
uniform float uFade;
uniform float uSpin;
uniform vec2 uSpot;     // Where the stream lands, in the disc's own plane
varying vec2 vQ;
void main() {
    float r = length(vQ);
    float a = atan(vQ.y, vQ.x);
    float edge = smoothstep(uInner * 0.92, uInner * 1.05, r) * (1.0 - smoothstep(0.72, 1.0, r));
    // Gas spirals in: faster near the middle, so the pattern winds up
    float swirl = a + 2.2 * log(r + 0.1) + uSpin / (0.25 + r);
    float n = fbm3(vec3(cos(swirl) * 2.0, sin(swirl) * 2.0, r * 3.0));
    float heat = 1.0 - smoothstep(uInner, 0.95, r);      // Hotter inward: white-blue at the star, orange at the rim
    vec3 tint = mix(uRim, uColour, heat);
    float glow = (0.1 + 0.62 * n) * mix(0.2, 0.85, heat);
    float spot = exp(-dot(vQ - uSpot, vQ - uSpot) * 60.0) * 1.3;
    gl_FragColor = vec4(bandColour(tint) * (glow + spot) * edge * uFade, 1.0);
}`;

export function createMassStream(model, quality = 'medium') {
    const donor = model.stars[model.stream.donor].star;
    const accretor = model.stars[model.stream.accretor].star;
    const n = COUNT[quality] || COUNT.medium;
    const aU = new Float32Array(n);
    const aJitter = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        aU[i] = i / n;
        aJitter[i] = (i * 0.61803398875) % 1;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geometry.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
    geometry.setAttribute('aJitter', new THREE.BufferAttribute(aJitter, 1));

    const fade = { value: 1 };
    const material = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: STREAM_VERTEX,
        fragmentShader: STREAM_FRAGMENT,
        uniforms: {
            ...sharedUniforms,
            uP0: { value: new THREE.Vector3() },
            uP1: { value: new THREE.Vector3() },
            uP2: { value: new THREE.Vector3() },
            uFlow: { value: 0 },
            uPxPerWorld: { value: 100 },
            uSize: { value: 0.1 },
            uDpr: { value: 1 },
            uColourA: { value: new THREE.Color(...blackBodyRGB(donor.teff_K)) },
            uColourB: { value: new THREE.Color(...blackBodyRGB(Math.max(14000, accretor.teff_K))) },
            uFade: fade
        }
    });
    const particles = new THREE.Points(geometry, material);
    particles.frustumCulled = false;
    particles.renderOrder = 5;

    const discMaterial = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: DISC_VERTEX,
        fragmentShader: DISC_FRAGMENT,
        uniforms: {
            ...sharedUniforms,
            tNoise: { value: getNoiseTexture() },
            uColour: { value: new THREE.Color(...blackBodyRGB(Math.max(12000, accretor.teff_K))) },
            uRim: { value: new THREE.Color(1, 0.42, 0.12) },
            uInner: { value: 0.4 },
            uFade: fade,
            uSpin: { value: 0 },
            uSpot: { value: new THREE.Vector2(1, 0) }
        }
    });
    const disc = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), discMaterial);
    disc.rotation.x = -Math.PI / 2;
    disc.frustumCulled = false;
    disc.renderOrder = 4;

    const group = new THREE.Group();
    group.add(particles, disc);

    const toA = new THREE.Vector3();
    const ahead = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const local = new THREE.Vector3();
    let flow = 0;
    let spin = 0;

    return {
        group,
        // d and a are the donor's and accretor's world positions, rD and rA their drawn radii
        update({ d, a, rD, rA, dt, reduceMotion, opacity, pxPerWorld, dpr }) {
            if (!reduceMotion) {
                flow = (flow + dt * 0.28) % 1;
                spin += dt * 0.8;
            }
            toA.set(a[0] - d[0], a[1] - d[1], a[2] - d[2]);
            const sep = Math.max(1e-6, toA.length());
            toA.divideScalar(sep);
            // Coriolis swings gas ahead of the accretor, in the direction the pair is turning
            ahead.crossVectors(up, toA).normalize().multiplyScalar(-1);

            const discR = Math.min(rA * 2.8, sep * 0.42);
            const start = Math.min(rD * 0.96, sep * 0.7);
            const u = material.uniforms;
            u.uP0.value.set(d[0] + toA.x * start, d[1] + toA.y * start, d[2] + toA.z * start);
            u.uP2.value.set(
                a[0] - toA.x * discR * 0.6 + ahead.x * discR * 0.8,
                a[1],
                a[2] - toA.z * discR * 0.6 + ahead.z * discR * 0.8
            );
            u.uP1.value.copy(u.uP0.value).add(u.uP2.value).multiplyScalar(0.5).addScaledVector(ahead, -sep * 0.1);
            u.uFlow.value = flow;
            u.uPxPerWorld.value = pxPerWorld;
            u.uSize.value = Math.min(rD, rA) * 0.2;
            u.uDpr.value = dpr;

            disc.position.set(a[0], a[1], a[2]);
            disc.scale.setScalar(discR);
            const du = discMaterial.uniforms;
            du.uInner.value = Math.min(0.85, (rA * 1.04) / discR);
            du.uSpin.value = spin;
            local.copy(u.uP2.value).sub(disc.position);
            // The disc's plane has its own axes after the quarter turn: (x, -z) in world terms
            du.uSpot.value.set(local.x / discR, -local.z / discR);
            fade.value = opacity;
        },
        setFade(k) { fade.value = k; },
        dispose() {
            geometry.dispose();
            material.dispose();
            disc.geometry.dispose();
            discMaterial.dispose();
        }
    };
}
