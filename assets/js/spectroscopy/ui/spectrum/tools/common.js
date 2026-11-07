// What the tools share: a result's sum set out in steps, the link that takes a result to its diagram, marks drawn over the
// plot, and the small figure with a time axis that the time-based tools draw on.

import { app } from '../../../core/state.js';
import { el, createFigure, drawFrame, linearScale, niceTicks } from '../../plot2d.js';

// ---------- Text ----------

// Replaces what a node holds, leaving out anything a condition turned to null
export function fill(node, ...items) {
    node.replaceChildren(...items.filter(Boolean));
}

export function para(text, cls = 'spectro-tool-text') {
    return el('p', { class: cls, text });
}

// One figure or sentence that the tool is reporting; the main answer is `big`
export function resultLine(text, big = false) {
    return el('p', { class: big ? 'spectro-tool-answer' : 'spectro-tool-line', text });
}

// A sum set out as numbered steps, so the student can follow it and check it
export function steps(lines) {
    return el('ol', { class: 'spectro-tool-steps' }, ...lines.map((line) => el('li', { text: line })));
}

// A live region for results, so a screen reader hears them as they appear
export function statusBox() {
    return el('div', { class: 'spectro-tool-result', role: 'status' });
}

// A dropdown with its label above it, at full touch height
export function labelledSelect(label, onChange) {
    const id = `spectroTool${++labelledSelect.next}`;
    const select = el('select', { id, class: 'spectro-tool-select' });
    select.addEventListener('change', () => onChange(select.value));
    const wrap = el('div', { class: 'spectro-tool-field' }, el('label', { for: id, text: label }), select);
    return { wrap, select };
}
labelledSelect.next = 0;

export function setOptions(select, options, value) {
    select.replaceChildren(...options.map((o) => el('option', { value: String(o.value), text: o.label })));
    if (value !== undefined) select.value = String(value);
}

// A slider for time, with its value in its label. Works from the keyboard like any range input.
export function timeSlider(label, onInput) {
    const id = `spectroToolTime${++labelledSelect.next}`;
    const value = el('span', { class: 'spectro-value' });
    const input = el('input', { type: 'range', id, min: '0', max: '1000', step: '1', value: '0' });
    input.addEventListener('input', () => onInput(Number(input.value) / 1000));
    const wrap = el('div', { class: 'spectro-tool-slider' }, el('label', { for: id }, `${label}: `, value), input);
    return {
        wrap,
        set(fraction, text) {
            input.value = String(Math.round(Math.max(0, Math.min(1, fraction)) * 1000));
            value.textContent = text;
            input.setAttribute('aria-valuetext', text);
        }
    };
}

// ---------- Going on to a diagram or another tool ----------

const DIAGRAMS = {
    hr: { tab: 'hr', label: 'Add to H-R' },
    hubble: { tab: 'hubble', label: 'Add to Hubble plot' }
};

// The tab bar only lists the tabs that apply to the current object
function hasTab(tab) {
    return !!document.getElementById(`spectroTab-${tab}`);
}

// "Add to H-R" or "Add to Hubble plot", whichever this object can go on; null if neither. `only` names the one diagram that
// a result is any use to, where that matters: a star's speed doesn't go on the H-R diagram.
export function diagramLink(only) {
    const diagram = only ? (hasTab(only) ? DIAGRAMS[only] : null) : hasTab('hubble') ? DIAGRAMS.hubble : hasTab('hr') ? DIAGRAMS.hr : null;
    if (!diagram) return null;
    return el('button', {
        type: 'button',
        class: 'spectro-tool-go',
        text: diagram.label,
        onclick: () => app.drawer.selectTab(diagram.tab)
    });
}

// A button that opens another tool, for a next step such as the Photometer after Wien's law; null if this object hasn't that tool
export function toolLink(panelApi, id, label) {
    if (!panelApi.hasTool(id)) return null;
    return el('button', { type: 'button', class: 'spectro-tool-next', text: label, onclick: () => panelApi.openTool(id) });
}

export function actionRow(...buttons) {
    return el('div', { class: 'spectro-tool-actions' }, ...buttons);
}

// ---------- Marks over the plot ----------

export function overlayTheme(plot) {
    const cs = getComputedStyle(plot.el);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    return {
        ink: v('--color-text', '#585858'),
        well: v('--spectro-plot-well', v('--color-bg', '#ffffff')),
        mark: v('--sim-value-color', '#2b2b2b'),
        font: cs.fontFamily || 'sans-serif'
    };
}

// A label that stays readable over the spectrum: text on a patch of the plot's own background. `within` is a pane to keep
// it inside, so a line near the edge doesn't push its label over the axis.
export function plotLabel(ctx, theme, text, x, y, { align = 'center', bold = true, within = null } = {}) {
    ctx.font = `${bold ? 700 : 400} 11.5px ${theme.font}`;
    const w = ctx.measureText(text).width;
    let left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    if (within) left = Math.max(within.x + 3, Math.min(left, within.x + within.w - w - 3));
    ctx.save();
    ctx.globalAlpha = 0.86;
    ctx.fillStyle = theme.well;
    ctx.fillRect(left - 3, y - 8, w + 6, 16);
    ctx.restore();
    ctx.fillStyle = theme.mark;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left, y + 0.5);
}

// A vertical mark through the object's pane. dashed tells two marks apart without relying on colour.
export function plotMark(ctx, plot, theme, nm, { dashed = false, width = 1.6 } = {}) {
    const { lo, hi } = plot.getRange();
    if (nm < lo || nm > hi) return null;
    const pane = plot.panes().body;
    const x = plot.xOf(nm);
    ctx.save();
    ctx.strokeStyle = theme.mark;
    ctx.lineWidth = width;
    if (dashed) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x, pane.y);
    ctx.lineTo(x, pane.y + pane.h);
    ctx.stroke();
    ctx.restore();
    return { x, top: pane.y, bottom: pane.y + pane.h };
}

// How many nanometres a few pixels are on the plot: how near a click has to be to count as on a line
export function searchNmAt(plot, nm, e) {
    const px = e && e.pointerType && e.pointerType !== 'mouse' ? 14 : 7;
    const x = plot.xOf(nm);
    return Math.abs(plot.nmOf(x + px) - nm);
}

// ---------- A small figure with a time axis ----------

// paint(ctx, frame, rect, sx, sy) draws the data once the frame is on. range() -> { xLo, xHi, yLo, yHi }.
export function createTimeFigure(parent, { label, xTitle, yTitle, range, paint, yInverted = false, height = 190 }) {
    const figure = createFigure(parent, {
        label,
        height: () => height,
        draw(ctx, frame) {
            const { width, height: h, theme } = frame;
            const { xLo, xHi, yLo, yHi } = range();
            const rect = { x: 54, y: 8, w: width - 54 - 12, h: h - 8 - 42 };
            const sx = linearScale(xLo, xHi, rect.x, rect.x + rect.w);
            const sy = yInverted ? linearScale(yLo, yHi, rect.y, rect.y + rect.h) : linearScale(yLo, yHi, rect.y + rect.h, rect.y);
            const xTicks = niceTicks(xLo, xHi, Math.max(3, Math.floor(rect.w / 70))).map((v) => ({ at: sx(v), text: axisNumber(v) }));
            const yTicks = niceTicks(yLo, yHi, 4).map((v) => ({ at: sy(v), text: axisNumber(v) }));
            drawFrame(ctx, rect, theme, { xTicks, yTicks, xTitle: typeof xTitle === 'function' ? xTitle() : xTitle, yTitle });
            ctx.save();
            ctx.beginPath();
            ctx.rect(rect.x, rect.y, rect.w, rect.h);
            ctx.clip();
            paint(ctx, frame, rect, sx, sy);
            ctx.restore();
        }
    });
    return figure;
}

function axisNumber(v) {
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toLocaleString('en-AU');
    return String(Number(v.toPrecision(4))).replace('-', '−');
}

// Round numbers around a share of a period, for a playback's speed list: never the same twice
export function niceSpeeds(unitsPerSecondList) {
    const out = [];
    unitsPerSecondList.forEach((x) => {
        const e = Math.floor(Math.log10(x));
        const m = x / 10 ** e;
        const nice = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
        const value = Number((nice * 10 ** e).toPrecision(2));
        if (!out.includes(value)) out.push(value);
    });
    return out;
}
