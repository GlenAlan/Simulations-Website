// The building blocks of the spectrum engine: the wavelength lattice, the Planck function, line and band shapes,
// and the seeded noise. Pure functions on typed arrays, with no DOM or WebGL, so all of it also runs under Node.
//
// Wavelengths are nm throughout. Because the grid is log spaced, one pixel is the same velocity everywhere, which is
// why a line's shape can be worked out once in km/s and looked up for every line of a star.

import { SPECTRUM_LO_NM, SPECTRUM_HI_NM, C_KMS, C_MS, H, K_B, WIEN_B } from '../core/phys.js';
import { hashString } from '../core/rng.js';
import { bandShape, bandRange } from '../data/molecules.js';

export const FWHM_PER_SIGMA = 2.35482;
const LN2 = Math.LN2;

// ---- Wavelength lattice ----

export function gridStep(R) {
    return Math.log(1 + 1 / (2 * R));
}

function latticeSpan(lo, hi, R) {
    const step = gridStep(R);
    const k0 = Math.floor(Math.log(lo / SPECTRUM_LO_NM) / step + 1e-9);
    const k1 = Math.ceil(Math.log(hi / SPECTRUM_LO_NM) / step - 1e-9);
    return { step, k0, n: k1 - k0 + 1 };
}

// Log spaced, two samples per resolution element. Every grid of the same R sits on one lattice anchored at the blue end
// of the range, so a pixel is the same pixel in any view: that is what keeps the noise from changing as a student pans.
export function makeGrid(lo, hi, R) {
    const { step, k0, n } = latticeSpan(lo, hi, R);
    const wl = new Float64Array(n);
    for (let i = 0; i < n; i++) wl[i] = SPECTRUM_LO_NM * Math.exp((k0 + i) * step);
    return wl;
}

const gridCache = new Map();

// The same grid with what the renderers need to go with it. Shared between spectra, so treat wl as read-only.
export function gridFor(lo, hi, R) {
    const key = `${lo}|${hi}|${R}`;
    let grid = gridCache.get(key);
    if (grid) {
        gridCache.delete(key);
        gridCache.set(key, grid);
        return grid;
    }
    const { step, k0, n } = latticeSpan(lo, hi, R);
    const wl = makeGrid(lo, hi, R);
    grid = { wl, n, step, k0, R, lnLo: Math.log(wl[0]), dvPix: C_KMS * step, lo: wl[0], hi: wl[n - 1] };
    gridCache.set(key, grid);
    if (gridCache.size > 12) gridCache.delete(gridCache.keys().next().value);
    return grid;
}

// ---- Planck function ----

const C2_NM_K = ((H * C_MS) / K_B) * 1e9;
const WIEN_NM_K = WIEN_B * 1e9;

// B_lambda in arbitrary units (shared by every object, so ratios between bodies at different temperatures are physical).
// Radius-squared weights turn it into relative flux.
export function bb(lambdaNm, T) {
    const x = C2_NM_K / (lambdaNm * T);
    if (x > 700) return 0;
    const l2 = lambdaNm * lambdaNm;
    return 1e20 / (l2 * l2 * lambdaNm * Math.expm1(x));
}

// What a black body's spectrum is normalised to: its true peak, even below 90 nm so that hot stars slope correctly.
// A body so cold that its peak lies beyond the red end is scaled to the brightest point it does have in range.
export function planckPeak(T) {
    return bb(Math.min(SPECTRUM_HI_NM, WIEN_NM_K / T), T);
}

// The brightest a black body gets inside the range, in the same units
export function planckPeakInRange(T) {
    return bb(Math.min(SPECTRUM_HI_NM, Math.max(SPECTRUM_LO_NM, WIEN_NM_K / T)), T);
}

// ---- Line shapes ----

// A Voigt profile as a pseudo-Voigt with unit peak: near enough for a teaching spectrum, and cheap
function voigtShape(sigma, a) {
    const fG = FWHM_PER_SIGMA * sigma;
    const fL = 2 * a;
    const f = (fG ** 5 + 2.69269 * fG ** 4 * fL + 2.42843 * fG ** 3 * fL ** 2 + 4.47163 * fG ** 2 * fL ** 3
        + 0.07842 * fG * fL ** 4 + fL ** 5) ** 0.2;
    const r = f > 0 ? fL / f : 0;
    const eta = 1.36603 * r - 0.47719 * r * r + 0.11116 * r * r * r;
    const lPeak = 0.63662 / f;
    const gPeak = 0.93944 / f;
    const peak = eta * lPeak + (1 - eta) * gPeak;
    return { f, etaP: (eta * lPeak) / peak, area: 1 / peak };
}

// Half of the rotational broadening kernel (Gray, limb darkening 0.6), sampled every dv: [middle, 1 step out, ...]
function rotationKernel(vsini, dv) {
    if (vsini < dv / 2) return [1];
    const eps = 0.6;
    const m = Math.max(1, Math.ceil(vsini / dv));
    const c1 = (2 * (1 - eps)) / (Math.PI * (1 - eps / 3));
    const c2 = eps / (2 * (1 - eps / 3));
    const half = new Array(m + 1);
    let sum = 0;
    for (let j = 0; j <= m; j++) {
        const x2 = Math.min(1, ((j * dv) / vsini) ** 2);
        half[j] = c1 * Math.sqrt(1 - x2) + c2 * (1 - x2);
        sum += j === 0 ? half[j] : 2 * half[j];
    }
    return half.map((w) => w / sum);
}

// How a line of unit intrinsic depth looks once rotation and the instrument have spread it, as a table in km/s.
// Broadening keeps a line's area, so a fast rotator's lines get wider and shallower, and profile(0) is below 1.
//   sigma: thermal and turbulent Gaussian width (km/s); a: Lorentz half-width from pressure (km/s);
//   vsini: rotation (km/s); R: resolving power of the instrument (0 for none)
export function makeProfile({ sigma = 1, a = 0, vsini = 0, R = 0 }) {
    const sigmaInst = R > 0 ? C_KMS / (FWHM_PER_SIGMA * R) : 0;
    const intrinsic = voigtShape(sigma, a);
    const seen = voigtShape(Math.hypot(sigma, sigmaInst), a);
    const dv = seen.f / 6;
    const kernel = rotationKernel(vsini, dv);
    const m = kernel.length - 1;
    const n = Math.ceil((vsini + 5 * seen.f) / dv) + 1;
    const base = new Float64Array(n + m + 1);
    const scale = intrinsic.area / seen.area;
    for (let k = 0; k < base.length; k++) {
        const u = ((2 * k * dv) / seen.f) ** 2;
        base[k] = scale * ((1 - seen.etaP) * Math.exp(-LN2 * u) + seen.etaP / (1 + u));
    }
    const table = new Float64Array(n + 1);
    for (let k = 0; k <= n; k++) {
        let sum = kernel[0] * base[k];
        for (let j = 1; j <= m; j++) sum += kernel[j] * (base[Math.abs(k - j)] + base[k + j]);
        table[k] = sum;
    }
    const vmax = n * dv;
    return { table, dv, n, vmax, tail: a > 0 ? table[n] * vmax * vmax : 0, peak: table[0] };
}

// How deep a line of unit intrinsic depth comes out at another resolving power: an estimate from its widths, for working out
// which lines a higher resolution would bring out, without drawing them
export function peakAtResolution({ sigma = 1, a = 0, vsini = 0, R = 0 }) {
    const sigmaInst = R > 0 ? C_KMS / (FWHM_PER_SIGMA * R) : 0;
    const intrinsic = voigtShape(sigma, a);
    const seen = voigtShape(Math.hypot(sigma, sigmaInst), a);
    const spread = 1.56 * vsini;
    return (intrinsic.area / seen.area) * (seen.f / Math.hypot(seen.f, spread));
}

export function profileAt(prof, v) {
    const x = v / prof.dv;
    if (x >= prof.n) return prof.tail > 0 ? prof.tail / (v * v) : 0;
    const k = x | 0;
    return prof.table[k] + (prof.table[k + 1] - prof.table[k]) * (x - k);
}

// The speed beyond which a line of this strength changes the spectrum by less than eps
function profileReach(prof, strength, eps) {
    const t = prof.table;
    if (strength * t[0] <= eps) return 0;
    if (strength * t[prof.n] > eps) {
        return prof.tail > 0 ? Math.sqrt((strength * prof.tail) / eps) : prof.vmax;
    }
    let lo = 0;
    let hi = prof.n;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (strength * t[mid] > eps) lo = mid; else hi = mid;
    }
    return hi * prof.dv;
}

const LINE_EPS = 7e-4;

// Multiplies one absorption line into A, touching only the pixels it reaches
export function mulLine(A, grid, obsNm, depth, prof) {
    const reach = profileReach(prof, depth, LINE_EPS);
    if (reach <= 0) return;
    const centre = (Math.log(obsNm) - grid.lnLo) / grid.step;
    const half = reach / grid.dvPix;
    const lo = Math.max(0, Math.ceil(centre - half));
    const hi = Math.min(grid.n - 1, Math.floor(centre + half));
    for (let i = lo; i <= hi; i++) {
        A[i] *= 1 - depth * profileAt(prof, Math.abs(i - centre) * grid.dvPix);
    }
}

// Adds one emission line into F (amp is the height a line of unit-peak profile would have)
export function addLine(F, grid, obsNm, amp, prof) {
    const reach = profileReach(prof, amp, LINE_EPS * 0.2);
    if (reach <= 0) return;
    const centre = (Math.log(obsNm) - grid.lnLo) / grid.step;
    const half = reach / grid.dvPix;
    const lo = Math.max(0, Math.ceil(centre - half));
    const hi = Math.min(grid.n - 1, Math.floor(centre + half));
    for (let i = lo; i <= hi; i++) {
        F[i] += amp * profileAt(prof, Math.abs(i - centre) * grid.dvPix);
    }
}

// ---- Molecular bands ----

// bandShape and bandRange are the molecules' own, so that plots and spectra agree on what each shape means.

// Calls back with each pixel index and rest wavelength a band reaches. `factor` is 1 + z for the object carrying it.
function eachBandPixel(grid, band, factor, fn) {
    const [a, b] = bandRange(band);
    const lo = Math.max(0, Math.ceil((Math.log(a * factor) - grid.lnLo) / grid.step));
    const hi = Math.min(grid.n - 1, Math.floor((Math.log(b * factor) - grid.lnLo) / grid.step));
    for (let i = lo; i <= hi; i++) fn(i, grid.wl[i] / factor);
}

export function mulBand(A, grid, band, strength, factor = 1) {
    if (strength <= 0) return;
    const d = Math.min(0.98, strength * (band.d ?? 1));
    eachBandPixel(grid, band, factor, (i, lam) => {
        A[i] *= 1 - d * bandShape(band, lam);
    });
}

export function addBand(F, grid, band, amp, factor = 1) {
    eachBandPixel(grid, band, factor, (i, lam) => {
        F[i] += amp * bandShape(band, lam);
    });
}

// ---- Noise ----

function mix32(h) {
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
}

// A unit Gaussian decided only by the seed and the bin, so it can be read in any order, from any view
export function gaussAt(seed, bin) {
    const h1 = mix32((seed + Math.imul(bin, 0x9e3779b1)) | 0);
    const h2 = mix32((h1 + 0x6d2b79f5) | 0);
    return Math.sqrt(-2 * Math.log((h1 + 1) / 4294967297)) * Math.cos((2 * Math.PI * h2) / 4294967296);
}

// A bright star gives several hundred, a faint quasar about 10. S/N goes as the square root of the flux.
const SNR_PER_ROOT_FLUX = 6.3e7;
export const SNR_MIN = 6;
export const SNR_MAX = 800;
export const MAG0_FLUX_WM2 = 2.5e-8;

export function snrFromFlux(fluxWm2) {
    return Math.min(SNR_MAX, Math.max(SNR_MIN, SNR_PER_ROOT_FLUX * Math.sqrt(Math.max(0, fluxWm2))));
}

// The flux the noise is worked out from. A few kinds of body only know their apparent magnitude, so whichever is the
// larger is taken as the measured one.
export function effectiveFlux(brightness) {
    if (!brightness) return 0;
    const f = brightness.flux_Wm2 || 0;
    const m = brightness.mag;
    return m !== undefined && m < 90 ? Math.max(f, MAG0_FLUX_WM2 * 10 ** (-0.4 * m)) : f;
}

// S/N applies at the brightest continuum point inside the range (flux fRef) and falls as the square root of the flux,
// down to a small floor so that a band with no light in it reads as noise around nothing.
export function noisy(clean, grid, code, snr, fRef = 1) {
    const out = new Float32Array(grid.n);
    const seed = hashString(`${code}:${grid.R}`);
    const floor2 = (0.01 * fRef) ** 2;
    for (let i = 0; i < grid.n; i++) {
        const f = clean[i];
        const sd = Math.sqrt(Math.max(0, f) * fRef + floor2) / snr;
        const v = f + sd * gaussAt(seed, grid.k0 + i);
        out[i] = v > 0 ? v : 0;
    }
    return out;
}
