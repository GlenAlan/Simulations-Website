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
 *   Roche limit of a much denser body; its pieces pull on each other (softened) as well as on the rest, and
 *   each is followed exactly round the body it is orbiting, so the swiftest doesn't hold back the rest.
 *   Compact bodies close together also get the 2PN terms and gravitational-wave radiation reaction (2.5PN),
 *   so they spiral in, and plunge together at their innermost stable orbit. A card measures how far the
 *   chosen body's orbit turns each time round against Einstein's formula, and follows the waves.
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
        ecc: byId('eccSlider'), eccVal: byId('eccVal'), eccName: byId('eccName'),
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
    const PIECE_TRAIL = 1024;             // ...and for a piece of a torn-apart body
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
        ['sun', 'earth', 'moon', 'jupiter', 'comet', 'blackhole'],
        ['dwarf', 'redgiant', 'bluegiant', 'browndwarf', 'whitedwarf', 'neutron', 'mars', 'asteroid', 'custom']   // ("More bodies")
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
            tip: 'With Kepler\'s 2nd law on, the shaded areas stay equal as the planet speeds up.',
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
            tip: () => (frameId !== null && bodyById(frameId) && bodyById(frameId).name === 'Giant planet' ? 'The star circles the giant planet, as the Sun seems to circle Earth.' : 'View from the giant planet: the star circles it, as the Sun seems to circle Earth.'),
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
            tip: 'Three equal stars chase each other round a figure of eight: a rare stable dance.',
            bodies: (function () {
                // Chenciner & Montgomery's figure-of-eight orbit (G = m = 1), scaled to 1 AU and 1 M_sun.
                const vs = Math.sqrt(G);           // velocity unit: AU/yr
                const x1 = 0.97000436, y1 = -0.24308753, vx3 = -0.93240737, vy3 = -0.86473146;
                return [
                    { kind: 'sun', name: 'Star A', at: [x1, y1], v: [-vx3 / 2 * vs, -vy3 / 2 * vs] },
                    { kind: 'sun', name: 'Star B', color: '#ff9a52', at: [-x1, -y1], v: [-vx3 / 2 * vs, -vy3 / 2 * vs] },
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
            tip: 'Three stars start at rest. Who gets thrown out? Then press Reverse.',
            bodies: [
                { kind: 'sun', name: 'Star A', m: 3, R: 1.74e6, color: '#ffd166', at: [100, 300] },
                { kind: 'sun', name: 'Star B', m: 4, R: 2.0e6, color: '#ff9a52', at: [-200, -100] },
                { kind: 'sun', name: 'Star C', m: 5, R: 2.3e6, color: '#8fb8ff', at: [100, -100] }
            ]
        },
        // A probe leaves Earth's orbit at 39 km/s, a little faster than the cheapest route to Jupiter, and
        // passes 5 Jupiter radii behind it after 1.8 years (Voyager 1 passed at 4.9). Jupiter turns it
        // through more than 100 degrees, which doubles its speed relative to the Sun: it leaves the solar
        // system for good.
        slingshot: {
            units: 'au', Tref: 1.4, subject: 2, forceBody: 1, trail: 7, vref: 2.75, box: [-7.4, 1.8, -3.2, 3.6],
            tip: 'The probe passes just behind Jupiter. Watch its speed relative to the Sun.',
            bodies: [
                { kind: 'sun' },
                { kind: 'jupiter', orbit: { around: 0, a: 5.2, e: 0, nu: 0, w: 103.14 } },
                { kind: 'probe', orbit: { around: 0, a: 3.50210, e: 0.714457, w: 0, nu: 0 } }
            ]
        },
        // A neutron star on an elliptical orbit 750 to 2,250 km from a black hole, once every 0.3 s. With
        // realistic physics, general relativity turns the ellipse by 17.4 degrees an orbit (Einstein's
        // formula: 16.5; the 2PN terms add the rest), and gravitational waves shrink it by about 1 km an orbit.
        blackhole: {
            units: 'km', time: 's', Tref: 0.3 / YEAR_S, subject: 1, trail: 5, realistic: true, box: [-3200, 1700, -1900, 1900].map((v) => v / AU_KM),
            tip: 'Relativity swings this orbit round into a rosette.',
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
            units: 'au', time: 'd', Tref: 0.006, subject: 1, trail: 4, realistic: true, box: [-0.64, 0.11, -0.23, 0.23],
            tip: 'At its first close pass, the black hole\'s tides tear this star apart.',
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
            tip: () => (turn.on ? 'Jupiter herds 500 asteroids. Turning with it, the patterns hold still.' : 'Jupiter herds 500 asteroids. In View from, choose Rotating with Jupiter: the patterns hold still.'),
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
            units: 'km', Tref: 0.5 / DAYS_PER_YEAR, subject: 0, forceBody: 1, vref: 0.75, trail: 1, swarm: true, progress: true, box: [-50000, 50000, -50000, 50000].map((v) => v / AU_KM),
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
        // The Sun and Mercury alone, with realistic physics: relativity turns Mercury's orbit forward by
        // 6 pi GM/(c^2 a (1 - e^2)) = 0.1035" each time round, 43" a century. (The other planets turn it by
        // about 532" a century more, as in "Inner planets": what Newton could explain; the 43" left over
        // was explained by Einstein in 1915.)
        mercury: {
            units: 'au', Tref: 87.969 / DAYS_PER_YEAR, subject: 1, trail: 4, realistic: true, box: [-0.52, 0.52, -0.52, 0.52],
            tip: 'Speed it up: this orbit turns 43″ a century.',
            bodies: [
                { kind: 'sun' },
                { kind: 'mercury', orbit: { around: 0, a: 0.387098, e: 0.205630, w: 77.46, nu: 0 } }
            ]
        },
        // Two black holes of 36 and 29 solar masses, like the first pair LIGO heard (GW150914, 2015), 1,200
        // km apart and going round each other 10 times a second: their gravitational waves (20 Hz) are
        // about to enter LIGO's range. They start on a circular orbit as relativity has it here (r omega^2
        // equal to the pull with its 1PN and 2PN terms: about 0.93 of Kepler's omega), already closing at
        // Peters' rate, dr/dt = -(64/5) eta (GM)^3/(c^5 r^3). The waves carry off their orbital energy: they
        // spiral together, faster and faster, and plunge at their innermost stable orbit (576 km) after
        // about 0.4 s (Peters' formula: 0.61 s to reach zero; at this distance the relativistic corrections
        // to that are large).
        inspiral: (function () {
            const m1 = 36, m2 = 29, M = m1 + m2, eta = (m1 * m2) / (M * M), r = 1200 / AU_KM, gm = G * M, g = gm / (C2 * r);
            // x = r^3 omega^2 / GM: 1 + (1 + 3 eta) x g - (4 + 2 eta) g + 2PN terms (from pnPair at rdot = 0)
            let x = 1;
            for (let k = 0; k < 60; k++) {
                x = 1 + (1 + 3 * eta) * x * g - (4 + 2 * eta) * g
                    + g * g * ((3 * eta - 4 * eta * eta) * x * x + (2 * eta * eta - 6.5 * eta) * x + 9 + 21.75 * eta);
            }
            const w = Math.sqrt((x * gm) / (r * r * r));
            const vr = (-64 / 5) * eta * gm * gm * gm / (C2 * C2 * C_LIGHT * r * r * r), vt = r * w;
            return {
                units: 'km', time: 's', Tref: TAU / w, subject: 1, trail: 6, realistic: true, box: [-1300, 1300, -850, 850].map((v) => v / AU_KM),
                tip: 'Gravitational waves drain the orbit until the black holes merge.',
                bodies: [
                    { kind: 'blackhole', name: 'Black hole A', m: m1, R: horizonKm(m1), at: [-(m2 / M) * r, 0], v: [-(m2 / M) * vr, -(m2 / M) * vt] },
                    { kind: 'blackhole', name: 'Black hole B', m: m2, R: horizonKm(m2), color: '#8fb8ff', at: [(m1 / M) * r, 0], v: [(m1 / M) * vr, (m1 / M) * vt] }
                ]
            };
        })(),
        empty: {
            units: 'au', Tref: 1, subject: 0, vref: TAU, box: [-1.5, 1.5, -1.5, 1.5],
            bodies: [{ kind: 'sun' }]
        }
    };

    // ------------------------------------------------------------------
    // Star colours from temperature. A main-sequence star's surface temperature follows from its mass:
    // the Stefan-Boltzmann law, L = 4 pi R^2 sigma T^4, with the main-sequence fits L ~ M^3.5 (the
    // mass-luminosity relation; e.g. N. Duric, Advanced Astrophysics, 2004) and R ~ M^0.74 gives
    // T ~ (L / R^2)^(1/4) = M^0.505, so T = 5778 K x (M / M_sun)^0.505. That is a rough fit: 3,100 K for a
    // red dwarf of 0.3 M_sun and 22,700 K for 15 M_sun, where real stars are nearer 3,400 K and 30,000 K.
    //   The colour of a blackbody at T is Tanner Helland's fit to Mitchell Charity's blackbody colour
    // table ("How to convert temperature (K) to RGB", tannerhelland.com, 2012). Seen from space the Sun
    // is white (the fit gives it 255, 242, 231) and other stars are pale too, but this page, like most
    // pictures, draws the Sun a warm yellow (#ffd166). So the colours are deepened (each channel taken
    // 1.3 times as far from white) and, near the Sun's temperature, shifted towards that yellow by the
    // Sun's own difference from it, fading out within about a third of its temperature either way: a
    // star of the Sun's mass keeps its yellow, lighter stars run through gold and orange to red, heavier
    // ones through cream and white to blue. The brightest channel is then set to full (stars shine).
    //   Colours are worked out once per mass bucket (COLOUR_STEPS per factor of ten) and kept, so the
    // glow sprites, which are keyed by colour, stay few. Red giants, white dwarfs, neutron stars and black
    // holes are not on the main sequence and keep their kind's look; custom bodies keep their colours.
    // A star takes the colour of its mass when it comes from the palette (the palette's stars are given
    // it below) and when its mass changes (the menu's mass slider, or a merger), unless the user picked
    // another: a colour counts as picked when it is neither its kind's colour nor the colour of its mass.
    // That is worked out from the body's own colour and mass, which undo puts back, so nothing else needs
    // keeping.
    // ------------------------------------------------------------------
    const T_SUN = 5778;                   // K
    const MASS_TEMP_POWER = 0.505;
    const COLOUR_STEPS = 40;              // colours per factor of ten in mass (6% apart in mass, 3% in temperature)
    const DEEPEN = 1.3;
    const SUN_TINT_COOL = 0.35, SUN_TINT_HOT = 0.3;   // how far the Sun's yellow reaches (in ln T)
    const KEEPS_LOOK = { redgiant: 1, whitedwarf: 1, neutron: 1, blackhole: 1, custom: 1 };
    const KIND_COLOUR = {};               // each kind's colour as first defined: the scenes were designed with these
    for (const k of Object.keys(KINDS)) KIND_COLOUR[k] = KINDS[k].color;
    const starColourCache = new Map();

    // Helland's blackbody colour at T kelvin, [r, g, b] from 0 to 255
    function blackbodyRgb(T) {
        const t = T / 100;
        const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
        const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
        const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
        return [r, g, b].map((v) => Math.min(255, Math.max(0, v)));
    }

    // The colour a star at T kelvin is drawn in (see above)
    function temperatureColour(T) {
        const bb = blackbodyRgb(T), b0 = blackbodyRgb(T_SUN);
        const sun = parseInt(KIND_COLOUR.sun.slice(1), 16);
        const lnT = Math.log(T / T_SUN), s = lnT < 0 ? SUN_TINT_COOL : SUN_TINT_HOT;
        const w = Math.exp(-(lnT / s) * (lnT / s));
        const deepen = (v) => 255 - DEEPEN * (255 - v);
        const c = [0, 1, 2].map((i) => deepen(bb[i]) + w * (((sun >> (16 - 8 * i)) & 255) - deepen(b0[i])));
        const top = Math.max(c[0], c[1], c[2], 1);
        return `#${c.map((v) => Math.round(Math.min(255, Math.max(0, (v * 255) / top))).toString(16).padStart(2, '0')).join('')}`;
    }

    // Main-sequence surface temperature (K) of a star of m solar masses, and the colour it is drawn in
    const temperatureOf = (m) => T_SUN * Math.pow(m, MASS_TEMP_POWER);
    function starColour(m) {
        const k = Math.round(Math.log10(Math.max(m, 1e-6)) * COLOUR_STEPS);
        let c = starColourCache.get(k);
        if (!c) {
            c = temperatureColour(temperatureOf(Math.pow(10, k / COLOUR_STEPS)));
            starColourCache.set(k, c);
        }
        return c;
    }

    // The colour a body's mass gives it: a star's from its temperature, anything lighter its kind's
    function colourForMass(b) {
        return b.m >= STAR_MASS ? starColour(b.m) : (KINDS[b.kind] || KINDS.custom).color;
    }
    // Does its colour follow its mass (not picked by the user)?
    function autoColoured(b) {
        if (KEEPS_LOOK[b.kind]) return false;
        const k = KINDS[b.kind];
        return b.color === KIND_COLOUR[b.kind] || (!!k && b.color === k.color) || (b.m >= STAR_MASS && b.color === starColour(b.m));
    }
    // Make a change to b's mass (in change); its colour follows unless the user picked one
    function withStarColour(b, change) {
        const auto = autoColoured(b);
        change();
        if (auto && !KEEPS_LOOK[b.kind]) b.color = colourForMass(b);
    }

    // The palette's stars get the colour of their mass (the Sun's stays #ffd166)...
    for (const k of Object.keys(KINDS)) {
        if (KINDS[k].m >= STAR_MASS && !KEEPS_LOOK[k]) KINDS[k].color = starColour(KINDS[k].m);
    }
    // ...but the scenes keep the colours they were designed with
    for (const key of Object.keys(SCENES)) {
        for (const s of SCENES[key].bodies) {
            if (!s.color && KINDS[s.kind] && KINDS[s.kind].color !== KIND_COLOUR[s.kind]) s.color = KIND_COLOUR[s.kind];
        }
    }

    // ------------------------------------------------------------------
    // The Solar System on a date: the Sun, the eight planets and Pluto (a dwarf planet) where they
    // really were, or will be, on the start date chosen in the settings (today to begin with).
    //   Positions come from JPL's "Keplerian Elements for Approximate Positions of the Major Planets"
    // (E. M. Standish, JPL Solar System Dynamics, https://ssd.jpl.nasa.gov/planets/approx_pos.html),
    // Table 1: each orbit's mean elements at J2000 (1 Jan 2000, 12:00) and their rates of change per
    // century, fitted to JPL's DE405 ephemeris over 1800 to 2050 (to within 15" to 10' in direction).
    // Pluto has since been taken off that page; its row is the one the table first gave. For a date, each
    // element is its J2000 value plus its rate times the centuries since; Kepler's equation
    // M = E - e sin E gives the eccentric anomaly E from the mean anomaly M (mean longitude less the
    // longitude of perihelion), and from E the position on the ellipse, (a(cos E - e), b sin E) from the
    // Sun with x towards perihelion. The velocity is the two-body orbit's there (see solarSystemBodies
    // and planetState for what each orbit is taken round, and its size).
    //   Flat: the simulation is in two dimensions, the plane of Earth's orbit (the ecliptic), and the other
    // orbits are tilted from it by a few degrees (Mercury 7, Pluto 17). Dropping each planet's height above
    // the plane (projecting) would shorten a tilted orbit unevenly, changing its energy and so its period
    // (Mercury's by 1.5 to 3%, Pluto's by 10 to 16%, depending on where they are). Instead each orbit is
    // turned flat about the line where it crosses the plane: its size, shape and period, and the planet's
    // distance and speed, stay exactly right, and its direction from the Sun is off by at most about
    // i^2/4 radians: 0.2 degrees for Mercury, 0.05 or less for the other planets, 1.3 for Pluto.
    //   Masses: the IAU 2009 System of Astronomical Constants (Luzum et al. 2011, Celest. Mech. Dyn.
    // Astron. 110, 293), as the Sun's mass over each planet's with its moons; Earth on its own (Earth/Moon
    // 81.30057), and Pluto with Charon (1.46 x 10^22 kg, from New Horizons). Radii: IAU mean radii.
    // The table gives the Earth-Moon centre of mass ("EM Bary"); Earth stands there without the Moon,
    // which at this scale would be under a pixel from it (and shrink Earth's disc to a dot).
    //   As in every scene, the centre of mass of the whole system is then put at rest at the origin: the
    // Sun starts with its own wobble (about 13 m/s, mostly from Jupiter) and nothing drifts away.
    // ------------------------------------------------------------------
    const JD_UNIX = 2440587.5;            // Julian date of 1 Jan 1970, 00:00 UTC
    const JD_J2000 = 2451545.0;           // 1 Jan 2000, 12:00
    const TO_RAD = Math.PI / 180;
    const jdFromMs = (ms) => JD_UNIX + ms / 86400000;
    const msFromJd = (jd) => (jd - JD_UNIX) * 86400000;
    const jdOfDate = (y, m, d) => jdFromMs(Date.UTC(y, m - 1, d));
    const JD_MIN = jdOfDate(1800, 1, 1), JD_MAX = jdOfDate(2050, 12, 31);   // the table's range

    Object.assign(KINDS, {
        saturn: { name: 'Saturn', m: 1 / 3497.9018, R: 58232, color: '#e3c47a', info: 'the ringed giant planet' },
        uranus: { name: 'Uranus', m: 1 / 22902.98, R: 25362, color: '#9ad8dc', info: 'an ice giant' },
        neptune: { name: 'Neptune', m: 1 / 19412.26, R: 24622, color: '#6f8ff0', info: 'the farthest planet' },
        pluto: { name: 'Pluto', m: 1 / 1.3605e8, R: 1188, color: '#c9a98c', info: 'a dwarf planet' }
    });

    // Kind, mass (M_sun), radius (km), then a (AU), e, I, L, longitude of perihelion, longitude of the
    // ascending node (degrees) at J2000, and their rates per century
    const PLANET_TABLE = [
        ['mercury', 1 / 6023600, 2439.4, 0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593,
            0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
        ['venus', 1 / 408523.71, 6051.8, 0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255,
            0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
        ['earth', 81.300569 / (82.300569 * 328900.56), 6371.0, 1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0,
            0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
        ['mars', 1 / 3098703.59, 3389.5, 1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
            0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
        ['jupiter', 1 / 1047.348644, 69911, 5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
            -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
        ['saturn', 1 / 3497.9018, 58232, 9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
            -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
        ['uranus', 1 / 22902.98, 25362, 19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503,
            -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
        ['neptune', 1 / 19412.26, 24622, 30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574,
            0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
        ['pluto', 1 / 1.3605e8, 1188.3, 39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684,
            -0.00031596, 0.00005170, 0.00004818, 145.20780515, -0.04062942, -0.01183482]
    ];

    // A planet's position (AU) and velocity (AU/yr) at Julian date jd from the table: flat (x, y, vx, vy,
    // as in the scene) and, for comparison, JPL's true ecliptic coordinates (x3, y3, z3). Without inner,
    // as the table has it (mu = G(M_sun + m)). With inner (the mass it orbits, in M_sun), as the scene
    // starts it: the orbit's size comes from its mean motion (the rate of L) by Kepler's third law,
    // a^3 = G(inner + m) / n^2, rather than the table's a. Both are fits, and they disagree slightly (by
    // 1 part in 100,000 for Mercury, 3 in 10,000 for Saturn going round the Sun and Jupiter); this way
    // the planets keep pace with the table's mean motion, and after a century of the simulation's own
    // gravity (Mercury's 415 orbits) each is still within about a degree of where the table puts it.
    function planetState(row, jd, inner) {
        const T = (jd - JD_J2000) / 36525;
        const el = (i) => row[3 + i] + row[9 + i] * T;
        const n = (row[12] * TO_RAD) / 100;   // mean motion, radians per year
        const a = inner ? Math.cbrt((G * (inner + row[1])) / (n * n)) : el(0);
        const e = el(1), incl = el(2) * TO_RAD, L = el(3), peri = el(4), node = el(5);
        const M = ((((L - peri) % 360) + 540) % 360 - 180) * TO_RAD;   // -180 to 180 degrees
        let E = M + e * Math.sin(M);
        for (let k = 0; k < 30; k++) {
            const dE = (M - (E - e * Math.sin(E))) / (1 - e * Math.cos(E));
            E += dE;
            if (Math.abs(dE) < 1e-13) break;
        }
        const b = a * Math.sqrt(1 - e * e);
        const px = a * (Math.cos(E) - e), py = b * Math.sin(E);
        const Edot = Math.sqrt((G * ((inner || 1) + row[1])) / (a * a * a)) / (1 - e * Math.cos(E));   // dE/dt
        const pvx = -a * Math.sin(E) * Edot, pvy = b * Math.cos(E) * Edot;
        // Flat: perihelion at its longitude in the ecliptic
        const cp = Math.cos(peri * TO_RAD), sp = Math.sin(peri * TO_RAD);
        // True: turned by the argument of perihelion, the inclination and the node (JPL's step 5)
        const w = (peri - node) * TO_RAD, O = node * TO_RAD;
        const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(incl), si = Math.sin(incl);
        return {
            x: cp * px - sp * py, y: sp * px + cp * py, vx: cp * pvx - sp * pvy, vy: sp * pvx + cp * pvy,
            x3: (cw * cO - sw * sO * ci) * px + (-sw * cO - cw * sO * ci) * py,
            y3: (cw * sO + sw * cO * ci) * px + (-sw * sO + cw * cO * ci) * py,
            z3: sw * si * px + cw * si * py
        };
    }

    // The scene's bodies for a start date (relative to the Sun; loading the scene moves them to the centre
    // of mass). Each planet's orbit is taken round the centre of mass of the Sun and the planets inside
    // it, with their mass (Jacobi coordinates, as in planetary codes): from out there they pull almost as
    // one body at that point. The Sun itself swings round Jupiter's way at about 12 m/s, so an orbit taken
    // round the Sun alone would start Saturn and the planets beyond with the wrong energy, their periods
    // out by up to 1%. The Sun's offset from that point (under 0.006 AU) moves them by under 0.04 degrees.
    function solarSystemBodies(jd) {
        const list = [{ kind: 'sun' }];
        let M = 1, X = 0, Y = 0, VX = 0, VY = 0;   // mass, position and velocity of the bodies inside
        for (const row of PLANET_TABLE) {
            const m = row[1], s = planetState(row, jd, M);
            const x = X + s.x, y = Y + s.y, vx = VX + s.vx, vy = VY + s.vy;
            list.push({ kind: row[0], m, R: row[2], at: [x, y], v: [vx, vy] });
            X = (M * X + m * x) / (M + m); Y = (M * Y + m * y) / (M + m);
            VX = (M * VX + m * vx) / (M + m); VY = (M * VY + m * vy) / (M + m);
            M += m;
        }
        return list;
    }

    // Today (local calendar), within the table's range
    function todayJd() {
        const now = new Date();
        return Math.min(JD_MAX, Math.max(JD_MIN, jdOfDate(now.getFullYear(), now.getMonth() + 1, now.getDate())));
    }
    // jd: the start date of the scene as loaded (undo steps keep it); chosen: the date it is loaded for next
    const startDate = { jd: todayJd(), chosen: 0 };
    startDate.chosen = startDate.jd;

    // Scenes with dated: true start on the start date, and the info bar shows the date
    SCENES.solar = {
        units: 'au', Tref: 1, subject: 3, dated: true, box: [-1.8, 1.8, -1.8, 1.8],
        tip: 'Real positions on the start date, in the settings. Fit view shows the outer planets.',
        get bodies() { return solarSystemBodies(startDate.chosen); }
    };

    // 'YYYY-MM-DD' to a Julian date (00:00 UTC), or NaN; and back
    function parseIsoDate(text) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || '').trim());
        if (!m) return NaN;
        const y = +m[1], mo = +m[2], d = +m[3];
        const t = Date.UTC(y, mo - 1, d), dt = new Date(t);
        return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? jdFromMs(t) : NaN;
    }
    function isoDate(jd) {
        const d = new Date(msFromJd(jd));
        const two = (n) => String(n).padStart(2, '0');
        return `${String(d.getUTCFullYear()).padStart(4, '0')}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
    }

    // A Julian date as "3 Jan 2027" (detail 'day'), "Jan 2027" ('month') or "2027" ('year')
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function fmtDate(jd, detail) {
        const d = new Date(msFromJd(jd));
        const y = d.getUTCFullYear();
        if (!isFinite(y)) return '–';
        if (detail === 'year') return String(y);
        const mon = MONTHS[d.getUTCMonth()];
        return detail === 'month' ? `${mon} ${y}` : `${d.getUTCDate()} ${mon} ${y}`;
    }

    // The day is shown only while it can be read (slow or paused); faster, the month, then the year
    function dateDetail() {
        const daysPerSecond = paused ? 0 : settings.speed * rate() * DAYS_PER_YEAR;
        return daysPerSecond <= 20 ? 'day' : daysPerSecond <= 200 ? 'month' : 'year';
    }

    // What the info bar's Time box shows: the date in a dated scene (the time since the start in its
    // tooltip), otherwise the time since the start
    function timeReadout() {
        if (!scene.dated) return fmtTime(simTime);
        const start = fmtDate(startDate.jd, 'day');
        setTitle(statBox(ui.statTime), simTime * DAYS_PER_YEAR < 1 ? `Date in the simulation, which started on ${start}`
            : `Date in the simulation: ${fmtDuration(simTime)} after its start on ${start}`);
        return { v: fmtDate(startDate.jd + simTime * DAYS_PER_YEAR, dateDetail()), u: '' };
    }

    // The settings' start date shows only for a dated scene; the Time box becomes a Date box
    Object.assign(ui, { dateRow: byId('startDateRow'), startDate: byId('startDateInput'), dateNote: byId('startDateNote') });
    function showDateUi() {
        const on = !!scene.dated;
        if (ui.dateRow && ui.dateRow.hidden === on) ui.dateRow.hidden = !on;
        if (ui.startDate && document.activeElement !== ui.startDate) {
            ui.startDate.value = isoDate(startDate.chosen);
            markDateField(true);
        }
        if (ui.statTime) ui.statTime.style.setProperty('--chars', on ? '11' : '6');
        const box = statBox(ui.statTime), label = box && box.querySelector('strong');
        if (label) label.textContent = on ? 'Date:' : 'Time:';
        if (!on) setTitle(box, 'Time since the start');
    }
    // After a scene is loaded (from loadScene)
    function syncDatedScene() {
        startDate.jd = startDate.chosen;
        showDateUi();
    }
    // After an undo, redo or "run again" (from restoreSnapshot): the snapshot's start date comes back
    function restoreStartDate(s) {
        if (s.startJD) startDate.jd = startDate.chosen = s.startJD;
        showDateUi();
    }

    // A new start date reloads a dated scene, as an undo step (even if nothing else had changed), keeping
    // the view, the trails' length and the chosen and viewed-from bodies
    function setStartDate(jd) {
        const day = Math.min(JD_MAX, Math.max(JD_MIN, jd));
        if (!scene.dated) { startDate.chosen = startDate.jd = day; showDateUi(); return; }
        const nameOf = (id) => { const b = id !== null ? bodyById(id) : null; return b ? b.name : null; };
        const keep = { zoom: view.zoom, panX: view.panX, panY: view.panY, trail: settings.trailIndex, sel: nameOf(selectedId), frame: nameOf(frameId) };
        const top = hist.undo[hist.undo.length - 1];
        startDate.chosen = day;
        hist.cleanLoad = false;   // (so the reload is an undo step: noteSceneLoad makes none for a scene restarted untouched)
        loadScene(settings.scene);
        const st = hist.undo[hist.undo.length - 1];
        if (st && st !== top) { st.label = 'change the start date'; updateHistoryUi(); }
        Object.assign(view, { zoom: keep.zoom, panX: keep.panX, panY: keep.panY, anim: null });
        settings.trailIndex = keep.trail;
        if (ui.trail) ui.trail.value = String(keep.trail);
        updateTrailLabel();
        const named = (n) => bodies.find((b) => b.name === n) || null;
        if (keep.sel && named(keep.sel)) selectedId = named(keep.sel).id;
        frameId = keep.frame && named(keep.frame) ? named(keep.frame).id : null;
        syncFrameUi();
        syncEccentricity(true);
    }

    // The date field: a date is used once it has been left alone for a moment (typing a year passes
    // through others: 0002, 0020, 0202, 2026), at once on Enter or on leaving the field. One outside the
    // table's years is marked, and said so in the note under the field, until it is put right (leaving the
    // field puts the scene's date back).
    let dateTimer = 0;
    const DATE_NOTE = ui.dateNote ? ui.dateNote.textContent : '';
    function markDateField(ok) {
        if (ok) ui.startDate.removeAttribute('aria-invalid'); else ui.startDate.setAttribute('aria-invalid', 'true');
        setText(ui.dateNote, ok ? DATE_NOTE : 'Choose a day from 1800 to 2050.');
    }
    function applyDateField() {
        clearTimeout(dateTimer);
        const jd = parseIsoDate(ui.startDate.value);
        const ok = jd >= JD_MIN && jd <= JD_MAX;
        markDateField(ok);
        if (ok && jd !== startDate.chosen) setStartDate(jd);
        return ok;
    }
    if (ui.startDate) {
        const later = () => { clearTimeout(dateTimer); dateTimer = setTimeout(applyDateField, 450); };
        ui.startDate.addEventListener('input', later);
        ui.startDate.addEventListener('change', later);
        ui.startDate.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyDateField(); } });
        ui.startDate.addEventListener('blur', () => { if (!applyDateField()) showDateUi(); });
    }

    // ------------------------------------------------------------------
    // Comet tails. Near a star a comet's ice turns to gas (from about 3 to 5 AU from a star like the Sun),
    // and the gas and dust it gives off are pushed away from the star. The gas, made into ions by the
    // star's ultraviolet light, is swept straight out by the stellar wind: a thin, straight ion tail
    // pointing directly away from the star, blue from glowing CO+ ions. Dust grains are pushed only gently,
    // by the light itself, so they keep much of the comet's own motion and fall behind it on slightly wider
    // orbits: a broad, curved, yellowish dust tail of reflected starlight, bending back along the orbit.
    // Both grow longer and brighter closer in. A star's light at the comet goes as L / d^2, with
    // L ~ M^3.5 on the main sequence, so distances are measured in "Sun-like" AU, d / sqrt(L): a tail
    // starts at TAIL_FAR of those and is fully grown at TAIL_FULL. The tails have real lengths (up to a
    // third of an AU, as for a bright comet), so they shrink as you zoom out, and never take more than a
    // quarter of the view.
    //   Cheap: only comets near a star get them (and not the dots of a crowded scene), and each tail is a
    // picture drawn once per colour, then stretched and turned into place: no gradients or arrays per frame.
    // ------------------------------------------------------------------
    const TAIL_FAR = 4, TAIL_FULL = 0.6;  // Sun-like AU
    const ION_AU = 0.45, DUST_AU = 0.28;  // tail lengths at full strength (AU)
    const TAIL_W = 256, ION_H = 32, DUST_H = 160, DUST_Y0 = 40, DUST_BEND = 60;   // the pictures (px)
    const TAIL_COLOURS = { dark: { ion: '#8cc4ff', dust: '#ffe2a6' }, light: { ion: '#2f6fd0', dust: '#b5852a' } };
    const tailStars = [];
    const tailPictures = new Map();
    const tailInfo = { drawn: 0, strength: 0, star: null, ionPx: 0 };   // the last frame's (for testing)

    // A tail's picture: pointing along +x from its head at (0, y0), fading towards its end; nested
    // layers, each a little narrower, make it brightest along the middle with soft edges. The dust tail
    // widens and bends towards +y (a quadratic curve).
    function tailPicture(kind, color) {
        const key = kind + color;
        let pic = tailPictures.get(key);
        if (pic) return pic;
        const ion = kind === 'ion';
        const H = ion ? ION_H : DUST_H, y0 = ion ? ION_H / 2 : DUST_Y0;
        pic = document.createElement('canvas');
        pic.width = TAIL_W; pic.height = H;
        const g = pic.getContext('2d');
        const fade = g.createLinearGradient(0, 0, TAIL_W, 0);
        fade.addColorStop(0, hexA(color, 1));
        fade.addColorStop(0.4, hexA(color, 0.6));
        fade.addColorStop(1, hexA(color, 0));
        g.fillStyle = fade;
        g.globalAlpha = 0.2;
        for (let layer = 0; layer < 8; layer++) {
            const f = 1 - layer / 9;
            g.beginPath();
            if (ion) {
                g.moveTo(0, y0 - 4 * f); g.lineTo(TAIL_W, y0 - f * 14); g.lineTo(TAIL_W, y0 + f * 14); g.lineTo(0, y0 + 4 * f);
            } else {
                for (let side = -1; side <= 1; side += 2) {
                    for (let i = 0; i <= 16; i++) {
                        const s = side < 0 ? i / 16 : 1 - i / 16;
                        const cx = 2 * s * (1 - s) * 0.55 * TAIL_W + s * s * TAIL_W, cy = y0 + s * s * DUST_BEND;
                        const tx = 2 * (1 - 2 * s) * 0.55 * TAIL_W + 2 * s * TAIL_W, ty = 2 * s * DUST_BEND;
                        const tl = Math.hypot(tx, ty), hw = side * f * (6 + 46 * s);
                        g.lineTo(cx - (ty / tl) * hw, cy + (tx / tl) * hw);
                    }
                }
            }
            g.closePath();
            g.fill();
        }
        tailPictures.set(key, pic);
        return pic;
    }

    // Draw a tail picture with its head at (x, y), along (ux, uy), its +y side towards (nx, ny): len px
    // long, and wide px across for each of the picture's (a long tail is narrower for its length than a
    // short one, which still needs a few pixels' width to be seen)
    function drawTailPicture(pic, x, y, ux, uy, nx, ny, len, wide, y0) {
        const k = len / TAIL_W;
        ctx.setTransform(dpr * ux * k, dpr * uy * k, dpr * nx * wide, dpr * ny * wide, dpr * (x - nx * wide * y0), dpr * (y - ny * wide * y0));
        ctx.drawImage(pic, 0, 0);
    }

    // Before the bodies (from renderFrame), so they are drawn on top
    function drawCometTails(C) {
        tailInfo.drawn = 0; tailInfo.strength = 0; tailInfo.star = null; tailInfo.ionPx = 0;
        let comets = 0;
        for (const b of bodies) if (b.kind === 'comet' && !b.grp && (!b.minor || isChosen(b))) comets++;
        if (!comets) return;
        tailStars.length = 0;
        for (const s of bodies) if (isStar(s)) tailStars.push(s);
        if (!tailStars.length) return;
        const pal = C.dark ? TAIL_COLOURS.dark : TAIL_COLOURS.light;
        const maxPx = 0.25 * Math.min(viewW, viewH);
        for (const b of bodies) {
            if (b.kind !== 'comet' || b.grp || (b.minor && !isChosen(b))) continue;
            // The star that lights it most (the largest L / d^2)
            let star = null, best = 0;
            for (const s of tailStars) {
                const dx = b.dx - s.dx, dy = b.dy - s.dy;
                const q = Math.pow(s.m, 3.5) / (dx * dx + dy * dy);
                if (q > best) { best = q; star = s; }
            }
            const dSun = 1 / Math.sqrt(best);   // its distance in Sun-like AU
            if (!star || !(dSun < TAIL_FAR)) continue;
            const u = Math.min(1, (TAIL_FAR - dSun) / (TAIL_FAR - TAIL_FULL));
            const ion = Math.min(ION_AU * u * scale, maxPx);
            const x = sx(b.dx), y = sy(b.dy);
            if (ion < 4 || x < -ion - 20 || x > viewW + ion + 20 || y < -ion - 20 || y > viewH + ion + 20) continue;
            // Away from the star (on screen)
            let ux = x - sx(star.dx), uy = y - sy(star.dy);
            const ul = Math.hypot(ux, uy);
            if (!(ul > 0)) continue;
            ux /= ul; uy /= ul;
            // Behind: against its sideways motion round the star (screen y points down; the world velocity
            // turned as the view is, as the dust's path round the star is turned with everything else)
            const rv = turnVec(b.vx - star.vx, b.vy - star.vy), vx = rv.x, vy = -rv.y;
            const along = vx * ux + vy * uy;
            let nx = along * ux - vx, ny = along * uy - vy;
            const nl = Math.hypot(nx, ny);
            if (nl > 0) { nx /= nl; ny /= nl; } else { nx = -uy; ny = ux; }
            // (on a dark page the tails add light, as gas and dust lit by the star do)
            if (C.dark) ctx.globalCompositeOperation = 'lighter';
            const dust = Math.min(DUST_AU * u * scale, maxPx);
            ctx.globalAlpha = 0.6 * u;
            drawTailPicture(tailPicture('dust', pal.dust), x, y, ux, uy, nx, ny, dust, clamp(dust / 120, 0.15, 0.6), DUST_Y0);
            ctx.globalAlpha = 0.8 * u;
            drawTailPicture(tailPicture('ion', pal.ion), x, y, ux, uy, nx, ny, ion, clamp(ion / 150, 0.2, 0.6), ION_H / 2);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
            // The coma: a haze of gas round the head
            ctx.globalAlpha = u;
            glow(x, y, 0, drawRadius(b) + (3 + 6 * u) * sizeScale, C.dark ? b.color : bodyStroke(b.color, false), 0.5);
            ctx.globalAlpha = 1;
            tailInfo.drawn++;
            if (b.id === selectedId) { Object.assign(tailInfo, { strength: u, star: star.name, ionPx: ion, ux, uy, nx, ny }); }
        }
        ctx.globalAlpha = 1;
    }

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
    const view = { zoom: 0.4, panX: 0, panY: 0, anim: null, shift: 0, shiftTo: 0 };
    let viewW = 0, viewH = 0, dpr = 1;
    // What can be seen of the canvas (its px): all of it, but for the Settings drawer over one side;
    // and where the middle of the view goes on it (see syncDrawer)
    let visL = 0, visR = 0, midX = 0;
    const drawer = { open: false, moved: false, back: null, box: null };
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
    // (Math.hypot boxes its numbers and takes far longer: this one for what runs every step or for every body)
    const hyp = (x, y) => Math.sqrt(x * x + y * y);
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
        if (exp === 0) return mant.toFixed(digits);   // (not "4.72×10⁰")
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
    // A whole number with its thousands marked, or from a billion up as ×10ⁿ, so it stays short
    const fmtWhole = (x) => (Math.abs(x) < 1e9 ? Math.round(x).toLocaleString('en-US') : fmtSci(x, 2));
    // Scenes count time in years, days (scene.time 'd', or scene.units 'km') or seconds (scene.time 's':
    // orbits round a black hole)
    const timeUnit = () => scene.time || (scene.units === 'km' ? 'd' : 'yr');
    const timeInSeconds = () => timeUnit() === 's';
    function fmtTime(yr) {
        // (the clock goes below zero when time runs backwards past the start)
        const a = Math.abs;
        if (timeInSeconds()) {
            const s = yr * YEAR_S;
            return { v: a(s) < 100 ? s.toFixed(2) : a(s) < 1000 ? s.toFixed(1) : fmtWhole(s), u: 's' };
        }
        if (timeUnit() === 'd') {
            const d = yr * DAYS_PER_YEAR;
            return { v: a(d) < 1000 ? d.toFixed(1) : fmtWhole(d), u: 'days' };
        }
        return { v: a(yr) < 100 ? yr.toFixed(2) : a(yr) < 1000 ? yr.toFixed(1) : fmtWhole(yr), u: 'yr' };
    }
    // A duration in s, days or years; precise keeps trailing zeros (a measured period: "1.00 yr")
    function fmtDuration(yr, precise) {
        if (timeInSeconds() || yr * YEAR_S < 600) {
            const s = yr * YEAR_S;
            if (s < 1) return `${precise ? s.toFixed(3) : +s.toFixed(3)} s`;
            if (s >= 1e9) return `${fmtWhole(s)} s`;
            return `${precise ? s.toFixed(s < 100 ? 2 : 0) : +s.toFixed(s < 10 ? 2 : 0)} s`;
        }
        if (timeUnit() === 'd' || yr < 0.1) {
            const d = yr * DAYS_PER_YEAR;
            if (d >= 1e9) return `${fmtWhole(d)} days`;
            if (precise) return `${d < 100 ? d.toFixed(1) : Math.round(d)} days`;
            if (d < 0.1) return `${+(d * 24).toFixed(1)} h`;   // (not "0.0 days")
            return `${d < 10 ? d.toFixed(1) : Math.round(d)} ${d < 1.5 && d >= 0.5 ? 'day' : 'days'}`;
        }
        if (precise) return `${yr < 100 ? yr.toFixed(2) : fmtWhole(yr)} yr`;
        return `${yr < 10 ? +yr.toFixed(2) : fmtWhole(yr)} yr`;
    }
    function fmtSpeedKms(kms) {
        if (kms < 0.1) return { v: (kms * 1000).toFixed(kms < 0.01 ? 2 : 1), u: 'm/s' };
        return { v: kms < 10 ? kms.toFixed(2) : kms < 1000 ? kms.toFixed(1) : fmtWhole(kms), u: 'km/s' };
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
            track: null,                  // period measurement (Kepler's 3rd law)
            // Set later on, but named here so every body has the same shape: the integrator's loops run
            // far faster over one shape than over many (with too many, each number written is boxed anew)
            hx: 0, hy: 0, slot: -1, stamp: -1, kep: null, hosts: 0, hostMass: 0, minor: false, rmax: 0, rd: 0, rh: 0, aim: null, ghost: null, heft: 0,
            navStamp: 0, navName: null, navBase: '', navNum: 0, navD: 0, navT: 0, navDepth: 0
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
    // (velocities changed, positions not) only works out again the pairs where it matters. Compact, close
    // pairs (GM/(rc^2) over RR_MIN) also get the 2PN terms and radiation reaction there: see "Relativity:
    // orbits that turn, and gravitational waves" (after the tidal break-ups).
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
    // times fewer steps per free-fall time than a point-mass orbit: still about 50 per swing through the
    // clump. (No relativity between them: GM/(rc^2) for a ninth of a star is a few millionths.) Pieces of
    // different bodies don't pull on each other at all: streams of gas passing through each other, each
    // pulled far harder by what it orbits. The pieces' relativity is in the turning of their orbits: see
    // driftHosted.
    const DIRECT_MAX = 200;               // exact pair sums up to this many bodies (about the measured crossover with the tree)
    // With the tree, its force errors (a few parts in 10,000 of the swarm's own pull) are the limit on
    // accuracy, not the steps: ETA_SWARM still gives over 600 steps per orbit at 4th order, whose errors
    // stay far below them, and lets a big swarm keep up with the clock.
    const ETA_SWARM = 0.01;
    const HEAVY_MAX = 8;                  // above it, the heaviest bodies that still pull pair by pair
    const PN_SKIP = 1e-9;
    const SOFT_STEP = 32;
    const SOFT_T2 = SOFT_STEP * SOFT_STEP;   // (the times are kept squared)
    // A piece's softening length (AU): about the size of the body it came from, more for a heavier piece.
    // (Pieces of unequal mass have paths that cross: at half this, close passes leave the energy book worse.)
    const softLength = (b) => (2 * b.R * Math.cbrt(FRAGMENTS)) / AU_KM;
    let scrCap = 0;
    let SX, SY, SVX, SVY, SM, SEPS, SGRP, SAX, SAY, SA0, SBEST, SSECOND, SPART, SPAIR, SDIR, SDPOS;
    let PAX, PAY, NAX, NAY;                  // the 1PN part of the accelerations, and the Newtonian part
    let HRX, HRY, HPX, HPY;                  // a host's pieces: positions relative to it, momenta (see driftHosted)
    let PNI = new Int32Array(256), PNJ = new Int32Array(256), pnCount = 0, pnList = null, pnN = -1, pnTmin = Infinity;
    function ensureScratch(n) {
        if (n <= scrCap) return;
        scrCap = Math.max(n, 2 * scrCap, 64);
        const f = () => new Float64Array(scrCap), k = () => new Int32Array(scrCap);
        SX = f(); SY = f(); SVX = f(); SVY = f(); SM = f(); SEPS = f(); SGRP = f(); SAX = f(); SAY = f(); SA0 = f();
        SBEST = f(); SSECOND = f(); SPART = k(); SPAIR = k(); SDIR = k(); SDPOS = k();
        PAX = f(); PAY = f(); NAX = f(); NAY = f();
        HRX = f(); HRY = f(); HPX = f(); HPY = f();
        growTreeCache(scrCap);
    }

    let gravStamp = 0;
    let anyPieces = false;   // (a torn-apart body's among them: only then do the pair sums look for pieces)
    let anyHosted = false;   // (a whole body is going round a host: see "Close pairs")
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
        anyPieces = false;
        anyHosted = false;
        for (let k = 0; k < n; k++) {
            const b = list[k];
            xs[k] = b.x; ys[k] = b.y; vxs[k] = b.vx; vys[k] = b.vy; ms[k] = b.m;
            const g = b.grp || 0;
            grp[k] = g && b.minor ? -1 - k : g;   // (the pieces of a dot in a swarm are too light to feel each other: no group)
            if (g) anyPieces = true;
            eps[k] = g ? softLength(b) : 0;
            // (the last acceleration: the tree's relative criterion needs it)
            a0[k] = useTree && (b.ax || b.ay) ? Math.sqrt(b.ax * b.ax + b.ay * b.ay) : 0;
            pair[k] = -1;
            b.slot = k; b.stamp = stamp;
        }
        if (pairs) {
            for (const p of pairs) {
                if (p.a.stamp === stamp && p.b.stamp === stamp) {
                    SPAIR[p.a.slot] = p.b.slot;
                    if (!p.hosted) SPAIR[p.b.slot] = p.a.slot; else if (!p.a.grp) anyHosted = true;
                }
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
        let A = f * ((4 + 2 * eta) * gm / r - (1 + 3 * eta) * v2 + 1.5 * eta * rd * rd);
        let B = f * (4 - 2 * eta) * rd;
        // Compact, close pairs (GM/(rc^2) over RR_MIN) also get the 2PN terms and radiation reaction (2.5PN,
        // the energy gravitational waves carry off): see "Relativity: orbits that turn, and gravitational waves".
        if (gm > RR_MIN_C2 * r) {
            rrSeen++;
            const gr = gm / r, rd2 = rd * rd, e2 = eta * eta, h = f / C2;
            A -= h * (rd2 * rd2 * (1.875 * eta - 5.625 * e2) + rd2 * v2 * (6 * e2 - 4.5 * eta) + v2 * v2 * (3 * eta - 4 * e2)
                + gr * (-rd2 * (2 + 25 * eta + 2 * e2) + v2 * (2 * e2 - 6.5 * eta)) + gr * gr * (9 + 21.75 * eta));
            B -= h * rd * (rd2 * (4.5 * eta + 3 * e2) - v2 * (7.5 * eta + 2 * e2) + gr * (2 + 20.5 * eta + 4 * e2));
            if (gwOn) {
                const k = 1.6 * eta * gm * gm / (C5 * r2 * r);
                A += k * (18 * v2 + (2 / 3) * gr - 25 * rd2) * rd;
                B -= k * (6 * v2 - 2 * gr - 15 * rd2);
            }
        }
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
        const inRows = SINDIR, rowOf = SDPOS, some = anyPieces, hosted = anyHosted;
        // (a pair whose lighter body can't disturb anyone needn't ask for less than this)
        const q = sampleDt / (HOST_STEPS * (n > DIRECT_MAX ? ETA_SWARM : ETA)), tLight = q * q;
        let tmin = Infinity;
        for (let a = 0; a < nRows; a++) {
            const i = rows ? rows[a] : a;
            const xi = xs[i], yi = ys[i], mi = ms[i], gi = grp[i], pi = SPAIR[i];
            let axi = accX[i], ayi = accY[i], b1 = best[i], b2 = second[i], p1 = part[i];
            for (let j = rows ? 0 : i + 1; j < n; j++) {
                if (rows && (j === i || (inRows[j] && rowOf[j] <= a))) continue;
                let gj = 0, piece = false;
                if (some) {
                    gj = grp[j];
                    piece = gi !== 0 || gj !== 0;
                    if (piece && gi !== gj && ((gi !== 0 && gj !== 0) || pi === j || SPAIR[j] === i)) continue;   // (other bodies' pieces; a piece and its host)
                }
                const dx = xs[j] - xi, dy = ys[j] - yi;
                const r2 = dx * dx + dy * dy;
                const mj = ms[j], msum = mi + mj;
                if (piece && gi === gj) {
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
                let kep = pi === j, turns = false;
                // (a whole body and its host: only the body's own entry names its partner)
                if (hosted && kep !== (SPAIR[j] === i)) { kep = true; turns = true; }
                if (!kep) {
                    const si = G * mj * ir3, sj = G * mi * ir3;
                    axi += si * dx; ayi += si * dy;
                    accX[j] -= sj * dx; accY[j] -= sj * dy;
                }
                if (msum > 0) {
                    const t = r2 * r / (G * msum);
                    if (piece) {
                        if (PIECE_T2 * t < tmin) tmin = t < tLight && (mi < LIGHT * mj || mj < LIGHT * mi) ? Math.min(tmin, PIECE_T2 * tLight) : PIECE_T2 * t;
                    } else if (t < tmin && !kep) tmin = t < tLight && (mi < LIGHT * mj || mj < LIGHT * mi) ? Math.min(tmin, tLight) : t;
                    // each body's two shortest pair times, and the partner of the shortest
                    if (t < b2) { if (t < b1) { b2 = b1; b1 = t; p1 = j; } else b2 = t; }
                    if (t < second[j]) { if (t < best[j]) { second[j] = best[j]; best[j] = t; part[j] = i; } else second[j] = t; }
                    if (pn && !piece && !turns) {
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
                    let soft = false;
                    if (gi !== 0 && sgrp[j] !== 0) {
                        if (sgrp[j] !== gi) continue;   // (other bodies' pieces)
                        soft = true;
                    }
                    const ddx = bx[s] - xi, ddy = by[s] - yi;
                    let d2 = ddx * ddx + ddy * ddy;
                    if (soft) { const ee = 0.5 * (ei + seps[j]); d2 += ee * ee; } else if (d2 === 0) continue;
                    const id3 = 1 / (d2 * Math.sqrt(d2)), mj = bm[s];
                    ax += G * mj * id3 * ddx; ay += G * mj * id3 * ddy;
                    const kk = soft ? (mi + mj) * id3 / SOFT_T2 : gi !== 0 ? (mi + mj) * id3 / PIECE_T2 : (mi + mj) * id3;
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
        for (let i = 0; i < n; i++) {
            if (SPAIR[i] < 0) continue;
            const q = SPAIR[SPAIR[i]] !== i ? SPAIR[i] : i;   // (of a piece or whole body and its host, just the host)
            if (!SINDIR[q]) { SINDIR[q] = 1; SDIR[nd++] = q; }
        }
        for (let a = 0; a < nd; a++) SDPOS[SDIR[a]] = a;
        // The light bodies' pulls on each other, from the tree
        let treeWork = 0;
        let nl = 0;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < n; i++) {
            if (SINDIR[i]) continue;
            // (dots going round a host, far too light to matter to each other: the tree need not hold them)
            const h = SPAIR[i];
            if (h >= 0 && SM[i] < LIGHT * SM[h]) { CAX[i] = 0; CAY[i] = 0; CB1[i] = 0; CB2[i] = 0; CP1[i] = -1; continue; }
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
    // A piece of a torn-apart body (see "Tidal disruption"), so light that it can't disturb its host much (at
    // most a HOST_MIN-th of its mass), is followed round it the same way, relativity or not, and many can
    // share one host (see driftHosted). Then one that swings in close forces little on the rest: it keeps
    // the step under HOST_TURN of its time near the host (for its trail, and for the others' small pull on
    // it through the host), but to no more than HOST_STEPS steps a trail sample. PIECE_STEP: a piece that
    // does set the step, passing some other body, is let off with that many times fewer steps.
    // A light whole body goes the same way, but only where it would otherwise hold everything back: when the
    // step it asks for is finer than HOST_STEPS steps a trail sample (twice that to stop: see chooseHosted). No
    // scene whose orbits take a good many trail samples ever gets there. A body near its Roche limit is
    // followed closely, so it tears where it should. Two compact bodies close enough to radiate (or any two
    // for which radiation matters soon: HOST_GW) stay on the ordinary steps, and a host can't go round anything.
    const HOST_MIN = 10;
    const HOST_TURN = 0.25;
    const HOST_STEPS = 32;
    const PIECE_STEP = 4;
    const PIECE_T2 = PIECE_STEP * PIECE_STEP;   // (the times are kept squared)
    const HOST_HEAVY = 1e-5;              // heavier than this beside their host, a body and those going round with it shift each other...
    const HOST_FINE = 32;                 // ...(the term the drift splits off), so it has this many times more steps a trail sample: the energy stays as level
    const hostShared = (m, mH, others) => m >= HOST_HEAVY * mH && others >= HOST_HEAVY * mH;
    const HOST_GW = 1e6;                  // radiation may take this many trail samples or more to close the orbit
    const LIGHT = 1e-9;                   // the lighter of a pair by this much: it moves the other not at all, and has nothing else to answer for
    const ROCHE_NEAR = 392;               // (3 ROCHE)^3: inside three times its Roche limit a whole body is followed closely
    const mainPairs = [];                 // { a, b, touch, fast, hosted, closest } for the bodies (hosted: a goes round b, see driftHosted)
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

    let KX = 0, KY = 0, KVX = 0, KVY = 0, KMIN = 0, KR = 0, KTURNS = 0;
    // Kepler's equation in universal variables, r0 G1(s) + eta G2(s) + mu G3(s) - tau (sets KR = r(s), its slope)
    function keplerF(s, r0, eta, mu, beta, tau) {
        stumpff(beta * s * s);
        const g1 = s * SC1, g2 = s * s * SC2;
        KR = r0 * SC0 + eta * g1 + mu * g2;
        return r0 * g1 + eta * g2 + mu * s * s * s * SC3 - tau;
    }

    // near: a short step, for which the universal variable's own series is a closer start (and fewer turns of the
    // solver below)
    function keplerDrift(rx, ry, vx, vy, mu, dt, near) {
        const r0 = Math.hypot(rx, ry);
        const eta = rx * vx + ry * vy;
        const beta = 2 * mu / r0 - (vx * vx + vy * vy);   // mu / a (negative for a hyperbola)
        let tau = dt, whole = false, s, lo, hi;
        KTURNS = 0;
        if (beta > 0) {
            // An ellipse is only advanced by the part of dt left over after whole turns; one turn is
            // s = 2 pi / sqrt(beta), which brackets the answer
            const P = TAU * mu / (beta * Math.sqrt(beta));
            if (Math.abs(tau) >= P) { KTURNS = Math.trunc(tau / P); tau -= P * KTURNS; whole = true; }
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
        if (near) s = (dt / r0) * (1 - 0.5 * dt * eta / (r0 * r0));
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

    // Move a host and its pieces. The whole group's centre of mass goes in a straight line; each piece goes
    // round the host exactly; and the pieces' pull on the host is the small term left (Duncan, Levison & Lee
    // 1998: the "democratic heliocentric" form of the Wisdom-Holman splitting), in which each moves the host,
    // and so all the others relative to it, by its own momentum / the host's mass, half before and half after.
    // Momentum is kept exactly and, for one piece, it is the exact two-body motion.
    // Relativity's main effect on a piece is that its orbit turns forward, by 3 GM / (c^2 p) for each radian it
    // goes round (6 pi GM / (c^2 a (1 - e^2)) a turn, whatever the step). A body following a Kepler orbit turned
    // like that keeps its energy and angular momentum, and, turning about the host, commutes with the motion
    // round it, so all this stays time-reversible. A piece too close to its host to stay in orbit (inside
    // the innermost stable orbit) falls in: see piecesFallIn.
    function driftHosted(g, dt) {
        const H = g.h, list = g.pairs, n = list.length, mH = H.m, real = settings.realistic;
        let M = mH, X = mH * H.x, Y = mH * H.y, PX = mH * H.vx, PY = mH * H.vy;
        for (let i = 0; i < n; i++) {
            const f = list[i].a, m = f.m;
            M += m; X += m * f.x; Y += m * f.y; PX += m * f.vx; PY += m * f.vy;
        }
        X /= M; Y /= M;
        const cvx = PX / M, cvy = PY / M, half = 0.5 * dt / mH;
        let sx = 0, sy = 0;
        for (let i = 0; i < n; i++) {
            const f = list[i].a, m = f.m;
            HRX[i] = f.x - H.x; HRY[i] = f.y - H.y;
            const px = m * (f.vx - cvx), py = m * (f.vy - cvy);
            HPX[i] = px; HPY[i] = py;
            sx += px; sy += py;
        }
        let tx = 0, ty = 0;
        for (let i = 0; i < n; i++) {
            const p = list[i], f = p.a, m = f.m, im = 1 / m + 1 / mH, gm = G * (mH + m);
            const rx = HRX[i] + half * (sx - HPX[i]), ry = HRY[i] + half * (sy - HPY[i]);
            const vx = HPX[i] * im, vy = HPY[i] * im;
            const r2 = rx * rx + ry * ry;
            keplerDrift(rx, ry, vx, vy, gm, dt, 4 * dt * dt * gm < r2 * Math.sqrt(r2));
            let kx = KX, ky = KY, kvx = KVX, kvy = KVY;
            if (KMIN < (H.R + f.R) / AU_KM || (real && gm > ISCO_C2 * KMIN)) p.touch = true;
            if (KMIN < p.closest) p.closest = KMIN;
            if (real) {
                const h = rx * vy - ry * vx, way = h * dt < 0 ? -1 : 1;
                let swept = Math.atan2(rx * ky - ry * kx, rx * kx + ry * ky);
                if (swept * way < 0) swept += way * TAU;
                const w = (3 * gm * gm / (C2 * h * h)) * (swept + way * TAU * Math.abs(KTURNS));
                if (h !== 0 && w !== 0) {
                    const c = Math.cos(w), s = Math.sin(w);
                    const x1 = c * kx - s * ky, vx1 = c * kvx - s * kvy;
                    ky = s * kx + c * ky; kvy = s * kvx + c * kvy;
                    kx = x1; kvx = vx1;
                }
            }
            HRX[i] = kx; HRY[i] = ky;
            const px = kvx / im, py = kvy / im;
            HPX[i] = px; HPY[i] = py;
            tx += px; ty += py;
        }
        let mx = 0, my = 0;
        for (let i = 0; i < n; i++) {
            const m = list[i].a.m;
            HRX[i] += half * (tx - HPX[i]); HRY[i] += half * (ty - HPY[i]);
            mx += m * HRX[i]; my += m * HRY[i];
        }
        H.x = X + dt * cvx - mx / M; H.y = Y + dt * cvy - my / M;
        H.vx = cvx - tx / mH; H.vy = cvy - ty / mH;
        for (let i = 0; i < n; i++) {
            const f = list[i].a;
            f.x = H.x + HRX[i]; f.y = H.y + HRY[i];
            f.vx = cvx + HPX[i] / f.m; f.vy = cvy + HPY[i] / f.m;
        }
    }

    // Can a and b be followed as a close pair? (gamma: how weakly the others must disturb them; read
    // from the packed shortest pair times of the last evaluation of the bodies' forces)
    function pairQualifies(a, b, gamma) {
        if (a.stamp !== mainStamp || b.stamp !== mainStamp) return false;
        const i = a.slot, j = b.slot;
        if (SPART[i] !== j || SPART[j] !== i) return false;
        if (a.held || b.held || a.grp || b.grp || !(a.m > 0 && b.m > 0)) return false;
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
            if (!p.hosted && !pairQualifies(p.a, p.b, 2 * KEP_GAMMA)) { mainPairs.splice(k, 1); changed = true; }
        }
        const n = bodies.length;
        let pieces = false;
        for (let k = 0; k < n; k++) { const b = bodies[k]; b.kep = null; if (b.grp) pieces = true; }
        for (const p of mainPairs) { p.a.kep = p; if (!p.hosted) p.b.kep = p; }
        for (let k = 0; k < n; k++) {
            const j = SPART[k];
            if (j <= k || SPART[j] !== k) continue;
            const a = bodies[k], b = bodies[j];
            if (a.kep || b.kep || a.hosts || b.hosts || !pairQualifies(a, b, KEP_GAMMA)) continue;
            followPair(a, b, false);
            changed = true;
        }
        const hostedChanged = chooseHosted();
        if (hostedChanged) changed = true;
        if ((pieces || hostGroups.length) && choosePieceHosts()) changed = true;
        if (changed && (pieces || hostGroups.length || hostedChanged)) syncHosts();
        return changed;
    }

    // Follow a and b as a close pair (a, a piece of a torn-apart body or a light whole body, round its host b)
    function followPair(a, b, fast, hosted) {
        const q = { a, b, touch: false, fast, hosted: !!(hosted || a.grp), closest: Infinity };
        mainPairs.push(q);
        a.kep = q;
        if (!q.hosted) b.kep = q;
    }

    // The body light whole body f would go round (null if none): of the heaviest few, the one it is going round
    // fastest, if that holds things back (pair time squared under t0) and it is the heavier by HOST_MIN. The
    // others' tides must be small beside its pull (gamma, as for a close pair), unless f is so light (LIGHT) that it
    // can't disturb anyone: its own path through them is all that is at stake, and that fares better this way.
    function hostFor(f, gamma, t0) {
        if (f.held || f.grp || !(f.m > 0)) return null;
        const nh = hostList.length, xf = f.x, yf = f.y, mf = f.m;
        let t1 = Infinity, t2 = Infinity, H = null;
        for (let k = 0; k < nh; k++) {
            const h = hostList[k];
            if (h === f) continue;
            const dx = h.x - xf, dy = h.y - yf, d3 = (dx * dx + dy * dy) * Math.sqrt(dx * dx + dy * dy);
            const t = d3 / (h.m + mf);
            if (t < t1) {
                if (H) t2 = Math.min(t2, t1 * (H.m + mf) / H.m);
                t1 = t; H = h;
            } else t2 = Math.min(t2, d3 / h.m);
        }
        if (!H || H.held || H.m < HOST_MIN * mf || (H.kep && H.kep.hosted)) return null;
        const fine = hostShared(mf, H.m, f.kep && f.kep.b === H ? H.hostMass - mf : H.hostMass);
        if (!(t1 > 0 && t1 < G * t0 / (fine ? HOST_FINE * HOST_FINE : 1))) return null;
        if (mf >= LIGHT * H.m && !(t1 < gamma * t2)) return null;
        if (!settings.realistic) return H;
        // Radiation left out of the drift must not matter: Peters' time for the orbit to close, if they are close enough to have it
        const r = Math.cbrt(t1 * (H.m + mf)), gm = G * (mf + H.m);
        if (!(gm > RR_MIN_C2 * r)) return H;
        return !(isCompact(f) && isCompact(H)) && (5 / 256) * C5 * r * r * r * r / (G * G * gm * mf * H.m) > HOST_GW * sampleDt ? H : null;
    }

    // Fill hostList: the heaviest few whole bodies
    function heaviestFew() {
        hostList.length = 0;
        for (const b of bodies) {
            if (b.grp || !(b.m > 0)) continue;
            if (hostList.length < HEAVY_MAX) { hostList.push(b); continue; }
            let lo = 0;
            for (let k = 1; k < HEAVY_MAX; k++) if (hostList[k].m < hostList[lo].m) lo = k;
            if (b.m > hostList[lo].m) hostList[lo] = b;
        }
    }

    // Light whole bodies going round hosts: those that have stopped holding things back (or whose host is now to go
    // round something heavier, as a host can't go round anything itself), then the new ones. Returns true if any changed.
    function chooseHosted() {
        const n = bodies.length;
        const q = sampleDt / (HOST_STEPS * (n > DIRECT_MAX ? ETA_SWARM : ETA)), t0 = q * q;
        let found = false;
        for (let k = 0; k < n && !found; k++) found = SBEST[k] < t0 && bodies[k].stamp === mainStamp;
        let any = found;
        for (let k = 0; k < mainPairs.length && !any; k++) any = mainPairs[k].hosted && !mainPairs[k].a.grp;
        if (!any) return false;
        heaviestFew();
        let changed = false, lastH = null, lastFree = false;
        for (let k = mainPairs.length - 1; k >= 0; k--) {
            const p = mainPairs[k];
            if (!p.hosted || p.a.grp) continue;
            if (p.b !== lastH) { lastH = p.b; lastFree = !hostFor(lastH, KEP_GAMMA, t0); }
            if (lastFree && p.a.stamp === mainStamp && p.b.stamp === mainStamp && hostFor(p.a, 2 * KEP_GAMMA, 4 * t0) === p.b) continue;
            mainPairs.splice(k, 1);
            p.a.kep = null;
            bookHosted(p, false);
            changed = true;
        }
        for (let k = 0; k < n; k++) {
            if (!(SBEST[k] < t0)) continue;
            const f = bodies[k];
            if (f.kep) continue;
            const H = hostFor(f, KEP_GAMMA, t0);
            if (!H || hostFor(H, KEP_GAMMA, t0)) continue;
            if (H.kep && !freeHost(H)) continue;
            hostBody(f, H);
            changed = true;
        }
        return changed;
    }

    // H is in an ordinary close pair: with a partner light enough, that becomes the first of its hosted bodies
    function freeHost(H) {
        const o = H.kep, x = o.a === H ? o.b : o.a;
        if (H.m < HOST_MIN * x.m || x.hosts) return false;
        mainPairs.splice(mainPairs.indexOf(o), 1);
        H.kep = x.kep = null;
        hostBody(x, H);
        return true;
    }

    function hostBody(f, H) {
        followPair(f, H, false, true);
        H.hosts++; H.hostMass += f.m;   // (until syncHosts counts them)
        bookHosted(f.kep, true);
    }

    // A whole body going round a host keeps its Kepler energy as its orbit turns (see driftHosted), so that pair's
    // relativistic terms leave the books as it starts, and come back as it stops: the total doesn't jump.
    const HOSTED_BOOK = -2;   // (among the body ids of groupEnergy)
    function bookHosted(p, on) {
        const i = p.a, j = p.b;
        if (!settings.realistic || i.stamp !== mainStamp || j.stamp !== mainStamp) return;
        const M = i.m + j.m, rx = i.x - j.x, ry = i.y - j.y, vx = i.vx - j.vx, vy = i.vy - j.vy;
        const pn = pairEnergy(i, j) - (0.5 * (i.m * j.m / M) * (vx * vx + vy * vy) - G * i.m * j.m / Math.hypot(rx, ry));
        groupEnergy.set(HOSTED_BOOK, (groupEnergy.get(HOSTED_BOOK) || 0) + (on ? -pn : pn));
    }

    // Each piece's host, if it has one: the body whose pull on it is so much the strongest that the others'
    // tides are small beside it (as for a close pair, with the same hysteresis, among the bodies that aren't
    // pieces: their own softened pull is gentle, and the steps follow it). Returns true if any changed.
    const hostList = [];
    function choosePieceHosts() {
        let changed = false;
        heaviestFew();
        for (let k = mainPairs.length - 1; k >= 0; k--) {
            // (a piece that has gone, or a host that has)
            const p = mainPairs[k];
            if (p.a.grp && (p.a.stamp !== mainStamp || p.b.stamp !== mainStamp)) { mainPairs.splice(k, 1); p.a.kep = null; changed = true; }
        }
        const nh = hostList.length;
        for (const f of bodies) {
            if (!f.grp) continue;
            const xf = f.x, yf = f.y, mf = f.m;
            let t1 = Infinity, t2 = Infinity, H = null;
            for (let k = 0; k < nh; k++) {
                const h = hostList[k], dx = h.x - xf, dy = h.y - yf, r2 = dx * dx + dy * dy;
                const t = r2 * Math.sqrt(r2) / (h.m + mf);
                if (t < t1) { t2 = t1; t1 = t; H = h; } else if (t < t2) t2 = t;
            }
            const q = f.kep;
            const ok = H && !f.held && !H.held && !H.kep && H.m >= HOST_MIN * mf && t1 > 0 && t1 < (q && q.b === H ? 2 * KEP_GAMMA : KEP_GAMMA) * t2;
            if (q && (!ok || q.b !== H)) { mainPairs.splice(mainPairs.indexOf(q), 1); f.kep = null; changed = true; }
            if (ok && !f.kep) { followPair(f, H, false); changed = true; }
        }
        return changed;
    }

    // The hosts, each with the close pairs of its pieces (kept while they stay the same)
    const hostGroups = [];
    function syncHosts() {
        for (const g of hostGroups) { g.h.hosts = 0; g.h.hostMass = 0; }
        hostGroups.length = 0;
        for (const p of mainPairs) {
            if (!p.hosted) continue;
            let g = null;
            if (p.b.hosts) g = hostGroups.find((q) => q.h === p.b);
            if (!g) { g = { h: p.b, pairs: [] }; hostGroups.push(g); }
            g.pairs.push(p);
            p.b.hosts = g.pairs.length;
            p.b.hostMass += p.a.m;
        }
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
        if (p.fast) return Infinity;
        if (!p.hosted) return KEP_TURN * Math.sqrt(r2 * r / gm);
        const own = HOST_TURN * Math.sqrt(r2 * r / gm);
        if (settings.realistic && !a.grp && !isCompact(a) && a.m >= LIGHT * b.m) {
            const R = a.R / AU_KM;
            if (r2 * r < ROCHE_NEAR * R * R * R * b.m / a.m) return own;
        }
        return Math.max(own, sampleDt / (!a.grp && hostShared(a.m, b.m, b.hostMass - a.m) ? HOST_FINE * HOST_STEPS : HOST_STEPS));
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
            if (!(pairs && (b.kep || b.hosts))) { b.x += dt * b.vx; b.y += dt * b.vy; }
        }
        if (pairs) {
            for (const p of pairs) if (!p.hosted) driftPair(p, dt);
            for (const g of hostGroups) driftHosted(g, dt);
        }
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
        for (const p of mainPairs) { p.touch = false; p.closest = Infinity; }
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
        if (a.kep && (a.kep === b.kep || a.kep.b === b)) return a.kep.touch;
        if (b.kep && b.kep.b === a) return b.kep.touch;
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
        let merged = hostGroups.length > 0 && piecesFallIn();
        while (firstContact()) {
            const a = contactA, b = contactB;
            if (a.kep) a.kep.touch = false;
            mergeBodies(a, b);
            merged = true;
        }
        if (merged) computeForces();
        return merged;
    }

    // Pieces that touched their hosts in the last step (hundreds at a time, when a swarm falls into a black
    // hole). Inside the innermost stable orbit, before it touches, a piece just falls in, as in plunge: what it
    // takes with it is kept in the books (under FALLEN, among the body ids of groupEnergy), so the total stays
    // level.
    const FALLEN = -1;
    function piecesFallIn() {
        let merged = false;
        listsWait = true;
        for (const p of mainPairs) {
            if (!p.touch || !p.hosted) continue;
            p.touch = false;
            const f = p.a, H = p.b, fell = settings.realistic && G * (H.m + f.m) > ISCO_C2 * (H.R + f.R) / AU_KM;
            const before = fell ? energyOf([f, H]) : 0;
            mergeBodies(f, H);
            if (fell) groupEnergy.set(FALLEN, (groupEnergy.get(FALLEN) || 0) + energyOf([H]) - before);
            merged = true;
        }
        listsWait = false;
        return merged;
    }

    // The survivor is the heavier body, or the black hole if there is one (it swallows the other from
    // the inside, whatever their masses).
    function mergeBodies(a, b) {
        noteIrreversible('merge');   // (running backwards: a copy of the system from just before)
        const bh = (q) => q.kind === 'blackhole';
        const big = bh(a) !== bh(b) ? (bh(a) ? a : b) : (a.m >= b.m ? a : b), small = big === a ? b : a;
        const auto = autoColoured(big);   // (a star's colour follows its mass: see starColour)
        noteCollision(big, small);   // (the stability timer)
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
        if (auto && !KEEPS_LOOK[big.kind]) big.color = colourForMass(big);
        // (not for a swarm's bodies, or torn-apart pieces: they merge by the hundred; and the stability
        // timer says so itself)
        if (!small.minor && !small.grp && timeDir < 0) { past.noted = true; pastNote(MERGE_BACK_NOTE, 8000); }   // (running backwards: not the usual crash)
        else if (!small.minor && !small.grp && !settings.stability && !scene.progress) showHint('note', `<strong>${escapeHtml(sentenceCase(theName(small)))} crashed into ${escapeHtml(theName(big))}</strong> and merged with it.`, { ms: 6000 });
    }

    // Said as a merger is (not for a swarm's bodies, which go by the hundred; the stability timer says so
    // itself). The scene's tip has done its job. If it was the chosen body, the choice goes to what tore
    // it apart, not to a piece: one fragment means nothing, and its readouts would only confuse.
    let tornNews = null;
    function announceTear() {
        const n = tornNews;
        tornNews = null;
        updateHistoryUi();   // (Undo now takes the break-up back: see tornInScene)
        if (!n || n.L.minor) return;
        clearHint('tip');
        if (n.chosen && bodies.includes(n.H)) selectBody(n.H.id);
        if (!settings.stability) showHint('note', `<strong>${escapeHtml(sentenceCase(theName(n.L)))} was torn apart</strong> by the tides of ${escapeHtml(theName(n.H))}.`, { ms: 7000 });
    }

    // ------------------------------------------------------------------
    // Tidal disruption (realistic physics). A star, planet, moon or comet that strays inside the Roche
    // limit of a body at least five times heavier, d = 2.44 R (M / m)^(1/3) (the limit for a fluid body
    // held together only by its own gravity), before their surfaces touch, is torn apart. It becomes a
    // line of fragments along the line to the heavy body, all moving as it did; the inner ones are more
    // tightly bound than the outer ones, so they spread out along the orbit into a stream, and if the
    // pass was close enough about half escape. The fragments of one body pull on each other (softened, see
    // above) and all pull on everything else, so self-gravity can gather some of the stream into clumps, as in
    // simulations of real disruptions. They don't merge with each other: they start overlapping (parts of
    // one fluid body), and streams of gas that meet pass through each other rather than sticking like
    // solid bodies; they can still merge with anything else, or fall into the black hole. A fragment
    // swings round the body tearing it far faster than anything else moves, so each follows its own orbit
    // round it exactly (see "Close pairs"), and it doesn't set the step for the rest.
    // In a crowded scene only the heaviest few bodies are tried as the heavy partner (bodies outside them
    // are light swarm bodies, whose Roche limits round each other are barely bigger than their own sizes,
    // so they merge rather than tear).
    // ------------------------------------------------------------------
    const ROCHE = 2.44;
    const FRAGMENTS = 9;
    const MINOR_FRAGMENTS = 3;            // ...or of a light body of a crowded scene (a dot among many, all but unseen)
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
                // (going round H it may have passed closer between the ends of the step)
                const d = L.kep && L.kep.hosted && L.kep.b === H ? Math.min(Math.hypot(dx, dy), L.kep.closest) : Math.hypot(dx, dy);
                const roche = (ROCHE * L.R * Math.cbrt(H.m / L.m)) / AU_KM;
                if (d < roche && roche > (H.R + L.R) / AU_KM && disrupt(L, H)) return true;
            }
        }
        return false;
    }

    // How a body breaks: ragged, not a row of equal beads. The pieces' masses, the gaps along the line to
    // the heavy body and how far they sit off it all vary, in a pattern taken from the two bodies, their
    // masses, size and name (never from the clock or Math.random, so Run again and a shared link break it
    // the same way, bit for bit).
    // Measured from their centre of mass, so all moving as one they keep the whole body's centre of mass,
    // momentum and angular momentum. Returns each piece's share of the mass and place (in units of the radius).
    function tearPattern(L, H, n) {
        const bits = new Uint32Array(new Float64Array([L.m, L.R, H.m]).buffer);
        let h = 2166136261;
        for (let k = 0; k < bits.length; k++) h = Math.imul(h ^ bits[k], 16777619);
        for (let k = 0; k < L.name.length; k++) h = Math.imul(h ^ L.name.charCodeAt(k), 16777619);
        const rnd = seeded(((h >>> 0) % 2147483646) + 1);
        rnd(); rnd();   // (the first numbers from a small seed are much alike)
        const share = [], along = [], off = [];
        let W = 0, s = 0;
        for (let i = 0; i < n; i++) {
            share.push(Math.exp(0.8 * (2 * rnd() - 1)));
            if (i) s += 0.35 + rnd();
            along.push(s);
            off.push(rnd() - 0.5);
            W += share[i];
        }
        const stretch = 2 / s;
        let A = 0, O = 0;
        for (let i = 0; i < n; i++) { share[i] /= W; A += share[i] * along[i] * stretch; O += share[i] * off[i]; }
        for (let i = 0; i < n; i++) { along[i] = along[i] * stretch - A; off[i] -= O; }
        return { share, along, off };
    }

    function disrupt(L, H) {
        const n = Math.min(L.minor ? MINOR_FRAGMENTS : FRAGMENTS, MAX_BODIES - bodies.length + 1);
        if (n < 3) return false;   // no room for the pieces: it stays whole
        noteIrreversible('tear');   // (running backwards: a copy of the system from just before)
        noteTornApart(L, H);       // (the stability timer)
        const d = Math.hypot(L.x - H.x, L.y - H.y);
        const ux = (L.x - H.x) / d, uy = (L.y - H.y) / d;
        const span = L.R / AU_KM;
        const parts = [], name = uniqueName('Fragment');
        const shape = tearPattern(L, H, n);
        let left = L.m;
        for (let i = 0; i < n; i++) {
            const s = shape.along[i], q = shape.off[i];
            const m = i < n - 1 ? L.m * shape.share[i] : left;   // (the last takes what rounding left: the mass adds up exactly)
            left -= m;
            const f = newBody({ name, kind: L.kind, m, R: L.R * Math.cbrt(shape.share[i]), color: L.color });
            f.grp = L.id;
            f.heft = heftOf(n * shape.share[i]);
            f.x = L.x + (ux * s - uy * q) * span; f.y = L.y + (uy * s + ux * q) * span;
            f.vx = L.vx; f.vy = L.vy;
            f.px = f.x; f.py = f.y;
            parts.push(f);
        }
        flashes.push({ x: L.x, y: L.y, t: performance.now(), color: L.color, r0: drawRadius(L) });
        const before = energyOf([L]);
        bodies.push(...parts);
        removeBody(L, parts[(n - 1) >> 1]);   // the view and the readouts pass to the middle piece
        groupEnergy.set(L.id, energyOf(parts) - before);
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

    // ------------------------------------------------------------------
    // Relativity: orbits that turn, and gravitational waves (realistic physics)
    //
    // Gravitational waves. Two compact bodies close together (GM/(rc^2) over RR_MIN, which in practice
    // means a white dwarf, neutron star or black hole within a few hundred thousand of its own size) lose
    // orbital energy to gravitational waves. Their relative motion gets the leading radiation-reaction
    // acceleration (2.5PN, a factor (v/c)^5 smaller than Newton's pull), added in pnPair beside the 1PN
    // terms, in the same harmonic coordinates (Damour & Deruelle 1981; Iyer & Will 1993, PRL 70, 113,
    // with their gauge constants alpha = 4, beta = 5):
    //   a_RR = (8/5) eta (GM)^2/(c^5 r^3) { (18 v^2 + (2/3) GM/r - 25 rdot^2) rdot n
    //                                       - (6 v^2 - 2 GM/r - 15 rdot^2) v }
    // (M, eta, n, v, rdot as for 1PN). Averaged over an orbit it takes away exactly the energy and angular
    // momentum of the quadrupole formula, so an orbit shrinks and becomes rounder as Peters (1964) found,
    // and a circular one of radius a lasts t = (5/256) c^5 a^4 / (G^3 m1 m2 (m1 + m2)) before the two meet.
    // (From moment to moment it differs from the quadrupole formula's rate by the change of a small
    // "Schott" term, so round an eccentric orbit the rate swings, even below zero for a moment.)
    // The force depends on the velocities, like the 1PN one, so it is part of the second kick done twice.
    //
    // The 2PN terms. These pairs get the next conservative terms too (Blanchet 2014, Living Rev. Relativ.
    // 17, 2, eq. 219, harmonic coordinates; a = -(GM/r^2)[(1 + A) n + B v] with
    //   c^4 A_2PN = (15/8) eta (1 - 3 eta) rdot^4 - (3/2) eta (3 - 4 eta) rdot^2 v^2 + eta (3 - 4 eta) v^4
    //             - (GM/r) [(2 + 25 eta + 2 eta^2) rdot^2 + (13/2 - 2 eta) eta v^2] + (GM/r)^2 (9 + 87 eta / 4)
    //   c^4 B_2PN = (3/2) eta (3 + 2 eta) rdot^3 - (1/2) eta (15 + 4 eta) rdot v^2 + (GM/r) (2 + 41 eta/2 + 4 eta^2) rdot),
    // and their energy (energy2PN). Without them the late inspiral goes wrong: with the 1PN terms alone,
    // which hold only while GM/(rc^2) is small, a pair 10 GM/c^2 apart takes 3.6 times Peters' time to
    // close in, and its energy drifts from total + carried off by 50 GM/(rc^2)^2 of what it radiates
    // (15% by 10 GM/c^2); and a body dropped straight onto a black hole even bounces back. With them, the
    // drift falls to 1-2% at 10 GM/c^2, and a circular inspiral takes 0.995 of Peters' time from 100 GM/c^2
    // apart, 0.98 from 50 and 0.94 from 30 (higher-order terms, left out, would add a few per cent back).
    // (Checked: the energy is what the 2PN motion keeps constant, to order GM/(rc^2)^3.)
    //
    // The plunge. RR_MIN is far above PN_PAIR_MAX, so these pairs are never left to the two-body (Kepler)
    // drift; their step follows the shrinking orbit (it scales with the pair's free-fall time). At their
    // innermost stable orbit they plunge together and merge (see plunge), keeping momentum.
    //
    // The energy carried off is the work the radiation reaction does on the system's energy (with its
    // 1PN and 2PN terms, as systemEnergy counts it), added up step by step (trapezium rule): total +
    // carried off stays level, to within the size of the terms left out (a few per cent in the last
    // orbits before a plunge).
    //
    // Orbits that turn. Relativity turns an orbit's closest point forward by 6 pi G(M + m)/(c^2 a (1 - e^2))
    // each time round (Einstein 1915), the other planets' pulls turn it too. For the chosen body, the
    // moment of its closest approach to what it orbits is found each time round (where r.v changes sign,
    // on the cubic through the positions and velocities at the ends of that step), and its direction is
    // that of the Runge-Lenz vector, the closest point of the osculating ellipse, at that moment
    // (interpolated between the step's ends: a Kepler orbit keeps it exactly, so the steps don't show).
    // The turn between one passage and the next is compared with Einstein's value for that orbit (with
    // a (1 - e^2) = 2 r_min r_max / (r_min + r_max) from its measured closest and farthest distances).
    // When other bodies' pulls on it could matter (their tides add up to more than a fifth of
    // GM/(pc^2)), the measured turn is a straight-line fit over every orbit since it started, and
    // Einstein's share is shown beside it. (Close to a black hole the measured turn is a few per cent more
    // than Einstein's formula: the 2PN terms' share, as GR predicts: Damour & Schäfer 1988.)
    // ------------------------------------------------------------------
    const RR_MIN = 1e-5;
    const RR_MIN_C2 = RR_MIN * C2;
    const C5 = C2 * C2 * C_LIGHT;
    const PREC_E_MIN = 0.02;              // a rounder orbit has no clear closest point to follow
    const WAVE_N = 480;                   // samples in the wave sketch
    let gwOn = true;                      // (tests can turn the waves off)
    let rrSeen = 0;                       // radiation-reaction pairs met in force evaluations since the last step
    let relSteps = 0;                     // steps since the scene loaded (trackers must see every one)
    const gw = {
        radiated: 0,                      // energy carried off by gravitational waves (M_sun AU^2 / yr^2)
        power: 0,                         // ...the rate at the end of the last step
        a: null, b: null,                 // the pair radiating most (b the lighter)
        merged: null,                     // { t, id, m, m1, m2 } after two compact bodies merged
        wave: new Float64Array(WAVE_N), waveT: 0, waveN: 0, waveDt: 0, frozen: false,
        ring: null                        // ringing of a new black hole: { t0, A, w, tau }
    };
    const watched = new Map();            // trackers of orbits: "bodyId:primaryId" -> tracker
    const apiWatch = new Set();           // bodies the test API asked about

    // Radiation reaction of a pair as the energy it carries off per unit time (0 if not a compact, close
    // pair): minus the work rate of a_RR on the pair's energy, mu a_RR . dE/dv, where
    // dE/dv = v (1 + (3/2)(1 - 3 eta) v^2/c^2 + (3 + eta) GM/(rc^2)) + eta GM/(rc^2) rdot n, plus the 2PN
    // terms' (from the energy in systemEnergy). Also sets RR_X, RR_Y, RR_VX, RR_VY: the relative position
    // and velocity.
    let RR_X = 0, RR_Y = 0, RR_VX = 0, RR_VY = 0;
    function radiationPower(i, j) {
        const dx = j.x - i.x, dy = j.y - i.y;
        const r2 = dx * dx + dy * dy, r = Math.sqrt(r2);
        const msum = i.m + j.m, gm = G * msum;
        RR_X = -dx; RR_Y = -dy; RR_VX = i.vx - j.vx; RR_VY = i.vy - j.vy;
        if (!(r > 0) || !(gm > RR_MIN_C2 * r)) return 0;
        const eta = (i.m * j.m) / (msum * msum), mu = eta * msum;
        const nx = -dx / r, ny = -dy / r, vx = RR_VX, vy = RR_VY;
        const rd = nx * vx + ny * vy, v2 = vx * vx + vy * vy, gr = gm / r;
        const k = 1.6 * eta * gm * gm / (C5 * r2 * r);
        const A = k * (18 * v2 + (2 / 3) * gr - 25 * rd * rd) * rd, B = -k * (6 * v2 - 2 * gr - 15 * rd * rd);
        const av = A * rd + B * v2, an = A + B * rd;
        const e2 = energy2PN(v2, rd, gr, eta);
        const dv2 = 0.5 + 0.75 * (1 - 3 * eta) * v2 / C2 + 0.5 * (3 + eta) * gr / C2 + e2.dv2;
        const drd = eta * gr * rd / C2 + e2.drd;
        return -mu * (2 * dv2 * av + drd * an);
    }

    // The 2PN terms of a pair's energy per unit reduced mass (harmonic coordinates; Blanchet 2014, Living
    // Rev. Relativ. 17, 2, eq. 233): k, the v^6 term, and p, the rest, with their slopes dE/d(v^2) (dv2) and
    // dE/d(rdot) (drd). (Checked: they are what the 2PN motion in pnPair keeps constant.)
    const E2PN = { k: 0, p: 0, dv2: 0, drd: 0 };
    function energy2PN(v2, rd, gr, eta) {
        const e2 = eta * eta, rd2 = rd * rd, c4 = C2 * C2;
        const a6 = (5 - 35 * eta + 65 * e2) / 16;
        const b4 = (21 - 23 * eta - 27 * e2) / 8, b2 = 0.25 * eta * (1 - 15 * eta), b0 = -0.375 * eta * (1 - 3 * eta);
        const q2 = 1.75 - 6.875 * eta + 0.5 * e2, q0 = 0.5 + 8.625 * eta + 1.5 * e2, q = -0.5 - 3.75 * eta;
        E2PN.k = (a6 * v2 * v2 * v2) / c4;
        E2PN.p = (gr * (b4 * v2 * v2 + b2 * v2 * rd2 + b0 * rd2 * rd2) + gr * gr * (q2 * v2 + q0 * rd2) + q * gr * gr * gr) / c4;
        E2PN.dv2 = (3 * a6 * v2 * v2 + gr * (2 * b4 * v2 + b2 * rd2) + gr * gr * q2) / c4;
        E2PN.drd = (gr * (2 * b2 * v2 * rd + 4 * b0 * rd2 * rd) + 2 * gr * gr * q0 * rd) / c4;
        return E2PN;
    }

    // Sum the power of the pairs given radiation reaction in the last force evaluation of the bodies
    // (the 1PN pairs, re-tested), and note the strongest pair. A pair inside its innermost stable orbit
    // plunges (and the sum stops there: the bodies have changed).
    function totalRadiationPower() {
        gw.found = false;
        if (pnList !== bodies || pnN !== bodies.length) return 0;
        let P = 0, best = 0;
        for (let q = 0; q < pnCount; q++) {
            const i = bodies[PNI[q]], j = bodies[PNJ[q]];
            if (!i || !j) continue;
            if (G * (i.m + j.m) > ISCO_C2 * Math.hypot(j.x - i.x, j.y - i.y) && plunge(i, j)) return P;
            const p = gwOn ? radiationPower(i, j) : 0;
            if (!p) continue;
            P += p;
            // (the rate swings round an eccentric orbit, even below zero for a moment: in these
            // coordinates the waves' energy is only carried off at the quadrupole formula's rate on average)
            if (Math.abs(p) > best) { best = Math.abs(p); gw.a = i.m >= j.m ? i : j; gw.b = gw.a === i ? j : i; gw.mSum = i.m + j.m; gw.found = true; }
        }
        return P;
    }

    // The innermost stable orbit. Closer than about 6 GM/c^2 (for a small body round a black hole of
    // mass M exactly that, in Schwarzschild's coordinates; much the same for two equal masses), no orbit
    // lasts: the two plunge together within an orbit, which the 1PN terms can't follow (pushed that far,
    // they even turn gravity round: a body dropped straight onto a black hole would bounce back). So a
    // pair (two compact bodies, as nothing else gets that close) merges there, through mergeBodies (mass
    // and momentum kept). Two black holes make one a little lighter than the two: what the final plunge
    // and ringing radiate, from the fit E/(Mc^2) = (1 - sqrt(8/9)) eta + 4 eta^2 (4 p0 + sqrt(8/9) - 1),
    // p0 = 0.04827, to numerical-relativity mergers of black holes without spin (Barausse, Morozova &
    // Rezzolla 2012, ApJ 758, 63): 4.8% of the mass for two equal ones, 36 + 29 -> 62 solar masses, as LIGO
    // measured. The final burst carries off that energy less what the pair had already given up (its
    // orbital energy): it is added to the energy carried off, and the rest of the change in the books (the
    // orbit's energy taken into the new hole) is kept, like a tidal break-up's, so the total stays level.
    const ISCO = 6;
    const ISCO_C2 = C2 / ISCO;
    function plunge(i, j) {
        if (!settings.merge || i.held || j.held) return false;
        const bothHoles = i.kind === 'blackhole' && j.kind === 'blackhole';
        const M = i.m + j.m, eta = (i.m * j.m) / (M * M);
        const eFit = bothHoles ? ((1 - Math.sqrt(8 / 9)) * eta + 4 * eta * eta * (4 * 0.04827 + Math.sqrt(8 / 9) - 1)) * M * C2 : 0;
        const burst = bothHoles ? Math.max(0, eFit + pairEnergy(i, j)) : 0;
        const before = systemEnergy().total;
        const n = bodies.length, mi = i.m, mj = j.m;
        mergeBodies(i, j);
        const big = bodies.includes(i) ? i : j;
        if (bodies.length === n) return false;
        if (bothHoles) { big.m = M - eFit / C2; collapseIfTooHeavy(big); }
        noteMerger(big, mi, mj);
        gw.radiated += burst;
        groupEnergy.set(`plunge ${big.id} ${simTime}`, systemEnergy().total - before + burst);
        computeForces();
        refreshBodyLists();
        return true;
    }

    // A pair's own energy, with its 1PN terms (as in systemEnergy)
    function pairEnergy(i, j) {
        const M = i.m + j.m, mu = (i.m * j.m) / M, eta = mu / M, gm = G * M;
        const rx = i.x - j.x, ry = i.y - j.y, r = Math.hypot(rx, ry);
        const vx = i.vx - j.vx, vy = i.vy - j.vy, v2 = vx * vx + vy * vy, rd = (rx * vx + ry * vy) / r;
        const e2 = gm > RR_MIN_C2 * r ? energy2PN(v2, rd, gm / r, eta) : null;
        return 0.5 * mu * v2 - (G * i.m * j.m) / r
            + (mu * 0.375 * (1 - 3 * eta) * v2 * v2) / C2 + (mu * gm / (2 * r * C2)) * ((3 + eta) * v2 + eta * rd * rd + gm / r)
            + (e2 ? mu * (e2.k + e2.p) : 0);
    }

    // After each step: the energy carried off (trapezium rule over the step), the orbits being watched,
    // a merger of the radiating pair, and the wave sketch
    function relativityStep(dt) {
        relSteps++;
        const pair = gw.a && gw.b ? [gw.a, gw.b] : null;
        let P = 0;
        gw.found = false;
        if (rrSeen && settings.realistic) { rrSeen = 0; P = totalRadiationPower(); }
        gw.radiated += 0.5 * (gw.power + P) * dt;
        gw.power = P;
        if (pair && !gw.found && !(gw.merged && gw.merged.t === simTime)) checkPairMerged(pair[0], pair[1]);
        if (!gw.found) gw.a = gw.b = null;
        const b = bodyById(selectedId);
        if (b && b.primary && b.bound && !b.held && !b.primary.held) watchStep(b, b.primary);
        if (gw.a && !(b && ((b === gw.b && b.primary === gw.a) || (b === gw.a && b.primary === gw.b)))) watchStep(gw.b, gw.a);
        for (const id of apiWatch) {
            const q = bodyById(id);
            if (q && q !== b && q.primary && q.bound) watchStep(q, q.primary);
        }
        sampleWave();
    }

    // A tracker follows body b relative to p: its turns (for the period and the shrinking of the orbit)
    // and its closest points (for the turning of the orbit)
    function newTracker(b, p) {
        return {
            bid: b.id, pid: p.id, ref: b.track, n: relSteps,
            x: 0, y: 0, vx: 0, vy: 0, rd: 0, phi: 0,
            theta: 0, tTurn: simTime, rmin: Infinity, rmax: 0, turns: [],   // turns: { t, a, T } (the last few)
            peri: null, apo: 0, sense: 0,
            orbits: [],                                                     // { dw, dwE, T, e, p } (the last few)
            n0: 0, W: 0, t0: 0, sT: 0, sW: 0, sTT: 0, sTW: 0, sumE: 0, sumT: 0, others: false
        };
    }

    function watchStep(b, p) {
        const key = `${b.id}:${p.id}`;
        let tr = watched.get(key);
        const rx = b.x - p.x, ry = b.y - p.y, vx = b.vx - p.vx, vy = b.vy - p.vy;
        const rd = rx * vx + ry * vy, r = hyp(rx, ry), phi = Math.atan2(ry, rx);
        if (!tr || tr.n !== relSteps - 1 || tr.ref !== b.track) {
            // new, or it missed steps, or the body was changed: start again
            if (watched.size > 8) watched.clear();
            tr = newTracker(b, p);
            watched.set(key, tr);
        } else {
            const t = simTime, h = t - tr.t;
            // Turns: the angle swept round p
            let d = phi - tr.phi;
            if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
            const prev = Math.abs(tr.theta);
            tr.theta += d;
            if (r < tr.rmin) tr.rmin = r;
            if (r > tr.rmax) tr.rmax = r;
            const now = Math.abs(tr.theta);
            if (now >= TAU) {
                const tc = tr.t + (now > prev ? (TAU - prev) / (now - prev) : 1) * h;
                tr.turns.push({ t: tc, a: 0.5 * (tr.rmin + tr.rmax), T: tc - tr.tTurn });
                if (tr.turns.length > 6) tr.turns.shift();
                tr.tTurn = tc;
                tr.theta -= Math.sign(tr.theta) * TAU;
                tr.rmin = tr.rmax = r;
            }
            // Closest point: r.v goes from negative to positive. Its direction is that of the osculating
            // ellipse's closest point (the Runge-Lenz vector), which a Kepler orbit keeps exactly and
            // relativity turns smoothly, taken at the moment r.v = 0 between the ends of the step.
            if (tr.rd < 0 && rd >= 0 && h > 0) {
                const s = hermitePeri(tr.x, tr.y, tr.vx, tr.vy, rx, ry, vx, vy, h);
                const rp = Math.hypot(HX, HY), mu = G * (b.m + p.m);
                const w0 = lenzAngle(tr.x, tr.y, tr.vx, tr.vy, mu), w1 = lenzAngle(rx, ry, vx, vy, mu);
                let dw = w1 - w0;
                dw -= TAU * Math.round(dw / TAU);
                notePericentre(tr, b, p, tr.t + s * h, w0 + s * dw, rp, rx * vy - ry * vx);
            }
            if (r > tr.apo) tr.apo = r;
        }
        tr.n = relSteps; tr.ref = b.track; tr.t = simTime;
        tr.x = rx; tr.y = ry; tr.vx = vx; tr.vy = vy; tr.rd = rd; tr.phi = phi;
    }

    // Direction of the Runge-Lenz vector ((v^2 - mu/r) r - (r.v) v) / mu of a relative state
    function lenzAngle(rx, ry, vx, vy, mu) {
        const k = vx * vx + vy * vy - mu / Math.hypot(rx, ry), rv = rx * vx + ry * vy;
        return Math.atan2(k * ry - rv * vy, k * rx - rv * vx);
    }

    // Where r.v = 0 on the cubic (Hermite) path between relative states (x0, y0, vx0, vy0) and
    // (x1, y1, vx1, vy1) a time h apart: returns the fraction s of the step, the position in HX, HY
    let HX = 0, HY = 0;
    function hermitePeri(x0, y0, vx0, vy0, x1, y1, vx1, vy1, h) {
        const at = (s) => {
            const s2 = s * s, s3 = s2 * s;
            const h00 = 2 * s3 - 3 * s2 + 1, h10 = (s3 - 2 * s2 + s) * h, h01 = 3 * s2 - 2 * s3, h11 = (s3 - s2) * h;
            const d00 = 6 * s2 - 6 * s, d10 = (3 * s2 - 4 * s + 1) * h, d01 = 6 * s - 6 * s2, d11 = (3 * s2 - 2 * s) * h;
            HX = h00 * x0 + h10 * vx0 + h01 * x1 + h11 * vx1;
            HY = h00 * y0 + h10 * vy0 + h01 * y1 + h11 * vy1;
            return HX * (d00 * x0 + d10 * vx0 + d01 * x1 + d11 * vx1) + HY * (d00 * y0 + d10 * vy0 + d01 * y1 + d11 * vy1);
        };
        let lo = 0, hi = 1;
        for (let k = 0; k < 48; k++) {
            const mid = 0.5 * (lo + hi);
            if (at(mid) < 0) lo = mid; else hi = mid;
        }
        const s = 0.5 * (lo + hi);
        at(s);
        return s;
    }

    // A closest point passed at time t, in direction w, at distance rp (hh: the sign of the way round)
    function notePericentre(tr, b, p, t, w, rp, hh) {
        const last = tr.peri;
        tr.peri = { t, w, rp };
        const apo = tr.apo;
        tr.apo = rp;
        if (!last) return;
        const sense = hh < 0 ? -1 : 1;
        let dw = w - last.w;
        dw -= TAU * Math.round(dw / TAU);
        dw *= sense;
        const T = t - last.t;
        const rmin = 0.5 * (rp + last.rp), rmax = Math.max(apo, rmin);
        const pp = (2 * rmin * rmax) / (rmin + rmax), e = (rmax - rmin) / (rmax + rmin);
        const dwE = (6 * Math.PI * G * (b.m + p.m)) / (C2 * pp);
        tr.orbits.push({ dw, dwE, T, e, p: pp, a: 0.5 * (rmin + rmax), t });
        if (tr.orbits.length > 8) tr.orbits.shift();
        // Running sums for the straight-line fit of the total turn against time, and Einstein's share
        if (!tr.n0) { tr.t0 = last.t; tr.sT = 0; tr.sW = 0; tr.sTT = 0; tr.sTW = 0; tr.n0 = 1; tr.W = 0; }
        tr.W += dw;
        const x = t - tr.t0;
        tr.n0++; tr.sT += x; tr.sW += tr.W; tr.sTT += x * x; tr.sTW += x * tr.W;
        tr.sumE += dwE; tr.sumT += T;
        tr.others = othersPull(b, p, pp);
    }

    // Could other bodies' pulls turn this orbit as much as a fifth of relativity does? Their tides on it,
    // sum of (m/M)(r/d)^3 over bodies farther out than it (d from what it orbits) and (m/M)(d/r)^2 over
    // those closer in, against GM/(pc^2) (their turn per orbit is about (3 pi / 2) times the first,
    // Einstein's 6 pi times the second)
    function othersPull(b, p, pp) {
        const M = b.m + p.m, r = Math.hypot(b.x - p.x, b.y - p.y);
        let tau = 0;
        for (const q of bodies) {
            if (q === b || q === p || !(q.m > 0)) continue;
            const d = Math.hypot(q.x - p.x, q.y - p.y);
            tau += d > r ? (q.m / M) * Math.pow(r / d, 3) : (q.m / M) * Math.pow(d / r, 2);
        }
        return tau > 0.2 * G * M / (C2 * pp);
    }

    // Did the radiating pair touch and merge in the last step (one of them gone, the other with both
    // masses)? (A plunge notes its merger itself.)
    function checkPairMerged(a, b) {
        const gone = !bodies.includes(a) ? a : !bodies.includes(b) ? b : null;
        const big = gone === a ? b : a;
        if (gone && bodies.includes(big) && Math.abs(big.m - gw.mSum) <= 1e-9 * big.m) noteMerger(big, gone.m, gw.mSum - gone.m);
    }

    // Two compact bodies (masses m1, m2) merged into big
    function noteMerger(big, m1, m2) {
        gw.merged = { t: simTime, id: big.id, m: big.m, m1: Math.max(m1, m2), m2: Math.min(m1, m2) };
        // (said in the hint line too, which screen readers announce)
        const kind = big.kind === 'blackhole' ? 'black hole' : big.kind === 'neutron' ? 'neutron star' : 'body';
        const lost = m1 + m2 - big.m;
        showHint('note', `<strong>Merged:</strong> one ${kind} of ${fmtMass(big.m)}${lost > 0 ? `. ${fmtMass(lost)} of mass went into gravitational waves` : ''}.`, { ms: 8000 });
        // A black hole rings as it settles, at the frequency and damping of its main (l = m = 2) mode:
        // omega = 0.3737 c^3/(GM), damping time GM/(0.0890 c^3) (Berti, Cardoso & Will 2006)
        if (big.kind === 'blackhole') {
            const tM = (G * big.m) / (C2 * C_LIGHT);
            let A = 0;
            for (let k = 1; k <= 24 && k <= gw.waveN; k++) A = Math.max(A, Math.abs(gw.wave[(gw.waveN - k) % WAVE_N]));
            gw.ring = { t0: simTime, A, w: 0.3737 / tM, tau: tM / 0.089 };
        } else {
            gw.frozen = true;   // (the chirp stays in view)
        }
    }

    // The wave as seen from above the orbit: h+ is proportional to the second time derivative of the
    // pair's quadrupole moment, mu d^2(x^2 - y^2)/dt^2 / 2 = mu (vx^2 - vy^2 - GM (x^2 - y^2)/r^3) (relative
    // position and velocity; for a circular orbit, proportional to (G M omega)^(2/3) cos 2 phi). Sampled
    // WAVE_N times in 2.5 of the scene's reference periods; after a merger, the new black hole's ringing,
    // then it stops (the chirp stays in view).
    function sampleWave() {
        if (gw.frozen && gw.a) { gw.frozen = false; gw.waveN = 0; gw.ring = null; }   // (a new pair)
        if (gw.frozen) return;
        if (!gw.waveDt) gw.waveDt = (2.5 * scene.Tref) / WAVE_N;
        if (!gw.a && !gw.ring && !gw.waveN) { gw.waveT = simTime; return; }
        while (gw.waveT + gw.waveDt <= simTime) {
            gw.waveT += gw.waveDt;
            let h = 0;
            if (gw.a && gw.b) {
                radiationPower(gw.b, gw.a);
                const x = RR_X, y = RR_Y, r2 = x * x + y * y, r = Math.sqrt(r2);
                const mu = (gw.a.m * gw.b.m) / (gw.a.m + gw.b.m);
                h = mu * (RR_VX * RR_VX - RR_VY * RR_VY - (G * (gw.a.m + gw.b.m) * (x * x - y * y)) / (r2 * r));
            } else if (gw.ring) {
                const s = gw.waveT - gw.ring.t0;
                h = gw.ring.A * Math.exp(-s / gw.ring.tau) * Math.cos(gw.ring.w * s);
                if (s > 12 * gw.ring.tau) { gw.ring = null; gw.frozen = true; }
            }
            gw.wave[gw.waveN % WAVE_N] = h;
            gw.waveN++;
        }
    }

    // The tracker following either body of a pair round the other, if any
    function pairTracker(a, b) {
        return watched.get(`${b.id}:${a.id}`) || watched.get(`${a.id}:${b.id}`) || null;
    }

    function resetRelativity() {
        gw.radiated = 0; gw.power = 0; gw.a = gw.b = null; gw.merged = null; gw.ring = null;
        gw.waveN = 0; gw.waveDt = 0; gw.frozen = false;
        rrSeen = 0;
        watched.clear();
    }

    // A scene can switch realistic physics on (one about relativity)
    // A scene that needs relativity switches realistic physics on; moving on to a scene that doesn't
    // puts the switch back (unless it was changed by hand meanwhile), so "Three stars: chaos" isn't
    // quietly run with Einstein's corrections after a visit to Mercury
    let realisticByScene = false;
    if (ui.realistic) {
        ui.realistic.addEventListener('change', () => {
            // (switched back on in such a scene, it is the scene's again, and goes when the scene does)
            const needed = !!(scene && scene.realistic);
            realisticByScene = needed && ui.realistic.checked;
            if (needed && !ui.realistic.checked) showHint('note', '<strong>Realistic physics off:</strong> just Newton, so a plain ellipse.', { ms: 6000 });
            else if (needed) clearHint('note');
        });
    }
    function setRealisticSwitch(on) {
        settings.realistic = on;
        if (ui.realistic) ui.realistic.checked = on;
        forcesDirty = true;
    }
    function relativitySceneLoaded(def) {
        resetRelativity();
        apiWatch.clear();
        if (def.realistic && !settings.realistic) {
            setRealisticSwitch(true);
            realisticByScene = true;
        } else if (!def.realistic && realisticByScene) {
            setRealisticSwitch(false);
            realisticByScene = false;
        }
    }

    // The precession of body b's orbit as measured so far: per orbit (radians) and per year, with
    // Einstein's value for the same orbits, or null before the first full orbit
    function precessionOf(b) {
        const p = b && b.primary;
        if (!p) return null;
        const tr = watched.get(`${b.id}:${p.id}`);
        if (!tr || !tr.orbits.length) return { orbits: 0, tracker: tr || null };
        const last = tr.orbits[tr.orbits.length - 1];
        const n = tr.n0;
        // Straight-line fit of the total turn against time (rad / yr) once there are three passages
        let rate = last.dw / last.T;
        if (n >= 3) {
            const den = n * tr.sTT - tr.sT * tr.sT;
            if (den > 0) rate = (n * tr.sTW - tr.sT * tr.sW) / den;
        }
        const rateE = tr.sumE / tr.sumT;
        return {
            orbits: tr.orbits.length ? n - 1 : 0, last, others: tr.others, round: last.e < PREC_E_MIN,
            perOrbit: tr.others ? rate * last.T : last.dw, einstein: tr.others ? rateE * last.T : last.dwE,
            rate, rateE, T: last.T, tracker: tr
        };
    }

    // ---- The relativity card (top right, with realistic physics, only when there is something to show) ----
    // The turning of the chosen body's orbit, when it is elliptical enough to have a clear closest point;
    // and the gravitational waves of the pair radiating most, when they shrink its orbit noticeably (by at
    // least a hundred-thousandth a turn), with a sketch of the wave: a chirp that rises in pitch and
    // strength as the pair closes in, and the ringing of the new black hole after they merge.
    function fmtTurn(rad, perCentury) {
        const deg = (rad * 180) / Math.PI;
        if (!perCentury && Math.abs(deg) >= 0.1) return `${Math.abs(deg) >= 10 ? deg.toFixed(1) : deg.toFixed(2)}°`;
        return `${fmtSig(deg * 3600)}″`;
    }

    function precessionLines(b, compact, title, C) {
        // (a piece of a torn-apart body has no orbit of its own to turn)
        if (b.grp || !orbitingBody(b) || !b.bound || (b.kep && b.kep.fast)) return null;
        const p = b.primary, el = elementsOf(b, p);
        if (!el || !el.bound) return null;
        const r = precessionOf(b);
        // Round orbits have no clear closest point. (Until one is measured, the osculating e, which for a
        // round orbit this close to a black hole is about 3 GM/(rc^2), not 0)
        if (r && r.orbits > 0 ? r.round : el.e < PREC_E_MIN + (4 * G * (b.m + p.m)) / (C2 * el.r)) return null;
        const done = r && r.orbits > 0;
        const eNow = (6 * Math.PI * G * (b.m + p.m)) / (C2 * el.p);
        const T = done ? r.T : el.T;
        const big = Math.max(Math.abs(done ? r.perOrbit : 0), eNow) >= 0.1 * Math.PI / 180;
        const century = !big && T * DAYS_PER_YEAR >= 1;
        // Per orbit (degrees, or arcseconds), or per century (arcseconds) for slow, small turns
        const say = (perOrbit, rate, unit) => (century ? `${fmtTurn(rate * 100, true)}${unit ? ' a century' : ''}`
            : `${fmtTurn(perOrbit)}${unit ? (compact ? ' a turn' : ' each time round') : ''}`);
        const lines = [];
        if (!done) {
            const tr = r && r.tracker;
            const f = tr && tr.peri ? clamp((simTime - tr.peri.t) / T, 0, 0.99) : 0;
            const wait = `measuring… ${Math.round(100 * f)}%`;
            if (compact) return [[title('Orbit turns: '), [`${wait} · Einstein ${say(eNow, eNow / T, false)}`]]];
            return [[title('The orbit turns (precession)')], [[`Measured: ${wait}`]], [[`Einstein: ${say(eNow, eNow / T, true)}`]]];
        }
        const einstein = say(r.einstein, r.others ? r.rateE : r.einstein / r.T, false);
        const measured = say(r.perOrbit, r.rate, true);
        if (compact) return [[title('Orbit turns: '), [`${measured}${r.others ? ', Einstein\'s ' : ' · Einstein '}${einstein}`]]];
        lines.push([title('The orbit turns (precession)')]);
        lines.push([[`Measured: ${measured}`]]);
        lines.push([[`${r.others ? 'Einstein\'s share' : 'Einstein'}: ${einstein}`]]);
        if (r.others) lines.push([['The rest: other bodies\' pulls', false, C.subtle]]);
        else if (century) lines.push([[`(${fmtTurn(r.perOrbit, true)} each time round)`, false, C.subtle]]);
        else if (Math.abs(r.perOrbit / r.einstein - 1) > 0.02 && G * (b.m + p.m) / (C2 * r.last.p) > 1e-3) {
            lines.push([['The gap: relativity\'s next terms, strong this close', false, C.subtle]]);
        }
        return lines;
    }

    // The gravitational-wave lines: { lines, wave } or null
    function waveLines(b, compact, title, C) {
        const merged = gw.merged && bodyById(gw.merged.id);
        if (!gw.a && !merged) return null;
        const lines = [];
        if (!gw.a) {
            const kind = merged.kind === 'blackhole' ? 'black hole' : merged.kind === 'neutron' ? 'neutron star' : 'body';
            const lost = gw.merged.m1 + gw.merged.m2 - merged.m;
            if (compact) lines.push([title('Merged: '), [`one ${kind} of ${fmtMass(merged.m)}`]]);
            else lines.push([title('Gravitational waves')], [[`Merged: one ${kind} of ${fmtMass(merged.m)}`]]);
            if (lost > 0) lines.push([[`${fmtMass(lost)} of mass went into waves`]]);
            return { lines, wave: gw.waveN > 1 };
        }
        const a = gw.a, c = gw.b;
        const rx = c.x - a.x, ry = c.y - a.y, vx = c.vx - a.vx, vy = c.vy - a.vy, r = Math.hypot(rx, ry);
        const tr = pairTracker(a, c);
        const ecc = tr && tr.orbits.length && tr.orbits[tr.orbits.length - 1].e >= 0.1;
        // Period: the last radial period of an eccentric orbit, otherwise the turning rate now
        const T = ecc ? tr.orbits[tr.orbits.length - 1].T : (TAU * r * r) / Math.abs(rx * vy - ry * vx);
        // Shown only if the waves shrink the orbit noticeably: Peters' average rate of energy loss over a
        // turn against the orbit's energy, (128 pi / 5) eta (GM/(c^2 a))^(5/2) f(e), at least 1e-5
        const el = relElements(rx, ry, vx, vy, G * (a.m + c.m));
        const e2 = el.bound ? el.e * el.e : 0, M = a.m + c.m;
        const fe = (1 + (73 / 24) * e2 + (37 / 96) * e2 * e2) / Math.pow(1 - Math.min(e2, 0.99), 3.5);
        if (el.bound && (128 * Math.PI / 5) * (a.m * c.m / (M * M)) * Math.pow(G * M / (C2 * el.a), 2.5) * fe < 1e-5) return null;
        let shrink = null;
        if (tr) {
            const list = ecc && tr.orbits.length >= 2 ? tr.orbits : !ecc && tr.turns.length >= 2 ? tr.turns : null;
            if (list) shrink = (list[list.length - 2].a - list[list.length - 1].a) * AU_KM;
        }
        const km = shrink === null ? 'measuring…' : shrink >= 1 ? `${fmtKm(shrink)} km` : `${fmtSig(shrink * 1000)} m`;
        const freq = `${fmtSig(2 / (T * YEAR_S))} Hz`;   // (twice a turn)
        const mine = b === a || b === c;
        if (compact) {
            lines.push([title('Waves: '), [shrink === null ? `${freq}, orbit shrinking` : `${freq}, orbit shrinks ${km} a turn`]]);
        } else {
            lines.push([title(mine ? 'Gravitational waves' : `Gravitational waves: ${a.name} and ${c.name}`)]);
            lines.push([[`Orbit shrinks ${km}${shrink === null ? '' : ' each time round'}`]]);
            lines.push([[`Period ${fmtDuration(T, true)} · waves ${freq}`]]);
        }
        return { lines, wave: gw.waveN > 1 };
    }

    function drawRelativityCard(C, subj, y, fs, compact) {
        if (!settings.realistic || cleanRender) return y;
        const title = (t) => [t, true, C.kepler];
        const pl = precessionLines(subj, compact, title, C);
        const wl = waveLines(subj, compact, title, C);
        if (!pl && !wl) return y;
        const lines = (pl || []).concat(wl ? wl.lines : []);
        const lh = Math.round(fs * 1.4);
        const widthOf = (line) => line.reduce((s, seg) => { ctx.font = font(fs, seg[1]); return s + ctx.measureText(seg[0]).width; }, 0);
        const sketchH = wl && wl.wave ? (compact ? 18 : 30) : 0;
        const w = Math.max(...lines.map(widthOf), sketchH ? (compact ? 120 : 170) : 0) + 20;
        const h = lines.length * lh + 10 + (sketchH ? sketchH + 6 : 0);
        const x = visR - 8 - w;
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
        if (sketchH) drawWave(C, x + 10, y + 5 + lines.length * lh + 2, w - 20, sketchH);
        return y + h;
    }

    // The wave sketch: the samples kept, newest on the right, scaled to the largest
    function drawWave(C, x, y, w, h) {
        const n = Math.min(gw.waveN, WAVE_N);
        let A = 0;
        for (let k = 0; k < n; k++) A = Math.max(A, Math.abs(gw.wave[(gw.waveN - 1 - k) % WAVE_N]));
        ctx.strokeStyle = C.faint;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2);
        ctx.stroke();
        if (!(A > 0)) return;
        ctx.strokeStyle = C.kepler;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        const k0 = gw.waveN - n;
        for (let k = 0; k < n; k++) {
            const px = x + w * ((k + WAVE_N - n) / (WAVE_N - 1));
            const py = y + h / 2 - (gw.wave[(k0 + k) % WAVE_N] / A) * (h / 2 - 1.5);
            if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }
        ctx.stroke();
    }

    // Energy chart: the energy carried off by gravitational waves, and the total with it (which stays
    // level), shown while the graph's span holds any (dashed, so they don't rely on colour)
    function chartWaves(ce, E, k) {
        if (!ce.$waves) {
            const line = (label, color, dash) => ({ label, data: [], borderColor: color, borderDash: dash, borderWidth: 2, pointRadius: 0, tension: 0.2, hidden: true });
            ce.$waves = [line('Carried off by waves', '#e9a23b', [6, 3]), line('Total + carried off', '#ae85ca', [2, 3])];
            ce.data.datasets.push(...ce.$waves);
            const labels = ce.options.plugins.legend.labels;
            labels.filter = (item, data) => !(ce.$waves.includes(data.datasets[item.datasetIndex]) && data.datasets[item.datasetIndex].hidden);
        }
        const n = ce.data.labels.length, on = gw.radiated !== 0;
        let show = on;
        for (const d of ce.$waves) {
            while (d.data.length < n - 1) d.data.unshift(null);
            d.data.push(on ? (d === ce.$waves[0] ? gw.radiated : E.total + gw.radiated) * k : null);
        }
        if (!show) show = ce.$waves[0].data.some((v) => v !== null);
        ce.$waves[0].hidden = ce.$waves[1].hidden = !show;
    }

    // Advance the simulation by simDt years (as many whole adaptive steps as fit). In the animation the
    // physics gets a share of each frame's time (budgetMs, checked on the clock every few steps): if the
    // steps still owed don't fit, the simulation slows down for this frame rather than take bigger steps.
    // maxSteps (for tests) caps the steps instead, with no clock.
    let lastAdvance = { steps: 0, timedOut: false };
    function advance(simDt, maxSteps, budgetMs) {
        noteRun();   // (edit history: the first run after a change)
        checkPast();   // (running backwards: an edit starts a new history)
        if (forcesDirty) computeForces();
        acc += simDt;
        let steps = 0;
        const t0 = maxSteps ? 0 : performance.now();
        const budget = budgetMs || PHYSICS_MS;
        const every = bodies.length > 60 ? 1 : 8;
        let timedOut = false;
        while (!maxSteps || steps < maxSteps) {
            const dt = stepSize();   // (the close pairs and the next step; running back, the logged ones)
            if (!(dt > 0) || acc < dt) break;
            // (stop if the next step, at the average cost so far, would overrun the budget)
            if (!maxSteps && steps % every === 0 && steps > 0) {
                const used = performance.now() - t0;
                if (used + used / steps > budget) { timedOut = true; break; }
            }
            step(timeDir * dt);
            simTime += timeDir * dt;
            acc -= dt;
            steps++;
            if (checkMerges()) { refreshBodyLists(); }
            if (checkTides()) { refreshBodyLists(); announceTear(); }
            afterStep(dt);
            // (the clock these measure by runs forwards whichever way time goes)
            trackPeriods(timeDir * simTime);
            k2Step(timeDir * simTime);
            flybyStep();
            relativityStep(timeDir * dt);   // (the energy carried off by waves counts down when time runs back)
            missionStep();   // (missions: crashes, the time limit and the goal)
            sampleTrails();
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

    // A planet's Hill sphere is often smaller than its disc on the screen, so a moon can't be dropped
    // inside it by eye. A body of mass m and radius R dropped on a heavier body that orbits something
    // (at canvas point px, py) therefore goes to moonSpot, about the Moon's distance in Hill spheres;
    // this is that body, unless at this zoom its Hill sphere is big enough to aim within.
    function moonHost(px, py, m, R, exclude) {
        if (settings.placement !== 'circular') return null;
        let host = null, bestD = 6;
        for (const b of bodies) {
            if (b === exclude || b.minor || !(b.m > m) || !isFinite(b.hill) || !(0.25 * b.hill > 2 * (b.R + R) / AU_KM)) continue;
            const d = Math.hypot(sx(b.dx) - px, sy(b.dy) - py) - drawRadius(b);
            if (d < bestD) { bestD = d; host = b; }
        }
        if (!host) return null;
        const w = unturnPoint(wx(px), wy(py)), r = Math.hypot(w.x - host.x, w.y - host.y);
        return host.hill * scale > drawRadius(host) + 24 && r > 2 * (host.R + R) / AU_KM ? null : host;
    }

    // Where such a body goes, on the side of host that (x, y) is on. n: moons it has already, each a
    // little farther out, so that they don't share an orbit.
    function moonSpot(host, x, y, n) {
        const dx = x - host.x, dy = y - host.y, d = Math.hypot(dx, dy) || 1;
        const r = host.hill * Math.min(0.45, 0.25 + 0.1 * (n || 0));
        return d > 1e-12 ? { x: host.x + (dx / d) * r, y: host.y + (dy / d) * r } : { x: host.x + r, y: host.y };
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
            if (!p || !b.bound || b.held || p.held || ((b.minor || b.grp) && b.id !== selectedId) || (b.kep && b.kep.fast)) { b.track = null; continue; }
            const rx = b.x - p.x, ry = b.y - p.y;
            const r = hyp(rx, ry);
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
            const dx = b.x - q.x, dy = b.y - q.y, r = hyp(dx, dy);
            flyby.vNow = hyp(b.vx - s.vx, b.vy - s.vy);
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
            if (hyp(dx - flyby.pts[n - 2], dy - flyby.pts[n - 1]) > 0.04 * Math.max(r, flyby.rp) && n < 6000) flyby.pts.push(dx, dy);
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
            const dx = b.x - q.x, dy = b.y - q.y, r = hyp(dx, dy);
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
            if (!T) T = b.trail = new Float64Array(2 * (b.minor ? SWARM_TRAIL : b.grp ? PIECE_TRAIL : TRAIL_CAP));
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
            if (!p || b.minor || (b.grp && b.id !== selectedId) || b.held || p.held || !b.trail || !p.trail || trailFirst(b) > k || trailFirst(p) > k) continue;
            const ib = trailIndex(b.trail, k), ip = trailIndex(p.trail, k);
            const rx = b.x - p.x, ry = b.y - p.y;
            const ox = b.trail[ib] - p.trail[ip], oy = b.trail[ib + 1] - p.trail[ip + 1];
            if (hyp(rx - ox, ry - oy) > 0.035 * hyp(rx, ry)) return true;
        }
        return false;
    }

    // The first sample at or after time t (binary search over the kept samples). While a backward run is
    // being recorded the samples' times fall instead (trailDir -1): then the first at or before t.
    function sampleAtTime(t) {
        let lo = Math.max(trailFloor, sampleCount - TRAIL_CAP + 1), hi = sampleCount - 1;
        const s = trailDir;
        if (hi < lo || s * sampleTimes[hi % TRAIL_CAP] < s * t) return sampleCount;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (s * sampleTimes[mid % TRAIL_CAP] < s * t) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    function clearTrail(b) { b.trailStart = sampleCount; }
    function clearAllTrails() { for (const b of bodies) b.trailStart = sampleCount; }

    // ------------------------------------------------------------------
    // Scenes
    // ------------------------------------------------------------------
    function loadScene(key) {
        restoreSpeed();   // (a zoom's slower time ends with it)
        missionKeepHome(key);   // (going into a mission: what to come back to)
        noteSceneLoad(key);   // (edit history: loading or restarting a scene can be undone)
        setReverse(false, true);   // (a new or restarted scene runs forwards)
        const def = SCENES[key] || SCENES['sun-earth'];
        settings.scene = SCENES[key] ? key : 'sun-earth';
        scene = def;
        bodies = [];
        mainPairs.length = 0;
        syncHosts();
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
        relativitySceneLoaded(def);
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
        syncDatedScene();   // (the start date and the Date box, for a scene with a start date)
        // (the last scene's notes go with it; this one's tip shows until the canvas or palette is used)
        clearHint('note');
        clearHint('missionNote');
        showHint('tip', def.tip || null);
        missionSceneLoaded();   // (a mission's scene starts the mission; any other ends one)
        stabilitySceneLoaded(settings.scene);   // (the timer a random system switched on goes with it)
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
        F = freeze ? frozenOrigin(simTime + lag) : liveFrameOrigin();
        turnDrawnPositions();   // (a rotating frame turns them about F: see "Rotating frame")
        // A held body stays exactly where it is held in the view
        for (const b of bodies) {
            if (b.held) { b.dx = F.x + b.held.offX; b.dy = F.y + b.held.offY; }
        }
    }

    // The frame origin from the integrator's positions (no extrapolation)
    function stateFrameOrigin() {
        if (freeze) return frozenOrigin(simTime);
        if (turn.on) { const P = turnPair(); if (P) return pairCentre(P, false); }
        const L = frameId !== null ? bodyById(frameId) : null;
        if (L) return { x: L.x, y: L.y };
        const c = totals(bodies);
        return { x: c.x, y: c.y };
    }

    // The frame's origin while frozen (a body it moves with is being dragged), at time t: it carries on at
    // the velocity it had when the drag began (a centre of mass that drifts, after a throw say, keeps
    // drifting, so the rest of the view doesn't slide while the body is held), less the dragged body's
    // own part, which the drag takes over (freeze: { x, y, vx, vy, t, phi }, see startHold)
    function frozenOrigin(t) {
        const dt = t - freeze.t;
        return { x: freeze.x + freeze.vx * dt, y: freeze.y + freeze.vy * dt, phi: freeze.phi };
    }

    const sx = (x) => midX + (x - F.x - view.panX) * scale;
    const sy = (y) => viewH / 2 - (y - F.y - view.panY) * scale;
    const wx = (px) => F.x + view.panX + (px - midX) / scale;
    const wy = (py) => F.y + view.panY - (py - viewH / 2) / scale;

    function updateScale() {
        const m = Math.max(1, Math.min(viewW, viewH));
        scale = view.zoom * m;
        sizeScale = clamp(m / 560, 0.62, 1.1);
        midX = viewW / 2 + view.shift;
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
    const bodySize = (b) => (b.grp ? 3.5 * pieceHeft(b) : b.minor ? MINOR_SIZE : symbolicSize(b.kind, b.m, b.R));
    // How big a piece of a torn-apart body looks beside the others, by its mass among them (x: its mass over
    // their average). Set as it breaks; a piece put back from a copy or a link works it out when it is drawn.
    const heftOf = (x) => clamp(Math.sqrt(x), 0.55, 1.8);
    function pieceHeft(b) {
        if (!b.heft) {
            let M = 0, n = 0;
            for (const q of bodies) if (q.grp === b.grp) { M += q.m; n++; }
            b.heft = heftOf((n * b.m) / M);
        }
        return b.heft;
    }

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
        for (const b of bodies) b.rd = b.rh = Math.max(b.minor ? 1.2 : b.grp ? 1.8 : 3, b.rmax, (b.R / AU_KM) * scale);
    }

    // Change the view so a world box (relative to the frame origin) fits what can be seen of the canvas
    // (at no more than the zoom most, if given).
    function fitBox(box, animate, most) {
        const m = Math.max(1, Math.min(viewW, viewH));
        const w = Math.max(box[1] - box[0], 1e-9), h = Math.max(box[3] - box[2], 1e-9);
        const W = visR - visL || 800, H = viewH || 500;
        const pxPerAu = Math.min((W - 40) / w, (H - 40) / h);
        const target = { zoom: Math.min(pxPerAu / m, most || Infinity), panX: 0.5 * (box[0] + box[1]), panY: 0.5 * (box[2] + box[3]) };
        if (!viewW || !viewH) { view.pendingBox = box; }
        view.panned = false;
        drawerCamera(box);
        if (animate) view.anim = target;
        else { view.zoom = target.zoom; view.panX = target.panX; view.panY = target.panY; view.anim = null; }
    }

    // Fit every body, and the whole orbit of each bound one, in the view.
    function fitAll() {
        if (!bodies.length) return;
        // (a mission locked on a body has its own view: the Sun, far off, isn't part of it)
        if (mission.def && mission.def.lock !== undefined) { fitBox(mission.def.scene.box, true); return; }
        updateDrawnPositions();
        // (a lone body has no extent to fit: it would fill the screen, so the scene's own size instead)
        if (bodies.length === 1) {
            const b = bodies[0], w = 0.5 * (scene.box[1] - scene.box[0]), h = 0.5 * (scene.box[3] - scene.box[2]);
            fitBox([b.dx - F.x - w, b.dx - F.x + w, b.dy - F.y - h, b.dy - F.y + h], true);
            return;
        }
        fitBox(paddedBox(sceneBox(true)), true);
    }

    const paddedBox = (q) => {
        const pad = 0.08 * Math.max(q[1] - q[0], q[3] - q[2], 1e-6);
        return [q[0] - pad, q[1] + pad, q[2] - pad, q[3] + pad];
    };

    // The box round every body, and with orbits, the whole orbit of each bound one (relative to the frame origin)
    function sceneBox(orbits) {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        const add = (x, y) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
        for (const b of bodies) {
            add(b.dx - F.x, b.dy - F.y);
            if (orbits && b.bound && b.primary && b.primary.primary !== b) {
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
        return [x0, x1, y0, y1];
    }

    // The glide: the zoom and the way left to go close in together, counted in px on the screen, so what
    // it is heading for comes steadily nearer even while the zoom races in. It aims at where a body that
    // is moving through the view (a.ref) is now, not where it was at the start, for as long as the glide
    // lasts (a target on the move is never quite caught, so that much is the limit).
    const GLIDE_FOLLOW_MS = 1500;
    function stepViewAnimation(dtReal) {
        if (view.shift !== view.shiftTo) {
            view.shift = view.shiftTo + (view.shift - view.shiftTo) * Math.exp(-dtReal / 0.16);
            if (Math.abs(view.shift - view.shiftTo) < 0.3) view.shift = view.shiftTo;
        }
        const a = view.anim;
        if (!a) return;
        if (a.ref && bodies.includes(a.ref)) { a.panX = a.ref.dx - F.x + a.ox; a.panY = a.ref.dy - F.y + a.oy; }
        const k = 1 - Math.exp(-dtReal / 0.16), zoom0 = view.zoom;
        view.zoom *= Math.pow(a.zoom / view.zoom, k);
        const left = (1 - k) * Math.min(1, zoom0 / view.zoom);
        view.panX = a.panX + (view.panX - a.panX) * left;
        view.panY = a.panY + (view.panY - a.panY) * left;
        const done = Math.abs(Math.log(a.zoom / view.zoom)) < 0.002 && Math.abs(a.panX - view.panX) * scale < 0.3 && Math.abs(a.panY - view.panY) * scale < 0.3;
        if (done) { view.zoom = a.zoom; view.panX = a.panX; view.panY = a.panY; view.anim = null; }
        else if (a.ref && performance.now() > a.until && Math.abs(Math.log(a.zoom / view.zoom)) < 0.002) view.anim = null;
    }

    // The glide just begun stays aimed at this body, wherever it goes meanwhile
    function glideWith(ref) {
        const a = view.anim;
        if (!a || !ref) return;
        a.ref = ref; a.ox = a.panX - (ref.dx - F.x); a.oy = a.panY - (ref.dy - F.y);
        a.until = performance.now() + GLIDE_FOLLOW_MS;
    }

    function zoomAt(px, py, factor) {
        const x = wx(px), y = wy(py);
        const was = { zoom: view.zoom, panX: view.panX, panY: view.panY };
        view.zoom = clamp(view.zoom * factor, 1e-7, 1e7);
        view.anim = null;
        drawer.moved = true;
        updateScale();
        view.panX = x - F.x - (px - midX) / scale;
        view.panY = y - F.y + (py - viewH / 2) / scale;
        if (factor > 1 && insideOf()) { Object.assign(view, was); updateScale(); }   // (no further in: see insideOf)
    }

    // The body whose true disc covers the whole canvas, if any: the view is inside it, with nothing to see
    function insideOf() {
        for (const b of bodies) {
            const x = sx(b.dx), y = sy(b.dy);
            if (Math.hypot(Math.max(x, viewW - x), Math.max(y, viewH - y)) < (b.R / AU_KM) * scale) return b;
        }
        return null;
    }

    // Change the frame without the view jumping, then glide to the new centre.
    function setFrame(id) {
        updateDrawnPositions();
        const before = viewOrigin();
        frameId = id !== null && bodyById(id) ? id : null;
        if (frameId === null) restoreSpeed();   // (a zoom's slower time ends with it)
        freeze = null;
        view.panned = false;
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
        refreshHint();   // (a scene's tip that names the view follows it)
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

    // How far the view will be turned dt years from now (for a place predicted ahead, such as a mission's
    // closest approach): in a rotating frame the pair will have turned on, by its two-body orbit
    function turnAngleIn(dt) {
        const P = turnPair();
        if (!P || !dt) return turn.phi;
        keplerDrift(P.B.x - P.A.x, P.B.y - P.A.y, P.B.vx - P.A.vx, P.B.vy - P.A.vy, G * (P.A.m + P.B.m), dt);
        return turn.alpha - Math.atan2(KY, KX);
    }

    // Where the frame's origin is and how far the view is turned, taken before a change (see keepScreen)
    const viewOrigin = () => ({ x: F.x, y: F.y, phi: turn.phi });
    // After a change that moved the frame's origin or turned the view (drawn positions already worked
    // out again): keep everything on the screen where it was. The pan takes up the move, turned as the
    // view is; the turn goes into the dying turn, so the view then glides round to its new angle. With
    // stay, a rotating frame instead takes the new angle as its line's direction on the screen, so the
    // view doesn't turn at all (one of the pair has been dragged to a new place).
    function keepScreen(before, stay) {
        const d = before.phi !== undefined ? wrapAngle(before.phi - turn.phi) : 0;
        if (Math.abs(d) > 1e-9) {
            if (stay && turn.on) turn.up = wrapAngle(turn.up + d); else addEase(d);
            updateDrawnPositions();
        }
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
        showHint('note', `<strong>Rotating with ${escapeHtml(theName(B))} and ${escapeHtml(theName(A))}:</strong> the view turns, so both stand still.`, { ms: 7000, tag: 'turn' });
        return true;
    }

    // Choosing any other frame ends a rotating one (setFrame keeps the screen still; the turn glides off)
    function leaveTurning() {
        if (!turn.on) return;
        clearHint('note', 'turn');
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

    // A link or the autosave keeps a rotating frame (B is its frame): [id of A, the line's direction]
    const turnSetup = () => (turnPair() ? [turn.aId, +turn.up.toFixed(6)] : undefined);
    // ...and opening one puts it back as it was, with frameId already set to B and no glide (its pan is
    // in the turned view, so it must be turned just as it was): t { a, up }, or null for none
    function restoreTurning(t) {
        const A = t ? bodyById(t.a) : null, B = frameId !== null ? bodyById(frameId) : null;
        Object.assign(turn, A && B && A !== B ? { on: true, aId: A.id, bId: B.id, up: wrapAngle(t.up) } : { on: false, aId: null, bId: null });
        turn.easeAmt = 0;
        pred.key = '';
        markPreview();
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
                const ecc = el && el.bound && el.e > 0.03 ? ` ${sentenceCase(theName(P.B))} slides in and out along its ellipse.` : '';
                const lag = settings.lagrange ? '' : ' Lagrange points: More options.';
                setText(ui.turnNote, `Arrows show motion in this turning view.${ecc}${lag}`);
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

    // Running back (see drawPast): where the frame's origin was between trail samples k and k + 1 (f of
    // the way), and how that moment's places turn into the view, as turnedTrails does for each sample:
    // { ox, oy, c, s } (no ox: the ordinary origin, while an ordinary frame glides square). Null when the
    // view isn't turned; 'none' when the pair's own samples don't reach back that far.
    function turnedSampleFrame(k, f) {
        const P = turnPair();
        if (!P) return turn.phi ? { c: turn.c, s: turn.s } : null;
        const TA = P.A.trail, TB = P.B.trail;
        if (!TA || !TB || trailFirst(P.A) > k || trailFirst(P.B) > k) return 'none';
        const at = (T, j) => { const i0 = trailIndex(T, k), i1 = trailIndex(T, k + 1); return T[i0 + j] + f * (T[i1 + j] - T[i0 + j]); };
        const ax = at(TA, 0), ay = at(TA, 1), bx = at(TB, 0), by = at(TB, 1), M = P.A.m + P.B.m;
        const a = turn.alpha - Math.atan2(by - ay, bx - ax);
        return { ox: (P.A.m * ax + P.B.m * bx) / M, oy: (P.A.m * ay + P.B.m * by) / M, c: Math.cos(a), s: Math.sin(a) };
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
            return `L${i + 1}, ${where}: keeps pace with ${b}, but drifts away if nudged.`;
        }
        const where = i === 3 ? 'ahead of' : 'behind';
        return Q.mu < ROUTH_MU ? `L${i + 1}, 60° ${where} ${b}: stable, so small bodies gather (like Jupiter's Trojans).`
            : `L${i + 1}, 60° ${where} ${b}: not stable, as ${b} is too heavy compared with ${a}.`;
    }

    // Small diamonds labelled L1 to L5 (over the bodies' dots, under their names and arrows). One hidden
    // under A or B, or crowding another, is left out, and all of them while the pair is too close
    // together on the screen to tell the points apart (zoom in to see them).
    let lagrangeShown = [];      // the markers drawn this frame: { x, y, i, text }
    function drawLagrangePoints(C) {
        lagrangeShown = [];
        if (!settings.lagrange) return;
        const Q = lagrangePair();
        if (!Q) return;
        const ax = sx(Q.A.dx), ay = sy(Q.A.dy), bx = sx(Q.B.dx), by = sy(Q.B.dy);
        if (Math.hypot(bx - ax, by - ay) < 60) return;
        const pts = lagrangePoints(Q, true);
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
            ctx.fillStyle = C.label;   // (as the bodies' names: over the well's shading the fainter grey was hard to read)
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

    // A tap on a Lagrange point's marker (by touch) reads its note, even among a swarm's dots, such as
    // the Trojans crowded round L4 and L5: only a body with a name (or the chosen one) near it comes first
    const LAGRANGE_TAP = 18;
    function namedBodyAt(x, y, tol) {
        let best = null, bestD = Infinity;
        for (const b of bodies) {
            if (b.minor && !isChosen(b)) continue;
            const d = Math.hypot(sx(b.dx) - x, sy(b.dy) - y) - drawRadius(b);
            if (d < tol && d < bestD) { bestD = d; best = b; }
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
    //   up) with a margin round the view: the shading as a tiny image, one pixel per grid point, smoothly
    //   scaled up, and the lines as paths, painted once onto a picture the size of the canvas and its
    //   margin (painting them takes far longer than copying it). Again only when a body has moved a pixel
    //   or the view has changed more than shifting and scaling the old picture can cover, and at most
    //   every few frames if that is slow; in between, the old picture follows the zoom and pan.
    // ------------------------------------------------------------------
    const WELL_CELL = 7;          // px between grid points
    const WELL_WORK = 240000;     // at most about this many body-point sums per picture
    const WELL_BODIES = 24;       // the heaviest bodies that make the picture
    const WELL_LEVELS = 9;        // about this many steps between contour lines across the depths in view
    const WELL_SOFT_MS = 150;     // a picture shifted or scaled is painted afresh after this long
    Object.assign(settings, { well: false, lagrange: false });
    Object.assign(ui, { wellToggle: byId('wellToggle'), lagrangeToggle: byId('lagrangeToggle') });
    const well = {
        small: null, smallCtx: null, img: null,   // the shading, one pixel per grid point
        U: null,                          // the depth at each grid point
        next: null,                       // what computeWell has worked out, until it is painted
        pic: null, picCtx: null,          // the whole picture, in the canvas's own pixels, the margin included
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
        const x0 = F.x + view.panX + (-margin - midX) / scale, y0 = F.y + view.panY + (margin + viewH / 2) / scale;
        const step = cell / scale;
        if (!well.U || well.U.length !== gw * gh) well.U = new Float32Array(gw * gh);
        const U = well.U;
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
        well.next = {
            lines, strong: crit.length ? strong : null, omega: P ? turn.omega : 0,
            view: { fx: F.x, fy: F.y, panX: view.panX, panY: view.panY, scale, w: viewW, h: viewH, mid: midX, margin, cell, gw, gh, off: Math.ceil(margin * dpr) },
            pos: src.map((b) => ({ b, x: sx(b.dx), y: sy(b.dy) }))
        };
        well.t = performance.now();
        well.cost = well.t - t0;
        well.wait = clamp(10 * well.cost, 0, 100);
        well.count++;
        well.info = { cell, grid: [gw, gh], bodies: n, step: dz, umin, umax, crit: crit.slice() };
    }

    // Paint what computeWell worked out onto the picture that drawGravityWell copies (v.off: where the
    // view's top-left corner is in it). In the frame after, unless it is needed at once, so one frame
    // doesn't have to do both.
    function paintWell(C) {
        const N = well.next, v = N.view, c = v.cell;
        well.next = null;
        const pw = Math.ceil((v.w + 2 * v.margin) * dpr) + 1, ph = Math.ceil((v.h + 2 * v.margin) * dpr) + 1;
        if (!well.pic || well.pic.width !== pw || well.pic.height !== ph) {
            well.pic = document.createElement('canvas');
            well.pic.width = pw; well.pic.height = ph;
            well.picCtx = well.pic.getContext('2d');
        }
        const g = well.picCtx;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, pw, ph);
        g.setTransform(dpr, 0, 0, dpr, v.off, v.off);
        g.imageSmoothingEnabled = true;
        g.drawImage(well.small, -v.margin - c / 2, -v.margin - c / 2, v.gw * c, v.gh * c);
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.lineWidth = 1;
        g.strokeStyle = C.dark ? 'rgba(205,214,240,0.2)' : 'rgba(30,45,90,0.24)';
        g.stroke(N.lines);
        if (N.strong) {
            g.lineWidth = 1.3;
            g.strokeStyle = C.dark ? 'rgba(205,214,240,0.36)' : 'rgba(30,45,90,0.42)';
            g.stroke(N.strong);
        }
        well.view = v; well.pos = N.pos; well.omega = N.omega;
    }

    // How the picture's screen points map onto the screen now: x' = k x + tx, y' = k y + ty
    function wellMap(v) {
        const k = scale / v.scale;
        return {
            k,
            tx: midX - k * v.mid + scale * (v.fx + v.panX - F.x - view.panX),
            ty: viewH / 2 - (k * v.h) / 2 - scale * (v.fy + v.panY - F.y - view.panY)
        };
    }

    // Is the old picture still good enough to shift into place?
    function wellStale(v, map, P) {
        if (map.k < 0.85 || map.k > 1.18) return true;
        // (a copy shifted or scaled is a little softer: only for a moment, while the view moves)
        if ((map.k !== 1 || map.tx !== 0 || map.ty !== 0) && performance.now() - well.t >= WELL_SOFT_MS) return true;
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
        let paintAt = 0;
        if (sig !== well.sig || !well.view) {
            computeWell(C, src, P);
            well.sig = sig;
            paintWell(C);
        } else if (well.next) {
            paintAt = performance.now();
            paintWell(C);
        } else if (performance.now() - well.t >= well.wait && wellStale(well.view, wellMap(well.view), P)) {
            computeWell(C, src, P);
        }
        // The picture, shifted (by whole pixels, which keeps it sharp) or scaled into place
        const v = well.view, map = wellMap(v), pic = well.pic;
        ctx.save();
        if (map.k === 1) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(pic, Math.round(dpr * map.tx) - v.off, Math.round(dpr * map.ty) - v.off);
        } else {
            ctx.setTransform(dpr * map.k, 0, 0, dpr * map.k, dpr * map.tx, dpr * map.ty);
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(pic, -v.off / dpr, -v.off / dpr, pic.width / dpr, pic.height / dpr);
        }
        ctx.restore();
        // (the painting, done by now, counts towards the wait before the next: a tenth of the time at most)
        if (paintAt) well.wait = clamp(10 * (well.cost + performance.now() - paintAt), 0, 100);
    }

    // ---- The switches, the W key, and the Lagrange points' tooltips ----
    function setWell(on, say) {
        settings.well = !!on;
        if (ui.wellToggle) ui.wellToggle.checked = settings.well;
        well.sig = '';
        if (say && settings.well) showHint('note', '<strong>Gravity well:</strong> darker is deeper, and each line joins points of equal depth.', { ms: 6000, tag: 'well' });
        else if (!settings.well) clearHint('note', 'well');
    }
    function setLagrange(on) {
        settings.lagrange = !!on;
        if (ui.lagrangeToggle) ui.lagrangeToggle.checked = settings.lagrange;
        syncTurnUi();   // (the rotating view's note points to them while they are off)
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
        if (Math.hypot(pt.x - down.x, pt.y - down.y) > 10 || namedBodyAt(pt.x, pt.y, 12)) return;
        const m = lagrangeAt(pt.x, pt.y, LAGRANGE_TAP);
        if (!m) return;
        const comma = m.text.indexOf(',');
        showHint('note', `<strong>${escapeHtml(m.text.slice(0, comma))}</strong>${escapeHtml(m.text.slice(comma))}`, { ms: 8000, tag: 'chosen' });
    }

    function bindWell() {
        if (ui.wellToggle) {
            ui.wellToggle.checked = settings.well;
            ui.wellToggle.addEventListener('change', () => setWell(ui.wellToggle.checked, true));
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
    let listsWait = false;   // (many bodies are going at once: advance refreshes the lists after them)
    function refreshBodyLists() {
        if (listsWait) return;
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
            ui.palette.querySelectorAll('.orb-chip').forEach((btn) => {
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

    // ------------------------------------------------------------------
    // Finding your way: the "Bodies" list in the settings, zooming to an orbit, choosing bodies from
    // the keyboard, the help sheet of keys and gestures, and what a screen reader is told.
    //   The list is virtualised: only the rows in sight (and the one the keyboard is on) are in the
    //   page, a few row elements reused as it scrolls, so 1,000 bodies cost no more than ten. Its values
    //   are brought up to date four times a second, and only while it is open. Its order is worked out
    //   again when bodies come or go, the order is changed, or every two seconds for orders that change
    //   as things move, but not while the pointer or the keyboard is in it, so rows don't jump under a
    //   click. A swarm's light bodies, and the pieces of a torn-apart body, are grouped by name
    //   ("Trojan 1…300"), closed until opened. It is an ARIA tree of flat rows (aria-level, -setsize
    //   and -posinset) with the focus kept on the tree (aria-activedescendant), since the rows are
    //   reused; moving along it chooses each body, as clicking one does. The chosen body's row grows a
    //   line of buttons: zoom to its orbit, view from it, edit it, delete it.
    //   Keys, not while typing: ? the help; N and Shift+N the next or previous body in "heaviest first"
    //   order (each body followed by what orbits it, so a moon comes after its planet); Z zoom to the
    //   chosen body's orbit; Enter on the canvas its menu. N and Z only while the simulation is in use
    //   (as for R and Delete), so they don't act while you read the page.
    // ------------------------------------------------------------------
    Object.assign(ui, {
        bodiesGroup: byId('bodiesGroup'), bodiesCount: byId('bodiesCount'), bodiesFind: byId('bodiesFind'),
        bodiesSort: byId('bodiesSort'), bodiesWrap: byId('bodiesWrap'), bodiesTree: byId('bodiesTree'),
        bodiesSizer: byId('bodiesSizer'), bodiesActions: byId('bodiesActions'), bodiesEmpty: byId('bodiesEmpty'),
        popZoom: byId('popZoom'), keysBtn: byId('keysHelpBtn'), keysHelp: byId('keysHelp'),
        keysClose: byId('keysHelpClose'), announcer: byId('orbAnnounce')
    });
    const NAV_ROW_H = 44;          // px: a row of the list (its name line and its values line)
    const NAV_TICK_MS = 250;       // the list's values, the canvas's description: four times a second
    const NAV_RESORT_MS = 2000;    // orders that change as things move are worked out again this often
    const NAV_LABEL_MS = 2000;     // the canvas's summary for screen readers, at most this often
    const NAV_GROUP_MIN = 4;       // swarm bodies or pieces that share a name are grouped from this many
    const nav = {
        rows: [],              // the list's rows in order: bodies, and groups ({ isGroup: true, ... })
        groups: new Map(),     // name -> a group of swarm bodies or pieces
        order: [],             // bodies in "heaviest first" order (reused)
        gid: 0, build: 0, stamp: 0, renames: 0,
        sig: '', builtAt: 0, dirty: true,
        sort: 'mass', find: '',
        slots: [], extra: null, // row elements, reused as the list scrolls (extra: the keyboard's row when out of sight)
        active: null,          // the row the keyboard is on
        shownSel: null,        // the chosen body as the list last showed it
        selIdx: -1, total: -1, com: null,
        visible: false, hover: false, scrollQueued: false, renderId: 0,
        actH: 42,              // px: the chosen row's line of buttons
        inUse: false,          // the simulation (or its settings) was the last thing pressed or focused
        popOpener: null, helpOpener: null,   // where the focus goes back to when the menu or the help closes
        labelNext: 0, announceTimer: 0, announced: '', cost: 0
    };

    // ---- Facts about a body, as the info bar gives them ----
    // What it goes round, and its distance, speed and period from that (the heaviest body's from the
    // centre of mass, com); the period measured over its last orbit once it has one.
    function bodyFacts(b, com) {
        const p = b.primary;
        const top = !p || (p.primary === b && b.m > p.m);
        const o = top ? com : p;
        const f = { top, dist: Math.hypot(b.x - o.x, b.y - o.y), speed: Math.hypot(b.vx - o.vx, b.vy - o.vy), T: Infinity, around: '' };
        if (bodies.length < 2) f.around = 'on its own';
        else if (top) f.around = 'around the centre of mass';
        else f.around = `${b.bound ? 'around' : 'escaping'} ${theName(p)}`;
        if (p && b.bound) {
            const tr = !top && b.track;
            f.T = tr && tr.done > 0 && tr.pid === p.id ? tr.T : elementsOf(b, p).T;
        }
        return f;
    }

    const distText = (au) => { const d = fmtDistance(au); return `${d.v} ${d.u}`; };
    const speedText = (v) => { const s = fmtSpeedKms(v * AUYR_KMS); return `${s.v} ${s.u}`; };
    // (screen readers read "M⊕" as symbols)
    const massWords = (m) => fmtMass(m).replace(' M☉', ' solar masses').replace(' M⊕', ' Earth masses');

    // "Mars, around the Sun, 1.524 AU, period 1.88 yr": what is announced when a body is chosen
    function describeBody(b, f) {
        const g = f || bodyFacts(b, totals(bodies));
        if (bodies.length < 2) return `${b.name}, on its own`;
        if (g.top) {
            const partner = isFinite(g.T) && b.primary ? `, going round with ${theName(b.primary)} every ${fmtDuration(g.T, true)}` : '';
            return `${b.name}, the heaviest body${partner}`;
        }
        return `${b.name}, ${g.around}, ${distText(g.dist)}${isFinite(g.T) ? `, period ${fmtDuration(g.T, true)}` : ''}`;
    }

    // ---- Orders ----
    // A name split into what it starts with and its number ("Trojan 17": "Trojan", 17), for grouping
    // and for sorting by name with 2 before 10. Worked out again only when the name changes.
    function navNameParts(b) {
        if (b.navName === b.name) return;
        b.navName = b.name;
        const m = /^(.*?)\s*(\d+)$/.exec(b.name);
        b.navBase = m && m[1] ? m[1] : b.name;
        b.navNum = m && m[1] ? +m[2] : 1;
    }
    function byName(a, b) {
        navNameParts(a); navNameParts(b);
        return a.navBase.localeCompare(b.navBase) || a.navNum - b.navNum || a.id - b.id;
    }

    // Every body, heaviest first, each followed by what orbits it (heaviest first, equal masses nearest
    // first): Sun, Jupiter, Earth, Moon, Venus... A body hangs under its primary only if that comes
    // first (heavier, or as heavy and older), so a binary's heavier star leads and nothing loops.
    // Sets each body's navD (distance from what it hangs under, or from the centre of mass) and
    // navDepth (how far down it hangs).
    function systemOrder(out) {
        const stamp = ++nav.stamp;
        for (const b of bodies) b.navStamp = stamp;
        const com = totals(bodies);
        const parentOf = (b) => {
            const p = b.primary;
            return p && p !== b && p.navStamp === stamp && (p.m > b.m || (p.m === b.m && p.id < b.id)) ? p : null;
        };
        for (const b of bodies) {
            const o = parentOf(b) || com;
            b.navD = Math.hypot(b.x - o.x, b.y - o.y);
        }
        const sorted = bodies.slice().sort((a, b) => b.m - a.m || a.navD - b.navD || a.id - b.id);
        const kids = new Map();
        const roots = [];
        for (const b of sorted) {
            const p = parentOf(b);
            if (!p) { roots.push(b); continue; }
            let k = kids.get(p.id);
            if (!k) kids.set(p.id, k = []);
            k.push(b);
        }
        out.length = 0;
        const visit = (b, depth) => {
            b.navDepth = depth;
            out.push(b);
            const k = kids.get(b.id);
            if (k) for (const c of k) visit(c, depth + 1);
        };
        for (const r of roots) visit(r, 0);
        return out;
    }

    // The bodies in the list's order (by name, distance from what each orbits, or period: shortest
    // first, the escaping and the heaviest last)
    function navSorted() {
        const out = nav.order;
        if (nav.sort === 'mass') return systemOrder(out);
        out.length = 0;
        const com = totals(bodies);
        for (const b of bodies) {
            b.navDepth = 0;
            if (nav.sort !== 'name') { const f = bodyFacts(b, com); b.navD = f.dist; b.navT = f.T; }
            out.push(b);
        }
        if (nav.sort === 'name') out.sort(byName);
        else if (nav.sort === 'distance') out.sort((a, b) => a.navD - b.navD || byName(a, b));
        else out.sort((a, b) => a.navT - b.navT || a.navD - b.navD || byName(a, b));
        return out;
    }

    // ---- The list's rows ----
    const grouped = (b) => !!(b.minor || b.grp);

    function navRowAt(r, i, level, pos, indent) {
        r.navIdx = i; r.navBuild = nav.build; r.navLevel = level; r.navPos = pos; r.navIndent = indent;
    }

    // Work out the rows: in order, a group's row in the place of its first member (followed by its
    // members if it is open), every other body (that matches what is typed in "Find") on its own row
    function navBuild() {
        nav.build++;
        const list = navSorted();
        const find = nav.find.trim().toLowerCase();
        for (const g of nav.groups.values()) g.members.length = 0;
        for (const b of list) {
            navNameParts(b);
            if (find || !grouped(b)) continue;
            let g = nav.groups.get(b.navBase);
            if (!g) {
                g = { isGroup: true, gid: ++nav.gid, base: b.navBase, members: [], open: false, lo: 0, hi: 0 };
                nav.groups.set(b.navBase, g);
            }
            g.members.push(b);
        }
        const rows = nav.rows;
        rows.length = 0;
        const indentOf = (b) => (nav.sort === 'mass' && !find ? Math.min(b.navDepth, 3) : 0);
        let top = 0;
        for (const b of list) {
            if (find && !b.name.toLowerCase().includes(find)) continue;
            const g = !find && grouped(b) ? nav.groups.get(b.navBase) : null;
            if (g && g.members.length >= NAV_GROUP_MIN) {
                if (g.members[0] !== b) continue;
                g.lo = Infinity; g.hi = -Infinity;
                for (const m of g.members) { g.lo = Math.min(g.lo, m.navNum); g.hi = Math.max(g.hi, m.navNum); }
                navRowAt(g, rows.length, 1, ++top, indentOf(b));
                rows.push(g);
                if (g.open) {
                    g.members.forEach((m, k) => { navRowAt(m, rows.length, 2, k + 1, g.navIndent + 1); m.navSize = g.members.length; rows.push(m); });
                }
                continue;
            }
            navRowAt(b, rows.length, 1, ++top, indentOf(b));
            rows.push(b);
        }
        for (const r of rows) if (r.navLevel === 1) r.navSize = top;
        nav.dirty = false;
        nav.builtAt = performance.now();
        if (nav.active && !navHas(nav.active)) nav.active = null;
    }

    const navHas = (r) => !!r && r.navBuild === nav.build && nav.rows[r.navIdx] === r;

    // Has the set of bodies changed (added, removed, merged, renamed, or a swarm body grown big enough
    // to be named)? A few additions a body, no allocations.
    function navSignature() {
        let ids = 0, small = 0;
        for (const b of bodies) {
            ids += b.id;
            if (grouped(b)) small++;
            if (b.navName !== b.name) { navNameParts(b); nav.renames++; }
        }
        return `${bodies.length}|${ids}|${small}|${nav.renames}`;
    }

    // Row layout: the chosen body's row is taller by its line of buttons
    const navRowTop = (i, sel) => i * NAV_ROW_H + (sel >= 0 && i > sel ? nav.actH : 0);
    function navIndexAt(y, sel) {
        const after = (sel + 1) * NAV_ROW_H;
        return Math.floor((sel >= 0 && y >= after ? Math.max(after, y - nav.actH) : y) / NAV_ROW_H);
    }
    function navSelIndex() {
        const b = bodyById(selectedId);
        return b && navHas(b) ? b.navIdx : -1;
    }

    function navRowEl() {
        const el = document.createElement('div');
        el.className = 'orb-bl-row';
        el.setAttribute('role', 'treeitem');
        el.hidden = true;
        el.innerHTML = '<span class="orb-bl-dot" aria-hidden="true"></span><span class="orb-bl-line"><span class="orb-bl-name"></span> <span class="orb-bl-around"></span></span>'
            + '<span class="orb-bl-mass" aria-hidden="true"></span><span class="orb-bl-vals" aria-hidden="true"></span>';
        el.navDot = el.children[0];
        el.navName = el.children[1].children[0];
        el.navAround = el.children[1].children[1];
        el.navMass = el.children[2];
        el.navVals = el.children[3];
        ui.bodiesTree.appendChild(el);
        return el;
    }

    function setAttr(el, name, v) {
        const s = String(v);
        if (el.getAttribute(name) !== s) el.setAttribute(name, s);
    }

    // Put row r (at index i) into element el; values: work out its numbers again (the 4 Hz update);
    // label: rewrite what a screen reader reads for it (it is read when the keyboard reaches it, so it
    // isn't changed while the keyboard is on it, which would have it read out again and again)
    function navFill(el, r, i, sel, values, label) {
        const isG = !!r.isGroup;
        const key = isG ? `g${r.gid}` : `b${r.id}`;
        const fresh = el.navKey !== key;
        if (fresh) {
            el.navKey = key;
            el.id = `orbBl-${key}`;
            el.classList.toggle('is-group', isG);
            if (isG) el.removeAttribute('aria-selected'); else el.removeAttribute('aria-expanded');
        }
        el.navRow = r;
        el.navSeen = nav.renderId;
        if (el.hidden) el.hidden = false;
        const y = navRowTop(i, sel);
        if (el.navTop !== y) { el.navTop = y; el.style.transform = `translateY(${y}px)`; }
        if (el.navIndentShown !== r.navIndent) { el.navIndentShown = r.navIndent; el.style.setProperty('--orb-bl-indent', r.navIndent); }
        setAttr(el, 'aria-level', r.navLevel);
        setAttr(el, 'aria-posinset', r.navPos);
        setAttr(el, 'aria-setsize', r.navSize);
        const chosen = !isG && r.id === selectedId;
        if (isG) setAttr(el, 'aria-expanded', r.open ? 'true' : 'false');
        else setAttr(el, 'aria-selected', chosen ? 'true' : 'false');
        el.classList.toggle('is-chosen', chosen);
        el.classList.toggle('is-active', r === nav.active);
        // (the keyboard's row keeps its words while the tree has the focus)
        const reading = r === nav.active && document.activeElement === ui.bodiesTree;
        if (fresh || values || label) navValues(el, r, fresh || label || (values && !reading));
    }

    function navValues(el, r, label) {
        const com = nav.com || (nav.com = totals(bodies));
        let name, around, mass = '', vals, words;
        if (r.isGroup) {
            const ms = r.members;
            let lo = Infinity, hi = 0, p = ms[0].primary, same = true;
            for (const m of ms) {
                const f = m.primary && m.primary !== m ? m.primary : com;
                const d = Math.hypot(m.x - f.x, m.y - f.y);
                if (d < lo) lo = d;
                if (d > hi) hi = d;
                if (m.primary !== p || !m.bound) same = false;
            }
            setBg(el.navDot, ms[0].color);
            // ("Trojan 1…300"; just "Fragment" for the pieces of a torn-apart body, which share one name)
            const span = r.lo < r.hi;
            name = span ? `${r.base} ${r.lo}…${r.hi}` : r.base;
            around = same && p ? `around ${theName(p)}` : '';
            const hiD = fmtDistance(hi), loD = fmtDistance(lo);
            vals = `${ms.length} bodies · ${loD.u === hiD.u ? loD.v : (hiD.u === 'km' ? fmtKm(lo * AU_KM) : lo.toFixed(3))}–${hiD.v} ${hiD.u}`;
            words = `${span ? `${r.base} ${r.lo} to ${r.hi}` : r.base}, ${ms.length} bodies${around ? `, ${around}` : ''}`;
        } else {
            const f = bodyFacts(r, com);
            setBg(el.navDot, r.color);
            name = r.name;
            around = f.around;
            const period = isFinite(f.T) ? fmtDuration(f.T, true) : '';
            mass = fmtMass(r.m);
            vals = `${distText(f.dist)} · ${speedText(f.speed)}${period ? ` · ${period}` : ''}`;
            words = `${r.name}, ${around}, ${distText(f.dist)}, ${speedText(f.speed)}${period ? `, period ${period}` : ''}, mass ${massWords(r.m)}`;
        }
        setText(el.navName, name);
        setText(el.navAround, around);
        setText(el.navMass, mass);
        setText(el.navVals, vals);
        if (label || !el.getAttribute('aria-label')) setAttr(el, 'aria-label', words);
    }
    // (the dot's colour as its colour too: a group's second dot is drawn in it)
    function setBg(el, c) { if (el.navBg !== c) { el.navBg = c; el.style.background = c; el.style.color = c; } }

    // Show the rows in sight (and the keyboard's row), the chosen row's buttons, and the tree's state
    function navRender(values) {
        const tree = ui.bodiesTree;
        if (!tree) return;
        nav.renderId++;
        const rows = nav.rows, n = rows.length;
        const sel = navSelIndex();
        nav.selIdx = sel;
        const total = n * NAV_ROW_H + (sel >= 0 ? nav.actH : 0);
        if (nav.total !== total) { nav.total = total; ui.bodiesSizer.style.height = `${total}px`; }
        const h = tree.clientHeight, y = tree.scrollTop;
        const i0 = Math.max(0, navIndexAt(y, sel) - 2), i1 = Math.min(n - 1, navIndexAt(y + h, sel) + 2);
        const count = Math.max(0, i1 - i0 + 1);
        while (nav.slots.length < count) nav.slots.push(navRowEl());
        const K = nav.slots.length;
        // Row i goes into slot i mod K, so a row that stays in sight as the list scrolls keeps its element
        for (let i = i0; i <= i1; i++) navFill(nav.slots[i % K], rows[i], i, sel, values, false);
        const ai = navHas(nav.active) ? nav.active.navIdx : -1;
        if (!nav.extra) nav.extra = navRowEl();
        if (ai >= 0 && (ai < i0 || ai > i1)) navFill(nav.extra, rows[ai], ai, sel, values, false);
        for (const el of nav.slots.concat(nav.extra)) {
            if (el.navSeen === nav.renderId || el.hidden) continue;
            el.hidden = true;
            el.removeAttribute('id');
            el.navKey = null;
        }
        const activeEl = ai >= 0 ? byId(`orbBl-${nav.active.isGroup ? `g${nav.active.gid}` : `b${nav.active.id}`}`) : null;
        if (activeEl) setAttr(tree, 'aria-activedescendant', activeEl.id); else tree.removeAttribute('aria-activedescendant');
        tree.classList.toggle('has-active', !!activeEl);
        if (ui.bodiesEmpty) ui.bodiesEmpty.hidden = n > 0;
        navPlaceActions(sel, y);
    }

    // The chosen row's buttons, over the bottom of its row (outside the tree, which may hold only rows)
    function navPlaceActions(sel, y) {
        const act = ui.bodiesActions;
        if (!act) return;
        const b = sel >= 0 ? nav.rows[sel] : null;
        if (!b) { if (!act.hidden) act.hidden = true; return; }
        if (act.hidden) act.hidden = false;
        const top = navRowTop(sel, sel) + NAV_ROW_H - y;
        if (act.navTop !== top) { act.navTop = top; act.style.transform = `translateY(${top}px)`; }
        const w = `${ui.bodiesTree.clientWidth}px`;
        if (act.style.width !== w) act.style.width = w;
        setAttr(act, 'aria-label', b.name);
        const view = act.querySelector('[data-act="view"]'), del = act.querySelector('[data-act="delete"]');
        setAttr(view, 'aria-pressed', frameId === b.id ? 'true' : 'false');
        view.title = frameId === b.id ? 'Go back to the centre-of-mass view (double-click)' : 'View the motion from it (double-click)';
        if (del.disabled !== bodies.length < 2) del.disabled = bodies.length < 2;
    }

    function navEnsureVisible(i) {
        const tree = ui.bodiesTree;
        if (!tree || i < 0) return;
        const sel = navSelIndex();
        const top = navRowTop(i, sel), bottom = top + NAV_ROW_H + (i === sel ? nav.actH : 0);
        if (top < tree.scrollTop) tree.scrollTop = top;
        else if (bottom > tree.scrollTop + tree.clientHeight) tree.scrollTop = Math.min(top, bottom - tree.clientHeight);
    }

    // The keyboard's row moves to r; a body's row chooses it, as clicking does
    function navActivate(r) {
        if (!navHas(r)) return;
        nav.active = r;
        if (!r.isGroup && r.id !== selectedId) {
            if (popBody && popBody !== r) closePopover();
            selectBody(r.id);
        }
        nav.shownSel = selectedId;
        navRender(false);
        navEnsureVisible(r.navIdx);
        navRender(false);
        // (fresh numbers for the screen reader, before it reads the row)
        const el = byId(`orbBl-${r.isGroup ? `g${r.gid}` : `b${r.id}`}`);
        if (el) navValues(el, r, true);
    }

    function navToggle(g, open) {
        g.open = open;
        nav.active = g;
        navBuild();
        navRender(true);
        navEnsureVisible(g.navIdx);
        navRender(false);
    }

    // The chosen body changed somewhere else (the canvas, N, an undo): open its group if it is in a
    // closed one, put the keyboard's row on it and scroll it into sight
    function navReveal() {
        nav.shownSel = selectedId;
        if (nav.dirty) navBuild();
        const b = bodyById(selectedId);
        if (b && !navHas(b) && !nav.find && grouped(b)) {
            navNameParts(b);
            const g = nav.groups.get(b.navBase);
            if (g && !g.open) { g.open = true; navBuild(); }
        }
        if (b && navHas(b)) nav.active = b;
        navRender(false);
        if (b && navHas(b)) { navEnsureVisible(b.navIdx); navRender(false); }
    }

    function navListVisible() {
        const g = ui.bodiesGroup;
        if (!g || !g.open) return false;
        const panel = g.closest('.sim-controls-panel');
        return !panel || panel.classList.contains('panel-open');
    }

    // Four times a second: the count in the list's heading, the canvas's summary, and while the list
    // is open its order (if needed), the chosen body and the numbers in sight
    function navTick() {
        const t0 = performance.now();
        if (ui.bodiesCount) setText(ui.bodiesCount, `(${bodies.length})`);
        if (t0 >= nav.labelNext && document.activeElement !== canvas) { nav.labelNext = t0 + NAV_LABEL_MS; updateCanvasLabel(); }
        const vis = navListVisible();
        if (vis) {
            const sig = navSignature();
            if (sig !== nav.sig) { nav.sig = sig; nav.dirty = true; }
            const busy = nav.hover || (ui.bodiesWrap && ui.bodiesWrap.contains(document.activeElement));
            if (!nav.dirty && nav.sort !== 'name' && !busy && t0 - nav.builtAt > NAV_RESORT_MS) nav.dirty = true;
            nav.com = totals(bodies);
            if (!nav.visible || selectedId !== nav.shownSel) navReveal();
            else if (nav.dirty) navBuild();
            navRender(true);
            nav.cost += 0.2 * (performance.now() - t0 - nav.cost);
        }
        nav.visible = vis;
    }

    // ---- Zoom to an orbit ----
    // The box (relative to the frame origin) round b's orbit around p as it is drawn: round the pair's
    // centre of mass, round p if the view is from p, or p's path round b if the view is from b.
    function orbitBox(b, p, el) {
        const M = b.m + p.m;
        let cx, cy, k;
        // (a rotating frame is centred on its pair, not on its body B: the orbit is drawn round the pair's
        // centre of mass, turned as the view is)
        if (frameId === p.id && !turn.on) { cx = p.dx; cy = p.dy; k = 1; }
        else if (frameId === b.id && !turn.on) { cx = b.dx; cy = b.dy; k = -1; }
        else { cx = (b.m * b.dx + p.m * p.dx) / M; cy = (b.m * b.dy + p.m * p.dy) / M; k = p.m / M; }
        const A = Math.abs(k) * el.a, B = A * Math.sqrt(Math.max(0, 1 - el.e * el.e));
        const w = (k < 0 ? el.w + Math.PI : el.w) + turn.phi;
        const ca = Math.cos(w), sa = Math.sin(w);
        // the ellipse's centre is a·e from its focus, away from the closest point
        const ox = cx - el.e * A * ca - F.x, oy = cy - el.e * A * sa - F.y;
        const hx = Math.sqrt(A * A * ca * ca + B * B * sa * sa), hy = Math.sqrt(A * A * sa * sa + B * B * ca * ca);
        const pad = 0.12 * Math.max(hx, hy);
        return [ox - hx - pad, ox + hx + pad, oy - hy - pad, oy + hy + pad];
    }

    // The bodies that pull b off its orbit round p: those whose pull on b, less their pull on p (what
    // changes the orbit), is more than a tenth of p's pull. The Sun's on the Moon is a hundredth of
    // Earth's in this sense; in a dance of three equal stars each pulls about as hard as the other.
    function disturbers(b, p) {
        const rx = b.x - p.x, ry = b.y - p.y;
        const r2 = rx * rx + ry * ry;
        const own = (b.m + p.m) / Math.max(r2, 1e-30);
        const out = [];
        for (const q of bodies) {
            if (q === b || q === p) continue;
            const bx = q.x - b.x, by = q.y - b.y, px = q.x - p.x, py = q.y - p.y;
            const db = Math.pow(bx * bx + by * by, 1.5), dp = Math.pow(px * px + py * py, 1.5);
            if (!(db > 0 && dp > 0)) continue;
            const ax = q.m * (bx / db - px / dp), ay = q.m * (by / db - py / dp);
            if (Math.hypot(ax, ay) > 0.1 * own) out.push(q);
        }
        return out;
    }

    // Glide the view to fit b's orbit round what it orbits. A moon of a planet that moves through the
    // view is seen from its planet, or its orbit would slide out of sight in moments. Where there is
    // no such orbit to show (the heaviest body, one escaping, or one pulled about by others as hard
    // as by what it orbits, as in the three-star scenes) it gets its neighbourhood instead: itself with
    // the bodies pulling on it, or out to its nearest neighbour. Returns what it did (for the announcement).
    function zoomToBody(b) {
        if (!b) return null;
        // (a jump rather than a glide for those who ask their system for less motion)
        const glide = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        updateDrawnPositions();
        const p = b.primary && b.primary !== b && bodies.includes(b.primary) ? b.primary : null;
        const el = p && b.bound ? elementsOf(b, p) : null;
        const crowd = p ? disturbers(b, p) : [];
        if (el && el.bound && !crowd.length && el.a * (1 + el.e) < 1e5 * Math.max(el.r, 1e-12)) {
            let from = null;
            // (not the partner of the heavier star of a binary: that orbits b itself)
            // (nor when the view turns with its planet, which then stands still)
            if (isSatellite(p) && p.primary !== b && frameId !== p.id && frameId !== b.id && !turnUses(p)) { setFrame(p.id); from = p; }
            fitBox(orbitBox(b, p, el), glide);
            glideWith(p);
            return { how: 'orbit', around: p, from, with: [], T: el.T };
        }
        const cx = b.dx - F.x, cy = b.dy - F.y;
        if (crowd.length) {
            const all = crowd.concat(p);
            let x0 = cx, x1 = cx, y0 = cy, y1 = cy;
            for (const q of all) {
                x0 = Math.min(x0, q.dx - F.x); x1 = Math.max(x1, q.dx - F.x);
                y0 = Math.min(y0, q.dy - F.y); y1 = Math.max(y1, q.dy - F.y);
            }
            const pad = 0.15 * Math.max(x1 - x0, y1 - y0);
            fitBox([x0 - pad, x1 + pad, y0 - pad, y1 + pad], glide);
            glideWith(b);
            return { how: 'near', around: null, from: null, with: all };
        }
        let near = Infinity;
        for (const q of bodies) if (q !== b) near = Math.min(near, Math.hypot(q.dx - b.dx, q.dy - b.dy));
        const r = isFinite(near) && near > 0 ? 1.25 * near : 0.5 * (scene.box[1] - scene.box[0]);
        fitBox([cx - r, cx + r, cy - r, cy + r], glide);
        glideWith(b);
        return { how: 'near', around: null, from: null, with: [] };
    }

    // After its orbit is reshaped (the eccentricity slider, or a new period or distances in the menu's
    // Orbit tab): if the whole orbit no longer fits, zoom out just enough to show it as well as what is
    // in view now (never in, and nothing else moves)
    function keepOrbitInView(b) {
        const p = b && b.primary && b.primary !== b && bodies.includes(b.primary) ? b.primary : null;
        const el = p ? elementsOf(b, p) : null;
        if (!el || !el.bound || !viewW || !viewH || !(el.a * (1 + el.e) < 1e5 * Math.max(el.r, 1e-12))) return;
        updateDrawnPositions();
        const o = orbitBox(b, p, el);   // (relative to the frame origin, with a margin)
        const xa = wx(visL) - F.x, xb = wx(visR) - F.x, ya = wy(0) - F.y, yb = wy(viewH) - F.y;
        const v = [Math.min(xa, xb), Math.max(xa, xb), Math.min(ya, yb), Math.max(ya, yb)];
        if (o[0] >= v[0] && o[1] <= v[1] && o[2] >= v[2] && o[3] <= v[3]) return;
        const glide = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        fitBox([Math.min(o[0], v[0]), Math.max(o[1], v[1]), Math.min(o[2], v[2]), Math.max(o[3], v[3])], glide);
    }

    // Zooming to an orbit that goes by too fast to follow also slows time to suit it (a lap in about
    // the time a scene's reference period takes) and says so; the old speed comes back on the way out:
    // zooming out again, back to the centre of mass, or a new scene. Choosing a speed by hand ends all that.
    const paceZoom = { was: 0, zoom: 0 };
    function suitSpeed(b, z) {
        if (mission.def || z.how !== 'orbit' || !(z.T / (settings.speed * rate()) < 1)) return;
        const v = SPEED_STOPS[nearestStop(z.T / (SECONDS_PER_TREF * rate()))];
        if (!paceZoom.was) paceZoom.was = settings.speed;
        paceZoom.zoom = view.anim ? view.anim.zoom : view.zoom;
        setSpeedValue(v);
        showHint('note', `<strong>Slowed to ${fmtFactor(v)}×</strong> to suit this orbit: a lap in ${fig2(z.T / (v * rate()))} s.`, { ms: 7000, tag: 'pace' });
    }
    function restoreSpeed() {
        if (!paceZoom.was) return;
        const v = paceZoom.was;
        paceZoom.was = 0;
        setSpeedValue(v);
        showHint('note', `<strong>Speed back to ${fmtFactor(v)}×.</strong>`, { ms: 4000, tag: 'pace' });
    }

    function zoomChosen() {
        const b = bodyById(selectedId);
        const z = zoomToBody(b);
        if (!z) return null;
        drawerCamera(null);
        suitSpeed(b, z);
        const whose = theName(b);
        const others = z.with.length && z.with.length <= 3 ? z.with.map(theName) : null;
        announce(z.how === 'orbit' ? `Zoomed to ${whose}'s orbit round ${theName(z.around)}${z.from ? `, viewed from ${theName(z.from)}` : ''}`
            : others ? `Zoomed in round ${whose}, with ${others.length > 1 ? `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]}` : others[0]}, which pull on it`
                : z.with.length ? `Zoomed in round ${whose} and the bodies pulling on it` : `Zoomed in round ${whose}`);
        return z;
    }

    // ---- Choosing from the keyboard ----
    function chooseNext(dir) {
        if (!bodies.length) return null;
        const order = systemOrder(nav.order);
        const n = order.length;
        const i = order.findIndex((q) => q.id === selectedId);
        const next = order[i < 0 ? (dir > 0 ? 0 : n - 1) : (i + (dir > 0 ? 1 : n - 1)) % n];
        if (popBody && popBody !== next) closePopover();
        selectBody(next.id);
        if (nav.visible) navReveal();
        announce(describeBody(next));
        return next;
    }

    // Its menu, with the focus in it; when the menu closes the focus goes back to opener
    function editChosen(opener) {
        const b = bodyById(selectedId);
        if (!b) return;
        nav.popOpener = opener || null;
        openEditor(b, null, true);
    }

    // Said by screen readers (politely, after what they are reading). Emptied first, so the same words
    // twice in a row are read twice.
    function announce(text) {
        if (!ui.announcer) return;
        nav.announced = text;
        ui.announcer.textContent = '';
        clearTimeout(nav.announceTimer);
        nav.announceTimer = setTimeout(() => { ui.announcer.textContent = text; }, 60);
    }

    // The canvas's name for screen readers: the scene, its bodies, the chosen one and the view. No
    // numbers, so it changes only when something does (a changed name is read out again).
    function sceneSummary() {
        const opt = ui.scene ? ui.scene.options[ui.scene.selectedIndex] : null;
        const named = [];
        let small = 0;
        for (const b of bodies) { if (grouped(b)) small++; else named.push(b); }
        named.sort((a, b) => b.m - a.m);
        const names = named.slice(0, 6).map((b) => b.name);
        if (named.length > 6) names.push(`${named.length - 6} more`);
        if (small) names.push(`${small} small ${small === 1 ? 'body' : 'bodies'}`);
        const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
        const n = bodies.length;
        let s = `Orbit simulation${opt ? `, ${opt.textContent}` : ''}. ${n} ${n === 1 ? 'body' : 'bodies'}: ${list}.`;
        const b = bodyById(selectedId);
        if (b) s += ` Chosen: ${b.name}, ${bodyFacts(b, totals(bodies)).around}.`;
        const L = frameId !== null ? bodyById(frameId) : null;
        if (L) s += ` Viewed from ${theName(L)}.`;
        if (paused) s += ' Paused.';
        return s;
    }
    function updateCanvasLabel() {
        setAttr(canvas, 'aria-label', sceneSummary());
    }

    // ---- The help: keys and gestures ----
    // (on a touch screen the keys are folded away under the gestures, unless it was opened with a key)
    function openHelp(byKey) {
        const d = ui.keysHelp;
        if (!d || d.open) return;
        showHelpKeys(!!byKey);
        const a = document.activeElement;
        nav.helpOpener = a && a !== document.body ? a : canvas;
        if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
        if (ui.keysClose) ui.keysClose.focus();
    }
    function showHelpKeys(on) {
        if (!ui.keysHelp) return;
        ui.keysHelp.classList.toggle('keys-open', on);
        const t = byId('helpKeysToggle');
        if (t) t.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
    function closeHelp() {
        const d = ui.keysHelp;
        if (!d || !d.open) return;
        if (typeof d.close === 'function') d.close(); else { d.removeAttribute('open'); helpClosed(); }
    }
    function helpClosed() {
        const o = nav.helpOpener;
        nav.helpOpener = null;
        if (o && o.isConnected && o.getClientRects().length) o.focus({ preventScroll: true });
        else canvas.focus({ preventScroll: true });
    }

    // While the help is open nothing else hears the keys (it is modal): Escape or ? closes it, and Tab
    // goes round its own buttons
    function onHelpKey(e) {
        const d = ui.keysHelp;
        if (!d || !d.open) return;
        e.stopImmediatePropagation();
        if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); closeHelp(); return; }
        if (e.key !== 'Tab') return;
        const items = Array.from(d.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])')).filter((el) => !el.disabled && el.getClientRects().length);
        if (!items.length) { e.preventDefault(); return; }
        const i = items.indexOf(document.activeElement);
        const j = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i < 0 || i === items.length - 1 ? 0 : i + 1);
        e.preventDefault();
        items[j].focus();
    }

    function onNavKey(e) {
        if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target)) return;
        const key = e.key;
        if (key === '?') { e.preventDefault(); openHelp(true); return; }
        const inUse = nav.inUse || !!popBody || document.body.classList.contains('sim-fullscreen-active');
        if ((key === 'n' || key === 'N') && inUse) {
            e.preventDefault();
            chooseNext(e.shiftKey ? -1 : 1);
        } else if ((key === 'z' || key === 'Z') && !e.shiftKey && inUse) {
            e.preventDefault();
            if (!e.repeat) zoomChosen();
        } else if (key === 'Enter' && e.target === canvas) {
            e.preventDefault();
            editChosen(canvas);
        }
    }

    // The list's own keys (an ARIA tree): up and down, Home, End, Page Up and Down move (and choose);
    // right opens a group (or goes into it), left closes it (or goes up to it); Enter opens a group or
    // the body's menu. (Delete is the page's: it deletes the chosen body, the one the keyboard is on.)
    function onTreeKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const rows = nav.rows, n = rows.length;
        if (!n) return;
        const i = navHas(nav.active) ? nav.active.navIdx : -1;
        const r = i >= 0 ? rows[i] : null;
        const page = Math.max(1, Math.floor(ui.bodiesTree.clientHeight / NAV_ROW_H) - 1);
        let j = -1;
        switch (e.key) {
            case 'ArrowDown': j = Math.min(n - 1, i + 1); break;
            case 'ArrowUp': j = Math.max(0, i - 1); break;
            case 'Home': j = 0; break;
            case 'End': j = n - 1; break;
            case 'PageDown': j = Math.min(n - 1, Math.max(0, i) + page); break;
            case 'PageUp': j = Math.max(0, i - page); break;
            case 'ArrowRight':
                if (r && r.isGroup) { if (!r.open) navToggle(r, true); else j = i + 1; }
                break;
            case 'ArrowLeft':
                if (r && r.isGroup && r.open) navToggle(r, false);
                else if (r && r.navLevel === 2) { for (j = i - 1; j > 0 && !rows[j].isGroup; j--); }
                break;
            case 'Enter':
                if (r && r.isGroup) navToggle(r, !r.open);
                else if (r) navEdit(ui.bodiesTree);
                break;
            default: return;
        }
        e.preventDefault();
        if (j >= 0) navActivate(rows[j]);
    }

    // Edit from the list. On a phone the settings sheet closes first (the menu is a sheet too), and the
    // focus goes back to the canvas.
    function navEdit(opener) {
        const panel = ui.bodiesGroup ? ui.bodiesGroup.closest('.sim-controls-panel') : null;
        const toggle = document.querySelector('.sim-panel-toggle-button');
        const sheet = panel && toggle && panel.classList.contains('panel-open') && document.body.classList.contains('sim-panel-sheet');
        if (sheet) toggle.click();
        editChosen(sheet ? canvas : opener);
    }

    function onListAction(act, btn) {
        const b = bodyById(selectedId);
        if (!b) return;
        if (act === 'zoom') zoomChosen();
        else if (act === 'view') {
            setFrame(frameId === b.id ? null : b.id);
            announce(frameId === b.id ? `Viewing from ${theName(b)}` : 'Viewing from the centre of mass');
        } else if (act === 'edit') navEdit(btn);
        else if (act === 'delete') deleteChosen();
        navRender(false);
    }

    function bindNavigation() {
        const tree = ui.bodiesTree;
        nav.actH = window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 48 : 42;
        if (tree) {
            tree.style.setProperty('--orb-bl-row', `${NAV_ROW_H}px`);
            tree.style.setProperty('--orb-bl-act', `${nav.actH}px`);
            if (ui.bodiesWrap) ui.bodiesWrap.style.setProperty('--orb-bl-act', `${nav.actH}px`);
            const rowOf = (e) => { const el = e.target.closest('.orb-bl-row'); return el && navHas(el.navRow) ? el.navRow : null; };
            tree.addEventListener('click', (e) => {
                const r = rowOf(e);
                if (!r) return;
                if (r.isGroup) navToggle(r, !r.open); else navActivate(r);
            });
            tree.addEventListener('dblclick', (e) => {
                const r = rowOf(e);
                if (!r || r.isGroup) return;
                setFrame(frameId === r.id ? null : r.id);
                navRender(false);
            });
            tree.addEventListener('keydown', onTreeKey);
            // (the keyboard starts on the chosen body)
            tree.addEventListener('focus', () => {
                if (navHas(nav.active)) return;
                const b = bodyById(selectedId);
                nav.active = b && navHas(b) ? b : nav.rows[0] || null;
                navRender(false);
            });
            tree.addEventListener('scroll', () => {
                if (nav.scrollQueued) return;
                nav.scrollQueued = true;
                requestAnimationFrame(() => { nav.scrollQueued = false; if (nav.visible) navRender(false); });
            }, { passive: true });
        }
        if (ui.bodiesWrap) {
            ui.bodiesWrap.addEventListener('pointerenter', () => { nav.hover = true; });
            ui.bodiesWrap.addEventListener('pointerleave', () => { nav.hover = false; });
        }
        if (ui.bodiesActions) {
            ui.bodiesActions.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-act]');
                if (btn) onListAction(btn.dataset.act, btn);
            });
            // (a button of a row scrolled out of sight is brought back into it when it gets the focus)
            ui.bodiesActions.addEventListener('focusin', () => navEnsureVisible(nav.selIdx));
        }
        if (ui.bodiesFind) {
            ui.bodiesFind.addEventListener('input', () => {
                nav.find = ui.bodiesFind.value;
                navBuild();
                if (tree) tree.scrollTop = 0;
                navReveal();
            });
        }
        if (ui.bodiesSort) {
            ui.bodiesSort.addEventListener('change', () => {
                nav.sort = ui.bodiesSort.value;
                navBuild();
                navReveal();
            });
        }
        if (ui.bodiesGroup) {
            ui.bodiesGroup.addEventListener('toggle', () => { nav.dirty = true; nav.visible = false; navTick(); });
        }
        if (ui.popZoom) ui.popZoom.addEventListener('click', () => { if (popBody) { selectBody(popBody.id); zoomChosen(); } });
        // The menu gives the focus back to whatever opened it from the keyboard
        if (ui.pop) {
            ui.pop.addEventListener('focusout', () => setTimeout(() => {
                if (!ui.pop.hidden || !nav.popOpener) return;
                const o = nav.popOpener;
                nav.popOpener = null;
                const a = document.activeElement;
                if ((!a || a === document.body) && o.isConnected && o.getClientRects().length) o.focus({ preventScroll: true });
            }, 0));
        }
        // The help
        if (ui.keysBtn) ui.keysBtn.addEventListener('click', () => openHelp(false));
        if (ui.keysClose) ui.keysClose.addEventListener('click', closeHelp);
        const keysToggle = byId('helpKeysToggle');
        if (keysToggle) keysToggle.addEventListener('click', () => showHelpKeys(!ui.keysHelp.classList.contains('keys-open')));
        if (ui.keysHelp) {
            ui.keysHelp.addEventListener('close', helpClosed);
            // (a click on the dimmed page around it closes it)
            ui.keysHelp.addEventListener('click', (e) => { if (e.target === ui.keysHelp) closeHelp(); });
        }
        window.addEventListener('keydown', onHelpKey, true);
        document.addEventListener('keydown', onNavKey);
        // In use: the simulation or its settings were the last thing pressed or focused
        const inSim = (el) => !!(el && el.closest && el.closest('.simulation-area-wrapper'));
        window.addEventListener('pointerdown', (e) => { nav.inUse = inSim(e.target); }, true);
        document.addEventListener('focusin', (e) => {
            if (e.target !== document.body) nav.inUse = inSim(e.target);
            if (e.target === canvas) updateCanvasLabel();
        });
        // A press on the canvas gives it the keyboard (so Enter, N and Z act on it next), unless you are
        // working in the body's menu (leaving one of its fields would apply what is half typed)
        // (A press shows no ring: the browser counts the focus given here as visible, and a pink ring
        // round the canvas after every click only clutters it. Tab brings it back.)
        canvas.addEventListener('pointerdown', () => {
            canvas.classList.add('orb-press-focus');
            const a = document.activeElement;
            if (a === canvas || (ui.pop && ui.pop.contains(a))) return;
            canvas.focus({ preventScroll: true });
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Tab') canvas.classList.remove('orb-press-focus'); }, true);
        // A body chosen on the canvas shows in the list straight away (after the canvas's own handler)
        canvas.addEventListener('pointerup', () => setTimeout(() => { if (nav.visible && selectedId !== nav.shownSel) navReveal(); }, 0));
        setInterval(navTick, NAV_TICK_MS);
    }

    function selectBody(id) {
        if (id === selectedId) return;
        selectedId = id;
        k2.bid = null;
        resetOrbitChart();
        syncEccentricity(true);
        clearHint('note', 'chosen');   // (about the last one: its Lagrange point, or a Zoom in that would now zoom elsewhere)
        refreshHint();   // (a note naming the chosen body follows the choice)
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
        if (!b || missionRefuse('delete', b)) return;
        noteEdit();   // (edit history: an undo step)
        updateDrawnPositions();
        const before = viewOrigin();
        const wasFrame = frameId === b.id;
        removeBody(b, null);
        if (selectedId === null) selectedId = defaultSubject();
        if (wasFrame) frameId = null;
        updateDrawnPositions();
        keepScreen(before);
        shiftComTrail(before);
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
        const burn = missionBegin();   // (missions: only the probe's burns are let through, and they use fuel)
        fn();
        missionEnd(burn);
        forcesDirty = true;
        updateDrawnPositions();
        if (!freeze) { keepScreen(before); shiftComTrail(before); }   // (also keeps a rotating frame's angle: see keepScreen)
    }

    // The trails are drawn relative to where the centre of mass was at each sample. A change that makes it
    // jump (a heavy body added, say) would leave a long straight line in every trail where that happened,
    // so the record of where it was goes with it: the trails stay where they are on the screen.
    function shiftComTrail(before) {
        const dx = F.x - before.x, dy = F.y - before.y;
        if (frameId !== null || turn.on || (!dx && !dy)) return;
        for (let i = 0; i < TRAIL_CAP; i++) { comTrail[2 * i] += dx; comTrail[2 * i + 1] += dy; }
    }

    // ------------------------------------------------------------------
    // Adding bodies
    // ------------------------------------------------------------------
    function addBody(kind, x, y) {
        if (bodies.length >= MAX_BODIES || missionRefuse('add')) return null;
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
        clearHint('note');   // (whatever it said before this)
        return added;
    }

    let customCount = 0;
    function nextCustomColour() {
        const c = ['#ae85ca', '#e0b48a', '#c75b9b', '#8499e7', '#ff9a52'][customCount % 5];
        customCount++;
        return c;
    }

    // The note under "Bodies you drop or move" says what the chosen option does (see launch)
    const PLACEMENT_NOTES = {
        circular: 'Round the body it would orbit there.',
        keep: 'A new body starts at rest.',
        rest: 'Then it falls.',
        throw: 'Flick it as you let go.'
    };
    function syncPlacementNote() {
        setText(byId('placementNote'), PLACEMENT_NOTES[settings.placement] || PLACEMENT_NOTES.circular);
    }

    // Set the velocity of a body that was just dropped or moved, by the "bodies you drop or move" option.
    // d: the drag that moved it (for a throw: the pointer's speed as it let go).
    function launch(b, isNew, d) {
        if (settings.placement === 'circular') {
            const p = placementPrimary(b.x, b.y, b.m, b);
            if (p) launchCircular(b, p, isNew ? orbitSense(p, b) : heldSense(b, p, d), isSatellite(p));
        } else if (settings.placement === 'throw') {
            const v = throwVelocity(d || chipThrow, performance.now());
            b.vx = v[0]; b.vy = v[1];
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

    // The way a body moved by hand goes round p when it is let go: the way it went round before it was
    // picked up (its velocity, kept while it is held, would go round the other way once it is carried
    // past the far side of p), or round a new primary, the usual way there. d: the drag (see startHold).
    function heldSense(b, p, d) {
        const h = d || dragOf(b);
        if (h && h.sense) return h.sense.pid === p.id ? h.sense.s : orbitSense(p, b);
        return senseAround(b, p);
    }

    // "Moon now orbits Earth", with a way to see it (at most zooms its orbit is too small to see)
    function moonNote(b) {
        const p = b && b.primary;
        if (p && b.bound && !mission.def) showHint('note', `<strong>${escapeHtml(sentenceCase(theName(b)))}</strong> now orbits ${escapeHtml(theName(p))}. <button type="button" class="orb-hint-btn orb-hint-zoom">Zoom in</button>`, { tag: 'chosen' });
    }

    // A tap on the Moon chip: a moon for the chosen body if it can have one, else for the heaviest that can
    function autoMoon(kind) {
        const k = KINDS[kind];
        const can = (b) => b && !b.minor && b.m > k.m && isFinite(b.hill) && 0.25 * b.hill > 2 * (b.R + k.R) / AU_KM;
        let host = bodyById(selectedId);
        if (!can(host)) { host = null; for (const b of bodies) if (can(b) && (!host || b.m > host.m)) host = b; }
        if (!host) return null;
        const n = bodies.filter((b) => b.primary === host && b.bound).length, ang = 0.6 + 2.4 * n;
        const s = moonSpot(host, host.x + Math.cos(ang), host.y + Math.sin(ang), n);
        const b = addBody(kind, s.x, s.y);
        moonNote(b);
        return b;
    }

    // A tap on a palette chip: put the body at a free spot around the heaviest body, in view.
    function addBodyAuto(kind) {
        updateDrawnPositions();
        if (kind === 'moon') { const b = autoMoon(kind); if (b) return b; }
        const top = heaviest();
        const k = KINDS[kind] || KINDS.custom;
        const half = Math.min(visR - visL, viewH) / (2 * scale);
        let cx = wx(midX), cy = wy(viewH / 2), R = 0.6 * half;
        if (top && top.m >= k.m) {
            const tx = sx(top.dx), ty = sy(top.dy);
            if (tx > visL && tx < visR && ty > 0 && ty < viewH) {
                cx = top.dx; cy = top.dy;
                const spaceX = Math.min(tx - visL, visR - tx), spaceY = Math.min(ty, viewH - ty);
                // (zoomed in close it may land out of view, rather than inside the body and merge with it)
                R = Math.max(0.7 * Math.min(spaceX, spaceY) / scale, 4 * (top.R + k.R) / AU_KM);
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
        if (!b || !p || p.primary === b && b.m > p.m || missionRefuse('orbit', b)) return;
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
        ui.ecc.disabled = !usable;
        if (ui.eccNote) {
            const note = usable ? 'Reshapes the orbit through where it is now: 0 is a circle, near 1 a long thin ellipse.'
                : (b ? `${b.name} is the heaviest body here. Click or tap a body that orbits it.` : '');
            if (ui.eccNote.textContent !== note) ui.eccNote.textContent = note;   // (read out; the tab's own note shows)
        }
        missionLockSidebar();
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
            sectorLine: 'rgba(174,133,202,0.75)', card: 'rgba(30,32,37,0.93)', cardLine: 'rgba(255,255,255,0.12)', outline: 'rgba(0,0,0,0)',
            burn: '#ffb454'
        } : {
            dark, bg: '#f4f6f8', text: '#3d3d3d', subtle: 'rgba(50,50,50,0.68)', label: 'rgba(40,40,40,0.78)', faint: 'rgba(60,60,60,0.3)',
            force: '#e0607e', velocity: '#2a9d8f', kepler: '#5b6fd6', sectorA: 'rgba(150,100,190,0.30)', sectorB: 'rgba(150,100,190,0.15)',
            sectorLine: 'rgba(130,85,175,0.75)', card: 'rgba(255,255,255,0.94)', cardLine: 'rgba(0,0,0,0.12)', outline: 'rgba(0,0,0,0.28)',
            burn: '#a85f00'
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
        drawPast(C);
        drawTrails(C);
        drawMissionMarks(C);
        drawFlybyGhost(C);
        if (settings.k1) drawEllipseLaw(C, subj);
        drawDragPreviews(C);
        drawEditPreview(C);
        drawCometTails(C);
        drawGravityUnder(C, subj);   // (Hill sphere, Roche limit and pull lines: see "Mutual gravity made visible")
        drawBodies(C);
        drawLagrangePoints(C);
        if (settings.com) drawCentreOfMass(C);   // small: on top, so a star at the centre doesn't hide it
        drawArrows(C);
        drawGravityOver(C, subj);
        drawMissionOver(C);
        drawLabels(C);
        drawOffscreen(C);
        drawFlashes();
        drawPaletteGhost();
        drawOverlays(C, subj);
    }

    // Each trail point is drawn relative to where the frame's origin (the centre of mass, or the locked
    // body) was at that sample's time, so a locked view shows paths as seen from that body. Runs of
    // points that make a straight line to within a fraction of a pixel are drawn as one (a little more
    // in the older, fainter part, and if drawing is running slow: perf.quality; see traceTrail), and
    // stretches off the canvas aren't drawn. A trail with more than TRAIL_POINTS samples (fast swings add
    // extra ones) is read every few samples. The minor bodies of a crowded scene, and the pieces of torn-apart bodies, are drawn together, a path per colour and shade.
    const TRAIL_CHUNKS = 8, MINOR_CHUNKS = 3, PIECE_CHUNKS = 5, TRAIL_POINTS = 1500;
    const minorGroups = new Map(), pieceGroups = new Map();
    function drawTrails(C) {
        const years = trailYears();
        if (years <= 0) return;
        const first = sampleAtTime(simTime - trailDir * years);
        const L = frameId !== null ? bodyById(frameId) : null;
        if (L && !L.trail) return;
        // While the frame is frozen (a body is being dragged), the live origin has drifted from F
        const live = freeze ? liveFrameOrigin() : F;
        const offX = (live.x - F.x - view.panX) * scale + midX, offY = viewH / 2 - (live.y - F.y - view.panY) * scale;
        const lw = clamp(1.6 * sizeScale, 1.2, 2);
        // (a turned view: each sample turned by the angle at its own time, from the turning pair's own
        // samples; see turnedTrails)
        const turned = turnedTrails(first);
        const oT = turned && turned.oT ? turned.oT : L ? L.trail : comTrail;
        const oFirst = turned && turned.oT ? turned.first : L ? trailFirst(L) : sampleCount - TRAIL_CAP + 1;
        const tr = { T: null, oT, offX, offY, stride: 1, turn: turned, capT: 0, capO: 0, out: 0, pen: true };
        for (const g of minorGroups.values()) g.length = 0;
        for (const g of pieceGroups.values()) g.length = 0;
        for (const b of bodies) {
            if (b.held || !b.trail) continue;
            if ((b.minor || b.grp) && !isChosen(b)) {
                const groups = b.minor ? minorGroups : pieceGroups;
                let g = groups.get(b.color);
                if (!g) { g = []; groups.set(b.color, g); }
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
                if (ke === sampleCount && !b.ghost) ctx.lineTo(sx(b.dx), sy(b.dy));   // (b.ghost: see drawPast)
                ctx.stroke();
            }
        }
        // The swarm: one path per colour for each of a few shades, in thinner lines with plain ends and
        // corners (round ones take far longer to paint); when drawing runs slow, only their newest part
        // (and only for the pieces of a torn-apart body, as bright as other trails, if slower still)
        const low = perf.quality < 0.3;
        ctx.lineWidth = Math.max(1, 0.6 * lw);
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'bevel';
        trailGroups(pieceGroups, PIECE_CHUNKS, 0, 0.8, tr, first, oFirst, C);
        if (!low) {
            ctx.lineJoin = 'miter';
            trailGroups(minorGroups, MINOR_CHUNKS, 0.06, 0.5, tr, first, oFirst, C);
        }
        ctx.globalAlpha = 1;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
    }

    // Groups of trails: a path per colour for each of chunks shades, from alpha a0 + a1 / chunks to a0 + a1
    // (the pieces' old ends don't all stop at one moment: each gives up its own share, for a tapering end)
    function trailGroups(groups, chunks, a0, a1, tr, first, oFirst, C) {
        const pieces = groups === pieceGroups;
        for (const [color, g] of groups) {
            if (!g.length) continue;
            ctx.strokeStyle = pieces ? pieceColour(color, C) : bodyStroke(color, C.dark);
            for (let c = 0; c < chunks; c++) {
                const f = (c + 1) / chunks;
                ctx.globalAlpha = a0 + a1 * f;
                ctx.beginPath();
                for (const b of g) {
                    let k0 = Math.max(trailFirst(b), first, oFirst);
                    k0 = Math.max(k0, sampleCount - Math.ceil((sampleCount - k0) * perf.quality));
                    if (pieces) k0 += Math.floor(0.45 * ((b.id * 0.618034) % 1) * (sampleCount - k0));
                    const count = sampleCount - k0;
                    if (count < 1) continue;
                    const chunk = Math.max(1, Math.ceil(count / chunks));
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
    }

    // Add samples ks..ke-1 of trail tr.T (relative to the origin trail tr.oT) to the current path,
    // leaving out stretches wholly off one side of the canvas. Painting a stroke takes far longer than
    // anything else in a frame and goes by its corners, so a run of samples goes as one straight line
    // while it stays within an eighth of minPx of them, in the screen's own pixels (0.15 in the newest
    // part): an orbit's long gentle curves need a quarter of the corners, and look the same. A line
    // always ends on a round sample number (a multiple of a power of two, at most TRAIL_JUMP and at least
    // tr.stride): the corners stay on the same samples from one frame to the next as the trail's ends
    // move on, so its lines don't crawl. Lines shorter than minPx don't have to fit.
    const TRAIL_JUMP = 64;
    const TP = new Float64Array(2);   // (trailAt's answer: numbers returned from a function are boxed)
    function traceTrail(tr, ks, ke, minPx) {
        tr.capT = tr.T.length >> 1;
        tr.capO = tr.oT.length >> 1;
        const tol = minPx / (8 * dpr), tol2 = tol * tol, last = ke - 1;
        let s0 = 1;
        while (s0 < tr.stride) s0 *= 2;
        trailAt(tr, ks);
        let a = ks, ax = TP[0], ay = TP[1];
        tr.out = outcode(ax, ay);
        tr.pen = true;
        ctx.moveTo(ax, ay);
        while (a < last) {
            let b = Math.min(last, a - a % s0 + s0);
            trailAt(tr, b);
            let bx = TP[0], by = TP[1];
            for (let s = 2 * s0; s <= TRAIL_JUMP && b < last; s *= 2) {
                const c = Math.min(last, a - a % s + s);
                if (c === b) continue;
                trailAt(tr, c);
                const cx = TP[0], cy = TP[1], ex = cx - ax, ey = cy - ay;
                if (Math.abs(ex) + Math.abs(ey) >= minPx) {
                    // (its middle and quarters, how far from the line)
                    const q = (c - a) >> 2, ee = ex * ex + ey * ey;
                    let fits = true;
                    for (let i = q > 0 ? 1 : 2; fits && i <= (q > 0 ? 3 : 2); i++) {
                        trailAt(tr, q > 0 ? a + i * q : a + 1);
                        const px = TP[0] - ax, py = TP[1] - ay;
                        const t = ee > 0 ? clamp((px * ex + py * ey) / ee, 0, 1) : 0;
                        const dx = px - t * ex, dy = py - t * ey;
                        fits = dx * dx + dy * dy <= tol2;
                    }
                    if (!fits) break;
                }
                b = c; bx = cx; by = cy;
            }
            trailLine(tr, ax, ay, bx, by);
            a = b; ax = bx; ay = by;
        }
        if (!tr.pen) ctx.moveTo(ax, ay);
    }

    // Where sample k of the trail is drawn, into TP (turned, in a turned view: see turnedTrails)
    function trailAt(tr, k) {
        const T = tr.T, oT = tr.oT, i = 2 * (k % tr.capT), io = 2 * (k % tr.capO), q = tr.turn;
        const rx = T[i] - oT[io], ry = T[i + 1] - oT[io + 1];
        if (!q) {
            TP[0] = tr.offX + rx * scale;
            TP[1] = tr.offY - ry * scale;
            return;
        }
        const cs = q.cs, j = 2 * (k % TRAIL_CAP), c = cs ? cs[j] : q.c, sn = cs ? cs[j + 1] : q.s;
        TP[0] = tr.offX + (c * rx - sn * ry) * scale;
        TP[1] = tr.offY - (sn * rx + c * ry) * scale;
    }

    // A straight stretch of a trail, unless it is wholly off one side of the canvas
    function trailLine(tr, ax, ay, x, y) {
        const o = outcode(x, y);
        if (o & tr.out) {
            tr.pen = false;
        } else {
            if (!tr.pen) { ctx.moveTo(ax, ay); tr.pen = true; }
            ctx.lineTo(x, y);
        }
        tr.out = o;
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

    const pieceColour = (color, C) => (C.dark ? color : bodyStroke(bodyStroke(color, false), false));

    function drawBody(b, x, y, r, C) {
        const look = lookOf(b);
        if (b.grp) {
            // A piece of a torn-apart body: a glowing clump (deeper on a light background, or it hardly shows)
            const z = pieceHeft(b);
            glow(x, y, 0, Math.max(r * 2.4, 5 * z), C.dark ? b.color : bodyStroke(b.color, false), C.dark ? 0.55 : 0.6);
            disc(x, y, Math.max(r * 0.8, 1.1 * z), pieceColour(b.color, C), 0.5, C);
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
        // What the canvas's edges carry (the cards, the arrow key, the scale bar, the "Viewed from" chip):
        // a name goes there only if it has nowhere else to go (and the chosen body's, never if it can help it)
        const zones = cleanRender ? [] : edgeKeepOut();
        ctx.font = font(fs);
        ctx.lineWidth = 3;
        ctx.strokeStyle = hexA(C.bg, 0.8);
        const placed = mission.def ? mission.labelBoxes.slice() : [];   // (a mission's marks are named first)
        const discs = [];
        for (const b of bodies) if (!b.minor || isChosen(b)) discs.push({ x: sx(b.dx), y: sy(b.dy), r: drawRadius(b), b });
        // the flyby close-up and its caption
        if (closeUp) placed.push({ l: closeUp.x - closeUp.R, r: closeUp.x + closeUp.R, t: closeUp.y - closeUp.R - 18, b: closeUp.y + closeUp.R });
        const order = discs.slice().sort((p, q) => (q.b.id === selectedId) - (p.b.id === selectedId) || q.b.m - p.b.m);
        for (const { x, y, r, b } of order) {
            if (x < visL - r || x > visR + r || y < -r || y > viewH + r) continue;   // (it has a pointer at the edge instead)
            const chosen = b.id === selectedId || b === popBody;
            if ((b.grp || b.minor) && !chosen) continue;
            const w = ctx.measureText(b.name).width;
            const gap = r + (chosen ? 9 : 5);
            const u0 = labelDirection(b), a0 = Math.atan2(u0.y, u0.x);
            let best = null, offEdge = null, offOthers = null, first = null;
            for (const da of [0, 0.9, -0.9, 1.8, -1.8, Math.PI]) {
                const ux = Math.cos(a0 + da), uy = Math.sin(a0 + da);
                const box = labelBox(x + ux * gap, y + uy * gap, ux, uy, w, fs);
                // (its own disc too: kept inside the canvas, a name can be pushed back onto it)
                const hit = placed.some((q) => box.l < q.r && box.r > q.l && box.t < q.b && box.b > q.t)
                    || discs.some((d) => { const rr = d.b === b ? d.r - 2 : d.r; return d.x + rr > box.l && d.x - rr < box.r && d.y + rr > box.t && d.y - rr < box.b; });
                const edge = zones.some((z) => box.l < z[2] && box.r > z[0] && box.t < z[3] && box.b > z[1]);
                const at = { box, ux, uy };
                if (!hit && !edge) { best = at; break; }
                if (!edge && !offEdge) offEdge = at;
                if (!hit && !offOthers) offOthers = at;
                if (!first) first = at;
            }
            // (the chosen body's name stays clear of a card even if it has to go over a disc)
            if (!best) best = chosen ? offEdge || offOthers || first : offOthers;
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
                    if (box.l < visL + 4 || box.r > visR - 4 || box.t < 4 || box.b > viewH - 4) continue;
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
        return M > 0 ? { x: sx(X / M), y: sy(Y / M) } : { x: midX, y: viewH / 2 };
    }

    // The box of a name anchored at (x, y) on the side (ux, uy) of its body, kept inside the canvas
    function labelBox(x, y, ux, uy, w, fs) {
        let l = ux > 0.38 ? x : ux < -0.38 ? x - w : x - w / 2;
        let t = uy > 0.38 ? y : uy < -0.38 ? y - fs : y - fs / 2;
        l = clamp(l, visL + 4, Math.max(visL + 4, visR - 4 - w));
        t = clamp(t, 2, viewH - fs - 4);
        return { l, t, r: l + w, b: t + fs };
    }

    // What the canvas's edges carry, which the off-screen pointers keep clear of: the time notice and
    // the "Viewed from" chip (top left), the cards (top right), the scale bar and legend (bottom left)
    // and "Sizes not to scale" (bottom right), as drawn last frame. Rectangles [left, top, right, bottom].
    const edges = { scaleRight: 160, noteLeft: Infinity, strip: Infinity };
    function edgeKeepOut() {
        const out = [], fs = clamp(Math.min(viewW, viewH) / 44, 10.5, 13);
        let top = 0;
        if (frameId !== null && ui.frameChip && !ui.frameChip.hidden) { top = 44; out.push([visL, 0, Math.min(visR, visL + 240), top]); }
        const t = timeNotice();
        if (t) {
            ctx.font = font(fs, true);
            out.push([visL, top, visL + 8 + ctx.measureText(t).width + 18 + 6, top + 8 + fs + 10 + 6]);
        }
        if (cards.bottom > 0 && cards.left < visR) out.push([cards.left - 6, 0, visR, cards.bottom + 4]);
        const strip = Math.min(edges.strip, viewH - fs - 18);
        out.push([visL, strip, Math.min(visR, edges.scaleRight + 6), viewH]);
        if (edges.noteLeft < visR) out.push([edges.noteLeft - 6, strip, visR, viewH]);
        if (legend.shown) out.push([legend.x - 4, legend.top - 4, legend.x + legend.w + 8, viewH]);
        return out;
    }

    // Slide a pointer at (ex, ey) on the edge along it until it, and h px either side of it along the
    // edge (where its name goes), are clear of every rectangle. Returns [x, y, clear]: on a small
    // canvas a stretch of edge may have no room left, and then the pointer goes without its name.
    function clearOfEdges(ex, ey, zones, inset, h) {
        const onSide = ex <= visL + inset + 0.5 || ex >= visR - inset - 0.5;
        const x0 = ex, y0 = ey;
        for (let pass = 0; pass < 7; pass++) {
            const z = onSide ? zones.find((r) => ex >= r[0] && ex <= r[2] && ey + h > r[1] && ey - h < r[3])
                : zones.find((r) => ey >= r[1] && ey <= r[3] && ex + h > r[0] && ex - h < r[2]);
            if (!z) return [ex, ey, true];
            if (pass === 6) break;
            if (onSide) {
                // up or down the side, whichever is nearer and still on the canvas
                const up = z[1] - h - 2, down = z[3] + h + 2;
                ey = (up >= inset && (ey - up <= down - ey || down > viewH - inset)) ? up : Math.min(down, viewH - inset);
            } else {
                const lt = z[0] - h - 2, rt = z[2] + h + 2;
                ex = (lt >= visL + inset && (ex - lt <= rt - ex || rt > visR - inset)) ? lt : Math.min(rt, visR - inset);
            }
        }
        return [x0, y0, false];
    }

    // A name's width in the pointers' font (kept: the same few names are measured every frame)
    const nameWidths = new Map();
    function nameWidth(name, fs) {
        const key = `${fs}|${name}`;
        let w = nameWidths.get(key);
        if (w === undefined) {
            if (nameWidths.size > 500) nameWidths.clear();
            w = ctx.measureText(name).width;
            nameWidths.set(key, w);
        }
        return w;
    }

    const named = (l, t, r, b, zones) => zones.some((z) => l < z[2] && r > z[0] && t < z[3] && b > z[1]);

    // Bodies outside the view: a small pointer at the edge of the canvas, in their direction.
    function drawOffscreen(C) {
        const fs = clamp(Math.min(viewW, viewH) / 46, 10, 12);
        const cx = (visL + visR) / 2, cy = viewH / 2;
        const inset = 12;
        let zones = null;
        for (const b of bodies) {
            const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
            if (b.grp || (b.minor && !isChosen(b)) || (x > visL - r && x < visR + r && y > -r && y < viewH + r)) continue;
            const dx = x - cx, dy = y - cy;
            const k = Math.min(((visR - visL) / 2 - inset) / Math.max(Math.abs(dx), 1e-9), (cy - inset) / Math.max(Math.abs(dy), 1e-9));
            if (!zones) zones = cleanRender ? [] : edgeKeepOut();
            const len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
            // (along a side, the name is a line tall; along the top or bottom, as wide as it is)
            ctx.font = font(fs);
            const nw = settings.labels ? nameWidth(b.name, fs) : 0;
            const h = Math.abs(ux) > 0.5 || !settings.labels ? fs / 2 + 8 : nw / 2 + 6;
            const [ex, ey, clear] = clearOfEdges(cx + dx * k, cy + dy * k, zones, inset, h);
            ctx.fillStyle = bodyStroke(b.color, C.dark);
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.moveTo(ex + ux * 6, ey + uy * 6);
            ctx.lineTo(ex - ux * 4 - uy * 5, ey - uy * 4 + ux * 5);
            ctx.lineTo(ex - ux * 4 + uy * 5, ey - uy * 4 - ux * 5);
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = 1;
            let half = 10;
            if (settings.labels && clear) {
                // (where its name would go: left out if another pointer's is there)
                const tx = ex - ux * 12, ty = ey - uy * 12;
                const nl = ux > 0.5 ? tx - nw : ux < -0.5 ? tx : tx - nw / 2, nt = uy > 0.5 ? ty - fs : uy < -0.5 ? ty : ty - fs / 2;
                if (!named(nl, nt, nl + nw, nt + fs, zones) || isChosen(b)) {
                    ctx.font = font(fs);
                    ctx.fillStyle = C.subtle;
                    ctx.textAlign = ux > 0.5 ? 'right' : ux < -0.5 ? 'left' : 'center';
                    ctx.textBaseline = uy > 0.5 ? 'bottom' : uy < -0.5 ? 'top' : 'middle';
                    ctx.fillText(b.name, tx, ty);
                    half = Math.max(half, nw / (Math.abs(ux) > 0.5 ? 1 : 2) + 6);
                    zones.push([nl - 3, nt - 2, nl + nw + 3, nt + fs + 2]);
                }
            }
            // (the next pointer along this edge keeps clear of this one and its name)
            zones.push([ex - half - 4, ey - fs - 14, ex + half + 4, ey + fs + 14]);
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
    // ARROW_PX long; arrows over twice that are squeezed, to at most two and a half times (a body swung
    // up to many times the scene's speeds shouldn't have an arrow across the whole view).
    const ARROW_PX = 60;
    let vRef = TAU;   // AU/yr (Earth's orbital speed until a scene sets it)
    const arrowUnit = () => ARROW_PX * sizeScale;
    const pxPerSpeed = () => arrowUnit() / vRef;
    function arrowLength(v) {
        const L = v * pxPerSpeed(), L0 = arrowUnit();
        return L <= 2 * L0 ? L : 2 * L0 + 0.5 * L0 * (1 - Math.exp(-(L - 2 * L0) / (0.5 * L0)));
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
        left = clamp(left, visL + 4, Math.max(visL + 4, visR - 4 - w));
        const ty = clamp(y, 10, viewH - 8);
        ctx.textAlign = 'left';
        if (halo) ctx.strokeText(text, left, ty);
        ctx.fillText(text, left, ty);
        ctx.textAlign = al;
    }

    // Above this many named bodies only the chosen body's arrows are drawn: the rest would swamp the view
    const ARROWS_ALL_MAX = 8;
    let arrowsBusy = false;
    function countArrows() {
        let n = 0;
        for (const b of bodies) if (!b.grp && !b.minor) n++;
        arrowsBusy = n > ARROWS_ALL_MAX;
    }

    function drawArrows(C) {
        const w = clamp(2 * sizeScale, 1.5, 2.4);
        const subj = bodyById(selectedId);
        countArrows();
        // (a torn-apart body's pieces only get arrows when one is chosen)
        if (settings.forces) {
            for (const b of bodies) {
                const Fm = Math.hypot(b.fx, b.fy);
                if (!(Fm > 0) || ((b.grp || b.minor || arrowsBusy) && b !== subj)) continue;
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
            if (!(settings.velocities || b.aim) || (b.held && !b.aim) || ((b.grp || b.minor || arrowsBusy) && b !== subj)) continue;
            const tip = velocityTip(b, fv);
            const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
            const dx = tip.x - x, dy = tip.y - y;
            const len = Math.hypot(dx, dy);
            const hot = !cleanRender && (!!b.aim || b.id === hoverAim);
            if (tip.len > 2.5) {
                arrow(x + (dx / len) * r, y + (dy / len) * r, tip.x, tip.y, hot ? hotColour : C.velocity, hot ? w * 1.5 : w);
                // (the chosen body's tip wears a ring: this end can be dragged, as a pink arrow can't)
                if (b === subj && !b.aim && !cleanRender && settings.velocities) {
                    ctx.strokeStyle = hot ? hotColour : C.velocity;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(tip.x, tip.y, 6.5 * sizeScale, 0, TAU);
                    ctx.stroke();
                    if (b.id === mission.craftId) { const q = mission.tipBox, m = 8 * sizeScale; q.l = tip.x - m; q.r = tip.x + m; q.t = tip.y - m; q.b = tip.y + m; }
                }
            } else if (hot && !b.aim) {
                const h = handlePos(b), hl = Math.hypot(h.x - x, h.y - y) || 1;
                ctx.globalAlpha = 0.6;
                arrow(x + ((h.x - x) / hl) * r, y + ((h.y - y) / hl) * r, h.x, h.y, hotColour, w);
                ctx.globalAlpha = 1;
            }
            if (b.aim && b.aim.burn) drawBurn(C, b, w);
        }
    }

    // A burn being aimed in a mission (see beginAim): an arrow from where the velocity arrow's tip was
    // when it was grabbed, along the change of velocity at the burn's own scale (so it follows the
    // pointer), with its size beside it
    function drawBurn(C, b, w) {
        const a = b.aim, B = a.burn;
        let dx = a.vx - B.vx, dy = a.vy - B.vy, ox = B.vx, oy = B.vy;
        if (turn.phi && !a.turn) { ({ x: dx, y: dy } = turnVec(dx, dy)); ({ x: ox, y: oy } = turnVec(ox, oy)); }   // (as velocityTip)
        const L = Math.hypot(dx, dy) * B.k;
        if (L < 3) return;
        const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b), o = Math.hypot(ox, oy);
        const x0 = o > 0 ? x + (ox / o) * (r + o * a.k) : x, y0 = o > 0 ? y - (oy / o) * (r + o * a.k) : y;
        const x1 = x0 + dx * B.k, y1 = y0 - dy * B.k;
        arrow(x0, y0, x1, y1, C.burn, w * 1.5);
        const dv = fmtSpeedKms(Math.hypot(dx, dy) * AUYR_KMS);
        ctx.font = font(Math.round(12 * Math.max(sizeScale, 0.9)), true);
        ctx.textBaseline = 'middle';
        ctx.textAlign = dx >= 0 ? 'left' : 'right';
        ctx.lineWidth = 3;
        ctx.strokeStyle = C.bg;
        ctx.fillStyle = C.burn;
        fillTextInside(`Δv ${dv.v} ${dv.u}`, x1 + (dx >= 0 ? 8 : -8), y1 - (dy >= 0 ? 8 : -8), true);
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

    // ------------------------------------------------------------------
    // Mutual gravity made visible. Every body pulls on every other: the chosen body's menu has a
    // Gravity tab listing the strongest pulls on it (the info bar's Gravity tooltip names them too);
    // pull lines split its force arrow into one arrow per body pulling on it, joined tip to tail so
    // that they add up to the force arrow (vector addition), with a faint dashed line to each of those
    // bodies; its Hill sphere and Roche limit can be drawn; and a small legend gives the arrows' scales.
    //   Each pull is Newton's F = G m1 m2 / r^2 along the line between the pair (softened between pieces
    //   of one torn-apart body, as in the physics). A pull's share of the net force is its part along
    //   the net force, (F_i . F) / |F|^2: the shares add up to exactly 100%, and one that pulls partly
    //   against the rest has a negative share (forces add as arrows, not as numbers).
    //   The strongest PULL_TOP pullers are picked ten times a second, in one pass over the bodies. Each
    //   frame only their pulls are worked out again, from where they are now, and the rest are drawn as
    //   one grey "others" arrow: the net force less those, so the chain always ends exactly at the tip
    //   of the force arrow, whatever the tree or relativity added to it.
    //   The chain is drawn at the force arrow's own scale (px per newton at its length, a straight
    //   proportion, so the arrows really add up), unless one pull is much bigger than the net force
    //   (pulls that nearly cancel, as on a moon passing between its planet and the star), or the force
    //   is too weak for its arrow to show (a probe, an asteroid): then the chain is drawn at a scale of
    //   its own, and its sum is a thin dashed arrow along the force arrow.
    //   Hill sphere: r_H = a (1 - e) cbrt(m / 3M) round the chosen body, for its orbit round its primary
    //   (mass M). Beyond it the primary's tidal pull beats the body's own gravity, so a moon of its own
    //   must stay inside. The formula needs m much less than M, so it is only drawn for bodies under a
    //   tenth of their primary's mass, and only for bound orbits. Roche limit: d = 2.44 R cbrt(M / m)
    //   from the primary, the distance checkTides uses: closer in, the primary's tides would tear apart
    //   a fluid body held together only by its own gravity. Not for star remnants or probes, which
    //   checkTides never tears apart either. Both are measured ten times a second and drawn at their
    //   true size every frame, so they keep up with the zoom; one too small to see says "zoom in".
    //   Legend: a round speed and a round force near the scene's reference arrows, drawn at exactly the
    //   lengths the arrows use (arrowLength and forceLength), above the scale bar; it fades while a
    //   body is under it.
    // ------------------------------------------------------------------
    const PULL_TOP = 5;                   // pulls named in the menu and drawn as pull lines (the rest: "others")
    const PULL_EVERY_MS = 100;            // the strongest pullers are picked again ten times a second
    const HILL_MAX = 0.1;                 // Hill spheres only for bodies under this fraction of their primary's mass
    const LIMITS_EVERY_MS = 100;
    Object.assign(settings, { pulls: false, limits: false });
    const pulls = {
        bid: null, list: null, n: -1, t: -Infinity,   // whose pulls, the bodies array and its length then, and when
        k: 0, rest: 0,                                // how many are named, and how many others there are
        who: new Array(PULL_TOP).fill(null),
        f: new Float64Array(PULL_TOP), fx: new Float64Array(PULL_TOP), fy: new Float64Array(PULL_TOP),
        tx: 0, ty: 0,                                 // all the pulls added up: the net force (exact)
        ox: 0, oy: 0,                                 // the others added up
        cx: new Float64Array(PULL_TOP), cy: new Float64Array(PULL_TOP),   // this frame's pulls of the named ones
        panelT: 0, panelBid: null, panelOn: false,    // the menu's list: when last written, for whom, and was it showing
        rows: []
    };
    const pp = { x: 0, y: 0 };        // pairPull's result (no allocation)
    // The chain as drawn this frame: its start and end, the force arrow's tip, its scale (px per M_sun
    // AU / yr^2), and what chainLink needs (the body's centre, line width, font size, names placed)
    const chainOut = {
        drawn: false, x0: 0, y0: 0, ex: 0, ey: 0, tipX: 0, tipY: 0, k: 0, squeezed: false, links: 0,
        named: 0, bx: 0, by: 0, w: 1, fs: 11
    };
    const chainLabels = [{ x: 0, y: 0, w: 0 }, { x: 0, y: 0, w: 0 }, { x: 0, y: 0, w: 0 }];
    const lim = {
        bid: null, t: -Infinity, hill: 0, roche: 0, p: null, inside: false,
        hillText: '', rocheText: '', notes: [],
        hShown: false, hState: '', hx: 0, hy: 0, hR: 0, rShown: false, rState: '', rx: 0, ry: 0, rR: 0
    };
    const legend = {
        t: -Infinity, alpha: 1, covered: false, vSqueezed: false, shown: false, right: false,
        kms: 0, vText: '', vPx: 0, N: 0, fText: '', fPx: 0, squeeze: false, x: 0, vy: 0, fy: 0, w: 0, top: 0
    };
    const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    // The pull of q on b (M_sun AU / yr^2) into pp; returns its size
    function pairPull(b, q) {
        const dx = q.x - b.x, dy = q.y - b.y;
        const r2 = dx * dx + dy * dy;
        let s2 = r2;
        if (b.grp && q.grp) {
            if (b.grp !== q.grp) { pp.x = 0; pp.y = 0; return 0; }
            const e = 0.5 * (softLength(b) + softLength(q)); s2 += e * e;
        }
        if (!(s2 > 0)) { pp.x = 0; pp.y = 0; return 0; }
        const k = (G * b.m * q.m) / (s2 * Math.sqrt(s2));
        pp.x = k * dx; pp.y = k * dy;
        return k * Math.sqrt(r2);
    }

    // The strongest pullers on b (kept sorted, strongest first) and all the pulls added up; at most
    // ten times a second unless fresh
    function gatherPulls(b, fresh) {
        const now = performance.now();
        if (!fresh && pulls.bid === b.id && pulls.list === bodies && pulls.n === bodies.length && now - pulls.t < PULL_EVERY_MS) return pulls;
        pulls.bid = b.id; pulls.list = bodies; pulls.n = bodies.length; pulls.t = now;
        const who = pulls.who, f = pulls.f, fx = pulls.fx, fy = pulls.fy;
        let k = 0, tx = 0, ty = 0;
        for (const q of bodies) {
            if (q === b) continue;
            const m = pairPull(b, q);
            tx += pp.x; ty += pp.y;
            if (k === PULL_TOP && !(m > f[k - 1])) continue;
            let i = k < PULL_TOP ? k++ : PULL_TOP - 1;
            while (i > 0 && f[i - 1] < m) { who[i] = who[i - 1]; f[i] = f[i - 1]; fx[i] = fx[i - 1]; fy[i] = fy[i - 1]; i--; }
            who[i] = q; f[i] = m; fx[i] = pp.x; fy[i] = pp.y;
        }
        for (let i = k; i < PULL_TOP; i++) who[i] = null;
        let ox = tx, oy = ty;
        for (let i = 0; i < k; i++) { ox -= fx[i]; oy -= fy[i]; }
        pulls.k = k; pulls.rest = bodies.length - 1 - k;
        pulls.tx = tx; pulls.ty = ty; pulls.ox = ox; pulls.oy = oy;
        return pulls;
    }

    // A pull's share of the net force (x, y: the pull), from the last gatherPulls
    function pullShare(x, y) {
        const T2 = pulls.tx * pulls.tx + pulls.ty * pulls.ty;
        return T2 > 0 ? (x * pulls.tx + y * pulls.ty) / T2 : 0;
    }

    // "100%", "99.98%", "0.0031%", "-83%": enough figures to show that small pulls aren't nothing
    function fmtShare(s) {
        const pct = 100 * s, a = Math.abs(pct);
        if (a < 1e-4) return '<0.0001%';
        let t;
        if (a >= 1000) t = Math.round(a).toLocaleString('en-US');
        else if (a >= 100.05) t = a.toFixed(a >= 199.5 ? 0 : 1);
        else if (a >= 99) t = a.toFixed(2);
        else if (a >= 10) t = a.toFixed(1);
        else t = String(+a.toPrecision(2));
        t = t.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
        return `${pct < 0 ? '−' : ''}${t}%`;
    }

    // A radius in plain words: "18,400 km", "1.50 million km", "0.215 AU"
    function fmtReach(au) {
        const km = au * AU_KM;
        if (scene.units !== 'km' && au >= 0.1) return `${+au.toPrecision(3)} AU`;
        if (km >= 1e6) return `${(km / 1e6).toPrecision(3)} million km`;
        if (km >= 100) return `${(+km.toPrecision(3)).toLocaleString('en-US')} km`;
        return `${+km.toPrecision(2)} km`;
    }

    // The info bar's Gravity tooltip: what the readout is, then all the pulls and their shares
    function pullsTitle(b, base) {
        if (!b || bodies.length < 2) return base;
        const P = gatherPulls(b);
        const T = Math.hypot(P.tx, P.ty);
        if (!(T > 0)) return base;
        const n = Math.min(P.k, 3), parts = [];
        for (let i = 0; i < n; i++) parts.push(`${theName(P.who[i])} ${fmtShare(pullShare(P.fx[i], P.fy[i]))}`);
        const more = P.k - n + P.rest;
        if (more) parts.push(`${more} more`);
        if (!orbitingBody(b)) return `${base}: ${parts.join(', ')}`;
        return `${base}. All the pulls on it add up to ${fmtSci(forceToNewtons(T), 2)} N: ${parts.join(', ')}`;
    }

    // ---- The menu's Gravity tab: who pulls on this body ----
    function buildPullRows() {
        const tbody = ui.popPullRows;
        if (!tbody) return;
        tbody.textContent = '';
        pulls.rows = [];
        for (let i = 0; i <= PULL_TOP; i++) {
            const tr = document.createElement('tr');
            const th = document.createElement('th'), dot = document.createElement('span'), name = document.createElement('span');
            const force = document.createElement('td'), share = document.createElement('td');
            th.scope = 'row';
            dot.className = 'orb-pull-dot';
            dot.setAttribute('aria-hidden', 'true');
            th.append(dot, name);
            tr.append(th, force, share);
            if (i === PULL_TOP) tr.className = 'orb-pull-others';
            tr.hidden = true;
            tbody.appendChild(tr);
            pulls.rows.push({ tr, dot, name, force, share });
        }
    }

    // A few times a second while the tab is showing (straight away when it opens or the body changes)
    function updatePullPanel(force) {
        const on = !!(ui.popPullRows && popBody && ui.pop && !ui.pop.hidden && edit.tab === 'pull');
        const wasOn = pulls.panelOn;
        pulls.panelOn = on;
        if (!on) return;
        const now = performance.now();
        if (!force && wasOn && pulls.panelBid === popBody.id && now - pulls.panelT < 200) return;
        pulls.panelT = now; pulls.panelBid = popBody.id;
        const b = popBody;
        setText(ui.popPullHead, `Who pulls on ${theName(b)}`);
        const P = bodies.length > 1 ? gatherPulls(b) : null;
        let against = false;
        for (let i = 0; i <= PULL_TOP; i++) {
            const row = pulls.rows[i];
            const others = i === PULL_TOP;
            const q = P && !others && i < P.k ? P.who[i] : null;
            const show = !!(others ? P && P.rest > 0 : q);
            if (row.tr.hidden === show) row.tr.hidden = !show;
            if (!show) continue;
            const x = others ? P.ox : P.fx[i], y = others ? P.oy : P.fy[i];
            const s = pullShare(x, y);
            if (s < -1e-6) against = true;   // (only if the minus shows: fmtShare's smallest is 0.0001%)
            if (others) {
                setText(row.name, `${P.rest.toLocaleString('en-US')} ${P.rest === 1 ? 'other' : 'others'}, together`);
            } else {
                row.dot.style.background = q.color;
                setText(row.name, q.name);
            }
            setText(row.force, `${fmtSci(forceToNewtons(others ? Math.hypot(x, y) : P.f[i]), 2)} N`);
            setText(row.share, fmtShare(s));
        }
        setText(ui.popPullNet, P ? `${fmtSci(forceToNewtons(Math.hypot(P.tx, P.ty)), 2)} N` : '–');
        let note;
        if (!P || !P.k) note = `Nothing else here pulls on ${theName(b)}.`;
        else {
            // Newton's 3rd law: the strongest puller is pulled back just as hard
            note = `${capital(theName(b))} pulls back on ${theName(P.who[0])} just as hard, ${fmtSci(forceToNewtons(P.f[0]), 2)} N (Newton's 3rd law).`;
            if (against) note = `A minus share pulls against the others. ${note}`;
        }
        setText(ui.popPullNote, note);
    }

    // ---- Pull lines ----
    // A faint dashed line from the chosen body to each of its strongest pullers (stronger: bolder)
    function drawPullTethers(C, b) {
        if (bodies.length < 2) return;
        const P = gatherPulls(b);
        if (!P.k) return;
        const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
        const far = 4 * (viewW + viewH);
        ctx.lineWidth = 1.3;
        ctx.setLineDash([3, 5]);
        for (let i = P.k - 1; i >= 0; i--) {
            const q = P.who[i];
            const qx = sx(q.dx), qy = sy(q.dy);
            const dx = qx - x, dy = qy - y, d = Math.hypot(dx, dy);
            const rq = q.minor && !isChosen(q) ? 2 : drawRadius(q);
            if (!(d > r + rq + 6)) continue;
            const ux = dx / d, uy = dy / d, end = Math.min(d - rq - 3, far);
            // (full strength for the strongest, faintest four powers of ten weaker)
            const s = clamp(1 + Math.log10(P.f[i] / P.f[0]) / 4, 0, 1);
            ctx.globalAlpha = 0.22 + 0.5 * s;
            ctx.strokeStyle = bodyStroke(q.color, C.dark);
            ctx.beginPath();
            ctx.moveTo(x + ux * (r + 3), y + uy * (r + 3));
            ctx.lineTo(x + ux * end, y + uy * end);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
    }

    // Each strongest pull as an arrow in its puller's colour, then the others in grey, tip to tail from
    // the base of the force arrow: they end at its tip. Long enough arrows are named.
    function drawPullChain(C, b) {
        chainOut.drawn = false;
        if (bodies.length < 2) return;
        const Fm = Math.hypot(b.fx, b.fy);
        if (!(Fm > 0)) return;
        const L = forceLength(Fm);
        const P = gatherPulls(b);
        const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
        // (forces are world vectors: on the screen they are turned as the view is, by turn.c and turn.s)
        const tc = turn.c, ts = turn.s;
        const ux = (tc * b.fx - ts * b.fy) / Fm, uy = -(ts * b.fx + tc * b.fy) / Fm;
        const x0 = x + ux * r, y0 = y + uy * r;
        let sumX = 0, sumY = 0, big = 0;
        for (let i = 0; i < P.k; i++) {
            const m = pairPull(b, P.who[i]);
            P.cx[i] = pp.x; P.cy[i] = pp.y;
            sumX += pp.x; sumY += pp.y;
            if (m > big) big = m;
        }
        const ox = b.fx - sumX, oy = b.fy - sumY;
        big = Math.max(big, Math.hypot(ox, oy));
        let k = L / Fm;
        const cap = 160 * sizeScale;   // (1.6 times the longest force arrow)
        // (a pull far too weak for its force arrow to show, on a probe or an asteroid, is drawn larger)
        const tiny = L < 16 * sizeScale;
        if (tiny) k = (40 * sizeScale) / Fm;
        const squeezed = tiny || big * k > cap;
        if (big * k > cap) k = cap / big;
        // (thinner than the force arrow, so where one pull is nearly all of it the pink shows round it)
        const wNet = clamp(2 * sizeScale, 1.5, 2.4), w = 0.55 * wNet;
        // The sum first (under the pulls): the force arrow itself, unless that is hidden, or the chain is
        // drawn at a scale of its own (then dashed and thin)
        const ex = x0 + (tc * b.fx - ts * b.fy) * k, ey = y0 - (ts * b.fx + tc * b.fy) * k;
        if (squeezed) {
            ctx.setLineDash([4, 3]);
            arrow(x0, y0, ex, ey, C.force, w);
            ctx.setLineDash([]);
        } else if (!settings.forces) {
            arrow(x0, y0, ex, ey, C.force, wNet);
        }
        const c = chainOut;
        c.x0 = x0; c.y0 = y0; c.ex = x0; c.ey = y0; c.links = 0; c.named = 0;
        c.bx = x; c.by = y; c.w = w; c.fs = clamp(Math.min(viewW, viewH) / 50, 10, 11.5);
        ctx.font = font(c.fs);
        for (let i = 0; i < P.k; i++) {
            chainLink(C, (tc * P.cx[i] - ts * P.cy[i]) * k, -(ts * P.cx[i] + tc * P.cy[i]) * k, bodyStroke(P.who[i].color, C.dark), P.who[i].name, P.who[i]);
        }
        chainLink(C, (tc * ox - ts * oy) * k, -(ts * ox + tc * oy) * k, C.subtle, P.rest ? 'others' : '', null);
        c.drawn = true; c.tipX = x0 + ux * L; c.tipY = y0 + uy * L; c.k = k; c.squeezed = squeezed;
    }

    // One pull of the chain, from where the last ended (chainOut.ex, ey), and its puller's name beside
    // it: on the side away from the body, not where that body's own name already is, nor over another
    function chainLink(C, lx, ly, color, label, q) {
        const c = chainOut;
        const len = Math.hypot(lx, ly);
        const px = c.ex, py = c.ey;
        c.ex += lx; c.ey += ly;
        if (len < 2) return;
        arrow(px, py, px + lx, py + ly, color, c.w);
        c.links++;
        if (!label || !settings.labels || len < 40 || c.named >= chainLabels.length || cleanRender) return;
        const fs = c.fs;
        let nx = -ly / len, ny = lx / len;
        const mx = px + lx / 2, my = py + ly / 2;
        if (nx * (mx - c.bx) + ny * (my - c.by) < 0) { nx = -nx; ny = -ny; }
        const tx = mx + nx * (fs * 0.9 + 2), ty = my + ny * (fs * 0.9 + 2);
        const tw = ctx.measureText(label).width / 2 + 3;
        if (q && Math.hypot(sx(q.dx) - tx, sy(q.dy) - ty) < drawRadius(q) + tw + 24) return;
        for (let j = 0; j < c.named; j++) {
            const o = chainLabels[j];
            if (Math.abs(o.x - tx) < o.w + tw && Math.abs(o.y - ty) < fs + 2) return;
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = hexA(C.bg, 0.8);
        ctx.lineWidth = 3;
        ctx.fillStyle = C.label;
        ctx.strokeText(label, tx, ty);
        ctx.fillText(label, tx, ty);
        const o = chainLabels[c.named++];
        o.x = tx; o.y = ty; o.w = tw;
    }

    // ---- Hill sphere and Roche limit ----
    function measureLimits(b) {
        const now = performance.now();
        if (lim.bid === b.id && now - lim.t < LIMITS_EVERY_MS) return;
        lim.bid = b.id; lim.t = now;
        lim.hill = lim.roche = 0; lim.p = null; lim.inside = false;
        lim.hillText = lim.rocheText = '';
        lim.notes.length = 0;   // (each: the card's line, and a shorter one for small canvases)
        if (bodies.length < 2) { lim.notes.push(['On its own: no Hill sphere or Roche limit', 'On its own: neither']); return; }
        if (!orbitingBody(b)) { lim.notes.push([`${capital(theName(b))} is the heaviest here: choose a body that orbits it`, 'Choose a body that orbits another']); return; }
        if (b.m < 1e-17) { lim.notes.push(['A probe\'s own gravity is far too weak for either', 'None for a probe']); return; }
        const p = b.primary;
        lim.p = p;
        const el = elementsOf(b, p);
        if (b.m > HILL_MAX * p.m) lim.notes.push([`No Hill sphere: it is over a tenth of ${theName(p)}'s mass`, 'No Hill sphere: too heavy']);
        else if (!el.bound || !b.bound) lim.notes.push([`No Hill sphere: it isn't bound to ${theName(p)}`, 'No Hill sphere: not bound']);
        else {
            lim.hill = el.a * (1 - el.e) * Math.cbrt(b.m / (3 * p.m));
            lim.hillText = `Hill sphere: ${fmtReach(lim.hill)}`;
        }
        if (isCompact(b)) lim.notes.push(['No Roche limit: it is too dense for tides to tear apart', 'No Roche limit: too dense']);
        else {
            lim.roche = (ROCHE * b.R * Math.cbrt(p.m / b.m)) / AU_KM;
            lim.inside = lim.roche <= p.R / AU_KM;
            lim.rocheText = `Roche limit: ${fmtReach(lim.roche)}`;
        }
    }

    // The dashed circles, at their true size (under the bodies). Each is 'ok', 'small' (hidden under
    // the disc: zoom in) or 'big' (far larger than the view: zoom out).
    function drawLimitCircles(C, b) {
        measureLimits(b);
        lim.hShown = lim.rShown = false;
        lim.hState = lim.rState = '';
        const big = 4 * (viewW + viewH);
        const state = (R, r) => (R <= r + 3 ? 'small' : R >= big ? 'big' : 'ok');
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 5]);
        if (lim.hill > 0) {
            lim.hx = sx(b.dx); lim.hy = sy(b.dy); lim.hR = lim.hill * scale;
            lim.hState = state(lim.hR, drawRadius(b));
            lim.hShown = lim.hState === 'ok';
            if (lim.hShown) {
                ctx.strokeStyle = hexA(bodyStroke(b.color, C.dark), 0.9);
                ctx.beginPath();
                ctx.arc(lim.hx, lim.hy, lim.hR, 0, TAU);
                ctx.stroke();
            }
        }
        const p = lim.p;
        if (lim.roche > 0 && p) {
            lim.rx = sx(p.dx); lim.ry = sy(p.dy); lim.rR = lim.roche * scale;
            lim.rState = state(lim.rR, drawRadius(p));
            lim.rShown = lim.rState === 'ok';
            if (lim.rShown) {
                ctx.strokeStyle = hexA(C.force, 0.9);
                ctx.beginPath();
                ctx.arc(lim.rx, lim.ry, lim.rR, 0, TAU);
                ctx.stroke();
            }
        }
        ctx.setLineDash([]);
    }

    // A circle's name: above it (or below), else where it crosses the view nearest the middle
    function circleLabel(C, cx, cy, R, below, text, fs) {
        ctx.font = font(fs);
        const w = ctx.measureText(text).width;
        let x = cx, top = NaN;
        for (const s of below ? [1, -1] : [-1, 1]) {
            const t = s < 0 ? cy - R - 4 - fs : cy + R + 4;
            if (cx >= visL && cx <= visR && t >= 4 && t + fs <= viewH - 30) { top = t; break; }
        }
        if (isNaN(top)) {
            const dx = midX - cx, dy = viewH / 2 - cy, d = Math.hypot(dx, dy);
            if (!(d > 0)) return;
            x = cx + (dx / d) * R; top = cy + (dy / d) * R + 4;
            if (x < visL || x > visR || top < 4 || top + fs > viewH - 30) return;
        }
        x = clamp(x, visL + 4 + w / 2, Math.max(visL + 4 + w / 2, visR - 4 - w / 2));
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.strokeStyle = hexA(C.bg, 0.85);
        ctx.lineWidth = 3;
        ctx.fillStyle = C.label;
        ctx.strokeText(text, x, top);
        ctx.fillText(text, x, top);
    }

    // Each circle named on it (its size and meaning are on the card)
    function drawLimitLabels(C, b) {
        if (cleanRender) return;
        const fs = clamp(Math.min(viewW, viewH) / 50, 10, 11.5);
        if (lim.hShown) circleLabel(C, lim.hx, lim.hy, lim.hR, false, 'Hill sphere', fs);
        if (lim.rShown) circleLabel(C, lim.rx, lim.ry, lim.rR, true, 'Roche limit', fs);
    }

    // The card (with the Kepler cards, top right): each size, what it means, and why one is missing
    // or can't be seen at this zoom
    function limitCardLines(b, compact) {
        if (!b) return null;
        const C = colours();
        const p = lim.p;
        const lines = [];
        const plain = (t) => [[t, false, C.subtle]];
        if (lim.hill > 0) {
            lines.push([[compact ? 'Hill sphere: ' : `Hill sphere of ${theName(b)}: `, true], [fmtReach(lim.hill)]]);
            if (!compact) lines.push(plain('its own moons must orbit inside it'));
        }
        if (lim.roche > 0 && p) {
            // (one line on a small canvas)
            lines.push([[compact ? 'Roche limit: ' : `Roche limit round ${theName(p)}: `, true], [fmtReach(lim.roche) + (compact && lim.inside ? ` (inside ${theName(p)})` : '')]]);
            if (!compact) {
                lines.push(plain(lim.inside ? `less than ${theName(p)}'s radius: ${theName(b)} would hit it first`
                    : `closer in, tides ${settings.realistic ? 'tear' : 'would tear'} ${theName(b)} apart`));
            }
        }
        for (const n of lim.notes) lines.push(plain(n[compact ? 1 : 0]));
        // Too small to see (under the discs) or far too big for the view
        const what = (h, r) => (h && r ? 'them' : h ? 'the Hill sphere' : 'the Roche limit');
        const hs = lim.hill > 0 && lim.hState === 'small', rs = lim.roche > 0 && !lim.inside && lim.rState === 'small';
        const hb = lim.hill > 0 && lim.hState === 'big', rb = lim.roche > 0 && lim.rState === 'big';
        if (hs || rs) lines.push(plain(`Zoom in to see ${what(hs, rs)}`));
        if (hb || rb) lines.push(plain(`Zoom out to see ${what(hb, rb)}`));
        return lines;
    }

    // ---- Drawn from renderFrame: under the bodies, and over the force arrows ----
    function drawGravityUnder(C, subj) {
        updatePullPanel(false);
        if (!subj) return;
        if (settings.limits) drawLimitCircles(C, subj);
        if (settings.pulls) drawPullTethers(C, subj);
    }

    function drawGravityOver(C, subj) {
        if (!subj) { chainOut.drawn = false; return; }
        if (settings.pulls) drawPullChain(C, subj); else chainOut.drawn = false;
        if (settings.limits) drawLimitLabels(C, subj);
    }

    // ---- Arrow legend (bottom left, above the scale bar) ----
    // The 1, 2 or 5 x 10^n nearest x (on a log scale)
    function niceNearest(x) {
        if (!(x > 0)) return 0;
        const pow = Math.pow(10, Math.floor(Math.log10(x)));
        let best = pow, bestD = Infinity;
        for (const c of [1, 2, 5, 10]) {
            const d = Math.abs(Math.log(c * pow / x));
            if (d < bestD) { bestD = d; best = c * pow; }
        }
        return +best.toPrecision(1);
    }

    function legendSpeedText(kms) {
        if (kms < 0.1) return `${+(kms * 1000).toPrecision(2)} m/s`;
        return `${(+kms.toPrecision(2)).toLocaleString('en-US')} km/s`;
    }

    // On a small canvas the key keeps out of the way: there for a few seconds as a scene opens or an
    // arrow is switched on, then only while paused (in a mission the clock stops for each burn, so not
    // there) or dragging
    const KEY_MS = 6000;
    const keyWake = { scene: null, v: false, f: false, until: 0 };
    function drawArrowLegend(C) {
        legend.shown = false;
        const showV = settings.velocities, showF = settings.forces;
        if (cleanRender || !bodies.length || !(showV || showF)) return;
        const now = performance.now();
        if (keyWake.scene !== scene || (showV && !keyWake.v) || (showF && !keyWake.f)) keyWake.until = now + KEY_MS;
        Object.assign(keyWake, { scene, v: showV, f: showF });
        const tight = viewW < 560 || viewH < 320;
        const away = tight && now >= keyWake.until && !drags.size && !(paused && !mission.def);
        if (away && legend.alpha < 0.02) { legend.alpha = 0; return; }
        const fs = clamp(Math.min(viewW, viewH) / 50, 10, 11.5);
        const lh = Math.round(fs * (viewW < 560 ? 1.35 : 1.55));
        // Round values near the scene's medium arrows, at exactly the drawn arrows' lengths
        if (showV) {
            const kms = niceNearest(0.7 * vRef * AUYR_KMS);
            if (kms !== legend.kms) { legend.kms = kms; legend.vText = legendSpeedText(kms); }
            legend.vPx = arrowLength(kms / AUYR_KMS);
        }
        if (showF) {
            const N = niceNearest(0.8 * forceToNewtons(forceRef));
            if (N !== legend.N) { legend.N = N; legend.fText = `${fmtSci(N, 0)} N`; }
            legend.fPx = forceLength(N / forceToNewtons(1));
        }
        ctx.font = font(fs);
        const arrowW = Math.max(showV ? legend.vPx : 0, showF ? legend.fPx : 0);
        const vTW = showV ? ctx.measureText(legend.vText).width : 0, fTW = showF ? ctx.measureText(legend.fText).width : 0;
        const textW = Math.max(vTW, fTW);
        // On a small canvas the two arrows share one row, just above the scale bar; elsewhere a row each
        const rowW = (showV ? legend.vPx + 6 + vTW : 0) + (showV && showF ? 14 : 0) + (showF ? legend.fPx + 6 + fTW : 0);
        const oneRow = tight && rowW <= viewW * 0.8;
        const rows = oneRow ? 1 : (showV ? 1 : 0) + (showF ? 1 : 0);
        const w = oneRow ? rowW : arrowW + 8 + textW;
        const bottom = viewH - 12 - fs - (tight ? 6 : 10);
        const top = bottom - rows * lh;
        // (the flyby close-up may have taken the bottom-left corner: then the bottom right, above the note)
        legend.right = !!(closeUp && closeUp.x < midX && closeUp.y > viewH / 2);
        const left = legend.right ? visR - 12 - w : visL + 12;
        // Fade while a body (not a swarm's dot) is under it: checked ten times a second
        if (now - legend.t > 100) {
            legend.t = now;
            legend.covered = false;
            for (const b of bodies) {
                if (b.minor && !isChosen(b)) continue;
                const x = sx(b.dx), y = sy(b.dy), r = drawRadius(b) + 4;
                if (x + r > left - 4 && x - r < left + w + 4 && y + r > top - 2 && y - r < bottom + 2) legend.covered = true;
            }
        }
        legend.alpha += ((away ? 0 : legend.covered ? 0.15 : 1) - legend.alpha) * 0.2;
        // (the arrows as drawArrows draws them: the same width and lengths)
        const aw = clamp(2 * sizeScale, 1.5, 2.4);
        ctx.globalAlpha = legend.alpha;
        let y = top + lh / 2;
        if (oneRow) {
            let x = left;
            if (showV) { legend.vy = y; legendRow(C, x, y, legend.vPx, aw, C.velocity, x + legend.vPx + 6, legend.vText); x += legend.vPx + 6 + vTW + 14; }
            if (showF) { legend.fy = y; legendRow(C, x, y, legend.fPx, aw, C.force, x + legend.fPx + 6, legend.fText); }
        } else {
            const tx = left + arrowW + 8;
            if (showV) { legend.vy = y; legendRow(C, left, y, legend.vPx, aw, C.velocity, tx, legend.vText); y += lh; }
            if (showF) { legend.fy = y; legendRow(C, left, y, legend.fPx, aw, C.force, tx, legend.fText); y += lh; }
        }
        ctx.globalAlpha = 1;
        legend.x = left; legend.shown = true; legend.w = w; legend.top = top;
    }

    // A legend row: an arrow px long (if any), then its text at tx
    function legendRow(C, left, y, px, width, color, tx, text) {
        if (color) arrow(left, y, left + px, y, color, width);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = hexA(C.bg, 0.8);
        ctx.lineWidth = 3;
        ctx.fillStyle = C.subtle;
        ctx.strokeText(text, tx, y + 0.5);
        ctx.fillText(text, tx, y + 0.5);
    }

    // ---- Switching them on and off: the settings, the menu's buttons and G ----
    function syncGravityControls() {
        if (ui.pullsToggle) ui.pullsToggle.checked = settings.pulls;
        if (ui.limitsToggle) ui.limitsToggle.checked = settings.limits;
        if (ui.popPullLines) ui.popPullLines.setAttribute('aria-pressed', settings.pulls ? 'true' : 'false');
        if (ui.popPullLimits) ui.popPullLimits.setAttribute('aria-pressed', settings.limits ? 'true' : 'false');
    }

    // On: say what they show in the hint line (read out: it is a live region)
    // (the note names whichever body is chosen while it shows)
    function setPullLines(on) {
        settings.pulls = !!on;
        syncGravityControls();
        if (!settings.pulls) { clearHint('note', 'pulls'); return; }
        showHint('note', () => {
            const b = bodyById(selectedId);
            if (!b) return '<strong>Pull lines:</strong> choose a body to see who pulls on it.';
            return `<strong>Pull lines:</strong> one arrow for each body pulling on ${escapeHtml(theName(b))}, joined tip to tail.`;
        }, { ms: 9000, tag: 'pulls' });
    }

    function setLimits(on) {
        settings.limits = !!on;
        lim.bid = null;
        syncGravityControls();
        if (!settings.limits) { clearHint('note', 'limits'); return; }
        showHint('note', () => {
            const b = bodyById(selectedId);
            if (!(b && orbitingBody(b) && b.m >= 1e-17)) return '<strong>Hill sphere and Roche limit:</strong> choose a body that orbits another.';
            measureLimits(b);
            const who = escapeHtml(theName(b)), says = [];
            if (lim.hill > 0) says.push(`<strong>Hill sphere:</strong> ${who}'s moons stay inside`);
            if (lim.roche > 0) says.push(`<strong>Roche limit:</strong> any closer, and tides would tear it apart`);
            return says.length ? `${says.join('. ')}.` : `<strong>Hill sphere and Roche limit:</strong> none for ${who}.`;
        }, { ms: 9000, tag: 'limits' });
    }

    function onGravityKey(e) {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.isComposing || typingIn(e.target)) return;
        if (e.key !== 'g' && e.key !== 'G') return;
        setPullLines(!settings.pulls);
        e.preventDefault();
    }

    function bindGravity() {
        Object.assign(ui, {
            pullsToggle: byId('pullsToggle'), limitsToggle: byId('limitsToggle'),
            popPullHead: byId('popPullHead'), popPullRows: byId('popPullRows'), popPullNet: byId('popPullNet'),
            popPullNote: byId('popPullNote'), popPullLines: byId('popPullLines'), popPullLimits: byId('popPullLimits')
        });
        TAB_OF.popTabPull = 'pull';
        buildPullRows();
        if (ui.pullsToggle) ui.pullsToggle.addEventListener('change', () => setPullLines(ui.pullsToggle.checked));
        if (ui.limitsToggle) ui.limitsToggle.addEventListener('change', () => setLimits(ui.limitsToggle.checked));
        if (ui.popPullLines) ui.popPullLines.addEventListener('click', () => setPullLines(!settings.pulls));
        if (ui.popPullLimits) ui.popPullLimits.addEventListener('click', () => setLimits(!settings.limits));
        document.addEventListener('keydown', onGravityKey);
        syncGravityControls();
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
        const room = ux > 0.3 ? visR - (q.x + gap) : ux < -0.3 ? q.x - gap - visL : Infinity;
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

    // "Sizes not to scale" says so for a few seconds as a scene opens or Realistic physics changes
    const SIZE_NOTE_MS = 8000;
    const sizeNote = { scene: null, realistic: null, until: 0 };

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
        const x0 = visL + pad + 4, y0 = viewH - pad - 4;
        ctx.strokeStyle = C.subtle;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x0, y0 - 5); ctx.lineTo(x0, y0); ctx.lineTo(x0 + len, y0); ctx.lineTo(x0 + len, y0 - 5);
        ctx.stroke();
        ctx.font = font(fs);
        ctx.fillStyle = C.subtle;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        const sl = scaleLabel(nice), now = performance.now();
        ctx.fillText(sl, x0 + len + 6, y0 + 2);
        edges.scaleRight = x0 + len + 6 + ctx.measureText(sl).width;
        if (sizeNote.scene !== scene || sizeNote.realistic !== settings.realistic) {
            Object.assign(sizeNote, { scene, realistic: settings.realistic, until: now + SIZE_NOTE_MS });
        }
        edges.noteLeft = Infinity;
        if (now < sizeNote.until) {
            const note = settings.realistic ? 'Sizes to scale' : 'Sizes not to scale';
            ctx.textAlign = 'right';
            ctx.fillText(note, visR - pad - 2, y0 + 2);
            edges.noteLeft = visR - pad - 2 - ctx.measureText(note).width;
        }
        edges.strip = y0 - fs - 4;

        drawFlybyCloseUp(C);

        // Pause / slow-down notice: top left, under the "Viewed from" chip if it is showing
        const t = timeNotice();
        if (t) {
            ctx.font = font(fs, true);
            const w = ctx.measureText(t).width + 18;
            const x = visL + pad, y = frameId !== null ? pad + 40 : pad;
            roundRect(x, y, w, fs + 10, 4);
            ctx.fillStyle = C.card;
            ctx.fill();
            ctx.fillStyle = C.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(t, x + w / 2, y + (fs + 10) / 2 + 0.5);
        }

        drawCardStack(C, subj, fs, pad);
        drawArrowLegend(C);
    }

    // ---- The cards down the top-right corner ----
    // Top first, in this order: a flyby, the stability timer, relativity, Kepler's 1st, 2nd
    // and 3rd laws, the Hill sphere and Roche limit. The stack never covers much of the canvas: when it
    // would grow past its cap (about 60% of the height, and clear of the scale bar), the lowest cards
    // turn compact (a line or two) first, a flyby and relativity last; if it is still too
    // tall the lowest fold into one last line that names them, and any left compact that now fit are
    // shown in full again. (Small canvases show compact cards from the start.) The layout is worked out
    // a few times a second, by drawing the cards where nothing shows, and kept in between.
    const CARD_ORDER = ['flyby', 'stability', 'relativity', 'k1', 'k2', 'k3', 'limits'];
    const CARD_NAMES = { flyby: 'flyby', stability: 'stability', relativity: 'relativity', k1: '1st law', k2: '2nd law', k3: '3rd law', limits: 'Hill & Roche' };
    const CARD_KEEP = new Set(['flyby', 'relativity']);
    const cards = { at: 0, sig: '', compact: {}, folded: [], left: Infinity, bottom: 0, over: false };

    // One card at y (compact or not): returns where the next one goes (y itself if it has nothing to show)
    function drawOneCard(C, id, subj, y, fs, compact) {
        let b = y;
        if (id === 'flyby') { const fl = flybyLines(compact); if (fl) b = drawCard(C, fl, y, fs) + 5; }
        else if (id === 'stability') b = drawStabilityCard(C, y, fs, compact);
        else if (id === 'relativity') { const e = drawRelativityCard(C, subj, y, fs, compact); if (e > y) b = e + 5; }
        else if (settings[id]) {
            const lines = id === 'k1' ? kepler1Lines(subj, compact) : id === 'k2' ? kepler2Lines(subj, compact) : id === 'limits' ? limitCardLines(subj, compact) : null;
            if (id === 'k3') b = drawKepler3Card(C, subj, y, fs, compact) + 5;
            else if (lines && lines.length) b = drawCard(C, lines, y, fs) + 5;
        }
        return b > y ? b : y;
    }

    // Which cards turn compact and which fold away, to keep the stack under cap px
    function layoutCards(C, subj, fs, small, cap) {
        const full = {}, comp = {}, ids = [];
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, 0, 0);
        ctx.clip();   // (measured by drawing them where nothing shows)
        for (const id of CARD_ORDER) {
            const h = drawOneCard(C, id, subj, 0, fs, small);
            if (h <= 0) continue;
            ids.push(id);
            full[id] = h;
            comp[id] = small ? h : drawOneCard(C, id, subj, 0, fs, true);
        }
        ctx.restore();
        const compact = {};
        let total = 0;
        for (const id of ids) { compact[id] = small; total += full[id]; }
        // (a flyby and relativity are what the moment is about: they turn compact last)
        const squeeze = (keep) => {
            for (let i = ids.length - 1; i >= 0 && total > cap; i--) {
                const id = ids[i];
                if (!compact[id] && !(keep && CARD_KEEP.has(id))) { total += comp[id] - full[id]; compact[id] = true; }
            }
        };
        squeeze(true);
        const folded = [], foldH = Math.round(fs * 1.4) + 15;
        for (let i = ids.length - 1; i >= 1 && total > cap; i--) {
            total -= compact[ids[i]] ? comp[ids[i]] : full[ids[i]];
            if (!folded.length) total += foldH;
            folded.unshift(ids[i]);
        }
        squeeze(false);
        // (with some folded away, the cards left may have room to be shown in full again, top first)
        if (folded.length && !small) {
            for (const id of ids) {
                if (folded.includes(id) || !compact[id] || total + full[id] - comp[id] > cap) continue;
                total += full[id] - comp[id];
                compact[id] = false;
            }
        }
        return { compact, folded };
    }

    function drawCardStack(C, subj, fs, pad) {
        const small = visR - visL < 560;
        const cfs = small ? clamp(fs - 0.5, 10, 12) : fs;
        const y0 = frameId !== null && visR - visL < 520 ? 48 : pad;
        const cap = Math.min(viewH * (viewH < 420 ? 0.55 : 0.6), viewH - y0 - 40);
        const now = performance.now();
        const sig = `${visR - visL}x${viewH}|${small}|${settings.k1}${settings.k2}${settings.k3}${settings.limits}${settings.stability}${settings.realistic}|${selectedId}|${C.dark}`;
        // (worked out again when what is switched on changes, and twice a second while the stack is
        // over its cap or has had to give way; a stack that fits as it is costs nothing more)
        const squeezed = cards.folded.length > 0 || (!small && CARD_ORDER.some((id) => cards.compact[id]));
        if (sig !== cards.sig || ((cards.over || squeezed) && now - cards.at > 500)) {
            Object.assign(cards, layoutCards(C, subj, cfs, small, cap));
            cards.sig = sig;
            cards.at = now;
        }
        cards.left = Infinity;
        cards.bottom = 0;
        let y = y0;
        for (const id of CARD_ORDER) {
            if (cards.folded.includes(id)) continue;
            y = drawOneCard(C, id, subj, y, cfs, cards.compact[id] !== undefined ? cards.compact[id] : small);
        }
        if (cards.folded.length) {
            const n = cards.folded.length;
            const text = small ? `+${n} more` : `+${n} more: ${cards.folded.map((id) => CARD_NAMES[id]).join(', ')}`;
            y = drawCard(C, [[[text, false, C.subtle]]], y, cfs) + 5;
        }
        cards.bottom = y > y0 ? y : 0;
        cards.over = y - y0 > cap + 1;
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
        const corners = [[visR - 10 - R, viewH - 30 - R], [visL + 10 + R, viewH - 34 - R], [visL + 10 + R, top]];
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

    // (kept: it is asked for every frame, and formatting a number with commas is slow)
    const scaleMemo = { au: 0, km: false, text: '' };
    function scaleLabel(au) {
        const km = scene.units === 'km' || au < 0.01;
        if (au !== scaleMemo.au || km !== scaleMemo.km) {
            scaleMemo.au = au; scaleMemo.km = km;
            scaleMemo.text = km ? `${fmtKm(Math.round(au * AU_KM))} km` : `${+au.toPrecision(3)} AU`;
        }
        return scaleMemo.text;
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
        const x = visR - 8 - w;
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
        if (x < cards.left) cards.left = x;   // (where the stack reaches: off-screen pointers keep clear)
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
        // Up to 10 rows (5 compact); past that, the last row says how many more there are
        const most = compact ? 5 : 10, shown = rows.length > most ? most - 1 : rows.length;
        const more = rows.length - shown;
        const cells = rows.slice(0, shown).map((r) => {
            const nm = r.body.name.length > maxName ? `${r.body.name.slice(0, maxName - 1)}…` : r.body.name;
            if (!r.measured) return { name: nm, body: r.body, measuring: `measuring… ${Math.round(r.progress * 100)}%` };
            const Tv = r.T * tf;
            const a = km ? fmtKm(r.a * AU_KM) : r.a.toFixed(3);
            const T = plain ? r.T.toFixed(3) : Tv >= 100 ? Tv.toFixed(1) : Tv >= 1 ? Tv.toFixed(2) : Tv.toPrecision(3);
            const ratio = plain ? r.ratio.toFixed(3) : fmtSci((Tv * Tv) / Math.pow(r.a * af, 3), 2);
            return { name: nm, body: r.body, cols: [a, T, ratio] };
        });
        if (more > 0) cells.push({ name: `+${more} more`, body: null, cols: ['', '', ''] });
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
        const x = visR - 8 - w;
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
                if (c.body) {
                    ctx.fillStyle = c.body.color;
                    ctx.beginPath();
                    ctx.arc(x + 13, ly, 3, 0, TAU);
                    ctx.fill();
                }
                ctx.textAlign = 'left';
                ctx.fillStyle = c.body ? C.text : C.subtle;
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
    //   Smooth: a path is worked out in the background, PREDICT_MS a frame, and only shown once it is
    //   whole; until then the last whole one stays (pred.shown), so a path never flickers or grows. A
    //   dragged body's path is worked out again as soon as the last is done (every frame or two); one
    //   moving on with the others, at most every PREDICT_EVERY_MS. In between, each frame the shown path
    //   is drawn from where the body is now (anchoredPath): the stretch it has covered since is left off
    //   (or for a closed orbit moved round to the end), and the rest is shifted to start at the body.
    // ------------------------------------------------------------------
    const PREDICT_ETA = 0.012;
    const PREDICT_PAIRS = 4e5;
    const PREDICT_MS = 3;                 // while drawing: ms of prediction a frame (it carries on in the next)
    const PREDICT_EVERY_MS = 100;         // a path whose body moves on with the others: worked out again this often
    const PREDICT_ALL = 24, PREDICT_HEAVY = 8;
    // The path being worked out (pts, its points' times ts after t0 in simulated years, bid: whose) and
    // the last whole one (shown); force: start again now (an edit, see previewPath)
    const pred = { key: '', t: 0, pts: null, ts: null, t0: 0, bid: null, loop: 0, end: null, refId: null, job: null, shown: null, force: false };
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
                const c = circularLaunch(b, p, d && d.isNew ? orbitSense(p, b) : heldSense(b, p, d), isSatellite(p));
                return { v: c.b, p, pv: c.p };
            }
        }
        if (settings.placement === 'rest') { const fv = frameVelocity(b.x, b.y); return { v: [fv.x, fv.y] }; }
        if (settings.placement === 'throw') return { v: throwVelocity(d || dragOf(b), performance.now()) };
        return { v: [b.vx, b.vy] };
    }

    function predictPath(b, d) {
        const rel = releaseVelocity(b, d);
        const p = placementPrimary(b.x, b.y, b.m, b);
        const L = frameId !== null && frameId !== b.id ? bodyById(frameId) : null;
        // (in a rotating frame the path is worked out as seen turning with the pair: see turnedSeen)
        const ref = turn.on ? null : L || (p && p.m >= b.m ? p : null);
        // (with the zoom's rough size: its points are spaced for the zoom, and a path worked out zoomed
        // out would be a few straight lines zoomed in)
        const key = [b.id, b.x, b.y, rel.v[0], rel.v[1], ref ? ref.id : turn.on ? 't' : 'c', settings.realistic, settings.merge, bodies.length, timeDir, Math.round(Math.log2(scale))].join('|');
        const now = performance.now();
        // The one being worked out carries on; a new one starts when something has changed: at once
        // after a reset or an edit, for another body, or while paused; for a dragged body once the last
        // is whole (or has taken too long); for one moving on with the others, at most every
        // PREDICT_EVERY_MS (anchoredPath keeps it with its body in between)
        if (pred.job) runPrediction(inRender ? PREDICT_MS : Infinity);
        const reset = !pred.key || pred.force || pred.bid !== b.id;
        const due = reset || (key !== pred.key && (!pred.job || now - pred.t > 400) && (paused || b.held || now - pred.t >= PREDICT_EVERY_MS));
        if (due) startPrediction(b, rel, ref, key, now);
        return pred.shown && pred.shown.bid === b.id ? pred.shown : pred;
    }

    function startPrediction(b, rel, ref, key, now) {
        pred.key = key; pred.t = now; pred.force = false; pred.bid = b.id; pred.t0 = simTime; pred.loop = 0;
        pred.refId = ref ? ref.id : turn.on ? TURN_REF : null;
        // The copy
        const src = predictionBodies(b, rel.p, ref);
        const list = src.map((q) => ({ x: q.x, y: q.y, vx: q.vx, vy: q.vy, m: q.m, R: q.R, grp: q.grp, ax: 0, ay: 0, hx: 0, hy: 0, slot: -1, stamp: -1, held: null }));
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
        pred.ts = [0];
        pred.end = 'cut';   // (until it finishes: the path so far, with no arrowhead at its end)
        pred.job = { list, me, origin, seen, pr, tMax, rMax, budget, k: 0, t: 0, lx: pts[0], ly: pts[1], ang: Math.atan2(pts[1], pts[0]), swept: 0, tmin: gravity(list) };
        runPrediction(inRender ? PREDICT_MS : Infinity);
    }

    // Carry the prediction on for up to ms milliseconds (it ends when the path closes, hits something,
    // leaves the view or uses up its budget)
    function runPrediction(ms) {
        const job = pred.job, list = job.list, me = job.me, pts = pred.pts, ts = pred.ts, pr = job.pr;
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
            tmin = yoshida(list, timeDir * dt, () => gravity(list));   // (where it will go: its past, if time runs backwards)
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
            if (hit) { pts.push(x, y); ts.push(t); end = 'hit'; break; }
            // (each point with its time, and where it first comes right round: one lap, for anchoredPath)
            const lap = !pred.loop && Math.abs(swept) >= TAU;
            if (lap || Math.abs(x - lx) + Math.abs(y - ly) > px) { pts.push(x, y); ts.push(t); lx = x; ly = y; }
            if (lap) pred.loop = ts.length - 1;
            if (Math.abs(swept) > TAU * 1.02) { end = 'closed'; break; }
            if (Math.hypot(x, y) > job.rMax && !(pr && pr.el.bound)) { end = 'away'; break; }
        }
        pts.push(...job.seen(me));
        ts.push(t);
        pred.end = end || 'open';
        pred.job = null;
        // Whole: shown from now on, in place of the last (which it grows out of: see blendedPath)
        const old = pred.shown && pred.shown.bid === pred.bid ? pred.shown : null;
        if (old) old.from = null;
        const t1 = performance.now();
        pred.shown = { bid: pred.bid, pts, ts, t0: pred.t0, loop: pred.end === 'closed' ? pred.loop : 0, end: pred.end, refId: pred.refId, t: t1, from: old, blend0: t1 };
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
        const pts = anchoredPath(b, pp, blendedPath(b, pp), o);   // (turned as the view is, and from where the body is now)
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

    // A path's points turned as drawn, and for its first PATH_BLEND_MS grown smoothly out of the path it
    // replaced (pp.from): each point moves from where the old path was at the same moment (matched by the
    // points' times, both counted from now) to its own place, so a new path never jumps in.
    const PATH_BLEND_MS = 90;
    function blendedPath(b, pp) {
        const pts = turnedPath(pp), old = pp.from;
        if (!old) return pts;
        const w = (performance.now() - pp.blend0) / PATH_BLEND_MS;
        const ots = old.ts, on = ots ? ots.length : 0, ts = pp.ts;
        if (!(w < 1) || !ts || ts.length * 2 !== pts.length || on < 2 || old.refId !== pp.refId) { pp.from = null; return pts; }
        const ops = turnedPath(old);
        if (ops.length !== 2 * on) { pp.from = null; return pts; }
        const keep = 1 - w * w * (3 - 2 * w);   // (eased: the old path's share)
        const off = b.held ? 0 : timeDir * (pp.t0 - old.t0);
        const out = pts.slice();
        for (let i = 0, j = 0; i < ts.length; i++) {
            const t = ts[i] + off;
            if (t > ots[on - 1]) break;   // (beyond the old path's end: the new one as it is)
            while (j < on - 2 && ots[j + 1] < t) j++;
            const f = t <= ots[j] ? 0 : ots[j + 1] > ots[j] ? Math.min(1, (t - ots[j]) / (ots[j + 1] - ots[j])) : 0;
            const ox = ops[2 * j] + f * (ops[2 * j + 2] - ops[2 * j]), oy = ops[2 * j + 1] + f * (ops[2 * j + 3] - ops[2 * j + 1]);
            out[2 * i] += keep * (ox - out[2 * i]);
            out[2 * i + 1] += keep * (oy - out[2 * i + 1]);
        }
        return out;
    }

    // A path's points (pts, relative to o and turned as drawn) from where body b is drawn now. Time having
    // run on since the path was worked out (from pp.t0), the body has covered its first stretch: that is
    // left off, or for a closed orbit (one lap, to pp.loop) moved round to the end; and the rest is
    // shifted so that it starts exactly at the body. A dragged body (held, so no time passes for it)
    // takes its whole path with it until the next one is ready. So the path stays with the body every
    // frame, and the next one, worked out from there, lands where this one already is.
    function anchoredPath(b, pp, pts, o) {
        const n = pts.length >> 1, ts = pp.ts;
        if (!ts || ts.length !== n || n < 2 || pp.bid !== b.id) return pts;
        const loop = pp.loop > 0 && pp.loop < n ? pp.loop : 0, last = loop || n - 1;
        let tau = b.held ? 0 : timeDir * (simTime + lag - pp.t0);
        if (!(tau > 0)) tau = 0;
        if (loop) tau %= ts[loop]; else if (tau > ts[last]) tau = ts[last];
        let lo = 0, hi = last;   // ts[lo] <= tau < ts[hi]
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= tau) lo = m; else hi = m; }
        const f = ts[lo + 1] > ts[lo] ? clamp((tau - ts[lo]) / (ts[lo + 1] - ts[lo]), 0, 1) : 0;
        const qx = pts[2 * lo] + f * (pts[2 * lo + 2] - pts[2 * lo]), qy = pts[2 * lo + 1] + f * (pts[2 * lo + 3] - pts[2 * lo + 1]);
        const bx = b.dx - o.x, by = b.dy - o.y, dx = bx - qx, dy = by - qy;
        const out = [bx, by];
        for (let k = lo + 1; k <= last; k++) out.push(pts[2 * k] + dx, pts[2 * k + 1] + dy);
        if (loop) {
            for (let k = 1; k <= lo; k++) out.push(pts[2 * k] + dx, pts[2 * k + 1] + dy);
            out.push(bx, by);
        }
        return out;
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

    // The body a drag would make a moon of (see moonHost): ringed while the drag is over it
    let dropHost = null;
    function drawDropHost(C) {
        if (!dropHost || !bodies.includes(dropHost)) return;
        ctx.strokeStyle = C.velocity;
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(sx(dropHost.dx), sy(dropHost.dy), drawRadius(dropHost) + 7, 0, TAU);
        ctx.stroke();
    }

    // A body being dragged from the palette, drawn where it would land.
    function drawPaletteGhost() {
        drawDropHost(colours());
        if (!paletteDrag || !paletteDrag.over) return;
        const k = KINDS[paletteDrag.kind] || KINDS.custom;
        const x = paletteDrag.cx, y = paletteDrag.cy;
        const r = Math.max(symbolicSize(paletteDrag.kind, k.m, k.R) * sizeScale, 4);
        ctx.globalAlpha = 0.85;
        drawBody({ kind: paletteDrag.kind, m: k.m, color: k.color }, x, y, r, colours());
        ctx.globalAlpha = 1;
        if (settings.placement === 'circular' && settings.preview && !dropHost) {
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
        updateMission();
        const tm = timeReadout();   // (the date, in a scene with a start date)
        setText(ui.statTime, tm.v);
        setText(ui.statTimeUnit, tm.u);
        updateTimeControls();
        updateOrbitReadouts();
        const b = bodyById(selectedId);
        if (!b) {
            setText(ui.subjectName, '–'); setText(ui.subjectAround, '');
            setText(ui.statDist, '–'); setText(ui.statSpeed, '–'); setText(ui.statForce, '–');
            setText(ui.statDistUnit, ''); setStatUnit(ui.statSpeed, ''); setStatUnit(ui.statForce, '');
            return;
        }
        if (ui.subjectDot) ui.subjectDot.style.background = b.color;
        setText(ui.subjectName, b.name);
        const p = b.primary;
        const top = !p || (p.primary === b && b.m > p.m);
        let dist, speed, force;
        if (bodies.length < 2) {
            // (no units for what isn't there)
            setText(ui.subjectAround, 'on its own');
            setText(ui.statDist, '–'); setText(ui.statDistUnit, '');
            setText(ui.statSpeed, '–'); setText(ui.statForce, '–');
            setStatUnit(ui.statSpeed, ''); setStatUnit(ui.statForce, '');
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
        setStatUnit(ui.statSpeed, s.u);
        setText(ui.statForce, force > 0 ? fmtSci(forceToNewtons(force), 2) : '0');
        setStatUnit(ui.statForce, 'N');
    }

    // The unit after a readout's value (the text that follows it)
    function setStatUnit(el, u) {
        if (!el || !el.nextSibling) return;
        const t = u ? ` ${u}` : ' ';
        if (el.nextSibling.textContent !== t) el.nextSibling.textContent = t;
    }

    function forceToNewtons(f) { return f * MSUN_KG * AU_M / (YEAR_S * YEAR_S); }
    function theName(b) { return ['Sun', 'Moon'].includes(b.name) ? `the ${b.name}` : b.name; }
    const sentenceCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

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
            // (pulled about by others as hard as by what it orbits, as in the three-star scenes: no one
            // orbit, so no period to give, and the number would jump about with its partner)
            const tossed = !pr && !top && p && !mission.def && bodies.length <= SWARM_N && disturbers(b, p).length > 0;
            if (el && !tossed) ecc = el.e < 9.995 ? el.e.toFixed(2) : '>10';
            if (top && !p) {
                tip = 'The heaviest body orbits nothing: it only wobbles round the centre of mass';
            } else if (tossed) {
                tip = `Other bodies pull on it about as hard as ${theName(p)}: it has no one orbit, so no period`;
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
        setTitle(statBox(ui.statForce), pullsTitle(b, pull));   // (and every pull's share: see pullsTitle)
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
        if (mission.def && next > MISSION_SPEED_MAX) { missionNote(`<strong>Up to ${MISSION_SPEED_MAX}×</strong> in a mission. <strong>Skip</strong> is the quick way.`); return; }
        paceZoom.was = 0;
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
        const sim = timeDir * simTime + acc;   // (time gained the way it is running)
        const dReal = (now - pace.t) / 1000, dSim = sim - pace.sim;
        const want = settings.speed * rate() * dReal;
        // Start again after a pause, a new scene, a jump back in time or a long gap (a hidden tab)
        const fresh = paused || timeHeld() || pace.scene !== scene || !(dReal > 0) || dReal > 1 || dSim < 0 || !(want > 0);
        pace.t = now; pace.sim = sim; pace.scene = scene;
        if (fresh) { pace.ratio = 1; pace.behind = false; return; }
        pace.ratio += (Math.min(dSim / want, 1.5) - pace.ratio) * (1 - Math.exp(-dReal / 0.35));
        pace.behind = pace.ratio < (pace.behind ? 0.95 : 0.9);
    }

    // Moving targets are hard to hit, so time waits while a body from the palette is over the canvas and
    // from the moment an arrow's tip is pressed until it is let go (not in a mission, whose clock is its own)
    function timeHeld() {
        if (mission.def) return false;
        if (paletteDrag && paletteDrag.moved && paletteDrag.over) return true;
        if (!drags.size) return false;
        for (const d of drags.values()) if (d.mode === 'aim') return true;
        return false;
    }

    // The note in the canvas's top-left corner: paused, the new speed just after a key changed it, or
    // the speed actually reached when it falls short of the chosen one; and whether time runs backwards
    function timeNotice() {
        const back = timeDir < 0 ? 'Running backwards' : '';
        if (performance.now() < speedFlash) return `${paused ? 'Paused · ' : back ? `${back} · ` : ''}${fmtFactor(settings.speed)}×: ${speedCaption(settings.speed)}`;
        if (paused && mission.def) return null;   // (its console says so, and the clock stops for each burn)
        if (mission.skip) return null;   // (the speed jumps for a moment you asked to pass quickly: nothing to report)
        if (paused) return back ? 'Paused · running backwards' : 'Paused';
        if (timeHeld()) return 'Time waits for you';
        if (pace.behind) return `${bodies.length > SWARM_N ? 'Many bodies' : 'Slowed down'}: running ${back ? 'backwards ' : ''}at ${fmtFactor(pace.ratio * settings.speed)}×`;
        return back || null;
    }

    // Every frame: the achieved speed and the caption (it changes with the scene)
    function updateTimeControls() {
        measurePace();
        const key = `${settings.scene}|${settings.speed}`;
        if (key !== captionKey) { captionKey = key; setText(ui.speedNote, speedCaption(settings.speed)); }
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
        return simTime !== t0;   // (a step back while time runs backwards)
    }

    // [ and ] change the speed; "." steps (pausing first if it is running). Not while typing, nor with
    // Ctrl or Cmd (browser shortcuts). Alt is allowed: on many keyboards [ and ] are typed with AltGr
    // or Option (which on Windows also reports Ctrl).
    function bindTimeControls() {
        if (ui.step) {
            ui.step.addEventListener('click', () => {
                if (paused) stepForward(); else setPaused(true);
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

    // The colours are a radio group: named, one stop of the Tab key (the chosen colour), and the arrow
    // keys choose the next or previous one
    const SWATCH_NAMES = ['Yellow', 'Orange', 'Pink', 'Magenta', 'Lavender', 'Blue', 'Sky blue', 'Teal', 'Sand', 'Grey'];
    function buildSwatches() {
        if (!ui.popColours) return;
        ui.popColours.textContent = '';
        SWATCHES.forEach((c, i) => {
            const s = document.createElement('button');
            s.type = 'button';
            s.className = 'orb-swatch';
            s.style.background = c;
            s.dataset.color = c;
            s.setAttribute('role', 'radio');
            s.setAttribute('aria-label', SWATCH_NAMES[i] || c);
            s.title = SWATCH_NAMES[i] || c;
            s.tabIndex = -1;
            s.addEventListener('click', () => {
                if (!popBody) return;
                popBody.color = c;
                updatePopover(true);
            });
            ui.popColours.appendChild(s);
        });
        ui.popColours.addEventListener('keydown', (e) => {
            const all = Array.from(ui.popColours.querySelectorAll('.orb-swatch')), i = all.indexOf(e.target);
            if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
            const n = all.length, step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            const j = step ? (i + step + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
            if (j < 0) return;
            e.preventDefault();
            all[j].focus();
            all[j].click();
        });
    }

    // The menu opens on the Body tab (in a mission, the probe's on Velocity, where its engine is); a
    // menu already open keeps its tab when another body is chosen
    function openPopover(b, tab) {
        if (!ui.pop || !b) return;
        if (tab) selectTab(tab);
        else if (ui.pop.hidden) selectTab(mission.def && b.id === mission.craftId ? 'vel' : 'body');
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
    // On phones held sideways (the info bar in a column beside the canvas) a sheet down one side of the
    // screen: over the palette, which isn't needed while a body is changed (so play, the readouts and
    // the cards stay in view), or over the info column if the body is on the left; the side is chosen
    // as it opens and kept while it is open.
    const SIDE_SHEET_MQ = '(orientation: landscape) and (min-width: 640px) and (max-height: 540px)';
    function positionPopover(b, opening) {
        const sheet = window.innerWidth < 600 && window.innerHeight > window.innerWidth;
        const side = !sheet && !!window.matchMedia && window.matchMedia(SIDE_SHEET_MQ).matches;
        ui.pop.classList.toggle('is-sheet', sheet);
        if (side) {
            const was = ui.pop.classList.contains('is-side');
            ui.pop.classList.add('is-side');
            ui.pop.style.left = '';
            ui.pop.style.top = '';
            const cr = canvas.getBoundingClientRect(), x = cr.left + sx(b.dx), w = ui.pop.offsetWidth;
            if (opening || !was) {
                // (with the settings open over the palette: on the other side from them, if it can)
                const bc = document.body.classList, settingsOpen = bc.contains('sim-panel-active') && bc.contains('sim-panel-side');
                const rightOk = x < window.innerWidth - w - 16, leftOk = x > w + 16;
                ui.pop.classList.toggle('on-left', settingsOpen ? !rightOk && leftOk : leftOk || (!rightOk && x > window.innerWidth / 2));
            }
            // (the canvas in full view beside it, with the page's header scrolled away)
            if (opening && !document.body.classList.contains('sim-fullscreen-active')) {
                const delta = cr.top - Math.max(0, Math.min(8, window.innerHeight - cr.height));
                if (Math.abs(delta) > 2) window.scrollBy({ top: delta, behavior: 'smooth' });
            }
            return;
        }
        ui.pop.classList.remove('is-side', 'on-left');
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
        // (and clear of the settings, if they are open over the canvas)
        const minX = visL > 0 ? visL + 6 : 6 - cr.left, maxX = visR < viewW ? visR - 6 : window.innerWidth - cr.left - 6;
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
        const sw = Array.from(ui.popColours.querySelectorAll('.orb-swatch')), on = sw.find((s) => s.dataset.color === b.color);
        sw.forEach((s) => {
            s.setAttribute('aria-checked', s === on ? 'true' : 'false');
            s.tabIndex = s === (on || sw[0]) ? 0 : -1;   // (a colour of its own, as a star's: the stop is on the first)
        });
        // Its mass in kg, and how hard it is to leave its surface: sqrt(2GM/R), the speed of light at a
        // black hole's horizon. (Its pull and its orbit are in the info bar and the other tabs.)
        let info = `<strong>Mass:</strong> ${fmtSci(b.m * MSUN_KG, 2)} kg`;
        if (hole) info += '<br><strong>Escape speed at its horizon:</strong> the speed of light';
        else if (b.R > 0.1) {
            const vs = Math.sqrt((2 * G * b.m) / (b.R / AU_KM)) * AUYR_KMS;
            const f = fmtSpeedKms(vs);
            info += `<br><strong>Surface escape speed:</strong> ${f.v} ${f.u}${lightFraction(vs)}`;
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
        ui.popDelete.addEventListener('click', deleteChosen);
        ui.popName.addEventListener('input', () => {
            if (!popBody) return;
            const n = ui.popName.value.trim().slice(0, 18);
            popBody.name = n || popBody.name;
            refreshBodyLists();
            syncEccentricity(true);
        });
        ui.popName.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.popName.blur(); });
        // Dragged, the sliders snap to round values; stepped with the keys they don't (a snap would
        // pull each small step straight back)
        let keyed = false;
        for (const el of [ui.popMass, ui.popRadius, ui.popSpeed]) {
            el.addEventListener('keydown', () => { keyed = true; });
            el.addEventListener('pointerdown', () => { keyed = false; });
        }
        const snapLog = (v, snaps) => {
            if (keyed) return v;
            for (const s of snaps) if (Math.abs(v - Math.log10(s)) < 0.04) return Math.log10(s);
            return v;
        };
        ui.popMass.addEventListener('input', () => {
            const b = popBody;
            if (!b) return;
            popLastInput = performance.now();
            const lg = snapLog(parseFloat(ui.popMass.value), MASS_SNAPS.map((m) => m / MEARTH));
            keepView(() => withStarColour(b, () => { b.m = Math.pow(10, lg) * MEARTH; collapseIfTooHeavy(b); }));
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
            if (sr.p && !keyed) {
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
    });

    const edit = {
        tab: 'body',         // the menu's open tab: body, vel, orbit or pull
        step: 0.01,          // steppers and pushes: a fraction of the value (10%, 1% or 0.1%)
        sense: 1, senseBid: null,   // the way round chosen for a body at rest
        shown: {},           // field -> the text last written into it (a field is applied only if that changed)
        units: {},           // field -> the unit it is shown in, { label, f } (f: internal units per shown unit)
        forceField: null,    // a field to rewrite even though it has focus (just applied or stepped)
        usual: { bid: null, t: 0, sense: 0 },
        engaged: null,       // the arrow keys act on the chosen body: the simulation was last pressed or focused (null: nothing has been yet)
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
        if (missionNudge(b, kind, step)) return;
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
        if (s.screen || !(T > 0) || missionRefuse('orbit', b)) return;
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
        keepOrbitInView(b);
    }

    // New closest and farthest distances (rp <= ra; ra = Infinity: an escaping orbit that keeps its
    // energy). The body stays where it is if the new orbit passes through its distance, still moving
    // outward or inward as it was; otherwise it moves along the line to what it orbits, onto the near or
    // far end. It keeps its way round.
    function setApsides(b, rp, ra) {
        const s = velocityParts(b);
        if (s.screen || !(rp > 0) || !(ra >= rp) || missionRefuse('orbit', b)) return;
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
        keepOrbitInView(b);
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
        if (ax >= 9999.5 && ax < 1e9) return Math.round(x).toLocaleString('en-US');
        if (ax < 1e-3 || ax >= 1e9) return x.toExponential(3);
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

    const MAX_SPEED = 0.99 * C_LIGHT;
    const FIELDS = {
        speed: {
            input: ui.popSpeedIn, unitEl: ui.popSpeedUnit, units: SPEED_UNITS, ok: (v) => v >= 0,
            why: 'Speed needs a number, 0 or more.', max: MAX_SPEED, over: 'Kept below the speed of light.',
            apply: (b, v) => { const s = velocityParts(b); setVelocity(b, v, s.angle, s.sense); },
            step: (b, dir, k) => nudge(b, dir > 0 ? 'faster' : 'slower', k)
        },
        angle: {
            input: ui.popAngleIn, units: ANGLE_UNITS, ok: (v) => isFinite(v),
            why: 'Direction needs a number of degrees.',
            apply: (b, v) => { const s = velocityParts(b); setVelocity(b, s.v, s.screen ? v : clamp(v, -Math.PI / 2, Math.PI / 2), s.sense); },
            // (10, 1 or 0.1 degrees)
            step: (b, dir, k) => FIELDS.angle.apply(b, velocityParts(b).angle + dir * k * 100 * DEG)
        },
        period: {
            input: ui.popPeriodIn, unitEl: ui.popPeriodUnit, units: TIME_UNITS, ok: (v) => v > 0,
            why: 'Period needs a number above 0.', max: 1e9, over: 'Kept to a billion years.',
            apply: (b, v) => setPeriod(b, v),
            step: (b, dir, k) => { const o = orbitOf(b); if (o && o.el.bound) setPeriod(b, o.T * (1 + dir * k)); }
        },
        peri: {
            input: ui.popPeriIn, unitEl: ui.popPeriUnit, units: DIST_UNITS, ok: (v) => v > 0,
            why: 'Distance needs a number above 0.', max: 1e6, over: 'Kept to a million AU.',
            apply: (b, v) => { const o = orbitOf(b); if (o) setApsides(b, v, Math.max(v, o.ra)); },
            step: (b, dir, k) => { const o = orbitOf(b); if (o) FIELDS.peri.apply(b, o.rp * (1 + dir * k)); }
        },
        apo: {
            input: ui.popApoIn, unitEl: ui.popApoUnit, units: DIST_UNITS, ok: (v) => v > 0,
            why: 'Distance needs a number above 0.', max: 1e6, over: 'Kept to a million AU.',
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

    // Apply what was typed in a field, if it changed. Something that can't be used is put back, saying
    // why; something too big is cut down to size.
    function commitField(name) {
        const F = FIELDS[name], input = F.input, b = popBody;
        if (!b || !input || input.value.trim() === (edit.shown[name] || '')) return;
        let v = parseField(input.value, F.units, edit.units[name]);
        if (!(isFinite(v) && F.ok(v))) {
            input.value = edit.shown[name] || '';
            fieldSay(F.why);
            return;
        }
        if (F.max !== undefined && v > F.max) { v = F.max; fieldSay(F.over); }
        edit.forceField = name;
        F.apply(b, v);
        updateEditor(true);
        edit.forceField = null;
    }

    // A word under the menu's fields for a few seconds, when an entry was refused or cut down to size
    function fieldSay(text) {
        const el = byId('popFieldWhy');
        if (!el) return;
        el.textContent = text;
        el.hidden = false;
        clearTimeout(edit.whyTimer);
        edit.whyTimer = setTimeout(() => { el.hidden = true; el.textContent = ''; }, 5000);
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
        setText(ui.popAngleNote, s.screen ? '0° points right, 90° up.' : '0° is sideways, + outward, − inward.');
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
            shape = o.el.bound ? `Average distance a = ${d.v} ${d.u}` : 'Escaping. Set a farthest distance to make it orbit.';
        } else {
            showField('period', NaN, periodUnit(scene.Tref));
            for (const n of ['peri', 'apo']) showField(n, NaN, distUnit(scene.units === 'km' ? 0 : 1));
            ui.popPeriodIn.placeholder = ui.popApoIn.placeholder = '';
            // (the heavier of a pair that orbit each other: their orbit is set from the lighter one)
            const partner = b.primary && b.primary.primary === b ? b.primary : null;
            shape = alone ? 'Nothing to orbit.'
                : partner ? `${b.name} and ${partner.name} orbit each other: set it from ${partner.name}'s menu.`
                    : `${b.name} is the heaviest: choose a body that orbits it.`;
        }
        setText(ui.popOrbitShape, shape);
        // (an escaping orbit's period and farthest distance can be typed, not stepped)
        for (const el of edit.orbitEls) el.disabled = !o || (!o.el.bound && el.tagName === 'BUTTON' && el.dataset.dir !== undefined && !el.closest('[data-field="peri"]'));
        missionLockMenu(b);
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
        // (the steps don't apply to the Body and Gravity tabs)
        if (ui.popStep) ui.popStep.classList.toggle('is-idle', name === 'body' || name === 'pull');
        // Each tab is as tall as it needs: beside a body, a taller one keeps the menu's top where it was
        // unless that would take it past the bottom
        if (popBody && ui.pop && !ui.pop.hidden && !ui.pop.classList.contains('is-sheet') && !ui.pop.classList.contains('is-side')) {
            const cr = canvas.getBoundingClientRect(), wr = ui.pop.parentElement.getBoundingClientRect();
            const oy = cr.top - wr.top, ph = ui.pop.offsetHeight, top = parseFloat(ui.pop.style.top) - oy;
            const fits = ph <= cr.height - 12;
            const minY = fits ? 6 : 6 - cr.top, maxY = fits ? cr.height - 6 : window.innerHeight - cr.top - 6;
            if (isFinite(top)) ui.pop.style.top = `${Math.round(oy + clamp(top, minY, Math.max(minY, maxY - ph)))}px`;
        }
    }

    function openEditor(b, tab, focus) {
        if (!b) return;
        openPopover(b, tab);
        if (focus) {
            const t = ui.popTabs.find((q) => q.getAttribute('aria-selected') === 'true');
            if (t) t.focus({ preventScroll: true });
        }
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
        return !!(t.closest && t.closest('[role="tablist"], [role="radiogroup"], [role="tree"], .orb-palette'));
    }

    function onEditorKey(e) {
        const t = e.target;
        if (e.key === 'Escape') {
            // In a field with something typed: put it back (a second Escape closes the menu)
            const name = t && t.classList && t.classList.contains('orb-spin-input') ? Object.keys(FIELDS).find((n) => FIELDS[n].input === t) : null;
            if (name && t.value.trim() !== (edit.shown[name] || '')) {
                t.value = edit.shown[name] || '';
                e.stopImmediatePropagation();
                e.preventDefault();
            }
            return;
        }
        const kind = ARROW_PUSH[e.key];
        if (!kind || e.ctrlKey || e.metaKey || takesArrows(t)) return;
        // (on a page just opened they work too, as Space and B do, while the simulation is in sight)
        if (!popBody && !edit.engaged && !(edit.engaged === null && canvasInView) && !document.body.classList.contains('sim-fullscreen-active')) return;
        if (missionKey(e, kind)) return;
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
    // times a second at most); like every prediction made while drawing, it is worked out PREDICT_MS a
    // frame in the background, and the last whole path is shown meanwhile (see predictPath).
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
        // The body's own velocity, given to predictPath as an aim (which it reads) for this call only. It
        // decides when to start a path again (at once after an edit, else at most every
        // PREDICT_EVERY_MS) and hands back the last whole one, which drawPredictedPath keeps with the body.
        const fv = frameVelocity();
        b.aim = { vx: b.vx - fv.x, vy: b.vy - fv.y, k: 1, ref: null, frameV: fv, snap: null };
        if (edit.previewDirty) pred.force = true;
        let pp;
        try { pp = predictPath(b, null); } finally { b.aim = null; }
        const P = edit.preview, same = !!(P && P.src === pp && P.bid === b.id);
        edit.preview = {
            src: pp, bid: b.id, pts: pp.pts, ts: pp.ts, t0: pp.t0, loop: pp.loop, end: pp.end, refId: pp.refId, from: pp.from, blend0: pp.blend0,
            t: same ? P.t : now, cost: same ? P.cost : performance.now() - now, paused
        };
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
            input.addEventListener('blur', () => commitField(name));
            input.addEventListener('focus', () => input.select());
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    commitField(name);
                    if (coarse()) input.blur(); else input.select();
                } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    commitField(name);
                    stepField(name, e.key === 'ArrowUp' ? 1 : -1, e);
                }
            });
        }
        ui.pop.querySelectorAll('.orb-spin').forEach((spin) => {
            const name = spin.dataset.field;
            spin.querySelectorAll('.orb-spin-btn').forEach((btn) => {
                const dir = parseFloat(btn.dataset.dir);
                holdRepeat(btn, (e) => { commitField(name); stepField(name, dir, e); });
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

    // In the column beside the canvas the usual kinds show, and the rest wait behind "More bodies"
    // (open again next time if it was left open); on narrow screens, and on a phone held sideways, all
    // the chips flow on in one set.
    const PALETTE_STORE = 'orbitsPaletteMore';
    function buildPalette() {
        if (!ui.palette) return;
        ui.palette.textContent = '';
        PALETTE.forEach((kinds, i) => {
            const chips = document.createElement('div');
            chips.className = 'orb-group-chips';
            for (const kind of kinds) chips.appendChild(paletteChip(kind));
            ui.palette.appendChild(chips);
            if (i) return;
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'orb-palette-more';
            more.textContent = 'More bodies';
            const show = (on) => { ui.palette.classList.toggle('is-open', on); more.setAttribute('aria-expanded', on ? 'true' : 'false'); };
            more.addEventListener('click', () => {
                const on = !ui.palette.classList.contains('is-open');
                show(on);
                storeSet(PALETTE_STORE, on ? '1' : '');
            });
            show(storeGet(PALETTE_STORE) === '1');
            ui.palette.appendChild(more);
        });
        paletteRove(ui.palette.querySelector('.orb-chip'));
        if (!ui.palette.dataset.keys) {
            ui.palette.dataset.keys = '1';
            ui.palette.addEventListener('focusin', (e) => { const c = e.target.closest && e.target.closest('.orb-chip'); if (c) paletteRove(c); });
            ui.palette.addEventListener('keydown', onPaletteKey);
            ui.palette.addEventListener('scroll', paletteEdges, { passive: true });
            if (typeof ResizeObserver !== 'undefined') new ResizeObserver(paletteEdges).observe(ui.palette);
            else window.addEventListener('resize', paletteEdges);
        }
        paletteEdges();
    }

    // On a phone held upright the chips are one row that scrolls sideways (see orbits_styles.css): it
    // fades at an end only while there are more chips beyond it
    function paletteEdges() {
        const p = ui.palette;
        if (!p) return;
        const max = p.scrollWidth - p.clientWidth;
        p.classList.toggle('at-start', p.scrollLeft <= 2);
        p.classList.toggle('at-end', p.scrollLeft >= max - 2);
    }

    // The keyboard: the palette is one stop of the Tab key (as in a toolbar), not fifteen. The arrow
    // keys move between its chips (up and down to the nearest chip in the row above or below), Home and
    // End go to the first and last, and the chip last used keeps the stop.
    function paletteRove(to) {
        if (!ui.palette || !to) return;
        for (const c of ui.palette.querySelectorAll('.orb-chip')) c.tabIndex = c === to ? 0 : -1;
    }

    function onPaletteKey(e) {
        const c = e.target.closest && e.target.closest('.orb-chip');
        if (!c || e.altKey || e.ctrlKey || e.metaKey) return;
        const list = Array.from(ui.palette.querySelectorAll('.orb-chip')).filter((q) => !q.disabled && q.offsetParent);
        const i = list.indexOf(c);
        if (i < 0) return;
        let to = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') to = list[clamp(i + (e.key === 'ArrowRight' ? 1 : -1), 0, list.length - 1)];
        else if (e.key === 'Home' || e.key === 'End') to = list[e.key === 'Home' ? 0 : list.length - 1];
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const down = e.key === 'ArrowDown', r = c.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
            let best = Infinity;
            for (const q of list) {
                const s = q.getBoundingClientRect(), dy = s.top + s.height / 2 - y;
                if (down ? dy < 4 : dy > -4) continue;
                const cost = Math.abs(dy) * 4 + Math.abs(s.left + s.width / 2 - x);
                if (cost < best) { best = cost; to = q; }
            }
            if (!to) to = c;
        } else return;
        e.preventDefault();
        if (to !== c) { to.focus(); to.scrollIntoView({ block: 'nearest' }); }
    }

    function paletteChip(kind) {
        const k = KINDS[kind];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'orb-chip';
        btn.dataset.kind = kind;
        const label = kind === 'custom' ? 'Custom' : k.name;
        btn.dataset.title = kind === 'custom' ? 'Your own body: drop it, then set its mass, speed and colour'
            : kind === 'moon' ? `${k.name}, ${k.info} (${fmtMass(k.m)}). Drop it on a planet, or click for a moon of the chosen planet`
                : `${k.name}, ${k.info} (${fmtMass(k.m)})`;
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

    // Is this touch's move from where it began heading for the canvas (the chip beside it, or below it)?
    function towardsCanvas(d, e) {
        const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
        const c = canvas.getBoundingClientRect();
        if (d.y0 < c.bottom && d.y0 > c.top) return Math.abs(dx) > Math.abs(dy) && dx * (c.left + c.width / 2 - d.x0) > 0;
        return Math.abs(dy) >= Math.abs(dx) && dy * (c.top + c.height / 2 - d.y0) > 0;
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
            // (by touch, only a move towards the canvas carries the body out: any other is a swipe, for
            // the chips or the page to scroll by, as they do by themselves: see touch-action in the styles)
            if (e.pointerType !== 'mouse' && !towardsCanvas(d, e)) return;
            d.moved = true;
            d.btn.classList.add('is-dragging');
            if (!ghostEl) {
                ghostEl = document.createElement('div');
                ghostEl.className = 'orb-drag-ghost';
                document.body.appendChild(ghostEl);
            }
            const k = KINDS[d.kind];
            ghostEl.style.background = d.kind === 'custom' ? '#ae85ca' : k.color;
        }
        if (!d.moved) return;
        traceDrag(d, e.clientX, e.clientY, e);   // (for a throw)
        const r = canvas.getBoundingClientRect();
        d.over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        d.cx = e.clientX - r.left; d.cy = e.clientY - r.top;
        ghostEl.style.display = d.over ? 'none' : 'block';
        ghostEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
        dropHint(d);   // (the drag layer, until it is let go)
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
            chipThrow = d;   // (thrown as it is let go, if bodies are thrown)
            const k = KINDS[d.kind] || KINDS.custom, host = moonHost(d.cx, d.cy, k.m, k.R, null);
            const w = unturnPoint(wx(d.cx), wy(d.cy));   // (from the drawn view to the world)
            const at = host ? moonSpot(host, w.x, w.y, bodies.filter((q) => q.primary === host && q.bound).length) : w;
            const b = addBody(d.kind, at.x, at.y);
            chipThrow = null;
            if (b && host) moonNote(b);
            if (b && d.kind === 'custom') openPopover(b);
        }
        dropHost = null;
        clearHint('drag');
    }

    function onChipCancel(e) {
        const d = paletteDrag;
        if (!d || e.pointerId !== d.id) return;
        paletteDrag = null;
        d.btn.classList.remove('is-dragging');
        if (ghostEl) ghostEl.style.display = 'none';
        dropHost = null;
        clearHint('drag');
    }

    // Escape, with a body on its way from the palette: it goes back, and time carries on. The press that
    // is still down lets go of nothing (its click, whenever it comes, adds nothing either).
    function escapeChipDrag() {
        const d = paletteDrag;
        if (!d || !d.moved) return false;
        d.btn.dataset.dragged = '1';
        d.btn.addEventListener('lostpointercapture', () => setTimeout(() => { d.btn.dataset.dragged = ''; }, 400), { once: true });
        onChipCancel({ pointerId: d.id });
        showHint('note', '<strong>Cancelled:</strong> nothing added.', { ms: 3000 });
        return true;
    }

    // ------------------------------------------------------------------
    // Hint line under the palette
    // ------------------------------------------------------------------
    let lastPointerType = window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 'touch' : 'mouse';
    const coarse = () => lastPointerType !== 'mouse';
    let hintKey = '';
    let hintPressed = false;   // a press on one of the line's own buttons: it stays as it is until that is over

    // One message at a time, by priority. Each layer holds { html, tag }; html may be a function, read
    // again whenever the line is refreshed, so a note that names the chosen body follows the choice.
    //   drag         what an active drag or aim will do, until it ends
    //   missionNote  in a mission: a burn, a refusal, an undone burn, the result (a few seconds)
    //   (mission)    the mission's own guidance
    //   note         fresh feedback from a switch or an action (a few seconds)
    //   tip          the scene's tip, until the first press on the canvas or the palette
    //   (offer)      "Carry on where you left off", for a while after the page opens
    //   (help)       the usual help
    const hints = { drag: null, missionNote: null, note: null, tip: null, open: false };
    const hintTimers = {};

    function showHint(layer, html, opts) {
        const o = opts || {};
        clearTimeout(hintTimers[layer]);
        const h = html ? { html, tag: o.tag || '' } : null;
        hints[layer] = h;
        if (h && o.ms) hintTimers[layer] = setTimeout(() => { if (hints[layer] === h) { hints[layer] = null; refreshHint(); } }, o.ms);
        refreshHint();
    }

    // Take a layer down (only if it still holds that tag, when one is given)
    function clearHint(layer, tag) {
        const h = hints[layer];
        if (!h || (tag && h.tag !== tag)) return;
        clearTimeout(hintTimers[layer]);
        hints[layer] = null;
        refreshHint();
    }

    const hintHtml = (h) => (h ? (typeof h.html === 'function' ? h.html() : h.html) : '');

    function usualHint() {
        const v = settings.velocities;
        let h;
        if (coarse()) {
            h = v ? '<strong>Drag</strong> a body into space. <strong>Tap</strong> one to aim or Edit it.'
                : '<strong>Drag</strong> a body into space. <strong>Tap</strong> one to Edit it.';
        } else {
            h = `<strong>Drag</strong> a body into space.${v ? ' Drag a <strong>teal tip</strong> to aim.' : ''} <span class="orb-hint-links"><button type="button" class="orb-hint-btn orb-hint-help" title="Keys and gestures (?)">Help</button>`;
        }
        h += ` <button type="button" class="orb-hint-btn orb-hint-missions" title="Fly a probe to a goal on a fuel budget (M)">Missions</button>${coarse() ? '' : '</span>'}`;
        return h;
    }

    // "A moon forming": how far it has got, in place of the usual help
    function moonProgress() {
        const top = heaviest();
        let big = 0, n = 0;
        for (const b of bodies) if (b !== top) { n++; if (b.m > big) big = b.m; }
        const pct = (100 * big) / KINDS.moon.m;
        return `Moonlets collide and stick. Biggest: <strong>${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%</strong> of the Moon, <strong>${n}</strong> pieces left.`;
    }

    // Write the line from the top layer that has something to say
    function refreshHint() {
        if (!ui.hint || hintPressed) return;
        const h = hintHtml(hints.drag) || (mission.def ? hintHtml(hints.missionNote) || missionHint() : '')
            || hintHtml(hints.note) || hintHtml(hints.tip) || (scene && scene.progress ? moonProgress() : '') || carryOnHint() || usualHint();
        if (h === hintKey) return;
        hintKey = h;
        ui.hint.innerHTML = h;
        // (a long message, cut short on a phone, opens out when tapped; a new one starts closed)
        if (hints.open) {
            hints.open = false;
            ui.hint.classList.remove('is-open', 'is-spilling');
            ui.hint.style.marginBottom = '';
        }
        hintClampCheck();
    }

    // The older way in: setHint() refreshes, html a note
    function setHint(kind, html) {
        if (html) showHint('note', html, { ms: 6000 });
        else refreshHint();
    }

    // The body that one of radius R km at (x, y) would touch, and so merge with
    function dropTouches(x, y, R) {
        if (!settings.merge) return null;
        for (const q of bodies) if (Math.hypot(q.x - x, q.y - y) < (q.R + R) / AU_KM) return q;
        return null;
    }

    // A drag from the palette: what a drop just here would do
    function dropHint(d) {
        const k = KINDS[d.kind] || KINDS.custom;
        dropHost = d.over ? moonHost(d.cx, d.cy, k.m, k.R, null) : null;
        let h = settings.placement === 'circular' ? '<strong>Drop it in space</strong>, or on a planet to make it a moon.' : '<strong>Drop it in space.</strong>';
        if (dropHost) h = `<strong>Drop it on ${escapeHtml(theName(dropHost))}</strong> to make it a moon.`;
        else if (d.over) {
            const w = unturnPoint(wx(d.cx), wy(d.cy)), hit = dropTouches(w.x, w.y, k.R);
            const p = settings.placement === 'circular' ? placementPrimary(w.x, w.y, k.m, null) : null;
            if (hit) h = `<strong>Drop it here</strong> and it merges with ${escapeHtml(theName(hit))}.`;
            else if (p) h = `<strong>Drop it here</strong> to orbit ${escapeHtml(theName(p))}.`;
        }
        showHint('drag', settings.placement === 'throw' ? `${h} <strong>Flick</strong> it as you let go to throw it.` : h);
    }

    // On a phone the line shows three lines at most: one cut short says so (…) and opens out when tapped
    let hintClampQueued = false;
    function hintClampCheck() {
        if (!ui.hint || hintClampQueued) return;
        hintClampQueued = true;
        requestAnimationFrame(() => {
            hintClampQueued = false;
            const cut = !hints.open && ui.hint.offsetParent !== null && ui.hint.scrollHeight > ui.hint.clientHeight + 2;
            ui.hint.classList.toggle('is-cut', cut);
            const opens = cut || hints.open;
            if (opens) {
                ui.hint.setAttribute('role', 'button');
                ui.hint.tabIndex = 0;
                ui.hint.setAttribute('aria-expanded', hints.open ? 'true' : 'false');
                ui.hint.title = hints.open ? 'Show less' : 'Show all of it';
            } else if (ui.hint.hasAttribute('role')) {
                ['role', 'tabindex', 'aria-expanded', 'title'].forEach((a) => ui.hint.removeAttribute(a));
            }
        });
    }

    // Opened, the line spills over what is below it rather than pushing it down (so the canvas keeps
    // its size), except in the tool column beside the canvas, which has room for it to grow
    function toggleHintOpen() {
        if (!ui.hint || !(hints.open || ui.hint.classList.contains('is-cut'))) return false;
        hints.open = !hints.open;
        const h0 = ui.hint.offsetHeight;
        const column = window.matchMedia && window.matchMedia('(orientation: landscape) and (min-width: 640px)').matches && !(sideways && sideways.matches);
        ui.hint.style.marginBottom = '';
        ui.hint.classList.toggle('is-open', hints.open);
        ui.hint.classList.toggle('is-spilling', hints.open && !column);
        const spill = hints.open && !column ? ui.hint.offsetHeight - h0 : 0;
        if (spill > 0) ui.hint.style.marginBottom = `${-spill}px`;
        else ui.hint.classList.remove('is-spilling');
        hintClampCheck();
        return true;
    }

    function bindHint() {
        if (!ui.hint) return;
        ui.hint.addEventListener('click', (e) => {
            if (e.target.closest && e.target.closest('button')) return;   // (the carry-on offer's own buttons)
            toggleHintOpen();
        });
        ui.hint.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target === ui.hint && toggleHintOpen()) { e.preventDefault(); e.stopPropagation(); }
        });
        window.addEventListener('resize', hintClampCheck);
        if (sideways) {
            if (sideways.addEventListener) sideways.addEventListener('change', placeHint); else if (sideways.addListener) sideways.addListener(placeHint);
            placeHint();
        }
    }

    // Phones held sideways: the tool column beside the canvas has no room for the hint line, so it goes
    // under the canvas (between the palette and the info bar: see orbits_styles.css), and in a mission
    // the goal and how it is going, over it
    const sideways = window.matchMedia ? window.matchMedia('(orientation: landscape) and (min-width: 640px) and (max-height: 540px)') : null;
    function placeHint() {
        const toolbar = byId('orbToolbar'), wrap = canvas.closest('.sim-canvas-wrapper');
        if (!ui.hint || !toolbar || !wrap) return;
        if (sideways.matches) { if (ui.hint.parentElement === toolbar) wrap.after(ui.hint); }
        else if (ui.hint.parentElement !== toolbar) toolbar.appendChild(ui.hint);
        const E = ui.mc;
        if (E) {
            if (sideways.matches && mission.def) { if (E.goal.parentElement === E.box) wrap.after(E.goal, E.status); }
            else if (E.goal.parentElement !== E.box) E.head.after(E.goal, E.status);
        }
        hintClampCheck();
    }

    // Turning a phone mid-session. Held sideways, the simulation fills the screen once the page's
    // header has scrolled away (the layout fits it to the screen's height without the header); upright,
    // it fits with the header. So if the simulation was in view as the phone turned, the page scrolls
    // to where it fits, rather than leaving the header in view and the info column cut off below.
    function bindTurn() {
        const dc = canvas.closest('.simulation-display-container');
        // (held sideways as the page opens: the simulation fills the screen straight away, under the header,
        // with the small margin that opening the settings would otherwise scroll the page to make)
        if (sideways && sideways.matches && dc && !window.scrollY) window.addEventListener('load', () => { if (!window.scrollY) window.scrollTo({ top: Math.round(dc.getBoundingClientRect().top) - 8 }); }, { once: true });
        if (!sideways || !dc || typeof IntersectionObserver === 'undefined' || !window.matchMedia('(pointer: coarse)').matches) return;
        let inView = false;
        new IntersectionObserver((es) => { inView = es[es.length - 1].isIntersecting; }, { threshold: 0.3 }).observe(dc);
        const onTurn = () => {
            if (!inView || document.body.classList.contains('sim-fullscreen-active')) return;
            // (once the layout has settled at the new size)
            // (with the body's menu open, as the menu places the page when it opens)
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (popBody && !ui.pop.hidden) { positionPopover(popBody, true); return; }
                const top = sideways.matches ? dc.getBoundingClientRect().top + window.scrollY - 8 : 0;
                window.scrollTo({ top: Math.max(0, Math.round(top)) });
            }));
        };
        if (sideways.addEventListener) sideways.addEventListener('change', onTurn); else if (sideways.addListener) sideways.addListener(onTurn);
    }

    function dragHint(d) {
        const b = d.body;
        if (!b) return;
        const pr = predictLaunch(b);
        if (d.mode === 'move') {
            dropHost = moonHost(sx(b.dx), sy(b.dy), b.m, b.R, b);
            if (dropHost) { showHint('drag', `<strong>Drop it on ${escapeHtml(theName(dropHost))}</strong> to make it a moon.`); return; }
            const p = pr && pr.p;
            const where = p ? theName(p) : 'the others';
            const how = settings.placement === 'circular' ? `starts on a circular orbit around ${escapeHtml(where)}`
                : settings.placement === 'rest' ? 'starts at rest in this view' : settings.placement === 'throw' ? throwHint(d) : 'keeps its velocity';
            showHint('drag', `<strong>Let go:</strong> it ${how}.`);
        } else if (b.aim && b.aim.burn) {
            showHint('drag', burnHint(b, d));
        } else if (pr && pr.p.m < b.m) {
            // The heaviest body orbits nothing: just its speed in this view
            const L = frameId !== null && frameId !== b.id ? bodyById(frameId) : null;
            const av = aimedVelocity(b), v = fmtSpeedKms(Math.hypot(av.x - (L ? L.vx : totals(bodies).vx), av.y - (L ? L.vy : totals(bodies).vy)) * AUYR_KMS);
            showHint('drag', `<strong>${v.v} ${v.u}</strong> relative to ${L ? escapeHtml(theName(L)) : 'the centre of mass'}.`);
        } else if (pr) {
            const kms = (v) => fmtSpeedKms(v * AUYR_KMS);
            const v = kms(pr.el.v), snap = b.aim && b.aim.snap;
            const fate = snap === 'circular' ? 'circular speed, a circle'
                : snap === 'escape' ? 'escape speed, so it only just gets away'
                    : pr.el.bound ? (pr.el.e < 0.01 ? 'a circle' : `an ellipse, e = ${pr.el.e.toFixed(2)}`) : `it escapes (e = ${pr.el.e.toFixed(2)})`;
            let h = `<strong>${v.v} ${v.u}</strong> relative to ${escapeHtml(theName(pr.p))}: ${fate}.`;
            // (on a touch screen, fine control comes from holding the tip still before dragging it)
            const fineTouch = coarse() && aimFineTouch(d);
            if (!snap && !fineTouch) h += ` Circular ${kms(pr.vc).v}, escape ${kms(pr.ve).v} ${kms(pr.ve).u}.`;
            if (!coarse()) h += d.fine ? ' <strong>Fine control.</strong>' : ' <strong>Shift:</strong> finer.';
            else if (fineTouch) h += ' <strong>Fine control:</strong> a tenth of your finger\'s move.';
            showHint('drag', h);
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
    let lastTap = { t: 0, x: 0, y: 0, id: null, quick: false };
    const TAP_MS = 250;        // a press longer than this isn't a tap (for double-clicks and double-taps)
    let longPressTimer = 0;
    // An arrow's tip is grabbed within this many px of it (the arrow is the handle: only the chosen body's
    // tip has a small ring), and failing anything closer, the arrow from a little farther off (see nearArrow)
    const GRAB_MOUSE = 14, GRAB_TOUCH = 24;
    const NEAR_MOUSE = 24, NEAR_TOUCH = 30;
    const HAND_LAG_S = 0.12;   // by the time a hand has pressed, a moving target has moved on this long
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
    // ...or the tip of another body's arrow (long enough to tell apart from the body; not a swarm's dot or
    // a piece, whose arrows aren't drawn unless it is the chosen body)
    function onArrowTip(x, y, tol) {
        if (!settings.velocities || bodies.length < 2) return null;
        let best = null, bestD = tol;
        for (const b of bodies) {
            if (b.held || b.id === selectedId || b.grp || b.minor || arrowsBusy) continue;
            const tip = velocityTip(b);
            if (tip.len < 14) continue;
            const dd = Math.hypot(tip.x - x, tip.y - y);
            if (dd < bestD) { bestD = dd; best = b; }
        }
        return best;
    }

    // How far from segment (x0, y0)-(x1, y1) a point is
    function distToSegment(x, y, x0, y0, x1, y1) {
        const ex = x1 - x0, ey = y1 - y0, ee = ex * ex + ey * ey;
        const s = ee > 0 ? clamp(((x - x0) * ex + (y - y0) * ey) / ee, 0, 1) : 0;
        return Math.hypot(x - x0 - s * ex, y - y0 - s * ey);
    }

    // Where a body was on the screen a hand's reaction ago, as an offset in px (at most 60: much faster
    // than that nobody is aiming at it). Nothing while time stands still.
    function handLag(vx, vy) {
        if (paused || timeHeld()) return { x: 0, y: 0 };
        const k = -timeDir * settings.speed * rate() * HAND_LAG_S * scale;
        const ox = vx * k, oy = -vy * k, n = Math.hypot(ox, oy);
        return n > 60 ? { x: (ox * 60) / n, y: (oy * 60) / n } : { x: ox, y: oy };
    }

    // The velocity arrow a press at (x, y) means, if it isn't right on a tip or a body: the nearest whose
    // shaft is under it, or whose tip is close to it now or was a moment ago
    function nearArrow(x, y, shaft, tip) {
        if (!settings.velocities || bodies.length < 2 || mission.def) return null;
        const fv = frameVelocity();
        let best = null, bestD = Infinity;
        for (const b of bodies) {
            if (b.held || ((b.grp || b.minor || arrowsBusy) && b.id !== selectedId)) continue;
            const t = velocityTip(b, fv);
            if (t.len < 14) continue;
            const bx = sx(b.dx), by = sy(b.dy), r = drawRadius(b), n = Math.hypot(t.x - bx, t.y - by) || 1;
            const lag = handLag(t.vx, t.vy);
            const ds = distToSegment(x, y, bx + ((t.x - bx) / n) * r, by + ((t.y - by) / n) * r, t.x, t.y);
            const dt = distToSegment(x, y, t.x, t.y, t.x + lag.x, t.y + lag.y);
            const d = Math.min(ds, dt);
            if ((ds <= shaft || dt <= tip) && d < bestD) { bestD = d; best = b; }
        }
        return best;
    }

    // A named body close to a press at (x, y), now or a moment ago
    function bodyNear(x, y, tol) {
        const fv = frameVelocity();
        let best = null, bestD = tol;
        for (const b of bodies) {
            if (b.minor || b.grp || mission.def) continue;
            const bx = sx(b.dx), by = sy(b.dy), v = turn.on || turn.phi ? viewVelocity(b, fv) : { x: b.vx - fv.x, y: b.vy - fv.y }, lag = handLag(v.x, v.y);
            const d = distToSegment(x, y, bx, by, bx + lag.x, by + lag.y) - drawRadius(b);
            if (d < bestD) { bestD = d; best = b; }
        }
        return best;
    }

    // The pink arrow under a press at (x, y)? They show a pull, and can't be dragged
    function onForceArrow(x, y, tol) {
        if (!settings.forces) return null;
        for (const b of bodies) {
            const Fm = Math.hypot(b.fx, b.fy);
            if (!(Fm > 0) || b.grp || b.minor || (arrowsBusy && b.id !== selectedId)) continue;
            const L = forceLength(Fm), bx = sx(b.dx), by = sy(b.dy), r = drawRadius(b);
            const ux = (turn.c * b.fx - turn.s * b.fy) / Fm, uy = -(turn.s * b.fx + turn.c * b.fy) / Fm;
            if (L >= 3 && distToSegment(x, y, bx + ux * r, by + uy * r, bx + ux * (r + L), by + uy * (r + L)) <= tol) return b;
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Aiming a velocity. The arrow tip follows the pointer (at the arrows' zoom-free scale, so a pixel
    // is the same speed at any zoom); Shift makes it ten times finer. Near the exact circular or escape
    // speed relative to the body it orbits, it snaps to it. If that body moves fast through the view
    // (a moon seen from the star) or the arrow would be tiny, the velocity is aimed relative to that body
    // instead, with the circular speed as the arrow's unit.
    //   In a mission the probe's arrow aims a burn instead: the pointer drags out the change of velocity
    // (drawn as its own arrow, see drawBurn) at a scale where the whole fuel budget is MISSION_TANK_PX of
    // drag, whatever the mission. At the arrow's own scale a pixel is about half a km/s, so a twitch would
    // spend the tank; this way a Hohmann burn is a drag of a few centimetres, and Shift is ten times finer.
    // ------------------------------------------------------------------
    const FINE = 0.1;
    const SNAP_PX = 6;
    const MISSION_TANK_PX = 200;

    // px of drag per AU/yr of burn for the mission's probe (0: not a mission's probe)
    function burnScale(b) {
        if (!mission.def || b.id !== mission.craftId || !(mission.def.budget > 0)) return 0;
        return (MISSION_TANK_PX * sizeScale) / (mission.def.budget / AUYR_KMS);
    }

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
        // Keep the grabbed point on the arrow (wherever on it, or near it, the press was). A body at rest has no arrow: it is grabbed just off the
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
        const bk = burnScale(b);
        if (bk) b.aim.burn = { k: bk, vx: b.aim.vx, vy: b.aim.vy, from: null };
    }

    // A mission's burn: the velocity as grabbed plus the pointer's movement at the burn's scale (a tenth
    // of it while Shift is held, from where Shift went down or up, so nothing jumps)
    function moveBurn(d, pt, shift) {
        const b = d.body, a = b.aim, B = a.burn, fine = !!shift;
        if (!B.from) B.from = { x: d.start.x, y: d.start.y, vx: B.vx, vy: B.vy, fine };
        else if (B.from.fine !== fine) B.from = { x: pt.x, y: pt.y, vx: a.vx, vy: a.vy, fine };
        const s = (fine ? FINE : 1) / B.k;
        a.vx = B.from.vx + (pt.x - B.from.x) * s;
        a.vy = B.from.vy - (pt.y - B.from.y) * s;
        a.snap = null;
        if (!fine) snapAim(b);
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
        if (a.burn) { moveBurn(d, pt, shift); return; }
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
        const tol = SNAP_PX / (a.burn ? a.burn.k : a.k);   // (a mission's burn: px of the burn's own arrow)
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
        // (a rotating frame moves with both of its pair, and freezes its angle too). It carries on at the
        // centre of mass's velocity, so nothing else slides if the whole system is drifting; and a glide
        // of the view under way stops here: the view stays still while a body is held.
        if (!freeze && (frameId === null || frameId === b.id || turnUses(b))) {
            const c = totals(bodies);
            freeze = { x: F.x, y: F.y, phi: turn.phi, vx: c.vx, vy: c.vy, t: simTime + lag };
        }
        view.anim = null;
        // (the way it goes round now, for a drop on a circular orbit: see heldSense)
        const p0 = placementPrimary(b.x, b.y, b.m, b);
        d.sense = p0 ? { pid: p0.id, s: senseAround(b, p0) } : null;
        b.held = { offX: b.dx - F.x, offY: b.dy - F.y };
        d.frameV = frameVelocity(b.x, b.y);
        applyHolds();
        updateDrawnPositions();
    }

    function endHold(d, apply) {
        const b = d.body;
        if (!b) return;
        updateDrawnPositions();
        const burn = missionBegin();
        if (apply) {
            if (d.mode === 'aim' && b.aim) {
                if (b.aim.snap) snapAim(b);   // exact, even if the body it orbits has moved on since
                const v = aimedVelocity(b);
                b.vx = v.x; b.vy = v.y;
                resetTracking(b);
                k2.bid = null;
            } else if (d.mode === 'move' && d.moved) {
                const host = moonHost(sx(b.dx), sy(b.dy), b.m, b.R, b);
                if (host) { const at = moonSpot(host, b.x, b.y, bodies.filter((q) => q.primary === host && q.bound).length); b.x = at.x; b.y = at.y; }
                launch(b, false, d);
            }
        }
        b.aim = null;
        b.held = null;
        missionEnd(burn);   // (missions: an aimed arrow is a burn)
        if (d.mode === 'move' && d.moved) clearTrail(b);
        if ((frameId === b.id || turnUses(b)) && d.moved) clearAllTrails();
        forcesDirty = true;
        const stillHeld = bodies.some((c) => c.held);
        if (freeze && !stillHeld) {
            // Let go: the frame follows its origin again with nothing on the screen moving (the body you
            // view from stays where it was dropped, rather than the view gliding to put it back in the
            // middle; a rotating frame keeps its pair's line where it now is on the screen)
            const fz = { x: F.x, y: F.y, phi: freeze.phi };   // (the frozen origin now)
            freeze = null;
            updateDrawnPositions();
            keepScreen(fz, true);
        }
        computeForces();
        computePrimaries();
        syncEccentricity(true);
        clearHint('drag');
        clearHint('tip');
        if (dropHost && d.mode === 'move' && apply) moonNote(b);
        dropHost = null;
        endGesture(d.mode === 'move' || apply);
    }

    function endAllDrags() {
        for (const d of drags.values()) if (d.body && d.body.held) { d.body.held = null; d.body.aim = null; }
        drags.clear();
        pinch = null;
        freeze = null;
        dropHost = null;
        if (hints.drag && !paletteDrag) { hints.drag = null; refreshHint(); }
    }

    // ------------------------------------------------------------------
    // Running time backwards
    //   Newton's laws don't mind which way time runs: reverse every velocity and a planet goes back
    //   round its orbit. So running backwards is just taking the steps with negative time, and the
    //   clock counts down. Kick-drift-kick leapfrog, its Yoshida composition and the Kepler drift of a
    //   close pair are all symmetric in time for a given step: a step forward and the same step back
    //   land exactly where they began. But the adaptive step is chosen from where the bodies are at the
    //   start of each step (the other end, going back), and close pairs start and end with hysteresis.
    //   So every step's size and close pairs are logged (a number and an index each, the newest
    //   STEP_LOG kept: 1.5 MB at most), and going back replays them in reverse order. The motion then
    //   retraces its path to within rounding errors: back at the start, a few parts in 10^12 after a
    //   hundred orbits (each step's rounding, about 10^-16, spread round the orbit as a planet that is
    //   a hair faster drifts ahead). Without the log it would be parts in 10^8. Further back than the
    //   log reaches (or past the start), the steps are chosen afresh, as going forwards.
    //   Rounding errors are tiny, but in a chaotic system, like the three stars of the Pythagorean
    //   problem, each close encounter multiplies them, so after a long run the backward motion drifts
    //   away from the true past, as physics predicts. The trails are the record of that past: going
    //   back over its trail a body takes it up again, and once a body has visibly left it, a ghost
    //   shows where it really was (read from the two trail samples either side of now), and the hint
    //   line says why. There is no other copy of the past to compare with: the trails (300 samples per
    //   reference period) are already one, and cost nothing more.
    //   Merges and tidal break-ups can't run backwards: two bodies that merge never come apart by
    //   themselves. So the system is copied just before each one (the newest EVENT_MAX, compact copies
    //   as for undo, keeping the very body objects so their trails come back too). When running back
    //   reaches that moment the copy is put back and the step that brought them together is retraced:
    //   the collision un-happens and the run carries on back from just before it. If the copy has been
    //   forgotten, the run stops there with a note. Bodies that touch while running back still merge.
    //   An edit (or undo, run again, a restart, or switching realistic physics) starts a new history:
    //   what came before it isn't the past of the system as it is now.
    //   Rewinding stops at the start, paused and ready to run forwards. Pressed there, Reverse runs on
    //   into the past that would lead to this setup (there is no trail to compare it with).
    //   Hooks: stepSize, afterStep and sampleTrails in advance (the trails sampled either way in time,
    //   see sampleAtTime), noteIrreversible in mergeBodies and disrupt, the clock-based measurements
    //   (periods, Kepler's 2nd law) fed time running forwards, drawPast in renderFrame, and timeDir in
    //   the time controls, the prediction, frame and runAgain.
    // ------------------------------------------------------------------
    let timeDir = 1;                      // 1: time runs forwards; -1: backwards
    let trailDir = 1;                     // which way in time the kept trail samples run
    let trailFloor = 0;                   // samples before this number may have been written over
    let trailEpoch = -1;                  // hist.epoch when trailFloor was last good
    const STEP_LOG = 1 << 17;             // steps logged for an exact retrace
    const LOG_MASK = STEP_LOG - 1;
    const PAIR_SETS = 4096;               // different sets of close pairs logged (beyond: chosen afresh going back)...
    const PAIR_ROWS = 200000;             // ...and at most this many pairs in them
    const EVENT_MAX = 200;                // merges and break-ups remembered...
    const EVENT_BODIES = 20000;           // ...and at most this many bodies in their copies
    const RETRACE_NEAR = 1e-3;            // back at a merger's moment: within this fraction of its step
    const MERGE_BACK_NOTE = '<strong>A merge can\'t be rewound.</strong> Undo brings them back.';   // (bodies that touch while running back)
    const past = {
        key: null,                        // the edit history's state when this history began (pastKey)
        from: 0,                          // trail samples from this number on were taken during it
        dt: null, pairs: null, head: 0, count: 0, replay: false,   // the step log: signed steps, pair sets
        sets: [[]], rows: 0, last: [], set: 0,   // the pair sets (as body ids), and the last step's pairs and set
        events: [], pending: null, wall: null,
        dropped: false,                   // the sample after the newest kept one was dropped (still readable)
        ghosted: false, drift: false, gap: 0, noted: false, noteTimer: 0   // (gap: the widest, px)
    };
    Object.assign(ui, { reverse: byId('reverseBtn') });

    // The edit history's state: it changes with every edit, undo, run again, restart or new scene (the
    // "run again" copy is retaken, or the trail samples start again), and while a body is dragged
    function pastKey() {
        const rw = hist.rw;
        return `${hist.epoch}|${hist.rwStale}|${!!hist.pending}|${rw ? `${rw.t}|${rw.samples}` : ''}|${settings.realistic}`;
    }

    // At the start of each advance: has the system been changed since this history began?
    function checkPast() {
        const key = pastKey();
        if (key === past.key) return;
        past.key = key;
        past.head = past.count = 0;
        past.replay = false;
        past.sets.length = 1; past.rows = 0; past.last = []; past.set = 0;
        past.events.length = 0; past.pending = null; past.wall = null;
        // (the sample just taken at this moment belongs to it)
        past.from = sampleCount > 0 && sampleTimes[(sampleCount - 1) % TRAIL_CAP] === simTime ? sampleCount - 1 : sampleCount;
        past.dropped = false;
    }

    // The next step. If the newest logged step went the other way, that step again with its close
    // pairs, so it is retraced exactly; otherwise the pairs and the adaptive step chosen now.
    function stepSize() {
        past.replay = false;
        if (past.count > 0) {
            const k = (past.head - 1) & LOG_MASK, s = past.dt[k];
            if (s * timeDir < 0) {
                usePairs(past.pairs[k]);
                past.replay = true;
                return -s * timeDir;
            }
        }
        refreshPairs();
        return nextDt;
    }

    // Follow logged set idx of close pairs (-1: too many sets were logged to keep this one: choose afresh)
    function usePairs(idx) {
        const want = idx >= 0 ? past.sets[idx] : null;
        if (!want) { refreshPairs(); return; }
        const has = (ia, ib, h) => mainPairs.some((p) => p.hosted === !!h && ((p.a.id === ia && p.b.id === ib) || (p.a.id === ib && p.b.id === ia)));
        const inOrder = want.length === mainPairs.length && want.every(([ia, ib, h], k) => mainPairs[k].a.id === ia && mainPairs[k].b.id === ib && mainPairs[k].hosted === !!h);
        if (inOrder || (want.length === mainPairs.length && want.every(([ia, ib, h]) => has(ia, ib, h)))) {
            if (forcesDirty) computeForces();
            return;
        }
        for (const p of mainPairs) if (p.hosted && !p.a.grp) bookHosted(p, false);
        for (const b of bodies) b.kep = null;
        mainPairs.length = 0;
        for (const [ia, ib, h] of want) {
            const a = bodyById(ia), b = bodyById(ib);
            if (a && b && !a.kep && (h || !b.kep)) {
                followPair(a, b, false, !!h);
                if (h && !a.grp) bookHosted(a.kep, true);
            }
        }
        syncHosts();
        computeForces();   // (a pair's own pull is left out of the kicks)
    }

    // The index of the set of close pairs the last step used (logging a new set if they changed)
    function pairSetIndex() {
        const L = past.last;
        let same = L.length === mainPairs.length;
        for (let i = 0; same && i < L.length; i++) same = L[i] === mainPairs[i];
        if (same) return past.set;
        past.last = mainPairs.slice();
        if (!mainPairs.length) return (past.set = 0);
        if (past.sets.length >= PAIR_SETS || past.rows >= PAIR_ROWS) return (past.set = -1);
        past.rows += mainPairs.length;
        past.sets.push(mainPairs.map((p) => [p.a.id, p.b.id, p.hosted ? 1 : 0]));
        return (past.set = past.sets.length - 1);
    }

    // After each step (from advance): log it (or take a replayed one off the log), and keep track of
    // merges and break-ups: copy the system before a new one, or undo the newest when back at its moment
    function afterStep(dt) {
        if (past.replay) {
            past.head--; past.count--; past.replay = false;
        } else {
            if (!past.dt) { past.dt = new Float64Array(STEP_LOG); past.pairs = new Int32Array(STEP_LOG); }
            const k = past.head & LOG_MASK;
            past.dt[k] = timeDir * dt;
            past.pairs[k] = pairSetIndex();
            past.head++;
            if (past.count < STEP_LOG) past.count++;
        }
        if (past.pending) {
            commitEvent(dt);
        } else if (past.events.length) {
            const ev = past.events[past.events.length - 1];
            if (ev.dir === -timeDir && ev.dir * (simTime - ev.t) <= RETRACE_NEAR * ev.dt) undoEvent(ev);
        }
        // (rewound to the start: it stops there, ready to run forwards, as a tape does)
        if (timeDir < 0 && simTime + dt >= 0.5 * dt && simTime < 0.5 * dt) {
            setPaused(true);
            setReverse(false, true);
            // (off, and looking it, though the pointer that pressed it may still be on it)
            if (ui.reverse && ui.reverse.matches(':hover')) ui.reverse.classList.add('is-rested');
            if (driftedFromStart()) {
                const again = canRunAgain() ? ' <button type="button" class="orb-hint-btn orb-hint-again">Run again</button>' : '';
                pastNote(`<strong>Back at time 0, but not where it began:</strong> rounding errors grow in chaos.${again}`, 12000);
            } else pastNote('<strong>Back at the start.</strong> Play runs it forwards again.', 6000);
            return;
        }
        const w = past.wall;
        if (w && w.dir === -timeDir && w.dir * (simTime - w.t) <= 0) {
            past.wall = null;
            setPaused(true);
            acc = 0;
            pastNote('<strong>Stopped:</strong> two bodies merged here, too long ago to take them apart.', 8000);
        }
    }

    // Rewound to the start of the run: is any body away from where it began, by over 1% of the size of
    // the system then, or gone? (Chaos does that at a high speed, where each step is far larger.)
    function driftedFromStart() {
        const s = hist.rw;
        if (!s || hist.rwStale || Math.abs(s.t - simTime) > sampleDt) return false;
        if (s.n !== bodies.length) return true;
        const num = s.num, at = new Map(bodies.map((b) => [b.id, b]));
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, far = 0;
        for (let i = 0; i < s.n; i++) {
            const o = i * SNAP_W, x = num[o + 3], y = num[o + 4], b = at.get(num[o]);
            if (!b) return true;
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            far = Math.max(far, Math.hypot(b.x - x, b.y - y));
        }
        return far > 0.01 * Math.hypot(x1 - x0, y1 - y0);
    }

    // Just before a merge (kind 'merge') or a tidal break-up ('tear'): copy the system, once a step
    function noteIrreversible(kind) {
        if (past.pending) return;
        past.pending = { kind, snap: snapshot(), objs: bodies.slice(), sel: selectedId, frame: frameId };
    }

    function commitEvent(dt) {
        const ev = past.pending;
        past.pending = null;
        Object.assign(ev, { t: simTime, dt, dir: timeDir, selAfter: selectedId, frameAfter: frameId });
        past.events.push(ev);
        let rows = 0;
        for (const e of past.events) rows += e.snap.n;
        while (past.events.length > EVENT_MAX || (rows > EVENT_BODIES && past.events.length > 1)) {
            const old = past.events.shift();
            rows -= old.snap.n;
            past.wall = { t: old.t, dir: old.dir };   // (running back can't get past this one)
        }
    }

    // Back at the moment of a merge or break-up: the bodies as they were just before (the same objects,
    // with their trails), then the step that brought them together retraced. (It isn't looked at for
    // contacts: they touched along it.)
    function undoEvent(ev) {
        past.events.pop();
        const s = ev.snap, num = s.num, had = new Set(bodies), list = [];
        for (let i = 0; i < s.n; i++) {
            const b = ev.objs[i], o = i * SNAP_W;
            b.m = num[o + 1]; b.R = num[o + 2];
            b.x = b.px = num[o + 3]; b.y = b.py = num[o + 4];
            b.vx = num[o + 5]; b.vy = num[o + 6];
            b.grp = num[o + 7] || null;
            b.name = s.names[i]; b.kind = s.kinds[i]; b.color = s.colors[i];
            b.held = null; b.aim = null; b.track = null; b.kep = null; b.ghost = null;
            list.push(b);
        }
        bodies = list;
        mainPairs.length = 0;
        for (const [ia, ib, fast, hosted] of s.pairs) {
            const a = list.find((q) => q.id === ia), b = list.find((q) => q.id === ib);
            if (a && b) followPair(a, b, !!fast, !!hosted);
        }
        syncHosts();
        groupEnergy.clear();
        for (const [id, u] of s.groupE) groupEnergy.set(id, u);
        // The choice of body (and the view) passes back to the one it came from
        if (selectedId === ev.selAfter) selectedId = ev.sel;
        if (frameId === ev.frameAfter) frameId = ev.frame;
        simTime = ev.t;
        // Trail samples from that moment on go: the body that was swallowed has none there. One that
        // comes back where the trails have started again (going the other way) starts its own afresh.
        if (trailDir === ev.dir) {
            while (sampleCount > trailFloor && ev.dir * (sampleTimes[(sampleCount - 1) % TRAIL_CAP] - ev.t) >= 0) dropSample();
        } else {
            for (const b of list) if (!had.has(b)) b.trailStart = sampleCount;
        }
        past.dropped = false;   // (the sample after the newest kept one has nothing for the bodies that came back)
        k2.bid = null;
        resetFlyby();
        computeForces();
        // The step itself, off the log too if it is there
        if (past.count > 0 && past.dt[(past.head - 1) & LOG_MASK] === ev.dir * ev.dt) { past.head--; past.count--; }
        step(-ev.dir * ev.dt);
        simTime -= ev.dir * ev.dt;
        acc = Math.max(0, acc - ev.dt);
        computePrimaries();
        refreshBodyLists();
        const back = list.filter((b) => !had.has(b));
        for (const b of back.slice(0, 12)) flashes.push({ x: b.x, y: b.y, t: performance.now(), color: b.color, r0: drawRadius(b), grow: b.minor ? 8 : 20 });
        const name = back.length ? escapeHtml(back[0].name) : 'A body';
        const note = ev.kind === 'tear' ? `<strong>${name} is whole again.</strong> A break-up can't run backwards by itself.`
            : `<strong>${back.length > 1 ? `${back.length} bodies are` : `${name} is`} back.</strong> A merger can't run backwards by itself.`;
        pastNote(note, 6000);
        updateHistoryUi();
    }

    // The trails after a step, either way in time. The kept samples always run one way (trailDir).
    // Going that way, one is added every sampleDt (and on a sharp bend). Going the other way, the
    // bodies go back over their trails, so the samples they pass are dropped (their numbers stay in
    // the buffers until written over: drawPast reads the newest one dropped). When none are left, the
    // trails start again the new way.
    function sampleTrails() {
        syncTrails();
        if (trailDir !== timeDir) {
            while (sampleCount > trailFloor && timeDir * (sampleTimes[(sampleCount - 1) % TRAIL_CAP] - simTime) < 0) dropSample();
            if (sampleCount > trailFloor) return;
            trailFloor = sampleCount;
            for (const b of bodies) if (b.trailStart < sampleCount) b.trailStart = sampleCount;
            trailDir = timeDir;
            recordSample();
            past.dropped = false;
            nextSampleT = simTime + timeDir * sampleDt;
            return;
        }
        if (timeDir * (simTime - nextSampleT) >= 0 || (timeDir * (simTime - lastSampleT) > sampleDt / 32 && trailBending())) {
            recordSample();
            past.dropped = false;
            while (timeDir * (nextSampleT - simTime) <= 0) nextSampleT += timeDir * sampleDt;
        }
    }

    // The samples were started again elsewhere (a new scene, an undo): they run the way time does now
    function syncTrails() {
        if (trailEpoch === hist.epoch) return;
        trailEpoch = hist.epoch;
        trailFloor = 0;
        if (sampleCount <= 1 && trailDir !== timeDir) { trailDir = timeDir; nextSampleT = lastSampleT + timeDir * sampleDt; }
    }

    // Drop the newest trail sample. The trail buffers are rings, so a body's oldest good sample is set by
    // the newest ever written: that limit is kept in its trailStart (and trailFloor for the shared ones).
    function dropSample() {
        const n = sampleCount - 1;
        for (const b of bodies) {
            if (b.trail) b.trailStart = Math.max(b.trailStart, sampleCount - (b.trail.length >> 1) + 1);
            if (b.trailStart > n) b.trailStart = n;
        }
        trailFloor = Math.max(trailFloor, sampleCount - TRAIL_CAP + 1);
        sampleCount = n;
        past.dropped = true;
        lastSampleT = n > trailFloor ? sampleTimes[(n - 1) % TRAIL_CAP] : simTime;
        nextSampleT = lastSampleT + trailDir * sampleDt;
    }

    // Running back over its trail, where each body really was at this moment (between the newest kept
    // sample and the one just dropped). A body the backward run has visibly taken away from it gets a
    // ghost there (a faint disc with a dashed edge), joined to it by a dotted line, and its trail stops at
    // the ghost (b.ghost, read by drawTrails). A body that has merged with another in the drifted run
    // back keeps its ghost, named. The first time in a run, the hint line says why.
    function drawPast(C) {
        syncTrails();
        if (past.ghosted) { for (const b of bodies) b.ghost = null; past.ghosted = false; }
        past.drift = false;
        past.gap = 0;
        drawThrowArrow(C);
        const k = sampleCount - 1;
        if (trailDir === timeDir || !past.dropped || k < Math.max(trailFloor, past.from) || cleanRender) return;
        const kt = k % TRAIL_CAP, kt1 = (k + 1) % TRAIL_CAP;
        const t0 = sampleTimes[kt], t1 = sampleTimes[kt1];
        if (timeDir * (simTime + lag - t0) > 0) return;   // (back before the oldest sample: there is no true past to compare with)
        const f = t1 !== t0 ? clamp((simTime + lag - t0) / (t1 - t0), 0, 1) : 0;
        // Relative to where the frame's origin was then, as the trails are drawn
        const L = frameId !== null ? bodyById(frameId) : null;
        let ox, oy;
        if (L) {
            if (!L.trail || trailFirst(L) > k) return;
            const i0 = trailIndex(L.trail, k), i1 = trailIndex(L.trail, k + 1);
            ox = L.trail[i0] + f * (L.trail[i1] - L.trail[i0]); oy = L.trail[i0 + 1] + f * (L.trail[i1 + 1] - L.trail[i0 + 1]);
        } else {
            ox = comTrail[2 * kt] + f * (comTrail[2 * kt1] - comTrail[2 * kt]); oy = comTrail[2 * kt + 1] + f * (comTrail[2 * kt1 + 1] - comTrail[2 * kt + 1]);
        }
        // (a turned view: seen from the turning pair as it was then, and turned as that moment's trail
        // samples are; see turnedSampleFrame)
        const tq = turnedSampleFrame(k, f);
        if (tq === 'none') return;
        if (tq && tq.ox !== undefined) { ox = tq.ox; oy = tq.oy; }
        const rc = tq ? tq.c : 1, rs = tq ? tq.s : 0;
        const live = freeze ? liveFrameOrigin() : F;
        const offX = (live.x - F.x - view.panX) * scale + midX, offY = viewH / 2 - (live.y - F.y - view.panY) * scale;
        const where = (b) => {
            const T = b.trail, i0 = trailIndex(T, k), i1 = trailIndex(T, k + 1);
            const rx = T[i0] + f * (T[i1] - T[i0]) - ox, ry = T[i0 + 1] + f * (T[i1 + 1] - T[i0 + 1]) - oy;
            return { x: offX + (rc * rx - rs * ry) * scale, y: offY - (rs * rx + rc * ry) * scale };
        };
        // (not pieces of a torn-apart body: their samples are too far apart at a swing past the host to say where they were)
        const usable = (b) => !b.held && !b.grp && b.trail && !(b.minor && !isChosen(b)) && trailFirst(b) <= k;
        for (const b of bodies) {
            if (!usable(b)) continue;
            const g = where(b), x = sx(b.dx), y = sy(b.dy), r = drawRadius(b);
            const gap = Math.hypot(g.x - x, g.y - y);
            past.gap = Math.max(past.gap, gap);
            if (gap <= Math.max(5, 0.8 * r)) continue;
            b.ghost = g;
            past.ghosted = past.drift = true;
            const rr = drawGhost(C, b, g, r);
            if (gap > rr + r + 4) {
                const ux = (x - g.x) / gap, uy = (y - g.y) / gap;
                ctx.strokeStyle = C.dark ? b.color : bodyStroke(b.color, false);
                ctx.globalAlpha = 0.45;
                ctx.lineWidth = 1;
                ctx.setLineDash([1.5, 4]);
                ctx.beginPath();
                ctx.moveTo(g.x + ux * rr, g.y + uy * rr);
                ctx.lineTo(x - ux * (r + 2), y - uy * (r + 2));
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.globalAlpha = 1;
            }
        }
        // Bodies merged away in this run (they are in the copies kept to undo it), named
        if (past.events.some((e) => e.dir === timeDir)) {
            const alive = new Set(bodies), gone = new Set();
            for (const e of past.events) if (e.dir === timeDir) for (const b of e.objs) if (!alive.has(b) && gone.size < 12 && usable(b)) gone.add(b);
            ctx.font = font(clamp(Math.min(viewW, viewH) / 48, 10, 12));
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            for (const b of gone) {
                const g = where(b), rr = drawGhost(C, b, g, drawRadius(b));
                ctx.fillStyle = C.subtle;
                ctx.fillText(b.name, g.x, g.y - rr - 3);
                past.drift = true;
            }
        }
        if (past.drift && !past.noted) {
            past.noted = true;
            // (bodies that merged on the way back left the true past for good: rounding has nothing to do with it)
            if (past.events.some((e) => e.dir === timeDir)) pastNote(MERGE_BACK_NOTE, 8000);
            else pastNote('<strong>Drifted from the true past:</strong> rounding errors grow in chaos. Dashed discs show where the bodies really were.', 9000);
        }
    }

    // A ghost: a faint disc with a dashed edge (not the dashed ring round the chosen body). Its radius.
    function drawGhost(C, b, g, r) {
        const rr = Math.max(r, 4) + 2;
        ctx.fillStyle = b.color;
        ctx.globalAlpha = 0.22;
        ctx.beginPath();
        ctx.arc(g.x, g.y, rr, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = C.dark ? b.color : bodyStroke(b.color, false);
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.9;
        ctx.setLineDash([2, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        return rr;
    }

    // A note in the hint line (read out by screen readers) for a while
    function pastNote(html, ms) {
        showHint('note', html, { ms: ms || 5000 });
    }

    // Time forwards (on false) or backwards (on true). The time still owed to the integrator was owed
    // the other way, and the measurements that run with the clock (periods, Kepler's 2nd law sectors,
    // the flyby card) start again; the history, the trails and any merges to undo carry on.
    function setReverse(on, quiet) {
        if (on && mission.def) {
            missionNote('<strong>Mission rules:</strong> time only runs forwards. Undo takes a burn back.');
            on = false;
        }
        const dir = on ? -1 : 1;
        if (dir !== timeDir) {
            timeDir = dir;
            acc = 0; lag = 0;
            pace.scene = null;
            for (const b of bodies) b.track = null;
            k2.bid = null;
            resetFlyby();
            pred.key = '';
            edit.previewDirty = true;
            past.noted = false;
            if (!quiet) pastNote(!on ? '<strong>Running forwards</strong> again.' : simTime > 0 ? '<strong>Running backwards:</strong> every body retraces its path.' : '<strong>Before the start:</strong> the past that would lead to this setup.', 5000);
        }
        syncReverseUi();
    }

    function syncReverseUi() {
        const back = timeDir < 0;
        if (ui.reverse) {
            ui.reverse.setAttribute('aria-pressed', back ? 'true' : 'false');
            if (back) ui.reverse.classList.remove('is-rested');
        }
        if (ui.pause) ui.pause.classList.toggle('is-back', back);   // (its Play points the way time will run)
        if (ui.step) {
            const label = back ? 'Step back' : 'Step forward';
            if (ui.step.getAttribute('aria-label') !== label) {
                ui.step.setAttribute('aria-label', label);
                ui.step.title = `${label} a moment (.)`;
                const icon = ui.step.querySelector('.icon');
                if (icon) { icon.classList.toggle('fa-step-forward', !back); icon.classList.toggle('fa-step-backward', back); }
            }
        }
    }

    // A press of Reverse, or B. Turning it on sets time going, as nobody presses it to see nothing happen.
    function pressReverse() {
        const on = timeDir > 0;
        setReverse(on);
        if (on && timeDir < 0 && paused) setPaused(false);
    }

    // The Reverse button, and B (not while typing, nor with Ctrl, Cmd or Alt); and the moment a thrown
    // body is let go
    function bindPlayControls() {
        window.addEventListener('pointerup', onThrowUp, true);
        if (ui.reverse) {
            ui.reverse.addEventListener('click', pressReverse);
            ui.reverse.addEventListener('pointerleave', () => ui.reverse.classList.remove('is-rested'));
        }
        window.addEventListener('keydown', (e) => {
            if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target)) return;
            if (e.key !== 'b' && e.key !== 'B') return;
            if (!e.repeat) pressReverse();
            e.preventDefault();
        });
        syncReverseUi();
    }

    // ------------------------------------------------------------------
    // Throwing a body ("Bodies you drop or move": "Throw it"). Let go of a body moved on the canvas, or
    // dropped from the palette, and it keeps moving across the screen as fast as the pointer was: the
    // pointer's speed over its last THROW_MS (px/s) over the screen speed of 1 AU/yr (px per AU for the
    // zoom, times simulated years per real second for the speed; backwards in time, the other way),
    // relative to the view. A pointer hardly moving as it lets go (resting it a moment first counts)
    // is a careful placement: the body starts at rest in the view. While it is dragged, the predicted
    // path shows the throw (releaseVelocity), and a body from the palette shows its velocity arrow.
    // ------------------------------------------------------------------
    const THROW_MS = 100;                 // the pointer's speed is taken over its last 100 ms
    const THROW_MIN = 60, THROW_MIN_TOUCH = 120;   // px/s: slower is a careful placement (fingers wobble as they lift)
    const THROW_MAX = 4000;               // px/s: faster flicks count as this fast
    const THROW_C = 0.05;                 // and no throw is faster than 5% of the speed of light
    let chipThrow = null;                 // a palette drag being let go

    // Where the pointer was lately (canvas or page px, with the event's time: on a phone the handler
    // can run a frame or two after the touch it reports)
    function traceDrag(d, x, y, e) {
        const now = performance.now();
        const t = e && Math.abs(e.timeStamp - now) < 1000 ? e.timeStamp : now;
        const tr = d.trace || (d.trace = []);
        tr.push({ t, x, y });
        while (tr.length > 2 && t - tr[1].t > 2 * THROW_MS) tr.shift();
        return t;
    }

    // Letting go: the last point, and when (seen before the handlers that place the body)
    function onThrowUp(e) {
        const d = drags.get(e.pointerId);
        if (d && d.mode === 'move') { const pt = canvasPoint(e); d.upT = traceDrag(d, pt.x, pt.y, e); }
        const c = paletteDrag;
        if (c && c.id === e.pointerId && c.moved) c.upT = traceDrag(c, e.clientX, e.clientY, e);
    }

    // The pointer's velocity as it is let go (px/s, screen y down), or null if it is hardly moving.
    // now: the time it is let go (or the present, while it is still held).
    function flickPx(d, now) {
        const tr = d && d.trace;
        if (!tr || tr.length < 2) return null;
        if (d.upT) now = d.upT;
        const end = tr[tr.length - 1];
        const t0 = Math.max(now - THROW_MS, tr[0].t), span = now - t0;
        if (!(span >= 8)) return null;
        // where it was at t0
        let i = tr.length - 1;
        while (i > 0 && tr[i - 1].t >= t0) i--;
        let x0 = tr[0].x, y0 = tr[0].y;
        if (i > 0) {
            const a = tr[i - 1], b = tr[i];
            const f = b.t > a.t ? clamp((t0 - a.t) / (b.t - a.t), 0, 1) : 1;
            x0 = a.x + f * (b.x - a.x); y0 = a.y + f * (b.y - a.y);
        }
        let vx = ((end.x - x0) * 1000) / span, vy = ((end.y - y0) * 1000) / span;
        const v = Math.hypot(vx, vy);
        if (v < ((d.type || lastPointerType) === 'mouse' ? THROW_MIN : THROW_MIN_TOUCH)) return null;
        if (v > THROW_MAX) { vx *= THROW_MAX / v; vy *= THROW_MAX / v; }
        return { x: vx, y: vy };
    }

    // The view's own velocity where a throw lets go of its body (a body being moved, or the drop point of
    // one from the palette): in a rotating frame it depends on the place (see frameVelocity)
    function throwBase(d) {
        if (d && d.body) return frameVelocity(d.body.x, d.body.y);
        if (d && d.cx !== undefined) { const w = unturnPoint(wx(d.cx), wy(d.cy)); return frameVelocity(w.x, w.y); }
        return frameVelocity();
    }

    // The world velocity a throw gives (AU/yr): the view's own velocity, plus the pointer's (along the
    // screen, so in a turned view turned back into the world's directions, as an aimed arrow is)
    function throwVelocity(d, now) {
        const fv = throwBase(d);
        const u = flickPx(d, now);
        if (!u) return [fv.x, fv.y];
        const k = timeDir * scale * Math.max(settings.speed * rate(), 1e-30);   // px/s on the screen per AU/yr
        let vx = u.x / k, vy = -u.y / k;
        const v = Math.hypot(vx, vy), cap = THROW_C * C_LIGHT;
        if (v > cap) { vx *= cap / v; vy *= cap / v; }
        const w = unturnVec(vx, vy);
        return [fv.x + w.x, fv.y + w.y];
    }

    function dragOf(b) {
        for (const d of drags.values()) if (d.body === b) return d;
        return null;
    }

    // The hint while a body is moved, when it will be thrown: "flies off at 12 km/s ..."
    function throwHint(d) {
        const now = performance.now();
        if (!flickPx(d, now)) return 'stays put. <strong>Flick</strong> it as you let go to throw it';
        const v = throwVelocity(d, now), fv = throwBase(d);
        const s = fmtSpeedKms(Math.hypot(v[0] - fv.x, v[1] - fv.y) * AUYR_KMS);
        return `flies off at <strong>${s.v} ${s.u}</strong>`;
    }

    // A body being dragged from the palette: the velocity it would be thrown with
    function drawThrowArrow(C) {
        const d = paletteDrag;
        if (!d || !d.over || !d.moved || settings.placement !== 'throw' || cleanRender) return;
        const now = performance.now();
        if (!flickPx(d, now)) return;
        const v = throwVelocity(d, now), fv = throwBase(d);
        const rel = turnVec(v[0] - fv.x, v[1] - fv.y), vx = rel.x, vy = rel.y, s = Math.hypot(vx, vy);   // (turned as the view is)
        const k = KINDS[d.kind] || KINDS.custom;
        const r = Math.max(symbolicSize(d.kind, k.m, k.R) * sizeScale, 4), L = arrowLength(s);
        const ux = vx / s, uy = -vy / s;   // (like every velocity arrow: backwards in time, against the motion)
        arrow(d.cx + ux * r, d.cy + uy * r, d.cx + ux * (r + L), d.cy + uy * (r + L), C.velocity, clamp(2 * sizeScale, 1.5, 2.4));
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
        let b = handleBody ? null : bodyAt(pt.x, pt.y, tol);
        // (by touch a Lagrange point's marker wins over a swarm's unnamed dots: the tap reads its note)
        if (b && touch && b.minor && !isChosen(b) && lagrangeShown.length && lagrangeAt(pt.x, pt.y, LAGRANGE_TAP) && !namedBodyAt(pt.x, pt.y, tol)) b = null;
        if (!handleBody && !b && !right) handleBody = onArrowTip(pt.x, pt.y, touch ? GRAB_TOUCH - 2 : GRAB_MOUSE - 1);
        // (not quite on anything: what the press was probably meant for, rather than moving the view)
        if (!handleBody && !b && !right) handleBody = nearArrow(pt.x, pt.y, touch ? 12 : 7, touch ? NEAR_TOUCH : NEAR_MOUSE);
        if (!handleBody && !b) b = bodyNear(pt.x, pt.y, touch ? 18 : 12);
        if (handleBody && missionRefuse('aim', handleBody)) handleBody = null;
        const forceOnly = !handleBody && !b && !right && !mission.def && onForceArrow(pt.x, pt.y, touch ? 10 : 6);
        const d = { id: e.pointerId, x: pt.x, y: pt.y, x0: pt.x, y0: pt.y, type: lastPointerType, moved: false, body: null, mode: 'pending', button: e.button, downT: performance.now() };
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
        } else if (forceOnly) {
            // (a press on a pink arrow, which looks as if it could be dragged, says what it is)
            d.mode = 'done';
            showHint('note', '<strong>Pink arrows</strong> show gravity\'s pull. Drag a <strong>teal tip</strong> to aim.', { ms: 5000 });
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
        traceDrag(d, pt.x, pt.y, e);   // (for a throw: where the pointer was lately)
        const far = Math.hypot(pt.x - d.x0, pt.y - d.y0) > (d.type === 'mouse' ? 3 : 8);
        if (d.mode === 'pinch') {
            const pts = [...drags.values()].filter((q) => q.mode === 'pinch');
            if (pts.length === 2 && pinch) {
                const [a, b] = pts;
                const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
                const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
                const was = { zoom: view.zoom, panX: view.panX, panY: view.panY };
                view.zoom = clamp(pinch.zoom0 * dist / pinch.d0, 1e-7, 1e7);
                view.anim = null;
                drawer.moved = true;
                updateScale();
                // keep the world point that was under the fingers' midpoint under it
                view.panX = pinch.wx - F.x - (mx - midX) / scale;
                view.panY = pinch.wy - F.y + (my - viewH / 2) / scale;
                if (view.zoom > was.zoom && insideOf()) { Object.assign(view, was); updateScale(); }   // (no further in)
            }
            return;
        }
        if (d.mode === 'pending' && far) d.mode = 'pan';
        if (d.mode === 'pan') {
            view.panX -= dx / scale;
            view.panY += dy / scale;
            view.anim = null;
            view.panned = true;
            drawer.moved = true;
            return;
        }
        if (d.mode === 'press' && far && missionRefuse('move', d.body)) d.mode = 'pan';
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
        if (d.mode === 'pan' && !view.panTold && !mission.def && Math.hypot(d.x - d.x0, d.y - d.y0) > 30) {
            view.panTold = true;
            showHint('note', '<strong>You moved the view.</strong> Fit view puts it back.', { ms: 5000 });
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
            // (only two quick presses: a press held still a while, as when a drag is started but the
            // body hardly moves, isn't half of a double-click)
            const quick = now - d.downT < TAP_MS;
            const dbl = quick && lastTap.quick && now - lastTap.t < 380 && Math.hypot(d.x0 - lastTap.x, d.y0 - lastTap.y) < (d.type === 'mouse' ? 8 : 26) && lastTap.id === (b ? b.id : null);
            lastTap = { t: dbl ? 0 : now, x: d.x0, y: d.y0, id: b ? b.id : null, quick };
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
        if (!tipOf) tipOf = onArrowTip(x, y, GRAB_MOUSE - 1) || nearArrow(x, y, 7, NEAR_MOUSE);
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

    // Chart.js is fetched the first time the graphs are shown (most visits never need it)
    const CHART_JS = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js';
    let chartJsAsked = false;
    function askForChartJs() {
        if (chartJsAsked) return;
        chartJsAsked = true;
        const tag = document.createElement('script');
        tag.src = CHART_JS;
        tag.onload = () => {
            if (charts || !ui.chartsContainer || ui.chartsContainer.style.display === 'none') return;
            charts = makeCharts();
            resetCharts();
        };
        tag.onerror = () => { chartJsAsked = false; };
        document.head.appendChild(tag);
    }

    function makeCharts() {
        if (typeof Chart === 'undefined') { askForChartJs(); return null; }
        const c = chartColors();
        // (a steady line stays a steady line: its axis spans at least 1% of its value, not its last few digits)
        const steadyAxis = (axis) => {
            const mid = 0.5 * (axis.max + axis.min), least = 0.01 * Math.abs(mid);
            if (axis.max - axis.min < least) { axis.min = mid - 0.5 * least; axis.max = mid + 0.5 * least; }
        };
        const common = (yTitle) => ({
            responsive: true, maintainAspectRatio: false, animation: false,
            plugins: { legend: { labels: { color: c.text, boxWidth: 12 } } },
            scales: {
                x: { ticks: { color: c.text, maxTicksLimit: 6, maxRotation: 0, sampleSize: 8 }, grid: { color: c.grid }, title: { display: true, text: `Time (${fmtTime(0).u})`, color: c.text } },
                y: { afterDataLimits: steadyAxis, ticks: { color: c.text }, grid: { color: c.grid }, title: { display: true, text: yTitle, color: c.text } }
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
        opts.scales.y1 = { afterDataLimits: steadyAxis, position: 'right', ticks: { color: c.text }, grid: { drawOnChartArea: false }, title: { display: true, text: 'Speed (km/s)', color: c.text } };
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

    let chartsFrom = null;   // where the page was when the graphs opened
    function setChartsVisible(visible) {
        if (!ui.chartsContainer) return;
        ui.chartsContainer.style.display = visible ? 'block' : 'none';
        document.body.classList.toggle('charts-visible', visible);
        if (visible && !charts) charts = makeCharts();
        if (visible) resetCharts();
        // (they open under the info bar, below the fold on most screens; closed, the page goes back)
        if (document.body.classList.contains('sim-fullscreen-active')) return;
        if (visible) {
            chartsFrom = window.scrollY;
            ui.chartsContainer.scrollIntoView({ block: 'nearest', behavior: quickMotion() });
        } else if (chartsFrom !== null) {
            window.scrollTo({ top: chartsFrom, behavior: quickMotion() });
            chartsFrom = null;
        }
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
    // orbit (to within the size of the next, 2PN, terms: about 2% for the neutron star at 0.24c). A compact,
    // close pair also has the 2PN terms in its motion, and so in its energy (energy2PN).
    let sumKE = 0, sumPE = 0;
    function addPairEnergy(bi, bj) {
        const rx = bi.x - bj.x, ry = bi.y - bj.y;
        if (bi.grp && bj.grp) {
            // pieces of one torn-apart body: the softened potential of their softened pull
            // (and pieces of different bodies don't pull on each other)
            if (bi.grp !== bj.grp) return;
            const e = 0.5 * (softLength(bi) + softLength(bj));
            sumPE -= (G * bi.m * bj.m) / Math.sqrt(rx * rx + ry * ry + e * e);
            return;
        }
        const r = Math.sqrt(rx * rx + ry * ry);
        if (!(r > 0)) return;
        sumPE -= (G * bi.m * bj.m) / r;
        // (a piece's orbit turns, without these, as does a whole body's going round its host: see driftHosted)
        if (settings.realistic && !bi.grp && !bj.grp && !(bi.kep && bi.kep.hosted && bi.kep.b === bj) && !(bj.kep && bj.kep.hosted && bj.kep.b === bi)) {
            const M = bi.m + bj.m, mu = (bi.m * bj.m) / M, eta = mu / M, gm = G * M;
            const vx = bi.vx - bj.vx, vy = bi.vy - bj.vy, v2 = vx * vx + vy * vy;
            const rd = (rx * vx + ry * vy) / r;
            sumKE += (mu * 0.375 * (1 - 3 * eta) * v2 * v2) / C2;
            sumPE += (mu * gm / (2 * r * C2)) * ((3 + eta) * v2 + eta * rd * rd + gm / r);
            // (and the 2PN terms for a compact, close pair, which has them in its motion too)
            if (gm > RR_MIN_C2 * r) { const e2 = energy2PN(v2, rd, gm / r, eta); sumKE += mu * e2.k; sumPE += mu * e2.p; }
        }
    }

    function systemEnergy() {
        const c = totals(bodies);
        sumKE = 0; sumPE = 0;
        for (const b of bodies) sumKE += 0.5 * b.m * ((b.vx - c.vx) ** 2 + (b.vy - c.vy) ** 2);
        for (let i = 0; i < bodies.length; i++) {
            const bi = bodies[i];
            for (let j = i + 1; j < bodies.length; j++) addPairEnergy(bi, bodies[j]);
        }
        for (const u of groupEnergy.values()) sumPE -= u;
        return { ke: sumKE, pe: sumPE, total: sumKE + sumPE };
    }

    // The part of that energy that a few of the bodies have: their motion, and every pair they are in
    function energyOf(list) {
        const c = totals(bodies);
        sumKE = 0; sumPE = 0;
        for (const b of list) {
            sumKE += 0.5 * b.m * ((b.vx - c.vx) ** 2 + (b.vy - c.vy) ** 2);
            for (const q of bodies) if (!list.includes(q)) addPairEnergy(b, q);
        }
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) addPairEnergy(list[i], list[j]);
        return sumKE + sumPE;
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
        if (Math.abs(simTime - lastChartSample) < every) return;   // (either way in time)
        lastChartSample = simTime;
        const label = fmtTime(simTime).v;
        const E = systemEnergy();
        const k = ENERGY_J / Math.pow(10, energyExp);
        const ce = charts.energy;
        ce.data.labels.push(label);
        ce.data.datasets[0].data.push(E.ke * k);
        ce.data.datasets[1].data.push(E.pe * k);
        ce.data.datasets[2].data.push(E.total * k);
        chartWaves(ce, E, k);
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
        recordGraphPoint(E, b, p);   // (kept at full precision for a download)
        for (const ch of [ce, co]) {
            if (ch.data.labels.length > 240) {
                ch.data.labels.shift();
                ch.data.datasets.forEach((d) => d.data.shift());
            }
        }
        chartsDirty = true;
    }

    // ------------------------------------------------------------------
    // Save and share: a link to the setup, autosave, data for a spreadsheet, and random planetary
    // systems with a stability timer
    //   A setup is what the edit history keeps of the system (see snapshot()), with its scene's key and
    //   scales, the view, the time still owed to the integrator and the main settings, as JSON. In a
    //   link it goes in the hash, #setup=1z.<data>: format 1, deflate-raw compressed (z), base64url. A
    //   browser that can't compress writes 1j.<data>, the JSON itself. JavaScript writes each number
    //   with just the digits that read back as the same float64, so a shared chaotic setup replays
    //   exactly. Opening one is a step in the edit history, like a change of scene, so it can be undone.
    //   Autosave keeps the same JSON in localStorage a couple of seconds after each change and every
    //   half minute while it runs (but not for a built-in scene that hasn't been touched), and a later
    //   visit offers to carry on, in the hint line. The copy of the system is taken at once (that is
    //   cheap) and written out a few hundred bodies at a time while the browser is idle, so even 1,000
    //   bodies never hold up a frame. Storage can be blocked: every use of it is wrapped.
    //   A random system (scene key random-<number>) is made from its number alone, so a link needs only
    //   the key to make it again. Its neighbouring planets are a random number of mutual Hill radii apart
    //   (one number for the whole system, give or take 10%): closer than about 6 and they usually stir
    //   each other into crossing orbits within thousands of orbits; wider than about 9 and they usually
    //   last.
    //   The stability timer counts the simulated time since the last change (or the start of the scene)
    //   until the first collision or tidal break-up, or until a body is flung out: unbound from the rest
    //   of the system, and three times as far from it as the farthest body was when the timer started.
    //   Four times a second it reads the bound flags of computePrimaries() and makes one pass over the
    //   bodies, so it costs next to nothing even with 1,000. Hooks in the code above: noteCollision in
    //   mergeBodies, noteTornApart in disrupt, recordGraphPoint in sampleCharts, drawStabilityCard in
    //   drawOverlays and carryOnHint in setHint.
    // ------------------------------------------------------------------
    const SETUP_VERSION = 1;
    const SAVE_KEY = 'orbits.autosave';        // "<ms since 1970>|<setup JSON>"
    const BEST_KEY = 'orbits.stabilityBest';   // { yr, label }
    const LONG_LINK = 8000;                    // characters: a longer link gets a warning
    const SETUP_MAX_BYTES = 16e6;              // a link may unpack to at most this much JSON
    const SAVE_QUIET_MS = 2000;                // autosave this long after the last change...
    const SAVE_EVERY_MS = 30000;               // ...and this often while it runs
    const SAVE_CHUNK = 250;                    // bodies written out per idle moment
    const OFFER_MS = 45000;                    // "Carry on where you left off" is offered this long
    const NOTE_MS = 9000;                      // a note under a button stays this long
    const STAB_EJECT = 3;                      // flung out: unbound, and this many times the system's size away
    const STAB_GOAL = 10000;                   // years: the challenge
    const RANDOM_MAX = 99999;                  // new random systems are numbered 1 to this
    const SEED_MAX = 2147483646;               // (a link may carry any number up to this)
    const GRAPH_POINTS = 20000;                // points of the graphs kept for a download
    const PLANET_LETTERS = 'bcdefghi';
    const SETUP_ERRORS = {
        none: 'It doesn\'t hold a setup.',
        broken: 'It may have been cut short or changed: ask for it again.',
        newer: 'It was made by a newer version of this page: reload the page, then open the link again.',
        browser: 'This browser can\'t unpack it: try an up-to-date Chrome, Edge, Firefox or Safari.',
        many: `It holds more than ${MAX_BODIES.toLocaleString('en-US')} bodies, more than this page can take.`
    };
    const CSV_EMPTY = {
        kepler: 'Nothing to list yet: choose a body that orbits something.',
        graphs: 'No graph data yet: show the Graphs and let it run.',
        bodies: 'There are no bodies.'
    };
    Object.assign(settings, { stability: false });

    const share = {
        offer: null, offerHtml: '', offerTimer: 0,     // the autosave on offer, as a setup
        link: '', copying: false,                       // the last link made
        noteTimers: new Map(),
        save: { sig: '', due: 0, lastAt: 0, lastT: NaN, savedSig: '', job: null, ok: null, bytes: 0, sliceMs: 0, writeMs: 0, count: 0 }
    };
    const stab = {
        running: false, sig: '', scene: '', t0: 0, lastT: 0, ended: null, rEject: Infinity,
        unbound: new Map(),          // id -> the simulated time it was first seen unbound from the rest
        boundAtStart: new Set(),     // ids of the bodies bound to the rest when the timer started
        counts: false, label: '', restartedAt: -Infinity, goalNoted: false, auto: false,
        best: { yr: 0, label: '' }, bestBefore: { yr: 0, label: '' }, bestDirty: false, bestSavedAt: 0
    };
    const graphData = [];            // the graphs' points at full precision, since they last started
    const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

    // localStorage, or null where it is blocked (some browsers throw on merely reading the property)
    function storage() {
        try { return window.localStorage || null; } catch (e) { return null; }
    }

    function storeGet(key) {
        const s = storage();
        if (!s) return null;
        try { return s.getItem(key); } catch (e) { return null; }
    }

    function storeSet(key, value) {
        const s = storage();
        if (!s) return false;
        try { s.setItem(key, value); return true; } catch (e) { return false; }   // blocked, or full
    }

    // Run fn when the browser has a moment to spare between frames
    const whenIdle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 1000 }) : setTimeout(fn, 30));

    // A note in the hint line for ms milliseconds (shares the history's timer, so notes don't cut each
    // other short or linger)
    function timedHint(html, ms) {
        showHint('note', html, { ms });
    }

    // A note under a button for a few seconds, then its usual text again
    function flashNote(el, text) {
        if (!el) return;
        el.textContent = text;
        revealInPanel(el);
        clearTimeout(share.noteTimers.get(el));
        share.noteTimers.set(el, setTimeout(() => { el.textContent = el.dataset.text || ''; }, NOTE_MS));
    }

    // A stretch of time in the scene's own unit: "0.24 yr", "3.4 yr", "1,234 yr" (or days, or seconds)
    function fmtSpan(yr) {
        const u = timeUnit(), v = u === 's' ? yr * YEAR_S : u === 'd' ? yr * DAYS_PER_YEAR : yr;
        const n = v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US');
        return `${n} ${u === 'd' ? 'days' : u}`;
    }

    // "1,234 yr", "3.4 yr", or days when shorter than a tenth of a year
    function fmtYears(yr) {
        if (yr >= 10) return `${Math.round(yr).toLocaleString('en-US')} yr`;
        if (yr >= 0.1) return `${+yr.toFixed(2)} yr`;
        return `${+(yr * DAYS_PER_YEAR).toPrecision(2)} days`;
    }

    function fmtAge(ms) {
        const min = ms / 60000;
        if (!(min >= 1)) return 'just now';
        if (min < 60) return `${Math.round(min)} min ago`;
        const h = Math.round(min / 60);
        if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
        const d = Math.round(h / 24);
        return d < 2 ? 'yesterday' : `${d} days ago`;
    }

    // "System #4821", or a built-in scene's name as the scene list has it, without the part in brackets
    function sceneLabel(key) {
        const seed = randomSeed(key);
        if (seed) return `System #${seed}`;
        const opt = ui.scene ? Array.from(ui.scene.options).find((o) => o.value === key) : null;
        return opt ? opt.textContent.replace(/\s*\(.*\)\s*$/, '') : 'Your setup';
    }

    // The user is moving a body or aiming its velocity: the system is half changed
    const editing = () => !!(hist.pending && hist.pending.gesture) || bodies.some((b) => b.held);

    // Changes to the system: every edit, undo, redo, run again and change of scene alters this
    function editSignature() {
        const top = hist.undo[hist.undo.length - 1];
        return `${settings.scene}|${hist.epoch}|${hist.undo.length}|${hist.redo.length}|${top ? top.at : 0}`;
    }

    function settingsSignature() {
        const s = settings;
        return [s.speed, s.realistic, s.merge, s.k1, s.k2, s.k3, s.forces, s.velocities, s.labels, s.stability,
            s.placement, s.trailIndex, s.com, selectedId, frameId, turn.on ? turn.aId : '', s.pulls, s.well, s.lagrange, s.limits].join(',');
    }

    // ------------------------------------------------------------------
    // Random systems
    // ------------------------------------------------------------------
    const isRandomKey = (key) => typeof key === 'string' && /^random-[1-9]\d{0,9}$/.test(key);
    function randomSeed(key) {
        if (!isRandomKey(key)) return 0;
        const n = +key.slice(7);
        return n <= SEED_MAX ? n : 0;
    }
    const validSeed = (n) => Number.isInteger(n) && n >= 1 && n <= SEED_MAX;

    // Repeatable random numbers in [0, 1) for a system number (mulberry32, after mixing the number up,
    // so that neighbouring numbers give unrelated systems)
    function systemRandom(seed) {
        let h = seed >>> 0;
        h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
        h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
        let a = (h ^ (h >>> 16)) >>> 0;
        return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Where a body is, and how it moves, relative to a mass on an orbit (a in AU, w and nu in degrees)
    function orbitState(mass, a, e, w, nu) {
        const c = { m: 0, x: 0, y: 0, vx: 0, vy: 0 };
        placeOnOrbit(c, { m: mass, x: 0, y: 0, vx: 0, vy: 0 }, { a, e, w, nu });
        return c;
    }

    // The scene for a system number: a star, 2 to 8 planets (fewer if they run out of room), now and then
    // a moon or two and a second star. Bodies are given by position and velocity, so a second star can
    // carry the whole planetary system round with it.
    function makeRandomSystem(seed) {
        const rnd = systemRandom(seed);
        const span = (lo, hi) => lo + (hi - lo) * rnd();
        const logSpan = (lo, hi) => lo * Math.pow(hi / lo, rnd());
        const pick = (list) => list[Math.floor(rnd() * list.length)];
        const DEG = 180 / Math.PI;
        // The star: most often a red dwarf or one like the Sun, now and then a hotter star or a white dwarf
        const roll = rnd();
        const star = roll < 0.4 ? { what: 'a red dwarf', kind: 'dwarf', m: span(0.15, 0.6), color: '#ff8a5c' }
            : roll < 0.85 ? { what: 'a star like the Sun', kind: 'sun', m: span(0.75, 1.3), color: '#ffd166' }
                : roll < 0.95 ? { what: 'a hot white star', kind: 'sun', m: span(1.4, 2.2), color: '#e9f0ff' }
                    : { what: 'a white dwarf', kind: 'whitedwarf', m: span(0.5, 0.75), color: '#e9f0ff' };
        const M = star.m;
        // (a star's radius grows a little more slowly than its mass; a white dwarf shrinks as it gets heavier)
        const R = star.kind === 'whitedwarf' ? 8700 * Math.cbrt(0.6 / M) : 696000 * Math.pow(M, 0.8);
        const list = [{ kind: star.kind, name: 'Star', m: M, R, color: star.color, x: 0, y: 0, vx: 0, vy: 0 }];
        // The planets, from the inside out. The first takes 0.4 to 2 years to go round; each next one is
        // `spacing` mutual Hill radii, ((m1 + m2) / 3M)^(1/3) (a1 + a2) / 2, beyond the one before.
        const want = 2 + Math.floor(rnd() * 7);
        const spacing = span(3.5, 10);
        const T1 = logSpan(0.4, 2);
        const planets = [];
        let a = Math.cbrt(M * T1 * T1);
        const aMax = 30 * a;
        for (let i = 0; i < want; i++) {
            const m = logSpan(0.5 * MEARTH, 2 * MJUP);
            if (i > 0) {
                const prev = planets[i - 1];
                const h = 0.5 * spacing * span(0.9, 1.1) * Math.cbrt((m + prev.m) / (3 * M));
                const next = h < 0.8 ? (prev.a * (1 + h)) / (1 - h) : Infinity;
                if (next > aMax) break;
                a = next;
            }
            const e = 0.06 * rnd(), w = 360 * rnd();
            planets.push({ m, a, e, w, nu: trueAnomaly(TAU * rnd(), e) * DEG });
        }
        const ROCKY = ['#e8825e', '#b5aca3', '#7ecaf6', '#f0d9a0', '#c9a27a'];
        const ICY = ['#7bd0c1', '#8499e7', '#8fb8ff'];
        const GIANT = ['#e0b48a', '#d9a066', '#f2c48d', '#c78f6a'];
        let moons = 0;
        planets.forEach((p, i) => {
            const me = p.m / MEARTH;
            const look = me < 3 ? { kind: 'earth', R: 6371 * Math.pow(me, 0.28), color: pick(ROCKY) }
                : me < 50 ? { kind: 'custom', R: 6371 * Math.min(4.5, Math.pow(me, 0.55)), color: pick(ICY) }
                    : { kind: 'jupiter', R: 69911 * Math.pow(p.m / MJUP, 0.15), color: pick(GIANT) };
            const q = orbitState(M + p.m, p.a, p.e, p.w, p.nu);
            const planet = { kind: look.kind, name: `Planet ${PLANET_LETTERS[i]}`, m: p.m, R: look.R, color: look.color, x: q.x, y: q.y, vx: q.vx, vy: q.vy };
            list.push(planet);
            // Now and then a moon for a giant, well inside its Hill sphere (where the star hardly disturbs
            // it); the pair's centre of mass follows the planet's orbit
            if (me >= 10 && moons < 2 && rnd() < 0.3) {
                const mm = logSpan(0.002, 0.03) * MEARTH;
                const hill = p.a * (1 - p.e) * Math.cbrt(p.m / (3 * M));
                const r = orbitState(p.m + mm, hill * span(0.15, 0.3), 0.03 * rnd(), 360 * rnd(), 360 * rnd());
                const f = mm / (p.m + mm);
                list.push({ kind: 'moon', name: `Moon of ${PLANET_LETTERS[i]}`, m: mm, R: 1737 * Math.cbrt(mm / KINDS.moon.m), color: '#c9ccd3',
                    x: planet.x + (1 - f) * r.x, y: planet.y + (1 - f) * r.y, vx: planet.vx + (1 - f) * r.vx, vy: planet.vy + (1 - f) * r.vy });
                planet.x -= f * r.x; planet.y -= f * r.y; planet.vx -= f * r.vx; planet.vy -= f * r.vy;
                moons++;
            }
        });
        // Now and then a second star, 3 to 8 times farther out than the last planet, which may unsettle it
        let companion = false;
        if (rnd() < 0.2) {
            const outer = planets[planets.length - 1];
            const mc = M * span(0.15, 0.7), red = mc < 0.6;
            const c = totals(list);
            const q = orbitState(c.M + mc, outer.a * (1 + outer.e) * span(3, 8), span(0, 0.35), 360 * rnd(), 360 * rnd());
            const fi = mc / (c.M + mc), fc = c.M / (c.M + mc);
            for (const b of list) { b.x -= fi * q.x; b.y -= fi * q.y; b.vx -= fi * q.vx; b.vy -= fi * q.vy; }
            list.push({ kind: red ? 'dwarf' : 'sun', name: 'Star B', m: mc, R: 696000 * Math.pow(mc, 0.8), color: red ? '#ff9a52' : '#ffd166',
                x: c.x + fc * q.x, y: c.y + fc * q.y, vx: c.vx + fc * q.vx, vy: c.vy + fc * q.vy });
            list[0].name = 'Star A';
            companion = true;
        }
        let half = 1.15 * Math.max(...planets.map((p) => p.a * (1 + p.e)));
        // (with a second star the planets' star goes round the centre of mass too: all of it in view)
        if (companion) {
            const c = totals(list), far = (b) => Math.hypot(b.x - c.x, b.y - c.y);
            half = 1.15 * Math.max(far(list[0]) + half / 1.15, far(list[list.length - 1]));
        }
        const extra = [];
        if (moons) extra.push(moons === 1 ? 'a moon' : `${moons} moons`);
        if (companion) extra.push('a second star');
        const desc = `${star.what} with ${planets.length} planets${extra.length === 2 ? `, ${extra[0]} and ${extra[1]}` : extra.length ? ` and ${extra[0]}` : ''}`;
        return {
            units: 'au', Tref: T1, subject: 1, trail: 6, seed, box: [-half, half, -half, half],
            tip: `${sentenceCase(desc)}. Will they last ${STAB_GOAL.toLocaleString('en-US')} years?`,
            bodies: list.map((b) => ({ kind: b.kind, name: b.name, m: b.m, R: b.R, color: b.color, at: [b.x, b.y], v: [b.vx, b.vy] }))
        };
    }

    // The scene key for a system number (making its scene the first time)
    function randomSceneKey(seed) {
        const key = `random-${seed}`;
        if (!hasOwn(SCENES, key)) SCENES[key] = makeRandomSystem(seed);
        return key;
    }

    function newRandomSeed() {
        let s;
        do { s = 1 + Math.floor(Math.random() * RANDOM_MAX); } while (s === randomSeed(settings.scene));
        return s;
    }

    // The scene list shows the latest random system as an entry of its own, under "Random system"
    // (which makes a new one)
    function showRandomOption(key) {
        if (!ui.scene || !isRandomKey(key)) return;
        let opt = ui.scene.querySelector('option[data-random-system]');
        if (!opt) {
            opt = document.createElement('option');
            opt.dataset.randomSystem = '';
            const base = ui.scene.querySelector('option[value="random"]');
            if (base) base.after(opt); else ui.scene.appendChild(opt);
        }
        opt.value = key;
        opt.textContent = `Random system #${randomSeed(key)}`;
    }

    // (an undo can bring back an older random system: the list follows)
    function syncSceneList() {
        if (ui.scene && isRandomKey(settings.scene) && ui.scene.value !== settings.scene) {
            showRandomOption(settings.scene);
            ui.scene.value = settings.scene;
        }
    }

    // auto: switched on by a random system, rather than by the user (see stabilitySceneLoaded); once
    // the user has switched it on, it stays theirs
    function setStability(on, auto) {
        const users = settings.stability && !stab.auto;
        settings.stability = !!on;
        stab.auto = settings.stability && !!auto && !users;
        if (ui.stability) ui.stability.checked = settings.stability;
    }

    // A random system switches the timer on for itself: another scene switches it off again (the
    // collisions of "A moon forming" or the chaos of three stars aren't a stability challenge), unless
    // the user switched it on
    function stabilitySceneLoaded(key) {
        if (stab.auto && !isRandomKey(key)) setStability(false);
    }

    function loadRandomSystem(seed) {
        const key = randomSceneKey(seed);
        showRandomOption(key);
        if (ui.scene) ui.scene.value = key;
        loadScene(key);
        setStability(true, true);
        return key;
    }

    // "Random system" picked in the scene list: make a new one before the list's own listener loads it
    function onSceneChoice(e) {
        if (e.target !== ui.scene || ui.scene.value !== 'random') return;
        const key = randomSceneKey(newRandomSeed());
        showRandomOption(key);
        ui.scene.value = key;
        setStability(true, true);
    }

    // ------------------------------------------------------------------
    // Setups as JSON, and as links
    // ------------------------------------------------------------------
    // Everything but the bodies (s: a snapshot)
    function setupHead(s) {
        const st = settings;
        return {
            v: SETUP_VERSION, sc: s.scene, t: s.t, acc, sel: s.sel, fr: s.frame,
            vw: [s.zoom, s.panX, s.panY],
            sca: [s.forceRef, s.vRef, s.energyExp, s.trail, s.com ? 1 : 0],
            cc: s.customCount, pr: s.pairs, ge: s.groupE,
            // (sh: what is shown; the last four came later, so an older link reads them as off)
            set: {
                sp: st.speed, re: +st.realistic, me: +st.merge, k: [+st.k1, +st.k2, +st.k3],
                sh: [+st.forces, +st.velocities, +st.labels, +st.pulls, +st.well, +st.lagrange, +st.limits], st: +st.stability, pl: st.placement
            },
            // (a rotating frame: the body its body fr orbits, and the line's direction on the screen)
            ro: turnSetup()
        };
    }

    // Body i of a snapshot: [id, name, kind, colour, m, R, x, y, vx, vy] and, for a piece of a body torn
    // apart, the id of that body
    function setupRow(s, i) {
        const num = s.num, o = i * SNAP_W;
        const row = [num[o], s.names[i], s.kinds[i], s.colors[i], num[o + 1], num[o + 2], num[o + 3], num[o + 4], num[o + 5], num[o + 6]];
        if (num[o + 7]) row.push(num[o + 7]);
        return row;
    }

    function setupJson(s) {
        const rows = [];
        for (let i = 0; i < s.n; i++) rows.push(setupRow(s, i));
        return JSON.stringify(Object.assign(setupHead(s), { b: rows }));
    }

    function setupError(code) {
        const e = new Error(SETUP_ERRORS[code] || SETUP_ERRORS.broken);
        e.setup = code;
        return e;
    }

    // A setup read back from JSON (a link or the autosave) and checked, so that a damaged or doctored
    // link can't break the page: { s (a snapshot to restore), set (settings), acc, maxGrp }.
    // Throws a setupError.
    function readSetup(json) {
        let d;
        try { d = JSON.parse(json); } catch (e) { throw setupError('broken'); }
        if (!d || typeof d !== 'object') throw setupError('broken');
        if (d.v !== SETUP_VERSION) throw setupError(typeof d.v === 'number' && d.v > SETUP_VERSION ? 'newer' : 'broken');
        const rows = d.b;
        if (!Array.isArray(rows) || !rows.length) throw setupError('broken');
        if (rows.length > MAX_BODIES) throw setupError('many');
        const n = rows.length;
        const num = new Float64Array(n * SNAP_W), names = new Array(n), kinds = new Array(n), colors = new Array(n);
        const ids = new Set(), renumber = [];
        let maxId = 0, maxGrp = 0;
        for (let i = 0; i < n; i++) {
            const r = rows[i];
            if (!Array.isArray(r) || r.length < 10 || r.length > 11) throw setupError('broken');
            const vals = r.slice(4, 10);
            if (!vals.every(Number.isFinite) || !(vals[0] > 0) || !(vals[1] >= 0)) throw setupError('broken');
            const kind = typeof r[2] === 'string' && hasOwn(KINDS, r[2]) ? r[2] : 'custom';
            const o = i * SNAP_W;
            const id = r[0];
            if (Number.isInteger(id) && id > 0 && id <= 1e9 && !ids.has(id)) { ids.add(id); num[o] = id; maxId = Math.max(maxId, id); } else renumber.push(o);
            for (let k = 0; k < 6; k++) num[o + 1 + k] = vals[k];
            const grp = r.length > 10 ? r[10] : 0;
            num[o + 7] = Number.isInteger(grp) && grp > 0 && grp <= 1e9 ? grp : 0;
            maxGrp = Math.max(maxGrp, num[o + 7]);
            names[i] = typeof r[1] === 'string' && r[1].trim() ? r[1].trim().slice(0, 40) : KINDS[kind].name;
            kinds[i] = kind;
            colors[i] = typeof r[3] === 'string' && /^#[0-9a-f]{6}$/i.test(r[3]) ? r[3] : (KINDS[kind].color || KINDS.custom.color);
        }
        for (const o of renumber) num[o] = ++maxId;
        let key = typeof d.sc === 'string' ? d.sc : '';
        const seed = randomSeed(key);
        if (seed) randomSceneKey(seed); else if (!hasOwn(SCENES, key) || isRandomKey(key)) key = 'empty';
        const def = SCENES[key];
        const fin = (v, dflt) => (Number.isFinite(v) ? v : dflt);
        const idOf = (v) => (ids.has(v) ? v : null);
        const pairs = [], paired = new Set(), pieces = new Set();
        for (let i = 0; i < n; i++) if (num[i * SNAP_W + 7]) pieces.add(num[i * SNAP_W]);
        for (const q of Array.isArray(d.pr) ? d.pr : []) {
            if (!Array.isArray(q) || !ids.has(q[0]) || !ids.has(q[1]) || q[0] === q[1] || paired.has(q[0])) continue;
            // (many pieces of a torn-apart body can share a host)
            if (!pieces.has(q[0]) && paired.has(q[1])) continue;
            paired.add(q[0]);
            if (!pieces.has(q[0])) paired.add(q[1]);
            pairs.push([q[0], q[1], q[2] ? 1 : 0]);
        }
        const groupE = (Array.isArray(d.ge) ? d.ge : []).filter((q) => Array.isArray(q) && Number.isInteger(q[0]) && Number.isFinite(q[1])).map((q) => [q[0], q[1]]);
        const vw = Array.isArray(d.vw) ? d.vw : [], sca = Array.isArray(d.sca) ? d.sca : [];
        const raw = d.set && typeof d.set === 'object' ? d.set : {};
        const flag = (v, dflt) => (v === 0 || v === 1 || typeof v === 'boolean' ? !!v : dflt);
        const flagAt = (v, i, dflt) => (Array.isArray(v) ? flag(v[i], dflt) : dflt);
        const s = {
            num, names, kinds, colors, n, t: Math.max(0, fin(d.t, 0)), samples: 0, epoch: -1,
            customCount: Number.isInteger(d.cc) && d.cc >= 0 ? d.cc : 0,
            scene: key, sel: idOf(d.sel), frame: idOf(d.fr), pairs, groupE,
            turn: Array.isArray(d.ro) && idOf(d.ro[0]) !== null && idOf(d.fr) !== null && d.ro[0] !== d.fr ? { a: d.ro[0], up: fin(d.ro[1], 0) } : null,
            forceRef: fin(sca[0], 0) > 0 ? sca[0] : 1, vRef: fin(sca[1], 0) > 0 ? sca[1] : TAU,
            energyExp: Number.isInteger(sca[2]) && Math.abs(sca[2]) < 400 ? sca[2] : 30,
            trail: Number.isInteger(sca[3]) && sca[3] >= 0 && sca[3] < TRAIL_STEPS.length ? sca[3] : (def.trail !== undefined ? def.trail : 4),
            com: !!sca[4],
            zoom: fin(vw[0], 0) > 0 ? clamp(vw[0], 1e-7, 1e7) : 0.4, panX: fin(vw[1], 0), panY: fin(vw[2], 0)
        };
        const set = {
            sp: fin(raw.sp, 0) > 0 ? clamp(raw.sp, SPEED_STOPS[0], SPEED_STOPS[SPEED_STOPS.length - 1]) : settings.speed,
            re: flag(raw.re, false), me: flag(raw.me, true),
            k: [flagAt(raw.k, 0, false), flagAt(raw.k, 1, false), flagAt(raw.k, 2, false)],
            sh: [flagAt(raw.sh, 0, true), flagAt(raw.sh, 1, true), flagAt(raw.sh, 2, true),
                flagAt(raw.sh, 3, false), flagAt(raw.sh, 4, false), flagAt(raw.sh, 5, false), flagAt(raw.sh, 6, false)],
            st: flag(raw.st, false),
            pl: ['circular', 'keep', 'rest', 'throw'].includes(raw.pl) ? raw.pl : 'circular'
        };
        return { s, set, acc: clamp(fin(d.acc, 0), 0, def.Tref), maxGrp };
    }

    function toBase64Url(bytes) {
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function fromBase64Url(text) {
        let s = text.replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function canCompress() {
        try { return typeof CompressionStream === 'function' && !!new CompressionStream('deflate-raw'); } catch (e) { return false; }
    }

    // Bytes through a (de)compression stream, stopping at limit bytes (a doctored link mustn't unpack
    // into gigabytes)
    async function pipeBytes(bytes, stream, limit) {
        const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
        const parts = [];
        let size = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (limit && size > limit) { reader.cancel().catch(() => {}); throw setupError('broken'); }
            parts.push(value);
        }
        const out = new Uint8Array(size);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }

    // The part of a link after #setup=
    async function encodeSetup(json) {
        const bytes = new TextEncoder().encode(json);
        if (canCompress()) {
            try { return `${SETUP_VERSION}z.${toBase64Url(await pipeBytes(bytes, new CompressionStream('deflate-raw')))}`; } catch (e) { /* the plain form below */ }
        }
        return `${SETUP_VERSION}j.${toBase64Url(bytes)}`;
    }

    async function decodeSetup(token) {
        const m = /^(\d{1,4})([zj])\.([A-Za-z0-9_-]+)$/.exec(token || '');
        if (!m) throw setupError(token ? 'broken' : 'none');
        if (+m[1] !== SETUP_VERSION) throw setupError(+m[1] > SETUP_VERSION ? 'newer' : 'broken');
        let bytes;
        try { bytes = fromBase64Url(m[3]); } catch (e) { throw setupError('broken'); }
        if (m[2] === 'z') {
            let stream;
            try { stream = new DecompressionStream('deflate-raw'); } catch (e) { throw setupError('browser'); }
            try { bytes = await pipeBytes(bytes, stream, SETUP_MAX_BYTES); } catch (e) { throw e && e.setup ? e : setupError('broken'); }
        }
        let json;
        try { json = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { throw setupError('broken'); }
        return readSetup(json);
    }

    async function makeShareLink() {
        return `${location.href.split('#')[0]}#setup=${await encodeSetup(setupJson(snapshot()))}`;
    }

    // The setup part of a link, or of the page's own hash
    function setupToken(url) {
        const s = String(url || ''), i = s.indexOf('#setup=');
        return i < 0 ? null : s.slice(i + 7).replace(/\s+/g, '');
    }

    // Put a setup in place of the system, paused: a step in the edit history (like a change of scene),
    // so Undo brings back what was there. The settings it carries aren't part of the history.
    function applySetup(st, label, note) {
        flushEdit();
        dragging();
        if (hist.pending) { const p = hist.pending; hist.pending = null; commitStep(p.snap, p, false); }
        closePopover();
        endAllDrags();
        if (bodies.length) commitStep(snapshot(), { label, target: null, key: 'scene' }, false);
        const s = st.s;
        showRandomOption(s.scene);
        applySettings(st.set);       // first, so the forces worked out next are the right kind
        restoreSnapshot(s, 'undo');
        sceneFromSnapshot(s);        // the scene's scales, even if it is the scene already showing
        acc = st.acc;
        nextId = Math.max(nextId, st.maxGrp + 1);
        const has = (id) => id !== null && bodies.some((b) => b.id === id);
        selectedId = has(s.sel) ? s.sel : defaultSubject();
        frameId = has(s.frame) ? s.frame : null;
        restoreTurning(s.turn && has(s.turn.a) ? s.turn : null);   // (a rotating frame, as it was: no glide)
        view.zoom = s.zoom; view.panX = s.panX; view.panY = s.panY; view.anim = null;
        k2.bid = null;
        refreshBodyLists();
        updateTrailLabel();
        resetCharts();
        syncEccentricity(true);
        hist.epoch++;
        Object.assign(hist, { cleanLoad: false, rwStale: true, rwFresh: false, rwFromStart: false, open: null });
        updateHistoryUi();
        setPaused(true);
        updateScale();
        updateDrawnPositions();
        timedHint(note, 7000);
        missionFromSetup(s);
    }

    function applySettings(set) {
        const check = (el, key, v) => { settings[key] = !!v; if (el) el.checked = settings[key]; };
        paceZoom.was = 0;
        setSpeedValue(set.sp);
        check(ui.realistic, 'realistic', set.re);
        check(ui.merge, 'merge', set.me);
        check(ui.k1, 'k1', set.k[0]); check(ui.k2, 'k2', set.k[1]); check(ui.k3, 'k3', set.k[2]);
        check(ui.forces, 'forces', set.sh[0]); check(ui.velocities, 'velocities', set.sh[1]); check(ui.labels, 'labels', set.sh[2]);
        // (quietly: the note that the setup opened is what the hint line says)
        settings.pulls = set.sh[3]; settings.limits = set.sh[6]; lim.bid = null;
        syncGravityControls();
        setWell(set.sh[4]);
        setLagrange(set.sh[5]);
        setStability(set.st);
        settings.placement = set.pl;
        if (ui.placement) ui.placement.value = set.pl;
        syncPlacementNote();
        forcesDirty = true;
        pred.key = '';
    }

    const OPEN_NOTE = (what) => `<strong>${what}</strong>, paused. Press play, or Undo to go back.`;

    // Open a link's setup. fromHash: it came with the page (or was pasted into its address), so the hash
    // is cleared afterwards and a reload doesn't open it again over any changes. Resolves to { ok, message }.
    async function openSetup(token, fromHash) {
        let st;
        try {
            st = await decodeSetup(token);
        } catch (e) {
            const message = e && e.setup ? e.message : SETUP_ERRORS.broken;
            timedHint(`<strong>That link didn't open a setup.</strong> ${escapeHtml(message)}`, 9000);
            if (fromHash) setPaused(false);
            return { ok: false, message };
        }
        applySetup(st, 'open a shared setup', OPEN_NOTE('Loaded a shared setup'));
        if (fromHash) {
            try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* the hash stays */ }
        }
        return { ok: true, message: 'Loaded a shared setup' };
    }

    // "Copy a link": to the clipboard (a ClipboardItem can wait for the link to be packed, which Safari
    // needs to count it as part of the click), else writeText, else the link in a box to copy by hand
    async function copyShareLink() {
        if (share.copying) return;
        share.copying = true;
        const n = bodies.length;
        const made = makeShareLink();
        let ok = false, link = '';
        try {
            if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem === 'function') {
                await navigator.clipboard.write([new ClipboardItem({ 'text/plain': made.then((l) => new Blob([l], { type: 'text/plain' })) })]);
                ok = true;
            }
        } catch (e) { ok = false; }
        try { link = await made; } catch (e) { share.copying = false; flashNote(ui.shareNote, 'Sorry: the link could not be made.'); return; }
        if (!ok) {
            try { await navigator.clipboard.writeText(link); ok = true; } catch (e) { ok = false; }
        }
        share.link = link;
        if (ui.shareField) {
            ui.shareField.value = link;
            ui.shareField.hidden = ok;
            if (!ok) {
                ui.shareField.focus();
                ui.shareField.select();
                try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            }
        }
        const kb = `${Math.max(1, Math.round(link.length / 1024)).toLocaleString('en-US')} KB`;
        let msg = ok ? 'Link copied.' : 'Copy the link from the box below.';
        if (link.length > LONG_LINK) {
            msg = `${ok ? 'Link copied, but it is' : 'This link is'} long (${kb}, ${n.toLocaleString('en-US')} ${n === 1 ? 'body' : 'bodies'}): some apps cut long links short.${ok ? '' : ' Copy it from the box below.'}`;
        }
        flashNote(ui.shareNote, msg);
        share.copying = false;
    }

    // ------------------------------------------------------------------
    // Autosave, and "Carry on where you left off"
    // ------------------------------------------------------------------
    // Not a built-in scene that hasn't been touched (it is one click away anyway), nor half-way
    // through moving a body
    const saveEligible = () => bodies.length > 0 && (isRandomKey(settings.scene) || !hist.cleanLoad) && !editing() && !mission.def;   // (a mission mustn't take the place of your own system)
    const autosaveSignature = () => `${editSignature()}#${settingsSignature()}`;

    function autosaveTick(now) {
        const sv = share.save;
        const sig = autosaveSignature();
        if (sig !== sv.sig) { sv.sig = sig; sv.due = now + SAVE_QUIET_MS; }
        else if (!sv.due && !paused && now - sv.lastAt >= SAVE_EVERY_MS && simTime !== sv.lastT) sv.due = now;
        // (a change made while a save is being written out waits for it to finish)
        if (sv.due && now >= sv.due && !sv.job && !editing()) { sv.due = 0; startSave(); }
    }

    // The copy is taken now; it is written out in slices while the browser is idle
    function startSave() {
        const sv = share.save;
        if (sv.job || !saveEligible()) return;
        const s = snapshot();
        sv.job = { s, head: JSON.stringify(setupHead(s)), parts: [], i: 0, sig: sv.sig };
        whenIdle(stepSave);
    }

    // One slice: SAVE_CHUNK bodies, or (once they are all written) the save itself
    function stepSave() {
        const sv = share.save, job = sv.job;
        if (!job) return;
        const t0 = performance.now();
        if (job.i < job.s.n) {
            const end = Math.min(job.s.n, job.i + SAVE_CHUNK), rows = [];
            for (let i = job.i; i < end; i++) rows.push(setupRow(job.s, i));
            job.parts.push(JSON.stringify(rows).slice(1, -1));
            job.i = end;
            sv.sliceMs = Math.max(sv.sliceMs, performance.now() - t0);
            whenIdle(stepSave);
            return;
        }
        sv.job = null;
        writeSave(`${job.head.slice(0, -1)},"b":[${job.parts.join(',')}]}`, job);
        sv.writeMs = Math.max(sv.writeMs, performance.now() - t0);
    }

    function writeSave(json, job) {
        const sv = share.save;
        sv.ok = storeSet(SAVE_KEY, `${Date.now()}|${json}`);
        sv.lastAt = performance.now();
        sv.lastT = job.s.t;
        sv.savedSig = job.sig;
        sv.bytes = json.length;
        sv.count++;
        return sv.ok;
    }

    // Save at once (the page is being left or hidden: no frames to hold up)
    function saveNow() {
        if (!saveEligible()) return false;
        share.save.job = null;
        const s = snapshot();
        return writeSave(setupJson(s), { s, sig: autosaveSignature() });
    }

    function saveOnLeave() {
        saveStabilityBest();
        const sv = share.save;
        if (sv.savedSig !== autosaveSignature() || sv.lastT !== simTime) saveNow();
    }

    // On a visit without a link: offer the last autosave in the hint line for a while
    function offerAutosave() {
        const raw = storeGet(SAVE_KEY);
        const bar = raw ? raw.indexOf('|') : -1;
        if (bar < 0) return;
        let st;
        try { st = readSetup(raw.slice(bar + 1)); } catch (e) { return; }
        const at = +raw.slice(0, bar);
        const what = `${sceneLabel(st.s.scene)}, ${st.s.n.toLocaleString('en-US')} ${st.s.n === 1 ? 'body' : 'bodies'}${at > 0 ? `, ${fmtAge(Date.now() - at)}` : ''}`;
        share.offer = st;
        share.offerHtml = `<button type="button" class="orb-carry-on" title="${escapeHtml(`Carry on where you left off: ${what}`)}"><span class="icon solid fa-history" aria-hidden="true"></span>Carry on where you left off</button>`
            + `<span class="orb-carry-what">${escapeHtml(what)}</span>`
            + '<button type="button" class="orb-carry-x" aria-label="No thanks" title="No thanks"><span class="icon solid fa-times" aria-hidden="true"></span></button>';
        clearTimeout(share.offerTimer);
        share.offerTimer = setTimeout(endOffer, OFFER_MS);
        refreshHint();
    }

    // The hint line's usual text while the offer stands (so a tap elsewhere doesn't take it away)
    function carryOnHint() { return share.offer ? share.offerHtml : ''; }

    function endOffer() {
        if (!share.offer) return;
        share.offer = null;
        share.offerHtml = '';
        clearTimeout(share.offerTimer);
        refreshHint();
    }

    function onHintClick(e) {
        const t = e.target && e.target.closest ? e.target : null;
        if (!t) return;
        if (t.closest('.orb-carry-on')) {
            const st = share.offer;
            endOffer();
            if (st) applySetup(st, 'carry on where you left off', OPEN_NOTE('Carried on where you left off'));
        } else if (t.closest('.orb-carry-x')) {
            endOffer();
        } else if (t.closest('.orb-hint-zoom')) {
            clearHint('note');
            zoomChosen();
        } else if (t.closest('.orb-hint-help')) {
            openHelp(false);
        } else if (t.closest('.orb-hint-again')) {
            runAgain();
        }
    }

    // ------------------------------------------------------------------
    // Stability timer
    // ------------------------------------------------------------------
    // The energy per unit reduced mass of b relative to the rest of the system (two bodies: b, and the
    // rest gathered at its centre of mass), from the totals c; restR is set to the distance between them
    let restR = 0;
    function restEnergy(b, c) {
        const Mr = c.M - b.m;
        if (!(Mr > 0)) { restR = 0; return -Infinity; }
        const rx = (c.M * c.x - b.m * b.x) / Mr, ry = (c.M * c.y - b.m * b.y) / Mr;
        const rvx = (c.M * c.vx - b.m * b.vx) / Mr, rvy = (c.M * c.vy - b.m * b.vy) / Mr;
        const dvx = b.vx - rvx, dvy = b.vy - rvy;
        restR = Math.hypot(b.x - rx, b.y - ry);
        return 0.5 * (dvx * dvx + dvy * dvy) - (G * c.M) / Math.max(restR, 1e-300);
    }

    function stabilityReset() {
        saveStabilityBest();
        const c = totals(bodies);
        let ext = 0;
        stab.boundAtStart.clear();
        stab.unbound.clear();
        for (const b of bodies) {
            ext = Math.max(ext, Math.hypot(b.x - c.x, b.y - c.y));
            // (a planet of one star of a wide pair can seem unbound from the rest as a whole)
            if (b.bound || restEnergy(b, c) < 0) stab.boundAtStart.add(b.id);
        }
        Object.assign(stab, {
            running: true, scene: settings.scene, t0: simTime, lastT: simTime, ended: null, goalNoted: false, bestBefore: Object.assign({}, stab.best),
            rEject: STAB_EJECT * Math.max(ext, 1e-12), counts: bodies.length >= 3,
            label: sceneLabel(settings.scene) + (hist.cleanLoad ? '' : ', changed')
        });
    }

    // Start the timer again if the system has been changed since it last looked (any edit, undo, run
    // again or new scene, or the physics switched); returns true if it did
    function stabilityRestart(now) {
        const sig = `${editSignature()}|${+settings.merge}${+settings.realistic}`;
        const edit = editing();
        if (stab.running && !edit && sig === stab.sig && simTime >= stab.lastT) return false;
        // (said on the card only if a run was under way in this scene)
        const changed = stab.running && stab.scene === settings.scene && (!!stab.ended || stab.lastT > stab.t0);
        stabilityReset();
        if (changed || (edit && now - stab.restartedAt < 4000)) stab.restartedAt = now;
        stab.sig = sig;
        return true;
    }

    // Four times a second: start again after any change, else look for a body flung out and keep the best
    function stabilityTick(now) {
        if (!settings.stability) {
            if (stab.running) { saveStabilityBest(); stab.running = false; }
            return;
        }
        if (stabilityRestart(now)) return;
        stab.lastT = simTime;
        if (stab.ended) return;
        checkEjections();
        if (stab.ended) return;
        // Only time before any body came unbound is sure to count (it may be on its way out)
        let since = simTime;
        for (const t of stab.unbound.values()) if (t < since) since = t;
        const yrs = since - stab.t0;
        if (noteBest(yrs) && now - stab.bestSavedAt > 10000) saveStabilityBest();
        if (!stab.goalNoted && stab.counts && yrs >= STAB_GOAL) {
            stab.goalNoted = true;
            saveStabilityBest();
            timedHint(`<strong>Still stable after ${STAB_GOAL.toLocaleString('en-US')} years.</strong> Challenge met!`, 8000);
        }
    }

    // A body bound to something heavier (inside its Hill sphere) isn't leaving; any other is tested
    // against the rest of the system
    function checkEjections() {
        if (bodies.length < 2) return;
        const c = totals(bodies);
        for (const b of bodies) {
            if (b.bound || b.held || b.grp || restEnergy(b, c) < 0) { stab.unbound.delete(b.id); continue; }
            if (!stab.unbound.has(b.id)) stab.unbound.set(b.id, simTime);
            if (restR > stab.rEject) {
                endStability(stab.boundAtStart.has(b.id) ? 'flung' : 'left', b, null, stab.unbound.get(b.id));
                return;
            }
        }
    }

    // (from mergeBodies and disrupt, in the middle of a step: just note it, after catching up with a
    // change made since the last look, such as a planet dropped onto its star)
    function noteCollision(big, small) {
        if (!settings.stability) return;
        stabilityRestart(performance.now());
        if (!stab.ended) endStability(big.kind === 'blackhole' ? 'swallowed' : 'hit', small, big, simTime);
    }

    function noteTornApart(L, H) {
        tornNews = { L, H, chosen: selectedId === L.id };
        if (!settings.stability) return;
        stabilityRestart(performance.now());
        if (!stab.ended) endStability('torn', L, H, simTime);
    }

    function endStability(kind, a, other, t) {
        const years = Math.max(0, t - stab.t0);
        stab.ended = { kind, a: a.name, b: other ? other.name : '', years };
        const best = noteBest(years);
        saveStabilityBest();
        timedHint(`<strong>${escapeHtml(eventText(stab.ended, fmtSpan(years)))}.</strong> ${best ? 'A new best!' : stab.best.yr > 0 ? `Your best: ${fmtYears(stab.best.yr)}.` : ''}`, 8000);
    }

    function eventText(e, dur) {
        switch (e.kind) {
            case 'flung': return `${e.a} was flung out after ${dur}`;
            case 'left': return `${e.a} left the system after ${dur}`;
            case 'swallowed': return `${e.b} swallowed ${e.a} after ${dur}`;
            case 'torn': return `${e.a} was torn apart after ${dur}`;
            default: return `${e.a} hit ${e.b} after ${dur}`;
        }
    }

    function readBest() {
        try {
            const b = JSON.parse(storeGet(BEST_KEY));
            if (b && Number.isFinite(b.yr) && b.yr > 0) return { yr: b.yr, label: typeof b.label === 'string' ? b.label.slice(0, 60) : '' };
        } catch (e) { /* none yet, or unreadable */ }
        return { yr: 0, label: '' };
    }

    // A best counts with three bodies or more (two alone keep their orbit for ever)
    function noteBest(yrs) {
        if (!stab.counts || !(yrs > stab.best.yr)) return false;
        stab.best = { yr: yrs, label: stab.label };
        stab.bestDirty = true;
        return true;
    }

    function saveStabilityBest() {
        if (!stab.bestDirty) return;
        stab.bestDirty = false;
        stab.bestSavedAt = performance.now();
        storeSet(BEST_KEY, JSON.stringify(stab.best));
    }

    // The card at the top of the top-right stack, while the timer is on
    function stabilityLines(compact) {
        if (!settings.stability || !stab.running) return null;
        const C = colours();
        const seed = randomSeed(settings.scene);
        const e = stab.ended;
        const dur = fmtSpan(Math.max(0, e ? e.years : simTime - stab.t0));
        const lines = [[[seed ? `System #${seed}: ` : 'Stability: ', true, C.kepler], [e ? eventText(e, dur) : `stable for ${dur}`]]];
        // (the best is the one from before this run: this run beating it is news)
        const before = stab.bestBefore, goal = stab.best.yr >= STAB_GOAL ? ', goal met' : ` · goal ${fmtYears(STAB_GOAL)}`;
        let note;
        if (performance.now() - stab.restartedAt < 4000) note = 'Restarted: you changed the system';
        else if (!stab.counts) note = 'A best needs three bodies or more';
        else if (!(before.yr > 0)) note = compact ? `Goal: ${fmtYears(STAB_GOAL)}` : `Can you build one that lasts ${fmtYears(STAB_GOAL)}?`;
        else if (stab.best.yr > before.yr) note = `A new best (was ${fmtYears(before.yr)})${goal}`;
        else note = `Your best: ${fmtYears(before.yr)}${!compact && before.label ? ` (${before.label})` : ''}${goal}`;
        lines.push([[note, false, C.subtle]]);
        return lines;
    }

    function drawStabilityCard(C, y, fs, compact) {
        const lines = stabilityLines(compact);
        return lines ? drawCard(C, lines, y, fs) + 5 : y;
    }

    // ------------------------------------------------------------------
    // Data for a spreadsheet (CSV): plain numbers or e-notation, units in the headings, in the scene's
    // own units (AU or km; years, days or seconds)
    // ------------------------------------------------------------------
    function csvUnits() {
        const tu = timeUnit(), km = scene.units === 'km';
        return { t: tu === 'd' ? 'days' : tu, tf: tu === 's' ? YEAR_S : tu === 'd' ? DAYS_PER_YEAR : 1, d: km ? 'km' : 'AU', af: km ? AU_KM : 1 };
    }

    // Eight significant figures; e-notation for very large or small values (never x10 superscripts)
    function csvNum(x) {
        if (x === 0) return '0';
        const ax = Math.abs(x);
        return ax >= 1e-4 && ax < 1e9 ? String(+x.toPrecision(8)) : x.toExponential(7);
    }

    function csvCell(v) {
        if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
        if (typeof v === 'number') return csvNum(v);
        let s = String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;   // a name mustn't be taken for a spreadsheet formula
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }

    const csvText = (head, rows) => `${[head].concat(rows).map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

    // Kepler's 3rd law: every body bound to the chosen body's primary (or to the chosen body, if it is
    // the one at the centre), measured over its last full orbit where it has made one
    function keplerCsv() {
        const U = csvUnits();
        const b = bodyById(selectedId);
        const P = b ? (orbitingBody(b) ? b.primary : b) : heaviest();
        const ratio = `${U.t}^2/${U.d}^3`;
        const head = ['Body', 'Orbits', `a (${U.d})`, `T measured (${U.t})`, `T from its motion (${U.t})`, `a^3 (${U.d}^3)`, `T^2 (${U.t}^2)`,
            `T^2/a^3 (${ratio})`, `Predicted 4pi^2/G(M+m) (${ratio})`];
        const rows = [];
        for (const c of P ? bodies : []) {
            if (c === P || c.primary !== P || !c.bound || c.grp) continue;
            const el = elementsOf(c, P);
            const tr = c.track && c.track.done > 0 ? c.track : null;
            const a = (tr ? tr.a : el.a) * U.af, Tm = tr ? tr.T * U.tf : null, Tk = el.T * U.tf;
            const T = Tm !== null ? Tm : Tk;
            rows.push([c.name, P.name, a, Tm, Tk, a * a * a, T * T, (T * T) / (a * a * a), ((4 * Math.PI * Math.PI) / (G * (P.m + c.m))) * (U.tf * U.tf) / (U.af * U.af * U.af)]);
        }
        rows.sort((r1, r2) => r1[2] - r2[2]);
        return csvText(head, rows);
    }

    // (from sampleCharts, after it adds a point: the graphs' data at full precision)
    function recordGraphPoint(E, b, p) {
        if (charts.energy.data.labels.length === 1) graphData.length = 0;   // the graphs have just started again
        graphData.push({
            t: simTime, ke: E.ke, pe: E.pe, total: E.total, name: b ? b.name : '', around: b && p ? p.name : '',
            r: b && p ? Math.hypot(b.x - p.x, b.y - p.y) : NaN, v: b && p ? Math.hypot(b.vx - p.vx, b.vy - p.vy) : NaN
        });
        if (graphData.length > GRAPH_POINTS) graphData.splice(0, GRAPH_POINTS / 10);
    }

    function graphsCsv() {
        const U = csvUnits();
        const head = [`Time (${U.t})`, 'Kinetic energy (J)', 'Potential energy (J)', 'Total energy (J)', 'Chosen body', 'Orbits',
            `Distance from what it orbits (${U.d})`, 'Speed relative to it (km/s)'];
        return csvText(head, graphData.map((q) => [q.t * U.tf, q.ke * ENERGY_J, q.pe * ENERGY_J, q.total * ENERGY_J, q.name, q.around, q.r * U.af, q.v * AUYR_KMS]));
    }

    function bodiesCsv() {
        const U = csvUnits();
        const head = [`Time (${U.t})`, 'Body', 'Mass (kg)', 'Radius (km)', `x (${U.d})`, `y (${U.d})`, 'vx (km/s)', 'vy (km/s)',
            'Orbits', `Distance from what it orbits (${U.d})`, 'Speed relative to it (km/s)', 'Eccentricity'];
        const rows = bodies.map((b) => {
            const p = b.primary, el = p ? elementsOf(b, p) : null;
            return [simTime * U.tf, b.name, b.m * MSUN_KG, b.R, b.x * U.af, b.y * U.af, b.vx * AUYR_KMS, b.vy * AUYR_KMS,
                p ? p.name : '', el ? el.r * U.af : null, el ? el.v * AUYR_KMS : null, el ? el.e : null];
        });
        return csvText(head, rows);
    }

    function csvOf(kind) {
        return kind === 'kepler' ? keplerCsv() : kind === 'graphs' ? graphsCsv() : kind === 'bodies' ? bodiesCsv() : '';
    }

    function downloadCsv(kind, noteEl) {
        const text = csvOf(kind);
        const rows = text ? text.split('\r\n').length - 2 : 0;
        if (rows <= 0) { flashNote(noteEl, CSV_EMPTY[kind] || ''); return false; }
        const seed = randomSeed(settings.scene);
        const name = `orbits-${kind === 'kepler' ? 'kepler3' : kind}-${seed ? `system-${seed}` : settings.scene}.csv`;
        try {
            // (with a byte-order mark, so spreadsheets read the names as UTF-8)
            const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }));
            const a = document.createElement('a');
            a.href = url; a.download = name; a.hidden = true;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        } catch (e) {
            flashNote(noteEl, 'Sorry: this browser couldn\'t save the file.');
            return false;
        }
        flashNote(noteEl, `Downloaded ${name}: ${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}.`);
        return true;
    }

    // ------------------------------------------------------------------
    // Controls, the page's start, and the checks four times a second
    // ------------------------------------------------------------------
    // A folded group of the settings says what it holds: the view, the laws switched on
    function syncFolds() {
        const on = [[ui.k1, '1st'], [ui.k2, '2nd'], [ui.k3, '3rd']].filter((k) => k[0] && k[0].checked).map((k) => k[1]);
        setText(ui.foldKepler, on.join(', '));
        const opt = ui.frame && ui.frame.options[ui.frame.selectedIndex];
        setText(ui.foldFrame, opt ? opt.textContent.replace(' (no body)', '') : '');
    }

    // Everything panned or zoomed out of view: Fit view stands out, and says why once
    let viewLost = null;
    function checkInView() {
        // (zoomed well back out from where a slower time was set: the old speed again)
        if (paceZoom.was && (view.anim ? view.anim.zoom : view.zoom) < 0.5 * paceZoom.zoom) restoreSpeed();
        // (a glide passes through views that show nothing: only where it ends counts)
        if (!ui.fit || !viewW || !bodies.length || dragging()) return;
        const inside = insideOf();   // (panned into a body: everything else is out of view, but that isn't the news)
        const out = !bodies.some((b) => { const x = sx(b.dx), y = sy(b.dy), r = (b.R / AU_KM) * scale; return x > visL - r && x < visR + r && y > -r && y < viewH + r; });
        if (view.anim) {
            if (viewLost === null) ui.fit.classList.toggle('is-wanted', !!view.panned);
            // (a glide that has brought bodies back: the note goes as soon as they show)
            else if (!inside && !out) { viewLost = null; clearHint('note', 'lost'); }
            return;
        }
        ui.fit.classList.toggle('is-wanted', out || !!inside || !!view.panned);   // (moved by hand: the way back stands out too)
        const lost = inside ? inside.id : out ? -1 : null;
        if (lost === viewLost) return;
        viewLost = lost;
        if (inside) showHint('note', `<strong>You are inside ${escapeHtml(theName(inside))}.</strong> Fit view brings it back.`, { tag: 'lost', ms: 6000 });
        else if (out) showHint('note', '<strong>Everything is out of view.</strong> Fit view brings it back.', { tag: 'lost', ms: 6000 });
        else clearHint('note', 'lost');
    }

    function shareTick() {
        const now = performance.now();
        if (scene.progress) refreshHint();
        syncSceneList();
        syncFolds();
        checkInView();
        stabilityTick(now);
        autosaveTick(now);
    }

    // After the first scene has loaded: a link in the address wins over the autosave
    function startShare() {
        share.save.sig = autosaveSignature();
        const token = setupToken(location.hash);
        if (token) { setPaused(true); openSetup(token, true); } else offerAutosave();
    }

    // Scroll the settings just enough to show what has just opened or appeared in them (the page itself stays)
    function revealInPanel(el) {
        const sc = el.closest ? el.closest('.sim-controls-content') : null;
        if (!sc) return;
        requestAnimationFrame(() => {
            const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
            let d = 0;
            if (r.bottom > s.bottom - 8) d = Math.min(r.bottom - s.bottom + 8, r.top - s.top - 8);
            else if (r.top < s.top + 8) d = r.top - s.top - 8;
            if (Math.abs(d) > 1) sc.scrollBy({ top: d, behavior: quickMotion() });
        });
    }

    const quickMotion = () => (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

    // About opens with its heading at the top of the screen; closed again, the page goes back to where
    // it was, as it does for the graphs (see setChartsVisible)
    function bindPageFolds() {
        const about = document.querySelector('details.description-area');
        for (const d of document.querySelectorAll('.sim-controls-content details')) {
            d.addEventListener('toggle', () => { if (d.open) revealInPanel(d); });
        }
        if (!about) return;
        let from = null;
        const sum = about.querySelector('summary');
        about.addEventListener('toggle', () => {
            if (about.open) {
                from = window.scrollY;
                const top = about.getBoundingClientRect().top;
                if (top > 0.3 * window.innerHeight || top < 0) window.scrollBy({ top: top - 8, behavior: quickMotion() });
            } else if (from !== null) {
                window.scrollTo({ top: from, behavior: quickMotion() });
                from = null;
                if (sum) sum.blur();
            }
        });
    }

    function bindShare() {
        bindPageFolds();
        Object.assign(ui, {
            foldKepler: byId('foldKepler'), foldFrame: byId('foldFrame'),
            shareBtn: byId('shareLinkBtn'), randomBtn: byId('randomSystemBtn'), shareNote: byId('shareNote'), shareField: byId('shareLinkField'),
            csvNote: byId('csvNote'), chartCsvBtn: byId('chartCsvBtn'), chartCsvNote: byId('chartCsvNote'), stability: byId('stabilityToggle')
        });
        for (const el of [ui.shareNote, ui.csvNote, ui.chartCsvNote]) if (el) el.dataset.text = el.textContent;
        const onClick = (btn, action) => { if (btn) btn.addEventListener('click', action); };
        onClick(ui.shareBtn, copyShareLink);
        onClick(ui.randomBtn, () => loadRandomSystem(newRandomSeed()));
        document.querySelectorAll('button[data-csv]').forEach((btn) => onClick(btn, () => downloadCsv(btn.dataset.csv, ui.csvNote)));
        onClick(ui.chartCsvBtn, () => downloadCsv('graphs', ui.chartCsvNote));
        if (ui.stability) {
            ui.stability.checked = settings.stability;
            ui.stability.addEventListener('change', () => setStability(ui.stability.checked));
        }
        if (ui.shareField) ui.shareField.addEventListener('focus', () => ui.shareField.select());
        // (capture, on the list's parent: before the list's own change listener)
        if (ui.scene && ui.scene.parentElement) ui.scene.parentElement.addEventListener('change', onSceneChoice, true);
        if (ui.hint) ui.hint.addEventListener('click', onHintClick);
        window.addEventListener('hashchange', () => { const t = setupToken(location.hash); if (t) openSetup(t, true); });
        window.addEventListener('pagehide', saveOnLeave);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveOnLeave(); });
        stab.best = readBest();
        setInterval(shareTick, 250);
        setTimeout(startShare, 0);
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
            pairs: mainPairs.map((q) => [q.a.id, q.b.id, q.fast ? 1 : 0, q.hosted ? 1 : 0]), groupE: Array.from(groupEnergy),
            gwE: gw.radiated, gwP: gw.power,   // (energy carried off by gravitational waves so far, and the rate)
            // The scene's own scales and settings: put back only when a change of scene is undone
            forceRef, vRef, energyExp, trail: settings.trailIndex, com: settings.com,
            zoom: view.zoom, panX: view.panX, panY: view.panY,
            startJD: startDate.jd,   // (the start date of a scene that has one)
            mission: missionSnapshot()   // (the fuel used and the burns, so undo gives fuel back)
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
        restoreStartDate(s);
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
        for (const [ia, ib, fast, hosted] of s.pairs || []) {
            const a = byNewId.get(ia), b = byNewId.get(ib);
            if (a && b) followPair(a, b, !!fast, !!hosted);
        }
        syncHosts();
        groupEnergy.clear();
        for (const [id, u] of s.groupE || []) groupEnergy.set(id, u);
        resetRelativity();
        gw.radiated = s.gwE || 0; gw.power = s.gwP || 0;
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
        clearHint('note', 'chosen');   // (a "Zoom in" for a moon that may no longer be there)
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
        missionRestore(s.mission, how);
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
        hist.as = '';
        if (what) commitStep(p.snap, what, true);
    }

    // A body picked up to move it, or its arrow grabbed to aim it: the step is the whole drag.
    function beginGesture(b, mode) {
        if (!hist.ready || hist.restoring) return;
        flushEdit();
        if (dragging() || hist.pending) return;
        hist.pending = {
            snap: snapshot(), gesture: true, target: b.id, key: mode,
            label: mode === 'aim' ? (mission.def && b.id === mission.craftId ? `fire ${b.name}'s engine` : `change ${b.name}'s velocity`) : `move ${b.name}`
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
        // (the eccentricity slider only turns the velocity, but what it changes is the orbit's shape;
        // in a mission a change to the probe's velocity is a burn)
        if (hist.as === 'shape' && (main.key === 'velocity' || main.key === 'speed')) return { key: 'shape', target: main.b.id, label: `change ${n}'s orbit shape` };
        if (mission.def && main.b.id === mission.craftId && (main.key === 'velocity' || main.key === 'speed')) return { key: 'velocity', target: main.b.id, label: `fire ${n}'s engine` };
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

    // Nothing done in this scene, yet a body has broken up in it: Undo goes back to the scene's start,
    // rather than out of the scene to the one before it
    const tornInScene = () => hist.cleanLoad && hist.rwFromStart && !mission.def && canRunAgain() && bodies.some((b) => b.grp);

    function undoStep() {
        flushEdit();
        if (dragging()) return false;
        if (tornInScene()) {
            restoreSnapshot(hist.rw, 'rewind');
            setReverse(false, true);
            hist.rwFresh = true;
            hist.open = null;
            historyNote('<strong>Undone:</strong> the break-up. Back at the start of the scene.');
            updateHistoryUi();
            return true;
        }
        if (!hist.undo.length) return false;
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
        setReverse(false, true);   // (running again always plays forwards)
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
        if (!b || dragging() || missionRefuse('delete', b)) return;
        if (bodies.length < 2) { historyNote(`<strong>${escapeHtml(b.name)} is the last body.</strong> Add another before deleting it.`); return; }
        const name = b.name;
        if (popBody === b) closePopover();
        deleteBody(b);
        flushEdit();
        historyNote(`<strong>Deleted ${escapeHtml(name)}.</strong> ${KEYS_MOD}Z brings it back.`);
    }

    // A short note in the hint line (read out by screen readers too), until the next one or a few
    // seconds. In a mission it says how the mission is going, so it shows over the mission's guidance.
    function historyNote(html, ms) {
        showHint(mission.def ? 'missionNote' : 'note', html, { ms: ms || 4000 });
    }

    function updateHistoryUi() {
        const u = tornInScene() ? { label: 'the break-up' } : hist.undo[hist.undo.length - 1], r = hist.redo[hist.redo.length - 1];
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
        const onClick = (btn, action) => { if (btn) btn.addEventListener('click', action); };
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
    // Missions: goals a student meets by firing a probe's engine within a fuel (delta-v) budget.
    //   Each mission is a scene of its own (the scene list's "Missions" group, or the Missions button
    //   under it): the bodies, the probe, the body its burns are measured from, a time limit and a
    //   view. It starts at once, paused: the mission console takes the palette's place (the goal in a
    //   line, how it is going, the fuel, the engine, Play or a skip to the next moment that matters),
    //   and the goal is drawn on the canvas. "How it works" gives the physics idea and the par: the
    //   delta-v of the classic way there, worked out from vis-viva, v^2 = GM (2/r - 1/a), and Kepler's
    //   3rd law.
    //   While a mission is loaded only the probe's velocity may change, and only by burns: the engine's
    //   buttons and the arrow keys (held, they keep firing, and the clock waits meanwhile), the menu's
    //   pushes and typed velocity, and aiming its arrow (the clock stops while it is aimed, so it can't
    //   hover). Each burn costs |delta-v| in km/s.
    //   Every edit already goes through keepView (an aimed arrow through endHold), which brackets it
    //   with missionBegin / missionEnd: a copy of every body before, compared after. A change to the
    //   probe's velocity alone is a burn and is charged (cut short if the tank runs dry); anything else
    //   is put back, with a friendly note. Edits that would pass as burns but aren't (the Orbit tab,
    //   the eccentricity slider) and those keepView never sees (adding, deleting, dragging) are refused
    //   where they start (missionRefuse), and their controls are greyed out (missionLockMenu,
    //   missionLockSidebar). Pushes are measured from the mission's reference body (Jupiter when being
    //   captured by it), whatever the probe's primary is.
    //   The fuel used and the burn log are part of the edit history's snapshots (missionSnapshot,
    //   missionRestore), so undo gives the fuel back, redo takes it again, and "run again" replays from
    //   the last burn with the fuel as it was then.
    //   Goals are checked on the simulated state: distances and relative speeds every step (a few
    //   multiplications, so a fast pass through Mars's Hill sphere is never stepped over), orbit
    //   elements every ORBIT_CHECK_EVERY steps and after each burn. The console, the hint line and the
    //   results are updated ten times a second, with the readouts.
    //   Leaving goes back to the system, speed and view it was started from (missionKeepHome, leaveMission).
    // ------------------------------------------------------------------
    const MISSION_STORE = 'orbitsMissions';  // localStorage: the best result of each mission
    const STARS_AT = [1.1, 1.35];            // delta-v up to these multiples of par: three stars, two (else one)
    const ORBIT_CHECK_EVERY = 16;            // steps between checks of the orbit elements
    const MSNAP_W = 7;                       // numbers kept per body while an edit is checked: id, m, R, x, y, vx, vy
    // The engine, as shares of the mission's tank: a tap (the first ENGINE_WAIT_MS of a press), a second
    // of holding, and how much smaller fine burns are. So a tank's par burn takes a second or few of holding.
    const ENGINE_TAP = 0.015, ENGINE_HOLD = 0.12, ENGINE_FINE = 0.1;
    const ENGINE_WAIT_MS = 220, ENGINE_EVERY_MS = 50;
    const SKIP_S = 1.5;                      // a skip to the next moment that matters takes about this long to watch
    const MISSION_SPEED_MAX = 2;             // the fastest the clock runs by choice: much faster and time runs out before you can fly (a skip goes faster)
    const PROMISE = 0.98;                    // a tick needs the coming pass inside this share of the goal
    const FINE_FROM = 0.08;                  // share of the tank still to burn at which the hint turns to Fine
    const TAP_FROM = 0.007;                  // and to single taps: letting go late would go right through a narrow goal
    const toKms = (v) => v * AUYR_KMS;
    const f1 = (x) => x.toFixed(1), f2 = (x) => x.toFixed(2);
    const auPlaces = (d) => (d < 0.1 ? 3 : 2);
    const auText = (d) => `${d.toFixed(auPlaces(d))} AU`;
    const auTextUp = (d) => { const n = auPlaces(d), k = Math.pow(10, n); return `${(Math.ceil(d * k - 1e-9) / k).toFixed(n)} AU`; };
    const starText = (n) => '★★★☆☆☆'.slice(3 - n, 6 - n);

    // The two burns of a Hohmann transfer between circular orbits of radii r1 and r2 round the Sun
    // (km/s), and its time (half the transfer ellipse's period, years): vis-viva gives the speeds at
    // the two ends of the ellipse, whose semi-major axis is a = (r1 + r2) / 2.
    function hohmann(r1, r2) {
        const a = 0.5 * (r1 + r2);
        const c1 = Math.sqrt(G / r1), c2 = Math.sqrt(G / r2);
        const e1 = Math.sqrt(G * (2 / r1 - 1 / a)), e2 = Math.sqrt(G * (2 / r2 - 1 / a));
        return { dv1: toKms(Math.abs(e1 - c1)), dv2: toKms(Math.abs(c2 - e2)), a, T: 0.5 * Math.pow(a, 1.5) };
    }

    // The missions, easy to hard. Each: its scene (as in SCENES), the probe, the reference body and the
    // target (indices into the scene's bodies), the fuel budget and par (km/s), the time limit (years),
    // the size of the first burn, where a hint needs to give it (aim, km/s), the goal, and the words: the
    // goal in a line, the idea and how par is worked out (on request), what it teaches, hints.
    //   goal types: orbit (a near-circle of radius r, within tol of it, round the reference body),
    //   escape (unbound from it), capture (bound to it, never farther than lim), reach (inside the
    //   target's Hill sphere, zone) and meet (within D of the target, moving within V of it; a tick also
    //   needs the path to arrive within arrive of its speed, as a burn to match any faster pass costs a
    //   star; l4: within D of the point 60 degrees ahead of the target, on an orbit of its size a to within
    //   da and with an eccentricity under eMax: a passing moment of slow relative motion isn't parking).
    const MISSIONS = (function () {
        const up = hohmann(1, 1.5), down = hohmann(1, 0.723), mars = hohmann(1, 1.524);
        // Escape from a 0.3 x 3 AU ellipse: escape speed sqrt(2GM/r) less the speed there
        const ea = 1.65, ee = 2.7 / 3.3;
        const vPeri = Math.sqrt(G * (2 / 0.3 - 1 / ea)), vApo = Math.sqrt(G * (2 / 3 - 1 / ea));
        const escPeri = toKms(Math.sqrt(2 * G / 0.3) - vPeri), escApo = toKms(Math.sqrt(2 * G / 3) - vApo);
        // Capture by Jupiter: arriving as from a Hohmann transfer from 1 AU (5.6 km/s relative to
        // Jupiter far out), on a hyperbola whose closest point is 0.02 AU (3 million km) from it,
        // starting 0.15 AU out. The hyperbola comes in from ahead of Jupiter, as that arrival does.
        // Braking at the closest point to an orbit reaching out to half Jupiter's Hill radius (beyond
        // that the Sun's pull would soon take it away again): vis-viva at both ends of that orbit.
        const muJ = G * MJUP, vJ = Math.sqrt(G * (1 + MJUP) / 5.2);
        const vInf = vJ - Math.sqrt(G * (2 / 5.2 - 1 / 3.1));
        const cRp = 0.02, c0 = 0.15, hillJ = 5.2 * Math.cbrt(MJUP / 3), cLim = 0.5 * hillJ;
        const cA = -muJ / (vInf * vInf), cE = 1 + cRp * vInf * vInf / muJ, cP = cA * (1 - cE * cE);
        const cNuInf = Math.acos(-1 / cE) / DEG, cNu0 = -Math.acos((cP / c0 - 1) / cE) / DEG;
        const cVp = Math.sqrt(vInf * vInf + 2 * muJ / cRp), cVcap = Math.sqrt(2 * muJ * cLim / (cRp * (cRp + cLim)));
        // Mars: its Hill radius a (m / 3M)^(1/3), 1.1 million km; the phase for a Hohmann transfer:
        // Mars must be 180 degrees less what it covers during the transfer ahead
        const marsHill = 1.524 * Math.cbrt(KINDS.mars.m / 3);
        const marsLead = 180 - 360 * mars.T / Math.pow(1.524, 1.5);
        // Rendezvous: one lap of an orbit 1/12 shorter (11 months), so 30 degrees are gained
        const rT = 11 / 12, rA = Math.cbrt(rT * rT), rDv = toKms(Math.sqrt(G) - Math.sqrt(G * (2 - 1 / rA)));
        // L4: one lap of an orbit 1/12 longer than Jupiter's, so 30 degrees are lost
        const TJ = TAU * Math.sqrt(Math.pow(5.2, 3) / (G * (1 + MJUP))), lT = TJ * 13 / 12;
        const lA = Math.cbrt(G * lT * lT / (TAU * TAU)), lDv = toKms(Math.sqrt(G * (2 / 5.2 - 1 / lA)) - Math.sqrt(G / 5.2));
        const sun = { kind: 'sun' }, probe = (orbit) => ({ kind: 'probe', orbit });
        return [
            {
                id: 'raise', title: 'Raise your orbit',
                scene: { units: 'au', Tref: 1, subject: 1, box: [-1.75, 1.75, -1.75, 1.75], bodies: [sun, probe({ around: 0, a: 1, e: 0, nu: 0 })] },
                craft: 1, ref: 0, target: null, budget: 9, limit: 5, par: up.dv1 + up.dv2,
                goal: { type: 'orbit', r: 1.5, tol: 0.05 },
                goalText: 'Reach a round orbit on the ring.',
                idea: 'A burn forwards lifts the far side of your orbit. Burn once to reach the ring, then again at the far point to round it off: a Hohmann transfer, the cheapest way up.',
                parText: `${f1(up.dv1)} km/s out to 1.5 AU, then ${f1(up.dv2)} km/s at the far point, from v² = GM(2/r − 1/a).`,
                teach: 'That was a Hohmann transfer: speeding up at one end of an orbit raises the other end.',
                hint: (x) => transferHint(x, 1.5, 0.05, true),
                fail: { fuel: 'Two burns are enough: forwards at the start, then forwards again at the far point.', crash: 'Burning backwards drops you towards the Sun.', time: 'Burn forwards until your orbit reaches the ring, then skip to the far point and burn again.' }
            },
            {
                id: 'venus', title: 'Down to Venus\'s orbit',
                scene: { units: 'au', Tref: 1, subject: 1, box: [-1.2, 1.2, -1.2, 1.2], bodies: [sun, probe({ around: 0, a: 1, e: 0, nu: 0 })] },
                craft: 1, ref: 0, target: null, budget: 9, limit: 5, par: down.dv1 + down.dv2,
                goal: { type: 'orbit', r: 0.723, tol: 0.05 },
                goalText: 'Drop to a round orbit on the ring.',
                idea: 'To go down, slow down: a burn backwards lowers the far side of your orbit. Burn backwards again at the closest point to round it off. You speed up as you fall.',
                parText: `${f1(down.dv1)} km/s backwards down to 0.72 AU, then ${f1(down.dv2)} km/s backwards at the closest point, from v² = GM(2/r − 1/a).`,
                teach: 'You slowed down twice, yet you are now faster than when you started: lower orbits are quicker.',
                hint: (x) => transferHint(x, 0.723, 0.05, false),
                fail: { fuel: 'Two burns are enough: backwards at the start, then backwards again at the closest point.', crash: 'Too much braking: you fell into the Sun. Burn backwards less.', time: 'Burn backwards until your orbit dips to the ring, then skip to the closest point and burn again.' }
            },
            {
                id: 'escape', title: 'Escape the Sun',
                scene: { units: 'au', Tref: 1, subject: 1, box: [-3.3, 0.65, -1.25, 1.25], bodies: [sun, probe({ around: 0, a: ea, e: ee, w: 0, nu: 180 })] },
                craft: 1, ref: 0, target: null, budget: 8, limit: 2.5, par: escPeri,
                goal: { type: 'escape' },
                goalText: 'Escape the Sun on as little fuel as you can.',
                idea: 'A burn adds the most energy where you are moving fastest (the Oberth effect). So wait until you swing closest to the Sun, then burn forwards.',
                parText: `at 0.3 AU you move at ${f1(toKms(vPeri))} km/s and escaping takes ${f1(toKms(Math.sqrt(2 * G / 0.3)))} km/s (√(2GM/r)): ${f1(escPeri)} km/s more. Out at 3 AU it would take ${f1(escApo)} km/s.`,
                teach: 'The same burn gives more energy when you are moving fast, which is why spacecraft burn close to a planet or the Sun.',
                hint: escapeHint,
                fail: { fuel: 'Burn at the closest point to the Sun: there the same burn adds far more energy.', time: 'Skip to the closest point to the Sun, then burn forwards.', crash: 'Burning backwards sends you into the Sun.' }
            },
            {
                id: 'capture', title: 'Captured by Jupiter',
                scene: {
                    units: 'au', time: 'd', Tref: 0.1, subject: 2, forceBody: 1, vref: 1.5, trail: 5, box: [-0.24, 0.24, -0.24, 0.24],
                    bodies: [sun, { kind: 'jupiter', orbit: { around: 0, a: 5.2, e: 0, nu: 0 } },
                        probe({ around: 1, a: cA, e: cE, w: 90 + cNuInf, nu: cNu0 })]
                },
                craft: 2, ref: 1, target: null, lock: 1, budget: 5, limit: 0.6, par: toKms(cVp - cVcap),
                goal: { type: 'capture', lim: cLim, hill: hillJ },
                goalText: 'Brake to stay in orbit round Jupiter, inside the ring.',
                idea: 'Brake where you are moving fastest, at the closest point to Jupiter: there each km/s takes away the most energy (the Oberth effect again).',
                parText: `at the closest point, ${Math.round(cRp * AU_KM / 1e6)} million km from Jupiter, slow from ${f1(toKms(cVp))} to ${f1(toKms(cVcap))} km/s: an orbit that stays inside the ring (from v² = GM(2/r − 1/a)).`,
                teach: 'You braked at the closest point, where it counts most. The Juno probe was captured by Jupiter in just this way.',
                hint: captureHint,
                fail: { fuel: 'Brake at the closest point to Jupiter, where it counts most.', missed: 'Skip to the closest point, then hold Back until Jupiter keeps you.', crash: 'You hit Jupiter! Try a gentler burn.' }
            },
            {
                id: 'mars', title: 'Get to Mars',
                scene: {
                    units: 'au', Tref: 1, subject: 2, forceBody: 1, box: [-1.75, 1.75, -1.75, 1.75],
                    bodies: [sun, { kind: 'mars', orbit: { around: 0, a: 1.524, e: 0, nu: 100 } }, probe({ around: 0, a: 1, e: 0, nu: 0 })]
                },
                craft: 2, ref: 0, target: 1, budget: 6, limit: 2, par: mars.dv1, aim: mars.dv1, lead: marsLead,
                goal: { type: 'reach', zone: marsHill },
                goalText: 'Fly to Mars, and get inside the ring round it.',
                idea: `One burn forwards stretches your orbit out to Mars's. Mars moves on while you fly, so wait for the launch window, when it is about ${Math.round(marsLead)}° ahead.`,
                parText: `the one burn, ${f1(mars.dv1)} km/s. The trip takes ${Math.round(mars.T * 12)} months (Kepler's 3rd law), and Mars moves ${Math.round(180 - marsLead)}° in that time, so it must start ${Math.round(marsLead)}° ahead.`,
                teach: 'Launch windows: Mars has to be in the right place when you set off. For real missions to Mars that happens every 26 months.',
                hint: marsHint,
                fail: { fuel: 'One burn of about 3 km/s, at the launch window, is nearly all it takes. Fine burns then tune it.', time: 'Skip to the launch window, burn until your closest approach is inside the goal, then skip to Mars.' }
            },
            {
                id: 'station', title: 'Catch the station',
                scene: {
                    units: 'au', Tref: 1, subject: 2, box: [-1.25, 1.25, -1.25, 1.25],
                    bodies: [sun, { kind: 'probe', name: 'Station', color: '#ae85ca', orbit: { around: 0, a: 1, e: 0, nu: 30 } }, probe({ around: 0, a: 1, e: 0, nu: 0 })]
                },
                craft: 2, ref: 0, target: 1, budget: 4, limit: 1.6, par: 2 * rDv, aim: rDv,
                goal: { type: 'meet', D: 0.02, V: 0.3 / AUYR_KMS, arrive: 1.1 / AUYR_KMS },
                goalText: 'Catch the station, 30° ahead of you, and match its speed.',
                idea: 'Speeding up raises your orbit and makes each lap longer, so you fall behind. To catch up, slow down: a smaller orbit is a quicker lap.',
                parText: `slow down ${f1(rDv)} km/s. Your smaller orbit takes 11 months instead of 12 (Kepler's 3rd law), so one lap gains 30°. Then speed up ${f1(rDv)} km/s to match the station.`,
                teach: 'Slow down to catch up: a lower orbit takes less time. Spacecraft meeting a space station use the same trick.',
                hint: stationHint,
                fail: { fuel: `Slow down about ${f1(rDv)} km/s, skip to the station, then follow the arrow to match its speed.`, time: `Slow down about ${f1(rDv)} km/s at the start: that smaller orbit brings you to the station in one lap.` }
            },
            {
                id: 'l4', title: 'Park at L4',
                scene: {
                    units: 'au', Tref: 11.86, subject: 2, forceBody: 1, box: [-6.3, 6.3, -6.3, 6.3],
                    bodies: [sun, { kind: 'jupiter', orbit: { around: 0, a: 5.2, e: 0, nu: 0 } }, probe({ around: 0, a: 5.2, e: 0, nu: 90 })]
                },
                craft: 2, ref: 0, target: 1, budget: 2, limit: 20, par: 2 * lDv, aim: lDv,
                goal: { type: 'meet', D: 0.3, l4: true, a: 5.2, da: 0.01, eMax: 0.03 },
                goalText: 'Park at L4, 60° ahead of Jupiter, on an orbit like Jupiter\'s.',
                idea: 'At L4 the Sun\'s and Jupiter\'s pulls keep Trojan asteroids in step with Jupiter. You start 90° ahead. A slightly bigger orbit takes longer, so you slip back to L4; then a burn settles you there.',
                parText: `speed up ${f2(lDv)} km/s. Your orbit then takes ${f1(lT)} years instead of Jupiter's ${f1(TJ)} (Kepler's 3rd law), so one lap loses 30°. Then slow down ${f2(lDv)} km/s to stay.`,
                teach: 'At L4 you go round in step with Jupiter, like the Trojan asteroids (the Lucy probe is on its way to visit them).',
                hint: l4Hint,
                fail: { fuel: `Speed up about ${f1(lDv)} km/s, skip to L4 (about 13 years), then follow the arrow to settle there.`, time: `Speed up about ${f1(lDv)} km/s at the start: one lap of that bigger orbit brings you back to L4.`, crash: 'Stay clear of Jupiter!' }
            }
        ].map((m, i) => Object.assign(m, { n: i + 1, key: `mission-${m.id}` }));
    })();
    for (const m of MISSIONS) SCENES[m.key] = m.scene;
    const missionByKey = (key) => MISSIONS.find((m) => m.key === key) || null;
    const missionById = (id) => MISSIONS.find((m) => m.id === id) || null;

    const mission = {
        def: null,             // the mission loaded (null: none)
        status: 'off',         // 'ready' (the clock hasn't started), 'flying', 'won' or 'lost'
        reason: '',            // why it was lost: crash, fuel, time or missed
        crashedInto: '',
        craftId: null, refId: null, targetId: null,
        used: 0,               // km/s of delta-v burned
        log: [],               // the burns: time (yr), delta-v (km/s), time, delta-v, ...
        steps: 0,
        nearId: null,          // the body the probe is nearest (for its size): what it hit, if it vanishes
        result: null,          // { stars, used, t, prev, better } once it is over
        resultShown: false,
        pred: null, predDirty: true,   // the coming closest approach to the target
        plan: null,            // the burn that would put that approach inside the goal (see burnPlan)
        tell: null,            // the burn the hint asks for, for the arrow on the probe: { ux, uy, kms }
        labels: [], labelBoxes: [],    // the marks' names to draw this frame, and where they went
        tipBox: { l: 0, r: -1, t: 0, b: 0 },   // the ring on the probe's velocity arrow this frame (r < l: none)
        aimPaused: false,      // the clock was stopped for a moment (aiming, firing, reading a card)
        firing: null,          // the engine while it is held: { kind, fine, key, timer }
        fine: false,           // the Fine switch
        skip: null,            // a skip going on: { kind, t, late, out, speed }
        arrived: false,        // the clock has stopped for this pass of the target, or a burn has been made in it
        gap2: Infinity, gapWas: Infinity,   // the distance to the target squared, this step and the last
        ahead: false,          // the target is short of the launch window (as of the last step)
        home: null,            // what to go back to on leaving (see missionKeepHome)
        burst: 0, burstTimer: 0,       // delta-v of burns in quick succession (one announcement for them all)
        refusedAt: 0, refusedText: '',
        hintShown: '',         // the mission hint last put in the hint line
        panel: null,           // what the card over the canvas shows: 'how', 'list' or 'result' (null: hidden)
        okSaid: false, sceneKeyAt: -1e9, keyed: false,
        menuLocked: false
    };

    // ---- Words ----
    const LOST_TITLE = { crash: 'Crashed', fuel: 'Out of fuel', time: 'Out of time', missed: 'You flew past Jupiter' };

    // Hints for a move between circular orbits (up: outwards). The end of the orbit that moves is the
    // far one going up and the near one going down; the second burn goes there, the same way again.
    function transferHint(x, r, tol, up) {
        const lo = r * (1 - tol), hi = r * (1 + tol);
        const way = up ? 'forwards' : 'backwards', where = up ? 'far point' : 'closest point', btn = up ? 'Forward' : 'Back';
        const reach = up ? x.ra : x.rp;
        if (!x.burns) return `Hold <strong>${btn}</strong> until your dashed orbit ${up ? 'reaches' : 'dips to'} the ring.`;
        if (!x.el.bound) return 'You are escaping the Sun! <strong>Undo</strong>, and try a smaller burn.';
        // (the first burn went the wrong way: the orbit shrank going up, or grew going down)
        if (up ? x.el.a < 0.995 : x.el.a > 1.005) return `That burn ${up ? 'lowered' : 'raised'} your orbit. <strong>Undo</strong>, then burn ${way}.`;
        if (up ? reach < lo : reach > hi) return `Not there yet: hold <strong>${btn}</strong> until your orbit ${up ? 'reaches' : 'dips to'} the ring.`;
        if (up ? reach > hi : reach < lo) return `Too far: your orbit goes past the ring. <strong>Undo</strong>, or burn ${up ? 'backwards' : 'forwards'} at the ${up ? 'closest point' : 'far point'}.`;
        const at = up ? x.nu > 165 : x.nu < 15;
        return at ? `<strong>Now:</strong> hold <strong>${btn}</strong> to round off your orbit on the ring.`
            : `Good. <strong>Skip to ${where}</strong>, then burn ${way} again.`;
    }
    // (within 45 degrees of the closest point, 0.35 AU from the Sun, a burn still earns three stars)
    function escapeHint(x) {
        if (x.nu < 45) return '<strong>Now:</strong> you are moving fastest. Hold <strong>Forward</strong> to escape!';
        // (at the very start, at the far point, it may just be moving out by a rounding error)
        if (x.out && x.nu < 170) return 'Past the closest point, a burn costs far more. <strong>Retry</strong>, and burn near the Sun.';
        return x.burns ? 'A burn out here adds little energy. <strong>Skip to closest point</strong>, then burn.'
            : 'Escaping costs less as you near the Sun. <strong>Skip to closest point</strong>, then burn.';
    }
    function captureHint(x) {
        const g = x.d.goal;
        if (x.el.bound && x.ra > g.lim) return 'Jupiter has you, but too widely. Hold <strong>Back</strong> at the closest point to shrink your orbit.';
        if (x.nu < 20) return '<strong>Now:</strong> closest point. Hold <strong>Back</strong> until Jupiter keeps you.';
        if (x.out) return 'You are past the closest point and climbing away: braking now costs more.';
        return '<strong>Skip to closest point</strong>, where braking counts most.';
    }
    // ---- Hints for flying to a target: they say what the physics says from here ----
    // The goal's reach, and whether the coming pass keeps the tick's promise: a skip stops inside the
    // goal, with the fuel to do what is left there.
    const goalReach = (g) => (g.type === 'reach' ? g.zone : g.D);
    // (what the tick asks for, the goal the status line gives: a little inside the goal, at the figures it
    // shows. Its reading of the pass is rounded up, so a reading no higher than this is a tick, and only that.)
    const goalAim = (g) => { const k = Math.pow(10, auPlaces(goalReach(g))); return Math.floor(PROMISE * goalReach(g) * k) / k; };
    // (L4: how far from the size of Jupiter's orbit a nearly round orbit can still be)
    const parkable = (g, r) => Math.abs(r / g.a - 1) < 0.7 * g.da + 0.9 * g.eMax;
    function passWorks(x, p) {
        const g = x.d.goal;
        if (!p || !(p.d < goalAim(g))) return false;
        if (g.type === 'reach') return true;
        if (g.l4 && !parkable(g, Math.hypot(p.cx, p.cy))) return false;
        if (g.arrive && p.dv > g.arrive) return false;
        return toKms(p.dv) - (g.l4 ? 0 : toKms(g.V)) <= x.left;
    }
    const onCourse = (x) => x.burns > 0 && !!mission.pred && mission.pred.t > simTime && passWorks(x, mission.pred);

    // The burn along the probe's motion, from here and now, that brings the coming pass closest inside
    // the goal: the smallest such burn the fuel pays for ({ kms: + forward, - back, speed: the speed that
    // makes }), or null if there is none, so what a hint asks for has been flown ahead first. While the
    // clock waits and only the speed changes, the answer stands; otherwise it is worked out again, four
    // times a second at most. (A few dozen predictions: a few milliseconds.)
    const PLAN_EVERY_MS = 250, PLAN_GRID = 12;
    function burnPlan(x) {
        const q = mission.plan, now = performance.now(), v = x.el.v;
        const same = !!q && q.t === simTime && Math.abs(x.vx * q.vy - x.vy * q.vx) < 1e-9 * v * v;
        if (q && (same || now - q.at < PLAN_EVERY_MS)) return q.none ? null : Object.assign(q, { kms: toKms(q.speed - v) });
        const g = x.d.goal, H = Math.max(x.d.limit - simTime, 0.02), left = x.left;
        const score = (kms) => {
            if (kms < -0.98 * toKms(v) || Math.abs(kms) > left) return Infinity;
            const p = predictApproach(H, kms / AUYR_KMS);
            if (!p) return Infinity;
            return passWorks({ d: x.d, left: left - Math.abs(kms) }, p) ? p.d : p.d + goalReach(g);
        };
        // Sampled more closely near no burn at all and near what the textbook burn would still take (a
        // pass inside the goal can be narrow: Mars's is 0.05 km/s across); then each dip, nearest first,
        // narrowed down
        const at = [];
        for (let k = -PLAN_GRID; k <= PLAN_GRID; k++) at.push(Math.sign(k) * left * (k / PLAN_GRID) * (k / PLAN_GRID));
        for (const sign of [-1, 1]) for (const f of [-0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15]) at.push(sign * (x.d.aim - mission.used + f * x.d.aim));
        at.sort((a, b) => a - b);
        const val = at.map(score);
        const dips = [];
        for (let i = 0; i < at.length; i++) {
            if (val[i] < Infinity && (i === 0 || val[i] <= val[i - 1]) && (i === at.length - 1 || val[i] <= val[i + 1])) dips.push(i);
        }
        dips.sort((a, b) => Math.abs(at[a]) - Math.abs(at[b]));
        let found = null;
        for (const i of dips.slice(0, 4)) {
            let lo = at[Math.max(0, i - 1)], hi = at[Math.min(at.length - 1, i + 1)];
            const r = 0.381966;
            let a = lo + r * (hi - lo), b = hi - r * (hi - lo), fa = score(a), fb = score(b);
            for (let it = 0; it < 14; it++) {
                if (fa < fb) { hi = b; b = a; fb = fa; a = lo + r * (hi - lo); fa = score(a); } else { lo = a; a = b; fa = fb; b = hi - r * (hi - lo); fb = score(b); }
            }
            const kms = fa < fb ? a : b;
            if (Math.min(fa, fb) < goalAim(g)) { found = kms; break; }
        }
        mission.plan = { t: simTime, at: now, vx: x.vx, vy: x.vy, none: found === null, speed: v + (found || 0) / AUYR_KMS, kms: found };
        return found === null ? null : mission.plan;
    }

    // A burn the hint asks for: the arrow on the probe, and if the engine is firing the opposite way, a word
    const BURN_KIND = { Forward: 'faster', Back: 'slower', In: 'in', Out: 'out' };
    const BURN_OPPOSITE = { Forward: 'slower', Back: 'faster', In: 'out', Out: 'in' };
    function askBurn(btn, ux, uy, kms, html) {
        mission.tell = { ux, uy, kms };
        const f = mission.firing;
        return f && f.kind === BURN_OPPOSITE[btn] ? `Wrong way: the gap is growing. Hold <strong>${btn}</strong> instead.` : html;
    }
    // (Rounded, so a screen reader isn't read every hundredth of a km/s)
    const kmsWords = (kms) => (kms < 1 ? Math.max(0.05, Math.round(kms * 20) / 20).toFixed(2) : kms.toFixed(1));
    // The way to go on from a burn along the motion: hold it, then Fine for the last of it, to the tick
    function planHint(x, q, first) {
        const btn = q.kms > 0 ? 'Forward' : 'Back', more = Math.abs(q.kms), v = x.el.v;
        const sign = q.kms > 0 ? 1 : -1, ux = sign * x.vx / v, uy = sign * x.vy / v;
        // (the first burn, on a clock that is running: no figure, which would change with every small move)
        if (first && !paused) return `Hold <strong>${btn}</strong>${first[1]}`;
        const words = kmsWords(more);
        let h;
        if (first) h = `${first[0]}${first[0] ? 'hold' : 'Hold'} <strong>${btn}</strong> for about ${words} km/s${first[1]}`;
        else if (mission.fine) h = `${more > TAP_FROM * x.d.budget ? 'Hold' : 'Tap'} <strong>${btn}</strong> until you see the ✓.`;
        else if (more > FINE_FROM * x.d.budget) h = `Keep holding <strong>${btn}</strong>: about ${words} km/s to go.`;
        else h = `Nearly. Turn on <strong>Fine</strong>, then hold <strong>${btn}</strong> until you see the ✓.`;
        return askBurn(btn, ux, uy, more, h);
    }
    // Is a burn from here worth asking for, or is going back better? (Up to the fuel of two stars; or
    // whatever the fuel so far, if it is a near miss, which a small burn finishes)
    const planWorthIt = (x, q) => !!q && (mission.used + Math.abs(q.kms) <= STARS_AT[1] * x.d.par
        || (!!mission.pred && mission.pred.d < 3 * goalReach(x.d.goal) && Math.abs(q.kms) <= FINE_FROM * x.d.budget));

    function marsHint(x) {
        if (onCourse(x)) return `On course for Mars! <strong>Skip to Mars</strong>${mission.skip ? '' : ', or press play and watch'}.`;
        if (!x.burns) {
            // (running, the clock will stop at the window; run on past it, it is gone)
            if (x.phase > x.d.lead + (paused ? 3 : 0)) return '<strong>Skip to launch window</strong>, when Mars reaches the marked spot.';
            if (!paused) return 'You missed the launch window. <strong>Retry</strong>, or pause to see if a burn still works.';
            const q = burnPlan(x);
            if (x.phase > x.d.lead - 3) return planHint(x, q || { kms: x.d.aim }, ['<strong>Launch window, time waits:</strong> ', '.']);
            return q ? planHint(x, q, ['You missed the launch window. <strong>Retry</strong>, or ', '.']) : 'You missed the launch window. <strong>Retry</strong>.';
        }
        if (!paused) return offPathHint('Mars');
        const q = burnPlan(x);
        return planWorthIt(x, q) ? planHint(x, q) : 'This path misses Mars. <strong>Undo</strong>, then burn at the launch window.';
    }

    // At the target: the burn that matches its velocity (for L4, the speed of an orbit of Jupiter's size,
    // or as near as the distance allows, square to the Sun), worked out from the actual difference. The
    // engine's buttons push along the motion, or straight out or in, so it is split that way: the two
    // parts of it, along the motion first. Then a burn along the motion leaves the other part as it was
    // and that one leaves nothing to come back to, so the hint doesn't swap back and forth. tol (AU/yr):
    // how much of the difference the goal lets you keep.
    function matchBurn(x) {
        const g = x.d.goal, el = x.el, r = el.r, v = el.v;
        let wx = x.tvx, wy = x.tvy, tol = g.V;
        if (g.l4) {
            const size = clamp(r, g.a * (1 - 0.7 * g.da), g.a * (1 + 0.7 * g.da));
            const k = Math.sqrt(el.mu * (2 / r - 1 / size)) * (el.h >= 0 ? 1 : -1) / r;
            wx = -k * x.ry; wy = k * x.rx;
            tol = el.mu * g.da / (2 * g.a * v);
        }
        const ux = wx - x.vx, uy = wy - x.vy, tx = x.vx / v, ty = x.vy / v, nx = x.rx / r, ny = x.ry / r;
        const det = tx * ny - ty * nx;
        const along = (ux * ny - uy * nx) / det, out = (tx * uy - ty * ux) / det;
        const left = (a, b) => toKms(Math.abs(a) - (g.l4 ? 0 : Math.sqrt(Math.max(0, tol * tol - b * b))));
        // (L4: the size first, then whichever part is the bigger: all of it would settle the orbit for sure)
        const first = g.l4 ? Math.abs(el.a / g.a - 1) >= 0.85 * g.da || (el.e < 0.9 * g.eMax ? false : Math.abs(along) >= Math.abs(out)) : Math.abs(along) > 0.7 * tol;
        return {
            ux, uy, first, cost: toKms(Math.abs(along) + Math.abs(out)) - toKms(tol),
            btn: first ? (along > 0 ? 'Forward' : 'Back') : (out > 0 ? 'Out' : 'In'),
            kms: first ? left(along, out) : left(out, along)
        };
    }
    function matchHint(x, what) {
        const m = matchBurn(x), kms = Math.max(0, m.kms), u = Math.hypot(m.ux, m.uy) || 1;
        if (m.cost > x.left) return 'Not enough fuel left to match it. <strong>Undo</strong> or <strong>Retry</strong>.';
        return askBurn(m.btn, m.ux / u, m.uy / u, kms, `<strong>${mission.aimPaused ? 'Now' : 'Arrived, time waits'}:</strong> hold <strong>${m.btn}</strong>, about ${kmsWords(kms)} km/s, ${what(m)}.`);
    }
    // While the clock runs with nothing pressed, the advice holds still: what the best burn is changes with
    // every small move, so that waits until the clock stops.
    const offPathHint = (what) => `This path misses ${what}. <strong>Pause</strong> for what to do next.`;
    const passHint = (what) => (mission.arrived ? `Passing ${what}. <strong>Pause</strong> to burn here.` : 'Arriving. Time will wait for your burn.');

    function stationHint(x) {
        const g = x.d.goal;
        if (x.td < g.D) return paused ? matchHint(x, () => 'to match the station\'s speed') : passHint('the station');
        if (onCourse(x)) return 'On course. <strong>Skip to the station</strong>, then match its speed.';
        if (!x.burns) {
            const q = burnPlan(x);
            return q ? planHint(x, q, ['', ': a smaller orbit is a quicker lap.']) : 'Too late to catch it from here. <strong>Retry</strong>.';
        }
        if (x.el.a > 1.005) return 'A bigger orbit is slower, so you are falling behind. <strong>Undo</strong>, and slow down instead.';
        if (!paused) return offPathHint('the station');
        const q = burnPlan(x);
        return planWorthIt(x, q) ? planHint(x, q) : 'This path misses the station. <strong>Undo</strong> your last burn, or <strong>Retry</strong>.';
    }
    function l4Hint(x) {
        const g = x.d.goal;
        if (x.td < g.D) {
            if (!paused) return passHint('L4');
            if (!parkable(g, x.el.r)) return 'Too far from Jupiter\'s orbit to settle here. <strong>Undo</strong> or <strong>Retry</strong>.';
            return matchHint(x, (m) => (m.first ? 'until your orbit matches Jupiter\'s' : 'to round off your orbit'));
        }
        if (onCourse(x)) return 'On course. <strong>Skip to L4</strong>, then settle there.';
        if (!x.burns) {
            const q = burnPlan(x);
            return q ? planHint(x, q, ['', ': a bigger orbit drifts you back to L4.']) : 'Too late to reach L4 from here. <strong>Retry</strong>.';
        }
        if (!paused) return offPathHint('L4');
        const q = burnPlan(x);
        return planWorthIt(x, q) ? planHint(x, q) : 'This path misses L4. <strong>Undo</strong> your last burn, or <strong>Retry</strong>.';
    }

    // ---- The state the console, hints and checks read ----
    // The target as seen from the reference body (rotated 60 degrees ahead for L4)
    function targetNow(R, T, l4) {
        let x = T.x - R.x, y = T.y - R.y, vx = T.vx - R.vx, vy = T.vy - R.vy;
        if (l4) {
            const c = 0.5, s = Math.sqrt(3) / 2;
            [x, y, vx, vy] = [c * x - s * y, s * x + c * y, c * vx - s * vy, s * vx + c * vy];
        }
        return { x, y, vx, vy };
    }

    function missionContext() {
        const d = mission.def, c = d && bodyById(mission.craftId), R = d && bodyById(mission.refId);
        if (!c || !R) return null;
        if (mission.predDirty && !missionIsOver()) refreshPrediction(false);
        const rx = c.x - R.x, ry = c.y - R.y, vx = c.vx - R.vx, vy = c.vy - R.vy;
        const el = relElements(rx, ry, vx, vy, G * (R.m + c.m));
        const x = {
            d, c, R, el, rx, ry, vx, vy,
            burns: mission.log.length / 2, left: Math.max(0, d.budget - mission.used),
            rp: el.p / (1 + el.e), ra: el.bound ? el.a * (1 + el.e) : Infinity,
            // degrees from the closest point (0 to 180 either side), and moving away from R?
            nu: el.e > 1e-6 ? Math.acos(clamp((el.ex * rx + el.ey * ry) / (el.e * el.r), -1, 1)) / DEG : 90,
            out: rx * vx + ry * vy > 0
        };
        const T = mission.targetId !== null ? bodyById(mission.targetId) : null;
        if (T) {
            const t = targetNow(R, T, d.goal.l4);
            x.tname = d.goal.l4 ? 'L4' : T.name;
            x.tvx = t.vx; x.tvy = t.vy;
            x.td = Math.hypot(rx - t.x, ry - t.y);
            x.tr = Math.hypot(t.x, t.y);
            x.tdv = Math.hypot(vx - t.vx, vy - t.vy);
            // how far ahead (+) or behind (-) the target is round the orbit, degrees
            x.phase = (((Math.atan2(t.y, t.x) - Math.atan2(ry, rx)) / DEG + 540) % 360) - 180;
        }
        return x;
    }

    // How the goal stands, for the console: { text, ok } (ok: on track)
    function missionStatus(x) {
        if (mission.status === 'won') return { text: `Complete: ${f1(mission.result.used)} km/s used`, ok: true };
        if (mission.status === 'lost') return { text: LOST_TITLE[mission.reason] || 'Mission over', ok: false };
        if (!x) return { text: '', ok: false };
        const d = x.d, g = d.goal;
        switch (g.type) {
            case 'orbit': {
                if (!x.el.bound) return { text: 'Escaping the Sun!', ok: false };
                const up = g.r > 1, reach = up ? x.ra : x.rp;
                return { text: `${up ? 'Far point' : 'Closest point'} ${f2(reach)} AU, goal ${f2(g.r)}`, ok: Math.abs(reach / g.r - 1) <= g.tol };
            }
            case 'escape': {
                const need = toKms(Math.sqrt(2 * x.el.mu / x.el.r) - x.el.v);
                return { text: `To escape from here: ${f1(Math.max(need, 0))} km/s`, ok: x.nu < 45 && need <= x.left };
            }
            case 'capture': {
                if (x.el.bound) return { text: `Orbit reaches ${f2(x.ra)} AU, goal ${f2(g.lim)}`, ok: false };
                if (x.el.r > g.lim) return { text: `${f2(x.el.r)} AU from Jupiter, ring at ${f2(g.lim)}`, ok: false };
                const need = toKms(x.el.v - Math.sqrt(2 * x.el.mu * g.lim / (x.el.r * (x.el.r + g.lim))));
                return { text: `To stay from here: brake ${f1(need)} km/s`, ok: x.nu < 20 && need <= x.left };
            }
            default: {
                const reach = goalReach(g), p = mission.pred;
                if (!x.burns) {
                    const where = `${x.tname} ${Math.round(Math.abs(x.phase))}° ${x.phase >= 0 ? 'ahead' : 'behind'}`;
                    return d.lead ? { text: `${where}, launch at ${Math.round(d.lead)}°`, ok: Math.abs(x.phase - d.lead) < 3 } : { text: where, ok: false };
                }
                if (g.type === 'meet' && x.td < reach) {
                    const fits = matchBurn(x).cost <= x.left;
                    if (!g.l4) return { text: `Inside the ring, ${f2(toKms(x.tdv))} km/s apart, goal ${f2(toKms(g.V))}`, ok: fits };
                    const size = Math.abs(x.el.a / g.a - 1) >= g.da;
                    return { text: `Inside the ring. ${size ? `Orbit ${f2(x.el.a)} AU, goal ${f2(g.a)}` : `Roundness e ${f2(x.el.e)}, goal under ${f2(g.eMax)}`}`, ok: fits && parkable(g, x.el.r) };
                }
                if (g.arrive && p && p.d < reach && p.dv > g.arrive) return { text: `Arriving too fast: ${f1(toKms(p.dv))} km/s, goal under ${f1(toKms(g.arrive))}`, ok: false };
                return p ? { text: `Closest to ${x.tname}: ${auTextUp(p.d)}, goal ${auText(goalAim(g))}`, ok: onCourse(x) } : { text: `${x.tname} ${auText(x.td)} away`, ok: false };
            }
        }
    }

    function missionHintText() {
        const x = missionContext();
        mission.tell = null;
        if (!x) return mission.status === 'lost' ? '<strong>Retry</strong>, or undo your last burn.' : '';
        if (mission.status === 'won') return `<strong>Mission complete!</strong> ${mission.def.n < MISSIONS.length ? 'On to the next one, or retry on less fuel.' : 'Can you beat your fuel?'}`;
        if (mission.status === 'lost') return '<strong>Retry</strong>, or undo your last burn and fly it differently.';
        if (x.left <= 1e-6) return 'Out of fuel: you can only coast now.';
        return x.d.hint(x);
    }
    // (setHint's default during a mission: the mission's own hint)
    function missionHint(kind) {
        if (!mission.def || kind === 'drop') return null;
        mission.hintShown = missionHintText() || null;
        return mission.hintShown;
    }

    // ---- Burns, and keeping everything else as it was ----
    const missionCraft = () => (mission.def ? bodyById(mission.craftId) : null);

    // A note in the hint line for something a mission doesn't allow (the same one at most every 1.5 s).
    function missionNote(html) {
        const now = performance.now();
        if (html === mission.refusedText && now - mission.refusedAt < 1500) return;
        mission.refusedText = html; mission.refusedAt = now;
        historyNote(html);
    }

    const missionIsOver = () => mission.status === 'won' || mission.status === 'lost';

    // Is this edit off limits in a mission? Shows a friendly note if so. Aiming the probe's own arrow is
    // allowed, and stops the clock while it is aimed (a held body stays put while time runs).
    function missionRefuse(what, b) {
        if (!mission.def) return false;
        const craft = !!b && b.id === mission.craftId;
        if (what === 'aim' && craft && !missionIsOver()) {
            if (!paused) { setPaused(true); mission.aimPaused = true; }
            return false;
        }
        const notes = {
            add: 'no new bodies. Leave the mission to build your own.',
            delete: 'nothing can be removed.',
            move: craft ? 'your probe changes course by burns, not by dragging.'
                : `${b ? escapeHtml(b.name) : 'it'} keeps to its path. Only your probe can change course.`,
            aim: craft ? 'the mission is over. Retry, or undo your last burn.' : 'only your probe has an engine.',
            orbit: 'orbits change only by your probe\'s burns.',
            other: 'only your probe\'s engine can change anything.'
        };
        missionNote(`<strong>Mission rules:</strong> ${notes[what] || notes.orbit}`);
        return true;
    }

    // A copy of every body before an edit (null if no mission is loaded)
    function missionBegin() {
        if (!mission.def) return null;
        const n = bodies.length, s = new Float64Array(n * MSNAP_W);
        for (let i = 0; i < n; i++) {
            const b = bodies[i], o = i * MSNAP_W;
            s[o] = b.id; s[o + 1] = b.m; s[o + 2] = b.R; s[o + 3] = b.x; s[o + 4] = b.y; s[o + 5] = b.vx; s[o + 6] = b.vy;
        }
        return s;
    }

    // Put the bodies back as the copy has them (all but the probe's velocity, unless all is set)
    function missionPutBack(s, all) {
        if (s.length !== bodies.length * MSNAP_W) return;
        for (let i = 0; i < bodies.length; i++) {
            const b = bodies[i], o = i * MSNAP_W;
            if (b.id !== s[o]) return;
        }
        for (let i = 0; i < bodies.length; i++) {
            const b = bodies[i], o = i * MSNAP_W;
            b.m = s[o + 1]; b.R = s[o + 2]; b.x = s[o + 3]; b.y = s[o + 4];
            if (all || b.id !== mission.craftId) { b.vx = s[o + 5]; b.vy = s[o + 6]; }
        }
        forcesDirty = true;
    }

    // After an edit: a change to the probe's velocity alone is a burn, charged to the fuel (cut short
    // if there isn't enough); any other change is put back. (A change too small to matter, such as the
    // last bit of rounding when a primary's share of a burn is worked out, is ignored.)
    function missionEnd(s) {
        if (!s) return;
        const differs = (a, b) => Math.abs(a - b) > 1e-9 * Math.max(Math.abs(a), Math.abs(b)) + 1e-300;
        const n = s.length / MSNAP_W, c = bodyById(mission.craftId);
        let bad = n !== bodies.length, dvx = 0, dvy = 0, vo = -1;
        for (let i = 0; i < n && !bad; i++) {
            const b = bodies[i], o = i * MSNAP_W;
            if (b.id !== s[o]) { bad = true; break; }
            const still = !differs(b.m, s[o + 1]) && !differs(b.R, s[o + 2]) && !differs(b.x, s[o + 3]) && !differs(b.y, s[o + 4]);
            if (b === c) {
                if (!still) bad = true;
                else { dvx = b.vx - s[o + 5]; dvy = b.vy - s[o + 6]; vo = o + 5; }
            } else if (!still || differs(b.vx, s[o + 5]) || differs(b.vy, s[o + 6])) bad = true;
        }
        if (bad) {
            missionPutBack(s, true);
            missionRefuse('other');
            resumeAfterAim();
            return;
        }
        missionPutBack(s, false);
        const dv = toKms(Math.hypot(dvx, dvy));
        if (!(dv > 1e-9) || !c) { resumeAfterAim(); return; }
        const d = mission.def, left = d.budget - mission.used;
        if (missionIsOver()) {
            c.vx = s[vo]; c.vy = s[vo + 1];
            missionNote('The mission is over: <strong>Retry</strong>, or undo your last burn.');
            return;
        }
        if (left <= 1e-6) {
            c.vx = s[vo]; c.vy = s[vo + 1];
            missionNote('<strong>Out of fuel:</strong> you can only coast now.');
            resumeAfterAim();
            return;
        }
        let f = 1;
        if (dv > left) { f = left / dv; c.vx = s[vo] + dvx * f; c.vy = s[vo + 1] + dvy * f; }
        mission.used = Math.min(d.budget, mission.used + dv * f);
        mission.log.push(simTime, dv * f);
        mission.predDirty = true;
        mission.arrived = true;
        noteBurn(dv * f);
        endSkip();
        if (mission.status === 'ready') startFlying();
        // Show the new path (the editor's preview of the chosen body)
        if (selectedId !== c.id) selectBody(c.id);
        edit.previewUntil = performance.now() + 5000;
        markPreview();
        if (mission.status === 'flying') {
            const out = missionCheckNow(c);
            if (out) missionOver(out === 'missed' ? 'lost' : out, out === 'missed' ? 'missed' : '');
            else if (d.budget - mission.used <= 1e-6) missionFuelCheck();
        }
        updateMissionConsole();
        resumeAfterAim();
    }

    // The clock goes on again once the probe's arrow or engine has been let go, or a card closed (if it
    // was stopped for that)
    function resumeAfterAim() {
        if (!mission.aimPaused || mission.firing || bodies.some((q) => q.held) || mission.panel === 'how' || mission.panel === 'list') return;
        mission.aimPaused = false;
        if (mission.status === 'flying' || mission.status === 'ready') setPaused(false);
    }

    // Burns in quick succession (a held engine, a stepper) are read out once, when they stop: on the
    // screen the fuel gauge has already fallen with them
    function noteBurn(dv) {
        mission.burst += dv;
        clearTimeout(mission.burstTimer);
        mission.burstTimer = setTimeout(() => {
            const d = mission.def, burst = mission.burst;
            mission.burst = 0;
            if (!d || missionIsOver()) return;
            const left = Math.max(0, d.budget - mission.used), v = fmtSpeedKms(burst);
            announce(`Burn: ${v.v} ${v.u}. ${left > 1e-6 ? `Fuel left: ${f1(left)} of ${f1(d.budget)} kilometres a second.` : 'That was the last of your fuel.'}`);
        }, 450);
    }

    // A push of the probe (pushes, steppers, arrow keys), measured from the mission's reference body:
    // dv (AU/yr) along its motion, against it (never so far that it turns round), or straight out or in.
    function missionPush(b, kind, dv) {
        const R = bodyById(mission.refId);
        if (!R || !(dv > 0)) return;
        let vx = b.vx - R.vx, vy = b.vy - R.vy;
        const v = Math.hypot(vx, vy), rx = b.x - R.x, ry = b.y - R.y, r = Math.hypot(rx, ry);
        if (kind === 'faster' || kind === 'slower') {
            if (!(v > 0)) return;
            const k = kind === 'faster' ? (v + dv) / v : Math.max(0, v - dv) / v;
            vx *= k; vy *= k;
        } else if (kind === 'out' || kind === 'in') {
            if (!(r > 0)) return;
            const k = (kind === 'out' ? dv : -dv) / r;
            vx += rx * k; vy += ry * k;
        } else return;
        applyEdit(b, () => { b.vx = R.vx + vx; b.vy = R.vy + vy; });
    }
    // The hint line while the probe's arrow is aimed (see beginAim): the burn, which way it points
    // (relative to the reference body), and the fuel it would leave
    function burnHint(b, d) {
        const def = mission.def, R = bodyById(mission.refId), av = aimedVelocity(b);
        const dvx = av.x - b.vx, dvy = av.y - b.vy, dv = toKms(Math.hypot(dvx, dvy));
        const left = Math.max(0, def.budget - mission.used), B = b.aim.burn;
        if (!(dv >= 0.005)) return `<strong>Drag out a burn:</strong> along the arrow to speed up, against it to slow down.`;
        let way = '';
        if (R) {
            const vx = b.vx - R.vx, vy = b.vy - R.vy, v = Math.hypot(vx, vy), rx = b.x - R.x, ry = b.y - R.y, r = Math.hypot(rx, ry);
            const along = v > 0 ? (dvx * vx + dvy * vy) / v : 0, out = r > 0 ? (dvx * rx + dvy * ry) / r : 0;
            way = Math.abs(along) >= Math.abs(out) ? (along > 0 ? ' forwards' : ' backwards') : (out > 0 ? ' outwards' : ' inwards');
        }
        const s = fmtSpeedKms(dv);
        let h = `<strong>Burn ${s.v} ${s.u}${way}:</strong> `;
        h += dv > left + 1e-6 ? `more than the ${f1(left)} km/s of fuel left.` : `leaves ${f1(left - dv)} of ${f1(def.budget)} km/s of fuel.`;
        if (b.aim.snap) h += b.aim.snap === 'circular' ? ' Circular speed.' : ' Escape speed.';
        if (!coarse()) h += B.from && B.from.fine ? ' <strong>Fine control.</strong>' : ' <strong>Shift:</strong> finer.';
        else if (aimFineTouch(d)) h += ' <strong>Fine control:</strong> a tenth of your finger\'s move.';
        return h;
    }

    // ---- The engine ----
    // Pressed (a button, or an arrow key), it fires a tap at once, and held it goes on firing. The clock
    // waits meanwhile, so a burn happens at one place, and watching the fuel and the new path takes the
    // time it needs: it runs again on letting go if it was running. (Before Play or a skip it wasn't.)
    function engineFire(kind, fine, key) {
        engineStop();
        if (!mission.def) return;
        if (missionIsOver()) { missionNote('The mission is over: <strong>Retry</strong>, or undo your last burn.'); return; }
        const c = missionCraft();
        if (!c || c.held) return;
        endSkip();
        if (!paused) { setPaused(true); mission.aimPaused = true; }
        const tank = mission.def.budget / AUYR_KMS, size = fine ? ENGINE_FINE : 1;
        const f = { kind, key: key || '', timer: 0 };
        mission.firing = f;
        mission.keyed = !!key;
        missionPush(c, kind, tank * ENGINE_TAP * size);
        const again = () => {
            const q = missionCraft();
            if (mission.firing !== f || !q || missionIsOver() || mission.used >= mission.def.budget - 1e-6) { if (mission.firing === f) engineStop(); return; }
            missionPush(q, kind, tank * ENGINE_HOLD * size * ENGINE_EVERY_MS / 1000);
            f.timer = setTimeout(again, ENGINE_EVERY_MS);
        };
        f.timer = setTimeout(again, ENGINE_WAIT_MS);
    }

    function engineStop() {
        const f = mission.firing;
        if (!f) return;
        clearTimeout(f.timer);
        mission.firing = null;
        // (an orbit stretched past the view: the view makes room for it)
        if (mission.def && mission.def.goal.type === 'orbit') keepOrbitInView(missionCraft());
        resumeAfterAim();
        updateMissionConsole();
    }

    // (from the arrow keys, once they are for the simulation) In a mission they fire the probe's engine
    function missionKey(e, kind) {
        if (!mission.def) return false;
        e.preventDefault();
        if (!e.repeat) engineFire(kind, mission.fine || e.shiftKey, e.key);
        return true;
    }

    // (nudge's way in: a step is a fraction of the speed relative to the reference body)
    function missionNudge(b, kind, step) {
        if (!mission.def || b.id !== mission.craftId) return false;
        const R = bodyById(mission.refId);
        if (R && step > 0) missionPush(b, kind, step * Math.hypot(b.vx - R.vx, b.vy - R.vy));
        return true;
    }

    // ---- Skipping to the next moment that matters ----
    // Years until the far point (apo) or the closest point of the orbit it is on (null: never again)
    function apsisIn(x, apo) {
        const el = x.el;
        if (!el.bound) {
            if (apo || x.out || !(el.e > 1)) return null;
            const a = -el.a, F = Math.acosh(Math.max(1, (1 + el.r / a) / el.e));
            return (el.e * Math.sinh(F) - F) / Math.sqrt(el.mu / (a * a * a));
        }
        if (el.e < 1e-3) return null;
        const c = clamp((1 - el.r / el.a) / el.e, -1, 1), E = x.out ? Math.acos(c) : TAU - Math.acos(c);
        const dM = (apo ? Math.PI : TAU) - (E - el.e * Math.sin(E));
        return ((dM + TAU) % TAU) / (TAU / el.T);
    }

    // What the skip button offers now: { kind, word, dt } (dt in years, inside the time left), or null.
    // Not when it is there already: the burn comes next.
    function skipTarget(x) {
        if (!x || missionIsOver()) return null;
        const d = x.d, g = d.goal;
        let s = null;
        if (g.type === 'orbit') {
            const apo = g.r > 1;
            // (once the orbit touches the ring: short of it or past it, the second burn won't round it off there)
            if (x.burns && x.el.bound && Math.abs((apo ? x.ra : x.rp) / g.r - 1) <= g.tol && (apo ? x.nu < 170 : x.nu > 10)) s = { kind: apo ? 'apo' : 'peri', word: apo ? 'far point' : 'closest point', dt: apsisIn(x, apo) };
        } else if (g.type === 'escape' || g.type === 'capture') {
            if (x.nu > 10) s = { kind: 'peri', word: 'closest point', dt: apsisIn(x, false) };
        } else if (!x.burns) {
            // (Mars's angle falls behind at the difference of the two rates of going round)
            if (d.lead && x.phase > d.lead) s = { kind: 'window', word: 'launch window', dt: (x.phase - d.lead) * DEG / (x.el.h / (x.el.r * x.el.r) - Math.sqrt(x.el.mu / Math.pow(x.tr, 3))) };
        } else if (onCourse(x) && x.td > goalReach(g)) {
            // (once the tick is earned; until then the burn isn't finished)
            s = { kind: 'meet', word: g.l4 ? 'L4' : x.tname === 'Station' ? 'the station' : x.tname, dt: mission.pred.t - simTime };
        }
        return s && s.dt > 0 && s.dt < d.limit - simTime ? s : null;
    }

    // Time runs faster up to that moment, then stops there, waiting for the burn. The speed chosen comes
    // back afterwards. It ends when anything else stops the clock or changes the path.
    function startSkip() {
        const x = missionContext(), s = skipTarget(x);
        if (!s) return;
        engineStop();
        if (mission.status === 'ready') startFlying();
        mission.skip = { kind: s.kind, t: simTime + s.dt, late: simTime + s.dt * (s.kind === 'apo' || s.kind === 'peri' ? 1.1 : 1), out: x.out, speed: settings.speed };
        setSpeedValue(clamp(s.dt / (SKIP_S * rate()), settings.speed, 100));
        mission.aimPaused = false;
        setPaused(false);
        updateMissionConsole();
    }

    // The speed slider's reach, in a mission or out of one
    function missionSpeedRange(on) {
        if (!ui.speed) return;
        ui.speed.max = String(on ? nearestStop(MISSION_SPEED_MAX) : SPEED_STOPS.length - 1);
        ui.speed.title = on ? `Up to ${MISSION_SPEED_MAX}× in a mission. Skip is the quick way.` : '';
    }

    function endSkip() {
        const k = mission.skip;
        if (!k) return;
        mission.skip = null;
        setSpeedValue(k.speed);
    }

    // (each step of a skip) Has it got there?
    function skipArrived(c) {
        const k = mission.skip, R = bodyById(mission.refId);
        if (simTime >= k.late || !R) return true;
        const rx = c.x - R.x, ry = c.y - R.y;
        if (k.kind === 'apo' || k.kind === 'peri') {
            const out = rx * (c.vx - R.vx) + ry * (c.vy - R.vy) > 0, was = k.out;
            k.out = out;
            return k.kind === 'apo' ? was && !out : !was && out;
        }
        if (k.kind === 'window') return windowAngle(c, R) <= mission.def.lead;
        return false;
    }

    // How far ahead round the orbit the target is, degrees (0 to 360)
    function windowAngle(c, R) {
        const T = bodyById(mission.targetId);
        return T ? ((Math.atan2(T.y - R.y, T.x - R.x) - Math.atan2(c.y - R.y, c.x - R.x)) / DEG + 360) % 360 : 0;
    }

    // The clock stops, waiting for the burn (a full-sized one: Fine was for tuning the burn before)
    function missionWait() {
        endSkip();
        acc = 0;
        setPaused(true);
        mission.fine = false;
    }

    // (each step) Got there by Play: the moment is short, so the clock stops for it where a skip would, at
    // the launch window and at the closest point of a pass inside the goal. Once: Play goes on from there.
    function missionArrival(c) {
        const d = mission.def, g = d.goal;
        if (d.lead) {
            const R = mission.log.length ? null : bodyById(mission.refId);
            if (!R) return;
            const was = mission.ahead;
            mission.ahead = windowAngle(c, R) > d.lead;
            if (was && !mission.ahead) missionWait();
        } else if (g.type === 'meet') {
            // (a path can dip twice in the ring, seen from L4: on, if a closer point is still to come)
            const was = mission.gapWas, p = mission.pred;
            mission.gapWas = mission.gap2;
            if (mission.gap2 >= g.D * g.D) mission.arrived = false;
            else if (!mission.arrived && mission.gap2 > was && !(p && p.t > simTime && p.d * p.d < mission.gap2)) { mission.arrived = true; missionWait(); }
        }
    }

    // ---- Goals ----
    // Every integrator step (from advance): crashes, the time limit, distance goals, and every
    // ORBIT_CHECK_EVERY steps the orbit elements. Once it is decided, this frame's steps stop there.
    function missionStep() {
        const st = mission.status;
        if (st !== 'flying' && st !== 'ready') return;
        if (st === 'ready') startFlying();
        const c = bodyById(mission.craftId);
        if (!c) { missionOver('lost', 'crash'); return; }   // merged into what it hit
        if (c.held) { acc = 0; return; }                    // (being aimed: wait)
        let near = null, nearK = Infinity;
        for (const q of bodies) {
            if (q === c) continue;
            const dx = c.x - q.x, dy = c.y - q.y, reach = (q.R + c.R) / AU_KM;
            const k = (dx * dx + dy * dy) / (reach * reach);
            if (k < nearK) { nearK = k; near = q; }
        }
        if (near) mission.nearId = near.id;
        if (nearK < 1) { missionOver('lost', 'crash'); return; }
        const d = mission.def, g = d.goal;
        if (g.type === 'reach' || g.type === 'meet') {
            if (missionMet(c)) { missionOver('won'); return; }
        } else if (++mission.steps % ORBIT_CHECK_EVERY === 0) {
            const out = missionCheckNow(c);
            if (out) { missionOver(out === 'missed' ? 'lost' : out, out === 'missed' ? 'missed' : ''); return; }
        }
        if (d.limit && simTime > d.limit) { missionOver('lost', 'time'); return; }
        if (mission.skip && skipArrived(c)) {
            const meet = mission.skip.kind === 'meet';
            missionWait();
            if (meet) { mission.arrived = true; skipReport(); }
        }
        missionArrival(c);
    }

    // (a skip to the target has stopped) It says so if that was short of the goal, which only a change of
    // course nothing here saw coming could do: the tick is worked out to prevent it
    function skipReport() {
        const x = missionContext();
        if (x && x.td >= goalReach(x.d.goal)) missionNote(`Arrived ${auText(x.td)} from ${escapeHtml(x.tname)}, short of the goal of ${auText(goalReach(x.d.goal))}.`);
    }

    // Within reach of the target (and, to meet it, moving with it)?
    function missionMet(c) {
        const g = mission.def.goal, R = bodyById(mission.refId), T = bodyById(mission.targetId);
        if (!R || !T) return false;
        const t = targetNow(R, T, g.l4);
        const dx = c.x - R.x - t.x, dy = c.y - R.y - t.y, d2 = dx * dx + dy * dy;
        mission.gap2 = d2;
        if (g.type === 'reach') return d2 < g.zone * g.zone;
        if (d2 >= g.D * g.D) return false;
        if (g.l4) return l4Orbit(c, R);
        const ux = c.vx - R.vx - t.vx, uy = c.vy - R.vy - t.vy;
        return ux * ux + uy * uy < g.V * g.V;
    }

    // On an orbit like Jupiter's (L4 goes round on it): its size to within da, and nearly round
    function l4Orbit(c, R) {
        const g = mission.def.goal;
        const el = relElements(c.x - R.x, c.y - R.y, c.vx - R.vx, c.vy - R.vy, G * (R.m + c.m));
        return el.bound && Math.abs(el.a / g.a - 1) < g.da && el.e < g.eMax;
    }

    // The goal now: 'won', 'missed' (flew past Jupiter) or null
    function missionCheckNow(c) {
        const g = mission.def.goal, R = bodyById(mission.refId);
        if (!R) return null;
        if (g.type === 'reach' || g.type === 'meet') return missionMet(c) ? 'won' : null;
        const rx = c.x - R.x, ry = c.y - R.y, vx = c.vx - R.vx, vy = c.vy - R.vy, mu = G * (R.m + c.m);
        if (g.type === 'escape') return 0.5 * (vx * vx + vy * vy) - mu / Math.hypot(rx, ry) >= 0 ? 'won' : null;
        const el = relElements(rx, ry, vx, vy, mu);
        if (g.type === 'orbit') return el.bound && el.p / (1 + el.e) >= g.r * (1 - g.tol) && el.a * (1 + el.e) <= g.r * (1 + g.tol) ? 'won' : null;
        if (g.type === 'capture') {
            // (an orbit that would dip into Jupiter isn't one)
            if (el.bound && el.a * (1 + el.e) <= g.lim && el.p / (1 + el.e) > (R.R + c.R) / AU_KM) return 'won';
            if (el.r > g.hill && rx * vx + ry * vy > 0) return 'missed';
        }
        return null;
    }

    // The tank is empty: lost, unless coasting still gets there (a target ahead on the path)
    function missionFuelCheck() {
        const g = mission.def.goal;
        if (g.type === 'reach' || g.type === 'meet') {
            refreshPrediction(true);
            const p = mission.pred;
            const c = bodyById(mission.craftId), R = bodyById(mission.refId);
            const along = g.type === 'reach' || (g.l4 ? !!(c && R && l4Orbit(c, R)) : !!p && p.dv < g.V);
            if (p && along && p.d < goalReach(g)) return;
        }
        missionOver('lost', 'fuel');
    }

    function starsFor(used, par) {
        return used <= STARS_AT[0] * par + 1e-9 ? 3 : used <= STARS_AT[1] * par + 1e-9 ? 2 : 1;
    }

    // Over: the result (a better one is kept), the clock stopped, and this frame's steps end here
    function missionOver(outcome, reason) {
        const d = mission.def;
        mission.status = outcome;
        mission.reason = reason || '';
        if (reason === 'crash') { const q = bodyById(mission.nearId); mission.crashedInto = q ? q.name : 'something'; }
        if (outcome === 'won') {
            const stars = starsFor(mission.used, d.par), prev = bestOf(d.id);
            const better = !prev || stars > prev.stars || (stars === prev.stars && mission.used < prev.used - 1e-9);
            if (better) saveBest(d.id, { stars, used: +mission.used.toFixed(3) });
            mission.result = { stars, used: mission.used, t: simTime, prev, better };
        } else {
            mission.result = { t: simTime };
        }
        mission.resultShown = false;
        mission.fine = false;
        endSkip();
        if (mission.firing) { clearTimeout(mission.firing.timer); mission.firing = null; }
        mission.aimPaused = false;
        acc = 0;
        setPaused(true);
    }

    // ---- The coming closest approach to the target ----
    // Every body followed on from now under the same gravity as the simulation (4th-order steps, each a
    // share of the shortest pair's time), so Jupiter's pull on a probe near L4 is in it: two-body orbits
    // put the probe 0.18 AU off after 13 years, and what a tick promises is where a skip stops. About 500
    // steps, a fraction of a millisecond; worked out again after a burn, once the approach it found has
    // passed, and every tenth of the time it looked ahead. The answer is the closest of all (to reach a
    // zone, the first pass inside it, which is all it takes). kick: a change of speed along the probe's
    // motion to try first (AU/yr).
    const PRED_ETA = 0.02, PRED_MAX_STEPS = 6000;
    const PRX = new Float64Array(3), PRY = new Float64Array(3), PRVX = new Float64Array(3), PRVY = new Float64Array(3);
    const PRAX = new Float64Array(3), PRAY = new Float64Array(3), PRM = new Float64Array(3);
    function predForces(n) {
        let tmin = Infinity;
        PRAX.fill(0); PRAY.fill(0);
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const dx = PRX[j] - PRX[i], dy = PRY[j] - PRY[i], r2 = dx * dx + dy * dy, r = Math.sqrt(r2), k = G / (r2 * r);
                PRAX[i] += k * PRM[j] * dx; PRAY[i] += k * PRM[j] * dy;
                PRAX[j] -= k * PRM[i] * dx; PRAY[j] -= k * PRM[i] * dy;
                const t2 = r2 * r / (G * (PRM[i] + PRM[j]));
                if (t2 < tmin) tmin = t2;
            }
        }
        return Math.sqrt(tmin);
    }

    function predictApproach(H, kick) {
        const n = bodies.length, g = mission.def.goal, reach = g.zone;
        const ci = bodies.findIndex((q) => q.id === mission.craftId), ri = bodies.findIndex((q) => q.id === mission.refId), ti = bodies.findIndex((q) => q.id === mission.targetId);
        if (ci < 0 || ri < 0 || ti < 0 || n > PRX.length) return null;
        bodies.forEach((q, i) => { PRX[i] = q.x; PRY[i] = q.y; PRVX[i] = q.vx; PRVY[i] = q.vy; PRM[i] = q.m; });
        if (kick) {
            const ux = PRVX[ci] - PRVX[ri], uy = PRVY[ci] - PRVY[ri], k = Math.max(0, 1 + kick / Math.hypot(ux, uy));
            PRVX[ci] = PRVX[ri] + k * ux; PRVY[ci] = PRVY[ri] + k * uy;
        }
        const touch = bodies.map((q, i) => (i === ci ? 0 : (q.R + bodies[ci].R) / AU_KM));
        const c = g.l4 ? 0.5 : 1, s = g.l4 ? Math.sqrt(3) / 2 : 0;
        // (the gap between the probe and the target, both from the reference body)
        const read = (o) => {
            const tx = PRX[ti] - PRX[ri], ty = PRY[ti] - PRY[ri], tvx = PRVX[ti] - PRVX[ri], tvy = PRVY[ti] - PRVY[ri];
            o.tx = c * tx - s * ty; o.ty = s * tx + c * ty;
            o.cx = PRX[ci] - PRX[ri]; o.cy = PRY[ci] - PRY[ri];
            o.gx = o.cx - o.tx; o.gy = o.cy - o.ty;
            o.ux = PRVX[ci] - PRVX[ri] - (c * tvx - s * tvy); o.uy = PRVY[ci] - PRVY[ri] - (s * tvx + c * tvy);
        };
        let tau = predForces(n), t = 0, d = Infinity, bt = 0, inside = false;
        const a = {}, b = {}, best = {};
        read(a);
        for (let k = 0; k < PRED_MAX_STEPS && t < H; k++) {
            const dt = Math.min(PRED_ETA * tau, H - t);
            for (const w of [YOSHIDA_W1, YOSHIDA_W0, YOSHIDA_W1]) {
                const h = w * dt;
                for (let i = 0; i < n; i++) { PRVX[i] += 0.5 * h * PRAX[i]; PRVY[i] += 0.5 * h * PRAY[i]; PRX[i] += h * PRVX[i]; PRY[i] += h * PRVY[i]; }
                tau = predForces(n);
                for (let i = 0; i < n; i++) { PRVX[i] += 0.5 * h * PRAX[i]; PRVY[i] += 0.5 * h * PRAY[i]; }
            }
            read(b);
            // The closest point of this step, the gap moving in a straight line over so short a time
            const ex = b.gx - a.gx, ey = b.gy - a.gy, ee = ex * ex + ey * ey;
            const f = ee > 0 ? clamp(-(a.gx * ex + a.gy * ey) / ee, 0, 1) : 0, gd = Math.hypot(a.gx + f * ex, a.gy + f * ey);
            if (gd < d) {
                d = gd; bt = t + f * dt;
                for (const key of ['cx', 'cy', 'tx', 'ty', 'ux', 'uy']) best[key] = a[key] + f * (b[key] - a[key]);
                if (g.type === 'reach' && gd < reach) inside = true;
            } else if (inside) break;
            t += dt;
            Object.assign(a, b);
            let hit = false;
            for (let i = 0; i < n; i++) if (i !== ci && Math.hypot(PRX[i] - PRX[ci], PRY[i] - PRY[ci]) < touch[i]) hit = true;
            if (hit) break;
        }
        if (!(d < Infinity)) return null;
        return { t0: simTime, h: H, t: simTime + bt, d, dv: Math.hypot(best.ux, best.uy), cx: best.cx, cy: best.cy, tx: best.tx, ty: best.ty };
    }

    function refreshPrediction(force) {
        const d = mission.def;
        if (!d || (d.goal.type !== 'reach' && d.goal.type !== 'meet')) { mission.pred = null; return; }
        const p = mission.pred;
        if (!force && !mission.predDirty && p && simTime < p.t && simTime - p.t0 < 0.1 * p.h && simTime >= p.t0) return;
        mission.predDirty = false;
        mission.pred = predictApproach(Math.max(d.limit - simTime, 0.02));
    }

    // ---- Starting, leaving, undo ----
    // (from loadScene: a mission's scene starts the mission, any other ends one)
    function missionSceneLoaded() {
        const def = missionByKey(settings.scene);
        if (!def) { if (mission.def) { endMission(); setPaused(false); } else hideMissionPanel(); return; }   // (a mission waits for Play)
        Object.assign(mission, {
            def, status: 'ready', reason: '', crashedInto: '', used: 0, log: [], steps: 0, result: null, resultShown: false,
            craftId: bodies[def.craft].id, refId: bodies[def.ref].id, targetId: def.target !== null ? bodies[def.target].id : null,
            nearId: null, pred: null, predDirty: true, plan: null, tell: null, aimPaused: false, burst: 0,
            arrived: false, gapWas: Infinity, ahead: false
        });
        clearTimeout(mission.burstTimer);
        endSkip();
        engineStop();
        if (def.lock !== undefined) {
            // (the view follows the body it is about, and the box is round it)
            frameId = bodies[def.lock].id;
            syncFrameUi();
            fitBox(def.scene.box, false);
        }
        // Every mission starts at the same pace, and the arrow keys are for the engine from now on
        // (not for the scene list, if it was picked there with the mouse)
        missionSpeedRange(true);
        setSpeedValue(1);
        mission.fine = false;
        edit.engaged = true;
        if (document.activeElement === ui.scene && performance.now() - mission.sceneKeyAt > 1000) ui.scene.blur();
        closeSettingsSheet();
        hideMissionPanel();
        missionUi(true);
        quietFlyby();
        setPaused(true);
        syncEccentricity(true);
        setHint();
    }

    function endMission() {
        clearTimeout(mission.burstTimer);
        endSkip();
        engineStop();
        missionSpeedRange(false);
        if (mission.home) setSpeedValue(mission.home.speed);
        Object.assign(mission, { def: null, status: 'off', pred: null, plan: null, tell: null, aimPaused: false, result: null, home: null });
        hideMissionPanel();
        missionUi(false);
        if (popBody) updatePopover(true);
        syncEccentricity(true);
        setHint();
    }

    function startFlying() {
        mission.status = 'flying';
    }

    // (from loadScene, before anything changes) Going into a mission from anything else: what to come
    // back to. (Not from a mission's scene without its mission: a link's, about to start it properly.)
    function missionKeepHome(key) {
        if (mission.def || !missionByKey(key)) return;
        mission.home = missionByKey(settings.scene) ? { speed: settings.speed } : {
            snap: snapshot(), speed: settings.speed, paused, back: timeDir < 0, clean: hist.cleanLoad, turn: turnSetup(), stability: settings.stability, stabAuto: stab.auto
        };
    }

    // Back to free play: the system as it was, its speed, its view, its way of time, running or paused.
    // Undo goes back into the mission.
    function leaveMission() {
        const h = mission.home;
        if (!h || !h.snap) {
            if (ui.scene) ui.scene.value = 'sun-earth';
            loadScene('sun-earth');
            setPaused(false);
            return;
        }
        flushEdit();
        dragging();
        hideMissionPanel();
        commitStep(snapshot(), { label: 'leave the mission', target: null, key: 'scene' }, false);
        restoreSnapshot(h.snap, 'undo');
        if (h.back) setReverse(true, true);
        if (h.turn) restoreTurning({ a: h.turn[0], up: h.turn[1] });
        if (h.stability) setStability(true, h.stabAuto);
        syncFrameUi();
        Object.assign(hist, { open: null, cleanLoad: h.clean, rwStale: true, rwFresh: false, rwFromStart: h.clean });
        updateHistoryUi();
        setPaused(h.paused);
    }

    // (the end of applySetup) A link or an autosave made in a mission holds no fuel or burns, so its
    // mission starts afresh
    function missionFromSetup(s) {
        if (missionByKey(s.scene)) loadScene(s.scene);
    }

    // (part of each edit-history snapshot)
    function missionSnapshot() {
        if (!mission.def) return null;
        return {
            id: mission.def.id, craftId: mission.craftId, refId: mission.refId, targetId: mission.targetId,
            used: mission.used, log: mission.log.slice(), status: mission.status,
            reason: mission.reason, crashedInto: mission.crashedInto, result: mission.result
        };
    }

    // Undo, redo or run again: the mission as it was. (A result is undone with what led to it, and a
    // redo back to the end of a mission brings the result back with it, and its card.)
    function missionRestore(m, how) {
        const def = m ? missionById(m.id) : null;
        if (!def) { if (mission.def) endMission(); return; }
        const was = mission.def, usedBefore = mission.used, over = m.status === 'won' || m.status === 'lost';
        Object.assign(mission, {
            def, craftId: m.craftId, refId: m.refId, targetId: m.targetId, used: m.used, log: m.log.slice(), status: m.status,
            reason: over ? m.reason : '', crashedInto: over ? m.crashedInto : '', result: over ? m.result : null,
            resultShown: false, aimPaused: false, predDirty: true, plan: null, tell: null, steps: 0,
            arrived: true, gapWas: Infinity, ahead: false   // (back in the ring by undo: no second stop for it)
        });
        clearTimeout(mission.burstTimer);
        mission.burst = 0;
        endSkip();
        if (mission.firing) { clearTimeout(mission.firing.timer); mission.firing = null; }
        hideMissionPanel();
        quietFlyby();
        if (over) setPaused(true);
        if (was !== def) {
            if (!was) { mission.home = { speed: settings.speed }; missionSpeedRange(true); setSpeedValue(1); }
            missionUi(true);
            syncEccentricity(true);
        }
        updateMissionConsole();
        // (the undo note, put up just after this, says how much fuel came back)
        if (how === 'undo' && Math.abs(usedBefore - m.used) > 1e-9) {
            setTimeout(() => {
                const h = hints.missionNote;
                if (!mission.def || !h || typeof h.html !== 'string' || !/^<strong>(Undone|Redone)/.test(h.html)) return;
                historyNote(`${h.html}. Fuel left: ${f1(Math.max(0, mission.def.budget - mission.used))} km/s.`);
            }, 0);
        }
    }

    // ---- Best results (localStorage, which may be blocked: then just not kept) ----
    let bestCache = null;
    function bestAll() {
        if (bestCache) return bestCache;
        try { bestCache = JSON.parse(localStorage.getItem(MISSION_STORE) || '{}') || {}; } catch (e) { bestCache = {}; }
        return bestCache;
    }
    function bestOf(id) { const b = bestAll()[id]; return b && b.stars >= 1 ? b : null; }
    function saveBest(id, r) {
        bestAll()[id] = r;
        try { localStorage.setItem(MISSION_STORE, JSON.stringify(bestCache)); } catch (e) { /* not kept */ }
        labelMissionOptions();
    }

    // ---- Locks on the menu and the sidebar ----
    // (the end of updateEditor) In a mission the Orbit tab, mass, radius, Circular and Delete are greyed
    // out, and for any body but the probe the Velocity tab too
    function missionLockMenu(b) {
        const on = !!mission.def;
        if (!on && !mission.menuLocked) return;
        mission.menuLocked = on;
        if (ui.popMass) ui.popMass.disabled = on;
        if (ui.popDelete) ui.popDelete.disabled = on;
        if (!on) return;
        const craft = b.id === mission.craftId;
        for (const el of edit.orbitEls) el.disabled = true;
        if (!craft) for (const el of edit.velEls) el.disabled = true;
        if (ui.popRadius) ui.popRadius.disabled = true;
        if (ui.popCircular) ui.popCircular.disabled = true;
        const why = craft ? 'Orbits change only by burns: use the Velocity tab.' : `Only your probe has an engine: ${theName(b)} keeps to its path.`;
        setText(ui.popOrbitShape, why);
        if (!craft) setText(ui.popAngleNote, why);
    }
    // (syncEccentricity) the eccentricity slider
    function missionLockSidebar() {
        if (!mission.def) return;
        if (ui.ecc) ui.ecc.disabled = true;
        setText(ui.eccNote, 'In a mission, orbits change only by burns of your probe\'s engine.');
    }

    // ---- The console, the card over the canvas, the Missions button, the scene list ----
    Object.assign(ui, { simWrap: document.querySelector('.orbits-sim'), toolbar: byId('orbToolbar'), missionPanel: null, missionsBtn: null, mc: null });
    const toolIcon = (name) => `<span class="icon solid fa-${name}" aria-hidden="true"></span>`;

    function buildMissionUi() {
        const wrap = canvas.closest('.sim-canvas-wrapper');
        if (wrap) {
            const P = document.createElement('section');
            P.className = 'orb-mission-panel';
            P.id = 'missionPanel';
            P.hidden = true;
            P.setAttribute('aria-labelledby', 'missionTitle');
            P.setAttribute('aria-live', 'polite');
            P.innerHTML = `<button type="button" class="orb-mission-x" aria-label="Close" title="Close (Esc)">${toolIcon('times')}</button>`
                + '<p class="orb-mission-kicker" id="missionKicker"></p><h3 class="orb-mission-title" id="missionTitle"></h3>'
                + '<div class="orb-mission-text" id="missionText"></div><div class="orb-mission-actions" id="missionActions"></div>';
            wrap.appendChild(P);
            ui.missionPanel = P;
            P.querySelector('.orb-mission-x').addEventListener('click', () => hideMissionPanel(true));
            // (Escape closes it, wherever the focus is, before anything else that Escape would close)
            window.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape' || P.hidden) return;
                hideMissionPanel(true);
                e.stopImmediatePropagation();
                e.preventDefault();
            }, true);
            // (clicks and drags in it stay away from the canvas and the page)
            ['pointerdown', 'dblclick', 'wheel'].forEach((t) => P.addEventListener(t, (e) => e.stopPropagation()));
        }
        if (ui.toolbar) buildMissionConsole();
        // In the settings, under the scene list: a button into the missions (beside "Random system"),
        // and the line saying what they are
        if (ui.scene) {
            const group = ui.scene.closest('.sim-control-group') || ui.scene.parentElement;
            const row = byId('sceneButtons');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'orb-mission-btn';
            btn.id = 'missionsBtn';
            btn.setAttribute('aria-describedby', 'missionsNote');
            btn.title = `${MISSIONS.length} missions, easy to hard (M)`;
            btn.innerHTML = `${toolIcon('rocket')}Missions`;
            let note = byId('missionsNote');
            if (!note) {
                note = document.createElement('p');
                note.className = 'orb-note';
                note.id = 'missionsNote';
                note.textContent = `Fly a probe to a goal on a fuel budget: ${MISSIONS.length} missions, easy to hard, also at the end of the scene list.`;
                group.append(note);
            }
            if (row) row.prepend(btn); else group.insertBefore(btn, note);
            ui.missionsBtn = btn;
            btn.addEventListener('click', openMissions);
            const og = document.createElement('optgroup');
            og.label = 'Missions';
            for (const m of MISSIONS) {
                const o = document.createElement('option');
                o.value = m.key;
                og.appendChild(o);
            }
            ui.scene.appendChild(og);
            labelMissionOptions();
            ui.scene.addEventListener('keydown', () => { mission.sceneKeyAt = performance.now(); });
        }
        // The usual hint's "Missions", and M
        if (ui.hint) ui.hint.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.orb-hint-missions')) openMissions(); });
        window.addEventListener('keydown', (e) => {
            if ((e.key !== 'm' && e.key !== 'M') || e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target)) return;
            if (!(nav.inUse || document.body.classList.contains('sim-fullscreen-active'))) return;
            e.preventDefault();
            openMissions(e);
        });
        // The engine stops when its key comes up, wherever the focus has gone (or the window with it)
        window.addEventListener('keyup', (e) => { if (mission.firing && mission.firing.key === e.key) engineStop(); });
        window.addEventListener('blur', engineStop);
    }

    // The console: in the palette's place while a mission is loaded
    function buildMissionConsole() {
        const C = document.createElement('section');
        C.className = 'orb-console';
        C.id = 'missionConsole';
        C.hidden = true;
        C.setAttribute('aria-labelledby', 'mcTitle');
        const pad = [['faster', 'Forward', 'arrow-up', '↑'], ['in', 'In', 'arrow-left', '←'], ['out', 'Out', 'arrow-right', '→'], ['slower', 'Back', 'arrow-down', '↓']];
        C.innerHTML = '<div class="orb-mc-head"><h3 class="orb-mc-title" id="mcTitle"></h3>'
            + `<button type="button" class="orb-mc-leave" id="mcLeave" aria-label="Leave the mission" title="Leave the mission, back to free play">${toolIcon('times')}</button></div>`
            + '<p class="orb-mc-goal" id="mcGoal"></p><p class="orb-mc-status" id="mcStatus"></p>'
            + '<div class="orb-mc-fuel" id="mcFuel" role="meter" aria-label="Fuel left" aria-valuemin="0"><div class="orb-mc-row"><strong>Fuel</strong><span id="mcFuelNum"></span></div>'
            + '<div class="orb-mc-bar"><div class="orb-mc-fill" id="mcFill"></div><div class="orb-mc-tick" id="mcTick" title="Keep your fuel above this mark for three stars"></div></div></div>'
            + '<div class="orb-mc-row orb-mc-left-row"><strong>Time</strong><span id="mcLeft"></span></div>'
            + '<div class="orb-mc-row orb-mc-pad-head"><strong id="mcPadLabel">Engine: hold to fire</strong><button type="button" class="orb-mc-fine" id="mcFine" aria-pressed="false" title="Much smaller burns, to fine-tune (or hold Shift)">Fine</button></div>'
            + `<div class="orb-mc-pad" role="group" aria-labelledby="mcPadLabel">${pad.map(([k, w, i, key]) => `<button type="button" class="orb-mc-burn orb-mc-${k}" data-kind="${k}" title="Burn ${w.toLowerCase()} (${key})">${toolIcon(i)}${w}</button>`).join('')}</div>`
            + `<button type="button" class="orb-mc-skip" id="mcSkip" hidden>${toolIcon('fast-forward')}<span id="mcSkipText"></span></button>`
            + `<div class="orb-mc-time"><button type="button" class="orb-mc-play" id="mcPlay">${toolIcon('play')}<span id="mcPlayText"></span></button>`
            + '<button type="button" class="orb-mc-retry" id="mcRetry" title="Start this mission again">Retry</button></div>'
            + '<div class="orb-mc-links"><button type="button" id="mcHow">How it works</button><button type="button" id="mcList">All missions</button></div>';
        ui.toolbar.prepend(C);
        const E = { box: C };
        ['Title', 'Goal', 'Status', 'Fuel', 'FuelNum', 'Fill', 'Tick', 'Fine', 'Play', 'PlayText', 'Skip', 'SkipText', 'Left', 'Retry', 'How', 'List', 'Leave'].forEach((n) => { E[n.toLowerCase()] = byId(`mc${n}`); });
        E.head = C.querySelector('.orb-mc-head');
        E.playIcon = E.play.querySelector('.icon');
        E.burns = Array.from(C.querySelectorAll('.orb-mc-burn'));
        ui.mc = E;
        // A button pressed with the pointer leaves the focus where it was, so Space still plays and pauses
        C.addEventListener('mousedown', (e) => { if (e.target.closest && e.target.closest('button')) e.preventDefault(); });
        E.burns.forEach((b) => {
            const kind = b.dataset.kind;
            b.addEventListener('pointerdown', (e) => {
                if (e.button) return;
                try { b.setPointerCapture(e.pointerId); } catch (err) { /* not captured: the window's events still end it */ }
                b.classList.add('is-firing');
                engineFire(kind, mission.fine || e.shiftKey);
            });
            const up = () => { b.classList.remove('is-firing'); engineStop(); };
            ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => b.addEventListener(t, up));
            b.addEventListener('contextmenu', (e) => e.preventDefault());
            // (Enter or Space on the button: a tap)
            b.addEventListener('click', (e) => { if (!e.detail) { engineFire(kind, mission.fine); engineStop(); } });
        });
        E.fine.addEventListener('click', () => { mission.fine = !mission.fine; updateMissionConsole(); });
        E.play.addEventListener('click', (e) => {
            if (mission.status === 'won') {
                const next = MISSIONS[mission.def.n];
                if (next) loadMission(next, !e.detail); else showMissionPanel('list', !e.detail);
                return;
            }
            if (mission.status === 'ready') startFlying();
            setPaused(!paused);
            updateMissionConsole();
        });
        E.skip.addEventListener('click', startSkip);
        E.retry.addEventListener('click', (e) => loadMission(mission.def, !e.detail));
        E.how.addEventListener('click', (e) => showMissionPanel('how', !e.detail));
        E.list.addEventListener('click', (e) => showMissionPanel('list', !e.detail));
        E.leave.addEventListener('click', leaveMission);
    }

    // "3. Escape the Sun ★★☆"
    function labelMissionOptions() {
        if (!ui.scene) return;
        for (const m of MISSIONS) {
            const o = ui.scene.querySelector(`option[value="${m.key}"]`);
            const b = bestOf(m.id);
            if (o) o.textContent = `${m.n}. ${m.title}${b ? ` ${starText(b.stars)}` : ''}`;
        }
    }

    // On a phone the settings cover the canvas: they step aside for a mission (any: on a wider screen
    // too, where they take room from it)
    function closeSettingsSheet(any) {
        const panel = byId('simulationControlsPanel'), toggle = document.querySelector('.sim-panel-toggle-button');
        if (panel && toggle && panel.classList.contains('panel-open') && (any || document.body.classList.contains('sim-panel-sheet'))) toggle.click();
    }

    // The Missions button (and M): straight into the first mission the first time, afterwards the list.
    // (From the keyboard, a key press or a button's click with no pointer, the focus goes along.)
    function openMissions(e) {
        closeSettingsSheet(true);
        const keyed = !!e && !e.detail;
        if (mission.def || MISSIONS.some((m) => bestOf(m.id))) showMissionPanel('list', keyed);
        else loadMission(MISSIONS[0], keyed);
    }

    function loadMission(def, focus) {
        if (!def) return;
        if (ui.scene) ui.scene.value = def.key;
        loadScene(def.key);
        if (focus && ui.mc) ui.mc.play.focus({ preventScroll: true });
    }

    function focusMissionPanel() {
        const btn = ui.missionPanel && !ui.missionPanel.hidden ? ui.missionPanel.querySelector('.orb-mission-actions button, .orb-mission-list button') : null;
        if (btn) btn.focus({ preventScroll: true });
    }

    function missionUi(on) {
        if (ui.simWrap) ui.simWrap.classList.toggle('orb-mission-on', on);
        if (ui.toolbar) ui.toolbar.setAttribute('aria-label', on ? 'Mission controls' : 'Add bodies');
        if (ui.mc) ui.mc.box.hidden = !on;
        if (sideways) placeHint();
        if (on) updateMissionConsole();
    }

    // The console, ten times a second and after each burn
    function updateMissionConsole() {
        const d = mission.def, E = ui.mc;
        if (!d || !E) return;
        const x = missionContext(), m = missionStatus(x), st = mission.status, over = missionIsOver();
        // (the button the hint names is marked, and the arrow on the probe follows the hint)
        const told = /(?:hold|holding|tap) <strong>(Forward|Back|In|Out)<\/strong>/i.exec(missionHintText() || '');
        const left = Math.max(0, d.budget - mission.used), best = bestOf(d.id);
        // (always three stars, full or empty, so a first win doesn't wrap the title and move everything)
        setText(E.title, `${d.n}. ${d.title} ${starText(best ? best.stars : 0)}`);
        setAttr(E.title, 'aria-label', `Mission ${d.n} of ${MISSIONS.length}: ${d.title}${best ? `, best ${best.stars} of 3 stars` : ''}`);
        setText(E.goal, d.goalText);
        setText(E.status, `${m.ok ? '✓ ' : ''}${m.text}`);
        E.status.classList.toggle('is-ok', m.ok);
        if (m.ok !== mission.okSaid) { mission.okSaid = m.ok; if (m.ok && !over) announce(`On track. ${m.text}`); }
        // The gauge: a mark where three stars are lost
        const frac = d.budget > 0 ? left / d.budget : 0;
        E.fill.style.width = `${(100 * frac).toFixed(1)}%`;
        E.fill.classList.toggle('is-low', frac < 0.15);
        E.tick.style.left = `${(100 * clamp(1 - STARS_AT[0] * d.par / d.budget, 0, 1)).toFixed(1)}%`;
        setText(E.fuelnum, `${f1(left)} of ${f1(d.budget)} km/s`);
        setAttr(E.fuel, 'aria-valuemax', f1(d.budget));
        setAttr(E.fuel, 'aria-valuenow', f1(left));
        setAttr(E.fuel, 'aria-valuetext', `${f1(left)} of ${f1(d.budget)} kilometres a second`);
        for (const b of E.burns) {
            if (b.disabled !== over) b.disabled = over;
            b.classList.toggle('is-told', !over && !!told && b.dataset.kind === BURN_KIND[told[1]]);
        }
        E.fine.disabled = over;
        setAttr(E.fine, 'aria-pressed', mission.fine ? 'true' : 'false');
        // The clock's button, and the skip
        // (after a win it is the way on, and Retry is the plain button beside it)
        const ready = st === 'ready', won = st === 'won', running = !paused || !!(mission.firing && mission.aimPaused && !ready);
        const clockWord = won ? (MISSIONS[d.n] ? 'Next mission' : 'All missions') : running ? 'Pause' : 'Play';
        setText(E.playtext, clockWord);
        setAttr(E.play, 'aria-label', clockWord);
        E.play.classList.toggle('is-primary', ready || won);
        E.play.classList.toggle('is-next', won);
        E.playIcon.hidden = won;
        E.playIcon.classList.toggle('fa-play', !running);
        E.playIcon.classList.toggle('fa-pause', running);
        E.play.hidden = st === 'lost';
        const s = over ? null : skipTarget(x);
        E.skip.hidden = !s && !mission.skip;
        E.skip.disabled = !!mission.skip;
        if (s || mission.skip) setText(E.skiptext, mission.skip ? 'Skipping…' : `Skip to ${s.word}`);
        setText(E.left, over ? `${fmtDuration(simTime)} taken` : `${fmtDuration(Math.max(0, d.limit - simTime))} left`);
        E.retry.classList.toggle('is-primary', st === 'lost');
    }

    const starsHtml = (n) => `<span class="orb-mission-stars" role="img" aria-label="${n} of 3 stars">${starText(n)}</span>`;
    const panelWords = {
        how(d) {
            return {
                kicker: `Mission ${d.n} of ${MISSIONS.length}`, title: 'How it works',
                html: `<p>${d.idea}</p><p class="orb-mission-small"><strong>Par ${f1(d.par)} km/s:</strong> ${d.parText}</p>`
                    + '<p class="orb-mission-small">Keep your fuel above the mark on the gauge for three stars. Undo gives fuel back.</p>',
                acts: [['Carry on', () => hideMissionPanel(true)]]
            };
        },
        list() {
            const total = MISSIONS.reduce((n, m) => n + (bestOf(m.id) ? bestOf(m.id).stars : 0), 0);
            const next = MISSIONS.find((m) => !bestOf(m.id));
            const rows = MISSIONS.map((m) => {
                const b = bestOf(m.id), here = mission.def === m;
                return `<li><button type="button" data-mission="${m.id}"${here ? ' aria-current="true"' : ''}${m === next ? ' class="is-next"' : ''}><span class="orb-mission-row-name">${m.n}. ${escapeHtml(m.title)}</span>`
                    + `<span class="orb-mission-stars" role="img" aria-label="${b ? `${b.stars} of 3 stars` : 'not flown yet'}">${starText(b ? b.stars : 0)}</span></button></li>`;
            }).join('');
            return {
                kicker: `${total} of ${3 * MISSIONS.length} stars`, title: 'Missions',
                html: `<ol class="orb-mission-list">${rows}</ol>`,
                acts: mission.def ? [['Back to free play', leaveMission]] : []
            };
        },
        result(d) {
            const kicker = `Mission ${d.n} of ${MISSIONS.length}`;
            if (mission.status === 'won') {
                const r = mission.result, next = MISSIONS[d.n];
                const best = r.better ? (r.prev ? ' A new best!' : '') : ` Your best: ${starText(r.prev.stars)}.`;
                return {
                    kicker, title: 'Mission complete!',
                    html: `<p>${starsHtml(r.stars)}</p><p>${f1(r.used)} km/s of fuel; par ${f1(d.par)}.${best}</p><p class="orb-mission-small">${d.teach}</p>`,
                    acts: [next ? ['Next mission', () => loadMission(next)] : ['All missions', () => showMissionPanel('list')], ['Retry', () => loadMission(d)]].concat(next ? [['All missions', () => showMissionPanel('list')]] : [])
                };
            }
            const what = {
                fuel: 'Coasting won\'t get you there.',
                time: `Time's up: the limit was ${fmtDuration(d.limit)}.`,
                missed: 'Too fast for it to keep you.'
            }[mission.reason] || '';
            const hint = d.fail[mission.reason] || d.fail.time || d.fail.fuel || 'Undo your last burn and try another, or start again.';
            return {
                kicker, title: mission.reason === 'crash' ? `You hit ${escapeHtml(theName({ name: mission.crashedInto }))}` : (LOST_TITLE[mission.reason] || 'Mission over'),
                html: `${what ? `<p>${what}</p>` : ''}<p><strong>Hint:</strong> ${hint}</p>`,
                acts: [['Retry', () => loadMission(d)]].concat(mission.log.length ? [['Undo last burn', () => { hideMissionPanel(); undoStep(); }]] : [], [['All missions', () => showMissionPanel('list')]])
            };
        }
    };

    // The card over the canvas, on request ('how', 'list') or for the outcome ('result'). The clock
    // waits while one asked for is open.
    function showMissionPanel(kind, focus) {
        const d = mission.def, P = ui.missionPanel;
        if (!P || (kind !== 'list' && !d)) return;
        endSkip();
        const w = panelWords[kind](d);
        mission.panel = kind;
        if (d && mission.status === 'flying' && !paused && kind !== 'result') { setPaused(true); mission.aimPaused = true; }
        byId('missionKicker').textContent = w.kicker;
        byId('missionTitle').innerHTML = w.title;
        const text = byId('missionText');
        text.innerHTML = w.html;
        text.querySelectorAll('[data-mission]').forEach((b) => b.addEventListener('click', (e) => {
            hideMissionPanel(true);
            loadMission(missionById(b.dataset.mission), !e.detail);
        }));
        const box = byId('missionActions');
        box.textContent = '';
        w.acts.forEach(([label, fn], i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            if (i === 0 && kind !== 'list') b.className = 'is-primary';
            b.addEventListener('click', (e) => {
                const keyed = !e.detail;
                fn();
                if (keyed && ui.missionPanel.hidden && mission.def && ui.mc) ui.mc.play.focus({ preventScroll: true });
                else if (keyed) focusMissionPanel();
                else b.blur();
            });
            box.appendChild(b);
        });
        P.classList.toggle('is-list', kind === 'list');
        P.hidden = false;
        P.scrollTop = 0;
        if (focus) focusMissionPanel();
    }

    function hideMissionPanel(byUser) {
        const P = ui.missionPanel;
        const wasOpen = !!P && !P.hidden;
        mission.panel = null;
        if (!wasOpen) return;
        // (if the focus was in it, it goes back to the page rather than to nowhere)
        const had = P.contains(document.activeElement);
        P.hidden = true;
        if (had && byUser) document.activeElement.blur();
        if (byUser) resumeAfterAim();
    }

    // The outcome, once: the card, and a gentle ring round the probe. (The keyboard's user can go on with
    // Enter at once.)
    function showResult() {
        const c = bodyById(mission.craftId);
        mission.resultShown = true;
        showMissionPanel('result', mission.keyed);
        if (mission.status === 'won' && c) flashes.push({ x: c.x, y: c.y, t: performance.now(), color: colours().velocity, r0: drawRadius(c), grow: 40 });
    }

    // In a mission the probe's flybys get no card or close-up (the mission card says what matters):
    // its flyby is marked as over, with no planet, which is how flybyStep and the card leave it alone
    function quietFlyby() {
        if (flyby.bid !== mission.craftId || flyby.pid !== null) Object.assign(flyby, { bid: mission.craftId, pid: null, active: false, done: true, pts: [] });
    }

    // Ten times a second (with the readouts): the start, the clock while aiming, the prediction, the
    // result, the console, and the hint line following the mission's progress (unless a note is showing)
    function updateMission() {
        if (!mission.def) return;
        if (mission.status === 'ready' && !paused) startFlying();
        const c = bodyById(mission.craftId);
        if (c && c.held && !paused) { setPaused(true); mission.aimPaused = true; }
        if (mission.status === 'flying' || mission.status === 'ready') refreshPrediction(false);
        // (the clock stopped some other way during a skip: that ends it)
        if (mission.skip && paused) endSkip();
        if (missionIsOver() && !mission.resultShown) showResult();
        quietFlyby();
        // (the probe's path, as it stands, is always on show while flying)
        if (!missionIsOver()) edit.previewUntil = performance.now() + 500;
        updateMissionConsole();
        refreshHint();   // (the guidance follows the mission's progress; the line only changes if it does)
    }

    // ---- Drawing ----
    // Under the bodies: the goal ring (with the band the orbit must stay in), the target's ring, L4 and
    // its zone, where the next burn goes (the far or closest point, the launch window) and where the
    // probe and the target will be at their coming closest approach. Their names are noted for
    // drawMissionOver, which puts them on top.
    function drawMissionMarks(C) {
        const d = mission.def;
        if (!d || cleanRender) return;
        const R = bodyById(mission.refId);
        if (!R) return;
        const g = d.goal, col = C.velocity, cx = sx(R.dx), cy = sy(R.dy);
        const labels = mission.labels = [];
        ctx.save();
        const ring = (x, y, r, label) => {
            ctx.strokeStyle = hexA(col, C.dark ? 0.6 : 0.75);
            ctx.lineWidth = 1.2;
            ctx.setLineDash([4, 6]);
            ctx.beginPath();
            ctx.arc(x, y, r, 0, TAU);
            ctx.stroke();
            ctx.setLineDash([]);
            // (a ring that fills a phone's canvas has its name just inside it, if under or over it won't do)
            if (label && r > 14) labels.push({ text: label, spots: (w, fs) => [[x, y + r + 5], [x, y - r - 5 - fs], [x, y + r - 6 - fs], [x, y - r + 6], [x - r + 11 + w / 2, y - fs / 2], [x + r - 11 - w / 2, y - fs / 2]] });
        };
        if (g.type === 'orbit') {
            ctx.fillStyle = hexA(col, C.dark ? 0.08 : 0.1);
            ctx.beginPath();
            ctx.arc(cx, cy, g.r * (1 + g.tol) * scale, 0, TAU);
            ctx.arc(cx, cy, g.r * (1 - g.tol) * scale, 0, TAU, true);
            ctx.fill();
            ring(cx, cy, g.r * scale, `goal: ${g.r} AU`);
        } else if (g.type === 'capture') {
            ring(cx, cy, g.lim * scale, 'goal: orbit inside');
        }
        const T = mission.targetId !== null ? bodyById(mission.targetId) : null;
        if (g.l4 && T) {
            // L4: the point 60 degrees ahead of Jupiter, with the zone to park in
            const c = 0.5, s = Math.sqrt(3) / 2, jx = T.dx - R.dx, jy = T.dy - R.dy;
            const lx = sx(R.dx + c * jx - s * jy), ly = sy(R.dy + s * jx + c * jy);
            ring(lx, ly, g.D * scale, null);
            ctx.strokeStyle = col;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(lx - 5, ly); ctx.lineTo(lx + 5, ly); ctx.moveTo(lx, ly - 5); ctx.lineTo(lx, ly + 5);
            ctx.stroke();
            labels.push(markName('L4', lx, ly, Math.max(7, g.D * scale) + 1, true));
        } else if (T) {
            // The ring to get inside, round the target; and Mars's path, to fly out to
            ring(sx(T.dx), sy(T.dy), Math.max((g.type === 'reach' ? g.zone : g.D) * scale, 6), null);
            if (g.type === 'reach') ring(cx, cy, Math.hypot(T.dx - R.dx, T.dy - R.dy) * scale, null);
        }
        const p = mission.pred, c = bodyById(mission.craftId);
        // Where the next burn goes: a world offset from R, turned as the view is turned
        const x = c && !missionIsOver() ? missionContext() : null, next = skipTarget(x);
        if (next && next.kind !== 'meet') {
            const ang = turn.on ? turnAngleIn(0) : 0;
            const at = (wx, wy) => [cx + (Math.cos(ang) * wx - Math.sin(ang) * wy) * scale, cy - (Math.sin(ang) * wx + Math.cos(ang) * wy) * scale];
            let spot, label = 'burn here';
            if (next.kind === 'window') {
                const a = Math.atan2(x.ry, x.rx) + d.lead * DEG;
                spot = at(x.tr * Math.cos(a), x.tr * Math.sin(a));
                label = 'launch when Mars is here';
            } else {
                const k = (next.kind === 'apo' ? -x.ra : x.rp) / x.el.e;
                spot = at(x.el.ex * k, x.el.ey * k);
            }
            ctx.strokeStyle = C.dark ? C.text : '#16181c';
            ctx.fillStyle = hexA(col, 0.35);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(spot[0], spot[1], 6, 0, TAU);
            ctx.fill();
            ctx.stroke();
            labels.push(markName(label, spot[0], spot[1], 9));
        }
        const ghost = p && T && c && mission.log.length && mission.status === 'flying' && p.t > simTime;
        // (the places predicted are world offsets from R at that time: turned as the view will be turned
        // then, so in a rotating frame they are seen from the pair as it will be)
        const ga = ghost ? turnAngleIn(p.t - simTime) : 0, gc = Math.cos(ga), gs = Math.sin(ga);
        const tx = ghost ? cx + (gc * p.tx - gs * p.ty) * scale : 0, ty = ghost ? cy - (gs * p.tx + gc * p.ty) * scale : 0;
        const kx = ghost ? cx + (gc * p.cx - gs * p.cy) * scale : 0, ky = ghost ? cy - (gs * p.cx + gc * p.cy) * scale : 0;
        // (not when it would sit on the target as it is now: they are about to meet; in a frame turning
        // with the target, where it stands still, when the probe is about to reach its closest point)
        const nowX = g.l4 ? sx(R.dx + 0.5 * (T.dx - R.dx) - Math.sqrt(3) / 2 * (T.dy - R.dy)) : T ? sx(T.dx) : 0;
        const nowY = g.l4 ? sy(R.dy + Math.sqrt(3) / 2 * (T.dx - R.dx) + 0.5 * (T.dy - R.dy)) : T ? sy(T.dy) : 0;
        const soon = ghost && (turnUses(T) ? Math.hypot(kx - sx(c.dx), ky - sy(c.dy)) <= 24 : Math.hypot(tx - nowX, ty - nowY) <= 24);
        mission.ghostPx = ghost ? { tx, ty, kx, ky, shown: !soon } : null;   // (for testing)
        if (ghost && !soon) {
            if (Math.hypot(tx - kx, ty - ky) > 9) {
                ctx.strokeStyle = C.faint;
                ctx.lineWidth = 1;
                ctx.setLineDash([2, 4]);
                ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(kx, ky); ctx.stroke();
                ctx.setLineDash([]);
            }
            ctx.strokeStyle = g.l4 ? col : bodyStroke(T.color, C.dark);
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(tx, ty, 6, 0, TAU); ctx.stroke();
            ctx.fillStyle = bodyStroke(c.color, C.dark);
            ctx.beginPath(); ctx.arc(kx, ky, 2.5, 0, TAU); ctx.fill();
            labels.push(markName(`${g.l4 ? 'L4' : T.name} in ${fmtDuration(p.t - simTime)}`, tx, ty, 9));
        }
        ctx.restore();
    }

    // A mark's name: the spots to try round a mark of radius r at (x, y), under it first (or over it)
    function markName(text, x, y, r, over) {
        return {
            text,
            spots: (w, fs) => {
                const under = [x, y + r + 3], above = [x, y - r - 3 - fs];
                return [over ? above : under, over ? under : above, [x + r + 5 + w / 2, y - fs / 2], [x - r - 5 - w / 2, y - fs / 2]];
            }
        };
    }

    // Over the bodies and arrows: the burn the hint asks for, as an arrow on the probe; and the names of
    // the marks, each on a backing of the canvas's colour so the lines under it don't strike it through,
    // in the first spot clear of the canvas's edges, the bodies and each other. (drawLabels, next, keeps
    // the bodies' names clear of them too.)
    function drawMissionOver(C) {
        mission.labelBoxes = [];
        if (!mission.def || cleanRender) return;
        const labels = mission.labels, t = mission.tell, c = missionCraft();
        ctx.save();
        if (t && c && !missionIsOver()) {
            const a = turn.on ? turnAngleIn(0) : 0, ux = Math.cos(a) * t.ux - Math.sin(a) * t.uy, uy = -(Math.sin(a) * t.ux + Math.cos(a) * t.uy), n = Math.hypot(ux, uy) || 1;
            const x0 = sx(c.dx) + ux / n * (drawRadius(c) + 3), y0 = sy(c.dy) + uy / n * (drawRadius(c) + 3);
            const L = clamp(40 + 30 * t.kms, 40, 90) * sizeScale, x1 = x0 + ux / n * L, y1 = y0 + uy / n * L;
            arrow(x0, y0, x1, y1, C.burn, 3);
            mission.labelBoxes.push({ l: Math.min(x0, x1) - 3, r: Math.max(x0, x1) + 3, t: Math.min(y0, y1) - 3, b: Math.max(y0, y1) + 3 });   // (names keep off it)
            // (the arrow's end can lie on the ring on the velocity arrow, a burn being along the motion: its name stands clear)
            const q = mission.tipBox, off = q.r > q.l ? Math.hypot((q.l + q.r) / 2 - x1, (q.t + q.b) / 2 - y1) : Infinity;
            labels.push(markName(`burn ${kmsWords(t.kms)} km/s`, x1, y1, off < 28 ? off + (q.r - q.l) / 2 + 5 : 5, uy < 0));
        }
        const fs = clamp(Math.min(viewW, viewH) / 46, 10, 12), pad = 3;
        const zones = edgeKeepOut(), boxes = mission.labelBoxes;
        boxes.push(mission.tipBox);
        const discs = bodies.map((b) => ({ x: sx(b.dx), y: sy(b.dy), r: drawRadius(b) }));
        ctx.font = font(fs);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (const q of labels) {
            const w = ctx.measureText(q.text).width;
            let at = null;
            for (const [cx0, ty] of q.spots(w, fs)) {
                if (ty < 2 || ty + fs > viewH - 2) continue;
                const lx = clamp(cx0, w / 2 + 4, viewW - w / 2 - 4), l = lx - w / 2 - pad, r = lx + w / 2 + pad, b = ty + fs + 1;
                const clear = !zones.some((z) => l < z[2] && r > z[0] && ty < z[3] && b > z[1])
                    && !boxes.some((z) => l < z.r && r > z.l && ty < z.b && b > z.t)
                    && !discs.some((d) => d.x + d.r > l && d.x - d.r < r && d.y + d.r > ty && d.y - d.r < b);
                if (at === null || clear) at = { l, r, t: ty, b, lx };
                if (clear) break;
            }
            if (!at) continue;
            boxes.push(at);
            ctx.fillStyle = hexA(C.bg, 0.86);
            roundRect(at.l, at.t - 1, at.r - at.l, at.b - at.t + 1, 3);
            ctx.fill();
            ctx.fillStyle = C.text;
            ctx.fillText(q.text, at.lx, at.t);
        }
        mission.tipBox.r = -1;
        ctx.restore();
    }

    // For testing: the mission as it stands (the goal's own numbers in goal, km/s and AU)
    function missionState() {
        const d = mission.def;
        if (!d) return { id: null, status: 'off' };
        if (mission.status === 'flying') refreshPrediction(false);
        const x = missionContext(), g = d.goal, p = mission.pred;
        const now = {};
        if (x) {
            now.bound = x.el.bound; now.e = x.el.e; now.rp = x.rp; now.ra = x.ra; now.r = x.el.r; now.v = toKms(x.el.v);
            if (x.tname) { now.target = x.tname; now.d = x.td; now.dv = toKms(x.tdv); now.phase = x.phase; }
        }
        return {
            id: d.id, n: d.n, title: d.title, status: mission.status, reason: mission.reason, crashedInto: mission.crashedInto,
            used: mission.used, left: Math.max(0, d.budget - mission.used), budget: d.budget, par: d.par, limit: d.limit,
            burns: mission.log.length / 2, log: mission.log.slice(), time: simTime, paused,
            result: mission.result ? Object.assign({}, mission.result) : null, best: bestOf(d.id),
            goal: Object.assign({ type: g.type }, g, g.V ? { V: toKms(g.V) } : {}), now,
            closest: p && (g.type === 'reach' || g.type === 'meet') ? { d: p.d, dv: toKms(p.dv), inYears: p.t - simTime, px: mission.ghostPx } : null,
            panel: mission.panel, hint: mission.hintShown, craft: x ? x.c.name : null,
            skip: mission.skip ? mission.skip.kind : null, offers: skipTarget(x), speed: settings.speed, firing: !!mission.firing,
            tell: mission.tell ? Object.assign({}, mission.tell) : null
        };
    }

    buildMissionUi();

    // ------------------------------------------------------------------
    // Canvas sizing: drawing buffer = CSS size x devicePixelRatio
    // ------------------------------------------------------------------
    function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width));
        const h = Math.max(1, Math.round(rect.height));
        const newDpr = Math.min(2, window.devicePixelRatio || 1);
        if (w === viewW && h === viewH && newDpr === dpr) { syncDrawer(rect); return; }
        const first = !viewW || !viewH;
        viewW = w; viewH = h; dpr = newDpr;
        syncDrawer(rect);
        if (ui.simWrap) ui.simWrap.style.setProperty('--orb-canvas-h', `${h}px`);   // (the settings stay as tall as the canvas)
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

    // ---- The Settings drawer ----
    // Beside the canvas, Settings is a drawer over one side of it, which moves no control. While it is
    // open the rest of the canvas is the frame: the cards, the corner text and the body's menu keep to
    // that (visL, visR), and the middle of the view eases to its middle (view.shift, in px, so it holds at
    // any zoom); a scene that would be cut off there is eased to fit. As it shuts all that eases back, but
    // a view panned or zoomed meanwhile stays where it is on the screen. Worked out only when the layout
    // changes: the page sends a resize as the panel opens and shuts.
    function syncDrawer(cr) {
        const panel = byId('simulationControlsPanel');
        let l = 0, r = viewW;
        if (panel && panel.offsetParent && panel.classList.contains('panel-open') && document.body.classList.contains('sim-panel-side')) {
            // (by its place in the layout: as it opens it is still sliding in)
            const o = panel.offsetParent, a = o.getBoundingClientRect().left + o.clientLeft + panel.offsetLeft - cr.left, b = a + panel.offsetWidth;
            if (a + b > viewW) r = clamp(Math.round(a), 0, viewW); else l = clamp(Math.round(b), 0, viewW);
        }
        if (l === visL && r === visR) return;
        const was = drawer.open;
        visL = l; visR = r;
        drawer.open = l > 0 || r < viewW;
        view.shiftTo = (l + r - viewW) / 2;
        if (ui.simWrap) ui.simWrap.style.setProperty('--orb-vis-l', `${l}px`);
        const glide = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (drawer.open && !was) drawerOpened(glide); else if (was && !drawer.open) drawerShut(glide);
        if (!glide) view.shift = view.shiftTo;
        if (popBody) positionPopover(popBody);
    }

    // A fit (box) or another move by a command, while the drawer is open: nothing to put back as it shuts but that
    function drawerCamera(box) {
        if (!drawer.open) return;
        Object.assign(drawer, { moved: false, back: null, box });
    }

    function drawerOpened(glide) {
        drawerCamera(null);
        if (view.panned || mission.def || !bodies.length) return;
        updateDrawnPositions();
        const to = view.anim || view, k = to.zoom * Math.max(1, Math.min(viewW, viewH));
        const inside = (q, mid, a, b) => mid + (q[0] - to.panX) * k >= a && mid + (q[1] - to.panX) * k <= b;
        // (the scene with its orbits; if the view was already closer in than those, its bodies)
        for (const orbits of [true, false]) {
            const q = sceneBox(orbits);
            const y0 = viewH / 2 - (q[3] - to.panY) * k, y1 = viewH / 2 - (q[2] - to.panY) * k;
            if (!inside(q, viewW / 2, 0, viewW) || y0 < 0 || y1 > viewH) continue;
            if (inside(q, (visL + visR) / 2, visL + 6, visR - 6)) return;
            const back = { zoom: to.zoom, panX: to.panX, panY: to.panY, scene };
            fitBox(paddedBox(q), glide, to.zoom);
            Object.assign(drawer, { back, box: null });
            return;
        }
    }

    function drawerShut(glide) {
        const { moved, back, box } = drawer;
        Object.assign(drawer, { moved: false, back: null, box: null });
        if (moved) {
            if (view.anim) return;
            updateScale();
            view.panX -= view.shift / scale;
            view.shift = 0;
            view.panned = true;
            updateScale();
        } else if (back && back.scene === scene) {
            const to = { zoom: back.zoom, panX: back.panX, panY: back.panY };
            if (glide) view.anim = to; else { Object.assign(view, to); view.anim = null; }
        } else if (box) {
            fitBox(box, glide);
        }
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

    let focusByPointer = false;

    function bindControls() {
        const bindCheck = (el, key, after) => {
            if (!el) return;
            el.checked = settings[key];
            el.addEventListener('change', () => { settings[key] = el.checked; if (after) after(); });
        };
        bindCheck(ui.forces, 'forces');
        bindCheck(ui.velocities, 'velocities', () => refreshHint());
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
            // (the canvas says what the new speed means, as it does for [ and ])
            ui.speed.addEventListener('input', () => { upd(); paceZoom.was = 0; speedFlash = performance.now() + 1500; });
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
                hist.as = 'shape';   // (named so in the edit history)
                applyEccentricity(e);
            });
            ui.ecc.addEventListener('change', () => {
                eccDrag = null;
                keepOrbitInView(bodyById(selectedId));   // (zoom out if the new orbit no longer fits)
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
            ui.placement.addEventListener('change', () => { settings.placement = ui.placement.value; syncPlacementNote(); });
            syncPlacementNote();
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
            if (e.key === 'Escape' && escapeChipDrag()) {
                e.stopImmediatePropagation();
                e.preventDefault();
                return;
            }
            if (e.key === 'Escape' && popBody) {
                closePopover();
                e.stopImmediatePropagation();
                e.preventDefault();
                return;
            }
            // Space pauses, unless it would type, or press what the keyboard has moved to. A button or
            // switch last used with the pointer lets go instead (or Space would add that body again).
            const t = e.target;
            if ((e.key !== ' ' && e.code !== 'Space') || e.repeat || !t) return;
            const types = (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(t.type)) || t.tagName === 'TEXTAREA' || t.isContentEditable;
            const presses = (t.tagName === 'INPUT' && t.type !== 'range') || ['SELECT', 'BUTTON', 'SUMMARY', 'A', 'LABEL'].includes(t.tagName);
            if (types || (presses && !focusByPointer)) return;
            if (presses) t.blur();
            setPaused(!paused);
            e.preventDefault();
        }, true);
        // (how the focus last moved: within a moment of a press or a click, it was the pointer's doing)
        let pointerAt = -Infinity;
        const pointerUsed = () => { pointerAt = performance.now(); };
        window.addEventListener('pointerdown', pointerUsed, true);
        window.addEventListener('click', (e) => { if (e.detail) pointerUsed(); }, true);
        document.addEventListener('focusin', () => { focusByPointer = performance.now() - pointerAt < 100; });

        // Recolour when the theme changes (palette chips use fixed colours, the canvas redraws itself)
        new MutationObserver(() => render()).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        // A press on the canvas or the palette (getting on with it) ends the scene's tip. Notes run out
        // by themselves.
        window.addEventListener('pointerdown', (e) => {
            lastPointerType = e.pointerType || 'mouse';
            const t = e.target;
            if (t && t.closest && (t === canvas || t.closest('.orb-palette'))) hints.tip = null;
            if (t && t.closest && t.closest('#orbHint button')) hintPressed = true;
            refreshHint();
        }, true);
        // (over with the click, or a moment after a press that became none: the click comes just after the release)
        const hintLetGo = () => { if (hintPressed) { hintPressed = false; refreshHint(); } };
        window.addEventListener('pointerup', () => setTimeout(hintLetGo, 250), true);
        window.addEventListener('pointercancel', hintLetGo, true);
        window.addEventListener('click', () => { hintPressed = false; setTimeout(refreshHint, 0); }, true);
        bindHint();
        bindTurn();
    }

    // ------------------------------------------------------------------
    // Main loop (exactly one). Each frame's time is measured in three parts (physics, drawing and the
    // rest) and smoothed. The physics gets what is left of 80% of the time between frames (as measured,
    // so a 120 Hz screen gets half as much per frame) after the other two, between 3 and PHYSICS_MS ms;
    // if drawing alone takes too long, the trails are drawn more coarsely first
    // (quality below 1), before the simulation itself has to slow down. Where frames have been coming late
    // (see physicsBudget), the painting after the frame's script counts as well. Readouts, primaries in a crowded
    // scene and the graphs are updated about ten times a second rather than every frame.
    // While paused with nothing going on, the picture can't change: frames rest, with one in full four
    // times a second in case something else has changed it. Anything the visitor does (or a call of the
    // public API) wakes them for a second. With the canvas scrolled out of sight, the physics and the
    // readouts carry on but nothing is drawn.
    // ------------------------------------------------------------------
    const REST_EVERY_MS = 250, WAKE_MS = 1000;
    let wakeUntil = 0, restNext = 0, canvasInView = true;
    const wake = () => { wakeUntil = performance.now() + WAKE_MS; };
    function resting(now) {
        if (!paused || now < wakeUntil || now >= restNext) return false;
        if (pred.job || (pred.shown && now - pred.shown.t < PATH_BLEND_MS)) return false;
        return !drags.size && !paletteDrag && !view.anim && view.shift === view.shiftTo && !flashes.length && !well.next && !forcesDirty && !turnEase() && now >= speedFlash && !mission.def;
    }
    function bindRest() {
        for (const t of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup', 'input', 'change', 'click', 'focusin', 'resize']) {
            window.addEventListener(t, wake, { capture: true, passive: true });
        }
        const api = window.orbitsSimulation;
        for (const k of Object.keys(api)) {
            const fn = api[k];
            if (typeof fn === 'function') api[k] = function (...args) { wake(); return fn.apply(this, args); };
        }
        if (typeof IntersectionObserver !== 'undefined') {
            new IntersectionObserver((es) => { canvasInView = es[es.length - 1].isIntersecting; }).observe(canvas);
        }
    }

    let fpsFrames = 0, fpsTime = 0;
    let eccNext = 0, readoutNext = 0, primNext = 0;
    const perf = { physics: 0, render: 0, other: 0, paint: 0, frame: 0, interval: 16.7, steps: 0, ratio: 1, quality: 1, req: 0, got: 0, win: 0 };
    const smooth = (old, v) => old + 0.1 * (v - old);

    // The physics' share of a frame. On a weak device the browser's painting of the canvas after the frame's
    // script can take as long as the script, and then 80% of the time between frames is too much to hand out:
    // frames miss the screen's refresh. So once LATE_SHARE of them are over LATE_MS apart, and for LATE_HOLD_MS
    // after (as this cures them), the paint is timed, by a message posted at the end of the frame, which arrives
    // once that is done, and 95% of the time less the paint is the limit if that is less. Elsewhere nothing is
    // timed, nothing changes, and the physics has all it had.
    const LATE_MS = 25, LATE_SHARE = 0.15, LATE_HOLD_MS = 5000;
    const paintClock = new MessageChannel();
    let lateShare = 0, lateUntil = 0, paintFrom = 0;
    paintClock.port1.onmessage = () => { perf.paint = smooth(perf.paint, performance.now() - paintFrom); };
    function physicsBudget(ts) {
        const t = Math.min(perf.interval, 20);
        const share = ts < lateUntil ? Math.min(0.8 * t, 0.95 * t - perf.paint) : 0.8 * t;
        return clamp(share - perf.render - perf.other, 3, PHYSICS_MS);
    }

    function frame(ts) {
        requestAnimationFrame(frame);
        const dtReal = lastFrameTs ? Math.min(0.1, (ts - lastFrameTs) / 1000) : 0;
        lastFrameTs = ts;
        const t0 = performance.now();
        if (resting(t0)) {
            if (ui.fps) { fpsFrames++; fpsTime += dtReal; }
            return;
        }
        restNext = t0 + REST_EVERY_MS;
        updateScale();
        applyHolds();
        let steps = 0;
        if (!paused && dtReal > 0 && !timeHeld()) {
            const want = dtReal * settings.speed * rate();
            const before = timeDir * simTime + acc;
            steps = advance(want, 0, physicsBudget(ts));
            applyHolds();
            perf.req += want;
            perf.got += timeDir * simTime + acc - before;
        } else {
            slowedDown = false;
            if (forcesDirty) computeForces();
        }
        const t1 = performance.now();
        lag = paused ? 0 : timeDir * clamp(acc, 0, nextDt);   // (drawn a moment back if time runs backwards)
        if (bodies.length <= SWARM_N || ts >= primNext) { computePrimaries(); primNext = ts + 100; }
        stepViewAnimation(dtReal);
        updateScale();
        updateDrawnPositions();
        const t2 = performance.now();
        if (canvasInView) render(); else syncTurnOptions();
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

        if (dtReal > 0) lateShare += 0.02 * ((1000 * dtReal > LATE_MS ? 1 : 0) - lateShare);   // (over about a second: a late frame here and there is nothing)
        if (lateShare > LATE_SHARE) lateUntil = ts + LATE_HOLD_MS;
        if (ts < lateUntil) { paintFrom = performance.now(); paintClock.port2.postMessage(0); }

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
        reset() { loadScene(settings.scene); if (!mission.def) setPaused(false); },
        loadScene(key) { if (ui.scene) ui.scene.value = key; loadScene(key); },
        scenes: () => Object.keys(SCENES),
        getState() {
            const E = systemEnergy();
            return {
                time: simTime, paused, scene: settings.scene, units: scene.units,
                selected: selectedId !== null && bodyById(selectedId) ? bodyById(selectedId).name : null,
                frame: frameId !== null && bodyById(frameId) ? bodyById(frameId).name : 'com',
                popover: popBody ? popBody.name : null,
                view: { zoom: view.zoom, panX: view.panX, panY: view.panY, scale, w: viewW, h: viewH, shift: view.shift, visL, visR },
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
        setEccentricity(e) { if (ui.ecc) ui.ecc.value = String(e); hist.as = 'shape'; applyEccentricity(e); eccDrag = null; },
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
        pairs: () => mainPairs.map((p) => ({ a: p.a.name, b: p.b.name, fast: p.fast, hosted: p.hosted })),
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
            physics: perf.physics, render: perf.render, other: perf.other, paint: perf.paint, frame: perf.frame,
            steps: perf.steps, speedRatio: perf.ratio, quality: perf.quality, bodies: bodies.length, slowedDown
        })
    });

    // Mutual gravity made visible (see that section): who pulls on a body, the overlays, the legend
    (function () {
        const api = window.orbitsSimulation;
        const named = (name) => (name ? bodies.find((q) => q.name === name) : bodyById(selectedId)) || null;
        Object.assign(api, {
            // Every other body's pull on it, strongest first: newtons and share of the net force
            pulls(name) {
                const b = named(name);
                if (!b) return null;
                gatherPulls(b, true);
                const list = [];
                for (const q of bodies) {
                    if (q === b) continue;
                    const m = pairPull(b, q);
                    list.push({ name: q.name, N: forceToNewtons(m), share: pullShare(pp.x, pp.y) });
                }
                return list.sort((p, q) => q.N - p.N);
            },
            setOverlays(o) {
                if (o && o.pulls !== undefined) setPullLines(o.pulls);
                if (o && o.limits !== undefined) setLimits(o.limits);
                return api.overlays();
            },
            // What the overlays and the Gravity tab show now (sizes in km, lengths in CSS px)
            overlays() {
                const b = bodyById(selectedId);
                const out = { pulls: settings.pulls, limits: settings.limits, body: b ? b.name : null };
                if (b && bodies.length > 1) {
                    const P = gatherPulls(b, true);
                    out.net = {
                        N: forceToNewtons(Math.hypot(P.tx, P.ty)), arrowN: forceToNewtons(Math.hypot(b.fx, b.fy)),
                        named: P.who.slice(0, P.k).map((q, i) => ({ name: q.name, N: forceToNewtons(P.f[i]), share: pullShare(P.fx[i], P.fy[i]) })),
                        others: { count: P.rest, N: forceToNewtons(Math.hypot(P.ox, P.oy)), share: pullShare(P.ox, P.oy) }
                    };
                }
                if (b) {
                    lim.bid = null;
                    measureLimits(b);
                    out.hill = { km: lim.hill * AU_KM, shown: settings.limits && lim.hShown, px: lim.hR, text: lim.hillText };
                    out.roche = { km: lim.roche * AU_KM, around: lim.p ? lim.p.name : null, inside: lim.inside, shown: settings.limits && lim.rShown, px: lim.rR, text: lim.rocheText };
                    out.notes = lim.notes.map((n) => n[0]);
                }
                out.chain = Object.assign({}, chainOut);
                out.legend = Object.assign({}, legend);
                const txt = (el) => (el ? el.textContent : null);
                out.panel = {
                    head: txt(ui.popPullHead), net: txt(ui.popPullNet), note: txt(ui.popPullNote),
                    rows: pulls.rows.filter((r) => !r.tr.hidden).map((r) => [r.name.textContent, r.force.textContent, r.share.textContent])
                };
                out.forceTitle = ui.statForce && statBox(ui.statForce) ? statBox(ui.statForce).title : null;
                out.hint = ui.hint ? ui.hint.textContent : null;
                return out;
            }
        });
    })();
    bindGravity();

    // The Solar System scene's start date, star colours and comet tails (for testing; dates as 'YYYY-MM-DD')
    Object.assign(window.orbitsSimulation, {
        // A new start date (1800 to 2050): reloads a scene with one, as the settings' field does
        setStartDate(iso) {
            const jd = parseIsoDate(iso);
            if (!(jd >= JD_MIN && jd <= JD_MAX)) return null;
            setStartDate(jd);
            return window.orbitsSimulation.date();
        },
        // The start date, the date now in the simulation and what the info bar shows (null if the scene has none)
        date() {
            if (!scene.dated) return null;
            const jd = startDate.jd + simTime * DAYS_PER_YEAR;
            return { start: isoDate(startDate.jd), now: isoDate(jd), jd, years: simTime, shown: ui.statTime ? ui.statTime.textContent : null };
        },
        // The colour a main-sequence star of this mass (M_sun) is drawn in, and its temperature (K)
        starColour: (m) => starColour(m),
        starTemperature: (m) => temperatureOf(m),
        // Where JPL's table puts a planet on a date: heliocentric, flat as in the scene (x, y, lon) and in
        // true ecliptic coordinates (lon3, lat3), in AU and degrees
        planetAt(name, iso) {
            const row = PLANET_TABLE.find((r) => KINDS[r[0]].name === name);
            const jd = parseIsoDate(iso);
            if (!row || !(jd > 0)) return null;
            const s = planetState(row, jd), deg = (v) => ((v / TO_RAD) % 360 + 360) % 360;
            return {
                x: s.x, y: s.y, vx: s.vx, vy: s.vy, r: Math.hypot(s.x, s.y), lon: deg(Math.atan2(s.y, s.x)),
                lon3: deg(Math.atan2(s.y3, s.x3)), lat3: Math.atan2(s.z3, Math.hypot(s.x3, s.y3)) / TO_RAD, r3: Math.hypot(s.x3, s.y3, s.z3)
            };
        },
        // The comet tails drawn in the last frame (and the chosen comet's strength, 0 to 1, and the star lighting it)
        tails: () => Object.assign({}, tailInfo)
    });

    // Missions (see "Missions" above): the list, starting one (by id or number), its state, and a burn of
    // the probe's engine, measured from the mission's reference body (kind: prograde, retrograde, outward
    // or inward, or faster, slower, out, in; km/s), charged like any other
    Object.assign(window.orbitsSimulation, {
        missions: () => MISSIONS.map((m) => ({ id: m.id, n: m.n, title: m.title, scene: m.key, par: m.par, budget: m.budget, limit: m.limit, type: m.goal.type, best: bestOf(m.id) })),
        startMission(id) {
            const m = missionById(id) || MISSIONS[(+id || 0) - 1];
            if (!m) return null;
            loadMission(m, false);
            return missionState();
        },
        missionState,
        burn(kind, kms) {
            const b = missionCraft();
            if (!b) return null;
            const k = { prograde: 'faster', retrograde: 'slower', outward: 'out', inward: 'in' }[kind] || kind;
            missionPush(b, k, kms / AUYR_KMS);
            return missionState();
        }
    });

    // Relativity (see "Relativity: orbits that turn, and gravitational waves"). Angles in radians per
    // orbit, rates in arcseconds a century; energies in M_sun AU^2/yr^2 (and J, and M_sun c^2).
    Object.assign(window.orbitsSimulation, {
        // The turning of a body's orbit, measured and as Einstein predicts. Asking starts measuring it
        // (it is measured anyway while it is the chosen body).
        precession(name) {
            const b = bodies.find((q) => q.name === name);
            if (!b) return null;
            apiWatch.add(b.id);
            const p = b.primary;
            const el = p ? elementsOf(b, p) : null;
            const out = {
                body: b.name, primary: p ? p.name : null, orbits: 0,
                predictedNow: el && el.bound ? (6 * Math.PI * G * (b.m + p.m)) / (C2 * el.p) : null
            };
            const r = precessionOf(b);
            if (!r || !r.orbits) return out;
            const AS = (180 / Math.PI) * 3600;
            return Object.assign(out, {
                orbits: r.orbits, measured: r.perOrbit, predicted: r.einstein, others: r.others, round: r.round,
                perCentury: { measured: r.rate * 100 * AS, predicted: r.rateE * 100 * AS },
                last: Object.assign({}, r.last), period: r.T
            });
        },
        radiated() {
            const tr = gw.a ? pairTracker(gw.a, gw.b) : null;
            return {
                energy: gw.radiated, joules: gw.radiated * ENERGY_J, solarMasses: gw.radiated / C2, power: gw.power,
                pair: gw.a ? [gw.a.name, gw.b.name] : null,
                turns: tr ? tr.turns.map((q) => ({ t: q.t, a: q.a, T: q.T })) : [],
                merged: gw.merged ? Object.assign({ name: bodyById(gw.merged.id) ? bodyById(gw.merged.id).name : null }, gw.merged) : null,
                waveSamples: gw.waveN, frozen: gw.frozen, waves: gwOn
            };
        },
        // Turn the radiation reaction off or on (for tests: realistic physics always has it)
        setWaves(v) { gwOn = !!v; forcesDirty = true; }
    });

    // Finding your way (see "Finding your way" above): the list's rows in sight, choosing the next
    // body, zooming to an orbit, and what screen readers are told
    Object.assign(window.orbitsSimulation, {
        // The rows the list shows now (in sight, in order): { name, group, level, around, mass, values, chosen, expanded, label }
        list() {
            navTick();
            const tree = ui.bodiesTree;
            if (!tree || !nav.visible) return [];
            const top = tree.scrollTop, bottom = top + tree.clientHeight;
            return Array.from(tree.querySelectorAll('.orb-bl-row:not([hidden])'))
                .filter((el) => el.navTop + NAV_ROW_H > top && el.navTop < bottom)
                .sort((a, b) => a.navTop - b.navTop)
                .map((el) => ({
                    name: el.navName.textContent, group: el.classList.contains('is-group'), level: +el.getAttribute('aria-level'),
                    around: el.navAround.textContent, mass: el.navMass.textContent, values: el.navVals.textContent,
                    chosen: el.getAttribute('aria-selected') === 'true', expanded: el.getAttribute('aria-expanded'),
                    label: el.getAttribute('aria-label'), active: el.classList.contains('is-active')
                }));
        },
        listInfo: () => ({ rows: nav.rows.length, elements: nav.slots.length + (nav.extra ? 1 : 0), open: nav.visible, cost: nav.cost, sort: nav.sort, find: nav.find }),
        // dir 1: the next body, -1 the one before; returns its name
        chooseNext(dir) { const b = chooseNext(dir === -1 ? -1 : 1); return b ? b.name : null; },
        // Zoom to a body's orbit (it is chosen); returns how, round what, and the view's target
        zoomTo(name) {
            const b = name ? bodies.find((q) => q.name === name) : bodyById(selectedId);
            if (!b) return null;
            selectBody(b.id);
            const z = zoomChosen();
            return {
                how: z.how, around: z.around ? z.around.name : null, viewedFrom: z.from ? z.from.name : null,
                with: z.with.map((q) => q.name), target: view.anim ? Object.assign({}, view.anim) : null
            };
        },
        describe(name) { const b = name ? bodies.find((q) => q.name === name) : bodyById(selectedId); return b ? describeBody(b) : null; },
        a11y: () => ({ canvasLabel: sceneSummary(), announced: nav.announced, helpOpen: !!(ui.keysHelp && ui.keysHelp.open) }),
        help(open) { if (open === false) closeHelp(); else openHelp(); }
    });
    bindNavigation();

    // Save and share (see that section): links, CSV, random systems, the stability timer and autosave
    Object.assign(window.orbitsSimulation, {
        // The link to the setup as it is now (a promise)
        shareLink: () => makeShareLink(),
        // Open a link's setup (a promise of { ok, message })
        loadLink: (url) => openSetup(setupToken(url), false),
        // kind: 'kepler', 'graphs' or 'bodies'; returns the CSV text (no byte-order mark)
        exportCsv: (kind) => csvOf(kind),
        // Load random system number seed (a new random one if left out)
        randomSystem(seed) {
            const s = validSeed(seed) ? seed : newRandomSeed();
            loadRandomSystem(s);
            return { seed: s, scene: settings.scene, bodies: bodies.length, Tref: scene.Tref, tip: scene.tip || '' };
        },
        stability() {
            const e = stab.ended;
            return {
                on: settings.stability, running: stab.running, years: stab.running ? (e ? e.years : simTime - stab.t0) : 0,
                ended: e ? Object.assign({ text: eventText(e, fmtSpan(e.years)) }, e) : null,
                best: Object.assign({}, stab.best), counts: stab.counts, ejectDistance: stab.rEject, goal: STAB_GOAL
            };
        },
        setStability,
        // The checks made four times a second, now
        tick: shareTick,
        saveNow,
        autosave() {
            const sv = share.save;
            return {
                eligible: saveEligible(), saves: sv.count, ok: sv.ok, bytes: sv.bytes, sliceMs: sv.sliceMs, writeMs: sv.writeMs,
                busy: !!sv.job, offer: !!share.offer, stored: (storeGet(SAVE_KEY) || '').length
            };
        }
    });
    bindShare();

    // Running backwards and throwing (see "Running time backwards" and "Throwing a body")
    Object.assign(window.orbitsSimulation, {
        setReverse(on) { setReverse(!!on); return timeDir < 0; },
        // Which way time runs, and what is kept for running back
        reverse: () => ({
            on: timeDir < 0, logged: past.count, events: past.events.map((e) => ({ t: e.t, kind: e.kind, dir: e.dir })),
            trailDir, samples: sampleCount, from: past.from, drift: past.drift, gapPx: past.gap,
            ghosts: bodies.filter((b) => b.ghost).map((b) => b.name)
        }),
        // A throw: body `name` dragged dx, dy px across the screen in the last ms milliseconds and let go
        // (as with "Throw it", whatever the option is set to). Its velocity relative to the view after,
        // and the speed the pointer's gives (AU/yr; km/s).
        flick(name, dx, dy, ms) {
            const b = bodies.find((q) => q.name === name);
            if (!b || b.held) return null;
            const was = settings.placement;
            settings.placement = 'throw';
            updateDrawnPositions();
            const x0 = sx(b.dx), y0 = sy(b.dy), now = performance.now();
            const d = { id: -1, mode: 'move', moved: true, body: b, type: 'mouse', x: x0, y: y0, trace: [] };
            startHold(b, d);
            const n = Math.max(2, Math.ceil(ms / 8));
            for (let i = 0; i <= n; i++) d.trace.push({ t: now - ms + (ms * i) / n, x: x0 + (dx * i) / n, y: y0 + (dy * i) / n });
            b.held.offX += dx / scale;
            b.held.offY -= dy / scale;
            applyHolds();
            endHold(d, true);
            settings.placement = was;
            // (relative to the view where it is, along the screen's directions: see viewVelocity)
            updateDrawnPositions();
            const rel = viewVelocity(b, frameVelocity()), v = Math.hypot(rel.x, rel.y);
            const want = Math.hypot(dx, dy) / (ms / 1000) / (scale * settings.speed * rate());
            return { v, kms: v * AUYR_KMS, expected: want, expectedKms: want * AUYR_KMS, vx: rel.x, vy: rel.y };
        },
        // Run forwards `years`, then back to where it began; how far each body ends from where it was
        // (and its speed from what it was), relative to its distance and speed from the centre of mass.
        // exact false: forget the step log first, so the way back takes steps chosen afresh (and ends with
        // a short step onto the starting time).
        roundTrip(years, exact) {
            setPaused(true);
            const api = window.orbitsSimulation;
            noteRun();
            checkPast();
            const t0 = simTime, c0 = totals(bodies), head0 = past.head;
            const start = new Map(bodies.map((b) => [b.id, { x: b.x - c0.x, y: b.y - c0.y, vx: b.vx - c0.vx, vy: b.vy - c0.vy, name: b.name }]));
            const tw = performance.now();
            api.advance(years);
            const forwardMs = performance.now() - tw, tEnd = simTime, logged = past.head - head0;
            setReverse(true, true);
            if (exact === false) past.head = past.count = 0;
            const tb = performance.now();
            api.advance(Math.max(0, tEnd - t0 - (exact === false ? 0 : 1e-9 * Math.abs(tEnd))));
            // the last step or two onto the starting time
            for (let i = 0; i < 1000 && past.count > 0 && past.head > head0; i++) {
                const dt = stepSize();
                if (!past.replay) break;
                step(-dt); simTime -= dt; afterStep(dt);
            }
            // (without the log, or past its oldest step: steps chosen afresh, the last one short)
            for (let i = 0; i < 1e6 && simTime > t0; i++) { refreshPairs(); const dt = Math.min(nextDt, simTime - t0); step(-dt); simTime -= dt; }
            const backMs = performance.now() - tb;
            computeForces(); computePrimaries();
            setReverse(false, true);
            const c1 = totals(bodies);
            let pos = 0, vel = 0, posAU = 0;
            for (const b of bodies) {
                const s = start.get(b.id);
                if (!s) continue;
                const r = Math.hypot(s.x, s.y) || 1, v = Math.hypot(s.vx, s.vy) || 1;
                const dp = Math.hypot(b.x - c1.x - s.x, b.y - c1.y - s.y), dv = Math.hypot(b.vx - c1.vx - s.vx, b.vy - c1.vy - s.vy);
                posAU = Math.max(posAU, dp); pos = Math.max(pos, dp / r); vel = Math.max(vel, dv / v);
            }
            return { years: tEnd - t0, timeLeft: simTime - t0, logged, pos, vel, posAU, bodies: bodies.length, lost: start.size - bodies.filter((b) => start.has(b.id)).length, forwardMs, backMs };
        }
    });
    bindPlayControls();

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
    bindRest();
    requestAnimationFrame(frame);
})();
