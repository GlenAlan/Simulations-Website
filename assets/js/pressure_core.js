/*
 * Gas Pressure Simulation - kinetic theory of an (ideal) gas in 2D.
 *
 * Pressure is measured from first principles: every wall collision transfers an
 * impulse J = m * |delta v_perp| to the wall. Summing J over a sliding time window
 * and dividing by (time * wall length) gives the pressure (force per unit length
 * in 2D). It is compared with the 2D ideal-gas prediction P * A = N k T (= total KE).
 *
 * Reduced units (world: 200 x 100 units, container region x < 140):
 *   particle mass m = 1 for the nitrogen-like gas, k_B = KB = 3 energy units per kelvin,
 *   so the 2D thermal speed sqrt(kT/m) = 30 units/s at 300 K.
 *   Display mapping: A_REF = 4096 units^2 <-> 1.00 L, and pressure is scaled so that
 *   300 particles at 300 K in 1.00 L read 101.325 kPa. Speeds are shown in m/s via
 *   SPEED_TO_MS (10 m/s per unit/s), which matches real N2 at the same temperature.
 */
(function () {
    'use strict';

    const canvas = document.getElementById('simulationCanvas');
    if (!canvas || !canvas.getContext) {
        console.error('Pressure simulation: canvas #simulationCanvas not found.');
        return;
    }
    const ctx = canvas.getContext('2d', { alpha: false });

    const byId = (id) => document.getElementById(id);
    const ui = {
        container: byId('containerSelect'),
        temp: byId('temperatureSlider'), tempVal: byId('temperatureVal'), tempLabel: byId('temperatureLabel'),
        insulatedNote: byId('insulatedNote'),
        count: byId('particleCountSlider'), countVal: byId('particleCountVal'),
        volume: byId('volumeSlider'), volumeVal: byId('volumeVal'), volumeGroup: byId('volumeControl'),
        weights: byId('weightsSlider'), weightsVal: byId('weightsVal'), weightsGroup: byId('weightsControl'),
        speed: byId('speedSlider'), speedVal: byId('speedVal'),
        gas: byId('gasSelect'),
        hitArrows: byId('hitArrowsToggle'), avgArrows: byId('avgArrowsToggle'), tracer: byId('tracerToggle'),
        collisions: byId('collisionsToggle'), insulated: byId('insulatedToggle'),
        graphMode: byId('graphModeSelect'),
        showCharts: byId('showCharts'), chartsContainer: byId('charts-container'),
        reset: byId('resetSimulationBtn'), fps: byId('fpsDisplay'),
        statP: byId('statPressure'), statV: byId('statVolume'), statT: byId('statTemperature'),
        statN: byId('statCount'), statZ: byId('statRatio')
    };

    // ------------------------------------------------------------------
    // Constants, units and geometry
    // ------------------------------------------------------------------
    const TAU = Math.PI * 2;
    const WORLD_W = 200, WORLD_H = 100;
    const REGION_W = 140;            // particles / containers live in x < REGION_W
    const INSTR_X = 143;             // instrument panel (gauge, legend) on the right
    const REGION_SHIFT = WORLD_W - (INSTR_X - 1);   // region offset when the layout is mirrored
    const KB = 3;                    // energy units per kelvin
    const A_REF = 4096;              // area that reads as 1.00 L
    const P_ATM = 300 * KB * 300 / A_REF;    // 65.92 sim units == 101.325 kPa (1 atm)
    const KPA = 101.325 / P_ATM;     // kPa per sim pressure unit
    const SPEED_TO_MS = 10;          // m/s per (unit/s) for the nitrogen-like gas
    const MAX_N = 1500;
    const CAP = MAX_N + 16;
    const R_DRAW = 0.6;              // drawn particle radius
    const R_COLL = 0.3;              // particle-particle collision radius (kept small: dilute gas)
    const D_COLL2 = (2 * R_COLL) * (2 * R_COLL);
    const WALL_T = 2.4;              // drawn wall thickness
    const MAX_STEP_DIST = 0.4;       // max distance a particle moves per substep
    const MAX_SUBSTEPS = 60;
    const MAX_FRAME_DT = 0.05;       // clamp long frames (tab switches)
    const PUMP_RATE = 300;           // particles per simulated second through the inlet
    const WEIGHT_P = 50 / KPA;       // each piston weight adds 50 kPa
    // Colour scale (like the Maxwell's demon page: blue = slower, red = faster than the median particle
    // of the default gas). sqrt(m) * speed / V_COL is the position on the scale; the median speed
    // at 300 K, sqrt(2 ln 2 * kT/m) = 35.3, lands on the violet midpoint (0.42) between blue and red.
    const V_COL = 84;
    const NB = 24;                   // colour buckets
    const HIT_CAP = 640, HIT_LIFE = 0.3, HIT_SCALE = 0.07, HIT_MAX = 16;
    const AVG_SCALE = 9 / P_ATM, AVG_MAX = 24;   // 1 atm -> 9 units long
    const SECTOR_TAU = 1.5;          // averaging time of the per-sector pressure arrows (s)
    const BIN_DT = 0.1, NBINS = 15;  // 1.5 s sliding window for the measured pressure
    const GX = REGION_W, GY = WORLD_H;   // collision grid, cell size 1 (>= 2 * R_COLL)
    const GAUGE_RANGES = [200, 400, 800, 1600, 3200, 6400];

    const GASES = {
        he: { m: 4 / 28, name: 'Helium' },
        n2: { m: 1, name: 'Nitrogen' },
        xe: { m: 131.3 / 28, name: 'Xenon' }
    };

    const BALLOON = { cx: 70, cy: 48.5, R0: 20, Rs: 38, k1: 11.8, k3: 8, Rmin: 6, Rmax: 45, M: 120, c: 400 };
    const BOX = { x0: 38, x1: 102, y0: 18, y1: 82 };
    const SYRINGE = { x0: 8, y0: 24, y1: 76, barrelEnd: 86, rod: 58, xMin: 28, xMax: 82, uMax: 20, follow: 5 };
    const PISTON = { x0: 38, x1: 102, y1: 92, yTop: 16, yLow: 86, M: 25, c: 80, slab: 4.5, weightH: 5.5 };
    const SEGMENTS = { box: [5, 5, 5, 5], syringe: [4, 4, 6, 6], piston: [4, 4, 5, 5] };  // left, right, top, bottom
    const N_CIRCLE_SECTORS = 24;

    // ------------------------------------------------------------------
    // Settings & state
    // ------------------------------------------------------------------
    const S = {
        container: 'balloon',
        Tset: 300,
        Ntarget: 300,
        gas: 'n2',
        speed: 1,
        collisions: false,
        insulated: false,
        hitArrows: true,
        avgArrows: true,
        tracer: false,
        syringeV: 0.80,
        weights: 1,
        graphMode: 'auto',
        paused: false
    };
    let mass = 1;
    let simTime = 0;

    // Particles (structure of arrays, no per-frame allocation)
    const px = new Float64Array(CAP), py = new Float64Array(CAP);
    const pvx = new Float64Array(CAP), pvy = new Float64Array(CAP);
    let N = 0;
    let lastSumV2 = 0, lastVmax2 = 0, lastSubsteps = 1;

    // Walls
    const bal = { R: 34, Rdot: 0 };
    const box = { x0: 0, x1: 0, y0: 0, y1: 0, u1: 0, v0: 0 };   // u1: right wall vx, v0: top wall vy
    let syringeTarget = 0;
    let dampLoss = 0;          // energy removed by wall damping (returned to the gas if insulated)
    let stepJ = 0, stepHits = 0;
    let pumpCarry = 0;
    let valveFlashUntil = 0;
    let hasDragged = false;

    // Collision grid (linked cells)
    const head = new Int32Array(GX * GY);
    const nextIdx = new Int32Array(CAP);
    const cellX = new Int16Array(CAP), cellY = new Int16Array(CAP);

    // Wall sectors for pressure arrows
    const MAX_SECTORS = 48;
    const secJ = new Float64Array(MAX_SECTORS);
    const secP = new Float64Array(MAX_SECTORS);
    let nSectors = N_CIRCLE_SECTORS;
    let segCount = [6, 6, 6, 6];
    const segStart = [0, 6, 12, 18];
    const secCos = new Float64Array(MAX_SECTORS), secSin = new Float64Array(MAX_SECTORS);
    const outCos = new Float64Array(MAX_SECTORS), outSin = new Float64Array(MAX_SECTORS);
    let sectorScale = N_CIRCLE_SECTORS / TAU;

    // Collision-arrow ring buffer
    const hitX = new Float32Array(HIT_CAP), hitY = new Float32Array(HIT_CAP);
    const hitNX = new Float32Array(HIT_CAP), hitNY = new Float32Array(HIT_CAP);
    const hitL = new Float32Array(HIT_CAP), hitT = new Float64Array(HIT_CAP);
    let hitHead = 0;

    // Measurement: current bin + ring of completed bins
    const meas = { J: 0, hits: 0, Ldt: 0, Adt: 0, KEdt: 0, Ndt: 0, dt: 0 };
    const binJ = new Float64Array(NBINS), binHits = new Float64Array(NBINS), binLdt = new Float64Array(NBINS);
    const binAdt = new Float64Array(NBINS), binKEdt = new Float64Array(NBINS), binNdt = new Float64Array(NBINS);
    const binDt = new Float64Array(NBINS);
    let binHead = 0, binCount = 0;
    let testAcc = null;        // long-run accumulator used by the debug/test API
    const win = { valid: false, P: 0, Pideal: 0, A: 0, KE: 0, T: 0, N: 0, hitRate: 0, ratio: 1 };

    // Decorative outside air for the balloon
    const AIR_N = 90;
    const ax = new Float32Array(AIR_N), ay = new Float32Array(AIR_N);
    const avx = new Float32Array(AIR_N), avy = new Float32Array(AIR_N);

    // Tracer trail
    const TRAIL_N = 90;
    const trailX = new Float32Array(TRAIL_N), trailY = new Float32Array(TRAIL_N);
    let trailHead = 0, trailLen = 0;

    // Rendering buffers
    const bucketCount = new Int32Array(NB), bucketStart = new Int32Array(NB), bucketCursor = new Int32Array(NB);
    const order = new Int32Array(CAP);
    const pBucket = new Uint8Array(CAP);

    // ------------------------------------------------------------------
    // Colours
    // ------------------------------------------------------------------
    const COLOR_STOPS = [
        [0.00, 50, 95, 225],
        [0.22, 45, 150, 255],
        [0.42, 140, 95, 240],
        [0.62, 235, 65, 110],
        [0.82, 255, 135, 35],
        [1.00, 255, 200, 45]
    ];
    function colorAt(t) {
        if (t <= 0) return COLOR_STOPS[0].slice(1);
        for (let i = 1; i < COLOR_STOPS.length; i++) {
            const b = COLOR_STOPS[i];
            if (t <= b[0]) {
                const a = COLOR_STOPS[i - 1];
                const f = (t - a[0]) / (b[0] - a[0]);
                return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
            }
        }
        return COLOR_STOPS[COLOR_STOPS.length - 1].slice(1);
    }
    const rgb = (c) => 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')';
    const bucketColor = [];
    for (let b = 0; b < NB; b++) bucketColor.push(rgb(colorAt((b + 0.5) / NB)));
    // Colour of a temperature = colour of the mean particle at that temperature.
    function tempT(T) { return Math.sqrt(Math.PI / 2 * KB * T) / V_COL; }
    function colorForTemperature(T) {
        let b = Math.floor(tempT(T) * NB);
        if (b < 0) b = 0; else if (b >= NB) b = NB - 1;
        return bucketColor[b];
    }

    let pal = null;
    function readPalette() {
        const root = document.documentElement;
        const dark = root.classList.contains('dark-mode');
        const cs = getComputedStyle(root);
        const cssVar = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
        pal = {
            dark: dark,
            bg: dark ? '#161616' : '#ffffff',
            text: cssVar('--color-text', dark ? '#e0e0e0' : '#585858'),
            textSub: dark ? 'rgba(224,224,224,0.66)' : 'rgba(60,60,60,0.72)',
            accent: cssVar('--color-accent', '#f2849e'),
            panelBg: dark ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.035)',
            panelBorder: dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.09)',
            wallInsulated: dark ? '#8a929b' : '#7b838c',
            foam: dark ? 'rgba(235,200,120,0.6)' : 'rgba(170,120,40,0.6)',
            metal: dark ? '#6b737c' : '#9aa1a8',
            metalEdge: dark ? '#8d959e' : '#6d747b',
            weight: dark ? '#454c54' : '#59616a',
            weightText: '#f0f0f0',
            rubber: '#f2849e',
            rubberFill: dark ? 'rgba(242,132,158,0.07)' : 'rgba(242,132,158,0.10)',
            stopper: dark ? '#565c63' : '#353a40',
            rod: dark ? 'rgba(200,210,220,0.5)' : 'rgba(100,110,120,0.5)',
            glass: dark ? 'rgba(160,190,220,0.05)' : 'rgba(80,120,160,0.05)',
            hitRGB: dark ? '255,255,255' : '30,30,30',
            avgArrow: dark ? 'rgba(255,190,60,0.62)' : 'rgba(205,115,0,0.62)',
            outArrow: dark ? 'rgba(126,202,246,0.75)' : 'rgba(31,120,180,0.75)',
            outSolid: dark ? '#7ecaf6' : '#1f78b4',
            air: dark ? 'rgba(210,210,210,0.32)' : 'rgba(70,70,70,0.30)',
            tracer: dark ? '#ffffff' : '#111111',
            trailRGB: dark ? '255,255,255' : '20,20,20',
            gaugeFace: dark ? '#222428' : '#f6f6f6',
            gaugeRim: dark ? '#9aa3ad' : '#7a828a',
            needle: '#f2849e',
            ideal: dark ? '#e8e8e8' : '#333333',
            grid: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
            valveOn: '#4ade80'
        };
    }

    // ------------------------------------------------------------------
    // Random numbers
    // ------------------------------------------------------------------
    let gaussSpare = 0, hasSpare = false;
    function gauss() {
        if (hasSpare) { hasSpare = false; return gaussSpare; }
        let u, v, s;
        do {
            u = Math.random() * 2 - 1;
            v = Math.random() * 2 - 1;
            s = u * u + v * v;
        } while (s >= 1 || s === 0);
        const f = Math.sqrt(-2 * Math.log(s) / s);
        gaussSpare = v * f;
        hasSpare = true;
        return u * f;
    }
    // Normal speed of a particle leaving a thermal wall (flux-weighted Maxwell-Boltzmann).
    function fluxSpeed(sigma) { return sigma * Math.sqrt(-2 * Math.log(1 - Math.random())); }

    // ------------------------------------------------------------------
    // Container helpers
    // ------------------------------------------------------------------
    function isBalloon() { return S.container === 'balloon'; }
    function area() { return isBalloon() ? Math.PI * bal.R * bal.R : (box.x1 - box.x0) * (box.y1 - box.y0); }
    function perimeter() { return isBalloon() ? TAU * bal.R : 2 * ((box.x1 - box.x0) + (box.y1 - box.y0)); }
    function externalPressure() {
        if (S.container === 'balloon') return P_ATM;
        if (S.container === 'piston') return P_ATM + S.weights * WEIGHT_P;
        return 0;
    }
    function tension(R) {
        const d = R - BALLOON.R0;
        if (d <= 0) return 0;
        const s = R - BALLOON.Rs;
        return BALLOON.k1 * d + (s > 0 ? BALLOON.k3 * s * s * s : 0);
    }
    function syringeXForVolume(V) { return SYRINGE.x0 + V * A_REF / (SYRINGE.y1 - SYRINGE.y0); }
    function syringeVolumeForX(x) { return (x - SYRINGE.x0) * (SYRINGE.y1 - SYRINGE.y0) / A_REF; }
    function currentKE() { return 0.5 * mass * lastSumV2; }
    function gasTemperature() { return N > 0 ? currentKE() / (N * KB) : S.Tset; }

    function solveBalloonRadius(NkT) {
        const B = BALLOON;
        const f = (R) => NkT / (Math.PI * R * R) - P_ATM - tension(R) / R;
        if (f(B.Rmax) > 0) return B.Rmax;
        if (f(B.Rmin) < 0) return B.Rmin;
        let lo = B.Rmin, hi = B.Rmax;
        for (let i = 0; i < 50; i++) {
            const mid = 0.5 * (lo + hi);
            if (f(mid) > 0) lo = mid; else hi = mid;
        }
        return 0.5 * (lo + hi);
    }

    function setupGeometry() {
        const NkT = S.Ntarget * KB * S.Tset;
        box.u1 = 0; box.v0 = 0;
        bal.Rdot = 0;
        if (S.container === 'balloon') {
            bal.R = solveBalloonRadius(NkT);
        } else if (S.container === 'box') {
            box.x0 = BOX.x0; box.x1 = BOX.x1; box.y0 = BOX.y0; box.y1 = BOX.y1;
        } else if (S.container === 'syringe') {
            box.x0 = SYRINGE.x0; box.y0 = SYRINGE.y0; box.y1 = SYRINGE.y1;
            box.x1 = clampSyringeX(syringeXForVolume(S.syringeV));
            syringeTarget = box.x1;
        } else {
            box.x0 = PISTON.x0; box.x1 = PISTON.x1; box.y1 = PISTON.y1;
            const h = NkT / ((P_ATM + S.weights * WEIGHT_P) * (PISTON.x1 - PISTON.x0));
            box.y0 = Math.min(PISTON.yLow, Math.max(PISTON.yTop, PISTON.y1 - h));
        }
    }
    function clampSyringeX(x) { return Math.min(SYRINGE.xMax, Math.max(SYRINGE.xMin, x)); }

    function setupSectors() {
        if (isBalloon()) {
            nSectors = N_CIRCLE_SECTORS;
            sectorScale = nSectors / TAU;
            for (let k = 0; k < nSectors; k++) {
                const a = -Math.PI + (k + 0.5) * TAU / nSectors;
                secCos[k] = Math.cos(a); secSin[k] = Math.sin(a);
                const b = a + 0.5 * TAU / nSectors;
                outCos[k] = Math.cos(b); outSin[k] = Math.sin(b);
            }
        } else {
            segCount = SEGMENTS[S.container];
            let acc = 0;
            for (let w = 0; w < 4; w++) { segStart[w] = acc; acc += segCount[w]; }
            nSectors = acc;
        }
        secJ.fill(0);
        const Ppred = S.Ntarget * KB * S.Tset / Math.max(1, area());
        for (let k = 0; k < nSectors; k++) secP[k] = Ppred;
    }

    // ------------------------------------------------------------------
    // Particle creation / removal
    // ------------------------------------------------------------------
    function placeRandomly(i) {
        if (isBalloon()) {
            const R = Math.max(0.5, bal.R - 0.5);
            let x, y;
            do {
                x = (Math.random() * 2 - 1) * R;
                y = (Math.random() * 2 - 1) * R;
            } while (x * x + y * y > R * R);
            px[i] = BALLOON.cx + x; py[i] = BALLOON.cy + y;
        } else {
            px[i] = box.x0 + 0.3 + Math.random() * (box.x1 - box.x0 - 0.6);
            py[i] = box.y0 + 0.3 + Math.random() * (box.y1 - box.y0 - 0.6);
        }
    }
    function giveThermalVelocity(i, T) {
        const sig = Math.sqrt(KB * T / mass);
        pvx[i] = sig * gauss();
        pvy[i] = sig * gauss();
    }
    function injectionTemperature() {
        return (S.insulated && N > 0) ? gasTemperature() : S.Tset;
    }
    // Inlet position + inward normal for each container.
    const inlet = { x: 0, y: 0, nx: 0, ny: 0, tx: 0, ty: 0 };
    function updateInlet() {
        if (S.container === 'balloon') {
            inlet.x = BALLOON.cx; inlet.y = BALLOON.cy + bal.R - 0.8; inlet.nx = 0; inlet.ny = -1; inlet.tx = 1; inlet.ty = 0;
        } else if (S.container === 'piston') {
            inlet.x = 0.5 * (box.x0 + box.x1); inlet.y = box.y1 - 0.8; inlet.nx = 0; inlet.ny = -1; inlet.tx = 1; inlet.ty = 0;
        } else {
            inlet.x = box.x0 + 0.8; inlet.y = 0.5 * (box.y0 + box.y1); inlet.nx = 1; inlet.ny = 0; inlet.tx = 0; inlet.ty = 1;
        }
    }
    function injectParticle(randomPlace) {
        if (N >= MAX_N) return;
        const i = N;
        const T = injectionTemperature();
        N++;
        if (randomPlace) {
            placeRandomly(i);
            giveThermalVelocity(i, T);
        } else {
            updateInlet();
            const off = (Math.random() - 0.5) * 3;
            px[i] = inlet.x + inlet.tx * off;
            py[i] = inlet.y + inlet.ty * off;
            giveThermalVelocity(i, T);
            const vn = pvx[i] * inlet.nx + pvy[i] * inlet.ny;
            if (vn < 0) { pvx[i] -= 2 * vn * inlet.nx; pvy[i] -= 2 * vn * inlet.ny; }
            valveFlashUntil = performance.now() + 250;
        }
        const v2 = pvx[i] * pvx[i] + pvy[i] * pvy[i];
        lastSumV2 += v2;
        if (v2 > lastVmax2) lastVmax2 = v2;
    }
    function removeParticle() {
        if (N <= 1) return;
        const i = 1 + Math.floor(Math.random() * (N - 1));   // never remove the tracer (index 0)
        const last = N - 1;
        lastSumV2 -= pvx[i] * pvx[i] + pvy[i] * pvy[i];
        px[i] = px[last]; py[i] = py[last]; pvx[i] = pvx[last]; pvy[i] = pvy[last];
        N--;
        valveFlashUntil = performance.now() + 250;
    }
    function updateParticleCount(dtSim) {
        const diff = S.Ntarget - N;
        if (diff === 0) { pumpCarry = 0; return; }
        pumpCarry += PUMP_RATE * dtSim;
        let k = Math.floor(pumpCarry);
        if (k <= 0) return;
        pumpCarry -= k;
        if (diff > 0) { k = Math.min(k, diff); for (let j = 0; j < k; j++) injectParticle(false); }
        else { k = Math.min(k, -diff); for (let j = 0; j < k; j++) removeParticle(); }
    }
    function recomputeVelocityStats() {
        let s = 0, mx = 0;
        for (let i = 0; i < N; i++) {
            const v2 = pvx[i] * pvx[i] + pvy[i] * pvy[i];
            s += v2; if (v2 > mx) mx = v2;
        }
        lastSumV2 = s; lastVmax2 = mx;
    }
    function scaleVelocities(f) {
        for (let i = 0; i < N; i++) { pvx[i] *= f; pvy[i] *= f; }
        lastSumV2 *= f * f; lastVmax2 *= f * f;
    }

    // ------------------------------------------------------------------
    // Physics
    // ------------------------------------------------------------------
    function addHitArrow(x, y, nx, ny, j) {
        const k = hitHead;
        hitHead = (hitHead + 1) % HIT_CAP;
        hitX[k] = x; hitY[k] = y; hitNX[k] = nx; hitNY[k] = ny;
        const L = j * HIT_SCALE;
        hitL[k] = L > HIT_MAX ? HIT_MAX : L;
        hitT[k] = simTime;
    }

    // Free walls (balloon membrane, piston) are integrated kick-drift-kick around the particle
    // update, so the large steady outside force does no spurious work: M x'' = F_ext(x) + gas
    // impulses (applied collision by collision while the particles move) - c x'.
    // Damping is an exact exponential decay whose energy is booked in dampLoss.
    function wallKick(h) {
        const c = S.container;
        if (c === 'balloon') {
            // Uniform radial mode of an elastic membrane: M R'' = sum(J)/dt - 2 pi R P_out - 2 pi gamma(R) - c R'
            const B = BALLOON;
            const v = bal.Rdot * Math.exp(-B.c * h / B.M);
            dampLoss += 0.5 * B.M * (bal.Rdot * bal.Rdot - v * v);
            bal.Rdot = v + (-TAU * bal.R * P_ATM - TAU * tension(bal.R)) / B.M * h;
        } else if (c === 'piston') {
            // Free piston (y down): M y'' = P_ext W - sum(J)/dt - c y'
            const P = PISTON;
            const v = box.v0 * Math.exp(-P.c * h / P.M);
            dampLoss += 0.5 * P.M * (box.v0 * box.v0 - v * v);
            box.v0 = v + (P_ATM + S.weights * WEIGHT_P) * (box.x1 - box.x0) / P.M * h;
        }
    }
    function wallDrift(dt) {
        const c = S.container;
        if (c === 'balloon') {
            const B = BALLOON;
            bal.R += bal.Rdot * dt;
            if (bal.R > B.Rmax) {
                bal.R = B.Rmax;
                if (bal.Rdot > 0) { dampLoss += 0.5 * B.M * bal.Rdot * bal.Rdot; bal.Rdot = 0; }
            } else if (bal.R < B.Rmin) {
                bal.R = B.Rmin;
                if (bal.Rdot < 0) { dampLoss += 0.5 * B.M * bal.Rdot * bal.Rdot; bal.Rdot = 0; }
            }
        } else if (c === 'syringe') {
            // Plunger is moved by the user: follows the target at a limited speed.
            let u = (syringeTarget - box.x1) * SYRINGE.follow;
            if (u > SYRINGE.uMax) u = SYRINGE.uMax; else if (u < -SYRINGE.uMax) u = -SYRINGE.uMax;
            box.u1 = u;
            box.x1 += u * dt;
            if (box.x1 < SYRINGE.xMin) { box.x1 = SYRINGE.xMin; box.u1 = 0; }
            else if (box.x1 > SYRINGE.xMax) { box.x1 = SYRINGE.xMax; box.u1 = 0; }
        } else if (c === 'piston') {
            const P = PISTON;
            box.y0 += box.v0 * dt;
            if (box.y0 < P.yTop) {
                box.y0 = P.yTop;
                if (box.v0 < 0) { dampLoss += 0.5 * P.M * box.v0 * box.v0; box.v0 = 0; }
            } else if (box.y0 > P.yLow) {
                box.y0 = P.yLow;
                if (box.v0 > 0) { dampLoss += 0.5 * P.M * box.v0 * box.v0; box.v0 = 0; }
            }
        }
    }

    function moveCircle(dt) {
        const cx = BALLOON.cx, cy = BALLOON.cy;
        const R = bal.R, R2 = R * R;
        const m = mass, M = BALLOON.M;
        const thermal = !S.insulated;
        const sig = Math.sqrt(KB * S.Tset / m);
        const arrows = S.hitArrows;
        const headR = R + R_DRAW * 0.9;
        let sumV2 = 0, vmax2 = 0, J = 0, hits = 0;
        for (let i = 0; i < N; i++) {
            let vx = pvx[i], vy = pvy[i];
            let x = px[i] + vx * dt, y = py[i] + vy * dt;
            const dx = x - cx, dy = y - cy;
            const r2 = dx * dx + dy * dy;
            if (r2 > R2) {
                const r = Math.sqrt(r2);
                const ux = dx / r, uy = dy / r;              // outward normal
                let vr = vx * ux + vy * uy;                   // outward radial velocity
                let vt = -vx * uy + vy * ux;                  // tangential velocity
                const Rdot = bal.Rdot;
                if (vr > Rdot) {                              // approaching the (moving) membrane
                    let vr2;
                    if (thermal) {                            // diffuse re-emission at the bath temperature
                        vr2 = Rdot - fluxSpeed(sig);
                        vt = sig * gauss();
                    } else {                                  // elastic collision with the membrane mode (mass M)
                        vr2 = ((m - M) * vr + 2 * M * Rdot) / (m + M);
                    }
                    const j = m * (vr - vr2);                 // outward impulse on the membrane
                    bal.Rdot = Rdot + j / M;
                    // The hit happened tau ago, so the membrane has been moving with the new
                    // velocity since then (keeps the energy exchange with P_out exact).
                    let tau = (r - R) / (vr - Rdot);
                    if (tau > dt) tau = dt;
                    bal.R += j / M * tau;
                    J += j; hits++;
                    let k = ((Math.atan2(uy, ux) + Math.PI) * sectorScale) | 0;
                    if (k >= nSectors) k = nSectors - 1;
                    secJ[k] += j;
                    if (arrows) addHitArrow(cx + ux * headR, cy + uy * headR, ux, uy, j);
                    vr = vr2;
                }
                let rn = 2 * R - r;
                if (rn > R) rn = R;
                if (rn < 0) rn = 0;
                x = cx + ux * rn; y = cy + uy * rn;
                vx = vr * ux - vt * uy;
                vy = vr * uy + vt * ux;
                pvx[i] = vx; pvy[i] = vy;
            }
            px[i] = x; py[i] = y;
            const v2 = vx * vx + vy * vy;
            sumV2 += v2;
            if (v2 > vmax2) vmax2 = v2;
        }
        lastSumV2 = sumV2; lastVmax2 = vmax2;
        stepJ += J; stepHits += hits;
    }

    function moveBox(dt) {
        const x0 = box.x0, x1 = box.x1, y0 = box.y0, y1 = box.y1;
        const u1 = box.u1;
        let v0 = box.v0;
        const freePiston = S.container === 'piston';
        const M = PISTON.M;
        const m = mass;
        const thermal = !S.insulated;
        const sig = Math.sqrt(KB * S.Tset / m);
        const arrows = S.hitArrows;
        const wInv = 1 / (x1 - x0), hInv = 1 / (y1 - y0);
        const nL = segCount[0], nR = segCount[1], nT = segCount[2], nB = segCount[3];
        const sL = segStart[0], sR = segStart[1], sT = segStart[2], sB = segStart[3];
        let sumV2 = 0, vmax2 = 0, J = 0, hits = 0;
        for (let i = 0; i < N; i++) {
            let vx = pvx[i], vy = pvy[i];
            let x = px[i] + vx * dt, y = py[i] + vy * dt;
            if (x < x0) {
                if (vx < 0) {
                    const nvx = thermal ? fluxSpeed(sig) : -vx;
                    if (thermal) vy = sig * gauss();
                    const j = m * (nvx - vx);
                    J += j; hits++;
                    let s = ((y - y0) * hInv * nL) | 0; if (s < 0) s = 0; else if (s >= nL) s = nL - 1;
                    secJ[sL + s] += j;
                    if (arrows) addHitArrow(x0 - R_DRAW, y, -1, 0, j);
                    vx = nvx;
                }
                x = 2 * x0 - x; if (x > x1) x = x1;
            } else if (x > x1) {
                if (vx > u1) {
                    const nvx = thermal ? u1 - fluxSpeed(sig) : 2 * u1 - vx;
                    if (thermal) vy = sig * gauss();
                    const j = m * (vx - nvx);
                    J += j; hits++;
                    let s = ((y - y0) * hInv * nR) | 0; if (s < 0) s = 0; else if (s >= nR) s = nR - 1;
                    secJ[sR + s] += j;
                    if (arrows) addHitArrow(x1 + R_DRAW, y, 1, 0, j);
                    vx = nvx;
                }
                x = 2 * x1 - x; if (x < x0) x = x0;
            }
            if (y < y0) {
                if (vy < v0) {
                    let nvy;
                    if (thermal) { nvy = v0 + fluxSpeed(sig); vx = sig * gauss(); }
                    else if (freePiston) nvy = ((m - M) * vy + 2 * M * v0) / (m + M);
                    else nvy = 2 * v0 - vy;
                    const j = m * (nvy - vy);
                    if (freePiston) {
                        let tau = (y0 - y) / (v0 - vy);       // time since the hit (see moveCircle)
                        if (tau > dt) tau = dt;
                        v0 -= j / M;
                        box.y0 -= j / M * tau;
                    }
                    J += j; hits++;
                    let s = ((x - x0) * wInv * nT) | 0; if (s < 0) s = 0; else if (s >= nT) s = nT - 1;
                    secJ[sT + s] += j;
                    if (arrows) addHitArrow(x, y0 - R_DRAW, 0, -1, j);
                    vy = nvy;
                }
                y = 2 * y0 - y; if (y > y1) y = y1;
            } else if (y > y1) {
                if (vy > 0) {
                    const nvy = thermal ? -fluxSpeed(sig) : -vy;
                    if (thermal) vx = sig * gauss();
                    const j = m * (vy - nvy);
                    J += j; hits++;
                    let s = ((x - x0) * wInv * nB) | 0; if (s < 0) s = 0; else if (s >= nB) s = nB - 1;
                    secJ[sB + s] += j;
                    if (arrows) addHitArrow(x, y1 + R_DRAW, 0, 1, j);
                    vy = nvy;
                }
                y = 2 * y1 - y; if (y < y0) y = y0;
            }
            px[i] = x; py[i] = y; pvx[i] = vx; pvy[i] = vy;
            const v2 = vx * vx + vy * vy;
            sumV2 += v2;
            if (v2 > vmax2) vmax2 = v2;
        }
        box.v0 = v0;
        lastSumV2 = sumV2; lastVmax2 = vmax2;
        stepJ += J; stepHits += hits;
    }

    // Equal-mass elastic collisions between particles, found with a linked-cell grid.
    function collidePair(i, j) {
        const dx = px[j] - px[i], dy = py[j] - py[i];
        const d2 = dx * dx + dy * dy;
        if (d2 >= D_COLL2 || d2 === 0) return;
        const dvx = pvx[j] - pvx[i], dvy = pvy[j] - pvy[i];
        const dot = dx * dvx + dy * dvy;
        if (dot >= 0) return;                       // already separating
        const k = dot / d2;                         // swap the normal velocity components
        pvx[i] += k * dx; pvy[i] += k * dy;
        pvx[j] -= k * dx; pvy[j] -= k * dy;
    }
    function collideParticles() {
        head.fill(-1);
        for (let i = 0; i < N; i++) {
            let gx = px[i] | 0, gy = py[i] | 0;
            if (gx < 0) gx = 0; else if (gx >= GX) gx = GX - 1;
            if (gy < 0) gy = 0; else if (gy >= GY) gy = GY - 1;
            cellX[i] = gx; cellY[i] = gy;
            const c = gy * GX + gx;
            nextIdx[i] = head[c];
            head[c] = i;
        }
        for (let i = 0; i < N; i++) {
            const gx = cellX[i], gy = cellY[i];
            let j;
            for (j = nextIdx[i]; j !== -1; j = nextIdx[j]) collidePair(i, j);
            if (gx + 1 < GX) for (j = head[gy * GX + gx + 1]; j !== -1; j = nextIdx[j]) collidePair(i, j);
            if (gy + 1 < GY) {
                const row = (gy + 1) * GX;
                if (gx > 0) for (j = head[row + gx - 1]; j !== -1; j = nextIdx[j]) collidePair(i, j);
                for (j = head[row + gx]; j !== -1; j = nextIdx[j]) collidePair(i, j);
                if (gx + 1 < GX) for (j = head[row + gx + 1]; j !== -1; j = nextIdx[j]) collidePair(i, j);
            }
        }
    }

    function physicsStep(dt) {
        stepJ = 0; stepHits = 0;
        wallKick(0.5 * dt);
        wallDrift(dt);
        if (isBalloon()) moveCircle(dt); else moveBox(dt);
        wallKick(0.5 * dt);
        if (S.collisions && N > 1) collideParticles();
        simTime += dt;
        const L = perimeter(), A = area(), KE = 0.5 * mass * lastSumV2;
        meas.J += stepJ; meas.hits += stepHits;
        meas.Ldt += L * dt; meas.Adt += A * dt; meas.KEdt += KE * dt; meas.Ndt += N * dt; meas.dt += dt;
        if (testAcc) {
            testAcc.J += stepJ; testAcc.hits += stepHits;
            testAcc.Ldt += L * dt; testAcc.Adt += A * dt; testAcc.KEdt += KE * dt; testAcc.Ndt += N * dt; testAcc.dt += dt;
        }
    }

    function wallSpeed() {
        if (S.container === 'balloon') return Math.abs(bal.Rdot);
        if (S.container === 'syringe') return Math.abs(box.u1);
        if (S.container === 'piston') return Math.abs(box.v0);
        return 0;
    }

    function updateSectors(dtSim) {
        const a = 1 - Math.exp(-dtSim / SECTOR_TAU);
        if (isBalloon()) {
            const len = TAU * bal.R / nSectors;
            for (let k = 0; k < nSectors; k++) {
                secP[k] += (secJ[k] / (len * dtSim) - secP[k]) * a;
                secJ[k] = 0;
            }
        } else {
            const w = box.x1 - box.x0, h = box.y1 - box.y0;
            for (let wall = 0; wall < 4; wall++) {
                const len = (wall < 2 ? h : w) / segCount[wall];
                const end = segStart[wall] + segCount[wall];
                for (let k = segStart[wall]; k < end; k++) {
                    secP[k] += (secJ[k] / (len * dtSim) - secP[k]) * a;
                    secJ[k] = 0;
                }
            }
        }
    }

    // With insulated walls the friction of the membrane/piston heats the gas instead of vanishing.
    function returnDampedEnergy() {
        if (S.insulated && dampLoss > 0 && N > 0 && S.container !== 'box' && S.container !== 'syringe') {
            const KE = currentKE();
            if (KE > 0) scaleVelocities(Math.sqrt(1 + dampLoss / KE));
        }
        dampLoss = 0;
    }

    function rotateBins() {
        if (meas.dt < BIN_DT) return;
        binJ[binHead] = meas.J; binHits[binHead] = meas.hits; binLdt[binHead] = meas.Ldt;
        binAdt[binHead] = meas.Adt; binKEdt[binHead] = meas.KEdt; binNdt[binHead] = meas.Ndt; binDt[binHead] = meas.dt;
        binHead = (binHead + 1) % NBINS;
        if (binCount < NBINS) binCount++;
        meas.J = meas.hits = meas.Ldt = meas.Adt = meas.KEdt = meas.Ndt = meas.dt = 0;
    }
    function clearMeasurements() {
        meas.J = meas.hits = meas.Ldt = meas.Adt = meas.KEdt = meas.Ndt = meas.dt = 0;
        binHead = 0; binCount = 0;
        win.valid = false;
    }
    function computeWindow() {
        let J = meas.J, hits = meas.hits, Ldt = meas.Ldt, Adt = meas.Adt, KEdt = meas.KEdt, Ndt = meas.Ndt, dt = meas.dt;
        for (let b = 0; b < binCount; b++) {
            J += binJ[b]; hits += binHits[b]; Ldt += binLdt[b]; Adt += binAdt[b];
            KEdt += binKEdt[b]; Ndt += binNdt[b]; dt += binDt[b];
        }
        if (dt <= 0 || Ldt <= 0 || Adt <= 0) { win.valid = false; return; }
        win.P = J / Ldt;
        win.A = Adt / dt;
        win.KE = KEdt / dt;
        win.N = Ndt / dt;
        win.T = Ndt > 0 ? KEdt / (Ndt * KB) : 0;
        win.Pideal = win.KE / win.A;          // 2D ideal gas: P A = N k T = total kinetic energy
        win.ratio = win.KE > 0 ? win.P * win.A / win.KE : 0;
        win.hitRate = hits / dt;
        win.valid = dt > 0.25;
    }

    // Decorative outside air around the balloon (does not affect the physics: the
    // outside pressure acts on the membrane as the constant P_ATM).
    function initAir() {
        const sig = Math.sqrt(KB * S.Tset / mass);
        const R = bal.R + R_DRAW + 0.5;
        for (let k = 0; k < AIR_N; k++) {
            let x, y;
            let tries = 0;
            do {
                x = 1 + Math.random() * (REGION_W - 2);
                y = 1 + Math.random() * (WORLD_H - 2);
                tries++;
            } while ((x - BALLOON.cx) * (x - BALLOON.cx) + (y - BALLOON.cy) * (y - BALLOON.cy) < R * R && tries < 50);
            ax[k] = x; ay[k] = y;
            avx[k] = sig * gauss(); avy[k] = sig * gauss();
        }
    }
    function moveAir(dt) {
        const cx = BALLOON.cx, cy = BALLOON.cy;
        const R = bal.R + R_DRAW + 0.5, R2 = R * R, Rdot = bal.Rdot;
        for (let k = 0; k < AIR_N; k++) {
            let x = ax[k] + avx[k] * dt, y = ay[k] + avy[k] * dt;
            if (x < 0.5) { x = 1 - x; avx[k] = Math.abs(avx[k]); }
            else if (x > REGION_W - 0.5) { x = 2 * (REGION_W - 0.5) - x; avx[k] = -Math.abs(avx[k]); }
            if (y < 0.5) { y = 1 - y; avy[k] = Math.abs(avy[k]); }
            else if (y > WORLD_H - 0.5) { y = 2 * (WORLD_H - 0.5) - y; avy[k] = -Math.abs(avy[k]); }
            const dx = x - cx, dy = y - cy, d2 = dx * dx + dy * dy;
            if (d2 < R2) {
                const d = Math.sqrt(d2) || 1e-6;
                const ux = dx / d, uy = dy / d;
                const vr = avx[k] * ux + avy[k] * uy;
                if (vr < Rdot) {
                    const dv = 2 * (Rdot - vr);
                    avx[k] += dv * ux; avy[k] += dv * uy;
                }
                x = cx + ux * R; y = cy + uy * R;
            }
            ax[k] = x; ay[k] = y;
        }
    }
    function scaleAir(f) { for (let k = 0; k < AIR_N; k++) { avx[k] *= f; avy[k] *= f; } }

    // One frame of simulated time (also used by the test API, without rendering).
    function simulateFrame(dtSim) {
        if (dtSim <= 0) return;
        updateParticleCount(dtSim);
        const vmax = Math.sqrt(lastVmax2) + wallSpeed();
        let n = Math.ceil(vmax * dtSim / MAX_STEP_DIST);
        if (!(n >= 1)) n = 1; else if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
        const dt = dtSim / n;
        for (let s = 0; s < n; s++) physicsStep(dt);
        lastSubsteps = n;
        updateSectors(dtSim);
        returnDampedEnergy();
        rotateBins();
        if (isBalloon()) moveAir(dtSim);
        computeWindow();
        sampleCharts();
    }

    // ------------------------------------------------------------------
    // Reset / initialisation
    // ------------------------------------------------------------------
    function initState() {
        simTime = 0;
        mass = GASES[S.gas].m;
        setupGeometry();
        N = 0;
        const n = Math.min(MAX_N, S.Ntarget);
        for (let i = 0; i < n; i++) {
            placeRandomly(i);
            giveThermalVelocity(i, S.Tset);
        }
        N = n;
        recomputeVelocityStats();
        setupSectors();
        hitT.fill(-1e9);
        hitHead = 0;
        clearMeasurements();
        dampLoss = 0; pumpCarry = 0;
        trailHead = 0; trailLen = 0;
        initAir();
        clearChartData();
        gaugeDisplay = N * KB * S.Tset / area() * KPA;
        meanSpeed = Math.sqrt(Math.PI / 2 * KB * S.Tset / mass);
        updateRegionLabel();
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------
    let cssW = 0, cssH = 0, dpr = 1, scale = 1, offX = 0, offY = 0;
    // On narrow screens (not fullscreen) simulation_ui.js puts its buttons over the top-right of
    // the canvas, so the instrument panel moves to the left and the containers to the right.
    let flip = false;
    const narrowQuery = window.matchMedia ? window.matchMedia("(max-width: 768px)") : null;
    let fSmall = 3, fMed = 3.4, fBig = 4.6;
    let gaugeDisplay = 101.3;
    let meanSpeed = 0;
    let gaugeIdx = 0;
    const DASH_FOAM = [1.2, 0.9], DASH_NONE = [];
    let legendGradient = null;
    let regionLabel = '';
    let regionLabelColor = '#888';
    // Cached instrument strings (refreshed a few times per second)
    const txt = { gauge: '', ideal: '', outside: '', hits: '', speed: '', legend0: '', legend1: '', legend2: '' };

    function resizeCanvas() {
        const boxEl = canvas.parentElement;
        if (!boxEl) return false;
        const w = boxEl.clientWidth, h = boxEl.clientHeight;
        if (!w || !h) return false;
        const newDpr = Math.min(window.devicePixelRatio || 1, 3);
        const bw = Math.round(w * newDpr), bh = Math.round(h * newDpr);
        const newFlip = !!(narrowQuery && narrowQuery.matches) && !document.body.classList.contains('sim-fullscreen-active');
        const flipChanged = newFlip !== flip;
        flip = newFlip;
        if (flipChanged) legendGradient = null;
        if (bw === canvas.width && bh === canvas.height && w === cssW && h === cssH && newDpr === dpr) return flipChanged;
        dpr = newDpr; cssW = w; cssH = h;
        canvas.width = bw; canvas.height = bh;
        scale = Math.min(w / WORLD_W, h / WORLD_H);
        offX = (w - WORLD_W * scale) / 2;
        offY = (h - WORLD_H * scale) / 2;
        fSmall = Math.max(2.9, 9.5 / scale);
        fMed = Math.max(3.3, 10.5 / scale);
        fBig = Math.max(4.4, 12.5 / scale);
        return true;
    }
    function font(size, bold) {
        return (bold ? '700 ' : '400 ') + size.toFixed(2) + 'px "Source Sans Pro", Helvetica, Arial, sans-serif';
    }
    let fontSmall = '', fontSmallBold = '', fontMed = '', fontMedBold = '', fontBig = '';
    function refreshFonts() {
        fontSmall = font(fSmall, false); fontSmallBold = font(fSmall, true);
        fontMed = font(fMed, false); fontMedBold = font(fMed, true);
        fontBig = font(fBig, true);
    }

    function roundRectPath(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }
    // Arrow with its head at (hx, hy) pointing along (nx, ny).
    function arrowPath(hx, hy, nx, ny, L, hl) {
        ctx.moveTo(hx - nx * L, hy - ny * L);
        ctx.lineTo(hx, hy);
        const bx = -nx, by = -ny, c = 0.87, s = 0.5;
        ctx.moveTo(hx + hl * (bx * c - by * s), hy + hl * (bx * s + by * c));
        ctx.lineTo(hx, hy);
        ctx.lineTo(hx + hl * (bx * c + by * s), hy + hl * (-bx * s + by * c));
    }

    function wallColor() { return S.insulated ? pal.wallInsulated : colorForTemperature(S.Tset); }

    function updateRegionLabel() {
        if (S.container === 'balloon') regionLabel = S.insulated ? 'Insulated balloon' : 'Room air ' + S.Tset + ' K';
        else regionLabel = S.insulated ? 'Insulated walls' : 'Walls (heat bath) ' + S.Tset + ' K';
        regionLabelColor = S.insulated ? pal.textSub : colorForTemperature(S.Tset);
    }

    function drawParticles(r) {
        const k = NB * Math.sqrt(mass) / V_COL;
        bucketCount.fill(0);
        let speedSum = 0;
        for (let i = 0; i < N; i++) {
            const vx = pvx[i], vy = pvy[i];
            const sp = Math.sqrt(vx * vx + vy * vy);
            speedSum += sp;
            let b = (sp * k) | 0;
            if (b >= NB) b = NB - 1;
            pBucket[i] = b;
            bucketCount[b]++;
        }
        meanSpeed += ((N ? speedSum / N : 0) - meanSpeed) * 0.1;
        let acc = 0;
        for (let b = 0; b < NB; b++) { bucketStart[b] = acc; bucketCursor[b] = acc; acc += bucketCount[b]; }
        for (let i = 0; i < N; i++) order[bucketCursor[pBucket[i]]++] = i;
        for (let b = 0; b < NB; b++) {
            const cnt = bucketCount[b];
            if (!cnt) continue;
            ctx.fillStyle = bucketColor[b];
            ctx.beginPath();
            const end = bucketStart[b] + cnt;
            for (let jj = bucketStart[b]; jj < end; jj++) {
                const i = order[jj];
                const x = px[i], y = py[i];
                ctx.moveTo(x + r, y);
                ctx.arc(x, y, r, 0, TAU);
            }
            ctx.fill();
        }
    }

    function drawAir() {
        ctx.fillStyle = pal.air;
        ctx.beginPath();
        for (let k = 0; k < AIR_N; k++) {
            ctx.moveTo(ax[k] + 0.45, ay[k]);
            ctx.arc(ax[k], ay[k], 0.45, 0, TAU);
        }
        ctx.fill();
    }

    function drawTracer(r) {
        if (N === 0) return;
        trailX[trailHead] = px[0]; trailY[trailHead] = py[0];
        trailHead = (trailHead + 1) % TRAIL_N;
        if (trailLen < TRAIL_N) trailLen++;
        if (trailLen > 1) {
            ctx.lineWidth = Math.max(0.25, 1 / scale);
            const seg = 6;
            for (let s0 = 0; s0 < trailLen - 1; s0 += seg) {
                const alpha = 0.08 + 0.5 * (s0 + seg) / trailLen;
                ctx.strokeStyle = 'rgba(' + pal.trailRGB + ',' + Math.min(0.6, alpha).toFixed(2) + ')';
                ctx.beginPath();
                const sEnd = Math.min(trailLen - 1, s0 + seg);
                for (let s = s0; s <= sEnd; s++) {
                    const idx = (trailHead - trailLen + s + TRAIL_N) % TRAIL_N;
                    if (s === s0) ctx.moveTo(trailX[idx], trailY[idx]); else ctx.lineTo(trailX[idx], trailY[idx]);
                }
                ctx.stroke();
            }
        }
        ctx.strokeStyle = pal.tracer;
        ctx.lineWidth = Math.max(0.3, 1.2 / scale);
        ctx.beginPath();
        ctx.arc(px[0], py[0], r + 1.1, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = pal.tracer;
        ctx.beginPath();
        ctx.arc(px[0], py[0], r * 1.15, 0, TAU);
        ctx.fill();
    }

    function drawValve(x, y, horizontal) {
        const on = performance.now() < valveFlashUntil;
        ctx.fillStyle = on ? pal.valveOn : pal.metalEdge;
        ctx.beginPath();
        ctx.arc(x, y, 1.3, 0, TAU);
        ctx.fill();
        if (horizontal) ctx.fillRect(x - 0.3, y - 2.4, 0.6, 1.4);
        else ctx.fillRect(x + 1.0, y - 0.3, 1.4, 0.6);
    }

    function drawBalloonBack() {
        const R = bal.R + R_DRAW;
        ctx.fillStyle = pal.rubberFill;
        ctx.beginPath();
        ctx.arc(BALLOON.cx, BALLOON.cy, R, 0, TAU);
        ctx.fill();
    }
    function balloonLineWidth() {
        return Math.min(1.5, Math.max(0.55, 1.5 * Math.sqrt(BALLOON.R0 / Math.max(bal.R, 1)) - 0.25));
    }
    function drawBalloonFront() {
        const cx = BALLOON.cx, cy = BALLOON.cy, R = bal.R + R_DRAW;
        const lw = balloonLineWidth();
        ctx.strokeStyle = pal.rubber;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.arc(cx, cy, R + lw / 2, 0, TAU);
        ctx.stroke();
        // knot and string
        const ky = cy + R + lw;
        ctx.fillStyle = pal.rubber;
        ctx.beginPath();
        ctx.moveTo(cx - 1.3, ky + 2.0);
        ctx.lineTo(cx + 1.3, ky + 2.0);
        ctx.lineTo(cx, ky - 0.3);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = pal.textSub;
        ctx.lineWidth = Math.max(0.25, 0.9 / scale);
        ctx.beginPath();
        ctx.moveTo(cx, ky + 2.0);
        ctx.quadraticCurveTo(cx + 3, ky + 5, cx + 1, WORLD_H + 1);
        ctx.stroke();
        if (performance.now() < valveFlashUntil) {
            ctx.fillStyle = pal.valveOn;
            ctx.beginPath();
            ctx.arc(cx, ky + 1.0, 0.9, 0, TAU);
            ctx.fill();
        }
    }

    // pathFn(o) adds the wall outline offset by `o` outwards from the physics boundary.
    function strokeWalls(pathFn) {
        ctx.lineWidth = WALL_T;
        ctx.strokeStyle = wallColor();
        ctx.lineJoin = 'miter';
        ctx.beginPath();
        pathFn(R_DRAW + WALL_T / 2);
        ctx.stroke();
        if (S.insulated) {
            ctx.lineWidth = 1.1;
            ctx.strokeStyle = pal.foam;
            ctx.setLineDash(DASH_FOAM);
            ctx.beginPath();
            pathFn(R_DRAW + WALL_T + 0.75);
            ctx.stroke();
            ctx.setLineDash(DASH_NONE);
        }
    }

    function drawRigidBox() {
        const x0 = box.x0, x1 = box.x1, y0 = box.y0, y1 = box.y1;
        strokeWalls((e) => {
            ctx.rect(x0 - e, y0 - e, (x1 - x0) + 2 * e, (y1 - y0) + 2 * e);
        });
        // inlet pipe on the left wall
        const yc = 0.5 * (y0 + y1);
        const xOut = x0 - R_DRAW - WALL_T - (S.insulated ? 1.4 : 0);
        ctx.fillStyle = pal.metal;
        ctx.fillRect(xOut - 7, yc - 1.2, 7, 2.4);
        drawValve(xOut - 4, yc, true);
    }

    function drawSyringe() {
        const x0 = box.x0, y0 = box.y0, y1 = box.y1, X = box.x1;
        const end = SYRINGE.barrelEnd;
        // glass interior tint
        ctx.fillStyle = pal.glass;
        ctx.fillRect(x0 - R_DRAW, y0 - R_DRAW, end - x0 + R_DRAW, (y1 - y0) + 2 * R_DRAW);
        strokeWalls((e) => {
            ctx.moveTo(end, y0 - e);
            ctx.lineTo(x0 - e, y0 - e);
            ctx.lineTo(x0 - e, y1 + e);
            ctx.lineTo(end, y1 + e);
        });
        // finger flanges
        ctx.fillStyle = wallColor();
        const fe = R_DRAW + WALL_T;
        ctx.fillRect(end - 0.5, y0 - fe - 6, 2.2, 6 + WALL_T);
        ctx.fillRect(end - 0.5, y1 + fe - WALL_T, 2.2, 6 + WALL_T);
        // nozzle + valve (inlet)
        const yc = 0.5 * (y0 + y1);
        const xOut = x0 - R_DRAW - WALL_T - (S.insulated ? 1.4 : 0);
        ctx.fillStyle = pal.metal;
        ctx.fillRect(xOut - 6, yc - 1.4, 6, 2.8);
        drawValve(xOut - 3.5, yc, true);
        // volume graduations
        ctx.strokeStyle = pal.textSub;
        ctx.lineWidth = Math.max(0.2, 0.8 / scale);
        ctx.fillStyle = pal.textSub;
        ctx.font = fontSmall;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const yTick = y1 + R_DRAW + WALL_T + (S.insulated ? 1.6 : 0);
        ctx.beginPath();
        for (let v = 3; v <= 9; v++) {
            const xv = syringeXForVolume(v / 10);
            ctx.moveTo(xv, yTick); ctx.lineTo(xv, yTick + (v % 2 === 0 ? 2.2 : 1.3));
        }
        ctx.stroke();
        for (let v = 4; v <= 8; v += 2) ctx.fillText((v / 10).toFixed(1) + ' L', syringeXForVolume(v / 10), yTick + 2.6 + fSmall);
        // plunger: rubber stopper, rod and thumb plate
        const sx = X + R_DRAW;
        ctx.fillStyle = pal.stopper;
        ctx.fillRect(sx, y0 - R_DRAW, 3.5, (y1 - y0) + 2 * R_DRAW);
        ctx.fillStyle = pal.rod;
        const thumbX = X + SYRINGE.rod;
        ctx.fillRect(sx + 3.5, yc - 1.6, thumbX - sx - 3.5, 3.2);
        ctx.fillStyle = pal.stopper;
        ctx.fillRect(thumbX, yc - 13, 2.4, 26);
        if (!hasDragged) {
            ctx.fillStyle = pal.textSub;
            ctx.font = fontSmall;
            ctx.textAlign = 'center';
            ctx.fillText('↔ drag', thumbX - 7, yc - 14.5);
        }
    }

    function drawPiston() {
        const x0 = box.x0, x1 = box.x1, Y = box.y0, y1 = box.y1;
        const P = PISTON;
        strokeWalls((e) => {
            ctx.moveTo(x0 - e, 3);
            ctx.lineTo(x0 - e, y1 + e);
            ctx.lineTo(x1 + e, y1 + e);
            ctx.lineTo(x1 + e, 3);
        });
        // stops at the top of travel
        const stopY = P.yTop - R_DRAW - P.slab;
        ctx.fillStyle = pal.metalEdge;
        ctx.beginPath();
        ctx.moveTo(x0 - R_DRAW, stopY - 1.6); ctx.lineTo(x0 + 1.4, stopY - 1.6); ctx.lineTo(x0 - R_DRAW, stopY - 3.6); ctx.closePath();
        ctx.moveTo(x1 + R_DRAW, stopY - 1.6); ctx.lineTo(x1 - 1.4, stopY - 1.6); ctx.lineTo(x1 + R_DRAW, stopY - 3.6); ctx.closePath();
        ctx.fill();
        // piston slab
        const top = Y - R_DRAW - P.slab;
        ctx.fillStyle = pal.metal;
        ctx.fillRect(x0 - R_DRAW, top, (x1 - x0) + 2 * R_DRAW, P.slab);
        ctx.fillStyle = wallColor();
        ctx.fillRect(x0 - R_DRAW, Y - R_DRAW - 0.8, (x1 - x0) + 2 * R_DRAW, 0.8);
        // weights
        const cx = 0.5 * (x0 + x1);
        const showText = fSmall * scale >= 9 && fSmall < P.weightH;
        for (let k = 0; k < S.weights; k++) {
            const wy = top - (k + 1) * (P.weightH + 0.4);
            ctx.fillStyle = pal.weight;
            roundRectPath(cx - 17, wy, 34, P.weightH, 0.8);
            ctx.fill();
            if (showText) {
                ctx.fillStyle = pal.weightText;
                ctx.font = fontSmall;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('+50 kPa', cx, wy + P.weightH / 2 + 0.2);
            }
        }
        ctx.textBaseline = 'alphabetic';
        // inlet at the bottom
        const yOut = y1 + R_DRAW + WALL_T + (S.insulated ? 1.4 : 0);
        ctx.fillStyle = pal.metal;
        ctx.fillRect(cx - 1.2, yOut, 2.4, WORLD_H - yOut + 1);
        drawValve(cx, Math.min(WORLD_H - 2, yOut + 3.2), false);
    }

    // Time-averaged pressure on each wall section: arrows inside the gas pressing on the wall.
    // Length is proportional to pressure, capped (the same cap for every wall, so equal
    // pressures always look equal) so that arrows never reach the middle of the container.
    function drawAvgArrows() {
        const hl = 1.8;
        ctx.lineWidth = 1.15;
        ctx.lineCap = 'round';
        ctx.strokeStyle = pal.avgArrow;
        ctx.beginPath();
        if (isBalloon()) {
            const cx = BALLOON.cx, cy = BALLOON.cy, hr = bal.R + R_DRAW * 0.6;
            const cap = Math.min(AVG_MAX, 0.55 * bal.R);
            for (let k = 0; k < nSectors; k++) {
                let L = secP[k] * AVG_SCALE;
                if (L > cap) L = cap;
                if (L < 0.5) continue;
                arrowPath(cx + secCos[k] * hr, cy + secSin[k] * hr, secCos[k], secSin[k], L, Math.min(hl, 0.45 * L));
            }
            ctx.stroke();
            // outside air pushing in
            const ro = bal.R + R_DRAW + balloonLineWidth() + 0.2;
            const Lo = Math.min(AVG_MAX, P_ATM * AVG_SCALE);
            ctx.strokeStyle = pal.outArrow;
            ctx.beginPath();
            for (let k = 0; k < nSectors; k++) {
                arrowPath(cx + outCos[k] * ro, cy + outSin[k] * ro, -outCos[k], -outSin[k], Lo, hl);
            }
            ctx.stroke();
        } else {
            const x0 = box.x0, x1 = box.x1, y0 = box.y0, y1 = box.y1;
            const w = x1 - x0, h = y1 - y0;
            const cap = Math.min(AVG_MAX, 0.4 * Math.min(w, h));
            for (let wall = 0; wall < 4; wall++) {
                const n = segCount[wall], s0 = segStart[wall];
                for (let s = 0; s < n; s++) {
                    let L = secP[s0 + s] * AVG_SCALE;
                    if (L > cap) L = cap;
                    if (L < 0.5) continue;
                    const f = (s + 0.5) / n;
                    const hh = Math.min(hl, 0.45 * L);
                    if (wall === 0) arrowPath(x0 - R_DRAW * 0.6, y0 + f * h, -1, 0, L, hh);
                    else if (wall === 1) arrowPath(x1 + R_DRAW * 0.6, y0 + f * h, 1, 0, L, hh);
                    else if (wall === 2) arrowPath(x0 + f * w, y0 - R_DRAW * 0.6, 0, -1, L, hh);
                    else arrowPath(x0 + f * w, y1 + R_DRAW * 0.6, 0, 1, L, hh);
                }
            }
            ctx.stroke();
        }
        ctx.lineCap = 'butt';
    }

    function drawHitArrows() {
        const now = simTime;
        ctx.lineWidth = 0.42;
        ctx.lineCap = 'round';
        for (let q = 0; q < 4; q++) {
            const aMin = q / 4, aMax = (q + 1) / 4;
            ctx.strokeStyle = 'rgba(' + pal.hitRGB + ',' + (0.25 + 0.75 * aMax).toFixed(2) + ')';
            ctx.beginPath();
            let any = false;
            for (let k = 0; k < HIT_CAP; k++) {
                const age = now - hitT[k];
                if (age < 0 || age >= HIT_LIFE) continue;
                const a = 1 - age / HIT_LIFE;
                if (a <= aMin || a > aMax) continue;
                const L = hitL[k];
                arrowPath(hitX[k], hitY[k], hitNX[k], hitNY[k], L, Math.min(1.2, 0.4 * L));
                any = true;
            }
            if (any) ctx.stroke();
        }
        ctx.lineCap = 'butt';
    }

    function drawGauge(cx, cy, r) {
        const a0 = 0.75 * Math.PI, sweep = 1.5 * Math.PI;
        const range = GAUGE_RANGES[gaugeIdx];
        ctx.fillStyle = pal.gaugeFace;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, TAU);
        ctx.fill();
        ctx.lineWidth = 0.9;
        ctx.strokeStyle = pal.gaugeRim;
        ctx.stroke();
        // ticks
        ctx.strokeStyle = pal.textSub;
        ctx.lineWidth = Math.max(0.2, 0.9 / scale);
        ctx.beginPath();
        for (let i = 0; i <= 20; i++) {
            const a = a0 + sweep * i / 20;
            const major = i % 5 === 0;
            const c = Math.cos(a), s = Math.sin(a);
            const r1 = r * 0.9, r2 = r * (major ? 0.74 : 0.82);
            ctx.moveTo(cx + c * r1, cy + s * r1);
            ctx.lineTo(cx + c * r2, cy + s * r2);
        }
        ctx.stroke();
        // labels
        ctx.fillStyle = pal.textSub;
        ctx.font = fontSmall;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const roomy = fSmall < r * 0.2;
        for (let i = 0; i <= 4; i++) {
            if (!roomy && (i === 0 || i === 4)) continue;   // small gauge: keep the bottom free for the readout
            const a = a0 + sweep * i / 4;
            const rl = r * 0.55;
            ctx.fillText(String(range * i / 4), cx + Math.cos(a) * rl, cy + Math.sin(a) * rl);
        }
        // outside / external pressure marker
        const Pext = externalPressure();
        if (Pext > 0) {
            const v = Math.min(1, Pext * KPA / range);
            const a = a0 + sweep * v;
            ctx.strokeStyle = pal.outSolid;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(a) * r * 0.93, cy + Math.sin(a) * r * 0.93);
            ctx.lineTo(cx + Math.cos(a) * r * 1.0, cy + Math.sin(a) * r * 1.0);
            ctx.stroke();
        }
        // ideal-gas prediction marker
        if (win.valid) {
            const v = Math.min(1.03, win.Pideal * KPA / range);
            const a = a0 + sweep * v;
            const c = Math.cos(a), s = Math.sin(a);
            const tip = r * 0.9, base = r * 1.12, half = 0.11;
            ctx.fillStyle = pal.ideal;
            ctx.beginPath();
            ctx.moveTo(cx + c * tip, cy + s * tip);
            ctx.lineTo(cx + Math.cos(a - half) * base, cy + Math.sin(a - half) * base);
            ctx.lineTo(cx + Math.cos(a + half) * base, cy + Math.sin(a + half) * base);
            ctx.closePath();
            ctx.fill();
        }
        // needle
        const v = Math.max(0, Math.min(1.04, gaugeDisplay / range));
        const a = a0 + sweep * v;
        ctx.strokeStyle = pal.needle;
        ctx.lineWidth = 0.85;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - Math.cos(a) * r * 0.12, cy - Math.sin(a) * r * 0.12);
        ctx.lineTo(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8);
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.fillStyle = pal.needle;
        ctx.beginPath();
        ctx.arc(cx, cy, 1.3, 0, TAU);
        ctx.fill();
        // digital readout
        ctx.fillStyle = pal.text;
        ctx.font = roomy ? fontMedBold : fontSmallBold;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(txt.gauge, cx, cy + r * 0.68);
    }

    function drawLegend(x, y, w) {
        if (!legendGradient) {
            legendGradient = ctx.createLinearGradient(x, 0, x + w, 0);
            for (let i = 0; i <= 10; i++) legendGradient.addColorStop(i / 10, rgb(colorAt(i / 10)));
        }
        ctx.fillStyle = pal.textSub;
        ctx.font = fontSmall;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('Particle speed (m/s)', x + w / 2, y - 1.2);
        ctx.fillStyle = legendGradient;
        ctx.fillRect(x, y, w, 3.2);
        // mean-speed marker for the current gas temperature
        if (win.valid) {
            const t = Math.min(1, tempT(win.T));
            const mx = x + t * w;
            ctx.fillStyle = pal.text;
            ctx.beginPath();
            ctx.moveTo(mx, y + 3.4); ctx.lineTo(mx - 1.2, y + 5.4); ctx.lineTo(mx + 1.2, y + 5.4); ctx.closePath();
            ctx.fill();
        }
        ctx.fillStyle = pal.textSub;
        const ly = y + 5.6 + fSmall;
        ctx.textAlign = 'left'; ctx.fillText(txt.legend0, x, ly);
        ctx.textAlign = 'center'; ctx.fillText(txt.legend1, x + w / 2, ly);
        ctx.textAlign = 'right'; ctx.fillText(txt.legend2, x + w, ly);
    }

    function drawInstruments(x0) {
        const x1 = x0 + (WORLD_W - 1.5 - INSTR_X), w = x1 - x0, cx = x0 + w / 2;
        ctx.fillStyle = pal.panelBg;
        roundRectPath(x0, 1.5, w, WORLD_H - 3, 2.5);
        ctx.fill();
        ctx.strokeStyle = pal.panelBorder;
        ctx.lineWidth = Math.max(0.2, 1 / scale);
        ctx.stroke();

        ctx.fillStyle = pal.textSub;
        ctx.font = fontSmallBold;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('PRESSURE GAUGE', cx, 4 + fSmall);

        const gr = Math.min(17, w / 2 - 6);
        const gcy = 8 + fSmall + gr;
        drawGauge(cx, gcy, gr);

        let y = gcy + gr + 2 + fSmall;
        const lh = fSmall * 1.35;
        ctx.font = fontSmall;
        ctx.textAlign = 'left';
        const tx = x0 + 3;
        // ideal marker key
        ctx.fillStyle = pal.ideal;
        ctx.beginPath();
        ctx.moveTo(tx, y - fSmall * 0.75); ctx.lineTo(tx + 2.2, y - fSmall * 0.75); ctx.lineTo(tx + 1.1, y - fSmall * 0.1); ctx.closePath();
        ctx.fill();
        ctx.fillStyle = pal.text;
        ctx.fillText(txt.ideal, tx + 3.4, y);
        y += lh;
        if (externalPressure() > 0) {
            ctx.fillStyle = pal.outSolid;
            ctx.fillRect(tx + 0.4, y - fSmall * 0.75, 1.4, fSmall * 0.65);
            ctx.fillStyle = pal.text;
            ctx.fillText(txt.outside, tx + 3.4, y);
            y += lh;
        }
        ctx.fillStyle = pal.textSub;
        ctx.fillText(txt.hits, tx + 3.4, y);
        y += lh;
        ctx.fillText(txt.speed, tx + 3.4, y);

        drawLegend(x0 + 4, WORLD_H - 8.5 - fSmall * 1.8, w - 8);
    }

    function render() {
        if (!pal || !cssW) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = pal.bg;
        ctx.fillRect(0, 0, cssW, cssH);
        ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offX, dpr * offY);

        ctx.save();
        if (flip) ctx.translate(REGION_SHIFT, 0);
        ctx.beginPath();
        ctx.rect(0, 0, INSTR_X - 1, WORLD_H);
        ctx.clip();

        const c = S.container;
        if (c === 'balloon') { drawAir(); drawBalloonBack(); }
        const r = Math.max(R_DRAW, 1.15 / scale);
        drawParticles(r);
        if (S.tracer) drawTracer(r);
        if (c === 'balloon') drawBalloonFront();
        else if (c === 'box') drawRigidBox();
        else if (c === 'syringe') drawSyringe();
        else drawPiston();
        if (S.avgArrows) drawAvgArrows();
        if (S.hitArrows) drawHitArrows();

        ctx.font = fontSmallBold;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = regionLabelColor;
        ctx.fillText(regionLabel, 2, 2 + fSmall);
        ctx.restore();

        drawInstruments(flip ? 1.5 : INSTR_X);
    }

    // ------------------------------------------------------------------
    // Text readouts (throttled)
    // ------------------------------------------------------------------
    function formatKpa(p) { return p >= 1000 ? p.toFixed(0) : p >= 100 ? p.toFixed(1) : p.toFixed(1); }
    function roundNice(v) { return v >= 1000 ? Math.round(v / 50) * 50 : Math.round(v / 10) * 10; }
    function updateReadouts() {
        const Pk = win.valid ? win.P * KPA : NaN;
        txt.gauge = win.valid ? formatKpa(gaugeDisplay) + ' kPa' : '– kPa';
        txt.ideal = 'ideal NkT/V: ' + (win.valid ? formatKpa(win.Pideal * KPA) : '–') + ' kPa';
        const Pext = externalPressure();
        if (S.container === 'balloon') txt.outside = 'outside air: ' + formatKpa(Pext * KPA) + ' kPa';
        else if (S.container === 'piston') txt.outside = 'atm + weights: ' + formatKpa(Pext * KPA) + ' kPa';
        txt.hits = 'wall hits: ' + (win.valid ? Math.round(win.hitRate) : '–') + ' /s';
        txt.speed = 'average speed: ' + Math.round(meanSpeed * SPEED_TO_MS) + ' m/s';
        const vTop = V_COL / Math.sqrt(mass) * SPEED_TO_MS;
        txt.legend0 = '0';
        txt.legend1 = String(roundNice(vTop / 2));
        txt.legend2 = String(roundNice(vTop));
        if (ui.statP) ui.statP.textContent = win.valid ? formatKpa(Pk) : '–';
        if (ui.statV) ui.statV.textContent = (area() / A_REF).toFixed(2);
        if (ui.statT) ui.statT.textContent = win.valid ? Math.round(win.T).toString() : '–';
        if (ui.statN) ui.statN.textContent = String(N);
        if (ui.statZ) ui.statZ.textContent = win.valid ? win.ratio.toFixed(2) : '–';
        if (S.container === 'syringe' && ui.volume && ui.volumeVal && dragging) {
            const V = syringeVolumeForX(syringeTarget);
            ui.volume.value = V.toFixed(2);
            ui.volumeVal.textContent = V.toFixed(2);
        }
    }
    function updateGaugeRange(v) {
        while (gaugeIdx < GAUGE_RANGES.length - 1 && v > GAUGE_RANGES[gaugeIdx] * 0.97) gaugeIdx++;
        while (gaugeIdx > 0 && v < GAUGE_RANGES[gaugeIdx - 1] * 0.75) gaugeIdx--;
    }

    // ------------------------------------------------------------------
    // Charts (Chart.js 3.9.1, behind the chart toggle)
    // ------------------------------------------------------------------
    let pressureChart = null, lawChart = null;
    const series = { meas: [], ideal: [], outside: [] };
    const lawPts = [], lawLine = [];
    let lastSeriesT = -1e9, lastLawT = -1e9, lastChartDraw = 0;
    const SERIES_DT = 0.25, LAW_DT = 0.5, SERIES_SPAN = 60, MAX_LAW_PTS = 400;
    const LAW_DEFS = {
        PV: { title: 'Pressure vs volume (Boyle)', x: 'Volume (L)', y: 'Pressure (kPa)' },
        PT: { title: 'Pressure vs temperature (Gay-Lussac)', x: 'Temperature (K)', y: 'Pressure (kPa)' },
        VT: { title: 'Volume vs temperature (Charles)', x: 'Temperature (K)', y: 'Volume (L)' },
        PN: { title: 'Pressure vs number of particles', x: 'Particles N', y: 'Pressure (kPa)' }
    };
    const AUTO_MODE = { balloon: 'VT', box: 'PT', syringe: 'PV', piston: 'VT' };
    function lawMode() { return S.graphMode === 'auto' ? AUTO_MODE[S.container] : S.graphMode; }
    function chartsAvailable() { return typeof window.Chart !== 'undefined'; }
    function chartsVisible() { return !!(ui.showCharts && ui.showCharts.checked); }

    function clearChartData() {
        series.meas.length = 0; series.ideal.length = 0; series.outside.length = 0;
        lawPts.length = 0; lawLine.length = 0;
        lastSeriesT = -1e9; lastLawT = -1e9;
        if (pressureChart || lawChart) redrawCharts(true);
    }
    function lawPoint(mode) {
        const P = win.P * KPA, V = win.A / A_REF;
        if (mode === 'PV') return { x: V, y: P };
        if (mode === 'PT') return { x: win.T, y: P };
        if (mode === 'VT') return { x: win.T, y: V };
        return { x: win.N, y: P };
    }
    function sampleCharts() {
        if (!win.valid) return;
        if (simTime - lastSeriesT >= SERIES_DT) {
            lastSeriesT = simTime;
            const t = +simTime.toFixed(2);
            series.meas.push({ x: t, y: win.P * KPA });
            series.ideal.push({ x: t, y: win.Pideal * KPA });
            const Pext = externalPressure();
            if (Pext > 0) series.outside.push({ x: t, y: Pext * KPA });
            const tMin = simTime - SERIES_SPAN;
            while (series.meas.length && series.meas[0].x < tMin) series.meas.shift();
            while (series.ideal.length && series.ideal[0].x < tMin) series.ideal.shift();
            while (series.outside.length && series.outside[0].x < tMin) series.outside.shift();
        }
        if (simTime - lastLawT >= LAW_DT) {
            lastLawT = simTime;
            lawPts.push(lawPoint(lawMode()));
            if (lawPts.length > MAX_LAW_PTS) lawPts.shift();
        }
    }
    function computeLawLine(mode) {
        lawLine.length = 0;
        if (!win.valid) return;
        let xMax = 0, xMin = Infinity;
        for (let i = 0; i < lawPts.length; i++) { const x = lawPts[i].x; if (x > xMax) xMax = x; if (x < xMin) xMin = x; }
        if (mode === 'PV') {
            const V = win.A / A_REF;
            xMin = Math.max(0.05, Math.min(xMin, V) * 0.8);
            xMax = Math.max(xMax, V) * 1.15;
            for (let i = 0; i <= 30; i++) {
                const x = xMin + (xMax - xMin) * i / 30;
                lawLine.push({ x: x, y: win.KE / (x * A_REF) * KPA });
            }
        } else {
            let top;
            if (mode === 'PN') top = Math.max(xMax, win.N) * 1.15;
            else top = Math.max(xMax, win.T, 100) * 1.15;
            let slope;
            if (mode === 'PT') slope = win.N * KB / win.A * KPA;
            else if (mode === 'VT') slope = win.N * KB / win.P / A_REF;
            else slope = KB * win.T / win.A * KPA;
            lawLine.push({ x: 0, y: 0 });
            lawLine.push({ x: top, y: slope * top });
        }
    }
    function axisOpts(title) {
        return {
            type: 'linear',
            beginAtZero: true,
            title: { display: true, text: title, color: pal.textSub },
            ticks: { color: pal.textSub, maxTicksLimit: 7 },
            grid: { color: pal.grid }
        };
    }
    function baseOptions(title, xTitle, yTitle) {
        return {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: { display: true, text: title, color: pal.text },
                legend: { labels: { color: pal.text, boxWidth: 12, font: { size: 10 }, filter: (item) => !item.hidden } },
                tooltip: { enabled: true }
            },
            scales: { x: axisOpts(xTitle), y: axisOpts(yTitle) }
        };
    }
    function setupCharts() {
        if (!chartsAvailable()) return;
        const c1 = byId('pressureChart'), c2 = byId('lawChart');
        if (!c1 || !c2) return;
        if (pressureChart) pressureChart.destroy();
        if (lawChart) lawChart.destroy();
        const o1 = baseOptions('Pressure over time', 'Simulation time (s)', 'Pressure (kPa)');
        o1.scales.x.beginAtZero = false;
        pressureChart = new window.Chart(c1, {
            type: 'line',
            data: {
                datasets: [
                    { label: 'Measured', data: series.meas, borderColor: pal.accent, backgroundColor: pal.accent, borderWidth: 2, pointRadius: 0, tension: 0.15 },
                    { label: 'Ideal NkT/V', data: series.ideal, borderColor: pal.ideal, backgroundColor: pal.ideal, borderWidth: 1.2, borderDash: [5, 4], pointRadius: 0 },
                    { label: 'Outside', data: series.outside, borderColor: pal.outSolid, backgroundColor: pal.outSolid, borderWidth: 1.2, borderDash: [2, 3], pointRadius: 0 }
                ]
            },
            options: o1
        });
        const mode = lawMode();
        const d = LAW_DEFS[mode];
        lawChart = new window.Chart(c2, {
            type: 'scatter',
            data: {
                datasets: [
                    { label: 'Measured', data: lawPts, borderColor: pal.accent, backgroundColor: 'rgba(242,132,158,0.55)', pointRadius: 2.2 },
                    { label: 'Ideal gas law', data: lawLine, borderColor: pal.ideal, backgroundColor: pal.ideal, borderDash: [5, 4], borderWidth: 1.2, showLine: true, pointRadius: 0 }
                ]
            },
            options: baseOptions(d.title, d.x, d.y)
        });
        lawChart.$mode = mode;
        redrawCharts(true);
    }
    function applyChartTheme() {
        [pressureChart, lawChart].forEach((ch) => {
            if (!ch) return;
            const o = ch.options;
            o.plugins.title.color = pal.text;
            o.plugins.legend.labels.color = pal.text;
            ['x', 'y'].forEach((ax) => {
                o.scales[ax].title.color = pal.textSub;
                o.scales[ax].ticks.color = pal.textSub;
                o.scales[ax].grid.color = pal.grid;
            });
        });
        if (pressureChart) {
            const ds = pressureChart.data.datasets;
            ds[1].borderColor = ds[1].backgroundColor = pal.ideal;
            ds[2].borderColor = ds[2].backgroundColor = pal.outSolid;
        }
        if (lawChart) {
            const ds = lawChart.data.datasets;
            ds[1].borderColor = ds[1].backgroundColor = pal.ideal;
        }
        redrawCharts(true);
    }
    function redrawCharts(force) {
        if (!chartsVisible() || !pressureChart || !lawChart) return;
        const now = performance.now();
        if (!force && now - lastChartDraw < 300) return;
        lastChartDraw = now;
        const sx = pressureChart.options.scales.x;
        sx.min = Math.max(0, Math.floor(simTime - SERIES_SPAN));
        sx.max = Math.max(10, Math.ceil(simTime));
        pressureChart.data.datasets[2].hidden = series.outside.length === 0;
        pressureChart.update('none');
        const mode = lawMode();
        if (lawChart.$mode !== mode) {
            const d = LAW_DEFS[mode];
            lawChart.options.plugins.title.text = d.title;
            lawChart.options.scales.x.title.text = d.x;
            lawChart.options.scales.y.title.text = d.y;
            lawChart.$mode = mode;
        }
        computeLawLine(mode);
        lawChart.update('none');
    }
    function onChartsToggle() {
        const show = chartsVisible();
        if (ui.chartsContainer) ui.chartsContainer.style.display = show ? 'block' : 'none';
        document.body.classList.toggle('charts-visible', show);
        if (show) {
            if (!pressureChart || !lawChart) setupCharts();
            else redrawCharts(true);
        }
    }

    // ------------------------------------------------------------------
    // Main loop
    // ------------------------------------------------------------------
    let rafId = 0, lastTs = 0;
    let fpsFrames = 0, fpsLast = 0;
    let lastReadout = 0;
    const perf = { phys: 0, render: 0, frame: 0, worstFrame: 0, samples: 0 };

    function frame(ts) {
        rafId = requestAnimationFrame(frame);
        const t0 = performance.now();
        let realDt = lastTs ? (ts - lastTs) / 1000 : 1 / 60;
        lastTs = ts;
        if (!(realDt > 0)) realDt = 0;
        if (realDt > MAX_FRAME_DT) realDt = MAX_FRAME_DT;

        if (!S.paused) simulateFrame(realDt * S.speed);
        const t1 = performance.now();

        if (win.valid) {
            const target = win.P * KPA;
            gaugeDisplay += (target - gaugeDisplay) * (1 - Math.exp(-realDt / 0.2));
            updateGaugeRange(Math.max(gaugeDisplay, win.Pideal * KPA, externalPressure() * KPA));
        }
        if (t0 - lastReadout > 200) {
            lastReadout = t0;
            updateReadouts();
        }
        render();
        const t2 = performance.now();
        redrawCharts(false);

        const a = 0.05;
        perf.phys += ((t1 - t0) - perf.phys) * a;
        perf.render += ((t2 - t1) - perf.render) * a;
        perf.frame += ((t2 - t0) - perf.frame) * a;
        if (t2 - t0 > perf.worstFrame) perf.worstFrame = t2 - t0;
        perf.samples++;

        fpsFrames++;
        if (ts - fpsLast >= 1000) {
            const fps = fpsFrames * 1000 / (ts - fpsLast);
            if (ui.fps) ui.fps.textContent = 'FPS: ' + fps.toFixed(0) + ' | ' + perf.frame.toFixed(1) + ' ms';
            perf.fps = fps;
            fpsFrames = 0;
            fpsLast = ts;
        }
    }
    function startLoop() {
        if (rafId) return;
        lastTs = 0;
        fpsLast = performance.now();
        rafId = requestAnimationFrame(frame);
    }

    // ------------------------------------------------------------------
    // Controls
    // ------------------------------------------------------------------
    function syncContainerControls() {
        if (ui.volumeGroup) ui.volumeGroup.hidden = S.container !== 'syringe';
        if (ui.weightsGroup) ui.weightsGroup.hidden = S.container !== 'piston';
        if (S.container === 'syringe' && ui.volume) {
            ui.volume.value = S.syringeV.toFixed(2);
            if (ui.volumeVal) ui.volumeVal.textContent = S.syringeV.toFixed(2);
        }
    }
    function syncInsulatedControls() {
        if (ui.temp) ui.temp.disabled = S.insulated;
        if (ui.tempLabel) ui.tempLabel.classList.toggle('is-disabled', S.insulated);
        if (ui.insulatedNote) ui.insulatedNote.hidden = !S.insulated;
    }
    function setContainer(type) {
        if (!AUTO_MODE[type]) return;
        S.container = type;
        if (ui.container && ui.container.value !== type) ui.container.value = type;
        hasDragged = false;
        syncContainerControls();
        initState();
        if (lawChart) lawChart.$mode = null;
    }
    function setTemperature(T) {
        T = Math.max(50, Math.min(1000, Math.round(T)));
        if (T === S.Tset) return;
        scaleAir(Math.sqrt(T / S.Tset));
        S.Tset = T;
        if (ui.temp && +ui.temp.value !== T) ui.temp.value = T;
        if (ui.tempVal) ui.tempVal.textContent = T;
        updateRegionLabel();
    }
    function setParticleCount(n, immediate) {
        n = Math.max(1, Math.min(MAX_N, Math.round(n)));
        S.Ntarget = n;
        if (ui.count && +ui.count.value !== n) ui.count.value = n;
        if (ui.countVal) ui.countVal.textContent = n;
        if (immediate) {
            while (N < n) injectParticle(true);
            while (N > n) removeParticle();
        }
    }
    function setVolume(V) {
        V = Math.max(syringeVolumeForX(SYRINGE.xMin), Math.min(syringeVolumeForX(SYRINGE.xMax), V));
        S.syringeV = V;
        syringeTarget = clampSyringeX(syringeXForVolume(V));
        if (ui.volume && Math.abs(+ui.volume.value - V) > 0.004) ui.volume.value = V.toFixed(2);
        if (ui.volumeVal) ui.volumeVal.textContent = V.toFixed(2);
    }
    function setWeights(n) {
        S.weights = Math.max(0, Math.min(4, Math.round(n)));
        if (ui.weights && +ui.weights.value !== S.weights) ui.weights.value = S.weights;
        if (ui.weightsVal) ui.weightsVal.textContent = S.weights;
    }
    function setGas(key) {
        if (!GASES[key]) return;
        const mNew = GASES[key].m;
        const f = Math.sqrt(mass / mNew);      // keep each particle's kinetic energy (same temperature)
        scaleVelocities(f);
        scaleAir(f);
        mass = mNew;
        S.gas = key;
        if (ui.gas && ui.gas.value !== key) ui.gas.value = key;
    }
    function setSpeed(x) {
        S.speed = Math.max(0.1, Math.min(3, x));
        if (ui.speed && Math.abs(+ui.speed.value - S.speed) > 1e-6) ui.speed.value = S.speed;
        if (ui.speedVal) ui.speedVal.textContent = S.speed.toFixed(1);
    }
    function setToggle(key, el, value) {
        S[key] = !!value;
        if (el && el.checked !== S[key]) el.checked = S[key];
    }

    function bindControls() {
        if (ui.container) ui.container.addEventListener('change', () => setContainer(ui.container.value));
        if (ui.temp) ui.temp.addEventListener('input', () => setTemperature(+ui.temp.value));
        if (ui.count) ui.count.addEventListener('input', () => setParticleCount(+ui.count.value, false));
        if (ui.volume) ui.volume.addEventListener('input', () => setVolume(+ui.volume.value));
        if (ui.weights) ui.weights.addEventListener('input', () => setWeights(+ui.weights.value));
        if (ui.speed) ui.speed.addEventListener('input', () => setSpeed(+ui.speed.value));
        if (ui.gas) ui.gas.addEventListener('change', () => setGas(ui.gas.value));
        if (ui.hitArrows) ui.hitArrows.addEventListener('change', () => {
            S.hitArrows = ui.hitArrows.checked;
            if (S.hitArrows) hitT.fill(-1e9);
        });
        if (ui.avgArrows) ui.avgArrows.addEventListener('change', () => { S.avgArrows = ui.avgArrows.checked; });
        if (ui.tracer) ui.tracer.addEventListener('change', () => { S.tracer = ui.tracer.checked; trailLen = 0; });
        if (ui.collisions) ui.collisions.addEventListener('change', () => { S.collisions = ui.collisions.checked; });
        if (ui.insulated) ui.insulated.addEventListener('change', () => {
            S.insulated = ui.insulated.checked;
            syncInsulatedControls();
            updateRegionLabel();
        });
        if (ui.graphMode) ui.graphMode.addEventListener('change', () => {
            S.graphMode = ui.graphMode.value;
            lawPts.length = 0; lastLawT = -1e9;
            redrawCharts(true);
        });
        if (ui.showCharts) {
            ui.showCharts.addEventListener('change', onChartsToggle);
            if (!chartsAvailable()) {
                const lbl = ui.showCharts.closest('label');
                if (lbl) lbl.style.display = 'none';
            }
        }
        if (ui.reset) ui.reset.addEventListener('click', () => { initState(); });
    }

    // Read initial control values (the browser may restore them on reload).
    function readControls() {
        if (ui.container && AUTO_MODE[ui.container.value]) S.container = ui.container.value;
        if (ui.temp) S.Tset = Math.max(50, Math.min(1000, +ui.temp.value || 300));
        if (ui.count) S.Ntarget = Math.max(1, Math.min(MAX_N, +ui.count.value || 300));
        if (ui.volume) S.syringeV = +ui.volume.value || 0.8;
        if (ui.weights) S.weights = Math.max(0, Math.min(4, +ui.weights.value || 0));
        if (ui.speed) S.speed = Math.max(0.1, Math.min(3, +ui.speed.value || 1));
        if (ui.gas && GASES[ui.gas.value]) S.gas = ui.gas.value;
        if (ui.hitArrows) S.hitArrows = ui.hitArrows.checked;
        if (ui.avgArrows) S.avgArrows = ui.avgArrows.checked;
        if (ui.tracer) S.tracer = ui.tracer.checked;
        if (ui.collisions) S.collisions = ui.collisions.checked;
        if (ui.insulated) S.insulated = ui.insulated.checked;
        if (ui.graphMode) S.graphMode = ui.graphMode.value;
        if (ui.tempVal) ui.tempVal.textContent = S.Tset;
        if (ui.countVal) ui.countVal.textContent = S.Ntarget;
        if (ui.weightsVal) ui.weightsVal.textContent = S.weights;
        if (ui.speedVal) ui.speedVal.textContent = S.speed.toFixed(1);
        syncContainerControls();
        syncInsulatedControls();
    }

    // Plunger dragging (mouse, pen and touch via pointer events).
    let dragging = false, dragOffset = 0, dragPointer = null;
    function toWorld(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: (e.clientX - rect.left - offX) / scale - (flip ? REGION_SHIFT : 0), y: (e.clientY - rect.top - offY) / scale };
    }
    function overPlunger(w) {
        const slack = 10 / scale;
        const X = box.x1;
        return w.x >= X - 3 - slack && w.x <= X + SYRINGE.rod + 3 + slack &&
            w.y >= SYRINGE.y0 - 4 - slack && w.y <= SYRINGE.y1 + 4 + slack;
    }
    function bindPointer() {
        canvas.addEventListener('pointerdown', (e) => {
            if (S.container !== 'syringe' || (e.pointerType === 'mouse' && e.button !== 0)) return;
            const w = toWorld(e);
            const inBarrel = w.x > SYRINGE.x0 && w.x < INSTR_X && w.y > SYRINGE.y0 - 6 && w.y < SYRINGE.y1 + 6;
            if (!overPlunger(w) && !inBarrel) return;
            dragging = true;
            hasDragged = true;
            dragPointer = e.pointerId;
            dragOffset = overPlunger(w) ? w.x - box.x1 : 0;
            syringeTarget = clampSyringeX(w.x - dragOffset);
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            canvas.classList.add('pressure-dragging');
            e.preventDefault();
        });
        canvas.addEventListener('pointermove', (e) => {
            if (dragging && e.pointerId === dragPointer) {
                const w = toWorld(e);
                syringeTarget = clampSyringeX(w.x - dragOffset);
                S.syringeV = syringeVolumeForX(syringeTarget);
                e.preventDefault();
            } else if (e.pointerType === 'mouse') {
                const can = S.container === 'syringe' && overPlunger(toWorld(e));
                canvas.classList.toggle('pressure-can-drag', can);
            }
        });
        const end = (e) => {
            if (!dragging || e.pointerId !== dragPointer) return;
            dragging = false;
            dragPointer = null;
            canvas.classList.remove('pressure-dragging');
            S.syringeV = syringeVolumeForX(syringeTarget);
            if (ui.volume) ui.volume.value = S.syringeV.toFixed(2);
            if (ui.volumeVal) ui.volumeVal.textContent = S.syringeV.toFixed(2);
        };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);
        canvas.addEventListener('lostpointercapture', end);
    }

    function onResize() {
        if (resizeCanvas()) {
            refreshFonts();
            legendGradient = null;
            render();
        }
    }

    // ------------------------------------------------------------------
    // Debug / test API
    // ------------------------------------------------------------------
    function runSim(seconds, frameDt) {
        const fdt = frameDt || 1 / 60;
        let t = 0;
        while (t < seconds - 1e-9) {
            const d = Math.min(fdt, seconds - t);
            simulateFrame(d);
            t += d;
        }
    }
    window.pressureSimulation = {
        getState: function () {
            return {
                container: S.container, N: N, Ntarget: S.Ntarget, Tset: S.Tset, gas: S.gas, mass: mass,
                collisions: S.collisions, insulated: S.insulated, speed: S.speed, simTime: simTime,
                R: bal.R, Rdot: bal.Rdot, box: { x0: box.x0, x1: box.x1, y0: box.y0, y1: box.y1 },
                volumeL: area() / A_REF, gasT: gasTemperature(), KE: currentKE(),
                window: { valid: win.valid, P_kPa: win.P * KPA, Pideal_kPa: win.Pideal * KPA, V_L: win.A / A_REF, T: win.T, ratio: win.ratio, hitRate: win.hitRate },
                substeps: lastSubsteps, gaugeRange: GAUGE_RANGES[gaugeIdx], mirroredLayout: flip
            };
        },
        setContainer: setContainer,
        setTemperature: setTemperature,
        setParticleCount: setParticleCount,
        setVolume: setVolume,
        setWeights: setWeights,
        setGas: setGas,
        setSpeed: setSpeed,
        setCollisions: (v) => setToggle('collisions', ui.collisions, v),
        setInsulated: (v) => { setToggle('insulated', ui.insulated, v); syncInsulatedControls(); updateRegionLabel(); },
        setArrows: (hit, avg) => { setToggle('hitArrows', ui.hitArrows, hit); setToggle('avgArrows', ui.avgArrows, avg); },
        setTracer: (v) => setToggle('tracer', ui.tracer, v),
        reset: () => initState(),
        pause: (v) => { S.paused = v === undefined ? !S.paused : !!v; return S.paused; },
        // Run the physics synchronously (no rendering) for `seconds` of simulated time.
        advance: function (seconds, frameDt) { runSim(seconds, frameDt); return this.getState(); },
        // Time-averaged measurement over `seconds` of simulated time.
        measure: function (seconds, frameDt) {
            testAcc = { J: 0, hits: 0, Ldt: 0, Adt: 0, KEdt: 0, Ndt: 0, dt: 0 };
            runSim(seconds, frameDt);
            const a = testAcc;
            testAcc = null;
            const P = a.J / a.Ldt, A = a.Adt / a.dt, KE = a.KEdt / a.dt;
            return {
                P_kPa: P * KPA, Pideal_kPa: KE / A * KPA, V_L: A / A_REF, T: a.KEdt / (a.Ndt * KB),
                N: a.Ndt / a.dt, ratio: P * A / KE, hitsPerSec: a.hits / a.dt, seconds: a.dt
            };
        },
        perf: () => ({ physMs: perf.phys, renderMs: perf.render, frameMs: perf.frame, worstFrameMs: perf.worstFrame, fps: perf.fps, substeps: lastSubsteps, N: N }),
        resetPerf: () => { perf.phys = perf.render = perf.frame = perf.worstFrame = 0; perf.samples = 0; },
        isLoopRunning: () => rafId !== 0
    };

    // ------------------------------------------------------------------
    // Start-up
    // ------------------------------------------------------------------
    function start() {
        readPalette();
        readControls();
        mass = GASES[S.gas].m;
        resizeCanvas();
        refreshFonts();
        bindControls();
        bindPointer();
        initState();
        updateReadouts();
        if (chartsVisible()) onChartsToggle();

        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(onResize);
            ro.observe(canvas.parentElement);
        }
        window.addEventListener('resize', onResize);
        // Fullscreen on/off changes where simulation_ui.js puts its buttons (see `flip`).
        new MutationObserver(onResize).observe(document.body, { attributes: true, attributeFilter: ['class'] });

        // Theme changes: main.js swaps dark-mode / light-mode on <html>.
        new MutationObserver(() => {
            readPalette();
            updateRegionLabel();
            applyChartTheme();
            render();
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

        render();
        startLoop();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
