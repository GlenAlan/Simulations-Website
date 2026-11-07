// Galaxies and quasars: everything, continuum included, is stretched by 1 + z.
//
// A galaxy is the summed light of a few stellar populations, with its stars' motions smearing every line. A quasar is a
// power-law continuum with broad emission from gas whirling round a black hole.

import { C_KMS, SPECTRUM_LO_NM, SPECTRUM_HI_NM } from '../core/phys.js';
import { hashString } from '../core/rng.js';
import { effectiveFlux, snrFromFlux, makeProfile, addLine, mulLine, gaussAt } from './kernel.js';
import { renderStars } from './stellar.js';

const solarMix = { X: 0.71, Y: 0.27, Z: 0.02, metals_dex: {} };
const population = (teff_K, logg) => ({ teff_K, logg, radius_Rsun: 1, vsini_kms: 0, composition: solarMix, stage: 'main_sequence' });

const OLD_GIANTS = population(4500, 2.8);
const OLD_DWARFS = population(5500, 4.4);
const YOUNG_F = population(6500, 4.3);
const YOUNG_A = population(9000, 4.2);

// [population, share of light at its own peak]
const MIXES = {
    elliptical: { stars: [[OLD_GIANTS, 0.8], [OLD_DWARFS, 0.2]], dispersion: 210, emission: 0, breakDepth: 0.4 },
    spiral: { stars: [[OLD_GIANTS, 0.45], [OLD_DWARFS, 0.3], [YOUNG_F, 0.15], [YOUNG_A, 0.1]], dispersion: 120, emission: 1, breakDepth: 0.22 },
    irregular: { stars: [[OLD_DWARFS, 0.35], [YOUNG_F, 0.3], [YOUNG_A, 0.35]], dispersion: 70, emission: 1.6, breakDepth: 0.1 }
};

const GALAXY_EMISSION = [
    [656.28, 'Hα', 'H I', 1], [658.35, '[N II]', 'N II', 0.3], [654.8, '[N II]', 'N II', 0.1], [486.13, 'Hβ', 'H I', 0.25],
    [500.68, '[O III]', 'O III', 0.25], [372.73, '[O II]', 'O II', 0.45], [671.64, '[S II]', 'S II', 0.15]
];

export function redshiftOf(body) {
    if (body.quasar) return body.quasar.z;
    if (body.galaxy && body.galaxy.z !== undefined) return body.galaxy.z;
    return (body.radial_velocity_kms ?? 0) / C_KMS;
}

function shiftNote(z) {
    return z >= 0.1
        ? `This object is so far away that z = ${z.toFixed(2)} is too large for v = cz to be accurate, so quote z itself.`
        : '';
}

export function galaxySpectrum(body, grid) {
    const galaxy = body.galaxy;
    const mix = MIXES[galaxy.morphology] || MIXES.spiral;
    const z = redshiftOf(body);
    const factor = 1 + z;
    const parts = mix.stars.map(([star, share]) => {
        // A population's weight is set so each contributes its share of the combined peak
        const weight = share / star.teff_K ** 5;
        return { star, factor, weight, code: body.code, sigma: mix.dispersion };
    });
    const out = renderStars(parts, grid);
    const { flux, continuum, lines } = out;
    const { n, wl } = grid;

    // The 400 nm break: old stars pile up metal lines just blueward of it
    for (let i = 0; i < n; i++) {
        const rest = wl[i] / factor;
        flux[i] *= 1 - mix.breakDepth / (1 + Math.exp((rest - 400) / 4));
    }

    if (mix.emission > 0) {
        // Star-forming gas: bright lines, smeared by the disc's rotation as seen at this tilt
        const tilt = Math.sin(((galaxy.inclination_deg ?? 50) * Math.PI) / 180);
        const sigma = Math.max(40, 110 * tilt);
        const prof = makeProfile({ sigma, R: grid.R });
        GALAXY_EMISSION.forEach(([rest, label, species, rel]) => {
            const obs = rest * factor;
            if (obs < grid.lo * 0.98 || obs > grid.hi * 1.02) return;
            // Hα stands about 0.6 of the local continuum above it in a typical spiral
            const i = Math.max(0, Math.min(n - 1, Math.round((Math.log(obs) - grid.lnLo) / grid.step)));
            const amp = (mix.emission * 0.6 * rel * continuum[i]) / prof.peak;
            addLine(flux, grid, obs, amp, prof);
            if (obs >= grid.lo && obs <= grid.hi) {
                lines.push({ rest_nm: rest, obs_nm: obs, species, label, depth: amp * prof.peak, type: 'em' });
            }
        });
    }
    return {
        flux,
        continuum,
        lines,
        fRef: out.fRef,
        snr: snrFromFlux(effectiveFlux(body.brightness)),
        mode: 'absorption',
        note: shiftNote(z)
    };
}

// [rest nm, label, species, height above the continuum, sigma km/s, wing km/s]
const QUASAR_LINES = [
    [121.57, 'Lyα', 'H I', 4.5, 1300, 900],
    [124.0, 'N V', 'N V', 1.1, 1400, 200],
    [139.7, 'Si IV', 'Si IV', 0.45, 1800, 300],
    [154.9, 'C IV', 'C IV', 2.1, 1500, 600],
    [190.9, 'C III]', 'C III', 0.9, 1700, 400],
    [279.8, 'Mg II', 'Mg II', 1.1, 1400, 500],
    [434.05, 'Hγ', 'H I', 0.35, 1400, 300],
    [486.13, 'Hβ', 'H I', 0.8, 1500, 400],
    [500.68, '[O III]', 'O III', 0.6, 220, 0],
    [495.89, '[O III]', 'O III', 0.2, 220, 0],
    [656.28, 'Hα', 'H I', 2.8, 1400, 500]
];

export function quasarSpectrum(body, grid) {
    const z = redshiftOf(body);
    const factor = 1 + z;
    const { n, wl } = grid;
    const lyman = 91.18 * factor;
    const lyAlpha = 121.57 * factor;
    const continuum = new Float64Array(n);
    // F_lambda falls as a power law. Its brightest point is at the blue end of what gets through the Lyman limit.
    const brightestAt = Math.max(SPECTRUM_LO_NM, Math.min(SPECTRUM_HI_NM, lyman));
    for (let i = 0; i < n; i++) {
        const below = 1 / (1 + Math.exp((lyman - wl[i]) / (0.002 * lyman)));
        continuum[i] = (wl[i] / brightestAt) ** -1.5 * below;
    }

    const flux = Float64Array.from(continuum);
    const lines = [];
    QUASAR_LINES.forEach(([rest, label, species, height, sigma, a]) => {
        const obs = rest * factor;
        if (obs < grid.lo * 0.9 || obs > grid.hi * 1.1) return;
        const prof = makeProfile({ sigma, a, R: grid.R });
        // Lines sit on the continuum at their own wavelength
        const local = (obs / brightestAt) ** -1.5;
        const amp = height * local;
        addLine(flux, grid, obs, amp, prof);
        if (obs >= grid.lo && obs <= grid.hi) {
            lines.push({ rest_nm: rest, obs_nm: obs, species, label, depth: amp * prof.peak, type: 'em' });
        }
    });

    // The Lyman-α forest: clouds along the way each take a bite blueward of the quasar's own Lyα
    const seed = hashString(`${body.code}:forest`);
    const forest = new Float64Array(n).fill(1);
    const clouds = Math.round(110 * ((1 + z) / 3) ** 2.2);
    const shape = makeProfile({ sigma: 22, R: grid.R });
    for (let k = 0; k < clouds; k++) {
        const u = 0.5 + 0.5 * Math.tanh(gaussAt(seed, 2 * k));
        const obs = lyman + (lyAlpha - lyman) * u;
        const depth = Math.min(0.95, 0.2 + 0.25 * Math.abs(gaussAt(seed, 2 * k + 1)));
        mulLine(forest, grid, obs, (depth * shape.table[0] ** -1) * 0.5, shape);
    }
    for (let i = 0; i < n; i++) flux[i] *= forest[i];

    const note = `This quasar's lines are shifted by a huge z = ${z.toFixed(2)}, which is too large for v = cz to work: that sum would give a speed above the speed of light at z above 1. Quote z itself.`;
    return {
        flux,
        continuum,
        lines,
        fRef: 1,
        snr: snrFromFlux(effectiveFlux(body.brightness)),
        mode: 'emission',
        note
    };
}
