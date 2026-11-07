// How is it moving? Two ways, one at a time:
//   Slide the lines    drag a lamp's lines onto the object's own, and read how far they moved (doppler_slide.js)
//   Measure one line   click an observed line, say which line it is, and read off the shift, z and v = cz. Several lines can
//                      be measured and are averaged, which also catches a line given the wrong name. The precise route.

import { registerTool } from './index.js';
import { getMeasurement, recordMeasurement } from '../../../core/measurements.js';
import { C_KMS } from '../../../core/phys.js';
import { signed, sig } from '../../../core/format.js';
import { blendAllowance, lineCentre, dopplerFrom, combineDoppler } from '../../../spectra/measure.js';
import { el } from '../../plot2d.js';
import { actionRow, diagramLink, fill, hasTab, overlayTheme, para, plotLabel, plotMark, resultLine, searchNmAt, statusBox, termLine, toolLink } from './common.js';
import { borrowReference, modeRow } from './hands_on.js';
import { createSlide, direction, galaxyWarning, velocityText, zText } from './doppler_slide.js';

const MAX_CANDIDATES = 6;
// Faster than this along the line of sight, and a star has almost certainly been given the wrong rest line
const STAR_SPEED_LIMIT_KMS = 500;
// Faster than this, with a nearer line going begging, and it's worth a second look
const NEARER_LINE_KMS = 100;

// How far from the clicked wavelength a rest line can be, by kind of object: depends only on the kind
function restWindow(entity, centre) {
    switch (entity.kind) {
    case 'galaxy': return { lo: centre / 1.32, hi: centre * 1.012 };
    case 'quasar': return { lo: centre / 5.5, hi: centre * 1.02 };
    case 'supernova': return { lo: centre * 0.97, hi: centre * 1.07 };
    default: return { lo: centre * 0.992, hi: centre * 1.008 };
    }
}

function lineName(line) {
    const name = String(line.label || line.species || '').replace(/\s*\d+(\.\d+)?$/, '');
    return name || 'Line';
}

function isStar(entity) {
    return !!(entity.star || entity.stars);
}

// The rest lines this could be: from the object's own list and from the reference on show, nearest first. A galaxy's or a
// quasar's lines can be far from where they were emitted, so there it is the strongest in reach that are offered.
function candidatesFor(api, centre) {
    const { entity } = api.resolved;
    const { lo, hi } = restWindow(entity, centre);
    const seen = new Map();
    const take = (lines, fromReference) => {
        (lines || []).forEach((line) => {
            if (line.band || !(line.rest_nm >= lo && line.rest_nm <= hi)) return;
            const key = line.rest_nm.toFixed(2);
            const had = seen.get(key);
            if (!had) seen.set(key, { line, fromReference, strength: Math.abs(line.depth ?? 0) });
            else if (!fromReference) had.fromReference = false;
        });
    };
    const overview = api.getOverview();
    take(overview && overview.lines, false);
    const reference = api.getReference();
    take(reference && reference.lines, true);
    const list = [...seen.values()];
    const far = entity.kind === 'galaxy' || entity.kind === 'quasar';
    list.sort((a, b) => (far ? b.strength - a.strength : Math.abs(a.line.rest_nm - centre) - Math.abs(b.line.rest_nm - centre)));
    return list.slice(0, MAX_CANDIDATES);
}

// The precise route, as it was before the slide joined it. isActive() says whether it is the mode on show: when it isn't, it
// neither draws nor takes clicks.
function mountExact(container, api, isActive) {
    const { plot } = api;
    const prompt = para('Click a line on the plot, then say which line it is. Zoom in close for a sharper reading. By keyboard: on the plot, Shift and an arrow move the cursor, and Enter picks.');
    const picked = el('div', { class: 'spectro-tool-choice', hidden: true });
    const result = statusBox();
    const listEl = el('div', { class: 'spectro-tool-measured', hidden: true });
    // Says what the choice below it can't, as it isn't a live region itself
    const pickedSays = el('p', { class: 'spectro-sr-only', role: 'status' });
    container.append(prompt, picked, pickedSays, result, listEl);

    let found = null;      // The line just clicked
    let rest = null;       // Its chosen rest line
    let choosing = false;  // The list of lines it could be is showing
    let measured = [];     // Lines measured on this object

    const removeOverlay = plot.addOverlay((ctx) => {
        if (!found || !isActive()) return;
        const theme = overlayTheme(plot);
        const pane = plot.panes().body;
        // Under the line labels, if they're showing
        const labelY = pane.y + plot.labelBand() + 12;
        const seen = plotMark(ctx, plot, theme, found.centre_nm);
        if (seen) plotLabel(ctx, theme, 'observed', seen.x, labelY, { within: pane });
        if (!rest) return;
        const home = plotMark(ctx, plot, theme, rest.line.rest_nm, { dashed: true });
        if (home) plotLabel(ctx, theme, 'rest', home.x, labelY + 16, { within: pane });
        if (seen && home && Math.abs(seen.x - home.x) > 14) {
            const y = pane.y + pane.h - 12;
            const dir = seen.x > home.x ? 1 : -1;
            ctx.save();
            ctx.strokeStyle = theme.mark;
            ctx.fillStyle = theme.mark;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(home.x, y);
            ctx.lineTo(seen.x - dir * 6, y);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(seen.x, y);
            ctx.lineTo(seen.x - dir * 7, y - 4);
            ctx.lineTo(seen.x - dir * 7, y + 4);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
    });

    function candidateText(line, fromReference) {
        return `${lineName(line)}, ${line.rest_nm.toFixed(2)} nm${fromReference ? ' (reference)' : ''}`;
    }

    // The choice takes as little of the drawer as it can: a button for each line it could be, nearest first, folding away
    // to one line once chosen so that the answer and the next step are on screen with the plot.
    function renderCandidates(byKeyboard = false) {
        picked.replaceChildren();
        picked.hidden = !found;
        prompt.hidden = !!found || measured.length > 0;
        if (!found) {
            pickedSays.textContent = '';
            return;
        }
        const options = candidatesFor(api, found.centre_nm);
        const kind = found.type === 'em' ? 'Bright line' : 'Dark line';
        const where = `${kind} at ${found.centre_nm.toFixed(found.err_nm < 0.01 ? 3 : 2)} ± ${Math.max(found.err_nm, 0.001).toFixed(found.err_nm < 0.01 ? 3 : 2)} nm`;
        picked.append(resultLine(where));
        const jumpNote = found.jumped ? para('The mark may not be on the dip you meant: others are close by at this zoom, and the uncertainty allows for them. Zoom in to be sure.') : null;
        if (jumpNote) picked.append(jumpNote);
        if (!options.length) {
            picked.append(para('No known line is close to this one. Try another line, or choose a reference whose lines might match.'));
            pickedSays.textContent = `${where}. No known line is close to this one.`;
            return;
        }
        if (rest && !choosing) {
            picked.replaceChildren(el('div', { class: 'spectro-tool-chosen' },
                el('div', {}, resultLine(where), resultLine(`Rest line: ${candidateText(rest.line, rest.fromReference)}`)),
                el('button', {
                    type: 'button',
                    class: 'spectro-tool-next',
                    text: 'Change',
                    onclick: (e) => {
                        choosing = true;
                        renderCandidates(e.detail === 0);
                    }
                })));
            if (jumpNote) picked.append(jumpNote);
            return;
        }
        const group = el('fieldset', { class: 'spectro-tool-options' }, el('legend', { text: 'Which line is it?' }));
        const buttons = options.map((option) => el('button', {
            type: 'button',
            class: 'spectro-tool-pick',
            'aria-pressed': rest && rest.line.rest_nm === option.line.rest_nm ? 'true' : 'false',
            text: candidateText(option.line, option.fromReference),
            onclick: (e) => {
                choosing = false;
                chooseRest(option);
                // By keyboard, the answer is where to go next, not all the way back through the page
                if (e.detail === 0) {
                    const answer = result.querySelector('.spectro-tool-answer');
                    if (answer) {
                        answer.tabIndex = -1;
                        answer.focus();
                    }
                }
            }
        }));
        group.append(el('div', { class: 'spectro-tool-picklist' }, ...buttons));
        picked.append(group);
        pickedSays.textContent = `${where}. ${options.length} lines it could be.`;
        if (byKeyboard) buttons[0].focus();
    }

    function renderList() {
        listEl.replaceChildren();
        listEl.hidden = measured.length < 2;
        if (listEl.hidden) return;
        const rows = measured.map((m, i) => el('tr', {},
            el('td', { text: `${lineName(m.line)} ${m.line.rest_nm.toFixed(1)}` }),
            el('td', { text: Math.abs(m.d.z) > 0.1 ? `z ${signed(m.d.z, 3)}` : `${signed(m.d.v_kms, 0)} km/s` }),
            el('td', {}, el('button', {
                type: 'button',
                class: 'spectro-tool-remove',
                text: '×',
                'aria-label': `Remove ${lineName(m.line)} ${m.line.rest_nm.toFixed(1)} nm`,
                onclick: () => {
                    measured.splice(i, 1);
                    renderResult();
                    renderList();
                }
            }))));
        listEl.append(el('table', { class: 'spectro-tool-table' },
            el('caption', { text: 'Lines measured so far' }),
            el('tbody', {}, ...rows)));
    }

    // A close pair of lines is easy to swap, and the tiny uncertainty on the answer says nothing about that. On a star, a
    // nearer line than the one chosen, or a speed no star has, is worth saying out loud.
    function wrongLineWarning(v, beyond) {
        const galaxy = !beyond && galaxyWarning(api.resolved.entity, v / C_KMS);
        if (galaxy) return el('p', { class: 'spectro-tool-warning', text: galaxy });
        if (beyond || !found || !rest || !isStar(api.resolved.entity)) return null;
        const faster = Math.abs(v) > STAR_SPEED_LIMIT_KMS;
        const nearest = candidatesFor(api, found.centre_nm)[0];
        const nearer = nearest && nearest.line.rest_nm !== rest.line.rest_nm ? nearest.line : null;
        const speedThere = nearer ? ((found.centre_nm / nearer.rest_nm) - 1) * C_KMS : 0;
        if (nearer && Math.abs(speedThere) < Math.abs(v) && Math.abs(v) > NEARER_LINE_KMS) {
            return el('p', { class: 'spectro-tool-warning', text: `Check the rest line: ${lineName(nearer)} is nearer, and would give ${signed(speedThere, 0)} km/s. Close pairs are easy to swap.` });
        }
        return faster ? el('p', { class: 'spectro-tool-warning', text: 'That is far faster than stars move, so this is probably the wrong rest line.' }) : null;
    }

    function renderResult() {
        result.replaceChildren();
        if (!measured.length) return;
        const combined = combineDoppler(measured.map((m) => m.d));
        const code = api.resolved.entity.code;
        recordMeasurement(code, { v_kms: combined.v_kms, v_err_kms: combined.err_kms, z: combined.z, v_source: 'line' });
        const last = measured[measured.length - 1];
        const beyond = Math.abs(combined.z) > 0.1;
        const m = getMeasurement(code) || {};
        const seen = new Set();
        const shift = `Δλ = ${last.d.dlambda_nm >= 0 ? '+' : '−'}${Math.abs(last.d.dlambda_nm).toFixed(Math.abs(last.d.dlambda_nm) < 1 ? 3 : 2)} nm from ${lineName(last.line)}`;
        const answer = beyond ? `z = ${zText(combined.z, combined.err_z)}` : `v = ${velocityText(combined.v_kms, combined.err_kms)}`;
        fill(result,
            el('p', { class: 'spectro-tool-answer' }, answer, el('span', { class: 'spectro-tool-direction', text: direction(combined.z) })),
            wrongLineWarning(combined.v_kms, beyond),
            // The way on comes before the explaining, so that it's on screen along with the answer
            actionRow(
                diagramLink('hubble'),
                hasTab('hubble') && api.resolved.entity.kind === 'galaxy' && !(m.distance_pc > 0) ? toolLink(api, 'photometer', 'Brightness next') : null,
                keyboardUsed ? el('button', { type: 'button', class: 'spectro-tool-next', text: 'Measure another line', onclick: () => plot.canvas.focus() }) : null
            ),
            termLine(beyond ? shift : `${shift}, so z = Δλ ÷ λ₀ = ${zText(combined.z, combined.err_z)}, and v = cz`, seen),
            beyond ? termLine(`z is above 0.1, so v = cz no longer applies: it would give ${sig(combined.v_kms, 3)} km/s, but light this stretched has crossed an expanding Universe. Astronomers quote z itself.`, seen, 'spectro-tool-text') : null,
            measured.length > 1 ? para(`The average of ${measured.length} lines.`) : para('Measure another line to check: all lines of one object share the same shift. Narrow lines give the sharpest speed.'),
            last.d.blended ? para('Another line sits inside this dip, so it may be two lines run together, and the uncertainty allows for that. A line standing alone gives a sharper speed.') : null,
            combined.disagree ? para('These lines don\'t agree. One of them may have been given the wrong rest line.') : null
        );
    }

    function chooseRest(option) {
        rest = option;
        const overview = api.getOverview();
        const rough = found.centre_nm / option.line.rest_nm - 1;
        const leaning = blendAllowance(overview && overview.lines, option.line.rest_nm, found.fwhm_nm, rough);
        const d = dopplerFrom(found.centre_nm, option.line.rest_nm, Math.hypot(found.err_nm, leaning));
        d.blended = leaning > 0;
        // Picking again for the same click changes that line's answer; a new click adds a line
        if (found.index !== undefined) measured[found.index] = { line: option.line, d };
        else {
            found.index = measured.length;
            measured.push({ line: option.line, d });
        }
        renderCandidates();
        renderResult();
        renderList();
        plot.redraw();
    }

    let keyboardUsed = false;

    const offClick = plot.onClick((nm, e) => {
        const spectrum = api.getSpectrum();
        if (!spectrum || !isActive()) return;
        const line = lineCentre(spectrum, nm, { searchNm: searchNmAt(plot, nm, e) });
        keyboardUsed = !!e && e.type === 'keydown';
        if (!line) {
            found = null;
            rest = null;
            choosing = false;
            renderCandidates();
            result.replaceChildren(para('No clear line there. Try closer to the middle of a dip or a spike, or zoom in.'));
            plot.redraw();
            return;
        }
        found = line;
        rest = null;
        choosing = true;
        renderCandidates(keyboardUsed);
        if (!measured.length) result.replaceChildren();
        plot.redraw();
    });

    return {
        setEntity() {
            found = null;
            rest = null;
            choosing = false;
            measured = [];
            renderCandidates();
            result.replaceChildren();
            renderList();
            plot.redraw();
        },
        dispose() {
            offClick();
            removeOverlay();
        }
    };
}

// The easiest first: the tool picks the object's best line and zooms to it, and the student lines up one reference line
const MODES = [
    { id: 'best', label: 'Best line' },
    { id: 'slide', label: 'Slide the lines' },
    { id: 'exact', label: 'Measure one line' }
];

// The mode is kept from one object to the next
const memory = { mode: 'best' };

function mount(container, api) {
    const reference = borrowReference(api);
    let mode = null;
    const says = el('p', { class: 'spectro-sr-only', role: 'status' });
    const modes = modeRow('How to measure the motion', MODES, (id) => select(id));
    const bestBox = el('div', { class: 'spectro-hands-mode-body' });
    const slideBox = el('div', { class: 'spectro-hands-mode-body' });
    const exactBox = el('div', { class: 'spectro-hands-mode-body spectro-tool-body' });
    container.append(modes.el, bestBox, slideBox, exactBox, says);
    const best = createSlide(bestBox, api, { says, single: true });
    const slide = createSlide(slideBox, api, { says });
    const exact = mountExact(exactBox, api, () => mode === 'exact');
    const slides = { best, slide };

    function select(next) {
        if (mode === next) return;
        if (slides[mode]) slides[mode].leave();
        mode = next;
        memory.mode = next;
        modes.set(next);
        bestBox.hidden = next !== 'best';
        slideBox.hidden = next !== 'slide';
        exactBox.hidden = next !== 'exact';
        // Sliding draws its own reference lines, so the reference stands aside for it; measuring one line has it back
        if (slides[next]) {
            reference.show('none');
            slides[next].enter();
        } else {
            reference.give();
        }
        api.plot.redraw();
    }

    return {
        setEntity(resolved) {
            // Zooming in close shows a line at high resolution, where its centre can be read more finely
            api.setResolution('zoom');
            best.setEntity(resolved);
            slide.setEntity(resolved);
            exact.setEntity(resolved);
            if (!mode) select(memory.mode);
        },
        dispose() {
            best.dispose();
            slide.dispose();
            exact.dispose();
            reference.dispose();
            api.setResolution('overview');
        }
    };
}

registerTool({
    id: 'doppler',
    label: 'How is it moving?',
    draws: true,
    appliesTo: () => true,
    mount
});
