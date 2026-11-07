// Twin jets and radio lobes, for radio galaxies and radio-loud quasars. Seen in the radio band only, so the quads
// collapse to nothing in every other band and cost nothing there. The look of one source is fixed by its seed.

import * as THREE from 'three';
import { Rng } from '../../core/rng.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { SKY_RADIUS, tangentBasis, quadAxes, worldHalfSize } from './sky_tangent.js';

// sources: [{ az, alt, positionAngleDeg, spanDeg, strength, seed, depth, pc }]; spanDeg is the whole length, tip to tip,
// and pc the source's distance (core/depth.js travelPc)
export function createRadioLobes(engine, sources) {
    const n = sources.length;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const centres = new Float32Array(n * 3);
    const us = new Float32Array(n * 3);
    const vs = new Float32Array(n * 3);
    const params = new Float32Array(n * 4);
    const shape = new Float32Array(n * 4);
    const depths = new Float32Array(n);
    const pcs = new Float32Array(n);
    sources.forEach((src, i) => {
        depths[i] = src.depth;
        pcs[i] = src.pc;
        const rng = new Rng(`lobes:${src.seed}`);
        const basis = tangentBasis(src.az, src.alt);
        // The quad is square; the jet axis runs along u
        const { u, v } = quadAxes(basis, src.positionAngleDeg, worldHalfSize(src.spanDeg * 1.08));
        centres.set(basis.centre.map((c) => c * SKY_RADIUS), i * 3);
        us.set(u, i * 3);
        vs.set(v, i * 3);
        params.set([src.strength, rng.range(0, 60), rng.range(0, 60), rng.range(-0.5, 0.5)], i * 4);
        // Tip distance on each side, how far the jet bends, and how fat the lobes are
        shape.set([rng.range(0.72, 0.92), rng.range(0.66, 0.92), rng.range(-0.1, 0.1), rng.range(0.13, 0.22)], i * 4);
    });
    geometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(centres, 3));
    geometry.setAttribute('aU', new THREE.InstancedBufferAttribute(us, 3));
    geometry.setAttribute('aV', new THREE.InstancedBufferAttribute(vs, 3));
    geometry.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
    geometry.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 4));
    geometry.setAttribute('aDepth', new THREE.InstancedBufferAttribute(depths, 1));
    geometry.setAttribute('aPc', new THREE.InstancedBufferAttribute(pcs, 1));
    geometry.instanceCount = n;

    const material = skyMaterial({
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            attribute vec3 aCentre;
            attribute vec3 aU;
            attribute vec3 aV;
            attribute vec4 aParams;
            attribute vec4 aShape;
            attribute float aDepth;
            attribute float aPc;
            varying vec2 vP;
            varying vec4 vParams;
            varying vec4 vShape;
            varying float vResolved;    // 0 while it's too small on screen to be drawn as anything but two soft dots
            void main() {
                vP = position.xy;
                vec3 centre = aCentre;
                float near = travel(centre, aPc);
                float grow = travelSize(near);
                vResolved = smoothstep(10.0, 30.0, length(aU) / ${SKY_RADIUS.toFixed(1)} * uPxPerRad * depthP(aDepth) * grow);
                vParams = vec4(aParams.x * travelThrough(near) * min(near * near, 1.0), aParams.yzw);
                vShape = aShape;
                vec3 world = centre + position.x * aU * grow + position.y * aV * grow;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
                gl_Position.xy *= depthP(aDepth);
                if (uBandW[0] < 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            varying vec2 vP;
            varying vec4 vParams;
            varying vec4 vShape;
            varying float vResolved;
            float fall(float a, float b, float x) {
                return 1.0 - smoothstep(b, a, x);
            }
            float h21(vec2 p) {
                vec3 q = fract(vec3(p.xyx) * 0.1031);
                q += dot(q, q.yzx + 33.33);
                return fract((q.x + q.y) * q.z);
            }
            float vn(vec2 p) {
                vec2 i = floor(p);
                vec2 f = fract(p);
                f = f * f * (3.0 - 2.0 * f);
                return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
            }
            float fbm(vec2 p) {
                float a = 0.5, s = 0.0;
                for (int i = 0; i < 5; i++) {
                    s += a * vn(p);
                    a *= 0.5;
                    p = mat2(0.8, 0.6, -0.6, 0.8) * p * 2.05 + 7.1;
                }
                return s;
            }
            // One lobe: a bubble swept back from a bright hot spot at its tip, with a brighter skin and stringy insides
            float lobe(vec2 p, float tip, float fat, vec2 off) {
                vec2 w = vec2(fbm(p * 4.0 + off), fbm(p * 4.0 + off.yx + 9.0)) - 0.47;
                vec2 q = p + w * 0.16;
                float dx = (q.x - (tip - fat * 1.6)) / (fat * 1.7);
                float dy = q.y / (fat * (1.0 - 0.35 * smoothstep(-0.6, 1.0, dx)));
                float d = sqrt(dx * dx + dy * dy);
                float body = fall(1.06, 0.2, d);
                float shell = smoothstep(0.4, 0.82, d) * fall(1.14, 0.8, d);
                float n = fbm(q * 7.0 + off * 1.7);
                float ridge = 1.0 - abs(2.0 * fbm(q * 15.0 + w * 3.0 + off * 2.3) - 1.0);
                ridge = ridge * ridge * ridge;
                float light = body * (0.03 + 0.2 * n * n + 0.26 * ridge) + shell * (0.05 + 0.24 * n);
                // The hot spot where the jet slams into the gas around the galaxy
                vec2 h = (p - vec2(tip - fat * 0.16, 0.0)) / (fat * 0.11);
                light += 3.2 * exp(-dot(h, h));
                vec2 h2 = (p - vec2(tip - fat * 0.2, 0.0)) / (fat * 0.42);
                light += 0.42 * exp(-dot(h2, h2));
                return light;
            }
            void main() {
                float bend = vShape.z;
                vec2 p = vec2(vP.x, vP.y - bend * vP.x * vP.x * sign(vP.x));
                float x = abs(p.x);
                float side = p.x > 0.0 ? 1.0 : -1.0;
                float tip = side > 0.0 ? vShape.x : vShape.y;
                float fat = vShape.w;
                vec2 off = vec2(vParams.y, vParams.z) + side * 3.1;
                vec2 l = vec2(x, p.y);
                // Too few pixels for a jet and hot spots: they'd only be broken sticks. So two soft dots, and no more
                vec2 dot1 = (l - vec2(tip - fat * 0.8, 0.0)) / max(fat * 1.3, 0.2);
                float dots = 1.1 * exp(-dot(dot1, dot1));
                if (vResolved <= 0.0) {
                    gl_FragColor = vec4(uBandTint[0] * uBandW[0] * dots * vParams.x * fall(1.0, 0.86, length(vP)) * uSkyFade, 1.0);
                    return;
                }
                float light = lobe(l, tip, fat, off);
                // The jet: narrow, knotted, and brighter on the side coming towards us
                float width = 0.0022 + 0.0075 * x;
                float wiggle = (vn(vec2(x * 9.0, off.x)) - 0.5) * 0.02 * smoothstep(0.0, 0.3, x);
                float along = fall(tip - fat * 0.1, tip - fat * 1.1, x);
                float knots = 0.5 + 0.9 * pow(vn(vec2(x * 26.0, off.y)), 2.0);
                float beam = side > 0.0 ? 1.0 + vParams.w : 1.0 - vParams.w;
                light += beam * along * knots * 1.3 * exp(-pow((p.y - wiggle) / width, 2.0));
                light += beam * along * 0.1 * exp(-pow((p.y - wiggle) / (width * 3.5), 2.0));
                // The bright core the jets come from
                vec2 c = vP / 0.009;
                light += 3.5 * exp(-dot(c, c));
                light = mix(dots, light, vResolved);
                float edge = fall(1.0, 0.86, length(vP));
                vec3 colour = uBandTint[0] * uBandW[0] * light * edge * vParams.x;
                gl_FragColor = vec4(colour * uSkyFade, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.galaxies + 1;
    mesh.visible = n > 0;
    engine.scene.add(mesh);
    return {
        mesh,
        dispose() {
            engine.scene.remove(mesh);
            geometry.dispose();
            material.dispose();
        }
    };
}
