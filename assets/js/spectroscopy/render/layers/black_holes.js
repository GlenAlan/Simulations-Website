// Black holes. From far away you only see the companion star (drawn by stars.js), plus a glow in X-rays and, for some,
// radio jets. Zoomed in, a full-screen pass bends the light of everything behind the hole, cuts out its shadow, and
// draws the accretion disc through the same bent rays, so the far side of the disc arches over the shadow as it really
// would. Sizes are stylised, but the bending, the beaming and the colour shift of the disc follow the real equations.
//
// The pass costs nothing until a hole is big enough on screen to matter, and only the pixels near the hole are shaded.

import * as THREE from 'three';
import { bus } from '../../core/state.js';
import { blackBodyRGB } from '../../core/phys.js';
import { limitingMag, vec3ToAzAlt } from '../../core/sky.js';
import { drawMag, parallaxFactor } from '../../core/depth.js';
import { componentStates } from '../../data/orbits.js';
import { sharedUniforms, skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { DEG, SKY_RADIUS, bodyRng, skyBasis, instancedQuad, smoothstep, exoticNoise } from './exotic_common.js';
import { bendingTables, B_CRIT, TABLE, TABLE_T0, TABLE_T1 } from './bh_geodesic.js';

// All lengths in units of the hole's mass M: the shadow's edge is at b = 5.2, the horizon at r = 2
const R_IN = 6;             // Innermost stable orbit: the disc's inner edge
const R_OUT = 18;           // The disc's outer edge
const LENS_EDGE = 90;       // The pass leaves the sky untouched beyond this distance from the hole
const LENS_K = 140;         // Stylised lens strength: sets the size of the ring of bent stars (about 24 M across)
const STAR_ORBIT = R_OUT * 2.5;

const REVEAL_LO = 5;        // Device pixels of disc radius where the hole starts to appear...
const REVEAL_HI = 14;       // ...and where it has fully arrived
const MAX_HEROES = 4;       // Holes drawn in detail at once. They are far apart, so this is never reached in practice
const LENS_FADE_S = 0.5;    // How long the lens takes to come up if its programs are only just ready
const JET_DEG = 7;          // Jet length as a multiple of the disc's on-sky diameter
const DEEP_STARS = 1500;    // Faint stars around a hole, so that at high zoom there is something to bend

// The disc's on-sky diameter in degrees: stylised, but heavier holes look bigger
function discDegrees(massMsun) {
    const t = Math.log(Math.max(1, massMsun) / 3) / Math.log(10);
    return 0.07 + 0.13 * Math.max(0, Math.min(1, t));
}

function companionAngle(bh, tDays) {
    const states = componentStates(bh.body, tDays);
    if (states.length >= 2) return Math.atan2(states[1].y_AU - states[0].y_AU, states[1].x_AU - states[0].x_AU);
    return 2 * Math.PI * (bh.info.phase0 + tDays / bh.info.period_days) + Math.PI;
}

// Everything about one hole that doesn't change
function makeHole(body) {
    const info = body.black_hole;
    const rng = bodyRng(body, 'hole');
    // Drawn at the disc's own tilt where the data gives one, as the disc needn't lie in the plane of the star's orbit
    const inc = Math.max(8, Math.min(86, info.disc_tilt_deg ?? info.inc_deg)) * DEG;
    const rho = rng.range(-0.6, 0.6);        // Tilt of the disc on the sky
    const si = Math.sin(inc);
    const ci = Math.cos(inc);
    const sr = Math.sin(rho);
    const cr = Math.cos(rho);
    const basis = skyBasis(body.sky.az, body.sky.alt);
    const v = basis.centre;
    const companion = info.companion.star;
    const bh = {
        body,
        info,
        basis,
        world: new THREE.Vector3(v[0], v[1], v[2]).multiplyScalar(SKY_RADIUS),
        discDeg: discDegrees(info.mass_Msun),
        // Disc axes on the sky: x right, y up, z towards the viewer. The far side of the orbit shows above the centre
        // when rho = 0, and orbital +y points away from us, matching vlos_kms in data/orbits.js
        e1: new THREE.Vector3(cr, sr, 0),
        e2: new THREE.Vector3(-sr * ci, cr * ci, -si),
        n: new THREE.Vector3(-sr * si, cr * si, ci),
        // A thin disc is hotter around a lighter hole, T proportional to M^(-1/4). The real disc is X-ray hot; here its
        // colour is scaled down into visible light so the gradient can be seen
        discT: 5800 * (10 / info.mass_Msun) ** 0.25,
        seed: rng.next(),
        thetaC: 0,
        starR: Math.max(1.6, Math.min(4.5, 1.8 + 1.5 * Math.log10(1 + companion.radius_Rsun))),
        starColour: blackBodyRGB(companion.teff_K),
        xray: body.bands.xray,
        uv: body.bands.uv,
        ir: body.bands.ir
    };
    bh.thetaC = companionAngle(bh, 0);
    return bh;
}

// ---- The lens pass ----------------------------------------------------------------------------------------------

const LENS_FRAGMENT = /* glsl */`
    ${BAND_GLSL}
    uniform sampler2D tInput;
    uniform sampler2D tRay;
    uniform sampler2D tEnd;
    uniform sampler2D tNoise;
    uniform sampler2D tBody;
    uniform vec2 uCentrePx;
    uniform vec2 uRes;
    uniform float uPxPerM;
    uniform float uReveal;
    uniform float uK;
    uniform float uEdge;
    uniform float uRIn;
    uniform float uROut;
    uniform float uDiscT;
    uniform float uSeed;
    uniform float uOrders;
    uniform float uLod;
    uniform float uMaskPx;
    uniform float uHotAngle;
    uniform vec3 uN;
    uniform vec3 uE1;
    uniform vec3 uE2;
    uniform vec3 uBandStrength;   // X-ray, UV, IR

    const float PI = 3.14159265;
    const float TAU = 6.2831853;
    const float B_CRIT = ${B_CRIT.toFixed(6)};
    const float WIDTH = ${TABLE.width.toFixed(6)};
    const float T0 = ${TABLE_T0.toFixed(6)};
    const float T1 = ${TABLE_T1.toFixed(6)};
    const float NB = ${TABLE.nB}.0;
    const float NY = ${TABLE.nY}.0;
    const float FLOW = 9.0;       // Disc time (in M) per second of real time: inner orbit in about 10 s
    const float CYCLE = 64.0;     // Noise restarts on this period, cross-faded, so the shear never winds up forever

    float tableX(float b) {
        // asinh by hand: the built-in loses precision for large negative values
        float s = (b - B_CRIT) / WIDTH;
        float t = sign(s) * log(abs(s) + sqrt(s * s + 1.0));
        return ((t - T0) / (T1 - T0)) * (NB - 1.0) / NB + 0.5 / NB;
    }

    float tableY(float y) {
        return y * (NY - 1.0) / NY + 0.5 / NY;
    }

    vec2 mirrored(vec2 uv) {
        return 1.0 - abs(mod(uv, 2.0) - 1.0);
    }

    // Keplerian shear: inner rings lap the outer ones, so noise is dragged into long thin arcs
    float gas(float r, float phi) {
        float om = pow(r, -1.5);
        float clock = uTime * uTwinkle * FLOW / CYCLE;
        float p1 = fract(clock);
        float p2 = fract(clock + 0.5);
        float w = abs(2.0 * p1 - 1.0);
        float lr = log(r);
        float a1 = (phi - om * p1 * CYCLE) / TAU;
        float a2 = (phi - om * p2 * CYCLE) / TAU + 0.37;
        vec4 n1 = textureLod(tNoise, vec2(a1 + uSeed, lr * 1.1 + uSeed * 3.1), uLod);
        vec4 n2 = textureLod(tNoise, vec2(a2 + uSeed, lr * 1.1 + uSeed * 5.3), uLod);
        float soft = mix(n1.r, n2.r, w);
        float fine = mix(
            textureLod(tNoise, vec2(a1 * 2.0 + uSeed, lr * 1.7), uLod).g,
            textureLod(tNoise, vec2(a2 * 2.0 + uSeed, lr * 1.7), uLod).g,
            w
        );
        return 0.72 * soft + 0.28 * fine;
    }

    // Light and opacity of the gas at disc position (r, phi), seen with redshift factor g
    vec4 discLight(float r, float phi, float g) {
        float f = uRIn / r;
        float inner = smoothstep(uRIn * 0.97, uRIn * 1.1, r);
        float outer = 1.0 - smoothstep(uROut * 0.5, uROut, r);
        float Tn = pow(f, 0.75) * pow(max(1.0 - sqrt(f), 0.0), 0.12) / 0.62;

        float n = gas(r, phi);
        float clumps = 0.28 + 2.0 * pow(n, 1.8);

        // Where the stream from the companion lands
        float dPhi = mod(phi - uHotAngle + PI, TAU) - PI;
        float rh = uROut * 0.8;
        float spot = exp(-((r - rh) * (r - rh)) / 3.0 - (dPhi * rh * dPhi * rh) / 7.0);

        float d = inner * outer * clumps;

        // Visible: the temperature sets the colour and the observed temperature is shifted by g
        float T = max(uDiscT * Tn * g * (1.0 + 0.5 * spot), 2300.0);
        vec3 bb = pow(textureLod(tBody, vec2(log(clamp(T, 1000.0, 40000.0) / 1000.0) / log(40.0), 0.5), 0.0).rgb, vec3(1.2));
        float g3 = g * g * g;
        vec3 visible = bb * (2.0 * pow(f, 1.3) * g3 * d + 1.2 * spot * inner);

        // False colour bands. X-rays come only from the hottest gas close in, UV from further out, IR from the cool rim
        float x = pow(Tn, 6.0) * g3 * g * d * 7.0 * uBandStrength.x + 3.0 * spot * uBandStrength.x;
        float u = pow(Tn, 3.5) * g3 * d * 3.4 * uBandStrength.y + 2.2 * spot * uBandStrength.y;
        float i = (1.0 - 0.6 * Tn) * g * d * 0.35 * uBandStrength.z;

        vec3 light = visible * uBandW[2]
            + uBandTint[4] * (uBandW[4] * x) + vec3(1.0) * (uBandW[4] * x * x * 0.03)
            + uBandTint[3] * (uBandW[3] * u)
            + uBandTint[1] * (uBandW[1] * i);

        // Radio passes straight through the disc; everything else is mostly blocked by it
        float opacity = clamp(d * 1.5, 0.0, 0.94) * (1.0 - uBandW[0]) * (1.0 - 0.7 * uBandW[1]);
        return vec4(light, opacity);
    }

    void main() {
        vec2 off = gl_FragCoord.xy - uCentrePx;
        float b = max(length(off) / uPxPerM, 0.001);
        vec2 dir = off / (b * uPxPerM);
        float pxM = 1.0 / uPxPerM;   // One device pixel, in M

        float tx = tableX(b);
        vec2 ends = texture2D(tEnd, vec2(tx, 0.5)).rg;
        float psiEnd = ends.r;

        // What's behind: bend the ray, then read the sky where it really came from. Past the edge of the screen,
        // reflect the picture: a thin ring close to the shadow, where nobody can tell
        float bend = b < 60.0 ? ends.g : 4.0 / b + 11.78 / (b * b);
        float w = smoothstep(uEdge, uEdge * 0.35, b);
        float beta = b - uK * bend * w;
        // The companion's sprite in stars.js sits at the lens centre, and the lens would turn it into a ring. So read
        // the sky no closer to the centre than the sprite reaches: what's there is the same diffuse glow, with no star
        float reach = uMaskPx / uPxPerM;
        float read = (beta < 0.0 ? -1.0 : 1.0) * max(abs(beta), reach);
        vec3 sky = texture2D(tInput, mirrored((uCentrePx + dir * read * uPxPerM) / uRes)).rgb;

        // Everything captured is black
        float outside = smoothstep(B_CRIT - pxM, B_CRIT + pxM, b);
        sky *= outside;

        // The disc, front to back. A ray stays in the plane through the line of sight and dir, and crosses the disc's
        // plane every pi of swept angle: order 0 is the direct view, 1 the image bent right around the hole, and so on
        vec3 light = vec3(0.0);
        float clear = 1.0;
        float angularMomentum = b * (uN.x * dir.y - uN.y * dir.x);
        if (b < uROut * 2.6) {
            float psi0 = atan(uN.z, -dot(uN.xy, dir));
            for (int k = 0; k < 3; k++) {
                if (float(k) >= uOrders) break;
                float psi = psi0 + float(k) * PI;
                if (psi >= psiEnd) break;
                float u = textureLod(tRay, vec2(tx, tableY(psi / psiEnd)), 0.0).r;
                if (u < 1.0 / uROut || u > 1.0 / (uRIn * 0.95)) continue;
                float r = 1.0 / u;
                vec3 P = vec3(sin(psi) * dir, cos(psi));
                float phi = atan(dot(P, uE2), dot(P, uE1));
                // Energy shift of gas on a circular orbit: gravity (the sqrt) and motion (the denominator)
                float g = sqrt(max(1.0 - 3.0 / r, 0.03)) / max(1.0 - pow(r, -1.5) * angularMomentum, 0.1);
                vec4 s = discLight(r, phi, g);
                light += clear * s.rgb;
                clear *= 1.0 - s.a;
            }
        }

        // The photon ring: every higher order piled up in a line too thin to resolve, so draw it as what it looks like
        vec3 warm = uBandW[2] * vec3(1.0, 0.72, 0.46) * 1.6 + uBandTint[4] * (uBandW[4] * 2.4 * uBandStrength.x)
            + uBandTint[3] * (uBandW[3] * 1.5 * uBandStrength.y);
        float sigma = max(0.1, 1.2 * pxM);
        float rim = (b - B_CRIT) / sigma;
        float approaching = 0.5 + 0.5 * clamp(angularMomentum / B_CRIT / max(length(uN.xy), 0.2), -1.0, 1.0);
        light += clear * warm * exp(-rim * rim) * (0.35 + 1.5 * approaching * approaching);

        // A soft halo of scattered light outside the shadow
        float beyond = max(b - B_CRIT, 0.0) / (uROut * 0.34);
        float halo = exp(-beyond * beyond) * outside * w;
        light += warm * halo * 0.035;

        vec3 colour = sky * clear + light;
        // While it arrives, fade over from the untouched sky: a half-strength lens only smears what's there
        if (uReveal < 0.999) colour = mix(texture2D(tInput, gl_FragCoord.xy / uRes).rgb, colour, uReveal);
        gl_FragColor = vec4(colour, 1.0);
    }`;

function createLensPass() {
    const tables = bendingTables();
    const { nB, nY } = TABLE;
    const half = THREE.DataUtils.toHalfFloat;

    const rayData = new Uint16Array(nB * nY);
    for (let i = 0; i < rayData.length; i++) rayData[i] = half(tables.ray[i]);
    const tRay = new THREE.DataTexture(rayData, nB, nY, THREE.RedFormat, THREE.HalfFloatType);
    const endData = new Uint16Array(nB * 2);
    for (let i = 0; i < nB; i++) {
        endData[i * 2] = half(tables.psiEnd[i]);
        endData[i * 2 + 1] = half(tables.deflection[i]);
    }
    const tEnd = new THREE.DataTexture(endData, nB, 1, THREE.RGFormat, THREE.HalfFloatType);

    // Black-body colours, log-spaced from 1,000 K to 40,000 K
    const bodyData = new Uint16Array(128 * 4);
    for (let i = 0; i < 128; i++) {
        const rgb = blackBodyRGB(1000 * 40 ** (i / 127));
        bodyData[i * 4] = half(rgb[0]);
        bodyData[i * 4 + 1] = half(rgb[1]);
        bodyData[i * 4 + 2] = half(rgb[2]);
        bodyData[i * 4 + 3] = half(1);
    }
    const tBody = new THREE.DataTexture(bodyData, 128, 1, THREE.RGBAFormat, THREE.HalfFloatType);

    [tRay, tEnd, tBody].forEach((t) => {
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.wrapS = THREE.ClampToEdgeWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.needsUpdate = true;
    });

    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const plane = new THREE.PlaneGeometry(2, 2);

    const copyMaterial = new THREE.ShaderMaterial({
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        blending: THREE.NoBlending,
        uniforms: { tInput: { value: null } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'uniform sampler2D tInput; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(tInput, vUv).rgb, 1.0); }'
    });
    const copyScene = new THREE.Scene();
    const copyMesh = new THREE.Mesh(plane, copyMaterial);
    copyMesh.frustumCulled = false;
    copyScene.add(copyMesh);

    const lensMaterial = skyMaterial({
        transparent: false,
        blending: THREE.NoBlending,
        uniforms: {
            tInput: { value: null },
            tRay: { value: tRay },
            tEnd: { value: tEnd },
            tNoise: { value: exoticNoise() },
            tBody: { value: tBody },
            uCentreNdc: { value: new THREE.Vector2() },
            uHalfNdc: { value: new THREE.Vector2(1, 1) },
            uCentrePx: { value: new THREE.Vector2() },
            uRes: { value: new THREE.Vector2(1, 1) },
            uPxPerM: { value: 1 },
            uReveal: { value: 1 },
            uK: { value: LENS_K },
            uEdge: { value: LENS_EDGE },
            uRIn: { value: R_IN },
            uROut: { value: R_OUT },
            uDiscT: { value: 7000 },
            uSeed: { value: 0 },
            uOrders: { value: 3 },
            uLod: { value: 0 },
            uMaskPx: { value: 16 },
            uHotAngle: { value: 0 },
            uN: { value: new THREE.Vector3(0, 0, 1) },
            uE1: { value: new THREE.Vector3(1, 0, 0) },
            uE2: { value: new THREE.Vector3(0, 1, 0) },
            uBandStrength: { value: new THREE.Vector3(1, 1, 1) }
        },
        vertexShader: /* glsl */`
            uniform vec2 uCentreNdc;
            uniform vec2 uHalfNdc;
            void main() {
                gl_Position = vec4(uCentreNdc + position.xy * uHalfNdc, 0.0, 1.0);
            }`,
        fragmentShader: LENS_FRAGMENT
    });
    const lensScene = new THREE.Scene();
    const lensMesh = new THREE.Mesh(plane, lensMaterial);
    lensMesh.frustumCulled = false;
    lensScene.add(lensMesh);

    return {
        compile: (engine) => Promise.all([engine.compileInBackground(copyScene, camera), engine.compileInBackground(lensScene, camera)]),
        copy(renderer, input) {
            copyMaterial.uniforms.tInput.value = input;
            renderer.render(copyScene, camera);
        },
        lens(renderer, input, target, hero, frame) {
            const bh = hero.bh;
            const u = lensMaterial.uniforms;
            const w = target.width;
            const h = target.height;
            u.tInput.value = input;
            u.uRes.value.set(w, h);
            u.uCentreNdc.value.set(hero.ndcX, hero.ndcY);
            u.uHalfNdc.value.set((LENS_EDGE * hero.pxPerM * 2) / w, (LENS_EDGE * hero.pxPerM * 2) / h);
            u.uCentrePx.value.set((hero.ndcX * 0.5 + 0.5) * w, (hero.ndcY * 0.5 + 0.5) * h);
            u.uPxPerM.value = hero.pxPerM;
            u.uReveal.value = hero.reveal;
            u.uDiscT.value = bh.discT;
            u.uSeed.value = bh.seed;
            // Thin arcs below a pixel across only flicker, and Low quality saves a read per pixel
            u.uOrders.value = frame.quality === 'low' || hero.pxPerM < 1 ? 2 : 3;
            u.uLod.value = Math.max(0, Math.log2(25 / hero.pxPerM));
            u.uMaskPx.value = 22 * frame.dpr;
            u.uHotAngle.value = bh.thetaC + STREAM_LEAD;
            u.uN.value.copy(bh.n);
            u.uE1.value.copy(bh.e1);
            u.uE2.value.copy(bh.e2);
            u.uBandStrength.value.set(Math.max(0.5, bh.xray), Math.max(0.5, bh.uv), Math.max(0.3, bh.ir));
            renderer.render(lensScene, camera);
        },
        dispose() {
            [tRay, tEnd, tBody].forEach((t) => t.dispose());
            plane.dispose();
            copyMaterial.dispose();
            lensMaterial.dispose();
        }
    };
}

// ---- What is drawn on top of the bent picture: the companion star and the stream of gas it loses -------------------

const STREAM_LEAD = 1.15;   // How far round the orbit the stream lands, ahead of the star (radians)
const STREAM_SEGMENTS = 48;

function streamGeometry() {
    const positions = new Float32Array((STREAM_SEGMENTS + 1) * 2 * 3);
    const index = [];
    for (let i = 0; i <= STREAM_SEGMENTS; i++) {
        const s = i / STREAM_SEGMENTS;
        positions.set([s, -1, 0, s, 1, 0], i * 6);
        if (i < STREAM_SEGMENTS) {
            const a = i * 2;
            index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(index);
    return geometry;
}

function createCompanionMesh(plane) {
    const material = skyMaterial({
        uniforms: {
            tNoise: { value: exoticNoise() },
            uCentreNdc: { value: new THREE.Vector2() },
            uHalfNdc: { value: new THREE.Vector2(0.1, 0.1) },
            uToHole: { value: new THREE.Vector2(1, 0) },
            uColour: { value: new THREE.Vector3(1, 1, 1) },
            uAmtA: { value: new THREE.Vector4(0, 1, 1, 0.2) },
            uAmtB: { value: 0.05 },
            uFade: { value: 1 },
            uSeed: { value: 0 },
            uDetail: { value: 1 }
        },
        vertexShader: /* glsl */`
            uniform vec2 uCentreNdc;
            uniform vec2 uHalfNdc;
            varying vec2 vP;
            void main() {
                vP = position.xy;
                gl_Position = vec4(uCentreNdc + position.xy * uHalfNdc, 0.0, 1.0);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            uniform sampler2D tNoise;
            uniform vec2 uToHole;
            uniform vec3 uColour;
            uniform vec4 uAmtA;
            uniform float uAmtB;
            uniform float uFade;
            uniform float uSeed;
            uniform float uDetail;
            varying vec2 vP;
            void main() {
                // The hole's pull draws the star out a little towards it
                const float R = 0.22;
                float along = dot(vP, uToHole);
                float across = dot(vP, vec2(-uToHole.y, uToHole.x));
                float pull = clamp(along / R, 0.0, 1.3);
                vec2 q = vec2(along / (1.0 + 0.16 * pull), across * (1.0 + 0.2 * pull * pull));
                float d = length(q) / R;
                float surface = smoothstep(1.04, 0.96, d);
                float limb = sqrt(max(1.0 - d * d, 0.0));
                float cells = texture2D(tNoise, vP * 0.55 + uSeed + 0.008 * uTime * uTwinkle).a;
                float disc = surface * (0.22 + 0.78 * limb) * mix(1.0, 0.72 + 0.56 * cells, uDetail) * 0.8;
                float corona = (1.0 - surface * 0.9) * (exp(-max(d - 1.0, 0.0) * 2.6) * 0.26 + 0.04 * exp(-d * 0.45));
                float edge = smoothstep(1.0, 0.7, length(vP));
                vec3 light = bandColour(pow(uColour, vec3(1.25))) * (disc + corona * edge) * bandAmount(uAmtA, uAmtB) * uFade;
                gl_FragColor = vec4(light, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(plane, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return mesh;
}

function createStreamMesh(geometry) {
    const material = skyMaterial({
        side: THREE.DoubleSide,
        uniforms: {
            tNoise: { value: exoticNoise() },
            uCentrePx: { value: new THREE.Vector2() },
            uRes: { value: new THREE.Vector2(1, 1) },
            uPxPerM: { value: 1 },
            uE1: { value: new THREE.Vector3(1, 0, 0) },
            uE2: { value: new THREE.Vector3(0, 1, 0) },
            uTheta: { value: 0 },
            uRFrom: { value: 40 },
            uRTo: { value: 15 },
            uLead: { value: STREAM_LEAD },
            uColour: { value: new THREE.Vector3(1, 1, 1) },
            uFade: { value: 1 },
            uSeed: { value: 0 },
            uBandStrength: { value: new THREE.Vector3(1, 1, 1) }
        },
        vertexShader: /* glsl */`
            uniform vec2 uCentrePx;
            uniform vec2 uRes;
            uniform float uPxPerM;
            uniform vec3 uE1;
            uniform vec3 uE2;
            uniform float uTheta;
            uniform float uRFrom;
            uniform float uRTo;
            uniform float uLead;
            varying float vS;
            varying float vSide;

            vec2 pathAt(float s) {
                // A falling, curving path: the orbital motion of the star it left carries it round ahead of the hole
                float th = uTheta + uLead * pow(s, 1.6);
                float r = mix(uRFrom, uRTo, pow(s, 0.9));
                vec3 p = (uE1 * cos(th) + uE2 * sin(th)) * r;
                // Gas behind the hole is seen by bent light, like the star
                float depth = max(-p.z, 0.0);
                float b = max(length(p.xy), 0.001);
                return p.xy * (0.5 + 0.5 * sqrt(1.0 + 16.0 * depth / (b * b)));
            }

            void main() {
                float s = position.x;
                vS = s;
                vSide = position.y;
                vec2 a = pathAt(s);
                vec2 t = normalize(pathAt(s + 0.01) - a + vec2(1e-5, 0.0));
                float halfWidth = max(mix(0.42, 0.2, s) * uPxPerM, 1.3) * 3.2;
                vec2 px = uCentrePx + a * uPxPerM + vec2(-t.y, t.x) * position.y * halfWidth;
                gl_Position = vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            uniform sampler2D tNoise;
            uniform vec3 uColour;
            uniform vec3 uBandStrength;
            uniform float uFade;
            uniform float uSeed;
            varying float vS;
            varying float vSide;
            void main() {
                float across = vSide * 3.2;
                float core = exp(-across * across * 1.1) + 0.28 * exp(-across * across * 0.28);
                float clump = texture2D(tNoise, vec2(vS * 0.9 - uTime * uTwinkle * 0.05 + uSeed, vSide * 0.07 + uSeed)).r;
                float along = smoothstep(0.0, 0.08, vS) * (0.25 + 2.2 * clump * clump) * (0.5 + 0.5 * vS);
                vec3 hot = mix(uColour, vec3(1.0, 0.82, 0.62), smoothstep(0.1, 0.95, vS));
                vec3 light = hot * uBandW[2] * 0.42
                    + uBandTint[3] * (uBandW[3] * (0.3 + 1.1 * vS) * uBandStrength.y)
                    + uBandTint[4] * (uBandW[4] * vS * vS * 1.1 * uBandStrength.x)
                    + uBandTint[1] * (uBandW[1] * 0.25 * uBandStrength.z);
                gl_FragColor = vec4(light * core * along * uFade, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    return mesh;
}

// Faint stars around a hole, brighter ones first as you zoom in, as everywhere else in the sky
function createDeepStars(engine, geometry, dprUniform) {
    const material = skyMaterial({
        uniforms: {
            uCentre: { value: new THREE.Vector3() },
            uEast: { value: new THREE.Vector3() },
            uUp: { value: new THREE.Vector3() },
            uReveal: { value: 0 },
            uDpr: dprUniform,
            uDepth: { value: 0 },
            uKeepDeg: { value: 99 }
        },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            uniform vec3 uCentre;
            uniform vec3 uEast;
            uniform vec3 uUp;
            uniform float uReveal;
            uniform float uDpr;
            uniform float uDepth;
            uniform float uKeepDeg;
            attribute vec3 aStar;     // Offset in degrees, brightness 0..1
            attribute vec3 aColour;
            varying vec3 vLight;
            void main() {
                const float RAD = 0.0174533;
                vec3 dir = uCentre + (uEast * aStar.x + uUp * aStar.y) * RAD;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(dir * ${SKY_RADIUS}.0, 1.0);
                gl_Position.xy *= depthP(uDepth);
                float cut = mix(0.08, 1.05, smoothstep(0.5, 3.0, uFov));
                // Without the background stars, only those the hole is seen to bend: a click on those finds the hole
                float shown = smoothstep(cut - 0.05, cut + 0.1, aStar.z) * step(dot(aStar.xy, aStar.xy), uKeepDeg * uKeepDeg);
                float edge = exp(-dot(aStar.xy, aStar.xy) * 1.6);
                float amount = uBandW[2] + 0.5 * uBandW[1] + 0.35 * uBandW[3] + 0.08 * uBandW[4] + 0.03 * uBandW[0];
                vLight = bandColour(aColour) * (0.28 + 2.4 * aStar.z * aStar.z) * shown * edge * uReveal * amount * uSkyFade;
                gl_PointSize = (shown * edge * uReveal > 0.003 ? 1.0 : 0.0) * (2.0 + 2.2 * aStar.z) * uDpr;
            }`,
        fragmentShader: /* glsl */`
            varying vec3 vLight;
            void main() {
                float r = length(gl_PointCoord - 0.5) * 2.0;
                gl_FragColor = vec4(vLight * exp(-r * r * 4.5), 1.0);
            }`
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = ORDER.background + 1;
    points.visible = false;
    engine.scene.add(points);
    return points;
}

function deepStarGeometry() {
    const rng = bodyRng({ code: 'deep-stars' });
    const stars = new Float32Array(DEEP_STARS * 3);
    const colours = new Float32Array(DEEP_STARS * 3);
    for (let i = 0; i < DEEP_STARS; i++) {
        const r = 1.35 * Math.sqrt(rng.next());
        const a = rng.range(0, Math.PI * 2);
        stars.set([r * Math.cos(a), r * Math.sin(a), rng.next() ** 2.2], i * 3);
        colours.set(blackBodyRGB(rng.logRange(3200, 14000)), i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(stars, 3)); // Three needs a position to size the draw
    geometry.setAttribute('aStar', new THREE.BufferAttribute(stars, 3));
    geometry.setAttribute('aColour', new THREE.BufferAttribute(colours, 3));
    return geometry;
}

// ---- Always on: the X-ray glow of every hole, and the jets of some ------------------------------------------------

function createGlows(engine, holes) {
    const n = holes.length;
    const geometry = instancedQuad(n);
    const centres = new Float32Array(n * 3);
    const bandA = new Float32Array(n * 4);
    const bandB = new Float32Array(n);
    const params = new Float32Array(n * 2);
    const depths = new Float32Array(n);
    holes.forEach((bh, i) => {
        depths[i] = bh.body.depth;
        centres.set([bh.world.x, bh.world.y, bh.world.z], i * 3);
        // The disc is the detection, so it's the X-ray and UV strengths that matter. Not in visible or IR
        bandA.set([bh.body.bands.radio * 0.25, 0, 0, bh.body.bands.uv * 0.55], i * 4);
        bandB[i] = bh.body.bands.xray;
        params.set([bh.discDeg, bh.seed], i * 2);
    });
    geometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(centres, 3));
    geometry.setAttribute('aBandA', new THREE.InstancedBufferAttribute(bandA, 4));
    geometry.setAttribute('aBandB', new THREE.InstancedBufferAttribute(bandB, 1));
    geometry.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 2));
    geometry.setAttribute('aDepth', new THREE.InstancedBufferAttribute(depths, 1));

    const material = skyMaterial({
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            attribute vec3 aCentre;
            attribute vec4 aBandA;
            attribute float aBandB;
            attribute vec2 aParams;
            attribute float aDepth;
            varying vec2 vP;
            varying float vAmount;
            void main() {
                float discPx = radians(aParams.x) * 0.5 * uPxPerRad * depthP(aDepth);
                float hide = 1.0 - smoothstep(${REVEAL_LO.toFixed(1)}, ${REVEAL_HI.toFixed(1)}, discPx);
                // X-ray binaries flicker: slowly, as the inner disc breathes
                float flicker = 1.0 + 0.12 * uTwinkle * sin(uTime * (0.9 + aParams.y) + aParams.y * 40.0);
                vAmount = bandAmount(aBandA, aBandB) * hide * flicker * uSkyFade;
                vP = position.xy;
                vec4 c = modelViewMatrix * vec4(aCentre, 1.0);
                c.xy *= depthP(aDepth);
                float sizePx = (vAmount > 0.002 ? 1.0 : 0.0) * uViewport.y * (0.02 + 0.035 * vAmount);
                c.xy += position.xy * sizePx * length(c.xyz) / uPxPerRad;
                gl_Position = projectionMatrix * c;
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            varying vec2 vP;
            varying float vAmount;
            void main() {
                float r = length(vP);
                float glow = 2.6 * exp(-r * r * 90.0) + 0.55 * exp(-r * r * 14.0) + 0.14 / (1.0 + r * r * 30.0);
                glow *= smoothstep(1.0, 0.6, r);
                gl_FragColor = vec4(bandColour(vec3(1.0)) * glow * vAmount, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.exotic;
    engine.scene.add(mesh);
    return mesh;
}

function jetMaterial(pass, noise) {
    return skyMaterial({
        uniforms: { tNoise: { value: noise }, uPass: { value: pass } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            uniform float uPass;
            attribute vec3 aCentre;
            attribute vec2 aAxis;
            attribute vec4 aJet;      // half-length (deg), disc diameter (deg), near brightness, far brightness
            attribute vec2 aBandJet;  // radio strength, seed
            attribute float aDepth;
            varying vec2 vP;
            varying vec2 vDoppler;
            varying float vRadio;
            varying float vReveal;
            varying float vSeed;
            varying float vLenM;
            void main() {
                float discPx = radians(aJet.y) * 0.5 * uPxPerRad * depthP(aDepth);
                vReveal = smoothstep(${REVEAL_LO.toFixed(1)}, ${REVEAL_HI.toFixed(1)}, discPx);
                // Holes in detail have their jets drawn over the bent picture, the rest in the sky as usual
                float hero = step(0.0001, vReveal);
                float gate = uPass > 0.5 ? hero : 1.0 - hero;
                vDoppler = aJet.zw;
                vRadio = aBandJet.x;
                vSeed = aBandJet.y;
                vLenM = aJet.x / aJet.y * ${(R_OUT * 2).toFixed(1)};
                vP = position.xy;
                vec4 c = modelViewMatrix * vec4(aCentre, 1.0);
                float dist = length(c.xyz);
                float hl = tan(radians(aJet.x)) * dist;
                float hw = max(hl * 0.09, 5.0 * dist / uPxPerRad);
                c.xy += (aAxis * position.x * hl + vec2(-aAxis.y, aAxis.x) * position.y * hw) * gate;
                gl_Position = projectionMatrix * c;
                gl_Position.xy *= depthP(aDepth);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            uniform sampler2D tNoise;
            varying vec2 vP;
            varying vec2 vDoppler;
            varying float vRadio;
            varying float vReveal;
            varying float vSeed;
            varying float vLenM;
            void main() {
                float along = abs(vP.x);
                float side = vP.x > 0.0 ? 1.0 : 0.0;
                float beam = mix(vDoppler.y, vDoppler.x, side);
                float spread = mix(0.012, 0.15, sqrt(along));
                // A slow corkscrew: the field that holds the jet together winds round it
                float w = (vP.y - spread * 0.16 * sin(along * 26.0 + vSeed * 20.0 + side * 2.0)) / spread;
                float core = exp(-w * w * 2.4);
                float sheath = 0.16 * exp(-w * w * 0.3);
                float flow = texture2D(tNoise, vec2(along * 2.2 - uTime * uTwinkle * 0.07 + vSeed + side * 0.5, vSeed)).g;
                float knots = 0.3 + 2.2 * flow * flow * flow;
                float fall = pow(max(1.0 - along, 0.0), 1.3) * smoothstep(1.0, 0.82, length(vec2(along, vP.y)));
                float base = core + sheath;
                // The far jet starts behind the shadow and the disc
                float m = along * vLenM;
                float hidden = mix(smoothstep(7.0, 22.0, m) * vReveal + (1.0 - vReveal), 1.0, side);

                // Radio all the time, visible and the shorter bands only near the hole and only when zoomed in
                float inner = exp(-along * 5.0);
                float radio = uBandW[0] * vRadio * 2.2;
                vec3 light = uBandTint[0] * radio
                    + vReveal * (vec3(0.5, 0.72, 1.0) * uBandW[2] * 1.2 * inner
                        + uBandTint[3] * (uBandW[3] * 0.8 * inner)
                        + uBandTint[4] * (uBandW[4] * 1.1 * inner));
                gl_FragColor = vec4(light * base * knots * fall * beam * hidden * uSkyFade, 1.0);
            }`
    });
}

function createJets(holes) {
    const withJets = holes.filter((bh) => bh.info.jets);
    const n = withJets.length;
    if (!n) return null;
    const geometry = instancedQuad(n);
    const centres = new Float32Array(n * 3);
    const axes = new Float32Array(n * 2);
    const jets = new Float32Array(n * 4);
    const bandJet = new Float32Array(n * 2);
    const jetDepths = new Float32Array(n);
    withJets.forEach((bh, i) => {
        jetDepths[i] = bh.body.depth;
        const nxy = Math.hypot(bh.n.x, bh.n.y) || 1;
        centres.set([bh.world.x, bh.world.y, bh.world.z], i * 3);
        axes.set([bh.n.x / nxy, bh.n.y / nxy], i * 2);
        // Relativistic beaming: at 0.9 c the jet coming towards us is far brighter than the one going away
        const beta = 0.9;
        const gamma = 1 / Math.sqrt(1 - beta * beta);
        const near = 1 / (gamma * (1 - beta * bh.n.z));
        const far = 1 / (gamma * (1 + beta * bh.n.z));
        jets.set([bh.discDeg * JET_DEG * Math.max(0.3, nxy) * 0.5, bh.discDeg, Math.min(2.4, near ** 1.2), far ** 1.2], i * 4);
        bandJet.set([bh.body.bands.radio, bh.seed], i * 2);
    });
    geometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(centres, 3));
    geometry.setAttribute('aAxis', new THREE.InstancedBufferAttribute(axes, 2));
    geometry.setAttribute('aJet', new THREE.InstancedBufferAttribute(jets, 4));
    geometry.setAttribute('aBandJet', new THREE.InstancedBufferAttribute(bandJet, 2));
    geometry.setAttribute('aDepth', new THREE.InstancedBufferAttribute(jetDepths, 1));
    const noise = exoticNoise();
    const sky = new THREE.Mesh(geometry, jetMaterial(0, noise));
    const front = new THREE.Mesh(geometry, jetMaterial(1, noise));
    sky.frustumCulled = false;
    front.frustumCulled = false;
    sky.renderOrder = ORDER.exotic;
    front.renderOrder = 0;
    return { sky, front, geometry };
}

// ---- The layer ---------------------------------------------------------------------------------------------------

export function createBlackHolesLayer(engine, app) {
    const holes = app.universe.bodies.filter((b) => b.kind === 'black_hole' && b.black_hole).map(makeHole);
    const byCode = new Map(holes.map((bh) => [bh.body.code, bh]));
    const glows = holes.length ? createGlows(engine, holes) : null;
    const jets = holes.length ? createJets(holes) : null;
    if (jets) engine.scene.add(jets.sky);

    const frontScene = new THREE.Scene();
    if (jets) frontScene.add(jets.front);

    // Created the first time a hole comes close enough to need them
    let lens = null;
    let plane = null;
    let streamGeo = null;
    let starGeo = null;
    const dprUniform = { value: 1 };
    const heroes = [];
    for (let i = 0; i < MAX_HEROES; i++) {
        heroes.push({ bh: null, reveal: 0, pxPerM: 1, ndcX: 0, ndcY: 0, starX: 0, starY: 0, companion: null, stream: null, stars: null });
    }
    let heroCount = 0;
    const v = new THREE.Vector3();
    const pickList = [];

    function ensureBuilt() {
        if (lens) return;
        lens = createLensPass();
        plane = new THREE.PlaneGeometry(2, 2);
        streamGeo = streamGeometry();
        starGeo = deepStarGeometry();
        heroes.forEach((hero) => {
            hero.companion = createCompanionMesh(plane);
            hero.stream = createStreamMesh(streamGeo);
            hero.stars = createDeepStars(engine, starGeo, dprUniform);
            frontScene.add(hero.stream, hero.companion);
        });
        compileLens();
    }

    // The lens waits for its programs, as drawing with unfinished ones would hold the page up. Until they're ready
    // the hole just stays as it was, and then the bending of the sky comes up over the next moment.
    let lensReady = false;
    let lensFade = 0;
    let lensRun = 0;
    function compileLens() {
        const run = ++lensRun;
        lensReady = false;
        lensFade = 0;
        Promise.all([lens.compile(engine), engine.compileInBackground(frontScene)]).then(() => {
            if (run === lensRun) lensReady = true;
        });
    }
    const offRestored = bus.on('gl-restored', () => {
        if (lens) compileLens();
    });

    function placeHero(hero, bh, reveal, pxPerM, p) {
        hero.bh = bh;
        hero.reveal = reveal;
        hero.pxPerM = pxPerM;
        hero.ndcX = v.x * p;
        hero.ndcY = v.y * p;
    }

    // Keep the biggest holes on screen, without allocating
    function collectHeroes(frame) {
        heroCount = 0;
        // A flight into the system goes on showing it as the sky fades, so that it doesn't vanish as the flight begins
        const shows = frame.view === 'sky' || (app.system && app.system.skyShows());
        if (!shows || sharedUniforms.uSkyFade.value < 0.01) return;
        const w = frame.width * frame.dpr;
        const h = frame.height * frame.dpr;
        for (let i = 0; i < holes.length; i++) {
            const bh = holes[i];
            const p = parallaxFactor(bh.body.depth, frame.fov);
            const radiusPx = bh.discDeg * DEG * 0.5 * frame.pxPerRad * p;
            if (radiusPx < REVEAL_LO) continue;
            v.copy(bh.world).project(frame.camera);
            if (v.z > 1 || v.z < -1) continue;
            const pxPerM = radiusPx / R_OUT;
            const reach = (LENS_EDGE * pxPerM * 2);
            if (Math.abs(v.x * p) > 1 + reach / w || Math.abs(v.y * p) > 1 + reach / h) continue;
            const reveal = smoothstep(REVEAL_LO, REVEAL_HI, radiusPx) * sharedUniforms.uSkyFade.value * lensFade;
            if (heroCount < MAX_HEROES) {
                placeHero(heroes[heroCount++], bh, reveal, pxPerM, p);
            } else {
                let smallest = 0;
                for (let k = 1; k < MAX_HEROES; k++) if (heroes[k].pxPerM < heroes[smallest].pxPerM) smallest = k;
                if (pxPerM > heroes[smallest].pxPerM) placeHero(heroes[smallest], bh, reveal, pxPerM, p);
            }
        }
    }

    function updateHero(hero, frame) {
        const bh = hero.bh;
        const w = frame.width * frame.dpr;
        const h = frame.height * frame.dpr;
        const cx = (hero.ndcX * 0.5 + 0.5) * w;
        const cy = (hero.ndcY * 0.5 + 0.5) * h;

        // Where the star is on its orbit, seen from here
        const c = Math.cos(bh.thetaC);
        const s = Math.sin(bh.thetaC);
        const px = bh.e1.x * c + bh.e2.x * s;
        const py = bh.e1.y * c + bh.e2.y * s;
        const pz = bh.e1.z * c + bh.e2.z * s;

        let ox = px * STAR_ORBIT;
        let oy = py * STAR_ORBIT;
        // Seen behind the hole, its light has been bent on the way to us. Thin lens with the star's true depth:
        // beta = b - 4 D / b, so the image stands off from the centre and the star never crosses the shadow
        const depth = Math.max(-pz * STAR_ORBIT, 0);
        const beta = Math.max(Math.hypot(ox, oy), 0.001);
        const stretch = 0.5 + 0.5 * Math.sqrt(1 + (16 * depth) / (beta * beta));
        ox *= stretch;
        oy *= stretch;
        hero.starX = ox;
        hero.starY = oy;

        const lim = limitingMag(frame.fov);
        const brightness = Math.max(0.55, Math.min(1.5, 0.75 + 0.1 * (lim - drawMag(bh.body))));

        const star = hero.companion.material.uniforms;
        const quad = bh.starR * 4.5 * hero.pxPerM;
        star.uCentreNdc.value.set(hero.ndcX + (ox * hero.pxPerM * 2) / w, hero.ndcY + (oy * hero.pxPerM * 2) / h);
        star.uHalfNdc.value.set((quad * 2) / w, (quad * 2) / h);
        const toHole = Math.hypot(ox, oy) || 1;
        star.uToHole.value.set(-ox / toHole, -oy / toHole);
        star.uColour.value.set(bh.starColour[0], bh.starColour[1], bh.starColour[2]);
        star.uAmtA.value.set(bh.body.bands.radio * 0.05, Math.max(0.6, bh.ir), 1, 0.3);
        star.uAmtB.value = 0.08;
        star.uFade.value = hero.reveal * brightness;
        star.uSeed.value = bh.seed;
        star.uDetail.value = smoothstep(4, 16, quad * 0.22);
        hero.companion.visible = true;

        const gas = hero.stream.material.uniforms;
        gas.uCentrePx.value.set(cx, cy);
        gas.uRes.value.set(w, h);
        gas.uPxPerM.value = hero.pxPerM;
        gas.uE1.value.copy(bh.e1);
        gas.uE2.value.copy(bh.e2);
        gas.uTheta.value = bh.thetaC;
        gas.uRFrom.value = STAR_ORBIT - bh.starR * 1.1;
        gas.uRTo.value = R_OUT * 0.8;
        gas.uColour.value.set(bh.starColour[0], bh.starColour[1], bh.starColour[2]);
        gas.uFade.value = hero.reveal;
        gas.uSeed.value = bh.seed;
        gas.uBandStrength.value.set(Math.max(0.5, bh.xray), Math.max(0.5, bh.uv), Math.max(0.3, bh.ir));
        hero.stream.visible = true;

        const { basis } = bh;
        const deep = hero.stars.material.uniforms;
        deep.uCentre.value.set(basis.centre[0], basis.centre[1], basis.centre[2]);
        deep.uEast.value.set(basis.east[0], basis.east[1], basis.east[2]);
        deep.uUp.value.set(basis.up[0], basis.up[1], basis.up[2]);
        deep.uReveal.value = hero.reveal;
        deep.uDepth.value = bh.body.depth;
        deep.uKeepDeg.value = app.layers.backgroundStars ? 99 : (bh.discDeg * LENS_EDGE) / (2 * R_OUT);
        hero.stars.visible = true;
        hero.stars.geometry.setDrawRange(0, frame.quality === 'low' ? DEEP_STARS >> 1 : DEEP_STARS);
    }

    const effect = engine.addPostEffect({
        isActive: () => heroCount > 0,
        render(renderer, input, output, frame) {
            const autoClear = renderer.autoClear;
            renderer.autoClear = false;
            renderer.setRenderTarget(output);
            lens.copy(renderer, input);
            for (let i = 0; i < heroCount; i++) lens.lens(renderer, input, output, heroes[i], frame);
            renderer.render(frontScene, frame.camera);
            renderer.autoClear = autoClear;
        }
    });

    const unsubscribe = bus.on('timeline', ({ code, t_days }) => {
        const resolved = app.universe.resolve(code);
        const bh = resolved && byCode.get(resolved.body.code);
        if (bh) bh.thetaC = companionAngle(bh, t_days);
    });

    return {
        id: 'black_holes',
        // Which way the companion is drawn from the hole, as an angle on the screen, so a flight can start the same way round
        companionAngle(code) {
            const bh = byCode.get(code);
            if (!bh) return null;
            const c = Math.cos(bh.thetaC);
            const s = Math.sin(bh.thetaC);
            return Math.atan2(bh.e1.y * c + bh.e2.y * s, bh.e1.x * c + bh.e2.x * s);
        },
        update(frame) {
            if (lensReady && lensFade < 1) lensFade = frame.reduceMotion ? 1 : Math.min(1, lensFade + frame.dt / LENS_FADE_S);
            collectHeroes(frame);
            dprUniform.value = frame.dpr;
            if (heroCount > 0) ensureBuilt();
            if (!lens) return;
            if (!lensReady) heroCount = 0;
            for (let i = 0; i < MAX_HEROES; i++) {
                const hero = heroes[i];
                if (i < heroCount) {
                    updateHero(hero, frame);
                } else {
                    hero.companion.visible = false;
                    hero.stream.visible = false;
                    hero.stars.visible = false;
                }
            }
        },
        // Up close the whole disc can be clicked, and the companion star has its own code. Only called on a click
        picks(frame) {
            pickList.length = 0;
            for (let i = 0; i < heroCount; i++) {
                const hero = heroes[i];
                const bh = hero.bh;
                if (hero.reveal < 0.05 || (bh.body.bands[frame.band] || 0) <= 0.01) continue;
                const cssPerM = hero.pxPerM / frame.dpr;
                const { depth } = bh.body;
                // Out to the edge of the bent sky, with the stars that are drawn there
                pickList.push({ code: bh.body.code, az: bh.body.sky.az, alt: bh.body.sky.alt, radiusPx: (app.layers.backgroundStars ? R_OUT : LENS_EDGE) * cssPerM, depth });
                const radPerM = (bh.discDeg * DEG) / (2 * R_OUT);
                const { centre, east, up } = bh.basis;
                const dx = hero.starX * radPerM;
                const dy = hero.starY * radPerM;
                const sky = vec3ToAzAlt(
                    centre[0] + east[0] * dx + up[0] * dy,
                    centre[1] + east[1] * dx + up[1] * dy,
                    centre[2] + east[2] * dx + up[2] * dy
                );
                pickList.push({ code: bh.info.companion.code, az: sky.az, alt: sky.alt, radiusPx: Math.max(6, bh.starR * cssPerM), depth });
            }
            return pickList;
        },
        dispose() {
            lensRun += 1;
            unsubscribe();
            offRestored();
            effect.isActive = () => false;
            if (glows) {
                engine.scene.remove(glows);
                glows.geometry.dispose();
                glows.material.dispose();
            }
            if (jets) {
                engine.scene.remove(jets.sky);
                jets.geometry.dispose();
                jets.sky.material.dispose();
                jets.front.material.dispose();
            }
            if (lens) {
                lens.dispose();
                plane.dispose();
                streamGeo.dispose();
                starGeo.dispose();
                heroes.forEach((hero) => {
                    engine.scene.remove(hero.stars);
                    hero.companion.material.dispose();
                    hero.stream.material.dispose();
                    hero.stars.material.dispose();
                });
            }
        }
    };
}
