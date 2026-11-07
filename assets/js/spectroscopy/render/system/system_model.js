// The system view's picture of one system: which stars orbit which, where everything is at a given time, and how
// real distances and sizes turn into what is drawn. Plain data and maths, so it runs under Node for tests.
//
// World axes: the orbital plane is the x-z plane and +y is out of it. An orbit's (x, y, z) in AU maps to world
// (x, z, -y), so orbits run anticlockwise seen from above and a body moving in +y moves away from a camera on +z.
// That matches componentStates, whose vlos_kms is positive for motion in +y: fly in along +z and what you see
// moving away is what the spectrum shows redshifted.

import { AU, G, M_SUN, R_SUN, R_EARTH, hzEdges, orbitalSpeedKms } from '../../core/phys.js';
import { componentStates, figureEightPath, planetOrbitCentre } from '../../data/orbits.js';

export const FRAME = 10;                // World units from the centre to the edge of the default view
const RSUN_AU = R_SUN / AU;
const REARTH_RSUN = R_EARTH / R_SUN;

// Real star radii would vanish next to these orbits, and real planets more so. Every size follows one compressed
// scale, r^0.3 in solar radii, so a star is still bigger than a planet and a giant bigger than a dwarf.
export function compressedSize(radiusRsun) {
    return Math.max(radiusRsun, 1e-3) ** 0.3;
}

const SIZE_TRUE = 0.5;                  // World radius of a one-solar-radius star, true scale
const SIZE_LOG = 0.7;                   // ... and log scale, where there is more room around it

export function hasSystemView(body) {
    if (!body || !(body.kind === 'star' || body.kind === 'binary' || body.kind === 'multiple')) return false;
    if (body.architecture === 'figure_eight' || body.architecture === 'double_double') return true;
    return !!(body.planets && body.planets.length);
}

// Any kind that has stars can be drawn, even when it isn't offered a System tab
export function canDraw(body) {
    return !!body && (!!body.star || !!(body.stars && body.stars.length));
}

// ---------- Hierarchy ----------

function massOf(stars, members) {
    return members.reduce((sum, i) => sum + stars[i].star.mass_Msun, 0);
}

// The orbit tree, from body.orbits: each entry pairs two groups of stars by index, innermost first
function buildTree(body, stars) {
    const leaves = stars.map((_, i) => ({ members: [i], index: i, children: null, a_AU: 0, orbit: null, flat: false }));
    if (leaves.length === 1) return leaves[0];
    if (body.architecture === 'figure_eight') {
        return { members: stars.map((_, i) => i), index: -1, children: leaves, a_AU: 0, orbit: null, flat: true };
    }
    const key = (list) => [...list].sort((a, b) => a - b).join(',');
    const nodes = new Map(leaves.map((leaf) => [key(leaf.members), leaf]));
    let root = leaves[0];
    (body.orbits || []).forEach((orbit) => {
        const members = [...orbit.a, ...orbit.b];
        root = {
            members,
            index: -1,
            children: [nodes.get(key(orbit.a)), nodes.get(key(orbit.b))],
            a_AU: orbit.a_AU,
            orbit,
            flat: false
        };
        nodes.set(key(members), root);
    });
    return root;
}

function allNodes(root) {
    const out = [];
    const walk = (node) => {
        out.push(node);
        (node.children || []).forEach(walk);
    };
    walk(root);
    return out;
}

// What a planet goes round: the stars it names, or else the whole system
function hostNodeOf(planet, model) {
    const group = planet.orbit_centre_stars;
    if (!group || !group.length) return model.root;
    return model.nodes.find((n) => n.members.length === group.length && group.every((i) => n.members.includes(i))) || model.root;
}

// The figure-eight's closed path in AU. It repeats its first point at the end, which a closed line doesn't want.
function figureEightPoints() {
    const points = figureEightPath().map((q) => ({ x: q.x_AU, y: q.y_AU }));
    points.pop();
    return points;
}

// ---------- Where everything is ----------

const ALONE = Object.freeze({ x_AU: 0, y_AU: 0, z_AU: 0, vlos_kms: 0 });

// Star states in the stars' own order: from componentStates, the one source the spectra also use
function readStates(model, tDays) {
    if (model.body.star) return [ALONE]; // A lone star is the centre of its system
    const raw = componentStates(model.body, tDays);
    return model.stars.map((s) => raw.find((q) => q.code === s.code));
}

export function buildModel(body) {
    const stars = body.star
        ? [{ code: body.code, star: body.star, entity: body }]
        : body.stars.map((s) => ({ code: s.code, star: s.star, entity: s }));

    const model = {
        body,
        code: body.code,
        stars,
        planets: [],
        root: null,
        nodes: [],
        pathPoints: body.architecture === 'figure_eight' ? figureEightPoints() : null,
        pathPeriodDays: body.figure_eight ? body.figure_eight.period_days : 365.25,
        unit: 1,                 // World units per AU, true scale
        levels: [],
        hz: null,
        logUseful: false,
        startLog: false,
        inclination: null,
        sightAz: 0
    };
    model.root = buildTree(body, stars);
    model.nodes = allNodes(model.root);

    model.planets = (body.planets || []).map((planet) => {
        const node = hostNodeOf(planet, model);
        return { planet, code: planet.code, node, parent: model.nodes.find((n) => n.children && n.children.includes(node)) || null };
    });

    // Every distance that has to fit: a separation for each orbit, a radius for each planet
    const levels = [];
    model.nodes.forEach((n) => { if (n.children && !n.flat && n.a_AU > 0) levels.push(n.a_AU); });
    model.planets.forEach((e) => levels.push(e.planet.orbit_AU));
    model.levels = levels;

    // How far out things reach, true scale: sampled over the longest orbit
    const longest = Math.max(1, model.pathPoints ? model.pathPeriodDays : 0,
        ...model.nodes.map((n) => (n.orbit ? n.orbit.period_days : 0)));
    let extent = 0;
    for (let k = 0; k < 24; k++) {
        const s = readStates(model, (k / 24) * longest);
        s.forEach((q, i) => {
            // A close pair of big stars must fit in the frame, not just their centres
            const reach = Math.hypot(q.x_AU, q.y_AU, q.z_AU) + (stars.length > 1 ? stars[i].star.radius_Rsun * RSUN_AU : 0);
            extent = Math.max(extent, reach);
        });
    }
    if (model.pathPoints) model.pathPoints.forEach((q) => { extent = Math.max(extent, Math.hypot(q.x, q.y)); });
    model.planets.forEach((e) => {
        let offset = 0;
        for (let k = 0; k < 8; k++) {
            const c = planetOrbitCentre(body, e.planet, (k / 8) * longest);
            offset = Math.max(offset, Math.hypot(c.x_AU, c.y_AU, c.z_AU));
        }
        extent = Math.max(extent, offset + e.planet.orbit_AU);
    });
    // A lone star with nothing round it still needs a frame
    model.extent = extent > 0 ? extent : 8 * stars[0].star.radius_Rsun * RSUN_AU;
    model.unit = FRAME / model.extent;

    const aMin = levels.length ? Math.min(...levels) : model.extent;
    const aMax = levels.length ? Math.max(...levels) : model.extent;
    model.aMin = aMin;
    model.aMax = aMax;
    model.logUseful = aMax / aMin > 1.5;
    model.startLog = aMax / aMin > 300;   // True scale would hide the inner parts: the double-double
    const a0 = aMin / 2;
    const denom = Math.log1p(aMax / a0);
    model.logRadius = (a) => FRAME * Math.log1p(a / a0) / (denom || 1);

    // The true line of sight, from the orbit the spectra use: i = 90 is edge-on. Lines shift with motion along +y in
    // the widest orbit, but along the long axis (+x) of the figure-eight, so that's where the flight starts from.
    const widest = body.figure_eight || (body.orbits && body.orbits.length ? body.orbits[body.orbits.length - 1] : null);
    model.inclination = widest ? widest.inc_deg : null;
    model.sightAz = body.figure_eight ? -Math.PI / 2 : 0;

    const main = stars.length === 1 && (stars[0].star.stage === 'main_sequence');
    if (main) model.hz = hzEdges(stars[0].star.luminosity_Lsun);

    computeSizes(model);
    return model;
}

function comFrom(model, states, node) {
    const c = [0, 0, 0];
    const m = massOf(model.stars, node.members);
    node.members.forEach((i) => {
        const k = model.stars[i].star.mass_Msun / m;
        c[0] += states[i].x_AU * k;
        c[1] += states[i].y_AU * k;
        c[2] += states[i].z_AU * k;
    });
    return c;
}

// The scale of an orbit's offsets, in world units per AU, at log mix m (0 = true scale, 1 = log scale)
function scaleOf(model, aAU, m) {
    if (!(aAU > 0)) return model.unit;
    const logScale = model.logRadius(aAU) / aAU;
    return model.unit + (logScale - model.unit) * m;
}

export function ringRadius(model, aAU, m) {
    return scaleOf(model, aAU, m) * aAU;
}

// Star sizes at each end of the log mix, worked out once. A star never covers its own innermost orbit or its partner.
function computeSizes(model) {
    const atMix = (m) => {
        const out = model.stars.map((s) => {
            const base = (SIZE_TRUE + (SIZE_LOG - SIZE_TRUE) * m) * compressedSize(s.star.radius_Rsun);
            const real = (1 - m) * s.star.radius_Rsun * RSUN_AU * model.unit;
            return Math.max(base, real);
        });
        let ringLimit = Infinity;
        model.planets.forEach((e) => { ringLimit = Math.min(ringLimit, 0.6 * ringRadius(model, e.planet.orbit_AU, m)); });
        out.forEach((r, i) => { out[i] = Math.min(r, ringLimit); });
        // Partners, innermost first: their radii may not add up to more than the gap between them
        model.nodes.filter((n) => n.children && !n.flat && n.children.every((c) => c.children === null))
            .forEach((n) => {
                const sep = ringRadius(model, n.a_AU, m);
                const [a, b] = n.children.map((c) => c.index);
                const sum = out[a] + out[b];
                if (sum > 0.92 * sep) {
                    out[a] *= (0.92 * sep) / sum;
                    out[b] *= (0.92 * sep) / sum;
                }
            });
        // A wide companion or a figure-eight partner just has to stay well clear
        if (model.root.flat) {
            const minGap = model.pathPoints ? 0.34 * model.unit : Infinity;
            out.forEach((r, i) => { out[i] = Math.min(r, minGap); });
        }
        return out;
    };
    model.starRadiiTrue = atMix(0);
    model.starRadiiLog = atMix(1);

    // How squashed each star is by its partner, from the real sizes. The true effect only shows near contact,
    // so this is stylised, but it grows with how close the pair really are.
    model.tides = model.stars.map(() => null);
    model.nodes.filter((n) => n.children && !n.flat).forEach((n) => {
        n.children.forEach((child, c) => {
            if (child.children !== null) return;
            const other = n.children[1 - c];
            const self = model.stars[child.index].star;
            const f = (self.radius_Rsun * RSUN_AU) / n.a_AU;
            if (f < 0.06) return;
            const q = massOf(model.stars, other.members) / self.mass_Msun;
            const stretch = Math.min(0.16, 1.1 * f * f * Math.cbrt(q));
            model.tides[child.index] = { other, stretch };
        });
    });

    // The data names who is losing gas and who is gaining it
    model.stream = null;
    const transfer = model.body.transfer;
    if (transfer) {
        const pair = model.nodes.find((n) => n.children && !n.flat && n.members.includes(transfer.donor) && n.members.includes(transfer.accretor) && n.members.length === 2);
        if (pair) model.stream = { pair, donor: transfer.donor, accretor: transfer.accretor };
    }
}

export function starRadius(model, i, m) {
    return model.starRadiiTrue[i] + (model.starRadiiLog[i] - model.starRadiiTrue[i]) * m;
}

// Planets use the stars' size scale, so a giant planet is rightly smaller than a dwarf star
export function planetRadius(model, planet, m) {
    const scale = SIZE_TRUE + (SIZE_LOG - SIZE_TRUE) * m;
    return scale * compressedSize((planet.radius_Rearth || 1) * REARTH_RSUN);
}

// Positions in world units at time t. Each orbit's offsets are scaled by its own size, so in log scale a close pair
// stays readable beside a wide one. out = { stars, planets, centres: [[x,y,z]...] and nodes: Map(node -> [x,y,z]) }
export function layout(model, tDays, m, out = null) {
    const o = out || {
        stars: model.stars.map(() => [0, 0, 0]),
        planets: model.planets.map(() => [0, 0, 0]),
        centres: model.planets.map(() => [0, 0, 0]),
        nodes: new Map(),
        states: null
    };
    const states = readStates(model, tDays);
    o.states = states;
    const place = (node, wx, wy, wz) => {
        o.nodes.set(node, [wx, wy, wz]);
        if (node.children === null) {
            o.stars[node.index][0] = wx;
            o.stars[node.index][1] = wy;
            o.stars[node.index][2] = wz;
            return;
        }
        const here = comFrom(model, states, node);
        const s = node.flat ? model.unit : scaleOf(model, node.a_AU, m);
        node.children.forEach((child) => {
            const c = comFrom(model, states, child);
            place(child, wx + (c[0] - here[0]) * s, wy + (c[2] - here[2]) * s, wz - (c[1] - here[1]) * s);
        });
    };
    place(model.root, 0, 0, 0);
    model.planets.forEach((entry, i) => {
        const pl = entry.planet;
        const r = ringRadius(model, pl.orbit_AU, m);
        const angle = 2 * Math.PI * ((pl.phase0 || 0) + tDays / pl.period_days);
        const inc = ((pl.inclination_deg || 0) * Math.PI) / 180;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        // Where the orbit is centred comes from the data. It sits on its group's own orbit, so it's scaled like that orbit.
        const q = planetOrbitCentre(model.body, pl, tDays);
        const k = entry.parent ? scaleOf(model, entry.parent.a_AU, m) : model.unit;
        const c = o.centres[i];
        c[0] = q.x_AU * k;
        c[1] = q.z_AU * k;
        c[2] = -q.y_AU * k;
        o.planets[i][0] = c[0] + x;
        o.planets[i][1] = c[1] + y * Math.sin(inc);
        o.planets[i][2] = c[2] - y * Math.cos(inc);
    });
    return o;
}

// Unit-circle points of a planet's orbit in world axes, tilted as it is
export function planetOrbitPoints(planet, n = 180) {
    const inc = ((planet.inclination_deg || 0) * Math.PI) / 180;
    const pts = [];
    for (let k = 0; k < n; k++) {
        const a = (k / n) * 2 * Math.PI;
        pts.push([Math.cos(a), Math.sin(a) * Math.sin(inc), -Math.sin(a) * Math.cos(inc)]);
    }
    return pts;
}

// Fraction of its orbit a planet has gone round at time t
export function planetPhase(planet, tDays) {
    const u = (planet.phase0 || 0) + tDays / planet.period_days;
    return ((u % 1) + 1) % 1;
}

// One child's path around its group's centre of mass, in AU offsets and world axes, starting at t = 0.
// Sampled from the states, so an eccentric or nested orbit draws true.
export function childOrbitPoints(model, node, child, n = 128) {
    const pts = [];
    const period = node.orbit ? node.orbit.period_days : 0;
    if (!period) {
        const s0 = readStates(model, 0);
        const c = comFrom(model, s0, child);
        const h = comFrom(model, s0, node);
        const r = Math.hypot(c[0] - h[0], c[1] - h[1]);
        const a0 = Math.atan2(c[1] - h[1], c[0] - h[0]);
        for (let k = 0; k < n; k++) {
            const a = a0 + (k / n) * 2 * Math.PI;
            pts.push([Math.cos(a) * r, 0, -Math.sin(a) * r]);
        }
        return pts;
    }
    for (let k = 0; k < n; k++) {
        const s = readStates(model, (k / n) * period);
        const c = comFrom(model, s, child);
        const h = comFrom(model, s, node);
        pts.push([c[0] - h[0], c[2] - h[2], -(c[1] - h[1])]);
    }
    return pts;
}

// The figure-eight in world units
export function figureEightWorldPoints(model) {
    if (!model.pathPoints) return null;
    return model.pathPoints.map((q) => [q.x * model.unit, 0, -q.y * model.unit]);
}

// ---------- Readouts ----------

// r, T, v = 2 pi r / T and both sides of Kepler's third law, for the System tab
export function keplerReadout(model, entry) {
    const pl = entry.planet;
    const rM = pl.orbit_AU * AU;
    const tS = pl.period_days * 86400;
    const massMsun = massOf(model.stars, entry.node.members);
    return {
        r_AU: pl.orbit_AU,
        r_m: rM,
        T_days: pl.period_days,
        T_s: tS,
        v_kms: orbitalSpeedKms(pl.orbit_AU, pl.period_days),
        r3OverT2: rM ** 3 / tS ** 2,
        GMOver4Pi2: (G * massMsun * M_SUN) / (4 * Math.PI * Math.PI),
        mass_Msun: massMsun,
        aroundStars: entry.node.members.length
    };
}

// Can the habitable zone be drawn for this body? The reason is shown as the switch's tooltip when it can't.
export function hzStatus(body) {
    if (!body) return { ok: false, reason: 'The habitable zone shows inside a planetary system. Enter a system to see it.' };
    if (!body.star) {
        return { ok: false, reason: 'No habitable zone here: with more than one star, the simple formula does not apply.' };
    }
    if (body.star.stage !== 'main_sequence') {
        const kind = body.star.stage === 'white_dwarf' ? 'A white dwarf' : 'A giant';
        return { ok: false, reason: `No habitable zone here: ${kind.toLowerCase()} is not on the main sequence, so the zone moves as the star evolves and the formula does not apply.` };
    }
    return { ok: true, reason: '' };
}

// A ladder of playback speeds from a crawl through the shortest orbit to a visible turn of the longest
export function speedsFor(model) {
    const periods = model.planets.map((e) => e.planet.period_days);
    model.nodes.forEach((n) => { if (n.orbit && n.orbit.period_days) periods.push(n.orbit.period_days); });
    if (model.pathPoints) periods.push(model.pathPeriodDays);
    const shortest = periods.length ? Math.min(...periods) : 10;
    const longest = periods.length ? Math.max(...periods) : 10;
    const ladder = [0.01, 0.05, 0.25, 1, 5, 25, 125, 625, 3125, 15625, 78125];
    const pick = (x) => ladder.reduce((best, s) => (Math.abs(Math.log(s / x)) < Math.abs(Math.log(best / x)) ? s : best), ladder[0]);
    const low = pick(shortest / 50);
    const start = pick(shortest / 8);
    const high = Math.max(pick(longest / 10), pick(start * 25));
    return { speeds: ladder.filter((s) => s >= low && s <= high), speed: start };
}
