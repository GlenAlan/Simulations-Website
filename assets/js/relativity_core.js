/*
 * Special Relativity simulation: time dilation, length contraction and the relativity of simultaneity.
 *
 * Everything on the canvas is what is *measured* in one inertial frame, picked with "Measured from":
 * where things are at one moment of that frame's time, and what their clocks read at that moment
 * (Lorentz transformations). It is not what a camera would photograph: the time light takes to reach
 * an eye, and the distortions that causes, are left out.
 *
 * Units: c = 1 in the light-clock scenario (light-seconds and seconds) and the twin paradox (light-years
 * and years); kilometres and microseconds for the muons. Within a scenario both frames use the same
 * screen scale and playback rate, so light moves at the same speed on screen in both, and the moving
 * object at v in the same units.
 *
 * Scenarios
 * - Light clocks: a ship and a station with the same rest length, each carrying a light clock (a pulse of
 *   light bouncing between two mirrors 0.5 light-seconds apart, so it ticks once a second). The craft at
 *   rest stays in the middle; the moving one wraps round the edges (as if the track were lined with
 *   identical, synchronised copies of the craft at rest, one per screen width). Both clocks read zero as
 *   the two craft pass each other.
 * - Twin paradox: a return trip to Proxima Centauri (4.24 ly). Measured from the ship (its outbound frame,
 *   then its inbound frame), Earth's clock jumps ahead at the turnaround.
 * - Muons: a batch of muons made 15 km up falls to the ground. Each decays when its own clock reaches a
 *   random lifetime (mean 2.2 µs), so the same muons survive whichever frame the fall is measured from.
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
        showGroup: byId('showGroup'),
        paths: byId('pathsToggle'), lengths: byId('lengthsToggle'), sync: byId('syncToggle'),
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

    // Light clocks (light-seconds and seconds)
    const LC = {
        L0: 1.6,          // rest length of the ship and of the station (ls)
        MIRROR: 0.5,      // mirror separation (ls): half a second up, half a second down
        TICK: 1,          // s per tick
        TRAIL: 2,         // seconds of light path left behind each pulse
        END: 0.62,        // end clocks' distance from the middle, in the craft's own frame (ls)
        HEIGHT: 0.94,     // craft height including fins and solar panels (ls)
        MIN_SPAN: 3.5     // narrowest scene (ls), so a craft at rest never fills more than ~45 % of the width
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
        RATE: 6,          // µs of the shown frame per second at 1x
        END_PAUSE: 5.5    // s (real)
    };

    const SCENARIOS = {
        clocks: {
            home: { name: 'Station', the: 'the station', icon: 'fa-satellite' },
            away: { name: 'Ship', the: 'the ship', icon: 'fa-rocket' },
            v: 0.8,
            hint: 'A ship and a station of the same length each carry a light clock that ticks once a second.',
            aria: 'A spaceship carrying a light clock flies past a space station that carries an identical light clock'
        },
        twins: {
            home: { name: 'Earth', the: 'Earth', icon: 'fa-globe-europe' },
            away: { name: 'Ship', the: 'the ship', icon: 'fa-rocket' },
            v: 0.8,
            hint: 'One twin flies to Proxima Centauri, 4.24 light-years away, and straight back. Who is older when they meet again?',
            aria: 'A spaceship flies from Earth to the star Proxima Centauri and back, with the ages of the twin at home and the travelling twin'
        },
        muons: {
            home: { name: 'Earth', the: 'Earth', icon: 'fa-globe-europe' },
            away: { name: 'Muons', the: 'the muons', icon: 'fa-atom' },
            v: 0.995,
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

    // ------------------------------------------------------------------
    // Settings and state
    // ------------------------------------------------------------------
    const S = {
        scenario: 'clocks',
        frame: 'home',        // 'home': the station / Earth is at rest; 'away': the ship / muons are at rest
        v: 0.8,               // speed of the ship (or muons) relative to home, as a fraction of c
        speed: 1,             // playback speed
        showPaths: true,
        showLengths: false,
        showSync: false
    };

    let viewW = 0, viewH = 0, dpr = 1;
    let fontPx = 13;
    let realNow = 0;          // seconds, for flashes and pauses
    let caption = null;       // { text, until } a short message that replaces the frame caption
    let callout = null;       // { title, text } a boxed message (twin turnaround, results)
    const hitRects = [];      // craft that can be tapped to ride along: { x0, y0, x1, y1, frame }
    let hoverFrame = null;
    let testPaused = false;   // set by the test API: the loop draws but doesn't advance

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

    // Twin paradox
    const tw = { t: 0, stage: 'out', pause: 0, pauseLen: 1 };

    // Muons
    const mu = {
        t: 0,                                   // time measured in the shown frame (µs)
        life: new Float64Array(MU.N),           // each muon's lifetime on its own clock (µs)
        x: new Float64Array(MU.N),              // across the sky (0-1)
        decayedAt: new Float64Array(MU.N),      // real time of the decay flash, or -1
        stage: 'fall', pause: 0
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
            muon: '#c9a5e3', calloutBg: 'rgba(30,32,38,0.94)',
            pinkText: '#f2849e', blueText: '#7ecaf6', purpleText: '#c9a5e3'
        } : {
            bg: '#f4f6f8', text: '#2b2b2b', muted: 'rgba(43,43,43,0.62)', faint: 'rgba(43,43,43,0.2)',
            starRGB: '40,50,70', pillBg: 'rgba(255,255,255,0.9)', pillEdge: 'rgba(0,0,0,0.16)',
            shipShade: '#c75b9b', stationShade: '#4f95c4', panel: '#8499e7', panelGrid: 'rgba(16,20,36,0.45)',
            truss: '#7c8590', edge: 'rgba(0,0,0,0.3)',
            chamber: '#1a1f27', chamberEdge: 'rgba(0,0,0,0.25)', mirror: '#e9eef4',
            photon: '#fff4c4', lightRGB: '214,140,0',
            earthOcean: '#3d86c6', ground: '#cfe3d8', groundLine: '#3f9e8f', skyRGB: '90,160,215',
            muon: '#8a5cb0', calloutBg: 'rgba(255,255,255,0.95)',
            pinkText: '#d4587a', blueText: '#2f84bb', purpleText: '#8a5cb0'
        });
        // The light inside the dark chambers is always the bright yellow.
        pal.chamberLightRGB = '255,214,92';
        if (charts) recolorCharts();
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
        const first = S.showSync ? 'The middle clocks read zero as the ship passes the station' : 'Both clocks read zero as the ship passes the station';
        showCaption(first, 4, firstRun ? ['Each tick is one trip of the light down to the lower mirror and back', 5,
            ['The moving clock\'s light has further to go at the same speed, so it ticks slower', 6]] : undefined);
        firstRun = false;
    }
    let firstRun = true;

    // Period (ls) after which the moving craft comes round again: the screen width plus room for the craft,
    // its arrow and its labels to leave one side completely before they appear at the other.
    function wrapPeriod(lay) {
        const half = (LC.L0 / 2) * lay.k / gammaOf(S.v);
        const label = craftLabelWidth(lay.f, 'Station', 's') / 2;
        const sync = S.showSync ? label + 10 + pillWidth(lay.f, 's', '00.0', true) : 0;
        return lay.P + 2 * (Math.max(half + clamp(0.3 * lay.k, 26, 64) + 12, label, sync) + 4) / lay.k;
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
        callout = null;
        if (S.v < 0.01) showCaption('Choose a speed for the trip', 4);
        else showCaption(homeMoves() ? 'The ship stays put: Earth and the star move instead' : 'The ship sets off from Earth', 3.5);
    }

    function stepTwins(dt, dtReal) {
        if (tw.pause > 0) {
            tw.pause -= dtReal;
            if (tw.pause <= 0) {
                if (tw.stage === 'turn') {
                    tw.stage = 'back';
                    callout = null;
                } else if (tw.stage === 'done') {
                    resetTwins();
                    resetChartData();
                }
            }
            return;
        }
        if (S.v < 0.01 || tw.stage === 'done') return;
        const { g, t1, t2, tau1 } = twinTimes();
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
                const jump = t2 - 2 * tau1 / g;
                callout = {
                    title: 'The ship turns round',
                    text: `Its idea of "now" on Earth jumps ${fmtNum(jump)} years ahead`
                };
                return;
            }
            tw.stage = 'back';
            showCaption('Turning round at Proxima Centauri', 2.5);
        }
        if (tw.t >= end - 1e-12) {
            tw.t = end;
            tw.stage = 'done';
            tw.pause = TW.END_PAUSE;
            const diff = t2 - 2 * tau1;
            callout = {
                title: `Home again: the traveller is ${fmtNum(diff)} years younger`,
                text: `Earth twin aged ${fmtNum(t2)} years, the traveller ${fmtNum(2 * tau1)}`
            };
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
        mu.stage = 'fall';
        mu.pause = 0;
        mu.decayedAt.fill(-1);
        callout = null;
        const g = gammaOf(S.v);
        if (homeMoves()) showCaption('The muons are at rest; the ground rushes up at them', 4);
        else showCaption('A cosmic ray makes a burst of muons 15 km up', 3, [`Measured from Earth, their clocks tick ${fmtTimes(g)} times slower`, 6]);
    }

    function stepMuons(dt, dtReal) {
        if (mu.pause > 0) {
            mu.pause -= dtReal;
            if (mu.pause <= 0 && mu.stage === 'done') {
                resetMuons(true);
                resetChartData();
            }
            return;
        }
        if (mu.stage === 'done') return;
        const { tLand, tauLand, g } = muonTimes();
        const tauBefore = muonClock();
        const end = homeMoves() ? tauLand : tLand;
        mu.t = Math.min(end, mu.t + dt);
        const tau = muonClock();
        for (let i = 0; i < MU.N; i++) {
            if (mu.life[i] > tauBefore && mu.life[i] <= tau) mu.decayedAt[i] = realNow;
        }
        if (mu.t >= end - 1e-12 || muonsLeft() === 0) {
            mu.stage = 'done';
            mu.pause = MU.END_PAUSE;
            const left = muonsLeft();
            const p0 = Math.exp(-tLand / MU.LIFE);   // chance of surviving without time dilation
            const landed = mu.t >= end - 1e-12;
            if (!landed) {
                callout = { title: 'All the muons decayed before reaching the ground', text: ['Try a speed closer to c'] };
            } else if (homeMoves()) {
                callout = {
                    title: `${left} of ${MU.N} muons reached the ground`,
                    text: [`Measured from the muons the atmosphere is only ${(MU.H / g).toFixed(2)} km thick,`,
                        `so the ground reached them after just ${fmtNum(tauLand)} µs`]
                };
            } else {
                callout = {
                    title: `${left} of ${MU.N} muons reached the ground`,
                    text: [`Their clocks ran ${fmtTimes(g)} times slower: only ${fmtNum(tauLand)} µs passed for them`,
                        `Without time dilation only about 1 in ${fmtBig(1 / p0)} would make it`]
                };
            }
        }
    }

    function fmtBig(x) {
        if (!isFinite(x) || x > 1e30) return 'a vast number';
        if (x < 1000) return String(Math.round(x));
        if (x < 1e6) return `${Math.round(x / 1000)} thousand`;
        if (x < 1e9) return `${Math.round(x / 1e6)} million`;
        if (x < 1e12) return `${Math.round(x / 1e9)} billion`;
        const e = Math.floor(Math.log10(x));
        return `${(x / Math.pow(10, e)).toFixed(0)} × 10^${e}`;
    }

    // ------------------------------------------------------------------
    // Shared state changes
    // ------------------------------------------------------------------
    // performance.now() shares its origin with the animation frame timestamps.
    const nowS = () => performance.now() / 1000;

    // A short message in place of the frame caption; `then` is an optional [text, seconds, then] to show after it.
    function showCaption(text, seconds, then) {
        const t = nowS();
        caption = { text, until: t + seconds, from: t, then };
    }

    function resetScenario(freshMuons) {
        callout = null;
        caption = null;
        if (S.scenario === 'clocks') resetClocks();
        else if (S.scenario === 'twins') resetTwins();
        else resetMuons(freshMuons);
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
        // A trip or a fall is planned at one speed: changing it starts again (with the same muons).
        if (S.scenario === 'twins') resetTwins();
        else if (S.scenario === 'muons') resetMuons(false);
        if (S.scenario !== 'clocks') resetChartData();
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
        if (ui.showGroup) ui.showGroup.hidden = name !== 'clocks';
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
        roundRectPath(x0 + 0.5, y0 + 0.5, w - 1, ps.h - 1, ps.h / 2);
        ctx.fillStyle = pal.pillBg;
        ctx.fill();
        ctx.lineWidth = 1 + flash;
        ctx.strokeStyle = flash > 0.02 ? opts.color : (opts.edge || pal.pillEdge);
        ctx.globalAlpha = flash > 0.02 ? 0.4 + 0.6 * flash : 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
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

    // Horizontal dimension line from x0 to x1 with its length written under it.
    function drawDimension(x0, x1, y, text, f, color) {
        const tick = Math.max(4, f * 0.4);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.moveTo(x0, y - tick);
        ctx.lineTo(x0, y + tick);
        ctx.moveTo(x1, y - tick);
        ctx.lineTo(x1, y + tick);
        ctx.stroke();
        setFont(f * 0.95, 700);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = color;
        ctx.fillText(text, (x0 + x1) / 2, y + tick + 2);
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
            for (let j = 0; j < n; j++) {
                const xs = viewW / 2 + (base + j * period) * k;
                if (xs > viewW + 2) break;
                ctx.fillRect(xs - s.r, y - s.r, s.r * 2, s.r * 2);
            }
        }
    }

    // Caption at the top left: which frame the measurements are made from (or a short message).
    function drawCaption(f) {
        const sc = SCENARIOS[S.scenario];
        const side = sc[S.frame];
        const pad = Math.max(8, f * 0.7);
        const y = pad + f * 0.6;
        let alphaMsg = 0;
        if (caption) {
            const left = caption.until - realNow;
            if (left <= 0 && caption.then) {
                const next = caption.then;
                caption = { text: next[0], from: realNow - 1, until: realNow + next[1], then: next[2] };
                alphaMsg = 1;
            } else if (left <= 0) {
                caption = null;
            } else {
                alphaMsg = clamp(Math.min(caption.then ? 1 : left / 0.5, (realNow - caption.from) / 0.3), 0, 1);
            }
        }
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        if (alphaMsg < 1) {
            ctx.globalAlpha = 1 - alphaMsg;
            setFont(f, 400);
            ctx.fillStyle = pal.muted;
            const lead = 'Measured from ';
            ctx.fillText(lead, pad, y);
            setFont(f, 700);
            ctx.fillStyle = S.frame === 'home' ? pal.blueText : (S.scenario === 'muons' ? pal.purpleText : pal.pinkText);
            ctx.fillText(side.the, pad + textW(lead, f, 400), y);
        }
        if (alphaMsg > 0) {
            ctx.globalAlpha = alphaMsg;
            setFont(f, 400);
            ctx.fillStyle = pal.text;
            ctx.fillText(caption.text, pad, y);
        }
        ctx.globalAlpha = 1;
    }

    // A boxed message (twin turnaround, results): a bold title and up to a few lines, centred at (cx, cy).
    // Text shrinks to fit narrow canvases.
    function drawCallout(cx, cy, f, box) {
        box = box || callout;
        if (!box) return;
        const lines = Array.isArray(box.text) ? box.text : box.text ? [box.text] : [];
        const maxW = viewW - 20;
        let f1 = f * 1.12, f2 = f * 0.95;
        const pad = Math.max(8, f * 0.9);
        const wTitle = textW(box.title, f1, 700);
        const wLines = lines.reduce((m, l) => Math.max(m, textW(l, f2, 400)), 0);
        const need = Math.max(wTitle, wLines) + 2 * pad;
        let s = 1;
        if (need > maxW) {
            s = maxW / need;
            f1 *= s;
            f2 *= s;
        }
        const w = Math.max(wTitle, wLines) * s + 2 * pad;
        const h = pad * 1.6 + f1 * 1.2 + lines.length * f2 * 1.4;
        const x0 = clamp(cx - w / 2, 10, viewW - 10 - w), y0 = cy - h / 2;
        roundRectPath(x0, y0, w, h, 8);
        ctx.fillStyle = pal.calloutBg;
        ctx.fill();
        ctx.strokeStyle = pal.pink;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        setFont(f1, 700);
        ctx.fillStyle = pal.text;
        ctx.fillText(box.title, x0 + w / 2, y0 + pad * 0.8);
        setFont(f2, 400);
        ctx.fillStyle = pal.muted;
        lines.forEach((l, i) => ctx.fillText(l, x0 + w / 2, y0 + pad * 0.8 + f1 * 1.3 + i * f2 * 1.4));
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
        ctx.ellipse(tx(0.52), ty(-0.06), Math.max(0.5, 0.075 * tkx), 0.075 * tky, 0, 0, TAU);
        ctx.fillStyle = '#2a3140';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = Math.max(1, tky * 0.012);
        ctx.stroke();
        if (!withChamber) {
            ctx.beginPath();
            ctx.ellipse(tx(0.2), ty(-0.06), Math.max(0.5, 0.06 * tkx), 0.06 * tky, 0, 0, TAU);
            ctx.ellipse(tx(-0.08), ty(-0.06), Math.max(0.5, 0.06 * tkx), 0.06 * tky, 0, 0, TAU);
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

    function drawPhoton(x, y, r) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
        g.addColorStop(0, `rgba(${pal.chamberLightRGB},0.9)`);
        g.addColorStop(1, `rgba(${pal.chamberLightRGB},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r * 3.2, 0, TAU);
        ctx.fill();
        ctx.fillStyle = pal.photon;
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
                drawTrail(trail, xShift, k, lay.cx, y, lc.T, c.moving ? pal.lightRGB : pal.chamberLightRGB, Math.max(1.5, k * 0.012));
            }
            const py = y + (LC.MIRROR / 2 - lightHeight(c.clock) * LC.MIRROR) * k;
            drawPhoton(xs, py, Math.max(2.5, k * 0.022));

            if (c.moving) drawVelocity(xs + dir * (halfLen + 10), y, dir, arrowLen, f, S.v);

            // Name and clock above the craft
            const phase = c.clock / LC.TICK;
            const lw = drawCraftLabel(xs, labelY, name, textColor, fmtNum(c.clock), 's', { f, color, phase, flash });

            // Simultaneity: clocks near each end, synchronised in the craft's own frame. Measured from a frame
            // where it moves at u, a clock a distance ξ (own frame) towards the front reads u·ξ/c² less.
            if (S.showSync) {
                const pw = pillWidth(f, 's', '00.0', true);
                for (const side of [-1, 1]) {
                    const xi = side * LC.END;
                    const reading = c.clock - c.u * xi;
                    const xe = xs + xi * kx;
                    const xp = xs + side * Math.max(Math.abs(xi * kx), lw / 2 + 8 + pw / 2);
                    ctx.strokeStyle = pal.faint;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(xp, labelY + lay.ps.h / 2);
                    ctx.lineTo(xe, y - 0.06 * k);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.arc(xe, y, Math.max(2.5, k * 0.018), 0, TAU);
                    ctx.fillStyle = pal.text;
                    ctx.fill();
                    ctx.strokeStyle = pal.edge;
                    ctx.stroke();
                    drawPill(xp, labelY, fmtNum(Math.max(0, reading)), 's', { f, color, edge: pal.faint, compact: true, template: '00.0' });
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
        const g = ctx.createRadialGradient(x - rx * 0.35, y - r * 0.35, r * 0.1, x, y, r);
        g.addColorStop(0, '#9ad6fa');
        g.addColorStop(1, pal.earthOcean);
        ctx.fillStyle = g;
        ctx.fillRect(x - rx, y - r, 2 * rx, 2 * r);
        ctx.fillStyle = pal.teal;
        const blobs = [[-0.35, -0.3, 0.42, 0.3], [0.32, 0.12, 0.38, 0.45], [-0.1, 0.55, 0.3, 0.18], [0.45, -0.55, 0.2, 0.14]];
        for (const b of blobs) {
            ctx.beginPath();
            ctx.ellipse(x + b[0] * rx, y + b[1] * r, b[2] * rx, b[3] * r, 0.4, 0, TAU);
            ctx.fill();
        }
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
        ctx.fillText(starName, clamp(xS, snw / 2 + 6, viewW - snw / 2 - 6), y + lay.rE + f * 1.5);

        // Earth and the star move when measured from the ship
        const arrowLen = clamp(0.06 * viewW, 26, 60);
        if (ship && st.homeU !== 0 && moving) {
            const dir = Math.sign(st.homeU);
            drawVelocity(xE + dir * (lay.rE * homeSx + 8), y - lay.rE - f * 0.2, dir, arrowLen, f, S.v);
            drawVelocity(xS + dir * (lay.rE * 0.62 * homeSx + 8), y - lay.rE - f * 0.2, dir, arrowLen, f, S.v);
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
        drawCallout(viewW / 2, Math.max(viewH * 0.24, f * 4.2), f);
    }

    // ------------------------------------------------------------------
    // Scene: muons
    // ------------------------------------------------------------------
    function muonsLayout() {
        const f = fontPx;
        const top = Math.round(f * 5);
        const yGround = viewH - Math.max(f * 2.6, viewH * 0.12);
        const k = (yGround - top) / MU.H;      // px per km
        const axisX = Math.round(textW('15 km', f * 0.9, 400) + f * 1.2);
        return { f, top, yGround, k, axisX, x0: axisX + f * 1.5, x1: viewW - f * 1.2 };
    }

    function drawMuons() {
        const lay = muonsLayout();
        const f = lay.f, k = lay.k;
        const g = gammaOf(S.v);
        const v = S.v;
        const ship = homeMoves();
        const tau = muonClock();
        // Where the ground is (px) and how high the muons are, measured in the shown frame
        let yMu, yGround, kAlt;
        if (!ship) {
            yGround = lay.yGround;
            yMu = lay.top + Math.min(MU.H, v * C_KM_US * mu.t) * k;
            kAlt = k;
        } else {
            yMu = lay.top;
            yGround = lay.top + Math.max(0, MU.H / g - v * C_KM_US * mu.t) * k;
            kAlt = k / g;      // the atmosphere is contracted along the motion
        }
        const yTopAtm = yGround - MU.H * kAlt;

        // Sky: the atmosphere's haze between its top and the ground, then the ground
        const sky = ctx.createLinearGradient(0, yTopAtm, 0, yGround);
        sky.addColorStop(0, `rgba(${pal.skyRGB},0)`);
        sky.addColorStop(1, `rgba(${pal.skyRGB},${dark ? 0.2 : 0.28})`);
        ctx.fillStyle = sky;
        ctx.fillRect(0, yTopAtm, viewW, yGround - yTopAtm);
        const groundDepth = Math.max(lay.f * 2.6, viewH * 0.12);
        const soil = ctx.createLinearGradient(0, yGround, 0, yGround + groundDepth * 1.6);
        soil.addColorStop(0, pal.ground);
        soil.addColorStop(0.6, pal.ground);
        soil.addColorStop(1, pal.bg);
        ctx.fillStyle = soil;
        ctx.fillRect(0, yGround, viewW, viewH - yGround);
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
        ctx.moveTo(lay.axisX, yTopAtm);
        ctx.lineTo(viewW, yTopAtm);
        ctx.stroke();
        ctx.setLineDash([]);

        // Altitude scale, fixed to Earth (so it is squeezed when measured from the muons)
        ctx.strokeStyle = pal.muted;
        ctx.fillStyle = pal.muted;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(lay.axisX, yGround);
        ctx.lineTo(lay.axisX, yTopAtm);
        ctx.stroke();
        // Labels: always the top (15 km); the others only where they have room. "0 km" sits just above the
        // ground line rather than across it.
        setFont(f * 0.9, 400);
        ctx.textAlign = 'right';
        const gapPx = 5 * kAlt;
        for (let a = MU.H; a >= 0; a -= 5) {
            const yy = yGround - a * kAlt;
            ctx.beginPath();
            ctx.moveTo(lay.axisX - 5, yy);
            ctx.lineTo(lay.axisX, yy);
            ctx.stroke();
            const room = a === MU.H || (a === 0 ? MU.H * kAlt >= f * 1.6 : gapPx >= f * 1.2);
            if (!room) continue;
            ctx.textBaseline = a === 0 ? 'bottom' : 'middle';
            ctx.fillText(`${a} km`, lay.axisX - 8, a === 0 ? yy - 2 : yy);
        }

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
        if (!ship) {
            const ew = craftLabelWidth(f, 'Earth', 'µs', tpl);
            drawCraftLabel(lay.x0 + ew / 2, yGround + Math.max(f * 1.3, (viewH - yGround) / 2), 'Earth', pal.blueText, fmtNum(mu.t), 'µs', { f, color: pal.blue, phase: mu.t, template: tpl });
        } else if (viewH - yGround > f * 1.6) {
            // Earth moves up at v: an arrow and its speed on the ground
            const ya = yGround + Math.max(f * 1.3, Math.min(f * 2, (viewH - yGround) / 2));
            setFont(f * 0.95, 700);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = pal.blueText;
            ctx.fillText('Earth', lay.x0, ya);
            const xa = lay.x0 + textW('Earth ', f * 0.95, 700) + 4;
            ctx.strokeStyle = pal.muted;
            ctx.fillStyle = pal.muted;
            ctx.lineWidth = Math.max(1.5, f * 0.13);
            ctx.beginPath();
            ctx.moveTo(xa, ya + f * 0.55);
            ctx.lineTo(xa, ya - f * 0.25);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(xa, ya - f * 0.65);
            ctx.lineTo(xa - f * 0.3, ya - f * 0.15);
            ctx.lineTo(xa + f * 0.3, ya - f * 0.15);
            ctx.closePath();
            ctx.fill();
            setFont(f * 0.92, 700);
            ctx.fillText(`${fmtV(S.v)} c`, xa + f * 0.6, ya);
        }
        hitRects.push({ x0: lay.x0, x1: lay.x1, y0: yMu - 14, y1: yMu + 14, frame: 'away' });
        hitRects.push({ x0: 0, x1: viewW, y0: yGround, y1: viewH, frame: 'home' });

        drawCaption(f);
        // Measured from the muons the fall is over in a flash; a note fills the space the thin atmosphere leaves.
        const cy = ship ? clamp((lay.yGround + lay.top + MU.H * k / g) / 2 + f * 2, f * 6, viewH - f * 4) : clamp((lay.top + lay.yGround) / 2, f * 5, viewH - f * 5);
        if (callout) drawCallout(viewW / 2, cy, f);
        else if (ship && mu.stage === 'fall') {
            drawCallout(viewW / 2, cy, f, {
                title: `The atmosphere is squashed to ${(MU.H / g).toFixed(2)} km`,
                text: [`Earth rushes up at ${fmtV(S.v)} c, so the ground arrives after ${fmtNum(muonTimes().tauLand)} µs`]
            });
        }
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
        if (S.scenario === 'clocks') drawClocks();
        else if (S.scenario === 'twins') drawTwins();
        else drawMuons();
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
        if (S.scenario === 'clocks') {
            const st = clockState();
            const movingName = st.away.moving ? 'Ship' : 'Station';
            return [
                { label: 'Station clock:', value: fmtNum(st.home.clock), unit: 's', color: pal.blue },
                { label: 'Ship clock:', value: fmtNum(st.away.clock), unit: 's', color: pal.pink },
                { label: `${movingName} length:`, value: (LC.L0 / g).toFixed(2), unit: 'ls' }
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

    function chartUnits() {
        if (S.scenario === 'clocks') return { t: 's', a: 'Station clock', b: 'Ship clock', y: 'Clock reading (s)' };
        if (S.scenario === 'twins') return { t: 'years', a: 'Earth twin', b: 'Traveller', y: 'Age gained (years)' };
        return { t: 'µs', a: 'Muons left', b: null, y: 'Muons left' };
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
                datasets: [
                    { label: 'A', data: [], borderColor: '#7ecaf6', backgroundColor: '#7ecaf6', borderWidth: 2, pointRadius: 0, tension: 0 },
                    { label: 'B', data: [], borderColor: '#f2849e', backgroundColor: '#f2849e', borderWidth: 2, pointRadius: 0, tension: 0 }
                ]
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
        const u = chartUnits();
        const sc = SCENARIOS[S.scenario];
        const ch = charts.clock;
        ch.data.datasets[0].label = u.a;
        ch.data.datasets[0].borderColor = ch.data.datasets[0].backgroundColor = S.scenario === 'muons' ? '#ae85ca' : '#7ecaf6';
        ch.data.datasets[1].label = u.b || '';
        ch.data.datasets[1].hidden = !u.b;
        ch.options.plugins.legend.labels.filter = (item) => !!item.text;
        ch.options.scales.x.title.text = `Time measured from ${sc[S.frame].the} (${u.t})`;
        ch.options.scales.y.title.text = u.y;
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
        let t, a, b;
        if (S.scenario === 'clocks') {
            const st = clockState();
            t = lc.T; a = st.home.clock; b = st.away.clock;
        } else if (S.scenario === 'twins') {
            const st = twinState();
            t = tw.t; a = st.earthAge; b = st.shipAge;
        } else {
            t = mu.t; a = muonsLeft(); b = null;
        }
        const ds = charts.clock.data.datasets;
        const last = ds[0].data[ds[0].data.length - 1];
        if (last && last.x === t && last.y === a && (b === null || ds[1].data[ds[1].data.length - 1].y === b)) return;
        ds[0].data.push({ x: t, y: a });
        if (b !== null) ds[1].data.push({ x: t, y: b });
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
        toggle(ui.paths, 'showPaths');
        toggle(ui.lengths, 'showLengths');
        toggle(ui.sync, 'showSync');
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

    function rate() {
        if (S.scenario === 'twins') return TW.RATE;
        if (S.scenario === 'muons') return MU.RATE;
        return 1;
    }

    function advance(dtReal) {
        const dt = dtReal * S.speed * rate();
        if (S.scenario === 'clocks') {
            // Small steps keep the light's zig-zag corners exact even at high playback speeds.
            const n = Math.max(1, Math.ceil(dt / 0.05));
            for (let i = 0; i < n; i++) stepClocks(dt / n);
        } else if (S.scenario === 'twins') {
            stepTwins(dt, dtReal);
        } else {
            stepMuons(dt, dtReal);
        }
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
            if (S.scenario === 'clocks') {
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
                Object.assign(out, { t: mu.t, stage: mu.stage, muonClock: muonClock(), left: muonsLeft(), times: muonTimes(), lifetimes: Array.from(mu.life) });
            }
            out.readouts = readoutRows().map((r) => `${r.label} ${r.value} ${r.unit}`);
            out.gammaText = fmtGamma(g);
            out.hitRects = hitRects.map((r) => Object.assign({}, r));
            out.callout = callout ? Object.assign({}, callout) : null;
            return out;
        }
    };

    // --- Start ---
    function start() {
        refreshPalette();
        bindControls();
        syncFrameButtons();
        if (ui.scenario) S.scenario = ui.scenario.value || 'clocks';
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
