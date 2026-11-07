// Glowing and reflecting gas and dust: nebulae (emission, planetary, reflection, dark) and comets.
//
// For emission objects the continuum is faint, so flux is scaled so the strongest line reaches 1 at overview resolution.

import { C_KMS, R_OVERVIEW } from '../core/phys.js';
import { MOLECULES } from '../data/molecules.js';
import { FWHM_PER_SIGMA, bb, makeProfile, addLine, addBand, planckPeak, snrFromFlux, effectiveFlux } from './kernel.js';
import { renderStars, SOLAR_STAR, starPartsOf } from './stellar.js';

// Lines every gas cloud of the type has, beyond what its data lists. rel is against Hα = 1; where the data already lists a
// line, its value wins. Forbidden lines only appear here, in emission.
const COMMON_EXTRAS = [
    { w: 656.28, rel: 1, label: 'Hα', species: 'H I' }, { w: 486.13, rel: 0.35, label: 'Hβ', species: 'H I' },
    { w: 434.05, rel: 0.16, label: 'Hγ', species: 'H I' }, { w: 410.17, rel: 0.09, label: 'Hδ', species: 'H I' },
    { w: 397.01, rel: 0.05, label: 'Hε', species: 'H I' }, { w: 1875.1, rel: 0.13, label: 'Paα', species: 'H I' },
    { w: 1281.81, rel: 0.05, label: 'Paβ', species: 'H I' }, { w: 121.57, rel: 0.2, label: 'Lyα', species: 'H I' },
    { w: 654.8, rel: 0.1, label: '[N II] 654.8', species: 'N II' }, { w: 587.56, rel: 0.06, label: 'He I 587.6', species: 'He I' }
];
const EMISSION_EXTRAS = [
    ...COMMON_EXTRAS,
    { w: 500.68, rel: 0.5, label: '[O III]', species: 'O III' }, { w: 495.89, rel: 0.17, label: '[O III]', species: 'O III' },
    { w: 658.35, rel: 0.3, label: '[N II]', species: 'N II' }, { w: 372.6, rel: 0.25, label: '[O II] 372.6', species: 'O II' },
    { w: 372.88, rel: 0.2, label: '[O II] 372.9', species: 'O II' }, { w: 671.64, rel: 0.13, label: '[S II] 671.6', species: 'S II' },
    { w: 673.08, rel: 0.1, label: '[S II] 673.1', species: 'S II' }
];
const PLANETARY_EXTRAS = [
    ...COMMON_EXTRAS,
    { w: 500.68, rel: 2.5, label: '[O III]', species: 'O III' }, { w: 495.89, rel: 0.83, label: '[O III]', species: 'O III' },
    { w: 658.35, rel: 0.35, label: '[N II]', species: 'N II' }, { w: 468.57, rel: 0.2, label: 'He II 468.6', species: 'He II' },
    { w: 386.88, rel: 0.3, label: '[Ne III] 386.9', species: 'Ne III' }, { w: 372.6, rel: 0.1, label: '[O II] 372.6', species: 'O II' },
    { w: 436.32, rel: 0.05, label: '[O III] 436.3', species: 'O III' }
];

// The species behind a line label, for the lines the data gives without one
function speciesFromLabel(label) {
    const text = String(label);
    if (text.startsWith('He')) return text;
    if (text.startsWith('H')) return 'H I';
    return text.replace(/[[\]]/g, '');
}

function mergedLines(listed, extras) {
    const hAlpha = listed.find((l) => Math.abs(l.w - 656.28) < 0.5);
    const k = hAlpha ? hAlpha.rel : 1;
    const out = listed.map((l) => ({ ...l, species: l.species || speciesFromLabel(l.label) }));
    extras.forEach((extra) => {
        if (!out.some((l) => Math.abs(l.w - extra.w) < 0.5)) out.push({ ...extra, rel: extra.rel * k });
    });
    return out;
}

// How wide a line is in the gas: hydrogen is light, so its atoms move faster
function gasWidth(label, turbulence) {
    const text = String(label);
    return Math.hypot(text.startsWith('H') && !text.startsWith('He') ? 16 : 7, turbulence);
}

// How tall a line of this width must start for its peak to reach `rel` at overview resolution
function peakHeight(sigma, rel) {
    const sigmaOverview = C_KMS / (FWHM_PER_SIGMA * R_OVERVIEW);
    return (rel * Math.hypot(sigma, sigmaOverview)) / sigma;
}

function emissionNebula(body, grid, type) {
    const nebula = body.nebula;
    const planetary = type === 'planetary';
    const list = mergedLines(nebula.emission_lines || [], planetary ? PLANETARY_EXTRAS : EMISSION_EXTRAS);
    const factor = 1 + (body.radial_velocity_kms ?? 0) / C_KMS;
    const turbulence = planetary ? 18 : 12;
    const strongest = Math.max(...list.map((l) => l.rel));

    const { n, wl } = grid;
    const flux = new Float64Array(n);
    const continuum = new Float64Array(n);
    // Hot gas glows faintly at every wavelength; the hot star inside it adds a little more
    const central = nebula.central_star;
    const starScale = central ? 0.02 / planckPeak(central.teff_K) : 0;
    for (let i = 0; i < n; i++) {
        const lam = wl[i] / factor;
        let c = 0.008 * (500 / lam) ** 0.6 * (1 - Math.exp(-((lam / 91.2) ** 6)));
        if (central) c += starScale * bb(lam, central.teff_K);
        continuum[i] = c;
        flux[i] = c;
    }

    const lines = [];
    const shapes = new Map();
    list.forEach((line) => {
        const sigma = gasWidth(line.label, turbulence);
        if (!shapes.has(sigma)) shapes.set(sigma, makeProfile({ sigma, R: grid.R }));
        const prof = shapes.get(sigma);
        const amp = peakHeight(sigma, line.rel / strongest);
        const obs = line.w * factor;
        addLine(flux, grid, obs, amp, prof);
        if (obs >= grid.lo && obs <= grid.hi) {
            lines.push({ rest_nm: line.w, obs_nm: obs, species: line.species, label: line.label, depth: amp * prof.peak, type: 'em' });
        }
    });
    return {
        flux,
        continuum,
        lines,
        fRef: 1,
        snr: snrFromFlux(effectiveFlux(body.brightness)),
        mode: 'emission',
        note: planetary
            ? 'Bright emission lines from a shell of gas lit by a hot central star, with hardly any continuum.'
            : 'Bright emission lines from hot, thin gas, with hardly any continuum.'
    };
}

const FALLBACK_ILLUMINATOR = {
    class: 'B', stage: 'main_sequence', teff_K: 14000, radius_Rsun: 3, logg: 4.2, vsini_kms: 120,
    composition: { X: 0.71, Y: 0.27, Z: 0.02, metals_dex: {} }
};

function reflectionNebula(body, grid) {
    const star = body.nebula.central_star || FALLBACK_ILLUMINATOR;
    const factor = 1 + (body.radial_velocity_kms ?? 0) / C_KMS;
    const { flux, continuum, lines } = renderStars([{ star, factor, weight: 1, code: body.code }], grid);
    // Dust scatters blue light more than red, so the nebula looks bluer than its star. The peak is rescaled to match.
    let peak = 0;
    for (let lam = 90; lam < 5000; lam *= 1.02) {
        const v = bb(lam, star.teff_K) * (500 / lam) ** 1.8;
        if (v > peak) peak = v;
    }
    const own = planckPeak(star.teff_K);
    const { n, wl } = grid;
    for (let i = 0; i < n; i++) {
        const scatter = (500 / (wl[i] / factor)) ** 1.8 * (own / peak);
        flux[i] *= scatter;
        continuum[i] *= scatter;
    }
    return {
        flux,
        continuum,
        lines,
        fRef: 1,
        snr: snrFromFlux(effectiveFlux(body.brightness)),
        mode: 'reflection',
        note: 'A star\'s light, scattered by dust. It shows the star\'s absorption lines, on a bluer continuum.'
    };
}

function darkNebula(body, grid) {
    const { n, wl } = grid;
    const flux = new Float64Array(n);
    const continuum = new Float64Array(n);
    // Only a trace of background starlight gets through, heavily reddened
    const peak = planckPeak(3000);
    for (let i = 0; i < n; i++) {
        const c = ((0.004 * bb(wl[i], 3000)) / peak) * Math.exp(-((700 / wl[i]) ** 2));
        continuum[i] = c;
        flux[i] = c;
    }
    return {
        flux,
        continuum,
        lines: [],
        fRef: 0.004,
        snr: 8,
        mode: 'none',
        note: 'Almost nothing to measure here: a dark nebula is cold dust that blocks the visible light from behind it. Try the infrared view of the sky.'
    };
}

export function nebulaSpectrum(body, grid) {
    const type = body.nebula.type;
    if (type === 'dark') return darkNebula(body, grid);
    if (type === 'reflection') return reflectionNebula(body, grid);
    return emissionNebula(body, grid, type);
}

// ---- Comets: sunlight off the dust, plus emission from the gas ----

const DEFAULT_COMET_LINES = [
    { w: 388.3, rel: 1, label: 'CN' }, { w: 473.7, rel: 0.4, label: 'C₂' }, { w: 516.5, rel: 0.8, label: 'C₂' },
    { w: 563.5, rel: 0.35, label: 'C₂' }, { w: 589.0, rel: 0.35, label: 'Na D' }, { w: 589.6, rel: 0.2, label: 'Na D' }
];
const COMET_MOLECULES = { CN: 'CN', 'C₂': 'C2' };
const COMET_SPECIES = { CN: 'CN', 'C₂': 'C2', 'Na D': 'Na I' };

// The molecular band a listed emission feature belongs to, so a comet's bands are the same shape as the reference's
function bandFor(line) {
    const molecule = MOLECULES[COMET_MOLECULES[line.label]];
    if (!molecule) return null;
    return molecule.bands.find((band) => band.shape === 'edge' && Math.abs(band.head - line.w) < 1.5) || null;
}

// A comet of another star (host given) reflects that star's light, not the Sun's, and is seen as well as a planet there is
const EXOCOMET_MIN_SNR = 150;

export function cometSpectrum(body, grid, host = null) {
    const comet = body.comet || {};
    const factor = 1 + (body.radial_velocity_kms ?? 0) / C_KMS;
    const own = host ? starPartsOf(host, { parts: null }) : [];
    const parts = own.length ? own : [{ star: SOLAR_STAR, factor, weight: 1, code: body.code }];
    const { flux, continuum, lines } = renderStars(parts, grid);
    const { wl, n } = grid;

    // A gassy comet shows its emission more strongly against a fainter dust continuum
    const dust = comet.dust_ratio ?? 0.5;
    const gas = 0.5 + 1.5 * (1 - dust);
    const list = comet.emission_lines && comet.emission_lines.length ? comet.emission_lines : DEFAULT_COMET_LINES;

    const narrow = makeProfile({ sigma: 2, R: grid.R });
    list.forEach((line) => {
        const amp = gas * line.rel;
        const obs = line.w * factor;
        const band = bandFor(line);
        if (band) addBand(flux, grid, band, amp, factor);
        else addLine(flux, grid, obs, peakHeight(2, amp * 2), narrow); // On top of the Sun's own deep sodium lines
        if (obs >= grid.lo && obs <= grid.hi) {
            lines.push({ rest_nm: line.w, obs_nm: obs, species: COMET_SPECIES[line.label] || line.label, label: line.label, depth: amp, type: 'em' });
        }
    });

    // Warm dust glows in the thermal infrared
    const dustPeak = planckPeak(290);
    for (let i = 0; i < n; i++) {
        const heat = (0.25 + 0.5 * dust) * (bb(wl[i] / factor, 290) / dustPeak);
        flux[i] += heat;
        continuum[i] += heat;
    }
    return {
        flux,
        continuum,
        lines,
        fRef: 1,
        snr: own.length ? Math.max(EXOCOMET_MIN_SNR, snrFromFlux(effectiveFlux(body.brightness))) : snrFromFlux(effectiveFlux(body.brightness)),
        mode: 'reflection',
        note: own.length
            ? 'Light from its own star reflected off dust, with that star\'s absorption lines, plus bright emission from gas in the coma: CN, C₂ and sodium.'
            : 'Sunlight reflected off dust, with the Sun\'s absorption lines, plus bright emission from gas in the coma: CN, C₂ and sodium.'
    };
}
