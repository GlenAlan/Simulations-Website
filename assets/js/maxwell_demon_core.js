// Maxwell's Demon simulation.
//
// A 2D gas in a box divided by a wall with a gate. The starting speeds follow
// a Maxwell-Boltzmann distribution: half the particles come from above its
// median speed (fast, red) and half from below it (slow, blue). Colour always
// shows the current speed against that fixed median, and the demon uses the
// same test, so what you see is what it sorts by. In automatic mode it opens
// the gate only for fast particles moving left -> right and slow particles
// moving right -> left, so the right chamber heats up and the left cools.
//
// Bounces off the walls are elastic and keep each particle's speed, so by
// default (particles pass through each other) every particle keeps its colour
// and the sorting is plain to see. With "Particles collide" on, elastic
// particle-particle collisions share energy out: speeds and colours keep
// changing and each chamber relaxes to its own Maxwell-Boltzmann distribution,
// but the chamber temperatures still drift apart.

// --- DOM Element References ---
const canvas = document.getElementById('simulationCanvas');
const ctx = canvas ? canvas.getContext('2d') : null;

const particleCountSlider = document.getElementById('particleCount');
const countVal = document.getElementById('countVal');
const speedSlider = document.getElementById('speedSlider');
const speedValEl = document.getElementById('speedVal');
const gateSizeSlider = document.getElementById('gateSizeSlider');
const gateSizeValEl = document.getElementById('gateSizeVal');
const demonModeSelector = document.getElementById('demonModeSelector');
const collisionsCheckbox = document.getElementById('particleCollisions');
const showChartsCheckbox = document.getElementById('showCharts');
const chartsContainer = document.getElementById('charts-container');

const leftRedEl = document.getElementById('leftRed');
const leftBlueEl = document.getElementById('leftBlue');
const leftTempEl = document.getElementById('leftTemp');
const rightRedEl = document.getElementById('rightRed');
const rightBlueEl = document.getElementById('rightBlue');
const rightTempEl = document.getElementById('rightTemp');

const resetButton = document.getElementById('resetSimulationBtn');
const fpsDisplay = document.getElementById('fpsDisplay');
const hintEl = document.getElementById('demonHint');
const demonModeNote = document.getElementById('demonModeNote');
const leftLabelEl = document.getElementById('leftLabel');
const rightLabelEl = document.getElementById('rightLabel');

// --- Simulation Constants ---
// The physics runs in a fixed 750 x 375 "world" (matching the 2:1 canvas),
// which is scaled to whatever size the canvas is displayed at. Resizing the
// window or going fullscreen therefore never changes the physics.
const WORLD_WIDTH = 750;
const WORLD_HEIGHT = 375;
const CENTER_X = WORLD_WIDTH / 2;
const radius = 5;

// The particle slider sets the total; half the particles start fast and half slow.
const MAX_PER_COLOR = particleCountSlider ? Math.floor((+particleCountSlider.max || 1000) / 2) : 500;
const MAX_PARTICLES = 2 * MAX_PER_COLOR;

// The speed slider picks one of these (roughly logarithmic) steps.
const SPEED_STOPS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150, 200, 300, 500, 700, 1000];
const MAX_RENDER_DPR = 2; // canvas resolution cap; sharper than this isn't visible but costs fill rate

// Starting temperature: each velocity component is normal with std-dev SIGMA
// (mean speed ~1.5 world units per simulated second).
const SIGMA = 1.2;
const T0 = SIGMA * SIGMA;                                   // mean kinetic energy per particle at the start (m = 1, 2D)
const SPEED_THRESHOLD = SIGMA * Math.sqrt(2 * Math.LN2);    // median speed of the starting gas
const SPEED_THRESHOLD_SQ = SPEED_THRESHOLD * SPEED_THRESHOLD;

const MAX_STEP_DISPLACEMENT = 0.5 * radius; // no particle moves more than this per sub-step (prevents tunnelling)
const MAX_SUBSTEPS_PER_FRAME = 400;
const PHYSICS_BUDGET_MS = 8;                // cap on physics time per frame; the simulation slows rather than stutters
const MAX_FRAME_DT = 0.1;                   // seconds; avoids a huge jump after the tab was in the background
const DEMON_LOOKAHEAD = 2 * radius;         // how far from the wall the demon watches approaching particles
const READOUT_INTERVAL_MS = 200;
const CHART_REDRAW_INTERVAL_MS = 250;
const MAX_CHART_POINTS = 400;
const INITIAL_SAMPLE_INTERVAL = 2;          // simulated seconds between chart samples (doubles as history grows)

// --- Parameters from the controls ---
function speedFromSlider() {
    if (!speedSlider) return 50;
    const index = Math.max(0, Math.min(SPEED_STOPS.length - 1, Math.round(+speedSlider.value)));
    return SPEED_STOPS[index];
}
function perColourFromSlider() {
    return particleCountSlider ? Math.max(1, Math.round(+particleCountSlider.value / 2)) : 100;
}
let nPerColor = perColourFromSlider();
let speedMultiplier = speedFromSlider();
let gateSizePercent = gateSizeSlider ? +gateSizeSlider.value : 25;
let demonMode = demonModeSelector ? demonModeSelector.value : 'automatic';
let particlesCollide = collisionsCheckbox ? collisionsCheckbox.checked : false; // off: every particle keeps its speed and colour

// --- Simulation State (struct of arrays for speed) ---
let particleCount = 0;
const posX = new Float64Array(MAX_PARTICLES);
const posY = new Float64Array(MAX_PARTICLES);
const velX = new Float64Array(MAX_PARTICLES);
const velY = new Float64Array(MAX_PARTICLES);
const side = new Uint8Array(MAX_PARTICLES); // 0 = left chamber, 1 = right chamber

let gateOpen = false;
const heldPointers = new Set(); // manual mode: pointers (mouse / touch / pen) holding the gate open
let spaceHeld = false;          // manual mode: Space held while the canvas has focus
let currentSimulationTime = 0;  // simulated seconds since reset
let maxSpeed = 0;              // fastest particle at the end of the last sub-step

// Uniform grid for collision detection (cell size = particle diameter).
const CELL_SIZE = 2 * radius;
const GRID_COLS = Math.ceil(WORLD_WIDTH / CELL_SIZE);
const GRID_ROWS = Math.ceil(WORLD_HEIGHT / CELL_SIZE);
const CELL_COUNT = GRID_COLS * GRID_ROWS;
const cellStart = new Int32Array(CELL_COUNT + 1);
const cellCursor = new Int32Array(CELL_COUNT);
const cellOfParticle = new Int32Array(MAX_PARTICLES);
const particlesByCell = new Int32Array(MAX_PARTICLES);

// --- Rendering State ---
let viewScale = 1;    // canvas pixels per world unit (the same in x and y)
let viewOffsetX = 0;  // canvas pixels; non-zero only if the canvas isn't exactly 2:1 (the world is centred)
let viewOffsetY = 0;
let renderDpr = 1;    // canvas pixels per CSS pixel
let vertical = false; // chambers stacked (left chamber drawn on top) on tall, narrow screens
let orientationSet = false;
let currentDpr = window.devicePixelRatio || 1;
let palette = null;
let leftTempRatio = 1, rightTempRatio = 1; // latest chamber temperatures relative to the start
let leftTint = 0, rightTint = 0;           // smoothed versions of those, for the chamber shading
let lastTimestamp = null;
let frameCount = 0;
let lastFpsUpdate = 0;
let lastReadoutUpdate = -Infinity;

// --- Charts ---
let leftChart = null, rightChart = null;
const chartData = {
    times: [],
    left: { red: [], blue: [] },
    right: { red: [], blue: [] }
};
let sampleInterval = INITIAL_SAMPLE_INTERVAL;
let nextSampleTime = 0;
let chartsDirty = false;
let lastChartRedraw = -Infinity;

// Scratch object for chamber statistics
const chamberStats = { leftRed: 0, leftBlue: 0, rightRed: 0, rightBlue: 0, leftEnergy: 0, rightEnergy: 0 };

// --- Helpers ---
function gateBounds() {
    const gateSize = (gateSizePercent / 100) * WORLD_HEIGHT;
    const gateTop = WORLD_HEIGHT / 2 - gateSize / 2;
    return [gateTop, gateTop + gateSize];
}

// Sample a speed from the 2D Maxwell-Boltzmann (Rayleigh) distribution
// using the inverse CDF, with u in [0, 1).
function speedFromQuantile(u) {
    return SIGMA * Math.sqrt(-2 * Math.log(1 - u));
}

function computeChamberStats() {
    let lr = 0, lb = 0, rr = 0, rb = 0, le = 0, re = 0;
    for (let i = 0; i < particleCount; i++) {
        const v2 = velX[i] * velX[i] + velY[i] * velY[i];
        const fast = v2 > SPEED_THRESHOLD_SQ;
        if (side[i] === 0) {
            if (fast) lr++; else lb++;
            le += v2;
        } else {
            if (fast) rr++; else rb++;
            re += v2;
        }
    }
    chamberStats.leftRed = lr; chamberStats.leftBlue = lb;
    chamberStats.rightRed = rr; chamberStats.rightBlue = rb;
    chamberStats.leftEnergy = 0.5 * le; chamberStats.rightEnergy = 0.5 * re;
    return chamberStats;
}

// --- Initialisation ---
function initializeSimulationState() {
    const n = Math.max(0, Math.min(MAX_PER_COLOR, nPerColor | 0));
    particleCount = 0;
    cellStart.fill(0);

    // Occupancy grid for overlap-free placement
    const placed = [];
    for (let c = 0; c < CELL_COUNT; c++) placed[c] = null;
    const minSep2 = 4 * radius * radius;

    function tryPlace(chamber) {
        const xMin = chamber === 0 ? radius : CENTER_X + radius;
        const xMax = chamber === 0 ? CENTER_X - radius : WORLD_WIDTH - radius;
        let x = 0, y = 0;
        for (let attempt = 0; attempt < 200; attempt++) {
            x = xMin + Math.random() * (xMax - xMin);
            y = radius + Math.random() * (WORLD_HEIGHT - 2 * radius);
            const gx = Math.min(GRID_COLS - 1, (x / CELL_SIZE) | 0);
            const gy = Math.min(GRID_ROWS - 1, (y / CELL_SIZE) | 0);
            let ok = true;
            for (let oy = -1; oy <= 1 && ok; oy++) {
                for (let ox = -1; ox <= 1 && ok; ox++) {
                    const cx = gx + ox, cy = gy + oy;
                    if (cx < 0 || cy < 0 || cx >= GRID_COLS || cy >= GRID_ROWS) continue;
                    const list = placed[cy * GRID_COLS + cx];
                    if (!list) continue;
                    for (let k = 0; k < list.length; k++) {
                        const j = list[k];
                        const dx = posX[j] - x, dy = posY[j] - y;
                        if (dx * dx + dy * dy < minSep2) { ok = false; break; }
                    }
                }
            }
            if (ok) break; // otherwise keep the last attempt; collisions will separate any overlap
        }
        const cell = Math.min(GRID_ROWS - 1, (y / CELL_SIZE) | 0) * GRID_COLS + Math.min(GRID_COLS - 1, (x / CELL_SIZE) | 0);
        (placed[cell] || (placed[cell] = [])).push(particleCount);
        return [x, y];
    }

    // n fast (red) and n slow (blue) particles: speeds come from the upper and
    // lower halves of the Maxwell-Boltzmann distribution, so together they form
    // a gas at the starting temperature. Each colour is split evenly between
    // the chambers (an odd one out goes left for red and right for blue).
    for (let colour = 0; colour < 2; colour++) {
        for (let k = 0; k < n; k++) {
            const u = Math.random() * 0.5 + (colour === 0 ? 0.5 : 0);
            const speed = speedFromQuantile(Math.min(u, 0.999999));
            const angle = Math.random() * Math.PI * 2;
            const chamber = (k + colour) % 2;
            const [x, y] = tryPlace(chamber);
            posX[particleCount] = x;
            posY[particleCount] = y;
            velX[particleCount] = Math.cos(angle) * speed;
            velY[particleCount] = Math.sin(angle) * speed;
            side[particleCount] = chamber;
            particleCount++;
        }
    }

    maxSpeed = 0;
    for (let i = 0; i < particleCount; i++) {
        const s = Math.hypot(velX[i], velY[i]);
        if (s > maxSpeed) maxSpeed = s;
    }

    currentSimulationTime = 0;
    gateOpen = false;
    observeGate();
    resetChartData();
    updateCountWidths();
    lastReadoutUpdate = -Infinity;
}

// --- Physics ---

// Bin particles into grid cells (counting sort).
function buildGrid() {
    cellStart.fill(0);
    for (let i = 0; i < particleCount; i++) {
        let gx = (posX[i] / CELL_SIZE) | 0;
        let gy = (posY[i] / CELL_SIZE) | 0;
        if (gx < 0) gx = 0; else if (gx >= GRID_COLS) gx = GRID_COLS - 1;
        if (gy < 0) gy = 0; else if (gy >= GRID_ROWS) gy = GRID_ROWS - 1;
        const c = gy * GRID_COLS + gx;
        cellOfParticle[i] = c;
        cellStart[c + 1]++;
    }
    for (let c = 0; c < CELL_COUNT; c++) cellStart[c + 1] += cellStart[c];
    cellCursor.set(cellStart.subarray(0, CELL_COUNT));
    for (let i = 0; i < particleCount; i++) {
        particlesByCell[cellCursor[cellOfParticle[i]]++] = i;
    }
}

// Elastic collisions between equal-mass disks: the components of velocity
// along the line of centres are exchanged, which conserves both momentum and
// kinetic energy exactly. Overlap is removed by moving both disks apart.
const NEIGHBOUR_OFFSETS = [[0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
function resolveCollisions(gateTop, gateBottom) {
    const diameter = 2 * radius;
    const diameterSq = diameter * diameter;
    for (let i = 0; i < particleCount; i++) {
        const c = cellOfParticle[i];
        const gx = c % GRID_COLS;
        const gy = (c - gx) / GRID_COLS;
        for (let k = 0; k < 5; k++) {
            const nx = gx + NEIGHBOUR_OFFSETS[k][0];
            const ny = gy + NEIGHBOUR_OFFSETS[k][1];
            if (nx < 0 || nx >= GRID_COLS || ny >= GRID_ROWS) continue;
            const nc = ny * GRID_COLS + nx;
            const end = cellStart[nc + 1];
            for (let s = cellStart[nc]; s < end; s++) {
                const j = particlesByCell[s];
                if (k === 0 && j <= i) continue;
                let dx = posX[j] - posX[i];
                let dy = posY[j] - posY[i];
                const d2 = dx * dx + dy * dy;
                if (d2 >= diameterSq) continue;
                // Particles on opposite sides of the wall only meet through the open gate
                if (side[i] !== side[j] && !(gateOpen &&
                    posY[i] > gateTop && posY[i] < gateBottom &&
                    posY[j] > gateTop && posY[j] < gateBottom)) continue;
                let d = Math.sqrt(d2);
                if (d < 1e-9) {
                    const a = Math.random() * Math.PI * 2;
                    dx = Math.cos(a); dy = Math.sin(a); d = 0;
                } else {
                    dx /= d; dy /= d;
                }
                const vn = (velX[j] - velX[i]) * dx + (velY[j] - velY[i]) * dy;
                if (vn < 0) {
                    velX[i] += vn * dx; velY[i] += vn * dy;
                    velX[j] -= vn * dx; velY[j] -= vn * dy;
                }
                const push = 0.5 * (diameter - d);
                posX[i] -= push * dx; posY[i] -= push * dy;
                posX[j] += push * dx; posY[j] += push * dy;
            }
        }
    }
}

// Bounce a particle passing through the open gate off the end of the wall at (CENTER_X, tipY).
function deflectFromGateEdge(i, tipY) {
    const dx = posX[i] - CENTER_X;
    const dy = posY[i] - tipY;
    const d2 = dx * dx + dy * dy;
    if (d2 >= radius * radius) return;
    const d = Math.sqrt(d2) || 1e-9;
    const nx = d2 > 0 ? dx / d : 0;
    const ny = d2 > 0 ? dy / d : (tipY < WORLD_HEIGHT / 2 ? 1 : -1);
    const vn = velX[i] * nx + velY[i] * ny;
    if (vn < 0) {
        velX[i] -= 2 * vn * nx;
        velY[i] -= 2 * vn * ny;
    }
    posX[i] = CENTER_X + nx * radius;
    posY[i] = tipY + ny * radius;
}

// Specular reflection from the box walls and the central wall / gate. A
// particle can only change chamber through the open gate, so nothing can
// tunnel through the wall whatever the speed setting.
function enforceBoundaries(gateTop, gateBottom) {
    const minX = radius, maxX = WORLD_WIDTH - radius;
    const minY = radius, maxY = WORLD_HEIGHT - radius;
    const leftLimit = CENTER_X - radius, rightLimit = CENTER_X + radius;
    let vmax2 = 0;
    for (let i = 0; i < particleCount; i++) {
        let x = posX[i], y = posY[i];
        if (x < minX) { x = 2 * minX - x; if (velX[i] < 0) velX[i] = -velX[i]; }
        else if (x > maxX) { x = 2 * maxX - x; if (velX[i] > 0) velX[i] = -velX[i]; }
        if (y < minY) { y = 2 * minY - y; if (velY[i] < 0) velY[i] = -velY[i]; }
        else if (y > maxY) { y = 2 * maxY - y; if (velY[i] > 0) velY[i] = -velY[i]; }
        // Safety clamp (only matters after a very deep overlap correction)
        if (x < minX) x = minX; else if (x > maxX) x = maxX;
        if (y < minY) y = minY; else if (y > maxY) y = maxY;
        posX[i] = x; posY[i] = y;

        const inGate = gateOpen && y > gateTop && y < gateBottom;
        if (side[i] === 0) {
            if (x > leftLimit) {
                if (inGate) {
                    deflectFromGateEdge(i, gateTop);
                    deflectFromGateEdge(i, gateBottom);
                    if (posX[i] >= CENTER_X) side[i] = 1;
                } else {
                    posX[i] = leftLimit;
                    if (velX[i] > 0) velX[i] = -velX[i];
                }
            }
        } else if (x < rightLimit) {
            if (inGate) {
                deflectFromGateEdge(i, gateTop);
                deflectFromGateEdge(i, gateBottom);
                if (posX[i] < CENTER_X) side[i] = 0;
            } else {
                posX[i] = rightLimit;
                if (velX[i] < 0) velX[i] = -velX[i];
            }
        }
        const v2 = velX[i] * velX[i] + velY[i] * velY[i];
        if (v2 > vmax2) vmax2 = v2;
    }
    maxSpeed = Math.sqrt(vmax2);
}

// Set the gate for the next sub-step. In automatic mode the demon looks at the
// particles about to reach the gate: it opens only if at least one of them
// should go through (fast heading right, or slow heading left) and none of
// them should not; it also holds the gate open for a particle still in the
// doorway on its way out.
function manualGateHeld() {
    return heldPointers.size > 0 || spaceHeld;
}

function observeGate() {
    if (demonMode !== 'automatic') {
        gateOpen = manualGateHeld();
        return;
    }
    const [gateTop, gateBottom] = gateBounds();
    let wanted = false, unwanted = false, inDoorway = false;
    for (let i = 0; i < particleCount; i++) {
        const offset = posX[i] - CENTER_X;
        const dist = offset < 0 ? -offset : offset;
        if (dist > DEMON_LOOKAHEAD) continue;
        const vx = velX[i];
        const y = posY[i];
        const approaching = side[i] === 0 ? vx > 0 : vx < 0;
        if (approaching) {
            const yAtWall = y + velY[i] * (dist / (vx < 0 ? -vx : vx));
            const willReachGap = yAtWall > gateTop && yAtWall < gateBottom;
            const inGapNow = dist < radius && y > gateTop && y < gateBottom;
            if (!willReachGap && !inGapNow) continue;
            const fast = vx * vx + velY[i] * velY[i] > SPEED_THRESHOLD_SQ;
            if ((side[i] === 0) === fast) wanted = true; else unwanted = true;
        } else if (dist < radius && y > gateTop && y < gateBottom) {
            inDoorway = true;
        }
    }
    gateOpen = !unwanted && (wanted || inDoorway);
}

function runSinglePhysicsStep(dt) {
    const [gateTop, gateBottom] = gateBounds();
    for (let i = 0; i < particleCount; i++) {
        posX[i] += velX[i] * dt;
        posY[i] += velY[i] * dt;
    }
    if (particlesCollide) {
        buildGrid();
        resolveCollisions(gateTop, gateBottom);
    }
    enforceBoundaries(gateTop, gateBottom);
    currentSimulationTime += dt;
    observeGate();

    while (currentSimulationTime >= nextSampleTime) {
        recordChartSample(nextSampleTime);
        nextSampleTime += sampleInterval;
    }
}

// Advance the simulation by simDt simulated seconds using sub-steps small
// enough that no particle moves more than MAX_STEP_DISPLACEMENT per step.
function advanceSimulation(simDt) {
    const start = performance.now();
    let remaining = simDt;
    let steps = 0;
    while (remaining > 1e-12 && steps < MAX_SUBSTEPS_PER_FRAME) {
        // Allow for speeds rising during a collision (at most sqrt(2) x for equal masses)
        const h = Math.min(remaining, MAX_STEP_DISPLACEMENT / Math.max(1.5 * maxSpeed, 1e-6));
        runSinglePhysicsStep(h);
        remaining -= h;
        steps++;
        if ((steps & 7) === 0 && performance.now() - start > PHYSICS_BUDGET_MS) break;
    }
    // Any time left over is dropped: at extreme settings the simulation runs
    // slower than requested instead of taking unstable steps.
}

// --- Charts ---
function resetChartData() {
    chartData.times = [];
    chartData.left.red = []; chartData.left.blue = [];
    chartData.right.red = []; chartData.right.blue = [];
    sampleInterval = INITIAL_SAMPLE_INTERVAL;
    nextSampleTime = 0;
    chartsDirty = true;
    lastChartRedraw = -Infinity;
}

function recordChartSample(time) {
    const s = computeChamberStats();
    chartData.times.push(time);
    chartData.left.red.push(s.leftRed);
    chartData.left.blue.push(s.leftBlue);
    chartData.right.red.push(s.rightRed);
    chartData.right.blue.push(s.rightBlue);
    if (chartData.times.length > MAX_CHART_POINTS) {
        // Keep the whole history at half the resolution so memory and drawing
        // cost stay bounded however long the simulation runs.
        const keepEven = (_, idx) => idx % 2 === 0;
        chartData.times = chartData.times.filter(keepEven);
        chartData.left.red = chartData.left.red.filter(keepEven);
        chartData.left.blue = chartData.left.blue.filter(keepEven);
        chartData.right.red = chartData.right.red.filter(keepEven);
        chartData.right.blue = chartData.right.blue.filter(keepEven);
        sampleInterval *= 2;
        nextSampleTime = chartData.times[chartData.times.length - 1];
    }
    chartsDirty = true;
}

function chartsVisible() {
    return !!(showChartsCheckbox && showChartsCheckbox.checked && leftChart && rightChart);
}

function redrawCharts(now) {
    if (!chartsVisible() || !chartsDirty) return;
    if (now !== undefined && now - lastChartRedraw < CHART_REDRAW_INTERVAL_MS) return;
    lastChartRedraw = now === undefined ? performance.now() : now;
    chartsDirty = false;
    const xMax = Math.max(10, currentSimulationTime);
    // Both charts share a y range so the two chambers can be compared at a glance
    let yMax = 1;
    for (const series of [chartData.left.red, chartData.left.blue, chartData.right.red, chartData.right.blue]) {
        for (let i = 0; i < series.length; i++) if (series[i] > yMax) yMax = series[i];
    }
    const sets = [[leftChart, chartData.left], [rightChart, chartData.right]];
    for (const [chart, data] of sets) {
        chart.options.scales.x.max = xMax;
        chart.options.scales.y.suggestedMax = yMax;
        chart.data.labels = chartData.times;
        chart.data.datasets[0].data = data.red;
        chart.data.datasets[1].data = data.blue;
        chart.update('none');
    }
}

function readThemeColour(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

function updateChartColors() {
    if (!palette) refreshPalette();
    const textColor = readThemeColour('--color-text', '#888');
    const gridColor = readThemeColour('--color-border', 'rgba(128,128,128,0.3)');
    [leftChart, rightChart].forEach(chart => {
        if (!chart) return;
        const { x, y } = chart.options.scales;
        x.title.color = textColor; x.ticks.color = textColor; x.grid.color = gridColor;
        y.title.color = textColor; y.ticks.color = textColor; y.grid.color = gridColor;
        chart.options.plugins.title.color = textColor;
        chart.options.plugins.legend.labels.color = textColor;
        const [fastSet, slowSet] = chart.data.datasets;
        fastSet.borderColor = fastSet.backgroundColor = palette.red;
        slowSet.borderColor = slowSet.backgroundColor = palette.blue;
        chart.update('none');
    });
}

function setupCharts() {
    const leftChartCanvas = document.getElementById('leftChart');
    const rightChartCanvas = document.getElementById('rightChart');
    if (!leftChartCanvas || !rightChartCanvas) return;
    if (typeof Chart === 'undefined') {
        // Chart.js failed to load (e.g. offline): hide the chart toggle rather than break the simulation
        const toggle = showChartsCheckbox ? showChartsCheckbox.closest('label') : null;
        if (toggle) toggle.style.display = 'none';
        return;
    }

    const chartOptions = (titleText) => ({
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        normalized: true,
        // Short boxes (fullscreen on a small screen): drop the legend and axis titles so the
        // plot keeps some height. The info bar shows the colour key anyway.
        onResize: (chart, size) => {
            chart.options.plugins.legend.display = size.height >= 170;
            chart.options.scales.x.title.display = size.height >= 150;
            chart.options.scales.y.title.display = size.height >= 150;
        },
        elements: { point: { radius: 0, hitRadius: 4 }, line: { borderWidth: 2, tension: 0 } },
        interaction: { mode: 'index', intersect: false },
        plugins: {
            title: { display: true, text: titleText, padding: { top: 2, bottom: 4 } },
            legend: { labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'circle' } },
            tooltip: {
                callbacks: { title: (items) => items.length ? `t = ${Number(items[0].label).toFixed(0)} s` : '' }
            }
        },
        scales: {
            x: {
                type: 'linear',
                min: 0,
                max: 10,
                title: { display: true, text: 'Simulated time (s)' },
                ticks: { maxTicksLimit: 6, includeBounds: false, callback: (value) => Number(value).toFixed(0) },
                grid: {}
            },
            y: {
                beginAtZero: true,
                title: { display: true, text: 'Particles' },
                ticks: { precision: 0 },
                grid: {}
            }
        }
    });

    const dataset = (label, color) => ({ label, data: [], borderColor: color, backgroundColor: color, fill: false });
    const makeChart = (el, title) => new Chart(el, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                dataset('Fast', palette.red),
                dataset('Slow', palette.blue)
            ]
        },
        options: chartOptions(title)
    });

    if (leftChart) leftChart.destroy();
    if (rightChart) rightChart.destroy();
    leftChart = makeChart(leftChartCanvas, 'Left chamber');
    rightChart = makeChart(rightChartCanvas, 'Right chamber');
    updateChartColors();
    chartsDirty = true;
}

function applyChartsVisibility(userToggled) {
    if (!showChartsCheckbox || !chartsContainer) return;
    const visible = showChartsCheckbox.checked;
    chartsContainer.style.display = visible ? 'block' : 'none';
    document.body.classList.toggle('charts-visible', visible);
    if (visible && leftChart && rightChart) {
        leftChart.resize();
        rightChart.resize();
        chartsDirty = true;
        redrawCharts();
    }
    // With a big canvas the charts open below the fold: bring them into view so the
    // button visibly does something (fullscreen makes room for them itself).
    if (visible && userToggled === true && !document.body.classList.contains('sim-fullscreen-active')) {
        requestAnimationFrame(() => {
            const rect = chartsContainer.getBoundingClientRect();
            if (rect.bottom > window.innerHeight) {
                chartsContainer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        });
    }
}

// --- Rendering ---
function refreshPalette() {
    const dark = document.documentElement.classList.contains('dark-mode');
    palette = {
        dark,
        wall: dark ? '#7a7a7a' : '#5a5a5a',
        gate: dark ? '#b98cff' : '#7b2fbf',
        demonFace: dark ? '#1e1e1e' : '#ffffff',
        halo: readThemeColour('--color-bg', dark ? '#1e1e1e' : '#ffffff'),
        red: readThemeColour('--mx-fast', dark ? '#ff4646' : '#e0242b'),
        blue: readThemeColour('--mx-slow', dark ? '#3f8cff' : '#1f62d6')
    };
}

// Temperature relative to the start, always at most 4 characters wide.
function formatTemperature(energy, count) {
    if (!(count > 0)) return '–';
    const t = energy / count / T0;
    if (t < 9.995) return t.toFixed(2);
    if (t < 99.95) return t.toFixed(1);
    return String(Math.min(9999, Math.round(t)));
}

function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
}

// Reserve room for the largest count possible with the current number of particles,
// so the readouts keep their width while the counts change.
function updateCountWidths() {
    const chars = String(particleCount).length;
    [leftRedEl, leftBlueEl, rightRedEl, rightBlueEl].forEach(el => {
        if (el) el.style.setProperty('--chars', chars);
    });
}

function updateReadouts() {
    const s = computeChamberStats();
    const leftCount = s.leftRed + s.leftBlue, rightCount = s.rightRed + s.rightBlue;
    leftTempRatio = leftCount > 0 ? s.leftEnergy / leftCount / T0 : 1;
    rightTempRatio = rightCount > 0 ? s.rightEnergy / rightCount / T0 : 1;
    setText(leftRedEl, String(s.leftRed));
    setText(leftBlueEl, String(s.leftBlue));
    setText(rightRedEl, String(s.rightRed));
    setText(rightBlueEl, String(s.rightBlue));
    setText(leftTempEl, formatTemperature(s.leftEnergy, leftCount));
    setText(rightTempEl, formatTemperature(s.rightEnergy, rightCount));
}

// Faint red / blue shading of a chamber that is hotter / colder than at the start.
// `chamber` is 0 (left / top) or 1 (right / bottom).
function drawChamberTint(chamber, tint) {
    const strength = Math.min(0.1, Math.abs(tint - 1) * 0.25);
    if (strength < 0.01) return;
    const half = CENTER_X * viewScale, across = WORLD_HEIGHT * viewScale;
    ctx.globalAlpha = strength;
    ctx.fillStyle = tint > 1 ? palette.red : palette.blue;
    if (vertical) ctx.fillRect(viewOffsetX, viewOffsetY + chamber * half, across, half);
    else ctx.fillRect(viewOffsetX + chamber * half, viewOffsetY, half, across);
    ctx.globalAlpha = 1;
}

// The demon: a small horned face sitting on the wall just before the gate (above it, or
// to its left when the chambers are stacked). Sizes are in CSS pixels so it stays
// readable on a phone without growing huge on a big screen.
function drawDemon(wallPos, gateStart, alongMin, cssSize) {
    const k = renderDpr;
    const r = Math.max(8, Math.min(18, cssSize * 0.034)) * k;
    const along = Math.max(gateStart - r - 5 * k, alongMin + 1.5 * r);
    const awake = demonMode === 'automatic';

    ctx.save();
    if (vertical) ctx.translate(along, wallPos); else ctx.translate(wallPos, along);
    // Head and horns, with a thin halo in the background colour so the demon
    // stands out from particles passing behind it
    const parts = [new Path2D(), new Path2D(), new Path2D()]; // filled separately so overlaps never cancel out
    for (const side of [-1, 1]) {
        const horn = parts[side < 0 ? 0 : 1];
        horn.moveTo(side * 0.78 * r, -0.4 * r);
        horn.lineTo(side * 0.92 * r, -1.38 * r);
        horn.lineTo(side * 0.22 * r, -0.86 * r);
        horn.closePath();
    }
    parts[2].arc(0, 0, r, 0, Math.PI * 2);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3 * k;
    ctx.strokeStyle = palette.halo;
    parts.forEach(p => ctx.stroke(p));
    ctx.fillStyle = palette.gate;
    parts.forEach(p => ctx.fill(p));
    // Eyes: open while it is sorting, shut in manual mode (you are the demon then)
    ctx.fillStyle = ctx.strokeStyle = palette.demonFace;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, 0.14 * r);
    if (awake) {
        ctx.beginPath();
        ctx.arc(-0.36 * r, -0.12 * r, 0.17 * r, 0, Math.PI * 2);
        ctx.arc(0.36 * r, -0.12 * r, 0.17 * r, 0, Math.PI * 2);
        ctx.fill();
    } else {
        ctx.beginPath();
        ctx.moveTo(-0.52 * r, -0.1 * r); ctx.lineTo(-0.2 * r, -0.1 * r);
        ctx.moveTo(0.2 * r, -0.1 * r); ctx.lineTo(0.52 * r, -0.1 * r);
        ctx.stroke();
    }
    // Grin
    ctx.beginPath();
    ctx.arc(0, 0.08 * r, 0.48 * r, 0.18 * Math.PI, 0.82 * Math.PI);
    ctx.stroke();
    ctx.restore();
}

// Draws the world either as is (left / right chambers) or transposed (world x runs
// down the screen, so the left chamber is on top) for tall screens. Below, "along"
// is the screen coordinate along the dividing wall and "across" the one through it.
function renderSimulation() {
    if (!ctx) return;
    if (!palette) refreshPalette();
    const [gateTop, gateBottom] = gateBounds();
    const s = viewScale, ox = viewOffsetX, oy = viewOffsetY;
    const k = renderDpr;
    const cssSize = Math.min(canvas.width, canvas.height) / k;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Chambers shaded by how much hotter / colder they are than at the start
    leftTint += (leftTempRatio - leftTint) * 0.08;
    rightTint += (rightTempRatio - rightTint) * 0.08;
    drawChamberTint(0, leftTint);
    drawChamberTint(1, rightTint);

    // Particles, in world units. One path per colour keeps this cheap even with 1000 particles.
    if (vertical) ctx.setTransform(0, s, s, 0, ox, oy); else ctx.setTransform(s, 0, 0, s, ox, oy);
    const redPath = new Path2D();
    const bluePath = new Path2D();
    const twoPi = Math.PI * 2;
    for (let i = 0; i < particleCount; i++) {
        const x = posX[i], y = posY[i];
        const path = (velX[i] * velX[i] + velY[i] * velY[i] > SPEED_THRESHOLD_SQ) ? redPath : bluePath;
        path.moveTo(x + radius, y);
        path.arc(x, y, radius, 0, twoPi);
    }
    ctx.fillStyle = palette.red;
    ctx.fill(redPath);
    ctx.fillStyle = palette.blue;
    ctx.fill(bluePath);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Wall and gate, with line widths in CSS pixels
    const wallWidth = (cssSize > 500 ? 3 : 2) * k;
    const acrossOrigin = vertical ? oy : ox, alongOrigin = vertical ? ox : oy;
    const wallPos = Math.round(acrossOrigin + CENTER_X * s) + ((Math.round(wallWidth) % 2) ? 0.5 : 0);
    const wallStart = alongOrigin, wallEnd = alongOrigin + WORLD_HEIGHT * s;
    const gateStart = alongOrigin + gateTop * s, gateEnd = alongOrigin + gateBottom * s;
    const segment = (path, a0, a1, c0, c1) => {
        if (vertical) { path.moveTo(a0, c0); path.lineTo(a1, c1); }
        else { path.moveTo(c0, a0); path.lineTo(c1, a1); }
    };

    ctx.lineCap = 'butt';
    ctx.lineWidth = wallWidth;
    ctx.strokeStyle = palette.wall;
    const wall = new Path2D();
    segment(wall, wallStart, gateStart, wallPos, wallPos);
    segment(wall, gateEnd, wallEnd, wallPos, wallPos);
    ctx.stroke(wall);

    // Door frame: short ticks at both ends of the gap, so the doorway is visible when open
    const tick = 5 * k;
    const frame = new Path2D();
    segment(frame, gateStart, gateStart, wallPos - tick, wallPos + tick);
    segment(frame, gateEnd, gateEnd, wallPos - tick, wallPos + tick);
    ctx.strokeStyle = palette.gate;
    ctx.stroke(frame);

    const door = new Path2D();
    segment(door, gateStart, gateEnd, wallPos, wallPos);
    if (gateOpen) {
        // Open: a faint dashed line marks the doorway
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = Math.max(1, k);
        ctx.setLineDash([3 * k, 4 * k]);
        ctx.stroke(door);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
    } else {
        // Closed: a solid bar, thicker than the wall, with a thin halo to separate it from particles
        ctx.lineWidth = wallWidth + 4 * k;
        ctx.strokeStyle = palette.halo;
        ctx.stroke(door);
        ctx.lineWidth = wallWidth + 2 * k;
        ctx.strokeStyle = palette.gate;
        ctx.stroke(door);
    }

    drawDemon(wallPos, gateStart, wallStart, cssSize);

    // If the canvas isn't exactly the world's shape, outline the world
    if (ox > 1 || oy > 1) {
        const w = (vertical ? WORLD_HEIGHT : WORLD_WIDTH) * s, h = (vertical ? WORLD_WIDTH : WORLD_HEIGHT) * s;
        ctx.lineWidth = k;
        ctx.strokeStyle = palette.wall;
        ctx.strokeRect(ox + 0.5, oy + 0.5, w - 1, h - 1);
    }
}

// --- Main Animation Loop ---
function animate(timestamp) {
    requestAnimationFrame(animate);
    if (!ctx) return;

    let elapsed = lastTimestamp === null ? 0 : (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;
    if (!(elapsed > 0)) elapsed = 0;
    else if (elapsed > MAX_FRAME_DT) elapsed = MAX_FRAME_DT;

    frameCount++;
    if (timestamp - lastFpsUpdate >= 1000) {
        const fps = frameCount * 1000 / (timestamp - lastFpsUpdate);
        if (fpsDisplay) fpsDisplay.textContent = `FPS: ${fps.toFixed(0)}`;
        frameCount = 0;
        lastFpsUpdate = timestamp;
    }

    if ((window.devicePixelRatio || 1) !== currentDpr) handleSimulationResize();

    if (demonMode !== 'automatic') gateOpen = manualGateHeld();
    advanceSimulation(elapsed * speedMultiplier);
    renderSimulation();

    if (timestamp - lastReadoutUpdate >= READOUT_INTERVAL_MS) {
        updateReadouts();
        lastReadoutUpdate = timestamp;
    }
    redrawCharts(timestamp);
}

// --- Sizing ---
// The page layout (simulation_styles.css) sizes the 2:1 canvas box, in normal and
// fullscreen mode; here the drawing buffer is matched to the canvas's displayed size.
function handleSimulationResize() {
    if (!canvas || !ctx) return;
    applyOrientation();
    currentDpr = window.devicePixelRatio || 1;
    renderDpr = Math.min(currentDpr, MAX_RENDER_DPR);
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    const pixelWidth = Math.max(1, Math.round(rect.width * renderDpr));
    const pixelHeight = Math.max(1, Math.round(rect.height * renderDpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    // One scale for both axes; if the box isn't exactly the world's shape the world is centred in it.
    const worldW = vertical ? WORLD_HEIGHT : WORLD_WIDTH, worldH = vertical ? WORLD_WIDTH : WORLD_HEIGHT;
    viewScale = Math.min(pixelWidth / worldW, pixelHeight / worldH);
    viewOffsetX = (pixelWidth - worldW * viewScale) / 2;
    viewOffsetY = (pixelHeight - worldH * viewScale) / 2;
    renderSimulation();
}

// Phones held upright: a 2:1 box would use a thin strip of the screen, so the page gives
// the box --aspect-ratio-portrait: 1/2 there (applied by simulation_styles.css) and the
// chambers are stacked: the same world drawn transposed, left chamber on top.
function wantsVertical() {
    const box = canvas.parentElement; // .sim-aspect-ratio-box
    if (!box) return false;
    const parts = getComputedStyle(box).getPropertyValue('--aspect-ratio').split('/').map(Number);
    return parts.length === 2 && parts[0] > 0 && parts[1] > parts[0];
}

function chamberNames() {
    return vertical ? ['Top', 'Bottom'] : ['Left', 'Right'];
}

function demonNoteText() {
    if (demonMode === 'manual') return 'You are the demon: press and hold on the simulation (or hold Space) to open the gate.';
    return vertical
        ? 'Lets fast particles through to the bottom and slow ones to the top.'
        : 'Lets fast particles through to the right and slow ones to the left.';
}

function applyOrientation() {
    const v = wantsVertical();
    if (orientationSet && v === vertical) return;
    vertical = v;
    orientationSet = true;
    const [first, second] = chamberNames();
    setText(leftLabelEl, first);
    setText(rightLabelEl, second);
    [[leftLabelEl, first], [rightLabelEl, second]].forEach(([el, name]) => {
        const boxEl = el ? el.closest('.stats-box') : null;
        if (boxEl) boxEl.title = `${name} chamber: number of fast and slow particles, and temperature relative to the start`;
    });
    setText(demonModeNote, demonNoteText());
    [[leftChart, first], [rightChart, second]].forEach(([chart, name]) => {
        if (!chart) return;
        chart.options.plugins.title.text = `${name} chamber`;
        chart.canvas.setAttribute('aria-label', `Chart: fast and slow particles in the ${name.toLowerCase()} chamber over time`);
        chart.update('none');
    });
}

function fullResetAndRestart() {
    initializeSimulationState();
    updateReadouts();
    lastReadoutUpdate = performance.now();
    redrawCharts();
    renderSimulation();
}

// --- Hints over the canvas ---
const HINT_MANUAL = 'Press and hold to open the gate';
const HINT_AUTOMATIC = 'The demon is in charge. Choose Manual in the settings to work the gate yourself.';
let hintTimer = null;
let manualHintDismissed = false;

function showHint(text, durationMs) {
    if (!hintEl) return;
    clearTimeout(hintTimer);
    setText(hintEl, text);
    hintEl.classList.add('is-visible');
    if (durationMs) hintTimer = setTimeout(hideHint, durationMs);
}

function hideHint() {
    clearTimeout(hintTimer);
    if (hintEl) hintEl.classList.remove('is-visible');
}

// --- Event Listeners & Initialisation ---
document.addEventListener('DOMContentLoaded', () => {
    if (!canvas || !ctx) {
        console.error("Canvas or context not found. Maxwell's Demon simulation cannot start.");
        return;
    }

    refreshPalette();
    setupCharts();
    initializeSimulationState();
    handleSimulationResize();
    updateReadouts();

    if (particleCountSlider) {
        const showCount = () => {
            setText(countVal, String(2 * nPerColor));
            particleCountSlider.setAttribute('aria-valuetext', `${2 * nPerColor} particles`);
        };
        particleCountSlider.addEventListener('input', () => {
            nPerColor = perColourFromSlider();
            showCount();
            fullResetAndRestart();
        });
        showCount();
    }

    if (speedSlider) {
        const showSpeed = () => {
            setText(speedValEl, String(speedMultiplier));
            speedSlider.setAttribute('aria-valuetext', `${speedMultiplier} times`);
        };
        speedSlider.addEventListener('input', () => {
            speedMultiplier = speedFromSlider();
            showSpeed();
        });
        showSpeed();
    }

    if (gateSizeSlider) {
        gateSizeSlider.addEventListener('input', () => {
            gateSizePercent = +gateSizeSlider.value;
            setText(gateSizeValEl, String(gateSizePercent));
            renderSimulation();
        });
        setText(gateSizeValEl, String(gateSizePercent));
    }

    const applyDemonMode = (userChanged) => {
        demonMode = demonModeSelector ? demonModeSelector.value : 'automatic';
        const manual = demonMode === 'manual';
        canvas.classList.toggle('mx-manual', manual);
        heldPointers.clear();
        spaceHeld = false;
        setText(demonModeNote, demonNoteText());
        if (manual) {
            manualHintDismissed = false;
            showHint(HINT_MANUAL);
        } else if (userChanged === true) {
            hideHint();
        }
        observeGate();
        renderSimulation();
    };
    if (demonModeSelector) demonModeSelector.addEventListener('change', () => applyDemonMode(true));
    applyDemonMode(false);

    // Collisions can be switched mid-run: the gas carries on from where it is
    if (collisionsCheckbox) {
        collisionsCheckbox.addEventListener('change', () => {
            particlesCollide = collisionsCheckbox.checked;
        });
    }

    if (showChartsCheckbox && chartsContainer) {
        showChartsCheckbox.addEventListener('change', () => applyChartsVisibility(true));
        applyChartsVisibility(false);
    }

    if (resetButton) resetButton.addEventListener('click', fullResetAndRestart);

    // Manual mode: press and hold (mouse, pen or touch) on the canvas to open the gate.
    // In automatic mode the canvas doesn't capture touches (the page scrolls over it);
    // a tap there explains how to take over.
    const releasePointer = (e) => {
        heldPointers.delete(e.pointerId);
        if (demonMode === 'manual') observeGate();
    };
    canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (demonMode !== 'manual') return;
        e.preventDefault(); // no text selection or focus-scroll from the press
        heldPointers.add(e.pointerId);
        observeGate();
        if (!manualHintDismissed) {
            manualHintDismissed = true;
            hideHint();
        }
    });
    canvas.addEventListener('pointerup', (e) => {
        if (demonMode === 'manual') {
            releasePointer(e);
        } else if (!(e.pointerType === 'mouse' && e.button !== 0)) {
            showHint(HINT_AUTOMATIC, 3500);
        }
    });
    canvas.addEventListener('pointercancel', releasePointer);
    canvas.addEventListener('pointerleave', releasePointer);
    window.addEventListener('blur', () => { heldPointers.clear(); spaceHeld = false; });
    canvas.addEventListener('contextmenu', (e) => { if (demonMode === 'manual') e.preventDefault(); });

    // Keyboard: with the canvas focused, hold Space to open the gate in manual mode
    canvas.addEventListener('keydown', (e) => {
        if (e.key !== ' ' && e.code !== 'Space') return;
        e.preventDefault(); // don't scroll the page
        if (e.repeat) return;
        if (demonMode === 'manual') {
            spaceHeld = true;
            observeGate();
            if (!manualHintDismissed) { manualHintDismissed = true; hideHint(); }
        } else {
            showHint(HINT_AUTOMATIC, 3500);
        }
    });
    canvas.addEventListener('keyup', (e) => {
        if (e.key === ' ' || e.code === 'Space') { spaceHeld = false; observeGate(); }
    });
    canvas.addEventListener('blur', () => { spaceHeld = false; });

    // Resize: window resizes, fullscreen / panel changes (simulation_ui.js) and layout shifts
    window.addEventListener('resize', handleSimulationResize);
    if (typeof ResizeObserver !== 'undefined') {
        const resizeObserver = new ResizeObserver(() => handleSimulationResize());
        resizeObserver.observe(canvas);
        if (canvas.parentElement && canvas.parentElement.parentElement) {
            resizeObserver.observe(canvas.parentElement.parentElement); // .sim-canvas-wrapper
        }
    }

    // Theme changes (main.js toggles dark-mode / light-mode on <html>)
    new MutationObserver(() => {
        refreshPalette();
        updateChartColors();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    lastFpsUpdate = performance.now();
    requestAnimationFrame(animate);
});
