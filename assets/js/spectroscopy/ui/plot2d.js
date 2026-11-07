// The parts the H-R diagram and the Hubble plot share, so the two read as one kind of figure: a crisp canvas that
// follows the site's theme, scales and ticks, markers and labels, the card that asks for a missing measurement,
// the list of plotted objects and the table under "Show as table". Nothing touches the page until it is called,
// so the maths at the top can be tested under Node.

import { blackBodyRGB } from '../core/phys.js';
import { superscript } from '../core/format.js';
import { recordMeasurement, getMeasurement } from '../core/measurements.js';

// ---------- Maths ----------

export function linearScale(d0, d1, r0, r1) {
    const k = (r1 - r0) / (d1 - d0);
    const scale = (x) => r0 + (x - d0) * k;
    scale.invert = (p) => d0 + (p - r0) / k;
    return scale;
}

export function logScale(d0, d1, r0, r1) {
    const inner = linearScale(Math.log10(d0), Math.log10(d1), r0, r1);
    const scale = (x) => inner(Math.log10(x));
    scale.invert = (p) => 10 ** inner.invert(p);
    return scale;
}

function niceStep(span, count) {
    const raw = span / Math.max(1, count);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

// Round ticks from 1, 2 and 5 times a power of ten
export function niceTicks(lo, hi, count = 5) {
    const step = niceStep(hi - lo, count);
    const ticks = [];
    // Adding 0 turns a -0 into 0, which would otherwise print as "-0" on the axis
    for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k++) ticks.push(k * step + 0);
    return ticks;
}

// The next round number at or above x, for the top of an axis
export function niceCeil(x, count = 5) {
    const step = niceStep(x, count);
    return Math.ceil(x / step - 1e-9) * step;
}

// "10⁻²", with 1 and 10 written plainly as a textbook would
export function powerLabel(exponent) {
    if (exponent === 0) return '1';
    if (exponent === 1) return '10';
    return `10${superscript(exponent)}`;
}

// Least squares through the origin: y = m x. The uncertainty in m comes from the scatter about the line.
export function fitThroughOrigin(xs, ys) {
    const n = xs.length;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
        sxx += xs[i] * xs[i];
        sxy += xs[i] * ys[i];
    }
    if (n === 0 || sxx === 0) return null;
    const slope = sxy / sxx;
    let rss = 0;
    for (let i = 0; i < n; i++) rss += (ys[i] - slope * xs[i]) ** 2;
    return { slope, err: n > 1 ? Math.sqrt(rss / (n - 1) / sxx) : null, n };
}

const FROM_SUPER = { '⁻': '-', '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };

// What students type: "5,100", "3.2e-9", "3.2 × 10^-9", "3.2x10⁻⁹". NaN for anything else. A comma only counts as a
// thousands separator: "1,2,3" and "5.800,5" are slips, and they don't get to pass as 123 and 5.8005.
export function parseNumber(text) {
    let t = String(text).trim().toLowerCase().replace(/[−–]/g, '-');
    if (t.includes(',') && !/^[-+]?\d{1,3}(,\d{3})+(\.\d*)?(\s*[ex×*·].*)?$/.test(t)) return NaN;
    t = t.replace(/[,\s]/g, '');
    t = t.replace(/[⁻⁰¹²³⁴-⁹]+/g, (m) => `^${[...m].map((c) => FROM_SUPER[c]).join('')}`);
    t = t.replace(/[x×*·]10\^?([-+]?\d+)$/, 'e$1');
    t = t.replace(/^10\^([-+]?\d+)$/, '1e$1');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(t)) return NaN;
    return Number(t);
}

// ---------- Colour ----------

// A black body's colour as a CSS colour; blackBodyRGB is linear, so it is encoded for the screen here
export function blackBodyCss(T) {
    const encode = (v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
    const [r, g, b] = blackBodyRGB(T).map(encode);
    return `rgb(${r}, ${g}, ${b})`;
}

// The site's tokens, read from the page so both themes work without a second set of colours here
export function readTheme(node) {
    const style = getComputedStyle(node);
    const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return {
        text: token('--color-text', '#585858'),
        strong: token('--sim-value-color', '#2b2b2b'),
        border: token('--color-border', '#c9c9c9'),
        paper: token('--color-bg', '#ffffff'),
        accent: token('--color-accent-active', '#ee5f81'),
        font: style.fontFamily,
        isDark: document.documentElement.classList.contains('dark-mode')
    };
}

export function fontOf(theme, size = 12, weight = 400, style = '') {
    return `${style} ${weight} ${size}px ${theme.font}`.trim();
}

// ---------- Small DOM helper ----------

export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
        if (value === undefined || value === null || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'hidden') node.hidden = true;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : value);
    });
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return node;
}

// ---------- The figure ----------

// A canvas at the display's real pixel density, sized from its container. draw(ctx, view) is given
// { width, height, dpr, theme } in CSS pixels. It only draws while it has a width, so a hidden tab costs nothing;
// onShow should call redraw.
export function createFigure(parent, { label, height, draw }) {
    const canvas = el('canvas', { role: 'img', 'aria-label': label });
    const tip = el('div', { class: 'spectro-fig-tip', hidden: true, 'aria-hidden': 'true' });
    const wrap = el('div', { class: 'spectro-fig' }, canvas, tip);
    parent.appendChild(wrap);

    const ctx = canvas.getContext('2d');
    let width = 0;
    let cssHeight = 0;
    let dpr = 0;

    function redraw() {
        const w = wrap.clientWidth;
        if (!w) return;
        const h = Math.round(height(w));
        const density = Math.min(window.devicePixelRatio || 1, 3);
        if (w !== width || h !== cssHeight || density !== dpr) {
            width = w;
            cssHeight = h;
            dpr = density;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            canvas.style.height = `${h}px`;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, cssHeight);
        draw(ctx, { width, height: cssHeight, dpr, theme: readTheme(wrap) });
    }

    // A height that follows the width can feed back through the page's scrollbar (taller, a scrollbar, narrower, shorter,
    // no scrollbar...). Should the width ever flip back to where it was a moment ago, keep the size it had and stop there.
    let lastWidths = [];
    new ResizeObserver(() => {
        const w = wrap.clientWidth;
        if (w === width) return;
        const now = performance.now();
        lastWidths = lastWidths.filter((entry) => now - entry.t < 400);
        const flipping = lastWidths.filter((entry) => entry.w === w).length >= 2;
        lastWidths.push({ w, t: now });
        if (flipping) return;
        redraw();
    }).observe(wrap);
    // If the graphics process restarts, the browser gives the canvas back empty
    canvas.addEventListener('contextrestored', redraw);
    new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return {
        wrap,
        canvas,
        redraw,
        setLabel(text) { canvas.setAttribute('aria-label', text); },
        pointerPos(event) {
            const box = canvas.getBoundingClientRect();
            return { x: event.clientX - box.left, y: event.clientY - box.top, touch: event.pointerType === 'touch' };
        },
        showTip(x, y, lines) {
            tip.replaceChildren(...lines.map((line) => el('span', { text: line })));
            tip.hidden = false;
            // Kept inside the figure, and on the far side of the point when near the right-hand edge
            const flip = x > width - tip.offsetWidth - 18;
            tip.style.left = `${flip ? x - tip.offsetWidth - 10 : x + 10}px`;
            tip.style.top = `${Math.max(2, y - tip.offsetHeight - 8)}px`;
        },
        hideTip() { tip.hidden = true; }
    };
}

// Paper, grid, frame, tick labels and axis titles. Ticks are { at (px), text, grid }; a label that would run into
// the one before it is dropped, so a narrow drawer keeps fewer, readable ticks.
export function drawFrame(ctx, rect, theme, { xTicks, yTicks, xTitle, yTitle }) {
    const right = rect.x + rect.w;
    const bottom = rect.y + rect.h;
    ctx.fillStyle = theme.paper;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    xTicks.forEach((t) => {
        if (t.grid === false) return;
        const x = Math.round(t.at) + 0.5;
        ctx.moveTo(x, rect.y);
        ctx.lineTo(x, bottom);
    });
    yTicks.forEach((t) => {
        if (t.grid === false) return;
        const y = Math.round(t.at) + 0.5;
        ctx.moveTo(rect.x, y);
        ctx.lineTo(right, y);
    });
    ctx.stroke();

    ctx.font = fontOf(theme, 12);
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let lastEnd = -Infinity;
    xTicks.forEach((t) => {
        if (!t.text) return;
        const half = ctx.measureText(t.text).width / 2;
        if (t.at - half < lastEnd + 5 || t.at + half > right + 12) return;
        ctx.fillText(t.text, t.at, bottom + 6);
        lastEnd = t.at + half;
    });
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    yTicks.forEach((t) => {
        if (t.text) ctx.fillText(t.text, rect.x - 6, t.at);
    });

    ctx.strokeStyle = theme.text;
    ctx.beginPath();
    xTicks.forEach((t) => {
        const x = Math.round(t.at) + 0.5;
        ctx.moveTo(x, bottom);
        ctx.lineTo(x, bottom + (t.text ? 4 : 2.5));
    });
    yTicks.forEach((t) => {
        const y = Math.round(t.at) + 0.5;
        ctx.moveTo(rect.x, y);
        ctx.lineTo(rect.x - (t.text ? 4 : 2.5), y);
    });
    ctx.stroke();
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

    ctx.font = fontOf(theme, 12, 600);
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    if (xTitle) ctx.fillText(xTitle, rect.x + rect.w / 2, bottom + 36);
    if (yTitle) {
        ctx.save();
        ctx.translate(13, rect.y + rect.h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(yTitle, 0, 0);
        ctx.restore();
    }
}

function markerPath(ctx, shape, x, y, r) {
    ctx.beginPath();
    if (shape === 'square') {
        const s = r * 0.9;
        ctx.rect(x - s, y - s, 2 * s, 2 * s);
    } else if (shape === 'diamond') {
        const s = r * 1.3;
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s, y);
        ctx.lineTo(x, y + s);
        ctx.lineTo(x - s, y);
        ctx.closePath();
    } else if (shape === 'triangle') {
        const s = r * 1.3;
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s * 0.95, y + s * 0.72);
        ctx.lineTo(x - s * 0.95, y + s * 0.72);
        ctx.closePath();
    } else {
        ctx.arc(x, y, r, 0, Math.PI * 2);
    }
}

// fill may be null for a hollow marker
export function drawMarker(ctx, shape, x, y, r, { fill, stroke, width = 1.25 }) {
    markerPath(ctx, shape, x, y, r);
    if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = stroke;
    ctx.stroke();
}

// The same shapes as small icons for the legend and lists
export function markerIcon(shape, { fill = 'currentColor', hollow = false } = {}) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'spectro-fig-icon');
    const paths = {
        square: 'M2.5 2.5h9v9h-9z',
        diamond: 'M7 1l6 6-6 6-6-6z',
        triangle: 'M7 1.5l6 10.5H1z',
        circle: 'M7 2a5 5 0 1 0 0 10a5 5 0 1 0 0-10z'
    };
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', paths[shape] || paths.circle);
    path.setAttribute('fill', hollow ? 'none' : fill);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.3');
    svg.appendChild(path);
    return svg;
}

export function drawErrorBar(ctx, x0, y0, x1, y1, stroke) {
    const cap = 3;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    if (x0 === x1) {
        ctx.moveTo(x0 - cap, y0);
        ctx.lineTo(x0 + cap, y0);
        ctx.moveTo(x1 - cap, y1);
        ctx.lineTo(x1 + cap, y1);
    } else {
        ctx.moveTo(x0, y0 - cap);
        ctx.lineTo(x0, y0 + cap);
        ctx.moveTo(x1, y1 - cap);
        ctx.lineTo(x1, y1 + cap);
    }
    ctx.stroke();
}

// Text with a thin halo in the paper colour, so it stays readable over grid lines and bands
export function haloText(ctx, text, x, y, theme, { align = 'left', baseline = 'middle', colour, font } = {}) {
    ctx.font = font || fontOf(theme, 12);
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = theme.paper;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = colour || theme.text;
    ctx.fillText(text, x, y);
}

// Finds a free spot for each point's label: right, left, above, below. A label with no free spot is left out; the
// list and the tooltip still name that point.
export function createLabelPlacer(ctx, rect) {
    const taken = [];
    const free = (box) => box.x >= rect.x + 1 && box.x + box.w <= rect.x + rect.w - 1
        && box.y >= rect.y + 1 && box.y + box.h <= rect.y + rect.h - 1
        && !taken.some((t) => box.x < t.x + t.w && box.x + box.w > t.x && box.y < t.y + t.h && box.y + box.h > t.y);
    return {
        // Marks a point's own marker as taken, so another point's label doesn't sit on it
        reserve(x, y, r) { taken.push({ x: x - r, y: y - r, w: 2 * r, h: 2 * r }); },
        reserveBox(x, y, w, h) { taken.push({ x, y, w, h }); },
        place(text, x, y, r) {
            const w = ctx.measureText(text).width + 2;
            const h = 12;
            const gap = r + 3;
            const spots = [
                { x: x + gap, y: y - h / 2 },
                { x: x - gap - w, y: y - h / 2 },
                { x: x - w / 2, y: y - gap - h },
                { x: x - w / 2, y: y + gap }
            ];
            const spot = spots.find((s) => free({ ...s, w, h }));
            if (!spot) return null;
            taken.push({ ...spot, w, h });
            return { x: spot.x + 1, y: spot.y + h / 2 };
        }
    };
}

// The closest point within reach of the pointer: a finger gets a bigger reach than a mouse
export function nearestPoint(points, pos) {
    const reach = pos.touch ? 22 : 11;
    let best = null;
    let bestD = reach * reach;
    points.forEach((p) => {
        if (p.px === undefined) return;
        const d = (p.px - pos.x) ** 2 + (p.py - pos.y) ** 2;
        if (d <= bestD) {
            best = p;
            bestD = d;
        }
    });
    return best;
}

// ---------- The strip that plots the current object, asking for whatever hasn't been measured yet ----------

// A thin strip over the diagram, so the diagram stays the biggest thing on the tab. Its name and its button share a line.
// Under them, one short cell for each value: the value once it's measured, or a link to the tool that measures it. Once the
// object is plotted the cells fold away into one line: where it sits on the diagram.
//
// fields: [{ key (in the measurement store), label, unit, scale (typed unit to stored unit), placeholder, tool (its id),
//            toolName (its button's words), min, max, rangeText (what can be typed, as words), allowNegative,
//            extra (cleared alongside a typed value, as a tool's uncertainty no longer applies),
//            brief(m) -> the value, short, and show(m) -> the value with where it came from, as the cell's tooltip }]
// options: status(code, m), summary(code, m) -> the plotted object's line, working(code, m) -> lines or null, workingLabel,
//          isPlotted(code), onAdd(code), onRemove(code), onTool(toolId), addLabel, removeLabel,
//          workingParent (where the working goes: closed, under the diagram)
//
// What a student typed is kept with the measurement, under typed, so a reload can tell it from a tool's reading.
export function createMeasureCard(parent, options) {
    const { fields } = options;
    const title = el('p', { class: 'spectro-fig-card-title', tabindex: '-1' });
    const summary = el('span', { class: 'spectro-fig-summary', hidden: true });
    const button = el('button', { type: 'button', class: 'spectro-fig-button spectro-fig-button-main', hidden: true });
    const head = el('div', { class: 'spectro-fig-card-head' }, title, summary, button);
    const cells = el('div', { class: 'spectro-fig-cells' });
    const rows = el('div', { class: 'spectro-fig-rows', hidden: true });
    const typeButton = el('button', { type: 'button', class: 'spectro-fig-hint', text: 'or type the values' });
    const status = el('p', { class: 'spectro-fig-card-status', hidden: true });
    const message = el('p', { class: 'spectro-fig-message', role: 'status', hidden: true });
    const root = el('div', { class: 'spectro-fig-card spectro-fig-strip' }, head, cells, rows, typeButton, status, message);
    parent.appendChild(root);

    const working = el('div', { class: 'spectro-fig-working' });
    const workingBox = el('details', { class: 'sim-controls-more spectro-fig-more', hidden: true },
        el('summary', { text: options.workingLabel || 'How it is worked out' }), working);
    (options.workingParent || root).appendChild(workingBox);

    const inputs = new Map();
    let code = null;
    let formOpen = false;
    let committing = false;
    let links = [];
    let hasWorking = false;

    const stored = () => getMeasurement(code) || {};
    const has = (m, field) => Number.isFinite(m[field.key]);
    const isTyped = (m, field) => Boolean(m.typed) && m.typed[field.key] !== undefined && m.typed[field.key] === m[field.key];

    function setAccepted(tick, on) {
        tick.classList.toggle('is-on', on);
    }

    function commit(field, input, errorLine, tick) {
        const text = input.value.trim();
        const m = stored();
        const typed = { ...(m.typed || {}) };
        if (text === '') {
            errorLine.hidden = true;
            input.removeAttribute('aria-invalid');
            setAccepted(tick, false);
            if (typed[field.key] !== undefined) {
                delete typed[field.key];
                committing = true;
                recordMeasurement(code, { [field.key]: undefined, ...field.extra, typed });
                committing = false;
            }
            return true;
        }
        const value = parseNumber(text);
        const size = Math.abs(value);
        const wrongKind = !Number.isFinite(value) || (!field.allowNegative && value <= 0);
        // Numbers the plot can't hold would only come back as Infinity
        const outOfRange = !wrongKind && ((field.max !== undefined && size > field.max) || (field.min !== undefined && size < field.min));
        if (wrongKind || outOfRange) {
            input.setAttribute('aria-invalid', 'true');
            errorLine.textContent = outOfRange
                ? `That is too far off this plot. Enter ${field.rangeText}.`
                : `Enter a ${field.allowNegative ? '' : 'positive '}number, such as ${field.placeholder}`;
            errorLine.hidden = false;
            setAccepted(tick, false);
            return false;
        }
        input.removeAttribute('aria-invalid');
        errorLine.hidden = true;
        setAccepted(tick, true);
        const stores = value * (field.scale || 1);
        if (typed[field.key] === stores && m[field.key] === stores) return true;
        typed[field.key] = stores;
        committing = true;
        recordMeasurement(code, { [field.key]: stores, ...field.extra, typed });
        committing = false;
        return true;
    }

    function inputRow(field, m) {
        const id = `spectroFig-${code}-${field.key}`;
        const input = el('input', {
            type: 'text',
            id,
            inputmode: field.allowNegative ? 'text' : 'decimal',
            autocomplete: 'off',
            placeholder: `e.g. ${field.placeholder}`
        });
        if (has(m, field)) input.value = String(Number((m[field.key] / (field.scale || 1)).toPrecision(6)));
        // Takes its room from the start, so that it appearing moves nothing
        const tick = el('span', { class: `spectro-fig-tick spectro-fig-accepted${has(m, field) ? ' is-on' : ''}` }, '✓ Accepted');
        const errorLine = el('p', { class: 'spectro-fig-error', role: 'alert', hidden: true });
        input.addEventListener('change', () => commit(field, input, errorLine, tick));
        // A complaint goes as soon as the slip is being put right, not when the box loses focus, which would move the Plot button
        input.addEventListener('input', () => {
            errorLine.hidden = true;
            input.removeAttribute('aria-invalid');
        });
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (commit(field, input, errorLine, tick) && !fields.some((f) => !has(stored(), f))) {
                button.click();
                button.focus();
            }
        });
        inputs.set(field, { input, errorLine, tick });
        return el('div', { class: 'spectro-fig-row spectro-fig-row-input' },
            el('label', { for: id, text: field.label }),
            el('span', { class: 'spectro-fig-inputline' }, input, el('span', { class: 'spectro-fig-unit', text: field.unit }), tick),
            errorLine);
    }

    function briefOf(field, m) {
        if (field.brief) return field.brief(m);
        return field.show(m).split(', from ')[0];
    }

    // A value, short, with where it came from on hover; or a link to the tool that measures it
    function cell(field, m) {
        let value;
        if (has(m, field)) {
            const full = isTyped(m, field) ? `${briefOf(field, m)}, typed in` : field.show(m);
            value = el('span', { class: 'spectro-fig-cell-value', title: full }, briefOf(field, m));
        } else {
            value = el('button', {
                type: 'button',
                class: 'spectro-fig-link',
                text: 'Measure',
                title: `Measure with ${field.toolName}, in the Spectrum tab`,
                'aria-label': `Measure ${field.label.toLowerCase()} with ${field.toolName}, in the Spectrum tab`,
                onclick: () => options.onTool(field.tool)
            });
            links.push(value);
        }
        return el('div', { class: 'spectro-fig-cell' }, el('span', { class: 'spectro-fig-cell-label', text: field.label }), value);
    }

    function renderRows() {
        const m = stored();
        cells.replaceChildren();
        rows.replaceChildren();
        inputs.clear();
        links = [];
        if (formOpen) {
            fields.forEach((field) => {
                if (has(m, field) && !isTyped(m, field)) rows.appendChild(el('div', { class: 'spectro-fig-row' },
                    el('span', { class: 'spectro-fig-rowlabel', text: field.label }),
                    el('span', { class: 'spectro-fig-rowvalue', text: field.show(m) })));
                else rows.appendChild(inputRow(field, m));
            });
        } else {
            fields.forEach((field) => cells.appendChild(cell(field, m)));
        }
    }

    function missingFields() {
        const m = stored();
        return fields.filter((f) => !has(m, f));
    }

    function renderOutcome() {
        const m = stored();
        const plotted = options.isPlotted(code);
        const missing = missingFields();
        status.textContent = options.status(code, m) || '';
        status.hidden = !status.textContent;
        summary.textContent = plotted && options.summary ? options.summary(code, m) : '';
        summary.hidden = !summary.textContent;
        cells.hidden = plotted || formOpen;
        rows.hidden = plotted || !formOpen;
        const lines = options.working(code, m);
        hasWorking = !!lines;
        workingBox.hidden = !lines || root.hidden;
        working.replaceChildren(...(lines || []).map((line) => el('span', { text: line })));
        const label = plotted ? options.removeLabel : options.addLabel;
        button.textContent = plotted ? 'Remove' : label;
        button.title = label;
        button.setAttribute('aria-label', `${label}: ${code}`);
        button.hidden = !plotted && !formOpen && missing.length > 0;
        button.classList.toggle('spectro-fig-button-main', !plotted);
        button.classList.toggle('spectro-fig-quiet', plotted);
        typeButton.hidden = plotted || formOpen || missing.length === 0;
        // The "still needed" line stays true as values arrive
        if (plotted || missing.length === 0) message.hidden = true;
        else message.textContent = stillNeeded(missing);
    }

    function stillNeeded(missing) {
        return `Still needed: ${missing.map((f) => f.label.toLowerCase()).join(', ')}.`;
    }

    function openForm(missing) {
        formOpen = true;
        renderRows();
        renderOutcome();
        const first = inputs.get(missing[0]);
        if (first) first.input.focus();
    }

    typeButton.addEventListener('click', () => openForm(missingFields()));

    // Plot and Remove share a place, so a second press that comes too soon after the first, as in a double-click, is a slip
    let pressedAt = -Infinity;
    button.addEventListener('click', (e) => {
        const now = performance.now();
        if (e.detail > 0 && now - pressedAt < 700) return;
        pressedAt = now;
        if (options.isPlotted(code)) {
            options.onRemove(code);
            // Said, as the point goes quietly: its values are kept, so the same button puts it back
            message.textContent = `Taken off. Its values are kept, so ${options.addLabel} puts it back.`;
            message.hidden = false;
            return;
        }
        // A value still in its box counts, even if the box hasn't lost focus yet
        const allGood = [...inputs.entries()].every(([field, { input, errorLine, tick }]) => commit(field, input, errorLine, tick));
        if (!allGood) return;
        const missing = missingFields();
        if (missing.length === 0) {
            formOpen = false;
            options.onAdd(code);
            return;
        }
        message.textContent = stillNeeded(missing);
        message.hidden = false;
        openForm(missing);
    });

    return {
        root,
        setCode(next, heading) {
            if (next !== code) {
                formOpen = false;
                message.hidden = true;
            }
            code = next;
            title.textContent = heading || next;
            // A value being typed into this card leaves the boxes alone, so focus stays put
            if (!committing) renderRows();
            renderOutcome();
        },
        // Called when a measurement arrives
        refresh() {
            if (code === null) return;
            if (!committing) renderRows();
            renderOutcome();
        },
        // Where focus goes on arriving at this card: the next thing to press, unless all that's left is taking it off again
        focusNext() {
            const next = options.isPlotted(code) ? null : [...links, button].find((b) => !b.hidden && b.isConnected);
            (next || title).focus();
        },
        focusTitle(focusOptions) {
            title.focus(focusOptions);
        },
        // The working goes with the card, wherever it is shown
        setHidden(hidden) {
            root.hidden = hidden;
            workingBox.hidden = hidden || !hasWorking;
        }
    };
}

// A switch for a diagram, as a word marked by a line under it when on
export function createToggle(parent, label, onChange, title) {
    const button = el('button', { type: 'button', class: 'spectro-fig-toggle', text: label, title: title || null, 'aria-pressed': 'false' });
    button.addEventListener('click', () => {
        const on = button.getAttribute('aria-pressed') !== 'true';
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        onChange(on);
    });
    parent.appendChild(button);
    return button;
}

// Just arrived with a new point, on a screen too short to hold both the card and the figure: show the figure
export function showFigure(root, figure) {
    const scroller = root.closest('.sim-controls-content');
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const seen = figure.wrap.getBoundingClientRect();
    if (seen.bottom <= box.bottom + 2) return;
    scroller.scrollTop += Math.min(seen.top - box.top - 6, seen.bottom - box.bottom + 6);
}

// ---------- Plots that last through a reload ----------

// The browser may refuse storage, in a private window or on a locked-down school machine: the plot then just lasts as long
// as the page.
export function readSaved(key) {
    try {
        return JSON.parse(localStorage.getItem(key));
    } catch (err) {
        return null;
    }
}

// A saved list read back, checked entry by entry: a damaged save, or one from a sky that has changed since, must not stop a
// tab from starting or put Infinity on a plot. Keeps each object once, only if isRight(code) still says it belongs here,
// and gives any entry without a usable number the next free one. -> [{ code, number, values }]
export function savedEntries(list, isRight) {
    if (!Array.isArray(list)) return [];
    const codes = new Set();
    const numbers = new Set();
    const out = [];
    list.forEach((entry) => {
        if (!entry || typeof entry !== 'object' || typeof entry.code !== 'string' || codes.has(entry.code)) return;
        let right = false;
        try {
            right = isRight(entry.code);
        } catch (err) {
            right = false;
        }
        if (!right) return;
        codes.add(entry.code);
        const { number } = entry;
        const usable = Number.isInteger(number) && number > 0 && number < 1e6 && !numbers.has(number);
        if (usable) numbers.add(number);
        out.push({ code: entry.code, number: usable ? number : null, values: entry.values });
    });
    let next = Math.max(0, ...numbers) + 1;
    out.forEach((entry) => { if (entry.number === null) entry.number = next++; });
    return out;
}

// A saved entry's values, keeping only known numbers within what the tab's own form accepts, and known words.
// limits: { key: [lowest, highest] }; words: { key: [allowed values] }. A typed value is kept on the same terms.
export function cleanSaved(values, limits, words = {}) {
    const out = {};
    if (!values || typeof values !== 'object' || Array.isArray(values)) return out;
    const fits = (key, v) => typeof v === 'number' && Number.isFinite(v) && v >= limits[key][0] && v <= limits[key][1];
    Object.keys(limits).forEach((key) => { if (fits(key, values[key])) out[key] = values[key]; });
    Object.keys(words).forEach((key) => { if (words[key].includes(values[key])) out[key] = values[key]; });
    if (values.typed && typeof values.typed === 'object' && !Array.isArray(values.typed)) {
        const typed = {};
        Object.keys(values.typed).forEach((key) => { if (key in limits && fits(key, values.typed[key])) typed[key] = values.typed[key]; });
        if (Object.keys(typed).length) out.typed = typed;
    }
    return out;
}

export function writeSaved(key, value) {
    try {
        if (value) localStorage.setItem(key, JSON.stringify(value));
        else localStorage.removeItem(key);
    } catch (err) {
        // Nothing to be done: see above
    }
}

// ---------- The list of plotted objects ----------

// focusAfterLast() names what takes keyboard focus when the last row goes. onClear, if given, adds a way to clear the lot,
// which asks first: it can be half an hour's work.
export function createPlottedList(parent, heading, focusAfterLast, onClear) {
    const list = el('ul', { class: 'spectro-fig-list' });
    const clearButton = el('button', { type: 'button', class: 'spectro-fig-hint', text: 'Clear all', hidden: !onClear });
    const sure = el('span', { class: 'spectro-fig-sure', hidden: true });
    const head = el('div', { class: 'spectro-fig-listhead' }, el('p', { class: 'sim-control-group-label', text: heading }), clearButton, sure);
    const root = el('div', { class: 'spectro-fig-listgroup', hidden: true }, head, list);
    parent.appendChild(root);
    let shownRows = 0;

    function askSure(on) {
        sure.hidden = !on;
        clearButton.hidden = on || !onClear;
    }

    clearButton.addEventListener('click', () => {
        sure.replaceChildren(
            el('span', { text: `Clear all ${shownRows}?` }),
            el('button', {
                type: 'button',
                class: 'spectro-fig-hint',
                text: 'Yes, clear',
                onclick: () => {
                    askSure(false);
                    onClear();
                    focusAfterLast().focus();
                }
            }),
            el('button', {
                type: 'button',
                class: 'spectro-fig-hint',
                text: 'Keep them',
                onclick: () => {
                    askSure(false);
                    clearButton.focus();
                }
            }));
        askSure(true);
        sure.querySelector('button').focus();
    });

    return {
        // rows: [{ key, badge, icon, code, detail, current, onSelect, onRemove }]
        update(rows) {
            shownRows = rows.length;
            root.hidden = rows.length === 0;
            const focusedKey = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
            list.replaceChildren(...rows.map((row) => el('li', { class: row.current ? 'is-current' : null },
                el('span', { class: 'spectro-fig-badge' }, row.icon || null, row.badge ? el('span', { text: row.badge }) : null),
                el('button', {
                    type: 'button',
                    class: 'spectro-fig-code',
                    text: row.code,
                    'data-key': `select:${row.key}`,
                    'aria-label': `Select ${row.code}`,
                    'aria-current': row.current ? 'true' : null,
                    onclick: row.onSelect
                }),
                el('span', { class: 'spectro-fig-detail', text: row.detail }),
                el('button', {
                    type: 'button',
                    class: 'spectro-fig-remove',
                    text: '×',
                    'data-key': `remove:${row.key}`,
                    'aria-label': `Remove ${row.code} from the plot`,
                    onclick: row.onRemove
                }))));
            if (focusedKey) {
                const buttons = [...list.querySelectorAll('button')];
                const next = buttons.find((b) => b.dataset.key === focusedKey) || buttons.find((b) => b.classList.contains('spectro-fig-remove'));
                if (next) next.focus();
                else focusAfterLast().focus();
            }
        }
    };
}

// ---------- The table alternative ----------

// A closed disclosure holding the same data as the canvas. rows() returns arrays of cells, each a string or
// { button, label, onClick }. It's only built while it's open.
export function createDataTable(parent, { label, columns, rows }) {
    const table = el('table', { class: 'spectro-fig-table' });
    const scroller = el('div', { class: 'spectro-fig-tablewrap', tabindex: '0', role: 'region', 'aria-label': label }, table);
    const empty = el('p', { class: 'spectro-fig-card-status', text: 'Nothing plotted yet.', hidden: true });
    const details = el('details', { class: 'sim-controls-more spectro-fig-more' }, el('summary', { text: 'Show as table' }), empty, scroller);
    parent.appendChild(details);

    function update() {
        if (!details.open) return;
        const data = rows();
        empty.hidden = data.length > 0;
        scroller.hidden = data.length === 0;
        table.replaceChildren(
            el('caption', { class: 'spectro-fig-sr', text: label }),
            el('thead', {}, el('tr', {}, ...columns.map((c) => el('th', { scope: 'col', text: c })))),
            el('tbody', {}, ...data.map((cells) => el('tr', {}, ...cells.map((cell) => el('td', {}, typeof cell === 'object' && cell
                ? el('button', { type: 'button', class: 'spectro-fig-code', text: cell.button, 'aria-label': cell.label, onclick: cell.onClick })
                : String(cell)))))));
    }
    details.addEventListener('toggle', update);
    return { update, details };
}

// A row of on/off chips in the site's own style
export function createChip(parent, id, label, onChange) {
    const input = el('input', { type: 'checkbox', id, onchange: () => onChange(input.checked) });
    parent.append(input, el('label', { for: id, text: label }));
    return input;
}
