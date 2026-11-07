// Gas falling from one star of an interacting pair onto the other: a curved ribbon of flowing gas and a small accretion
// disc with a hot spot where the stream lands. Placed from the pair's live positions each frame, so it turns with the
// pair and stays on the orbit the spectra use.

import * as THREE from 'three';
import { blackBodyRGB } from '../../core/phys.js';
import { sharedUniforms, BAND_GLSL } from '../shared.js';
import { NOISE_GLSL, getNoiseTexture } from './star_surface.js';

const SEGMENTS = 48;

const STREAM_VERTEX = /* glsl */`
attribute float aU;
attribute float aSide;
uniform vec3 uP0;
uniform vec3 uP1;
uniform vec3 uP2;
uniform float uW0;          // Half-width in world units at each end
uniform float uW1;
uniform float uMinW;        // Never thinner than this on screen: world units per unit of depth
varying float vU;
varying float vSide;
void main() {
    float u = aU;
    float m = 1.0 - u;
    vec3 p = m * m * uP0 + 2.0 * m * u * uP1 + u * u * uP2;
    vec3 along = normalize(m * (uP1 - uP0) + u * (uP2 - uP1));
    vec3 toCamera = cameraPosition - p;
    float depth = length(toCamera);
    vec3 across = normalize(cross(along, toCamera));
    float w = max(mix(uW0, uW1, u), uMinW * depth);
    vU = u;
    vSide = aSide;
    gl_Position = projectionMatrix * viewMatrix * vec4(p + across * aSide * w, 1.0);
}`;

const STREAM_FRAGMENT = /* glsl */`
${BAND_GLSL}
${NOISE_GLSL}
uniform vec3 uColourA;
uniform vec3 uColourB;
uniform float uFade;
uniform float uFlow;
varying float vU;
varying float vSide;
void main() {
    float soft = exp(-vSide * vSide * 3.0);
    float ends = smoothstep(0.0, 0.05, vU) * (1.0 - smoothstep(0.94, 1.0, vU));
    // Lumps of gas on the move: the pattern runs along the stream, so it visibly falls from one star to the other
    float lumps = fbm3(vec3(vU * 7.0 - uFlow, vSide * 0.7, 3.0));
    vec3 c = bandColour(mix(uColourA, uColourB, vU * vU));
    gl_FragColor = vec4(c * soft * ends * (0.25 + 1.2 * lumps) * (0.55 + 0.7 * vU) * uFade, 1.0);
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

export function createMassStream(model) {
    const donor = model.stars[model.stream.donor].star;
    const accretor = model.stars[model.stream.accretor].star;

    const count = (SEGMENTS + 1) * 2;
    const aU = new Float32Array(count);
    const aSide = new Float32Array(count);
    const indices = [];
    for (let i = 0; i <= SEGMENTS; i++) {
        aU[i * 2] = i / SEGMENTS;
        aU[i * 2 + 1] = i / SEGMENTS;
        aSide[i * 2] = -1;
        aSide[i * 2 + 1] = 1;
        if (i < SEGMENTS) {
            const j = i * 2;
            indices.push(j, j + 1, j + 2, j + 1, j + 3, j + 2);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
    geometry.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
    geometry.setIndex(indices);

    const fade = { value: 1 };
    const noise = { value: getNoiseTexture() };
    const material = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: STREAM_VERTEX,
        fragmentShader: STREAM_FRAGMENT,
        uniforms: {
            ...sharedUniforms,
            tNoise: noise,
            uP0: { value: new THREE.Vector3() },
            uP1: { value: new THREE.Vector3() },
            uP2: { value: new THREE.Vector3() },
            uW0: { value: 0.1 },
            uW1: { value: 0.05 },
            uMinW: { value: 0.001 },
            uFlow: { value: 0 },
            uColourA: { value: new THREE.Color(...blackBodyRGB(donor.teff_K)) },
            uColourB: { value: new THREE.Color(...blackBodyRGB(Math.max(14000, accretor.teff_K))) },
            uFade: fade
        }
    });
    const ribbon = new THREE.Mesh(geometry, material);
    ribbon.frustumCulled = false;
    ribbon.renderOrder = 5;

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
            tNoise: noise,
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
    group.add(ribbon, disc);

    const toA = new THREE.Vector3();
    const swing = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const local = new THREE.Vector3();
    let flow = 0;
    let spin = 0;

    return {
        group,
        // d and a are the donor's and accretor's world positions, rD and rA their drawn radii
        update({ d, a, rD, rA, dt, reduceMotion, opacity, pxPerWorld }) {
            if (!reduceMotion) {
                flow += dt * 1.1;
                spin += dt * 0.8;
            }
            toA.set(a[0] - d[0], a[1] - d[1], a[2] - d[2]);
            const sep = Math.max(1e-6, toA.length());
            toA.divideScalar(sep);
            // In the turning frame of the pair, Coriolis swings infalling gas the way the donor is moving
            swing.crossVectors(toA, up).normalize();

            const discR = Math.min(rA * 2.8, sep * 0.42);
            const start = Math.min(rD * 0.96, sep * 0.7);
            const u = material.uniforms;
            u.uP0.value.set(d[0] + toA.x * start, d[1] + toA.y * start, d[2] + toA.z * start);
            u.uP2.value.set(
                a[0] - toA.x * discR * 0.6 + swing.x * discR * 0.8,
                a[1],
                a[2] - toA.z * discR * 0.6 + swing.z * discR * 0.8
            );
            u.uP1.value.copy(u.uP0.value).add(u.uP2.value).multiplyScalar(0.5).addScaledVector(swing, sep * 0.05);
            u.uW0.value = Math.min(rD, sep * 0.2) * 0.16;
            u.uW1.value = Math.min(rA, sep * 0.2) * 0.1;
            u.uMinW.value = 1.2 / pxPerWorld;
            u.uFlow.value = flow;

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
        dispose() {
            geometry.dispose();
            material.dispose();
            disc.geometry.dispose();
            discMaterial.dispose();
        }
    };
}
