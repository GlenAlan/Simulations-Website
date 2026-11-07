// Planet spectra (spec 8.3): the host's light x how the planet reflects it x its gases' absorption bands, plus the planet's
// own heat in the infrared. Everything comes from composition fields; nothing here knows a planet by name or code.
//
// Reflected and thermal light are in true proportion: reflected = albedo x (R_star / a)^2 x B(T_star), thermal = B(T_eq).
// The planet's own radius cancels, and the crossover falls where it really does, a few microns for a temperate planet.

import { C_KMS } from '../core/phys.js';
import { LINES } from '../data/lines.js';
import { MOLECULES } from '../data/molecules.js';
import { bb, planckPeakInRange, makeProfile, mulLine, mulBand, snrFromFlux, effectiveFlux } from './kernel.js';
import { renderStars, starPartsOf, SOLAR_STAR } from './stellar.js';

const SOLAR_RADIUS_AU = 0.00465;

// Column of gas (ppm x bar) that gives a band about two thirds of its full strength. Bands differ hugely in strength: a few
// ppm of methane shows at 3.3 um, while oxygen needs tens of thousands. Strength then grows slowly, as a saturating band does.
const HALF_COLUMN = {
    H2O: 3000, CO2: 20000, CH4: 5, NH3: 100, O2: 50000, O3: 1, CO: 100, SO2: 100, N2O: 1, TiO: 1, SiO: 10
};

// In a giant, light only reaches down to the cloud tops, so its deep pressure doesn't count
function bandStrength(gas, ppm, pressureBar) {
    const column = ppm * Math.min(pressureBar, 5);
    return 1 - Math.exp(-Math.sqrt(column / (HALF_COLUMN[gas] ?? 1000)));
}

const ATOM_SPECIES = { Na: 'Na I', K: 'K I', Li: 'Li I', Ca: 'Ca I', Fe: 'Fe I' };

const RED_EDGE_LAND = 0.45;
const RED_EDGE_SEA = 0.3;

// What a surface's ice field means, as the molecules that show it
const ICE_MOLECULES = { water: ['H2O_ice'], methane_nitrogen: ['CH4_ice', 'N2_ice'], H2O: ['H2O_ice'], CH4: ['CH4_ice'] };

function gasesOf(planet) {
    const out = new Map();
    Object.entries(planet.atmosphere_pct || {}).forEach(([gas, pct]) => out.set(gas, pct * 1e4));
    Object.entries(planet.atmosphere_ppm || {}).forEach(([gas, ppm]) => out.set(gas, (out.get(gas) || 0) + ppm));
    return out;
}

// A surface's reflectance at a wavelength, by its rock type
function groundReflectance(rock, lam) {
    if (rock === 'iron_oxide') return 0.1 + 0.25 * Math.min(1, Math.max(0, (lam - 420) / 330));
    if (rock === 'basalt') return 0.09 + 0.02 * Math.min(1, lam / 1000);
    if (rock === 'iron') return 0.12 + 0.05 * Math.min(1, lam / 1500);
    if (rock === 'molten') return 0.05;
    return 0.24;
}

// Reflectance of the surface and clouds together, before scaling to the planet's albedo
function reflectanceModel(planet) {
    const surface = planet.surface || {};
    const clouds = planet.clouds || {};
    const pressure = planet.pressure_bar ?? 0;
    const ocean = surface.ocean_fraction || 0;
    const land = 1 - ocean;
    const cover = Math.min(0.95, clouds.cover || 0);
    const rock = surface.rock || 'silicate';
    const redEdge = surface.red_edge_nm;
    const iced = Boolean(surface.ice);
    const blueDim = clouds.kind === 'H2SO4';
    const dusty = clouds.kind === 'dust';
    const giant = !surface.rock && pressure >= 10;
    const rayleigh = (giant ? 0.3 : 0.14) * Math.min(1, pressure);

    return (lam) => {
        let ground;
        if (iced) {
            ground = 0.8;
        } else if (giant) {
            ground = 0.5;
        } else {
            ground = groundReflectance(rock, lam);
            // Iron-bearing minerals dip broadly near 1 um and again near 2 um
            const dip1 = (lam - 1000) / 170;
            const dip2 = (lam - 2000) / 300;
            ground *= 1 - 0.3 * Math.exp(-0.5 * dip1 * dip1) - 0.14 * Math.exp(-0.5 * dip2 * dip2);
        }
        let below = land * ground + ocean * (0.05 + 0.02 * Math.min(1, 450 / lam));
        // Life's red edge: a step up where plants stop absorbing, on land and in the blooms and mats on the sea. It stays up
        // across the near infrared, so it shows as a higher level past the edge, not a bump.
        if (redEdge) below += (land * RED_EDGE_LAND + ocean * RED_EDGE_SEA) / (1 + Math.exp((redEdge - lam) / 9));
        let deck = 0.8;
        if (blueDim) deck = 0.85 * Math.min(1, Math.max(0.25, (lam - 300) / 200));
        if (dusty) deck = groundReflectance('iron_oxide', lam) * 1.3;
        const air = rayleigh * (450 / lam) ** 4;
        return cover * deck + (1 - cover) * below + air;
    };
}

// A planet's reflectance over the visible averages out to its stated albedo
function albedoFunction(planet) {
    const model = reflectanceModel(planet);
    let sum = 0;
    let count = 0;
    for (let lam = 400; lam <= 800; lam += 20) {
        sum += model(lam);
        count++;
    }
    const scale = (planet.albedo ?? 0.3) / (sum / count);
    return (lam) => scale * model(lam);
}

// Absorption by the planet's own gases and ices, written into A, and the features that are there to be seen
function drawPlanetAbsorption(A, grid, planet, factor, gases = gasesOf(planet), pressure = planet.pressure_bar ?? 0) {
    const features = [];
    gases.forEach((ppm, gas) => {
        if (pressure <= 0) return;
        const molecule = MOLECULES[gas];
        const atom = ATOM_SPECIES[gas];
        if (molecule) {
            const strength = bandStrength(gas, ppm, pressure);
            molecule.bands.forEach((band) => {
                mulBand(A, grid, band, strength, factor);
                features.push({ rest_nm: band.c, species: gas, label: molecule.label || gas, depth: strength * (band.d ?? 1), band: true, width_nm: band.w });
            });
        }
        if (atom && LINES[atom]) {
            // Atoms in a hot atmosphere: only the ground-state lines, narrow cores on far-reaching pressure wings
            const strength = 0.95 * (1 - Math.exp(-Math.sqrt(ppm * Math.min(pressure, 5))));
            const prof = makeProfile({ sigma: 3, a: 1200, R: grid.R });
            LINES[atom].forEach((line) => {
                if ((line.ei ?? 0) > 0.1 || line.forbidden) return;
                const d = strength * (line.s ?? 1);
                mulLine(A, grid, line.w * factor, d, prof);
                features.push({ rest_nm: line.w, species: atom, label: line.label || `${atom} ${line.w.toFixed(1)}`, depth: d * prof.peak });
            });
        }
    });
    const surface = planet.surface || {};
    const iceList = ICE_MOLECULES[surface.ice] || [];
    iceList.forEach((key) => {
        const molecule = MOLECULES[key];
        if (!molecule) return;
        molecule.bands.forEach((band) => {
            mulBand(A, grid, band, 0.8, factor);
            features.push({ rest_nm: band.c, species: key, label: molecule.label || key, depth: 0.8 * (band.d ?? 1), band: true, width_nm: band.w });
        });
    });
    return features;
}

function withObservedWavelengths(features, grid, factor) {
    return features
        .map((f) => ({ ...f, obs_nm: f.rest_nm * factor, type: 'abs' }))
        .filter((f) => f.obs_nm >= grid.lo && f.obs_nm <= grid.hi);
}

// Planets are very faint next to their stars, but a student has to be able to find their bands, so these spectra are as
// if from a telescope built for the job. Only the brightest get better than this.
const PLANET_MIN_SNR = 150;

// hostEntity is the planet's host, or null for a home planet, which reflects a Sun-like star
export function planetSpectrum(planet, grid, opts, hostEntity, ownBody) {
    const parts = hostEntity
        ? starPartsOf(hostEntity, { ...opts, parts: null })
        : [{ star: SOLAR_STAR, factor: 1 + (ownBody?.radial_velocity_kms ?? 0) / C_KMS, weight: 1, code: 'host' }];
    if (!parts.length) parts.push({ star: SOLAR_STAR, factor: 1, weight: 1, code: 'host' });
    const host = renderStars(parts, grid);
    const factor = parts.length === 1 ? parts[0].factor : 1 + (hostEntity?.radial_velocity_kms ?? 0) / C_KMS;
    const a = planet.orbit_AU || 1;
    const geometry = (SOLAR_RADIUS_AU / a) ** 2;
    const Teq = planet.T_eq_K ?? 250;
    const albedo = albedoFunction(planet);
    const baseAlbedo = planet.albedo ?? 0.3;

    const A = new Float64Array(grid.n).fill(1);
    const features = drawPlanetAbsorption(A, grid, planet, factor);

    // In absolute units: the host's flux is a normalised spectrum x its norm
    const { wl, n } = grid;
    const hostScale = host.norm * geometry;
    const reflected = new Float64Array(n);
    const thermal = new Float64Array(n);
    const reflectedCont = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const rest = wl[i] / factor;
        reflected[i] = albedo(rest) * hostScale * host.flux[i] * A[i];
        reflectedCont[i] = baseAlbedo * hostScale * host.continuum[i];
        thermal[i] = bb(rest, Teq);
    }

    // The continuum's brightest point in the full range, on a coarse grid of its reflected and thermal parts
    let norm = 0;
    const steps = 240;
    for (let j = 0; j <= steps; j++) {
        const lam = 90 * (5000 / 90) ** (j / steps);
        let hostLight = 0;
        for (const part of parts) hostLight += part.weight * bb(lam, part.star.teff_K);
        const sum = baseAlbedo * geometry * hostLight + bb(lam, Teq);
        if (sum > norm) norm = sum;
    }

    const flux = new Float64Array(n);
    const continuum = new Float64Array(n);
    let note = 'Reflected starlight, then the planet\'s own heat in the infrared. Dips that the star does not have belong to the planet.';
    if (opts.subtractHost) {
        // Reflectance: 0.3 here means the planet returns 30% of the starlight. The host's lines cancel exactly.
        note = 'The host star\'s light has been divided out, so only the planet\'s own features remain. Flux here is the fraction of starlight the planet returns. Its own heat lifts the far right.';
        for (let i = 0; i < n; i++) {
            const hostLight = Math.max(1e-300, hostScale * host.flux[i]);
            const hostCont = Math.max(1e-300, hostScale * host.continuum[i]);
            flux[i] = albedo(wl[i] / factor) * A[i] + Math.min(1e3, (thermal[i] * A[i]) / hostLight);
            continuum[i] = baseAlbedo + Math.min(1e3, thermal[i] / hostCont);
        }
    } else {
        for (let i = 0; i < n; i++) {
            flux[i] = (reflected[i] + thermal[i] * A[i]) / norm;
            continuum[i] = (reflectedCont[i] + thermal[i]) / norm;
        }
    }

    const lines = withObservedWavelengths(features, grid, factor);
    if (!opts.subtractHost) {
        // The host's own lines still show in the reflected light, for as long as reflected light dominates
        host.lines.forEach((line) => {
            const i = Math.round((Math.log(line.obs_nm) - grid.lnLo) / grid.step);
            const share = continuum[i] > 0 ? (reflectedCont[i] / norm) / continuum[i] : 0;
            lines.push({ ...line, depth: line.depth * share, source: 'host' });
        });
    }

    return {
        flux,
        continuum,
        lines,
        fRef: opts.subtractHost ? baseAlbedo : 1,
        snr: Math.max(PLANET_MIN_SNR, snrFromFlux(effectiveFlux(planet.brightness || ownBody?.brightness))),
        mode: 'reflection',
        note
    };
}

// Rogue planets have no star: only their own heat, seen through their own gases
const ROGUE_GASES = {
    gas_giant: { H2O: 200, CH4: 3000 },
    sub_neptune: { H2O: 100, CH4: 10000 },
    ice_dwarf: { CH4: 70000, CO: 30000 }
};

export function roguePlanetSpectrum(body, grid) {
    const rogue = body.rogue_planet;
    const T = rogue.teff_K ?? 200;
    const factor = 1 + (body.radial_velocity_kms ?? 0) / C_KMS;
    const planet = { atmosphere_pct: rogue.atmosphere_pct, atmosphere_ppm: rogue.atmosphere_ppm, surface: rogue.surface, pressure_bar: rogue.pressure_bar ?? 1 };
    const gases = gasesOf(planet);
    if (!gases.size) Object.entries(ROGUE_GASES[rogue.type] || ROGUE_GASES.gas_giant).forEach(([gas, ppm]) => gases.set(gas, ppm));

    const A = new Float64Array(grid.n).fill(1);
    const features = drawPlanetAbsorption(A, grid, planet, factor, gases, planet.pressure_bar);
    const peak = planckPeakInRange(T);
    const flux = new Float64Array(grid.n);
    const continuum = new Float64Array(grid.n);
    for (let i = 0; i < grid.n; i++) {
        const c = bb(grid.wl[i] / factor, T) / peak;
        continuum[i] = c;
        flux[i] = c * A[i];
    }
    return {
        flux,
        continuum,
        lines: withObservedWavelengths(features, grid, factor),
        fRef: 1,
        snr: Math.max(40, snrFromFlux(effectiveFlux(body.brightness))),
        mode: 'thermal',
        note: 'No visible light: this planet has no star to reflect, so it only glows faintly in the infrared from its own heat. Its peak lies beyond 5 µm.'
    };
}
