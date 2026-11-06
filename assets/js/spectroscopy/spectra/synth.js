// FOUNDATION STUB, replaced by the synth track. The API below is the contract; see the brief.
//
// spectrumOf(entity, opts) returns a Spectrum:
//   { wl: Float64Array (nm, log spaced), flux: Float32Array, continuum: Float32Array,
//     lines: [{ rest_nm, obs_nm, species, label, depth, type: 'abs'|'em' }],
//     snr, mode: 'absorption'|'emission'|'reflection'|'thermal'|'none', note }
// opts: { lo_nm, hi_nm, R, t (days), noise, parts (component codes to keep), subtractHost }
// Flux is F_lambda, scaled so the continuum's peak within the full range is 1.

import { SPECTRUM_LO_NM, SPECTRUM_HI_NM, R_OVERVIEW, planck } from '../core/phys.js';

export function makeGrid(lo, hi, R) {
    const step = Math.log(1 + 1 / (2 * R));
    const n = Math.ceil(Math.log(hi / lo) / step) + 1;
    const wl = new Float64Array(n);
    for (let i = 0; i < n; i++) wl[i] = lo * Math.exp(i * step);
    return wl;
}

function blackBody(T, opts) {
    const wl = makeGrid(opts.lo_nm ?? SPECTRUM_LO_NM, opts.hi_nm ?? SPECTRUM_HI_NM, opts.R ?? R_OVERVIEW);
    const flux = new Float32Array(wl.length);
    const peak = planck(Math.max(SPECTRUM_LO_NM, 2.898e6 / T), T);
    for (let i = 0; i < wl.length; i++) flux[i] = planck(wl[i], T) / peak;
    return { wl, flux, continuum: flux.slice(), lines: [], snr: Infinity, mode: 'thermal', note: '' };
}

export function spectrumOf(entity, opts = {}) {
    const star = entity.star || (entity.stars && entity.stars[0].star);
    return blackBody(star ? star.teff_K : 6000, opts);
}

export function referenceSpectrum(refId, opts = {}) {
    return blackBody(opts.T ?? 5800, opts);
}

// The range a spectrum opens on: the visible by default, or wherever its black-body peak sits
export function autoRange(entity) {
    return { lo_nm: 380, hi_nm: 750 };
}
