// A small gravity integration for three or four stars that are not in stable orbits (data/unstable.js). Pure: no DOM.
//
// Units are AU, days and solar masses, with G from Kepler's third law as the rest of the sky has it: P = 365.25 sqrt(a^3/M).
//
// The same positions at any time, in any browser, however the clock got there:
//  - Only +, -, *, / and sqrt touch the integration, and IEEE 754 makes those exact to the last bit everywhere. A chaotic
//    orbit grows any last-digit difference until the stars go different ways, so nothing else may.
//  - It is integrated once, from t = 0 forwards, with a fourth-order symplectic step (Yoshida's composition of leapfrog) whose
//    size follows the closest pair. Every few steps the state is kept, and a time in between is read by cubic Hermite
//    interpolation of the positions, with the velocities as their slopes, so a reading never depends on what was read before.
//  - Once one star has been flung out for good, and what it leaves behind is a pair, or a stable triple, the rest is two-body
//    motion: each pair goes round its ellipse, and the one flung out goes off along its hyperbola, both exact functions of time.
//    So the clock can run on for ever.
//  - A time before 0 reads the same machinery run on the same stars with every velocity reversed.

export const G_DAY = (4 * Math.PI * Math.PI) / (365.25 * 365.25);
export const KMS_PER_AU_DAY = 149597870.7 / 86400;

// Yoshida (1990): a step of h made of three leapfrog steps of W1 h, W0 h and W1 h, with W1 = 1 / (2 - 2^(1/3)) and
// W0 = 1 - 2 W1. Written out, so that no cube root is taken in the browser.
const W1 = 1.3512071919596578;
const W0 = -1.7024143839193153;
const DRIFT_OUT = W1 / 2;
const DRIFT_IN = (W0 + W1) / 2;

const KEEP_EVERY = 6;              // Steps between kept states
const FINAL_EVERY = 48;            // Steps between checks for the end of the dance
const FAR_SHARE = 20;              // The one flung out is this many times as far as the widest orbit left behind
const TRIPLE_MARGIN = 1.1;         // A triple left behind has this much room over Mardling and Aarseth's limit

// ---------- Gravity ----------

// Accelerations of every star, with a little softening so that nothing divides by zero
function accelerate(n, m, x, a, eps2) {
    for (let i = 0; i < 3 * n; i++) a[i] = 0;
    for (let i = 0; i < n; i++) {
        const xi = x[3 * i];
        const yi = x[3 * i + 1];
        const zi = x[3 * i + 2];
        for (let j = i + 1; j < n; j++) {
            const dx = x[3 * j] - xi;
            const dy = x[3 * j + 1] - yi;
            const dz = x[3 * j + 2] - zi;
            const r2 = dx * dx + dy * dy + dz * dz + eps2;
            const f = G_DAY / (r2 * Math.sqrt(r2));
            const fi = f * m[j];
            const fj = f * m[i];
            a[3 * i] += dx * fi;
            a[3 * i + 1] += dy * fi;
            a[3 * i + 2] += dz * fi;
            a[3 * j] -= dx * fj;
            a[3 * j + 1] -= dy * fj;
            a[3 * j + 2] -= dz * fj;
        }
    }
}

// The step: eta times the shortest of each pair's free-fall time and its crossing time at its present speed. Also returns,
// through out, the closest any pair is as a share of the sum of their radii.
function stepSize(n, m, x, v, eta, radii, out) {
    let least = Infinity;
    let touch = Infinity;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const dx = x[3 * j] - x[3 * i];
            const dy = x[3 * j + 1] - x[3 * i + 1];
            const dz = x[3 * j + 2] - x[3 * i + 2];
            const du = v[3 * j] - v[3 * i];
            const dv = v[3 * j + 1] - v[3 * i + 1];
            const dw = v[3 * j + 2] - v[3 * i + 2];
            const r2 = dx * dx + dy * dy + dz * dz;
            const s2 = du * du + dv * dv + dw * dw;
            const fall = (r2 * Math.sqrt(r2)) / (G_DAY * (m[i] + m[j]));
            if (fall < least) least = fall;
            if (s2 > 0 && r2 / s2 < least) least = r2 / s2;
            if (radii) {
                const sum = radii[i] + radii[j];
                const share = r2 / (sum * sum);
                if (share < touch) touch = share;
            }
        }
    }
    if (out) out.touch = touch;
    return eta * Math.sqrt(least);
}

function makeScratch(n) {
    return { a: new Float64Array(3 * n), probe: { touch: Infinity } };
}

// One fourth-order step of h, in place
function step(n, m, x, v, h, eps2, scratch) {
    const { a } = scratch;
    const k = 3 * n;
    for (let i = 0; i < k; i++) x[i] += DRIFT_OUT * h * v[i];
    accelerate(n, m, x, a, eps2);
    for (let i = 0; i < k; i++) v[i] += W1 * h * a[i];
    for (let i = 0; i < k; i++) x[i] += DRIFT_IN * h * v[i];
    accelerate(n, m, x, a, eps2);
    for (let i = 0; i < k; i++) v[i] += W0 * h * a[i];
    for (let i = 0; i < k; i++) x[i] += DRIFT_IN * h * v[i];
    accelerate(n, m, x, a, eps2);
    for (let i = 0; i < k; i++) v[i] += W1 * h * a[i];
    for (let i = 0; i < k; i++) x[i] += DRIFT_OUT * h * v[i];
}

// ---------- Two-body motion ----------

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// A pair's orbit from where one is relative to the other: semi-major axis (negative if unbound), eccentricity, energy per mass
export function pairOrbit(r, v, mu) {
    const d = Math.sqrt(dot(r, r));
    const energy = dot(v, v) / 2 - mu / d;
    const h = cross(r, v);
    const e = Math.sqrt(Math.max(0, 1 + (2 * energy * dot(h, h)) / (mu * mu)));
    return { a: -mu / (2 * energy), e, energy, d };
}

function solveElliptic(M, e) {
    let E = e < 0.8 ? M : Math.PI;
    for (let i = 0; i < 60; i++) {
        const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        E -= dE;
        if (Math.abs(dE) < 1e-14) break;
    }
    return E;
}

function solveHyperbolic(M, e) {
    let F = M === 0 ? 0 : Math.sign(M) * Math.log((2 * Math.abs(M)) / e + 1.8);
    for (let i = 0; i < 80; i++) {
        const dF = (e * Math.sinh(F) - F - M) / (e * Math.cosh(F) - 1);
        F -= dF;
        if (Math.abs(dF) < 1e-13 * Math.max(1, Math.abs(F))) break;
    }
    return F;
}

// Where a pair is after dt, from where it was: Lagrange's f and g with the anomaly reached by Kepler's equation.
// Exact for an ellipse or a hyperbola, and for any dt, since the mean anomaly of an ellipse is taken round to one turn.
export function keplerStep(r0, v0, mu, dt) {
    const d0 = Math.sqrt(dot(r0, r0));
    const rv = dot(r0, v0);
    const alpha = 2 / d0 - dot(v0, v0) / mu;   // 1 / a
    let f;
    let g;
    let fDot;
    let gDot;
    if (alpha > 0) {
        const a = 1 / alpha;
        const n = Math.sqrt(mu * alpha * alpha * alpha);
        const eCos = 1 - d0 * alpha;
        const eSin = rv / Math.sqrt(mu * a);
        const e = Math.sqrt(eCos * eCos + eSin * eSin);
        const E0 = Math.atan2(eSin, eCos);
        const M0 = E0 - eSin;
        const turns = Math.floor((M0 + n * dt) / (2 * Math.PI));
        const M = M0 + n * dt - 2 * Math.PI * turns;
        const E = solveElliptic(M, e);
        const dE = E - E0;
        const tau = (M - M0) / n;
        const c = Math.cos(dE);
        const s = Math.sin(dE);
        f = 1 - (a / d0) * (1 - c);
        g = tau - (dE - s) / n;
        const d = a * (1 - e * Math.cos(E));
        fDot = (-Math.sqrt(mu * a) * s) / (d * d0);
        gDot = 1 - (a / d) * (1 - c);
    } else {
        const a = 1 / alpha;                    // Negative
        const n = Math.sqrt(-mu * alpha * alpha * alpha);
        const eCosh = 1 - d0 * alpha;
        const eSinh = rv / Math.sqrt(-mu * a);
        const e = Math.sqrt(eCosh * eCosh - eSinh * eSinh);
        const F0 = Math.asinh(eSinh / e);
        const M0 = eSinh - F0;
        const M = M0 + n * dt;
        const F = solveHyperbolic(M, e);
        const dF = F - F0;
        const ch = Math.cosh(dF);
        const sh = Math.sinh(dF);
        f = 1 - (a / d0) * (1 - ch);
        g = dt - (sh - dF) / n;
        const d = a * (1 - e * Math.cosh(F));
        fDot = (-Math.sqrt(-mu * a) * sh) / (d * d0);
        gDot = 1 - (a / d) * (1 - ch);
    }
    return {
        r: [f * r0[0] + g * v0[0], f * r0[1] + g * v0[1], f * r0[2] + g * v0[2]],
        v: [fDot * r0[0] + gDot * v0[0], fDot * r0[1] + gDot * v0[1], fDot * r0[2] + gDot * v0[2]]
    };
}

// ---------- Who is bound to whom ----------

// Joins the most tightly bound pair into one, again and again, until nothing is left bound: a forest of two-body orbits.
// A unit: { members: [star indices], m, x, v (where its centre of mass is, and how fast), and either leaf: the star's index,
// or a and b, the two units it is made of, with mu, r and u (where b is relative to a, and how fast) and their orbit }.
export function decompose(n, m, x, v) {
    let units = [];
    for (let i = 0; i < n; i++) {
        units.push({ members: [i], m: m[i], leaf: i, x: [x[3 * i], x[3 * i + 1], x[3 * i + 2]], v: [v[3 * i], v[3 * i + 1], v[3 * i + 2]] });
    }
    for (;;) {
        let best = null;
        for (let i = 0; i < units.length; i++) {
            for (let j = i + 1; j < units.length; j++) {
                const A = units[i];
                const B = units[j];
                const mu = G_DAY * (A.m + B.m);
                const r = [B.x[0] - A.x[0], B.x[1] - A.x[1], B.x[2] - A.x[2]];
                const u = [B.v[0] - A.v[0], B.v[1] - A.v[1], B.v[2] - A.v[2]];
                const orbit = pairOrbit(r, u, mu);
                if (orbit.energy < 0 && (!best || orbit.a < best.orbit.a)) best = { i, j, mu, r, u, orbit };
            }
        }
        if (!best) break;
        const A = units[best.i];
        const B = units[best.j];
        const M = A.m + B.m;
        units = units.filter((_, k) => k !== best.i && k !== best.j);
        units.push({
            members: [...A.members, ...B.members],
            m: M,
            x: [0, 1, 2].map((k) => (A.x[k] * A.m + B.x[k] * B.m) / M),
            v: [0, 1, 2].map((k) => (A.v[k] * A.m + B.v[k] * B.m) / M),
            a: A,
            b: B,
            mu: best.mu,
            r: best.r,
            u: best.u,
            orbit: best.orbit
        });
    }
    return units;
}

// The widest an orbit in a unit reaches: its apocentre, or the widest of those inside it
function reachOf(unit) {
    if (unit.leaf !== undefined) return 0;
    return Math.max(unit.orbit.a * (1 + unit.orbit.e), reachOf(unit.a), reachOf(unit.b));
}

// Mardling and Aarseth (2001), as data/dynamics.js has it: the smallest stable a_out / a_in
export function stableRatio(qOut, eOut) {
    return 2.8 * (1 + qOut) ** 0.4 * (1 + eOut) ** 0.4 * (1 - eOut) ** -1.2;
}

// Is every orbit in a unit wide enough beside the ones inside it to last? margin: how much room over the limit it needs.
export function unitStable(unit, margin = TRIPLE_MARGIN) {
    if (unit.leaf !== undefined) return true;
    if (!unitStable(unit.a, margin) || !unitStable(unit.b, margin)) return false;
    const e = unit.orbit.e;
    if (e >= 1) return false;
    return [[unit.a, unit.b], [unit.b, unit.a]].every(([inner, other]) => {
        if (inner.leaf !== undefined) return true;
        return unit.orbit.a / inner.orbit.a > margin * stableRatio(other.m / inner.m, e);
    });
}

const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];

// Has the dance ended? Everything is in parts that are flying apart for good: none bound to another, each pair of them
// moving apart, far enough apart that each now moves as one body, and none able to break up again. Returns the parts, or
// null. Two parts are then a hyperbola; three or more (a four-star system that has flung out two) are taken as so far
// apart that they go on in straight lines, which takes them further still.
function finalParts(n, m, x, v, outAU) {
    const units = decompose(n, m, x, v);
    if (units.length < 2) return null;
    const far = units.length > 2 ? FAR_SHARE * 2.5 : FAR_SHARE;
    for (let i = 0; i < units.length; i++) {
        for (let j = i + 1; j < units.length; j++) {
            const A = units[i];
            const B = units[j];
            const r = sub(B.x, A.x);
            if (dot(r, sub(B.v, A.v)) <= 0) return null;
            const d = Math.sqrt(dot(r, r));
            if (d < far * Math.max(reachOf(A), reachOf(B), 1e-9) || d < outAU) return null;
        }
    }
    return units.every((u) => unitStable(u)) ? units : null;
}

// The two-body tree that carries the stars on from the end of the integration. A node keeps where its second part is
// relative to its first, and how fast, at that moment.
function treeNode(u) {
    return u.leaf !== undefined ? { leaf: u.leaf } : { a: treeNode(u.a), b: treeNode(u.b), ma: u.a.m, mb: u.b.m, mu: u.mu, r: u.r, v: u.u };
}

function treeOf(units) {
    if (units.length === 2) {
        const [A, B] = units;
        const M = A.m + B.m;
        return {
            com: [0, 1, 2].map((k) => (A.x[k] * A.m + B.x[k] * B.m) / M),
            vcom: [0, 1, 2].map((k) => (A.v[k] * A.m + B.v[k] * B.m) / M),
            roots: [{ a: treeNode(A), b: treeNode(B), ma: A.m, mb: B.m, mu: G_DAY * M, r: sub(B.x, A.x), v: sub(B.v, A.v) }],
            straight: null
        };
    }
    return { com: null, vcom: null, roots: null, straight: units.map((u) => ({ node: treeNode(u), x: u.x.slice(), v: u.v.slice() })) };
}

function placeTree(node, c, w, dt, x, v) {
    if (node.leaf !== undefined) {
        const i = node.leaf;
        x[3 * i] = c[0];
        x[3 * i + 1] = c[1];
        x[3 * i + 2] = c[2];
        v[3 * i] = w[0];
        v[3 * i + 1] = w[1];
        v[3 * i + 2] = w[2];
        return;
    }
    const s = keplerStep(node.r, node.v, node.mu, dt);
    const M = node.ma + node.mb;
    const fa = node.mb / M;
    const fb = node.ma / M;
    placeTree(node.a, [c[0] - fa * s.r[0], c[1] - fa * s.r[1], c[2] - fa * s.r[2]], [w[0] - fa * s.v[0], w[1] - fa * s.v[1], w[2] - fa * s.v[2]], dt, x, v);
    placeTree(node.b, [c[0] + fb * s.r[0], c[1] + fb * s.r[1], c[2] + fb * s.r[2]], [w[0] + fb * s.v[0], w[1] + fb * s.v[1], w[2] + fb * s.v[2]], dt, x, v);
}

function readTree(tree, dt, x, v) {
    if (tree.roots) {
        const c = [0, 1, 2].map((k) => tree.com[k] + tree.vcom[k] * dt);
        placeTree(tree.roots[0], c, tree.vcom, dt, x, v);
        return;
    }
    tree.straight.forEach((part) => placeTree(part.node, [0, 1, 2].map((k) => part.x[k] + part.v[k] * dt), part.v, dt, x, v));
}

// ---------- One direction of time ----------

// Integrates stars from x0 and v0 (AU, AU/day) until the dance ends or maxT, keeping states to read back.
// opts: { eta, eps (softening, AU), radii (AU: only to record how close any two come), outAU (how far from the others a star
// counts as having left them), maxSteps, giveUpAt (stop once two stars come within this many of their radii added) }.
// Returns a run: { n, m, times, states (6n numbers per kept time), end, steps, closest (as a share of the two stars' radii
// added), final, parts (the star indices of each part once it has ended), leftAt (when each star left the others for the last
// time, or null), tree }.
export function integrate(masses, x0, v0, maxT, opts = {}) {
    const n = masses.length;
    const k6 = 6 * n;
    const m = Float64Array.from(masses);
    const x = Float64Array.from(x0);
    const v = Float64Array.from(v0);
    const eta = opts.eta ?? 0.02;
    const eps2 = (opts.eps ?? 0) * (opts.eps ?? 0);
    const radii = opts.radii ? Float64Array.from(opts.radii) : null;
    const maxSteps = opts.maxSteps ?? 4e6;
    const outAU = opts.outAU ?? Infinity;
    const outward2 = outAU * outAU;
    const scratch = makeScratch(n);
    let times = new Float64Array(1024);
    let states = new Float64Array(1024 * k6);
    let kept = 0;
    const keep = (time) => {
        if (kept === times.length) {
            const t2 = new Float64Array(times.length * 2);
            t2.set(times);
            times = t2;
            const s2 = new Float64Array(states.length * 2);
            s2.set(states);
            states = s2;
        }
        times[kept] = time;
        states.set(x, kept * k6);
        states.set(v, kept * k6 + 3 * n);
        kept++;
    };
    // When each star last left the middle of the others, or null while it is among them
    const leftAt = new Array(n).fill(null);
    const track = (time) => {
        for (let i = 0; i < n; i++) {
            let mass = 0;
            let cx = 0;
            let cy = 0;
            let cz = 0;
            for (let j = 0; j < n; j++) {
                if (j === i) continue;
                mass += m[j];
                cx += m[j] * x[3 * j];
                cy += m[j] * x[3 * j + 1];
                cz += m[j] * x[3 * j + 2];
            }
            const dx = x[3 * i] - cx / mass;
            const dy = x[3 * i + 1] - cy / mass;
            const dz = x[3 * i + 2] - cz / mass;
            if (dx * dx + dy * dy + dz * dz > outward2) {
                if (leftAt[i] === null) leftAt[i] = time;
            } else {
                leftAt[i] = null;
            }
        }
    };
    let t = 0;
    let steps = 0;
    let closest = Infinity;
    let parts = null;
    keep(0);
    track(0);
    // A run that only matters if no two stars come within this share of their radii added stops as soon as two do
    const giveUp = opts.giveUpAt ? opts.giveUpAt * opts.giveUpAt : 0;
    while (t < maxT && steps < maxSteps) {
        const h = stepSize(n, m, x, v, eta, radii, scratch.probe);
        if (scratch.probe.touch < closest) closest = scratch.probe.touch;
        if (closest < giveUp) break;
        step(n, m, x, v, h, eps2, scratch);
        t += h;
        steps++;
        if (steps % KEEP_EVERY === 0) {
            keep(t);
            track(t);
        }
        if (steps % FINAL_EVERY === 0) {
            parts = finalParts(n, m, x, v, Number.isFinite(outAU) ? outAU : 0);
            if (parts) break;
        }
    }
    if (times[kept - 1] !== t) {
        keep(t);
        track(t);
    }
    return {
        n,
        m,
        times: times.subarray(0, kept),
        states: states.subarray(0, kept * k6),
        end: t,
        steps,
        closest: Math.sqrt(closest),
        final: !!parts,
        parts: parts ? parts.map((p) => p.members.slice().sort((a, b) => a - b)) : null,
        leftAt,
        tree: parts ? treeOf(parts) : null
    };
}

// Cubic Hermite between two kept states, positions with velocities as their slopes. Writes x and v (each 3n).
function hermite(run, k, t, x, v) {
    const n3 = 3 * run.n;
    const k6 = 2 * n3;
    const t0 = run.times[k];
    const h = run.times[k + 1] - t0;
    const s = (t - t0) / h;
    const p = k * k6;
    const q = p + k6;
    const st = run.states;
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    // Their slopes, for the velocities
    const d00 = (6 * s2 - 6 * s) / h;
    const d10 = 3 * s2 - 4 * s + 1;
    const d01 = (-6 * s2 + 6 * s) / h;
    const d11 = 3 * s2 - 2 * s;
    for (let i = 0; i < n3; i++) {
        const x0 = st[p + i];
        const x1 = st[q + i];
        const v0 = st[p + n3 + i];
        const v1 = st[q + n3 + i];
        x[i] = h00 * x0 + h10 * h * v0 + h01 * x1 + h11 * h * v1;
        v[i] = d00 * x0 + d10 * v0 + d01 * x1 + d11 * v1;
    }
}

// Where every star is at time t (>= 0) along a run, and how fast: x and v (each 3n) are written
export function readRun(run, t, x, v) {
    const n3 = 3 * run.n;
    const times = run.times;
    const last = times.length - 1;
    if (t >= run.end) {
        if (run.tree) {
            readTree(run.tree, t - run.end, x, v);
        } else {
            // It never ended in the time it was given: it waits where it got to
            for (let i = 0; i < n3; i++) {
                x[i] = run.states[last * 2 * n3 + i];
                v[i] = 0;
            }
        }
        return;
    }
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t) lo = mid;
        else hi = mid;
    }
    hermite(run, lo, Math.max(t, 0), x, v);
}

// Accelerations at given positions, for anything that needs them, such as how sharply a star is turning
export function accelerationsAt(masses, x, eps = 0) {
    const n = masses.length;
    const a = new Float64Array(3 * n);
    accelerate(n, Float64Array.from(masses), x, a, eps * eps);
    return a;
}

// Kinetic and potential energy, in solar masses AU^2 / day^2
export function totalEnergy(masses, x, v) {
    const n = masses.length;
    let kinetic = 0;
    let potential = 0;
    for (let i = 0; i < n; i++) {
        kinetic += 0.5 * masses[i] * (v[3 * i] * v[3 * i] + v[3 * i + 1] * v[3 * i + 1] + v[3 * i + 2] * v[3 * i + 2]);
        for (let j = i + 1; j < n; j++) {
            const dx = x[3 * j] - x[3 * i];
            const dy = x[3 * j + 1] - x[3 * i + 1];
            const dz = x[3 * j + 2] - x[3 * i + 2];
            potential -= (G_DAY * masses[i] * masses[j]) / Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
    }
    return { kinetic, potential, total: kinetic + potential };
}

