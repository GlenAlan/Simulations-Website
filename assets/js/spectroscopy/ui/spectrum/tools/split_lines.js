// Which line shows a multiple star's lines splitting best. At the moment the stars' speeds along the line of sight are furthest
// apart, each candidate line is drawn in the whole system's light, as the plot will show it, and the one whose two dips stand
// clearest of each other wins. Hydrogen's lines and other broad ones seldom split for the eye, since each star's line is wider
// than the gap between them; a narrow metal line does. Pure: no DOM, so it can be tested on its own.
//
//   widestSplit(body, from, period, codes?) -> t   the next moment within one period when the followed stars are furthest apart
//   splitLine(entity, body, overviews, codes, { t, parts }) -> { line, contrast } | null
//       overviews[i] is the overview spectrum of the star codes[i] alone. null when no line shows two dips plainly.
//   halfSwing(body, codes, period) -> km/s    half how far the stars' lines spread over one period
//   readableFirst(lines, overviews, swings, seen, reachKms) -> lines   the same lines, with one every star can follow first

import { C_KMS, R_ZOOM } from '../../../core/phys.js';
import { spectrumOf } from '../../../spectra/synth.js';
import { hasLongWings, lineCentre } from '../../../spectra/measure.js';
import { componentStates } from '../../../data/orbits.js';

const TRIED = 12;           // Candidates drawn and looked at, the likeliest first
const PLAIN = 0.35;         // Between the dips, the flux comes at least this share of the way back up to the continuum
const LEAST_DIP = 0.04;     // And each dip is at least this deep, as a share of the continuum
const SAMPLES = 96;

export function widestSplit(body, from, period, codes = null) {
    let best = from;
    let most = -1;
    for (let k = 0; k < SAMPLES; k++) {
        const t = from + (k / SAMPLES) * period;
        const v = componentStates(body, t).filter((s) => !codes || codes.includes(s.code)).map((s) => s.vlos_kms);
        if (v.length < 2) return from;
        const spread = Math.max(...v) - Math.min(...v);
        if (spread > most + 1e-9) {
            most = spread;
            best = t;
        }
    }
    return best;
}

// A star's light at a wavelength, relative to the others: its area times a black body at its temperature
function lightAt(star, nm) {
    const x = 1.4388e7 / (nm * (star.teff_K || 5800));
    return (star.radius_Rsun ?? 1) ** 2 / (nm ** 5 * Math.expm1(Math.min(x, 700)));
}

// How plainly a line shows as two dips at time t: { contrast between them, depth of the shallower }, or null if it doesn't
function dipsAt(entity, body, line, t, a, b, parts) {
    const rv = body.radial_velocity_kms ?? 0;
    const nmA = line.rest_nm * (1 + (rv + a.vlos_kms) / C_KMS);
    const nmB = line.rest_nm * (1 + (rv + b.vlos_kms) / C_KMS);
    const half = line.rest_nm * ((Math.max(Math.abs(rv + a.vlos_kms), Math.abs(rv + b.vlos_kms)) + 60) / C_KMS);
    const opts = { lo_nm: line.rest_nm - half, hi_nm: line.rest_nm + half, R: R_ZOOM, t };
    if (parts) opts.parts = parts;
    const { wl, flux, continuum } = spectrumOf(entity, opts);
    if (!wl || wl.length < 8) return null;
    const step = Math.log(wl[1] / wl[0]);
    const index = (nm) => Math.max(0, Math.min(wl.length - 1, Math.round(Math.log(nm / wl[0]) / step)));
    const reach = Math.max(2, index(nmA + 0.25 * (nmB - nmA)) - index(nmA));
    const lowest = (nm) => {
        const c = index(nm);
        let at = c;
        for (let i = Math.max(0, c - reach); i <= Math.min(wl.length - 1, c + reach); i++) if (flux[i] < flux[at]) at = i;
        return at;
    };
    const ia = lowest(nmA);
    const ib = lowest(nmB);
    if (ib <= ia + 1) return null;
    let between = -Infinity;
    for (let i = ia + 1; i < ib; i++) between = Math.max(between, flux[i]);
    const cont = continuum[(ia + ib) >> 1];
    const shallow = Math.max(flux[ia], flux[ib]);
    if (!(cont > 0) || 1 - shallow / cont < LEAST_DIP) return null;
    return { contrast: (between - shallow) / (cont - shallow), depth: 1 - shallow / cont };
}

export function splitLine(entity, body, overviews, codes, { t = 0, parts = null } = {}) {
    if (codes.length < 2) return null;
    const states = componentStates(body, t).filter((s) => codes.includes(s.code)).sort((x, y) => x.vlos_kms - y.vlos_kms);
    if (states.length < 2) return null;
    const a = states[0];
    const b = states[states.length - 1];
    if (b.vlos_kms - a.vlos_kms < 3) return null;
    const starOf = (code) => (body.stars || []).find((s) => s.code === code);
    const sa = starOf(a.code);
    const sb = starOf(b.code);
    const oa = overviews[codes.indexOf(a.code)];
    const ob = overviews[codes.indexOf(b.code)];
    if (!sa || !sb || !oa || !ob) return null;

    // Each line both stars have, by the smaller of the two dips it would make in their joint light, where there is light to
    // see it in: a dip where the stars are dim is lost in the noise
    const usable = (l) => !l.band && l.type !== 'em' && l.obs_nm > 380 && l.obs_nm < 1000;
    const inB = new Map((ob.lines || []).filter(usable).map((l) => [l.rest_nm.toFixed(2), l]));
    const peakOf = (sp) => sp.flux.reduce((m, f) => (f > m ? f : m), 0) || 1;
    const peakA = peakOf(oa);
    const peakB = peakOf(ob);
    const fluxAt = (sp, nm) => {
        const i = Math.max(0, Math.min(sp.wl.length - 1, Math.round(Math.log(nm / sp.wl[0]) / Math.log(sp.wl[1] / sp.wl[0]))));
        return Math.max(0, sp.flux[i]);
    };
    const candidates = [];
    (oa.lines || []).filter(usable).forEach((la) => {
        const lb = inB.get(la.rest_nm.toFixed(2));
        if (!lb) return;
        const nm = la.rest_nm;
        const wa = lightAt(sa.star, nm);
        const wb = lightAt(sb.star, nm);
        const dip = Math.min((la.depth_zoom ?? la.depth) * wa, (lb.depth_zoom ?? lb.depth) * wb) / (wa + wb);
        if (dip < LEAST_DIP) return;
        const light = Math.sqrt(Math.min(fluxAt(oa, la.obs_nm) / peakA, fluxAt(ob, lb.obs_nm) / peakB));
        candidates.push({ line: la, light, guess: dip * light * (hasLongWings(la) ? 0.3 : 1) });
    });
    candidates.sort((x, y) => y.guess - x.guess);

    // Plain, and then as deep and as well lit as can be: a clear gap between two faint dips is still hard to see
    let best = null;
    candidates.slice(0, TRIED).forEach(({ line, light }) => {
        const seen = dipsAt(entity, body, line, t, a, b, parts);
        if (!seen || seen.contrast < PLAIN) return;
        const score = Math.min(1, seen.contrast) * seen.depth * light;
        if (!best || score > best.score) best = { line, score, contrast: seen.contrast };
    });
    if (!best) return null;
    const { rest_nm, label, species } = best.line;
    return { line: { rest_nm, label, species }, contrast: best.contrast };
}

// ---------- A line whose swing can be read ----------

const SHOWS_DEPTH = 0.03;   // As the Period tool's: shallower than this, a star doesn't really show a line
const READS_WELL = 0.35;    // A centre known to this share of the swing, even at the overview's coarse resolution, is plenty

// Half how far the lines of the stars in codes spread, together, over one period
export function halfSwing(body, codes, period) {
    const list = Array.isArray(codes) ? codes : [codes];
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 48; k++) {
        componentStates(body, (k / 48) * period).forEach((state) => {
            if (!list.includes(state.code)) return;
            lo = Math.min(lo, state.vlos_kms);
            hi = Math.max(hi, state.vlos_kms);
        });
    }
    return Number.isFinite(lo) ? 0.5 * (hi - lo) : 0;
}

// How finely the worst-placed star shows the line's centre, at the resolution it will be followed at, as a share of how far its
// lines swing. A broad line can't follow a small swing, and a white dwarf's hydrogen lines are thousands of km/s wide, however
// deep. seen.entity and seen.parts[i] say whose light star i's line is read in, as the Period tool reads it.
function readingShare(line, overviews, swings, seen, reachKms) {
    let worst = -1;
    overviews.forEach((overview, i) => {
        const own = (overview.lines || []).find((l) => !l.band && l.depth > SHOWS_DEPTH && Math.abs(l.rest_nm - line.rest_nm) < 0.01);
        if (!own) return;
        const nm = own.obs_nm;
        // A line about as deep in the same star, within the reach of the search (the swing, and part of the line's own width as the
        // overview shows it), could be followed in its place, swinging rightly but about the wrong middle
        const wide = lineCentre(overview, nm, { searchNm: nm * 0.0008, type: 'abs' });
        // With room to spare: the tool measures the width in all the stars' light together, where lines can blend
        const reach = 1.2 * reachKms + (wide ? (wide.fwhm_nm / wide.centre_nm) * C_KMS : 80) + 40;
        const crowded = reachKms > 0 && (overview.lines || []).some((l) => l !== own && !l.band && l.depth > 0.8 * own.depth
            && (Math.abs(l.obs_nm - nm) / nm) * C_KMS < reach);
        if (crowded) {
            worst = Infinity;
            return;
        }
        let found;
        if (seen) {
            const half = nm * 0.0015;
            const opts = { lo_nm: nm - half, hi_nm: nm + half, R: R_ZOOM };
            if (seen.parts[i]) opts.parts = [seen.parts[i]];
            found = lineCentre(spectrumOf(seen.entity, opts), nm, { searchNm: nm * 0.0002, type: 'abs' });
        } else {
            found = lineCentre(overview, nm, { searchNm: nm * 0.0008, type: 'abs' });
        }
        const err = found ? (found.err_nm / found.centre_nm) * C_KMS : Infinity;
        worst = Math.max(worst, err / Math.max(1, swings[i]));
    });
    return worst < 0 ? Infinity : worst;
}

// The order stays as it was while its first line can be read well enough; otherwise the next that can comes first.
// reachKms: how far from where it's expected the Period tool looks for a line.
export function readableFirst(lines, overviews, swings, seen = null, reachKms = 0) {
    if (lines.length < 2) return lines;
    const shares = lines.map((line) => readingShare(line, overviews, swings, seen, reachKms));
    if (shares[0] <= READS_WELL) return lines;
    // The next in the order that reads well enough, or failing that the one read best
    let best = shares.findIndex((share) => share <= READS_WELL);
    if (best < 0) {
        best = 0;
        shares.forEach((share, k) => { if (share < shares[best]) best = k; });
    }
    return best ? [lines[best], ...lines.filter((_, k) => k !== best)] : lines;
}
