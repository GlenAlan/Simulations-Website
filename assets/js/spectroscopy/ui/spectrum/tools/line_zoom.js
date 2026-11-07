// Spin, by hand. The tool picks a line and zooms in on it. Over the star's own line it lays the same line from the same star
// with no spin, dashed, and the student widens that line by spinning it (a slider, or its grip on the plot) until the two match.
// The reading is what they set: "Spin: 45 km/s", and the width that gives. Check shows what the line's own shape measures, with
// its uncertainty and the working, as a check and not a mark. Widths are kept through the session so stars can be compared:
// a giant's lines are narrower than a dwarf's of the same class (pressure), and a fast spinner's wider than a slow one's.
//
// Objects that aren't stars have no still twin to compare with: their line is zoomed to and its measured width shown.

import { registerTool } from './index.js';
import { app } from '../../../core/state.js';
import { C_KMS, R_ZOOM, R_OVERVIEW } from '../../../core/phys.js';
import { lineWidth, lineZoomWindow, hasLongWings, suggestRotationLines, resolvingPower, rotationLimitKms, ROTATION_FWHM, FASTEST_SPIN_KMS } from '../../../spectra/measure.js';
import { gridFor } from '../../../spectra/kernel.js';
import { renderStars, starPartsOf } from '../../../spectra/stellar.js';
import { el } from '../../plot2d.js';
import { actionRow, fill, overlayTheme, para, plotLabel, resultLine, searchNmAt, statusBox } from './common.js';
import { borrowReference, drawGrip, handTheme, HAND_DASH, plotGrab, reachOf } from './hands_on.js';

// The lines a giant and a dwarf differ in most: pressure sets their width. Named so that every star offers the same ones.
const PRESSURE_LINES = ['Hα', 'Na D₂', 'Ca II K'];
const SPIN_RULES_FROM_KMS = 100;
const MOST_SPIN_KMS = 400;
const SLIDER_STEPS = 1000;
const LIMB = 0.6;                 // Limb darkening, as the star's own lines are made with
const RECORD_AFTER_MS = 700;

// Widths last the session and outlive a change of selection, so that the next star's line can be set beside them
const history = [];
let lastLine = null;             // { rest_nm, label }

function kmsText(v) {
    return v < 10 ? v.toFixed(1) : String(Math.round(v));
}

// To one decimal below 100 km/s, so that a sum set out with these numbers comes out right on a calculator
function sumText(v) {
    return v < 100 ? v.toFixed(1) : String(Math.round(v));
}

function shortName(line) {
    return String(line.label || line.species || 'Line').replace(/\s*\d+(\.\d+)?$/, '') || 'Line';
}

function lineName(line) {
    return `${shortName(line)} ${line.rest_nm.toFixed(1)} nm`;
}

// Spin on the slider: fine steps at the slow end, where most stars are
const spinOf = (s) => MOST_SPIN_KMS * (s / SLIDER_STEPS) ** 2;
const sliderOf = (v) => Math.round(SLIDER_STEPS * Math.sqrt(Math.max(0, v) / MOST_SPIN_KMS));

// ---------- The measured reading, as the check ----------

// The sum from a line's width to a speed, in the numbers as shown, so that it gives the answer as shown
function spinSum(w) {
    const width = Number(sumText(w.fwhm_kms));
    const base = Number(sumText(w.base_kms));
    const spread = Math.sqrt(Math.max(0, width * width - base * base));
    return { width, base, spread: Number(sumText(spread)), spin: Number(sumText(spread)) / ROTATION_FWHM };
}

// Whether pressure rules this line in this star. Hydrogen and Ca II H and K's always does; a stronger line such as helium's or
// sodium's can be so widened by a fast spin that pressure hardly counts. A line nobody has named goes by its shape.
function pressureRules(w, identified) {
    const spinWidth = ROTATION_FWHM * w.velocity_kms;
    if (!identified) return w.pressure_kms > 2 * spinWidth;
    if (!hasLongWings(identified)) return false;
    const always = identified.species === 'H I' || identified.species === 'Ca II';
    return always || w.fwhm_kms < SPIN_RULES_FROM_KMS || spinWidth < 0.7 * w.fwhm_kms;
}

// What a line says about rotation. A line that pressure widens gives only an upper limit, and a limit past anything a star
// could do isn't a reading of its spin at all.
function spinReading(w, winged) {
    if (winged) {
        const most = w.velocity_kms + 2 * w.err_kms;
        if (most >= FASTEST_SPIN_KMS) return { kind: 'too wide' };
        if (most < w.limit_kms) return { kind: 'unresolved' };
        return { kind: 'limit', value: most };
    }
    if (w.noReading) return { kind: 'noisy' };
    if (w.unresolved) return { kind: 'unresolved' };
    const { spin } = spinSum(w);
    if (spin >= FASTEST_SPIN_KMS) return { kind: 'too wide' };
    return { kind: 'value', value: spin, err: Math.max(w.err_kms, 0.5) };
}

function rotationText(w, reading) {
    switch (reading.kind) {
    case 'noisy': return 'Measured: too noisy to read spin from this line';
    case 'too wide': return 'Measured: too wide to be spin alone';
    case 'unresolved': return `Measured: spin under ${Math.round(w.limit_kms)} km/s, too small to see`;
    case 'limit': return `Measured: spin at most ${kmsText(reading.value)} km/s, as pressure widens this line too`;
    default: return `Measured: spin ${kmsText(reading.value)} ± ${kmsText(reading.err)} km/s`;
    }
}

function workingText(w, reading) {
    if (reading.kind !== 'value') return null;
    const { width, base, spread, spin } = spinSum(w);
    return `The line is ${sumText(width)} km/s wide; without spin it would be about ${sumText(base)}. √(${sumText(width)}² − ${sumText(base)}²) = ${sumText(spread)} km/s, and spin makes a line ${ROTATION_FWHM} × v sin i wide: ${sumText(spread)} ÷ ${ROTATION_FWHM} = ${kmsText(spin)} km/s.`;
}

// ---------- The same star, not spinning ----------

const stillStars = new WeakMap();
function stillStar(star) {
    let still = stillStars.get(star);
    if (!still) {
        still = { ...star, vsini_kms: 0 };
        stillStars.set(star, still);
    }
    return still;
}

// The stars behind an entity, with their spin taken away and nothing else changed, rendered without noise over lo..hi
function stillTwin(entity, bodyOpts, lo, hi, R) {
    const parts = starPartsOf(entity, { t: bodyOpts.t, parts: bodyOpts.parts });
    if (!parts.length) return null;
    const grid = gridFor(lo, hi, R);
    const out = renderStars(parts.map((part) => ({ ...part, star: stillStar(part.star) })), grid);
    const ratio = new Float64Array(grid.n);
    for (let i = 0; i < grid.n; i++) ratio[i] = out.continuum[i] > 0 ? out.flux[i] / out.continuum[i] : 1;
    return { wl: grid.wl, continuum: out.continuum, ratio, dv: grid.dvPix, R, lo, hi };
}

// The rotation profile: a star's disc, one side coming and one going, darker towards its edge
const kernels = new Map();
function spinKernel(v, dv) {
    const half = Math.floor(v / dv);
    const key = `${half}|${(v / dv).toFixed(2)}`;
    let k = kernels.get(key);
    if (k) return k;
    const out = new Float64Array(2 * half + 1);
    let sum = 0;
    for (let j = -half; j <= half; j++) {
        const x = (j * dv) / v;
        const g = x * x >= 1 ? 0 : 2 * (1 - LIMB) * Math.sqrt(1 - x * x) + (Math.PI * LIMB / 2) * (1 - x * x);
        out[j + half] = g;
        sum += g;
    }
    for (let j = 0; j < out.length; j++) out[j] /= sum;
    k = { half, weights: out };
    if (kernels.size > 400) kernels.clear();
    kernels.set(key, k);
    return k;
}

function spunRatio(twin, v, into) {
    const n = twin.ratio.length;
    if (v < 0.75 * twin.dv) {
        into.set(twin.ratio);
        return into;
    }
    const { half, weights } = spinKernel(v, twin.dv);
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = -half; j <= half; j++) s += weights[j + half] * twin.ratio[Math.max(0, Math.min(n - 1, i + j))];
        into[i] = s;
    }
    return into;
}

function isStarLike(entity) {
    return !!(entity.star || entity.stars || entity.black_hole);
}

const WIDTH_MEANS = {
    galaxy: 'Stars moving about inside the galaxy smear every line.',
    quasar: 'Gas whirling round the central black hole spreads these lines out.',
    supernova: 'Gas thrown out by the explosion moves at a huge range of speeds.',
    nebula: 'The gas in the nebula moving about, and its heat, widen this line.'
};

function mount(container, api) {
    const { plot } = api;
    const reduceMotion = () => !!(app.settings && app.settings.reduceMotion);

    // ---------- Building it ----------

    const chips = el('div', { class: 'spectro-hands-chips', role: 'group', 'aria-label': 'Line' });
    const answer = el('p', { class: 'spectro-tool-answer' });
    const widthLine = el('p', { class: 'spectro-tool-line' });
    const hint = para('Widen the dashed line until it matches.');
    const slider = el('input', { type: 'range', class: 'spectro-hands-big', min: '0', max: String(SLIDER_STEPS), step: '1', value: '0', 'aria-label': 'Spin of the dashed line' });
    const ends = el('div', { class: 'spectro-hands-ends', 'aria-hidden': 'true' }, el('span', { text: 'No spin' }), el('span', { text: 'Faster →' }));
    const sliderBox = el('div', { class: 'spectro-hands-pane' }, slider, ends);
    const checkBox = el('div', { class: 'spectro-hands-use' });
    const result = statusBox();
    const historyEl = el('div', { class: 'spectro-tool-measured', hidden: true });
    const says = el('p', { class: 'spectro-sr-only', role: 'status' });
    container.append(chips, answer, widthLine, hint, sliderBox, checkBox, result, historyEl, says);

    const started = plot.getRange();
    // The dashed line is the comparison here, so the reference stands aside and the star's line has the whole plot, with the
    // flux axis fitted to it: a fast spinner's line is shallow, and from zero it would lie almost flat
    const reference = borrowReference(api);
    reference.show('none');
    if (plot.setFitFloor) plot.setFitFloor(true);
    let line = null;          // The line on show: { rest_nm, obs_nm, label, species }
    let twin = null;          // The still twin over the view
    let spun = null;          // Its ratio, spun to the student's speed
    let spin = 0;             // What the student has set
    let touched = false;
    let shape = null;         // Where the spun line sits: { centre, depthNm, halfKms }
    let measured = null;      // The line's own measured width, once asked for
    let recordTimer = 0;
    let drag = null;

    // ---------- Choosing the line ----------

    function same(a, b) {
        return Math.abs(a.rest_nm - b.rest_nm) < 0.05;
    }

    // For a star: the line that shows its spin best, and the three that show its density best, by name. For anything else:
    // its strongest lines.
    function offered() {
        const overview = api.getOverview();
        const atoms = ((overview && overview.lines) || []).filter((l) => !l.band);
        const { entity } = api.resolved;
        const list = [];
        const add = (l) => { if (l && !list.some((x) => same(x, l))) list.push(l); };
        // The line on show, such as one carried over from the last star, is always among them
        if (line) add(atoms.find((l) => same(l, line)));
        if (isStarLike(entity)) {
            suggestRotationLines(overview || {}, 1).forEach(add);
            PRESSURE_LINES.forEach((label) => add(atoms.find((l) => l.label === label)));
        } else {
            atoms.filter((l) => l.obs_nm > 330).sort((a, b) => Math.abs(b.depth) - Math.abs(a.depth)).slice(0, 3).forEach(add);
        }
        return list;
    }

    function renderChips(list) {
        chips.replaceChildren(...list.map((l) => el('button', {
            type: 'button',
            class: 'spectro-hands-chip',
            'aria-pressed': line && same(line, l) ? 'true' : 'false',
            text: shortName(l),
            'aria-label': `${lineName(l)}: zoom in on it`,
            onclick: () => choose(l)
        })));
        chips.hidden = list.length < 2;
    }

    function choose(l, { quiet = false } = {}) {
        line = l;
        lastLine = { rest_nm: l.rest_nm, label: l.label };
        measured = null;
        widthKms = null;
        checkKey = '';
        const overview = api.getOverview();
        const view = lineZoomWindow(overview, l.obs_nm, { line: l, searchNm: l.obs_nm * 0.0015, hydrogen: l.species === 'H I' });
        if (view) api.setResolution('zoom', { lo_nm: view.centre_nm - view.half_nm, hi_nm: view.centre_nm + view.half_nm });
        twin = null;
        renderChips(offered());
        render();
        if (!quiet) says.textContent = `${lineName(l)}. Widen the dashed line until it matches.`;
        plot.redraw();
    }

    // ---------- The still twin and its spin ----------

    function ensureTwin() {
        const { entity } = api.resolved;
        if (!line || !isStarLike(entity)) return null;
        const { lo, hi } = plot.getRange();
        const spectrum = api.getSpectrum();
        const R = spectrum && resolvingPower(spectrum) > 20000 ? R_ZOOM : R_OVERVIEW;
        if (twin && twin.R === R && twin.lo <= lo && twin.hi >= hi) return twin;
        const margin = (hi / lo) ** 0.5;
        try {
            twin = stillTwin(entity, api.getBodyOpts(), lo / margin, hi * margin, R);
        } catch (err) {
            console.error('[spectroscopy] spin reference:', err);
            twin = null;
        }
        spun = twin ? new Float64Array(twin.ratio.length) : null;
        if (twin) spunRatio(twin, spin, spun);
        shape = null;
        return twin;
    }

    function indexOf(nm) {
        const { wl } = twin;
        const i = Math.round(Math.log(nm / wl[0]) / Math.log(wl[1] / wl[0]));
        return Math.max(0, Math.min(wl.length - 1, i));
    }

    // The spun line's middle, depth and half width at half depth, from the profile as drawn
    function measureShape() {
        if (!twin || !line) return null;
        const c = indexOf(line.obs_nm);
        const reach = Math.max(4, Math.round((Math.max(60, 2.5 * spin) / twin.dv)));
        let at = c;
        for (let i = Math.max(0, c - reach); i <= Math.min(spun.length - 1, c + reach); i++) if (spun[i] < spun[at]) at = i;
        const depth = 1 - spun[at];
        if (!(depth > 0.005)) return null;
        const level = 1 - depth / 2;
        let l = at;
        while (l > 0 && spun[l] < level) l--;
        let r = at;
        while (r < spun.length - 1 && spun[r] < level) r++;
        const halfKms = 0.5 * (r - l) * twin.dv;
        return { centre: twin.wl[at], depth, halfKms };
    }

    // The dashed line's width, measured exactly as Check measures the star's own line, so that the two can be compared. It
    // takes a moment, so it waits until the line stops moving.
    let widthKms = null;
    let widthTimer = 0;
    function measureWidthSoon() {
        clearTimeout(widthTimer);
        widthTimer = setTimeout(() => {
            if (!twin || !shape) return;
            const flux = new Float64Array(spun.length);
            for (let i = 0; i < flux.length; i++) flux[i] = spun[i] * twin.continuum[i];
            const w = lineWidth({ wl: twin.wl, flux, snr: Infinity, mode: 'absorption' }, shape.centre, { searchNm: shape.centre * 0.0006, hydrogen: line.species === 'H I' });
            widthKms = w ? w.fwhm_kms : false;
            render();
        }, 150);
    }

    const widthWords = () => (widthKms === null ? '…' : widthKms === false ? 'too faint to' : `${kmsText(widthKms)} km/s`);

    function setSpin(v, { from = 'slider' } = {}) {
        spin = Math.max(0, Math.min(MOST_SPIN_KMS, v));
        touched = true;
        if (from !== 'slider') slider.value = String(sliderOf(spin));
        if (twin) spunRatio(twin, spin, spun);
        shape = null;
        widthKms = null;
        render();
        plot.redraw();
        measureWidthSoon();
        clearTimeout(recordTimer);
        recordTimer = setTimeout(record, RECORD_AFTER_MS);
    }

    slider.addEventListener('input', () => setSpin(spinOf(Number(slider.value))));

    // ---------- Reading ----------

    function limitKms() {
        const spectrum = api.getSpectrum();
        return rotationLimitKms(spectrum ? resolvingPower(spectrum) : R_ZOOM);
    }

    function spinText() {
        const limit = limitKms();
        return spin < limit ? `Spin: under ${Math.round(limit)} km/s` : `Spin: ${kmsText(spin)} km/s`;
    }

    function render() {
        const { entity } = api.resolved;
        const star = isStarLike(entity);
        sliderBox.hidden = !star || !line;
        hint.hidden = !star || !line || touched;
        if (!line) {
            answer.textContent = '';
            widthLine.textContent = '';
            fill(result, para('No clear line here to zoom in on.'));
            checkBox.replaceChildren();
            return;
        }
        if (!star) {
            renderMeasured();
            answer.textContent = '';
            widthLine.textContent = '';
            checkBox.replaceChildren();
            return;
        }
        const before = twin;
        ensureTwin();
        if (!shape) shape = measureShape();
        if (twin !== before || (widthKms === null && shape)) measureWidthSoon();
        answer.textContent = spinText();
        widthLine.textContent = widthKms === false ? '' : `${shortName(line)}: ${widthWords()} wide`;
        slider.setAttribute('aria-valuetext', `${spinText()}${typeof widthKms === 'number' ? `, ${kmsText(widthKms)} km/s wide` : ''}`);
        renderCheck();
    }

    let checkKey = '';
    function renderCheck() {
        const key = `${!!measured}|${touched}`;
        if (key === checkKey) return;
        checkKey = key;
        if (measured) {
            checkBox.replaceChildren();
            renderMeasured();
            return;
        }
        result.replaceChildren();
        fill(checkBox, touched ? actionRow(el('button', {
            type: 'button',
            class: 'spectro-tool-next',
            text: 'Check',
            title: 'What the line\'s own shape measures',
            onclick: () => {
                measure();
                checkKey = '';
                render();
            }
        })) : null);
    }

    // The line's own measured width, and what it says: the reading the tool worked out for itself
    function measure() {
        const spectrum = api.getSpectrum();
        if (!spectrum || !line) return;
        const near = shape ? shape.centre : line.obs_nm;
        measured = lineWidth(spectrum, near, { searchNm: near * 0.0006, hydrogen: line.species === 'H I' });
        if (!measured) measured = { none: true };
    }

    function renderMeasured() {
        const { entity } = api.resolved;
        if (!isStarLike(entity) && !measured) measure();
        if (!measured || measured.none) {
            fill(result, para(`${line ? lineName(line) : 'This line'} doesn't stand clear of the noise here. Try another line, or a brighter object.`));
            return;
        }
        const w = measured;
        if (!isStarLike(entity)) {
            const spread = 0.5 * Math.sqrt(Math.max(0, w.fwhm_kms ** 2 - w.instrument_kms ** 2));
            fill(result,
                resultLine(`Spread of speeds: about ±${kmsText(spread)} km/s`, true),
                resultLine(`${kmsText(w.fwhm_kms)} km/s wide: v ≈ c × half-width ÷ λ₀`),
                para(WIDTH_MEANS[entity.kind] || 'A line this wide means its source is moving at a range of speeds along your line of sight.'));
            return;
        }
        const reading = spinReading(w, pressureRules(w, line));
        const working = workingText(w, reading);
        fill(result,
            resultLine(rotationText(w, reading)),
            resultLine(`Measured width: ${kmsText(w.fwhm_kms)} km/s`),
            working ? para(working) : null);
        says.textContent = rotationText(w, reading);
    }

    // ---------- Widths so far ----------

    function record() {
        if (!line || !touched || typeof widthKms !== 'number') {
            if (line && touched && widthKms === null) recordTimer = setTimeout(record, RECORD_AFTER_MS);
            return;
        }
        const code = api.resolved.entity.code;
        const entry = { code, line: shortName(line), width: widthKms, spin: spin < limitKms() ? `< ${Math.round(limitKms())}` : kmsText(spin) };
        const at = history.findIndex((h) => h.code === code && h.line === entry.line);
        if (at >= 0) history[at] = entry;
        else history.push(entry);
        if (history.length > 10) history.shift();
        renderHistory();
    }

    function renderHistory() {
        historyEl.replaceChildren();
        historyEl.hidden = history.length < 2;
        if (historyEl.hidden) return;
        const code = api.resolved.entity.code;
        historyEl.append(
            el('table', { class: 'spectro-tool-table' },
                el('caption', { text: 'Your widths so far' }),
                el('thead', {}, el('tr', {},
                    el('th', { scope: 'col', text: 'Object' }),
                    el('th', { scope: 'col', text: 'Line' }),
                    el('th', { scope: 'col', text: 'Width (km/s)' }),
                    el('th', { scope: 'col', text: 'Spin (km/s)' }))),
                el('tbody', {}, ...history.map((h) => el('tr', { class: h.code === code ? 'is-current' : undefined },
                    el('td', { text: h.code }),
                    el('td', { text: h.line }),
                    el('td', { text: kmsText(h.width) }),
                    el('td', { text: h.spin }))))),
            actionRow(el('button', {
                type: 'button',
                class: 'spectro-tool-next',
                text: 'Clear the list',
                onclick: () => {
                    history.length = 0;
                    renderHistory();
                }
            }))
        );
    }

    // ---------- On the plot ----------

    function gripAt() {
        if (!shape) return null;
        const pane = plot.panes().body;
        let x = plot.xOf(shape.centre * (1 + shape.halfKms / C_KMS));
        const cont = twin.continuum[indexOf(shape.centre)];
        let y = plot.yOf(cont * (1 - shape.depth / 2));
        // The axis fits the star's own line, so a still twin deeper than that runs out of the bottom: the grip goes where
        // its side comes into view
        const low = pane.y + pane.h - 10;
        if (y > low) {
            for (let i = indexOf(shape.centre); i < spun.length; i++) {
                const yi = plot.yOf(spun[i] * twin.continuum[i]);
                if (yi <= low) {
                    x = plot.xOf(twin.wl[i]);
                    y = yi;
                    break;
                }
            }
        }
        if (x < pane.x || x > pane.x + pane.w || y < pane.y || y > pane.y + pane.h) return null;
        return { x, y };
    }

    const removeOverlay = plot.addOverlay((ctx) => {
        const { entity } = api.resolved || {};
        if (!entity || !line) return;
        const pane = plot.panes().body;
        if (!isStarLike(entity)) {
            if (!measured || measured.none) return;
            drawWidthBar(ctx, measured);
            return;
        }
        if (!ensureTwin()) return;
        if (!shape) shape = measureShape();
        const theme = handTheme(plot);
        const n = twin.wl.length;
        ctx.save();
        ctx.beginPath();
        ctx.rect(pane.x, pane.y, pane.w, pane.h);
        ctx.clip();
        ctx.strokeStyle = theme.ref;
        ctx.lineWidth = 2;
        ctx.setLineDash(HAND_DASH);
        ctx.beginPath();
        let pen = false;
        const across = Math.max(40, Math.round(pane.w));
        for (let k = 0; k <= across; k++) {
            const x = pane.x + (k / across) * pane.w;
            const nm = plot.nmOf(x);
            const f = Math.log(nm / twin.wl[0]) / Math.log(twin.wl[1] / twin.wl[0]);
            if (f < 0 || f > n - 1) { pen = false; continue; }
            const i = Math.floor(f);
            const u = f - i;
            const j = Math.min(n - 1, i + 1);
            const value = (spun[i] + (spun[j] - spun[i]) * u) * (twin.continuum[i] + (twin.continuum[j] - twin.continuum[i]) * u);
            const y = plot.yOf(value);
            if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
        const grip = gripAt();
        if (grip) {
            drawGrip(ctx, theme, grip.x, grip.y, { focused: !!drag });
            const right = grip.x < pane.x + pane.w * 0.7;
            plotLabel(ctx, theme, spin < limitKms() ? 'No spin' : `${kmsText(spin)} km/s`, grip.x + (right ? 15 : -15), grip.y, { align: right ? 'left' : 'right', within: pane });
        }
        if (measured && !measured.none) drawWidthBar(ctx, measured);
    });

    // The measured width as a bar across the line at half depth, once Check has been pressed
    function drawWidthBar(ctx, w) {
        const theme = overlayTheme(plot);
        const pane = plot.panes().body;
        const half = w.fwhm_nm / 2;
        const sign = w.type === 'em' ? 1 : -1;
        const y = plot.yOf(w.continuum + (sign * w.height) / 2);
        if (y < pane.y || y > pane.y + pane.h) return;
        const x1 = plot.xOf(w.centre_nm - half);
        const x2 = plot.xOf(w.centre_nm + half);
        ctx.save();
        ctx.strokeStyle = theme.mark;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        [x1, x2].forEach((x) => { ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); });
        ctx.stroke();
        ctx.restore();
        plotLabel(ctx, theme, `measured ${kmsText(w.fwhm_kms)} km/s`, 0.5 * (x1 + x2), Math.min(pane.y + pane.h - 10, y + 15), { within: pane });
    }

    // The grip, or anywhere along the dashed line's sides: dragging away from its middle spins it faster
    function hit(x, y, e) {
        const { entity } = api.resolved || {};
        if (!entity || !isStarLike(entity) || !twin || !shape) return null;
        const reach = reachOf(e);
        const grip = gripAt();
        if (grip && Math.hypot(x - grip.x, y - grip.y) <= reach + 4) return true;
        const pane = plot.panes().body;
        if (x < pane.x || x > pane.x + pane.w) return null;
        const cx = plot.xOf(shape.centre);
        if (Math.abs(x - cx) < 4) return null;
        const i = indexOf(plot.nmOf(x));
        const yc = plot.yOf(spun[i] * twin.continuum[i]);
        // Only on the line itself, not the flat continuum either side of it
        return Math.abs(y - yc) <= reach && 1 - spun[i] > 0.15 * shape.depth ? true : null;
    }

    function kmsPerPx(x) {
        const nm = plot.nmOf(x);
        return (Math.abs(plot.nmOf(x + 1) - nm) / nm) * C_KMS;
    }

    const offGrab = plotGrab(plot, {
        hit,
        start(what, x) {
            drag = { x0: x, spin0: spin, cx: plot.xOf(shape.centre) };
            plot.redraw();
        },
        move(x) {
            if (!drag) return;
            // A spun line's half width at half depth is about 0.8 of its speed, plus what it had without spin
            const moved = (Math.abs(x - drag.cx) - Math.abs(drag.x0 - drag.cx)) * kmsPerPx(x);
            setSpin(drag.spin0 + moved / 0.8, { from: 'drag' });
        },
        end(x, y, e, moved) {
            drag = null;
            if (moved) says.textContent = spinText();
            plot.redraw();
        }
    });

    // A click on another line zooms to it
    const offClick = plot.onClick((nm, e) => {
        if (drag) return;
        const overview = api.getOverview();
        const searchNm = searchNmAt(plot, nm, e);
        const near = ((overview && overview.lines) || []).filter((l) => !l.band).reduce((best, l) => (!best || Math.abs(l.obs_nm - nm) < Math.abs(best.obs_nm - nm) ? l : best), null);
        if (near && Math.abs(near.obs_nm - nm) < Math.max(searchNm * 3, nm * 0.0005) && !(line && same(near, line))) choose(near);
    });

    // A new spectrum (time, stars shown) or a new zoom needs a new twin
    const offOpts = api.onBodyOpts(() => {
        twin = null;
        shape = null;
        measured = null;
        widthKms = null;
        checkKey = '';
        plot.redraw();
    });

    return {
        setEntity() {
            touched = false;
            spin = 0;
            slider.value = '0';
            twin = null;
            shape = null;
            measured = null;
            widthKms = null;
            checkKey = '';
            api.setResolution('zoom');
            // The same line as on the last star, so the two can be compared, if this one shows it
            const again = lastLine ? ((api.getOverview() || {}).lines || []).find((l) => !l.band && same(l, lastLine)) : null;
            const first = again || offered()[0] || null;
            line = first;
            renderChips(offered());
            if (first) choose(first, { quiet: true });
            else {
                line = null;
                render();
            }
            renderHistory();
            plot.redraw();
        },
        dispose() {
            clearTimeout(recordTimer);
            offClick();
            offGrab();
            offOpts();
            removeOverlay();
            reference.dispose();
            if (plot.setFitFloor) plot.setFitFloor(false);
            api.setResolution('overview');
            plot.setRange(started.lo, started.hi, { animate: !reduceMotion() });
        }
    };
}

registerTool({
    id: 'line-zoom',
    label: 'Spin',
    draws: true,
    appliesTo: () => true,
    mount
});
