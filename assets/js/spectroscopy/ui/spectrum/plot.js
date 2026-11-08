// The spectrum plot: one or two spectra over one wavelength axis, on a canvas that stays crisp at any pixel
// ratio and follows the site's light and dark themes. Everything that shows a spectrum uses this, so the axis,
// the colour strip and the navigation are the same everywhere.
//
//   const plot = createPlot(container, opts)
//   opts: { lo, hi (the furthest it can go, nm), minRatio (narrowest hi/lo), reduceMotion() -> bool, ariaLabel }
//
//   Data      setSpectrum(sp, label?), setReference(sp|null, label?), setMode('stacked'|'overlay'), getMode()
//   Range     setRange(lo, hi, { animate }), getRange() -> { lo, hi }, setAutoRange(lo, hi), resetRange(),
//             setLimits(lo, hi), setMinRatio(r), zoomBy(factor, anchorNm?), panBy(fractionOfWidth)
//   Mapping   xOf(nm), nmOf(x), yOf(flux, 'body'|'ref'), fluxAt(nm, 'body'|'ref'), panes() (all in CSS pixels of the canvas)
//   Cursor    setCursor(nm|null), getCursor()
//   Events    onClick(fn(nm, e)), onHover(fn(nm|null, e)), onRangeChange(fn(lo, hi)): each returns a function that removes it
//   Drawing   addOverlay(fn(ctx, plot)) -> remove, redraw(now?), showLineLabels(on), labelBand(), setTopCap(note), setFitFloor(on),
//             setAriaLabel(text), dispose()
//   Chrome    stage (the element the panel puts its own controls on), setChrome({ headers, top, refRow }), onLayout(fn(layout))
//
// The panel puts its controls on the plot: a strip across the top (top px), a header over the object's pane (headers px), and
// the reference's row (refRow px) under the object's spectrum: under the axis in overlay, between the panes when stacked.
// The plot leaves room for them and says where they go through onLayout (refRowY, refRowH). Values are read where the pointer is: the wavelength
// on the axis, and each spectrum's value beside its point.
//
// The plot is pinned in its panel, so the wheel is the plot's: it zooms about the pointer, and a sideways scroll pans. A touch
// pinch, a mouse drag up and down, the keys and the panel's buttons zoom as well.
//
// An overlay is drawn after the spectra each time the plot redraws, in CSS pixels; call redraw() when its own state
// changes. Wavelengths in the visible are coloured with wavelengthToRgb, and wavelengthScale and wavelengthTicks are
// the axis itself, for anything else that needs the same one.
//
// A Spectrum is what spectra/synth.js returns: { wl (nm, ascending), flux, continuum, lines, snr, mode, note }.

import { SPECTRUM_LO_NM, SPECTRUM_HI_NM } from '../../core/phys.js';
import { sig, wavelength, superscript } from '../../core/format.js';

export const VISIBLE_LO_NM = 380;
export const VISIBLE_HI_NM = 750;

export const WAVELENGTH_PRESETS = [
    { id: 'uv', label: 'UV', title: 'Ultraviolet: 90 to 380 nm', lo: 90, hi: 380 },
    { id: 'lya', label: 'Lyman-α', title: 'Around the Lyman-α line at 121.6 nm', lo: 114, hi: 129 },
    { id: 'visible', label: 'Visible', title: 'Visible light: 380 to 750 nm', lo: VISIBLE_LO_NM, hi: VISIBLE_HI_NM },
    { id: 'halpha', label: 'Hα', title: 'Around the Hα line at 656.3 nm', lo: 648, hi: 665 },
    { id: 'cahk', label: 'Ca H & K', title: 'Around the Ca II H and K lines at 396.8 and 393.4 nm', lo: 385, hi: 405 },
    { id: 'nad', label: 'Na D', title: 'Around the Na D lines at 589.0 and 589.6 nm', lo: 584, hi: 595 },
    { id: 'nir', label: 'Near-IR', title: 'Near-infrared: 750 nm to 5 µm', lo: VISIBLE_HI_NM, hi: 5000 },
    { id: 'full', label: 'Full range', title: 'The whole range: 90 nm to 5 µm', lo: SPECTRUM_LO_NM, hi: SPECTRUM_HI_NM }
];

// ---------- The wavelength axis ----------

// Below LOG_FROM the axis is linear, as textbook spectra are, and above LOG_TO it is logarithmic. In between it
// blends, so zooming out never makes the axis jump between the two.
const LOG_FROM = Math.log(2.2);
const LOG_TO = Math.log(4);

export function wavelengthScale(lo, hi, left, width) {
    const lnSpan = Math.log(hi / lo);
    const s = Math.min(1, Math.max(0, (lnSpan - LOG_FROM) / (LOG_TO - LOG_FROM)));
    const t = s * s * (3 - 2 * s);

    const uOf = (nm) => {
        const a = (nm - lo) / (hi - lo);
        if (t === 0) return a;
        const b = Math.log(nm / lo) / lnSpan;
        return t === 1 ? b : a + (b - a) * t;
    };

    const nmOfU = (u) => {
        if (t === 0) return lo + u * (hi - lo);
        if (t === 1 || u <= 0 || u >= 1) return lo * Math.exp(u * lnSpan);
        let a = lo;
        let b = hi;
        for (let i = 0; i < 32 && b - a > 1e-6 * a; i++) {
            const m = 0.5 * (a + b);
            if (uOf(m) < u) a = m;
            else b = m;
        }
        return 0.5 * (a + b);
    };

    return {
        lo,
        hi,
        left,
        width,
        t,
        isLog: t >= 0.5,
        xOf: (nm) => left + width * uOf(nm),
        nmOf: (x) => nmOfU((x - left) / width)
    };
}

function tickLabel(nm, step) {
    if (nm >= 999.5) {
        const digits = Math.max(0, Math.ceil(-Math.log10(step / 1000) - 1e-9));
        return `${(nm / 1000).toFixed(digits)} µm`;
    }
    const digits = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
    return `${nm.toFixed(digits)} nm`;
}

function plainMum(nm) {
    return nm >= 999.5 ? `${Number((nm / 1000).toFixed(3))} µm` : `${Number(nm.toFixed(3))} nm`;
}

function ticksFit(list, scale, measure, gap) {
    let last = -Infinity;
    for (const tick of list) {
        const w = measure(tick.label);
        const x0 = Math.max(scale.left - 30, Math.min(tick.x - w / 2, scale.left + scale.width + 8 - w));
        if (x0 < last + gap) return false;
        last = x0 + w;
    }
    return true;
}

// Round numbers that fit without touching, in nm below 1 µm and µm above. measure(text) -> width in pixels.
export function wavelengthTicks(scale, measure, gap = 10) {
    const { lo, hi } = scale;
    const inRange = (v) => v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9);

    if (scale.isLog) {
        const eLo = Math.floor(Math.log10(lo));
        const eHi = Math.ceil(Math.log10(hi));
        const sets = [[1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 1.5, 2, 3, 4, 5, 7], [1, 2, 3, 5], [1, 2, 5], [1, 3], [1]];
        for (const set of sets) {
            const major = [];
            for (let e = eLo; e <= eHi; e++) {
                set.forEach((m) => {
                    const v = m * 10 ** e;
                    if (inRange(v)) major.push({ nm: v, x: scale.xOf(v), label: plainMum(v) });
                });
            }
            if (major.length >= 2 && ticksFit(major, scale, measure, gap)) {
                const minor = [];
                for (let e = eLo; e <= eHi; e++) {
                    for (let m = 1; m < 10; m++) {
                        const v = m * 10 ** e;
                        if (inRange(v) && !major.some((t) => Math.abs(t.nm - v) < 1e-6 * v)) minor.push(scale.xOf(v));
                    }
                }
                return { major, minor };
            }
        }
    }

    const span = hi - lo;
    let e = Math.floor(Math.log10(span / 20));
    for (let tries = 0; tries < 24; tries++, e += tries % 3 === 0 ? 1 : 0) {
        const mant = [1, 2, 5][tries % 3];
        const step = mant * 10 ** e;
        const first = Math.ceil(lo / step - 1e-9);
        const last = Math.floor(hi / step + 1e-9);
        if (last - first > 40) continue;
        const major = [];
        for (let i = first; i <= last; i++) {
            const v = i * step;
            major.push({ nm: v, x: scale.xOf(v), label: tickLabel(v, step) });
        }
        if (major.length && ticksFit(major, scale, measure, gap)) {
            const minorStep = step / (mant === 2 ? 2 : 5);
            const minor = [];
            const a = Math.ceil(lo / minorStep - 1e-9);
            const b = Math.floor(hi / minorStep + 1e-9);
            if (b - a < 400) {
                for (let i = a; i <= b; i++) {
                    const v = i * minorStep;
                    if (Math.abs(v / step - Math.round(v / step)) > 1e-6) minor.push(scale.xOf(v));
                }
            }
            return { major, minor };
        }
    }
    return { major: [], minor: [] };
}

// ---------- The colour of light ----------

// The colour of a wavelength in 380-750 nm, as 0..255 sRGB (after Dan Bruton's fit), dimming towards both ends
// of the visible, where the eye loses it. Outside the visible it returns null.
export function wavelengthToRgb(nm) {
    if (nm < VISIBLE_LO_NM || nm > VISIBLE_HI_NM) return null;
    let r = 0;
    let g = 0;
    let b = 0;
    if (nm < 440) { r = (440 - nm) / 60; b = 1; }
    else if (nm < 490) { g = (nm - 440) / 50; b = 1; }
    else if (nm < 510) { g = 1; b = (510 - nm) / 20; }
    else if (nm < 580) { r = (nm - 510) / 70; g = 1; }
    else if (nm < 645) { r = 1; g = (645 - nm) / 65; }
    else r = 1;
    const fade = nm < 420 ? 0.35 + (0.65 * (nm - 380)) / 40 : nm > 700 ? 1 - (0.5 * (nm - 700)) / 50 : 1;
    const shape = (c) => Math.round(255 * (c * fade) ** 0.8);
    return [shape(r), shape(g), shape(b)];
}

// ---------- Helpers ----------

function lowerBound(wl, nm) {
    let a = 0;
    let b = wl.length;
    while (a < b) {
        const m = (a + b) >> 1;
        if (wl[m] < nm) a = m + 1;
        else b = m;
    }
    return a;
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

// How many standard deviations a sample in a column has to stand out by before it counts as a feature, not noise.
// At 4.5, a whole 40,000-sample spectrum of pure noise has about a 1 in 8 chance of a single false feature.
const OUTLIER_SD = 4.5;

const OVERLAY_DASH = [6, 4];

function isNoisy(sp) {
    return Number.isFinite(sp.snr) && sp.snr > 0;
}

// The noise in a spectrum, as k in sigma = k * sqrt(flux). Differences between neighbouring samples give it, since
// lines are too few to move their median; 1.4826 turns a median deviation into a standard deviation.
function measureNoise(sp, fluxPeak) {
    if (!isNoisy(sp)) return 0;
    const { flux } = sp;
    const stride = Math.max(1, Math.floor(flux.length / 6000));
    const floor = 1e-3 * fluxPeak;
    const values = [];
    for (let i = 0; i + 1 < flux.length; i += stride) {
        if (flux[i] > floor) values.push(Math.abs(flux[i + 1] - flux[i]) / Math.sqrt(flux[i]));
    }
    if (values.length < 16) return 0;
    values.sort((a, b) => a - b);
    return (values[values.length >> 1] * 1.4826) / Math.SQRT2;
}

// A y axis's ticks from bottom (usually 0) up to top: round numbers, shown as a mantissa with any power of ten said once in the title
function yTicks(top, maxTicks = 3, bottom = 0) {
    const exp = top < 0.01 || top >= 1000 ? Math.floor(Math.log10(top)) : 0;
    const scaled = top / 10 ** exp;
    const floor = bottom / 10 ** exp;
    const rawStep = (scaled - floor) / maxTicks;
    const e = Math.floor(Math.log10(rawStep));
    const m = rawStep / 10 ** e;
    const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * 10 ** e;
    const digits = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
    const ticks = [];
    for (let i = Math.ceil(floor / step - 1e-9); i * step <= scaled * (1 + 1e-9); i++) {
        ticks.push({ value: i * step * 10 ** exp, label: i === 0 ? '0' : (i * step).toFixed(digits) });
    }
    return { ticks, exp };
}

function makeSeries() {
    return { sp: null, label: '', key: '', cols: null, top: 1, bottom: 0, exp: 0, peak: 0, fluxPeak: 0, noiseK: 0, emissive: false, strip: null, paneNote: '', capNote: '', capped: false };
}

function makeColumns(n) {
    return {
        n,
        nm: new Float64Array(n),
        min: new Float32Array(n),
        max: new Float32Array(n),
        lineMin: new Float32Array(n),
        lineMax: new Float32Array(n),
        cont: new Float32Array(n),
        noise: new Float32Array(n),
        count: new Int32Array(n)
    };
}

// ---------- The component ----------

export function createPlot(container, opts = {}) {
    const root = document.createElement('div');
    root.className = 'spectro-plot';

    const stage = document.createElement('div');
    stage.className = 'spectro-plot-stage';

    const canvas = document.createElement('canvas');
    canvas.className = 'spectro-plot-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'slider');
    canvas.setAttribute('aria-roledescription', 'spectrum plot');
    canvas.setAttribute('aria-orientation', 'horizontal');
    canvas.setAttribute('aria-label', opts.ariaLabel || 'Spectrum');

    const cursorCanvas = document.createElement('canvas');
    cursorCanvas.className = 'spectro-plot-cursor';
    cursorCanvas.setAttribute('aria-hidden', 'true');

    stage.append(canvas, cursorCanvas);
    root.append(stage);
    container.appendChild(root);

    const ctx = canvas.getContext('2d');
    const cursorCtx = cursorCanvas.getContext('2d');
    const reduceMotion = opts.reduceMotion || (() => false);

    let limitLo = opts.lo ?? SPECTRUM_LO_NM;
    let limitHi = opts.hi ?? SPECTRUM_HI_NM;
    let minRatio = opts.minRatio ?? 1.002;
    let lo = VISIBLE_LO_NM;
    let hi = VISIBLE_HI_NM;
    let autoLo = lo;
    let autoHi = hi;
    let mode = 'stacked';
    let labelsOn = false;
    let cursorNm = null;
    let fitFloor = false;

    // Room kept for the panel's own controls: a strip across the top, a header over the object's pane, and the reference's row,
    // which is under the object's spectrum: under its axis in overlay, and between the two panes when they are stacked
    const chrome = { headers: 26, top: 32, refRow: 0, refLine: 0 };
    const layoutFns = new Set();
    let layoutKey = '';

    let cssW = 0;
    let cssH = 0;
    let dpr = 1;
    let layout = null;
    let scale = wavelengthScale(lo, hi, 0, 1);
    let tokens = null;
    let hatch = null;
    let queued = 0;
    let tween = 0;
    let disposed = false;
    let lastDrawMs = 0;

    // If the graphics process restarts, the browser gives a canvas back empty: draw it again
    canvas.addEventListener('contextrestored', () => {
        hatch = null;
        redraw(true);
    });
    cursorCanvas.addEventListener('contextrestored', () => drawCursor());

    const series = { body: makeSeries(), ref: makeSeries() };
    const overlays = new Set();
    const clickFns = new Set();
    const hoverFns = new Set();
    const rangeFns = new Set();

    // ---------- Theme ----------

    function readTokens() {
        const cs = getComputedStyle(root);
        const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
        tokens = {
            ink: v('--color-text', '#585858'),
            well: v('--spectro-plot-well', v('--color-bg', '#ffffff')),
            grid: v('--spectro-plot-grid', v('--color-border', '#c9c9c9')),
            body: v('--spectro-plot-body', '#b3264f'),
            ref: v('--spectro-plot-ref', '#0b6bab'),
            uv: v('--spectro-plot-uv', 'rgba(111, 66, 193, 0.08)'),
            ir: v('--spectro-plot-ir', 'rgba(200, 80, 40, 0.07)'),
            font: cs.fontFamily || 'sans-serif'
        };
        hatch = null;
    }

    const themeWatch = new MutationObserver(() => {
        tokens = null;
        redraw();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    function fontOf(size, weight = 400) {
        return `${weight} ${size}px ${tokens.font}`;
    }

    // The diagonal hatching over the UV and IR parts of a strip, at whole device pixels
    function hatchPattern(emissive) {
        if (!hatch) hatch = {};
        const key = emissive ? 'em' : 'abs';
        if (hatch[key]) return hatch[key];
        const size = Math.round(5 * dpr);
        const tile = document.createElement('canvas');
        tile.width = size;
        tile.height = size;
        const t = tile.getContext('2d');
        t.strokeStyle = emissive ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.26)';
        t.lineWidth = Math.max(1, dpr * 0.9);
        t.beginPath();
        t.moveTo(-1, size + 1);
        t.lineTo(size + 1, -1);
        t.moveTo(-1, 1);
        t.lineTo(1, -1);
        t.moveTo(size - 1, size + 1);
        t.lineTo(size + 1, size - 1);
        t.stroke();
        const pattern = ctx.createPattern(tile, 'repeat');
        if (pattern.setTransform) pattern.setTransform(new DOMMatrix().scale(1 / dpr));
        hatch[key] = pattern;
        return pattern;
    }

    // ---------- Layout ----------

    function hasRef() {
        return !!series.ref.sp;
    }

    function computeLayout() {
        const compact = cssH < 240;
        const left = 34;
        const right = 10;
        const plotW = Math.max(10, cssW - left - right);
        const rulerH = chrome.top;
        const titleH = chrome.headers;
        // The colour strip under each spectrum: tall enough to read the lines in it as bands of colour
        const stripH = compact ? 15 : 20;
        const stripGap = 2;
        const paneGap = compact ? 4 : 7;
        const axisH = 20;
        const refRowH = chrome.refRow || titleH;
        // The reference's key goes beside its name, on the row's first line if it has two
        const refKeyH = Math.min(refRowH, chrome.refLine || refRowH);
        const base = { x: left, w: plotW, stripH };
        let body;
        let ref = null;
        let refRowY;
        let axisY;
        if (mode === 'overlay' || !hasRef()) {
            // One pane, with the reference's row under its axis: the row is there even with no reference, to choose one
            const strips = hasRef() ? 2 : 1;
            const h = Math.max(20, cssH - rulerH - titleH - strips * (stripH + stripGap) - axisH - refRowH);
            const y = rulerH + titleH;
            body = { ...base, titleY: rulerH, titleH, y, h, stripY: y + h + stripGap };
            const lastStrip = hasRef() ? body.stripY + stripH + stripGap : body.stripY;
            axisY = lastStrip + stripH;
            refRowY = axisY + axisH;
            if (hasRef()) ref = { ...base, titleY: refRowY, titleH: refKeyH, y, h, stripY: lastStrip };
        } else {
            // Stacked: the reference's row straight under the object's spectrum, and the two panes the same height
            const free = Math.max(40, cssH - rulerH - titleH - refRowH - 2 * (stripH + stripGap) - paneGap - axisH);
            const bodyH = Math.round(free * 0.5);
            const refH = free - bodyH;
            const y0 = rulerH + titleH;
            body = { ...base, titleY: rulerH, titleH, y: y0, h: bodyH, stripY: y0 + bodyH + stripGap };
            refRowY = body.stripY + stripH + paneGap;
            ref = { ...base, titleY: refRowY, titleH: refKeyH, y: refRowY + refRowH, h: refH, stripY: refRowY + refRowH + refH + stripGap };
            axisY = ref.stripY + stripH;
        }
        return {
            refRowY,
            refRowH,
            left,
            right: left + plotW,
            plotW,
            compact,
            rulerH,
            titleH,
            stripH,
            body,
            ref,
            top: rulerH,
            axisY,
            bottom: cssH
        };
    }

    function ensureLayout() {
        if (!layout) {
            layout = computeLayout();
            scale = wavelengthScale(lo, hi, layout.left, layout.plotW);
        }
        return layout;
    }

    // Height of the band at the top of a pane that holds line labels. Labels name the reference's lines only, so that matching
    // them to the object's own dips is still the student's to do: the object's pane has a band only when the reference is laid
    // over it.
    function labelBand(pane) {
        if (!labelsOn || !hasRef()) return 0;
        if (layout && pane === layout.body && !(mode === 'overlay')) return 0;
        const rows = labelRows(pane);
        return rows * 12 + 2;
    }

    function labelRows(pane) {
        if (mode === 'overlay' && hasRef()) return pane.h > 150 ? 3 : 2;
        return pane.h > 70 ? 2 : 1;
    }

    // ---------- Columns: at most one min and one max for each device pixel across the plot ----------

    function ensureColumns(s, which) {
        if (!s.sp) {
            s.cols = null;
            return;
        }
        const n = Math.max(1, Math.round(layout.plotW * dpr));
        const key = `${lo}|${hi}|${n}`;
        if (s.key === key && s.cols) return;
        s.key = key;
        if (!s.cols || s.cols.n !== n) s.cols = makeColumns(n);
        const c = s.cols;
        const { wl, flux, continuum } = s.sp;
        const N = wl.length;
        const left = layout.left;
        let i = lowerBound(wl, scale.nmOf(left));
        const k = s.noiseK;
        let peak = 0;
        let linePeak = 0;
        let lineLow = Infinity;
        let contPeak = 0;
        let excess = 0;
        let any = false;
        let flat = true;
        for (let col = 0; col < n; col++) {
            const mid = scale.nmOf(left + (col + 0.5) / dpr);
            const end = col === n - 1 ? hi * (1 + 1e-9) : scale.nmOf(left + (col + 1) / dpr);
            let fMin = Infinity;
            let fMax = -Infinity;
            let fSum = 0;
            let cSum = 0;
            let count = 0;
            while (i < N && wl[i] < end) {
                const f = flux[i];
                if (f === f) {
                    if (f < fMin) fMin = f;
                    if (f > fMax) fMax = f;
                    fSum += f;
                    cSum += continuum ? continuum[i] : 0;
                    count++;
                }
                i++;
            }
            c.nm[col] = mid;
            c.count[col] = count;
            if (count === 0) {
                // Fewer samples than pixels: read between the samples either side
                if (i > 0 && i < N) {
                    const a = i - 1;
                    const w = (mid - wl[a]) / (wl[i] - wl[a]);
                    if (w >= 0 && w <= 1) {
                        const f = flux[a] + (flux[i] - flux[a]) * w;
                        fMin = f;
                        fMax = f;
                        fSum = f;
                        cSum = continuum ? continuum[a] + (continuum[i] - continuum[a]) * w : 0;
                        count = 1;
                    }
                }
                if (count === 0 || fMax !== fMax) {
                    c.min[col] = NaN;
                    c.max[col] = NaN;
                    c.lineMin[col] = NaN;
                    c.lineMax[col] = NaN;
                    c.cont[col] = 0;
                    c.noise[col] = 0;
                    continue;
                }
            }
            any = true;
            if (fMax > peak) peak = fMax;
            const mean = fSum / count;
            const cont = cSum / count;
            const sigma = k * Math.sqrt(Math.max(mean, 1e-6));
            // The bold line of a noisy spectrum: the column's mean, except where a sample stands too far out to be noise
            let lineMin = fMin;
            let lineMax = fMax;
            if (k > 0 && c.count[col] >= 4) {
                const reach = OUTLIER_SD * sigma;
                if (mean - fMin < reach) lineMin = mean;
                if (fMax - mean < reach) lineMax = mean;
            }
            if (cont > 0 && (lineMin < 0.995 * cont || lineMax > 1.005 * cont)) flat = false;
            if (lineMax > linePeak) linePeak = lineMax;
            if (lineMin < lineLow) lineLow = lineMin;
            if (cont > contPeak) contPeak = cont;
            if (lineMax - cont > excess) excess = lineMax - cont;
            c.min[col] = fMin;
            c.max[col] = fMax;
            c.lineMin[col] = lineMin;
            c.lineMax[col] = lineMax;
            c.cont[col] = cont;
            c.noise[col] = sigma;
        }
        // The scale fits the line, with room for most of the noise around it but not for its wildest spikes
        s.peak = peak;
        s.top = peak > 0 ? Math.max(1.06 * linePeak, Math.min(1.02 * peak, 1.25 * linePeak)) : 1;
        // Asked to: a part of the range that climbs far above the rest doesn't get to squash the rest flat. It runs off
        // the top instead, and the plot says so.
        s.capped = false;
        if (s.capNote && any) {
            const values = Array.from(c.lineMax).filter((v) => v === v).sort((x, y) => x - y);
            const cap = 1.8 * values[values.length >> 1];
            if (cap > 0 && s.top > 1.25 * cap) {
                s.top = cap;
                s.capped = true;
            }
        }
        // Say so when a range has nothing to show, rather than leave a drawing that looks broken
        s.paneNote = '';
        if (s.emissive ? excess < 1e-3 * s.fluxPeak : (s.sp.mode === 'absorption' && flat)) {
            if (which === 'ref') s.paneNote = 'No lines from this reference in this range';
            // A flat line isn't scaled up to fill the pane, or it would look like a strong signal
            if (s.emissive) s.top = 1.06 * s.fluxPeak;
        } else if (k > 0 && any && contPeak <= 3 * k * Math.sqrt(contPeak) && !s.emissive) {
            s.paneNote = 'Too faint here to show more than noise';
            // Nor is noise scaled up to fill the pane, or its spikes would look like lines
            if (linePeak < 0.01 * s.fluxPeak) s.top = 0.01 * s.fluxPeak;
        }
        // Asked to, for a close look at one line: the axis runs from just under the deepest point in view to just over the
        // highest, so a shallow line fills the pane instead of lying flat along its top
        s.bottom = 0;
        if (typeof fitFloor === 'number' && any && !s.paneNote && !s.capped && fitFloor > 0 && fitFloor < 1
            && lineLow >= linePeak * (fitFloor - 0.3 * (1 - fitFloor))) {
            // A floor held at a share of the top, for lines that move: the scale stays put while they do. Zoomed out to where
            // much falls below it, the axis goes back to zero.
            s.top = linePeak * (1 + 0.1 * (1 - fitFloor));
            s.bottom = fitFloor * linePeak;
        } else if (fitFloor === true && any && !s.paneNote && !s.capped && lineLow > 0 && linePeak - lineLow < 0.7 * linePeak) {
            // Never closer than 3% of the level, or a featureless stretch would blow its noise up into lines
            const pad = Math.max(0.12 * (linePeak - lineLow), 0.5 * (0.03 * linePeak - (linePeak - lineLow)));
            s.top = linePeak + pad;
            s.bottom = Math.max(0, lineLow - pad);
        }
        paintStrip(s);
    }

    // A strip is one pixel tall in memory and stretched when drawn, so its colours are only worked out when the
    // data or the range changes. Absorption darkens the rainbow; emission glows on black.
    function paintStrip(s) {
        const c = s.cols;
        if (!s.strip || s.strip.width !== c.n) {
            s.strip = document.createElement('canvas');
            s.strip.width = c.n;
            s.strip.height = 1;
            s.stripCtx = s.strip.getContext('2d');
            s.stripImg = s.stripCtx.createImageData(c.n, 1);
        }
        const px = s.stripImg.data;
        const emissive = s.emissive;
        const peak = s.fluxPeak > 0 ? s.fluxPeak : 1;
        if (emissive) {
            // A bright line one pixel wide on black is hard to see, so each spreads a little on the strip. Its level
            // is lifted too, so weak lines still show, as they do to the eye in a lamp's spectrum.
            if (!s.glow || s.glow.length !== c.n) s.glow = new Float32Array(c.n);
            const reach = Math.max(1, Math.round(dpr));
            s.glow.fill(0);
            for (let col = 0; col < c.n; col++) {
                const top = c.lineMax[col];
                if (top !== top) continue;
                const level = clamp01((top - c.cont[col] - 3 * c.noise[col]) / peak) ** 0.38;
                if (level <= 0) continue;
                const a = Math.max(0, col - reach);
                const b = Math.min(c.n - 1, col + reach);
                for (let j = a; j <= b; j++) if (level > s.glow[j]) s.glow[j] = level;
            }
        }
        for (let col = 0; col < c.n; col++) {
            const rgb = wavelengthToRgb(c.nm[col]);
            let r;
            let g;
            let b;
            if (emissive) {
                const level = s.glow[col];
                if (rgb) {
                    r = 8 + (rgb[0] - 8) * level;
                    g = 8 + (rgb[1] - 8) * level;
                    b = 8 + (rgb[2] - 8) * level;
                } else {
                    r = 34 + 196 * level;
                    g = r;
                    b = r;
                }
            } else {
                // Dips and rises against the continuum. Where the continuum is lost in the noise that comparison means
                // nothing, and when a column has too few samples to average, its noise is allowed for.
                const cont = c.cont[col];
                const sigma = c.noise[col];
                const usable = cont > 0 && c.max[col] === c.max[col] && !(sigma > 0 && (cont < 1e-3 * peak || sigma > 0.25 * cont));
                const allow = usable && c.count[col] < 4 ? (2.5 * sigma) / cont : 0;
                const dip = usable ? Math.max(0, 1 - c.lineMin[col] / cont - allow) : 0;
                const rise = usable ? Math.max(0, c.lineMax[col] / cont - 1 - allow) : 0;
                const dark = (1 - Math.min(1, dip)) ** 2;
                const lift = Math.min(1, rise * 2);
                const base = rgb || [150, 150, 154];
                r = base[0] * dark;
                g = base[1] * dark;
                b = base[2] * dark;
                r += (255 - r) * lift;
                g += (255 - g) * lift;
                b += (255 - b) * lift;
            }
            const o = col * 4;
            px[o] = r;
            px[o + 1] = g;
            px[o + 2] = b;
            px[o + 3] = 255;
        }
        s.stripCtx.putImageData(s.stripImg, 0, 0);
    }

    // ---------- Base layer ----------

    function snap(v) {
        return (Math.round(v * dpr - 0.5) + 0.5) / dpr;
    }

    function yOfPane(flux, s, pane) {
        const band = labelBand(pane);
        return pane.y + pane.h - ((flux - s.bottom) / (s.top - s.bottom)) * (pane.h - band);
    }

    function drawWell(pane) {
        ctx.fillStyle = tokens.well;
        ctx.fillRect(pane.x, pane.y, pane.w, pane.h);
        const a = scale.xOf(VISIBLE_LO_NM);
        const b = scale.xOf(VISIBLE_HI_NM);
        if (lo < VISIBLE_LO_NM) {
            ctx.fillStyle = tokens.uv;
            ctx.fillRect(pane.x, pane.y, Math.min(a, pane.x + pane.w) - pane.x, pane.h);
        }
        if (hi > VISIBLE_HI_NM) {
            const from = Math.max(b, pane.x);
            ctx.fillStyle = tokens.ir;
            ctx.fillRect(from, pane.y, pane.x + pane.w - from, pane.h);
        }
    }

    function drawGrid(pane, ticks) {
        ctx.save();
        ctx.strokeStyle = tokens.grid;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1 / dpr;
        ctx.beginPath();
        ticks.major.forEach((tick) => {
            const x = snap(tick.x);
            ctx.moveTo(x, pane.y);
            ctx.lineTo(x, pane.y + pane.h);
        });
        ctx.stroke();
        ctx.restore();
    }

    function drawRegionEdges(pane) {
        ctx.save();
        ctx.strokeStyle = tokens.ink;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1 / dpr;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        [VISIBLE_LO_NM, VISIBLE_HI_NM].forEach((nm) => {
            if (nm > lo && nm < hi) {
                const x = snap(scale.xOf(nm));
                ctx.moveTo(x, pane.y);
                ctx.lineTo(x, pane.y + pane.h);
            }
        });
        ctx.stroke();
        ctx.restore();
    }

    function drawYAxis(pane, s) {
        const band = labelBand(pane);
        const { ticks, exp } = yTicks(s.top, pane.h - band < 64 ? 2 : 3, s.bottom);
        s.exp = exp;
        ctx.save();
        ctx.strokeStyle = tokens.grid;
        ctx.lineWidth = 1 / dpr;
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ticks.forEach((tick) => {
            if (tick.value === 0) return;
            const y = snap(yOfPane(tick.value, s, pane));
            ctx.moveTo(pane.x, y);
            ctx.lineTo(pane.x + pane.w, y);
        });
        ctx.stroke();
        // An axis that doesn't start at zero says so, with the usual break at its foot
        if (s.bottom > 0) {
            const x = pane.x;
            const y = pane.y + pane.h - 6;
            ctx.globalAlpha = 1;
            ctx.strokeStyle = tokens.ink;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(x - 4, y + 2);
            ctx.lineTo(x + 4, y - 1);
            ctx.moveTo(x - 4, y + 5);
            ctx.lineTo(x + 4, y + 2);
            ctx.stroke();
        }
        ctx.restore();

        ctx.fillStyle = tokens.ink;
        ctx.font = fontOf(11);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ticks.forEach((tick) => {
            const y = yOfPane(tick.value, s, pane);
            ctx.fillText(tick.label, pane.x - 5, Math.max(pane.y + 5, Math.min(pane.y + pane.h - 5, y)));
        });
    }

    function drawSeries(pane, s, colour, { fill = 0.13, alpha = 1, dash = null } = {}) {
        const c = s.cols;
        if (!c) return;
        const band = labelBand(pane);
        const k = (pane.h - band) / (s.top - s.bottom);
        // Where zero would be, so that a raised floor needs no change below
        const bottom = pane.y + pane.h + s.bottom * k;
        const left = layout.left;

        ctx.save();
        ctx.beginPath();
        ctx.rect(pane.x, pane.y, pane.w, pane.h);
        ctx.clip();

        if (fill) {
            ctx.fillStyle = colour;
            ctx.globalAlpha = fill;
            ctx.beginPath();
            let open = false;
            let lastX = 0;
            for (let i = 0; i < c.n; i++) {
                const m = c.lineMax[i];
                if (m !== m) {
                    if (open) { ctx.lineTo(lastX, bottom); ctx.closePath(); open = false; }
                    continue;
                }
                const x = left + (i + 0.5) / dpr;
                if (!open) { ctx.moveTo(x, bottom); open = true; }
                ctx.lineTo(x, bottom - m * k);
                lastX = x;
            }
            if (open) { ctx.lineTo(lastX, bottom); ctx.closePath(); }
            ctx.fill();
        }

        const trace = (topOf, bottomOf) => {
            ctx.beginPath();
            let pen = false;
            for (let i = 0; i < c.n; i++) {
                const mx = topOf[i];
                if (mx !== mx) { pen = false; continue; }
                const x = left + (i + 0.5) / dpr;
                const y1 = bottom - mx * k;
                const y2 = bottom - bottomOf[i] * k;
                if (!pen) { ctx.moveTo(x, y1); pen = true; }
                else ctx.lineTo(x, y1);
                if (y2 - y1 > 0.4) ctx.lineTo(x, y2);
            }
            ctx.stroke();
        };
        ctx.strokeStyle = colour;
        ctx.lineJoin = 'round';
        if (s.noiseK > 0) {
            // The full spread of the noise, faintly, behind the line it scatters around
            ctx.globalAlpha = alpha * 0.32;
            ctx.lineWidth = 1;
            trace(c.max, c.min);
        }
        ctx.globalAlpha = alpha;
        ctx.lineWidth = dash ? 1.5 : 1.3;
        if (dash) ctx.setLineDash(dash);
        trace(c.lineMax, c.lineMin);
        ctx.restore();
    }

    function drawStrip(pane, s) {
        const y = pane.stripY;
        const h = pane.stripH;
        ctx.fillStyle = tokens.grid;
        ctx.fillRect(pane.x, y, pane.w, h);
        if (!s.sp || !s.cols) return;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(s.strip, 0, 0, s.cols.n, 1, pane.x, y, pane.w, h);

        const zones = [];
        if (lo < VISIBLE_LO_NM) zones.push({ a: pane.x, b: Math.min(scale.xOf(VISIBLE_LO_NM), pane.x + pane.w), label: 'UV', side: -1 });
        if (hi > VISIBLE_HI_NM) zones.push({ a: Math.max(scale.xOf(VISIBLE_HI_NM), pane.x), b: pane.x + pane.w, label: 'IR', side: 1 });
        zones.forEach((zone) => {
            if (zone.b - zone.a <= 0) return;
            ctx.fillStyle = hatchPattern(s.emissive);
            ctx.fillRect(zone.a, y, zone.b - zone.a, h);
            if (zone.b - zone.a >= 24 && h >= 10) {
                ctx.font = fontOf(h >= 13 ? 10.5 : 9, 700);
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const text = zone.label;
                const w = ctx.measureText(text).width + 6;
                // At the outer end of the zone, where it is least likely to hide a line
                const cx = zone.side < 0 ? zone.a + 2 + w / 2 : zone.b - 2 - w / 2;
                ctx.fillStyle = s.emissive ? '#000000' : '#ffffff';
                ctx.globalAlpha = 0.72;
                ctx.fillRect(cx - w / 2, y + 1, w, h - 2);
                ctx.globalAlpha = 1;
                ctx.fillStyle = s.emissive ? '#ffffff' : '#000000';
                ctx.fillText(text, cx, y + h / 2 + 0.5);
            }
        });
    }

    function ellipsize(text, maxWidth) {
        if (ctx.measureText(text).width <= maxWidth) return text;
        let lo2 = 0;
        let hi2 = text.length;
        while (lo2 < hi2) {
            const m = (lo2 + hi2 + 1) >> 1;
            if (ctx.measureText(`${text.slice(0, m)}…`).width <= maxWidth) lo2 = m;
            else hi2 = m - 1;
        }
        return `${text.slice(0, lo2)}…`;
    }

    // The name above a pane, next to a key mark: solid for the object, hollow for the reference, so the two differ
    // without relying on colour. Text stays in the text colour.
    function drawKey(x, y, colour, hollow) {
        const size = 8;
        const top = y - size / 2;
        if (hollow) {
            ctx.strokeStyle = colour;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x + 0.75, top + 0.75, size - 1.5, size - 1.5);
        } else {
            ctx.fillStyle = colour;
            ctx.fillRect(x, top, size, size);
        }
        return x + size + 4;
    }

    // A sample of the line itself, for overlay, where the two curves are told apart by being solid or dashed
    function drawLineKey(x, y, colour, dashed) {
        const length = 20;
        ctx.save();
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2;
        if (dashed) ctx.setLineDash(OVERLAY_DASH);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + length, y);
        ctx.stroke();
        ctx.restore();
        return x + length + 4;
    }

    // The pane's key, and for the object its name. The reference's name is the panel's picker, in the same row. The unit of
    // the scale is in the gutter beside it.
    function drawTitle(pane, s, which) {
        const y = pane.titleY + pane.titleH / 2 + 0.5;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = tokens.ink;
        ctx.font = fontOf(11);
        ctx.fillText('flux', 6, y);
        const x = drawKey(pane.x, y, which === 'body' ? tokens.body : tokens.ref, which === 'ref');
        if (which === 'ref') return;
        ctx.font = fontOf(11.5, 700);
        ctx.fillText(ellipsize(s.label || 'This object', pane.w * 0.4), x, y);
    }

    function drawOverlayTitle(pane) {
        const y = pane.titleY + pane.titleH / 2 + 0.5;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        // A row each: the object's above its spectrum, and the reference's under it, where its name is the panel's own control
        const x0 = drawLineKey(pane.x, y, tokens.body, false);
        ctx.font = fontOf(11.5, 700);
        ctx.fillStyle = tokens.ink;
        ctx.fillText(ellipsize(series.body.label || 'This object', pane.w * 0.4), x0, y);
        ctx.font = fontOf(11);
        ctx.fillText('flux', 6, y);
        drawLineKey(pane.x, layout.ref.titleY + layout.ref.titleH / 2 + 0.5, tokens.ref, true);
    }

    function drawOverlayUnit(pane, s) {
        if (!s.exp) return;
        const text = `× 10${superscript(s.exp)}`;
        ctx.font = fontOf(11);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const y = pane.y + labelBand(pane) + 9;
        ctx.fillStyle = tokens.well;
        ctx.globalAlpha = 0.8;
        ctx.fillRect(pane.x + 1, y - 7, ctx.measureText(text).width + 6, 14);
        ctx.globalAlpha = 1;
        ctx.fillStyle = tokens.ink;
        ctx.fillText(text, pane.x + 4, y);
    }

    function drawAxis(ticks) {
        const y = layout.axisY;
        ctx.strokeStyle = tokens.ink;
        ctx.lineWidth = 1 / dpr;
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ticks.minor.forEach((x) => {
            const sx = snap(x);
            ctx.moveTo(sx, y);
            ctx.lineTo(sx, y + 3);
        });
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ticks.major.forEach((tick) => {
            const sx = snap(tick.x);
            ctx.moveTo(sx, y);
            ctx.lineTo(sx, y + 5);
        });
        ctx.stroke();

        ctx.font = fontOf(11);
        ctx.fillStyle = tokens.ink;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ticks.major.forEach((tick) => {
            const w = ctx.measureText(tick.label).width;
            const x = Math.max(layout.left - 30, Math.min(tick.x - w / 2, layout.right + 8 - w));
            ctx.fillText(tick.label, x, y + 6);
        });
    }

    // Labels go in a band at the top of the pane, in up to `rows` rows, strongest lines first; a line that can't fit is
    // left unnamed at this zoom. sources: [{ s, ink }]; both spectra in overlay share one set of rows.
    function drawLineLabels(pane, sources, rows) {
        if (!labelsOn) return;
        const entries = [];
        sources.forEach(({ s, ink }) => {
            if (!s.sp || !s.sp.lines || !s.cols) return;
            s.sp.lines.forEach((line) => {
                if (line.label && line.obs_nm >= lo && line.obs_nm <= hi) entries.push({ line, s, ink });
            });
        });
        if (!entries.length) return;
        entries.sort((a, b) => Math.abs(b.line.depth ?? 0) - Math.abs(a.line.depth ?? 0));
        ctx.font = fontOf(10.5);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        const taken = Array.from({ length: rows }, () => []);
        const bottom = pane.y + pane.h;
        const seen = new Set();
        const limit = Math.min(entries.length, 160);
        for (let e = 0; e < limit; e++) {
            const { line, s, ink } = entries[e];
            const name = line.label;
            const x = scale.xOf(line.obs_nm);
            // Close pairs (Na D) and the same line on both spectra need naming only once at this zoom
            const blendKey = `${name}@${Math.round(x / 8)}`;
            if (seen.has(blendKey)) continue;
            const w = ctx.measureText(name).width;
            const x0 = Math.max(pane.x + 1, Math.min(x - w / 2, pane.x + pane.w - w - 1));
            const x1 = x0 + w;
            let row = -1;
            for (let r = 0; r < rows; r++) {
                if (taken[r].every(([a, b]) => x1 + 4 < a || x0 - 4 > b)) { row = r; break; }
            }
            if (row < 0) continue;
            taken[row].push([x0, x1]);
            seen.add(blendKey);
            const textY = pane.y + 10 + row * 12;
            const col = Math.max(0, Math.min(s.cols.n - 1, Math.round((x - layout.left) * dpr - 0.5)));
            let top = s.cols.lineMax[col];
            for (let d = -2; d <= 2; d++) {
                const v = s.cols.lineMax[Math.max(0, Math.min(s.cols.n - 1, col + d))];
                if (v > top) top = v;
            }
            const yCurve = top === top ? Math.min(bottom, yOfPane(top, s, pane)) : bottom;
            ctx.save();
            ctx.strokeStyle = ink;
            ctx.globalAlpha = 0.6;
            ctx.lineWidth = 1 / dpr;
            ctx.beginPath();
            ctx.moveTo(snap(x), textY + 2);
            ctx.lineTo(snap(x), Math.max(textY + 3, yCurve - 1));
            ctx.stroke();
            ctx.restore();
            ctx.fillStyle = tokens.ink;
            ctx.fillText(name, x0, textY);
        }
    }

    // Labels name a reference's lines, never the object's own: with none chosen, a word on where they'll come from
    function drawLabelsWanted(pane) {
        if (!labelsOn || hasRef()) return;
        const text = 'Labels name a reference\'s lines: choose one below';
        ctx.font = fontOf(11);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(text).width;
        const x = pane.x + 6;
        const y = pane.y + 12;
        ctx.fillStyle = tokens.well;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x - 3, y - 8, w + 6, 16);
        ctx.globalAlpha = 1;
        ctx.fillStyle = tokens.ink;
        ctx.fillText(text, x, y);
    }

    function drawPaneNote(pane, s, y) {
        if (!s.paneNote) return;
        ctx.font = fontOf(12);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(s.paneNote).width + 12;
        ctx.fillStyle = tokens.well;
        ctx.globalAlpha = 0.8;
        ctx.fillRect(pane.x + pane.w / 2 - w / 2, y - 9, w, 18);
        ctx.globalAlpha = 1;
        ctx.fillStyle = tokens.ink;
        ctx.fillText(s.paneNote, pane.x + pane.w / 2, y);
    }

    // Where the curve has run off the top, at the top
    function drawCapNote(pane, s) {
        if (!s.capped) return;
        const text = `↑ ${s.capNote}`;
        ctx.font = fontOf(11);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const y = pane.y + labelBand(pane) + 9;
        const w = ctx.measureText(text).width;
        ctx.fillStyle = tokens.well;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(pane.x + pane.w - w - 8, y - 7, w + 6, 14);
        ctx.globalAlpha = 1;
        ctx.fillStyle = tokens.ink;
        ctx.fillText(text, pane.x + pane.w - 5, y);
    }

    function drawBase() {
        const started = performance.now();
        if (!cssW || !cssH) return;
        if (!tokens) readTokens();
        layout = computeLayout();
        scale = wavelengthScale(lo, hi, layout.left, layout.plotW);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        const nextKey = [layout.body.titleY, layout.refRowY, layout.refRowH, !!layout.ref, layout.titleH, layout.left, layout.plotW, mode, layout.compact].join();
        if (nextKey !== layoutKey) {
            layoutKey = nextKey;
            layoutFns.forEach((fn) => fn(layout, mode));
        }

        ctx.font = fontOf(11);
        const ticks = wavelengthTicks(scale, (t) => ctx.measureText(t).width);
        const { body, ref } = series;
        ensureColumns(body, 'body');
        ensureColumns(ref, 'ref');
        const stacked = mode === 'stacked' || !hasRef();


        const bodyPane = layout.body;
        drawWell(bodyPane);
        drawGrid(bodyPane, ticks);
        if (body.sp) drawYAxis(bodyPane, body);
        drawRegionEdges(bodyPane);
        if (body.sp) drawSeries(bodyPane, body, tokens.body, { fill: stacked ? 0.13 : 0.06 });

        if (stacked) {
            drawTitle(bodyPane, body, 'body');
            drawLabelsWanted(bodyPane);
            drawPaneNote(bodyPane, body, bodyPane.y + bodyPane.h / 2);
            drawStrip(bodyPane, body);
            if (hasRef()) {
                const refPane = layout.ref;
                drawWell(refPane);
                drawGrid(refPane, ticks);
                drawYAxis(refPane, ref);
                drawRegionEdges(refPane);
                drawSeries(refPane, ref, tokens.ref);
                drawTitle(refPane, ref, 'ref');
                drawLineLabels(refPane, [{ s: ref, ink: tokens.ref }], labelRows(refPane));
                drawPaneNote(refPane, ref, refPane.y + refPane.h / 2);
                drawStrip(refPane, ref);
            }
        } else {
            const refPane = layout.ref;
            drawSeries(refPane, ref, tokens.ref, { fill: 0, alpha: 0.9, dash: OVERLAY_DASH });
            drawOverlayTitle(bodyPane);
            drawOverlayUnit(bodyPane, body);
            drawLineLabels(bodyPane, [{ s: ref, ink: tokens.ref }], labelRows(bodyPane));
            drawPaneNote(bodyPane, body, bodyPane.y + 14 + labelBand(bodyPane));
            drawPaneNote(refPane, ref, bodyPane.y + 34 + labelBand(bodyPane));
            drawStrip(bodyPane, body);
            drawStrip(refPane, ref);
        }
        drawCapNote(bodyPane, body);
        if (stacked) {
            drawOverlayUnit(bodyPane, body);
            if (hasRef()) drawOverlayUnit(layout.ref, ref);
        }
        drawAxis(ticks);
        if (scale.isLog) {
            const pane = layout.ref || layout.body;
            ctx.font = fontOf(10.5);
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            const text = 'log scale';
            const w = ctx.measureText(text).width;
            ctx.fillStyle = tokens.well;
            ctx.globalAlpha = 0.8;
            ctx.fillRect(pane.x + pane.w - w - 6, pane.y + pane.h - 15, w + 6, 14);
            ctx.globalAlpha = 1;
            ctx.fillStyle = tokens.ink;
            ctx.fillText(text, pane.x + pane.w - 3, pane.y + pane.h - 8);
        }

        overlays.forEach((fn) => {
            ctx.save();
            try {
                fn(ctx, api);
            } catch (err) {
                console.error('[spectroscopy] plot overlay failed:', err);
            }
            ctx.restore();
        });

        drawCursor();
        lastDrawMs = performance.now() - started;
    }

    // ---------- Cursor layer: moving the cursor never redraws the spectra ----------

    function fluxAt(nm, which = 'body') {
        const s = series[which];
        if (!s || !s.sp) return null;
        const { wl, flux } = s.sp;
        if (!wl.length || nm < wl[0] || nm > wl[wl.length - 1]) return null;
        const i = Math.min(wl.length - 1, lowerBound(wl, nm));
        const j = i > 0 && nm - wl[i - 1] < wl[i] - nm ? i - 1 : i;
        const v = flux[j];
        return v === v ? v : null;
    }

    function cursorDigits() {
        const nmPerPx = (hi - lo) / Math.max(1, layout ? layout.plotW : cssW);
        return Math.max(1, Math.min(3, Math.ceil(-Math.log10(nmPerPx))));
    }

    function drawCursor() {
        const c = cursorCtx;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, cssW, cssH);
        const showing = cursorNm !== null && !!layout && !!tokens && cursorNm >= lo && cursorNm <= hi;
        cursorCanvas.style.visibility = showing ? 'visible' : 'hidden';
        if (!showing) return;
        const x = snap(scale.xOf(cursorNm));
        const top = layout.body.y;
        c.strokeStyle = tokens.ink;
        c.lineWidth = 1 / dpr;
        c.globalAlpha = 0.85;
        c.beginPath();
        c.moveTo(x, top);
        c.lineTo(x, layout.axisY + 2);
        c.stroke();
        c.globalAlpha = 1;

        const dot = (which, colour) => {
            const pane = layout[which];
            const s = series[which];
            const v = fluxAt(cursorNm, which);
            if (v === null || !pane) return;
            const y = Math.max(pane.y, Math.min(pane.y + pane.h, yOfPane(v, s, pane)));
            c.beginPath();
            c.arc(x, y, 3.5, 0, Math.PI * 2);
            c.fillStyle = colour;
            c.strokeStyle = tokens.well;
            c.lineWidth = 1.5;
            c.fill();
            c.stroke();
            // The value right beside the point it belongs to, so no line of the panel has to be kept for it
            const words = sig(v, 3);
            c.font = fontOf(11, 700);
            const tw = c.measureText(words).width + 8;
            let tx = x + 7;
            if (tx + tw > pane.x + pane.w) tx = x - 7 - tw;
            const ty = Math.max(pane.y + 1, Math.min(pane.y + pane.h - 17, y - 8));
            c.fillStyle = tokens.well;
            c.globalAlpha = 0.86;
            c.beginPath();
            if (c.roundRect) c.roundRect(tx, ty, tw, 16, 3);
            else c.rect(tx, ty, tw, 16);
            c.fill();
            c.globalAlpha = 1;
            c.fillStyle = tokens.ink;
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillText(words, tx + tw / 2, ty + 8.5);
        };
        dot('body', tokens.body);
        if (hasRef()) dot('ref', tokens.ref);

        // A label on the axis, so the wavelength can be read where the eye already is
        const text = wavelength(cursorNm, cursorDigits());
        c.font = fontOf(11, 700);
        const w = c.measureText(text).width + 10;
        const px = Math.max(1, Math.min(x - w / 2, cssW - w - 1));
        const py = layout.axisY + 2;
        c.fillStyle = tokens.ink;
        c.beginPath();
        if (c.roundRect) c.roundRect(px, py, w, 16, 3);
        else c.rect(px, py, w, 16);
        c.fill();
        c.fillStyle = tokens.well;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(text, px + w / 2, py + 8.5);
    }

    // What the cursor reads, for screen readers: on the canvas itself, as the sighted reading is drawn on it
    function updateReadout() {
        if (cursorNm === null) {
            canvas.setAttribute('aria-valuenow', String(Math.round(Math.sqrt(lo * hi))));
            canvas.setAttribute('aria-valuetext', `Showing ${wavelength(lo)} to ${wavelength(hi)}`);
            return;
        }
        const text = wavelength(cursorNm, cursorDigits());
        const a = fluxAt(cursorNm, 'body');
        const b = hasRef() ? fluxAt(cursorNm, 'ref') : null;
        const parts = [text];
        if (series.body.sp) {
            const v = a === null ? 'no data' : sig(a, 3);
            parts.push(`object flux ${v}`);
        }
        if (hasRef()) {
            const v = b === null ? 'no data' : sig(b, 3);
            parts.push(`reference flux ${v}`);
        }
        canvas.setAttribute('aria-valuenow', String(Math.round(cursorNm)));
        canvas.setAttribute('aria-valuetext', parts.join(', '));
    }

    // ---------- Drawing on demand ----------

    function redraw(now) {
        if (disposed) return;
        if (now === true) {
            if (queued) { cancelAnimationFrame(queued); queued = 0; }
            drawBase();
            updateReadout();
            return;
        }
        if (queued) return;
        queued = requestAnimationFrame(() => {
            queued = 0;
            drawBase();
            updateReadout();
        });
    }

    function resize() {
        const rect = stage.getBoundingClientRect();
        const nextW = rect.width;
        const nextH = rect.height;
        const nextDpr = window.devicePixelRatio || 1;
        if (nextW === cssW && nextH === cssH && nextDpr === dpr) return false;
        cssW = nextW;
        cssH = nextH;
        if (nextDpr !== dpr) hatch = null;
        dpr = nextDpr;
        const bw = Math.max(1, Math.round(cssW * dpr));
        const bh = Math.max(1, Math.round(cssH * dpr));
        canvas.width = bw;
        canvas.height = bh;
        cursorCanvas.width = bw;
        cursorCanvas.height = bh;
        layout = null;
        series.body.key = '';
        series.ref.key = '';
        return true;
    }

    const sizeWatch = new ResizeObserver(() => {
        // Resizing clears the canvas, so draw straight away rather than show a blank frame
        if (resize() && cssW > 0 && cssH > 0) redraw(true);
    });
    sizeWatch.observe(stage);
    window.addEventListener('resize', onWindowResize);

    function onWindowResize() {
        if (resize() && cssW > 0 && cssH > 0) redraw(true);
    }

    // ---------- Range ----------

    function clampedRange(a, b) {
        const maxLn = Math.log(limitHi / limitLo);
        let lnA = Math.log(a);
        let lnB = Math.log(b);
        const minLn = Math.log(minRatio);
        let span = lnB - lnA;
        if (span < minLn) {
            const mid = 0.5 * (lnA + lnB);
            lnA = mid - minLn / 2;
            lnB = mid + minLn / 2;
            span = minLn;
        }
        if (span > maxLn) {
            lnA = Math.log(limitLo);
            lnB = Math.log(limitHi);
        } else {
            if (lnA < Math.log(limitLo)) { lnB += Math.log(limitLo) - lnA; lnA = Math.log(limitLo); }
            if (lnB > Math.log(limitHi)) { lnA -= lnB - Math.log(limitHi); lnB = Math.log(limitHi); }
        }
        return [Math.exp(lnA), Math.exp(lnB)];
    }

    function applyRange(a, b) {
        const [nextLo, nextHi] = clampedRange(a, b);
        if (nextLo === lo && nextHi === hi) return false;
        lo = nextLo;
        hi = nextHi;
        scale = layout ? wavelengthScale(lo, hi, layout.left, layout.plotW) : wavelengthScale(lo, hi, 0, 1);
        // A cursor left outside the view would read out somewhere not on show; keyboard users keep one in view
        if (cursorNm !== null && (cursorNm < lo || cursorNm > hi)) {
            cursorNm = canvas.matches(':focus-visible') ? Math.sqrt(lo * hi) : null;
        }
        redraw();
        rangeFns.forEach((fn) => fn(lo, hi));
        return true;
    }

    function stopTween() {
        if (tween) cancelAnimationFrame(tween);
        tween = 0;
    }

    function setRange(a, b, options = {}) {
        stopTween();
        if (options.animate && !reduceMotion() && cssW > 0) {
            const [toLo, toHi] = clampedRange(a, b);
            const fromLo = Math.log(lo);
            const fromHi = Math.log(hi);
            const started = performance.now();
            const step = (now) => {
                const u = Math.min(1, (now - started) / 240);
                const e = 1 - (1 - u) ** 3;
                applyRange(Math.exp(fromLo + (Math.log(toLo) - fromLo) * e), Math.exp(fromHi + (Math.log(toHi) - fromHi) * e));
                tween = u < 1 ? requestAnimationFrame(step) : 0;
            };
            tween = requestAnimationFrame(step);
            return;
        }
        applyRange(a, b);
    }

    // Zoom keeping one wavelength at the same place on the axis; u is where that place is, 0 (left) to 1 (right)
    function zoomAbout(anchorNm, u, factor) {
        const useLog = scale.t >= 0.5;
        if (useLog) {
            const span = Math.log(hi / lo) * factor;
            const a = Math.log(anchorNm) - u * span;
            applyRange(Math.exp(a), Math.exp(a + span));
        } else {
            const span = (hi - lo) * factor;
            const a = anchorNm - u * span;
            applyRange(Math.max(1e-3, a), a + span);
        }
    }

    function zoomBy(factor, anchorNm) {
        stopTween();
        ensureLayout();
        const m = anchorNm ?? (cursorNm !== null && cursorNm >= lo && cursorNm <= hi ? cursorNm : scale.nmOf(layout.left + layout.plotW / 2));
        const u = (scale.xOf(m) - layout.left) / layout.plotW;
        zoomAbout(m, u, factor);
    }

    // Move the view by a fraction of the plot's width; positive moves towards longer wavelengths
    function panBy(fraction) {
        stopTween();
        ensureLayout();
        panFrom(lo, hi, fraction);
    }

    // By ratio, so the view keeps its width whatever it passes through and stops flat at either end of the range
    function panFrom(lo0, hi0, fraction) {
        const f = Math.exp(fraction * Math.log(hi0 / lo0));
        applyRange(lo0 * f, hi0 * f);
    }

    // Zooming from where a drag began, about the wavelength it began on
    function zoomFrom(lo0, hi0, anchorNm, u, factor) {
        const span = Math.log(hi0 / lo0) * factor;
        const a = Math.log(anchorNm) - u * span;
        applyRange(Math.exp(a), Math.exp(a + span));
    }

    // ---------- Pointers ----------

    const pointers = new Map();
    let drag = null;
    let pinch = null;
    let holdTimer = 0;
    let lastTap = null;

    function localX(e) {
        const r = canvas.getBoundingClientRect();
        return e.clientX - r.left;
    }

    function plotNm(x) {
        ensureLayout();
        const px = Math.max(layout.left, Math.min(layout.right, x));
        return scale.nmOf(px);
    }

    function inPlot(x) {
        ensureLayout();
        return x >= layout.left - 6 && x <= layout.right + 6;
    }

    function setCursor(nm) {
        const next = nm === null || nm === undefined ? null : nm;
        if (next === cursorNm) return;
        cursorNm = next;
        drawCursor();
        updateReadout();
    }

    function fireHover(nm, e) {
        hoverFns.forEach((fn) => fn(nm, e));
    }

    function fireClick(nm, e) {
        clickFns.forEach((fn) => fn(nm, e));
    }

    function clearHold() {
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = 0;
    }

    function startPinch() {
        const [a, b] = [...pointers.values()];
        const midX = 0.5 * (a.x + b.x);
        pinch = {
            dist: Math.max(20, Math.abs(a.x - b.x)),
            midNm: plotNm(midX),
            lnSpan: Math.log(hi / lo)
        };
        drag = null;
        clearHold();
    }

    function onPointerDown(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        stopTween();
        const x = localX(e);
        pointers.set(e.pointerId, { x });
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* Older browsers */ }
        if (pointers.size === 2) {
            startPinch();
            return;
        }
        drag = { id: e.pointerId, x0: x, y0: e.clientY, lo0: lo, hi0: hi, moved: false, scrub: false, type: e.pointerType };
        canvas.classList.add('is-dragging');
        if (e.pointerType !== 'mouse') {
            holdTimer = setTimeout(() => {
                holdTimer = 0;
                if (drag && !drag.moved) {
                    drag.scrub = true;
                    setCursor(plotNm(drag.x0));
                    fireHover(cursorNm, e);
                }
            }, 320);
        }
    }

    function onPointerMove(e) {
        const x = localX(e);
        const p = pointers.get(e.pointerId);
        if (p) p.x = x;

        if (pinch && pointers.size >= 2) {
            const [a, b] = [...pointers.values()];
            const dist = Math.max(20, Math.abs(a.x - b.x));
            const span = pinch.lnSpan * (pinch.dist / dist);
            const u = (0.5 * (a.x + b.x) - layout.left) / layout.plotW;
            const start = Math.log(pinch.midNm) - u * span;
            applyRange(Math.exp(start), Math.exp(start + span));
            return;
        }

        if (drag && drag.id === e.pointerId) {
            const dx = x - drag.x0;
            if (drag.scrub) {
                setCursor(plotNm(x));
                fireHover(cursorNm, e);
                return;
            }
            const dy = e.clientY - drag.y0;
            const mouse = drag.type === 'mouse';
            // A finger going up or down scrolls the drawer, so only a mouse can zoom by dragging
            const reach = mouse ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.abs(dx);
            if (!drag.moved && reach < (mouse ? 3 : 7)) return;
            ensureLayout();
            if (!drag.moved) {
                drag.moved = true;
                clearHold();
                drag.zooms = mouse && Math.abs(dy) > 1.5 * Math.abs(dx);
                if (drag.zooms) {
                    const x0 = Math.max(layout.left, Math.min(layout.right, drag.x0));
                    drag.anchorNm = scale.nmOf(x0);
                    drag.anchorU = (x0 - layout.left) / layout.plotW;
                }
            }
            if (drag.zooms) {
                // Up is in, and 120 px is a factor of e
                zoomFrom(drag.lo0, drag.hi0, drag.anchorNm, drag.anchorU, Math.exp(dy / 120));
            } else {
                panFrom(drag.lo0, drag.hi0, -dx / layout.plotW);
            }
            return;
        }

        if (e.pointerType === 'mouse' && !drag) {
            if (inPlot(x)) {
                setCursor(plotNm(x));
                fireHover(cursorNm, e);
            } else if (cursorNm !== null) {
                setCursor(null);
                fireHover(null, e);
            }
        }
    }

    function onPointerUp(e) {
        const hadPinch = !!pinch;
        pointers.delete(e.pointerId);
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* Already released */ }
        clearHold();
        if (pointers.size < 2) pinch = null;
        if (hadPinch) {
            drag = null;
            canvas.classList.remove('is-dragging');
            return;
        }
        const finished = drag;
        drag = null;
        canvas.classList.remove('is-dragging');
        if (!finished || finished.id !== e.pointerId) return;
        const x = localX(e);
        if (finished.scrub) return;
        if (!finished.moved && inPlot(x)) {
            const nm = plotNm(x);
            if (e.pointerType !== 'mouse') {
                // No hover on a touch screen: a tap places the cursor, and two quick taps reset the view
                setCursor(nm);
                fireHover(nm, e);
                const now = performance.now();
                if (lastTap && now - lastTap.t < 320 && Math.abs(lastTap.x - x) < 28) {
                    lastTap = null;
                    resetRange();
                    return;
                }
                lastTap = { t: now, x };
            }
            fireClick(nm, e);
        }
    }

    function onPointerCancel(e) {
        pointers.delete(e.pointerId);
        clearHold();
        if (pointers.size < 2) pinch = null;
        if (drag && drag.id === e.pointerId) drag = null;
        canvas.classList.remove('is-dragging');
    }

    function onPointerLeave(e) {
        if (e.pointerType !== 'mouse' || drag) return;
        if (document.activeElement === canvas && canvas.matches(':focus-visible')) return;
        setCursor(null);
        fireHover(null, e);
    }

    // Up and down zooms about the pointer, as on a map; sideways, or Shift with the wheel, pans
    function onWheel(e) {
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
        const dx = e.deltaX * unit;
        const dy = (e.shiftKey && !dx ? 0 : e.deltaY) * unit;
        const sideways = e.shiftKey && !dx ? e.deltaY * unit : dx;
        if (!dy && !sideways) return;
        e.preventDefault();
        stopTween();
        ensureLayout();
        if (Math.abs(sideways) > Math.abs(dy)) {
            panFrom(lo, hi, sideways / layout.plotW);
            return;
        }
        const x = Math.max(layout.left, Math.min(layout.right, localX(e)));
        const u = (x - layout.left) / layout.plotW;
        // A trackpad pinch sends many small steps, a mouse wheel a few big ones
        zoomAbout(scale.nmOf(x), u, Math.exp(Math.max(-1, Math.min(1, dy * (Math.abs(dy) < 40 ? 0.01 : 0.0016)))));
    }

    function onDoubleClick(e) {
        e.preventDefault();
        resetRange();
    }

    // A touch-and-hold scrub must not scroll the sheet underneath
    function onTouchMove(e) {
        if (drag && drag.scrub) e.preventDefault();
    }

    // ---------- Keyboard ----------

    function onKeyDown(e) {
        const key = e.key;
        let handled = true;
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
            const dir = key === 'ArrowLeft' ? -1 : 1;
            if (e.shiftKey) {
                ensureLayout();
                const from = cursorNm !== null && cursorNm >= lo && cursorNm <= hi ? scale.xOf(cursorNm) : layout.left + layout.plotW / 2;
                const stepPx = e.altKey ? 1 : Math.max(2, layout.plotW / 100);
                setCursor(plotNm(from + dir * stepPx));
                fireHover(cursorNm, e);
            } else {
                // The cursor stays where it is on the plot, so its reading changes as the spectrum moves under it
                const before = cursorNm !== null ? scale.xOf(cursorNm) : null;
                panBy(dir * 0.1);
                if (before !== null) {
                    cursorNm = scale.nmOf(before);
                    updateReadout();
                    drawCursor();
                }
            }
        } else if (key === '+' || key === '=') {
            zoomBy(0.8);
        } else if (key === '-' || key === '_') {
            zoomBy(1.25);
        } else if (key === '0' || key === 'Home') {
            resetRange();
        } else if (key === 'Enter' || key === ' ') {
            ensureLayout();
            if (cursorNm === null) setCursor(scale.nmOf(layout.left + layout.plotW / 2));
            else fireClick(cursorNm, e);
        } else {
            handled = false;
        }
        if (handled) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    function onFocus() {
        // Keyboard users get the readout straight away
        if (canvas.matches(':focus-visible') && cursorNm === null) {
            ensureLayout();
            setCursor(scale.nmOf(layout.left + layout.plotW / 2));
        }
    }

    function onBlur() {
        if (cursorNm !== null) setCursor(null);
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('focus', onFocus);
    canvas.addEventListener('blur', onBlur);

    // ---------- Public ----------

    function setSeries(s, sp, label) {
        s.sp = sp;
        if (label !== undefined) s.label = label;
        s.key = '';
        s.fluxPeak = 0;
        s.noiseK = 0;
        s.emissive = false;
        if (sp) {
            let fluxPeak = 0;
            let contPeak = 0;
            const { flux, continuum } = sp;
            for (let i = 0; i < flux.length; i++) {
                if (flux[i] > fluxPeak) fluxPeak = flux[i];
                if (continuum && continuum[i] > contPeak) contPeak = continuum[i];
            }
            s.fluxPeak = fluxPeak;
            s.noiseK = measureNoise(sp, fluxPeak);
            // A spike that's going to run off the top doesn't make this a spectrum of bright lines
            s.emissive = sp.mode === 'emission' || (!s.capNote && fluxPeak > 0 && contPeak < 0.02 * fluxPeak);
        }
        layout = null;
        redraw();
        updateReadout();
    }

    function resetRange() {
        setRange(autoLo, autoHi, { animate: true });
    }

    const api = {
        el: root,
        canvas,
        stage,
        setChrome(next) {
            Object.assign(chrome, next);
            layout = null;
            layoutKey = '';
            redraw();
        },
        onLayout(fn) {
            layoutFns.add(fn);
            return () => layoutFns.delete(fn);
        },
        setSpectrum(sp, label) { setSeries(series.body, sp, label); },
        setReference(sp, label) { setSeries(series.ref, sp || null, label); },
        setMode(next) {
            if (next !== 'stacked' && next !== 'overlay') return;
            mode = next;
            layout = null;
            redraw();
        },
        getMode: () => mode,
        setRange,
        getRange: () => ({ lo, hi }),
        setAutoRange(a, b) { [autoLo, autoHi] = clampedRange(a, b); },
        resetRange,
        setLimits(a, b) {
            limitLo = a;
            limitHi = b;
            applyRange(lo, hi);
        },
        setMinRatio(r) {
            minRatio = r;
            applyRange(lo, hi);
        },
        getMinRatio: () => minRatio,
        zoomBy,
        panBy,
        xOf(nm) {
            ensureLayout();
            return scale.xOf(nm);
        },
        nmOf(x) {
            ensureLayout();
            return scale.nmOf(x);
        },
        yOf(flux, which = 'body') {
            ensureLayout();
            const pane = layout[which] || layout.body;
            return yOfPane(flux, series[which] || series.body, pane);
        },
        fluxAt,
        // Where things are, in CSS pixels of the canvas: { left, right, top, axisY, body: pane, ref: pane|null },
        // where a pane is { x, y, w, h, stripY, stripH }
        panes() {
            ensureLayout();
            return layout;
        },
        setCursor,
        getCursor: () => cursorNm,
        addOverlay(fn) {
            overlays.add(fn);
            redraw();
            return () => {
                overlays.delete(fn);
                redraw();
            };
        },
        onClick(fn) {
            clickFns.add(fn);
            return () => clickFns.delete(fn);
        },
        onHover(fn) {
            hoverFns.add(fn);
            return () => hoverFns.delete(fn);
        },
        onRangeChange(fn) {
            rangeFns.add(fn);
            return () => rangeFns.delete(fn);
        },
        redraw,
        showLineLabels(on) {
            labelsOn = !!on;
            redraw();
        },
        lineLabelsShown: () => labelsOn,
        // How much of the top of the object's pane the line labels take, so that a tool's own marks can sit below them
        labelBand() {
            ensureLayout();
            return labelBand(layout.body);
        },
        // note, or '': lets a part of the object's spectrum run off the top, with this said where it does
        setTopCap(note) {
            const next = note || '';
            if (series.body.capNote === next) return;
            series.body.capNote = next;
            series.body.key = '';
            redraw();
        },
        setAriaLabel(text) {
            canvas.setAttribute('aria-label', text);
        },
        // true: the flux axis fits what's in view from just under its lowest point, for a close look at one line. A number from 0
        // to 1: the axis starts at that share of the highest point in view, and stays there as lines move. false: from zero.
        setFitFloor(on) {
            const next = typeof on === 'number' ? on : !!on;
            if (fitFloor === next) return;
            fitFloor = next;
            series.body.key = '';
            series.ref.key = '';
            redraw();
        },
        lastDrawMs: () => lastDrawMs,
        dispose() {
            disposed = true;
            stopTween();
            clearHold();
            if (queued) cancelAnimationFrame(queued);
            sizeWatch.disconnect();
            themeWatch.disconnect();
            window.removeEventListener('resize', onWindowResize);
            overlays.clear();
            clickFns.clear();
            hoverFns.clear();
            rangeFns.clear();
            root.remove();
        }
    };

    canvas.setAttribute('aria-valuemin', String(limitLo));
    canvas.setAttribute('aria-valuemax', String(limitHi));
    updateReadout();
    return api;
}
