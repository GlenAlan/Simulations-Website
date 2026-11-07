// The spectrum engine's front door (spec 8, 10.2, 12). Pure functions on typed arrays, with no DOM or WebGL.
//
// spectrumOf(entity, opts) returns a Spectrum:
//   { wl: Float64Array (nm, log spaced), flux: Float32Array, clean: Float32Array (the same without noise),
//     continuum: Float32Array (without noise or lines),
//     lines: [{ rest_nm, obs_nm, species, label, depth, type: 'abs'|'em', band?, width_nm?, code?, source? }],
//     snr, mode: 'absorption'|'emission'|'reflection'|'thermal'|'none', note }
// opts: { lo_nm, hi_nm, R, t (days), noise (default true), parts (component codes to keep), subtractHost }
//
// Flux is F_lambda, scaled so the continuum's peak is 1: its true peak, even below 90 nm, so a hot star slopes correctly.
// An emission object has next to no continuum, so there its strongest line reaches 1 at overview resolution.
// lines only holds what can be seen: a line lost in the noise isn't listed. Spectra are cached, so treat them as read-only.
//
// autoRange(entity)          -> { lo_nm, hi_nm }: the range a spectrum opens on
// referenceSpectrum(id, opts) -> a Spectrum with no noise. opts: { lo_nm, hi_nm, R, T (for 'bb'), v_kms (shifts it) }
// photometer(entity)         -> { flux_Wm2, err_Wm2, distance_pc, distance_ly }: a measured brightness, stable per object
// timeVarying(entity)        -> null, or { kind, period_days | duration_days, ... } for the panel's playback
// lightCurve(entity, opts)   -> for a supernova: { t_days, mag, rel_flux, peak_mag, t_peak_days, t_first_light_days }

import { SPECTRUM_LO_NM, SPECTRUM_HI_NM, R_OVERVIEW, LY_PER_PC, wienPeakNm } from '../core/phys.js';
import { hashString } from '../core/rng.js';
import { makeGrid as latticeGrid, gridFor, noisy, gaussAt, bb, planckPeak, planckPeakInRange, snrFromFlux, effectiveFlux, MAG0_FLUX_WM2, SNR_MIN } from './kernel.js';
import { starSpectrum, starPartsOf, parentOf, fluxOf } from './stellar.js';
import { planetSpectrum, roguePlanetSpectrum } from './planet.js';
import { nebulaSpectrum, cometSpectrum } from './nebular.js';
import { supernovaSpectrum, supernovaLightCurve, supernovaMag, SUPERNOVA_SPAN_DAYS } from './supernova.js';
import { galaxySpectrum, quasarSpectrum, redshiftOf } from './extragalactic.js';
import { buildReference } from './reference.js';

export const makeGrid = latticeGrid;

const cache = new Map();
const CACHE_SIZE = 32;

function remember(key, value) {
    cache.set(key, value);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return value;
}

function recall(key) {
    const hit = cache.get(key);
    if (hit) {
        cache.delete(key);
        cache.set(key, hit);
    }
    return hit;
}

function rangeOf(opts) {
    const lo = Math.max(SPECTRUM_LO_NM, opts.lo_nm ?? SPECTRUM_LO_NM);
    const hi = Math.min(SPECTRUM_HI_NM, opts.hi_nm ?? SPECTRUM_HI_NM);
    return gridFor(lo, Math.max(lo * 1.0001, hi), opts.R ?? R_OVERVIEW);
}

function thermalBody(T, grid, snr, note) {
    const peak = planckPeak(T);
    const flux = new Float64Array(grid.n);
    for (let i = 0; i < grid.n; i++) flux[i] = bb(grid.wl[i], T) / peak;
    return { flux, continuum: flux, lines: [], fRef: planckPeakInRange(T) / peak, snr, mode: 'thermal', note };
}

function buildSpectrum(entity, grid, opts) {
    const o = { ...opts };
    switch (entity.kind) {
    case 'planet': {
        const host = parentOf(entity, opts);
        return planetSpectrum(entity, grid, o, host || undefined, null);
    }
    case 'home_planet':
        return planetSpectrum(entity.planet, grid, o, undefined, entity);
    case 'rogue_planet':
        return roguePlanetSpectrum(entity, grid);
    case 'comet':
        return cometSpectrum(entity, grid);
    case 'nebula':
        return nebulaSpectrum(entity, grid);
    case 'supernova':
        return supernovaSpectrum(entity, grid, o);
    case 'galaxy':
        return galaxySpectrum(entity, grid);
    case 'quasar':
        return quasarSpectrum(entity, grid);
    case 'neutron_star':
        return thermalBody(entity.neutron_star.teff_K ?? 1e6, grid, SNR_MIN + 2,
            'This object is far too faint to show any lines: only a very faint, hot thermal glow, rising towards the ultraviolet. Neutron stars are better found in radio and X-rays.');
    default: {
        const made = starSpectrum(entity, grid, o);
        return made || thermalBody(6000, grid, SNR_MIN, 'This object has no measurable spectrum of its own.');
    }
    }
}

// How deep a line has to be for a student to see it through the noise at its own wavelength
function visibleLines(spec, clean, grid, noise) {
    const shown = [];
    const { snr, fRef } = spec;
    for (const line of spec.lines) {
        let needed = 0.02;
        if (noise && Number.isFinite(snr)) {
            const i = Math.max(0, Math.min(grid.n - 1, Math.round((Math.log(line.obs_nm) - grid.lnLo) / grid.step)));
            const level = Math.max(1e-12, spec.continuum[i] > 0 ? spec.continuum[i] : clean[i]);
            if (line.type === 'em') {
                needed = (2.5 * Math.sqrt(level * fRef)) / snr;
            } else {
                needed = Math.max(0.02, 2.5 / (snr * Math.sqrt(level / Math.max(1e-30, fRef))));
            }
        }
        if (line.depth >= needed) shown.push(line);
    }
    shown.sort((a, b) => a.obs_nm - b.obs_nm);
    return shown;
}

function finish(spec, grid, code, noise) {
    const clean = Float32Array.from(spec.flux);
    const flux = noise && Number.isFinite(spec.snr) ? noisy(spec.flux, grid, code, spec.snr, spec.fRef) : clean;
    return {
        wl: grid.wl,
        flux,
        clean,
        continuum: spec.continuum === spec.flux ? clean : Float32Array.from(spec.continuum),
        lines: visibleLines(spec, spec.flux, grid, noise),
        snr: spec.snr,
        mode: spec.mode,
        note: spec.note || ''
    };
}

export function spectrumOf(entity, opts = {}) {
    const noise = opts.noise !== false;
    const grid = rangeOf(opts);
    const code = entity.code || 'unknown';
    const parts = opts.parts && opts.parts.length ? [...opts.parts].sort().join(',') : '';
    const key = `${code}|${grid.lo}|${grid.hi}|${grid.R}|${opts.t ?? 0}|${noise}|${parts}|${opts.subtractHost ? 1 : 0}`;
    const hit = recall(key);
    if (hit) return hit;
    return remember(key, finish(buildSpectrum(entity, grid, opts), grid, code, noise));
}

export function referenceSpectrum(refId, opts = {}) {
    const grid = rangeOf(opts);
    const key = `ref:${refId}|${grid.lo}|${grid.hi}|${grid.R}|${opts.T ?? ''}|${opts.v_kms ?? 0}`;
    const hit = recall(key);
    if (hit) return hit;
    return remember(key, finish(buildReference(refId, grid, opts), grid, refId, false));
}

// ---- The range a spectrum opens on ----

function clampRange(lo, hi) {
    return { lo_nm: Math.max(SPECTRUM_LO_NM, lo), hi_nm: Math.min(SPECTRUM_HI_NM, hi) };
}

const VISIBLE = { lo_nm: 380, hi_nm: 750 };

function rangeForTemperature(T) {
    const peak = wienPeakNm(T);
    if (peak < 380) return clampRange(peak * 0.65, 750);
    if (peak > 750) return clampRange(380, peak * 1.6);
    return { ...VISIBLE };
}

export function autoRange(entity) {
    switch (entity.kind) {
    case 'planet':
    case 'home_planet':
        return { lo_nm: 350, hi_nm: 5000 };
    case 'rogue_planet':
        return { lo_nm: 1000, hi_nm: 5000 };
    case 'comet':
    case 'nebula':
        return { lo_nm: 350, hi_nm: 720 };
    case 'neutron_star':
        return { lo_nm: 90, hi_nm: 750 };
    case 'supernova':
        return { lo_nm: 300, hi_nm: 950 };
    case 'galaxy': {
        const stretch = 1 + redshiftOf(entity);
        return clampRange(370 * stretch, 700 * stretch);
    }
    case 'quasar': {
        const stretch = 1 + redshiftOf(entity);
        return clampRange(105 * stretch, 700 * stretch);
    }
    default: {
        const parts = starPartsOf(entity, {});
        if (!parts.length) return { ...VISIBLE };
        let brightest = parts[0];
        parts.forEach((part) => {
            if ((part.star.luminosity_Lsun ?? 0) > (brightest.star.luminosity_Lsun ?? 0)) brightest = part;
        });
        return rangeForTemperature(brightest.star.teff_K);
    }
    }
}

// ---- Photometer ----

function trueFlux(entity, opts) {
    if (entity.kind === 'supernova') {
        const phase = (entity.supernova.phase0_days ?? 0) + (opts.t ?? 0);
        const mag = supernovaMag(entity, phase);
        return Number.isFinite(mag) ? MAG0_FLUX_WM2 * 10 ** (-0.4 * mag) : 0;
    }
    if (entity.kind === 'home_planet') return effectiveFlux(entity.brightness);
    if (entity.kind === 'planet' && !entity.brightness) {
        // Starlight caught by the planet and sent back: only what's reflected is worth a reading at this distance
        const host = parentOf(entity, opts);
        const earthRadiusAU = 4.26e-5;
        const hostFlux = host ? fluxOf(host, opts) : 0;
        return hostFlux * (entity.albedo ?? 0.3) * (((entity.radius_Rearth ?? 1) * earthRadiusAU) / (entity.orbit_AU || 1)) ** 2;
    }
    if (entity.brightness && entity.brightness.flux_Wm2 !== undefined) return entity.brightness.flux_Wm2;
    return fluxOf(entity, opts);
}

// The measured brightness b and the distance, so a student can work out L = 4 pi d^2 b. A reading carries a small, stable
// error: fainter objects are harder to measure, up to 8%.
export function photometer(entity, opts = {}) {
    const parent = parentOf(entity, opts);
    const distance_pc = entity.distance_pc ?? parent?.distance_pc ?? null;
    const flux = trueFlux(entity, opts);
    const fraction = Math.min(0.08, Math.max(0.01, 0.5 / snrFromFlux(flux)));
    const seed = hashString(`${entity.code}:photometer`);
    const measured = flux * (1 + fraction * Math.max(-2.5, Math.min(2.5, gaussAt(seed, 0))));
    return {
        flux_Wm2: measured,
        err_Wm2: flux * fraction,
        distance_pc,
        distance_ly: distance_pc === null ? null : distance_pc * LY_PER_PC
    };
}

// ---- Time-varying objects ----

const DAYS_PER_YEAR = 365.25;

function systemTiming(body) {
    if (body.black_hole) {
        return { kind: 'black_hole', period_days: body.black_hole.period_days };
    }
    const orbits = body.orbits || [];
    const periods = orbits.map((o) => o.period_days).filter((p) => p > 0).sort((a, b) => a - b);
    const shortest = periods[0];
    switch (body.architecture) {
    case 'figure_eight':
        return { kind: 'figure_eight', period_days: shortest ?? body.period_days ?? DAYS_PER_YEAR };
    case 'double_double':
        return { kind: 'double_double', period_days: shortest ?? 3.5, periods_days: periods };
    case 'hierarchical_triple':
        return { kind: 'hierarchical_triple', period_days: shortest, periods_days: periods };
    default:
        return shortest ? { kind: 'binary', period_days: shortest, periods_days: periods } : null;
    }
}

export function timeVarying(entity, opts = {}) {
    if (entity.kind === 'supernova') {
        const phase0 = entity.supernova.phase0_days ?? 0;
        return { kind: 'supernova', duration_days: SUPERNOVA_SPAN_DAYS - phase0, phase0_days: phase0 };
    }
    if (entity.kind === 'neutron_star') {
        const period = entity.neutron_star.pulse_period_s;
        return entity.neutron_star.pulsar && period ? { kind: 'pulsar', period_s: period, period_days: period / 86400 } : null;
    }
    if (entity.stars || entity.black_hole) return systemTiming(entity);
    if (entity.kind === 'star_component' || entity.parent) {
        const parent = parentOf(entity, opts);
        if (parent && (parent.stars || parent.black_hole)) return systemTiming(parent);
    }
    return null;
}

export function lightCurve(entity, opts = {}) {
    if (entity.kind !== 'supernova') return null;
    return supernovaLightCurve(entity, opts);
}
