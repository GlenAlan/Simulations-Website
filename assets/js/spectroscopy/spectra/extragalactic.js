// Galaxies and quasars: everything, continuum included, is stretched by 1 + z.
//
// A galaxy is the summed light of a few stellar populations, with its stars' motions smearing every line. A quasar is a
// power-law continuum with broad emission from gas whirling round a black hole.

import { C_KMS, SPECTRUM_LO_NM, SPECTRUM_HI_NM } from '../core/phys.js';
import { hashString } from '../core/rng.js';
import { effectiveFlux, snrFromFlux, makeProfile, addLine, mulLine, gaussAt, bb } from './kernel.js';
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
    if (body.nucleus && body.nucleus.z !== undefined) return body.nucleus.z;
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
        const depth = Math.min(0.9, 0.2 + 0.2 * Math.abs(gaussAt(seed, 2 * k + 1)));
        mulLine(forest, grid, obs, depth, shape);
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

// ---------- A galaxy's centre: its black hole and the stars round it ----------
//
// The bulge's old stars, their lines smeared by how fast they move (the M-sigma relation links that to the hole), plus
// whatever the hole adds. Feeding and seen down the dust's axis (type 1): a hot disc's blue continuum, broad lines from
// gas whirling round at thousands of km/s, and narrow lines from slower gas further out. Seen through the dust (type 2):
// only the narrow lines, and the warm dust's glow in the infrared. Quiet: the stars alone.

// [rest nm, label, species, equivalent width in nm against the disc's own light]
const BROAD_LINES = [
    [121.567, 'Lyα', 'H I', 10], [154.9, 'C IV', 'C IV', 5], [190.9, 'C III]', 'C III', 2], [279.8, 'Mg II', 'Mg II', 4],
    [434.047, 'Hγ', 'H I', 4], [486.133, 'Hβ', 'H I', 10], [587.562, 'He I', 'He I', 1.5], [656.282, 'Hα', 'H I', 40],
    [1875.1, 'Paα', 'H I', 10]
];
// [rest nm, label, species, strength against [O III] 500.7; or with balmer: true, against Hα, which is 3.5 Hβ]
const NARROW_LINES = [
    [342.6, '[Ne V]', 'Ne V', 0.1], [372.73, '[O II]', 'O II', 0.25], [386.88, '[Ne III]', 'Ne III', 0.12],
    [500.684, '[O III]', 'O III', 1], [495.891, '[O III]', 'O III', 1 / 3],
    [630.03, '[O I]', 'O I', 0.15, true], [654.8, '[N II]', 'N II', 0.33, true], [658.35, '[N II]', 'N II', 1, true],
    [671.64, '[S II]', 'S II', 0.35, true], [673.08, '[S II]', 'S II', 0.3, true]
];
const DUST_T_K = 1300;              // The inner edge of the dust round the disc: as hot as dust can be
const DUST_PEAK_NM = 2.898e6 / DUST_T_K;
const NORM_SAMPLES = 160;           // Fixed points across the range, so the scale is the same whatever part is drawn

export function nucleusSpectrum(entity, grid, host) {
    const n = entity.nucleus;
    const z = redshiftOf(entity);
    const factor = 1 + z;
    const sigma = n.sigma_kms || 200;
    const parts = MIXES.elliptical.stars.map(([star, share]) => ({ star, factor, weight: share / star.teff_K ** 5, code: entity.code, sigma }));
    const out = renderStars(parts, grid);
    const { flux, continuum, lines } = out;
    const { n: count, wl } = grid;
    const starAt = (lam) => parts.reduce((sum, p) => sum + p.weight * bb(lam / p.factor, p.star.teff_K), 0) / out.norm;
    for (let i = 0; i < count; i++) {
        const rest = wl[i] / factor;
        flux[i] *= 1 - MIXES.elliptical.breakDepth / (1 + Math.exp((rest - 400) / 4));
    }

    // How bright the hole's own light is against the stars', at 510 nm in its own frame. Its visible light is about a tenth
    // of all it gives out; the centre of a galaxy holds about a third of its starlight.
    const galaxyL = host && host.galaxy ? host.galaxy.luminosity_Lsun : n.luminosity_Lsun;
    const intrinsic = n.active ? Math.min(5, Math.max(0.02, n.luminosity_Lsun / 10 / (0.3 * galaxyL))) : 0;
    const shown = n.type === 1 ? intrinsic : intrinsic * 0.01;
    const star510 = starAt(510 * factor);
    const discAt510 = shown * star510;
    // The dust takes in about a third of the disc's light and gives it out again near 2 µm, whichever side it's seen from
    const dustPeak = 0.7 * intrinsic * star510;
    const lyman = 91.18 * factor;
    const disc = (lam) => {
        const rest = lam / factor;
        const below = 1 / (1 + Math.exp((lyman - lam) / (0.002 * lyman)));
        return discAt510 * (rest / 510) ** -1.5 * below;
    };
    const dust = (lam) => (dustPeak > 0 ? (dustPeak * bb(lam / factor, DUST_T_K)) / bb(DUST_PEAK_NM, DUST_T_K) : 0);

    // One scale for the whole range: the brightest the continuum gets anywhere in it
    let top = 0;
    for (let k = 0; k <= NORM_SAMPLES; k++) {
        const lam = SPECTRUM_LO_NM * (SPECTRUM_HI_NM / SPECTRUM_LO_NM) ** (k / NORM_SAMPLES);
        top = Math.max(top, starAt(lam) + disc(lam) + dust(lam));
    }
    const scale = 1 / top;
    if (discAt510 > 0 || dustPeak > 0) {
        for (let i = 0; i < count; i++) {
            const added = disc(wl[i]) + dust(wl[i]);
            flux[i] += added;
            continuum[i] += added;
        }
        // The starlight's dark lines are diluted by the light the hole adds
        lines.forEach((line) => {
            const stars = starAt(line.obs_nm);
            line.depth *= stars / (stars + disc(line.obs_nm) + dust(line.obs_nm));
        });
    }
    for (let i = 0; i < count; i++) {
        flux[i] *= scale;
        continuum[i] *= scale;
    }
    // The noise is set by the light of the galaxy's middle in visible light, wherever the disc's ultraviolet peaks
    const lamRef = 550 * factor;
    const fRef = (starAt(lamRef) + disc(lamRef) + dust(lamRef)) * scale;

    // A line's height above the continuum, from its equivalent width: EW = 1.064 h FWHM for a Gaussian
    const heightFor = (ew, rest, fwhm) => (ew * C_KMS) / (1.064 * rest * fwhm);
    // A broad line has wings, from the fastest gas closest in; its core is narrowed to match, so the whole line is still
    // fwhmKms wide at half its height (the pseudo-Voigt's width, for a Lorentzian of 0.24 of that)
    const emit = (rest, label, species, amp, fwhmKms) => {
        const obs = rest * factor;
        if (obs < grid.lo * 0.9 || obs > grid.hi * 1.1 || !(amp > 0)) return 0;
        const broad = fwhmKms > 1000;
        const prof = makeProfile({ sigma: (broad ? 0.865 : 1) * fwhmKms / 2.3548, a: broad ? 0.12 * fwhmKms : 0, R: grid.R });
        addLine(flux, grid, obs, amp, prof);
        return amp * prof.peak;
    };
    // A broad line is marked broad: it's the one to measure the width of (ui/spectrum/tools/line_zoom.js)
    const seen = new Map();
    const list = (rest, label, species, peak, broad = false) => {
        const obs = rest * factor;
        if (!(peak > 0) || obs < grid.lo || obs > grid.hi) return;
        const key = rest.toFixed(1);
        const had = seen.get(key);
        if (had) had.depth += peak;
        else {
            // A broad line's width goes with it, as a wide, low line still shows through noise that would hide a narrow one
            const line = { rest_nm: rest, obs_nm: obs, species, label, depth: peak, type: 'em', ...(broad ? { broad: true, fwhm_kms: n.broad_fwhm_kms } : {}) };
            seen.set(key, line);
            lines.push(line);
        }
    };

    if (n.type === 1 && n.broad_fwhm_kms) {
        BROAD_LINES.forEach(([rest, label, species, ew]) => {
            const h = heightFor(ew, rest, n.broad_fwhm_kms) * disc(rest * factor) * scale;
            list(rest, label, species, emit(rest, label, species, h, n.broad_fwhm_kms), true);
        });
    }
    if (n.active) {
        // [O III] 500.7's strength against the starlight: stronger the brighter the hole is for its galaxy, and in type 1
        // diluted by the disc's own light
        const ew = 1.2 * Math.min(2, Math.max(0.3, n.luminosity_Lsun / (0.5 * galaxyL))) * (n.type === 1 ? 0.25 : 1);
        const oiii = heightFor(ew, 500.684, n.narrow_fwhm_kms) * starAt(500.684 * factor) * scale;
        // Where the broad lines show, the narrow lines on top of and beside them are only a few per cent of their light, and
        // are left out, so a broad line's width can be read cleanly: [O III], which has no broad line, stays
        const alpha = (oiii * 3.5) / (n.oiii_hbeta || 8);
        const nearBroad = (balmer) => n.type === 1 && balmer;
        const narrow = [...NARROW_LINES.map(([rest, label, species, rel, balmer]) => [rest, label, species, nearBroad(balmer) ? 0 : (balmer ? alpha : oiii) * rel]),
            ...(n.type === 1 ? [] : [[486.133, 'Hβ', 'H I', alpha / 3.5], [434.047, 'Hγ', 'H I', alpha / 7.4], [656.282, 'Hα', 'H I', alpha]])];
        narrow.forEach(([rest, label, species, h]) => {
            // Heights scale with the stars' light at each line, as their strengths are against it
            const local = starAt(rest * factor) / starAt(500.684 * factor);
            list(rest, label, species, emit(rest, label, species, h * local, n.narrow_fwhm_kms));
        });
    }
    const note = n.active ? shiftNote(z)
        : 'The black hole here is quiet: it adds nothing you can see, so this is the light of the stars round it.';
    return {
        flux,
        continuum,
        lines,
        fRef,
        snr: snrFromFlux(effectiveFlux(host ? host.brightness : entity.brightness)),
        mode: n.type === 1 ? 'emission' : 'absorption',
        note
    };
}

// ---------- Measuring a broad line ----------
//
// A broad emission line is many times wider than anything the line tools were made for, and noise along its top can look like
// a line of its own. So for one: a straight continuum from either side of a wide window, the line smoothed over a few hundred
// km/s, and its full width where the smoothed line falls to half its height. Works from the spectrum alone.
// Returns { centre_nm, fwhm_nm, fwhm_kms, continuum, height, type: 'em', instrument_kms } or null.
const BROAD_WINDOW = 0.07;          // Half the window, as a share of the wavelength: about 21,000 km/s
const BROAD_SMOOTH_KMS = 400;
const BROAD_SIDE = 0.15;            // The share of the window at each end taken as continuum
const BROAD_FIND_KMS = 2500;        // How far from where it's expected its peak may be
const BROAD_CLEAR = 20;             // Standard deviations of smoothed noise its peak should stand above, for a clean half height

export const BROAD_LINE_HALF = BROAD_WINDOW;

function median(list) {
    const s = list.slice().sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0;
}

export function broadLineWidth(spectrum, nearNm) {
    const { wl, flux } = spectrum;
    if (!wl || wl.length < 20) return null;
    const lo = nearNm * (1 - BROAD_WINDOW);
    const hi = nearNm * (1 + BROAD_WINDOW);
    let a = 0;
    while (a < wl.length && wl[a] < lo) a++;
    let b = wl.length - 1;
    while (b > a && wl[b] > hi) b--;
    const n = b - a + 1;
    if (n < 40) return null;
    const side = Math.max(3, Math.floor(n * BROAD_SIDE));
    const left = [];
    const right = [];
    for (let i = 0; i < side; i++) {
        left.push(flux[a + i]);
        right.push(flux[b - i]);
    }
    const yl = median(left);
    const yr = median(right);
    const xl = wl[a + (side >> 1)];
    const xr = wl[b - (side >> 1)];
    const cont = (x) => yl + ((yr - yl) * (x - xl)) / (xr - xl);
    // Smoothed, over a fixed number of km/s whatever the sampling
    const dv = (wl[a + 1] / wl[a] - 1) * C_KMS;
    const resid = new Float64Array(n);
    for (let i = 0; i < n; i++) resid[i] = flux[a + i] - cont(wl[a + i]);
    const smooth = new Float64Array(n);
    const scatter = Math.sqrt(left.concat(right).reduce((s, y, i) => s + (y - (i < side ? yl : yr)) ** 2, 0) / (2 * side));
    let noise = 0;
    let peak = -1;
    const smoothBy = (kms) => {
        const k = Math.max(1, Math.round(kms / dv / 2));
        let sum = 0;
        let count = 0;
        for (let i = 0; i < Math.min(n, k); i++) { sum += resid[i]; count++; }
        for (let i = 0; i < n; i++) {
            if (i + k < n) { sum += resid[i + k]; count++; }
            if (i - k - 1 >= 0) { sum -= resid[i - k - 1]; count--; }
            smooth[i] = sum / count;
        }
        // The noise left after smoothing, from the continuum's own scatter
        noise = scatter / Math.sqrt(2 * k + 1);
        peak = -1;
        for (let i = 0; i < n; i++) {
            if (Math.abs(wl[a + i] / nearNm - 1) * C_KMS > BROAD_FIND_KMS) continue;
            if (peak < 0 || smooth[i] > smooth[peak]) peak = i;
        }
    };
    const cross = (from, step, half) => {
        for (let i = from; i > 0 && i < n - 1; i += step) {
            if (smooth[i + step] < half) {
                const t = (smooth[i] - half) / (smooth[i] - smooth[i + step]);
                return wl[a + i] + t * (wl[a + i + step] - wl[a + i]);
            }
        }
        return null;
    };
    const widthNow = () => {
        if (peak < 0 || !(smooth[peak] > 5 * noise) || !(smooth[peak] > 0)) return null;
        const l = cross(peak, -1, smooth[peak] / 2);
        const r = cross(peak, 1, smooth[peak] / 2);
        return l === null || r === null ? null : { l, r };
    };
    // A faint line's noisy top would cut its half height short, so it's smoothed more widely until it stands well clear
    for (const kms of [BROAD_SMOOTH_KMS, 2 * BROAD_SMOOTH_KMS, 4 * BROAD_SMOOTH_KMS]) {
        smoothBy(kms);
        if (peak >= 0 && smooth[peak] > BROAD_CLEAR * noise) break;
    }
    const edges = widthNow();
    if (!edges) return null;
    const { l, r } = edges;
    const centre = 0.5 * (l + r);
    const R = 1 / (2 * (wl[a + 1] / wl[a] - 1));
    return {
        centre_nm: centre,
        fwhm_nm: r - l,
        fwhm_kms: ((r - l) / centre) * C_KMS,
        continuum: cont(centre),
        height: smooth[peak],
        type: 'em',
        instrument_kms: C_KMS / R
    };
}
