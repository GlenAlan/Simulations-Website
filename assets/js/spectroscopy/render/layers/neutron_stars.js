// Neutron stars and pulsars: a tiny hot core with a dipole magnetic field and, for pulsars, two beams swept round by
// the spin, like a lighthouse. The geometry is real: each beam's axis is tilted from the spin axis, and the beam crosses
// our line of sight once a turn, which is what makes the pulse. In radio they are beacons at every zoom.
//
// Flashing is capped for photosensitive viewers. See pulseDisplay below. Nothing flashes at all with Reduce motion.

import * as THREE from 'three';
import { blackBodyRGB } from '../../core/phys.js';
import { parallaxFactor } from '../../core/depth.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { DEG, SKY_RADIUS, bodyRng, skyBasis, instancedQuad, smoothstep } from './exotic_common.js';

const MAX_FLASH_HZ = 2.8;     // Stays below three flashes a second, the accepted limit for photosensitive viewers
const SHIMMER_BELOW_S = 0.25; // Pulses faster than this are drawn as a shimmer: the eye couldn't follow them anyway

// How a pulse period is shown. { rate: turns a second shown on screen, depth: 0..1 how far the light swings }.
// Slow pulsars run at their true rate. Fast ones are slowed to the cap, and the fastest barely vary at all, spinning
// faster on screen the faster they really are, so that the order is still right.
export function pulseDisplay(periodS) {
    if (!periodS) return { rate: 0, depth: 0 };
    const f = 1 / periodS;
    if (periodS < SHIMMER_BELOW_S) {
        const fastness = Math.max(0, Math.min(1, Math.log10(SHIMMER_BELOW_S / periodS) / 2.4));
        return { rate: 1.1 + 1.2 * fastness, depth: 0.16 };
    }
    return { rate: Math.min(f, MAX_FLASH_HZ), depth: 1 - 0.35 * smoothstep(1, MAX_FLASH_HZ, f) };
}

export function createNeutronStarsLayer(engine, app) {
    const bodies = app.universe.bodies.filter((b) => b.kind === 'neutron_star' && b.neutron_star);
    const n = bodies.length;
    const geometry = instancedQuad(n);
    const centres = new Float32Array(n * 3);
    const spins = new Float32Array(n * 3);
    const pulses = new Float32Array(n * 4);
    const infos = new Float32Array(n * 4);
    const thermals = new Float32Array(n * 3);
    const bandA = new Float32Array(n * 4);
    const bandB = new Float32Array(n);
    const depths = new Float32Array(n);

    bodies.forEach((body, i) => {
        depths[i] = body.depth;
        const info = body.neutron_star;
        const rng = bodyRng(body, 'pulsar');
        const v = skyBasis(body.sky.az, body.sky.alt).centre;
        centres.set([v[0] * SKY_RADIUS, v[1] * SKY_RADIUS, v[2] * SKY_RADIUS], i * 3);
        // The beam's tilt from the spin axis, and the spin axis placed so that the beam sweeps across us
        // Very small tilts are drawn a little larger, or the beam would never be seen side-on
        const tilt = Math.max(24, Math.min(80, info.magnetic_tilt_deg ?? rng.range(30, 62))) * DEG;
        const roll = rng.range(0, Math.PI * 2);
        spins.set([Math.sin(tilt) * Math.cos(roll), Math.sin(tilt) * Math.sin(roll), Math.cos(tilt)], i * 3);
        const show = info.pulsar ? pulseDisplay(info.pulse_period_s) : { rate: 0, depth: 0 };
        pulses.set([show.rate, show.depth, tilt, rng.range(0, Math.PI * 2)], i * 4);
        infos.set([rng.range(0.11, 0.17), info.pulsar ? 1 : 0, info.gamma ? 1 : 0, rng.next()], i * 4);
        thermals.set(blackBodyRGB(Math.min(40000, info.teff_K || 30000)), i * 3);
        bandA.set([body.bands.radio, body.bands.ir, body.bands.visible, body.bands.uv], i * 4);
        bandB[i] = body.bands.xray;
    });

    geometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(centres, 3));
    geometry.setAttribute('aSpin', new THREE.InstancedBufferAttribute(spins, 3));
    geometry.setAttribute('aPulse', new THREE.InstancedBufferAttribute(pulses, 4));
    geometry.setAttribute('aInfo', new THREE.InstancedBufferAttribute(infos, 4));
    geometry.setAttribute('aThermal', new THREE.InstancedBufferAttribute(thermals, 3));
    geometry.setAttribute('aBandA', new THREE.InstancedBufferAttribute(bandA, 4));
    geometry.setAttribute('aBandB', new THREE.InstancedBufferAttribute(bandB, 1));
    geometry.setAttribute('aDepth', new THREE.InstancedBufferAttribute(depths, 1));

    const material = skyMaterial({
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            attribute vec3 aCentre;
            attribute vec3 aSpin;
            attribute vec4 aPulse;    // Turns a second shown, swing 0..1, beam tilt from the spin axis, start angle
            attribute vec4 aInfo;     // On-sky half-size (deg), is a pulsar, emits gamma pulses, seed
            attribute vec3 aThermal;
            attribute vec4 aBandA;
            attribute float aBandB;
            attribute float aDepth;
            varying vec2 vP;
            varying vec3 vAxis;
            varying float vPulse;
            varying float vDetail;
            varying float vHalfPx;
            varying vec3 vInfo;
            varying vec3 vThermal;
            varying vec4 vWeights;    // Radio, visible, UV, X-ray
            void main() {
                float turning = aPulse.x * uTime * uTwinkle * 6.2831853 + aPulse.w;
                // With Reduce motion the beams hold still, seen side-on, and the light is steady
                float angle = uTwinkle > 0.5 ? turning : 1.3;
                float tilt = aPulse.z;
                vec3 e1 = (vec3(0.0, 0.0, 1.0) - aSpin * cos(tilt)) / sin(tilt);
                vec3 e2 = cross(aSpin, e1);
                vAxis = aSpin * cos(tilt) + (e1 * cos(angle) + e2 * sin(angle)) * sin(tilt);

                // A pulse is the beam crossing our line of sight
                // The width is scaled to the tilt so that every pulsar spends about the same share of each turn pointing at us
                float crossing = exp(-(1.0 - vAxis.z) / (0.14 * (1.0 - cos(2.0 * tilt))));
                float swing = aPulse.y * uTwinkle;
                float shimmer = 1.0 + 0.05 * uTwinkle * aInfo.y * sin(uTime * (7.1 + aInfo.w * 3.0));
                vPulse = mix(1.0, 0.16 + 1.5 * crossing, swing) * shimmer;

                float angularPx = radians(aInfo.x) * uPxPerRad * depthP(aDepth);
                vDetail = smoothstep(26.0, 90.0, angularPx);

                vWeights = vec4(
                    uBandW[0] * aBandA.x,
                    uBandW[2] * vDetail,                     // Only once you're close: almost nothing reaches us in visible light
                    uBandW[3] * max(aBandA.w, 0.1 * step(0.001, aBandA.w)),
                    uBandW[4] * aBandB
                );
                float shows = dot(vWeights, vec4(1.0));
                vInfo = aInfo.yzw;
                vThermal = aThermal;
                vP = position.xy;

                // Beacons keep a minimum size in the bands where they are the thing to find
                float beacon = (uBandW[0] * aBandA.x + uBandW[4] * aBandB) * uViewport.y * 0.022;
                vHalfPx = max(angularPx, beacon);
                float gate = shows > 0.002 ? 1.0 : 0.0;
                vec4 c = modelViewMatrix * vec4(aCentre, 1.0);
                c.xy *= depthP(aDepth);
                c.xy += position.xy * vHalfPx * gate * length(c.xyz) / uPxPerRad;
                gl_Position = projectionMatrix * c;
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            varying vec2 vP;
            varying vec3 vAxis;
            varying float vPulse;
            varying float vDetail;
            varying float vHalfPx;
            varying vec3 vInfo;
            varying vec3 vThermal;
            varying vec4 vWeights;

            // A cone of light seen from the side. The closer it points at us, the shorter and wider it looks
            float beam(vec2 p, vec3 a) {
                float s = length(a.xy);
                if (s < 0.03) return 0.0;
                vec2 ax = a.xy / s;
                float u = dot(p, ax);
                if (u <= 0.0) return 0.0;
                float v = dot(p, vec2(-ax.y, ax.x));
                float len = 0.08 + 0.85 * s;
                float w = u * 0.13 / max(s, 0.2) + 0.006;
                float across = v / w;
                float fade = u / len;
                return exp(-across * across * 1.3) * exp(-fade * fade * 2.6) * (0.45 + 0.75 * a.z + 0.3);
            }

            // Shells of a dipole field: a field line obeys r = L sin^2(theta), theta measured from the magnetic axis
            float dipole(vec2 p, float r, vec3 m) {
                float c = dot(vec3(p, 0.0), m) / max(r, 0.0001);
                float L = r / max(1.0 - c * c, 0.02);
                float a = (L - 0.11) / 0.011;
                float b = (L - 0.2) / 0.016;
                float d = (L - 0.33) / 0.024;
                return (exp(-a * a) + 0.65 * exp(-b * b) + 0.4 * exp(-d * d)) * exp(-r * 4.2);
            }

            void main() {
                float r = length(vP);
                float px = 1.0 / vHalfPx;
                float coreSize = max(0.012, 1.5 * px);
                float core = exp(-r * r / (coreSize * coreSize));
                float tight = mix(6.0, 90.0, vDetail);
                float glow = exp(-r * r * tight);
                float edge = smoothstep(1.0, 0.75, r);

                float beams = 0.0;
                float field = 0.0;
                if (vDetail > 0.001) {
                    if (vInfo.x > 0.5) beams = (beam(vP, vAxis) + 0.8 * beam(vP, -vAxis)) * vDetail;
                    field = dipole(vP, r, vAxis) * vDetail;
                }

                float gamma = vInfo.y;
                float pulsar = vInfo.x;
                vec3 radio = uBandTint[0] * vWeights.x * (core * 1.6 * vPulse + glow * 1.1 * vPulse + beams * 1.5 + field * 0.5);
                vec3 white = mix(vThermal, vec3(1.0), 0.45);
                vec3 visible = vWeights.y * (white * core * 4.0 + white * glow * 0.8 * (0.5 + 0.5 * vPulse)
                    + vec3(0.62, 0.8, 1.0) * beams * 0.9 + vec3(0.45, 0.55, 1.0) * field * 0.9);
                vec3 uv = uBandTint[3] * vWeights.z * (core * 2.0 + glow * 0.5 + field * 0.5);
                float xPulse = gamma > 0.5 ? vPulse : 1.0;
                vec3 xray = uBandTint[4] * vWeights.w * (core * 2.4 + glow * 0.8 * xPulse + beams * gamma * 1.4 + field * 0.4);

                gl_FragColor = vec4((radio + visible + uv + xray) * edge * uSkyFade, 1.0);
            }`
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.exotic;
    engine.scene.add(mesh);

    return {
        id: 'neutron_stars',
        update() {},
        // What this layer draws can be clicked, even where the star's magnitude wouldn't have it show yet. Same rules as the
        // shader above. Only called on a click or a hover
        picks(frame) {
            const out = [];
            const strengthKey = frame.band;
            bodies.forEach((body, i) => {
                const { depth } = body;
                const strength = body.bands[strengthKey] || 0;
                if (strength <= 0.001) return;
                const p = parallaxFactor(depth, frame.fov);
                const angularPx = infos[i * 4] * DEG * frame.pxPerRad * p;
                if (strengthKey === 'visible' && angularPx < 26) return;
                out.push({ code: body.code, az: body.sky.az, alt: body.sky.alt, radiusPx: 0, depth });
            });
            return out;
        },
        dispose() {
            engine.scene.remove(mesh);
            geometry.dispose();
            material.dispose();
        }
    };
}
