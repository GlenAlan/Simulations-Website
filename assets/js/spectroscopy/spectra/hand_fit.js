// What a student's own work on the plot comes to: a black-body curve they have laid over a spectrum, a mark they have put
// on its peak, and reference lines they have slid onto its dips. Pure functions on what a student can see, with no DOM.
//
//   topEdge(spectrum)                 -> { nm, level }   the top of the spectrum in narrow bins, ignoring its dips; once per spectrum
//   curveScale(edge, T, lo, hi)       -> amp             how tall the curve for T has to be to sit on that top, across lo..hi nm
//   curveAt(amp, T, nm)               -> flux            the curve itself
//   fitError(T)                       -> K               how closely a curve can be matched by eye, as an uncertainty
//   markOnPeak(peak, nm, slackNm)     -> { on, rising }  whether a mark is on the peak wienPeak found: rising is -1 when the light
//                                                        still rises to the left of the mark, +1 to the right, 0 on the peak
//   slideError({ restNm, z, nmPerPx, widthNm, stepZ }) -> err_nm   how finely a slid line can be set on its dip

import { C_KMS, WIEN_B } from '../core/phys.js';
import { wienCurveAt } from './measure.js';

const WIEN_NM_K = WIEN_B * 1e9;

// ---------- A curve laid over the spectrum ----------

const EDGE_BIN = 0.01;        // In ln(wavelength): 1%, narrow enough to follow a curve, wide enough to hold some continuum
const EDGE_SHARE = 0.85;      // How far up each bin's fluxes the top is read, past most of the lines
const EDGE_SIGMAS = 1.04;     // How many standard deviations of noise lie below that point, taken off again

function lowerBound(wl, nm) {
    let a = 0;
    let b = wl.length;
    while (a < b) {
        const m = (a + b) >> 1;
        if (wl[m] < nm) a = m + 1;
        else b = m;
    }
    return a;
}

export function topEdge(spectrum) {
    const { wl, flux } = spectrum;
    const nm = [];
    const level = [];
    if (!wl || wl.length < 16) return { nm: new Float64Array(0), level: new Float64Array(0) };
    const per = Math.max(4, Math.round(EDGE_BIN / Math.log(wl[1] / wl[0])));
    const buffer = new Float64Array(per);
    const diffs = new Float64Array(per - 1);
    for (let i = 0; i + per <= wl.length; i += per) {
        let n = 0;
        for (let j = 0; j < per; j++) {
            const f = flux[i + j];
            if (f === f) buffer[n++] = f;
        }
        if (n < 4) continue;
        const values = buffer.subarray(0, n).sort();
        const top = values[Math.floor(EDGE_SHARE * (n - 1))];
        // The noise from neighbours' differences, which the lines are too few to move
        for (let j = 0; j + 1 < per; j++) diffs[j] = Math.abs(flux[i + j + 1] - flux[i + j]) || 0;
        const spread = (diffs.slice().sort()[(per - 1) >> 1] * 1.4826) / Math.SQRT2;
        nm.push(wl[i + (per >> 1)]);
        level.push(Math.max(0, top - EDGE_SIGMAS * spread));
    }
    return { nm: Float64Array.from(nm), level: Float64Array.from(level) };
}

// Least squares on the bins in view, so the curve sits on the part of the spectrum the student is looking at. With too few
// bins in view, the nearest few either side are used.
export function curveScale(edge, T, lo, hi) {
    const n = edge.nm.length;
    if (!n) return 0;
    let a = lowerBound(edge.nm, lo);
    let b = lowerBound(edge.nm, hi);
    if (b - a < 3) {
        const mid = Math.min(n - 1, Math.max(0, (a + b) >> 1));
        a = Math.max(0, mid - 2);
        b = Math.min(n, mid + 3);
    }
    let sbb = 0;
    let sby = 0;
    for (let i = a; i < b; i++) {
        const B = wienCurveAt({ T_K: T, amp: 1 }, edge.nm[i]);
        sbb += B * B;
        sby += B * edge.level[i];
    }
    return sbb > 0 ? sby / sbb : 0;
}

export function curveAt(amp, T, nm) {
    return wienCurveAt({ T_K: T, amp }, nm);
}

// Fitting a whole curve by eye in the full range comes within a few per cent for stars cooler than about 32,000 K, measured
// across the sky's stars. Hotter, the peak is off the short end and only a slope is left to match, which hardly changes with
// temperature: an O6 star looks as good at 31,000 K as at 43,000 K.
const PEAK_OFF_SCALE_K = 32000;
export function fitError(T) {
    if (T >= 2 * PEAK_OFF_SCALE_K) return 0.3 * T;
    return (T >= PEAK_OFF_SCALE_K ? 0.2 : 0.05) * T;
}

// ---------- A mark on the peak ----------

// A black body is so flat near its top that 5% below it is as close as an eye can say where the top is, through the lines.
// A mark anywhere in that band, or within slackNm of the top, is on the peak.
const ON_PEAK = 0.95;

export function markOnPeak(peak, nm, slackNm = 0) {
    if (!peak || !(peak.peak_nm > 0)) return { on: false, rising: 0 };
    const top = peak.peak_nm;
    const T = WIEN_NM_K / top;
    const share = wienCurveAt({ T_K: T, amp: 1 }, nm) / wienCurveAt({ T_K: T, amp: 1 }, top);
    if (share >= ON_PEAK || Math.abs(nm - top) <= slackNm) return { on: true, rising: 0 };
    return { on: false, rising: nm > top ? -1 : 1 };
}

// ---------- Reference lines slid onto the dips ----------

// By eye, a line can be set on its dip to within about a sixth of the dip's width, and no finer than about a pixel and a
// half on the plot, or one step of the control moving it. Another line inside the dip can pull its middle aside by up to
// blendNm (measure.js's blendAllowance). Checked by lining the lines up on each dip's middle as drawn, at the zoom the tool's
// own buttons give: 99% of stars and 94% of galaxies within the stated error.
export function slideError({ restNm, z, nmPerPx, widthNm, stepZ = 0, blendNm = 0 }) {
    const obs = restNm * (1 + z);
    return Math.hypot(1.5 * nmPerPx, 0.15 * (widthNm || 0), blendNm, 0.5 * stepZ * restNm, obs * 1e-6);
}

// A quasar's bright lines come from gas whirling round its black hole at thousands of km/s, wider than any one feature a
// measurement might latch onto in their noisy tops. As a share of the wavelength.
export const QUASAR_LINE_WIDTH = 5000 / C_KMS;
