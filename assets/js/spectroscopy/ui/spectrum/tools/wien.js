// Wien's Law peak finder: marks where the object's black-body curve peaks and works out T = b / lambda max. When the peak
// is off the short end of the range, it says why and hands over to the black-body reference, or a standard star's match.

import { registerTool } from './index.js';
import { recordMeasurement, getMeasurement } from '../../../core/measurements.js';
import { WIEN_B } from '../../../core/phys.js';
import { plusMinus, sci, sig, withCommas } from '../../../core/format.js';
import { STANDARDS } from '../../../data/standards.js';
import { wienPeak, wienCurveAt } from '../../../spectra/measure.js';
import { el } from '../../plot2d.js';
import { actionRow, diagramLink, fill, hasTab, overlayTheme, para, plotLabel, plotMark, resultLine, statusBox, steps, termLine, toolLink } from './common.js';

const BODY_KINDS = ['star', 'binary', 'multiple', 'black_hole', 'supernova', 'neutron_star'];

function applies(resolved) {
    if (resolved.path === 'member' || resolved.path === 'component') return true;
    return resolved.path === 'body' && BODY_KINDS.includes(resolved.body.kind);
}

// By eye, a curve can be told from its neighbours to about this share of the temperature. With its peak off the short end,
// only a slope is left to match, and that hardly changes with temperature: an O6 star looks as good at 31,000 K as at 43,000 K.
const PEAK_OFF_SCALE_K = 32000;
function blackBodyMatchErr(T) {
    if (T >= 2 * PEAK_OFF_SCALE_K) return 0.3;
    return T >= PEAK_OFF_SCALE_K ? 0.2 : 0.05;
}

function roundTo3(x) {
    return Number(x.toPrecision(3));
}

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

function partCount(api) {
    const { parts } = api.getBodyOpts();
    if (parts && parts.length) return parts.length;
    const { entity } = api.resolved;
    return entity.stars ? entity.stars.length : 1;
}

function mount(container, api) {
    const { plot } = api;
    const result = statusBox();
    const refBlock = el('div', { class: 'spectro-tool-ref', hidden: true });
    container.append(result, refBlock);

    let peak = null;
    let pending = 0;
    const offs = [];

    const removeOverlay = plot.addOverlay((ctx) => {
        if (!peak) return;
        const theme = overlayTheme(plot);
        const pane = plot.panes().body;
        const { lo } = plot.getRange();
        // Under the line labels, if they're showing
        const labelY = pane.y + plot.labelBand() + 12;
        if (peak.belowRange) {
            plotLabel(ctx, theme, `← the peak is below ${sig(lo, 3)} nm`, pane.x + 6, labelY, { align: 'left' });
            return;
        }
        if (peak.T_K === null) return;
        // The fitted curve, dashed, so the mark can be seen to sit at its top and not at some spike in the spectrum
        ctx.save();
        ctx.beginPath();
        ctx.rect(pane.x, pane.y, pane.w, pane.h);
        ctx.clip();
        ctx.strokeStyle = theme.mark;
        ctx.lineWidth = 1.3;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        const stepsAcross = Math.max(24, Math.round(pane.w / 3));
        for (let i = 0; i <= stepsAcross; i++) {
            const x = pane.x + (i / stepsAcross) * pane.w;
            const y = plot.yOf(wienCurveAt(peak.fit, plot.nmOf(x)));
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
        const mark = plotMark(ctx, plot, theme, peak.peak_nm);
        if (!mark) {
            const side = peak.peak_nm < lo;
            plotLabel(ctx, theme, side ? '← peak' : 'peak →', side ? pane.x + 6 : pane.x + pane.w - 6, labelY, { align: side ? 'left' : 'right' });
            return;
        }
        const right = mark.x < pane.x + pane.w * 0.6;
        plotLabel(ctx, theme, `λmax = ${sig(peak.peak_nm, 3)} nm`, mark.x + (right ? 6 : -6), labelY, { align: right ? 'left' : 'right' });
    });

    // A peak that gave a temperature, as opposed to one off the scale or light with no curve to it
    function hasReading() {
        return !!peak && !peak.belowRange && peak.T_K !== null;
    }

    function keepReferenceResult() {
        const m = getMeasurement(api.resolved.entity.code);
        return !!m && m.T_source === 'reference';
    }

    function record(T, err, source) {
        recordMeasurement(api.resolved.entity.code, { T_K: T, T_err_K: err, T_source: source });
    }

    // The way on from a reading: to the H-R diagram if the tab is there and there's something to do on it, and to the
    // Photometer if that's what the diagram still needs
    function nextSteps() {
        const m = getMeasurement(api.resolved.entity.code) || {};
        const items = [diagramLink('hr')];
        if (hasTab('hr') && !(m.flux_Wm2 > 0)) items.push(toolLink(api, 'photometer', 'Photometer next'));
        return actionRow(...items);
    }

    function renderBelowRange() {
        const seen = new Set();
        result.replaceChildren(
            resultLine('The peak is off the scale', true),
            termLine('This object is too hot to find its peak here. Above about 32,000 K, the black-body peak falls below 90 nm, the short end of this spectrum, and what you see is only the curve sloping up towards it. There is no top to read, so Wien\'s law has nothing to work on.', seen, 'spectro-tool-text'),
            para('Instead, fit the black-body reference: show it over the spectrum, then slide its temperature until the two curves have the same shape.')
        );
    }

    function renderPeak() {
        const metres = peak.peak_nm * 1e-9;
        const answer = plusMinus(peak.T_K, peak.err_K);
        const blended = partCount(api) > 1;
        const reading = keepReferenceResult() ? getMeasurement(api.resolved.entity.code) : null;
        fill(result,
            resultLine(`T = ${answer} K`, true),
            steps([
                `λmax = ${sig(peak.peak_nm, 3)} nm = ${sci(metres, 3)} m`,
                `T = b ÷ λmax, with b = ${sci(WIEN_B, 4)} m·K`,
                `T = (${sci(WIEN_B, 4)} m·K) ÷ (${sci(metres, 3)} m) = ${withCommas(peak.T_K)} K`
            ]),
            blended ? para('This is the combined light of several stars, so it is a blend of their temperatures. To look at one star at a time:') : null,
            blended ? actionRow(toolLink(api, 'stars-shown', 'Stars shown')) : null,
            reading ? para(`Your H-R diagram is using ${withCommas(reading.T_K)} K from the reference.`) : null,
            reading ? actionRow(el('button', {
                type: 'button',
                class: 'spectro-tool-next',
                text: 'Use Wien\'s value instead',
                onclick: () => {
                    record(peak.T_K, peak.err_K, 'wien');
                    renderPeak();
                }
            })) : null,
            nextSteps()
        );
    }

    function renderNothing() {
        result.replaceChildren(para('This light doesn\'t follow one black-body curve, so there is no peak to find. Mostly bright lines over very little continuum, such as a supernova long after its peak, have no temperature to read this way.'));
    }

    // A reference that carries a temperature can stand in for the peak: the black-body curve, or a standard star
    function referenceReading() {
        const st = api.picker.state();
        if (!st.item) return null;
        if (st.item.kind === 'blackbody') {
            return { T: st.T, err: blackBodyMatchErr(st.T) * st.T, rough: st.T >= PEAK_OFF_SCALE_K, name: `Black-body reference, ${withCommas(st.T)} K` };
        }
        if (st.item.kind === 'standard') {
            const id = st.item.standard;
            return { T: STANDARDS[id].teff_K, err: standardError(id), name: st.item.label };
        }
        return null;
    }

    function showBlackBody() {
        api.picker.choose('bb');
        plot.setMode('overlay');
        // The slope that matters is at the short end, so show that much of the range
        const { hi } = plot.getRange();
        plot.setRange(90, Math.min(hi, 800), { animate: true });
    }

    function renderReference() {
        const reading = referenceReading();
        const hot = peak && peak.belowRange;
        refBlock.replaceChildren();
        refBlock.hidden = !reading && !hot;
        if (refBlock.hidden) return;
        if (!reading) {
            refBlock.append(actionRow(el('button', { type: 'button', class: 'spectro-tool-go', text: 'Show the black-body reference', onclick: showBlackBody })));
            return;
        }
        const code = api.resolved.entity.code;
        const m = getMeasurement(code);
        const used = !!m && m.T_source === 'reference' && m.T_K === reading.T;
        const low = roundTo3(reading.T - reading.err);
        const high = roundTo3(reading.T + reading.err);
        fill(refBlock,
            para(reading.rough
                ? `${reading.name}. If this matches your spectrum, its temperature is a measurement too, but a rough one. With no peak to read, a slope changes little with temperature, so anything from about ${withCommas(low)} to ${withCommas(high)} K could look as good.`
                : `${reading.name}. If this matches your spectrum, its temperature is a measurement too.`),
            actionRow(el('button', {
                type: 'button',
                class: 'spectro-tool-go',
                text: 'Use this temperature',
                onclick: () => {
                    record(reading.T, reading.err, 'reference');
                    renderReference();
                    if (hasReading()) renderPeak();
                }
            })),
            used ? resultLine(reading.rough ? `T is about ${withCommas(low)} to ${withCommas(high)} K, from the reference` : `T = ${plusMinus(reading.T, reading.err)} K, from the reference`, true) : null,
            // A star with a peak of its own already offers these under its reading
            used && !hasReading() ? nextSteps() : null
        );
    }

    function run({ frame = true } = {}) {
        const spectrum = api.getOverview();
        peak = spectrum ? wienPeak(spectrum) : null;
        if (peak && peak.belowRange) {
            renderBelowRange();
        } else if (hasReading()) {
            if (!keepReferenceResult()) record(peak.T_K, peak.err_K, 'wien');
            renderPeak();
            if (frame) {
                const { lo, hi } = plot.getRange();
                if (peak.peak_nm < lo || peak.peak_nm > hi) {
                    plot.setRange(Math.min(lo, peak.peak_nm * 0.75), Math.max(hi, peak.peak_nm * 1.35), { animate: true });
                }
            }
        } else {
            renderNothing();
        }
        renderReference();
        plot.redraw();
    }

    // A change of stars shown, or of time: wait for it to settle, since a full-range spectrum takes a moment
    offs.push(api.onBodyOpts(() => {
        clearTimeout(pending);
        pending = setTimeout(() => run({ frame: false }), 220);
    }));
    offs.push(api.onReferenceChange(renderReference));

    return {
        setEntity() {
            run();
        },
        dispose() {
            clearTimeout(pending);
            offs.forEach((off) => off());
            removeOverlay();
        }
    };
}

registerTool({
    id: 'wien',
    label: 'Wien\'s Law peak finder',
    draws: true,
    appliesTo: applies,
    mount
});
