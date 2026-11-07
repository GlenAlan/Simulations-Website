// How a galaxy's central black hole looks up close (render/system/nucleus_model.js is its system). The hole is the same
// picture as a stellar one (remnants.js createHole), with a slower disc: gas this far out round a hole this heavy takes days,
// not seconds, to go round. A feeding hole's disc is blazing and blue-white, a starved one's a dim, warm swirl. A radio-loud
// one has long jets. A feeding one also has its thick ring of dusty clouds round the disc: from the side the clouds pile up
// and hide the disc (a type 2); from above they are a ragged, part see-through ring round it (a type 1). The dust glows a
// dull red in infrared, where it shows best, and lets ultraviolet light, X-rays and radio through almost untouched.

import * as THREE from 'three';
import { Rng } from '../../core/rng.js';
import { sharedUniforms } from '../shared.js';
import { exoticNoise, instancedQuad } from '../layers/exotic_common.js';

// Options for createHole, or null for anything that isn't a galaxy's hole
export function holeLook(body) {
    if (!body || body.kind !== 'nucleus') return null;
    const n = body.nucleus;
    // Its disc lies all but in the plane the flight in measures its tilt from (nucleus_model.js), so a type 2 is first seen
    // through its dust and a type 1 from above it
    return { jets: !!n.jets, glow: n.active ? 1.5 : 0.14, flow: 0.3, jetScale: 13, tilt: 0.05 };
}

// ---------- The ring of dust ----------
//
// Not a solid ring but a few hundred soft clouds, each a wisp of noise stretched along the ring. Lengths are in the hole's
// drawn radii, the disc's outer edge being 1. Stylised, as every size is in the system view: the real ring lies far beyond the
// stars' orbits, but drawn there it would wall the view in, so here it sits just inside the nearest star's closest approach
// (nucleus_model.js supermassiveRadius).
//
// Each cloud absorbs what's behind it and adds a little light of its own (premultiplied alpha). Those on the far side of the
// hole are drawn before it and those on the near side after, so the near ones dim the disc and the far ones are behind it.
const CLOUDS = { low: 120, medium: 190, high: 270 };
const INNER = 1.12;             // The ring's inner edge...
const SPREAD = 0.95;            // ...and how far out it reaches beyond that
// How thick it is, as a spread of heights for a share of the distance out: thick enough to hide the disc, and the light
// bent round the hole, from within about 20 degrees of its plane, as the dust round a type 2 does; thin enough that the
// three-quarter view a visit settles on sees over it
const THICK = 0.26;
// How thick one cloud is to light at its middle, as an optical depth, in each band: radio, IR, visible, UV, X-ray. Against the
// dark sky this changes nothing; it is what dims the disc behind. The disc is far brighter than anything else here, so in
// visible light each cloud is all but opaque, and a few in a line hide it. Ultraviolet would really be stopped hardest of
// all; it is kept faint here so that the disc's ultraviolet glow, the hot gas, is what that band shows.
const STOPS = [0, 2, 10, 0.15, 0];
const SKY_STOP = 0.012;         // Away from the disc, the share of that a cloud keeps: a faint veil over the sky
const WARM = [0.85, 0.5, 0.28]; // The disc's light on the inner wall, reddened by the dust
const WARM_LIGHT = 0.45;
const IR_GLOW = [0.02, 0.09];   // Infrared: a dull glow from the whole ring, and more from its warm inner wall

const CLOUD_VERTEX = /* glsl */`
attribute vec3 aLocal;      // Where the cloud is: in the disc's plane, then along its axis
attribute vec4 aShape;      // Half-size, stretch along the ring, thickness, seed
uniform vec3 uCentre;
uniform vec3 uE1;
uniform vec3 uE2;
uniform vec3 uN;
uniform float uScale;
uniform float uNear;
uniform float uReveal;
uniform float uBandW[5];
uniform vec3 uBandTint[5];
uniform vec3 uStops;        // IR, visible, UV: X-rays and radio go straight through
varying vec2 vUv;
varying vec2 vNoiseUv;
varying float vStop;
varying vec3 vLight;

void main() {
    // uCentre and the axes are in the system's own frame, which the mesh's parent may have moved or scaled
    vec3 world = (modelMatrix * vec4(uCentre + (uE1 * aLocal.x + uE2 * aLocal.y + uN * aLocal.z) * uScale, 1.0)).xyz;
    vec3 centre = (modelMatrix * vec4(uCentre, 1.0)).xyz;
    // Which side of the hole it's on, along the line of sight
    float side = dot(world - centre, cameraPosition - centre);
    if ((side > 0.0) != (uNear > 0.5) || uReveal <= 0.001) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }
    // Stretched along the ring, as it would be sheared by going round
    float phi = atan(aLocal.y, aLocal.x);
    vec2 along = (mat3(viewMatrix) * mat3(modelMatrix) * (-sin(phi) * uE1 + cos(phi) * uE2)).xy;
    vec2 ax = dot(along, along) > 1e-8 ? normalize(along) : vec2(1.0, 0.0);
    vec2 ay = vec2(-ax.y, ax.x) * 0.65;     // Flattened a little, as the ring is
    float unit = uScale * length(modelMatrix[0].xyz);
    vec4 view = viewMatrix * vec4(world, 1.0);
    view.xy += (ax * position.x * aShape.y + ay * position.y) * aShape.x * unit;
    gl_Position = projectionMatrix * view;
    // How far this corner is from the hole across the view, in the hole's radii, at the hole's own distance. Dust only hides
    // what is behind it, and the only bright thing behind it is the disc: away from that, a cloud dims the faint sky just a
    // little, so that it never stands out as a dark shape against it.
    vec4 mid = viewMatrix * vec4(centre, 1.0);
    vec2 across = (view.xy / max(-view.z, 1e-4) - mid.xy / max(-mid.z, 1e-4)) * -mid.z;
    float overDisc = 1.0 - smoothstep(0.9, 1.35, length(across) / unit);
    vUv = position.xy;
    vNoiseUv = position.xy * vec2(0.22 * aShape.y, 0.22) + aShape.w * vec2(7.13, 3.71);

    // Lit by the disc in the middle: the far side shows its lit inner wall, the near side its dark back
    float rho = length(aLocal.xy);
    float inner = 1.0 - smoothstep(${INNER.toFixed(2)}, ${(INNER + 0.75).toFixed(2)}, rho);
    float facing = 0.5 + 0.5 * dot(normalize(centre - world), normalize(cameraPosition - world));
    float lowDown = 1.0 - smoothstep(0.0, 0.5, abs(aLocal.z) / rho);
    vec3 warm = vec3(${WARM.map((x) => x.toFixed(2)).join(', ')}) * ${WARM_LIGHT.toFixed(2)} * inner * inner * facing * facing * lowDown;
    vec3 glow = uBandTint[1] * (${IR_GLOW[0].toFixed(2)} + ${IR_GLOW[1].toFixed(2)} * inner) * (0.6 + 0.4 * facing);
    vLight = (warm * uBandW[2] + glow * uBandW[1]) * aShape.z * uReveal;
    vStop = (uStops.x * uBandW[1] + uStops.y * uBandW[2] + uStops.z * uBandW[3]) * aShape.z * uReveal * mix(${SKY_STOP.toFixed(3)}, 1.0, overDisc);
}`;

const CLOUD_FRAGMENT = /* glsl */`
uniform sampler2D tNoise;
varying vec2 vUv;
varying vec2 vNoiseUv;
varying float vStop;
varying vec3 vLight;

void main() {
    float r2 = dot(vUv, vUv);
    if (r2 >= 1.0) discard;
    // A soft blob with no edge, thinned into wisps and lanes by the noise
    float blob = (1.0 - r2) * (1.0 - r2);
    vec4 n = texture2D(tNoise, vNoiseUv);
    float wisps = smoothstep(0.15, 0.7, 0.75 * n.r + 0.45 * n.g - 0.12);
    float d = blob * mix(0.2, 1.0, wisps);
    gl_FragColor = vec4(vLight * d, 1.0 - exp(-vStop * d));
}`;

function makeClouds(seed, count) {
    const rng = new Rng(`dust:${seed}`);
    const local = new Float32Array(count * 3);
    const shape = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
        const phi = rng.range(0, Math.PI * 2);
        // Thicker towards the inside, where most of the dust is, and flaring outwards
        const rho = INNER + SPREAD * rng.next() ** 1.3;
        const out = (rho - INNER) / SPREAD;
        const z = Math.max(-2, Math.min(2, rng.gauss())) * THICK * rho;
        local.set([rho * Math.cos(phi), rho * Math.sin(phi), z], i * 3);
        const wisp = rng.chance(0.35);
        shape.set([
            0.2 + 0.22 * rng.next() + 0.16 * out,           // Half-size
            wisp ? rng.range(1.8, 2.8) : rng.range(1, 1.4), // Stretch along the ring
            rng.range(0.5, 1),                              // How thick a cloud
            rng.next()                                      // Seed
        ], i * 4);
    }
    return { local, shape };
}

function cloudMaterial(uniforms, near) {
    return new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendEquation: THREE.AddEquation,
        vertexShader: CLOUD_VERTEX,
        fragmentShader: CLOUD_FRAGMENT,
        uniforms: { ...uniforms, uNear: { value: near ? 1 : 0 } }
    });
}

// The ring of dust round a feeding hole's disc, or null for a quiet hole, which has none. hole is createHole's handle.
export function createDustRing(body, hole, quality = 'medium') {
    if (!body || body.kind !== 'nucleus' || !body.nucleus.active) return null;
    const count = CLOUDS[quality] || CLOUDS.medium;
    const { local, shape } = makeClouds(body.code, count);
    const geometry = instancedQuad(count);
    geometry.setAttribute('aLocal', new THREE.InstancedBufferAttribute(local, 3));
    geometry.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 4));
    // The ring's own axes: in the disc's plane, and along its axis
    const n = hole.normal.clone().normalize();
    const e1 = new THREE.Vector3(1, 0, 0).addScaledVector(n, -n.x);
    if (e1.lengthSq() < 1e-6) e1.set(0, 0, 1).addScaledVector(n, -n.z);
    e1.normalize();
    const e2 = new THREE.Vector3().crossVectors(n, e1);
    const uniforms = {
        uBandW: sharedUniforms.uBandW,
        uBandTint: sharedUniforms.uBandTint,
        tNoise: { value: exoticNoise() },
        uCentre: { value: new THREE.Vector3() },
        uE1: { value: e1 },
        uE2: { value: e2 },
        uN: { value: n },
        uScale: { value: 1 },
        uReveal: { value: 1 },
        uStops: { value: new THREE.Vector3(STOPS[1], STOPS[2], STOPS[3]) }
    };
    const far = new THREE.Mesh(geometry, cloudMaterial(uniforms, false));
    const near = new THREE.Mesh(geometry, cloudMaterial(uniforms, true));
    far.renderOrder = 3.4;      // Before the hole's picture (3.5), which then covers them
    near.renderOrder = 3.6;     // After it, over the disc
    const object = new THREE.Group();
    [far, near].forEach((mesh) => {
        mesh.frustumCulled = false;
        object.add(mesh);
    });
    return {
        object,
        update({ reveal, radius, position }) {
            object.visible = reveal > 0.001;
            uniforms.uReveal.value = reveal;
            uniforms.uScale.value = radius;
            uniforms.uCentre.value.set(position[0], position[1], position[2]);
        },
        dispose() {
            geometry.dispose();
            far.material.dispose();
            near.material.dispose();
        }
    };
}
