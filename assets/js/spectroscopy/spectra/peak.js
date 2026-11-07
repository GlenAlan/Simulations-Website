// Finds a star's black-body peak from its observed spectrum, through its lines, bands and noise. For the Wien tool.
//
// Simply smoothing a spectrum and taking its highest point doesn't work: a black body's peak is so flat that 3% in
// wavelength is only 0.2% in flux, and a star's lines bite far more than that, more on one side of the peak than the other.
// So this does what a careful student does by eye: trace the top of the spectrum, ignoring the dips, then fit the black-body
// curve to that trace. Pass it a spectrum across the whole range, so the curve has both sides of its peak to hold on to.
//
// blackBodyPeak(spectrum) -> { peak_nm, T_K }

import { WIEN_B, H, C_MS, K_B } from '../core/phys.js';

const BIN_WIDTH = 0.02;      // In ln(wavelength): about 2%, wide enough to always hold some clean continuum
const TOP_SHARE = 0.85;      // How far up each bin's fluxes to read the top of the spectrum
const TOP_SHARE_SIGMAS = 1.04; // How many standard deviations of noise lie below that point
const FLUX_WINDOW = 2.2;     // Only fits within this much of the top, in ln(flux): 11% of the peak
const BLUE_LIMIT_NM = 92;    // The merged Lyman series and its edge sit below this
const C2 = ((H * C_MS) / K_B) * 1e9;

function logPlanck(lam, T) {
    const x = C2 / (lam * T);
    return x > 600 ? -600 : -5 * Math.log(lam) - Math.log(Math.expm1(x));
}

// The top of the spectrum in bins: [{ lam, y }] with y = ln(flux). Reading high up each bin also picks up the noise, by
// about one standard deviation, and more so where the flux is low, which would flatten the curve. So that is taken off.
function traceTop(spectrum) {
    const { wl, flux, snr } = spectrum;
    const per = Math.max(4, Math.round(BIN_WIDTH / Math.log(wl[1] / wl[0])));
    const tops = [];
    const buffer = new Float64Array(per);
    let brightest = 0;
    for (let i = 0; i + per <= wl.length; i += per) {
        const lam = wl[i + (per >> 1)];
        if (lam < BLUE_LIMIT_NM) continue;
        for (let j = 0; j < per; j++) buffer[j] = flux[i + j];
        buffer.sort();
        const top = buffer[Math.floor(TOP_SHARE * (per - 1))];
        tops.push({ lam, top });
        if (top > brightest) brightest = top;
    }
    const noisy = spectrum.flux !== spectrum.clean && Number.isFinite(snr);
    const points = [];
    for (const { lam, top } of tops) {
        const level = noisy ? top - (TOP_SHARE_SIGMAS * Math.sqrt(top * brightest)) / snr : top;
        if (level > 0) points.push({ lam, y: Math.log(level) });
    }
    return points;
}

// Least squares in ln(flux) with a free scale, weighted by flux since the brighter points are the surer ones
function misfit(points, T, peakY) {
    let w = 0;
    let m = 0;
    for (const p of points) {
        const wt = Math.exp(p.y - peakY);
        w += wt;
        m += wt * (p.y - logPlanck(p.lam, T));
    }
    m /= w;
    let chi = 0;
    for (const p of points) {
        const r = p.y - logPlanck(p.lam, T) - m;
        chi += Math.exp(p.y - peakY) * r * r;
    }
    return { chi, scale: m };
}

function bestTemperature(points, peakY, lo, hi, step) {
    let best = Infinity;
    let bestT = lo;
    for (let lt = Math.log(lo); lt < Math.log(hi); lt += step) {
        const T = Math.exp(lt);
        const { chi } = misfit(points, T, peakY);
        if (chi < best) {
            best = chi;
            bestT = T;
        }
    }
    return bestT;
}

export function blackBodyPeak(spectrum) {
    const trace = traceTop(spectrum);
    const peakY = trace.reduce((top, p) => Math.max(top, p.y), -Infinity);
    let points = trace.filter((p) => p.y > peakY - FLUX_WINDOW);
    let T = bestTemperature(points, peakY, 1500, 80000, 0.03);
    for (let round = 0; round < 3; round++) {
        T = bestTemperature(points, peakY, T * 0.86, T * 1.16, 0.003);
        // Whatever still sits well below the curve is full of lines or bands, so leave it out and fit again
        const { scale } = misfit(points, T, peakY);
        const residuals = points.map((p) => p.y - logPlanck(p.lam, T) - scale);
        const spread = Math.sqrt(residuals.reduce((sum, r) => sum + r * r, 0) / residuals.length);
        const kept = points.filter((_, i) => residuals[i] >= -Math.max(0.01, 1.5 * spread));
        if (kept.length >= 6) points = kept;
    }
    T = bestTemperature(points, peakY, T * 0.97, T * 1.03, 0.001);
    return { peak_nm: (WIEN_B / T) * 1e9, T_K: T };
}
