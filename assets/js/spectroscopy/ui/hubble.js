// The Hubble tab (spec section 12): recession speed against distance for the galaxies the student has measured.
// The gradient of a line through the origin is H₀. Speed comes from the Doppler tool and distance from the
// Photometer. Plotted galaxies last for the session only: nothing is saved.

import { bus, select } from '../core/state.js';
import { getMeasurement, recordMeasurement } from '../core/measurements.js';
import { C_KMS, H0 } from '../core/phys.js';
import { plusMinus, sig, withCommas } from '../core/format.js';
import {
    createChip, createDataTable, createFigure, createLabelPlacer, createMeasureCard, createPlottedList, drawErrorBar,
    drawFrame, drawMarker, el, fitThroughOrigin, fontOf, haloText, linearScale, logScale, markerIcon, nearestPoint,
    niceCeil, niceTicks, powerLabel
} from './plot2d.js';

const Z_LIMIT = 0.1;          // Above this, v = cz is only an approximation (spec section 8.4)
const SUGGESTED_GALAXIES = 8;
const RESIDUALS_HEIGHT = 120; // Extra height the residuals panel adds to the figure (px)

// ---------- Session state ----------

const plotted = new Map();    // code -> number shown beside the point
let nextNumber = 1;
let refreshTab = () => {};    // The mounted tab's refresh

// ---------- Numbers ----------

function velocityOf(m) {
    if (Number.isFinite(m.v_kms)) return m.v_kms;
    return Number.isFinite(m.z) ? m.z * C_KMS : null;
}

function galaxyPoint(code) {
    const m = getMeasurement(code) || {};
    const v = velocityOf(m);
    if (v === null || !(m.distance_pc > 0)) return null;
    return { code, v, vErr: m.v_err_kms || 0, dMpc: m.distance_pc / 1e6, z: Number.isFinite(m.z) ? m.z : v / C_KMS };
}

function galaxyPoints() {
    return [...plotted.keys()].map(galaxyPoint).filter(Boolean);
}

// "+23,400", so a blueshift's sign is never lost
function signedSpeed(v) {
    return `${v < 0 ? '−' : '+'}${withCommas(Math.abs(v))}`;
}

function currentFit() {
    const points = galaxyPoints();
    return fitThroughOrigin(points.map((p) => p.dMpc), points.map((p) => p.v));
}

// Test only, and not reachable from the page's UI: plots every galaxy from its true values, so a test can check
// that the fit recovers H₀ (spec section 19). Load this module from the test and call it directly.
export function __plotAllGalaxiesFromTrueValues(app) {
    app.universe.bodies.filter((body) => body.kind === 'galaxy').forEach((body) => {
        recordMeasurement(body.code, { v_kms: body.radial_velocity_kms, distance_pc: body.distance_pc });
        if (!plotted.has(body.code)) plotted.set(body.code, nextNumber++);
    });
    refreshTab();
    const fit = currentFit();
    return { H0: fit.slope, err: fit.err, n: fit.n, expected: H0, within5: Math.abs(fit.slope - H0) <= 5 };
}

// ---------- The tab ----------

export function initHubbleTab(app) {
    app.drawer.registerTab({
        id: 'hubble',
        label: 'Hubble',
        order: 30,
        appliesTo: (resolved) => resolved.path === 'body' && ['galaxy', 'quasar'].includes(resolved.body.kind),
        mount: (container) => mountHubble(container, app)
    });
}

function mountHubble(container, app) {
    let current = null;
    let useLog = false;
    let showResiduals = false;
    let view = null;

    const root = el('div', { class: 'spectro-fig-tab' });
    container.appendChild(root);

    const readout = el('p', { class: 'spectro-fig-readout', tabindex: '-1' });
    const readoutNote = el('p', { class: 'spectro-fig-card-status', role: 'status' });
    root.append(readout, readoutNote);

    const figure = createFigure(root, {
        label: 'Hubble plot',
        height: (w) => {
            const main = Math.max(240, Math.min(w * 0.82, 380, window.innerHeight * 0.5));
            return showResiduals ? main + RESIDUALS_HEIGHT : main;
        },
        draw
    });

    const legend = el('div', { class: 'spectro-fig-legend', hidden: true },
        el('span', {}, markerIcon('circle'), `Galaxy, |z| up to ${Z_LIMIT}`),
        el('span', {}, markerIcon('circle', { hollow: true }), `Galaxy, |z| above ${Z_LIMIT}`));
    root.appendChild(legend);

    const zNote = el('p', {
        class: 'spectro-fig-hintline',
        hidden: true,
        text: `For the hollow points, |z| is above ${Z_LIMIT}, so v = cz is only an approximation.`
    });
    root.appendChild(zNote);

    const chips = el('div', { class: 'sim-checkbox-group sim-chips spectro-fig-chips' });
    root.appendChild(chips);
    createChip(chips, 'spectroHubbleLog', 'Log scales', (on) => {
        useLog = on;
        figure.redraw();
    });
    createChip(chips, 'spectroHubbleResiduals', 'Residuals', (on) => {
        showResiduals = on;
        figure.redraw();
    });

    const card = createMeasureCard(root, {
        addLabel: 'Add to Hubble plot',
        removeLabel: 'Remove from Hubble plot',
        onHint: () => app.drawer.selectTab('spectrum'),
        fields: [
            {
                key: 'v_kms',
                label: 'Recession speed',
                unit: 'km/s',
                placeholder: '7,000',
                hint: 'Use the Doppler tool in Spectrum',
                allowNegative: true,
                extra: { v_err_kms: undefined, z: undefined },
                show: (m) => `${m.v_err_kms > 0 ? plusMinus(m.v_kms, m.v_err_kms) : withCommas(m.v_kms)} km/s, from the Doppler tool`
            },
            {
                key: 'distance_pc',
                label: 'Distance',
                unit: 'Mpc',
                scale: 1e6,
                placeholder: '100',
                hint: 'Use the Photometer in Spectrum',
                show: (m) => `${sig(m.distance_pc / 1e6, 3)} Mpc, from the Photometer`
            }
        ],
        status(code) {
            return plotted.has(code) ? `On your plot as point ${plotted.get(code)}.` : 'Not on your plot yet.';
        },
        working(code, m) {
            const v = velocityOf(m);
            if (v === null || !(m.distance_pc > 0)) return null;
            const dMpc = m.distance_pc / 1e6;
            const z = Number.isFinite(m.z) ? m.z : v / C_KMS;
            const lines = [
                `d = ${sig(m.distance_pc, 3)} pc = ${sig(dMpc, 3)} Mpc`,
                `v ÷ d = ${signedSpeed(v)} km/s ÷ ${sig(dMpc, 3)} Mpc = ${sig(v / dMpc, 3)} km/s/Mpc`
            ];
            if (Math.abs(z) > Z_LIMIT) lines.push(`z = ${sig(z, 2)}, above ${Z_LIMIT}, so v = cz is only an approximation here.`);
            return lines;
        },
        isPlotted: (code) => plotted.has(code),
        onAdd(code) {
            plotted.set(code, nextNumber++);
            const point = galaxyPoint(code);
            announce(`${code} added at ${sig(point.dMpc, 3)} Mpc and ${withCommas(point.v)} km/s.`);
            refresh();
        },
        onRemove: removeGalaxy
    });

    const quasarNote = el('div', { class: 'spectro-fig-card', hidden: true });
    root.appendChild(quasarNote);

    function removeGalaxy(code) {
        plotted.delete(code);
        if (plotted.size === 0) nextNumber = 1;
        announce(`${code} removed.`);
        refresh();
    }

    const list = createPlottedList(root, 'Your galaxies', () => readout);
    const table = createDataTable(root, {
        label: 'Plotted galaxies',
        columns: ['Point', 'Code', 'Distance (Mpc)', 'Speed (km/s)', 'z', 'Residual (km/s)'],
        rows() {
            const fit = currentFit();
            return galaxyPoints().map((p) => [
                String(plotted.get(p.code)),
                { button: p.code, label: `Select ${p.code}`, onClick: () => select(p.code) },
                sig(p.dMpc, 3),
                p.vErr > 0 ? plusMinus(p.v, p.vErr) : withCommas(p.v),
                sig(p.z, 2),
                fit ? signedSpeed(p.v - fit.slope * p.dMpc) : ''
            ]);
        }
    });

    const live = el('p', { class: 'spectro-fig-sr', role: 'status' });
    root.appendChild(live);
    function announce(text) { live.textContent = text; }

    function renderQuasarNote(resolved) {
        const { body } = resolved;
        const measured = getMeasurement(body.code);
        const measuredZ = measured && Number.isFinite(measured.z) ? measured.z : null;
        const z = measuredZ !== null ? measuredZ : body.quasar.z;
        const v = z * C_KMS;
        const compared = z >= 1
            ? `which is faster than light. That can't be right: nothing moves through space that fast`
            : `which is a large share of the speed of light, far too much for that simple formula to hold`;
        quasarNote.replaceChildren(
            el('p', { class: 'spectro-fig-card-title', text: `Quasar ${body.code}` }),
            el('p', { class: 'spectro-fig-readout', text: `z = ${sig(z, 3)}` }),
            el('p', { class: 'spectro-fig-card-status', text: measuredZ !== null ? 'From your Doppler measurement.' : 'From the catalogue. Measure it yourself with the Doppler tool in Spectrum.' }),
            el('p', { text: `A quasar can't go on this plot. Using v = cz here would give ${sig(v, 3)} km/s, ${compared}. Its light has been stretched by the expanding Universe during a very long journey, so astronomers quote z itself instead of a speed.` }));
    }

    function refresh() {
        const code = current ? current.entity.code : null;
        const isQuasar = current && current.body.kind === 'quasar';
        card.setHidden(!current || isQuasar);
        quasarNote.hidden = !isQuasar;
        if (isQuasar) renderQuasarNote(current);
        else if (current) card.setCode(code, `Galaxy ${code}`);

        const points = galaxyPoints();
        const fit = currentFit();
        const n = points.length;
        if (!fit) {
            readout.textContent = 'H₀ = ?';
            readoutNote.textContent = 'Add galaxies to draw the line. Its gradient is H₀.';
        } else if (fit.err === null) {
            readout.textContent = `H₀ ≈ ${sig(fit.slope, 3)} km/s/Mpc`;
            readoutNote.textContent = `From one galaxy, so no uncertainty yet. Aim for at least ${SUGGESTED_GALAXIES} galaxies.`;
        } else {
            readout.textContent = `H₀ = ${plusMinus(fit.slope, fit.err)} km/s/Mpc`;
            const more = SUGGESTED_GALAXIES - n;
            readoutNote.textContent = more > 0
                ? `Best-fit line through the origin, from ${n} galaxies. Aim for at least ${SUGGESTED_GALAXIES}: ${more} more to go.`
                : `Best-fit line through the origin, from ${n} galaxies.`;
        }

        legend.hidden = n === 0;
        zNote.hidden = !points.some((p) => Math.abs(p.z) > Z_LIMIT);
        list.update(points.map((p) => ({
            key: p.code,
            badge: String(plotted.get(p.code)),
            icon: markerIcon('circle', { hollow: Math.abs(p.z) > Z_LIMIT }),
            code: p.code,
            detail: `${sig(p.dMpc, 3)} Mpc, ${withCommas(p.v)} km/s`,
            current: p.code === code,
            onSelect: () => select(p.code),
            onRemove: () => removeGalaxy(p.code)
        })));
        table.update();

        figure.setLabel(`Hubble plot of recession speed in km/s against distance in Mpc. ${n} galax${n === 1 ? 'y' : 'ies'} plotted.${fit ? ` The line through the origin has gradient ${sig(fit.slope, 3)} km/s/Mpc.` : ''} Values are in the table under Show as table.`);
        figure.redraw();
    }
    refreshTab = refresh;

    // ---------- Drawing ----------

    function logAxis(values, fallbackLo, fallbackHi) {
        const good = values.filter((x) => x > 0);
        const lo = good.length ? 10 ** Math.floor(Math.log10(Math.min(...good))) : fallbackLo;
        const hi = good.length ? 10 ** Math.ceil(Math.log10(Math.max(...good)) + 1e-9) : fallbackHi;
        return hi > lo ? [lo, hi] : [lo, lo * 10];
    }

    function decadeTicks(scale, lo, hi) {
        const ticks = [];
        for (let e = Math.round(Math.log10(lo)); e <= Math.round(Math.log10(hi)); e++) {
            ticks.push({ at: scale(10 ** e), text: powerLabel(e) });
            if (e < Math.round(Math.log10(hi))) {
                [2, 5].forEach((k) => ticks.push({ at: scale(k * 10 ** e), text: '', grid: false }));
            }
        }
        return ticks;
    }

    function linearTicks(scale, lo, hi, count) {
        return niceTicks(lo, hi, count).map((value) => ({ at: scale(value), text: withCommas(value) }));
    }

    function draw(ctx, frame) {
        const { width, height, theme } = frame;
        const points = galaxyPoints();
        const fit = currentFit();
        const rect = { x: 62, y: 10, w: width - 62 - 12, h: height - 10 - 42 - (showResiduals ? RESIDUALS_HEIGHT : 0) };

        let sx;
        let sy;
        let xTicks;
        let yTicks;
        const distances = points.map((p) => p.dMpc);
        const speeds = points.map((p) => p.v + p.vErr);
        if (useLog) {
            const [xLo, xHi] = logAxis(distances, 10, 1000);
            const [yLo, yHi] = logAxis(points.map((p) => p.v), 100, 100000);
            sx = logScale(xLo, xHi, rect.x, rect.x + rect.w);
            sy = logScale(yLo, yHi, rect.y + rect.h, rect.y);
            xTicks = decadeTicks(sx, xLo, xHi);
            yTicks = decadeTicks(sy, yLo, yHi);
        } else {
            const xMax = niceCeil(Math.max(50, ...distances) * 1.04);
            const yMax = niceCeil(Math.max(3500, ...speeds) * 1.04);
            const yMin = Math.min(0, ...points.map((p) => p.v - p.vErr));
            const yLow = yMin < 0 ? -niceCeil(-yMin) : 0;
            sx = linearScale(0, xMax, rect.x, rect.x + rect.w);
            sy = linearScale(yLow, yMax, rect.y + rect.h, rect.y);
            xTicks = linearTicks(sx, 0, xMax, Math.max(3, Math.floor(rect.w / 60)));
            yTicks = linearTicks(sy, yLow, yMax, 5);
        }

        drawFrame(ctx, rect, theme, {
            xTicks,
            yTicks,
            xTitle: showResiduals ? '' : 'Distance d (Mpc)',
            yTitle: 'Recession speed v (km/s)'
        });

        const inX = (x) => Math.max(rect.x, Math.min(rect.x + rect.w, x));
        const inY = (y) => Math.max(rect.y, Math.min(rect.y + rect.h, y));

        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.w, rect.h);
        ctx.clip();
        if (fit) {
            const xs = useLog ? [sx.invert(rect.x), sx.invert(rect.x + rect.w)] : [0, sx.invert(rect.x + rect.w)];
            ctx.strokeStyle = theme.accent;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(sx(xs[0]), sy(fit.slope * xs[0]));
            ctx.lineTo(sx(xs[1]), sy(fit.slope * xs[1]));
            ctx.stroke();
        }
        ctx.restore();

        if (fit) {
            // The line's own label, just below and to the right of it
            const labelX = rect.x + rect.w * 0.7;
            haloText(ctx, 'v = H₀d', labelX + 10, inY(sy(fit.slope * sx.invert(labelX)) + 16), theme, {
                font: fontOf(theme, 12, 600),
                colour: theme.strong
            });
        }

        const placer = createLabelPlacer(ctx, rect);
        points.forEach((p) => {
            p.px = inX(sx(p.dMpc));
            p.py = inY(p.v > 0 || !useLog ? sy(p.v) : rect.y + rect.h);
            if (p.vErr > 0) {
                const low = useLog ? Math.max(p.v - p.vErr, p.v * 0.1) : p.v - p.vErr;
                if (low > 0 || !useLog) drawErrorBar(ctx, p.px, inY(sy(low)), p.px, inY(sy(p.v + p.vErr)), theme.strong);
            }
            placer.reserve(p.px, p.py, 5);
        });
        const code = current ? current.entity.code : null;
        points.forEach((p) => {
            const hollow = Math.abs(p.z) > Z_LIMIT;
            drawMarker(ctx, 'circle', p.px, p.py, 4, { fill: hollow ? theme.paper : theme.strong, stroke: theme.strong, width: 1.5 });
            if (p.code === code) {
                ctx.beginPath();
                ctx.arc(p.px, p.py, 8, 0, Math.PI * 2);
                ctx.strokeStyle = theme.accent;
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        });
        ctx.font = fontOf(theme, 12, 700);
        points.forEach((p) => {
            const text = String(plotted.get(p.code));
            const spot = placer.place(text, p.px, p.py, 5);
            if (spot) haloText(ctx, text, spot.x, spot.y, theme, { font: fontOf(theme, 12, 700), colour: theme.strong });
        });

        if (points.length === 0) {
            haloText(ctx, 'No galaxies yet', rect.x + rect.w / 2, rect.y + rect.h / 2, theme, { align: 'center', font: fontOf(theme, 13, 400, 'italic') });
        }

        if (showResiduals) drawResiduals(ctx, frame, rect, sx, points, fit);

        view = { points };
    }

    // A second small panel under the first: how far each point sits from the line. At the far end of the plot the
    // ±300 km/s scatter would be too small to see on the main axis.
    function drawResiduals(ctx, frame, main, sx, points, fit) {
        const { theme, height } = frame;
        const top = main.y + main.h + 36;
        const rect = { x: main.x, y: top, w: main.w, h: height - top - 42 };
        const residuals = fit ? points.map((p) => p.v - fit.slope * p.dMpc) : [];
        const biggest = niceCeil(Math.max(100, ...residuals.map(Math.abs)) * 1.1, 2);
        const sy = linearScale(-biggest, biggest, rect.y + rect.h, rect.y);
        const xTicks = useLog
            ? decadeTicks(sx, sx.invert(rect.x), sx.invert(rect.x + rect.w))
            : niceTicks(0, sx.invert(rect.x + rect.w), Math.max(3, Math.floor(rect.w / 60))).map((value) => ({ at: sx(value), text: withCommas(value) }));
        drawFrame(ctx, rect, theme, {
            xTicks,
            yTicks: [-biggest, 0, biggest].map((value) => ({ at: sy(value), text: value === 0 ? '0' : signedSpeed(value) })),
            xTitle: 'Distance d (Mpc)'
        });
        haloText(ctx, 'Residual: v − H₀d (km/s)', rect.x + 6, rect.y - 8, theme, { font: fontOf(theme, 12, 600) });

        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(rect.x, sy(0));
        ctx.lineTo(rect.x + rect.w, sy(0));
        ctx.stroke();

        points.forEach((p, i) => {
            if (!fit) return;
            const x = Math.max(rect.x, Math.min(rect.x + rect.w, sx(p.dMpc)));
            const y = sy(residuals[i]);
            ctx.strokeStyle = theme.text;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, sy(0));
            ctx.lineTo(x, y);
            ctx.stroke();
            drawMarker(ctx, 'circle', x, y, 3, { fill: Math.abs(p.z) > Z_LIMIT ? theme.paper : theme.strong, stroke: theme.strong, width: 1.25 });
        });
    }

    // ---------- Pointer ----------

    figure.canvas.addEventListener('pointermove', (event) => {
        if (!view) return;
        const pos = figure.pointerPos(event);
        const point = nearestPoint(view.points, pos);
        figure.canvas.style.cursor = point ? 'pointer' : 'default';
        if (point) {
            figure.showTip(point.px, point.py, [
                point.code,
                `${sig(point.dMpc, 3)} Mpc, ${withCommas(point.v)} km/s`,
                `z = ${sig(point.z, 2)}`
            ]);
        } else {
            figure.hideTip();
        }
    });
    figure.canvas.addEventListener('pointerleave', () => figure.hideTip());
    figure.canvas.addEventListener('click', (event) => {
        if (!view) return;
        const point = nearestPoint(view.points, figure.pointerPos(event));
        if (point) select(point.code);
    });

    bus.on('measurement', ({ code }) => {
        if (plotted.has(code)) {
            refresh();
            return;
        }
        if (current && current.entity.code === code) {
            if (current.body.kind === 'quasar') renderQuasarNote(current);
            else card.refresh();
        }
    });

    return {
        setEntity(resolved) {
            current = resolved;
            refresh();
        },
        onShow() {
            figure.redraw();
        }
    };
}
