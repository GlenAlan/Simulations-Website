// How a system's light is shared between its stars. The same sum as the spectrum's continuum: each star adds its radius squared
// times the Planck curve at its temperature. No DOM here, so it can be checked under Node.

import { bb } from '../../../spectra/kernel.js';
import { eclipsingOrbits, visibleShares } from '../../../data/orbits.js';

const SAMPLES = 64;
const CURVE_SAMPLES = 2400;      // Over one orbit: an eclipse a few per cent of the orbit long still gets plenty

// A star's light across a range of wavelengths, in the spectrum's arbitrary units
function lightIn(star, lo, hi) {
    const ratio = (hi / lo) ** (1 / (SAMPLES - 1));
    const T = star.teff_K;
    let sum = 0;
    let nm = lo;
    for (let i = 0; i < SAMPLES; i++) {
        // Log spaced, so each sample stands for a width in proportion to its wavelength
        sum += bb(nm, T) * nm;
        nm *= ratio;
    }
    return sum * (star.radius_Rsun ?? 1) ** 2;
}

// Each star's share of the light between lo and hi at this moment: [{ code, share }] in body.stars order
export function lightShares(body, lo, hi, t = 0) {
    const seen = visibleShares(body, t);
    const lights = body.stars.map((s, i) => lightIn(s.star, lo, hi) * (seen ? seen[i] : 1));
    const total = lights.reduce((sum, x) => sum + x, 0);
    return body.stars.map((s, i) => ({ code: s.code, share: total > 0 ? lights[i] / total : 0 }));
}

// One orbit of an eclipsing system's brightness: { period_days, level (1 = nothing hidden), lowest, dips }. Each dip is
// { depth (share of the full light), duration_days, at_days, hidden (the code of the star behind) }, deepest first.
export function eclipseCurve(body, lo, hi) {
    const orbit = eclipsingOrbits(body)[0];
    if (!orbit) return null;
    const P = orbit.period_days;
    const lights = body.stars.map((s) => lightIn(s.star, lo, hi));
    const total = lights.reduce((sum, x) => sum + x, 0);
    const level = new Float32Array(CURVE_SAMPLES);
    const behind = new Int8Array(CURVE_SAMPLES);
    let lowest = 1;
    for (let i = 0; i < CURVE_SAMPLES; i++) {
        const seen = visibleShares(body, (i / CURVE_SAMPLES) * P);
        let sum = 0;
        let most = -1;
        let mostHidden = 0;
        seen.forEach((share, s) => {
            sum += lights[s] * share;
            if (1 - share > mostHidden) {
                mostHidden = 1 - share;
                most = s;
            }
        });
        level[i] = sum / total;
        behind[i] = most;
        if (level[i] < lowest) lowest = level[i];
    }
    // Runs of samples below the full light, starting from one that isn't, so a dip that spans t = 0 stays whole
    let start = 0;
    while (start < CURVE_SAMPLES && level[start] < 1) start++;
    const dips = [];
    let run = null;
    for (let k = 0; k <= CURVE_SAMPLES; k++) {
        const i = (start + k) % CURVE_SAMPLES;
        if (k < CURVE_SAMPLES && level[i] < 1) {
            if (!run) run = { n: 0, low: 1, at: i };
            run.n++;
            if (level[i] < run.low) {
                run.low = level[i];
                run.at = i;
            }
        } else if (run) {
            dips.push({
                depth: 1 - run.low,
                duration_days: (run.n / CURVE_SAMPLES) * P,
                at_days: (run.at / CURVE_SAMPLES) * P,
                hidden: body.stars[behind[run.at]].code
            });
            run = null;
        }
    }
    dips.sort((a, b) => b.depth - a.depth);
    return { period_days: P, level, lowest, dips };
}
