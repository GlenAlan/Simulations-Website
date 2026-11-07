// Comets in another star's system: a small bright coma, a curved yellow-white dust tail and a straight blue ion tail, both
// pointing away from the star, growing as the comet nears it and gone far out, where its ice stays frozen. In the style of
// the sky's comets close up (render/layers/comets.js), on one small quad per comet laid out on the screen, so it costs a draw
// call each. Each band shows what comets really do: infrared the warm dust, ultraviolet the huge hydrogen cloud, radio a
// faint OH glow, X-rays a faint crescent where the star's wind meets the coma.
//
//   const comets = createComets(model, mix);   group goes in the scene
//   comets.place(tDays, mix)                   where each is now, before the camera moves: comets.items[i].world
//   comets.update(ctx)                         after the camera has moved; see below
//   comets.pick(x, y, radiusPx, dpr)           { code, d } nearest in CSS px, or null
//   comets.dispose()

import * as THREE from 'three';
import { sharedUniforms, BAND_GLSL } from '../shared.js';
import { createOrbitLine } from './orbit_lines.js';
import { cometAt, cometOrbitPoints, activity } from './comet_orbits.js';
import { FRAME, radialToWorld, ringRadius } from './system_model.js';

const COMA_WORLD = 0.012 * FRAME;     // The coma's size in the system's world: a few pixels from afar, a ball close up
const TAIL_LEAST = 0.15 * FRAME;      // A tail is at least this long when the comet is at its most active, so it reads
const LINE_COLOUR = [0.6, 0.78, 0.84];

const VERTEX = /* glsl */`
uniform vec4 uClip;         // The nucleus, in clip space
uniform vec2 uTail;         // Which way the tail points on the screen
uniform vec3 uReach;        // Device px: behind the head, ahead along the tail, to each side
uniform vec2 uViewport;
varying vec2 vXY;           // Device px from the nucleus: x along the tail, y across it
varying vec2 vEdge;
void main() {
    vEdge = position.xy;
    vec2 n = vec2(-uTail.y, uTail.x);
    vXY = vec2(position.x > 0.0 ? uReach.y : -uReach.x, position.y * uReach.z);
    vec4 c = uClip;
    c.xy += (uTail * vXY.x + n * vXY.y) / (uViewport * 0.5) * c.w;
    gl_Position = c;
}`;

const FRAGMENT = /* glsl */`
${BAND_GLSL}
uniform float uComa;        // The coma's radius, device px
uniform float uTailLen;     // The tail's length on screen, device px
uniform float uCurve;       // Which way and how far the dust tail bends back along the orbit
uniform float uDust;        // Dust's share of the tails
uniform float uActive;      // 0 far out, a bare nucleus; 1 near the star
uniform float uHalo;        // The hydrogen cloud's radius, device px
uniform vec3 uGas;          // The coma's colour, from its emission lines
uniform float uAlpha;
uniform float uSeed;
varying vec2 vXY;
varying vec2 vEdge;
void main() {
    float x = vXY.x;
    float y = vXY.y;
    float r = max(length(vXY), 1e-3);
    float cosA = x / r;
    float t = uTime * uTwinkle;
    float comaR = uComa;

    // The coma, pushed back into a hood on the side facing the star, and its bright middle
    float rh = r * (1.0 + 0.28 * -cosA);
    float comaWide = exp(-rh / (comaR * 0.45)) * uActive;
    float core = exp(-r * r / (comaR * comaR * 0.08));
    float nucleus = exp(-r * r / 2.2);

    // The ion tail: straight out from the star, narrow, its streaks drifting outward
    float L = max(uTailLen, 1.0);
    float xi = x / L;
    float ion = 0.0;
    if (xi > -0.02 && xi < 1.25) {
        float wi = max(L * (0.008 + 0.035 * xi), 1.0);
        float yi = y / wi;
        float rays = 0.65 + 0.35 * sin(yi * 2.6 + uSeed * 40.0 + 6.0 * sin(xi * 3.0 - t * 0.35));
        ion = exp(-yi * yi * 0.9) * rays * exp(-xi * 2.2) * smoothstep(-0.01, 0.04, xi) * smoothstep(1.2, 0.85, xi);
    }

    // The dust tail: heavier grains lag behind, so it bends back along the orbit and fans out, with a crisp leading edge
    float xd = x / (L * 0.8);
    float dust = 0.0;
    if (xd > -0.02 && xd < 1.5) {
        float centre = uCurve * L * 0.3 * xd * xd;
        float wd = max(L * (0.02 + 0.1 * xd), 1.3);
        float yn = (y - centre) / wd;
        float lead = yn * (uCurve >= 0.0 ? 1.0 : -1.0);
        float prof = lead > 0.0 ? exp(-lead * lead * 2.6) : exp(-lead * lead * 0.6);
        dust = prof * exp(-xd * 1.6) * smoothstep(-0.02, 0.06, xd) * smoothstep(1.5, 1.1, xd);
    }
    float dustW = (0.3 + 1.05 * uDust) * uActive;
    float ionW = (0.3 + 1.05 * (1.0 - uDust)) * uActive;

    vec3 dustColour = mix(vec3(1.0, 0.74, 0.4), vec3(1.0, 0.9, 0.7), smoothstep(0.55, 0.0, xd));
    vec3 tail = dustColour * dust * dustW * 1.3 + vec3(0.2, 0.46, 1.0) * ion * ionW * 2.2;
    // A soft ceiling, so the tail keeps its colours and never burns to white
    tail /= 1.0 + 2.0 * dot(tail, vec3(0.3, 0.55, 0.15));
    vec3 visible = tail + uGas * comaWide * 0.5 + mix(uGas, vec3(1.0), 0.5) * core * (0.12 + 0.88 * uActive)
        + vec3(1.0, 0.97, 0.9) * nucleus * (0.45 + 0.95 * uActive);

    float ir = dust * dustW * 1.5 + comaWide + core * 0.8 * (0.3 + 0.7 * uActive) + nucleus;
    float hr = r / uHalo;
    float cloud = (exp(-hr * hr * 2.6) * 0.34 + exp(-hr * 3.2) * 0.16) * smoothstep(1.25, 0.9, hr) * uActive;
    float uv = cloud + comaWide * 0.8 + core * 0.9 * uActive + ion * 0.5 * ionW + nucleus * 0.5;
    float radio = exp(-r * r / (comaR * comaR * 0.12)) * 1.2 * uActive;
    float shell = (r - comaR * 1.1) / (comaR * 0.55);
    float xray = (exp(-shell * shell) * pow(max(-cosA, 0.0), 1.4) + comaWide * 0.1) * 0.45 * uActive;

    vec3 light = visible * uBandW[2] + uBandTint[0] * (radio * uBandW[0]) + uBandTint[1] * (ir * uBandW[1])
        + uBandTint[3] * (uv * uBandW[3]) + uBandTint[4] * (xray * uBandW[4]);
    float window = smoothstep(1.0, 0.75, abs(vEdge.x)) * smoothstep(1.0, 0.75, abs(vEdge.y));
    gl_FragColor = vec4(light * window * uAlpha, 1.0);
}`;

// Rough colour of a spectral line, for the coma's glow (as the sky's comets do it)
function lineColour(nm) {
    if (nm < 440) return [0.35, 0.3, 1.0];
    if (nm < 490) return [0.2, 0.6, 1.0];
    if (nm < 530) return [0.25, 1.0, 0.55];
    if (nm < 575) return [0.6, 1.0, 0.25];
    if (nm < 620) return [1.0, 0.75, 0.2];
    return [1.0, 0.3, 0.2];
}

function gasColour(lines) {
    const sum = [0, 0, 0];
    (lines || []).forEach((line) => {
        const c = lineColour(line.w ?? line.nm ?? line.wavelength_nm ?? 516);
        const seen = (line.rel ?? 1) * ((line.w ?? 516) < 440 ? 0.15 : 1);
        for (let k = 0; k < 3; k++) sum[k] += c[k] * seen;
    });
    const top = Math.max(sum[0], sum[1], sum[2], 0.001);
    return sum.every((v) => v === 0) ? [0.5, 1, 0.7] : sum.map((v) => 0.14 + 0.86 * (v / top));
}

const quad = new THREE.PlaneGeometry(2, 2);
const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

export function createComets(model, mix) {
    const group = new THREE.Group();
    const L = model.luminosity || 1;
    const items = model.comets.map((entry, i) => {
        const { orbit, comet } = entry;
        const path = cometOrbitPoints(orbit, 200);
        const drawn = path.points.map(() => [0, 0, 0]);
        path.points.forEach((p, k) => radialToWorld(model, p, mix, drawn[k]));
        const line = createOrbitLine(drawn, { opacity: 0.22, width: 1.2, trail: 0.8, colour: LINE_COLOUR, u: path.u });
        const block = comet.comet || comet;
        const material = new THREE.ShaderMaterial({
            toneMapped: false,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            vertexShader: VERTEX,
            fragmentShader: FRAGMENT,
            uniforms: {
                ...sharedUniforms,
                uClip: { value: new THREE.Vector4(0, 0, 0, 1) },
                uTail: { value: new THREE.Vector2(1, 0) },
                uReach: { value: new THREE.Vector3(10, 10, 10) },
                uComa: { value: 4 },
                uTailLen: { value: 1 },
                uCurve: { value: 0.5 },
                uDust: { value: block.dust_ratio ?? 0.5 },
                uActive: { value: 0 },
                uHalo: { value: 20 },
                uGas: { value: new THREE.Vector3(...gasColour(block.emission_lines)) },
                uAlpha: { value: 0 },
                uSeed: { value: (i * 0.618 + 0.13) % 1 }
            }
        });
        const glow = new THREE.Mesh(quad, material);
        glow.frustumCulled = false;
        glow.renderOrder = 6;
        group.add(line.object, glow);
        const peak = activity(orbit.q_AU, L);
        const tailMax = block.tail_AU ?? comet.tail_AU ?? comet.tail_length_AU ?? Math.min(2, Math.max(0.05, 0.3 * Math.sqrt(L)));
        return {
            entry, path, drawn, line, material, glow, peak, tailMax,
            state: {}, world: [0, 0, 0], dir: [1, 0, 0], tailWorld: 0, active: 0, own: 0, mixDrawn: mix,
            screen: { ok: false, x: 0, y: 0, coma: 0, tx: 1, ty: 0, len: 0 }
        };
    });

    function place(tDays, mix) {
        items.forEach((item) => {
            const s = cometAt(item.entry.orbit, tDays, item.state);
            radialToWorld(model, [s.x, s.y, s.z], mix, item.world);
            item.active = activity(s.r_AU, L);
            const share = item.peak > 1e-3 ? Math.min(1, item.active / item.peak) : 0;
            const tailAU = item.tailMax * share;
            const along = ringRadius(model, s.r_AU + tailAU, mix) - ringRadius(model, s.r_AU, mix);
            item.tailWorld = Math.max(along, TAIL_LEAST * share);
            if (Math.abs(mix - item.mixDrawn) > 1e-4) {
                item.path.points.forEach((p, k) => radialToWorld(model, p, mix, item.drawn[k]));
                item.line.setPoints(item.drawn);
                item.mixDrawn = mix;
            }
        });
    }

    const viewProj = new THREE.Matrix4();
    const v = new THREE.Vector4();
    const toPx = (out, camera, p, viewport) => {
        v.set(p[0], p[1], p[2], 1).applyMatrix4(viewProj);
        out.w = v.w;
        out.x = (v.x / v.w) * viewport.x * 0.5;
        out.y = (v.y / v.w) * viewport.y * 0.5;
        return out;
    };
    const a = { x: 0, y: 0, w: 1 };
    const b = { x: 0, y: 0, w: 1 };
    const end = [0, 0, 0];

    // ctx = { camera, star: [x, y, z] the brightest star, stage, rate: days per second shown, cap: orbits per second,
    //         tDays, dpr, selected, hover, focused: the code in close-up, focusIndex: this list's index of it or -1 }
    function update(ctx) {
        const { camera, star, stage, dpr } = ctx;
        const viewport = sharedUniforms.uViewport.value;
        viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const f = camera.projectionMatrix.elements[5] * viewport.y * 0.5;     // Device px per unit at depth 1
        const uvOn = sharedUniforms.uBandW.value[3] > 0.002;
        items.forEach((item, i) => {
            const { orbit } = item.entry;
            const u = item.material.uniforms;
            item.own = smooth(ctx.cap * 0.5, ctx.cap, ctx.rate / orbit.period_days);
            const code = item.entry.code;
            const marked = code === ctx.selected || code === ctx.hover;
            const f0 = orbit.phase0 + ctx.tDays / orbit.period_days;
            item.line.set({
                draw: stage.orbits,
                head: item.own > 0 ? 0 : f0 - Math.floor(f0),
                trail: 0.8 * (1 - item.own),
                opacity: (ctx.focused ? 0.6 : 1) * (code === ctx.focused ? 0.3 : marked ? 0.6 : 0.22),
                width: (marked ? 2 : 1.2) * dpr
            });

            const p = item.world;
            toPx(a, camera, p, viewport);
            // While something else is in close-up, this stands back
            const alpha = stage.planets * (1 - item.own) * (ctx.focused && i !== ctx.focusIndex ? 0.35 : 1);
            const sc = item.screen;
            sc.ok = a.w > 1e-6 && alpha > 0.002;
            item.glow.visible = sc.ok;
            if (!sc.ok) return;
            // Away from the star, and back along the orbit for the dust
            const dx = p[0] - star[0];
            const dy = p[1] - star[1];
            const dz = p[2] - star[2];
            const d = Math.hypot(dx, dy, dz) || 1;
            item.dir[0] = dx / d;
            item.dir[1] = dy / d;
            item.dir[2] = dz / d;
            const Lw = item.tailWorld;
            for (let k = 0; k < 3; k++) end[k] = p[k] + item.dir[k] * Math.max(Lw, 1e-6);
            toPx(b, camera, end, viewport);
            let tx = b.x - a.x;
            let ty = b.y - a.y;
            const len = b.w > 1e-6 ? Math.hypot(tx, ty) : 0;
            if (len > 0.5) {
                tx /= len;
                ty /= len;
            } else {
                tx = 1;
                ty = 0;
            }
            const vel = item.state;
            end[0] = p[0] + vel.vx * Math.max(Lw, 1e-6);
            end[1] = p[1] + vel.vy * Math.max(Lw, 1e-6);
            end[2] = p[2] + vel.vz * Math.max(Lw, 1e-6);
            toPx(b, camera, end, viewport);
            const vx = b.x - a.x;
            const vy = b.y - a.y;
            const vl = Math.hypot(vx, vy) || 1;
            const curve = -((vx * -ty + vy * tx) / vl) * 0.8;

            const coma = Math.max((3 + 5 * item.active) * dpr, (COMA_WORLD * f) / a.w);
            const halo = coma * 7 * (0.4 + 0.6 * item.active);
            const reach = Math.max(coma * 3.5, 12 * dpr);
            const wide = uvOn ? halo * 1.25 : 0;
            v.set(p[0], p[1], p[2], 1).applyMatrix4(viewProj);
            u.uClip.value.copy(v);
            u.uTail.value.set(tx, ty);
            u.uReach.value.set(Math.max(reach, wide), Math.max(len * 1.3, reach, wide), Math.max((Math.abs(curve) * 0.8 + 0.3) * len, reach, wide));
            u.uComa.value = coma;
            u.uTailLen.value = len;
            u.uCurve.value = curve;
            u.uActive.value = item.active;
            u.uHalo.value = halo;
            u.uAlpha.value = alpha;
            sc.x = a.x / dpr + viewport.x * 0.5 / dpr;
            sc.y = viewport.y * 0.5 / dpr - a.y / dpr;
            sc.coma = coma / dpr;
            sc.tx = tx;
            sc.ty = -ty;
            sc.len = (len * item.active) / dpr;
        });
    }

    // Nearest comet to a point in CSS px: its head, or anywhere along a tail that's out
    function pick(x, y, radiusPx) {
        let best = null;
        let bestD = radiusPx;
        items.forEach((item) => {
            const sc = item.screen;
            if (!sc.ok || item.own > 0.5) return;
            let d = Math.max(0, Math.hypot(x - sc.x, y - sc.y) - sc.coma);
            if (sc.len > 10) {
                const along = Math.max(0, Math.min(sc.len, (x - sc.x) * sc.tx + (y - sc.y) * sc.ty));
                const off = Math.hypot(x - (sc.x + sc.tx * along), y - (sc.y + sc.ty * along));
                d = Math.min(d, off + 4);
            }
            if (d < bestD) {
                bestD = d;
                best = { code: item.entry.code, d };
            }
        });
        return best;
    }

    return {
        group,
        items,
        place,
        update,
        pick,
        dispose() {
            items.forEach((item) => {
                item.line.dispose();
                item.material.dispose();
            });
        }
    };
}
