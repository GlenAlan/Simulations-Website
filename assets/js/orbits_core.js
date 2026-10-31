/*
 * Orbits & Gravity simulation - Newtonian n-body gravity in 2D.
 *
 * Units: distances in AU, times in (Julian) years, masses in solar masses, so G = 4 pi^2 and a planet
 * 1 AU from a 1 M_sun star takes one year per orbit. Readouts convert to km, km/s, kg and N.
 *
 * Integration: Yoshida's 4th-order composition of three kick-drift-kick leapfrog steps (symplectic and
 *   time-reversible for a fixed step), with one adaptive step for all bodies, dt = ETA * min over pairs of
 *   sqrt(r^3 / G(m_i + m_j)), so a close pass is taken in many small steps. That is accurate enough for
 *   chaotic three-body encounters (the Pythagorean problem ends as published). Leftover frame time carries
 *   over to the next frame (no step is ever cut short), and the bodies are drawn extrapolated by that
 *   leftover so the motion stays smooth. If a close pass needs more steps than a frame allows, the
 *   simulation slows down for a moment instead of losing accuracy.
 *   Bodies whose real radii touch (checked along each step) merge, conserving mass and momentum; a black
 *   hole swallows whatever crosses its event horizon.
 *
 * Realistic physics (off by default) draws every body at its true size (with a small marker so it can be
 *   found), adds the first post-Newtonian correction of general relativity to each pair (orbits close to a
 *   neutron star or black hole precess) and tears apart a star, planet or moon that strays inside the
 *   Roche limit of a much denser body.
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
        realistic: byId('realisticToggle'),
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
        popRadius: byId('popRadius'), popRadiusVal: byId('popRadiusVal'), popRadiusLabel: byId('popRadiusLabel'),
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
    const C_LIGHT = 299792.458 / AUYR_KMS; // speed of light, AU/yr (63,241)
    const C2 = C_LIGHT * C_LIGHT;
    const NS_MAX_MASS = 2.3;              // M_sun: a heavier neutron star collapses into a black hole
    // Event horizon (Schwarzschild radius 2GM/c^2) of mass m, in km: 2.95 km per solar mass
    const horizonKm = (m) => (2 * G * m / C2) * AU_KM;

    const ETA = 0.004;                    // step = ETA x the shortest pair free-fall time (~1600 steps per circular orbit)
    const MAX_PAIRS_PER_FRAME = 1.2e6;    // force evaluations per frame (x pairs) before the simulation slows down
    const YOSHIDA_W1 = 1 / (2 - Math.cbrt(2)), YOSHIDA_W0 = 1 - 2 * YOSHIDA_W1;
    const MAX_BODIES = 30;
    const SECONDS_PER_TREF = 6;           // real seconds per reference period of the scene at 1x
    const TRAIL_PER_TREF = 300;           // trail samples per reference period
    const TRAIL_CAP = 6144;               // samples kept per body (20 reference periods)
    const TRAIL_STEPS = [0, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20]; // trail lengths in reference periods
    const K2_SECTORS = 12;                // Kepler's 2nd law: sectors per orbit
    const STAR_MASS = 0.07;               // M_sun: heavier bodies are drawn as stars

    // Sample bodies for the palette (and the scenes). Masses and radii are real (radii in km); the drawn
    // size is compressed unless realistic physics is on. The star remnants are drawn by their kind (a
    // black hole stays a black hole whatever its mass). info: the palette chip's tooltip.
    const KINDS = {
        sun: { name: 'Sun', m: 1, R: 696000, color: '#ffd166', info: 'our star' },
        dwarf: { name: 'Red dwarf', m: 0.3, R: 210000, color: '#ff8a5c', info: 'the most common kind of star' },
        redgiant: { name: 'Red giant', m: 1.2, R: 3.0e7, color: '#ff6a48', info: 'an old star swollen to 43 times the Sun\'s size' },
        bluegiant: { name: 'Blue giant', m: 15, R: 4.6e6, color: '#9cc3ff', info: 'a hot, heavy, short-lived star' },
        browndwarf: { name: 'Brown dwarf', m: 0.05, R: 70000, color: '#b86b7f', info: 'too light to shine like a star: 52 Jupiters' },
        whitedwarf: { name: 'White dwarf', m: 0.6, R: 8700, color: '#e9f0ff', info: 'the Earth-sized core left by a star like the Sun' },
        neutron: { name: 'Neutron star', m: 1.4, R: 12, color: '#a9d4ff', info: 'a city-sized core left by a supernova' },
        blackhole: { name: 'Black hole', m: 10, R: horizonKm(10), color: '#ffab5e', info: 'nothing that crosses its event horizon gets out' },
        jupiter: { name: 'Jupiter', m: MJUP, R: 69911, color: '#e0b48a', info: 'the largest planet' },
        earth: { name: 'Earth', m: MEARTH, R: 6371, color: '#7ecaf6', info: 'our planet' },
        mars: { name: 'Mars', m: 0.10745 * MEARTH, R: 3390, color: '#e8825e', info: 'a small rocky planet' },
        moon: { name: 'Moon', m: 0.0123 * MEARTH, R: 1737, color: '#c9ccd3', info: 'Earth\'s moon' },
        comet: { name: 'Comet', m: 1.1e-16, R: 6, color: '#a5e8ff', info: 'a 12 km ball of ice and dust' },
        asteroid: { name: 'Asteroid', m: 4.7e-10, R: 470, color: '#a89f91', info: 'Ceres, the largest asteroid' },
        custom: { name: 'Planet', m: MEARTH, R: 6371, color: '#ae85ca' },
        mercury: { name: 'Mercury', m: 0.0553 * MEARTH, R: 2440, color: '#b5aca3' },
        venus: { name: 'Venus', m: 0.815 * MEARTH, R: 6052, color: '#f0d9a0' },
        probe: { name: 'Probe', m: 4e-28, R: 0.005, color: '#c3ccd8' }
    };
    const PALETTE = [
        { label: 'Stars', kinds: ['sun', 'dwarf', 'redgiant', 'bluegiant', 'browndwarf'] },
        { label: 'Dead stars', kinds: ['whitedwarf', 'neutron', 'blackhole'] },
        { label: 'Planets and moons', kinds: ['jupiter', 'earth', 'mars', 'moon'] },
        { label: 'Small bodies', kinds: ['comet', 'asteroid', 'custom'] }
    ];
    const SWATCHES = ['#ffd166', '#ff8a5c', '#f2849e', '#c75b9b', '#ae85ca', '#8499e7', '#7ecaf6', '#7bd0c1', '#e0b48a', '#c9ccd3'];
    // Values the mass and radius sliders snap to
    const MASS_SNAPS = [KINDS.moon.m, KINDS.mars.m, MEARTH, MJUP, 0.05, 0.3, 0.6, 1, 1.4, 10, 15];
    const RADIUS_SNAPS = [12, 1737, 3390, 6371, 8700, 69911, 210000, 696000, 4.6e6, 3.0e7];

    // ------------------------------------------------------------------
    // Scenes. Bodies are given directly or by orbit elements around an earlier body
    // (a in AU, e, w = direction of the closest point in degrees, nu = start angle from it).
    // Every scene starts with the centre of mass at rest at the origin. Tref: the scene's reference
    // period (6 s on screen at 1x); vref: the speed drawn as a medium arrow (default: the subject's
    // average orbital speed); tip: a line for the hint bar when the scene opens.
    // ------------------------------------------------------------------
    const SCENES = {
        'sun-earth': {
            units: 'au', Tref: 1, subject: 1, box: [-1.2, 1.2, -1.2, 1.2],
            bodies: [{ kind: 'sun' }, { kind: 'earth', orbit: { around: 0, a: 1, e: 0, nu: 0 } }]
        },
        ellipse: {
            units: 'au', Tref: 1, subject: 1, box: [-1.65, 0.45, -0.9, 0.9],
            tip: 'Turn on Kepler\'s 2nd law: the planet speeds up near the Sun, yet the shaded areas stay equal.',
            bodies: [{ kind: 'sun' }, { kind: 'earth', name: 'Planet', orbit: { around: 0, a: 1, e: 0.6, w: 0, nu: 180 } }]
        },
        inner: {
            units: 'au', Tref: 1, subject: 3, box: [-1.7, 1.7, -1.7, 1.7],
            bodies: [
                { kind: 'sun' },
                { kind: 'mercury', orbit: { around: 0, a: 0.387, e: 0.2056, w: 77, nu: 40 } },
                { kind: 'venus', orbit: { around: 0, a: 0.723, e: 0.0068, w: 131, nu: 60 } },
                { kind: 'earth', orbit: { around: 0, a: 1, e: 0.0167, w: 103, nu: 130 } },
                { kind: 'mars', orbit: { around: 0, a: 1.524, e: 0.0934, w: 336, nu: 240 } }
            ]
        },
        comet: {
            units: 'au', Tref: 1, subject: 2, forceBody: 1, trail: 6, box: [-3.85, 1.15, -1.2, 1.2],
            bodies: [
                { kind: 'sun' },
                { kind: 'earth', orbit: { around: 0, a: 1, e: 0.0167, nu: 200 } },
                { kind: 'comet', orbit: { around: 0, a: 2, e: 0.85, w: 0, nu: 150 } }
            ]
        },
        'earth-moon': {
            units: 'km', Tref: 27.32 / DAYS_PER_YEAR, subject: 1, box: [-0.0031, 0.0031, -0.0031, 0.0031],
            bodies: [{ kind: 'earth' }, { kind: 'moon', orbit: { around: 0, a: 384400 / AU_KM, e: 0.0549, nu: 0 } }]
        },
        moon: {
            units: 'au', Tref: 1, subject: 2, trail: 4, box: [-1.15, 1.15, -1.15, 1.15],
            tip: 'Double-click the giant planet to view from it: then the star circles the planet, as the Sun seems to circle Earth.',
            // A heavy giant planet (31 Jupiters) so its moon can orbit at a visible distance: 0.065 AU is
            // 0.3 of its Hill radius, where the star hardly disturbs the moon.
            bodies: [
                { kind: 'sun', name: 'Star' },
                { kind: 'jupiter', name: 'Giant planet', m: 0.03, R: 70000, orbit: { around: 0, a: 1, e: 0, nu: 0 } },
                { kind: 'moon', m: MEARTH, R: 3000, orbit: { around: 1, a: 0.065, e: 0, nu: 90 } }
            ]
        },
        binary: {
            units: 'au', Tref: 2.31, subject: 1, com: true, box: [-1.9, 1.9, -1.3, 1.3],
            bodies: [
                { kind: 'sun', name: 'Star A' },
                { kind: 'dwarf', name: 'Star B', m: 0.5, R: 400000, orbit: { around: 0, a: 2, e: 0.4, w: 0, nu: 0 } }
            ]
        },
        figure8: {
            units: 'au', Tref: 1.0067, subject: 0, trail: 4, vref: 5.5, box: [-1.1, 1.1, -0.45, 0.45],
            tip: 'A rare stable dance: three equal stars chase each other round a figure of eight. Compare it with "Three stars: chaos".',
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
        // Burrau's Pythagorean three-body problem: masses 3, 4 and 5 at rest at the corners of a 3-4-5
        // triangle, each opposite the side of its own length (here in units of 100 AU, so the stars, at
        // their real sizes, never touch). They fall together, swing through close encounters, and after
        // about 60 time units (9,500 years) the 4 and 5 leave as a tight binary and the 3 is flung out
        // (Szebehely & Peters 1967). Chaotic: the integrator's accuracy is enough to end as published.
        pythagorean: {
            units: 'au', Tref: 1200, subject: 0, trail: 3, com: true, vref: 1.6, box: [-420, 330, -260, 360],
            tip: 'Three stars start at rest. Who gets thrown out? It\'s chaos: nudge one star a hair and the dance ends differently.',
            bodies: [
                { kind: 'sun', name: 'Star A', m: 3, R: 1.74e6, color: '#ffd166', at: [100, 300] },
                { kind: 'sun', name: 'Star B', m: 4, R: 2.0e6, color: '#f2849e', at: [-200, -100] },
                { kind: 'sun', name: 'Star C', m: 5, R: 2.3e6, color: '#8fb8ff', at: [100, -100] }
            ]
        },
        // A probe leaves Earth's orbit at 39 km/s, a little faster than the cheapest route to Jupiter, and
        // passes 5 Jupiter radii behind it after 1.8 years (Voyager 1 passed at 4.9). Jupiter turns it
        // through more than 100 degrees, which doubles its speed relative to the Sun: it leaves the solar
        // system for good.
        slingshot: {
            units: 'au', Tref: 1.4, subject: 2, forceBody: 1, trail: 7, vref: 2.75, box: [-7.4, 1.8, -3.2, 3.6],
            tip: 'The probe passes just behind Jupiter. Watch its speed relative to the Sun, and the close-up from Jupiter.',
            bodies: [
                { kind: 'sun' },
                { kind: 'jupiter', orbit: { around: 0, a: 5.2, e: 0, nu: 0, w: 103.14 } },
                { kind: 'probe', orbit: { around: 0, a: 3.50210, e: 0.714457, w: 0, nu: 0 } }
            ]
        },
        // A neutron star on an elliptical orbit 750 to 2,250 km from a black hole, once every 0.3 s. With
        // realistic physics, general relativity turns the ellipse by 16 degrees an orbit.
        blackhole: {
            units: 'km', time: 's', Tref: 0.3 / YEAR_S, subject: 1, trail: 5, box: [-3200, 1700, -1900, 1900].map((v) => v / AU_KM),
            tip: 'Turn on Realistic physics in the settings: relativity makes the orbit swing round, a rosette instead of an ellipse.',
            bodies: [
                { kind: 'blackhole' },
                { kind: 'neutron', orbit: { around: 0, a: 1500 / AU_KM, e: 0.5, w: 0, nu: 180 } }
            ]
        },
        // A Sun-like star on an elliptical orbit round a 1,000-solar-mass black hole, coming within 9 million
        // km of it every 2.2 days: half its own Roche limit. With realistic physics the black hole's tides
        // tear it apart at the first close pass, and the pieces spread out round the orbit. (The hole is
        // much heavier than the star, as in real tidal disruptions, so its own wobble hardly matters.)
        tde: {
            units: 'au', time: 'd', Tref: 0.006, subject: 1, trail: 4, box: [-0.64, 0.11, -0.23, 0.23],
            tip: 'Turn on Realistic physics in the settings: the star dips inside its Roche limit and the black hole\'s tides tear it apart.',
            bodies: [
                { kind: 'blackhole', m: 1000, R: horizonKm(1000) },
                { kind: 'sun', name: 'Star', orbit: { around: 0, a: 0.33, e: 0.818, w: 0, nu: 180 } }
            ]
        },
        empty: {
            units: 'au', Tref: 1, subject: 0, vref: TAU, box: [-1.5, 1.5, -1.5, 1.5],
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
        merge: true,
        realistic: false     // true sizes, relativity (1PN) and tidal break-up
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
    let lastSampleT = 0;
    const comTrail = new Float64Array(TRAIL_CAP * 2);
    const sampleTimes = new Float64Array(TRAIL_CAP);

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
    const COMPACT = { whitedwarf: 1, neutron: 1, blackhole: 1 };
    const isCompact = (b) => !!COMPACT[b.kind];
    const isStar = (b) => b.m >= STAR_MASS && !isCompact(b);
    // How a body is drawn: a star remnant by its kind, otherwise a star (it shines) or a planet
    const lookOf = (b) => (isCompact(b) ? b.kind : b.m >= STAR_MASS ? 'star' : b.kind === 'browndwarf' ? 'browndwarf' : 'planet');
    const bodyById = (id) => { for (const b of bodies) if (b.id === id) return b; return null; };
    const rate = () => scene.Tref / SECONDS_PER_TREF;           // simulated years per real second at 1x
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
        if (ax >= 99.95) return x.toFixed(0);
        if (ax >= 9.995) return x.toFixed(1);
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
    // Scenes count time in years, days (scene.time 'd', or scene.units 'km') or seconds (scene.time 's':
    // orbits round a black hole)
    const timeUnit = () => scene.time || (scene.units === 'km' ? 'd' : 'yr');
    const timeInSeconds = () => timeUnit() === 's';
    function fmtTime(yr) {
        if (timeInSeconds()) {
            const s = yr * YEAR_S;
            return { v: s < 100 ? s.toFixed(2) : s < 1000 ? s.toFixed(1) : Math.round(s).toLocaleString('en-US'), u: 's' };
        }
        if (timeUnit() === 'd') {
            const d = yr * DAYS_PER_YEAR;
            return { v: d < 1000 ? d.toFixed(1) : Math.round(d).toLocaleString('en-US'), u: 'days' };
        }
        return { v: yr < 100 ? yr.toFixed(2) : yr < 1000 ? yr.toFixed(1) : Math.round(yr).toLocaleString('en-US'), u: 'yr' };
    }
    // A duration in s, days or years; precise keeps trailing zeros (a measured period: "1.00 yr")
    function fmtDuration(yr, precise) {
        if (timeInSeconds() || yr * YEAR_S < 600) {
            const s = yr * YEAR_S;
            if (s < 1) return `${precise ? s.toFixed(3) : +s.toFixed(3)} s`;
            return `${precise ? s.toFixed(s < 100 ? 2 : 0) : +s.toFixed(s < 10 ? 2 : 0)} s`;
        }
        if (timeUnit() === 'd' || yr < 0.1) {
            const d = yr * DAYS_PER_YEAR;
            if (precise) return `${d < 100 ? d.toFixed(1) : Math.round(d)} days`;
            return `${d < 10 ? d.toFixed(1) : Math.round(d)} ${d < 1.5 && d >= 0.5 ? 'day' : 'days'}`;
        }
        if (precise) return `${yr < 100 ? yr.toFixed(2) : Math.round(yr).toLocaleString('en-US')} yr`;
        return `${yr < 10 ? +yr.toFixed(2) : Math.round(yr).toLocaleString('en-US')} yr`;
    }
    function fmtSpeedKms(kms) {
        if (kms < 0.1) return { v: (kms * 1000).toFixed(kms < 0.01 ? 2 : 1), u: 'm/s' };
        return { v: kms < 10 ? kms.toFixed(2) : kms < 1000 ? kms.toFixed(1) : Math.round(kms).toLocaleString('en-US'), u: 'km/s' };
    }
    // " (0.24c)" for speeds of at least 1% of the speed of light
    function lightFraction(kms) {
        const f = kms / 299792.458;
        return f >= 0.01 ? ` (${f < 0.995 ? f.toFixed(2) : '1.00'}c)` : '';
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
            grp: null,                    // id of the body it is a piece of (torn apart by tides)
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
    // Accelerations of every body in a list (the bodies, or a copy of them for a prediction), and the
    // shortest pair free-fall time squared, r^3 / G(m_i + m_j), for the step size.
    // With realistic physics each pair also gets the first post-Newtonian (1PN) correction of general
    // relativity (the usual harmonic-coordinate form for the relative motion of two bodies), shared
    // between the two bodies in inverse proportion to their masses:
    //   a = GM/(c^2 r^2) { [(4 + 2 eta) GM/r - (1 + 3 eta) v^2 + 1.5 eta rdot^2] n + (4 - 2 eta) rdot v }
    // where M = m1 + m2, eta = m1 m2 / M^2, n points from body 2 to body 1 and v = v1 - v2. It turns an
    // orbit's ellipse by 6 pi GM / (c^2 a (1 - e^2)) each time round: 43" a century for Mercury,
    // degrees per orbit close to a neutron star or black hole.
    function gravity(list) {
        const n = list.length;
        const pn = settings.realistic;
        for (const b of list) { b.ax = 0; b.ay = 0; }
        let tmin = Infinity;
        for (let i = 0; i < n; i++) {
            const bi = list[i];
            for (let j = i + 1; j < n; j++) {
                const bj = list[j];
                if (bi.grp && bi.grp === bj.grp) continue;   // pieces of one torn-apart body
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
                    if (pn) {
                        const gm = G * msum, eta = (bi.m * bj.m) / (msum * msum);
                        const nx = -dx / r, ny = -dy / r;
                        const vx = bi.vx - bj.vx, vy = bi.vy - bj.vy;
                        const rd = nx * vx + ny * vy, v2 = vx * vx + vy * vy;
                        const f = gm / (C2 * r2);
                        const A = f * ((4 + 2 * eta) * gm / r - (1 + 3 * eta) * v2 + 1.5 * eta * rd * rd);
                        const B = f * (4 - 2 * eta) * rd;
                        const ax = A * nx + B * vx, ay = A * ny + B * vy;
                        bi.ax += (bj.m / msum) * ax; bi.ay += (bj.m / msum) * ay;
                        bj.ax -= (bi.m / msum) * ax; bj.ay -= (bi.m / msum) * ay;
                    }
                }
            }
        }
        return tmin;
    }

    // Accelerations of the bodies, net forces for the arrows, and the next adaptive step.
    function computeForces() {
        const tmin = gravity(bodies);
        for (const b of bodies) { b.fx = b.m * b.ax; b.fy = b.m * b.ay; }
        nextDt = Math.min(ETA * Math.sqrt(tmin), sampleDt);
        forcesDirty = false;
    }

    // One kick-drift-kick leapfrog step for every body in the list that isn't held. The 1PN force
    // depends on the velocities too, so with realistic physics the second kick is done twice: with the
    // forces at the half-step velocities, then again with those at the velocities that gave.
    function leapfrog(list, dt, forces) {
        const h = 0.5 * dt;
        for (const b of list) {
            if (b.held) continue;
            b.vx += h * b.ax; b.vy += h * b.ay;
            b.x += dt * b.vx; b.y += dt * b.vy;
        }
        let tmin = forces();
        for (const b of list) {
            if (b.held) continue;
            b.hx = b.vx; b.hy = b.vy;
            b.vx += h * b.ax; b.vy += h * b.ay;
        }
        if (settings.realistic) {
            tmin = forces();
            for (const b of list) {
                if (b.held) continue;
                b.vx = b.hx + h * b.ax; b.vy = b.hy + h * b.ay;
            }
        }
        return tmin;
    }

    // One 4th-order step: leapfrog steps of w1 dt, w0 dt (backwards: w0 < 0) and w1 dt.
    function yoshida(list, dt, forces) {
        leapfrog(list, YOSHIDA_W1 * dt, forces);
        leapfrog(list, YOSHIDA_W0 * dt, forces);
        return leapfrog(list, YOSHIDA_W1 * dt, forces);
    }

    function step(dt) {
        for (const b of bodies) { b.px = b.x; b.py = b.y; }
        yoshida(bodies, dt, computeForces);
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
                    if (a.held || b.held || (a.grp && a.grp === b.grp)) continue;
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

    // The survivor is the heavier body, or the black hole if there is one (it swallows the other from
    // the inside, whatever their masses).
    function mergeBodies(a, b) {
        const bh = (q) => q.kind === 'blackhole';
        const big = bh(a) !== bh(b) ? (bh(a) ? a : b) : (a.m >= b.m ? a : b), small = big === a ? b : a;
        const M = a.m + b.m;
        const fx = M > 0 ? (a.m * a.x + b.m * b.x) / M : big.x, fy = M > 0 ? (a.m * a.y + b.m * b.y) / M : big.y;
        flashes.push({ x: fx, y: fy, t: performance.now(), color: big.color, r0: drawRadius(big) });
        big.vx = M > 0 ? (a.m * a.vx + b.m * b.vx) / M : big.vx;
        big.vy = M > 0 ? (a.m * a.vy + b.m * b.vy) / M : big.vy;
        big.x = fx; big.y = fy;
        big.m = M;
        // A black hole's horizon grows with its mass; a white dwarf or neutron star keeps its size (they
        // are held up by pressure, not by being big); anything else keeps its density.
        if (!isCompact(big)) big.R = Math.cbrt(a.R * a.R * a.R + b.R * b.R * b.R);
        big.track = null;
        removeBody(small, big);
        collapseIfTooHeavy(big);
    }

    // ------------------------------------------------------------------
    // Tidal disruption (realistic physics). A star, planet, moon or comet that strays inside the Roche
    // limit of a body at least five times heavier, d = 2.44 R (M / m)^(1/3) (the limit for a fluid body
    // held together only by its own gravity), before their surfaces touch, is torn apart. It becomes a
    // line of fragments along the line to the heavy body, all moving as it did; the inner ones are more
    // tightly bound than the outer ones, so they spread out along the orbit into a stream, and if the
    // pass was close enough about half escape. The fragments then move on their own orbits (they don't
    // pull on each other or merge again), the usual "frozen-in" picture of a tidal disruption.
    // ------------------------------------------------------------------
    const ROCHE = 2.44;
    const FRAGMENTS = 9;

    function checkTides() {
        if (!settings.realistic) return false;
        for (const L of bodies) {
            if (L.grp || L.held || isCompact(L) || L.m < 1e-17) continue;   // not probes: they are held together by their structure
            for (const H of bodies) {
                if (H === L || H.held || H.m < 5 * L.m) continue;
                const d = Math.hypot(L.x - H.x, L.y - H.y);
                const roche = (ROCHE * L.R * Math.cbrt(H.m / L.m)) / AU_KM;
                if (d < roche && roche > (H.R + L.R) / AU_KM && disrupt(L, H)) return true;
            }
        }
        return false;
    }

    function disrupt(L, H) {
        const n = Math.min(FRAGMENTS, MAX_BODIES - bodies.length + 1);
        if (n < 3) return false;   // no room for the pieces: it stays whole
        const d = Math.hypot(L.x - H.x, L.y - H.y);
        const ux = (L.x - H.x) / d, uy = (L.y - H.y) / d;
        const span = L.R / AU_KM;
        const parts = [];
        for (let i = 0; i < n; i++) {
            const s = -1 + (2 * i) / (n - 1);
            const f = newBody({ name: uniqueName('Fragment'), kind: L.kind, m: L.m / n, R: L.R / Math.cbrt(n), color: L.color });
            f.grp = L.id;
            f.x = L.x + ux * s * span; f.y = L.y + uy * s * span;
            f.vx = L.vx; f.vy = L.vy;
            f.px = f.x; f.py = f.y;
            parts.push(f);
        }
        flashes.push({ x: L.x, y: L.y, t: performance.now(), color: L.color, r0: drawRadius(L) });
        bodies.push(...parts);
        removeBody(L, parts[(n - 1) >> 1]);   // the view and the readouts pass to the middle piece
        computeForces();
        return true;
    }

    // A neutron star over about 2.3 solar masses can't hold itself up: it becomes a black hole.
    // A black hole's radius is always its event horizon.
    function collapseIfTooHeavy(b) {
        if (b.kind === 'neutron' && b.m > NS_MAX_MASS) {
            b.kind = 'blackhole';
            b.color = KINDS.blackhole.color;
            if (/^Neutron star/.test(b.name)) b.name = uniqueName('Black hole');
            flashes.push({ x: b.x, y: b.y, t: performance.now(), color: '#ffffff', r0: drawRadius(b) });
            refreshBodyLists();
        }
        if (b.kind === 'blackhole') b.R = horizonKm(b.m);
    }

    // Advance the simulation by simDt years (as many whole adaptive steps as fit).
    function advance(simDt, maxSteps) {
        noteRun();   // (edit history: the first run after a change)
        if (forcesDirty) computeForces();
        acc += simDt;
        let steps = 0;
        const pairs = Math.max(1, (bodies.length * (bodies.length - 1)) / 2);
        const limit = maxSteps || clamp(Math.round(MAX_PAIRS_PER_FRAME / (3 * pairs)), 300, 4000);
        while (steps < limit) {
            const dt = nextDt;
            if (!(dt > 0) || acc < dt) break;
            step(dt);
            simTime += dt;
            acc -= dt;
            steps++;
            if (checkMerges()) { refreshBodyLists(); }
            if (checkTides()) { refreshBodyLists(); }
            trackPeriods(simTime);
            k2Step(simTime);
            flybyStep();
            if (simTime >= nextSampleT || (simTime - lastSampleT > sampleDt / 32 && trailBending())) {
                recordSample();
                while (nextSampleT <= simTime) nextSampleT += sampleDt;
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
                if (b.grp && b.grp === p.grp) continue;   // pieces of one body don't pull on each other
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

    // Launch b on a circular orbit around p: relative speed sqrt(G(M + m)/r) at right angles to the line
    // between them. The pair keeps its centre of mass and momentum, so both go round their centre of
    // mass. With inherit, b first takes on p's velocity: a body dropped beside a planet then joins the
    // planet's motion, and the pair carries on round the star together (even a heavy "moon" that would
    // otherwise rob the planet of half its orbital speed).
    function launchCircular(b, p, sense, inherit) {
        const rx = b.x - p.x, ry = b.y - p.y;
        const r = Math.hypot(rx, ry);
        if (r === 0) return;
        const v = Math.sqrt((G * (b.m + p.m)) / r);
        const s = sense || 1;
        const M = b.m + p.m;
        const bvx = inherit ? p.vx : b.vx, bvy = inherit ? p.vy : b.vy;
        const cx = (b.m * b.x + p.m * p.x) / M, cy = (b.m * b.y + p.m * p.y) / M;
        const cvx = (b.m * bvx + p.m * p.vx) / M, cvy = (b.m * bvy + p.m * p.vy) / M;
        setPairRelative(b, p, rx, ry, (-s * ry / r) * v, (s * rx / r) * v, cx, cy, cvx, cvy);
    }

    // Does p itself orbit something heavier (a planet or a moon, not the star at the centre)?
    const isSatellite = (p) => !!(p.primary && p.bound && p.primary.m > p.m);

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
    // Flybys (gravity assists). When the chosen body, much lighter than a planet, passes through the
    // planet's Hill sphere without being captured, its speed relative to the planet's star is noted on
    // the way in and out, and its path relative to the planet is kept (every step) for a close-up. Seen
    // from the planet it leaves as fast as it came, only turned; seen from the star the turn adds the
    // planet's own motion, so it can gain (passing behind the planet) or lose a lot of speed.
    // ------------------------------------------------------------------
    const flyby = { bid: null, pid: null, sid: null, active: false, done: false, hill: 0, vIn: 0, vOut: 0, vNow: 0, relIn: 0, relOut: 0, rmin: 0, rp: 0, pts: [], el0: null };

    function resetFlyby() {
        flyby.bid = null; flyby.active = false; flyby.done = false; flyby.pts = []; flyby.el0 = null;
    }

    function flybyStep() {
        const b = bodyById(selectedId);
        if (!b || b.held || (flyby.bid !== null && flyby.bid !== b.id)) { if (flyby.bid !== null) resetFlyby(); return; }
        if (flyby.active) {
            const q = bodyById(flyby.pid), s = bodyById(flyby.sid);
            if (!q || !s || q.held) { resetFlyby(); return; }
            const dx = b.x - q.x, dy = b.y - q.y, r = Math.hypot(dx, dy);
            flyby.vNow = Math.hypot(b.vx - s.vx, b.vy - s.vy);
            if (r < flyby.rmin) {
                // On the way in, the closest approach of the hyperbola it is on now (the star's pull
                // shifts it as it goes); after it, the measured one. The close-up is scaled by it.
                flyby.rmin = r;
                const el = relElements(dx, dy, b.vx - q.vx, b.vy - q.vy, G * (b.m + q.m));
                flyby.rp = Math.max(Math.min(el.p / (1 + el.e), r), (q.R + b.R) / AU_KM);
            } else {
                flyby.rp = flyby.rmin;
            }
            // points closer together near the planet (where the close-up shows them)
            const n = flyby.pts.length;
            if (Math.hypot(dx - flyby.pts[n - 2], dy - flyby.pts[n - 1]) > 0.04 * Math.max(r, flyby.rp) && n < 6000) flyby.pts.push(dx, dy);
            if (r > flyby.hill) {
                flyby.active = false; flyby.done = true;
                flyby.vOut = flyby.vNow;
                flyby.relOut = Math.hypot(b.vx - q.vx, b.vy - q.vy);
                flyby.pts.push(dx, dy);
            }
            return;
        }
        if (flyby.done) return;
        for (const q of bodies) {
            const s = q.primary;
            if (q === b || !s || q === b.primary || s === b || !(q.hill < Infinity)) continue;
            if (q.m < 10 * b.m || q.m > 0.1 * s.m) continue;   // a light body passing a planet
            const dx = b.x - q.x, dy = b.y - q.y, r = Math.hypot(dx, dy);
            if (r >= q.hill) continue;
            const el = relElements(dx, dy, b.vx - q.vx, b.vy - q.vy, G * (b.m + q.m));
            if (el.bound) continue;   // captured: an orbit, not a flyby
            Object.assign(flyby, {
                bid: b.id, pid: q.id, sid: s.id, active: true, done: false, hill: q.hill, rmin: r,
                vIn: Math.hypot(b.vx - s.vx, b.vy - s.vy), relIn: el.v,
                rp: Math.max(el.p / (1 + el.e), (q.R + b.R) / AU_KM),
                el0: relElements(b.x - s.x, b.y - s.y, b.vx - s.vx, b.vy - s.vy, G * (b.m + s.m)),
                pts: [dx, dy]
            });
            flyby.vNow = flyby.vIn;
            return;
        }
    }

    // ------------------------------------------------------------------
    // Trails
    // ------------------------------------------------------------------
    // Samples are taken at regular times, and in between whenever a body has turned noticeably round
    // the body it orbits (so a fast swing past the closest point stays a smooth curve).
    function recordSample() {
        const k = sampleCount % TRAIL_CAP;
        const c = totals(bodies);
        comTrail[2 * k] = c.x; comTrail[2 * k + 1] = c.y;
        sampleTimes[k] = simTime;
        for (const b of bodies) {
            b.trail[2 * k] = b.x;
            b.trail[2 * k + 1] = b.y;
        }
        sampleCount++;
        lastSampleT = simTime;
    }

    function trailBending() {
        if (!sampleCount) return false;
        const k = 2 * ((sampleCount - 1) % TRAIL_CAP);
        for (const b of bodies) {
            const p = b.primary;
            if (!p || b.held || p.held || b.trailStart >= sampleCount) continue;
            const rx = b.x - p.x, ry = b.y - p.y;
            const ox = b.trail[k] - p.trail[k], oy = b.trail[k + 1] - p.trail[k + 1];
            if (Math.hypot(rx - ox, ry - oy) > 0.035 * Math.hypot(rx, ry)) return true;
        }
        return false;
    }

    // The first sample at or after time t (binary search over the kept samples)
    function sampleAtTime(t) {
        let lo = Math.max(0, sampleCount - TRAIL_CAP + 1), hi = sampleCount - 1;
        if (hi < lo || sampleTimes[hi % TRAIL_CAP] < t) return sampleCount;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (sampleTimes[mid % TRAIL_CAP] < t) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    function clearTrail(b) { b.trailStart = sampleCount; }
    function clearAllTrails() { for (const b of bodies) b.trailStart = sampleCount; }

    // ------------------------------------------------------------------
    // Scenes
    // ------------------------------------------------------------------
    function loadScene(key) {
        noteSceneLoad(key);   // (edit history: loading or restarting a scene can be undone)
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
        // Arrow scales: the subject's pull (or the scene's chosen one) and its average orbital speed
        // read as medium-length arrows
        const subj = bodies[def.forceBody !== undefined ? def.forceBody : def.subject] || null;
        const fs = subj ? Math.hypot(subj.fx, subj.fy) : 0;
        forceRef = fs > 0 ? fs : 1;
        const vs = bodies[def.subject];
        const el = vs && orbitingBody(vs) ? elementsOf(vs, vs.primary) : null;
        vRef = def.vref || (el ? (el.bound ? Math.sqrt(el.mu / el.a) : el.v) : TAU);
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
        resetFlyby();
        setHint(null, def.tip ? `<strong>Tip:</strong> ${def.tip}` : null);
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
    // planet and a giant planet about one and a half times Earth (a red giant is the largest).
    function symbolicRadius(Rkm) {
        return clamp(2.5 * Math.pow(1.5, Math.log10(Math.max(1, Rkm)) - 1), 3, 30);
    }
    // Star remnants are far too small for that: a black hole is drawn the size of a planet (a little
    // larger as it grows), a white dwarf or neutron star as a bright spark.
    function symbolicSize(kind, m, Rkm) {
        if (kind === 'blackhole') return clamp(13 * Math.pow(m / 10, 1 / 6), 9, 19);
        if (kind === 'neutron') return 4.5;
        if (kind === 'whitedwarf') return 5.5;
        return symbolicRadius(Rkm);
    }
    const MARKER_R = 7;   // px: the ring that marks a body drawn at its true (tiny) size

    // The radius that arrows, names and clicks keep clear of (the disc, or the marker ring around it)
    function drawRadius(b) {
        return b.rh || Math.max(bodySize(b) * sizeScale, (b.R / AU_KM) * scale);
    }
    // A torn-apart body's pieces are small
    const bodySize = (b) => (b.grp ? 3.5 : symbolicSize(b.kind, b.m, b.R));

    // Drawn radii for this frame. A moon close to its planet on screen shrinks both discs (down to
    // 3 px) so they never overlap; zoomed in far enough, bodies are drawn at their true size.
    // With realistic physics every body is drawn at its true size (rd), inside a marker ring (rh).
    function computeDrawRadii() {
        if (settings.realistic) {
            for (const b of bodies) {
                b.rd = (b.R / AU_KM) * scale;
                b.rh = Math.max(b.rd, MARKER_R);
            }
            return;
        }
        for (const b of bodies) b.rmax = bodySize(b) * sizeScale;
        for (const b of bodies) {
            const p = b.primary;
            if (!p || !b.bound || b.m >= p.m) continue;
            const d = Math.hypot(b.dx - p.dx, b.dy - p.dy) * scale;
            p.rmax = Math.min(p.rmax, 0.45 * d);
            b.rmax = Math.min(b.rmax, 0.3 * d);
        }
        for (const b of bodies) b.rd = b.rh = Math.max(3, b.rmax, (b.R / AU_KM) * scale);
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
            const opts = [['com', 'Centre of mass (no body)']].concat(bodies.filter((b) => !b.grp || b.id === frameId).map((b) => [String(b.id), b.name]));
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
        noteEdit();   // (edit history: an undo step)
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
        noteEdit();   // (edit history: every edit made through here is an undo step)
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
        noteEdit();   // (edit history: an undo step, taken before the new body's colour is chosen)
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
            if (p) launchCircular(b, p, isNew ? orbitSense(p, b) : senseAround(b, p), isSatellite(p));
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
    // Orbit shape (eccentricity slider): the subject stays where it is and only its velocity changes,
    // as in the menu's orbit editor. The orbit keeps the size (semi-major axis, so the period) it had
    // when the slider started moving, and only the direction of the velocity turns (the same speed and
    // size, a different shape: energy sets the size, angular momentum the shape). A rounder orbit of
    // that size can't pass through where the body is, so below that it sits at the near or far end of
    // its orbit, which shrinks or grows to fit: at 0 it is the circle through where it is.
    // ------------------------------------------------------------------
    let eccDrag = null;      // { a, sense, out } captured when the slider starts moving
    let eccLastInput = 0;

    function applyEccentricity(e) {
        const b = bodyById(selectedId);
        const p = b && b.primary;
        if (!b || !p || p.primary === b && b.m > p.m) return;
        const s = velocityParts(b);
        const r = s.r;
        if (!(r > 0)) return;
        if (!eccDrag || eccDrag.bid !== b.id) {
            const el = elementsOf(b, p);
            const a0 = el.bound ? el.a : r;
            // Moving outward or inward as it was (outward when it is at an end of its orbit)
            eccDrag = { bid: b.id, a: a0, sense: s.sense, out: Math.abs(s.vr) > 1e-3 * s.v ? Math.sign(s.vr) : 1 };
        }
        const mu = G * (b.m + p.m);
        let a = eccDrag.a;
        if (r < a * (1 - e)) a = r / (1 - e);         // at its closest point
        else if (r > a * (1 + e)) a = r / (1 + e);    // at its farthest point
        const vt = Math.sqrt(mu * a * (1 - e * e)) / r;
        const vr = eccDrag.out * Math.sqrt(Math.max(0, mu * (2 / r - 1 / a) - vt * vt));
        const tx = -s.uy * eccDrag.sense, ty = s.ux * eccDrag.sense;
        keepView(() => setRelative(b, s, s.rx, s.ry, vr * s.ux + vt * tx, vr * s.uy + vt * ty));
        resetTracking(b);
        resetTracking(p);
        k2.bid = null;
        computePrimaries();
        markPreview();
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
            const note = usable ? 'Reshapes the orbit through where it is now: 0 is a circle, near 1 a long thin ellipse.'
                : (b ? `${b.name} is the heaviest body here. Click or tap a body that orbits it.` : '');
            if (ui.eccNote.textContent !== note) ui.eccNote.textContent = note;
        }
        syncOrbitFacts(b, usable);
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
            const ch = (sh) => Math.round(((n >> sh) & 255) * f).toString(16).padStart(2, '0');
            s = `#${ch(16)}${ch(8)}${ch(0)}`;   // hex, so hexA() can fade it
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
        placeCloseUp();
        const subj = bodyById(selectedId);
        if (settings.k2) drawSectors(C, subj);
        drawTrails(C);
        drawFlybyGhost(C);
        if (settings.k1) drawEllipseLaw(C, subj);
        drawDragPreviews(C);
        drawEditPreview(C);
        drawBodies(C);
        if (settings.com) drawCentreOfMass(C);   // small: on top, so a star at the centre doesn't hide it
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
        const first = sampleAtTime(simTime - years);
        const L = frameId !== null ? bodyById(frameId) : null;
        // While the frame is frozen (a body is being dragged), the live origin has drifted from F
        const live = freeze ? liveFrameOrigin() : F;
        const offX = (live.x - F.x - view.panX) * scale + viewW / 2, offY = viewH / 2 - (live.y - F.y - view.panY) * scale;
        const lw = clamp(1.6 * sizeScale, 1.2, 2);
        const CHUNKS = 8;
        const oT = L ? L.trail : comTrail;
        for (const b of bodies) {
            if (b.held) continue;
            let k0 = Math.max(b.trailStart, first, sampleCount - TRAIL_CAP + 1);
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

    // During and after a flyby: the orbit round the star the body was on before it met the planet
    // (faint and dashed), to compare with where it actually goes.
    function drawFlybyGhost(C) {
        const b = bodyById(selectedId);
        if (!b || flyby.bid !== b.id || !flyby.el0) return;
        const s = bodyById(flyby.sid), q = bodyById(flyby.pid);
        if (!s || !q) return;
        const el = flyby.el0;
        const cx = sx(s.dx), cy = sy(s.dy);
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = C.dark ? b.color : bodyStroke(b.color, false);
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 5]);
        traceConic(cx, cy, el, 3 * Math.max(viewW, viewH) / scale);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        if (!el.bound || cleanRender) return;
        // Named at its far end, unless a body (and so its name) is there
        const ra = el.a * (1 + el.e) * scale;
        const ux = -Math.cos(el.w), uy = Math.sin(el.w);
        const at = { x: cx + ux * ra, y: cy + uy * ra };
        if (bodies.some((o) => Math.hypot(sx(o.dx) - at.x, sy(o.dy) - at.y) < 70)) return;
        if (closeUp && Math.hypot(at.x - closeUp.x, at.y - closeUp.y) < closeUp.R + 90) return;
        ctx.font = font(clamp(Math.min(viewW, viewH) / 48, 10, 12));
        ctx.fillStyle = C.subtle;
        ctx.textBaseline = 'middle';
        labelOutward(`orbit without ${q.name}`, at, ux, uy, 8);
    }

    // A soft glow around a body (light, not size)
    function glow(x, y, r0, r1, color, a) {
        const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
        g.addColorStop(0, hexA(color, a));
        g.addColorStop(1, hexA(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r1, 0, TAU);
        ctx.fill();
    }

    // A lit sphere: lighter towards the top left
    function disc(x, y, r, color, light, C) {
        const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
        g.addColorStop(0, mix(color, '#ffffff', light));
        g.addColorStop(1, color);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        if (!C.dark && r > 2) {
            ctx.strokeStyle = C.outline;
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    }

    // A black hole: a disc darker than space, edged by a thin bright photon ring and a faint glow of
    // bent light. Light from the side moving towards us is brighter, so the ring is lopsided.
    function drawBlackHole(x, y, r, b, C) {
        const ring = b.color;
        if (r > 1.5) glow(x, y, r * 0.95, r * 2.7, ring, C.dark ? 0.3 : 0.4);
        if (r < 2.5) {
            ctx.fillStyle = '#000000';
            ctx.beginPath();
            ctx.arc(x, y, Math.max(r, 1.2), 0, TAU);
            ctx.fill();
            return;
        }
        // Photon ring: brighter on the left, where the light comes towards us (on a light page, deeper
        // colours rather than white, which wouldn't show)
        const lw = clamp(r * 0.22, 1.5, 3.5);
        const g = ctx.createLinearGradient(x - r, y - r * 0.4, x + r, y + r * 0.4);
        g.addColorStop(0, C.dark ? mix(ring, '#ffffff', 0.75) : ring);
        g.addColorStop(0.45, C.dark ? ring : bodyStroke(ring, false));
        g.addColorStop(1, hexA(ring, 0.45));
        ctx.strokeStyle = g;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.arc(x, y, r - lw / 2, 0, TAU);
        ctx.stroke();
        // The shadow: darker than space
        ctx.fillStyle = '#000000';
        ctx.beginPath();
        ctx.arc(x, y, r - lw * 0.85, 0, TAU);
        ctx.fill();
    }

    function drawBody(b, x, y, r, C) {
        const look = lookOf(b);
        if (b.grp) {
            // A piece of a torn-apart body: a glowing clump
            glow(x, y, 0, Math.max(r * 2.4, 5), b.color, C.dark ? 0.55 : 0.6);
            disc(x, y, Math.max(r * 0.8, 0.9), b.color, 0.5, C);
            return;
        }
        if (look === 'blackhole') { drawBlackHole(x, y, r, b, C); return; }
        // White on a light background needs a deeper glow to show
        const halo = C.dark ? b.color : bodyStroke(b.color, false);
        if (look === 'neutron') {
            // A tiny, intensely hot star: a white spark in a blue-white glow
            glow(x, y, r * 0.5, Math.max(r * 3.4, 8), halo, C.dark ? 0.75 : 0.7);
            disc(x, y, Math.max(r, 0.9), '#e4f1ff', 0.8, C);
            return;
        }
        if (look === 'whitedwarf') {
            glow(x, y, r * 0.6, Math.max(r * 2.8, 7), halo, C.dark ? 0.5 : 0.6);
            disc(x, y, Math.max(r, 0.9), b.color, 0.6, C);
            return;
        }
        if (look === 'star') glow(x, y, r * 0.6, r * 2.6, b.color, C.dark ? 0.45 : 0.35);
        else if (look === 'browndwarf' && r > 2) glow(x, y, r * 0.8, r * 1.8, b.color, 0.2);   // a dull infrared glow
        disc(x, y, Math.max(r, 0.9), b.color, look === 'star' ? 0.55 : 0.35, C);
    }

    function drawBodies(C) {
        const real = settings.realistic && !cleanRender;
        for (const b of bodies) {
            const x = sx(b.dx), y = sy(b.dy);
            const r = drawRadius(b);
            if (x < -r - 60 || x > viewW + r + 60 || y < -r - 60 || y > viewH + r + 60) continue;
            if (settings.realistic) {
                // True size, so stars shine as small points of light; a ring marks anything too small to see
                const rd = b.rd;
                if (isStar(b) && rd < 4) glow(x, y, 0, 5, b.color, C.dark ? 0.6 : 0.5);
                drawBody(b, x, y, rd, C);
                if (rd < MARKER_R && real && !b.grp) {
                    ctx.strokeStyle = C.dark ? hexA(b.color, 0.6) : bodyStroke(b.color, false);
                    ctx.lineWidth = 1.2;
                    ctx.beginPath();
                    ctx.arc(x, y, MARKER_R, 0, TAU);
                    ctx.stroke();
                }
            } else {
                drawBody(b, x, y, r, C);
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
    // Each name goes on the side away from the pull (outwards from what it orbits, clear of the arrows
    // and trail) unless that would cover another name or body; then the next free side round. A name
    // with no free side is left out (the chosen body's never is). Pieces of a torn-apart body aren't
    // named unless chosen.
    function drawLabels(C) {
        if (!settings.labels) return;
        const fs = clamp(Math.min(viewW, viewH) / 42, 11, 13);
        ctx.font = font(fs);
        ctx.lineWidth = 3;
        ctx.strokeStyle = hexA(C.bg, 0.8);
        const placed = [];
        const discs = bodies.map((b) => ({ x: sx(b.dx), y: sy(b.dy), r: drawRadius(b), b }));
        // the flyby close-up and its caption
        if (closeUp) placed.push({ l: closeUp.x - closeUp.R, r: closeUp.x + closeUp.R, t: closeUp.y - closeUp.R - 18, b: closeUp.y + closeUp.R });
        const order = discs.slice().sort((p, q) => (q.b.id === selectedId) - (p.b.id === selectedId) || q.b.m - p.b.m);
        for (const { x, y, r, b } of order) {
            if (x < -60 || x > viewW + 60 || y < -60 || y > viewH + 60) continue;
            const chosen = b.id === selectedId || b === popBody;
            if (b.grp && !chosen) continue;
            const w = ctx.measureText(b.name).width;
            const gap = r + (chosen ? 9 : 5);
            const u0 = labelDirection(b), a0 = Math.atan2(u0.y, u0.x);
            let best = null;
            for (const da of [0, 0.9, -0.9, 1.8, -1.8, Math.PI]) {
                const ux = Math.cos(a0 + da), uy = Math.sin(a0 + da);
                const box = labelBox(x + ux * gap, y + uy * gap, ux, uy, w, fs);
                // (its own disc too: kept inside the canvas, a name can be pushed back onto it)
                const hit = placed.some((q) => box.l < q.r && box.r > q.l && box.t < q.b && box.b > q.t)
                    || discs.some((d) => { const rr = d.b === b ? d.r - 2 : d.r; return d.x + rr > box.l && d.x - rr < box.r && d.y + rr > box.t && d.y - rr < box.b; });
                if (!hit) { best = { box, ux, uy }; break; }
                if (!best && chosen) best = { box, ux, uy, forced: true };
            }
            if (!best) continue;
            placed.push(best.box);
            ctx.fillStyle = C.label;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.strokeText(b.name, best.box.l, best.box.t);
            ctx.fillText(b.name, best.box.l, best.box.t);
        }
        // Last, the centre of mass's own label, in the first free spot round its marker (if the
        // marker is on a star, over the star's glow rather than not at all)
        if (settings.com && bodies.length) {
            const c = drawnCentreOfMass();
            ctx.font = font(clamp(Math.min(viewW, viewH) / 46, 10, 12));
            const w = ctx.measureText('centre of mass').width, h = 12;
            const spots = [[11, -16], [11, 4], [-11 - w, -16], [-11 - w, 4], [-w / 2, -26], [-w / 2, 14]];
            let at = null;
            for (const strict of [true, false]) {
                for (const [dx, dy] of spots) {
                    const box = { l: c.x + dx, t: c.y + dy, r: c.x + dx + w, b: c.y + dy + h };
                    if (box.l < 4 || box.r > viewW - 4 || box.t < 4 || box.b > viewH - 4) continue;
                    if (placed.some((q) => box.l < q.r && box.r > q.l && box.t < q.b && box.b > q.t)) continue;
                    if (strict && discs.some((d) => d.x + d.r > box.l && d.x - d.r < box.r && d.y + d.r > box.t && d.y - d.r < box.b)) continue;
                    at = box;
                    break;
                }
                if (at) break;
            }
            if (at) {
                ctx.fillStyle = C.subtle;
                ctx.strokeText('centre of mass', at.l, at.t);
                ctx.fillText('centre of mass', at.l, at.t);
            }
        }
    }

    function drawnCentreOfMass() {
        let M = 0, X = 0, Y = 0;
        for (const b of bodies) { M += b.m; X += b.m * b.dx; Y += b.m * b.dy; }
        return M > 0 ? { x: sx(X / M), y: sy(Y / M) } : { x: viewW / 2, y: viewH / 2 };
    }

    // The box of a name anchored at (x, y) on the side (ux, uy) of its body, kept inside the canvas
    function labelBox(x, y, ux, uy, w, fs) {
        let l = ux > 0.38 ? x : ux < -0.38 ? x - w : x - w / 2;
        let t = uy > 0.38 ? y : uy < -0.38 ? y - fs : y - fs / 2;
        l = clamp(l, 4, Math.max(4, viewW - 4 - w));
        t = clamp(t, 2, viewH - fs - 4);
        return { l, t, r: l + w, b: t + fs };
    }

    // Bodies outside the view: a small pointer at the edge of the canvas, in their direction.
    function drawOffscreen(C) {
        const fs = clamp(Math.min(viewW, viewH) / 46, 10, 12);
        const cx = viewW / 2, cy = viewH / 2;
        const inset = 12;
        for (const b of bodies) {
            const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
            if (b.grp || (x > -r && x < viewW + r && y > -r && y < viewH + r)) continue;
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

    // Velocity arrows have a length in px that doesn't depend on the zoom, like the force arrows: the
    // same speed always looks the same, and it can be set as finely zoomed out (watching the whole
    // predicted orbit) as zoomed in. The scene's reference speed (its main body's circular speed) is
    // ARROW_PX long; arrows over three times that are squeezed.
    const ARROW_PX = 60;
    let vRef = TAU;   // AU/yr (Earth's orbital speed until a scene sets it)
    const arrowUnit = () => ARROW_PX * sizeScale;
    const pxPerSpeed = () => arrowUnit() / vRef;
    function arrowLength(v) {
        const L = v * pxPerSpeed(), L0 = arrowUnit();
        return L <= 3 * L0 ? L : 3 * L0 + L0 * (1 - Math.exp(-(L - 3 * L0) / L0));
    }

    // The tip of a body's velocity arrow (screen px; the arrow starts at the edge of its disc) and the
    // velocity it shows: relative to the view, or while it is being aimed, relative to the aim's
    // reference at the aim's own scale (k px per AU/yr, never squeezed).
    function velocityTip(b) {
        const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
        let vx, vy, L;
        if (b.aim) {
            vx = b.aim.vx; vy = b.aim.vy;
            L = Math.hypot(vx, vy) * b.aim.k;
        } else {
            const fv = frameVelocity();
            vx = b.vx - fv.x; vy = b.vy - fv.y;
            L = arrowLength(Math.hypot(vx, vy));
        }
        const v = Math.hypot(vx, vy);
        if (!(v > 0)) return { x, y, vx, vy, len: 0 };
        return { x: x + (vx / v) * (r + L), y: y - (vy / v) * (r + L), vx, vy, len: L };
    }
    // Where an arrow is grabbed: its tip, or a little way out from the disc if the arrow is too short
    // to grab (nothing is drawn there)
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
            // Hardly moving in this view: grab it at right angles to the name label
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
        // (a torn-apart body's pieces only get arrows when one is chosen)
        if (settings.forces) {
            for (const b of bodies) {
                const Fm = Math.hypot(b.fx, b.fy);
                if (!(Fm > 0) || (b.grp && b !== subj)) continue;
                const L = forceLength(Fm * 1);
                if (L < 3) continue;
                const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
                const ux = b.fx / Fm, uy = -b.fy / Fm;
                arrow(x + ux * r, y + uy * r, x + ux * (r + L), y + uy * (r + L), C.force, w);
            }
        }
        // Velocities only when they are switched on (or while one is being aimed): plain arrows, like
        // the forces. An arrow's tip is dragged to aim it (an invisible grab area round the tip); the
        // arrow under the pointer, or being aimed, is drawn thicker and brighter. A body hardly moving
        // has no arrow to grab, so hovering just off its disc shows a faint stub that can be pulled out.
        const hotColour = C.dark ? mix(C.velocity, '#ffffff', 0.35) : bodyStroke(C.velocity, false);
        for (const b of bodies) {
            if (!(settings.velocities || b.aim) || (b.held && !b.aim) || (b.grp && b !== subj)) continue;
            const tip = velocityTip(b);
            const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
            const dx = tip.x - x, dy = tip.y - y;
            const len = Math.hypot(dx, dy);
            const hot = !cleanRender && (!!b.aim || b.id === hoverAim);
            if (tip.len > 2.5) {
                arrow(x + (dx / len) * r, y + (dy / len) * r, tip.x, tip.y, hot ? hotColour : C.velocity, hot ? w * 1.5 : w);
            } else if (hot && !b.aim) {
                const h = handlePos(b), hl = Math.hypot(h.x - x, h.y - y) || 1;
                ctx.globalAlpha = 0.6;
                arrow(x + ((h.x - x) / hl) * r, y + ((h.y - y) / hl) * r, h.x, h.y, hotColour, w);
                ctx.globalAlpha = 1;
            }
        }
    }

    // The centre-of-mass marker (its label is placed with the bodies' names)
    function drawCentreOfMass(C) {
        if (!bodies.length) return;
        const { x, y } = drawnCentreOfMass();
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
        ctx.fillText(settings.realistic ? 'Sizes to scale' : 'Sizes not to scale', viewW - pad - 2, y0 + 2);

        drawFlybyCloseUp(C);

        // Pause / slow-down notice: top left, under the "Viewed from" chip if it is showing
        const t = timeNotice();
        if (t) {
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
        const fl = flybyLines(compact);
        if (fl) y = drawCard(C, fl, y, cfs) + 5;
        if (settings.k1) y = drawCard(C, kepler1Lines(subj, compact), y, cfs) + 5;
        if (settings.k2) y = drawCard(C, kepler2Lines(subj, compact), y, cfs) + 5;
        if (settings.k3) drawKepler3Card(C, subj, y, cfs, compact);
    }

    // The flyby card: the chosen body's speed relative to the star before and after it passed the
    // planet, and relative to the planet (the same both ways).
    function flybyLines(compact) {
        const b = bodyById(selectedId);
        if (!b || flyby.bid !== b.id || !(flyby.active || flyby.done)) return null;
        const q = bodyById(flyby.pid), s = bodyById(flyby.sid);
        if (!q || !s) return null;
        const C = colours();
        const kms = (v) => fmtSpeedKms(v * AUYR_KMS);
        const now = flyby.done ? flyby.vOut : flyby.vNow;
        const vIn = kms(flyby.vIn), vNow = kms(now);
        const title = !flyby.done ? `Passing ${q.name}…` : now >= flyby.vIn ? `Gravity assist from ${q.name}` : `Slowed down by ${q.name}`;
        const head = [[title, true, C.velocity]];
        const speeds = [`${vIn.v} → ${vNow.v} ${vNow.u}`, true];
        const lines = [head, [[`Speed relative to ${theName(s)}: `], speeds]];
        if (compact) return lines;
        // (to two figures: the star's pull across the planet's Hill sphere makes them differ a little)
        const rel = (v) => (v * AUYR_KMS).toPrecision(2);
        lines.push([[flyby.done ? `Relative to ${q.name}: ${rel(flyby.relIn)} km/s in, ${rel(flyby.relOut)} out` : `Relative to ${q.name}: ${rel(flyby.relIn)} km/s in`]]);
        return lines;
    }

    // A round close-up in the bottom-right corner: the flyby seen from the planet (drawn at its true
    // size there), so the hairpin turn that is far too small to see in the main view shows.
    // Where the flyby close-up goes this frame (worked out before the names, which keep clear of it):
    // the bottom-right corner, or the bottom-left or top-left one if fewer bodies are near it.
    let closeUp = null;
    function placeCloseUp() {
        closeUp = null;
        const b = bodyById(selectedId);
        if (cleanRender || !b || flyby.bid !== b.id || !(flyby.active || flyby.done) || flyby.pts.length < 4 || !bodyById(flyby.pid)) return;
        const R = clamp(Math.min(viewW, viewH) * 0.15, 44, 80);
        const top = (frameId !== null ? 48 : 8) + (timeNotice() ? 32 : 0) + 18 + R;
        const corners = [[viewW - 10 - R, viewH - 30 - R], [10 + R, viewH - 34 - R], [10 + R, top]];
        const crowd = (c) => bodies.reduce((n, o) => n + Math.max(0, R + 60 - Math.hypot(sx(o.dx) - c[0], sy(o.dy) - c[1])), 0);
        let best = corners[0], least = crowd(best);
        for (const c of corners.slice(1)) { const n = crowd(c); if (n < least - 1) { least = n; best = c; } }
        closeUp = { x: best[0], y: best[1], R };
    }

    function drawFlybyCloseUp(C) {
        if (!closeUp) return;
        const b = bodyById(selectedId), q = bodyById(flyby.pid);
        const { x: cx, y: cy, R } = closeUp;
        const k = R / (7 * flyby.rp);   // px per AU: the closest approach is a seventh of the way out
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, TAU);
        ctx.fillStyle = C.card;
        ctx.fill();
        ctx.strokeStyle = C.cardLine;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.clip();
        const qr = Math.max(2.5, (q.R / AU_KM) * k);
        // Which way the planet is going (relative to its star): the body swings round behind it to gain speed
        const s = bodyById(flyby.sid);
        if (s) {
            const vx = q.vx - s.vx, vy = q.vy - s.vy, v = Math.hypot(vx, vy);
            if (v > 0) arrow(cx + (vx / v) * (qr + 2), cy - (vy / v) * (qr + 2), cx + (vx / v) * (qr + 0.42 * R), cy - (vy / v) * (qr + 0.42 * R), hexA(q.color, 0.8), 1.6);
        }
        drawBody(q, cx, cy, qr, C);
        const P = flyby.pts;
        const col = C.dark ? b.color : bodyStroke(b.color, false);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        let ex = 0, ey = 0, px = 0, py = 0;
        for (let i = 0; i < P.length; i += 2) {
            const x = cx + P[i] * k, y = cy - P[i + 1] * k;
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
            // the last point still inside the close-up, and one a little before it (for the arrowhead)
            if (Math.hypot(x - cx, y - cy) < R - 8) {
                if (Math.hypot(x - ex, y - ey) > 6) { px = ex; py = ey; }
                ex = x; ey = y;
            }
        }
        const bx = cx + (b.x - q.x) * k, by = cy - (b.y - q.y) * k;
        if (flyby.active) ctx.lineTo(bx, by);
        ctx.stroke();
        if (flyby.active) {
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.arc(bx, by, 3, 0, TAU);
            ctx.fill();
        } else if (Math.hypot(ex - px, ey - py) > 2) {
            arrow(px, py, ex, ey, col, 1.6);
        }
        ctx.restore();
        ctx.font = font(clamp(Math.min(viewW, viewH) / 50, 10, 12));
        ctx.fillStyle = C.subtle;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`Seen from ${q.name}`, cx, cy - R - 4);
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
            if (c === P || c.primary !== P || !c.bound || c.grp) continue;
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
        // In the scene's own units: AU or km, and years, days or seconds
        const km = scene.units === 'km';
        const tu = timeUnit(), tf = tu === 's' ? YEAR_S : tu === 'd' ? DAYS_PER_YEAR : 1, af = km ? AU_KM : 1;
        const plain = !km && tu === 'yr';
        const title = compact || !P ? '3rd law' : `3rd law: orbits of ${P.name}`;
        const head = [compact ? '' : '', km ? 'a (km)' : 'a (AU)', `T (${tu === 'd' ? 'days' : tu})`, 'T²/a³'];
        const maxName = compact ? 8 : 11;
        const cells = rows.slice(0, compact ? 5 : 8).map((r) => {
            const nm = r.body.name.length > maxName ? `${r.body.name.slice(0, maxName - 1)}…` : r.body.name;
            if (!r.measured) return { name: nm, body: r.body, measuring: `measuring… ${Math.round(r.progress * 100)}%` };
            const Tv = r.T * tf;
            const a = km ? fmtKm(r.a * AU_KM) : r.a.toFixed(3);
            const T = plain ? r.T.toFixed(3) : Tv >= 100 ? Tv.toFixed(1) : Tv >= 1 ? Tv.toFixed(2) : Tv.toPrecision(3);
            const ratio = plain ? r.ratio.toFixed(3) : fmtSci((Tv * Tv) / Math.pow(r.a * af, 3), 2);
            return { name: nm, body: r.body, cols: [a, T, ratio] };
        });
        let note = '';
        if (!rows.length) note = compact ? 'Add orbiting bodies' : 'Add bodies that orbit it to compare.';
        else {
            const pred = (4 * Math.PI * Math.PI) / (G * (P.m + rows[0].body.m));
            const v = plain ? pred.toFixed(3) : fmtSci((pred * tf * tf) / (af * af * af), 2);
            note = compact ? `Newton: 4π²/GM = ${v}` : `Newton: 4π²/GM = ${v} ${tu === 'yr' ? 'yr' : tu}²/${km ? 'km' : 'AU'}³`;
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

    // ------------------------------------------------------------------
    // Predicted path while a body is moved or aimed. Not just the two-body ellipse: a copy of the whole
    // system is run forward (coarser steps, a fixed budget of force evaluations) until the body has gone
    // once round, left the view far behind or hit something, so Jupiter's pull on a probe, or the star's
    // on a moon, is included. The path is drawn relative to the body it orbits (or to the body the view
    // is locked on), which is how an orbit is usually pictured.
    // ------------------------------------------------------------------
    const PREDICT_ETA = 0.012;
    const PREDICT_PAIRS = 4e5;
    const pred = { key: '', t: 0, pts: null, end: null, refId: null };
    let predictDeadline = Infinity;   // performance.now() time a prediction stops at (end 'cut'): see previewPath

    // The velocities a circular launch of b around p would give them (see launchCircular)
    function circularLaunch(b, p, sense, inherit) {
        const save = { bx: b.vx, by: b.vy, px: p.vx, py: p.vy };
        launchCircular(b, p, sense, inherit);
        const out = { b: [b.vx, b.vy], p: [p.vx, p.vy] };
        b.vx = save.bx; b.vy = save.by; p.vx = save.px; p.vy = save.py;
        return out;
    }

    // The world velocity a dragged body will have when it is let go, and that of its primary.
    function releaseVelocity(b, d) {
        if (b.aim) {
            const base = aimBase(b);
            return { v: [base.x + b.aim.vx, base.y + b.aim.vy] };
        }
        if (settings.placement === 'circular') {
            const p = placementPrimary(b.x, b.y, b.m, b);
            if (p) {
                const c = circularLaunch(b, p, d && d.isNew ? orbitSense(p, b) : senseAround(b, p), isSatellite(p));
                return { v: c.b, p, pv: c.p };
            }
        }
        if (settings.placement === 'rest') { const fv = frameVelocity(); return { v: [fv.x, fv.y] }; }
        return { v: [b.vx, b.vy] };
    }

    function predictPath(b, d) {
        const rel = releaseVelocity(b, d);
        const p = placementPrimary(b.x, b.y, b.m, b);
        const L = frameId !== null && frameId !== b.id ? bodyById(frameId) : null;
        const ref = L || (p && p.m >= b.m ? p : null);
        // Worked out again when anything changes, but at most 20 times a second while the others move
        const key = [b.id, b.x, b.y, rel.v[0], rel.v[1], ref ? ref.id : 'c', settings.realistic, settings.merge, bodies.length].join('|');
        const now = performance.now();
        if (pred.pts && (key === pred.key || (!paused && now - pred.t < 50 && pred.key.split('|')[0] === String(b.id)))) return pred;
        pred.key = key; pred.t = now; pred.refId = ref ? ref.id : null;
        // The copy
        const list = bodies.map((q) => ({ x: q.x, y: q.y, vx: q.vx, vy: q.vy, m: q.m, R: q.R, grp: q.grp, ax: 0, ay: 0 }));
        const me = list[bodies.indexOf(b)];
        me.vx = rel.v[0]; me.vy = rel.v[1];
        if (rel.p) { const pc = list[bodies.indexOf(rel.p)]; pc.vx = rel.pv[0]; pc.vy = rel.pv[1]; }
        const rc = ref ? list[bodies.indexOf(ref)] : null;
        const origin = () => {
            if (rc) return [rc.x, rc.y];
            let M = 0, X = 0, Y = 0;
            for (const q of list) { M += q.m; X += q.m * q.x; Y += q.m * q.y; }
            return [X / M, Y / M];
        };
        // How long to look ahead: about one orbit if it is bound (two-body estimate), otherwise until it
        // is well out of view
        const pr = predictLaunch(b);
        const tMax = pr && pr.el.bound ? 1.6 * pr.el.T : 6 * scene.Tref;
        const rMax = 2.5 * Math.max(viewW, viewH) / scale;
        const pairs = Math.max(1, (list.length * (list.length - 1)) / 2);
        const budget = Math.min(20000, Math.floor(PREDICT_PAIRS / (3 * pairs)));
        const pts = [];
        let o = origin();
        let lx = me.x - o[0], ly = me.y - o[1];
        pts.push(lx, ly);
        let ang = Math.atan2(ly, lx), swept = 0, t = 0, end = null;
        let tmin = gravity(list);
        const px = 1.5 / scale;   // keep points about 1.5 px apart
        for (let k = 0; k < budget && t < tMax; k++) {
            if (predictDeadline < Infinity && (k & 7) === 7 && performance.now() > predictDeadline) { end = 'cut'; break; }
            const dt = PREDICT_ETA * Math.sqrt(tmin);
            const x0 = me.x, y0 = me.y;
            tmin = yoshida(list, dt, () => gravity(list));
            t += dt;
            // Hit something? (closest approach along the step, as in checkMerges)
            let hit = null;
            for (const q of list) {
                if (!settings.merge) break;
                if (q === me) continue;
                const reach = (q.R + me.R) / AU_KM;
                const ex = me.x - x0, ey = me.y - y0;
                const ee = ex * ex + ey * ey;
                const qx = q.x - x0, qy = q.y - y0;
                const s = ee > 0 ? clamp((qx * ex + qy * ey) / ee, 0, 1) : 1;
                if (Math.hypot(qx - s * ex, qy - s * ey) < reach) { hit = q; break; }
            }
            o = origin();
            const x = me.x - o[0], y = me.y - o[1];
            const a = Math.atan2(y, x);
            let da = a - ang;
            if (da > Math.PI) da -= TAU; else if (da < -Math.PI) da += TAU;
            swept += da; ang = a;
            if (hit) { pts.push(x, y); end = 'hit'; break; }
            if (Math.abs(x - lx) + Math.abs(y - ly) > px) { pts.push(x, y); lx = x; ly = y; }
            if (Math.abs(swept) > TAU * 1.02) { end = 'closed'; break; }
            if (Math.hypot(x, y) > rMax && !(pr && pr.el.bound)) { end = 'away'; break; }
        }
        pts.push(me.x - o[0], me.y - o[1]);
        pred.pts = pts;
        pred.end = end || 'open';
        return pred;
    }

    // While dragging: the path the body would follow if let go now.
    function drawDragPreviews(C) {
        for (const d of drags.values()) {
            const b = d.body;
            if (!b || (d.mode !== 'move' && d.mode !== 'aim')) continue;
            if (!settings.preview && d.mode === 'move') continue;
            if (bodies.length < 2) continue;
            drawPredictedPath(C, b, predictPath(b, d));
        }
    }

    // A predicted path { pts, end, refId } (points relative to the reference body, or the centre of
    // mass), dashed in the body's colour.
    function drawPredictedPath(C, b, pp) {
        const ref = pp.refId !== null ? bodyById(pp.refId) : null;
        const o = ref ? { x: ref.dx, y: ref.dy } : liveFrameOrigin();
        const pts = pp.pts;
        const col = C.dark ? hexA(b.color, 0.8) : bodyStroke(b.color, false);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = col;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        for (let i = 0; i < pts.length; i += 2) {
            const x = sx(o.x + pts[i]), y = sy(o.y + pts[i + 1]);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        // Where it ends: a cross if it hits something, an arrowhead if it is heading off
        const n = pts.length;
        if (n < 6) return;
        const ex = sx(o.x + pts[n - 2]), ey = sy(o.y + pts[n - 1]);
        if (pp.end === 'hit') {
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(ex - 5, ey - 5); ctx.lineTo(ex + 5, ey + 5);
            ctx.moveTo(ex - 5, ey + 5); ctx.lineTo(ex + 5, ey - 5);
            ctx.stroke();
        } else if (pp.end !== 'closed' && pp.end !== 'cut') {
            let j = n - 4;
            while (j > 0 && Math.hypot(sx(o.x + pts[j]) - ex, sy(o.y + pts[j + 1]) - ey) < 8) j -= 2;
            const bx = sx(o.x + pts[j]), by = sy(o.y + pts[j + 1]);
            const len = Math.hypot(ex - bx, ey - by);
            if (len > 1 && ex > 0 && ex < viewW && ey > 0 && ey < viewH) {
                const ux = (ex - bx) / len, uy = (ey - by) / len;
                ctx.fillStyle = col;
                ctx.beginPath();
                ctx.moveTo(ex + ux * 3, ey + uy * 3);
                ctx.lineTo(ex - ux * 6 - uy * 4, ey - uy * 6 + ux * 4);
                ctx.lineTo(ex - ux * 6 + uy * 4, ey - uy * 6 - ux * 4);
                ctx.closePath();
                ctx.fill();
            }
        }
    }

    // The two-body orbit a held or aimed body would have around its primary on release (for the hint
    // and the readouts): relative speed, and the circular and escape speeds sqrt(G(M + m)/r) and
    // sqrt(2G(M + m)/r) there.
    function predictLaunch(b) {
        const p = placementPrimary(b.x, b.y, b.m, b);
        if (!p) return null;
        const rx = b.x - p.x, ry = b.y - p.y;
        const r = Math.hypot(rx, ry);
        if (!(r > 0)) return null;
        const mu = G * (b.m + p.m);
        const vc = Math.sqrt(mu / r), ve = Math.SQRT2 * vc;
        const rel = releaseVelocity(b, null);
        const pv = rel.p === p ? rel.pv : [p.vx, p.vy];
        return { p, el: relElements(rx, ry, rel.v[0] - pv[0], rel.v[1] - pv[1], mu), vc, ve };
    }

    // A body being dragged from the palette, drawn where it would land.
    function drawPaletteGhost() {
        if (!paletteDrag || !paletteDrag.over) return;
        const k = KINDS[paletteDrag.kind] || KINDS.custom;
        const x = paletteDrag.cx, y = paletteDrag.cy;
        const r = Math.max(symbolicSize(paletteDrag.kind, k.m, k.R) * sizeScale, 4);
        ctx.globalAlpha = 0.85;
        drawBody({ kind: paletteDrag.kind, m: k.m, color: k.color }, x, y, r, colours());
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
        updateTimeControls();
        updateOrbitReadouts();
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
    // The chosen body's orbit in the info bar: its period and eccentricity, and tooltips that name
    // what the readouts are measured from.
    // ------------------------------------------------------------------
    Object.assign(ui, {
        statPeriod: byId('statPeriod'), statPeriodUnit: byId('statPeriodUnit'), statPeriodMark: byId('statPeriodMark'),
        statPeriodBox: byId('statPeriodBox'), statEcc: byId('statEcc')
    });
    const statBox = (el) => (el ? el.closest('.stats-box') : null);
    const setTitle = (el, t) => { if (el && el.title !== t) el.title = t; };

    // The period shown is the one measured over the body's last full orbit once it has gone round
    // (marked with a tick), and until then the period of the two-body orbit it is on now, worked out
    // from its speed and distance (Kepler's 3rd law). They agree for a lone planet; with other bodies
    // pulling, the measured one is the true time round. While a body is dragged or aimed it is the
    // orbit it would have if let go now. The heaviest body orbits nothing, unless it is one of a
    // binary pair: then both stars share the pair's period.
    function updateOrbitReadouts() {
        const b = bodyById(selectedId);
        let value = '–', unit = '', measured = false, ecc = '–';
        let tip = 'Time for one orbit', where = 'the body it orbits', pull = 'Gravitational pull of the body it orbits: F = Gm₁m₂/r²';
        if (b && bodies.length < 2) tip = 'On its own: it has nothing to orbit';
        else if (b) {
            const top = !b.primary || (b.primary.primary === b && b.m > b.primary.m);
            const pr = b.held && !top ? predictLaunch(b) : null;
            const p = pr ? pr.p : b.primary;
            where = top ? 'the centre of mass' : theName(p);
            pull = top ? 'Total gravitational pull of all the other bodies on it' : `Gravitational pull of ${theName(p)} on it: F = Gm₁m₂/r²`;
            const el = pr ? pr.el : p ? elementsOf(b, p) : null;
            const bound = el && el.bound && (pr || b.bound);
            if (el) ecc = el.e < 9.995 ? el.e.toFixed(2) : '>10';
            if (top && !p) {
                tip = 'The heaviest body orbits nothing: it only wobbles round the centre of mass';
            } else if (!bound) {
                value = 'escaping';
                tip = `Not bound to ${theName(p)}: it is going fast enough to escape, so it has no period`;
            } else {
                const live = fmtDuration(el.T, true);
                const tr = !pr && b.track;
                measured = !!(tr && tr.done > 0 && tr.pid === p.id);
                const shown = measured ? fmtDuration(tr.T, true) : live;
                const cut = shown.lastIndexOf(' ');
                value = shown.slice(0, cut); unit = shown.slice(cut + 1);
                const what = top ? `${b.name} and ${p.name} to go round each other` : `one orbit of ${theName(p)}`;
                if (pr) tip = `The period it would have round ${theName(p)} if you let go now`;
                else if (measured) tip = `Time for ${what}, measured over the last one (${tr.done} ${tr.done === 1 ? 'orbit' : 'orbits'} so far). From its present speed and distance: ${live}`;
                else tip = `Time for ${what}, worked out from its present speed and distance. Measured once it has gone round`;
                tip += `. Eccentricity ${el.e.toFixed(3)}`;
            }
        }
        setText(ui.statPeriod, value);
        setText(ui.statPeriodUnit, unit);
        if (ui.statPeriodMark && ui.statPeriodMark.hidden === measured) ui.statPeriodMark.hidden = !measured;
        setText(ui.statEcc, ecc);
        setTitle(ui.statPeriodBox, tip);
        setTitle(statBox(ui.statDist), `Distance from ${where}`);
        setTitle(statBox(ui.statSpeed), `Speed relative to ${where}`);
        setTitle(statBox(ui.statForce), pull);
    }

    // ------------------------------------------------------------------
    // Time controls. The speed slider steps through friendly speeds on a log scale, from a hundredth of
    // normal (to watch a close pass) to a hundred times (to see thousands of years of a three-star
    // dance), and a caption says what the speed means in the scene's own time. When the computer
    // can't keep up, the note on the canvas gives the speed actually reached. While paused, the step
    // button (or the "." key) moves on by a moment.
    // ------------------------------------------------------------------
    const SPEED_STOPS = [0.01, 0.02, 0.03, 0.05, 0.07, 0.1, 0.15, 0.2, 0.3, 0.5, 0.7, 1, 1.5, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100];
    const STEP_FRAME = 1 / 60;            // real seconds of motion per step: one 60 fps frame
    Object.assign(ui, { speedNote: byId('speedNote'), step: byId('stepBtn') });
    let speedFlash = 0;                   // until when (ms) the canvas shows the speed after a key changed it
    let captionKey = '';

    // A speed as shown: 0.01, 0.15, 1.5, 20, 100
    const fmtFactor = (v) => String(v >= 10 ? Math.round(v) : +v.toPrecision(2));
    // Two significant figures, with thousands separated: 0.05, 4.6, 17, 20,000
    const fig2 = (x) => (x >= 100 ? Math.round(+x.toPrecision(2)).toLocaleString('en-US') : String(+x.toPrecision(2)));

    // What a speed means in the scene's own time: "1 yr every 6 s", "4.6 days a second", "0.05 s a second"
    function speedCaption(speed) {
        const perSecond = speed * rate();   // simulated years per real second
        if (timeInSeconds()) {
            const s = perSecond * YEAR_S;
            return s >= 0.01 ? `${fig2(s)} s a second` : `${fig2(s * 1000)} ms a second`;
        }
        const days = timeUnit() === 'd';
        const v = perSecond * (days ? DAYS_PER_YEAR : 1);
        if (+v.toPrecision(2) >= 1) return `${fig2(v)} ${!days ? 'yr' : fig2(v) === '1' ? 'day' : 'days'} a second`;
        // Slower than one a second: how long one year (or day) takes to watch
        const wait = 1 / v;
        const every = wait < 99.5 ? `${fig2(wait)} s` : wait < 5400 ? `${fig2(wait / 60)} min` : `${fig2(wait / 3600)} hours`;
        return `1 ${days ? 'day' : 'yr'} every ${every}`;
    }

    // The slider stop nearest a speed (on the log scale)
    function nearestStop(v) {
        let best = 0;
        for (let i = 1; i < SPEED_STOPS.length; i++) {
            if (Math.abs(Math.log(SPEED_STOPS[i] / v)) < Math.abs(Math.log(SPEED_STOPS[best] / v))) best = i;
        }
        return best;
    }

    function showSpeed() {
        const t = fmtFactor(settings.speed);
        setText(ui.speedVal, t);
        if (ui.speed) ui.speed.setAttribute('aria-valuetext', `${t} times`);
        captionKey = '';
    }

    // Any speed (the slider shows the nearest stop)
    function setSpeedValue(v) {
        v = +v;
        if (!(v > 0) || !isFinite(v)) return;
        settings.speed = v;
        if (ui.speed) ui.speed.value = String(nearestStop(v));
        showSpeed();
    }

    // The next stop up (dir 1) or down (-1) from the present speed, which needn't be a stop
    function stepSpeed(dir) {
        const v = settings.speed;
        let next = null;
        for (const s of SPEED_STOPS) {
            if (dir > 0 && s > v * 1.0001) { next = s; break; }
            if (dir < 0 && s < v * 0.9999) next = s;
        }
        if (next === null) return;
        setSpeedValue(next);
        speedFlash = performance.now() + 1500;
    }

    // The speed actually reached, measured from outside the integrator: simulated time gained
    // (counting the time still owed to it) per real second, smoothed over about a third of a second,
    // as a fraction of the chosen speed. It falls short when a frame can't fit all the steps it needs.
    // Slow frames count too: a frame moves the simulation on by at most a tenth of a second, so the
    // real time is taken from the frames' timestamps, not from the time each frame was allowed.
    const pace = { t: 0, sim: 0, scene: null, ratio: 1, behind: false };
    function measurePace() {
        const now = lastFrameTs || performance.now();
        const sim = simTime + acc;
        const dReal = (now - pace.t) / 1000, dSim = sim - pace.sim;
        const want = settings.speed * rate() * dReal;
        // Start again after a pause, a new scene, a jump back in time or a long gap (a hidden tab)
        const fresh = paused || pace.scene !== scene || !(dReal > 0) || dReal > 1 || dSim < 0 || !(want > 0);
        pace.t = now; pace.sim = sim; pace.scene = scene;
        if (fresh) { pace.ratio = 1; pace.behind = false; return; }
        pace.ratio += (Math.min(dSim / want, 1.5) - pace.ratio) * (1 - Math.exp(-dReal / 0.35));
        pace.behind = pace.ratio < (pace.behind ? 0.95 : 0.9);
    }

    // The note in the canvas's top-left corner: paused, the new speed just after a key changed it, or
    // the speed actually reached when it falls short of the chosen one
    function timeNotice() {
        if (performance.now() < speedFlash) return `${paused ? 'Paused · ' : ''}${fmtFactor(settings.speed)}×: ${speedCaption(settings.speed)}`;
        if (paused) return 'Paused';
        if (pace.behind) return `Slowed down: running at ${fmtFactor(pace.ratio * settings.speed)}×`;
        return null;
    }

    // Every frame: the achieved speed, the caption (it changes with the scene) and the step button
    function updateTimeControls() {
        measurePace();
        const key = `${settings.scene}|${settings.speed}`;
        if (key !== captionKey) { captionKey = key; setText(ui.speedNote, speedCaption(settings.speed)); }
        if (ui.step && ui.step.disabled === paused) ui.step.disabled = !paused;
    }

    // One step while paused: a 60 fps frame's worth of time at the chosen speed, in whole integrator
    // steps (time short of a whole step is owed, as it is between frames). At least one step is taken,
    // so even at the slowest speeds every press moves things on: if the frame's worth isn't enough,
    // more time is added (doubling) until a step happens.
    function stepForward() {
        if (!paused) return false;
        const t0 = simTime;
        let dt = settings.speed * rate() * STEP_FRAME;
        computePrimaries();
        for (let i = 0; i < 60 && simTime === t0 && dt > 0; i++) {
            advance(dt);
            dt *= 2;
        }
        computePrimaries();
        updateDrawnPositions();
        return simTime > t0;
    }

    // [ and ] change the speed; "." steps (pausing first if it is running). Not while typing, nor with
    // Ctrl or Cmd (browser shortcuts). Alt is allowed: on many keyboards [ and ] are typed with AltGr
    // or Option (which on Windows also reports Ctrl).
    function bindTimeControls() {
        if (ui.step) {
            ui.step.addEventListener('click', (e) => {
                stepForward();
                // After a click or tap (not a key press), Space should play again rather than press
                // this button once more
                if (e.detail) ui.step.blur();
            });
        }
        window.addEventListener('keydown', (e) => {
            const altGr = !!(e.getModifierState && e.getModifierState('AltGraph'));
            if (e.defaultPrevented || e.metaKey || (e.ctrlKey && !altGr)) return;
            const t = e.target;
            const typing = t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
                (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color'].includes(t.type)));
            if (typing) return;
            if (e.key === '[' || e.key === ']') {
                stepSpeed(e.key === ']' ? 1 : -1);
                e.preventDefault();
            } else if (e.key === '.') {
                if (paused) stepForward(); else setPaused(true);
                e.preventDefault();
            }
        });
    }

    // ------------------------------------------------------------------
    // Popover (the body's menu): right-click or long-press a body
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
        // (on the side away from what it orbits if there is room, so its orbit and predicted path stay in view)
        const leftSide = x - r - 18 - pw;
        const awayIsLeft = orbitingBody(b) && sx(b.primary.dx) > x + r;
        if (leftSide > minX && (awayIsLeft || left + pw > Math.min(cr.width, maxX))) left = leftSide;
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
        // A black hole's size is its event horizon, fixed by its mass
        const hole = b.kind === 'blackhole';
        ui.popRadius.disabled = hole;
        setText(ui.popRadiusLabel, hole ? 'Event horizon' : 'Radius');
        setText(ui.popRadiusVal, `${fmtKm(b.R)} km`);
        // Speed relative to the primary, on a slider up to 1.6x the escape speed
        const sr = speedRelative(b);
        const v = Math.hypot(sr.vx, sr.vy);
        let note = '';
        if (sr.p) {
            const { vc, ve } = speedsAround(b, sr.p);
            if (!popSpeedMax || force && !recent) popSpeedMax = Math.max(1.6 * ve, 1.15 * v);
            const kms = (s) => fmtSpeedKms(s * AUYR_KMS);
            note = `Circular ${kms(vc).v} · escape ${kms(ve).v} ${kms(ve).u}, relative to ${theName(sr.p)}`;
        } else {
            // (the heaviest body barely moves: let its slider reach the scene's typical speed)
            if (!popSpeedMax) popSpeedMax = Math.max(1.15 * v, vRef);
            note = 'Relative to the centre of mass';
        }
        if (!recent) ui.popSpeed.value = String(Math.round(clamp(v / popSpeedMax, 0, 1) * 1000));
        // (the speed itself is in the typed field above the slider; as a fraction of c here, if it is that fast)
        const lf = lightFraction(v * AUYR_KMS);
        setText(ui.popSpeedNote, lf ? `${lf.slice(2, -1)} · ${note}` : note);
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
        // How hard it is to leave its surface: sqrt(2GM/R), the speed of light at a black hole's horizon
        if (hole) info += '<br><strong>Escape speed</strong> at the event horizon: the speed of light';
        else if (b.R > 0.1) {
            const vs = Math.sqrt((2 * G * b.m) / (b.R / AU_KM)) * AUYR_KMS;
            const f = fmtSpeedKms(vs);
            info += `<br><strong>Escape speed</strong> from its surface: ${f.v} ${f.u}${lightFraction(vs)}`;
        }
        if (ui.popInfo.innerHTML !== info) ui.popInfo.innerHTML = info;
        updateEditor(force);
    }

    // Circular and escape speeds of b relative to p where it is now: sqrt(G(M + m)/r) and sqrt(2) times that
    function speedsAround(b, p) {
        const r = Math.max(Math.hypot(b.x - p.x, b.y - p.y), 1e-15);
        const vc = Math.sqrt((G * (b.m + p.m)) / r);
        return { r, vc, ve: Math.SQRT2 * vc };
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
            keepView(() => { b.m = Math.pow(10, lg) * MEARTH; collapseIfTooHeavy(b); });
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
            let vNew = (parseFloat(ui.popSpeed.value) / 1000) * popSpeedMax;
            // Snap to the exact circular or escape speed within a step of the slider
            if (sr.p) {
                const { vc, ve } = speedsAround(b, sr.p);
                for (const s of [vc, ve]) if (Math.abs(vNew - s) < 0.006 * popSpeedMax) vNew = s;
            }
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
        bindEditor();
    }

    // ------------------------------------------------------------------
    // Trajectory editor: the menu's Velocity and Orbit tabs, the arrow keys, and the predicted path of
    // the body being edited.
    //   Velocities are relative to the body it orbits (the heaviest body's to the centre of mass). The
    //   direction is the angle away from sideways: 0 degrees is at right angles to the line to the body
    //   it orbits, as in a circular orbit; + leans outward, - inward. (The heaviest body orbits nothing,
    //   so its direction is simply measured anticlockwise from the right of the screen.)
    //   A new period scales the whole orbit about what it orbits: the same shape and direction, the body
    //   at the same point along it, and Kepler's 3rd law gives the new size. New closest or farthest
    //   distances keep the body where it is and change only its velocity, as a rocket burn would; if it
    //   is outside the new orbit, it moves along the line to what it orbits, onto the near or far end.
    //   Pushes (and the speed's steppers) add a step (10%, 1% or 0.1%) of its speed: along its motion,
    //   against it, or straight out or in.
    //   Every edit goes through keepView and keeps the pair's centre of mass and momentum, as the
    //   Circular button does (so a binary doesn't start to drift).
    // ------------------------------------------------------------------
    Object.assign(ui, {
        popTabs: ui.pop ? Array.from(ui.pop.querySelectorAll('[role="tab"]')) : [],
        popSpeedIn: byId('popSpeedIn'), popSpeedUnit: byId('popSpeedUnit'),
        popAngleIn: byId('popAngleIn'), popAngleNote: byId('popAngleNote'),
        popSenseSub: byId('popSenseSub'), popSenseAcw: byId('popSenseAcw'), popSenseCw: byId('popSenseCw'),
        popPeriodIn: byId('popPeriodIn'), popPeriodUnit: byId('popPeriodUnit'),
        popPeriIn: byId('popPeriIn'), popPeriUnit: byId('popPeriUnit'), popPeriName: byId('popPeriName'),
        popApoIn: byId('popApoIn'), popApoUnit: byId('popApoUnit'), popApoName: byId('popApoName'),
        popOrbitShape: byId('popOrbitShape'),
        popStep: ui.pop ? ui.pop.querySelector('.orb-pop-step') : null,
        subjectEdit: byId('statSubjectEdit'),
        orbitFacts: byId('orbitFacts'), editOrbit: byId('editOrbitBtn')
    });

    const edit = {
        tab: 'vel',          // the menu's open tab: vel, orbit or body
        step: 0.01,          // steppers and pushes: a fraction of the value (10%, 1% or 0.1%)
        sense: 1, senseBid: null,   // the way round chosen for a body at rest
        shown: {},           // field -> the text last written into it (a field is applied only if that changed)
        units: {},           // field -> the unit it is shown in, { label, f } (f: internal units per shown unit)
        forceField: null,    // a field to rewrite even though it has focus (just applied or stepped)
        usual: { bid: null, t: 0, sense: 0 },
        engaged: false,      // the arrow keys act on the chosen body (the simulation was last pressed or focused)
        downAt: new Map(),   // pointerId -> when it went down (for fine aiming on touch screens)
        previewUntil: 0,     // after a push from the keyboard with the menu closed, show the path until then
        preview: null,       // the path last worked out for the preview
        previewDirty: true,
        sum: 0, sumNext: 0,  // a checksum of the bodies (while paused: has anything else changed them?)
        menuShown: null,     // the Edit button's state last shown
        velEls: [], orbitEls: []   // the Velocity and Orbit tabs' controls (to disable)
    };
    const TAB_OF = { popTabVel: 'vel', popTabOrbit: 'orbit', popTabBody: 'body' };
    const DEG = Math.PI / 180;
    const SPEED_UNITS = { 'km/s': 1 / AUYR_KMS, kms: 1 / AUYR_KMS, 'm/s': 1 / (1000 * AUYR_KMS), 'au/yr': 1 };
    const DIST_UNITS = { au: 1, km: 1 / AU_KM, m: 1 / AU_M };
    const TIME_UNITS = {
        s: 1 / YEAR_S, min: 60 / YEAR_S, h: 3600 / YEAR_S, hr: 3600 / YEAR_S, hours: 3600 / YEAR_S,
        d: 1 / DAYS_PER_YEAR, day: 1 / DAYS_PER_YEAR, days: 1 / DAYS_PER_YEAR, yr: 1, y: 1, year: 1, years: 1
    };
    const ANGLE_UNITS = { '°': DEG, deg: DEG, degrees: DEG };

    // What b's velocity is measured from: the body it orbits, or for the heaviest body the centre of mass
    function relState(b) {
        const p = orbitingBody(b) ? b.primary : null;
        const o = p || totals(bodies);
        const rx = b.x - o.x, ry = b.y - o.y;
        return { p, rx, ry, vx: b.vx - o.vx, vy: b.vy - o.vy, r: Math.hypot(rx, ry) };
    }

    // Its speed, direction (radians) and way round (1 anticlockwise, -1 clockwise), with the unit vector
    // out from what it orbits (ux, uy) and the velocity's parts along it (vr) and sideways (vt)
    function velocityParts(b) {
        const s = relState(b);
        const v = Math.hypot(s.vx, s.vy);
        if (!s.p || !(s.r > 0)) return Object.assign(s, { v, screen: true, sense: 0, angle: v > 0 ? Math.atan2(s.vy, s.vx) : 0 });
        const ux = s.rx / s.r, uy = s.ry / s.r;
        const vr = s.vx * ux + s.vy * uy, vt = s.vy * ux - s.vx * uy;
        const sense = vt > 0 ? 1 : vt < 0 ? -1 : (edit.senseBid === b.id ? edit.sense : orbitSense(s.p, b));
        return Object.assign(s, { v, ux, uy, vr, vt, sense, screen: false, angle: v > 0 ? Math.atan2(vr, Math.abs(vt)) : 0 });
    }

    // Give b the velocity (ux, uy) relative to what it is measured from, and put it at (rx, ry) from it.
    // With a primary, the pair keeps its centre of mass and momentum (as in launchCircular). The heaviest
    // body is set so that its velocity relative to the new centre of mass is the one asked for.
    function setRelative(b, s, rx, ry, ux, uy) {
        const p = s.p;
        if (p) {
            const M = b.m + p.m;
            const cx = (b.m * b.x + p.m * p.x) / M, cy = (b.m * b.y + p.m * p.y) / M;
            const cvx = (b.m * b.vx + p.m * p.vx) / M, cvy = (b.m * b.vy + p.m * p.vy) / M;
            setPairRelative(b, p, rx, ry, ux, uy, cx, cy, cvx, cvy);
            return;
        }
        const c = totals(bodies);
        const f = c.M > 0 ? b.m / c.M : 1;
        if (f >= 1) return;    // on its own, it is the centre of mass
        b.vx = (ux + c.vx - f * b.vx) / (1 - f);
        b.vy = (uy + c.vy - f * b.vy) / (1 - f);
    }

    // Every edit: through keepView (the view stays put, and it can be undone), then the measurements
    // start again as after the other edits. A body that moved (a new period) starts a new trail.
    function applyEdit(b, fn) {
        const p = orbitingBody(b) ? b.primary : null;
        const x0 = b.x, y0 = b.y, r0 = p ? Math.hypot(b.x - p.x, b.y - p.y) : 1;
        keepView(fn);
        if (Math.hypot(b.x - x0, b.y - y0) > 1e-9 * r0) {
            clearTrail(b);
            if (p) clearTrail(p);
            if (frameId === b.id || (p && frameId === p.id)) clearAllTrails();
        }
        resetTracking(b);
        if (p) resetTracking(p);
        k2.bid = null;
        computePrimaries();
        syncEccentricity(true);
        markPreview();
        updatePopover(true);
    }

    // Speed (AU/yr), direction (radians) and way round, as in velocityParts
    function setVelocity(b, speed, angle, sense) {
        const s = velocityParts(b);
        if (!(speed >= 0) || !isFinite(angle) || bodies.length < 2) return;
        let ux, uy;
        if (s.screen) {
            ux = speed * Math.cos(angle); uy = speed * Math.sin(angle);
        } else {
            const tx = -s.uy * sense, ty = s.ux * sense;
            const c = Math.cos(angle), sn = Math.sin(angle);
            ux = speed * (c * tx + sn * s.ux); uy = speed * (c * ty + sn * s.uy);
            edit.sense = sense; edit.senseBid = b.id;
        }
        applyEdit(b, () => setRelative(b, s, s.rx, s.ry, ux, uy));
    }

    // A push (a rocket burn): a change of velocity of step x its speed (x the circular speed if it is
    // hardly moving): along its motion (faster), against it (slower: never so far that it turns round),
    // or straight out from or in towards what it orbits.
    function nudge(b, kind, step) {
        const s = velocityParts(b);
        if (bodies.length < 2 || !(step > 0)) return;
        const vc = s.p ? Math.sqrt((G * (b.m + s.p.m)) / Math.max(s.r, 1e-15)) : vRef;
        const moving = s.v > 1e-3 * vc;
        const dv = step * (moving ? s.v : vc);
        let ux = s.vx, uy = s.vy;
        if (kind === 'faster' || kind === 'slower') {
            let dx = 1, dy = 0;
            if (moving) { dx = s.vx / s.v; dy = s.vy / s.v; } else if (!s.screen) { dx = -s.uy * s.sense; dy = s.ux * s.sense; }
            const v = kind === 'faster' ? (moving ? s.v : 0) + dv : Math.max(0, s.v - dv);
            ux = dx * v; uy = dy * v;
        } else if (kind === 'out' || kind === 'in') {
            if (!(s.r > 0)) return;
            const k = (kind === 'out' ? dv : -dv) / s.r;
            ux += s.rx * k; uy += s.ry * k;
        } else return;
        applyEdit(b, () => setRelative(b, s, s.rx, s.ry, ux, uy));
    }

    // Its orbit around what it orbits: period, closest and farthest distances (Infinity if escaping)
    function orbitOf(b) {
        const s = relState(b);
        if (!s.p || !(s.r > 0)) return null;
        const el = relElements(s.rx, s.ry, s.vx, s.vy, G * (b.m + s.p.m));
        return { p: s.p, el, T: el.T, rp: el.p / (1 + el.e), ra: el.bound ? el.a * (1 + el.e) : Infinity };
    }

    // A new period: Kepler's 3rd law gives the size, a = (G(M + m) T^2 / 4 pi^2)^(1/3). A bound orbit is
    // scaled about what it orbits (distances x k, velocities / sqrt(k): the same shape, direction and
    // point along it). An escaping one can't be scaled into an orbit: it keeps its place and direction
    // and gets the speed for that size (vis-viva), or if even that can't reach, a circular orbit of
    // that size on the same line.
    function setPeriod(b, T) {
        const s = velocityParts(b);
        if (s.screen || !(T > 0)) return;
        const mu = G * (b.m + s.p.m);
        const el = relElements(s.rx, s.ry, s.vx, s.vy, mu);
        const a = Math.cbrt((mu * T * T) / (4 * Math.PI * Math.PI));
        let rx = s.rx, ry = s.ry, ux = s.vx, uy = s.vy;
        if (el.bound) {
            const k = a / el.a, q = 1 / Math.sqrt(k);
            rx *= k; ry *= k; ux *= q; uy *= q;
        } else if (a > 0.5 * s.r) {
            const f = Math.sqrt(mu * (2 / s.r - 1 / a)) / s.v;
            ux *= f; uy *= f;
        } else {
            const k = a / s.r, v = Math.sqrt(mu / a);
            rx *= k; ry *= k;
            ux = -s.uy * s.sense * v; uy = s.ux * s.sense * v;
        }
        applyEdit(b, () => setRelative(b, s, rx, ry, ux, uy));
    }

    // New closest and farthest distances (rp <= ra; ra = Infinity: an escaping orbit that keeps its
    // energy). The body stays where it is if the new orbit passes through its distance, still moving
    // outward or inward as it was; otherwise it moves along the line to what it orbits, onto the near or
    // far end. It keeps its way round.
    function setApsides(b, rp, ra) {
        const s = velocityParts(b);
        if (s.screen || !(rp > 0) || !(ra >= rp)) return;
        const mu = G * (b.m + s.p.m);
        let a, pl;   // semi-major axis and semi-latus rectum
        if (isFinite(ra)) {
            a = 0.5 * (rp + ra);
            pl = (2 * rp * ra) / (rp + ra);
        } else {
            const el = relElements(s.rx, s.ry, s.vx, s.vy, mu);
            if (el.bound) return;
            a = el.a;                    // negative (-Infinity for a parabola)
            pl = rp * (2 - rp / a);      // p = rp (1 + e), with e = 1 - rp / a
        }
        const r = Math.min(Math.max(s.r, rp), ra);
        const vt = Math.sqrt(mu * pl) / r;
        const vr = (s.vr < 0 ? -1 : 1) * Math.sqrt(Math.max(0, mu * (2 / r - 1 / a) - vt * vt));
        const k = r / s.r, tx = -s.uy * s.sense, ty = s.ux * s.sense;
        applyEdit(b, () => setRelative(b, s, s.rx * k, s.ry * k, vr * s.ux + vt * tx, vr * s.uy + vt * ty));
    }

    // The way the other bodies go round p (or p round its own primary): 1 anticlockwise, -1 clockwise,
    // 0 if there is nothing to compare with (worked out once a second for the menu)
    function usualSense(p, b) {
        const now = performance.now();
        const u = edit.usual;
        if (u.bid === b.id && u.pid === p.id && now - u.t < 1000) return u.sense;
        let L = 0;
        for (const c of bodies) {
            if (c === b || c === p || c.primary !== p) continue;
            L += c.m * ((c.x - p.x) * (c.vy - p.vy) - (c.y - p.y) * (c.vx - p.vx));
        }
        if (L === 0 && p.primary && p.primary !== b) {
            const q = p.primary;
            L = (p.x - q.x) * (p.vy - q.vy) - (p.y - q.y) * (p.vx - q.vx);
        }
        Object.assign(u, { bid: b.id, pid: p.id, t: now, sense: Math.sign(L) });
        return u.sense;
    }

    // ---- The fields ----
    // Units the fields are shown in: km/s (m/s if slow), AU (km in the km scenes, or if small), and
    // years, days or seconds as the scene counts time (days or seconds if short). Any of them can be typed.
    const speedUnit = (v) => (v * AUYR_KMS < 0.1 ? { label: 'm/s', f: SPEED_UNITS['m/s'] } : { label: 'km/s', f: SPEED_UNITS['km/s'] });
    const distUnit = (au) => (scene.units === 'km' || au < 0.01 ? { label: 'km', f: DIST_UNITS.km } : { label: 'AU', f: 1 });
    function periodUnit(yr) {
        if (timeInSeconds() || yr * YEAR_S < 600) return { label: 's', f: TIME_UNITS.s };
        if (timeUnit() === 'd' || yr < 0.1) return { label: 'days', f: TIME_UNITS.d };
        return { label: 'yr', f: 1 };
    }

    // Four significant figures (whole numbers with commas when large), easy to type over
    function fieldText(x) {
        const ax = Math.abs(x);
        if (ax === 0) return '0';
        if (ax >= 9999.5 && ax < 1e15) return Math.round(x).toLocaleString('en-US');
        if (ax < 1e-3 || ax >= 1e15) return x.toExponential(3);
        return x.toPrecision(4);
    }

    // A typed value with an optional unit ("2", "2 yr", "730 days", "1,000 m/s"), in internal units
    function parseField(text, units, unit) {
        const m = String(text).trim().replace(/[−–]/g, '-').replace(/,/g, '')
            .match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(.*)$/i);
        if (!m) return NaN;
        const u = m[2].toLowerCase().replace(/\s+/g, '');
        const f = u ? units[u] : unit && unit.f;
        return f === undefined ? NaN : parseFloat(m[1]) * f;
    }

    const FIELDS = {
        speed: {
            input: ui.popSpeedIn, unitEl: ui.popSpeedUnit, units: SPEED_UNITS, ok: (v) => v >= 0,
            apply: (b, v) => { const s = velocityParts(b); setVelocity(b, v, s.angle, s.sense); },
            step: (b, dir, k) => nudge(b, dir > 0 ? 'faster' : 'slower', k)
        },
        angle: {
            input: ui.popAngleIn, units: ANGLE_UNITS, ok: (v) => isFinite(v),
            apply: (b, v) => { const s = velocityParts(b); setVelocity(b, s.v, s.screen ? v : clamp(v, -Math.PI / 2, Math.PI / 2), s.sense); },
            // (10, 1 or 0.1 degrees)
            step: (b, dir, k) => FIELDS.angle.apply(b, velocityParts(b).angle + dir * k * 100 * DEG)
        },
        period: {
            input: ui.popPeriodIn, unitEl: ui.popPeriodUnit, units: TIME_UNITS, ok: (v) => v > 0,
            apply: (b, v) => setPeriod(b, v),
            step: (b, dir, k) => { const o = orbitOf(b); if (o && o.el.bound) setPeriod(b, o.T * (1 + dir * k)); }
        },
        peri: {
            input: ui.popPeriIn, unitEl: ui.popPeriUnit, units: DIST_UNITS, ok: (v) => v > 0,
            apply: (b, v) => { const o = orbitOf(b); if (o) setApsides(b, v, Math.max(v, o.ra)); },
            step: (b, dir, k) => { const o = orbitOf(b); if (o) FIELDS.peri.apply(b, o.rp * (1 + dir * k)); }
        },
        apo: {
            input: ui.popApoIn, unitEl: ui.popApoUnit, units: DIST_UNITS, ok: (v) => v > 0,
            apply: (b, v) => { const o = orbitOf(b); if (o) setApsides(b, Math.min(v, o.rp), v); },
            step: (b, dir, k) => { const o = orbitOf(b); if (o && isFinite(o.ra)) FIELDS.apo.apply(b, o.ra * (1 + dir * k)); }
        }
    };

    // Show a value in a field, unless it is being typed in
    function showField(name, value, unit) {
        const F = FIELDS[name], input = F.input;
        if (!input || (document.activeElement === input && edit.forceField !== name)) return;
        edit.units[name] = unit;
        if (F.unitEl) setText(F.unitEl, unit.label);
        let t = '';
        if (isFinite(value)) {
            t = name === 'angle' ? (value / unit.f).toFixed(1) : fieldText(value / unit.f);
            if (t === '-0.0') t = '0.0';
        }
        edit.shown[name] = t;
        if (input.value !== t) input.value = t;
    }

    // Apply what was typed in a field, if it changed. Something that can't be read is marked (and, when
    // the field is left, put back).
    function commitField(name, keepBad) {
        const F = FIELDS[name], input = F.input, b = popBody;
        if (!b || !input || input.value.trim() === (edit.shown[name] || '')) return;
        const v = parseField(input.value, F.units, edit.units[name]);
        if (!(isFinite(v) && F.ok(v))) {
            if (keepBad) { input.setAttribute('aria-invalid', 'true'); return; }
            input.value = edit.shown[name] || '';
            input.removeAttribute('aria-invalid');
            return;
        }
        input.removeAttribute('aria-invalid');
        edit.forceField = name;
        F.apply(b, v);
        updateEditor(true);
        edit.forceField = null;
    }

    // A stepper (or the up and down keys in a field)
    function stepField(name, dir, e) {
        if (!popBody) return;
        edit.forceField = name;
        FIELDS[name].step(popBody, dir, stepFor(e));
        updateEditor(true);
        edit.forceField = null;
    }

    // The step for a press: Shift ten times finer, Alt ten times coarser
    function stepFor(e) {
        return edit.step * (e && e.shiftKey ? 0.1 : 1) * (e && e.altKey ? 10 : 1);
    }

    function setStep(step) {
        if (!(step > 0)) return;
        edit.step = step;
        if (ui.pop) ui.pop.querySelectorAll('[data-step]').forEach((btn) => btn.setAttribute('aria-pressed', parseFloat(btn.dataset.step) === step ? 'true' : 'false'));
    }

    // The fields follow the body as it moves (from updatePopover, a few times a second)
    function updateEditor(force) {
        if (!popBody || !ui.pop || ui.pop.hidden || !ui.popSpeedIn) return;
        if (force) markPreview();
        const b = popBody;
        const alone = bodies.length < 2;
        const s = velocityParts(b);
        // Velocity
        const vc = s.p ? Math.sqrt((G * (b.m + s.p.m)) / Math.max(s.r, 1e-15)) : s.v;
        showField('speed', s.v, speedUnit(vc));
        showField('angle', s.angle, { label: '°', f: DEG });
        setText(ui.popAngleNote, s.screen ? 'Relative to the centre of mass: 0° points right, 90° up.'
            : '0° is sideways, as in a circle; + is outward, − inward.');
        ui.popSenseAcw.setAttribute('aria-pressed', !s.screen && s.sense > 0 ? 'true' : 'false');
        ui.popSenseCw.setAttribute('aria-pressed', !s.screen && s.sense < 0 ? 'true' : 'false');
        const usual = s.screen ? 0 : usualSense(s.p, b);
        setText(ui.popSenseSub, usual ? (usual === s.sense ? 'prograde' : 'retrograde') : '');
        ui.popSenseSub.title = usual ? `Prograde: the same way round as the others go round ${theName(s.p)}` : '';
        for (const el of edit.velEls) el.disabled = alone || (s.screen && (el === ui.popSenseAcw || el === ui.popSenseCw));
        // Orbit
        const o = orbitOf(b);
        const names = apsisNames(o ? o.p : null);
        setText(ui.popPeriName, names[0]);
        setText(ui.popApoName, names[1]);
        let shape;
        if (o) {
            const du = distUnit(o.el.bound ? o.el.a : o.rp);
            showField('period', o.T, periodUnit(o.el.bound ? o.T : 1));
            showField('peri', o.rp, du);
            showField('apo', o.ra, du);
            ui.popPeriodIn.placeholder = 'escaping';
            ui.popApoIn.placeholder = 'never';
            const d = fmtDistance(o.el.a);
            const e = o.el.e;
            shape = o.el.bound ? `Average distance a = ${d.v} ${d.u}, e = ${e.toFixed(3)}: ${e < 0.005 ? 'a circle' : e < 0.995 ? 'an ellipse' : 'a very thin ellipse'}.`
                : `Escaping (e = ${e.toFixed(2)}). Set a farthest distance to make it orbit.`;
        } else {
            showField('period', NaN, periodUnit(scene.Tref));
            for (const n of ['peri', 'apo']) showField(n, NaN, distUnit(scene.units === 'km' ? 0 : 1));
            ui.popPeriodIn.placeholder = ui.popApoIn.placeholder = '';
            // (the heavier of a pair that orbit each other: their orbit is set from the lighter one)
            const partner = b.primary && b.primary.primary === b ? b.primary : null;
            shape = alone ? 'It is on its own: there is nothing to orbit.'
                : partner ? `${b.name} and ${partner.name} orbit each other: set their orbit from ${partner.name}'s menu.`
                    : `${b.name} is the heaviest body here: it doesn't orbit another. Choose one that orbits it.`;
        }
        setText(ui.popOrbitShape, shape);
        // (an escaping orbit's period and farthest distance can be typed, not stepped)
        for (const el of edit.orbitEls) el.disabled = !o || (!o.el.bound && el.tagName === 'BUTTON' && el.dataset.dir !== undefined && !el.closest('[data-field="peri"]'));
    }

    function selectTab(name, focus) {
        edit.tab = name;
        for (const t of ui.popTabs) {
            const on = TAB_OF[t.id] === name;
            t.setAttribute('aria-selected', on ? 'true' : 'false');
            t.tabIndex = on ? 0 : -1;
            const panel = byId(t.getAttribute('aria-controls'));
            if (panel) panel.hidden = !on;
            if (on && focus) t.focus();
        }
        // (the steps don't apply to the Body tab)
        if (ui.popStep) ui.popStep.classList.toggle('is-idle', name === 'body');
    }

    function openEditor(b, tab, focus) {
        if (!b) return;
        if (tab) selectTab(tab);
        openPopover(b);
        if (focus) {
            const t = ui.popTabs.find((q) => q.getAttribute('aria-selected') === 'true');
            if (t) t.focus({ preventScroll: true });
        }
    }

    // The sidebar's "Orbit of ..." group: its period and closest and farthest distances
    function syncOrbitFacts(b, usable) {
        if (ui.editOrbit) ui.editOrbit.disabled = !usable;
        if (!ui.orbitFacts) return;
        let t = '';
        const o = usable ? orbitOf(b) : null;
        if (o) {
            const names = apsisNames(o.p);
            const d = (x) => { const f = fmtDistance(x); return `${f.v} ${f.u}`; };
            t = o.el.bound ? `Period ${fmtDuration(o.T, true)}; ${names[0]} ${d(o.rp)}, ${names[1]} ${d(o.ra)}.`
                : `Escaping; ${names[0]} ${d(o.rp)}.`;
        }
        setText(ui.orbitFacts, t);
    }

    // A button that acts once when pressed and, held down, again and again (steppers and pushes)
    function holdRepeat(btn, fn) {
        let timer = 0, viaPointer = false;
        const stop = () => { clearTimeout(timer); timer = 0; };
        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || btn.disabled) return;
            viaPointer = true;
            const mods = { shiftKey: e.shiftKey, altKey: e.altKey };
            fn(mods);
            const again = (delay) => { timer = setTimeout(() => { if (!btn.disabled && popBody) { fn(mods); again(70); } }, delay); };
            stop();
            again(450);
        });
        ['pointerup', 'pointercancel'].forEach((t) => btn.addEventListener(t, () => { stop(); setTimeout(() => { viaPointer = false; }, 0); }));
        ['pointerleave', 'blur'].forEach((t) => btn.addEventListener(t, stop));
        btn.addEventListener('contextmenu', (e) => e.preventDefault());
        // Keyboard (Enter or Space): once
        btn.addEventListener('click', (e) => { if (viaPointer) { viaPointer = false; return; } fn(e); });
    }

    // ---- Arrow keys: push the chosen body ----
    // up faster, down slower, right outward, left inward (Shift finer, Alt coarser). Only while the
    // simulation was the last thing pressed or focused (or it is fullscreen, or the menu is open), so
    // the arrow keys still scroll the page; never while typing, in a list, slider, tab or colour choice.
    const ARROW_PUSH = { ArrowUp: 'faster', ArrowDown: 'slower', ArrowRight: 'out', ArrowLeft: 'in' };

    function takesArrows(t) {
        if (!t || !t.tagName) return false;
        if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
        if (t.tagName === 'INPUT' && !['button', 'checkbox', 'submit', 'reset'].includes(t.type)) return true;
        return !!(t.closest && t.closest('[role="tablist"], [role="radiogroup"]'));
    }

    function onEditorKey(e) {
        const t = e.target;
        if (e.key === 'Escape') {
            // In a field with something typed: put it back (a second Escape closes the menu)
            const name = t && t.classList && t.classList.contains('orb-spin-input') ? Object.keys(FIELDS).find((n) => FIELDS[n].input === t) : null;
            if (name && t.value.trim() !== (edit.shown[name] || '')) {
                t.value = edit.shown[name] || '';
                t.removeAttribute('aria-invalid');
                e.stopImmediatePropagation();
                e.preventDefault();
            }
            return;
        }
        const kind = ARROW_PUSH[e.key];
        if (!kind || e.ctrlKey || e.metaKey || takesArrows(t)) return;
        if (!popBody && !edit.engaged && !document.body.classList.contains('sim-fullscreen-active')) return;
        const b = popBody || (selectedId !== null ? bodyById(selectedId) : null);
        if (!b || b.held || bodies.length < 2) return;
        e.preventDefault();
        nudge(b, kind, stepFor(e));
        if (!popBody) edit.previewUntil = performance.now() + 2000;
    }

    // ---- Fine aiming on a touch screen (there is no Shift key) ----
    // Hold the arrow's tip still for half a second before dragging it (a ring shows), and for the rest of
    // that drag it moves a tenth as far as the finger. Decided when the finger first moves.
    const FINE_HOLD_MS = 500;
    function aimFineReady(d) {
        const t0 = edit.downAt.get(d.id);
        return t0 !== undefined && performance.now() - t0 >= FINE_HOLD_MS;
    }
    function aimFine(d) {
        if (d.type === 'mouse') return false;
        if (d.fineTouch === undefined) d.fineTouch = aimFineReady(d);
        return d.fineTouch;
    }
    // Fine now, or will be when it moves (for the hint and the ring)
    function aimFineTouch(d) {
        if (d.type === 'mouse' || d.mode !== 'aim') return false;
        return d.fineTouch !== undefined ? d.fineTouch : !d.moved && aimFineReady(d);
    }

    // ---- Live preview ----
    // The predicted path (predictPath's, drawn as while aiming) of the body in the menu, of the chosen
    // body for two seconds after a push from the keyboard, and of the chosen body while paused (if
    // predicted paths are on). While paused it is worked out only when something has changed (in full:
    // predictPath's own budget bounds it). While running it is worked out ten times a second at most,
    // and each time stops after 3 ms, so it may cover only the next part of the orbit; it costs well
    // under a millisecond a frame on average.
    const PREVIEW_MS = 3;
    const PREVIEW_EVERY_MS = 100;
    function markPreview() { edit.previewDirty = true; }

    function previewBody() {
        if (bodies.length < 2 || cleanRender) return null;
        for (const d of drags.values()) if (d.body && (d.mode === 'move' || d.mode === 'aim')) return null;   // its own preview shows
        if (popBody) return popBody.held ? null : popBody;
        const b = selectedId !== null && (paused && settings.preview || performance.now() < edit.previewUntil) ? bodyById(selectedId) : null;
        return b && !b.held ? b : null;
    }

    // A checksum of the bodies (a few multiply-adds each, at most four times a second while paused):
    // has something else (another body moved, a mass changed, an undo) changed them?
    function bodiesSum() {
        let s = bodies.length;
        for (const q of bodies) s = s * 1.000001 + q.m * 7 + q.x * 3 + q.y * 5 + q.vx * 11 + q.vy * 13;
        return s;
    }

    function previewPath(b) {
        const now = performance.now();
        if (paused && now >= edit.sumNext) {
            edit.sumNext = now + 250;
            const s = bodiesSum();
            if (s !== edit.sum) { edit.sum = s; edit.previewDirty = true; }
        }
        const P = edit.preview;
        if (P && P.bid === b.id && (paused ? P.paused && !edit.previewDirty : now - P.t < PREVIEW_EVERY_MS)) return P;
        // The body's own velocity, given to predictPath as an aim (which it reads) for this call only
        const fv = frameVelocity();
        b.aim = { vx: b.vx - fv.x, vy: b.vy - fv.y, k: 1, ref: null, frameV: fv, snap: null };
        if (edit.previewDirty || !P || P.bid !== b.id) pred.key = '';
        predictDeadline = paused ? Infinity : now + PREVIEW_MS;
        let pp;
        try { pp = predictPath(b, null); } finally { b.aim = null; predictDeadline = Infinity; }
        // (a path cut short must not be taken for a whole one by a drag's preview)
        if (pp.end === 'cut') pred.key = '';
        edit.preview = { bid: b.id, pts: pp.pts, end: pp.end, refId: pp.refId, t: now, cost: performance.now() - now, paused };
        edit.previewDirty = false;
        return edit.preview;
    }

    function drawEditPreview(C) {
        syncEditButton();
        if (cleanRender) return;
        // The ring round an arrow's tip that is ready for fine aiming
        for (const d of drags.values()) {
            if (!d.body || !d.body.aim || !aimFineTouch(d)) continue;
            const h = handlePos(d.body);
            ctx.strokeStyle = C.velocity;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(h.x, h.y, 16, 0, TAU);
            ctx.stroke();
            if (!d.fineHinted) { d.fineHinted = true; dragHint(d); }
        }
        const b = previewBody();
        if (b) drawPredictedPath(C, b, previewPath(b));
    }

    // The stats bar's Edit button: pressed while the menu is open
    function syncEditButton() {
        const btn = ui.subjectEdit;
        if (!btn) return;
        const state = `${!!popBody}|${selectedId !== null}`;
        if (state === edit.menuShown) return;
        edit.menuShown = state;
        btn.setAttribute('aria-expanded', popBody ? 'true' : 'false');
        btn.disabled = selectedId === null;
    }

    function bindEditor() {
        if (!ui.popSpeedIn) return;
        edit.velEls = Array.from(ui.pop.querySelectorAll('#popPanelVel input, #popPanelVel button'));
        edit.orbitEls = Array.from(ui.pop.querySelectorAll('#popPanelOrbit input, #popPanelOrbit button'));
        // Tabs: click, or the arrow keys, Home and End along them
        ui.popTabs.forEach((t) => t.addEventListener('click', () => selectTab(TAB_OF[t.id])));
        const list = ui.popTabs.length ? ui.popTabs[0].parentElement : null;
        if (list) {
            list.addEventListener('keydown', (e) => {
                const i = ui.popTabs.indexOf(document.activeElement), n = ui.popTabs.length;
                if (i < 0) return;
                const j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
                if (j < 0) return;
                e.preventDefault();
                selectTab(TAB_OF[ui.popTabs[j].id], true);
            });
        }
        // Typed fields: Enter or leaving the field applies; up and down step it
        for (const name of Object.keys(FIELDS)) {
            const input = FIELDS[name].input;
            if (!input) continue;
            input.addEventListener('blur', () => commitField(name, false));
            input.addEventListener('focus', () => input.select());
            input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    commitField(name, true);
                    if (coarse()) input.blur(); else input.select();
                } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    commitField(name, true);
                    stepField(name, e.key === 'ArrowUp' ? 1 : -1, e);
                }
            });
        }
        ui.pop.querySelectorAll('.orb-spin').forEach((spin) => {
            const name = spin.dataset.field;
            spin.querySelectorAll('.orb-spin-btn').forEach((btn) => {
                const dir = parseFloat(btn.dataset.dir);
                holdRepeat(btn, (e) => { commitField(name, false); stepField(name, dir, e); });
            });
        });
        // Way round
        [ui.popSenseAcw, ui.popSenseCw].forEach((btn) => btn.addEventListener('click', () => {
            const b = popBody;
            if (!b) return;
            const s = velocityParts(b), sense = parseInt(btn.dataset.sense, 10);
            if (s.screen) return;
            if (s.v > 0 && sense !== s.sense) setVelocity(b, s.v, s.angle, sense);
            edit.sense = sense; edit.senseBid = b.id;
            updateEditor(true);
        }));
        ui.pop.querySelectorAll('[data-push]').forEach((btn) => holdRepeat(btn, (e) => { if (popBody) nudge(popBody, btn.dataset.push, stepFor(e)); }));
        ui.pop.querySelectorAll('[data-step]').forEach((btn) => btn.addEventListener('click', () => setStep(parseFloat(btn.dataset.step))));
        // The stats bar's Edit button opens (or closes) the menu of the chosen body
        if (ui.subjectEdit) {
            ui.subjectEdit.addEventListener('click', () => {
                const b = selectedId !== null ? bodyById(selectedId) : null;
                if (popBody && popBody === b) closePopover();
                else openEditor(b, null, true);
                syncEditButton();
            });
        }
        // The sidebar's button: the Orbit tab (on a phone, the settings sheet closes first)
        if (ui.editOrbit) {
            ui.editOrbit.addEventListener('click', () => {
                const b = selectedId !== null ? bodyById(selectedId) : null;
                const panel = byId('simulationControlsPanel'), toggle = document.querySelector('.sim-panel-toggle-button');
                if (panel && toggle && panel.classList.contains('panel-open') && document.body.classList.contains('sim-panel-sheet')) toggle.click();
                openEditor(b, 'orbit', true);
            });
        }
        // Keys (before the page's own Escape handler, so Escape in a field only puts it back)
        window.addEventListener('keydown', onEditorKey, true);
        const inSim = (el) => !!(el && el.closest && el.closest('.simulation-display-container'));
        window.addEventListener('pointerdown', (e) => {
            edit.engaged = inSim(e.target);
            edit.downAt.set(e.pointerId, performance.now());
        }, true);
        ['pointerup', 'pointercancel'].forEach((t) => window.addEventListener(t, (e) => edit.downAt.delete(e.pointerId), true));
        document.addEventListener('focusin', (e) => { if (e.target !== document.body) edit.engaged = inSim(e.target); });
        selectTab(edit.tab);
        setStep(edit.step);
    }

    // ------------------------------------------------------------------
    // Palette (drag a body onto the canvas, or tap to add it at a free spot)
    // ------------------------------------------------------------------
    let paletteDrag = null;
    let ghostEl = null;

    // The chips come in groups (stars, dead stars, planets, small bodies): headed groups in the column
    // beside the canvas, one flowing set of chips under it on narrow screens.
    function buildPalette() {
        if (!ui.palette) return;
        ui.palette.textContent = '';
        for (const group of PALETTE) {
            const box = document.createElement('div');
            box.className = 'orb-group';
            box.setAttribute('role', 'group');
            const head = document.createElement('p');
            head.className = 'orb-group-label';
            head.id = `orbGroup${group.label.replace(/\W/g, '')}`;
            head.textContent = group.label;
            box.setAttribute('aria-labelledby', head.id);
            const chips = document.createElement('div');
            chips.className = 'orb-group-chips';
            for (const kind of group.kinds) chips.appendChild(paletteChip(kind));
            box.append(head, chips);
            ui.palette.appendChild(box);
        }
    }

    function paletteChip(kind) {
        const k = KINDS[kind];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'orb-chip';
        btn.dataset.kind = kind;
        const label = kind === 'custom' ? 'Custom' : k.name;
        btn.dataset.title = kind === 'custom' ? 'Your own body: drag it into space, then set its mass, speed and colour'
            : `${k.name}, ${k.info} (${fmtMass(k.m)}). Drag it into space, or click to add it.`;
        btn.title = btn.dataset.title;
        const common = k.name.toLowerCase();
        const proper = ['sun', 'earth', 'jupiter', 'mars', 'moon'].includes(kind);
        btn.setAttribute('aria-label', kind === 'custom' ? 'Add a custom body' : proper ? `Add ${k.name}` : `Add ${/^[aeiou]/.test(common) ? 'an' : 'a'} ${common}`);
        const disc = document.createElement('span');
        disc.className = 'orb-chip-disc' + (kind === 'custom' ? ' is-custom' : '');
        const d = kind === 'custom' ? 18 : Math.round(clamp(6 + symbolicSize(kind, k.m, k.R) * 0.6, 9, 22));
        disc.style.width = `${d}px`;
        disc.style.height = `${d}px`;
        if (kind === 'blackhole') {
            disc.classList.add('is-hole');
            disc.style.background = `radial-gradient(circle, #000 0 54%, #fff3e2 60%, ${k.color} 66%, ${hexA(k.color, 0)} 74%)`;
            disc.style.boxShadow = `0 0 7px ${hexA(k.color, 0.55)}`;
        } else if (kind !== 'custom') {
            disc.style.background = `radial-gradient(circle at 35% 35%, ${mix(k.color, '#ffffff', 0.4)}, ${k.color})`;
            if (k.m >= STAR_MASS || COMPACT[kind]) disc.style.boxShadow = `0 0 ${kind === 'neutron' ? 9 : 8}px ${hexA(k.color, kind === 'neutron' ? 0.9 : 0.55)}`;
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
        return btn;
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
            const v = settings.velocities;
            if (kind === 'drop') h = '<strong>Drop it in space</strong> to add it.';
            else if (coarse()) {
                h = v ? '<strong>Drag</strong> a body into space. Tap a body, then drag its <strong>arrow tip</strong>, or tap <strong>Edit</strong> to set its orbit.'
                    : '<strong>Drag</strong> a body into space or around it. Tap a body, then <strong>Edit</strong> to set its speed and orbit.';
            } else {
                h = v ? '<strong>Drag</strong> bodies into space or around it. Drag an <strong>arrow tip</strong> to aim. <strong>Right-click</strong> a body (or <strong>Edit</strong>) to set its orbit; <strong>arrow keys</strong> push it.'
                    : '<strong>Drag</strong> bodies into space or around it. <strong>Right-click</strong> a body (or <strong>Edit</strong>) to set its speed and orbit; <strong>arrow keys</strong> push it.';
            }
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
        } else if (pr && pr.p.m < b.m) {
            // The heaviest body orbits nothing: just its speed in this view
            const L = frameId !== null && frameId !== b.id ? bodyById(frameId) : null;
            const base = aimBase(b), v = fmtSpeedKms(Math.hypot(b.aim.vx + base.x - (L ? L.vx : totals(bodies).vx), b.aim.vy + base.y - (L ? L.vy : totals(bodies).vy)) * AUYR_KMS);
            setHint(null, `<strong>${v.v} ${v.u}</strong> relative to ${L ? escapeHtml(theName(L)) : 'the centre of mass'}. The others pull it round as it goes.`);
        } else if (pr) {
            const kms = (v) => fmtSpeedKms(v * AUYR_KMS);
            const v = kms(pr.el.v), snap = b.aim && b.aim.snap;
            const fate = snap === 'circular' ? 'exactly the circular speed, a circle'
                : snap === 'escape' ? 'exactly the escape speed, so it just escapes (a parabola)'
                    : pr.el.bound ? (pr.el.e < 0.01 ? 'a circle' : `an ellipse, e = ${pr.el.e.toFixed(2)}`) : `it escapes (e = ${pr.el.e.toFixed(2)})`;
            let h = `<strong>${v.v} ${v.u}</strong> relative to ${escapeHtml(theName(pr.p))}: ${fate}.`;
            // (on a touch screen, fine control comes from holding the tip still before dragging it)
            const fineTouch = coarse() && aimFineTouch(d);
            if (!snap && !fineTouch) h += ` Circular ${kms(pr.vc).v}, escape ${kms(pr.ve).v} ${kms(pr.ve).u}.`;
            if (!coarse()) h += d.fine ? ' <strong>Fine control</strong> while Shift is held.' : ' Hold <strong>Shift</strong> for fine control.';
            else if (fineTouch) h += ' <strong>Fine control</strong>: it moves a tenth as far as your finger.';
            setHint(null, h);
        }
    }

    // ------------------------------------------------------------------
    // Canvas input: mouse, pen and touch through pointer events
    //   body: drag = move (held in place while dragged); right-click or long-press = its menu;
    //   double-click / double-tap = view from it (again: back to the centre of mass)
    //   velocity arrow's tip (grabbed within a few px of it): drag = aim it (Shift, or on a touch screen
    //   holding the tip still for half a second first: ten times finer; it snaps to the exact circular
    //   and escape speeds)
    //   empty space: drag = pan; two fingers = pinch zoom and pan; wheel = zoom
    //   tap/click = choose the body the readouts and Kepler's laws are about
    // ------------------------------------------------------------------
    const drags = new Map();   // pointerId -> drag state
    let pinch = null;
    let lastTap = { t: 0, x: 0, y: 0, id: null };
    let longPressTimer = 0;
    // An arrow's tip is grabbed within this many px of it (nothing is drawn there: the arrow is the handle)
    const GRAB_MOUSE = 11, GRAB_TOUCH = 20;
    let hoverAim = null;   // id of the body whose arrow tip the mouse is over

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

    // The tip of the chosen body's velocity arrow at (x, y)? (Only when velocities are shown.)
    function onHandle(x, y, tol) {
        const b = bodyById(selectedId);
        if (!settings.velocities || !b || b.held || bodies.length < 2) return null;
        const h = handlePos(b);
        if (Math.hypot(h.x - x, h.y - y) > tol) return null;
        // the body itself wins inside its disc
        if (Math.hypot(sx(b.dx) - x, sy(b.dy) - y) < drawRadius(b)) return null;
        return b;
    }
    // ...or the tip of another body's arrow (long enough to tell apart from the body)
    function onArrowTip(x, y, tol) {
        if (!settings.velocities || bodies.length < 2) return null;
        let best = null, bestD = tol;
        for (const b of bodies) {
            if (b.held || b.id === selectedId) continue;
            const tip = velocityTip(b);
            if (tip.len < 14) continue;
            const dd = Math.hypot(tip.x - x, tip.y - y);
            if (dd < bestD) { bestD = dd; best = b; }
        }
        return best;
    }

    // ------------------------------------------------------------------
    // Aiming a velocity. The arrow tip follows the pointer (at the arrows' zoom-free scale, so a pixel
    // is the same speed at any zoom); Shift makes it ten times finer. Near the exact circular or escape
    // speed relative to the body it orbits, it snaps to it. If that body moves fast through the view
    // (a moon seen from the star) or the arrow would be tiny, the velocity is aimed relative to that body
    // instead, with the circular speed as the arrow's unit.
    // ------------------------------------------------------------------
    const FINE = 0.1;
    const SNAP_PX = 6;

    function beginAim(b, d, pt) {
        startHold(b, d);
        const fv = d.frameV;
        let ref = null, k = pxPerSpeed();
        const p = placementPrimary(b.x, b.y, b.m, b);
        if (p && p.m >= b.m && frameId !== p.id) {
            const vc = Math.sqrt((G * (b.m + p.m)) / Math.max(Math.hypot(b.x - p.x, b.y - p.y), 1e-15));
            const drift = Math.hypot(p.vx - fv.x, p.vy - fv.y);
            if (vc * k < 24 || drift > 1.5 * vc) { ref = p; k = arrowUnit() / vc; }
        }
        const base = ref ? { x: ref.vx, y: ref.vy } : fv;
        b.aim = { vx: b.vx - base.x, vy: b.vy - base.y, k, ref, frameV: fv, snap: null };
        // Keep the grabbed point on the arrow. A body at rest has no arrow: it is grabbed just off the
        // edge of its disc, and the arrow grows from there as soon as the pointer moves.
        let tip = velocityTip(b);
        if (tip.len < 1) {
            const h = handlePos(b), x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
            const l = Math.hypot(h.x - x, h.y - y) || 1;
            tip = { x: x + ((h.x - x) / l) * r, y: y + ((h.y - y) / l) * r };
        }
        d.grabX = pt.x - tip.x; d.grabY = pt.y - tip.y;
        d.fine = null;
        d.start = { x: pt.x, y: pt.y, vx: b.aim.vx, vy: b.aim.vy, coarse: false };
    }

    // The world velocity the aimed velocity is measured from
    function aimBase(b) {
        const a = b.aim;
        if (a.ref && bodies.includes(a.ref)) return { x: a.ref.vx, y: a.ref.vy };
        return frameId !== null && frameId !== b.id ? frameVelocity() : a.frameV;
    }

    function moveAim(d, pt, shift) {
        const b = d.body, a = b.aim;
        if (shift) {
            // Fine: a tenth of the pointer's movement, from where Shift was pressed (or from where the
            // drag began, if Shift was down from the start)
            if (!d.fine) d.fine = d.start.coarse ? { x: pt.x, y: pt.y, vx: a.vx, vy: a.vy } : d.start;
            a.vx = d.fine.vx + ((pt.x - d.fine.x) * FINE) / a.k;
            a.vy = d.fine.vy - ((pt.y - d.fine.y) * FINE) / a.k;
            a.snap = null;
            return;
        }
        if (d.fine) {
            // Shift let go: carry on from here without a jump
            const tip = velocityTip(b);
            d.grabX = pt.x - tip.x; d.grabY = pt.y - tip.y;
            d.fine = null;
        }
        d.start.coarse = true;
        const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
        const tx = pt.x - d.grabX - x, ty = pt.y - d.grabY - y;
        const len = Math.hypot(tx, ty);
        const L = Math.max(0, len - r);   // the arrow starts at the disc's edge
        a.vx = len > 0 ? ((tx / len) * L) / a.k : 0;
        a.vy = len > 0 ? (-(ty / len) * L) / a.k : 0;
        snapAim(b);
    }

    // Snap to the circular velocity (either way round) within SNAP_PX of it, or to the escape speed
    // (any direction) within a little less.
    function snapAim(b) {
        const a = b.aim;
        a.snap = null;
        const p = placementPrimary(b.x, b.y, b.m, b);
        if (!p || p.m < b.m) return;
        const rx = b.x - p.x, ry = b.y - p.y, r = Math.hypot(rx, ry);
        if (!(r > 0)) return;
        const base = aimBase(b);
        const vc = Math.sqrt((G * (b.m + p.m)) / r), ve = Math.SQRT2 * vc;
        const ux = base.x + a.vx - p.vx, uy = base.y + a.vy - p.vy;
        const tol = SNAP_PX / a.k;
        let to = null;
        for (const s of [1, -1]) {
            const cx = (-s * ry / r) * vc, cy = (s * rx / r) * vc;
            if (Math.hypot(ux - cx, uy - cy) < tol) { to = [cx, cy]; a.snap = 'circular'; break; }
        }
        const u = Math.hypot(ux, uy);
        if (!to && u > 0 && Math.abs(u - ve) < 0.7 * tol) { to = [(ux * ve) / u, (uy * ve) / u]; a.snap = 'escape'; }
        if (to) { a.vx = to[0] + p.vx - base.x; a.vy = to[1] + p.vy - base.y; }
    }

    function startHold(b, d) {
        beginGesture(b, d.mode);   // (edit history: the whole drag is one step, from before the body is held)
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
                if (b.aim.snap) snapAim(b);   // exact, even if the body it orbits has moved on since
                const base = aimBase(b);
                b.vx = base.x + b.aim.vx; b.vy = base.y + b.aim.vy;
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
        endGesture(d.mode === 'move' || apply);
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
        const right = e.button === 2;
        // The chosen body's handle first, then a body, then another body's arrow tip
        let handleBody = right ? null : onHandle(pt.x, pt.y, touch ? GRAB_TOUCH : GRAB_MOUSE);
        const b = handleBody ? null : bodyAt(pt.x, pt.y, tol);
        if (!handleBody && !b && !right) handleBody = onArrowTip(pt.x, pt.y, touch ? GRAB_TOUCH - 2 : GRAB_MOUSE - 1);
        const d = { id: e.pointerId, x: pt.x, y: pt.y, x0: pt.x, y0: pt.y, type: lastPointerType, moved: false, body: null, mode: 'pending', button: e.button };
        if (handleBody) {
            d.mode = 'aim';
            d.body = handleBody;
            if (handleBody.id !== selectedId) selectBody(handleBody.id);
            beginAim(handleBody, d, pt);
        } else if (b) {
            d.body = b;
            if (right) {
                // Right-click: the body's menu
                d.mode = 'done';
                openPopover(b);
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
        if (d.mode === 'aim' && d.body && d.body.aim) {
            if (far) d.moved = true;
            if (d.moved) moveAim(d, pt, e.shiftKey || aimFine(d));
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
            endHold(d, !cancelled && (d.mode === 'move' || d.moved));
            return;
        }
        if (cancelled || d.mode === 'done') return;
        if (d.button === 2) {
            // Right-click on empty space just closes the menu
            if (d.mode === 'pending' && popBody) closePopover();
            return;
        }
        if (d.mode === 'press' || d.mode === 'pending') {
            // A tap or click; a double one views the motion from that body (or, on empty space, from
            // the centre of mass again)
            const now = performance.now();
            const b = d.body;
            const dbl = now - lastTap.t < 380 && Math.hypot(d.x0 - lastTap.x, d.y0 - lastTap.y) < (d.type === 'mouse' ? 8 : 26) && lastTap.id === (b ? b.id : null);
            lastTap = { t: dbl ? 0 : now, x: d.x0, y: d.y0, id: b ? b.id : null };
            if (b) {
                if (popBody && popBody !== b) closePopover();
                selectBody(b.id);
                if (dbl) setFrame(frameId === b.id ? null : b.id);
            } else if (dbl) {
                closePopover();
                if (frameId !== null) setFrame(null);
            } else if (popBody) {
                closePopover();
            }
        }
    }

    // The cursor shows what a press would do; an arrow tip under the mouse is also drawn highlighted.
    function updateCursor(x, y) {
        canvas.classList.remove('orb-can-grab', 'orb-grabbing', 'orb-can-aim');
        hoverAim = null;
        if (drags.size) {
            const d = [...drags.values()][0];
            canvas.classList.add(d.mode === 'aim' ? 'orb-can-aim' : 'orb-grabbing');
            return;
        }
        updateDrawnPositions();
        let tipOf = onHandle(x, y, GRAB_MOUSE);
        if (!tipOf && bodyAt(x, y, 5)) { canvas.classList.add('orb-can-grab'); return; }
        if (!tipOf) tipOf = onArrowTip(x, y, GRAB_MOUSE - 1);
        if (tipOf) { canvas.classList.add('orb-can-aim'); hoverAim = tipOf.id; }
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

    // Kinetic, potential and total energy. With realistic physics the first post-Newtonian terms of
    // each pair's energy are added (the v^4 one to the kinetic energy, the rest to the potential):
    // E/mu = (3/8)(1 - 3 eta) v^4/c^2 + GM/(2rc^2) [(3 + eta) v^2 + eta rdot^2 + GM/r]. Then the total
    // stays level round a black hole, where the Newtonian energy alone swings by tens of per cent each
    // orbit (to within the size of the next, 2PN, terms: about 2% for the neutron star at 0.24c).
    function systemEnergy() {
        const c = totals(bodies);
        let ke = 0, pe = 0;
        for (const b of bodies) ke += 0.5 * b.m * ((b.vx - c.vx) ** 2 + (b.vy - c.vy) ** 2);
        for (let i = 0; i < bodies.length; i++) {
            const bi = bodies[i];
            for (let j = i + 1; j < bodies.length; j++) {
                const bj = bodies[j];
                if (bi.grp && bi.grp === bj.grp) continue;
                const rx = bi.x - bj.x, ry = bi.y - bj.y, r = Math.hypot(rx, ry);
                if (!(r > 0)) continue;
                pe -= (G * bi.m * bj.m) / r;
                if (settings.realistic) {
                    const M = bi.m + bj.m, mu = (bi.m * bj.m) / M, eta = mu / M, gm = G * M;
                    const vx = bi.vx - bj.vx, vy = bi.vy - bj.vy, v2 = vx * vx + vy * vy;
                    const rd = (rx * vx + ry * vy) / r;
                    ke += (mu * 0.375 * (1 - 3 * eta) * v2 * v2) / C2;
                    pe += (mu * gm / (2 * r * C2)) * ((3 + eta) * v2 + eta * rd * rd + gm / r);
                }
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
    // Edit history: undo, redo and "run again"
    //   Each change the user makes to the system (moving a body or aiming its velocity, adding or
    //   deleting one, anything set in its popover or by the eccentricity slider, loading or restarting a
    //   scene) is an undo step: a compact copy of the whole system just before it, numbers and strings
    //   only (never the trails). A drag, a slider sweep or quick repeated changes to one body make a
    //   single step. Undo puts everything back as it was at that moment, the simulated time included;
    //   redo goes forward again. Merges and tidal break-ups are physics, not edits.
    //   "Run again" goes back to the system as it was at the last change (or at the start of the scene),
    //   taken the moment the simulation first runs after it. The integrator is deterministic, so the
    //   same motion plays again, and nothing is lost by going back: it isn't an undo step itself.
    //   Hooks in the code above: noteEdit() in keepView, addBody and deleteBody (and for any control in
    //   the popover, see bindHistory), beginGesture / endGesture in startHold / endHold, noteSceneLoad
    //   in loadScene and noteRun in advance.
    // ------------------------------------------------------------------
    const HISTORY_STEPS = 100;        // undo steps kept
    const HISTORY_BODIES = 60000;     // ...and at most this many bodies in all the kept steps together
    const MERGE_MS = 700;             // changes of one kind to one body this close together are one step
    const SNAP_W = 8;                 // numbers kept per body: id, m, R, x, y, vx, vy, grp
    const KEYS_MOD = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+';
    const hist = {
        ready: false,
        restoring: false,
        undo: [], redo: [],           // steps: { snap, label, target, key, at }
        pending: null,                // an edit under way: { snap, gesture } (+ label, target, key for a drag)
        open: null,                   // the newest step, while more changes of the same kind can join it
        epoch: 0,                     // counts restarts of the trail samples
        cleanLoad: true,              // nothing changed since the scene was loaded
        rw: null,                     // the "run again" state
        rwStale: true,                // changed since it was taken: take it when the simulation next runs
        rwFresh: true,                // the system is at it (nothing has run since)
        rwFromStart: true,            // ...and it is the start of the scene
        noteTimer: 0
    };

    // A compact copy of the system: eight numbers and three strings per body, and the globals that go
    // with them. reuse: an old copy whose storage can be written over (the "run again" state).
    function snapshot(reuse) {
        const n = bodies.length;
        const s = reuse && reuse.num.length >= n * SNAP_W ? reuse
            : { num: new Float64Array(n * SNAP_W), names: [], kinds: [], colors: [] };
        const num = s.num;
        for (let i = 0; i < n; i++) {
            const b = bodies[i], o = i * SNAP_W;
            num[o] = b.id; num[o + 1] = b.m; num[o + 2] = b.R;
            num[o + 3] = b.x; num[o + 4] = b.y; num[o + 5] = b.vx; num[o + 6] = b.vy;
            num[o + 7] = b.grp || 0;
            s.names[i] = b.name; s.kinds[i] = b.kind; s.colors[i] = b.color;
        }
        s.names.length = s.kinds.length = s.colors.length = n;
        return Object.assign(s, {
            n, t: simTime, samples: sampleCount, epoch: hist.epoch, customCount,
            scene: settings.scene, sel: selectedId, frame: frameId,
            // The scene's own scales and settings: put back only when a change of scene is undone
            forceRef, vRef, energyExp, trail: settings.trailIndex, com: settings.com,
            zoom: view.zoom, panX: view.panX, panY: view.panY
        });
    }

    // Put the system back as a snapshot has it. Bodies keep their ids (an existing body is reused, with
    // its trail buffer). Drags end; trails, period tracking, Kepler's 2nd law, the flyby card, the graphs
    // and the predicted path start again; and the view doesn't jump. how: 'undo' (or redo) or 'rewind'.
    function restoreSnapshot(s, how) {
        hist.restoring = true;
        endAllDrags();
        hoverAim = null;
        updateDrawnPositions();
        const before = { x: F.x, y: F.y };
        const pan = view.anim ? { x: view.anim.panX, y: view.anim.panY } : { x: view.panX, y: view.panY };
        const sameScene = s.scene === settings.scene;
        const jump = s.t !== simTime;
        // The trails are still good if no time has passed since the snapshot (an edit undone while paused)
        const keepTrails = sameScene && !jump && s.epoch === hist.epoch && s.samples === sampleCount;
        if (!sameScene) sceneFromSnapshot(s);
        const old = new Map(bodies.map((b) => [b.id, b]));
        const list = [];
        let maxId = 0;
        for (let i = 0; i < s.n; i++) {
            const num = s.num, o = i * SNAP_W, id = num[o];
            const x = num[o + 3], y = num[o + 4];
            let b = old.get(id);
            // A body that hasn't moved keeps its trail; one that has would get a jump in it
            const keep = keepTrails && b && Math.hypot(b.x - x, b.y - y) * scale < 0.5;
            if (!b) {
                b = newBody({ name: s.names[i], kind: s.kinds[i], m: num[o + 1], R: num[o + 2], color: s.colors[i] });
                b.id = id;
            }
            b.name = s.names[i]; b.kind = s.kinds[i]; b.color = s.colors[i];
            b.m = num[o + 1]; b.R = num[o + 2];
            b.x = b.px = b.dx = x; b.y = b.py = b.dy = y;
            b.vx = num[o + 5]; b.vy = num[o + 6];
            b.grp = num[o + 7] || null;
            b.held = null; b.aim = null; b.track = null;
            if (!keep) b.trailStart = sampleCount;
            list.push(b);
            if (id > maxId) maxId = id;
        }
        bodies = list;
        nextId = Math.max(nextId, maxId + 1);   // ids are never used twice
        customCount = s.customCount;
        simTime = s.t; acc = 0; lag = 0; slowedDown = false;
        if (!keepTrails) restartSamples();
        // The chosen body and the view-from body: undo brings back the choice made before the change;
        // running again keeps the current ones (if they are still there)
        const has = (id) => id !== null && bodies.some((b) => b.id === id);
        if (!sameScene) { selectedId = s.sel; frameId = s.frame; } else {
            if (how === 'rewind' ? !has(selectedId) : has(s.sel)) selectedId = s.sel;
            if (!has(frameId)) frameId = s.frame;
        }
        freeze = null;
        k2.bid = null;
        resetFlyby();
        flashes.length = 0;
        pred.key = '';
        eccDrag = null;
        forcesDirty = true;
        computeForces();
        computePrimaries();
        refreshBodyLists();
        if (popBody) {
            const pb = bodyById(popBody.id);
            if (pb) { popBody = pb; popSpeedMax = 0; updatePopover(true); } else closePopover();
        }
        // Nothing on the screen moves at the moment of the change. After a jump in time the view then
        // glides back to where it was relative to the frame's origin, so a body you view from stays put.
        updateDrawnPositions();
        if (sameScene) {
            view.panX += before.x - F.x;
            view.panY += before.y - F.y;
            if (jump) view.anim = { zoom: view.anim ? view.anim.zoom : view.zoom, panX: pan.x, panY: pan.y };
        } else {
            view.zoom = s.zoom; view.panX = s.panX; view.panY = s.panY; view.anim = null;
        }
        resetCharts();
        syncEccentricity(true);
        updateTrailLabel();
        hist.restoring = false;
    }

    // Undoing a change of scene: the scene's scales and settings come back with its bodies
    function sceneFromSnapshot(s) {
        settings.scene = s.scene;
        scene = SCENES[s.scene] || scene;
        if (ui.scene) ui.scene.value = s.scene;
        sampleDt = scene.Tref / TRAIL_PER_TREF;
        forceRef = s.forceRef; vRef = s.vRef; energyExp = s.energyExp;
        settings.trailIndex = s.trail;
        if (ui.trail) ui.trail.value = String(s.trail);
        settings.com = s.com;
        if (ui.com) ui.com.checked = s.com;
    }

    // Time has jumped: the trail samples start again from now, as when a scene is loaded (the samples'
    // times must keep increasing for sampleAtTime).
    function restartSamples() {
        sampleCount = 0;
        for (const b of bodies) b.trailStart = 0;
        recordSample();
        nextSampleT = simTime + sampleDt;
        hist.epoch++;
    }

    // Called just before the user changes the system. The first call of an edit takes the snapshot, and
    // the change is looked at when the event handler that made it has finished (so an edit that calls
    // this several times is still one step). later: the change is made by a later event listener (the
    // popover's own controls, whose events reach a capture listener first).
    function noteEdit(later) {
        if (!hist.ready || hist.restoring || hist.pending) return;
        hist.pending = { snap: snapshot(), gesture: false };
        if (later) setTimeout(flushEdit, 0); else queueMicrotask(flushEdit);
    }

    // Look at the edit under way (not a drag): what changed, if anything, names the step.
    function flushEdit() {
        const p = hist.pending;
        if (!p || p.gesture) return;
        hist.pending = null;
        const what = describeEdit(p.snap);
        if (what) commitStep(p.snap, what, true);
    }

    // A body picked up to move it, or its arrow grabbed to aim it: the step is the whole drag.
    function beginGesture(b, mode) {
        if (!hist.ready || hist.restoring) return;
        flushEdit();
        if (dragging() || hist.pending) return;
        hist.pending = {
            snap: snapshot(), gesture: true, target: b.id, key: mode,
            label: mode === 'aim' ? `change ${b.name}'s velocity` : `move ${b.name}`
        };
    }

    // The drag is over. changed: false if nothing was changed (an arrow tip pressed and let go).
    function endGesture(changed) {
        const p = hist.pending;
        if (!p || !p.gesture || bodies.some((b) => b.held)) return;
        hist.pending = null;
        if (changed) commitStep(p.snap, p, false);
    }

    // Is a body being dragged? (A drag that ended without endGesture is taken as a finished change.)
    function dragging() {
        const p = hist.pending;
        if (!p || !p.gesture) return false;
        if (bodies.some((b) => b.held)) return true;
        hist.pending = null;
        commitStep(p.snap, p, false);
        return false;
    }

    // Loading a scene, or restarting one, can be undone too, so a slip on the Restart button or the scene
    // list doesn't throw away a system you have built (restarting an untouched scene isn't a step).
    function noteSceneLoad(key) {
        if (!hist.ready) return;
        flushEdit();
        dragging();
        if (hist.pending) { const p = hist.pending; hist.pending = null; commitStep(p.snap, p, false); }
        const same = key === settings.scene;
        if (bodies.length && !(same && hist.cleanLoad && simTime === 0)) {
            commitStep(snapshot(), { label: same ? 'restart' : 'change scene', target: null, key: 'scene' }, false);
        }
        hist.epoch++;
        Object.assign(hist, { cleanLoad: true, rwStale: true, rwFresh: false, rwFromStart: true, open: null });
        updateHistoryUi();
    }

    // The simulation is about to take a step: finish an edit, and if this is the first run since the
    // last change, take the "run again" state now.
    function noteRun() {
        if (!hist.ready) return;
        if (hist.pending && !hist.pending.gesture) flushEdit();
        if (!hist.rwStale && !hist.rwFresh) return;
        if (bodies.some((b) => b.held)) return;   // a drag isn't over yet
        if (hist.rwStale) {
            hist.rw = snapshot(hist.rw);
            hist.rwStale = false;
            // The forces from this state, as running again will work them out (with realistic physics
            // they depend on the velocities too), so it runs exactly the same way each time
            forcesDirty = true;
        }
        hist.rwFresh = false;
        updateHistoryUi();
    }

    // Has a vector changed, beyond the rounding of working it out again?
    const vecDiffers = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by) > 1e-12 * Math.max(Math.hypot(ax, ay), Math.hypot(bx, by)) + 1e-18;
    const numDiffers = (a, b) => Math.abs(a - b) > 1e-12 * Math.max(Math.abs(a), Math.abs(b));

    // What an edit changed, compared with the snapshot taken before it: { label, target, key }, or null
    // if nothing did. A change to the chosen body is the one named.
    function describeEdit(s) {
        const at = new Map();
        for (let i = 0; i < s.n; i++) at.set(s.num[i * SNAP_W], i);
        const added = [];
        let main = null, kept = 0;
        for (const b of bodies) {
            const i = at.get(b.id);
            if (i === undefined) { added.push(b); continue; }
            kept++;
            const key = changeOf(s, i, b);
            if (key && (!main || b.id === selectedId)) main = { b, i, key };
        }
        if (added.length) {
            return { key: 'add', target: added[0].id, label: added.length > 1 ? `add ${added.length} bodies` : `add ${added[0].name}` };
        }
        if (kept < s.n) {
            const ids = new Set(bodies.map((b) => b.id)), gone = [];
            for (let i = 0; i < s.n; i++) if (!ids.has(s.num[i * SNAP_W])) gone.push(i);
            return { key: 'delete', target: s.num[gone[0] * SNAP_W], label: gone.length > 1 ? `delete ${gone.length} bodies` : `delete ${s.names[gone[0]]}` };
        }
        if (!main) return null;
        const n = s.names[main.i];
        const label = {
            mass: `change ${n}'s mass`, radius: `change ${n}'s radius`, orbit: `change ${n}'s orbit`, move: `move ${n}`,
            speed: `change ${n}'s speed`, velocity: `change ${n}'s velocity`, name: `rename ${n}`, colour: `change ${n}'s colour`
        }[main.key];
        // (the speed slider and an aimed arrow can follow on from each other as one step)
        return { key: main.key === 'speed' ? 'velocity' : main.key, target: main.b.id, label };
    }

    // The main thing that changed about body b (row i of the snapshot): the mass first (a neutron star
    // that becomes a black hole changes everything), then its radius, where it is and how it moves, and
    // last its name and colour.
    function changeOf(s, i, b) {
        const num = s.num, o = i * SNAP_W;
        if (numDiffers(num[o + 1], b.m) || s.kinds[i] !== b.kind) return 'mass';
        if (numDiffers(num[o + 2], b.R)) return 'radius';
        const vx = num[o + 5], vy = num[o + 6];
        const moved = vecDiffers(num[o + 3], num[o + 4], b.x, b.y);
        const sped = vecDiffers(vx, vy, b.vx, b.vy);
        if (moved) return sped ? 'orbit' : 'move';
        if (sped) {
            const cross = vx * b.vy - vy * b.vx, dot = vx * b.vx + vy * b.vy;
            return dot > 0 && Math.abs(cross) <= 1e-9 * dot ? 'speed' : 'velocity';
        }
        if (s.names[i] !== b.name) return 'name';
        if (s.colors[i] !== b.color) return 'colour';
        return null;
    }

    // A new undo step (or more of the newest one: the same kind of change to the same body within
    // MERGE_MS of the last, or more typing of its name). A new step clears the redo steps.
    function commitStep(snap, what, mergeable) {
        const now = performance.now();
        const top = hist.undo[hist.undo.length - 1];
        if (mergeable && top && top === hist.open && top.target === what.target && top.key === what.key
            && (what.key === 'name' || now - top.at < MERGE_MS)) {
            top.at = now;
        } else {
            hist.undo.push({ snap, label: what.label, target: what.target, key: what.key, at: now });
            hist.redo.length = 0;
            trimHistory();
        }
        hist.open = mergeable ? hist.undo[hist.undo.length - 1] : null;
        Object.assign(hist, { cleanLoad: false, rwStale: true, rwFresh: false, rwFromStart: false });
        updateHistoryUi();
    }

    // At most HISTORY_STEPS steps, and HISTORY_BODIES bodies in all (fewer steps for a big swarm)
    function trimHistory() {
        while (hist.undo.length > HISTORY_STEPS) hist.undo.shift();
        const size = (list) => list.reduce((n, st) => n + st.snap.n, 0);
        while (hist.undo.length > 1 && size(hist.undo) + size(hist.redo) > HISTORY_BODIES) hist.undo.shift();
    }

    function undoStep() {
        flushEdit();
        if (dragging() || !hist.undo.length) return false;
        const st = hist.undo.pop();
        hist.redo.push({ snap: snapshot(), label: st.label, target: st.target, key: st.key, at: 0 });
        restoreSnapshot(st.snap, 'undo');
        afterUndoRedo(`<strong>Undone:</strong> ${escapeHtml(st.label)}`);
        return true;
    }

    function redoStep() {
        flushEdit();
        if (dragging() || !hist.redo.length) return false;
        const st = hist.redo.pop();
        hist.undo.push({ snap: snapshot(), label: st.label, target: st.target, key: st.key, at: 0 });
        restoreSnapshot(st.snap, 'undo');
        afterUndoRedo(`<strong>Redone:</strong> ${escapeHtml(st.label)}`);
        return true;
    }

    function afterUndoRedo(note) {
        Object.assign(hist, { open: null, cleanLoad: false, rwStale: true, rwFresh: false, rwFromStart: false });
        historyNote(note);
        updateHistoryUi();
    }

    const canRunAgain = () => !!hist.rw && !hist.rwStale && !hist.rwFresh;

    // Back to the state at the last change (or the start of the scene), and play
    function runAgain() {
        flushEdit();
        if (dragging() || !canRunAgain()) return false;
        restoreSnapshot(hist.rw, 'rewind');
        hist.rwFresh = true;
        hist.open = null;
        setPaused(false);
        historyNote(`<strong>Running again</strong> from ${hist.rwFromStart ? 'the start' : 'your last change'}.`);
        updateHistoryUi();
        return true;
    }

    // Delete or Backspace: delete the chosen body (if another is left)
    function deleteChosen() {
        const b = bodyById(selectedId);
        if (!b || bodies.length < 2 || dragging()) return;
        const name = b.name;
        if (popBody === b) closePopover();
        deleteBody(b);
        flushEdit();
        historyNote(`<strong>Deleted ${escapeHtml(name)}.</strong> ${KEYS_MOD}Z brings it back.`);
    }

    // A short note in the hint line (read out by screen readers too), until the next one or a few seconds
    function historyNote(html) {
        setHint(null, html);
        clearTimeout(hist.noteTimer);
        hist.noteTimer = setTimeout(() => { if (hintKey === html) setHint(); }, 4000);
    }

    function updateHistoryUi() {
        const u = hist.undo[hist.undo.length - 1], r = hist.redo[hist.redo.length - 1];
        historyButton(ui.undoBtn, 'Undo', u, `${KEYS_MOD}Z`);
        historyButton(ui.redoBtn, 'Redo', r, KEYS_MOD === '⌘' ? '⇧⌘Z' : 'Ctrl+Y');
        if (ui.rewindBtn) {
            const t = `Run again from ${hist.rwFromStart ? 'the start' : 'your last change'}`;
            ui.rewindBtn.disabled = !canRunAgain();
            ui.rewindBtn.title = `${t} (R)`;
            ui.rewindBtn.setAttribute('aria-label', t);
        }
    }

    // "Undo: move Earth (Ctrl+Z)", or greyed out with "Nothing to undo"
    function historyButton(btn, verb, step, keys) {
        if (!btn) return;
        btn.disabled = !step;
        btn.title = step ? `${verb}: ${step.label} (${keys})` : `Nothing to ${verb.toLowerCase()}`;
        btn.setAttribute('aria-label', step ? `${verb}: ${step.label}` : verb);
    }

    // Keys: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redo, R run again, Delete or Backspace delete
    // the chosen body. Not while typing in a field, which keeps its own undo.
    function typingIn(el) {
        if (!el || !el.tagName) return false;
        if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
        return el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color'].includes((el.type || 'text').toLowerCase());
    }

    function onHistoryKey(e) {
        if (e.defaultPrevented || e.isComposing || e.altKey || typingIn(e.target)) return;
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
        // R and Delete act only while the simulation is in use (last pressed or focused, its menu open,
        // or fullscreen), as the arrow keys do: Backspace pressed while reading the page mustn't delete a body
        const inUse = !!popBody || edit.engaged || document.body.classList.contains('sim-fullscreen-active');
        if (mod && key === 'z') { if (e.shiftKey) redoStep(); else undoStep(); }
        else if (mod && key === 'y' && !e.shiftKey) redoStep();
        else if (!mod && key === 'r' && inUse) { if (!e.repeat) runAgain(); }
        else if (!mod && (key === 'Delete' || key === 'Backspace') && inUse) { if (!e.repeat) deleteChosen(); }
        else return;
        e.preventDefault();
    }

    function bindHistory() {
        Object.assign(ui, { undoBtn: byId('undoBtn'), redoBtn: byId('redoBtn'), rewindBtn: byId('rewindBtn') });
        // After a click or tap the button lets go of the focus, so Space pauses rather than pressing it again
        const onClick = (btn, action) => {
            if (btn) btn.addEventListener('click', (e) => { action(); if (e.detail) btn.blur(); });
        };
        onClick(ui.undoBtn, undoStep);
        onClick(ui.redoBtn, redoStep);
        onClick(ui.rewindBtn, runAgain);
        // Anything changed in the popover is an edit (its radius, name and colour don't go through
        // keepView): a capture listener takes the snapshot before the control's own listener runs, and a
        // bubbling one looks at the change after it.
        if (ui.pop) {
            ['input', 'change', 'click'].forEach((type) => {
                ui.pop.addEventListener(type, () => noteEdit(true), true);
                ui.pop.addEventListener(type, flushEdit);
            });
        }
        document.addEventListener('keydown', onHistoryKey);
        hist.ready = true;
        updateHistoryUi();
    }

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
        bindCheck(ui.velocities, 'velocities', () => setHint());
        bindCheck(ui.labels, 'labels');
        bindCheck(ui.realistic, 'realistic', () => { forcesDirty = true; pred.key = ''; });
        bindCheck(ui.k1, 'k1');
        bindCheck(ui.k2, 'k2', () => { k2.bid = null; });
        bindCheck(ui.k3, 'k3');
        bindCheck(ui.com, 'com');
        bindCheck(ui.preview, 'preview');
        bindCheck(ui.merge, 'merge');
        if (ui.speed) {
            const upd = () => {
                settings.speed = SPEED_STOPS[clamp(parseInt(ui.speed.value, 10) || 0, 0, SPEED_STOPS.length - 1)];
                showSpeed();
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
            if (!drags.has(e.pointerId)) { canvas.classList.remove('orb-can-grab', 'orb-can-aim'); hoverAim = null; }
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
        for (const d of drags.values()) if ((d.mode === 'move' || (d.mode === 'aim' && d.moved)) && d.body && !paused) dragHint(d);

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
            elements: el ? { a: el.a, e: el.e, T: el.T, r: el.r, v: el.v, w: el.w } : null,
            kind: b.kind, piece: !!b.grp,
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
        setSpeed(v) { setSpeedValue(v); },
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
        setRealistic(v) { if (ui.realistic) ui.realistic.checked = !!v; settings.realistic = !!v; forcesDirty = true; },
        flyby() { return Object.assign({}, flyby, { pts: flyby.pts.length / 2 }); },
        // The path predicted for a body if it were launched now with world velocity (vx, vy): points
        // relative to the reference body (or the centre of mass), and how the path ends
        predict(name, vx, vy) {
            const b = bodies.find((q) => q.name === name);
            if (!b) return null;
            const fv = frameVelocity();
            b.aim = { vx: vx - fv.x, vy: vy - fv.y, k: 1, ref: null, frameV: fv, snap: null };
            pred.key = '';
            const pp = predictPath(b, null);
            b.aim = null;
            const ref = pp.refId !== null ? bodyById(pp.refId) : null;
            return { ref: ref ? ref.name : null, end: pp.end, pts: pp.pts.slice() };
        },
        // Where the velocity handle of a body is on the canvas (CSS px), and its arrow's length
        handle(name) {
            const b = bodies.find((q) => q.name === name);
            if (!b) return null;
            updateDrawnPositions();
            computeDrawRadii();
            const h = handlePos(b), t = velocityTip(b);
            return { x: h.x, y: h.y, len: t.len };
        },
        speeds(name) {
            const b = bodies.find((q) => q.name === name);
            const p = b && placementPrimary(b.x, b.y, b.m, b);
            if (!p) return null;
            const s = speedsAround(b, p);
            return { primary: p.name, r: s.r, vc: s.vc, ve: s.ve, vrel: Math.hypot(b.vx - p.vx, b.vy - p.vy) };
        },
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

    // Time controls and the orbit readouts (see "Time controls" above): the speed stops, a step while
    // paused, the speed actually reached, and what the info bar shows for the chosen body's orbit
    Object.assign(window.orbitsSimulation, {
        speedStops: () => SPEED_STOPS.slice(),
        stepForward,
        timeInfo() {
            return {
                speed: settings.speed, stop: ui.speed ? +ui.speed.value : null, shown: ui.speedVal ? ui.speedVal.textContent : null,
                caption: speedCaption(settings.speed), achieved: pace.ratio * settings.speed, behind: pace.behind,
                notice: timeNotice(), stepYears: settings.speed * rate() * STEP_FRAME
            };
        },
        orbitReadout() {
            updateOrbitReadouts();
            const txt = (el) => (el ? el.textContent : null);
            return {
                period: txt(ui.statPeriod), unit: txt(ui.statPeriodUnit), measured: !!(ui.statPeriodMark && !ui.statPeriodMark.hidden),
                ecc: txt(ui.statEcc), title: ui.statPeriodBox ? ui.statPeriodBox.title : null
            };
        }
    });
    bindTimeControls();

    // Trajectory editor (speeds in AU/yr or km/s, angles in degrees from sideways, + outward; times in
    // years; distances in AU)
    (function () {
        const api = window.orbitsSimulation;
        const named = (name) => bodies.find((q) => q.name === name) || null;
        const PUSH_NAMES = { prograde: 'faster', retrograde: 'slower', outward: 'out', inward: 'in' };
        Object.assign(api, {
            // Velocity relative to what it orbits (the heaviest body's: to the centre of mass)
            velocity(name) {
                const b = named(name);
                if (!b) return null;
                const s = velocityParts(b);
                return { speed: s.v, kms: s.v * AUYR_KMS, angle: s.angle / DEG, sense: s.sense, relativeTo: s.p ? s.p.name : 'centre of mass' };
            },
            // { speed (AU/yr) or kms, angle, sense (1 anticlockwise, -1 clockwise) or retro (against the
            // usual way round) }; anything left out stays as it is
            setVelocity(name, o) {
                const b = named(name);
                if (!b) return null;
                const s = velocityParts(b);
                const speed = o.kms !== undefined ? o.kms / AUYR_KMS : o.speed !== undefined ? o.speed : s.v;
                const angle = o.angle !== undefined ? o.angle * DEG : s.angle;
                let sense = o.sense || s.sense;
                if (o.retro !== undefined && s.p) {
                    const u = usualSense(s.p, b) || orbitSense(s.p, b);
                    sense = o.retro ? -u : u;
                }
                setVelocity(b, speed, s.screen ? angle : clamp(angle, -Math.PI / 2, Math.PI / 2), sense);
                return api.velocity(name);
            },
            orbit(name) {
                const b = named(name);
                const o = b ? orbitOf(b) : null;
                return o ? { primary: o.p.name, T: o.T, rp: o.rp, ra: o.ra, a: o.el.a, e: o.el.e, bound: o.el.bound } : null;
            },
            // { T } and/or { rp, ra } (T first, then the distances, by the menu's rules)
            setOrbit(name, o) {
                const b = named(name);
                if (!b) return null;
                if (o.T !== undefined) setPeriod(b, o.T);
                if (o.rp !== undefined || o.ra !== undefined) {
                    const c = orbitOf(b);
                    if (c) {
                        const rp = o.rp !== undefined ? o.rp : c.rp, ra = o.ra !== undefined ? o.ra : c.ra;
                        setApsides(b, Math.min(rp, ra), Math.max(rp, ra));
                    }
                }
                return api.orbit(name);
            },
            // kind: faster, slower, out or in (or prograde, retrograde, outward, inward); step: a
            // fraction of its speed (default: the menu's step)
            nudge(name, kind, step) {
                const b = named(name);
                if (!b) return null;
                nudge(b, PUSH_NAMES[kind] || kind, step !== undefined ? step : edit.step);
                return api.velocity(name);
            },
            openEditor(name, tab) { openEditor(name ? named(name) : bodyById(selectedId), tab || null); },
            setStep,
            editor() {
                const fields = {}, units = {};
                for (const n of Object.keys(FIELDS)) {
                    fields[n] = FIELDS[n].input ? FIELDS[n].input.value : null;
                    units[n] = edit.units[n] ? edit.units[n].label : null;
                }
                const P = edit.preview;
                return {
                    open: !!popBody, body: popBody ? popBody.name : null, tab: edit.tab, step: edit.step, fields, units,
                    preview: P ? { body: bodyById(P.bid) ? bodyById(P.bid).name : null, points: P.pts.length / 2, end: P.end, age: performance.now() - P.t, cost: P.cost } : null,
                    previewing: previewBody() ? previewBody().name : null
                };
            }
        });
    })();

    // Edit history (undo, redo, run again): each returns whether it did anything
    Object.assign(window.orbitsSimulation, {
        undo: () => undoStep(),
        redo: () => redoStep(),
        rewind: () => runAgain(),
        history() {
            flushEdit();
            return {
                undo: hist.undo.length, redo: hist.redo.length,
                labels: hist.undo.map((st) => st.label), redoLabels: hist.redo.map((st) => st.label),
                dragging: !!(hist.pending && hist.pending.gesture),
                canRewind: canRunAgain(), rewindTime: hist.rw && !hist.rwStale ? hist.rw.t : null,
                rewindFromStart: hist.rwFromStart
            };
        }
    });
    bindHistory();

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
