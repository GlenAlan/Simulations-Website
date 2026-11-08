// Neutron stars and pulsars: a tiny hot core with a dipole magnetic field and, for pulsars, two beams swept round by
// the spin, like a lighthouse. The geometry is real: each beam's axis is tilted from the spin axis, and the beam crosses
// our line of sight once a turn, which is what makes the pulse. In radio they are beacons at every zoom.
//
// How fast each turns is the rule the system view's beams share: see shownRate in exotic_common.js. Here a pulsar is a
// small point, which may flash as fast as it is shown turning. Zoomed in until its beams are big, a fast one's beams blur
// into their sweep as up close (skyTurningShare). Nothing flashes at all with Reduce motion.

import * as THREE from 'three';
import { blackBodyRGB } from '../../core/phys.js';
import { parallaxFactor, travelPc } from '../../core/depth.js';
import { skyMaterial, BAND_GLSL, LOOP_ZERO_GLSL, ORDER } from '../shared.js';
import { DEG, SKY_RADIUS, bodyRng, skyBasis, instancedQuad, pulsarSpin, skyTurningShare, HELD_ANGLE, PULSAR_BEAM_SLOPE,
    SWEEP_SAMPLES, SKY_SWEEP_PX } from './exotic_common.js';

const BEAMS_SHOW_PX = 64;   // Half-size, in device pixels, at which the beams are well on show (vDetail about 0.6)

export function createNeutronStarsLayer(engine, app) {
    const bodies = app.universe.bodies.filter((b) => b.kind === 'neutron_star' && b.neutron_star);
    const n = bodies.length;
    const geometry = instancedQuad(n);
    const centres = new Float32Array(n * 3);
    const spins = new Float32Array(n * 3);
    const pulses = new Float32Array(n * 4);
    const turns = new Float32Array(n);
    const infos = new Float32Array(n * 4);
    const thermals = new Float32Array(n * 3);
    const bandA = new Float32Array(n * 4);
    const bandB = new Float32Array(n);
    const depths = new Float32Array(n);
    const pcs = new Float32Array(n);

    bodies.forEach((body, i) => {
        depths[i] = body.depth;
        pcs[i] = travelPc(body);
        const info = body.neutron_star;
        const rng = bodyRng(body, 'pulsar');
        const v = skyBasis(body.sky.az, body.sky.alt).centre;
        centres.set([v[0] * SKY_RADIUS, v[1] * SKY_RADIUS, v[2] * SKY_RADIUS], i * 3);
        // The beam's tilt from the spin axis, and the spin axis placed so that the beam sweeps across us, as the system
        // view has them too
        const spin = pulsarSpin(body, rng);
        spins.set(spin.axis, i * 3);
        pulses.set([spin.rate, spin.depth, spin.tilt, spin.phase], i * 4);
        turns[i] = skyTurningShare(spin.rate);
        infos.set([rng.range(0.11, 0.17), info.pulsar ? 1 : 0, info.gamma ? 1 : 0, rng.next()], i * 4);
        thermals.set(blackBodyRGB(Math.min(40000, info.teff_K || 30000)), i * 3);
        bandA.set([body.bands.radio, body.bands.ir, body.bands.visible, body.bands.uv], i * 4);
        bandB[i] = body.bands.xray;
    });

    geometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(centres, 3));
    geometry.setAttribute('aSpin', new THREE.InstancedBufferAttribute(spins, 3));
    geometry.setAttribute('aPulse', new THREE.InstancedBufferAttribute(pulses, 4));
    geometry.setAttribute('aTurn', new THREE.InstancedBufferAttribute(turns, 1));
    geometry.setAttribute('aInfo', new THREE.InstancedBufferAttribute(infos, 4));
    geometry.setAttribute('aThermal', new THREE.InstancedBufferAttribute(thermals, 3));
    geometry.setAttribute('aBandA', new THREE.InstancedBufferAttribute(bandA, 4));
    geometry.setAttribute('aBandB', new THREE.InstancedBufferAttribute(bandB, 1));
    geometry.setAttribute('aDepth', new THREE.InstancedBufferAttribute(depths, 1));
    geometry.setAttribute('aPc', new THREE.InstancedBufferAttribute(pcs, 1));

    const material = skyMaterial({
        uniforms: { uSweepPx: { value: new THREE.Vector2(SKY_SWEEP_PX[0], SKY_SWEEP_PX[1]) } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            attribute vec3 aCentre;
            attribute vec3 aSpin;
            attribute vec4 aPulse;    // Turns a second shown, swing 0..1, beam tilt from the spin axis, start angle
            attribute float aTurn;    // The share of the beams' light that turns once they're big (skyTurningShare)
            attribute vec4 aInfo;     // On-sky half-size (deg), is a pulsar, emits gamma pulses, seed
            attribute vec3 aThermal;
            attribute vec4 aBandA;
            attribute float aBandB;
            attribute float aDepth;
            attribute float aPc;
            uniform vec2 uSweepPx;    // SKY_SWEEP_PX, in device pixels
            varying vec2 vP;
            varying vec3 vAxis;
            varying vec3 vSpin;
            varying vec2 vTurn;       // Beam tilt, and the share of the beams' light turning; the rest is their sweep
            varying float vPulse;
            varying float vDetail;
            varying float vHalfPx;
            varying vec3 vInfo;
            varying vec3 vThermal;
            varying vec4 vWeights;    // Radio, visible, UV, X-ray
            void main() {
                float turning = aPulse.x * uTime * uTwinkle * 6.2831853 + aPulse.w;
                // With Reduce motion the beams hold still, seen side-on, and the light is steady (pulsarAngle)
                float angle = uTwinkle > 0.5 ? turning : ${HELD_ANGLE.toFixed(2)};
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

                vec3 centre = aCentre;
                float near = travel(centre, aPc);
                float angularPx = radians(aInfo.x) * uPxPerRad * depthP(aDepth) * travelSize(near);
                vDetail = smoothstep(26.0, 90.0, angularPx);

                vWeights = vec4(
                    uBandW[0] * aBandA.x,
                    uBandW[2] * vDetail,                     // Only once you're close: almost nothing reaches us in visible light
                    uBandW[3] * max(aBandA.w, 0.1 * step(0.001, aBandA.w)),
                    uBandW[4] * aBandB
                ) * travelLight(near);
                float shows = dot(vWeights, vec4(1.0));
                vInfo = aInfo.yzw;
                vThermal = aThermal;
                vP = position.xy;

                // Beacons keep a minimum size in the bands where they are the thing to find
                float beacon = (uBandW[0] * aBandA.x + uBandW[4] * aBandB) * uViewport.y * 0.022;
                vHalfPx = max(angularPx, beacon);
                // Big on the screen, a fast pulsar's beams are drawn as up close: part turning, the rest their blurred sweep
                vSpin = aSpin;
                vTurn = vec2(tilt, uTwinkle > 0.5 ? mix(1.0, aTurn, smoothstep(uSweepPx.x, uSweepPx.y, vHalfPx)) : 1.0);
                float gate = shows > 0.002 ? 1.0 : 0.0;
                vec4 c = modelViewMatrix * vec4(centre, 1.0);
                c.xy *= depthP(aDepth);
                c.xy += position.xy * vHalfPx * gate * length(c.xyz) / uPxPerRad;
                gl_Position = projectionMatrix * c;
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            ${LOOP_ZERO_GLSL}
            varying vec2 vP;
            varying vec3 vAxis;
            varying vec3 vSpin;
            varying vec2 vTurn;
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
                float w = u * ${PULSAR_BEAM_SLOPE.toFixed(2)} / max(s, 0.2) + 0.006;
                float across = v / w;
                float fade = u / len;
                return exp(-across * across * 1.3) * exp(-fade * fade * 2.6) * (0.45 + 0.75 * a.z + 0.3);
            }

            // Both beams, averaged over SWEEP_SAMPLES turns of them round the spin axis: the blur of their sweep, as the eye
            // sees a fast lighthouse. A different start for each pixel, as up close (system/remnants.js), holds still.
            float swept(vec2 p) {
                float tilt = vTurn.x;
                vec3 e1 = (vec3(0.0, 0.0, 1.0) - vSpin * cos(tilt)) / sin(tilt);
                vec3 e2 = cross(vSpin, e1);
                float start = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
                float sum = 0.0;
                for (int k = 0; k < ${SWEEP_SAMPLES} + uLoopZero; k++) {
                    float a = (float(k) + start) * ${(2 * Math.PI / SWEEP_SAMPLES).toFixed(6)};
                    vec3 axis = vSpin * cos(tilt) + (e1 * cos(a) + e2 * sin(a)) * sin(tilt);
                    sum += beam(p, axis) + 0.8 * beam(p, -axis);
                }
                return sum * ${(1 / SWEEP_SAMPLES).toFixed(6)};
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
                    if (vInfo.x > 0.5) {
                        beams = beam(vP, vAxis) + 0.8 * beam(vP, -vAxis);
                        if (vTurn.y < 0.999) beams = mix(swept(vP), beams, vTurn.y);
                        beams *= vDetail;
                    }
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
        // The sizes are in CSS pixels, so that a pulsar flashes over the same share of a viewer's sight on any screen
        update(frame) {
            material.uniforms.uSweepPx.value.set(SKY_SWEEP_PX[0] * frame.dpr, SKY_SWEEP_PX[1] * frame.dpr);
        },
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
        // The field of view at which a pulsar is drawn big enough for its beams to be seen turning (vDetail above), so that a
        // zoom shows them on the sky before the system view takes over (render/system/zoom_into.js): the same turn, followed
        // from one view into the other. 0 for a neutron star with no beams.
        beamsFov(code, frame) {
            const i = bodies.findIndex((b) => b.code === code);
            if (i < 0 || !bodies[i].neutron_star.pulsar) return 0;
            const reach = infos[i * 4] * DEG * frame.pxPerRad * Math.tan((frame.fov * DEG) / 2);
            let fov = frame.fov;
            for (let k = 0; k < 4; k++) fov = (2 * Math.atan((reach * parallaxFactor(bodies[i].depth, fov)) / BEAMS_SHOW_PX)) / DEG;
            return fov;
        },
        dispose() {
            engine.scene.remove(mesh);
            geometry.dispose();
            material.dispose();
        }
    };
}
