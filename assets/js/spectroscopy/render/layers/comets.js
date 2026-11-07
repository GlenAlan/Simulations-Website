// Comets: a glowing coma, a curved yellow-white dust tail and a straight blue ion tail, all lying on the sky and all
// pointing away from the same Sun, which is below the horizon. Two parts: a shader on one quad per comet gives the
// smooth glow, and a few hundred drifting particles give it grain and the shimmer.
//
// What each band shows is what comets really do: infrared sees the warm dust, ultraviolet the vast hydrogen cloud
// glowing in Lyman alpha, radio a faint OH point, and X-rays a faint crescent where the solar wind hits the coma.

import * as THREE from 'three';
import { azAltToVec3, vec3ToAzAlt, limitingMag } from '../../core/sky.js';
import { drawMag, parallaxFactor } from '../../core/depth.js';
import { bandMagnitudes } from '../../data/band_table.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { DEG, SKY_RADIUS, bodyRng, instancedQuad, exoticNoise } from './exotic_common.js';

const SUN_ALT = -70;       // How far below the horizon the unseen Sun is: tails point up and away from it
const PARTICLES_EACH = 420;

// Rough colour of a spectral line, for mixing the coma's gas glow from its emission lines
function lineColour(nm) {
    if (nm < 440) return [0.35, 0.3, 1.0];   // CN, violet
    if (nm < 490) return [0.2, 0.6, 1.0];
    if (nm < 530) return [0.25, 1.0, 0.55];  // C2, the green of real comet comas
    if (nm < 575) return [0.6, 1.0, 0.25];
    if (nm < 620) return [1.0, 0.75, 0.2];   // Na
    return [1.0, 0.3, 0.2];
}

function gasColour(lines) {
    const sum = [0, 0, 0];
    (lines || []).forEach((line) => {
        const c = lineColour(line.w);
        // The eye barely sees the violet CN band, which is why real comas look green from C2
        const seen = line.rel * (line.w < 440 ? 0.15 : 1);
        sum[0] += c[0] * seen;
        sum[1] += c[1] * seen;
        sum[2] += c[2] * seen;
    });
    const top = Math.max(sum[0], sum[1], sum[2], 0.001);
    // Reflected sunlight whitens the gas glow a little
    return sum.every((v) => v === 0) ? [0.5, 1, 0.7] : sum.map((v) => 0.14 + 0.86 * (v / top));
}

// The tail's direction on the sky at a comet: the part of "directly away from the Sun" that lies along the sky
function tailBasis(body, sunDir) {
    const c = azAltToVec3(body.sky.az, body.sky.alt);
    const dot = c[0] * sunDir[0] + c[1] * sunDir[1] + c[2] * sunDir[2];
    let t = [c[0] * dot - sunDir[0], c[1] * dot - sunDir[1], c[2] * dot - sunDir[2]];
    let len = Math.hypot(t[0], t[1], t[2]);
    if (len < 0.01) { // Straight opposite the Sun: any way up will do
        t = [0, 1, 0];
        len = 1;
    }
    t = [t[0] / len, t[1] / len, t[2] / len];
    const n = [c[1] * t[2] - c[2] * t[1], c[2] * t[0] - c[0] * t[2], c[0] * t[1] - c[1] * t[0]];
    return { c, t, n };
}

const COMET_COMMON = /* glsl */`
    uniform float uDpr;
    float cometShows(float mag) {
        // Fainter comets come into view as you zoom in, like everything else in visible light. A faint one stays quieter
        // than a bright one for a while after it arrives, so that it has to be looked for
        float over = uLimitMag - mag;
        return smoothstep(-0.6, 0.6, over) * clamp(pow(10.0, -0.4 * (mag - 4.0)), 0.5, 1.4) * mix(0.45, 1.0, smoothstep(0.3, 2.6, over));
    }
    // How long the tail is on screen, in CSS pixels
    float tailOnScreen(float tailDeg, float depth) {
        return radians(tailDeg) * uPxPerRad * depthP(depth) / uDpr;
    }
    // In the other bands, as for a sprite in stars.js: from a little over 3 magnitudes below the zoom's limit, which is
    // when engine.bodyShows says it can be clicked
    float bandShows(float mag) {
        return smoothstep(-3.25, -2.25, uLimitMag - mag);
    }
`;

function createGlow(engine, comets) {
    const n = comets.length;
    const geometry = instancedQuad(n);
    const a = {
        centre: new Float32Array(n * 3), tail: new Float32Array(n * 3), normal: new Float32Array(n * 3),
        shape: new Float32Array(n * 4), extra: new Float32Array(n * 4), gas: new Float32Array(n * 3),
        bandA: new Float32Array(n * 4), bandB: new Float32Array(n), depth: new Float32Array(n), mags: new Float32Array(n * 4)
    };
    comets.forEach((comet, i) => {
        const { body, basis } = comet;
        a.centre.set(basis.c.map((v) => v * SKY_RADIUS), i * 3);
        a.tail.set(basis.t, i * 3);
        a.normal.set(basis.n, i * 3);
        a.shape.set([body.comet.coma_deg, body.comet.tail_deg, body.comet.dust_ratio, comet.seed], i * 4);
        a.extra.set([comet.curve, drawMag(body), 0, 0], i * 4);
        a.depth[i] = body.depth;
        a.mags.set(comet.mags, i * 4);
        a.gas.set(comet.gas, i * 3);
        a.bandA.set([body.bands.radio, body.bands.ir, body.bands.visible, body.bands.uv], i * 4);
        a.bandB[i] = body.bands.xray;
    });
    geometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(a.centre, 3));
    geometry.setAttribute('aTail', new THREE.InstancedBufferAttribute(a.tail, 3));
    geometry.setAttribute('aNormal', new THREE.InstancedBufferAttribute(a.normal, 3));
    geometry.setAttribute('aShape', new THREE.InstancedBufferAttribute(a.shape, 4));
    geometry.setAttribute('aExtra', new THREE.InstancedBufferAttribute(a.extra, 4));
    geometry.setAttribute('aGas', new THREE.InstancedBufferAttribute(a.gas, 3));
    geometry.setAttribute('aBandA', new THREE.InstancedBufferAttribute(a.bandA, 4));
    geometry.setAttribute('aBandB', new THREE.InstancedBufferAttribute(a.bandB, 1));
    geometry.setAttribute('aDepth', new THREE.InstancedBufferAttribute(a.depth, 1));
    geometry.setAttribute('aMags', new THREE.InstancedBufferAttribute(a.mags, 4));

    const material = skyMaterial({
        side: THREE.DoubleSide,  // The quad lies on the sky; which way round it faces depends on the tail
        uniforms: { tNoise: { value: exoticNoise() }, uDpr: { value: 1 } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            ${COMET_COMMON}
            attribute vec3 aCentre;
            attribute vec3 aTail;
            attribute vec3 aNormal;
            attribute vec4 aShape;    // Coma (deg), tail (deg), dust ratio, seed
            attribute vec4 aExtra;    // Curve of the dust tail, apparent magnitude
            attribute vec3 aGas;
            attribute vec4 aBandA;
            attribute float aBandB;
            attribute float aDepth;
            attribute vec4 aMags;     // Radio, IR, UV, X-ray, as drawn
            varying float vPxDeg;     // Degrees of this comet's sky in a device pixel
            varying vec2 vXY;         // Degrees from the nucleus: x along the tail, y across it
            varying vec4 vShape;
            varying float vCurve;
            varying vec3 vGas;
            varying vec4 vAmount;     // Radio, IR, visible, UV
            varying float vXray;
            varying float vHalo;
            varying vec2 vEdge;
            varying vec4 vLook;       // The head's least radius (device px), the tail's light, the coma's light, device px per CSS px
            void main() {
                const float RAD = 0.0174533;
                vEdge = position.xy;
                float pxDeg = 1.0 / (uPxPerRad * depthP(aDepth) * RAD);
                vPxDeg = pxDeg;
                float tail = aShape.y;
                // At sky scale the coma is under a pixel across, yet the head must be what the eye goes to. So it never
                // gets smaller than a small glow, a bigger one the nearer the comet is
                float headPx = mix(5.5, 2.2, sqrt(aDepth)) * uDpr;
                float coma = max(aShape.x, headPx * pxDeg);
                // A tail a few pixels wide is all at the same spot on the screen, so it's drawn fainter or it burns to white.
                // One wider than the frame eases off too, or there is nothing to see but a pale wash
                float tailPx = tailOnScreen(tail, aDepth);
                float tailLight = mix(0.34, 1.0, smoothstep(50.0, 300.0, tailPx)) * mix(1.0, 0.3, smoothstep(900.0, 5000.0, tailPx));
                // Zoomed right in, a coma wider than the frame would be a fog. So it thins out as it outgrows the view
                float comaFills = smoothstep(0.04, 0.25, aShape.x / pxDeg / uViewport.y);
                vLook = vec4(headPx, tailLight, mix(1.0, 0.2, comaFills), uDpr);
                float halo = max(tail * 0.85, 2.4);
                float uvOn = step(0.002, uBandW[3]);
                float reach = max(coma * 3.5, 16.0 * pxDeg * uDpr);
                float back = mix(reach, halo * 1.25, uvOn);
                float front = max(tail * 1.3, mix(reach, halo * 1.25, uvOn));
                float side = max(max((abs(aExtra.x) * 0.8 + 0.3) * tail, reach), mix(0.0, halo * 1.25, uvOn));
                vXY = vec2(position.x > 0.0 ? front : -back, position.y * side);
                vShape = aShape;
                vCurve = aExtra.x;
                vGas = aGas;
                vHalo = halo;
                vAmount = vec4(aBandA.x * uBandW[0] * bandShows(aMags.x), aBandA.y * uBandW[1] * bandShows(aMags.y), aBandA.z * uBandW[2] * cometShows(aExtra.y), aBandA.w * uBandW[3] * bandShows(aMags.z));
                vXray = aBandB * uBandW[4] * bandShows(aMags.w);
                vec3 dir = aCentre + (aTail * vXY.x + aNormal * vXY.y) * RAD * ${SKY_RADIUS}.0;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(dir, 1.0);
                gl_Position.xy *= depthP(aDepth);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            uniform sampler2D tNoise;
            varying vec2 vXY;
            varying vec4 vShape;
            varying float vCurve;
            varying vec3 vGas;
            varying vec4 vAmount;
            varying float vXray;
            varying float vHalo;
            varying vec2 vEdge;
            varying float vPxDeg;
            varying vec4 vLook;

            void main() {
                float x = vXY.x;
                float y = vXY.y;
                float r = max(length(vXY), 1e-5);
                float pxDeg = vPxDeg;
                float tail = vShape.y;
                float dustRatio = vShape.z;
                float seed = vShape.w;
                float t = uTime * uTwinkle;

                // The coma: pushed back on the sunward side into a hood, drawn out towards the tail
                float comaR = max(vShape.x, vLook.x * pxDeg);
                float cosA = x / r;
                float rh = r * (1.0 + 0.28 * -cosA + 0.22 * cosA * -abs(cosA));
                float comaWide = exp(-rh / (comaR * 0.42));
                // The bright middle and the nucleus keep to a few pixels however far in you go: a nucleus is a point of
                // light, and a ball of white the size of the frame would hide the coma's own shape
                float coreR = min(comaR * 0.1, 22.0 * vLook.w * pxDeg);
                float comaCore = exp(-r / (comaR * 1.1)) / (1.0 + pow(rh / coreR, 2.0));
                float nucleusR = max(min(comaR * 0.035, 3.0 * vLook.w * pxDeg), 1.05 * pxDeg);
                float nucleus = exp(-r * r / (nucleusR * nucleusR));

                // The ion tail: straight out from the nucleus, narrow, full of fine rays flowing away
                float xi = x / tail;
                float ion = 0.0;
                float ionWide = 0.0;
                if (xi > -0.03 && xi < 1.32) {
                    float ramp = smoothstep(-0.015, 0.03, xi);
                    float sway = 0.018 * tail * xi * xi * sin(xi * 7.0 + seed * 30.0 + t * 0.21);
                    float wi = max(tail * (0.0045 + 0.042 * xi), 1.0 * pxDeg);
                    float yi = (y - sway) / wi;
                    float rays = texture2D(tNoise, vec2(yi * 0.075 + seed, xi * 0.55 - t * 0.022)).g;
                    float strands = texture2D(tNoise, vec2(yi * 0.19 + seed * 2.0, xi * 1.3 - t * 0.04)).r;
                    float body = exp(-yi * yi * 0.9);
                    ion = body * (0.4 + 1.2 * rays * rays + 0.5 * strands) * exp(-xi * 2.5) * ramp * smoothstep(1.3, 0.95, xi);
                    ionWide = exp(-yi * yi * 0.09) * exp(-xi * 3.2) * ramp * smoothstep(1.3, 0.8, xi);
                }

                // The dust tail: heavier grains lag behind, so it curves away and fans out. It has a crisp leading
                // edge and a soft trailing one
                float xd = x / (tail * 0.82);
                float dust = 0.0;
                if (xd > -0.03 && xd < 1.6) {
                    float ramp = smoothstep(-0.02, 0.05, xd);
                    float centre = vCurve * tail * 0.3 * xd * xd;
                    float wd = max(tail * (0.012 + 0.11 * xd), 1.3 * pxDeg);
                    float yn = (y - centre) / wd;
                    float lead = yn * sign(vCurve);
                    float prof = lead > 0.0 ? exp(-lead * lead * 2.6) : exp(-lead * lead * 0.6);
                    // Streamers fan out from the nucleus: read noise by the angle they leave it at
                    float fan = texture2D(tNoise, vec2((y / sqrt(x * x + comaR * comaR)) * 3.5 + seed * 3.0, xd * 0.12 - t * 0.006)).r;
                    float bands = texture2D(tNoise, vec2(yn * 0.1 + seed, xd * 0.3 - t * 0.012)).a;
                    dust = prof * exp(-xd * 1.55) * ramp * (0.45 + 0.75 * fan + 0.45 * bands) * smoothstep(1.6, 1.15, xd);
                }

                float dustW = 0.3 + 1.05 * dustRatio;
                float ionW = 0.3 + 1.05 * (1.0 - dustRatio);

                // Visible
                vec3 dustColour = mix(vec3(1.0, 0.74, 0.4), vec3(1.0, 0.9, 0.7), smoothstep(0.55, 0.0, xd));
                vec3 ionColour = vec3(0.2, 0.46, 1.0);
                vec3 tailLit = (dustColour * dust * dustW * 0.8 + ionColour * (ion * 1.3 + ionWide * 0.2) * ionW) * vLook.y * vAmount.z;
                // A soft ceiling, so that however bright it gets the tail keeps its colours and never burns to white
                tailLit /= 1.0 + 2.2 * dot(tailLit, vec3(0.3, 0.55, 0.15));
                vec3 visible = vGas * comaWide * 0.42 * vLook.z
                    + mix(vGas, vec3(1.0), 0.45) * comaCore * 0.8
                    + vec3(1.0, 0.98, 0.92) * nucleus * 4.5;

                // Infrared: the warm dust, and little else
                float ir = dust * dustW * 1.5 + comaWide * 1.0 + comaCore * 0.8 + nucleus * 2.0;

                // Ultraviolet: the huge hydrogen cloud, then the coma
                float hr = r / vHalo;
                float cloud = exp(-hr * hr * 2.6) * 0.34 + exp(-hr * 3.2) * 0.16;
                cloud *= 1.0 + 0.18 * (texture2D(tNoise, vXY / vHalo * 0.12 + seed).a - 0.5);
                // Far bigger than a narrow view, so there it's only a tint over what's behind it, not a wall of violet
                cloud *= mix(0.22, 1.0, smoothstep(2.0, 15.0, uFov));
                float uv = cloud * smoothstep(1.25, 0.9, hr) + comaWide * 0.8 + comaCore * 0.9 + ion * 0.5 * ionW + nucleus * 2.0;

                // Radio: a faint point at the 18 cm OH line
                float pointR = max(comaR * 0.35, 1.8 * pxDeg);
                float radio = exp(-r * r / (pointR * pointR)) * 1.8;

                // X-rays: the solar wind lights a crescent on the sunward side of the coma
                float shell = (r - comaR * 1.1) / (comaR * 0.55);
                float crescent = exp(-shell * shell) * pow(max(-cosA, 0.0), 1.4);
                float xray = (crescent * 1.2 + nucleus * 0.6 + comaWide * 0.2) * 2.2;

                vec3 light = tailLit + visible * vAmount.z
                    + uBandTint[0] * (radio * vAmount.x)
                    + uBandTint[1] * (ir * vAmount.y)
                    + uBandTint[3] * (uv * vAmount.w)
                    + uBandTint[4] * (xray * vXray);
                // Nothing may reach the edge of the quad
                float window = smoothstep(1.0, 0.72, abs(vEdge.x)) * smoothstep(1.0, 0.72, abs(vEdge.y));
                gl_FragColor = vec4(light * window * uSkyFade, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.comets;
    engine.scene.add(mesh);
    return mesh;
}

function createParticles(engine, comets) {
    const total = comets.length * PARTICLES_EACH;
    const a = {
        centre: new Float32Array(total * 3), tail: new Float32Array(total * 3), normal: new Float32Array(total * 3),
        shape: new Float32Array(total * 4), grain: new Float32Array(total * 4), band: new Float32Array(total * 3),
        depth: new Float32Array(total), mags: new Float32Array(total * 2)
    };
    // Interleaved, so that drawing only the first part still gives every comet its share
    let k = 0;
    for (let p = 0; p < PARTICLES_EACH; p++) {
        comets.forEach((comet) => {
            const { body, basis, rng } = comet;
            const dustRatio = body.comet.dust_ratio;
            const isDust = rng.next() < 0.3 + 0.5 * dustRatio;
            a.centre.set(basis.c.map((v) => v * SKY_RADIUS), k * 3);
            a.tail.set(basis.t, k * 3);
            a.normal.set(basis.n, k * 3);
            a.shape.set([body.comet.coma_deg, body.comet.tail_deg, comet.curve, drawMag(body)], k * 4);
            a.depth[k] = body.depth;
            a.mags.set([comet.mags[1], comet.mags[2]], k * 2);
            // Start along the tail, sideways offset (more near the middle), dust (0) or ion (1), phase
            a.grain.set([rng.next(), rng.gauss(0, 0.55), isDust ? 0 : 1, rng.next()], k * 4);
            a.band.set([body.bands.ir, body.bands.visible, body.bands.uv], k * 3);
            k++;
        });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(a.centre, 3));
    geometry.setAttribute('aTail', new THREE.BufferAttribute(a.tail, 3));
    geometry.setAttribute('aNormal', new THREE.BufferAttribute(a.normal, 3));
    geometry.setAttribute('aShape', new THREE.BufferAttribute(a.shape, 4));
    geometry.setAttribute('aGrain', new THREE.BufferAttribute(a.grain, 4));
    geometry.setAttribute('aBand', new THREE.BufferAttribute(a.band, 3));
    geometry.setAttribute('aDepth', new THREE.BufferAttribute(a.depth, 1));
    geometry.setAttribute('aMags', new THREE.BufferAttribute(a.mags, 2));

    const material = skyMaterial({
        uniforms: { uDpr: { value: 1 } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            ${COMET_COMMON}
            attribute vec3 aTail;
            attribute vec3 aNormal;
            attribute vec4 aShape;
            attribute vec4 aGrain;
            attribute vec3 aBand;
            attribute float aDepth;
            attribute vec2 aMags;     // IR, UV, as drawn
            varying vec3 vLight;
            void main() {
                const float RAD = 0.0174533;
                float tail = aShape.y;
                float isIon = aGrain.z;
                float t = uTime * uTwinkle;
                // Grains drift out along the tail; ions are swept away much faster
                float u = fract(aGrain.x + t * mix(0.0035, 0.012, isIon));
                float x;
                float y;
                if (isIon > 0.5) {
                    x = u * tail;
                    y = aGrain.y * tail * (0.0045 + 0.042 * u) * 1.1;
                } else {
                    float xd = u * 1.1;
                    x = xd * tail * 0.82;
                    y = aShape.z * tail * 0.3 * xd * xd + aGrain.y * tail * (0.012 + 0.11 * xd) * 1.2;
                }
                vec3 dir = position + (aTail * x + aNormal * y) * RAD * ${SKY_RADIUS}.0;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(dir, 1.0);
                gl_Position.xy *= depthP(aDepth);

                float along = isIon > 0.5 ? exp(-u * 2.6) : exp(-u * 1.5);
                float life = smoothstep(0.0, 0.05, u) * smoothstep(1.0, 0.75, u);
                float flicker = 0.65 + 0.35 * uTwinkle * sin(uTime * (1.5 + aGrain.w * 3.0) + aGrain.w * 50.0);
                vec3 tint = isIon > 0.5 ? vec3(0.45, 0.68, 1.0) : vec3(1.0, 0.86, 0.62);
                // At wide views the grains land on top of each other and would burn the tail to white, so they fade right
                // out and leave it to the glow. Zoomed in they stand apart.
                float apart = smoothstep(90.0, 340.0, tailOnScreen(tail, aDepth));
                float vis = aBand.y * uBandW[2] * cometShows(aShape.w) * apart * apart;
                vec3 light = tint * vis
                    + uBandTint[1] * (uBandW[1] * aBand.x * (1.0 - isIon) * bandShows(aMags.x))
                    + uBandTint[3] * (uBandW[3] * aBand.z * isIon * 0.4 * bandShows(aMags.y));
                vLight = light * along * life * flicker * 0.5 * uSkyFade;
                gl_PointSize = (0.9 + 1.3 * aGrain.w * aGrain.w) * 1.5 * uDpr;
            }`,
        fragmentShader: /* glsl */`
            varying vec3 vLight;
            void main() {
                float r = length(gl_PointCoord - 0.5) * 2.0;
                gl_FragColor = vec4(vLight * exp(-r * r * 3.0), 1.0);
            }`
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = ORDER.comets + 1;
    engine.scene.add(points);
    return points;
}

export function createCometsLayer(engine, app) {
    const sunDir = azAltToVec3(app.universe.cometTailAz, SUN_ALT);
    const comets = app.universe.bodies.filter((b) => b.kind === 'comet' && b.comet).map((body) => {
        const rng = bodyRng(body, 'comet');
        const curve = (rng.next() < 0.5 ? -1 : 1) * rng.range(0.55, 1);
        const m = bandMagnitudes(body);
        return { body, rng, basis: tailBasis(body, sunDir), seed: rng.next(), curve, gas: gasColour(body.comet.emission_lines), mags: [m.radio, m.ir, m.uv, m.xray] };
    });
    const glow = createGlow(engine, comets);
    const particles = createParticles(engine, comets);
    const total = comets.length * PARTICLES_EACH;
    let appliedQuality = null;

    return {
        id: 'comets',
        update(frame) {
            particles.material.uniforms.uDpr.value = frame.dpr;
            glow.material.uniforms.uDpr.value = frame.dpr;
            if (frame.quality !== appliedQuality) {
                appliedQuality = frame.quality;
                const share = frame.quality === 'low' ? 0.3 : frame.quality === 'medium' ? 0.65 : 1;
                particles.geometry.setDrawRange(0, Math.floor(total * share));
            }
        },
        // A comet can be clicked anywhere it can be seen, not only on its head: all across the width its dust grains drift
        // over, along the straight ion tail, and in ultraviolet anywhere in its great hydrogen cloud. At every zoom, as the
        // grains look like stars when zoomed right in. Only called on a click or a hover
        picks(frame) {
            const list = [];
            comets.forEach(({ body, basis, curve }) => {
                if (!engine.bodyShows(body)) return;
                // In visible light a comet is seen only from a little before the zoom's limit: no clicking on empty sky
                if (frame.band === 'visible' && drawMag(body) > limitingMag(frame.fov) + 0.6) return;
                const { c, t, n } = basis;
                const tail = body.comet.tail_deg;
                const pxPerDeg = (frame.pxPerRad * DEG * parallaxFactor(body.depth, frame.fov)) / frame.dpr;
                const step = 30 / pxPerDeg;
                const push = (x, y, radiusPx = 0) => {
                    const dx = x * DEG;
                    const dy = y * DEG;
                    const sky = vec3ToAzAlt(c[0] + t[0] * dx + n[0] * dy, c[1] + t[1] * dx + n[1] * dy, c[2] + t[2] * dx + n[2] * dy);
                    list.push({ code: body.code, az: sky.az, alt: sky.alt, radiusPx, depth: body.depth });
                };
                const along = Math.max(step, tail / 40);
                // The dust tail, out to where it fades (the glow's shader draws it to 1.6 of 0.82 of the tail, faintly)
                for (let x = along; x <= tail * 1.1; x += along) {
                    const xd = x / (tail * 0.82);
                    // As far out as the grains go: see the particles' shader
                    const halfWidth = tail * (0.012 + 0.11 * xd) * 1.7;
                    const across = Math.max(step, (2 * halfWidth) / 20);
                    const middle = curve * tail * 0.3 * xd * xd;
                    for (let y = -halfWidth; y <= halfWidth + across * 0.5; y += across) push(x, middle + y);
                }
                // The ion tail goes straight out from the head, where a strongly curved dust tail has left it, in visible
                // light and ultraviolet; infrared shows only the dust
                if (frame.band === 'visible' || frame.band === 'uv') {
                    for (let x = along; x <= tail * 1.1; x += along) push(x, 0);
                }
                // In ultraviolet the hydrogen cloud is far bigger than the rest, and plainly part of the comet
                if (frame.band === 'uv') push(0, 0, Math.max(body.comet.tail_deg * 0.85, 2.4) * 0.85 * pxPerDeg);
            });
            return list;
        },
        dispose() {
            [glow, particles].forEach((mesh) => {
                engine.scene.remove(mesh);
                mesh.geometry.dispose();
                mesh.material.dispose();
            });
        }
    };
}
