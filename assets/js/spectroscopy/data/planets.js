// Planets and their systems (spec 8.3). The habitable zone is worked out from luminosity for every host, even where
// the panel's formula doesn't apply to it (giants, white dwarfs, multi-star systems), so that no random planet can
// sit in one with water on it however the system is built.
//
// A planet:
//   type          one of the keys of PLANET_TYPES, or an opaque id for a hard-coded type
//   type_label    plain words, for the catalogue values
//   host          the code of the body it orbits; orbit_centre_stars lists star indices if it circles only some of them
//   surface       { ocean_fraction, rock, ice, red_edge_nm, subsurface_ocean }
//                 rock: 'silicate'|'iron'|'basalt'|'iron_oxide'|'molten'; ice: null|'water'|'methane_nitrogen'
//   clouds        { kind, cover }, kind: null|'H2O'|'H2SO4'|'NH3'|'dust'
//   rings         null or { inner_Rp, outer_Rp, tilt_deg, opacity }
//   T_surface_K   null for planets with no solid surface
//   brightness    reflected starlight only: planets aren't drawn in the sky, but tools can read it

import { stable } from '../core/rng.js';
import { keplerPeriodDays, hzEdges, AU, R_EARTH } from '../core/phys.js';
import { dp, RSUN_AU } from './stellar.js';

const EARTH_RADIUS_AU = R_EARTH / AU;

export const PLANET_TYPES = {
    sub_neptune: { share: 0.2, label: 'Sub-Neptune' },
    rocky_airless: { share: 0.15, label: 'Rocky, airless' },
    gas_giant: { share: 0.12, label: 'Gas giant' },
    thin_co2: { share: 0.1, label: 'Thin CO₂ (Mars-like)' },
    ice_giant: { share: 0.1, label: 'Ice giant' },
    thick_co2: { share: 0.08, label: 'Thick CO₂ (Venus-like)' },
    desert: { share: 0.07, label: 'Desert world' },
    frozen_ocean: { share: 0.05, label: 'Frozen ocean world' },
    hot_jupiter: { share: 0.05, label: 'Hot Jupiter' },
    lava_world: { share: 0.04, label: 'Lava world' },
    ice_dwarf: { share: 0.04, label: 'Ice dwarf' }
};

// How many planets a system has (spec 7.2): buckets with exact counts, a number drawn inside each
export const PLANET_COUNT_BUCKETS = [
    { share: 0.35, draw: () => 1 },
    { share: 0.35, draw: (rng) => rng.int(2, 3) },
    { share: 0.22, draw: (rng) => rng.int(4, 6) },
    { share: 0.08, draw: (rng) => rng.weighted([[7, 5], [8, 4], [9, 1]]) }
];

// The closest orbit a planet is ever given, in stellar radii (spec: giants reach 4.65 AU, O stars 0.07 AU)
export const MIN_STELLAR_RADII = 2.5;
// Orbits inside these fractions of sqrt(L) are hot enough for each type: about 850 K and 950 K. Both are well under
// 0.3 x the zone's inner edge (0.29 sqrt(L)), so the spec's placement rule holds for every host.
const HOT_JUPITER_LIMIT = 0.1;
const LAVA_LIMIT = 0.08;
const HOT_LIMIT_SQRT_L = HOT_JUPITER_LIMIT;

export function hostContext(body, info) {
    const L = info.luminosity_Lsun;
    return {
        code: body.code,
        L,
        M: info.mass_Msun,
        teff: info.teff_K,
        rStarAU: info.radius_Rsun * RSUN_AU,
        mainSequenceSingle: info.mainSequenceSingle,
        hz: hzEdges(L),
        sqrtL: Math.sqrt(L),
        floorAU: info.floorAU,
        rv: body.radial_velocity_kms,
        distance: body.distance_pc,
        flux: body.brightness.flux_Wm2,
        mag: body.brightness.mag
    };
}

function lowestOrbit(ctx) {
    return Math.max(MIN_STELLAR_RADII * ctx.rStarAU, ctx.floorAU || 0);
}

// Which types an orbit may hold. Hot types go only inside the hot limit, and only where they clear the star: a gas
// giant at the surface of a tiny red dwarf isn't an orbit. Cold types go only beyond the outer edge of the zone.
function allowedTypes(a, ctx) {
    const { hz, sqrtL } = ctx;
    if (a < HOT_LIMIT_SQRT_L * sqrtL) {
        const list = ['rocky_airless'];
        const low = lowestOrbit(ctx);
        if (a >= low + 80 * EARTH_RADIUS_AU) list.push('hot_jupiter');
        if (a < LAVA_LIMIT * sqrtL && a >= low + 10 * EARTH_RADIUS_AU) list.push('lava_world');
        return list;
    }
    if (a < hz.inner) {
        const list = ['rocky_airless', 'thick_co2', 'sub_neptune', 'gas_giant'];
        if (a > 0.6 * sqrtL) list.push('desert');
        return list;
    }
    if (a <= hz.outer) return ['rocky_airless', 'thin_co2', 'desert', 'sub_neptune', 'gas_giant', 'thick_co2'];
    const list = ['gas_giant', 'ice_giant', 'ice_dwarf', 'frozen_ocean', 'sub_neptune', 'rocky_airless'];
    if (a < 4 * sqrtL) list.push('thin_co2');
    if (a < 2.5 * sqrtL) list.push('desert');
    return list;
}

// Chooses by how far each allowed type is behind its share of the planets so far, so the sky's totals land on the
// table's shares even though each orbit can only hold some of the types
function pickType(rng, a, ctx, tally) {
    const weights = allowedTypes(a, ctx).map((type) => {
        const due = PLANET_TYPES[type].share * (tally.total + 12) - (tally.counts[type] || 0);
        return [type, Math.max(0.01, due)];
    });
    return rng.weighted(weights);
}

function rockyMass(rng, radius, density = 1) {
    return stable(density * radius ** 3.3 * rng.range(0.8, 1.2), 3);
}

// Everything but the orbit, by type. inHz is the numeric zone, whichever kind of host this is
const BUILDERS = {
    sub_neptune(rng, inHz) {
        const radius = rng.range(1.8, 3.8);
        const H2 = rng.range(80, 88);
        const CH4 = rng.range(0.5, 2);
        const CO2 = rng.range(0.1, 1);
        const ppm = {};
        if (!inHz && rng.chance(0.35)) ppm.H2O = rng.range(50, 800);
        return {
            radius,
            mass: stable(2.7 * radius ** 1.3 * rng.range(0.8, 1.2), 3),
            albedo: rng.range(0.3, 0.5),
            pressure: 100,
            pct: { H2, He: 100 - H2 - CH4 - CO2, CH4, CO2 },
            ppm
        };
    },
    rocky_airless(rng) {
        const radius = rng.range(0.3, 1.6);
        return {
            radius,
            mass: rockyMass(rng, radius),
            albedo: rng.range(0.06, 0.2),
            pressure: 0,
            surface: { rock: rng.weighted([['silicate', 6], ['iron', 2], ['basalt', 3]]) }
        };
    },
    gas_giant(rng) {
        const H2 = rng.range(85, 87);
        return {
            radius: rng.range(7, 13),
            mass: stable(rng.logRange(30, 2000), 3),
            albedo: rng.range(0.3, 0.6),
            pressure: 100,
            pct: { H2, He: 100 - H2 },
            ppm: { CH4: rng.range(1000, 4000), NH3: rng.range(100, 700) }
        };
    },
    thin_co2(rng) {
        const radius = rng.range(0.4, 1.1);
        const CO2 = rng.range(94, 96);
        const N2 = rng.range(2, 4);
        return {
            radius,
            mass: rockyMass(rng, radius, 0.75),
            albedo: rng.range(0.15, 0.3),
            pressure: stable(rng.logRange(0.003, 0.08), 3),
            pct: { CO2, N2, Ar: 100 - CO2 - N2 },
            surface: { rock: 'iron_oxide' },
            clouds: { kind: 'dust', cover: rng.range(0, 0.15) },
            opacity: 0.1
        };
    },
    ice_giant(rng) {
        const H2 = rng.range(78, 81);
        const CH4 = rng.range(1.5, 2.5);
        return {
            radius: rng.range(3.3, 5),
            mass: rng.range(12, 25),
            albedo: rng.range(0.35, 0.5),
            pressure: 100,
            pct: { H2, He: 100 - H2 - CH4, CH4 }
        };
    },
    thick_co2(rng) {
        const radius = rng.range(0.7, 1.2);
        const CO2 = rng.range(95.5, 97);
        return {
            radius,
            mass: rockyMass(rng, radius, 0.9),
            albedo: rng.range(0.6, 0.8),
            pressure: rng.range(30, 110),
            pct: { CO2, N2: 100 - CO2 },
            ppm: { SO2: rng.range(80, 300), H2SO4: rng.range(5, 50) },
            surface: { rock: 'basalt' },
            clouds: { kind: 'H2SO4', cover: 1 },
            opacity: 100
        };
    },
    desert(rng) {
        const radius = rng.range(0.6, 1.4);
        const CO2 = rng.range(15, 40);
        const Ar = rng.range(1, 5);
        const O2 = rng.chance(0.55) ? rng.range(0.1, 5) : 0;
        const pct = { N2: 100 - CO2 - Ar - O2, CO2, Ar };
        if (O2 > 0) pct.O2 = O2;
        return {
            radius,
            mass: rockyMass(rng, radius, 0.9),
            albedo: rng.range(0.25, 0.4),
            pressure: stable(rng.logRange(0.2, 3), 3),
            pct,
            surface: { rock: 'silicate' },
            clouds: { kind: 'dust', cover: rng.range(0.05, 0.35) },
            opacity: 0.6
        };
    },
    frozen_ocean(rng) {
        const radius = rng.range(0.4, 1.2);
        return {
            radius,
            mass: stable(0.6 * radius ** 3 * rng.range(0.85, 1.15), 3),
            albedo: rng.range(0.6, 0.85),
            pressure: 0,
            surface: { rock: 'silicate', ice: 'water', subsurface_ocean: true }
        };
    },
    hot_jupiter(rng, inHz, tGuess) {
        const H2 = rng.range(85, 86.5);
        const ppm = { Na: rng.range(2, 6), K: rng.range(0.2, 0.6), H2O: rng.range(200, 800), CO: rng.range(300, 900) };
        if (tGuess > 1700) ppm.TiO = rng.range(1, 5);
        return {
            radius: rng.range(10, 20),
            mass: stable(rng.logRange(100, 3000), 3),
            albedo: rng.range(0.03, 0.12),
            pressure: 100,
            pct: { H2, He: 100 - H2 },
            ppm
        };
    },
    lava_world(rng) {
        const radius = rng.range(0.7, 1.7);
        const Na = rng.range(50, 70);
        const SiO = rng.range(15, 35);
        return {
            radius,
            mass: rockyMass(rng, radius, 1.1),
            albedo: rng.range(0.05, 0.15),
            pressure: stable(rng.logRange(0.001, 0.1), 3),
            pct: { Na, SiO, K: 100 - Na - SiO },
            surface: { rock: 'molten' }
        };
    },
    ice_dwarf(rng) {
        const radius = rng.range(0.15, 0.6);
        const CH4 = rng.range(2, 8);
        const CO = rng.range(1, 5);
        return {
            radius,
            mass: stable(0.3 * radius ** 3 * rng.range(0.85, 1.15), 3),
            albedo: rng.range(0.5, 0.9),
            pressure: stable(rng.logRange(0.00001, 0.001), 3),
            pct: { N2: 100 - CH4 - CO, CH4, CO },
            surface: { rock: 'silicate', ice: 'methane_nitrogen' }
        };
    }
};

function roundAll(values, places) {
    const out = {};
    Object.keys(values || {}).forEach((key) => { out[key] = dp(values[key], places); });
    return out;
}

// Greenhouse warming from a rough optical depth; sqrt(sqrt()) keeps it exact in every browser
function surfaceTemperature(tEq, opacity) {
    return tEq * Math.sqrt(Math.sqrt(1 + 0.75 * opacity));
}

function equilibriumTemperature(L, a, albedo) {
    return 278.5 * Math.sqrt(Math.sqrt(L * (1 - albedo))) / Math.sqrt(a);
}

function assemble(code, type, label, a, f, ctx, massForPeriod, extras) {
    const periodDays = stable(keplerPeriodDays(a, massForPeriod), 6);
    const hz = ctx.hz;
    const tEq = stable(equilibriumTemperature(ctx.L, a, f.albedo), 4);
    const reflected = f.albedo * ((f.radius * EARTH_RADIUS_AU) / (2 * a)) ** 2;
    return {
        code,
        kind: 'planet',
        type,
        type_label: label,
        host: ctx.code,
        orbit_centre_stars: extras.orbit_centre_stars || null,
        orbit_AU: a,
        period_days: periodDays,
        phase0: extras.phase0,
        inclination_deg: extras.inclination_deg,
        radius_Rearth: stable(f.radius, 4),
        mass_Mearth: stable(f.mass, 4),
        gravity_g: stable(f.mass / (f.radius * f.radius), 3),
        albedo: dp(f.albedo, 3),
        in_hz: ctx.mainSequenceSingle && a >= hz.inner && a <= hz.outer,
        T_eq_K: tEq,
        T_surface_K: f.tSurface,
        pressure_bar: f.pressure,
        day_length_h: dp(f.dayLength, 1),
        tidally_locked: !!f.locked,
        atmosphere_pct: f.pct,
        atmosphere_ppm: f.ppm,
        surface: f.surface,
        clouds: f.clouds,
        rings: f.rings || null,
        host_teff_K: ctx.teff,
        host_luminosity_Lsun: ctx.L,
        host_mass_Msun: massForPeriod,
        radial_velocity_kms: ctx.rv,
        distance_pc: ctx.distance,
        brightness: {
            flux_Wm2: stable(ctx.flux * reflected, 4),
            mag: dp(ctx.mag - 2.5 * Math.log10(reflected), 2)
        },
        bands: null,                 // Set last of all, from band_table.js
        visual_seed: code
    };
}

function makePlanet(rng, code, type, a, ctx) {
    const inHz = a >= ctx.hz.inner && a <= ctx.hz.outer;
    const tGuess = equilibriumTemperature(ctx.L, a, 0.1);
    const raw = BUILDERS[type](rng, inHz, tGuess);
    const tEq = equilibriumTemperature(ctx.L, a, raw.albedo);
    const giant = type === 'gas_giant' || type === 'ice_giant' || type === 'hot_jupiter' || type === 'sub_neptune';
    const locked = type === 'hot_jupiter' || type === 'lava_world' || a < 0.1 * ctx.sqrtL;
    const period = keplerPeriodDays(a, ctx.M);
    const f = {
        radius: raw.radius,
        mass: raw.mass,
        albedo: raw.albedo,
        pressure: stable(raw.pressure, 4),
        locked,
        dayLength: locked ? period * 24 : giant ? rng.range(8, 22) : rng.range(12, 200),
        pct: roundAll(raw.pct, 2),
        ppm: roundAll(raw.ppm, 2),
        surface: { ocean_fraction: 0, rock: 'silicate', ice: null, red_edge_nm: null, subsurface_ocean: false, ...raw.surface },
        clouds: raw.clouds ? { kind: raw.clouds.kind, cover: dp(raw.clouds.cover, 2) } : { kind: null, cover: 0 },
        tSurface: giant ? null : dp(surfaceTemperature(tEq, raw.opacity || 0), 0)
    };
    if (type === 'gas_giant' && tEq < 300) f.clouds = { kind: 'NH3', cover: dp(rng.range(0.55, 0.95), 2) };
    const ringChance = type === 'gas_giant' ? 0.28 : type === 'ice_giant' ? 0.15 : 0;
    if (tEq < 350 && rng.chance(ringChance)) {
        const inner = rng.range(1.25, 1.6);
        f.rings = { inner_Rp: dp(inner, 2), outer_Rp: dp(inner * rng.range(1.25, 1.9), 2), tilt_deg: dp(rng.range(-28, 28), 1), opacity: dp(rng.range(0.25, 0.85), 2) };
    }
    return assemble(code, type, PLANET_TYPES[type].label, a, f, ctx, ctx.M, {
        phase0: dp(rng.next(), 5),
        inclination_deg: dp(rng.range(-3, 3), 2)
    });
}

// A planet from fixed values, for the hard-coded systems. Only the orbit's phase is seeded.
export function planetFromSpec(rng, spec, ctx, extras = {}) {
    const massForPeriod = extras.massForPeriod ?? ctx.M;
    const type = spec.type;
    const f = {
        radius: spec.radius_Rearth,
        mass: spec.mass_Mearth,
        albedo: spec.albedo,
        pressure: spec.pressure_bar,
        locked: !!spec.tidally_locked,
        dayLength: spec.day_length_h,
        pct: spec.atmosphere_pct || {},
        ppm: spec.atmosphere_ppm || {},
        surface: { ocean_fraction: 0, rock: 'silicate', ice: null, red_edge_nm: null, subsurface_ocean: false, ...spec.surface },
        clouds: spec.clouds || { kind: null, cover: 0 },
        rings: spec.rings || null,
        tSurface: spec.T_surface_K ?? null
    };
    const label = spec.type_label || PLANET_TYPES[type].label;
    return assemble(spec.code, type, label, spec.orbit_AU, f, ctx, massForPeriod, {
        phase0: dp(rng.next(), 5),
        inclination_deg: dp(rng.range(-3, 3), 2),
        orbit_centre_stars: extras.orbit_centre_stars
    });
}

// Orbits spaced by a ratio of 1.4 to 2.0. The first is drawn further out when there are few planets, so that lone
// planets aren't all hot ones; none goes inside the host's lowest safe orbit. fixedAU, if given, keeps one orbit.
function orbitLadder(rng, n, ctx, fixedAU) {
    const low = lowestOrbit(ctx);
    const orbits = [];
    if (fixedAU) {
        orbits.push(fixedAU);
        let inner = fixedAU;
        let outer = fixedAU;
        while (orbits.length < n) {
            const ratio = rng.range(1.4, 2);
            if (rng.chance(0.4) && inner / ratio >= low) {
                inner /= ratio;
                orbits.unshift(stable(inner, 6));
                inner = orbits[0];
            } else {
                outer *= ratio;
                orbits.push(stable(outer, 6));
                outer = orbits[orbits.length - 1];
            }
        }
        return orbits;
    }
    const spread = n === 1 ? 9 : n <= 3 ? 3 : n <= 6 ? 1.2 : 0.6;
    const lo = Math.max(0.03 * ctx.sqrtL, low);
    // About one system in four starts close in, where the hot types live
    const hotStart = rng.chance(0.25);
    const hi = Math.max(lo * 1.5, Math.min((hotStart ? 0.09 : spread) * ctx.sqrtL, 100));
    let a = stable(rng.logRange(lo, hi), 6);
    orbits.push(a);
    for (let i = 1; i < n; i++) {
        a = stable(a * rng.range(1.4, 2), 6);
        orbits.push(a);
    }
    return orbits;
}

// The random planets of one system. fixed = { orbit_AU, planet } keeps a hard-coded one in its place in the ladder.
export function makeSystemPlanets(rng, nextCode, ctx, n, tally, fixed = null) {
    const orbits = orbitLadder(rng, n, ctx, fixed ? fixed.orbit_AU : null);
    return orbits.map((a) => {
        if (fixed && a === fixed.orbit_AU) {
            addToTally(tally, fixed.planet.type);
            return fixed.planet;
        }
        const type = pickType(rng, a, ctx, tally);
        addToTally(tally, type);
        return makePlanet(rng, nextCode(), type, a, ctx);
    });
}

export function addToTally(tally, type) {
    if (PLANET_TYPES[type]) tally.counts[type] = (tally.counts[type] || 0) + 1;
    tally.total++;
}
