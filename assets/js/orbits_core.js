/*
 * Orbits & Gravity simulation - Newtonian n-body gravity in 2D.
 *
 * Units: distances in AU, times in (Julian) years, masses in solar masses, so G = 4 pi^2 and a planet
 * 1 AU from a 1 M_sun star takes one year per orbit. Readouts convert to km, km/s, kg and N.
 *
 * Integration: Yoshida's 4th-order composition of three kick-drift-kick leapfrog steps (symplectic and
 *   time-reversible for a fixed step), with one adaptive step for all bodies, dt = ETA * min over pairs of
 *   sqrt(r^3 / G(m_i + m_j)), so a close pass is taken in many small steps. That is accurate enough for
 *   chaotic three-body encounters (the Pythagorean problem ends as published). Two bodies much closer to
 *   each other than to anything else (a tight binary, a flyby) instead drift round each other on an exact
 *   two-body (Kepler) orbit, with the rest acting through the kicks (Wisdom-Holman splitting), so the step
 *   only has to follow the rest: a close pass costs a few dozen steps however close it gets. Leftover
 *   frame time carries over to the next frame (no step is ever cut short), and the bodies are drawn
 *   extrapolated by that leftover so the motion stays smooth. The physics gets a share of each frame's
 *   time on the clock; if the steps owed don't fit, the simulation slows down for a moment instead of
 *   losing accuracy.
 *   Forces: every pair is summed exactly up to DIRECT_MAX bodies (on packed typed arrays); beyond that,
 *   the heaviest bodies still pull pair by pair and the light ones pull on each other through a
 *   Barnes-Hut tree with quadrupole moments, up to MAX_BODIES bodies.
 *   Bodies whose real radii touch (checked along each step, after a sort-and-sweep broad phase) merge,
 *   conserving mass and momentum; a black hole swallows whatever crosses its event horizon.
 *
 * Realistic physics (off by default) draws every body at its true size (with a small marker so it can be
 *   found), adds the first post-Newtonian correction of general relativity to each pair (orbits close to a
 *   neutron star or black hole precess) and tears apart a star, planet or moon that strays inside the
 *   Roche limit of a much denser body; its pieces pull on each other (softened) as well as on the rest.
 *
 * Crowded scenes (more than SWARM_N bodies, or made as a swarm) draw their light bodies as plain dots
 *   with short trails and no names or arrows, unless chosen; drawing gets coarser before the physics
 *   slows down if a frame runs long.
 *
 * Frames: the view follows the centre of mass (an inertial frame) or is locked on a body. Trails are
 *   stored in inertial coordinates at shared sample times, so they can be redrawn relative to any body.
 *   The view can also turn with a body and the body it orbits (a rotating frame): then the bodies'
 *   drawn positions (dx, dy) are turned about the frame's origin, so they are NOT world positions; a
 *   screen point goes back to the world through unturnPoint (see "Rotating frame" after syncFrameUi).
 *   The gravity well (the potential as a contour map) and the Lagrange points are drawn there too.
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
    const PHYSICS_MS = 13;                // at most this many ms per frame for the physics before the simulation slows down
    const YOSHIDA_W1 = 1 / (2 - Math.cbrt(2)), YOSHIDA_W0 = 1 - 2 * YOSHIDA_W1;
    const MAX_BODIES = 1000;
    const SWARM_N = 40;                   // with more bodies than this, the light ones are drawn and named as a swarm
    const SECONDS_PER_TREF = 6;           // real seconds per reference period of the scene at 1x
    const TRAIL_PER_TREF = 300;           // trail samples per reference period
    const TRAIL_CAP = 6144;               // samples kept per body (20 reference periods)
    const SWARM_TRAIL = 256;              // samples kept for a minor body of a crowded scene (memory stays small)
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

    // Repeatable pseudo-random numbers in [0, 1) for the crowded scenes (the same scene every time)
    function seeded(seed) {
        let s = seed;
        return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    }
    // The true anomaly (angle from the closest point) at mean anomaly M on an ellipse of eccentricity e
    function trueAnomaly(M, e) {
        let E = M;
        for (let k = 0; k < 30; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    }

    // ------------------------------------------------------------------
    // Scenes. Bodies are given directly or by orbit elements around an earlier body
    // (a in AU, e, w = direction of the closest point in degrees, nu = start angle from it).
    // Every scene starts with the centre of mass at rest at the origin. Tref: the scene's reference
    // period (6 s on screen at 1x); vref: the speed drawn as a medium arrow (default: the subject's
    // average orbital speed); tip: a line for the hint bar when the scene opens; swarm: its light bodies
    // are drawn as a swarm (dots, no names) however few are left.
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
        // The Sun, Jupiter and 500 of the asteroids its gravity herds. 150 Trojans gather round each of the
        // points 60 degrees ahead of and behind Jupiter on its orbit (L4 and L5), swinging slowly about them.
        // 200 Hildas are in the 3:2 resonance (three orbits for every two of Jupiter's), on orbits lined up so
        // that each is at its closest to the Sun whenever Jupiter passes it, safely far from Jupiter; at any
        // moment they trace a triangle, its corners 60 degrees ahead of, behind and opposite Jupiter, that
        // turns with it. Real orbits (Hildas at 3.97 AU, e = 0.12 to 0.25) and sizes (20 to 60 km); the
        // asteroids pull on each other and on Jupiter as well, far too weakly to see.
        trojans: {
            units: 'au', Tref: 11.86, subject: 1, trail: 1, swarm: true, box: [-6.3, 6.3, -6.3, 6.3],
            tip: 'Jupiter\'s pull herds 500 asteroids: the Trojans stay 60° ahead of it and 60° behind it, and the Hildas trace a triangle that turns with it. Set View from to "Rotating with Jupiter and the Sun" to see them stand still.',
            bodies: (function () {
                const rnd = seeded(11);
                const list = [{ kind: 'sun' }, { kind: 'jupiter', orbit: { around: 0, a: 5.2026, e: 0.0484, w: 0, nu: 0 } }];
                const rock = (rkm) => ({ R: rkm, m: (4 / 3) * Math.PI * Math.pow(rkm * 1000, 3) * 1500 / MSUN_KG });
                // Orbit elements from a mean longitude lambda and the direction of the closest point w (degrees)
                const orbitAt = (a, e, w, lambda) => ({ around: 0, a, e, w, nu: trueAnomaly(((lambda - w) * Math.PI) / 180, e) * 180 / Math.PI });
                for (let i = 0; i < 300; i++) {
                    const ahead = i % 2 === 0, w = 360 * rnd();
                    const lambda = (ahead ? 60 : -60) + 20 * (rnd() - 0.5);
                    list.push(Object.assign({ kind: 'asteroid', name: `Trojan ${i + 1}`, color: '#c9a27a',
                        orbit: orbitAt(5.2026 * (1 + 0.012 * (rnd() - 0.5)), 0.08 * rnd(), w, lambda) }, rock(20 + 40 * rnd())));
                }
                for (let i = 0; i < 200; i++) {
                    // 3 lambda_J - 2 lambda - w close to 0, with Jupiter's lambda_J = 0 now
                    const lambda = 360 * rnd(), w = -2 * lambda - 40 * (rnd() - 0.5);
                    list.push(Object.assign({ kind: 'asteroid', name: `Hilda ${i + 1}`, color: '#7bd0c1',
                        orbit: orbitAt(3.97 * (1 + 0.006 * (rnd() - 0.5)), 0.12 + 0.13 * rnd(), w, lambda) }, rock(20 + 40 * rnd())));
                }
                return list;
            })()
        },
        // A moon forming, as the Moon probably did after a Mars-sized body hit the young Earth: 400 moonlets
        // of rock (300 km across, two Moons' worth in all) left in a disc just outside Earth's Roche limit
        // (2.9 Earth radii, inside which tides would pull a moon apart), 20,000 to 45,000 km out. They
        // pull on each other, stir each other up, collide and stick; the biggest grow fastest. (In this flat
        // disc everything is in one plane, so they meet more often than in a real, thicker one.)
        moondisc: {
            units: 'km', Tref: 0.5 / DAYS_PER_YEAR, subject: 1, trail: 1, swarm: true, box: [-50000, 50000, -50000, 50000].map((v) => v / AU_KM),
            tip: 'Moonlets left by a giant impact pull on each other, collide and stick: a moon builds up. Turn on Realistic physics to see tides tear apart clumps that stray too close to Earth.',
            bodies: (function () {
                const rnd = seeded(5);
                const n = 400, mass = (2 * KINDS.moon.m) / n;
                const R = Math.cbrt((3 * mass * MSUN_KG) / (4 * Math.PI * 3300)) / 1000;   // km, at the Moon's density
                const list = [{ kind: 'earth' }];
                for (let i = 0; i < n; i++) {
                    const a = (20000 + 25000 * rnd()) / AU_KM;
                    list.push({ kind: 'moon', name: `Moonlet ${i + 1}`, m: mass, R, color: i % 3 ? '#b5aca3' : '#c9ccd3',
                        orbit: { around: 0, a, e: 0.02 * rnd(), w: 360 * rnd(), nu: 360 * rnd() } });
                }
                return list;
            })()
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
            trail: null,                  // samples (allocated at the first one: see recordSample)
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
        const used = new Set();
        for (const b of bodies) used.add(b.name);
        if (!used.has(base)) return base;
        for (let i = 2; ; i++) {
            const n = `${base} ${i}`;
            if (!used.has(n)) return n;
        }
    }

    // ------------------------------------------------------------------
    // Physics
    // ------------------------------------------------------------------
    // Accelerations of every body in a list (the bodies, or a copy of them for a prediction), and the
    // shortest pair free-fall time squared, r^3 / G(m_i + m_j), for the step size.
    // With realistic physics each pair also gets the first post-Newtonian (1PN) correction of general
    // relativity (the usual harmonic-coordinate form for the relative motion of two bodies), shared
    // between the two bodies in inverse proportion to their masses:
    //   a = GM/(c^2 r^2) { [(4 + 2 eta) GM/r - (1 + 3 eta) v^2 + 1.5 eta rdot^2] n + (4 - 2 eta) rdot v }
    // where M = m1 + m2, eta = m1 m2 / M^2, n points from body 2 to body 1 and v = v1 - v2. It turns an
    // orbit's ellipse by 6 pi GM / (c^2 a (1 - e^2)) each time round: 43" a century for Mercury,
    // degrees per orbit close to a neutron star or black hole. Pairs for which both GM/(rc^2) and v^2/c^2
    // are under PN_SKIP (a billionth: Earth and a moonlet, two asteroids) skip it: it would turn their
    // orbits by a few billionths of a radian per turn. The 1PN part is kept apart, so the second kick
    // (velocities changed, positions not) only works out again the pairs where it matters.
    //
    // The sums run on packed copies of the bodies' numbers (one Float64Array per quantity, kept from one
    // step to the next), which a browser works through far faster than the bodies' own objects; the
    // bodies stay the record of where everything is. Up to DIRECT_MAX bodies every pair is added up
    // exactly, in the same order as always, so the small scenes give exactly the same numbers. With more,
    // the heaviest few (and the members of close pairs, below) still pull and are pulled pair by pair,
    // with relativity, but the light bodies' pulls on each other come from a Barnes-Hut tree.
    //
    // Pieces of one torn-apart body pull on each other too, softened (Plummer): a = G m d / (d^2 + eps^2)^1.5,
    // with eps the radius of the whole body they came from. Each piece stands for part of the star's gas,
    // spread through it and held up by its pressure, not a point: softened only at their own size, pieces
    // released at rest (there is no pressure in the model) would fall together into a clump far smaller
    // than the star was, which then survives a pass that tears the real star apart. Two pieces passing
    // through each other feel a gentle pull, not an ever stronger one, and the clump can never force the
    // step down below about its own free-fall time (eps^3 / G(m_i + m_j)), whatever they do. That pull changes
    // smoothly (it never grows without limit, as a point mass's does close in), so those pairs need SOFT_STEP
    // times fewer steps per free-fall time than a point-mass orbit: still about 200 per swing through the
    // clump. (No relativity between them: GM/(rc^2) for a ninth of a star is a few millionths.)
    const DIRECT_MAX = 200;               // exact pair sums up to this many bodies (about the measured crossover with the tree)
    // With the tree, its force errors (a few parts in 10,000 of the swarm's own pull) are the limit on
    // accuracy, not the steps: ETA_SWARM still gives over 600 steps per orbit at 4th order, whose errors
    // stay far below them, and lets a big swarm keep up with the clock.
    const ETA_SWARM = 0.01;
    const HEAVY_MAX = 8;                  // above it, the heaviest bodies that still pull pair by pair
    const PN_SKIP = 1e-9;
    const SOFT_STEP = 8;
    const SOFT_T2 = SOFT_STEP * SOFT_STEP;   // (the times are kept squared)
    // A piece's softening length (AU): the radius of the body it came from, cbrt(FRAGMENTS) times its own
    const softLength = (b) => (b.R * Math.cbrt(FRAGMENTS)) / AU_KM;
    let scrCap = 0;
    let SX, SY, SVX, SVY, SM, SEPS, SGRP, SAX, SAY, SA0, SBEST, SSECOND, SPART, SPAIR, SDIR, SDPOS;
    let PAX, PAY, NAX, NAY;                  // the 1PN part of the accelerations, and the Newtonian part
    let PNI = new Int32Array(256), PNJ = new Int32Array(256), pnCount = 0, pnList = null, pnN = -1, pnTmin = Infinity;
    function ensureScratch(n) {
        if (n <= scrCap) return;
        scrCap = Math.max(n, 2 * scrCap, 64);
        const f = () => new Float64Array(scrCap), k = () => new Int32Array(scrCap);
        SX = f(); SY = f(); SVX = f(); SVY = f(); SM = f(); SEPS = f(); SGRP = f(); SAX = f(); SAY = f(); SA0 = f();
        SBEST = f(); SSECOND = f(); SPART = k(); SPAIR = k(); SDIR = k(); SDPOS = k();
        PAX = f(); PAY = f(); NAX = f(); NAY = f();
        growTreeCache(scrCap);
    }

    let gravStamp = 0;
    let forceMode = 'auto';   // 'direct' or 'tree' forces one method (for the accuracy test)
    let heavyMax = HEAVY_MAX;
    const work = { pairs: 0, tree: 0 };   // interactions in the last evaluation (for the perf readout)

    // pairs: close pairs whose own pull is left out (their orbit is followed exactly by the drift);
    // velOnly: only the velocities changed since the last call (the second kick with relativity).
    function gravity(list, pairs, velOnly) {
        const n = list.length;
        ensureScratch(n);
        const stamp = ++gravStamp;
        const useTree = forceMode === 'tree' || (forceMode === 'auto' && n > DIRECT_MAX);
        const xs = SX, ys = SY, vxs = SVX, vys = SVY, ms = SM, grp = SGRP, eps = SEPS, a0 = SA0, pair = SPAIR;
        for (let k = 0; k < n; k++) {
            const b = list[k];
            xs[k] = b.x; ys[k] = b.y; vxs[k] = b.vx; vys[k] = b.vy; ms[k] = b.m;
            const g = b.grp || 0;
            grp[k] = g;
            eps[k] = g ? softLength(b) : 0;
            // (the last acceleration: the tree's relative criterion needs it)
            a0[k] = useTree && (b.ax || b.ay) ? Math.sqrt(b.ax * b.ax + b.ay * b.ay) : 0;
            pair[k] = -1;
            b.slot = k; b.stamp = stamp;
        }
        if (pairs) {
            for (const p of pairs) {
                if (p.a.stamp === stamp && p.b.stamp === stamp) { SPAIR[p.a.slot] = p.b.slot; SPAIR[p.b.slot] = p.a.slot; }
            }
        }
        const pn = settings.realistic;
        let tmin;
        if (pn && velOnly && pnList === list && pnN === n) {
            // Only the velocities changed: the Newtonian part stands, the 1PN pairs are worked out again
            for (let k = 0; k < n; k++) { PAX[k] = 0; PAY[k] = 0; }
            for (let q = 0; q < pnCount; q++) pnPair(PNI[q], PNJ[q]);
            for (let k = 0; k < n; k++) { SAX[k] = NAX[k] + PAX[k]; SAY[k] = NAY[k] + PAY[k]; }
            tmin = pnTmin;
        } else {
            pnCount = 0;
            if (pn) for (let k = 0; k < n; k++) { PAX[k] = 0; PAY[k] = 0; }
            tmin = useTree ? gravityTree(n, pn) : gravityDirect(n, pn);
            if (pn) {
                for (let k = 0; k < n; k++) { NAX[k] = SAX[k]; NAY[k] = SAY[k]; SAX[k] += PAX[k]; SAY[k] += PAY[k]; }
                pnList = list; pnN = n; pnTmin = tmin;
            }
        }
        const axs = SAX, ays = SAY;
        for (let k = 0; k < n; k++) { const b = list[k]; b.ax = axs[k]; b.ay = ays[k]; }
        return tmin;
    }

    // The 1PN acceleration of pair i, j (see above), added to PAX, PAY
    function pnPair(i, j) {
        const dx = SX[j] - SX[i], dy = SY[j] - SY[i];
        const r2 = dx * dx + dy * dy, r = Math.sqrt(r2);
        const mi = SM[i], mj = SM[j], msum = mi + mj;
        const gm = G * msum, eta = (mi * mj) / (msum * msum);
        const nx = -dx / r, ny = -dy / r;
        const vx = SVX[i] - SVX[j], vy = SVY[i] - SVY[j];
        const rd = nx * vx + ny * vy, v2 = vx * vx + vy * vy;
        const f = gm / (C2 * r2);
        const A = f * ((4 + 2 * eta) * gm / r - (1 + 3 * eta) * v2 + 1.5 * eta * rd * rd);
        const B = f * (4 - 2 * eta) * rd;
        const ax = A * nx + B * vx, ay = A * ny + B * vy;
        PAX[i] += (mj / msum) * ax; PAY[i] += (mj / msum) * ay;
        PAX[j] -= (mi / msum) * ax; PAY[j] -= (mi / msum) * ay;
    }

    // Note a pair that gets the 1PN correction (for the second kick)
    function notePN(i, j) {
        if (pnCount >= PNI.length) {
            const a = new Int32Array(2 * PNI.length), b = new Int32Array(2 * PNJ.length);
            a.set(PNI); b.set(PNJ); PNI = a; PNJ = b;
        }
        PNI[pnCount] = i; PNJ[pnCount] = j; pnCount++;
    }

    // Every pair, exactly. Besides the accelerations, each body's shortest and second-shortest pair
    // free-fall times (and the partner of the shortest) are kept, to find close pairs.
    function gravityDirect(n, pn) {
        for (let k = 0; k < n; k++) { SAX[k] = 0; SAY[k] = 0; SBEST[k] = Infinity; SSECOND[k] = Infinity; SPART[k] = -1; }
        work.pairs = (n * (n - 1)) / 2; work.tree = 0;
        return pairRows(null, n, n, pn);
    }

    // The exact pull of each pair, added both ways to accelerations already started. Rows: each body i
    // of rows[0..nRows) with every other body, each pair once (counting the rows in order); with no
    // rows, every pair i < j. Returns the shortest free-fall time squared of the pairs that set the
    // step (not the close pairs, which drift exactly).
    function pairRows(rows, nRows, n, pn) {
        // (local names for the arrays: a browser reads those much faster in a loop than outer variables)
        const xs = SX, ys = SY, ms = SM, grp = SGRP, accX = SAX, accY = SAY, best = SBEST, second = SSECOND, part = SPART;
        const inRows = SINDIR, rowOf = SDPOS;
        let tmin = Infinity;
        for (let a = 0; a < nRows; a++) {
            const i = rows ? rows[a] : a;
            const xi = xs[i], yi = ys[i], mi = ms[i], gi = grp[i], pi = SPAIR[i];
            let axi = accX[i], ayi = accY[i], b1 = best[i], b2 = second[i], p1 = part[i];
            for (let j = rows ? 0 : i + 1; j < n; j++) {
                if (rows && (j === i || (inRows[j] && rowOf[j] <= a))) continue;
                const dx = xs[j] - xi, dy = ys[j] - yi;
                const r2 = dx * dx + dy * dy;
                const mj = ms[j], msum = mi + mj;
                if (gi !== 0 && gi === grp[j]) {
                    // pieces of one torn-apart body: softened
                    const e = 0.5 * (SEPS[i] + SEPS[j]);
                    const s2 = r2 + e * e, s = Math.sqrt(s2), is3 = 1 / (s2 * s);
                    axi += G * mj * is3 * dx; ayi += G * mj * is3 * dy;
                    accX[j] -= G * mi * is3 * dx; accY[j] -= G * mi * is3 * dy;
                    if (msum > 0) {
                        const t = s2 * s / (G * msum);
                        if (SOFT_T2 * t < tmin) tmin = SOFT_T2 * t;
                        if (t < b2) { if (t < b1) { b2 = b1; b1 = t; p1 = -1; } else b2 = t; }
                        if (t < second[j]) { if (t < best[j]) { second[j] = best[j]; best[j] = t; part[j] = -1; } else second[j] = t; }
                    }
                    continue;
                }
                if (r2 === 0) continue;
                const r = Math.sqrt(r2);
                const ir3 = 1 / (r2 * r);
                const kep = pi === j;
                if (!kep) {
                    const si = G * mj * ir3, sj = G * mi * ir3;
                    axi += si * dx; ayi += si * dy;
                    accX[j] -= sj * dx; accY[j] -= sj * dy;
                }
                if (msum > 0) {
                    const t = r2 * r / (G * msum);
                    if (t < tmin && !kep) tmin = t;
                    // each body's two shortest pair times, and the partner of the shortest
                    if (t < b2) { if (t < b1) { b2 = b1; b1 = t; p1 = j; } else b2 = t; }
                    if (t < second[j]) { if (t < best[j]) { second[j] = best[j]; best[j] = t; part[j] = i; } else second[j] = t; }
                    if (pn) {
                        const vx = SVX[i] - SVX[j], vy = SVY[i] - SVY[j];
                        if ((G * msum) / (C2 * r) > PN_SKIP || (vx * vx + vy * vy) / C2 > PN_SKIP) { pnPair(i, j); notePN(i, j); }
                    }
                }
            }
            accX[i] = axi; accY[i] = ayi; best[i] = b1; second[i] = b2; part[i] = p1;
        }
        return tmin;
    }

    // ------------------------------------------------------------------
    // Barnes-Hut tree (2D quadtree) for many bodies. The light bodies are sorted into square cells, each
    // split into four until it holds at most LEAF_SIZE bodies; each cell keeps its mass, centre of mass and
    // quadrupole moment. A body feels a cell as a whole (its mass at its centre of mass, corrected by the
    // quadrupole for its shape) when the cell looks small from there: farther than its size / THETA plus
    // the distance between its centre of mass and its middle (so a body is never inside a cell it takes as
    // a whole); otherwise the cell is opened, down to single bodies, which pull exactly. With THETA = 0.5
    // and the quadrupole, the median error is a few parts in 10,000 of the swarm's own pull, and the big
    // pulls (from the heaviest bodies, done pair by pair) are exact.
    // Once a body's acceleration is known (from the last evaluation), a cell may also be taken whole
    // from closer (THETA_LOOSE) if its likely error, about G M s^2 / d^4 for a cell of mass M and size s,
    // is under ALPHA of that acceleration (the "relative" criterion of the GADGET-2 code). Asteroids
    // round the Sun then feel the rest of the swarm through a handful of cells (their pull on each other is
    // a billionth of the Sun's), while moonlets that crowd together still feel each other body by body.
    // The tree is rebuilt for every force evaluation, in flat typed arrays (no objects), and walked
    // without a stack: the cells are stored depth first, each with the index of the next cell after its
    // own subtree.
    // Relativity is left out between two light bodies: its size relative to their (already tiny) pull on
    // each other is GM/(rc^2) + v^2/c^2, so it changes the motion by a minute fraction of what the 1PN
    // terms of the heavy bodies (still included) do.
    // ------------------------------------------------------------------
    const THETA = 0.5, THETA_LOOSE = 1;
    const ALPHA = 2e-4;
    const LEAF_SIZE = 16;
    let tCap = 0, tCount = 0;
    let TCX, TCY, TM, TQXX, TQXY, TQYY, TOPEN, TOPEN1, TERR, TNEXT, TSTART, TEND;
    let BIDX = new Int32Array(0), BX = new Float64Array(0), BY = new Float64Array(0), BM = new Float64Array(0);
    // The tree's results per body: its pull, and the two largest (m + M) / d^3 with the partner of the first
    let CAX = new Float64Array(0), CAY = new Float64Array(0), CB1 = new Float64Array(0), CB2 = new Float64Array(0), CP1 = new Int32Array(0);
    let SINDIR = new Uint8Array(0);

    function growTreeCache(cap) {
        BIDX = new Int32Array(cap); BX = new Float64Array(cap); BY = new Float64Array(cap); BM = new Float64Array(cap);
        CAX = new Float64Array(cap); CAY = new Float64Array(cap); CB1 = new Float64Array(cap); CB2 = new Float64Array(cap);
        CP1 = new Int32Array(cap); SINDIR = new Uint8Array(cap);
    }

    function growTree() {
        const cap = Math.max(256, 2 * tCap);
        const grow = (a, T) => { const b = new T(cap); if (a) b.set(a); return b; };
        TCX = grow(TCX, Float64Array); TCY = grow(TCY, Float64Array); TM = grow(TM, Float64Array);
        TQXX = grow(TQXX, Float64Array); TQXY = grow(TQXY, Float64Array); TQYY = grow(TQYY, Float64Array);
        TOPEN = grow(TOPEN, Float64Array); TOPEN1 = grow(TOPEN1, Float64Array); TERR = grow(TERR, Float64Array);
        TNEXT = grow(TNEXT, Int32Array); TSTART = grow(TSTART, Int32Array); TEND = grow(TEND, Int32Array);
        tCap = cap;
    }

    // Move the bodies BIDX[start..end) with coordinate < c to the front; returns where the rest begin
    function partitionBodies(start, end, coord, c) {
        let i = start, j = end - 1;
        while (i <= j) {
            if (coord[BIDX[i]] < c) i++;
            else { const t = BIDX[i]; BIDX[i] = BIDX[j]; BIDX[j] = t; j--; }
        }
        return i;
    }

    // Build the cell for bodies BIDX[start..end) (square of half-width half centred on cx, cy); returns its index
    function buildCell(start, end, cx, cy, half, depth) {
        if (tCount >= tCap) growTree();
        const nd = tCount++;
        let M = 0, X = 0, Y = 0, qxx = 0, qxy = 0, qyy = 0;
        if (end - start <= LEAF_SIZE || depth >= 40) {
            TSTART[nd] = start; TEND[nd] = end;
            for (let s = start; s < end; s++) { const k = BIDX[s], m = SM[k]; M += m; X += m * SX[k]; Y += m * SY[k]; }
            if (M > 0) { X /= M; Y /= M; } else { X = cx; Y = cy; }
            for (let s = start; s < end; s++) {
                const k = BIDX[s], m = SM[k], dx = SX[k] - X, dy = SY[k] - Y;
                qxx += m * (2 * dx * dx - dy * dy); qyy += m * (2 * dy * dy - dx * dx); qxy += 3 * m * dx * dy;
            }
        } else {
            TSTART[nd] = start; TEND[nd] = -1;
            const mx = partitionBodies(start, end, SX, cx);
            const m1 = partitionBodies(start, mx, SY, cy), m2 = partitionBodies(mx, end, SY, cy);
            const h = 0.5 * half;
            if (m1 > start) buildCell(start, m1, cx - h, cy - h, h, depth + 1);
            if (mx > m1) buildCell(m1, mx, cx - h, cy + h, h, depth + 1);
            if (m2 > mx) buildCell(mx, m2, cx + h, cy - h, h, depth + 1);
            if (end > m2) buildCell(m2, end, cx + h, cy + h, h, depth + 1);
            // The children follow this cell, each followed by its own subtree
            const stop = tCount;
            for (let c = nd + 1; c < stop; c = TNEXT[c]) { const m = TM[c]; M += m; X += m * TCX[c]; Y += m * TCY[c]; }
            if (M > 0) { X /= M; Y /= M; } else { X = cx; Y = cy; }
            // Quadrupole about the new centre: the children's own plus that of their masses offset by d,
            // Q = sum m (3 d d - d^2 I) (in the plane: Qxx = m(2dx^2 - dy^2), Qxy = 3 m dx dy)
            for (let c = nd + 1; c < stop; c = TNEXT[c]) {
                const m = TM[c], dx = TCX[c] - X, dy = TCY[c] - Y;
                qxx += TQXX[c] + m * (2 * dx * dx - dy * dy); qyy += TQYY[c] + m * (2 * dy * dy - dx * dx); qxy += TQXY[c] + 3 * m * dx * dy;
            }
        }
        TM[nd] = M; TCX[nd] = X; TCY[nd] = Y; TQXX[nd] = qxx; TQXY[nd] = qxy; TQYY[nd] = qyy;
        const off = Math.hypot(X - cx, Y - cy), rOpen = (2 * half) / THETA + off, rLoose = (2 * half) / THETA_LOOSE + off;
        TOPEN[nd] = M > 0 ? rOpen * rOpen : -1;   // (a massless cell is never opened)
        TOPEN1[nd] = M > 0 ? rLoose * rLoose : -1;
        TERR[nd] = (G * M * 4 * half * half) / ALPHA;
        TNEXT[nd] = tCount;
        return nd;
    }

    // The pull of the tree on light body k: its acceleration and the two largest (m_k + M) / d^3 (for the
    // step and for close pairs) into the arrays above; returns the number of interactions.
    function walkTree(k) {
        // (local names for the arrays: a browser reads those much faster in a loop than outer variables)
        const tcx = TCX, tcy = TCY, tm = TM, tqxx = TQXX, tqxy = TQXY, tqyy = TQYY, topen = TOPEN, topen1 = TOPEN1, terr = TERR;
        const tnext = TNEXT, tstart = TSTART, tend = TEND, bidx = BIDX, bx = BX, by = BY, bm = BM, sgrp = SGRP, seps = SEPS;
        const xi = SX[k], yi = SY[k], mi = SM[k], gi = SGRP[k], ei = SEPS[k];
        const aOld = SA0[k];
        let ax = 0, ay = 0, k1 = 0, k2 = 0, p1 = -1, count = 0;
        let nd = 0;
        const end = tCount;
        while (nd < end) {
            const dx = tcx[nd] - xi, dy = tcy[nd] - yi;   // from the body to the cell's centre of mass
            const r2 = dx * dx + dy * dy;
            if (r2 > topen[nd] || (r2 > topen1[nd] && terr[nd] < aOld * r2 * r2)) {
                // The cell as a whole: a = G M d / d^3 + G [(5/2)(d.Q.d / d^2) d - Q.d] / d^5
                const M = tm[nd];
                if (!(M > 0)) { nd = tnext[nd]; continue; }
                const ir2 = 1 / r2, ir3 = Math.sqrt(ir2) * ir2, ir5 = ir3 * ir2;
                const qx = tqxx[nd] * dx + tqxy[nd] * dy, qy = tqxy[nd] * dx + tqyy[nd] * dy;
                const dqd = 2.5 * (dx * qx + dy * qy) * ir2;
                ax += G * (M * ir3 * dx + ir5 * (dqd * dx - qx));
                ay += G * (M * ir3 * dy + ir5 * (dqd * dy - qy));
                const kk = (mi + M) * ir3;
                if (kk > k1) { k2 = k1; k1 = kk; p1 = -1; } else if (kk > k2) k2 = kk;
                count++;
                nd = tnext[nd];
            } else if (tend[nd] >= 0) {
                for (let s = tstart[nd], e = tend[nd]; s < e; s++) {
                    const j = bidx[s];
                    if (j === k) continue;
                    const ddx = bx[s] - xi, ddy = by[s] - yi;
                    let d2 = ddx * ddx + ddy * ddy;
                    const soft = gi !== 0 && gi === sgrp[j];
                    if (soft) { const ee = 0.5 * (ei + seps[j]); d2 += ee * ee; } else if (d2 === 0) continue;
                    const id3 = 1 / (d2 * Math.sqrt(d2)), mj = bm[s];
                    ax += G * mj * id3 * ddx; ay += G * mj * id3 * ddy;
                    const kk = soft ? (mi + mj) * id3 / SOFT_T2 : (mi + mj) * id3;
                    if (kk > k1) { k2 = k1; k1 = kk; p1 = soft ? -1 : j; } else if (kk > k2) k2 = kk;
                    count++;
                }
                nd = tnext[nd];
            } else {
                nd++;
            }
        }
        CAX[k] = ax; CAY[k] = ay; CB1[k] = k1; CB2[k] = k2; CP1[k] = p1;
        return count;
    }

    function gravityTree(n, pn) {
        // The direct set: the heaviest bodies, kept in a short list sorted by mass, and close pairs
        let nd = 0;
        const hmax = Math.min(heavyMax, n);
        for (let i = 0; i < n; i++) {
            const m = SM[i];
            if (nd < hmax) { let p = nd++; while (p > 0 && SM[SDIR[p - 1]] < m) { SDIR[p] = SDIR[p - 1]; p--; } SDIR[p] = i; } else if (hmax > 0 && m > SM[SDIR[nd - 1]]) {
                let p = nd - 1;
                while (p > 0 && SM[SDIR[p - 1]] < m) { SDIR[p] = SDIR[p - 1]; p--; }
                SDIR[p] = i;
            }
        }
        SINDIR.fill(0, 0, n);
        for (let a = 0; a < nd; a++) SINDIR[SDIR[a]] = 1;
        for (let i = 0; i < n; i++) if (SPAIR[i] >= 0 && !SINDIR[i]) { SINDIR[i] = 1; SDIR[nd++] = i; }
        for (let a = 0; a < nd; a++) SDPOS[SDIR[a]] = a;
        // The light bodies' pulls on each other, from the tree
        let treeWork = 0;
        let nl = 0;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < n; i++) {
            if (SINDIR[i]) continue;
            BIDX[nl++] = i;
            const x = SX[i], y = SY[i];
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        tCount = 0;
        let kmax = 0;
        if (nl > 0) {
            const half = 0.5 * Math.max(x1 - x0, y1 - y0) * (1 + 1e-9) + 1e-300;
            buildCell(0, nl, 0.5 * (x0 + x1), 0.5 * (y0 + y1), half, 0);
            for (let s = 0; s < nl; s++) { const k = BIDX[s]; BX[s] = SX[k]; BY[s] = SY[k]; BM[s] = SM[k]; }
            for (let s = 0; s < nl; s++) {
                const k = BIDX[s];
                treeWork += walkTree(k);
                if (CB1[k] > kmax) kmax = CB1[k];
            }
        }
        const treeTmin = kmax > 0 ? 1 / (G * kmax) : Infinity;
        let tmin = treeTmin;
        for (let i = 0; i < n; i++) {
            SBEST[i] = Infinity; SSECOND[i] = Infinity; SPART[i] = -1;
            if (SINDIR[i]) { SAX[i] = 0; SAY[i] = 0; continue; }
            SAX[i] = CAX[i]; SAY[i] = CAY[i];
            if (CB1[i] > 0) { SBEST[i] = 1 / (G * CB1[i]); SPART[i] = CP1[i]; }
            if (CB2[i] > 0) SSECOND[i] = 1 / (G * CB2[i]);
        }
        // Every pair with a body of the direct set, exactly (each direct-direct pair once)
        work.pairs = nd * n - (nd * (nd + 1)) / 2;
        work.tree = treeWork;
        return Math.min(tmin, pairRows(SDIR, nd, n, pn));
    }

    // ------------------------------------------------------------------
    // Close pairs. With one step for everyone, a single close pair (a tight binary, a flyby at a few
    // planet radii, two stars swinging past each other) would force tiny steps on the whole system. So two
    // bodies that are each other's closest partner (shortest pair free-fall time), and much closer to each
    // other than to anything else (their pair time squared under KEP_GAMMA times that with any third body:
    // the others' tides on them are under a few per cent of their own pull), are moved by an exact
    // two-body (Kepler) drift instead of a straight line, and their own pull is left out of the kicks.
    // Everything else, including the third bodies' pull on them (and relativity), still acts through the
    // kicks. This is the Wisdom-Holman splitting, used in planetary and star-cluster codes: still
    // symplectic, time-reversible and 4th order in the Yoshida composition, but the step now only has to
    // follow the others (and turn the pair by at most a few degrees per step, KEP_TURN, so trails, the
    // flyby close-up and the swept areas stay smooth). A flyby therefore takes a few dozen steps however
    // close it gets. A pair that goes round faster than the trails are sampled (period under a quarter of
    // a sample) is stepped without that limit: its cost no longer grows with how tight it is.
    // Pairs where relativity matters (GM/(rc^2) above PN_PAIR_MAX) are left to the ordinary steps, which
    // follow the 1PN precession closely; so are pieces of one torn-apart body (softened, not Keplerian).
    // ------------------------------------------------------------------
    const KEP_GAMMA = 0.02;
    const KEP_TURN = 0.05;                // step <= KEP_TURN x sqrt(r^3 / GM): about 4 degrees of the pair's turn
    const KEP_UNRESOLVED = 0.25;          // periods under this many trail samples are not followed turn by turn
    const PN_PAIR_MAX = 1e-6;
    const mainPairs = [];                 // { a, b, touch, fast } for the bodies
    let mainStamp = 0, mainN = 0;

    // Universal-variable Kepler drift (Danby's G-functions): exact for ellipses, parabolas and hyperbolas,
    // forwards or backwards in time. Results in KX, KY, KVX, KVY; KMIN is the closest the two came.
    let SC0 = 1, SC1 = 1, SC2 = 0.5, SC3 = 1 / 6;
    function stumpff(z) {
        if (Math.abs(z) < 0.5) {
            SC3 = (1 - z / 20 * (1 - z / 42 * (1 - z / 72 * (1 - z / 110 * (1 - z / 156 * (1 - z / 210 * (1 - z / 272))))))) / 6;
            SC2 = (1 - z / 12 * (1 - z / 30 * (1 - z / 56 * (1 - z / 90 * (1 - z / 132 * (1 - z / 182 * (1 - z / 240))))))) / 2;
            SC1 = 1 - z * SC3;
            SC0 = 1 - z * SC2;
        } else if (z > 0) {
            const x = Math.sqrt(z);
            SC0 = Math.cos(x); SC1 = Math.sin(x) / x;
            SC2 = (1 - SC0) / z; SC3 = (1 - SC1) / z;
        } else {
            const x = Math.sqrt(-z);
            SC0 = Math.cosh(x); SC1 = Math.sinh(x) / x;
            SC2 = (1 - SC0) / z; SC3 = (1 - SC1) / z;
        }
    }

    let KX = 0, KY = 0, KVX = 0, KVY = 0, KMIN = 0, KR = 0;
    // Kepler's equation in universal variables, r0 G1(s) + eta G2(s) + mu G3(s) - tau (sets KR = r(s), its slope)
    function keplerF(s, r0, eta, mu, beta, tau) {
        stumpff(beta * s * s);
        const g1 = s * SC1, g2 = s * s * SC2;
        KR = r0 * SC0 + eta * g1 + mu * g2;
        return r0 * g1 + eta * g2 + mu * s * s * s * SC3 - tau;
    }

    function keplerDrift(rx, ry, vx, vy, mu, dt) {
        const r0 = Math.hypot(rx, ry);
        const eta = rx * vx + ry * vy;
        const beta = 2 * mu / r0 - (vx * vx + vy * vy);   // mu / a (negative for a hyperbola)
        let tau = dt, whole = false, s, lo, hi;
        if (beta > 0) {
            // An ellipse is only advanced by the part of dt left over after whole turns; one turn is
            // s = 2 pi / sqrt(beta), which brackets the answer
            const P = TAU * mu / (beta * Math.sqrt(beta));
            if (Math.abs(tau) >= P) { tau -= P * Math.trunc(tau / P); whole = true; }
            const sMax = TAU / Math.sqrt(beta);
            lo = tau >= 0 ? 0 : -sMax; hi = tau >= 0 ? sMax : 0;
            s = tau * beta / mu;
        } else {
            // A parabola or hyperbola: start from the shorter of the near and the far-out estimates, then
            // widen the open end of the bracket until it holds the answer
            const at = Math.abs(tau);
            s = at / r0;
            if (beta < 0) { const nb = Math.sqrt(-beta); s = Math.min(s, Math.log(1 + 2 * at * (-beta) * nb / mu) / nb); } else s = Math.min(s, Math.cbrt(6 * at / mu));
            if (tau < 0) s = -s;
            lo = tau >= 0 ? 0 : s; hi = tau >= 0 ? s : 0;
            if (tau >= 0) { while (!(keplerF(hi, r0, eta, mu, beta, tau) >= 0)) { lo = hi; hi = 2 * hi + 1e-300; } } else { while (!(keplerF(lo, r0, eta, mu, beta, tau) <= 0)) { hi = lo; lo = 2 * lo - 1e-300; } }
        }
        if (!(s >= lo && s <= hi)) s = 0.5 * (lo + hi);
        // Kepler's equation rises steadily with s (its slope is the distance r > 0): Laguerre-Conway
        // steps (which converge from rough starts in a few steps), falling back on bisection
        for (let it = 0; it < 60; it++) {
            const F = keplerF(s, r0, eta, mu, beta, tau);
            if (F === 0) break;
            if (F < 0) lo = s; else hi = s;
            const d2F = eta * SC0 + (mu - beta * r0) * s * SC1;
            let next = s - 5 * F / (KR + Math.sqrt(Math.abs(16 * KR * KR - 20 * F * d2F)));
            if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
            const ds = next - s;
            s = next;
            if (Math.abs(ds) <= 2e-15 * Math.abs(s) || !(hi - lo > 2e-15 * Math.abs(s))) break;
        }
        stumpff(beta * s * s);
        const g1 = s * SC1, g2 = s * s * SC2;
        const r = r0 * SC0 + eta * g1 + mu * g2;
        const f = 1 - mu * g2 / r0, g = r0 * g1 + eta * g2;
        const fd = -mu * g1 / (r0 * r), gd = 1 - mu * g2 / r;
        KX = f * rx + g * vx; KY = f * ry + g * vy;
        KVX = fd * rx + gd * vx; KVY = fd * ry + gd * vy;
        // Closest approach: the pericentre if it was passed, otherwise one of the ends
        const eta1 = KX * KVX + KY * KVY;
        KMIN = Math.min(r0, r);
        if (whole || (dt > 0 ? eta < 0 && eta1 >= 0 : eta > 0 && eta1 <= 0)) {
            const h = rx * vy - ry * vx, p = h * h / mu;
            const e = Math.sqrt(Math.max(0, 1 - p * beta / mu));
            KMIN = Math.min(KMIN, p / (1 + e));
        }
    }

    // Move a close pair: its centre of mass in a straight line, the two round each other exactly. The
    // heavier body is placed from the centre of mass and the lighter one from it by the exact separation
    // (placing both from the centre of mass would scale their separation by the rounding error of
    // m1/M + m2/M, which is not quite 1, every step: a slow, steady drift in the pair's energy).
    function driftPair(p, dt) {
        const h = p.a.m >= p.b.m ? p.a : p.b, l = h === p.a ? p.b : p.a;
        const M = h.m + l.m, fl = l.m / M, fh = 1 - fl;
        const cvx = fh * h.vx + fl * l.vx, cvy = fh * h.vy + fl * l.vy;
        const cx = fh * h.x + fl * l.x + dt * cvx, cy = fh * h.y + fl * l.y + dt * cvy;
        keplerDrift(l.x - h.x, l.y - h.y, l.vx - h.vx, l.vy - h.vy, G * M, dt);
        h.x = cx - fl * KX; h.y = cy - fl * KY; h.vx = cvx - fl * KVX; h.vy = cvy - fl * KVY;
        l.x = h.x + KX; l.y = h.y + KY; l.vx = h.vx + KVX; l.vy = h.vy + KVY;
        if (KMIN < (h.R + l.R) / AU_KM) p.touch = true;
    }

    // Can a and b be followed as a close pair? (gamma: how weakly the others must disturb them; read
    // from the packed shortest pair times of the last evaluation of the bodies' forces)
    function pairQualifies(a, b, gamma) {
        if (a.stamp !== mainStamp || b.stamp !== mainStamp) return false;
        const i = a.slot, j = b.slot;
        if (SPART[i] !== j || SPART[j] !== i) return false;
        if (a.held || b.held || (a.grp && a.grp === b.grp) || !(a.m > 0 && b.m > 0)) return false;
        if (!(SBEST[i] < gamma * SSECOND[i] && SBEST[j] < gamma * SSECOND[j])) return false;
        if (settings.realistic && G * (a.m + b.m) / (C2 * Math.hypot(b.x - a.x, b.y - a.y)) > PN_PAIR_MAX) return false;
        return true;
    }

    // Update the close pairs from the last force evaluation (at a step boundary). Pairs end with some
    // hysteresis, so one near the limit doesn't flicker. Returns true if they changed.
    function choosePairs() {
        // (refreshed if the packed numbers are a prediction's, or the bodies changed since)
        if (gravStamp !== mainStamp || bodies.length !== mainN) computeForces();
        let changed = false;
        for (let k = mainPairs.length - 1; k >= 0; k--) {
            const p = mainPairs[k];
            if (!pairQualifies(p.a, p.b, 2 * KEP_GAMMA)) { mainPairs.splice(k, 1); changed = true; }
        }
        const n = bodies.length;
        for (let k = 0; k < n; k++) bodies[k].kep = null;
        for (const p of mainPairs) { p.a.kep = p; p.b.kep = p; }
        for (let k = 0; k < n; k++) {
            const j = SPART[k];
            if (j <= k || SPART[j] !== k) continue;
            const a = bodies[k], b = bodies[j];
            if (a.kep || b.kep || !pairQualifies(a, b, KEP_GAMMA)) continue;
            const p = { a, b, touch: false, fast: false };
            mainPairs.push(p);
            a.kep = p; b.kep = p;
            changed = true;
        }
        return changed;
    }

    function refreshPairs() {
        if (choosePairs()) computeForces();
    }

    // Accelerations of the bodies, net forces for the arrows, and the next adaptive step.
    function computeForces(velOnly) {
        const tmin = gravity(bodies, mainPairs, velOnly);
        mainStamp = gravStamp; mainN = bodies.length;
        const n = bodies.length;
        for (let k = 0; k < n; k++) { const b = bodies[k]; b.fx = b.m * b.ax; b.fy = b.m * b.ay; }
        let dt = (n > DIRECT_MAX ? ETA_SWARM : ETA) * Math.sqrt(tmin);
        for (const p of mainPairs) dt = Math.min(dt, pairStepLimit(p));
        nextDt = Math.min(dt, sampleDt);
        forcesDirty = false;
    }

    // A close pair: add its own pull to the force arrows (it is left out of the accelerations), and the
    // longest step that keeps its turn per step small (none for one too fast to follow)
    function pairStepLimit(p) {
        const a = p.a, b = p.b;
        if (a.stamp !== mainStamp || b.stamp !== mainStamp) return Infinity;
        const rx = b.x - a.x, ry = b.y - a.y, r2 = rx * rx + ry * ry, r = Math.sqrt(r2);
        const f = G * a.m * b.m / (r2 * r);
        a.fx += f * rx; a.fy += f * ry; b.fx -= f * rx; b.fy -= f * ry;
        const gm = G * (a.m + b.m);
        const vx = b.vx - a.vx, vy = b.vy - a.vy;
        const beta = 2 * gm / r - (vx * vx + vy * vy);
        p.fast = beta > 0 && TAU * gm / (beta * Math.sqrt(beta)) < KEP_UNRESOLVED * sampleDt;
        return p.fast ? Infinity : KEP_TURN * Math.sqrt(r2 * r / gm);
    }

    // One kick-drift-kick leapfrog step for every body in the list that isn't held (close pairs drift
    // round each other exactly). The 1PN force depends on the velocities too, so with realistic physics
    // the second kick is done twice: with the forces at the half-step velocities, then again with those
    // at the velocities that gave.
    function leapfrog(list, dt, forces, pairs) {
        const h = 0.5 * dt;
        for (const b of list) {
            if (b.held) continue;
            b.vx += h * b.ax; b.vy += h * b.ay;
            if (!(pairs && b.kep)) { b.x += dt * b.vx; b.y += dt * b.vy; }
        }
        if (pairs) for (const p of pairs) driftPair(p, dt);
        let tmin = forces();
        for (const b of list) {
            if (b.held) continue;
            b.hx = b.vx; b.hy = b.vy;
            b.vx += h * b.ax; b.vy += h * b.ay;
        }
        if (settings.realistic) {
            tmin = forces(true);
            for (const b of list) {
                if (b.held) continue;
                b.vx = b.hx + h * b.ax; b.vy = b.hy + h * b.ay;
            }
        }
        return tmin;
    }

    // One 4th-order step: leapfrog steps of w1 dt, w0 dt (backwards: w0 < 0) and w1 dt.
    function yoshida(list, dt, forces, pairs) {
        leapfrog(list, YOSHIDA_W1 * dt, forces, pairs);
        leapfrog(list, YOSHIDA_W0 * dt, forces, pairs);
        return leapfrog(list, YOSHIDA_W1 * dt, forces, pairs);
    }

    function step(dt) {
        for (const b of bodies) { b.px = b.x; b.py = b.y; }
        for (const p of mainPairs) p.touch = false;
        yoshida(bodies, dt, computeForces, mainPairs);
    }

    // Bodies whose real radii touched during the last step (closest approach along the straight
    // path between the old and new positions, or along their exact orbit for a close pair) merge into
    // one, conserving mass and momentum. Only pairs whose boxes round their paths overlap are tested
    // (sort and sweep: the boxes stay sorted by their left edges from step to step, so re-sorting them
    // takes little more than one pass), and of those touching, the first in the list merges first, as
    // when every pair was tested in turn.
    let sweepOrder = new Int32Array(0);
    let SWLX = new Float64Array(0), SWHX = new Float64Array(0), SWLY = new Float64Array(0), SWHY = new Float64Array(0);
    let contactA = null, contactB = null;

    function touching(a, b) {
        if (a.held || b.held || (a.grp && a.grp === b.grp)) return false;
        if (a.kep && a.kep === b.kep) return a.kep.touch;
        const reach = (a.R + b.R) / AU_KM;
        const x0 = b.px - a.px, y0 = b.py - a.py;
        const x1 = b.x - a.x, y1 = b.y - a.y;
        const ex = x1 - x0, ey = y1 - y0;
        const ee = ex * ex + ey * ey;
        const t = ee > 0 ? clamp(-(x0 * ex + y0 * ey) / ee, 0, 1) : 1;
        const cx = x0 + t * ex, cy = y0 + t * ey;
        return cx * cx + cy * cy < reach * reach;
    }

    function firstContact() {
        const n = bodies.length;
        contactA = contactB = null;
        if (n < 2) return false;
        if (SWLX.length < n) {
            const cap = Math.max(64, 2 * n);
            SWLX = new Float64Array(cap); SWHX = new Float64Array(cap); SWLY = new Float64Array(cap); SWHY = new Float64Array(cap);
        }
        for (let k = 0; k < n; k++) {
            const b = bodies[k], reach = b.R / AU_KM;
            const x0 = b.px, x1 = b.x, y0 = b.py, y1 = b.y;
            SWLX[k] = (x0 < x1 ? x0 : x1) - reach; SWHX[k] = (x0 < x1 ? x1 : x0) + reach;
            SWLY[k] = (y0 < y1 ? y0 : y1) - reach; SWHY[k] = (y0 < y1 ? y1 : y0) + reach;
        }
        if (sweepOrder.length !== n) {
            const order = Array.from({ length: n }, (_, i) => i);
            order.sort((p, q) => SWLX[p] - SWLX[q]);
            sweepOrder = Int32Array.from(order);
        } else {
            for (let a = 1; a < n; a++) {
                const i = sweepOrder[a], key = SWLX[i];
                let c = a - 1;
                while (c >= 0 && SWLX[sweepOrder[c]] > key) { sweepOrder[c + 1] = sweepOrder[c]; c--; }
                sweepOrder[c + 1] = i;
            }
        }
        let bi = n, bj = n;
        for (let a = 0; a < n; a++) {
            const i = sweepOrder[a], hx = SWHX[i], ly = SWLY[i], hy = SWHY[i];
            for (let c = a + 1; c < n; c++) {
                const j = sweepOrder[c];
                if (SWLX[j] > hx) break;
                if (SWLY[j] > hy || SWHY[j] < ly) continue;
                const lo = i < j ? i : j, hi = i < j ? j : i;
                if (lo > bi || (lo === bi && hi >= bj)) continue;
                if (touching(bodies[lo], bodies[hi])) { bi = lo; bj = hi; }
            }
        }
        // A close pair can touch at its pericentre between the ends of a step
        for (const p of mainPairs) {
            if (!p.touch) continue;
            const i = bodies.indexOf(p.a), j = bodies.indexOf(p.b);
            if (i < 0 || j < 0) continue;
            const lo = Math.min(i, j), hi = Math.max(i, j);
            if (lo < bi || (lo === bi && hi < bj)) { bi = lo; bj = hi; }
        }
        if (bi >= n) return false;
        contactA = bodies[bi]; contactB = bodies[bj];
        return true;
    }

    function checkMerges() {
        if (!settings.merge) return false;
        let merged = false;
        while (firstContact()) {
            const a = contactA, b = contactB;
            if (a.kep) a.kep.touch = false;
            mergeBodies(a, b);
            merged = true;
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
        // (a small flash for two bodies of a swarm: in a disc of moonlets they merge by the hundred)
        flashes.push({ x: fx, y: fy, t: performance.now(), color: big.color, r0: drawRadius(big), grow: big.minor && small.minor ? 8 : 30 });
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
    // pass was close enough about half escape. The fragments pull on each other (softened, see above)
    // and on everything else, so self-gravity can gather some of the stream into clumps, as in
    // simulations of real disruptions. They don't merge with each other: they start overlapping (parts of
    // one fluid body), and streams of gas that meet pass through each other rather than sticking like
    // solid bodies; they can still merge with anything else, or fall into the black hole.
    // In a crowded scene only the heaviest few bodies are tried as the heavy partner (bodies outside them
    // are light swarm bodies, whose Roche limits round each other are barely bigger than their own sizes,
    // so they merge rather than tear).
    // ------------------------------------------------------------------
    const ROCHE = 2.44;
    const FRAGMENTS = 9;
    const tideHeavy = [];
    // What the books gain at the break-up, which a whole body (a point) didn't have in them: mostly the
    // pieces' pull on each other (the binding energy that held it together), and the extra tidal energy of
    // pieces spread along the line to the heavy body (a few tenths of a per cent of the orbit's energy).
    // It is kept here (by the torn-apart body's id) and taken off the energy, so the total stays level
    // through a disruption.
    const groupEnergy = new Map();

    function checkTides() {
        if (!settings.realistic) return false;
        let hs = bodies;
        if (bodies.length > SWARM_N) {
            tideHeavy.length = 0;
            for (const b of bodies) {
                if (tideHeavy.length < HEAVY_MAX) { tideHeavy.push(b); continue; }
                let lo = 0;
                for (let k = 1; k < tideHeavy.length; k++) if (tideHeavy[k].m < tideHeavy[lo].m) lo = k;
                if (b.m > tideHeavy[lo].m) tideHeavy[lo] = b;
            }
            hs = tideHeavy;
        }
        for (const L of bodies) {
            if (L.grp || L.held || isCompact(L) || L.m < 1e-17) continue;   // not probes: they are held together by their structure
            for (const H of hs) {
                if (H === L || H.held || H.m < 5 * L.m) continue;
                const dx = L.x - H.x, dy = L.y - H.y;
                const d = Math.hypot(dx, dy);
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
        const before = systemEnergy().total;
        bodies.push(...parts);
        removeBody(L, parts[(n - 1) >> 1]);   // the view and the readouts pass to the middle piece
        groupEnergy.set(L.id, 0);
        groupEnergy.set(L.id, systemEnergy().total - before);
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

    // Advance the simulation by simDt years (as many whole adaptive steps as fit). In the animation the
    // physics gets a share of each frame's time (budgetMs, checked on the clock every few steps): if the
    // steps still owed don't fit, the simulation slows down for this frame rather than take bigger steps.
    // maxSteps (for tests) caps the steps instead, with no clock.
    let lastAdvance = { steps: 0, timedOut: false };
    function advance(simDt, maxSteps, budgetMs) {
        noteRun();   // (edit history: the first run after a change)
        if (forcesDirty) computeForces();
        acc += simDt;
        let steps = 0;
        const t0 = maxSteps ? 0 : performance.now();
        const budget = budgetMs || PHYSICS_MS;
        const every = bodies.length > 60 ? 1 : 8;
        let timedOut = false;
        while (!maxSteps || steps < maxSteps) {
            refreshPairs();
            const dt = nextDt;
            if (!(dt > 0) || acc < dt) break;
            // (stop if the next step, at the average cost so far, would overrun the budget)
            if (!maxSteps && steps % every === 0 && steps > 0) {
                const used = performance.now() - t0;
                if (used + used / steps > budget) { timedOut = true; break; }
            }
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
        slowedDown = timedOut || (!!maxSteps && steps >= maxSteps);
        if (slowedDown) acc = 0;   // couldn't keep up: slow down rather than take bigger steps
        lastAdvance.steps = steps; lastAdvance.timedOut = timedOut;
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
    // Pieces of one torn-apart body count each other's softened pull (as in gravity), so a clump that
    // gathers again by its own gravity shows as pieces orbiting each other.
    // In a crowded scene only the PRIMARY_MAX heaviest bodies are candidates (a light swarm body can't
    // keep another in orbit for long), which keeps this quick for hundreds of bodies. The light bodies of
    // a crowded scene (or one made as a swarm) are also marked minor: drawn as simple dots, without
    // names, arrows or long trails, unless chosen. A body stays a full one if it is among the NAMED_MAX
    // heaviest and either at least 30 times the typical (median) mass, like a planet among asteroids, or
    // at least a thousandth of the heaviest, like a moon grown from a disc of moonlets.
    const PRIMARY_MAX = 32;
    const NAMED_MAX = 12;
    const primOrder = [];
    function computePrimaries() {
        primOrder.length = 0;
        for (const b of bodies) primOrder.push(b);
        const order = primOrder.sort((a, b) => b.m - a.m || a.id - b.id);
        const crowded = order.length > SWARM_N || !!scene.swarm;
        const typical = crowded ? 30 * order[order.length >> 1].m : 0, notable = crowded ? 1e-3 * order[0].m : 0;
        for (let i = 0; i < order.length; i++) {
            const b = order[i];
            b.primary = null; b.bound = false; b.hill = Infinity;
            b.minor = crowded && (i >= NAMED_MAX || (b.m < typical && b.m < notable));
        }
        for (let i = 1; i < order.length; i++) {
            const b = order[i];
            let best = null, bestA = Infinity, pull = null, pullMax = -1;
            const jmax = Math.min(i, PRIMARY_MAX);
            for (let j = 0; j < jmax; j++) {
                const p = order[j];
                const rx = b.x - p.x, ry = b.y - p.y;
                const r2 = rx * rx + ry * ry;
                if (r2 === 0) continue;
                let s2 = r2;
                if (b.grp && b.grp === p.grp) { const e = 0.5 * (softLength(b) + softLength(p)); s2 += e * e; }
                const g = p.m / s2;
                if (g > pullMax) { pullMax = g; pull = p; }
                if (r2 > p.hill * p.hill) continue;
                const mu = G * (b.m + p.m);
                const vx = b.vx - p.vx, vy = b.vy - p.vy;
                const energy = 0.5 * (vx * vx + vy * vy) - mu / Math.sqrt(s2);
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
            if (!p || !b.bound || b.held || p.held || (b.minor && b.id !== selectedId) || (b.kep && b.kep.fast)) { b.track = null; continue; }
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
        // (not for a close pair going round faster than the steps: its turns can't be followed)
        if (!settings.k2 || !b || !p || b.held || p.held || (b.kep && b.kep.fast)) { k2.bid = null; return; }
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
            let T = b.trail;
            if (!T) T = b.trail = new Float64Array(2 * (b.minor ? SWARM_TRAIL : TRAIL_CAP));
            const i = 2 * (sampleCount % (T.length >> 1));
            T[i] = b.x;
            T[i + 1] = b.y;
        }
        sampleCount++;
        lastSampleT = simTime;
    }

    // Where sample k of a body's trail is kept (trails of different lengths share the sample numbers)
    const trailIndex = (T, k) => 2 * (k % (T.length >> 1));
    // The oldest sample still kept in a trail
    const trailFirst = (b) => (b.trail ? Math.max(b.trailStart, sampleCount - (b.trail.length >> 1) + 1) : sampleCount);

    function trailBending() {
        if (!sampleCount) return false;
        const k = sampleCount - 1;
        for (const b of bodies) {
            const p = b.primary;
            if (!p || b.minor || b.held || p.held || !b.trail || !p.trail || trailFirst(b) > k || trailFirst(p) > k) continue;
            const ib = trailIndex(b.trail, k), ip = trailIndex(p.trail, k);
            const rx = b.x - p.x, ry = b.y - p.y;
            const ox = b.trail[ib] - p.trail[ip], oy = b.trail[ib + 1] - p.trail[ip + 1];
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
        mainPairs.length = 0;
        groupEnergy.clear();
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
        if (turn.on) { const P = turnPair(); if (P) return pairCentre(P, true); }   // (a rotating frame: the pair's centre)
        const L = frameId !== null ? bodyById(frameId) : null;
        if (L) return { x: L.dx, y: L.dy };
        let M = 0, X = 0, Y = 0;
        for (const b of bodies) { M += b.m; X += b.m * b.dx; Y += b.m * b.dy; }
        return M > 0 ? { x: X / M, y: Y / M } : { x: 0, y: 0 };
    }

    // (x, y): where, in a rotating frame, whose velocity depends on the place (see turnVelocityAt)
    function frameVelocity(x, y) {
        if (turn.on) { const v = turnVelocityAt(x, y); if (v) return v; }
        const L = frameId !== null ? bodyById(frameId) : null;
        if (L) return { x: L.vx, y: L.vy };
        const c = totals(bodies);
        return { x: c.vx, y: c.vy };
    }

    function updateDrawnPositions() {
        for (const b of bodies) {
            if (b.held) { b.dx = b.x; b.dy = b.y; continue; }
            // (a close pair going round faster than one step is drawn moving with its centre of mass)
            const p = b.kep && b.kep.fast ? b.kep : null;
            const M = p ? p.a.m + p.b.m : 0;
            const vx = p ? (p.a.m * p.a.vx + p.b.m * p.b.vx) / M : b.vx, vy = p ? (p.a.m * p.a.vy + p.b.m * p.b.vy) / M : b.vy;
            b.dx = b.x + vx * lag; b.dy = b.y + vy * lag;
        }
        F = freeze ? { x: freeze.x, y: freeze.y } : liveFrameOrigin();
        turnDrawnPositions();   // (a rotating frame turns them about F: see "Rotating frame")
        // A held body stays exactly where it is held in the view
        for (const b of bodies) {
            if (b.held) { b.dx = F.x + b.held.offX; b.dy = F.y + b.held.offY; }
        }
    }

    // The frame origin from the integrator's positions (no extrapolation)
    function stateFrameOrigin() {
        if (freeze) return { x: freeze.x, y: freeze.y };
        if (turn.on) { const P = turnPair(); if (P) return pairCentre(P, false); }
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
    // A torn-apart body's pieces are small, and so are the light bodies of a swarm
    const MINOR_SIZE = 2;
    const bodySize = (b) => (b.grp ? 3.5 : b.minor ? MINOR_SIZE : symbolicSize(b.kind, b.m, b.R));

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
            if (!p || !b.bound || b.m >= p.m || b.minor) continue;
            const d = Math.hypot(b.dx - p.dx, b.dy - p.dy) * scale;
            p.rmax = Math.min(p.rmax, 0.45 * d);
            b.rmax = Math.min(b.rmax, 0.3 * d);
        }
        for (const b of bodies) b.rd = b.rh = Math.max(b.minor ? 1.2 : 3, b.rmax, (b.R / AU_KM) * scale);
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
                const el = turnedElements(elementsOf(b, b.primary));
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
        const before = viewOrigin();
        frameId = id !== null && bodyById(id) ? id : null;
        freeze = null;
        leaveTurning();   // (a rotating frame ends: the view glides back square)
        updateDrawnPositions();
        keepScreen(before);
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
        syncTurnUi();
    }

    // ------------------------------------------------------------------
    // Rotating frame
    //   "View from: Rotating with Jupiter and the Sun": the view turns with a body B and the body A it
    //   orbits, so both stand still. Their centre of mass is the frame's origin, and the line from A to B
    //   keeps one direction on the screen (turn.up: across, or upwards on a tall screen). The angle is
    //   the pair's angle at each moment, so on an elliptical orbit B slides in and out along that line
    //   (and the view turns faster while they are close, as Kepler's 2nd law says it must).
    //   frameId is B (so the "Viewed from" chip, and the room the overlays leave for it, work as for a
    //   body), turn.on is set and turn.aId is A.
    //   The whole picture goes through one turn about the frame's origin F: drawn = F + R(phi)(world - F).
    //   updateDrawnPositions turns the bodies' drawn positions (dx, dy) that way, so sx/sy/wx/wy stay a
    //   plain shift and scale between that drawn view and the screen. Anything that turns a screen point
    //   back into a world position (a drop, a drag) goes through unturnPoint, and world vectors drawn as
    //   arrows are turned by turn.c and turn.s. Trails are kept in world coordinates at shared times, so
    //   each sample is turned by the pair's angle at its own time, read from the pair's own trail
    //   samples. Velocity arrows show velocities relative to the turning view, v - (V + Omega x (r - C)),
    //   where V and C are the pair's centre-of-mass velocity and position and Omega how fast the pair
    //   turns; an arrow aimed in the view is turned back into the world the same way when it is let go.
    //   A sudden change of angle (switching frames, dropping one of the pair, an undo) goes into a turn
    //   that dies away (turnEase), so the view glides round instead of jumping, also on the way back to
    //   an ordinary frame (where phi is just that dying turn, and is 0 the rest of the time).
    // ------------------------------------------------------------------
    const TURN_REF = -1;          // a predicted path's refId when it was worked out in a rotating frame
    const TURN_EASE_S = 0.25;     // s: how quickly a sudden turn of the view dies away
    const turn = {
        on: false,
        aId: null, bId: null,     // the pair: B (also frameId) and the body A it orbits
        up: 0,                    // the screen direction of the line from A to B (radians anticlockwise)
        easeAmt: 0, easeT: 0,     // a turn that dies away, from time easeT (ms)
        theta: 0,                 // the pair's direction in the world this frame
        phi: 0, c: 1, s: 0,       // the view's turn this frame, and its cosine and sine
        alpha: 0,                 // phi + theta: turns coordinates along the pair (A to B along +x) into the view
        omega: 0,                 // how fast the pair turns (radians a year; negative: clockwise)
        options: '', optionsAt: 0 // the rotating frames last offered in "View from" (see syncTurnOptions)
    };
    Object.assign(ui, { turnNote: byId('turnNote') });

    const wrapAngle = (a) => a - TAU * Math.round(a / TAU);

    // The dying turn, now
    function turnEase() {
        if (!turn.easeAmt) return 0;
        const v = turn.easeAmt * Math.exp(-(performance.now() - turn.easeT) / (1000 * TURN_EASE_S));
        if (Math.abs(v) < 1e-4) { turn.easeAmt = 0; return 0; }
        return v;
    }
    function addEase(d) {
        turn.easeAmt = wrapAngle(turnEase() + d);
        turn.easeT = performance.now();
    }

    // The turning pair { A, B }, or null (not turning, or one of them has gone)
    function turnPair() {
        if (!turn.on) return null;
        // (B has merged into another body, which the view now follows as its heir: turn with that one)
        if (frameId !== turn.bId && frameId !== null && frameId !== turn.aId && !bodyById(turn.bId) && bodyById(frameId)) turn.bId = frameId;
        if (frameId !== turn.bId) return null;
        const A = bodyById(turn.aId), B = bodyById(turn.bId);
        return A && B ? { A, B } : null;
    }
    const turnBodies = () => { const P = turnPair(); return P ? [P.A, P.B] : []; };
    const turnUses = (b) => !!(b && turn.on && (b.id === turn.aId || b.id === turn.bId));
    // The body B goes round (if it is bound to one): the other half of a pair it can turn with
    const turnPartner = (b) => (b && !b.grp && b.bound && b.primary && b.primary !== b ? b.primary : null);

    // The pair's centre of mass, from the drawn (extrapolated) positions or the integrator's
    function pairCentre(P, drawn) {
        const M = P.A.m + P.B.m;
        return drawn ? { x: (P.A.m * P.A.dx + P.B.m * P.B.dx) / M, y: (P.A.m * P.A.dy + P.B.m * P.B.dy) / M }
            : { x: (P.A.m * P.A.x + P.B.m * P.B.x) / M, y: (P.A.m * P.A.y + P.B.m * P.B.y) / M };
    }

    // How fast the line from A to B turns (radians a year): the relative angular momentum over r^2
    function pairOmega(P) {
        const rx = P.B.x - P.A.x, ry = P.B.y - P.A.y, r2 = rx * rx + ry * ry;
        return r2 > 0 ? (rx * (P.B.vy - P.A.vy) - ry * (P.B.vx - P.A.vx)) / r2 : 0;
    }

    // The velocity of the rotating frame itself at world point (x, y): the pair's centre-of-mass
    // velocity plus Omega x (r - C); without a point, the centre of mass's alone
    function turnVelocityAt(x, y) {
        const P = turnPair();
        if (!P) return null;
        const M = P.A.m + P.B.m;
        const vx = (P.A.m * P.A.vx + P.B.m * P.B.vx) / M, vy = (P.A.m * P.A.vy + P.B.m * P.B.vy) / M;
        if (x === undefined || y === undefined) return { x: vx, y: vy };
        const c = pairCentre(P, false), w = pairOmega(P);
        return { x: vx - w * (y - c.y), y: vy + w * (x - c.x) };
    }

    // From updateDrawnPositions, once the drawn positions (still world positions, extrapolated) and the
    // origin F are known: this frame's turn, and every drawn position turned by it about F
    function turnDrawnPositions() {
        let phi = turnEase();
        if (turn.on) {
            const P = turnPair();
            if (!P) {
                stopTurning();
                phi = turnEase();
            } else {
                turn.theta = Math.atan2(P.B.dy - P.A.dy, P.B.dx - P.A.dx);
                turn.omega = pairOmega(P);
                phi += turn.up - turn.theta;
            }
        }
        if (freeze && freeze.phi !== undefined) phi = freeze.phi;   // (one of the pair is being dragged)
        phi = wrapAngle(phi);
        turn.phi = phi; turn.c = Math.cos(phi); turn.s = Math.sin(phi);
        turn.alpha = phi + (turn.on ? turn.theta : 0);
        if (!phi) return;
        const c = turn.c, s = turn.s;
        for (const b of bodies) {
            const x = b.dx - F.x, y = b.dy - F.y;
            b.dx = F.x + c * x - s * y;
            b.dy = F.y + s * x + c * y;
        }
    }

    // World vectors and points into the drawn view and back
    const turnVec = (x, y) => ({ x: turn.c * x - turn.s * y, y: turn.s * x + turn.c * y });
    const unturnVec = (x, y) => ({ x: turn.c * x + turn.s * y, y: -turn.s * x + turn.c * y });
    function turnPoint(x, y) { const v = turnVec(x - F.x, y - F.y); return { x: F.x + v.x, y: F.y + v.y }; }
    function unturnPoint(x, y) { const v = unturnVec(x - F.x, y - F.y); return { x: F.x + v.x, y: F.y + v.y }; }

    // Where the frame's origin is and how far the view is turned, taken before a change (see keepScreen)
    const viewOrigin = () => ({ x: F.x, y: F.y, phi: turn.phi });
    // After a change that moved the frame's origin or turned the view (drawn positions already worked
    // out again): keep everything on the screen where it was. The pan takes up the move, turned as the
    // view is; the turn goes into the dying turn, so the view then glides round to its new angle.
    function keepScreen(before) {
        const d = before.phi !== undefined ? wrapAngle(before.phi - turn.phi) : 0;
        if (Math.abs(d) > 1e-9) { addEase(d); updateDrawnPositions(); }
        const v = turnVec(before.x - F.x, before.y - F.y);
        view.panX += v.x;
        view.panY += v.y;
    }

    // View from a rotating frame turning with B and A (by default the body B orbits)
    function startTurning(B, A) {
        A = A || turnPartner(B);
        if (!B || !A || A === B) return false;
        updateDrawnPositions();
        const before = viewOrigin();
        frameId = B.id;
        freeze = null;
        Object.assign(turn, { on: true, aId: A.id, bId: B.id, up: viewH > 1.15 * viewW ? Math.PI / 2 : 0 });
        updateDrawnPositions();
        keepScreen(before);
        view.anim = { zoom: view.anim ? view.anim.zoom : view.zoom, panX: 0, panY: 0 };
        pred.key = '';
        markPreview();
        syncFrameUi();
        updatePopover(true);
        historyNote(`<strong>Rotating with ${escapeHtml(theName(B))} and ${escapeHtml(theName(A))}:</strong> the view turns with them, so both stand still. Arrows show velocities in this turning view.`);
        return true;
    }

    // Choosing any other frame ends a rotating one (setFrame keeps the screen still; the turn glides off)
    function leaveTurning() {
        if (!turn.on) return;
        Object.assign(turn, { on: false, aId: null, bId: null });
        pred.key = '';
        markPreview();
    }

    // One of the pair has gone (deleted, swallowed by the other, a new scene): an ordinary frame again, gliding square
    // from where the view was, unless both have gone (a new scene), which simply starts square
    function stopTurning() {
        const gone = !bodyById(turn.aId) && !bodyById(turn.bId);
        leaveTurning();
        turn.easeAmt = gone ? 0 : wrapAngle(turn.phi);
        turn.easeT = performance.now();
        syncFrameUi();
    }

    // "View from": a rotating frame's option is turn:<id of B>
    function pickTurning(value) {
        const m = /^turn:(\d+)$/.exec(value || '');
        if (!m) return false;
        if (!startTurning(bodyById(parseInt(m[1], 10)))) syncFrameUi();   // (no longer possible: show the frame as it is)
        return true;
    }

    // Which body the list offers to turn with: the chosen one if it orbits something, else the heaviest
    // body that orbits a heavier one (Jupiter in the Trojans scene, even with the Sun chosen)
    function turnCandidate() {
        const s = bodyById(selectedId);
        if (turnPartner(s)) return s;
        let best = null;
        for (const b of bodies) {
            const p = turnPartner(b);
            if (p && !b.minor && b.m <= p.m && (!best || b.m > best.m)) best = b;
        }
        return best;
    }
    const turnLabel = (B, A) => `Rotating with ${theName(B)} and ${theName(A)}`;

    // The rotating frames in "View from" (after the bodies): the one in use, and the chosen body's
    function turnOptions() {
        const out = [];
        const P = turnPair();
        if (P) out.push([`turn:${P.B.id}`, turnLabel(P.B, P.A)]);
        const c = turnCandidate();
        if (c && !(P && c === P.B)) out.push([`turn:${c.id}`, turnLabel(c, turnPartner(c))]);
        return out;
    }
    // Choosing another body changes what is offered (checked a few times a second while drawing)
    function syncTurnOptions() {
        const now = performance.now();
        if (now < turn.optionsAt) return;
        turn.optionsAt = now + 300;
        const sig = turnOptions().map((o) => o.join('=')).join('|');
        if (sig !== turn.options) { turn.options = sig; refreshBodyLists(); }
    }

    // The list, the chip ("Rotating with Jupiter and the Sun") and the note under the list
    function syncTurnUi() {
        const P = turnPair();
        if (ui.frame && P) ui.frame.value = `turn:${P.B.id}`;
        if (ui.frameChip && ui.frameChipName) {
            const lead = ui.frameChipName.previousSibling;
            const text = P ? 'Rotating with ' : 'Viewed from ';
            if (lead && lead.nodeType === 3 && lead.nodeValue !== text) lead.nodeValue = text;
            if (P) ui.frameChipName.textContent = theName(P.B);   // (short: the list names the pair)
        }
        if (ui.turnNote) {
            ui.turnNote.hidden = !P;
            if (P) {
                const el = elementsOf(P.B, P.A);
                const ecc = el && el.bound && el.e > 0.03 ? ` Its orbit is an ellipse, so ${theName(P.B)} slides in and out.` : '';
                setText(ui.turnNote, `The view turns with ${theName(P.B)} round ${theName(P.A)}, so both stand still. Arrows show velocities in this turning view.${ecc}`);
            }
        }
    }

    // A body's velocity as drawn: relative to the turning view (minus the frame's own velocity where the
    // body is), or in an ordinary frame relative to fv; turned as the view is
    function viewVelocity(b, fv) {
        const u = turn.on ? frameVelocity(b.x, b.y) : fv;
        return turnVec(b.vx - u.x, b.vy - u.y);
    }

    // An arrow grabbed in a turned view is aimed as drawn (its numbers are along the view's directions,
    // so it stays put on the screen while the view turns); aimedVelocity turns it back into the world,
    // on top of the frame's own velocity where the body is (aimBase)
    function turnAim(a) {
        if (!turn.on && !turn.phi) return;
        const v = turnVec(a.vx, a.vy);
        a.vx = v.x; a.vy = v.y; a.turn = true;
    }
    function aimedVelocity(b) {
        const a = b.aim, base = aimBase(b);
        const v = a.turn ? unturnVec(a.vx, a.vy) : { x: a.vx, y: a.vy };
        return { x: base.x + v.x, y: base.y + v.y };
    }
    function setAimedVelocity(b, vx, vy) {
        const a = b.aim, base = aimBase(b);
        const v = a.turn ? turnVec(vx - base.x, vy - base.y) : { x: vx - base.x, y: vy - base.y };
        a.vx = v.x; a.vy = v.y;
    }

    // Orbit elements, and lists of world offsets, turned as the view is
    function turnedElements(el) {
        return el && turn.phi ? Object.assign({}, el, { w: el.w + turn.phi }) : el;
    }
    function turnedPoints(pts, angle) {
        const a = angle === undefined ? turn.phi : angle;
        if (!a) return pts;
        const c = Math.cos(a), s = Math.sin(a), out = new Array(pts.length);
        for (let i = 0; i + 1 < pts.length; i += 2) {
            out[i] = c * pts[i] - s * pts[i + 1];
            out[i + 1] = s * pts[i] + c * pts[i + 1];
        }
        return out;
    }
    // A predicted path's points: one worked out in a rotating frame is along the pair (turned by alpha),
    // any other in world directions (turned by phi)
    const turnedPath = (pp) => turnedPoints(pp.pts, pp.refId === TURN_REF ? turn.alpha : turn.phi);

    // A prediction in a rotating frame (see predictPath): where a body of the copy is relative to the
    // copy's turning pair, along the line from A to B (+x) and across it
    function turnedSeen(src, list) {
        const P = turnPair();
        if (!P) return null;
        const qa = list[src.indexOf(P.A)], qb = list[src.indexOf(P.B)];
        if (!qa || !qb) return null;
        return (q) => {
            const M = qa.m + qb.m;
            const rx = q.x - (qa.m * qa.x + qb.m * qb.x) / M, ry = q.y - (qa.m * qa.y + qb.m * qb.y) / M;
            const dx = qb.x - qa.x, dy = qb.y - qa.y, d = Math.hypot(dx, dy) || 1;
            const c = dx / d, s = dy / d;
            return [c * rx + s * ry, c * ry - s * rx];
        };
    }

    // Trails in a turned view (see drawTrails). In a rotating frame each sample is seen from the pair's
    // centre of mass at that sample's time and turned by alpha - theta_k, theta_k being the pair's
    // direction then (read from the pair's own samples): { oT (the centres), cs (cosines and sines),
    // first (the first sample both of the pair have) }. While an ordinary frame glides square: one turn
    // for every sample, { c, s }. Null when the view isn't turned.
    const turnTrailO = new Float64Array(TRAIL_CAP * 2), turnTrailCS = new Float64Array(TRAIL_CAP * 2);
    function turnedTrails(first) {
        const P = turnPair();
        if (!P) return turn.phi ? { oT: null, cs: null, c: turn.c, s: turn.s, first: 0 } : null;
        const TA = P.A.trail, TB = P.B.trail;
        if (!TA || !TB) return { oT: turnTrailO, cs: turnTrailCS, first: sampleCount };
        const k0 = Math.max(first, trailFirst(P.A), trailFirst(P.B), sampleCount - TRAIL_CAP + 1);
        const ma = P.A.m, mb = P.B.m, M = ma + mb;
        const ca = Math.cos(turn.alpha), sa = Math.sin(turn.alpha);
        for (let k = k0; k < sampleCount; k++) {
            const ia = trailIndex(TA, k), ib = trailIndex(TB, k), j = 2 * (k % TRAIL_CAP);
            const ax = TA[ia], ay = TA[ia + 1], bx = TB[ib], by = TB[ib + 1];
            turnTrailO[j] = (ma * ax + mb * bx) / M;
            turnTrailO[j + 1] = (ma * ay + mb * by) / M;
            const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 1;
            const ct = dx / d, st = dy / d;
            turnTrailCS[j] = ca * ct + sa * st;       // cos(alpha - theta_k)
            turnTrailCS[j + 1] = sa * ct - ca * st;   // sin(alpha - theta_k)
        }
        return { oT: turnTrailO, cs: turnTrailCS, first: k0 };
    }

    // traceTrail for a turned view: the same, with each point turned
    function traceTurnedTrail(tr, ks, ke, minPx) {
        const T = tr.T, oT = tr.oT, offX = tr.offX, offY = tr.offY, stride = tr.stride;
        const cs = tr.turn.cs, c0 = tr.turn.c, s0 = tr.turn.s;
        const capT = T.length >> 1, capO = oT.length >> 1;
        let i = 2 * (ks % capT), io = 2 * (ks % capO), j = 2 * (ks % TRAIL_CAP);
        let c = cs ? cs[j] : c0, s = cs ? cs[j + 1] : s0;
        let rx = T[i] - oT[io], ry = T[i + 1] - oT[io + 1];
        let lx = offX + (c * rx - s * ry) * scale, ly = offY - (s * rx + c * ry) * scale;
        let out = outcode(lx, ly), pen = true;
        ctx.moveTo(lx, ly);
        for (let k = ks + 1; k < ke; k += stride) {
            if (k + stride >= ke) k = ke - 1;
            i = 2 * (k % capT); io = 2 * (k % capO); j = 2 * (k % TRAIL_CAP);
            if (cs) { c = cs[j]; s = cs[j + 1]; }
            rx = T[i] - oT[io]; ry = T[i + 1] - oT[io + 1];
            const x = offX + (c * rx - s * ry) * scale, y = offY - (s * rx + c * ry) * scale;
            if (Math.abs(x - lx) + Math.abs(y - ly) < minPx && k < ke - 1) continue;
            const o = outcode(x, y);
            if (o & out) {
                pen = false;
            } else {
                if (!pen) { ctx.moveTo(lx, ly); pen = true; }
                ctx.lineTo(x, y);
            }
            lx = x; ly = y; out = o;
        }
        if (!pen) ctx.moveTo(lx, ly);
    }

    // ------------------------------------------------------------------
    // Lagrange points of a body B and the body A it orbits (A the heavier; mu = m_B / (m_A + m_B)), in
    // units of the distance d between them now, along the line from A to B and measured from their
    // centre of mass (A at -mu, B at 1 - mu). L1, L2 and L3 lie on that line, where in a frame turning
    // with the pair the two pulls and the outward (centrifugal) push balance: the roots of
    //   f(x) = x - (1 - mu)(x + mu)/|x + mu|^3 - mu(x - 1 + mu)/|x - 1 + mu|^3,
    // a quintic on each stretch of the line: one between A and B (L1), one beyond B (L2) and one beyond
    // A (L3). f runs from -infinity to +infinity across each stretch, so bisection finds each root to
    // the last digit. L4 and L5 make equilateral triangles with A and B, 60 degrees ahead of B and
    // behind it; they are stable only while mu is under 0.0385 (Routh's limit), and then small bodies
    // gather round them, as the Trojans do round Jupiter's.
    // ------------------------------------------------------------------
    const ROUTH_MU = 0.0385;
    const lagrangeMemo = { mu: NaN, pts: null };
    function lagrangeUnits(mu) {
        if (mu === lagrangeMemo.mu) return lagrangeMemo.pts;
        const f = (x) => {
            const a = x + mu, b = x - 1 + mu;
            return x - (1 - mu) * a / Math.abs(a * a * a) - mu * b / Math.abs(b * b * b);
        };
        // (f(lo) < 0 < f(hi))
        const root = (lo, hi) => {
            for (let k = 0; k < 200 && hi - lo > 4e-16 * Math.max(1, Math.abs(lo)); k++) {
                const m = 0.5 * (lo + hi);
                if (f(m) < 0) lo = m; else hi = m;
            }
            return 0.5 * (lo + hi);
        };
        const tiny = 1e-12, h = Math.sqrt(3) / 2;
        const pts = [
            [root(-mu + tiny, 1 - mu - tiny), 0], [root(1 - mu + tiny, 2), 0], [root(-2, -mu - tiny), 0],
            [0.5 - mu, h], [0.5 - mu, -h]
        ];
        lagrangeMemo.mu = mu;
        lagrangeMemo.pts = pts;
        return pts;
    }

    // The pair whose points are shown: the rotating frame's, else the one the list offers (the chosen
    // body, if it orbits something). Only while they are bound to each other (and B isn't so light
    // that L1 and L2 sit on it). { A (the heavier), B, mu, sense: 1 if B goes round anticlockwise }
    function lagrangePair() {
        const P = turnPair();
        let B = P ? P.B : turnCandidate();
        let A = P ? P.A : turnPartner(B);
        if (!A || !B) return null;
        if (B.m > A.m) [A, B] = [B, A];
        const rx = B.x - A.x, ry = B.y - A.y, r = Math.hypot(rx, ry);
        const vx = B.vx - A.vx, vy = B.vy - A.vy;
        const mu = B.m / (A.m + B.m);
        if (!(r > 0) || !(mu > 1e-15) || 0.5 * (vx * vx + vy * vy) - G * (A.m + B.m) / r >= 0) return null;
        return { A, B, mu, sense: rx * vy - ry * vx < 0 ? -1 : 1 };
    }

    // The five points relative to A (AU, in world directions, or drawn ones with drawn), each with its
    // place along the line from A to B and across it (+: ahead of B) in units of their distance
    function lagrangePoints(Q, drawn) {
        const ax = drawn ? Q.A.dx : Q.A.x, ay = drawn ? Q.A.dy : Q.A.y;
        const dx = (drawn ? Q.B.dx : Q.B.x) - ax, dy = (drawn ? Q.B.dy : Q.B.y) - ay;
        const d = Math.hypot(dx, dy), c = dx / d, s = dy / d;
        return lagrangeUnits(Q.mu).map(([x, y]) => {
            const u = (x + Q.mu) * d, v = y * Q.sense * d;
            return { x: c * u - s * v, y: s * u + c * v, along: x + Q.mu, across: y, d };
        });
    }

    // A short line about each point (a tooltip; tapped on a touch screen, in the hint line)
    function lagrangeText(i, Q) {
        const b = theName(Q.B), a = theName(Q.A);
        if (i < 3) {
            const where = [`between ${b} and ${a}`, `just beyond ${b}`, `on the far side of ${a}`][i];
            return `L${i + 1}, ${where}: a body here keeps pace with ${b}, but drifts away if nudged.`;
        }
        const where = i === 3 ? 'ahead of' : 'behind';
        return Q.mu < ROUTH_MU ? `L${i + 1}, 60° ${where} ${b}: a stable spot, where small bodies gather (like Jupiter's Trojans).`
            : `L${i + 1}, 60° ${where} ${b}: not stable, as ${b} is too heavy compared with ${a}.`;
    }

    // Small diamonds labelled L1 to L5 (under the bodies). One hidden under A or B, or crowding another,
    // is left out.
    let lagrangeShown = [];      // the markers drawn this frame: { x, y, i, text }
    function drawLagrangePoints(C) {
        lagrangeShown = [];
        if (!settings.lagrange) return;
        const Q = lagrangePair();
        if (!Q) return;
        const pts = lagrangePoints(Q, true);
        const ax = sx(Q.A.dx), ay = sy(Q.A.dy), bx = sx(Q.B.dx), by = sy(Q.B.dy);
        const ra = drawRadius(Q.A) + 6, rb = drawRadius(Q.B) + 6;
        const fs = clamp(Math.min(viewW, viewH) / 46, 10, 12);
        ctx.font = font(fs);
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = C.dark ? 'rgba(224,224,224,0.75)' : 'rgba(40,40,40,0.7)';
        const halo = hexA(C.bg, 0.8);
        pts.forEach((p, i) => {
            const x = sx(Q.A.dx + p.x), y = sy(Q.A.dy + p.y);
            if (x < -10 || x > viewW + 10 || y < -10 || y > viewH + 10) return;
            if (Math.hypot(x - ax, y - ay) < ra || Math.hypot(x - bx, y - by) < rb) return;
            if (lagrangeShown.some((q) => Math.hypot(q.x - x, q.y - y) < 14)) return;
            const r = 4.5;
            ctx.beginPath();
            ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
            ctx.stroke();
            lagrangeShown.push({ x, y, i, text: lagrangeText(i, Q) });
            if (cleanRender) return;
            // The name on the side away from the pair's centre; for L1 and L2, either side of B, to one
            // side of the line (B's own name goes outwards)
            const ox = sx(Q.A.dx + (Q.B.dx - Q.A.dx) * Q.mu), oy = sy(Q.A.dy + (Q.B.dy - Q.A.dy) * Q.mu);
            let ux = x - ox, uy = y - oy;
            if (i < 2) { ux = ay - by; uy = bx - ax; }
            const len = Math.hypot(ux, uy) || 1;
            ux /= len; uy /= len;
            const name = `L${i + 1}`, w = ctx.measureText(name).width;
            const tx = x + ux * 9 + (ux < -0.3 ? -w : ux > 0.3 ? 0 : -w / 2), ty = y + uy * 10;
            ctx.textAlign = 'left';
            ctx.lineWidth = 3;
            ctx.strokeStyle = halo;
            ctx.strokeText(name, tx, ty);
            ctx.fillStyle = C.subtle;
            ctx.fillText(name, tx, ty);
            ctx.lineWidth = 1.4;
            ctx.strokeStyle = C.dark ? 'rgba(224,224,224,0.75)' : 'rgba(40,40,40,0.7)';
        });
    }

    function lagrangeAt(x, y, tol) {
        let best = null, bestD = tol;
        for (const q of lagrangeShown) {
            const d = Math.hypot(q.x - x, q.y - y);
            if (d < bestD) { bestD = d; best = q; }
        }
        return best;
    }

    // ------------------------------------------------------------------
    // Gravity well: the potential Phi = -sum G m / sqrt(r^2 + eps^2) of the heavier bodies (a light swarm
    // body's dimple is far too small to see), drawn as a contour map. In a rotating frame it is the
    // effective potential Phi - (1/2) Omega^2 |r - C|^2, which adds the outward push of the turning
    // frame: its hills and saddles are the Lagrange points.
    //   Why a contour map, not a rubber sheet: it stays flat and lined up with the bodies, trails and
    //   arrows drawn over it (a warped sheet would put each body somewhere other than where it is
    //   drawn), it shows the depth everywhere at once, and contour lines are already familiar from maps:
    //   darker is deeper, each line joins points at the same depth (an equipotential), and where the
    //   lines crowd together the slope, and so the pull, is steep.
    //   Depth is compressed logarithmically, u = ln(-Phi / G), so one star's well doesn't swallow the
    //   picture: round a single body the lines are circles whose radii go up in equal ratios, the same
    //   pattern at any zoom. The lines are a round step of u apart (1, 2, 2.5 or 5 times a power of ten),
    //   about WELL_LEVELS steps across the depths in view, so zooming in on a planet still shows its
    //   small dimple on the side of its star's well. Lines closer together than the grid aren't drawn
    //   (the shading shows them). In a rotating frame a few stronger lines pass through L1, L2 and L3
    //   and round L4 and L5: the curves that bound the region round each body, the horseshoe and the
    //   tadpoles that bodies can't cross without more energy.
    //   eps is about a body's drawn radius, so its well bottoms out under its disc.
    //   Worked out on a coarse grid (a point every WELL_CELL px, more when there are many bodies to add
    //   up) with a margin round the view: the shading as a tiny image, one pixel per grid point, drawn
    //   smoothly scaled up, and the lines as paths. Again only when a body has moved a pixel or the view
    //   has changed more than shifting and scaling the old picture can cover, and at most every few
    //   frames if that is slow; in between, the old picture follows the zoom and pan.
    // ------------------------------------------------------------------
    const WELL_CELL = 7;          // px between grid points
    const WELL_WORK = 240000;     // at most about this many body-point sums per picture
    const WELL_BODIES = 24;       // the heaviest bodies that make the picture
    const WELL_LEVELS = 9;        // about this many steps between contour lines across the depths in view
    Object.assign(settings, { well: false, lagrange: false });
    Object.assign(ui, { wellToggle: byId('wellToggle'), wellNote: byId('wellNote'), lagrangeToggle: byId('lagrangeToggle') });
    const well = {
        small: null, smallCtx: null, img: null,   // the shading, one pixel per grid point
        lines: null, strong: null,        // the contour lines (Path2D, in the screen points of the view below)
        view: null,                       // what it was worked out for (origin, pan, scale, size, margin, grid)
        pos: [],                          // the screen positions of its bodies then
        sig: '',                          // what forces a new picture when it changes (theme, size, frame, bodies)
        omega: 0,                         // the rotating frame's rate then
        t: 0, cost: 0, wait: 0, count: 0, // when it was last worked out, how long that took (ms), the wait before another
        info: null                        // the grid and contour levels (for testing)
    };

    // The bodies that make the picture: the heaviest few that aren't light swarm bodies, or the turning pair
    function wellBodies() {
        let top = 0;
        for (const b of bodies) if (b.m > top) top = b.m;
        const list = bodies.filter((b) => ((!b.minor && b.m > 1e-12 * top) || turnUses(b)));
        if (list.length > WELL_BODIES) {
            list.sort((p, q) => q.m - p.m);
            list.length = WELL_BODIES;
        }
        return list;
    }

    // Contour segments of level v across one grid cell: corners a (top left), b (top right), c (bottom
    // right) and d (bottom left), top-left corner at (x, y), side h (marching squares; where opposite
    // corners are both above, the centre decides which way the lines go)
    function cellContour(p, x, y, h, a, b, c, d, v) {
        const k = (a >= v ? 8 : 0) | (b >= v ? 4 : 0) | (c >= v ? 2 : 0) | (d >= v ? 1 : 0);
        if (k === 0 || k === 15) return;
        // where the level crosses each side (a side it doesn't cross is never used)
        const tx = x + (h * (v - a)) / (b - a), ry = y + (h * (v - b)) / (c - b);
        const bx = x + (h * (v - d)) / (c - d), ly = y + (h * (v - a)) / (d - a);
        const seg = (x1, y1, x2, y2) => { p.moveTo(x1, y1); p.lineTo(x2, y2); };
        switch (k) {
            case 1: case 14: seg(x, ly, bx, y + h); break;
            case 2: case 13: seg(bx, y + h, x + h, ry); break;
            case 3: case 12: seg(x, ly, x + h, ry); break;
            case 4: case 11: seg(tx, y, x + h, ry); break;
            case 6: case 9: seg(tx, y, bx, y + h); break;
            case 7: case 8: seg(x, ly, tx, y); break;
            default: {   // 5 or 10: a saddle
                const mid = (a + b + c + d) / 4 >= v;
                if ((k === 5) === mid) { seg(x, ly, tx, y); seg(bx, y + h, x + h, ry); }
                else { seg(tx, y, x + h, ry); seg(x, ly, bx, y + h); }
            }
        }
    }

    // A round step: 1, 2, 2.5 or 5 times a power of ten, the nearest to x (by ratio)
    function roundStep(x) {
        const e = Math.pow(10, Math.floor(Math.log10(x))), r = x / e;
        return e * (r < 1.41 ? 1 : r < 2.24 ? 2 : r < 3.54 ? 2.5 : r < 7.07 ? 5 : 10);
    }

    function computeWell(C, src, P) {
        const t0 = performance.now();
        const margin = Math.round(0.15 * Math.max(viewW, viewH));
        const W = viewW + 2 * margin, H = viewH + 2 * margin;
        const n = src.length;
        let cell = WELL_CELL;
        while (cell < 16 && (W / cell) * (H / cell) * n > WELL_WORK) cell++;
        const gw = Math.ceil(W / cell) + 1, gh = Math.ceil(H / cell) + 1;
        // The bodies at their drawn places (the potential doesn't change when the view turns), softened
        // by about their drawn radius; in a rotating frame, the outward push about the pair's centre
        const bxs = new Float64Array(n), bys = new Float64Array(n), bms = new Float64Array(n), be2 = new Float64Array(n);
        src.forEach((b, k) => {
            const e = Math.max(drawRadius(b), 3) / scale;
            bxs[k] = b.dx; bys[k] = b.dy; bms[k] = b.m; be2[k] = e * e;
        });
        const pc = P ? pairCentre(P, true) : { x: 0, y: 0 };
        const om2 = P ? (turn.omega * turn.omega) / (2 * G) : 0;
        // -Phi / G at a drawn point
        const depth = (x, y) => {
            let s = 0;
            for (let k = 0; k < n; k++) {
                const dx = x - bxs[k], dy = y - bys[k];
                s += bms[k] / Math.sqrt(dx * dx + dy * dy + be2[k]);
            }
            if (om2) { const dx = x - pc.x, dy = y - pc.y; s += om2 * (dx * dx + dy * dy); }
            return s;
        };
        // Grid point (i, j) is at screen point (i cell - margin, j cell - margin)
        const x0 = F.x + view.panX + (-margin - viewW / 2) / scale, y0 = F.y + view.panY + (margin + viewH / 2) / scale;
        const step = cell / scale;
        const U = new Float32Array(gw * gh);
        let umin = Infinity, umax = -Infinity;
        for (let j = 0; j < gh; j++) {
            const y = y0 - j * step;
            for (let i = 0; i < gw; i++) {
                const u = Math.log(depth(x0 + i * step, y));
                U[j * gw + i] = u;
                if (u < umin) umin = u;
                if (u > umax) umax = u;
            }
        }
        const span = umax - umin;
        const dz = span > 1e-9 ? roundStep(span / WELL_LEVELS) : 0;
        // The stronger lines of a rotating frame: through L1 and L2 (round each body's own region) once
        // that region (about the Hill radius, d (mu/3)^(1/3)) is a few grid cells across, and through L3
        // and round L4 and L5 (the horseshoe and the tadpoles, about d sqrt(mu) wide) once they are too;
        // any thinner and the grid would break them into dashes
        const crit = [];
        const Q = P ? lagrangePair() : null;
        if (Q) {
            const lp = lagrangePoints(Q, true);
            const dpx = lp[0].d * scale, lu = lp.map((q) => Math.log(depth(Q.A.dx + q.x, Q.A.dy + q.y)));
            if (dpx * Math.cbrt(Q.mu / 3) > 2 * cell) crit.push(lu[0], lu[1]);
            const u4 = Math.min(lu[3], lu[4]);
            if (dpx * Math.sqrt(Q.mu) > 3 * cell && lu[2] > u4) crit.push(lu[2], u4 + 0.3 * (lu[2] - u4), u4 + 0.65 * (lu[2] - u4));
        }
        // The shading: darker the deeper, from the shallowest ground in view (w = 0) to the deepest (1).
        // On a light page, a blue-grey veil that thickens into the wells; on a dark one (already nearly
        // black) the shallow ground is lifted a little and the wells sink to black.
        if (!well.small || well.small.width !== gw || well.small.height !== gh) {
            well.small = document.createElement('canvas');
            well.small.width = gw; well.small.height = gh;
            well.smallCtx = well.small.getContext('2d');
            well.img = well.smallCtx.createImageData(gw, gh);
        }
        const data = well.img.data, dark = C.dark, W0 = 0.3;
        for (let q = 0, o = 0; q < U.length; q++, o += 4) {
            const w = span > 1e-9 ? (U[q] - umin) / span : 0;
            if (!dark) {
                data[o] = 20; data[o + 1] = 34; data[o + 2] = 72;
                data[o + 3] = Math.round(62 * w);
            } else if (w < W0) {
                data[o] = data[o + 1] = 205; data[o + 2] = 225;
                data[o + 3] = Math.round(20 * (1 - w / W0));
            } else {
                data[o] = data[o + 1] = data[o + 2] = 0;
                data[o + 3] = Math.round(150 * (w - W0) / (1 - W0));
            }
        }
        well.smallCtx.putImageData(well.img, 0, 0);
        // The lines (marching squares; a cell that more than one ordinary line crosses is too steep to draw)
        const lines = new Path2D(), strong = new Path2D();
        for (let j = 0; j < gh - 1; j++) {
            const y = j * cell - margin;
            for (let i = 0; i < gw - 1; i++) {
                const a = U[j * gw + i], b = U[j * gw + i + 1], c = U[(j + 1) * gw + i + 1], d = U[(j + 1) * gw + i];
                const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
                const x = i * cell - margin;
                if (dz) {
                    const n0 = Math.ceil(lo / dz);
                    if (n0 * dz <= hi && (n0 + 1) * dz > hi) cellContour(lines, x, y, cell, a, b, c, d, n0 * dz);
                }
                for (const v of crit) if (v > lo && v <= hi) cellContour(strong, x, y, cell, a, b, c, d, v);
            }
        }
        well.lines = lines;
        well.strong = crit.length ? strong : null;
        well.view = { fx: F.x, fy: F.y, panX: view.panX, panY: view.panY, scale, w: viewW, h: viewH, margin, cell, gw, gh };
        well.pos = src.map((b) => ({ b, x: sx(b.dx), y: sy(b.dy) }));
        well.omega = P ? turn.omega : 0;
        well.t = performance.now();
        well.cost = well.t - t0;
        well.wait = clamp(10 * well.cost, 0, 100);
        well.count++;
        well.info = { cell, grid: [gw, gh], bodies: n, step: dz, umin, umax, crit: crit.slice() };
    }

    // How the picture's screen points map onto the screen now: x' = k x + tx, y' = k y + ty
    function wellMap(v) {
        const k = scale / v.scale;
        return {
            k,
            tx: viewW / 2 - (k * v.w) / 2 + scale * (v.fx + v.panX - F.x - view.panX),
            ty: viewH / 2 - (k * v.h) / 2 - scale * (v.fy + v.panY - F.y - view.panY)
        };
    }

    // Is the old picture still good enough to shift into place?
    function wellStale(v, map, P) {
        if (map.k < 0.85 || map.k > 1.18) return true;
        // (the view must stay inside its margin, short of the outermost grid cell)
        const slack = v.margin - 16;
        if (-map.tx / map.k < -slack || (viewW - map.tx) / map.k > v.w + slack) return true;
        if (-map.ty / map.k < -slack || (viewH - map.ty) / map.k > v.h + slack) return true;
        for (const q of well.pos) {
            if (Math.hypot(map.k * q.x + map.tx - sx(q.b.dx), map.k * q.y + map.ty - sy(q.b.dy)) > 1) return true;
        }
        return !!P && Math.abs(turn.omega - well.omega) > 0.003 * Math.abs(well.omega);
    }

    function drawGravityWell(C) {
        syncTurnOptions();   // (not part of the picture: the rotating frames offered in "View from", checked from here as this runs every frame)
        if (!settings.well || !bodies.length) return;
        const src = wellBodies();
        if (!src.length) return;
        const P = turnPair();
        const sig = [C.dark, viewW, viewH, dpr, P ? `${P.A.id}>${P.B.id}` : '-', src.map((b) => `${b.id}:${b.m}`).join(',')].join('|');
        const forced = sig !== well.sig || !well.view;
        if (forced || (performance.now() - well.t >= well.wait && wellStale(well.view, wellMap(well.view), P))) {
            computeWell(C, src, P);
            well.sig = sig;
        }
        // The shading (smoothly scaled up from its grid) and the lines, shifted and scaled into place
        const v = well.view, map = wellMap(v), c = v.cell;
        ctx.save();
        ctx.setTransform(dpr * map.k, 0, 0, dpr * map.k, dpr * map.tx, dpr * map.ty);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(well.small, -v.margin - c / 2, -v.margin - c / 2, v.gw * c, v.gh * c);
        ctx.lineWidth = 1 / map.k;
        ctx.strokeStyle = C.dark ? 'rgba(205,214,240,0.2)' : 'rgba(30,45,90,0.24)';
        ctx.stroke(well.lines);
        if (well.strong) {
            ctx.lineWidth = 1.3 / map.k;
            ctx.strokeStyle = C.dark ? 'rgba(205,214,240,0.36)' : 'rgba(30,45,90,0.42)';
            ctx.stroke(well.strong);
        }
        ctx.restore();
    }

    // ---- The switches, the W key, and the Lagrange points' tooltips ----
    function setWell(on, fromKey) {
        settings.well = !!on;
        if (ui.wellToggle) ui.wellToggle.checked = settings.well;
        if (ui.wellNote) ui.wellNote.hidden = !settings.well;
        well.sig = '';
        if (fromKey) {
            historyNote(settings.well ? '<strong>Gravity well:</strong> darker is deeper, and each line joins points at the same depth. W hides it.'
                : '<strong>Gravity well hidden.</strong> W shows it again.');
        }
    }
    function setLagrange(on) {
        settings.lagrange = !!on;
        if (ui.lagrangeToggle) ui.lagrangeToggle.checked = settings.lagrange;
    }

    // W: the gravity well on or off (not while typing in a field)
    function onWellKey(e) {
        if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.repeat || typingIn(e.target)) return;
        if (e.key !== 'w' && e.key !== 'W') return;
        setWell(!settings.well, true);
        e.preventDefault();
    }

    // A Lagrange point's line: a tooltip under the mouse, or in the hint line when tapped
    let lagrangeTitle = false, lagrangeDown = null;
    function onLagrangeHover(e) {
        if (e.buttons || (!lagrangeShown.length && !lagrangeTitle)) return;
        const pt = canvasPoint(e);
        const m = lagrangeAt(pt.x, pt.y, 9);
        if (m && !bodyAt(pt.x, pt.y, 4)) {
            if (canvas.title !== m.text) canvas.title = m.text;
            lagrangeTitle = true;
        } else if (lagrangeTitle) {
            canvas.removeAttribute('title');
            lagrangeTitle = false;
        }
    }
    function onLagrangeTap(e) {
        const down = lagrangeDown;
        lagrangeDown = null;
        if (!down || (e.pointerType || 'mouse') === 'mouse' || !lagrangeShown.length) return;
        const pt = canvasPoint(e);
        if (Math.hypot(pt.x - down.x, pt.y - down.y) > 10 || bodyAt(pt.x, pt.y, 12)) return;
        const m = lagrangeAt(pt.x, pt.y, 18);
        if (!m) return;
        const comma = m.text.indexOf(',');
        historyNote(`<strong>${escapeHtml(m.text.slice(0, comma))}</strong>${escapeHtml(m.text.slice(comma))}`);
    }

    function bindWell() {
        if (ui.wellToggle) {
            ui.wellToggle.checked = settings.well;
            ui.wellToggle.addEventListener('change', () => setWell(ui.wellToggle.checked));
        }
        if (ui.lagrangeToggle) {
            ui.lagrangeToggle.checked = settings.lagrange;
            ui.lagrangeToggle.addEventListener('change', () => setLagrange(ui.lagrangeToggle.checked));
        }
        document.addEventListener('keydown', onWellKey);
        canvas.addEventListener('pointermove', onLagrangeHover);
        canvas.addEventListener('pointerdown', (e) => { lagrangeDown = canvasPoint(e); });
        canvas.addEventListener('pointerup', onLagrangeTap);
        canvas.addEventListener('pointerleave', () => { if (lagrangeTitle) { canvas.removeAttribute('title'); lagrangeTitle = false; } });
    }

    // ------------------------------------------------------------------
    // Body lists in the UI (frame selector), after bodies are added, removed or renamed
    // ------------------------------------------------------------------
    function refreshBodyLists() {
        if (frameId !== null && !bodyById(frameId)) frameId = null;
        if (selectedId !== null && !bodyById(selectedId)) selectedId = defaultSubject();
        if (ui.frame) {
            const opts = [['com', 'Centre of mass (no body)']].concat(bodies.filter((b) => (!b.grp && !b.minor) || b.id === frameId).map((b) => [String(b.id), b.name]), turnOptions());
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
        const before = viewOrigin();
        const wasFrame = frameId === b.id;
        removeBody(b, null);
        if (selectedId === null) selectedId = defaultSubject();
        if (wasFrame) frameId = null;
        updateDrawnPositions();
        keepScreen(before);
        computePrimaries();
        refreshBodyLists();
        syncEccentricity(true);
    }

    // Keep the view still when something changes the frame origin (e.g. a mass change moves the
    // centre of mass): run fn, then shift the pan by however far the origin moved.
    function keepView(fn) {
        noteEdit();   // (edit history: every edit made through here is an undo step)
        updateDrawnPositions();
        const before = viewOrigin();
        fn();
        forcesDirty = true;
        updateDrawnPositions();
        if (!freeze) keepScreen(before);   // (also keeps a rotating frame's angle: see keepScreen)
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
            const fv = frameVelocity(x, y);
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
            const fv = frameVelocity(b.x, b.y);
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
        const w = unturnPoint(best[0], best[1]);   // (from the drawn view to the world)
        return addBody(kind, w.x, w.y);
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
        inRender = true;
        try { renderFrame(); } finally { inRender = false; }
    }

    function renderFrame() {
        const C = colours();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = C.bg;
        ctx.fillRect(0, 0, viewW, viewH);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        computeDrawRadii();
        placeCloseUp();
        drawGravityWell(C);   // (underneath everything: see "Gravity well")
        const subj = bodyById(selectedId);
        if (settings.k2) drawSectors(C, subj);
        drawTrails(C);
        drawFlybyGhost(C);
        if (settings.k1) drawEllipseLaw(C, subj);
        drawDragPreviews(C);
        drawEditPreview(C);
        drawBodies(C);
        drawLagrangePoints(C);
        if (settings.com) drawCentreOfMass(C);   // small: on top, so a star at the centre doesn't hide it
        drawArrows(C);
        drawLabels(C);
        drawOffscreen(C);
        drawFlashes();
        drawPaletteGhost();
        drawOverlays(C, subj);
    }

    // Each trail point is drawn relative to where the frame's origin (the centre of mass, or the locked
    // body) was at that sample's time, so a locked view shows paths as seen from that body. A point
    // closer than about a pixel to the last one drawn is skipped (two or three pixels in the older,
    // fainter part, and more if drawing is running slow: perf.quality), and stretches off the canvas
    // aren't drawn. A trail with more than TRAIL_POINTS samples (fast swings add extra ones) is read
    // every few samples. The minor bodies of a crowded scene are drawn together, a path per colour and shade.
    const TRAIL_CHUNKS = 8, MINOR_CHUNKS = 3, TRAIL_POINTS = 1500;
    const minorGroups = new Map();
    function drawTrails(C) {
        const years = trailYears();
        if (years <= 0) return;
        const first = sampleAtTime(simTime - years);
        const L = frameId !== null ? bodyById(frameId) : null;
        if (L && !L.trail) return;
        // While the frame is frozen (a body is being dragged), the live origin has drifted from F
        const live = freeze ? liveFrameOrigin() : F;
        const offX = (live.x - F.x - view.panX) * scale + viewW / 2, offY = viewH / 2 - (live.y - F.y - view.panY) * scale;
        const lw = clamp(1.6 * sizeScale, 1.2, 2);
        // (a turned view: each sample turned by the angle at its own time, from the turning pair's own
        // samples; see turnedTrails)
        const turned = turnedTrails(first);
        const oT = turned && turned.oT ? turned.oT : L ? L.trail : comTrail;
        const oFirst = turned && turned.oT ? turned.first : L ? trailFirst(L) : sampleCount - TRAIL_CAP + 1;
        const tr = { T: null, oT, offX, offY, stride: 1, turn: turned };
        for (const g of minorGroups.values()) g.length = 0;
        for (const b of bodies) {
            if (b.held || !b.trail) continue;
            if (b.minor && !isChosen(b)) {
                let g = minorGroups.get(b.color);
                if (!g) { g = []; minorGroups.set(b.color, g); }
                g.push(b);
                continue;
            }
            const k0 = Math.max(trailFirst(b), first, oFirst);
            const count = sampleCount - k0;
            if (count < 1) continue;
            ctx.strokeStyle = bodyStroke(b.color, C.dark);
            ctx.lineWidth = lw;
            tr.T = b.trail;
            tr.stride = Math.max(1, Math.floor(count / (TRAIL_POINTS * perf.quality)));
            const chunk = Math.max(1, Math.ceil(count / TRAIL_CHUNKS));
            for (let c = 0; c < TRAIL_CHUNKS; c++) {
                const ks = k0 + c * chunk;
                if (ks >= sampleCount) break;
                const ke = Math.min(sampleCount, ks + chunk + 1);
                const f = (c + 1) / TRAIL_CHUNKS;
                ctx.globalAlpha = 0.08 + 0.72 * f;
                ctx.beginPath();
                traceTrail(tr, ks, ke, (1.2 + 2 * (1 - f)) / perf.quality);
                if (ke === sampleCount) ctx.lineTo(sx(b.dx), sy(b.dy));
                ctx.stroke();
            }
        }
        // The swarm: one path per colour for each of a few shades, in thinner lines with plain ends and
        // corners (round ones take far longer to paint); when drawing runs slow, only their newest part
        if (perf.quality < 0.3) return;
        ctx.lineWidth = Math.max(1, 0.6 * lw);
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';
        for (const [color, g] of minorGroups) {
            if (!g.length) continue;
            ctx.strokeStyle = bodyStroke(color, C.dark);
            for (let c = 0; c < MINOR_CHUNKS; c++) {
                const f = (c + 1) / MINOR_CHUNKS;
                ctx.globalAlpha = 0.06 + 0.5 * f;
                ctx.beginPath();
                for (const b of g) {
                    let k0 = Math.max(trailFirst(b), first, oFirst);
                    k0 = Math.max(k0, sampleCount - Math.ceil((sampleCount - k0) * perf.quality));
                    const count = sampleCount - k0;
                    if (count < 1) continue;
                    const chunk = Math.max(1, Math.ceil(count / MINOR_CHUNKS));
                    const ks = k0 + c * chunk;
                    if (ks >= sampleCount) continue;
                    const ke = Math.min(sampleCount, ks + chunk + 1);
                    tr.T = b.trail;
                    tr.stride = 1;
                    traceTrail(tr, ks, ke, 2 / perf.quality);
                    if (ke === sampleCount) ctx.lineTo(sx(b.dx), sy(b.dy));
                }
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
    }

    // Add samples ks..ke-1 of trail tr.T (relative to the origin trail tr.oT; every tr.stride-th, and
    // the last) to the current path, skipping points within minPx of the last one drawn and stretches
    // wholly off one side of the canvas
    function traceTrail(tr, ks, ke, minPx) {
        if (tr.turn) { traceTurnedTrail(tr, ks, ke, minPx); return; }
        const T = tr.T, oT = tr.oT, offX = tr.offX, offY = tr.offY, stride = tr.stride;
        const capT = T.length >> 1, capO = oT.length >> 1;
        let i = 2 * (ks % capT), io = 2 * (ks % capO);
        let lx = offX + (T[i] - oT[io]) * scale, ly = offY - (T[i + 1] - oT[io + 1]) * scale;
        let out = outcode(lx, ly), pen = true;
        ctx.moveTo(lx, ly);
        for (let k = ks + 1; k < ke; k += stride) {
            if (k + stride >= ke) k = ke - 1;
            i = 2 * (k % capT); io = 2 * (k % capO);
            const x = offX + (T[i] - oT[io]) * scale, y = offY - (T[i + 1] - oT[io + 1]) * scale;
            if (Math.abs(x - lx) + Math.abs(y - ly) < minPx && k < ke - 1) continue;
            const o = outcode(x, y);
            if (o & out) {
                pen = false;
            } else {
                if (!pen) { ctx.moveTo(lx, ly); pen = true; }
                ctx.lineTo(x, y);
            }
            lx = x; ly = y; out = o;
        }
        if (!pen) ctx.moveTo(lx, ly);
    }

    // Which sides of the canvas (with a margin) a point is beyond, as bits
    function outcode(x, y) {
        return (x < -20 ? 1 : x > viewW + 20 ? 2 : 0) | (y < -20 ? 4 : y > viewH + 20 ? 8 : 0);
    }

    // The bodies drawn in full even in a swarm: the one chosen, the one whose menu is open, the one viewed from
    const isChosen = (b) => b.id === selectedId || b === popBody || b.id === frameId;

    // During and after a flyby: the orbit round the star the body was on before it met the planet
    // (faint and dashed), to compare with where it actually goes.
    function drawFlybyGhost(C) {
        const b = bodyById(selectedId);
        if (!b || flyby.bid !== b.id || !flyby.el0) return;
        const s = bodyById(flyby.sid), q = bodyById(flyby.pid);
        if (!s || !q) return;
        const el = turnedElements(flyby.el0);
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

    // Glows and small lit discs are drawn from little pictures made once per colour (offscreen canvases),
    // not a new gradient for every body every frame
    const sprites = new Map();
    const SPRITE_PX = 64;
    function sprite(key, paint) {
        let s = sprites.get(key);
        if (!s) {
            if (sprites.size > 400) sprites.clear();
            s = document.createElement('canvas');
            s.width = s.height = 2 * SPRITE_PX;
            paint(s.getContext('2d'), SPRITE_PX);
            sprites.set(key, s);
        }
        return s;
    }

    // A soft glow around a body (light, not size)
    function glow(x, y, r0, r1, color, a) {
        if (!(r1 > 0.5)) return;
        const k = clamp(Math.round((20 * r0) / r1) / 20, 0, 0.95);   // inner radius as a fraction of the outer
        const img = sprite(`g${color}|${a}|${k}`, (g, R) => {
            const gr = g.createRadialGradient(R, R, k * R, R, R, R);
            gr.addColorStop(0, hexA(color, a));
            gr.addColorStop(1, hexA(color, 0));
            g.fillStyle = gr;
            g.beginPath();
            g.arc(R, R, R, 0, TAU);
            g.fill();
        });
        ctx.drawImage(img, x - r1, y - r1, 2 * r1, 2 * r1);
    }

    // A lit sphere: lighter towards the top left
    function disc(x, y, r, color, light, C) {
        if (r <= 24) {
            const img = sprite(`d${color}|${light}`, (g, R) => {
                const gr = g.createRadialGradient(R * 0.65, R * 0.65, R * 0.1, R, R, R);
                gr.addColorStop(0, mix(color, '#ffffff', light));
                gr.addColorStop(1, color);
                g.fillStyle = gr;
                g.beginPath();
                g.arc(R, R, R, 0, TAU);
                g.fill();
            });
            ctx.drawImage(img, x - r, y - r, 2 * r, 2 * r);
            ctx.beginPath();
            ctx.arc(x, y, r, 0, TAU);
        } else {
            const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
            g.addColorStop(0, mix(color, '#ffffff', light));
            g.addColorStop(1, color);
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, TAU);
            ctx.fill();
        }
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

    // The minor bodies of a crowded scene: plain dots, one path per colour
    const dotGroups = new Map();
    function drawMinorBodies(C) {
        for (const g of dotGroups.values()) g.length = 0;
        for (const b of bodies) {
            if (!b.minor || isChosen(b)) continue;
            const x = sx(b.dx), y = sy(b.dy);
            if (x < -10 || x > viewW + 10 || y < -10 || y > viewH + 10) continue;
            let g = dotGroups.get(b.color);
            if (!g) { g = []; dotGroups.set(b.color, g); }
            g.push(b);
        }
        for (const [color, g] of dotGroups) {
            if (!g.length) continue;
            ctx.fillStyle = C.dark ? color : bodyStroke(color, false);
            ctx.beginPath();
            for (const b of g) {
                const x = sx(b.dx), y = sy(b.dy), r = Math.max(b.rd, 1.2);
                ctx.moveTo(x + r, y);
                ctx.arc(x, y, r, 0, TAU);
            }
            ctx.fill();
        }
    }

    function drawBodies(C) {
        const real = settings.realistic && !cleanRender;
        drawMinorBodies(C);
        for (const b of bodies) {
            if (b.minor && !isChosen(b)) continue;
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
        const discs = [];
        for (const b of bodies) if (!b.minor || isChosen(b)) discs.push({ x: sx(b.dx), y: sy(b.dy), r: drawRadius(b), b });
        // the flyby close-up and its caption
        if (closeUp) placed.push({ l: closeUp.x - closeUp.R, r: closeUp.x + closeUp.R, t: closeUp.y - closeUp.R - 18, b: closeUp.y + closeUp.R });
        const order = discs.slice().sort((p, q) => (q.b.id === selectedId) - (p.b.id === selectedId) || q.b.m - p.b.m);
        for (const { x, y, r, b } of order) {
            if (x < -60 || x > viewW + 60 || y < -60 || y > viewH + 60) continue;
            const chosen = b.id === selectedId || b === popBody;
            if ((b.grp || b.minor) && !chosen) continue;
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
            if (b.grp || (b.minor && !isChosen(b)) || (x > -r && x < viewW + r && y > -r && y < viewH + r)) continue;
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
    function velocityTip(b, frameV) {
        const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
        let vx, vy, L;
        if (b.aim) {
            vx = b.aim.vx; vy = b.aim.vy;
            if (turn.phi && !b.aim.turn) ({ x: vx, y: vy } = turnVec(vx, vy));   // (a world aim, drawn turned)
            L = Math.hypot(vx, vy) * b.aim.k;
        } else {
            const fv = frameV || frameVelocity();
            vx = b.vx - fv.x; vy = b.vy - fv.y;
            if (turn.on || turn.phi) ({ x: vx, y: vy } = viewVelocity(b, fv));   // (as seen in a turned view)
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
        // (turn.c, turn.s: the world turned as the view is)
        return Fm > 0 ? { x: -(turn.c * b.fx - turn.s * b.fy) / Fm, y: (turn.s * b.fx + turn.c * b.fy) / Fm } : { x: 0.6, y: 0.8 };
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
                if (!(Fm > 0) || ((b.grp || b.minor) && b !== subj)) continue;
                const L = forceLength(Fm * 1);
                if (L < 3) continue;
                const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
                const ux = (turn.c * b.fx - turn.s * b.fy) / Fm, uy = -(turn.s * b.fx + turn.c * b.fy) / Fm;   // (turned with the view)
                arrow(x + ux * r, y + uy * r, x + ux * (r + L), y + uy * (r + L), C.force, w);
            }
        }
        // Velocities only when they are switched on (or while one is being aimed): plain arrows, like
        // the forces. An arrow's tip is dragged to aim it (an invisible grab area round the tip); the
        // arrow under the pointer, or being aimed, is drawn thicker and brighter. A body hardly moving
        // has no arrow to grab, so hovering just off its disc shows a faint stub that can be pulled out.
        const hotColour = C.dark ? mix(C.velocity, '#ffffff', 0.35) : bodyStroke(C.velocity, false);
        const fv = frameVelocity();
        for (const b of bodies) {
            if (!(settings.velocities || b.aim) || (b.held && !b.aim) || ((b.grp || b.minor) && b !== subj)) continue;
            const tip = velocityTip(b, fv);
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
        const el = turnedElements(elementsOf(b, p));
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
            const pts = turnedPoints(s.pts);   // (world offsets, turned as the view is)
            const live = s === k2.cur;
            ctx.fillStyle = s.n % 2 ? C.sectorA : C.sectorB;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            for (let k = 0; k < n; k++) ctx.lineTo(cx + pts[2 * k] * scale, cy - pts[2 * k + 1] * scale);
            if (live) ctx.lineTo(sx(b.dx), sy(b.dy));
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = C.sectorLine;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + pts[0] * scale, cy - pts[1] * scale);
            ctx.stroke();
            // Area label inside finished sectors that are big enough on screen
            if (!live && k2.bound && !cleanRender) {
                const m = Math.floor(n / 2);
                const mx = pts[2 * m] * scale, my = -pts[2 * m + 1] * scale;
                const rpx = Math.hypot(mx, my);
                const x0 = pts[0] * scale, y0 = -pts[1] * scale, x1 = pts[2 * n - 2] * scale, y1 = -pts[2 * n - 1] * scale;
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
            const q = turnPoint(f.x, f.y);   // (a world point, drawn turned)
            ctx.arc(sx(q.x), sy(q.y), f.r0 + (f.grow || 30) * t, 0, TAU);
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
            if (c === P || c.primary !== P || !c.bound || c.grp || (c.minor && c !== b)) continue;
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
    const PREDICT_MS = 3;                 // while drawing: ms of prediction a frame (it carries on in the next)
    const PREDICT_ALL = 24, PREDICT_HEAVY = 8;
    const pred = { key: '', t: 0, pts: null, end: null, refId: null, job: null };
    let inRender = false;

    // The bodies copied for a prediction: all of them, or in a crowded scene only those whose pull on
    // the body matters (the heaviest few, with the body itself and those it is measured from): a light
    // swarm body barely moves it, and leaving the swarm out keeps the prediction long and quick.
    function predictionBodies(b, p, ref) {
        if (bodies.length <= PREDICT_ALL) return bodies;
        const src = bodies.slice().sort((q, r) => r.m - q.m).slice(0, PREDICT_HEAVY);
        for (const q of [b, p, ref].concat(turnBodies())) if (q && !src.includes(q)) src.push(q);
        return src;
    }

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
            const v = aimedVelocity(b);
            return { v: [v.x, v.y] };
        }
        if (settings.placement === 'circular') {
            const p = placementPrimary(b.x, b.y, b.m, b);
            if (p) {
                const c = circularLaunch(b, p, d && d.isNew ? orbitSense(p, b) : senseAround(b, p), isSatellite(p));
                return { v: c.b, p, pv: c.p };
            }
        }
        if (settings.placement === 'rest') { const fv = frameVelocity(b.x, b.y); return { v: [fv.x, fv.y] }; }
        return { v: [b.vx, b.vy] };
    }

    function predictPath(b, d) {
        const rel = releaseVelocity(b, d);
        const p = placementPrimary(b.x, b.y, b.m, b);
        const L = frameId !== null && frameId !== b.id ? bodyById(frameId) : null;
        // (in a rotating frame the path is worked out as seen turning with the pair: see turnedSeen)
        const ref = turn.on ? null : L || (p && p.m >= b.m ? p : null);
        // Worked out again when anything changes, but at most 20 times a second while the others move.
        // While drawing, it takes at most PREDICT_MS a frame and carries on in the next ones (the path so
        // far is shown meanwhile).
        const key = [b.id, b.x, b.y, rel.v[0], rel.v[1], ref ? ref.id : turn.on ? 't' : 'c', settings.realistic, settings.merge, bodies.length].join('|');
        const now = performance.now();
        const same = pred.key.split('|')[0] === String(b.id);
        if (pred.pts && (key === pred.key || (!paused && same && (now - pred.t < 50 || (pred.job && now - pred.t < 400))))) {
            if (pred.job) runPrediction(inRender ? PREDICT_MS : Infinity);
            return pred;
        }
        pred.key = key; pred.t = now; pred.refId = ref ? ref.id : turn.on ? TURN_REF : null;
        // The copy
        const src = predictionBodies(b, rel.p, ref);
        const list = src.map((q) => ({ x: q.x, y: q.y, vx: q.vx, vy: q.vy, m: q.m, R: q.R, grp: q.grp, ax: 0, ay: 0 }));
        const me = list[src.indexOf(b)];
        me.vx = rel.v[0]; me.vy = rel.v[1];
        if (rel.p) { const pc = list[src.indexOf(rel.p)]; pc.vx = rel.pv[0]; pc.vy = rel.pv[1]; }
        const rc = ref ? list[src.indexOf(ref)] : null;
        const origin = () => {
            if (rc) return [rc.x, rc.y];
            let M = 0, X = 0, Y = 0;
            for (const q of list) { M += q.m; X += q.m * q.x; Y += q.m * q.y; }
            return [X / M, Y / M];
        };
        // Where a body of the copy is, relative to the origin (or in a rotating frame, to the turning pair)
        const seen = turnedSeen(src, list) || ((q) => { const o = origin(); return [q.x - o[0], q.y - o[1]]; });
        // How long to look ahead: about one orbit if it is bound (two-body estimate), otherwise until it
        // is well out of view
        const pr = predictLaunch(b);
        const tMax = pr && pr.el.bound ? 1.6 * pr.el.T : 6 * scene.Tref;
        const rMax = 2.5 * Math.max(viewW, viewH) / scale;
        const pairs = Math.max(1, (list.length * (list.length - 1)) / 2);
        const budget = Math.min(20000, Math.floor(PREDICT_PAIRS / (3 * pairs)));
        const pts = seen(me);
        pred.pts = pts;
        pred.end = 'cut';   // (until it finishes: the path so far, with no arrowhead at its end)
        pred.job = { list, me, origin, seen, pr, tMax, rMax, budget, k: 0, t: 0, lx: pts[0], ly: pts[1], ang: Math.atan2(pts[1], pts[0]), swept: 0, tmin: gravity(list) };
        runPrediction(inRender ? PREDICT_MS : Infinity);
        return pred;
    }

    // Carry the prediction on for up to ms milliseconds (it ends when the path closes, hits something,
    // leaves the view or uses up its budget)
    function runPrediction(ms) {
        const job = pred.job, list = job.list, me = job.me, pts = pred.pts, pr = job.pr;
        const t0 = performance.now();
        const px = 1.5 / scale;   // keep points about 1.5 px apart
        let { lx, ly, ang, swept, t, tmin } = job;
        let end = null;
        for (; job.k < job.budget && t < job.tMax; job.k++) {
            if ((job.k & 15) === 15 && performance.now() - t0 > ms) {
                Object.assign(job, { lx, ly, ang, swept, t, tmin });
                return;
            }
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
            const [x, y] = job.seen(me);
            const a = Math.atan2(y, x);
            let da = a - ang;
            if (da > Math.PI) da -= TAU; else if (da < -Math.PI) da += TAU;
            swept += da; ang = a;
            if (hit) { pts.push(x, y); end = 'hit'; break; }
            if (Math.abs(x - lx) + Math.abs(y - ly) > px) { pts.push(x, y); lx = x; ly = y; }
            if (Math.abs(swept) > TAU * 1.02) { end = 'closed'; break; }
            if (Math.hypot(x, y) > job.rMax && !(pr && pr.el.bound)) { end = 'away'; break; }
        }
        pts.push(...job.seen(me));
        pred.end = end || 'open';
        pred.job = null;
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
        const pts = turnedPath(pp);   // (turned as the view is)
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
            const w = unturnPoint(X, Y), p = placementPrimary(w.x, w.y, k.m, null);
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
            const av = b.aim ? aimedVelocity(b) : null;
            const vx = av ? av.x : b.vx, vy = av ? av.y : b.vy;
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
        if (pace.behind) return `${bodies.length > SWARM_N ? 'Many bodies' : 'Slowed down'}: running at ${fmtFactor(pace.ratio * settings.speed)}×`;
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
    // predicted paths are on). It is started again only when something has changed (while running, ten
    // times a second at most); like every prediction made while drawing, it takes at most PREDICT_MS a
    // frame and carries on in the next frames until the path is whole.
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
        // (an unfinished prediction is carried on every frame, PREDICT_MS at a time, until it is whole)
        const going = !!(pred.job && P && P.bid === b.id && P.end === 'cut');
        if (P && P.bid === b.id && !going && (paused ? P.paused && !edit.previewDirty : now - P.t < PREVIEW_EVERY_MS)) return P;
        // The body's own velocity, given to predictPath as an aim (which it reads) for this call only
        const fv = frameVelocity();
        b.aim = { vx: b.vx - fv.x, vy: b.vy - fv.y, k: 1, ref: null, frameV: fv, snap: null };
        if (edit.previewDirty || !P || P.bid !== b.id) pred.key = '';
        let pp;
        try { pp = predictPath(b, null); } finally { b.aim = null; }
        edit.preview = { bid: b.id, pts: pp.pts, end: pp.end, refId: pp.refId, t: going ? P.t : now, cost: performance.now() - now, paused };
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
            const w = unturnPoint(wx(d.cx), wy(d.cy)), b = addBody(d.kind, w.x, w.y);   // (from the drawn view to the world)
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
            const av = aimedVelocity(b), v = fmtSpeedKms(Math.hypot(av.x - (L ? L.vx : totals(bodies).vx), av.y - (L ? L.vy : totals(bodies).vy)) * AUYR_KMS);
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
        turnAim(b.aim);   // (a turned view: aimed as drawn, see aimedVelocity)
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
        if (a.turn && turn.on) return frameVelocity(b.x, b.y);   // (at rest in a rotating frame, where it is now)
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
        const av = aimedVelocity(b);   // (the world velocity aimed)
        const vc = Math.sqrt((G * (b.m + p.m)) / r), ve = Math.SQRT2 * vc;
        const ux = av.x - p.vx, uy = av.y - p.vy;
        const tol = SNAP_PX / a.k;
        let to = null;
        for (const s of [1, -1]) {
            const cx = (-s * ry / r) * vc, cy = (s * rx / r) * vc;
            if (Math.hypot(ux - cx, uy - cy) < tol) { to = [cx, cy]; a.snap = 'circular'; break; }
        }
        const u = Math.hypot(ux, uy);
        if (!to && u > 0 && Math.abs(u - ve) < 0.7 * tol) { to = [(ux * ve) / u, (uy * ve) / u]; a.snap = 'escape'; }
        if (to) setAimedVelocity(b, to[0] + p.vx, to[1] + p.vy);
    }

    function startHold(b, d) {
        beginGesture(b, d.mode);   // (edit history: the whole drag is one step, from before the body is held)
        updateDrawnPositions();
        // A frame that moves with this body must stand still while it is dragged
        // (a rotating frame moves with both of its pair, and freezes its angle too)
        if (!freeze && (frameId === null || frameId === b.id || turnUses(b))) freeze = { x: F.x, y: F.y, phi: turn.phi };
        b.held = { offX: b.dx - F.x, offY: b.dy - F.y };
        d.frameV = frameVelocity(b.x, b.y);
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
                const v = aimedVelocity(b);
                b.vx = v.x; b.vy = v.y;
                resetTracking(b);
                k2.bid = null;
            } else if (d.mode === 'move' && d.moved) {
                launch(b, false);
            }
        }
        b.aim = null;
        b.held = null;
        if (d.mode === 'move' && d.moved) clearTrail(b);
        if ((frameId === b.id || turnUses(b)) && d.moved) clearAllTrails();
        forcesDirty = true;
        const stillHeld = bodies.some((c) => c.held);
        if (freeze && !stillHeld) {
            const fz = freeze;
            freeze = null;
            updateDrawnPositions();
            keepScreen(fz);   // (and a rotating frame's angle glides on from where it was frozen)
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
            const o = unturnVec(b.held.offX, b.held.offY);   // (held in the drawn view, which may be turned)
            b.x = origin.x + o.x;
            b.y = origin.y + o.y;
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
                const rx = bi.x - bj.x, ry = bi.y - bj.y;
                if (bi.grp && bi.grp === bj.grp) {
                    // pieces of one torn-apart body: the softened potential of their softened pull
                    const e = 0.5 * (softLength(bi) + softLength(bj));
                    pe -= (G * bi.m * bj.m) / Math.sqrt(rx * rx + ry * ry + e * e);
                    continue;
                }
                const r = Math.sqrt(rx * rx + ry * ry);
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
        for (const u of groupEnergy.values()) pe -= u;
        return { ke, pe, total: ke + pe };
    }

    function angularMomentum() {
        const c = totals(bodies);
        let L = 0;
        for (const b of bodies) L += b.m * ((b.x - c.x) * (b.vy - c.vy) - (b.y - c.y) * (b.vx - c.vx));
        return L;
    }

    // The graphs take a point every 60th of the scene's reference period, but are redrawn at most ten
    // times a second (at high speeds points come faster than that)
    let chartsDirty = false, chartsNextDraw = 0;
    function sampleCharts() {
        if (!chartsVisible()) return;
        const now = performance.now();
        if (chartsDirty && now >= chartsNextDraw) {
            charts.energy.update('none');
            charts.orbit.update('none');
            chartsDirty = false;
            chartsNextDraw = now + 100;
        }
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
        }
        chartsDirty = true;
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
            // The close pairs being followed by the two-body drift (they end with some hysteresis, so
            // running again needs the same ones to repeat exactly), and the binding energy booked for
            // bodies torn apart by tides
            pairs: mainPairs.map((q) => [q.a.id, q.b.id, q.fast ? 1 : 0]), groupE: Array.from(groupEnergy),
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
        const before = viewOrigin();
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
        const byNewId = new Map(list.map((b) => [b.id, b]));
        mainPairs.length = 0;
        for (const b of list) b.kep = null;
        for (const [ia, ib, fast] of s.pairs || []) {
            const a = byNewId.get(ia), b = byNewId.get(ib);
            if (a && b) { const q = { a, b, touch: false, fast: !!fast }; mainPairs.push(q); a.kep = q; b.kep = q; }
        }
        groupEnergy.clear();
        for (const [id, u] of s.groupE || []) groupEnergy.set(id, u);
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
            keepScreen(before);   // (a rotating frame's angle glides too)
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
        // R and Delete act only while the simulation is in use (it or its settings were last pressed or
        // focused, its menu is open, or it is fullscreen): Backspace pressed while reading the page
        // mustn't delete a body
        const inUse = !!popBody || hist.inUse || document.body.classList.contains('sim-fullscreen-active');
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
        const inSim = (el) => !!(el && el.closest && el.closest('.simulation-area-wrapper'));
        window.addEventListener('pointerdown', (e) => { hist.inUse = inSim(e.target); }, true);
        document.addEventListener('focusin', (e) => { if (e.target !== document.body) hist.inUse = inSim(e.target); });
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
        if (ui.frame) ui.frame.addEventListener('change', () => pickTurning(ui.frame.value) || setFrame(ui.frame.value === 'com' ? null : parseInt(ui.frame.value, 10)));
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
    // Main loop (exactly one). Each frame's time is measured in three parts (physics, drawing and the
    // rest) and smoothed. The physics gets what is left of 80% of the time between frames (as measured,
    // so a 120 Hz screen gets half as much per frame) after the other two, between 3 and PHYSICS_MS ms;
    // if drawing alone takes too long, the trails are drawn more coarsely first
    // (quality below 1), before the simulation itself has to slow down. Readouts, primaries in a crowded
    // scene and the graphs are updated about ten times a second rather than every frame.
    // ------------------------------------------------------------------
    let fpsFrames = 0, fpsTime = 0;
    let eccNext = 0, readoutNext = 0, primNext = 0;
    const perf = { physics: 0, render: 0, other: 0, frame: 0, interval: 16.7, steps: 0, ratio: 1, quality: 1, req: 0, got: 0, win: 0 };
    const smooth = (old, v) => old + 0.1 * (v - old);

    function frame(ts) {
        requestAnimationFrame(frame);
        const dtReal = lastFrameTs ? Math.min(0.1, (ts - lastFrameTs) / 1000) : 0;
        lastFrameTs = ts;
        const t0 = performance.now();
        updateScale();
        applyHolds();
        let steps = 0;
        if (!paused && dtReal > 0) {
            const want = dtReal * settings.speed * rate();
            const before = simTime + acc;
            steps = advance(want, 0, clamp(0.8 * Math.min(perf.interval, 20) - perf.render - perf.other, 3, PHYSICS_MS));
            applyHolds();
            perf.req += want;
            perf.got += simTime + acc - before;
        } else {
            slowedDown = false;
            if (forcesDirty) computeForces();
        }
        const t1 = performance.now();
        lag = paused ? 0 : clamp(acc, 0, nextDt);
        if (bodies.length <= SWARM_N || ts >= primNext) { computePrimaries(); primNext = ts + 100; }
        stepViewAnimation(dtReal);
        updateScale();
        updateDrawnPositions();
        const t2 = performance.now();
        render();
        const t3 = performance.now();
        if (ts >= readoutNext) { updateReadouts(); readoutNext = ts + 100; }
        updatePopover(false);
        sampleCharts();
        if (ts > eccNext) { syncEccentricity(false); eccNext = ts + 200; }
        for (const d of drags.values()) if ((d.mode === 'move' || (d.mode === 'aim' && d.moved)) && d.body && !paused) dragHint(d);
        const t4 = performance.now();

        perf.physics = smooth(perf.physics, t1 - t0);
        perf.render = smooth(perf.render, t3 - t2);
        perf.other = smooth(perf.other, t2 - t1 + t4 - t3);
        perf.frame = smooth(perf.frame, t4 - t0);
        perf.steps = smooth(perf.steps, steps);
        if (dtReal > 0) perf.interval = smooth(perf.interval, 1000 * dtReal);
        perf.win += dtReal;
        if (perf.win >= 0.5) {
            perf.ratio = perf.req > 0 ? perf.got / perf.req : 1;
            perf.req = perf.got = perf.win = 0;
        }
        // Drawing too slow (its commands, or the painting the browser does after them, which shows as
        // frames coming late although the script was quick): coarser and shorter trails first, finer
        // again when there is time to spare
        const lateFrames = perf.interval > 24 && perf.frame < 0.75 * perf.interval;
        if ((perf.render > 7 || lateFrames) && perf.quality > 0.2) perf.quality = Math.max(0.2, perf.quality * 0.95);
        else if (perf.render < 4 && perf.interval < 19 && perf.quality < 1) perf.quality = Math.min(1, perf.quality * 1.02);

        if (ui.fps) {
            fpsFrames++;
            fpsTime += dtReal;
            if (fpsTime >= 0.5) {
                ui.fps.textContent = `FPS: ${Math.round(fpsFrames / fpsTime)} · ${Math.round(perf.steps)} steps/frame`;
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
        // (world positions: a rotating frame turns them, see turnPoint)
        toScreen(x, y) { updateDrawnPositions(); const d = turnPoint(x, y); return { x: sx(d.x), y: sy(d.y) }; },
        toWorld(px, py) { updateDrawnPositions(); return unturnPoint(wx(px), wy(py)); },
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
            if (!b.trail || (L && !L.trail)) return out;
            const k0 = Math.max(trailFirst(b), sampleCount - TRAIL_CAP + 1, L ? trailFirst(L) : 0);
            for (let k = k0; k < sampleCount; k++) {
                const i = trailIndex(b.trail, k), io = L ? trailIndex(L.trail, k) : 2 * (k % TRAIL_CAP);
                const ox = L ? L.trail[io] : comTrail[io], oy = L ? L.trail[io + 1] : comTrail[io + 1];
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

    // Many bodies and close pairs: what the integrator is doing (for testing)
    Object.assign(window.orbitsSimulation, {
        // The close pairs followed by the exact two-body drift
        pairs: () => mainPairs.map((p) => ({ a: p.a.name, b: p.b.name, fast: p.fast })),
        step: () => ({ dt: nextDt, bodies: bodies.length, direct: bodies.length <= DIRECT_MAX, work: Object.assign({}, work) }),
        // Milliseconds per force evaluation of the bodies as they are now, by each method
        timeForces(reps) {
            const res = {};
            for (const m of ['direct', 'tree']) {
                forceMode = m;
                const t0 = performance.now();
                for (let k = 0; k < (reps || 20); k++) gravity(bodies, mainPairs);
                res[m] = (performance.now() - t0) / (reps || 20);
            }
            forceMode = 'auto';
            computeForces();
            const t0 = performance.now();
            for (let k = 0; k < (reps || 20); k++) { refreshPairs(); step(nextDt); simTime += nextDt; }
            res.step = (performance.now() - t0) / (reps || 20);
            return res;
        },
        // Smoothed per-frame milliseconds (physics, drawing, the rest), steps per frame, the simulated
        // time achieved over the time asked for, and the drawing quality (1 = full)
        perf: () => ({
            physics: perf.physics, render: perf.render, other: perf.other, frame: perf.frame,
            steps: perf.steps, speedRatio: perf.ratio, quality: perf.quality, bodies: bodies.length, slowedDown
        })
    });

    // Rotating frame, gravity well and Lagrange points (see "Rotating frame" after syncFrameUi)
    Object.assign(window.orbitsSimulation, {
        // Turn with body b and body a (by default the body b orbits); no name: back to the centre of mass
        setRotatingFrame(a, b) {
            const named = (n) => (n ? bodies.find((q) => q.name === n) || null : null);
            if (!a && !b) { setFrame(null); return false; }
            return b ? startTurning(named(b), named(a)) : startTurning(named(a));
        },
        // The rotating frame in use: the pair, the view's turn (radians), how fast the pair turns (rad/yr)
        // and the line's direction on the screen
        turning() {
            updateDrawnPositions();
            const P = turnPair();
            return { on: !!P, a: P ? P.A.name : null, b: P ? P.B.name : null, phi: turn.phi, omega: turn.omega, up: turn.up, ease: turnEase() };
        },
        // A body's place and velocity as seen in the rotating frame: along the line from A to B (x) and
        // across it (y, + ahead of B), from the pair's centre of mass (AU, AU/yr)
        rotatingState(name) {
            const P = turnPair(), q = bodies.find((o) => o.name === name);
            if (!P || !q) return null;
            const c = pairCentre(P, false), dx = P.B.x - P.A.x, dy = P.B.y - P.A.y, d = Math.hypot(dx, dy);
            const ux = dx / d, uy = dy / d, sense = pairOmega(P) < 0 ? -1 : 1;
            const u = turnVelocityAt(q.x, q.y), rx = q.x - c.x, ry = q.y - c.y, vx = q.vx - u.x, vy = q.vy - u.y;
            return { x: rx * ux + ry * uy, y: sense * (ry * ux - rx * uy), vx: vx * ux + vy * uy, vy: sense * (vy * ux - vx * uy), d };
        },
        // Lagrange points of a body and the body it orbits: positions relative to the heavier of the two
        // (AU, world axes), and along / across the line between them in units of their distance now
        lagrange(name) {
            const b = name ? bodies.find((q) => q.name === name) : null;
            const P = turnPair();
            const A = b ? (P && b === P.B ? P.A : turnPartner(b)) : null;
            if (!b || !A) return null;
            const heavy = b.m > A.m ? b : A, light = heavy === b ? A : b;
            const rx = light.x - heavy.x, ry = light.y - heavy.y, vx = light.vx - heavy.vx, vy = light.vy - heavy.vy;
            const r = Math.hypot(rx, ry);
            if (0.5 * (vx * vx + vy * vy) - G * (heavy.m + light.m) / r >= 0) return null;
            const Q = { A: heavy, B: light, mu: light.m / (heavy.m + light.m), sense: rx * vy - ry * vx < 0 ? -1 : 1 };
            const pts = lagrangePoints(Q, false), out = { primary: heavy.name, secondary: light.name, mu: Q.mu, d: r, dKm: r * AU_KM };
            pts.forEach((p, i) => {
                out[`L${i + 1}`] = { x: p.x, y: p.y, along: p.along, across: p.across, km: Math.hypot(p.x, p.y) * AU_KM, text: lagrangeText(i, Q) };
            });
            return out;
        },
        // The markers drawn in the last frame (CSS px)
        lagrangeMarkers: () => lagrangeShown.map((q) => ({ name: `L${q.i + 1}`, x: q.x, y: q.y, text: q.text })),
        setWell(on) { setWell(on); },
        setLagrange(on) { setLagrange(on); },
        // The gravity well's last picture: grid, contour step and levels, cost (ms) and how many so far
        wellInfo: () => Object.assign({ on: settings.well, cost: well.cost, count: well.count, wait: well.wait }, well.info || {})
    });
    bindWell();

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
