// Glowing and reflecting gas and dust: nebulae (emission, planetary, reflection, dark) and comets.
//
// For emission objects the continuum is faint, so flux is scaled so the strongest line reaches 1 at overview resolution.

import { C_KMS, R_OVERVIEW } from '../core/phys.js';
import { MOLECULES } from '../data/molecules.js';
import { hashString } from '../core/rng.js';
import { FWHM_PER_SIGMA, bb, makeProfile, addLine, addBand, planckPeak, snrFromFlux, effectiveFlux, gaussAt } from './kernel.js';
import { renderStars, SOLAR_STAR } from './stellar.js';

// Lines a nebula of the type always has, on top of whatever the data lists. rel is against Hα = 1.
const EMISSION_EXTRAS = [
    { w: 656.28, rel: 1, label: 'Hα', species: 'H I' }, { w: 486.13, rel: 0.35, label: 'Hβ', species: 'H I' },
    { w: 434.05, rel: 0.16, label: 'Hγ', species: 'H I' }, { w: 410.17, rel: 0.09, label: 'Hδ', species: 'H I' },
    { w: 500.68, rel: 0.5, label: '[O III]', species: 'O III' }, { w: 495.89, rel: 0.17, label: '[O III]', species: 'O III' },
    { w: 658.35, rel: 0.3, label: '[N II]', species: 'N II' }, { w: 654.8, rel: 0.1, label: '[N II]', species: 'N II' },
    { w: 671.64, rel: 0.13, label: '[S II]', species: 'S II' }, { w: 673.08, rel: 0.1, label: '[S II]', species: 'S II' },
    { w: 372.73, rel: 0.45, label: '[O II]', species: 'O II' }, { w: 587.56, rel: 0.05, label: 'He I', species: 'He I' },
    { w: 1875.1, rel: 0.13, label: 'Paα', species: 'H I' }, { w: 121.57, rel: 0.2, label: 'Lyα', species: 'H I' }
];
const PLANETARY_EXTRAS = [
    { w: 656.28, rel: 1, label: 'Hα', species: 'H I' }, { w: 486.13, rel: 0.35, label: 'Hβ', species: 'H I' },
    { w: 434.05, rel: 0.16, label: 'Hγ', species: 'H I' }, { w: 410.17, rel: 0.09, label: 'Hδ', species: 'H I' },
    { w: 500.68, rel: 3.2, label: '[O III]', species: 'O III' }, { w: 495.89, rel: 1.07, label: '[O III]', species: 'O III' },
    { w: 658.35, rel: 0.35, label: '[N II]', species: 'N II' }, { w: 654.8, rel: 0.12, label: '[N II]', species: 'N II' },
    { w: 468.57, rel: 0.2, label: 'He II', species: 'He II' }, { w: 386.88, rel: 0.3, label: '[Ne III]', species: 'Ne III' },
    { w: 587.56, rel: 0.1, label: 'He I', species: 'He I' }, { w: 372.73, rel: 0.2, label: '[O II]', species: 'O II' }
];

// The species behind a line label, for the labels the data gives without one
function speciesFromLabel(label) {
    const text = String(label);
    if (text.startsWith('H')) return text.startsWith('He') ? text : 'H I';
    return text.replace(/[[\]]/g, '');
}

function mergedLines(listed, extras) {
    const scaleToHa = listed.find((l) => Math.abs(l.w - 656.28) < 0.5);
    const k = scaleToHa ? scaleToHa.rel : 1;
    const out = listed.map((l) => ({ ...l, species: l.species || speciesFromLabel(l.label) }));
    extras.forEach((extra) => {
        if (!out.some((l) => Math.abs(l.w - extra.w) < 0.5)) out.push({ ...extra, rel: extra.rel * k });
    });
    return out;
}

// How wide a line is in the gas: hydrogen is light, so its atoms move faster
function gasWidth(label, turbulence) {
    return Math.hypot(String(label).startsWith('H') && !String(label).startsWith('He') ? 16 : 7, turbulence);
}

// Scales a line so its peak reaches `rel` at overview resolution, however wide it is
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
    // Hot gas glows faintly at every wavelength; a planetary nebula also has its hot central star
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
        const rel = line.rel / strongest;
        const amp = peakHeight(sigma, rel);
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

// A default illuminating star, stable per nebula, for data that doesn't name one
function defaultIlluminator(body) {
    const seed = hashString(`${body.code}:star`);
    const T = 11000 + 9000 * ((gaussAt(seed, 1) + 3) / 6);
    return {
        class: 'B', stage: 'main_sequence', teff_K: Math.min(22000, Math.max(9000, T)), radius_Rsun: 3, logg: 4.2,
        vsini_kms: 120, composition: { X: 0.71, Y: 0.27, Z: 0.02, metals_dex: {} }
    };
}

function reflectionNebula(body, grid) {
    const nebula = body.nebula;
    const star = nebula.central_star || nebula.illuminating_star || defaultIlluminator(body);
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
        const c = (0.004 * bb(wl[i], 3000)) / peak * Math.exp(-((700 / wl[i]) ** 2));
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

const COMET_FEATURES = [
    // Swan and CN bands are many lines bunched behind a head on the red side
    { w: 388.3, rel: 1, label: 'CN', species: 'CN', band: 4 },
    { w: 473.7, rel: 0.45, label: 'C₂', species: 'C2', band: 9 },
    { w: 516.5, rel: 0.8, label: 'C₂', species: 'C2', band: 9 },
    { w: 563.5, rel: 0.4, label: 'C₂', species: 'C2', band: 9 },
    { w: 589.0, rel: 0.4, label: 'Na D', species: 'Na I' },
    { w: 589.59, rel: 0.25, label: 'Na D', species: 'Na I' }
];

export function cometSpectrum(body, grid) {
    const comet = body.comet || {};
    const factor = 1 + (body.radial_velocity_kms ?? 0) / C_KMS;
    const { flux, continuum, lines } = renderStars([{ star: SOLAR_STAR, factor, weight: 1, code: body.code }], grid);
    const { wl, n } = grid;

    // A gassy comet shows its emission more strongly against a fainter dust continuum
    const dust = comet.dust_ratio ?? 0.5;
    const gas = 0.5 + 1.5 * (1 - dust);
    const listed = comet.emission_lines || [];
    const strengthOf = (feature) => {
        const found = listed.find((l) => Math.abs(l.w - feature.w) < 1.2);
        return found ? found.rel : feature.rel;
    };

    const out = [];
    const prof = makeProfile({ sigma: 2, R: grid.R });
    COMET_FEATURES.forEach((feature) => {
        const amp = gas * strengthOf(feature);
        const obs = feature.w * factor;
        if (feature.band) {
            const band = { c: feature.w - feature.band / 2, w: feature.band, shape: 'edge', head: 'red' };
            addBand(flux, grid, band, amp, factor);
        } else {
            addLine(flux, grid, obs, peakHeight(2, amp * 0.7), prof);
        }
        if (obs >= grid.lo && obs <= grid.hi) {
            out.push({ rest_nm: feature.w, obs_nm: obs, species: feature.species, label: feature.label, depth: amp, type: 'em' });
        }
    });
    void MOLECULES;

    // Warm dust glows in the thermal infrared
    const dustPeak = planckPeak(290);
    for (let i = 0; i < n; i++) {
        const heat = (0.25 + 0.5 * dust) * (bb(wl[i] / factor, 290) / dustPeak);
        flux[i] += heat;
        continuum[i] += heat;
    }
    lines.push(...out);
    return {
        flux,
        continuum,
        lines,
        fRef: 1,
        snr: snrFromFlux(effectiveFlux(body.brightness)),
        mode: 'reflection',
        note: 'Sunlight reflected off dust, with the Sun\'s absorption lines, plus bright emission from gas in the coma: CN, C₂ and sodium.'
    };
}
