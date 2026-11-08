// Supernovae evolve over days: a hot, ultraviolet-rich continuum that cools; broad P Cygni lines from fast ejecta; then a
// nebular phase where the continuum has faded and broad emission is all that's left.
//
// Time is measured as the phase, in days from peak brightness: phase = phase0_days + t. Its brightness is the band table's
// visible light, the same curve the sky draws, so that the sky, the panel and the spectra agree.

import { C_KMS, SPECTRUM_LO_NM, SPECTRUM_HI_NM } from '../core/phys.js';
import { DIAGNOSTIC_LINES } from '../data/lines.js';
import { supernovaBandsAt } from '../data/band_table.js';
import { MAG0_FLUX_WM2, bb, planckPeak, makeProfile, mulLine, addLine, snrFromFlux } from './kernel.js';

// Piecewise-linear in the first column
function curve(table, x) {
    if (x <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
        if (x <= table[i][0]) {
            const [x0, y0] = table[i - 1];
            const [x1, y1] = table[i];
            return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
        }
    }
    return table[table.length - 1][1];
}

const FEATURE_PHASES = [-12, 0, 15, 40, 90];
const at = (list, phase) => curve(FEATURE_PHASES.map((p, i) => [p, list[i]]), phase);

// The speed that puts a Type Ia's silicon pair at its famous 615 nm at peak brightness
const SI_II_PEAK_SPEED = -DIAGNOSTIC_LINES.SNIa.find((line) => line.species === 'Si II').shift_kms;

const FIRST_LIGHT = -18;

const TYPES = {
    Ia: {
        temperature: [[-18, 14000], [-10, 12500], [0, 10000], [10, 8000], [20, 6500], [40, 5500], [80, 5000], [200, 4500]],
        speed: [[-18, 1.55], [-10, 1.26], [0, 1], [15, 0.93], [40, 0.84], [100, 0.74]].map(([p, x]) => [p, x * SI_II_PEAK_SPEED]),
        width: 2600,
        continuum: [[40, 1], [70, 0.45], [100, 0.15], [200, 0.03]],
        nebular: [[30, 0], [70, 0.55], [120, 1]],
        ultraviolet: { below: 340, keep: 0.25 },
        // [rest nm, label, species, depths through the phases, P Cygni emission through the phases]
        features: [
            [634.711, 'Si II', 'Si II', [0.34, 0.42, 0.3, 0.1, 0.01], [0.06, 0.08, 0.06, 0.02, 0]],
            [637.137, 'Si II', 'Si II', [0.28, 0.34, 0.24, 0.08, 0.01], [0.06, 0.08, 0.06, 0.02, 0]],
            [412.805, 'Si II 412.8', 'Si II', [0.25, 0.3, 0.15, 0, 0], [0, 0, 0, 0, 0]],
            [545.4, 'S II', 'S II', [0.16, 0.2, 0.07, 0, 0], [0, 0, 0, 0, 0]],
            [564.0, 'S II', 'S II', [0.16, 0.2, 0.07, 0, 0], [0, 0, 0, 0, 0]],
            [393.366, 'Ca II K', 'Ca II', [0.45, 0.45, 0.45, 0.45, 0.25], [0, 0, 0.05, 0.1, 0.1]],
            [396.847, 'Ca II H', 'Ca II', [0.35, 0.35, 0.35, 0.35, 0.2], [0, 0, 0, 0, 0]],
            [854.209, 'Ca II 854.2', 'Ca II', [0.3, 0.3, 0.45, 0.6, 0.45], [0.05, 0.05, 0.15, 0.3, 0.3]],
            [866.214, 'Ca II 866.2', 'Ca II', [0.2, 0.2, 0.3, 0.4, 0.3], [0, 0, 0.1, 0.15, 0.15]],
            [448.113, 'Mg II 448.1', 'Mg II', [0.25, 0.3, 0.35, 0.2, 0.05], [0, 0, 0, 0, 0]],
            [492.392, 'Fe II 492.4', 'Fe II', [0.1, 0.18, 0.3, 0.4, 0.25], [0, 0.04, 0.1, 0.15, 0.1]],
            [516.903, 'Fe II 516.9', 'Fe II', [0.1, 0.18, 0.3, 0.4, 0.25], [0, 0.04, 0.1, 0.15, 0.1]],
            [777.417, 'O I 777.4', 'O I', [0.2, 0.2, 0.2, 0.1, 0], [0, 0, 0, 0, 0]]
        ],
        emission: [
            [465.8, '[Fe III]', 'Fe III', 1, 3200], [515.9, '[Fe II]', 'Fe II', 0.8, 3200], [589.3, '[Co III]', 'Co III', 0.35, 3000],
            [715.5, '[Fe II]', 'Fe II', 0.35, 3000], [737.8, '[Ni II]', 'Ni II', 0.28, 3000], [864.0, '[Fe II]', 'Fe II', 0.18, 3000]
        ]
    },
    II: {
        temperature: [[-18, 36000], [-10, 30000], [-5, 22000], [0, 15000], [7, 10000], [15, 8000], [30, 6200], [60, 5400], [100, 5200], [200, 4500]],
        speed: [[-18, 17000], [-10, 15000], [0, 11000], [15, 8000], [30, 6000], [60, 4000], [100, 3000]],
        width: 1800,
        continuum: [[100, 1], [125, 0.3], [200, 0.05]],
        nebular: [[90, 0], [125, 0.7], [170, 1]],
        ultraviolet: null,
        features: [
            [656.282, 'Hα', 'H I', [0.15, 0.25, 0.4, 0.45, 0.4], [0.5, 1.1, 1.9, 2.1, 2.4]],
            [486.133, 'Hβ', 'H I', [0.15, 0.25, 0.4, 0.45, 0.4], [0.2, 0.4, 0.7, 0.7, 0.7]],
            [434.047, 'Hγ', 'H I', [0.12, 0.2, 0.3, 0.35, 0.3], [0.1, 0.2, 0.3, 0.3, 0.3]],
            [410.174, 'Hδ', 'H I', [0.1, 0.15, 0.25, 0.25, 0.2], [0.05, 0.1, 0.15, 0.15, 0.15]],
            [587.562, 'He I 587.6', 'He I', [0.2, 0.2, 0.05, 0, 0], [0.2, 0.2, 0.05, 0, 0]],
            [589.3, 'Na D', 'Na I', [0, 0, 0.1, 0.35, 0.5], [0, 0, 0.1, 0.3, 0.4]],
            [492.392, 'Fe II 492.4', 'Fe II', [0, 0, 0.1, 0.3, 0.35], [0, 0, 0.02, 0.08, 0.1]],
            [501.844, 'Fe II 501.8', 'Fe II', [0, 0, 0.1, 0.3, 0.35], [0, 0, 0.02, 0.08, 0.1]],
            [516.903, 'Fe II 516.9', 'Fe II', [0, 0, 0.1, 0.3, 0.35], [0, 0, 0.02, 0.08, 0.1]],
            [393.366, 'Ca II K', 'Ca II', [0, 0.1, 0.35, 0.55, 0.55], [0, 0, 0.05, 0.1, 0.1]],
            [396.847, 'Ca II H', 'Ca II', [0, 0.08, 0.28, 0.45, 0.45], [0, 0, 0, 0, 0]],
            [854.209, 'Ca II 854.2', 'Ca II', [0, 0, 0.2, 0.5, 0.6], [0, 0, 0.3, 0.6, 0.8]]
        ],
        emission: [
            [656.282, 'Hα', 'H I', 1, 1500], [630.03, '[O I] 630.0', 'O I', 0.35, 1500], [636.378, '[O I] 636.4', 'O I', 0.12, 1500],
            [729.15, '[Ca II] 729.1', 'Ca II', 0.35, 1400], [732.39, '[Ca II] 732.4', 'Ca II', 0.2, 1400], [854.209, 'Ca II 854.2', 'Ca II', 0.25, 1500],
            [589.3, 'Na D', 'Na I', 0.12, 1500], [486.133, 'Hβ', 'H I', 0.12, 1500], [715.5, '[Fe II]', 'Fe II', 0.1, 1200]
        ]
    }
};

function typeOf(body) {
    return body.supernova.type === 'Ia' ? TYPES.Ia : TYPES.II;
}

const phaseOf = (body, t) => (body.supernova.phase0_days ?? 0) + t;

// Days from peak when the explosion is first seen; before then a type II's star is still there, a type Ia's is not
export const SUPERNOVA_FIRST_LIGHT = FIRST_LIGHT;
// How long the Light curve tool plays before first light, to show what was there
const BEFORE_DAYS = 8;

// Whether its expanding shell can be seen at all, so that the sky draws it and the Light curve speaks of it. One in another
// galaxy (host_code) can't be: its remnant is far smaller than the finest zoom shows, so it stays a point that brightens
// and fades. Nor can any shell under SHELL_SEEN_DEG across.
const SHELL_SEEN_DEG = 0.005;
export function supernovaShellShows(sn) {
    return !sn.host_code && (sn.shell_deg ?? 0) >= SHELL_SEEN_DEG;
}

// The explosion's own visible light at a phase, 1 at peak: the curve the Light curve draws
export function supernovaLight(sn, phase) {
    return phase < FIRST_LIGHT ? 0 : explosionLight(sn, phase);
}

// The colour temperature of its light at a phase (days from peak): the same as its spectrum's continuum
export function supernovaTemperature(sn, phase) {
    return curve((sn.type === 'Ia' ? TYPES.Ia : TYPES.II).temperature, Math.max(phase, FIRST_LIGHT));
}

// Where a supernova is in its story at time t, for a picture of it: { phase, exploded, days (since first light), T, light,
// continuum, nebular, speed, outerSpeed }. light is the explosion's own visible light, 1 at peak; continuum how much of the
// spectrum is still a hot photosphere's, nebular how much is the thinning gas's emission lines (both as the spectrum has
// them); speed the photosphere's speed (km/s, the absorption lines'), outerSpeed the fastest gas's.
export function supernovaStage(body, t) {
    const type = typeOf(body);
    const phase = phaseOf(body, t);
    const out = { phase, exploded: phase >= FIRST_LIGHT, days: phase - FIRST_LIGHT, outerSpeed: type.speed[0][1] };
    if (!out.exploded) return out;
    const contWeight = curve(type.continuum, phase);
    const nebWeight = curve(type.nebular, phase);
    out.T = curve(type.temperature, phase);
    out.light = explosionLight(body.supernova, phase);
    out.continuum = contWeight;
    out.nebular = nebWeight;
    out.speed = curve(type.speed, phase);
    return out;
}

// Apparent magnitude at time t, or Infinity before the explosion
export function supernovaMag(body, t) {
    const phase = phaseOf(body, t);
    if (phase < FIRST_LIGHT) return Infinity;
    return body.supernova.peak_mag - 2.5 * Math.log10(Math.max(1e-6, explosionLight(body.supernova, phase)));
}

// The band table's visible light, 1 at peak. Later on that rises again as the sky draws the spreading filaments of the
// remnant, but those aren't the explosion's own light, so after peak this curve only ever falls.
function explosionLight(sn, phase) {
    let light = supernovaBandsAt(sn, phase).visible;
    for (let p = 0; p < phase; p += 10) light = Math.min(light, supernovaBandsAt(sn, p).visible);
    return light;
}

export function supernovaSpectrum(body, grid, opts) {
    const type = typeOf(body);
    const phase = phaseOf(body, opts.t ?? 0);
    const factor = 1 + (body.radial_velocity_kms ?? 0) / C_KMS;
    const { wl, n } = grid;

    if (phase < FIRST_LIGHT) {
        return {
            flux: new Float64Array(n),
            continuum: new Float64Array(n),
            lines: [],
            fRef: 1,
            snr: 6,
            mode: 'none',
            note: 'Nothing here yet: this star has not exploded at this time.'
        };
    }

    const T = curve(type.temperature, phase);
    const speed = curve(type.speed, phase);
    const contWeight = curve(type.continuum, phase);
    const nebWeight = curve(type.nebular, phase);
    const peak = Math.max(contWeight, nebWeight);

    const continuum = new Float64Array(n);
    const planckNorm = planckPeak(T);
    for (let i = 0; i < n; i++) continuum[i] = ((contWeight / peak) * bb(wl[i] / factor, T)) / planckNorm;

    // Absorption and P Cygni emission, both as multiples of the local continuum
    const A = new Float64Array(n).fill(1);
    const E = new Float64Array(n);
    const lines = [];
    const shape = makeProfile({ sigma: type.width, R: grid.R });
    type.features.forEach(([rest, label, species, depths, emits]) => {
        const depth = at(depths, phase);
        const emit = at(emits, phase);
        const trough = rest * (1 - speed / C_KMS) * factor;
        const atRest = rest * factor;
        if (depth > 0) {
            mulLine(A, grid, trough, depth, shape);
            // An absorption dip needs a continuum to absorb, so it fades from view as the continuum does
            if (trough >= grid.lo && trough <= grid.hi) {
                lines.push({ rest_nm: rest, obs_nm: trough, species, label, depth: depth * shape.peak * (contWeight / peak), type: 'abs' });
            }
        }
        if (emit > 0) {
            addLine(E, grid, atRest, emit, shape);
            if (atRest >= grid.lo && atRest <= grid.hi && emit > 0.3) {
                lines.push({ rest_nm: rest, obs_nm: atRest, species, label, depth: emit * shape.peak * continuum[Math.round((Math.log(atRest) - grid.lnLo) / grid.step)], type: 'em' });
            }
        }
    });

    const flux = new Float64Array(n);
    const ultraviolet = type.ultraviolet;
    for (let i = 0; i < n; i++) {
        let f = continuum[i] * (A[i] + E[i]);
        // Iron-group lines blanket a Type Ia's ultraviolet
        if (ultraviolet) f *= ultraviolet.keep + (1 - ultraviolet.keep) / (1 + Math.exp((ultraviolet.below - wl[i] / factor) / 22));
        flux[i] = f;
    }

    if (nebWeight > 0) {
        const amp = nebWeight / peak;
        type.emission.forEach(([rest, label, species, rel, sigma]) => {
            const prof = makeProfile({ sigma, R: grid.R });
            const obs = rest * factor;
            addLine(flux, grid, obs, amp * rel, prof);
            if (obs >= grid.lo && obs <= grid.hi && amp * rel > 0.03) {
                lines.push({ rest_nm: rest, obs_nm: obs, species, label, depth: amp * rel * prof.peak, type: 'em' });
            }
        });
    }

    // Keep the plot's scale steady as the spectrum evolves: the brightest continuum point in range is the reference
    const cooled = Math.min(SPECTRUM_HI_NM, Math.max(SPECTRUM_LO_NM, 2.898e6 / T));
    const fRef = Math.max(nebWeight / peak, ((contWeight / peak) * bb(cooled, T)) / planckNorm);

    const mag = supernovaMag(body, opts.t ?? 0);
    const days = Math.round(phase);
    const when = days < 0 ? `${-days} days before peak brightness` : days === 0 ? 'at peak brightness' : `${days} days after peak brightness`;
    const nebular = nebWeight >= contWeight;
    return {
        flux,
        continuum,
        lines,
        fRef,
        snr: snrFromFlux(MAG0_FLUX_WM2 * 10 ** (-0.4 * mag)),
        mode: nebular ? 'emission' : 'absorption',
        note: nebular
            ? `This is ${when}. The gas has thinned out, so you now see broad emission instead of a continuum with absorption.`
            : `This is ${when}. The broad, blueshifted dips come from gas thrown out at about ${Math.round(speed / 100) * 100} km/s.`
    };
}

// The light curve across a span of times, in the same t that the spectrum takes
export function supernovaLightCurve(body, opts = {}) {
    const phase0 = body.supernova.phase0_days ?? 0;
    // From a little before first light, so that what was there before can be seen
    const from = opts.from_days ?? Math.min(0, FIRST_LIGHT - BEFORE_DAYS - phase0);
    const to = opts.to_days ?? Math.max(from + 60, SUPERNOVA_SPAN_DAYS - phase0);
    const n = opts.samples ?? 260;
    const t_days = new Float64Array(n);
    const mag = new Float64Array(n);
    const rel_flux = new Float64Array(n);
    const peakMag = body.supernova.peak_mag;
    for (let i = 0; i < n; i++) {
        const t = from + ((to - from) * i) / (n - 1);
        const m = supernovaMag(body, t);
        t_days[i] = t;
        mag[i] = m;
        rel_flux[i] = Number.isFinite(m) ? 10 ** (-0.4 * (m - peakMag)) : 0;
    }
    return { t_days, mag, rel_flux, peak_mag: peakMag, t_peak_days: -phase0, t_first_light_days: FIRST_LIGHT - phase0 };
}

export const SUPERNOVA_SPAN_DAYS = 500;
