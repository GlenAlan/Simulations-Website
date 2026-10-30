// Thermal Radiation Simulation - core logic
//
// A heater (a hot ball) sits in the middle of a vacuum chamber with a metal
// block on each side. Every object emits thermal radiation (P = e*sigma*A*T^4,
// with a Planck spectrum); radiation reaching a surface is either absorbed
// (heating it) or reflected. Temperatures follow from energy conservation:
//     dT/dt = (power absorbed - power emitted) / heat capacity
// The radiation "packets" are a visual representation of that energy flow:
// each one carries the same energy, so packet rate is proportional to power.

(function () {
    'use strict';

    // --- DOM Element References ---
    const canvas = document.getElementById('simulationCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    const byId = (id) => document.getElementById(id);

    const speedSlider = byId('speedSlider');
    const speedVal = byId('speedVal');
    const heaterTempSlider = byId('heaterTemp');
    const heaterTempVal = byId('heaterTempVal');
    const heaterOnCheckbox = byId('heaterOn');
    const leftSurfaceSelect = byId('leftSurface');
    const rightSurfaceSelect = byId('rightSurface');
    const leftDistanceSlider = byId('leftDistance');
    const leftDistanceVal = byId('leftDistanceVal');
    const rightDistanceSlider = byId('rightDistance');
    const rightDistanceVal = byId('rightDistanceVal');
    const viewModeSelect = byId('viewMode');
    const wallRadiationCheckbox = byId('showWallRadiation');
    const showChartsCheckbox = byId('showCharts');
    const chartsContainer = byId('charts-container');
    const resetButton = byId('resetSimulationBtn');
    const fpsDisplay = byId('fpsDisplay');
    const sourceTempEl = byId('sourceTempVal');
    const leftTempEl = byId('leftTempVal');
    const rightTempEl = byId('rightTempVal');
    const simTimeEl = byId('simTimeVal');

    // --- Physical constants ---
    const SIGMA = 5.670374e-8;      // Stefan-Boltzmann constant (W m^-2 K^-4)
    const C1 = 3.741771e8;          // first radiation constant 2*pi*h*c^2 (W um^4 m^-2)
    const C2 = 14387.77;            // second radiation constant h*c/k (um K)
    const WIEN_B = 2897.77;         // Wien displacement constant (um K)
    const T_AMB = 293.15;           // chamber walls: 20 degC
    const LAMBDA_SPLIT = 3.0;       // um, short-wave / long-wave boundary for non-grey surfaces
    const VIS_MIN = 0.38;           // um
    const VIS_MAX = 0.75;           // um

    // --- Scene geometry (world units: cm) ---
    const WORLD_W = 125;
    const WORLD_H = 62.5;
    const SRC_X = WORLD_W / 2;
    const AXIS_Y = 31;
    const SRC_R = 4;                                    // heater ball radius (cm)
    const SRC_AREA = 4 * Math.PI * SRC_R * SRC_R * 1e-4; // m^2
    const SRC_EPS = 0.95;
    const SRC_HEAT_CAP = 300;                           // J/K
    const HEATER_MAX_POWER = 25000;                     // W
    const THERMOSTAT_TAU = 2;                           // s (simulated)
    const BLOCK_SIDE = 8;                               // cm (hollow metal cube)
    const BLOCK_AREA = 6 * BLOCK_SIDE * BLOCK_SIDE * 1e-4; // m^2
    const BLOCK_HEAT_CAP = 100;                         // J/K
    const SLAB_HALF = 4;     // cm: the canvas shows a slice of 3D space this thick either side of the page
    const MIN_DIST = 10, MAX_DIST = 50;                 // cm, heater centre to block face

    // --- Visual / numerical parameters ---
    const PACKET_SPEED = 40;         // cm per real second (light slowed down enormously)
    const PACKETS_PER_WATT = 0.4;    // packets per real second per watt radiated
    const MAX_PACKETS = 2600;
    const MAX_FLASHES = 240;
    const FLASH_LIFE = 0.28;         // s
    const MAX_SUBSTEP = 0.2;         // s simulated per thermal integration step
    const THERMO_MAX_C = 250;        // thermometer full scale (degC)
    const CHART_MAX_POINTS = 600;

    // Surfaces: absorptivity (= emissivity, Kirchhoff) below and above LAMBDA_SPLIT.
    const SURFACES = {
        black:     { name: 'Matte black paint', short: 0.97, long: 0.97, specular: false },
        grey:      { name: 'Dull grey metal',   short: 0.45, long: 0.45, specular: false },
        white:     { name: 'White paint',       short: 0.25, long: 0.90, specular: false },
        aluminium: { name: 'Shiny aluminium',   short: 0.06, long: 0.06, specular: true },
        silver:    { name: 'Polished silver',   short: 0.02, long: 0.02, specular: true }
    };

    // --- Planck distribution tables (functions of y = lambda*T in um K) ---
    const PL_N = 1400;
    const PL_LOG_MIN = Math.log(150);
    const PL_LOG_STEP = (Math.log(200000) - PL_LOG_MIN) / (PL_N - 1);
    const plY = new Float64Array(PL_N);
    const plCdf = new Float64Array(PL_N);
    (function buildPlanckTable() {
        const integrand = (y) => Math.pow(y, -4) / Math.expm1(C2 / y); // B(y)*y, integrated over ln y
        const total = Math.pow(Math.PI, 4) / 15 / Math.pow(C2, 4);
        let acc = 0;
        let prev = integrand(Math.exp(PL_LOG_MIN));
        plY[0] = Math.exp(PL_LOG_MIN);
        for (let i = 1; i < PL_N; i++) {
            const y = Math.exp(PL_LOG_MIN + i * PL_LOG_STEP);
            const g = integrand(y);
            acc += 0.5 * (g + prev) * PL_LOG_STEP;
            prev = g;
            plY[i] = y;
            plCdf[i] = Math.min(1, acc / total);
        }
    })();

    // Fraction of blackbody power emitted below wavelength lambda (y = lambda*T).
    function bandFraction(y) {
        if (y <= plY[0]) return 0;
        if (y >= plY[PL_N - 1]) return 1;
        const f = (Math.log(y) - PL_LOG_MIN) / PL_LOG_STEP;
        const i = Math.floor(f);
        const t = f - i;
        return plCdf[i] * (1 - t) + plCdf[i + 1] * t;
    }

    // Sample a wavelength (um) from the Planck spectrum at temperature T.
    function sampleWavelength(T) {
        const u = Math.random();
        let lo = 0, hi = PL_N - 1;
        if (u >= plCdf[hi]) return plY[hi] / T;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (plCdf[mid] < u) lo = mid; else hi = mid;
        }
        const span = plCdf[hi] - plCdf[lo];
        const t = span > 0 ? (u - plCdf[lo]) / span : 0;
        return Math.exp(PL_LOG_MIN + (lo + t) * PL_LOG_STEP) / T;
    }

    // Effective absorptivity of a surface for radiation from a blackbody at temperature T.
    // By Kirchhoff's law this is also the surface's emissivity when it is at temperature T.
    function absorptivity(surface, T) {
        if (surface.short === surface.long) return surface.long;
        const f = bandFraction(LAMBDA_SPLIT * T);
        return surface.short * f + surface.long * (1 - f);
    }

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    // --- Simulation state ---
    const state = {
        Ts: 1000,           // heater temperature (K)
        Tset: 1000,         // thermostat set point (K)
        heaterOn: true,
        speed: 20,
        simTime: 0,         // simulated seconds
        view: 'all',        // 'all' | 'visible' | 'thermal'
        showWalls: false,
        blocks: [
            { side: -1, surface: 'black', dist: 20, T: T_AMB },
            { side: 1, surface: 'silver', dist: 20, T: T_AMB }
        ]
    };
    const flux = { srcEmit: 0, srcAbs: 0, heater: 0 };

    function updateBlockGeometry(b) {
        const a = BLOCK_SIDE / 2;
        const d = b.dist;
        // Solid angle of the square face seen from the heater centre -> view factor.
        const omega = 4 * Math.asin((a * a) / (a * a + d * d));
        b.Fsb = omega / (4 * Math.PI);              // fraction of heater radiation reaching the block
        b.Fbs = SRC_AREA * b.Fsb / BLOCK_AREA;      // reciprocity: fraction of block radiation reaching heater
        if (b.side < 0) { b.x1 = SRC_X - d; b.x0 = b.x1 - BLOCK_SIDE; }
        else { b.x0 = SRC_X + d; b.x1 = b.x0 + BLOCK_SIDE; }
        b.y0 = AXIS_Y - a;
        b.y1 = AXIS_Y + a;
    }

    // Radiative power balance for every object at the current temperatures.
    function computeFluxes() {
        const Ts = state.Ts;
        const sAmb = SIGMA * Math.pow(T_AMB, 4);
        const srcEmit = SRC_EPS * SIGMA * SRC_AREA * Math.pow(Ts, 4);
        const srcRefl = (1 - SRC_EPS) * sAmb * SRC_AREA; // wall radiation reflected by the heater
        let toSource = 0;
        let sumF = 0;
        for (const b of state.blocks) {
            const s = SURFACES[b.surface];
            const eps = absorptivity(s, b.T);
            const aSrc = absorptivity(s, Ts);
            const aAmb = absorptivity(s, T_AMB);
            const wallIrr = BLOCK_AREA * sAmb * (1 - b.Fbs) + b.Fsb * srcRefl;
            b.eps = eps;
            b.aSrc = aSrc;
            b.fromHeater = aSrc * b.Fsb * srcEmit;
            b.fromWalls = aAmb * wallIrr;
            b.absorbed = b.fromHeater + b.fromWalls;
            b.emitted = eps * SIGMA * BLOCK_AREA * Math.pow(b.T, 4);
            b.net = b.absorbed - b.emitted;
            // Radiation leaving the block (emitted + reflected) that reaches the heater
            const leaving = b.emitted + (1 - aSrc) * b.Fsb * srcEmit + (1 - aAmb) * wallIrr;
            toSource += b.Fbs * leaving;
            sumF += b.Fsb;
        }
        const srcAbs = SRC_EPS * (toSource + sAmb * SRC_AREA * (1 - sumF));
        let heater = 0;
        if (state.heaterOn) {
            heater = clamp(srcEmit - srcAbs + SRC_HEAT_CAP * (state.Tset - Ts) / THERMOSTAT_TAU, 0, HEATER_MAX_POWER);
        }
        flux.srcEmit = srcEmit;
        flux.srcAbs = srcAbs;
        flux.heater = heater;
    }

    function advanceThermal(simDt) {
        let remaining = simDt;
        while (remaining > 1e-9) {
            const h = Math.min(MAX_SUBSTEP, remaining);
            computeFluxes();
            state.Ts = Math.max(1, state.Ts + h * (flux.heater + flux.srcAbs - flux.srcEmit) / SRC_HEAT_CAP);
            for (const b of state.blocks) {
                b.T = Math.max(1, b.T + h * b.net / BLOCK_HEAT_CAP);
            }
            remaining -= h;
        }
        state.simTime += simDt;
        computeFluxes();
    }

    // --- Radiation packets (structure of arrays, swap-remove) ---
    const pX = new Float32Array(MAX_PACKETS);
    const pY = new Float32Array(MAX_PACKETS);
    const pDx = new Float32Array(MAX_PACKETS);
    const pDy = new Float32Array(MAX_PACKETS);
    const pZ = new Float32Array(MAX_PACKETS);   // depth out of the page (cm)
    const pTz = new Float32Array(MAX_PACKETS);  // dz per cm travelled in the page plane
    const pLam = new Float32Array(MAX_PACKETS); // wavelength (um)
    const pStyle = new Uint8Array(MAX_PACKETS);
    const pWave = new Uint8Array(MAX_PACKETS);
    let packetCount = 0;
    const hitCounts = [0, 0, 0]; // packets absorbed by left block, right block, heater (debug statistics)

    const fX = new Float32Array(MAX_FLASHES);
    const fY = new Float32Array(MAX_FLASHES);
    const fAge = new Float32Array(MAX_FLASHES);
    const fStyle = new Uint8Array(MAX_FLASHES);
    let flashCount = 0;

    // Packet styles: 0 = infrared, 1 = ultraviolet, 2..8 = visible colour bins
    const VIS_BIN_EDGES = [0.45, 0.495, 0.53, 0.57, 0.59, 0.62];
    const VIS_BIN_CENTRES = [0.42, 0.47, 0.51, 0.55, 0.58, 0.605, 0.66];
    const STYLE_COUNT = 9;
    function styleForWavelength(lam) {
        if (lam >= VIS_MAX) return 0;
        if (lam < VIS_MIN) return 1;
        let bin = 0;
        while (bin < VIS_BIN_EDGES.length && lam >= VIS_BIN_EDGES[bin]) bin++;
        return 2 + bin;
    }
    // Wave shapes: longer wavelength -> fewer, lazier wiggles
    const WAVE_LIMITS = [0.38, 0.75, 1.5, 3, 6, 12];
    const WAVE_CYCLES = [4.2, 3.4, 2.6, 2.1, 1.7, 1.35, 1.1];
    function waveForWavelength(lam) {
        let i = 0;
        while (i < WAVE_LIMITS.length && lam >= WAVE_LIMITS[i]) i++;
        return i;
    }
    const WAVE_S = [];
    const WAVE_W = [];
    WAVE_CYCLES.forEach((cycles) => {
        const n = Math.max(7, Math.ceil(cycles * 6) + 1);
        const s = new Float32Array(n);
        const w = new Float32Array(n);
        for (let k = 0; k < n; k++) {
            const t = k / (n - 1);
            s[k] = t;
            w[k] = Math.sin(t * cycles * 2 * Math.PI) * Math.sin(Math.PI * t);
        }
        WAVE_S.push(s);
        WAVE_W.push(w);
    });

    function addPacket(x, y, dx, dy, z, tz, lam) {
        if (packetCount >= MAX_PACKETS) return;
        const i = packetCount++;
        pX[i] = x; pY[i] = y; pDx[i] = dx; pDy[i] = dy; pZ[i] = z; pTz[i] = tz; pLam[i] = lam;
        pStyle[i] = styleForWavelength(lam);
        pWave[i] = waveForWavelength(lam);
    }

    function removePacket(i) {
        const last = --packetCount;
        if (i !== last) {
            pX[i] = pX[last]; pY[i] = pY[last]; pDx[i] = pDx[last]; pDy[i] = pDy[last];
            pZ[i] = pZ[last]; pTz[i] = pTz[last]; pLam[i] = pLam[last];
            pStyle[i] = pStyle[last]; pWave[i] = pWave[last];
        }
    }

    function addFlash(x, y, style) {
        let i;
        if (flashCount < MAX_FLASHES) i = flashCount++;
        else i = Math.floor(Math.random() * MAX_FLASHES);
        fX[i] = x; fY[i] = y; fAge[i] = 0; fStyle[i] = style;
    }

    // Cosine-weighted (Lambertian) direction about the in-plane normal (nx, ny).
    // Writes the in-plane unit direction and the out-of-plane slope into tmpDir.
    const tmpDir = { dx: 0, dy: 0, tz: 0, ok: false };
    function lambertDirection(nx, ny) {
        const sinT = Math.sqrt(Math.random());
        const cosT = Math.sqrt(1 - sinT * sinT);
        const phi = Math.random() * 2 * Math.PI;
        const tx = -ny, ty = nx;                 // in-plane tangent
        const a = sinT * Math.cos(phi);
        const ix = nx * cosT + tx * a;
        const iy = ny * cosT + ty * a;
        const len = Math.hypot(ix, iy);
        if (len < 1e-3) { tmpDir.ok = false; return tmpDir; }
        tmpDir.dx = ix / len;
        tmpDir.dy = iy / len;
        tmpDir.tz = sinT * Math.sin(phi) / len;
        tmpDir.ok = true;
        return tmpDir;
    }

    function spawnFromSource() {
        const sp = 2 * Math.random() - 1;          // sine of the angle out of the page
        const cp = Math.sqrt(1 - sp * sp);
        if (cp < 1e-3) return;
        const tz = sp / cp;
        const z0 = SRC_R * tz;
        if (Math.abs(z0) >= SLAB_HALF) return;      // leaves the drawn slice straight away
        const phi = Math.random() * 2 * Math.PI;
        const dx = Math.cos(phi), dy = Math.sin(phi);
        addPacket(SRC_X + dx * (SRC_R + 0.05), AXIS_Y + dy * (SRC_R + 0.05), dx, dy, z0, tz, sampleWavelength(state.Ts));
    }

    function spawnFromBlock(b) {
        const face = Math.floor(Math.random() * 6);
        if (face >= 4) return;                       // front/back faces radiate straight out of the page
        const u = (Math.random() - 0.5) * BLOCK_SIDE;
        let x, y, nx = 0, ny = 0;
        if (face === 0) { nx = -1; x = b.x0 - 0.05; y = AXIS_Y + u; }
        else if (face === 1) { nx = 1; x = b.x1 + 0.05; y = AXIS_Y + u; }
        else if (face === 2) { ny = -1; y = b.y0 - 0.05; x = (b.x0 + b.x1) / 2 + u; }
        else { ny = 1; y = b.y1 + 0.05; x = (b.x0 + b.x1) / 2 + u; }
        const dir = lambertDirection(nx, ny);
        if (!dir.ok) return;
        // Emission spectrum = absorptivity(lambda) x Planck(lambda, T) (rejection sampling)
        const s = SURFACES[b.surface];
        const aMax = Math.max(s.short, s.long);
        let lam = sampleWavelength(b.T);
        for (let k = 0; k < 8; k++) {
            const a = lam < LAMBDA_SPLIT ? s.short : s.long;
            if (Math.random() * aMax <= a) break;
            lam = sampleWavelength(b.T);
        }
        addPacket(x, y, dir.dx, dir.dy, (Math.random() * 2 - 1) * SLAB_HALF, dir.tz, lam);
    }

    function insideAnyObject(x, y) {
        const dx = x - SRC_X, dy = y - AXIS_Y;
        if (dx * dx + dy * dy < SRC_R * SRC_R) return true;
        for (const b of state.blocks) {
            if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return true;
        }
        return false;
    }

    // Radiation from the room-temperature chamber walls (only drawn when enabled).
    const WALL_FLUX = SIGMA * Math.pow(T_AMB, 4) * 1e-4 * PACKETS_PER_WATT; // packets per cm^2 per s
    const WALL_RATE_FACES = 2 * WORLD_W * WORLD_H * WALL_FLUX;              // through the front/back of the slice
    const WALL_RATE_EDGES = 2 * (WORLD_W + WORLD_H) * 2 * SLAB_HALF * WALL_FLUX;
    function spawnFromWalls() {
        const r = Math.random() * (WALL_RATE_FACES + WALL_RATE_EDGES);
        if (r < WALL_RATE_FACES) {
            // Enters the drawn slice from in front of / behind the page
            const x = Math.random() * WORLD_W, y = Math.random() * WORLD_H;
            if (insideAnyObject(x, y)) return;
            const sinT = Math.sqrt(Math.random());
            const cosT = Math.sqrt(1 - sinT * sinT);
            if (sinT < 1e-3) return;
            const sign = Math.random() < 0.5 ? -1 : 1;
            const phi = Math.random() * 2 * Math.PI;
            addPacket(x, y, Math.cos(phi), Math.sin(phi), sign * SLAB_HALF * 0.999, -sign * cosT / sinT, sampleWavelength(T_AMB));
        } else {
            const per = Math.random() * 2 * (WORLD_W + WORLD_H);
            let x, y, nx = 0, ny = 0;
            if (per < WORLD_W) { x = per; y = 0.05; ny = 1; }
            else if (per < 2 * WORLD_W) { x = per - WORLD_W; y = WORLD_H - 0.05; ny = -1; }
            else if (per < 2 * WORLD_W + WORLD_H) { x = 0.05; y = per - 2 * WORLD_W; nx = 1; }
            else { x = WORLD_W - 0.05; y = per - 2 * WORLD_W - WORLD_H; nx = -1; }
            const dir = lambertDirection(nx, ny);
            if (!dir.ok) return;
            addPacket(x, y, dir.dx, dir.dy, (Math.random() * 2 - 1) * SLAB_HALF, dir.tz, sampleWavelength(T_AMB));
        }
    }

    const emitAcc = { src: 0, b0: 0, b1: 0, walls: 0 };
    function emitPackets(dtReal) {
        const k = PACKETS_PER_WATT * dtReal;
        let n;
        emitAcc.src += flux.srcEmit * k;
        n = Math.floor(emitAcc.src); emitAcc.src -= n;
        n = Math.min(n, 600);
        for (let i = 0; i < n; i++) spawnFromSource();

        const b0 = state.blocks[0], b1 = state.blocks[1];
        emitAcc.b0 += b0.emitted * k;
        n = Math.floor(emitAcc.b0); emitAcc.b0 -= n;
        for (let i = 0; i < Math.min(n, 200); i++) spawnFromBlock(b0);
        emitAcc.b1 += b1.emitted * k;
        n = Math.floor(emitAcc.b1); emitAcc.b1 -= n;
        for (let i = 0; i < Math.min(n, 200); i++) spawnFromBlock(b1);

        if (state.showWalls) {
            emitAcc.walls += (WALL_RATE_FACES + WALL_RATE_EDGES) * dtReal;
            n = Math.floor(emitAcc.walls); emitAcc.walls -= n;
            for (let i = 0; i < Math.min(n, 100); i++) spawnFromWalls();
        } else {
            emitAcc.walls = 0;
        }
    }

    function stepPackets(dtReal) {
        const s = PACKET_SPEED * dtReal;
        const blocks = state.blocks;
        let i = 0;
        while (i < packetCount) {
            const ox = pX[i], oy = pY[i];
            const x = ox + pDx[i] * s;
            const y = oy + pDy[i] * s;
            const z = pZ[i] + pTz[i] * s;
            if (z > SLAB_HALF || z < -SLAB_HALF || x < 0 || x > WORLD_W || y < 0 || y > WORLD_H) {
                removePacket(i); // left the drawn slice or reached the chamber walls
                continue;
            }
            // Heater ball
            const hx = x - SRC_X, hy = y - AXIS_Y;
            const rEff2 = SRC_R * SRC_R - z * z;
            if (rEff2 > 0 && hx * hx + hy * hy < rEff2) {
                if (Math.random() < SRC_EPS) {
                    hitCounts[2]++;
                    addFlash(x, y, pStyle[i]);
                    removePacket(i);
                    continue;
                }
                const r = Math.hypot(hx, hy) || 1;
                const dir = lambertDirection(hx / r, hy / r);
                if (!dir.ok) { removePacket(i); continue; }
                pDx[i] = dir.dx; pDy[i] = dir.dy; pTz[i] = dir.tz;
                pX[i] = ox; pY[i] = oy; pZ[i] = z;
                i++;
                continue;
            }
            // Blocks
            let handled = false;
            for (let j = 0; j < blocks.length; j++) {
                const b = blocks[j];
                if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
                handled = true;
                let nx = 0, ny = 0;
                if (ox < b.x0) nx = -1;
                else if (ox > b.x1) nx = 1;
                else if (oy < b.y0) ny = -1;
                else if (oy > b.y1) ny = 1;
                if (nx === 0 && ny === 0) { removePacket(i); break; } // block was moved onto the packet
                const surf = SURFACES[b.surface];
                const a = pLam[i] < LAMBDA_SPLIT ? surf.short : surf.long;
                if (Math.random() < a) {
                    hitCounts[j]++;
                    addFlash(x, y, pStyle[i]);
                    removePacket(i);
                    break;
                }
                if (surf.specular) {
                    if (nx !== 0) pDx[i] = -pDx[i]; else pDy[i] = -pDy[i];
                } else {
                    const dir = lambertDirection(nx, ny);
                    if (!dir.ok) { removePacket(i); break; }
                    pDx[i] = dir.dx; pDy[i] = dir.dy; pTz[i] = dir.tz;
                }
                pX[i] = ox; pY[i] = oy; pZ[i] = z;
                i++;
                break;
            }
            if (handled) continue;
            pX[i] = x; pY[i] = y; pZ[i] = z;
            i++;
        }
    }

    function stepFlashes(dtReal) {
        let i = 0;
        while (i < flashCount) {
            fAge[i] += dtReal;
            if (fAge[i] >= FLASH_LIFE) {
                const last = --flashCount;
                fX[i] = fX[last]; fY[i] = fY[last]; fAge[i] = fAge[last]; fStyle[i] = fStyle[last];
                continue;
            }
            i++;
        }
    }

    // --- Colours ---
    function wavelengthToRGB(lam) {
        const w = lam * 1000;
        let r = 0, g = 0, b = 0;
        if (w < 440) { r = (440 - w) / 60; b = 1; }
        else if (w < 490) { g = (w - 440) / 50; b = 1; }
        else if (w < 510) { g = 1; b = (510 - w) / 20; }
        else if (w < 580) { r = (w - 510) / 70; g = 1; }
        else if (w < 645) { r = 1; g = (645 - w) / 65; }
        else { r = 1; }
        return [r, g, b];
    }

    // Approximate colour of a glowing blackbody (normalised so the brightest channel = 255).
    const BB_TABLE = [
        [600, 255, 18, 0], [800, 255, 38, 0], [1000, 255, 56, 0], [1200, 255, 83, 0],
        [1400, 255, 101, 0], [1600, 255, 115, 0], [1800, 255, 126, 0], [2000, 255, 137, 18],
        [2500, 255, 161, 72], [3000, 255, 180, 107]
    ];
    function blackbodyRGB(T) {
        if (T <= BB_TABLE[0][0]) return BB_TABLE[0].slice(1);
        for (let i = 1; i < BB_TABLE.length; i++) {
            if (T <= BB_TABLE[i][0]) {
                const a = BB_TABLE[i - 1], b = BB_TABLE[i];
                const t = (T - a[0]) / (b[0] - a[0]);
                return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
            }
        }
        return BB_TABLE[BB_TABLE.length - 1].slice(1);
    }
    // How strongly an object visibly glows (0..1): nothing below ~720 K (dull red appears around 800 K).
    function glowStrength(T, eps) {
        const g = clamp((T - 720) / (1250 - 720), 0, 1);
        return eps * Math.pow(g, 1.3);
    }
    function rgbStr(c, a) {
        return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
    }

    // Thermal-camera palette (cold -> hot)
    const THERMAL_STOPS = [
        [0.0, 8, 4, 32], [0.2, 52, 14, 104], [0.42, 150, 24, 120], [0.62, 226, 70, 40],
        [0.82, 252, 180, 40], [1.0, 255, 255, 235]
    ];
    const THERMAL_LUT = [];
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let k = 1;
        while (k < THERMAL_STOPS.length - 1 && t > THERMAL_STOPS[k][0]) k++;
        const a = THERMAL_STOPS[k - 1], b = THERMAL_STOPS[k];
        const u = clamp((t - a[0]) / (b[0] - a[0]), 0, 1);
        THERMAL_LUT.push(`rgb(${Math.round(a[1] + (b[1] - a[1]) * u)},${Math.round(a[2] + (b[2] - a[2]) * u)},${Math.round(a[3] + (b[3] - a[3]) * u)})`);
    }
    // Like a real thermal camera, the colour scale auto-ranges (here to the hottest block);
    // the heater is far off the top of the scale and shows white.
    const THERMAL_MIN_C = 10;
    let thermalMaxC = 60;
    function updateThermalRange() {
        let hottest = T_AMB;
        for (const b of state.blocks) hottest = Math.max(hottest, apparentTemperature(b.T, b.eps));
        const target = Math.max(50, THERMAL_MIN_C + (hottest - 273.15 - THERMAL_MIN_C) * 1.3);
        thermalMaxC += (target - thermalMaxC) * 0.08;
    }
    function thermalFraction(Tk) {
        return clamp((Tk - 273.15 - THERMAL_MIN_C) / (thermalMaxC - THERMAL_MIN_C), 0, 1);
    }
    function thermalColor(Tk) {
        return THERMAL_LUT[Math.round(thermalFraction(Tk) * 255)];
    }
    // Temperature a thermal camera would report: emitted + reflected wall radiation, read as a black body.
    function apparentTemperature(T, eps) {
        return Math.pow(eps * Math.pow(T, 4) + (1 - eps) * Math.pow(T_AMB, 4), 0.25);
    }

    let pal = {};
    const styleColors = new Array(STYLE_COUNT);
    function refreshPalette() {
        const dark = document.documentElement.classList.contains('dark-mode');
        pal = dark ? {
            dark: true,
            chamber: '#141519', wall: '#4b4e58', text: '#ececec', muted: 'rgba(236,236,236,0.66)',
            faint: 'rgba(236,236,236,0.42)', panel: 'rgba(20,21,25,0.72)', ir: '#ff6ec7', lead: '#7c818b', glass: 'rgba(255,255,255,0.10)',
            glassEdge: 'rgba(255,255,255,0.65)', liquid: '#ff4d4f', barIn: '#ffa94d', barWalls: '#868e96',
            barOut: '#ff6ec7', barTrack: 'rgba(255,255,255,0.08)', warm: '#ff8787', cool: '#74c0fc',
            steady: '#8ce99a', outline: 'rgba(255,255,255,0.55)',
            chartText: '#d0d0d0', chartGrid: 'rgba(255,255,255,0.10)', left: '#4dabf7', right: '#ffa94d', heaterLine: '#bfbfbf'
        } : {
            dark: false,
            chamber: '#f5f6f8', wall: '#b4b8c1', text: '#2b2b2b', muted: 'rgba(43,43,43,0.85)',
            faint: 'rgba(43,43,43,0.6)', panel: 'rgba(245,246,248,0.82)', ir: '#c2187a', lead: '#8b9099', glass: 'rgba(0,0,0,0.05)',
            glassEdge: 'rgba(0,0,0,0.55)', liquid: '#e03131', barIn: '#f08c00', barWalls: '#adb5bd',
            barOut: '#c2187a', barTrack: 'rgba(0,0,0,0.06)', warm: '#e03131', cool: '#1c7ed6',
            steady: '#2b8a3e', outline: 'rgba(0,0,0,0.55)',
            chartText: '#585858', chartGrid: 'rgba(0,0,0,0.10)', left: '#1c7ed6', right: '#e8590c', heaterLine: '#777777'
        };
        styleColors[0] = pal.ir;
        styleColors[1] = dark ? '#b197fc' : '#7048e8';
        for (let k = 0; k < VIS_BIN_CENTRES.length; k++) {
            const c = wavelengthToRGB(VIS_BIN_CENTRES[k]);
            const m = dark ? 255 : 200;
            styleColors[2 + k] = `rgb(${Math.round(c[0] * m)},${Math.round(c[1] * m)},${Math.round(c[2] * m)})`;
        }
        updateChartTheme();
    }

    // --- Canvas sizing ---
    let cssW = 0, cssH = 0, dpr = 1, scale = 1;
    function handleResize() {
        if (!canvas || !ctx) return;
        const box = canvas.parentElement;
        if (!box) return;
        const isFullscreen = document.body.classList.contains('sim-fullscreen-active');
        let ratio = 2;
        const ratioStr = getComputedStyle(box).getPropertyValue('--aspect-ratio').trim();
        if (ratioStr) {
            const parts = ratioStr.split('/');
            const r = parts.length === 2 ? parseFloat(parts[0]) / parseFloat(parts[1]) : parseFloat(ratioStr);
            if (isFinite(r) && r > 0) ratio = r;
        }
        let w, h;
        if (isFullscreen) {
            const wrapper = box.parentElement;
            if (!wrapper) return;
            const aw = wrapper.clientWidth, ah = wrapper.clientHeight;
            if (aw <= 0 || ah <= 0) return;
            if (aw / ah > ratio) { h = ah; w = h * ratio; } else { w = aw; h = w / ratio; }
            box.style.width = `${w}px`;
            box.style.height = `${h}px`;
        } else {
            box.style.width = '';
            box.style.height = '';
            const rect = box.getBoundingClientRect();
            w = rect.width; h = rect.height;
        }
        w = Math.max(1, Math.round(w));
        h = Math.max(1, Math.round(h));
        const newDpr = window.devicePixelRatio || 1;
        if (w === cssW && h === cssH && newDpr === dpr) return;
        cssW = w; cssH = h; dpr = newDpr;
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        scale = cssW / WORLD_W;
    }

    // --- Rendering ---
    const FONT_FAMILY = '"Source Sans Pro", Helvetica, Arial, sans-serif';
    let fontPx = 12;
    const X = (x) => x * scale;

    function fmtPower(p) {
        const a = Math.abs(p);
        if (a >= 1000) return `${(p / 1000).toFixed(a >= 10000 ? 1 : 2)} kW`;
        if (a >= 100) return `${p.toFixed(0)} W`;
        if (a >= 10) return `${p.toFixed(1)} W`;
        return `${p.toFixed(2)} W`;
    }
    function fmtC(Tk, digits) {
        return `${(Tk - 273.15).toFixed(digits)} °C`;
    }
    function fmtTime(sec) {
        const s = Math.floor(sec);
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
        const two = (v) => (v < 10 ? '0' : '') + v;
        return h > 0 ? `${h}:${two(m)}:${two(ss)}` : `${m}:${two(ss)}`;
    }

    function setFont(sizePx, weight) {
        ctx.font = `${weight || 400} ${Math.round(sizePx)}px ${FONT_FAMILY}`;
    }

    function drawChamber(thermal) {
        ctx.fillStyle = thermal ? thermalColor(T_AMB) : pal.chamber;
        ctx.fillRect(0, 0, cssW, cssH);
        ctx.strokeStyle = thermal ? 'rgba(255,255,255,0.35)' : pal.wall;
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, cssW - 2, cssH - 2);

        const small = Math.max(9, fontPx * 0.9);
        setFont(small, 600);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = thermal ? 'rgba(255,255,255,0.85)' : pal.muted;
        ctx.fillText(thermal ? 'THERMAL CAMERA VIEW' : 'VACUUM CHAMBER', 8, 7);
        setFont(small, 400);
        ctx.fillStyle = thermal ? 'rgba(255,255,255,0.7)' : pal.faint;
        ctx.fillText(thermal ? 'colours show the temperature the camera measures (auto range)' : 'no air - walls at 20 °C', 8, 7 + small * 1.25);

        if (!thermal) {
            // Label the empty gaps: a faint dimension line from the heater centre to each block face
            const ay = X(AXIS_Y);
            const tick = Math.max(3, fontPx * 0.35);
            ctx.strokeStyle = pal.faint;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 4]);
            ctx.beginPath();
            for (const b of state.blocks) {
                const face = X(b.side < 0 ? b.x1 : b.x0);
                ctx.moveTo(X(SRC_X + b.side * SRC_R), ay);
                ctx.lineTo(face, ay);
            }
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            for (const b of state.blocks) {
                const face = X(b.side < 0 ? b.x1 : b.x0);
                ctx.moveTo(face, ay - tick);
                ctx.lineTo(face, ay + tick);
            }
            ctx.stroke();
            ctx.textAlign = 'center';
            for (const b of state.blocks) {
                const gapStart = b.side < 0 ? b.x1 : SRC_X + SRC_R;
                const gapEnd = b.side < 0 ? SRC_X - SRC_R : b.x0;
                if (X(gapEnd - gapStart) < fontPx * 3.4) continue;
                const mx = X((gapStart + gapEnd) / 2);
                setFont(Math.max(9, fontPx * 0.9), 400);
                ctx.fillStyle = pal.muted;
                ctx.textBaseline = 'bottom';
                ctx.fillText('vacuum', mx, ay - 3);
                setFont(Math.max(9, fontPx * 0.85), 400);
                ctx.fillStyle = pal.faint;
                ctx.textBaseline = 'top';
                ctx.fillText(`${b.dist} cm`, mx, ay + 3);
            }
        }
    }

    function drawLeads(thermal) {
        ctx.strokeStyle = thermal ? 'rgba(255,255,255,0.35)' : pal.lead;
        ctx.lineWidth = Math.max(1.5, X(0.35));
        ctx.beginPath();
        ctx.moveTo(X(SRC_X - 1.2), X(AXIS_Y + SRC_R * 0.8));
        ctx.lineTo(X(SRC_X - 1.2), cssH);
        ctx.moveTo(X(SRC_X + 1.2), X(AXIS_Y + SRC_R * 0.8));
        ctx.lineTo(X(SRC_X + 1.2), cssH);
        ctx.stroke();
    }

    const bucketOf = new Uint8Array(MAX_PACKETS);
    const order = new Uint16Array(MAX_PACKETS);
    const BUCKETS = STYLE_COUNT * 4;
    const bucketStart = new Int32Array(BUCKETS + 1);
    const bucketFill = new Int32Array(BUCKETS);
    const ALPHAS = [0.22, 0.45, 0.7, 1.0];

    function drawPackets() {
        if (state.view === 'thermal' || packetCount === 0) return;
        const visibleOnly = state.view === 'visible';
        bucketStart.fill(0);
        const fadeZone = 0.4 * SLAB_HALF;
        for (let i = 0; i < packetCount; i++) {
            const st = pStyle[i];
            if (visibleOnly && st < 2) { bucketOf[i] = 255; continue; }
            const a = (SLAB_HALF - Math.abs(pZ[i])) / fadeZone;
            const lvl = a >= 1 ? 3 : (a <= 0 ? 0 : Math.min(3, Math.floor(a * 4)));
            const bk = st * 4 + lvl;
            bucketOf[i] = bk;
            bucketStart[bk + 1]++;
        }
        for (let k = 0; k < BUCKETS; k++) bucketStart[k + 1] += bucketStart[k];
        for (let k = 0; k < BUCKETS; k++) bucketFill[k] = bucketStart[k];
        for (let i = 0; i < packetCount; i++) {
            const bk = bucketOf[i];
            if (bk === 255) continue;
            order[bucketFill[bk]++] = i;
        }

        const len = clamp(X(2.6), 9, 20);
        const amp = clamp(X(0.4), 1.6, 3.2);
        const lwIR = clamp(X(0.22), 1.1, 1.8);
        const lwVis = clamp(X(0.3), 1.4, 2.4);
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'bevel';
        for (let bk = 0; bk < BUCKETS; bk++) {
            const start = bucketStart[bk], end = bucketStart[bk + 1];
            if (end <= start) continue;
            const st = (bk / 4) | 0;
            ctx.strokeStyle = styleColors[st];
            ctx.globalAlpha = ALPHAS[bk & 3];
            ctx.lineWidth = st === 0 ? lwIR : lwVis;
            ctx.beginPath();
            for (let n = start; n < end; n++) {
                const i = order[n];
                const hx = pX[i] * scale, hy = pY[i] * scale;
                const dx = pDx[i], dy = pDy[i];
                const S = WAVE_S[pWave[i]], W = WAVE_W[pWave[i]];
                const m = S.length;
                for (let k = 0; k < m; k++) {
                    const along = S[k] * len, side = W[k] * amp;
                    const px = hx - dx * along - dy * side;
                    const py = hy - dy * along + dx * side;
                    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    function drawFlashes() {
        if (state.view === 'thermal' || flashCount === 0) return;
        const visibleOnly = state.view === 'visible';
        const r0 = clamp(X(0.35), 1.5, 3), r1 = clamp(X(1.3), 5, 10);
        for (let i = 0; i < flashCount; i++) {
            if (visibleOnly && fStyle[i] < 2) continue;
            const t = fAge[i] / FLASH_LIFE;
            ctx.globalAlpha = 0.85 * (1 - t);
            ctx.fillStyle = styleColors[fStyle[i]];
            ctx.beginPath();
            ctx.arc(fX[i] * scale, fY[i] * scale, r0 + (r1 - r0) * t, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function drawGlowHalo(cx, cy, r, T, eps) {
        const g = glowStrength(T, eps);
        if (g <= 0.01) return;
        const c = blackbodyRGB(T);
        const outer = r * (1.5 + 1.6 * g);
        const grad = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, outer);
        grad.addColorStop(0, rgbStr(c, (pal.dark ? 0.55 : 0.45) * g));
        grad.addColorStop(1, rgbStr(c, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, outer, 0, Math.PI * 2);
        ctx.fill();
    }

    function drawSource(thermal) {
        const cx = X(SRC_X), cy = X(AXIS_Y), r = X(SRC_R);
        if (thermal) {
            ctx.fillStyle = thermalColor(apparentTemperature(state.Ts, SRC_EPS));
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
            return;
        }
        drawGlowHalo(cx, cy, r, state.Ts, SRC_EPS);
        // Dark, matte heater ball
        const body = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
        body.addColorStop(0, '#5e6168');
        body.addColorStop(1, '#1a1b1f');
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        const g = glowStrength(state.Ts, SRC_EPS);
        if (g > 0.005) {
            const c = blackbodyRGB(state.Ts);
            const white = clamp((state.Ts - 1300) / 700, 0, 1);
            const core = [c[0] + (255 - c[0]) * white * 0.85, c[1] + (255 - c[1]) * white * 0.85, c[2] + (255 - c[2]) * white * 0.85];
            const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
            glow.addColorStop(0, rgbStr(core, Math.min(1, g * 1.1)));
            glow.addColorStop(0.75, rgbStr(c, Math.min(1, g)));
            glow.addColorStop(1, rgbStr(c, g * 0.85));
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.strokeStyle = pal.outline;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
    }

    function drawBlockBody(b, thermal) {
        const x = X(b.x0), y = X(b.y0), w = X(BLOCK_SIDE), h = X(BLOCK_SIDE);
        if (thermal) {
            ctx.fillStyle = thermalColor(apparentTemperature(b.T, b.eps));
            ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = 'rgba(255,255,255,0.35)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            return;
        }
        const s = SURFACES[b.surface];
        drawGlowHalo(x + w / 2, y + h / 2, w * 0.55, b.T, s.short);
        let fill;
        switch (b.surface) {
            case 'black': fill = '#121212'; break;
            case 'grey': fill = '#7b7e84'; break;
            case 'white': fill = '#f3f3ef'; break;
            case 'aluminium': {
                fill = ctx.createLinearGradient(x, y, x + w, y + h);
                fill.addColorStop(0, '#d9dce1');
                fill.addColorStop(0.45, '#a9aeb6');
                fill.addColorStop(0.55, '#c9cdd3');
                fill.addColorStop(1, '#8f949c');
                break;
            }
            default: {
                fill = ctx.createLinearGradient(x, y, x + w, y + h);
                fill.addColorStop(0, '#ffffff');
                fill.addColorStop(0.35, '#c4c8cf');
                fill.addColorStop(0.5, '#f4f5f7');
                fill.addColorStop(0.65, '#b4b9c1');
                fill.addColorStop(1, '#e9ebee');
            }
        }
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, w, h);
        const g = glowStrength(b.T, s.short);
        if (g > 0.005) {
            ctx.fillStyle = rgbStr(blackbodyRGB(b.T), Math.min(0.9, g));
            ctx.fillRect(x, y, w, h);
        }
        if (s.specular) {
            // Mirror-like highlight streak
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = Math.max(1, w * 0.06);
            ctx.beginPath();
            ctx.moveTo(x + w * 0.2, y + h * 0.85);
            ctx.lineTo(x + w * 0.55, y + h * 0.15);
            ctx.stroke();
        }
        ctx.strokeStyle = pal.outline;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }

    function drawThermometer(cx, bulbY, topY, T, thermal) {
        const tw = clamp(X(0.9), 4, 8);
        const br = clamp(X(1.0), 4, 8.5);
        const tubeTop = topY + tw / 2;
        const tubeBottom = bulbY;
        // Glass
        ctx.fillStyle = thermal ? 'rgba(255,255,255,0.18)' : pal.glass;
        ctx.strokeStyle = thermal ? 'rgba(255,255,255,0.8)' : pal.glassEdge;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - tw / 2, tubeBottom);
        ctx.lineTo(cx - tw / 2, tubeTop);
        ctx.arc(cx, tubeTop, tw / 2, Math.PI, 0);
        ctx.lineTo(cx + tw / 2, tubeBottom);
        ctx.arc(cx, bulbY, br, -Math.PI / 2 + Math.asin(Math.min(1, tw / 2 / br)), Math.PI * 1.5 - Math.asin(Math.min(1, tw / 2 / br)));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Liquid
        const frac = clamp((T - 273.15) / THERMO_MAX_C, 0, 1);
        const usable = tubeBottom - tubeTop;
        const liquidTop = tubeBottom - usable * frac;
        ctx.fillStyle = pal.liquid;
        ctx.fillRect(cx - tw / 2 + 1.5, liquidTop, tw - 3, tubeBottom - liquidTop);
        ctx.beginPath();
        ctx.arc(cx, bulbY, br - 1.5, 0, Math.PI * 2);
        ctx.fill();
        // Scale ticks every 50 degC
        ctx.strokeStyle = thermal ? 'rgba(255,255,255,0.6)' : pal.faint;
        ctx.beginPath();
        for (let c = 50; c <= THERMO_MAX_C; c += 50) {
            const ty = tubeBottom - usable * (c / THERMO_MAX_C);
            ctx.moveTo(cx + tw / 2, ty);
            ctx.lineTo(cx + tw / 2 + 3, ty);
        }
        ctx.stroke();
    }

    // Translucent rounded panel behind a caption so it stays readable over the packets.
    function drawPanel(x, y, w, h, thermal) {
        const r = Math.min(6, h / 3);
        ctx.fillStyle = thermal ? 'rgba(0,0,0,0.38)' : pal.panel;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
        ctx.fill();
    }

    function textWidth(text, sizePx, weight) {
        setFont(sizePx, weight);
        return ctx.measureText(text).width;
    }

    function netInfo(b) {
        const tol = Math.max(0.01, 0.01 * b.absorbed);
        let word, col;
        if (b.net > tol) { word = 'warming up'; col = pal.warm; }
        else if (b.net < -tol) { word = 'cooling down'; col = pal.cool; }
        else { word = 'steady: in = out'; col = pal.steady; }
        return { text: `net ${b.net >= 0 ? '+' : '−'}${fmtPower(Math.abs(b.net))} · ${word}`, col };
    }

    let barScale = 30; // W at full bar length (smoothed)
    function drawBlockLabels(b, thermal) {
        const s = SURFACES[b.surface];
        const cx = X((b.x0 + b.x1) / 2);
        const textColor = thermal ? '#ffffff' : pal.text;
        const mutedColor = thermal ? 'rgba(255,255,255,0.88)' : pal.muted;
        const pad = Math.max(4, fontPx * 0.45);

        // Thermometer reading above the thermometer
        const tText = fmtC(b.T, 1);
        const tFont = fontPx * 1.05;
        const tW = textWidth(tText, tFont, 700);
        const tCx = clamp(cx, tW / 2 + pad + 2, cssW - tW / 2 - pad - 2);
        const tBase = X(b.y0 - 13) - fontPx * 0.5;
        drawPanel(tCx - tW / 2 - pad, tBase - tFont * 1.05, tW + 2 * pad, tFont * 1.4, thermal);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = textColor;
        ctx.fillText(tText, tCx, tBase);

        // Caption below the block: name, absorption/emission, energy bars, net power
        const nameFont = fontPx, subFont = fontPx * 0.88, smallFont = fontPx * 0.85, netFont = fontPx * 0.9;
        const subText = thermal
            ? `camera reads ${fmtC(apparentTemperature(b.T, b.eps), 0)}`
            : `absorbs ${Math.round(b.aSrc * 100)}% · emissivity ${b.eps.toFixed(2)}`;
        const showBars = !thermal && cssW >= 430;
        const net = thermal ? null : netInfo(b);
        const barMax = clamp(X(11), 40, 120);
        const barH = Math.max(4, fontPx * 0.55);
        const labelW = fontPx * 1.8;
        const valueW = textWidth('000.0 W', smallFont, 400);
        const rowW = labelW + barMax + 6 + valueW;
        let contentW = Math.max(textWidth(s.name, nameFont, 700), textWidth(subText, subFont, 400));
        if (net) contentW = Math.max(contentW, textWidth(net.text, netFont, 700));
        if (showBars) contentW = Math.max(contentW, rowW);
        const lh = fontPx * 1.22;
        const barGap = fontPx * 0.5;
        let panelH = pad + fontPx * 0.95 + lh;
        if (showBars) panelH += fontPx * 0.55 + 2 * (barH + barGap);
        if (net) panelH += showBars ? fontPx * 0.95 : lh;
        panelH += pad;
        const panelW = contentW + 2 * pad;
        const px = clamp(cx - panelW / 2, 4, cssW - 4 - panelW);
        const top = X(b.y1) + Math.max(4, fontPx * 0.4);
        drawPanel(px, top, panelW, panelH, thermal);
        const mx = px + panelW / 2;
        let y = top + pad + fontPx * 0.95;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        setFont(nameFont, 700);
        ctx.fillStyle = textColor;
        ctx.fillText(s.name, mx, y);
        y += lh;
        setFont(subFont, 400);
        ctx.fillStyle = mutedColor;
        ctx.fillText(subText, mx, y);
        if (showBars) {
            // Energy bars: in (absorbed: heater + walls) and out (emitted)
            const left = mx - rowW / 2;
            y += fontPx * 0.55;
            const rows = [
                { label: 'in', parts: [[b.fromHeater, pal.barIn], [b.fromWalls, pal.barWalls]], total: b.absorbed },
                { label: 'out', parts: [[b.emitted, pal.barOut]], total: b.emitted }
            ];
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            for (const row of rows) {
                setFont(smallFont, 700);
                ctx.fillStyle = mutedColor;
                ctx.fillText(row.label, left, y + barH / 2);
                const bx = left + labelW;
                ctx.fillStyle = pal.barTrack;
                ctx.fillRect(bx, y, barMax, barH);
                let bxx = bx;
                for (const [v, col] of row.parts) {
                    const w = Math.min(barMax - (bxx - bx), Math.max(0, v / barScale * barMax));
                    if (w <= 0) continue;
                    ctx.fillStyle = col;
                    ctx.fillRect(bxx, y, w, barH);
                    bxx += w;
                }
                setFont(smallFont, 400);
                ctx.fillStyle = textColor;
                ctx.fillText(fmtPower(row.total), bx + barMax + 6, y + barH / 2);
                y += barH + barGap;
            }
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            if (net) y += fontPx * 0.95 - lh;
        }
        if (net) {
            y += lh;
            setFont(netFont, 700);
            ctx.fillStyle = net.col;
            ctx.fillText(net.text, mx, y);
        }
    }

    function drawSourceLabels(thermal) {
        const cx = X(SRC_X);
        const lh = fontPx * 1.2;
        const pad = Math.max(4, fontPx * 0.45);
        const titleFont = fontPx, subFont = fontPx * 0.88;
        const title = `Heater ${fmtC(state.Ts, 0)} (${Math.round(state.Ts)} K)`;
        const line2 = `emits ${fmtPower(flux.srcEmit)}`;
        const line3 = state.heaterOn ? `electrical input ${fmtPower(flux.heater)}` : 'heater switched off';
        const w = Math.max(textWidth(title, titleFont, 700), textWidth(line2, subFont, 400), textWidth(line3, subFont, 400));
        const h = 2 * pad + fontPx * 0.9 + 2 * lh;
        const bottom = X(AXIS_Y - SRC_R) - Math.max(5, fontPx * 0.5);
        const top = bottom - h;
        drawPanel(cx - w / 2 - pad, top, w + 2 * pad, h, thermal);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        let y = top + pad + fontPx * 0.9;
        setFont(titleFont, 700);
        ctx.fillStyle = thermal ? '#ffffff' : pal.text;
        ctx.fillText(title, cx, y);
        y += lh;
        setFont(subFont, 400);
        ctx.fillStyle = thermal ? 'rgba(255,255,255,0.88)' : pal.muted;
        ctx.fillText(line2, cx, y);
        y += lh;
        ctx.fillText(line3, cx, y);
    }

    function drawLegend() {
        if (cssW < 470) return;
        const thermal = state.view === 'thermal';
        const x0 = 10, lh = fontPx * 1.3;
        let y = cssH - 10 - lh * (thermal ? 0.5 : 1.5);
        setFont(fontPx * 0.85, 400);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        if (thermal) {
            // Colour bar
            const barW = clamp(X(18), 80, 160), barH = Math.max(6, fontPx * 0.6);
            for (let i = 0; i < barW; i++) {
                ctx.fillStyle = THERMAL_LUT[Math.round(i / (barW - 1) * 255)];
                ctx.fillRect(x0 + i, y - barH, 1.5, barH);
            }
            ctx.strokeStyle = 'rgba(255,255,255,0.6)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x0 + 0.5, y - barH + 0.5, barW - 1, barH - 1);
            ctx.fillStyle = '#ffffff';
            ctx.textBaseline = 'top';
            const top = Math.round(thermalMaxC);
            [[THERMAL_MIN_C, 'left', `${THERMAL_MIN_C}`], [(THERMAL_MIN_C + top) / 2, 'center', `${Math.round((THERMAL_MIN_C + top) / 2)}`], [top, 'right', `${top}+ °C`]]
                .forEach(([c, align, label]) => {
                    ctx.textAlign = align;
                    ctx.fillText(label, x0 + (c - THERMAL_MIN_C) / (top - THERMAL_MIN_C) * barW, y + 2);
                });
            return;
        }
        const drawSample = (sx, sy, style, wave) => {
            const S = WAVE_S[wave], W = WAVE_W[wave], len = fontPx * 1.6, amp = Math.max(1.8, fontPx * 0.2);
            ctx.strokeStyle = styleColors[style];
            ctx.lineWidth = style === 0 ? 1.5 : 2;
            ctx.beginPath();
            for (let k = 0; k < S.length; k++) {
                const px = sx + S[k] * len, py = sy + W[k] * amp;
                if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();
        };
        let x = x0;
        if (state.view === 'all') {
            drawSample(x, y, 0, 4);
            ctx.fillStyle = pal.muted;
            ctx.fillText('infrared (invisible)', x + fontPx * 2, y);
            x += fontPx * 2 + ctx.measureText('infrared (invisible)').width + fontPx;
        }
        drawSample(x, y, 7, 1);
        x += fontPx * 2;
        ctx.fillStyle = pal.muted;
        const visText = state.view === 'visible' ? 'visible light only - infrared hidden' : 'visible light';
        ctx.fillText(visText, x, y);
        y += lh;
        ctx.fillStyle = pal.faint;
        ctx.fillText('every packet carries the same energy · flash = absorbed', x0, y);
    }

    function render() {
        if (!ctx || cssW <= 0) return;
        const thermal = state.view === 'thermal';
        if (thermal) updateThermalRange();
        fontPx = clamp(cssW / 62, 9, 14);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        drawChamber(thermal);
        drawLeads(thermal);
        drawPackets();
        drawSource(thermal);
        for (const b of state.blocks) {
            drawBlockBody(b, thermal);
            const cx = X((b.x0 + b.x1) / 2);
            drawThermometer(cx, X(b.y0 + 1.2), X(b.y0 - 13), b.T, thermal);
        }
        drawFlashes();
        // Smoothly adapt the energy-bar scale to the largest flow
        let maxFlow = 1;
        for (const b of state.blocks) maxFlow = Math.max(maxFlow, b.absorbed, b.emitted);
        const target = maxFlow * 1.15;
        barScale = barScale < target ? target : barScale + (target - barScale) * 0.02;
        drawSourceLabels(thermal);
        for (const b of state.blocks) drawBlockLabels(b, thermal);
        drawLegend();
    }

    // --- Charts (Chart.js, optional) ---
    let tempChart = null;
    let spectrumChart = null;
    const history = { left: [], right: [], heater: [] };
    let chartSampleEvery = 0.25;   // real seconds between samples
    let chartSampleTimer = 0;
    let chartRedrawTimer = 0;
    let lastSpectrumT = -1;
    const spectrumData = [];

    function chartsAvailable() {
        return typeof window.Chart !== 'undefined' && byId('tempChart') && byId('spectrumChart');
    }

    function recordHistory() {
        const t = state.simTime / 60;
        history.left.push({ x: t, y: state.blocks[0].T - 273.15 });
        history.right.push({ x: t, y: state.blocks[1].T - 273.15 });
        history.heater.push({ x: t, y: state.Ts - 273.15 });
        if (history.left.length > CHART_MAX_POINTS) {
            // Thin out the history in place (keeps the array references used by Chart.js)
            for (const key of ['left', 'right', 'heater']) {
                const arr = history[key];
                let w = 0;
                for (let r = 0; r < arr.length; r += 2) arr[w++] = arr[r];
                arr.length = w;
            }
            chartSampleEvery *= 2;
        }
    }

    function surfaceLabel(i) {
        return `${i === 0 ? 'Left' : 'Right'}: ${SURFACES[state.blocks[i].surface].name}`;
    }

    // Draws the visible band and the Wien peak marker on the spectrum chart.
    const spectrumDecorations = {
        id: 'radiationSpectrumDecorations',
        beforeDatasetsDraw(chart) {
            const area = chart.chartArea;
            const xs = chart.scales.x;
            if (!area || !xs) return;
            const c = chart.ctx;
            const x0 = xs.getPixelForValue(VIS_MIN), x1 = xs.getPixelForValue(VIS_MAX);
            const g = c.createLinearGradient(x0, 0, x1, 0);
            [[0, '#8b00ff'], [0.2, '#0050ff'], [0.4, '#00d0ff'], [0.55, '#00ff40'], [0.7, '#ffff00'], [0.85, '#ff8000'], [1, '#ff0000']]
                .forEach(([o, col]) => g.addColorStop(o, col));
            c.save();
            c.globalAlpha = 0.45;
            c.fillStyle = g;
            c.fillRect(x0, area.top, Math.max(1, x1 - x0), area.bottom - area.top);
            c.globalAlpha = 1;
            c.fillStyle = pal.chartText;
            c.font = `600 10px ${FONT_FAMILY}`;
            c.textAlign = 'left';
            c.textBaseline = 'top';
            c.fillText('visible', x1 + 3, area.top + 2);
            const peak = WIEN_B / state.Ts;
            if (peak <= xs.max) {
                const px = xs.getPixelForValue(peak);
                c.strokeStyle = pal.chartText;
                c.setLineDash([4, 3]);
                c.beginPath();
                c.moveTo(px, area.top);
                c.lineTo(px, area.bottom);
                c.stroke();
                c.setLineDash([]);
                c.textAlign = px > (area.left + area.right) / 2 ? 'right' : 'left';
                c.fillText(`peak ${peak.toFixed(2)} µm`, px + (c.textAlign === 'right' ? -4 : 4), area.top + 14);
            }
            c.restore();
        }
    };

    function baseChartOptions(title, xTitle, yTitle) {
        return {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            parsing: false,
            normalized: true,
            plugins: {
                title: { display: true, text: title, color: pal.chartText, font: { size: 12 } },
                legend: { labels: { color: pal.chartText, boxWidth: 12, font: { size: 10 } } },
                tooltip: { enabled: false }
            },
            scales: {
                x: {
                    type: 'linear', min: 0,
                    title: { display: true, text: xTitle, color: pal.chartText },
                    ticks: { color: pal.chartText, maxTicksLimit: 8 },
                    grid: { color: pal.chartGrid }
                },
                y: {
                    title: { display: true, text: yTitle, color: pal.chartText },
                    ticks: { color: pal.chartText, maxTicksLimit: 6 },
                    grid: { color: pal.chartGrid }
                }
            }
        };
    }

    function setupCharts() {
        if (!chartsAvailable()) return;
        if (tempChart) { tempChart.destroy(); tempChart = null; }
        if (spectrumChart) { spectrumChart.destroy(); spectrumChart = null; }
        const tOpts = baseChartOptions('Temperatures', 'Simulated time (minutes)', 'Blocks (°C)');
        tOpts.scales.y.beginAtZero = true;
        tOpts.scales.y2 = {
            position: 'right',
            min: 0,
            suggestedMax: 1000,
            title: { display: true, text: 'Heater (°C)', color: pal.chartText },
            ticks: { color: pal.chartText, maxTicksLimit: 6 },
            grid: { drawOnChartArea: false, color: pal.chartGrid }
        };
        tempChart = new window.Chart(byId('tempChart'), {
            type: 'line',
            data: {
                datasets: [
                    { label: surfaceLabel(0), data: history.left, borderColor: pal.left, backgroundColor: pal.left, borderWidth: 2, pointRadius: 0, yAxisID: 'y' },
                    { label: surfaceLabel(1), data: history.right, borderColor: pal.right, backgroundColor: pal.right, borderWidth: 2, pointRadius: 0, yAxisID: 'y' },
                    { label: 'Heater', data: history.heater, borderColor: pal.heaterLine, backgroundColor: pal.heaterLine, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, yAxisID: 'y2' }
                ]
            },
            options: tOpts
        });
        const sOpts = baseChartOptions('Heater spectrum', 'Wavelength (µm)', 'Power per µm (W/µm)');
        sOpts.scales.x.max = 15;
        sOpts.scales.y.beginAtZero = true;
        sOpts.plugins.legend.display = false;
        spectrumChart = new window.Chart(byId('spectrumChart'), {
            type: 'line',
            data: {
                datasets: [{ label: 'Heater', data: spectrumData, borderColor: pal.ir, backgroundColor: hexToRgba(pal.ir, 0.18), fill: true, borderWidth: 2, pointRadius: 0 }]
            },
            options: sOpts,
            plugins: [spectrumDecorations]
        });
        lastSpectrumT = -1;
        updateCharts(true);
    }

    function hexToRgba(hex, a) {
        const v = parseInt(hex.slice(1), 16);
        return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
    }

    function computeSpectrum() {
        const T = state.Ts;
        spectrumData.length = 0;
        for (let i = 0; i <= 200; i++) {
            const lam = 0.1 + i * (14.9 / 200);
            const p = SRC_EPS * SRC_AREA * C1 / (Math.pow(lam, 5) * Math.expm1(C2 / (lam * T)));
            spectrumData.push({ x: lam, y: isFinite(p) ? p : 0 });
        }
        const vis = (bandFraction(VIS_MAX * T) - bandFraction(VIS_MIN * T)) * 100;
        const visText = vis < 0.001 ? 'less than 0.001%' : `${vis < 1 ? vis.toPrecision(2) : vis.toFixed(1)}%`;
        if (spectrumChart) {
            spectrumChart.options.plugins.title.text = `Heater spectrum at ${Math.round(T)} K: ${visText} is visible light`;
        }
        lastSpectrumT = T;
    }

    function updateCharts(force) {
        if (!tempChart || !spectrumChart || !showChartsCheckbox || !showChartsCheckbox.checked) return;
        const tMax = history.left.length ? history.left[history.left.length - 1].x : 0;
        tempChart.options.scales.x.max = Math.max(1, Math.ceil(tMax));
        tempChart.data.datasets[0].label = surfaceLabel(0);
        tempChart.data.datasets[1].label = surfaceLabel(1);
        tempChart.update('none');
        if (force || Math.abs(state.Ts - lastSpectrumT) > 0.5) {
            computeSpectrum();
            spectrumChart.update('none');
        }
    }

    function updateChartTheme() {
        if (tempChart || spectrumChart) setupCharts();
    }

    // --- Info bar ---
    function updateInfoBar() {
        if (sourceTempEl) sourceTempEl.textContent = (state.Ts - 273.15).toFixed(0);
        if (leftTempEl) leftTempEl.textContent = (state.blocks[0].T - 273.15).toFixed(1);
        if (rightTempEl) rightTempEl.textContent = (state.blocks[1].T - 273.15).toFixed(1);
        if (simTimeEl) simTimeEl.textContent = fmtTime(state.simTime);
    }

    // --- Reset ---
    function resetSimulation() {
        state.Ts = state.Tset;
        state.simTime = 0;
        for (const b of state.blocks) { b.T = T_AMB; updateBlockGeometry(b); }
        packetCount = 0;
        flashCount = 0;
        emitAcc.src = emitAcc.b0 = emitAcc.b1 = emitAcc.walls = 0;
        history.left.length = 0;
        history.right.length = 0;
        history.heater.length = 0;
        chartSampleEvery = 0.25;
        chartSampleTimer = 0;
        computeFluxes();
        recordHistory();
        updateInfoBar();
        updateCharts(true);
    }

    // --- Controls ---
    function heaterLabel(T) {
        return `${Math.round(T)} K (${Math.round(T - 273.15)} °C)`;
    }

    function readControls() {
        if (speedSlider) state.speed = parseFloat(speedSlider.value) || 20;
        if (heaterTempSlider) state.Tset = parseFloat(heaterTempSlider.value) || 1000;
        if (heaterOnCheckbox) state.heaterOn = heaterOnCheckbox.checked;
        if (leftSurfaceSelect && SURFACES[leftSurfaceSelect.value]) state.blocks[0].surface = leftSurfaceSelect.value;
        if (rightSurfaceSelect && SURFACES[rightSurfaceSelect.value]) state.blocks[1].surface = rightSurfaceSelect.value;
        if (leftDistanceSlider) state.blocks[0].dist = clamp(parseFloat(leftDistanceSlider.value) || 20, MIN_DIST, MAX_DIST);
        if (rightDistanceSlider) state.blocks[1].dist = clamp(parseFloat(rightDistanceSlider.value) || 20, MIN_DIST, MAX_DIST);
        if (viewModeSelect) state.view = viewModeSelect.value;
        if (wallRadiationCheckbox) state.showWalls = wallRadiationCheckbox.checked;
        if (speedVal) speedVal.textContent = state.speed.toFixed(0);
        if (heaterTempVal) heaterTempVal.textContent = heaterLabel(state.Tset);
        if (leftDistanceVal) leftDistanceVal.textContent = state.blocks[0].dist.toFixed(0);
        if (rightDistanceVal) rightDistanceVal.textContent = state.blocks[1].dist.toFixed(0);
        state.blocks.forEach(updateBlockGeometry);
    }

    function setBlockDistance(i, d) {
        const b = state.blocks[i];
        b.dist = clamp(Math.round(d), MIN_DIST, MAX_DIST);
        updateBlockGeometry(b);
        const slider = i === 0 ? leftDistanceSlider : rightDistanceSlider;
        const label = i === 0 ? leftDistanceVal : rightDistanceVal;
        if (slider) slider.value = String(b.dist);
        if (label) label.textContent = b.dist.toFixed(0);
    }

    function bindControls() {
        if (speedSlider) speedSlider.addEventListener('input', () => {
            state.speed = parseFloat(speedSlider.value) || 1;
            if (speedVal) speedVal.textContent = state.speed.toFixed(0);
        });
        if (heaterTempSlider) heaterTempSlider.addEventListener('input', () => {
            state.Tset = parseFloat(heaterTempSlider.value) || 1000;
            if (heaterTempVal) heaterTempVal.textContent = heaterLabel(state.Tset);
        });
        if (heaterOnCheckbox) heaterOnCheckbox.addEventListener('change', () => { state.heaterOn = heaterOnCheckbox.checked; });
        if (leftSurfaceSelect) leftSurfaceSelect.addEventListener('change', () => {
            state.blocks[0].surface = leftSurfaceSelect.value;
            updateCharts(false);
        });
        if (rightSurfaceSelect) rightSurfaceSelect.addEventListener('change', () => {
            state.blocks[1].surface = rightSurfaceSelect.value;
            updateCharts(false);
        });
        if (leftDistanceSlider) leftDistanceSlider.addEventListener('input', () => setBlockDistance(0, parseFloat(leftDistanceSlider.value)));
        if (rightDistanceSlider) rightDistanceSlider.addEventListener('input', () => setBlockDistance(1, parseFloat(rightDistanceSlider.value)));
        if (viewModeSelect) viewModeSelect.addEventListener('change', () => { state.view = viewModeSelect.value; });
        if (wallRadiationCheckbox) wallRadiationCheckbox.addEventListener('change', () => { state.showWalls = wallRadiationCheckbox.checked; });
        if (resetButton) resetButton.addEventListener('click', resetSimulation);

        if (showChartsCheckbox && chartsContainer) {
            const applyCharts = () => {
                const on = showChartsCheckbox.checked;
                chartsContainer.style.display = on ? 'flex' : 'none';
                document.body.classList.toggle('charts-visible', on);
                if (on) setupCharts();
                if (document.body.classList.contains('sim-fullscreen-active')) {
                    setTimeout(handleResize, 50);
                }
            };
            showChartsCheckbox.addEventListener('change', applyCharts);
            applyCharts();
        }

        // Drag the blocks to change their distance (mouse, pen and touch)
        let drag = null;
        const toWorld = (e) => {
            const rect = canvas.getBoundingClientRect();
            return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
        };
        const blockAt = (p) => {
            for (let i = 0; i < state.blocks.length; i++) {
                const b = state.blocks[i];
                if (p.x >= b.x0 - 1.5 && p.x <= b.x1 + 1.5 && p.y >= b.y0 - 14 && p.y <= b.y1 + 1.5) return i;
            }
            return -1;
        };
        canvas.addEventListener('pointerdown', (e) => {
            const p = toWorld(e);
            const i = blockAt(p);
            if (i < 0) return;
            const b = state.blocks[i];
            const nearFace = b.side < 0 ? b.x1 : b.x0;
            drag = { i, offset: nearFace - p.x, id: e.pointerId };
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            canvas.style.cursor = 'grabbing';
            e.preventDefault();
        });
        canvas.addEventListener('pointermove', (e) => {
            const p = toWorld(e);
            if (drag && e.pointerId === drag.id) {
                const b = state.blocks[drag.i];
                const nearFace = p.x + drag.offset;
                setBlockDistance(drag.i, b.side < 0 ? SRC_X - nearFace : nearFace - SRC_X);
                e.preventDefault();
            } else if (e.pointerType === 'mouse') {
                canvas.style.cursor = blockAt(p) >= 0 ? 'grab' : '';
            }
        });
        const endDrag = (e) => {
            if (drag && e.pointerId === drag.id) {
                drag = null;
                canvas.style.cursor = '';
            }
        };
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);
        canvas.addEventListener('lostpointercapture', endDrag);
    }

    // --- Main loop ---
    let lastTimestamp = 0;
    let fpsFrames = 0;
    let fpsTimer = 0;
    let infoTimer = 0;
    const perfSamples = new Float32Array(240);
    let perfIndex = 0;
    let perfFilled = 0;

    function animate(timestamp) {
        const dtReal = lastTimestamp ? Math.min(0.1, Math.max(0, (timestamp - lastTimestamp) / 1000)) : 1 / 60;
        lastTimestamp = timestamp;
        const t0 = performance.now();

        advanceThermal(dtReal * state.speed);
        emitPackets(dtReal);
        stepPackets(dtReal);
        stepFlashes(dtReal);
        render();

        chartSampleTimer += dtReal;
        if (chartSampleTimer >= chartSampleEvery) {
            chartSampleTimer = 0;
            recordHistory();
        }
        chartRedrawTimer += dtReal;
        if (chartRedrawTimer >= 0.5) {
            chartRedrawTimer = 0;
            updateCharts(false);
        }
        infoTimer += dtReal;
        if (infoTimer >= 0.25) {
            infoTimer = 0;
            updateInfoBar();
        }

        perfSamples[perfIndex] = performance.now() - t0;
        perfIndex = (perfIndex + 1) % perfSamples.length;
        perfFilled = Math.min(perfFilled + 1, perfSamples.length);

        fpsFrames++;
        fpsTimer += dtReal;
        if (fpsTimer >= 1) {
            if (fpsDisplay) fpsDisplay.textContent = `FPS: ${Math.round(fpsFrames / fpsTimer)}`;
            fpsFrames = 0;
            fpsTimer = 0;
        }
        requestAnimationFrame(animate);
    }

    let started = false;
    function start() {
        if (started || !canvas || !ctx) {
            if (!canvas || !ctx) console.error('Canvas or context not found. Radiation simulation cannot start.');
            return;
        }
        started = true;
        refreshPalette();
        readControls();
        handleResize();
        bindControls();
        resetSimulation();

        window.addEventListener('resize', handleResize);
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => requestAnimationFrame(handleResize));
            const wrapper = canvas.closest('.sim-canvas-wrapper');
            if (wrapper) ro.observe(wrapper);
        }
        // Fullscreen is toggled with a class on <body>; theme with a class on <html>.
        new MutationObserver(() => setTimeout(handleResize, 60)).observe(document.body, { attributes: true, attributeFilter: ['class'] });
        new MutationObserver(refreshPalette).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('load', handleResize);

        requestAnimationFrame(animate);
    }

    // Small API for testing / debugging
    window.radiationSimulation = {
        reset: resetSimulation,
        getState: () => ({
            heaterK: state.Ts, setK: state.Tset, heaterOn: state.heaterOn, simTime: state.simTime, speed: state.speed,
            heaterEmitW: flux.srcEmit, heaterAbsorbW: flux.srcAbs, heaterPowerW: flux.heater,
            packets: packetCount, flashes: flashCount, absorbedPackets: hitCounts.slice(), canvas: { cssW, cssH, dpr, pixelW: canvas.width, pixelH: canvas.height },
            blocks: state.blocks.map((b) => ({
                surface: b.surface, dist: b.dist, K: b.T, absorbed: b.absorbed, fromHeater: b.fromHeater,
                fromWalls: b.fromWalls, emitted: b.emitted, net: b.net, eps: b.eps, aSrc: b.aSrc, Fsb: b.Fsb
            }))
        }),
        getPerf: () => {
            let sum = 0, max = 0;
            for (let i = 0; i < perfFilled; i++) { sum += perfSamples[i]; max = Math.max(max, perfSamples[i]); }
            return { frames: perfFilled, avgMs: perfFilled ? sum / perfFilled : 0, maxMs: max };
        },
        bandFraction,
        advance: (simSeconds) => { advanceThermal(simSeconds); updateInfoBar(); }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
