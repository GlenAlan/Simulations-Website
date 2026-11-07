// What's left of a star, up close in the system view: a black hole with its disc, and a pulsar's beams.
//
// The hole is the sky's own picture (render/layers/black_holes.js) on a quad that faces the camera: the same tables of bent
// light, the same disc, the same photon ring. There it bends a picture of the sky behind it. Here what's behind is only a
// faint backdrop, so it just blocks it. It keeps the interface of a star from star_surface.js.

import * as THREE from 'three';
import { blackBodyRGB } from '../../core/phys.js';
import { hashString, Rng } from '../../core/rng.js';
import { sharedUniforms } from '../shared.js';
import { bendingTables, B_CRIT, TABLE, TABLE_T0, TABLE_T1 } from '../layers/bh_geodesic.js';
import { exoticNoise } from '../layers/exotic_common.js';
import { HOLE_DISC, JET_BANDS, BEAM_BANDS, BEAM_TRUE, bandRgb, falseTint } from './band_look.js';

// Lengths in units of the hole's mass M, as on the sky. The radius the system view gives a hole is its disc's outer edge.
const R_IN = 6;
const R_OUT = 18;
const QUAD_M = R_OUT * 2.6;     // Half the quad's width
const STREAM_LEAD = 1.15;       // How far round the orbit the stream lands, ahead of the star (radians)

const HOLE_VERTEX = /* glsl */`
varying vec2 vP;
void main() {
    vP = position.xy * ${QUAD_M.toFixed(2)};
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const HOLE_FRAGMENT = /* glsl */`
uniform sampler2D tRay;
uniform sampler2D tEnd;
uniform sampler2D tNoise;
uniform sampler2D tBody;
uniform float uTime;
uniform float uTwinkle;
uniform float uPxM;         // One device pixel, in M
uniform float uLod;
uniform float uOrders;
uniform float uDiscT;
uniform float uSeed;
uniform float uHotAngle;
uniform float uReveal;
uniform vec3 uN;            // The disc's axes as the camera sees them: x right, y up, z towards the viewer
uniform vec3 uE1;
uniform vec3 uE2;
uniform vec2 uBandDisc;     // The band: how bright the whole disc is, and how much more towards its hot inner edge
uniform vec4 uBandTint;     // ... the false colour it's drawn in, and how much of the mix is false colour
varying vec2 vP;

const float PI = 3.14159265;
const float TAU = 6.2831853;
const float B_CRIT = ${B_CRIT.toFixed(6)};
const float WIDTH = ${TABLE.width.toFixed(6)};
const float T0 = ${TABLE_T0.toFixed(6)};
const float T1 = ${TABLE_T1.toFixed(6)};
const float NB = ${TABLE.nB}.0;
const float NY = ${TABLE.nY}.0;
const float R_IN = ${R_IN.toFixed(1)};
const float R_OUT = ${R_OUT.toFixed(1)};
const float FLOW = 9.0;
const float CYCLE = 64.0;

float tableX(float b) {
    float s = (b - B_CRIT) / WIDTH;
    float t = sign(s) * log(abs(s) + sqrt(s * s + 1.0));
    return ((t - T0) / (T1 - T0)) * (NB - 1.0) / NB + 0.5 / NB;
}

float tableY(float y) {
    return y * (NY - 1.0) / NY + 0.5 / NY;
}

float gas(float r, float phi) {
    float om = pow(r, -1.5);
    float clock = uTime * uTwinkle * FLOW / CYCLE;
    float p1 = fract(clock);
    float p2 = fract(clock + 0.5);
    float w = abs(2.0 * p1 - 1.0);
    float lr = log(r);
    float a1 = (phi - om * p1 * CYCLE) / TAU;
    float a2 = (phi - om * p2 * CYCLE) / TAU + 0.37;
    float soft = mix(
        textureLod(tNoise, vec2(a1 + uSeed, lr * 1.1 + uSeed * 3.1), uLod).r,
        textureLod(tNoise, vec2(a2 + uSeed, lr * 1.1 + uSeed * 5.3), uLod).r,
        w
    );
    float fine = mix(
        textureLod(tNoise, vec2(a1 * 2.0 + uSeed, lr * 1.7), uLod).g,
        textureLod(tNoise, vec2(a2 * 2.0 + uSeed, lr * 1.7), uLod).g,
        w
    );
    return 0.72 * soft + 0.28 * fine;
}

vec4 discLight(float r, float phi, float g) {
    float f = R_IN / r;
    float inner = smoothstep(R_IN * 0.97, R_IN * 1.1, r);
    float outer = 1.0 - smoothstep(R_OUT * 0.5, R_OUT, r);
    float Tn = pow(f, 0.75) * pow(max(1.0 - sqrt(f), 0.0), 0.12) / 0.62;
    float clumps = 0.28 + 2.0 * pow(gas(r, phi), 1.8);
    float dPhi = mod(phi - uHotAngle + PI, TAU) - PI;
    float rh = R_OUT * 0.8;
    float spot = exp(-((r - rh) * (r - rh)) / 3.0 - (dPhi * rh * dPhi * rh) / 7.0);
    float d = inner * outer * clumps;
    float T = max(uDiscT * Tn * g * (1.0 + 0.5 * spot), 2300.0);
    vec3 bb = pow(textureLod(tBody, vec2(log(clamp(T, 1000.0, 40000.0) / 1000.0) / log(40.0), 0.5), 0.0).rgb, vec3(1.2));
    vec3 light = bb * (2.0 * pow(f, 1.3) * g * g * g * d + 1.2 * spot * inner) * max(uBandDisc.x + uBandDisc.y * f * f, 0.0);
    return vec4(light, clamp(d * 1.5, 0.0, 0.94));
}

void main() {
    float b = max(length(vP), 0.001);
    vec2 dir = vP / b;
    float tx = tableX(b);
    float psiEnd = texture2D(tEnd, vec2(tx, 0.5)).r;
    float outside = smoothstep(B_CRIT - uPxM, B_CRIT + uPxM, b);

    vec3 light = vec3(0.0);
    float clear = 1.0;
    float angularMomentum = b * (uN.x * dir.y - uN.y * dir.x);
    if (b < R_OUT * 2.6) {
        float psi0 = atan(uN.z, -dot(uN.xy, dir));
        for (int k = 0; k < 3; k++) {
            if (float(k) >= uOrders) break;
            float psi = psi0 + float(k) * PI;
            if (psi >= psiEnd) break;
            float u = textureLod(tRay, vec2(tx, tableY(psi / psiEnd)), 0.0).r;
            if (u < 1.0 / R_OUT || u > 1.0 / (R_IN * 0.95)) continue;
            float r = 1.0 / u;
            vec3 P = vec3(sin(psi) * dir, cos(psi));
            float phi = atan(dot(P, uE2), dot(P, uE1));
            float g = sqrt(max(1.0 - 3.0 / r, 0.03)) / max(1.0 - pow(r, -1.5) * angularMomentum, 0.1);
            vec4 s = discLight(r, phi, g);
            light += clear * s.rgb;
            clear *= 1.0 - s.a;
        }
    }

    vec3 warm = vec3(1.0, 0.72, 0.46) * 1.6;
    float sigma = max(0.1, 1.2 * uPxM);
    float rim = (b - B_CRIT) / sigma;
    float approaching = 0.5 + 0.5 * clamp(angularMomentum / B_CRIT / max(length(uN.xy), 0.2), -1.0, 1.0);
    light += clear * warm * exp(-rim * rim) * (0.35 + 1.5 * approaching * approaching) * max(uBandDisc.x + uBandDisc.y, 0.0);

    float beyond = max(b - B_CRIT, 0.0) / (R_OUT * 0.34);
    light += warm * exp(-beyond * beyond) * outside * 0.035;

    // Whatever's behind shows through only where the ray isn't caught and the gas lets it pass
    float edge = 1.0 - smoothstep(0.9, 1.0, b / ${QUAD_M.toFixed(2)});
    light = mix(light, uBandTint.rgb * dot(light, vec3(0.3, 0.55, 0.15)) * 1.5, uBandTint.a);
    gl_FragColor = vec4(light * edge * uReveal, (1.0 - clear * outside) * uReveal);
}`;

// The tables are large, and every hole shares them
let tables = null;
function holeTextures() {
    if (tables) return tables;
    const source = bendingTables();
    const { nB, nY } = TABLE;
    const half = THREE.DataUtils.toHalfFloat;
    const rayData = new Uint16Array(nB * nY);
    for (let i = 0; i < rayData.length; i++) rayData[i] = half(source.ray[i]);
    const tRay = new THREE.DataTexture(rayData, nB, nY, THREE.RedFormat, THREE.HalfFloatType);
    const endData = new Uint16Array(nB * 2);
    for (let i = 0; i < nB; i++) {
        endData[i * 2] = half(source.psiEnd[i]);
        endData[i * 2 + 1] = half(source.deflection[i]);
    }
    const tEnd = new THREE.DataTexture(endData, nB, 1, THREE.RGFormat, THREE.HalfFloatType);
    const bodyData = new Uint16Array(128 * 4);
    for (let i = 0; i < 128; i++) {
        const rgb = blackBodyRGB(1000 * 40 ** (i / 127));
        bodyData.set([half(rgb[0]), half(rgb[1]), half(rgb[2]), half(1)], i * 4);
    }
    const tBody = new THREE.DataTexture(bodyData, 128, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    [tRay, tEnd, tBody].forEach((t) => {
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.wrapS = THREE.ClampToEdgeWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.needsUpdate = true;
    });
    tables = { tRay, tEnd, tBody };
    return tables;
}

const quadGeometry = new THREE.PlaneGeometry(2, 2);

export function createHole(starData, opts = {}) {
    const rng = new Rng(hashString(opts.seed || 'hole'));
    const { tRay, tEnd, tBody } = holeTextures();
    const material = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendEquation: THREE.AddEquation,
        vertexShader: HOLE_VERTEX,
        fragmentShader: HOLE_FRAGMENT,
        uniforms: {
            uTime: sharedUniforms.uTime,
            uTwinkle: sharedUniforms.uTwinkle,
            tRay: { value: tRay },
            tEnd: { value: tEnd },
            tBody: { value: tBody },
            tNoise: { value: exoticNoise() },
            uPxM: { value: 0.5 },
            uLod: { value: 0 },
            uOrders: { value: opts.quality === 'low' ? 2 : 3 },
            uDiscT: { value: starData.teff_K },
            uSeed: { value: rng.next() },
            uHotAngle: { value: 0 },
            uReveal: { value: 1 },
            uN: { value: new THREE.Vector3(0, 0, 1) },
            uE1: { value: new THREE.Vector3(1, 0, 0) },
            uE2: { value: new THREE.Vector3(0, 1, 0) },
            uBandDisc: { value: new THREE.Vector2(1, 0) },
            uBandTint: { value: new THREE.Vector4(1, 1, 1, 0) }
        }
    });
    const quad = new THREE.Mesh(quadGeometry, material);
    quad.frustumCulled = false;
    quad.renderOrder = 3.5;     // After the orbit lines, or the line round the centre of mass would cross the shadow
    const group = new THREE.Group();
    group.add(quad);

    // The disc's plane is a little off the plane of the orbit: nothing makes the two agree
    const tilt = rng.range(0.1, 0.4);
    const swing = rng.range(0, Math.PI * 2);
    const normal = new THREE.Vector3(Math.sin(tilt) * Math.cos(swing), Math.cos(tilt), Math.sin(tilt) * Math.sin(swing));
    const e1 = new THREE.Vector3(1, 0, 0).addScaledVector(normal, -normal.x).normalize();
    const e2 = new THREE.Vector3().crossVectors(normal, e1);
    const rot = new THREE.Matrix3();
    const qCam = new THREE.Quaternion();
    const toCompanion = new THREE.Vector3();

    // Jets along the disc's axis, for a hole that has them: they show in radio, and faintly in X-rays
    const jets = opts.jets ? createBeams({ radius: 0.05, length: 1, knots: 1, sides: 16 }) : null;
    if (jets) {
        jets.object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
        group.add(jets.object);
    }
    const tintOut = [0, 0, 0];
    const jetRgb = [0, 0, 0];

    const api = {
        group,
        look: null,
        radius: 1,
        setRadius(r) {
            api.radius = r;
            quad.scale.setScalar((r * QUAD_M) / R_OUT);
        },
        setTide() {},
        setBandStrength() {},
        // The band weights: the disc's hot inner edge in X-rays, its cooler outside in infrared, the jets in radio
        setBand(w) {
            let x = 0;
            let y = 0;
            for (let b = 0; b < 5; b++) {
                x += w[b] * HOLE_DISC[b][0];
                y += w[b] * HOLE_DISC[b][1];
            }
            material.uniforms.uBandDisc.value.set(x, y);
            const { tint, share } = falseTint(w, tintOut);
            material.uniforms.uBandTint.value.set(tint[0], tint[1], tint[2], share);
            if (jets) jets.setColour(bandRgb(w, [0, 0, 0], JET_BANDS, jetRgb));
        },
        setQuality(q) { material.uniforms.uOrders.value = q === 'low' ? 2 : 3; },
        // Where the companion is, so the stream lands on the right side of the disc
        setCompanion(x, y, z) {
            toCompanion.set(x - group.position.x, y - group.position.y, z - group.position.z);
            material.uniforms.uHotAngle.value = Math.atan2(toCompanion.dot(e2), toCompanion.dot(e1)) + STREAM_LEAD;
        },
        update(s) {
            quad.quaternion.copy(s.camera.getWorldQuaternion(qCam));
            const u = material.uniforms;
            u.uReveal.value = s.reveal;
            group.visible = s.reveal > 0.001;
            const pxPerM = Math.max(0.05, (s.pxRadius * (s.dpr || 1)) / R_OUT);
            u.uPxM.value = 1 / pxPerM;
            u.uLod.value = Math.max(0, Math.log2(25 / pxPerM));
            rot.setFromMatrix4(s.camera.matrixWorldInverse);
            u.uN.value.copy(normal).applyMatrix3(rot);
            u.uE1.value.copy(e1).applyMatrix3(rot);
            u.uE2.value.copy(e2).applyMatrix3(rot);
            if (jets) jets.update({ dt: s.dt, reveal: s.reveal, reduceMotion: s.reduceMotion, scale: api.radius * 6 });
        },
        dispose() {
            material.dispose();
            if (jets) jets.dispose();
        }
    };
    return api;
}

// ---------- Beams: a pulsar's, and a black hole's jets ----------

const BEAM_VERTEX = /* glsl */`
varying float vAlong;
varying vec3 vNormal;
varying vec3 vView;
void main() {
    vAlong = position.y;
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-view.xyz);
    gl_Position = projectionMatrix * view;
}`;

const BEAM_FRAGMENT = /* glsl */`
uniform vec3 uColour;
uniform float uAmount;
uniform float uKnots;       // Jets: knots of brighter gas, moving outward
uniform float uFlow;
varying float vAlong;
varying vec3 vNormal;
varying vec3 vView;
void main() {
    float along = abs(vAlong);
    float fade = (1.0 - smoothstep(0.1, 1.0, along)) * smoothstep(0.0, 0.08, along);
    float rim = pow(abs(dot(normalize(vNormal), normalize(vView))), 1.5);
    float knots = mix(1.0, 0.45 + 0.55 * pow(0.5 + 0.5 * sin(along * 24.0 - uFlow), 3.0), uKnots);
    gl_FragColor = vec4(uColour * fade * rim * knots * uAmount, 1.0);
}`;

// The real thing turns too fast to draw, and would flash. These sweep gently, at one speed for every pulsar.
const BEAM_TURNS_PER_S = 0.12;

// Two cones from a point, one each way along y: { object, setColour(rgb), update({ dt, reveal, reduceMotion, scale }) }
function createBeams({ radius, length, knots, sides }) {
    const geometry = new THREE.ConeGeometry(radius, length, sides, 1, true);
    geometry.translate(0, -0.5 * length, 0);     // The point at the star, the open end along -y
    const material = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: BEAM_VERTEX,
        fragmentShader: BEAM_FRAGMENT,
        uniforms: {
            uColour: { value: new THREE.Color(...BEAM_TRUE) },
            uAmount: { value: 0.5 },
            uKnots: { value: knots },
            uFlow: { value: 0 }
        }
    });
    const object = new THREE.Group();
    const north = new THREE.Mesh(geometry, material);
    const south = new THREE.Mesh(geometry, material);
    south.rotation.z = Math.PI;
    [north, south].forEach((m) => {
        m.frustumCulled = false;
        m.renderOrder = 3;
    });
    object.add(north, south);
    return {
        object,
        setColour(rgb) {
            material.uniforms.uColour.value.setRGB(rgb[0], rgb[1], rgb[2]);
            object.visible = rgb[0] + rgb[1] + rgb[2] > 0.002;
        },
        update({ dt, reveal, reduceMotion, scale }) {
            if (!reduceMotion) material.uniforms.uFlow.value += dt * 2.2;
            object.scale.setScalar(scale);
            material.uniforms.uAmount.value = 0.5 * reveal;
        },
        dispose() {
            geometry.dispose();
            material.dispose();
        }
    };
}

export function createPulsarBeams(ns) {
    const beams = createBeams({ radius: 0.13, length: 1, knots: 0, sides: 28 });
    const spin = new THREE.Group();
    const axis = new THREE.Group();
    axis.rotation.z = ((ns.magnetic_tilt_deg || 30) * Math.PI) / 180;
    axis.add(beams.object);
    spin.add(axis);
    let angle = 0;
    const rgb = [0, 0, 0];
    return {
        object: spin,
        // Radio first; some pulsars sweep X-rays too. In visible light they stay the stylised beams they were.
        setBand(w) { beams.setColour(bandRgb(w, BEAM_TRUE, BEAM_BANDS, rgb)); },
        update({ dt, reveal, reduceMotion, radius }) {
            if (!reduceMotion) angle += dt * BEAM_TURNS_PER_S * Math.PI * 2;
            spin.rotation.y = angle;
            beams.update({ dt: 0, reveal, reduceMotion: true, scale: radius * 7 });
        },
        dispose: beams.dispose
    };
}