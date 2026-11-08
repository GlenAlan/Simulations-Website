// Light curve: a supernova's brightness against time, with playback that moves its spectrum and the sky to that time. Also the
// dips of the few star systems that line up closely enough for their stars to pass in front of each other: those run on the
// system's own clock, and a system that never eclipses doesn't have this tool at all.

import { registerTool } from './index.js';
import { bus } from '../../../core/state.js';
import { sig } from '../../../core/format.js';
import { eclipsingOrbits } from '../../../data/orbits.js';
import { lightCurve } from '../../../spectra/synth.js';
import { supernovaShellShows } from '../../../spectra/supernova.js';
import { createPlayback } from '../../playback.js';
import { el } from '../../plot2d.js';
import { createTimeFigure, everyFew, figureTable, niceSpeeds, para, timeSlider } from './common.js';
import { clockFor } from './orbit_clock.js';
import { eclipseCurve } from './star_light.js';
import { sketchBox, drawSupernovaSketch, sketchWords } from './supernova_sketch.js';

const SPEEDS = [5, 10, 20, 40];  // Days per second
const SPEED = 10;

function dayText(phase) {
    const days = Math.round(phase);
    const count = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;
    return days === 0 ? 'at peak' : days < 0 ? `${count(-days)} before peak` : `${count(days)} after peak`;
}

function mountSupernova(container, api) {
    const note = para('The spectrum and the sky follow this time. Drag Time back to the start and play it to see the flash, and compare the spectrum near peak with later on.');
    const caveat = para('');
    // Only a supernova whose shell can be seen has one to hand over to (supernovaShellShows)
    const CAVEAT_SHELL = 'This curve is the explosion\'s own visible light, and it is held flat 1.64 magnitudes below peak, where the simulation hands over to the glow of the expanding shell. A real supernova goes on fading for years. The shell\'s slow brightening after about 150 days shows in the sky but isn\'t drawn here.';
    const CAVEAT_POINT = 'This curve is the explosion\'s own visible light, held flat 1.64 magnitudes below peak. A real supernova goes on fading for years.';
    const readout = el('p', { class: 'spectro-tool-answer' });
    // Says where it has got to when it stops, not several times a second while it plays
    const spoken = el('p', { class: 'spectro-sr-only', role: 'status' });
    const controls = el('div', { class: 'spectro-tool-controls' });
    const below = el('div', { class: 'spectro-tool-controls' });
    container.append(readout, spoken, controls);

    let curve = null;
    let entity = null;

    const figure = createTimeFigure(container, {
        label: 'Light curve',
        xTitle: 'Days after peak',
        yTitle: 'Magnitude',
        yInverted: true,
        range: () => {
            if (!curve) return { xLo: 0, xHi: 1, yLo: 0, yHi: 1 };
            const finite = Array.from(curve.mag).filter(Number.isFinite);
            const top = Math.min(...finite);
            const bottom = Math.max(...finite);
            return {
                xLo: curve.t_days[0] - curve.t_peak_days,
                xHi: curve.t_days[curve.t_days.length - 1] - curve.t_peak_days,
                yLo: top - 0.2,
                yHi: bottom + 0.2
            };
        },
        paint(ctx, frame, rect, sx, sy) {
            if (!curve) return;
            const { theme } = frame;
            ctx.strokeStyle = theme.strong;
            ctx.lineWidth = 2;
            ctx.beginPath();
            let pen = false;
            for (let i = 0; i < curve.t_days.length; i++) {
                const m = curve.mag[i];
                if (!Number.isFinite(m)) {
                    pen = false;
                    continue;
                }
                const x = sx(curve.t_days[i] - curve.t_peak_days);
                const y = sy(m);
                if (pen) ctx.lineTo(x, y);
                else ctx.moveTo(x, y);
                pen = true;
            }
            ctx.stroke();
            // Now: a line and a dot, with its place along the curve said in the readout as well
            const phase = playback.t - curve.t_peak_days;
            const at = sx(phase);
            ctx.strokeStyle = theme.accent;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(at, rect.y);
            ctx.lineTo(at, rect.y + rect.h);
            ctx.stroke();
            ctx.setLineDash([]);
            const mag = magAt(playback.t);
            if (Number.isFinite(mag)) {
                ctx.beginPath();
                ctx.arc(at, sy(mag), 4.5, 0, Math.PI * 2);
                ctx.fillStyle = theme.accent;
                ctx.strokeStyle = theme.paper;
                ctx.lineWidth = 1.5;
                ctx.fill();
                ctx.stroke();
            }
            // In the corner, the explosion up close at this moment
            const box = sketchBox(rect);
            if (box) drawSupernovaSketch(ctx, box, entity, playback.t, theme);
        }
    });
    container.append(below, note, caveat);
    const updateTable = figureTable(container, {
        label: 'Light curve values',
        columns: ['Days after peak', 'Magnitude'],
        rows: () => (curve ? everyFew(Array.from(curve.t_days).map((t, i) => [t, curve.mag[i]])).map(([t, mag]) => [
            String(Math.round(t - curve.t_peak_days)),
            Number.isFinite(mag) ? mag.toFixed(1) : 'Not yet visible'
        ]) : [])
    });

    function magAt(t) {
        const { t_days: ts, mag } = curve;
        if (t <= ts[0]) return mag[0];
        for (let i = 1; i < ts.length; i++) {
            if (t <= ts[i]) {
                const f = (t - ts[i - 1]) / (ts[i] - ts[i - 1]);
                const a = mag[i - 1];
                const b = mag[i];
                return Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * f : b;
            }
        }
        return mag[mag.length - 1];
    }

    function apply(t) {
        if (!curve) return;
        const from = curve.t_days[0];
        const to = curve.t_days[curve.t_days.length - 1];
        const clamped = Math.max(from, Math.min(to, t));
        if (clamped !== t) {
            playback.t = clamped;
            if (t >= to) playback.pause();
        }
        const mag = magAt(clamped);
        const phase = clamped - curve.t_peak_days;
        readout.textContent = Number.isFinite(mag) ? `${dayText(phase)}: magnitude ${mag.toFixed(1)}` : `${dayText(phase)}: not yet visible`;
        if (!playback.playing) spoken.textContent = `${readout.textContent}. ${sketchWords(entity, clamped)}`;
        slider.set((clamped - from) / (to - from), dayText(phase));
        api.setBodyOpts({ t: clamped });
        bus.emit('timeline', { code: entity.code, t_days: clamped });
        figure.redraw();
    }

    const playback = createPlayback(controls, { label: 'Light curve playback', speeds: SPEEDS, speed: SPEED, unit: 'days', onTick: apply });
    const slider = timeSlider('Time', (fraction) => {
        const from = curve.t_days[0];
        const to = curve.t_days[curve.t_days.length - 1];
        playback.pause();
        playback.setTime(from + fraction * (to - from));
    });
    below.append(slider.wrap);

    function reset(code) {
        if (code) bus.emit('timeline', { code, t_days: 0 });
    }

    return {
        setEntity(resolved) {
            reset(entity && entity !== resolved.entity ? entity.code : null);
            entity = resolved.entity;
            curve = lightCurve(entity);
            // One in another galaxy fades on as a real one does (data/band_table.js), so its curve needs no word of explanation
            caveat.textContent = entity.supernova.host_code ? '' : supernovaShellShows(entity.supernova) ? CAVEAT_SHELL : CAVEAT_POINT;
            caveat.hidden = !caveat.textContent;
            figure.setLabel(`Light curve: magnitude against days after peak, reaching magnitude ${curve.peak_mag.toFixed(1)} at its peak, with a sketch of the explosion up close at the time shown in the top right corner. The values are in the table under Show as table.`);
            updateTable();
            playback.pause();
            playback.setTime(0);
        },
        onPanelHide() {
            playback.pause();
        },
        dispose() {
            playback.dispose();
            api.setBodyOpts({ t: null });
            reset(entity && entity.code);
        }
    };
}

// ---------- Eclipses ----------

const ORBITS_SHOWN = 2;
const LAST_SLIDER_FRACTION = 0.9995;
const LEAST_SPAN = 0.1;          // The least share of the light the brightness axis spans

function shortDuration(days) {
    return days < 2 ? `${sig(days * 24, 2)} hours` : `${sig(days, 2)} days`;
}

function percent(share) {
    return share < 0.1 ? `${sig(share * 100, 2)}%` : `${Math.round(share * 100)}%`;
}

function mountEclipse(container, api) {
    const { plot } = api;
    const summary = el('div', { class: 'spectro-tool-result' });
    const note = para('Each dip is one star passing in front of the other, and how deep it goes depends on how much of the hidden star\'s light is lost. They come when both stars are moving across your view, which is just when their spectral lines cross. The brightness is for the range on the plot, so try other ranges: the hotter star\'s eclipse goes deeper in the blue.');
    const controls = el('div', { class: 'spectro-tool-controls' });
    const below = el('div', { class: 'spectro-tool-controls' });
    container.append(summary, controls);

    let body = null;
    let clock = null;
    let curve = null;
    let playback = null;
    let offClock = null;
    let startT = 0;
    let queued = 0;

    const levelAt = (t) => {
        const P = curve.period_days;
        const phase = (((t / P) % 1) + 1) % 1;
        return curve.level[Math.min(curve.level.length - 1, Math.floor(phase * curve.level.length))];
    };

    const figure = createTimeFigure(container, {
        label: 'Light curve of an eclipsing pair',
        xTitle: 'Time (days)',
        yTitle: 'Brightness',
        range: () => {
            if (!curve) return { xLo: 0, xHi: 1, yLo: 0, yHi: 1 };
            // Never less than a tenth of the light from top to bottom, so that a dip of a few hundredths of a per cent looks as
            // slight as it is, and not as deep as one of 30%
            const dip = Math.max(1 - curve.lowest, LEAST_SPAN);
            return { xLo: 0, xHi: ORBITS_SHOWN * curve.period_days, yLo: 1 - 1.15 * dip, yHi: 1 + 0.15 * dip };
        },
        paint(ctx, frame, rect, sx, sy) {
            if (!curve) return;
            const { theme } = frame;
            const span = ORBITS_SHOWN * curve.period_days;
            ctx.strokeStyle = theme.strong;
            ctx.lineWidth = 2;
            ctx.beginPath();
            const stepsAcross = Math.max(120, Math.round(rect.w));
            for (let i = 0; i <= stepsAcross; i++) {
                const into = (i / stepsAcross) * span;
                const x = sx(into);
                const y = sy(levelAt(startT + into));
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            const now = clock.steppedT();
            const at = sx(now - startT);
            ctx.strokeStyle = theme.accent;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(at, rect.y);
            ctx.lineTo(at, rect.y + rect.h);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(at, sy(levelAt(now)), 4.5, 0, Math.PI * 2);
            ctx.fillStyle = theme.accent;
            ctx.strokeStyle = theme.paper;
            ctx.lineWidth = 1.5;
            ctx.fill();
            ctx.stroke();
        }
    });
    container.append(below, note);

    const slider = timeSlider('Time', (fraction) => {
        clock.pause();
        clock.setTime(startT + Math.min(LAST_SLIDER_FRACTION, fraction) * ORBITS_SHOWN * curve.period_days);
    });
    below.append(slider.wrap);

    function apply(t) {
        if (!curve) return;
        const span = ORBITS_SHOWN * curve.period_days;
        if (t < startT || t >= startT + span) startT += Math.floor((t - startT) / span) * span;
        const into = t - startT;
        slider.set(into / span, `${sig(into, 3)} days`);
        figure.redraw();
    }

    function describe() {
        const { lo, hi } = plot.getRange();
        curve = eclipseCurve(body, lo, hi);
        summary.replaceChildren(...curve.dips.map((dip, i) => el('p', {
            class: 'spectro-tool-line',
            text: `${curve.dips.length > 1 ? (i === 0 ? 'Deeper dip' : 'Shallower dip') : 'Dip'}: ${percent(dip.depth)} of the light, about ${shortDuration(dip.duration_days)} long, with ${dip.hidden} behind`
        })));
        apply(clock.steppedT());
    }

    const offRange = plot.onRangeChange(() => {
        if (queued) return;
        queued = requestAnimationFrame(() => {
            queued = 0;
            if (body) describe();
        });
    });

    return {
        setEntity(resolved) {
            body = resolved.body;
            const next = clockFor(body);
            if (next !== clock) {
                if (offClock) offClock();
                if (playback) playback.dispose();
                clock = next;
                offClock = clock.onStep(apply);
                const P = eclipsingOrbits(body)[0].period_days;
                startT = Math.floor(clock.steppedT() / (ORBITS_SHOWN * P)) * (ORBITS_SHOWN * P);
                playback = createPlayback(controls, {
                    clock,
                    label: 'Light curve playback',
                    speeds: niceSpeeds([P / 12, P / 6, P / 3, P / 1.5]),
                    unit: 'days'
                });
            }
            describe();
        },
        dispose() {
            cancelAnimationFrame(queued);
            offRange();
            if (offClock) offClock();
            if (playback) playback.dispose();
            body = null;
        }
    };
}

// The same tool for two very different objects, so a change of object may mean a change of insides
function mount(container, api) {
    let inner = null;
    let isSupernova = null;
    return {
        setEntity(resolved) {
            const supernova = resolved.entity.kind === 'supernova';
            if (supernova !== isSupernova) {
                if (inner) inner.dispose();
                container.replaceChildren();
                inner = supernova ? mountSupernova(container, api) : mountEclipse(container, api);
                isSupernova = supernova;
            }
            inner.setEntity(resolved);
        },
        onPanelHide() {
            if (inner && inner.onPanelHide) inner.onPanelHide();
        },
        dispose() {
            if (inner) inner.dispose();
        }
    };
}

function applies(resolved) {
    if (resolved.entity.kind === 'supernova') return true;
    const { body } = resolved;
    return resolved.path !== 'planet' && !!body && !!body.stars && eclipsingOrbits(body).length > 0;
}

registerTool({
    id: 'light-curve',
    label: 'Light curve',
    appliesTo: applies,
    mount
});
