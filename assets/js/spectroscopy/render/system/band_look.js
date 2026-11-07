// How each thing in a planetary system shows in each band, up close (spec section 5). The sky's own false colours and
// cross-fade apply: shaders read the engine's band weights, and this gives each part's strength in each band, as a multiple
// of how it looks in visible light. Values are five-long, in the order of BANDS: radio, IR, visible, UV, X-ray.
// Plain maths, no three.js, so it runs under Node for tests.

import { BANDS, BAND_INFO } from '../../core/bands.js';
import { bandStrengths, planckBandFractions } from '../../data/band_table.js';

export const TINTS = BANDS.map((b) => BAND_INFO[b].tint);

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// One value for the current mix of bands
export function mixBands(w, v) {
    return w[0] * v[0] + w[1] * v[1] + w[2] * v[2] + w[3] * v[3] + w[4] * v[4];
}

// A colour in the current mix: its true colour in visible light, each other band's false colour, each scaled by v
export function bandRgb(w, trueRgb, v, out = [0, 0, 0]) {
    for (let c = 0; c < 3; c++) {
        out[c] = trueRgb[c] * v[2] * w[2] + TINTS[0][c] * v[0] * w[0] + TINTS[1][c] * v[1] * w[1]
            + TINTS[3][c] * v[3] * w[3] + TINTS[4][c] * v[4] * w[4];
    }
    return out;
}

// For the shaders: the false colours' share of the mix and their blend, so a shader can turn a true colour into the band's
export function falseTint(w, out = [0, 0, 0]) {
    const share = 1 - w[2];
    for (let c = 0; c < 3; c++) {
        out[c] = share > 1e-4 ? (TINTS[0][c] * w[0] + TINTS[1][c] * w[1] + TINTS[3][c] * w[3] + TINTS[4][c] * w[4]) / share : 1;
    }
    return { tint: out, share };
}

// ---------- Stars ----------

// A star's surface and the glow round its edge, in each band. Black-body light goes by the share of the Planck curve in
// each band beside the share in visible light, square-rooted as the sky's strengths are: hot stars blaze in ultraviolet, cool
// ones and giants in infrared. X-rays and radio come from a hot corona, not the surface, so they are in the glow, with the
// disc dim. Up close even a quiet star's chromosphere gives a little radio (judgement: the quiet Sun is a radio source to a
// nearby receiver, though no star is from parsecs away), so in radio a star is dim but not gone. Active M dwarfs flare.
export function starBandLook(entry, accreting = false) {
    const star = entry.star;
    const stage = star.stage || 'main_sequence';
    if (stage === 'neutron_star') {
        // Thermal X-rays from the hot surface are how most are seen. The beams carry the radio.
        return {
            surface: [0, 0, 1, 0.5, 1.5],
            corona: [0, 0, 1, 0.45, 1.3],
            flares: false
        };
    }
    const bands = entry.entity && entry.entity.bands ? entry.entity.bands : bandStrengths({ kind: 'star', star });
    const f = planckBandFractions(star.teff_K);
    const vis = Math.max(f.visible, 1e-6);
    const ir = clamp(Math.sqrt(f.ir / vis), 0.04, 2.2);
    const uv = clamp(Math.sqrt(f.uv / vis), 0.02, 2.2);
    const white = stage === 'white_dwarf';
    const dwarf = stage === 'main_sequence';
    const cool = star.teff_K < 7000;
    const xr = clamp((bands.xray || 0) / 0.3, 0, 1.3);
    const flares = dwarf && star.class === 'M' && (bands.xray || 0) >= 0.3;
    const surface = [
        0.06 + 0.5 * (bands.radio || 0),
        ir,
        1,
        uv,
        white ? clamp((bands.xray || 0) * 2.5, 0.02, 1.4) : 0
    ];
    const corona = [
        0.08 + 1.5 * (bands.radio || 0),
        0.6 * ir,
        1,
        // Cool dwarfs: a chromosphere and transition region bright in UV above a surface that's dim in it
        cool && dwarf ? Math.max(uv, 0.35 + 0.4 * xr) : uv,
        white ? 0.6 * surface[4] : cool ? 0.1 + xr : 0.08 + 0.6 * xr
    ];
    // The hot corona lies over the disc as well as round it, and from the front it's all that X-rays see there
    if (!white) surface[4] = 0.4 * corona[4];
    if (accreting) {
        // Gas from its partner lands on it at hundreds of km/s and heats to millions of degrees, so the accreting star of an
        // interacting pair shines in X-rays and UV wherever it is in view, however small its disc is drawn
        surface[4] += 0.6;
        corona[4] += 1.6;
        surface[3] = Math.max(surface[3], 1);
        corona[3] += 0.8;
    }
    return { surface, corona, flares };
}

// A flare on an active M dwarf: a few seconds of extra X-rays, UV and radio, every so often. Never more than a flash
// every few seconds. Returns 0 (quiet) to about 1.6; held at 0 with Reduce motion.
export function createFlares(seed) {
    let t = 0;
    let next = 2 + (seed % 7);
    let start = -100;
    let size = 1;
    let n = seed;
    const rand = () => {
        n = (n * 1103515245 + 12345) % 2147483648;
        return n / 2147483648;
    };
    return {
        step(dt, reduceMotion) {
            if (reduceMotion) return 0;
            t += dt;
            if (t >= next) {
                start = t;
                size = 0.6 + rand();
                next = t + 5 + rand() * 9;
            }
            const since = t - start;
            if (since < 0 || since > 6) return 0;
            const rise = Math.min(1, since / 0.35);
            return size * rise * rise * Math.exp(-Math.max(0, since - 0.35) / 1.4);
        }
    };
}

// What a flare adds, as multiples of the quiet values: radio, IR, visible, UV, X-ray
export const FLARE_GAIN = { surface: [0.8, 0, 0, 0.8, 1.2], corona: [2, 0, 0.15, 1.5, 2.5] };

// ---------- Remnants and gas ----------

// A black hole's disc: how bright the whole disc is, and how much more towards its hot inner edge. The inner disc is at
// millions of degrees, so X-rays come from there; the outer disc is cooler and shows in infrared. Radio comes from the jets.
export const HOLE_DISC = [[0.05, 0], [0.75, -0.45], [1, 0], [0.55, 1.3], [0.22, 3.2]];
// The jets, where there are jets: synchrotron radio, with a little X-ray from their knots
export const JET_BANDS = [1.6, 0.08, 0, 0.05, 0.35];
// A pulsar's beams: radio first; some pulsars sweep X-ray and gamma beams too. In visible they stay the stylised beams.
export const BEAM_BANDS = [2.2, 0, 1, 0.3, 0.7];
export const BEAM_TRUE = [0.55, 0.72, 1.0];
// The stream between two stars and the disc it feeds: gas heated as it falls, hottest where it lands
export const STREAM_BANDS = [0.08, 0.6, 1, 1.5, 1.4];
export const DISC_BANDS = [0.1, 0.45, 1, 2, 3.2];

// ---------- The sky behind a system ----------

// Galactic synchrotron along the band in radio, warm dust in infrared, a darker band in UV with dust blocking it, and a faint
// diffuse glow in X-rays and gamma rays. lane: how much the dust lanes darken the band; below 0 they glow instead.
export const SKY_GLOW = [0.9, 0.8, 1, 0.42, 0.32];
export const SKY_LANE = [0, -0.9, 0.8, 1, 0.2];
const NIGHT = [0.0021, 0.0037, 0.0100];

export function nightFloor(w, out = [0, 0, 0]) {
    const k = 0.0042;
    for (let c = 0; c < 3; c++) {
        out[c] = NIGHT[c] * w[2] + k * (TINTS[0][c] * w[0] + TINTS[1][c] * w[1] + TINTS[3][c] * w[3] + TINTS[4][c] * w[4]);
    }
    return out;
}
