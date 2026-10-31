/*
 * Special Relativity simulation: time dilation, length contraction and the relativity of simultaneity.
 *
 * Everything on the canvas is what is *measured* in one inertial frame, picked with "Measured from":
 * where things are at one moment of that frame's time, and what their clocks read at that moment
 * (Lorentz transformations). It is not what a camera would photograph: the time light takes to reach
 * an eye, and the distortions that causes, are left out.
 *
 * Units: c = 1 (light-seconds and seconds; light-years and years in the twin paradox); kilometres and
 * microseconds for the muons. Within a scenario both frames use the same screen scale and playback rate
 * (except the muons, below), so light moves at the same speed on screen in both, and the moving object at
 * v in the same units.
 *
 * Scenarios, in teaching order
 * - Light speed: a ship passes a station and, as the ship's nose passes the station's front end, each fires a
 *   flash of light and a probe straight ahead. Both flashes move at c in either frame, so they stay level;
 *   the probes leave their craft at the same speed u, and the moving craft's probe is measured at
 *   (u + v)/(1 + uv/c²), never more than c. Strobe marks every 0.25 s show the speeds; "Newton's
 *   prediction" adds ghosts where the moving craft's flash and probe would be if speeds simply added.
 * - Lightning (Einstein's train): lightning strikes both ends of the ship just as its middle passes the
 *   station's middle, at the same moment measured from the station. Each flash runs along the track at c,
 *   both ways from where its strike happened (measured in the shown frame), to a detector in the middle of
 *   each craft, whose two lamps light as the flashes from behind and ahead arrive. The station's detector
 *   gets both at once and the ship's gets the front flash first, in both frames. Measured from the ship the
 *   front strike happened γvΔx/c² = vL0/c² earlier (Δx = L0/γ, their separation measured from the station),
 *   so its detector, half way between the strikes, sees them in the order they happened.
 * - Light clocks: a ship and a station with the same rest length, each carrying a light clock (a pulse of
 *   light bouncing between two mirrors 0.5 light-seconds apart, so it ticks once a second). The craft at
 *   rest stays in the middle; the moving one wraps round the edges (as if the track were lined with
 *   identical, synchronised copies of the craft at rest, one per screen width). Both clocks read zero as
 *   the two craft pass each other.
 * - Muons: a batch of muons made 15 km up falls to the ground. Each decays when its own clock reaches a
 *   random lifetime (mean 2.2 µs), so the same muons survive whichever frame the fall is measured from.
 *   Measured from the muons the atmosphere is only 15/γ km thick, so that view is zoomed in γ times (after a
 *   moment at Earth's scale) and played γ times slower: the fall takes as long on screen in both frames, the
 *   muons decay at the same moments, and anything moving at a given speed crosses the screen equally fast.
 * - Ship in a hangar (the pole-and-barn paradox): at rest the ship is longer than the hangar. Measured from
 *   the hangar both doors shut at the same moment, for a short while, with the contracted ship inside.
 *   Measured from the ship the hangar is even shorter, but each door shuts when the hangar's own clock beside
 *   it reads zero, and those clocks are not synchronised measured from the ship: the exit door shuts and
 *   reopens ahead of the nose, then the entrance shuts and reopens behind the tail. The run pauses at each
 *   door's shut moment.
 * - Twin paradox: a return trip to Proxima Centauri (4.24 ly). Measured from the ship (its outbound frame,
 *   then its inbound frame), Earth's clock jumps ahead at the turnaround.
 */
(function () {
    'use strict';

    const canvas = document.getElementById('simulationCanvas');
    if (!canvas || !canvas.getContext) {
        console.error('Relativity simulation: canvas #simulationCanvas not found.');
        return;
    }
    const ctx = canvas.getContext('2d');

    const byId = (id) => document.getElementById(id);
    const ui = {
        speed: byId('speedSlider'), speedVal: byId('speedVal'),
        scenario: byId('scenarioSelect'), scenarioHint: byId('scenarioHint'),
        showGroup: byId('showGroup'), probeGroup: byId('probeGroup'),
        probe: byId('probeSlider'), probeVal: byId('probeVal'),
        toggles: ['paths', 'newton', 'lengths', 'sync'].map((key) => ({ key, input: byId(`${key}Toggle`), label: byId(`${key}Label`) })),
        velocity: byId('velocitySlider'), velocityVal: byId('velocityVal'),
        frameBtns: Array.from(document.querySelectorAll('.rel-frame-btn')),
        reset: byId('resetSimulationBtn'), fps: byId('fpsDisplay'),
        showCharts: byId('showCharts'), chartsContainer: byId('charts-container'),
        statGamma: byId('statGamma'),
        stats: ['A', 'B', 'C'].map((k) => ({
            label: byId(`stat${k}Label`), value: byId(`stat${k}`), unit: byId(`stat${k}Unit`), dot: byId(`stat${k}Dot`)
        }))
    };

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------
    const TAU = Math.PI * 2;
    const FONT = '"Source Sans Pro", Helvetica, Arial, sans-serif';
    const C_KM_US = 0.299792458;     // speed of light in km per microsecond

    // Light speed (light-seconds and seconds): the ship and the station drawn at 3/4 of their light-clock size
    const LT = {
        SIZE: 0.75,       // drawing scale (the light-clock craft are 1.6 ls long)
        L0: 1.2,          // rest length of each craft (ls); each fires from its front end, L0/2 ahead of its middle
        HEIGHT: 0.72,     // craft height (ls)
        DOT: 0.25,        // s between strobe marks
        PROBE_Y: 0.09,    // the probes fly this far under the flashes (ls), so their marks stay apart
        LEAD: 1.2,        // s of the shown frame before the flashes, while the moving craft comes up
        HOLD: 1.6,        // s (real) holding the last picture before starting again
        MIN_SPAN: 5.5     // narrowest scene (ls)
    };

    // Half the height of the ship and of the station, fins and solar panels included (ls, at full size)
    const LT_HALF = 0.47;

    // Lightning (light-seconds and seconds): the light-clock ship and station, without their clocks
    const LN = {
        SIZE: 0.75,       // drawing scale (the light-clock craft are 1.6 ls long)
        L0: 1.2,          // rest length of each craft (ls); the strikes hit the ship's nose and tail
        GAP: 0.3,         // space between the ship's lane and the station's (ls)
        LEAD: 1.0,        // s before the first strike
        AFTER: 0.9,       // s after the last flash reaches a detector
        HOLD: 1.8,        // s (real) holding the last picture before starting again
        RATE: 0.5,        // s of the shown frame per second at 1x
        MIN_SPAN: 4.2     // narrowest scene (ls)
    };

    // Light clocks (light-seconds and seconds)
    const LC = {
        L0: 1.6,          // rest length of the ship and of the station (ls)
        MIRROR: 0.5,      // mirror separation (ls): half a second up, half a second down
        TICK: 1,          // s per tick
        TRAIL: 2,         // seconds of light path left behind each pulse
        DOT: 0.1,         // seconds between the marks along a light path
        END: 0.62,        // end clocks' distance from the middle, in the craft's own frame (ls)
        HEIGHT: 0.94,     // craft height including fins and solar panels (ls)
        MIN_SPAN: 3.5     // narrowest scene (ls), so a craft at rest never fills more than ~45 % of the width
    };

    // Ship in a hangar (light-seconds and seconds): the light-clock ship, without its clock
    const HG = {
        SHIP: 1.6,        // the ship's rest length (ls)
        L0: 1.2,          // the hangar's rest length, door to door (ls)
        IN: 0.52,         // half the hangar's inner height (ls): room for the ship's fins
        WALL: 0.07,       // roof and floor thickness (ls)
        SHUT: 0.55,       // the doors are shut for this fraction of the time the contracted ship spends wholly inside
        HOLD: 1.3,        // s (real) paused at each door's shut moment
        END_HOLD: 0.8,    // s (real) before starting again
        MIN_SPAN: 4.6     // narrowest scene (ls)
    };

    // Twin paradox (light-years and years)
    const TW = {
        D: 4.24,          // Earth to Proxima Centauri (ly)
        RATE: 1.5,        // years of the shown frame per second at 1x
        TURN_PAUSE: 3.2,  // s (real) spent showing Earth's clock jump at the turnaround
        END_PAUSE: 5.5    // s (real) showing the result before the trip starts again
    };

    // Muons (kilometres and microseconds)
    const MU = {
        H: 15,            // height where cosmic rays make the muons (km)
        LIFE: 2.197,      // mean lifetime at rest (µs)
        N: 40,            // muons per batch
        RATE: 6,          // µs of Earth's time per second at 1x (and µs of the muons' time / γ, see rate())
        INTRO: 1.8,       // s (real) before the fall, measured from the muons: the squashed atmosphere, then a zoom
        INTRO_EARTH: 0.6, // s (real) before the fall, measured from Earth
        EMPTY_FAST: 8,    // the rest of the fall plays this much faster once every muon has decayed...
        EMPTY_MAX: 4,     // ...unless that would still take longer than this (s, real): then the run ends there
        END_PAUSE: 5.5    // s (real)
    };

    // Each scenario's two frames, starting speed, which "Show" toggles apply and the hint in the settings panel.
    const SCENARIOS = {
        light: {
            home: { name: 'Station', the: 'the station', icon: 'fa-satellite' },
            away: { name: 'Ship', the: 'the ship', icon: 'fa-rocket' },
            v: 0.5,
            show: ['paths', 'newton'], probe: true,
            hint: 'As the ship passes the station, each fires a flash of light and a probe straight ahead. The probes leave at the speed set here.',
            aria: 'A spaceship passes a space station; each fires a flash of light and a probe forward, and the two flashes stay level'
        },
        lightning: {
            home: { name: 'Station', the: 'the station', icon: 'fa-satellite' },
            away: { name: 'Ship', the: 'the ship', icon: 'fa-rocket' },
            v: 0.6,
            show: [],
            hint: 'Lightning strikes both ends of the ship as its middle passes the station\u2019s middle. Lamps in the middle of each craft light as the flashes arrive.',
            aria: 'Lightning strikes both ends of a spaceship as it passes a space station; light spreads out from each strike to a detector in the middle of each craft'
        },
        clocks: {
            home: { name: 'Station', the: 'the station', icon: 'fa-satellite' },
            away: { name: 'Ship', the: 'the ship', icon: 'fa-rocket' },
            v: 0.8,
            show: ['paths', 'lengths', 'sync'],
            hint: 'A ship and a station of the same length each carry a light clock that ticks once a second.',
            aria: 'A spaceship carrying a light clock flies past a space station that carries an identical light clock'
        },
        hangar: {
            home: { name: 'Hangar', the: 'the hangar', icon: 'fa-warehouse' },
            away: { name: 'Ship', the: 'the ship', icon: 'fa-rocket' },
            v: 0.8,
            show: ['sync'],
            hint: 'At rest the ship is 1.6 ls long and the hangar 1.2 ls. The hangar\u2019s doors both shut for a moment as the ship flies through.',
            aria: 'A spaceship longer than a hangar flies through it while the hangar doors shut for a moment'
        },
        twins: {
            home: { name: 'Earth', the: 'Earth', icon: 'fa-globe-europe' },
            away: { name: 'Ship', the: 'the ship', icon: 'fa-rocket' },
            v: 0.8,
            show: [],
            hint: 'One twin flies to Proxima Centauri, 4.24 light-years away, and straight back. Who is older when they meet again?',
            aria: 'A spaceship flies from Earth to the star Proxima Centauri and back, with the ages of the twin at home and the travelling twin'
        },
        muons: {
            home: { name: 'Earth', the: 'Earth', icon: 'fa-globe-europe' },
            away: { name: 'Muons', the: 'the muons', icon: 'fa-atom' },
            v: 0.995,
            show: [],
            hint: 'Cosmic rays make muons 15 km up. They live about 2.2 µs, too short to cross 15 km even at light speed. Yet many reach the ground.',
            aria: 'A row of muons made high in the atmosphere falls towards the ground, decaying one by one'
        }
    };

    // Speed slider: steps 0-90 are 0.00c-0.90c in 0.01c steps; above that (1 - v) shrinks tenfold every
    // 20 steps up to 0.999c, so the interesting range from 0.9c to 0.999c gets almost a third of the track.
    function speedFromStep(i) {
        if (i <= 90) return i / 100;
        return Math.round((1 - 0.1 * Math.pow(10, -(i - 90) / 20)) * 1000) / 1000;
    }
    function stepFromSpeed(v) {
        if (v <= 0.9) return Math.round(v * 100);
        return Math.min(130, Math.round(90 + 20 * Math.log10(0.1 / Math.max(1e-6, 1 - v))));
    }

    const gammaOf = (v) => 1 / Math.sqrt(1 - v * v);
    const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
    const mod = (a, n) => ((a % n) + n) % n;
    const fmtV = (v) => (v <= 0.9 ? v.toFixed(2) : v.toFixed(3));
    const fmtGamma = (g) => (g < 9.9995 ? g.toFixed(3) : g.toFixed(2));
    const fmtNum = (x) => (Math.abs(x) < 999.95 ? x.toFixed(1) : x.toFixed(0));
    const fmtTimes = (g) => (g < 9.995 ? g.toFixed(2) : g.toFixed(1));
    // A time that can be before zero, to two decimals, with a proper minus sign.
    const fmtSigned = (x) => (x < -0.005 ? '\u2212' : '') + Math.abs(x).toFixed(2);
    // A velocity in units of c, with a minus sign when it points backwards.
    // Above 0.9 it is cut (not rounded) to three decimals, so anything slower than light never shows as 1.000.
    const fmtU = (u) => {
        const a = Math.abs(u);
        const text = a > 0.9 && a < 1 ? (Math.floor(a * 1000 + 1e-9) / 1000).toFixed(3) : fmtV(a);
        return (u < -0.0005 ? '\u2212' : '') + text;
    };

    // ------------------------------------------------------------------
    // Settings and state
    // ------------------------------------------------------------------
    const S = {
        scenario: 'light',
        frame: 'home',        // 'home': the station / Earth is at rest; 'away': the ship / muons are at rest
        v: 0.5,               // speed of the ship (or muons) relative to home, as a fraction of c
        speed: 1,             // playback speed
        probeU: 0.5,          // light speed: each probe's speed relative to the craft that fires it
        showPaths: true,
        showNewton: false,
        showLengths: false,
        showSync: false
    };

    let viewW = 0, viewH = 0, dpr = 1;
    let fontPx = 13;
    let realNow = 0;          // seconds, for flashes and pauses
    const hitRects = [];      // craft that can be tapped to ride along: { x0, y0, x1, y1, frame }
    let hoverFrame = null;
    let testPaused = false;   // set by the test API: the loop draws but doesn't advance

    // Light speed
    const lt = {
        t: -LT.LEAD,          // time measured in the shown frame (s); the flashes are fired at t = 0
        hold: 0,              // s (real) left holding the last picture
        flashAt: -9           // real time the flashes were fired (for the burst at the muzzles)
    };

    // Lightning
    const ln = { t: 0, hold: 0, struck: [-9, -9] };   // frame time (s); real time of each strike (rear, front)

    // Light clocks
    const lc = {
        T: 0,                 // time measured in the shown frame (s)
        tauMove: 0,           // reading of the moving craft's clock: its own (proper) time
        xMove: 0,             // centre of the moving craft (ls; the craft at rest is at 0), wrapped round
        xTravel: 0,           // distance it has moved, not wrapped (moves the background stars)
        trailHome: [], trailAway: [],
        tickHome: 0, tickAway: 0,
        flashHome: -9, flashAway: -9
    };

    // Ship in a hangar
    const hg = { t: 0, hold: 0, done: false, slam: [-9, -9] };   // frame time (s); real time each door last moved

    // Twin paradox
    const tw = { t: 0, stage: 'out', pause: 0, pauseLen: 1 };

    // Muons
    const mu = {
        t: 0,                                   // time measured in the shown frame (µs)
        life: new Float64Array(MU.N),           // each muon's lifetime on its own clock (µs)
        x: new Float64Array(MU.N),              // across the sky (0-1)
        decayedAt: new Float64Array(MU.N),      // real time of the decay flash, or -1
        stage: 'intro', pause: 0                // 'intro' (before the fall), 'fall' or 'done'
    };

    // Background stars (fixed to the home frame), as fractions of the canvas
    const STAR_N = 110;
    const stars = [];
    (function makeStars() {
        let seed = 7;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (let i = 0; i < STAR_N; i++) {
            stars.push({ fx: rnd(), fy: rnd(), r: 0.5 + rnd() * 0.9, a: 0.25 + rnd() * 0.45 });
        }
    })();

    // ------------------------------------------------------------------
    // Palette (refreshed when the light/dark theme changes)
    // ------------------------------------------------------------------
    let dark = true;
    let pal = {};
    function refreshPalette() {
        dark = document.documentElement.classList.contains('dark-mode');
        const common = {
            pink: '#f2849e', blue: '#7ecaf6', teal: '#7bd0c1', magenta: '#c75b9b', purple: '#ae85ca', peri: '#8499e7',
            star: '#ffd36b'
        };
        pal = Object.assign(common, dark ? {
            bg: '#16181c', text: '#e8e8e8', muted: 'rgba(232,232,232,0.62)', faint: 'rgba(232,232,232,0.22)',
            starRGB: '255,255,255', pillBg: 'rgba(22,24,28,0.86)', pillEdge: 'rgba(255,255,255,0.18)',
            shipShade: '#c75b9b', stationShade: '#4f95c4', panel: '#8499e7', panelGrid: 'rgba(16,20,36,0.55)',
            truss: '#8d96a1', edge: 'rgba(0,0,0,0.35)',
            chamber: '#0a0c10', chamberEdge: 'rgba(255,255,255,0.2)', mirror: '#e9eef4',
            photon: '#fff4c4', lightRGB: '255,214,92',
            earthOcean: '#3d86c6', ground: '#22332f', groundLine: '#7bd0c1', skyRGB: '126,202,246',
            muon: '#c9a5e3',
            pinkText: '#f2849e', blueText: '#7ecaf6', purpleText: '#c9a5e3'
        } : {
            bg: '#f4f6f8', text: '#2b2b2b', muted: 'rgba(43,43,43,0.62)', faint: 'rgba(43,43,43,0.2)',
            starRGB: '40,50,70', pillBg: 'rgba(255,255,255,0.9)', pillEdge: 'rgba(0,0,0,0.16)',
            shipShade: '#c75b9b', stationShade: '#4f95c4', panel: '#8499e7', panelGrid: 'rgba(16,20,36,0.45)',
            truss: '#7c8590', edge: 'rgba(0,0,0,0.3)',
            chamber: '#1a1f27', chamberEdge: 'rgba(0,0,0,0.25)', mirror: '#e9eef4',
            photon: '#fff4c4', lightRGB: '214,140,0',
            earthOcean: '#3d86c6', ground: '#cfe3d8', groundLine: '#3f9e8f', skyRGB: '90,160,215',
            muon: '#8a5cb0',
            pinkText: '#d4587a', blueText: '#2f84bb', purpleText: '#8a5cb0'
        });
        // The light inside the dark chambers is always the bright yellow; detector panels are the windows' colour.
        pal.chamberLightRGB = '255,214,92';
        pal.glass = '#2a3140';
        if (charts) recolorCharts();
    }

    // ------------------------------------------------------------------
    // Light speed: physics
    // ------------------------------------------------------------------
    // Relativistic velocity addition: something moving at u relative to a craft that moves at V is measured at w.
    const addVelocities = (u, V) => (u + V) / (1 + u * V);

    // The two craft, the flashes and the probes, measured in the shown frame. The craft at rest has its front end
    // at x = 0, and the moving craft's front passes it at t = 0, when both fire. Positions are of each craft's
    // middle (ls); u is a velocity (c).
    function lightState() {
        const g = gammaOf(S.v);
        const hm = homeMoves();
        const V = hm ? -S.v : S.v;                  // velocity of the moving craft
        const t = lt.t;
        const rest = { x: -LT.L0 / 2, u: 0, length: LT.L0, moving: false };
        const move = { x: V * t - LT.L0 / (2 * g), u: V, length: LT.L0 / g, moving: true };
        const probeRest = S.probeU, probeMove = addVelocities(S.probeU, V);
        return {
            t, V, g,
            home: hm ? move : rest, away: hm ? rest : move,
            probe: { home: hm ? probeMove : probeRest, away: hm ? probeRest : probeMove },
            // Where the moving craft's flash and probe would be if speeds simply added (Newton)
            newton: { light: 1 + V, probe: S.probeU + V },
            moving: hm ? 'home' : 'away'
        };
    }

    // Frame time at which the flashes are about to leave the canvas: the picture is held there, still showing them.
    function lightEnd() {
        if (viewW === 0) return 4;
        const lay = lightLayout();
        return (viewW - lay.x0 - Math.max(18, lay.f * 1.6)) / lay.k;
    }

    function resetLight() {
        lt.t = -LT.LEAD;
        lt.hold = 0;
    }

    function stepLight(dt, dtReal) {
        if (lt.hold > 0) {
            lt.hold -= dtReal;
            if (lt.hold <= 0) {
                resetLight();
                resetChartData();
            }
            return;
        }
        const before = lt.t;
        lt.t += dt;
        if (before < 0 && lt.t >= 0) lt.flashAt = realNow;
        const end = lightEnd();
        if (lt.t >= end) {
            lt.t = end;
            lt.hold = LT.HOLD;
        }
    }

    // ------------------------------------------------------------------
    // Lightning: physics
    // ------------------------------------------------------------------
    // The two strikes (rear, front) and the craft, measured in the shown frame. Both middles are at x = 0 at
    // t = 0, when (measured from the station) lightning hits both ends of the ship. Each strike leaves a mark on
    // the ship's end and on the station beside it; `own` is where each mark is along its craft, in the craft's own
    // frame. Each detector (in a craft's middle) gets each flash when the spreading light reaches it.
    function lightningState() {
        const v = S.v, g = gammaOf(v);
        const hm = homeMoves();
        const L = LN.L0;
        // Strikes: measured from the station at x = ∓L/(2γ), t = 0; from the ship at x = ∓L/2, t = ±vL/2.
        const strikes = hm ? [{ x: -L / 2, t: v * L / 2 }, { x: L / 2, t: -v * L / 2 }]
            : [{ x: -L / (2 * g), t: 0 }, { x: L / (2 * g), t: 0 }];
        const craft = (u) => ({ u, moving: u !== 0, x0: 0 });
        const home = craft(hm ? -v : 0), away = craft(hm ? 0 : v);
        const own = { home: [-L / (2 * g), L / (2 * g)], away: [-L / 2, L / 2] };
        // When the light from strike s reaches the middle of a craft moving at u (from x = 0 at t = 0)
        const arrival = (s, u) => {
            const side = Math.sign(u * s.t - s.x) || 1;     // where the detector is, relative to the strike
            return side > 0 ? (-s.x + s.t) / (1 - u) : (s.x + s.t) / (1 + u);
        };
        const det = {
            home: strikes.map((s) => arrival(s, home.u)),
            away: strikes.map((s) => arrival(s, away.u))
        };
        const first = Math.min(strikes[0].t, strikes[1].t);
        const last = Math.max(...det.home, ...det.away);
        return { v, g, t: ln.t, strikes, home, away, own, det, start: first - LN.LEAD, end: last + LN.AFTER };
    }

    function resetLightning() {
        ln.t = lightningState().start;
        ln.hold = 0;
        ln.struck = [-9, -9];
    }

    function stepLightning(dt, dtReal) {
        if (ln.hold > 0) {
            ln.hold -= dtReal;
            if (ln.hold <= 0) {
                resetLightning();
                resetChartData();
            }
            return;
        }
        const st = lightningState();
        const before = ln.t;
        ln.t = Math.min(st.end, ln.t + dt);
        st.strikes.forEach((s, i) => {
            if (before < s.t && ln.t >= s.t) ln.struck[i] = realNow;
        });
        if (ln.t >= st.end) ln.hold = LN.HOLD;
    }

    // ------------------------------------------------------------------
    // Light clocks: physics
    // ------------------------------------------------------------------
    // Height of a clock's light pulse above its lower mirror (0-1), from the clock's reading: it leaves the
    // lower mirror at every whole tick and reaches the upper one half a tick later.
    function lightHeight(clock) {
        const f = clock / LC.TICK - Math.floor(clock / LC.TICK);
        return 1 - Math.abs(1 - 2 * f);
    }

    function homeMoves() {
        return S.frame === 'away';
    }

    // Each craft's clock reading (at its middle), position and velocity, measured in the shown frame.
    function clockState() {
        const hm = homeMoves();
        return {
            home: { clock: hm ? lc.tauMove : lc.T, x: hm ? lc.xMove : 0, u: hm ? -S.v : 0, moving: hm },
            away: { clock: hm ? lc.T : lc.tauMove, x: hm ? 0 : lc.xMove, u: hm ? 0 : S.v, moving: !hm }
        };
    }

    function resetClocks() {
        lc.T = 0;
        lc.tauMove = 0;
        lc.xMove = 0;
        lc.xTravel = 0;
        lc.trailHome.length = 0;
        lc.trailAway.length = 0;
        lc.tickHome = 0;
        lc.tickAway = 0;
    }

    // Period (ls) after which the moving craft comes round again: the screen width plus just enough room for
    // the craft's back (and labels) to leave one side before its front (and velocity arrow) appears at the other.
    function wrapPeriod(lay) {
        const half = (LC.L0 / 2) * lay.k / gammaOf(S.v);
        const label = craftLabelWidth(lay.f, 'Station', 's') / 2;
        const sync = S.showSync ? label + 10 + pillWidth(lay.f, 's', '00.0', true) : 0;
        const back = Math.max(half, label, sync);
        const front = Math.max(half + clamp(0.3 * lay.k, 26, 64) + 12, label, sync);
        return lay.P + (back + front + 8) / lay.k;
    }

    // Add the path of a light pulse from clock reading ca to cb (frame times Ta to Tb, craft centre xa to xb)
    // to its trail, with a point at every mirror bounce so the zig-zag keeps its sharp corners.
    function extendTrail(trail, xa, xb, ca, cb, Ta, Tb) {
        if (trail.length === 0) trail.push({ x: xa, h: lightHeight(ca), t: Ta });
        const half = LC.TICK / 2;
        if (cb > ca) {
            for (let m = Math.floor(ca / half) + 1; m * half <= cb; m++) {
                const f = (m * half - ca) / (cb - ca);
                trail.push({ x: xa + f * (xb - xa), h: m % 2 === 0 ? 0 : 1, t: Ta + f * (Tb - Ta) });
            }
        }
        trail.push({ x: xb, h: lightHeight(cb), t: Tb });
        while (trail.length > 2 && trail[1].t < Tb - LC.TRAIL) trail.shift();
    }

    function stepClocks(dt) {
        const g = gammaOf(S.v);
        const hm = homeMoves();
        const u = hm ? -S.v : S.v;
        const T0 = lc.T, tau0 = lc.tauMove, x0 = lc.xMove;
        lc.T += dt;
        lc.tauMove += dt / g;     // the moving clock ticks slower: dτ = dt / γ
        lc.xMove += u * dt;
        lc.xTravel += u * dt;
        const restTrail = hm ? lc.trailAway : lc.trailHome;
        const moveTrail = hm ? lc.trailHome : lc.trailAway;
        extendTrail(restTrail, 0, 0, T0, lc.T, T0, lc.T);
        extendTrail(moveTrail, x0, lc.xMove, tau0, lc.tauMove, T0, lc.T);
        // Round again: the craft (with its light path) jumps back one period.
        if (viewW > 0) {
            const per = wrapPeriod(clocksLayout());
            const jump = lc.xMove > per / 2 ? -per : lc.xMove < -per / 2 ? per : 0;
            if (jump) {
                lc.xMove += jump;
                for (const p of moveTrail) p.x += jump;
            }
        }

        const st = clockState();
        const th = Math.floor(st.home.clock / LC.TICK + 1e-9);
        const ta = Math.floor(st.away.clock / LC.TICK + 1e-9);
        if (th > lc.tickHome) lc.flashHome = realNow;
        if (ta > lc.tickAway) lc.flashAway = realNow;
        lc.tickHome = th;
        lc.tickAway = ta;
    }

    // ------------------------------------------------------------------
    // Ship in a hangar: physics
    // ------------------------------------------------------------------
    // The hangar is centred on x = 0 and the ship's middle passes its middle at t = 0. Each door (own position
    // ∓L0/2 along the hangar) is shut while the hangar's clock beside it reads between -d and +d; those clocks
    // are synchronised in the hangar's frame, so measured from the hangar both doors shut at once. d is a fraction
    // of the time the contracted ship spends wholly inside; if it doesn't fit, the doors stay open.
    function hangarState() {
        const v = Math.max(S.v, 1e-6), g = gammaOf(S.v);
        const hm = homeMoves();
        const room = (HG.L0 - HG.SHIP / g) / (2 * v);      // hangar time the ship is wholly inside, either side of 0
        const d = room > 0 ? HG.SHUT * room : 0;
        const t = hg.t;
        const hangar = { x: hm ? -v * t : 0, u: hm ? -v : 0, length: HG.L0 / (hm ? g : 1), clock: hm ? t / g : t };
        const ship = { x: hm ? 0 : v * t, u: hm ? 0 : v, length: HG.SHIP / (hm ? 1 : g) };
        // Each door's clock now, and whether it is shut ([entrance, exit])
        const doors = [-1, 1].map((side) => {
            const own = side * HG.L0 / 2;
            const clock = hangar.clock - hangar.u * own;
            return { own, clock, x: hangar.x + own * (hm ? 1 / g : 1), shut: d > 0 && Math.abs(clock) < d };
        });
        // Frame times at which each door is in the middle of its shut spell (the clock beside it reads zero)
        const pauses = d > 0 ? (hm ? [-g * v * HG.L0 / 2, g * v * HG.L0 / 2] : [0]) : [];
        // From the ship's nose at the left edge (or the hangar coming in from the right) until it has gone
        const half = (viewW > 0 ? hangarLayout().P : 5) / 2;
        const reach = half + (hm ? hangar.length : ship.length) / 2 + 0.1;
        return { v, g, t, d, hangar, ship, doors, pauses, both: doors[0].shut && doors[1].shut,
            shutFor: hm || d === 0 ? 0 : 2 * d, start: -reach / v, end: reach / v };
    }

    // Below 0.01c the ship would take far too long to arrive: it is shown at rest across the hangar instead
    // (too long to fit), until the speed goes up.
    function resetHangar() {
        hg.t = S.v < 0.01 ? 0 : hangarState().start;
        hg.hold = 0;
        hg.done = false;
    }

    function stepHangar(dt, dtReal) {
        if (S.v < 0.01) return;
        if (hg.hold > 0) {
            hg.hold -= dtReal;
            if (hg.hold <= 0 && hg.done) {
                resetHangar();
                resetChartData();
            }
            return;
        }
        const st = hangarState();
        const before = hg.t;
        hg.t = Math.min(st.end, hg.t + dt);
        // Pause at each door's shut moment
        for (const tp of st.pauses) {
            if (before < tp && hg.t >= tp) {
                hg.t = tp;
                hg.hold = HG.HOLD;
                break;
            }
        }
        const after = hangarState();
        after.doors.forEach((door, i) => {
            if (door.shut !== st.doors[i].shut) hg.slam[i] = realNow;
        });
        if (hg.t >= st.end) {
            hg.done = true;
            hg.hold = HG.END_HOLD;
        }
    }

    // ------------------------------------------------------------------
    // Twin paradox: physics (everything follows from the time measured in the shown frame)
    // ------------------------------------------------------------------
    function twinTimes() {
        const v = Math.max(S.v, 1e-6);
        const g = gammaOf(S.v);
        const t1 = TW.D / v;            // Earth time to reach the star
        return { g, v, t1, t2: 2 * t1, tau1: t1 / g };
    }

    // Positions (ly) and ages (yr) measured in the shown frame. Measured from Earth: Earth at 0, the star at D.
    // Measured from the ship: the ship at 0, in its outbound frame and then its inbound frame.
    function twinState() {
        const { g, v, t1, t2, tau1 } = twinTimes();
        const t = tw.t;
        if (!homeMoves()) {
            const out = t < t1;
            return {
                earthX: 0, starX: TW.D, shipX: out ? v * t : TW.D - v * (t - t1), earthAge: t, shipAge: t / g,
                shipU: out ? v : -v, homeU: 0, facing: out ? 1 : -1, dist: TW.D, g
            };
        }
        const s = { shipX: 0, shipAge: t, shipU: 0, dist: TW.D / g, g };
        if (tw.stage === 'out') {
            return Object.assign(s, { earthX: -v * t, starX: TW.D / g - v * t, earthAge: t / g, homeU: -v, facing: 1 });
        }
        if (tw.stage === 'turn') {
            // Stopped at the star while the ship swaps its outbound frame for its inbound one: in the new frame
            // "now" on Earth is much later, so Earth's clock jumps ahead (animated over the pause).
            const p = clamp(1 - tw.pause / tw.pauseLen, 0, 1);
            const e = p < 0.25 ? 0 : p > 0.7 ? 1 : (1 - Math.cos(Math.PI * (p - 0.25) / 0.45)) / 2;
            const before = tau1 / g, after = t2 - tau1 / g;
            return Object.assign(s, { earthX: -TW.D / g, starX: 0, earthAge: before + e * (after - before), homeU: 0, facing: p < 0.5 ? 1 : -1 });
        }
        const sb = t - tau1;
        return Object.assign(s, { earthX: -TW.D / g + v * sb, starX: v * sb, earthAge: t2 - tau1 / g + sb / g, homeU: v, facing: -1 });
    }

    function resetTwins() {
        tw.t = 0;
        tw.stage = 'out';
        tw.pause = 0;
    }

    function stepTwins(dt, dtReal) {
        if (tw.pause > 0) {
            tw.pause -= dtReal;
            if (tw.pause <= 0) {
                if (tw.stage === 'turn') {
                    tw.stage = 'back';
                } else if (tw.stage === 'done') {
                    resetTwins();
                    resetChartData();
                }
            }
            return;
        }
        if (S.v < 0.01 || tw.stage === 'done') return;
        const { t1, t2, tau1 } = twinTimes();
        const ship = homeMoves();
        const mid = ship ? tau1 : t1;
        const end = ship ? 2 * tau1 : t2;
        const before = tw.t;
        tw.t = Math.min(end, tw.t + dt);
        if (before < mid && tw.t >= mid) {
            if (ship) {
                tw.t = mid;
                tw.stage = 'turn';
                tw.pause = tw.pauseLen = TW.TURN_PAUSE;
                return;
            }
            tw.stage = 'back';
        }
        if (tw.t >= end - 1e-12) {
            tw.t = end;
            tw.stage = 'done';
            tw.pause = TW.END_PAUSE;
        }
    }

    // ------------------------------------------------------------------
    // Muons: physics
    // ------------------------------------------------------------------
    function newMuons() {
        for (let i = 0; i < MU.N; i++) {
            mu.life[i] = -MU.LIFE * Math.log(1 - Math.random());
            mu.x[i] = (i + 0.5 + (Math.random() - 0.5) * 0.5) / MU.N;
        }
    }

    function muonTimes() {
        const v = Math.max(S.v, 1e-6);
        const g = gammaOf(S.v);
        const tLand = MU.H / (v * C_KM_US);    // Earth time to fall 15 km (µs)
        return { g, v, tLand, tauLand: tLand / g };
    }

    // The muons' own clock (the same for all of them) at the current frame time.
    function muonClock() {
        return homeMoves() ? mu.t : mu.t / gammaOf(S.v);
    }

    function muonsLeft() {
        const tau = muonClock();
        let n = 0;
        for (let i = 0; i < MU.N; i++) if (mu.life[i] > tau) n++;
        return n;
    }

    function resetMuons(fresh) {
        if (fresh) newMuons();
        mu.t = 0;
        mu.stage = 'intro';
        mu.pause = homeMoves() ? MU.INTRO : MU.INTRO_EARTH;
        mu.decayedAt.fill(-1);
    }

    // Screen zoom of the muons' view: 1 (Earth's scale) for a moment at the start, easing up to γ, at which the
    // squashed atmosphere fills the same height as the full 15 km does measured from Earth.
    function muonZoom() {
        if (!homeMoves()) return 1;
        const g = gammaOf(S.v);
        if (mu.stage !== 'intro') return g;
        const p = clamp((1 - mu.pause / MU.INTRO - 0.3) / 0.55, 0, 1);
        return 1 + (g - 1) * (1 - Math.cos(Math.PI * p)) / 2;
    }

    function stepMuons(dt, dtReal) {
        if (mu.pause > 0) {
            mu.pause -= dtReal;
            if (mu.pause <= 0) {
                if (mu.stage === 'intro') {
                    mu.stage = 'fall';
                } else if (mu.stage === 'done') {
                    resetMuons(true);
                    resetChartData();
                }
            }
            return;
        }
        if (mu.stage === 'done') return;
        const { tLand, tauLand } = muonTimes();
        const tauBefore = muonClock();
        const end = homeMoves() ? tauLand : tLand;
        // Once every muon has decayed the rest of the fall plays faster, so the ground still arrives
        mu.t = Math.min(end, mu.t + (muonsLeft() === 0 ? MU.EMPTY_FAST : 1) * dt);
        const tau = muonClock();
        for (let i = 0; i < MU.N; i++) {
            if (mu.life[i] > tauBefore && mu.life[i] <= tau) mu.decayedAt[i] = realNow;
        }
        // At low speeds even the faster finish would take too long: stop once they have all gone
        const slowFinish = muonsLeft() === 0 && dtReal > 0 && (end - mu.t) * dtReal / (MU.EMPTY_FAST * dt) > MU.EMPTY_MAX;
        if (mu.t >= end - 1e-12 || slowFinish) {
            mu.stage = 'done';
            mu.pause = MU.END_PAUSE;
        }
    }

    // ------------------------------------------------------------------
    // Shared state changes
    // ------------------------------------------------------------------
    function resetScenario(freshMuons) {
        SCENE[S.scenario].reset(freshMuons);
        resetChartData();
        updateReadouts(true);
    }

    function setFrame(frame) {
        if (frame !== 'home' && frame !== 'away') return;
        if (frame === S.frame) return;
        S.frame = frame;
        syncFrameButtons();
        resetScenario(false);   // the muons keep their lifetimes, so the same ones survive in both frames
        updateChartLabels();
    }

    function setVelocity(v, fromSlider) {
        v = clamp(v, 0, 0.999);
        if (v === S.v && fromSlider) return;
        S.v = v;
        if (ui.velocity && !fromSlider) ui.velocity.value = String(stepFromSpeed(v));
        syncVelocityUI();
        // A trip, a fall or a race is planned at one speed: changing it starts again (with the same muons).
        if (S.scenario !== 'clocks') {
            SCENE[S.scenario].reset(false);
            resetChartData();
        }
        updateReadouts(true);
        updateGammaChart();
    }

    function setScenario(name) {
        if (!SCENARIOS[name]) return;
        S.scenario = name;
        if (ui.scenario && ui.scenario.value !== name) ui.scenario.value = name;
        const sc = SCENARIOS[name];
        if (ui.scenarioHint) ui.scenarioHint.textContent = sc.hint;
        canvas.setAttribute('aria-label', sc.aria);
        // Only the "Show" toggles (and the probe speed) that apply to this scenario
        ui.toggles.forEach((t) => {
            const on = sc.show.includes(t.key);
            if (t.input) t.input.hidden = !on;
            if (t.label) t.label.hidden = !on;
        });
        if (ui.showGroup) ui.showGroup.hidden = sc.show.length === 0;
        if (ui.probeGroup) ui.probeGroup.hidden = !sc.probe;
        ui.frameBtns.forEach((btn) => {
            const side = sc[btn.dataset.frame];
            const icon = btn.querySelector('.icon');
            const label = btn.querySelector('.rel-frame-name');
            if (icon) icon.className = `icon solid ${side.icon}`;
            if (label) label.textContent = side.name;
        });
        S.v = sc.v;
        if (ui.velocity) ui.velocity.value = String(stepFromSpeed(S.v));
        syncVelocityUI();
        resetScenario(true);
        updateChartLabels();
        updateGammaChart();
    }

    function syncFrameButtons() {
        ui.frameBtns.forEach((btn) => {
            const on = btn.dataset.frame === S.frame;
            btn.setAttribute('aria-checked', on ? 'true' : 'false');
            btn.tabIndex = on ? 0 : -1;
        });
    }

    function syncVelocityUI() {
        if (ui.velocityVal) ui.velocityVal.textContent = fmtV(S.v);
        if (ui.velocity) {
            const pct = (100 * parseFloat(ui.velocity.value)) / parseFloat(ui.velocity.max || 130);
            ui.velocity.style.setProperty('--rel-fill', `${pct.toFixed(1)}%`);
            ui.velocity.setAttribute('aria-valuetext', `${fmtV(S.v)} times the speed of light`);
        }
    }

    // ------------------------------------------------------------------
    // Drawing helpers
    // ------------------------------------------------------------------
    function setFont(sizePx, weight) {
        ctx.font = `${weight || 400} ${Math.round(sizePx)}px ${FONT}`;
    }

    function textW(str, sizePx, weight) {
        setFont(sizePx, weight);
        return ctx.measureText(str).width;
    }

    function roundRectPath(x, y, w, h, r) {
        r = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    // Craft transform: local coordinates (scene units, y down) to CSS px, squeezed along x when moving.
    let tcx = 0, tcy = 0, tkx = 1, tky = 1;
    const tx = (x) => tcx + x * tkx;
    const ty = (y) => tcy + y * tky;
    function setCraft(x, y, kx, ky) {
        tcx = x; tcy = y; tkx = kx; tky = ky;
    }
    // Rounded rectangle in local coordinates; the corner radius is in px.
    function localRect(x0, y0, x1, y1, rPx) {
        roundRectPath(tx(x0), ty(y0), (x1 - x0) * tkx, (y1 - y0) * tky, rPx);
    }
    // The same with the corner radius in local units, so the corners squeeze along with the drawing.
    function localRectScaled(x0, y0, x1, y1, r) {
        const a = tx(x0), b = tx(x1);
        const left = Math.min(a, b), w = Math.abs(b - a);
        const top = ty(y0), h = (y1 - y0) * tky;
        const rx = Math.min(r * Math.abs(tkx), w / 2), ry = Math.min(r * tky, h / 2);
        ctx.beginPath();
        ctx.moveTo(left + rx, top);
        ctx.lineTo(left + w - rx, top);
        ctx.ellipse(left + w - rx, top + ry, rx, ry, 0, -Math.PI / 2, 0);
        ctx.lineTo(left + w, top + h - ry);
        ctx.ellipse(left + w - rx, top + h - ry, rx, ry, 0, 0, Math.PI / 2);
        ctx.lineTo(left + rx, top + h);
        ctx.ellipse(left + rx, top + h - ry, rx, ry, 0, Math.PI / 2, Math.PI);
        ctx.lineTo(left, top + ry);
        ctx.ellipse(left + rx, top + ry, rx, ry, 0, Math.PI, Math.PI * 1.5);
        ctx.closePath();
    }

    // A clock readout: a rounded box with a small clock face (its hand turns once per tick, so you can see
    // how fast the clock runs) and the reading right-aligned in a fixed-width slot, so digits never jitter.
    function pillSize(f) {
        return { h: Math.round(f * 1.75), font: f * 1.12 };
    }
    // A compact pill (the clocks at a craft's ends) has no clock face and a smaller reading.
    function pillWidth(f, unit, template, compact) {
        const ps = pillSize(f);
        const font = compact ? ps.font * 0.9 : ps.font;
        const slot = textW(template || '000.0', font, 700);
        const unitW = unit ? textW(` ${unit}`, font, 400) : 0;
        const lead = compact ? ps.h * 0.4 : ps.h * 0.55 + ps.h * 0.62 + 4;
        return Math.round(lead + slot + unitW + ps.h * 0.4);
    }
    function drawPill(cx, cy, value, unit, opts) {
        const f = opts.f;
        const ps = pillSize(f);
        const compact = !!opts.compact;
        const font = compact ? ps.font * 0.9 : ps.font;
        const w = pillWidth(f, unit, opts.template, compact);
        const x0 = Math.round(cx - w / 2), y0 = Math.round(cy - ps.h / 2);
        const flash = opts.flash || 0;
        const baseAlpha = ctx.globalAlpha;   // the caller may be fading the whole label
        roundRectPath(x0 + 0.5, y0 + 0.5, w - 1, ps.h - 1, ps.h / 2);
        ctx.fillStyle = pal.pillBg;
        ctx.fill();
        ctx.lineWidth = 1 + flash;
        ctx.strokeStyle = flash > 0.02 ? opts.color : (opts.edge || pal.pillEdge);
        ctx.globalAlpha = baseAlpha * (flash > 0.02 ? 0.4 + 0.6 * flash : 1);
        ctx.stroke();
        ctx.globalAlpha = baseAlpha;
        if (!compact) {
            // Clock face
            const r = ps.h * 0.31;
            const fx = x0 + ps.h * 0.55, fy = cy;
            ctx.beginPath();
            ctx.arc(fx, fy, r, 0, TAU);
            ctx.strokeStyle = opts.color;
            ctx.lineWidth = 1.4;
            ctx.stroke();
            const ang = TAU * (opts.phase || 0) - Math.PI / 2;
            ctx.beginPath();
            ctx.moveTo(fx, fy);
            ctx.lineTo(fx + Math.cos(ang) * r * 0.78, fy + Math.sin(ang) * r * 0.78);
            ctx.lineWidth = 1.6;
            ctx.lineCap = 'round';
            ctx.stroke();
            ctx.lineCap = 'butt';
        }
        // Reading: right-aligned value, then the unit
        const unitW = unit ? textW(` ${unit}`, font, 400) : 0;
        const xr = x0 + w - ps.h * 0.4 - unitW;
        ctx.textBaseline = 'middle';
        setFont(font, 700);
        ctx.textAlign = 'right';
        ctx.fillStyle = pal.text;
        ctx.fillText(value, xr, cy + 0.5);
        if (unit) {
            setFont(font, 400);
            ctx.textAlign = 'left';
            ctx.fillStyle = pal.muted;
            ctx.fillText(` ${unit}`, xr, cy + 0.5);
        }
        return { x0, x1: x0 + w, y0, y1: y0 + ps.h };
    }

    // "Name [clock]" centred at cx, on one row.
    function craftLabelWidth(f, name, unit, template) {
        return textW(name, f, 700) + 8 + pillWidth(f, unit, template);
    }
    function drawCraftLabel(cx, cy, name, color, value, unit, opts) {
        const f = opts.f;
        const nameW = textW(name, f, 700);
        const w = nameW + 8 + pillWidth(f, unit, opts.template);
        if (opts.keepInside) cx = clamp(cx, w / 2 + 6, viewW - w / 2 - 6);
        const x0 = cx - w / 2;
        setFont(f, 700);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.fillText(name, x0, cy + 0.5);
        const pw = pillWidth(f, unit, opts.template);
        drawPill(x0 + nameW + 8 + pw / 2, cy, value, unit, opts);
        return w;
    }

    function drawArrow(x0, y, x1, color, width) {
        const dir = Math.sign(x1 - x0) || 1;
        const head = Math.max(5, width * 3.2);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1 - dir * head * 0.8, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x1 - dir * head, y - head * 0.6);
        ctx.lineTo(x1 - dir * head, y + head * 0.6);
        ctx.closePath();
        ctx.fill();
    }

    // Velocity arrow with "0.80 c" over it, starting at x0 and pointing along dir.
    function drawVelocity(x0, y, dir, len, f, speed) {
        if (speed <= 0) return;
        drawArrow(x0, y, x0 + dir * len, pal.muted, Math.max(1.5, f * 0.13));
        setFont(f * 0.92, 700);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = pal.muted;
        ctx.fillText(`${fmtV(speed)} c`, x0 + dir * len / 2, y - Math.max(4, f * 0.3));
    }

    // A craft's name, with its velocity after it when it moves ("Ship → 0.50 c"), centred at cx and kept inside
    // the canvas. Returns the tag's extent.
    function drawNameTag(cx, cy, name, color, f, u) {
        const nameW = textW(name, f, 700);
        const speed = Math.abs(u) > 0.0005 ? `${fmtV(Math.abs(u))} c` : '';
        const arrowW = speed ? clamp(f * 2.2, 20, 34) : 0;
        const speedW = speed ? textW(speed, f * 0.92, 700) : 0;
        const w = nameW + (speed ? 8 + arrowW + 6 + speedW : 0);
        const x0 = clamp(cx - w / 2, 6, Math.max(6, viewW - w - 6));
        setFont(f, 700);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.fillText(name, x0, cy + 0.5);
        if (speed) {
            const xa = x0 + nameW + 8;
            const dir = Math.sign(u);
            drawArrow(dir > 0 ? xa : xa + arrowW, cy, dir > 0 ? xa + arrowW : xa, pal.muted, Math.max(1.5, f * 0.12));
            setFont(f * 0.92, 700);
            ctx.fillStyle = pal.muted;
            ctx.fillText(speed, xa + arrowW + 6, cy + 0.5);
        }
        return { x0, x1: x0 + w };
    }

    // Horizontal dimension line from x0 to x1 with its length written under it, or (inline) in a gap in the
    // middle of the line when there is room for it.
    function drawDimension(x0, x1, y, text, f, color, inline) {
        const tick = Math.max(4, f * 0.4);
        setFont(f * 0.95, 700);
        const tw = ctx.measureText(text).width;
        const gap = inline && x1 - x0 > tw + 24 ? tw / 2 + 6 : 0;
        const xm = (x0 + x1) / 2;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(xm - gap, y);
        ctx.moveTo(xm + gap, y);
        ctx.lineTo(x1, y);
        ctx.moveTo(x0, y - tick);
        ctx.lineTo(x0, y + tick);
        ctx.moveTo(x1, y - tick);
        ctx.lineTo(x1, y + tick);
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.fillStyle = color;
        if (gap) {
            ctx.textBaseline = 'middle';
            ctx.fillText(text, clamp(xm, tw / 2 + 4, viewW - tw / 2 - 4), y + 0.5);
        } else if (inline) {
            // Beside the line, on whichever side has room
            const right = x1 + 6 + tw <= viewW - 4;
            ctx.textAlign = right ? 'left' : 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, right ? x1 + 6 : x0 - 6, y + 0.5);
        } else {
            ctx.textBaseline = 'top';
            ctx.fillText(text, clamp(xm, tw / 2 + 4, viewW - tw / 2 - 4), y + tick + 2);
        }
    }

    // Scale bar at the bottom left (as on the other simulation pages): a round length, `unit` per `k` px.
    function niceLength(x) {
        const e = Math.pow(10, Math.floor(Math.log10(x)));
        const m = x / e;
        return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * e;
    }
    function drawScaleBar(k, unit, f) {
        const len = niceLength(clamp(viewW / 9, 60, 140) / k);
        const px = len * k;
        const x0 = 12, y0 = viewH - 10;
        ctx.strokeStyle = pal.muted;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x0, y0 - 5);
        ctx.lineTo(x0, y0);
        ctx.lineTo(x0 + px, y0);
        ctx.lineTo(x0 + px, y0 - 5);
        ctx.stroke();
        setFont(f * 0.88, 400);
        ctx.fillStyle = pal.muted;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${len} ${unit}`, x0 + px + 6, y0 + 2);
    }

    // A small italic "c" beside a pulse of light: its speed, the same in every frame. Inside a clock bay (dark
    // in both themes) it is the bright yellow with a dark halo; on the open canvas it follows the theme.
    function drawLightTag(x, y, f, inBay) {
        const onDark = inBay || dark;
        ctx.font = `italic 700 ${Math.round(f * 1.1)}px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3;
        ctx.strokeStyle = onDark ? 'rgba(13,16,22,0.85)' : pal.bg;
        ctx.strokeText('c', x, y);
        ctx.fillStyle = `rgb(${onDark ? pal.chamberLightRGB : pal.lightRGB})`;
        ctx.fillText('c', x, y);
        ctx.lineJoin = 'miter';
    }

    // Background stars, fixed to the home frame (period P scene units). Measured from the away frame they
    // stream past at the home frame's velocity u and bunch up by γ (the home frame is length-contracted).
    function drawStars(k, P, homeX, g) {
        const n = Math.ceil(g) + 1;
        const fade = 1 / Math.sqrt(g);
        const period = P / g;
        for (let i = 0; i < stars.length; i++) {
            const s = stars[i];
            const y = s.fy * viewH;
            ctx.fillStyle = `rgba(${pal.starRGB},${(s.a * fade * (dark ? 1 : 0.55)).toFixed(3)})`;
            const base = mod(homeX + (s.fx - 0.5) * P / g + P / 2, period) - P / 2;
            ctx.beginPath();
            for (let j = 0; j < n; j++) {
                const xs = viewW / 2 + (base + j * period) * k;
                if (xs > viewW + 2) break;
                ctx.moveTo(xs + s.r, y);
                ctx.arc(xs, y, s.r, 0, TAU);
            }
            ctx.fill();
        }
    }

    // Note at the top left: which frame the measurements are made from.
    let captionsOn = true;    // off only for clean captures (test API)
    function drawCaption(f) {
        if (!captionsOn) return;
        const side = SCENARIOS[S.scenario][S.frame];
        const fs = f * 0.92;
        const pad = Math.max(8, f * 0.7);
        const y = pad + fs * 0.6;
        const lead = 'Measured from ';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        setFont(fs, 400);
        ctx.fillStyle = pal.muted;
        ctx.fillText(lead, pad, y);
        setFont(fs, 700);
        ctx.fillStyle = S.frame === 'home' ? pal.blueText : (S.scenario === 'muons' ? pal.purpleText : pal.pinkText);
        ctx.fillText(side.the, pad + textW(lead, fs, 400), y);
    }

    // ------------------------------------------------------------------
    // Craft drawings (local coordinates in light-seconds, centred, nose to +x)
    // ------------------------------------------------------------------
    function drawShipBody(withChamber) {
        const edge = Math.max(1, tky * 0.006);
        // Fins and nozzle (behind the hull)
        ctx.fillStyle = pal.shipShade;
        ctx.beginPath();
        ctx.moveTo(tx(-0.34), ty(-0.3));
        ctx.lineTo(tx(-0.6), ty(-0.47));
        ctx.lineTo(tx(-0.74), ty(-0.47));
        ctx.lineTo(tx(-0.74), ty(-0.3));
        ctx.closePath();
        ctx.moveTo(tx(-0.34), ty(0.3));
        ctx.lineTo(tx(-0.6), ty(0.47));
        ctx.lineTo(tx(-0.74), ty(0.47));
        ctx.lineTo(tx(-0.74), ty(0.3));
        ctx.closePath();
        ctx.moveTo(tx(-0.72), ty(-0.15));
        ctx.lineTo(tx(-0.8), ty(-0.19));
        ctx.lineTo(tx(-0.8), ty(0.19));
        ctx.lineTo(tx(-0.72), ty(0.15));
        ctx.closePath();
        ctx.fill();
        // Hull
        ctx.beginPath();
        ctx.moveTo(tx(-0.7), ty(-0.31));
        ctx.lineTo(tx(0.3), ty(-0.31));
        ctx.bezierCurveTo(tx(0.56), ty(-0.31), tx(0.76), ty(-0.16), tx(0.8), ty(0));
        ctx.bezierCurveTo(tx(0.76), ty(0.16), tx(0.56), ty(0.31), tx(0.3), ty(0.31));
        ctx.lineTo(tx(-0.7), ty(0.31));
        ctx.quadraticCurveTo(tx(-0.76), ty(0.31), tx(-0.76), ty(0.25));
        ctx.lineTo(tx(-0.76), ty(-0.25));
        ctx.quadraticCurveTo(tx(-0.76), ty(-0.31), tx(-0.7), ty(-0.31));
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, ty(-0.31), 0, ty(0.31));
        grad.addColorStop(0, '#f7a4b8');
        grad.addColorStop(0.55, pal.pink);
        grad.addColorStop(1, '#d96f8c');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = pal.edge;
        ctx.lineWidth = edge;
        ctx.stroke();
        // Cockpit window
        ctx.beginPath();
        ctx.ellipse(tx(0.52), ty(-0.06), Math.max(0.5, 0.075 * Math.abs(tkx)), 0.075 * tky, 0, 0, TAU);
        ctx.fillStyle = '#2a3140';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = Math.max(1, tky * 0.012);
        ctx.stroke();
        if (!withChamber) {
            ctx.beginPath();
            ctx.ellipse(tx(0.2), ty(-0.06), Math.max(0.5, 0.06 * Math.abs(tkx)), 0.06 * tky, 0, 0, TAU);
            ctx.ellipse(tx(-0.08), ty(-0.06), Math.max(0.5, 0.06 * Math.abs(tkx)), 0.06 * tky, 0, 0, TAU);
            ctx.fillStyle = '#2a3140';
            ctx.fill();
        }
    }

    function drawStationBody() {
        const edge = Math.max(1, tky * 0.006);
        // Truss and solar panels
        ctx.strokeStyle = pal.truss;
        ctx.lineWidth = Math.max(1.5, tky * 0.018);
        ctx.beginPath();
        for (const s of [-1, 1]) {
            ctx.moveTo(tx(s * 0.6), ty(0));
            ctx.lineTo(tx(s * 0.73), ty(0));
            ctx.moveTo(tx(s * 0.73), ty(-0.45));
            ctx.lineTo(tx(s * 0.73), ty(0.45));
        }
        ctx.stroke();
        for (const s of [-1, 1]) {
            for (const v of [-1, 1]) {
                const x0 = s > 0 ? 0.665 : -0.8, x1 = s > 0 ? 0.8 : -0.665;
                const y0 = v > 0 ? 0.11 : -0.47, y1 = v > 0 ? 0.47 : -0.11;
                localRect(x0, y0, x1, y1, 2);
                ctx.fillStyle = pal.panel;
                ctx.fill();
                ctx.strokeStyle = pal.panelGrid;
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.beginPath();
                for (let j = 1; j < 4; j++) {
                    const yy = y0 + (y1 - y0) * j / 4;
                    ctx.moveTo(tx(x0), ty(yy));
                    ctx.lineTo(tx(x1), ty(yy));
                }
                ctx.moveTo(tx((x0 + x1) / 2), ty(y0));
                ctx.lineTo(tx((x0 + x1) / 2), ty(y1));
                ctx.stroke();
            }
        }
        const grad = ctx.createLinearGradient(0, ty(-0.32), 0, ty(0.32));
        grad.addColorStop(0, '#a6dbfa');
        grad.addColorStop(0.55, pal.blue);
        grad.addColorStop(1, '#5fa9d8');
        // Docking stubs and modules
        ctx.fillStyle = pal.stationShade;
        localRect(-0.665, -0.08, -0.58, 0.08, 2);
        ctx.fill();
        localRect(0.58, -0.08, 0.665, 0.08, 2);
        ctx.fill();
        ctx.fillStyle = grad;
        ctx.strokeStyle = pal.edge;
        ctx.lineWidth = edge;
        localRect(-0.6, -0.17, -0.22, 0.17, 0.05 * tky);
        ctx.fill();
        ctx.stroke();
        localRect(0.22, -0.17, 0.6, 0.17, 0.05 * tky);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,0.22)';
        ctx.beginPath();
        for (const s of [-1, 1]) {
            ctx.moveTo(tx(s * 0.41), ty(-0.17));
            ctx.lineTo(tx(s * 0.41), ty(0.17));
        }
        ctx.stroke();
        // Hub around the light clock
        localRect(-0.25, -0.32, 0.25, 0.32, 0.07 * tky);
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = pal.edge;
        ctx.stroke();
    }

    // The light clock: a dark chamber with a mirror at the top and bottom and the pulse of light between.
    function drawLightClock(height, flash) {
        const hw = 0.17;
        localRect(-hw, -0.29, hw, 0.29, Math.min(4, 0.03 * tky));
        ctx.fillStyle = pal.chamber;
        ctx.fill();
        ctx.strokeStyle = pal.chamberEdge;
        ctx.lineWidth = 1;
        ctx.stroke();
        const mh = Math.max(2, 0.022 * tky);
        const m = LC.MIRROR / 2;
        ctx.fillStyle = pal.mirror;
        ctx.fillRect(tx(-hw * 0.82), ty(-m) - mh, (2 * hw * 0.82) * tkx, mh);
        ctx.fillRect(tx(-hw * 0.82), ty(m), (2 * hw * 0.82) * tkx, mh);
        if (flash > 0) {
            // A tick: the lower mirror glows as the light gets back to it.
            ctx.fillStyle = `rgba(${pal.chamberLightRGB},${(0.85 * flash).toFixed(3)})`;
            ctx.fillRect(tx(-hw * 0.82), ty(m) - 1, (2 * hw * 0.82) * tkx, mh + 2);
        }
    }

    // A detector, drawn over a craft in place of its windows (lightning): a dark panel with two lamps, lit by
    // light that has arrived from behind (lit[0]) and from ahead (lit[1]).
    function drawLamps(lit) {
        localRectScaled(-0.15, -0.22, 0.15, -0.08, 0.035);
        ctx.fillStyle = pal.glass;
        ctx.fill();
        [[-0.125, -0.012], [0.012, 0.125]].forEach((seg, i) => {
            if (lit[i]) {
                const x = tx((seg[0] + seg[1]) / 2), y = ty(-0.15), r = 0.16 * tky;
                const g = ctx.createRadialGradient(x, y, 0, x, y, r);
                g.addColorStop(0, `rgba(${pal.chamberLightRGB},0.75)`);
                g.addColorStop(1, `rgba(${pal.chamberLightRGB},0)`);
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, TAU);
                ctx.fill();
            }
            localRectScaled(seg[0], -0.19, seg[1], -0.11, 0.015);
            ctx.fillStyle = lit[i] ? pal.photon : 'rgba(255,255,255,0.14)';
            ctx.fill();
        });
    }

    // A pulse of light: a pale core in a yellow glow (amber on the light theme's open canvas).
    function drawPhoton(x, y, r, inBay) {
        const rgb = inBay || dark ? pal.chamberLightRGB : pal.lightRGB;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
        g.addColorStop(0, `rgba(${rgb},0.9)`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r * 3.2, 0, TAU);
        ctx.fill();
        ctx.fillStyle = inBay || dark ? pal.photon : '#ffcf4d';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
    }

    // Light path behind a pulse, fading with age: drawn as a few polylines of equal opacity (one stroke
    // each, so the joins stay clean). xShift moves the trail with a wrapped copy of its craft.
    const TRAIL_BANDS = 8;
    function drawTrail(trail, xShift, k, cx, cy, Tnow, rgb, width) {
        if (trail.length < 2) return;
        const m = LC.MIRROR / 2;
        const X = (p) => cx + (p.x + xShift) * k;
        const Y = (p) => cy + (m - p.h * LC.MIRROR) * k;
        ctx.lineWidth = width;
        ctx.lineJoin = 'round';
        let i = 1;
        while (i < trail.length) {
            const band = Math.min(TRAIL_BANDS - 1, Math.floor(clamp((Tnow - trail[i].t) / LC.TRAIL, 0, 0.999) * TRAIL_BANDS));
            ctx.beginPath();
            ctx.moveTo(X(trail[i - 1]), Y(trail[i - 1]));
            while (i < trail.length) {
                const b = Math.min(TRAIL_BANDS - 1, Math.floor(clamp((Tnow - trail[i].t) / LC.TRAIL, 0, 0.999) * TRAIL_BANDS));
                if (b !== band) break;
                ctx.lineTo(X(trail[i]), Y(trail[i]));
                i++;
            }
            const alpha = 0.85 * (1 - (band + 0.5) / TRAIL_BANDS);
            ctx.strokeStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
            ctx.stroke();
        }
        ctx.lineJoin = 'miter';
    }

    // Marks along a light path at every LC.DOT seconds of the shown frame's time, like a strobe photograph.
    // Light covers the same distance between marks in both clocks (straight up and down in the clock at rest,
    // on a slant in the moving one), so the marks are the same distance apart: the same speed, c.
    function drawStrobe(trail, xShift, k, cx, cy, Tnow, rgb, r) {
        if (trail.length < 2) return;
        const m = LC.MIRROR / 2;
        const dot = LC.DOT * k >= 6 ? LC.DOT : 2 * LC.DOT;
        let j = 1;
        for (let n = Math.ceil(Math.max(trail[0].t, Tnow - LC.TRAIL) / dot - 1e-6); n * dot <= Tnow + 1e-6; n++) {
            const td = n * dot;
            while (j < trail.length - 1 && trail[j].t < td) j++;
            const a = trail[j - 1], b = trail[j];
            const s = b.t > a.t ? clamp((td - a.t) / (b.t - a.t), 0, 1) : 1;
            const x = cx + (a.x + s * (b.x - a.x) + xShift) * k;
            const y = cy + (m - (a.h + s * (b.h - a.h)) * LC.MIRROR) * k;
            const alpha = 0.95 * (1 - clamp((Tnow - td) / LC.TRAIL, 0, 1));
            ctx.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, TAU);
            ctx.fill();
        }
    }

    // ------------------------------------------------------------------
    // Scene: light speed
    // ------------------------------------------------------------------
    // Two lanes, the ship above and the station below, each with its name over it. x0 is where the craft fire
    // (the front end of the craft at rest), placed so the craft at rest just fits to its left.
    function lightLayout() {
        const f = fontPx;
        const capH = Math.round(f * 2.3);
        const labelH = Math.round(f * 1.9);
        const tagH = Math.round(f * 1.5);       // a probe's speed, under it
        const botH = Math.round(f * 1.8);       // scale bar
        const free = viewH - capH - botH - 2 * (labelH + tagH);
        const k = Math.max(8, Math.min(viewW / LT.MIN_SPAN, free / (2 * LT.HEIGHT)));
        const laneH = labelH + LT.HEIGHT * k + tagH;
        const gap = Math.max(f * 0.4, (viewH - capH - botH - 2 * laneH) / 3);
        const yShip = capH + gap + labelH + LT.HEIGHT * k / 2;
        const yStation = yShip + LT.HEIGHT * k / 2 + tagH + gap + labelH + LT.HEIGHT * k / 2;
        const x0 = Math.round(Math.max(f * 1.2, 10) + LT.L0 * k);
        return { f, k, labelH, yShip, yStation, x0, P: viewW / k };
    }

    // A probe: a small dart in its craft's colour, nose forward, squeezed by its own γ.
    function drawProbe(x, y, k, u, color, dark2) {
        const len = clamp(0.16 * k, 9, 22), h = len * 0.36;
        const sx = 1 / gammaOf(Math.min(Math.abs(u), 0.9999));
        const l = len * sx;
        ctx.beginPath();
        ctx.moveTo(x + l / 2, y);
        ctx.quadraticCurveTo(x + l * 0.2, y - h / 2, x - l / 2, y - h / 2);
        ctx.lineTo(x - l / 2, y + h / 2);
        ctx.quadraticCurveTo(x + l * 0.2, y + h / 2, x + l / 2, y);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.fillStyle = dark2;
        ctx.fillRect(x - l / 2, y - h / 2, Math.max(1, l * 0.18), h);
    }

    // Small text under a probe (its speed), centred at x and kept inside the canvas.
    function drawSpeedTag(x, y, text, f, color, dashed) {
        setFont(f * 0.85, 700);
        const w = ctx.measureText(text).width;
        const xc = clamp(x, w / 2 + 4, viewW - w / 2 - 4);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.globalAlpha = dashed ? 0.7 : 1;
        ctx.fillStyle = color;
        ctx.fillText(text, xc, y);
        ctx.globalAlpha = 1;
    }

    function drawLight() {
        const lay = lightLayout();
        const st = lightState();
        const k = lay.k, f = lay.f, t = st.t;
        const X = (x) => lay.x0 + x * k;
        const hm = homeMoves();
        drawStars(k, lay.P, hm ? st.V * (t + LT.LEAD) : 0, hm ? st.g : 1);
        const pr = Math.max(2.5, k * 0.02);
        const dy = clamp(LT.PROBE_Y * k, 7, 22);          // the probes fly just under the flashes
        const lanes = [
            { which: 'away', c: st.away, y: lay.yShip, color: pal.pink, text: pal.pinkText, dark2: pal.shipShade },
            { which: 'home', c: st.home, y: lay.yStation, color: pal.blue, text: pal.blueText, dark2: pal.stationShade }
        ];
        lanes.forEach((lane) => {
            lane.w = st.probe[lane.which];
            lane.moving = lane.which === st.moving;
        });

        // Under the craft: the strobe marks every LT.DOT seconds (the flashes' are the same distance apart in
        // both lanes, the probes' closer together) and Newton's ghosts.
        if (t > 0) {
            for (const lane of lanes) {
                const y = lane.y;
                if (S.showPaths) {
                    for (let n = 1; n * LT.DOT <= t + 1e-9; n++) {
                        const tn = n * LT.DOT;
                        const xl = X(tn);
                        if (xl < viewW + 4) {
                            ctx.fillStyle = `rgba(${pal.lightRGB},0.8)`;
                            ctx.beginPath();
                            ctx.arc(xl, y, Math.max(1.8, pr * 0.55), 0, TAU);
                            ctx.fill();
                        }
                        const xp = X(lane.w * tn);
                        if (xp > -4 && xp < viewW + 4) {
                            ctx.fillStyle = dark ? lane.color : lane.text;
                            ctx.globalAlpha = 0.65;
                            ctx.beginPath();
                            ctx.arc(xp, y + dy, Math.max(1.5, pr * 0.45), 0, TAU);
                            ctx.fill();
                            ctx.globalAlpha = 1;
                        }
                    }
                }
                // Newton's prediction: where the moving craft's flash and probe would be if speeds simply added
                if (S.showNewton && lane.moving) {
                    ctx.setLineDash([3, 3]);
                    ctx.lineWidth = 1.3;
                    const xn = X(st.newton.light * t);
                    if (xn < viewW + 20) {
                        ctx.strokeStyle = `rgba(${pal.lightRGB},0.85)`;
                        ctx.beginPath();
                        ctx.arc(xn, y, pr * 1.7, 0, TAU);
                        ctx.stroke();
                        drawSpeedTag(xn, y - pr * 1.7 - f * 1.25, `${fmtU(st.newton.light)} c`, f, `rgb(${pal.lightRGB})`, true);
                    }
                    const xq = X(st.newton.probe * t);
                    if (xq > -20 && xq < viewW + 20) {
                        ctx.strokeStyle = lane.color;
                        ctx.beginPath();
                        ctx.arc(xq, y + dy, pr * 1.3, 0, TAU);
                        ctx.stroke();
                        drawSpeedTag(xq, y + dy + pr * 1.3 + 3, `${fmtU(st.newton.probe)} c`, f, lane.text, true);
                    }
                    ctx.setLineDash([]);
                }
            }
            // The two flashes are always level: a faint line joins them.
            if (X(t) < viewW + pr) {
                ctx.setLineDash([3, 5]);
                ctx.strokeStyle = `rgba(${pal.lightRGB},0.45)`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(X(t), lay.yShip + pr * 2);
                ctx.lineTo(X(t), lay.yStation - pr * 2 - f * 1.3);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // The craft, with their names (and the moving one's velocity) over them
        for (const lane of lanes) {
            const c = lane.c, y = lane.y;
            const xs = X(c.x);
            const s = LT.SIZE;
            setCraft(xs, y, k * s * (c.moving ? 1 / st.g : 1), k * s);
            if (lane.which === 'away') drawShipBody(false);
            else drawStationBody();
            const labelY = y - (LT.HEIGHT / 2) * k - lay.labelH / 2;
            const tag = drawNameTag(xs, labelY, SCENARIOS.light[lane.which].name, lane.text, f, c.u);
            hitRects.push({ x0: Math.min(xs - c.length * k / 2, tag.x0) - 6, x1: Math.max(xs + c.length * k / 2, tag.x1) + 6,
                y0: labelY - f, y1: y + (LT.HEIGHT / 2) * k, frame: lane.which });
        }

        // Over the craft: the burst where they fire, the probes with their speeds, and the flashes marked "c"
        if (t >= 0) {
            const burst = clamp(1 - (realNow - lt.flashAt) / 0.5, 0, 1);
            for (const lane of lanes) {
                const y = lane.y;
                if (burst > 0 && t < 0.6) {
                    // At x = 0, where the craft fired: fixed in the shown frame
                    ctx.strokeStyle = `rgba(${pal.chamberLightRGB},${(0.8 * burst).toFixed(3)})`;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(X(0), y, pr + (1 - burst) * 18, 0, TAU);
                    ctx.stroke();
                }
                const xp = X(lane.w * t);
                if (xp > -20 && xp < viewW + 20) {
                    drawProbe(xp, y + dy, k, lane.w, lane.color, lane.dark2);
                    drawSpeedTag(xp, y + dy + clamp(0.05 * k, 4, 7) + 3, `${fmtU(lane.w)} c`, f, lane.text);
                }
                const xl = X(t);
                if (xl < viewW + pr * 3) {
                    drawPhoton(xl, y, pr);
                    drawLightTag(xl - f * 0.28, y - pr * 1.7 - f * 0.6, f);
                }
            }
        }
        drawScaleBar(k, 'ls', f);
        drawCaption(f);
    }

    // ------------------------------------------------------------------
    // Scene: lightning
    // ------------------------------------------------------------------
    // The ship's lane above the station's, each name on the outside. Both lanes share x, so a flash's front is
    // a vertical line across both.
    function lightningLayout() {
        const f = fontPx;
        const capH = Math.round(f * 2.3);
        const labelH = Math.round(f * 1.9);
        const botH = Math.round(f * 1.8);
        const s = LN.SIZE;
        const span = 4 * LT_HALF * s + LN.GAP;     // top of the ship's fins to the bottom of the station's panels (ls)
        const free = viewH - capH - botH - 2 * labelH;
        const k = Math.max(8, Math.min(viewW / LN.MIN_SPAN, free / span));
        const spare = Math.max(0, free - span * k);
        const top = capH + labelH + spare / 2;
        const yShip = top + LT_HALF * s * k;
        const yStation = yShip + (2 * LT_HALF * s + LN.GAP) * k;
        return { f, k, labelH, yShip, yStation, top, bottom: yStation + LT_HALF * s * k, cx: viewW / 2, P: viewW / k };
    }

    // A lightning bolt from the top of the canvas down to (x, y), fading out.
    function drawBolt(x, y, top, alpha, seed) {
        if (alpha <= 0) return;
        const n = 7;
        ctx.beginPath();
        ctx.moveTo(x + (seed % 2 ? 10 : -10), top);
        for (let i = 1; i < n; i++) {
            const yy = top + (y - top) * i / n;
            const jag = ((i * 37 + seed * 11) % 7 - 3) * 4;
            ctx.lineTo(x + jag, yy);
        }
        ctx.lineTo(x, y);
        ctx.lineJoin = 'round';
        ctx.strokeStyle = `rgba(${pal.chamberLightRGB},${(0.35 * alpha).toFixed(3)})`;
        ctx.lineWidth = 7;
        ctx.stroke();
        ctx.strokeStyle = dark ? `rgba(255,250,225,${alpha.toFixed(3)})` : `rgba(${pal.lightRGB},${alpha.toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineJoin = 'miter';
    }

    // A small four-pointed mark where a strike hit.
    function drawScorch(x, y) {
        ctx.fillStyle = dark ? '#ffe9a8' : '#b8860b';
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x + 1.6, y - 1.6);
        ctx.lineTo(x + 5, y);
        ctx.lineTo(x + 1.6, y + 1.6);
        ctx.lineTo(x, y + 5);
        ctx.lineTo(x - 1.6, y + 1.6);
        ctx.lineTo(x - 5, y);
        ctx.lineTo(x - 1.6, y - 1.6);
        ctx.closePath();
        ctx.fill();
    }

    function drawLightning() {
        const lay = lightningLayout();
        const st = lightningState();
        const k = lay.k, f = lay.f, t = st.t, g = st.g;
        const X = (x) => lay.cx + x * k;
        const hm = homeMoves();
        drawStars(k, lay.P, hm ? st.home.u * (t - st.start) : 0, hm ? g : 1);
        const lightRGB = dark ? pal.chamberLightRGB : pal.lightRGB;
        const y0 = lay.top - 0.04 * k, y1 = lay.bottom + 0.04 * k;
        const yTag = (lay.yShip + lay.yStation) / 2;   // the gap between the lanes

        // Each flash runs both ways along the track at c from where its strike happened in this frame: a front
        // across both lanes, fading once it has passed both detectors.
        st.strikes.forEach((s) => {
            if (t < s.t) return;
            const d = t - s.t;
            const reach = Math.max(Math.abs(st.home.u * t - s.x), Math.abs(st.away.u * t - s.x));
            const a = clamp(1 - (d - reach - 0.3) / 0.8, 0, 1);
            if (a <= 0) return;
            for (const dir of [-1, 1]) {
                const x = X(s.x + dir * d);
                if (x < -10 || x > viewW + 10) continue;
                ctx.strokeStyle = `rgba(${lightRGB},${(0.16 * a).toFixed(3)})`;
                ctx.lineWidth = 8;
                ctx.beginPath();
                ctx.moveTo(x, y0);
                ctx.lineTo(x, y1);
                ctx.stroke();
                ctx.strokeStyle = `rgba(${lightRGB},${(0.9 * a).toFixed(3)})`;
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.globalAlpha = a;
                drawLightTag(x + (dir > 0 ? 4 : -f * 0.75), yTag, f);
                ctx.globalAlpha = 1;
            }
        });

        // The craft, with a detector in each middle, and the marks the strikes left on them
        const lanes = [
            { which: 'away', c: st.away, y: lay.yShip, text: pal.pinkText },
            { which: 'home', c: st.home, y: lay.yStation, text: pal.blueText }
        ];
        for (const lane of lanes) {
            const c = lane.c;
            const sx = c.moving ? 1 / g : 1;
            const xs = X(c.u * t);
            const lit = st.det[lane.which].map((td) => t >= td - 1e-9);
            setCraft(xs, lane.y, k * LN.SIZE * sx, k * LN.SIZE);
            // The ship without its portholes, so the detector takes their place
            if (lane.which === 'away') drawShipBody(true);
            else drawStationBody();
            drawLamps(lit);
            st.strikes.forEach((s, i) => {
                if (t >= s.t) drawScorch(xs + st.own[lane.which][i] * sx * k, lane.y);
            });
            const ext = LT_HALF * LN.SIZE * k;
            const labelY = lane.which === 'away' ? lane.y - ext - lay.labelH / 2 : lane.y + ext + lay.labelH / 2;
            const tag = drawNameTag(xs, labelY, SCENARIOS.lightning[lane.which].name, lane.text, f, c.u);
            const half = (LN.L0 / 2) * sx * k;
            hitRects.push({ x0: Math.min(xs - half, tag.x0) - 6, x1: Math.max(xs + half, tag.x1) + 6,
                y0: Math.min(labelY - f, lane.y - ext), y1: Math.max(labelY + f, lane.y + ext), frame: lane.which });
        }

        // The strikes themselves: a bolt and a burst at the moment each happens
        st.strikes.forEach((s, i) => {
            const age = realNow - ln.struck[i];
            if (t < s.t || age > 0.45 || age < 0) return;
            const a = 1 - age / 0.45;
            const yb = lay.yStation;
            drawBolt(X(s.x), yb, 0, a, i + 1);
            for (const yy of [lay.yShip, lay.yStation]) {
                const glow = ctx.createRadialGradient(X(s.x), yy, 0, X(s.x), yy, 24);
                glow.addColorStop(0, `rgba(255,248,220,${a.toFixed(3)})`);
                glow.addColorStop(1, 'rgba(255,248,220,0)');
                ctx.fillStyle = glow;
                ctx.beginPath();
                ctx.arc(X(s.x), yy, 24, 0, TAU);
                ctx.fill();
            }
        });
        drawScaleBar(k, 'ls', f);
        drawCaption(f);
    }

    // ------------------------------------------------------------------
    // Scene: light clocks
    // ------------------------------------------------------------------
    function clocksLayout() {
        const f = fontPx;
        const ps = pillSize(f);
        const capH = Math.round(f * 2.3);
        const labelH = ps.h + Math.round(f * 0.7);
        const dimH = S.showLengths ? Math.round(f * 2.4) : 0;
        const botH = Math.round(f * 0.6);
        const free = viewH - capH - botH - 2 * (labelH + dimH) - f;
        const k = Math.max(8, Math.min(viewW / LC.MIN_SPAN, free / (2 * LC.HEIGHT)));
        const laneH = labelH + LC.HEIGHT * k + dimH;
        const gap = Math.max(f * 0.5, (viewH - capH - botH - 2 * laneH) / 3);
        const yShip = capH + gap + labelH + LC.HEIGHT * k / 2;
        const yStation = yShip + LC.HEIGHT * k / 2 + dimH + gap + labelH + LC.HEIGHT * k / 2;
        return { f, k, ps, labelH, dimH, yShip, yStation, P: viewW / k, cx: viewW / 2 };
    }

    function drawClocks() {
        const lay = clocksLayout();
        const g = gammaOf(S.v);
        const st = clockState();
        drawStars(lay.k, lay.P, st.home.moving ? lc.xTravel : 0, st.home.moving ? g : 1);
        drawCraftLane('away', st.away, lay.yShip, lay, g);
        drawCraftLane('home', st.home, lay.yStation, lay, g);
        drawScaleBar(lay.k, 'ls', lay.f);
        drawCaption(lay.f);
    }

    function drawCraftLane(which, c, y, lay, g) {
        const k = lay.k, f = lay.f;
        const sx = c.moving ? 1 / g : 1;
        const kx = k * sx;
        const isShip = which === 'away';
        const color = isShip ? pal.pink : pal.blue;
        const textColor = isShip ? pal.pinkText : pal.blueText;
        const sc = SCENARIOS.clocks;
        const name = sc[which].name;
        const trail = isShip ? lc.trailAway : lc.trailHome;
        const flash = clamp(1 - (realNow - (isShip ? lc.flashAway : lc.flashHome)) / 0.45, 0, 1);
        const halfLen = (LC.L0 / 2) * kx;
        const labelY = y - (LC.HEIGHT / 2) * k - lay.labelH / 2 - 1;
        const dir = Math.sign(c.u);
        const arrowLen = clamp(0.3 * k, 26, 64);

        // The moving craft comes round again after one period; its light path may still be fading at the
        // other edge, so the neighbouring copies are drawn too (they are off screen otherwise).
        const per = c.moving ? wrapPeriod(lay) : 0;
        const shifts = c.moving ? [-per, 0, per] : [0];
        const labelW = craftLabelWidth(f, name, 's');
        for (const s of shifts) {
            const xs = lay.cx + (c.x + s) * k;
            const reach = Math.max(halfLen + arrowLen + 12, labelW / 2) + (S.showSync ? labelW : 0) + LC.TRAIL * k;
            if (xs + reach < 0 || xs - reach > viewW) continue;
            const xShift = s;

            setCraft(xs, y, kx, k);
            if (isShip) drawShipBody(true);
            else drawStationBody();
            drawLightClock(lightHeight(c.clock), flash);
            if (S.showPaths) {
                // A moving clock's path leaves its chamber, so it uses the colour that shows on the background.
                const rgb = c.moving ? pal.lightRGB : pal.chamberLightRGB;
                drawTrail(trail, xShift, k, lay.cx, y, lc.T, rgb, Math.max(1.2, k * 0.008));
                drawStrobe(trail, xShift, k, lay.cx, y, lc.T, rgb, Math.max(1.8, k * 0.011));
            }
            const py = y + (LC.MIRROR / 2 - lightHeight(c.clock) * LC.MIRROR) * k;
            const pr = Math.max(2.5, k * 0.022);
            drawPhoton(xs, py, pr, true);
            drawLightTag(xs + pr * 1.6 + 3, py - pr * 1.6, f, true);

            if (c.moving) drawVelocity(xs + dir * (halfLen + 10), y, dir, arrowLen, f, S.v);

            // Name and clock above the craft, with the clocks near each end beside them (simultaneity).
            // While the moving craft crosses an edge the whole group slides along to stay inside the canvas,
            // and fades out as the craft itself leaves.
            const phase = c.clock / LC.TICK;
            const lw = labelW;
            const pw = pillWidth(f, 's', '00.0', true);
            const endOff = [-1, 1].map((side) => side * Math.max(LC.END * kx, lw / 2 + 8 + pw / 2));
            const groupHalf = S.showSync ? Math.max(lw / 2, endOff[1] + pw / 2) : lw / 2;
            let xl = xs;
            let alpha = 1;
            if (c.moving) {
                const margin = 6;
                xl = 2 * (groupHalf + margin) <= viewW ? clamp(xs, groupHalf + margin, viewW - groupHalf - margin) : viewW / 2;
                const span = Math.max(1, 2 * halfLen);
                const seen = clamp((Math.min(xs + halfLen, viewW) - Math.max(xs - halfLen, 0)) / span, 0, 1);
                alpha = clamp((seen - 0.15) / 0.35, 0, 1);
            }
            if (alpha > 0) {
                ctx.globalAlpha = alpha;
                drawCraftLabel(xl, labelY, name, textColor, fmtNum(c.clock), 's', { f, color, phase, flash });
                // Clocks near each end, synchronised in the craft's own frame. Measured from a frame where it
                // moves at u, a clock a distance ξ (own frame) towards the front reads u·ξ/c² less.
                if (S.showSync) {
                    [-1, 1].forEach((side, i) => {
                        const xi = side * LC.END;
                        const reading = c.clock - c.u * xi;
                        const xe = xs + xi * kx;
                        const xp = xl + endOff[i];
                        ctx.strokeStyle = pal.faint;
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.moveTo(xp, labelY + lay.ps.h / 2);
                        ctx.lineTo(xe, y - 0.06 * k);
                        ctx.stroke();
                        drawPill(xp, labelY, fmtNum(Math.max(0, reading)), 's', { f, color, edge: pal.faint, compact: true, template: '00.0' });
                    });
                }
                ctx.globalAlpha = 1;
            }
            if (S.showSync) {
                // Where the end clocks are on the craft
                for (const side of [-1, 1]) {
                    ctx.beginPath();
                    ctx.arc(xs + side * LC.END * kx, y, Math.max(2.5, k * 0.018), 0, TAU);
                    ctx.fillStyle = pal.text;
                    ctx.fill();
                    ctx.strokeStyle = pal.edge;
                    ctx.lineWidth = 1;
                    ctx.stroke();
                }
            }

            if (S.showLengths) {
                const dy = y + (LC.HEIGHT / 2) * k + f * 0.7;
                const len = LC.L0 * sx;
                drawDimension(xs - halfLen, xs + halfLen, dy, `${len.toFixed(2)} ls`, f, c.moving ? textColor : pal.muted);
            }

            hitRects.push({ x0: xs - halfLen - 6, x1: xs + halfLen + 6, y0: labelY - lay.ps.h / 2, y1: y + (LC.HEIGHT / 2) * k, frame: which });
        }
    }

    // ------------------------------------------------------------------
    // Scene: ship in a hangar
    // ------------------------------------------------------------------
    // One lane: the hangar's name and length over it, the ship's under it.
    function hangarLayout() {
        const f = fontPx;
        const capH = Math.round(f * 2.3);
        const tagH = Math.round(f * 1.7);
        const dimH = Math.round(f * 1.7);
        const clockH = S.showSync ? Math.round(f * 2.2) : 0;    // the hangar's door clocks, over the roof
        const botH = Math.round(f * 1.8);
        const H = 2 * (HG.IN + HG.WALL);
        const free = viewH - capH - botH - 2 * (tagH + dimH) - clockH;
        const k = Math.max(8, Math.min(viewW / HG.MIN_SPAN, free / H));
        const y = capH + tagH + dimH + clockH + Math.max(0, free - H * k) / 2 + H * k / 2;
        return { f, k, y, H, tagH, dimH, clockH, cx: viewW / 2, P: viewW / k };
    }

    // The hangar in its own coordinates (set with setCraft): a dark back wall, a roof and a floor that run a
    // little past the doors, and a door at each end that drops from the roof when shut.
    function drawHangar(doors, both, glow) {
        const L = HG.L0 / 2, o = 0.09, w = HG.WALL;
        localRectScaled(-L - 0.02, -HG.IN, L + 0.02, HG.IN, 0.02);
        ctx.fillStyle = dark ? 'rgba(126,202,246,0.07)' : 'rgba(63,136,187,0.08)';
        ctx.fill();
        if (both || glow > 0) {
            ctx.fillStyle = `rgba(123,208,193,${(0.22 * Math.max(both ? 1 : 0, glow)).toFixed(3)})`;
            ctx.fill();
        }
        for (const s of [-1, 1]) {
            const y0 = s > 0 ? HG.IN : -HG.IN - w;
            localRectScaled(-L - o, y0, L + o, y0 + w, 0.025);
            const grad = ctx.createLinearGradient(0, ty(y0), 0, ty(y0 + w));
            grad.addColorStop(0, '#a6dbfa');
            grad.addColorStop(0.55, pal.blue);
            grad.addColorStop(1, '#5fa9d8');
            ctx.fillStyle = grad;
            ctx.fill();
            ctx.strokeStyle = pal.edge;
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        drawDoors(doors, false);
    }

    // The doors: open ones as a stub under the roof (drawn behind the ship), shut ones from roof to floor (in
    // front of it), each flashing as it moves.
    function drawDoors(doors, shut) {
        doors.forEach((door, i) => {
            if (door.shut !== shut) return;
            const side = i === 0 ? -1 : 1;
            const x0 = side * HG.L0 / 2 - (side < 0 ? 0.035 : 0);
            localRectScaled(x0, -HG.IN, x0 + 0.035, -HG.IN + (shut ? 2 * HG.IN : 0.06), 0.01);
            ctx.fillStyle = pal.peri;
            ctx.fill();
            if (door.flash > 0) {
                ctx.fillStyle = `rgba(255,255,255,${(0.6 * door.flash).toFixed(3)})`;
                ctx.fill();
            }
        });
    }

    function drawHangarScene() {
        const lay = hangarLayout();
        const st = hangarState();
        const k = lay.k, f = lay.f, g = st.g, y = lay.y;
        const X = (x) => lay.cx + x * k;
        const hm = homeMoves();
        drawStars(k, lay.P, hm ? st.hangar.x : 0, hm ? g : 1);
        const hx = X(st.hangar.x), sx = X(st.ship.x);
        const hk = k * (hm ? 1 / g : 1);
        const doors = st.doors.map((d, i) => Object.assign({}, d, { flash: clamp(1 - (realNow - hg.slam[i]) / 0.4, 0, 1) }));
        // Glow inside while both doors are shut; it lingers a moment through the pause
        setCraft(hx, y, hk, k);
        drawHangar(doors, st.both, 0);
        setCraft(sx, y, k * (hm ? 1 : 1 / g), k);
        drawShipBody(false);
        // Shut doors in front (they never overlap the ship: each shuts only while the ship is clear of it)
        setCraft(hx, y, hk, k);
        drawDoors(doors, true);

        // Names and measured lengths: the hangar's over it, the ship's under it
        const top = y - (HG.IN + HG.WALL) * k, bot = y + (HG.IN + HG.WALL) * k;
        const hl = st.hangar.length * k / 2, sl = st.ship.length * k / 2;
        const above = top - lay.clockH;
        drawDimension(hx - hl, hx + hl, above - lay.dimH / 2, `${st.hangar.length.toFixed(2)} ls`, f, hm ? pal.blueText : pal.muted, true);
        drawDimension(sx - sl, sx + sl, bot + lay.dimH / 2, `${st.ship.length.toFixed(2)} ls`, f, hm ? pal.muted : pal.pinkText, true);
        const hTag = drawNameTag(hx, above - lay.dimH - lay.tagH / 2, SCENARIOS.hangar.home.name, pal.blueText, f, st.hangar.u);
        const sTag = drawNameTag(sx, bot + lay.dimH + lay.tagH / 2, SCENARIOS.hangar.away.name, pal.pinkText, f, st.ship.u);
        hitRects.push({ x0: Math.min(hx - hl, hTag.x0) - 6, x1: Math.max(hx + hl, hTag.x1) + 6, y0: above - lay.dimH - lay.tagH, y1: top + 4, frame: 'home' });
        hitRects.push({ x0: Math.min(sx - sl, sTag.x0) - 6, x1: Math.max(sx + sl, sTag.x1) + 6, y0: y - LT_HALF * k, y1: bot + lay.dimH + lay.tagH, frame: 'away' });

        // The hangar's clocks beside its doors (synchronised in the hangar's frame)
        if (S.showSync) {
            const pw = pillWidth(f, 's', '\u22120.00', true);
            doors.forEach((door, i) => {
                // Over the roof at its door, nudged apart if the contracted hangar brings them together
                const xd = X(door.x) + (i === 0 ? -1 : 1) * Math.max(0, (pw + 6 - (X(doors[1].x) - X(doors[0].x))) / 2);
                drawPill(clamp(xd, pw / 2 + 4, viewW - pw / 2 - 4), top - lay.clockH / 2, fmtSigned(door.clock), 's',
                    { f, color: pal.blue, edge: door.shut ? pal.peri : pal.faint, compact: true, template: '\u22120.00' });
            });
        }
        drawScaleBar(k, 'ls', f);
        drawCaption(f);
    }

    // ------------------------------------------------------------------
    // Scene: twin paradox
    // ------------------------------------------------------------------
    function twinsLayout() {
        const f = fontPx;
        const k = viewW * 0.74 / TW.D;          // px per light-year
        const rE = clamp(Math.min(viewH * 0.085, viewW * 0.05), 12, 44);
        const yRoute = viewH * 0.6;
        const shipLen = clamp(viewW * 0.09, 44, 120);
        return { f, k, rE, yRoute, shipLen, cx: viewW / 2, P: viewW / k };
    }

    function drawEarth(x, y, r, sx) {
        const rx = Math.max(1, r * sx);
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(x, y, rx, r, 0, 0, TAU);
        ctx.clip();
        // Flat, like the craft: ocean, land, and the night side as a darker crescent
        ctx.fillStyle = pal.earthOcean;
        ctx.fillRect(x - rx, y - r, 2 * rx, 2 * r);
        ctx.fillStyle = pal.teal;
        const blobs = [[-0.35, -0.3, 0.42, 0.3], [0.32, 0.12, 0.38, 0.45], [-0.1, 0.55, 0.3, 0.18], [0.45, -0.55, 0.2, 0.14]];
        for (const b of blobs) {
            ctx.beginPath();
            ctx.ellipse(x + b[0] * rx, y + b[1] * r, b[2] * rx, b[3] * r, 0.4, 0, TAU);
            ctx.fill();
        }
        ctx.beginPath();
        ctx.rect(x - rx, y - r, 2 * rx, 2 * r);
        ctx.ellipse(x - rx * 0.28, y - r * 0.12, rx * 1.02, r * 1.02, 0, 0, TAU, true);
        ctx.fillStyle = 'rgba(10,20,40,0.28)';
        ctx.fill('evenodd');
        ctx.restore();
        ctx.beginPath();
        ctx.ellipse(x, y, rx, r, 0, 0, TAU);
        ctx.strokeStyle = 'rgba(126,202,246,0.5)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    function drawStar(x, y, r, sx) {
        const rx = Math.max(1, r * sx);
        // The glow is only decoration, so it stays round; the star itself is squashed when it moves.
        const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 3);
        glow.addColorStop(0, 'rgba(255,211,107,0.45)');
        glow.addColorStop(1, 'rgba(255,211,107,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, r * 3, 0, TAU);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(x, y, rx, r, 0, 0, TAU);
        ctx.fillStyle = '#ffe3a0';
        ctx.fill();
        ctx.strokeStyle = pal.star;
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // Arrow at the canvas edge pointing to something off screen.
    function drawOffscreen(side, y, text, f) {
        const pad = 8;
        const x = side < 0 ? pad : viewW - pad;
        drawArrow(x - side * 18, y, x, pal.muted, 2);
        setFont(f * 0.9, 700);
        ctx.textAlign = side < 0 ? 'left' : 'right';
        ctx.textBaseline = 'top';
        ctx.fillStyle = pal.muted;
        ctx.fillText(text, x, y + 8);
    }

    function drawTwins() {
        const lay = twinsLayout();
        const f = lay.f, k = lay.k;
        const st = twinState();
        const g = st.g;
        const ship = homeMoves();
        const toX = ship ? (x) => lay.cx + x * k : (x) => lay.cx + (x - TW.D / 2) * k;
        drawStars(k, lay.P, ship ? st.earthX + TW.D / (2 * g) : 0, ship ? g : 1);

        const xE = toX(st.earthX), xS = toX(st.starX), xShip = toX(st.shipX);
        const homeSx = ship ? 1 / g : 1;
        const y = lay.yRoute;

        // Route between Earth and the star, with its measured length
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = pal.faint;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(xE, y);
        ctx.lineTo(xS, y);
        ctx.stroke();
        ctx.setLineDash([]);
        const dimY = y + lay.rE + f * 3.6;
        drawDimension(xE, xS, dimY, `${st.dist.toFixed(2)} ly`, f, ship ? pal.blueText : pal.muted);
        const moving = tw.stage === 'out' || tw.stage === 'back';

        drawStar(xS, y, lay.rE * 0.62, homeSx);
        drawEarth(xE, y, lay.rE, homeSx);

        // Earth twin's age under Earth; the star's name under the star
        const ageTemplate = '000.0';
        drawCraftLabel(xE, y + lay.rE + f * 1.5, 'Earth twin', pal.blueText, fmtNum(st.earthAge), 'yr', { f, color: pal.blue, phase: st.earthAge, template: ageTemplate, flash: tw.stage === 'turn' ? 0.6 : 0, keepInside: true });
        setFont(f * 0.95, 700);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = pal.muted;
        const starName = 'Proxima Centauri';
        const snw = textW(starName, f * 0.95, 700);
        // Where both labels actually sit (each is kept inside the canvas)
        const ew = craftLabelWidth(f, 'Earth twin', 'yr', ageTemplate);
        const xEl = clamp(xE, ew / 2 + 6, viewW - ew / 2 - 6), xSl = clamp(xS, snw / 2 + 6, viewW - snw / 2 - 6);
        const crowded = Math.abs(xSl - xEl) < ew / 2 + snw / 2 + 12;
        ctx.fillText(starName, xSl, crowded ? y - lay.rE - f * 0.9 : y + lay.rE + f * 1.5);

        // Earth and the star move together when measured from the ship: one arrow on the route between them
        const arrowLen = clamp(0.06 * viewW, 26, 60);
        if (ship && st.homeU !== 0 && moving) {
            const dir = Math.sign(st.homeU);
            drawVelocity((xE + xS) / 2 - dir * arrowLen / 2, y - f * 0.6, dir, arrowLen, f, S.v);
        }

        // The ship, flying just above the route, nose towards where it is heading
        const sx = ship ? 1 : 1 / g;
        const shipY = y - lay.rE - lay.shipLen * 0.42;
        const kk = lay.shipLen / LC.L0;
        setCraft(xShip, shipY, st.facing * kk * sx, kk);
        drawShipBody(false);
        if (!ship && S.v > 0 && moving) {
            const dir = Math.sign(st.shipU) || 1;
            drawVelocity(xShip + dir * (lay.shipLen / 2 * sx + 8), shipY, dir, arrowLen, f, S.v);
        }
        drawCraftLabel(xShip, shipY - lay.shipLen * 0.42 - f * 1.1, 'Traveller', pal.pinkText, fmtNum(st.shipAge), 'yr', { f, color: pal.pink, phase: st.shipAge, template: ageTemplate, keepInside: true });
        hitRects.push({ x0: xShip - lay.shipLen / 2, x1: xShip + lay.shipLen / 2, y0: shipY - lay.shipLen * 0.5 - f * 2, y1: shipY + lay.shipLen * 0.3, frame: 'away' });
        hitRects.push({ x0: xE - lay.rE - 6, x1: xE + lay.rE + 6, y0: y - lay.rE - 6, y1: y + lay.rE + f * 2.4, frame: 'home' });

        if (ship) {
            if (xE < -lay.rE) drawOffscreen(-1, y, `Earth ${Math.abs(st.earthX).toFixed(1)} ly`, f);
            if (xS > viewW + lay.rE) drawOffscreen(1, y, `Star ${Math.abs(st.starX).toFixed(1)} ly`, f);
        }

        drawCaption(f);
    }

    // ------------------------------------------------------------------
    // Scene: muons
    // ------------------------------------------------------------------
    function muonsLayout() {
        const f = fontPx;
        const top = Math.round(f * 4.4);
        const band = Math.max(f * 2.6, viewH * 0.12);     // ground strip under the full fall
        const yGround = viewH - band;
        const k = (yGround - top) / MU.H;      // px per km measured from Earth
        const dimX = Math.round(f * 1.1);
        const labelW = textW('15.0 km', f * 0.9, 700);
        return { f, top, band, yGround, k, dimX, x0: dimX + labelW + f * 1.6, x1: viewW - f * 1.2 };
    }

    // Vertical dimension line from y0 to y1 at x, with its length written beside it (clamped to the canvas).
    function drawVDimension(x, y0, y1, text, f, color) {
        const tick = Math.max(4, f * 0.4);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
        for (const y of [y0, y1]) {
            if (y < -2 || y > viewH + 2) continue;
            ctx.moveTo(x - tick, y);
            ctx.lineTo(x + tick, y);
        }
        ctx.stroke();
        const ym = clamp((Math.max(y0, 0) + Math.min(y1, viewH)) / 2, f * 3.2, viewH - f);
        setFont(f * 0.9, 700);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3;
        ctx.strokeStyle = pal.bg;
        ctx.strokeText(text, x + tick + 3, ym);
        ctx.fillStyle = color;
        ctx.fillText(text, x + tick + 3, ym);
        ctx.lineJoin = 'miter';
    }

    function drawMuons() {
        const lay = muonsLayout();
        const f = lay.f;
        const g = gammaOf(S.v);
        const v = S.v;
        const ship = homeMoves();
        const tau = muonClock();
        const zoom = muonZoom();
        const k = lay.k * zoom;                 // px per km in the shown frame
        const thick = ship ? MU.H / g : MU.H;   // the atmosphere's thickness, measured in the shown frame
        // Where the ground is (px) and how high the muons are, measured in the shown frame
        let yMu, yGround;
        if (!ship) {
            yGround = lay.yGround;
            yMu = lay.top + Math.min(MU.H, v * C_KM_US * mu.t) * k;
        } else {
            yMu = lay.top;
            yGround = lay.top + Math.max(0, thick - v * C_KM_US * mu.t) * k;
        }
        const yTopAtm = yGround - thick * k;

        // Sky: the atmosphere's haze between its top and the ground, then a strip of ground fading out below
        const sky = ctx.createLinearGradient(0, yTopAtm, 0, yGround);
        sky.addColorStop(0, `rgba(${pal.skyRGB},0)`);
        sky.addColorStop(1, `rgba(${pal.skyRGB},${dark ? 0.2 : 0.28})`);
        ctx.fillStyle = sky;
        ctx.fillRect(0, yTopAtm, viewW, yGround - yTopAtm);
        const soil = ctx.createLinearGradient(0, yGround, 0, yGround + lay.band * 1.6);
        soil.addColorStop(0, pal.ground);
        soil.addColorStop(0.6, pal.ground);
        soil.addColorStop(1, pal.bg);
        ctx.fillStyle = soil;
        ctx.fillRect(0, yGround, viewW, lay.band * 1.6);
        ctx.strokeStyle = pal.groundLine;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, yGround);
        ctx.lineTo(viewW, yGround);
        ctx.stroke();

        // Top of the atmosphere, where cosmic rays make the muons
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = pal.faint;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(lay.dimX, yTopAtm);
        ctx.lineTo(viewW, yTopAtm);
        ctx.stroke();
        ctx.setLineDash([]);

        // The atmosphere's thickness as measured in this frame: the scale of the view
        drawVDimension(lay.dimX, yTopAtm, yGround, `${thick < 9.995 ? thick.toFixed(2) : thick.toFixed(1)} km`, f, ship ? pal.blueText : pal.muted);

        // The muons
        const r = clamp(f * 0.36, 3, 6);
        const span = lay.x1 - lay.x0;
        for (let i = 0; i < MU.N; i++) {
            const x = lay.x0 + mu.x[i] * span;
            if (mu.life[i] > tau) {
                const glow = ctx.createRadialGradient(x, yMu, 0, x, yMu, r * 2.6);
                glow.addColorStop(0, 'rgba(174,133,202,0.55)');
                glow.addColorStop(1, 'rgba(174,133,202,0)');
                ctx.fillStyle = glow;
                ctx.beginPath();
                ctx.arc(x, yMu, r * 2.6, 0, TAU);
                ctx.fill();
                ctx.fillStyle = pal.muon;
                ctx.beginPath();
                ctx.arc(x, yMu, r, 0, TAU);
                ctx.fill();
            } else if (mu.decayedAt[i] >= 0) {
                // Decay: a ring that spreads and fades where the muon was
                const age = realNow - mu.decayedAt[i];
                const yd = ship ? lay.top : lay.top + Math.min(MU.H, v * C_KM_US * g * mu.life[i]) * k;
                if (age < 0.7) {
                    ctx.strokeStyle = `rgba(174,133,202,${(0.8 * (1 - age / 0.7)).toFixed(3)})`;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(x, yd, r + age * 26, 0, TAU);
                    ctx.stroke();
                }
                ctx.fillStyle = pal.faint;
                ctx.fillRect(x - 1, yd - 1, 2, 2);
            }
        }

        // Clocks: the muons' own clock next to the row; Earth's clock on the ground (Earth's frame only)
        const tpl = '00.0';
        const pw = craftLabelWidth(f, 'Muons', 'µs', tpl);
        drawCraftLabel(viewW - f * 0.8 - pw / 2, yMu - r * 2.6 - f * 1.1, 'Muons', pal.purpleText, fmtNum(tau), 'µs', { f, color: pal.purple, phase: tau, template: tpl });
        const yLabel = yGround + clamp(lay.band / 2, f * 1.3, f * 2);
        if (!ship) {
            const ew = craftLabelWidth(f, 'Earth', 'µs', tpl);
            drawCraftLabel(lay.x0 + ew / 2, yLabel, 'Earth', pal.blueText, fmtNum(mu.t), 'µs', { f, color: pal.blue, phase: mu.t, template: tpl });
        } else if (yLabel < viewH - f * 0.5) {
            // Earth moves up at v: an arrow and its speed on the ground
            setFont(f * 0.95, 700);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = pal.blueText;
            ctx.fillText('Earth', lay.x0, yLabel);
            const xa = lay.x0 + textW('Earth ', f * 0.95, 700) + 4;
            ctx.strokeStyle = pal.muted;
            ctx.fillStyle = pal.muted;
            ctx.lineWidth = Math.max(1.5, f * 0.13);
            ctx.beginPath();
            ctx.moveTo(xa, yLabel + f * 0.55);
            ctx.lineTo(xa, yLabel - f * 0.25);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(xa, yLabel - f * 0.65);
            ctx.lineTo(xa - f * 0.3, yLabel - f * 0.15);
            ctx.lineTo(xa + f * 0.3, yLabel - f * 0.15);
            ctx.closePath();
            ctx.fill();
            setFont(f * 0.92, 700);
            ctx.fillText(`${fmtV(S.v)} c`, xa + f * 0.6, yLabel);
        }
        hitRects.push({ x0: lay.x0, x1: lay.x1, y0: yMu - 14, y1: yMu + 14, frame: 'away' });
        hitRects.push({ x0: 0, x1: viewW, y0: yGround, y1: viewH, frame: 'home' });

        // Measured from the muons the view is zoomed in and slowed down by γ: say so, quietly
        if (ship && g > 1.005) {
            setFont(f * 0.88, 400);
            ctx.fillStyle = pal.muted;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText(`Zoom ×${fmtTimes(g)} · time ×${fmtTimes(g)} slower`, viewW - 10, viewH - 8);
        }
        drawCaption(f);
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------
    function render() {
        if (viewW === 0 || viewH === 0) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = pal.bg;
        ctx.fillRect(0, 0, viewW, viewH);
        hitRects.length = 0;
        SCENE[S.scenario].draw();
    }

    // ------------------------------------------------------------------
    // Readouts (fixed-width formatting to match --chars in the HTML)
    // ------------------------------------------------------------------
    const lastText = new Map();
    function setText(el, text) {
        if (!el || lastText.get(el) === text) return;
        lastText.set(el, text);
        el.textContent = text;
    }

    function readoutRows() {
        const g = gammaOf(S.v);
        if (S.scenario === 'light') {
            const st = lightState();
            return [
                { label: 'Station\u2019s probe:', value: fmtU(st.probe.home), unit: 'c', color: pal.blue },
                { label: 'Ship\u2019s probe:', value: fmtU(st.probe.away), unit: 'c', color: pal.pink },
                { label: 'Both flashes:', value: fmtU(1), unit: 'c' }
            ];
        }
        if (S.scenario === 'lightning') {
            const st = lightningState();
            // Each craft's clock in its middle reads zero as the middles pass (t = 0)
            const clock = (c) => (c.moving ? st.t / st.g : st.t);
            return [
                { label: 'Station clock:', value: fmtNum(clock(st.home)), unit: 's', color: pal.blue },
                { label: 'Ship clock:', value: fmtNum(clock(st.away)), unit: 's', color: pal.pink },
                { label: 'Strikes apart:', value: Math.abs(st.strikes[0].t - st.strikes[1].t).toFixed(2), unit: 's' }
            ];
        }
        if (S.scenario === 'clocks') {
            const st = clockState();
            const movingName = st.away.moving ? 'Ship' : 'Station';
            return [
                { label: 'Station clock:', value: fmtNum(st.home.clock), unit: 's', color: pal.blue },
                { label: 'Ship clock:', value: fmtNum(st.away.clock), unit: 's', color: pal.pink },
                { label: `${movingName} length:`, value: (LC.L0 / g).toFixed(2), unit: 'ls' }
            ];
        }
        if (S.scenario === 'hangar') {
            const st = hangarState();
            return [
                { label: 'Ship length:', value: st.ship.length.toFixed(2), unit: 'ls', color: pal.pink },
                { label: 'Hangar length:', value: st.hangar.length.toFixed(2), unit: 'ls', color: pal.blue },
                { label: 'Both doors shut:', value: st.shutFor > 0 ? st.shutFor.toFixed(2) : 'never', unit: st.shutFor > 0 ? 's' : '' }
            ];
        }
        if (S.scenario === 'twins') {
            const st = twinState();
            return [
                { label: 'Earth twin:', value: fmtNum(st.earthAge), unit: 'yr', color: pal.blue },
                { label: 'Traveller:', value: fmtNum(st.shipAge), unit: 'yr', color: pal.pink },
                { label: 'Distance:', value: st.dist.toFixed(2), unit: 'ly' }
            ];
        }
        const first = homeMoves()
            ? { label: 'Atmosphere:', value: (MU.H / g).toFixed(2), unit: 'km', color: pal.blue }
            : { label: 'Earth clock:', value: fmtNum(mu.t), unit: 'µs', color: pal.blue };
        return [
            first,
            { label: 'Muon clock:', value: fmtNum(muonClock()), unit: 'µs', color: pal.purple },
            { label: 'Muons left:', value: String(muonsLeft()), unit: `of ${MU.N}` }
        ];
    }

    function updateReadouts() {
        setText(ui.statGamma, fmtGamma(gammaOf(S.v)));
        const rows = readoutRows();
        rows.forEach((row, i) => {
            const st = ui.stats[i];
            if (!st) return;
            setText(st.label, row.label);
            setText(st.value, row.value);
            setText(st.unit, row.unit);
            if (st.dot) {
                st.dot.style.display = row.color ? '' : 'none';
                if (row.color && st.dot.style.color !== row.color) st.dot.style.color = row.color;
            }
        });
    }

    // ------------------------------------------------------------------
    // Charts: the two clocks against time, and γ against speed
    // ------------------------------------------------------------------
    let charts = null;
    let chartTimer = 0;
    const CHART_MAX = 400;

    function chartColors() {
        return { text: dark ? '#e0e0e0' : '#585858', grid: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' };
    }

    // The first graph's lines for each scenario (up to four), its time unit and its y-axis title.
    function chartSpec() {
        const lightCol = dark ? '#ffd65c' : '#d69b00';
        if (S.scenario === 'light') {
            return { t: 's', y: 'Distance travelled (ls)', lines: [
                { label: 'Station\u2019s flash', color: lightCol },
                { label: 'Ship\u2019s flash', color: lightCol, dash: [6, 5] },
                { label: 'Station\u2019s probe', color: '#7ecaf6' },
                { label: 'Ship\u2019s probe', color: '#f2849e' }
            ] };
        }
        if (S.scenario === 'lightning') return { t: 's', y: 'Clock time since the first strike (s)', lines: [{ label: 'Station clock', color: '#7ecaf6' }, { label: 'Ship clock', color: '#f2849e' }] };
        if (S.scenario === 'clocks') return { t: 's', y: 'Clock reading (s)', lines: [{ label: 'Station clock', color: '#7ecaf6' }, { label: 'Ship clock', color: '#f2849e' }] };
        if (S.scenario === 'hangar') return { t: 's', y: 'Clock reading (s)', lines: [{ label: 'Hangar clock', color: '#7ecaf6' }, { label: 'Ship clock', color: '#f2849e' }] };
        if (S.scenario === 'twins') return { t: 'years', y: 'Age gained (years)', lines: [{ label: 'Earth twin', color: '#7ecaf6' }, { label: 'Traveller', color: '#f2849e' }] };
        return { t: '\u00b5s', y: 'Muons left', lines: [{ label: 'Muons left', color: '#ae85ca' }] };
    }

    function chartsVisible() {
        return !!(charts && ui.chartsContainer && ui.chartsContainer.style.display !== 'none');
    }

    function makeCharts() {
        if (typeof Chart === 'undefined') return null;
        const c = chartColors();
        const scaleOpts = (title) => ({
            type: 'linear',
            ticks: { color: c.text, maxTicksLimit: 6 },
            grid: { color: c.grid },
            title: { display: true, text: title, color: c.text }
        });
        const clockEl = byId('clockChart'), gammaEl = byId('gammaChart');
        const clock = clockEl ? new Chart(clockEl, {
            type: 'line',
            data: {
                datasets: [0, 1, 2, 3].map(() => ({ label: '', data: [], borderWidth: 2, pointRadius: 0, tension: 0 }))
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false, parsing: false, normalized: true,
                plugins: { legend: { labels: { color: c.text, boxWidth: 12 } }, tooltip: { enabled: false } },
                scales: { x: Object.assign(scaleOpts('Time'), { min: 0 }), y: Object.assign(scaleOpts('Reading'), { min: 0 }) }
            }
        }) : null;
        const curve = [];
        for (let i = 0; i <= 130; i++) {
            const v = speedFromStep(i);
            curve.push({ x: v, y: gammaOf(v) });
        }
        const gamma = gammaEl ? new Chart(gammaEl, {
            type: 'scatter',
            data: {
                datasets: [
                    { label: 'γ = 1/√(1 − v²/c²)', data: curve, showLine: true, borderColor: '#ae85ca', backgroundColor: '#ae85ca', borderWidth: 2, pointRadius: 0 },
                    { label: 'Now', data: [{ x: S.v, y: gammaOf(S.v) }], borderColor: '#f2849e', backgroundColor: '#f2849e', pointRadius: 6, pointHoverRadius: 6 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                plugins: { legend: { labels: { color: c.text, boxWidth: 12 } }, tooltip: { enabled: false } },
                scales: {
                    x: Object.assign(scaleOpts('Speed (fraction of c)'), { min: 0, max: 1 }),
                    y: Object.assign(scaleOpts('Lorentz factor γ'), { min: 1 })
                }
            }
        }) : null;
        return { clock, gamma };
    }

    function updateChartLabels() {
        if (!charts || !charts.clock) return;
        const spec = chartSpec();
        const sc = SCENARIOS[S.scenario];
        const ch = charts.clock;
        ch.data.datasets.forEach((d, i) => {
            const line = spec.lines[i];
            d.label = line ? line.label : '';
            d.hidden = !line;
            d.borderColor = d.backgroundColor = line ? line.color : '#888';
            d.borderDash = line && line.dash ? line.dash : [];
        });
        ch.options.plugins.legend.labels.filter = (item) => !!item.text;
        ch.options.scales.x.title.text = `Time measured from ${sc[S.frame].the} (${spec.t})`;
        ch.options.scales.y.title.text = spec.y;
        ch.update('none');
    }

    function updateGammaChart() {
        if (!charts || !charts.gamma) return;
        const g = gammaOf(S.v);
        charts.gamma.data.datasets[1].data = [{ x: S.v, y: g }];
        charts.gamma.options.scales.y.max = Math.max(5, Math.ceil(g * 1.15));
        charts.gamma.update('none');
    }

    function resetChartData() {
        chartTimer = 0;
        if (!charts || !charts.clock) return;
        charts.clock.data.datasets.forEach((d) => { d.data = []; });
        charts.clock.update('none');
    }

    function sampleCharts(dtReal) {
        if (!chartsVisible() || !charts.clock) return;
        chartTimer -= dtReal;
        if (chartTimer > 0) return;
        chartTimer = 0.2;
        const sample = SCENE[S.scenario].chart();
        if (!sample) return;
        const t = sample[0], values = sample.slice(1);
        const ds = charts.clock.data.datasets;
        const last = ds[0].data[ds[0].data.length - 1];
        if (last && last.x === t) return;
        values.forEach((y, i) => ds[i].data.push({ x: t, y }));
        // Long runs: keep every other point, so the whole history stays on the graph.
        ds.forEach((d) => {
            if (d.data.length > CHART_MAX) d.data = d.data.filter((p, i) => i % 2 === 0 || i === d.data.length - 1);
        });
        charts.clock.update('none');
    }

    function recolorCharts() {
        const c = chartColors();
        [charts.clock, charts.gamma].forEach((chart) => {
            if (!chart) return;
            chart.options.plugins.legend.labels.color = c.text;
            ['x', 'y'].forEach((axis) => {
                chart.options.scales[axis].ticks.color = c.text;
                chart.options.scales[axis].grid.color = c.grid;
                chart.options.scales[axis].title.color = c.text;
            });
            chart.update('none');
        });
    }

    function setChartsVisible(visible) {
        if (!ui.chartsContainer) return;
        ui.chartsContainer.style.display = visible ? 'block' : 'none';
        document.body.classList.toggle('charts-visible', visible);
        if (visible && !charts) {
            charts = makeCharts();
            updateChartLabels();
            updateGammaChart();
        }
        if (visible) chartTimer = 0;
    }

    // ------------------------------------------------------------------
    // Canvas sizing
    // ------------------------------------------------------------------
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
        fontPx = clamp(Math.min(viewW / 78, viewH / 30), 11, 15);
        render();
    }

    // ------------------------------------------------------------------
    // Input: tap or click a craft to measure from it
    // ------------------------------------------------------------------
    function hitAt(e) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        for (let i = hitRects.length - 1; i >= 0; i--) {
            const r = hitRects[i];
            if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return r.frame;
        }
        return null;
    }

    canvas.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse') return;
        const f = hitAt(e);
        const target = f && f !== S.frame ? f : null;
        if (target === hoverFrame) return;
        hoverFrame = target;
        canvas.classList.toggle('rel-can-click', !!target);
        canvas.title = target ? `Measure from ${SCENARIOS[S.scenario][target].the}` : '';
    });
    canvas.addEventListener('pointerleave', () => {
        hoverFrame = null;
        canvas.classList.remove('rel-can-click');
        canvas.title = '';
    });
    canvas.addEventListener('click', (e) => {
        const f = hitAt(e);
        if (f && f !== S.frame) {
            setFrame(f);
            hoverFrame = null;
            canvas.classList.remove('rel-can-click');
            canvas.title = '';
        }
    });

    // ------------------------------------------------------------------
    // Controls
    // ------------------------------------------------------------------
    function bindControls() {
        if (ui.speed) {
            const apply = () => {
                S.speed = parseFloat(ui.speed.value) || 1;
                setText(ui.speedVal, S.speed.toFixed(1));
            };
            ui.speed.addEventListener('input', apply);
            apply();
        }
        if (ui.velocity) {
            ui.velocity.addEventListener('input', () => setVelocity(speedFromStep(parseInt(ui.velocity.value, 10)), true));
        }
        ui.frameBtns.forEach((btn) => {
            btn.addEventListener('click', () => setFrame(btn.dataset.frame));
            // Arrow keys move between the two options, as in a radio group.
            btn.addEventListener('keydown', (e) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
                e.preventDefault();
                const next = S.frame === 'home' ? 'away' : 'home';
                setFrame(next);
                const nb = ui.frameBtns.find((b) => b.dataset.frame === next);
                if (nb) nb.focus();
            });
        });
        if (ui.scenario) ui.scenario.addEventListener('change', () => setScenario(ui.scenario.value));
        const toggle = (el, key, after) => {
            if (!el) return;
            S[key] = el.checked;
            el.addEventListener('change', () => {
                S[key] = el.checked;
                if (after) after();
            });
        };
        ui.toggles.forEach((t) => toggle(t.input, `show${t.key[0].toUpperCase()}${t.key.slice(1)}`));
        if (ui.probe) {
            const apply = () => {
                S.probeU = clamp(parseFloat(ui.probe.value) || 0, 0, 0.99);
                setText(ui.probeVal, S.probeU.toFixed(2));
            };
            ui.probe.addEventListener('input', () => {
                apply();
                updateReadouts();
            });
            apply();
        }
        if (ui.showCharts) {
            ui.showCharts.addEventListener('change', () => setChartsVisible(ui.showCharts.checked));
            setChartsVisible(ui.showCharts.checked);
        }
        if (ui.reset) ui.reset.addEventListener('click', () => resetScenario(true));
    }

    // ------------------------------------------------------------------
    // Main loop (exactly one)
    // ------------------------------------------------------------------
    const MAX_FRAME_DT = 0.1;
    let lastTimestamp = 0;
    let fpsFrames = 0, fpsTime = 0;

    // Each scenario's steps: reset, advance by dt (frame time) and dtReal (real seconds), draw, and the first
    // graph's sample ([time, value per line], or null for none).
    const SCENE = {
        light: { reset: resetLight, step: stepLight, draw: drawLight,
            chart: () => {
                if (lt.t < 0) return null;
                const st = lightState();
                return [lt.t, lt.t, lt.t, st.probe.home * lt.t, st.probe.away * lt.t];
            } },
        lightning: { reset: resetLightning, step: stepLightning, draw: drawLightning,
            chart: () => {
                // From the first strike: the time passed on each craft's middle clock
                const st = lightningState();
                const t0 = Math.min(st.strikes[0].t, st.strikes[1].t);
                if (ln.t < t0) return null;
                const dt = ln.t - t0;
                return [dt, homeMoves() ? dt / st.g : dt, homeMoves() ? dt : dt / st.g];
            } },
        clocks: { reset: resetClocks, draw: drawClocks,
            step: (dt) => {
                // Small steps keep the light's zig-zag corners exact even at high playback speeds.
                const n = Math.max(1, Math.ceil(dt / 0.05));
                for (let i = 0; i < n; i++) stepClocks(dt / n);
            },
            chart: () => {
                const st = clockState();
                return [lc.T, st.home.clock, st.away.clock];
            } },
        hangar: { reset: resetHangar, step: stepHangar, draw: drawHangarScene,
            chart: () => {
                // Each middle clock reads zero as the middles pass
                const st = hangarState();
                return [hg.t - st.start, homeMoves() ? hg.t / st.g : hg.t, homeMoves() ? hg.t : hg.t / st.g];
            } },
        twins: { reset: resetTwins, step: stepTwins, draw: drawTwins,
            chart: () => {
                const st = twinState();
                return [tw.t, st.earthAge, st.shipAge];
            } },
        muons: { reset: resetMuons, step: stepMuons, draw: drawMuons, chart: () => [mu.t, muonsLeft()] }
    };

    function rate() {
        if (S.scenario === 'twins') return TW.RATE;
        if (S.scenario === 'lightning') return LN.RATE;
        if (S.scenario === 'muons') return MU.RATE / (homeMoves() ? gammaOf(S.v) : 1);
        return 1;
    }

    function advance(dtReal) {
        SCENE[S.scenario].step(dtReal * S.speed * rate(), dtReal);
    }

    function frame(timestamp) {
        const dtReal = lastTimestamp ? Math.min(MAX_FRAME_DT, (timestamp - lastTimestamp) / 1000) : 0;
        lastTimestamp = timestamp;
        realNow = timestamp / 1000;
        if (!testPaused) advance(dtReal);
        render();
        updateReadouts();
        sampleCharts(dtReal);

        if (ui.fps) {
            fpsFrames++;
            fpsTime += dtReal;
            if (fpsTime >= 0.5) {
                ui.fps.textContent = `FPS: ${Math.round(fpsFrames / fpsTime)}`;
                fpsFrames = 0;
                fpsTime = 0;
            }
        }
        requestAnimationFrame(frame);
    }

    // ------------------------------------------------------------------
    // Public API (used by the reset button; handy for testing)
    // ------------------------------------------------------------------
    window.relativitySimulation = {
        reset: () => resetScenario(true),
        setScenario,
        setFrame,
        setVelocity: (v) => setVelocity(v, false),
        // Stop (or restart) the clock-driven stepping, and step by hand (in seconds of real time at 1x).
        pause: (on) => { testPaused = on !== false; },
        showCaptions: (on) => { captionsOn = on !== false; },
        advance: (realSeconds) => {
            const n = Math.max(1, Math.ceil(realSeconds / 0.02));
            for (let i = 0; i < n; i++) advance(realSeconds / n);
            render();
            updateReadouts();
        },
        speedFromStep,
        stepFromSpeed,
        getState: () => {
            const g = gammaOf(S.v);
            const out = { scenario: S.scenario, frame: S.frame, v: S.v, gamma: g, view: { w: viewW, h: viewH, dpr, fontPx } };
            if (S.scenario === 'light') {
                const lay = lightLayout();
                const st = lightState();
                // Screen positions (CSS px) of the flashes and probes, so their speeds can be measured
                const X = (x) => lay.x0 + x * lay.k;
                Object.assign(out, {
                    t: lt.t, k: lay.k, x0: lay.x0, light: lightState(),
                    screen: { flash: X(Math.max(0, lt.t)), probeHome: X(st.probe.home * Math.max(0, lt.t)), probeAway: X(st.probe.away * Math.max(0, lt.t)),
                        homeX: X(st.home.x), awayX: X(st.away.x) }
                });
            } else if (S.scenario === 'hangar') {
                const lay = hangarLayout();
                Object.assign(out, { t: hg.t, k: lay.k, cx: lay.cx, hold: hg.hold, hangar: hangarState() });
            } else if (S.scenario === 'lightning') {
                const lay = lightningLayout();
                const st = lightningState();
                // Screen positions (CSS px) of each flash's two fronts, so their speed can be measured
                const fronts = st.strikes.map((s) => (ln.t < s.t ? null : [-1, 1].map((d) => lay.cx + (s.x + d * (ln.t - s.t)) * lay.k)));
                Object.assign(out, { t: ln.t, k: lay.k, cx: lay.cx, lightning: st, fronts });
            } else if (S.scenario === 'clocks') {
                const lay = clocksLayout();
                const st = clockState();
                // Light pulses in CSS px, with the moving craft not wrapped, so speeds can be measured.
                const pulse = (c, y) => ({ x: lay.cx + (c.moving ? lc.xTravel : 0) * lay.k, y: y + (LC.MIRROR / 2 - lightHeight(c.clock) * LC.MIRROR) * lay.k });
                Object.assign(out, {
                    T: lc.T, k: lay.k, P: lay.P,
                    home: Object.assign({}, st.home, { length: LC.L0 / (st.home.moving ? g : 1), pulse: pulse(st.home, lay.yStation),
                        ends: [-1, 1].map((s) => st.home.clock - st.home.u * s * LC.END) }),
                    away: Object.assign({}, st.away, { length: LC.L0 / (st.away.moving ? g : 1), pulse: pulse(st.away, lay.yShip),
                        ends: [-1, 1].map((s) => st.away.clock - st.away.u * s * LC.END) }),
                    endSeparation: 2 * LC.END
                });
            } else if (S.scenario === 'twins') {
                Object.assign(out, { t: tw.t, stage: tw.stage, twin: twinState(), times: twinTimes() });
            } else {
                const lay = muonsLayout();
                Object.assign(out, { t: mu.t, stage: mu.stage, muonClock: muonClock(), left: muonsLeft(), times: muonTimes(), lifetimes: Array.from(mu.life),
                    zoom: muonZoom(), kmPx: lay.k * muonZoom(), rate: rate() });
            }
            out.readouts = readoutRows().map((r) => `${r.label} ${r.value} ${r.unit}`);
            out.gammaText = fmtGamma(g);
            out.hitRects = hitRects.map((r) => Object.assign({}, r));
            return out;
        }
    };

    // --- Start ---
    function start() {
        refreshPalette();
        bindControls();
        syncFrameButtons();
        if (ui.scenario) S.scenario = ui.scenario.value || 'light';
        resizeCanvas();
        setScenario(S.scenario);
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resizeCanvas).observe(canvas);
        window.addEventListener('resize', resizeCanvas);
        new MutationObserver(refreshPalette).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render()).catch(() => {});
        requestAnimationFrame(frame);
    }

    start();
})();
