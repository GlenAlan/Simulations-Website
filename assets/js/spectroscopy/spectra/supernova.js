// Supernovae evolve over days: a hot, ultraviolet-rich continuum that cools; broad P Cygni lines from fast ejecta; then a
// nebular phase where the continuum has faded and broad emission is all that's left.
//
// Time is measured as the phase, in days from peak brightness: phase = phase0_days + t.

import { C_KMS, SPECTRUM_LO_NM, SPECTRUM_HI_NM } from '../core/phys.js';
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

const TYPES = {
    Ia: {
        firstLight: -18,
        temperature: [[-18, 14000], [-10, 12500], [0, 10000], [10, 8000], [20, 6500], [40, 5500], [80, 5000], [200, 4500]],
        speed: [[-18, 17000], [-10, 14000], [0, 11000], [15, 9500], [40, 8000], [100, 7000]],
        width: 2600,
        continuum: [[40, 1], [70, 0.45], [100, 0.15], [200, 0.03]],
        nebular: [[30, 0], [70, 0.55], [120, 1]],
        ultraviolet: { below: 340, keep: 0.25 },
        // [rest nm, label, species, depths through the phases, P Cygni emission through the phases]
        features: [
            [634.7, 'Si II', 'Si II', [0.34, 0.42, 0.3, 0.1, 0.01], [0.06, 0.08, 0.06, 0.02, 0]],
            [637.1, 'Si II', 'Si II', [0.28, 0.34, 0.24, 0.08, 0.01], [0.06, 0.08, 0.06, 0.02, 0]],
            [412.8, 'Si II', 'Si II', [0.25, 0.3, 0.15, 0, 0], [0, 0, 0, 0, 0]],
            [545.4, 'S II', 'S II', [0.16, 0.2, 0.07, 0, 0], [0, 0, 0, 0, 0]],
            [564.0, 'S II', 'S II', [0.16, 0.2, 0.07, 0, 0], [0, 0, 0, 0, 0]],
            [393.37, 'Ca II K', 'Ca II', [0.45, 0.45, 0.45, 0.45, 0.25], [0, 0, 0.05, 0.1, 0.1]],
            [396.85, 'Ca II H', 'Ca II', [0.35, 0.35, 0.35, 0.35, 0.2], [0, 0, 0, 0, 0]],
            [854.21, 'Ca II', 'Ca II', [0.3, 0.3, 0.45, 0.6, 0.45], [0.05, 0.05, 0.15, 0.3, 0.3]],
            [866.21, 'Ca II', 'Ca II', [0.2, 0.2, 0.3, 0.4, 0.3], [0, 0, 0.1, 0.15, 0.15]],
            [448.11, 'Mg II', 'Mg II', [0.25, 0.3, 0.35, 0.2, 0.05], [0, 0, 0, 0, 0]],
            [492.39, 'Fe II', 'Fe II', [0.1, 0.18, 0.3, 0.4, 0.25], [0, 0.04, 0.1, 0.15, 0.1]],
            [516.9, 'Fe II', 'Fe II', [0.1, 0.18, 0.3, 0.4, 0.25], [0, 0.04, 0.1, 0.15, 0.1]],
            [777.4, 'O I', 'O I', [0.2, 0.2, 0.2, 0.1, 0], [0, 0, 0, 0, 0]]
        ],
        emission: [
            [465.8, '[Fe III]', 'Fe III', 1, 3200], [515.9, '[Fe II]', 'Fe II', 0.8, 3200], [589.3, '[Co III]', 'Co III', 0.35, 3000],
            [715.5, '[Fe II]', 'Fe II', 0.35, 3000], [737.8, '[Ni II]', 'Ni II', 0.28, 3000], [864.0, '[Fe II]', 'Fe II', 0.18, 3000]
        ]
    },
    II: {
        firstLight: -10,
        temperature: [[-10, 30000], [-5, 22000], [0, 15000], [7, 10000], [15, 8000], [30, 6200], [60, 5400], [100, 5200], [200, 4500]],
        speed: [[-10, 15000], [0, 11000], [15, 8000], [30, 6000], [60, 4000], [100, 3000]],
        width: 1800,
        continuum: [[100, 1], [125, 0.3], [200, 0.05]],
        nebular: [[90, 0], [125, 0.7], [170, 1]],
        ultraviolet: null,
        features: [
            [656.28, 'Hα', 'H I', [0.15, 0.25, 0.4, 0.45, 0.4], [0.5, 1.1, 1.9, 2.1, 2.4]],
            [486.13, 'Hβ', 'H I', [0.15, 0.25, 0.4, 0.45, 0.4], [0.2, 0.4, 0.7, 0.7, 0.7]],
            [434.05, 'Hγ', 'H I', [0.12, 0.2, 0.3, 0.35, 0.3], [0.1, 0.2, 0.3, 0.3, 0.3]],
            [410.17, 'Hδ', 'H I', [0.1, 0.15, 0.25, 0.25, 0.2], [0.05, 0.1, 0.15, 0.15, 0.15]],
            [587.56, 'He I', 'He I', [0.2, 0.2, 0.05, 0, 0], [0.2, 0.2, 0.05, 0, 0]],
            [589.3, 'Na D', 'Na I', [0, 0, 0.1, 0.35, 0.5], [0, 0, 0.1, 0.3, 0.4]],
            [492.39, 'Fe II', 'Fe II', [0, 0, 0.1, 0.3, 0.35], [0, 0, 0.02, 0.08, 0.1]],
            [501.84, 'Fe II', 'Fe II', [0, 0, 0.1, 0.3, 0.35], [0, 0, 0.02, 0.08, 0.1]],
            [516.9, 'Fe II', 'Fe II', [0, 0, 0.1, 0.3, 0.35], [0, 0, 0.02, 0.08, 0.1]],
            [393.37, 'Ca II K', 'Ca II', [0, 0.1, 0.35, 0.55, 0.55], [0, 0, 0.05, 0.1, 0.1]],
            [396.85, 'Ca II H', 'Ca II', [0, 0.08, 0.28, 0.45, 0.45], [0, 0, 0, 0, 0]],
            [854.21, 'Ca II', 'Ca II', [0, 0, 0.2, 0.5, 0.6], [0, 0, 0.3, 0.6, 0.8]]
        ],
        emission: [
            [656.28, 'Hα', 'H I', 1, 1500], [630.03, '[O I]', 'O I', 0.35, 1500], [636.38, '[O I]', 'O I', 0.12, 1500],
            [729.15, '[Ca II]', 'Ca II', 0.35, 1400], [732.39, '[Ca II]', 'Ca II', 0.2, 1400], [854.21, 'Ca II', 'Ca II', 0.25, 1500],
            [589.3, 'Na D', 'Na I', 0.12, 1500], [486.13, 'Hβ', 'H I', 0.12, 1500], [715.5, '[Fe II]', 'Fe II', 0.1, 1200]
        ]
    }
};

function typeOf(body) {
    return body.supernova.type === 'Ia' ? TYPES.Ia : TYPES.II;
}

function magnitudesBelowPeak(body, phase) {
    if (body.supernova.type === 'Ia') {
        if (phase < 0) return 0.015 * phase * phase;
        if (phase <= 15) return 1.1 * (phase / 15) ** 1.2;
        if (phase <= 35) return 1.1 + 0.09 * (phase - 15);
        return 2.9 + 0.0135 * (phase - 35);
    }
    if (phase < 0) return 0.02 * phase * phase;
    if (phase <= 20) return 0.5 * (phase / 20);
    if (phase <= 100) return 0.5 + 0.002 * (phase - 20);
    if (phase <= 120) return 0.66 + 0.1 * (phase - 100);
    return 2.66 + 0.0098 * (phase - 120);
}

const phaseOf = (body, t) => (body.supernova.phase0_days ?? 0) + t;

export function supernovaPeakMag(body) {
    return body.supernova.peak_mag ?? body.brightness?.mag ?? 3;
}

// Apparent magnitude at a phase, or Infinity before the explosion
export function supernovaMag(body, phase) {
    if (phase < typeOf(body).firstLight) return Infinity;
    return supernovaPeakMag(body) + magnitudesBelowPeak(body, phase);
}

export function supernovaSpectrum(body, grid, opts) {
    const type = typeOf(body);
    const phase = phaseOf(body, opts.t ?? 0);
    const factor = 1 + (body.radial_velocity_kms ?? 0) / C_KMS;
    const { wl, n } = grid;

    if (phase < type.firstLight) {
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
            if (trough >= grid.lo && trough <= grid.hi) {
                lines.push({ rest_nm: rest, obs_nm: trough, species, label, depth: depth * shape.peak, type: 'abs' });
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

    const mag = supernovaMag(body, phase);
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
    const type = typeOf(body);
    const phase0 = body.supernova.phase0_days ?? 0;
    const from = opts.from_days ?? Math.min(0, type.firstLight - phase0);
    const to = opts.to_days ?? Math.max(from + 60, 500 - phase0);
    const n = opts.samples ?? 260;
    const t_days = new Float64Array(n);
    const mag = new Float64Array(n);
    const rel_flux = new Float64Array(n);
    const peakMag = supernovaPeakMag(body);
    for (let i = 0; i < n; i++) {
        const t = from + ((to - from) * i) / (n - 1);
        const m = supernovaMag(body, phase0 + t);
        t_days[i] = t;
        mag[i] = m;
        rel_flux[i] = Number.isFinite(m) ? 10 ** (-0.4 * (m - peakMag)) : 0;
    }
    return { t_days, mag, rel_flux, peak_mag: peakMag, t_peak_days: -phase0, t_first_light_days: type.firstLight - phase0 };
}

export const SUPERNOVA_SPAN_DAYS = 500;
