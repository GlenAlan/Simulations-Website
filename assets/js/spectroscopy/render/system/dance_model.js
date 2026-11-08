// The system view's side of a young multiple in no stable orbit (data/unstable.js): the clock's range, how big its stars are
// drawn, where they have been, and how much to hold the clock back so that nothing flashes. Plain maths, so it runs under Node.
//
// Its stars have no orbits to draw or to smear, so they are drawn with trails behind them instead, and the clock is never so
// fast that they would smear: what keeps the flash rule is that a disc big enough on screen to matter never sweeps across it
// faster than SWEEP_PER_S of its own width a second, and that when the camera rides with one star, what's round it never swings
// past faster than TURNS_PER_S. danceGovernor says how much to slow the clock for that, frame by frame.

import { danceMotion, danceAccelerations, danceTimescale, danceCentreAU } from '../../data/unstable.js';

const BREAK_UP_S = 45;            // At the top speed, the first star leaves within this many seconds
const SECONDS_PER_CROSSING = 8;   // The speed it opens at: about one crossing of the group in this long
const REDUCED_CROSSING_S = 40;    // With Reduce motion, the most it goes
const STAR_SHARE = 0.03;          // Its stars are drawn no bigger than this share of the view's half-width...
const SWEEP_PER_S = 1.2;          // ... and a big one never crosses more than this many of its own widths a second...
const BIG_PX = [24, 48];          // ... where big means a radius in this range of pixels, or more
const TURNS_PER_S = 0.6;          // Riding with a star, the rest swings round no faster than this
const TRAIL_CROSSINGS = 1;        // A trail is where each star has been over this many crossing times

export function isDance(model) {
    return !!(model && model.body && model.body.unstable);
}

// The clock's range in days per second, as speedsFor gives it for any system
export function danceSpeeds(model, reduceMotion = false) {
    const body = model.body;
    const tcr = danceTimescale(body);
    const top = Math.max(tcr / 2, body.chaos.eject_days / BREAK_UP_S);
    const max = reduceMotion ? tcr / REDUCED_CROSSING_S : top;
    return { min: tcr / 400, max, speed: Math.min(max, tcr / SECONDS_PER_CROSSING) };
}

// The largest a star may be drawn, in world units, given the view's half-width (system_model.js FRAME)
export function danceStarCap(frame) {
    return STAR_SHARE * frame;
}

// How far back the trails reach, in days
export function trailDays(model) {
    return TRAIL_CROSSINGS * danceTimescale(model.body);
}

// Where every star is at tDays, in world axes and units: [x, y, z] for each. A state's (x, y, z) in AU is world (x, z, -y).
export function danceWorld(model, tDays, out = null) {
    const { x } = danceMotion(model.body, tDays);
    const n = model.stars.length;
    const o = out || Array.from({ length: n }, () => [0, 0, 0]);
    const k = model.unit;
    for (let i = 0; i < n; i++) {
        o[i][0] = x[3 * i] * k;
        o[i][1] = x[3 * i + 2] * k;
        o[i][2] = -x[3 * i + 1] * k;
    }
    return o;
}

// The view's middle in world units: the stars that stay, once one has been thrown out (data/unstable.js danceCentreAU)
export function danceCentreWorld(model, tDays) {
    const c = danceCentreAU(model.body, tDays);
    const k = model.unit;
    return [c[0] * k, c[2] * k, -c[1] * k];
}

// Moves a layout (system_model.js) so that its middle is the stars that stay: those thrown out go off, the rest stay in view
export function recentreLayout(model, tDays, o) {
    const c = danceCentreWorld(model, tDays);
    const move = (p) => {
        p[0] -= c[0];
        p[1] -= c[1];
        p[2] -= c[2];
    };
    o.stars.forEach(move);
    o.nodes.forEach(move);
    return o;
}

function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

// How much the clock may run this frame, from 0 to 1, at speed days per second. view: { radii: drawn radius of each star in
// world units, px: each one's radius in pixels, target: the index of the star the camera rides with, or -1 }.
export function danceGovernor(model, tDays, speed, view) {
    if (!(speed > 0)) return 1;
    const body = model.body;
    const { v } = danceMotion(body, tDays);
    const n = model.stars.length;
    const k = model.unit;
    const t = view.target;
    const vel = (i) => [v[3 * i] * k, v[3 * i + 2] * k, -v[3 * i + 1] * k];
    const ride = t >= 0 ? vel(t) : [0, 0, 0];
    let g = 1;
    for (let i = 0; i < n; i++) {
        if (i === t) continue;
        const big = smoothstep(BIG_PX[0], BIG_PX[1], view.px[i]);
        if (big <= 0) continue;
        const w = vel(i);
        const across = Math.hypot(w[0] - ride[0], w[1] - ride[1], w[2] - ride[2]) / (2 * Math.max(view.radii[i], 1e-9));
        // Widths a day; slowed in proportion to how big it is, so that nothing jumps as a disc grows
        const allowed = SWEEP_PER_S / (across * speed);
        g = Math.min(g, 1 - big + big * Math.min(1, allowed));
    }
    if (t >= 0) {
        // Riding with a star, everything else turns round as fast as its path bends
        const a = danceAccelerations(body, tDays);
        const vt = [v[3 * t], v[3 * t + 1], v[3 * t + 2]];
        const at = [a[3 * t], a[3 * t + 1], a[3 * t + 2]];
        const s2 = vt[0] * vt[0] + vt[1] * vt[1] + vt[2] * vt[2];
        if (s2 > 0) {
            const c = [vt[1] * at[2] - vt[2] * at[1], vt[2] * at[0] - vt[0] * at[2], vt[0] * at[1] - vt[1] * at[0]];
            const turnPerDay = Math.hypot(c[0], c[1], c[2]) / s2;
            g = Math.min(g, (2 * Math.PI * TURNS_PER_S) / (turnPerDay * speed));
        }
    }
    return Math.max(0.001, Math.min(1, g));
}
