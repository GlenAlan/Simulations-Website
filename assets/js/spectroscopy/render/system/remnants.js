// What's left of a star, up close in the system view: a black hole with its disc, and a pulsar's beams.
//
// The hole is the sky's own picture (render/layers/black_holes.js) on a quad that faces the camera: the same tables of bent
// light, the same disc, the same photon ring. There it bends a picture of the sky behind it. Here what's behind is only a
// faint backdrop, so it just blocks it. It keeps the interface of a star from star_surface.js.

import * as THREE from 'three';
import { blackBodyRGB } from '../../core/phys.js';
import { hashString, Rng } from '../../core/rng.js';
import { sharedUniforms, LOOP_ZERO_GLSL } from '../shared.js';
import { bendingTables, B_CRIT, TABLE, TABLE_T0, TABLE_T1 } from '../layers/bh_geodesic.js';
import { exoticNoise, bodyRng, pulsarSpin, pulsarAngle, pulsarBeam, closeTurningShare, smoothstep, PULSAR_BEAM_SLOPE,
    SWEEP_SAMPLES } from '../layers/exotic_common.js';
import { HOLE_DISC, JET_BANDS, BEAM_BANDS, BEAM_TRUE, bandRgb, falseTint } from './band_look.js';

// Lengths in units of the hole's mass M, as on the sky. The radius the system view gives a hole is its disc's outer edge.
const R_IN = 6;
const R_OUT = 18;
const QUAD_M = R_OUT * 2.6;     // Half the quad's width
const STREAM_LEAD = 1.15;       // How far round the orbit the stream lands, ahead of the star (radians)
const CALM_FROM = 0.06;         // Crossing the screen at this many of its own radii a second, the disc's clumps start to blur...
const CALM_TO = 0.2;            // ... and by this, they're an even glow

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
uniform float uCalm;        // 1: the hole is crossing the screen fast, and its clumps are a blur
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
const float CLUMPS_MEAN = 0.85;

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
    float clumps = uCalm > 0.999 ? CLUMPS_MEAN : mix(0.28 + 2.0 * pow(gas(r, phi), 1.8), CLUMPS_MEAN, uCalm);
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

// opts: { seed, quality, jets, glow, flow, jetScale, tilt }. glow scales the disc's light, flow how fast its gas swirls round,
// jetScale the jets' length in the hole's radii, and tilt the disc's angle to the orbits' plane (radians): a galaxy's giant
// hole has a slower disc, dim if it's starved, longer jets, and its disc lies in the plane its line of sight is measured from.
export function createHole(starData, opts = {}) {
    const rng = new Rng(hashString(opts.seed || 'hole'));
    const { tRay, tEnd, tBody } = holeTextures();
    const glow = opts.glow ?? 1;
    const flow = opts.flow ?? 1;
    const jetScale = opts.jetScale ?? 6;
    const twinkle = flow === 1 ? sharedUniforms.uTwinkle : { value: sharedUniforms.uTwinkle.value * flow };
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
            uTwinkle: twinkle,
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
            uBandTint: { value: new THREE.Vector4(1, 1, 1, 0) },
            uCalm: { value: 0 }
        }
    });
    const quad = new THREE.Mesh(quadGeometry, material);
    quad.frustumCulled = false;
    quad.renderOrder = 3.5;     // After the orbit lines, or the line round the centre of mass would cross the shadow
    const group = new THREE.Group();
    group.add(quad);

    // The disc's plane is a little off the plane of the orbit: nothing makes the two agree. opts.tilt sets it instead.
    const drawnTilt = rng.range(0.1, 0.4);
    const tilt = opts.tilt ?? drawnTilt;
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
    let sweep = 0;      // How fast the hole crosses the screen, in its own radii a second, smoothed over a few frames

    const api = {
        group,
        look: null,
        radius: 1,
        normal,                 // The disc's axis, in the system's own axes, for anything that must line up with it
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
            material.uniforms.uBandDisc.value.set(x * glow, y * glow);
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
            if (twinkle !== sharedUniforms.uTwinkle) twinkle.value = sharedUniforms.uTwinkle.value * flow;
            u.uReveal.value = s.reveal;
            group.visible = s.reveal > 0.001;
            const pxPerM = Math.max(0.05, (s.pxRadius * (s.dpr || 1)) / R_OUT);
            u.uPxM.value = 1 / pxPerM;
            u.uLod.value = Math.max(0, Math.log2(25 / pxPerM));
            // Swinging round its partner, the hole carries its streaked disc across the screen, and every spot the streaks
            // pass flickers. Moving fast, the streaks blur into an even glow, as a star's surface does.
            const across = (s.pxPerSecond || 0) / Math.max(s.pxRadius || 0, 1);
            sweep += (across - sweep) * Math.min(1, (s.dt || 0) * 4);
            u.uCalm.value = smoothstep(CALM_FROM, CALM_TO, sweep);
            rot.setFromMatrix4(s.camera.matrixWorldInverse);
            u.uN.value.copy(normal).applyMatrix3(rot);
            u.uE1.value.copy(e1).applyMatrix3(rot);
            u.uE2.value.copy(e2).applyMatrix3(rot);
            if (jets) jets.update({ dt: s.dt, reveal: s.reveal, reduceMotion: s.reduceMotion, scale: api.radius * jetScale });
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

// A pulsar's beams as light in the space round the star, not as cones with walls: each pixel shows the beam where its line
// of sight passes nearest the axis, fading smoothly across, as the sky draws it. A beam sweeping a wall's hard edge over the
// screen changes a wide area at once; this changes it gently. The cones are only something to draw on, wider than the light.
const SOFT_BEAM_VERTEX = /* glsl */`
varying vec3 vWorld;
void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
}`;

const SOFT_BEAM_FRAGMENT = /* glsl */`
uniform vec3 uColour;
uniform float uAmount;
uniform vec3 uApex;
uniform vec3 uAxis;
uniform float uLength;
uniform float uSlope;
varying vec3 vWorld;
void main() {
    vec3 rd = normalize(vWorld - cameraPosition);
    vec3 w0 = cameraPosition - uApex;
    float b = dot(rd, uAxis);
    float t = max((b * dot(uAxis, w0) - dot(rd, w0)) / max(1.0 - b * b, 1e-4), 0.0);
    vec3 p = cameraPosition + rd * t - uApex;
    // Each cone draws its own half of the beam
    float side = sign(dot(vWorld - uApex, uAxis));
    float s = dot(p, uAxis) * side;
    if (s <= 0.0) discard;
    float across = length(p - uAxis * s * side) / max(s * uSlope, uLength * 0.004);
    float a = s / uLength;
    float fade = (1.0 - smoothstep(0.1, 1.0, a)) * smoothstep(0.0, 0.08, a);
    gl_FragColor = vec4(uColour * exp(-across * across) * fade * uAmount, 1.0);
}`;
const SOFT_BEAM_ROOM = 2.2;     // The cones' width, as a share of the light's own
// How bright a beam is, as the luminance of its colour times this: about the same in every band, and dim enough that a beam
// sweeping over the screen changes no wide area by much from one frame to the next. Each line of sight crosses a cone
// twice, so the light peaks at twice this. A pale colour may go a little brighter, up to SOFT_BEAM_MOST.
const SOFT_BEAM_LIGHT = 0.142;
const SOFT_BEAM_MOST = 0.16;

function createSoftBeams({ slope, sides }) {
    // Closed, so that every line of sight through it crosses it twice, even one looking in at the open end
    const geometry = new THREE.ConeGeometry(slope * SOFT_BEAM_ROOM, 1, sides, 1, false);
    geometry.translate(0, -0.5, 0);
    const material = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: SOFT_BEAM_VERTEX,
        fragmentShader: SOFT_BEAM_FRAGMENT,
        uniforms: {
            uColour: { value: new THREE.Color(...BEAM_TRUE) },
            uAmount: { value: 0 },
            uApex: { value: new THREE.Vector3() },
            uAxis: { value: new THREE.Vector3(0, 1, 0) },
            uLength: { value: 1 },
            uSlope: { value: slope }
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
    const q = new THREE.Quaternion();
    const scaleNow = new THREE.Vector3();
    let amount = SOFT_BEAM_MOST;
    return {
        object,
        setColour(rgb) {
            material.uniforms.uColour.value.setRGB(rgb[0], rgb[1], rgb[2]);
            const light = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
            amount = Math.min(SOFT_BEAM_MOST, SOFT_BEAM_LIGHT / Math.max(light, 1e-3));
            object.visible = rgb[0] + rgb[1] + rgb[2] > 0.002;
            return amount * light;      // How bright each crossing of a beam is
        },
        update({ reveal, scale }) {
            object.scale.setScalar(scale);
            object.updateWorldMatrix(true, false);
            const u = material.uniforms;
            object.getWorldPosition(u.uApex.value);
            // The cones open along -y: the axis the north one points along
            u.uAxis.value.set(0, -1, 0).applyQuaternion(object.getWorldQuaternion(q));
            u.uLength.value = object.getWorldScale(scaleNow).y;
            u.uAmount.value = amount * reveal;
        },
        dispose() {
            geometry.dispose();
            material.dispose();
        }
    };
}

// Above SPIN_SHOWN turns a second (layers/exotic_common.js) a pulsar's beams are seen as the eye sees a fast lighthouse:
// their sweep blurred into the two cones they trace round the spin axis. This is the soft beam above, averaged over
// SWEEP_SAMPLES directions round the cone, on a ball that holds the cones, so that every line of sight is worked out once.
// A different start for each pixel turns what would be spokes into a fine grain, which holds still.
const SWEPT_FRAGMENT = /* glsl */`
${LOOP_ZERO_GLSL}
uniform vec3 uColour;
uniform float uAmount;
uniform vec3 uApex;
uniform vec3 uSpin;
uniform vec3 uE1;
uniform vec3 uE2;
uniform float uTilt;
uniform float uLength;
uniform float uSlope;
uniform float uStar;        // The star's radius, which hides what's behind it
varying vec3 vWorld;

float softBeam(vec3 rd, vec3 w0, vec3 axis, float hidden) {
    float b = dot(rd, axis);
    float t = max((b * dot(axis, w0) - dot(rd, w0)) / max(1.0 - b * b, 1e-4), 0.0);
    if (t > hidden) return 0.0;
    vec3 p = w0 + rd * t;
    float s = abs(dot(p, axis));
    float across = length(p - axis * dot(p, axis)) / max(s * uSlope, uLength * 0.004);
    float a = s / uLength;
    float fade = (1.0 - smoothstep(0.1, 1.0, a)) * smoothstep(0.0, 0.08, a);
    return exp(-across * across) * fade;
}

void main() {
    vec3 rd = normalize(vWorld - cameraPosition);
    vec3 w0 = cameraPosition - uApex;
    // Where this line of sight meets the star, if it does
    float mid = -dot(w0, rd);
    float gap = dot(w0, w0) - mid * mid;
    float hidden = gap < uStar * uStar ? mid - sqrt(uStar * uStar - gap) : 1e20;
    float start = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    float light = 0.0;
    for (int k = 0; k < ${SWEEP_SAMPLES} + uLoopZero; k++) {
        float a = (float(k) + start) * ${(2 * Math.PI / SWEEP_SAMPLES).toFixed(6)};
        light += softBeam(rd, w0, uSpin * cos(uTilt) + (uE1 * cos(a) + uE2 * sin(a)) * sin(uTilt), hidden);
    }
    // Each line of sight met each soft cone twice; here it's worked out once
    gl_FragColor = vec4(uColour * light * ${(2 / SWEEP_SAMPLES).toFixed(6)} * uAmount, 1.0);
}`;

function createSweptBeams({ slope, spin }) {
    const geometry = new THREE.SphereGeometry(1, 32, 16);
    const material = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        vertexShader: SOFT_BEAM_VERTEX,
        fragmentShader: SWEPT_FRAGMENT,
        uniforms: {
            uColour: { value: new THREE.Color(...BEAM_TRUE) },
            uAmount: { value: 0 },
            uApex: { value: new THREE.Vector3() },
            uSpin: { value: new THREE.Vector3().fromArray(spin.axis) },
            uE1: { value: new THREE.Vector3().fromArray(spin.e1) },
            uE2: { value: new THREE.Vector3().fromArray(spin.e2) },
            uTilt: { value: spin.tilt },
            uLength: { value: 1 },
            uSlope: { value: slope },
            uStar: { value: 0 }
        }
    });
    const object = new THREE.Mesh(geometry, material);
    object.frustumCulled = false;
    object.renderOrder = 3;
    let amount = SOFT_BEAM_MOST;
    let dark = false;
    return {
        object,
        // The same light as the soft beam's, by the luminance of its colour
        setColour(rgb) {
            material.uniforms.uColour.value.setRGB(rgb[0], rgb[1], rgb[2]);
            const light = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
            amount = Math.min(SOFT_BEAM_MOST, SOFT_BEAM_LIGHT / Math.max(light, 1e-3));
            dark = rgb[0] + rgb[1] + rgb[2] <= 0.002;
        },
        // share: how much of the beams' light is the blur. A ball of the beams' length round the star holds them.
        update({ reveal, scale, share, star }) {
            object.scale.setScalar(scale * 1.02);
            object.visible = !dark && share > 0.001 && reveal > 0.001;
            object.updateWorldMatrix(true, false);
            const u = material.uniforms;
            object.getWorldPosition(u.uApex.value);
            u.uLength.value = scale;
            u.uStar.value = star;
            u.uAmount.value = amount * reveal * share;
        },
        dispose() {
            geometry.dispose();
            material.dispose();
        }
    };
}

// The pulsar the sky shows, turning the same way at the same moment (pulsarSpin in layers/exotic_common.js): the same tilt,
// beam width and turns a second, on the shared clock. sight is the unit vector towards us, where the flight in starts: the
// sky's view of the pulsar is laid along it, so whenever the sky shows a pulse, the beam here points back along the flight.
// Turning faster than SPIN_SHOWN, its beams fade and their blurred sweep takes the rest of their light; turning faster than
// FLICKER_HZ, more so as they grow on the screen (closeTurningShare).
export function createPulsarBeams(body, sight) {
    const spin = pulsarSpin(body, bodyRng(body, 'pulsar'));
    // The sky's frame at the pulsar (right, up, towards us) in this world: up is the world's up, square to the line of sight
    const z = new THREE.Vector3(...sight).normalize();
    const y = new THREE.Vector3(0, 1, 0).addScaledVector(z, -z.y).normalize();
    const x = new THREE.Vector3().crossVectors(y, z);
    const toWorld = (v) => new THREE.Vector3().addScaledVector(x, v[0]).addScaledVector(y, v[1]).addScaledVector(z, v[2]);
    const local = { ...spin, axis: toWorld(spin.axis).toArray(), e1: toWorld(spin.e1).toArray(), e2: toWorld(spin.e2).toArray() };
    const beams = createSoftBeams({ slope: PULSAR_BEAM_SLOPE, sides: 28 });
    const swept = spin.spin < 1 ? createSweptBeams({ slope: PULSAR_BEAM_SLOPE, spin: local }) : null;
    const object = swept ? new THREE.Group().add(beams.object, swept.object) : beams.object;
    const along = [0, 0, 0];
    const pointing = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    const rgb = [0, 0, 0];
    let light = SOFT_BEAM_LIGHT;
    return {
        object,
        // Radio first; some pulsars sweep X-rays too. In visible light they stay the stylised beams they were.
        setBand(w) {
            bandRgb(w, BEAM_TRUE, BEAM_BANDS, rgb);
            light = beams.setColour(rgb);
            if (swept) swept.setColour(rgb);
        },
        // beamPx: how long the beams are on the screen, in CSS pixels (closeTurningShare)
        update({ reveal, radius, beamPx = 0 }) {
            const still = sharedUniforms.uTwinkle.value < 0.5;
            const angle = pulsarAngle(spin, sharedUniforms.uTime.value, still);
            pulsarBeam(local, angle, along);
            // With Reduce motion it holds still, so its beams are whole
            const share = still ? 1 : closeTurningShare(spin.rate, beamPx, light);
            // The beams lie along the object's y axis
            beams.object.quaternion.setFromUnitVectors(Y, pointing.fromArray(along).normalize());
            beams.update({ reveal: reveal * share, scale: radius * 7 });
            if (swept) swept.update({ reveal, scale: radius * 7, share: 1 - share, star: radius });
        },
        dispose() {
            beams.dispose();
            if (swept) swept.dispose();
        }
    };
}