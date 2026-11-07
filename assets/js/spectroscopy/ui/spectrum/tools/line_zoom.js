// Line zoom: shows one line at high resolution, measures its width, and says what that width means: rotation if its sides
// are steep, density if it has long wings. Widths are kept through the session so that stars can be compared.

import { registerTool } from './index.js';
import { C_KMS } from '../../../core/phys.js';
import { lineWidth, hasLongWings, suggestRotationLines } from '../../../spectra/measure.js';
import { el } from '../../plot2d.js';
import { actionRow, overlayTheme, para, plotLabel, resultLine, searchNmAt, statusBox } from './common.js';

const MIN_WINDOW_KMS = 90;       // The narrowest view: wide enough for a narrow line and some continuum either side
const WINDOW_PER_WIDTH = 4;      // Half the view, as a multiple of the line's width
const PICKS = 5;

// Widths last the session and outlive a change of selection, so that the next star's line can be set beside them
const history = [];
let lastLine = null;             // { rest_nm, label }

function kmsText(v) {
    return v < 10 ? v.toFixed(1) : String(Math.round(v));
}

function lineName(line) {
    return `${String(line.label || line.species || 'Line').replace(/\s*\d+(\.\d+)?$/, '')} ${line.rest_nm.toFixed(1)} nm`;
}

// A line with long wings is widened by pressure as well, so its width only says how fast the star could be turning at most
function rotationText(w, winged) {
    if (w.unresolved) {
        return `Rotation: unresolved (< ${Math.round(w.limit_kms)} km/s)`;
    }
    if (winged) return `Rotation: at most ${kmsText(w.velocity_kms)} km/s`;
    return `Rotation: v sin i ≈ ${kmsText(w.velocity_kms)} ± ${kmsText(Math.max(w.err_kms, 0.5))} km/s`;
}

// Rotation and pressure are readings of a star's lines. Anywhere else, a line's width is gas or stars moving at many speeds.
function isStarLike(entity) {
    return !!(entity.star || entity.stars || entity.black_hole);
}

const WIDTH_MEANS = {
    galaxy: 'Stars moving about inside the galaxy smear every line, so this width tells you how fast they move.',
    quasar: 'Gas whirling around the central black hole at a huge speed spreads these lines out.',
    supernova: 'Gas thrown out by the explosion is moving at a huge range of speeds, so its lines are very wide.',
    nebula: 'This width comes from the gas in the nebula moving about, and from its heat.'
};

// What the shape says. Words are about what was measured, not about what kind of star this is.
function meaning(w, winged) {
    if (w.shape === 'wings' || winged) {
        return 'This line has long wings, which come from pressure. The denser the gas, the wider they spread: broad wings mean a dense dwarf or white dwarf, narrow lines a thin, puffed-up giant. Because pressure widens this line so much, a thin metal line is better for rotation.';
    }
    if (w.unresolved) {
        return `Too narrow to show rotation. At this resolution the instrument alone makes a line ${kmsText(w.instrument_kms)} km/s wide, so a slower spin can't be told apart. That is a real limit, not a fault.`;
    }
    if (w.shape === 'steep') {
        return 'Steep sides and a flat bottom: that is rotation. One side of the star is coming towards you and the other going away, which spreads every line evenly.';
    }
    return 'Rounded, without long wings, so this width is mostly rotation and not pressure.';
}

function mount(container, api) {
    const { plot } = api;
    const intro = para('Click a line on the plot, or pick one here. In a star, thin metal lines show rotation best, and hydrogen or strong sodium and calcium lines show density.');
    const chips = el('div', { class: 'spectro-tool-picks', role: 'group', 'aria-label': 'Lines to zoom in on' });
    const result = statusBox();
    const historyEl = el('div', { class: 'spectro-tool-measured', hidden: true });
    container.append(intro, chips, result, historyEl);

    const started = plot.getRange();
    let current = null;      // The measured width, and the line it belongs to

    const removeOverlay = plot.addOverlay((ctx) => {
        if (!current) return;
        const { w } = current;
        const theme = overlayTheme(plot);
        const half = w.fwhm_nm / 2;
        const sign = w.type === 'em' ? 1 : -1;
        const level = w.continuum + (sign * w.height) / 2;
        const x1 = plot.xOf(w.centre_nm - half);
        const x2 = plot.xOf(w.centre_nm + half);
        const y = plot.yOf(level);
        const pane = plot.panes().body;
        if (y < pane.y || y > pane.y + pane.h) return;
        ctx.save();
        ctx.strokeStyle = theme.mark;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        [x1, x2].forEach((x) => {
            ctx.moveTo(x, y - 5);
            ctx.lineTo(x, y + 5);
        });
        ctx.stroke();
        ctx.restore();
        plotLabel(ctx, theme, `${kmsText(w.fwhm_kms)} km/s wide`, 0.5 * (x1 + x2), Math.min(pane.y + pane.h - 10, y + 16));
    });

    function renderHistory() {
        historyEl.replaceChildren();
        historyEl.hidden = history.length < 2;
        if (historyEl.hidden) return;
        const code = api.resolved.entity.code;
        historyEl.append(
            el('table', { class: 'spectro-tool-table' },
                el('caption', { text: 'Widths so far' }),
                el('thead', {}, el('tr', {},
                    el('th', { scope: 'col', text: 'Object' }),
                    el('th', { scope: 'col', text: 'Line' }),
                    el('th', { scope: 'col', text: 'Width (km/s)' }),
                    el('th', { scope: 'col', text: 'Rotation (km/s)' }))),
                el('tbody', {}, ...history.map((h) => el('tr', { class: h.code === code ? 'is-current' : undefined },
                    el('td', { text: h.code }),
                    el('td', { text: h.line }),
                    el('td', { text: kmsText(h.width) }),
                    el('td', { text: h.unresolved ? `< ${Math.round(h.limit)}` : `${h.atMost ? 'up to ' : ''}${kmsText(h.rotation)}` }))))),
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

    // Finds the line in the overview first: its width there sets how far to zoom
    function zoomTo(nm, line, searchNm) {
        const overview = api.getOverview();
        const first = overview && lineWidth(overview, nm, { searchNm });
        if (!first) {
            result.replaceChildren(para('No clear line there. Try closer to the middle of a dip or a spike.'));
            current = null;
            plot.redraw();
            return;
        }
        const halfKms = Math.max(MIN_WINDOW_KMS, WINDOW_PER_WIDTH * first.fwhm_kms);
        const centre = first.centre_nm;
        const halfNm = (centre * halfKms) / C_KMS;
        api.setResolution('zoom', { lo_nm: centre - halfNm, hi_nm: centre + halfNm });
        measureHere(centre, line, Math.min(halfNm * 0.3, Math.max(first.fwhm_nm, (centre * 6) / C_KMS)));
    }

    function measureHere(nm, line, searchNm) {
        const spectrum = api.getSpectrum();
        const w = spectrum && lineWidth(spectrum, nm, { searchNm });
        if (!w) {
            result.replaceChildren(para('No clear line there. Try closer to the middle of a dip or a spike.'));
            current = null;
            plot.redraw();
            return;
        }
        current = { w, line };
        const identified = line || nearestListed(w.centre_nm);
        if (identified) lastLine = { rest_nm: identified.rest_nm, label: identified.label || identified.species };
        const name = identified ? lineName(identified) : `Line at ${w.centre_nm.toFixed(2)} nm`;
        const R = Math.round(1 / (2 * (spectrum.wl[1] / spectrum.wl[0] - 1)));
        const widthLine = resultLine(`${name}: ${w.fwhm_nm.toFixed(w.fwhm_nm < 1 ? 3 : 2)} nm wide at half depth, which is ${kmsText(w.fwhm_kms)} km/s`);
        const { entity } = api.resolved;
        const winged = w.shape === 'wings' || (identified ? hasLongWings(identified) : false);
        if (isStarLike(entity)) {
            result.replaceChildren(
                resultLine(rotationText(w, winged), true),
                widthLine,
                para(`v ≈ c × half-width ÷ λ₀, after taking off what the instrument (${kmsText(w.instrument_kms)} km/s at R = ${R.toLocaleString('en-AU')}) and the hot gas itself add.`),
                para(meaning(w, winged))
            );
        } else {
            const spread = 0.5 * Math.sqrt(Math.max(0, w.fwhm_kms ** 2 - w.instrument_kms ** 2));
            result.replaceChildren(
                resultLine(`Spread of speeds: about ±${kmsText(spread)} km/s`, true),
                widthLine,
                para(`v ≈ c × half-width ÷ λ₀. ${WIDTH_MEANS[entity.kind] || 'A line this wide means its source is moving at a range of speeds along your line of sight.'}`)
            );
        }
        const code = entity.code;
        const entry = {
            code,
            line: name.replace(' nm', ''),
            width: w.fwhm_kms,
            rotation: w.velocity_kms,
            atMost: winged,
            unresolved: w.unresolved,
            limit: w.limit_kms
        };
        const at = history.findIndex((h) => h.code === code && h.line === entry.line);
        if (at >= 0) history[at] = entry;
        else history.push(entry);
        if (history.length > 10) history.shift();
        renderHistory();
        plot.redraw();
    }

    // Whichever listed line the measured centre belongs to, if one is clearly it
    function nearestListed(nm) {
        const overview = api.getOverview();
        if (!overview || !overview.lines) return null;
        let best = null;
        let gap = Infinity;
        overview.lines.forEach((line) => {
            if (line.band) return;
            const d = Math.abs(line.obs_nm - nm);
            if (d < gap) {
                gap = d;
                best = line;
            }
        });
        return gap < (nm * 12) / C_KMS ? best : null;
    }

    // The line last zoomed on comes first, so the same line can be read on the next star; then the thin metal lines
    // that show rotation, then the strongest
    function renderPicks() {
        const overview = api.getOverview();
        const lines = (overview && overview.lines) || [];
        const atoms = lines.filter((l) => !l.band);
        const list = [];
        const add = (line) => {
            if (line && !list.some((x) => Math.abs(x.rest_nm - line.rest_nm) < 0.05)) list.push(line);
        };
        if (lastLine) add(atoms.find((l) => Math.abs(l.rest_nm - lastLine.rest_nm) < 0.05));
        suggestRotationLines(overview || {}, 3).forEach(add);
        atoms.slice().filter((l) => l.obs_nm > 330).sort((a, b) => Math.abs(b.depth) - Math.abs(a.depth)).slice(0, 4).forEach(add);
        chips.replaceChildren(...list.slice(0, PICKS).map((line) => el('button', {
            type: 'button',
            class: 'spectro-tool-pick',
            text: lineName(line),
            onclick: () => zoomTo(line.obs_nm, line, line.obs_nm * 0.0015)
        })));
        chips.hidden = !list.length;
    }

    const offClick = plot.onClick((nm, e) => {
        const searchNm = searchNmAt(plot, nm, e);
        const { lo, hi } = plot.getRange();
        // Already close in: measure here, in the spectrum on show, and keep the view
        if (api.getResolution() === 'zoom' && hi / lo < 1.02) measureHere(nm, null, searchNm);
        else zoomTo(nm, null, searchNm);
    });

    return {
        setEntity() {
            current = null;
            result.replaceChildren();
            api.setResolution('zoom');
            renderPicks();
            renderHistory();
            plot.redraw();
        },
        dispose() {
            offClick();
            removeOverlay();
            api.setResolution('overview');
            plot.setRange(started.lo, started.hi);
        }
    };
}

registerTool({
    id: 'line-zoom',
    label: 'Line zoom',
    draws: true,
    appliesTo: () => true,
    mount
});
