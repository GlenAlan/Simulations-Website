// Charges in Fields: charged particles in uniform electric and magnetic fields.
//
// Physics in SI units. The field box is 10 cm long; the plates hold up to 1 kV and launches go up to 2 kV, so even
// electrons stay below 0.09c and the motion is Newtonian. Particles move in short drift-kick-drift substeps with a
// Boris kick, which keeps a particle's speed exact in a magnetic field. Gravity is ignored (qE is ~1e11 times mg).
//
// World coordinates are metres, x to the right and y up. The box runs from x = 0 to PLATE_L, centred on y = 0; the
// plates sit at y = +-gap/2 and the magnetic field fills x = 0..PLATE_L, |y| <= MAG_HALF. Outside the box there is
// no field. Slow motion is automatic: each particle type has a playback rate that takes a 500 V launch across the
// box in about 2.4 s, and every time shown is the real (simulated) time.
//
// Layout of this file: the core first, then one marked section per feature. A feature pushes an object onto
// `features`; the core calls any of these hooks it has, in order of registration:
//   init(), reset(), onSettings(), onSetup(name), frame(realDt, simDt),
//   drawUnder() (under the fields), drawMid() (over the plates, under the trails), drawOver() (on top),
//   pointerDown(w, e) / pointerMove(w, e) / pointerUp(w, e) -> true when it took the event
//     (w = { x, y } in metres and { cx, cy } in canvas CSS px),
//   hover(w) -> a CSS cursor when it wants one, keydown(e) -> true when it took the key,
//   fire() -> true when it took the shot, obstacles(list) to add collision segments.
// Launchers register in `launchers` (the accelerator is here; the slingshot is in its section).
(function () {
    'use strict';

    const canvas = document.getElementById('simulationCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (!canvas || !ctx) {
        console.error('Simulation canvas not found.');
        return;
    }
    const $ = (id) => document.getElementById(id);
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // ===================================================================== Constants
    const E_CHARGE = 1.602176634e-19; // C
    const M_PROTON = 1.67262192e-27;  // kg
    const M_ELECTRON = 9.1093837e-31;
    const M_ALPHA = 6.6446573e-27;
    const M_NEUTRON = 1.6749275e-27;
    const U_MASS = 1.66053907e-27;

    const PLATE_L = 0.10;     // Length of the plates and of the field box (m)
    const MAG_HALF = 0.045;   // Half-height of the magnetic field region (m)
    const GUN_L = 0.012;      // Length of the accelerator (m)
    const VIEW_W = 0.19;      // World area always in view (m), centred on the box
    const VIEW_H = 0.095;
    const VIEW_CX = PLATE_L / 2;
    const REF_V = 500;        // Launch voltage that sets each particle type's playback rate (V)
    const FLIGHT_S = 2.4;     // Real seconds a REF_V launch takes to cross the box
    const STROBE_S = 0.1;     // Real seconds between strobe dots
    const MAX_STEP = 0.0002;  // Longest substep (m)
    const B_MIN = 1e-4;       // Magnetic slider range (T), log scale
    const B_MAX = 0.5;
    const GAP_MIN = 0.02;     // Plate gap range (m)
    const GAP_MAX = 0.08;
    const MAX_PARTICLES = 30;
    const TRAIL_MAX = 800;    // Strobe dots kept per particle
    const AIM_PX = 40;        // Length of the accelerator's aim handle (CSS px)

    // Charge in units of e
    const PARTICLE_TYPES = {
        proton: { name: 'Proton', q: 1, m: M_PROTON },
        electron: { name: 'Electron', q: -1, m: M_ELECTRON },
        alpha: { name: 'Alpha particle', q: 2, m: M_ALPHA },
        neutron: { name: 'Neutron', q: 0, m: M_NEUTRON },
        custom: { name: 'Custom particle', q: 1, m: M_PROTON }, // Charge and mass set in More options
    };

    function particleType(key) {
        return PARTICLE_TYPES[key] || PARTICLE_TYPES.proton;
    }

    function chargeLabel(q) {
        if (q === 0) return '0';
        const sign = q > 0 ? '+' : '−';
        return Math.abs(q) === 1 ? sign : `${Math.abs(q)}${sign}`;
    }

    // ===================================================================== Settings and state
    const settings = {
        setup: 'free',         // 'free' or 'thomson'
        field: 'E',            // 'E', 'B' or 'both'
        plateV: 500,           // V across the plates
        plusTop: true,         // Positive plate on top, so the field points down
        B: 0.2,                // T
        bOut: false,           // false: into the page (crosses), true: out of it (dots)
        gap: 0.05,             // m
        launchV: 500,          // V
        particle: 'proton',
        launcher: 'accelerator',
        playback: 1,
        lockGeometry: false,   // A setup that fixes the plates and the launcher in place sets this
        allowDrop: true,       // Tapping the canvas drops a charge at rest
        show: { velocity: true, force: true, components: false, rhr: false, grid: false, equip: false, values: false, aimGuide: false },
    };

    let particles = [];
    let marks = [];            // Glowing marks where particles hit a plate or left the view
    let selected = null;
    let nextId = 1;
    let paused = false;
    let simClock = 0;          // Simulated seconds since the start
    let interacted = false;    // Hides the first-use hint
    let rateOverride = null;   // A particle type whose playback rate is used instead of the selected one's
    let hintOverride = null;   // Text for the hint line instead of the default (an empty string hides it)
    const features = [];
    const launchers = {};

    function callFeatures(hook, ...args) {
        for (const f of features) if (typeof f[hook] === 'function') f[hook](...args);
    }

    function askFeatures(hook, ...args) {
        for (const f of features) if (typeof f[hook] === 'function' && f[hook](...args)) return f;
        return null;
    }

    // ===================================================================== Fields
    function eActive() { return settings.field === 'E' || settings.field === 'both'; }
    function bActive() { return settings.field === 'B' || settings.field === 'both'; }
    function platesPresent() { return eActive(); }
    function eFieldY() { return (settings.plusTop ? -1 : 1) * settings.plateV / settings.gap; } // V/m
    function bFieldZ() { return (settings.bOut ? 1 : -1) * settings.B; }                         // T
    function insideE(x, y) { return eActive() && x >= 0 && x <= PLATE_L && Math.abs(y) < settings.gap / 2; }
    function insideB(x, y) { return bActive() && x >= 0 && x <= PLATE_L && Math.abs(y) <= MAG_HALF; }

    function fieldAt(x, y, out) {
        out.ey = insideE(x, y) ? eFieldY() : 0;
        out.bz = insideB(x, y) ? bFieldZ() : 0;
        return out;
    }

    // Net force on a particle where it is now: electric (0, fey) and magnetic (fbx, fby), in N
    function forcesOn(p) {
        const f = fieldAt(p.x, p.y, { ey: 0, bz: 0 });
        if (p.state === 'gun') {
            const a = p.qe === 0 ? 0 : (p.vExit * p.vExit) / (2 * GUN_L);
            return { fex: p.ux * p.m * a, fey: p.uy * p.m * a, fbx: 0, fby: 0, inField: a > 0 };
        }
        return {
            fex: 0,
            fey: p.q * f.ey,
            fbx: p.q * p.vy * f.bz,
            fby: -p.q * p.vx * f.bz,
            inField: f.ey !== 0 || f.bz !== 0,
        };
    }

    // ===================================================================== Particles
    // Speed after a launch through `volts`. A neutral particle can't be accelerated by a voltage; it leaves at the
    // speed a singly charged particle of the same mass would have.
    function launchSpeedFor(q, m, volts) {
        const qa = Math.abs(q) || 1;
        return Math.sqrt(2 * qa * E_CHARGE * Math.max(0, volts) / m);
    }

    function refSpeedFor(q, m) {
        return launchSpeedFor(q, m, REF_V);
    }

    function rateFor(key) {
        const t = particleType(key);
        return PLATE_L / refSpeedFor(t.q, t.m) / FLIGHT_S;
    }

    // Simulated seconds per real second
    function currentRate() {
        return rateFor(rateOverride || settings.particle) * settings.playback;
    }

    function makeParticle(key, x, y) {
        const t = particleType(key);
        return {
            id: nextId++,
            type: key,
            name: t.name,
            qe: t.q,
            q: t.q * E_CHARGE,
            m: t.m,
            label: chargeLabel(t.q),
            x, y, vx: 0, vy: 0,
            state: 'free',           // 'gun' (in the accelerator), 'free', 'stopped' (hit something) or 'gone' (left the view)
            t: 0,                    // Simulated seconds since launch
            strobeDt: STROBE_S * currentRate(),
            nextStrobe: 0,
            trail: [],               // Strobe dots: x0, y0, x1, y1, ...
            born: simClock,
            hitWhat: null,
            speedAtEnd: 0,
        };
    }

    function addParticle(p, opts = {}) {
        particles.push(p);
        recordStrobe(p);
        if (opts.select !== false) selected = p;
        if (!opts.quiet) interacted = true;
        while (particles.length > MAX_PARTICLES) {
            const i = particles.findIndex((q) => q !== selected);
            if (i < 0) break;
            particles.splice(i, 1);
        }
        return p;
    }

    function recordStrobe(p) {
        const tr = p.trail;
        const n = tr.length;
        p.nextStrobe += p.strobeDt;
        // A particle at rest adds no new dots
        if (n >= 2 && Math.abs(tr[n - 2] - p.x) < 1e-7 && Math.abs(tr[n - 1] - p.y) < 1e-7) return;
        tr.push(p.x, p.y);
        if (tr.length > TRAIL_MAX * 2) tr.splice(0, 2);
    }

    function strobeDue(p) {
        return p.t >= p.nextStrobe - p.strobeDt * 1e-6;
    }

    function dropAt(x, y, key = settings.particle) {
        return addParticle(makeParticle(key, x, y));
    }

    // ===================================================================== Motion
    // Inside the accelerator a particle moves along the barrel with constant acceleration v^2/(2L), which is
    // qV/(mL): it leaves the muzzle at exactly the launch speed. Returns the simulated time left over.
    function advanceGun(p, dt) {
        const a = p.qe === 0 ? 0 : (p.vExit * p.vExit) / (2 * GUN_L);
        let guard = 0;
        while (dt > 0 && p.state === 'gun' && guard++ < 10000) {
            if (strobeDue(p)) recordStrobe(p);
            const h = Math.min(dt, p.nextStrobe - p.t);
            const remain = GUN_L - p.gs;
            const tExit = a > 0 ? (-p.gv + Math.sqrt(p.gv * p.gv + 2 * a * remain)) / a : remain / p.gv;
            if (tExit <= h) {
                p.t += tExit;
                dt -= tExit;
                p.state = 'free';
                p.x = p.bx + p.ux * GUN_L;
                p.y = p.by + p.uy * GUN_L;
                p.vx = p.ux * p.vExit;
                p.vy = p.uy * p.vExit;
                return dt;
            }
            p.gs += p.gv * h + 0.5 * a * h * h;
            p.gv += a * h;
            p.t += h;
            dt -= h;
            p.x = p.bx + p.ux * p.gs;
            p.y = p.by + p.uy * p.gs;
            p.vx = p.ux * p.gv;
            p.vy = p.uy * p.gv;
        }
        return 0;
    }

    // Boris kick: half the electric push, a rotation by the magnetic field, then the other half
    function kick(p, qm, ey, bz, h) {
        const half = qm * ey * h / 2;
        let vx = p.vx;
        let vy = p.vy + half;
        if (bz !== 0) {
            const t = qm * bz * h / 2;
            const s = 2 * t / (1 + t * t);
            const ux = vx + vy * t;
            const uy = vy - vx * t;
            vx += uy * s;
            vy -= ux * s;
        }
        p.vx = vx;
        p.vy = vy + half;
    }

    const fTmp = { ey: 0, bz: 0 };
    let obstaclesNow = [];

    function advanceFree(p, dt) {
        const qm = p.m > 0 ? p.q / p.m : 0;
        const eMax = eActive() ? Math.abs(eFieldY()) : 0;
        const bMax = bActive() ? settings.B : 0;
        let guard = 0;
        while (dt > 0 && p.state === 'free' && guard++ < 50000) {
            if (strobeDue(p)) recordStrobe(p);
            const speed = Math.hypot(p.vx, p.vy);
            let h = Math.min(dt, p.nextStrobe - p.t);
            if (speed > 0) h = Math.min(h, MAX_STEP / speed);
            const acc = Math.abs(qm) * (eMax + speed * bMax);
            if (acc > 0) h = Math.min(h, Math.sqrt(2 * MAX_STEP / acc));
            if (bMax > 0 && qm !== 0) h = Math.min(h, 0.02 / (Math.abs(qm) * bMax));
            if (!(h > 0)) h = dt;
            const x0 = p.x;
            const y0 = p.y;
            p.x += p.vx * h / 2;
            p.y += p.vy * h / 2;
            fieldAt(p.x, p.y, fTmp);
            if (qm !== 0 && (fTmp.ey !== 0 || fTmp.bz !== 0)) kick(p, qm, fTmp.ey, fTmp.bz, h);
            p.x += p.vx * h / 2;
            p.y += p.vy * h / 2;
            p.t += h;
            dt -= h;
            if (collide(p, x0, y0)) break;
            if (leaveView(p, x0, y0)) break;
        }
        if (p.state === 'free' && strobeDue(p)) recordStrobe(p);
    }

    function advanceParticle(p, dt) {
        if (p.state === 'gun') dt = advanceGun(p, dt);
        if (p.state === 'free' && dt > 0) advanceFree(p, dt);
    }

    function advanceAll(simDt) {
        obstaclesNow = obstacleList();
        for (const p of particles) advanceParticle(p, simDt);
        simClock += simDt;
    }

    // ===================================================================== Collisions
    function obstacleList() {
        const list = [];
        if (platesPresent()) {
            const y = settings.gap / 2;
            const topName = settings.plateV > 0 ? (settings.plusTop ? 'positive plate' : 'negative plate') : 'upper plate';
            const botName = settings.plateV > 0 ? (settings.plusTop ? 'negative plate' : 'positive plate') : 'lower plate';
            list.push({ x0: 0, y0: y, x1: PLATE_L, y1: y, name: topName });
            list.push({ x0: 0, y0: -y, x1: PLATE_L, y1: -y, name: botName });
        }
        callFeatures('obstacles', list);
        return list;
    }

    // Where along a->b the path crosses segment o (0..1), or -1
    function segmentHit(ax, ay, bx, by, o) {
        const rx = bx - ax;
        const ry = by - ay;
        const sx = o.x1 - o.x0;
        const sy = o.y1 - o.y0;
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-30) return -1;
        const qx = o.x0 - ax;
        const qy = o.y0 - ay;
        const t = (qx * sy - qy * sx) / den;
        const u = (qx * ry - qy * rx) / den;
        return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
    }

    function collide(p, x0, y0) {
        let best = -1;
        let hit = null;
        for (const o of obstaclesNow) {
            const t = segmentHit(x0, y0, p.x, p.y, o);
            if (t >= 0 && (best < 0 || t < best)) {
                best = t;
                hit = o;
            }
        }
        if (!hit) return false;
        endParticle(p, x0 + (p.x - x0) * best, y0 + (p.y - y0) * best, 'stopped', hit.name, hit);
        return true;
    }

    function leaveView(p, x0, y0) {
        const r = viewRect;
        if (p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1) return false;
        const dx = p.x - x0;
        const dy = p.y - y0;
        let t = 1;
        if (p.x < r.x0 && dx < 0) t = Math.min(t, (r.x0 - x0) / dx);
        if (p.x > r.x1 && dx > 0) t = Math.min(t, (r.x1 - x0) / dx);
        if (p.y < r.y0 && dy < 0) t = Math.min(t, (r.y0 - y0) / dy);
        if (p.y > r.y1 && dy > 0) t = Math.min(t, (r.y1 - y0) / dy);
        t = clamp(t, 0, 1);
        endParticle(p, x0 + dx * t, y0 + dy * t, 'gone', 'edge', null);
        return true;
    }

    function endParticle(p, x, y, state, what, obstacle) {
        p.speedAtEnd = Math.hypot(p.vx, p.vy);
        p.x = x;
        p.y = y;
        p.state = state;
        p.hitWhat = what;
        if (p.ghost) return;
        p.trail.push(x, y);
        marks.push({ x, y, qe: p.qe, born: performance.now() });
        if (marks.length > 40) marks.shift();
        if (obstacle && typeof obstacle.onHit === 'function') obstacle.onHit(p);
        if (!p.quiet) announceEnd(p);
    }

    // ===================================================================== Prediction (aim guide)
    // The path a particle of type `key` would take from (x, y) with velocity (vx, vy), moved exactly as the real
    // ones are, until it hits something, leaves the view or about `realSeconds` of playback have passed.
    function predictPath(key, x, y, vx, vy, realSeconds = 6) {
        const t = particleType(key);
        const p = {
            ghost: true, qe: t.q, q: t.q * E_CHARGE, m: t.m, x, y, vx, vy,
            state: 'free', t: 0, strobeDt: Infinity, nextStrobe: Infinity, trail: [],
        };
        const saved = obstaclesNow;
        obstaclesNow = obstacleList();
        const pts = [x, y];
        const total = realSeconds * rateFor(key);
        const chunks = 240;
        for (let i = 0; i < chunks && p.state === 'free'; i++) {
            advanceFree(p, total / chunks);
            pts.push(p.x, p.y);
        }
        obstaclesNow = saved;
        return { points: pts, end: p.state, endX: p.x, endY: p.y };
    }

    // ===================================================================== View
    let viewW = 0;
    let viewH = 0;
    let dpr = 1;
    let scale = 1;  // CSS px per metre
    let ox = 0;     // Canvas position of the world origin (CSS px)
    let oy = 0;
    const viewRect = { x0: -0.045, x1: 0.145, y0: -0.0475, y1: 0.0475 }; // World area the canvas shows (m)

    function computeView() {
        scale = Math.min(viewW / VIEW_W, viewH / VIEW_H);
        ox = viewW / 2 - VIEW_CX * scale;
        oy = viewH / 2;
        viewRect.x0 = -ox / scale;
        viewRect.x1 = (viewW - ox) / scale;
        viewRect.y1 = oy / scale;
        viewRect.y0 = -(viewH - oy) / scale;
    }

    const px = (x) => ox + x * scale;
    const py = (y) => oy - y * scale;
    const wx = (cx) => (cx - ox) / scale;
    const wy = (cy) => (oy - cy) / scale;

    // ===================================================================== Drawing helpers
    function isDarkMode() {
        return document.documentElement.classList.contains('dark-mode');
    }

    function makePalette(dark) {
        return dark ? {
            bg: '#121417', text: '#e6e6e6', muted: 'rgba(230, 230, 230, 0.62)', faint: 'rgba(230, 230, 230, 0.25)',
            pos: '#ff6b6b', neg: '#5aa9ff', neutral: '#b8b8b8',
            eLine: 'rgba(255, 210, 110, 0.55)', bSym: 'rgba(190, 150, 255, 0.6)',
            magFill: 'rgba(150, 110, 255, 0.07)', magEdge: 'rgba(190, 150, 255, 0.4)',
            velocity: '#7bd0c1', forceE: '#ffa94d', forceB: '#d08cff',
            gunFill: '#2b3036', gunEdge: '#7d8792', ring: '#ffffff', glow: 'rgba(255, 255, 255, 0.9)',
        } : {
            bg: '#f7f8fa', text: '#2b2b2b', muted: 'rgba(40, 40, 40, 0.62)', faint: 'rgba(40, 40, 40, 0.22)',
            pos: '#d63c3c', neg: '#1f6fd1', neutral: '#7a7a7a',
            eLine: 'rgba(190, 130, 0, 0.6)', bSym: 'rgba(110, 60, 200, 0.55)',
            magFill: 'rgba(120, 80, 220, 0.06)', magEdge: 'rgba(110, 60, 200, 0.4)',
            velocity: '#2a9d8f', forceE: '#e07b00', forceB: '#9b4dca',
            gunFill: '#e3e6ea', gunEdge: '#8a939c', ring: '#222222', glow: 'rgba(255, 255, 255, 0.95)',
        };
    }

    let pal = makePalette(true);
    let fontPx = 13;

    function font(size = fontPx, weight = 400) {
        return `${weight} ${size}px "Source Sans Pro", Helvetica, sans-serif`;
    }

    function colorForCharge(qe) {
        return qe > 0 ? pal.pos : qe < 0 ? pal.neg : pal.neutral;
    }

    function bodyRadius(p) {
        return p.m < 1e-29 ? 6 : Math.abs(p.qe) >= 2 ? 8.5 : 7.5;
    }

    // An arrow in canvas px with an optional label beyond its tip
    function drawArrow(x0, y0, x1, y1, color, width, label) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        if (len < 2) return;
        const ux = dx / len;
        const uy = dy / len;
        const head = Math.min(9, len * 0.45);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1 - ux * head * 0.8, y1 - uy * head * 0.8);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - ux * head - uy * head * 0.5, y1 - uy * head + ux * head * 0.5);
        ctx.lineTo(x1 - ux * head + uy * head * 0.5, y1 - uy * head - ux * head * 0.5);
        ctx.closePath();
        ctx.fill();
        if (label) {
            ctx.font = font(fontPx, 700);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, x1 + ux * 11, y1 + uy * 11);
        }
    }

    // ===================================================================== Rendering
    function render() {
        if (viewW === 0 || viewH === 0) return;
        pal = makePalette(isDarkMode());
        fontPx = clamp(viewW / 75, 11, 14);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = pal.bg;
        ctx.fillRect(0, 0, viewW, viewH);
        callFeatures('drawUnder');
        drawMagneticRegion();
        drawElectricField();
        drawPlates();
        callFeatures('drawMid');
        drawTrails();
        drawMarks();
        const l = activeLauncher();
        if (l && l.draw) l.draw();
        drawParticles();
        drawArrows();
        callFeatures('drawOver');
        drawHint();
    }

    function bFraction() {
        return Math.log(settings.B / B_MIN) / Math.log(B_MAX / B_MIN);
    }

    function drawMagneticRegion() {
        if (!bActive()) return;
        const x0 = px(0);
        const x1 = px(PLATE_L);
        const y0 = py(MAG_HALF);
        const y1 = py(-MAG_HALF);
        ctx.fillStyle = pal.magFill;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = pal.magEdge;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
        ctx.setLineDash([]);
        // Denser symbols for a stronger field
        const cols = Math.round(4 + 8 * bFraction());
        const spacing = (x1 - x0) / cols;
        const rows = Math.max(2, Math.round((y1 - y0) / spacing));
        const yStep = (y1 - y0) / rows;
        const r = clamp(spacing * 0.2, 3, 7);
        ctx.strokeStyle = pal.bSym;
        ctx.fillStyle = pal.bSym;
        ctx.lineWidth = 1.3;
        for (let i = 0; i < cols; i++) {
            for (let j = 0; j < rows; j++) {
                const cx = x0 + (i + 0.5) * spacing;
                const cy = y0 + (j + 0.5) * yStep;
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.stroke();
                if (settings.bOut) {
                    ctx.beginPath();
                    ctx.arc(cx, cy, Math.max(1.2, r * 0.28), 0, Math.PI * 2);
                    ctx.fill();
                } else {
                    const d = r * 0.62;
                    ctx.beginPath();
                    ctx.moveTo(cx - d, cy - d);
                    ctx.lineTo(cx + d, cy + d);
                    ctx.moveTo(cx + d, cy - d);
                    ctx.lineTo(cx - d, cy + d);
                    ctx.stroke();
                }
            }
        }
    }

    function drawElectricField() {
        if (!eActive() || settings.plateV <= 0) return;
        // More field lines for a stronger field
        const n = Math.round(3 + 15 * clamp(Math.abs(eFieldY()) / 25000, 0, 1));
        const yTop = py(settings.gap / 2) + 5;
        const yBot = py(-settings.gap / 2) - 5;
        const down = settings.plusTop;
        const head = 6;
        ctx.strokeStyle = pal.eLine;
        ctx.fillStyle = pal.eLine;
        ctx.lineWidth = 1.2;
        for (let i = 0; i < n; i++) {
            const x = px(PLATE_L * (i + 0.5) / n);
            ctx.beginPath();
            ctx.moveTo(x, yTop);
            ctx.lineTo(x, yBot);
            ctx.stroke();
            const ym = (yTop + yBot) / 2 + (down ? head / 2 : -head / 2);
            const dir = down ? 1 : -1;
            ctx.beginPath();
            ctx.moveTo(x, ym);
            ctx.lineTo(x - head * 0.6, ym - dir * head);
            ctx.lineTo(x + head * 0.6, ym - dir * head);
            ctx.closePath();
            ctx.fill();
        }
    }

    function plateThickness() {
        return clamp(scale * 0.0035, 7, 11);
    }

    function drawPlates() {
        if (!platesPresent()) return;
        const charged = settings.plateV > 0;
        const th = plateThickness();
        const x0 = px(0);
        const x1 = px(PLATE_L);
        [true, false].forEach((top) => {
            const isPos = top === settings.plusTop;
            const color = !charged ? pal.neutral : isPos ? pal.pos : pal.neg;
            const yc = py(top ? settings.gap / 2 : -settings.gap / 2);
            const yRect = top ? yc - th : yc;
            ctx.fillStyle = color;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x0, yRect, x1 - x0, th, 2);
            else ctx.rect(x0, yRect, x1 - x0, th);
            ctx.fill();
            if (charged) {
                // Signs on the plate, so the charge never relies on colour alone
                ctx.fillStyle = '#ffffff';
                ctx.font = font(th + 3, 700);
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const n = Math.max(4, Math.round((x1 - x0) / 34));
                for (let i = 0; i < n; i++) {
                    ctx.fillText(isPos ? '+' : '−', x0 + (x1 - x0) * (i + 0.5) / n, yRect + th / 2 + 0.5);
                }
            }
            // Voltage outside the gap, at the right-hand end
            ctx.fillStyle = pal.muted;
            ctx.font = font(fontPx, 400);
            ctx.textAlign = 'right';
            ctx.textBaseline = top ? 'bottom' : 'top';
            const v = !charged ? '0 V' : isPos ? `+${Math.round(settings.plateV)} V` : '0 V';
            ctx.fillText(v, x1, top ? yRect - 3 : yRect + th + 3);
        });
        if (!settings.lockGeometry) {
            // Grip on the lower plate: drag it to change the gap
            const gx = px(PLATE_L * 0.5);
            const gy = py(-settings.gap / 2) + th + 3;
            ctx.strokeStyle = pal.faint;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = -1; i <= 1; i++) {
                ctx.moveTo(gx - 9, gy + 3 + i * 3 + 3);
                ctx.lineTo(gx + 9, gy + 3 + i * 3 + 3);
            }
            ctx.stroke();
        }
    }

    function trailAlpha(p, rank) {
        if (p === selected) return 1;
        return rank < 3 ? 0.85 : Math.max(0.18, 0.85 - (rank - 2) * 0.12);
    }

    function drawTrails() {
        const n = particles.length;
        const r = 1.9;
        for (let i = 0; i < n; i++) {
            const p = particles[i];
            const tr = p.trail;
            if (tr.length < 2) continue;
            ctx.globalAlpha = trailAlpha(p, n - 1 - i);
            ctx.fillStyle = colorForCharge(p.qe);
            ctx.beginPath();
            for (let k = 0; k < tr.length; k += 2) {
                const x = px(tr[k]);
                const y = py(tr[k + 1]);
                ctx.moveTo(x + r, y);
                ctx.arc(x, y, r, 0, Math.PI * 2);
            }
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function drawMarks() {
        const now = performance.now();
        for (const m of marks) {
            const age = (now - m.born) / 1000;
            const x = px(m.x);
            const y = py(m.y);
            const flash = Math.max(0, 1 - age / 0.6);
            const color = colorForCharge(m.qe);
            ctx.globalAlpha = 0.25 + 0.35 * flash;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, 7 + 6 * flash, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = pal.glow;
            ctx.beginPath();
            ctx.arc(x, y, 2.4, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function drawParticles() {
        for (const p of particles) {
            if (p.state === 'gone') continue;
            const x = px(p.x);
            const y = py(p.y);
            const r = bodyRadius(p);
            if (p === selected) {
                ctx.strokeStyle = pal.ring;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.globalAlpha = p.state === 'stopped' ? 0.55 : 1;
            ctx.fillStyle = colorForCharge(p.qe);
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = font(p.label.length > 1 ? r * 1.15 : r * 1.6, 700);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(p.label, x, y + 0.5);
            ctx.globalAlpha = 1;
        }
    }

    function forceArrowLength(f, p) {
        const ref = (Math.abs(p.qe) || 1) * E_CHARGE * 1e4;
        return clamp(34 + 16 * Math.log2(f / ref), 10, 110);
    }

    function drawArrows() {
        const p = selected;
        if (!p || p.state === 'stopped' || p.state === 'gone') return;
        const cx = px(p.x);
        const cy = py(p.y);
        const r = bodyRadius(p) + 2;
        if (settings.show.velocity) {
            const v = Math.hypot(p.vx, p.vy);
            if (v > 0) {
                const len = clamp(46 * v / refSpeedFor(p.qe, p.m), 8, 120);
                const ux = p.vx / v;
                const uy = -p.vy / v;
                drawArrow(cx + ux * r, cy + uy * r, cx + ux * (r + len), cy + uy * (r + len), pal.velocity, 2.5, 'v');
            }
        }
        if (settings.show.force) {
            const f = forcesOn(p);
            const fe = Math.hypot(f.fex, f.fey);
            const fb = Math.hypot(f.fbx, f.fby);
            const both = fe > 0 && fb > 0;
            const one = (fx, fy, mag, color, label) => {
                const len = forceArrowLength(mag, p);
                const ux = fx / mag;
                const uy = -fy / mag;
                drawArrow(cx + ux * r, cy + uy * r, cx + ux * (r + len), cy + uy * (r + len), color, 2.5, label);
            };
            if (fe > 0) one(f.fex, f.fey, fe, pal.forceE, both ? 'qE' : 'F');
            if (fb > 0) one(f.fbx, f.fby, fb, pal.forceB, both ? 'qvB' : 'F');
            if (fe === 0 && fb === 0 && (insideE(p.x, p.y) || insideB(p.x, p.y))) {
                // In a field but feeling nothing: still in a magnetic field, or neutral
                ctx.fillStyle = pal.muted;
                ctx.font = font(fontPx, 700);
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText('F = 0', cx + r + 6, cy - r - 6);
            }
        }
    }

    function defaultHint() {
        if (viewW < 520) return 'Tap the launcher to fire · tap the field to drop a charge';
        return 'Click the launcher (or press Space) to fire · tap the field to drop a charge at rest';
    }

    function drawHint() {
        const text = hintOverride !== null ? hintOverride : (interacted ? '' : defaultHint());
        if (!text) return;
        ctx.font = font(fontPx, 400);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = pal.muted;
        ctx.fillText(text, viewW / 2, viewH - 8);
    }

    // ===================================================================== Accelerator (default launcher)
    const GUN_HOME = { x: -0.026, y: 0, angle: 0 };
    const gun = { x: GUN_HOME.x, y: GUN_HOME.y, angle: GUN_HOME.angle }; // Muzzle (m) and aim (rad, anticlockwise from +x)

    function gunGeometry() {
        const sx = Math.cos(gun.angle);
        const sy = -Math.sin(gun.angle); // Canvas y points down
        const mx = px(gun.x);
        const my = py(gun.y);
        const len = GUN_L * scale;
        return { sx, sy, mx, my, bx: mx - sx * len, by: my - sy * len, len, kx: mx + sx * AIM_PX, ky: my + sy * AIM_PX };
    }

    function fireFromGun(key = settings.particle, opts = {}) {
        const p = makeParticle(key, gun.x, gun.y);
        p.ux = Math.cos(gun.angle);
        p.uy = Math.sin(gun.angle);
        p.bx = gun.x - p.ux * GUN_L;
        p.by = gun.y - p.uy * GUN_L;
        p.vExit = launchSpeedFor(p.qe, p.m, settings.launchV);
        if (p.vExit > 0) {
            p.state = 'gun';
            p.gs = 0;
            p.gv = p.qe === 0 ? p.vExit : 0; // Nothing to push a neutral particle: it goes through at launch speed
            p.x = p.bx;
            p.y = p.by;
        }
        return addParticle(p, opts);
    }

    function distToSegment(x, y, ax, ay, bx, by) {
        const dx = bx - ax;
        const dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) : 0;
        return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
    }

    function snapAngle(a, fine) {
        if (fine) return a;
        const step = Math.PI / 12; // 15 degrees
        const near = Math.round(a / step) * step;
        return Math.abs(a - near) < (3 * Math.PI) / 180 ? near : a;
    }

    function clampToView(x, y, margin = 0.006) {
        return {
            x: clamp(x, viewRect.x0 + margin, viewRect.x1 - margin),
            y: clamp(y, viewRect.y0 + margin, viewRect.y1 - margin),
        };
    }

    // Where a particle fired now leaves the launcher, and how fast (for the aim guide)
    function gunShot() {
        const t = particleType(settings.particle);
        const v = launchSpeedFor(t.q, t.m, settings.launchV);
        return { x: gun.x, y: gun.y, vx: Math.cos(gun.angle) * v, vy: Math.sin(gun.angle) * v };
    }

    let aimGuideUntil = 0; // performance.now() time until which a keyboard aim shows the guide

    function drawAimGuide(shot) {
        if (!settings.show.aimGuide || !shot) return;
        const path = predictPath(settings.particle, shot.x, shot.y, shot.vx, shot.vy);
        const pts = path.points;
        if (pts.length < 4) return;
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = colorForCharge(particleType(settings.particle).q);
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px(pts[0]), py(pts[1]));
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(px(pts[i]), py(pts[i + 1]));
        ctx.stroke();
        ctx.restore();
    }

    launchers.accelerator = {
        drag: null,
        aiming() {
            return !!(this.drag && this.drag.moved) || performance.now() < aimGuideUntil;
        },
        fire() {
            return fireFromGun();
        },
        shot: gunShot,
        draw() {
            const g = gunGeometry();
            const t = particleType(settings.particle);
            const charged = t.q !== 0 && settings.launchV > 0;
            if (this.aiming()) drawAimGuide(gunShot());
            ctx.save();
            ctx.translate(g.bx, g.by);
            ctx.rotate(Math.atan2(g.sy, g.sx));
            const h = 18;
            ctx.fillStyle = pal.gunFill;
            ctx.strokeStyle = pal.gunEdge;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(-5, -h / 2, g.len + 7, h, 4);
            else ctx.rect(-5, -h / 2, g.len + 7, h);
            ctx.fill();
            ctx.stroke();
            // Two little plates: the particle is pushed from the back one towards the one with the hole
            const back = !charged ? pal.neutral : t.q > 0 ? pal.pos : pal.neg;
            const front = !charged ? pal.neutral : t.q > 0 ? pal.neg : pal.pos;
            ctx.fillStyle = back;
            ctx.fillRect(-1, -h / 2 + 3, 3, h - 6);
            ctx.fillStyle = front;
            ctx.fillRect(g.len - 1, -h / 2 + 3, 3, h / 2 - 6);
            ctx.fillRect(g.len - 1, 3, 3, h / 2 - 6);
            ctx.restore();
            if (charged) {
                // Signs beside the plates, outside the body
                ctx.font = font(fontPx - 1, 700);
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const nx = -g.sy;
                const ny = g.sx;
                const off = h / 2 + 7;
                ctx.fillStyle = back;
                ctx.fillText(t.q > 0 ? '+' : '−', g.bx - nx * off, g.by - ny * off);
                ctx.fillStyle = front;
                ctx.fillText(t.q > 0 ? '−' : '+', g.mx - nx * off, g.my - ny * off);
            }
            // Launch voltage under the launcher
            ctx.fillStyle = pal.muted;
            ctx.font = font(fontPx, 400);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const cx = (g.bx + g.mx) / 2;
            const cy = Math.max(g.by, g.my) + h / 2 + 8;
            ctx.fillText(`${Math.round(settings.launchV)} V`, cx, cy);
            if (!settings.lockGeometry) {
                // Aim handle
                ctx.strokeStyle = pal.faint;
                ctx.lineWidth = 1.5;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(g.mx + g.sx * 6, g.my + g.sy * 6);
                ctx.lineTo(g.kx, g.ky);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = pal.bg;
                ctx.strokeStyle = pal.muted;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(g.kx, g.ky, 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        },
        hitKnob(w) {
            if (settings.lockGeometry) return false;
            const g = gunGeometry();
            return Math.hypot(w.cx - g.kx, w.cy - g.ky) < 16;
        },
        hitBody(w) {
            const g = gunGeometry();
            return distToSegment(w.cx, w.cy, g.bx, g.by, g.mx, g.my) < 14;
        },
        hover(w) {
            if (this.hitKnob(w)) return 'grab';
            if (this.hitBody(w)) return settings.lockGeometry ? 'pointer' : 'move';
            return null;
        },
        pointerDown(w) {
            if (this.hitKnob(w)) {
                this.drag = { mode: 'aim', moved: false };
                return true;
            }
            if (this.hitBody(w)) {
                this.drag = { mode: 'body', moved: false, sx: w.cx, sy: w.cy, dx: gun.x - w.x, dy: gun.y - w.y };
                return true;
            }
            return false;
        },
        pointerMove(w, e) {
            const d = this.drag;
            if (!d) return;
            if (d.mode === 'aim') {
                d.moved = true;
                const g = gunGeometry();
                gun.angle = snapAngle(Math.atan2(-(w.cy - g.my), w.cx - g.mx), e.shiftKey);
            } else if (d.mode === 'body') {
                if (!d.moved && Math.hypot(w.cx - d.sx, w.cy - d.sy) < 6) return;
                if (settings.lockGeometry) return;
                d.moved = true;
                const c = clampToView(w.x + d.dx, w.y + d.dy, 0.008);
                gun.x = c.x;
                gun.y = c.y;
            }
        },
        pointerUp() {
            const d = this.drag;
            this.drag = null;
            if (d && d.mode === 'body' && !d.moved) fire();
        },
        keyAim(deg) {
            gun.angle += (deg * Math.PI) / 180;
            aimGuideUntil = performance.now() + 1500;
        },
        reset() {
            gun.x = GUN_HOME.x;
            gun.y = GUN_HOME.y;
            gun.angle = GUN_HOME.angle;
        },
    };

    function activeLauncher() {
        return launchers[settings.launcher] || launchers.accelerator;
    }

    // ===================================================================== Actions
    function fire() {
        if (askFeatures('fire')) return;
        activeLauncher().fire();
    }

    function stopAll() {
        particles = [];
        marks = [];
        selected = null;
    }

    function reset() {
        stopAll();
        simClock = 0;
        callFeatures('reset');
        render();
        updateReadouts();
    }

    function setPaused(on) {
        paused = !!on;
        const btn = $('pauseBtn');
        if (btn) {
            btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
            btn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
            btn.title = paused ? 'Play (P)' : 'Pause (P)';
            const icon = btn.querySelector('.icon');
            if (icon) icon.className = `icon solid ${paused ? 'fa-play' : 'fa-pause'}`;
        }
        const step = $('stepBtn');
        if (step) step.hidden = !paused;
    }

    function stepOnce() {
        advanceAll((1 / 30) * currentRate());
        callFeatures('frame', 1 / 30, (1 / 30) * currentRate());
    }

    // ===================================================================== Live region
    const liveEl = $('chLive');

    function announce(text) {
        if (liveEl) liveEl.textContent = text;
    }

    function speechNumber(v) {
        if (v === 0) return '0';
        const exp = Math.floor(Math.log10(Math.abs(v)));
        if (exp < 4 && exp > -3) return String(+v.toPrecision(3));
        return `${(v / Math.pow(10, exp)).toFixed(2)} times 10 to the ${exp}`;
    }

    function announceEnd(p) {
        const where = p.state === 'gone' ? 'left the view' : `hit the ${p.hitWhat}`;
        announce(`${p.name} ${where} at ${speechNumber(p.speedAtEnd)} metres per second after ${fmtTime(p.t).join(' ')}.`);
    }

    // ===================================================================== Readouts
    const SUPS = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
    const sup = (n) => String(n).split('').map((c) => SUPS[c] || c).join('');

    function fmtSci(v, digits = 2) {
        if (!isFinite(v)) return '–';
        if (v === 0) return '0';
        let exp = Math.floor(Math.log10(Math.abs(v)));
        let mant = v / Math.pow(10, exp);
        if (Math.abs(+mant.toFixed(digits)) >= 10) {
            mant /= 10;
            exp += 1;
        }
        return `${mant.toFixed(digits)}×10${sup(exp)}`;
    }

    function fmtSpeed(v) {
        return v < 1000 ? String(Math.round(v)) : fmtSci(v, 2);
    }

    // [value, unit]
    function fmtEnergy(ev) {
        if (ev < 10) return [ev.toFixed(1), 'eV'];
        if (ev < 1000) return [ev.toFixed(0), 'eV'];
        return [(ev / 1000).toFixed(2), 'keV'];
    }

    function fmtTime(t) {
        const ns = t * 1e9;
        if (ns < 100) return [ns.toFixed(1), 'ns'];
        if (ns < 1000) return [ns.toFixed(0), 'ns'];
        if (ns < 1e6) return [(ns / 1000).toFixed(2), 'µs'];
        return [(ns / 1e6).toFixed(2), 'ms'];
    }

    function fmtMilliTesla(b) {
        const mt = b * 1000;
        if (mt < 1) return mt.toFixed(3);
        if (mt < 10) return mt.toFixed(2);
        if (mt < 100) return mt.toFixed(1);
        return mt.toFixed(0);
    }

    const readoutCache = new Map();

    function setText(id, text) {
        if (readoutCache.get(id) === text) return;
        readoutCache.set(id, text);
        const el = $(id);
        if (el) el.textContent = text;
    }

    function setHidden(id, hidden) {
        const el = $(id);
        if (el && el.hidden !== hidden) el.hidden = hidden;
    }

    function particleSpeed(p) {
        return p.state === 'stopped' || p.state === 'gone' ? p.speedAtEnd : Math.hypot(p.vx, p.vy);
    }

    function updateReadouts() {
        const p = selected;
        const dash = '–';
        const dot = $('selDot');
        const key = p ? p.qe : particleType(settings.particle).q;
        if (dot) dot.style.backgroundColor = colorForCharge(key);
        setText('selName', p ? p.name : particleType(settings.particle).name);
        if (p) {
            const v = particleSpeed(p);
            setText('statSpeed', fmtSpeed(v));
            const [e, eu] = fmtEnergy((0.5 * p.m * v * v) / E_CHARGE);
            setText('statEnergy', e);
            setText('statEnergyUnit', eu);
            const [t, tu] = fmtTime(p.t);
            setText('statTime', t);
            setText('statTimeUnit', tu);
        } else {
            setText('statSpeed', dash);
            setText('statEnergy', dash);
            setText('statTime', dash);
        }
        const values = settings.show.values;
        setHidden('statEBox', !(values && eActive()));
        setHidden('statBBox', !(values && bActive()));
        setHidden('statFBox', !values);
        setHidden('statABox', !values);
        setHidden('statRBox', !(values && settings.field === 'B'));
        if (!values) return;
        if (eActive()) {
            const e = Math.abs(eFieldY());
            setText('statE', e < 1e4 ? e.toFixed(0) : fmtSci(e, 2));
        }
        if (bActive()) setText('statB', fmtMilliTesla(settings.B));
        if (p && p.state !== 'stopped' && p.state !== 'gone') {
            const f = forcesOn(p);
            const fx = f.fex + f.fbx;
            const fy = f.fey + f.fby;
            const fm = Math.hypot(fx, fy);
            setText('statF', fmtSci(fm, 2));
            setText('statA', fmtSci(fm / p.m, 2));
            const v = Math.hypot(p.vx, p.vy);
            const r = p.qe !== 0 && v > 0 && settings.field === 'B' ? (p.m * v) / (Math.abs(p.q) * settings.B) : NaN;
            setText('statR', isFinite(r) ? (r * 100 < 1000 ? (r * 100).toFixed(2) : fmtSci(r * 100, 2)) : dash);
        } else {
            setText('statF', dash);
            setText('statA', dash);
            setText('statR', dash);
        }
    }

    // ===================================================================== Controls
    // A row of role="radio" buttons: click or arrow keys to choose; only the chosen one is in the tab order
    function radioGroup(buttons, getKey, onChoose) {
        const list = Array.from(buttons);
        const sync = (key) => {
            list.forEach((b) => {
                const on = getKey(b) === key;
                b.setAttribute('aria-checked', on ? 'true' : 'false');
                b.tabIndex = on ? 0 : -1;
            });
        };
        list.forEach((b, i) => {
            b.addEventListener('click', () => onChoose(getKey(b)));
            b.addEventListener('keydown', (e) => {
                let j = -1;
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % list.length;
                if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + list.length) % list.length;
                if (j < 0) return;
                e.preventDefault();
                while (list[j].hidden && j !== i) j = (j + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
                onChoose(getKey(list[j]));
                list[j].focus();
            });
        });
        return sync;
    }

    function sliderFill(slider) {
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        const f = ((parseFloat(slider.value) - min) / (max - min)) * 100;
        slider.style.setProperty('--ch-fill', `${f}%`);
    }

    const plateVSlider = $('plateVSlider');
    const bSlider = $('bSlider');
    const launchVSlider = $('launchVSlider');
    const gapSlider = $('gapSlider');
    const playbackSlider = $('playbackSlider');

    const bToSlider = (b) => Math.round((1000 * Math.log(b / B_MIN)) / Math.log(B_MAX / B_MIN));
    const sliderToB = (v) => B_MIN * Math.pow(B_MAX / B_MIN, v / 1000);

    const syncFieldButtons = radioGroup(document.querySelectorAll('.ch-field .ch-seg-btn'), (b) => b.dataset.field, (k) => setField(k));
    const syncParticleChips = radioGroup(document.querySelectorAll('#particleGroup .ch-chip'), (b) => b.dataset.particle, (k) => setParticle(k));
    const syncLauncherButtons = radioGroup(document.querySelectorAll('#launchGroup .ch-seg-btn'), (b) => b.dataset.launcher, (k) => setLauncher(k));

    // Bring every control in line with `settings` (after a setup or a feature changes several at once)
    function syncControls() {
        syncFieldButtons(settings.field);
        syncParticleChips(settings.particle);
        syncLauncherButtons(launchers[settings.launcher] ? settings.launcher : 'accelerator');
        setHidden('eStrength', !eActive());
        setHidden('bStrength', !bActive());
        if (plateVSlider) {
            plateVSlider.value = settings.plateV;
            sliderFill(plateVSlider);
        }
        setText('plateVVal', String(Math.round(settings.plateV)));
        if (bSlider) {
            bSlider.value = bToSlider(settings.B);
            sliderFill(bSlider);
            bSlider.setAttribute('aria-valuetext', `${fmtMilliTesla(settings.B)} millitesla`);
        }
        setText('bVal', fmtMilliTesla(settings.B));
        if (launchVSlider) launchVSlider.value = settings.launchV;
        setText('launchVVal', String(Math.round(settings.launchV)));
        if (gapSlider) gapSlider.value = (settings.gap * 100).toFixed(1);
        setText('gapVal', (settings.gap * 100).toFixed(1));
        if (playbackSlider) playbackSlider.value = settings.playback;
        setText('playbackVal', settings.playback.toFixed(1));
        const eDir = $('eDirBtn');
        if (eDir) {
            eDir.querySelector('.ch-dir-text').textContent = settings.plusTop ? 'on top' : 'below';
            eDir.setAttribute('aria-label', `Positive plate ${settings.plusTop ? 'on top' : 'below'}. Press to swap the plates`);
        }
        const bDir = $('bDirBtn');
        if (bDir) {
            bDir.querySelector('.ch-dir-sym').textContent = settings.bOut ? '⊙' : '⊗';
            bDir.querySelector('.ch-dir-text').textContent = settings.bOut ? 'out of page' : 'into page';
            bDir.setAttribute('aria-label', `Field ${settings.bOut ? 'out of' : 'into'} the page. Press to reverse it`);
        }
        const toggles = { velocityToggle: 'velocity', forceToggle: 'force', componentsToggle: 'components', rhrToggle: 'rhr', gridToggle: 'grid', equipToggle: 'equip', valuesToggle: 'values', aimGuideToggle: 'aimGuide' };
        Object.keys(toggles).forEach((id) => {
            const el = $(id);
            if (el) el.checked = !!settings.show[toggles[id]];
        });
        const setupSelect = $('setupSelect');
        if (setupSelect) setupSelect.value = settings.setup;
    }

    function settingsChanged() {
        syncControls();
        callFeatures('onSettings');
        updateReadouts();
    }

    function setField(key) {
        if (!['E', 'B', 'both'].includes(key)) return;
        settings.field = key;
        settingsChanged();
    }

    function setParticle(key) {
        if (!PARTICLE_TYPES[key]) return;
        settings.particle = key;
        settingsChanged();
    }

    function setLauncher(key) {
        if (!launchers[key]) return;
        settings.launcher = key;
        settingsChanged();
    }

    function setSetup(name) {
        settings.setup = name;
        stopAll();
        callFeatures('onSetup', name);
        settingsChanged();
    }

    function setGap(gapM) {
        settings.gap = clamp(Math.round(gapM * 1000) / 1000, GAP_MIN, GAP_MAX);
        settingsChanged();
    }

    if (plateVSlider) plateVSlider.addEventListener('input', () => { settings.plateV = parseFloat(plateVSlider.value); settingsChanged(); });
    if (bSlider) bSlider.addEventListener('input', () => { settings.B = sliderToB(parseFloat(bSlider.value)); settingsChanged(); });
    if (launchVSlider) launchVSlider.addEventListener('input', () => { settings.launchV = parseFloat(launchVSlider.value); settingsChanged(); });
    if (gapSlider) gapSlider.addEventListener('input', () => setGap(parseFloat(gapSlider.value) / 100));
    if (playbackSlider) playbackSlider.addEventListener('input', () => { settings.playback = parseFloat(playbackSlider.value); settingsChanged(); });

    const eDirBtn = $('eDirBtn');
    if (eDirBtn) eDirBtn.addEventListener('click', () => { settings.plusTop = !settings.plusTop; settingsChanged(); });
    const bDirBtn = $('bDirBtn');
    if (bDirBtn) bDirBtn.addEventListener('click', () => { settings.bOut = !settings.bOut; settingsChanged(); });
    const fireBtn = $('fireBtn');
    if (fireBtn) fireBtn.addEventListener('click', () => fire());

    [['velocityToggle', 'velocity'], ['forceToggle', 'force'], ['componentsToggle', 'components'], ['rhrToggle', 'rhr'],
        ['gridToggle', 'grid'], ['equipToggle', 'equip'], ['valuesToggle', 'values'], ['aimGuideToggle', 'aimGuide']].forEach(([id, key]) => {
        const el = $(id);
        if (el) el.addEventListener('change', () => { settings.show[key] = el.checked; settingsChanged(); });
    });

    const setupSelect = $('setupSelect');
    if (setupSelect) setupSelect.addEventListener('change', () => setSetup(setupSelect.value));

    const pauseBtn = $('pauseBtn');
    if (pauseBtn) pauseBtn.addEventListener('click', () => setPaused(!paused));
    const stepBtn = $('stepBtn');
    if (stepBtn) stepBtn.addEventListener('click', () => stepOnce());
    const resetBtn = $('resetSimulationBtn');
    if (resetBtn) resetBtn.addEventListener('click', () => reset());

    // ===================================================================== Pointer input
    let pointer = null; // The current press: { kind, ... }

    function canvasPoint(e) {
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        return { cx, cy, x: wx(cx), y: wy(cy) };
    }

    function particleAt(w) {
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            if (p.state === 'gone') continue;
            if (Math.hypot(px(p.x) - w.cx, py(p.y) - w.cy) < bodyRadius(p) + 8) return p;
        }
        return null;
    }

    function hitPlate(w) {
        if (!platesPresent() || settings.lockGeometry) return false;
        if (w.x < -0.002 || w.x > PLATE_L + 0.002) return false;
        const th = plateThickness();
        const top = py(settings.gap / 2) - th / 2;
        const bot = py(-settings.gap / 2) + th / 2;
        return Math.abs(w.cy - top) < th / 2 + 7 || Math.abs(w.cy - bot) < th / 2 + 9;
    }

    canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const w = canvasPoint(e);
        const f = askFeatures('pointerDown', w, e);
        const l = activeLauncher();
        if (f) pointer = { kind: 'feature', f };
        else if (l.pointerDown && l.pointerDown(w, e)) pointer = { kind: 'launcher', l };
        else if (hitPlate(w)) pointer = { kind: 'plate' };
        else pointer = { kind: 'tap', cx: w.cx, cy: w.cy, moved: false };
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* Ignore */ }
        e.preventDefault();
    });

    canvas.addEventListener('pointermove', (e) => {
        const w = canvasPoint(e);
        if (!pointer) {
            let cursor = null;
            for (const f of features) {
                if (typeof f.hover === 'function') cursor = f.hover(w);
                if (cursor) break;
            }
            const l = activeLauncher();
            if (!cursor && l.hover) cursor = l.hover(w);
            if (!cursor && hitPlate(w)) cursor = 'ns-resize';
            if (!cursor && particleAt(w)) cursor = 'pointer';
            if (!cursor && settings.allowDrop) cursor = 'crosshair';
            canvas.style.cursor = cursor || 'default';
            return;
        }
        if (pointer.kind === 'feature') pointer.f.pointerMove && pointer.f.pointerMove(w, e);
        else if (pointer.kind === 'launcher') pointer.l.pointerMove && pointer.l.pointerMove(w, e);
        else if (pointer.kind === 'plate') setGap(2 * Math.abs(w.y));
        else if (pointer.kind === 'tap' && Math.hypot(w.cx - pointer.cx, w.cy - pointer.cy) > 8) pointer.moved = true;
    });

    function endPointer(e, cancelled) {
        if (!pointer) return;
        const w = canvasPoint(e);
        const p = pointer;
        pointer = null;
        if (p.kind === 'feature') p.f.pointerUp && p.f.pointerUp(w, e, cancelled);
        else if (p.kind === 'launcher') p.l.pointerUp && p.l.pointerUp(w, e, cancelled);
        else if (p.kind === 'tap' && !p.moved && !cancelled) {
            const hit = particleAt(w);
            if (hit) selected = hit;
            else if (settings.allowDrop) dropAt(w.x, w.y);
            updateReadouts();
        }
    }

    canvas.addEventListener('pointerup', (e) => endPointer(e, false));
    canvas.addEventListener('pointercancel', (e) => endPointer(e, true));

    // ===================================================================== Keyboard
    function isTextEntry(el) {
        if (!el) return false;
        if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
        if (el.tagName !== 'INPUT') return false;
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        return !['range', 'checkbox', 'radio', 'button'].includes(type);
    }

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (isTextEntry(e.target)) return;
        if (askFeatures('keydown', e)) return;
        const onCanvas = e.target === canvas;
        const free = onCanvas || e.target === document.body || (e.target.tagName === 'INPUT' && e.target.type === 'range');
        if (e.key === ' ' && free && !e.repeat) {
            e.preventDefault();
            fire();
        } else if ((e.key === 'p' || e.key === 'P') && !e.repeat) {
            e.preventDefault();
            setPaused(!paused);
        } else if (e.key === '.' && paused) {
            e.preventDefault();
            stepOnce();
        } else if (onCanvas && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
            const l = activeLauncher();
            if (!l.keyAim || settings.lockGeometry) return;
            e.preventDefault();
            const deg = (e.shiftKey ? 0.5 : 3) * (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? 1 : -1);
            l.keyAim(deg);
        }
    });

    // ===================================================================== Canvas sizing
    function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width));
        const h = Math.max(1, Math.round(rect.height));
        const newDpr = Math.min(2, window.devicePixelRatio || 1);
        if (w === viewW && h === viewH && newDpr === dpr) return;
        viewW = w;
        viewH = h;
        dpr = newDpr;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        computeView();
        const g = clampToView(gun.x, gun.y, 0.008);
        gun.x = g.x;
        gun.y = g.y;
        render();
    }

    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resizeCanvas).observe(canvas);
    window.addEventListener('resize', resizeCanvas);

    // =====================================================================
    // Feature sections. Each feature adds code inside its own section only.
    // =====================================================================

    // ===================================================================== [slingshot]


    // ===================================================================== end [slingshot]



    // ===================================================================== [thomson]


    // ===================================================================== end [thomson]



    // ===================================================================== [overlays]


    // ===================================================================== end [overlays]



    // ===================================================================== [graphs-custom]


    // ===================================================================== end [graphs-custom]



    // ===================================================================== Main loop (exactly one)
    const MAX_FRAME_DT = 0.1; // s; avoids a huge step after the tab was hidden
    const fpsDisplay = $('fpsDisplay');
    let lastTimestamp = 0;
    let fpsFrames = 0;
    let fpsTime = 0;

    function frame(timestamp) {
        const dt = lastTimestamp ? Math.min(MAX_FRAME_DT, (timestamp - lastTimestamp) / 1000) : 0;
        lastTimestamp = timestamp;
        const simDt = paused ? 0 : dt * currentRate();
        if (simDt > 0) advanceAll(simDt);
        callFeatures('frame', paused ? 0 : dt, simDt);
        render();
        updateReadouts();
        if (fpsDisplay) {
            fpsFrames++;
            fpsTime += dt;
            if (fpsTime >= 0.5) {
                fpsDisplay.textContent = `FPS: ${Math.round(fpsFrames / fpsTime)}`;
                fpsFrames = 0;
                fpsTime = 0;
            }
        }
        requestAnimationFrame(frame);
    }

    // ===================================================================== Public API (reset button; tests)
    window.chargesSim = {
        constants: { E_CHARGE, M_PROTON, M_ELECTRON, M_ALPHA, M_NEUTRON, U_MASS, PLATE_L, MAG_HALF, GUN_L, B_MIN, B_MAX },
        get settings() { return settings; },
        get particles() { return particles; },
        get selected() { return selected; },
        get gun() { return gun; },
        get view() { return { scale, ox, oy, viewW, viewH, rect: { ...viewRect } }; },
        get paused() { return paused; },
        PARTICLE_TYPES,
        reset,
        fire,
        dropAt,
        fireFromGun,
        setField,
        setParticle,
        setLauncher,
        setSetup,
        setGap,
        setPaused,
        // Change several settings at once, then bring the controls in line
        set(partial) {
            Object.keys(partial).forEach((k) => {
                if (k === 'show') Object.assign(settings.show, partial.show);
                else settings[k] = partial[k];
            });
            settingsChanged();
        },
        // Run the simulation for `realSeconds` of playback in fixed frames (works while paused)
        advance(realSeconds, fps = 60) {
            const n = Math.max(1, Math.round(realSeconds * fps));
            for (let i = 0; i < n; i++) {
                advanceAll(currentRate() / fps);
                callFeatures('frame', 1 / fps, currentRate() / fps);
            }
            render();
            updateReadouts();
        },
        predictPath,
        launchSpeedFor,
        rateFor,
        render,
        toCanvas: (x, y) => ({ cx: px(x), cy: py(y) }),
    };

    // ===================================================================== Start
    resizeCanvas();
    callFeatures('init');
    syncControls();
    updateReadouts();
    requestAnimationFrame(frame);
})();
