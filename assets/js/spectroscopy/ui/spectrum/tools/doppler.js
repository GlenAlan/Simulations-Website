// Doppler measure: click an observed line, say which line it is, and read off the shift, z and v = cz. Several lines can
// be measured and are averaged, which also catches a line given the wrong name.

import { registerTool } from './index.js';
import { recordMeasurement } from '../../../core/measurements.js';
import { signed, sig, withCommas } from '../../../core/format.js';
import { blendAllowance, lineCentre, dopplerFrom, combineDoppler } from '../../../spectra/measure.js';
import { el } from '../../plot2d.js';
import { actionRow, diagramLink, fill, overlayTheme, para, plotLabel, plotMark, resultLine, searchNmAt, statusBox } from './common.js';

const MAX_CANDIDATES = 7;

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
    const top = list.slice(0, MAX_CANDIDATES);
    top.sort((a, b) => a.line.rest_nm - b.line.rest_nm);
    return top;
}

function direction(z) {
    return z >= 0 ? '→ moving away' : '← moving towards us';
}

// z and v with an uncertainty rounded together: enough digits to show it, no more
function zText(z, err) {
    const digits = err > 0 ? Math.max(2, Math.min(6, Math.ceil(-Math.log10(err)))) : 5;
    return `${signed(z, digits)} ± ${err.toFixed(digits)}`;
}

function velocityText(v, err) {
    const digits = err < 1 ? 1 : 0;
    const shown = err < 1 ? err.toFixed(1) : withCommas(Math.max(1, err));
    const value = digits ? signed(v, 1) : `${v < 0 ? '−' : '+'}${withCommas(Math.abs(v))}`;
    return `${value} ± ${shown} km/s`;
}

function mount(container, api) {
    const { plot } = api;
    const prompt = para('Click a line on the plot. Zoom in close for a sharper reading. By keyboard: focus the plot, move the cursor with Shift and an arrow key, and press Enter to pick.');
    const picked = el('div', { class: 'spectro-tool-choice', hidden: true });
    const result = statusBox();
    const listEl = el('div', { class: 'spectro-tool-measured', hidden: true });
    container.append(prompt, picked, result, listEl);

    let found = null;      // The line just clicked
    let rest = null;       // Its chosen rest line
    let measured = [];     // Lines measured on this object
    const radioName = `spectroDopplerRest${++mount.count}`;

    const removeOverlay = plot.addOverlay((ctx) => {
        if (!found) return;
        const theme = overlayTheme(plot);
        const pane = plot.panes().body;
        const seen = plotMark(ctx, plot, theme, found.centre_nm);
        if (seen) plotLabel(ctx, theme, 'observed', seen.x, pane.y + 12, { within: pane });
        if (!rest) return;
        const home = plotMark(ctx, plot, theme, rest.line.rest_nm, { dashed: true });
        if (home) plotLabel(ctx, theme, 'rest', home.x, pane.y + 28, { within: pane });
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

    function renderCandidates() {
        picked.replaceChildren();
        picked.hidden = !found;
        if (!found) return;
        const options = candidatesFor(api, found.centre_nm);
        const kind = found.type === 'em' ? 'Bright line' : 'Dark line';
        picked.append(resultLine(`${kind} at ${found.centre_nm.toFixed(found.err_nm < 0.01 ? 3 : 2)} ± ${Math.max(found.err_nm, 0.001).toFixed(found.err_nm < 0.01 ? 3 : 2)} nm`));
        if (!options.length) {
            picked.append(para('No known line is close to this one. Try another line, or choose a reference whose lines might match.'));
            return;
        }
        const group = el('fieldset', { class: 'spectro-tool-options' }, el('legend', { text: 'Which line is it? Choose its rest wavelength.' }));
        options.forEach(({ line, fromReference }) => {
            const id = `${radioName}-${line.rest_nm.toFixed(3).replace('.', '-')}`;
            const input = el('input', { type: 'radio', id, name: radioName, value: String(line.rest_nm) });
            input.addEventListener('change', () => chooseRest({ line, fromReference }));
            if (rest && rest.line.rest_nm === line.rest_nm) input.checked = true;
            group.append(el('div', { class: 'spectro-tool-option' }, input, el('label', { for: id, text: `${lineName(line)}, ${line.rest_nm.toFixed(2)} nm${fromReference ? ' (reference)' : ''}` })));
        });
        picked.append(group);
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

    function renderResult() {
        result.replaceChildren();
        if (!measured.length) return;
        const combined = combineDoppler(measured.map((m) => m.d));
        const code = api.resolved.entity.code;
        recordMeasurement(code, { v_kms: combined.v_kms, v_err_kms: combined.err_kms, z: combined.z });
        const last = measured[measured.length - 1];
        const beyond = Math.abs(combined.z) > 0.1;
        fill(result,
            beyond
                ? resultLine(`z = ${zText(combined.z, combined.err_z)}`, true)
                : resultLine(`v = ${velocityText(combined.v_kms, combined.err_kms)}`, true),
            resultLine(direction(combined.z)),
            resultLine(`Δλ = ${last.d.dlambda_nm >= 0 ? '+' : '−'}${Math.abs(last.d.dlambda_nm).toFixed(Math.abs(last.d.dlambda_nm) < 1 ? 3 : 2)} nm from ${lineName(last.line)}`),
            beyond ? null : resultLine(`z = Δλ ÷ λ₀ = ${zText(combined.z, combined.err_z)}, and v = cz`),
            beyond ? para(`z is above 0.1, so v = cz no longer applies: it would give ${sig(combined.v_kms, 3)} km/s, but light this stretched has crossed an expanding Universe. Astronomers quote z itself.`) : null,
            measured.length > 1 ? para(`The average of ${measured.length} lines.`) : para('Measure another line to check this one: all lines of one object share the same shift. Narrow lines give the sharpest speed, and broad ones only a rough one.'),
            last.d.blended ? para('Another line sits inside this dip, so it may be two lines run together, and the uncertainty allows for that. A line standing alone gives a sharper speed.') : null,
            combined.disagree ? para('These lines don\'t agree. One of them may have been given the wrong rest line.') : null,
            actionRow(diagramLink('hubble'))
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
        renderResult();
        renderList();
        plot.redraw();
    }

    const offClick = plot.onClick((nm, e) => {
        const spectrum = api.getSpectrum();
        if (!spectrum) return;
        const line = lineCentre(spectrum, nm, { searchNm: searchNmAt(plot, nm, e) });
        if (!line) {
            found = null;
            rest = null;
            renderCandidates();
            result.replaceChildren(para('No clear line there. Try closer to the middle of a dip or a spike, or zoom in.'));
            plot.redraw();
            return;
        }
        found = line;
        rest = null;
        renderCandidates();
        if (!measured.length) result.replaceChildren();
        plot.redraw();
    });

    return {
        setEntity() {
            found = null;
            rest = null;
            measured = [];
            // Zooming in close shows the line at high resolution, where its centre can be read more finely
            api.setResolution('zoom');
            renderCandidates();
            result.replaceChildren();
            renderList();
            plot.redraw();
        },
        dispose() {
            offClick();
            removeOverlay();
            api.setResolution('overview');
        }
    };
}
mount.count = 0;

registerTool({
    id: 'doppler',
    label: 'Doppler measure',
    draws: true,
    appliesTo: () => true,
    mount
});
