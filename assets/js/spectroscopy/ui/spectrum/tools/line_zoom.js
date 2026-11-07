// Line zoom: shows one line at high resolution, measures its width, and says how much of it is rotation and how much is
// pressure, from the shape of that line. Widths are kept through the session so that stars can be compared.

import { registerTool } from './index.js';
import { C_KMS } from '../../../core/phys.js';
import { lineWidth, lineZoomWindow, hasLongWings, suggestRotationLines, ROTATION_FWHM, FASTEST_SPIN_KMS } from '../../../spectra/measure.js';
import { el } from '../../plot2d.js';
import { actionRow, overlayTheme, para, plotLabel, resultLine, searchNmAt, statusBox } from './common.js';

const PICKS = 5;
const ROTATION_PICKS = 3;
// The lines a giant and a dwarf differ in most: pressure sets their width. Named so that every star offers the same ones.
const PRESSURE_LINES = ['Hα', 'Na D₂', 'Ca II K'];
const SPIN_RULES_FROM_KMS = 100;
const THIN_GAS_PRESSURE_KMS = 12;

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

function lineName(line) {
    return `${String(line.label || line.species || 'Line').replace(/\s*\d+(\.\d+)?$/, '')} ${line.rest_nm.toFixed(1)} nm`;
}

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
    case 'noisy': return 'Rotation: too noisy to read from this line';
    case 'too wide': return 'Rotation: can\'t tell from this line';
    case 'unresolved': return `Rotation: unresolved (< ${Math.round(w.limit_kms)} km/s)`;
    case 'limit': return `Rotation: at most ${kmsText(reading.value)} km/s`;
    default: return `Rotation: v sin i ≈ ${kmsText(reading.value)} ± ${kmsText(reading.err)} km/s`;
    }
}

function rotationCell(w, reading) {
    switch (reading.kind) {
    case 'noisy':
    case 'too wide': return 'can\'t tell';
    case 'unresolved': return `< ${Math.round(w.limit_kms)}`;
    case 'limit': return `up to ${kmsText(reading.value)}`;
    default: return kmsText(reading.value);
    }
}

// The working behind a reading, for a student with a calculator
function workingText(w, reading) {
    if (reading.kind !== 'value') return null;
    const { width, base, spread, spin } = spinSum(w);
    return `Without spin it would be about ${sumText(base)} km/s wide, from the instrument, hot gas and pressure: √(${sumText(width)}² − ${sumText(base)}²) = ${sumText(spread)} km/s. Spin makes a line ${ROTATION_FWHM} × v sin i wide, not 2 ×, as little of a star's light comes from its fast-moving edges: ${sumText(spread)} ÷ ${ROTATION_FWHM} = ${kmsText(spin)} km/s.`;
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

// What this line's own shape says. Words go by what was measured on it, not by what kind of line or star it is.
function meaning(w, winged, reading) {
    const width = kmsText(w.fwhm_kms);
    const pressure = kmsText(w.pressure_kms);
    const spinWidth = ROTATION_FWHM * w.velocity_kms;
    if (reading.kind === 'noisy') {
        return 'Too much noise here to split this width into spin and pressure. A deeper line or a brighter star would settle it.';
    }
    if (reading.kind === 'too wide') {
        return `At ${width} km/s this is far wider than any star could spin: it is pressure, or several lines run together.`;
    }
    if (winged) {
        if (w.pressure_kms <= THIN_GAS_PRESSURE_KMS) {
            return `Pressure adds only about ${pressure} km/s here, so the gas is thin or this element is scarce.`;
        }
        if (w.pressure_kms >= spinWidth || w.fwhm_kms >= 150) {
            return `Most of this ${width} km/s is long wings around a narrow core, from pressure. Denser gas spreads them wider.`;
        }
        return `Spin and pressure both widen this line, about ${pressure} km/s of it from pressure.`;
    }
    if (reading.kind === 'unresolved') {
        return `Too narrow to show rotation: the instrument, hot gas and pressure alone make about ${kmsText(w.base_kms)} of these ${width} km/s. That is a real limit, not a fault.`;
    }
    if (spinWidth >= 0.7 * w.fwhm_kms) {
        return w.shape === 'steep' && w.fwhm_kms >= 25
            ? 'Steep sides and a flat bottom, the shape that spin gives.'
            : 'Most of this width is spin.';
    }
    return 'Part of this width is spin. The rest is the instrument, hot gas and pressure.';
}

function mount(container, api) {
    const { plot } = api;
    const intro = para('Click a line on the plot, or pick one here.');
    const chips = el('div', {});
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
                    el('td', { text: h.rotation }))))),
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

    function noLine(line) {
        const named = line ? `${lineName(line)} doesn't stand clear of the noise in this spectrum. Try a stronger line, or a brighter object.` : 'No clear dip or spike here. Try closer to the middle of one, or zoom in.';
        result.replaceChildren(para(named));
        current = null;
        plot.redraw();
    }

    // Finds the line in the overview first: its width there sets how far to zoom
    function zoomTo(nm, line, searchNm) {
        const overview = api.getOverview();
        const identity = line || nearestListed(nm);
        const view = lineZoomWindow(overview, nm, { line, searchNm, hydrogen: identity?.species === 'H I' });
        if (!view) {
            noLine(null);
            return;
        }
        api.setResolution('zoom', { lo_nm: view.centre_nm - view.half_nm, hi_nm: view.centre_nm + view.half_nm });
        measureHere(view.centre_nm, line, view.search_nm);
    }

    function measureHere(nm, line, searchNm) {
        const spectrum = api.getSpectrum();
        const identity = line || nearestListed(nm);
        const w = spectrum && lineWidth(spectrum, nm, { searchNm, hydrogen: identity?.species === 'H I' });
        if (!w) {
            noLine(line);
            return;
        }
        current = { w, line };
        const identified = line || nearestListed(w.centre_nm);
        if (identified) lastLine = { rest_nm: identified.rest_nm, label: identified.label || identified.species };
        const name = identified ? lineName(identified) : `Line at ${w.centre_nm.toFixed(2)} nm`;
        const widthLine = resultLine(`${name}: ${w.fwhm_nm.toFixed(w.fwhm_nm < 1 ? 3 : 2)} nm wide at half depth. c × that ÷ λ₀ is ${sumText(w.fwhm_kms)} km/s.`);
        const { entity } = api.resolved;
        const winged = pressureRules(w, identified);
        const reading = spinReading(w, winged);
        if (isStarLike(entity)) {
            const working = workingText(w, reading);
            result.replaceChildren(
                resultLine(rotationText(w, reading), true),
                widthLine,
                ...(working ? [para(working)] : []),
                para(meaning(w, winged, reading))
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
            rotation: isStarLike(entity) ? rotationCell(w, reading) : 'not a star'
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

    function pickRow(text, label, lines) {
        if (!lines.length) return [];
        return [
            para(text),
            el('div', { class: 'spectro-tool-picks', role: 'group', 'aria-label': label }, ...lines.map((line) => el('button', {
                type: 'button',
                class: 'spectro-tool-pick',
                text: lineName(line),
                onclick: () => zoomTo(line.obs_nm, line, line.obs_nm * 0.0015)
            })))
        ];
    }

    // A star's lines come in two groups, because they answer two questions and only one line of each suits each. A student
    // comparing a thin metal line between a giant and a dwarf is comparing their spins. The line last zoomed on stays in its
    // group, so the same line can be read on the next star.
    function renderPicks() {
        const overview = api.getOverview();
        const lines = (overview && overview.lines) || [];
        const atoms = lines.filter((l) => !l.band);
        const same = (a, b) => Math.abs(a.rest_nm - b.rest_nm) < 0.05;
        const last = lastLine ? atoms.concat((overview && overview.zoomLines) || []).find((l) => same(l, lastLine)) : null;
        const { entity } = api.resolved;
        if (!isStarLike(entity)) {
            const list = [];
            const add = (line) => {
                if (line && !list.some((x) => same(x, line))) list.push(line);
            };
            add(last);
            atoms.slice().filter((l) => l.obs_nm > 330).sort((a, b) => Math.abs(b.depth) - Math.abs(a.depth)).slice(0, PICKS).forEach(add);
            chips.replaceChildren(...pickRow('Lines to zoom in on:', 'Lines to zoom in on', list.slice(0, PICKS)));
            chips.hidden = !list.length;
            return;
        }
        const pressure = PRESSURE_LINES.map((label) => atoms.find((l) => l.label === label)).filter(Boolean);
        const rotation = suggestRotationLines(overview || {}, ROTATION_PICKS).filter((line) => !pressure.some((p) => same(p, line)));
        if (last && !pressure.concat(rotation).some((l) => same(l, last))) (hasLongWings(last) ? pressure : rotation).unshift(last);
        chips.replaceChildren(
            ...pickRow('Giant or dwarf? Compare one of these on both stars: pressure widens them, so the wider one is the denser star, the dwarf.', 'Lines that show density', pressure),
            ...pickRow('Rotation: the lines that show this star\'s spin best. One side of a star comes towards you as the other goes away, which spreads every line evenly. v sin i is the part of the spin along your line of sight.', 'Lines that show rotation', rotation)
        );
        chips.hidden = !pressure.length && !rotation.length;
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
