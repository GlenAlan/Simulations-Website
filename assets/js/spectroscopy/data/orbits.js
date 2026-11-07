// Where the members of a multi-star system are at a given time. Used by the spectra (line shifts) and the system
// view (drawing), so both always agree.
//
// componentStates(body, tDays) -> [{ code, x_AU, y_AU, z_AU, vlos_kms }]
//   One entry per star in the system (for a black hole: the hole, then its companion). x and y are in the plane of
//   the widest orbit, z is out of it, around the system's centre of mass. vlos_kms is the speed along the line of
//   sight, positive away from us, and excludes the system's own radial_velocity_kms. Positions are exact functions
//   of time, so nothing can drift, however long a playback runs.
//
// Each entry of body.orbits pairs two groups of stars by index, { a: [0, 1], b: [2], ... }, and the groups orbit their
// shared centre of mass. Adding up every orbit a star belongs to gives its place in any nested hierarchy: a triple
// is [{ a: [0], b: [1] }, { a: [0, 1], b: [2] }], a double-double is [{ a: [0], b: [1] }, { a: [2], b: [3] },
// { a: [0, 1], b: [2, 3] }]. The figure-eight's single entry only records its period; it reads a stored path (see below).

import { AU } from '../core/phys.js';

const TWO_PI = 2 * Math.PI;
const RAD = Math.PI / 180;

// Separation vector and line-of-sight speed of group a relative to group b. An orbit tilted against the widest one
// leans out of the x-y plane; its speed along the line of sight is always scaled by the sine of its own inclination.
function relativeOrbit(orbit, tDays, referenceIncDeg) {
    const e = orbit.ecc || 0;
    const mean = TWO_PI * (orbit.phase0 + tDays / orbit.period_days);
    let cosNu;
    let sinNu;
    let radius = orbit.a_AU;
    if (e > 0) {
        // Kepler's equation by Newton's method; e stays below 0.5, so a few steps reach full precision
        const m = mean - TWO_PI * Math.floor(mean / TWO_PI);
        let ecc = m + e * Math.sin(m);
        for (let i = 0; i < 6; i++) ecc -= (ecc - e * Math.sin(ecc) - m) / (1 - e * Math.cos(ecc));
        const cosE = Math.cos(ecc);
        const factor = 1 - e * cosE;
        cosNu = (cosE - e) / factor;
        sinNu = (Math.sqrt(1 - e * e) * Math.sin(ecc)) / factor;
        radius = orbit.a_AU * factor;
    } else {
        cosNu = Math.cos(mean);
        sinNu = Math.sin(mean);
    }
    const omega = (orbit.omega_deg || 0) * RAD;
    const cosW = Math.cos(omega);
    const sinW = Math.sin(omega);
    const cosU = cosNu * cosW - sinNu * sinW;
    const sinU = sinNu * cosW + cosNu * sinW;
    const speed = (TWO_PI * orbit.a_AU * AU) / (orbit.period_days * 86400) / 1000 / Math.sqrt(1 - e * e);
    const tilt = (orbit.inc_deg - referenceIncDeg) * RAD;
    return {
        x: radius * cosU,
        y: radius * sinU * Math.cos(tilt),
        z: radius * sinU * Math.sin(tilt),
        v: speed * (cosU + e * cosW) * Math.sin(orbit.inc_deg * RAD)
    };
}

function groupMass(stars, group) {
    return group.reduce((sum, i) => sum + stars[i].star.mass_Msun, 0);
}

function nestedStates(body, tDays) {
    const stars = body.stars;
    const out = stars.map((s) => ({ code: s.code, x_AU: 0, y_AU: 0, z_AU: 0, vlos_kms: 0 }));
    const widest = body.orbits[body.orbits.length - 1].inc_deg;
    body.orbits.forEach((orbit) => {
        const rel = relativeOrbit(orbit, tDays, widest);
        const massA = groupMass(stars, orbit.a);
        const massB = groupMass(stars, orbit.b);
        const total = massA + massB;
        orbit.a.forEach((i) => {
            const share = massB / total;
            out[i].x_AU += rel.x * share;
            out[i].y_AU += rel.y * share;
            out[i].z_AU += rel.z * share;
            out[i].vlos_kms += rel.v * share;
        });
        orbit.b.forEach((i) => {
            const share = massA / total;
            out[i].x_AU -= rel.x * share;
            out[i].y_AU -= rel.y * share;
            out[i].z_AU -= rel.z * share;
            out[i].vlos_kms -= rel.v * share;
        });
    });
    return out;
}

function blackHoleStates(body, tDays) {
    const bh = body.black_hole;
    const m2 = bh.companion.star.mass_Msun;
    const aAU = bh.a_AU ?? Math.cbrt((bh.mass_Msun + m2) * (bh.period_days / 365.25) ** 2);
    const rel = relativeOrbit({ a_AU: aAU, period_days: bh.period_days, inc_deg: bh.inc_deg, phase0: bh.phase0 }, tDays, bh.inc_deg);
    const total = bh.mass_Msun + m2;
    const holeShare = m2 / total;
    const companionShare = bh.mass_Msun / total;
    return [
        { code: body.code, x_AU: rel.x * holeShare, y_AU: rel.y * holeShare, z_AU: 0, vlos_kms: rel.v * holeShare },
        { code: bh.companion.code, x_AU: -rel.x * companionShare, y_AU: -rel.y * companionShare, z_AU: 0, vlos_kms: -rel.v * companionShare }
    ];
}

// The figure-eight (Chenciner and Montgomery's three-body choreography). Units are G = m = 1 until scaled.
// One period is integrated once, on first use, and stored for one star. Its two partners follow the same path a third
// of a period ahead and behind, so all three are exact and repeat for ever.
const EIGHT_X = 0.97000436;
const EIGHT_Y = -0.24308753;
const EIGHT_VX = -0.93240737;
const EIGHT_VY = -0.86473146;
const EIGHT_PERIOD = 6.32591398;
const EIGHT_NODES = 1024;
const EIGHT_SUBSTEPS = 16;
// Phase of each star on the stored path at t = 0: stars[2] starts at the crossing point
const EIGHT_OFFSETS = [2 / 3, 1 / 3, 0];

let eightTable = null;

function eightAccel(p, a) {
    const dx12 = p[0] - p[2];
    const dy12 = p[1] - p[3];
    const dx13 = p[0] - p[4];
    const dy13 = p[1] - p[5];
    const dx23 = p[2] - p[4];
    const dy23 = p[3] - p[5];
    const r12 = dx12 * dx12 + dy12 * dy12;
    const r13 = dx13 * dx13 + dy13 * dy13;
    const r23 = dx23 * dx23 + dy23 * dy23;
    const f12 = 1 / (r12 * Math.sqrt(r12));
    const f13 = 1 / (r13 * Math.sqrt(r13));
    const f23 = 1 / (r23 * Math.sqrt(r23));
    a[0] = -dx12 * f12 - dx13 * f13;
    a[1] = -dy12 * f12 - dy13 * f13;
    a[2] = dx12 * f12 - dx23 * f23;
    a[3] = dy12 * f12 - dy23 * f23;
    a[4] = dx13 * f13 + dx23 * f23;
    a[5] = dy13 * f13 + dy23 * f23;
}

function buildEightTable() {
    const n = EIGHT_NODES;
    const h = EIGHT_PERIOD / (n * EIGHT_SUBSTEPS);
    const t = { x: new Float64Array(n), y: new Float64Array(n), vx: new Float64Array(n), vy: new Float64Array(n), ax: new Float64Array(n), ay: new Float64Array(n) };
    const pos = [EIGHT_X, EIGHT_Y, -EIGHT_X, -EIGHT_Y, 0, 0];
    const vel = [-EIGHT_VX / 2, -EIGHT_VY / 2, -EIGHT_VX / 2, -EIGHT_VY / 2, EIGHT_VX, EIGHT_VY];
    const acc = new Float64Array(6);
    const k1p = new Float64Array(6);
    const k1v = new Float64Array(6);
    const k2p = new Float64Array(6);
    const k2v = new Float64Array(6);
    const k3p = new Float64Array(6);
    const k3v = new Float64Array(6);
    const k4p = new Float64Array(6);
    const k4v = new Float64Array(6);
    const tp = new Float64Array(6);
    // Classical fourth-order Runge-Kutta. At this step size the loop closes to about 1e-11 of its width
    for (let i = 0; i <= n * EIGHT_SUBSTEPS; i++) {
        if (i % EIGHT_SUBSTEPS === 0 && i < n * EIGHT_SUBSTEPS) {
            const node = i / EIGHT_SUBSTEPS;
            eightAccel(pos, acc);
            t.x[node] = pos[4];
            t.y[node] = pos[5];
            t.vx[node] = vel[4];
            t.vy[node] = vel[5];
            t.ax[node] = acc[4];
            t.ay[node] = acc[5];
        }
        if (i === n * EIGHT_SUBSTEPS) break;
        eightAccel(pos, k1v);
        for (let j = 0; j < 6; j++) { k1p[j] = vel[j]; tp[j] = pos[j] + 0.5 * h * k1p[j]; }
        eightAccel(tp, k2v);
        for (let j = 0; j < 6; j++) { k2p[j] = vel[j] + 0.5 * h * k1v[j]; tp[j] = pos[j] + 0.5 * h * k2p[j]; }
        eightAccel(tp, k3v);
        for (let j = 0; j < 6; j++) { k3p[j] = vel[j] + 0.5 * h * k2v[j]; tp[j] = pos[j] + h * k3p[j]; }
        eightAccel(tp, k4v);
        for (let j = 0; j < 6; j++) {
            k4p[j] = vel[j] + h * k3v[j];
            pos[j] += (h / 6) * (k1p[j] + 2 * k2p[j] + 2 * k3p[j] + k4p[j]);
            vel[j] += (h / 6) * (k1v[j] + 2 * k2v[j] + 2 * k3v[j] + k4v[j]);
        }
    }
    // The published starting values are only given to 8 places, so the end misses the start by a whisker.
    // Share that out along the path so the stored loop closes exactly.
    const dx = pos[4] - t.x[0];
    const dy = pos[5] - t.y[0];
    const dvx = vel[4] - t.vx[0];
    const dvy = vel[5] - t.vy[0];
    for (let i = 0; i < n; i++) {
        const f = i / n;
        t.x[i] -= dx * f;
        t.y[i] -= dy * f;
        t.vx[i] -= dvx * f;
        t.vy[i] -= dvy * f;
    }
    let extent = 0;
    for (let i = 0; i < n; i++) extent = Math.max(extent, Math.abs(t.x[i]));
    t.extent = extent;
    return t;
}

function eightAt(phase, out) {
    if (!eightTable) eightTable = buildEightTable();
    const t = eightTable;
    const n = EIGHT_NODES;
    const u = (phase - Math.floor(phase)) * n;
    const i = Math.min(n - 1, Math.floor(u));
    const j = (i + 1) % n;
    const s = u - i;
    const h = EIGHT_PERIOD / n;
    // Cubic Hermite: the table holds slopes as well as values, so the path and its speed stay smooth between nodes
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    out.x = h00 * t.x[i] + h10 * h * t.vx[i] + h01 * t.x[j] + h11 * h * t.vx[j];
    out.y = h00 * t.y[i] + h10 * h * t.vy[i] + h01 * t.y[j] + h11 * h * t.vy[j];
    out.vx = h00 * t.vx[i] + h10 * h * t.ax[i] + h01 * t.vx[j] + h11 * h * t.ax[j];
    out.vy = h00 * t.vy[i] + h10 * h * t.ay[i] + h01 * t.vy[j] + h11 * h * t.ay[j];
    return out;
}

// Length scale (AU per unit) that makes the path dynamically true for these masses and period: Kepler's third law
// in the units of the published solution. For three 0.8 solar-mass stars and a year it gives a path about 2 AU across.
function eightScale(massMsun, periodDays) {
    const years = periodDays / 365.25;
    return Math.cbrt((4 * Math.PI * Math.PI * massMsun * years * years) / (EIGHT_PERIOD * EIGHT_PERIOD));
}

// Seen along the path's long axis, which gives the three sets of lines their widest weave
function figureEightStates(body, tDays) {
    const info = body.figure_eight;
    const length = eightScale(body.stars[0].star.mass_Msun, info.period_days);
    const kmsPerUnit = ((length * AU) / ((info.period_days * 86400) / EIGHT_PERIOD)) / 1000;
    const sinI = Math.sin(info.inc_deg * RAD);
    const p = {};
    return body.stars.map((s, i) => {
        eightAt(info.phase0 + tDays / info.period_days + EIGHT_OFFSETS[i], p);
        return { code: s.code, x_AU: p.x * length, y_AU: p.y * length, z_AU: 0, vlos_kms: p.vx * kmsPerUnit * sinI };
    });
}

// The figure-eight's whole path for the system view: a closed list of points, about 2 AU across, its first point
// repeated at the end. Pass the star's mass and the period, or leave them for the values used in the sky.
export function figureEightPath(samples = 512, massMsun = 0.8, periodDays = 365.25) {
    const length = eightScale(massMsun, periodDays);
    const p = {};
    const points = [];
    for (let i = 0; i <= samples; i++) {
        eightAt(i / samples, p);
        points.push({ x_AU: p.x * length, y_AU: p.y * length, z_AU: 0 });
    }
    return points;
}

export function componentStates(body, tDays = 0) {
    if (body.figure_eight) return figureEightStates(body, tDays);
    if (body.stars && body.orbits && body.orbits.length) return nestedStates(body, tDays);
    if (body.black_hole) return blackHoleStates(body, tDays);
    return [];
}

// Where a planet's orbit is centred, in the same frame as componentStates: the origin, except for a planet that
// circles only part of a system (planet.orbit_centre_stars lists those stars), which follows their centre of mass.
export function planetOrbitCentre(body, planet, tDays = 0) {
    const group = planet.orbit_centre_stars;
    if (!group || !group.length) return { x_AU: 0, y_AU: 0, z_AU: 0 };
    const states = componentStates(body, tDays);
    let mass = 0;
    const c = { x_AU: 0, y_AU: 0, z_AU: 0 };
    group.forEach((i) => {
        const m = body.stars[i].star.mass_Msun;
        mass += m;
        c.x_AU += states[i].x_AU * m;
        c.y_AU += states[i].y_AU * m;
        c.z_AU += states[i].z_AU * m;
    });
    c.x_AU /= mass;
    c.y_AU /= mass;
    c.z_AU /= mass;
    return c;
}
