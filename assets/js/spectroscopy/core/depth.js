// How far away things look. No DOM or WebGL here, so this loads in Node for tests.
//
// body.depth runs from 0 (as near as anything gets: exactly the look the sky had before depth existed) to 1 (the dome
// behind everything). Depth only ever pushes things further away. It works three ways, all render-only:
//   1. Static size: assignDepths shrinks the size fields once (see DEPTH_TABLE), so layers, picking and framing all agree.
//   2. Faintness: body.depth_dim_mag. drawMag(body) is what to draw with. body.brightness stays true for the spectrum tools.
//   3. Zoom: parallaxFactor(depth, fov), or P. Below a field of view of 80 degrees further things zoom more slowly, because
//      they are drawn P times as far from the centre of the view. So P = 1 at the centre, and the sky keeps moving apart.
//
// Adding a sky shader? Give it the depth explicitly: an `aDepth` attribute per instance or per point, set from body.depth,
// or a uniform if the pass draws one body. Never rely on a missing attribute reading as 0. BAND_GLSL has depthP(d):
//   Something sized on the sky:   gl_Position.xy *= depthP(aDepth);
//   A sprite sized in pixels:     clip.xy *= depthP(aDepth);  before adding the quad's offset, so faint stars keep their size.
//   Anything the shader works out from uPxPerRad is really uPxPerRad * depthP(aDepth) on screen.
//   The dome (sky, horizon, grid, scenery) is depth 1: depthP(1.0).
//
// Finding a body on screen: engine.projectBody(body), or engine.project(az, alt, depth) for a point near one (a cluster
// member, a tail). engine.project(az, alt) alone means depth 0. Candidates from a layer's picks() carry { depth }, and their
// radiusPx is a real one, so scale by parallaxFactor(depth, frame.fov).
//
// ETA = 0 is the kill switch: every P becomes 1, and everything is where it was before depth existed.

export const ETA = 0.1;
const FULL_FOV = 80;        // At this field of view and wider, P = 1 at every depth

// near and far: the depth of the nearest and furthest of a kind, by real distance. kSize: how much the furthest shrinks.
// kDim: how many magnitudes fainter the furthest is. A kind with neither already dims with real distance in its magnitude.
export const DEPTH_TABLE = {
    comet: { near: 0, far: 1, kSize: 0.7, kDim: 2.5 },
    nebula: { near: 0, far: 1, kSize: 0.5, kDim: 1.5 },
    cluster: { near: 0, far: 1, kSize: 0.5, kDim: 1.5 },
    galaxy: { near: 0.2, far: 1, kSize: 0.45, kDim: 1.5 },
    supernova: { near: 0, far: 0.8, kSize: 0.4, kDim: 1 },
    star: { near: 0, far: 1, kSize: 0, kDim: 0 },
    binary: { near: 0, far: 1, kSize: 0, kDim: 0 },
    multiple: { near: 0, far: 1, kSize: 0, kDim: 0 },
    rogue_planet: { near: 0, far: 1, kSize: 0, kDim: 0 },
    neutron_star: { near: 0.1, far: 0.9, kSize: 0, kDim: 0 },   // Those with a remnant's parent take its depth instead
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

// Nearest first. A row of one sits at its kind's near end. Ties go by code, so the order never depends on the list's.
function rankDepths(list, row) {
    const sorted = list.slice().sort((a, b) => a.distance_pc - b.distance_pc || (a.code < b.code ? -1 : 1));
    const last = Math.max(1, sorted.length - 1);
    sorted.forEach((body, i) => { body.depth = row.near + ((row.far - row.near) * i) / last; });
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
        });
    }
}

// What's inside a body is as far away as the body is
function passDown(body) {
    const inside = [
        ...(body.planets || []),
        ...(body.stars || []),
        ...(body.black_hole ? [body.black_hole.companion] : []),
        ...(body.cluster ? body.cluster.members : [])
    ];
    inside.forEach((entity) => {
        entity.depth = body.depth;
        entity.depth_dim_mag = body.depth_dim_mag;
    });
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

    universe.bodies.forEach((body) => {
        const row = DEPTH_TABLE[body.kind] || DEPTH_TABLE.star;
        body.depth_dim_mag = row.kDim * body.depth;
        if (row.kSize) scaleSizes(body, 1 - row.kSize * body.depth);
        passDown(body);
    });
}
