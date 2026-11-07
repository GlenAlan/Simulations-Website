// Everything in the sky that isn't a plain star or multi-star system (spec 7.3). Each function fills in the kind's own
// block on a body that already has its code, returning the fallback band strengths the sky uses until band_table.js
// sets the real ones. Sky positions come later (data/sky_layout.js).
//
// body.nebula       { type: 'emission'|'planetary'|'dark'|'reflection', emission_lines[], size_deg, central_star, dust,
//                     star_forming }. central_star is a star block: ionising O or B star, a planetary's white dwarf, or
//                     the star a reflection nebula scatters. Dark nebulae have null.
// body.neutron_star { pulsar, pulse_period_s, gamma, remnant_of, teff_K, radius_km, mass_Msun, luminosity_Lsun,
//                     magnetic_tilt_deg }
// body.galaxy       { morphology, inclination_deg, position_angle_deg, size_deg, z, radio_lobes, active_nucleus,
//                     distance_Mpc, abs_mag, luminosity_Lsun }
// body.black_hole   { mass_Msun, companion, a_AU, period_days, K_kms, inc_deg, phase0, jets, disc_tilt_deg }.
//                     K_kms is the companion's true velocity amplitude, K = 2 pi a1 sin i / P.
// body.supernova    { type: 'Ia'|'II', phase0_days, peak_mag, abs_peak_mag, peak_time, remnant_code, remnant_kind,
//                     shell_deg }. phase0_days is days after peak at t = 0, so peak_time = -phase0_days.
// body.quasar       { z, radio_loud, blazar, luminosity_distance_pc, luminosity_Lsun }
// body.comet        { emission_lines[], coma_deg, tail_deg, dust_ratio, heliocentric_AU }
// body.rogue_planet { type, teff_K, radius_Rearth, mass_Mearth, atmosphere_pct, atmosphere_ppm, luminosity_Lsun }

import { stable } from '../core/rng.js';
import { keplerPeriodDays, fluxFromLuminosity, orbitalSpeedKms, H0, C_KMS, PC, AU, L_SUN, R_EARTH, SIGMA, R_SUN } from '../core/phys.js';
import { dp, luminosityFromRT, absoluteVisual, apparentMag, distanceForMag, fluxFromVisualMag, distanceModulus,
    makeClassStar, makeWhiteDwarf } from './stellar.js';
import { supernovaMag } from './lightcurve.js';

function line(w, rel, label) {
    return { w, rel: dp(rel, 3), label };
}

function nebulaLines(rng, type) {
    if (type === 'dark' || type === 'reflection') return [];
    // [O III] 495.9 is always a third of 500.7: they share an upper level. Likewise Hbeta is about 0.35 of Halpha.
    const oxygen = type === 'planetary' ? rng.range(1.2, 3) : rng.range(0.2, 1.1);
    const nitrogen = type === 'planetary' ? rng.range(0.1, 0.6) : rng.range(0.15, 0.5);
    return [
        line(656.28, 1, 'Hα'),
        line(486.13, rng.range(0.3, 0.38), 'Hβ'),
        line(500.68, oxygen, '[O III]'),
        line(495.89, oxygen / 3, '[O III]'),
        line(658.35, nitrogen, '[N II]')
    ];
}

export function makeNebula(rng, body, type) {
    const planetary = type === 'planetary';
    const distance = stable(type === 'dark' ? rng.logRange(150, 1000) : rng.logRange(300, planetary ? 4000 : 3000), 5);
    const rv = dp(rng.range(-50, 50), 1);
    let central = null;
    if (type === 'emission') central = makeClassStar(rng, rng.chance(0.55) ? 'O' : 'B');
    else if (type === 'reflection') central = makeClassStar(rng, rng.chance(0.75) ? 'B' : 'A');
    else if (planetary) {
        // Freshly exposed, so very hot and still somewhat puffed up
        central = makeWhiteDwarf(rng, { wd_type: 'DA', T: stable(rng.logRange(30000, 100000), 4), R: dp(rng.range(0.012, 0.03), 4), age: rng.range(600, 8000) });
    }
    const mag = dp(type === 'emission' ? rng.range(2.5, 7.5) : planetary ? rng.range(5, 10) : rng.range(4.5, 9), 3);
    body.distance_pc = distance;
    body.radial_velocity_kms = rv;
    body.brightness = { flux_Wm2: fluxFromVisualMag(mag), mag };
    body.nebula = {
        type,
        emission_lines: nebulaLines(rng, type),
        size_deg: dp(planetary ? rng.range(0.3, 0.9) : rng.range(1.5, 7), 3),
        central_star: central,
        dust: dp(type === 'dark' ? rng.range(0.8, 1) : planetary ? rng.range(0.05, 0.2) : rng.range(0.25, 0.7), 2),
        star_forming: type === 'emission'
    };
    if (type === 'dark') return { radio: 0.2, ir: 0.9, visible: 0.15, uv: 0, xray: 0 };
    if (type === 'reflection') return { radio: 0.05, ir: 0.6, visible: 0.7, uv: 0.4, xray: 0.02 };
    if (planetary) return { radio: 0.2, ir: 0.5, visible: 1, uv: 0.7, xray: 0.08 };
    return { radio: 0.5, ir: 0.9, visible: 1, uv: 0.3, xray: 0.05 };
}

function neutronStarLuminosity(radiusKm, teff) {
    const rRsun = (radiusKm * 1000) / R_SUN;
    return stable(luminosityFromRT(rRsun, teff), 4);
}

// A neutron star is far too small to see by eye; the pulsars here are generously faint points, about as bright in
// visible light as the Crab pulsar, so that a zoomed-in observer can just find them
export function makeNeutronStar(rng, body, pulsar, remnant) {
    const teff = stable(rng.logRange(3e5, 2e6), 4);
    const radiusKm = dp(rng.range(10, 14), 2);
    const luminosity = neutronStarLuminosity(radiusKm, teff);
    const distance = remnant ? remnant.distance_pc : stable(rng.logRange(100, 5000), 5);
    const mag = dp(rng.range(15.5, 17.3), 3);
    const gamma = pulsar && rng.chance(0.2);
    body.distance_pc = distance;
    body.radial_velocity_kms = dp(rng.range(-300, 300), 1);
    body.brightness = { flux_Wm2: stable(fluxFromLuminosity(luminosity, distance), 5), mag };
    body.neutron_star = {
        pulsar,
        pulse_period_s: pulsar ? stable(rng.logRange(0.001, 5), 4) : null,
        gamma,
        remnant_of: remnant ? remnant.code : null,
        teff_K: teff,
        radius_km: radiusKm,
        mass_Msun: dp(rng.range(1.2, 2.1), 3),
        luminosity_Lsun: luminosity,
        magnetic_tilt_deg: dp(rng.range(10, 80), 1)
    };
    return { radio: pulsar ? 1 : 0, ir: 0, visible: 0.02, uv: 0.1, xray: 0.7 };
}

// d comes in from a stratified list, so that the Hubble plot has galaxies all along its length
export function makeGalaxy(rng, body, morphology, dMpc, radioLobes, activeNucleus) {
    const distance = dMpc * 1e6;
    const velocity = dp(H0 * dMpc + rng.range(-300, 300), 1);
    const modulus = distanceModulus(distance);
    // Bright ellipticals, modest spirals, faint irregulars; lifted where needed to stay within reach of a zoomed scope
    const typical = morphology === 'elliptical' ? -21.8 : morphology === 'spiral' ? -21 : -19.6;
    const absMag = Math.min(typical + rng.range(-1, 1), 17.2 - modulus);
    const mag = dp(absMag + modulus, 3);
    const luminosity = stable(10 ** (-0.4 * (absMag - 4.74)), 4);
    body.distance_pc = distance;
    body.radial_velocity_kms = velocity;
    body.brightness = { flux_Wm2: stable(fluxFromLuminosity(luminosity, distance), 5), mag };
    body.galaxy = {
        morphology,
        inclination_deg: dp(rng.range(0, 85), 1),
        position_angle_deg: dp(rng.range(0, 180), 1),
        size_deg: dp(rng.range(0.3, 2.2), 3),
        z: stable(velocity / C_KMS, 5),
        radio_lobes: radioLobes,
        active_nucleus: activeNucleus,
        distance_Mpc: dMpc,
        abs_mag: dp(absMag, 2),
        luminosity_Lsun: luminosity
    };
    return {
        radio: radioLobes ? 0.8 : 0.05,
        ir: morphology === 'elliptical' ? 0.3 : 0.6,
        visible: 1,
        uv: morphology === 'elliptical' ? 0.1 : 0.5,
        xray: activeNucleus ? 0.6 : 0.02
    };
}

// The stellar remnant and its visible partner: its mass is the answer, found from the partner's Doppler orbit
export function makeBlackHole(rng, nextCode, body) {
    const companionClass = rng.weighted([['B', 2], ['A', 2], ['F', 5], ['G', 8], ['K', 8]]);
    const star = makeClassStar(rng, companionClass);
    const companionCode = nextCode();
    const massBH = dp(rng.range(3, 30), 2);
    const total = massBH + star.mass_Msun;
    // Far enough out that the partner's Roche lobe still contains it, whatever its size
    const low = Math.max(0.1, 0.03 * star.radius_Rsun);
    const a = stable(rng.logRange(low, Math.max(0.5, low * 2)), 4);
    const period = stable(keplerPeriodDays(a, total), 6);
    const inc = dp(rng.range(30, 80), 2);
    const K = stable((orbitalSpeedKms(a, period) * (massBH / total)) * Math.sin((inc * Math.PI) / 180), 5);
    const absV = absoluteVisual(star.luminosity_Lsun, star.teff_K);
    const mag = dp(rng.chance(0.2) ? rng.range(6, 9) : rng.range(9, 17), 3);
    const distance = Math.max(200, distanceForMag(absV, mag));
    const rv = dp(rng.range(-120, 120), 1);
    const jets = rng.chance(0.3);
    const companion = {
        code: companionCode,
        kind: 'star_component',
        parent: body.code,
        star,
        distance_pc: distance,
        radial_velocity_kms: rv,
        brightness: { flux_Wm2: stable(fluxFromLuminosity(star.luminosity_Lsun, distance), 5), mag: apparentMag(absV, distance) },
        visual_seed: companionCode
    };
    body.distance_pc = distance;
    body.radial_velocity_kms = rv;
    body.brightness = { ...companion.brightness };
    body.black_hole = {
        mass_Msun: massBH,
        companion,
        a_AU: a,
        period_days: period,
        K_kms: K,
        inc_deg: inc,
        phase0: dp(rng.next(), 5),
        jets,
        disc_tilt_deg: dp(rng.range(50, 85), 1)
    };
    return { radio: jets ? 0.6 : 0.03, ir: 0.3, visible: 0.5, uv: 0.5, xray: 1 };
}

export function makeSupernova(rng, body, type, phase0Days) {
    const ia = type === 'Ia';
    // Standard-candle peak for Ia; a broader range for the core-collapse type II
    const absPeak = dp(ia ? rng.range(-19.5, -19.1) : rng.range(-17.5, -16.5), 2);
    const peakMag = dp(rng.range(0, 6), 2);
    const distance = distanceForMag(absPeak, peakMag);
    const sn = {
        type,
        phase0_days: phase0Days,
        peak_mag: peakMag,
        abs_peak_mag: absPeak,
        peak_time: dp(-phase0Days, 2),
        remnant_code: null,                // A neutron star's code for type II; a type Ia leaves nothing
        remnant_kind: ia ? 'none' : 'neutron_star',
        shell_deg: dp(rng.range(0.1, 0.5), 3)
    };
    const mag = dp(supernovaMag(sn, 0), 3);
    body.distance_pc = distance;
    body.radial_velocity_kms = dp(rng.range(-100, 100), 1);
    body.brightness = { flux_Wm2: fluxFromVisualMag(mag), mag };
    body.supernova = sn;
    return { radio: 0.3, ir: 0.8, visible: 1, uv: 0.7, xray: 0.5 };
}

// Comoving distance in a flat universe (Omega_m = 0.3), since z = v/c fails badly this far out
function comovingDistancePc(z) {
    const steps = 200;
    const h = z / steps;
    const inv = (x) => {
        const u = 1 + x;
        return 1 / Math.sqrt(0.3 * u * u * u + 0.7);
    };
    let sum = 0.5 * (inv(0) + inv(z));
    for (let i = 1; i < steps; i++) sum += inv(i * h);
    return (C_KMS / H0) * sum * h * 1e6;
}

export function makeQuasar(rng, body, z, radioLoud) {
    const distance = stable(comovingDistancePc(z), 5);
    const lumDistance = stable(distance * (1 + z), 5);
    const mag = dp(rng.range(13.5, 17), 3);
    const flux = fluxFromVisualMag(mag);
    const d = lumDistance * PC;
    body.distance_pc = distance;
    body.radial_velocity_kms = dp(z * C_KMS, 1);       // cz as a label only: panels show z, as v = cz fails here
    body.brightness = { flux_Wm2: flux, mag };
    body.quasar = {
        z,
        radio_loud: radioLoud,
        blazar: radioLoud,
        luminosity_distance_pc: lumDistance,
        luminosity_Lsun: stable((4 * Math.PI * d * d * flux) / L_SUN, 4)
    };
    return { radio: radioLoud ? 1 : 0.05, ir: 0.5, visible: 0.3, uv: 1, xray: 0.9 };
}

export function makeComet(rng, body) {
    const helio = dp(rng.range(0.8, 6), 2);
    const mag = dp(rng.range(2, 8), 3);
    body.distance_pc = stable(rng.range(2, 15) * (AU / PC), 4);
    body.radial_velocity_kms = dp(rng.range(-30, 30), 1);
    body.brightness = { flux_Wm2: fluxFromVisualMag(mag), mag };
    body.comet = {
        emission_lines: [
            line(388.3, 1, 'CN'),
            line(473.7, rng.range(0.3, 0.5), 'C₂'),
            line(516.5, rng.range(0.6, 0.9), 'C₂'),
            line(563.6, rng.range(0.25, 0.45), 'C₂'),
            line(589.0, rng.range(0.2, 0.5), 'Na D'),
            line(589.6, rng.range(0.1, 0.25), 'Na D')
        ],
        coma_deg: dp(rng.range(0.1, 0.5), 3),
        tail_deg: dp(rng.range(2, 9), 2),
        dust_ratio: dp(rng.next(), 3),
        heliocentric_AU: helio
    };
    return { radio: 0.1, ir: 0.8, visible: 1, uv: 0.8, xray: 0.05 };
}

// Warm only from its own leftover heat, so it shines in the infrared alone
export function makeRogue(rng, body, type) {
    let teff;
    let radius;
    let mass;
    let pct;
    let ppm;
    if (type === 'gas_giant') {
        teff = rng.range(120, 400);
        radius = rng.range(7, 13);
        mass = stable(rng.logRange(30, 2000), 3);
        const H2 = rng.range(85, 87);
        pct = { H2: dp(H2, 2), He: dp(100 - H2, 2) };
        ppm = { CH4: dp(rng.range(1000, 4000), 1), H2O: dp(rng.range(50, 500), 1) };
    } else if (type === 'sub_neptune') {
        teff = rng.range(60, 180);
        radius = rng.range(1.8, 3.8);
        mass = stable(2.7 * radius ** 1.3 * rng.range(0.8, 1.2), 3);
        const H2 = rng.range(80, 88);
        pct = { H2: dp(H2, 2), He: dp(99 - H2, 2), CH4: 1 };
        ppm = { H2O: dp(rng.range(20, 300), 1) };
    } else {
        teff = rng.range(40, 90);
        radius = rng.range(0.15, 0.6);
        mass = stable(0.3 * radius ** 3 * rng.range(0.85, 1.15), 3);
        pct = { N2: 90, CH4: 7, CO: 3 };
        ppm = {};
    }
    const T = dp(teff, 1);
    const rMetres = radius * R_EARTH;
    const luminosity = stable((4 * Math.PI * rMetres * rMetres * SIGMA * T * T * T * T) / L_SUN, 4);
    const distance = stable(rng.logRange(3, 60), 4);
    body.distance_pc = distance;
    body.radial_velocity_kms = dp(rng.range(-40, 40), 1);
    body.brightness = { flux_Wm2: stable(fluxFromLuminosity(luminosity, distance), 5), mag: 99 };
    body.rogue_planet = {
        type,
        teff_K: T,
        radius_Rearth: stable(radius, 4),
        mass_Mearth: stable(mass, 4),
        atmosphere_pct: pct,
        atmosphere_ppm: ppm,
        luminosity_Lsun: luminosity
    };
    return { radio: 0, ir: 0.5, visible: 0, uv: 0, xray: 0 };
}
