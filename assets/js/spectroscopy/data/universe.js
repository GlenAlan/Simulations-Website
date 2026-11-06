// FOUNDATION STUB, replaced by the data track. It is also the executable schema: every field below keeps its
// name and meaning in the real generator, which may only add fields. It has the right counts and kinds but
// none of the spec's special systems, placement rules, spoiler protection or validation.
//
// Units are in the field names. Sky positions are degrees (core/sky.js). All of this is plain data with no DOM.

import { Rng, DEFAULT_SEED } from '../core/rng.js';
import { MIN_ALT, galacticLatitude } from '../core/sky.js';
import { fluxFromLuminosity, keplerPeriodDays, hzEdges, logG, H0, C_KMS, wienPeakNm } from '../core/phys.js';

const STAR_TYPES = [
    // class, count, T lo/hi, mass lo/hi, radius lo/hi, lum lo/hi, vsini lo/hi, chance of planets
    ['O', 11, 30000, 50000, 16, 60, 7, 15, 30000, 800000, 100, 300, 0.05],
    ['B', 23, 10000, 30000, 2.5, 16, 2, 7, 25, 30000, 100, 250, 0.15],
    ['A', 40, 7500, 10000, 1.6, 2.5, 1.5, 2.5, 5, 50, 80, 200, 0.35],
    ['F', 52, 6000, 7500, 1.1, 1.6, 1.1, 1.5, 1.5, 5, 20, 100, 0.55],
    ['G', 74, 5200, 6000, 0.8, 1.1, 0.85, 1.15, 0.6, 1.5, 1, 20, 0.65],
    ['K', 92, 3700, 5200, 0.45, 0.8, 0.6, 0.9, 0.08, 0.6, 1, 10, 0.7],
    ['M', 218, 2400, 3700, 0.08, 0.45, 0.1, 0.6, 0.0001, 0.08, 1, 10, 0.75],
    ['WD', 34, 5000, 100000, 0.5, 1.2, 0.01, 0.01, 0.0001, 0.1, 1, 50, 0.2],
    ['G3', 29, 3500, 30000, 1, 40, 10, 1000, 50, 1000000, 1, 20, 0.3]
];

const OTHER_COUNTS = {
    rogue_planet: 117, binary: 102, comet: 10, nebula: 45, cluster: 40, neutron_star: 35, galaxy: 35,
    black_hole: 25, supernova: 15, quasar: 3
};

function makeCode(rng, used) {
    let code;
    do code = rng.code(); while (used.has(code));
    used.add(code);
    return code;
}

// Roughly V magnitude from luminosity and distance; the real generator computes this properly
function apparentMag(luminosityLsun, distancePc) {
    return 4.83 - 2.5 * Math.log10(Math.max(1e-6, luminosityLsun)) + 5 * Math.log10(distancePc / 10);
}

function brightness(luminosityLsun, distancePc) {
    return { flux_Wm2: fluxFromLuminosity(luminosityLsun, distancePc), mag: apparentMag(luminosityLsun, distancePc) };
}

function skyPosition(rng, towardsBand) {
    for (;;) {
        const az = rng.range(0, 360);
        const alt = (Math.asin(rng.next()) * 180) / Math.PI; // Even coverage of the dome
        if (alt < MIN_ALT) continue;
        const lat = Math.abs(galacticLatitude(az, alt));
        const keep = towardsBand === true ? Math.exp(-(lat * lat) / 900) + 0.08
            : towardsBand === false ? Math.min(1, lat / 25) : 1;
        if (rng.next() < keep) return { az, alt };
    }
}

function makeStar(rng, row, cls = row[0]) {
    const t = rng.next();
    const lerp = (lo, hi) => lo + (hi - lo) * t;
    const logLerp = (lo, hi) => lo * (hi / lo) ** t;
    const teff = rng.range(row[2], row[3]);
    const mass = lerp(row[4], row[5]);
    const radius = cls === 'WD' ? 0.01 : logLerp(row[6], row[7]);
    const stage = cls === 'WD' ? 'white_dwarf' : cls === 'G3' ? 'giant' : 'main_sequence';
    return {
        class: cls === 'WD' ? 'D' : cls === 'G3' ? (teff > 8000 ? 'B' : teff > 5000 ? 'G' : 'K') : cls,
        subclass: rng.int(0, 9),
        luminosity_class: stage === 'main_sequence' ? 'V' : stage === 'giant' ? 'III' : 'D',
        stage,                                     // 'main_sequence'|'giant'|'supergiant'|'white_dwarf'
        teff_K: teff,
        mass_Msun: mass,
        radius_Rsun: radius,
        luminosity_Lsun: logLerp(row[8], row[9]),
        logg: logG(mass, radius),
        vsini_kms: rng.range(row[10], row[11]),
        population: 'I',                           // 'I'|'II'|'peculiar'
        peculiar: null,                            // null|'carbon'|...
        wd_type: cls === 'WD' ? 'DA' : null,       // 'DA'|'DB'|'DZ'|'DQ' for white dwarfs
        age_Myr: rng.logRange(50, 9000),
        composition: {
            X: 0.71, Y: 0.27, Z: 0.02,
            metals_dex: { Fe: 0, Ca: 0, Na: 0, Mg: 0, Ti: 0, C: 0, N: 0, O: 0, Si: 0 }
        }
    };
}

function makePlanet(rng, used, host, a, massMsun, luminosity) {
    const hz = hzEdges(luminosity);
    const type = rng.pick(['sub_neptune', 'rocky_airless', 'gas_giant', 'thin_co2', 'ice_giant', 'thick_co2', 'desert']);
    const gas = type === 'gas_giant' || type === 'ice_giant' || type === 'sub_neptune';
    return {
        code: makeCode(rng, used),
        kind: 'planet',
        type,                                       // See spec 8.3; see the data track for the ids
        type_label: type.replace('_', ' '),         // Plain words, for the catalogue values
        host: host.code,
        orbit_AU: a,
        period_days: keplerPeriodDays(a, massMsun),
        phase0: rng.next(),                         // Orbit position at t = 0, as a fraction of a period
        inclination_deg: rng.range(-3, 3),
        radius_Rearth: gas ? rng.range(3, 11) : rng.range(0.5, 1.8),
        mass_Mearth: gas ? rng.range(10, 300) : rng.range(0.1, 5),
        albedo: rng.range(0.1, 0.6),
        in_hz: a >= hz.inner && a <= hz.outer,      // Only ever true for main-sequence hosts
        T_eq_K: 278 * Math.sqrt(Math.sqrt(luminosity) / a) * 0.9,
        pressure_bar: gas ? 100 : 0,
        day_length_h: rng.range(8, 60),
        atmosphere_pct: gas ? { H2: 86, He: 14 } : {},
        atmosphere_ppm: {},
        surface: { ocean_fraction: 0, rock: 'silicate', ice: null, red_edge_nm: null },
        clouds: { kind: null, cover: 0 },           // kind: null|'H2O'|'H2SO4'|'NH3'|'dust'
        rings: null,                                // null or { inner_Rp, outer_Rp, tilt_deg, opacity }
        bands: { radio: 0, ir: 0.5, visible: 0.5, uv: 0.05, xray: 0 },
        visual_seed: ''
    };
}

export function generateUniverse(seed = DEFAULT_SEED) {
    const rng = new Rng(seed);
    const used = new Set();
    const bodies = [];
    const base = (kind, towardsBand, distancePc, velocity) => {
        const code = makeCode(rng, used);
        return {
            code,
            kind,
            sky: skyPosition(rng, towardsBand),
            distance_pc: distancePc,
            radial_velocity_kms: velocity,
            bands: { radio: 0, ir: 0.5, visible: 1, uv: 0.2, xray: 0.05 }, // Relative strength in each band, 0..1
            brightness: brightness(1, distancePc),   // flux_Wm2 is the measured total; mag is apparent visible
            visual_seed: code
        };
    };

    STAR_TYPES.forEach((row) => {
        for (let i = 0; i < row[1]; i++) {
            const star = makeStar(rng, row);
            const body = base('star', true, rng.logRange(8, 2500), rng.range(-300, 300));
            body.star = star;
            body.brightness = brightness(star.luminosity_Lsun, body.distance_pc);
            body.planets = [];
            const peak = wienPeakNm(star.teff_K);
            body.bands = {
                radio: 0.02,
                ir: Math.min(1, peak / 900),
                visible: 1,
                uv: Math.min(1, 200 / peak),
                xray: star.teff_K > 25000 ? 0.1 : 0.02
            };
            if (rng.chance(row[12]) && star.stage === 'main_sequence') {
                let a = Math.max(0.03, 0.2 * Math.sqrt(star.luminosity_Lsun));
                const n = rng.int(1, 5);
                for (let p = 0; p < n; p++) {
                    body.planets.push(makePlanet(rng, used, body, a, star.mass_Msun, star.luminosity_Lsun));
                    a *= rng.range(1.4, 2.0);
                }
                body.planets.forEach((planet) => { planet.visual_seed = planet.code; });
            }
            bodies.push(body);
        }
    });

    const mainRow = STAR_TYPES[4];
    for (let i = 0; i < OTHER_COUNTS.binary; i++) {
        const body = base('binary', true, rng.logRange(10, 1500), rng.range(-100, 100));
        const a = { code: makeCode(rng, used), kind: 'star_component', parent: body.code, star: makeStar(rng, mainRow) };
        const b = { code: makeCode(rng, used), kind: 'star_component', parent: body.code, star: makeStar(rng, STAR_TYPES[5]) };
        const massSum = a.star.mass_Msun + b.star.mass_Msun;
        const aAU = rng.logRange(0.02, 3);
        body.architecture = 'binary';              // 'binary'|'hierarchical_triple'|'figure_eight'|'double_double'
        body.stars = [a, b];
        // Each orbit pairs members of stars[] by index; hierarchical systems nest them (see the data track)
        body.orbits = [{ a: [0], b: [1], a_AU: aAU, period_days: keplerPeriodDays(aAU, massSum), ecc: 0, inc_deg: rng.range(20, 85), omega_deg: 0, phase0: rng.next() }];
        body.interacting = aAU < 0.05;             // Mass transfer: bright in X-rays
        body.planets = [];
        body.brightness = brightness(a.star.luminosity_Lsun + b.star.luminosity_Lsun, body.distance_pc);
        bodies.push(body);
    }

    for (let i = 0; i < OTHER_COUNTS.rogue_planet; i++) {
        const body = base('rogue_planet', null, rng.logRange(3, 60), rng.range(-40, 40));
        body.rogue_planet = { type: rng.pick(['gas_giant', 'sub_neptune', 'ice_dwarf']), teff_K: rng.range(40, 400), radius_Rearth: rng.range(1, 11), mass_Mearth: rng.range(1, 300) };
        body.bands = { radio: 0, ir: 0.5, visible: 0, uv: 0, xray: 0 };
        body.brightness = { flux_Wm2: 1e-14, mag: 99 };
        bodies.push(body);
    }
    for (let i = 0; i < OTHER_COUNTS.comet; i++) {
        const body = base('comet', null, rng.range(1e-5, 1e-4), rng.range(-30, 30));
        body.comet = { emission_lines: [{ w: 388.3, rel: 1, label: 'CN' }, { w: 516.5, rel: 0.8, label: 'C₂' }, { w: 589.0, rel: 0.4, label: 'Na D' }], coma_deg: rng.range(0.1, 0.5), tail_deg: rng.range(2, 9), dust_ratio: rng.next() };
        body.brightness.mag = rng.range(2, 8);
        body.bands = { radio: 0.1, ir: 0.8, visible: 1, uv: 0.8, xray: 0.05 };
        bodies.push(body);
    }
    for (let i = 0; i < OTHER_COUNTS.nebula; i++) {
        const body = base('nebula', true, rng.logRange(300, 5000), rng.range(-50, 50));
        const type = rng.weighted([['emission', 60], ['planetary', 25], ['dark', 8], ['reflection', 7]]);
        body.nebula = {
            type,                                  // 'emission'|'planetary'|'dark'|'reflection'
            emission_lines: type === 'dark' || type === 'reflection' ? [] : [{ w: 656.28, rel: 1, label: 'Hα' }, { w: 486.13, rel: 0.35, label: 'Hβ' }, { w: 500.68, rel: type === 'planetary' ? 2 : 0.5, label: '[O III]' }, { w: 495.9, rel: type === 'planetary' ? 0.7 : 0.17, label: '[O III]' }, { w: 658.35, rel: 0.3, label: '[N II]' }],
            size_deg: type === 'planetary' ? rng.range(0.3, 0.9) : rng.range(1.5, 7),
            central_star: null                     // A star block for planetary nebulae (a white dwarf)
        };
        body.brightness.mag = rng.range(4, 10);
        body.bands = { radio: 0.5, ir: 0.9, visible: 1, uv: 0.3, xray: 0.05 };
        bodies.push(body);
    }
    for (let i = 0; i < OTHER_COUNTS.cluster; i++) {
        const body = base('cluster', true, rng.logRange(150, 8000), rng.range(-120, 120));
        const type = rng.chance(0.8) ? 'open' : 'globular';
        const n = rng.int(30, 150);
        body.cluster = { type, age_Myr: type === 'open' ? rng.logRange(5, 800) : rng.range(9000, 13000), radius_deg: type === 'open' ? rng.range(0.4, 1.6) : rng.range(0.2, 0.6), members: [] };
        for (let m = 0; m < n; m++) {
            const star = makeStar(rng, STAR_TYPES[rng.int(2, 6)]);
            const ang = rng.range(0, Math.PI * 2);
            const r = body.cluster.radius_deg * Math.sqrt(rng.next());
            body.cluster.members.push({ code: makeCode(rng, used), kind: 'cluster_member', parent: body.code, offset_deg: { x: r * Math.cos(ang), y: r * Math.sin(ang) }, star, brightness: brightness(star.luminosity_Lsun, body.distance_pc) });
        }
        body.brightness.mag = rng.range(4, 9);
        bodies.push(body);
    }
    for (let i = 0; i < OTHER_COUNTS.neutron_star; i++) {
        const body = base('neutron_star', true, rng.logRange(100, 5000), rng.range(-300, 300));
        const pulsar = rng.chance(0.6);
        body.neutron_star = { pulsar, pulse_period_s: pulsar ? rng.logRange(0.001, 5) : null, gamma: pulsar && rng.chance(0.2), remnant_of: null, teff_K: rng.logRange(3e5, 2e6) };
        body.bands = { radio: pulsar ? 1 : 0, ir: 0, visible: 0.02, uv: 0.1, xray: 0.7 };
        body.brightness.mag = 17;
        bodies.push(body);
    }
    for (let i = 0; i < OTHER_COUNTS.galaxy; i++) {
        const dMpc = rng.logRange(10, 1000);
        const velocity = H0 * dMpc + rng.range(-300, 300);
        const body = base('galaxy', false, dMpc * 1e6, velocity);
        body.galaxy = { morphology: rng.weighted([['spiral', 60], ['elliptical', 30], ['irregular', 10]]), inclination_deg: rng.range(0, 85), position_angle_deg: rng.range(0, 180), size_deg: rng.range(0.3, 2.2), z: velocity / C_KMS, radio_lobes: rng.chance(0.1), active_nucleus: rng.chance(0.15) };
        body.brightness.mag = rng.range(8, 16);
        body.bands = { radio: body.galaxy.radio_lobes ? 0.8 : 0.05, ir: 0.6, visible: 1, uv: 0.4, xray: body.galaxy.active_nucleus ? 0.6 : 0.02 };
        bodies.push(body);
    }
    for (let i = 0; i < OTHER_COUNTS.black_hole; i++) {
        const body = base('black_hole', true, rng.logRange(300, 6000), rng.range(-120, 120));
        const companion = { code: makeCode(rng, used), kind: 'star_component', parent: body.code, star: makeStar(rng, STAR_TYPES[rng.int(3, 5)]) };
        const massBH = rng.range(3, 30);
        const aAU = rng.range(0.1, 0.5);
        const period = keplerPeriodDays(aAU, massBH + companion.star.mass_Msun);
        body.black_hole = { mass_Msun: massBH, companion, period_days: period, K_kms: rng.range(50, 300), inc_deg: rng.range(30, 80), phase0: rng.next(), jets: rng.chance(0.3) };
        body.bands = { radio: body.black_hole.jets ? 0.6 : 0.03, ir: 0.3, visible: 0.5, uv: 0.5, xray: 1 };
        body.brightness = brightness(companion.star.luminosity_Lsun, body.distance_pc);
        bodies.push(body);
    }
    for (let i = 0; i < OTHER_COUNTS.supernova; i++) {
        const body = base('supernova', true, rng.logRange(1000, 8000), rng.range(-100, 100));
        const type = i % 2 ? 'II' : 'Ia';
        body.supernova = { type, phase0_days: rng.range(-15, 400), peak_mag: rng.range(0, 6), remnant_code: null, shell_deg: rng.range(0.1, 0.5) };
        body.brightness.mag = body.supernova.peak_mag;
        body.bands = { radio: 0.3, ir: 0.8, visible: 1, uv: 0.7, xray: 0.5 };
        bodies.push(body);
    }
    for (let i = 0; i < OTHER_COUNTS.quasar; i++) {
        const z = rng.range(0.5, 4);
        const body = base('quasar', false, (z * C_KMS / H0) * 1e6, z * C_KMS);
        body.quasar = { z, radio_loud: i === 0, blazar: false };
        body.bands = { radio: i === 0 ? 1 : 0.05, ir: 0.5, visible: 0.3, uv: 1, xray: 0.9 };
        body.brightness.mag = rng.range(13, 16);
        bodies.push(body);
    }
    ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'].forEach((name, i) => {
        const body = base('home_planet', null, 5e-6, 0);
        body.name = name;
        body.planet = makePlanet(rng, used, body, [0.39, 0.72, 1.52, 5.2, 9.58, 19.2, 30.1][i], 1, 1);
        body.planet.in_hz = false;
        body.planet.code = body.code;
        body.brightness.mag = [0, -3.5, 0.5, -2.2, 0.5, 5.7, 7.8][i];
        bodies.push(body);
    });

    const byCode = new Map();
    const register = (entity, body, path) => byCode.set(entity.code, { entity, body, path });
    bodies.forEach((body) => {
        register(body, body, 'body');
        (body.planets || []).forEach((planet) => register(planet, body, 'planet'));
        (body.stars || []).forEach((star) => register(star, body, 'component'));
        if (body.black_hole) register(body.black_hole.companion, body, 'component');
        if (body.cluster) body.cluster.members.forEach((member) => register(member, body, 'member'));
    });

    return {
        seed,
        bodies,                    // The 1,000 sky bodies and the 7 home planets
        cometTailAz: 90,           // Every comet's tail points away from a Sun below the horizon on this bearing
        counts: {},
        resolve(code) {            // Any code, any case: { entity, body, path } or null
            return byCode.get(String(code).trim().toUpperCase()) || null;
        },
        allCodes() {
            return [...byCode.keys()];
        }
    };
}
