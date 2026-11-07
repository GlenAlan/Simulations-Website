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
    function platesPresent() { return eActive() || settings.setup === 'thomson'; } // Thomson's plates stay in place
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
        const charged = eActive() && settings.plateV > 0;
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
                d.moved = true; // A drag isn't a click, even when the gun can't move
                if (settings.lockGeometry) return;
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
    // Thomson's experiment. A cathode-ray gun on the centre line fires a steady beam between the plates and through
    // the magnetic field onto a fluorescent screen at the end of the plates. The student measures the spot's shift
    // with the plates alone, brings it back to zero with the magnetic field (qE = qvB, so v = E/B), then works out
    // q/m. The beam isn't made of real particles: its steady path comes from the particles' own mover (only when
    // something changes) and is drawn as a glow with dots streaming along it at equal times. A probe particle partway
    // along it is what `selected` points at, so the velocity and force arrows show on the beam. Cathode rays are never
    // called electrons (on screen, in ARIA or in the live region) until both answers have been checked or shown.
    {
        const TH_BEAMS = {
            cathode: { key: 'electron', name: 'Cathode rays', qm: E_CHARGE / M_ELECTRON },
            hydrogen: { key: 'proton', name: 'Hydrogen ions', qm: E_CHARGE / M_PROTON },
        };
        const TH_LAUNCH_V = 2000;     // V
        const TH_GAP = 0.05;          // m
        const TH_SCREEN_HALF = 0.03;  // Half-height of the screen (m): it closes the end of the box
        const TH_TOLERANCE = 0.05;    // An answer within 5% counts
        const TH_TRIES = 2;           // Wrong answers before "Show answer" appears
        const TH_ANNOUNCE_MS = 700;   // The spot is read out once it has stayed put this long
        const TH_GOAL = 'What are cathode rays? Balance the beam, then work out their charge-to-mass ratio.';
        const TH_CANVAS_LABEL = 'Thomson\'s experiment: a beam from a gun on the left passes between two plates and ' +
            'through a magnetic field, then makes a glowing spot on a screen with a millimetre scale. Click the gun ' +
            'or press Space to turn the beam on or off.';
        const TH_RATIO = Math.round(TH_BEAMS.cathode.qm / TH_BEAMS.hydrogen.qm / 10) * 10; // About 1840
        const TH_DISCOVERY = `Cathode rays' q/m is about ${TH_RATIO} times hydrogen's, whatever the cathode metal: ` +
            'a particle far lighter than any atom, inside all of them. It\'s the electron.';

        const th = {
            active: false,
            beam: 'cathode',
            on: true,
            clock: 0,          // Simulated seconds of beam time
            onAt: 0,           // Beam clock when the beam last came on, and when it went off (Infinity while on)
            offAt: Infinity,
            path: null,        // The beam's steady path: times, positions, velocities, how it ends, the spot
            dirty: true,
            pathScale: 0,      // The view scale the path was worked out at
            probe: null,
            free: null,        // Free play's settings and gun, kept up to date while in free play, put back on leaving
            saved: {},         // Page text and states that entering changed
            answers: {
                cathode: { text: '', tries: 0, known: false, msg: '' },
                hydrogen: { text: '', tries: 0, known: false, msg: '' },
            },
            spotSpeech: '',    // The spot's position in words, when it last changed, and the last one read out
            spotSince: 0,
            spotSaid: '',
        };
        const thEl = { hideInThomson: [] };
        const thPt = { x: 0, y: 0, vx: 0, vy: 0 };

        function thSnapshotFree() {
            if (settings.setup !== 'free') return;
            const f = th.free || (th.free = { settings: {}, show: {}, gun: {} });
            Object.keys(settings).forEach((k) => { if (k !== 'show') f.settings[k] = settings[k]; });
            Object.assign(f.show, settings.show);
            f.gun.x = gun.x;
            f.gun.y = gun.y;
            f.gun.angle = gun.angle;
            f.rateOverride = rateOverride;
            f.hintOverride = hintOverride;
        }

        function thEnter() {
            if (!th.active) {
                th.active = true;
                thPage(true);
            }
            // The experiment starts with the mystery beam
            if (th.beam !== 'cathode' && thEl.input) th.answers[th.beam].text = thEl.input.value;
            th.beam = 'cathode';
            Object.assign(settings, {
                field: 'E', plateV: 0, plusTop: true, B: B_MIN, bOut: false, gap: TH_GAP, launchV: TH_LAUNCH_V,
                launcher: 'accelerator', lockGeometry: true, allowDrop: false,
            });
            settings.show.values = false;
            settings.show.aimGuide = false;
            gun.x = GUN_HOME.x;
            gun.y = GUN_HOME.y;
            gun.angle = GUN_HOME.angle;
            hintOverride = '';
            thApplyBeam();
            thRestartBeam();
        }

        function thLeave() {
            th.active = false;
            if (thEl.input) th.answers[th.beam].text = thEl.input.value;
            const f = th.free;
            if (f) {
                Object.keys(f.settings).forEach((k) => { if (k !== 'setup') settings[k] = f.settings[k]; });
                Object.assign(settings.show, f.show);
                gun.x = f.gun.x;
                gun.y = f.gun.y;
                gun.angle = f.gun.angle;
                rateOverride = f.rateOverride;
                hintOverride = f.hintOverride;
            }
            if (selected === th.probe) selected = null;
            thPage(false);
        }

        // Swap the page between free play and Thomson's experiment
        function thPage(on) {
            const s = th.saved;
            setHidden('statsFree', on);
            setHidden('particleGroup', on);
            setHidden('statsThomson', !on);
            setHidden('beamGroup', !on);
            setHidden('thAnswer', !on);
            thEl.hideInThomson.forEach((el) => { el.hidden = on; });
            const area = canvas.closest('.charges-sim');
            if (area) area.classList.toggle('th-active', on);
            const gapSlider = $('gapSlider');
            if (gapSlider) gapSlider.disabled = on; // The plates are fixed
            const hint = $('setupHint');
            const fireBtn = $('fireBtn');
            const charts = $('showCharts');
            if (on) {
                s.hint = hint ? hint.textContent : '';
                s.canvasLabel = canvas.getAttribute('aria-label');
                if (hint) hint.textContent = TH_GOAL;
                canvas.setAttribute('aria-label', TH_CANVAS_LABEL);
                if (fireBtn) {
                    s.fireHtml = fireBtn.innerHTML;
                    s.fireTitle = fireBtn.title;
                    s.fireLabel = fireBtn.getAttribute('aria-label');
                    fireBtn.classList.add('th-beam-btn');
                    fireBtn.title = 'Turn the beam on or off (Space)';
                    fireBtn.setAttribute('aria-label', 'Beam');
                }
                // Speed against time is something Thomson couldn't see
                s.charts = !!(charts && charts.checked);
                if (s.charts) {
                    charts.checked = false;
                    charts.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } else {
                if (hint) hint.textContent = s.hint;
                if (s.canvasLabel !== null) canvas.setAttribute('aria-label', s.canvasLabel);
                if (fireBtn) {
                    fireBtn.innerHTML = s.fireHtml;
                    fireBtn.title = s.fireTitle;
                    if (s.fireLabel === null) fireBtn.removeAttribute('aria-label');
                    else fireBtn.setAttribute('aria-label', s.fireLabel);
                    fireBtn.removeAttribute('aria-pressed');
                    fireBtn.classList.remove('th-beam-btn');
                }
                if (s.charts && charts) {
                    charts.checked = true;
                    charts.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }

        // The beam's particle type drives the gun's polarity, the playback rate and the probe
        function thApplyBeam() {
            const b = TH_BEAMS[th.beam];
            settings.particle = b.key;
            rateOverride = b.key;
            th.probe = makeParticle(b.key, gun.x, gun.y);
            th.probe.name = b.name;
            th.probe.state = 'gone';
            selected = th.probe;
            th.dirty = true;
            thSyncBeamUI();
        }

        function thSetBeam(key) {
            if (!TH_BEAMS[key]) return;
            if (key !== th.beam) {
                if (thEl.input) th.answers[th.beam].text = thEl.input.value;
                th.beam = key;
                thApplyBeam();
                thRestartBeam();
                settingsChanged();
            }
            thSyncBeamUI();
        }

        // The beam comes on afresh: its head leaves the gun now (or the whole beam is there at once while paused)
        function thRestartBeam() {
            th.on = true;
            th.onAt = paused ? -Infinity : th.clock;
            th.offAt = Infinity;
            thSyncBeamButton();
        }

        function thSetBeamOn(on) {
            if (on) {
                thRestartBeam();
                return;
            }
            th.on = false;
            th.offAt = paused ? -Infinity : th.clock; // The tail drains out to the screen
            thSyncBeamButton();
        }

        function thSyncBeamButton() {
            const btn = $('fireBtn');
            if (!btn || !th.active) return;
            btn.setAttribute('aria-pressed', th.on ? 'true' : 'false');
            btn.innerHTML = `<span class="icon solid fa-power-off" aria-hidden="true"></span> Beam ${th.on ? 'on' : 'off'}`;
        }

        // ----- The steady path
        function thTracePath() {
            const t = particleType(TH_BEAMS[th.beam].key);
            const v = launchSpeedFor(t.q, t.m, settings.launchV);
            const ux = Math.cos(gun.angle);
            const uy = Math.sin(gun.angle);
            const path = { t: [0], x: [gun.x], y: [gun.y], vx: [ux * v], vy: [uy * v], end: 'none', tEnd: 0, spotY: NaN, probeT: NaN };
            if (!(v > 0)) return path;
            const p = {
                ghost: true, qe: t.q, q: t.q * E_CHARGE, m: t.m, x: gun.x, y: gun.y, vx: ux * v, vy: uy * v,
                state: 'free', t: 0, strobeDt: Infinity, nextStrobe: Infinity, trail: [],
            };
            const saved = obstaclesNow;
            obstaclesNow = obstacleList();
            const dt = (PLATE_L - gun.x) / v / 300;
            for (let i = 0; i < 3000 && p.state === 'free'; i++) {
                advanceFree(p, dt);
                path.t.push(p.t);
                path.x.push(p.x);
                path.y.push(p.y);
                path.vx.push(p.vx);
                path.vy.push(p.vy);
            }
            obstaclesNow = saved;
            path.tEnd = p.t;
            path.end = p.state === 'stopped' ? p.hitWhat : p.state === 'gone' ? 'edge' : 'none';
            if (p.hitWhat === 'screen') path.spotY = p.y;
            // The probe sits partway along the plates (or halfway to where the beam ends, if that's sooner)
            const xMax = Math.max(...path.x);
            if (xMax > 0) {
                const x = thProbeX();
                const target = xMax > x ? x : xMax / 2;
                for (let i = 1; i < path.x.length; i++) {
                    if (path.x[i] >= target) {
                        const f = (target - path.x[i - 1]) / ((path.x[i] - path.x[i - 1]) || 1);
                        path.probeT = path.t[i - 1] + f * (path.t[i] - path.t[i - 1]);
                        break;
                    }
                }
            }
            return path;
        }

        // About a third of the way along the plates (leaving room for the velocity arrow before the screen), clear of
        // the electric field lines and the columns of magnetic field symbols (spaced as the core draws them), so the
        // arrows don't lie along a line and the probe doesn't sit on a symbol
        function thProbeX() {
            const avoid = [];
            if (eActive() && settings.plateV > 0) {
                const n = Math.round(3 + 15 * clamp(Math.abs(eFieldY()) / 25000, 0, 1));
                for (let i = 0; i < n; i++) avoid.push((i + 0.5) / n);
            }
            if (bActive()) {
                const cols = Math.round(4 + 8 * bFraction());
                for (let i = 0; i < cols; i++) avoid.push((i + 0.5) / cols);
            }
            let best = 0.35;
            let bestScore = -Infinity;
            for (let f = 0.25; f <= 0.45 + 1e-9; f += 0.0025) {
                const clear = avoid.reduce((g, a) => Math.min(g, Math.abs(f - a)), 0.05);
                const score = clear - 0.2 * Math.abs(f - 0.35);
                if (score > bestScore) {
                    best = f;
                    bestScore = score;
                }
            }
            return PLATE_L * best;
        }

        // Worked out again after any change (and after a resize, since a beam can leave the view)
        function thEnsurePath() {
            if (th.dirty || !th.path || th.pathScale !== scale) {
                th.dirty = false;
                th.pathScale = scale;
                th.path = thTracePath();
            }
            return th.path;
        }

        // Position and velocity `tp` simulated seconds along the path, into `out`
        function thPointAt(path, tp, out) {
            const ts = path.t;
            const n = ts.length;
            let i = 0;
            let f = 0;
            if (n < 2) {
                f = 0;
            } else if (tp >= ts[n - 1]) {
                i = n - 2;
                f = 1;
            } else if (tp > 0) {
                let lo = 0;
                let hi = n - 1;
                while (hi - lo > 1) {
                    const mid = (lo + hi) >> 1;
                    if (ts[mid] <= tp) lo = mid;
                    else hi = mid;
                }
                i = lo;
                f = (tp - ts[lo]) / ((ts[hi] - ts[lo]) || 1);
            }
            const j = Math.min(i + 1, n - 1);
            out.x = path.x[i] + (path.x[j] - path.x[i]) * f;
            out.y = path.y[i] + (path.y[j] - path.y[i]) * f;
            out.vx = path.vx[i] + (path.vx[j] - path.vx[i]) * f;
            out.vy = path.vy[i] + (path.vy[j] - path.vy[i]) * f;
            return out;
        }

        // The part of the path the beam fills now (path times a..b), and whether it reaches the end
        function thSpan(path) {
            const a = Math.max(0, th.clock - th.offAt);
            const b = Math.min(path.tEnd, th.clock - th.onAt);
            const arrived = path.tEnd > 0 && th.clock - th.onAt >= path.tEnd && th.clock - th.offAt <= path.tEnd;
            return { a, b, arrived };
        }

        function thUpdateProbe(path, span) {
            const p = th.probe;
            if (!p) return;
            const tp = path.probeT;
            if (!(tp >= span.a && tp <= span.b)) {
                p.state = 'gone';
                return;
            }
            thPointAt(path, tp, p);
            p.state = 'free';
            p.t = tp;
        }

        function thUpdateReadout(path, span) {
            let value = '–';
            let unit = '';
            let dir = '';
            let speech = '';
            if (!(path.tEnd > 0)) {
                dir = 'no beam';
                speech = 'No beam.';
            } else if (!span.arrived) {
                if (!th.on) {
                    dir = 'beam off';
                    speech = 'Beam off.';
                }
            } else if (path.end === 'screen') {
                const cm = path.spotY * 100;
                value = Math.abs(cm).toFixed(2);
                unit = 'cm';
                dir = value === '0.00' ? '' : cm > 0 ? 'up' : 'down';
                speech = dir ? `Spot ${value} centimetres ${dir}.` : 'Spot at zero.';
            } else if (path.end === 'edge') {
                dir = 'misses';
                speech = 'The beam misses the screen.';
            } else {
                dir = 'hits a plate';
                speech = 'The beam hits a plate.';
            }
            setText('thSpot', value);
            setText('thSpotUnit', unit);
            setText('thSpotDir', dir);
            // Read the spot out once it stays put
            const now = performance.now();
            if (speech !== th.spotSpeech) {
                th.spotSpeech = speech;
                th.spotSince = now;
            } else if (speech && speech !== th.spotSaid && now - th.spotSince > TH_ANNOUNCE_MS) {
                th.spotSaid = speech;
                announce(speech);
            }
        }

        // ----- Drawing
        function thColors() {
            return isDarkMode() ? {
                beam: 'rgba(215, 238, 255, 0.9)', halo: 'rgba(150, 205, 255, 0.16)', dot: '#ffffff',
                glass: 'rgba(120, 255, 170, 0.14)', glassEdge: 'rgba(120, 255, 170, 0.6)',
                spot: '120, 255, 160', spotCore: '#f0fff4', hit: '220, 235, 255',
            } : {
                beam: 'rgba(40, 52, 70, 0.85)', halo: 'rgba(70, 95, 140, 0.13)', dot: '#26303e',
                glass: 'rgba(30, 170, 90, 0.12)', glassEdge: 'rgba(20, 135, 70, 0.65)',
                spot: '25, 190, 90', spotCore: '#0a6630', hit: '70, 85, 110',
            };
        }

        // The plates' length and gap, which Thomson knew from his apparatus
        function thDrawDimensions() {
            const thk = plateThickness();
            const x0 = px(0);
            const x1 = px(PLATE_L);
            ctx.save();
            ctx.strokeStyle = pal.faint;
            ctx.fillStyle = pal.muted;
            ctx.lineWidth = 1;
            ctx.font = font(fontPx - 1, 400);
            ctx.textBaseline = 'middle';
            // Length, under the lower plate's voltage label
            const yl = Math.round(py(-settings.gap / 2) + thk + fontPx + 13) + 0.5;
            const len = `${Math.round(PLATE_L * 100)} cm`;
            const half = ctx.measureText(len).width / 2 + 6;
            const xm = (x0 + x1) / 2;
            ctx.fillStyle = pal.bg; // Clears the field symbols from behind the label
            ctx.fillRect(xm - half + 2, yl - fontPx / 2 - 1, 2 * half - 4, fontPx + 2);
            ctx.fillStyle = pal.muted;
            ctx.beginPath();
            ctx.moveTo(x0, yl - 4);
            ctx.lineTo(x0, yl + 4);
            ctx.moveTo(x1, yl - 4);
            ctx.lineTo(x1, yl + 4);
            ctx.moveTo(x0, yl);
            ctx.lineTo(xm - half, yl);
            ctx.moveTo(xm + half, yl);
            ctx.lineTo(x1, yl);
            ctx.stroke();
            ctx.textAlign = 'center';
            ctx.fillText(len, xm, yl);
            // Gap, just before the plates
            const xg = Math.round(x0 - 9) + 0.5;
            const yT = py(settings.gap / 2);
            const yB = py(-settings.gap / 2);
            ctx.beginPath();
            ctx.moveTo(xg - 4, yT);
            ctx.lineTo(xg + 4, yT);
            ctx.moveTo(xg - 4, yB);
            ctx.lineTo(xg + 4, yB);
            ctx.moveTo(xg, yT);
            ctx.lineTo(xg, yB);
            ctx.stroke();
            ctx.textAlign = 'right';
            ctx.fillText(`${+(settings.gap * 100).toFixed(1)} cm`, xg - 6, py(settings.gap * 0.36));
            ctx.restore();
        }

        // The fluorescent screen across the end of the plates, with a millimetre scale numbered in cm
        function thDrawScreen(c) {
            const thk = plateThickness();
            const x = px(PLATE_L);
            const yT = py(settings.gap / 2) - thk;
            const yB = py(-settings.gap / 2) + thk;
            const w = clamp(scale * 0.0012, 4, 7);
            ctx.fillStyle = c.glass;
            ctx.fillRect(x, yT, w, yB - yT);
            ctx.strokeStyle = c.glassEdge;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x + 0.75, yT);
            ctx.lineTo(x + 0.75, yB);
            ctx.stroke();
            const sx = Math.round(x + w + 2);
            const step = scale * 0.001 >= 3 ? 1 : 5; // mm between ticks
            const lim = Math.floor((settings.gap / 2) * 1000 + 1e-6);
            ctx.strokeStyle = pal.muted;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let k = -lim; k <= lim; k += step) {
                const len = k % 10 === 0 ? 9 : k % 5 === 0 ? 6 : 3.5;
                const y = Math.round(py(k / 1000)) + 0.5;
                ctx.moveTo(sx, y);
                ctx.lineTo(sx + len, y);
            }
            ctx.stroke();
            ctx.fillStyle = pal.muted;
            ctx.font = font(fontPx - 1, 400);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            for (let k = -lim + (lim % 10); k <= lim; k += 10) {
                ctx.fillText(k === lim - (lim % 10) ? `${k / 10} cm` : String(Math.abs(k / 10)), sx + 12, py(k / 1000));
            }
        }

        function thDrawBeam(c, path, span) {
            const { a, b } = span;
            if (!(b > a)) return;
            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            thPointAt(path, a, thPt);
            ctx.moveTo(px(thPt.x), py(thPt.y));
            const ts = path.t;
            for (let i = 0; i < ts.length; i++) {
                if (ts[i] > a && ts[i] < b) ctx.lineTo(px(path.x[i]), py(path.y[i]));
            }
            thPointAt(path, b, thPt);
            ctx.lineTo(px(thPt.x), py(thPt.y));
            ctx.strokeStyle = c.halo;
            ctx.lineWidth = clamp(scale * 0.0015, 5, 8);
            ctx.stroke();
            ctx.strokeStyle = c.beam;
            ctx.lineWidth = 1.5;
            ctx.stroke();
            // Dots streaming along at equal times, like the particles' strobe trails
            const step = STROBE_S * currentRate();
            if (step > 0) {
                ctx.fillStyle = c.dot;
                ctx.beginPath();
                for (let tp = th.clock % step; tp <= b; tp += step) {
                    if (tp < a) continue;
                    thPointAt(path, tp, thPt);
                    const x = px(thPt.x);
                    const y = py(thPt.y);
                    ctx.moveTo(x + 2.2, y);
                    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
                }
                ctx.fill();
            }
            ctx.restore();
        }

        function thGlow(x, y, r, rgb, core, coreR) {
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, `rgba(${rgb}, 0.95)`);
            g.addColorStop(0.3, `rgba(${rgb}, 0.6)`);
            g.addColorStop(1, `rgba(${rgb}, 0)`);
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = core;
            ctx.beginPath();
            ctx.arc(x, y, coreR, 0, Math.PI * 2);
            ctx.fill();
        }

        // ----- The answer
        const TH_SUPS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' };

        // A number typed as 1.76e11, 1.76x10^11, 1.76 × 10¹¹, 1.76*10**11 or 176000000000 (NaN if it isn't one)
        function thParse(text) {
            let s = String(text || '').toLowerCase()
                .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]/g, (ch) => TH_SUPS[ch])
                .replace(/[−–]/g, '-')
                .replace(/\s+/g, '')
                .replace(/c\/kg$/, '');
            // Commas: thousands separators (176,000,000,000) or a decimal comma (1,76e11)
            s = /^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(s) ? s.replace(/,/g, '') : s.replace(/,/g, '.');
            const num = '([+-]?(?:\\d+\\.?\\d*|\\.\\d+))';
            let m = s.match(new RegExp(`^${num}(?:[x×*·⋅]10(?:\\^|\\*\\*)?([+-]?\\d+))?$`));
            if (m) return parseFloat(m[1]) * (m[2] === undefined ? 1 : Math.pow(10, parseInt(m[2], 10)));
            m = s.match(new RegExp(`^${num}e([+-]?\\d+)$`));
            if (m) return parseFloat(m[1]) * Math.pow(10, parseInt(m[2], 10));
            m = s.match(/^10(?:\^|\*\*)([+-]?\d+)$/);
            if (m) return Math.pow(10, parseInt(m[1], 10));
            return NaN;
        }

        function thKnownText(key) {
            const b = TH_BEAMS[key];
            const other = key === 'cathode' ? 'hydrogen' : 'cathode';
            const value = fmtSci(b.qm, 2).replace('×', ' × ');
            const next = th.answers[other].known ? TH_DISCOVERY : `Now try ${TH_BEAMS[other].name.toLowerCase()}.`;
            return `${b.name}: q/m ≈ ${value} C/kg. ${next}`;
        }

        // Show a message under the answer; clearing it first makes a screen reader read a repeated one again
        function thSay(text) {
            const el = thEl.feedback;
            if (!el) return;
            th.answers[th.beam].msg = text;
            el.textContent = '';
            setTimeout(() => { if (th.answers[th.beam].msg === text) el.textContent = text; }, 60);
        }

        function thCheck() {
            const a = th.answers[th.beam];
            a.text = thEl.input ? thEl.input.value : '';
            const v = Math.abs(thParse(a.text));
            if (!(v > 0 && isFinite(v))) {
                thSay('Type a number, like 4.2e9 or 4.2 × 10^9.');
                return;
            }
            const ratio = v / TH_BEAMS[th.beam].qm;
            const pow = Math.round(Math.log10(ratio));
            if (Math.abs(ratio - 1) <= TH_TOLERANCE) {
                a.known = true;
                thSay(`Right! ${thKnownText(th.beam)}`);
            } else {
                a.tries++;
                if (pow !== 0 && Math.abs(ratio / Math.pow(10, pow) - 1) <= TH_TOLERANCE) thSay('Not quite: out by a power of ten. Check your units.');
                else thSay(`Not within 5%: too ${ratio > 1 ? 'big' : 'small'}.`);
            }
            setHidden('thRevealBtn', a.known || a.tries < TH_TRIES);
        }

        function thReveal() {
            th.answers[th.beam].known = true;
            thSay(thKnownText(th.beam));
            setHidden('thRevealBtn', true);
            if (thEl.input) thEl.input.focus();
        }

        function thSyncBeamUI() {
            if (thEl.syncChips) thEl.syncChips(th.beam);
            const a = th.answers[th.beam];
            setText('thAnswerBeam', TH_BEAMS[th.beam].name);
            if (thEl.input) thEl.input.value = a.text;
            if (a.known) a.msg = thKnownText(th.beam);
            if (thEl.feedback) thEl.feedback.textContent = a.msg;
            setHidden('thRevealBtn', a.known || a.tries < TH_TRIES);
        }

        features.push({
            init() {
                thEl.input = $('thAnswerInput');
                thEl.feedback = $('thFeedback');
                const aim = $('aimGuideToggle');
                const values = $('valuesToggle');
                thEl.hideInThomson = [
                    document.querySelector('#launchGroup .ch-seg-panel'),
                    aim && aim.closest('.sim-checkbox-group'),
                    values,
                    document.querySelector('label[for="valuesToggle"]'),
                    document.querySelector('.sim-show-charts-label'),
                ].filter(Boolean);
                thEl.syncChips = radioGroup(document.querySelectorAll('#beamGroup .ch-chip'), (b) => b.dataset.beam, (k) => thSetBeam(k));
                thEl.syncChips(th.beam);
                const metal = $('cathodeSelect');
                if (metal) metal.addEventListener('change', () => { if (th.active) thRestartBeam(); });
                const form = $('thAnswerForm');
                if (form) form.addEventListener('submit', (e) => { e.preventDefault(); thCheck(); });
                const reveal = $('thRevealBtn');
                if (reveal) reveal.addEventListener('click', () => thReveal());
                thSnapshotFree();
                Object.assign(window.chargesSim, {
                    thomson: {
                        get active() { return th.active; },
                        get beam() { return th.beam; },
                        get on() { return th.on; },
                        get answers() { return th.answers; },
                        // Where the beam meets the screen (m, up positive), or null if it doesn't
                        spot() {
                            const p = thEnsurePath();
                            return p.end === 'screen' ? p.spotY : null;
                        },
                        path() {
                            const p = thEnsurePath();
                            return { end: p.end, tEnd: p.tEnd, spotY: p.spotY, endX: p.x[p.x.length - 1], points: p.t.length };
                        },
                        setBeam: thSetBeam,
                        beamOn: thSetBeamOn,
                        parse: thParse,
                        check(text) {
                            if (thEl.input) thEl.input.value = text;
                            thCheck();
                            return th.answers[th.beam].msg;
                        },
                        qm: (key) => TH_BEAMS[key].qm,
                    },
                });
            },
            onSetup(name) {
                if (name === 'thomson') thEnter();
                else if (th.active) thLeave();
            },
            onSettings() {
                if (th.active) th.dirty = true;
                else thSnapshotFree();
            },
            reset() {
                if (!th.active) return;
                selected = th.probe;
                thRestartBeam();
            },
            frame(realDt, simDt) {
                if (!th.active) {
                    thSnapshotFree();
                    return;
                }
                th.clock += simDt;
                const path = thEnsurePath();
                const span = thSpan(path);
                thUpdateProbe(path, span);
                thUpdateReadout(path, span);
            },
            fire() {
                if (!th.active) return false;
                thSetBeamOn(!th.on);
                return true;
            },
            obstacles(list) {
                if (th.active) list.push({ x0: PLATE_L, y0: -TH_SCREEN_HALF, x1: PLATE_L, y1: TH_SCREEN_HALF, name: 'screen' });
            },
            drawMid() {
                if (!th.active) return;
                const c = thColors();
                const path = thEnsurePath();
                const span = thSpan(path);
                thDrawDimensions();
                thDrawScreen(c);
                thDrawBeam(c, path, span);
                if (span.arrived) {
                    const n = path.x.length - 1;
                    if (path.end === 'screen') thGlow(px(PLATE_L) + 1, py(path.spotY), 13, c.spot, c.spotCore, 2.6);
                    else thGlow(px(path.x[n]), py(path.y[n]), 7, c.hit, c.dot, 1.6);
                }
                // The probe: the beam particle the arrows belong to
                const p = th.probe;
                if (p && p.state === 'free' && (settings.show.velocity || settings.show.force || settings.show.components)) {
                    ctx.strokeStyle = c.beam;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(px(p.x), py(p.y), 4.5, 0, Math.PI * 2);
                    ctx.stroke();
                }
            },
        });
    }
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
