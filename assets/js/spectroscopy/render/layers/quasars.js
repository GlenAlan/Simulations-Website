// What a quasar has beyond its point of light, which the stars layer draws: a glow round the core in the bands where
// it is bright, a faint host galaxy that only shows at the highest zoom, and, for the radio-loud one, jets and lobes.

import * as THREE from 'three';
import { Rng } from '../../core/rng.js';
import { limitingMag } from '../../core/sky.js';
import { drawMag, parallaxFactor, travelPc } from '../../core/depth.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { SKY_RADIUS, tangentBasis, quadAxes, scatterPicks, revealGain, REVEAL_GLSL } from './sky_tangent.js';
import { createRadioLobes } from './radio_lobes.js';

const RAD = Math.PI / 180;
const HOST_DEG = 0.14;       // A host galaxy's width on the sky: stylised, like every size here

export function createQuasarsLayer(engine, app) {
    const quasars = app.universe.bodies.filter((b) => b.kind === 'quasar').map((body) => {
        const rng = new Rng(`quasar:${body.visual_seed}`);
        const basis = tangentBasis(body.sky.az, body.sky.alt);
        return {
            body,
            basis,
            positionAngle: rng.range(0, 180),
            flatten: rng.range(0.62, 0.95),
            span: rng.range(1.6, 2.8)
        };
    });
    const n = quasars.length;

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const centres = new Float32Array(n * 3);
    const us = new Float32Array(n * 3);
    const vs = new Float32Array(n * 3);
    const bandA = new Float32Array(n * 4);
    const bandB = new Float32Array(n);
    const extra = new Float32Array(n * 2);
    const depths = new Float32Array(n);
    const pcs = new Float32Array(n);
    quasars.forEach((q, i) => {
        depths[i] = q.body.depth;
        pcs[i] = travelPc(q.body);
        const axes = quadAxes(q.basis, q.positionAngle, 1);
        centres.set(q.basis.centre.map((c) => c * SKY_RADIUS), i * 3);
        us.set(axes.u, i * 3);
        vs.set(axes.v, i * 3);
        const { bands } = q.body;
        bandA.set([bands.radio, bands.ir, bands.visible, bands.uv], i * 4);
        bandB[i] = bands.xray;
        extra.set([drawMag(q.body), q.flatten], i * 2);
    });
    geometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(centres, 3));
    geometry.setAttribute('aU', new THREE.InstancedBufferAttribute(us, 3));
    geometry.setAttribute('aV', new THREE.InstancedBufferAttribute(vs, 3));
    geometry.setAttribute('aBandA', new THREE.InstancedBufferAttribute(bandA, 4));
    geometry.setAttribute('aBandB', new THREE.InstancedBufferAttribute(bandB, 1));
    geometry.setAttribute('aExtra', new THREE.InstancedBufferAttribute(extra, 2));
    geometry.setAttribute('aDepth', new THREE.InstancedBufferAttribute(depths, 1));
    geometry.setAttribute('aPc', new THREE.InstancedBufferAttribute(pcs, 1));
    geometry.instanceCount = n;

    const material = skyMaterial({
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            ${REVEAL_GLSL}
            attribute vec3 aCentre;
            attribute vec3 aU;
            attribute vec3 aV;
            attribute vec4 aBandA;
            attribute float aBandB;
            attribute vec2 aExtra;
            attribute float aDepth;
            attribute float aPc;
            varying vec2 vDeg;       // Position in degrees from the core, along the host's axes
            varying vec2 vPx;        // The same in device pixels
            varying vec4 vBand;
            varying float vXray;
            varying float vFlat;
            varying float vHost;
            void main() {
                vec3 centre = aCentre;
                float near = travel(centre, aPc);
                float pxPerDeg = uPxPerRad * 0.0174533;
                // Big enough for whichever is larger on screen: the host's width, or a fixed glow in pixels
                float halfDeg = max(${(HOST_DEG * 1.1).toFixed(3)}, 46.0 / pxPerDeg);
                vDeg = position.xy * halfDeg;
                vPx = vDeg * pxPerDeg;
                vBand = vec4(aBandA.xy, aBandA.z * revealGain(aExtra.x), aBandA.w) * travelLight(near);
                vXray = aBandB * travelLight(near);
                vFlat = aExtra.y;
                // The host appears only when zoomed right in
                vHost = smoothstep(120.0, 420.0, pxPerDeg);
                float h = tan(radians(halfDeg)) * ${SKY_RADIUS.toFixed(1)};
                gl_Position = projectionMatrix * modelViewMatrix * vec4(centre + (position.x * aU + position.y * aV) * h, 1.0);
                gl_Position.xy *= depthP(aDepth);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            varying vec2 vDeg;
            varying vec2 vPx;
            varying vec4 vBand;
            varying float vXray;
            varying float vFlat;
            varying float vHost;
            void main() {
                // A glow fixed in pixels round the core, so it reads the same at any zoom
                // Tighter outside visible light, where a quasar is nothing but a point
                float px = length(vPx) * (1.0 + 1.3 * (uBandW[1] + uBandW[3] + uBandW[4]));
                float glow = 1.0 / (1.0 + pow(px / 5.5, 2.4));
                glow *= 1.0 - smoothstep(26.0, 44.0, px);
                // The host galaxy: faint, smooth and redder than the core
                vec2 e = vec2(vDeg.x, vDeg.y / vFlat);
                float r = length(e) / ${(HOST_DEG / 2).toFixed(3)};
                float host = exp(-3.2 * pow(r, 0.7)) * (1.0 - smoothstep(0.9, 1.9, r)) * vHost;
                vec3 colour = vec3(1.0, 0.72, 0.48) * host * vBand.z * uBandW[2] * 0.65
                    + vec3(0.72, 0.8, 1.0) * glow * vBand.z * uBandW[2] * 0.12
                    + uBandTint[1] * uBandW[1] * vBand.y * (glow * 0.5 + host * 0.5)
                    + uBandTint[3] * uBandW[3] * vBand.w * glow * 0.9
                    + uBandTint[4] * uBandW[4] * vXray * glow * 0.9;
                gl_FragColor = vec4(colour * uSkyFade, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.exotic;
    mesh.visible = n > 0;
    engine.scene.add(mesh);

    const loud = quasars.filter((q) => q.body.quasar.radio_loud);
    const lobes = createRadioLobes(engine, loud.map((q) => ({
        az: q.body.sky.az,
        alt: q.body.sky.alt,
        positionAngleDeg: q.positionAngle + 90,
        spanDeg: q.span,
        strength: Math.max(0.5, q.body.bands.radio) * 1.2,
        seed: q.body.visual_seed,
        depth: q.body.depth,
        pc: travelPc(q.body)
    })));

    return {
        id: 'quasars',
        update() {},
        picks(frame) {
            const out = [];
            const lim = limitingMag(frame.fov);
            if (app.band === 'radio') {
                // A click on a lobe finds its quasar
                loud.forEach((q) => {
                    const stepDeg = 30 / ((frame.pxPerRad * RAD * parallaxFactor(q.body.depth, frame.fov)) / frame.dpr);
                    scatterPicks(out, q.body.code, q.basis, q.positionAngle + 90, q.span / 2, q.span * 0.1, stepDeg, q.body.depth);
                });
            } else if (app.band === 'visible') {
                quasars.forEach((q) => {
                    if (revealGain(drawMag(q.body), lim) >= 0.03) out.push({ code: q.body.code, az: q.body.sky.az, alt: q.body.sky.alt, radiusPx: 0, depth: q.body.depth });
                });
            }
            return out;
        },
        dispose() {
            engine.scene.remove(mesh);
            geometry.dispose();
            material.dispose();
            lobes.dispose();
        }
    };
}
