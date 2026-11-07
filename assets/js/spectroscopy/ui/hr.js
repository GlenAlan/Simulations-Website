// The H-R tab (spec section 11). Students plot the stars they have measured, with temperature from the Wien tool
// or a reference match and luminosity from L = 4 pi d^2 b. A cluster's members can all be plotted at once, and the
// main-sequence turn-off then gives an estimate of its age. Regions explain what powers their stars.
// The student's own stars last through a reload, in this browser, until they're cleared.

import { bus, select } from '../core/state.js';
import { getMeasurement, recordMeasurement } from '../core/measurements.js';
import { luminosityFromFlux, L_SUN, PC } from '../core/phys.js';
import { Rng } from '../core/rng.js';
import { distance, plusMinus, sci, sig, withCommas } from '../core/format.js';
import * as synth from '../spectra/synth.js';
import { toolWords } from './spectrum/tools/index.js';
import { newTurnOff, turnOffWords, drawTurnOff, turnOffGrip, turnOffValueText } from './turn_off.js';
import {
    blackBodyCss, createToggle, createDataTable, createFigure, createLabelPlacer, createMeasureCard, createPlottedList,
    drawErrorBar, drawFrame, drawMarker, el, fontOf, haloText, linearScale, logScale, markerIcon, nearestPoint, powerLabel,
    readSaved, showFigure, writeSaved, savedEntries, cleanSaved
} from './plot2d.js';

const T_MAX = 130000;     // Left edge (K): the hottest white dwarfs
const T_MIN = 2000;       // Right edge (K)
const LOG_L_MIN = -5;
const LOG_L_MAX = 7;
const TURN_OFF_MIN = -3.5;  // The turn-off marker moves along the main sequence, so stays within its ends
const TURN_OFF_MAX = 6;
const T_SUN = 5772;

// The middle of the main sequence: [temperature (K), log10 L in L☉]
const MS_LINE = [
    [2200, -4.1], [2400, -3.7], [3000, -2.4], [3700, -1.25], [4500, -0.65], [5200, -0.25], [5772, 0], [6500, 0.42],
    [7500, 0.85], [10000, 1.65], [15000, 2.9], [20000, 3.6], [30000, 4.6], [50000, 5.75], [60000, 6.1]
];
const MS_HALF_WIDTH = 0.65;   // In decades of luminosity

// Where the CNO cycle takes over from the p-p chain: a star of about 1.3 M☉, near 6,500 K
const CNO_T = 6500;

export function msLogL(T) {
    const x = Math.log10(T);
    let i = 0;
    while (i < MS_LINE.length - 2 && T > MS_LINE[i + 1][0]) i++;
    const x0 = Math.log10(MS_LINE[i][0]);
    const x1 = Math.log10(MS_LINE[i + 1][0]);
    return MS_LINE[i][1] + ((x - x0) / (x1 - x0)) * (MS_LINE[i + 1][1] - MS_LINE[i][1]);
}

// The main-sequence temperature at a luminosity: the same line read the other way
function msTemperature(logL) {
    let i = 0;
    while (i < MS_LINE.length - 2 && logL > MS_LINE[i + 1][1]) i++;
    const [T0, y0] = MS_LINE[i];
    const [T1, y1] = MS_LINE[i + 1];
    return 10 ** (Math.log10(T0) + ((logL - y0) / (y1 - y0)) * (Math.log10(T1) - Math.log10(T0)));
}

// Which part of the diagram a point falls in. This sets its marker shape, so a point never relies on colour.
export function regionOf(T, L) {
    const logL = Math.log10(L);
    const radius = Math.sqrt(L) / (T / T_SUN) ** 2;
    if (radius < 0.04) return 'white_dwarf';
    if (logL - msLogL(T) <= 0.85) return 'main_sequence';
    return logL >= 3.8 ? 'supergiant' : 'giant';
}

const SHAPES = { main_sequence: 'circle', giant: 'square', supergiant: 'diamond', white_dwarf: 'triangle' };
const REGION_NAMES = { main_sequence: 'Main sequence', giant: 'Giant', supergiant: 'Supergiant', white_dwarf: 'White dwarf' };

// Age from the turn-off. L ∝ M^3.5 gives the mass of the stars now leaving the main sequence, allowing for a star
// being about twice as bright by then as when it formed, and their lifetime is t ≈ 10 billion years × M^-2.5.
export function turnOffAge(logL) {
    const massMsun = (10 ** logL / 2) ** (1 / 3.5);
    return { massMsun, ageGyr: 10 * massMsun ** -2.5, T: msTemperature(logL) };
}

// The top of the main sequence, skipping the odd straggler above it. Giants sit well clear of the band.
export function suggestTurnOff(points) {
    const onMs = points
        .map((p) => ({ logL: Math.log10(p.L), T: p.T }))
        .filter((p) => Math.abs(p.logL - msLogL(p.T)) <= 0.85)
        .map((p) => p.logL)
        .sort((a, b) => b - a);
    if (onMs.length === 0) return 0;
    return onMs[Math.min(onMs.length - 1, Math.max(1, Math.round(onMs.length * 0.02)))];
}

function bandOutline(hot, cool) {
    const inside = MS_LINE.map(([T]) => T).filter((T) => T > cool && T < hot);
    const temps = [cool, ...inside, hot];
    return [
        ...temps.map((T) => [T, msLogL(T) + MS_HALF_WIDTH]),
        ...temps.slice().reverse().map((T) => [T, msLogL(T) - MS_HALF_WIDTH])
    ];
}

// outline is [T (K), log L] pairs. at is where the label and the keyboard target sit: beside the band for giants
// and white dwarfs, as their stars would otherwise cover the words.
const REGIONS = [
    {
        id: 'supergiants',
        name: 'Supergiants',
        label: 'Supergiants',
        at: [8000, 5.3],
        outline: [[32000, 5.0], [32000, 6.4], [2600, 6.1], [2600, 4.2], [8000, 4.1]],
        process: 'Helium burning and heavier elements',
        stage: 'Late life of a very massive star',
        text: 'After helium, the core goes on to fuse carbon, neon, oxygen and silicon, in shells like the layers of an onion, making heavier elements up to iron. Fusing iron gives out no energy, so the core then collapses and the star explodes as a supernova, scattering those elements through space.'
    },
    {
        id: 'giants',
        name: 'Giants',
        label: 'Giants',
        at: [7000, 2.6],
        outline: [[6200, 1.5], [5400, 2.3], [4200, 3.1], [2900, 3.6], [2900, 2.5], [3800, 1.4], [4800, 0.85], [5800, 0.8]],
        process: 'Helium burning',
        stage: 'Late life, after the main sequence',
        text: 'The core has run out of hydrogen. It shrinks and heats up while hydrogen fuses in a shell around it, and the outer layers swell and cool. At about 100 million K the core starts joining helium nuclei into carbon and oxygen. In massive stars, this goes on to heavier elements.'
    },
    {
        id: 'upper-ms',
        name: 'Upper main sequence',
        label: 'Main sequence',
        at: [9000, msLogL(9000)],
        outline: bandOutline(60000, CNO_T),
        process: 'CNO cycle',
        stage: 'Adult life: steady hydrogen fusion in the core',
        text: 'Stars above about 1.3 solar masses. In cores hotter than about 17 million K, carbon, nitrogen and oxygen nuclei act as catalysts: protons attach to them one at a time until a helium nucleus falls out and the carbon is free to go again. Four hydrogen nuclei still become one helium, and the lost mass is the energy released, E = mc². The rate climbs so steeply with temperature that these stars use up their hydrogen in millions of years, not billions.'
    },
    {
        id: 'lower-ms',
        name: 'Lower main sequence',
        at: [3900, msLogL(3900)],
        outline: bandOutline(CNO_T, 2200),
        process: 'p-p chain',
        stage: 'Adult life: steady hydrogen fusion in the core',
        text: 'Stars below about 1.3 solar masses, including the Sun. Their cores, cooler than about 17 million K, join protons directly: in a few steps, four hydrogen nuclei become one helium nucleus. The helium has about 0.7% less mass than the hydrogen it came from, and that lost mass is the energy released, E = mc².'
    },
    {
        id: 'white-dwarfs',
        name: 'White dwarfs',
        label: 'White dwarfs',
        at: [55000, -2.8],
        outline: [[100000, -1.4], [100000, 0.6], [40000, -0.4], [15000, -1.8], [8000, -2.9], [5000, -3.5], [4300, -4.5], [8000, -4.5], [15000, -3.6], [40000, -2.4]],
        process: 'No fusion',
        stage: 'End of life for low and medium-mass stars',
        text: 'What is left after a star sheds its outer layers: a hot core of carbon and oxygen, about the size of a planet. Nothing fuses here any more. It shines with stored heat, so it slowly cools and fades, drifting down and to the right.'
    }
];

const CLASSES = [['O', T_MAX, 30000], ['B', 30000, 10000], ['A', 10000, 7500], ['F', 7500, 6000], ['G', 6000, 5200], ['K', 5200, 3700], ['M', 3700, T_MIN]];
const T_TICKS = [100000, 50000, 20000, 10000, 5000, 3000];
const RADIUS_LINES = [0.01, 0.1, 1, 10, 100, 1000];
const SOURCES = { wien: 'Wien\'s law', fit: 'your fitted curve', standard: 'a standard star', reference: 'the reference match', typed: 'your typed value' };
const SOURCE_SHORT = { wien: 'Wien\'s law', fit: 'Fitted curve', standard: 'Standard star', reference: 'Reference match', typed: 'Typed in' };
const T_NOISE = 0.02;     // Cluster members: true temperature with this fractional noise

// How far to trust a turn-off age. Plotting all 40 of this sky's clusters at the suggested turn-off gave 0.77 to 1.37 times
// the catalogue age, so the true age is within about 30% of what's shown. Stated in words beside the figure.
const AGE_ERROR_PERCENT = 30;

// ---------- Session state: kept here, not in the tab, so it outlives a change of selection ----------

const plotted = new Map();   // code -> number shown beside the point
let nextNumber = 1;
let cluster = null;          // { code, type, points, turnOffLogL, placed }: the student places the turn-off (turn_off.js)
let saveKey = null;
let tab = null;              // The mounted tab's refresh, announce and focus

function persist() {
    if (!saveKey) return;
    const stars = [...plotted].map(([code, number]) => ({ code, number, values: getMeasurement(code) }));
    writeSaved(saveKey, stars.length ? { nextNumber, stars } : null);
}

// What a saved star may bring back: the numbers the form itself would take, and the words the tools write
const SAVED_LIMITS = {
    T_K: [100, 1e7], T_err_K: [0, 1e7],
    flux_Wm2: [1e-30, 1e6], flux_err: [0, 1e6],
    distance_pc: [1e-6, 1e10],
    L_Lsun: [1e-12, 1e14], L_err_Lsun: [0, 1e14]
};
const SAVED_WORDS = { T_source: Object.keys(SOURCES) };

function restore(app) {
    saveKey = `spectro.hr.v1.${app.universe.seed}`;
    const saved = readSaved(saveKey);
    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.stars)) return;
    // Codes are kept from one sky to the next, but what a code names may have changed: only stars still go on the diagram
    const isStar = (code) => {
        const resolved = app.universe.resolve(code);
        return !!resolved && isApplicable(resolved) && !(resolved.path === 'body' && resolved.body.kind === 'cluster');
    };
    savedEntries(saved.stars, isStar).forEach(({ code, number, values }) => {
        const clean = cleanSaved(values, SAVED_LIMITS, SAVED_WORDS);
        if (!Object.keys(clean).length) return;
        recordMeasurement(code, clean);
        if (starPoint(code)) {
            plotted.set(code, number);
            nextNumber = Math.max(nextNumber, number + 1);
        }
    });
    // What couldn't be used is gone from the save too
    persist();
}

function addStar(code) {
    if (plotted.has(code)) return;
    plotted.set(code, nextNumber++);
    persist();
    bus.emit('plotted', { code });
}

// ---------- Numbers ----------

// Luminosity from what's been measured, with its uncertainty carried through: (ΔL/L)² = (Δb/b)² + (2Δd/d)²
function luminosityOf(m) {
    if (m.flux_Wm2 > 0 && m.distance_pc > 0) {
        const L = luminosityFromFlux(m.flux_Wm2, m.distance_pc);
        const fromFlux = m.flux_err > 0 ? m.flux_err / m.flux_Wm2 : 0;
        const fromDistance = m.distance_err_pc > 0 ? (2 * m.distance_err_pc) / m.distance_pc : 0;
        return { L, err: L * Math.hypot(fromFlux, fromDistance) };
    }
    return null;
}

function starPoint(code) {
    const m = getMeasurement(code) || {};
    const lum = luminosityOf(m);
    if (!(m.T_K > 0) || !lum) return null;
    return { code, T: m.T_K, Terr: m.T_err_K || 0, L: lum.L, Lerr: lum.err, source: m.T_source };
}

// Each member's brightness from the photometer when the spectra code offers one, or else its catalogue flux
function memberFlux(member) {
    if (typeof synth.photometer === 'function') {
        try {
            const reading = synth.photometer(member);
            const flux = typeof reading === 'number' ? reading : reading && reading.flux_Wm2;
            if (flux > 0) return flux;
        } catch (err) {
            // Falls through to the catalogue value
        }
    }
    return member.brightness ? member.brightness.flux_Wm2 : 0;
}

export function clusterPoints(body) {
    const rng = new Rng(`hr-${body.code}`); // The same noise each time this cluster is plotted
    const out = [];
    body.cluster.members.forEach((member) => {
        // A binary member's two stars were born with the cluster too, and each is a point of its own. The pair's own code
        // finds its brighter star.
        (member.stars || [member]).forEach((one, k) => {
            const flux = memberFlux(one);
            const dist = member.distance_pc || body.distance_pc;
            const L = flux > 0 && dist > 0 ? luminosityFromFlux(flux, dist) : one.star.luminosity_Lsun;
            const T = one.star.teff_K * (1 + rng.gauss(0, T_NOISE));
            if (L > 0 && T > 0) out.push({ code: one.code, pairCode: member.stars && k === 0 ? member.code : null, T, L, isMember: true });
        });
    });
    return out;
}

function ageText(ageGyr) {
    return ageGyr >= 1 ? `${sig(ageGyr, 2)} billion years` : `${sig(ageGyr * 1000, 2)} million years`;
}

// ---------- The tab ----------

function isApplicable(resolved) {
    if (resolved.path === 'member' || resolved.path === 'component') return true;
    return resolved.path === 'body' && ['star', 'binary', 'multiple', 'cluster'].includes(resolved.body.kind);
}

export function initHRTab(app) {
    app.drawer.registerTab({
        id: 'hr',
        label: 'H-R',
        order: 30,
        appliesTo: isApplicable,
        mount: (container) => mountHR(container, app)
    });
    restore(app);

    // How the Spectrum tab's tools hand their results over
    const open = () => app.drawer.selectTab('hr');
    app.diagrams = app.diagrams || {};
    app.diagrams.hr = {
        isPlotted: (code) => plotted.has(code),
        canPlot: (code) => !!starPoint(code),
        plot(code) {
            open();
            addStar(code);
            if (tab) tab.added(code);
        },
        show() {
            open();
            if (tab) tab.arrive();
        }
    };
}

function mountHR(container, app) {
    let current = null;
    let axisMode = 'temperature';  // or 'class'
    let showRadii = false;
    let activeRegion = null;
    let hoverRegion = null;
    let closingNote = false;
    let regionSeen = false;
    let view = null;               // The last draw's geometry and points, for hit tests
    const bandCache = { key: '', canvas: null };

    const root = el('div', { class: 'spectro-fig-tab' });
    container.appendChild(root);

    // The star in hand, as one thin strip over the diagram, so the two are on screen together and the diagram is the bigger
    const top = el('div', { class: 'spectro-fig-top' });
    root.appendChild(top);

    const figure = createFigure(root, {
        label: 'H-R diagram',
        height: (w) => {
            const scroller = root.closest('.sim-controls-content');
            const room = scroller && scroller.clientHeight ? scroller.clientHeight - top.offsetHeight - 64 : window.innerHeight * 0.62;
            return Math.max(270, Math.min(w * 1.1, 560, room));
        },
        draw
    });


    // Keyboard targets for the regions. A pointer reaches the regions through the canvas itself, so these let
    // clicks pass through them; see the CSS.
    const regionButtons = new Map();
    REGIONS.forEach((region) => {
        const button = el('button', {
            type: 'button',
            class: 'spectro-fig-region',
            'aria-label': `${region.name}: what powers these stars`,
            'aria-pressed': 'false',
            onclick: () => showRegion(activeRegion === region.id ? null : region.id, button),
            onfocus: () => {
                if (button.matches(':focus-visible') && !closingNote) showRegion(region.id, button);
            }
        });
        regionButtons.set(region.id, button);
        figure.wrap.appendChild(button);
    });

    const handle = el('div', {
        class: 'spectro-fig-handle',
        role: 'slider',
        tabindex: '0',
        hidden: true,
        'aria-label': 'Main-sequence turn-off luminosity',
        'aria-orientation': 'vertical',
        'aria-valuemin': String(TURN_OFF_MIN),
        'aria-valuemax': String(TURN_OFF_MAX),
        title: 'Drag to move the turn-off'
    });
    figure.wrap.appendChild(handle);

    // Under the diagram, on one quiet line: its two switches, and once there are points, what their shapes mean. A point's
    // colour follows its temperature, as the strip along the top does.
    const options = el('div', { class: 'spectro-fig-options' });
    createToggle(options, 'Spectral class axis', (on) => {
        axisMode = on ? 'class' : 'temperature';
        figure.redraw();
    }, 'Label the temperature axis with spectral classes, O to M');
    createToggle(options, 'Radius lines', (on) => {
        showRadii = on;
        figure.redraw();
    }, 'Lines of equal radius, in solar radii');
    const legend = el('div', { class: 'spectro-fig-legend', hidden: true, title: 'A point\'s colour follows its temperature, as in the strip along the top' },
        ...Object.keys(SHAPES).map((id) => el('span', {}, markerIcon(SHAPES[id], { hollow: true }), REGION_NAMES[id])));
    root.append(options, legend);

    // Until there's a star on the diagram: how to find the kind of star a task asks for, and that the regions say more
    const findHint = el('p', { class: 'spectro-fig-hintline', text: 'To find a kind of star, go by colour: pale yellow is about G, orange about K. Of two orange stars, the much brighter is probably a giant.' });
    const regionHint = el('p', { class: 'spectro-fig-hintline', text: 'Click or tap a region to see what powers its stars.' });
    const regionNote = el('div', { class: 'spectro-fig-note', role: 'status', hidden: true });
    root.append(findHint, regionHint, regionNote);

    function showRegion(id, focusTarget) {
        activeRegion = id;
        regionButtons.forEach((button, key) => button.setAttribute('aria-pressed', key === id ? 'true' : 'false'));
        regionNote.replaceChildren();
        regionNote.hidden = !id;
        if (id) {
            regionSeen = true;
            regionHint.hidden = true;
            const region = REGIONS.find((r) => r.id === id);
            regionNote.append(
                el('div', { class: 'spectro-fig-note-head' },
                    el('p', { class: 'spectro-fig-card-title', text: `${region.name}: ${region.process}` }),
                    el('button', {
                        type: 'button',
                        class: 'spectro-fig-remove',
                        text: '×',
                        'aria-label': 'Close this note',
                        onclick: () => {
                            showRegion(null);
                            closingNote = true;
                            if (focusTarget) focusTarget.focus();
                            closingNote = false;
                        }
                    })),
                el('p', { class: 'spectro-fig-card-status', text: region.stage }),
                el('p', { text: region.text }));
        }
        figure.redraw();
    }

    // ---------- Adding the current star ----------

    const card = createMeasureCard(top, {
        addLabel: 'Plot on H-R',
        removeLabel: 'Remove from H-R',
        workingParent: root,
        onTool: (tool) => app.spectrumPanel.openTool(tool, { from: 'hr', focus: true }),
        fields: [
            {
                key: 'T_K',
                label: 'Temperature',
                unit: 'K',
                placeholder: '5,800',
                tool: 'wien',
                toolName: toolWords({ id: 'wien' }).short,
                min: 100,
                max: 1e7,
                rangeText: 'a temperature from 100 to 10,000,000 K',
                extra: { T_source: 'typed', T_err_K: undefined },
                brief: (m) => `${m.T_err_K > 0 ? plusMinus(m.T_K, m.T_err_K) : withCommas(m.T_K)} K`,
                show: (m) => `${m.T_err_K > 0 ? plusMinus(m.T_K, m.T_err_K) : withCommas(m.T_K)} K, from ${SOURCES[m.T_source] || 'your measurement'}`
            },
            {
                key: 'flux_Wm2',
                label: 'Brightness',
                unit: 'W/m²',
                placeholder: '3.2e-9',
                tool: 'photometer',
                toolName: toolWords({ id: 'photometer' }).short,
                min: 1e-30,
                max: 1e6,
                rangeText: 'a brightness from 1e-30 to 1e6 W/m²',
                extra: { flux_err: undefined, L_Lsun: undefined, L_err_Lsun: undefined },
                brief: (m) => `${sci(m.flux_Wm2, 2)} W/m²`,
                show: (m) => `${sci(m.flux_Wm2, 3)} W/m², from the Brightness tool`
            },
            {
                key: 'distance_pc',
                label: 'Distance',
                unit: 'pc',
                placeholder: '35',
                tool: 'photometer',
                toolName: toolWords({ id: 'photometer' }).short,
                min: 1e-6,
                max: 1e10,
                rangeText: 'a distance from 1e-6 to 1e10 pc',
                extra: { L_Lsun: undefined, L_err_Lsun: undefined },
                brief: (m) => distance(m.distance_pc),
                show: (m) => `${distance(m.distance_pc)}, from the Brightness tool`
            }
        ],
        // Where it went, once it's on: the point's number and the two values it is plotted at
        summary(code) {
            const point = starPoint(code);
            return point ? `Point ${plotted.get(code)}: ${sig(point.T, 3)} K, ${sig(point.L, 3)} L☉` : '';
        },
        workingLabel: 'How the luminosity is worked out',
        status(code) {
            if (plotted.has(code)) {
                const point = starPoint(code);
                const offScale = point && (point.T > T_MAX || point.T < T_MIN || Math.log10(point.L) > LOG_L_MAX || Math.log10(point.L) < LOG_L_MIN);
                return offScale ? 'Off the scale, so the point sits at the edge.' : '';
            }
            const body = current && current.body;
            if (current && current.path === 'body' && body && body.kind !== 'star') {
                return 'This point is the combined light of its stars. Select one star to plot it alone.';
            }
            return '';
        },
        working(code, m) {
            const lum = luminosityOf(m);
            if (!lum) return null;
            const metres = m.distance_pc * PC;
            const watts = lum.L * L_SUN;
            const result = lum.err > 0 ? plusMinus(lum.L, lum.err) : sig(lum.L, 3);
            return [
                `d = ${sig(m.distance_pc, 3)} pc = ${sci(metres, 3)} m`,
                `L = 4π × (${sci(metres, 3)} m)² × (${sci(m.flux_Wm2, 3)} W/m²)`,
                `= ${sci(watts, 3)} W = ${result} L☉`,
                `One L☉ is ${sci(L_SUN, 3)} W.`
            ];
        },
        isPlotted: (code) => plotted.has(code),
        onAdd(code) {
            addStar(code);
            announceAdded(code);
            refresh();
        },
        onRemove(code) {
            removeStar(code);
        }
    });

    function announceAdded(code) {
        const point = starPoint(code);
        if (point) announce(`${code} added at ${sig(point.T, 3)} K and ${sig(point.L, 3)} L☉.`);
    }

    function removeStar(code) {
        plotted.delete(code);
        if (plotted.size === 0) nextNumber = 1;
        persist();
        announce(`${code} removed.`);
        bus.emit('plotted', { code });
        refresh();
    }

    function clearStars() {
        plotted.clear();
        nextNumber = 1;
        persist();
        announce('All your stars removed from the diagram.');
        bus.emit('plotted', { code: null });
        refresh();
    }

    // ---------- Plotting a whole cluster ----------

    const clusterCard = el('div', { class: 'spectro-fig-card', hidden: true });
    top.appendChild(clusterCard);
    const clusterTitle = el('p', { class: 'spectro-fig-card-title', tabindex: '-1' });
    const clusterStatus = el('p', { class: 'spectro-fig-card-status' });
    const ageLine = el('p', { class: 'spectro-fig-readout', hidden: true });
    const turnOffLine = el('p', { class: 'spectro-fig-card-status', hidden: true });
    const clusterButton = el('button', { type: 'button', class: 'spectro-fig-button spectro-fig-button-main', onclick: toggleCluster });
    // No suggested turn-off: the student places it (turn_off.js)
    clusterCard.append(el('div', { class: 'spectro-fig-card-head' }, clusterTitle, el('div', { class: 'spectro-fig-actions' }, clusterButton)),
        clusterStatus, ageLine, turnOffLine);

    // How the age comes out, under the diagram and out of the way until asked for
    const turnOffBox = el('div', { class: 'spectro-fig-working' });
    const howAge = el('details', { class: 'sim-controls-more spectro-fig-more', hidden: true }, el('summary', { text: 'How the age is worked out' }), turnOffBox);
    root.appendChild(howAge);

    function clusterBody() {
        if (!current || !current.body) return null;
        if (current.body.cluster) return current.body;
        // A binary member is a body of its own, and knows which cluster it's in
        const home = current.body.in_cluster ? app.universe.resolve(current.body.in_cluster) : null;
        return home ? home.body : null;
    }

    function toggleCluster() {
        const body = clusterBody();
        if (!body) return;
        if (cluster && cluster.code === body.code) {
            cluster = null;
            announce('Cluster removed from the diagram.');
        } else {
            const points = clusterPoints(body);
            cluster = { code: body.code, type: body.cluster.type, points, ...newTurnOff() };
            announce(`${points.length} cluster members plotted.`);
        }
        refresh();
    }

    function renderClusterCard() {
        const body = clusterBody();
        clusterCard.hidden = !body;
        if (!body) return;
        const typeName = body.cluster.type === 'globular' ? 'Globular cluster' : 'Open cluster';
        clusterTitle.textContent = `${typeName} ${body.code}`;
        const showing = cluster && cluster.code === body.code;
        clusterButton.textContent = showing ? 'Remove' : 'Plot all members';
        clusterButton.setAttribute('aria-label', showing ? `Remove cluster ${body.code} from the diagram` : `Plot all members of ${body.code}`);
        clusterButton.classList.toggle('spectro-fig-button-main', !showing);
        clusterButton.classList.toggle('spectro-fig-quiet', !!showing);
        clusterStatus.textContent = `${body.cluster.n_stars} stars, all about as far away and as old as each other.`;
        clusterStatus.hidden = !!showing;
        ageLine.hidden = !showing;
        turnOffLine.hidden = !showing;
        howAge.hidden = !showing;
        if (showing) renderTurnOff();
    }

    function renderTurnOff() {
        const words = turnOffWords(cluster, turnOffAge(cluster.turnOffLogL), ageText, AGE_ERROR_PERCENT);
        ageLine.textContent = words.age;
        ageLine.hidden = !words.age;
        turnOffLine.textContent = words.status;
        turnOffBox.replaceChildren(
            ...(words.working || []).map((line) => el('span', { text: line })),
            ...words.notes.map((line) => el('span', { class: 'spectro-fig-working-note', text: line })));
    }

    function setTurnOff(logL) {
        cluster.placed = true;
        cluster.turnOffLogL = Math.max(TURN_OFF_MIN, Math.min(TURN_OFF_MAX, logL));
        renderTurnOff();
        figure.redraw();
        updateLabel();
    }

    handle.addEventListener('keydown', (event) => {
        if (!cluster) return;
        const steps = { ArrowUp: 0.05, ArrowDown: -0.05, PageUp: 0.5, PageDown: -0.5 };
        if (event.key in steps) setTurnOff(cluster.turnOffLogL + steps[event.key]);
        else if (event.key === 'Home') setTurnOff(TURN_OFF_MIN);
        else if (event.key === 'End') setTurnOff(TURN_OFF_MAX);
        else return;
        // These keys move the marker here, not the sky
        event.preventDefault();
        event.stopPropagation();
    });
    handle.addEventListener('pointerdown', (event) => {
        handle.setPointerCapture(event.pointerId);
        handle.classList.add('is-dragging');
        event.preventDefault();
        handle.focus({ preventScroll: true });
    });
    handle.addEventListener('pointermove', (event) => {
        if (!cluster || !view || !handle.hasPointerCapture(event.pointerId)) return;
        setTurnOff(view.sy.invert(figure.pointerPos(event).y));
    });
    const endDrag = () => handle.classList.remove('is-dragging');
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);

    // ---------- The list and the table ----------

    const list = createPlottedList(root, 'Your stars', focusAtTop, clearStars);
    // The working and the table come after the list, closed
    const table = createDataTable(root, {
        label: 'Plotted stars',
        columns: ['Point', 'Code', 'Temperature (K)', 'Luminosity (L☉)', 'Region', 'Temperature from'],
        rows: () => allPoints().map((p) => [
            p.isMember ? '' : String(plotted.get(p.code)),
            { button: p.code, label: `Select ${p.code}`, onClick: () => select(p.code) },
            p.Terr > 0 ? plusMinus(p.T, p.Terr) : sig(p.T, 3),
            p.Lerr > 0 ? plusMinus(p.L, p.Lerr) : sig(p.L, 3),
            REGION_NAMES[regionOf(p.T, p.L)],
            p.isMember ? 'Catalogue, with noise' : (SOURCE_SHORT[p.source] || 'Measured')
        ])
    });

    const live = el('p', { class: 'spectro-fig-sr', role: 'status' });
    root.appendChild(live);
    function announce(text) { live.textContent = text; }

    // Something that takes focus for certain, whichever card is showing
    function focusAtTop() {
        return clusterCard.hidden ? { focus: () => card.focusTitle() } : clusterTitle;
    }

    tab = {
        // Back from a tool: on to the next thing to press
        arrive() {
            refresh();
            if (clusterCard.hidden || !card.root.hidden) card.focusNext();
            else clusterButton.focus();
        },
        added(code) {
            announceAdded(code);
            refresh();
            card.focusTitle({ preventScroll: true });
            showFigure(root, figure);
        }
    };

    function studentPoints() {
        return [...plotted.keys()].map(starPoint).filter(Boolean);
    }

    // Cluster members first, so the student's own stars draw on top of them
    function allPoints() {
        return [...(cluster ? cluster.points : []), ...studentPoints()];
    }

    function updateLabel() {
        const count = plotted.size;
        const parts = [`H-R diagram, temperature falling to the right against luminosity on a log scale. ${count} of your own star${count === 1 ? '' : 's'} plotted.`];
        if (cluster) {
            parts.push(`${cluster.type === 'globular' ? 'Globular' : 'Open'} cluster ${cluster.code} plotted with ${cluster.points.length} members, ${cluster.placed ? `turn-off placed near ${sig(10 ** cluster.turnOffLogL, 2)} L☉` : 'turn-off not placed yet'}.`);
        }
        parts.push('Values are in the table under Show as table.');
        figure.setLabel(parts.join(' '));
    }

    function refresh() {
        const code = current ? current.entity.code : null;
        const isStar = current && !(current.path === 'body' && current.body.kind === 'cluster');
        card.setHidden(!isStar);
        if (isStar) card.setCode(code, `Star ${code}`);
        renderClusterCard();

        const any = plotted.size > 0 || !!cluster;
        legend.hidden = !any;
        findHint.hidden = !isStar || any;
        regionHint.hidden = any || regionSeen || !!activeRegion;

        list.update(studentPoints().map((p) => ({
            key: p.code,
            badge: String(plotted.get(p.code)),
            icon: markerIcon(SHAPES[regionOf(p.T, p.L)], { fill: blackBodyCss(p.T) }),
            code: p.code,
            detail: `${sig(p.T, 3)} K, ${sig(p.L, 3)} L☉`,
            current: p.code === code,
            onSelect: () => select(p.code),
            onRemove: () => removeStar(p.code)
        })));
        table.update();
        updateLabel();
        figure.redraw();
    }

    // ---------- Drawing ----------

    function makeXScale(rect) {
        if (axisMode === 'temperature') return logScale(T_MAX, T_MIN, rect.x, rect.x + rect.w);
        const width = rect.w / CLASSES.length;
        // Equal width for each class, as textbooks draw it, with log spacing inside a class
        return (T) => {
            const clamped = Math.max(T_MIN, Math.min(T_MAX, T));
            let i = CLASSES.findIndex((c) => clamped > c[2]);
            if (i < 0) i = CLASSES.length - 1;
            const [, hot, cool] = CLASSES[i];
            return rect.x + (i + Math.log(hot / clamped) / Math.log(hot / cool)) * width;
        };
    }

    // Edges are cut into short pieces so a straight edge in temperature follows the kinks of the class axis
    function projectOutline(outline, sx, sy) {
        const out = [];
        outline.forEach(([T, logL], i) => {
            const [T2, logL2] = outline[(i + 1) % outline.length];
            for (let k = 0; k < 8; k++) {
                const f = k / 8;
                out.push([sx(10 ** (Math.log10(T) + f * (Math.log10(T2) - Math.log10(T)))), sy(logL + f * (logL2 - logL))]);
            }
        });
        return out;
    }

    function tracePolygon(ctx, polygon, dx = 0) {
        ctx.beginPath();
        polygon.forEach(([x, y], i) => {
            if (i === 0) ctx.moveTo(x + dx, y);
            else ctx.lineTo(x + dx, y);
        });
        ctx.closePath();
    }

    function temperatureGradient(ctx, rect, sx, mix) {
        const gradient = ctx.createLinearGradient(rect.x, 0, rect.x + rect.w, 0);
        const STOPS = 36;
        for (let i = 0; i <= STOPS; i++) {
            const T = T_MAX * (T_MIN / T_MAX) ** (i / STOPS);
            gradient.addColorStop(Math.max(0, Math.min(1, (sx(T) - rect.x) / rect.w)), mix(blackBodyCss(T)));
        }
        return gradient;
    }

    // The soft bands, tinted by temperature. A shape drawn off the canvas casts a blurred shadow onto it, which
    // gives soft edges in every browser, unlike canvas filters. Kept until the size, axis or theme changes.
    function bandLayer(rect, sx, sy, frame) {
        const key = [frame.width, frame.height, frame.dpr, axisMode, frame.theme.isDark].join();
        if (bandCache.key === key) return bandCache.canvas;
        const layer = bandCache.canvas || document.createElement('canvas');
        layer.width = Math.round(frame.width * frame.dpr);
        layer.height = Math.round(frame.height * frame.dpr);
        const g = layer.getContext('2d');
        g.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0);
        g.save();
        g.beginPath();
        g.rect(rect.x, rect.y, rect.w, rect.h);
        g.clip();
        const away = frame.width + 200;
        g.shadowColor = '#000';
        g.shadowBlur = 7 * frame.dpr;
        g.shadowOffsetX = away * frame.dpr;
        g.fillStyle = '#000';
        REGIONS.forEach((region) => {
            tracePolygon(g, projectOutline(region.outline, sx, sy), -away);
            g.fill();
        });
        g.restore();
        // Pale yellow-white would vanish on white paper, so in the light theme the tint leans towards grey
        const mix = frame.theme.isDark
            ? (css) => css
            : (css) => css.replace(/\d+/g, (v) => String(Math.round(Number(v) * 0.68 + 88 * 0.32)));
        g.globalCompositeOperation = 'source-in';
        g.fillStyle = temperatureGradient(g, rect, sx, mix);
        g.fillRect(rect.x, rect.y, rect.w, rect.h);
        g.globalCompositeOperation = 'source-over';
        bandCache.key = key;
        bandCache.canvas = layer;
        return layer;
    }

    function drawRadiusLines(ctx, rect, sx, sy, theme) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.w, rect.h);
        ctx.clip();
        ctx.strokeStyle = theme.text;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        const labels = [];
        RADIUS_LINES.forEach((R) => {
            const logLAt = (T) => 2 * Math.log10(R) + 4 * Math.log10(T / T_SUN);
            ctx.beginPath();
            const STEPS = 60;
            let lastInside = null;
            for (let i = 0; i <= STEPS; i++) {
                const T = T_MAX * (T_MIN / T_MAX) ** (i / STEPS);
                const x = sx(T);
                const y = sy(logLAt(T));
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
                if (y >= rect.y + 8 && y <= rect.y + rect.h - 8) lastInside = [x, y];
            }
            ctx.stroke();
            if (lastInside) labels.push([R, lastInside]);
        });
        ctx.restore();
        labels.forEach(([R, [x, y]]) => {
            const px = Math.max(rect.x + 40, Math.min(x - 3, rect.x + rect.w - 3));
            haloText(ctx, `${R} R☉`, px, y - 2, theme, { align: 'right', baseline: 'bottom', font: fontOf(theme, 11) });
        });
    }

    function draw(ctx, frame) {
        const { width, height, theme } = frame;
        const rect = { x: 52, y: 12, w: width - 52 - 10, h: height - 12 - 42 };
        const sx = makeXScale(rect);
        const sy = linearScale(LOG_L_MIN, LOG_L_MAX, rect.y + rect.h, rect.y);

        const xTicks = axisMode === 'temperature'
            ? [
                ...T_TICKS.map((T) => ({ at: sx(T), text: withCommas(T) })),
                ...[70000, 30000, 7000, 4000].map((T) => ({ at: sx(T), text: '', grid: false }))
            ].sort((a, b) => a.at - b.at)
            : CLASSES.slice(1).map((c) => ({ at: sx(c[1]), text: '' }));
        const yTicks = [];
        for (let e = LOG_L_MIN; e <= LOG_L_MAX; e++) {
            const labelled = e % 2 === 0;
            yTicks.push({ at: sy(e), text: labelled ? powerLabel(e) : '', grid: labelled });
        }
        drawFrame(ctx, rect, theme, {
            xTicks,
            yTicks,
            xTitle: axisMode === 'temperature' ? 'Temperature (K), hotter to the left' : 'Spectral class, hotter to the left',
            yTitle: 'Luminosity (L☉)'
        });
        if (axisMode === 'class') {
            ctx.font = fontOf(theme, 12);
            ctx.fillStyle = theme.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            CLASSES.forEach((c, i) => ctx.fillText(c[0], rect.x + (i + 0.5) * (rect.w / CLASSES.length), rect.y + rect.h + 6));
        }

        // Bands, then the colour strip that says what the colours mean
        ctx.save();
        ctx.globalAlpha = theme.isDark ? 0.24 : 0.34;
        ctx.drawImage(bandLayer(rect, sx, sy, frame), 0, 0, width, height);
        ctx.restore();
        ctx.fillStyle = temperatureGradient(ctx, rect, sx, (css) => css);
        ctx.fillRect(rect.x + 1, rect.y + 1, rect.w - 2, 5);

        const polygons = new Map(REGIONS.map((region) => [region.id, projectOutline(region.outline, sx, sy)]));
        const emphasised = activeRegion || hoverRegion;
        if (emphasised) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(rect.x, rect.y, rect.w, rect.h);
            ctx.clip();
            tracePolygon(ctx, polygons.get(emphasised));
            ctx.strokeStyle = theme.accent;
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.restore();
        }

        if (showRadii) drawRadiusLines(ctx, rect, sx, sy, theme);

        // Cluster members go under the labels, the student's own stars over them
        drawCluster(ctx, rect, sx, sy, theme);

        const placer = createLabelPlacer(ctx, rect);
        const labelFont = fontOf(theme, 12, 400, 'italic');
        const labelBoxes = new Map();
        REGIONS.forEach((region) => {
            if (!region.label) return;
            ctx.font = labelFont;
            const w = ctx.measureText(region.label).width;
            const x = Math.max(rect.x + w / 2 + 4, Math.min(rect.x + rect.w - w / 2 - 4, sx(region.at[0])));
            const y = sy(region.at[1]);
            if (region.id === 'upper-ms') {
                // Lettered along the band, as textbooks do, but beside it: this is where the stars themselves sit
                const x2 = sx(region.at[0] * 0.8);
                const y2 = sy(msLogL(region.at[0] * 0.8));
                const angle = Math.atan2(y2 - y, x2 - x);
                const gap = sy(0) - sy(MS_HALF_WIDTH) + 9;
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate(angle);
                haloText(ctx, region.label, 0, gap, theme, { align: 'center', font: labelFont });
                ctx.restore();
                const cx = x - Math.sin(angle) * gap;
                const cy = y + Math.cos(angle) * gap;
                labelBoxes.set(region.id, { x: cx - 26, y: cy - 22, w: 52, h: 44 });
            } else {
                haloText(ctx, region.label, x, y, theme, { align: 'center', font: labelFont });
                labelBoxes.set(region.id, { x: x - w / 2 - 2, y: y - 8, w: w + 4, h: 16 });
                placer.reserveBox(x - w / 2, y - 7, w, 14);
            }
        });

        const stars = drawStudentStars(ctx, rect, sx, sy, theme, placer);

        // While the main sequence is in focus, show where the p-p chain gives way to the CNO cycle. It's brief, so it
        // goes over any stars there.
        if (emphasised === 'upper-ms' || emphasised === 'lower-ms') {
            const x = sx(CNO_T);
            const top = sy(msLogL(CNO_T) + MS_HALF_WIDTH);
            const bottom = sy(msLogL(CNO_T) - MS_HALF_WIDTH);
            haloText(ctx, 'CNO', x - 3, top - 1, theme, { align: 'right', baseline: 'bottom', font: fontOf(theme, 12, 600) });
            haloText(ctx, 'p-p', x + 3, bottom + 1, theme, { align: 'left', baseline: 'top', font: fontOf(theme, 12, 600) });
        }

        view = { rect, sx, sy, polygons, labelBoxes, points: [...(cluster ? cluster.points : []), ...stars] };
        placeOverlays();
    }

    function drawCluster(ctx, rect, sx, sy, theme) {
        if (!cluster) {
            handle.hidden = true;
            return;
        }
        cluster.points.forEach((p) => {
            const logL = Math.log10(p.L);
            p.px = Math.max(rect.x, Math.min(rect.x + rect.w, sx(p.T)));
            p.py = Math.max(rect.y, Math.min(rect.y + rect.h, sy(logL)));
            // On dark paper a light ring would wash out so small a marker's colour; on white, the ring is what shows it
            drawMarker(ctx, SHAPES[regionOf(p.T, p.L)], p.px, p.py, 3.25, { fill: blackBodyCss(p.T), stroke: theme.isDark ? theme.paper : theme.text, width: 0.75 });
        });

        drawTurnOff(ctx, rect, sx, sy, theme, cluster);
        handle.hidden = false;
        handle.setAttribute('aria-valuenow', cluster.turnOffLogL.toFixed(2));
        handle.setAttribute('aria-valuetext', turnOffValueText(cluster, turnOffAge(cluster.turnOffLogL), ageText));
    }

    function drawStudentStars(ctx, rect, sx, sy, theme, placer) {
        const code = current ? current.entity.code : null;
        const stars = studentPoints();
        // With a cluster on show this is about the cluster: other stars are small, hollow and unlabelled, so as not to hide it
        const quiet = !!cluster;
        stars.forEach((p) => {
            p.px = Math.max(rect.x, Math.min(rect.x + rect.w, sx(p.T)));
            p.py = Math.max(rect.y, Math.min(rect.y + rect.h, sy(Math.log10(p.L))));
            if (quiet) return;
            if (p.Terr > 0) {
                const left = Math.max(rect.x, Math.min(rect.x + rect.w, sx(p.T + p.Terr)));
                const right = Math.max(rect.x, Math.min(rect.x + rect.w, sx(Math.max(T_MIN, p.T - p.Terr))));
                drawErrorBar(ctx, left, p.py, right, p.py, theme.strong);
            }
            if (p.Lerr > 0) {
                const low = Math.max(rect.y, Math.min(rect.y + rect.h, sy(Math.log10(Math.max(p.L * 1e-3, p.L - p.Lerr)))));
                const high = Math.max(rect.y, Math.min(rect.y + rect.h, sy(Math.log10(p.L + p.Lerr))));
                drawErrorBar(ctx, p.px, low, p.px, high, theme.strong);
            }
            placer.reserve(p.px, p.py, 6);
        });
        stars.forEach((p) => {
            if (quiet) drawMarker(ctx, SHAPES[regionOf(p.T, p.L)], p.px, p.py, 3, { fill: null, stroke: theme.strong, width: 1 });
            else drawMarker(ctx, SHAPES[regionOf(p.T, p.L)], p.px, p.py, 5, { fill: blackBodyCss(p.T), stroke: theme.strong });
        });
        ctx.font = fontOf(theme, 12, 700);
        stars.forEach((p) => {
            if (quiet) return;
            const spot = placer.place(String(plotted.get(p.code)), p.px, p.py, 6);
            if (spot) haloText(ctx, String(plotted.get(p.code)), spot.x, spot.y, theme, { font: fontOf(theme, 12, 700), colour: theme.strong });
        });

        // A ring round the selected star, wherever it came from
        const selected = [...stars, ...(cluster ? cluster.points : [])].find((p) => p.code === code || p.pairCode === code);
        if (selected) {
            ctx.beginPath();
            ctx.arc(selected.px, selected.py, selected.isMember ? 7 : 9, 0, Math.PI * 2);
            ctx.strokeStyle = theme.accent;
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        return stars;
    }

    function placeOverlays() {
        const { sx, sy, rect, labelBoxes } = view;
        REGIONS.forEach((region) => {
            const button = regionButtons.get(region.id);
            const box = labelBoxes.get(region.id);
            button.style.left = `${box ? box.x + box.w / 2 : sx(region.at[0])}px`;
            button.style.top = `${box ? box.y + box.h / 2 : sy(region.at[1])}px`;
        });
        if (cluster) {
            // On the main sequence where the line crosses it, so dragging slides it up the sequence to the bend
            const grip = turnOffGrip(rect, sx, sy, cluster, msTemperature);
            handle.style.left = `${grip.x}px`;
            handle.style.top = `${grip.y}px`;
        }
    }

    // ---------- Pointer ----------

    function regionAt(pos) {
        if (!view) return null;
        const { rect, polygons, labelBoxes } = view;
        if (pos.x < rect.x || pos.x > rect.x + rect.w || pos.y < rect.y || pos.y > rect.y + rect.h) return null;
        for (const [id, box] of labelBoxes) {
            if (pos.x >= box.x && pos.x <= box.x + box.w && pos.y >= box.y && pos.y <= box.y + box.h) return id;
        }
        // Smaller regions win where they overlap; the list is searched from the main sequence down
        const order = ['upper-ms', 'lower-ms', 'white-dwarfs', 'giants', 'supergiants'];
        return order.find((id) => {
            const polygon = polygons.get(id);
            let inside = false;
            for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                const [xi, yi] = polygon[i];
                const [xj, yj] = polygon[j];
                if ((yi > pos.y) !== (yj > pos.y) && pos.x < ((xj - xi) * (pos.y - yi)) / (yj - yi) + xi) inside = !inside;
            }
            return inside;
        }) || null;
    }

    figure.canvas.addEventListener('pointermove', (event) => {
        if (!view) return;
        const pos = figure.pointerPos(event);
        const point = nearestPoint(view.points, pos);
        if (point) {
            figure.showTip(point.px, point.py, [
                point.code,
                `${sig(point.T, 3)} K, ${sig(point.L, 3)} L☉`,
                REGION_NAMES[regionOf(point.T, point.L)]
            ]);
        } else {
            figure.hideTip();
        }
        const region = point ? null : regionAt(pos);
        figure.canvas.style.cursor = point || region ? 'pointer' : 'default';
        if (region !== hoverRegion) {
            hoverRegion = region;
            figure.redraw();
        }
    });
    figure.canvas.addEventListener('pointerleave', () => {
        figure.hideTip();
        if (hoverRegion) {
            hoverRegion = null;
            figure.redraw();
        }
    });
    figure.canvas.addEventListener('click', (event) => {
        if (!view) return;
        const pos = figure.pointerPos(event);
        const point = nearestPoint(view.points, pos);
        if (point) {
            select(point.code);
            return;
        }
        const region = regionAt(pos);
        if (region) showRegion(activeRegion === region ? null : region, regionButtons.get(region));
    });

    bus.on('measurement', ({ code }) => {
        // A point that has lost a value it needs comes off the diagram
        if (plotted.has(code) && !starPoint(code)) {
            removeStar(code);
            return;
        }
        if (current && current.entity.code === code) card.refresh();
        if (plotted.has(code)) {
            persist();
            refresh();
        }
    });

    return {
        setEntity(resolved) {
            current = resolved;
            refresh();
        },
        onShow() {
            // A measurement made in another tab may have arrived while this was hidden
            figure.redraw();
        }
    };
}
