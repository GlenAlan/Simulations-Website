// Time series: a line's position against time for binaries, multiples and black-hole companions. The picture builds up as
// the system's clock runs: each column is the spectrum around one line at one moment, and the marks are that line's measured
// centre for each star. From those come the period, the speed swing K, and with them the masses (see orbit_sums.js).
//
// The clock is the system's own (orbit_clock.js), shared with the orbit and the spectrum. This tool reads its stepped reading
// and can play it, but opening, closing or re-framing the tool never moves it. Its picture simply starts from whatever time it is.

import { linkToolNames, registerTool } from './index.js';
import { C_KMS, R_ZOOM } from '../../../core/phys.js';
import { sig } from '../../../core/format.js';
import { spectrumOf } from '../../../spectra/synth.js';
import { dopplerFrom, fitOrbit, lineCentre, suggestTrackingLines } from '../../../spectra/measure.js';
import { componentStates } from '../../../data/orbits.js';
import { createPlayback } from '../../playback.js';
import { drawMarker, el } from '../../plot2d.js';
import { createTimeFigure, everyFew, figureTable, labelledSelect, niceSpeeds, overlayTheme, para, plotLabel, plotMark, setOptions, statusBox, timeSlider } from './common.js';
import { orbitResults } from './orbit_sums.js';
import { clockFor } from './orbit_clock.js';
import { createOrbitDial, STAR_SHAPES } from './orbit_dial.js';

const COLUMNS = 240;             // Moments across the picture
const ROWS = 72;                 // Speeds up its side
const TRACK_EVERY = 4;           // Measure the line's centre at every this many columns
const CYCLES_SHOWN = 3;
const FILL_PER_FRAME = 2;        // Columns worked out per frame, so that playback stays smooth
const LONGEST_SHOWN_DAYS = 20000; // A slower orbit than this can't be played: its stars would barely move
const MIN_ERR_KMS = 0.5;
const MIN_LINE_DEPTH = 0.03;     // As in suggestTrackingLines: shallower than this, a star doesn't really show a line
const POOR_K_SHARE = 0.05;       // A speed swing known no better than this may well read better from another of the star's lines
const MIN_SAMPLES_PER_SWING = 6; // Sampled less often than this, a swing can't be read, and what fits it instead is false
// A period is only offered once a swing and a half of the star's quickest orbit is in. Before that, part of a swing can be
// fitted as well by a shorter, false one with a tight error bar, and a student who paused would copy it down.
const MIN_CYCLES_FOR_PERIOD = 1.5;
const SPEED_SHARES = [1 / 36, 1 / 18, 1 / 9, 1 / 4.5]; // The time to show covered per second: a full picture in 36 s at the slowest
const LAST_SLIDER_FRACTION = 0.9995; // The very end of the slider is the end of the picture, not the start of the next

function applies(resolved) {
    const { body } = resolved;
    return !!(body && (body.black_hole || (body.stars && body.orbits && body.orbits.length))) && resolved.path !== 'planet';
}

function daysText(d) {
    return d >= 100 ? `${Math.round(d).toLocaleString('en-AU')} days` : `${Number(d.toPrecision(3))} days`;
}

// Every orbit a star takes part in, by its period
function periodsOfStar(body, code) {
    if (body.black_hole) return [body.black_hole.period_days];
    if (body.figure_eight) return [body.figure_eight.period_days];
    const index = body.stars.findIndex((s) => s.code === code);
    return body.orbits.filter((o) => [...o.a, ...o.b].includes(index)).map((o) => o.period_days);
}

// Each star followed: its code, and a mark that isn't told apart by colour
function followedStars(resolved, parts) {
    const { body, entity, path } = resolved;
    if (body.black_hole) return [{ code: body.black_hole.companion.code, mass: body.black_hole.companion.star.mass_Msun, part: null, shape: STAR_SHAPES[0] }];
    const shapeOf = (code) => STAR_SHAPES[body.stars.findIndex((s) => s.code === code) % STAR_SHAPES.length];
    if (path === 'component') return [{ code: entity.code, part: null, shape: shapeOf(entity.code) }];
    const list = body.stars.filter((s) => !parts || parts.includes(s.code));
    return list.map((s) => ({ code: s.code, part: s.code, shape: shapeOf(s.code) }));
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

function lineTitle(line) {
    return `${String(line.label || line.species).replace(/\s*\d+(\.\d+)?$/, '')}, ${line.rest_nm.toFixed(1)} nm`;
}

function sameLine(a, b) {
    return Math.abs(a.rest_nm - b.rest_nm) < 0.01;
}

function mount(container, api) {
    const { plot } = api;
    const intro = para('Press Play and watch the line move. Each star\'s lines swing to and fro as it orbits. The time for one swing is the period.');
    const lineField = labelledSelect('Line to follow', (value) => {
        line = lines[Number(value)];
        linePicked = true;
        rebuild();
    });
    const spanField = labelledSelect('Time to show', (value) => {
        span = Number(value);
        buildPlayback(true);
        rebuild();
    });
    const controls = el('div', { class: 'spectro-tool-controls' });
    const dialHost = el('div', { class: 'spectro-ts-dial' });
    const result = statusBox();
    const started = plot.getRange();

    // Play and the orbit's dial first and the picture straight under them, so all are in view with the plot above them
    container.append(el('div', { class: 'spectro-ts-top' }, controls, dialHost));

    // ---------- State ----------

    let resolved = null;
    let entity = null;
    let clock = null;
    let speedAtOpen = 0;
    let offClock = null;
    let dial = null;
    let stars = [];
    let lines = [];
    let line = null;
    let linePicked = false;
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
    let startT = 0;           // The clock's time at the picture's left edge
    let playhead = 0;
    let fitsDue = false;
    let fitBucket = 0;
    let panelShown = true;

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
            stars.forEach((star) => {
                star.points.forEach((p) => {
                    drawMarker(ctx, star.shape, sx(p.t - startT), sy(p.v), 2.6, { fill: theme.paper, stroke: theme.accent, width: 1.3 });
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
    container.append(after, result, lineField.wrap, spanField.wrap, intro);
    const updateTable = figureTable(container, {
        label: 'Line shifts over time',
        columns: ['Star', 'Time (days)', 'Line shift (km/s)'],
        rows: () => stars.flatMap((star) => everyFew(star.points, 16).map((p) => [star.code, sig(p.t, 3), sig(p.v, 3)]))
    });

    const removeOverlay = plot.addOverlay((ctx) => {
        if (!line) return;
        const theme = overlayTheme(plot);
        const mark = plotMark(ctx, plot, theme, line.rest_nm, { dashed: true, width: 1.3 });
        if (mark) plotLabel(ctx, theme, 'rest', mark.x, mark.top + 12);
        drawNowMarks(ctx, theme);
    });

    // Over each star's line, where it is at this moment on the clock, in the same mark as the picture's
    function drawNowMarks(ctx, theme) {
        if (!clock || stars.length < 2) return;
        const pane = plot.panes().body;
        const { lo, hi } = plot.getRange();
        const rv = resolved.body.radial_velocity_kms ?? 0;
        componentStates(resolved.body, clock.steppedT()).forEach((state) => {
            const star = stars.find((s) => s.code === state.code);
            if (!star) return;
            const nm = line.rest_nm * (1 + (rv + state.vlos_kms) / C_KMS);
            if (nm < lo || nm > hi) return;
            drawMarker(ctx, star.shape, plot.xOf(nm), pane.y + 27, 4, { fill: theme.well, stroke: theme.mark, width: 1.4 });
        });
    }

    // ---------- Working out the columns ----------

    function sliceOpts(t, part, restNm = line.rest_nm) {
        const lo = restNm * (1 - halfKms / C_KMS);
        const hi = restNm * (1 + halfKms / C_KMS);
        const opts = { lo_nm: lo, hi_nm: hi, R: R_ZOOM, t };
        const { parts } = api.getBodyOpts();
        if (part) opts.parts = [part];
        else if (parts && !resolved.body.black_hole) opts.parts = parts;
        return opts;
    }

    function paintColumn(col) {
        const t = startT + ((col + 0.5) / COLUMNS) * span;
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

    // One star's line at one moment, as a point for the fit; null if it can't be told from the noise
    function measure(star, followed, t) {
        const rest = followed.rest_nm;
        const spectrum = spectrumOf(entity, sliceOpts(t, star.part, rest));
        const near = star.last ?? rest * (1 + (0.5 * (vLo + vHi)) / C_KMS);
        const search = star.last ? 0.4 * reachKms : reachKms;
        const found = lineCentre(spectrum, near, { searchNm: (rest * search) / C_KMS, type: 'abs' });
        if (!found) return null;
        star.last = found.centre_nm;
        const d = dopplerFrom(found.centre_nm, rest, found.err_nm);
        return { t, v: d.v_kms, err: Math.max(MIN_ERR_KMS, d.err_kms) };
    }

    function trackColumn(t) {
        stars.forEach((star) => {
            if (star.tooFast) return;
            const point = measure(star, star.line, t);
            if (point) star.points.push(point);
        });
        fitsDue = true;
    }

    function fillStep() {
        filling = 0;
        if (!panelShown || !line) return;
        let budget = FILL_PER_FRAME;
        for (let col = 0; col <= wanted && col < COLUMNS && budget > 0; col++) {
            if (filled[col]) continue;
            paintColumn(col);
            budget--;
        }
        if (budget < FILL_PER_FRAME) drawImage();
        // Fitting takes a moment, so while playing it waits for several new points; once paused or finished it catches up
        const bucket = Math.floor(filledCount / (TRACK_EVERY * 4));
        const paused = !clock || !clock.playing;
        if (fitsDue && (bucket !== fitBucket || filledCount >= COLUMNS || (paused && filledCount >= wanted + 1))) {
            fitBucket = bucket;
            updateResults();
        }
        figure.redraw();
        if (budget === 0 && filledCount < wanted + 1) filling = requestAnimationFrame(fillStep);
    }

    function requestFill() {
        if (!filling && panelShown) filling = requestAnimationFrame(fillStep);
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

    // A star whose line wouldn't do, once the whole picture is in: its other lines, over the same moments, keeping the sharpest reading
    function tryOtherLines(star) {
        star.triedOthers = true;
        const sharpness = (fit) => fit.err_K_kms / fit.K_kms;
        for (const other of star.own) {
            if (sameLine(other, star.line)) continue;
            star.last = null;
            const points = [];
            for (let col = 0; col < COLUMNS; col += TRACK_EVERY) {
                const point = measure(star, other, startT + ((col + 0.5) / COLUMNS) * span);
                if (point) points.push(point);
            }
            const fit = points.length >= 12 ? fitOrbit(points) : null;
            if (fit && (!star.fit || sharpness(fit) < sharpness(star.fit))) {
                star.points = points;
                star.fit = fit;
                star.line = other;
            }
        }
    }

    // A line the student picked is the one they want read, as long as it gives a reading at all
    function wantsAnotherLine(star) {
        if (star.tooFast || star.tooSlow || star.triedOthers) return false;
        return !star.fit || (!linePicked && star.fit.err_K_kms > POOR_K_SHARE * star.fit.K_kms);
    }

    // How much of the star's quickest orbit its readings cover
    function cyclesIn(star) {
        const n = star.points.length;
        return n ? (star.points[n - 1].t - star.points[0].t) / Math.min(...star.periods) : 0;
    }

    function updateResults() {
        fitsDue = false;
        const covered = filledCount >= COLUMNS;
        stars.forEach((star) => {
            star.fit = !star.tooFast && star.points.length >= 12 && cyclesIn(star) >= MIN_CYCLES_FOR_PERIOD ? fitOrbit(star.points) : null;
            if (covered && wantsAnotherLine(star)) tryOtherLines(star);
        });
        result.replaceChildren(...orbitResults({
            resolved,
            stars,
            covered,
            span,
            line,
            sampleGap: (span * TRACK_EVERY) / COLUMNS
        }));
        linkToolNames(result, api.hasTool);
        figure.setLabel(`Time series: how far the line ${line ? lineTitle(line) : ''} has shifted, in km/s, against time in days, for ${stars.map((star) => `star ${star.code}`).join(' and ')}. The results are below it, and the values are in the table under Show as table.`);
        updateTable();
    }

    // ---------- Time ----------

    function apply(t) {
        let into = t - startT;
        if (into < 0 || into >= span) {
            // On past the end of the picture: it starts over from its left edge, and what's in it stays
            startT += Math.floor(into / span) * span;
            into = t - startT;
        }
        playhead = into;
        slider.set(into / span, daysText(into));
        wanted = Math.max(wanted, Math.min(COLUMNS - 1, Math.floor((into / span) * COLUMNS)));
        if (dial) dial.set(t);
        // Columns still to work out, or a last fit to catch up on now that it has stopped
        if (filledCount < wanted + 1 || (fitsDue && !clock.playing)) requestFill();
        figure.redraw();
    }

    let playback = null;
    const slider = timeSlider('Time', (fraction) => {
        if (!clock) return;
        clock.pause();
        clock.setTime(startT + Math.min(LAST_SLIDER_FRACTION, fraction) * span);
    });

    // Speeds suit the time on show, so that any of them gets through it while you watch. Past what the system's fastest orbit
    // can show as it happens, this tool works from the clock's stepped reading (see orbit_clock.js). A clock already running
    // at some speed carries on at it, unless a new time span is what was asked for.
    function buildPlayback(newSpan = false) {
        if (playback) playback.dispose();
        const speeds = niceSpeeds(SPEED_SHARES.map((share) => span * share));
        if (newSpan || !clock.playing) clock.setSpeed(speeds[Math.min(1, speeds.length - 1)]);
        playback = createPlayback(controls, {
            clock,
            label: 'Time series playback',
            speeds,
            unit: 'days'
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
            const t = startT + (i / 96) * Math.max(span, shortest);
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
        startT = clock.steppedT();
        const sampleGap = (span * TRACK_EVERY) / COLUMNS;
        stars.forEach((star) => {
            star.points = [];
            star.fit = null;
            star.last = null;
            star.triedOthers = false;
            const quickest = Math.min(...star.periods);
            star.tooFast = quickest < MIN_SAMPLES_PER_SWING * sampleGap;
            star.tooSlow = quickest > span / MIN_CYCLES_FOR_PERIOD;
            // The chosen line if this star shows it at all, or else its own best
            const shows = star.seenLines.some((l) => sameLine(l, line));
            star.line = shows || !star.own.length ? line : star.own[0];
        });
        imageCanvas = null;
        chooseFraming();
        const windowHalf = line.rest_nm * ((Math.max(Math.abs(vLo), Math.abs(vHi)) + 15) / C_KMS);
        api.setResolution('zoom', { lo_nm: line.rest_nm - windowHalf, hi_nm: line.rest_nm + windowHalf });
        if (stars.some((star) => star.tooFast)) updateResults();
        else result.replaceChildren(para(`${clock.playing ? '' : 'Press Play. '}The period appears once a swing and a half has gone by.`));
        apply(clock.steppedT());
    }

    function setUpFor(nextResolved) {
        resolved = nextResolved;
        entity = nextResolved.entity;
        const nextClock = clockFor(nextResolved.body);
        if (nextClock !== clock) {
            if (offClock) offClock();
            if (dial) dial.dispose();
            clock = nextClock;
            speedAtOpen = clock.speed;
            offClock = clock.onStep(apply);
            dial = createOrbitDial(dialHost, nextResolved.body);
        }
        const { parts } = api.getBodyOpts();
        stars = followedStars(nextResolved, parts);
        stars.forEach((star) => {
            star.points = [];
            star.fit = null;
            star.periods = periodsOfStar(nextResolved.body, star.code);
        });
        // Lines come from each star's own light, so the first choice is one that all of them show
        const overviews = stars.map((star) => spectrumOf(entity, star.part ? { parts: [star.part] } : {}));
        const suggestions = suggestTrackingLines(overviews, 6);
        lines = suggestions;
        line = lines[0] || null;
        linePicked = false;
        stars.forEach((star, s) => {
            star.own = suggestTrackingLines([overviews[s]], 4);
            star.seenLines = (overviews[s].lines || []).filter((l) => !l.band && l.depth > MIN_LINE_DEPTH);
        });
        setOptions(lineField.select, lines.map((l, i) => ({ value: i, label: lineTitle(l) })), 0);
        lineField.wrap.hidden = lines.length < 2;

        const periods = periodsFor(nextResolved, stars);
        shortest = periods[0] ?? 1;
        const spans = periods.map((p, i) => ({ value: p * CYCLES_SHOWN, label: daysText(p * CYCLES_SHOWN) + (i === 0 && periods.length > 1 ? ', the shortest' : '') }));
        span = spans.length ? spans[0].value : shortest * CYCLES_SHOWN;
        setOptions(spanField.select, spans, span);
        spanField.wrap.hidden = spans.length < 2;
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
            setUpFor(next);
        },
        onPanelHide() {
            panelShown = false;
        },
        onPanelShow() {
            panelShown = true;
            requestFill();
            figure.redraw();
        },
        dispose() {
            if (filling) cancelAnimationFrame(filling);
            filling = 0;
            offOpts();
            removeOverlay();
            if (playback) playback.dispose();
            if (dial) dial.dispose();
            if (offClock) offClock();
            // A long time span may have left it going far faster than it was
            if (clock && clock.speed > clock.smoothMax && speedAtOpen <= clock.smoothMax) clock.setSpeed(speedAtOpen);
            api.setResolution('overview');
            plot.setRange(started.lo, started.hi);
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
