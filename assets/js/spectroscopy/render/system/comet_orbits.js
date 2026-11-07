// Comets in other star systems: where one is on its eccentric orbit, how fast it's going, and how active it is there.
// Plain maths, no three.js, so it runs under Node for tests.
//
// cometsOf(body)            the comets of a system, read from body.comets
// cometOrbit(comet, mass)   { a_AU, e, q_AU, Q_AU, period_days, phase0, inc, omega, node }, from the comet's own fields
// cometAt(orbit, tDays)     { x, y, z (AU, world axes as in system_model.js), r_AU, vx, vy, vz (unit direction of motion) }
// cometOrbitPoints(orbit)   { points: [[x, y, z] in AU], u: [fraction of the period at each point] }, denser near the star
// activity(r_AU, L)         0 far out, where the ice stays frozen, to 1 close in

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

export function cometsOf(body) {
    return (body && Array.isArray(body.comets)) ? body.comets : [];
}

const pick = (...xs) => xs.find((x) => typeof x === 'number' && Number.isFinite(x));

// Field names as data/ gives them; a few spellings are read, so that the shape can settle without this changing
export function cometOrbit(comet, massMsun = 1) {
    const o = comet.orbit || comet;
    let e = pick(o.ecc, o.eccentricity, o.e) ?? 0.7;
    e = Math.min(0.985, Math.max(0, e));
    const q = pick(o.q_AU, o.perihelion_AU);
    const a = pick(o.a_AU, o.semi_major_AU, o.orbit_AU) ?? (q !== undefined ? q / (1 - e) : 3);
    const period = pick(o.period_days) ?? 365.25 * Math.sqrt(a ** 3 / Math.max(massMsun, 0.05));
    const meanDeg = pick(o.mean_anomaly_deg);
    return {
        a_AU: a,
        e,
        q_AU: a * (1 - e),
        Q_AU: a * (1 + e),
        period_days: period,
        phase0: pick(o.phase0) ?? (meanDeg !== undefined ? meanDeg / 360 : 0),
        inc: (pick(o.inclination_deg, o.inc_deg) ?? 0) * DEG,
        omega: (pick(o.omega_deg, o.arg_periapsis_deg, o.periapsis_deg) ?? 0) * DEG,
        node: (pick(o.node_deg, o.ascending_node_deg) ?? 0) * DEG
    };
}

function eccentricAnomaly(M, e) {
    let E = e > 0.8 ? Math.PI : M;
    for (let k = 0; k < 12; k++) {
        const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        E -= d;
        if (Math.abs(d) < 1e-10) break;
    }
    return E;
}

// In the orbit's plane (x towards the closest point) to world axes: tilted about the line of nodes, then turned about +y
function toWorld(orbit, px, py, out, k) {
    const co = Math.cos(orbit.omega);
    const so = Math.sin(orbit.omega);
    const x = px * co - py * so;
    const y = px * so + py * co;
    const wx = x;
    const wy = y * Math.sin(orbit.inc);
    const wz = -y * Math.cos(orbit.inc);
    const cn = Math.cos(orbit.node);
    const sn = Math.sin(orbit.node);
    out[k] = wx * cn + wz * sn;
    out[k + 1] = wy;
    out[k + 2] = -wx * sn + wz * cn;
}

function stateAtE(orbit, E, out) {
    const { a_AU: a, e } = orbit;
    const b = a * Math.sqrt(1 - e * e);
    const tmp = [0, 0, 0, 0, 0, 0];
    toWorld(orbit, a * (Math.cos(E) - e), b * Math.sin(E), tmp, 0);
    toWorld(orbit, -a * Math.sin(E), b * Math.cos(E), tmp, 3);
    const vl = Math.hypot(tmp[3], tmp[4], tmp[5]) || 1;
    out.x = tmp[0];
    out.y = tmp[1];
    out.z = tmp[2];
    out.r_AU = a * (1 - e * Math.cos(E));
    out.vx = tmp[3] / vl;
    out.vy = tmp[4] / vl;
    out.vz = tmp[5] / vl;
    return out;
}

export function cometAt(orbit, tDays, out = {}) {
    const f = orbit.phase0 + tDays / orbit.period_days;
    const M = TAU * (f - Math.floor(f));
    return stateAtE(orbit, eccentricAnomaly(M, orbit.e), out);
}

// Evenly spaced in the eccentric anomaly, which puts more points round the tight bend near the star, where the comet is
// fast and the line curves most. u is the time, as a share of the period, so the line's trail follows the comet.
export function cometOrbitPoints(orbit, n = 200) {
    const points = [];
    const u = [];
    const s = {};
    for (let k = 0; k < n; k++) {
        const E = (k / n) * TAU;
        stateAtE(orbit, E, s);
        points.push([s.x, s.y, s.z]);
        u.push((E - orbit.e * Math.sin(E)) / TAU);
    }
    return { points, u };
}

// Water ice sublimates inside about 3 AU from the Sun, and the line moves out as the square root of the star's luminosity
export function activity(rAU, luminosityLsun = 1) {
    const snow = 3 * Math.sqrt(Math.max(luminosityLsun, 1e-4));
    const x = Math.min(1, Math.max(0, (snow / Math.max(rAU, 1e-4) - 1) / 2));
    return x * x * (3 - 2 * x);
}
