// Supernovae: a flash, then an expanding shell that breaks up into a filamentary remnant, shown at each object's
// own time t = phase0_days + the time its panel's playback sends over the bus ('timeline'). There is no global
// clock, so each stays at its own stage until its panel plays it.
//
// The remnant is baked once at full size (nebula_bake.js). A freely expanding shell looks the same at every age
// apart from its scale, so the sprite only scales that image with time and shifts the light between its channels;
// time changes cost no bake at all. The bright point at the middle is stars.js's sprite; this layer adds the glow
// around it and the shell. Both types are drawn in one instanced draw.

import * as THREE from 'three';
import { bus } from '../../core/state.js';
import { azAltToVec3 } from '../../core/sky.js';
import { Rng, hashString } from '../../core/rng.js';
import { blackBodyRGB } from '../../core/phys.js';
import { depthLight, parallaxFactor } from '../../core/depth.js';
import { supernovaBandsAt } from '../../data/band_table.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { getBaker, SPRITE_FETCH_GLSL, SPRITE_ID_GLSL, lineRGB } from './nebula_bake.js';

const SKY_RADIUS = 1000;
const RAD = Math.PI / 180;
const DISPLAY_SCALE = 2.5; // shell_deg is stretched like every other size here, so that a shell reads at sky scale

const smooth = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

function shellRadius(t) {
    if (t <= 0) return 0.03;
    return Math.min(1, Math.max(0.03, 1.15 * (t / (t + 220)) ** 0.8));
}

// Everything that changes with time, written straight into the instance arrays. How bright each band is comes from
// the band table, the one source for that; this only decides where that light is: early on it is all in the point,
// and later it is all in the shell. Returns the point's share of its peak light, for the sprite in stars.js.
function writeStage(a, i, sn, t) {
    const isIa = sn.type === 'Ia';
    const bands = supernovaBandsAt(sn, t);
    const inShell = smooth(20, 130, t);
    const inFlash = 1 - inShell;
    // The point's light goes by its magnitude. The shell's is an extended object's: see core/depth.js
    const shell = inShell * a.shellLight[i];
    a.shape.set([shellRadius(t), smooth(150, 400, t), bands.visible * shell, bands.visible * inFlash], i * 4);
    a.flash.set([bands.radio * inFlash, bands.ir * inFlash, bands.uv * inFlash, bands.xray * inFlash], i * 4);
    a.shell.set([bands.radio * shell, bands.ir * shell, bands.uv * shell, bands.xray * shell], i * 4);
    // Colour of the flash: a cooling black body. Type II starts hotter and ends redder, on its hydrogen plateau
    const hot = isIa ? 11500 : 19000;
    const cool = isIa ? 5600 : 4400;
    const T = t <= 0 ? hot : cool + (hot - cool) * Math.exp(-t / (isIa ? 22 : 16));
    a.flashCol.set(blackBodyRGB(T), i * 3);
    // Colour of the shell sheet: glowing white while young, then the lines of the gas it has swept up
    const young = Math.exp(-t / 120);
    const late = a.lateSheet[i];
    const warm = blackBodyRGB(7000);
    a.sheetCol.set([
        warm[0] * young + late[0] * (1 - young),
        warm[1] * young + late[1] * (1 - young),
        warm[2] * young + late[2] * (1 - young)
    ], i * 3);
    return bands.visible * inFlash;
}

export function createSupernovaeLayer(engine, app) {
    const baker = getBaker(engine, app);
    const bodies = app.universe.bodies.filter((b) => b.kind === 'supernova');
    const n = bodies.length;
    const f = (size) => new Float32Array(n * size);
    const aCentre = f(3);
    const aR = f(3);
    const aN = f(3);
    const aRect = f(4);
    const aFilCol = f(3);
    const aPack = f(3); // Half-size, job id, peak magnitude: packed, as WebGL allows only 16 attributes
    const aReady = f(1);
    const aDepth = f(1);
    const stage = { shape: f(4), flash: f(4), shell: f(4), flashCol: f(3), sheetCol: f(3), lateSheet: [], shellLight: bodies.map(depthLight) };

    const items = [];
    const byCode = new Map();
    const hydrogen = lineRGB(656.28);
    const nitrogenSulphur = lineRGB(671.6);
    const oxygen = lineRGB(500.7);
    const balmerBlue = lineRGB(434.0);
    bodies.forEach((body, i) => {
        const sn = body.supernova;
        const isIa = sn.type === 'Ia';
        const c = azAltToVec3(body.sky.az, body.sky.alt);
        let rx = -c[2];
        let rz = c[0];
        const len = Math.hypot(rx, rz) || 1;
        rx /= len;
        rz /= len;
        const r = [rx, 0, rz];
        const nn = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]];

        const rng = new Rng(hashString(`${body.visual_seed}:remnant`));
        const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rng.range(0, 6.283), rng.range(0, 6.283), rng.range(0, 6.283)));
        const rot = new THREE.Matrix3().setFromMatrix4(m);
        const off = new THREE.Vector3(rng.next(), rng.next(), rng.next());
        const z = rng.range(-0.4, 0.4); // The axis lies near the plane of the sky, so its bright limbs can be seen
        const ang = rng.range(0, Math.PI * 2);
        const s = Math.sqrt(1 - z * z);
        const axis = new THREE.Vector3(s * Math.cos(ang), s * Math.sin(ang), z);
        const lop = isIa ? 0.02 : 0.08;
        const S = new THREE.Vector4(0.68, isIa ? rng.range(0.035, 0.05) : rng.range(0.07, 0.10), isIa ? rng.range(0.03, 0.05) : rng.range(0.10, 0.16), isIa ? 0 : 1);
        const asym = new THREE.Vector4(rng.range(-lop, lop), rng.range(-lop, lop), rng.range(-lop, lop), isIa ? rng.range(0.06, 0.1) : rng.range(0.16, 0.26));
        const C = new THREE.Vector4(isIa ? 1.5 : 0.95, isIa ? 0.9 : 0.85, 1.2, isIa ? 2.2 : 1.8);
        // Each has its own outline: a Type Ia is close to round, a Type II lobed, and many have burst out on one side
        const blowAngle = rng.range(0, Math.PI * 2);
        const L = new THREE.Vector4(
            isIa ? rng.range(0.10, 0.22) : rng.range(0.22, 0.42),
            rng.chance(isIa ? 0.35 : 0.65) ? rng.range(0.12, 0.26) : 0,
            Math.cos(blowAngle),
            Math.sin(blowAngle)
        );
        // A Type II can be anything from thin, broken arcs to a web of filaments right across it
        const F = new THREE.Vector4(
            isIa ? rng.range(0.01, 0.04) : rng.chance(0.3) ? rng.range(0.2, 0.42) : rng.range(0.05, 0.16),
            isIa ? rng.range(0.09, 0.14) : rng.range(0.14, 0.30),
            isIa ? rng.range(0.15, 0.4) : rng.range(0.05, 0.25),
            isIa ? 0 : rng.chance(0.25) ? rng.range(1.0, 2.0) : 0
        );
        const job = baker.addJob({
            program: 'remnant',
            dir: c,
            set(u) {
                u.uOff.value = off;
                u.uRot.value = rot;
                u.uS.value = S;
                u.uAsym.value = asym;
                u.uAxis.value = axis;
                u.uC.value = C;
                u.uL.value = L;
                u.uF.value = F;
            },
            onReset() { items[i].shown = 0; aReady[i] = 0; readyAttr.needsUpdate = true; }
        });
        const tanHalf = Math.tan(sn.shell_deg * DISPLAY_SCALE * RAD);
        aCentre.set(c, i * 3);
        aR.set(r, i * 3);
        aN.set(nn, i * 3);
        aRect.set(job.rect, i * 4);
        aPack.set([tanHalf, job.id, sn.peak_mag + (body.depth_dim_mag || 0)], i * 3);
        aDepth[i] = body.depth;
        // Filaments: Balmer-dominated and pale for Type Ia, a warmer red with [N II] and [S II] for Type II. The sheet
        // and ejecta: blue-white for a Type Ia's fast shock, oxygen teal for a Type II's oxygen-rich ejecta. Both are as
        // a camera records them, paler than the pure colours of the lines.
        const filament = isIa
            ? [hydrogen[0] * 0.80 + balmerBlue[0] * 0.25, hydrogen[1] * 0.80 + 0.26, hydrogen[2] * 0.80 + balmerBlue[2] * 0.30]
            : [hydrogen[0] * 0.50 + nitrogenSulphur[0] * 0.50, 0.18 + rng.range(0, 0.08), 0.17];
        aFilCol.set(filament, i * 3);
        stage.lateSheet.push(isIa ? [0.55, 0.72, 1.0] : [oxygen[0] * 0.5 + 0.34, oxygen[1] * 0.45 + 0.27, oxygen[2] * 0.5 + 0.42]);
        const pointShare = writeStage(stage, i, sn, sn.phase0_days);
        items.push({ body, job, c, r, n: nn, tanHalf, shown: 0, bands: supernovaBandsAt(sn, sn.phase0_days), pointShare });
        byCode.set(body.code, i);
    });

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const inst = (name, array, size, dynamic) => {
        const attr = new THREE.InstancedBufferAttribute(array, size);
        if (dynamic) attr.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(name, attr);
        return attr;
    };
    inst('aCentre', aCentre, 3);
    inst('aR', aR, 3);
    inst('aN', aN, 3);
    inst('aRect', aRect, 4);
    inst('aFilCol', aFilCol, 3);
    inst('aPack', aPack, 3);
    inst('aDepth', aDepth, 1);
    const readyAttr = inst('aReady', aReady, 1, true);
    const stageAttrs = [
        inst('aShape', stage.shape, 4, true),
        inst('aFlash', stage.flash, 4, true),
        inst('aShell', stage.shell, 4, true),
        inst('aFlashCol', stage.flashCol, 3, true),
        inst('aSheetCol', stage.sheetCol, 3, true)
    ];
    geometry.instanceCount = n;

    const material = skyMaterial({
        uniforms: { tAtlas: baker.atlasUniform, ...baker.heroUniforms },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            ${SPRITE_ID_GLSL}
            attribute vec3 aCentre;
            attribute vec3 aR;
            attribute vec3 aN;
            attribute vec4 aRect;
            attribute vec3 aFilCol;
            attribute vec3 aPack;
            attribute float aReady;
            attribute vec4 aShape;
            attribute vec4 aFlash;
            attribute vec4 aShell;
            attribute vec3 aFlashCol;
            attribute vec3 aSheetCol;
            attribute float aDepth;
            varying vec2 vQ;
            varying vec2 vPx;
            varying vec4 vRect;
            varying vec3 vFilCol;
            varying vec3 vSheetCol;
            varying vec3 vFlash;
            varying vec4 vShape;
            varying vec4 vShell;
            varying float vShellX;
            varying float vReady;
            varying float vGlowPx;
            varying float vSmall;
            void main() {
                float aHalf = aPack.x;
                // Only a few tens of pixels across, a shell is a faint smoke ring on the sky, not yet a bright hoop
                vSmall = mix(0.5, 1.0, smoothstep(30.0, 170.0, 2.0 * aHalf * aShape.x * uPxPerRad));
                SET_HERO(aPack.y)
                // How bright the event looks from here, in the same terms as stars.js uses for its point
                float over = clamp(pow(10.0, -0.4 * (aPack.z - uLimitMag)), 0.0, 400.0);
                float seen = min(1.0, sqrt(over) / 5.0);
                float vis = aShape.w * seen * uBandW[2];
                float radio = aFlash.x * uBandW[0];
                float ir = aFlash.y * uBandW[1];
                float uv = aFlash.z * uBandW[3];
                float xr = aFlash.w * uBandW[4];
                vFlash = aFlashCol * vis + uBandTint[0] * radio + uBandTint[1] * ir + uBandTint[3] * uv + uBandTint[4] * xr;
                float total = vis + radio + ir + uv + xr;
                float dprScale = clamp(uViewport.y / 900.0, 0.8, 2.0);
                // Bright, but a point of light: at its peak it shouldn't be the largest thing in the sky
                float glowPx = (4.0 + 34.0 * sqrt(total)) * dprScale;
                vGlowPx = glowPx;
                float half_ = max(aHalf, glowPx / uPxPerRad);
                vQ = position.xy * half_ / aHalf;
                vPx = position.xy * half_ * uPxPerRad;
                vRect = aRect;
                vFilCol = aFilCol;
                vSheetCol = aSheetCol;
                vShape = aShape;
                vShell = vec4(aShell.x, aShell.y, aShape.z, aShell.z);
                vShellX = aShell.w;
                vReady = aReady;
                vec3 world = (aCentre + (aR * position.x + aN * position.y) * half_) * ${SKY_RADIUS.toFixed(1)};
                gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
                gl_Position.xy *= depthP(aDepth);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            ${SPRITE_FETCH_GLSL}
            varying vec2 vQ;
            varying vec2 vPx;
            varying vec4 vRect;
            varying vec3 vFilCol;
            varying vec3 vSheetCol;
            varying vec3 vFlash;
            varying vec4 vShape;
            varying vec4 vShell;
            varying float vShellX;
            varying float vReady;
            varying float vGlowPx;
            varying float vSmall;

            vec3 ramp(vec3 tint, float v) {
                return tint * v + vec3(0.9) * v * v * 0.3;
            }

            void main() {
                // The image of the grown remnant, scaled to the shell's size today
                vec2 q = vQ / vShape.x;
                float inside = step(max(abs(q.x), abs(q.y)), 1.0);
                vec2 qc = clamp(q, -1.0, 1.0);
                vec4 t = fetchBaked(qc, vRect.xy + (qc * 0.5 + 0.5) * vRect.zw, 1.0) * inside * vReady;
                float sheet = t.r * t.r;
                float fil = t.g * t.g;
                float hot = t.b * t.b;
                float sync = t.a * t.a;
                float age = vShape.y;

                // A young shell is bright and smooth; as it sweeps up gas it fades into threads
                vec3 col = (vSheetCol * sheet * (1.15 - 0.85 * age) * 2.5 + vFilCol * fil * (0.25 + 1.5 * age) * 1.35) * vSmall * vShell.z * uBandW[2];
                col += ramp(uBandTint[0], sync * 2.9 * vShell.x) * uBandW[0];
                col += ramp(uBandTint[1], (sheet * 0.9 + hot * 0.25 + fil * 0.6) * 1.8 * vShell.y) * uBandW[1];
                col += ramp(uBandTint[3], (sheet * 1.2 + fil * 1.1) * 1.5 * vShell.w) * uBandW[3];
                col += ramp(uBandTint[4], (hot * 1.4 + sheet * 0.3) * 1.5 * vShellX) * uBandW[4];

                // The flash: a small hot core and a wide faint halo, sized in pixels because it is a point of light
                float r = length(vPx) / max(vGlowPx, 1.0);
                float glow = exp(-r * r * 36.0) * 2.2 + exp(-r * r * 7.0) * 0.45 + 0.09 / (1.0 + r * r * 90.0);
                glow *= smoothstep(1.0, 0.72, r);
                col += vFlash * glow;

                gl_FragColor = vec4(col * uSkyFade, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.supernovae;
    engine.scene.add(mesh);

    // The bright point is drawn by the stars layer, which is created after this one, so it's reached from update
    let pointsDirty = true;
    function sendPoints() {
        const stars = engine.getLayer('stars');
        if (!stars) return;
        pointsDirty = false;
        if (!stars.setSpriteFlux) return;
        items.forEach((item) => stars.setSpriteFlux(item.body.code, item.pointShare));
    }

    const offTimeline = bus.on('timeline', ({ code, t_days: tDays }) => {
        const i = byCode.get(code);
        if (i === undefined) return;
        const item = items[i];
        const sn = item.body.supernova;
        const t = sn.phase0_days + tDays;
        item.pointShare = writeStage(stage, i, sn, t);
        pointsDirty = true;
        item.bands = supernovaBandsAt(sn, t);
        stageAttrs.forEach((attr) => { attr.needsUpdate = true; });
    });

    return {
        id: 'supernovae',
        update(frame) {
            baker.beginFrame(frame);
            let changed = false;
            const step = frame.dt > 0 ? frame.dt / 0.5 : 1;
            if (pointsDirty) sendPoints();
            for (let i = 0; i < n; i++) {
                const item = items[i];
                if (item.job.ready && item.shown < 1) {
                    item.shown = frame.reduceMotion ? 1 : Math.min(1, item.shown + step);
                    aReady[i] = item.shown;
                    changed = true;
                }
                const shape = i * 4;
                if (stage.shape[shape + 2] > 0.02) {
                    item.job.half = item.tanHalf * stage.shape[shape];
                    item.job.parallax = parallaxFactor(item.body.depth, frame.fov);
                    baker.considerSprite(item.job, item.c, item.r, item.n);
                }
            }
            if (changed) readyAttr.needsUpdate = true;
        },
        // A grown shell can be clicked anywhere on it, not only on the point at its centre
        picks(frame) {
            const out = [];
            for (let i = 0; i < n; i++) {
                const { body, tanHalf, bands } = items[i];
                if ((bands[frame.band] || 0) <= 0.01) continue;
                const shape = i * 4;
                if (stage.shape[shape + 2] < 0.05) continue;
                const radiusPx = (tanHalf * stage.shape[shape] * 0.74 * frame.pxPerRad * parallaxFactor(body.depth, frame.fov)) / frame.dpr;
                out.push({ code: body.code, az: body.sky.az, alt: body.sky.alt, radiusPx, depth: body.depth });
            }
            return out;
        },
        dispose() {
            offTimeline();
            engine.scene.remove(mesh);
            geometry.dispose();
            material.dispose();
        }
    };
}
