// Star spectra (spec 8.1): a pure Planck continuum at the surface temperature, multiplied by absorption lines and bands.
//
//   depth = temperature visibility(species, T) x abundance
//   width = thermal, pressure (from log g, as Lorentz wings) and rotation (v sin i), then the instrument's R
//   shift = radial velocity
//
// Nothing here changes the continuum itself, which is why the Wien tool finds the star's true peak through the lines.

import { SPECTRUM_LO_NM, SPECTRUM_HI_NM, C_KMS, fluxFromLuminosity, wienPeakNm } from '../core/phys.js';
import { app } from '../core/state.js';
import { LINES, LINE_INFO } from '../data/lines.js';
import { MOLECULES } from '../data/molecules.js';
import { componentStates } from '../data/orbits.js';
import { bb, planckPeak, planckPeakInRange, makeProfile, mulLine, mulBand, effectiveFlux, snrFromFlux } from './kernel.js';

// ---- Which lines a star of a given temperature shows ----

// A smooth curve in log T: strongest at peak (K), falling away with the given widths in dex on the cool and hot sides
function bell(T, peak, cool, hot) {
    const x = Math.log10(T / peak);
    const w = x < 0 ? cool : hot;
    return Math.exp((-x * x) / (2 * w * w));
}

// Peak K, cool and hot widths (dex), strength at the peak, Lorentz half-width at log g = 4.44 (km/s), and how steeply that
// width follows gravity. Hydrogen's wings come from electrons, so they follow gravity less steeply than a metal line's.
const row = (T, cool, hot, amp, a, k = 0.5) => ({ T, cool, hot, amp, a, k });
const SPECIES = {
    'H I': row(9500, 0.2, 0.32, 0.95, 300, 0.22),
    'He I': row(20000, 0.085, 0.16, 0.8, 70, 0.3),
    'He II': row(45000, 0.1, 0.25, 0.75, 90, 0.3),
    'Li I': row(4200, 0.1, 0.1, 0.15, 2),
    'C I': row(7500, 0.1, 0.12, 0.45, 3),
    'C II': row(18000, 0.09, 0.1, 0.5, 4),
    'C III': row(30000, 0.08, 0.1, 0.55, 4),
    'C IV': row(42000, 0.09, 0.14, 0.6, 5),
    'N I': row(9000, 0.09, 0.1, 0.4, 3),
    'N II': row(22000, 0.08, 0.09, 0.5, 4),
    'N III': row(34000, 0.08, 0.1, 0.55, 4),
    'N V': row(45000, 0.08, 0.14, 0.6, 5),
    'O I': row(7500, 0.12, 0.1, 0.7, 3),
    'O II': row(25000, 0.07, 0.09, 0.55, 4),
    'O III': row(38000, 0.07, 0.1, 0.55, 4),
    'Na I': row(3800, 0.13, 0.16, 0.95, 8),
    'Mg I': row(4500, 0.13, 0.16, 0.85, 4),
    'Mg II': row(9500, 0.16, 0.16, 0.8, 6),
    'Si I': row(5000, 0.12, 0.12, 0.5, 3),
    'Si II': row(12000, 0.12, 0.12, 0.7, 4),
    'Si III': row(20000, 0.08, 0.1, 0.55, 4),
    'Si IV': row(28000, 0.07, 0.1, 0.6, 5),
    'K I': row(3200, 0.12, 0.12, 0.8, 6),
    'Ca I': row(3700, 0.11, 0.14, 0.85, 4),
    'Ca II': row(5000, 0.25, 0.13, 0.97, 4),
    'Ti I': row(3500, 0.12, 0.1, 0.6, 2),
    'Ti II': row(6500, 0.13, 0.12, 0.6, 2),
    'Fe I': row(4500, 0.13, 0.15, 0.85, 2),
    'Fe II': row(7000, 0.13, 0.13, 0.7, 2)
};

// The few strong lines whose wings run far past a normal metal line's: [species, rest nm, Lorentz half-width (km/s)]
const WIDE_LINES = [
    ['Ca II', 393.366, 500], ['Ca II', 396.847, 420], ['Ca II', 849.802, 60], ['Ca II', 854.209, 120], ['Ca II', 866.214, 90],
    ['Ca I', 422.673, 60], ['Na I', 588.995, 16], ['Na I', 589.592, 13], ['K I', 766.49, 20], ['K I', 769.896, 15],
    ['Mg I', 516.733, 18], ['Mg I', 517.268, 30], ['Mg I', 518.361, 40], ['Mg II', 279.553, 200], ['Mg II', 280.271, 170]
];

function elementOf(species) {
    return species.split(' ')[0];
}

export function visibility(species, T) {
    const p = SPECIES[species];
    return p ? p.amp * bell(T, p.T, p.cool, p.hot) : 0;
}

// How much of an element a star has, relative to the Sun. metals_dex already holds the star's overall level, so it is
// not to be scaled by Z again; elements it doesn't list go with the overall level.
function abundance(star, element) {
    const c = star.composition;
    if (!c) return 1;
    if (element === 'H') return (c.X ?? 0.71) / 0.71;
    if (element === 'He') return (c.Y ?? 0.27) / 0.27;
    const dex = c.metals_dex && c.metals_dex[element];
    if (dex !== undefined) return 10 ** dex;
    return c.metallicity_dex !== undefined ? 10 ** c.metallicity_dex : Math.max(c.Z ?? 0.02, 2e-7) / 0.02;
}

// Lines weaken more slowly than the abundance falls, as they do on a real curve of growth
const abundanceDepth = (x) => x ** 0.6;

// A line's strength s was set at the species' peak temperature. The visibility curve moves the whole species with
// temperature; this moves one line against the species' main line by how much harder its lower level is to reach.
// The cube root is because s is itself the cube root of gf e^(-Ei/kT).
const BOLTZMANN_EV = 8.617e-5;
const mainLineEnergy = new Map();

function mainEnergyOf(species) {
    if (!mainLineEnergy.has(species)) {
        let best = null;
        LINES[species].forEach((line) => {
            if (line.w >= 300 && line.ei !== undefined && !line.forbidden && (!best || line.s > best.s)) best = line;
        });
        mainLineEnergy.set(species, best ? best.ei : 0);
    }
    return mainLineEnergy.get(species);
}

function boltzmannWeight(species, line, T) {
    const info = LINE_INFO[species];
    if (!info || line.ei === undefined) return 1;
    const weight = Math.exp((-(line.ei - mainEnergyOf(species)) / BOLTZMANN_EV) * (1 / T - 1 / info.T_peak_K) / 3);
    return Math.min(1.5, Math.max(0.15, weight));
}

export function isWhiteDwarf(star) {
    return star.stage === 'white_dwarf' || star.class === 'D' || Boolean(star.wd_type);
}

// White dwarfs: gravity has sunk everything but one element, so a type shows only that element's lines.
function whiteDwarfStrength(species, star) {
    const T = star.teff_K;
    const type = star.wd_type || 'DA';
    const el = elementOf(species);
    if (type === 'DA') return el === 'H' ? 0.92 * bell(T, 14000, 0.3, 0.55) : 0;
    if (type === 'DB') {
        if (species === 'He I') return Math.max(0.2, 0.8 * bell(T, 20000, 0.18, 0.3));
        return species === 'He II' ? 0.7 * bell(T, 60000, 0.1, 0.3) : 0;
    }
    if (type === 'DZ') {
        return ['Ca II', 'Ca I', 'Mg I', 'Mg II', 'Na I', 'Fe I', 'Fe II'].includes(species)
            ? Math.max(0.15, visibility(species, T)) : 0;
    }
    if (type === 'DQ') return el === 'C' ? Math.max(0.12, visibility(species, T)) : 0;
    return 0;
}

// Molecular bands, by temperature. They are switched off where a star has no such molecules (carbon stars have no TiO).
function starBands(star) {
    const T = star.teff_K;
    const type = star.wd_type;
    if (isWhiteDwarf(star)) return type === 'DQ' ? [['C2', 0.9 * bell(T, 8000, 0.25, 0.2)]] : [];
    const metal = (el) => abundanceDepth(abundance(star, el));
    const logg = star.logg ?? 4.44;
    const dwarfness = Math.min(1, Math.max(0, (logg - 3) / 1.5));
    if (star.peculiar === 'carbon') {
        const carbon = Math.min(1.1, 0.9 * bell(T, 3200, 0.2, 0.2));
        return [['C2', carbon], ['CN', 0.8 * bell(T, 3500, 0.2, 0.2)], ['CH', 0.8 * bell(T, 4000, 0.2, 0.2)]];
    }
    const tio = 1 / (1 + Math.exp((T - 3450) / 170));
    return [
        ['TiO', 0.9 * tio * metal('Ti')],
        ['CH', 0.5 * bell(T, 5000, 0.12, 0.12) * metal('C')],
        ['CN', 0.3 * bell(T, 4500, 0.1, 0.1) * metal('N')],
        ['MgH', 0.4 * bell(T, 4000, 0.08, 0.08) * dwarfness * metal('Mg')],
        ['CaH', 0.45 * bell(T, 3200, 0.07, 0.08) * dwarfness * metal('Ca')]
    ];
}

// ---- A star's model: all of its lines, with their depth and shape, ready to be drawn on any grid ----

const MICRO_KMS = 1;
const models = new WeakMap();

function buildModel(star, R, sigmaExtra) {
    const T = star.teff_K;
    const logg = star.logg ?? 4.44;
    const vsini = star.vsini_kms ?? 0;
    const wd = isWhiteDwarf(star);
    const shapes = new Map();
    const shapeFor = (sigma, a) => {
        const key = `${sigma.toFixed(2)}|${a.toFixed(1)}`;
        if (!shapes.has(key)) shapes.set(key, makeProfile({ sigma, a, vsini, R }));
        return shapes.get(key);
    };

    const lines = [];
    Object.keys(LINES).forEach((species) => {
        const p = SPECIES[species];
        if (!p) return;
        const el = elementOf(species);
        const strength = wd ? whiteDwarfStrength(species, star) : visibility(species, T) * abundanceDepth(abundance(star, el));
        if (strength < 0.004) return;
        // A metal line in a white dwarf is very broad, but hydrogen and helium are what really widen with gravity
        const gravity = Math.min(el === 'H' || el === 'He' ? 10 : 3, 10 ** (p.k * (logg - 4.44)));
        const mass = LINE_INFO[species] ? LINE_INFO[species].mass_u : 40;
        const sigma = Math.hypot(0.0912 * Math.sqrt(T / mass), MICRO_KMS, sigmaExtra);
        const wingScale = Math.sqrt(Math.min(1, strength));
        LINES[species].forEach((line) => {
            if (line.forbidden) return; // Forbidden lines only form in thin gas, never as absorption in a star
            const lineS = line.s ?? 1;
            const lyman = el === 'H' && line.w < 200;
            // Gravity dissolves the high levels of hydrogen in a white dwarf, so its Balmer series stops early
            if (wd && el === 'H' && !lyman && lineS < 0.3) return;
            // Balmer lines stay strong far up the series, as saturated lines do
            const s = el === 'H' && !lyman && !wd ? Math.sqrt(lineS) : lineS;
            // Ultraviolet resonance lines start from the ground state, where nearly all atoms sit, so they saturate early
            const raw = line.w < 300
                ? 0.95 * (1 - Math.exp(-5 * strength)) * s
                : strength * s * boltzmannWeight(species, line, T);
            const d = Math.min(0.97, raw);
            if (d < 0.004) return;
            const wide = WIDE_LINES.find((w) => w[0] === species && Math.abs(w[1] - line.w) < 0.15);
            let a = (wide ? wide[2] : p.a) * gravity * wingScale;
            if (el === 'H') a *= lineS ** 0.75;
            if (lyman) a = Math.min(a, 700);
            const prof = shapeFor(sigma, a);
            lines.push({ w: line.w, d, prof, species, label: line.label || `${species} ${line.w.toFixed(1)}` });
        });
    });

    const bands = [];
    starBands(star).forEach(([key, strength]) => {
        const molecule = MOLECULES[key];
        if (!molecule || strength < 0.01) return;
        molecule.bands.forEach((band) => bands.push({ band, strength, key, label: molecule.label || key }));
    });

    // Below the Lyman limit hydrogen absorbs from the ground state, strongly unless the star has ionised it all
    const hasHydrogen = !wd || (star.wd_type || 'DA') === 'DA';
    const lymanTau = hasHydrogen ? 5 * (wd ? 0.6 : visibility('H I', T) / 0.95) : 0;
    return { T, lines, bands, lymanTau };
}

function modelOf(star, R, sigmaExtra = 0) {
    let perStar = models.get(star);
    if (!perStar) {
        perStar = new Map();
        models.set(star, perStar);
    }
    const key = `${R}|${sigmaExtra}`;
    if (!perStar.has(key)) perStar.set(key, buildModel(star, R, sigmaExtra));
    return perStar.get(key);
}

// The fraction of light a star lets through at each pixel, written into A. `factor` is 1 + v/c.
function drawAbsorption(A, grid, model, factor) {
    A.fill(1);
    for (const line of model.lines) mulLine(A, grid, line.w * factor, line.d, line.prof);
    for (const b of model.bands) mulBand(A, grid, b.band, b.strength, factor);
    if (model.lymanTau > 0) {
        const edge = 91.18;
        const reach = edge * 1.01 * factor;
        for (let i = 0; i < grid.n && grid.wl[i] < reach; i++) {
            const lam = grid.wl[i] / factor;
            A[i] *= Math.exp(-model.lymanTau * (lam / edge) ** 3 / (1 + Math.exp((lam - edge) / 0.12)));
        }
    }
}

// ---- Light from one or more stars ----

function peakOf(parts) {
    if (parts.length === 1) {
        const { star, weight } = parts[0];
        const T = star.teff_K;
        return { norm: weight * planckPeak(T), ref: planckPeakInRange(T) / planckPeak(T) };
    }
    // Sum on a coarse grid that also runs below the range, so a hot pair slopes as a hot star does
    let norm = 0;
    let inRange = 0;
    const steps = 320;
    for (let j = 0; j <= steps; j++) {
        const lam = 10 * (SPECTRUM_HI_NM / 10) ** (j / steps);
        let sum = 0;
        for (const part of parts) sum += part.weight * bb(lam / part.factor, part.star.teff_K);
        if (sum > norm) norm = sum;
        if (lam >= SPECTRUM_LO_NM && sum > inRange) inRange = sum;
    }
    return { norm, ref: inRange / norm };
}

// parts: [{ star, factor (1 + v/c), weight (emitting area, as radius squared), code, sigma (extra km/s) }]
// Returns flux and continuum normalised together, and every line in range with its depth as seen in the combined light.
export function renderStars(parts, grid) {
    const flux = new Float64Array(grid.n);
    const continuum = new Float64Array(grid.n);
    const A = new Float64Array(grid.n);
    const { norm, ref } = peakOf(parts);
    const { wl, n } = grid;
    const models_ = parts.map((part) => modelOf(part.star, grid.R, part.sigma || 0));
    parts.forEach((part, p) => {
        const model = models_[p];
        drawAbsorption(A, grid, model, part.factor);
        const w = part.weight / norm;
        const T = model.T;
        const f = part.factor;
        for (let i = 0; i < n; i++) {
            const c = w * bb(wl[i] / f, T);
            continuum[i] += c;
            flux[i] += c * A[i];
        }
    });

    // A line is diluted by whatever light the other stars add at its wavelength
    const lightAt = (lam) => parts.map((part) => part.weight * bb(lam / part.factor, part.star.teff_K));
    const lines = [];
    parts.forEach((part, p) => {
        const model = models_[p];
        const share = (obs) => {
            const light = lightAt(obs);
            const total = light.reduce((sum, x) => sum + x, 0);
            return total > 0 ? light[p] / total : 0;
        };
        for (const line of model.lines) {
            const obs = line.w * part.factor;
            if (obs < grid.lo || obs > grid.hi) continue;
            const depth = line.d * line.prof.peak * (parts.length > 1 ? share(obs) : 1);
            lines.push({ rest_nm: line.w, obs_nm: obs, species: line.species, label: line.label, depth, type: 'abs', code: part.code });
        }
        for (const b of model.bands) {
            const obs = b.band.c * part.factor;
            if (obs < grid.lo || obs > grid.hi) continue;
            const depth = Math.min(0.98, b.strength * (b.band.d ?? 1)) * (parts.length > 1 ? share(obs) : 1);
            lines.push({ rest_nm: b.band.c, obs_nm: obs, species: b.key, label: b.label, depth, type: 'abs', code: part.code, band: true, width_nm: b.band.w });
        }
    });
    return { flux, continuum, lines, fRef: ref, norm };
}

// ---- Which stars an entity holds, and how fast each is moving at time t ----

// The body an entity belongs to, from its own fields: a component's system, a member's cluster, a planet's host.
export function parentOf(entity, opts = {}) {
    if (opts.body) return opts.body;
    const code = entity.parent || entity.host;
    const universe = opts.universe || app.universe;
    if (!code || !universe) return null;
    const found = universe.resolve(code);
    return found ? found.entity : null;
}

function velocitiesAt(body, t) {
    const out = new Map();
    componentStates(body, t).forEach((state) => out.set(state.code, state.vlos_kms));
    return out;
}

const partOf = (star, velocity, code) => ({
    star,
    code,
    factor: 1 + velocity / C_KMS,
    weight: (star.radius_Rsun ?? 1) ** 2
});

// The stars behind an entity. opts.t is days; opts.parts keeps only the named components.
export function starPartsOf(entity, opts = {}) {
    const t = opts.t ?? 0;
    const keep = (list) => (opts.parts && opts.parts.length ? list.filter((p) => opts.parts.includes(p.code)) : list);

    if (entity.stars) {
        const rv = entity.radial_velocity_kms ?? 0;
        const v = velocitiesAt(entity, t);
        return keep(entity.stars.map((c) => partOf(c.star, rv + (v.get(c.code) ?? 0), c.code)));
    }
    if (entity.black_hole) {
        const c = entity.black_hole.companion;
        const v = velocitiesAt(entity, t);
        return [partOf(c.star, (entity.radial_velocity_kms ?? 0) + (v.get(c.code) ?? 0), c.code)];
    }
    if (entity.cluster) {
        // The brightest members set a cluster's combined light; any more add nothing but time
        const top = [...entity.cluster.members]
            .sort((a, b) => (b.star.luminosity_Lsun ?? 0) - (a.star.luminosity_Lsun ?? 0))
            .slice(0, 14);
        return keep(top.map((m) => partOf(m.star, m.radial_velocity_kms ?? entity.radial_velocity_kms ?? 0, m.code)));
    }
    if (entity.star) {
        const parent = parentOf(entity, opts);
        let velocity = entity.radial_velocity_kms ?? (parent ? parent.radial_velocity_kms : 0) ?? 0;
        if (parent && (parent.stars || parent.black_hole)) {
            velocity = (parent.radial_velocity_kms ?? 0) + (velocitiesAt(parent, t).get(entity.code) ?? 0);
        }
        return [partOf(entity.star, velocity, entity.code)];
    }
    return [];
}

// The measured flux behind the noise: an entity's own if it has one, or worked out from its star and its parent's distance
export function fluxOf(entity, opts = {}) {
    if (entity.brightness) return effectiveFlux(entity.brightness);
    const parent = parentOf(entity, opts);
    if (entity.star && parent && parent.distance_pc) {
        return fluxFromLuminosity(entity.star.luminosity_Lsun ?? 1, parent.distance_pc);
    }
    return parent ? effectiveFlux(parent.brightness) : 0;
}

function hottestShown(parts) {
    let best = parts[0];
    let bestLight = -1;
    for (const part of parts) {
        const light = part.weight * planckPeak(part.star.teff_K);
        if (light > bestLight) {
            bestLight = light;
            best = part;
        }
    }
    return best.star.teff_K;
}

export function starSpectrum(entity, grid, opts) {
    const parts = starPartsOf(entity, opts);
    if (!parts.length) return null;
    const out = renderStars(parts, grid);
    const notes = [];
    if (entity.black_hole) notes.push('Only the companion star shows here. The black hole itself gives out no light of its own in this range.');
    else if (entity.cluster) notes.push('This is the combined light of the brightest stars in the cluster. Pick a member star to see its own spectrum.');
    else if (parts.length > 1) notes.push(`You are seeing the combined light of ${parts.length} stars, each with its own set of lines.`);
    const T = hottestShown(parts);
    if (wienPeakNm(T) < SPECTRUM_LO_NM) notes.push('The black-body peak is below 90 nm, outside this range. Fit the black-body reference instead of finding the peak.');
    return { ...out, snr: snrFromFlux(fluxOf(entity, opts)), mode: 'absorption', note: notes.join(' ') };
}

// A Sun-like star, for the light that home planets and comets reflect
export const SOLAR_STAR = {
    class: 'G', subclass: 2, luminosity_class: 'V', stage: 'main_sequence', teff_K: 5800, mass_Msun: 1, radius_Rsun: 1,
    luminosity_Lsun: 1, logg: 4.44, vsini_kms: 2, population: 'I', peculiar: null, wd_type: null,
    composition: { X: 0.71, Y: 0.27, Z: 0.02, metals_dex: {} }
};
