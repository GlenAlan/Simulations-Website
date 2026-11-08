// The system view's picture of one system: which stars orbit which, where everything is at a given time, and how
// real distances and sizes turn into what is drawn. Plain data and maths, so it runs under Node for tests.
//
// World axes: the orbital plane is the x-z plane and +y is out of it. An orbit's (x, y, z) in AU maps to world
// (x, z, -y), so orbits run anticlockwise seen from above and a body moving in +y moves away from a camera on +z.
// That matches componentStates, whose vlos_kms is positive for motion in +y: fly in along +z and what you see
// moving away is what the spectrum shows redshifted.

import { AU, G, M_SUN, R_SUN, R_EARTH, hzEdges, orbitalSpeedKms } from '../../core/phys.js';
import { componentStates, figureEightPath, planetOrbitCentre } from '../../data/orbits.js';
import { memberDirection } from '../layers/sky_tangent.js';
import { cometsOf, cometOrbit } from './comet_orbits.js';
import { rocheShare } from '../../data/dynamics.js';
import { nucleusSystemOf, supermassiveRadius, CLOSE_STAR_SHARE, CLOSE_STAR_FLOOR_PX } from './nucleus_model.js';
import { danceReachAU } from '../../data/unstable.js';
import { danceSpeeds, danceStarCap, recentreLayout } from './dance_model.js';

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
const STAR_TO_RING = 0.42;              // A star's radius as a share of its innermost planet's orbit
const PLANET_TO_STAR = 0.62;            // A planet's radius, rings included, as a share of its smallest host star's
const PLANET_TO_RING = 0.16;            // ... and of its own orbit, so that a close-up has room for it
const HOLE_DISC = 2.4;

// Everything that shines can be visited: lone stars, with or without planets, pairs, triples, cluster members, black
// holes with their companions, and neutron stars
export function canDraw(body) {
    return !!body && (!!body.star || !!(body.stars && body.stars.length) || !!body.black_hole || !!body.neutron_star);
}

export function hasSystemView(body) {
    return canDraw(body);
}

// A cluster member is entered as a system of its own: a copy with what a system needs from its cluster
const memberSystems = new WeakMap();
function memberSystem(member, cluster) {
    let system = memberSystems.get(member);
    if (!system) {
        system = {
            ...member,
            sky: memberDirection(cluster, member),
            depth: cluster.depth,
            bands: member.bands || cluster.bands,
            planets: member.planets || []
        };
        memberSystems.set(member, system);
    }
    return system;
}

// What a resolved selection opens: its body, or for a cluster member the member, or for a galaxy's black hole or one of
// the stars round it, that hole (render/system/nucleus_model.js). Null if there's nothing to visit.
export function systemBodyOf(resolved) {
    if (!resolved) return null;
    const nucleus = nucleusSystemOf(resolved);
    if (nucleus) return nucleus;
    const body = resolved.path === 'member' ? memberSystem(resolved.entity, resolved.body) : resolved.body;
    return canDraw(body) ? body : null;
}

// ---------- Hierarchy ----------

function massOf(stars, members) {
    return members.reduce((sum, i) => sum + stars[i].star.mass_Msun, 0);
}

// The orbit data pairs by star index. A black hole has one orbit, in its own fields, which data/orbits.js reads too.
function orbitsOf(body) {
    if (body.orbits) return body.orbits;
    const hole = body.black_hole;
    if (!hole) return [];
    return [{ a: [0], b: [1], a_AU: hole.a_AU, period_days: hole.period_days, ecc: 0, inc_deg: hole.inc_deg, omega_deg: 0, phase0: hole.phase0 }];
}

// The orbit tree, from the body's orbits: each entry pairs two groups of stars by index, innermost first
function buildTree(body, stars) {
    const leaves = stars.map((_, i) => ({ members: [i], index: i, children: null, a_AU: 0, orbit: null, flat: false }));
    if (leaves.length === 1) return leaves[0];
    // Unstable: no orbits at all, just stars round their centre of mass (render/system/dance_model.js)
    if (body.architecture === 'figure_eight' || body.unstable) {
        return { members: stars.map((_, i) => i), index: -1, children: leaves, a_AU: 0, orbit: null, flat: true };
    }
    const key = (list) => [...list].sort((a, b) => a - b).join(',');
    const nodes = new Map(leaves.map((leaf) => [key(leaf.members), leaf]));
    let root = leaves[0];
    orbitsOf(body).forEach((orbit) => {
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
    if (model.stars.length === 1) return [ALONE]; // A lone star is the centre of its system
    const raw = componentStates(model.body, tDays);
    return model.stars.map((s) => raw.find((q) => q.code === s.code));
}

// A black hole or neutron star in the shape of a star, for the sums. Their looks live in remnants.js. A hole's radius is
// its disc's, and stylised, as sizes are everywhere here.
function holeAsStar(hole) {
    return {
        teff_K: 5800 * (10 / hole.mass_Msun) ** 0.25,
        mass_Msun: hole.mass_Msun,
        radius_Rsun: 0.5 * (hole.mass_Msun / 8) ** 0.5,
        luminosity_Lsun: 0,
        stage: 'black_hole'
    };
}

function neutronAsStar(ns) {
    return {
        teff_K: ns.teff_K,
        mass_Msun: ns.mass_Msun,
        radius_Rsun: ns.radius_km / 695700,
        luminosity_Lsun: ns.luminosity_Lsun,
        stage: 'neutron_star',
        vsini_kms: 0
    };
}

function starsOf(body) {
    if (body.stars && body.stars.length) return body.stars.map((s) => ({ code: s.code, star: s.star, entity: s }));
    if (body.star) return [{ code: body.code, star: body.star, entity: body }];
    if (body.black_hole) {
        const { companion } = body.black_hole;
        return [
            { code: body.code, star: holeAsStar(body.black_hole), entity: body },
            { code: companion.code, star: companion.star, entity: companion }
        ];
    }
    return [{ code: body.code, star: neutronAsStar(body.neutron_star), entity: body }];
}

export function buildModel(body) {
    const stars = starsOf(body);

    const model = {
        body,
        code: body.code,
        stars,
        planets: [],
        root: null,
        nodes: [],
        pathPoints: body.architecture === 'figure_eight' ? figureEightPoints() : null,
        pathPeriodDays: body.figure_eight ? body.figure_eight.period_days : body.unstable ? 0 : 365.25,
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

    // Comets go round the whole system, on long eccentric orbits
    const totalMass = stars.reduce((sum, s) => sum + (s.star.mass_Msun || 0), 0) || 1;
    model.luminosity = stars.reduce((sum, s) => sum + (s.star.luminosity_Lsun || 0), 0);
    model.comets = cometsOf(body).map((comet) => ({ comet, code: comet.code, orbit: cometOrbit(comet, totalMass) }));

    // Every distance that has to fit: a separation for each orbit, a radius for each planet, and each comet's mean distance
    const levels = [];
    model.nodes.forEach((n) => { if (n.children && !n.flat && n.a_AU > 0) levels.push(n.a_AU); });
    model.planets.forEach((e) => levels.push(e.planet.orbit_AU));
    model.comets.forEach((c) => levels.push(c.orbit.a_AU));
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
    if (body.unstable) extent = Math.max(extent, danceReachAU(body));   // As far out as they go before one is flung out
    model.planets.forEach((e) => {
        let offset = 0;
        for (let k = 0; k < 8; k++) {
            const c = planetOrbitCentre(body, e.planet, (k / 8) * longest);
            offset = Math.max(offset, Math.hypot(c.x_AU, c.y_AU, c.z_AU));
        }
        extent = Math.max(extent, offset + e.planet.orbit_AU);
    });
    // A comet's whole orbit is in view when zoomed out as far as the view goes, and most of it at the start
    model.comets.forEach((c) => { extent = Math.max(extent, c.orbit.Q_AU / 1.6); });
    // A lone star with nothing round it still needs a frame
    model.extent = extent > 0 ? extent : 8 * stars[0].star.radius_Rsun * RSUN_AU;
    model.unit = FRAME / model.extent;

    const aMin = levels.length ? Math.min(...levels) : model.extent;
    const aMax = levels.length ? Math.max(...levels) : model.extent;
    model.aMin = aMin;
    model.aMax = aMax;
    model.logUseful = aMax / aMin > 1.5;
    // True scale would hide the inner parts: the double-double, and a galaxy's black hole among its stars
    model.startLog = aMax / aMin > 300 || body.kind === 'nucleus';
    const a0 = aMin / 2;
    const denom = Math.log1p(aMax / a0);
    model.logRadius = (a) => FRAME * Math.log1p(a / a0) / (denom || 1);

    // The true line of sight, from the orbit the spectra use: i = 90 is edge-on. Lines shift with motion along +y in
    // the widest orbit, but along the long axis (+x) of the figure-eight, so that's where the flight starts from.
    const orbits = orbitsOf(body);
    const widest = body.figure_eight || (orbits.length ? orbits[orbits.length - 1] : null);
    model.inclination = widest ? widest.inc_deg : body.unstable ? body.chaos.inc_deg : null;
    model.sightAz = body.figure_eight ? -Math.PI / 2 : 0;

    const main = stars.length === 1 && (stars[0].star.stage === 'main_sequence');
    if (main) model.hz = hzEdges(stars[0].star.luminosity_Lsun);
    model.lone = stars.length === 1 && model.planets.length === 0 && model.comets.length === 0;

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

// A star with nothing round it is what there is to see, so it fills the view: a giant most, a white dwarf least
function loneRadius(star) {
    return FRAME * Math.min(0.5, 0.34 * compressedSize(star.radius_Rsun) ** 0.6);
}

// How far a planet reaches, in its own radii: rings are part of what's drawn
export function planetReach(planet) {
    return planet.rings ? Math.max(1, planet.rings.outer_Rp || 1) : 1;
}

// Star and planet sizes at each end of the log mix, worked out once. A star never covers its own innermost orbit or its
// partner, and a planet starts out well under the size of its star.
function computeSizes(model) {
    const nucleus = model.body.kind === 'nucleus';
    const atMix = (m) => {
        const out = model.stars.map((s) => {
            if (model.lone) return loneRadius(s.star);
            if (s.star.supermassive) return supermassiveRadius(model, ringRadius, FRAME, m);
            // A hole's radius is its disc's edge, and most of the disc is faint: it needs more room to be seen
            const own = s.star.stage === 'black_hole' ? HOLE_DISC : nucleus ? CLOSE_STAR_SHARE : 1;
            const base = own * (SIZE_TRUE + (SIZE_LOG - SIZE_TRUE) * m) * compressedSize(s.star.radius_Rsun);
            const real = (1 - m) * s.star.radius_Rsun * RSUN_AU * model.unit;
            return Math.max(base, real);
        });
        let ringLimit = Infinity;
        model.planets.forEach((e) => { ringLimit = Math.min(ringLimit, STAR_TO_RING * ringRadius(model, e.planet.orbit_AU, m)); });
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
            const minGap = model.pathPoints ? 0.34 * model.unit : model.body.unstable ? danceStarCap(FRAME) : Infinity;
            out.forEach((r, i) => { out[i] = Math.min(r, minGap); });
        }
        return out;
    };
    model.starRadiiTrue = atMix(0);
    model.starRadiiLog = atMix(1);

    const planetsAtMix = (m, starRadii) => model.planets.map((e) => {
        const base = (SIZE_TRUE + (SIZE_LOG - SIZE_TRUE) * m) * compressedSize((e.planet.radius_Rearth || 1) * REARTH_RSUN);
        const hostMin = Math.min(...e.node.members.map((i) => starRadii[i]));
        const room = Math.min(PLANET_TO_STAR * hostMin, PLANET_TO_RING * ringRadius(model, e.planet.orbit_AU, m));
        return Math.min(base, room / planetReach(e.planet));
    });
    model.planetRadiiTrue = planetsAtMix(0, model.starRadiiTrue);
    model.planetRadiiLog = planetsAtMix(1, model.starRadiiLog);
    model.planetIndex = new Map(model.planets.map((e, j) => [e.planet, j]));

    // The smallest either may be on screen, in pixels of radius, so that everything is still something to click
    model.starFloorPx = model.stars.map((s) => {
        if (s.star.stage === 'black_hole') return 22;
        if (nucleus) return CLOSE_STAR_FLOOR_PX;
        return Math.max(6, Math.min(44, 9 * compressedSize(s.star.radius_Rsun)));
    });
    model.planetFloorPx = model.planets.map((e) => {
        const big = Math.min(1, Math.max(0, ((e.planet.radius_Rearth || 1) - 1) / 10));
        return 5 + 6 * Math.sqrt(big);
    });

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

    // The data names who is losing gas and who is gaining it. A black hole is fed only as its companion really could:
    // a stream once the companion fills its Roche lobe, or a hot massive star's wind, which spreads wide
    model.stream = null;
    const transfer = model.body.black_hole ? holeFeed(model.body.black_hole) : model.body.transfer;
    if (transfer) {
        const pair = model.nodes.find((n) => n.children && !n.flat && n.members.includes(transfer.donor) && n.members.includes(transfer.accretor) && n.members.length === 2);
        if (pair) model.stream = { pair, donor: transfer.donor, accretor: transfer.accretor, ontoHole: !!model.body.black_hole, wind: !!transfer.wind };
    }
}

// How a black hole's companion (star 1) feeds it (star 0), if at all: { donor, accretor, wind } or null. The data says
// (black_hole.feeding, see data/dynamics.js): 'roche' is a stream from a companion that fills its lobe, 'wind' a hot massive
// star's wind, 'none' nothing. Without that field, the same from the orbit: filling the lobe at closest approach (within the
// data's own 3%) makes a stream, and short of that only a star bright enough to drive a strong wind feeds it.
const WIND_LSUN = 1e4;
function holeFeed(hole) {
    let feeding = hole.feeding;
    if (!feeding) {
        const star = hole.companion.star;
        const lobe = rocheShare(star.mass_Msun / hole.mass_Msun) * hole.a_AU * (1 - (hole.ecc || 0));
        feeding = (star.radius_Rsun * RSUN_AU) / lobe >= 0.97 ? 'roche' : star.luminosity_Lsun >= WIND_LSUN ? 'wind' : 'none';
    }
    if (feeding === 'none') return null;
    return { donor: 1, accretor: 0, wind: feeding === 'wind' };
}

// Towards us, from the system's centre: where the flight in starts (system_view.js beginFlight), on the true line of sight
export function sightDirection(model) {
    const el = (model.inclination === null ? 7 : Math.min(70, Math.max(4, 90 - model.inclination))) * (Math.PI / 180);
    const az = model.sightAz;
    return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
}

export function starRadius(model, i, m) {
    return (model.starRadiiTrue[i] + (model.starRadiiLog[i] - model.starRadiiTrue[i]) * m) * (model.sizeScale || 1);
}

// Planets use the stars' size scale, so a giant planet is rightly smaller than a dwarf star
export function planetRadius(model, planet, m) {
    const j = model.planetIndex.get(planet);
    return model.planetRadiiTrue[j] + (model.planetRadiiLog[j] - model.planetRadiiTrue[j]) * m;
}

// ---------- What's drawn: a planet is never bigger than its star ----------

// How much bigger a star's picture is than its planets' at the very least. Over 1 because a shape off to the side of the
// view is stretched outwards a little by the perspective, by at most about a fifth in this view.
export const SIZE_MARGIN = 1.25;

// The apparent size of a sphere: the tangent of the angle it covers, seen from distance d. Its pixels are about this times
// the focal length. It's by angle and not by depth so that it means the same wherever in the view the sphere is.
function apparent(r, d) {
    return r / Math.sqrt(Math.max(d * d - r * r, 1e-12));
}

function radiusFor(a, d) {
    return (a * d) / Math.sqrt(1 + a * a);
}

const distance = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

// How far the rule bears on a sphere: all the way once any of it may be in view, tailing off to nothing outside that. A star
// out of sight is no size at all as far as the student can tell, and nothing has to look smaller than it. A planet out of
// sight needs no star to grow for it. It goes gradually, so that nothing jumps as it comes into view.
function inView(z, d, r, corner) {
    const off = Math.acos(Math.max(-1, Math.min(1, z / d)));
    return 1 - smooth(corner, corner + 0.35, off - Math.asin(Math.min(1, r / d)));
}

export function createSizes(model) {
    return {
        stars: new Float64Array(model.stars.length),
        planets: new Float64Array(model.planets.length),
        starZ: new Float64Array(model.stars.length),
        planetZ: new Float64Array(model.planets.length),
        starD: new Float64Array(model.stars.length),
        planetD: new Float64Array(model.planets.length)
    };
}

// The one place that decides how big things are drawn this frame, and the one place the hard rule is kept: seen from
// where the camera is now, every planet looks smaller than every star it goes round. This is about the picture, so what
// counts is apparent size, which takes in how far each is from the camera.
//
// Each starts at its world size or its minimum on screen. Then a star grows to stay ahead of its planets, as far as it
// has room to: it can't reach the camera or its partner, or cover a planet that's on show (while one planet is in focus,
// only that one, as the others are faded). Whatever that doesn't settle is settled by making the planet smaller.
//
// view = { cam: [x, y, z], fwd: unit vector the camera looks along, f: pixels per unit of tangent at the view's middle,
//          corner: how far the view reaches from its axis, at its corners, in radians,
//          minSize: 0 to 1, how far minimum sizes apply, planets: how far planets have faded in, focus: planet index or -1,
//          starsAt: optional, where to take the stars to be: a star merged into its smear has no one place, and sizes
//          worked out from where it happens to be this frame would jump about,
//          gone: optional, for each planet, how far it has merged into its own smear }
// out comes from createSizes: stars and planets hold world radii of the bodies, rings left out.
export function drawnSizes(model, pos, m, view, out) {
    const { cam, fwd, f, corner, minSize, focus } = view;
    const starsAt = view.starsAt || pos.stars;
    const nStars = model.stars.length;
    const nPlanets = model.planets.length;
    for (let i = 0; i < nStars; i++) {
        const p = starsAt[i];
        const z = (p[0] - cam[0]) * fwd[0] + (p[1] - cam[1]) * fwd[1] + (p[2] - cam[2]) * fwd[2];
        out.starZ[i] = z;
        out.starD[i] = Math.max(distance(p, cam), 1e-9);
        const least = z > 0 ? radiusFor((model.starFloorPx[i] * minSize) / f, z) : 0;
        out.stars[i] = Math.max(starRadius(model, i, m), least);
    }
    for (let j = 0; j < nPlanets; j++) {
        const p = pos.planets[j];
        const z = (p[0] - cam[0]) * fwd[0] + (p[1] - cam[1]) * fwd[1] + (p[2] - cam[2]) * fwd[2];
        out.planetZ[j] = z;
        out.planetD[j] = Math.max(distance(p, cam), 1e-9);
        const r = model.planetRadiiTrue[j] + (model.planetRadiiLog[j] - model.planetRadiiTrue[j]) * m;
        const least = z > 0 ? radiusFor((model.planetFloorPx[j] * minSize) / f, z) : 0;
        out.planets[j] = Math.max(r, least);
    }
    if (view.planets <= 0.001) return out;
    const { gone } = view;

    // Keep each star ahead of its planets, leaving out any that have merged into a blur and aren't drawn
    for (let j = 0; j < nPlanets; j++) {
        if (gone && gone[j] >= 0.999) continue;
        const reach = planetReach(model.planets[j].planet);
        const shown = inView(out.planetZ[j], out.planetD[j], out.planets[j] * reach, corner);
        if (shown <= 0) continue;
        const need = apparent(out.planets[j] * reach, out.planetD[j]) * SIZE_MARGIN * shown;
        const { members } = model.planets[j].node;
        for (let h = 0; h < members.length; h++) {
            const i = members[h];
            const weight = inView(out.starZ[i], out.starD[i], out.stars[i], corner);
            if (weight <= 0) continue;
            const want = radiusFor(need * weight, out.starD[i]);
            if (want > out.stars[i]) out.stars[i] = Math.max(out.stars[i], Math.min(want, roomFor(model, pos, starsAt, out, i, cam, focus)));
        }
    }
    // Then hold each planet under what its stars came to
    for (let j = 0; j < nPlanets; j++) {
        const reach = planetReach(model.planets[j].planet);
        const { members } = model.planets[j].node;
        for (let h = 0; h < members.length; h++) {
            const i = members[h];
            const weight = inView(out.starZ[i], out.starD[i], out.stars[i], corner);
            if (weight <= 0) continue;
            const most = apparent(out.stars[i], out.starD[i]) / (SIZE_MARGIN * weight);
            if (apparent(out.planets[j] * reach, out.planetD[j]) > most) out.planets[j] = radiusFor(most, out.planetD[j]) / reach;
        }
    }
    return out;
}

// How big a star can grow without getting in the way of anything on show
function roomFor(model, pos, starsAt, out, i, cam, focus) {
    const here = starsAt[i];
    let room = 0.92 * distance(here, cam);
    // A planet in close-up is what's being looked at, so far behind it a tight pair may swell into one another
    for (let k = 0; k < model.stars.length && focus < 0; k++) {
        if (k !== i) room = Math.min(room, 0.46 * distance(here, starsAt[k]));
    }
    for (let j = 0; j < model.planets.length; j++) {
        if (focus >= 0 && j !== focus) continue;
        const clear = out.planets[j] * planetReach(model.planets[j].planet);
        room = Math.min(room, 0.85 * distance(here, pos.planets[j]) - clear);
    }
    return room;
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
    if (model.body.unstable) recentreLayout(model, tDays, o);    // Centred on the stars that stay (dance_model.js)
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

// A point r AU from the middle of the system, in world units: each distance is scaled as an orbit of that size would be,
// so a comet's long orbit squeezes in log scale just as the planets' do. p holds AU in world axes; out may be p.
export function radialToWorld(model, p, m, out = [0, 0, 0]) {
    const r = Math.hypot(p[0], p[1], p[2]);
    const k = r > 0 ? ringRadius(model, r, m) / r : model.unit;
    out[0] = p[0] * k;
    out[1] = p[1] * k;
    out[2] = p[2] * k;
    return out;
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

// ---------- Fast orbits turn into steady smears ----------

function smooth(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

// The most orbits a second still drawn as a moving disc. A disc passes any one spot once per orbit (a pair of them,
// twice), so this is what keeps the flash rate down. Reduce motion holds it far lower.
export const ORBITS_PER_SECOND = 1;
export const ORBITS_PER_SECOND_REDUCED = 0.1;

// A busier orbit gets a share of that. Gas falling from one star to the other puts a stream and a bright disc beside the
// stars, and they all pass a spot each turn, from in front and from behind: up to nine flashes a turn, close up, with the
// stars big on the screen. A black hole's disc is streaked, and the streaks race past as the hole swings round its partner.
// At this share neither goes over three flashes a second, at any zoom or size of window.
export const BUSY_ORBIT_SHARE = 0.4;

export function orbitShare(model, node) {
    if (model.stream && model.stream.pair === node) return BUSY_ORBIT_SHARE;
    if (model.body.black_hole && node === model.root) return BUSY_ORBIT_SHARE;
    return 1;
}

export function createSmear(model) {
    return {
        nodes: new Map(model.nodes.map((n) => [n, { own: 0, above: 0 }])),
        stars: new Float64Array(model.stars.length),        // 0: a disc, 1: nothing but the smear
        starBlur: new Float64Array(model.stars.length),     // A disc going fast: 1 has no surface detail left to race past
        planets: new Float64Array(model.planets.length),
        planetAbove: new Float64Array(model.planets.length) // The same for whatever carries the planet's whole orbit
    };
}

// How far each orbit has merged into its smear at this clock speed (days per second). What rides on a fast orbit goes
// too: a pair on a fast wide orbit can't stay a ring that jumps about.
export function smearWeights(model, daysPerSecond, cap, out) {
    const weight = (period, sharedBy) => (period > 0 ? smooth(cap * 0.5, cap, (daysPerSecond * sharedBy) / period) : 0);
    const walk = (node, above, fastest) => {
        const entry = out.nodes.get(node);
        const period = node.flat ? model.pathPeriodDays : node.orbit ? node.orbit.period_days : 0;
        // The figure-eight's three stars share one path, so each spot on it is passed three times an orbit. A busy orbit
        // counts as faster than it is, by the same reasoning.
        entry.own = weight(period, (node.flat ? 3 : 1) / orbitShare(model, node));
        entry.above = above;
        const next = Math.max(above, entry.own);
        const rate = period > 0 ? Math.max(fastest, daysPerSecond / period) : fastest;
        if (node.children === null) {
            out.stars[node.index] = above;
            out.starBlur[node.index] = smooth(cap * 0.08, cap * 0.35, fastest);
        } else {
            node.children.forEach((child) => walk(child, next, rate));
        }
    };
    walk(model.root, 0, 0);
    model.planets.forEach((e, j) => {
        const entry = out.nodes.get(e.node);
        out.planets[j] = weight(e.planet.period_days, 1);
        out.planetAbove[j] = entry.above;
    });
    return out;
}

// ---------- Without the blur: how fast the clock may run ----------
//
// The smears above are only for Reduce motion. Without it nothing blurs, so whatever is big on the screen and going
// round fast is kept under the flash rule by slowing the clock instead: no more than three flashes a second over more
// than a quarter of a 10° field (21,824 px; the field is 341 x 256 px at 1024 x 768).
//
// A disc of radius r px swinging a px either way sweeps a band of about 4 pi a r px, and passes each spot in it once a
// turn, or twice where its path crosses itself as seen at a slant: a flash each time. Moving more than its own width
// from one frame to the next, it lands on spots here and there, each about fps r / (pi a) times a second: often enough to
// flash the whole band only if the disc is big beside its swing. If not, then whatever the turns do against the frames,
// at most the fps / 3.5 places it keeps landing on can light up more than 3.5 times a second. So a small thing may whirl
// round as fast as it likes, and something big is held to a turn or so a second.
//
// Each thing on show going round is { period: days, passes: spots passed per turn, area: px that would flash, sweep and
// jump: see flashSafeRate }, and the clock may go as fast as the slowest of them allows, once enough of them together
// would flash over the area allowed. Detail riding on a body (a star's corona, a black hole's streaks) is a thing of its
// own, passing each spot many times a turn (holdClock in system_view.js, with spacings found by measuring).
export const FLASH_AREA_PX = 21824;
export const FLASH_FIELD_PX = 341 * 256;
export const FLASHES_PER_S = 2.5;           // The most a spot may flash in a second: under three, with room to spare
const FLASH_AREA_SHARE = 0.5;               // ... and the area that may do it, as a share of the limit
const FLASH_FPS_LEAST = 60;                 // A screen that draws faster lands on more spots, so never count on fewer frames

// The band a disc of radius r px sweeps, swinging a px either way, that could flash faster than allowed. turnsPerS is how
// fast it goes round at the most it will be allowed to: past that it only gets faster. discs is how many share the band.
export function sweptArea(a, r, turnsPerS, fps, discs = 1) {
    const frames = Math.max(fps || 0, FLASH_FPS_LEAST);
    let area = 4 * Math.PI * a * r;
    const skips = (2 * Math.PI * a * turnsPerS) / frames > 2 * r;
    if (skips && (discs * frames * r) / (Math.PI * Math.max(a, 1e-6)) <= FLASHES_PER_S) {
        area = Math.min(area, (frames / 3.5) * Math.PI * r * r);
    }
    return Math.min(area, FLASH_FIELD_PX);
}

// The most days a second at which all the items together keep the rule, or Infinity if none of them can break it. Two
// ways to break it: spots flashing too often (area), and too much of the screen lighting up at once from one frame to the
// next, as the leading edge of something big sweeps across (sweep: 4 pi a r px a turn, and jump: pi r^2 px once it moves
// clear of itself each frame). fps is how often the screen is drawn: fewer frames, bigger steps.
export function flashSafeRate(items, fps = FLASH_FPS_LEAST) {
    const budget = FLASH_AREA_PX * FLASH_AREA_SHARE;
    const caps = items.filter((it) => it.period > 0 && it.passes > 0 && it.area > 0)
        .map((it) => ({ cap: (FLASHES_PER_S * it.period) / it.passes, area: it.area }))
        .sort((p, q) => p.cap - q.cap);
    let spots = Infinity;
    let area = 0;
    for (let k = 0; k < caps.length; k++) {
        area += caps[k].area;
        if (area > budget) {
            spots = caps[k].cap;
            break;
        }
    }
    return Math.min(spots, frameSafeRate(items, fps, budget));
}

// The most days a second at which what lights up between one frame and the next, all told, stays within budget. Each
// item adds sweep / (period fps) px for each day a second, until it's moving clear of itself and adds its jump.
function frameSafeRate(items, fps, budget) {
    const frames = Math.max(fps || 0, 10);
    const list = items.filter((it) => it.period > 0 && it.sweep > 0 && it.jump > 0)
        .map((it) => {
            const k = it.sweep / (it.period * frames);
            return { k, jump: it.jump, at: it.jump / k };
        })
        .sort((p, q) => p.at - q.at);
    if (list.reduce((sum, it) => sum + it.jump, 0) <= budget) return Infinity;
    let jumped = 0;
    let slope = list.reduce((sum, it) => sum + it.k, 0);
    for (let k = 0; k < list.length; k++) {
        const rate = slope > 0 ? (budget - jumped) / slope : Infinity;
        if (rate <= list[k].at) return rate;
        jumped += list[k].jump;
        slope -= list[k].k;
    }
    return Infinity;
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

// A comet's orbit for the System tab: its nearest and furthest from the middle, and Kepler's third law with the semi-major
// axis, which is what r becomes for an ellipse
export function cometReadout(model, entry) {
    const o = entry.orbit;
    const aM = o.a_AU * AU;
    const tS = o.period_days * 86400;
    const massMsun = massOf(model.stars, model.root.members);
    return {
        q_AU: o.q_AU,
        Q_AU: o.Q_AU,
        a_AU: o.a_AU,
        e: o.e,
        T_days: o.period_days,
        T_s: tS,
        a3OverT2: aM ** 3 / tS ** 2,
        GMOver4Pi2: (G * massMsun * M_SUN) / (4 * Math.PI * Math.PI),
        mass_Msun: massMsun,
        aroundStars: model.stars.length
    };
}

// Can the habitable zone be drawn for this body? The reason is shown as the switch's tooltip when it can't.
export function hzStatus(body) {
    if (!body) return { ok: false, reason: 'The habitable zone shows inside a planetary system. Enter a system to see it.' };
    if (body.black_hole || body.neutron_star) {
        return { ok: false, reason: 'No habitable zone here: the simple formula is for a single star on the main sequence.' };
    }
    if (!body.star || (body.stars && body.stars.length > 1)) {
        return { ok: false, reason: 'No habitable zone here: with more than one star, the simple formula does not apply.' };
    }
    if (body.star.stage !== 'main_sequence') {
        const kind = body.star.stage === 'white_dwarf' ? 'A white dwarf' : 'A giant';
        return { ok: false, reason: `No habitable zone here: ${kind.toLowerCase()} is not on the main sequence, so the zone moves as the star evolves and the formula does not apply.` };
    }
    return { ok: true, reason: '' };
}

// The range of the clock, in days per second, from a crawl through the shortest orbit to a visible turn of the longest.
// Fast enough, the shorter orbits merge into their smears, and the longer ones are what's left to watch. With Reduce
// motion the top is far lower. Null if nothing here goes round anything.
export function speedsFor(model, reduceMotion = false, mix = model.startLog ? 1 : 0) {
    if (model.body.unstable) return danceSpeeds(model, reduceMotion);   // No orbits: paced on its crossing time
    const periods = model.planets.map((e) => e.planet.period_days);
    // A busy orbit (orbitShare) is held to its share of the top speed, as if it were that much shorter
    const shared = [...periods];
    model.nodes.forEach((n) => {
        if (!n.orbit || !n.orbit.period_days) return;
        periods.push(n.orbit.period_days);
        shared.push(n.orbit.period_days * orbitShare(model, n));
    });
    if (model.pathPoints) periods.push(model.pathPeriodDays);
    (model.comets || []).forEach((c) => periods.push(c.orbit.period_days));
    if (!periods.length) return null;
    if (model.pathPoints) shared.push(model.pathPeriodDays);
    (model.comets || []).forEach((c) => shared.push(c.orbit.period_days));
    const shortest = Math.min(...periods);
    const longest = Math.max(...shared);
    const min = shortest / 200;
    const fastest = model.pathPoints ? 0.2 : 0.5;   // The figure-eight's stars share a path, and must stay stars at the top
    const max = longest * (reduceMotion ? ORBITS_PER_SECOND_REDUCED * 0.2 : ORBITS_PER_SECOND * fastest);
    return { min, max, speed: Math.min(max, Math.max(shortest / 8, speedToSeeMoving(model, mix))) };
}

// The orbits drawn big enough to watch in the whole-system view, as { r: radius as a share of the view's half-width, period }
function watchableOrbits(model, mix) {
    const out = [];
    model.planets.forEach((e) => out.push({ r: ringRadius(model, e.planet.orbit_AU, mix) / FRAME, period: e.planet.period_days }));
    model.nodes.forEach((n) => {
        if (!n.orbit || !n.orbit.period_days || n.flat) return;
        // The lighter side goes round furthest from the middle
        const masses = n.children.map((c) => massOf(model.stars, c.members));
        const share = Math.max(...masses) / (masses[0] + masses[1]);
        out.push({ r: (ringRadius(model, n.a_AU, mix) * share) / FRAME, period: n.orbit.period_days });
    });
    if (model.pathPoints) out.push({ r: 0.5, period: model.pathPeriodDays });
    (model.comets || []).forEach((c) => out.push({ r: ringRadius(model, c.orbit.a_AU, mix) / FRAME, period: c.orbit.period_days }));
    return out.filter((o) => o.r >= WATCHABLE_SHARE && o.period > 0);
}

// The least speed at which something on show visibly goes round: a few pixels a second at least, so a wide triple whose close
// pair is one dot at this scale still has its third star moving on arrival. Any orbit too small to see may then blur, as the
// flash cap says (smearWeights).
const WATCHABLE_SHARE = 0.05;       // An orbit this far out from the middle, as a share of the view, is about 15 px
const MOVING_SHARE_PER_S = 0.06;    // ... and this much of the view a second, about 20 px, is plainly moving

function speedToSeeMoving(model, mix) {
    const orbits = watchableOrbits(model, mix);
    if (!orbits.length) return 0;
    return Math.min(...orbits.map((o) => (MOVING_SHARE_PER_S * o.period) / (2 * Math.PI * o.r)));
}
