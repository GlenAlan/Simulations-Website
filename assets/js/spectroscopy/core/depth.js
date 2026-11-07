// How far away things look. No DOM or WebGL here, so this loads in Node for tests.
//
// body.depth runs from 0 (as near as anything gets: exactly the look the sky had before depth existed) to 1 (the dome
// behind everything). Depth only ever pushes things further away. It works two ways, both render-only and fixed:
//   1. Static size: assignDepths shrinks the size fields once (see DEPTH_TABLE), so layers, picking and framing all agree.
//   2. Faintness: body.depth_dim_mag. drawMag(body) is what to draw with. body.brightness stays true for the spectrum tools.
//      The extended layers reveal things softly, so that alone wouldn't dim a bright one: they also multiply their light
//      by depthLight(body).
//
// There is no parallax as the view pans or zooms. The sky used to fake it (further things zoomed more slowly), but a
// telescope turning or zooming sees none: only the observer moving does. ETA = 0 switches that off, so parallaxFactor is
// always exactly 1 and the shaders' depthP() too; both are left in place, doing nothing. Real parallax comes instead on a
// flight into a system, where the observer really travels:
//
// Travel. Every sky shader gives each thing its distance from Earth in parsecs, travelPc(entity), as an `aPc` attribute
// (or a uniform for a pass that draws one thing), next to aDepth. The system view moves the traveller along the line to the
// system (render/system/system_view.js, travelAt in transition.js), and BAND_GLSL's travel(p, pc) moves each thing to
// where the traveller sees it and says how much nearer it is: render/shared.js. A point brightens by travelLight(near),
// something with a size grows by travelSize(near). Picking is off during a flight; engine.project(az, alt, pc) and
// projectBody(body) follow the travel, for the marks drawn over the sky as a flight begins.
//
// travelPc: a body's own distance, nudged by a few parts in a million where two would otherwise share one, because the
// shaders know the system being flown to by its distance alone. What's inside a body shares the body's, except a cluster's
// members, each of which has a place of its own in the depth of its cluster, so that flying into one opens the cluster out.
//
// The dome (sky glow, Milky Way band, background stars, horizon) is as good as infinitely far for a flight to a star. It stays
// fixed, and fades as the system takes over. A flight out of the galaxy fades it on the way: uDomeFade.

import { memberDirection } from '../render/layers/sky_tangent.js';
import { hashString } from './rng.js';

export const ETA = 0;
const FULL_FOV = 80;        // At this field of view and wider, P = 1 at every depth
const LIGHT_SHARE = 0.5;    // How much of its depth_dim_mag an extended object also loses at every zoom

// near and far: the depth of the nearest and furthest of a kind, by real distance. kSize: how much the furthest shrinks.
// kDim: how many magnitudes fainter the furthest is. A kind with neither already dims with real distance in its magnitude.
// byMag ranks by apparent brightness instead, for a kind whose distance and magnitude have nothing to do with each other: a
// comet's looks are all that say how near it is, and with its biggest among its faintest they read as one flat layer.
export const DEPTH_TABLE = {
    comet: { near: 0, far: 0.4, kSize: 0.7, kDim: 2.5, byMag: true },  // Only two now, both our own: not far apart
    nebula: { near: 0, far: 1, kSize: 0.5, kDim: 1.5 },
    cluster: { near: 0, far: 1, kSize: 0.5, kDim: 1.5 },
    // Galaxies are the faintest things there are: any dimmer and the furthest would stay below the deepest zoom's limit, a
    // core with no shape
    galaxy: { near: 0.2, far: 1, kSize: 0.35, kDim: 1 },
    supernova: { near: 0, far: 0.8, kSize: 0.4, kDim: 1 },
    star: { near: 0, far: 1, kSize: 0, kDim: 0 },
    binary: { near: 0, far: 1, kSize: 0, kDim: 0 },
    multiple: { near: 0, far: 1, kSize: 0, kDim: 0 },
    rogue_planet: { near: 0, far: 1, kSize: 0, kDim: 0 },
    neutron_star: { near: 0.1, far: 0.9, kSize: 0, kDim: 0 },   // One a supernova left behind takes that supernova's depth instead
    black_hole: { near: 0.1, far: 0.9, kSize: 0, kDim: 0 },
    quasar: { near: 0.8, far: 1, kSize: 0, kDim: 0 },
    home_planet: { near: 0, far: 0, kSize: 0, kDim: 0 }
};

// ETA * ln(min(fov, 80) / 80): the engine keeps this in the uParallaxLog uniform
export function parallaxLog(fov) {
    return ETA * Math.log(Math.min(fov, FULL_FOV) / FULL_FOV);
}

export function parallaxFactor(depth, fov) {
    return Math.exp(depth * parallaxLog(fov));
}

// The magnitude to draw with. Works on a body, or on anything inside one that assignDepths reached (a cluster member).
export function drawMag(entity) {
    return entity.brightness.mag + (entity.depth_dim_mag || 0);
}

// What an extended object's own light is multiplied by for being far away: 1 at depth 0
export function depthLight(entity) {
    return 10 ** (-0.4 * LIGHT_SHARE * (entity.depth_dim_mag || 0));
}

// Nearest first. A row of one sits at its kind's near end. Ties go by code, so the order never depends on the list's.
// The first sky's bodies rank among themselves, exactly as they did before the deeper sky was added (body.deep, see
// data/universe.js), so they keep their looks. A deeper body takes the depth its distance would have among them: most are
// further than all of them, so they sit at the far end, small and dim.
function rankDepths(list, row) {
    const rank = row.byMag ? (body) => body.brightness.mag : (body) => body.distance_pc;
    const sorted = list.filter((b) => !b.deep).sort((a, b) => rank(a) - rank(b) || (a.code < b.code ? -1 : 1));
    const last = Math.max(1, sorted.length - 1);
    const depthAt = (i) => row.near + ((row.far - row.near) * i) / last;
    sorted.forEach((body, i) => { body.depth = depthAt(i); });
    const keys = sorted.map(rank);
    list.forEach((body) => {
        if (!body.deep) return;
        const x = rank(body);
        let hi = 0;
        while (hi < keys.length && keys[hi] <= x) hi++;
        if (hi === 0) body.depth = row.near;
        else if (hi === keys.length) body.depth = row.far;
        else {
            const lo = hi - 1;
            const f = keys[hi] > keys[lo] ? (x - keys[lo]) / (keys[hi] - keys[lo]) : 0;
            body.depth = depthAt(lo + f);
        }
    });
}

function scaleSizes(body, scale) {
    if (body.nebula) body.nebula.size_deg *= scale;
    if (body.galaxy) body.galaxy.size_deg *= scale;
    if (body.comet) {
        body.comet.coma_deg *= scale;
        body.comet.tail_deg *= scale;
    }
    if (body.supernova) body.supernova.shell_deg *= scale;
    if (body.cluster) {
        body.cluster.radius_deg *= scale;
        body.cluster.members.forEach((member) => {
            member.offset_deg.x *= scale;
            member.offset_deg.y *= scale;
            if (member.stars) member.visual_sep_deg *= scale;
        });
    }
}

// Where a cluster's member lies along the line of sight, in parsecs from its cluster's middle: somewhere in a ball as wide
// as the cluster is drawn across the sky, which is where its place on the sky puts it. Fixed by its code.
function memberReachPc(body, member) {
    const R = body.cluster.radius_deg * (Math.PI / 180) * body.distance_pc;
    const across = (Math.hypot(member.offset_deg.x, member.offset_deg.y) * (Math.PI / 180) * body.distance_pc);
    const ball = Math.max(R * 1.2, across * 1.05);
    const h = (hashString(`travel:${member.code}`) / 4294967296) * 2 - 1;
    return h * Math.sqrt(ball * ball - across * across);
}

// What's inside a body is as far away as the body is. A cluster member may also carry a depth_offset, a little either way.
// A member's depth is its own: entity.depth. So is its distance for a flight: entity.travel_pc (see Travel above).
function passDown(body, unique) {
    const inside = [
        ...(body.planets || []),
        ...(body.stars || []),
        ...(body.black_hole ? [body.black_hole.companion] : []),
        ...(body.nucleus ? [body.nucleus, ...body.nucleus.nucleus.stars] : []),
        ...(body.cluster ? body.cluster.members : [])
    ];
    inside.forEach((entity) => {
        entity.depth = Math.max(0, body.depth + (entity.depth_offset || 0));
        entity.depth_dim_mag = body.depth_dim_mag;
        entity.travel_pc = entity.kind === 'cluster_member' || entity.in_cluster
            ? unique(body.distance_pc + memberReachPc(body, entity))
            : body.travel_pc;
        // A binary member is a system of its own, and shrinking its cluster has moved it
        if (entity.in_cluster) {
            entity.sky = memberDirection(body, entity);
            entity.stars.forEach((star) => {
                star.depth = entity.depth;
                star.depth_dim_mag = body.depth_dim_mag;
                star.travel_pc = entity.travel_pc;
            });
        }
    });
}

// A body's distance for a flight, as the sky's layers are given it: see Travel above
export function travelPc(entity) {
    return entity.travel_pc || entity.distance_pc;
}

// Sets body.depth and body.depth_dim_mag on every body, and shrinks the render-only size fields. Run once, right after
// generateUniverse and before anything is drawn, so nothing has to know the sizes were ever otherwise.
export function assignDepths(universe) {
    if (universe.depthsAssigned) return;
    universe.depthsAssigned = true;
    const kinds = new Map();
    universe.bodies.forEach((body) => {
        if (!kinds.has(body.kind)) kinds.set(body.kind, []);
        kinds.get(body.kind).push(body);
    });
    kinds.forEach((list, kind) => rankDepths(list, DEPTH_TABLE[kind] || DEPTH_TABLE.star));

    // A neutron star stays with the supernova that left it, so that the pair doesn't drift apart when zooming
    universe.bodies.forEach((body) => {
        const parent = body.neutron_star && body.neutron_star.remnant_of;
        const resolved = parent ? universe.resolve(parent) : null;
        if (resolved) body.depth = resolved.body.depth;
    });

    // Distances for a flight: each its own, as a shader sees it, in single precision
    const taken = new Set();
    const unique = (pc) => {
        let x = pc;
        for (let k = 1; taken.has(Math.fround(x)); k++) x = pc * (1 + k * 1e-5);
        taken.add(Math.fround(x));
        return x;
    };
    universe.bodies.forEach((body) => { body.travel_pc = unique(body.distance_pc); });

    universe.bodies.forEach((body) => {
        const row = DEPTH_TABLE[body.kind] || DEPTH_TABLE.star;
        body.depth_dim_mag = row.kDim * body.depth;
        if (row.kSize) scaleSizes(body, 1 - row.kSize * body.depth);
        passDown(body, unique);
    });
}
