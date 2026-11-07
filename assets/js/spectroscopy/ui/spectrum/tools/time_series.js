// Time series: a line's position against time for binaries, multiples and black-hole companions. The picture builds up as
// playback runs: each column is the spectrum around one line at one moment, and the marks are that line's measured centre
// for each star. From those come the period, the speed swing K, and with them the masses (see orbit_sums.js).

import { registerTool } from './index.js';
import { bus } from '../../../core/state.js';
import { C_KMS, R_ZOOM } from '../../../core/phys.js';
import { spectrumOf } from '../../../spectra/synth.js';
import { dopplerFrom, fitOrbit, lineCentre, suggestTrackingLines } from '../../../spectra/measure.js';
import { componentStates } from '../../../data/orbits.js';
import { createPlayback } from '../../playback.js';
import { drawMarker, el, markerIcon } from '../../plot2d.js';
import { createTimeFigure, labelledSelect, niceSpeeds, overlayTheme, para, plotLabel, plotMark, setOptions, statusBox, timeSlider } from './common.js';
import { orbitResults } from './orbit_sums.js';

const COLUMNS = 240;             // Moments across the picture
const ROWS = 72;                 // Speeds up its side
const TRACK_EVERY = 4;           // Measure the line's centre at every this many columns
const CYCLES_SHOWN = 3;
const FILL_PER_FRAME = 2;        // Columns worked out per frame, so that playback stays smooth
const LONGEST_SHOWN_DAYS = 20000; // A slower orbit than this can't be played: its stars would barely move
const SHAPES = ['circle', 'square', 'triangle', 'diamond'];
const MIN_ERR_KMS = 0.5;

function applies(resolved) {
    const { body } = resolved;
    return !!(body && (body.black_hole || (body.stars && body.orbits && body.orbits.length))) && resolved.path !== 'planet';
}

// Each star followed: its code, and a mark that isn't told apart by colour
function followedStars(resolved, parts) {
    const { body, entity, path } = resolved;
    if (body.black_hole) return [{ code: body.black_hole.companion.code, mass: body.black_hole.companion.star.mass_Msun, part: null }];
    if (path === 'component') return [{ code: entity.code, part: null }];
    const list = body.stars.filter((s) => !parts || parts.includes(s.code));
    return list.map((s) => ({ code: s.code, part: s.code }));
}

// The orbits that matter for what is on show, shortest first
function periodsFor(resolved, stars) {
    const { body } = resolved;
    if (body.black_hole) return [body.black_hole.period_days];
    if (body.figure_eight) return [body.figure_eight.period_days];
    const codes = stars.map((s) => s.code);
    const indexOf = (i) => body.stars[i].code;
    const periods = body.orbits
        .filter((o) => [...o.a, ...o.b].some((i) => codes.includes(indexOf(i))))
        .map((o) => o.period_days)
        .filter((p) => p > 0 && p < LONGEST_SHOWN_DAYS);
    return [...new Set(periods)].sort((a, b) => a - b);
}

function daysText(d) {
    return d >= 100 ? `${Math.round(d).toLocaleString('en-AU')} days` : `${Number(d.toPrecision(3))} days`;
}

function lineTitle(line) {
    return `${String(line.label || line.species).replace(/\s*\d+(\.\d+)?$/, '')}, ${line.rest_nm.toFixed(1)} nm`;
}

function mount(container, api) {
    const { plot } = api;
    const intro = para('Press Play and watch the line move. Each star\'s lines swing to and fro as it orbits. The time for one swing is the period.');
    const lineField = labelledSelect('Line to follow', (value) => {
        line = lines[Number(value)];
        rebuild();
    });
    const spanField = labelledSelect('Time to show', (value) => {
        span = Number(value);
        rebuild();
    });
    const controls = el('div', { class: 'spectro-tool-controls' });
    const legend = el('div', { class: 'spectro-fig-legend', hidden: true });
    const result = statusBox();
    const started = plot.getRange();

    // Play first and the picture straight under it, so both are in view with the plot above them
    container.append(controls);

    // ---------- State ----------

    let resolved = null;
    let entity = null;
    let stars = [];
    let lines = [];
    let line = null;
    let span = 1;
    let shortest = 1;
    let vLo = -100;
    let vHi = 100;
    let halfKms = 200;
    let reachKms = 100;
    let image = null;
    let imageCanvas = null;
    let filled = new Uint8Array(COLUMNS);
    let filledCount = 0;
    let wanted = 0;           // Columns up to here should be worked out
    let filling = 0;
    let playhead = 0;
    let fitsDue = false;
    let fitBucket = 0;

    // ---------- The picture ----------

    const figure = createTimeFigure(container, {
        label: 'Time series',
        xTitle: 'Time (days)',
        yTitle: 'Line shift (km/s)',
        height: 210,
        range: () => ({ xLo: 0, xHi: span, yLo: vLo, yHi: vHi }),
        paint(ctx, frame, rect, sx, sy) {
            const { theme } = frame;
            if (imageCanvas) {
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(imageCanvas, rect.x, rect.y, rect.w, rect.h);
            }
            // No shift, and the system's own speed that the swing is centred on, are lines worth having
            if (vLo < 0 && vHi > 0) {
                ctx.strokeStyle = theme.text;
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 4]);
                ctx.beginPath();
                ctx.moveTo(rect.x, sy(0));
                ctx.lineTo(rect.x + rect.w, sy(0));
                ctx.stroke();
                ctx.setLineDash([]);
            }
            stars.forEach((star, s) => {
                star.points.forEach((p) => {
                    drawMarker(ctx, SHAPES[s % SHAPES.length], sx(p.t), sy(p.v), 2.6, { fill: theme.paper, stroke: theme.accent, width: 1.3 });
                });
            });
            const at = sx(playhead);
            ctx.strokeStyle = theme.accent;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(at, rect.y);
            ctx.lineTo(at, rect.y + rect.h);
            ctx.stroke();
        }
    });
    const after = el('div', { class: 'spectro-tool-controls' });
    container.append(after, legend, result, lineField.wrap, spanField.wrap, intro);

    const removeOverlay = plot.addOverlay((ctx) => {
        if (!line) return;
        const theme = overlayTheme(plot);
        const mark = plotMark(ctx, plot, theme, line.rest_nm, { dashed: true, width: 1.3 });
        if (mark) plotLabel(ctx, theme, 'rest', mark.x, mark.top + 12);
    });

    // ---------- Working out the columns ----------

    function sliceOpts(t, part) {
        const lo = line.rest_nm * (1 - halfKms / C_KMS);
        const hi = line.rest_nm * (1 + halfKms / C_KMS);
        const opts = { lo_nm: lo, hi_nm: hi, R: R_ZOOM, t };
        const { parts } = api.getBodyOpts();
        if (part) opts.parts = [part];
        else if (parts && !resolved.body.black_hole) opts.parts = parts;
        return opts;
    }

    function paintColumn(col) {
        const t = ((col + 0.5) / COLUMNS) * span;
        const spectrum = spectrumOf(entity, sliceOpts(t));
        const { wl, flux } = spectrum;
        const sorted = Float32Array.from(flux).sort();
        const top = sorted[Math.floor(sorted.length * 0.92)] || 1;
        for (let r = 0; r < ROWS; r++) {
            const v = vLo + ((r + 0.5) / ROWS) * (vHi - vLo);
            const nm = line.rest_nm * (1 + v / C_KMS);
            let i = Math.round(Math.log(nm / wl[0]) / Math.log(wl[1] / wl[0]));
            i = Math.max(0, Math.min(wl.length - 1, i));
            // Averaged over a few samples, since a row of the picture is wider than a sample
            let sum = 0;
            let n = 0;
            for (let j = Math.max(0, i - 2); j <= Math.min(wl.length - 1, i + 2); j++) {
                sum += flux[j];
                n++;
            }
            image[col * ROWS + r] = Math.max(0, Math.min(1, 1 - (n ? sum / n : top) / top));
        }
        filled[col] = 1;
        filledCount++;
        if (col % TRACK_EVERY === 0) trackColumn(t);
    }

    function trackColumn(t) {
        stars.forEach((star) => {
            const spectrum = spectrumOf(entity, sliceOpts(t, star.part));
            const near = star.last ?? line.rest_nm * (1 + (0.5 * (vLo + vHi)) / C_KMS);
            const search = star.last ? 0.4 * reachKms : reachKms;
            const found = lineCentre(spectrum, near, { searchNm: (line.rest_nm * search) / C_KMS, type: 'abs' });
            if (!found) return;
            star.last = found.centre_nm;
            const d = dopplerFrom(found.centre_nm, line.rest_nm, found.err_nm);
            star.points.push({ t, v: d.v_kms, err: Math.max(MIN_ERR_KMS, d.err_kms) });
        });
        fitsDue = true;
    }

    function fillStep() {
        filling = 0;
        let budget = FILL_PER_FRAME;
        for (let col = 0; col <= wanted && col < COLUMNS && budget > 0; col++) {
            if (filled[col]) continue;
            paintColumn(col);
            budget--;
        }
        drawImage();
        // Fitting takes a moment, so while playing it waits for several new points; once paused or finished it catches up
        const bucket = Math.floor(filledCount / (TRACK_EVERY * 4));
        const paused = !playback || !playback.playing;
        if (fitsDue && (bucket !== fitBucket || filledCount >= COLUMNS || (paused && filledCount >= wanted + 1))) {
            fitBucket = bucket;
            updateResults();
        }
        figure.redraw();
        if (budget === 0 && filledCount < wanted + 1) filling = requestAnimationFrame(fillStep);
    }

    function requestFill() {
        if (!filling) filling = requestAnimationFrame(fillStep);
    }

    function drawImage() {
        if (!imageCanvas) {
            imageCanvas = document.createElement('canvas');
            imageCanvas.width = COLUMNS;
            imageCanvas.height = ROWS;
        }
        const ctx = imageCanvas.getContext('2d');
        const out = ctx.createImageData(COLUMNS, ROWS);
        const dark = document.documentElement.classList.contains('dark-mode');
        const paper = dark ? 24 : 255;
        const ink = dark ? 235 : 20;
        for (let col = 0; col < COLUMNS; col++) {
            if (!filled[col]) continue;
            for (let r = 0; r < ROWS; r++) {
                const d = image[col * ROWS + r];
                const level = paper + (ink - paper) * d ** 0.75;
                const o = ((ROWS - 1 - r) * COLUMNS + col) * 4;
                out.data[o] = level;
                out.data[o + 1] = level;
                out.data[o + 2] = level;
                out.data[o + 3] = 255;
            }
        }
        ctx.putImageData(out, 0, 0);
    }

    // ---------- Results ----------

    function updateResults() {
        fitsDue = false;
        stars.forEach((star) => {
            star.fit = star.points.length >= 12 ? fitOrbit(star.points) : null;
        });
        const covered = filledCount >= COLUMNS;
        result.replaceChildren(...orbitResults({ resolved, stars, shapes: SHAPES, covered, span, shortest }));
    }

    function renderLegend() {
        legend.hidden = stars.length < 2;
        legend.replaceChildren(...stars.map((star, s) => el('span', {}, markerIcon(SHAPES[s % SHAPES.length], { hollow: true }), `Star ${star.code}`)));
    }

    // ---------- Time ----------

    function apply(t) {
        const wrapped = ((t % span) + span) % span;
        playhead = wrapped;
        slider.set(wrapped / span, daysText(wrapped));
        wanted = Math.max(wanted, Math.min(COLUMNS - 1, Math.floor((wrapped / span) * COLUMNS)));
        api.setBodyOpts({ t });
        bus.emit('timeline', { code: api.resolved.entity.code, t_days: t });
        requestFill();
        figure.redraw();
    }

    let playback = null;
    const slider = timeSlider('Time', (fraction) => {
        if (playback) playback.pause();
        const t = fraction * span;
        if (playback) playback.setTime(t);
    });

    function buildPlayback() {
        if (playback) playback.dispose();
        const speeds = niceSpeeds([shortest / 12, shortest / 6, shortest / 3, shortest / 1.5]);
        playback = createPlayback(controls, {
            label: 'Time series playback',
            speeds,
            speed: speeds[Math.min(1, speeds.length - 1)],
            unit: 'days',
            onTick: apply
        });
        after.replaceChildren(slider.wrap);
    }

    // ---------- Starting over ----------

    function chooseFraming() {
        const { body } = resolved;
        const rv = body.radial_velocity_kms ?? 0;
        let lowest = Infinity;
        let highest = -Infinity;
        const codes = stars.map((s) => s.code);
        for (let i = 0; i < 96; i++) {
            const t = (i / 96) * Math.max(span, shortest);
            componentStates(body, t).forEach((state) => {
                if (!codes.includes(state.code)) return;
                lowest = Math.min(lowest, state.vlos_kms + rv);
                highest = Math.max(highest, state.vlos_kms + rv);
            });
        }
        if (!Number.isFinite(lowest)) {
            lowest = rv;
            highest = rv;
        }
        const overview = spectrumOf(entity, partOptions());
        const fromRest = line.rest_nm * (1 + (0.5 * (lowest + highest)) / C_KMS);
        const seen = lineCentre(overview, fromRest, { searchNm: line.rest_nm * ((highest - lowest) / C_KMS + 0.0015), type: 'abs' });
        const lineWidth = seen ? (seen.fwhm_nm / seen.centre_nm) * C_KMS : 80;
        // Room for the line's own width, without letting a broad line squeeze the swing into a corner of the picture
        const swing = highest - lowest;
        const edge = Math.max(25, Math.min(0.6 * lineWidth, 0.5 * swing + 20));
        vLo = lowest - edge;
        vHi = highest + edge;
        reachKms = Math.max(30, 0.5 * swing + 0.4 * lineWidth + 20);
        halfKms = Math.max(Math.abs(vLo), Math.abs(vHi)) + 3 * lineWidth + 40;
    }

    function partOptions() {
        const { parts } = api.getBodyOpts();
        return parts && !resolved.body.black_hole ? { parts } : {};
    }

    function rebuild() {
        if (!line) return;
        if (filling) cancelAnimationFrame(filling);
        filling = 0;
        image = new Float32Array(COLUMNS * ROWS);
        filled = new Uint8Array(COLUMNS);
        filledCount = 0;
        wanted = 0;
        fitBucket = 0;
        fitsDue = false;
        stars.forEach((star) => {
            star.points = [];
            star.fit = null;
            star.last = null;
        });
        imageCanvas = null;
        chooseFraming();
        const windowHalf = line.rest_nm * ((Math.max(Math.abs(vLo), Math.abs(vHi)) + 15) / C_KMS);
        api.setResolution('zoom', { lo_nm: line.rest_nm - windowHalf, hi_nm: line.rest_nm + windowHalf });
        if (playback) {
            playback.pause();
            playback.setTime(0);
        }
        result.replaceChildren(para('Press Play. The period appears once more than one full swing has gone by.'));
        requestFill();
    }

    function setUpFor(nextResolved) {
        resolved = nextResolved;
        entity = nextResolved.entity;
        const { parts } = api.getBodyOpts();
        stars = followedStars(nextResolved, parts);
        stars.forEach((star) => {
            star.points = [];
            star.fit = null;
        });
        // Lines come from each star's own light, so the first choice is one that all of them show
        const overviews = stars.map((star) => spectrumOf(entity, star.part ? { parts: [star.part] } : {}));
        const suggestions = suggestTrackingLines(overviews, 6);
        lines = suggestions;
        line = lines[0] || null;
        setOptions(lineField.select, lines.map((l, i) => ({ value: i, label: lineTitle(l) })), 0);
        lineField.wrap.hidden = lines.length < 2;

        const periods = periodsFor(nextResolved, stars);
        shortest = periods[0] ?? 1;
        const spans = periods.map((p, i) => ({ value: p * CYCLES_SHOWN, label: daysText(p * CYCLES_SHOWN) + (i === 0 && periods.length > 1 ? ', the shortest' : '') }));
        span = spans.length ? spans[0].value : shortest * CYCLES_SHOWN;
        setOptions(spanField.select, spans, span);
        spanField.wrap.hidden = spans.length < 2;
        renderLegend();
        buildPlayback();
        if (!line) {
            result.replaceChildren(para('No line here is clear enough to follow.'));
            return;
        }
        rebuild();
    }

    // Picking other stars with Stars shown starts the picture again, for just those stars
    const offOpts = api.onBodyOpts((changed) => {
        if (changed && 'parts' in changed) setUpFor(resolved);
    });

    return {
        setEntity(next) {
            const old = api.resolved && entity && entity !== next.entity ? entity.code : null;
            if (old) bus.emit('timeline', { code: old, t_days: 0 });
            setUpFor(next);
        },
        onPanelHide() {
            if (playback) playback.pause();
        },
        dispose() {
            if (filling) cancelAnimationFrame(filling);
            filling = 0;
            offOpts();
            removeOverlay();
            if (playback) playback.dispose();
            api.setBodyOpts({ t: null });
            api.setResolution('overview');
            plot.setRange(started.lo, started.hi);
            if (entity) bus.emit('timeline', { code: entity.code, t_days: 0 });
        }
    };
}

registerTool({
    id: 'time-series',
    label: 'Time series',
    draws: true,
    appliesTo: applies,
    mount
});
