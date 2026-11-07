// Slide the lines: a lamp's lines drawn over the spectrum where they would be at rest, which the student drags (or moves with
// a slider) until they sit on the object's own dips or bright lines. The reading is how far they moved them, with an
// uncertainty from how finely that can be judged at the zoom on show. Part of How is it moving?, in doppler.js.
//
//   const slide = createSlide(container, api, { says })   -> { enter(), leave(), setEntity(resolved), dispose() }
//
// The shift lives in the reference picker (picker.setShiftZ), so it carries over to whatever reference is shown next, such as
// the standard stars in How hot?.

import { app } from '../../../core/state.js';
import { recordMeasurement, getMeasurement } from '../../../core/measurements.js';
import { C_KMS, SPECTRUM_LO_NM, SPECTRUM_HI_NM } from '../../../core/phys.js';
import { sci, signed, sig, withCommas } from '../../../core/format.js';
import { LINES } from '../../../data/lines.js';
import { getReference } from '../../../data/references.js';
import { blendAllowance, dopplerFrom, lineCentre, resolvingPower } from '../../../spectra/measure.js';
import { QUASAR_LINE_WIDTH, slideError } from '../../../spectra/hand_fit.js';
import { WAVELENGTH_PRESETS } from '../plot.js';
import { shiftSettings } from '../refs.js';
import { el } from '../../plot2d.js';
import { actionRow, diagramLink, fill, hasTab, para, plotLabel, toolLink } from './common.js';
import { drawGrip, handTheme, HAND_DASH, holdToRepeat, plotGrab, reachOf } from './hands_on.js';

// ---------- Words for a shift ----------

export function direction(z) {
    return z >= 0 ? '→ moving away' : '← moving towards us';
}

// z and v with an uncertainty rounded together: enough digits to show it, no more
export function zText(z, err) {
    const digits = err > 0 ? Math.max(2, Math.min(6, Math.ceil(-Math.log10(err)))) : 5;
    return `${signed(z, digits)} ± ${err.toFixed(digits)}`;
}

export function velocityText(v, err) {
    const digits = err < 1 ? 1 : 0;
    const shown = err < 1 ? err.toFixed(1) : withCommas(Math.max(1, err));
    const value = digits ? signed(v, 1) : `${v < 0 ? '−' : '+'}${withCommas(Math.abs(v))}`;
    return `${value} ± ${shown} km/s`;
}

// Every galaxy in this sky is moving away from us, as nearly all are in the real one. A far galaxy's lines move a long way, so a
// dip near where one line belongs is often another line that has moved there: Na D lands beside Hα's rest place at z ≈ 0.11.
// Said when a reading comes out as a galaxy coming towards us at more than galaxies' own motions allow.
const GALAXY_TOWARDS_KMS = 300;
export function galaxyWarning(entity, z) {
    if (!entity || entity.kind !== 'galaxy' || !(z * C_KMS < -GALAXY_TOWARDS_KMS)) return '';
    return 'Almost every galaxy is moving away from us. A far galaxy\'s lines move a long way, so this dip may be a different line that has moved here.';
}

function nmText(nm) {
    const size = Math.abs(nm);
    const digits = size < 1 ? 2 : size < 10 ? 1 : 0;
    return `${nm < 0 ? '−' : '+'}${size.toFixed(digits)} nm`;
}

// ---------- Which lines to offer ----------

// One tap picks the lamp and zooms to its line, wherever the slide has moved it
const TARGETS = [
    { id: 'lya', label: 'Lyα', lamp: 'lamp:H', at: [121.567], preset: 'lya' },
    { id: 'civ', label: 'C IV', lamp: 'uv:C IV', at: [154.82, 155.078] },
    { id: 'mgii', label: 'Mg II', lamp: 'uv:Mg II', at: [279.553, 280.271] },
    { id: 'cahk', label: 'Ca H & K', lamp: 'ion:Ca II', at: [393.366, 396.847], preset: 'cahk' },
    { id: 'hbeta', label: 'Hβ', lamp: 'lamp:H', at: [486.133] },
    { id: 'oiii', label: '[O III]', lamp: 'ion:O III', at: [500.684, 495.891] },
    { id: 'mgb', label: 'Mg b', lamp: 'lamp:Mg', at: [518.36, 517.268, 516.732] },
    { id: 'nad', label: 'Na D', lamp: 'lamp:Na', at: [588.995, 589.592], preset: 'nad' },
    { id: 'halpha', label: 'Hα', lamp: 'lamp:H', at: [656.282], preset: 'halpha' }
];
// Which lines each sort of object is offered: the well-known ones for a star; for a quasar, the far-UV lines its light
// has stretched into view
const OFFERED = {
    star: ['halpha', 'cahk', 'nad'],
    galaxy: ['cahk', 'mgb', 'nad', 'halpha', 'oiii'],
    quasar: ['lya', 'civ', 'mgii', 'halpha'],
    nucleus: ['halpha', 'hbeta', 'oiii', 'cahk', 'nad'],
    nebula: ['halpha', 'hbeta', 'oiii']
};
const MOST_TARGETS = 3;
const ZOOM_HALF = 0.013;     // Half the width of a zoom on one line, as a share of its wavelength: Hα's preset

// The strongest of the object's own lines that a lamp can match, as a student would pick them out by eye. Depends on the
// lines, never on how far they are shifted.
function targetsFor(entity, overview) {
    const offered = OFFERED[entity.kind] || (entity.kind === 'supernova' || entity.kind === 'nebula' ? OFFERED.nebula : OFFERED.star);
    const lines = (overview && overview.lines) || [];
    const scored = TARGETS.filter((t) => offered.includes(t.id)).map((t) => {
        let strength = 0;
        lines.forEach((line) => {
            if (!line.band && t.at.some((w) => Math.abs(line.rest_nm - w) < 0.3)) strength = Math.max(strength, Math.abs(line.depth ?? 0));
        });
        return { t, strength };
    });
    const strong = scored.filter((s) => s.strength >= 0.05).sort((a, b) => b.strength - a.strength).slice(0, MOST_TARGETS);
    if (!strong.length) return { list: [TARGETS.find((t) => t.id === 'halpha')], first: 'halpha' };
    const first = strong[0].t.id;
    return { list: TARGETS.filter((t) => strong.some((s) => s.t === t)), first };
}

// ---------- The one best line, for lining up a single line ----------

// Lines a student will know by name, any of which the best line can be
const KNOWN_LINES = [656.282, 486.133, 434.047, 393.366, 396.847, 588.995, 589.592, 518.36, 121.567, 154.82, 279.553, 500.684, 447.148, 587.562, 468.57, 541.152];
const BEST_MIN_DEPTH = 0.05;

// The object's own line that is easiest to line up a reference line with, and to set finely: strong, narrow, standing clear of
// its neighbours, where the object gives plenty of light, and in the visible if it can be, where a student is already looking.
// Returns { rest, obs, rel, label, fwhm } or null.
const SHARP_KMS = 100;          // A line this wide counts half as well as a very narrow one
export function bestLineFor(overview, { broad = false } = {}) {
    const lines = (overview && overview.lines) || [];
    const { wl, flux } = overview || {};
    if (!wl || !flux) return null;
    let top = 0;
    for (let i = 0; i < flux.length; i += 20) if (flux[i] > top) top = flux[i];
    const lightAt = (nm) => {
        let a = 0;
        let b = wl.length - 1;
        while (b - a > 1) {
            const m = (a + b) >> 1;
            if (wl[m] < nm) a = m;
            else b = m;
        }
        let sum = 0;
        let n = 0;
        for (let i = Math.max(0, a - 40); i < Math.min(flux.length, a + 40); i++) {
            sum += Math.max(0, flux[i]);
            n++;
        }
        return top > 0 && n ? sum / n / top : 0;
    };
    let best = null;
    let bestScore = 0;
    lines.forEach((line) => {
        if (line.band || !(Math.abs(line.depth ?? 0) >= BEST_MIN_DEPTH)) return;
        if (!KNOWN_LINES.some((w) => Math.abs(w - line.rest_nm) < 0.05)) return;
        const obs = line.obs_nm ?? line.rest_nm;
        if (obs < SPECTRUM_LO_NM * 1.05 || obs > SPECTRUM_HI_NM * 0.95) return;
        const found = lineCentre(overview, obs, { searchNm: obs * 0.002, type: line.type === 'em' ? 'em' : 'abs' });
        // A quasar's bright lines are all broad, whatever a noisy top seems to measure
        const fwhm = Math.max(found ? found.fwhm_nm : obs / 5000, broad ? obs * QUASAR_LINE_WIDTH : 0);
        const blended = blendAllowance(lines, line.rest_nm, fwhm, obs / line.rest_nm - 1) > 0;
        const visible = obs >= 380 && obs <= 750 ? 1 : 0.7;
        const sharp = 1 / (1 + (fwhm / obs) * C_KMS / SHARP_KMS);
        const light = Math.sqrt(Math.max(0.0025, lightAt(obs)));
        const score = Math.sqrt(Math.min(1, Math.abs(line.depth))) * (blended ? 0.35 : 1) * visible * sharp * light;
        if (score > bestScore) {
            bestScore = score;
            best = { rest: line.rest_nm, obs, rel: 1, label: line.label || `${line.species} ${line.rest_nm.toFixed(1)}`, fwhm };
        }
    });
    return best;
}

// A lamp's lines, strongest first. A thin lamp's brightness goes as s cubed; the faintest are left out, as they'd only clutter.
const lampCache = new Map();
function lampLines(id) {
    if (lampCache.has(id)) return lampCache.get(id);
    const item = getReference(id);
    const all = (item && LINES[item.species]) || [];
    const list = item && item.lines
        ? item.lines.map((w) => all.reduce((best, line) => (Math.abs(line.w - w) < Math.abs(best.w - w) ? line : best), { w: Infinity })).filter((l) => Number.isFinite(l.w))
        : all;
    const top = Math.max(1e-9, ...list.map((l) => (l.s ?? 1) ** 3));
    const lines = list
        .map((l) => ({ rest: l.w, rel: (l.s ?? 1) ** 3 / top, label: l.label || `${item.species} ${l.w.toFixed(1)}` }))
        .filter((l) => l.rel >= 0.02)
        .sort((a, b) => b.rel - a.rel);
    lampCache.set(id, lines);
    return lines;
}

function lampName(id) {
    const item = getReference(id);
    return item ? item.label.replace(/\s*\(.*\)$/, '') : '';
}

// ---------- The slider: linear for a star; for galaxies and quasars it stretches out near zero, where the fine steps matter ----------

const POSITIONS = 2000;

function scaleFor(entity) {
    const s = shiftSettings(entity);
    const toZ = (v) => (s.unit === 'z' ? v : v / C_KMS);
    const zMin = toZ(s.min);
    const zMax = toZ(s.max);
    const fine = toZ(s.step);
    const soft = zMax > 10 * Math.abs(zMin) ? Math.abs(zMin) / 4 : 0;
    const u = (z) => (soft ? Math.asinh(z / soft) : z);
    const back = (x) => (soft ? soft * Math.sinh(x) : x);
    const uMin = u(zMin);
    const uMax = u(zMax);
    const positions = soft ? POSITIONS : Math.min(POSITIONS, Math.round((zMax - zMin) / fine));
    return {
        zMin,
        zMax,
        fine,
        positions,
        clamp: (z) => Math.max(zMin, Math.min(zMax, z)),
        pos: (z) => Math.round((positions * (u(z) - uMin)) / (uMax - uMin)),
        z: (p) => back(uMin + (p / positions) * (uMax - uMin))
    };
}

// single: true lines up just the object's best line, which it picks and zooms to for the student, with the working in steps
export function createSlide(container, api, { says, single = false }) {
    const { plot } = api;
    const reduceMotion = () => !!(app.settings && app.settings.reduceMotion);

    let active = false;
    let scale = scaleFor(null);
    let targets = { list: [], first: 'halpha' };
    let target = null;          // The line last zoomed to, which picks the lamp
    let lines = [];             // The lamp's lines
    let grabbed = null;         // The line last dragged
    let drag = null;
    let width = null;           // { obs, nm }: the width of the dip under the main line, once it has settled there
    let settleTimer = 0;
    let framedQuasar = null;
    let framedBest = null;      // The object whose best line was last framed

    // ---------- Building it ----------

    const answer = el('p', { class: 'spectro-tool-answer' });
    const warning = el('p', { class: 'spectro-tool-warning', hidden: true });
    const working = el('p', { class: 'spectro-tool-line' });
    // The single line's working, a step at a time, filled in as the line moves
    const workItems = [0, 1, 2, 3].map(() => el('li'));
    const workSteps = el('ol', { class: 'spectro-tool-steps', hidden: true }, ...workItems);
    const hint = para(single ? 'Drag the dashed line onto the object\'s line.' : 'Drag the dashed lines onto the dips.');
    const minus = el('button', { type: 'button', class: 'spectro-square', text: '−', 'aria-label': 'Slide a little towards blue', title: 'A little towards blue' });
    const plus = el('button', { type: 'button', class: 'spectro-square', text: '+', 'aria-label': 'Slide a little towards red', title: 'A little towards red' });
    const slider = el('input', { type: 'range', class: 'spectro-hands-big', min: '0', step: '1', 'aria-label': single ? 'Slide the reference line' : 'Slide the reference lines' });
    const sliderRow = el('div', { class: 'spectro-hands-slide' }, minus, slider, plus);
    const ends = el('div', { class: 'spectro-hands-ends', 'aria-hidden': 'true' }, el('span', { text: '← Bluer' }), el('span', { text: 'Redder →' }));
    const zoomRow = el('div', { class: 'spectro-hands-chips spectro-hands-zooms', role: 'group', 'aria-label': 'Zoom to a line', hidden: single });
    const useBox = el('div', { class: 'spectro-hands-use' });
    const none = para('No line here stands out clearly enough to line up. Try Measure one line.');
    none.hidden = true;
    const root = el('div', { class: 'spectro-hands-pane' }, answer, warning, single ? workSteps : working, hint, none, sliderRow, ends, zoomRow, useBox);
    container.append(root);

    // ---------- The shift ----------

    const zNow = () => api.picker.state().z;

    function setZ(z, { from = 'drag' } = {}) {
        const next = scale.clamp(z);
        if (next === zNow()) return;
        api.picker.setShiftZ(next);
        if (from !== 'slider') slider.value = String(scale.pos(next));
        width = null;
        render();
        settleSoon();
        plot.redraw();
    }

    slider.addEventListener('input', () => setZ(scale.z(Number(slider.value)), { from: 'slider' }));
    holdToRepeat(minus, (k) => setZ(zNow() - k * scale.fine, { from: 'button' }));
    holdToRepeat(plus, (k) => setZ(zNow() + k * scale.fine, { from: 'button' }));

    // ---------- The main line: the one dragged, or the one zoomed to, or the strongest in view ----------

    function inView(nm) {
        const { lo, hi } = plot.getRange();
        return nm >= lo && nm <= hi;
    }

    function mainLine() {
        if (single) return lines[0] || null;
        const f = 1 + zNow();
        if (grabbed && inView(grabbed.rest * f)) return grabbed;
        const wanted = target ? lines.find((l) => Math.abs(l.rest - target.at[0]) < 0.01) : null;
        if (wanted && inView(wanted.rest * f)) return wanted;
        return lines.find((l) => inView(l.rest * f)) || wanted || lines[0] || null;
    }

    // ---------- Reading ----------

    function nmPerPxAt(nm) {
        const x = plot.xOf(nm);
        return Math.abs(plot.nmOf(x + 1) - plot.nmOf(x));
    }

    function reading() {
        const line = mainLine();
        const z = zNow();
        if (!line || !z) return null;
        const obs = line.rest * (1 + z);
        const spectrum = api.getSpectrum();
        const R = spectrum ? resolvingPower(spectrum) : 5000;
        const settled = !!width && Math.abs(width.obs - obs) < 1e-9 * obs + 1e-9;
        const dip = settled ? width.nm : obs / Math.max(1000, R);
        const errNm = slideError({ restNm: line.rest, z, nmPerPx: nmPerPxAt(obs), widthNm: dip, stepZ: scale.fine, blendNm: settled ? width.blend : 0 });
        return { line, z, d: dopplerFrom(obs, line.rest, errNm) };
    }

    // Once the lines stop moving, the width of whatever dip the main line sits on sets how finely it could be judged
    function settleSoon() {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
            const line = mainLine();
            const spectrum = api.getSpectrum();
            if (!line || !spectrum || !active) return;
            const z = zNow();
            const obs = line.rest * (1 + z);
            const found = lineCentre(spectrum, obs, { searchNm: Math.max(obs * 4e-4, 3 * nmPerPxAt(obs)) });
            let nm = found ? found.fwhm_nm : obs / Math.max(1000, resolvingPower(spectrum));
            if (api.resolved.entity.kind === 'quasar') nm = Math.max(nm, obs * QUASAR_LINE_WIDTH);
            const overview = api.getOverview();
            width = { obs, nm, blend: blendAllowance(overview && overview.lines, line.rest, nm, z) };
            render();
            const r = reading();
            if (r) says.textContent = `${answerText(r)}, ${direction(r.z).replace(/^[←→]\s*/, '')}`;
        }, 160);
    }

    function answerText(r) {
        return r.d.beyondCz ? `z = ${zText(r.d.z, r.d.err_z)}` : `v = ${velocityText(r.d.v_kms, r.d.err_kms)}`;
    }

    // The single line's sum, from where the student has put it: rest, observed, the difference, then the speed or z
    function renderSteps(r) {
        workSteps.hidden = !r;
        if (!r) return;
        const obs = r.line.rest * (1 + r.z);
        const digits = Math.abs(r.d.dlambda_nm) < 1 ? 2 : 1;
        workItems[0].textContent = `λ₀ = ${r.line.rest.toFixed(2)} nm: ${r.line.label} at rest`;
        workItems[1].textContent = `λ = ${obs.toFixed(2)} nm: where you put it`;
        workItems[2].textContent = `Δλ = λ − λ₀ = ${r.d.dlambda_nm >= 0 ? '+' : '−'}${Math.abs(r.d.dlambda_nm).toFixed(digits)} nm`;
        const dl = Math.abs(r.d.dlambda_nm).toFixed(digits);
        workItems[3].textContent = r.d.beyondCz
            ? `z = Δλ ÷ λ₀ = ${dl} ÷ ${r.line.rest.toFixed(2)} = ${signed(r.d.z, 3)}`
            : `v = c × Δλ ÷ λ₀ = ${sci(C_KMS, 3)} km/s × ${dl} ÷ ${r.line.rest.toFixed(2)} = ${r.d.v_kms < 0 ? '−' : '+'}${withCommas(Math.abs(r.d.v_kms))} km/s`;
    }

    let useKey = '';
    function render() {
        const r = reading();
        hint.hidden = !!r || (single && !lines.length);
        if (!r) {
            answer.textContent = 'Not moved yet';
            working.textContent = '';
            working.hidden = true;
        } else {
            answer.replaceChildren(answerText(r), el('span', { class: 'spectro-tool-direction', text: direction(r.z) }));
            working.hidden = false;
            working.textContent = `Moved ${nmText(r.d.dlambda_nm)} at ${r.line.label}, so ${r.d.beyondCz ? 'z = Δλ ÷ λ' : 'v = c × Δλ ÷ λ'}`;
        }
        const warn = r ? galaxyWarning(api.resolved && api.resolved.entity, r.z) : '';
        if (warning.textContent !== warn) warning.textContent = warn;
        warning.hidden = !warn;
        if (single) renderSteps(r);
        slider.setAttribute('aria-valuetext', r ? `${answerText(r)}, ${direction(r.z).replace(/^[←→]\s*/, '')}` : 'Not moved');
        renderUse(r);
    }

    // To the Hubble plot, for a galaxy or a quasar: what a slide reads is a measurement like any other
    function renderUse(r) {
        const code = api.resolved ? api.resolved.entity.code : '';
        const m = getMeasurement(code) || {};
        const used = !!r && m.v_source === 'slide' && m.z === r.d.z;
        const key = !r || !hasTab('hubble') ? 'none' : used ? `used|${r.d.z}|${r.d.err_z}` : 'offer';
        if (key === useKey) return;
        useKey = key;
        if (key === 'none') {
            useBox.replaceChildren();
            return;
        }
        if (used) {
            fill(useBox,
                para(`Sent to Hubble: ${answerText(r)}.`),
                actionRow(
                    diagramLink('hubble'),
                    api.resolved.entity.kind === 'galaxy' && !(m.distance_pc > 0) ? toolLink(api, 'photometer', 'Brightness next') : null
                ));
            return;
        }
        fill(useBox, actionRow(el('button', {
            type: 'button',
            class: 'spectro-tool-go',
            text: 'Use this speed',
            onclick: (e) => {
                const now = reading();
                if (!now) return;
                recordMeasurement(code, { v_kms: now.d.v_kms, v_err_kms: now.d.err_kms, z: now.d.z, v_source: 'slide' });
                useKey = '';
                renderUse(now);
                says.textContent = `Sent to Hubble: ${answerText(now)}`;
                if (e.detail === 0) {
                    const next = useBox.querySelector('button');
                    if (next) next.focus();
                }
            }
        })));
    }

    // ---------- Zooming to a line ----------

    function renderTargets() {
        const buttons = targets.list.map((t) => el('button', {
            type: 'button',
            class: 'spectro-hands-chip',
            'aria-pressed': target && target.id === t.id ? 'true' : 'false',
            text: t.label,
            'aria-label': `${t.label}: show its lamp lines and zoom to them`,
            onclick: () => zoomTo(t)
        }));
        const wide = el('button', { type: 'button', class: 'spectro-hands-chip', text: 'Wide', 'aria-label': 'Zoom out to see all the lines', onclick: zoomWide });
        zoomRow.replaceChildren(...buttons, wide);
    }

    function useLamp(t) {
        target = t;
        lines = lampLines(t.lamp);
        grabbed = null;
        width = null;
    }

    function zoomTo(t) {
        useLamp(t);
        renderTargets();
        const f = 1 + zNow();
        const preset = t.preset && WAVELENGTH_PRESETS.find((p) => p.id === t.preset);
        const centre = t.at.reduce((a, b) => a + b, 0) / t.at.length;
        const lo = preset ? preset.lo : centre * (1 - ZOOM_HALF);
        const hi = preset ? preset.hi : centre * (1 + ZOOM_HALF);
        plot.setRange(Math.max(SPECTRUM_LO_NM, lo * f), Math.min(SPECTRUM_HI_NM, hi * f), { animate: true });
        render();
        settleSoon();
        says.textContent = `${lampName(t.lamp)} lines, zoomed to ${t.label}`;
        plot.redraw();
    }

    function zoomWide() {
        if (api.resolved.entity.kind === 'quasar') plot.setRange(SPECTRUM_LO_NM, SPECTRUM_HI_NM, { animate: true });
        else plot.resetRange();
        says.textContent = 'Zoomed out';
    }

    // ---------- On the plot ----------

    // The lines in view, strongest first, leaving out any too close to a stronger one to tell apart
    function drawnLines() {
        const f = 1 + zNow();
        const out = [];
        for (const line of lines) {
            const nm = line.rest * f;
            if (!inView(nm)) continue;
            const x = plot.xOf(nm);
            if (out.some((o) => Math.abs(o.x - x) < 3)) continue;
            out.push({ line, x });
            if (out.length >= 40) break;
        }
        return out;
    }

    function gripY(pane) {
        return pane.y + pane.h * 0.66;
    }

    function draw(ctx) {
        if (!active || !lines.length) return;
        const theme = handTheme(plot);
        const pane = plot.panes().body;
        const shown = drawnLines();
        const main = mainLine();
        ctx.save();
        ctx.beginPath();
        ctx.rect(pane.x, pane.y, pane.w, pane.h);
        ctx.clip();
        ctx.strokeStyle = theme.ref;
        ctx.setLineDash(HAND_DASH);
        shown.forEach(({ line, x }) => {
            ctx.globalAlpha = line === main ? 1 : line.rel >= 0.1 ? 0.85 : 0.5;
            ctx.lineWidth = line === main ? 2 : 1.3;
            ctx.beginPath();
            ctx.moveTo(x, pane.y);
            ctx.lineTo(x, pane.y + pane.h);
            ctx.stroke();
        });
        ctx.restore();

        const z = zNow();
        const labelY = pane.y + plot.labelBand() + 11;
        // Where the main line was at rest, and how far it has come: the shift itself, as a distance on the plot
        if (main && z) {
            const restX = plot.xOf(main.rest);
            const nowX = plot.xOf(main.rest * (1 + z));
            const y = pane.y + pane.h - 9;
            const from = Math.max(pane.x, Math.min(pane.x + pane.w, restX));
            if (inView(main.rest * (1 + z)) && Math.abs(nowX - from) > 12) {
                ctx.save();
                ctx.strokeStyle = theme.ref;
                ctx.fillStyle = theme.ref;
                ctx.lineWidth = 1.6;
                if (inView(main.rest)) {
                    ctx.beginPath();
                    ctx.moveTo(restX, y - 7);
                    ctx.lineTo(restX, y + 7);
                    ctx.stroke();
                }
                const dir = nowX > from ? 1 : -1;
                ctx.beginPath();
                ctx.moveTo(from, y);
                ctx.lineTo(nowX - dir * 6, y);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(nowX, y);
                ctx.lineTo(nowX - dir * 7, y - 4);
                ctx.lineTo(nowX - dir * 7, y + 4);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
            }
        }
        // Names: the main line's, then any others that fit
        ctx.font = `700 11.5px ${theme.font}`;
        const taken = [];
        const named = shown.filter(({ line }) => line === main).concat(shown.filter(({ line }) => line !== main && line.rel >= 0.05));
        named.slice(0, 6).forEach(({ line, x }) => {
            const w = ctx.measureText(line.label).width + 8;
            const left = Math.max(pane.x + 3, Math.min(x - w / 2, pane.x + pane.w - w - 3));
            if (taken.some(([a, b]) => left < b + 4 && left + w > a - 4)) return;
            taken.push([left, left + w]);
            plotLabel(ctx, theme, line.label, x, labelY, { within: pane });
        });
        // What the lines are, top right, unless a name is there. A single line is named on itself.
        const key = single ? '' : `${lampName(target ? target.lamp : '')} lines`;
        const keyW = ctx.measureText(key).width + 8;
        const keyLeft = pane.x + pane.w - keyW - 3;
        if (!key) {
            // Nothing to say
        } else if (!taken.some(([a, b]) => keyLeft < b + 4 && keyLeft + keyW > a - 4)) plotLabel(ctx, theme, key, pane.x + pane.w - 6, labelY, { align: 'right', bold: false });
        else plotLabel(ctx, theme, key, pane.x + pane.w - 6, labelY + 18, { align: 'right', bold: false });
        if (main && inView(main.rest * (1 + z))) {
            drawGrip(ctx, theme, plot.xOf(main.rest * (1 + z)), gripY(pane), { focused: !!drag });
        }
    }

    function hit(x, y, e) {
        if (!active || !lines.length) return null;
        const pane = plot.panes().body;
        if (y < pane.y - 4 || y > pane.y + pane.h + 4 || x < pane.x - 6 || x > pane.x + pane.w + 6) return null;
        const reach = reachOf(e);
        const main = mainLine();
        if (main && inView(main.rest * (1 + zNow()))) {
            const gx = plot.xOf(main.rest * (1 + zNow()));
            if (Math.hypot(x - gx, y - gripY(pane)) <= reach + 4) return main;
        }
        let best = null;
        let bestD = Math.max(7, reach * 0.6);
        drawnLines().forEach(({ line, x: lx }) => {
            const d = Math.abs(lx - x);
            if (d <= bestD) {
                best = line;
                bestD = d;
            }
        });
        return best;
    }

    const removeOverlay = plot.addOverlay(draw);
    const offGrab = plotGrab(plot, {
        hit,
        start(line, x) {
            grabbed = line;
            drag = { line, offset: x - plot.xOf(line.rest * (1 + zNow())) };
            plot.redraw();
        },
        move(x) {
            if (!drag) return;
            // Past the edge of the plot too, so a line near the edge can still be pushed on
            const nm = plot.nmOf(x - drag.offset);
            if (nm > 1) setZ(nm / drag.line.rest - 1);
        },
        end() {
            drag = null;
            settleSoon();
            plot.redraw();
        }
    });
    // A new zoom changes how finely the lines can be set, so the uncertainty follows it
    const offRange = plot.onRangeChange(() => {
        if (!active) return;
        render();
        settleSoon();
    });

    // Zooms to show both where the best line is at rest and where the object's own line is, with room either side
    function frameBest(animate) {
        const line = lines[0];
        if (!line) return;
        framedBest = api.resolved.entity.code;
        const a = Math.min(line.rest, line.obs);
        const b = Math.max(line.rest, line.obs);
        const room = Math.max(0.004, (3 * line.fwhm) / line.obs, 0.1 * (b / a - 1));
        plot.setRange(Math.max(SPECTRUM_LO_NM, a * (1 - room)), Math.min(SPECTRUM_HI_NM, b * (1 + room)), { animate: animate && !reduceMotion() });
        says.textContent = `Zoomed to ${line.label}. Drag the dashed line onto the object's line.`;
    }

    return {
        enter() {
            active = true;
            if (single) {
                if (framedBest !== api.resolved.entity.code) frameBest(true);
            } else if (api.resolved && api.resolved.entity.kind === 'quasar' && framedQuasar !== api.resolved.entity.code) {
                // A quasar's lines are spread across the whole range, and the whole pattern slides
                framedQuasar = api.resolved.entity.code;
                plot.setRange(SPECTRUM_LO_NM, SPECTRUM_HI_NM, { animate: !reduceMotion() });
            }
            useKey = '';
            render();
            settleSoon();
            plot.redraw();
        },
        leave() {
            active = false;
            clearTimeout(settleTimer);
            plot.redraw();
        },
        setEntity(resolved) {
            scale = scaleFor(resolved.entity);
            slider.max = String(scale.positions);
            slider.value = String(scale.pos(zNow()));
            useKey = '';
            if (single) {
                const best = bestLineFor(api.getOverview(), { broad: resolved.entity.kind === 'quasar' });
                lines = best ? [best] : [];
                grabbed = best;
                width = null;
                none.hidden = !!best;
                sliderRow.hidden = !best;
                ends.hidden = !best;
                if (active) {
                    if (best) frameBest(false);
                    render();
                    settleSoon();
                }
                plot.redraw();
                return;
            }
            targets = targetsFor(resolved.entity, api.getOverview());
            const t = TARGETS.find((x) => x.id === targets.first);
            useLamp(t);
            hint.textContent = (api.getOverview() || {}).mode === 'emission' ? 'Drag the dashed lines onto the bright lines.' : 'Drag the dashed lines onto the dips.';
            renderTargets();
            if (active) {
                if (resolved.entity.kind === 'quasar' && framedQuasar !== resolved.entity.code) {
                    framedQuasar = resolved.entity.code;
                    plot.setRange(SPECTRUM_LO_NM, SPECTRUM_HI_NM);
                }
                render();
                settleSoon();
            }
            plot.redraw();
        },
        dispose() {
            clearTimeout(settleTimer);
            removeOverlay();
            offGrab();
            offRange();
        }
    };
}
