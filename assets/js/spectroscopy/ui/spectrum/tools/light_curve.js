// Light curve: a supernova's brightness against time, with playback that moves its spectrum and the sky to that time.

import { registerTool } from './index.js';
import { bus } from '../../../core/state.js';
import { lightCurve } from '../../../spectra/synth.js';
import { createPlayback } from '../../playback.js';
import { el } from '../../plot2d.js';
import { createTimeFigure, everyFew, figureTable, para, timeSlider } from './common.js';

const SPEEDS = [5, 10, 20, 40];  // Days per second
const SPEED = 10;

function dayText(phase) {
    const days = Math.round(phase);
    return days === 0 ? 'at peak' : days < 0 ? `${-days} days before peak` : `${days} days after peak`;
}

function mount(container, api) {
    const note = para('The spectrum and the sky follow this time. Drag Time back to the start to see the flash, and compare the spectrum near peak with later on.');
    const caveat = para('This curve is the explosion\'s own visible light, and it is held flat 1.64 magnitudes below peak, where the simulation hands over to the glow of the expanding shell. A real supernova goes on fading for years. The shell\'s slow brightening after about 150 days shows in the sky but isn\'t drawn here.');
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
        if (!playback.playing) spoken.textContent = readout.textContent;
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
            figure.setLabel(`Light curve: magnitude against days after peak, reaching magnitude ${curve.peak_mag.toFixed(1)} at its peak. The values are in the table under Show as table.`);
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

registerTool({
    id: 'light-curve',
    label: 'Light curve',
    appliesTo: (resolved) => resolved.entity.kind === 'supernova',
    mount
});
