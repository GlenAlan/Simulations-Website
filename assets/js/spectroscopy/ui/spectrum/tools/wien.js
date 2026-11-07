// How hot? The student works the temperature out from the spectrum, three ways, one at a time:
//   Fit a curve     lay a black-body curve over the spectrum and drag it, or its slider, until the shapes match
//   Standard stars  lay standard stars over it in turn, and find the one with the same dips
//   Wien's law      mark the top of the curve; lambda max is read where the mark is, T = b / lambda max follows with its working,
//                   and the curve that peaks there is drawn over the light, so a mark off the top shows as a curve that doesn't fit
// Each reading is what the student set or marked, and nothing says whether it is right. "Use this temperature" sends it on
// to the H-R diagram, saying where it came from. Light of more than one star is a blend, and says so.

import { registerTool } from './index.js';
import { recordMeasurement, getMeasurement } from '../../../core/measurements.js';
import { C_KMS, WIEN_B, SPECTRUM_LO_NM, SPECTRUM_HI_NM } from '../../../core/phys.js';
import { plusMinus, sci, sig, withCommas } from '../../../core/format.js';
import { STANDARDS, STANDARD_LABELS } from '../../../data/standards.js';
import { wienPeak, wienCurveAt } from '../../../spectra/measure.js';
import { topEdge, curveScale, curveAt, fitError, markOnPeak, markReading } from '../../../spectra/hand_fit.js';
import { el } from '../../plot2d.js';
import { actionRow, diagramLink, fill, hasTab, para, plotLabel, resultLine, statusBox, steps, toolLink } from './common.js';
import { borrowReference, drawGrip, handTheme, HAND_DASH, modeRow, plotGrab, reachOf } from './hands_on.js';

const BODY_KINDS = ['star', 'binary', 'multiple', 'black_hole', 'supernova', 'neutron_star'];
const WIEN_NM_K = WIEN_B * 1e9;

function applies(resolved) {
    if (resolved.path === 'member' || resolved.path === 'component') return true;
    return resolved.path === 'body' && BODY_KINDS.includes(resolved.body.kind);
}

const MODES = [
    { id: 'fit', label: 'Fit a curve' },
    { id: 'standards', label: 'Standard stars' },
    { id: 'peak', label: 'Wien\'s law' }
];

// The whole curve for fitting and for finding its top; the visible for comparing lines. Fixed, so they say nothing about the star.
const FULL_VIEW = { lo: SPECTRUM_LO_NM, hi: SPECTRUM_HI_NM };
const OPENING_VIEWS = { fit: FULL_VIEW, standards: { lo: 380, hi: 750 }, peak: FULL_VIEW };

// Kept from one object to the next, as an instrument would be: the mode, where the curve was, the views
const memory = { mode: 'fit', T: 10000, views: {}, standard: null };

// ---------- The curve's temperature, on a slider that is logarithmic as temperatures are far apart at the hot end ----------

const T_MIN = 1000;
const T_MAX = 150000;
const T_STEPS = 1000;

function roundT(T) {
    const step = T < 10000 ? 10 : 100;
    return Math.min(T_MAX, Math.max(T_MIN, Math.round(T / step) * step));
}

function sliderOf(T) {
    return Math.round((T_STEPS * Math.log(T / T_MIN)) / Math.log(T_MAX / T_MIN));
}

function tOf(s) {
    return roundT(T_MIN * (T_MAX / T_MIN) ** (s / T_STEPS));
}

// ---------- Standard stars ----------

const CLASSES = ['O', 'B', 'A', 'F', 'G', 'K', 'M'];
const MAIN_SEQUENCE = ['O5', 'B0', 'B5', 'A0', 'A5', 'F0', 'F5', 'G2', 'G8', 'K0', 'K5', 'M0', 'M5'];
const OTHERS = [{ id: 'DA', label: 'White dwarf' }, { id: 'RG', label: 'Red giant' }];
const STEP_ORDER = [...MAIN_SEQUENCE, 'DA', 'RG'];

// Half the gap to the next standard either side: a match is only as fine as the list of standards
function standardError(id) {
    const list = Object.values(STANDARDS).map((s) => s.teff_K).sort((a, b) => a - b);
    const T = STANDARDS[id].teff_K;
    const at = list.indexOf(T);
    const gaps = [];
    if (at > 0) gaps.push(T - list[at - 1]);
    if (at < list.length - 1) gaps.push(list[at + 1] - T);
    return Math.max(...gaps) / 2;
}

function standardName(id) {
    return MAIN_SEQUENCE.includes(id) ? id : STANDARD_LABELS[id];
}

// ---------- Where each reading came from, as the H-R diagram says it ----------

const SOURCE_WORDS = { fit: 'your fitted curve', standard: 'a standard star', wien: 'Wien\'s law', reference: 'the reference match' };

function partCount(api) {
    const { parts } = api.getBodyOpts();
    if (parts && parts.length) return parts.length;
    const { entity } = api.resolved;
    return entity.stars ? entity.stars.length : 1;
}

function mount(container, api) {
    const { plot } = api;
    const reference = borrowReference(api);
    const opened = plot.getRange();
    let openedCode = null;

    let mode = null;
    let edge = null;          // The top of the spectrum, for laying the curve on
    let peak = null;          // wienPeak's answer: only whether there is a peak in range, and which way the light still rises
    let blend = 1;            // How many stars' light this is
    let pending = 0;
    const offs = [];

    // ---------- Building it ----------

    const modes = modeRow('How to find the temperature', MODES, (id) => select(id));
    const says = el('p', { class: 'spectro-sr-only', role: 'status' });

    // Fit a curve
    const fitAnswer = el('p', { class: 'spectro-tool-answer' });
    const fitSlider = el('input', { type: 'range', class: 'spectro-hands-big', min: '0', max: String(T_STEPS), step: '1', 'aria-label': 'Temperature of the curve' });
    const fitEnds = el('div', { class: 'spectro-hands-ends', 'aria-hidden': 'true' }, el('span', { text: 'Cooler' }), el('span', { text: 'Hotter' }));
    const fitHint = para('Drag the dashed curve, or the slider, until it has the same shape.');
    const fitBox = el('div', { class: 'spectro-hands-pane' }, fitAnswer, fitSlider, fitEnds, fitHint);

    // Standard stars
    const stdQuestion = para('Which has the same dips?');
    const classButtons = CLASSES.map((cls) => el('button', {
        type: 'button',
        class: 'spectro-hands-chip',
        'aria-pressed': 'false',
        text: cls,
        'aria-label': `${cls} standard star`,
        onclick: () => chooseStandard(MAIN_SEQUENCE.find((id) => id[0] === cls))
    }));
    const classRow = el('div', { class: 'spectro-hands-chips', role: 'group', 'aria-label': 'Class' }, ...classButtons);
    const subRow = el('div', { class: 'spectro-hands-subs', role: 'group', 'aria-label': 'Standard star' });
    const stdAnswer = el('p', { class: 'spectro-tool-answer', hidden: true });
    const stdShift = el('div', { class: 'spectro-hands-note' });
    const stdBox = el('div', { class: 'spectro-hands-pane' }, stdQuestion, classRow, subRow, stdAnswer, stdShift);

    // Wien's law
    const peakPrompt = para('Drag the marker to the top of the curve.');
    const peakInput = el('input', { type: 'range', class: 'spectro-sr-only', min: '0', max: '200', step: '1', value: '156', 'aria-label': 'Peak marker. Arrow keys move it, Enter marks the top' });
    const peakResult = statusBox();
    const peakBox = el('div', { class: 'spectro-hands-pane' }, peakPrompt, peakInput, peakResult);

    const useBox = el('div', { class: 'spectro-hands-use' });
    container.append(modes.el, fitBox, stdBox, peakBox, useBox, says);

    // ---------- Fit a curve ----------

    let T = memory.T;
    let touched = false;      // Nothing to send on until the student has moved the curve
    let fitDrawn = null;      // The scale the curve was last drawn at, for hit testing
    let fitDrag = null;

    function setT(next, { from = 'slider' } = {}) {
        const value = roundT(next);
        if (value === T && touched) return;
        T = value;
        memory.T = T;
        touched = true;
        if (from !== 'slider') fitSlider.value = String(sliderOf(T));
        syncFit();
        plot.redraw();
        renderUse();
    }

    function syncFit() {
        fitAnswer.textContent = `This curve: ${withCommas(T)} K`;
        fitSlider.value = String(sliderOf(T));
        fitSlider.setAttribute('aria-valuetext', `${withCommas(T)} K`);
        fitHint.hidden = touched;
    }

    fitSlider.addEventListener('input', () => setT(tOf(Number(fitSlider.value))));

    function curveY(nm) {
        return plot.yOf(curveAt(fitDrawn.amp, T, nm));
    }

    // The grip sits at the curve's top when that is in view, or at the edge it runs off
    function fitGrip() {
        const pane = plot.panes().body;
        const { lo, hi } = plot.getRange();
        const top = WIEN_NM_K / T;
        let x;
        if (top < lo) x = pane.x + 14;
        else if (top > hi) x = pane.x + pane.w - 14;
        else x = plot.xOf(top);
        const y = Math.max(pane.y + 12, Math.min(pane.y + pane.h - 12, curveY(plot.nmOf(x))));
        return { x, y };
    }

    function drawFit(ctx) {
        if (!edge || !edge.nm.length) return;
        const theme = handTheme(plot);
        const pane = plot.panes().body;
        const { lo, hi } = plot.getRange();
        fitDrawn = { amp: curveScale(edge, T, lo, hi) };
        if (!(fitDrawn.amp > 0)) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(pane.x, pane.y, pane.w, pane.h);
        ctx.clip();
        ctx.strokeStyle = theme.ref;
        ctx.lineWidth = 2;
        ctx.setLineDash(HAND_DASH);
        ctx.beginPath();
        const across = Math.max(24, Math.round(pane.w / 2));
        for (let i = 0; i <= across; i++) {
            const x = pane.x + (i / across) * pane.w;
            const y = curveY(plot.nmOf(x));
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
        const grip = fitGrip();
        drawGrip(ctx, theme, grip.x, grip.y, { focused: !!fitDrag });
        const right = grip.x < pane.x + pane.w * 0.62;
        plotLabel(ctx, theme, `${withCommas(T)} K`, grip.x + (right ? 15 : -15), grip.y, { align: right ? 'left' : 'right', within: pane });
    }

    function hitFit(x, y, e) {
        if (!edge || !fitDrawn || !(fitDrawn.amp > 0)) return null;
        const pane = plot.panes().body;
        if (x < pane.x - 4 || x > pane.x + pane.w + 4 || y < pane.y - 6 || y > pane.y + pane.h + 4) return null;
        const reach = reachOf(e);
        const grip = fitGrip();
        if (Math.hypot(x - grip.x, y - grip.y) <= reach + 4) return true;
        const yc = curveY(plot.nmOf(Math.max(pane.x, Math.min(pane.x + pane.w, x))));
        // Where the curve lies along the floor it is out of the way, and the plot keeps the drag
        if (yc > pane.y + pane.h - 6) return null;
        return Math.abs(y - Math.max(pane.y, yc)) <= reach ? true : null;
    }

    // A curve keeps its shape as its temperature changes, only sliding along in wavelength: so the point under the pointer
    // follows it, and T goes as the inverse of where that point has got to. The pointer may go past the edge of the plot,
    // as it must to push a hot star's peak further off the short end.
    function dragFit(x) {
        const nm = plot.nmOf(x);
        if (nm > 1) setT(fitDrag.T * (fitDrag.nm / nm), { from: 'drag' });
    }

    // ---------- Standard stars ----------

    let standard = null;

    function syncStandards() {
        classButtons.forEach((button, i) => button.setAttribute('aria-pressed', standard && standard[0] === CLASSES[i] && MAIN_SEQUENCE.includes(standard) ? 'true' : 'false'));
        const cls = standard && MAIN_SEQUENCE.includes(standard) ? standard[0] : null;
        const subs = cls ? MAIN_SEQUENCE.filter((id) => id[0] === cls) : [];
        const items = [...subs.map((id) => ({ id, label: id })), ...OTHERS];
        subRow.replaceChildren(...items.map((item) => el('button', {
            type: 'button',
            class: `spectro-hands-chip${OTHERS.includes(item) ? ' is-other' : ''}`,
            'aria-pressed': item.id === standard ? 'true' : 'false',
            text: item.label,
            onclick: () => chooseStandard(item.id)
        })));
        stdAnswer.hidden = !standard;
        if (standard) stdAnswer.textContent = `${standardName(standard)}: ${withCommas(STANDARDS[standard].teff_K)} K`;
        syncShiftNote();
    }

    // What the student slid the lines by is kept, so the standards are shifted with the star. With nothing slid yet, a
    // fast-moving star's lines won't sit on a standard's, so there is a way to go and slide them first.
    function syncShiftNote() {
        const z = api.picker.state().z;
        if (z) {
            const v = z * C_KMS;
            fill(stdShift, para(`Shifted by your slide: ${v >= 0 ? '+' : '−'}${withCommas(Math.abs(v))} km/s`));
        } else {
            fill(stdShift, actionRow(toolLink(api, 'doppler', 'Moving? Slide the lines first')));
        }
    }

    function chooseStandard(id, { focus = false } = {}) {
        standard = id;
        memory.standard = { code: api.resolved.entity.code, id };
        reference.show(`std:${id}`, 'overlay');
        syncStandards();
        says.textContent = `${STANDARD_LABELS[id]}, ${withCommas(STANDARDS[id].teff_K)} K`;
        if (focus) {
            const pressed = stdBox.querySelector('[aria-pressed="true"]');
            if (pressed) pressed.focus();
        }
        renderUse();
    }

    // Left and right step along the standards, so a student can watch the lines come and go
    stdBox.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (!e.target.closest('.spectro-hands-chips, .spectro-hands-subs')) return;
        e.preventDefault();
        e.stopPropagation();
        const at = standard ? STEP_ORDER.indexOf(standard) : -1;
        const next = Math.max(0, Math.min(STEP_ORDER.length - 1, at + (e.key === 'ArrowRight' ? 1 : -1)));
        chooseStandard(STEP_ORDER[next], { focus: true });
    });

    // ---------- Wien's law ----------

    const PARKED = 0.78;      // Where the marker waits, as a share of the width: the same for every star
    let markNm = null;        // Null while parked
    // Once marked: { reading (markReading's, at the mark), on (inside the flat top), rising (which way the light still climbs
    // when not) }, or { off: 'short'|'long' } for no peak in range
    let marked = null;
    let markDrag = false;
    let markerFocused = false;

    function markerNm() {
        if (markNm !== null) return markNm;
        const pane = plot.panes().body;
        return plot.nmOf(pane.x + PARKED * pane.w);
    }

    function hasCurve() {
        return !!peak && (peak.T_K !== null || peak.belowRange || peak.aboveRange);
    }

    // The top of the spectrum at a wavelength, for the grip to ride on
    function edgeAt(nm) {
        if (!edge || !edge.nm.length) return 0;
        const list = edge.nm;
        let a = 0;
        let b = list.length - 1;
        if (nm <= list[0]) return edge.level[0];
        if (nm >= list[b]) return edge.level[b];
        while (b - a > 1) {
            const m = (a + b) >> 1;
            if (list[m] < nm) a = m;
            else b = m;
        }
        const w = (nm - list[a]) / (list[b] - list[a]);
        return edge.level[a] + (edge.level[b] - edge.level[a]) * w;
    }

    function markerPoint() {
        const pane = plot.panes().body;
        const nm = markerNm();
        const { lo, hi } = plot.getRange();
        if (nm < lo || nm > hi) return null;
        const x = plot.xOf(nm);
        const y = Math.max(pane.y + 12, Math.min(pane.y + pane.h - 12, plot.yOf(edgeAt(nm)) - 12));
        return { x, y, nm };
    }

    function drawPeak(ctx) {
        if (!hasCurve()) return;
        const theme = handTheme(plot);
        const pane = plot.panes().body;
        const labelY = pane.y + plot.labelBand() + 12;
        const read = marked && marked.reading;
        if (read && markNm !== null) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(pane.x, pane.y, pane.w, pane.h);
            ctx.clip();
            // How far either way the mark could as well have gone: the curve is that flat across this band
            const x0 = plot.xOf(read.lo_nm);
            const x1 = plot.xOf(read.hi_nm);
            ctx.fillStyle = theme.mark;
            ctx.globalAlpha = 0.1;
            ctx.fillRect(Math.min(x0, x1), pane.y, Math.abs(x1 - x0), pane.h);
            ctx.globalAlpha = 1;
            // The black body that peaks where the mark is, through the light at the mark: it fits the spectrum only if the mark
            // is on the top
            const fit = { T_K: read.T_K, amp: edgeAt(read.peak_nm) / Math.max(1e-300, wienCurveAt({ T_K: read.T_K, amp: 1 }, read.peak_nm)) };
            ctx.strokeStyle = theme.mark;
            ctx.lineWidth = 1.6;
            ctx.setLineDash(HAND_DASH);
            ctx.beginPath();
            const across = Math.max(24, Math.round(pane.w / 3));
            for (let i = 0; i <= across; i++) {
                const x = pane.x + (i / across) * pane.w;
                const y = plot.yOf(wienCurveAt(fit, plot.nmOf(x)));
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.restore();
        }
        if (marked && marked.off) {
            const { lo, hi } = plot.getRange();
            const short = marked.off === 'short';
            plotLabel(ctx, theme, short ? `← the peak is below ${sig(lo, 3)} nm` : `the peak is beyond ${sig(hi, 3)} nm →`, short ? pane.x + 6 : pane.x + pane.w - 6, labelY, { align: short ? 'left' : 'right' });
        }
        const point = markerPoint();
        if (!point) {
            const { lo } = plot.getRange();
            const left = markerNm() < lo;
            plotLabel(ctx, theme, left ? '← marker' : 'marker →', left ? pane.x + 6 : pane.x + pane.w - 6, labelY + 18, { align: left ? 'left' : 'right' });
            return;
        }
        ctx.save();
        ctx.strokeStyle = theme.mark;
        ctx.lineWidth = read ? 2 : 1.6;
        if (!read) ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(point.x, pane.y);
        ctx.lineTo(point.x, pane.y + pane.h);
        ctx.stroke();
        ctx.restore();
        drawGrip(ctx, theme, point.x, point.y, { colour: theme.mark, focused: markerFocused || markDrag });
        if (markNm === null || (marked && marked.off)) return;
        const right = point.x < pane.x + pane.w * 0.6;
        const text = read ? `λmax = ${sig(read.peak_nm, 3)} nm` : `${sig(point.nm, 3)} nm`;
        plotLabel(ctx, theme, text, point.x + (right ? 15 : -15), point.y, { align: right ? 'left' : 'right', within: pane });
    }

    function hitMarker(x, y, e) {
        if (!hasCurve()) return null;
        const point = markerPoint();
        if (!point) return null;
        const pane = plot.panes().body;
        if (y < pane.y - 6 || y > pane.y + pane.h + 4) return null;
        const reach = reachOf(e);
        // The grip, or anywhere along the line itself
        return Math.hypot(x - point.x, y - point.y) <= reach + 4 || Math.abs(x - point.x) <= Math.max(6, reach * 0.6) ? true : null;
    }

    function slackAt(nm) {
        const x = plot.xOf(nm);
        return Math.abs(plot.nmOf(x + 10) - nm);
    }

    function moveMarker(nm) {
        markNm = nm;
        if (marked) {
            marked = null;
            renderMark();
        }
        syncMarkerInput();
        plot.redraw();
    }

    // The reading is wherever the mark was let go: nothing moves it onto the peak
    function tryMark(nm) {
        if (!hasCurve()) return;
        markNm = nm;
        if (peak.belowRange) marked = { off: 'short' };
        else if (peak.aboveRange) marked = { off: 'long' };
        else {
            const m = markOnPeak(peak, nm, slackAt(nm));
            marked = { reading: markReading(api.getOverview(), nm), on: m.on, rising: m.rising };
        }
        renderMark();
        plot.redraw();
    }

    function syncMarkerInput() {
        const pane = plot.panes().body;
        const share = (plot.xOf(markerNm()) - pane.x) / pane.w;
        peakInput.value = String(Math.round(Math.max(0, Math.min(1, share)) * 200));
        peakInput.setAttribute('aria-valuetext', `Marker at ${sig(markerNm(), 3)} nm`);
    }

    peakInput.addEventListener('input', () => {
        const pane = plot.panes().body;
        moveMarker(plot.nmOf(pane.x + (Number(peakInput.value) / 200) * pane.w));
    });
    peakInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        tryMark(markerNm());
    });
    peakInput.addEventListener('focus', () => {
        markerFocused = true;
        peakPrompt.hidden = !hasCurve();
        peakPrompt.textContent = 'Left and right move the marker. Enter marks the top.';
        plot.redraw();
    });
    peakInput.addEventListener('blur', () => {
        markerFocused = false;
        syncPeakPrompt();
        plot.redraw();
    });

    function syncPeakPrompt() {
        peakPrompt.hidden = !hasCurve() || !!marked;
        peakPrompt.textContent = 'Drag the marker to the top of the curve.';
    }

    function renderMark() {
        peakResult.replaceChildren();
        if (!markerFocused) peakPrompt.hidden = !hasCurve() || !!marked;
        if (!peak) return;
        if (!hasCurve()) {
            fill(peakResult, para('This light doesn\'t follow one black-body curve, so there is no peak to find. Mostly bright lines over very little continuum, such as a supernova long after its peak, have no temperature to read this way.'));
            renderUse();
            return;
        }
        if (!marked) {
            renderUse();
            return;
        }
        if (marked.off) {
            fill(peakResult,
                resultLine('The peak is off the scale', true),
                para(marked.off === 'short'
                    ? 'The light still rises at the short end, so its peak is below 90 nm and too hot to find here. Fit a curve instead.'
                    : 'The light still rises at the long end, so its peak is beyond this range. Fit a curve instead.'),
                actionRow(el('button', { type: 'button', class: 'spectro-tool-go', text: 'Fit a curve', onclick: () => select('fit') })));
        } else {
            const read = marked.reading;
            const metres = read.peak_nm * 1e-9;
            const answer = plusMinus(read.T_K, read.err_K);
            fill(peakResult,
                resultLine(blend > 1 ? `Blend: T = ${answer} K` : `T = ${answer} K`, true),
                // Where the light is plainly still climbing, a nudge: the dashed curve already shows the misfit
                marked.on ? null : para(marked.rising < 0 ? '← The light is still higher to the left' : 'The light is still higher to the right →'),
                steps([
                    `λmax = ${sig(read.peak_nm, 3)} nm = ${sci(metres, 3)} m`,
                    `T = b ÷ λmax, b = ${sci(WIEN_B, 4)} m·K`,
                    `T = ${withCommas(read.T_K)} K`
                ]));
        }
        renderUse();
    }

    // ---------- Using a reading ----------

    function reading() {
        if (mode === 'fit') return touched ? { T, err: fitError(T), source: 'fit' } : null;
        if (mode === 'standards') return standard ? { T: STANDARDS[standard].teff_K, err: standardError(standard), source: 'standard' } : null;
        if (mode === 'peak') return marked && marked.reading ? { T: Math.round(marked.reading.T_K), err: marked.reading.err_K, source: 'wien' } : null;
        return null;
    }

    // The way on from a reading: to the H-R diagram, and to Brightness if that's what the diagram still needs
    function nextSteps() {
        const m = getMeasurement(api.resolved.entity.code) || {};
        const items = [diagramLink('hr')];
        if (hasTab('hr') && !(m.flux_Wm2 > 0)) items.push(toolLink(api, 'photometer', 'Brightness next'));
        return actionRow(...items);
    }

    let useKey = '';
    function renderUse(force = false) {
        const r = reading();
        const code = api.resolved ? api.resolved.entity.code : '';
        const m = getMeasurement(code) || {};
        const used = !!r && m.T_source === r.source && m.T_K === r.T;
        const key = !r ? 'none' : blend > 1 ? `blend${blend}` : !hasTab('hr') ? 'no-hr' : used ? `used|${r.T}` : `offer|${m.T_K}|${m.T_source}`;
        if (!force && key === useKey) return;
        useKey = key;
        if (!r || (blend === 1 && !hasTab('hr'))) {
            useBox.replaceChildren();
            return;
        }
        if (blend > 1) {
            // A blend's one temperature is true of the blend and of no star in it, so it isn't sent on as if it were a star's
            fill(useBox,
                para(`This is ${blend} stars' light added together. That one temperature is true of the blend, but of no star in it.`),
                actionRow(toolLink(api, 'stars-shown', 'Read each star with the Stars tool')));
            return;
        }
        if (used) {
            fill(useBox,
                para(`Sent to H-R: ${plusMinus(r.T, r.err)} K, from ${SOURCE_WORDS[r.source]}.`),
                nextSteps());
            return;
        }
        fill(useBox,
            m.T_K > 0 ? para(`The H-R diagram has ${m.T_err_K > 0 ? plusMinus(m.T_K, m.T_err_K) : withCommas(m.T_K)} K, from ${SOURCE_WORDS[m.T_source] || 'your own value'}.`) : null,
            actionRow(el('button', {
                type: 'button',
                class: 'spectro-tool-go',
                text: 'Use this temperature',
                onclick: (e) => {
                    const now = reading();
                    if (!now) return;
                    recordMeasurement(api.resolved.entity.code, { T_K: now.T, T_err_K: now.err, T_source: now.source });
                    renderUse(true);
                    says.textContent = `Sent to the H-R diagram: ${plusMinus(now.T, now.err)} K`;
                    // By keyboard, on to what comes next rather than back through the page
                    if (e.detail === 0) {
                        const next = useBox.querySelector('button');
                        if (next) next.focus();
                    }
                }
            })));
    }

    // ---------- Modes ----------

    function select(next, { frame = true } = {}) {
        if (mode === next) return;
        if (mode) memory.views[mode] = plot.getRange();
        mode = next;
        memory.mode = next;
        modes.set(next);
        fitBox.hidden = next !== 'fit';
        stdBox.hidden = next !== 'standards';
        peakBox.hidden = next !== 'peak';
        if (next === 'standards' && standard) reference.show(`std:${standard}`, 'overlay');
        else reference.show('none');
        if (next === 'standards') syncShiftNote();
        if (frame) {
            const v = memory.views[next] || OPENING_VIEWS[next];
            plot.setRange(v.lo, v.hi, { animate: true });
        }
        if (next === 'peak') syncMarkerInput();
        renderUse(true);
        plot.redraw();
    }

    // ---------- On the plot ----------

    const removeOverlay = plot.addOverlay((ctx) => {
        if (mode === 'fit') drawFit(ctx);
        else if (mode === 'peak') drawPeak(ctx);
    });

    offs.push(plotGrab(plot, {
        hit(x, y, e) {
            if (mode === 'fit') return hitFit(x, y, e);
            if (mode === 'peak') return hitMarker(x, y, e);
            return null;
        },
        start(what, x) {
            if (mode === 'fit') {
                const pane = plot.panes().body;
                fitDrag = { T, nm: plot.nmOf(Math.max(pane.x, Math.min(pane.x + pane.w, x))) };
                plot.redraw();
            } else {
                markDrag = true;
                plot.redraw();
            }
        },
        move(x) {
            if (mode === 'fit' && fitDrag) dragFit(x);
            else if (mode === 'peak') {
                const pane = plot.panes().body;
                moveMarker(plot.nmOf(Math.max(pane.x, Math.min(pane.x + pane.w, x))));
            }
        },
        end(x, y, e, moved) {
            if (mode === 'fit') {
                fitDrag = null;
                if (moved) says.textContent = `Curve at ${withCommas(T)} K`;
                plot.redraw();
            } else if (mode === 'peak') {
                markDrag = false;
                tryMark(markerNm());
            }
        }
    }));

    // A click or tap on the plot, or Enter on it, marks there
    offs.push(plot.onClick((nm) => {
        if (mode !== 'peak' || !hasCurve()) return;
        tryMark(nm);
        syncMarkerInput();
    }));

    // ---------- The object ----------

    function measure() {
        const spectrum = api.getOverview();
        edge = spectrum ? topEdge(spectrum) : null;
        peak = spectrum ? wienPeak(spectrum) : null;
        blend = partCount(api);
    }

    function startOver() {
        markNm = null;
        marked = null;
        syncPeakPrompt();
        renderMark();
        syncMarkerInput();
    }

    // A change of stars shown, or of time: wait for it to settle, since a full-range spectrum takes a moment
    offs.push(api.onBodyOpts(() => {
        clearTimeout(pending);
        pending = setTimeout(() => {
            measure();
            startOver();
            renderUse(true);
            plot.redraw();
        }, 220);
    }));
    offs.push(api.onReferenceChange(() => {
        if (mode === 'standards') syncShiftNote();
    }));

    return {
        setEntity(resolved) {
            const code = resolved.entity.code;
            openedCode = openedCode || code;
            measure();
            touched = false;
            standard = memory.standard && memory.standard.code === code ? memory.standard.id : null;
            syncFit();
            syncStandards();
            if (!mode) select(memory.mode);
            else if (mode === 'standards') reference.show(standard ? `std:${standard}` : 'none', standard ? 'overlay' : null);
            startOver();
            renderUse(true);
            plot.redraw();
        },
        dispose() {
            clearTimeout(pending);
            offs.forEach((off) => off());
            removeOverlay();
            if (mode) memory.views[mode] = plot.getRange();
            reference.dispose();
            // Closed by the student on the object it opened on: the view goes back to what it was
            if (api.resolved && api.resolved.entity.code === openedCode) plot.setRange(opened.lo, opened.hi, { animate: true });
        }
    };
}

registerTool({
    id: 'wien',
    label: 'How hot?',
    draws: true,
    appliesTo: applies,
    mount
});
