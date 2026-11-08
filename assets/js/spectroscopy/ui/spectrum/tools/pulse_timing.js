// Pulse timing: a pulsar's radio pulses as a trace, slowed down far enough to watch, and its period from timing a run of
// pulses. Nothing here ever flashes: pulses pass as a moving trace at no more than about 2 a second, and with reduce
// motion the trace stands still.

import { registerTool } from './index.js';
import { app, bus } from '../../../core/state.js';
import { Rng } from '../../../core/rng.js';
import { sig } from '../../../core/format.js';
import { createPlayback } from '../../playback.js';
import { el, fontOf } from '../../plot2d.js';
import { createTimeFigure, figureTable, para } from './common.js';

const SHOWN_PULSES = 5;          // How many periods fit across the trace
const PULSE_WIDTH = 0.045;       // Width of a pulse as a share of the period
const TIMED_PULSES = 40;         // How many arrival times the reading is fitted to
const TIMING_JITTER = 0.012;     // Scatter of one arrival time as a share of the period

// Times a run of pulses, each arriving a little early or late, and fits a straight line to arrival time against pulse
// number: the slope is the period and the scatter gives its uncertainty.
function timePulses(period, code) {
    const rng = new Rng(`pulse-${code}`);
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    const arrivals = [];
    for (let k = 0; k < TIMED_PULSES; k++) {
        const at = k * period + rng.gauss(0, TIMING_JITTER * period);
        arrivals.push(at);
        sx += k;
        sy += at;
        sxx += k * k;
        sxy += k * at;
    }
    const n = TIMED_PULSES;
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const icept = (sy - slope * sx) / n;
    let rss = 0;
    arrivals.forEach((at, k) => { rss += (at - icept - slope * k) ** 2; });
    const err = Math.sqrt(rss / (n - 2) / (sxx - (sx * sx) / n));
    return { period: slope, err: Math.max(err * 2, 1e-4 * period) };
}

// A period in the unit that reads best, with what it needs for its speed list
function unitFor(periodS) {
    return periodS < 1 ? { name: 'ms', perS: 1000 } : { name: 's', perS: 1 };
}

function periodText(value, err, unit) {
    const scaled = value * unit.perS;
    const scaledErr = err * unit.perS;
    const digits = Math.max(0, Math.ceil(-Math.log10(scaledErr)));
    return `${scaled.toFixed(digits)} ± ${scaledErr.toFixed(digits)} ${unit.name}`;
}

function traceAt(phase, noiseSeed) {
    const u = phase - Math.floor(phase);
    const d = Math.min(u, 1 - u);
    const pulse = Math.exp(-0.5 * (d / PULSE_WIDTH) ** 2);
    // A little steady noise, the same each time past a given point
    const s = Math.sin((Math.floor(phase * 90) + noiseSeed) * 12.9898) * 43758.5453;
    return pulse + 0.05 * (s - Math.floor(s));
}

function mount(container, api) {
    const answer = el('p', { class: 'spectro-tool-answer', role: 'status' });
    const rate = el('p', { class: 'spectro-tool-line' });
    const controls = el('div', { class: 'spectro-tool-controls' });
    container.append(answer, rate, controls);

    let neutron = null;
    let entity = null;
    let period = 1;
    let unit = unitFor(1);
    let playback = null;
    let tNow = 0;
    let seed = 0;

    const figure = createTimeFigure(container, {
        label: 'Pulse trace',
        xTitle: () => `Time (${unit.name})`,
        yTitle: 'Radio signal',
        height: 170,
        range: () => {
            const span = SHOWN_PULSES * period * unit.perS;
            return { xLo: 0, xHi: span, yLo: 0, yHi: 1.45 };
        },
        paint(ctx, frame, rect, sx, sy) {
            const { theme } = frame;
            const span = SHOWN_PULSES * period;
            ctx.strokeStyle = theme.strong;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            const n = Math.round(rect.w);
            for (let i = 0; i <= n; i++) {
                const x = rect.x + i;
                const time = (i / n) * span + tNow;
                const y = sy(traceAt(time / period, seed));
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
            // The gap between two pulses, marked with its length
            const first = Math.ceil(tNow / period) * period - tNow;
            const a = sx(first * unit.perS);
            const b = sx((first + period) * unit.perS);
            const y = sy(1.15);
            ctx.strokeStyle = theme.text;
            ctx.fillStyle = theme.text;
            ctx.lineWidth = 1.3;
            ctx.beginPath();
            ctx.moveTo(a, y);
            ctx.lineTo(b, y);
            [a, b].forEach((x) => {
                ctx.moveTo(x, y - 4);
                ctx.lineTo(x, y + 4);
            });
            ctx.stroke();
            ctx.font = fontOf(theme, 12, 600);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText('one period', 0.5 * (a + b), y - 3);
        }
    });
    const note = para('Each pulse is a beam from the spinning neutron star sweeping past, like a lighthouse. It turns once each period.');
    container.append(note);
    const updateTable = figureTable(container, {
        label: 'Pulse arrival times',
        columns: ['Pulse', 'Arrives at (s)'],
        rows: () => Array.from({ length: SHOWN_PULSES + 1 }, (_, i) => [String(i + 1), sig(i * period, 4)])
    });

    function draw() {
        figure.redraw();
    }

    function setUp(resolved) {
        entity = resolved.entity;
        neutron = entity.neutron_star;
        period = neutron.pulse_period_s;
        unit = unitFor(period);
        seed = (entity.code.charCodeAt(0) * 7 + entity.code.charCodeAt(1)) % 97;
        const timed = timePulses(period, entity.code);
        const pulses = 1 / timed.period;
        answer.textContent = `Period = ${periodText(timed.period, timed.err, unit)}`;
        figure.setLabel(`Pulse trace: radio signal against time, with one sharp pulse each period. ${answer.textContent}. The times are in the table under Show as table.`);
        updateTable();
        const pulsesText = pulses >= 10 ? `${Math.round(pulses).toLocaleString('en-AU')} pulses each second` : `${sig(pulses, 3)} pulses each second`;
        tNow = 0;
        if (playback) {
            playback.dispose();
            playback = null;
        }
        const reduced = !!(app.settings && app.settings.reduceMotion);
        if (reduced) {
            rate.textContent = `${pulsesText}. The trace stands still because Reduce motion is on.`;
        } else {
            // Speeds that keep the trace at or below 2 pulses a second, however fast the star really turns
            const scaled = period * unit.perS;
            const speeds = [scaled / 2, scaled, 2 * scaled].map((s) => Number(s.toPrecision(2)));
            rate.textContent = pulses > 2
                ? `${pulsesText}. The trace below plays them at up to 2 a second, so that each pulse can be followed.`
                : `${pulsesText}. The trace below plays them at a rate that's easy to follow.`;
            playback = createPlayback(controls, {
                label: 'Pulse playback',
                speeds,
                speed: speeds[1],
                unit: unit.name,
                onTick(t) {
                    tNow = t / unit.perS;
                    bus.emit('timeline', { code: entity.code, t_days: tNow / 86400 });
                    draw();
                }
            });
        }
        draw();
    }

    return {
        setEntity: setUp,
        onPanelHide() {
            if (playback) playback.pause();
        },
        dispose() {
            if (playback) playback.dispose();
            if (entity) bus.emit('timeline', { code: entity.code, t_days: 0 });
        }
    };
}

registerTool({
    id: 'pulse-timing',
    label: 'Pulse timing',
    appliesTo: (resolved) => resolved.entity.kind === 'neutron_star' && !!resolved.entity.neutron_star.pulsar,
    mount
});
