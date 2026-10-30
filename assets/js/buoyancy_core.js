/*
 * Buoyancy Simulation - simulations.science
 *
 * The user draws the cross-section of an object on a 1 cm grid using several
 * materials, then drops it into a 2 m x 1 m tank of liquid. The drawing is a
 * slice of a prism 10 cm deep (the tank is 10 cm deep too), so every mass,
 * volume and force is in real SI units.
 *
 * Physics (fixed 1/240 s sub-steps, semi-implicit Euler):
 *  - One rigid body (x, y, angle) whose mass and moment of inertia are summed
 *    from its cells. Rotation can be locked (infinite moment of inertia).
 *  - Hydrostatics per cell: every rotated square cell is clipped against the
 *    local, possibly sloping, liquid surface. That gives the exact submerged
 *    area and its centroid, so buoyancy (rho g V) acts at the right place and the
 *    centre of buoyancy / righting moment emerge on their own. The local surface
 *    slope adds the horizontal part of the pressure force.
 *  - Empty cells fully enclosed by material are sealed air pockets. Empty cells
 *    inside the object's convex hull form "open cavities" (the inside of a boat
 *    or cup). Liquid only enters a cavity cell when it is below the outside
 *    surface, connected to the outside liquid through submerged cells and its
 *    air can escape upwards; liquid drains out downhill. So an open steel hull
 *    floats until it is swamped, and an upside-down cup traps air.
 *  - Drag on every exposed face: quadratic pressure drag on faces moving into
 *    the fluid, laminar skin friction and a viscous term, integrated implicitly,
 *    plus the added mass / inertia of the liquid that has to be pushed aside.
 *  - Contacts with the floor, walls and lid via sequential impulses
 *    (restitution + Coulomb friction) with speculative margins and projection.
 *  - Liquid surface: the mean level follows from volume conservation
 *    (Archimedes' displacement); waves are the tank's standing modes with the
 *    exact linear gravity-capillary dispersion relation, driven by the change in
 *    the object's displacement.
 */
(function () {
    'use strict';

    const canvas = document.getElementById('simulationCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (!canvas || !ctx) {
        console.error('Buoyancy simulation: #simulationCanvas not found.');
        return;
    }

    // ------------------------------------------------------------------
    // Constants (SI units; y points up; origin at the bottom-left of the tank)
    // ------------------------------------------------------------------
    const TANK_W = 2.0;
    const TANK_H = 1.0;
    const DEPTH = 0.10;
    const CELL = 0.01;
    const GW = Math.round(TANK_W / CELL);
    const GH = Math.round(TANK_H / CELL);
    const CELL_A = CELL * CELL;
    const DT = 1 / 240;
    const MAX_SUBSTEPS = 48;
    const RHO_AIR = 1.2;
    const MU_AIR = 1.8e-5;
    const NCOL = 100;
    const DXC = TANK_W / NCOL;
    const NMODE = NCOL - 1;
    const CD_FRONT = 1.1;
    const CD_BACK = 0.6;
    const FRICTION = 0.45;
    const RESTITUTION = 0.25;
    const BOUNCE_SPEED = 0.25;
    const SLOP = 0.0005;
    const SPECULATIVE = 0.002;
    const CONTACT_ITERS = 8;
    const MAX_CONTACTS = 256;
    const FILL_RATE = 20;
    const DRAIN_RATE = 8;
    const SETTLE_RATE = 15;
    const LEVEL_EPS = 0.02 * CELL;
    const BRUSH_SIZES = [1, 2, 3, 4, 6, 8, 12, 16];
    const T_EXT = 0, T_MAT = 1, T_SEALED = 2, T_OPEN = 3;
    const K_SEALED = 8;
    const MAX_PARTICLES = 400;
    const UNDO_LIMIT = 40;

    const MATERIALS = [
        null,
        { key: 'cork', name: 'Cork', rho: 240, color: '#c9a36b', dark: '#8d6b3d', light: '#e6c897', tex: 'speckle' },
        { key: 'pine', name: 'Pine wood', rho: 500, color: '#d9a35e', dark: '#a06a35', light: '#ecc791', tex: 'grain' },
        { key: 'ice', name: 'Ice', rho: 917, color: '#c9ecfa', dark: '#93cde6', light: '#ffffff', tex: 'ice' },
        { key: 'nylon', name: 'Nylon', rho: 1150, color: '#e8735f', dark: '#c4553f', light: '#f6a393', tex: 'smooth' },
        { key: 'aluminium', name: 'Aluminium', rho: 2700, color: '#c3c9cf', dark: '#959ea7', light: '#e9edf0', tex: 'brushed' },
        { key: 'steel', name: 'Steel', rho: 7850, color: '#7b8692', dark: '#56606b', light: '#a6b0ba', tex: 'brushed' },
        { key: 'gold', name: 'Gold', rho: 19300, color: '#e0b03a', dark: '#b3861b', light: '#f8dc83', tex: 'sheen' }
    ];
    const MAT_ID = {};
    for (let i = 1; i < MATERIALS.length; i++) MAT_ID[MATERIALS[i].key] = i;

    const LIQUIDS = {
        oil: {
            name: 'Olive oil', rho: 911, mu: 0.081, sigma: 0.032, damp: 3.0,
            top: [214, 190, 58], bottom: [128, 112, 14], aTop: 0.62, aBot: 0.84, surface: '#fff0a0'
        },
        water: {
            name: 'Fresh water', rho: 1000, mu: 0.001, sigma: 0.072, damp: 1.0,
            top: [58, 150, 228], bottom: [18, 66, 140], aTop: 0.58, aBot: 0.8, surface: '#bfe6ff'
        },
        mercury: {
            name: 'Mercury', rho: 13534, mu: 0.00153, sigma: 0.485, damp: 1.1,
            top: [196, 202, 210], bottom: [110, 116, 126], aTop: 0.9, aBot: 0.97, surface: '#ffffff'
        }
    };

    const ARROWS = {
        weight: { label: 'Weight', color: '#ff5f5f' },
        buoyancy: { label: 'Buoyancy', color: '#2fe39b' },
        drag: { label: 'Drag', color: '#ffc53d' },
        contact: { label: 'Contact', color: '#c58cff' },
        net: { label: 'Net force', color: null }
    };

    // ------------------------------------------------------------------
    // Settings and state
    // ------------------------------------------------------------------
    const settings = {
        liquid: 'water',
        rotation: true,
        speed: 1,
        gravity: 9.81,
        liquidDepth: 0.5,
        arrows: { weight: true, buoyancy: true, drag: false, contact: false, net: true },
        markers: true,
        material: MAT_ID.steel,
        tool: 'brush',
        brushIndex: 2
    };

    const grid = new Uint8Array(GW * GH);
    const undoStack = [];
    let mode = 'draw';
    let preview = null;          // analysis of the current drawing
    let body = null;             // rigid body while simulating
    let drawDirty = true;
    let gridLayerDirty = true;
    const st = { x: 0, y: 0, th: 0, vx: 0, vy: 0, om: 0, maValid: false, maxPrev: 0, mayPrev: 0, iaPrev: 0 };
    let level = settings.liquidDepth;
    let simTime = 0;

    // waves
    const eta = new Float64Array(NCOL);
    const amp = new Float64Array(NMODE + 1);
    const vel = new Float64Array(NMODE + 1);
    const om2 = new Float64Array(NMODE + 1);
    const gam = new Float64Array(NMODE + 1);
    const cosKJ = new Float64Array((NMODE + 1) * NCOL);    // [k * NCOL + j]
    const cosJK = new Float64Array(NCOL * (NMODE + 1));    // [j * (NMODE + 1) + k]
    let bOld = new Float64Array(NCOL);
    let bNew = new Float64Array(NCOL);
    const src = new Float64Array(NCOL);
    for (let k = 0; k <= NMODE; k++) {
        for (let j = 0; j < NCOL; j++) {
            const v = Math.cos(k * Math.PI * (j + 0.5) / NCOL);
            cosKJ[k * NCOL + j] = v;
            cosJK[j * (NMODE + 1) + k] = v;
        }
    }

    // splash droplets
    const pX = new Float64Array(MAX_PARTICLES), pY = new Float64Array(MAX_PARTICLES);
    const pVX = new Float64Array(MAX_PARTICLES), pVY = new Float64Array(MAX_PARTICLES);
    const pLife = new Float64Array(MAX_PARTICLES);
    let nParticles = 0;

    // scratch for the hot loop (no allocations while stepping)
    const cornX = new Float64Array(4), cornY = new Float64Array(4), cornG = new Float64Array(4);
    const polyX = new Float64Array(8), polyY = new Float64Array(8);
    const cRX = new Float64Array(MAX_CONTACTS), cRY = new Float64Array(MAX_CONTACTS);
    const cNX = new Float64Array(MAX_CONTACTS), cNY = new Float64Array(MAX_CONTACTS);
    const cMN = new Float64Array(MAX_CONTACTS), cMT = new Float64Array(MAX_CONTACTS);
    const cTarget = new Float64Array(MAX_CONTACTS), cLam = new Float64Array(MAX_CONTACTS), cLamT = new Float64Array(MAX_CONTACTS);

    // per-substep results (for arrows and read-outs)
    const phys = {
        subA: 0, subEnv: 0, cobX: 0, cobY: 0,
        fbX: 0, fbY: 0, fdX: 0, fdY: 0, fcX: 0, fcY: 0, fgX: 0, fgY: 0, fgrabX: 0, fgrabY: 0,
        contactPX: 0, contactPY: 0, contactW: 0, weight: 0, airB: 0
    };
    // frame accumulators -> smoothed display values
    const acc = { n: 0, fbX: 0, fbY: 0, fdX: 0, fdY: 0, fcX: 0, fcY: 0, netX: 0, netY: 0, cpx: 0, cpy: 0, cw: 0 };
    const disp = { fbX: 0, fbY: 0, fdX: 0, fdY: 0, fcX: 0, fcY: 0, netX: 0, netY: 0, cpx: 0, cpy: 0, hasContact: 0, sub: 0 };

    const grab = { active: false, bx: 0, by: 0, tx: 0, ty: 0, pointerId: -1 };
    const pointer = { inside: false, x: 0, y: 0, down: false, button: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, id: -1, shift: false, type: 'mouse' };

    // canvas metrics
    let cssW = 0, cssH = 0, dpr = 1, scale = 1;

    // render caches
    let pal = null;
    let textures = null;
    let textureKey = '';
    let bgGradient = null, liquidGradient = null, gradientKey = '';
    const gridCanvas = document.createElement('canvas');
    const drawCanvas = document.createElement('canvas');
    const drawTopCanvas = document.createElement('canvas');

    // performance stats
    const perf = { physMs: 0, renderMs: 0, frameMs: 0, fps: 0, frames: 0, lastFpsT: 0, fpsFrames: 0, substeps: 0 };

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function fmt(v, digits) {
        if (!isFinite(v)) return '-';
        return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }
    function fmtAuto(v) {
        const a = Math.abs(v);
        if (a < 10) return fmt(v, 2);
        if (a < 100) return fmt(v, 1);
        return fmt(v, 0);
    }
    function surfaceAt(x) {
        let fc = x / DXC - 0.5;
        if (fc <= 0) return level + eta[0];
        if (fc >= NCOL - 1) return level + eta[NCOL - 1];
        const j = Math.floor(fc);
        const t = fc - j;
        return level + eta[j] + (eta[j + 1] - eta[j]) * t;
    }

    // ------------------------------------------------------------------
    // Drawing-grid analysis -> rigid body description
    // ------------------------------------------------------------------
    function convexHull(pts) {
        pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
        const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
        const lower = [];
        for (const p of pts) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
            lower.push(p);
        }
        const upper = [];
        for (let i = pts.length - 1; i >= 0; i--) {
            const p = pts[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
            upper.push(p);
        }
        upper.pop();
        lower.pop();
        return lower.concat(upper);
    }

    function analyzeGrid() {
        let c0 = GW, c1 = -1, r0 = GH, r1 = -1;
        for (let r = 0; r < GH; r++) {
            const row = r * GW;
            for (let c = 0; c < GW; c++) {
                if (grid[row + c]) {
                    if (c < c0) c0 = c;
                    if (c > c1) c1 = c;
                    if (r < r0) r0 = r;
                    r1 = r;
                }
            }
        }
        if (c1 < 0) return null;

        const LW = c1 - c0 + 3, LH = r1 - r0 + 3, NL = LW * LH;
        const gc0 = c0 - 1, gr0 = r0 - 1;
        const ltype = new Uint8Array(NL), lmat = new Uint8Array(NL);
        for (let lr = 1; lr < LH - 1; lr++) {
            for (let lc = 1; lc < LW - 1; lc++) {
                const m = grid[(gr0 + lr) * GW + gc0 + lc];
                if (m) { const li = lr * LW + lc; ltype[li] = T_MAT; lmat[li] = m; }
            }
        }

        // 1. empty cells reachable from outside (4-connected) -> everything else is sealed air
        const outside = new Uint8Array(NL);
        const queue = new Int32Array(NL);
        let qh = 0, qt = 0;
        const pushOut = (li) => { if (!outside[li] && ltype[li] !== T_MAT) { outside[li] = 1; queue[qt++] = li; } };
        for (let lc = 0; lc < LW; lc++) { pushOut(lc); pushOut((LH - 1) * LW + lc); }
        for (let lr = 0; lr < LH; lr++) { pushOut(lr * LW); pushOut(lr * LW + LW - 1); }
        while (qh < qt) {
            const li = queue[qh++];
            const lc = li % LW;
            if (lc > 0) pushOut(li - 1);
            if (lc < LW - 1) pushOut(li + 1);
            if (li >= LW) pushOut(li - LW);
            if (li < NL - LW) pushOut(li + LW);
        }
        for (let li = 0; li < NL; li++) if (ltype[li] !== T_MAT && !outside[li]) ltype[li] = T_SEALED;

        // 2. convex hull of the material (cell corners, local grid units)
        const pts = [];
        for (let lr = 0; lr < LH; lr++) {
            let mn = -1, mx = -1;
            for (let lc = 0; lc < LW; lc++) {
                if (ltype[lr * LW + lc] === T_MAT) { if (mn < 0) mn = lc; mx = lc; }
            }
            if (mn >= 0) pts.push([mn, lr], [mn, lr + 1], [mx + 1, lr], [mx + 1, lr + 1]);
        }
        const hull = convexHull(pts);
        const nh = hull.length;

        // 3. outside-connected empty cells inside the hull are "open cavity" cells
        let nOpen = 0;
        for (let lr = 0; lr < LH; lr++) {
            const yy = lr + 0.5;
            let xmin = Infinity, xmax = -Infinity;
            for (let e = 0; e < nh; e++) {
                const a = hull[e], b = hull[(e + 1) % nh];
                if ((a[1] - yy) * (b[1] - yy) <= 0 && a[1] !== b[1]) {
                    const x = a[0] + (yy - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
                    if (x < xmin) xmin = x;
                    if (x > xmax) xmax = x;
                }
            }
            if (xmax <= xmin) continue;
            for (let lc = 0; lc < LW; lc++) {
                const li = lr * LW + lc;
                const xx = lc + 0.5;
                if (ltype[li] === T_EXT && xx > xmin + 1e-6 && xx < xmax - 1e-6) { ltype[li] = T_OPEN; nOpen++; }
            }
        }

        // 4. which open cells hold liquid/air when upright ("basins", used for the hull volume)
        const basin = new Uint8Array(NL);
        if (nOpen > 0) {
            const reach = new Uint8Array(NL);
            qh = 0; qt = 0;
            for (let li = 0; li < NL; li++) {
                if (ltype[li] !== T_OPEN) continue;
                const lr = (li / LW) | 0;
                const nbs = [li - 1, li + 1, li - LW, li + LW];
                for (let q = 0; q < 4; q++) {
                    const nb = nbs[q];
                    if (ltype[nb] === T_EXT) {
                        const nr = (nb / LW) | 0;
                        if (lr >= nr && !reach[li]) { reach[li] = 1; queue[qt++] = li; }
                    }
                }
            }
            while (qh < qt) {
                const k = queue[qh++];
                const kr = (k / LW) | 0;
                const nbs = [k - 1, k + 1, k - LW, k + LW];
                for (let q = 0; q < 4; q++) {
                    const j = nbs[q];
                    if (ltype[j] === T_OPEN && !reach[j] && ((j / LW) | 0) >= kr) { reach[j] = 1; queue[qt++] = j; }
                }
            }
            for (let li = 0; li < NL; li++) if (ltype[li] === T_OPEN && !reach[li]) basin[li] = 1;
        }

        // 5. body cells
        let n = 0;
        for (let li = 0; li < NL; li++) if (ltype[li] !== T_EXT) n++;
        const ox = new Float64Array(n), oy = new Float64Array(n), cmass = new Float64Array(n);
        const kind = new Uint8Array(n), env = new Uint8Array(n), cellLocal = new Int32Array(n);
        const lcell = new Int32Array(NL).fill(-1);
        let M = 0, mx = 0, my = 0;
        let areaMat = 0, areaSealed = 0, areaOpen = 0, areaBasin = 0, massMat = 0;
        const matCount = new Int32Array(MATERIALS.length);
        let idx = 0;
        for (let lr = 0; lr < LH; lr++) {
            for (let lc = 0; lc < LW; lc++) {
                const li = lr * LW + lc;
                const t = ltype[li];
                if (t === T_EXT) continue;
                let rho, kd;
                if (t === T_MAT) { kd = lmat[li]; rho = MATERIALS[kd].rho; areaMat += CELL_A; matCount[kd]++; }
                else if (t === T_SEALED) { kd = K_SEALED; rho = RHO_AIR; areaSealed += CELL_A; }
                else { kd = 9; rho = RHO_AIR; areaOpen += CELL_A; if (basin[li]) areaBasin += CELL_A; }
                const m = rho * CELL_A * DEPTH;
                if (t === T_MAT) massMat += m;
                const lx = (lc + 0.5) * CELL, ly = (lr + 0.5) * CELL;
                ox[idx] = lx; oy[idx] = ly; cmass[idx] = m; kind[idx] = kd;
                env[idx] = (t !== T_OPEN || basin[li]) ? 1 : 0;
                cellLocal[idx] = li; lcell[li] = idx;
                M += m; mx += m * lx; my += m * ly;
                idx++;
            }
        }
        const comLX = mx / M, comLY = my / M;
        let I = 0, areaMx = 0, areaMy = 0;
        for (let i = 0; i < n; i++) {
            ox[i] -= comLX; oy[i] -= comLY;
            I += cmass[i] * (ox[i] * ox[i] + oy[i] * oy[i] + CELL_A / 6);
            areaMx += CELL_A * ox[i]; areaMy += CELL_A * oy[i];
        }

        // 6. exposed faces (body cell next to an exterior cell) for drag
        const fList = [];
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (let i = 0; i < n; i++) {
            const li = cellLocal[i];
            for (let q = 0; q < 4; q++) {
                const nb = li + dirs[q][0] + dirs[q][1] * LW;
                if (ltype[nb] === T_EXT) fList.push(ox[i] + dirs[q][0] * CELL * 0.5, oy[i] + dirs[q][1] * CELL * 0.5, dirs[q][0], dirs[q][1]);
            }
        }
        const nf = fList.length / 4;
        const fox = new Float64Array(nf), foy = new Float64Array(nf), fnx = new Float64Array(nf), fny = new Float64Array(nf);
        for (let f = 0; f < nf; f++) { fox[f] = fList[4 * f]; foy[f] = fList[4 * f + 1]; fnx[f] = fList[4 * f + 2]; fny[f] = fList[4 * f + 3]; }

        // 7. hull vertices (contact points) relative to the centre of mass
        const hullX = new Float64Array(nh), hullY = new Float64Array(nh);
        for (let h = 0; h < nh; h++) { hullX[h] = hull[h][0] * CELL - comLX; hullY[h] = hull[h][1] * CELL - comLY; }

        // 8. open-cavity bookkeeping
        const openCells = [], pairs = [], region = [];
        const inRegion = new Uint8Array(NL);
        for (let li = 0; li < NL; li++) {
            if (ltype[li] !== T_OPEN) continue;
            openCells.push(lcell[li]);
            if (!inRegion[li]) { inRegion[li] = 1; region.push(li); }
            const nbs = [li - 1, li + 1, li - LW, li + LW];
            for (let q = 0; q < 4; q++) {
                const nb = nbs[q];
                if (ltype[nb] === T_EXT) {
                    pairs.push(li, nb);
                    if (!inRegion[nb]) { inRegion[nb] = 1; region.push(nb); }
                }
            }
        }

        return {
            n, ox, oy, cmass, kind, env, cellLocal, lcell, ltype, lmat, LW, LH, gc0, gr0, NL,
            comLX, comLY, mass: M, massMat, inertia: I, areaMx, areaMy,
            areaTot: n * CELL_A, areaMat, areaSealed, areaOpen, areaBasin,
            areaEnv: areaMat + areaSealed + areaBasin, matCount,
            nf, fox, foy, fnx, fny, nh, hullX, hullY,
            charLen: Math.max(0.02, Math.sqrt(areaMat + areaSealed + areaBasin)),
            nOpen: openCells.length,
            openCells: Int32Array.from(openCells),
            openPairs: Int32Array.from(pairs),
            cavRegion: Int32Array.from(region),
            worldX: gc0 * CELL + comLX, worldY: gr0 * CELL + comLY,
            // dynamic
            water: new Float32Array(n),
            waterShown: new Uint8Array(n),
            waterMass: 0, waterMx: 0, waterMy: 0, waterInertia: 0, waterArea: 0, waterHeld: 0,
            cy: null, csub: null, fR: null, fV: null, fD: null, queue: null,
            img: null, imgKey: '', cavAirImg: null, cavWaterImg: null, cavKey: '', cavDirty: true
        };
    }

    function prepareBodyDynamics(B) {
        B.cy = new Float64Array(B.NL);
        B.csub = new Uint8Array(B.NL);
        B.fR = new Uint8Array(B.NL);
        B.fV = new Uint8Array(B.NL);
        B.fD = new Uint8Array(B.NL);
        B.queue = new Int32Array(B.NL);
        B.pocketMark = new Int32Array(B.NL);
        B.order = new Int32Array(B.NL);
        B.pocketGen = 0;
        B.water.fill(0);
        B.waterShown.fill(0);
        updateWaterMass(B);
        B.cavDirty = true;
    }

    function updateWaterMass(B) {
        const mCell = LIQUIDS[settings.liquid].rho * CELL_A * DEPTH;
        let m = 0, mx = 0, my = 0, I = 0, area = 0;
        const oc = B.openCells;
        for (let q = 0; q < oc.length; q++) {
            const i = oc[q];
            const w = B.water[i];
            if (w <= 0) continue;
            const mm = w * mCell;
            m += mm; mx += mm * B.ox[i]; my += mm * B.oy[i];
            I += mm * (B.ox[i] * B.ox[i] + B.oy[i] * B.oy[i] + CELL_A / 6);
            area += w * CELL_A;
        }
        B.waterMass = m; B.waterMx = mx; B.waterMy = my; B.waterInertia = I; B.waterArea = area;
    }

    // ------------------------------------------------------------------
    // Liquid level / waves
    // ------------------------------------------------------------------
    function liquidArea() {
        return settings.liquidDepth * TANK_W - (body ? body.waterArea : 0);
    }

    function updateWaveCoefficients() {
        const liq = LIQUIDS[settings.liquid];
        const g = settings.gravity;
        const H = Math.max(0.02, level);
        const nu = liq.mu / liq.rho;
        for (let k = 1; k <= NMODE; k++) {
            const kap = k * Math.PI / TANK_W;
            om2[k] = (g * kap + (liq.sigma / liq.rho) * kap * kap * kap) * Math.tanh(kap * H);
            const r = k / NMODE;
            gam[k] = liq.damp + 2 * nu * kap * kap + 6 * r * r * r * r;
        }
    }

    function clearWaves() {
        amp.fill(0); vel.fill(0); eta.fill(0); nParticles = 0;
    }

    // displacement below the calm level for an axis-aligned drawing (draw mode)
    function drawModeLevel(P) {
        let L = settings.liquidDepth;
        if (!P) return L;
        const rowCount = new Int32Array(GH);
        for (let i = 0; i < P.n; i++) {
            const r = P.gr0 + (P.cellLocal[i] / P.LW | 0);
            rowCount[r]++;
        }
        const A0 = liquidArea();
        for (let it = 0; it < 30; it++) {
            let disp = 0;
            const top = Math.min(GH - 1, Math.floor(L / CELL));
            for (let r = 0; r <= top; r++) {
                if (!rowCount[r]) continue;
                disp += rowCount[r] * CELL * clamp(L - r * CELL, 0, CELL);
            }
            const Ln = clamp((A0 + disp) / TANK_W, 0.001, TANK_H);
            if (Math.abs(Ln - L) < 1e-7) { L = Ln; break; }
            L = Ln;
        }
        return L;
    }

    // calm-level displacement of the body at its current pose (fills `out`, returns total area)
    function calmDisplacement(out) {
        const B = body;
        out.fill(0);
        const c = Math.cos(st.th), s = Math.sin(st.th);
        const ac = Math.abs(c), as = Math.abs(s);
        const ext = 0.5 * CELL * (ac + as);
        const rampA = CELL * Math.min(ac, as), wMax = CELL / Math.max(ac, as), E2 = 2 * ext;
        let tot = 0;
        for (let i = 0; i < B.n; i++) {
            const X = st.x + c * B.ox[i] - s * B.oy[i];
            const Y = st.y + s * B.ox[i] + c * B.oy[i];
            const dc = level - Y;
            if (dc <= -ext) continue;
            let Ac;
            if (dc >= ext) Ac = CELL_A;
            else {
                const tt = dc + ext;
                if (rampA < 1e-12) Ac = wMax * tt;
                else if (tt < rampA) Ac = wMax * tt * tt / (2 * rampA);
                else if (tt <= E2 - rampA) Ac = wMax * (tt - 0.5 * rampA);
                else { const u = E2 - tt; Ac = CELL_A - wMax * u * u / (2 * rampA); }
            }
            tot += Ac;
            let fc = X / DXC - 0.5, j, t;
            if (fc <= 0) { j = 0; t = 0; } else if (fc >= NCOL - 1) { j = NCOL - 2; t = 1; } else { j = Math.floor(fc); t = fc - j; }
            out[j] += Ac / DXC * (1 - t);
            out[j + 1] += Ac / DXC * t;
        }
        return tot;
    }

    function stepWaves(dt, sourceOn) {
        if (sourceOn) {
            let jmin = NCOL, jmax = -1;
            for (let j = 0; j < NCOL; j++) {
                const sj = bNew[j] - bOld[j];
                src[j] = sj;
                if (sj !== 0) { if (j < jmin) jmin = j; jmax = j; }
            }
            if (jmax >= 0) {
                const f = 2 / NCOL;
                for (let k = 1; k <= NMODE; k++) {
                    const base = k * NCOL;
                    let p = 0;
                    for (let j = jmin; j <= jmax; j++) p += src[j] * cosKJ[base + j];
                    amp[k] += p * f;
                }
                // splash droplets where the surface is being pushed up fast
                for (let j = jmin; j <= jmax; j++) {
                    const rate = src[j] / dt;
                    if (rate > 0.6 && nParticles < MAX_PARTICLES && Math.random() < Math.min(1, (rate - 0.6) * 0.5)) {
                        spawnDroplet((j + Math.random()) * DXC, level + eta[j], rate);
                    }
                }
            }
        }
        for (let k = 1; k <= NMODE; k++) {
            vel[k] += (-om2[k] * amp[k] - gam[k] * vel[k]) * dt;
            amp[k] += vel[k] * dt;
        }
        let maxAbs = 0;
        const stride = NMODE + 1;
        for (let j = 0; j < NCOL; j++) {
            const base = j * stride;
            let sum = 0;
            for (let k = 1; k <= NMODE; k++) sum += amp[k] * cosJK[base + k];
            eta[j] = sum;
            const a = sum < 0 ? -sum : sum;
            if (a > maxAbs) maxAbs = a;
        }
        if (maxAbs > 0.25) {
            const f = 0.25 / maxAbs;
            for (let k = 1; k <= NMODE; k++) { amp[k] *= f; vel[k] *= f; }
            for (let j = 0; j < NCOL; j++) eta[j] *= f;
        }
    }

    function spawnDroplet(x, y, rate) {
        if (nParticles >= MAX_PARTICLES) return;
        const i = nParticles++;
        pX[i] = x; pY[i] = y;
        const sp = Math.min(3.5, rate * (0.5 + Math.random() * 0.9));
        pVX[i] = (Math.random() - 0.5) * sp * 1.2;
        pVY[i] = sp;
        pLife[i] = 0;
    }

    function stepParticles(dt) {
        const g = settings.gravity;
        let i = 0;
        while (i < nParticles) {
            pVY[i] -= g * dt;
            pX[i] += pVX[i] * dt;
            pY[i] += pVY[i] * dt;
            pLife[i] += dt;
            if (pX[i] < 0) { pX[i] = 0; pVX[i] = -pVX[i] * 0.3; }
            if (pX[i] > TANK_W) { pX[i] = TANK_W; pVX[i] = -pVX[i] * 0.3; }
            if ((pVY[i] < 0 && pY[i] < surfaceAt(pX[i])) || pLife[i] > 3) {
                const last = --nParticles;
                pX[i] = pX[last]; pY[i] = pY[last]; pVX[i] = pVX[last]; pVY[i] = pVY[last]; pLife[i] = pLife[last];
            } else i++;
        }
    }

    function pokeLiquid(x, strength) {
        // a small Gaussian dent in the surface, projected onto the modes
        const f = 2 / NCOL;
        for (let j = 0; j < NCOL; j++) {
            const dx = ((j + 0.5) * DXC - x) / 0.035;
            src[j] = -strength * Math.exp(-dx * dx);
        }
        let mean = 0;
        for (let j = 0; j < NCOL; j++) mean += src[j];
        mean /= NCOL;
        for (let k = 1; k <= NMODE; k++) {
            let p = 0;
            for (let j = 0; j < NCOL; j++) p += (src[j] - mean) * cosKJ[k * NCOL + j];
            amp[k] += p * f;
        }
        const S = surfaceAt(x);
        for (let q = 0; q < 6; q++) spawnDroplet(x + (Math.random() - 0.5) * 0.03, S, 1.2 + Math.random());
    }

    // ------------------------------------------------------------------
    // Rigid-body physics
    // ------------------------------------------------------------------
    function substep(dt) {
        const B = body;
        const liq = LIQUIDS[settings.liquid];
        const rhoL = liq.rho, g = settings.gravity;
        const rotOn = settings.rotation;
        const c = Math.cos(st.th), s = Math.sin(st.th);
        const hc = 0.5 * CELL;
        cornX[0] = -hc * c + hc * s; cornY[0] = -hc * s - hc * c;
        cornX[1] = hc * c + hc * s;  cornY[1] = hc * s - hc * c;
        cornX[2] = hc * c - hc * s;  cornY[2] = hc * s + hc * c;
        cornX[3] = -hc * c - hc * s; cornY[3] = -hc * s + hc * c;
        const ac = Math.abs(c), as = Math.abs(s);
        const ext = hc * (ac + as);
        const rampA = CELL * Math.min(ac, as), wMax = CELL / Math.max(ac, as), E2 = 2 * ext;
        const L = level;
        const x0 = st.x, y0 = st.y;

        let sA = 0, sAx = 0, sAy = 0, sAk = 0, sAky = 0, sAenv = 0, calmTot = 0;
        let sxMin = Infinity, sxMax = -Infinity, syMin = Infinity, syMax = -Infinity, dTop = Infinity;
        bNew.fill(0);
        const n = B.n, OX = B.ox, OY = B.oy, ENV = B.env;
        for (let i = 0; i < n; i++) {
            const ox = OX[i], oy = OY[i];
            const rx = c * ox - s * oy, ry = s * ox + c * oy;
            const X = x0 + rx, Y = y0 + ry;
            const fc = X / DXC - 0.5;
            let j, t, k;
            if (fc <= 0) { j = 0; t = 0; k = 0; }
            else if (fc >= NCOL - 1) { j = NCOL - 2; t = 1; k = 0; }
            else { j = Math.floor(fc); t = fc - j; k = (eta[j + 1] - eta[j]) / DXC; }
            const e0 = eta[j];
            const S = L + e0 + (eta[j + 1] - e0) * t;
            const d = S - Y;
            if (d < dTop) dTop = d;
            const lim = ext * (1 + (k < 0 ? -k : k));
            if (d > -lim) {
                let A, cx, cy;
                if (d >= lim) { A = CELL_A; cx = 0; cy = 0; }
                else {
                    cornG[0] = d + k * cornX[0] - cornY[0];
                    cornG[1] = d + k * cornX[1] - cornY[1];
                    cornG[2] = d + k * cornX[2] - cornY[2];
                    cornG[3] = d + k * cornX[3] - cornY[3];
                    let m = 0;
                    for (let q = 0; q < 4; q++) {
                        const qn = (q + 1) & 3;
                        const gq = cornG[q], gn = cornG[qn];
                        if (gq >= 0) { polyX[m] = cornX[q]; polyY[m] = cornY[q]; m++; }
                        if ((gq >= 0) !== (gn >= 0)) {
                            const tt = gq / (gq - gn);
                            polyX[m] = cornX[q] + tt * (cornX[qn] - cornX[q]);
                            polyY[m] = cornY[q] + tt * (cornY[qn] - cornY[q]);
                            m++;
                        }
                    }
                    let a2 = 0, sx = 0, sy = 0;
                    for (let q = 0; q < m; q++) {
                        const qn = (q + 1 === m) ? 0 : q + 1;
                        const cr = polyX[q] * polyY[qn] - polyX[qn] * polyY[q];
                        a2 += cr;
                        sx += (polyX[q] + polyX[qn]) * cr;
                        sy += (polyY[q] + polyY[qn]) * cr;
                    }
                    if (a2 > 1e-14) { A = 0.5 * a2; cx = sx / (3 * a2); cy = sy / (3 * a2); }
                    else { A = 0; cx = 0; cy = 0; }
                }
                if (A > 0) {
                    const px = rx + cx, py = ry + cy;
                    sA += A; sAx += A * px; sAy += A * py;
                    sAk += A * k; sAky += A * k * py;
                    if (ENV[i]) sAenv += A;
                    if (X < sxMin) sxMin = X;
                    if (X > sxMax) sxMax = X;
                    if (Y < syMin) syMin = Y;
                    if (Y > syMax) syMax = Y;
                }
            }
            // displacement below the calm level (drives the mean level and the waves)
            const dc = L - Y;
            if (dc > -ext) {
                let Ac;
                if (dc >= ext) Ac = CELL_A;
                else {
                    const tt = dc + ext;
                    if (rampA < 1e-12) Ac = wMax * tt;
                    else if (tt < rampA) Ac = wMax * tt * tt / (2 * rampA);
                    else if (tt <= E2 - rampA) Ac = wMax * (tt - 0.5 * rampA);
                    else { const u = E2 - tt; Ac = CELL_A - wMax * u * u / (2 * rampA); }
                }
                calmTot += Ac;
                const w1 = Ac / DXC;
                bNew[j] += w1 * (1 - t);
                bNew[j + 1] += w1 * t;
            }
        }

        // ---- external forces and torque about the (dry) centre of mass ----
        const kB = rhoL * g * DEPTH;
        const Mtot = B.mass + B.waterMass;
        const Itot = B.inertia + B.waterInertia;
        const fbX = -kB * sAk, fbY = kB * sA;
        let Fx = fbX, Fy = fbY - Mtot * g;
        let T = kB * (sAx + sAky);
        T += -g * (c * B.waterMx - s * B.waterMy);
        const kAir = RHO_AIR * g * DEPTH;
        const emA = B.areaTot - sA;
        let airB = 0;
        if (emA > 0) {
            airB = kAir * emA;
            Fy += airB;
            T += kAir * ((c * B.areaMx - s * B.areaMy) - sAx);
        }
        // Added mass of the liquid that must be accelerated with the body (2D potential-flow
        // estimates from the submerged extents: a plate of width b moving broadside carries
        // rho*pi*b^2/4 per metre of depth, half of that at a free surface; a circle gets C_a = 1).
        let Max = 0, May = 0, Ia = 0;
        if (sA > 0) {
            const Wx = sxMax - sxMin + CELL, Hy = syMax - syMin + CELL;
            const full = clamp((dTop - ext) / (0.25 * Wx), 0, 1);   // 0 = pierces the surface, 1 = well under
            const ramp = clamp(Hy / 0.04, 0, 1);                     // grows over the first few cm of entry
            const rEff = ramp + (1 - ramp) * full;
            const k0 = rhoL * Math.PI * DEPTH;
            May = k0 * Wx * Wx * 0.125 * (1 + full) * rEff;
            Max = k0 * Hy * Hy * 0.25 * rEff;
            const w2 = Wx * Wx, h2 = Hy * Hy;
            Ia = k0 * (w2 * w2 + h2 * h2) / 256 * (1 + full) * rEff;
        }
        // Momentum of body + entrained liquid is conserved while the added mass grows
        // (water-entry "slamming"); when it shrinks the liquid keeps its momentum.
        const max0 = st.maValid ? Math.min(st.maxPrev, Max) : Max;
        const may0 = st.maValid ? Math.min(st.mayPrev, May) : May;
        const ia0 = st.maValid ? Math.min(st.iaPrev, Ia) : Ia;
        st.maxPrev = Max; st.mayPrev = May; st.iaPrev = Ia; st.maValid = true;
        const Mx = Mtot + Max, My = Mtot + May, Ii = Itot + Ia;
        const Mi = 0.5 * (Mx + My);

        // grab spring (mouse / touch)
        let gX = 0, gY = 0;
        if (grab.active) {
            const ax = c * grab.bx - s * grab.by, ay = s * grab.bx + c * grab.by;
            const om = rotOn ? st.om : 0;
            const vax = st.vx - om * ay, vay = st.vy + om * ax;
            const wg = 2 * Math.PI * 2.2;
            const kS = Mi * wg * wg, cS = 2 * 0.85 * Mi * wg;
            gX = kS * (grab.tx - (x0 + ax)) - cS * vax;
            gY = kS * (grab.ty - (y0 + ay)) - cS * vay;
            Fx += gX; Fy += gY;
            T += ax * gY - ay * gX;
        }

        // ---- drag on exposed faces (linearised, solved implicitly) ----
        let c11 = 0, c12 = 0, c13 = 0, c22 = 0, c23 = 0, c33 = 0;
        const vx = st.vx, vy = st.vy, om = rotOn ? st.om : 0;
        const Lc = B.charLen;
        const faceA = CELL * DEPTH;
        const FOX = B.fox, FOY = B.foy, FNX = B.fnx, FNY = B.fny;
        for (let f = 0; f < B.nf; f++) {
            const fox = FOX[f], foy = FOY[f];
            const rx = c * fox - s * foy, ry = s * fox + c * foy;
            const nx = c * FNX[f] - s * FNY[f], ny = s * FNX[f] + c * FNY[f];
            const X = x0 + rx, Y = y0 + ry;
            const fc = X / DXC - 0.5;
            let S;
            if (fc <= 0) S = L + eta[0];
            else if (fc >= NCOL - 1) S = L + eta[NCOL - 1];
            else { const j = Math.floor(fc); S = L + eta[j] + (eta[j + 1] - eta[j]) * (fc - j); }
            const d = S - Y;
            const dyE = (nx < 0 ? -nx : nx) * hc;
            let frac;
            if (d >= dyE) frac = 1; else if (d <= -dyE) frac = 0; else frac = 0.5 + 0.5 * d / dyE;
            const rho = RHO_AIR + (rhoL - RHO_AIR) * frac;
            const mu = MU_AIR + (liq.mu - MU_AIR) * frac;
            const vfx = vx - om * ry, vfy = vy + om * rx;
            const vn = vfx * nx + vfy * ny;
            const tx = -ny, ty = nx;
            const vt = vfx * tx + vfy * ty;
            // pressure drag: stagnation pressure on faces moving into the fluid, wake suction behind
            let kn = 12 * mu * faceA / Lc;
            if (vn > 0) kn += 0.5 * rho * CD_FRONT * faceA * vn;
            else kn -= 0.5 * rho * CD_BACK * faceA * vn;
            const kt = 0.664 * faceA * Math.sqrt(rho * mu * (vt < 0 ? -vt : vt) / Lc) + 2 * mu * faceA / Lc;
            const jn = rx * ny - ry * nx;
            const jt = rx * ty - ry * tx;
            c11 += kn * nx * nx + kt * tx * tx;
            c12 += kn * nx * ny + kt * tx * ty;
            c13 += kn * nx * jn + kt * tx * jt;
            c22 += kn * ny * ny + kt * ty * ty;
            c23 += kn * ny * jn + kt * ty * jt;
            c33 += kn * jn * jn + kt * jt * jt;
        }

        // ---- implicit velocity update: (M + dt C) v' = M v + dt F ----
        let nvx, nvy, nom;
        const b1 = (Mtot + max0) * vx + dt * Fx, b2 = (Mtot + may0) * vy + dt * Fy;
        if (rotOn) {
            const b3 = (Itot + ia0) * om + dt * T;
            const a11 = Mx + dt * c11, a12 = dt * c12, a13 = dt * c13;
            const a22 = My + dt * c22, a23 = dt * c23, a33 = Ii + dt * c33;
            const m11 = a22 * a33 - a23 * a23;
            const m12 = a12 * a33 - a23 * a13;
            const m13 = a12 * a23 - a22 * a13;
            const det = a11 * m11 - a12 * m12 + a13 * m13;
            nvx = (b1 * m11 - a12 * (b2 * a33 - a23 * b3) + a13 * (b2 * a23 - a22 * b3)) / det;
            nvy = (a11 * (b2 * a33 - a23 * b3) - b1 * m12 + a13 * (a12 * b3 - b2 * a13)) / det;
            nom = (a11 * (a22 * b3 - b2 * a23) - a12 * (a12 * b3 - b2 * a13) + b1 * m13) / det;
        } else {
            const a11 = Mx + dt * c11, a12 = dt * c12, a22 = My + dt * c22;
            const det = a11 * a22 - a12 * a12;
            nvx = (b1 * a22 - a12 * b2) / det;
            nvy = (a11 * b2 - a12 * b1) / det;
            nom = 0;
        }
        const fdX = -(c11 * nvx + c12 * nvy + c13 * nom);
        const fdY = -(c12 * nvx + c22 * nvy + c23 * nom);
        st.vx = nvx; st.vy = nvy; st.om = nom;

        // ---- contacts with the tank ----
        solveContacts(dt, 1 / Mx, 1 / My, rotOn ? 1 / Ii : 0, c, s);

        // ---- integrate positions ----
        st.x += st.vx * dt;
        st.y += st.vy * dt;
        if (rotOn) {
            st.th += st.om * dt;
            if (st.th > Math.PI) st.th -= 2 * Math.PI; else if (st.th < -Math.PI) st.th += 2 * Math.PI;
        }
        projectOutOfWalls();

        // ---- liquid: mean level from volume conservation + waves ----
        level = clamp((liquidArea() + calmTot) / TANK_W, 0.001, TANK_H);
        stepWaves(dt, true);
        const tmp = bOld; bOld = bNew; bNew = tmp;

        // ---- record for display ----
        phys.subA = sA; phys.subEnv = sAenv;
        if (sA > 0) { phys.cobX = x0 + sAx / sA; phys.cobY = y0 + sAy / sA; }
        phys.fbX = fbX; phys.fbY = fbY; phys.fdX = fdX; phys.fdY = fdY;
        phys.fgX = 0; phys.fgY = -Mtot * g; phys.weight = Mtot * g; phys.airB = airB;
        phys.fgrabX = gX; phys.fgrabY = gY;
        acc.n++;
        acc.fbX += fbX; acc.fbY += fbY; acc.fdX += fdX; acc.fdY += fdY;
        acc.fcX += phys.fcX; acc.fcY += phys.fcY;
        acc.netX += fbX + fdX + phys.fcX + gX;
        acc.netY += fbY + fdY + phys.fcY + gY - Mtot * g + airB;
        if (phys.contactW > 0) { acc.cpx += phys.contactPX; acc.cpy += phys.contactPY; acc.cw += 1; }
        simTime += dt;
    }

    function solveContacts(dt, invMx, invMy, invI, c, s) {
        const B = body;
        let nc = 0;
        let vx = st.vx, vy = st.vy, om = st.om;
        for (let h = 0; h < B.nh && nc < MAX_CONTACTS - 4; h++) {
            const rx = c * B.hullX[h] - s * B.hullY[h];
            const ry = s * B.hullX[h] + c * B.hullY[h];
            const px = st.x + rx, py = st.y + ry;
            for (let w = 0; w < 4; w++) {
                let nx, ny, pen;
                if (w === 0) { nx = 0; ny = 1; pen = -py; }
                else if (w === 1) { nx = 1; ny = 0; pen = -px; }
                else if (w === 2) { nx = -1; ny = 0; pen = px - TANK_W; }
                else { nx = 0; ny = -1; pen = py - TANK_H; }
                if (pen < -SPECULATIVE) continue;
                const tx = -ny, ty = nx;
                const rn = rx * ny - ry * nx, rt = rx * ty - ry * tx;
                cRX[nc] = rx; cRY[nc] = ry; cNX[nc] = nx; cNY[nc] = ny;
                cMN[nc] = 1 / (nx * nx * invMx + ny * ny * invMy + rn * rn * invI);
                cMT[nc] = 1 / (tx * tx * invMx + ty * ty * invMy + rt * rt * invI);
                const vn0 = (vx - om * ry) * nx + (vy + om * rx) * ny;
                let target;
                if (pen >= 0) target = vn0 < -BOUNCE_SPEED ? -RESTITUTION * vn0 : 0;
                else if (vn0 * dt < pen && vn0 < -BOUNCE_SPEED) target = -RESTITUTION * vn0;
                else target = pen / dt;
                cTarget[nc] = target;
                cLam[nc] = 0; cLamT[nc] = 0;
                nc++;
            }
        }
        let fx = 0, fy = 0, cpx = 0, cpy = 0, cw = 0;
        if (nc > 0) {
            for (let it = 0; it < CONTACT_ITERS; it++) {
                for (let k = 0; k < nc; k++) {
                    const rx = cRX[k], ry = cRY[k], nx = cNX[k], ny = cNY[k];
                    let vpx = vx - om * ry, vpy = vy + om * rx;
                    const vn = vpx * nx + vpy * ny;
                    let dl = cMN[k] * (cTarget[k] - vn);
                    const l0 = cLam[k];
                    const l1 = l0 + dl > 0 ? l0 + dl : 0;
                    dl = l1 - l0; cLam[k] = l1;
                    if (dl !== 0) {
                        vx += dl * nx * invMx; vy += dl * ny * invMy; om += dl * (rx * ny - ry * nx) * invI;
                    }
                    const tx = -ny, ty = nx;
                    vpx = vx - om * ry; vpy = vy + om * rx;
                    const vt = vpx * tx + vpy * ty;
                    let dt2 = -cMT[k] * vt;
                    const lt0 = cLamT[k], maxF = FRICTION * cLam[k];
                    let lt1 = lt0 + dt2;
                    if (lt1 > maxF) lt1 = maxF; else if (lt1 < -maxF) lt1 = -maxF;
                    dt2 = lt1 - lt0; cLamT[k] = lt1;
                    if (dt2 !== 0) {
                        vx += dt2 * tx * invMx; vy += dt2 * ty * invMy; om += dt2 * (rx * ty - ry * tx) * invI;
                    }
                }
            }
            for (let k = 0; k < nc; k++) {
                const jx = cLam[k] * cNX[k] - cLamT[k] * cNY[k];
                const jy = cLam[k] * cNY[k] + cLamT[k] * cNX[k];
                fx += jx / dt; fy += jy / dt;
                if (cLam[k] > 0) { cpx += (st.x + cRX[k]) * cLam[k]; cpy += (st.y + cRY[k]) * cLam[k]; cw += cLam[k]; }
            }
        }
        st.vx = vx; st.vy = vy; st.om = invI > 0 ? om : 0;
        phys.fcX = fx; phys.fcY = fy;
        phys.contactW = cw;
        if (cw > 0) { phys.contactPX = cpx / cw; phys.contactPY = cpy / cw; }
    }

    function projectOutOfWalls() {
        const B = body;
        const c = Math.cos(st.th), s = Math.sin(st.th);
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let h = 0; h < B.nh; h++) {
            const px = st.x + c * B.hullX[h] - s * B.hullY[h];
            const py = st.y + s * B.hullX[h] + c * B.hullY[h];
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
        }
        if (minY < -SLOP) st.y += -minY - SLOP;
        else if (maxY > TANK_H + SLOP) st.y -= maxY - TANK_H - SLOP;
        if (minX < -SLOP) st.x += -minX - SLOP;
        else if (maxX > TANK_W + SLOP) st.x -= maxX - TANK_W - SLOP;
    }

    // ------------------------------------------------------------------
    // Open cavities: flooding, venting, draining (once per frame)
    // ------------------------------------------------------------------
    function stepCavities(dtF) {
        const B = body;
        if (!B || B.nOpen === 0 || dtF <= 0) return;
        const LW = B.LW, ltype = B.ltype, Y = B.cy, sub = B.csub;
        const R = B.fR, V = B.fV, D = B.fD, queue = B.queue;
        const c = Math.cos(st.th), s = Math.sin(st.th);
        const region = B.cavRegion;
        for (let q = 0; q < region.length; q++) {
            const li = region[q];
            const lc = li % LW, lr = (li - lc) / LW;
            const ox = (lc + 0.5) * CELL - B.comLX, oy = (lr + 0.5) * CELL - B.comLY;
            const X = st.x + c * ox - s * oy;
            const yy = st.y + s * ox + c * oy;
            Y[li] = yy;
            sub[li] = yy < surfaceAt(X) ? 1 : 0;
            R[li] = 0; V[li] = 0; D[li] = 0;
        }
        const pairs = B.openPairs;
        const np = pairs.length;
        let qh, qt;
        // R: connected to the outside liquid through submerged cells
        qh = 0; qt = 0;
        for (let p = 0; p < np; p += 2) {
            const o = pairs[p], e = pairs[p + 1];
            if (sub[e] && sub[o] && !R[o]) { R[o] = 1; queue[qt++] = o; }
        }
        while (qh < qt) {
            const k = queue[qh++];
            const nb0 = k - 1, nb1 = k + 1, nb2 = k - LW, nb3 = k + LW;
            if (ltype[nb0] === T_OPEN && !R[nb0] && sub[nb0]) { R[nb0] = 1; queue[qt++] = nb0; }
            if (ltype[nb1] === T_OPEN && !R[nb1] && sub[nb1]) { R[nb1] = 1; queue[qt++] = nb1; }
            if (ltype[nb2] === T_OPEN && !R[nb2] && sub[nb2]) { R[nb2] = 1; queue[qt++] = nb2; }
            if (ltype[nb3] === T_OPEN && !R[nb3] && sub[nb3]) { R[nb3] = 1; queue[qt++] = nb3; }
        }
        // V: air can get out - bubbling upwards through anything, or in any direction
        // through connected air (dry cavity cells and outside air above the liquid)
        const W = B.water, lcell = B.lcell, oc = B.openCells;
        qh = 0; qt = 0;
        for (let p = 0; p < np; p += 2) {
            const o = pairs[p], e = pairs[p + 1];
            if (!V[o] && (Y[o] <= Y[e] + LEVEL_EPS || (!sub[e] && W[lcell[o]] < 0.5))) { V[o] = 1; queue[qt++] = o; }
        }
        while (qh < qt) {
            const k = queue[qh++];
            const yk = Y[k] + LEVEL_EPS;
            const airK = W[lcell[k]] < 0.5;
            for (let z = 0; z < 4; z++) {
                const j = z === 0 ? k - 1 : z === 1 ? k + 1 : z === 2 ? k - LW : k + LW;
                if (ltype[j] !== T_OPEN || V[j]) continue;
                if (Y[j] <= yk || (airK && W[lcell[j]] < 0.5)) { V[j] = 1; queue[qt++] = j; }
            }
        }
        // D: liquid can run out (a path to the outside that never goes up)
        qh = 0; qt = 0;
        for (let p = 0; p < np; p += 2) {
            const o = pairs[p], e = pairs[p + 1];
            if (!D[o] && Y[o] >= Y[e] - LEVEL_EPS) { D[o] = 1; queue[qt++] = o; }
        }
        while (qh < qt) {
            const k = queue[qh++];
            const yk = Y[k] - LEVEL_EPS;
            const nb0 = k - 1, nb1 = k + 1, nb2 = k - LW, nb3 = k + LW;
            if (ltype[nb0] === T_OPEN && !D[nb0] && Y[nb0] >= yk) { D[nb0] = 1; queue[qt++] = nb0; }
            if (ltype[nb1] === T_OPEN && !D[nb1] && Y[nb1] >= yk) { D[nb1] = 1; queue[qt++] = nb1; }
            if (ltype[nb2] === T_OPEN && !D[nb2] && Y[nb2] >= yk) { D[nb2] = 1; queue[qt++] = nb2; }
            if (ltype[nb3] === T_OPEN && !D[nb3] && Y[nb3] >= yk) { D[nb3] = 1; queue[qt++] = nb3; }
        }

        let changed = false;
        for (let q = 0; q < oc.length; q++) {
            const bi = oc[q];
            const li = B.cellLocal[bi];
            let w = W[bi];
            const w0 = w;
            if (R[li] && V[li]) {
                if (w < 1) {
                    let front = false;
                    const nbs0 = li - 1, nbs1 = li + 1, nbs2 = li - LW, nbs3 = li + LW;
                    for (let z = 0; z < 4 && !front; z++) {
                        const nb = z === 0 ? nbs0 : z === 1 ? nbs1 : z === 2 ? nbs2 : nbs3;
                        const t = ltype[nb];
                        if (t === T_EXT) { if (sub[nb]) front = true; }
                        else if (t === T_OPEN && R[nb] && V[nb] && W[lcell[nb]] >= 0.5) front = true;
                    }
                    if (front) w = Math.min(1, w + FILL_RATE * dtF);
                }
            } else if (D[li] && !sub[li]) {
                w = Math.max(0, w - DRAIN_RATE * dtF);
            }
            if (w !== w0) { W[bi] = w; changed = true; }
        }
        // Trapped pockets (air that cannot escape): the air volume is conserved and always
        // rises to the highest cells of the pocket, so the inside surface stays level.
        const mark = B.pocketMark, order = B.order;
        B.pocketGen = (B.pocketGen + 1) & 0x3fffffff || 1;
        const gen = B.pocketGen;
        for (let q = 0; q < oc.length; q++) {
            const start = B.cellLocal[oc[q]];
            if (V[start] || mark[start] === gen) continue;
            let n = 0;
            let ySpill = -Infinity;  // highest point of the pocket's opening: air below it is exposed and escapes
            mark[start] = gen; order[n++] = start;
            for (let h = 0; h < n; h++) {
                const k = order[h];
                for (let z = 0; z < 4; z++) {
                    const j = z === 0 ? k - 1 : z === 1 ? k + 1 : z === 2 ? k - LW : k + LW;
                    const tj = ltype[j];
                    if (tj === T_OPEN) {
                        if (!V[j] && mark[j] !== gen) { mark[j] = gen; order[n++] = j; }
                    } else if (tj === T_EXT) {
                        const ys = 0.5 * (Y[k] + Y[j]);
                        if (ys > ySpill) ySpill = ys;
                    }
                }
            }
            let air = 0, cap = 0;
            for (let h = 0; h < n; h++) {
                const k = order[h];
                air += 1 - W[lcell[k]];
                const f = (Y[k] - ySpill) / CELL + 0.5;
                cap += f > 1 ? 1 : (f > 0 ? f : 0);
            }
            if (air > cap) air = cap;    // the excess bubbles out under the rim
            if (air <= 1e-6) air = 0;
            order.subarray(0, n).sort((a, b) => Y[b] - Y[a]);
            for (let h = 0; h < n; h++) {
                const bi = lcell[order[h]];
                const a = air > 1 ? 1 : (air > 0 ? air : 0);
                air -= a;
                const w = 1 - a;
                if (Math.abs(W[bi] - w) > 1e-9) { W[bi] = w; changed = true; }
            }
        }
        // liquid in vented cavities runs downhill
        const maxMove = SETTLE_RATE * dtF;
        for (let q = 0; q < oc.length; q++) {
            const bi = oc[q];
            let w = W[bi];
            if (w <= 0) continue;
            const li = B.cellLocal[bi];
            if (!V[li]) continue;
            let best = -1, bestY = Y[li] - LEVEL_EPS;
            for (let z = 0; z < 4; z++) {
                const nb = z === 0 ? li - 1 : z === 1 ? li + 1 : z === 2 ? li - LW : li + LW;
                if (ltype[nb] === T_OPEN && V[nb] && Y[nb] < bestY && W[lcell[nb]] < 1) { best = nb; bestY = Y[nb]; }
            }
            if (best >= 0) {
                const bj = lcell[best];
                const mv = Math.min(w, 1 - W[bj], maxMove);
                if (mv > 0) { W[bi] = w - mv; W[bj] += mv; changed = true; }
            }
        }
        let held = 0;
        for (let q = 0; q < oc.length; q++) {
            const bi = oc[q];
            if (W[bi] > 0 && !(R[B.cellLocal[bi]] && sub[B.cellLocal[bi]])) held += W[bi];
        }
        B.waterHeld = held * LIQUIDS[settings.liquid].rho * CELL_A * DEPTH;
        if (changed) {
            updateWaterMass(B);
            for (let q = 0; q < oc.length; q++) {
                const bi = oc[q];
                const shown = W[bi] >= 0.5 ? 1 : 0;
                if (shown !== B.waterShown[bi]) { B.waterShown[bi] = shown; B.cavDirty = true; }
            }
        }
    }

    // ------------------------------------------------------------------
    // Simulation control
    // ------------------------------------------------------------------
    function resetAccumulators() {
        acc.n = 0; acc.fbX = acc.fbY = acc.fdX = acc.fdY = acc.fcX = acc.fcY = acc.netX = acc.netY = 0;
        acc.cpx = acc.cpy = acc.cw = 0;
    }

    function dropObject() {
        const P = analyzeGrid();
        if (!P) {
            setHint('Draw something first: pick a material and drag on the tank.');
            return false;
        }
        body = P;
        preview = P;
        prepareBodyDynamics(body);
        st.x = body.worldX; st.y = body.worldY; st.th = 0; st.vx = 0; st.vy = 0;
        // no real object is released perfectly symmetrically: a tiny nudge lets unstable balance points tip
        st.om = settings.rotation ? 2e-3 : 0;
        st.maValid = false;
        grab.active = false;
        clearWaves();
        level = drawModeLevel(body);
        for (let it = 0; it < 8; it++) {
            const tot = calmDisplacement(bOld);
            level = clamp((liquidArea() + tot) / TANK_W, 0.001, TANK_H);
        }
        updateWaveCoefficients();
        Object.keys(disp).forEach((k) => { disp[k] = 0; });
        resetAccumulators();
        simTime = 0;
        mode = 'sim';
        updateModeUI();
        updateStatsDisplay(true);
        return true;
    }

    function enterEditMode() {
        mode = 'draw';
        body = null;
        grab.active = false;
        clearWaves();
        drawDirty = true;
        updateModeUI();
        updateStatsDisplay(true);
    }

    function simulate(seconds) {
        if (mode !== 'sim' || !body) return 0;
        let n = 0;
        let acc2 = seconds;
        let sinceCavity = 0;
        updateWaveCoefficients();
        while (acc2 >= DT - 1e-12) {
            substep(DT);
            acc2 -= DT;
            n++;
            sinceCavity += DT;
            if (sinceCavity >= 1 / 60 - 1e-9) { stepCavities(sinceCavity); stepParticles(sinceCavity); sinceCavity = 0; }
        }
        if (sinceCavity > 0) { stepCavities(sinceCavity); stepParticles(sinceCavity); }
        return n;
    }

    // ------------------------------------------------------------------
    // Drawing tools
    // ------------------------------------------------------------------
    function pushUndo() {
        undoStack.push(grid.slice());
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    }
    function undo() {
        if (!undoStack.length) return;
        grid.set(undoStack.pop());
        if (mode !== 'draw') enterEditMode();
        drawDirty = true;
    }
    function setCell(c, r, v) {
        if (c < 0 || r < 0 || c >= GW || r >= GH) return;
        grid[r * GW + c] = v;
    }
    function paintDisc(x, y, size, v) {
        const cx = x / CELL, cy = y / CELL;
        if (size <= 1) { setCell(Math.floor(cx), Math.floor(cy), v); return; }
        const rad = size / 2;
        const rr = rad * rad;
        let painted = false;
        for (let r = Math.floor(cy - rad); r <= Math.ceil(cy + rad); r++) {
            for (let c = Math.floor(cx - rad); c <= Math.ceil(cx + rad); c++) {
                const dx = c + 0.5 - cx, dy = r + 0.5 - cy;
                if (dx * dx + dy * dy <= rr) { setCell(c, r, v); painted = true; }
            }
        }
        if (!painted) setCell(Math.floor(cx), Math.floor(cy), v);
    }
    function paintLine(x0, y0, x1, y1, size, v) {
        const dist = Math.hypot(x1 - x0, y1 - y0);
        const step = Math.max(0.3 * CELL, size * CELL * 0.25);
        const n = Math.max(1, Math.ceil(dist / step));
        for (let i = 1; i <= n; i++) paintDisc(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, size, v);
    }
    function insideEllipse(c, r, ecx, ecy, rx, ry) {
        if (rx <= 0 || ry <= 0) return false;
        const dx = (c + 0.5 - ecx) / rx, dy = (r + 0.5 - ecy) / ry;
        return dx * dx + dy * dy <= 1;
    }
    // Calls fn(c, r) for every cell of a shape spanning cells [cA..cB] x [rA..rB]
    function forEachShapeCell(tool, cA, rA, cB, rB, thick, fn) {
        const w = cB - cA + 1, h = rB - rA + 1;
        if (tool === 'rect') {
            for (let r = rA; r <= rB; r++) for (let c = cA; c <= cB; c++) fn(c, r);
        } else if (tool === 'box') {
            for (let r = rA; r <= rB; r++) for (let c = cA; c <= cB; c++) {
                if (c - cA < thick || cB - c < thick || r - rA < thick || rB - r < thick) fn(c, r);
            }
        } else if (tool === 'ellipse' || tool === 'ring') {
            const ecx = cA + w / 2, ecy = rA + h / 2, rx = w / 2, ry = h / 2;
            for (let r = rA; r <= rB; r++) for (let c = cA; c <= cB; c++) {
                if (!insideEllipse(c, r, ecx, ecy, rx, ry)) continue;
                if (tool === 'ellipse') { fn(c, r); continue; }
                let shell = !insideEllipse(c, r, ecx, ecy, rx - thick, ry - thick);
                if (!shell) {
                    // keep the outer layer 4-connected so the ring always seals
                    for (let dr = -1; dr <= 1 && !shell; dr++) for (let dc = -1; dc <= 1; dc++) {
                        if (!insideEllipse(c + dc, r + dr, ecx, ecy, rx, ry)) { shell = true; break; }
                    }
                }
                if (shell) fn(c, r);
            }
        }
    }
    function shapeBounds(x0, y0, x1, y1, square) {
        let cA = Math.floor(Math.min(x0, x1) / CELL), cB = Math.floor(Math.max(x0, x1) / CELL);
        let rA = Math.floor(Math.min(y0, y1) / CELL), rB = Math.floor(Math.max(y0, y1) / CELL);
        if (square) {
            const size = Math.max(cB - cA, rB - rA);
            if (x1 >= x0) cB = cA + size; else cA = cB - size;
            if (y1 >= y0) rB = rA + size; else rA = rB - size;
        }
        return { cA: clamp(cA, 0, GW - 1), cB: clamp(cB, 0, GW - 1), rA: clamp(rA, 0, GH - 1), rB: clamp(rB, 0, GH - 1) };
    }
    function floodFill(c, r, v) {
        if (c < 0 || r < 0 || c >= GW || r >= GH) return;
        const start = r * GW + c;
        const target = grid[start];
        if (target === v) return;
        const visited = new Uint8Array(GW * GH);
        const q = new Int32Array(GW * GH);
        let qh = 0, qt = 0, touchesBorder = false;
        visited[start] = 1; q[qt++] = start;
        while (qh < qt) {
            const i = q[qh++];
            const ci = i % GW, ri = (i - ci) / GW;
            if (ci === 0 || ri === 0 || ci === GW - 1 || ri === GH - 1) touchesBorder = true;
            if (ci > 0 && !visited[i - 1] && grid[i - 1] === target) { visited[i - 1] = 1; q[qt++] = i - 1; }
            if (ci < GW - 1 && !visited[i + 1] && grid[i + 1] === target) { visited[i + 1] = 1; q[qt++] = i + 1; }
            if (ri > 0 && !visited[i - GW] && grid[i - GW] === target) { visited[i - GW] = 1; q[qt++] = i - GW; }
            if (ri < GH - 1 && !visited[i + GW] && grid[i + GW] === target) { visited[i + GW] = 1; q[qt++] = i + GW; }
        }
        if (target === 0 && touchesBorder) {
            setHint('Fill works inside a closed outline (or to recolour a solid region).');
            return false;
        }
        pushUndo();
        for (let k = 0; k < qt; k++) grid[q[k]] = v;
        drawDirty = true;
        return true;
    }

    // ------------------------------------------------------------------
    // Presets
    // ------------------------------------------------------------------
    function fillRect(c, r, w, h, m) { for (let rr = r; rr < r + h; rr++) for (let cc = c; cc < c + w; cc++) setCell(cc, rr, m); }
    function fillShape(tool, cA, rA, cB, rB, thick, m, filter) {
        forEachShapeCell(tool, cA, rA, cB, rB, thick, (c, r) => { if (!filter || filter(c, r)) setCell(c, r, m); });
    }
    const PRESETS = [
        { key: 'boat', label: 'Steel boat (open hull)', build() {
            const S = MAT_ID.steel;
            fillRect(62, 52, 76, 1, S); fillRect(62, 53, 1, 23, S); fillRect(137, 53, 1, 23, S);
        } },
        { key: 'pine', label: 'Pine block', build() { fillRect(85, 60, 30, 20, MAT_ID.pine); } },
        { key: 'ice', label: 'Ice cube', build() { fillRect(90, 58, 20, 20, MAT_ID.ice); } },
        { key: 'steel', label: 'Steel block', build() { fillRect(90, 60, 20, 12, MAT_ID.steel); } },
        { key: 'ball', label: 'Hollow steel ball (sealed)', build() { fillShape('ring', 75, 50, 124, 99, 1, MAT_ID.steel); } },
        { key: 'canoe', label: 'Aluminium canoe', build() {
            fillShape('ring', 66, 58, 133, 105, 1, MAT_ID.aluminium, (c, r) => r < 82);
        } },
        { key: 'bell', label: 'Upside-down steel cup (traps air)', build() {
            const S = MAT_ID.steel;
            fillRect(80, 80, 40, 1, S); fillRect(80, 60, 1, 20, S); fillRect(119, 60, 1, 20, S);
        } },
        { key: 'blend', label: 'Cork float with steel weight under one end', build() {
            fillRect(70, 63, 60, 10, MAT_ID.cork); fillRect(72, 60, 6, 3, MAT_ID.steel);
        } },
        { key: 'plank', label: 'Tall pine plank (stability)', build() { fillRect(97, 56, 6, 38, MAT_ID.pine); } },
        { key: 'nylon', label: 'Nylon block (sinks slowly)', build() { fillRect(90, 60, 20, 15, MAT_ID.nylon); } },
        { key: 'cork', label: 'Cork slab', build() { fillRect(80, 60, 40, 8, MAT_ID.cork); } },
        { key: 'gold', label: 'Gold bar', build() { fillRect(92, 60, 16, 8, MAT_ID.gold); } }
    ];
    function loadPreset(key, opts) {
        const p = PRESETS.find((q) => q.key === key);
        if (!p) return false;
        pushUndo();
        grid.fill(0);
        p.build();
        drawDirty = true;
        if (!opts || opts.drop !== false) dropObject();
        else enterEditMode();
        return true;
    }

    // ------------------------------------------------------------------
    // Canvas size / palette / textures
    // ------------------------------------------------------------------
    function handleResize() {
        const box = canvas.parentElement;
        if (!box) return;
        const isFs = document.body.classList.contains('sim-fullscreen-active');
        const aspect = TANK_W / TANK_H;
        let tw, th;
        if (isFs) {
            const wrap = box.parentElement;
            if (!wrap) return;
            const aw = wrap.clientWidth, ah = wrap.clientHeight;
            if (aw <= 0 || ah <= 0) return;
            if (aw / ah > aspect) { th = ah; tw = th * aspect; } else { tw = aw; th = tw / aspect; }
            const ws = Math.floor(tw) + 'px', hs = Math.floor(th) + 'px';
            if (box.style.width !== ws) box.style.width = ws;
            if (box.style.height !== hs) box.style.height = hs;
            tw = Math.floor(tw); th = Math.floor(th);
        } else {
            if (box.style.width) box.style.width = '';
            if (box.style.height) box.style.height = '';
            const r = box.getBoundingClientRect();
            tw = r.width; th = r.height;
        }
        tw = Math.max(1, Math.round(tw));
        th = Math.max(1, Math.round(th));
        const ndpr = Math.min(3, window.devicePixelRatio || 1);
        if (tw !== cssW || th !== cssH || ndpr !== dpr) {
            cssW = tw; cssH = th; dpr = ndpr;
            scale = cssW / TANK_W;
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
            gridLayerDirty = true;
            drawDirty = true;
            gradientKey = '';
            if (body) { body.imgKey = ''; body.cavKey = ''; }
        }
    }

    function refreshPalette() {
        const dark = !document.documentElement.classList.contains('light-mode') &&
            document.documentElement.classList.contains('dark-mode');
        const cs = getComputedStyle(document.documentElement);
        const text = (cs.getPropertyValue('--color-text') || '').trim() || (dark ? '#e0e0e0' : '#585858');
        pal = {
            dark,
            text,
            bgTop: dark ? '#1a1e23' : '#f7f9fb',
            bgBot: dark ? '#22282f' : '#e4eaf0',
            air: dark ? '#2b3641' : '#e6f0f8',
            hatch: dark ? 'rgba(170,205,235,0.45)' : 'rgba(70,105,140,0.4)',
            gridMinor: dark ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.05)',
            gridMajor: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.13)',
            gridLabel: dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.45)',
            outline: dark ? 'rgba(8,10,14,0.85)' : 'rgba(30,35,40,0.75)',
            seam: dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.25)',
            wall: dark ? 'rgba(200,215,230,0.35)' : 'rgba(60,80,100,0.35)',
            halo: dark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)',
            net: dark ? '#ffffff' : '#1d2329',
            panel: dark ? 'rgba(20,24,28,0.78)' : 'rgba(255,255,255,0.85)',
            panelBorder: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'
        };
        ARROWS.net.color = pal.net;
        gradientKey = '';
        textureKey = '';
        gridLayerDirty = true;
        drawDirty = true;
        if (body) { body.imgKey = ''; body.cavKey = ''; }
    }

    function makeTexture(mat, pxPerM, seed) {
        const size = Math.max(24, Math.round(0.16 * pxPerM));
        const cv = document.createElement('canvas');
        cv.width = cv.height = size;
        const g = cv.getContext('2d');
        const rnd = mulberry32(seed);
        const cm = pxPerM * 0.01;
        g.fillStyle = mat.color;
        g.fillRect(0, 0, size, size);
        if (mat.tex === 'speckle') {
            const nDots = Math.round(size * size / (cm * cm) * 1.6);
            for (let i = 0; i < nDots; i++) {
                g.fillStyle = rnd() < 0.6 ? mat.dark : mat.light;
                g.globalAlpha = 0.25 + rnd() * 0.45;
                const r = Math.max(0.5, cm * (0.05 + rnd() * 0.14));
                const x = rnd() * size, y = rnd() * size;
                g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
            }
        } else if (mat.tex === 'grain') {
            g.strokeStyle = mat.dark;
            g.lineWidth = Math.max(0.6, cm * 0.08);
            let y = rnd() * cm;
            while (y < size) {
                g.globalAlpha = 0.18 + rnd() * 0.3;
                const a = cm * (0.1 + rnd() * 0.25), ph = rnd() * 6.283, per = 1 + Math.floor(rnd() * 3);
                for (let off = -size; off <= size; off += size) {
                    g.beginPath();
                    for (let x = 0; x <= size; x += Math.max(1, size / 48)) {
                        const yy = y + off + a * Math.sin(ph + 6.283 * per * x / size);
                        if (x === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
                    }
                    g.stroke();
                }
                y += cm * (0.35 + rnd() * 0.6);
            }
        } else if (mat.tex === 'ice') {
            g.strokeStyle = mat.light;
            g.lineWidth = Math.max(0.8, cm * 0.12);
            for (let i = 0; i < 7; i++) {
                g.globalAlpha = 0.25 + rnd() * 0.35;
                const x = rnd() * size, y = rnd() * size, l = cm * (1 + rnd() * 3);
                for (let ox = -size; ox <= size; ox += size) for (let oy = -size; oy <= size; oy += size) {
                    g.beginPath(); g.moveTo(x + ox, y + oy); g.lineTo(x + ox + l, y + oy - l); g.stroke();
                }
            }
            g.strokeStyle = mat.dark;
            g.lineWidth = Math.max(0.5, cm * 0.05);
            for (let i = 0; i < 4; i++) {
                g.globalAlpha = 0.35;
                let x = rnd() * size, y = rnd() * size;
                g.beginPath(); g.moveTo(x, y);
                for (let k = 0; k < 4; k++) { x += (rnd() - 0.5) * cm * 2; y += (rnd() - 0.5) * cm * 2; g.lineTo(x, y); }
                g.stroke();
            }
        } else if (mat.tex === 'smooth') {
            for (let i = 0; i < size * size / (cm * cm); i++) {
                g.fillStyle = rnd() < 0.5 ? mat.dark : mat.light;
                g.globalAlpha = 0.08 + rnd() * 0.08;
                g.fillRect(rnd() * size, rnd() * size, Math.max(1, cm * 0.2), Math.max(1, cm * 0.2));
            }
        } else if (mat.tex === 'brushed') {
            const step = Math.max(1, cm * 0.12);
            for (let y = 0; y < size; y += step) {
                g.fillStyle = rnd() < 0.5 ? mat.dark : mat.light;
                g.globalAlpha = 0.08 + rnd() * 0.22;
                g.fillRect(0, y, size, step * (0.5 + rnd() * 0.6));
            }
        } else if (mat.tex === 'sheen') {
            g.fillStyle = mat.light;
            const band = size / 4;
            for (let k = -2; k < 4; k++) {
                g.globalAlpha = 0.28;
                g.beginPath();
                g.moveTo(k * size / 2, size); g.lineTo(k * size / 2 + band, size);
                g.lineTo(k * size / 2 + band + size, 0); g.lineTo(k * size / 2 + size, 0);
                g.closePath(); g.fill();
            }
            g.globalAlpha = 0.18;
            g.fillStyle = mat.dark;
            for (let i = 0; i < 40; i++) g.fillRect(rnd() * size, rnd() * size, Math.max(1, cm * 0.15), Math.max(1, cm * 0.15));
        }
        g.globalAlpha = 1;
        return cv;
    }

    function makeHatch(pxPerM) {
        const size = Math.max(6, Math.round(0.008 * pxPerM));
        const cv = document.createElement('canvas');
        cv.width = cv.height = size;
        const g = cv.getContext('2d');
        g.fillStyle = pal.air;
        g.fillRect(0, 0, size, size);
        g.strokeStyle = pal.hatch;
        g.lineWidth = Math.max(1, size * 0.14);
        g.beginPath();
        g.moveTo(-1, size + 1); g.lineTo(size + 1, -1);
        g.moveTo(-1, 1); g.lineTo(1, -1);
        g.moveTo(size - 1, size + 1); g.lineTo(size + 1, size - 1);
        g.stroke();
        return cv;
    }

    function ensureTextures() {
        const pxPerM = scale * dpr;
        const key = pxPerM.toFixed(2) + (pal.dark ? 'd' : 'l');
        if (key === textureKey && textures) return;
        textureKey = key;
        textures = [null];
        for (let i = 1; i < MATERIALS.length; i++) textures.push(makeTexture(MATERIALS[i], pxPerM, 1234 + i * 77));
        textures.push(makeHatch(pxPerM));  // index 8 = sealed air
    }

    // Paints cells of a kind grid (0 empty, 1..7 material, 8 sealed) into g.
    // layers: bit 1 = material fills, bit 2 = sealed air, bit 4 = outlines
    function paintCells(g, kinds, W, H, cellPx, outlineW, layers) {
        if (layers === undefined) layers = 7;
        ensureTextures();
        const paths = [];
        for (let m = 0; m <= K_SEALED; m++) paths.push(null);
        const xs = new Float64Array(W + 1);
        for (let c = 0; c <= W; c++) xs[c] = Math.round(c * cellPx);
        const ys = new Float64Array(H + 1);
        for (let r = 0; r <= H; r++) ys[r] = Math.round((H - r) * cellPx);  // row r spans ys[r+1]..ys[r]
        for (let r = 0; r < H; r++) {
            let c = 0;
            while (c < W) {
                const k = kinds[r * W + c];
                if (!k) { c++; continue; }
                let e = c + 1;
                while (e < W && kinds[r * W + e] === k) e++;
                if (!paths[k]) paths[k] = new Path2D();
                paths[k].rect(xs[c], ys[r + 1], xs[e] - xs[c], ys[r] - ys[r + 1]);
                c = e;
            }
        }
        for (let m = 1; m <= K_SEALED; m++) {
            if (!paths[m]) continue;
            if (m === K_SEALED ? !(layers & 2) : !(layers & 1)) continue;
            const pat = g.createPattern(textures[m], 'repeat');
            g.fillStyle = pat || (m === K_SEALED ? pal.air : MATERIALS[m].color);
            g.fill(paths[m]);
        }
        if (!(layers & 4)) return;
        // outlines: material next to non-material (strong) and between materials (faint)
        const strong = new Path2D(), faint = new Path2D();
        const isMat = (k) => k >= 1 && k <= 7;
        for (let r = 0; r < H; r++) {
            for (let c = 0; c < W; c++) {
                const k = kinds[r * W + c];
                if (!isMat(k)) continue;
                const right = c + 1 < W ? kinds[r * W + c + 1] : 0;
                const up = r + 1 < H ? kinds[(r + 1) * W + c] : 0;
                const left = c > 0 ? kinds[r * W + c - 1] : 0;
                const down = r > 0 ? kinds[(r - 1) * W + c] : 0;
                if (!isMat(right)) { strong.moveTo(xs[c + 1], ys[r + 1]); strong.lineTo(xs[c + 1], ys[r]); }
                else if (right !== k) { faint.moveTo(xs[c + 1], ys[r + 1]); faint.lineTo(xs[c + 1], ys[r]); }
                if (!isMat(left)) { strong.moveTo(xs[c], ys[r + 1]); strong.lineTo(xs[c], ys[r]); }
                if (!isMat(up)) { strong.moveTo(xs[c], ys[r + 1]); strong.lineTo(xs[c + 1], ys[r + 1]); }
                else if (up !== k) { faint.moveTo(xs[c], ys[r + 1]); faint.lineTo(xs[c + 1], ys[r + 1]); }
                if (!isMat(down)) { strong.moveTo(xs[c], ys[r]); strong.lineTo(xs[c + 1], ys[r]); }
            }
        }
        g.lineCap = 'square';
        g.strokeStyle = pal.seam;
        g.lineWidth = Math.max(1, outlineW * 0.6);
        g.stroke(faint);
        g.strokeStyle = pal.outline;
        g.lineWidth = outlineW;
        g.stroke(strong);
    }

    function renderDrawLayer() {
        const W = canvas.width, H = canvas.height;
        for (const cv of [drawCanvas, drawTopCanvas]) {
            if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
            cv.getContext('2d').clearRect(0, 0, W, H);
        }
        preview = analyzeGrid();
        if (!preview) return;
        const kinds = grid.slice();
        for (let li = 0; li < preview.NL; li++) {
            if (preview.ltype[li] !== T_SEALED) continue;
            const lc = li % preview.LW, lr = (li - lc) / preview.LW;
            kinds[(preview.gr0 + lr) * GW + preview.gc0 + lc] = K_SEALED;
        }
        const cellPx = CELL * scale * dpr;
        const ow = Math.max(1, Math.min(2.5 * dpr, cellPx * 0.18));
        paintCells(drawCanvas.getContext('2d'), kinds, GW, GH, cellPx, ow, 1);
        paintCells(drawTopCanvas.getContext('2d'), kinds, GW, GH, cellPx, ow, 6);
    }

    function renderGridLayer() {
        const W = canvas.width, H = canvas.height;
        if (gridCanvas.width !== W || gridCanvas.height !== H) { gridCanvas.width = W; gridCanvas.height = H; }
        const g = gridCanvas.getContext('2d');
        g.clearRect(0, 0, W, H);
        const cellPx = CELL * scale * dpr;
        const minorStep = cellPx >= 7 ? 1 : (cellPx >= 3 ? 5 : 10);
        g.lineWidth = 1;
        for (let pass = 0; pass < 2; pass++) {
            g.strokeStyle = pass === 0 ? pal.gridMinor : pal.gridMajor;
            g.beginPath();
            for (let c = 0; c <= GW; c += minorStep) {
                const major = c % 10 === 0;
                if ((pass === 1) !== major) continue;
                const x = Math.round(c * cellPx) + 0.5;
                g.moveTo(x, 0); g.lineTo(x, H);
            }
            for (let r = 0; r <= GH; r += minorStep) {
                const major = r % 10 === 0;
                if ((pass === 1) !== major) continue;
                const y = Math.round((GH - r) * cellPx) + 0.5;
                g.moveTo(0, y); g.lineTo(W, y);
            }
            g.stroke();
        }
        // height labels every 10 cm
        g.fillStyle = pal.gridLabel;
        g.font = Math.round(clamp(cssW / 70, 8, 12) * dpr) + 'px "Source Sans Pro", Helvetica, sans-serif';
        g.textBaseline = 'bottom';
        g.textAlign = 'left';
        for (let r = 10; r < GH; r += 10) {
            g.fillText((r) + ' cm', 3 * dpr, Math.round((GH - r) * cellPx) - 1 * dpr);
        }
    }

    function renderBodyImage(B) {
        const cellPx = CELL * scale * dpr;
        const key = cellPx.toFixed(3) + (pal.dark ? 'd' : 'l');
        if (B.img && B.imgKey === key) return;
        const W = Math.max(1, Math.round(B.LW * cellPx)), H = Math.max(1, Math.round(B.LH * cellPx));
        if (!B.img) {
            B.img = document.createElement('canvas');
            B.airImg = document.createElement('canvas');
            B.lineImg = document.createElement('canvas');
        }
        const kinds = new Uint8Array(B.NL);
        let nSealed = 0;
        for (let li = 0; li < B.NL; li++) {
            const t = B.ltype[li];
            kinds[li] = t === T_MAT ? B.lmat[li] : (t === T_SEALED ? K_SEALED : 0);
            if (t === T_SEALED) nSealed++;
        }
        const ow = Math.max(1, Math.min(2.5 * dpr, cellPx * 0.18));
        const layers = [[B.img, 1], [B.airImg, 2], [B.lineImg, 4]];
        for (const [cv, bits] of layers) {
            cv.width = W; cv.height = H;
            const g = cv.getContext('2d');
            g.clearRect(0, 0, W, H);
            if (bits === 2 && !nSealed) continue;
            paintCells(g, kinds, B.LW, B.LH, cellPx, ow, bits);
        }
        B.hasSealed = nSealed > 0;
        B.imgKey = key;
        B.cavKey = '';
    }

    function renderCavityImages(B) {
        const cellPx = CELL * scale * dpr;
        const key = cellPx.toFixed(3) + (pal.dark ? 'd' : 'l') + settings.liquid;
        if (!B.cavDirty && B.cavKey === key) return;
        const W = Math.max(1, Math.round(B.LW * cellPx)), H = Math.max(1, Math.round(B.LH * cellPx));
        if (!B.cavAirImg) { B.cavAirImg = document.createElement('canvas'); B.cavWaterImg = document.createElement('canvas'); }
        for (const cv of [B.cavAirImg, B.cavWaterImg]) {
            if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
            cv.getContext('2d').clearRect(0, 0, W, H);
        }
        const air = new Path2D(), water = new Path2D();
        let nAir = 0, nWater = 0;
        const oc = B.openCells;
        for (let q = 0; q < oc.length; q++) {
            const bi = oc[q];
            const li = B.cellLocal[bi];
            const lc = li % B.LW, lr = (li - lc) / B.LW;
            const x0 = Math.round(lc * cellPx), x1 = Math.round((lc + 1) * cellPx);
            const y0 = Math.round((B.LH - lr - 1) * cellPx), y1 = Math.round((B.LH - lr) * cellPx);
            if (B.waterShown[bi]) { water.rect(x0, y0, x1 - x0, y1 - y0); nWater++; }
            else { air.rect(x0, y0, x1 - x0, y1 - y0); nAir++; }
        }
        if (nAir) { const g = B.cavAirImg.getContext('2d'); g.fillStyle = pal.air; g.fill(air); }
        if (nWater) {
            const g = B.cavWaterImg.getContext('2d');
            const liq = LIQUIDS[settings.liquid];
            g.fillStyle = 'rgba(' + liq.top.join(',') + ',' + Math.min(1, liq.aTop + 0.15) + ')';
            g.fill(water);
        }
        B.cavKey = key;
        B.cavDirty = false;
    }

    function ensureGradients() {
        const key = cssW + 'x' + cssH + settings.liquid + (pal.dark ? 'd' : 'l');
        if (key === gradientKey) return;
        gradientKey = key;
        bgGradient = ctx.createLinearGradient(0, 0, 0, cssH);
        bgGradient.addColorStop(0, pal.bgTop);
        bgGradient.addColorStop(1, pal.bgBot);
        const liq = LIQUIDS[settings.liquid];
        const k = pal.dark ? 1 : 0.85;
        liquidGradient = ctx.createLinearGradient(0, cssH * 0.2, 0, cssH);
        liquidGradient.addColorStop(0, 'rgba(' + liq.top.join(',') + ',' + (liq.aTop * k) + ')');
        liquidGradient.addColorStop(1, 'rgba(' + liq.bottom.join(',') + ',' + (liq.aBot * k) + ')');
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------
    function wy(y) { return (TANK_H - y) * scale; }
    function wx(x) { return x * scale; }

    function render() {
        if (!pal) refreshPalette();
        ensureGradients();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.fillStyle = bgGradient;
        ctx.fillRect(0, 0, cssW, cssH);

        // liquid region
        const liq = LIQUIDS[settings.liquid];
        const liqPath = new Path2D();
        const surf = new Path2D();
        liqPath.moveTo(0, cssH);
        const y0 = wy(level + eta[0]);
        liqPath.lineTo(0, y0);
        surf.moveTo(0, y0);
        for (let j = 0; j < NCOL; j++) {
            const x = wx((j + 0.5) * DXC), y = wy(level + eta[j]);
            liqPath.lineTo(x, y); surf.lineTo(x, y);
        }
        const yN = wy(level + eta[NCOL - 1]);
        liqPath.lineTo(cssW, yN); surf.lineTo(cssW, yN);
        liqPath.lineTo(cssW, cssH);
        liqPath.closePath();
        ctx.fillStyle = liquidGradient;
        ctx.fill(liqPath);

        if (mode === 'draw') {
            if (gridLayerDirty) { renderGridLayer(); gridLayerDirty = false; }
            ctx.drawImage(gridCanvas, 0, 0, cssW, cssH);
            if (drawDirty) { renderDrawLayer(); drawDirty = false; updateStatsDisplay(true); level = drawModeLevel(preview); }
            ctx.drawImage(drawCanvas, 0, 0, cssW, cssH);
        } else if (body) {
            drawBody(liqPath, 0);
        }

        // translucent liquid over submerged parts + surface line
        ctx.fillStyle = 'rgba(' + liq.top.join(',') + ',' + (pal.dark ? 0.16 : 0.14) + ')';
        ctx.fill(liqPath);
        ctx.strokeStyle = liq.surface;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 1.5;
        ctx.stroke(surf);
        ctx.globalAlpha = 1;
        if (mode === 'sim' && body) drawBody(liqPath, 1);
        else if (mode === 'draw') ctx.drawImage(drawTopCanvas, 0, 0, cssW, cssH);

        // droplets
        if (nParticles) {
            ctx.fillStyle = 'rgba(' + liq.top.join(',') + ',0.9)';
            ctx.beginPath();
            const r = Math.max(1, 0.004 * scale);
            for (let i = 0; i < nParticles; i++) {
                const x = wx(pX[i]), y = wy(pY[i]);
                ctx.moveTo(x + r, y);
                ctx.arc(x, y, r, 0, Math.PI * 2);
            }
            ctx.fill();
        }

        // tank walls
        ctx.strokeStyle = pal.wall;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(1, 0); ctx.lineTo(1, cssH - 1); ctx.lineTo(cssW - 1, cssH - 1); ctx.lineTo(cssW - 1, 0);
        ctx.stroke();

        drawLiquidLabel(liq);
        drawScaleBar();

        if (mode === 'sim' && body) {
            drawForces();
            if (grab.active) drawGrabLine();
        } else {
            drawToolPreview();
            if (!preview) drawEmptyHint();
        }
    }

    // pass 0: solid material (drawn before the liquid tint); pass 1: air pockets, liquid held
    // inside open cavities and outlines (drawn after the tint and waterline)
    function drawBody(liqPath, pass) {
        const B = body;
        renderBodyImage(B);
        if (B.nOpen) renderCavityImages(B);
        const ix = -B.comLX * scale, iy = -(B.LH * CELL - B.comLY) * scale;
        const iw = B.LW * CELL * scale, ih = B.LH * CELL * scale;
        const X = wx(st.x), Y = wy(st.y);
        if (pass === 0) {
            ctx.save();
            ctx.translate(X, Y);
            ctx.rotate(-st.th);
            ctx.drawImage(B.img, ix, iy, iw, ih);
            ctx.restore();
            return;
        }
        if (B.nOpen) {
            // air held in open cavities only shows where it keeps the liquid out
            ctx.save();
            ctx.clip(liqPath);
            ctx.translate(X, Y);
            ctx.rotate(-st.th);
            ctx.drawImage(B.cavAirImg, ix, iy, iw, ih);
            ctx.restore();
        }
        ctx.save();
        ctx.translate(X, Y);
        ctx.rotate(-st.th);
        if (B.hasSealed) ctx.drawImage(B.airImg, ix, iy, iw, ih);
        if (B.nOpen) ctx.drawImage(B.cavWaterImg, ix, iy, iw, ih);
        ctx.drawImage(B.lineImg, ix, iy, iw, ih);
        ctx.restore();
    }

    function drawArrow(x, y, fx, fy, color, kPx, maxLen) {
        const f = Math.hypot(fx, fy);
        let len = f * kPx;
        if (len < 5) return;
        let clipped = false;
        if (len > maxLen) { len = maxLen; clipped = true; }
        const ux = fx / f, uy = -fy / f;
        const ex = x + ux * len, ey = y + uy * len;
        const head = Math.min(11, Math.max(6, len * 0.35));
        const hx = ex - ux * head, hy = ey - uy * head;
        const px = -uy, py = ux;
        for (let pass = 0; pass < 2; pass++) {
            ctx.strokeStyle = pass === 0 ? pal.halo : color;
            ctx.fillStyle = pass === 0 ? pal.halo : color;
            ctx.lineWidth = pass === 0 ? 5 : 2.5;
            ctx.beginPath();
            ctx.moveTo(x, y); ctx.lineTo(hx, hy);
            ctx.stroke();
            ctx.beginPath();
            const hw = head * 0.5 + (pass === 0 ? 1.5 : 0);
            ctx.moveTo(ex + ux * (pass === 0 ? 2 : 0), ey + uy * (pass === 0 ? 2 : 0));
            ctx.lineTo(hx + px * hw, hy + py * hw);
            ctx.lineTo(hx - px * hw, hy - py * hw);
            ctx.closePath();
            ctx.fill();
            if (clipped) {
                const mx = x + ux * len * 0.5, my = y + uy * len * 0.5;
                ctx.beginPath();
                ctx.moveTo(mx + px * 6 - ux * 3, my + py * 6 - uy * 3); ctx.lineTo(mx - px * 6 - ux * 1, my - py * 6 - uy * 1);
                ctx.moveTo(mx + px * 6 + ux * 1, my + py * 6 + uy * 1); ctx.lineTo(mx - px * 6 + ux * 3, my - py * 6 + uy * 3);
                ctx.stroke();
            }
        }
    }

    function comWorld() {
        const B = body;
        const c = Math.cos(st.th), s = Math.sin(st.th);
        const M = B.mass + B.waterMass;
        const dx = B.waterMass > 0 ? B.waterMx / M : 0, dy = B.waterMass > 0 ? B.waterMy / M : 0;
        return [st.x + c * dx - s * dy, st.y + s * dx + c * dy];
    }

    function drawForces() {
        const B = body;
        const g = settings.gravity;
        const weight = (B.mass + B.waterMass) * g;
        const kPx = (0.17 * cssH) / Math.max(weight, 1e-6);
        const maxLen = 0.42 * cssH;
        const [cxw, cyw] = comWorld();
        const cx = wx(cxw), cy = wy(cyw);
        const A = settings.arrows;
        const legend = [];
        if (A.buoyancy && disp.sub > 0) {
            drawArrow(wx(phys.cobX), wy(phys.cobY), disp.fbX, disp.fbY, ARROWS.buoyancy.color, kPx, maxLen);
        }
        if (A.weight) drawArrow(cx, cy, 0, -weight, ARROWS.weight.color, kPx, maxLen);
        if (A.drag) drawArrow(cx, cy, disp.fdX, disp.fdY, ARROWS.drag.color, kPx, maxLen);
        if (A.contact && disp.hasContact > 0.05) drawArrow(wx(disp.cpx), wy(disp.cpy), disp.fcX, disp.fcY, ARROWS.contact.color, kPx, maxLen);
        if (A.net) drawArrow(cx, cy, disp.netX, disp.netY, ARROWS.net.color, kPx, maxLen);
        if (A.weight) legend.push(['weight', weight]);
        if (A.buoyancy) legend.push(['buoyancy', Math.hypot(disp.fbX, disp.fbY)]);
        if (A.drag) legend.push(['drag', Math.hypot(disp.fdX, disp.fdY)]);
        if (A.contact) legend.push(['contact', Math.hypot(disp.fcX, disp.fcY)]);
        if (A.net) legend.push(['net', Math.hypot(disp.netX, disp.netY)]);

        if (settings.markers) {
            // centre of mass: quartered disc
            const r = 6;
            ctx.lineWidth = 1.5;
            ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#111111';
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#111111';
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, 0, Math.PI / 2); ctx.closePath(); ctx.fill();
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, Math.PI, Math.PI * 1.5); ctx.closePath(); ctx.fill();
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
            if (disp.sub > 0) {
                const bx = wx(phys.cobX), by = wy(phys.cobY);
                ctx.strokeStyle = pal.halo; ctx.lineWidth = 4;
                ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2); ctx.stroke();
                ctx.strokeStyle = ARROWS.buoyancy.color; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2); ctx.stroke();
            }
        }
        if (legend.length || settings.markers) drawLegend(legend);
    }

    function drawLegend(rows) {
        const fs = clamp(cssW / 62, 9, 13);
        ctx.font = fs + 'px "Source Sans Pro", Helvetica, sans-serif';
        const lineH = fs * 1.35;
        const items = rows.map(([k, v]) => [ARROWS[k].color, ARROWS[k].label + ': ' + fmtAuto(v) + ' N']);
        if (settings.markers) items.push(['markers', 'Centre of mass / buoyancy']);
        let w = 0;
        for (const it of items) w = Math.max(w, ctx.measureText(it[1]).width);
        const pad = 6, sw = 18;
        const bw = w + sw + pad * 3, bh = items.length * lineH + pad * 1.5;
        const x0 = 8, y0 = 8;
        ctx.fillStyle = pal.panel;
        ctx.strokeStyle = pal.panelBorder;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(x0, y0, bw, bh);
        ctx.fill(); ctx.stroke();
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        items.forEach((it, i) => {
            const yy = y0 + pad * 0.75 + lineH * (i + 0.5);
            if (it[0] === 'markers') {
                ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#111111'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.arc(x0 + pad + 4, yy, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                ctx.fillStyle = '#111111';
                ctx.beginPath(); ctx.moveTo(x0 + pad + 4, yy); ctx.arc(x0 + pad + 4, yy, 4, 0, Math.PI / 2); ctx.closePath(); ctx.fill();
                ctx.beginPath(); ctx.moveTo(x0 + pad + 4, yy); ctx.arc(x0 + pad + 4, yy, 4, Math.PI, Math.PI * 1.5); ctx.closePath(); ctx.fill();
                ctx.strokeStyle = ARROWS.buoyancy.color; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(x0 + pad + 14, yy, 3.5, 0, Math.PI * 2); ctx.stroke();
            } else {
                ctx.strokeStyle = it[0]; ctx.lineWidth = 3;
                ctx.beginPath(); ctx.moveTo(x0 + pad, yy); ctx.lineTo(x0 + pad + sw, yy); ctx.stroke();
            }
            ctx.fillStyle = pal.text;
            ctx.fillText(it[1], x0 + pad * 2 + sw, yy + 0.5);
        });
    }

    function drawGrabLine() {
        const c = Math.cos(st.th), s = Math.sin(st.th);
        const ax = st.x + c * grab.bx - s * grab.by, ay = st.y + s * grab.bx + c * grab.by;
        ctx.strokeStyle = pal.text;
        ctx.globalAlpha = 0.7;
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(wx(ax), wy(ay)); ctx.lineTo(wx(grab.tx), wy(grab.ty)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ff7ac6';
        ctx.beginPath(); ctx.arc(wx(ax), wy(ay), 4, 0, Math.PI * 2); ctx.fill();
    }

    function drawLiquidLabel(liq) {
        const fs = clamp(cssW / 60, 9, 13);
        ctx.font = fs + 'px "Source Sans Pro", Helvetica, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        const txt = liq.name + ' · ' + liq.rho.toLocaleString('en-US') + ' kg/m³';
        const x = cssW - 8;
        const y = wy(surfaceAt(TANK_W - 0.1)) - 5;
        ctx.lineWidth = 3;
        ctx.strokeStyle = pal.halo;
        ctx.strokeText(txt, x, y);
        ctx.fillStyle = pal.text;
        ctx.fillText(txt, x, y);
    }

    function drawScaleBar() {
        const len = 0.1 * scale;
        const x = 10, y = cssH - 10;
        const fs = clamp(cssW / 70, 8, 12);
        ctx.font = fs + 'px "Source Sans Pro", Helvetica, sans-serif';
        for (let pass = 0; pass < 2; pass++) {
            ctx.strokeStyle = pass === 0 ? pal.halo : pal.text;
            ctx.lineWidth = pass === 0 ? 4 : 1.5;
            ctx.beginPath();
            ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 4);
            ctx.stroke();
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.strokeStyle = pal.halo;
        ctx.strokeText('10 cm', x + len + 5, y + 2);
        ctx.fillStyle = pal.text;
        ctx.fillText('10 cm', x + len + 5, y + 2);
    }

    function drawEmptyHint() {
        const fs = clamp(cssW / 45, 11, 17);
        ctx.font = fs + 'px "Source Sans Pro", Helvetica, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = pal.text;
        ctx.globalAlpha = 0.75;
        ctx.fillText('Pick a material and draw an object, then press Drop', cssW / 2, cssH * 0.25);
        ctx.globalAlpha = 1;
    }

    function drawToolPreview() {
        if (!pointer.inside && !pointer.down) return;
        const tool = settings.tool;
        const size = BRUSH_SIZES[settings.brushIndex];
        if (pointer.down && isShapeTool(tool)) {
            const b = shapeBounds(pointer.startX, pointer.startY, pointer.x, pointer.y, pointer.shift);
            const cellPx = CELL * scale;
            const path = new Path2D();
            forEachShapeCell(tool, b.cA, b.rA, b.cB, b.rB, size, (c, r) => {
                path.rect(c * cellPx, (GH - r - 1) * cellPx, cellPx, cellPx);
            });
            ctx.fillStyle = MATERIALS[settings.material].color;
            ctx.globalAlpha = 0.6;
            ctx.fill(path);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = pal.text;
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = 1;
            ctx.strokeRect(b.cA * cellPx, (GH - b.rB - 1) * cellPx, (b.cB - b.cA + 1) * cellPx, (b.rB - b.rA + 1) * cellPx);
            ctx.setLineDash([]);
            const wcm = b.cB - b.cA + 1, hcm = b.rB - b.rA + 1;
            ctx.font = '12px "Source Sans Pro", Helvetica, sans-serif';
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
            ctx.fillStyle = pal.text;
            ctx.fillText(wcm + ' × ' + hcm + ' cm', (b.cB + 1) * cellPx + 4, (GH - b.rB - 1) * cellPx);
            return;
        }
        if (pointer.type !== 'mouse' && !pointer.down) return;
        if (tool === 'brush' || tool === 'eraser') {
            const r = Math.max(size / 2, 0.5) * CELL * scale;
            ctx.strokeStyle = tool === 'eraser' ? pal.text : MATERIALS[settings.material].color;
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(wx(pointer.x), wy(pointer.y), r, 0, Math.PI * 2); ctx.stroke();
            ctx.strokeStyle = pal.halo; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(wx(pointer.x), wy(pointer.y), r + 1.5, 0, Math.PI * 2); ctx.stroke();
        }
    }

    // ------------------------------------------------------------------
    // Read-outs
    // ------------------------------------------------------------------
    const el = {};
    let lastStatsT = 0;
    function updateStatsDisplay(force) {
        const now = performance.now();
        if (!force && now - lastStatsT < 200) return;
        lastStatsT = now;
        const P = mode === 'sim' ? body : preview;
        const liq = LIQUIDS[settings.liquid];
        const g = settings.gravity;
        if (!el.mass) return;
        if (!P) {
            el.mass.textContent = '-'; el.volume.textContent = '-'; el.density.textContent = '-';
            el.submerged.textContent = '-'; el.weight.textContent = '-'; el.buoyancy.textContent = '-';
            el.prediction.textContent = 'Draw an object to see whether it will float in ' + liq.name.toLowerCase() + '.';
            return;
        }
        const V = (P.areaMat + P.areaSealed) * DEPTH;
        const M = P.mass;
        const rho = M / V;
        let massTxt = fmtAuto(M) + ' kg';
        if (mode === 'sim' && P.waterHeld > 0.02) massTxt += ' + ' + fmtAuto(P.waterHeld) + ' kg of ' + LIQUIDS[settings.liquid].name.toLowerCase() + ' inside';
        el.mass.textContent = massTxt;
        el.volume.textContent = fmtAuto(V * 1000) + ' L';
        el.density.textContent = fmt(rho, 0) + ' kg/m³';
        el.weight.textContent = fmtAuto((M + (mode === 'sim' ? P.waterMass : 0)) * g) + ' N';
        if (mode === 'sim') {
            el.submerged.textContent = fmt(100 * clamp(disp.sub, 0, 1), 0) + '%';
            el.buoyancy.textContent = fmtAuto(Math.hypot(disp.fbX, disp.fbY)) + ' N';
        } else {
            el.submerged.textContent = '-';
            el.buoyancy.textContent = '-';
        }
        el.prediction.textContent = predictionText(P, liq, rho, V, M, g);
    }

    function predictionText(P, liq, rho, V, M, g) {
        const rl = liq.rho;
        const ln = liq.name.toLowerCase();
        const r0 = fmt(rho, 0), rL = rl.toLocaleString('en-US');
        if (rho < rl) {
            return 'Average density ' + r0 + ' kg/m³ < ' + rL + ' kg/m³ (' + ln + ') → floats with about ' +
                fmt(100 * rho / rl, 0) + '% of its volume submerged.';
        }
        const Vh = V + P.areaBasin * DEPTH;
        if (P.areaBasin > 0 && M / Vh < rl) {
            const rh = M / Vh;
            return 'Solid parts average ' + r0 + ' kg/m³ > ' + rL + ' kg/m³, but counting the air in its open hull it averages ' +
                fmt(rh, 0) + ' kg/m³ → floats like a boat (about ' + fmt(100 * rh / rl, 0) + '% of the hull submerged) unless ' + ln + ' gets in.';
        }
        const net = (M - rl * V) * g;
        let txt = 'Average density ' + r0 + ' kg/m³ > ' + rL + ' kg/m³ (' + ln + ') → sinks. Fully submerged it still feels a buoyant force of ' +
            fmtAuto(rl * V * g) + ' N, so its apparent weight is ' + fmtAuto(net) + ' N';
        if (P.areaOpen - P.areaBasin > 0.15 * (P.areaMat + P.areaSealed)) txt += ' (unless it traps air underneath, like an upside-down cup)';
        return txt + '.';
    }

    function setHint(text) {
        if (el.hint) el.hint.textContent = text;
        hintHold = performance.now() + 3500;
    }
    let hintHold = 0;
    function refreshHint() {
        if (!el.hint || performance.now() < hintHold) return;
        let t;
        if (mode === 'sim') {
            t = 'Drag the object to lift or throw it · tap the liquid to make waves · Edit to change the drawing';
        } else {
            const m = MATERIALS[settings.material];
            const tips = {
                brush: 'drag to paint (right-click erases)',
                eraser: 'drag to erase',
                rect: 'drag to draw a solid rectangle (Shift: square)',
                box: 'drag for a hollow box; wall = brush size (Shift: square)',
                ellipse: 'drag to draw a solid ellipse (Shift: circle)',
                ring: 'drag for a hollow ring; wall = brush size (Shift: circle)',
                fill: 'click inside a closed outline to fill it'
            };
            t = (settings.tool === 'eraser' ? 'Eraser' : m.name + ' · ' + m.rho.toLocaleString('en-US') + ' kg/m³') + ' — ' + tips[settings.tool];
        }
        if (el.hint.textContent !== t) el.hint.textContent = t;
    }

    // ------------------------------------------------------------------
    // Pointer input
    // ------------------------------------------------------------------
    function isShapeTool(t) { return t === 'rect' || t === 'box' || t === 'ellipse' || t === 'ring'; }
    function eventToWorld(e) {
        const r = canvas.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width * TANK_W;
        const y = TANK_H - (e.clientY - r.top) / r.height * TANK_H;
        return [clamp(x, 0, TANK_W), clamp(y, 0, TANK_H)];
    }

    function hitBody(x, y, tol) {
        const B = body;
        if (!B) return null;
        const c = Math.cos(st.th), s = Math.sin(st.th);
        const dx = x - st.x, dy = y - st.y;
        const lx = c * dx + s * dy, ly = -s * dx + c * dy;
        const gx = (lx + B.comLX) / CELL, gy = (ly + B.comLY) / CELL;
        const rad = Math.ceil(tol / CELL);
        let best = null, bestD = Infinity;
        for (let r = Math.floor(gy) - rad; r <= Math.floor(gy) + rad; r++) {
            for (let cc = Math.floor(gx) - rad; cc <= Math.floor(gx) + rad; cc++) {
                if (cc < 0 || r < 0 || cc >= B.LW || r >= B.LH) continue;
                if (B.ltype[r * B.LW + cc] === T_EXT) continue;
                const ddx = cc + 0.5 - gx, ddy = r + 0.5 - gy;
                const d2 = ddx * ddx + ddy * ddy;
                if (d2 < bestD) { bestD = d2; best = [lx, ly]; }
            }
        }
        if (best && Math.sqrt(bestD) * CELL <= tol + CELL) return best;
        return null;
    }

    function onPointerDown(e) {
        if (pointer.down && e.pointerId !== pointer.id) return;
        const [x, y] = eventToWorld(e);
        pointer.type = e.pointerType || 'mouse';
        pointer.inside = true;
        pointer.x = x; pointer.y = y;
        pointer.shift = e.shiftKey;
        if (mode === 'sim') {
            const tol = pointer.type === 'mouse' ? 0.012 : 0.035;
            const hit = hitBody(x, y, tol);
            if (hit) {
                grab.active = true; grab.bx = hit[0]; grab.by = hit[1]; grab.tx = x; grab.ty = y;
                pointer.down = true; pointer.id = e.pointerId;
                try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                canvas.style.cursor = 'grabbing';
            } else if (y < surfaceAt(x)) {
                pokeLiquid(x, 0.006);
            }
            e.preventDefault();
            return;
        }
        // draw mode
        pointer.down = true; pointer.id = e.pointerId;
        pointer.button = e.button;
        pointer.startX = x; pointer.startY = y; pointer.lastX = x; pointer.lastY = y;
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        const tool = settings.tool;
        const size = BRUSH_SIZES[settings.brushIndex];
        if (tool === 'fill') {
            floodFill(Math.floor(x / CELL), Math.floor(y / CELL), e.button === 2 ? 0 : settings.material);
            pointer.down = false;
        } else if (tool === 'brush' || tool === 'eraser') {
            pushUndo();
            const v = (tool === 'eraser' || e.button === 2) ? 0 : settings.material;
            paintDisc(x, y, size, v);
            drawDirty = true;
        }
        e.preventDefault();
    }

    function onPointerMove(e) {
        const [x, y] = eventToWorld(e);
        pointer.type = e.pointerType || 'mouse';
        pointer.inside = true;
        pointer.shift = e.shiftKey;
        if (pointer.down && e.pointerId !== pointer.id) return;
        pointer.x = x; pointer.y = y;
        if (mode === 'sim') {
            if (grab.active) { grab.tx = x; grab.ty = y; }
            else if (pointer.type === 'mouse') canvas.style.cursor = hitBody(x, y, 0.012) ? 'grab' : 'default';
            return;
        }
        canvas.style.cursor = 'crosshair';
        if (!pointer.down) return;
        const tool = settings.tool;
        if (tool === 'brush' || tool === 'eraser') {
            const v = (tool === 'eraser' || pointer.button === 2) ? 0 : settings.material;
            paintLine(pointer.lastX, pointer.lastY, x, y, BRUSH_SIZES[settings.brushIndex], v);
            pointer.lastX = x; pointer.lastY = y;
            drawDirty = true;
        }
    }

    function onPointerUp(e) {
        if (!pointer.down || e.pointerId !== pointer.id) {
            if (e.type === 'pointerleave' && !pointer.down) pointer.inside = false;
            return;
        }
        if (e.type === 'pointerleave') return;  // captured: wait for up/cancel
        const [x, y] = eventToWorld(e);
        pointer.down = false;
        pointer.id = -1;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (mode === 'sim') {
            grab.active = false;
            canvas.style.cursor = 'default';
            if (pointer.type !== 'mouse') pointer.inside = false;
            return;
        }
        const tool = settings.tool;
        if (isShapeTool(tool) && e.type === 'pointerup') {
            pushUndo();
            const b = shapeBounds(pointer.startX, pointer.startY, x, y, e.shiftKey);
            const v = pointer.button === 2 ? 0 : settings.material;
            forEachShapeCell(tool, b.cA, b.rA, b.cB, b.rB, BRUSH_SIZES[settings.brushIndex], (c, r) => setCell(c, r, v));
            drawDirty = true;
        }
        if (pointer.type !== 'mouse') pointer.inside = false;
    }

    // ------------------------------------------------------------------
    // UI wiring
    // ------------------------------------------------------------------
    function updateModeUI() {
        const tb = document.getElementById('buoyToolbar');
        if (tb) tb.classList.toggle('is-sim', mode === 'sim');
        const dropBtn = document.getElementById('dropBtn');
        const editBtn = document.getElementById('editBtn');
        if (dropBtn) dropBtn.hidden = mode === 'sim';
        if (editBtn) editBtn.hidden = mode !== 'sim';
        const redrop = document.getElementById('redropBtn');
        if (redrop) redrop.hidden = mode !== 'sim';
        canvas.style.cursor = mode === 'sim' ? 'default' : 'crosshair';
        hintHold = 0;
        refreshHint();
    }

    function syncToolButtons() {
        document.querySelectorAll('.buoy-mat').forEach((b) => {
            const on = +b.dataset.mat === settings.material && settings.tool !== 'eraser';
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        document.querySelectorAll('.buoy-tool').forEach((b) => {
            const on = b.dataset.tool === settings.tool;
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        hintHold = 0;
        refreshHint();
    }

    function setLiquid(key) {
        if (!LIQUIDS[key]) return;
        settings.liquid = key;
        st.maValid = false;
        const sel = document.getElementById('liquidSelector');
        if (sel && sel.value !== key) sel.value = key;
        gradientKey = '';
        if (body) { updateWaterMass(body); body.cavKey = ''; }
        updateWaveCoefficients();
        if (mode === 'draw') level = drawModeLevel(preview);
        updateStatsDisplay(true);
    }

    function setupUI() {
        el.mass = document.getElementById('statMass');
        el.volume = document.getElementById('statVolume');
        el.density = document.getElementById('statDensity');
        el.submerged = document.getElementById('statSubmerged');
        el.weight = document.getElementById('statWeight');
        el.buoyancy = document.getElementById('statBuoyancy');
        el.prediction = document.getElementById('predictionText');
        el.hint = document.getElementById('toolHint');
        el.fps = document.getElementById('fpsDisplay');

        // material palette
        const palEl = document.getElementById('materialPalette');
        if (palEl) {
            palEl.innerHTML = '';
            for (let i = 1; i < MATERIALS.length; i++) {
                const m = MATERIALS[i];
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'buoy-mat';
                b.dataset.mat = String(i);
                b.setAttribute('role', 'radio');
                b.title = m.name + ' – ' + m.rho.toLocaleString('en-US') + ' kg/m³';
                b.setAttribute('aria-label', b.title);
                b.innerHTML = '<span class="buoy-swatch" style="background:' + m.color + '"></span><span class="buoy-mat-name">' +
                    m.name + '</span><span class="buoy-mat-rho">' + m.rho.toLocaleString('en-US') + '</span>';
                b.addEventListener('click', () => {
                    settings.material = i;
                    if (settings.tool === 'eraser') settings.tool = 'brush';
                    if (mode === 'sim') enterEditMode();
                    syncToolButtons();
                });
                palEl.appendChild(b);
            }
        }
        document.querySelectorAll('.buoy-tool').forEach((b) => {
            b.addEventListener('click', () => {
                settings.tool = b.dataset.tool;
                if (mode === 'sim') enterEditMode();
                syncToolButtons();
            });
        });
        const sizeEl = document.getElementById('brushSize'), sizeVal = document.getElementById('brushSizeVal');
        if (sizeEl) {
            const upd = () => {
                settings.brushIndex = clamp(parseInt(sizeEl.value, 10) || 0, 0, BRUSH_SIZES.length - 1);
                if (sizeVal) sizeVal.textContent = BRUSH_SIZES[settings.brushIndex] + ' cm';
            };
            sizeEl.addEventListener('input', upd);
            sizeEl.value = String(settings.brushIndex);
            upd();
        }
        const on = (id, fn) => { const n = document.getElementById(id); if (n) n.addEventListener('click', fn); };
        on('dropBtn', () => dropObject());
        on('editBtn', () => enterEditMode());
        on('redropBtn', () => dropObject());
        on('clearBtn', () => { pushUndo(); grid.fill(0); enterEditMode(); });
        on('undoBtn', () => undo());
        on('resetSimulationBtn', () => {
            if (mode === 'sim') dropObject();
            else { clearWaves(); drawDirty = true; }
        });

        const liqSel = document.getElementById('liquidSelector');
        if (liqSel) {
            liqSel.value = settings.liquid;
            liqSel.addEventListener('change', () => setLiquid(liqSel.value));
        }
        const presetSel = document.getElementById('presetSelector');
        if (presetSel) {
            for (const p of PRESETS) {
                const o = document.createElement('option');
                o.value = p.key; o.textContent = p.label;
                presetSel.appendChild(o);
            }
            presetSel.addEventListener('change', () => {
                if (presetSel.value) loadPreset(presetSel.value);
                presetSel.value = '';
            });
        }
        const bindCheck = (id, get, set) => {
            const n = document.getElementById(id);
            if (!n) return;
            n.checked = get();
            n.addEventListener('change', () => set(n.checked));
        };
        bindCheck('rotationToggle', () => settings.rotation, (v) => { settings.rotation = v; if (!v) st.om = 0; });
        Object.keys(settings.arrows).forEach((k) => {
            bindCheck('arrow_' + k, () => settings.arrows[k], (v) => { settings.arrows[k] = v; });
        });
        bindCheck('showMarkers', () => settings.markers, (v) => { settings.markers = v; });

        const bindRange = (id, valId, get, set, fmtFn) => {
            const n = document.getElementById(id), v = document.getElementById(valId);
            if (!n) return;
            n.value = String(get());
            const upd = () => { set(parseFloat(n.value)); if (v) v.textContent = fmtFn(get()); };
            n.addEventListener('input', upd);
            if (v) v.textContent = fmtFn(get());
        };
        bindRange('speedSlider', 'speedVal', () => settings.speed, (x) => { settings.speed = x; }, (x) => x.toFixed(2));
        bindRange('gravitySlider', 'gravityVal', () => settings.gravity, (x) => {
            settings.gravity = x;
            updateWaveCoefficients();
            updateStatsDisplay(true);
        }, (x) => {
            const named = [[1.62, 'Moon'], [3.71, 'Mars'], [9.81, 'Earth'], [24.79, 'Jupiter']];
            for (const [gv, nm] of named) if (Math.abs(x - gv) < 0.06) return x.toFixed(2) + ' (' + nm + ')';
            return x.toFixed(2);
        });
        bindRange('depthSlider', 'depthVal', () => Math.round(settings.liquidDepth * 100), (x) => {
            settings.liquidDepth = x / 100;
            if (mode === 'draw') level = drawModeLevel(preview);
            updateWaveCoefficients();
        }, (x) => String(Math.round(x)));

        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointercancel', onPointerUp);
        canvas.addEventListener('pointerleave', (e) => {
            if (!pointer.down) pointer.inside = false;
            onPointerUp(e);
        });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        document.addEventListener('keydown', (e) => {
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { undo(); e.preventDefault(); }
            if (e.key === 'Shift') pointer.shift = true;
        });
        document.addEventListener('keyup', (e) => { if (e.key === 'Shift') pointer.shift = false; });

        new MutationObserver(() => refreshPalette()).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('resize', () => handleResize());
        syncToolButtons();
        updateModeUI();
    }

    // ------------------------------------------------------------------
    // Main loop
    // ------------------------------------------------------------------
    let lastTs = 0;
    let loopRunning = false;
    let physAcc = 0;

    function frame(ts) {
        requestAnimationFrame(frame);
        const t0 = performance.now();
        handleResize();
        if (cssW < 2 || cssH < 2) return;
        let dtReal = lastTs ? (ts - lastTs) / 1000 : 0;
        lastTs = ts;
        if (!(dtReal > 0)) dtReal = 0;
        if (dtReal > 0.1) dtReal = 0.1;

        let steps = 0;
        if (mode === 'sim' && body) {
            physAcc += dtReal * settings.speed;
            updateWaveCoefficients();
            while (physAcc >= DT && steps < MAX_SUBSTEPS) {
                substep(DT);
                physAcc -= DT;
                steps++;
            }
            if (steps >= MAX_SUBSTEPS) physAcc = 0;
            if (steps > 0) {
                stepCavities(steps * DT);
                stepParticles(steps * DT);
            }
            // frame averages -> smoothed display values
            if (acc.n > 0) {
                const inv = 1 / acc.n;
                const a = 1 - Math.exp(-dtReal / 0.12);
                disp.fbX += (acc.fbX * inv - disp.fbX) * a;
                disp.fbY += (acc.fbY * inv - disp.fbY) * a;
                disp.fdX += (acc.fdX * inv - disp.fdX) * a;
                disp.fdY += (acc.fdY * inv - disp.fdY) * a;
                disp.fcX += (acc.fcX * inv - disp.fcX) * a;
                disp.fcY += (acc.fcY * inv - disp.fcY) * a;
                disp.netX += (acc.netX * inv - disp.netX) * a;
                disp.netY += (acc.netY * inv - disp.netY) * a;
                disp.hasContact += ((acc.cw > 0 ? 1 : 0) - disp.hasContact) * a;
                if (acc.cw > 0) { disp.cpx = acc.cpx / acc.cw; disp.cpy = acc.cpy / acc.cw; }
                disp.sub = body.areaEnv > 0 ? phys.subEnv / body.areaEnv : 0;
                resetAccumulators();
            }
        } else {
            physAcc = 0;
            if (nParticles) stepParticles(dtReal);
        }
        const t1 = performance.now();
        render();
        const t2 = performance.now();
        updateStatsDisplay(false);
        refreshHint();

        // perf (exponential averages)
        const k = 0.05;
        perf.physMs += ((t1 - t0) - perf.physMs) * k;
        perf.renderMs += ((t2 - t1) - perf.renderMs) * k;
        perf.frameMs += ((t2 - t0) - perf.frameMs) * k;
        perf.substeps += (steps - perf.substeps) * k;
        perf.frames++;
        perf.fpsFrames++;
        if (ts - perf.lastFpsT >= 500) {
            perf.fps = perf.fpsFrames * 1000 / Math.max(1, ts - perf.lastFpsT);
            perf.fpsFrames = 0;
            perf.lastFpsT = ts;
            if (el.fps && el.fps.style.display === 'block') {
                el.fps.textContent = 'FPS: ' + perf.fps.toFixed(0) + ' · JS ' + perf.frameMs.toFixed(1) + ' ms';
            }
        }
    }

    function start() {
        if (loopRunning) return;
        loopRunning = true;
        refreshPalette();
        setupUI();
        handleResize();
        loadPreset('boat');
        undoStack.length = 0;
        requestAnimationFrame(frame);
    }

    // ------------------------------------------------------------------
    // Public / debug API
    // ------------------------------------------------------------------
    window.buoyancySimulation = {
        reset() { if (mode === 'sim') dropObject(); else clearWaves(); },
        drop: dropObject,
        edit: enterEditMode,
        clear() { pushUndo(); grid.fill(0); enterEditMode(); },
        undo,
        loadPreset,
        presets: () => PRESETS.map((p) => p.key),
        setLiquid,
        setRotation(v) {
            settings.rotation = !!v; if (!v) st.om = 0;
            const n = document.getElementById('rotationToggle'); if (n) n.checked = !!v;
        },
        setGravity(v) { settings.gravity = v; updateWaveCoefficients(); },
        setSpeed(v) { settings.speed = v; },
        setLiquidDepth(m) { settings.liquidDepth = m; if (mode === 'draw') level = drawModeLevel(preview); },
        setArrows(o) { Object.assign(settings.arrows, o); },
        fillRect(c, r, w, h, matKey) { fillRect(c, r, w, h, matKey ? (MAT_ID[matKey] || 0) : 0); drawDirty = true; if (mode === 'sim') enterEditMode(); },
        clearGrid() { grid.fill(0); drawDirty = true; if (mode === 'sim') enterEditMode(); },
        advance(seconds) { return simulate(seconds); },
        setPose(x, y, theta, vx, vy, omega) {
            if (x !== undefined && x !== null) st.x = x;
            if (y !== undefined && y !== null) st.y = y;
            if (theta !== undefined && theta !== null) st.th = theta;
            st.vx = vx || 0; st.vy = vy || 0; st.om = omega || 0;
        },
        cavityInfo() {
            if (!body || !body.nOpen) return null;
            let v = 0, r = 0, d = 0, wsum = 0;
            for (let q = 0; q < body.openCells.length; q++) {
                const li = body.cellLocal[body.openCells[q]];
                v += body.fV[li]; r += body.fR[li]; d += body.fD[li]; wsum += body.water[body.openCells[q]];
            }
            return { open: body.nOpen, vented: v, wetConnected: r, drainable: d, waterCells: wsum };
        },
        getState() {
            const B = mode === 'sim' ? body : preview;
            const liq = LIQUIDS[settings.liquid];
            const out = {
                mode, liquid: settings.liquid, rotation: settings.rotation, level, simTime,
                x: st.x, y: st.y, theta: st.th, vx: st.vx, vy: st.vy, omega: st.om
            };
            if (B) {
                const V = (B.areaMat + B.areaSealed) * DEPTH;
                out.mass = B.mass; out.volume = V; out.density = B.mass / V;
                out.cells = B.n; out.faces = B.nf; out.hullPoints = B.nh; out.openCells = B.nOpen;
                out.areaSealed = B.areaSealed; out.areaBasin = B.areaBasin;
                out.prediction = predictionText(B, liq, B.mass / V, V, B.mass, settings.gravity);
            }
            if (mode === 'sim' && body) {
                out.submergedFraction = body.areaEnv > 0 ? phys.subEnv / body.areaEnv : 0;
                out.submergedVolume = phys.subA * DEPTH;
                out.buoyancy = phys.fbY; out.weight = phys.weight;
                out.waterInside = body.waterMass;
                out.waterHeld = body.waterHeld;
                out.contactForce = [phys.fcX, phys.fcY];
                out.dragForce = [phys.fdX, phys.fdY];
                out.cob = [phys.cobX, phys.cobY];
            }
            return out;
        },
        getPerf() {
            return { fps: perf.fps, frameMs: perf.frameMs, physMs: perf.physMs, renderMs: perf.renderMs, substepsPerFrame: perf.substeps, frames: perf.frames };
        },
        _internals: { settings, MATERIALS, LIQUIDS, grid, GW, GH, CELL }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
