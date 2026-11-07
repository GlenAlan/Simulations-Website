// What the tools measure. Pure functions on a Spectrum, with no DOM, working only on what a student can see: the noisy
// flux and the wavelengths. They never read a spectrum's noise-free arrays or the entity behind it.
//
//   wienPeak(spectrum)                  -> { peak_nm, T_K, err_K, belowRange, aboveRange, fit: { T_K, amp } | null }
//                                          spectrum must cover the whole range: panelApi.getOverview(), whatever the plot shows
//   lineCentre(spectrum, nearNm, opts?) -> { centre_nm, err_nm, depth, fwhm_nm, type, continuum, height, sn, moved_nm, jumped } | null
//   lineWidth(spectrum, nearNm, opts?)  -> { fwhm_nm, fwhm_kms, velocity_kms, err_kms, unresolved, noReading, limit_kms, base_kms, pressure_kms, shape, ... } | null
//   dopplerFrom(centreNm, restNm, errNm?) -> { dlambda_nm, z, v_kms, err_kms, err_z, beyondCz }
//   fitOrbit(points)                    -> { period_days, err_period_days, K_kms, err_K_kms, gamma_kms, cycles } | null
//   massFunction, minimumUnseenMass, pairMasses: the sums that turn a period and a speed swing into masses
//
// opts: { searchNm (how far from nearNm the line may be), type ('abs'|'em', if known), hydrogen (true for a hydrogen line, whose
//         pressure wings can be as wide as its whole width) }
//
// Uncertainties are stated so that they cover the true error, not just the scatter: each also allows for what lines,
// blends and the fit's shape do, as checked against every star in the sky.

import { AU, C_KMS, G, M_SUN, WIEN_B, SPECTRUM_LO_NM, SPECTRUM_HI_NM } from '../core/phys.js';
import { blackBodyPeak } from './peak.js';
import { makeProfile, profileAt } from './kernel.js';

const WIEN_NM_K = WIEN_B * 1e9;
const FWHM_PER_SIGMA = 2.3548;

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

const WIEN_BIN = 0.03;           // Width of each bin in ln(wavelength) when comparing the spectrum with its curve
const WIEN_KEEP_FROM = 0.12;     // Compare only where the curve is above this share of its peak
const WIEN_UPPER = 0.85;         // A bin's level is this quantile of its samples, less what noise alone adds to it
const WIEN_UPPER_Z = 1.036;      // Standard deviations of noise that quantile sits above the true level
const WIEN_MIN_ERR = 0.015;      // What lines and bands can do to the fit however clean the spectrum, as a share of T
const WIEN_NOISE_ERR = 0.1;      // Divided by the signal-to-noise at the peak, a share of T
const WIEN_COLDEST_K = 1600;     // blackBodyPeak looks no lower than about this
const WIEN_MOST_ERR = 0.3;       // Past this share of T, the light isn't following any one black-body curve

// How the spectrum sits against the curve for T: the curve's height, the signal-to-noise near the peak, and how far the
// spectrum rises above the curve. Absorption can only take light away, so rising above it means this isn't one black body,
// as with the combined light of two stars of different temperatures.
function compareWithCurve(spectrum, T) {
    const { wl, flux } = spectrum;
    const lo = Math.max(wl[0], SPECTRUM_LO_NM);
    const hi = Math.min(wl[wl.length - 1], SPECTRUM_HI_NM);
    const count = Math.max(1, Math.round(Math.log(hi / lo) / WIEN_BIN));
    const top = planckShape(Math.min(hi, Math.max(lo, WIEN_NM_K / T)), T);
    const levels = [];
    let sn = 0;
    for (let b = 0; b < count; b++) {
        const from = lo * Math.exp((b * Math.log(hi / lo)) / count);
        const to = lo * Math.exp(((b + 1) * Math.log(hi / lo)) / count);
        const nm = Math.sqrt(from * to);
        const shape = planckShape(nm, T);
        const i0 = lowerBound(wl, from);
        const i1 = lowerBound(wl, to);
        if (i1 - i0 < 8 || shape < WIEN_KEEP_FROM * top) continue;
        const noise = noiseIn(flux, i0, i1);
        // Divided by the curve, so the slope across a bin doesn't count as spread
        const ratios = new Float64Array(i1 - i0);
        for (let i = i0; i < i1; i++) ratios[i - i0] = flux[i] / Math.max(1e-300, planckShape(wl[i], T) / shape);
        ratios.sort();
        const level = Math.max(0, quantileSorted(ratios, WIEN_UPPER) - WIEN_UPPER_Z * noise);
        if (noise > 0 && level / noise > sn) sn = level / noise;
        levels.push(level / shape);
    }
    if (levels.length < 3) return null;
    levels.sort((a, b) => a - b);
    const amp = quantileSorted(levels, 0.75);
    // Near the top, not the very top: in a faint star one bin's noise mustn't count as light above the curve
    return { amp, sn, over: Math.max(0, quantileSorted(levels, 0.95) / amp - 1) };
}

export function wienPeak(spectrum) {
    const none = { peak_nm: null, T_K: null, err_K: null, belowRange: false, aboveRange: false, fit: null };
    const { wl } = spectrum || {};
    // Bright lines with next to no continuum have no black-body curve to fit
    if (!wl || wl.length < 100 || spectrum.mode === 'emission') return none;
    const { T_K: T } = blackBodyPeak(spectrum);
    const peak = WIEN_NM_K / T;
    const seen = compareWithCurve(spectrum, T);
    if (!seen || !(seen.amp > 0)) return none;
    const fit = { T_K: T, amp: seen.amp };
    // No peak on the plot to read, so no number that looks like a reading
    if (peak < wl[0]) return { ...none, belowRange: true, fit };
    if (T < WIEN_COLDEST_K) return { ...none, aboveRange: true };
    // A peak close to the edge of the range has less of its curve on show, and its uncertainty grows to match
    const edge = Math.max(0, 1 - Math.log(peak / wl[0]) / Math.log(1.6));
    const fraction = Math.hypot(WIEN_MIN_ERR * (1 + 0.5 * edge), seen.sn > 0 ? WIEN_NOISE_ERR / seen.sn : 0, seen.over);
    if (fraction > WIEN_MOST_ERR) return none;
    return { peak_nm: peak, T_K: T, err_K: fraction * T, belowRange: false, aboveRange: false, fit };
}

// What the fitted curve says the flux is at a wavelength, for drawing it over the spectrum
export function wienCurveAt(fit, nm) {
    return fit ? fit.amp * planckShape(nm, fit.T_K) : 0;
}

// ---------- Lines ----------

const LINE_WINDOW_PX = 36;       // Half-width of the first look around a line, in samples
const LINE_WINDOW_MAX_PX = 1200;
const CENTRE_FLOOR_RES = 0.04;   // A line's centre can't be trusted better than this share of a resolution element
const CENTRE_FLOOR_WIDTH = 0.012; // ... or this share of its own width, because neighbours lean on it
const LINE_SCALES = [1, 3, 7, 15, 31]; // Half-widths of the smoothing tried on a line, in samples
const LINE_CLEAR_SIGMA = 7;      // How many standard deviations of noise a line must clear before no more smoothing is needed

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
function sideContinuum(flux, a, b, centre, gap, sigma, wantLower) {
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
    const rise = Math.max(3.5 * sigma, 0.1 * height);
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
            const js = (h * g * u * u) / s;
            a00 += jc * jc; a01 += jc * g; a02 += jc * js;
            a11 += g * g; a12 += g * js; a22 += js * js;
            b0 += jc * r; b1 += g * r; b2 += js * r;
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

const DIP_COMPARABLE = 0.8;      // A dip this share as deep as the deepest in reach could as well be the one meant
const DIP_CLEAR_SIGMA = 4;       // Standard deviations a smaller dip must clear to count as a dip at all
const DIP_SEPARATE = 0.3;        // How far the spectrum must climb between two dips for them to be two, as a share of the depth

// Looks through the dips between samples from and to of a smoothed profile. Returns the deepest of those near the click's
// sample, and the others the student might have meant: smaller dips the click was nearer to, and any about as deep.
function dipNearestClick(profile, from, to, click, smooth, sigma) {
    const list = Array.from(profile).sort((x, y) => x - y);
    const level = quantileSorted(list, 0.8);
    const reach = 2 * smooth + 1;
    const dips = [];
    let deepest = 0;
    for (let i = from; i <= to; i++) {
        const value = profile[i];
        let lowest = true;
        for (let j = Math.max(0, i - reach); j <= Math.min(profile.length - 1, i + reach) && lowest; j++) {
            if (profile[j] < value) lowest = false;
        }
        if (!lowest) continue;
        const amp = level - value;
        if (amp <= 0) continue;
        dips.push({ i, amp });
        if (amp > deepest) deepest = amp;
    }
    if (!dips.length) {
        let at = from;
        for (let i = from; i <= to; i++) if (profile[i] < profile[at]) at = i;
        return { at, passed: [], rivals: [] };
    }
    const lowest = dips.reduce((a, b) => (b.amp > a.amp ? b : a));
    // About as deep, and a separate dip: the spectrum climbs well out of it before reaching the deepest. Noise on the floor of
    // one wide dip doesn't count.
    const rival = (dip) => {
        if (dip === lowest || dip.amp < DIP_COMPARABLE * deepest) return false;
        let top = -Infinity;
        for (let i = Math.min(dip.i, lowest.i); i <= Math.max(dip.i, lowest.i); i++) if (profile[i] > top) top = profile[i];
        return top - profile[dip.i] >= DIP_SEPARATE * dip.amp;
    };
    let best = lowest;
    dips.forEach((dip) => {
        if (rival(dip) && Math.abs(dip.i - click) < Math.abs(best.i - click)) best = dip;
    });
    const noise = (DIP_CLEAR_SIGMA * sigma) / Math.sqrt(2 * smooth + 1);
    const away = Math.abs(best.i - click);
    const passed = dips
        .filter((dip) => dip !== best && (rival(dip) || dip === lowest || (dip.amp >= noise && Math.abs(dip.i - click) < away)))
        .map((dip) => dip.i);
    const rivals = dips.filter((dip) => dip !== best && (rival(dip) || dip === lowest)).map((dip) => dip.i);
    return { at: best.i, passed, rivals };
}

// Finds the line at a wavelength: its type, a continuum under it, and its depth profile. Grows its window until the line
// fits well inside it.
function findLine(spectrum, nearNm, opts = {}) {
    const { wl, flux } = spectrum;
    if (!wl || wl.length < 8 || nearNm < wl[0] || nearNm > wl[wl.length - 1]) return null;
    const step = Math.log(wl[1] / wl[0]);
    const i0 = Math.min(wl.length - 1, lowerBound(wl, nearNm));
    const searchPx = Math.max(2, Math.round((opts.searchNm ?? 0) / (nearNm * step)));
    let half = Math.max(LINE_WINDOW_PX, searchPx * 3);

    while (half <= LINE_WINDOW_MAX_PX) {
        const a = Math.max(0, i0 - half);
        const b = Math.min(wl.length, i0 + half + 1);
        if (b - a < 8) return null;
        const sigma = noiseIn(flux, a, b);
        // The strongest feature in reach, up or down, at the finest smoothing that lifts it clear of the noise:
        // a wide, shallow line in a noisy spectrum only shows once the noise is smoothed away
        let smooth = 1;
        let profile = null;
        let type = 'abs';
        let centreIndex = i0;
        let bestSign = -1;
        for (const s of LINE_SCALES) {
            if (s * 5 > half && profile) break;
            const trial = smoothed(flux, a, b, s);
            const list = Array.from(trial).sort((x, y) => x - y);
            const sa = Math.max(0, i0 - searchPx - a);
            const sb = Math.min(b - a - 1, i0 + searchPx - a);
            let dip = sa;
            let bump = sa;
            for (let i = sa; i <= sb; i++) {
                if (trial[i] < trial[dip]) dip = i;
                if (trial[i] > trial[bump]) bump = i;
            }
            const bumpAmp = trial[bump] - Math.max(quantileSorted(list, 0.5), quantileSorted(list, 0.3));
            const dipAmp = quantileSorted(list, 0.8) - trial[dip];
            // Up or down: whichever is the bigger, counting the one nearer the click for more, since that's the one being pointed at
            const nearness = (i) => 1 - (0.6 * Math.abs(i + a - i0)) / Math.max(1, searchPx);
            const isBump = bumpAmp * nearness(bump) > dipAmp * nearness(dip) && bumpAmp * Math.sqrt(2 * s + 1) > 4 * sigma;
            const kind = opts.type || (spectrum.mode === 'emission' || isBump ? 'em' : 'abs');
            const amp = kind === 'em' ? bumpAmp : dipAmp;
            const clear = sigma > 0 ? (amp * Math.sqrt(2 * s + 1)) / sigma : Infinity;
            if (clear > bestSign) {
                bestSign = clear;
                smooth = s;
                profile = trial;
                type = kind;
                centreIndex = (kind === 'em' ? bump : dip) + a;
            }
            if (clear >= LINE_CLEAR_SIGMA) break;
        }
        // Of the dips about as deep as the deepest in reach, the one nearest the click: a click on Ca II H means H, not K. A caller
        // that says what kind of line it wants is following a known line through time, not asking what a click meant.
        let others = [];
        let rivals = [];
        if (type === 'abs' && !opts.type) {
            const picked = dipNearestClick(profile, Math.max(0, i0 - searchPx - a), Math.min(b - a - 1, i0 + searchPx - a), i0 - a, smooth, sigma);
            centreIndex = picked.at + a;
            others = picked.passed.map((i) => wl[i + a]);
            rivals = picked.rivals.map((i) => wl[i + a]);
        }
        // The continuum, keeping clear of the middle of the window
        const gap = Math.round(half * 0.4);
        const cont = sideContinuum(flux, centreIndex - half, centreIndex + half + 1, centreIndex, gap, sigma, type === 'em');
        if (!cont) return null;
        const sign = type === 'em' ? 1 : -1;
        const y = new Float64Array(b - a);
        const ys = new Float64Array(b - a);
        for (let i = 0; i < b - a; i++) {
            const level = cont(a + i);
            y[i] = sign * (flux[a + i] - level);
            ys[i] = sign * (profile[i] - level);
        }
        const at = centreIndex - a;
        const height = ys[at];
        if (!(height > 0)) return null;
        const basin = lineBasin(ys, at, height, sigma / Math.sqrt(2 * smooth + 1));
        const { left, right } = widthAt(ys, at, 0.5 * height, basin);
        // The line must sit well inside the window, or its sides were taken for the continuum. A spectrum that stops short
        // of that gets what it has: a narrow view's line can still be centred, and its width is only as good as the view.
        const roomToGrow = half < LINE_WINDOW_MAX_PX && (a > 0 || b < wl.length);
        if ((right - left) * 3 >= half * 0.8 && roomToGrow) {
            half = Math.min(half * 2, LINE_WINDOW_MAX_PX);
            continue;
        }
        return { a, b, sigma, at, height, y, ys, cont, type, left, right, step, half, basin, passedOver: others, rivals };
    }
    return null;
}

// How far above the noise a feature has to stand before it counts as a line at all
function significant(line) {
    const width = Math.max(2, line.right - line.left);
    return line.height >= (line.sigma * 3.2) / Math.sqrt(Math.min(width, 16) * 0.5 + 0.5);
}

// The centre, width and their errors of a line already found
function measureLine(spectrum, line) {
    const { wl } = spectrum;
    const R = resolvingPower(spectrum);
    const s0 = Math.max(0.8, (line.right - line.left) / FWHM_PER_SIGMA);
    const fit = fitGaussian(line.y, 0.5 * (line.left + line.right), line.height, s0, Math.max(3, 1.6 * FWHM_PER_SIGMA * s0), line.basin);
    const index = fit ? fit.c : 0.5 * (line.left + line.right);
    const at = line.a + Math.max(0, Math.min(line.b - line.a - 1, index));
    const k = Math.floor(at);
    const nm = wl[k] * (wl[Math.min(wl.length - 1, k + 1)] / wl[k]) ** (at - k);
    const sigmaPx = fit ? fit.s : s0;
    const fwhmPx = FWHM_PER_SIGMA * sigmaPx;
    const fitErr = fit ? fit.errC * line.step * nm : (sigmaPx * line.step * nm) / 2;
    // A line that leans has a neighbour hiding in it: the middle of its top half and its bottom half disagree
    const high = widthAt(line.ys, line.at, 0.7 * line.height, line.basin);
    const low = widthAt(line.ys, line.at, 0.3 * line.height, line.basin);
    const lean = Math.abs(0.5 * (high.left + high.right) - 0.5 * (low.left + low.right)) * line.step * nm;
    const fwhmNm = fwhmPx * line.step * nm;
    const err = Math.hypot(1.8 * fitErr, (CENTRE_FLOOR_RES * nm) / R, CENTRE_FLOOR_WIDTH * fwhmNm, lean);
    const contLevel = line.cont(line.a + line.at);
    return {
        centre_nm: nm,
        err_nm: err,
        depth: contLevel > 0 ? line.height / contLevel : null,
        height: line.height,
        fwhm_nm: fwhmNm,
        err_fwhm_nm: (fit ? fit.errS * FWHM_PER_SIGMA : fwhmPx / 4) * line.step * nm,
        type: line.type,
        continuum: contLevel,
        sn: line.sigma > 0 ? line.height / line.sigma : Infinity
    };
}

// How far a click may be off and still be on the line it means, as a share of the search: about a pixel on the plot
const CLICK_SLACK = 1.5 / 7;
const RIVAL_CLOSE = 3 / 7;       // Two deep dips this close on the plot, under 3 pixels, can't be told apart by clicking

// A line's centre. moved_nm says how far that is from the click. If the search passed over a smaller dip nearer the click to get
// here, or another deep dip is too close on the plot to tell from this one (jumped), the student may have meant that one,
// so the uncertainty runs out to cover how far off it is.
export function lineCentre(spectrum, nearNm, opts = {}) {
    const line = findLine(spectrum, nearNm, opts);
    if (!line || !significant(line)) return null;
    const out = measureLine(spectrum, line);
    const moved = Math.abs(out.centre_nm - nearNm);
    const search = opts.searchNm ?? 0;
    const crowded = line.rivals.some((nm) => Math.abs(nm - out.centre_nm) < RIVAL_CLOSE * search);
    const jumped = crowded || (line.passedOver.length > 0 && moved > CLICK_SLACK * search);
    const reach = jumped ? Math.max(...line.passedOver.map((nm) => Math.abs(nm - out.centre_nm))) : 0;
    return { ...out, moved_nm: moved, jumped, err_nm: Math.hypot(out.err_nm, reach) };
}

// ---------- Line width ----------

// A rotating star's line is 1.56 v sin i wide at half depth (limb darkening 0.6). Its steep sides and flat bottom make a
// fitted Gaussian come out about 0.9 of that.
export const ROTATION_FWHM = 1.41;
// Heat and small-scale motions in a metal line (km/s, as a standard deviation). Nearly the same in every star.
const LINE_GAS_SIGMA = 1.4;
// A reading has to clear this share of the limit before it counts: the spec's "about 3 to 5 km/s" is where a line stops telling.
const RESOLVED_SHARE = 0.8;
// Past this share of the speed, or of the limit if it reads below that, the line is too noisy to give any answer
const NOISY_SHARE = 0.45;
const NOISY_LIMIT_SHARE = 0.6;
// Past about this a star would fly apart (the fastest in this sky turns at 300). A wider "at most" says the dip isn't one star's
// line, or is all pressure.
export const FASTEST_SPIN_KMS = 400;

// The smallest rotation a resolving power can show: a good part of its resolution, and never under 5 km/s
export function rotationLimitKms(R) {
    return Math.max(5, (0.8 * C_KMS) / R / 2);
}

const FIT_SPINS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 17, 20, 24, 28, 33, 40, 48, 56, 65, 80, 100, 120, 140, 160, 190, 220, 260, 300, 350, 400, 480];
const FIT_PRESSURES = [0, 0.3, 0.6, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 13, 16, 20, 25, 32, 40, 50, 65, 80, 100, 130, 170, 220, 300, 400, 500];
// A narrow line can take finer steps, and needs them: a step in pressure is otherwise made up for by a false spin
const FIT_PRESSURES_FINE = [0, 0.3, 0.6, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.6, 6.3, 7, 8, 9, 10, 11, 12.5, 14, 16, 18, 20, 22, 25, 28, 32, 36, 40, 45, 50, 56, 63];
const FIT_SAMPLES = 320;
const FIT_REACH_KMS = 30;
const FIT_REACH_WIDTHS = 1.5;
const FIT_WIDE_FROM_KMS = 60;
const FIT_WIDE_TO_KMS = 150;
const fitProfiles = new Map();

function fitProfile(vsini, a, R) {
    const key = `${vsini}|${a}|${R}`;
    let prof = fitProfiles.get(key);
    if (!prof) {
        prof = makeProfile({ sigma: LINE_GAS_SIGMA, a, vsini, R });
        if (fitProfiles.size > 900) fitProfiles.clear();
        fitProfiles.set(key, prof);
    }
    return prof;
}

// Splits a line's width into rotation and pressure from its shape: rotation gives steep sides and a flat bottom, and pressure
// a sharp core on long wings. Tries each pair of the two against the line, with its depth and a level offset left free, and
// returns the best spin and pressure and how far the spin can move before the fit gets clearly worse.
function fitBroadening(line, centreIndex, R, widthKms, opts = {}) {
    const dv = C_KMS * line.step;
    // The core and its shoulders: further out, a wide line's wings are mostly its neighbours
    const reach = Math.max(6, Math.max(FIT_REACH_KMS, FIT_REACH_WIDTHS * widthKms) / dv);
    const lo = Math.max(line.basin.from, Math.ceil(centreIndex - reach));
    const hi = Math.min(line.basin.to, Math.floor(centreIndex + reach));
    const stride = Math.max(1, Math.ceil((hi - lo + 1) / FIT_SAMPLES));
    const xs = [];
    const ys = [];
    for (let i = lo; i <= hi; i += stride) {
        xs.push(Math.abs(i - centreIndex) * dv);
        ys.push(line.y[i]);
    }
    const n = xs.length;
    if (n < 5) return null;
    let sy = 0;
    let syy = 0;
    for (let k = 0; k < n; k++) {
        sy += ys[k];
        syy += ys[k] * ys[k];
    }
    const spins = FIT_SPINS.filter((v) => v <= Math.max(3, widthKms * 1.1));
    // A very wide line is mostly rotation: pressure that wide would be its neighbours' doing, unless it's hydrogen
    const wide = Math.min(1, Math.max(0, (widthKms - FIT_WIDE_FROM_KMS) / (FIT_WIDE_TO_KMS - FIT_WIDE_FROM_KMS)));
    const pressureShare = opts.hydrogen ? 0.8 : 0.8 - 0.5 * wide;
    const pressures = (widthKms < FIT_WIDE_FROM_KMS ? FIT_PRESSURES_FINE : FIT_PRESSURES).filter((a) => a <= Math.max(1, widthKms * pressureShare));
    const bestAt = new Float64Array(spins.length).fill(Infinity);
    let best = Infinity;
    let bestSpin = 0;
    let bestA = 0;
    spins.forEach((v, iv) => {
        pressures.forEach((a) => {
            const prof = fitProfile(v, a, R);
            let sm = 0;
            let smm = 0;
            let smy = 0;
            for (let k = 0; k < n; k++) {
                const m = profileAt(prof, xs[k]);
                sm += m;
                smm += m * m;
                smy += m * ys[k];
            }
            const det = n * smm - sm * sm;
            if (!(det > 0)) return;
            const h = (n * smy - sm * sy) / det;
            const o = (sy - h * sm) / n;
            if (!(h > 0)) return;
            const rss = syy - h * smy - o * sy;
            if (rss < bestAt[iv]) bestAt[iv] = rss;
            if (rss < best) {
                best = rss;
                bestSpin = iv;
                bestA = a;
            }
        });
    });
    if (!Number.isFinite(best)) return null;
    // A curve through the best spin and its neighbours, for a value between the steps
    let spin = spins[bestSpin];
    if (bestSpin > 0 && bestSpin < spins.length - 1) {
        const x0 = spins[bestSpin - 1];
        const x1 = spins[bestSpin];
        const x2 = spins[bestSpin + 1];
        const y0 = bestAt[bestSpin - 1];
        const y1 = bestAt[bestSpin];
        const y2 = bestAt[bestSpin + 1];
        const d0 = (y1 - y0) / (x1 - x0);
        const d1 = (y2 - y1) / (x2 - x1);
        const curve = (d1 - d0) / (x2 - x0);
        if (curve > 0) spin = Math.max(x0, Math.min(x2, 0.5 * (x0 + x1) - d0 / (2 * curve)));
    }
    // The noise per sample, or more if the shape really doesn't fit
    const scatter = Math.max(line.sigma * line.sigma, best / Math.max(1, n - 4));
    const worse = best + scatter;
    let low = spins[bestSpin];
    let high = spins[bestSpin];
    for (let k = bestSpin; k >= 0 && bestAt[k] <= worse; k--) low = spins[k];
    for (let k = bestSpin; k < spins.length && bestAt[k] <= worse; k++) high = spins[k];
    if (bestSpin > 0 && low === spins[bestSpin]) low = spin - (spins[bestSpin] - spins[bestSpin - 1]) * Math.min(1, scatter / Math.max(1e-30, bestAt[bestSpin - 1] - best));
    if (bestSpin < spins.length - 1 && high === spins[bestSpin]) high = spin + (spins[bestSpin + 1] - spins[bestSpin]) * Math.min(1, scatter / Math.max(1e-30, bestAt[bestSpin + 1] - best));
    return { spin, a: bestA, err: 0.5 * (high - low) };
}

// Samples averaged in groups: the same light in fewer, cleaner samples
function binned(spectrum, k) {
    const count = Math.floor(spectrum.wl.length / k);
    const wl = new Float64Array(count);
    const flux = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        let sum = 0;
        for (let j = 0; j < k; j++) sum += spectrum.flux[i * k + j];
        flux[i] = sum / k;
        wl[i] = spectrum.wl[i * k] * (spectrum.wl[1] / spectrum.wl[0]) ** ((k - 1) / 2);
    }
    return { wl, flux, snr: spectrum.snr, mode: spectrum.mode };
}

// The line itself, or, at high resolution, the same line from the binned samples if it is a broad one. A fast rotator's lines
// spread over hundreds of samples, each too noisy to follow, and there's no sharp detail to lose by binning them.
function lineToMeasure(spectrum, nearNm, opts) {
    const R = resolvingPower(spectrum);
    if (R >= BIN_FROM_R && spectrum.wl.length >= 8 * BIN_SAMPLES) {
        const coarse = binned(spectrum, BIN_SAMPLES);
        const broad = findLine(coarse, nearNm, opts);
        if (broad && significant(broad) && (broad.right - broad.left) * broad.step * C_KMS >= BROAD_LINE_KMS) {
            return { line: broad, from: coarse };
        }
    }
    return { line: findLine(spectrum, nearNm, opts), from: spectrum };
}

export function lineWidth(spectrum, nearNm, opts = {}) {
    const { line, from } = lineToMeasure(spectrum, nearNm, opts);
    if (!line || !significant(line)) return null;
    const centre = measureLine(from, line);
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
    // The line's centre, as a position in the window
    const centreIndex = Math.log(centre.centre_nm / from.wl[line.a]) / line.step;
    const split = fitBroadening(line, centreIndex, R, fwhmKms, opts);
    const fitted = split ? split.spin : 0;
    const pressureKms = split ? 2 * split.a : 0;
    // What the line would be wide with no spin at all: never less than the instrument and the gas's heat. The speed then follows
    // from it, so that the sum on screen gives the speed on screen.
    const narrowest = Math.hypot(instrument, FWHM_PER_SIGMA * LINE_GAS_SIGMA);
    const baseKms = Math.max(narrowest, Math.sqrt(Math.max(0, fwhmKms * fwhmKms - (ROTATION_FWHM * fitted) ** 2)));
    const velocity = Math.sqrt(Math.max(0, fwhmKms * fwhmKms - baseKms * baseKms)) / ROTATION_FWHM;
    // The fit's own error, some of a resolution element and a share of the answer for what neighbours and wings add
    const err = Math.hypot(split ? split.err : 0, 0.25 * instrument, 0.1 * velocity);
    return {
        fwhm_nm: centre.fwhm_nm,
        fwhm_kms: fwhmKms,
        centre_nm: centre.centre_nm,
        err_nm: centre.err_nm,
        continuum: centre.continuum,
        height: centre.height,
        depth: centre.depth,
        type: centre.type,
        instrument_kms: instrument,
        velocity_kms: velocity,
        err_kms: err,
        unresolved: velocity < RESOLVED_SHARE * limit,
        limit_kms: limit,
        noReading: err > Math.max(NOISY_SHARE * velocity, NOISY_LIMIT_SHARE * limit),
        base_kms: baseKms,
        pressure_kms: pressureKms,
        shape,
        wingRatio
    };
}

const ZOOM_MIN_WINDOW_KMS = 90;     // The narrowest view: wide enough for a narrow line and some continuum either side
const ZOOM_WINDOW_PER_WIDTH = 4;    // Half the view, as a multiple of the line's width
const PICK_WANDER_KMS = 40;         // How far a listed line can seem to sit from where it's listed before the dip is a neighbour's

// Where line zoom should look for a line at nearNm: the overview's width sets how far to zoom. With a listed line it always has an
// answer, though the overview may not show it: a thin line can be too shallow to find there, or sit on a much wider neighbour.
// Returns { centre_nm, half_nm, search_nm } for the view and the search within it, or null.
export function lineZoomWindow(overview, nearNm, opts = {}) {
    const { line, searchNm } = opts;
    const seen = overview ? lineWidth(overview, nearNm, { searchNm, hydrogen: opts.hydrogen }) : null;
    const trusted = seen && (!line
        || (Math.abs(seen.centre_nm - nearNm) / nearNm) * C_KMS < Math.max(PICK_WANDER_KMS, 0.25 * seen.fwhm_kms));
    if (!trusted && !line) return null;
    const centre = trusted ? seen.centre_nm : nearNm;
    const halfKms = Math.max(ZOOM_MIN_WINDOW_KMS, ZOOM_WINDOW_PER_WIDTH * (trusted ? seen.fwhm_kms : 0));
    const half = (centre * halfKms) / C_KMS;
    const near = (centre * 6) / C_KMS;
    return { centre_nm: centre, half_nm: half, search_nm: Math.min(half * 0.3, Math.max(trusted ? seen.fwhm_nm : 0, near)) };
}

// Lines that pressure widens a lot, so they say little about rotation: hydrogen and helium, and the resonance lines of
// alkali and alkaline-earth atoms
const WINGED_SPECIES = new Set(['H I', 'He I', 'He II']);
const WINGED_LINES = [
    ['Ca II', 393.366], ['Ca II', 396.847], ['Ca II', 849.802], ['Ca II', 854.209], ['Ca II', 866.214], ['Ca I', 422.673],
    ['Na I', 588.995], ['Na I', 589.592], ['Na I', 818.326], ['Na I', 819.482], ['K I', 766.49], ['K I', 769.896],
    ['Mg I', 516.733], ['Mg I', 517.268], ['Mg I', 518.361], ['Mg II', 279.553], ['Mg II', 280.271]
];

export function hasLongWings(line) {
    if (WINGED_SPECIES.has(line.species)) return true;
    return WINGED_LINES.some(([species, nm]) => species === line.species && Math.abs(nm - line.rest_nm) < 0.15);
}

// How wide a star's own lines are at this resolution, as a FWHM. Blends only ever make a dip wider, so it goes by the narrower
// of what the deepest lines measure.
function typicalWidthKms(spectrum, thin) {
    const widths = thin
        .filter((line) => line.obs_nm >= 380 && line.obs_nm <= 1000)
        .sort((a, b) => b.depth - a.depth)
        .slice(0, 15)
        .map((line) => lineWidth(spectrum, line.obs_nm, { searchNm: line.obs_nm * 0.0015 }))
        .filter(Boolean)
        .map((w) => w.fwhm_kms)
        .sort((a, b) => a - b);
    return widths.length ? quantileSorted(widths, 0.25) : 0;
}

const BAND_HEAD_CLEAR_KMS = 1300;   // The step at a molecular band's head throws off a line this close to it, at overview resolution
const FAST_SHARPENS = 0.92;         // About 50 km/s: thin lines this wide are all rotation, and their neighbours matter more
const VERY_FAST_SHARPENS = 0.84;    // About 65 km/s: rotation now outweighs pressure in stronger lines too
const FAST_WINGED_LINES_KMS = 200;  // With only stronger lines to go by: a dense star's pressure alone takes them to about 150
const WIDTH_PER_SPIN = 2.5;
const BIN_FROM_R = 50000;
const BIN_SAMPLES = 8;
const BROAD_LINE_KMS = 120;
const ROTATION_LINE_MIN_SNR = 20;   // At the line's own wavelength
const ROTATION_LINE_SIGNAL = 15;    // Standard deviations at which a line is half way to as good as any
const ROTATION_LINE_SIGNAL_MIN = 8; // Fewer than this, and a thin line is lost in the noise
const HYDROGEN_ONLY_SNR = 60;       // A star showing only hydrogen this clearly is hot and spinning: anything fainter just hides its other lines

// The lines that show a star's rotation best, for the spectrum's S/N. A slow star's are thin metal lines with clear space around
// them, in a part of the spectrum with plenty of light, and any line that sits on the head of a molecular band is left out.
// A fast star's thin lines are smeared into each other, so there it is strong lines standing clear of their neighbours, helium's
// and magnesium's among them, since rotation now outweighs their pressure. Takes an overview spectrum; returns entries of its
// lines (or zoomLines), best first. Ca II K and H are never offered, and hydrogen only if nothing else shows.
export function suggestRotationLines(spectrum, count = 3) {
    const { wl, flux, lines, zoomLines } = spectrum;
    if (!lines || !lines.length) return [];
    let top = 0;
    for (let i = 0; i < flux.length; i += 40) if (flux[i] > top) top = flux[i];
    const inRange = (l) => !l.band && l.type !== 'em' && l.obs_nm > 330 && l.obs_nm < 1300;
    const listed = lines.filter(inRange);
    const faint = (zoomLines || []).filter(inRange);
    const metals = listed.filter((l) => l.species !== 'H I' && l.species !== 'Ca II');
    const thin = metals.concat(faint).filter((l) => !hasLongWings(l));
    const width = typicalWidthKms(spectrum, thin.length ? thin : metals);
    const onlyHydrogen = !metals.length && spectrum.snr >= HYDROGEN_ONLY_SNR;
    // Sharpening the instrument deepens a thin line a lot, unless rotation is what sets its width
    const sharpens = thin.length >= 3 ? median(thin.map((l) => (l.depth_zoom ?? l.depth) / Math.max(1e-6, l.depth))) : Infinity;
    const fast = onlyHydrogen || (thin.length >= 3 ? sharpens < FAST_SHARPENS : width >= FAST_WINGED_LINES_KMS);
    const veryFast = onlyHydrogen || (thin.length >= 3 ? sharpens < VERY_FAST_SHARPENS : fast);
    const all = fast ? listed : listed.concat(faint);
    const heads = lines.filter((l) => l.band && l.head_nm !== undefined && l.depth > 0.02);
    const shown = (line) => line.depth_zoom ?? line.depth;
    const signalOf = (line, i) => (fast ? line.depth : shown(line)) * spectrum.snr * Math.sqrt(Math.max(0, flux[i]) / top);
    // A slow star needs a thin line that stands clear of the noise. Without one, the sodium and potassium resonance lines are
    // next best: their pressure can be told apart from a spin of more than a few km/s, though what they give is a limit.
    const thinLineShows = !fast && thin.some((line) => signalOf(line, Math.min(wl.length - 1, lowerBound(wl, line.obs_nm))) >= ROTATION_LINE_SIGNAL_MIN);
    const usable = (line) => {
        if (line.species === 'Ca II') return !hasLongWings(line);
        if (line.species === 'H I') return onlyHydrogen;
        if (!hasLongWings(line)) return true;
        return veryFast || (!thinLineShows && !fast && (line.species === 'K I' || line.species === 'Na I'));
    };
    // The neighbours that count: anything at all comparable in depth, once the star's lines are this wide
    const need = fast ? WIDTH_PER_SPIN * width : 300;
    const scored = [];
    all.forEach((line) => {
        if (!usable(line)) return;
        const i = Math.min(wl.length - 1, lowerBound(wl, line.obs_nm));
        if (!(spectrum.snr * Math.sqrt(Math.max(0, flux[i]) / top) >= ROTATION_LINE_MIN_SNR)) return;
        if (heads.some((h) => (Math.abs(h.head_nm - line.obs_nm) / line.obs_nm) * C_KMS < BAND_HEAD_CLEAR_KMS)) return;
        // How far to the nearest line that could disturb this one, as a speed
        let clear = Infinity;
        listed.forEach((other) => {
            if (other === line || other.depth < 0.25 * line.depth) return;
            const apart = (Math.abs(other.obs_nm - line.obs_nm) / line.obs_nm) * C_KMS;
            // A much stronger line reaches much further, on its wings
            const reach = fast && hasLongWings(other) && other.depth > 2 * line.depth ? width : 0;
            clear = Math.min(clear, Math.max(0, apart - reach));
        });
        const roomy = Math.min(1, clear / need);
        // How far the line stands above the noise at its own wavelength, which a deep line in plenty of light reads best
        const signal = signalOf(line, i);
        if (!fast && thinLineShows && signal < ROTATION_LINE_SIGNAL_MIN) return;
        // A line in the visible is where a student is looking already
        const handy = line.obs_nm >= 380 && line.obs_nm <= 750 ? 1 : 0.6;
        scored.push({ line, score: (signal / (signal + ROTATION_LINE_SIGNAL)) * roomy * roomy * handy });
    });
    scored.sort((a, b) => b.score - a.score);
    // The stars of a multiple system each list the same line
    const unique = [];
    scored.forEach(({ line }) => {
        if (!unique.some((u) => Math.abs(u.rest_nm - line.rest_nm) < 0.05)) unique.push(line);
    });
    return unique.slice(0, count);
}

// The lines best for following through time, given the overview spectrum of each star to be followed. Sharp, deep lines with
// clear space around them, and if at all possible lines that all the stars show. Returns [{ rest_nm, label, species }], best first.
export function suggestTrackingLines(spectra, count = 5) {
    const perStar = spectra.map((spectrum) => {
        const { wl, flux, lines } = spectrum;
        const scores = new Map();
        if (!lines) return scores;
        let top = 0;
        for (let i = 0; i < flux.length; i += 40) if (flux[i] > top) top = flux[i];
        const usable = lines.filter((l) => !l.band && l.type !== 'em' && l.obs_nm > 370 && l.obs_nm < 1000 && l.depth > 0.03);
        usable.forEach((line) => {
            const i = Math.min(wl.length - 1, lowerBound(wl, line.obs_nm));
            const light = Math.sqrt(Math.max(0, flux[i]) / Math.max(1e-30, top));
            let clear = Infinity;
            usable.forEach((other) => {
                if (other !== line && other.depth > 0.5 * line.depth) clear = Math.min(clear, (Math.abs(other.obs_nm - line.obs_nm) / line.obs_nm) * C_KMS);
            });
            const score = Math.min(line.depth, 0.6) * (hasLongWings(line) ? 0.3 : 1) * Math.min(1, clear / 250) * light;
            const key = line.rest_nm.toFixed(2);
            if (!scores.has(key) || scores.get(key).score < score) scores.set(key, { score, line });
        });
        return scores;
    });
    const keys = new Set();
    perStar.forEach((scores) => scores.forEach((_, key) => keys.add(key)));
    const combined = [...keys].map((key) => {
        let least = Infinity;
        let most = 0;
        let line = null;
        perStar.forEach((scores) => {
            const hit = scores.get(key);
            least = Math.min(least, hit ? hit.score : 0);
            if (hit && hit.score > most) {
                most = hit.score;
                line = hit.line;
            }
        });
        return { least, most, line };
    });
    combined.sort((a, b) => b.least - a.least || b.most - a.most);
    return combined.slice(0, count).map(({ line }) => ({ rest_nm: line.rest_nm, label: line.label, species: line.species }));
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

// ---------- Orbits, from a line's position against time ----------

// A trend plus up to three harmonics, by least squares. Returns the coefficients and chi squared.
function solveHarmonics(points, freq, harmonics) {
    const size = 2 + 2 * harmonics;
    const A = Array.from({ length: size }, () => new Float64Array(size + 1));
    const row = new Float64Array(size);
    const t0 = points[0].t;
    const fill = (t) => {
        row[0] = 1;
        row[1] = t - t0;
        for (let h = 1; h <= harmonics; h++) {
            const phase = 2 * Math.PI * h * freq * t;
            row[2 * h] = Math.cos(phase);
            row[2 * h + 1] = Math.sin(phase);
        }
    };
    points.forEach((p) => {
        fill(p.t);
        const w = 1 / (p.err * p.err);
        for (let i = 0; i < size; i++) {
            for (let j = i; j < size; j++) A[i][j] += w * row[i] * row[j];
            A[i][size] += w * row[i] * p.v;
        }
    });
    for (let i = 0; i < size; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i];
    // Gaussian elimination with pivoting
    for (let i = 0; i < size; i++) {
        let pivot = i;
        for (let r = i + 1; r < size; r++) if (Math.abs(A[r][i]) > Math.abs(A[pivot][i])) pivot = r;
        if (Math.abs(A[pivot][i]) < 1e-24) return null;
        [A[i], A[pivot]] = [A[pivot], A[i]];
        for (let r = i + 1; r < size; r++) {
            const k = A[r][i] / A[i][i];
            for (let c = i; c <= size; c++) A[r][c] -= k * A[i][c];
        }
    }
    const coef = new Float64Array(size);
    for (let i = size - 1; i >= 0; i--) {
        let sum = A[i][size];
        for (let c = i + 1; c < size; c++) sum -= A[i][c] * coef[c];
        coef[i] = sum / A[i][i];
    }
    let chi = 0;
    points.forEach((p) => {
        fill(p.t);
        let model = 0;
        for (let i = 0; i < size; i++) model += coef[i] * row[i];
        chi += ((p.v - model) / p.err) ** 2;
    });
    return { coef, chi, harmonics };
}

const ORBIT_MIN_CYCLES = 1.15;   // A period only counts once more than one full cycle has been seen

// The period and speed swing of a line, from points { t (days), v (km/s), err (km/s) } in time order. Takes the shortest
// period that fits as well as any, since twice a period fits just as well. Null until a period shows clearly.
export function fitOrbit(points) {
    const n = points.length;
    if (n < 12) return null;
    const span = points[n - 1].t - points[0].t;
    if (!(span > 0)) return null;
    const dt = span / (n - 1);
    const fLo = ORBIT_MIN_CYCLES / span;
    const fHi = 1 / (4 * dt);
    const harmonicsFor = (f) => Math.max(1, Math.min(3, Math.floor(1 / (f * 2.5 * dt))));

    const flat = solveHarmonics(points, fLo / 1000, 1);
    let trendChi = 0;
    {
        const mean = points.reduce((s, p) => s + p.v / (p.err * p.err), 0) / points.reduce((s, p) => s + 1 / (p.err * p.err), 0);
        points.forEach((p) => { trendChi += ((p.v - mean) / p.err) ** 2; });
    }
    if (!flat) return null;

    const trials = [];
    for (let f = fLo; f <= fHi; f += 1 / (span * 8)) {
        const s = solveHarmonics(points, f, harmonicsFor(f));
        if (s) trials.push({ f, chi: s.chi });
    }
    if (!trials.length) return null;
    const best = trials.reduce((m, s) => Math.min(m, s.chi), Infinity);
    // The highest frequency, so the shortest period, whose fit is about as good as the best, at the bottom of its valley
    let pick = trials.length - 1;
    const good = best * 1.25 + 2 * n * 0.05;
    while (pick > 0 && !(trials[pick].chi <= good && trials[pick - 1].chi >= trials[pick].chi)) pick--;
    let f = trials[pick].f;
    let width = 1 / (span * 8);
    for (let round = 0; round < 24; round++) {
        const a = f - width / 2;
        const b = f + width / 2;
        const ca = a > 0 ? solveHarmonics(points, a, harmonicsFor(f)) : null;
        const cb = solveHarmonics(points, b, harmonicsFor(f));
        const c0 = solveHarmonics(points, f, harmonicsFor(f));
        if (ca && c0 && ca.chi < c0.chi) f = a;
        else if (cb && c0 && cb.chi < c0.chi) f = b;
        else width /= 2;
        if (width * span < 1e-4) break;
    }
    const fit = solveHarmonics(points, f, harmonicsFor(f));
    if (!fit) return null;
    const dof = Math.max(1, n - fit.coef.length);
    // Most of the swing has to be explained by the cycle, and the swing has to stand above the scatter left over
    if (fit.chi > 0.5 * trendChi && fit.chi / dof > 2) return null;
    const period = 1 / f;
    if (span / period < ORBIT_MIN_CYCLES) return null;

    const value = (t) => {
        let sum = 0;
        for (let h = 1; h <= fit.harmonics; h++) {
            const phase = 2 * Math.PI * h * f * t;
            sum += fit.coef[2 * h] * Math.cos(phase) + fit.coef[2 * h + 1] * Math.sin(phase);
        }
        return sum;
    };
    let top = -Infinity;
    let bottom = Infinity;
    for (let i = 0; i < 240; i++) {
        const v = value((i / 240) * period);
        if (v > top) top = v;
        if (v < bottom) bottom = v;
    }
    const K = 0.5 * (top - bottom);
    const meanErr = points.reduce((s, p) => s + p.err, 0) / n;
    const scatter = meanErr * Math.sqrt(Math.max(1, fit.chi / dof));
    if (K < 2.5 * scatter * Math.sqrt(2 / n)) return null;
    const errK = Math.hypot(2 * scatter * Math.sqrt(2 / n), 0.01 * K, 0.2);
    const errF = (Math.sqrt(6 / n) * scatter) / (Math.PI * span * Math.max(K, 1e-6));
    const errP = Math.hypot(2 * period * period * errF, 0.002 * period);
    const gamma = fit.coef[0] + fit.coef[1] * (0.5 * span) + 0.5 * (top + bottom);
    return { period_days: period, err_period_days: errP, K_kms: K, err_K_kms: errK, gamma_kms: gamma, cycles: span / period };
}

const DAY_S = 86400;

// The mass function, P K^3 / (2 pi G): the least the unseen mass could be, in solar masses, with its uncertainty
export function massFunction(periodDays, errPeriodDays, K_kms, errK_kms) {
    const P = periodDays * DAY_S;
    const K = K_kms * 1000;
    const f = (P * K * K * K) / (2 * Math.PI * G * M_SUN);
    const relative = Math.hypot(errPeriodDays / periodDays, (3 * errK_kms) / K_kms);
    return { f_Msun: f, err_Msun: f * relative };
}

// The smallest unseen mass that fits, when the orbit is seen edge on and the partner has mass m2: M^3 / (M + m2)^2 = f
export function minimumUnseenMass(fMsun, m2Msun) {
    let M = Math.max(fMsun, 0.1) + m2Msun;
    for (let i = 0; i < 40; i++) {
        const g = M * M * M - fMsun * (M + m2Msun) * (M + m2Msun);
        const d = 3 * M * M - 2 * fMsun * (M + m2Msun);
        if (!(Math.abs(d) > 0)) break;
        const next = M - g / d;
        if (!(next > 0)) break;
        if (Math.abs(next - M) < 1e-9 * M) {
            M = next;
            break;
        }
        M = next;
    }
    return M;
}

// A pair whose two sets of lines can both be followed: the shared period and each star's swing give the masses, through
// Kepler's third law. The tilt of the orbit stays unknown, so these are all multiplied by sin^3 i.
export function pairMasses(periodDays, K1_kms, K2_kms) {
    const P = periodDays * DAY_S;
    const sum = (K1_kms + K2_kms) * 1000;
    const total = (P * sum * sum * sum) / (2 * Math.PI * G * M_SUN);
    const separationAU = (sum * P) / (2 * Math.PI * AU);
    return {
        total_Msun: total,
        m1_Msun: (total * K2_kms) / (K1_kms + K2_kms),
        m2_Msun: (total * K1_kms) / (K1_kms + K2_kms),
        ratio: K2_kms / K1_kms,
        separation_AU: separationAU
    };
}

// How far a neighbour can have pulled a line's centre, in observed nm: when another listed line lies inside the dip's width,
// as Na D's pair do at a galaxy's width, what looks like one dip is two and its centre lies between them. 0 if it stands alone.
export function blendAllowance(lines, restNm, fwhmNm, z = 0) {
    if (!lines) return 0;
    const stretch = 1 + z;
    const self = lines.find((l) => !l.band && Math.abs(l.rest_nm - restNm) < 0.005);
    const strength = self ? Math.abs(self.depth ?? 0) : 0;
    let widest = 0;
    lines.forEach((l) => {
        if (l.band || (self && l.type !== self.type)) return;
        const apart = Math.abs(l.rest_nm - restNm) * stretch;
        if (apart < 1e-6 || apart > fwhmNm || Math.abs(l.depth ?? 0) < 0.4 * strength) return;
        widest = Math.max(widest, apart);
    });
    return 0.65 * widest;
}

// Several lines' speeds combined: a weighted mean, and an uncertainty that grows if they disagree with each other.
// Takes [{ z, err_z }].
export function combineDoppler(list) {
    if (!list.length) return null;
    if (list.length === 1) {
        const { z, err_z: errZ } = list[0];
        return { z, err_z: errZ, v_kms: z * C_KMS, err_kms: errZ * C_KMS, disagree: false };
    }
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
    const perLine = chi / (list.length - 1);
    const errZ = Math.sqrt(Math.max(1, perLine) / w);
    return { z, err_z: errZ, v_kms: z * C_KMS, err_kms: errZ * C_KMS, disagree: perLine > 4 };
}
