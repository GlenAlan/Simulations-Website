// Multi-star systems: random binaries and hierarchical triples, and the two hard-coded showcase systems (spec 7.3, 7.4).
//
// A multi-star body:
//   kind           'binary' for a plain pair; 'multiple' for anything with more stars
//   architecture   'binary'|'hierarchical_triple'|'figure_eight'|'double_double'
//   stars[]        { code, kind: 'star_component', parent, star, distance_pc, radial_velocity_kms, brightness, ... }
//   orbits[]       { a: [i..], b: [j..], a_AU, period_days, ecc, inc_deg, omega_deg, phase0 }, innermost first, widest
//                  last; pairs groups of stars[] by index (see data/orbits.js). The figure-eight has one entry with
//                  shared_path: true, empty a and b and no a_AU: it gives the period, but draw figureEightPath().
//   interacting    a close pair passing mass across: bright in X-rays
//   transfer       null or { donor, accretor }: star indices of the interacting pair
//   figure_eight   null or { period_days, inc_deg, phase0 }
//   pairs          null or [{ label, codes, offset_deg: { x, y } }]: the double-double's two pairs, drawn as two points
//                  when zoomed in (one point otherwise)
//   visual_sep_deg how far apart the widest pair could be drawn when zoomed right in (stylised)

import { stable } from '../core/rng.js';
import { keplerPeriodDays } from '../core/phys.js';
import { dp, clamp, RSUN_AU, makeClassStar, makeRedGiant, makeWhiteDwarf, starFromMass, makeComposition, fixedStar,
    absoluteVisual, apparentMag, combineMags } from './stellar.js';
import { settleSystem } from './dynamics.js';

// Primaries of random systems, roughly by how common such systems are in catalogues
const PRIMARY_CLASSES = [['B', 4], ['A', 8], ['F', 12], ['G', 18], ['K', 22], ['M', 30], ['WD', 3], ['GIANT', 3]];

// How close two stars can be without touching, as a multiple of the sum of their radii
const MIN_SEPARATION_RADII = 2.5;
// Below this multiple they're close enough to pass mass across
const TRANSFER_RADII = 3.2;
const FIXED_INC_DEG = 62;

function smallestSeparation(a, b) {
    return MIN_SEPARATION_RADII * (a.radius_Rsun + b.radius_Rsun) * RSUN_AU;
}

function component(code, parent, star) {
    return { code, kind: 'star_component', parent, star, visual_seed: code };
}

function makeOrbit(rng, a, b, aAU, massTotal, opts = {}) {
    const ecc = opts.circular ? 0 : rng.chance(0.3) ? dp(rng.range(0.05, 0.4), 3) : 0;
    return {
        a,
        b,
        a_AU: stable(aAU, 5),
        period_days: stable(keplerPeriodDays(aAU, massTotal), 6),
        ecc,
        inc_deg: dp(rng.range(20, 85), 2),
        omega_deg: ecc ? dp(rng.range(0, 360), 1) : 0,
        phase0: dp(rng.next(), 5)
    };
}

// Primary of a random system, then a partner drawn by mass ratio; all share a birth cloud. forced: a class to use instead.
function drawPrimary(rng, population, composition, forced = null) {
    const cls = forced || rng.weighted(PRIMARY_CLASSES);
    if (cls === 'WD') return makeWhiteDwarf(rng, { population, composition });
    if (cls === 'GIANT') return makeRedGiant(rng, { population, composition, maxMass: 3 });
    const maxMass = population === 'II' ? 0.92 : undefined;
    return makeClassStar(rng, cls, { population, composition, maxMass });
}

function drawPartner(rng, primaryMass, population, composition) {
    const low = 0.09;
    const mass = stable(clamp(primaryMass * rng.range(0.25, 1), low, Math.min(primaryMass, 8)), 4);
    return starFromMass(rng, mass, { population, composition });
}

function primaryPopulation(rng) {
    return rng.chance(0.15) ? 'II' : 'I';
}

// A random binary or hierarchical triple, ready for a position and brightness. wantsPlanets keeps the orbits tight
// enough for planets to circle the whole system at a sensible distance. canPass: false keeps it from being one of the few
// pairs that pass mass across. Drawn as it always was, then settled by data/dynamics.js so that it could really exist.
// For the added sky (data/quotas.js EXTRA) only: passing makes its inner pair one that passes mass across, primary gives the
// class of its first star, and widestAU lets a plain pair be drawn out to that separation instead of 3 AU.
export function makeRandomMulti(rng, nextCode, code, triple, wantsPlanets, { canPass = true, passing = false, primary = null, widestAU = null } = {}) {
    let population = primaryPopulation(rng);
    let composition = makeComposition(rng, population);
    let s0 = drawPrimary(rng, population, composition, primary);
    // Metal-poor stars are old: a massive primary can't be one
    if (population === 'II' && s0.mass_Msun > 1) {
        population = 'I';
        composition = makeComposition(rng, population);
        s0 = drawPrimary(rng, population, composition, primary);
    }
    const s1 = drawPartner(rng, Math.max(s0.mass_Msun, 0.15), population, composition);
    const mass01 = s0.mass_Msun + s1.mass_Msun;

    const floor = smallestSeparation(s0, s1);
    const hiInner = wantsPlanets ? (triple ? 0.1 : 0.5) : triple ? 0.6 : widestAU || 3;
    const aInner = stable(rng.logRange(Math.max(0.02, floor * 1.02), Math.max(hiInner, floor * 2)), 5);
    const inner = makeOrbit(rng, [0], [1], aInner, mass01, { circular: aInner < 0.2 });
    const parts = [s0, s1];
    const orbits = [inner];

    if (triple) {
        const s2 = drawPartner(rng, Math.max(s0.mass_Msun, 0.15), population, composition);
        parts.push(s2);
        const total = mass01 + s2.mass_Msun;
        // Stable hierarchy: outer period at least ten times the inner, which also puts the third star well clear
        const ratio = stable(rng.logRange(wantsPlanets ? 10.5 : 12, wantsPlanets ? 80 : 900), 5);
        const outerPeriod = inner.period_days * ratio;
        const years = outerPeriod / 365.25;
        const aOuter = stable(Math.cbrt(total * years * years), 5);
        const orbit = makeOrbit(rng, [0, 1], [2], aOuter, total);
        orbits.push(orbit);
    }

    const stars = parts.map((star) => component(nextCode(), code, star));
    const closeEnough = aInner <= TRANSFER_RADII * (s0.radius_Rsun + s1.radius_Rsun) * RSUN_AU || aInner < 0.05;
    const system = {
        kind: triple ? 'multiple' : 'binary',
        architecture: triple ? 'hierarchical_triple' : 'binary',
        stars,
        orbits,
        interacting: false,
        transfer: null,
        figure_eight: null,
        pairs: null,
        visual_sep_deg: dp(rng.range(0.02, 0.06), 3),
        planets: []
    };
    return settleSystem(rng.fork('settle'), system, { passing: passing || (closeEnough && canPass), planets: wantsPlanets });
}

// A pair from two stars that already exist, for a cluster's binary members: the same shape as a random binary
export function makePairOf(rng, nextCode, code, s0, s1, visualSepDeg, { canPass = true } = {}) {
    const floor = smallestSeparation(s0, s1);
    const aInner = stable(rng.logRange(Math.max(0.02, floor * 1.02), Math.max(8, floor * 2)), 5);
    const orbit = makeOrbit(rng, [0], [1], aInner, s0.mass_Msun + s1.mass_Msun, { circular: aInner < 0.2 });
    const closeEnough = aInner <= TRANSFER_RADII * (s0.radius_Rsun + s1.radius_Rsun) * RSUN_AU || aInner < 0.05;
    const system = settleSystem(rng.fork(`settle:${code}`), {
        kind: 'binary',
        architecture: 'binary',
        stars: [s0, s1].map((star) => component(nextCode(), code, star)),
        orbits: [orbit],
        interacting: false,
        transfer: null,
        figure_eight: null,
        pairs: null,
        visual_sep_deg: 0,
        planets: []
    }, { passing: closeEnough && canPass });
    system.visual_sep_deg = visualSepDeg(orbit.period_days);
    return system;
}

// Combined light of a system's stars, and how far away it has to be for a target magnitude
export function systemAbsoluteMag(stars) {
    return combineMags(stars.map((s) => absoluteVisual(s.star.luminosity_Lsun, s.star.teff_K)));
}

export function systemLuminosity(stars) {
    return stable(stars.reduce((sum, s) => sum + s.star.luminosity_Lsun, 0), 5);
}

export function systemMass(stars) {
    return stable(stars.reduce((sum, s) => sum + s.star.mass_Msun, 0), 5);
}

// The widest orbit, for keeping planets out of the way
export function widestOrbitAU(orbits) {
    return orbits.reduce((max, o) => Math.max(max, o.a_AU), 0);
}

export function fillComponentFields(body, fluxOf) {
    body.stars.forEach((s) => {
        const absV = absoluteVisual(s.star.luminosity_Lsun, s.star.teff_K);
        s.distance_pc = body.distance_pc;
        s.radial_velocity_kms = body.radial_velocity_kms;
        s.brightness = { flux_Wm2: fluxOf(s.star.luminosity_Lsun, body.distance_pc), mag: apparentMag(absV, body.distance_pc) };
    });
}

const SOLAR_MIX = { X: 0.71, Y: 0.27, Z: 0.02, metallicity_dex: 0, metals_dex: { Fe: 0, Ca: 0, Na: 0, Mg: 0, Si: 0, Ti: 0, C: 0, N: 0, O: 0 } };

// F8Q3ZN: three identical stars chasing each other round one path. Its orbit lives in data/orbits.js.
export function makeFigureEightSystem(code) {
    const prefix = code.slice(0, 5);
    const stars = ['A', 'B', 'C'].map((letter) => component(`${prefix}${letter}`, code, fixedStar({
        class: 'K', subclass: 0, luminosity_class: 'V', teff_K: 5250, mass_Msun: 0.8, radius_Rsun: 0.85, luminosity_Lsun: 0.45,
        vsini_kms: 3, age_Myr: 3000, composition: SOLAR_MIX
    })));
    return {
        kind: 'multiple',
        architecture: 'figure_eight',
        stars,
        orbits: [{ a: [], b: [], period_days: 365.25, ecc: 0, inc_deg: FIXED_INC_DEG, omega_deg: 0, phase0: 0, shared_path: true }],
        interacting: false,
        transfer: null,
        figure_eight: { period_days: 365.25, inc_deg: FIXED_INC_DEG, phase0: 0 },
        pairs: null,
        visual_sep_deg: 0.03,
        planets: []
    };
}

// D2W7XK: two close pairs orbiting each other from far away
export function makeDoubleDoubleSystem(code) {
    const prefix = code.slice(0, 5);
    const spec = [
        ['A', { class: 'F', subclass: 5, teff_K: 6500, mass_Msun: 1.3, radius_Rsun: 1.3, vsini_kms: 12 }],
        ['B', { class: 'G', subclass: 2, teff_K: 5800, mass_Msun: 1, radius_Rsun: 1, vsini_kms: 6 }],
        ['C', { class: 'K', subclass: 0, teff_K: 5250, mass_Msun: 0.8, radius_Rsun: 0.85, luminosity_Lsun: 0.45, vsini_kms: 4 }],
        ['D', { class: 'M', subclass: 2, teff_K: 3500, mass_Msun: 0.4, radius_Rsun: 0.45, vsini_kms: 3 }]
    ];
    const stars = spec.map(([letter, v]) => component(`${prefix}${letter}`, code, fixedStar({
        luminosity_class: 'V', age_Myr: 1800, composition: SOLAR_MIX, ...v
    })));
    const orbit = (a, b, aAU, massTotal, inc, phase0) => ({
        a,
        b,
        a_AU: aAU,
        period_days: stable(keplerPeriodDays(aAU, massTotal), 6),
        ecc: 0,
        inc_deg: inc,
        omega_deg: 0,
        phase0
    });
    return {
        kind: 'multiple',
        architecture: 'double_double',
        stars,
        orbits: [
            orbit([0], [1], 0.06, 2.3, 68, 0.13),
            orbit([2], [3], 0.08, 1.2, 74, 0.58),
            orbit([0, 1], [2, 3], 150, 3.5, 40, 0.3)
        ],
        interacting: false,
        transfer: null,
        figure_eight: null,
        pairs: [
            { label: 'A', codes: [stars[0].code, stars[1].code], offset_deg: { x: -0.05, y: 0.02 } },
            { label: 'B', codes: [stars[2].code, stars[3].code], offset_deg: { x: 0.05, y: -0.02 } }
        ],
        visual_sep_deg: 0.11,
        planets: []
    };
}
