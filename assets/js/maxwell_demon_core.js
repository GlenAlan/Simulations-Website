// Maxwell's Demon simulation.
//
// A 2D hard-disk gas in a box divided by a wall with a gate. All collisions
// (particle-particle and particle-wall) are elastic, so total kinetic energy is
// conserved and the speeds settle into a Maxwell-Boltzmann distribution.
// Colour shows speed: red particles are faster than the median speed of the
// starting gas, blue ones slower, so a particle changes colour when a
// collision speeds it up or slows it down. In automatic mode the demon opens
// the gate only for fast particles moving left -> right and slow particles
// moving right -> left, so the right chamber heats up and the left cools.

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

// --- Simulation Constants ---
// The physics runs in a fixed 750 x 375 "world" (matching the 2:1 canvas),
// which is scaled to whatever size the canvas is displayed at. Resizing the
// window or going fullscreen therefore never changes the physics.
const WORLD_WIDTH = 750;
const WORLD_HEIGHT = 375;
const CENTER_X = WORLD_WIDTH / 2;
const radius = 5;

const MAX_PER_COLOR = particleCountSlider ? +particleCountSlider.max || 500 : 500;
const MAX_PARTICLES = 2 * MAX_PER_COLOR;

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
let nPerColor = particleCountSlider ? +particleCountSlider.value : 100;
let speedMultiplier = speedSlider ? +speedSlider.value : 50;
let gateSizePercent = gateSizeSlider ? +gateSizeSlider.value : 25;
let demonMode = demonModeSelector ? demonModeSelector.value : 'automatic';

// --- Simulation State (struct of arrays for speed) ---
let particleCount = 0;
const posX = new Float64Array(MAX_PARTICLES);
const posY = new Float64Array(MAX_PARTICLES);
const velX = new Float64Array(MAX_PARTICLES);
const velY = new Float64Array(MAX_PARTICLES);
const side = new Uint8Array(MAX_PARTICLES); // 0 = left chamber, 1 = right chamber

let gateOpen = false;
let pointerHeld = false;       // manual mode: gate is held open by mouse / touch
let currentSimulationTime = 0; // simulated seconds since reset
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
let canvasScaleX = 1; // device pixels per world unit
let canvasScaleY = 1;
let currentDpr = window.devicePixelRatio || 1;
let palette = null;
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
function observeGate() {
    if (demonMode !== 'automatic') {
        gateOpen = pointerHeld;
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
    buildGrid();
    resolveCollisions(gateTop, gateBottom);
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
    const sets = [[leftChart, chartData.left], [rightChart, chartData.right]];
    for (const [chart, data] of sets) {
        chart.options.scales.x.max = xMax;
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
    const textColor = readThemeColour('--color-text', '#888');
    const gridColor = readThemeColour('--color-border', 'rgba(128,128,128,0.3)');
    [leftChart, rightChart].forEach(chart => {
        if (!chart) return;
        const { x, y } = chart.options.scales;
        x.title.color = textColor; x.ticks.color = textColor; x.grid.color = gridColor;
        y.title.color = textColor; y.ticks.color = textColor; y.grid.color = gridColor;
        chart.options.plugins.title.color = textColor;
        chart.options.plugins.legend.labels.color = textColor;
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
        elements: { point: { radius: 0, hitRadius: 4 }, line: { borderWidth: 2, tension: 0 } },
        interaction: { mode: 'index', intersect: false },
        plugins: {
            title: { display: true, text: titleText },
            legend: { labels: { boxWidth: 12 } },
            tooltip: {
                callbacks: { title: (items) => items.length ? `t = ${Number(items[0].label).toFixed(0)} s` : '' }
            }
        },
        scales: {
            x: {
                type: 'linear',
                min: 0,
                max: 10,
                title: { display: true, text: 'Simulation Time (s)' },
                ticks: { maxTicksLimit: 6, callback: (value) => Number(value).toFixed(0) },
                grid: {}
            },
            y: {
                beginAtZero: true,
                title: { display: true, text: 'Particle Count' },
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
                dataset('Red (fast)', 'rgba(255, 0, 0, 0.85)'),
                dataset('Blue (slow)', 'rgba(0, 100, 255, 0.85)')
            ]
        },
        options: chartOptions(title)
    });

    if (leftChart) leftChart.destroy();
    if (rightChart) rightChart.destroy();
    leftChart = makeChart(leftChartCanvas, 'Left Chamber');
    rightChart = makeChart(rightChartCanvas, 'Right Chamber');
    updateChartColors();
    chartsDirty = true;
}

function applyChartsVisibility() {
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
}

// --- Rendering ---
function refreshPalette() {
    const dark = document.documentElement.classList.contains('dark-mode');
    palette = {
        wall: dark ? '#6b6b6b' : '#444444',
        gate: dark ? '#c47cff' : '#800080',
        red: 'rgba(255, 0, 0, 0.85)',
        blue: 'rgba(0, 100, 255, 0.85)'
    };
}

function formatTemperature(energy, count) {
    return count > 0 ? (energy / count / T0).toFixed(2) : '–';
}

function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
}

function updateReadouts() {
    const s = computeChamberStats();
    setText(leftRedEl, String(s.leftRed));
    setText(leftBlueEl, String(s.leftBlue));
    setText(rightRedEl, String(s.rightRed));
    setText(rightBlueEl, String(s.rightBlue));
    setText(leftTempEl, formatTemperature(s.leftEnergy, s.leftRed + s.leftBlue));
    setText(rightTempEl, formatTemperature(s.rightEnergy, s.rightRed + s.rightBlue));
}

function renderSimulation() {
    if (!ctx) return;
    if (!palette) refreshPalette();
    const [gateTop, gateBottom] = gateBounds();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(canvasScaleX, 0, 0, canvasScaleY, 0, 0);

    // Central wall with the gap for the gate
    ctx.lineWidth = 2;
    ctx.strokeStyle = palette.wall;
    ctx.beginPath();
    ctx.moveTo(CENTER_X, 0);
    ctx.lineTo(CENTER_X, gateTop);
    ctx.moveTo(CENTER_X, gateBottom);
    ctx.lineTo(CENTER_X, WORLD_HEIGHT);
    ctx.stroke();

    if (!gateOpen) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = palette.gate;
        ctx.beginPath();
        ctx.moveTo(CENTER_X, gateTop);
        ctx.lineTo(CENTER_X, gateBottom);
        ctx.stroke();
    }

    // One path per colour keeps this cheap even with 1000 particles
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

    if (demonMode !== 'automatic') gateOpen = pointerHeld;
    advanceSimulation(elapsed * speedMultiplier);
    renderSimulation();

    if (timestamp - lastReadoutUpdate >= READOUT_INTERVAL_MS) {
        updateReadouts();
        lastReadoutUpdate = timestamp;
    }
    redrawCharts(timestamp);
}

// --- Sizing ---
function handleSimulationResize() {
    if (!canvas || !ctx) return;
    const aspectRatioBox = canvas.parentElement; // .sim-aspect-ratio-box
    if (!aspectRatioBox) return;

    if (document.body.classList.contains('sim-fullscreen-active')) {
        // Fit the largest 2:1 box into the space the fullscreen layout gives the canvas wrapper
        const canvasWrapper = aspectRatioBox.parentElement;
        if (!canvasWrapper) return;
        const availableWidth = canvasWrapper.clientWidth;
        const availableHeight = canvasWrapper.clientHeight;
        if (availableWidth > 0 && availableHeight > 0) {
            const aspect = WORLD_WIDTH / WORLD_HEIGHT;
            let targetWidth = availableWidth, targetHeight = availableWidth / aspect;
            if (targetHeight > availableHeight) {
                targetHeight = availableHeight;
                targetWidth = availableHeight * aspect;
            }
            aspectRatioBox.style.width = `${Math.floor(targetWidth)}px`;
            aspectRatioBox.style.height = `${Math.floor(targetHeight)}px`;
        }
    } else {
        // Let the CSS aspect-ratio box size itself
        aspectRatioBox.style.width = '';
        aspectRatioBox.style.height = '';
    }

    // Match the backing store to the canvas's displayed size for crisp high-DPI rendering
    currentDpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;
    const pixelWidth = Math.max(1, Math.round(cssWidth * currentDpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * currentDpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvasScaleX = pixelWidth / WORLD_WIDTH;
    canvasScaleY = pixelHeight / WORLD_HEIGHT;
    renderSimulation();
}

function fullResetAndRestart() {
    initializeSimulationState();
    updateReadouts();
    lastReadoutUpdate = performance.now();
    redrawCharts();
    renderSimulation();
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
        particleCountSlider.addEventListener('input', () => {
            nPerColor = +particleCountSlider.value;
            if (countVal) countVal.textContent = nPerColor;
            fullResetAndRestart();
        });
        if (countVal) countVal.textContent = nPerColor;
    }

    if (speedSlider) {
        speedSlider.addEventListener('input', () => {
            speedMultiplier = +speedSlider.value;
            if (speedValEl) speedValEl.textContent = speedMultiplier;
        });
        if (speedValEl) speedValEl.textContent = speedMultiplier;
    }

    if (gateSizeSlider) {
        gateSizeSlider.addEventListener('input', () => {
            gateSizePercent = +gateSizeSlider.value;
            if (gateSizeValEl) gateSizeValEl.textContent = gateSizePercent;
        });
        if (gateSizeValEl) gateSizeValEl.textContent = gateSizePercent;
    }

    const applyDemonMode = () => {
        demonMode = demonModeSelector ? demonModeSelector.value : 'automatic';
        canvas.style.cursor = demonMode === 'manual' ? 'pointer' : '';
        observeGate();
    };
    if (demonModeSelector) demonModeSelector.addEventListener('change', applyDemonMode);
    applyDemonMode();

    if (showChartsCheckbox && chartsContainer) {
        showChartsCheckbox.addEventListener('change', applyChartsVisibility);
        applyChartsVisibility();
    }

    if (resetButton) resetButton.addEventListener('click', fullResetAndRestart);

    // Manual mode: press and hold (mouse, pen or touch) on the canvas to open the gate
    const releaseGate = () => { pointerHeld = false; };
    canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        pointerHeld = true;
        if (demonMode === 'manual') e.preventDefault();
    });
    canvas.addEventListener('pointerup', releaseGate);
    canvas.addEventListener('pointercancel', releaseGate);
    canvas.addEventListener('pointerleave', releaseGate);
    window.addEventListener('blur', releaseGate);
    canvas.addEventListener('contextmenu', (e) => { if (demonMode === 'manual') e.preventDefault(); });

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
