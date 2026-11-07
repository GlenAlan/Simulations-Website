// What the tools measure. Pure functions on a Spectrum, with no DOM, working only on what a student can see: the noisy
// flux and the wavelengths. They never read spectrum.clean, spectrum.continuum or the entity behind the spectrum.
//
//   wienPeak(spectrum)                  -> { peak_nm, T_K, err_K, belowRange, aboveRange, fit: { T_K, amp } | null, spread }
//   lineCentre(spectrum, nearNm, opts?) -> { centre_nm, err_nm, depth, fwhm_nm, type, continuum } | null
//   lineWidth(spectrum, nearNm, opts?)  -> { fwhm_nm, fwhm_kms, velocity_kms, err_kms, unresolved, limit_kms, shape, ... } | null
//   dopplerFrom(centreNm, restNm, errNm?) -> { dlambda_nm, z, v_kms, err_kms, err_z, beyondCz }
//
// Uncertainties are stated so that they cover the true error, not just the scatter: each also allows for what lines,
// blends and the fit's shape do, as checked against every star in the sky.

import { C_KMS, WIEN_B, SPECTRUM_LO_NM, SPECTRUM_HI_NM } from '../core/phys.js';

const NM_PER_M = 1e9;
const WIEN_NM_K = WIEN_B * NM_PER_M;

// ---------- Small tools ----------

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

function quantileSorted(sorted, q) {
    if (!sorted.length) return NaN;
    const at = q * (sorted.length - 1);
    const i = Math.floor(at);
    const j = Math.min(sorted.length - 1, i + 1);
    return sorted[i] + (sorted[j] - sorted[i]) * (at - i);
}

function median(values) {
    return quantileSorted(values.slice().sort((a, b) => a - b), 0.5);
}

// The noise in samples a..b from differences of neighbours: lines are too few to move the median of those.
// 1.4826 turns a median deviation into a standard deviation, and neighbours differ by the root of 2 of it.
function noiseIn(flux, a, b) {
    const diffs = [];
    for (let i = a; i + 1 < b; i++) diffs.push(Math.abs(flux[i + 1] - flux[i]));
    return diffs.length >= 4 ? (median(diffs) * 1.4826) / Math.SQRT2 : 0;
}

// The resolving power of a log-spaced grid with two samples per resolution element
export function resolvingPower(spectrum) {
    const { wl } = spectrum;
    if (!wl || wl.length < 2) return 0;
    return 1 / (2 * (wl[1] / wl[0] - 1));
}

// A black body's shape only, without the constant in front: x = hc / (lambda k T) with hc/k = 1.4388e7 nm K
function planckShape(nm, T) {
    const x = 1.438777e7 / (nm * T);
    if (x > 600) return 0;
    const l = nm / 1000;
    return 1 / (l * l * l * l * l * Math.expm1(x));
}

// ---------- Wien's law ----------

const WIEN_BIN = 0.03;           // Width of each bin in ln(wavelength): wide enough for several lines to leave a gap
const WIEN_KEEP_FROM = 0.12;     // Fit the part of the curve above this share of its peak: the part that fixes the peak
const WIEN_UPPER = 0.85;         // The envelope of a bin is this quantile, less what noise alone adds to it
const WIEN_UPPER_Z = 1.036;      // Standard deviations of noise that quantile sits above the true level
const WIEN_MIN_ERR = 0.015;      // Lines and bands can move the fit this much however clean the spectrum (share of T)

const T_LOW = 300;
const T_HIGH = 300000;

function makeBins(wl, flux) {
    const lo = Math.max(wl[0], SPECTRUM_LO_NM);
    const hi = Math.min(wl[wl.length - 1], SPECTRUM_HI_NM);
    const count = Math.max(1, Math.round(Math.log(hi / lo) / WIEN_BIN));
    const bins = [];
    for (let b = 0; b < count; b++) {
        const from = lo * Math.exp((b * Math.log(hi / lo)) / count);
        const to = lo * Math.exp(((b + 1) * Math.log(hi / lo)) / count);
        const i0 = lowerBound(wl, from);
        const i1 = lowerBound(wl, to);
        if (i1 - i0 >= 8) bins.push({ i0, i1, nm: Math.sqrt(from * to), noise: noiseIn(flux, i0, i1), level: 0, weight: 0, keep: false });
    }
    return bins;
}

// One bin's upper envelope. The samples are first divided by the current fit, so that the slope across the bin doesn't
// count as spread; with no fit yet the bin is used as it stands.
function fillEnvelopes(bins, wl, flux, T) {
    const ref = T ? planckShape : null;
    bins.forEach((bin) => {
        const n = bin.i1 - bin.i0;
        const ratios = new Float64Array(n);
        const centre = ref ? ref(bin.nm, T) : 1;
        const useRef = centre > 0;
        for (let i = 0; i < n; i++) {
            const k = bin.i0 + i;
            const shape = useRef && ref ? ref(wl[k], T) / centre : 1;
            ratios[i] = shape > 0 ? flux[k] / shape : flux[k];
        }
        ratios.sort();
        bin.level = Math.max(0, quantileSorted(ratios, WIEN_UPPER) - WIEN_UPPER_Z * bin.noise);
        // Each bin's level has noise of about 1.6 sigma / sqrt(n), and a share of its own value for lines the bin can't see past
        const stat = (1.6 * bin.noise) / Math.sqrt(n);
        bin.weight = 1 / (stat * stat + (0.01 * bin.level) ** 2 + 1e-30);
    });
}

function fitAt(bins, T) {
    let sxy = 0;
    let sxx = 0;
    const shape = new Array(bins.length);
    bins.forEach((bin, i) => {
        if (!bin.keep) return;
        const s = planckShape(bin.nm, T);
        shape[i] = s;
        sxy += bin.weight * bin.level * s;
        sxx += bin.weight * s * s;
    });
    if (!(sxx > 0)) return { amp: 0, chi: Infinity };
    const amp = sxy / sxx;
    let chi = 0;
    bins.forEach((bin, i) => {
        if (!bin.keep) return;
        const d = bin.level - amp * shape[i];
        chi += bin.weight * d * d;
    });
    return { amp, chi };
}

// The best temperature for the bins in use: a coarse search in ln T, then a golden-section search around its best
function bestTemperature(bins) {
    const steps = 48;
    let best = T_LOW;
    let bestChi = Infinity;
    for (let s = 0; s <= steps; s++) {
        const T = T_LOW * (T_HIGH / T_LOW) ** (s / steps);
        const { chi } = fitAt(bins, T);
        if (chi < bestChi) {
            bestChi = chi;
            best = T;
        }
    }
    const ratio = (T_HIGH / T_LOW) ** (1 / steps);
    let a = Math.log(best / ratio);
    let b = Math.log(best * ratio);
    const g = 0.381966;
    let c = a + g * (b - a);
    let d = b - g * (b - a);
    let fc = fitAt(bins, Math.exp(c)).chi;
    let fd = fitAt(bins, Math.exp(d)).chi;
    for (let i = 0; i < 28; i++) {
        if (fc < fd) {
            b = d;
            d = c;
            fd = fc;
            c = a + g * (b - a);
            fc = fitAt(bins, Math.exp(c)).chi;
        } else {
            a = c;
            c = d;
            fc = fd;
            d = b - g * (b - a);
            fd = fitAt(bins, Math.exp(d)).chi;
        }
    }
    return Math.exp(0.5 * (a + b));
}

// Which bins to trust against the current fit. Absorption can only take light away, so a bin well below the curve is a
// band or a crowd of lines and is dropped, while the bins that touch the curve stay. Bins far from the peak drop out too.
function chooseBins(bins, T, amp) {
    let top = 0;
    bins.forEach((bin) => {
        const model = amp * planckShape(bin.nm, T);
        if (model > top) top = model;
    });
    let kept = 0;
    bins.forEach((bin) => {
        const model = amp * planckShape(bin.nm, T);
        const sd = 1 / Math.sqrt(bin.weight);
        const nearPeak = model >= WIEN_KEEP_FROM * top;
        const notDipped = bin.level >= model - Math.max(3 * sd, 0.025 * model);
        bin.keep = nearPeak && notDipped;
        if (bin.keep) kept++;
    });
    return kept;
}

function fitWien(bins, wl, flux) {
    // Start from the upper envelopes as they stand, using only the bins near the brightest
    fillEnvelopes(bins, wl, flux, 0);
    const brightest = bins.reduce((m, bin) => Math.max(m, bin.level), 0);
    if (!(brightest > 0)) return null;
    bins.forEach((bin) => { bin.keep = bin.level >= 0.2 * brightest; });
    let T = bestTemperature(bins);
    let amp = fitAt(bins, T).amp;
    for (let round = 0; round < 7; round++) {
        fillEnvelopes(bins, wl, flux, T);
        if (chooseBins(bins, T, amp) < 3) break;
        const nextT = bestTemperature(bins);
        amp = fitAt(bins, nextT).amp;
        const settled = Math.abs(nextT / T - 1) < 2e-4 && round >= 2;
        T = nextT;
        if (settled) break;
    }
    return { T, amp };
}

// Refits with the bins resampled at random, to see how much the answer rests on any few of them. A fixed stream of
// numbers, so the same spectrum always gives the same uncertainty.
function resampledSpread(bins, T) {
    const kept = bins.filter((bin) => bin.keep);
    if (kept.length < 4) return 0.05;
    let seed = 12345;
    const next = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const rounds = 24;
    let sum = 0;
    for (let r = 0; r < rounds; r++) {
        const sample = kept.map(() => ({ ...kept[Math.floor(next() * kept.length)] }));
        const t = bestTemperature(sample);
        const d = Math.log(t / T);
        sum += d * d;
    }
    return Math.sqrt(sum / rounds);
}

export function wienPeak(spectrum) {
    const none = { peak_nm: null, T_K: null, err_K: null, belowRange: false, aboveRange: false, fit: null, spread: null };
    const { wl, flux } = spectrum || {};
    if (!wl || wl.length < 100) return none;
    const bins = makeBins(wl, flux);
    if (bins.length < 4) return none;
    const fit = fitWien(bins, wl, flux);
    if (!fit) return none;
    const peak = WIEN_NM_K / fit.T;
    const curve = { T_K: fit.T, amp: fit.amp };
    if (peak < wl[0]) {
        // No peak on the plot to read, so no number that looks like a reading
        return { ...none, belowRange: true, fit: curve, spread: resampledSpread(bins, fit.T) };
    }
    if (peak > wl[wl.length - 1]) {
        return { ...none, aboveRange: true, fit: curve };
    }
    const spread = resampledSpread(bins, fit.T);
    // A peak close to the edge of the range has less of its curve on show, and its uncertainty grows to match
    const edge = Math.max(0, 1 - Math.log(peak / wl[0]) / Math.log(1.6));
    const fraction = Math.hypot(4 * spread, WIEN_MIN_ERR * (1 + 0.5 * edge));
    return { peak_nm: peak, T_K: WIEN_NM_K / peak, err_K: fraction * fit.T, belowRange: false, aboveRange: false, fit: curve, spread };
}

// A curve to draw over the spectrum: what the fit says the flux is at a wavelength
export function wienCurveAt(fit, nm) {
    return fit ? fit.amp * planckShape(nm, fit.T_K) : 0;
}

// ---------- Lines ----------

const LINE_WINDOW_PX = 36;       // Half-width of the first look around a line, in samples
const LINE_WINDOW_MAX_PX = 1200;
const CENTRE_FLOOR_RES = 0.04;   // A line's centre can't be trusted better than this share of a resolution element
const CENTRE_FLOOR_WIDTH = 0.06; // ... or this share of its own width, because neighbours lean on it

function smoothed(flux, a, b, half) {
    const out = new Float64Array(b - a);
    for (let i = a; i < b; i++) {
        let sum = 0;
        let n = 0;
        for (let j = Math.max(0, i - half); j <= Math.min(flux.length - 1, i + half); j++) {
            const f = flux[j];
            if (f === f) {
                sum += f;
                n++;
            }
        }
        out[i - a] = n ? sum / n : 0;
    }
    return out;
}

// A straight continuum under a line from the upper part of each side of the window. In a crowded stretch this is a
// pseudo-continuum, which is all that a line's centre and width need.
function sideContinuum(wl, flux, a, b, centre, gap, sigma, wantLower) {
    const q = wantLower ? 0.3 : 0.8;
    const offset = wantLower ? -0.52 : 0.84;
    const side = (from, to) => {
        const s = [];
        for (let i = Math.max(0, from); i < Math.min(flux.length, to); i++) s.push(flux[i]);
        if (s.length < 3) return null;
        s.sort((x, y) => x - y);
        return quantileSorted(s, q) - offset * sigma;
    };
    const left = side(a, centre - gap);
    const right = side(centre + gap, b);
    const xa = 0.5 * (a + centre - gap);
    const xb = 0.5 * (b + centre + gap);
    if (left === null && right === null) return null;
    if (left === null) return () => right;
    if (right === null) return () => left;
    const slope = (right - left) / (xb - xa);
    return (i) => left + slope * (i - xa);
}

// How far a line's own valley runs each way from its deepest point: until it has climbed out, or until it starts down
// again into a neighbour. That keeps a line blended with its neighbour, such as Ca II H with K, from being read as one line.
function lineBasin(depths, centre, height, sigma) {
    const rise = Math.max(2.2 * sigma, 0.06 * height);
    const walk = (dir) => {
        let i = centre;
        let lowest = depths[centre];
        let lowestAt = centre;
        while (i + dir >= 0 && i + dir < depths.length) {
            i += dir;
            const d = depths[i];
            if (d < lowest) {
                lowest = d;
                lowestAt = i;
            } else if (d > lowest + rise) {
                return lowestAt;
            }
            if (lowest < 0.08 * height) return lowestAt;
        }
        return lowestAt;
    };
    return { from: walk(-1), to: walk(1) };
}

// Where a line crosses a level on each side of its deepest point, keeping inside its valley. A side that never gets down
// to that level, because a neighbour is in the way, is given the other side's width.
function widthAt(depths, centre, level, basin) {
    let l = centre;
    while (l > basin.from && depths[l - 1] >= level) l--;
    let r = centre;
    while (r < basin.to && depths[r + 1] >= level) r++;
    const edge = (i, j, limit) => {
        const a = depths[i];
        if (i === limit || j < 0 || j >= depths.length) return a <= level ? 0 : null;
        const b = depths[j];
        return a > b ? (a - level) / (a - b) : 0;
    };
    const eL = edge(l, l - 1, basin.from);
    const eR = edge(r, r + 1, basin.to);
    let left = centre - (centre - l + (eL ?? 0));
    let right = centre + (r - centre + (eR ?? 0));
    if (eL === null && eR !== null) left = centre - (right - centre);
    if (eR === null && eL !== null) right = centre + (centre - left);
    return { left, right };
}

// Fit a Gaussian (centre, height, sigma) to the core of a line, Gauss-Newton on what's left after the continuum. Returns
// the centre and sigma in samples with their standard errors, scaled by how badly the shape actually fits.
function fitGaussian(y, c0, h0, s0, half, basin) {
    let c = c0;
    let h = h0;
    let s = Math.max(0.6, s0);
    const lo = Math.max(0, basin.from, Math.floor(c0 - half));
    const hi = Math.min(y.length - 1, basin.to, Math.ceil(c0 + half));
    const n = hi - lo + 1;
    if (n < 4) return null;
    let cov = null;
    for (let iter = 0; iter < 10; iter++) {
        let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0;
        for (let i = lo; i <= hi; i++) {
            const u = (i - c) / s;
            const g = Math.exp(-0.5 * u * u);
            const r = y[i] - h * g;
            const jc = (h * g * u) / s;
            const jh = g;
            const js = (h * g * u * u) / s;
            a00 += jc * jc; a01 += jc * jh; a02 += jc * js;
            a11 += jh * jh; a12 += jh * js; a22 += js * js;
            b0 += jc * r; b1 += jh * r; b2 += js * r;
        }
        const m00 = a11 * a22 - a12 * a12;
        const m01 = a02 * a12 - a01 * a22;
        const m02 = a01 * a12 - a02 * a11;
        const det = a00 * m00 + a01 * m01 + a02 * m02;
        if (!(Math.abs(det) > 1e-30)) break;
        const inv00 = m00 / det;
        const inv01 = m01 / det;
        const inv02 = m02 / det;
        const inv11 = (a00 * a22 - a02 * a02) / det;
        const inv12 = (a01 * a02 - a00 * a12) / det;
        const inv22 = (a00 * a11 - a01 * a01) / det;
        const dc = inv00 * b0 + inv01 * b1 + inv02 * b2;
        const dh = inv01 * b0 + inv11 * b1 + inv12 * b2;
        const ds = inv02 * b0 + inv12 * b1 + inv22 * b2;
        // Small steps only: the start is already close, and a noisy line mustn't send the fit off to its neighbour
        c += Math.max(-s, Math.min(s, dc));
        h += Math.max(-Math.abs(h), Math.min(Math.abs(h), dh));
        s = Math.max(0.5, Math.min(half * 1.5, s + Math.max(-0.5 * s, Math.min(0.5 * s, ds))));
        cov = { inv00, inv22 };
        if (Math.abs(dc) < 1e-3 && Math.abs(ds) < 1e-3) break;
    }
    if (!cov || !(h === h) || !(c >= lo - 2 && c <= hi + 2)) return null;
    let rss = 0;
    for (let i = lo; i <= hi; i++) {
        const u = (i - c) / s;
        const r = y[i] - h * Math.exp(-0.5 * u * u);
        rss += r * r;
    }
    const variance = rss / Math.max(1, n - 3);
    return { c, h, s, errC: Math.sqrt(Math.max(0, cov.inv00 * variance)), errS: Math.sqrt(Math.max(0, cov.inv22 * variance)) };
}

// Finds the line at a wavelength: its type, a continuum under it, and its depth profile. opts.searchNm is how far from
// nearNm the line may be: the plot passes a few pixels' worth. Grows its window until the line fits well inside it.
function findLine(spectrum, nearNm, opts = {}) {
    const { wl, flux } = spectrum;
    if (!wl || wl.length < 8 || nearNm < wl[0] || nearNm > wl[wl.length - 1]) return null;
    const step = Math.log(wl[1] / wl[0]);
    const i0 = Math.min(wl.length - 1, lowerBound(wl, nearNm));
    const searchPx = Math.max(2, Math.round((opts.searchNm ?? 0) / (nearNm * step)));
    const smooth = 1;
    let half = Math.max(LINE_WINDOW_PX, searchPx * 3);
    let found = null;

    while (half <= LINE_WINDOW_MAX_PX) {
        const a = Math.max(0, i0 - half);
        const b = Math.min(wl.length, i0 + half + 1);
        if (b - a < 8) return null;
        const sigma = noiseIn(flux, a, b);
        const profile = smoothed(flux, a, b, smooth);
        const list = Array.from(profile).sort((x, y) => x - y);
        const middle = quantileSorted(list, 0.5);
        // The strongest feature in reach, up or down
        const sa = Math.max(0, i0 - searchPx - a);
        const sb = Math.min(b - a - 1, i0 + searchPx - a);
        let dip = sa;
        let bump = sa;
        for (let i = sa; i <= sb; i++) {
            if (profile[i] < profile[dip]) dip = i;
            if (profile[i] > profile[bump]) bump = i;
        }
        const upper = quantileSorted(list, 0.8);
        const lower = quantileSorted(list, 0.3);
        const bumpAmp = profile[bump] - Math.max(middle, lower);
        const dipAmp = upper - profile[dip];
        const type = opts.type || (spectrum.mode === 'emission' || bumpAmp > dipAmp * (spectrum.mode === 'absorption' ? 1.5 : 1) ? 'em' : 'abs');
        const centreIndex = (type === 'em' ? bump : dip) + a;
        // The continuum, keeping clear of the middle of the window
        const gap = Math.round(half * 0.4);
        const cont = sideContinuum(wl, flux, centreIndex - half, centreIndex + half + 1, centreIndex, gap, sigma, type === 'em');
        if (!cont) return null;
        const y = new Float64Array(b - a);
        const ys = new Float64Array(b - a);
        for (let i = 0; i < b - a; i++) {
            const level = cont(a + i);
            const sign = type === 'em' ? 1 : -1;
            y[i] = sign * (flux[a + i] - level);
            ys[i] = sign * (profile[i] - level);
        }
        const at = centreIndex - a;
        const height = ys[at];
        if (!(height > 0)) return null;
        const basin = lineBasin(ys, at, height, sigma / Math.sqrt(2 * smooth + 1));
        const { left, right } = widthAt(ys, at, 0.5 * height, basin);
        const widthPx = right - left;
        // The line must sit well inside the window, or its sides were taken for the continuum
        if (widthPx * 3 >= half * 0.8 && half < LINE_WINDOW_MAX_PX) {
            half *= 2;
            continue;
        }
        found = { a, b, sigma, at, height, y, ys, cont, type, left, right, step, half, basin };
        break;
    }
    return found;
}

// How far above the noise a feature has to stand before it counts as a line at all
function significant(line) {
    const width = Math.max(2, line.right - line.left);
    return line.height >= (line.sigma * 3.2) / Math.sqrt(Math.min(width, 16) * 0.5 + 0.5);
}

export function lineCentre(spectrum, nearNm, opts = {}) {
    const line = findLine(spectrum, nearNm, opts);
    if (!line || !significant(line)) return null;
    const { wl } = spectrum;
    const R = resolvingPower(spectrum);
    const s0 = Math.max(0.8, (line.right - line.left) / 2.3548);
    const fit = fitGaussian(line.y, 0.5 * (line.left + line.right), line.height, s0, Math.max(3, 1.6 * 2.3548 * s0), line.basin);
    const index = fit ? fit.c : 0.5 * (line.left + line.right);
    const at = line.a + Math.max(0, Math.min(line.b - line.a - 1, index));
    const k = Math.floor(at);
    const nm = wl[k] * (wl[Math.min(wl.length - 1, k + 1)] / wl[k]) ** (at - k);
    const sigmaPx = fit ? fit.s : s0;
    const fwhmPx = fit ? 2.3548 * fit.s : line.right - line.left;
    const fwhmNm = fwhmPx * line.step * nm;
    const resNm = nm / R;
    const fitErr = fit ? fit.errC * line.step * nm : (sigmaPx * line.step * nm) / 2;
    // A line that leans has a neighbour hiding in it: the middle of its top half and its bottom half disagree
    const high = widthAt(line.ys, line.at, 0.7 * line.height, line.basin);
    const low = widthAt(line.ys, line.at, 0.3 * line.height, line.basin);
    const lean = Math.abs(0.5 * (high.left + high.right) - 0.5 * (low.left + low.right)) * line.step * nm;
    const err = Math.hypot(1.8 * fitErr, CENTRE_FLOOR_RES * resNm, CENTRE_FLOOR_WIDTH * fwhmNm, lean);
    const contLevel = line.cont(line.a + line.at);
    return {
        centre_nm: nm,
        err_nm: err,
        depth: contLevel > 0 ? line.height / contLevel : null,
        height: line.height,
        fwhm_nm: fwhmNm,
        type: line.type,
        continuum: contLevel,
        sn: line.sigma > 0 ? line.height / line.sigma : Infinity
    };
}

// ---------- Line width ----------

const ROTATION_HWHM = 0.78;      // A rotating star's line is 0.78 v sin i wide at half depth (limb darkening 0.6)
const LINE_INTRINSIC_KMS = 3.2;  // FWHM of a metal line with no rotation at all: heat and small-scale motion in the gas

// The smallest rotation a resolving power can show: about a quarter of the resolution, and never under 5 km/s
export function rotationLimitKms(R) {
    return Math.max(5, (0.8 * C_KMS) / R / 2);
}

export function lineWidth(spectrum, nearNm, opts = {}) {
    const line = findLine(spectrum, nearNm, opts);
    if (!line || !significant(line)) return null;
    const centre = lineCentre(spectrum, nearNm, opts);
    if (!centre) return null;
    const R = resolvingPower(spectrum);
    const instrument = C_KMS / R;
    const fwhmKms = (centre.fwhm_nm / centre.centre_nm) * C_KMS;

    // Width at a quarter and at three-quarters of the depth. Their ratio tells what made the line: rotation gives steep
    // sides (about 1.6), plain heat a rounded line (2.2), and pressure long wings (3 or more).
    const sn = line.sigma > 0 ? line.height / line.sigma : Infinity;
    let shape = null;
    let wingRatio = null;
    if (sn >= 8 && (line.right - line.left) >= 4) {
        const upper = widthAt(line.ys, line.at, 0.75 * line.height, line.basin);
        const lower = widthAt(line.ys, line.at, 0.25 * line.height, line.basin);
        const narrow = upper.right - upper.left;
        const wide = lower.right - lower.left;
        if (narrow > 0) {
            wingRatio = wide / narrow;
            shape = wingRatio < 1.95 ? 'steep' : wingRatio > 2.7 ? 'wings' : 'rounded';
        }
    }

    const limit = rotationLimitKms(R);
    const excess = fwhmKms * fwhmKms - instrument * instrument - LINE_INTRINSIC_KMS * LINE_INTRINSIC_KMS;
    const velocity = excess > 0 ? (0.5 * Math.sqrt(excess)) / ROTATION_HWHM : 0;
    // Half a resolution element, and a tenth of the width for what neighbours and wings add, on top of the noise
    const sErr = centre.err_nm / centre.centre_nm * C_KMS * 2.3548;
    const err = Math.hypot(sErr * 0.5 / ROTATION_HWHM, 0.1 * instrument, 0.1 * velocity);
    return {
        fwhm_nm: centre.fwhm_nm,
        fwhm_kms: fwhmKms,
        half_nm: centre.fwhm_nm / 2,
        centre_nm: centre.centre_nm,
        err_nm: centre.err_nm,
        continuum: centre.continuum,
        height: centre.height,
        depth: centre.depth,
        type: centre.type,
        instrument_kms: instrument,
        velocity_kms: velocity,
        err_kms: err,
        unresolved: velocity < limit,
        limit_kms: limit,
        shape,
        wingRatio
    };
}

// Lines that pressure widens a lot, so they say little about rotation: hydrogen and helium, and the resonance lines of
// alkali and alkaline-earth atoms
const WINGED_SPECIES = new Set(['H I', 'He I', 'He II']);
const WINGED_LINES = [
    ['Ca II', 393.366], ['Ca II', 396.847], ['Ca II', 849.802], ['Ca II', 854.209], ['Ca II', 866.214], ['Ca I', 422.673],
    ['Na I', 588.995], ['Na I', 589.592], ['K I', 766.49], ['K I', 769.896], ['Mg I', 516.733], ['Mg I', 517.268], ['Mg I', 518.361],
    ['Mg II', 279.553], ['Mg II', 280.271]
];

export function hasLongWings(line) {
    if (WINGED_SPECIES.has(line.species)) return true;
    return WINGED_LINES.some(([species, nm]) => species === line.species && Math.abs(nm - line.rest_nm) < 0.15);
}

// The lines that show a star's rotation best: thin metal lines with clear space around them, in a part of the spectrum
// with plenty of light. Takes an overview spectrum; returns entries of its lines, best first.
export function suggestRotationLines(spectrum, count = 3) {
    const { wl, flux, lines } = spectrum;
    if (!lines || !lines.length) return [];
    let top = 0;
    for (let i = 0; i < flux.length; i += 40) if (flux[i] > top) top = flux[i];
    const absorption = lines.filter((l) => !l.band && l.type !== 'em' && l.obs_nm > 330 && l.obs_nm < 1100);
    const scored = [];
    absorption.forEach((line) => {
        if (hasLongWings(line) || line.depth < 0.02) return;
        const i = Math.min(wl.length - 1, lowerBound(wl, line.obs_nm));
        if (flux[i] < 0.03 * top) return;
        // How far to the nearest line that could disturb this one, as a speed
        let clear = Infinity;
        absorption.forEach((other) => {
            if (other === line || other.depth < 0.25 * line.depth) return;
            clear = Math.min(clear, (Math.abs(other.obs_nm - line.obs_nm) / line.obs_nm) * C_KMS);
        });
        const roomy = Math.min(1, clear / 300);
        const strong = Math.min(line.depth, 0.5);
        scored.push({ line, score: strong * roomy * roomy });
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, count).map((s) => s.line);
}

// ---------- Doppler ----------

export function dopplerFrom(centreNm, restNm, errNm = 0) {
    const dlambda = centreNm - restNm;
    const z = dlambda / restNm;
    const errZ = errNm / restNm;
    return {
        dlambda_nm: dlambda,
        z,
        v_kms: z * C_KMS,
        err_kms: errZ * C_KMS,
        err_z: errZ,
        beyondCz: Math.abs(z) > 0.1
    };
}

// Several lines' speeds combined: a weighted mean, and an uncertainty that grows if they disagree with each other.
// Takes [{ z, err_z }].
export function combineDoppler(list) {
    if (!list.length) return null;
    if (list.length === 1) return { z: list[0].z, err_z: list[0].err_z, v_kms: list[0].z * C_KMS, err_kms: list[0].err_z * C_KMS, disagree: false };
    let w = 0;
    let wz = 0;
    list.forEach((m) => {
        const weight = 1 / Math.max(1e-16, m.err_z * m.err_z);
        w += weight;
        wz += weight * m.z;
    });
    const z = wz / w;
    let chi = 0;
    list.forEach((m) => {
        chi += (m.z - z) ** 2 / Math.max(1e-16, m.err_z * m.err_z);
    });
    const scatter = Math.sqrt(Math.max(1, chi / (list.length - 1)));
    const errZ = scatter * Math.sqrt(1 / w);
    return { z, err_z: errZ, v_kms: z * C_KMS, err_kms: errZ * C_KMS, disagree: chi / (list.length - 1) > 4 };
}
