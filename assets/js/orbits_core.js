/*
 * Orbits & Gravity simulation - Newtonian n-body gravity in 2D.
 *
 * Units: distances in AU, times in (Julian) years, masses in solar masses, so G = 4 pi^2 and a planet
 * 1 AU from a 1 M_sun star takes one year per orbit. Readouts convert to km, km/s, kg and N.
 *
 * Integration: kick-drift-kick leapfrog (symplectic and time-reversible) with one adaptive step for all
 *   bodies, dt = ETA * min over pairs of sqrt(r^3 / G(m_i + m_j)), so a close pass is taken in many
 *   small steps. Leftover frame time carries over to the next frame (no step is ever cut short), and the
 *   bodies are drawn extrapolated by that leftover so the motion stays smooth. If a close pass needs more
 *   steps than a frame allows, the simulation slows down for a moment instead of losing accuracy.
 *   Bodies whose real radii touch (checked along each step) merge, conserving mass and momentum.
 *
 * Frames: the view follows the centre of mass (an inertial frame) or is locked on a body. Trails are
 *   stored in inertial coordinates at shared sample times, so they can be redrawn relative to any body.
 *
 * Each body's "primary" is the body it orbits: the most local heavier body that it is bound to and is
 *   inside the Hill sphere of (the Moon orbits Earth even though the Sun pulls it harder). Readouts, the
 *   eccentricity slider and Kepler's laws use the motion relative to the primary, a two-body orbit with
 *   mu = G (m + M). Kepler's 2nd law areas and 3rd law periods are measured from the simulated motion.
 */
(function () {
    'use strict';

    const canvas = document.getElementById('simulationCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (!canvas || !ctx) {
        console.error('Orbits simulation: canvas #simulationCanvas not found.');
        return;
    }

    const byId = (id) => document.getElementById(id);
    const ui = {
        speed: byId('speedSlider'), speedVal: byId('speedVal'),
        scene: byId('sceneSelect'),
        orbitGroupLabel: byId('orbitGroupLabel'), ecc: byId('eccSlider'), eccVal: byId('eccVal'), eccName: byId('eccName'),
        eccNote: byId('eccNote'),
        forces: byId('forceToggle'), velocities: byId('velocityToggle'), labels: byId('labelsToggle'),
        k1: byId('kepler1Toggle'), k2: byId('kepler2Toggle'), k3: byId('kepler3Toggle'),
        frame: byId('frameSelect'), trail: byId('trailSlider'), trailVal: byId('trailVal'),
        placement: byId('placementSelect'), com: byId('comToggle'), preview: byId('previewToggle'), merge: byId('mergeToggle'),
        frameChip: byId('frameChip'), frameChipName: byId('frameChipName'),
        palette: byId('bodyPalette'), fit: byId('fitViewBtn'), hint: byId('orbHint'),
        subjectDot: byId('statSubjectDot'), subjectName: byId('statSubjectName'), subjectAround: byId('statSubjectAround'),
        statTime: byId('statTime'), statTimeUnit: byId('statTimeUnit'),
        statDist: byId('statDist'), statDistUnit: byId('statDistUnit'),
        statSpeed: byId('statSpeed'), statForce: byId('statForce'),
        pause: byId('pauseBtn'), reset: byId('resetSimulationBtn'),
        showCharts: byId('showCharts'), chartsContainer: byId('charts-container'),
        fps: byId('fpsDisplay'),
        pop: byId('bodyPopover'), popDot: byId('popDot'), popName: byId('popName'), popClose: byId('popClose'),
        popLock: byId('popLock'), popLockText: byId('popLockText'), popCircular: byId('popCircular'), popDelete: byId('popDelete'),
        popMass: byId('popMass'), popMassVal: byId('popMassVal'),
        popSpeed: byId('popSpeed'), popSpeedVal: byId('popSpeedVal'), popSpeedNote: byId('popSpeedNote'),
        popRadius: byId('popRadius'), popRadiusVal: byId('popRadiusVal'),
        popColours: byId('popColours'), popInfo: byId('popInfo')
    };

    // ------------------------------------------------------------------
    // Constants and units
    // ------------------------------------------------------------------
    const TAU = Math.PI * 2;
    const G = 4 * Math.PI * Math.PI;      // AU^3 / (M_sun yr^2)
    const AU_KM = 1.495978707e8;
    const AU_M = AU_KM * 1000;
    const YEAR_S = 3.15576e7;             // Julian year
    const DAYS_PER_YEAR = 365.25;
    const MSUN_KG = 1.98847e30;
    const MEARTH = 3.003489e-6;           // Earth masses per solar mass (as a fraction of M_sun)
    const MJUP = 9.547919e-4;
    const G_SI = 6.6743e-11;
    const AUYR_KMS = AU_KM / YEAR_S;      // 4.74 km/s per AU/yr
    const ENERGY_J = MSUN_KG * (AU_M / YEAR_S) * (AU_M / YEAR_S); // J per M_sun AU^2 / yr^2

    const ETA = 0.006;                    // step = ETA x the shortest pair free-fall time (~1000 steps per circular orbit)
    const MAX_STEPS_PER_FRAME = 4000;
    const MAX_BODIES = 30;
    const SECONDS_PER_TREF = 6;           // real seconds per reference period of the scene at 1x
    const TRAIL_PER_TREF = 300;           // trail samples per reference period
    const TRAIL_CAP = 6144;               // samples kept per body (20 reference periods)
    const TRAIL_STEPS = [0, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20]; // trail lengths in reference periods
    const K2_SECTORS = 12;                // Kepler's 2nd law: sectors per orbit
    const STAR_MASS = 0.07;               // M_sun: heavier bodies are drawn as stars

    // Sample bodies for the palette (and the scenes). Radii are real (km); the drawn size is compressed.
    const KINDS = {
        sun: { name: 'Sun', m: 1, R: 696000, color: '#ffd166' },
        dwarf: { name: 'Red dwarf', m: 0.3, R: 210000, color: '#ff8a5c' },
        jupiter: { name: 'Jupiter', m: MJUP, R: 69911, color: '#e0b48a' },
        earth: { name: 'Earth', m: MEARTH, R: 6371, color: '#7ecaf6' },
        mars: { name: 'Mars', m: 0.10745 * MEARTH, R: 3390, color: '#e8825e' },
        moon: { name: 'Moon', m: 0.0123 * MEARTH, R: 1737, color: '#c9ccd3' },
        comet: { name: 'Comet', m: 1.1e-16, R: 6, color: '#a5e8ff' },
        asteroid: { name: 'Asteroid', m: 4.7e-10, R: 470, color: '#a89f91' },
        custom: { name: 'Planet', m: MEARTH, R: 6371, color: '#ae85ca' },
        mercury: { name: 'Mercury', m: 0.0553 * MEARTH, R: 2440, color: '#b5aca3' },
        venus: { name: 'Venus', m: 0.815 * MEARTH, R: 6052, color: '#f0d9a0' },
        probe: { name: 'Probe', m: 4e-28, R: 0.005, color: '#e8e8e8' }
    };
    const PALETTE = ['sun', 'dwarf', 'jupiter', 'earth', 'mars', 'moon', 'comet', 'asteroid', 'custom'];
    const SWATCHES = ['#ffd166', '#ff8a5c', '#f2849e', '#c75b9b', '#ae85ca', '#8499e7', '#7ecaf6', '#7bd0c1', '#e0b48a', '#c9ccd3'];
    // Values the mass and radius sliders snap to
    const MASS_SNAPS = [KINDS.moon.m, KINDS.mars.m, MEARTH, MJUP, 0.3, 1];
    const RADIUS_SNAPS = [1737, 3390, 6371, 69911, 210000, 696000];

    // ------------------------------------------------------------------
    // Scenes. Bodies are given directly or by orbit elements around an earlier body
    // (a in AU, e, w = direction of the closest point in degrees, nu = start angle from it).
    // Every scene starts with the centre of mass at rest at the origin.
    // ------------------------------------------------------------------
    const SCENES = {
        'sun-earth': {
            units: 'au', Tref: 1, arrow: 0.05, subject: 1, box: [-1.2, 1.2, -1.2, 1.2],
            bodies: [{ kind: 'sun' }, { kind: 'earth', orbit: { around: 0, a: 1, e: 0, nu: 0 } }]
        },
        ellipse: {
            units: 'au', Tref: 1, arrow: 0.05, subject: 1, box: [-1.65, 0.45, -0.9, 0.9],
            bodies: [{ kind: 'sun' }, { kind: 'earth', name: 'Planet', orbit: { around: 0, a: 1, e: 0.6, w: 0, nu: 180 } }]
        },
        inner: {
            units: 'au', Tref: 1, arrow: 0.03, subject: 3, box: [-1.7, 1.7, -1.7, 1.7],
            bodies: [
                { kind: 'sun' },
                { kind: 'mercury', orbit: { around: 0, a: 0.387, e: 0.2056, w: 77, nu: 40 } },
                { kind: 'venus', orbit: { around: 0, a: 0.723, e: 0.0068, w: 131, nu: 60 } },
                { kind: 'earth', orbit: { around: 0, a: 1, e: 0.0167, w: 103, nu: 130 } },
                { kind: 'mars', orbit: { around: 0, a: 1.524, e: 0.0934, w: 336, nu: 240 } }
            ]
        },
        comet: {
            units: 'au', Tref: 1, arrow: 0.06, subject: 2, forceBody: 1, trail: 6, box: [-3.85, 1.15, -1.2, 1.2],
            bodies: [
                { kind: 'sun' },
                { kind: 'earth', orbit: { around: 0, a: 1, e: 0.0167, nu: 200 } },
                { kind: 'comet', orbit: { around: 0, a: 2, e: 0.85, w: 0, nu: 150 } }
            ]
        },
        'earth-moon': {
            units: 'km', Tref: 27.32 / DAYS_PER_YEAR, arrow: 0.08, subject: 1, box: [-0.0031, 0.0031, -0.0031, 0.0031],
            bodies: [{ kind: 'earth' }, { kind: 'moon', orbit: { around: 0, a: 384400 / AU_KM, e: 0.0549, nu: 0 } }]
        },
        moon: {
            units: 'au', Tref: 1, arrow: 0.03, subject: 2, trail: 4, box: [-1.15, 1.15, -1.15, 1.15],
            // A heavy giant planet (31 Jupiters) so its moon can orbit at a visible distance: 0.065 AU is
            // 0.3 of its Hill radius, where the star hardly disturbs the moon.
            bodies: [
                { kind: 'sun', name: 'Star' },
                { kind: 'jupiter', name: 'Giant planet', m: 0.03, R: 70000, orbit: { around: 0, a: 1, e: 0, nu: 0 } },
                { kind: 'moon', m: MEARTH, R: 3000, orbit: { around: 1, a: 0.065, e: 0, nu: 90 } }
            ]
        },
        binary: {
            units: 'au', Tref: 2.31, arrow: 0.06, subject: 1, com: true, box: [-1.9, 1.9, -1.3, 1.3],
            bodies: [
                { kind: 'sun', name: 'Star A' },
                { kind: 'dwarf', name: 'Star B', m: 0.5, R: 400000, orbit: { around: 0, a: 2, e: 0.4, w: 0, nu: 0 } }
            ]
        },
        figure8: {
            units: 'au', Tref: 1.0067, arrow: 0.05, subject: 0, trail: 4, box: [-1.1, 1.1, -0.45, 0.45],
            bodies: (function () {
                // Chenciner & Montgomery's figure-of-eight orbit (G = m = 1), scaled to 1 AU and 1 M_sun.
                const vs = Math.sqrt(G);           // velocity unit: AU/yr
                const x1 = 0.97000436, y1 = -0.24308753, vx3 = -0.93240737, vy3 = -0.86473146;
                return [
                    { kind: 'sun', name: 'Star A', at: [x1, y1], v: [-vx3 / 2 * vs, -vy3 / 2 * vs] },
                    { kind: 'sun', name: 'Star B', color: '#f2849e', at: [-x1, -y1], v: [-vx3 / 2 * vs, -vy3 / 2 * vs] },
                    { kind: 'sun', name: 'Star C', color: '#7ecaf6', at: [0, 0], v: [vx3 * vs, vy3 * vs] }
                ];
            })()
        },
        // A probe leaves Earth's distance on a bound orbit (41.6 km/s), passes 0.021 AU behind Jupiter
        // after 1.17 years and is flung out of the solar system at 8 km/s.
        slingshot: {
            units: 'au', Tref: 2, arrow: 0.06, subject: 2, forceBody: 1, trail: 6, box: [-6.2, 6.2, -5.6, 5.6],
            bodies: [
                { kind: 'sun' },
                { kind: 'jupiter', orbit: { around: 0, a: 5.2, e: 0, nu: 0, w: 95.8 } },
                { kind: 'probe', at: [1, 0], v: [0, 8.77] }
            ]
        },
        empty: {
            units: 'au', Tref: 1, arrow: 0.08, subject: 0, box: [-1.5, 1.5, -1.5, 1.5],
            bodies: [{ kind: 'sun' }]
        }
    };

    // ------------------------------------------------------------------
    // Settings and state
    // ------------------------------------------------------------------
    const settings = {
        speed: 1,
        scene: 'sun-earth',
        forces: true,
        velocities: true,
        labels: true,
        k1: false, k2: false, k3: false,
        trailIndex: 4,
        placement: 'circular',
        com: false,
        preview: true,
        merge: true
    };

    let scene = SCENES['sun-earth'];
    let bodies = [];
    let nextId = 1;
    let simTime = 0;          // years
    let acc = 0;              // simulated time owed to the integrator (carried between frames)
    let nextDt = 0.001;       // adaptive step for the next leapfrog step
    let forcesDirty = true;
    let paused = false;
    let slowedDown = false;   // the last frame hit the step limit
    let selectedId = null;    // the body the readouts and Kepler overlays are about
    let frameId = null;       // null = centre of mass, else the id of the body the view is locked on
    let freeze = null;        // frozen frame origin while dragging a body the frame depends on
    let forceRef = 1;         // N: force drawn as a medium-length arrow
    let energyExp = 33;       // charts: energies in units of 10^energyExp J
    let lastFrameTs = 0;
    let cleanRender = false;  // no scale bar, notes, cards or numbers (for still images of the canvas)

    // Trails: samples of every body (and the centre of mass) at shared times
    let sampleDt = 1 / TRAIL_PER_TREF;
    let sampleCount = 0;
    let nextSampleT = 0;
    const comTrail = new Float64Array(TRAIL_CAP * 2);

    // View: px per AU = zoom * min(canvas width, height), so the scene scales with the canvas
    const view = { zoom: 0.4, panX: 0, panY: 0, anim: null };
    let viewW = 0, viewH = 0, dpr = 1;
    let scale = 1;            // px per AU (this frame)
    let sizeScale = 1;        // drawn body sizes and arrows scale a little with the canvas
    let lag = 0;              // years: bodies are drawn extrapolated by the leftover time
    let F = { x: 0, y: 0 };   // frame origin this frame (world coordinates)
    const flashes = [];       // merge flashes

    // Kepler's 2nd law (subject's sectors) and per-body period tracking live in k2 / body.track
    const k2 = { bid: null, pid: null, dt: 0, tNext: 0, sectors: [], cur: null, lastT: 0, lastX: 0, lastY: 0, lastAng: 0 };

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const isDark = () => document.documentElement.classList.contains('dark-mode');
    const isStar = (b) => b.m >= STAR_MASS;
    const bodyById = (id) => { for (const b of bodies) if (b.id === id) return b; return null; };
    const rate = () => scene.Tref / SECONDS_PER_TREF;           // simulated years per real second at 1x
    const arrowTime = () => scene.arrow * scene.Tref;           // a velocity arrow shows the path over this time
    const trailYears = () => TRAIL_STEPS[settings.trailIndex] * scene.Tref;

    const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
    function fmtSci(x, digits) {
        if (!isFinite(x)) return '–';
        if (x === 0) return '0';
        let exp = Math.floor(Math.log10(Math.abs(x)));
        let mant = x / Math.pow(10, exp);
        if (Math.abs(+mant.toFixed(digits)) >= 10) { mant /= 10; exp += 1; }
        return `${mant.toFixed(digits)}×10${String(exp).split('').map((c) => SUP[c]).join('')}`;
    }
    // Three significant figures, plain for moderate values
    function fmtSig(x) {
        const ax = Math.abs(x);
        if (ax === 0) return '0';
        if (ax >= 1e6 || ax < 1e-3) return fmtSci(x, 2);
        if (ax >= 1000) return Math.round(x).toLocaleString('en-US');
        if (ax >= 100) return x.toFixed(1);
        if (ax >= 10) return x.toFixed(2);
        if (ax >= 1) return x.toFixed(2);
        return x.toPrecision(3);
    }
    function fmtMass(m) {
        if (m >= 0.008) return `${fmtSig(m)} M☉`;
        return `${fmtSig(m / MEARTH)} M⊕`;
    }
    function fmtKm(km) {
        if (km >= 1e8) return fmtSci(km, 2);
        if (km >= 100) return Math.round(km).toLocaleString('en-US');
        if (km >= 1) return km.toFixed(1);
        return km.toFixed(3);
    }
    // Distance readout: AU in the AU scenes (km when tiny), km in the Earth-Moon scene
    function fmtDistance(au) {
        if (scene.units === 'km' || au < 0.01) return { v: fmtKm(au * AU_KM), u: 'km' };
        if (au < 10) return { v: au.toFixed(3), u: 'AU' };
        if (au < 1000) return { v: au.toFixed(1), u: 'AU' };
        return { v: fmtSci(au, 2), u: 'AU' };
    }
    function fmtTime(yr) {
        if (scene.units === 'km') {
            const d = yr * DAYS_PER_YEAR;
            return { v: d < 1000 ? d.toFixed(1) : Math.round(d).toLocaleString('en-US'), u: 'days' };
        }
        return { v: yr < 100 ? yr.toFixed(2) : yr < 1000 ? yr.toFixed(1) : Math.round(yr).toString(), u: 'yr' };
    }
    // A duration in days or years; precise keeps trailing zeros (a measured period: "1.00 yr")
    function fmtDuration(yr, precise) {
        if (scene.units === 'km' || yr < 0.1) {
            const d = yr * DAYS_PER_YEAR;
            if (precise) return `${d < 100 ? d.toFixed(1) : Math.round(d)} days`;
            return `${d < 10 ? d.toFixed(1) : Math.round(d)} ${d < 1.5 && d >= 0.5 ? 'day' : 'days'}`;
        }
        if (precise) return `${yr < 100 ? yr.toFixed(2) : Math.round(yr)} yr`;
        return `${yr < 10 ? +yr.toFixed(2) : Math.round(yr)} yr`;
    }
    function fmtSpeedKms(kms) {
        if (kms < 0.1) return { v: (kms * 1000).toFixed(kms < 0.01 ? 2 : 1), u: 'm/s' };
        return { v: kms < 10 ? kms.toFixed(2) : kms < 1000 ? kms.toFixed(1) : Math.round(kms).toString(), u: 'km/s' };
    }
    // Apsis names: perihelion around the Sun, perigee around Earth, periastron around other stars
    function apsisNames(p) {
        if (!p) return ['periapsis', 'apoapsis'];
        if (p.name === 'Sun') return ['perihelion', 'aphelion'];
        if (p.name === 'Earth') return ['perigee', 'apogee'];
        if (isStar(p)) return ['periastron', 'apastron'];
        return ['periapsis', 'apoapsis'];
    }

    // ------------------------------------------------------------------
    // Bodies
    // ------------------------------------------------------------------
    function newBody(props) {
        return {
            id: nextId++,
            name: props.name, kind: props.kind || 'custom', color: props.color,
            m: props.m, R: props.R,
            x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, px: 0, py: 0,
            dx: 0, dy: 0,                 // drawn position (extrapolated)
            held: null,                   // { offX, offY } while dragged: position relative to the frame origin
            trail: new Float64Array(TRAIL_CAP * 2),
            trailStart: sampleCount,      // first valid sample
            primary: null, bound: false, hill: Infinity,
            fx: 0, fy: 0,                 // net gravitational force (M_sun AU / yr^2)
            track: null                   // period measurement (Kepler's 3rd law)
        };
    }

    // Place child on an orbit around parent, keeping the pair's centre of mass where the parent was.
    function placeOnOrbit(child, parent, o) {
        const mu = G * (parent.m + child.m);
        const e = o.e || 0, a = o.a;
        const w = ((o.w || 0) * Math.PI) / 180, nu = ((o.nu || 0) * Math.PI) / 180;
        const dir = o.retro ? -1 : 1;
        const p = a * (1 - e * e);
        const r = p / (1 + e * Math.cos(nu));
        const qx = r * Math.cos(nu), qy = dir * r * Math.sin(nu);
        const s = Math.sqrt(mu / p);
        const qvx = -s * Math.sin(nu), qvy = dir * s * (e + Math.cos(nu));
        const cw = Math.cos(w), sw = Math.sin(w);
        setPairRelative(child, parent, cw * qx - sw * qy, sw * qx + cw * qy, cw * qvx - sw * qvy, sw * qvx + cw * qvy,
            parent.x, parent.y, parent.vx, parent.vy);
    }

    // Two-body placement: child relative to parent by (rx, ry, rvx, rvy), with the pair's centre of mass
    // at (cx, cy) moving at (cvx, cvy).
    function setPairRelative(child, parent, rx, ry, rvx, rvy, cx, cy, cvx, cvy) {
        const M = parent.m + child.m;
        const fc = parent.m / M, fp = child.m / M;
        child.x = cx + fc * rx; child.y = cy + fc * ry;
        child.vx = cvx + fc * rvx; child.vy = cvy + fc * rvy;
        parent.x = cx - fp * rx; parent.y = cy - fp * ry;
        parent.vx = cvx - fp * rvx; parent.vy = cvy - fp * rvy;
    }

    function totals(list) {
        let M = 0, X = 0, Y = 0, PX = 0, PY = 0;
        for (const b of list) { M += b.m; X += b.m * b.x; Y += b.m * b.y; PX += b.m * b.vx; PY += b.m * b.vy; }
        return M > 0 ? { M, x: X / M, y: Y / M, vx: PX / M, vy: PY / M } : { M: 0, x: 0, y: 0, vx: 0, vy: 0 };
    }

    function uniqueName(base) {
        if (!bodies.some((b) => b.name === base)) return base;
        for (let i = 2; ; i++) {
            const n = `${base} ${i}`;
            if (!bodies.some((b) => b.name === n)) return n;
        }
    }

    // ------------------------------------------------------------------
    // Physics
    // ------------------------------------------------------------------
    // Accelerations of the free bodies, net forces for the arrows, and the next adaptive step.
    function computeForces() {
        const n = bodies.length;
        for (const b of bodies) { b.ax = 0; b.ay = 0; }
        let tmin = Infinity;
        for (let i = 0; i < n; i++) {
            const bi = bodies[i];
            for (let j = i + 1; j < n; j++) {
                const bj = bodies[j];
                const dx = bj.x - bi.x, dy = bj.y - bi.y;
                const r2 = dx * dx + dy * dy;
                if (r2 === 0) continue;
                const r = Math.sqrt(r2);
                const ir3 = 1 / (r2 * r);
                const si = G * bj.m * ir3, sj = G * bi.m * ir3;
                bi.ax += si * dx; bi.ay += si * dy;
                bj.ax -= sj * dx; bj.ay -= sj * dy;
                const msum = bi.m + bj.m;
                if (msum > 0) {
                    const t = r2 * r / (G * msum);
                    if (t < tmin) tmin = t;
                }
            }
        }
        for (const b of bodies) { b.fx = b.m * b.ax; b.fy = b.m * b.ay; }
        nextDt = Math.min(ETA * Math.sqrt(tmin), sampleDt);
        forcesDirty = false;
    }

    // One kick-drift-kick leapfrog step for every body that isn't held.
    function leapfrog(dt) {
        const h = 0.5 * dt;
        for (const b of bodies) {
            b.px = b.x; b.py = b.y;
            if (b.held) continue;
            b.vx += h * b.ax; b.vy += h * b.ay;
            b.x += dt * b.vx; b.y += dt * b.vy;
        }
        computeForces();
        for (const b of bodies) {
            if (b.held) continue;
            b.vx += h * b.ax; b.vy += h * b.ay;
        }
    }

    // Bodies whose real radii touched during the last step (closest approach along the straight
    // path between the old and new positions) merge into one, conserving mass and momentum.
    function checkMerges() {
        if (!settings.merge) return false;
        let merged = false;
        let again = true;
        while (again) {
            again = false;
            scan:
            for (let i = 0; i < bodies.length; i++) {
                for (let j = i + 1; j < bodies.length; j++) {
                    const a = bodies[i], b = bodies[j];
                    if (a.held || b.held) continue;
                    const reach = (a.R + b.R) / AU_KM;
                    const x0 = b.px - a.px, y0 = b.py - a.py;
                    const x1 = b.x - a.x, y1 = b.y - a.y;
                    const ex = x1 - x0, ey = y1 - y0;
                    const ee = ex * ex + ey * ey;
                    const t = ee > 0 ? clamp(-(x0 * ex + y0 * ey) / ee, 0, 1) : 1;
                    const cx = x0 + t * ex, cy = y0 + t * ey;
                    if (cx * cx + cy * cy < reach * reach) {
                        mergeBodies(a, b);
                        merged = again = true;
                        break scan;   // the list changed: scan again
                    }
                }
            }
        }
        if (merged) computeForces();
        return merged;
    }

    function mergeBodies(a, b) {
        const big = a.m >= b.m ? a : b, small = big === a ? b : a;
        const M = a.m + b.m;
        const fx = M > 0 ? (a.m * a.x + b.m * b.x) / M : big.x, fy = M > 0 ? (a.m * a.y + b.m * b.y) / M : big.y;
        flashes.push({ x: fx, y: fy, t: performance.now(), color: big.color, r0: drawRadius(big) });
        big.vx = M > 0 ? (a.m * a.vx + b.m * b.vx) / M : big.vx;
        big.vy = M > 0 ? (a.m * a.vy + b.m * b.vy) / M : big.vy;
        big.x = fx; big.y = fy;
        big.m = M;
        big.R = Math.cbrt(a.R * a.R * a.R + b.R * b.R * b.R);   // same density
        big.track = null;
        removeBody(small, big);
    }

    // Advance the simulation by simDt years (as many whole adaptive steps as fit).
    function advance(simDt, maxSteps) {
        if (forcesDirty) computeForces();
        acc += simDt;
        let steps = 0;
        const limit = maxSteps || MAX_STEPS_PER_FRAME;
        while (steps < limit) {
            const dt = nextDt;
            if (!(dt > 0) || acc < dt) break;
            leapfrog(dt);
            simTime += dt;
            acc -= dt;
            steps++;
            if (checkMerges()) { refreshBodyLists(); }
            trackPeriods(simTime);
            k2Step(simTime);
            while (simTime >= nextSampleT) {
                recordSample();
                nextSampleT += sampleDt;
            }
        }
        slowedDown = steps >= limit;
        if (slowedDown) acc = 0;   // couldn't keep up: slow down rather than take bigger steps
        return steps;
    }

    // ------------------------------------------------------------------
    // Orbits relative to a body's primary
    // ------------------------------------------------------------------
    function relElements(rx, ry, vx, vy, mu) {
        const r = Math.hypot(rx, ry);
        const v2 = vx * vx + vy * vy;
        const h = rx * vy - ry * vx;
        const rv = rx * vx + ry * vy;
        const k = v2 - mu / r;
        const ex = (k * rx - rv * vx) / mu, ey = (k * ry - rv * vy) / mu;
        const e = Math.hypot(ex, ey);
        const energy = 0.5 * v2 - mu / r;
        const a = -mu / (2 * energy);
        const bound = energy < 0;
        return {
            r, v: Math.sqrt(v2), h, e, ex, ey, energy, a, bound, mu,
            p: (h * h) / mu,
            w: e > 1e-9 ? Math.atan2(ey, ex) : Math.atan2(ry, rx),
            T: bound ? TAU * Math.sqrt((a * a * a) / mu) : Infinity
        };
    }

    function elementsOf(b, p) {
        if (!p) return null;
        return relElements(b.x - p.x, b.y - p.y, b.vx - p.vx, b.vy - p.vy, G * (b.m + p.m));
    }

    // Each body's primary: the most local heavier body it is bound to and inside the Hill sphere of.
    // Bodies bound to nothing heavier get the strongest heavier attractor (bound = false). The heaviest
    // body is paired with its heaviest bound companion if that is at least a tenth of its mass (binaries).
    function computePrimaries() {
        const order = bodies.slice().sort((a, b) => b.m - a.m || a.id - b.id);
        for (const b of order) { b.primary = null; b.bound = false; b.hill = Infinity; }
        for (let i = 1; i < order.length; i++) {
            const b = order[i];
            let best = null, bestA = Infinity, pull = null, pullMax = -1;
            for (let j = 0; j < i; j++) {
                const p = order[j];
                const rx = b.x - p.x, ry = b.y - p.y;
                const r2 = rx * rx + ry * ry;
                if (r2 === 0) continue;
                const g = p.m / r2;
                if (g > pullMax) { pullMax = g; pull = p; }
                if (r2 > p.hill * p.hill) continue;
                const mu = G * (b.m + p.m);
                const vx = b.vx - p.vx, vy = b.vy - p.vy;
                const energy = 0.5 * (vx * vx + vy * vy) - mu / Math.sqrt(r2);
                if (energy >= 0) continue;
                const a = -mu / (2 * energy);
                if (a < bestA) { bestA = a; best = p; }
            }
            b.primary = best || pull;
            b.bound = !!best;
            if (b.primary) {
                const r = Math.hypot(b.x - b.primary.x, b.y - b.primary.y);
                b.hill = r * Math.cbrt(b.m / (3 * (b.primary.m + b.m)));
            }
        }
        const top = order[0];
        if (top) {
            for (let i = 1; i < order.length; i++) {
                const c = order[i];
                if (c.primary === top && c.bound && c.m >= 0.1 * top.m) { top.primary = c; top.bound = true; break; }
            }
        }
    }

    function heaviest() {
        let best = null;
        for (const b of bodies) if (!best || b.m > best.m) best = b;
        return best;
    }

    // Which body a body dropped at (x, y) would orbit: the most local heavier body whose Hill sphere
    // contains the point (the heaviest body's reaches everywhere); otherwise the strongest pull.
    function placementPrimary(x, y, m, exclude) {
        let best = null, pull = null, pullMax = -1;
        for (const p of bodies) {
            if (p === exclude) continue;
            const r2 = (x - p.x) * (x - p.x) + (y - p.y) * (y - p.y);
            if (r2 === 0) continue;
            const g = p.m / r2;
            if (g > pullMax) { pullMax = g; pull = p; }
            if (p.m < m) continue;
            if (r2 < p.hill * p.hill && (!best || p.hill < best.hill)) best = p;
        }
        return best || pull;
    }

    // Sense of rotation for a new orbit around p: the way p's own satellites (or p itself) go round.
    function orbitSense(p, b) {
        let L = 0;
        for (const c of bodies) {
            if (c === b || c === p || c.primary !== p) continue;
            L += c.m * ((c.x - p.x) * (c.vy - p.vy) - (c.y - p.y) * (c.vx - p.vx));
        }
        if (L === 0 && p.primary && p.primary !== b) {
            const q = p.primary;
            L = (p.x - q.x) * (p.vy - q.vy) - (p.y - q.y) * (p.vx - q.vx);
        }
        return L < 0 ? -1 : 1;
    }

    // Launch b on a circular orbit around p. The pair keeps its centre of mass and momentum (a new
    // body comes in at rest in the view), so both go round their centre of mass.
    function launchCircular(b, p, sense) {
        const rx = b.x - p.x, ry = b.y - p.y;
        const r = Math.hypot(rx, ry);
        if (r === 0) return;
        const v = Math.sqrt((G * (b.m + p.m)) / r);
        const s = sense || 1;
        const M = b.m + p.m;
        const cx = (b.m * b.x + p.m * p.x) / M, cy = (b.m * b.y + p.m * p.y) / M;
        const cvx = (b.m * b.vx + p.m * p.vx) / M, cvy = (b.m * b.vy + p.m * p.vy) / M;
        setPairRelative(b, p, rx, ry, (-s * ry / r) * v, (s * rx / r) * v, cx, cy, cvx, cvy);
    }

    // ------------------------------------------------------------------
    // Kepler's 3rd law: measured periods (time for a full turn around the primary) and
    // semi-major axes (half of closest + farthest distance during that turn).
    // ------------------------------------------------------------------
    function trackPeriods(t) {
        for (const b of bodies) {
            const p = b.primary;
            if (!p || !b.bound || b.held || p.held) { b.track = null; continue; }
            const rx = b.x - p.x, ry = b.y - p.y;
            const r = Math.hypot(rx, ry);
            const phi = Math.atan2(ry, rx);
            let tr = b.track;
            if (!tr || tr.pid !== p.id) {
                b.track = { pid: p.id, phi, theta: 0, t0: t, tPrev: t, rmin: r, rmax: r, T: 0, a: 0, done: 0 };
                continue;
            }
            let d = phi - tr.phi;
            if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
            const prev = Math.abs(tr.theta);
            tr.theta += d;
            tr.phi = phi;
            if (r < tr.rmin) tr.rmin = r;
            if (r > tr.rmax) tr.rmax = r;
            const now = Math.abs(tr.theta);
            if (now >= TAU) {
                const f = now > prev ? (TAU - prev) / (now - prev) : 1;
                const tc = tr.tPrev + f * (t - tr.tPrev);
                tr.T = tc - tr.t0;
                tr.a = 0.5 * (tr.rmin + tr.rmax);
                tr.done++;
                tr.t0 = tc;
                tr.theta -= Math.sign(tr.theta) * TAU;
                tr.rmin = r; tr.rmax = r;
            }
            tr.tPrev = t;
        }
    }

    function resetTracking(b) {
        if (!b) return;
        b.track = null;
        for (const c of bodies) if (c.primary === b) c.track = null;
        if (k2.bid === b.id || k2.pid === b.id) k2.bid = null;
    }

    // ------------------------------------------------------------------
    // Kepler's 2nd law: sectors swept by the subject in equal times (a twelfth of its period),
    // relative to its primary. Areas are summed step by step (each step adds the thin triangle
    // primary - old position - new position); a sector boundary inside a step splits it in time.
    // ------------------------------------------------------------------
    function k2Step(t) {
        const b = bodyById(selectedId);
        const p = b && b.primary;
        if (!settings.k2 || !b || !p || b.held || p.held) { k2.bid = null; return; }
        const rx = b.x - p.x, ry = b.y - p.y;
        if (k2.bid !== b.id || k2.pid !== p.id) {
            const el = elementsOf(b, p);
            k2.bid = b.id; k2.pid = p.id;
            k2.dt = el.bound ? el.T / K2_SECTORS : 0.25 * el.r / Math.max(el.v, 1e-9);
            k2.bound = el.bound;
            k2.tNext = t + k2.dt;
            k2.sectors = [];
            k2.cur = { pts: [rx, ry], area: 0, t0: t, n: 0 };
            k2.lastT = t; k2.lastX = rx; k2.lastY = ry; k2.lastAng = Math.atan2(ry, rx);
            return;
        }
        let t0 = k2.lastT, x0 = k2.lastX, y0 = k2.lastY;
        while (t >= k2.tNext && t > t0) {
            const f = (k2.tNext - t0) / (t - t0);
            const xb = x0 + f * (rx - x0), yb = y0 + f * (ry - y0);
            k2.cur.area += 0.5 * (x0 * yb - xb * y0);
            k2.cur.pts.push(xb, yb);
            k2.sectors.push(k2.cur);
            if (k2.sectors.length > K2_SECTORS) k2.sectors.shift();
            k2.cur = { pts: [xb, yb], area: 0, t0: k2.tNext, n: k2.cur.n + 1 };
            t0 = k2.tNext; x0 = xb; y0 = yb;
            k2.lastAng = Math.atan2(yb, xb);
            k2.tNext += k2.dt;
        }
        k2.cur.area += 0.5 * (x0 * ry - rx * y0);
        const ang = Math.atan2(ry, rx);
        let d = ang - k2.lastAng;
        if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
        if (Math.abs(d) > 0.015) {
            k2.cur.pts.push(rx, ry);
            k2.lastAng = ang;
        }
        k2.lastT = t; k2.lastX = rx; k2.lastY = ry;
    }

    // ------------------------------------------------------------------
    // Trails
    // ------------------------------------------------------------------
    function recordSample() {
        const k = sampleCount % TRAIL_CAP;
        const c = totals(bodies);
        comTrail[2 * k] = c.x; comTrail[2 * k + 1] = c.y;
        for (const b of bodies) {
            b.trail[2 * k] = b.x;
            b.trail[2 * k + 1] = b.y;
        }
        sampleCount++;
    }

    function clearTrail(b) { b.trailStart = sampleCount; }
    function clearAllTrails() { for (const b of bodies) b.trailStart = sampleCount; }

    // ------------------------------------------------------------------
    // Scenes
    // ------------------------------------------------------------------
    function loadScene(key) {
        const def = SCENES[key] || SCENES['sun-earth'];
        settings.scene = SCENES[key] ? key : 'sun-earth';
        scene = def;
        bodies = [];
        simTime = 0; acc = 0; sampleCount = 0; nextSampleT = 0;
        sampleDt = scene.Tref / TRAIL_PER_TREF;
        frameId = null; freeze = null;
        k2.bid = null;
        flashes.length = 0;
        closePopover();
        endAllDrags();
        for (const s of def.bodies) {
            const k = KINDS[s.kind] || KINDS.custom;
            const b = newBody({
                name: s.name || k.name, kind: s.kind,
                m: s.m !== undefined ? s.m : k.m, R: s.R !== undefined ? s.R : k.R,
                color: s.color || k.color
            });
            if (s.orbit) {
                placeOnOrbit(b, bodies[s.orbit.around], s.orbit);
            } else {
                b.x = s.at ? s.at[0] : 0; b.y = s.at ? s.at[1] : 0;
                b.vx = s.v ? s.v[0] : 0; b.vy = s.v ? s.v[1] : 0;
            }
            bodies.push(b);
        }
        // Centre of mass at rest at the origin
        const c = totals(bodies);
        for (const b of bodies) { b.x -= c.x; b.y -= c.y; b.vx -= c.vx; b.vy -= c.vy; }
        selectedId = bodies[def.subject] ? bodies[def.subject].id : (bodies[0] ? bodies[0].id : null);
        settings.trailIndex = def.trail !== undefined ? def.trail : 4;
        if (ui.trail) ui.trail.value = String(settings.trailIndex);
        settings.com = !!def.com;
        if (ui.com) ui.com.checked = settings.com;
        computeForces();
        computePrimaries();
        // Arrow scale: the subject's pull (or the scene's chosen one) reads as a medium-length arrow
        const subj = bodies[def.forceBody !== undefined ? def.forceBody : def.subject] || null;
        const fs = subj ? Math.hypot(subj.fx, subj.fy) : 0;
        forceRef = fs > 0 ? fs : 1;
        let pe = 0;
        for (let i = 0; i < bodies.length; i++) {
            for (let j = i + 1; j < bodies.length; j++) {
                pe += (G * bodies[i].m * bodies[j].m) / Math.hypot(bodies[i].x - bodies[j].x, bodies[i].y - bodies[j].y);
            }
        }
        energyExp = pe > 0 ? Math.floor(Math.log10(pe * ENERGY_J)) : 30;
        recordSample();
        nextSampleT = sampleDt;
        fitBox(def.box, false);
        refreshBodyLists();
        updateTrailLabel();
        resetCharts();
        syncEccentricity(true);
    }

    // ------------------------------------------------------------------
    // View
    // ------------------------------------------------------------------
    function liveFrameOrigin() {
        const L = frameId !== null ? bodyById(frameId) : null;
        if (L) return { x: L.dx, y: L.dy };
        let M = 0, X = 0, Y = 0;
        for (const b of bodies) { M += b.m; X += b.m * b.dx; Y += b.m * b.dy; }
        return M > 0 ? { x: X / M, y: Y / M } : { x: 0, y: 0 };
    }

    function frameVelocity() {
        const L = frameId !== null ? bodyById(frameId) : null;
        if (L) return { x: L.vx, y: L.vy };
        const c = totals(bodies);
        return { x: c.vx, y: c.vy };
    }

    function updateDrawnPositions() {
        for (const b of bodies) {
            if (!b.held) { b.dx = b.x + b.vx * lag; b.dy = b.y + b.vy * lag; } else { b.dx = b.x; b.dy = b.y; }
        }
        F = freeze ? { x: freeze.x, y: freeze.y } : liveFrameOrigin();
        // A held body stays exactly where it is held in the view
        for (const b of bodies) {
            if (b.held) { b.dx = F.x + b.held.offX; b.dy = F.y + b.held.offY; }
        }
    }

    // The frame origin from the integrator's positions (no extrapolation)
    function stateFrameOrigin() {
        if (freeze) return { x: freeze.x, y: freeze.y };
        const L = frameId !== null ? bodyById(frameId) : null;
        if (L) return { x: L.x, y: L.y };
        const c = totals(bodies);
        return { x: c.x, y: c.y };
    }

    const sx = (x) => viewW / 2 + (x - F.x - view.panX) * scale;
    const sy = (y) => viewH / 2 - (y - F.y - view.panY) * scale;
    const wx = (px) => F.x + view.panX + (px - viewW / 2) / scale;
    const wy = (py) => F.y + view.panY - (py - viewH / 2) / scale;

    function updateScale() {
        const m = Math.max(1, Math.min(viewW, viewH));
        scale = view.zoom * m;
        sizeScale = clamp(m / 560, 0.62, 1.1);
    }

    // Drawn radius (CSS px) from the real radius: compressed, so a star is about twice a giant
    // planet and a giant planet about one and a half times Earth.
    function symbolicRadius(Rkm) {
        return clamp(2.5 * Math.pow(1.5, Math.log10(Math.max(1, Rkm)) - 1), 3, 18);
    }
    function drawRadius(b) {
        return b.rd || Math.max(symbolicRadius(b.R) * sizeScale, (b.R / AU_KM) * scale);
    }

    // Drawn radii for this frame. A moon close to its planet on screen shrinks both discs (down to
    // 3 px) so they never overlap; zoomed in far enough, bodies are drawn at their true size.
    function computeDrawRadii() {
        for (const b of bodies) b.rmax = symbolicRadius(b.R) * sizeScale;
        for (const b of bodies) {
            const p = b.primary;
            if (!p || !b.bound || b.m >= p.m) continue;
            const d = Math.hypot(b.dx - p.dx, b.dy - p.dy) * scale;
            p.rmax = Math.min(p.rmax, 0.45 * d);
            b.rmax = Math.min(b.rmax, 0.3 * d);
        }
        for (const b of bodies) b.rd = Math.max(3, b.rmax, (b.R / AU_KM) * scale);
    }

    // Change the view so a world box (relative to the frame origin) fits the canvas.
    function fitBox(box, animate) {
        const m = Math.max(1, Math.min(viewW, viewH));
        const w = Math.max(box[1] - box[0], 1e-9), h = Math.max(box[3] - box[2], 1e-9);
        const W = viewW || 800, H = viewH || 500;
        const pxPerAu = Math.min((W - 40) / w, (H - 40) / h);
        const target = { zoom: pxPerAu / m, panX: 0.5 * (box[0] + box[1]), panY: 0.5 * (box[2] + box[3]) };
        if (!viewW || !viewH) { view.pendingBox = box; }
        if (animate) view.anim = target;
        else { view.zoom = target.zoom; view.panX = target.panX; view.panY = target.panY; view.anim = null; }
    }

    // Fit every body, and the whole orbit of each bound one, in the view.
    function fitAll() {
        if (!bodies.length) return;
        updateDrawnPositions();
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        const add = (x, y) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
        for (const b of bodies) {
            add(b.dx - F.x, b.dy - F.y);
            if (b.bound && b.primary && b.primary.primary !== b) {
                const el = elementsOf(b, b.primary);
                if (el && el.bound) {
                    const fp = b.primary.m / (b.m + b.primary.m);
                    const R = el.a * (1 + el.e) * fp;
                    const cx = b.primary.dx - F.x, cy = b.primary.dy - F.y;
                    // the ellipse's bounding box
                    const ca = Math.cos(el.w), sa = Math.sin(el.w);
                    const A = el.a * fp, B = A * Math.sqrt(Math.max(0, 1 - el.e * el.e));
                    const ox = cx - el.e * A * ca, oy = cy - el.e * A * sa;
                    const hx = Math.sqrt(A * A * ca * ca + B * B * sa * sa), hy = Math.sqrt(A * A * sa * sa + B * B * ca * ca);
                    if (R < 1e6) { add(ox - hx, oy - hy); add(ox + hx, oy + hy); }
                }
            }
        }
        const pad = 0.08 * Math.max(x1 - x0, y1 - y0, 1e-6);
        fitBox([x0 - pad, x1 + pad, y0 - pad, y1 + pad], true);
    }

    function stepViewAnimation(dtReal) {
        const a = view.anim;
        if (!a) return;
        const k = 1 - Math.exp(-dtReal / 0.16);
        view.zoom *= Math.pow(a.zoom / view.zoom, k);
        view.panX += (a.panX - view.panX) * k;
        view.panY += (a.panY - view.panY) * k;
        if (Math.abs(Math.log(a.zoom / view.zoom)) < 0.002 && Math.abs(a.panX - view.panX) * scale < 0.3 && Math.abs(a.panY - view.panY) * scale < 0.3) {
            view.zoom = a.zoom; view.panX = a.panX; view.panY = a.panY; view.anim = null;
        }
    }

    function zoomAt(px, py, factor) {
        const x = wx(px), y = wy(py);
        view.zoom = clamp(view.zoom * factor, 1e-7, 1e7);
        view.anim = null;
        updateScale();
        view.panX = x - F.x - (px - viewW / 2) / scale;
        view.panY = y - F.y + (py - viewH / 2) / scale;
    }

    // Change the frame without the view jumping, then glide to the new centre.
    function setFrame(id) {
        updateDrawnPositions();
        const before = { x: F.x, y: F.y };
        frameId = id !== null && bodyById(id) ? id : null;
        freeze = null;
        updateDrawnPositions();
        view.panX += before.x - F.x;
        view.panY += before.y - F.y;
        view.anim = { zoom: view.anim ? view.anim.zoom : view.zoom, panX: 0, panY: 0 };
        syncFrameUi();
        updatePopover(true);
    }

    function syncFrameUi() {
        const L = frameId !== null ? bodyById(frameId) : null;
        if (ui.frame) ui.frame.value = L ? String(L.id) : 'com';
        if (ui.frameChip) {
            ui.frameChip.hidden = !L;
            if (L && ui.frameChipName) ui.frameChipName.textContent = L.name;
        }
    }

    // ------------------------------------------------------------------
    // Body lists in the UI (frame selector), after bodies are added, removed or renamed
    // ------------------------------------------------------------------
    function refreshBodyLists() {
        if (frameId !== null && !bodyById(frameId)) frameId = null;
        if (selectedId !== null && !bodyById(selectedId)) selectedId = defaultSubject();
        if (ui.frame) {
            const opts = [['com', 'Centre of mass (no body)']].concat(bodies.map((b) => [String(b.id), b.name]));
            const same = ui.frame.options.length === opts.length && opts.every((o, i) => ui.frame.options[i].value === o[0] && ui.frame.options[i].textContent === o[1]);
            if (!same) {
                ui.frame.textContent = '';
                for (const [v, t] of opts) {
                    const o = document.createElement('option');
                    o.value = v; o.textContent = t;
                    ui.frame.appendChild(o);
                }
            }
        }
        syncFrameUi();
        if (ui.palette) {
            const full = bodies.length >= MAX_BODIES;
            ui.palette.querySelectorAll('button').forEach((btn) => {
                btn.disabled = full;
                btn.title = full ? `At most ${MAX_BODIES} bodies` : btn.dataset.title;
            });
        }
    }

    function defaultSubject() {
        // The heaviest body that orbits something, else the heaviest body
        computePrimaries();
        let best = null;
        for (const b of bodies) if (b.primary && b.primary.primary !== b && (!best || b.m > best.m)) best = b;
        if (!best) best = heaviest();
        return best ? best.id : null;
    }

    function selectBody(id) {
        if (id === selectedId) return;
        selectedId = id;
        k2.bid = null;
        resetOrbitChart();
        syncEccentricity(true);
    }

    function removeBody(b, heir) {
        const i = bodies.indexOf(b);
        if (i < 0) return;
        bodies.splice(i, 1);
        if (frameId === b.id) frameId = heir ? heir.id : null;
        if (selectedId === b.id) selectedId = heir ? heir.id : null;
        if (popBody === b) { if (heir) popBody = heir; else closePopover(); }
        for (const d of drags.values()) if (d.body === b) d.body = heir || null;
        forcesDirty = true;
        k2.bid = null;
        refreshBodyLists();
    }

    function deleteBody(b) {
        if (!b) return;
        updateDrawnPositions();
        const before = { x: F.x, y: F.y };
        const wasFrame = frameId === b.id;
        removeBody(b, null);
        if (selectedId === null) selectedId = defaultSubject();
        if (wasFrame) frameId = null;
        updateDrawnPositions();
        view.panX += before.x - F.x;
        view.panY += before.y - F.y;
        computePrimaries();
        refreshBodyLists();
        syncEccentricity(true);
    }

    // Keep the view still when something changes the frame origin (e.g. a mass change moves the
    // centre of mass): run fn, then shift the pan by however far the origin moved.
    function keepView(fn) {
        updateDrawnPositions();
        const before = { x: F.x, y: F.y };
        fn();
        forcesDirty = true;
        updateDrawnPositions();
        if (!freeze) { view.panX += before.x - F.x; view.panY += before.y - F.y; }
    }

    // ------------------------------------------------------------------
    // Adding bodies
    // ------------------------------------------------------------------
    function addBody(kind, x, y) {
        if (bodies.length >= MAX_BODIES) return null;
        const k = KINDS[kind] || KINDS.custom;
        const b = newBody({ name: uniqueName(k.name), kind, m: k.m, R: k.R, color: kind === 'custom' ? nextCustomColour() : k.color });
        let added = null;
        keepView(() => {
            b.x = x; b.y = y;
            const fv = frameVelocity();
            b.vx = fv.x; b.vy = fv.y;
            bodies.push(b);
            computeForces();
            computePrimaries();
            launch(b, true);
            added = b;
        });
        clearTrail(b);
        computePrimaries();
        refreshBodyLists();
        selectBody(b.id);
        return added;
    }

    let customCount = 0;
    function nextCustomColour() {
        const c = ['#ae85ca', '#7bd0c1', '#c75b9b', '#8499e7', '#f2849e'][customCount % 5];
        customCount++;
        return c;
    }

    // Set the velocity of a body that was just dropped or moved, by the "bodies you drop or move" option.
    function launch(b, isNew) {
        if (settings.placement === 'circular') {
            const p = placementPrimary(b.x, b.y, b.m, b);
            if (p) launchCircular(b, p, isNew ? orbitSense(p, b) : senseAround(b, p));
        } else if (settings.placement === 'rest' || isNew) {
            const fv = frameVelocity();
            b.vx = fv.x; b.vy = fv.y;
        }
        forcesDirty = true;
        resetTracking(b);
    }

    // The way b already goes round p (or the usual sense if it was hardly moving).
    function senseAround(b, p) {
        const h = (b.x - p.x) * (b.vy - p.vy) - (b.y - p.y) * (b.vx - p.vx);
        const r = Math.hypot(b.x - p.x, b.y - p.y);
        const vc = Math.sqrt((G * (b.m + p.m)) / Math.max(r, 1e-12));
        if (Math.abs(h) > 0.05 * r * vc) return h < 0 ? -1 : 1;
        return orbitSense(p, b);
    }

    // A tap on a palette chip: put the body at a free spot around the heaviest body, in view.
    function addBodyAuto(kind) {
        updateDrawnPositions();
        const top = heaviest();
        const k = KINDS[kind] || KINDS.custom;
        const half = Math.min(viewW, viewH) / (2 * scale);
        let cx = wx(viewW / 2), cy = wy(viewH / 2), R = 0.6 * half;
        if (top && top.m >= k.m) {
            const tx = sx(top.dx), ty = sy(top.dy);
            if (tx > 0 && tx < viewW && ty > 0 && ty < viewH) {
                cx = top.dx; cy = top.dy;
                const spaceX = Math.min(tx, viewW - tx), spaceY = Math.min(ty, viewH - ty);
                R = 0.7 * Math.min(spaceX, spaceY) / scale;
            }
        }
        let best = null, bestD = -1;
        for (let i = 0; i < 24; i++) {
            const ang = (i / 24) * TAU + 0.3;
            for (const f of [1, 0.75, 0.5]) {
                const x = cx + Math.cos(ang) * R * f, y = cy + Math.sin(ang) * R * f;
                let dmin = Infinity;
                for (const b of bodies) dmin = Math.min(dmin, Math.hypot(b.dx - x, b.dy - y) * scale);
                if (dmin > bestD) { bestD = dmin; best = [x, y]; }
            }
        }
        if (!best) best = [cx, cy];
        return addBody(kind, best[0], best[1]);
    }

    // ------------------------------------------------------------------
    // Orbit shape (eccentricity slider): relaunch the subject with the same semi-major axis,
    // from the far end of its new orbit (aphelion) in the direction it is now.
    // ------------------------------------------------------------------
    let eccDrag = null;      // { a, sense } captured when the slider starts moving
    let eccLastInput = 0;

    function applyEccentricity(e) {
        const b = bodyById(selectedId);
        const p = b && b.primary;
        if (!b || !p || p.primary === b && b.m > p.m) return;
        if (!eccDrag || eccDrag.bid !== b.id) {
            const el = elementsOf(b, p);
            eccDrag = { bid: b.id, a: el.bound ? el.a : el.r, sense: el.h < 0 ? -1 : 1 };
        }
        const a = eccDrag.a, mu = G * (b.m + p.m);
        const rx = b.x - p.x, ry = b.y - p.y;
        const r = Math.hypot(rx, ry) || 1;
        const ux = rx / r, uy = ry / r;
        const rAp = a * (1 + e);
        const vAp = Math.sqrt((mu * (1 - e)) / rAp);
        const s = eccDrag.sense;
        keepView(() => {
            const M = b.m + p.m;
            const cx = (b.m * b.x + p.m * p.x) / M, cy = (b.m * b.y + p.m * p.y) / M;
            const cvx = (b.m * b.vx + p.m * p.vx) / M, cvy = (b.m * b.vy + p.m * p.vy) / M;
            setPairRelative(b, p, ux * rAp, uy * rAp, -s * uy * vAp, s * ux * vAp, cx, cy, cvx, cvy);
        });
        clearTrail(b);
        resetTracking(b);
        resetTracking(p);
        k2.bid = null;
        computePrimaries();
    }

    // Show the subject's current eccentricity on the slider (unless it is being moved).
    function syncEccentricity(force) {
        if (!ui.ecc) return;
        const b = bodyById(selectedId);
        const p = b && b.primary;
        const usable = !!(b && p && !(p.primary === b && b.m > p.m));
        if (ui.orbitGroupLabel) {
            const t = b ? `Orbit of ${b.name}` : 'Orbit';
            if (ui.orbitGroupLabel.textContent !== t) ui.orbitGroupLabel.textContent = t;
        }
        ui.ecc.disabled = !usable;
        if (ui.eccNote) {
            const note = usable ? 'Relaunches it with the same average distance: 0 is a circle, near 1 a long thin ellipse.'
                : (b ? `${b.name} is the heaviest body here. Click or tap a body that orbits it.` : '');
            if (ui.eccNote.textContent !== note) ui.eccNote.textContent = note;
        }
        if (!usable) {
            if (ui.eccVal) ui.eccVal.textContent = '–';
            if (ui.eccName) ui.eccName.textContent = '';
            return;
        }
        if (!force && performance.now() - eccLastInput < 700) return;
        const el = elementsOf(b, p);
        const e = el.e;
        ui.ecc.value = String(clamp(e, 0, 0.95));
        showEccentricity(e);
    }

    function showEccentricity(e) {
        if (ui.eccVal) ui.eccVal.textContent = e < 9.995 ? e.toFixed(2) : '>10';
        if (ui.eccName) {
            const n = e < 0.005 ? '(circle)' : e < 0.995 ? '(ellipse)' : e < 1.005 ? '(parabola: escaping)' : '(hyperbola: escaping)';
            if (ui.eccName.textContent !== n) ui.eccName.textContent = n;
        }
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------
    function colours() {
        const dark = isDark();
        return dark ? {
            dark, bg: '#16181c', text: '#e0e0e0', subtle: 'rgba(224,224,224,0.55)', label: 'rgba(224,224,224,0.62)', faint: 'rgba(224,224,224,0.28)',
            force: '#f2849e', velocity: '#7bd0c1', kepler: '#8499e7', sectorA: 'rgba(174,133,202,0.34)', sectorB: 'rgba(174,133,202,0.18)',
            sectorLine: 'rgba(174,133,202,0.75)', card: 'rgba(30,32,37,0.93)', cardLine: 'rgba(255,255,255,0.12)', outline: 'rgba(0,0,0,0)'
        } : {
            dark, bg: '#f4f6f8', text: '#3d3d3d', subtle: 'rgba(50,50,50,0.68)', label: 'rgba(40,40,40,0.78)', faint: 'rgba(60,60,60,0.3)',
            force: '#e0607e', velocity: '#2a9d8f', kepler: '#5b6fd6', sectorA: 'rgba(150,100,190,0.30)', sectorB: 'rgba(150,100,190,0.15)',
            sectorLine: 'rgba(130,85,175,0.75)', card: 'rgba(255,255,255,0.94)', cardLine: 'rgba(0,0,0,0.12)', outline: 'rgba(0,0,0,0.28)'
        };
    }

    // A darker version of a body's colour for light mode (trails and labels need the contrast).
    const shadeCache = new Map();
    function bodyStroke(color, dark) {
        if (dark) return color;
        let s = shadeCache.get(color);
        if (!s) {
            const n = parseInt(color.slice(1), 16);
            const f = 0.68;
            s = `rgb(${Math.round(((n >> 16) & 255) * f)},${Math.round(((n >> 8) & 255) * f)},${Math.round((n & 255) * f)})`;
            shadeCache.set(color, s);
        }
        return s;
    }

    function font(px, bold) {
        return `${bold ? '700 ' : ''}${px}px "Source Sans Pro", Helvetica, sans-serif`;
    }

    function render() {
        if (viewW === 0 || viewH === 0) return;
        const C = colours();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = C.bg;
        ctx.fillRect(0, 0, viewW, viewH);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        computeDrawRadii();
        const subj = bodyById(selectedId);
        if (settings.k2) drawSectors(C, subj);
        drawTrails(C);
        if (settings.k1) drawEllipseLaw(C, subj);
        drawDragPreviews(C);
        if (settings.com) drawCentreOfMass(C);
        drawBodies(C);
        drawArrows(C);
        drawLabels(C);
        drawOffscreen(C);
        drawFlashes();
        drawPaletteGhost();
        drawOverlays(C, subj);
    }

    // Each trail point is drawn relative to where the frame's origin (the centre of mass, or the locked
    // body) was at that sample's time, so a locked view shows paths as seen from that body.
    function drawTrails(C) {
        const years = trailYears();
        if (years <= 0) return;
        const n = Math.min(TRAIL_CAP - 1, Math.round(years / sampleDt));
        const L = frameId !== null ? bodyById(frameId) : null;
        // While the frame is frozen (a body is being dragged), the live origin has drifted from F
        const live = freeze ? liveFrameOrigin() : F;
        const offX = (live.x - F.x - view.panX) * scale + viewW / 2, offY = viewH / 2 - (live.y - F.y - view.panY) * scale;
        const lw = clamp(1.6 * sizeScale, 1.2, 2);
        const CHUNKS = 8;
        const oT = L ? L.trail : comTrail;
        for (const b of bodies) {
            if (b.held) continue;
            let k0 = Math.max(b.trailStart, sampleCount - n, sampleCount - TRAIL_CAP + 1);
            if (L) k0 = Math.max(k0, L.trailStart);
            const count = sampleCount - k0;
            if (count < 1) continue;
            ctx.strokeStyle = bodyStroke(b.color, C.dark);
            ctx.lineWidth = lw;
            const T = b.trail;
            const chunk = Math.max(1, Math.ceil(count / CHUNKS));
            for (let c = 0; c < CHUNKS; c++) {
                const ks = k0 + c * chunk;
                if (ks >= sampleCount) break;
                const ke = Math.min(sampleCount, ks + chunk + 1);
                ctx.globalAlpha = 0.08 + 0.72 * ((c + 1) / CHUNKS);
                ctx.beginPath();
                let i = 2 * (ks % TRAIL_CAP);
                let lx = offX + (T[i] - oT[i]) * scale, ly = offY - (T[i + 1] - oT[i + 1]) * scale;
                ctx.moveTo(lx, ly);
                for (let k = ks + 1; k < ke; k++) {
                    i = 2 * (k % TRAIL_CAP);
                    const x = offX + (T[i] - oT[i]) * scale, y = offY - (T[i + 1] - oT[i + 1]) * scale;
                    if (Math.abs(x - lx) + Math.abs(y - ly) < 1.2 && k < ke - 1) continue;
                    ctx.lineTo(x, y);
                    lx = x; ly = y;
                }
                if (ke === sampleCount) ctx.lineTo(sx(b.dx), sy(b.dy));
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }

    function drawBodies(C) {
        for (const b of bodies) {
            const x = sx(b.dx), y = sy(b.dy);
            const r = drawRadius(b);
            if (x < -r - 60 || x > viewW + r + 60 || y < -r - 60 || y > viewH + r + 60) continue;
            if (isStar(b)) {
                const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 2.6);
                g.addColorStop(0, hexA(b.color, C.dark ? 0.45 : 0.35));
                g.addColorStop(1, hexA(b.color, 0));
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(x, y, r * 2.6, 0, TAU);
                ctx.fill();
            }
            const g2 = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
            g2.addColorStop(0, mix(b.color, '#ffffff', isStar(b) ? 0.55 : 0.35));
            g2.addColorStop(1, b.color);
            ctx.fillStyle = g2;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, TAU);
            ctx.fill();
            if (!C.dark) {
                ctx.strokeStyle = C.outline;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            if ((b.id === selectedId || b === popBody) && !cleanRender) {
                ctx.strokeStyle = b === popBody ? colours().text : C.subtle;
                ctx.lineWidth = 1.2;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.arc(x, y, r + 5, 0, TAU);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }
    }

    // Names go on top of the arrows and trails, with a halo in the background colour so lines
    // crossing them don't make them hard to read.
    function drawLabels(C) {
        if (!settings.labels) return;
        const fs = clamp(Math.min(viewW, viewH) / 42, 11, 13);
        ctx.font = font(fs);
        ctx.lineWidth = 3;
        ctx.strokeStyle = hexA(C.bg, 0.8);
        for (const b of bodies) {
            const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
            if (x < -60 || x > viewW + 60 || y < -60 || y > viewH + 60) continue;
            // On the side away from the pull (outwards from what it orbits), clear of the arrows and trail
            const u = labelDirection(b);
            const gap = r + (b.id === selectedId || b === popBody ? 9 : 5);
            ctx.fillStyle = C.label;
            ctx.textAlign = u.x > 0.38 ? 'left' : u.x < -0.38 ? 'right' : 'center';
            ctx.textBaseline = u.y > 0.38 ? 'top' : u.y < -0.38 ? 'bottom' : 'middle';
            fillTextInside(b.name, x + u.x * gap, y + u.y * gap, true);
        }
    }

    // Bodies outside the view: a small pointer at the edge of the canvas, in their direction.
    function drawOffscreen(C) {
        const fs = clamp(Math.min(viewW, viewH) / 46, 10, 12);
        const cx = viewW / 2, cy = viewH / 2;
        const inset = 12;
        for (const b of bodies) {
            const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
            if (x > -r && x < viewW + r && y > -r && y < viewH + r) continue;
            const dx = x - cx, dy = y - cy;
            const k = Math.min((cx - inset) / Math.max(Math.abs(dx), 1e-9), (cy - inset) / Math.max(Math.abs(dy), 1e-9));
            const ex = cx + dx * k, ey = cy + dy * k;
            const len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
            ctx.fillStyle = bodyStroke(b.color, C.dark);
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.moveTo(ex + ux * 6, ey + uy * 6);
            ctx.lineTo(ex - ux * 4 - uy * 5, ey - uy * 4 + ux * 5);
            ctx.lineTo(ex - ux * 4 + uy * 5, ey - uy * 4 - ux * 5);
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = 1;
            if (settings.labels) {
                ctx.font = font(fs);
                ctx.fillStyle = C.subtle;
                ctx.textAlign = ux > 0.5 ? 'right' : ux < -0.5 ? 'left' : 'center';
                ctx.textBaseline = uy > 0.5 ? 'bottom' : uy < -0.5 ? 'top' : 'middle';
                ctx.fillText(b.name, ex - ux * 12, ey - uy * 12);
            }
        }
    }

    function hexA(color, a) {
        const n = parseInt(color.slice(1), 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
    function mix(c1, c2, t) {
        const a = parseInt(c1.slice(1), 16), b = parseInt(c2.slice(1), 16);
        const ch = (s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
        return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
    }

    function arrow(x0, y0, x1, y1, color, width) {
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        if (len < 2) return;
        const head = Math.min(9, 3 + width * 2.4, len * 0.6);
        const ux = dx / len, uy = dy / len;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1 - ux * head * 0.7, y1 - uy * head * 0.7);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - ux * head - uy * head * 0.55, y1 - uy * head + ux * head * 0.55);
        ctx.lineTo(x1 - ux * head + uy * head * 0.55, y1 - uy * head - ux * head * 0.55);
        ctx.closePath();
        ctx.fill();
    }

    // Force arrows: px length from the force, compressed for very strong pulls (equal forces always
    // get equal arrows, so the Sun's arrow matches Earth's).
    function forceLength(f) {
        const Lmax = 100 * sizeScale;
        return Lmax * (1 - Math.exp(-Math.LN2 * f / forceRef));   // the reference force is half the maximum
    }

    // Where the velocity handle of the selected body is drawn (screen px), and the arrow tip.
    function velocityTip(b) {
        const fv = frameVelocity();
        const tau = arrowTime();
        const vx = b.aim ? b.aim.vx : b.vx - fv.x, vy = b.aim ? b.aim.vy : b.vy - fv.y;
        const x = sx(b.dx), y = sy(b.dy);
        return { x: x + vx * tau * scale, y: y - vy * tau * scale, vx, vy };
    }
    function handlePos(b) {
        const tip = velocityTip(b);
        const x = sx(b.dx), y = sy(b.dy);
        const r = drawRadius(b);
        const dx = tip.x - x, dy = tip.y - y;
        const len = Math.hypot(dx, dy);
        const min = r + 16;
        if (len >= min) return { x: tip.x, y: tip.y };
        let ux, uy;
        if (len > 0.5) { ux = dx / len; uy = dy / len; } else {
            // Hardly moving in this view: put the handle at right angles to the name label
            const l = labelDirection(b);
            ux = -l.y; uy = l.x;
        }
        return { x: x + ux * min, y: y + uy * min };
    }

    // Which way a body's name goes (screen direction): away from the pull on it
    function labelDirection(b) {
        const Fm = Math.hypot(b.fx, b.fy);
        return Fm > 0 ? { x: -b.fx / Fm, y: b.fy / Fm } : { x: 0.6, y: 0.8 };
    }

    // Text kept inside the canvas whatever its alignment
    function fillTextInside(text, x, y, halo) {
        const w = ctx.measureText(text).width;
        const al = ctx.textAlign;
        let left = al === 'right' ? x - w : al === 'center' ? x - w / 2 : x;
        left = clamp(left, 4, Math.max(4, viewW - 4 - w));
        const ty = clamp(y, 10, viewH - 8);
        ctx.textAlign = 'left';
        if (halo) ctx.strokeText(text, left, ty);
        ctx.fillText(text, left, ty);
        ctx.textAlign = al;
    }

    function drawArrows(C) {
        const w = clamp(2 * sizeScale, 1.5, 2.4);
        const subj = bodyById(selectedId);
        if (settings.forces) {
            for (const b of bodies) {
                const Fm = Math.hypot(b.fx, b.fy);
                if (!(Fm > 0)) continue;
                const L = forceLength(Fm * 1);
                if (L < 3) continue;
                const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
                const ux = b.fx / Fm, uy = -b.fy / Fm;
                arrow(x + ux * r, y + uy * r, x + ux * (r + L), y + uy * (r + L), C.force, w);
            }
        }
        for (const b of bodies) {
            const showV = settings.velocities || b === subj || b.aim;
            if (!showV || (b.held && !b.aim)) continue;
            const tip = velocityTip(b);
            const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
            const dx = tip.x - x, dy = tip.y - y;
            const len = Math.hypot(dx, dy);
            if (len > r + 3) arrow(x + (dx / len) * r, y + (dy / len) * r, tip.x, tip.y, C.velocity, w);
            if (((b === subj && !b.held && bodies.length > 1) || b.aim) && !cleanRender) {
                const h = handlePos(b);
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = C.velocity;
                ctx.fillStyle = hexA(C.dark ? '#16181c' : '#f4f6f8', 0.6);
                ctx.beginPath();
                ctx.arc(h.x, h.y, 6, 0, TAU);
                ctx.fill();
                ctx.stroke();
            }
        }
    }

    function drawCentreOfMass(C) {
        let M = 0, X = 0, Y = 0;
        for (const b of bodies) { M += b.m; X += b.m * b.dx; Y += b.m * b.dy; }
        if (!(M > 0)) return;
        const x = sx(X / M), y = sy(Y / M);
        const r = 6;
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = C.text;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = C.text;
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.arc(x, y, r, -Math.PI / 2, 0); ctx.closePath(); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.arc(x, y, r, Math.PI / 2, Math.PI); ctx.closePath(); ctx.fill();
        if (settings.labels) {
            ctx.font = font(clamp(Math.min(viewW, viewH) / 46, 10, 12));
            ctx.fillStyle = C.subtle;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText('centre of mass', x + r + 5, y - r - 4);
        }
    }

    // A conic (relative orbit) around the primary at screen point (cx, cy).
    function traceConic(cx, cy, el, maxR) {
        ctx.beginPath();
        if (el.bound && el.e < 0.999) {
            const a = el.a * scale, b = a * Math.sqrt(1 - el.e * el.e);
            const ox = cx - el.e * a * Math.cos(el.w), oy = cy + el.e * a * Math.sin(el.w);
            ctx.ellipse(ox, oy, a, b, -el.w, 0, TAU);
            return;
        }
        // Parabola or hyperbola: r = p / (1 + e cos(nu)) up to maxR
        const lim = el.e > 1 ? Math.acos(-1 / el.e) : Math.PI;
        let first = true;
        const N = 160;
        for (let i = 0; i <= N; i++) {
            const nu = -lim + 1e-3 + ((2 * lim - 2e-3) * i) / N;
            const rr = el.p / (1 + el.e * Math.cos(nu));
            if (!(rr > 0) || rr > maxR) { first = true; continue; }
            const ang = el.w + nu;
            const x = cx + rr * Math.cos(ang) * scale, y = cy - rr * Math.sin(ang) * scale;
            if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
        }
    }

    function drawEllipseLaw(C, b) {
        const p = b && b.primary;
        if (!b || !p || (p.primary === b && b.m > p.m)) return;
        const el = elementsOf(b, p);
        const cx = sx(p.dx), cy = sy(p.dy);
        const maxR = 3 * Math.max(viewW, viewH) / scale;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = C.kepler;
        ctx.setLineDash([6, 5]);
        traceConic(cx, cy, el, maxR);
        ctx.stroke();
        ctx.setLineDash([]);
        if (!el.bound) return;
        const fs = clamp(Math.min(viewW, viewH) / 46, 10, 12);
        const ux = Math.cos(el.w), uy = -Math.sin(el.w);
        const rp = el.a * (1 - el.e) * scale, ra = el.a * (1 + el.e) * scale;
        const peri = { x: cx + ux * rp, y: cy + uy * rp }, apo = { x: cx - ux * ra, y: cy - uy * ra };
        const f2 = { x: cx - ux * 2 * el.a * el.e * scale, y: cy - uy * 2 * el.a * el.e * scale };
        // Major axis
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(peri.x, peri.y); ctx.lineTo(apo.x, apo.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        // Lines from the body to both foci: r1 + r2 = 2a all the way round
        const bx = sx(b.dx), by = sy(b.dy);
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(cx, cy); ctx.lineTo(bx, by); ctx.lineTo(f2.x, f2.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        // Empty focus, closest and farthest points
        ctx.fillStyle = C.kepler;
        ctx.strokeStyle = C.kepler;
        ctx.lineWidth = 1.6;
        const s = 4;
        ctx.beginPath();
        ctx.moveTo(f2.x - s, f2.y - s); ctx.lineTo(f2.x + s, f2.y + s);
        ctx.moveTo(f2.x - s, f2.y + s); ctx.lineTo(f2.x + s, f2.y - s);
        ctx.stroke();
        for (const q of [peri, apo]) { ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, TAU); ctx.fill(); }
        if (el.e > 0.03 && !cleanRender) {
            const names = apsisNames(p);
            ctx.font = font(fs);
            ctx.fillStyle = C.kepler;
            ctx.textBaseline = 'middle';
            // (not where the body itself is, so they never sit on its name)
            if (Math.hypot(bx - peri.x, by - peri.y) > 40) labelOutward(names[0], peri, ux, uy, 8);
            if (Math.hypot(bx - apo.x, by - apo.y) > 40) labelOutward(names[1], apo, -ux, -uy, 8);
            if (2 * el.a * el.e * scale > 26) labelBeside('empty focus', f2, ux, uy, 10);
        }
    }

    // A label beyond a point along (ux, uy); if the canvas edge is in the way, on the inside instead.
    function labelOutward(text, q, ux, uy, gap) {
        const w = ctx.measureText(text).width;
        const room = ux > 0.3 ? viewW - (q.x + gap) : ux < -0.3 ? q.x - gap : Infinity;
        if (room < w + 4) { ux = -ux; uy = -uy; }
        ctx.textAlign = ux > 0.3 ? 'left' : ux < -0.3 ? 'right' : 'center';
        const x = q.x + ux * gap, y = q.y + uy * gap + (Math.abs(ux) <= 0.3 ? (uy > 0 ? 6 : -6) : 0);
        fillTextInside(text, x, y);
    }
    function labelBeside(text, q, ux, uy, gap) {
        // Perpendicular to the major axis
        const px = -uy, py = ux;
        const s = py > 0 ? 1 : -1;
        ctx.textAlign = 'center';
        fillTextInside(text, q.x + px * gap * s, q.y + py * gap * s + 4 * s);
    }

    function drawSectors(C, b) {
        if (!b || k2.bid !== b.id) return;
        const p = bodyById(k2.pid);
        if (!p) return;
        const cx = sx(p.dx), cy = sy(p.dy);
        const fs = clamp(Math.min(viewW, viewH) / 48, 10, 12);
        const list = k2.sectors.concat(k2.cur ? [k2.cur] : []);
        list.forEach((s) => {
            const n = s.pts.length / 2;
            if (n < 2) return;
            const live = s === k2.cur;
            ctx.fillStyle = s.n % 2 ? C.sectorA : C.sectorB;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            for (let k = 0; k < n; k++) ctx.lineTo(cx + s.pts[2 * k] * scale, cy - s.pts[2 * k + 1] * scale);
            if (live) ctx.lineTo(sx(b.dx), sy(b.dy));
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = C.sectorLine;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + s.pts[0] * scale, cy - s.pts[1] * scale);
            ctx.stroke();
            // Area label inside finished sectors that are big enough on screen
            if (!live && k2.bound && !cleanRender) {
                const m = Math.floor(n / 2);
                const mx = s.pts[2 * m] * scale, my = -s.pts[2 * m + 1] * scale;
                const rpx = Math.hypot(mx, my);
                const x0 = s.pts[0] * scale, y0 = -s.pts[1] * scale, x1 = s.pts[2 * n - 2] * scale, y1 = -s.pts[2 * n - 1] * scale;
                const chord = Math.hypot(x1 - x0, y1 - y0);
                if (rpx * chord > 1500 && chord > 30) {
                    ctx.font = font(fs);
                    ctx.fillStyle = C.text;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(fmtArea(Math.abs(s.area)), cx + mx * 0.62, cy + my * 0.62);
                }
            }
        });
    }

    function fmtArea(au2) {
        if (scene.units === 'km') return fmtSci(au2 * AU_KM * AU_KM, 2);
        return au2 >= 0.01 ? au2.toPrecision(3) : fmtSci(au2, 2);
    }
    const areaUnit = () => (scene.units === 'km' ? 'km²' : 'AU²');

    function drawFlashes() {
        const now = performance.now();
        for (let i = flashes.length - 1; i >= 0; i--) {
            const f = flashes[i];
            const t = (now - f.t) / 650;
            if (t >= 1) { flashes.splice(i, 1); continue; }
            ctx.globalAlpha = 1 - t;
            ctx.strokeStyle = f.color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(sx(f.x), sy(f.y), f.r0 + 30 * t, 0, TAU);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    // Overlays: Kepler cards (top right), scale bar (bottom left), "not to scale" note, pause label.
    function drawOverlays(C, subj) {
        if (cleanRender) return;
        const fs = clamp(Math.min(viewW, viewH) / 44, 10.5, 13);
        const pad = 8;
        // Scale bar: a round length in the units it is labelled in
        const target = clamp(viewW / 8, 70, 130) / scale;
        const km = scene.units === 'km' || target < 0.01;
        const nice = km ? niceNumber(target * AU_KM) / AU_KM : niceNumber(target);
        const len = nice * scale;
        const x0 = pad + 4, y0 = viewH - pad - 4;
        ctx.strokeStyle = C.subtle;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x0, y0 - 5); ctx.lineTo(x0, y0); ctx.lineTo(x0 + len, y0); ctx.lineTo(x0 + len, y0 - 5);
        ctx.stroke();
        ctx.font = font(fs);
        ctx.fillStyle = C.subtle;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(scaleLabel(nice), x0 + len + 6, y0 + 2);
        ctx.textAlign = 'right';
        ctx.fillText('Sizes not to scale', viewW - pad - 2, y0 + 2);

        // Pause / slow-down notice: top left, under the "Viewed from" chip if it is showing
        if (paused || slowedDown) {
            const t = paused ? 'Paused' : 'Close pass: slowed down';
            ctx.font = font(fs, true);
            const w = ctx.measureText(t).width + 18;
            const x = pad, y = frameId !== null ? pad + 40 : pad;
            roundRect(x, y, w, fs + 10, 4);
            ctx.fillStyle = C.card;
            ctx.fill();
            ctx.fillStyle = C.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(t, x + w / 2, y + (fs + 10) / 2 + 0.5);
        }

        // Kepler cards stack down the top-right corner (shorter on small canvases)
        const compact = viewW < 560;
        const cfs = compact ? clamp(fs - 0.5, 10, 12) : fs;
        let y = pad;
        if (frameId !== null && viewW < 520) y = 48;
        if (settings.k1) y = drawCard(C, kepler1Lines(subj, compact), y, cfs) + 5;
        if (settings.k2) y = drawCard(C, kepler2Lines(subj, compact), y, cfs) + 5;
        if (settings.k3) drawKepler3Card(C, subj, y, cfs, compact);
    }

    function scaleLabel(au) {
        if (scene.units === 'km' || au < 0.01) return `${fmtKm(Math.round(au * AU_KM))} km`;
        return `${+au.toPrecision(3)} AU`;
    }

    // The largest 1, 2 or 5 x 10^n not much longer than x
    function niceNumber(x) {
        const pow = Math.pow(10, Math.floor(Math.log10(x)));
        return [1, 2, 5, 10].map((k) => k * pow).filter((v) => v <= x * 1.4).pop() || pow;
    }

    function roundRect(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    // A card of text lines in the top-right corner. Each line is a list of segments [text, bold?, colour?].
    // Returns the card's bottom edge.
    function drawCard(C, lines, y, fs) {
        if (!lines || !lines.length) return y - 6;
        const lh = Math.round(fs * 1.4);
        const widthOf = (line) => line.reduce((s, seg) => { ctx.font = font(fs, seg[1]); return s + ctx.measureText(seg[0]).width; }, 0);
        const w = Math.max(...lines.map(widthOf)) + 20;
        const h = lines.length * lh + 10;
        const x = viewW - 8 - w;
        cardBox(C, x, y, w, h);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        lines.forEach((line, i) => {
            let lx = x + 10;
            for (const seg of line) {
                ctx.font = font(fs, seg[1]);
                ctx.fillStyle = seg[2] || C.text;
                ctx.fillText(seg[0], lx, y + 5 + lh * (i + 0.5));
                lx += ctx.measureText(seg[0]).width;
            }
        });
        return y + h;
    }

    function cardBox(C, x, y, w, h) {
        roundRect(x, y, w, h, 5);
        ctx.fillStyle = C.card;
        ctx.fill();
        ctx.strokeStyle = C.cardLine;
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    // Is b orbiting something we can analyse (not the heaviest body of the scene)?
    function orbitingBody(b) {
        const p = b && b.primary;
        return !!(p && !(p.primary === b && b.m > p.m));
    }

    // Kepler's 1st law card: the fitted ellipse's size and shape (compact: one line, for phones)
    function kepler1Lines(b, compact) {
        const C = colours();
        const title = (t) => [t, true, C.kepler];
        if (!orbitingBody(b)) return [[title('1st law: '), ['pick an orbiting body']]];
        const p = b.primary;
        const el = elementsOf(b, p);
        if (!el.bound) {
            return [[title('1st law: '), [`not bound, e = ${el.e.toFixed(2)} (${el.e < 1.005 ? 'parabola' : 'hyperbola'})`]]];
        }
        const d = (v) => { const f = fmtDistance(v); return `${f.v} ${f.u}`; };
        if (compact) return [[title('1st law: '), [`a = ${d(el.a)}, e = ${el.e.toFixed(2)}`]]];
        // Distance to the empty focus, for r1 + r2 = 2a
        const r2 = Math.hypot(b.x - p.x + 2 * el.a * el.e * Math.cos(el.w), b.y - p.y + 2 * el.a * el.e * Math.sin(el.w));
        return [
            [title(`1st law: an ellipse, ${p.name} at a focus`)],
            [[`a = ${d(el.a)}   e = ${el.e.toFixed(3)}`]],
            [[`r₁ + r₂ = ${d(el.r + r2)} = 2a`]]
        ];
    }

    // Kepler's 2nd law card: the sectors' time and their (equal) areas
    function kepler2Lines(b, compact) {
        const C = colours();
        const title = (t) => [t, true, C.kepler];
        if (!orbitingBody(b)) return [[title('2nd law: '), ['pick an orbiting body']]];
        const head = compact ? [title('2nd law: '), [`sectors of ${fmtDuration(k2.dt)}`]] : [title('2nd law: equal areas in equal times')];
        if (k2.bid !== b.id) return [head, [['Starting…']]];
        const lines = [head];
        if (!compact) lines.push([[`Each sector: ${fmtDuration(k2.dt)}${k2.bound ? ' (1/12 orbit)' : ''}`]]);
        const done = k2.sectors;
        if (done.length >= 2) {
            let lo = Infinity, hi = 0, sum = 0;
            for (const s of done) { const a = Math.abs(s.area); lo = Math.min(lo, a); hi = Math.max(hi, a); sum += a; }
            const mean = sum / done.length;
            const spread = mean > 0 ? (100 * (hi - lo)) / mean : 0;
            const within = spread < 0.1 ? '0.1' : spread.toFixed(1);
            lines.push([[compact ? `${fmtArea(mean)} ${areaUnit()} each, ±${within}%` : `Areas: ${fmtArea(mean)} ${areaUnit()}, all within ${within}%`]]);
        } else {
            lines.push([[done.length ? `Area: ${fmtArea(Math.abs(done[0].area))} ${areaUnit()}` : 'Measuring the first sector…']]);
        }
        return lines;
    }

    // Kepler's 3rd law: measured a, T and T^2/a^3 for every body bound to the same primary.
    function kepler3Rows(b) {
        const P = b ? (orbitingBody(b) ? b.primary : b) : heaviest();
        if (!P) return { P: null, rows: [] };
        const rows = [];
        for (const c of bodies) {
            if (c === P || c.primary !== P || !c.bound) continue;
            const tr = c.track;
            const row = { body: c, a: 0, T: 0, ratio: 0, progress: 0, measured: false };
            if (tr && tr.done > 0) {
                row.a = tr.a; row.T = tr.T; row.ratio = (tr.T * tr.T) / (tr.a * tr.a * tr.a); row.measured = true;
            } else {
                row.progress = tr ? Math.min(0.99, Math.abs(tr.theta) / TAU) : 0;
                row.aEst = elementsOf(c, P).a;
            }
            rows.push(row);
        }
        rows.sort((r1, r2) => (r1.a || r1.aEst) - (r2.a || r2.aEst));
        return { P, rows };
    }

    // A table: one row per orbiting body, the same T^2/a^3 for all of them, and Newton's value.
    function drawKepler3Card(C, subj, y, fs, compact) {
        const { P, rows } = kepler3Rows(subj);
        const lh = Math.round(fs * 1.4);
        const km = scene.units === 'km';
        const title = compact || !P ? '3rd law' : `3rd law: orbits of ${P.name}`;
        const head = [compact ? '' : '', km ? 'a (km)' : 'a (AU)', km ? 'T (days)' : 'T (yr)', 'T²/a³'];
        const maxName = compact ? 8 : 11;
        const cells = rows.slice(0, compact ? 5 : 8).map((r) => {
            const nm = r.body.name.length > maxName ? `${r.body.name.slice(0, maxName - 1)}…` : r.body.name;
            if (!r.measured) return { name: nm, body: r.body, measuring: `measuring… ${Math.round(r.progress * 100)}%` };
            const a = km ? fmtKm(r.a * AU_KM) : r.a.toFixed(3);
            const T = km ? (r.T * DAYS_PER_YEAR).toFixed(2) : r.T.toFixed(3);
            const ratio = km ? fmtSci(Math.pow(r.T * DAYS_PER_YEAR, 2) / Math.pow(r.a * AU_KM, 3), 2) : r.ratio.toFixed(3);
            return { name: nm, body: r.body, cols: [a, T, ratio] };
        });
        let note = '';
        if (!rows.length) note = compact ? 'Add orbiting bodies' : 'Add bodies that orbit it to compare.';
        else {
            const pred = (4 * Math.PI * Math.PI) / (G * (P.m + rows[0].body.m));
            const v = km ? fmtSci(pred * Math.pow(DAYS_PER_YEAR, 2) / Math.pow(AU_KM, 3), 2) : pred.toFixed(3);
            note = compact ? `Newton: 4π²/GM = ${v}` : `Newton: 4π²/GM = ${v} ${km ? 'd²/km³' : 'yr²/AU³'}`;
        }
        // Column widths (the "measuring" text spans the three number columns)
        const gap = compact ? 9 : 12, dot = 10;
        const colW = [0, 0, 0, 0];
        ctx.font = font(fs, true);
        head.forEach((t, i) => { colW[i] = Math.max(colW[i], ctx.measureText(t).width); });
        ctx.font = font(fs);
        let measW = 0;
        for (const c of cells) {
            colW[0] = Math.max(colW[0], ctx.measureText(c.name).width + dot);
            if (c.cols) c.cols.forEach((t, i) => { colW[i + 1] = Math.max(colW[i + 1], ctx.measureText(t).width); });
            else measW = Math.max(measW, ctx.measureText(c.measuring).width);
        }
        const numW = Math.max(colW[1] + gap + colW[2] + gap + colW[3], measW);
        const tableW = rows.length ? colW[0] + gap + numW : 0;
        ctx.font = font(fs, true);
        let w = ctx.measureText(title).width;
        ctx.font = font(fs);
        w = Math.max(w, ctx.measureText(note).width, tableW) + 20;
        const nLines = 1 + (rows.length ? 1 + cells.length : 0) + 1;
        const h = nLines * lh + 10;
        const x = viewW - 8 - w;
        cardBox(C, x, y, w, h);
        ctx.textBaseline = 'middle';
        let ly = y + 5 + lh / 2;
        ctx.textAlign = 'left';
        ctx.font = font(fs, true);
        ctx.fillStyle = C.kepler;
        ctx.fillText(title, x + 10, ly);
        ly += lh;
        const numX = x + 10 + colW[0] + gap;
        if (rows.length) {
            // Header
            ctx.font = font(fs, true);
            ctx.fillStyle = C.subtle;
            ctx.textAlign = 'right';
            let cx = numX;
            for (let i = 1; i < 4; i++) { cx += colW[i]; ctx.fillText(head[i], cx, ly); cx += gap; }
            ly += lh;
            ctx.font = font(fs);
            for (const c of cells) {
                ctx.fillStyle = c.body.color;
                ctx.beginPath();
                ctx.arc(x + 13, ly, 3, 0, TAU);
                ctx.fill();
                ctx.textAlign = 'left';
                ctx.fillStyle = C.text;
                ctx.fillText(c.name, x + 10 + dot, ly);
                if (c.cols) {
                    ctx.textAlign = 'right';
                    let nx = numX;
                    for (let i = 1; i < 4; i++) { nx += colW[i]; ctx.fillText(c.cols[i - 1], nx, ly); nx += gap; }
                } else {
                    ctx.fillStyle = C.subtle;
                    ctx.fillText(c.measuring, numX, ly);
                }
                ly += lh;
            }
        }
        ctx.textAlign = 'left';
        ctx.font = font(fs);
        ctx.fillStyle = C.subtle;
        ctx.fillText(note, x + 10, ly);
        return y + h;
    }

    // While dragging: the orbit the body would follow, and the speed guide while aiming its velocity.
    function drawDragPreviews(C) {
        for (const d of drags.values()) {
            const b = d.body;
            if (!b || (d.mode !== 'move' && d.mode !== 'aim')) continue;
            if (!settings.preview && d.mode === 'move') continue;
            const pr = predictLaunch(b);
            if (!pr) continue;
            const p = pr.p;
            const cx = sx(p.dx), cy = sy(p.dy);
            if (settings.preview || d.mode === 'aim') {
                ctx.lineWidth = 1.4;
                ctx.strokeStyle = hexA(b.color, 0.75);
                ctx.setLineDash([5, 5]);
                if (Math.abs(pr.el.h) < 1e-9 * pr.el.r * Math.max(pr.el.v, 1e-9) || pr.el.p * scale < 0.5) {
                    ctx.beginPath();
                    ctx.moveTo(sx(b.dx), sy(b.dy));
                    ctx.lineTo(cx, cy);
                } else {
                    traceConic(cx, cy, pr.el, 3 * Math.max(viewW, viewH) / scale);
                }
                ctx.stroke();
                ctx.setLineDash([]);
            }
            if (d.mode === 'aim') {
                // Speed guide: circles for the circular and escape speeds around the primary's velocity
                const fv = frameVelocity();
                const tau = arrowTime();
                const ox = sx(b.dx) + (p.vx - fv.x) * tau * scale, oy = sy(b.dy) - (p.vy - fv.y) * tau * scale;
                const rings = [[pr.vc * tau * scale, 'circular speed'], [pr.ve * tau * scale, 'escape speed']];
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 4]);
                ctx.strokeStyle = hexA(C.velocity, 0.55);
                for (const [rr] of rings) {
                    if (rr < 6) continue;
                    ctx.beginPath();
                    ctx.arc(ox, oy, rr, 0, TAU);
                    ctx.stroke();
                }
                ctx.setLineDash([]);
                drawRingLabels(C, b, ox, oy, rings, cx, cy);
            }
        }
    }

    // The speed rings' labels, each sitting on its own ring at the clearest angle: away from the aimed
    // arrow and its handle, the line to the body being orbited, the body and its name, inside the
    // canvas and never on top of each other. A ring too small for that gets its label just outside it.
    function drawRingLabels(C, b, ox, oy, rings, px, py) {
        const fs = clamp(Math.min(viewW, viewH) / 48, 10, 12);
        const bx = sx(b.dx), by = sy(b.dy), r = drawRadius(b);
        const h = handlePos(b);
        const angle = (x, y) => Math.atan2(y - oy, x - ox);
        const avoid = [angle(h.x, h.y), angle(h.x, h.y) + Math.PI, angle(px, py)];
        // The body's name, as drawLabels places it
        const nfs = clamp(Math.min(viewW, viewH) / 42, 11, 13);
        ctx.font = font(nfs);
        const nu = labelDirection(b), ngap = r + 9, nw = ctx.measureText(b.name).width;
        const nx = bx + nu.x * ngap, ny = by + nu.y * ngap;
        const nl = nu.x > 0.38 ? nx : nu.x < -0.38 ? nx - nw : nx - nw / 2;
        const nt = nu.y > 0.38 ? ny : nu.y < -0.38 ? ny - nfs : ny - nfs / 2;
        const keepOut = [{ l: nl - 2, r: nl + nw + 2, t: nt - 2, b: nt + nfs + 2 }];
        // ...and the canvas's own notes: the scale bar row, and the pause / "Viewed from" notices
        keepOut.push({ l: 0, r: viewW, t: viewH - 24, b: viewH });
        if (paused || slowedDown || frameId !== null) keepOut.push({ l: 0, r: 240, t: 0, b: frameId !== null ? 84 : 40 });
        const overlaps = (a, q) => a.l < q.r && a.r > q.l && a.t < q.b && a.b > q.t;
        const nearPoint = (a, x, y, d) => x > a.l - d && x < a.r + d && y > a.t - d && y < a.b + d;
        const angDist = (a1, a2) => { const d = Math.abs(((a1 - a2) % TAU + TAU) % TAU); return Math.min(d, TAU - d); };
        ctx.font = font(fs);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = hexA(C.bg, 0.9);
        ctx.fillStyle = C.velocity;
        let first = null;
        for (const [rr, text] of rings) {
            if (rr < 6) continue;
            const w = ctx.measureText(text).width;
            let best = null, bestScore = -Infinity;
            for (const rad of [rr, rr + fs / 2 + 6]) {
                for (let k = 0; k < 72; k++) {
                    const a = (k / 72) * TAU;
                    const x = ox + Math.cos(a) * rad, y = oy + Math.sin(a) * rad;
                    const box = { l: x - w / 2 - 3, r: x + w / 2 + 3, t: y - fs / 2 - 2, b: y + fs / 2 + 2 };
                    if (box.l < 4 || box.r > viewW - 4 || box.t < 4 || box.b > viewH - 4) continue;
                    if (keepOut.some((q) => overlaps(box, q))) continue;
                    if (nearPoint(box, bx, by, r + 4) || nearPoint(box, h.x, h.y, 9)) continue;
                    let score = Math.min(...avoid.map((v) => angDist(a, v)));
                    if (first) score -= 0.25 * angDist(a, first.a);   // keep the pair together where possible
                    if (rad !== rr) score -= 1;                         // on the ring is better than beside it
                    if (score > bestScore) { bestScore = score; best = { a, x, y, box }; }
                }
                if (best && rad === rr) break;
            }
            if (!best) continue;
            keepOut.push(best.box);
            if (!first) first = best;
            ctx.strokeText(text, best.x, best.y);
            ctx.fillText(text, best.x, best.y);
        }
    }

    // The orbit a held or aimed body would have on release.
    function predictLaunch(b) {
        const p = placementPrimary(b.x, b.y, b.m, b);
        if (!p) return null;
        const rx = b.x - p.x, ry = b.y - p.y;
        const r = Math.hypot(rx, ry);
        if (!(r > 0)) return null;
        const mu = G * (b.m + p.m);
        const vc = Math.sqrt(mu / r), ve = Math.SQRT2 * vc;
        let vx, vy;
        const fv = frameVelocity();
        if (b.aim) { vx = fv.x + b.aim.vx - p.vx; vy = fv.y + b.aim.vy - p.vy; }
        else if (settings.placement === 'circular') {
            const s = senseAround(b, p);
            vx = (-s * ry / r) * vc; vy = (s * rx / r) * vc;
        } else if (settings.placement === 'rest') { vx = fv.x - p.vx; vy = fv.y - p.vy; }
        else { vx = b.vx - p.vx; vy = b.vy - p.vy; }
        return { p, el: relElements(rx, ry, vx, vy, mu), vc, ve };
    }

    // A body being dragged from the palette, drawn where it would land.
    function drawPaletteGhost() {
        if (!paletteDrag || !paletteDrag.over) return;
        const k = KINDS[paletteDrag.kind] || KINDS.custom;
        const x = paletteDrag.cx, y = paletteDrag.cy;
        const r = Math.max(symbolicRadius(k.R) * sizeScale, 4);
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = paletteDrag.kind === 'custom' ? '#ae85ca' : k.color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (settings.placement === 'circular' && settings.preview) {
            const X = wx(x), Y = wy(y);
            const p = placementPrimary(X, Y, k.m, null);
            if (p) {
                const rr = Math.hypot(X - p.dx, Y - p.dy) * scale;
                ctx.strokeStyle = hexA(k.color, 0.7);
                ctx.lineWidth = 1.4;
                ctx.setLineDash([5, 5]);
                ctx.beginPath();
                ctx.arc(sx(p.dx), sy(p.dy), rr, 0, TAU);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }
    }

    // ------------------------------------------------------------------
    // Readouts
    // ------------------------------------------------------------------
    function setText(el, t) { if (el && el.textContent !== t) el.textContent = t; }

    function updateReadouts() {
        const tm = fmtTime(simTime);
        setText(ui.statTime, tm.v);
        setText(ui.statTimeUnit, tm.u);
        const b = bodyById(selectedId);
        if (!b) {
            setText(ui.subjectName, '–'); setText(ui.subjectAround, '');
            setText(ui.statDist, '–'); setText(ui.statSpeed, '–'); setText(ui.statForce, '–');
            return;
        }
        if (ui.subjectDot) ui.subjectDot.style.background = b.color;
        setText(ui.subjectName, b.name);
        const p = b.primary;
        const top = !p || (p.primary === b && b.m > p.m);
        let dist, speed, force;
        if (bodies.length < 2) {
            setText(ui.subjectAround, 'on its own');
            setText(ui.statDist, '–'); setText(ui.statDistUnit, 'AU');
            setText(ui.statSpeed, '–'); setText(ui.statForce, '–');
            return;
        }
        const pr = b.held && !top ? predictLaunch(b) : null;
        if (top) {
            // The heaviest body: its motion around the centre of mass (with the aimed velocity while aiming)
            const c = totals(bodies);
            const fv = b.aim ? frameVelocity() : null;
            const vx = b.aim ? fv.x + b.aim.vx : b.vx, vy = b.aim ? fv.y + b.aim.vy : b.vy;
            dist = Math.hypot(b.x - c.x, b.y - c.y);
            speed = Math.hypot(vx - c.vx, vy - c.vy);
            force = Math.hypot(b.fx, b.fy);
            setText(ui.subjectAround, 'around the centre of mass');
        } else if (pr) {
            // Being moved or aimed: the orbit it would have if let go now, as the hint and preview show
            dist = pr.el.r;
            speed = pr.el.v;
            force = (G * b.m * pr.p.m) / (dist * dist);
            setText(ui.subjectAround, pr.el.bound ? `around ${theName(pr.p)}` : `escaping ${theName(pr.p)}`);
        } else {
            dist = Math.hypot(b.x - p.x, b.y - p.y);
            speed = Math.hypot(b.vx - p.vx, b.vy - p.vy);
            force = (G * b.m * p.m) / (dist * dist);
            setText(ui.subjectAround, b.bound ? `around ${theName(p)}` : `escaping ${theName(p)}`);
        }
        const d = fmtDistance(dist);
        setText(ui.statDist, d.v);
        setText(ui.statDistUnit, d.u);
        const s = fmtSpeedKms(speed * AUYR_KMS);
        setText(ui.statSpeed, s.v);
        if (ui.statSpeed && ui.statSpeed.nextSibling) {
            const t = ` ${s.u}`;
            if (ui.statSpeed.nextSibling.textContent !== t) ui.statSpeed.nextSibling.textContent = t;
        }
        setText(ui.statForce, force > 0 ? fmtSci(forceToNewtons(force), 2) : '0');
    }

    function forceToNewtons(f) { return f * MSUN_KG * AU_M / (YEAR_S * YEAR_S); }
    function theName(b) { return ['Sun', 'Moon'].includes(b.name) ? `the ${b.name}` : b.name; }

    // ------------------------------------------------------------------
    // Popover: double-click (or double-tap / long-press) a body
    // ------------------------------------------------------------------
    let popBody = null;
    let popSpeedMax = 1;
    let popLastInput = 0;
    let popNextUpdate = 0;

    function buildSwatches() {
        if (!ui.popColours) return;
        ui.popColours.textContent = '';
        for (const c of SWATCHES) {
            const s = document.createElement('button');
            s.type = 'button';
            s.className = 'orb-swatch';
            s.style.background = c;
            s.dataset.color = c;
            s.setAttribute('role', 'radio');
            s.setAttribute('aria-label', `Colour ${c}`);
            s.addEventListener('click', () => {
                if (!popBody) return;
                popBody.color = c;
                updatePopover(true);
            });
            ui.popColours.appendChild(s);
        }
    }

    function openPopover(b) {
        if (!ui.pop || !b) return;
        popBody = b;
        selectBody(b.id);
        ui.pop.hidden = false;
        popSpeedMax = 0;
        updatePopover(true);
        positionPopover(b, true);
    }

    function closePopover() {
        if (!ui.pop) return;
        if (ui.pop.contains(document.activeElement)) document.activeElement.blur();
        popBody = null;
        ui.pop.hidden = true;
    }

    // Beside the body on wider screens (kept on screen, it may overlap the palette); on phones in
    // portrait a sheet along the bottom of the screen, with the page scrolled so the canvas shows above it.
    function positionPopover(b, opening) {
        const sheet = window.innerWidth < 600 && window.innerHeight > window.innerWidth;
        ui.pop.classList.toggle('is-sheet', sheet);
        if (sheet) {
            ui.pop.style.left = '';
            ui.pop.style.top = '';
            if (opening && !document.body.classList.contains('sim-fullscreen-active')) {
                const cr = canvas.getBoundingClientRect();
                const sheetTop = window.innerHeight - ui.pop.offsetHeight;
                const y = cr.top + sy(b.dy);
                // Keep the body (and as much of the canvas as fits) above the sheet
                let delta = 0;
                if (cr.bottom > sheetTop - 8) delta = Math.min(cr.bottom - (sheetTop - 8), cr.top - 8);
                if (y - delta > sheetTop - 24) delta = y - (sheetTop - 24);
                if (Math.abs(delta) > 2) window.scrollBy({ top: delta, behavior: 'smooth' });
            }
            return;
        }
        const wrap = ui.pop.parentElement;
        const wr = wrap.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
        const ox = cr.left - wr.left, oy = cr.top - wr.top;
        const pw = ui.pop.offsetWidth, ph = ui.pop.offsetHeight;
        const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
        // Room in canvas coordinates: within the canvas when it fits, otherwise anywhere on screen
        const minX = 6 - cr.left, maxX = window.innerWidth - cr.left - 6;
        const fits = ph <= cr.height - 12;
        const minY = fits ? 6 : 6 - cr.top, maxY = fits ? cr.height - 6 : window.innerHeight - cr.top - 6;
        let left = x + r + 18;
        if (left + pw > Math.min(cr.width, maxX) && x - r - 18 - pw > minX) left = x - r - 18 - pw;
        let top = y - ph / 2;
        left = clamp(left, minX, Math.max(minX, maxX - pw));
        top = clamp(top, minY, Math.max(minY, maxY - ph));
        ui.pop.style.left = `${Math.round(ox + left)}px`;
        ui.pop.style.top = `${Math.round(oy + top)}px`;
    }

    function speedRelative(b) {
        const p = b.primary && !(b.primary.primary === b && b.m > b.primary.m) ? b.primary : null;
        if (p) return { p, vx: b.vx - p.vx, vy: b.vy - p.vy };
        const c = totals(bodies);
        return { p: null, vx: b.vx - c.vx, vy: b.vy - c.vy };
    }

    function updatePopover(force) {
        if (!popBody || !ui.pop || ui.pop.hidden) return;
        const now = performance.now();
        if (!force && now < popNextUpdate) return;
        popNextUpdate = now + 150;
        const b = popBody;
        const typing = document.activeElement === ui.popName;
        if (ui.popDot) ui.popDot.style.background = b.color;
        if (!typing && ui.popName.value !== b.name) ui.popName.value = b.name;
        const locked = frameId === b.id;
        ui.popLock.setAttribute('aria-pressed', locked ? 'true' : 'false');
        setText(ui.popLockText, locked ? 'Viewing from here' : 'View from here');
        ui.popLock.title = locked ? 'Go back to the centre-of-mass view' : `Lock the view on ${b.name}: everything is shown relative to it`;
        const recent = now - popLastInput < 600;
        if (!recent || force) {
            ui.popMass.value = String(Math.log10(b.m / MEARTH));
            ui.popRadius.value = String(Math.log10(Math.max(1, b.R)));
        }
        setText(ui.popMassVal, fmtMass(b.m));
        setText(ui.popRadiusVal, `${fmtKm(b.R)} km`);
        // Speed relative to the primary, on a slider up to 1.6x the escape speed
        const sr = speedRelative(b);
        const v = Math.hypot(sr.vx, sr.vy);
        let note = '';
        if (sr.p) {
            const r = Math.hypot(b.x - sr.p.x, b.y - sr.p.y);
            const vc = Math.sqrt((G * (b.m + sr.p.m)) / r), ve = Math.SQRT2 * vc;
            if (!popSpeedMax || force && !recent) popSpeedMax = Math.max(1.6 * ve, 1.15 * v);
            note = `Circular ${fmtSpeedKms(vc * AUYR_KMS).v} · escape ${fmtSpeedKms(ve * AUYR_KMS).v} ${fmtSpeedKms(ve * AUYR_KMS).u}, relative to ${theName(sr.p)}`;
        } else {
            if (!popSpeedMax) popSpeedMax = Math.max(1.15 * v, 1e-6);
            note = 'Relative to the centre of mass';
        }
        if (!recent) ui.popSpeed.value = String(Math.round(clamp(v / popSpeedMax, 0, 1) * 1000));
        const sp = fmtSpeedKms(v * AUYR_KMS);
        setText(ui.popSpeedVal, `${sp.v} ${sp.u}`);
        setText(ui.popSpeedNote, note);
        ui.popCircular.disabled = !sr.p;
        // Colour swatches
        ui.popColours.querySelectorAll('.orb-swatch').forEach((s) => s.setAttribute('aria-checked', s.dataset.color === b.color ? 'true' : 'false'));
        // Newton's law for this body and its primary, and its orbit
        let info = '';
        if (sr.p) {
            const p = sr.p;
            const r = Math.hypot(b.x - p.x, b.y - p.y);
            const Fn = forceToNewtons((G * b.m * p.m) / (r * r));
            const el = elementsOf(b, p);
            const dd = fmtDistance(r);
            info = `<strong>Pull of ${escapeHtml(theName(p))}:</strong> F = Gm₁m₂/r² = ${fmtSci(Fn, 2)} N<br>`;
            info += el.bound ? `<strong>Orbit:</strong> ${dd.v} ${dd.u} away, e = ${el.e.toFixed(3)}, period ${fmtDuration(el.T, true)}`
                : `<strong>Not bound:</strong> ${dd.v} ${dd.u} away and escaping (e = ${el.e.toFixed(2)})`;
        } else if (bodies.length > 1) {
            info = `<strong>Heaviest body.</strong> Pull of the others: ${fmtSci(forceToNewtons(Math.hypot(b.fx, b.fy)), 2)} N`;
        } else {
            info = '<strong>On its own:</strong> nothing to pull on it.';
        }
        info += `<br><strong>Mass:</strong> ${fmtSci(b.m * MSUN_KG, 2)} kg`;
        if (ui.popInfo.innerHTML !== info) ui.popInfo.innerHTML = info;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function bindPopover() {
        if (!ui.pop) return;
        buildSwatches();
        ui.popClose.addEventListener('click', closePopover);
        ui.popLock.addEventListener('click', () => {
            if (!popBody) return;
            setFrame(frameId === popBody.id ? null : popBody.id);
        });
        ui.popCircular.addEventListener('click', () => {
            const b = popBody;
            if (!b || !b.primary) return;
            const p = b.primary;
            keepView(() => launchCircular(b, p, senseAround(b, p)));
            resetTracking(b); resetTracking(p);
            computePrimaries();
            syncEccentricity(true);
            updatePopover(true);
        });
        ui.popDelete.addEventListener('click', () => {
            const b = popBody;
            closePopover();
            deleteBody(b);
        });
        ui.popName.addEventListener('input', () => {
            if (!popBody) return;
            const n = ui.popName.value.trim().slice(0, 18);
            popBody.name = n || popBody.name;
            refreshBodyLists();
            syncEccentricity(true);
        });
        ui.popName.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.popName.blur(); });
        const snapLog = (v, snaps) => {
            for (const s of snaps) if (Math.abs(v - Math.log10(s)) < 0.04) return Math.log10(s);
            return v;
        };
        ui.popMass.addEventListener('input', () => {
            const b = popBody;
            if (!b) return;
            popLastInput = performance.now();
            const lg = snapLog(parseFloat(ui.popMass.value), MASS_SNAPS.map((m) => m / MEARTH));
            keepView(() => { b.m = Math.pow(10, lg) * MEARTH; });
            resetTracking(b);
            computeForces();
            computePrimaries();
            updatePopover(true);
        });
        ui.popRadius.addEventListener('input', () => {
            const b = popBody;
            if (!b) return;
            popLastInput = performance.now();
            b.R = Math.pow(10, snapLog(parseFloat(ui.popRadius.value), RADIUS_SNAPS));
            updatePopover(true);
        });
        ui.popSpeed.addEventListener('input', () => {
            const b = popBody;
            if (!b) return;
            popLastInput = performance.now();
            const sr = speedRelative(b);
            const vNew = (parseFloat(ui.popSpeed.value) / 1000) * popSpeedMax;
            let ux, uy;
            const v = Math.hypot(sr.vx, sr.vy);
            if (v > 1e-12) { ux = sr.vx / v; uy = sr.vy / v; } else if (sr.p) {
                const rx = b.x - sr.p.x, ry = b.y - sr.p.y, r = Math.hypot(rx, ry) || 1;
                const s = orbitSense(sr.p, b);
                ux = -s * ry / r; uy = s * rx / r;
            } else { ux = 1; uy = 0; }
            const base = sr.p ? { x: sr.p.vx, y: sr.p.vy } : (() => { const c = totals(bodies); return { x: c.vx, y: c.vy }; })();
            keepView(() => { b.vx = base.x + ux * vNew; b.vy = base.y + uy * vNew; });
            resetTracking(b);
            k2.bid = null;
            computePrimaries();
            syncEccentricity(true);
            updatePopover(true);
        });
        // Keep clicks and drags in the popover away from the canvas handlers and the page
        ['pointerdown', 'dblclick', 'wheel'].forEach((t) => ui.pop.addEventListener(t, (e) => e.stopPropagation()));
    }

    // ------------------------------------------------------------------
    // Palette (drag a body onto the canvas, or tap to add it at a free spot)
    // ------------------------------------------------------------------
    let paletteDrag = null;
    let ghostEl = null;

    function buildPalette() {
        if (!ui.palette) return;
        ui.palette.textContent = '';
        for (const kind of PALETTE) {
            const k = KINDS[kind];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'orb-chip';
            btn.dataset.kind = kind;
            const label = kind === 'custom' ? 'Custom' : k.name;
            btn.dataset.title = kind === 'custom' ? 'Your own body: drag it into space, then set its mass, speed and colour'
                : `${k.name} (${fmtMass(k.m)}): drag it into space, or click to add it`;
            btn.title = btn.dataset.title;
            btn.setAttribute('aria-label', kind === 'custom' ? 'Add a custom body' : `Add ${k.name}`);
            const disc = document.createElement('span');
            disc.className = 'orb-chip-disc' + (kind === 'custom' ? ' is-custom' : '');
            const d = kind === 'custom' ? 18 : Math.round(clamp(6 + symbolicRadius(k.R) * 0.75, 9, 20));
            disc.style.width = `${d}px`;
            disc.style.height = `${d}px`;
            if (kind !== 'custom') {
                disc.style.background = `radial-gradient(circle at 35% 35%, ${mix(k.color, '#ffffff', 0.4)}, ${k.color})`;
                if (k.m >= STAR_MASS) disc.style.boxShadow = `0 0 8px ${hexA(k.color, 0.55)}`;
            }
            const name = document.createElement('span');
            name.className = 'orb-chip-name';
            name.textContent = label;
            btn.append(disc, name);
            btn.addEventListener('pointerdown', (e) => onChipDown(e, btn));
            btn.addEventListener('pointermove', onChipMove);
            btn.addEventListener('pointerup', onChipUp);
            btn.addEventListener('pointercancel', onChipCancel);
            btn.addEventListener('click', () => {
                if (btn.dataset.dragged === '1') { btn.dataset.dragged = ''; return; }
                const b = addBodyAuto(kind);
                if (b && kind === 'custom') openPopover(b);
            });
            ui.palette.appendChild(btn);
        }
    }

    function onChipDown(e, btn) {
        if (btn.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
        paletteDrag = { kind: btn.dataset.kind, btn, id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, over: false, cx: 0, cy: 0 };
        btn.dataset.dragged = '';
        try { btn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }

    function onChipMove(e) {
        const d = paletteDrag;
        if (!d || e.pointerId !== d.id) return;
        if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 6) {
            d.moved = true;
            d.btn.classList.add('is-dragging');
            if (!ghostEl) {
                ghostEl = document.createElement('div');
                ghostEl.className = 'orb-drag-ghost';
                document.body.appendChild(ghostEl);
            }
            const k = KINDS[d.kind];
            ghostEl.style.background = d.kind === 'custom' ? '#ae85ca' : k.color;
            setHint('drop');
        }
        if (!d.moved) return;
        const r = canvas.getBoundingClientRect();
        d.over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        d.cx = e.clientX - r.left; d.cy = e.clientY - r.top;
        ghostEl.style.display = d.over ? 'none' : 'block';
        ghostEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    }

    function onChipUp(e) {
        const d = paletteDrag;
        if (!d || e.pointerId !== d.id) return;
        paletteDrag = null;
        d.btn.classList.remove('is-dragging');
        if (ghostEl) ghostEl.style.display = 'none';
        if (!d.moved) return;   // a tap: the click handler adds it
        d.btn.dataset.dragged = '1';
        setTimeout(() => { d.btn.dataset.dragged = ''; }, 400);
        if (d.over) {
            updateDrawnPositions();
            const b = addBody(d.kind, wx(d.cx), wy(d.cy));
            if (b && d.kind === 'custom') openPopover(b);
        }
        setHint();
    }

    function onChipCancel(e) {
        const d = paletteDrag;
        if (!d || e.pointerId !== d.id) return;
        paletteDrag = null;
        d.btn.classList.remove('is-dragging');
        if (ghostEl) ghostEl.style.display = 'none';
        setHint();
    }

    // ------------------------------------------------------------------
    // Hint line under the palette
    // ------------------------------------------------------------------
    let lastPointerType = window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';
    const coarse = () => lastPointerType !== 'mouse';
    let hintKey = '';

    function setHint(kind, html) {
        if (!ui.hint) return;
        let h = html;
        if (!h) {
            if (kind === 'drop') h = '<strong>Drop it in space</strong> to add it.';
            else if (coarse()) h = '<strong>Drag</strong> a body into space. Tap a body, then drag its arrow tip to set its velocity. <strong>Double-tap</strong> a body for options.';
            else h = '<strong>Drag</strong> a body into space. Drag bodies to move them, <strong>right-drag</strong> to set their velocity, <strong>double-click</strong> for options.';
        }
        if (h === hintKey) return;
        hintKey = h;
        ui.hint.innerHTML = h;
    }

    function dragHint(d) {
        const b = d.body;
        if (!b) return;
        const pr = predictLaunch(b);
        if (d.mode === 'move') {
            const p = pr && pr.p;
            const where = p ? theName(p) : 'the others';
            const how = settings.placement === 'circular' ? `starts on a circular orbit around ${escapeHtml(where)}`
                : settings.placement === 'rest' ? 'starts at rest in this view' : 'keeps its velocity';
            setHint(null, `<strong>Release</strong> to place ${escapeHtml(b.name)}: it ${how}.`);
        } else if (pr) {
            const v = fmtSpeedKms(Math.hypot(pr.el.v) * AUYR_KMS);
            const fate = pr.el.bound ? (pr.el.e < 0.02 ? 'a circle' : `an ellipse, e = ${pr.el.e.toFixed(2)}`) : 'escapes';
            setHint(null, `<strong>${v.v} ${v.u}</strong> relative to ${escapeHtml(theName(pr.p))}: ${fate}. Circular ${fmtSpeedKms(pr.vc * AUYR_KMS).v}, escape ${fmtSpeedKms(pr.ve * AUYR_KMS).v} ${fmtSpeedKms(pr.ve * AUYR_KMS).u}.`);
        }
    }

    // ------------------------------------------------------------------
    // Canvas input: mouse, pen and touch through pointer events
    //   body: drag = move (held in place while dragged), right-drag = aim its velocity
    //   velocity handle of the selected body: drag = change its velocity
    //   empty space: drag = pan; two fingers = pinch zoom and pan; wheel = zoom
    //   tap/click = select; double-click / double-tap / long-press = popover
    // ------------------------------------------------------------------
    const drags = new Map();   // pointerId -> drag state
    let pinch = null;
    let lastTap = { t: 0, x: 0, y: 0, id: null };
    let longPressTimer = 0;

    function canvasPoint(e) {
        const r = canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function bodyAt(x, y, tol) {
        let best = null, bestD = Infinity;
        for (const b of bodies) {
            const d = Math.hypot(sx(b.dx) - x, sy(b.dy) - y) - drawRadius(b);
            if (d < tol && d < bestD) { bestD = d; best = b; }
        }
        return best;
    }

    function onHandle(x, y, tol) {
        const b = bodyById(selectedId);
        if (!b || b.held || bodies.length < 2) return null;
        const h = handlePos(b);
        if (Math.hypot(h.x - x, h.y - y) > tol) return null;
        // the body itself wins inside its disc
        if (Math.hypot(sx(b.dx) - x, sy(b.dy) - y) < drawRadius(b)) return null;
        return b;
    }

    function startHold(b, d) {
        updateDrawnPositions();
        // A frame that moves with this body must stand still while it is dragged
        if (!freeze && (frameId === null || frameId === b.id)) freeze = { x: F.x, y: F.y };
        b.held = { offX: b.dx - F.x, offY: b.dy - F.y };
        d.frameV = frameVelocity();
        applyHolds();
        updateDrawnPositions();
    }

    function endHold(d, apply) {
        const b = d.body;
        if (!b) return;
        updateDrawnPositions();
        if (apply) {
            if (d.mode === 'aim' && b.aim) {
                const fv = frameId !== null && frameId !== b.id ? frameVelocity() : d.frameV;
                b.vx = fv.x + b.aim.vx; b.vy = fv.y + b.aim.vy;
                resetTracking(b);
                k2.bid = null;
            } else if (d.mode === 'move' && d.moved) {
                launch(b, false);
            }
        }
        b.aim = null;
        b.held = null;
        if (d.mode === 'move' && d.moved) clearTrail(b);
        if (frameId === b.id && d.moved) clearAllTrails();
        forcesDirty = true;
        const stillHeld = bodies.some((c) => c.held);
        if (freeze && !stillHeld) {
            const fz = freeze;
            freeze = null;
            updateDrawnPositions();
            view.panX += fz.x - F.x;
            view.panY += fz.y - F.y;
            if (frameId !== null) view.anim = { zoom: view.zoom, panX: 0, panY: 0 };
        }
        computeForces();
        computePrimaries();
        syncEccentricity(true);
        setHint();
    }

    function endAllDrags() {
        for (const d of drags.values()) if (d.body && d.body.held) { d.body.held = null; d.body.aim = null; }
        drags.clear();
        pinch = null;
        freeze = null;
    }

    // Held bodies stay where they are held in the (possibly frozen) frame while others move.
    function applyHolds() {
        if (!bodies.some((b) => b.held)) return;
        const origin = stateFrameOrigin();
        for (const b of bodies) {
            if (!b.held) continue;
            b.x = origin.x + b.held.offX;
            b.y = origin.y + b.held.offY;
        }
        forcesDirty = true;
    }

    function onPointerDown(e) {
        lastPointerType = e.pointerType || 'mouse';
        const pt = canvasPoint(e);
        updateDrawnPositions();
        const touch = lastPointerType !== 'mouse';
        // Second finger: pinch (unless the first one is holding a body)
        if (drags.size === 1 && touch) {
            const first = [...drags.values()][0];
            if (first.mode === 'pending' || first.mode === 'pan' || (first.mode === 'press' && !first.moved)) {
                clearTimeout(longPressTimer);
                if (first.mode === 'press' && first.body) { /* not moved yet: nothing to undo */ }
                first.mode = 'pinch';
                drags.set(e.pointerId, { id: e.pointerId, mode: 'pinch', x: pt.x, y: pt.y, x0: pt.x, y0: pt.y, type: lastPointerType });
                const a = first, b = drags.get(e.pointerId);
                pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom0: view.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
                pinch.wx = wx(pinch.mx); pinch.wy = wy(pinch.my);
                try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                e.preventDefault();
                return;
            }
            return;
        }
        if (drags.size > 0) return;
        const tol = touch ? 16 : 5;
        const handleBody = onHandle(pt.x, pt.y, touch ? 22 : 11);
        const b = handleBody ? null : bodyAt(pt.x, pt.y, tol);
        const d = { id: e.pointerId, x: pt.x, y: pt.y, x0: pt.x, y0: pt.y, type: lastPointerType, moved: false, body: null, mode: 'pending', button: e.button };
        if (handleBody) {
            d.mode = 'handle';
            d.body = handleBody;
            const tip = velocityTip(handleBody);
            d.v0 = { x: tip.vx, y: tip.vy };
            startHold(handleBody, d);
            handleBody.aim = { vx: d.v0.x, vy: d.v0.y };
            d.mode = 'aim';
            d.relative = true;
        } else if (b) {
            d.body = b;
            if (e.button === 2) {
                d.mode = 'aim';
                d.relative = false;
                startHold(b, d);
                const tip = velocityTip(b);
                b.aim = { vx: tip.vx, vy: tip.vy };
            } else {
                d.mode = 'press';
                if (touch) {
                    longPressTimer = setTimeout(() => {
                        if (drags.get(e.pointerId) === d && !d.moved) {
                            d.mode = 'done';
                            openPopover(b);
                        }
                    }, 520);
                }
            }
        } else {
            d.mode = 'pending';
        }
        drags.set(e.pointerId, d);
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (d.mode === 'aim') { dragHint(d); }
        updateCursor(pt.x, pt.y);
        e.preventDefault();
    }

    function onPointerMove(e) {
        const pt = canvasPoint(e);
        const d = drags.get(e.pointerId);
        if (!d) {
            if ((e.pointerType || 'mouse') === 'mouse') updateCursor(pt.x, pt.y);
            return;
        }
        const dx = pt.x - d.x, dy = pt.y - d.y;
        d.x = pt.x; d.y = pt.y;
        const far = Math.hypot(pt.x - d.x0, pt.y - d.y0) > (d.type === 'mouse' ? 3 : 8);
        if (d.mode === 'pinch') {
            const pts = [...drags.values()].filter((q) => q.mode === 'pinch');
            if (pts.length === 2 && pinch) {
                const [a, b] = pts;
                const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
                const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
                view.zoom = clamp(pinch.zoom0 * dist / pinch.d0, 1e-7, 1e7);
                view.anim = null;
                updateScale();
                // keep the world point that was under the fingers' midpoint under it
                view.panX = pinch.wx - F.x - (mx - viewW / 2) / scale;
                view.panY = pinch.wy - F.y + (my - viewH / 2) / scale;
            }
            return;
        }
        if (d.mode === 'pending' && far) d.mode = 'pan';
        if (d.mode === 'pan') {
            view.panX -= dx / scale;
            view.panY += dy / scale;
            view.anim = null;
            return;
        }
        if (d.mode === 'press' && far) {
            clearTimeout(longPressTimer);
            d.mode = 'move';
            d.moved = true;
            startHold(d.body, d);
            closePopover();
        }
        if (d.mode === 'move' && d.body) {
            const b = d.body;
            b.held.offX += dx / scale;
            b.held.offY -= dy / scale;
            applyHolds();
            updateDrawnPositions();
            dragHint(d);
            return;
        }
        if (d.mode === 'aim' && d.body) {
            const b = d.body;
            const tau = arrowTime();
            if (d.relative) {
                b.aim.vx = d.v0.x + (pt.x - d.x0) / (scale * tau);
                b.aim.vy = d.v0.y - (pt.y - d.y0) / (scale * tau);
            } else if (far || d.moved) {
                b.aim.vx = (pt.x - sx(b.dx)) / (scale * tau);
                b.aim.vy = -(pt.y - sy(b.dy)) / (scale * tau);
            }
            if (far) d.moved = true;
            dragHint(d);
        }
    }

    function onPointerUp(e) {
        const d = drags.get(e.pointerId);
        if (!d) return;
        clearTimeout(longPressTimer);
        drags.delete(e.pointerId);
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        const cancelled = e.type === 'pointercancel';
        if (d.mode === 'pinch') {
            // The remaining finger carries on panning
            for (const q of drags.values()) { q.mode = 'pan'; q.x0 = q.x; q.y0 = q.y; }
            pinch = null;
            return;
        }
        if (d.mode === 'move' || d.mode === 'aim') {
            endHold(d, !cancelled && (d.mode === 'move' || d.moved || !d.relative));
            return;
        }
        if (cancelled || d.mode === 'done') return;
        if (d.mode === 'press' || d.mode === 'pending') {
            // A tap or click
            const now = performance.now();
            const b = d.body;
            const dbl = now - lastTap.t < 380 && Math.hypot(d.x0 - lastTap.x, d.y0 - lastTap.y) < (d.type === 'mouse' ? 8 : 26) && lastTap.id === (b ? b.id : null);
            lastTap = { t: dbl ? 0 : now, x: d.x0, y: d.y0, id: b ? b.id : null };
            if (b) {
                if (dbl) openPopover(b);
                else {
                    if (popBody && popBody !== b) closePopover();
                    selectBody(b.id);
                }
            } else if (dbl) {
                closePopover();
                if (frameId !== null) setFrame(null);
            } else if (popBody) {
                closePopover();
            }
        }
    }

    function updateCursor(x, y) {
        canvas.classList.remove('orb-can-grab', 'orb-grabbing', 'orb-can-aim');
        if (drags.size) {
            const d = [...drags.values()][0];
            canvas.classList.add(d.mode === 'aim' ? 'orb-can-aim' : 'orb-grabbing');
            return;
        }
        updateDrawnPositions();
        if (onHandle(x, y, 11)) canvas.classList.add('orb-can-aim');
        else if (bodyAt(x, y, 5)) canvas.classList.add('orb-can-grab');
    }

    function onWheel(e) {
        e.preventDefault();
        const pt = canvasPoint(e);
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
        updateDrawnPositions();
        zoomAt(pt.x, pt.y, Math.exp(-dy * 0.0015));
    }

    // ------------------------------------------------------------------
    // Charts (energy of the system; distance and speed of the selected body)
    // ------------------------------------------------------------------
    let charts = null;
    let lastChartSample = -Infinity;

    function chartColors() {
        const dark = isDark();
        return { text: dark ? '#e0e0e0' : '#585858', grid: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' };
    }

    function supExp(n) { return String(n).split('').map((c) => SUP[c]).join(''); }

    function makeCharts() {
        if (typeof Chart === 'undefined') return null;
        const c = chartColors();
        const common = (yTitle) => ({
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { labels: { color: c.text, boxWidth: 12 } } },
            scales: {
                x: { ticks: { color: c.text, maxTicksLimit: 6, maxRotation: 0 }, grid: { color: c.grid }, title: { display: true, text: `Time (${fmtTime(0).u})`, color: c.text } },
                y: { ticks: { color: c.text }, grid: { color: c.grid }, title: { display: true, text: yTitle, color: c.text } }
            }
        });
        const e1 = byId('energyChart'), e2 = byId('orbitChart');
        if (!e1 || !e2) return null;
        const energy = new Chart(e1, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    { label: 'Kinetic', data: [], borderColor: '#7bd0c1', borderWidth: 2, pointRadius: 0, tension: 0.2 },
                    { label: 'Potential', data: [], borderColor: '#f2849e', borderWidth: 2, pointRadius: 0, tension: 0.2 },
                    { label: 'Total', data: [], borderColor: '#ae85ca', borderWidth: 2, pointRadius: 0, tension: 0.2 }
                ]
            },
            options: common(`Energy (×10${supExp(energyExp)} J)`)
        });
        const opts = common('Distance');
        opts.scales.y1 = { position: 'right', ticks: { color: c.text }, grid: { drawOnChartArea: false }, title: { display: true, text: 'Speed (km/s)', color: c.text } };
        const orbit = new Chart(e2, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    { label: 'Distance', data: [], borderColor: '#8499e7', borderWidth: 2, pointRadius: 0, tension: 0.2, yAxisID: 'y' },
                    { label: 'Speed', data: [], borderColor: '#7bd0c1', borderWidth: 2, pointRadius: 0, tension: 0.2, yAxisID: 'y1' }
                ]
            },
            options: opts
        });
        return { energy, orbit };
    }

    function chartsVisible() { return !!(charts && ui.chartsContainer && ui.chartsContainer.style.display !== 'none'); }

    function setChartsVisible(visible) {
        if (!ui.chartsContainer) return;
        ui.chartsContainer.style.display = visible ? 'block' : 'none';
        document.body.classList.toggle('charts-visible', visible);
        if (visible && !charts) charts = makeCharts();
        if (visible) resetCharts();
    }

    function resetCharts() {
        lastChartSample = -Infinity;
        if (!charts) return;
        for (const ch of [charts.energy, charts.orbit]) {
            ch.data.labels = [];
            ch.data.datasets.forEach((d) => { d.data = []; });
            ch.options.scales.x.title.text = `Time (${fmtTime(0).u})`;
        }
        charts.energy.options.scales.y.title.text = `Energy (×10${supExp(energyExp)} J)`;
        resetOrbitChart();
        charts.energy.update('none');
    }

    function resetOrbitChart() {
        if (!charts) return;
        const ch = charts.orbit;
        ch.data.labels = [];
        ch.data.datasets.forEach((d) => { d.data = []; });
        const b = bodyById(selectedId);
        const u = scene.units === 'km' ? 'km' : 'AU';
        ch.options.scales.y.title.text = `Distance (${u})`;
        ch.data.datasets[0].label = b ? `${b.name}: distance` : 'Distance';
        ch.data.datasets[1].label = b ? `${b.name}: speed` : 'Speed';
        ch.update('none');
    }

    function systemEnergy() {
        const c = totals(bodies);
        let ke = 0, pe = 0;
        for (const b of bodies) ke += 0.5 * b.m * ((b.vx - c.vx) ** 2 + (b.vy - c.vy) ** 2);
        for (let i = 0; i < bodies.length; i++) {
            for (let j = i + 1; j < bodies.length; j++) {
                const r = Math.hypot(bodies[i].x - bodies[j].x, bodies[i].y - bodies[j].y);
                if (r > 0) pe -= (G * bodies[i].m * bodies[j].m) / r;
            }
        }
        return { ke, pe, total: ke + pe };
    }

    function angularMomentum() {
        const c = totals(bodies);
        let L = 0;
        for (const b of bodies) L += b.m * ((b.x - c.x) * (b.vy - c.vy) - (b.y - c.y) * (b.vx - c.vx));
        return L;
    }

    function sampleCharts() {
        if (!chartsVisible()) return;
        const every = scene.Tref / 60;
        if (simTime - lastChartSample < every) return;
        lastChartSample = simTime;
        const label = fmtTime(simTime).v;
        const E = systemEnergy();
        const k = ENERGY_J / Math.pow(10, energyExp);
        const ce = charts.energy;
        ce.data.labels.push(label);
        ce.data.datasets[0].data.push(E.ke * k);
        ce.data.datasets[1].data.push(E.pe * k);
        ce.data.datasets[2].data.push(E.total * k);
        const co = charts.orbit;
        const b = bodyById(selectedId);
        const p = b && b.primary;
        co.data.labels.push(label);
        if (b && p) {
            const r = Math.hypot(b.x - p.x, b.y - p.y);
            co.data.datasets[0].data.push(scene.units === 'km' ? r * AU_KM : r);
            co.data.datasets[1].data.push(Math.hypot(b.vx - p.vx, b.vy - p.vy) * AUYR_KMS);
        } else {
            co.data.datasets[0].data.push(null);
            co.data.datasets[1].data.push(null);
        }
        for (const ch of [ce, co]) {
            if (ch.data.labels.length > 240) {
                ch.data.labels.shift();
                ch.data.datasets.forEach((d) => d.data.shift());
            }
            ch.update('none');
        }
    }

    new MutationObserver(() => {
        if (!charts) return;
        const c = chartColors();
        for (const ch of [charts.energy, charts.orbit]) {
            ch.options.plugins.legend.labels.color = c.text;
            Object.values(ch.options.scales).forEach((s) => {
                s.ticks.color = c.text;
                if (s.grid && s.grid.color !== undefined) s.grid.color = c.grid;
                if (s.title) s.title.color = c.text;
            });
            ch.update('none');
        }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // ------------------------------------------------------------------
    // Canvas sizing: drawing buffer = CSS size x devicePixelRatio
    // ------------------------------------------------------------------
    function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width));
        const h = Math.max(1, Math.round(rect.height));
        const newDpr = Math.min(2, window.devicePixelRatio || 1);
        if (w === viewW && h === viewH && newDpr === dpr) return;
        const first = !viewW || !viewH;
        viewW = w; viewH = h; dpr = newDpr;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        if ((first || view.pendingBox) && scene) {
            const box = view.pendingBox || scene.box;
            view.pendingBox = null;
            fitBox(box, false);
        }
        updateScale();
        updateDrawnPositions();
        render();
        if (popBody) positionPopover(popBody);
    }

    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resizeCanvas).observe(canvas);
    window.addEventListener('resize', resizeCanvas);

    // ------------------------------------------------------------------
    // Controls
    // ------------------------------------------------------------------
    function updateTrailLabel() {
        const n = TRAIL_STEPS[settings.trailIndex];
        setText(ui.trailVal, n === 0 ? 'off' : fmtDuration(n * scene.Tref));
    }

    function setPaused(p) {
        paused = !!p;
        if (!ui.pause) return;
        ui.pause.setAttribute('aria-pressed', paused ? 'true' : 'false');
        ui.pause.setAttribute('aria-label', paused ? 'Play' : 'Pause');
        ui.pause.title = paused ? 'Play (Space)' : 'Pause (Space)';
        const icon = ui.pause.querySelector('.icon');
        if (icon) { icon.classList.toggle('fa-pause', !paused); icon.classList.toggle('fa-play', paused); }
    }

    function bindControls() {
        const bindCheck = (el, key, after) => {
            if (!el) return;
            el.checked = settings[key];
            el.addEventListener('change', () => { settings[key] = el.checked; if (after) after(); });
        };
        bindCheck(ui.forces, 'forces');
        bindCheck(ui.velocities, 'velocities');
        bindCheck(ui.labels, 'labels');
        bindCheck(ui.k1, 'k1');
        bindCheck(ui.k2, 'k2', () => { k2.bid = null; });
        bindCheck(ui.k3, 'k3');
        bindCheck(ui.com, 'com');
        bindCheck(ui.preview, 'preview');
        bindCheck(ui.merge, 'merge');
        if (ui.speed) {
            const upd = () => {
                settings.speed = parseFloat(ui.speed.value);
                setText(ui.speedVal, settings.speed.toFixed(1));
            };
            ui.speed.addEventListener('input', upd);
            upd();
        }
        if (ui.scene) {
            ui.scene.value = settings.scene;
            ui.scene.addEventListener('change', () => loadScene(ui.scene.value));
        }
        if (ui.ecc) {
            ui.ecc.addEventListener('input', () => {
                eccLastInput = performance.now();
                const e = parseFloat(ui.ecc.value);
                showEccentricity(e);
                applyEccentricity(e);
            });
            ui.ecc.addEventListener('change', () => {
                eccDrag = null;
                // Zoom out if the new orbit no longer fits
                const b = bodyById(selectedId);
                if (b && b.primary) {
                    const el = elementsOf(b, b.primary);
                    const apo = el.bound ? el.a * (1 + el.e) : el.r;
                    updateDrawnPositions();
                    const cx = sx(b.primary.dx), cy = sy(b.primary.dy);
                    const R = apo * scale;
                    if (cx - R < 0 || cx + R > viewW || cy - R < 0 || cy + R > viewH) fitAll();
                }
            });
        }
        if (ui.trail) {
            ui.trail.addEventListener('input', () => {
                settings.trailIndex = parseInt(ui.trail.value, 10) || 0;
                updateTrailLabel();
            });
        }
        if (ui.frame) ui.frame.addEventListener('change', () => setFrame(ui.frame.value === 'com' ? null : parseInt(ui.frame.value, 10)));
        if (ui.frameChip) ui.frameChip.addEventListener('click', () => setFrame(null));
        if (ui.placement) {
            ui.placement.value = settings.placement;
            ui.placement.addEventListener('change', () => { settings.placement = ui.placement.value; });
        }
        if (ui.fit) ui.fit.addEventListener('click', fitAll);
        if (ui.pause) ui.pause.addEventListener('click', () => setPaused(!paused));
        if (ui.reset) ui.reset.addEventListener('click', () => window.orbitsSimulation.reset());
        if (ui.showCharts) {
            ui.showCharts.addEventListener('change', () => setChartsVisible(ui.showCharts.checked));
            setChartsVisible(ui.showCharts.checked);
        }

        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointercancel', onPointerUp);
        canvas.addEventListener('pointerleave', (e) => {
            if (!drags.has(e.pointerId)) canvas.classList.remove('orb-can-grab', 'orb-can-aim');
        });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        canvas.addEventListener('wheel', onWheel, { passive: false });

        // Escape closes the popover first (before the shared handler closes settings or fullscreen);
        // Space pauses.
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && popBody) {
                closePopover();
                e.stopImmediatePropagation();
                e.preventDefault();
                return;
            }
            // Space pauses, unless it would type, press a button or tick a box
            const t = e.target;
            const takesSpace = t && ((t.tagName === 'INPUT' && t.type !== 'range') || ['TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY', 'A', 'LABEL'].includes(t.tagName) || t.isContentEditable);
            if ((e.key === ' ' || e.code === 'Space') && !takesSpace && !e.repeat) {
                setPaused(!paused);
                e.preventDefault();
            }
        }, true);

        // Recolour when the theme changes (palette chips use fixed colours, the canvas redraws itself)
        new MutationObserver(() => render()).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('pointerdown', (e) => {
            lastPointerType = e.pointerType || 'mouse';
            setHint();
        }, true);
    }

    // ------------------------------------------------------------------
    // Main loop (exactly one)
    // ------------------------------------------------------------------
    let fpsFrames = 0, fpsTime = 0;
    let eccNext = 0;

    function frame(ts) {
        requestAnimationFrame(frame);
        const dtReal = lastFrameTs ? Math.min(0.1, (ts - lastFrameTs) / 1000) : 0;
        lastFrameTs = ts;
        updateScale();
        applyHolds();
        if (!paused && dtReal > 0) {
            advance(dtReal * settings.speed * rate());
            applyHolds();
        } else {
            slowedDown = false;
            if (forcesDirty) computeForces();
        }
        lag = paused ? 0 : clamp(acc, 0, nextDt);
        computePrimaries();
        stepViewAnimation(dtReal);
        updateScale();
        updateDrawnPositions();
        render();
        updateReadouts();
        updatePopover(false);
        sampleCharts();
        if (ts > eccNext) { syncEccentricity(false); eccNext = ts + 200; }
        for (const d of drags.values()) if (d.mode === 'move' && d.body && !paused) dragHint(d);

        if (ui.fps) {
            fpsFrames++;
            fpsTime += dtReal;
            if (fpsTime >= 0.5) {
                ui.fps.textContent = `FPS: ${Math.round(fpsFrames / fpsTime)} · ${nextDt > 0 ? Math.round(rate() * settings.speed / 60 / nextDt) : 0} steps/frame`;
                fpsFrames = 0;
                fpsTime = 0;
            }
        }
    }

    // ------------------------------------------------------------------
    // Public API (used by the reset button; handy for testing)
    // ------------------------------------------------------------------
    function bodyInfo(b) {
        const p = b.primary;
        const el = p ? elementsOf(b, p) : null;
        return {
            id: b.id, name: b.name, m: b.m, R: b.R, color: b.color,
            x: b.x, y: b.y, vx: b.vx, vy: b.vy, held: !!b.held,
            screen: { x: sx(b.dx), y: sy(b.dy), r: drawRadius(b) },
            primary: p ? p.name : null, bound: b.bound,
            elements: el ? { a: el.a, e: el.e, T: el.T, r: el.r, v: el.v } : null,
            measured: b.track && b.track.done ? { T: b.track.T, a: b.track.a, revs: b.track.done } : null
        };
    }

    window.orbitsSimulation = {
        reset() { loadScene(settings.scene); setPaused(false); },
        loadScene(key) { if (ui.scene) ui.scene.value = key; loadScene(key); },
        scenes: () => Object.keys(SCENES),
        getState() {
            const E = systemEnergy();
            return {
                time: simTime, paused, scene: settings.scene, units: scene.units,
                selected: selectedId !== null && bodyById(selectedId) ? bodyById(selectedId).name : null,
                frame: frameId !== null && bodyById(frameId) ? bodyById(frameId).name : 'com',
                popover: popBody ? popBody.name : null,
                view: { zoom: view.zoom, panX: view.panX, panY: view.panY, scale, w: viewW, h: viewH },
                energy: E, angularMomentum: angularMomentum(), momentum: totals(bodies),
                bodies: bodies.map(bodyInfo), settings: Object.assign({}, settings), slowedDown
            };
        },
        body(name) { const b = bodies.find((q) => q.name === name); return b ? bodyInfo(b) : null; },
        // Run the physics without drawing (years of simulated time)
        advance(years) {
            let left = years;
            while (left > 1e-12) {
                const chunk = Math.min(left, 0.02 * scene.Tref);
                computePrimaries();
                advance(chunk, 1e9);
                left -= chunk;
            }
            computePrimaries();
            return simTime;
        },
        setPaused,
        setSpeed(v) { settings.speed = v; if (ui.speed) { ui.speed.value = String(v); setText(ui.speedVal, v.toFixed(1)); } },
        select(name) { const b = bodies.find((q) => q.name === name); if (b) selectBody(b.id); },
        lock(name) { const b = name ? bodies.find((q) => q.name === name) : null; setFrame(b ? b.id : null); },
        add(kind, x, y) { const b = addBody(kind, x, y); return b ? bodyInfo(b) : null; },
        setEccentricity(e) { if (ui.ecc) ui.ecc.value = String(e); applyEccentricity(e); eccDrag = null; },
        set(name, props) {
            const b = bodies.find((q) => q.name === name);
            if (!b) return;
            keepView(() => Object.assign(b, props));
            resetTracking(b); computeForces(); computePrimaries();
        },
        kepler() {
            const b = bodyById(selectedId);
            return {
                k2: { dt: k2.dt, areas: k2.sectors.map((s) => Math.abs(s.area)), body: k2.bid !== null && bodyById(k2.bid) ? bodyById(k2.bid).name : null },
                k3: kepler3Rows(b).rows.map((r) => ({ name: r.body.name, a: r.a, T: r.T, ratio: r.ratio, measured: r.measured }))
            };
        },
        toScreen(x, y) { updateDrawnPositions(); return { x: sx(x), y: sy(y) }; },
        toWorld(px, py) { updateDrawnPositions(); return { x: wx(px), y: wy(py) }; },
        fit: fitAll,
        fitBox(box) { fitBox(box, false); },
        setCleanRender(v) { cleanRender = !!v; },
        trailPoints(name) {
            const b = bodies.find((q) => q.name === name);
            if (!b) return [];
            const L = frameId !== null ? bodyById(frameId) : null;
            const out = [];
            const k0 = Math.max(b.trailStart, sampleCount - TRAIL_CAP + 1, L ? L.trailStart : 0);
            for (let k = k0; k < sampleCount; k++) {
                const i = 2 * (k % TRAIL_CAP);
                const ox = L ? L.trail[i] : comTrail[i], oy = L ? L.trail[i + 1] : comTrail[i + 1];
                out.push([b.trail[i] - ox, b.trail[i + 1] - oy]);
            }
            return out;
        },
        settings
    };

    // ------------------------------------------------------------------
    // Start
    // ------------------------------------------------------------------
    buildPalette();
    bindPopover();
    bindControls();
    resizeCanvas();
    loadScene(settings.scene);
    setHint();
    requestAnimationFrame(frame);
})();
