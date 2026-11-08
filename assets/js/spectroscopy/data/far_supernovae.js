// Supernovae seen in other galaxies (data/quotas.js SUPERNOVAE). The first sky makes its supernovae as it always did, all in
// our galaxy or just beyond it. The nearest few of each type stay. The rest hand their codes on to supernovae seen as nearly
// every real one is: in another galaxy, at its distance and redshift, a faint point on it that shows only when zoomed in. A
// type Ia peaks near absolute magnitude -19.3 and a type II near -17, so each sits on a galaxy at the distance that puts its
// peak at SUPERNOVAE.farPeakMag. A type Ia's brightness then says how far off it is, and its galaxy's redshift how fast that
// is receding. Its remnant will be far too small to see.
//
// body.supernova gains host_code: the galaxy it is in, or null for one of our own neighbourhood's.

import { stable } from '../core/rng.js';
import { fluxFromLuminosity } from '../core/phys.js';
import { vec3ToAzAlt } from '../core/sky.js';
import { DEPTH_TABLE } from '../core/depth.js';
import { dp, clamp, distanceModulus, fluxFromVisualMag } from './stellar.js';
import { supernovaBandsAt } from './band_table.js';
import { placeDeepAt } from './sky_layout.js';
import { tangentBasis, offsetVector } from '../render/layers/sky_tangent.js';
import { SUPERNOVAE } from './quotas.js';

const ABS_PEAK = { Ia: [-19.5, -19.1], II: [-17.5, -16.5] };   // As data/deep_sky.js makeSupernova draws them
const REMNANT_PC = 10;              // How big a young remnant is, for the size its shell is given: far below anything drawn
const FIELD_NS_PC = [100, 5000];    // As data/deep_sky.js makeNeutronStar first places one; data/neutron_field.js then moves it
const INTERNAL_KMS = 120;           // A supernova's own motion in its galaxy, about the galaxy's middle (one-dimensional)
const INTERNAL_LIMIT = 300;
const PLACE_TRIES = 40;
// Drawn this much fainter than its magnitude, for its depth: further than all of the first sky's (core/depth.js)
const DEPTH_DIM_MAG = DEPTH_TABLE.supernova.far * DEPTH_TABLE.supernova.kDim;

const byCode = (a, b) => (a.code < b.code ? -1 : 1);

function typeList(table) {
    const list = [];
    Object.keys(table).forEach((type) => { for (let i = 0; i < table[type]; i++) list.push(type); });
    return list;
}

// How much fainter than its peak a supernova is this many days from it, as the sky draws it (data/band_table.js)
function fadeMag(type, phase) {
    return -2.5 * Math.log10(Math.max(0.001, supernovaBandsAt({ type }, phase).visible));
}

// Which of the first sky's supernovae stay, which become far ones, and which go. supernovae: the first sky's, in the order
// they were made. Returns { near, far: [{ body, type }], gone }. The nearest of each type stay; a far one takes a code of its
// own type first, then any; a far one with no code left to take has body null, for a new one.
export function sortSupernovae(supernovae) {
    const near = new Set();
    Object.keys(SUPERNOVAE.near).forEach((type) => {
        supernovae.filter((b) => b.supernova.type === type)
            .sort((a, b) => a.distance_pc - b.distance_pc || byCode(a, b))
            .slice(0, SUPERNOVAE.near[type])
            .forEach((b) => near.add(b));
    });
    const spare = supernovae.filter((b) => !near.has(b));
    const taken = new Set();
    const far = typeList(SUPERNOVAE.far).map((type) => {
        const body = spare.find((b) => !taken.has(b) && b.supernova.type === type) || spare.find((b) => !taken.has(b)) || null;
        if (body) taken.add(body);
        return { body, type };
    });
    return { near: supernovae.filter((b) => near.has(b)), far, gone: spare.filter((b) => !taken.has(b)) };
}

// A neutron star whose supernova went: one of our galaxy's own, where it is, at a distance such stars have
export function freeNeutronStar(rng, body) {
    const ns = body.neutron_star;
    ns.remnant_of = null;
    body.distance_pc = stable(rng.logRange(FIELD_NS_PC[0], FIELD_NS_PC[1]), 5);
    body.brightness = { flux_Wm2: stable(fluxFromLuminosity(ns.luminosity_Lsun, body.distance_pc), 5), mag: body.brightness.mag };
}

// Where on its galaxy: a spot in the galaxy's own plane, seen tilted as the galaxy is drawn (render/layers/galaxies.js),
// within SUPERNOVAE.farOffset of the way out to the edge it has at its smallest, after core/depth.js has shrunk it
function spotsOn(rng, host) {
    const g = host.galaxy;
    const RAD = Math.PI / 180;
    const major = (g.size_deg / 2) * (1 - DEPTH_TABLE.galaxy.kSize);
    const flat = g.morphology === 'elliptical' ? 0.85 : Math.max(0.22, Math.cos(Math.min(g.inclination_deg, 88) * RAD));
    const c = Math.cos(g.position_angle_deg * RAD);
    const s = Math.sin(g.position_angle_deg * RAD);
    const basis = tangentBasis(host.sky.az, host.sky.alt);
    return Array.from({ length: PLACE_TRIES }, () => {
        const f = rng.range(SUPERNOVAE.farOffset[0], SUPERNOVAE.farOffset[1]);
        const angle = rng.range(0, 2 * Math.PI);
        const a = f * major * Math.cos(angle);
        const b = f * major * flat * Math.sin(angle);
        const v = offsetVector(basis, a * s - b * c, a * c + b * s);
        return vec3ToAzAlt(v[0], v[1], v[2]);
    });
}

// The far supernovae: each given a type, a peak, a phase and a galaxy, then placed on it. far: from sortSupernovae, each with
// a body (made by makeBody() where it has none). galaxies: every galaxy in the sky, laid out. layout: the sky's layout, which
// each joins. phasesTaken: the phases already used, as no two supernovae may share one. Returns the bodies.
export function makeFarSupernovae(rng, far, galaxies, layout, phasesTaken, makeBody) {
    const n = far.length;
    if (!n) return [];
    const [lo, hi] = SUPERNOVAE.farPhaseDays;
    const slots = rng.shuffle(Array.from({ length: n }, (_, i) => i));
    const used = new Set();
    const pool = galaxies.slice().sort(byCode);
    const bodies = [];
    far.forEach(({ body: given, type }, i) => {
        const r = rng.fork(`far:${i}`);
        const body = given || makeBody();
        let phase = dp(lo + ((hi - lo) / n) * (slots[i] + r.next()), 2);
        while (phasesTaken.has(phase)) phase = dp(phase + 0.01, 2);
        phasesTaken.add(phase);
        const absPeak = dp(r.range(ABS_PEAK[type][0], ABS_PEAK[type][1]), 2);
        const fade = fadeMag(type, phase);
        // Galaxies at a distance that puts the peak in range and keeps it findable now, any order but the same every time
        const fits = (g) => {
            const peak = absPeak + distanceModulus(g.distance_pc);
            return peak >= SUPERNOVAE.farPeakMag[0] && peak <= SUPERNOVAE.farPeakMag[1] && peak + fade + DEPTH_DIM_MAG <= SUPERNOVAE.farFaintestNow;
        };
        const mid = (SUPERNOVAE.farPeakMag[0] + SUPERNOVAE.farPeakMag[1]) / 2;
        const free = pool.filter((g) => !used.has(g));
        const nearest = free.slice().sort((a, b) => Math.abs(absPeak + distanceModulus(a.distance_pc) - mid) - Math.abs(absPeak + distanceModulus(b.distance_pc) - mid) || byCode(a, b));
        const candidates = [...r.shuffle(free.filter(fits)), ...nearest];
        const entry = { body, rule: 'stars' };
        body.deep = true;
        let host = null;
        for (const g of candidates) {
            setFarSupernova(body, type, absPeak, phase, g);    // Its brightness sets how far it keeps from its neighbours
            if (placeDeepAt(layout, entry, spotsOn(r, g), g)) {
                host = g;
                break;
            }
        }
        if (!host) {
            // Never at these counts; validation would say so
            host = candidates[0];
            setFarSupernova(body, type, absPeak, phase, host);
            body.sky = { az: host.sky.az, alt: host.sky.alt };
        }
        used.add(host);
        bodies.push(body);
    });
    return bodies;
}

function setFarSupernova(body, type, absPeak, phase, host) {
    const ia = type === 'Ia';
    const distance = host.distance_pc;
    const peak = dp(absPeak + distanceModulus(distance), 2);
    const sn = {
        type,
        phase0_days: phase,
        peak_mag: peak,
        abs_peak_mag: absPeak,
        peak_time: dp(-phase, 2),
        remnant_code: null,
        remnant_kind: ia ? 'none' : 'neutron_star',    // A type II's neutron star, far too faint to see from here
        shell_deg: stable((REMNANT_PC / distance) * (180 / Math.PI), 3),
        host_code: host.code
    };
    body.distance_pc = distance;
    body.radial_velocity_kms = host.radial_velocity_kms;   // Its own motion is added once its galaxy has its: setFarVelocities
    body.brightness = { flux_Wm2: fluxFromVisualMag(peak + fadeMag(type, phase)), mag: peak };
    body.supernova = sn;
}

// A far supernova moves with its galaxy, give or take its own motion in it. Run once the galaxies have their velocities.
export function setFarVelocities(rng, bodies, resolve) {
    bodies.forEach((body) => {
        const host = resolve(body.supernova.host_code);
        if (!host) return;
        const own = clamp(rng.fork(body.code).gauss(0, INTERNAL_KMS), -INTERNAL_LIMIT, INTERNAL_LIMIT);
        body.radial_velocity_kms = dp(host.radial_velocity_kms + own, 1);
    });
}

export const FAR_INTERNAL_LIMIT_KMS = INTERNAL_LIMIT;
export const FAR_DEPTH_DIM_MAG = DEPTH_DIM_MAG;
