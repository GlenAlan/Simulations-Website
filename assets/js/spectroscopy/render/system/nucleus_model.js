// A galaxy's central black hole, entered as a system of its own: the hole, with its disc, and the few stars on close
// orbits round it (data/nuclei.js). Plain data, so it runs under Node; render/system/nucleus_view.js has the looks.
//
// nucleusSystem(nucleus, galaxy) -> a body in the shape the system view reads: { code, kind: 'nucleus', sky, depth, stars,
// orbits, nucleus, host, planets: [] }, where stars[0] is the hole in the shape of a star (stage 'black_hole', with
// supermassive: true) and the rest are the close stars. The orbits are the data's own, so data/orbits.js places them.

const systems = new WeakMap();

// The disc's temperature as the hole's picture shows it. A feeding hole's thin disc is far hotter than any star, so it
// is drawn at the hottest the picture shows, blue-white. A starved one has no thin disc, only a faint, thick swirl of
// thin hot gas that gives off little light at all: drawn warm and dim.
const DRAWN_HOT_K = 40000;
const DRAWN_QUIET_K = 3800;

function holeAsStar(n) {
    return {
        stage: 'black_hole',
        supermassive: true,
        mass_Msun: n.mass_Msun,
        teff_K: n.active ? Math.min(DRAWN_HOT_K, n.disc_T_K || DRAWN_HOT_K) : DRAWN_QUIET_K,
        radius_Rsun: 1,         // Its drawn size is worked out from its stars' orbits: see supermassiveRadius
        luminosity_Lsun: 0
    };
}

export function nucleusSystem(nucleus, galaxy) {
    let system = systems.get(nucleus);
    if (!system) {
        const n = nucleus.nucleus;
        system = {
            code: nucleus.code,
            kind: 'nucleus',
            sky: galaxy.sky,
            depth: galaxy.depth || 0,
            depth_dim_mag: nucleus.depth_dim_mag || 0,
            distance_pc: nucleus.distance_pc,
            radial_velocity_kms: nucleus.radial_velocity_kms,
            brightness: nucleus.brightness,
            bands: nucleus.bands,
            visual_seed: nucleus.visual_seed,
            nucleus: n,
            host: galaxy,
            stars: [{ code: nucleus.code, kind: 'star_component', star: holeAsStar(n) }, ...n.stars],
            orbits: n.orbits,
            planets: []
        };
        systems.set(nucleus, system);
    }
    return system;
}

// The nucleus a selection leads into: the nucleus itself, or one of its close stars. Null for anything else.
export function nucleusSystemOf(resolved) {
    if (!resolved || !resolved.body || !resolved.body.nucleus) return null;
    const { body, path, entity } = resolved;
    if (path === 'nucleus') return nucleusSystem(entity, body);
    if (path === 'component' && body.kind === 'galaxy') return nucleusSystem(body.nucleus, body);
    return null;
}

// How big the hole is drawn: well inside where its nearest star ever comes, so that star never sweeps across the disc,
// and never more than a fifth of the view
const HOLE_SHARE = 0.5;
const HOLE_MOST = 0.22;
export function supermassiveRadius(model, ringRadius, frame, m) {
    const inner = model.body.orbits[0];
    const nearest = ringRadius(model, inner.a_AU, m) * (1 - (inner.ecc || 0));
    return Math.min(HOLE_MOST * frame, HOLE_SHARE * nearest);
}

// The close stars are points of light beside the hole, a fraction of a star's usual drawn size
export const CLOSE_STAR_SHARE = 0.3;
export const CLOSE_STAR_FLOOR_PX = 4;
