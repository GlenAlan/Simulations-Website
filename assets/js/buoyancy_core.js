/*
 * Buoyancy Simulation - simulations.science
 *
 * The user draws the cross-section of an object on a 1 cm grid using several
 * materials, then drops it into a 2.4 m x 1.5 m tank of liquid. The drawing is a
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
 *    or cup). Each cavity holds a volume of liquid with a level, world-horizontal
 *    free surface (solved every sub-step for the current pose), so its mass and
 *    moving centre of mass feed straight into the rigid-body dynamics. Liquid
 *    runs in and out through the cavity's openings (runs of its boundary that
 *    meet the outside) at a rate set by the head difference: orifice flow
 *    ~ Cd sqrt(2 g dh), but through an opening that faces up no more than
 *    sharp-crested weir flow (2/3) Cd sqrt(2 g) H^1.5 over each of its lips. It
 *    flows only while air can get out (or in): an upside-down cup keeps its
 *    trapped air until it tips and the air bubbles out. Volume is conserved: what
 *    the object holds is missing from the tank.
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
    const TANK_W = 2.4;
    const TANK_H = 1.5;
    const DEPTH = 0.10;
    const CELL = 0.01;
    const GW = Math.round(TANK_W / CELL);
    const GH = Math.round(TANK_H / CELL);
    const CELL_A = CELL * CELL;
    const DT = 1 / 240;
    const MAX_SUBSTEPS = 48;
    const RHO_AIR = 1.2;
    const MU_AIR = 1.8e-5;
    const NCOL = 120;
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
    const CD_OPEN = 0.6;          // discharge coefficient of cavity openings
    const BUBBLE_K = 0.35;        // trapped air escaping through a submerged opening (relative to orifice flow)
    const GLUG_K = 0.5;           // liquid leaving a cavity that air can only enter through the same opening
    const AIR_EPS = 0.1 * CELL;   // air must reach this far past an opening's top edge to get through
    const WATER_SPIN = 0.5;       // share of the held liquid's own moment of inertia that turns with the hull
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
        liquidDepth: 0.6,
        arrows: { weight: true, buoyancy: true, drag: false, contact: false, net: false },
        markers: false,
        material: MAT_ID.pine,
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
    // An object pushes the liquid aside over a few centimetres, not in 2 cm columns: what it adds to
    // each wave mode is spread like that (a Gaussian 2 cm wide). Otherwise the column steps feed the
    // shortest waves the grid can hold, and the surface goes jagged.
    const srcFilter = new Float64Array(NMODE + 1);
    for (let k = 0; k <= NMODE; k++) { const u = k * Math.PI * 0.02 / TANK_W; srcFilter[k] = Math.exp(-0.5 * u * u); }
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
    let clipA = 0, clipCX = 0, clipCY = 0;                  // result of clipCell()
    let gExt = 0, gRampA = 0, gWMax = 0, gE2 = 0;           // a rotated cell against a level line
    let cavW = 0;                                           // d(area)/d(level) from cavArea()
    let prevVX = 0, prevVY = 0, accX = 0, accY = 0;         // smoothed body acceleration (slosh)
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
    const liquidColumn = document.createElement('canvas');   // the tank's liquid, as one opaque column
    let liquidPattern = null;
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
    // The liquid's surface: the level plus the waves, as a Catmull-Rom curve through the column
    // samples (mirrored at the walls, which the waves meet level). The same curve is drawn, cuts the
    // object's cells for buoyancy and drag, and is used everywhere else; surfSlope is its slope there.
    let surfSlope = 0;
    function surfaceAt(x) {
        const fc = x / DXC - 0.5;
        let j = Math.floor(fc);
        if (j < -1) j = -1; else if (j > NCOL - 1) j = NCOL - 1;
        let t = fc - j;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const i0 = j - 1, i2 = j + 1, i3 = j + 2;
        const p0 = eta[i0 < 0 ? -1 - i0 : i0];
        const p1 = eta[j < 0 ? -1 - j : (j >= NCOL ? 2 * NCOL - 1 - j : j)];
        const p2 = eta[i2 >= NCOL ? 2 * NCOL - 1 - i2 : i2];
        const p3 = eta[i3 >= NCOL ? 2 * NCOL - 1 - i3 : i3];
        const a = p2 - p0, b = 2 * p0 - 5 * p1 + 4 * p2 - p3, cc = 3 * (p1 - p2) + p3 - p0;
        surfSlope = 0.5 * (a + t * (2 * b + 3 * cc * t)) / DXC;
        return level + p1 + 0.5 * t * (a + t * (b + t * cc));
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

        // 3b. The stair-steps of a curved or slanted outline leave notches a cell or two deep inside
        // the hull. They are part of the outside, not pockets that hold liquid: a group of open cells
        // that all touch the outside, or only a handful of cells, goes back to the outside.
        if (nOpen > 0) {
            const seen = new Uint8Array(NL);
            for (let li0 = 0; li0 < NL; li0++) {
                if (ltype[li0] !== T_OPEN || seen[li0]) continue;
                qh = 0; qt = 0;
                queue[qt++] = li0; seen[li0] = 1;
                let inner = false;
                while (qh < qt) {
                    const li = queue[qh++];
                    let edge = false;
                    for (let q = 0; q < 4; q++) {
                        const nb = q === 0 ? li - 1 : q === 1 ? li + 1 : q === 2 ? li - LW : li + LW;
                        if (ltype[nb] === T_EXT) edge = true;
                        else if (ltype[nb] === T_OPEN && !seen[nb]) { seen[nb] = 1; queue[qt++] = nb; }
                    }
                    if (!edge) inner = true;
                }
                if (!inner || qt <= 4) {
                    for (let k = 0; k < qt; k++) ltype[queue[k]] = T_EXT;
                    nOpen -= qt;
                }
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

        // 8. open cavities: 4-connected groups of open cells, with their outlines and openings
        const cavs = [];
        const cavIdx = new Int16Array(NL).fill(-1);
        for (let li0 = 0; li0 < NL; li0++) {
            if (ltype[li0] !== T_OPEN || cavIdx[li0] >= 0) continue;
            const id = cavs.length;
            qh = 0; qt = 0;
            queue[qt++] = li0; cavIdx[li0] = id;
            while (qh < qt) {
                const li = queue[qh++];
                for (let q = 0; q < 4; q++) {
                    const nb = li + dirs[q][0] + dirs[q][1] * LW;
                    if (ltype[nb] === T_OPEN && cavIdx[nb] < 0) { cavIdx[nb] = id; queue[qt++] = nb; }
                }
            }
            const local = queue.slice(0, qt);
            const cells = new Int32Array(qt);
            for (let k = 0; k < qt; k++) cells[k] = lcell[local[k]];
            cavs.push(makeCavity(cells, traceCavity(local, id, cavIdx, ltype, LW, comLX, comLY)));
        }

        return {
            n, ox, oy, cmass, kind, env, cellLocal, lcell, ltype, lmat, LW, LH, gc0, gr0, NL, cavIdx,
            comLX, comLY, mass: M, massMat, inertia: I, areaMx, areaMy,
            areaTot: n * CELL_A, areaMat, areaSealed, areaOpen, areaBasin,
            areaEnv: areaMat + areaSealed + areaBasin, matCount,
            nf, fox, foy, fnx, fny, nh, hullX, hullY,
            charLen: Math.max(0.02, Math.sqrt(areaMat + areaSealed + areaBasin)),
            nOpen: areaOpen > 0 ? Math.round(areaOpen / CELL_A) : 0,
            cavs,
            worldX: gc0 * CELL + comLX, worldY: gr0 * CELL + comLY,
            // liquid held in the cavities (body frame, about the dry centre of mass)
            waterMass: 0, waterMx: 0, waterMy: 0, waterInertia: 0, waterArea: 0,
            img: null, imgKey: ''
        };
    }

    // Boundary of a cavity, as directed cell sides with the cavity on their left (so the loops run
    // anticlockwise round it, y up) joined into closed loops. A run of sides facing the outside is an
    // opening; where it ends the boundary turns into the object's material: a lip.
    const DIRX = [1, 0, -1, 0], DIRY = [0, 1, 0, -1];   // right, up, left, down; outward normal (DIRY, -DIRX)
    function traceCavity(local, id, cavIdx, ltype, LW, comLX, comLY) {
        const VW = LW + 1;
        const eS = [], eD = [], eO = [], eL = [];      // start vertex, direction, opens to the outside, cell
        const outs = new Map();
        for (const li of local) {
            const lc = li % LW, lr = (li - lc) / LW;
            const sides = [[li - LW, lc, lr, 0], [li + 1, lc + 1, lr, 1], [li + LW, lc + 1, lr + 1, 2], [li - 1, lc, lr + 1, 3]];
            for (const [nb, vx, vy, d] of sides) {
                if (cavIdx[nb] === id) continue;
                const k = vy * VW + vx, e = eS.length;
                eS.push(k); eD.push(d); eO.push(ltype[nb] === T_EXT ? 1 : 0); eL.push(li);
                const o = outs.get(k);
                if (o) o.push(e); else outs.set(k, [e]);
            }
        }
        const nE = eS.length, used = new Uint8Array(nE);
        const loops = [], chains = [], faces = [];
        const vxOf = (k) => (k % VW) * CELL - comLX, vyOf = (k) => ((k / VW) | 0) * CELL - comLY;
        const endKey = (e) => eS[e] + DIRX[eD[e]] + DIRY[eD[e]] * VW;
        for (let e0 = 0; e0 < nE; e0++) {
            if (used[e0]) continue;
            const loop = [];
            let e = e0;
            while (e >= 0 && !used[e]) {
                used[e] = 1; loop.push(e);
                const d = eD[e], cand = outs.get(endKey(e));
                // turn left first: where two cells touch only at a corner the loops stay apart
                let next = -1;
                for (const t of [1, 0, 3]) {
                    for (const c of cand) if (eD[c] === ((d + t) & 3)) { next = c; break; }
                    if (next >= 0) break;
                }
                e = next;
            }
            const m = loop.length;
            let s0 = 0;
            while (s0 < m && eO[loop[s0]]) s0++;
            const allOpen = s0 === m;
            if (allOpen) s0 = 0;
            const at = (i) => loop[(s0 + i) % m];
            // The outline as drawn: a vertex wherever a wall side changes direction, and each opening
            // as its outer envelope (below); per vertex the outward normal of the side leaving it and
            // whether that side is open
            const ox = [], oy = [], onx = [], ony = [], oo = [];
            // openings: runs of sides facing the outside, as faces (midpoint, outward normal) and a polyline
            let i = 0;
            while (i < m) {
                if (!eO[at(i)]) {
                    const e0 = at(i), d = eD[e0];
                    ox.push(vxOf(eS[e0])); oy.push(vyOf(eS[e0])); onx.push(DIRY[d]); ony.push(-DIRX[d]); oo.push(0);
                    i++;
                    while (i < m && !eO[at(i)] && eD[at(i)] === d) i++;
                    continue;
                }
                const f0 = faces.length / 4;
                const cx = [vxOf(eS[at(i)])], cy = [vyOf(eS[at(i)])];
                let dPrev = -1, nsx = 0, nsy = 0;
                while (i < m && eO[at(i)]) {
                    const e1 = at(i), d = eD[e1];
                    const lc = eL[e1] % LW, lr = (eL[e1] - lc) / LW;
                    const nx = DIRY[d], ny = -DIRX[d];
                    faces.push((lc + 0.5 + 0.5 * nx) * CELL - comLX, (lr + 0.5 + 0.5 * ny) * CELL - comLY, nx, ny);
                    nsx += nx; nsy += ny;
                    const k = endKey(e1);
                    if (d === dPrev) { cx[cx.length - 1] = vxOf(k); cy[cy.length - 1] = vyOf(k); }
                    else { cx.push(vxOf(k)); cy.push(vyOf(k)); }
                    dPrev = d;
                    i++;
                }
                const nf = faces.length / 4 - f0;
                // A stair-stepped opening follows a slanted edge of the hull: drawn, it is that straight
                // edge, the outer envelope of its corners (with the cavity on the left, a polyline that
                // only turns right). The ends, its lips, stay where they are.
                const ex = [cx[0]], ey = [cy[0]];
                for (let k = 1; k < cx.length && !allOpen; k++) {
                    while (ex.length >= 2) {
                        const n = ex.length, ax = ex[n - 2], ay = ey[n - 2], bx = ex[n - 1], by = ey[n - 1];
                        if ((bx - ax) * (cy[k] - by) - (by - ay) * (cx[k] - bx) >= -1e-12) { ex.pop(); ey.pop(); } else break;
                    }
                    ex.push(cx[k]); ey.push(cy[k]);
                }
                const env = allOpen ? [cx, cy] : [ex, ey];
                for (let k = 0; k < env[0].length - 1; k++) {
                    const dx = env[0][k + 1] - env[0][k], dy = env[1][k + 1] - env[1][k], l = Math.hypot(dx, dy) || 1;
                    ox.push(env[0][k]); oy.push(env[1][k]); onx.push(dy / l); ony.push(-dx / l); oo.push(1);
                }
                chains.push({
                    f0, nf, px: Float64Array.from(cx), py: Float64Array.from(cy), lips: !allOpen,
                    ex: Float64Array.from(env[0]), ey: Float64Array.from(env[1]),   // as drawn
                    nbx: nsx / nf, nby: nsy / nf,           // mean outward normal (body frame)
                    qI: 0, qO: 0, lipMode: false, wA: 0.5,  // this step: flows, over the lips?, lip A's share
                    tin: null, tout: null,                  // where it flows through (flow-weighted)
                    // smoothed for drawing: signed flows over lip A / lip B / as a jet (+ in, - out), jet geometry
                    sA: 0, sB: 0, sJ: 0, jx: 0, jy: 0, jnx: 0, jny: 0, jv: 0
                });
            }
            loops.push({ x: Float64Array.from(ox), y: Float64Array.from(oy), nx: Float64Array.from(onx), ny: Float64Array.from(ony), o: Uint8Array.from(oo) });
        }
        for (const ch of chains) { ch.tin = new Float64Array(5); ch.tout = new Float64Array(5); }
        return { loops, chains, faces: Float64Array.from(faces) };
    }

    function makeCavity(cells, shape) {
        const nc = cells.length;
        return {
            cells, nc, area: nc * CELL_A, faces: shape.faces, nf: shape.faces.length / 4,
            loops: shape.loops, chains: shape.chains,
            Y: new Float64Array(nc),      // world height of each cell centre (current pose)
            ymin: 0, ymax: 0, xmin: 0, xmax: 0, iLow: 0, cx: 0,
            V: 0,                         // liquid held (m^2 of cross-section)
            h: 0, Ws: 0, xs: 0,           // level, surface width, surface centre (world x)
            m: 0, mx: 0, my: 0, I: 0,     // mass properties of the held liquid
            qIn: 0, qOut: 0, vented: true,
            sL: 0, sR: 0, fx0: 0, fspan: 1,  // outside level just beyond the openings' ends
            // trapped air escaping: the liquid flow it lets in, and the stretch of opening it leaves by
            bubQ: 0, bX0: 0, bY0: 0, bX1: 0, bY1: 0, bNX: 0, bNY: 1,
            // visual slosh and ripples of the inside surface
            phi: 0, phiV: 0, rip: 0, ripT: 0
        };
    }

    function resetCavities(B) {
        for (const cv of B.cavs) {
            cv.V = 0; cv.h = -1; cv.m = cv.mx = cv.my = cv.I = 0;
            cv.qIn = cv.qOut = 0; cv.vented = true;
            cv.bubQ = 0; cv.phi = cv.phiV = cv.rip = 0;
            for (const ch of cv.chains) { ch.qI = ch.qO = 0; ch.sA = ch.sB = ch.sJ = 0; ch.lipMode = false; }
        }
        B.waterMass = B.waterMx = B.waterMy = B.waterInertia = B.waterArea = 0;
    }

    // ------------------------------------------------------------------
    // Held liquid: level surface, flow through the openings, mass properties
    // ------------------------------------------------------------------
    // geometry of a cell rotated by the body angle, cut by a horizontal line
    function setCellGeometry(c, s) {
        const ac = Math.abs(c), as = Math.abs(s);
        gExt = 0.5 * CELL * (ac + as);
        gRampA = CELL * Math.min(ac, as);
        gWMax = CELL / Math.max(ac, as);
        gE2 = 2 * gExt;
    }
    // area of a rotated cell below a horizontal line that is tt above the cell's lowest corner
    function rampArea(tt) {
        if (gRampA < 1e-12) return gWMax * tt;
        if (tt < gRampA) return gWMax * tt * tt / (2 * gRampA);
        if (tt <= gE2 - gRampA) return gWMax * (tt - 0.5 * gRampA);
        const u = gE2 - tt;
        return CELL_A - gWMax * u * u / (2 * gRampA);
    }
    function rampWidth(tt) {
        if (gRampA < 1e-12) return gWMax;
        if (tt < gRampA) return gWMax * tt / gRampA;
        if (tt <= gE2 - gRampA) return gWMax;
        return gWMax * (gE2 - tt) / gRampA;
    }
    // Clips the current rotated cell (corners in cornX/cornY, relative to its centre) to the
    // region below the line y = d + k x; sets clipA and the centroid offset clipCX/clipCY.
    function clipCell(d, k) {
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
        if (a2 > 1e-14) { clipA = 0.5 * a2; clipCX = sx / (3 * a2); clipCY = sy / (3 * a2); }
        else { clipA = 0; clipCX = 0; clipCY = 0; }
    }
    function setCorners(c, s) {
        const hc = 0.5 * CELL;
        cornX[0] = -hc * c + hc * s; cornY[0] = -hc * s - hc * c;
        cornX[1] = hc * c + hc * s;  cornY[1] = hc * s - hc * c;
        cornX[2] = hc * c - hc * s;  cornY[2] = hc * s + hc * c;
        cornX[3] = -hc * c - hc * s; cornY[3] = -hc * s + hc * c;
    }

    // area of the cavity below the level h (and its derivative, the surface width, in cavW)
    function cavArea(cv, h) {
        const Y = cv.Y, n = cv.nc;
        const top = h + gExt;
        let A = 0, W = 0;
        for (let k = 0; k < n; k++) {
            const tt = top - Y[k];
            if (tt <= 0) continue;
            if (tt >= gE2) { A += CELL_A; continue; }
            A += rampArea(tt); W += rampWidth(tt);
        }
        cavW = W;
        return A;
    }

    // level of the held liquid for its volume (safeguarded Newton; starts from the last level)
    function solveLevel(cv) {
        const lo0 = cv.ymin - gExt, hi0 = cv.ymax + gExt;
        if (cv.V <= 0) { cv.h = lo0; cv.Ws = 0; return; }
        if (cv.V >= cv.area) { cv.h = hi0; cv.Ws = 0; return; }
        let lo = lo0, hi = hi0;
        let h = cv.h > lo && cv.h < hi ? cv.h : lo + (hi - lo) * cv.V / cv.area;
        let W = 0;
        for (let it = 0; it < 40; it++) {
            const f = cavArea(cv, h) - cv.V;
            W = cavW;
            if (f > -1e-10 && f < 1e-10) break;
            if (f > 0) hi = h; else lo = h;
            let hn = W > 1e-9 ? h - f / W : 0.5 * (lo + hi);
            if (!(hn > lo && hn < hi)) hn = 0.5 * (lo + hi);
            h = hn;
            if (hi - lo < 1e-10) break;
        }
        cv.h = h; cv.Ws = W;
    }

    // integral over a face (length CELL, spanning heights z0..z1) of sqrt(hu - max(z, hd)), z < hu
    function faceFlow(z0, z1, hu, hd) {
        if (hu <= z0) return 0;
        const dz = z1 - z0;
        if (dz < 1e-9) return CELL * Math.sqrt(hu - (z0 > hd ? z0 : hd));
        const top = z1 < hu ? z1 : hu;
        const sq = Math.sqrt(hu - hd);
        // antiderivative of sqrt(hu - max(z, hd)) on z <= hu
        const k3 = (2 / 3) * sq * sq * sq;
        const u0 = hu - z0, u1 = hu - top;
        const G0 = z0 <= hd ? sq * z0 : sq * hd + k3 - (2 / 3) * u0 * Math.sqrt(u0);
        const G1 = top <= hd ? sq * top : sq * hd + k3 - (2 / 3) * u1 * Math.sqrt(u1);
        return (G1 - G0) * CELL / dz;
    }

    // Flow over a lip, in units of (2/3) Cd sqrt(2g) (the sharp-crested weir): h1 is the upstream
    // level above the lip, h2 the downstream one; a drowned lip passes less (Villemonte).
    function weirHead(h1, h2) {
        if (h1 <= 0) return 0;
        const q = h1 * Math.sqrt(h1);
        if (h2 <= 0) return q;
        const r = h2 >= h1 ? 1 : h2 / h1;
        return q * Math.pow(1 - r * Math.sqrt(r), 0.385);
    }

    // One sub-step for every cavity: level for the pose, exchange through the openings, mass properties
    function updateCavities(dt) {
        const B = body;
        const cavs = B.cavs;
        if (!cavs.length) return;
        const c = Math.cos(st.th), s = Math.sin(st.th);
        setCellGeometry(c, s);
        setCorners(c, s);
        const g = settings.gravity;
        const kQ = CD_OPEN * Math.sqrt(2 * g), kW = (2 / 3) * kQ;
        const rhoD = LIQUIDS[settings.liquid].rho * DEPTH;
        const x0 = st.x, y0 = st.y;
        const OX = B.ox, OY = B.oy;
        const hc = 0.5 * CELL;
        const aS = 1 - Math.exp(-dt / 0.06);
        let mT = 0, mxT = 0, myT = 0, IT = 0;
        for (let ci = 0; ci < cavs.length; ci++) {
            const cv = cavs[ci];
            const cells = cv.cells, Y = cv.Y, n = cv.nc;
            let ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity, iLow = 0, xsum = 0;
            for (let k = 0; k < n; k++) {
                const bi = cells[k];
                const yy = y0 + s * OX[bi] + c * OY[bi];
                const xx = x0 + c * OX[bi] - s * OY[bi];
                Y[k] = yy;
                xsum += xx;
                if (yy < ymin) { ymin = yy; iLow = k; }
                if (yy > ymax) ymax = yy;
                if (xx < xmin) xmin = xx;
                if (xx > xmax) xmax = xx;
            }
            cv.ymin = ymin; cv.ymax = ymax; cv.xmin = xmin - gExt; cv.xmax = xmax + gExt; cv.iLow = iLow; cv.cx = xsum / n;
            solveLevel(cv);

            // ---- exchange with the tank through the openings ----
            const hin = cv.h;
            const full = cv.V >= cv.area * 0.9995, empty = cv.V <= 0;
            let QIt = 0, QOt = 0, qOutAir = 0, dIn = 0, dOut = 0, bub = 0, bubA = 0, vented = false;
            const F = cv.faces;
            // The tank's surface is one curve across the whole tank, so over the object it means
            // nothing: liquid reaches an opening from beyond its ends, so the outside level at a
            // face is capped by the level just outside the opening's ends.
            let fx0 = Infinity, fx1 = -Infinity;
            for (let f = 0; f < cv.nf; f++) {
                const X = x0 + c * F[4 * f] - s * F[4 * f + 1];
                if (X < fx0) fx0 = X;
                if (X > fx1) fx1 = X;
            }
            const sL = surfaceAt(fx0 - CELL), sR = surfaceAt(fx1 + CELL);
            const fspan = fx1 - fx0 > 1e-6 ? fx1 - fx0 : 1;
            cv.sL = sL; cv.sR = sR; cv.fx0 = fx0; cv.fspan = fspan;
            for (let k = 0; k < cv.chains.length; k++) {
                const ch = cv.chains[k];
                let qi = 0, qo = 0;
                const ti = ch.tin, to = ch.tout;
                ti.fill(0); to.fill(0);
                for (let f = ch.f0, fe = ch.f0 + ch.nf; f < fe; f++) {
                    const mx = F[4 * f], my = F[4 * f + 1], nx = F[4 * f + 2], ny = F[4 * f + 3];
                    const X = x0 + c * mx - s * my, Yf = y0 + s * mx + c * my;
                    const nwx = c * nx - s * ny, nwy = s * nx + c * ny;
                    const e = (nwx < 0 ? -nwx : nwx) * hc;
                    const z0 = Yf - e, z1 = Yf + e;
                    const sEnds = sL + (sR - sL) * (X - fx0) / fspan;
                    const sHere = surfaceAt(X);
                    const S = sHere < sEnds ? sHere : sEnds;
                    const airIn = !full && hin < z1 - AIR_EPS;
                    const airOut = S < z1 - AIR_EPS;
                    if (airIn) {
                        if (airOut) vented = true;
                        else {
                            // depth of the air under this opening's top edge (it bubbles out through it);
                            // remember the stretch of opening where it is deepest
                            const a = Math.min(z1 - hin, 0.05);
                            bub += CELL * Math.sqrt(a);
                            if (a > bubA + 0.003) { bubA = a; cv.bX0 = cv.bX1 = X; cv.bY0 = cv.bY1 = z1; cv.bNX = nwx; cv.bNY = nwy; }
                            else if (a > bubA - 0.003) {
                                if (X < cv.bX0) { cv.bX0 = X; cv.bY0 = z1; }
                                if (X > cv.bX1) { cv.bX1 = X; cv.bY1 = z1; }
                                if (a > bubA) bubA = a;
                            }
                        }
                    }
                    if (S > hin) {
                        if (full || S <= z0) continue;
                        const fl = faceFlow(z0, z1, S, hin);
                        if (fl <= 0) continue;
                        const d = S - (z0 > hin ? z0 : hin);
                        qi += fl; if (d > dIn) dIn = d;
                        ti[0] += fl * mx; ti[1] += fl * my; ti[2] += fl * nx; ti[3] += fl * ny; ti[4] += fl * d;
                    } else if (hin > S) {
                        if (empty || hin <= z0) continue;
                        const fl = faceFlow(z0, z1, hin, S);
                        if (fl <= 0) continue;
                        const d = hin - (z0 > S ? z0 : S);
                        qo += fl; if (airOut) qOutAir += fl; if (d > dOut) dOut = d;
                        to[0] += fl * mx; to[1] += fl * my; to[2] += fl * nx; to[3] += fl * ny; to[4] += fl * d;
                    }
                }
                // orifice flow through the wetted part of the opening ...
                let QI = kQ * qi, QO = kQ * qo;
                ch.lipMode = false;
                // ... but through an opening that faces up the liquid has to come over the lips at its
                // ends: weir flow over each, reduced when the far side is above the lip too
                if (ch.lips && s * ch.nbx + c * ch.nby > 0.3 && (QI > 0 || QO > 0)) {
                    const n = ch.px.length - 1;
                    const ax = x0 + c * ch.px[0] - s * ch.py[0], az = y0 + s * ch.px[0] + c * ch.py[0];
                    const bx = x0 + c * ch.px[n] - s * ch.py[n], bz = y0 + s * ch.px[n] + c * ch.py[n];
                    const SA = Math.min(surfaceAt(ax), sL + (sR - sL) * (ax - fx0) / fspan);
                    const SB = Math.min(surfaceAt(bx), sL + (sR - sL) * (bx - fx0) / fspan);
                    const inflow = QI >= QO;
                    const wa = inflow ? weirHead(SA - az, hin - az) : weirHead(hin - az, SA - az);
                    const wb = inflow ? weirHead(SB - bz, hin - bz) : weirHead(hin - bz, SB - bz);
                    const W = kW * (wa + wb);
                    if (inflow ? W < QI : W < QO) {
                        if (inflow) QI = W; else QO = W;
                        ch.lipMode = true;
                        ch.wA = wa + wb > 0 ? wa / (wa + wb) : 0.5;
                    }
                }
                ch.qI = QI; ch.qO = QO;
                QIt += QI; QOt += QO;
            }
            let QI = QIt, QO = QOt;
            const Wc = cv.Ws > CELL ? cv.Ws : CELL;
            // the last sliver of air under a submerged rim leaves as one final bubble
            const sliver = cv.area - cv.V <= 2 * AIR_EPS * Wc;
            if (!vented) {
                // air can only leave as bubbles, or enter where the liquid falls out
                if (!sliver) QI = Math.min(QI, BUBBLE_K * kQ * bub);
                QO = Math.min(QO, GLUG_K * kQ * qOutAir);
            }
            cv.qIn = QI; cv.qOut = QO; cv.vented = vented;
            cv.bubQ = (!vented && bubA > 0 && QI > QO) ? QI : 0;
            let dV = (QI - QO) * dt;
            if (dV > 0) {
                let lim = 0.5 * Wc * dIn;
                if (!vented && !sliver) lim = Math.min(lim, 0.5 * Wc * bubA);
                dV = Math.min(dV, sliver ? Math.max(lim, 0.25 * (cv.area - cv.V)) : lim, cv.area - cv.V);
            } else if (dV < 0) {
                dV = -Math.min(-dV, 0.5 * Wc * dOut, cv.V);
            }
            if (dV !== 0) {
                cv.V += dV;
                if (cv.V < 1e-9) cv.V = 0;
                else if (cv.V > cv.area - 1e-9) cv.V = cv.area;
                cv.h = clamp(cv.h + dV / Wc, ymin - gExt, ymax + gExt);
            }

            // ---- the streams (for drawing): over an opening's lips, or as a jet through it ----
            const kI = QIt > 0 ? QI / QIt : 0, kO = QOt > 0 ? QO / QOt : 0;
            for (let k = 0; k < cv.chains.length; k++) {
                const ch = cv.chains[k];
                const qi = ch.qI * kI, qo = ch.qO * kO;
                const inflow = qi >= qo, q = inflow ? qi : -qo;
                let tA = 0, tB = 0, tJ = 0;
                if (ch.lipMode) { tA = q * ch.wA; tB = q - tA; } else tJ = q;
                ch.sA += (tA - ch.sA) * aS; ch.sB += (tB - ch.sB) * aS; ch.sJ += (tJ - ch.sJ) * aS;
                if (tJ === 0) continue;
                // flow-weighted point and normal of the wetted faces (body frame) and the jet's speed
                const t = inflow ? ch.tin : ch.tout, fl = (inflow ? ch.qI : ch.qO) / kQ;
                if (!(fl > 0)) continue;
                const nl = Math.hypot(t[2], t[3]) || 1;
                const a = ch.sJ * tJ > 0 && Math.abs(ch.sJ) > 0.2 * Math.abs(tJ) ? aS : 1;   // a new jet starts where it is
                ch.jx += (t[0] / fl - ch.jx) * a; ch.jy += (t[1] / fl - ch.jy) * a;
                ch.jnx += (t[2] / nl - ch.jnx) * a; ch.jny += (t[3] / nl - ch.jny) * a;
                ch.jv += (Math.sqrt(2 * g * Math.max(0, t[4] / fl)) - ch.jv) * a;
            }

            // ---- mass properties of the held liquid (body frame, about the dry centre of mass) ----
            if (cv.V <= 0) { cv.m = cv.mx = cv.my = cv.I = 0; cv.Ws = 0; continue; }
            const top = cv.h + gExt;
            let A = 0, ax = 0, ay = 0, aI = 0, sw = 0, swx = 0;
            for (let k = 0; k < n; k++) {
                const tt = top - Y[k];
                if (tt <= 0) continue;
                const bi = cells[k];
                let px = OX[bi], py = OY[bi], a;
                if (tt >= gE2) a = CELL_A;
                else {
                    clipCell(cv.h - Y[k], 0);
                    a = clipA;
                    px += c * clipCX + s * clipCY;
                    py += -s * clipCX + c * clipCY;
                    const w = rampWidth(tt);
                    sw += w; swx += w * (x0 + c * OX[bi] - s * OY[bi]);
                }
                A += a; ax += a * px; ay += a * py; aI += a * (px * px + py * py);
            }
            if (sw > 0) { cv.xs = swx / sw; cv.Ws = sw; }
            const m = rhoD * cv.V;
            let rx, ry, r2;
            if (A > 1e-14) { rx = ax / A; ry = ay / A; r2 = aI / A; }
            else { const bi = cells[iLow]; rx = OX[bi]; ry = OY[bi]; r2 = rx * rx + ry * ry; }
            const rc2 = rx * rx + ry * ry;
            cv.m = m; cv.mx = m * rx; cv.my = m * ry;
            cv.I = m * rc2 + WATER_SPIN * m * Math.max(0, r2 - rc2);
            mT += cv.m; mxT += cv.mx; myT += cv.my; IT += cv.I;
        }
        B.waterMass = mT; B.waterMx = mxT; B.waterMy = myT; B.waterInertia = IT;
        B.waterArea = 0;
        for (let ci = 0; ci < cavs.length; ci++) B.waterArea += cavs[ci].V;
    }

    // after a liquid change: the held volume stays, its mass follows the new density
    function updateWaterMass(B) {
        const k = LIQUIDS[settings.liquid].rho * DEPTH;
        let m = 0, mx = 0, my = 0, I = 0;
        for (const cv of B.cavs) {
            const old = cv.m;
            if (old > 0) { const f = k * cv.V / old; cv.m *= f; cv.mx *= f; cv.my *= f; cv.I *= f; }
            m += cv.m; mx += cv.mx; my += cv.my; I += cv.I;
        }
        B.waterMass = m; B.waterMx = mx; B.waterMy = my; B.waterInertia = I;
    }

    // ------------------------------------------------------------------
    // Streams: liquid pouring over a lip or through a hole (geometry shared by drawing and splashes)
    // ------------------------------------------------------------------
    const Q_MIN = 2e-4;           // smallest stream that is drawn (m^2/s)
    function cavityLevelAt(cv, x) {
        return cv.h + Math.tan(cv.phi) * (x - cv.xs);
    }
    // the outside level an opening sees (capped by the level beyond its ends, as in updateCavities)
    function openingSurface(cv, x) {
        const sE = cv.sL + (cv.sR - cv.sL) * (x - cv.fx0) / cv.fspan;
        const sH = surfaceAt(x);
        return sH < sE ? sH : sE;
    }
    // what the body has at a world point: its cell type there (T_EXT outside it); hitCav is the
    // cavity of an open cell
    let hitCav = -1;
    function bodyCellAt(x, y) {
        hitCav = -1;
        const B = body;
        if (!B) return T_EXT;
        const c = Math.cos(st.th), s = Math.sin(st.th);
        const dx = x - st.x, dy = y - st.y;
        const lc = Math.floor((c * dx + s * dy + B.comLX) / CELL), lr = Math.floor((-s * dx + c * dy + B.comLY) / CELL);
        if (lc < 0 || lr < 0 || lc >= B.LW || lr >= B.LH) return T_EXT;
        const li = lr * B.LW + lc;
        hitCav = B.cavIdx[li];
        return B.ltype[li];
    }

    // an opening as drawn (its envelope) in world coordinates (cpX/cpZ), no segment longer than 1 cm
    const CP_MAX = 4096;
    const cpX = new Float64Array(CP_MAX), cpZ = new Float64Array(CP_MAX);
    function chainPoints(ch, c, s) {
        const n = ch.ex.length;
        let px = st.x + c * ch.ex[0] - s * ch.ey[0], pz = st.y + s * ch.ex[0] + c * ch.ey[0];
        let m = 0;
        cpX[m] = px; cpZ[m] = pz; m++;
        for (let i = 1; i < n && m < CP_MAX; i++) {
            const qx = st.x + c * ch.ex[i] - s * ch.ey[i], qz = st.y + s * ch.ex[i] + c * ch.ey[i];
            const k = Math.max(1, Math.ceil(Math.hypot(qx - px, qz - pz) / CELL));
            for (let j = 1; j <= k && m < CP_MAX; j++) { cpX[m] = px + (qx - px) * j / k; cpZ[m] = pz + (qz - pz) * j / k; m++; }
            px = qx; pz = qz;
        }
        return m;
    }
    // The stretches of that polyline lying between lo(x) and hi(x): each run covers points i0..i1 and
    // starts and ends at (sx, sz) and (ex, ez), on the polyline (a band crossing, or its end point).
    const runs = [];
    function bandRuns(m, lo, hi) {
        runs.length = 0;
        const inBand = (x, z) => z > lo(x) && z < hi(x);
        const cross = (i) => {   // where the state changes between points i-1 and i
            const was = inBand(cpX[i - 1], cpZ[i - 1]);
            let a = 0, b = 1;
            for (let it = 0; it < 12; it++) {
                const t = 0.5 * (a + b);
                if (inBand(cpX[i - 1] + (cpX[i] - cpX[i - 1]) * t, cpZ[i - 1] + (cpZ[i] - cpZ[i - 1]) * t) === was) a = t; else b = t;
            }
            const t = 0.5 * (a + b);
            return [cpX[i - 1] + (cpX[i] - cpX[i - 1]) * t, cpZ[i - 1] + (cpZ[i] - cpZ[i - 1]) * t];
        };
        let r = null;
        for (let i = 0; i < m; i++) {
            const now = inBand(cpX[i], cpZ[i]);
            if (now && !r) {
                r = { i0: i, i1: i, sx: cpX[i], sz: cpZ[i], ex: 0, ez: 0 };
                if (i > 0) { const p = cross(i); r.sx = p[0]; r.sz = p[1]; }
            } else if (!now && r) {
                const p = cross(i);
                r.i1 = i - 1; r.ex = p[0]; r.ez = p[1];
                runs.push(r); r = null;
            }
        }
        if (r) { r.i1 = m - 1; r.ex = cpX[m - 1]; r.ez = cpZ[m - 1]; runs.push(r); }
        return runs.length;
    }

    // A stream as a ribbon: its centre line traced under gravity from (x, y) with velocity (vx, vy),
    // as wide as the flow q needs at its speed (narrowing as it speeds up; a rising one, traced only up
    // to its top, may widen a little); stop(x, y) ends it where it lands
    const RB_MAX = 160;
    const rbX = new Float64Array(RB_MAX), rbY = new Float64Array(RB_MAX), rbW = new Float64Array(RB_MAX);
    const rbNX = new Float64Array(RB_MAX), rbNY = new Float64Array(RB_MAX);
    function traceStream(x, y, vx, vy, q, w0, stop, rising) {
        const g = settings.gravity, wMin = 1.2 / scale;
        let n = 0, t = 0;
        while (n < RB_MAX) {
            if (rising && n > 1 && vy <= 0.05 * Math.abs(vx) + 0.02) break;
            const sp = Math.hypot(vx, vy);
            const w = sp > 1e-6 ? q / sp : w0;
            rbX[n] = x; rbY[n] = y;
            rbW[n] = Math.max(wMin, Math.min(w, (rising ? 1.6 : 1) * w0));
            if (sp > 0.03 || n === 0) { rbNX[n] = sp > 1e-9 ? -vy / sp : 0; rbNY[n] = sp > 1e-9 ? vx / sp : 1; }
            else { rbNX[n] = rbNX[n - 1]; rbNY[n] = rbNY[n - 1]; }
            n++;
            if (n > 1 && (stop(x, y) || t > 1.5)) break;
            const dt = clamp(0.006 / Math.max(sp, 0.05), 0.0015, 0.03);
            vy -= g * dt; x += vx * dt; y += vy * dt; t += dt;
        }
        return n;
    }

    // Streams leaving the object, found while drawing the cavities (start, velocity, flow, width) and
    // drawn on top of it; where they land in the tank they splash
    const outStreams = [];
    const landings = [];

    // Per frame: slosh of the inside surfaces (drawn only), ripples, splashes where a stream lands,
    // trapped air bubbling out
    function stepCavityVisuals(dtF) {
        const B = body;
        if (!B || !B.cavs.length || !(dtF > 0)) return;
        const g = settings.gravity;
        const a = 1 - Math.exp(-dtF / 0.08);
        accX += ((st.vx - prevVX) / dtF - accX) * a;
        accY += ((st.vy - prevVY) / dtF - accY) * a;
        prevVX = st.vx; prevVY = st.vy;
        const liq = LIQUIDS[settings.liquid];
        const zeta = clamp(0.06 + 0.03 * liq.damp, 0.08, 0.3);
        // in a frame moving with the hull the liquid feels gravity minus the hull's acceleration
        const eq = clamp(Math.atan2(-accX, Math.max(0.2 * g, g + accY)), -0.3, 0.3);
        const ripDecay = Math.exp(-dtF / 0.7);
        for (const cv of B.cavs) {
            cv.ripT += dtF;
            cv.rip *= ripDecay;
            if (cv.V <= 0 || cv.V >= cv.area || cv.Ws < 2 * CELL) { cv.phi *= 0.8; cv.phiV = 0; }
            else {
                const k = Math.PI / cv.Ws;
                const d = Math.max(CELL, cv.V / cv.Ws);
                const w = Math.sqrt(g * k * Math.tanh(k * d));
                let t = dtF;
                while (t > 1e-9) {
                    const hh = Math.min(t, 1 / 120);
                    cv.phiV += (w * w * (eq - cv.phi) - 2 * zeta * w * cv.phiV) * hh;
                    cv.phi += cv.phiV * hh;
                    t -= hh;
                }
                if (cv.phi > 0.3) { cv.phi = 0.3; cv.phiV = 0; } else if (cv.phi < -0.3) { cv.phi = -0.3; cv.phiV = 0; }
                // the slosh is only drawn, so it must not lift the surface over a lip (it would have
                // to spill there)
                const c = Math.cos(st.th), s = Math.sin(st.th);
                let lo = -1, hi = 1;
                for (const ch of cv.chains) {
                    if (!ch.lips) continue;
                    for (let e = 0; e < 2; e++) {
                        const i = e ? ch.px.length - 1 : 0;
                        const dx = st.x + c * ch.px[i] - s * ch.py[i] - cv.xs, dz = st.y + s * ch.px[i] + c * ch.py[i] - cv.h;
                        if (dz <= 0 || (dx < 0 ? -dx : dx) < 1e-4) continue;
                        if (dx > 0) { if (dz / dx < hi) hi = dz / dx; } else if (dz / dx > lo) lo = dz / dx;
                    }
                }
                const tp = Math.tan(cv.phi);
                if (tp > hi) { cv.phi = Math.atan(hi); cv.phiV = 0; } else if (tp < lo) { cv.phi = Math.atan(lo); cv.phiV = 0; }
            }
            // a stream pouring in stirs the inside surface
            if (cv.V > 0) {
                let qIn = 0;
                for (const ch of cv.chains) qIn += Math.max(0, ch.sA) + Math.max(0, ch.sB) + Math.max(0, ch.sJ);
                if (qIn > Q_MIN) {
                    const hit = Math.min(0.004, 0.25 * qIn);
                    if (hit > cv.rip) cv.rip = hit;
                }
            }
            // trapped air leaving as bubbles, from the stretch of opening where it is deepest; they
            // start just outside the object (past the lip when the opening faces down)
            if (cv.bubQ > 0) {
                let nb = Math.min(40, cv.bubQ / 6e-5) * dtF;
                while (nb > 0) {
                    if (nb >= 1 || Math.random() < nb) {
                        const u = Math.random();
                        let x = cv.bX0 + (cv.bX1 - cv.bX0) * u + cv.bNX * 0.006, y = cv.bY0 + (cv.bY1 - cv.bY0) * u + cv.bNY * 0.006;
                        const away = x >= cv.cx ? 1 : -1;
                        for (let k = 0; k < 16 && bodyCellAt(x, y) !== T_EXT; k++) x += away * 0.005;
                        if (bodyCellAt(x, y) === T_EXT) spawnBubble(x + (Math.random() - 0.5) * 0.008, y);
                    }
                    nb -= 1;
                }
            }
        }
        // streams pouring out splash where they land
        for (let i = 0; i < landings.length; i += 2) {
            const xi = landings[i], q = landings[i + 1];
            if (Math.random() < Math.min(1, q * 500 * dtF)) spawnDroplet(xi + (Math.random() - 0.5) * 0.02, surfaceAt(xi), 0.8 + Math.random() * 0.8);
            disturbSurface(xi, -0.15 * q * dtF);
        }
    }

    // air bubbles rising through the liquid (they burst at the surface, or where they reach the
    // object's air or material)
    const MAX_BUBBLES = 160;
    const bX = new Float64Array(MAX_BUBBLES), bY = new Float64Array(MAX_BUBBLES);
    const bR = new Float64Array(MAX_BUBBLES), bPh = new Float64Array(MAX_BUBBLES), bV = new Float64Array(MAX_BUBBLES);
    let nBubbles = 0;
    function spawnBubble(x, y) {
        if (nBubbles >= MAX_BUBBLES) return;
        const i = nBubbles++;
        bX[i] = x; bY[i] = y;
        bR[i] = 0.002 + Math.random() * 0.004;
        bPh[i] = Math.random() * 6.283;
        bV[i] = 0.18 + Math.random() * 0.12 + bR[i] * 15;
    }
    // is a point in liquid that belongs to the tank or a cavity (not air, not material)?
    function inLiquid(x, y) {
        const t = bodyCellAt(x, y);
        if (t === T_EXT) return y < surfaceAt(x);
        if (t !== T_OPEN || hitCav < 0) return false;
        const cv = body.cavs[hitCav];
        return cv.V > 0 && y < cavityLevelAt(cv, x);
    }
    function stepBubbles(dt) {
        let i = 0;
        while (i < nBubbles) {
            bPh[i] += dt * 9;
            bY[i] += bV[i] * dt;
            bX[i] += Math.cos(bPh[i]) * 0.04 * dt;
            if (bY[i] > TANK_H || !inLiquid(bX[i], bY[i])) {
                const last = --nBubbles;
                bX[i] = bX[last]; bY[i] = bY[last]; bR[i] = bR[last]; bPh[i] = bPh[last]; bV[i] = bV[last];
            } else i++;
        }
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
            gam[k] = liq.damp + 2 * nu * kap * kap + 12 * r * r * r * r;
        }
    }

    function clearWaves() {
        amp.fill(0); vel.fill(0); eta.fill(0); nParticles = 0; nBubbles = 0;
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
                    amp[k] += p * f * srcFilter[k];
                }
                // splash droplets where the surface is being pushed up fast
                for (let j = jmin; j <= jmax; j++) {
                    const rate = src[j] / dt;
                    if (rate > 0.6 && nParticles < MAX_PARTICLES && Math.random() < Math.min(1, (rate - 0.6) * 0.5)) {
                        // (not where the surface lies inside the object, e.g. in an upturned cup)
                        const x = (j + Math.random()) * DXC;
                        if (bodyCellAt(x, level + eta[j]) === T_EXT) spawnDroplet(x, level + eta[j], rate);
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
            // a falling drop ends in the liquid (the tank's or a cavity's) or on the object
            let landed = false;
            if (pVY[i] < 0) {
                const t = bodyCellAt(pX[i], pY[i]);
                landed = t === T_EXT ? pY[i] < surfaceAt(pX[i]) : (t !== T_OPEN || inLiquid(pX[i], pY[i]));
            }
            if (landed || pLife[i] > 3) {
                const last = --nParticles;
                pX[i] = pX[last]; pY[i] = pY[last]; pVX[i] = pVX[last]; pVY[i] = pVY[last]; pLife[i] = pLife[last];
            } else i++;
        }
    }

    // a small Gaussian dent in the surface (negative strength: a bump), projected onto the modes
    function disturbSurface(x, strength) {
        const f = 2 / NCOL;
        let j0 = NCOL, j1 = -1;
        for (let j = 0; j < NCOL; j++) {
            const dx = ((j + 0.5) * DXC - x) / 0.035;
            const v = dx * dx < 16 ? -strength * Math.exp(-dx * dx) : 0;
            src[j] = v;
            if (v !== 0) { if (j < j0) j0 = j; j1 = j; }
        }
        if (j1 < 0) return;
        // (the mean of the dent only feeds mode 0, the level, which is not a wave)
        for (let k = 1; k <= NMODE; k++) {
            let p = 0;
            const base = k * NCOL;
            for (let j = j0; j <= j1; j++) p += src[j] * cosKJ[base + j];
            amp[k] += p * f * srcFilter[k];
        }
    }

    function pokeLiquid(x, strength) {
        disturbSurface(x, strength);
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
        setCorners(c, s);
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
            let j, t;
            if (fc <= 0) { j = 0; t = 0; }
            else if (fc >= NCOL - 1) { j = NCOL - 2; t = 1; }
            else { j = Math.floor(fc); t = fc - j; }
            const S = surfaceAt(X), k = surfSlope;
            const d = S - Y;
            if (d < dTop) dTop = d;
            const lim = ext * (1 + (k < 0 ? -k : k));
            if (d > -lim) {
                let A, cx, cy;
                if (d >= lim) { A = CELL_A; cx = 0; cy = 0; }
                else { clipCell(d, k); A = clipA; cx = clipCX; cy = clipCY; }
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
            const S = surfaceAt(X);
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

        // ---- liquid held in open cavities (new pose) ----
        updateCavities(dt);

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
        resetCavities(body);
        st.x = body.worldX; st.y = body.worldY; st.th = 0; st.vx = 0; st.vy = 0;
        prevVX = prevVY = accX = accY = 0;
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
        let since = 0;
        updateWaveCoefficients();
        while (acc2 >= DT - 1e-12) {
            substep(DT);
            acc2 -= DT;
            n++;
            since += DT;
            if (since >= 1 / 60 - 1e-9) { stepParticles(since); stepBubbles(since); stepCavityVisuals(since); since = 0; }
        }
        if (since > 0) { stepParticles(since); stepBubbles(since); stepCavityVisuals(since); }
        // show the latest state directly (the frame loop only smooths while time is running)
        disp.fbX = phys.fbX; disp.fbY = phys.fbY; disp.fdX = phys.fdX; disp.fdY = phys.fdY;
        disp.fcX = phys.fcX; disp.fcY = phys.fcY;
        disp.netX = phys.fbX + phys.fdX + phys.fcX + phys.fgrabX;
        disp.netY = phys.fbY + phys.fdY + phys.fcY + phys.fgrabY - phys.weight + phys.airB;
        disp.hasContact = phys.contactW > 0 ? 1 : 0;
        if (phys.contactW > 0) { disp.cpx = phys.contactPX; disp.cpy = phys.contactPY; }
        disp.sub = body.areaEnv > 0 ? phys.subEnv / body.areaEnv : 0;
        resetAccumulators();
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
    // Positions are in grid cells (1 cm): the tank is 240 x 150 and the liquid starts 60 deep,
    // so objects are drawn just above the surface around column 120.
    const PRESETS = [
        { key: 'pine', label: 'Pine block', build() { fillRect(100, 72, 40, 25, MAT_ID.pine); } },
        { key: 'ice', label: 'Ice block', build() { fillRect(108, 70, 24, 24, MAT_ID.ice); } },
        { key: 'cork', label: 'Cork slab', build() { fillRect(100, 70, 40, 8, MAT_ID.cork); } },
        { key: 'steel', label: 'Steel block', build() { fillRect(110, 70, 20, 12, MAT_ID.steel); } },
        { key: 'nylon', label: 'Nylon block (sinks slowly)', build() { fillRect(110, 70, 20, 15, MAT_ID.nylon); } },
        { key: 'gold', label: 'Gold bar', build() { fillRect(112, 70, 16, 8, MAT_ID.gold); } },
        { key: 'plank', label: 'Tall pine plank (stability)', build() { fillRect(117, 66, 6, 38, MAT_ID.pine); } },
        { key: 'blend', label: 'Cork float with a steel weight', build() {
            fillRect(90, 73, 60, 10, MAT_ID.cork); fillRect(92, 70, 6, 3, MAT_ID.steel);
        } },
        { key: 'ball', label: 'Hollow steel ball (sealed)', build() { fillShape('ring', 95, 62, 144, 111, 1, MAT_ID.steel); } },
        { key: 'boat', label: 'Steel boat (open hull)', build() {
            const S = MAT_ID.steel;
            fillRect(90, 48, 60, 1, S); fillRect(90, 49, 1, 18, S); fillRect(149, 49, 1, 18, S);
        } },
        { key: 'leaky', label: 'Steel boat with a hole', build() {
            const S = MAT_ID.steel;
            fillRect(90, 48, 60, 1, S); fillRect(90, 49, 1, 18, S); fillRect(149, 49, 1, 18, S);
            setCell(119, 48, 0);
        } },
        { key: 'bulkheads', label: 'Boat with bulkheads (one compartment holed)', build() {
            // the holed end compartment floods to the outside level; the others keep the boat afloat
            const A = MAT_ID.aluminium;
            fillRect(84, 48, 72, 1, A); fillRect(84, 49, 1, 18, A); fillRect(155, 49, 1, 18, A);
            fillRect(100, 49, 1, 18, A); fillRect(139, 49, 1, 18, A);
            setCell(91, 48, 0);
        } },
        { key: 'canoe', label: 'Aluminium canoe', build() {
            fillShape('ring', 88, 66, 151, 109, 1, MAT_ID.aluminium, (c, r) => r < 88);
        } },
        { key: 'bell', label: 'Upside-down cup (traps air)', build() {
            const S = MAT_ID.steel;
            fillRect(100, 88, 40, 1, S); fillRect(100, 70, 1, 18, S); fillRect(139, 70, 1, 18, S);
        } },
        { key: 'ship', label: 'Steel ship with a wooden cabin', build() {
            const S = MAT_ID.steel, P = MAT_ID.pine;
            // 1 cm steel hull with raked ends (steps kept 4-connected so the hull is watertight)
            fillRect(86, 61, 68, 1, S);
            for (let r = 0; r < 28; r++) {
                const k = Math.floor(r / 3), kn = Math.floor((r + 1) / 3);
                setCell(85 - k, 62 + r, S); setCell(154 + k, 62 + r, S);
                if (kn !== k && r < 27) { setCell(84 - k, 62 + r, S); setCell(155 + k, 62 + r, S); }
            }
            setCell(85, 61, S); setCell(154, 61, S);
            // cabin with two sealed windows, a mast with a nylon flag, cork fenders
            fillRect(108, 62, 22, 11, P);
            fillRect(111, 66, 5, 4, 0); fillRect(122, 66, 5, 4, 0);
            fillRect(117, 73, 2, 26, P);
            fillRect(119, 90, 13, 7, MAT_ID.nylon);
            fillRect(78, 76, 3, 6, MAT_ID.cork); fillRect(159, 76, 3, 6, MAT_ID.cork);
        } }
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
    // The shared stylesheet sizes the aspect-ratio box (normal and fullscreen); the drawing
    // buffer just follows the canvas's displayed size and the device pixel ratio.
    function handleResize() {
        const box = canvas.parentElement;
        if (box && (box.style.width || box.style.height)) { box.style.width = ''; box.style.height = ''; }
        const tw = Math.max(1, Math.round(canvas.clientWidth));
        const th = Math.max(1, Math.round(canvas.clientHeight));
        const ndpr = Math.min(2, window.devicePixelRatio || 1);   // more is not visibly sharper, just slower
        if (tw !== cssW || th !== cssH || ndpr !== dpr) {
            cssW = tw; cssH = th; dpr = ndpr;
            scale = Math.min(cssW / TANK_W, cssH / TANK_H);
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
            gridLayerDirty = true;
            drawDirty = true;
            gradientKey = '';
            if (body) body.imgKey = '';
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
        if (body) body.imgKey = '';
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
    }

    // outline of a cavity (screen coordinates) as closed loops; under its walls it reaches half a
    // pixel further, so no seam shows between the liquid and the wall's outline
    function addCavityOutline(p, cv, c, s) {
        const d = 0.5 / scale;
        for (const L of cv.loops) {
            const n = L.x.length;
            let first = true;
            const put = (bx, by) => {
                const X = (st.x + c * bx - s * by) * scale, Y = (TANK_H - (st.y + s * bx + c * by)) * scale;
                if (first) { p.moveTo(X, Y); first = false; } else p.lineTo(X, Y);
            };
            for (let i = 0; i < n; i++) {
                // (consecutive wall sides are at right angles, so their offsets add up exactly)
                const ip = i === 0 ? n - 1 : i - 1;
                const oIn = L.o[ip] ? 0 : d, oOut = L.o[i] ? 0 : d;
                put(L.x[i] + oIn * L.nx[ip] + oOut * L.nx[i], L.y[i] + oIn * L.ny[ip] + oOut * L.ny[i]);
            }
            p.closePath();
        }
    }

    // the tank's liquid look on any path (one opaque layer; layered as the tank is drawn if the
    // browser cannot transform patterns)
    let liqTint = '';
    function fillLiquid(path) {
        if (liquidPattern) { ctx.fillStyle = liquidPattern; ctx.fill(path); return; }
        ctx.fillStyle = bgGradient; ctx.fill(path);
        ctx.fillStyle = liquidGradient; ctx.fill(path);
        ctx.fillStyle = liqTint; ctx.fill(path);
    }

    // 2 screen pixels into the cavity, across an opening (against its outward normal)
    function sinkInto(ch, c, s) {
        const nx = c * ch.nbx - s * ch.nby, ny = s * ch.nbx + c * ch.nby, l = Math.hypot(nx, ny) || 1;
        return [-2 * nx / l, 2 * ny / l];
    }

    // A stretch of an opening (a band run over cpX/cpZ) and the space above it up to top(x) + pad,
    // reaching ext further at both ends; its bottom is moved by (kx, ky) screen pixels into the
    // cavity, so that it overlaps the cavity instead of sharing an edge with it (two fills meeting
    // along an edge leave a faint seam)
    function addBand(p, r, top, pad, ext, kx, ky) {
        const dir = r.ex >= r.sx ? 1 : -1;
        p.moveTo(wx(r.sx - dir * ext) + kx, wy(r.sz) + ky);
        p.lineTo(wx(r.sx) + kx, wy(r.sz) + ky);
        for (let i = r.i0; i <= r.i1; i++) p.lineTo(wx(cpX[i]) + kx, wy(cpZ[i]) + ky);
        p.lineTo(wx(r.ex) + kx, wy(r.ez) + ky);
        p.lineTo(wx(r.ex + dir * ext) + kx, wy(r.ez) + ky);
        p.lineTo(wx(r.ex + dir * ext), wy(top(r.ex) + pad));
        for (let i = r.i1; i >= r.i0; i--) p.lineTo(wx(cpX[i]), wy(top(cpX[i]) + pad));
        p.lineTo(wx(r.sx - dir * ext), wy(top(r.sx) + pad));
        p.closePath();
    }

    // A traced stream (traceStream, n points) filled like the liquid, with a light edge along its upper
    // side and faint streaks running along it; rounded at the end for the top of a fountain
    function drawStream(n, liq, speed, roundEnd) {
        if (n < 2) return;
        const p = new Path2D();
        for (let i = 0; i < n; i++) {
            const h = 0.5 * rbW[i], X = wx(rbX[i] + rbNX[i] * h), Y = wy(rbY[i] + rbNY[i] * h);
            if (i === 0) p.moveTo(X, Y); else p.lineTo(X, Y);
        }
        if (roundEnd) {
            // half a circle round the front: from the left side, the way the stream was heading
            const i = n - 1;
            p.arc(wx(rbX[i]), wy(rbY[i]), 0.5 * rbW[i] * scale, Math.atan2(-rbNY[i], rbNX[i]), Math.atan2(-rbNY[i], rbNX[i]) + Math.PI, false);
        }
        for (let i = n - 1; i >= 0; i--) {
            const h = 0.5 * rbW[i];
            p.lineTo(wx(rbX[i] - rbNX[i] * h), wy(rbY[i] - rbNY[i] * h));
        }
        p.closePath();
        fillLiquid(p);
        const side = rbNY[0] >= 0 ? 1 : -1;
        const e = new Path2D();
        let wsum = 0;
        for (let i = 0; i < n; i++) {
            const h = 0.5 * rbW[i] * side, X = wx(rbX[i] + rbNX[i] * h), Y = wy(rbY[i] + rbNY[i] * h);
            if (i === 0) e.moveTo(X, Y); else e.lineTo(X, Y);
            wsum += rbW[i];
        }
        ctx.lineJoin = 'round';
        ctx.strokeStyle = liq.surface;
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 1.2;
        ctx.stroke(e);
        // faint streaks running along a long, thick stream
        const wPx = wsum / n * scale;
        if (wPx > 3 && Math.hypot(rbX[n - 1] - rbX[0], rbY[n - 1] - rbY[0]) > 0.08) {
            const cl = new Path2D();
            cl.moveTo(wx(rbX[0]), wy(rbY[0]));
            for (let i = 1; i < n; i++) cl.lineTo(wx(rbX[i]), wy(rbY[i]));
            ctx.globalAlpha = 0.15;
            ctx.lineWidth = Math.max(1, 0.15 * wPx);
            ctx.setLineDash([0.025 * scale, 0.04 * scale]);
            ctx.lineDashOffset = -simTime * Math.max(0.3, speed) * scale;
            ctx.stroke(cl);
            ctx.setLineDash([]);
        }
        ctx.globalAlpha = 1;
    }

    // Liquid pouring out over a lip: the pool runs over the opening (the band run r, from the pool's
    // edge to the lip; split: only up to that point) as a tongue whose surface drops to the depth
    // over the lip, then falls
    function drawTongue(cv, ch, r, atA, m, q, liq, split, c, s) {
        const xs = [], zs = [];
        if (atA) {
            for (let i = 0, i1 = split >= 0 ? split : r.i1; i <= i1; i++) { xs.push(cpX[i]); zs.push(cpZ[i]); }
            if (split < 0) { xs.push(r.ex); zs.push(r.ez); }
        } else {
            for (let i = m - 1, i0 = split >= 0 ? split : r.i0; i >= i0; i--) { xs.push(cpX[i]); zs.push(cpZ[i]); }
            if (split < 0) { xs.push(r.sx); zs.push(r.sz); }
        }
        const n = xs.length;
        const lipX = xs[0], lipZ = zs[0];
        const wb = Math.max(0.6 * (cavityLevelAt(cv, lipX) - lipZ), 1.2 / scale);
        // (its bottom reaches 2 px into the pool: a shared edge would leave a faint seam)
        const [kx, ky] = sinkInto(ch, c, s);
        const p = new Path2D(), top = new Path2D();
        p.moveTo(wx(xs[0]) + kx, wy(zs[0]) + ky);
        for (let k = 1; k < n; k++) p.lineTo(wx(xs[k]) + kx, wy(zs[k]) + ky);
        for (let k = n - 1; k >= 0; k--) {
            // from the pool's level at its edge down to the depth over the lip, level at both ends
            const u = n > 1 ? 1 - k / (n - 1) : 1;
            const L = cavityLevelAt(cv, xs[k]);
            const y = wy(L - (L - (lipZ + wb)) * u * u * (3 - 2 * u));
            p.lineTo(wx(xs[k]), y);
            if (k === n - 1) top.moveTo(wx(xs[k]), y); else top.lineTo(wx(xs[k]), y);
        }
        p.closePath();
        fillLiquid(p);
        ctx.strokeStyle = liq.surface;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 1.5;
        ctx.stroke(top);
        ctx.globalAlpha = 1;
        let dir = Math.sign(lipX - xs[n - 1]);
        if (Math.abs(lipX - xs[n - 1]) < 1e-4) dir = lipX >= cv.cx ? 1 : -1;
        // (the fall starts just before the lip, over the tongue, so no edge shows between them)
        outStreams.push([lipX - dir * 1.5 / scale, lipZ + 0.5 * wb, dir * q / wb, 0, q, wb]);
    }

    // Liquid held in the cavities, drawn like the tank's liquid: a level (sloshing) surface clipped to
    // each cavity, and the streams pouring in or out of it
    const surfPts = new Float64Array(2 * 400);
    function drawCavities() {
        const B = body;
        const liq = LIQUIDS[settings.liquid];
        liqTint = 'rgba(' + liq.top.join(',') + ',' + (pal.dark ? 0.16 : 0.14) + ')';
        const c = Math.cos(st.th), s = Math.sin(st.th);
        const ext = 0.5 * CELL * (Math.abs(c) + Math.abs(s));
        const g = settings.gravity;
        const pad = 1.5 / scale;
        outStreams.length = 0;
        for (const cv of B.cavs) {
            const outline = new Path2D();
            addCavityOutline(outline, cv, c, s);
            const lev = (x) => cavityLevelAt(cv, x);
            const sOut = (x) => openingSurface(cv, x);
            const sTop = (x) => Math.max(sOut(x), surfaceAt(x));
            const stopIn = (x, y) => y <= cavityLevelAt(cv, x) || y < cv.ymin - CELL || x < cv.xmin - CELL || x > cv.xmax + CELL;

            // 1. Liquid pouring in over a lip. Where there is air under the opening, the tank's liquid
            //    drawn over it is really falling in, so that stretch is cleared (while the cavity is
            //    vented: over trapped air it stays, and the air bubbles up through it).
            const clear = new Path2D(), inClip = new Path2D();
            let nClear = 0;
            const px1 = 1 / scale;
            const sTopPad = (x) => sTop(x) + pad;
            const nappes = [];
            for (const ch of cv.chains) {
                if (!(ch.sA > Q_MIN || ch.sB > Q_MIN)) continue;
                const m = chainPoints(ch, c, s);
                const nr = bandRuns(m, lev, sTopPad);
                if (!nr) continue;
                const [kx, ky] = sinkInto(ch, c, s);
                if (cv.vented) for (const r of runs) { addBand(clear, r, sTop, pad, 0, kx, ky); addBand(inClip, r, sTop, pad, 3 * px1, kx, ky); nClear++; }
                for (let e = 0; e < 2; e++) {
                    const q = e ? ch.sB : ch.sA;
                    if (!(q > Q_MIN)) continue;
                    const r = e ? runs[nr - 1] : runs[0];
                    const x = e ? r.ex : r.sx, z = e ? r.ez : r.sz, xo = e ? r.sx : r.ex;
                    const H = Math.min(sOut(x), sTop(x)) - z;
                    if (H < 0.5 * px1) continue;
                    let dir = Math.sign(xo - x);
                    if (Math.abs(xo - x) < 1e-4) dir = cv.cx >= x ? 1 : -1;
                    // (starting just upstream of the lip, under the tank's liquid, so no edge shows)
                    nappes.push([x - dir * 1.5 * px1, z + 0.5 * H, dir * q / H, q, H]);
                }
            }
            if (nClear) { ctx.fillStyle = bgGradient; ctx.fill(clear); }

            // 2. The pool, clipped to the cavity
            ctx.save();
            ctx.clip(outline);
            const bx0 = Math.floor(wx(cv.xmin)) - 3, bx1 = Math.ceil(wx(cv.xmax)) + 3;
            const by0 = -2, by1 = Math.ceil(wy(cv.ymin - ext)) + 3;
            const box = new Path2D();
            box.rect(bx0, by0, bx1 - bx0, by1 - by0);
            if (cv.V <= 0) {
                ctx.fillStyle = bgGradient; ctx.fill(box);
            } else if (cv.V >= cv.area) {
                fillLiquid(box);
            } else {
                // surface: level line + slosh tilt + ripples
                const np = clamp(Math.ceil((bx1 - bx0) / 5), 2, 399);
                const tp = Math.tan(cv.phi);
                const t = cv.ripT;
                for (let i = 0; i <= np; i++) {
                    const sx = bx0 + (bx1 - bx0) * i / np;
                    const xw = sx / scale;
                    let yw = cv.h + tp * (xw - cv.xs);
                    if (cv.rip > 2e-5) yw += cv.rip * (0.6 * Math.sin(xw * 52 - t * 7.5) + 0.4 * Math.sin(xw * 87 + t * 11));
                    surfPts[2 * i] = sx; surfPts[2 * i + 1] = wy(yw);
                }
                const below = new Path2D(), above = new Path2D(), line = new Path2D();
                below.moveTo(bx0, by1); above.moveTo(bx0, by0);
                for (let i = 0; i <= np; i++) {
                    const sx = surfPts[2 * i], sy = surfPts[2 * i + 1];
                    below.lineTo(sx, sy); above.lineTo(sx, sy);
                    if (i === 0) line.moveTo(sx, sy); else line.lineTo(sx, sy);
                }
                below.lineTo(bx1, by1); below.closePath();
                above.lineTo(bx1, by0); above.closePath();
                ctx.fillStyle = bgGradient; ctx.fill(above);
                fillLiquid(below);
                ctx.strokeStyle = liq.surface;
                ctx.globalAlpha = 0.85;
                ctx.lineWidth = 1.5;
                ctx.stroke(line);
                ctx.globalAlpha = 1;
            }
            ctx.restore();

            // 3. Liquid pouring out over a lip runs over it as a tongue, then falls (drawn later, on top)
            for (const ch of cv.chains) {
                if (!(ch.sA < -Q_MIN || ch.sB < -Q_MIN) || cv.V <= 0) continue;
                const m = chainPoints(ch, c, s);
                const nr = bandRuns(m, sOut, lev);
                if (!nr) continue;
                const rA = runs[0], rB = runs[nr - 1];
                const spillA = ch.sA < -Q_MIN && rA.i0 === 0, spillB = ch.sB < -Q_MIN && rB.i1 === m - 1;
                // one run over the whole opening (full to the brim): each lip gets half of it
                const split = spillA && spillB && nr === 1 ? (m - 1) >> 1 : -1;
                if (spillA) drawTongue(cv, ch, rA, true, m, -ch.sA, liq, split, c, s);
                if (spillB) drawTongue(cv, ch, rB, false, m, -ch.sB, liq, split, c, s);
            }

            // 4. Streams falling into the cavity: over the lips, through holes as jets, or, over a
            //    submerged hole, a fountain of what is left of the jet when it reaches the surface
            //    (The nappes are drawn once inside the cavity and once over the cleared stretches.)
            for (let pass = 0; pass < (nClear ? 2 : 1) && nappes.length; pass++) {
                ctx.save();
                ctx.clip(pass ? inClip : outline);
                for (const [x, y, vx, q, w] of nappes) {
                    const n = traceStream(x, y, vx, 0, q, w, stopIn, false);
                    drawStream(n, liq, Math.abs(vx), false);
                }
                ctx.restore();
            }
            ctx.save();
            ctx.clip(outline);
            for (const ch of cv.chains) {
                if (!(Math.abs(ch.sJ) > Q_MIN)) continue;
                const q = Math.abs(ch.sJ), v = Math.max(0.2, ch.jv);
                const px = st.x + c * ch.jx - s * ch.jy, py = st.y + s * ch.jx + c * ch.jy;
                let nx = c * ch.jnx - s * ch.jny, ny = s * ch.jnx + c * ch.jny;
                const nl = Math.hypot(nx, ny) || 1;
                nx /= nl; ny /= nl;
                const w0 = q / v;
                if (ch.sJ < 0) {
                    if (py > surfaceAt(px) + 0.25 * CELL) outStreams.push([px, py, nx * v, ny * v, q, w0]);
                    continue;
                }
                // (into trapped air the liquid only creeps in as the air bubbles out: no jet)
                if (!cv.vented) continue;
                const L = cavityLevelAt(cv, px);
                if (cv.V <= 0 || py > L + 0.25 * CELL) {
                    const n = traceStream(px, py, -nx * v, -ny * v, q, w0, stopIn, false);
                    drawStream(n, liq, v, false);
                } else if (-ny > 0.3) {
                    // (a jet mixing into still liquid slows roughly as its width over the distance)
                    const D = (L - py) / -ny;
                    const vs = 0.9 * v * Math.min(1, 3 * w0 / Math.max(D, 1e-3));
                    if (vs * vs / (2 * g) > 0.003) {
                        const ws = Math.min(3 * w0, w0 * v / vs);
                        const n = traceStream(px - nx * D, L - 0.3 * CELL, -nx * vs, -ny * vs, q, ws, () => false, true);
                        drawStream(n, liq, vs, true);
                    }
                }
            }
            ctx.restore();
        }
    }

    // streams leaving the object, on top of it, down to where they land
    function drawOutStreams() {
        landings.length = 0;
        if (!outStreams.length) return;
        const liq = LIQUIDS[settings.liquid];
        const stop = (x, y) => y <= Math.max(0, surfaceAt(x)) || x < 0 || x > TANK_W;
        for (const [x, y, vx, vy, q, w] of outStreams) {
            const n = traceStream(x, y, vx, vy, q, w, stop, false);
            drawStream(n, liq, Math.hypot(vx, vy), false);
            if (n > 1 && rbY[n - 1] <= surfaceAt(rbX[n - 1]) + 0.01) landings.push(rbX[n - 1], q);
        }
    }

    function ensureGradients() {
        const key = cssW + 'x' + cssH + 'x' + dpr + settings.liquid + (pal.dark ? 'd' : 'l');
        if (key === gradientKey) return;
        gradientKey = key;
        const liq = LIQUIDS[settings.liquid];
        const k = pal.dark ? 1 : 0.85;
        const tint = 'rgba(' + liq.top.join(',') + ',' + (pal.dark ? 0.16 : 0.14) + ')';
        const make = (g, s) => {
            const bg = g.createLinearGradient(0, 0, 0, cssH * s);
            bg.addColorStop(0, pal.bgTop);
            bg.addColorStop(1, pal.bgBot);
            const lg = g.createLinearGradient(0, cssH * 0.2 * s, 0, cssH * s);
            lg.addColorStop(0, 'rgba(' + liq.top.join(',') + ',' + (liq.aTop * k) + ')');
            lg.addColorStop(1, 'rgba(' + liq.bottom.join(',') + ',' + (liq.aBot * k) + ')');
            return [bg, lg];
        };
        [bgGradient, liquidGradient] = make(ctx, 1);
        // The tank's liquid is the background, the liquid gradient and a tint, layered. Liquid held in
        // the object and its streams are filled with that result in one opaque layer: layered fills
        // do not blend cleanly at anti-aliased edges (where two meet a dark seam shows).
        const H = Math.max(1, Math.round(cssH * dpr));
        if (liquidColumn.height !== H) { liquidColumn.width = 1; liquidColumn.height = H; }
        const g = liquidColumn.getContext('2d');
        const [bg, lg] = make(g, dpr);
        g.globalCompositeOperation = 'copy';
        g.fillStyle = bg; g.fillRect(0, 0, 1, H);
        g.globalCompositeOperation = 'source-over';
        g.fillStyle = lg; g.fillRect(0, 0, 1, H);
        g.fillStyle = tint; g.fillRect(0, 0, 1, H);
        liquidPattern = ctx.createPattern(liquidColumn, 'repeat-x');
        if (liquidPattern && liquidPattern.setTransform && typeof DOMMatrix === 'function') {
            liquidPattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
        } else liquidPattern = null;
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
        // the surface curve (surfaceAt): Catmull-Rom between the column samples, as Bezier segments
        const ys = (j) => wy(level + eta[j < 0 ? -1 - j : (j >= NCOL ? 2 * NCOL - 1 - j : j)]);
        const dx3 = DXC * scale / 3;
        liqPath.moveTo(0, cssH);
        const yE = wy(surfaceAt(0));
        liqPath.lineTo(0, yE); surf.moveTo(0, yE);
        liqPath.lineTo(wx(0.5 * DXC), ys(0)); surf.lineTo(wx(0.5 * DXC), ys(0));
        for (let j = 0; j < NCOL - 1; j++) {
            const x1 = wx((j + 0.5) * DXC), x2 = x1 + 3 * dx3;
            const y1 = ys(j), y2 = ys(j + 1);
            const c1y = y1 + (y2 - ys(j - 1)) / 6, c2y = y2 - (ys(j + 2) - y1) / 6;
            liqPath.bezierCurveTo(x1 + dx3, c1y, x2 - dx3, c2y, x2, y2);
            surf.bezierCurveTo(x1 + dx3, c1y, x2 - dx3, c2y, x2, y2);
        }
        const yN = wy(surfaceAt(TANK_W));
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
            drawBody(0);
        }

        // translucent liquid over submerged parts + surface line
        ctx.fillStyle = 'rgba(' + liq.top.join(',') + ',' + (pal.dark ? 0.16 : 0.14) + ')';
        ctx.fill(liqPath);
        ctx.strokeStyle = liq.surface;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 1.5;
        ctx.stroke(surf);
        ctx.globalAlpha = 1;
        if (mode === 'sim' && body) drawBody(1);
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
        // bubbles
        if (nBubbles) {
            ctx.beginPath();
            for (let i = 0; i < nBubbles; i++) {
                const x = wx(bX[i]), y = wy(bY[i]), r = Math.max(1.2, bR[i] * scale);
                ctx.moveTo(x + r, y);
                ctx.arc(x, y, r, 0, Math.PI * 2);
            }
            ctx.fillStyle = 'rgba(255,255,255,0.18)';
            ctx.fill();
            ctx.strokeStyle = liq.surface;
            ctx.globalAlpha = 0.8;
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.globalAlpha = 1;
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
            else if (!pointer.down) drawPrediction();
        }
    }

    // pass 0: solid material (drawn before the liquid tint); pass 1: air pockets, liquid held
    // inside open cavities and outlines (drawn after the tint and waterline)
    function drawBody(pass) {
        const B = body;
        renderBodyImage(B);
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
        // open cavities cover the tank's waterline and tint: dry inside, or their own liquid
        if (B.cavs.length) drawCavities();
        ctx.save();
        ctx.translate(X, Y);
        ctx.rotate(-st.th);
        if (B.hasSealed) ctx.drawImage(B.airImg, ix, iy, iw, ih);
        ctx.drawImage(B.lineImg, ix, iy, iw, ih);
        ctx.restore();
        // streams pouring out of the object
        if (B.cavs.length) drawOutStreams();
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

    // Weight and buoyancy as shown. Held liquid that sits below the outside surface is counted as
    // part of the tank: its weight and the buoyancy on it cancel exactly (same size, same point),
    // so leaving both out changes no force or torque. A flooded hull then shows the weight of its
    // material and a buoyancy that has dropped, while liquid held up above the surface (a boat
    // lifted out full) adds to the weight. The physics itself uses the full mass and buoyancy.
    const fv = { W: 0, cx: 0, cy: 0, fbX: 0, fbY: 0, bx: 0, by: 0, carried: 0 };
    function forceView() {
        const B = body;
        const g = settings.gravity, rhoL = LIQUIDS[settings.liquid].rho;
        let As = 0, ax = 0, ay = 0;
        if (B.cavs.length && B.waterMass > 0) {
            const c = Math.cos(st.th), s = Math.sin(st.th);
            setCellGeometry(c, s);
            setCorners(c, s);
            for (const cv of B.cavs) {
                if (cv.V <= 0) continue;
                const lim = Math.min(cv.h, surfaceAt(cv.xs));
                const top = lim + gExt, Y = cv.Y;
                for (let k = 0; k < cv.nc; k++) {
                    const tt = top - Y[k];
                    if (tt <= 0) continue;
                    const bi = cv.cells[k];
                    let px = st.x + c * B.ox[bi] - s * B.oy[bi], py = Y[k], a;
                    if (tt >= gE2) a = CELL_A;
                    else { clipCell(lim - Y[k], 0); a = clipA; px += clipCX; py += clipCY; }
                    As += a; ax += a * px; ay += a * py;
                }
            }
        }
        const m = B.mass + B.waterMass;
        const mw = Math.min(rhoL * DEPTH * As, B.waterMass);
        const [cx, cy] = comWorld();
        const ms = m - mw;
        fv.W = ms * g;
        fv.cx = mw > 0 ? (m * cx - mw * ax / As) / ms : cx;
        fv.cy = mw > 0 ? (m * cy - mw * ay / As) / ms : cy;
        fv.fbX = disp.fbX;
        fv.fbY = disp.fbY - mw * g;
        const sa = phys.subA - mw / (rhoL * DEPTH);
        if (mw > 0 && sa > 1e-6) {
            fv.bx = (phys.subA * phys.cobX - ax) / sa;
            fv.by = (phys.subA * phys.cobY - ay) / sa;
        } else { fv.bx = phys.cobX; fv.by = phys.cobY; }
        fv.carried = B.waterMass - mw;
    }

    function drawForces() {
        const B = body;
        forceView();
        const weight = fv.W;
        const kPx = (0.17 * cssH) / Math.max((B.mass + B.waterMass) * settings.gravity, 1e-6);
        const maxLen = 0.42 * cssH;
        const cx = wx(fv.cx), cy = wy(fv.cy);
        const A = settings.arrows;
        if (A.buoyancy && disp.sub > 0) {
            drawArrow(wx(fv.bx), wy(fv.by), fv.fbX, fv.fbY, ARROWS.buoyancy.color, kPx, maxLen);
        }
        if (A.weight) drawArrow(cx, cy, 0, -weight, ARROWS.weight.color, kPx, maxLen);
        if (A.drag) drawArrow(cx, cy, disp.fdX, disp.fdY, ARROWS.drag.color, kPx, maxLen);
        if (A.contact && disp.hasContact > 0.05) drawArrow(wx(disp.cpx), wy(disp.cpy), disp.fcX, disp.fcY, ARROWS.contact.color, kPx, maxLen);
        if (A.net) drawArrow(cx, cy, disp.netX, disp.netY, ARROWS.net.color, kPx, maxLen);
        if (!legendVals.ok) storeLegendValues();
        const L = legendVals;
        const rows = [];
        const N = (v) => fmtAuto(v) + ' N';
        if (A.weight) rows.push([ARROWS.weight.color, 'Weight', N(L.weight)]);
        if (A.buoyancy) rows.push([ARROWS.buoyancy.color, 'Buoyancy', N(L.buoyancy)]);
        if (A.net) rows.push([ARROWS.net.color, 'Net force', N(L.net)]);
        if (A.drag) rows.push([ARROWS.drag.color, 'Drag', N(L.drag)]);
        if (A.contact) rows.push([ARROWS.contact.color, 'Contact', N(L.contact)]);
        if (B.cavs.length && L.carried > 0.01) {
            rows.push(['liquid', LIQUIDS[settings.liquid].name.replace('Fresh water', 'Water') + ' held up', fmtAuto(L.carried) + ' kg']);
        }

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
                const bx = wx(fv.bx), by = wy(fv.by);
                ctx.strokeStyle = pal.halo; ctx.lineWidth = 4;
                ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2); ctx.stroke();
                ctx.strokeStyle = ARROWS.buoyancy.color; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2); ctx.stroke();
            }
        }
        if (settings.markers) rows.push(['markers', 'Centre of mass / buoyancy', '']);
        if (rows.length) drawInfoBox(rows, '000.0 N');
    }

    // A small key in the top-left corner: [swatch] label ... value (values right-aligned in a
    // column as wide as `valueTemplate`, so changing numbers never shift anything)
    function drawInfoBox(rows, valueTemplate, right) {
        const fs = clamp(cssW / 70, 10, 13);
        ctx.font = fs + 'px "Source Sans Pro", Helvetica, sans-serif';
        const lineH = Math.round(fs * 1.4);
        let lw = 0, vw = valueTemplate ? ctx.measureText(valueTemplate).width : 0;
        for (const r of rows) {
            lw = Math.max(lw, ctx.measureText(r[1]).width);
            if (r[2]) vw = Math.max(vw, ctx.measureText(r[2]).width);
        }
        const pad = 7, sw = r0Swatch(rows) ? 18 : 0, gap = vw > 0 ? 10 : 0;
        const bw = pad * 2 + (sw ? sw + pad : 0) + lw + gap + vw, bh = rows.length * lineH + pad;
        const x0 = right ? Math.max(8, Math.floor(cssW - 8 - bw)) : 8, y0 = 8;
        ctx.fillStyle = pal.panel;
        ctx.strokeStyle = pal.panelBorder;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(x0 + 0.5, y0 + 0.5, Math.ceil(bw), Math.ceil(bh));
        ctx.fill(); ctx.stroke();
        ctx.textBaseline = 'middle';
        rows.forEach((r, i) => {
            const yy = y0 + pad / 2 + lineH * (i + 0.5);
            const sx = x0 + pad;
            if (r[0] === 'markers') {
                ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#111111'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.arc(sx + 4, yy, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                ctx.fillStyle = '#111111';
                ctx.beginPath(); ctx.moveTo(sx + 4, yy); ctx.arc(sx + 4, yy, 4, 0, Math.PI / 2); ctx.closePath(); ctx.fill();
                ctx.beginPath(); ctx.moveTo(sx + 4, yy); ctx.arc(sx + 4, yy, 4, Math.PI, Math.PI * 1.5); ctx.closePath(); ctx.fill();
                ctx.strokeStyle = ARROWS.buoyancy.color; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(sx + 14, yy, 3.5, 0, Math.PI * 2); ctx.stroke();
            } else if (r[0] === 'liquid') {
                const liq = LIQUIDS[settings.liquid];
                ctx.fillStyle = 'rgb(' + liq.top.join(',') + ')';
                ctx.fillRect(sx + 3, yy - 4, sw - 6, 8);
            } else if (r[0]) {
                ctx.strokeStyle = r[0]; ctx.lineWidth = 3;
                ctx.beginPath(); ctx.moveTo(sx, yy); ctx.lineTo(sx + sw, yy); ctx.stroke();
            }
            ctx.fillStyle = pal.text;
            ctx.textAlign = 'left';
            ctx.fillText(r[1], sx + (sw ? sw + pad : 0), yy + 0.5);
            if (r[2]) {
                ctx.textAlign = 'right';
                ctx.fillText(r[2], x0 + bw - pad, yy + 0.5);
            }
        });
        ctx.textAlign = 'left';
    }
    function r0Swatch(rows) { for (const r of rows) if (r[0]) return true; return false; }

    // draw mode: will the drawing float?
    function drawPrediction() {
        if (!predictionLines.length) return;
        drawInfoBox(predictionLines.map((t) => [null, t, '']), '', true);
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

    // labels along the bottom edge sit on the liquid, so they are light text with a dark halo in both themes
    const ON_LIQUID_TEXT = '#ffffff', ON_LIQUID_HALO = 'rgba(0,0,0,0.55)';

    function drawLiquidLabel(liq) {
        const fs = clamp(cssW / 60, 9, 13);
        ctx.font = fs + 'px "Source Sans Pro", Helvetica, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        const txt = liq.name + ' · ' + liq.rho.toLocaleString('en-US') + ' kg/m³';
        // bottom-right corner: clear of the overlay buttons that sit top-right on small screens
        const x = cssW - 8;
        const y = cssH - 6;
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = ON_LIQUID_HALO;
        ctx.strokeText(txt, x, y);
        ctx.fillStyle = ON_LIQUID_TEXT;
        ctx.fillText(txt, x, y);
    }

    function drawScaleBar() {
        const len = 0.1 * scale;
        const x = 10, y = cssH - 10;
        const fs = clamp(cssW / 70, 8, 12);
        ctx.font = fs + 'px "Source Sans Pro", Helvetica, sans-serif';
        for (let pass = 0; pass < 2; pass++) {
            ctx.strokeStyle = pass === 0 ? ON_LIQUID_HALO : ON_LIQUID_TEXT;
            ctx.lineWidth = pass === 0 ? 4 : 1.5;
            ctx.beginPath();
            ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 4);
            ctx.stroke();
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = ON_LIQUID_HALO;
        ctx.strokeText('10 cm', x + len + 5, y + 2);
        ctx.fillStyle = ON_LIQUID_TEXT;
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
    const lastTxt = new Map();
    function setText(node, t) {
        if (!node || lastTxt.get(node) === t) return;
        lastTxt.set(node, t);
        node.textContent = t;
    }
    // read-out numbers: fixed decimals by size, no thousands separators (the boxes reserve a width)
    function fmtR(v) {
        if (!isFinite(v)) return '-';
        const a = Math.abs(v);
        return v.toFixed(a < 9.995 ? 2 : (a < 99.95 ? 1 : 0));
    }
    let predictionLines = [];
    // Force values for the on-canvas key, refreshed together with the info bar so the two always
    // agree and the key's numbers don't flicker every frame while the object bobs.
    const legendVals = { ok: false, weight: 0, buoyancy: 0, net: 0, drag: 0, contact: 0, carried: 0 };
    function storeLegendValues() {
        legendVals.ok = true;
        legendVals.weight = fv.W;
        legendVals.buoyancy = Math.hypot(fv.fbX, fv.fbY);
        legendVals.net = Math.hypot(disp.netX, disp.netY);
        legendVals.drag = Math.hypot(disp.fdX, disp.fdY);
        legendVals.contact = Math.hypot(disp.fcX, disp.fcY);
        legendVals.carried = fv.carried;
    }
    function updateStatsDisplay(force) {
        const now = performance.now();
        if (!force && now - lastStatsT < 200) return;
        lastStatsT = now;
        const P = mode === 'sim' ? body : preview;
        const liq = LIQUIDS[settings.liquid];
        const g = settings.gravity;
        if (!P) {
            predictionLines = [];
            if (!el.mass) return;
            setText(el.mass, '–'); setText(el.volume, '–'); setText(el.density, '–');
            setText(el.submerged, '–'); setText(el.weight, '–'); setText(el.buoyancy, '–');
            return;
        }
        const V = (P.areaMat + P.areaSealed) * DEPTH;
        const M = P.mass;
        const rho = M / V;
        predictionLines = predictionText(P, liq, rho, V, M, g);
        if (!el.mass) return;
        setText(el.mass, fmtR(M));
        setText(el.volume, fmtR(V * 1000));
        setText(el.density, rho.toFixed(0));
        if (mode === 'sim') {
            forceView();
            storeLegendValues();
            setText(el.weight, fmtR(fv.W));
            setText(el.submerged, (100 * clamp(disp.sub, 0, 1)).toFixed(0));
            setText(el.buoyancy, fmtR(legendVals.buoyancy));
        } else {
            legendVals.ok = false;
            setText(el.weight, fmtR(M * g));
            setText(el.submerged, '–');
            setText(el.buoyancy, '–');
        }
    }

    // "Will it float?" for the drawing: a few short lines shown on the tank while drawing
    function predictionText(P, liq, rho, V, M, g) {
        const rl = liq.rho;
        const r0 = fmt(rho, 0), rL = rl.toLocaleString('en-US');
        const lines = [fmtAuto(M) + ' kg \u00f7 ' + fmtAuto(V * 1000) + ' L = ' + r0 + ' kg/m\u00b3  (' +
            liq.name.toLowerCase() + ': ' + rL + ')'];
        if (rho < rl) {
            lines.push('\u2192 should float, about ' + fmt(100 * rho / rl, 0) + '% submerged');
            return lines;
        }
        const Vh = V + P.areaBasin * DEPTH;
        if (P.areaBasin > 0 && M / Vh < rl) {
            lines.push('With the air in its hull: ' + fmt(M / Vh, 0) + ' kg/m\u00b3');
            lines.push('\u2192 should float like a boat until liquid gets in');
            return lines;
        }
        let t = '\u2192 should sink; in the liquid it weighs ' + fmtAuto((M - rl * V) * g) + ' N, not ' + fmtAuto(M * g) + ' N';
        lines.push(t);
        if (P.areaOpen - P.areaBasin > 0.15 * (P.areaMat + P.areaSealed)) lines.push('(unless it traps air underneath)');
        return lines;
    }

    function setHint(text) {
        if (el.hint) { el.hint.textContent = text; lastTxt.set(el.hint, text); }
        hintHold = performance.now() + 3500;
    }
    let hintHold = 0;
    function refreshHint() {
        if (!el.hint || performance.now() < hintHold) return;
        let title, body;
        if (mode === 'sim') {
            title = 'Simulating';
            body = 'Drag the object to lift or throw it; tap the liquid for waves. Pick a tool to draw again.';
        } else {
            const m = MATERIALS[settings.material];
            const fine = pointer.type === 'mouse';
            const tips = {
                brush: fine ? 'Drag to paint (right-click erases).' : 'Drag to paint.',
                eraser: 'Drag to erase.',
                rect: fine ? 'Drag out a solid rectangle (Shift: square).' : 'Drag out a solid rectangle.',
                box: 'Drag out a hollow box; its wall is the size.',
                ellipse: fine ? 'Drag out a solid ellipse (Shift: circle).' : 'Drag out a solid ellipse.',
                ring: 'Drag out a hollow ring; its wall is the size.',
                fill: 'Tap inside a closed outline to fill it.'
            };
            title = settings.tool === 'eraser' ? 'Eraser' : m.name + ', ' + m.rho.toLocaleString('en-US') + ' kg/m\u00b3';
            body = tips[settings.tool] + ' Then press Drop.';
        }
        const key = title + '|' + body;
        if (lastTxt.get(el.hint) === key) return;
        lastTxt.set(el.hint, key);
        el.hint.innerHTML = '';
        const st = document.createElement('strong');
        st.textContent = title + ': ';
        el.hint.appendChild(st);
        el.hint.appendChild(document.createTextNode(body));
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
            // grab tolerance in screen pixels: a finger needs more than a mouse
            const tol = (pointer.type === 'mouse' ? 6 : 20) / scale;
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
            else if (pointer.type === 'mouse') canvas.style.cursor = hitBody(x, y, 6 / scale) ? 'grab' : 'default';
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
        if (dropBtn) {
            dropBtn.setAttribute('aria-pressed', mode === 'sim' ? 'true' : 'false');
            dropBtn.title = mode === 'sim' ? 'Drop the object again from where it was drawn' : 'Drop the object into the liquid';
        }
        if (editBtn) editBtn.setAttribute('aria-pressed', mode === 'sim' ? 'false' : 'true');
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
        if (body) updateWaterMass(body);
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
                b.title = m.name + ' (' + m.rho.toLocaleString('en-US') + ' kg/m³)';
                b.setAttribute('aria-label', b.title);
                b.innerHTML = '<span class="buoy-swatch" style="background:' + m.color + '"></span>';
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
        const sizeEl = document.getElementById('brushSize');
        if (sizeEl) {
            sizeEl.innerHTML = '';
            BRUSH_SIZES.forEach((cm, i) => {
                const o = document.createElement('option');
                o.value = String(i); o.textContent = cm + ' cm';
                sizeEl.appendChild(o);
            });
            sizeEl.value = String(settings.brushIndex);
            sizeEl.addEventListener('change', () => {
                settings.brushIndex = clamp(parseInt(sizeEl.value, 10) || 0, 0, BRUSH_SIZES.length - 1);
                if (mode === 'sim') enterEditMode();
            });
        }
        const on = (id, fn) => { const n = document.getElementById(id); if (n) n.addEventListener('click', fn); };
        on('dropBtn', () => dropObject());
        on('editBtn', () => { if (mode === 'sim') enterEditMode(); });
        on('clearBtn', () => { pushUndo(); grid.fill(0); enterEditMode(); setHint('Cleared: pick a material and draw a new object (or undo)'); });
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
        const gName = document.getElementById('gravityName');
        const showGravityName = (x) => {
            let nm = '';
            for (const [gv, n] of [[1.62, 'Moon'], [3.71, 'Mars'], [9.81, 'Earth'], [24.79, 'Jupiter']]) if (Math.abs(x - gv) < 0.06) nm = n;
            if (gName && gName.textContent !== nm) gName.textContent = nm;
        };
        bindRange('gravitySlider', 'gravityVal', () => settings.gravity, (x) => {
            // snap to the named values so Earth, the Moon etc. are easy to hit
            for (const gv of [1.62, 3.71, 9.81, 24.79]) if (Math.abs(x - gv) < 0.12) x = gv;
            settings.gravity = x;
            updateWaveCoefficients();
            updateStatsDisplay(true);
        }, (x) => { showGravityName(x); return x.toFixed(2); });
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
                stepParticles(steps * DT);
                stepBubbles(steps * DT);
                stepCavityVisuals(steps * DT);
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
            if (nBubbles) stepBubbles(dtReal);
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
        loadPreset('pine');
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
            const n = document.getElementById('rotationToggle');
            if (n) { n.checked = !!v; n.dispatchEvent(new Event('change')); }
        },
        setGravity(v) { settings.gravity = v; updateWaveCoefficients(); },
        setSpeed(v) { settings.speed = v; },
        setLiquidDepth(m) { settings.liquidDepth = m; if (mode === 'draw') level = drawModeLevel(preview); },
        setArrows(o) { Object.assign(settings.arrows, o); },
        fillRect(c, r, w, h, matKey) { fillRect(c, r, w, h, matKey ? (MAT_ID[matKey] || 0) : 0); drawDirty = true; if (mode === 'sim') enterEditMode(); },
        clearGrid() { grid.fill(0); drawDirty = true; if (mode === 'sim') enterEditMode(); },
        advance(seconds) { return simulate(seconds); },
        _poke(x, strength) { if (mode === 'sim') pokeLiquid(x, strength || 0.006); },
        setPose(x, y, theta, vx, vy, omega) {
            if (x !== undefined && x !== null) st.x = x;
            if (y !== undefined && y !== null) st.y = y;
            if (theta !== undefined && theta !== null) st.th = theta;
            st.vx = vx || 0; st.vy = vy || 0; st.om = omega || 0;
        },
        cavityInfo() {
            if (!body || !body.cavs.length) return null;
            return {
                cavities: body.cavs.map((cv) => ({
                    cells: cv.nc, faces: cv.nf, area: cv.area, held: cv.V, fill: cv.V / cv.area,
                    level: cv.h, surfaceWidth: cv.Ws, qIn: cv.qIn, qOut: cv.qOut, vented: cv.vented,
                    slosh: cv.phi, xs: cv.xs, bubbling: cv.bubQ,
                    // drawn streams (smoothed, + in, - out): over the lips, or as a jet
                    stream: cv.chains.reduce((a, ch) => a + ch.sA + ch.sB + ch.sJ, 0),
                    openings: cv.chains.map((ch) => ({
                        faces: ch.nf, lips: ch.lips, qIn: ch.qI, qOut: ch.qO, overLips: ch.lipMode,
                        lipA: ch.sA, lipB: ch.sB, jet: ch.sJ, jetSpeed: ch.jv
                    }))
                })),
                heldTotal: body.waterArea, heldMass: body.waterMass
            };
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
                forceView();
                out.weightShown = fv.W; out.buoyancyShown = Math.hypot(fv.fbX, fv.fbY); out.waterHeldUp = fv.carried;
                out.contactForce = [phys.fcX, phys.fcY];
                out.dragForce = [phys.fdX, phys.fdY];
                out.cob = [phys.cobX, phys.cobY];
            }
            return out;
        },
        getPerf() {
            return { fps: perf.fps, frameMs: perf.frameMs, physMs: perf.physMs, renderMs: perf.renderMs, substepsPerFrame: perf.substeps, frames: perf.frames };
        },
        _internals: { settings, MATERIALS, LIQUIDS, grid, GW, GH, CELL, body: () => body, surfaceAt }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
