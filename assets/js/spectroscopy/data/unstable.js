// Young multiple stars that are not in stable orbits: three or four massive stars a few hundred AU apart, born together in a
// star-forming nebula, swinging round one another with no pattern, as in the Orion Trapezium. They are possible now but they
// can't last: within some tens of crossing times one star, usually the lightest, is flung out, and what it leaves behind
// settles into a pair. Every other multiple star in the sky is in a stable hierarchy (data/dynamics.js).
//
// Made last of all, from a stream and codes of their own, so nothing else in the sky changes. Each is a multi-star body
// (data/multi.js) with:
//   architecture 'non_hierarchical', unstable: true, orbits: [] (there are none to list), deep: true (data/sky_layout.js)
//   chaos { seed      the seed its dance is found from, when first needed (danceOf and danceInfo, below)
//           inc_deg   the line of sight: away from us is (0, sin i, -cos i), as for the widest orbit of any other system
//           host      the nebula it is in or by }
// Its stars' places and speeds come from the integration (componentStates in data/orbits.js reads danceStates here), so the
// system view, the sky and the spectrum all show the same motion.

import { Rng, stable } from '../core/rng.js';
import { fluxFromLuminosity } from '../core/phys.js';
import { MIN_ALT, azAltToVec3, vec3ToAzAlt } from '../core/sky.js';
import { DEPTH_TABLE } from '../core/depth.js';
import { dp, dpAz, RSUN_AU, starFromMass, makeComposition, msLifetimeMyr, apparentMag } from './stellar.js';
import { systemAbsoluteMag, systemLuminosity, fillComponentFields } from './multi.js';
import { deepSpacingDeg, DEEP_CLEAR_DEG } from './sky_layout.js';
import { rocheShare } from './dynamics.js';
import { G_DAY, KMS_PER_AU_DAY, integrate, readRun, decompose, unitStable, totalEnergy, accelerationsAt } from './nbody.js';
import { UNSTABLE_MULTIPLES } from './quotas.js';

export const UNSTABLE_ARCH = 'non_hierarchical';

const RAD = Math.PI / 180;
const AGE_MYR = [0.5, 2.5];
const PRIMARY_MSUN = [8, 20];
const PARTNER_SHARE = [0.25, 0.8];        // Of the heaviest star's mass
const START_AU = [25, 70];                // The radius of the ball the stars start in
const START_APART = 0.5;                  // No two closer than this share of it: no pair is singled out at the start
const VIRIAL = [0.15, 0.35];                // Their motion's energy over their gravity's: under 1/2, so they fall together
const ETA = 0.05;
const NEAR_MISS = 2;                      // No two ever pass closer than this many of their radii added
const MAX_DRIFT = 1e-3;                   // The integration keeps the total energy to this share
const SOFTEN = 0.05;                      // Softening, as a share of the closest pair's radii added
const AHEAD_TCR = [5, 40];                // Today is this many crossing times before the first star leaves
const PAST_TCR = 1.5;                     // ... with at least this much of the dance behind it
const CAP_TCR = { 3: 50, 4: 70 };         // How long a start is followed for, to see whether it suits...
const STEP_BUDGET = { 3: 20000, 4: 36000 }; // ... and in how many steps at most, as it is done while the page loads
const LEFT_RV = 3;                        // A star has left once this many virial radii from the middle of the others
const COMPACT_RV = 2.5;                   // Today, every star is within this many virial radii of the middle
const TRIES = 120;
const TODAY_TRIES = 8;
const SEP_DEG = [0.035, 0.055];           // How far apart the sky draws them, at most (stylised, as for any multiple)
const HOST_RADIUS_DEG = 1.35;             // A nebula drawn at least this big can hold one inside it
const RV_SPREAD_KMS = 3;                  // Moving with the gas it was born in
const DEPTH_SPREAD = 0.03;                // As far away as its nebula, give or take

export function isUnstable(body) {
    return !!(body && body.unstable);
}

// The least mass a star can have and already be on the main sequence at this age: lighter stars are still contracting
// (Iben 1965, about 0.6 million years for 5 solar masses, going as M^-2.5)
export function zeroAgeMass(ageMyr) {
    return stable(5 * (ageMyr / 0.58) ** -0.4, 4);
}

// ---------- Vectors, with nothing but arithmetic and square roots ----------

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a) => scale(a, 1 / Math.sqrt(dot(a, a)));

// A point in the unit ball, by rejection, so that no trigonometry or cube root is needed
function inBall(rng) {
    for (;;) {
        const p = [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)];
        const d2 = dot(p, p);
        if (d2 <= 1 && d2 > 1e-4) return p;
    }
}

function toCentre(list, masses) {
    const M = masses.reduce((a, b) => a + b, 0);
    const c = [0, 1, 2].map((k) => list.reduce((sum, p, i) => sum + masses[i] * p[k], 0) / M);
    return list.map((p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
}

const flat = (list) => list.flatMap((p) => p);

// ---------- The dance, found the first time it is needed ----------
// Finding a start that suits (findDance, below) means following trial starts until one does: some tens of milliseconds a
// system. So it isn't done while the sky is made, but the first time anything needs these stars' places: the system is chosen,
// zoomed into or checked. It comes from the system's own seed (chaos.seed), so it is the same whenever and wherever it is found.
// A dance: { info, start, run, ... }, where info holds what the search chose:
//   x_AU, v_AU_day   where each star starts, and how fast: [[x, y, z], ...] in the stars' order
//   today_days       how long after that start today is
//   eta, eps_AU      the integration's step and softening (data/nbody.js)
//   virial_AU, crossing_days   the virial radius, G M^2 / (-2E), and the crossing time, G M^(5/2) / (-2E)^(3/2)
//   eject_days       how long after today the first star leaves the others for good
//   escapers         the codes of the stars that leave, first to leave first; the heaviest part left behind stays

const dances = new WeakMap();
const listeners = new Set();

function massesOf(body) {
    return body.stars.map((s) => s.star.mass_Msun);
}

function radiiOf(body) {
    return body.stars.map((s) => s.star.radius_Rsun * RSUN_AU);
}

function runFrom(masses, radii, x, v, info, maxT) {
    return integrate(masses, x, v, maxT, {
        eta: info.eta,
        eps: info.eps_AU,
        radii,
        outAU: LEFT_RV * info.virial_AU,
        giveUpAt: 0
    });
}

// Long enough for any start that was chosen to have ended its dance
function capOf(body, info) {
    return 4 * (CAP_TCR[body.stars.length] || 70) * info.crossing_days;
}

function search(body) {
    const made = findDance(new Rng(body.chaos.seed), body.stars.map((s) => s.star));
    if (!made) throw new Error(`No unstable start suited ${body.code}`);
    const c = made.chaos;
    const info = { ...c, escapers: c.leavers.map((k) => body.stars[k].code) };
    delete info.leavers;
    return { info, start: { masses: massesOf(body), x: flat(c.x_AU), v: flat(c.v_AU_day) }, run: made.run, back: null, n: body.stars.length, memo: [] };
}

// Hears of each system whose dance has just been found: fn(body). Returns a function that stops it.
export function onDance(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

// Has this system's dance been found yet? Something drawing it without needing it can wait for onDance.
export function danceReady(body) {
    return dances.has(body);
}

// The dance, found once. fresh: found again from the seed, for validation to compare with the one kept.
export function danceOf(body, { fresh = false } = {}) {
    if (fresh) return search(body);
    let dance = dances.get(body);
    if (!dance) {
        dance = search(body);
        dances.set(body, dance);
        listeners.forEach((fn) => fn(body));
    }
    return dance;
}

// What the search chose (see above)
export function danceInfo(body) {
    return danceOf(body).info;
}

// The same stars with every speed reversed: the time before the start, only if anything asks for it
function backRun(body, dance) {
    if (!dance.back) {
        const v = dance.start.v.map((q) => -q);
        dance.back = runFrom(dance.start.masses, radiiOf(body), dance.start.x, v, dance.info, capOf(body, dance.info));
    }
    return dance.back;
}

// Where every star is, and how fast, tDays after today: { x, v } in AU and AU per day, 3 numbers a star
export function danceMotion(body, tDays) {
    const dance = danceOf(body);
    const memo = dance.memo.find((m) => m.t === tDays);
    if (memo) return memo;
    const runT = dance.info.today_days + tDays;
    const x = new Float64Array(3 * dance.n);
    const v = new Float64Array(3 * dance.n);
    if (runT >= 0) {
        readRun(dance.run, runT, x, v);
    } else {
        readRun(backRun(body, dance), -runT, x, v);
        for (let i = 0; i < v.length; i++) v[i] = -v[i];
    }
    const out = { t: tDays, x, v };
    dance.memo.unshift(out);
    if (dance.memo.length > 6) dance.memo.pop();
    return out;
}

// As componentStates gives any system: places in AU and the speed along the line of sight, positive away from us
export function danceStates(body, tDays) {
    const { x, v } = danceMotion(body, tDays);
    const i = body.chaos.inc_deg * RAD;
    const s = Math.sin(i);
    const c = Math.cos(i);
    return body.stars.map((star, k) => ({
        code: star.code,
        x_AU: x[3 * k],
        y_AU: x[3 * k + 1],
        z_AU: x[3 * k + 2],
        vlos_kms: (v[3 * k + 1] * s - v[3 * k + 2] * c) * KMS_PER_AU_DAY
    }));
}

// The middle of the stars that stay, for a view to centre on, in AU: the centre of mass until a star is thrown out, then moving
// smoothly over to the centre of mass of those left behind, as they recoil the other way
const SETTLE_TCR = 4;
export function danceCentreAU(body, tDays) {
    const dance = danceOf(body);
    const { x } = danceMotion(body, tDays);
    const chaos = dance.info;
    const runT = chaos.today_days + tDays;
    let mass = 0;
    const c = [0, 0, 0];
    body.stars.forEach((s, i) => {
        let w = 1;
        if (chaos.escapers.includes(s.code)) {
            const f = Math.max(0, Math.min(1, (runT - leftTime(dance.run, i)) / (SETTLE_TCR * chaos.crossing_days)));
            w = 1 - f * f * (3 - 2 * f);
        }
        const m = s.star.mass_Msun * w;
        mass += m;
        c[0] += m * x[3 * i];
        c[1] += m * x[3 * i + 1];
        c[2] += m * x[3 * i + 2];
    });
    return [c[0] / mass, c[1] / mass, c[2] / mass];
}

// The stars that stay once the last star to leave has gone, and how far out they go round their own middle on the orbits they
// are left in: { stay (their indices), leftDays (the time, as tDays, when the last to go left them), settledDays (by when the
// middle has moved over to them: see danceCentreAU), reachAU, orbits: [{ a, b (star indices of its two sides), period_days }] },
// or null if no star is thrown out. Found once, from the integration's own two-body ending.
const BOUND_SPAN_TCR = 30;      // Looked at over this many crossing times after the dance ends...
const BOUND_SAMPLES = 1200;     // ... at this many moments, so that the widest swing is caught to within a percent or so
export function danceBound(body) {
    const dance = danceOf(body);
    if (dance.bound !== undefined) return dance.bound;
    const chaos = dance.info;
    const { run } = dance;
    const all = body.stars.map((s, i) => i);
    const going = all.filter((i) => chaos.escapers.includes(body.stars[i].code));
    const stay = all.filter((i) => !going.includes(i));
    if (!going.length || !stay.length || !run.tree) {
        dance.bound = null;
        return null;
    }
    const left = Math.max(...going.map((i) => leftTime(run, i)));
    const masses = massesOf(body);
    const mass = stay.reduce((sum, i) => sum + masses[i], 0);
    const x = new Float64Array(3 * dance.n);
    const v = new Float64Array(3 * dance.n);
    const from = Math.max(run.end, left);
    const span = BOUND_SPAN_TCR * chaos.crossing_days;
    let reach = 0;
    for (let k = 0; k < BOUND_SAMPLES; k++) {
        readRun(run, from + (span * (k + 0.5)) / BOUND_SAMPLES, x, v);
        const c = [0, 1, 2].map((q) => stay.reduce((sum, i) => sum + masses[i] * x[3 * i + q], 0) / mass);
        stay.forEach((i) => {
            reach = Math.max(reach, Math.hypot(x[3 * i] - c[0], x[3 * i + 1] - c[1], x[3 * i + 2] - c[2]));
        });
    }
    // The orbits they are left in: every bound node of the ending's two-body tree that holds only stars that stay
    const orbits = [];
    const membersOf = (node) => (node.leaf !== undefined ? [node.leaf] : [...membersOf(node.a), ...membersOf(node.b)]);
    const walk = (node) => {
        if (node.leaf !== undefined) return;
        const a = membersOf(node.a);
        const b = membersOf(node.b);
        const r = Math.hypot(node.r[0], node.r[1], node.r[2]);
        const energy = (node.v[0] ** 2 + node.v[1] ** 2 + node.v[2] ** 2) / 2 - node.mu / r;
        if (energy < 0 && [...a, ...b].every((i) => stay.includes(i))) {
            const semi = -node.mu / (2 * energy);
            orbits.push({ a, b, period_days: 2 * Math.PI * Math.sqrt(semi ** 3 / node.mu) });
        }
        walk(node.a);
        walk(node.b);
    };
    (run.tree.roots || run.tree.straight.map((part) => part.node)).forEach(walk);
    dance.bound = {
        stay,
        leftDays: left - chaos.today_days,
        settledDays: left + SETTLE_TCR * chaos.crossing_days - chaos.today_days,
        reachAU: reach,
        orbits
    };
    return dance.bound;
}

// How hard each star is being pulled just now (AU per day per day), for how sharply it turns
export function danceAccelerations(body, tDays) {
    const { x } = danceMotion(body, tDays);
    return accelerationsAt(massesOf(body), x, danceInfo(body).eps_AU);
}

// The time over which the stars' lines swing: the crossing time, in days. Clocks, tools and the view pace themselves on it.
export function danceTimescale(body) {
    return danceInfo(body).crossing_days;
}

// How far out the stars go while they dance, from a crossing time before today to when the first leaves, in AU: as far as the
// furthest star is most of that time. Now and then one swings out further, and comes back.
const REACH_SHARE = 0.85;
export function danceReachAU(body) {
    const dance = danceOf(body);
    if (dance.reach) return dance.reach;
    const chaos = dance.info;
    const from = chaos.today_days - chaos.crossing_days;
    const to = chaos.today_days + chaos.eject_days;
    const { run } = dance;
    const n3 = 3 * dance.n;
    // Each kept moment counts for the time until the next: they come thick and fast in a close pass
    const furthest = [];
    let total = 0;
    for (let k = 0; k + 1 < run.times.length; k++) {
        const t = run.times[k];
        if (t < from || t > to) continue;
        let r = 0;
        for (let i = 0; i < n3; i += 3) {
            const o = k * 2 * n3 + i;
            r = Math.max(r, Math.sqrt(run.states[o] ** 2 + run.states[o + 1] ** 2 + run.states[o + 2] ** 2));
        }
        const dt = run.times[k + 1] - t;
        furthest.push([r, dt]);
        total += dt;
    }
    furthest.sort((a, b) => a[0] - b[0]);
    let reach = chaos.virial_AU;
    for (let k = 0, sum = 0; k < furthest.length; k++) {
        sum += furthest[k][1];
        reach = furthest[k][0];
        if (sum >= REACH_SHARE * total) break;
    }
    dance.reach = reach;
    return dance.reach;
}

// What the panel says about it, from the integration: { years until one is flung out, crossing time in years, which went }
export function danceFacts(body) {
    const chaos = danceInfo(body);
    const light = body.stars.reduce((best, s) => (s.star.mass_Msun < best.star.mass_Msun ? s : best), body.stars[0]);
    return {
        ejectYears: chaos.eject_days / 365.25,
        crossingYears: chaos.crossing_days / 365.25,
        escapers: chaos.escapers.slice(),
        lightestOut: chaos.escapers.includes(light.code)
    };
}

// ---------- Is it really unstable now? ----------

// The present moment, tried as data/dynamics.js tries every other system: find the pair most tightly bound, then what
// circles it, and ask whether Mardling and Aarseth's limit holds. { stable, units } where units is the breakdown into
// two-body orbits (data/nbody.js decompose).
export function presentHierarchy(body) {
    const { x, v } = danceMotion(body, 0);
    const units = decompose(body.stars.length, massesOf(body), x, v);
    return { stable: units.length === 1 && unitStable(units[0], 1), units };
}

// ---------- Making them ----------

// Stars of one age, all massive enough to be on the main sequence already, heaviest first
function makeStars(rng, n) {
    const age = dp(rng.range(AGE_MYR[0], AGE_MYR[1]), 3);
    const least = stable(zeroAgeMass(age) * 1.05, 4);
    const top = stable(Math.max(rng.logRange(PRIMARY_MSUN[0], PRIMARY_MSUN[1]), least / PARTNER_SHARE[1]), 4);
    const masses = [top];
    for (let i = 1; i < n; i++) masses.push(stable(Math.max(least, top * rng.range(PARTNER_SHARE[0], PARTNER_SHARE[1])), 4));
    masses.sort((a, b) => b - a);
    const composition = makeComposition(rng, 'I');
    return masses.map((m) => starFromMass(rng, m, { composition, age, aged: Math.min(1, age / msLifetimeMyr(m)) }));
}

// A start: places in a ball, none too close, and speeds in random directions scaled to the virial ratio q, about the centre
// of mass, turned so that the stars' total spin is about +z
function drawStart(rng, masses, radiusAU, q) {
    const n = masses.length;
    let x;
    for (;;) {
        x = masses.map(() => scale(inBall(rng), radiusAU));
        let apart = true;
        for (let i = 0; i < n && apart; i++) {
            for (let j = i + 1; j < n && apart; j++) {
                const d = [x[j][0] - x[i][0], x[j][1] - x[i][1], x[j][2] - x[i][2]];
                apart = dot(d, d) >= (START_APART * radiusAU) ** 2;
            }
        }
        if (apart) break;
    }
    x = toCentre(x, masses);
    let v = toCentre(masses.map(() => scale(norm(inBall(rng)), rng.range(0.3, 1))), masses);
    const energy = totalEnergy(masses, flat(x), flat(v));
    const k = Math.sqrt((q * -energy.potential) / energy.kinetic);
    v = v.map((p) => scale(p, k));
    // Spin axis to +z
    const spin = x.reduce((sum, p, i) => {
        const l = cross(p, v[i]);
        return [sum[0] + masses[i] * l[0], sum[1] + masses[i] * l[1], sum[2] + masses[i] * l[2]];
    }, [0, 0, 0]);
    if (dot(spin, spin) > 0) {
        const e3 = norm(spin);
        const e1 = norm(cross(Math.abs(e3[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], e3));
        const e2 = cross(e3, e1);
        const turn = (p) => [dot(p, e1), dot(p, e2), dot(p, e3)];
        x = x.map(turn);
        v = v.map(turn);
    }
    return { x, v };
}

// Is this moment one that could be today: every star still among the others, nothing in a stable hierarchy, no star touching
// another or overfilling its Roche lobe?
function suitsToday(stars, masses, x, v, virialAU) {
    const n = masses.length;
    for (let i = 0; i < n; i++) {
        const r = Math.sqrt(x[3 * i] ** 2 + x[3 * i + 1] ** 2 + x[3 * i + 2] ** 2);
        if (r > COMPACT_RV * virialAU) return false;
    }
    if (presentProblems(stars, masses, x).length) return false;
    const units = decompose(n, masses, x, v);
    return !(units.length === 1 && unitStable(units[0], 1));
}

// Stars touching, or a star overfilling its Roche lobe towards another, at these places
function presentProblems(stars, masses, x) {
    const out = [];
    const n = masses.length;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const d = Math.sqrt((x[3 * j] - x[3 * i]) ** 2 + (x[3 * j + 1] - x[3 * i + 1]) ** 2 + (x[3 * j + 2] - x[3 * i + 2]) ** 2);
            const ri = stars[i].star.radius_Rsun * RSUN_AU;
            const rj = stars[j].star.radius_Rsun * RSUN_AU;
            if (d <= ri + rj) out.push(`${stars[i].code} and ${stars[j].code} touch`);
            if (ri >= rocheShare(masses[i] / masses[j]) * d) out.push(`${stars[i].code} overfills its Roche lobe towards ${stars[j].code}`);
            if (rj >= rocheShare(masses[j] / masses[i]) * d) out.push(`${stars[j].code} overfills its Roche lobe towards ${stars[i].code}`);
        }
    }
    return out;
}

// The crossing time and virial radius of a start, from its energy: arithmetic and square roots only
function scalesOf(masses, x, v) {
    const M = masses.reduce((a, b) => a + b, 0);
    const E = totalEnergy(masses, x, v).total;
    const twoE = -2 * E;
    return { crossing: (G_DAY * M * M * Math.sqrt(M)) / (twoE * Math.sqrt(twoE)), virial: (G_DAY * M * M) / twoE, E };
}

// How far the total energy has wandered by the end of a run, as a share of it
function energyDrift(run, masses, x, v) {
    const n6 = 6 * masses.length;
    const last = run.states.subarray(run.states.length - n6);
    const before = totalEnergy(masses, x, v).total;
    return Math.abs(totalEnergy(masses, last.subarray(0, n6 / 2), last.subarray(n6 / 2)).total / before - 1);
}

// When a star left the others for good (run time): when it last went out past them, or the end of the dance if it was still
// close by then
function leftTime(run, i) {
    return run.leftAt[i] === null ? run.end : run.leftAt[i];
}

// Who leaves, once the dance is over: every star but those in its heaviest part, which stays. { stars: those that leave,
// first to go first, at: when the first star thrown out on its own left }, or null if the dance hasn't ended or no star is
// thrown out on its own.
function firstLeaver(run, masses) {
    if (!run.final) return null;
    const mass = (part) => part.reduce((m, i) => m + masses[i], 0);
    const stay = run.parts.reduce((best, p) => (mass(p) > mass(best) ? p : best), run.parts[0]);
    const going = run.parts.filter((p) => p !== stay);
    const singles = going.filter((p) => p.length === 1).map((p) => p[0]).filter((i) => run.leftAt[i] !== null);
    if (!singles.length) return null;
    const stars = going.flat().sort((a, b) => leftTime(run, a) - leftTime(run, b) || a - b);
    return { stars, at: Math.min(...singles.map((i) => run.leftAt[i])) };
}

// One system's stars, start and today: tried until one suits. Later tries ask less, so that one always comes.
function findDance(rng, stars) {
    const masses = stars.map((s) => s.mass_Msun);
    const radii = stars.map((s) => s.radius_Rsun * RSUN_AU);
    const n = masses.length;
    let tightest = Infinity;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) tightest = Math.min(tightest, radii[i] + radii[j]);
    const parts = stars.map((star) => ({ star }));
    let best = null;
    for (let attempt = 0; attempt < TRIES; attempt++) {
        const relaxed = attempt >= TRIES / 2;
        const r = rng.fork(`start:${attempt}`);
        const radiusAU = stable(r.logRange(START_AU[0], START_AU[1]), 5);
        const q = dp(r.range(VIRIAL[0], VIRIAL[1]), 4);
        const start = drawStart(r, masses, radiusAU, q);
        const x = flat(start.x);
        const v = flat(start.v);
        const { crossing, virial } = scalesOf(masses, x, v);
        const chaos = { eta: ETA, eps_AU: stable(SOFTEN * tightest, 4), virial_AU: virial };
        const run = integrate(masses, x, v, (relaxed ? 2 : 1) * (CAP_TCR[n] || 70) * crossing, {
            eta: chaos.eta, eps: chaos.eps_AU, radii, outAU: LEFT_RV * virial, giveUpAt: NEAR_MISS,
            maxSteps: (relaxed ? 4 : 1) * (STEP_BUDGET[n] || 40000)
        });
        // Two stars that would touch, no star flung out in the time, the integration not good enough, or a star flung out too
        // soon after the start
        if (run.closest < NEAR_MISS) continue;
        const leaver = firstLeaver(run, masses);
        if (!leaver || energyDrift(run, masses, x, v) > MAX_DRIFT) continue;
        const ahead = [AHEAD_TCR[0] * (relaxed ? 0.5 : 1), AHEAD_TCR[1]];
        const room = leaver.at / crossing - PAST_TCR * (relaxed ? 0.5 : 1);
        if (room < ahead[0]) continue;
        const xs = new Float64Array(3 * n);
        const vs = new Float64Array(3 * n);
        for (let k = 0; k < TODAY_TRIES; k++) {
            const tau = r.range(ahead[0], Math.min(ahead[1], room));
            const today = dp(leaver.at - tau * crossing, 3);
            readRun(run, today, xs, vs);
            if (!suitsToday(parts, masses, xs, vs, virial)) continue;
            best = {
                start, run, radiusAU,
                chaos: {
                    x_AU: start.x,
                    v_AU_day: start.v,
                    today_days: today,
                    eta: chaos.eta,
                    eps_AU: chaos.eps_AU,
                    virial_AU: virial,
                    crossing_days: crossing,
                    eject_days: leaver.at - today,
                    leavers: leaver.stars
                }
            };
            break;
        }
        if (best) break;
    }
    return best;
}

// ---------- Where they are ----------

// Each emission nebula's radius as the sky draws it: shrunk by its depth among the first sky's nebulae (core/depth.js)
function drawnRadii(sky) {
    const nebulae = sky.filter((b) => b.kind === 'nebula' && !b.deep).sort((a, b) => a.distance_pc - b.distance_pc || (a.code < b.code ? -1 : 1));
    const last = Math.max(1, nebulae.length - 1);
    const row = DEPTH_TABLE.nebula;
    const out = new Map();
    nebulae.forEach((b, i) => {
        const depth = row.near + ((row.far - row.near) * i) / last;
        out.set(b, (b.nebula.size_deg / 2) * (1 - row.kSize * depth));
    });
    return out;
}

function tooClose(dotValue, threshold) {
    return dotValue > threshold - 1e-7 && Math.round(dotValue * 1e9) > Math.round(threshold * 1e9);
}

// Inside its nebula's glow where there is room, clear of everything else by the deeper sky's spacing (data/sky_layout.js),
// out of any other extended object and out of the space kept round the target. Puts it in the layout for whatever comes next.
function placeBy(rng, body, host, hostRadius, layout) {
    const spacing = deepSpacingDeg(body);
    const a = azAltToVec3(host.sky.az, host.sky.alt);
    const ref = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const e1 = norm(cross(a, ref));
    const e2 = cross(a, e1);
    const fits = (v) => layout.placed.every((other) => {
        let need = other.deep ? Math.min(spacing, other.spacing || spacing) : Math.max(spacing, DEEP_CLEAR_DEG);
        need *= 1.02;
        if (other.entry.body !== host && other.radius > 0) need = Math.max(need, other.radius + 0.1);
        if (other.clear > 0) need = Math.max(need, other.clear);
        return !tooClose(v[0] * other.v[0] + v[1] * other.v[1] + v[2] * other.v[2], Math.cos(need * RAD));
    });
    const inner = Math.max(spacing, DEEP_CLEAR_DEG) * 1.05;
    const rings = [[inner, Math.max(inner, 0.75 * hostRadius)], [inner, inner + 1.5], [inner, inner + 6]];
    for (const [lo, hi] of rings) {
        for (let tries = 0; tries < 400; tries++) {
            const sep = dp(rng.range(lo, hi), 4) * RAD;
            const angle = rng.range(0, 2 * Math.PI);
            const s = Math.sin(sep);
            const c = Math.cos(sep);
            const p = vec3ToAzAlt(...[0, 1, 2].map((k) => c * a[k] + s * (Math.cos(angle) * e1[k] + Math.sin(angle) * e2[k])));
            const az = dpAz(p.az, 3);
            const alt = dp(p.alt, 3);
            if (alt < MIN_ALT + 0.3) continue;
            const v = azAltToVec3(az, alt);
            if (!fits(v)) continue;
            body.sky = { az, alt };
            layout.placed.push({ entry: { body }, v, radius: 0, deep: true, spacing, clear: 0 });
            return true;
        }
    }
    return false;                                   // Validation would report it; it doesn't happen
}

// ---------- The sky's unstable multiples ----------

// Makes them, places them and gives them their codes. base(code) is a new multi-star body; layout is the sky's, so far; sky
// is every body made so far, to find the nebulae.
//
// The four-star ones come first, then the triples, each from a stream of its own kind and number, with hosts from opposite
// ends of one shuffled list of nebulae. So raising the number of triples in data/quotas.js adds new ones after the rest, and
// every one already there keeps its code, stars, motion, nebula and place.
export function makeUnstableMultiples(rng, nextCode, base, layout, sky) {
    const radii = drawnRadii(sky);
    const nebulae = sky.filter((b) => b.kind === 'nebula' && b.nebula.type === 'emission').sort((a, b) => (a.code < b.code ? -1 : 1));
    const roomy = rng.fork('hosts').shuffle(nebulae.filter((b) => (radii.get(b) || 0) >= HOST_RADIUS_DEG));
    const rest = rng.fork('other hosts').shuffle(nebulae.filter((b) => !((radii.get(b) || 0) >= HOST_RADIUS_DEG)));
    // Nebulae big enough to hold one, if there are any; any star-forming nebula if not
    const pool = roomy.length ? roomy : rest;
    const plan = [
        ...Array.from({ length: UNSTABLE_MULTIPLES.quadruples }, (_, k) => ({ n: 4, name: `quadruple:${k}`, host: pool[(pool.length - 1 - (k % pool.length))] })),
        ...Array.from({ length: UNSTABLE_MULTIPLES.triples }, (_, k) => ({ n: 3, name: `triple:${k}`, host: pool[k % pool.length] }))
    ];
    return plan.map(({ n, name, host }) => {
        const r = rng.fork(name);
        const body = base(nextCode());
        const stars = makeStars(r.fork('stars'), n);
        const danceSeed = r.fork('dance').state;
        const components = stars.map((star) => {
            const code = nextCode();
            return { code, kind: 'star_component', parent: body.code, star, visual_seed: code };
        });
        Object.assign(body, {
            kind: 'multiple',
            architecture: UNSTABLE_ARCH,
            unstable: true,
            stars: components,
            orbits: [],
            interacting: false,
            transfer: null,
            figure_eight: null,
            pairs: null,
            visual_sep_deg: dp(r.range(SEP_DEG[0], SEP_DEG[1]), 3),
            planets: [],
            deep: true
        });
        // The dance itself is found from this seed when first needed (danceOf, above)
        body.chaos = {
            seed: danceSeed,
            inc_deg: dp(Math.acos(r.range(0, 1)) / RAD, 2),
            host: host.code
        };
        // As far away as the gas it was born in, and moving with it. Rounding can carry a distance drawn right at the edge of
        // that a hair beyond it: then it is kept just inside. No other distance changes.
        let distance = stable(host.distance_pc * r.range(1 - DEPTH_SPREAD, 1 + DEPTH_SPREAD), 5);
        const off = distance / host.distance_pc - 1;
        if (Math.abs(off) > DEPTH_SPREAD) distance = stable(host.distance_pc * (1 + Math.sign(off) * DEPTH_SPREAD * 0.999), 5);
        body.distance_pc = distance;
        body.radial_velocity_kms = dp(host.radial_velocity_kms + r.range(-RV_SPREAD_KMS, RV_SPREAD_KMS), 1);
        body.brightness = {
            flux_Wm2: stable(fluxFromLuminosity(systemLuminosity(components), distance), 6),
            mag: apparentMag(systemAbsoluteMag(components), distance)
        };
        fillComponentFields(body, (l, d) => stable(fluxFromLuminosity(l, d), 6));
        placeBy(r.fork('sky'), body, host, radii.get(host) || 0, layout);
        return body;
    });
}

// ---------- Checks, for data/validate.js ----------

// Everything that would make one of these impossible now, or not what it says it is, in plain words. u is the universe, for
// its host. Its one failure of data/dynamics.js systemProblems, the hierarchy test, is meant: the rest of that must pass too.
export function unstableProblems(body, u) {
    const out = [];
    const fail = (message) => out.push(`${body.code} ${message}`);
    if (body.kind !== 'multiple' || body.architecture !== UNSTABLE_ARCH) fail(`is a ${body.kind} '${body.architecture}'`);
    if (!body.chaos || !Number.isInteger(body.chaos.seed)) return [...out, `${body.code} has no seed for its dance`];
    const chaos = danceInfo(body);
    if (!(body.stars.length === 3 || body.stars.length === 4)) fail(`has ${body.stars.length} stars`);
    if ((body.planets || []).length || (body.comets || []).length) fail('has planets or comets');
    if (body.orbits.length) fail('lists orbits it hasn\'t got');
    // Stars that fit their age: born together, none past the main sequence, none still contracting towards it
    const age = body.stars[0].star.age_Myr;
    body.stars.forEach((s) => {
        if (s.star.age_Myr !== age) fail(`has stars of different ages (${s.code})`);
        if (s.star.stage !== 'main_sequence') fail(`has ${s.code} off the main sequence`);
        if (msLifetimeMyr(s.star.mass_Msun) <= age) fail(`has ${s.code} older than its time on the main sequence`);
        if (s.star.mass_Msun < zeroAgeMass(age)) fail(`has ${s.code} too light to have reached the main sequence by ${age} million years`);
    });
    // Possible now: bound, nothing touching or overfilling its Roche lobe, and genuinely not a stable hierarchy
    const masses = massesOf(body);
    const { x, v } = danceMotion(body, 0);
    if (!(totalEnergy(masses, x, v).total < 0)) fail('isn\'t bound');
    presentProblems(body.stars, masses, x).forEach((p) => fail(`now: ${p}`));
    if (presentHierarchy(body).stable) fail('passes the hierarchy test now, so it isn\'t unstable');
    // The dance, found again from its seed: the same to the last digit, a star flung out when it says, by the stars it names,
    // no two stars ever touching, and energy kept
    const kept = danceOf(body);
    const fresh = danceOf(body, { fresh: true });
    if (fresh.run.end !== kept.run.end || fresh.run.steps !== kept.run.steps || fresh.info.today_days !== kept.info.today_days) {
        fail('dances differently when found again');
    }
    if (!fresh.run.final) fail('never settles');
    const leaver = firstLeaver(fresh.run, masses);
    if (!leaver) {
        fail('flings no star out');
    } else {
        const when = leaver.at - chaos.today_days;
        if (Math.abs(when - chaos.eject_days) > 1e-6 * chaos.eject_days) fail(`flings a star out at ${when} days, not ${chaos.eject_days}`);
        if (leaver.stars.map((k) => body.stars[k].code).join() !== chaos.escapers.join()) fail('flings out other stars than it names');
        if (chaos.today_days >= leaver.at) fail('has already lost a star today');
    }
    if (!(chaos.eject_days >= 2.5 * chaos.crossing_days)) fail(`loses a star after only ${chaos.eject_days / chaos.crossing_days} crossing times`);
    if (fresh.run.closest < NEAR_MISS) fail(`has two stars passing within ${fresh.run.closest} of their radii added`);
    const drift = energyDrift(fresh.run, masses, fresh.start.x, fresh.start.v);
    if (drift > MAX_DRIFT) fail(`loses ${drift} of its energy in the integration`);
    // Young, so in or by a star-forming nebula, at its distance
    const host = u && u.resolve(body.chaos.host);
    if (!host || !host.body.nebula || !host.body.nebula.star_forming) fail(`is not by a star-forming nebula (${body.chaos.host})`);
    else if (Math.abs(body.distance_pc / host.body.distance_pc - 1) > DEPTH_SPREAD + 1e-6) fail('is not as far away as its nebula');
    return out;
}
