/*
 * Nuclear Stability & Decay - simulations.science
 *
 * Build nuclei from protons and neutrons (or drop in ready-made ones), combine and collide them, and watch the
 * unstable ones decay, one random decay at a time, until they reach a stable nucleus.
 *
 * Data (assets/js/nuclear_data.js): evaluated half-lives, decay modes with branching ratios and mass excesses for
 * every known ground state (IAEA LiveChart/ENSDF, gaps from NUBASE2020), the main gamma lines and the split of
 * electron capture and beta+ decay, plus three isomers (Tc-99m, Ba-137m, Pa-234m).
 *
 * Time: each unstable nucleus has its own logarithmic clock. It starts at 1 ns (earlier for very short-lived
 * nuclei) and runs ten times faster every half second at 1x, so a timer gets from nanoseconds to billions of
 * years within seconds. The decay time is drawn when the nucleus forms, t = -(T1/2 / ln 2) ln U (U uniform in
 * (0, 1]), together with the branch (by its branching ratio); the nucleus decays when its clock reaches t.
 * Nothing warns of a decay in advance: it is random and memoryless, as in a real nucleus. (The carbon-dating
 * setup gives its sample one shared, steady clock instead, so the sample can be seen to halve.) The simulation
 * speed scales the clocks and everything that moves on its own (radiation, recoils); things the user throws
 * move in real time.
 *
 * Model for nuclides that are not in the table (the user can build anything up to 300 nucleons):
 *  - Masses: the semi-empirical (Bethe-Weizsaecker) formula with pairing, anchored to the nearest measured isotope
 *    of the same element, so separation energies and Q-values join smoothly onto the data.
 *  - Beyond the drip lines (S_n < 0 or S_p < 0), or for clusters of only neutrons or only protons: prompt nucleon
 *    emission (~1e-21 s; protons tunnel through the Coulomb barrier, WKB).
 *  - Otherwise each energetically allowed mode gets a partial half-life: beta-/beta+/EC from the Fermi integral
 *    with log ft fitted to the data (4.3 even-even, 5.0 odd A, 5.4 odd-odd), alpha from the Viola-Seaborg formula,
 *    spontaneous fission from a fit of log T1/2 against the fissility Z^2/A. The fastest modes win, by rate.
 */
(function () {
    'use strict';

    const canvas = document.getElementById('simulationCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (!canvas || !ctx) {
        console.error('Nuclear simulation: #simulationCanvas not found.');
        return;
    }

    const byId = (id) => document.getElementById(id);
    const ui = {
        speed: byId('speedSlider'), speedVal: byId('speedVal'),
        showChart: byId('showChartToggle'), showTags: byId('showTagsToggle'), showNeutrinos: byId('showNeutrinosToggle'),
        showEquations: byId('showEquationsToggle'), showDetails: byId('showDetailsToggle'),
        notation: byId('notationToggle'), keepParticles: byId('keepParticlesToggle'), mirrorWalls: byId('mirrorWallsToggle'),
        element: byId('elementSelect'), isotope: byId('isotopeSelect'), addBtn: byId('addNuclideBtn'),
        toolbar: byId('nucToolbar'), palette: byId('nucPalette'), trayToggle: byId('nucTrayToggle'),
        setups: document.querySelectorAll('[data-setup]'),
        reset: byId('resetSimulationBtn'), clear: byId('clearSimulationBtn'), fps: byId('fpsDisplay'),
        statName: byId('statNucleus'), statHalf: byId('statHalfLife'), statDecay: byId('statDecay'),
    };

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------
    const TAU = Math.PI * 2;
    const LN2 = Math.LN2;
    const YEAR = 31556926;          // s
    const ME_N = 8071.318;          // keV: mass excesses of the neutron, the hydrogen-1 atom and the helium-4 atom
    const ME_H = 7288.971;
    const ME_HE4 = 2424.916;
    const M_E = 510.999;            // keV: electron mass
    const ALPHA = 1 / 137.036;
    const MAX_A = 300;              // biggest nucleus that can be built
    const MAX_Z = 130;
    const MAX_BODIES = 40;
    const MAX_SPARKS = 240;
    const DECADES_PER_S = 2;        // clock decades per real second at 1x
    // Speeds of the radiation, in canvas sizes (the geometric mean of width and height) per second at 1x: slow
    // enough to read the labels, which stay in view for a couple of seconds whichever way a particle goes.
    // Gamma rays are the fastest and alpha particles the slowest, though nowhere near to scale. (Fission
    // fragments: in shorter sides per second.)
    const SPEED = { g: 0.22, nu: 0.19, e: 0.15, n: 0.16, p: 0.13, a: 0.1, cluster: 0.09, fragment: 0.32 };
    const FADE_AT = 2.6, FADE_LEN = 1;   // s: emitted radiation fades out over FADE_LEN after FADE_AT
    const MIRROR_LIFE = 12;         // s: neutrons last longer between reflecting walls
    const CHAIN_NEUTRON_SPEED = 2.5; // x in the chain reaction: a generation takes about a second, so the growth shows
    const REFLECTOR_ALBEDO = 0.95;  // share of the neutrons reaching the reflector that it sends back (the rest leak out)
    const PROMPT = 5e-22;           // s: nucleon emission from an unbound nucleus
    const LOG_FT = { ee: 4.3, odd: 5.0, oo: 5.4 };   // fitted to the data (see header)
    const EC_K = 20.3;              // K-capture strength, fitted to the measured EC/beta+ ratios
    const MAGIC = [2, 8, 20, 28, 50, 82, 126];

    const SYMBOLS = ['n', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl',
        'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb',
        'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La',
        'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir',
        'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th', 'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk',
        'Cf', 'Es', 'Fm', 'Md', 'No', 'Lr', 'Rf', 'Db', 'Sg', 'Bh', 'Hs', 'Mt', 'Ds', 'Rg', 'Cn', 'Nh', 'Fl', 'Mc', 'Lv', 'Ts', 'Og'];
    const NAMES = ['Neutron', 'Hydrogen', 'Helium', 'Lithium', 'Beryllium', 'Boron', 'Carbon', 'Nitrogen', 'Oxygen',
        'Fluorine', 'Neon', 'Sodium', 'Magnesium', 'Aluminium', 'Silicon', 'Phosphorus', 'Sulfur', 'Chlorine', 'Argon',
        'Potassium', 'Calcium', 'Scandium', 'Titanium', 'Vanadium', 'Chromium', 'Manganese', 'Iron', 'Cobalt', 'Nickel',
        'Copper', 'Zinc', 'Gallium', 'Germanium', 'Arsenic', 'Selenium', 'Bromine', 'Krypton', 'Rubidium', 'Strontium',
        'Yttrium', 'Zirconium', 'Niobium', 'Molybdenum', 'Technetium', 'Ruthenium', 'Rhodium', 'Palladium', 'Silver',
        'Cadmium', 'Indium', 'Tin', 'Antimony', 'Tellurium', 'Iodine', 'Xenon', 'Caesium', 'Barium', 'Lanthanum', 'Cerium',
        'Praseodymium', 'Neodymium', 'Promethium', 'Samarium', 'Europium', 'Gadolinium', 'Terbium', 'Dysprosium',
        'Holmium', 'Erbium', 'Thulium', 'Ytterbium', 'Lutetium', 'Hafnium', 'Tantalum', 'Tungsten', 'Rhenium', 'Osmium',
        'Iridium', 'Platinum', 'Gold', 'Mercury', 'Thallium', 'Lead', 'Bismuth', 'Polonium', 'Astatine', 'Radon',
        'Francium', 'Radium', 'Actinium', 'Thorium', 'Protactinium', 'Uranium', 'Neptunium', 'Plutonium', 'Americium',
        'Curium', 'Berkelium', 'Californium', 'Einsteinium', 'Fermium', 'Mendelevium', 'Nobelium', 'Lawrencium',
        'Rutherfordium', 'Dubnium', 'Seaborgium', 'Bohrium', 'Hassium', 'Meitnerium', 'Darmstadtium', 'Roentgenium',
        'Copernicium', 'Nihonium', 'Flerovium', 'Moscovium', 'Livermorium', 'Tennessine', 'Oganesson'];

    // Palette strip: the particles and ready-made nuclei (chosen so every decay type has an example).
    const PRESETS = [
        { Z: 1, N: 0 }, { Z: 0, N: 1 },
        { Z: 1, N: 1, note: 'deuterium: fuse it with tritium' },
        { Z: 1, N: 2, note: 'tritium' },
        { Z: 2, N: 2, note: 'the alpha particle' },
        { Z: 6, N: 8, note: 'radiocarbon dating' },
        { Z: 4, N: 3, note: 'pure electron capture' },
        { Z: 11, N: 11, note: 'positron emitter' },
        { Z: 19, N: 21, note: 'beta- or electron capture' },
        { Z: 27, N: 33, note: 'beta- and two gammas' },
        { Z: 43, N: 56, iso: 1, note: 'gamma emitter used in medical scans' },
        { Z: 55, N: 82, note: 'beta-, then a gamma from Ba-137m' },
        { Z: 88, N: 138, note: 'alpha emitter' },
        { Z: 92, N: 143, note: 'add a neutron for fission' },
        { Z: 92, N: 146, note: 'a 14-step decay chain' },
        { Z: 98, N: 154, note: 'alpha, or spontaneous fission' },
    ];
    // fx, fy: place on a wide canvas; tx, ty: on a tall one (phones in portrait), clear of the chart
    // (on a tall canvas: three across the top, two down the side beside the chart)
    const START_SCENE = [
        { Z: 92, N: 146, fx: 0.24, fy: 0.42, tx: 0.22, ty: 0.15, select: true },
        { Z: 6, N: 8, fx: 0.47, fy: 0.3, tx: 0.56, ty: 0.1 },
        { Z: 43, N: 56, iso: 1, fx: 0.5, fy: 0.68, tx: 0.26, ty: 0.46 },
        { Z: 27, N: 33, fx: 0.7, fy: 0.62, tx: 0.26, ty: 0.7 },
        { Z: 26, N: 30, fx: 0.12, fy: 0.75, tx: 0.85, ty: 0.1 },
    ];

    // Neutron capture on these (Z, N) targets usually splits the nucleus (thermal fission / (fission + capture)).
    const FISSILE = { '92,141': 0.92, '92,143': 0.85, '94,145': 0.73, '94,147': 0.74, '95,147': 0.85, '96,149': 0.87, '98,153': 0.83 };
    const NEUTRON_CATCH = 0.05;     // chance that another nucleus catches a free neutron that touches it

    // ------------------------------------------------------------------
    // Settings & state
    // ------------------------------------------------------------------
    const S = {
        speed: 1, showChart: true, showTags: true, showNeutrinos: true, showEquations: true, showDetails: false,
        notation: false, keepParticles: false, mirrorWalls: false,
    };
    let viewW = 0, viewH = 0, dpr = 1;
    let rN = 4;                     // nucleon radius (CSS px)
    let fontPx = 13;
    let realTime = 0;               // s since start (labels, the chart's zoom)
    let simTime = 0;                // s of simulation time (runs at the simulation speed: decays, radiation)
    let batch = null;               // the carbon-dating sample: a shared steady clock and its count
    let reflector = null;           // the chain-reaction core's neutron reflector { x0, y0, x1, y1 } (with the mirror setting)
    let chainRx = null;             // the chain-reaction setup: { gens: fissions in each neutron generation }
    let holdClock = null;           // a setup's test for nuclei whose own slow decay would only get in the way
    let clockK = 1;                 // a setup's faster clock (the decay series)
    let nextId = 1;
    let bodies = [];
    let sparks = [];                // light particles: e-, e+, neutrinos, gammas
    let effects = [];               // flashes, decay tags, toasts
    let eqLog = [];                 // decay equations, newest last
    let selectedId = 0;
    let toast = null;
    let layout = null;              // overlay rectangles for this canvas size
    let panelRects = [];            // equation and details panels drawn this frame (nuclei keep clear of them)
    let paused = false;             // clocks stopped (test hook)
    let frozen = false;             // everything stopped (test hook, for screenshots mid-animation)

    // ------------------------------------------------------------------
    // Data
    // ------------------------------------------------------------------
    const table = new Map();        // key(Z, N, iso) -> raw record
    const isoFeeds = new Map();     // parent key -> [daughter Z, N, iso, fraction]
    let chartNMax = 0, chartZMax = 0;
    const key = (Z, N, iso) => ((Z * 400 + N) * 2 + (iso ? 1 : 0));
    // codes that end in digits (clusters kZ.N, beta- then 3-7 neutrons b3..b7) are terminated by '=' in the data
    const MODE_RE = /^(k\d+\.\d+=|b[3-7]=|b[nNpaf]|e[pPaf]|[becziafpPnNBCZ])(\?|[0-9.eE+-]*)$/;

    function parseModes(text) {
        const out = [];
        if (!text) return out;
        text.split(',').forEach((part) => {
            const m = MODE_RE.exec(part);
            if (!m) return;
            out.push({ code: m[1].replace('=', ''), pct: m[2] === '' ? 100 : (m[2] === '?' ? null : parseFloat(m[2])) });
        });
        return out;
    }

    function parseEntry(Z, N, iso, text, isoE) {
        const f = text.split('|');
        const rec = {
            Z, N, iso, hl: f[0] === 's' ? Infinity : (f[0] === '' ? null : parseFloat(f[0])),
            modes: parseModes(f[1]), me: parseFloat(f[2]) || 0, ab: null, pos: null, gam: null, isoE: isoE || 0,
        };
        for (let i = 3; i < f.length; i++) {
            const x = f[i];
            if (x[0] === 'w') rec.ab = parseFloat(x.slice(1));
            else if (x[0] === '+') rec.pos = parseFloat(x.slice(1));
            else if (x[0] === 'g') {
                rec.gam = {};
                x.slice(1).split('/').forEach((grp) => {
                    const parts = grp.split(':');
                    rec.gam[parts[0]] = parts.slice(1).map((s) => s.split('@').map(parseFloat));
                });
            }
        }
        return rec;
    }

    function loadData() {
        const D = window.NUCLEAR_DATA;
        if (!D) { console.error('Nuclear simulation: nuclear_data.js not loaded.'); return; }
        D.nuclides.split('\n').forEach((line) => {
            const sp1 = line.indexOf(' '), sp2 = line.indexOf(' ', sp1 + 1);
            const Z = parseInt(line.slice(0, sp1), 10), N0 = parseInt(line.slice(sp1 + 1, sp2), 10);
            line.slice(sp2 + 1).split(';').forEach((e, i) => {
                if (!e) return;
                const N = N0 + i;
                table.set(key(Z, N, 0), parseEntry(Z, N, 0, e));
                if (N > chartNMax) chartNMax = N;
                if (Z > chartZMax) chartZMax = Z;
            });
        });
        D.isomers.split('\n').forEach((line) => {
            const p = line.split(' ');
            const Z = +p[0], N = +p[1];
            table.set(key(Z, N, 1), parseEntry(Z, N, 1, p.slice(6).join(' '), +p[2]));
            isoFeeds.set(key(+p[3], +p[4], 0), [Z, N, 1, +p[5]]);
        });
    }

    // ------------------------------------------------------------------
    // Names
    // ------------------------------------------------------------------
    const ROOTS = ['nil', 'un', 'bi', 'tri', 'quad', 'pent', 'hex', 'sept', 'oct', 'enn'];
    function elementSymbol(Z) {
        if (Z < SYMBOLS.length) return SYMBOLS[Z];
        const s = String(Z).split('').map((d) => ROOTS[+d][0]).join('');
        return s[0].toUpperCase() + s.slice(1);
    }
    function elementName(Z) {
        if (Z < NAMES.length) return NAMES[Z];
        // IUPAC systematic names (e.g. 119 Ununennium, 120 Unbinilium)
        let s = String(Z).split('').map((d) => ROOTS[+d]).join('') + 'ium';
        s = s.replace('nnn', 'nn').replace('iium', 'ium');
        return s[0].toUpperCase() + s.slice(1);
    }
    function nuclideName(Z, N, iso) {
        const A = Z + N;
        if (Z === 0) return N === 1 ? 'Neutron' : (['', '', 'Dineutron', 'Trineutron', 'Tetraneutron'][N] || N + ' neutrons');
        if (Z === 1 && N === 0) return 'Proton';
        return elementName(Z) + '-' + A + (iso ? 'm' : '');
    }
    function shortName(Z, N, iso) {
        if (Z === 0 && N === 1) return 'n';
        if (Z === 1 && N === 0) return 'p';
        return elementSymbol(Z) + '-' + (Z + N) + (iso ? 'm' : '');
    }

    // ------------------------------------------------------------------
    // Masses and the decay model
    // ------------------------------------------------------------------
    // Semi-empirical mass formula: mass excess in keV.
    function semfME(Z, N) {
        const A = Z + N;
        if (A <= 1) return Z ? ME_H : ME_N;
        const A3 = Math.cbrt(A);
        let B = 15.75 * A - 17.8 * A3 * A3 - 0.711 * Z * (Z - 1) / A3 - 23.7 * (N - Z) * (N - Z) / A;
        const d = 11.18 / Math.sqrt(A);
        if (Z % 2 === 0 && N % 2 === 0) B += d; else if (Z % 2 && N % 2) B -= d;
        return Z * ME_H + N * ME_N - Math.max(B, -50) * 1000;
    }

    const meCache = new Map();
    function massExcess(Z, N, iso) {
        if (Z < 0 || N < 0) return NaN;
        const rec = table.get(key(Z, N, iso));
        if (rec) return rec.me;
        if (iso) return massExcess(Z, N, 0);
        const k = key(Z, N, 0);
        if (meCache.has(k)) return meCache.get(k);
        // Anchor to the nearest measured isotope of the same element (keeps separation energies continuous).
        let v = semfME(Z, N);
        for (let d = 1; d < 60; d++) {
            const r = table.get(key(Z, N - d, 0)) || table.get(key(Z, N + d, 0));
            if (r) { v = r.me + semfME(Z, N) - semfME(Z, r.N); break; }
        }
        meCache.set(k, v);
        return v;
    }

    function fermiF(Z, W, sign) {
        const p = Math.sqrt(Math.max(1e-12, W * W - 1));
        const x = TAU * sign * ALPHA * Z * W / p;
        if (Math.abs(x) < 1e-8) return 1;
        if (x < -700) return 0;
        return x / (1 - Math.exp(-x));
    }
    // Fermi integral f(Z, W0) for beta- (sign +1, daughter charge Z) or beta+ (sign -1); W in electron masses.
    function fBeta(Z, W0, sign) {
        if (W0 <= 1.0001) return 0;
        const n = 40, h = (W0 - 1) / n;
        let s = 0;
        for (let i = 1; i <= n; i++) {
            const W = 1 + i * h;
            const p = Math.sqrt(W * W - 1);
            s += fermiF(Z, W, sign) * p * W * (W0 - W) * (W0 - W) * (i === n ? 1 : (i % 2 ? 4 : 2));
        }
        return s * h / 3;
    }
    function fEC(Z, Qkev) {
        const q = Qkev / M_E;
        return EC_K * Math.pow(ALPHA * Z, 3) * q * q;
    }
    // Share of electron-capture-or-beta+ decays that emit a positron (parent charge Z, Q_EC in keV).
    function positronShareModel(Z, Qec) {
        if (Qec <= 2 * M_E) return 0;
        const fp = fBeta(Z - 1, Qec / M_E - 1, -1);
        const fe = fEC(Z, Qec);
        return fp / (fp + fe);
    }
    function logFt(Z, N) {
        if (Z % 2 === 0 && N % 2 === 0) return LOG_FT.ee;
        if (Z % 2 && N % 2) return LOG_FT.oo;
        return LOG_FT.odd;
    }
    function betaMinusHalfLife(Z, N, Q) {
        const f = fBeta(Z + 1, 1 + Q / M_E, 1);
        return f > 0 ? Math.pow(10, logFt(Z, N)) / f : Infinity;
    }
    function epsilonHalfLife(Z, N, Q) {
        const f = fBeta(Z - 1, Q / M_E - 1, -1) + fEC(Z, Q);
        return f > 0 ? Math.pow(10, logFt(Z, N)) / f : Infinity;
    }
    // Viola-Seaborg systematics (Sobiczewski et al. 1989), Q in keV.
    function alphaHalfLife(Z, N, Q) {
        if (Q <= 0) return Infinity;
        const q = Q / 1000;
        let lg = (1.66175 * Z - 8.5166) / Math.sqrt(q) - 0.20228 * Z - 33.9069;
        if (Z % 2 && N % 2) lg += 1.114; else if (N % 2) lg += 1.066; else if (Z % 2) lg += 0.772;
        return Math.pow(10, Math.max(-21, lg));
    }
    // Spontaneous fission: log10 T1/2 falls ~5.65 decades per unit of Z^2/A (fit to U-238 ... Rf-260), with the
    // usual extra hindrance for odd nucleon numbers.
    function fissionHalfLife(Z, N) {
        const A = Z + N;
        const x = Z * Z / A;
        if (x < 30) return Infinity;
        let lg = 23.4 - 5.65 * (x - 35.56);
        if (Z % 2 && N % 2) lg += 5; else if (A % 2) lg += 3;
        return Math.pow(10, Math.max(-21, lg));
    }
    // WKB tunnelling through the Coulomb barrier (proton emission): Q in keV.
    function protonHalfLife(Zd, Ad, Q) {
        if (Q <= 0) return Infinity;
        const q = Q / 1000;
        const b = 1.44 * Zd / q;                           // fm: classical turning point
        const R = 1.2 * (Math.cbrt(Ad) + 1);               // fm
        if (R >= b) return PROMPT;
        const x = R / b;
        const G = Math.sqrt(2 * 938.3 * q) / 197.33 * b * (Math.acos(Math.sqrt(x)) - Math.sqrt(x * (1 - x)));
        return Math.max(PROMPT, LN2 / (1e21 * Math.exp(-2 * G)));
    }

    // Decay modes and half-life of a nuclide that is not in the table.
    function estimate(Z, N) {
        const A = Z + N;
        if (Z === 0 && N > 1) return { hl: PROMPT, modes: [{ code: 'n', p: 1 }] };
        if (N === 0 && Z > 1) return { hl: PROMPT, modes: [{ code: 'p', p: 1 }] };
        const me = massExcess(Z, N, 0);
        const rates = [];
        const add = (code, T) => { if (T < 1e40) rates.push({ code, rate: LN2 / T }); };
        const Sn = N > 0 ? massExcess(Z, N - 1, 0) + ME_N - me : 1e9;
        const Sp = Z > 0 ? massExcess(Z - 1, N, 0) + ME_H - me : 1e9;
        const S2n = N > 1 ? massExcess(Z, N - 2, 0) + 2 * ME_N - me : 1e9;
        const S2p = Z > 1 ? massExcess(Z - 2, N, 0) + 2 * ME_H - me : 1e9;
        if (Sn < 0) add('n', PROMPT);
        else if (S2n < 0) add('N', PROMPT * 2);
        if (Sp < 0) add('p', protonHalfLife(Z - 1, A - 1, -Sp));
        else if (S2p < 0) add('P', protonHalfLife(Z - 2, A - 2, -S2p / 2) * 2);
        const Qb = N > 0 ? me - massExcess(Z + 1, N - 1, 0) : -1;
        const Qe = Z > 0 ? me - massExcess(Z - 1, N + 1, 0) : -1;
        const Qa = (Z > 2 && N > 2) ? me - massExcess(Z - 2, N - 2, 0) - ME_HE4 : -1;
        if (Qb > 0) add('b', betaMinusHalfLife(Z, N, Qb));
        if (Qe > 0) add('e', epsilonHalfLife(Z, N, Qe));
        if (Qa > 0 && Z >= 52) add('a', alphaHalfLife(Z, N, Qa));
        if (Z >= 80) add('f', fissionHalfLife(Z, N));
        if (!rates.length) return { hl: Infinity, modes: [] };
        let total = 0;
        rates.forEach((r) => { total += r.rate; });
        const modes = rates.filter((r) => r.rate / total > 1e-7).map((r) => ({ code: r.code, p: r.rate / total }));
        modes.sort((a, b) => b.p - a.p);
        return { hl: Math.max(PROMPT, LN2 / total), modes };
    }

    const SUB_PARENT = { bn: 'b', bN: 'b', b3: 'b', b4: 'b', b5: 'b', b6: 'b', b7: 'b', bp: 'b', ba: 'b', bf: 'b', ep: 'e', eP: 'e', ea: 'e', ef: 'e' };

    // Everything the simulation needs to know about one nuclide (cached).
    const infoCache = new Map();
    function getInfo(Z, N, iso) {
        const k = key(Z, N, iso);
        if (infoCache.has(k)) return infoCache.get(k);
        const rec = table.get(k);
        const info = {
            Z, N, A: Z + N, iso: iso ? 1 : 0, sym: elementSymbol(Z), name: nuclideName(Z, N, iso),
            short: shortName(Z, N, iso), known: !!rec, estimated: false, me: massExcess(Z, N, iso),
            ab: rec ? rec.ab : null, gam: rec ? rec.gam : null, posData: rec ? rec.pos : null, isoE: rec ? rec.isoE : 0,
            hl: Infinity, stable: true, modes: [],
        };
        let modes = [];
        let hl = rec ? rec.hl : null;
        if (rec && rec.modes.length) {
            const prim = [];
            const subs = [];
            rec.modes.forEach((m) => {
                if (SUB_PARENT[m.code]) { subs.push(m); return; }
                const same = prim.find((p) => p.code === m.code);   // a mode listed twice: add the two
                if (same) { if (m.pct != null) same.pct = (same.pct || 0) + m.pct; } else prim.push({ code: m.code, pct: m.pct, sub: [] });
            });
            // Delayed emission (e.g. beta- then a neutron) is given as a share of all decays: store it as a share
            // of its parent mode's decays.
            subs.forEach((m) => {
                const pc = SUB_PARENT[m.code];
                let parent = prim.find((p) => p.code === pc) || (pc === 'e' && prim.find((p) => p.code === 'c' || p.code === 'z'));
                if (!parent) { parent = { code: pc, pct: m.pct, sub: [] }; prim.push(parent); }
                if (m.pct != null) parent.sub.push({ code: m.code, p: Math.min(1, m.pct / (parent.pct || 100)) });
            });
            let sum = 0;
            prim.forEach((p) => { if (p.pct == null) p.pct = prim.length === 1 ? 100 : 0; sum += p.pct; });
            if (sum > 0) modes = prim.filter((p) => p.pct > 0).map((p) => ({ code: p.code, p: p.pct / sum, sub: p.sub }));
        }
        if (hl === Infinity && !modes.length) {
            info.hl = Infinity;
        } else if (hl == null || !(hl > 0) || !modes.length) {
            const est = estimate(Z, N);
            if (hl == null || !(hl > 0)) { hl = est.hl; info.estimated = true; }
            if (!modes.length) { modes = est.modes.map((m) => ({ code: m.code, p: m.p, sub: [] })); info.estimated = true; }
            if (!modes.length && hl !== Infinity) { modes = [{ code: Z > N ? 'p' : 'n', p: 1, sub: [] }]; }
        }
        if (modes.length && hl > 0 && hl < Infinity) {
            info.hl = hl;
            info.stable = false;
            modes.sort((a, b) => b.p - a.p);
            info.modes = modes;
        }
        infoCache.set(k, info);
        return info;
    }

    function positronShare(info) {
        if (info.posData != null) return info.posData;
        const daughter = massExcess(info.Z - 1, info.N + 1, 0);
        return positronShareModel(info.Z, info.me - daughter);
    }

    // Primary decay type of a nuclide, for its colour: 'stable', 'unknown', or a mode code.
    function chartClass(info) {
        if (info.stable) return info.known ? 'stable' : 'none';
        if (!info.known || info.estimated && !info.modes.length) return 'unknown';
        const c = info.modes[0].code;
        if (c === 'b' || c === 'B') return 'b';
        if (c === 'e' || c === 'c' || c === 'z' || c === 'C' || c === 'Z') return 'e';
        if (c === 'a' || c[0] === 'k') return 'a';
        if (c === 'f') return 'f';
        if (c === 'p' || c === 'P') return 'p';
        if (c === 'n' || c === 'N') return 'n';
        if (c === 'i') return 'i';
        return 'unknown';
    }

    // ------------------------------------------------------------------
    // Formatting
    // ------------------------------------------------------------------
    const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };
    const sup = (n) => String(n).split('').map((c) => SUP[c] || c).join('');

    // Timer units: [length in s, singular, plural]. Each runs up to the next (60 s make a minute, and so on).
    const TIME_UNITS = [
        [1e-12, 'ps', 'ps'], [1e-9, 'ns', 'ns'], [1e-6, 'µs', 'µs'], [1e-3, 'ms', 'ms'], [1, 's', 's'], [60, 'min', 'min'],
        [3600, 'hour', 'hours'], [86400, 'day', 'days'], [YEAR, 'year', 'years'], [1e3 * YEAR, 'thousand years', 'thousand years'],
        [1e6 * YEAR, 'million years', 'million years'], [1e9 * YEAR, 'billion years', 'billion years'],
    ];
    // Leading digit of v (> 0) and its power of ten, rounded down: a counting timer never runs ahead.
    function oneFigure(v) {
        let e = Math.floor(Math.log10(v));
        let m = Math.floor(v / Math.pow(10, e) + 1e-9);
        if (m >= 10) { m = 1; e += 1; }
        if (m < 1) { m = 9; e -= 1; }
        return { m, e };
    }
    // A running timer to one significant figure ("7 ns", "40 µs", "3 s", "20 min", "5 days", "300 years",
    // "4 billion years"): { num, unit, wide }, where wide is the unit's longest form (for a steady layout).
    function formatDuration(s) {
        if (!(s > 0)) return { num: '0', unit: 's', wide: 's' };
        if (s < 1e-12) {
            const f = oneFigure(s);
            const u = '× 10' + sup(f.e) + ' s';
            return { num: String(f.m), unit: u, wide: u };
        }
        for (let i = TIME_UNITS.length - 1; i >= 0; i--) {
            const [len, one, many] = TIME_UNITS[i];
            if (s < len) continue;
            const v = s / len;
            if (i === TIME_UNITS.length - 1 && v >= 1000) {
                const f = oneFigure(s / YEAR);
                const u = '× 10' + sup(f.e) + ' years';
                return { num: String(f.m), unit: u, wide: u };
            }
            const f = oneFigure(v);
            const n = f.m * Math.pow(10, f.e);
            return { num: String(Math.round(n)), unit: n === 1 ? one : many, wide: many };
        }
        return { num: '0', unit: 's', wide: 's' };
    }
    const durationText = (s) => { const d = formatDuration(s); return d.num + ' ' + d.unit; };

    // A fixed half-life, up to 4 significant figures without trailing zeros ("5,700 years", "4.468 billion years").
    function formatHalfLife(s) {
        if (s === Infinity) return 'Stable';
        if (!(s > 0)) return 'Unknown';
        const trim = (v, n) => {
            let t = Number(v.toPrecision(n));
            return t >= 1000 ? t.toLocaleString('en-GB', { maximumFractionDigits: 0 }) : String(t);
        };
        if (s < 1e-12) {
            const e = Math.floor(Math.log10(s));
            return trim(s / Math.pow(10, e), 2) + ' × 10' + sup(e) + ' s';
        }
        const y = s / YEAR;
        if (y >= 1e12) { const e = Math.floor(Math.log10(y)); return trim(y / Math.pow(10, e), 3) + ' × 10' + sup(e) + ' years'; }
        if (y >= 1e9) return trim(y / 1e9, 4) + ' billion years';
        if (y >= 1e6) return trim(y / 1e6, 4) + ' million years';
        if (y >= 1e5) return trim(y / 1e3, 4) + ' thousand years';
        if (y >= 1) return trim(y, 4) + ' years';
        if (s >= 86400 * 2) return trim(s / 86400, 4) + ' days';
        if (s >= 3600 * 2) return trim(s / 3600, 4) + ' hours';
        if (s >= 120) return trim(s / 60, 4) + ' minutes';
        if (s >= 1) return trim(s, 4) + ' s';
        if (s >= 1e-3) return trim(s * 1e3, 4) + ' ms';
        if (s >= 1e-6) return trim(s * 1e6, 4) + ' µs';
        if (s >= 1e-9) return trim(s * 1e9, 4) + ' ns';
        return trim(s * 1e12, 4) + ' ps';
    }

    function formatEnergy(keV) {
        const a = Math.abs(keV);
        if (a >= 1000) return (keV / 1000).toFixed(a >= 1e5 ? 0 : (a >= 1e4 ? 1 : 2)) + ' MeV';
        return keV.toFixed(a >= 100 ? 0 : 1) + ' keV';
    }

    const MODE_NAMES = {
        b: 'β⁻', e: 'β⁺/EC', c: 'EC', z: 'β⁺', a: 'α', f: 'fission', i: 'γ',
        p: 'p', P: '2p', n: 'n', N: '2n', B: '2β⁻', C: '2EC', Z: '2β⁺',
    };
    const modeName = (code) => MODE_NAMES[code] || (code[0] === 'k' ? 'cluster' : code);

    function pctText(p) {
        const v = p * 100;
        if (v >= 99.995) return '100%';
        if (v >= 10) return v.toFixed(1).replace(/\.0$/, '') + '%';
        if (v >= 0.0001) return Number(v.toPrecision(2)) + '%';
        return '<0.0001%';
    }

    // Short summary of the decay modes ("alpha 96.9%, fission 3.1%"), splitting EC and beta+.
    function modesSummary(info, withPct) {
        if (info.stable) return 'stable';
        const parts = [];
        info.modes.forEach((m) => {
            if (m.code === 'e') {
                const f = positronShare(info);
                if (f > 0.995) parts.push({ t: 'β⁺', p: m.p });
                else if (f < 0.005) parts.push({ t: 'EC', p: m.p });
                else { parts.push({ t: 'β⁺', p: m.p * f }); parts.push({ t: 'EC', p: m.p * (1 - f) }); }
            } else parts.push({ t: modeName(m.code), p: m.p });
        });
        parts.sort((a, b) => b.p - a.p);
        // the short form leaves out rare branches (U-238's 0.00005% fission would only mislead)
        if (!withPct) return parts.filter((x, i) => i === 0 || x.p >= 0.01).slice(0, 2).map((x) => x.t).join(', ');
        return parts.filter((x) => x.p >= 1e-6).map((x) => x.t + ' ' + pctText(x.p)).join(', ');
    }

    // ------------------------------------------------------------------
    // Colours (theme)
    // ------------------------------------------------------------------
    let C = {};
    function readPalette() {
        const dark = document.documentElement.classList.contains('dark-mode');
        C = {
            dark,
            bg: dark ? '#16181c' : '#f4f6f8',
            text: dark ? '#e8eaed' : '#24272c',
            muted: dark ? '#9aa1ab' : '#5f6670',
            faint: dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.09)',
            panel: dark ? 'rgba(30,33,39,0.92)' : 'rgba(255,255,255,0.93)',
            panelSolid: dark ? '#1d2026' : '#ffffff',
            border: dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.13)',
            accent: '#f2849e',
            accentText: dark ? '#f2849e' : '#cc4c74',     // the accent as text: deeper on a light background
            // nucleons as in textbook pictures: crimson protons, light grey neutrons
            proton: '#d4203f',
            neutron: dark ? '#c6c8cc' : '#bdc0c5',
            protonText: dark ? '#f0607a' : '#c01d3a',      // the same colours as text
            neutronText: dark ? '#c6c8cc' : '#6c7079',
            electron: dark ? '#5cb8f2' : '#2f8fd6',
            positron: dark ? '#f6a04d' : '#e2862c',
            gamma: dark ? '#e07ad0' : '#c2459f',
            neutrino: dark ? 'rgba(220,224,230,0.55)' : 'rgba(60,66,76,0.5)',
            modes: {
                stable: dark ? '#eceff3' : '#24272c',
                b: dark ? '#4ea7f0' : '#2f8fd6',
                e: dark ? '#f39c4a' : '#e7862f',
                a: dark ? '#f2d14f' : '#e2b711',
                f: dark ? '#5fcf8c' : '#2fae64',
                p: dark ? '#ef5a6a' : '#de3a4d',
                n: dark ? '#a985ea' : '#8c63d6',
                i: dark ? '#e07ad0' : '#c2459f',
                unknown: dark ? '#4b5059' : '#c6cbd2',
                none: dark ? '#4b5059' : '#c6cbd2',
            },
        };
    }
    const modeColor = (code) => C.modes[chartCodeClass(code)] || C.modes.unknown;
    // Coloured text: the colour itself on the dark background, a deeper shade of it on the light one.
    const ink = (col) => (C.dark || col[0] !== '#' ? col : shadeColor(col, 0.72));
    function chartCodeClass(code) {
        if (!code) return 'unknown';
        if (code === 'b' || code === 'B' || code[0] === 'b') return 'b';
        if (code === 'e' || code === 'c' || code === 'z' || code === 'C' || code === 'Z' || code[0] === 'e') return 'e';
        if (code === 'a' || code[0] === 'k') return 'a';
        if (code === 'f') return 'f';
        if (code === 'p' || code === 'P') return 'p';
        if (code === 'n' || code === 'N' || code === 'capture') return 'n';
        if (code === 'i') return 'i';
        return 'unknown';
    }

    // ------------------------------------------------------------------
    // Nucleon packing. Every nucleus is a round ball built the same way for its A, so the same nuclide always
    // looks the same: 1 to 4 nucleons make a sphere, a pair, a triangle and a tetrahedron; 5 to 16 sit evenly
    // on one shell; bigger nuclei are concentric shells, each holding its share of a ball of even density
    // with its nucleons spread evenly over it. Positions are in nucleon spacings.
    // The protons are spread evenly through the ball: the sites are put in farthest-point order (each one the
    // site farthest from all those before it) and the first Z are protons, so a beta decay changes one site.
    // ------------------------------------------------------------------
    const SPACING = 1.62;           // nucleon spacing in nucleon radii: neighbours overlap a little, as in textbook pictures
    const shellCache = new Map();
    // n points spread evenly over the unit sphere (a Fibonacci spiral evened out by mutual repulsion, as in
    // the Thomson problem) and their smallest separation.
    function shellPoints(n) {
        if (shellCache.has(n)) return shellCache.get(n);
        const ga = Math.PI * (3 - Math.sqrt(5));
        const p = new Float64Array(n * 3), f = new Float64Array(n * 3);
        for (let i = 0; i < n; i++) {
            const y = 1 - (i + 0.5) * 2 / n, r = Math.sqrt(1 - y * y);
            p[i * 3] = Math.cos(i * ga) * r; p[i * 3 + 1] = y; p[i * 3 + 2] = Math.sin(i * ga) * r;
        }
        const iters = n <= 16 ? 400 : (n <= 60 ? 80 : 30);
        for (let it = 0; it < iters; it++) {
            f.fill(0);
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    const dx = p[i * 3] - p[j * 3], dy = p[i * 3 + 1] - p[j * 3 + 1], dz = p[i * 3 + 2] - p[j * 3 + 2];
                    const d2 = dx * dx + dy * dy + dz * dz + 1e-12, k = 1 / (d2 * Math.sqrt(d2));
                    f[i * 3] += dx * k; f[i * 3 + 1] += dy * k; f[i * 3 + 2] += dz * k;
                    f[j * 3] -= dx * k; f[j * 3 + 1] -= dy * k; f[j * 3 + 2] -= dz * k;
                }
            }
            const step = 0.5 / Math.pow(n, 1.5) * (1 - 0.7 * it / iters);
            for (let i = 0; i < n * 3; i += 3) {
                const x = p[i] + f[i] * step, y = p[i + 1] + f[i + 1] * step, z = p[i + 2] + f[i + 2] * step;
                const m = Math.hypot(x, y, z);
                p[i] = x / m; p[i + 1] = y / m; p[i + 2] = z / m;
            }
        }
        let dmin = 2;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) dmin = Math.min(dmin, Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]));
        }
        const res = { p, dmin };
        shellCache.set(n, res);
        return res;
    }
    // Turn a point about the x, y and z axes (so no two shells, and no spiral pole, line up with the view).
    function rotate(pt, ax, ay, az) {
        let [x, y, z] = pt, t;
        t = y * Math.cos(ax) - z * Math.sin(ax); z = y * Math.sin(ax) + z * Math.cos(ax); y = t;
        t = x * Math.cos(ay) + z * Math.sin(ay); z = -x * Math.sin(ay) + z * Math.cos(ay); x = t;
        t = x * Math.cos(az) - y * Math.sin(az); y = x * Math.sin(az) + y * Math.cos(az); x = t;
        return [x, y, z];
    }

    // The sites of a nucleus with A nucleons: { x, y, z (z towards the viewer), radius, order (farthest-point
    // order, protons first), depth (indices from back to front) }.
    const arrCache = [];
    function arrangement(A) {
        if (arrCache[A]) return arrCache[A];
        let P = [];
        const shell = (n, r, k) => {
            const s = shellPoints(n);
            for (let i = 0; i < n; i++) P.push(rotate([s.p[i * 3] * r, s.p[i * 3 + 1] * r, s.p[i * 3 + 2] * r], 0.9 + 0.71 * k, 0.4 + 1.13 * k, 0.25 + 0.57 * k));
        };
        if (A <= 1) P.push([0, 0, 0]);
        else if (A === 2) P = [[-0.5, 0, 0], [0.5, 0, 0]].map((p) => rotate(p, 0, 0.45, 0.2));
        else if (A === 3) {
            for (let i = 0; i < 3; i++) P.push(rotate([Math.cos(i * TAU / 3 + 0.3) / Math.sqrt(3), Math.sin(i * TAU / 3 + 0.3) / Math.sqrt(3), 0], 0.5, 0.35, 0));
        } else if (A === 4) {
            // a tetrahedron with a corner towards the viewer (tipped a little): all four show
            const rc = 1 / Math.sqrt(3), zb = -Math.sqrt(2 / 3) / 4;
            P = [[0, 0, -3 * zb]];
            for (let i = 0; i < 3; i++) P.push([Math.cos(i * TAU / 3 + 0.5) * rc, Math.sin(i * TAU / 3 + 0.5) * rc, zb]);
            P = P.map((p) => rotate(p, 0.45, -0.3, 0));
        } else if (A <= 16) shell(A, 0.94 / shellPoints(A).dmin, 0);
        else {
            // shells one spacing apart from the outside in, each with the nucleons of its slice of the ball
            const R = 0.5527 * Math.cbrt(A);      // radius of A close-packed nucleons, in spacings
            let done = 0;
            for (let k = 0; done < A; k++) {
                const ri = Math.max(0, R - k - 1);
                const cum = ri > 0 ? Math.round(A * (1 - Math.pow(ri / R, 3))) : A;
                const n = cum - done;
                if (n <= 0) continue;
                if (n === 1 && ri === 0) P.push([0, 0, 0]);
                else shell(n, Math.max(R - k - 0.5, n === 2 ? 0.47 : 0.94 / shellPoints(n).dmin), k);
                done = cum;
            }
        }
        const n = P.length;
        const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
        let radius = 0;
        P.forEach((p, i) => { x[i] = p[0]; y[i] = p[1]; z[i] = p[2]; radius = Math.max(radius, Math.hypot(p[0], p[1], p[2])); });
        // farthest-point order, from the frontmost site; ties go to the site further back
        const order = new Int16Array(n), dmin = new Float64Array(n).fill(Infinity), used = new Uint8Array(n);
        let cur = 0;
        for (let i = 1; i < n; i++) if (z[i] > z[cur] + 1e-9) cur = i;
        for (let c = 0; c < n; c++) {
            order[c] = cur; used[cur] = 1;
            let best = -1, bd = -1;
            for (let i = 0; i < n; i++) {
                if (used[i]) continue;
                const d = (x[i] - x[cur]) ** 2 + (y[i] - y[cur]) ** 2 + (z[i] - z[cur]) ** 2;
                if (d < dmin[i]) dmin[i] = d;
                if (dmin[i] > bd + 1e-9 || (dmin[i] > bd - 1e-9 && z[i] < z[best] - 1e-9)) { bd = dmin[i]; best = i; }
            }
            cur = best;
        }
        const depth = Array.from({ length: n }, (_, i) => i).sort((i, j) => z[i] - z[j]);
        return (arrCache[A] = { A: n, x, y, z, radius, order, depth });
    }
    // Which sites hold protons: 1 for a proton, 0 for a neutron.
    function siteTypes(arr, Z) {
        const t = new Uint8Array(arr.A);
        for (let i = 0; i < Z && i < arr.A; i++) t[arr.order[i]] = 1;
        return t;
    }

    // Shaded nucleon spheres for a nucleon radius r (CSS px) at k device px per CSS px: [type][shade], type 1
    // a proton, and the shades for depth (those at the back a little darker).
    const SHADES = 5;
    const nucleonCache = new Map();
    function nucleonSprites(r, k) {
        const id = r.toFixed(2) + '/' + k;
        if (nucleonCache.has(id)) return nucleonCache.get(id);
        const rp = r * k, size = Math.ceil(rp * 2 + 2), c0 = size / 2;
        const sprites = [C.neutron, C.proton].map((base) => {
            const list = [];
            for (let s = 0; s < SHADES; s++) {
                const d = 0.8 + 0.2 * s / (SHADES - 1);
                const c = document.createElement('canvas');
                c.width = c.height = size;
                const g = c.getContext('2d');
                // a soft highlight up and to the left, the colour, and a darker rim
                const grad = g.createRadialGradient(c0 - rp * 0.36, c0 - rp * 0.4, rp * 0.04, c0 - rp * 0.12, c0 - rp * 0.14, rp * 1.12);
                grad.addColorStop(0, shadeColor(base, 1.62, d));
                grad.addColorStop(0.28, shadeColor(base, 1.1, d));
                grad.addColorStop(0.7, shadeColor(base, 0.86, d));
                grad.addColorStop(1, shadeColor(base, 0.52, d));
                g.fillStyle = grad;
                g.beginPath(); g.arc(c0, c0, rp, 0, TAU); g.fill();
                if (!C.dark) {
                    g.strokeStyle = 'rgba(0,0,0,0.14)';
                    g.lineWidth = Math.max(0.6, k * 0.5);
                    g.stroke();
                }
                list.push(c);
            }
            return list;
        });
        nucleonCache.set(id, sprites);
        return sprites;
    }
    // hex lightened towards white (k > 1) or darkened (k < 1), then dimmed by d
    function shadeColor(hex, k, d) {
        const n = parseInt(hex.slice(1), 16);
        let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        if (k > 1) { const t = k - 1; r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t; } else { r *= k; g *= k; b *= k; }
        const m = d == null ? 1 : d;
        return `rgb(${Math.round(r * m)},${Math.round(g * m)},${Math.round(b * m)})`;
    }

    // A nucleus drawn into its own canvas: the nucleons from back to front, then a soft shadow round the rim
    // so the ball reads as round. { canvas, sw (size in CSS px), R (radius, CSS px), s (site spacing, CSS px),
    // arr, types }.
    function renderNucleus(Z, N, r, k) {
        const arr = arrangement(Math.max(1, Z + N));
        const s = r * SPACING, R = arr.radius * s + r;
        const half = Math.ceil(R + 2), size = Math.ceil(half * 2 * k);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const g = canvas.getContext('2d');
        const types = siteTypes(arr, Z);
        const sp = nucleonSprites(r, k), ns = sp[0][0].width;
        const zr = arr.radius || 1;
        for (const i of arr.depth) {
            const shade = Math.max(0, Math.min(SHADES - 1, Math.round((arr.z[i] / zr * 0.5 + 0.5) * (SHADES - 1))));
            g.drawImage(sp[types[i]][shade], (half + arr.x[i] * s) * k - ns / 2, (half + arr.y[i] * s) * k - ns / 2);
        }
        if (arr.A > 1) {
            g.globalCompositeOperation = 'source-atop';
            const rim = g.createRadialGradient(half * k, half * k, R * k * 0.4, half * k, half * k, R * k);
            rim.addColorStop(0, 'rgba(0,0,0,0)');
            rim.addColorStop(1, C.dark ? 'rgba(0,0,0,0.32)' : 'rgba(0,0,0,0.2)');
            g.fillStyle = rim;
            g.fillRect(0, 0, size, size);
            g.globalCompositeOperation = 'source-over';
        }
        return { canvas, sw: size / k, R, s, arr, types };
    }

    // The look of each nuclide at the current size, shared by all its nuclei (the most recently used kept).
    const lookCache = new Map();
    function nuclideLook(Z, N) {
        const id = Z * 400 + N;
        let l = lookCache.get(id);
        if (l) { lookCache.delete(id); lookCache.set(id, l); return l; }
        l = renderNucleus(Z, N, rN, dpr);
        lookCache.set(id, l);
        if (lookCache.size > 150) lookCache.delete(lookCache.keys().next().value);
        return l;
    }

    // ------------------------------------------------------------------
    // Bodies (nuclei and nucleons on the canvas)
    // ------------------------------------------------------------------
    function makeBody(Z, N, iso, x, y) {
        const b = {
            id: nextId++, Z, N, iso: iso ? 1 : 0, info: null, look: null, x, y, vx: 0, vy: 0, lx: x, ly: y,
            R: 4, sprite: null, sw: 0, clock: null, steps: [], step: null, transient: false, projectileUntil: 0,
            held: false, excited: 0, born: simTime, chain: [], glow: null, prev: null, pulse: 0, thrown: false,
        };
        setComposition(b, Z, N, iso, null);
        return b;
    }

    // Change what a body is made of: refresh its info and look, and record the step in its decay chain. When
    // the number of nucleons changes the old look fades into the new one.
    function setComposition(b, Z, N, iso, code) {
        const oldLook = b.look, oldA = b.Z + b.N;
        b.Z = Z; b.N = N; b.iso = iso && table.has(key(Z, N, 1)) ? 1 : 0;
        b.info = getInfo(Z, N, b.iso);
        b.chain.push({ Z, N, iso: b.iso, code });
        if (b.chain.length > 40) b.chain.splice(1, b.chain.length - 40);
        applyLook(b);
        if (oldLook && oldA !== Z + N && code !== 'f') b.prev = { look: oldLook, t: simTime };
        b.clock = null;
    }
    function applyLook(b) {
        b.look = nuclideLook(b.Z, b.N);
        b.sprite = b.look.canvas; b.sw = b.look.sw; b.R = b.look.R;
    }

    // The sites that change in a beta decay or electron capture (one per unit of charge): with the protons on
    // the first Z sites in farthest-point order, Z -> Z + 1 turns site Z into a proton.
    function changedSites(b, dZ) {
        const arr = b.look.arr, out = [];
        const from = dZ > 0 ? b.Z : b.Z + dZ, to = dZ > 0 ? b.Z + dZ : b.Z;
        for (let c = from; c < to && c < arr.A; c++) {
            const i = arr.order[c];
            out.push({ x: arr.x[i] * b.look.s, y: arr.y[i] * b.look.s, from: dZ > 0 ? 0 : 1, to: dZ > 0 ? 1 : 0 });
        }
        return out;
    }

    function addBody(Z, N, iso, x, y) {
        if (bodies.filter((o) => !o.transient).length >= MAX_BODIES) { showToast('The canvas is full: remove a few nuclei first'); return null; }
        const b = makeBody(Z, N, iso, x, y);
        bodies.push(b);
        afterFormed(b, 0);
        return b;
    }

    function startClock(b) {
        const info = b.info;
        if (info.stable) { b.clock = null; return; }
        // A setup can hold the clocks of nuclei whose own decay is far too slow to matter to it (the uranium in
        // the chain reaction, the tritium for fusion): on the speeded-up clock they would decay first.
        if (holdClock && holdClock(b)) { b.clock = null; return; }
        const hl = info.hl;
        const t = -hl / LN2 * Math.log(1 - Math.random());       // 1 - U is in (0, 1]
        const logHalf = Math.log10(hl);
        const logStart = Math.min(-9, logHalf - 2.5);
        b.clock = { logT: logStart, logStart, logHalf, logEnd: Math.log10(Math.max(t, 1e-30)), branch: null };
        // a member of the carbon-dating sample reads the sample's shared steady clock (its ring starts
        // nearer the half-life, which it passes within seconds)
        if (batch && batch.ids.has(b.id) && b.Z === batch.Z && b.N === batch.N) {
            b.clock.shared = true;
            b.clock.logStart = b.clock.logT = logHalf - 1.3;
        }
    }

    // ------------------------------------------------------------------
    // Decays
    // ------------------------------------------------------------------
    function pickBranch(info, force) {
        if (force) {
            const m = info.modes.find((x) => x.code === force || (force === 'z' || force === 'c') && x.code === 'e');
            if (m) return { mode: m, code: force === 'z' || force === 'c' ? force : m.code };
        }
        let r = Math.random(), m = info.modes[info.modes.length - 1];
        for (const x of info.modes) { if (r < x.p) { m = x; break; } r -= x.p; }
        let code = m.code;
        if (code === 'e') code = Math.random() < positronShare(info) ? 'z' : 'c';
        return { mode: m, code };
    }

    // Fission fragments: the heavy fragment peaks near A = 140 for actinides (shell effects near Z = 50, N = 82),
    // otherwise the split is symmetric; the charge divides in proportion to mass, with a little spread.
    function gauss() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v); }
    function fissionFragments(Z, N) {
        const A = Z + N;
        const nuBar = Math.max(1, 2.43 + 0.1 * (A - 236));
        for (let tries = 0; tries < 30; tries++) {
            const nu = Math.max(0, Math.min(6, Math.round(nuBar + gauss() * 1.0)));
            const Af = A - nu;
            const asym = A >= 220 && A <= 262;
            let AH = Math.round(asym ? 139.5 + gauss() * 4.5 : Af / 2 + Math.abs(gauss()) * 5);
            AH = Math.max(Math.ceil(Af / 2), Math.min(Af - 4, AH));
            const AL = Af - AH;
            const ZH = Math.round(Z * AH / Af + gauss() * 0.5);
            const ZL = Z - ZH;
            const NH = AH - ZH, NL = AL - ZL;
            if (ZL < 1 || NL < 0 || NH < 0) continue;
            if (tries < 25 && (!table.has(key(ZH, NH, 0)) || !table.has(key(ZL, NL, 0)))) continue;
            return { H: [ZH, NH], L: [ZL, NL], nu };
        }
        const ZH = Math.ceil(Z / 2), AH = Math.ceil(A / 2);
        return { H: [ZH, AH - ZH], L: [Z - ZH, A - AH - (Z - ZH)], nu: 0 };
    }

    // Plan one decay of body b: the steps to animate, the final make-up and the nuclear equation.
    function planDecay(b, force) {
        const info = b.info;
        const br = pickBranch(info, force);
        const code = br.code;
        let Z = b.Z, N = b.N, iso = 0;     // daughters form in the ground state, unless an isomer is fed below
        const steps = [];
        const eq = { lhs: [nucTok(Z, N, b.iso)], rhs: [], extra: [], Q: 0 };
        let nBetaPlus = 0;
        const emitted = { e: 0, ep: 0, nu: 0, nubar: 0, n: 0, p: 0, a: 0, g: [] };
        // One particle (or cluster) leaves: each step records what the nucleus becomes.
        const emit = (cz, cn, c) => {
            Z -= cz; N -= cn;
            steps.push({ kind: 'emit', cz, cn, to: [Z, N, 0, c] });
            if (cz === 2 && cn === 2) emitted.a++; else if (cz === 1 && cn === 0) emitted.p++; else if (cz === 0 && cn === 1) emitted.n++;
            else eq.extra.push(nucTok(cz, cn, 0));
        };
        switch (code) {
            case 'b': case 'B': {
                const k = code === 'B' ? 2 : 1;
                Z += k; N -= k; emitted.e += k; emitted.nubar += k;
                steps.push({ kind: 'beta', sign: -1, count: k });
                break;
            }
            case 'z': case 'Z': {
                const k = code === 'Z' ? 2 : 1;
                Z -= k; N += k; emitted.ep += k; emitted.nu += k; nBetaPlus += k;
                steps.push({ kind: 'beta', sign: 1, count: k });
                break;
            }
            case 'c': case 'C': {
                const k = code === 'C' ? 2 : 1;
                Z -= k; N += k; emitted.nu += k;
                for (let i = 0; i < k; i++) eq.lhs.push({ t: 'e-' });
                steps.push({ kind: 'ec', count: k });
                break;
            }
            case 'a': emit(2, 2, 'a'); break;
            case 'p': emit(1, 0, 'p'); break;
            case 'P': emit(1, 0, 'P'); emit(1, 0, 'P'); break;
            case 'n': emit(0, 1, 'n'); break;
            case 'N': emit(0, 1, 'N'); emit(0, 1, 'N'); break;
            case 'i':
                emitted.g.push(info.isoE);
                steps.push({ kind: 'gamma', energies: [info.isoE], iso: 0 });
                break;
            case 'f': break;
            default:
                if (code[0] === 'k') {
                    const [cz, cn] = code.slice(1).split('.').map(Number);
                    emit(cz, cn, code);
                }
        }
        // Isomer fed by this beta- decay (e.g. Cs-137 -> Ba-137m)
        if (code === 'b' && isoFeeds.has(key(b.Z, b.N, 0))) {
            const f = isoFeeds.get(key(b.Z, b.N, 0));
            if (Math.random() < f[3]) iso = 1;
        }
        if (steps.length && (steps[0].kind === 'beta' || steps[0].kind === 'ec')) steps[0].to = [Z, N, iso, code];
        // Delayed emission after the beta decay (e.g. Li-9 -> Be-9* -> Be-8 + n)
        let fiss = null;
        const sub = br.mode.sub;
        if (sub && sub.length && code !== 'i') {
            let r = Math.random();
            for (const sb of sub) {
                if (r < sb.p) {
                    const c = sb.code[1];
                    if (c === 'n' || c === 'N' || (c >= '3' && c <= '7')) {
                        const k = c === 'n' ? 1 : (c === 'N' ? 2 : +c);
                        for (let i = 0; i < k && N > 0; i++) emit(0, 1, 'n');
                    } else if (c === 'p' || c === 'P') {
                        for (let i = 0; i < (c === 'P' ? 2 : 1) && Z > 0; i++) emit(1, 0, 'p');
                    } else if (c === 'a' && Z >= 2 && N >= 2) emit(2, 2, 'a');
                    else if (c === 'f') fiss = fissionFragments(Z, N);
                    iso = 0;
                    break;
                }
                r -= sb.p;
            }
        }
        if (code === 'f') fiss = fissionFragments(Z, N);
        if (fiss) {
            steps.push({ kind: 'fission', H: fiss.H, L: fiss.L, nu: fiss.nu, from: [Z, N] });
            emitted.n += fiss.nu;
            Z = fiss.H[0]; N = fiss.H[1]; iso = 0;
            eq.extra.push(nucTok(fiss.L[0], fiss.L[1], 0));
        }
        // Gammas from the de-excitation of the daughter (measured lines of this decay mode)
        const lines = info.gam && info.gam[br.mode.code];
        if (lines && code !== 'i' && !fiss) {
            const es = [];
            for (const [E, I] of lines) if (Math.random() * 100 < I) es.push(E);
            if (es.length) { steps.push({ kind: 'gamma', energies: es.slice(0, 3), iso }); emitted.g.push(...es.slice(0, 3)); }
        }
        // Equation and energy released (atomic mass excesses; beta+ also creates an electron-positron pair)
        eq.rhs.push(nucTok(Z, N, iso));
        eq.extra.forEach((t) => eq.rhs.push(t));
        const push = (t, k) => { if (k > 0) eq.rhs.push(Object.assign({ k }, t)); };
        push({ t: 'a' }, emitted.a); push({ t: 'p' }, emitted.p); push({ t: 'n' }, emitted.n);
        push({ t: 'e-' }, emitted.e); push({ t: 'e+' }, emitted.ep);
        push({ t: 'nubar' }, emitted.nubar); push({ t: 'nu' }, emitted.nu); push({ t: 'g' }, emitted.g.length);
        let Q = info.me - massExcess(Z, N, iso) - emitted.a * ME_HE4 - emitted.p * ME_H - emitted.n * ME_N - nBetaPlus * 2 * M_E;
        if (fiss) Q -= massExcess(fiss.L[0], fiss.L[1], 0);
        eq.extra.forEach((t) => { if (t.t === 'nuc' && !fiss) Q -= massExcess(t.Z, t.N, 0); });
        eq.Q = Q;
        eq.code = code;
        return { code, steps, eq, final: [Z, N, iso] };
    }

    function nucTok(Z, N, iso) { return { t: 'nuc', Z, N, iso }; }

    const TAGS = {
        b: 'β⁻ decay', B: 'double β⁻ decay', z: 'β⁺ decay', Z: 'double β⁺ decay',
        c: 'electron capture', C: 'double electron capture', a: 'α decay', p: 'proton emission', P: 'two-proton emission',
        n: 'neutron emission', N: 'two-neutron emission', i: 'γ emission', f: 'fission',
    };

    function beginDecay(b, force) {
        const plan = planDecay(b, force);
        b.clock = null;
        b.steps = plan.steps.slice();
        b.pendingEq = plan.eq;
        b.pendingTag = TAGS[plan.code] || (plan.code[0] === 'k' ? 'cluster decay' : 'decay');
        b.pendingCode = plan.code;
        nextStep(b);
    }

    const STEP_DUR = { beta: 0.85, ec: 1.0, emit: 0.6, fission: 1.1, gamma: 0.55, capture: 0.45 };
    const FIRE_AT = { beta: 0.45, ec: 0.55, emit: 0.15, fission: 0.5, gamma: 0.35, capture: 0.3 };
    function nextStep(b) {
        const st = b.steps.shift();
        if (!st) { b.step = null; afterFormed(b, 0.15); return; }
        st.t = 0;
        st.dur = STEP_DUR[st.kind];
        st.fired = false;
        st.dir = b.forceDir != null ? b.forceDir : Math.random() * TAU;
        // beta-: a neutron becomes a proton; beta+ and electron capture: a proton becomes a neutron
        if (st.kind === 'beta' || st.kind === 'ec') st.sites = changedSites(b, st.kind === 'beta' && st.sign < 0 ? st.count : -st.count);
        if (st.kind === 'gamma') b.excited = 1;
        b.step = st;
    }

    // A body has just formed (or finished decaying): its clock starts after a short pause.
    function afterFormed(b, delay) {
        b.clockDelay = delay;
        b.clock = null;
        b.needsClock = true;
    }

    function logEquation(b) {
        if (!b.pendingEq) return;
        eqLog.push({ eq: b.pendingEq, color: modeColor(b.pendingCode), t: realTime });
        if (eqLog.length > 30) eqLog.shift();
        if (S.showTags && (!chainRx || b.pendingCode === 'f')) addTag(b.x, b.y - b.R - 10, b.pendingTag, b.pendingCode === 'capture' ? C.accent : modeColor(b.pendingCode), b);
        b.pendingEq = null;
    }

    function updateStep(b, dt) {
        const st = b.step;
        st.t += dt;
        const u = st.t / st.dur;
        if (!st.fired && u >= FIRE_AT[st.kind]) {
            st.fired = true;
            fireStep(b, st);
        }
        if (u >= 1) nextStep(b);
    }

    function fireStep(b, st) {
        const cx = b.x, cy = b.y;
        logEquation(b);
        if (st.kind === 'beta' || st.kind === 'ec') {
            const minus = st.kind === 'beta' && st.sign < 0;
            const col = minus ? C.electron : C.positron;
            st.sites.forEach((sv, i) => {
                const a = st.dir + i * 2.4;
                if (st.kind === 'beta') {
                    spawnSpark(minus ? 'e-' : 'e+', cx + sv.x, cy + sv.y, a, b.R);
                    spawnSpark(minus ? 'nubar' : 'nu', cx + sv.x, cy + sv.y, a + 2.2 + Math.random() * 1.6, b.R);
                } else spawnSpark('nu', cx + sv.x, cy + sv.y, st.dir + Math.PI + i, b.R);
                addFlash(cx + sv.x, cy + sv.y, rN * 3.2, col);
            });
            b.glow = { sites: st.sites, t: simTime, color: st.kind === 'ec' ? C.modes.e : col };
            const to = st.to;
            setComposition(b, to[0], to[1], to[2], to[3]);
            b.pulse = 1;
        } else if (st.kind === 'emit') {
            const dir = st.dir;
            const ex = cx + Math.cos(dir) * b.R, ey = cy + Math.sin(dir) * b.R;
            const p = makeBody(st.cz, st.cn, 0, ex, ey);
            p.transient = true;
            p.emitted = true;
            const alpha = st.cz === 2 && st.cn === 2, m = st.cz + st.cn;
            const sp = radBase() * (alpha ? SPEED.a : (m > 1 ? SPEED.cluster : (st.cz ? SPEED.p : SPEED.n)));
            p.vx = Math.cos(dir) * sp; p.vy = Math.sin(dir) * sp;
            p.projectileUntil = simTime + MIRROR_LIFE;
            p.ignore = [b.id];
            p.gen = b.gen || 0;     // a delayed neutron from a fission fragment belongs to that fission's generation
            bodies.push(p);
            const M = b.Z + b.N;
            b.vx -= p.vx * m / Math.max(1, M) * 0.6; b.vy -= p.vy * m / Math.max(1, M) * 0.6;
            // the trail in the colour of the radiation (alpha) or of the nucleon (p, n)
            const nucleon = m === 1;
            const col = nucleon ? (st.cz ? C.proton : C.neutron) : C.modes.a;
            const text = alpha ? 'α' : (nucleon ? (st.cz ? 'p' : 'n') : shortName(st.cz, st.cn, 0));
            p.trail = { color: col, text, ink: nucleon ? (st.cz ? C.protonText : C.neutronText) : ink(C.modes.a) };
            addFlash(ex, ey, rN * 4, col);
            const to = st.to;
            setComposition(b, to[0], to[1], to[2], to[3]);
            b.pulse = 1;
        } else if (st.kind === 'gamma') {
            st.energies.forEach((E, i) => spawnSpark('g', cx, cy, st.dir + i * 2.3, b.R, E));
            if (b.iso !== st.iso) setComposition(b, b.Z, b.N, st.iso, 'i');
            addFlash(cx, cy, b.R * 1.6, C.gamma);
            b.excited = 0;
        } else if (st.kind === 'fission') {
            fissionSplit(b, st);
        } else if (st.kind === 'capture') {
            // de-excitation gamma of a freshly combined nucleus
            if (st.energy != null) spawnSpark('g', cx, cy, st.dir, b.R, st.energy);
            b.excited = 0;
        }
    }

    // A neutron flying out of a fission or a decay (it ignores the nuclei it came from). gen: the generation of
    // the fission that freed it (0 for the neutron that starts a chain reaction).
    function launchNeutron(x, y, angle, ignore, gen) {
        const n = makeBody(0, 1, 0, x, y);
        n.transient = true;
        n.emitted = true;
        n.gen = gen || 0;
        const sp = radBase() * SPEED.n * (chainRx ? CHAIN_NEUTRON_SPEED : 1);
        n.vx = Math.cos(angle) * sp; n.vy = Math.sin(angle) * sp;
        n.projectileUntil = simTime + MIRROR_LIFE;
        n.ignore = ignore;
        n.trail = { color: C.neutron, text: 'n', ink: C.neutronText };
        bodies.push(n);
        return n;
    }

    function fissionSplit(b, st) {
        const dir = st.dir;
        const [ZH, NH] = st.H, [ZL, NL] = st.L;
        const cx = b.x, cy = b.y;
        const light = makeBody(ZL, NL, 0, cx, cy);
        light.chain = b.chain.slice();
        light.chain.push({ Z: ZL, N: NL, iso: 0, code: 'f' });
        setComposition(b, ZH, NH, 0, 'f');
        const sep = (b.R + light.R) * 0.55;
        b.x = cx - Math.cos(dir) * sep; b.y = cy - Math.sin(dir) * sep;
        light.x = cx + Math.cos(dir) * sep; light.y = cy + Math.sin(dir) * sep;
        // the fragments fly apart with equal and opposite momenta, then slow down
        const v = Math.min(viewW, viewH) * SPEED.fragment;
        const AH = ZH + NH, AL = ZL + NL;
        b.vx = -Math.cos(dir) * v * AL / (AH + AL) * 2; b.vy = -Math.sin(dir) * v * AL / (AH + AL) * 2;
        light.vx = Math.cos(dir) * v * AH / (AH + AL) * 2; light.vy = Math.sin(dir) * v * AH / (AH + AL) * 2;
        b.thrown = false;
        light.pulse = b.pulse = 1;
        bodies.push(light);
        afterFormed(light, 0.5);
        b.gen = light.gen = st.gen || 0;
        if (chainRx && st.gen) chainRx.gens[st.gen - 1] = (chainRx.gens[st.gen - 1] || 0) + 1;
        for (let i = 0; i < st.nu; i++) {
            const a = dir + Math.PI / 2 + (i - (st.nu - 1) / 2) * 0.9 + (Math.random() - 0.5) * 0.5 + (i % 2 ? Math.PI : 0);
            launchNeutron(cx, cy, a, [b.id, light.id], st.gen || 0);
        }
        addFlash(cx, cy, (b.R + light.R) * 2.2, C.modes.f);
        for (let i = 0; i < 2; i++) spawnSpark('g', cx, cy, Math.random() * TAU, (b.R + light.R) * 0.5, 0);
    }

    // ------------------------------------------------------------------
    // Combining (drop one thing onto another, or a collision)
    // ------------------------------------------------------------------
    // Busy: in the middle of a decay. A nucleus still to give off its capture gamma is not: it can take in
    // more at once (the gamma goes straight away).
    function busy(b) { return b.steps.length > 0 || !!(b.step && b.step.kind !== 'capture'); }
    function settleCapture(b) {
        if (!b.step || b.step.kind !== 'capture' || b.steps.length) return;
        if (!b.step.fired) { b.step.fired = true; fireStep(b, b.step); }
        b.step = null;
    }

    // Combine two bodies into target. impact: they met in flight, so the collision itself leaves the new
    // nucleus excited (it gives off a gamma even when the fusion takes in energy).
    function combine(target, other, impact) {
        const Z = target.Z + other.Z, N = target.N + other.N;
        if (Z + N > MAX_A || Z > MAX_Z) { showToast('Too big to build: the limit here is ' + MAX_A + ' nucleons'); return false; }
        if (busy(target) || busy(other)) return false;
        settleCapture(target); settleCapture(other);
        const meBefore = massExcess(target.Z, target.N, target.iso) + massExcess(other.Z, other.N, other.iso);
        const lhs = [nucTok(other.Z, other.N, other.iso), nucTok(target.Z, target.N, target.iso)];
        const isNeutron = other.Z === 0 && other.N === 1;
        const fissile = isNeutron && FISSILE[target.Z + ',' + target.N];
        // the combined nucleus: centre of mass, momentum conserved
        const mT = target.Z + target.N, mO = other.Z + other.N;
        const x = (target.x * mT + other.x * mO) / (mT + mO), y = (target.y * mT + other.y * mO) / (mT + mO);
        const vx = (target.vx * mT + other.vx * mO) / (mT + mO), vy = (target.vy * mT + other.vy * mO) / (mT + mO);
        const wasSelected = selectedId === other.id;
        removeBody(other);
        if (wasSelected) selectedId = target.id;
        // something thrown keeps flying (and taking in what it meets) as part of the new nucleus
        if (other.thrown && !other.emitted) target.thrown = true;
        target.x = x; target.y = y; target.vx = vx; target.vy = vy;
        target.clock = null;
        target.needsClock = false;
        setComposition(target, Z, N, 0, 'capture');
        target.pulse = 1;
        const Q = meBefore - target.info.me;
        addFlash(target.x, target.y, target.R * 1.8, isNeutron ? C.modes.n : C.accent, target);
        const unbound = !target.info.stable && target.info.hl < 1e-15;
        if (fissile && (other.forceFission || Math.random() < fissile)) {
            // induced fission: n + U-235 -> U-236* -> two fragments + neutrons
            const fr = fissionFragments(Z, N);
            const eq = { lhs, rhs: [nucTok(fr.H[0], fr.H[1], 0), nucTok(fr.L[0], fr.L[1], 0)], code: 'f', star: nucTok(Z, N, 0) };
            if (fr.nu) eq.rhs.push({ t: 'n', k: fr.nu });
            eq.Q = meBefore - massExcess(fr.H[0], fr.H[1], 0) - massExcess(fr.L[0], fr.L[1], 0) - fr.nu * ME_N;
            target.pendingEq = eq;
            target.pendingTag = 'induced fission';
            target.pendingCode = 'f';
            target.excited = 1;
            target.steps = [{ kind: 'fission', H: fr.H, L: fr.L, nu: fr.nu, from: [Z, N], gen: (other.gen || 0) + 1 }];
            target.step = { kind: 'capture', t: 0, dur: 0.35, fired: true, dir: 0 };
            return true;
        }
        const eq = { lhs, rhs: [nucTok(Z, N, 0)], code: 'capture', Q };
        const gamma = (Q > 0 || impact) && !unbound;
        if (gamma) eq.rhs.push({ t: 'g', k: 1 });
        target.pendingEq = eq;
        target.pendingTag = isNeutron ? 'neutron capture' : (other.Z === 1 && other.N === 0 ? 'proton capture' : 'fusion');
        target.pendingCode = isNeutron ? 'n' : 'capture';
        logEquation(target);
        if (gamma) {
            target.excited = 1;
            target.step = { kind: 'capture', t: 0, dur: STEP_DUR.capture, fired: false, dir: Math.random() * TAU, energy: Math.max(0, Q) };
        } else {
            afterFormed(target, 0.25);
        }
        return true;
    }

    function removeBody(b) {
        const i = bodies.indexOf(b);
        if (i >= 0) bodies.splice(i, 1);
        if (selectedId === b.id) selectedId = 0;
        drags.forEach((d, id) => { if (d.body === b) drags.delete(id); });
    }

    // ------------------------------------------------------------------
    // Light particles and effects
    // ------------------------------------------------------------------
    const radBase = () => Math.sqrt(viewW * viewH);    // px: the canvas size the radiation speeds are given in
    // A light particle leaving (x, y); its label shows once it is `clear` px out (past the nucleus it left).
    function spawnSpark(kind, x, y, angle, clear, energy) {
        if (sparks.length >= MAX_SPARKS) sparks.shift();
        const sp = radBase() * (kind === 'g' ? SPEED.g : (kind === 'nu' || kind === 'nubar' ? SPEED.nu : SPEED.e));
        const s = { kind, x, y, ox: x, oy: y, clear: (clear || 0) + 10, vx: Math.cos(angle) * sp, vy: Math.sin(angle) * sp, age: 0, energy: energy || 0, trail: [] };
        if (kind === 'e+') s.annihilateAt = 0.9 + Math.random() * 0.5;    // s: a positron soon meets an electron
        sparks.push(s);
    }
    // Emitted radiation fades out as it leaves (age in s of simulation time).
    const fadeOf = (age, life) => Math.max(0, Math.min(1, ((life || FADE_AT + FADE_LEN) - age) / FADE_LEN));
    // A flash of light (following a moving nucleus, if given one).
    function addFlash(x, y, r, color, body) {
        // (one at a time on a moving nucleus: flashes on top of each other would wash it out)
        const same = body && effects.find((e) => e.kind === 'flash' && e.body === body);
        if (same) { same.age = 0; same.r = r; return; }
        effects.push({ kind: 'flash', x, y, r, color, age: 0, life: 0.45, body: body || null });
    }
    // A short label over a nucleus that has just decayed ("alpha decay"); it rises, fades and follows the nucleus.
    function addTag(x, y, text, color, body) {
        // the same thing again (a thrown nucleus taking in one after another): count it on the same label
        const same = body && effects.find((e) => e.kind === 'tag' && e.body === body && e.text === text && e.age < e.life * 0.8);
        if (same) { same.count = (same.count || 1) + 1; same.age = Math.min(same.age, 0.2); return; }
        // in a busy scene a label right next to a fresh one would only cover it up
        for (const e of effects) if (e.kind === 'tag' && e.body !== body && e.age < 0.9 && Math.abs(e.x - x) < 90 && Math.abs(e.y - e.rise - y) < 30) return;
        let stack = 0;
        for (const e of effects) if (e.kind === 'tag' && e.age < 1 && (body ? e.body === body : Math.hypot(e.x - x, e.y - y) < 40)) stack += 1;
        effects.push({ kind: 'tag', x, y, text, color, body: body || null, stack, rise: 0, age: 0, life: 2.2 });
    }
    function showToast(text, life) { toast = { text, age: 0, life: life || 2.8 }; }

    // dt: simulation time (radiation, flashes); dtReal: real time (labels and messages, to stay readable)
    function updateSparks(dt, dtReal) {
        for (let i = sparks.length - 1; i >= 0; i--) {
            const s = sparks[i];
            s.age += dt;
            s.x += s.vx * dt; s.y += s.vy * dt;
            if (s.kind === 'e-' || s.kind === 'e+') {
                const n = s.trail.length;
                if (!n || Math.hypot(s.x - s.trail[n - 2], s.y - s.trail[n - 1]) > 3) s.trail.push(s.x, s.y);
                if (s.trail.length > 24) s.trail.splice(0, 2);
            }
            if (s.annihilateAt && s.age >= s.annihilateAt) {
                // e+ + e- -> two 511 keV photons, back to back
                const a = Math.random() * TAU;
                spawnSpark('g', s.x, s.y, a, 4, M_E);
                spawnSpark('g', s.x, s.y, a + Math.PI, 4, M_E);
                addFlash(s.x, s.y, rN * 3, C.positron);
                sparks.splice(i, 1);
                continue;
            }
            const m = 60;
            if (s.x < -m || s.y < -m || s.x > viewW + m || s.y > viewH + m || s.age > FADE_AT + FADE_LEN) sparks.splice(i, 1);
        }
        for (let i = effects.length - 1; i >= 0; i--) {
            const e = effects[i];
            if (e.kind === 'tag') {
                e.age += dtReal;
                e.rise += 9 * dtReal;
                if (e.body && bodies.indexOf(e.body) >= 0) { e.x = e.body.x; e.y = e.body.y - e.body.R - 10; }
            } else {
                e.age += dt;
                if (e.body && bodies.indexOf(e.body) >= 0) { e.x = e.body.x; e.y = e.body.y; }
            }
            if (e.age >= e.life) effects.splice(i, 1);
        }
        if (toast) { toast.age += dtReal; if (toast.age > toast.life) toast = null; }
    }

    // ------------------------------------------------------------------
    // Body motion
    // ------------------------------------------------------------------
    function workRect() {
        const m = 6;
        return { x0: m, y0: m, x1: viewW - m, y1: viewH - m };
    }

    // The space a resting body needs: its nucleus, gauge and the label underneath (names are wider than nuclei).
    function bodyBox(b) {
        const lw = b.labelW || b.info.name.length * fontPx * 0.55;
        const lines = (chainRx || b.clock && b.clock.shared) && b.id !== selectedId ? 1 : (b.info.stable || b.clock || b.needsClock ? 2 : 1);
        return {
            hw: Math.max(b.R + 6, lw / 2 + 9),
            top: b.R + 7,
            bottom: b.R + 8 + fontPx * (1.25 * lines + (b.id === selectedId ? 1.2 : 0)),
        };
    }

    // A free neutron kept in play by the reflecting walls (not one that has leaked out through the reflector).
    const mirroredNeutron = (b) => S.mirrorWalls && b.Z === 0 && !b.leaked;

    // Something fast that takes in what it hits: a free neutron, or a nucleus that was thrown (or knocked).
    function isProjectile(b) {
        if (b.held) return false;
        if (b.emitted) return b.Z === 0 && b.N === 1 && b.projectileUntil > simTime;
        return (b.thrown || b.projectileUntil > simTime) && Math.hypot(b.vx, b.vy) > 120;
    }
    // Distance from (px, py) to the segment (ax, ay)-(bx, by): the path a body covered this frame.
    function segDist(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const u = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
        return Math.hypot(px - ax - u * dx, py - ay - u * dy);
    }

    // dt: simulation time; clockDt: clock decades; dtReal: real time (for what the user throws)
    function updateBodies(dt, clockDt, dtReal) {
        const wr = workRect();
        const obstacles = [];
        if (S.showChart && layout) obstacles.push(layout.inset);
        panelRects.forEach((r) => obstacles.push(r));
        if (batch && !paused) batch.t += batch.rate * dt;
        for (let i = bodies.length - 1; i >= 0; i--) {
            const b = bodies[i];
            if (b.pulse > 0) b.pulse = Math.max(0, b.pulse - dt * 3);
            if (b.step) updateStep(b, dt);
            else if (b.needsClock) {
                b.clockDelay -= dt;
                if (b.clockDelay <= 0) { b.needsClock = false; startClock(b); }
            } else if (b.clock && !paused) {
                let logNow = b.clock.logT + clockDt;
                if (b.clock.shared) logNow = Math.log10(Math.max(1e-30, batch ? batch.t : 0));
                b.clock.logT = Math.max(b.clock.logStart, logNow);
                if (logNow >= b.clock.logEnd) { b.clock.logT = b.clock.logEnd; beginDecay(b); }
            }
            b.lx = b.x; b.ly = b.y;
            if (b.held) continue;
            const mdt = b.thrown ? dtReal : dt;      // what the user throws moves in real time
            b.x += b.vx * mdt; b.y += b.vy * mdt;
            const speed = Math.hypot(b.vx, b.vy);
            if (b.transient && !S.keepParticles) {
                // emitted particles fly straight off the canvas (or bounce off neutron mirrors), fading as they go
                const mirrored = mirroredNeutron(b);
                // a neutron set free inside the reflector is mostly sent back into it (a few get through it and
                // are lost); any other bounces off the canvas walls
                if (b.inReflector === undefined) b.inReflector = !!reflector && b.x > reflector.x0 && b.x < reflector.x1 && b.y > reflector.y0 && b.y < reflector.y1;
                if (mirrored && b.inReflector && reflector) {
                    const r = reflector;
                    const out = b.x < r.x0 + b.R || b.x > r.x1 - b.R || b.y < r.y0 + b.R || b.y > r.y1 - b.R;
                    if (out && Math.random() > REFLECTOR_ALBEDO) {
                        b.leaked = true;
                        b.projectileUntil = 0;
                        b.born = simTime - FADE_AT;     // fades out as it leaves
                    } else bounceWalls(b, r, 1);
                } else if (mirrored) bounceWalls(b, wr, 1);
                const m = b.R + 4;
                const life = mirrored ? MIRROR_LIFE : FADE_AT + FADE_LEN;
                if (b.x < -m || b.y < -m || b.x > viewW + m || b.y > viewH + m || simTime - b.born > life) { removeBody(b); continue; }
            } else {
                const damp = Math.exp(-mdt / (b.transient ? 1.6 : 0.6));
                b.vx *= damp; b.vy *= damp;
                // a kept particle comes to rest and joins the rest (a free neutron starts its clock)
                if (b.transient && speed < 25) { b.transient = false; b.emitted = false; afterFormed(b, 0); }
                if (b.thrown && speed < 20) b.thrown = false;
                bounceWalls(b, wr, 0.45);
            }
        }
        // Resting bodies keep their nuclei and labels apart: overlapping boxes are pushed apart along the
        // shorter overlap. (Not something flying through: it would push its targets out of its way.)
        const boxes = bodies.map((b) => (b.transient || isProjectile(b) ? null : bodyBox(b)));
        const k = Math.min(1, dt * 8);
        for (let i = 0; i < bodies.length; i++) {
            const a = bodies[i], ba = boxes[i];
            if (!ba) continue;
            for (let j = i + 1; j < bodies.length; j++) {
                const c = bodies[j], bc = boxes[j];
                if (!bc || a.held || c.held) continue;   // a nucleus being dragged may be dropped onto another
                const dx = c.x - a.x;
                const ox = ba.hw + bc.hw - Math.abs(dx);
                if (ox <= 0) continue;
                const oy = Math.min(a.y + ba.bottom, c.y + bc.bottom) - Math.max(a.y - ba.top, c.y - bc.top);
                if (oy <= 0) continue;
                if (ox < oy) {
                    const sx = dx >= 0 ? 1 : -1;
                    a.x -= sx * ox * k * 0.5; c.x += sx * ox * k * 0.5;
                } else {
                    const sy = (c.y + (bc.bottom - bc.top) / 2) >= (a.y + (ba.bottom - ba.top) / 2) ? 1 : -1;
                    a.y -= sy * oy * k * 0.5; c.y += sy * oy * k * 0.5;
                }
            }
        }
        // ...but never under the chart or a text panel (these win over the spacing above).
        for (const b of bodies) {
            if (!b.transient && !b.held) obstacles.forEach((r) => pushOutOfRect(b, r, 1));
        }
        // Fast things hit what is in their way: a neutron is captured by any nucleus it meets (no charge, no
        // barrier), and a thrown nucleus takes in each lighter one along its path, slowing down as it gains
        // mass (momentum is conserved). The test covers this frame's whole path, so nothing slips through, and
        // each body merges at most once a frame.
        const merged = new Set();
        for (const p of bodies.slice()) {
            if (merged.has(p) || bodies.indexOf(p) < 0 || !isProjectile(p)) continue;
            for (const t of bodies) {
                if (t === p || t.transient || t.held || merged.has(t) || (p.ignore && p.ignore.indexOf(t.id) >= 0)) continue;
                const reach = Math.max(t.R, p.R) * 0.85 + Math.min(t.R, p.R) * 0.5;
                if (segDist(t.x, t.y, p.lx, p.ly, p.x, p.y) >= reach || busy(t)) continue;
                const big = p.Z + p.N > t.Z + t.N ? p : t;    // the heavier takes in the lighter
                const small = big === p ? t : p;
                // A free neutron is not always caught: most nuclei (fission fragments among them) take in slow
                // neutrons far less readily than uranium-235 or plutonium-239 does, which keeps a chain going, and
                // the lightest (deuterium, tritium, helium) hardly ever do.
                const caught = !p.emitted || FISSILE[t.Z + ',' + t.N] || (t.Z + t.N > 4 && Math.random() < NEUTRON_CATCH);
                if (caught && combine(big, small, true)) { merged.add(big); merged.add(small); } else (p.ignore || (p.ignore = [])).push(t.id);
                break;
            }
        }
    }

    // Keep a body inside the canvas: a resting nucleus with its whole label, a flying particle by its radius.
    function bounceWalls(b, wr, rest) {
        const bx = b.transient ? { hw: b.R, top: b.R, bottom: b.R } : bodyBox(b);
        const left = wr.x0 + bx.hw, right = Math.max(left, wr.x1 - bx.hw);
        const top = wr.y0 + bx.top, bottom = Math.max(top, wr.y1 - bx.bottom);
        if (b.x < left) { b.x = left; b.vx = Math.abs(b.vx) * rest; }
        if (b.x > right) { b.x = right; b.vx = -Math.abs(b.vx) * rest; }
        if (b.y < top) { b.y = top; b.vy = Math.abs(b.vy) * rest; }
        if (b.y > bottom) { b.y = bottom; b.vy = -Math.abs(b.vy) * rest; }
    }

    // Keep a resting body (with its label) out of an overlay rectangle: the chart inset or a text panel.
    function pushOutOfRect(b, r, k) {
        const bx = bodyBox(b);
        const x0 = r.x - bx.hw, x1 = r.x + r.w + bx.hw, y0 = r.y - bx.bottom, y1 = r.y + r.h + bx.top;
        if (b.x <= x0 || b.x >= x1 || b.y <= y0 || b.y >= y1) return;
        // Leave by the nearest side that has room for the body beyond it (never into a wall, where it would
        // stay stuck under the rectangle); if none has, by the side with the most space.
        const wr = workRect();
        const sides = [
            { d: b.x - x0, room: x0 - wr.x0 - b.R, dx: -1, dy: 0 },
            { d: x1 - b.x, room: wr.x1 - x1 - b.R, dx: 1, dy: 0 },
            { d: b.y - y0, room: y0 - wr.y0 - bx.top, dx: 0, dy: -1 },
            { d: y1 - b.y, room: wr.y1 - y1 - bx.bottom, dx: 0, dy: 1 },
        ];
        const fits = sides.filter((sd) => sd.room >= 0).sort((a, c) => a.d - c.d);
        const sd = fits.length ? fits[0] : sides.sort((a, c) => c.room - a.room)[0];
        b.x += sd.dx * sd.d * k;
        b.y += sd.dy * sd.d * k;
    }

    // ------------------------------------------------------------------
    // Layout of the overlays for this canvas size
    // ------------------------------------------------------------------
    function computeLayout() {
        const tall = viewH > viewW * 0.85;
        const pad = Math.max(6, Math.min(12, viewW / 90));
        // The chart is taller than it is wide (Z across, N up): beside the nuclei on a wide canvas, in the
        // lower corner on a tall one. The nuclear equations go under it, right-aligned.
        const cw = chartZMax + 3, ch = chartNMax + 3;
        const eqFs = Math.max(13, Math.min(20, viewW / 58));
        const eqLineH = eqFs * 1.7;
        let w, h, inset, eq;
        if (tall) {
            // two lines of equations along the bottom, the chart just above them
            w = Math.min(viewW * 0.38, 170); h = w * ch / cw;
            const eqH = S.showEquations ? 2 * eqLineH + eqFs * 0.5 : 0;
            inset = { x: viewW - w - pad, y: viewH - h - pad - (eqH ? eqH + pad * 0.6 : 0), w, h };
            eq = { right: viewW - pad, top: viewH - pad - eqH, bottom: viewH - pad, lines: 2, maxW: viewW - 2 * pad, fromTop: true };
        } else {
            h = Math.max(120, Math.min(viewH * 0.56, 330)); w = h * cw / ch;
            inset = { x: viewW - w - pad, y: pad, w, h };
            const top = S.showChart ? inset.y + h + pad * 0.8 : pad;
            const lines = Math.max(1, Math.min(4, Math.floor((viewH - pad - top - eqFs * 0.5) / eqLineH)));
            eq = { right: viewW - pad, top, bottom: viewH - pad, lines, maxW: Math.max(w, viewW * 0.5), fromTop: S.showChart };
        }
        layout = { tall, pad, inset, eq, eqFs };
        insetCache = null;
    }

    // ------------------------------------------------------------------
    // Chart of nuclides (Segre chart), as in textbooks: protons Z across, neutrons N up. Each element is a
    // column, and the stable valley climbs above the N = Z line towards N = 1.5 Z.
    // The inset shows the whole chart, or zooms in on the selected nucleus's history (where it started, each
    // step since and where it is now). Its view is the chart point at its centre and the size of a square in
    // px, easing towards its target.
    // ------------------------------------------------------------------
    let insetCache = null;
    const insetView = { z: 0, n: 0, cell: 0 };
    const INSET_PAD = 6;
    const MIN_ROWS = 26;             // zoomed in on a single nuclide, the inset still shows this many rows
    const chartList = [];            // [Z, N] of every ground state in the table
    function buildChartList() {
        chartList.length = 0;
        table.forEach((rec) => {
            if (rec.iso) return;
            chartList.push([rec.Z, rec.N]);
        });
    }
    function chartColorOf(Z, N) {
        return C.modes[chartClass(getInfo(Z, N, 0))];
    }

    // The cells with zFrom <= Z <= zTo and nFrom <= N <= nTo; (x0, y0) is the top-left corner of the cell
    // (Z = zFrom, N = nTo).
    function renderChartCells(g, x0, y0, cell, zFrom, zTo, nFrom, nTo) {
        const gap = cell >= 6 ? Math.min(1.5, cell * 0.08) : 0;
        for (const it of chartList) {
            const Z = it[0], N = it[1];
            if (Z < zFrom || Z > zTo || N < nFrom || N > nTo) continue;
            g.fillStyle = chartColorOf(Z, N);
            g.fillRect(x0 + (Z - zFrom) * cell, y0 + (nTo - N) * cell, cell - gap, cell - gap);
        }
    }

    // The squares a body's history covers.
    function historyBox(b) {
        let z0 = b.Z, z1 = b.Z, n0 = b.N, n1 = b.N;
        b.chain.forEach((c) => { z0 = Math.min(z0, c.Z); z1 = Math.max(z1, c.Z); n0 = Math.min(n0, c.N); n1 = Math.max(n1, c.N); });
        return { z0, z1, n0, n1 };
    }
    function insetFullView(r) {
        const zMax = chartZMax + 2, nMax = chartNMax + 2;
        return { z: zMax / 2, n: nMax / 2, cell: Math.min((r.w - INSET_PAD * 2) / (zMax + 1), (r.h - INSET_PAD * 2) / (nMax + 1)) };
    }
    function insetTarget(r) {
        const full = insetFullView(r);
        const sel = selectedBody();
        if (!sel || sel.transient || !S.showChart) return full;
        const bx = historyBox(sel), m = 2.5;            // a margin of two and a half squares
        const w = r.w - INSET_PAD * 2, h = r.h - INSET_PAD * 2;
        const cell = Math.max(full.cell, Math.min(w / (bx.z1 - bx.z0 + 1 + 2 * m), h / (bx.n1 - bx.n0 + 1 + 2 * m), h / MIN_ROWS));
        // centred on the history, but not past the edges of the chart
        const centre = (c, half, max) => (half * 2 >= max + 1 ? max / 2 : Math.max(half - 0.5, Math.min(max + 0.5 - half, c)));
        return { z: centre((bx.z0 + bx.z1) / 2, w / 2 / cell, chartZMax + 2), n: centre((bx.n0 + bx.n1) / 2, h / 2 / cell, chartNMax + 2), cell };
    }
    function updateInsetView(dt) {
        if (!layout) return;
        const t = insetTarget(layout.inset), v = insetView;
        if (!(v.cell > 0) || dt <= 0) { if (!(v.cell > 0)) Object.assign(v, t); return; }
        const k = 1 - Math.exp(-dt / 0.2);
        v.z += (t.z - v.z) * k; v.n += (t.n - v.n) * k;
        v.cell = Math.exp(Math.log(v.cell) + (Math.log(t.cell) - Math.log(v.cell)) * k);
        if (Math.abs(t.z - v.z) < 0.01 && Math.abs(t.n - v.n) < 0.01 && Math.abs(t.cell / v.cell - 1) < 0.002) Object.assign(v, t);
    }
    const insetToScreen = (r, Z, N) => [r.x + r.w / 2 + (Z - insetView.z) * insetView.cell, r.y + r.h / 2 - (N - insetView.n) * insetView.cell];

    function drawInsetChart() {
        const r = layout.inset, v = insetView;
        const zMax = chartZMax + 2, nMax = chartNMax + 2;
        const zoomed = v.cell > insetFullView(r).cell * 1.3;
        const fs = Math.max(9, Math.min(11, r.w / 16));
        let c = insetCache;
        if (!c || c.theme !== C.dark || c.w !== r.w || c.h !== r.h || c.dpr !== dpr || c.z !== v.z || c.n !== v.n || c.cell !== v.cell) {
            const canvasEl = c && c.w === r.w && c.h === r.h && c.dpr === dpr ? c.canvas : document.createElement('canvas');
            canvasEl.width = Math.ceil(r.w * dpr); canvasEl.height = Math.ceil(r.h * dpr);
            const g = canvasEl.getContext('2d');
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            roundRect(g, 0.5, 0.5, r.w - 1, r.h - 1, 6);
            g.fillStyle = C.panel; g.fill();
            g.strokeStyle = C.border; g.lineWidth = 1; g.stroke();
            g.save();
            roundRect(g, 1, 1, r.w - 2, r.h - 2, 5); g.clip();
            const cell = v.cell;
            const X = (Z) => r.w / 2 + (Z - v.z) * cell, Y = (N) => r.h / 2 - (N - v.n) * cell;
            // the chart's own extent (in the full view the lines stop at its edges)
            const x0 = Math.max(0, X(-0.5)), x1 = Math.min(r.w, X(zMax + 0.5)), y0 = Math.max(0, Y(nMax + 0.5)), y1 = Math.min(r.h, Y(-0.5));
            // magic numbers: faint lines (Z = m upright, N = m across), N = Z dashed
            g.strokeStyle = C.faint; g.lineWidth = Math.max(1, Math.min(2, cell * 0.12));
            MAGIC.forEach((m) => {
                if (m <= zMax) { g.beginPath(); g.moveTo(X(m), y0); g.lineTo(X(m), y1); g.stroke(); }
                if (m <= nMax) { g.beginPath(); g.moveTo(x0, Y(m)); g.lineTo(x1, Y(m)); g.stroke(); }
            });
            const zFrom = Math.max(0, Math.floor(v.z - r.w / 2 / cell) - 1), zTo = Math.min(zMax, Math.ceil(v.z + r.w / 2 / cell) + 1);
            const nFrom = Math.max(0, Math.floor(v.n - r.h / 2 / cell) - 1), nTo = Math.min(nMax, Math.ceil(v.n + r.h / 2 / cell) + 1);
            renderChartCells(g, X(zFrom) - cell / 2, Y(nTo) - cell / 2, cell, zFrom, zTo, nFrom, nTo);
            const k = Math.min(zMax, nMax);
            g.setLineDash([3, 3]);
            g.strokeStyle = C.muted; g.globalAlpha = 0.6; g.lineWidth = 1;
            g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(k), Y(k)); g.stroke();
            g.setLineDash([]); g.globalAlpha = 1;
            g.restore();
            // axis captions and the hint, in the empty corner above the valley (on a backing when zoomed in)
            const caption = (t, x, y, align, base, w8) => {
                g.font = font(w8, fs);
                if (zoomed) {
                    const tw = g.measureText(t).width;
                    const bx = align === 'right' ? x - tw - 3 : x - 3, by = base === 'top' ? y - 1 : y - fs - 1;
                    roundRect(g, bx, by, tw + 6, fs + 3, 3);
                    g.fillStyle = C.panelSolid; g.globalAlpha = 0.85; g.fill(); g.globalAlpha = 1;
                }
                g.fillStyle = C.muted; g.textAlign = align; g.textBaseline = base;
                g.fillText(t, x, y);
            };
            if (!zoomed) {
                caption('Z →', r.w - INSET_PAD, r.h - INSET_PAD + 1, 'right', 'bottom', 700);
                caption('N ↑', INSET_PAD, INSET_PAD - 1, 'left', 'top', 700);
                caption('tap to', INSET_PAD, INSET_PAD + fs * 1.25, 'left', 'top', 300);
                caption('enlarge', INSET_PAD, INSET_PAD + fs * 2.35, 'left', 'top', 300);
            } else caption('tap to enlarge', r.w - INSET_PAD, INSET_PAD - 1, 'right', 'top', 300);
            c = insetCache = { canvas: canvasEl, theme: C.dark, w: r.w, h: r.h, dpr, z: v.z, n: v.n, cell: v.cell };
        }
        ctx.drawImage(c.canvas, r.x, r.y, r.w, r.h);
        const sel = selectedBody();
        if (!sel || sel.transient) return;
        const cell = v.cell;
        const toXY = (Z, N) => insetToScreen(r, Z, N);
        ctx.save();
        roundRect(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, 5); ctx.clip();
        drawChainPath(sel, toXY, Math.max(1.2, Math.min(3, cell * 0.18 + 0.9)), Math.max(3, Math.min(9, cell * 0.5 + 3)));
        const [x, y] = toXY(sel.Z, sel.N);
        ctx.strokeStyle = C.text; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, Math.max(3.5, Math.min(cell * 2.4, cell * 0.5 + 5)), 0, TAU); ctx.stroke();
        ctx.restore();
        if (!zoomed) return;
        // where the nucleus is: its proton number under its column, its neutron number beside its row
        const tag = (t, tx, ty, align) => {
            ctx.font = font(700, fs);
            const tw = ctx.measureText(t).width;
            const bx = Math.max(r.x + 3, Math.min(r.x + r.w - tw - 9, align === 'center' ? tx - tw / 2 - 3 : tx));
            const by = Math.max(r.y + fs * 1.6, Math.min(r.y + r.h - fs - 7, ty - fs / 2 - 2));
            roundRect(ctx, bx, by, tw + 6, fs + 4, 3);
            ctx.fillStyle = C.panelSolid; ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1;
            ctx.fillStyle = C.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillText(t, bx + 3, by + fs / 2 + 2.5);
        };
        tag('Z = ' + sel.Z, x, r.y + r.h - fs, 'center');
        tag('N = ' + sel.N, r.x + 3, y, 'left');
    }

    // The decay path of a body on a chart: one arrow per step, in the colour of the decay, with a dark (or
    // light) outline so a yellow alpha arrow still shows over the yellow alpha squares. toXY(Z, N) -> [x, y]:
    // a beta- step goes down and right, an alpha step down and left by two.
    function drawChainPath(b, toXY, lw, head) {
        const ch = b.chain;
        if (ch.length < 2) return;
        const halo = C.dark ? 'rgba(10,11,14,0.85)' : 'rgba(255,255,255,0.9)';
        const ow = Math.max(1.5, lw * 0.9);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (let pass = 0; pass < 2; pass++) {
            for (let i = 1; i < ch.length; i++) {
                const a = ch[i - 1], c = ch[i];
                if (a.Z === c.Z && a.N === c.N) continue;
                const [x0, y0] = toXY(a.Z, a.N), [x1, y1] = toXY(c.Z, c.N);
                const col = pass === 0 ? halo : (c.code === 'capture' ? C.accent : modeColor(c.code));
                ctx.strokeStyle = col; ctx.fillStyle = col;
                ctx.lineWidth = pass === 0 ? lw + ow * 2 : lw;
                if (c.code === 'f' && pass === 1) ctx.setLineDash([lw * 2, lw * 2]);
                ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
                ctx.setLineDash([]);
                const ang = Math.atan2(y1 - y0, x1 - x0);
                const len = Math.hypot(x1 - x0, y1 - y0);
                if (len > head * 0.8) {
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x1 - Math.cos(ang - 0.45) * head, y1 - Math.sin(ang - 0.45) * head);
                    ctx.lineTo(x1 - Math.cos(ang + 0.45) * head, y1 - Math.sin(ang + 0.45) * head);
                    ctx.closePath();
                    if (pass === 0) { ctx.lineWidth = ow * 2; ctx.stroke(); }
                    ctx.fill();
                }
            }
        }
        ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    }

    // Expanded chart: most of the canvas, with zoom, pan, a legend and a nuclide picker. The view is the
    // centre (cZ, cN) and the size of one square in px.
    const chartView = { open: false, cZ: 40, cN: 60, cell: 4, pick: null, pointers: new Map(), pinch: null, moved: false };
    function chartRects() {
        const m = Math.max(6, layout.pad);
        const panel = { x: m, y: m, w: viewW - 2 * m, h: viewH - 2 * m };
        const fs = Math.max(11, Math.min(14, viewW / 70));
        const head = Math.round(fs * 2.6);
        const legendH = Math.round(fs * 1.9) * (viewW < 560 ? 2 : 1);
        const pickH = chartView.pick ? Math.round(fs * 2.9) : 0;
        // outer: the chart with its axes; area: the cells. Above the cells, the Z = 2, 8, ... magic numbers;
        // under them, room for two lines (an element's symbol and Z under its column); on the left, the N
        // numbers (N = 2, 8, ... in bold) and the axis title.
        const outer = { x: panel.x + 8, y: panel.y + head, w: panel.w - 16, h: panel.h - head - legendH - pickH - 8 };
        const L = Math.round(fs * 3.4), B = Math.round(fs * 2.3), T = Math.round(fs * 1.3);
        const area = { x: outer.x + L, y: outer.y + T, w: outer.w - L, h: outer.h - B - T };
        const btn = Math.max(30, Math.min(38, fs * 2.5));
        const by = panel.y + (head - btn) / 2;
        const close = { x: panel.x + panel.w - btn - 6, y: by, w: btn, h: btn };
        const fit = { x: close.x - btn - 6, y: by, w: btn, h: btn };
        const zin = { x: fit.x - btn - 4, y: by, w: btn, h: btn };
        const zout = { x: zin.x - btn - 4, y: by, w: btn, h: btn };
        const pick = chartView.pick ? { x: panel.x + 8, y: outer.y + outer.h + 4, w: panel.w - 16, h: pickH - 4 } : null;
        const add = pick ? { x: pick.x + pick.w - btn * 2.2, y: pick.y + (pick.h - btn) / 2, w: btn * 2.2, h: btn } : null;
        return { panel, outer, area, fs, head, legendH, close, fit, zin, zout, pick, add, btn };
    }
    function chartFitCell(rr) { return Math.min(rr.area.w / (chartZMax + 4), rr.area.h / (chartNMax + 4)); }
    function openChart() {
        chartView.pick = null;
        const rr = chartRects();
        chartView.open = true;
        const sel = selectedBody();
        if (sel && !sel.transient) {
            // Frame the selected nucleus's history, as the inset does, with squares big enough to carry their
            // mass numbers; if the whole path does not fit at that size, keep the nucleus itself in view.
            const { z0, z1, n0, n1 } = historyBox(sel);
            const spanZ = Math.max(12, z1 - z0 + 6), spanN = Math.max(MIN_ROWS, n1 - n0 + 6);
            chartView.cell = Math.min(40, Math.max(20, Math.min(rr.area.w / spanZ, rr.area.h / spanN)));
            const halfZ = rr.area.w / 2 / chartView.cell - 1.5, halfN = rr.area.h / 2 / chartView.cell - 1.5;
            chartView.cZ = Math.max(sel.Z - halfZ, Math.min(sel.Z + halfZ, (z0 + z1) / 2));
            chartView.cN = Math.max(sel.N - halfN, Math.min(sel.N + halfN, (n0 + n1) / 2));
        } else {
            chartView.cell = chartFitCell(rr);
            chartView.cZ = chartZMax / 2; chartView.cN = chartNMax / 2;
        }
        clampChartView(rr);
    }
    function clampChartView(rr) {
        const fitC = chartFitCell(rr);
        chartView.cell = Math.max(fitC, Math.min(48, chartView.cell));
        const halfZ = rr.area.w / 2 / chartView.cell, halfN = rr.area.h / 2 / chartView.cell;
        const zMid = (chartZMax + 1) / 2, nMid = (chartNMax + 1) / 2;
        chartView.cZ = halfZ * 2 >= chartZMax + 4 ? zMid : Math.max(halfZ - 2, Math.min(chartZMax + 2 - halfZ, chartView.cZ));
        chartView.cN = halfN * 2 >= chartNMax + 4 ? nMid : Math.max(halfN - 2, Math.min(chartNMax + 2 - halfN, chartView.cN));
    }
    // (Z, N) -> canvas px, and back: Z to the right, N up.
    function chartToScreen(rr, Z, N) {
        return [rr.area.x + rr.area.w / 2 + (Z - chartView.cZ) * chartView.cell, rr.area.y + rr.area.h / 2 - (N - chartView.cN) * chartView.cell];
    }
    function screenToChart(rr, x, y) {
        return [chartView.cZ + (x - rr.area.x - rr.area.w / 2) / chartView.cell, chartView.cN - (y - rr.area.y - rr.area.h / 2) / chartView.cell];
    }

    const LEGEND = [['stable', 'Stable'], ['b', 'β⁻'], ['e', 'β⁺ / EC'], ['a', 'α'], ['f', 'Fission'], ['p', 'p emission'], ['n', 'n emission'], ['unknown', 'Unknown']];
    function drawExpandedChart() {
        const rr = chartRects();
        const P = rr.panel, A = rr.area, fs = rr.fs;
        ctx.fillStyle = C.dark ? 'rgba(10,11,14,0.55)' : 'rgba(40,44,52,0.25)';
        ctx.fillRect(0, 0, viewW, viewH);
        roundRect(ctx, P.x, P.y, P.w, P.h, 8);
        ctx.fillStyle = C.panelSolid; ctx.fill();
        ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
        // title
        ctx.font = `700 ${fs * 1.05}px "Source Sans Pro", Helvetica, sans-serif`;
        ctx.fillStyle = C.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const title = rr.zout.x - P.x > fs * 18 ? 'Chart of nuclides: tap a square to see it' : 'Chart of nuclides';
        ctx.fillText(title, P.x + 12, P.y + rr.head / 2);
        drawChartButton(rr.zout, '−'); drawChartButton(rr.zin, '+'); drawChartButton(rr.fit, '⤢'); drawChartButton(rr.close, '×');
        // cells
        ctx.save();
        ctx.beginPath(); ctx.rect(A.x, A.y, A.w, A.h); ctx.clip();
        const cell = chartView.cell;
        const [zA, nA] = screenToChart(rr, A.x, A.y + A.h), [zB, nB] = screenToChart(rr, A.x + A.w, A.y);
        const z0 = Math.floor(zA) - 1, z1 = Math.ceil(zB) + 1, n0 = Math.floor(nA) - 1, n1 = Math.ceil(nB) + 1;
        // magic numbers: Z = m is a column line, N = m a row line
        ctx.strokeStyle = C.faint; ctx.lineWidth = Math.max(1, cell * 0.12);
        MAGIC.forEach((m) => {
            const [x, y] = chartToScreen(rr, m, m);
            if (m < 126) { ctx.beginPath(); ctx.moveTo(x, A.y); ctx.lineTo(x, A.y + A.h); ctx.stroke(); }
            ctx.beginPath(); ctx.moveTo(A.x, y); ctx.lineTo(A.x + A.w, y); ctx.stroke();
        });
        const [tlx, tly] = chartToScreen(rr, z0 - 0.5, n1 + 0.5);
        renderChartCells(ctx, tlx, tly, cell, z0, z1, n0, n1);
        // N = Z
        ctx.setLineDash([4, 4]); ctx.strokeStyle = C.muted; ctx.lineWidth = 1; ctx.globalAlpha = 0.7;
        const [ax, ay] = chartToScreen(rr, -1, -1), [bx, by] = chartToScreen(rr, 130, 130);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        // labels inside the squares when zoomed in: the symbol over the mass number in big squares, the mass
        // number alone in middling ones (each column is one element, named under the chart)
        if (cell >= 18) {
            const two = cell >= 28;
            const f1 = two ? Math.min(cell * 0.32, 15) : Math.min(cell * 0.42, 13);
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            for (const it of chartList) {
                const Z = it[0], N = it[1];
                if (Z < z0 || Z > z1 || N < n0 || N > n1) continue;
                const [x, y] = chartToScreen(rr, Z, N);
                const cls = chartClass(getInfo(Z, N, 0));
                ctx.fillStyle = (cls === 'stable' && C.dark) || cls === 'a' || cls === 'e' || (cls === 'unknown' && !C.dark) ? '#1d1f24' : '#ffffff';
                if (two) {
                    ctx.font = font(700, f1);
                    ctx.fillText(elementSymbol(Z), x, y - f1 * 0.5);
                    ctx.font = font(300, f1 * 0.9);
                    ctx.fillText(String(Z + N), x, y + f1 * 0.6);
                } else {
                    ctx.font = font(700, f1);
                    ctx.fillText(String(Z + N), x, y);
                }
            }
        }
        // decay path of the selected nucleus
        const sel = selectedBody();
        const toXY = (Z, N) => chartToScreen(rr, Z, N);
        if (sel) {
            drawChainPath(sel, toXY, Math.max(2, Math.min(4, cell * 0.18)), Math.max(7, Math.min(12, cell * 0.5)));
            ctx.strokeStyle = C.text; ctx.lineWidth = 2;
            const [x, y] = toXY(sel.Z, sel.N);
            ctx.beginPath(); ctx.arc(x, y, Math.max(6, cell * 0.85), 0, TAU); ctx.stroke();
        }
        if (chartView.pick) {
            const [x, y] = toXY(chartView.pick.Z, chartView.pick.N);
            ctx.strokeStyle = C.accent; ctx.lineWidth = 2.5;
            ctx.strokeRect(x - cell / 2 - 1.5, y - cell / 2 - 1.5, cell + 3, cell + 3);
        }
        ctx.restore();
        // axes: Z along the bottom (each column's element when there is room), N up the left side
        const step = [1, 2, 5, 10, 20, 50].find((v) => v * cell >= fs * 2.4) || 50;
        ctx.fillStyle = C.muted;
        ctx.font = font(700, fs * 0.85);
        const capZ = 'Protons Z →', capN = 'Neutrons N →';
        const capZW = ctx.measureText(capZ).width;
        const by0 = A.y + A.h + 4;
        ctx.textAlign = 'right'; ctx.textBaseline = 'top';
        ctx.fillText(capZ, A.x + A.w, by0 + (cell >= 16 ? fs * 0.9 : 0));
        ctx.save();
        ctx.translate(rr.outer.x, A.y + A.h); ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(capN, 0, 0);
        ctx.restore();
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const zRight = A.x + A.w - capZW - fs;
        const zTop = Math.min(chartZMax, zB), nTop = Math.min(chartNMax, nB);   // numbers only where there are nuclides
        if (cell >= 16) {
            for (let z = Math.max(0, Math.ceil(zA)); z <= Math.floor(zTop); z++) {
                const [x] = chartToScreen(rr, z, 0);
                if (x < A.x + cell * 0.3) continue;
                ctx.font = font(700, Math.min(fs * 0.85, cell * 0.55));
                if (x < zRight || cell < 22) ctx.fillText(elementSymbol(z), x, by0);
                if (cell >= 22 && x < zRight) { ctx.font = font(300, fs * 0.7); ctx.fillText(String(z), x, by0 + fs * 0.95); }
            }
        } else {
            ctx.font = font(300, fs * 0.8);
            for (let z = Math.max(0, Math.ceil(zA / step) * step); z <= zTop; z += step) {
                const [x] = chartToScreen(rr, z, 0);
                if (x > A.x + 6 && x < zRight) ctx.fillText(String(z), x, by0);
            }
        }
        // magic numbers: Z = m over its column, N = m (bold, in place of a number) beside its row; a caption that
        // would run into the one before it is left out
        ctx.font = font(700, fs * 0.75);
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        let lastRight = -1e9;
        MAGIC.forEach((m) => {
            if (m > chartZMax) return;
            const [x] = chartToScreen(rr, m, 0);
            const t = 'Z=' + m, w = ctx.measureText(t).width;
            if (x - w / 2 < A.x - 2 || x + w / 2 > A.x + A.w + 2 || x - w / 2 < lastRight + 4) return;
            ctx.fillText(t, x, A.y - 2);
            lastRight = x + w / 2;
        });
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        const magicRows = [];
        MAGIC.forEach((m) => {
            const [, y] = chartToScreen(rr, 0, m);
            if (y < A.y + 4 || y > A.y + A.h - 2) return;   // (the axis title is further left, clear of these)
            if (magicRows.some((v) => Math.abs(v - y) < fs * 0.95)) return;
            ctx.fillText('N=' + m, A.x - 4, y);
            magicRows.push(y);
        });
        ctx.font = font(300, fs * 0.8);
        for (let n = Math.max(0, Math.ceil(nA / step) * step); n <= nTop; n += step) {
            const [, y] = chartToScreen(rr, 0, n);
            if (magicRows.some((v) => Math.abs(v - y) < fs * 0.95)) continue;
            if (y > A.y + 6 && y < A.y + A.h - 2) ctx.fillText(String(n), A.x - 4, y);
        }
        // legend
        const ly = P.y + P.h - rr.legendH;
        ctx.font = `300 ${fs * 0.9}px "Source Sans Pro", Helvetica, sans-serif`;
        ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        const rows = viewW < 560 ? 2 : 1;
        const perRow = Math.ceil(LEGEND.length / rows);
        const rowH = rr.legendH / rows;
        for (let r = 0; r < rows; r++) {
            const items = LEGEND.slice(r * perRow, (r + 1) * perRow);
            const sw = fs * 0.75, gap = fs * 0.9;
            const widths = items.map(([, t]) => sw + 5 + ctx.measureText(t).width);
            const total = widths.reduce((s, w) => s + w, 0) + gap * (items.length - 1);
            let x = P.x + Math.max(10, (P.w - total) / 2);
            const y = ly + rowH * (r + 0.5) - 2;
            items.forEach(([cls, t], i) => {
                ctx.fillStyle = C.modes[cls];
                ctx.fillRect(x, y - sw / 2, sw, sw);
                if (cls === 'stable' && !C.dark) { ctx.strokeStyle = C.border; ctx.strokeRect(x, y - sw / 2, sw, sw); }
                ctx.fillStyle = C.text;
                ctx.fillText(t, x + sw + 5, y);
                x += widths[i] + gap;
            });
        }
        // picked nuclide
        if (rr.pick) {
            const pk = chartView.pick, info = getInfo(pk.Z, pk.N, 0);
            const R = rr.pick;
            roundRect(ctx, R.x, R.y, R.w, R.h, 6);
            ctx.fillStyle = C.dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)'; ctx.fill();
            ctx.fillStyle = C.modes[chartClass(info)];
            ctx.fillRect(R.x + 8, R.y + R.h / 2 - fs * 0.45, fs * 0.9, fs * 0.9);
            ctx.font = `700 ${fs}px "Source Sans Pro", Helvetica, sans-serif`;
            ctx.fillStyle = C.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            const maxW = rr.add.x - R.x - fs * 2.2;
            let line = info.name + '  ·  ' + (info.stable ? 'stable' : formatHalfLife(info.hl) + '  ·  ' + modesSummary(info, false));
            line = fitText(line, maxW);
            ctx.fillText(line, R.x + 8 + fs * 1.3, R.y + R.h / 2);
            roundRect(ctx, rr.add.x, rr.add.y, rr.add.w, rr.add.h, 5);
            ctx.fillStyle = C.accent; ctx.fill();
            ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
            ctx.fillText('Add', rr.add.x + rr.add.w / 2, rr.add.y + rr.add.h / 2 + 0.5);
        }
    }
    function drawChartButton(r, glyph) {
        roundRect(ctx, r.x, r.y, r.w, r.h, 5);
        ctx.fillStyle = C.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'; ctx.fill();
        ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `700 ${r.h * 0.55}px "Source Sans Pro", Helvetica, sans-serif`;
        ctx.fillText(glyph, r.x + r.w / 2, r.y + r.h / 2 + 1);
    }
    function fitText(t, maxW) {
        if (ctx.measureText(t).width <= maxW) return t;
        while (t.length > 3 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
        return t + '…';
    }

    // ------------------------------------------------------------------
    // Drawing helpers
    // ------------------------------------------------------------------
    function roundRect(g, x, y, w, h, r) {
        g.beginPath();
        g.moveTo(x + r, y);
        g.arcTo(x + w, y, x + w, y + h, r);
        g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r);
        g.arcTo(x, y, x + w, y, r);
        g.closePath();
    }
    const font = (w, px) => `${w} ${px}px "Source Sans Pro", Helvetica, sans-serif`;

    // Nuclide in A/Z notation (mass number over atomic number, before the symbol). Returns the width.
    function drawNotation(g, Z, N, iso, x, y, fs, draw) {
        const A = Z + N;
        let sym, top, bot;
        if (Z === 0 && N === 1) { sym = 'n'; top = '1'; bot = '0'; }
        else if (Z === 1 && N === 0) { sym = 'p'; top = '1'; bot = '1'; }
        else { sym = elementSymbol(Z); top = A + (iso ? 'm' : ''); bot = String(Z); }
        return drawScripted(g, sym, top, bot, x, y, fs, draw);
    }
    function drawScripted(g, sym, top, bot, x, y, fs, draw) {
        const sf = fs * 0.62;
        g.font = font(700, sf);
        const wt = top ? g.measureText(top).width : 0, wb = bot ? g.measureText(bot).width : 0;
        const ws = Math.max(wt, wb);
        if (draw) {
            g.textAlign = 'right';
            g.textBaseline = 'alphabetic';
            if (top) g.fillText(top, x + ws, y - fs * 0.42);
            if (bot) g.fillText(bot, x + ws, y + fs * 0.24);
        }
        g.font = font(700, fs);
        const w = g.measureText(sym).width;
        if (draw) { g.textAlign = 'left'; g.fillText(sym, x + ws + 1, y); }
        return ws + 1 + w;
    }
    // One token of an equation; returns its width.
    function drawToken(g, tok, x, y, fs, draw) {
        let w = 0;
        if (tok.k > 1) {
            g.font = font(700, fs);
            const t = tok.k + ' ';
            if (draw) { g.textAlign = 'left'; g.fillText(t, x, y); }
            w += g.measureText(t).width;
        }
        x += w;
        switch (tok.t) {
            case 'nuc': return w + drawNotation(g, tok.Z, tok.N, tok.iso, x, y, fs, draw);
            case 'a': return w + drawScripted(g, 'He', '4', '2', x, y, fs, draw);
            case 'p': return w + drawScripted(g, 'p', '1', '1', x, y, fs, draw);
            case 'n': return w + drawScripted(g, 'n', '1', '0', x, y, fs, draw);
            case 'e-': return w + drawScripted(g, 'e', '0', '−1', x, y, fs, draw);
            case 'e+': return w + drawScripted(g, 'e', '0', '+1', x, y, fs, draw);
            case 'g': {
                g.font = font(700, fs);
                if (draw) { g.textAlign = 'left'; g.fillText('γ', x, y); }
                return w + g.measureText('γ').width;
            }
            case 'nu': case 'nubar': {
                g.font = font(700, fs);
                const wn = g.measureText('ν').width;
                if (draw) {
                    g.textAlign = 'left';
                    g.fillText('ν', x, y);
                    if (tok.t === 'nubar') { g.fillRect(x + wn * 0.08, y - fs * 0.78, wn * 0.84, Math.max(1, fs * 0.08)); }
                }
                g.font = font(700, fs * 0.6);
                if (draw) g.fillText('e', x + wn, y + fs * 0.22);
                return w + wn + g.measureText('e').width;
            }
            default: return w;
        }
    }
    function drawEquation(g, eq, x, y, fs, draw) {
        let cx = x;
        const opGap = fs * 0.35;
        const op = (t) => {
            g.font = font(300, fs);
            if (draw) { g.textAlign = 'left'; g.fillText(t, cx + opGap, y); }
            cx += g.measureText(t).width + opGap * 2;
        };
        eq.lhs.forEach((t, i) => { if (i) op('+'); cx += drawToken(g, t, cx, y, fs, draw); });
        if (eq.star) {
            op('→');
            cx += drawToken(g, eq.star, cx, y, fs, draw);
            g.font = font(700, fs);
            if (draw) g.fillText('*', cx, y);
            cx += g.measureText('*').width;
        }
        op('→');
        eq.rhs.forEach((t, i) => { if (i) op('+'); cx += drawToken(g, t, cx, y, fs, draw); });
        return cx - x;
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------
    function selectedBody() { return selectedId ? bodies.find((b) => b.id === selectedId) || null : null; }

    function render() {
        if (viewW === 0 || viewH === 0) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = C.bg;
        ctx.fillRect(0, 0, viewW, viewH);
        if (S.showChart) drawInsetChart();
        if (!bodies.length && !dragGhost) drawEmptyHint();
        if (reflector && S.mirrorWalls) drawReflector(false);
        drawBin();
        drawEffects(true);
        drawBodies();
        drawSparks();
        if (reflector && S.mirrorWalls) drawReflector(true);
        drawEffects(false);
        drawPanels();
        drawGhost();
        drawToast();
        if (chartView.open) drawExpandedChart();
    }

    // The chain-reaction core's neutron reflector: a faint dashed wall with its name and, once the chain has
    // started, the number of fissions in each generation of neutrons along its foot (1 → 2 → 5 …: the growth).
    // words: its name and the count (drawn over the nuclei, so they stay readable), else the outline.
    function drawReflector(words) {
        const r = reflector;
        if (!words) {
            ctx.strokeStyle = hexA(C.modes.n, C.dark ? 0.55 : 0.6); ctx.lineWidth = 2;
            ctx.setLineDash([6, 5]);
            roundRect(ctx, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, 10);
            ctx.stroke();
            ctx.setLineDash([]);
            return;
        }
        ctx.font = font(700, Math.max(10, fontPx * 0.8));
        const t = 'neutron reflector', tw = ctx.measureText(t).width;
        ctx.fillStyle = C.bg;
        ctx.fillRect(r.x0 + 12, r.y0 - fontPx * 0.5, tw + 8, fontPx);
        ctx.fillStyle = ink(C.modes.n); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(t, r.x0 + 16, r.y0);
        if (!chainRx || !chainRx.gens.length) return;
        const counts = Array.from(chainRx.gens, (n) => n || 0);
        // under the reflector if there is room, else along its top after its name
        const below = r.y1 + fontPx * 1.1 < viewH - fontPx * 0.4;
        const gx = below ? r.x0 + 16 : r.x0 + 16 + tw + 18, gy = below ? r.y1 + fontPx * 0.9 : r.y0;
        const room = Math.min(r.x1, viewW - 8) - gx - 8;
        let from = 0, g = 'fissions per generation: ' + counts.join(' → ');
        // the latest generations, if they do not all fit
        while (from < counts.length - 1 && ctx.measureText(g).width > room) g = 'fissions per generation: … ' + counts.slice(++from).join(' → ');
        if (ctx.measureText(g).width > room) g = counts.slice(-Math.max(1, Math.floor(room / (fontPx * 2)))).join(' → ');
        ctx.fillStyle = C.bg;
        ctx.fillRect(gx - 4, gy - fontPx * 0.5, ctx.measureText(g).width + 8, fontPx);
        ctx.fillStyle = ink(C.modes.f);
        ctx.fillText(g, gx, gy);
    }

    function drawEmptyHint() {
        ctx.font = font(300, Math.max(13, fontPx * 1.15));
        ctx.fillStyle = C.muted;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const cx = layout.tall ? viewW / 2 : (viewW - (S.showChart ? layout.inset.w : 0)) / 2;
        const lines = viewW < 480 ? ['Drag a proton, neutron or nucleus', 'from the tray onto here'] : ['Drag a proton, neutron or nucleus from the tray onto here'];
        lines.forEach((t, i) => ctx.fillText(t, cx, viewH * (layout.tall ? 0.38 : 0.5) + (i - (lines.length - 1) / 2) * fontPx * 1.5));
    }

    function drawBodies() {
        const sel = selectedBody();
        // order: transient particles on top
        const list = bodies.slice().sort((a, b) => (a.transient - b.transient) || (a.held - b.held));
        for (const b of list) {
            const x = b.x, y = b.y;
            const st = b.step;
            // emitted particles fade out as they leave
            const fade = b.transient && b.emitted && !S.keepParticles ? fadeOf(simTime - b.born, mirroredNeutron(b) ? MIRROR_LIFE : 0) : 1;
            if (fade <= 0) continue;
            ctx.globalAlpha = fade;
            const scale = 1 + 0.08 * b.pulse;
            // excited nucleus: a soft halo (a steady one for a long-lived isomer)
            if (b.excited > 0 || b.iso) {
                const k = b.excited > 0 ? 1 : 0.6;
                const g = ctx.createRadialGradient(x, y, b.R * 0.6, x, y, b.R * 1.9 + 6);
                g.addColorStop(0, hexA(C.gamma, 0.35 * k));
                g.addColorStop(1, hexA(C.gamma, 0));
                ctx.fillStyle = g;
                ctx.beginPath(); ctx.arc(x, y, b.R * 1.9 + 6, 0, TAU); ctx.fill();
            }
            if (sel === b && !b.transient) {
                ctx.fillStyle = hexA(C.accent, C.dark ? 0.13 : 0.16);
                ctx.beginPath(); ctx.arc(x, y, b.R + 9, 0, TAU); ctx.fill();
            }
            // electron capture: an inner-shell electron spirals in to the proton that takes it
            if (st && st.kind === 'ec' && !st.fired) {
                const u = Math.min(1, st.t / (st.dur * FIRE_AT.ec));
                const sv = st.sites[0] || { x: 0, y: 0 };
                const shellR = b.R + 16 + rN * 2;
                ctx.strokeStyle = hexA(C.electron, 0.45 * (1 - u * 0.5)); ctx.lineWidth = 1;
                ctx.setLineDash([3, 4]);
                ctx.beginPath(); ctx.arc(x, y, shellR, 0, TAU); ctx.stroke();
                ctx.setLineDash([]);
                const ang = st.dir + u * 5, rr = shellR * (1 - u);
                const ex = x + sv.x * u + Math.cos(ang) * rr, ey = y + sv.y * u + Math.sin(ang) * rr;
                drawDot(ex, ey, Math.max(2.4, rN * 0.5), C.electron);
                ctx.font = font(700, Math.max(10, fontPx * 0.85)); ctx.fillStyle = ink(C.electron);
                ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                ctx.fillText('e⁻', ex + 5, ey - 8);
            }
            // a flying alpha, proton or neutron: its streak goes behind it
            if (b.transient && b.trail && !b.held) drawTrail(b, x, y, false);
            // fission: the nucleus stretches into two lobes joined by a neck, then splits
            if (st && st.kind === 'fission' && !st.fired) {
                const u = Math.min(1, st.t / (st.dur * 0.5));
                const e = u * u * (3 - 2 * u);
                const d = b.R * 0.55 * e, k = 1 - 0.2 * e;
                ctx.save();
                ctx.translate(x, y); ctx.rotate(st.dir);
                ctx.drawImage(b.sprite, -d - b.sw * k / 2, -b.sw * k / 2, b.sw * k, b.sw * k);
                ctx.drawImage(b.sprite, d - b.sw * k / 2, -b.sw * k / 2, b.sw * k, b.sw * k);
                ctx.restore();
            } else {
                const w = b.sw * scale;
                ctx.drawImage(b.sprite, x - w / 2, y - w / 2, w, w);
                // a nucleus that has just gained or lost nucleons: the old look fades into the new one
                if (b.prev) {
                    const u = (simTime - b.prev.t) / 0.15;   // (quick: halfway, red and grey blend to pink)
                    if (u >= 1 || u < 0) b.prev = null;
                    else {
                        const pw = b.prev.look.sw * scale;
                        ctx.globalAlpha = fade * (1 - u);
                        ctx.drawImage(b.prev.look.canvas, x - pw / 2, y - pw / 2, pw, pw);
                        ctx.globalAlpha = fade;
                    }
                }
            }
            drawChangingSites(b, x, y);
            if (b.transient) {
                if (b.trail && !b.held) drawTrail(b, x, y, true);
                ctx.globalAlpha = 1;
                continue;
            }
            ctx.globalAlpha = 1;
            drawClockRing(b, x, y);
            if (!S.hideLabels) drawLabel(b, x, y, sel === b);
        }
    }

    // The nucleon that changes in a beta decay or electron capture: it comes to the front with a growing glow
    // while the decay builds up, then turns into the other kind of nucleon and sinks back.
    function drawChangingSites(b, x, y) {
        const st = b.step;
        let sites = null, pre = 0, age = 0, color;
        if (st && (st.kind === 'beta' || st.kind === 'ec') && !st.fired && st.sites) {
            sites = st.sites;
            pre = Math.min(1, st.t / (st.dur * FIRE_AT[st.kind]));
            color = st.kind === 'ec' ? C.modes.e : (st.sign < 0 ? C.electron : C.positron);
        } else if (b.glow) {
            age = simTime - b.glow.t;
            if (age > 1.1 || age < 0) { b.glow = null; return; }
            sites = b.glow.sites; color = b.glow.color;
        }
        if (!sites || !sites.length) return;
        const base = ctx.globalAlpha;
        const sp = nucleonSprites(rN, dpr), ns = sp[0][0].width / dpr;
        for (const sv of sites) {
            const gx = x + sv.x, gy = y + sv.y;
            const turn = pre ? 0 : Math.min(1, age / 0.3);
            const show = pre ? Math.min(1, pre * 2.5) : (age < 0.7 ? 1 : Math.max(0, 1 - (age - 0.7) / 0.4));
            const glowA = pre ? 0.4 + 0.4 * pre : 0.85 * show;
            const gr = rN * 3.8;
            const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
            g.addColorStop(0, hexA('#ffffff', (pre ? 0.3 : 0.75) * glowA));
            g.addColorStop(0.45, hexA(color, 0.6 * glowA));
            g.addColorStop(1, hexA(color, 0));
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(gx, gy, gr, 0, TAU); ctx.fill();
            // picked out: a little bigger than the rest, with a ring round it
            const s = ns * (pre ? 1.2 + 0.2 * pre : 1.4 - 0.3 * Math.min(1, age / 0.9));
            ctx.globalAlpha = base * show;
            ctx.drawImage(sp[sv.to][SHADES - 1], gx - s / 2, gy - s / 2, s, s);
            if (turn < 1) {
                ctx.globalAlpha = base * show * (1 - turn);
                ctx.drawImage(sp[sv.from][SHADES - 1], gx - s / 2, gy - s / 2, s, s);
            }
            ctx.globalAlpha = base * show;
            ctx.strokeStyle = color; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(gx, gy, s * 0.62, 0, TAU); ctx.stroke();
            ctx.globalAlpha = base;
        }
    }

    // Log-time progress as a gauge around the nucleus, open at the bottom (towards the label): it fills
    // clockwise from the lower left, and the notch near the end marks the half-life.
    const RING_A0 = Math.PI * 0.75, RING_SPAN = Math.PI * 1.5;
    function drawClockRing(b, x, y) {
        const c = b.clock;
        if (!c) return;
        const r = b.R + 4;
        const span = c.logHalf + 1 - c.logStart;
        const f = Math.max(0, Math.min(1, (c.logT - c.logStart) / span));
        const fh = (c.logHalf - c.logStart) / span;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.strokeStyle = C.faint;
        ctx.beginPath(); ctx.arc(x, y, r, RING_A0, RING_A0 + RING_SPAN); ctx.stroke();
        ctx.strokeStyle = modeColor(b.info.modes[0].code);
        if (f > 0.002) { ctx.beginPath(); ctx.arc(x, y, r, RING_A0, RING_A0 + RING_SPAN * f); ctx.stroke(); }
        ctx.lineCap = 'butt';
        const ah = RING_A0 + RING_SPAN * fh;
        ctx.strokeStyle = C.text; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x + Math.cos(ah) * (r - 3.5), y + Math.sin(ah) * (r - 3.5)); ctx.lineTo(x + Math.cos(ah) * (r + 3.5), y + Math.sin(ah) * (r + 3.5)); ctx.stroke();
    }

    function drawLabel(b, x, y, selected) {
        const info = b.info;
        // The chain reaction is crowded: short names ("Ba-143"), and the counting clock only for the selected one.
        const compact = !!chainRx;
        const ly = y + b.R + (b.clock ? 9 : 5) + fontPx * 0.9;
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = selected ? C.accentText : C.text;
        if (S.notation) {
            const fs = fontPx * 1.1;
            const w = drawNotation(ctx, b.Z, b.N, b.iso, 0, 0, fs, false);
            ctx.fillStyle = selected ? C.accentText : C.text;
            drawNotation(ctx, b.Z, b.N, b.iso, x - w / 2, ly + 1, fs, true);
            b.labelW = w;
        } else {
            const name = compact ? shortName(b.Z, b.N, b.iso) : info.name;
            ctx.font = font(700, fontPx);
            ctx.textAlign = 'center';
            ctx.fillText(name, x, ly);
            b.labelW = ctx.measureText(name).width;
        }
        const y2 = ly + fontPx * 1.2;
        ctx.font = font(300, Math.max(11, fontPx * 0.92));
        ctx.fillStyle = C.muted;
        // (the carbon-dating sample's shared clock is in its panel)
        if (b.step || b.needsClock && !info.stable || (compact || b.clock && b.clock.shared) && !selected) return;
        if (info.stable) {
            ctx.textAlign = 'center';
            ctx.fillText('Stable', x, y2);
        } else if (b.clock) {
            // a stopwatch, then the count (one significant figure) right-aligned at a fixed point, so the
            // digits stay put as it counts up
            const d = formatDuration(Math.pow(10, b.clock.logT));
            const digits = d.wide[0] === '×' ? '0' : (/^(s|min|hours)$/.test(d.wide) ? '00' : '000');
            const icon = fontPx * 0.95;
            const wNum = ctx.measureText(digits).width, wUnit = ctx.measureText(' ' + d.wide).width;
            const right = x - (icon + wNum + wUnit) / 2 + icon + wNum;
            ctx.fillStyle = C.text;
            ctx.font = font(700, Math.max(11, fontPx * 0.92));
            const wn = ctx.measureText(d.num).width;
            ctx.textAlign = 'right';
            ctx.fillText(d.num, right, y2);
            drawStopwatch(right - wn - icon * 0.6, y2 - fontPx * 0.3, icon * 0.34);
            ctx.font = font(300, Math.max(11, fontPx * 0.92));
            ctx.textAlign = 'left';
            ctx.fillStyle = C.muted;
            ctx.fillText(' ' + d.unit, right, y2);
            b.labelW = Math.max(b.labelW, icon + wNum + wUnit);
            if (selected) {
                ctx.textAlign = 'center';
                ctx.font = font(300, Math.max(10.5, fontPx * 0.85));
                const t = 'half-life ' + formatHalfLife(info.hl);
                ctx.fillText(t, x, y2 + fontPx * 1.15);
                b.labelW = Math.max(b.labelW, ctx.measureText(t).width);
            }
        } else if (selected) {
            // a nucleus whose clock is held (the uranium in the chain reaction): just its half-life
            ctx.textAlign = 'center';
            const t = 'half-life ' + formatHalfLife(info.hl);
            ctx.fillText(t, x, y2);
            b.labelW = Math.max(b.labelW, ctx.measureText(t).width);
        }
    }

    // A flying alpha, proton or neutron: a fading streak behind it, or (label) its symbol.
    function drawTrail(b, x, y, label) {
        const sp = Math.hypot(b.vx, b.vy);
        if (sp < 20) return;
        if (label) {
            if (S.hideLabels) return;
            ctx.font = font(700, Math.max(12, fontPx * 1.05)); ctx.fillStyle = b.trail.ink || ink(b.trail.color);
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillText(b.trail.text, x + b.R + 4, y - b.R - 4);
            return;
        }
        const ux = b.vx / sp, uy = b.vy / sp;
        const len = Math.min(70, sp * 0.25 + 18);
        const g = ctx.createLinearGradient(x, y, x - ux * len, y - uy * len);
        g.addColorStop(0, hexA(b.trail.color, 0.6));
        g.addColorStop(1, hexA(b.trail.color, 0));
        ctx.strokeStyle = g; ctx.lineWidth = Math.max(2, b.R * 0.8); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - ux * len, y - uy * len); ctx.stroke();
        ctx.lineCap = 'butt';
    }

    function drawStopwatch(x, y, r) {
        ctx.strokeStyle = C.muted; ctx.lineWidth = Math.max(1, r * 0.3);
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x, y - r * 0.62);
        ctx.moveTo(x, y - r); ctx.lineTo(x, y - r * 1.4);
        ctx.moveTo(x - r * 0.38, y - r * 1.4); ctx.lineTo(x + r * 0.38, y - r * 1.4);
        ctx.stroke();
    }

    function drawDot(x, y, r, color) {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }
    function hexA(hex, a) {
        if (hex[0] !== '#') return hex;
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }

    function drawSparks() {
        const lw = Math.max(1.5, rN * 0.4);
        const fsSmall = Math.max(11, fontPx * 0.95);
        ctx.font = font(700, fsSmall); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        for (const s of sparks) {
            if ((s.kind === 'nu' || s.kind === 'nubar') && !S.showNeutrinos) continue;
            const a = fadeOf(s.age);
            if (a <= 0) continue;
            ctx.globalAlpha = a;
            const sp = Math.hypot(s.vx, s.vy) || 1;
            const ux = s.vx / sp, uy = s.vy / sp;
            // the label shows once the particle is clear of the nucleus it left (and its label)
            const labelled = !S.hideLabels && a > 0.3 && Math.hypot(s.x - s.ox, s.y - s.oy) > s.clear;
            if (s.kind === 'g') {
                // a wave packet travelling along its path
                const len = Math.max(26, rN * 6), amp = Math.max(3, rN * 0.75), k = TAU / Math.max(7, rN * 1.8);
                ctx.strokeStyle = C.gamma; ctx.lineWidth = lw;
                ctx.beginPath();
                for (let i = 0; i <= 24; i++) {
                    const d = -len * i / 24;
                    const env = Math.sin(Math.PI * i / 24);
                    const o = Math.sin(d * k + s.age * 18) * amp * env;
                    const px = s.x + ux * d - uy * o, py = s.y + uy * d + ux * o;
                    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
                }
                ctx.stroke();
                if (labelled) {
                    ctx.fillStyle = ink(C.gamma);
                    ctx.fillText(S.showDetails && s.energy > 0 ? 'γ ' + formatEnergy(s.energy) : 'γ', s.x + 6, s.y - 10);
                }
            } else if (s.kind === 'nu' || s.kind === 'nubar') {
                ctx.strokeStyle = C.neutrino; ctx.lineWidth = 1;
                ctx.setLineDash([2, 4]);
                ctx.beginPath(); ctx.moveTo(s.x - ux * 30, s.y - uy * 30); ctx.lineTo(s.x, s.y); ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = C.neutrino;
                ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(2, rN * 0.4), 0, TAU); ctx.fill();
                if (labelled) ctx.fillText(s.kind === 'nu' ? 'ν' : 'ν̄', s.x + 5, s.y - 8);
            } else {
                const col = s.kind === 'e-' ? C.electron : C.positron;
                if (s.trail.length >= 4) {
                    ctx.strokeStyle = hexA(col, 0.45); ctx.lineWidth = Math.max(1.5, rN * 0.35);
                    ctx.beginPath(); ctx.moveTo(s.trail[0], s.trail[1]);
                    for (let i = 2; i < s.trail.length; i += 2) ctx.lineTo(s.trail[i], s.trail[i + 1]);
                    ctx.lineTo(s.x, s.y);
                    ctx.stroke();
                }
                drawDot(s.x, s.y, Math.max(2.4, rN * 0.5), col);
                if (labelled) {
                    ctx.fillStyle = ink(col);
                    ctx.fillText(s.kind === 'e-' ? 'e⁻' : 'e⁺', s.x + 6, s.y - 9);
                }
            }
        }
        ctx.globalAlpha = 1;
    }

    // under: the glow round a nucleus that is taking things in (drawn beneath it, so it is not washed out);
    // otherwise everything else, on top.
    function drawEffects(under) {
        for (const e of effects) {
            if (under !== (e.kind === 'flash' && !!e.body)) continue;
            const u = e.age / e.life;
            if (e.kind === 'flash') {
                const r = e.r * (0.6 + 0.8 * u);
                const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r);
                g.addColorStop(0, hexA(e.color, 0.55 * (1 - u)));
                g.addColorStop(1, hexA(e.color, 0));
                ctx.fillStyle = g;
                ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, TAU); ctx.fill();
            } else if (e.kind === 'tag') {
                const a = u < 0.1 ? u / 0.1 : (u > 0.7 ? (1 - u) / 0.3 : 1);
                ctx.globalAlpha = a;
                ctx.font = font(700, fontPx * 1.05);
                ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
                const text = e.count > 1 ? e.text + ' ×' + e.count : e.text;
                const w = ctx.measureText(text).width;
                const x = Math.max(w / 2 + 4, Math.min(viewW - w / 2 - 4, e.x));
                const y = Math.max(fontPx + 4, e.y - e.rise - e.stack * fontPx * 1.3);
                ctx.lineWidth = 3; ctx.strokeStyle = C.bg; ctx.lineJoin = 'round';
                ctx.strokeText(text, x, y);
                ctx.fillStyle = ink(e.color);
                ctx.fillText(text, x, y);
                ctx.globalAlpha = 1;
            }
        }
    }

    // Top left: the carbon-dating count and the selected nucleus's details. Under the chart: the equations.
    function drawPanels() {
        const pad = layout.pad;
        let y = pad;
        panelRects = [];
        const maxW = (layout.tall || !S.showChart ? viewW : layout.inset.x) - pad * 2 - 4;
        if (batch) y = drawBatchPanel(pad, y, maxW) + pad * 0.7;
        const sel = selectedBody();
        if (S.showDetails && sel && !sel.transient) drawDetails(sel, pad, y, maxW);
        if (S.showEquations) drawEquations();
    }
    function panelBox(x, y, w, h) {
        roundRect(ctx, x, y, w, h, 6);
        ctx.fillStyle = C.panel; ctx.fill();
        ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
        panelRects.push({ x, y, w, h });
    }

    // The latest decay equations, newest first (lit up briefly when it arrives), right-aligned under the chart.
    function drawEquations() {
        const L = layout.eq;
        const items = eqLog.slice(-L.lines).reverse();
        if (!items.length) return;
        const showQ = S.showDetails;
        let fs = layout.eqFs;
        const widest = (f) => Math.max(...items.map((it) => drawEquation(ctx, it.eq, 0, 0, f, false) + (showQ ? qWidth(it.eq, f) : 0)));
        let ew = widest(fs);
        if (ew + fs * 1.4 > L.maxW) { fs = Math.max(11, fs * (L.maxW - fs * 1.4) / ew); ew = widest(fs); }
        const lineH = fs * 1.7;
        const w = Math.min(L.maxW, ew + fs * 1.4), h = items.length * lineH + fs * 0.5;
        const x = L.right - w, y = L.fromTop ? L.top : L.bottom - h;
        panelBox(x, y, w, h);
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
        items.forEach((it, i) => {
            const top = y + fs * 0.25 + lineH * i;
            const ly = top + lineH * 0.5 + fs * 0.32;
            const age = realTime - it.t;
            if (i === 0 && age < 2) {
                ctx.fillStyle = hexA(it.color[0] === '#' ? it.color : C.accent, 0.16 * (1 - age / 2));
                ctx.fillRect(x + 1, top, w - 2, lineH);
            }
            ctx.globalAlpha = i === 0 ? 1 : Math.max(0.4, 0.78 - i * 0.14);
            ctx.fillStyle = it.color;
            ctx.fillRect(x + fs * 0.3, ly - fs * 0.75, 3, fs * 1.05);
            ctx.fillStyle = C.text;
            const ew2 = drawEquation(ctx, it.eq, x + fs * 0.75, ly, fs, true);
            if (showQ) {
                ctx.font = font(300, fs * 0.8); ctx.fillStyle = C.muted; ctx.textAlign = 'left';
                ctx.fillText(qText(it.eq), x + fs * 0.75 + ew2 + fs * 0.8, ly);
            }
            ctx.globalAlpha = 1;
        });
        ctx.restore();
    }
    function qText(eq) { return 'Q = ' + formatEnergy(eq.Q); }
    function qWidth(eq, fs) { ctx.font = font(300, fs * 0.8); return ctx.measureText(qText(eq)).width + fs * 0.8; }

    // A nucleon as a small ball (for text in the panels), centred on (x, y).
    function drawNucleonIcon(type, x, y, r) {
        const sp = nucleonSprites(r, dpr);
        const c = sp[type][SHADES - 1];
        ctx.drawImage(c, x - c.width / dpr / 2, y - c.height / dpr / 2, c.width / dpr, c.height / dpr);
    }

    function drawDetails(b, x, y, maxW) {
        const info = b.info;
        const fs = Math.max(11, Math.min(14, viewW / 85));
        const lines = [];
        // the first line is the make-up, with a proton and a neutron for a key
        const pText = b.Z + (b.Z === 1 ? ' proton' : ' protons'), nText = b.N + (b.N === 1 ? ' neutron' : ' neutrons');
        const ratio = b.Z > 0 ? '   N/Z = ' + (b.N / b.Z).toFixed(2) : '';
        if (info.stable) lines.push(['Stable' + (info.known ? '' : ' (model)'), C.text]);
        else {
            lines.push(['Half-life: ' + formatHalfLife(info.hl) + (info.estimated ? ' (estimated)' : ''), C.text]);
            lines.push(['Decays by: ' + modesSummary(info, true), C.text]);
        }
        const A = b.Z + b.N;
        if (A > 1) {
            const BE = (b.Z * ME_H + b.N * ME_N - info.me) / A / 1000;
            lines.push(['Binding energy: ' + BE.toFixed(3) + ' MeV per nucleon', C.muted]);
        }
        if (info.ab) lines.push(['Natural abundance: ' + Number(info.ab.toPrecision(4)) + '%', C.muted]);
        if (b.iso) lines.push(['Excited (metastable) state, ' + formatEnergy(info.isoE) + ' above the ground state', C.muted]);
        const lineH = fs * 1.45;
        const titleFs = fs * 1.15;
        const ball = fs * 0.42, gap = fs * 0.5;
        ctx.font = font(300, fs);
        let w = ball * 4 + gap * 3 + ctx.measureText(pText + nText + ratio).width;
        lines.forEach(([t]) => { w = Math.max(w, ctx.measureText(t).width); });
        ctx.font = font(700, titleFs);
        w = Math.min(maxW, Math.max(w, ctx.measureText(info.name).width + titleFs * 3.2) + fs * 1.6);
        const h = titleFs * 1.7 + (lines.length + 1) * lineH + fs * 0.4;
        panelBox(x, y, w, h);
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
        ctx.fillStyle = C.text;
        ctx.font = font(700, titleFs); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        const ty = y + titleFs * 1.25;
        ctx.fillText(info.name, x + fs * 0.8, ty);
        const nw = ctx.measureText(info.name).width;
        ctx.fillStyle = C.muted;
        drawNotation(ctx, b.Z, b.N, b.iso, x + fs * 0.8 + nw + fs * 0.8, ty, titleFs, true);
        ctx.font = font(300, fs);
        let lx = x + fs * 0.8;
        const y1 = ty + titleFs * 0.45 + lineH;
        const part = (type, t) => {
            drawNucleonIcon(type, lx + ball, y1 - fs * 0.33, ball);
            lx += ball * 2 + fs * 0.3;
            ctx.fillStyle = C.text; ctx.fillText(t, lx, y1);
            lx += ctx.measureText(t).width + gap;
        };
        part(1, pText); part(0, nText);
        ctx.fillStyle = C.muted; ctx.fillText(ratio.trim(), lx, y1);
        lines.forEach(([t, col], i) => {
            ctx.fillStyle = col;
            ctx.fillText(t, x + fs * 0.8, y1 + lineH * (i + 1));
        });
        ctx.restore();
    }

    // The carbon-dating count: how many of the sample are left, after how many half-lives, and a graph of
    // the count against the halving curve. Returns the bottom of the panel.
    function drawBatchPanel(x, y, maxW) {
        const fs = Math.max(11, Math.min(14, viewW / 85));
        const left = bodies.filter((b) => batch.ids.has(b.id) && b.Z === batch.Z && b.N === batch.N).length;
        const halves = batch.t / batch.hl;
        if (left !== batch.last) { batch.points.push([halves, left]); batch.last = left; }
        const title = batch.name + ' left: ' + left + ' of ' + batch.total;
        const yrs = batch.t / YEAR;
        const sub = halves.toFixed(1) + ' half-lives  ·  ' + (yrs >= 1 ? Number(yrs.toPrecision(2)).toLocaleString('en-GB') : '0') + ' years';
        const gw = fs * 14, gh = fs * 4.6;
        ctx.font = font(700, fs * 1.05);
        let w = ctx.measureText(title).width;
        ctx.font = font(300, fs * 0.92);
        w = Math.min(maxW, Math.max(w, ctx.measureText(sub).width, gw + fs * 1.5) + fs * 1.6);
        const h = fs * 3.3 + gh + fs * 1.9;
        panelBox(x, y, w, h);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.font = font(700, fs * 1.05); ctx.fillStyle = C.text;
        ctx.fillText(title, x + fs * 0.8, y + fs * 1.45);
        ctx.font = font(300, fs * 0.92); ctx.fillStyle = C.muted;
        ctx.fillText(sub, x + fs * 0.8, y + fs * 2.75);
        // the graph: count (up) against half-lives 0 to 5 (across)
        const gx = x + fs * 1.6, gy = y + fs * 3.4, X = (u) => gx + Math.min(5, u) / 5 * gw, Y = (n) => gy + gh - n / batch.total * gh;
        ctx.strokeStyle = C.border; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(gx, gy + gh); ctx.lineTo(gx + gw, gy + gh); ctx.stroke();
        ctx.font = font(300, fs * 0.75); ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (let i = 1; i <= 5; i++) {
            ctx.beginPath(); ctx.moveTo(X(i), gy + gh); ctx.lineTo(X(i), gy + gh + 3); ctx.stroke();
            ctx.fillText(String(i), X(i), gy + gh + 4);
        }
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(String(batch.total), gx - 4, Y(batch.total));
        ctx.fillText('0', gx - 4, Y(0));
        // expected: halves every half-life
        ctx.setLineDash([3, 3]); ctx.strokeStyle = C.muted;
        ctx.beginPath();
        for (let i = 0; i <= 40; i++) { const u = i / 8; const px = X(u), py = Y(batch.total * Math.pow(0.5, u)); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
        ctx.stroke(); ctx.setLineDash([]);
        // counted
        ctx.strokeStyle = C.modes.b; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(X(0), Y(batch.total));
        let n = batch.total;
        batch.points.forEach(([u, c]) => { ctx.lineTo(X(u), Y(n)); ctx.lineTo(X(u), Y(c)); n = c; });
        ctx.lineTo(X(halves), Y(n));
        ctx.stroke();
        drawDot(X(halves), Y(n), 3, C.modes.b);
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = C.muted; ctx.font = font(300, fs * 0.75);
        ctx.fillText('half-lives', gx + gw, gy + gh + fs * 1.85);
        return y + h;
    }

    function drawBin() {
        if (!binVisible()) return;
        const r = binRect();
        const hot = binHot;
        ctx.fillStyle = hot ? hexA('#ef5a6a', 0.25) : (C.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)');
        ctx.strokeStyle = hot ? '#ef5a6a' : C.border;
        ctx.lineWidth = hot ? 2 : 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.setLineDash([]);
        // a simple bin glyph
        const s = r.r * 0.42;
        ctx.strokeStyle = hot ? '#ef5a6a' : C.muted; ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(r.x - s * 0.75, r.y - s * 0.55); ctx.lineTo(r.x - s * 0.6, r.y + s * 0.85); ctx.lineTo(r.x + s * 0.6, r.y + s * 0.85); ctx.lineTo(r.x + s * 0.75, r.y - s * 0.55);
        ctx.moveTo(r.x - s * 0.95, r.y - s * 0.6); ctx.lineTo(r.x + s * 0.95, r.y - s * 0.6);
        ctx.moveTo(r.x - s * 0.3, r.y - s * 0.6); ctx.lineTo(r.x - s * 0.3, r.y - s * 0.85); ctx.lineTo(r.x + s * 0.3, r.y - s * 0.85); ctx.lineTo(r.x + s * 0.3, r.y - s * 0.6);
        ctx.stroke();
    }

    // What a drag will do when it ends: a ring around the nucleus it would combine with, and for something
    // coming from the tray, the item itself in a soft halo (so a neutron shows up even over a big nucleus).
    function drawTargetRing(t) {
        ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.arc(t.x, t.y, t.R + 9, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
    }
    function drawGhost() {
        drags.forEach((d) => {
            if (!d.body || !d.moved) return;
            const t = findDropTarget(d.body.x, d.body.y, d.body, d.body.R);
            if (t) drawTargetRing(t);
        });
        if (!dragGhost || !dragGhost.over) return;
        const b = dragGhost.body;
        const t = findDropTarget(dragGhost.x, dragGhost.y, null, b.R);
        if (t) drawTargetRing(t);
        const x = dragGhost.x, y = dragGhost.y;
        const ring = Math.max(b.R + 4, 11);
        ctx.fillStyle = C.dark ? 'rgba(22,24,28,0.85)' : 'rgba(255,255,255,0.9)';
        ctx.beginPath(); ctx.arc(x, y, ring, 0, TAU); ctx.fill();
        ctx.drawImage(b.sprite, x - b.sw / 2, y - b.sw / 2, b.sw, b.sw);
        ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, ring, 0, TAU); ctx.stroke();
    }

    function drawToast() {
        if (!toast) return;
        const u = toast.age / toast.life;
        const a = u < 0.08 ? u / 0.08 : (u > 0.8 ? (1 - u) / 0.2 : 1);
        ctx.globalAlpha = a;
        ctx.font = font(700, fontPx);
        // one line if it fits, else wrapped onto two or three
        const maxW = viewW - 20 - fontPx * 2;
        const lines = [];
        toast.text.split(' ').forEach((word) => {
            const last = lines[lines.length - 1];
            if (last != null && ctx.measureText(last + ' ' + word).width <= maxW) lines[lines.length - 1] = last + ' ' + word;
            else lines.push(word);
        });
        const shown = lines.slice(0, 3).map((t) => fitText(t, maxW));
        const w = Math.min(viewW - 20, Math.max(...shown.map((t) => ctx.measureText(t).width)) + fontPx * 2);
        const lh = fontPx * 1.3, h = lh * shown.length + fontPx * 0.9;
        const x = (viewW - w) / 2;
        let y = viewH - h - layout.pad;
        // clear of the text panels (on a tall canvas the equations run along the bottom)
        for (const r of panelRects) if (x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y) y = Math.max(layout.pad, r.y - h - 6);
        roundRect(ctx, x, y, w, h, Math.min(h / 2, fontPx * 1.1));
        ctx.fillStyle = C.panelSolid; ctx.fill();
        ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        shown.forEach((t, i) => ctx.fillText(t, viewW / 2, y + fontPx * 0.45 + lh * (i + 0.5) + 0.5));
        ctx.globalAlpha = 1;
    }

    // ------------------------------------------------------------------
    // Pointer input: drag nuclei around, drop one onto another to combine, flick to throw, tap to select;
    // drag from the tray to add; drop onto the bin (or off the canvas) to remove.
    // ------------------------------------------------------------------
    const drags = new Map();         // pointerId -> { body, ox, oy, samples, sx, sy, st, moved }
    let dragGhost = null;            // a tray item being dragged in
    let binHot = false;
    let insetTap = null;

    function binVisible() { return drags.size > 0 && Array.from(drags.values()).some((d) => d.moved); }
    function binRect() {
        const r = Math.max(22, Math.min(30, viewW / 30));
        const insetLeft = S.showChart && !layout.tall ? layout.inset.x : viewW;
        return { x: Math.min(viewW / 2, insetLeft - r - 20), y: viewH - r - layout.pad - 2, r };
    }
    function overBin(x, y) { const r = binRect(); return Math.hypot(x - r.x, y - r.y) < r.r + 8; }

    function canvasPoint(e) {
        const rect = canvas.getBoundingClientRect();
        const m = 24;   // a little slack, so a nucleus dropped just past the edge is not lost
        return {
            x: (e.clientX - rect.left) * viewW / rect.width, y: (e.clientY - rect.top) * viewH / rect.height,
            inside: e.clientX >= rect.left - m && e.clientX <= rect.right + m && e.clientY >= rect.top - m && e.clientY <= rect.bottom + m,
        };
    }

    function hitBody(x, y, tol) {
        let best = null, bd = Infinity;
        for (const b of bodies) {
            if (b.transient && b.emitted) continue;
            const d = Math.hypot(b.x - x, b.y - y) - b.R;
            if (d < tol && d < bd) { bd = d; best = b; }
        }
        return best;
    }

    function findDropTarget(x, y, except, r) {
        let best = null, bd = Infinity;
        for (const b of bodies) {
            if (b === except || b.transient || b.held) continue;
            const d = Math.hypot(b.x - x, b.y - y);
            if (d < b.R + r * 0.7 + 4 && d < bd) { bd = d; best = b; }
        }
        return best;
    }

    function inInset(x, y) {
        if (!S.showChart || !layout) return false;
        const r = layout.inset;
        return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    }

    function onPointerDown(e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const p = canvasPoint(e);
        if (chartView.open) { chartPointerDown(e, p); e.preventDefault(); return; }
        if (inInset(p.x, p.y)) { insetTap = { id: e.pointerId, x: p.x, y: p.y }; e.preventDefault(); return; }
        const tol = e.pointerType === 'mouse' ? 4 : 14;
        const b = hitBody(p.x, p.y, tol);
        if (b && !b.held) {
            b.held = true;
            b.transient = false; b.emitted = false;
            drags.set(e.pointerId, { body: b, ox: b.x - p.x, oy: b.y - p.y, samples: [[performance.now(), p.x, p.y]], sx: p.x, sy: p.y, st: performance.now(), moved: false });
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            canvas.style.cursor = 'grabbing';
        } else {
            drags.set(e.pointerId, { body: null, sx: p.x, sy: p.y, st: performance.now(), moved: false, samples: [] });
        }
        e.preventDefault();
    }

    function onPointerMove(e) {
        const p = canvasPoint(e);
        if (chartView.open) { chartPointerMove(e, p); return; }
        const d = drags.get(e.pointerId);
        if (!d) {
            if (e.pointerType === 'mouse') canvas.style.cursor = inInset(p.x, p.y) ? 'pointer' : (hitBody(p.x, p.y, 4) ? 'grab' : 'default');
            return;
        }
        if (Math.hypot(p.x - d.sx, p.y - d.sy) > 6) d.moved = true;
        if (!d.body) return;
        d.body.x = p.x + d.ox; d.body.y = p.y + d.oy;
        d.body.vx = 0; d.body.vy = 0;
        d.samples.push([performance.now(), p.x, p.y]);
        if (d.samples.length > 6) d.samples.shift();
        binHot = d.moved && overBin(p.x, p.y);
        e.preventDefault();
    }

    function onPointerUp(e) {
        const p = canvasPoint(e);
        if (chartView.open) { chartPointerUp(e, p); return; }
        if (insetTap && insetTap.id === e.pointerId) {
            if (e.type === 'pointerup' && inInset(p.x, p.y)) openChart();
            insetTap = null;
            return;
        }
        const d = drags.get(e.pointerId);
        if (!d) return;
        drags.delete(e.pointerId);
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        canvas.style.cursor = 'default';
        binHot = false;
        const tap = !d.moved && performance.now() - d.st < 600;
        if (!d.body) { if (tap && e.type === 'pointerup') selectedId = 0; return; }
        const b = d.body;
        b.held = false;
        if (tap) { selectedId = b.id; return; }
        if (e.type !== 'pointerup') return;
        // removed: onto the bin, the tray or off the canvas
        if (overBin(p.x, p.y) || !p.inside || overToolbar(e)) { poof(b); return; }
        const t = findDropTarget(b.x, b.y, b, b.R);
        if (t) { if (combine(t, b)) { selectedId = t.id; } return; }
        // a flick: the thrown nucleus is selected, so the chart and the info bar follow what it takes in
        if (throwBody(b, d.samples)) selectedId = b.id;
    }

    // Set a released body moving at the speed of the pointer's last moments (in real time, whatever the
    // simulation speed). Returns true for a real throw.
    function throwBody(b, samples) {
        if (samples.length < 2) return false;
        const now = performance.now();
        const recent = samples.filter((s) => now - s[0] < 120);
        if (recent.length < 2) return false;
        const a = recent[0], c = recent[recent.length - 1];
        const dt = Math.max(0.016, (c[0] - a[0]) / 1000);
        let vx = (c[1] - a[1]) / dt, vy = (c[2] - a[2]) / dt;
        const sp = Math.hypot(vx, vy);
        const max = Math.max(viewW, viewH) * 2.5;
        if (sp > max) { vx *= max / sp; vy *= max / sp; }
        b.vx = vx; b.vy = vy;
        b.thrown = true;
        b.ignore = null;
        return sp > 250;
    }

    function poof(b) {
        addFlash(b.x, b.y, b.R * 1.5, C.muted);
        removeBody(b);
    }

    function overToolbar(e) {
        if (!ui.toolbar) return false;
        const r = ui.toolbar.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }

    // --- expanded chart gestures ---
    function chartPointerDown(e, p) {
        chartView.pointers.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y });
        chartView.moved = false;
        if (chartView.pointers.size === 2) {
            const [a, b] = Array.from(chartView.pointers.values());
            chartView.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cell: chartView.cell };
        }
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    function chartPointerMove(e, p) {
        const pt = chartView.pointers.get(e.pointerId);
        if (!pt) { if (e.pointerType === 'mouse') canvas.style.cursor = 'default'; return; }
        const rr = chartRects();
        const dx = p.x - pt.x, dy = p.y - pt.y;
        pt.x = p.x; pt.y = p.y;
        if (Math.hypot(p.x - pt.sx, p.y - pt.sy) > 6) chartView.moved = true;
        if (chartView.pointers.size >= 2 && chartView.pinch) {
            const [a, b] = Array.from(chartView.pointers.values());
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            zoomChartAt(rr, mx, my, chartView.pinch.cell * d / chartView.pinch.d / chartView.cell);
        } else if (chartView.moved) {
            chartView.cZ -= dx / chartView.cell;
            chartView.cN += dy / chartView.cell;
            clampChartView(rr);
        }
    }
    function chartPointerUp(e, p) {
        const pt = chartView.pointers.get(e.pointerId);
        chartView.pointers.delete(e.pointerId);
        if (chartView.pointers.size < 2) chartView.pinch = null;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (!pt || chartView.moved || e.type !== 'pointerup') return;
        const rr = chartRects();
        const inR = (r) => r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
        if (inR(rr.close) || !inR(rr.panel)) { chartView.open = false; return; }
        if (inR(rr.zin)) { zoomChartAt(rr, rr.area.x + rr.area.w / 2, rr.area.y + rr.area.h / 2, 1.6); return; }
        if (inR(rr.zout)) { zoomChartAt(rr, rr.area.x + rr.area.w / 2, rr.area.y + rr.area.h / 2, 1 / 1.6); return; }
        if (inR(rr.fit)) { chartView.cell = 0; clampChartView(rr); return; }
        if (inR(rr.add) && chartView.pick) {
            const pk = chartView.pick;
            const spot = freeSpot();
            const b = addBody(pk.Z, pk.N, 0, spot.x, spot.y);
            if (b) { selectedId = b.id; b.pulse = 1; }
            chartView.open = false;
            return;
        }
        if (inR(rr.area)) {
            const [z, n] = screenToChart(rr, p.x, p.y);
            const Z = Math.round(z), N = Math.round(n);
            chartView.pick = table.has(key(Z, N, 0)) ? { Z, N } : null;
        }
    }
    function zoomChartAt(rr, x, y, factor) {
        const [z, n] = screenToChart(rr, x, y);
        chartView.cell *= factor;
        clampChartView(rr);
        // keep the point under the fingers / cursor in place
        const [z2, n2] = screenToChart(rr, x, y);
        chartView.cZ += z - z2; chartView.cN += n - n2;
        clampChartView(rr);
    }
    function onWheel(e) {
        if (!chartView.open) return;
        const p = canvasPoint(e);
        zoomChartAt(chartRects(), p.x, p.y, Math.exp(-e.deltaY * 0.0015));
        e.preventDefault();
    }

    // A free spot for something added with a tap (as far as possible from everything else).
    function freeSpot() {
        const wr = workRect();
        const avoid = panelRects.slice();
        if (S.showChart) avoid.push(layout.inset);
        let best = { x: viewW * 0.4, y: viewH * 0.45 }, bd = -1;
        for (let i = 0; i < 40; i++) {
            const x = wr.x0 + 40 + Math.random() * (wr.x1 - wr.x0 - 80);
            const y = wr.y0 + 40 + Math.random() * (wr.y1 - wr.y0 - 100);
            if (avoid.some((r) => x > r.x - 40 && x < r.x + r.w + 40 && y > r.y - 50 && y < r.y + r.h + 40)) continue;
            let d = 1e9;
            for (const b of bodies) d = Math.min(d, Math.hypot(b.x - x, b.y - y) - b.R);
            if (d > bd) { bd = d; best = { x, y }; }
        }
        return best;
    }

    // --- the tray: one column of particles and nuclei beside the canvas (a row under it in portrait) ---
    // A small picture of a nuclide for the tray, sized by its mass number.
    function trayIcon(Z, N) {
        const A = Z + N, arr = arrangement(A);
        const size = 9 + 2.3 * Math.cbrt(A);                   // CSS px across
        const k = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
        const look = renderNucleus(Z, N, size / 2 / (arr.radius * SPACING + 1), k);
        const c = look.canvas;
        c.className = 'nuc-icon';
        c.setAttribute('aria-hidden', 'true');
        c.style.width = c.style.height = look.sw + 'px';
        c.style.margin = (-(look.sw - size) / 2) + 'px';      // the sprite has a little room round the ball
        return c;
    }

    function buildPalette() {
        if (!ui.palette) return;
        ui.palette.innerHTML = '';
        PRESETS.forEach((pr) => {
            const info = getInfo(pr.Z, pr.N, pr.iso || 0);
            const btn = document.createElement('button');
            btn.type = 'button';
            const particle = pr.Z + pr.N === 1;
            btn.className = 'nuc-item' + (particle ? ' nuc-particle' : '');
            const desc = info.stable ? 'stable' : modesSummary(info, false) + ', half-life ' + formatHalfLife(info.hl);
            btn.title = (particle ? info.name : info.name + ': ' + desc) + (pr.note && !particle ? ' (' + pr.note + ')' : '');
            btn.setAttribute('aria-label', 'Add ' + info.name);
            const icon = document.createElement('span');
            icon.className = 'nuc-icon-box';
            icon.appendChild(trayIcon(pr.Z, pr.N));
            btn.appendChild(icon);
            const text = document.createElement('span');
            text.className = 'nuc-item-text';
            if (particle) text.textContent = pr.Z ? 'p' : 'n';
            else text.innerHTML = '<sup>' + (pr.Z + pr.N) + (pr.iso ? 'm' : '') + '</sup>' + elementSymbol(pr.Z);
            btn.appendChild(text);
            if (!particle) {
                const dot = document.createElement('span');
                dot.className = 'nuc-mode nuc-mode-' + chartClass(info);
                dot.setAttribute('aria-hidden', 'true');
                btn.appendChild(dot);
            }
            bindPaletteItem(btn, pr);
            ui.palette.appendChild(btn);
        });
    }

    function bindPaletteItem(btn, pr) {
        let pid = null, start = null, samples = [];
        btn.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            pid = e.pointerId;
            start = { x: e.clientX, y: e.clientY, t: performance.now() };
            samples = [];
            try { btn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            // (not for touch: the tray scrolls under a finger, along its length)
            if (e.pointerType === 'mouse') e.preventDefault();
        });
        btn.addEventListener('pointermove', (e) => {
            if (e.pointerId !== pid) return;
            const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6;
            if (!dragGhost && moved) {
                dragGhost = { body: makeBody(pr.Z, pr.N, pr.iso || 0, 0, 0), x: 0, y: 0, over: false };
                btn.classList.add('is-dragging');
            }
            if (dragGhost) {
                const p = canvasPoint(e);
                // a finger would hide the item: carry it just above the fingertip
                const lift = e.pointerType === 'mouse' ? 0 : dragGhost.body.R + 26;
                dragGhost.x = p.x; dragGhost.y = p.y - lift; dragGhost.over = p.inside && !chartView.open;
                samples.push([performance.now(), p.x, p.y]);
                if (samples.length > 6) samples.shift();
            }
        });
        const end = (e) => {
            if (e.pointerId !== pid) return;
            pid = null;
            btn.classList.remove('is-dragging');
            try { btn.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            if (!dragGhost) {
                if (e.type === 'pointerup') tapAdd(pr);
                return;
            }
            const g = dragGhost;
            dragGhost = null;
            if (e.type !== 'pointerup' || !g.over) return;
            const t = findDropTarget(g.x, g.y, null, g.body.R);
            const b = addBody(pr.Z, pr.N, pr.iso || 0, g.x, g.y);
            if (!b) return;
            if (t) { if (combine(t, b)) selectedId = t.id; else selectedId = b.id; return; }
            selectedId = b.id;
            throwBody(b, samples);
        };
        btn.addEventListener('pointerup', end);
        btn.addEventListener('pointercancel', end);
        // keyboard (Enter/Space) clicks
        btn.addEventListener('click', (e) => { if (e.detail === 0) tapAdd(pr); });
    }

    function tapAdd(pr) {
        if (chartView.open) chartView.open = false;
        const spot = freeSpot();
        const b = addBody(pr.Z, pr.N, pr.iso || 0, spot.x, spot.y);
        if (b) { selectedId = b.id; b.pulse = 1; }
    }

    // The tray folds away to a slim strip, giving the canvas the room; each viewer's choice is remembered.
    const TRAY_KEY = 'nuclearTrayCollapsed';
    function setTrayCollapsed(collapsed, remember) {
        const host = ui.toolbar ? ui.toolbar.closest('.nuclear-sim') : null;
        if (host) host.classList.toggle('nuc-tray-collapsed', collapsed);
        if (ui.trayToggle) {
            ui.trayToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            const label = collapsed ? 'Show the particles and nuclei' : 'Hide the particles and nuclei';
            ui.trayToggle.title = label;
            ui.trayToggle.setAttribute('aria-label', label);
        }
        if (remember) {
            try { localStorage.setItem(TRAY_KEY, collapsed ? '1' : '0'); } catch (e) { /* storage unavailable */ }
            // the canvas area changes: the page measures its layout again
            window.dispatchEvent(new Event('resize'));
        }
    }
    function bindTray() {
        let collapsed = false;
        try { collapsed = localStorage.getItem(TRAY_KEY) === '1'; } catch (e) { /* storage unavailable */ }
        setTrayCollapsed(collapsed, false);
        if (ui.trayToggle) {
            ui.trayToggle.addEventListener('click', () => {
                setTrayCollapsed(ui.trayToggle.getAttribute('aria-expanded') === 'true', true);
            });
        }
    }

    // ------------------------------------------------------------------
    // Setups: ready-made scenes, chosen in the settings panel. Each one replaces the scene.
    // ------------------------------------------------------------------
    let scheduled = [];             // [{ at (simulation time), fn }]: the setups' timed steps
    const later = (s, fn) => scheduled.push({ at: simTime + s, fn });

    // Positions for up to n nuclei, each given a cw x ch box (nucleus and label), in the space the chart and
    // the equations leave (and clear of `avoid`; within `area` if given), nearest the middle first.
    function setupSlots(n, cw, ch, avoid, area) {
        const pad = layout.pad, inset = layout.inset;
        const blocked = avoid ? [avoid] : [];
        if (!layout.tall) {
            if (S.showChart) blocked.push({ x0: inset.x - 8, y0: 0, x1: viewW, y1: viewH });
            else if (S.showEquations) blocked.push({ x0: viewW * 0.55, y0: viewH * 0.6, x1: viewW, y1: viewH });
        } else {
            if (S.showChart) blocked.push({ x0: inset.x - 8, y0: inset.y - 8, x1: viewW, y1: viewH });
            if (S.showEquations) blocked.push({ x0: 0, y0: layout.eq.top - 6, x1: viewW, y1: viewH });
        }
        const A = area || { x0: pad, y0: pad, x1: viewW - pad, y1: viewH - pad };
        const cols = Math.max(1, Math.floor((A.x1 - A.x0) / cw)), rows = Math.max(1, Math.floor((A.y1 - A.y0) / ch));
        const ox = (A.x0 + A.x1 - cols * cw) / 2, oy = (A.y0 + A.y1 - rows * ch) / 2;
        const slots = [];
        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                const x0 = ox + i * cw, y0 = oy + j * ch;
                if (blocked.some((r) => x0 < r.x1 && x0 + cw > r.x0 && y0 < r.y1 && y0 + ch > r.y0)) continue;
                slots.push({ x: x0 + cw / 2, y: y0 + ch * 0.38, row: j, col: i });
            }
        }
        if (!slots.length) return [{ x: viewW * 0.3, y: viewH * 0.35, row: 0, col: 0 }];
        const mx = slots.reduce((s, p) => s + p.x, 0) / slots.length, my = slots.reduce((s, p) => s + p.y, 0) / slots.length;
        slots.sort((a, b) => Math.hypot(a.x - mx, (a.y - my) * 1.3) - Math.hypot(b.x - mx, (b.y - my) * 1.3));
        return slots.slice(0, n);
    }
    const readingOrder = (pts) => pts.sort((a, b) => (a.row - b.row) || (a.col - b.col));
    // The box a nucleus of this kind needs with its label, for setupSlots.
    function slotSize(Z, N) {
        const R = nuclideLook(Z, N).R;
        ctx.font = font(700, fontPx);
        const lw = ctx.measureText(chainRx ? shortName(Z, N, 0) : nuclideName(Z, N, 0)).width;
        return [Math.max(2 * R + 16, lw + 22), 2 * R + 20 + fontPx * 2.6];
    }
    function setToggle(el, on) {
        if (el && el.checked !== on) { el.checked = on; el.dispatchEvent(new Event('change')); }
    }
    // A setting a setup needs (on or off): set for it, and put back when the scene is replaced.
    let setupToggles = [];
    function setupNeeds(el, on) {
        const want = on !== false;
        if (!el || el.checked === want) return;
        setToggle(el, want);
        setupToggles.push([el, !want]);
    }

    const SETUPS = {
        // U-235 in a box whose walls reflect neutrons; one neutron is fired in
        chain() {
            setupNeeds(ui.mirrorWalls);
            chainRx = { gens: [] };
            holdClock = (b) => b.Z >= 90;    // uranium's half-life is hundreds of millions of years
            // on a tall canvas the core gets the whole width: the chart comes back with the next scene
            if (layout.tall) setupNeeds(ui.showChart, false);
            const [cw, ch] = slotSize(92, 143);
            const pts = setupSlots(layout.tall ? 12 : 14, cw, ch);
            const us = pts.map((p) => addBody(92, 143, 0, p.x, p.y)).filter(Boolean);
            // a reflector round the core keeps the neutrons among the nuclei, as in a reactor
            const m = layout.pad * 0.5;
            reflector = {
                x0: Math.max(m, Math.min(...pts.map((p) => p.x)) - cw / 2 - m), x1: Math.min(viewW - m, Math.max(...pts.map((p) => p.x)) + cw / 2 + m),
                y0: Math.max(m, Math.min(...pts.map((p) => p.y)) - ch * 0.38 - m), y1: Math.min(viewH - m, Math.max(...pts.map((p) => p.y)) + ch * 0.62 + m),
            };
            showToast('One neutron splits a uranium-235 nucleus, and the neutrons it frees split more', 6);
            // the first neutron comes in from the left, from outside the reflector, aimed at the nearest nucleus
            later(0.6, () => {
                const live = us.filter((u) => bodies.indexOf(u) >= 0 && !busy(u));
                if (!live.length) return;
                const t = live.reduce((a, b) => (b.x < a.x ? b : a));
                const x = Math.min(t.x - t.R - radBase() * SPEED.n * 0.6, reflector ? reflector.x0 - 20 : viewW);
                const n = launchNeutron(Math.max(layout.pad + 6, x), t.y, 0, [], 0);
                n.forceFission = true;
                n.inReflector = false;      // fired in from outside, so the reflector does not hold it
            });
        },
        // a single U-238, followed on the chart down to lead-206
        series() {
            setupNeeds(ui.showEquations);
            clockK = 4;     // fourteen decays, most of them slow: the clock runs four times as fast here
            const [cw, ch] = slotSize(92, 146);
            const p = setupSlots(1, cw, ch)[0];
            const b = addBody(92, 146, 0, p.x, p.y);
            if (b) selectedId = b.id;
            showToast('Uranium-238 decays by 8 α and 6 β⁻ decays to stable lead-206', 7);
        },
        // twenty C-14 nuclei on one steady clock: half are left after each half-life (twenty identical
        // decay labels would only hide the count)
        dating() {
            setupNeeds(ui.showTags, false);
            if (layout.tall) setupNeeds(ui.showChart, false);
            const fs = Math.max(11, Math.min(14, viewW / 85));
            const [cw, ch] = slotSize(6, 8);
            const pts = setupSlots(layout.tall ? 16 : 20, cw, ch, { x0: 0, y0: 0, x1: fs * 18, y1: fs * 10.5 });
            const hl = getInfo(6, 8, 0).hl;
            batch = { Z: 6, N: 8, name: 'Carbon-14', total: 0, ids: new Set(), t: 0, hl, rate: hl / 3, points: [], last: 0 };
            readingOrder(pts).forEach((p) => { const b = addBody(6, 8, 0, p.x, p.y); if (b) batch.ids.add(b.id); });
            batch.total = batch.last = batch.ids.size;
            showToast('Here one half-life (5,700 years) takes 3 seconds: watch the sample halve', 6);
        },
        // carbon-9 to carbon-16: too few neutrons, beta+; too many, beta-
        carbon() {
            const [cw, ch] = slotSize(6, 8);
            const pts = readingOrder(setupSlots(8, cw, ch));
            pts.forEach((p, i) => addBody(6, 3 + i, 0, p.x, p.y));
            showToast('Too few neutrons: β⁺ decay. Too many: β⁻ decay. Only carbon-12 and -13 are stable', 7);
        },
        // deuterium and tritium in pairs; the first pair is pushed together
        fusion() {
            holdClock = (b) => b.Z === 1 && b.N === 2;     // tritium's 12-year half-life would beat the user to it
            setupNeeds(ui.showDetails);     // for the energy released (Q) in the equations
            if (layout.tall) setupNeeds(ui.showChart, false);
            const [cw, ch] = slotSize(1, 2);
            const pts = readingOrder(setupSlots(3, cw * 2.2, ch));
            const pairs = pts.map((p) => [addBody(1, 1, 0, p.x - cw * 0.55, p.y), addBody(1, 2, 0, p.x + cw * 0.55, p.y)]);
            showToast('Deuterium + tritium make helium-5, which throws out a neutron at once. Drag the others together', 7);
            later(0.9, () => {
                const [d, t] = pairs[0] || [];
                if (!d || !t || bodies.indexOf(d) < 0 || bodies.indexOf(t) < 0) return;
                const dx = t.x - d.x, dy = t.y - d.y, dist = Math.hypot(dx, dy) || 1;
                const v = Math.max(400, dist / 0.6 * 1.6);
                d.vx = dx / dist * v; d.vy = dy / dist * v;
                d.projectileUntil = simTime + 2;
            });
        },
        // fluorine-18, the PET tracer: positrons, then pairs of 511 keV gamma rays
        pet() {
            setupNeeds(ui.showDetails);
            if (layout.tall) setupNeeds(ui.showChart, false);
            // well spread (each positron needs room to fly and annihilate) and added one after another, so
            // they do not all decay at once
            const [cw, ch] = slotSize(9, 9);
            const want = layout.tall ? 3 : 4, details = { x0: 0, y0: 0, x1: Math.min(330, viewW * 0.6), y1: Math.min(150, fontPx * 7.5) };
            let pts = setupSlots(want, cw * 2, ch * 1.4, details);
            if (pts.length < want) pts = setupSlots(want, cw * 1.3, ch * 1.15, details);   // a small canvas: closer together
            pts.forEach((p, i) => later(i * 0.8, () => {
                const b = addBody(9, 9, 0, p.x, p.y);
                if (b && !i) selectedId = b.id;
            }));
            showToast('Each positron meets an electron: two 511 keV gamma rays fly apart, which a PET scanner detects', 7);
        },
    };
    function runSetup(name) {
        if (!SETUPS[name]) return;
        resetScene(false);
        SETUPS[name]();
        // on a narrow screen the settings sheet covers the canvas: close it to watch
        const panel = byId('simulationControlsPanel'), toggle = document.querySelector('.sim-panel-toggle-button');
        if (document.body.classList.contains('sim-panel-sheet') && panel && panel.classList.contains('panel-open') && toggle) toggle.click();
    }

    // ------------------------------------------------------------------
    // Settings panel and readouts
    // ------------------------------------------------------------------
    function bindControls() {
        if (ui.speed) {
            const upd = () => {
                S.speed = parseFloat(ui.speed.value) || 1;
                if (ui.speedVal) ui.speedVal.textContent = S.speed.toFixed(1);
            };
            ui.speed.addEventListener('input', upd);
            upd();
        }
        const toggles = [['showChart', ui.showChart], ['showTags', ui.showTags], ['showNeutrinos', ui.showNeutrinos],
            ['showEquations', ui.showEquations], ['showDetails', ui.showDetails], ['notation', ui.notation],
            ['keepParticles', ui.keepParticles], ['mirrorWalls', ui.mirrorWalls]];
        toggles.forEach(([k, el]) => {
            if (!el) return;
            S[k] = el.checked;
            el.addEventListener('change', () => {
                S[k] = el.checked;
                if (k === 'showChart' && !S.showChart) chartView.open = false;
                if (k === 'showChart' || k === 'showEquations') computeLayout();
            });
        });
        ui.setups.forEach((btn) => btn.addEventListener('click', () => runSetup(btn.getAttribute('data-setup'))));
        if (ui.element) {
            for (let Z = 1; Z <= 118; Z++) {
                const o = document.createElement('option');
                o.value = String(Z);
                o.textContent = Z + '  ' + NAMES[Z] + ' (' + SYMBOLS[Z] + ')';
                ui.element.appendChild(o);
            }
            ui.element.value = '6';
            ui.element.addEventListener('change', fillIsotopes);
            fillIsotopes();
        }
        if (ui.addBtn) ui.addBtn.addEventListener('click', () => {
            const Z = parseInt(ui.element.value, 10);
            const v = ui.isotope.value.split(',');
            tapAdd({ Z, N: +v[0], iso: +v[1] });
        });
        if (ui.reset) ui.reset.addEventListener('click', () => resetScene(true));
        if (ui.clear) ui.clear.addEventListener('click', () => resetScene(false));
    }

    function fillIsotopes() {
        const Z = parseInt(ui.element.value, 10);
        ui.isotope.innerHTML = '';
        let pick = null, best = -1;
        const opts = [];
        table.forEach((rec) => {
            if (rec.Z !== Z) return;
            opts.push(rec);
        });
        opts.sort((a, b) => (a.N - b.N) || (a.iso - b.iso));
        opts.forEach((rec) => {
            const info = getInfo(Z, rec.N, rec.iso);
            const o = document.createElement('option');
            o.value = rec.N + ',' + rec.iso;
            o.textContent = info.short + ' – ' + (info.stable ? 'stable' : formatHalfLife(info.hl));
            ui.isotope.appendChild(o);
            // default: the most abundant (or longest-lived) isotope
            const score = info.stable ? 1e40 + (info.ab || 0) : (info.hl || 0);
            if (score > best) { best = score; pick = o.value; }
        });
        if (pick) ui.isotope.value = pick;
    }

    let lastReadout = '';
    function updateReadouts() {
        const b = selectedBody();
        let name = '–', half = '–', decay = '–';
        if (b && !b.transient) {
            name = b.info.name;
            half = b.info.stable ? 'stable' : formatHalfLife(b.info.hl);
            decay = b.info.stable ? 'none' : modesSummary(b.info, false);
        }
        const s = name + '|' + half + '|' + decay;
        if (s === lastReadout) return;
        lastReadout = s;
        if (ui.statName) ui.statName.textContent = name;
        if (ui.statHalf) ui.statHalf.textContent = half;
        if (ui.statDecay) ui.statDecay.textContent = decay;
    }

    function resetScene(withStart) {
        bodies = []; sparks = []; effects = []; eqLog = []; toast = null; batch = null; scheduled = []; reflector = null; chainRx = null; holdClock = null; clockK = 1;
        // settings the last setup turned on for itself go off again
        setupToggles.forEach(([el, was]) => setToggle(el, was));
        setupToggles = [];
        selectedId = 0; drags.clear(); dragGhost = null; chartView.open = false;
        if (withStart && viewW > 0) {
            START_SCENE.forEach((s) => {
                const tall = layout && layout.tall;
                const b = addBody(s.Z, s.N, s.iso || 0, (tall ? s.tx : s.fx) * viewW, (tall ? s.ty : s.fy) * viewH);
                if (b && s.select) selectedId = b.id;
            });
        }
    }

    // ------------------------------------------------------------------
    // Canvas sizing
    // ------------------------------------------------------------------
    function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width));
        const h = Math.max(1, Math.round(rect.height));
        const newDpr = Math.min(2, window.devicePixelRatio || 1);
        if (w === viewW && h === viewH && newDpr === dpr) return false;
        const oldW = viewW, oldH = viewH, wasTall = layout ? layout.tall : null;
        viewW = w; viewH = h; dpr = newDpr;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        rN = Math.max(3.2, Math.min(7, Math.min(viewW, viewH * 2) / 150));
        fontPx = Math.max(12, Math.min(14, viewW / 85));
        computeLayout();
        refreshLooks();
        if (oldW > 0) {
            bodies.forEach((b) => { b.x *= viewW / oldW; b.y *= viewH / oldH; });
            sparks.forEach((s) => { s.x *= viewW / oldW; s.y *= viewH / oldH; s.ox *= viewW / oldW; s.oy *= viewH / oldH; });
            if (reflector) reflector = { x0: reflector.x0 * viewW / oldW, x1: reflector.x1 * viewW / oldW, y0: reflector.y0 * viewH / oldH, y1: reflector.y1 * viewH / oldH };
            // a phone turned between portrait and landscape: once the layout has settled, spread out again
            if (wasTall !== null && wasTall !== layout.tall) {
                clearTimeout(spreadTimer);
                spreadTimer = setTimeout(spreadOut, 250);
            }
        }
        render();
        return true;
    }
    // The nucleon size or the theme changed: draw every nucleus again.
    function refreshLooks() {
        lookCache.clear();
        nucleonCache.clear();
        bodies.forEach((b) => { applyLook(b); b.prev = null; });
        if (dragGhost) applyLook(dragGhost.body);
    }

    // After the canvas turns between tall and wide (a phone rotated), the chart moves to another corner:
    // lay the nuclei out again in the free space, in their old reading order.
    let spreadTimer = 0;
    function spreadOut() {
        const list = bodies.filter((b) => !b.transient);
        if (!list.length) return;
        const pad = layout.pad, inset = layout.inset;
        const free = { x: pad, y: pad, w: viewW - 2 * pad, h: viewH - 2 * pad };
        if (S.showChart) {
            if (layout.tall) free.h = inset.y - 2 * pad; else free.w = inset.x - 2 * pad;
        }
        const n = list.length;
        const cols = Math.max(1, Math.round(Math.sqrt(n * free.w / Math.max(1, free.h))));
        const rows = Math.ceil(n / cols);
        list.sort((a, b) => (a.y - b.y) || (a.x - b.x));
        list.forEach((b, i) => {
            const r = Math.floor(i / cols), c = i % cols;
            const inRow = r === rows - 1 ? n - r * cols : cols;
            b.x = free.x + free.w * (c + 0.5) / inRow + (r % 2 ? 6 : -6);
            b.y = free.y + free.h * (r + 0.4) / rows;
            b.vx = 0; b.vy = 0;
        });
    }

    // ------------------------------------------------------------------
    // Main loop (exactly one)
    // ------------------------------------------------------------------
    const MAX_FRAME_DT = 0.05;
    let lastTs = 0, fpsFrames = 0, fpsTime = 0;
    const perf = { frameMs: 0, worst: 0 };
    // One step: dt of real time, which is dt x speed of simulation time.
    function step(dt) {
        const dtSim = dt * S.speed;
        realTime += dt;
        simTime += dtSim;
        if (scheduled.length) {
            const due = scheduled.filter((a) => simTime >= a.at);
            scheduled = scheduled.filter((a) => simTime < a.at);
            due.forEach((a) => a.fn());
        }
        updateBodies(dtSim, dtSim * DECADES_PER_S * clockK, dt);
        updateSparks(dtSim, dt);
        updateInsetView(dt);
    }
    function frame(ts) {
        requestAnimationFrame(frame);   // first, so the loop keeps going whatever happens below
        const dt = lastTs && !frozen ? Math.min(MAX_FRAME_DT, (ts - lastTs) / 1000) : 0;
        lastTs = ts;
        const t0 = performance.now();
        step(dt);
        render();
        updateReadouts();
        const ms = performance.now() - t0;
        perf.frameMs = perf.frameMs * 0.95 + ms * 0.05;
        perf.worst = Math.max(perf.worst, ms);
        if (ui.fps) {
            fpsFrames++; fpsTime += dt;
            if (fpsTime >= 0.5) { ui.fps.textContent = `FPS: ${Math.round(fpsFrames / fpsTime)}`; fpsFrames = 0; fpsTime = 0; }
        }
    }

    // ------------------------------------------------------------------
    // Public API (reset button; handy for testing)
    // ------------------------------------------------------------------
    function bodySummary(b) {
        return {
            id: b.id, Z: b.Z, N: b.N, iso: b.iso, name: b.info.name, x: b.x, y: b.y, R: b.R, vx: b.vx, vy: b.vy, stable: b.info.stable,
            transient: b.transient, busy: !!(b.step || b.steps.length), clock: b.clock ? Object.assign({}, b.clock) : null,
            chain: b.chain.map((c) => shortName(c.Z, c.N, c.iso) + (c.code ? '(' + c.code + ')' : '')),
        };
    }
    window.nuclearSimulation = {
        reset: () => resetScene(true),
        clear: () => resetScene(false),
        add: (Z, N, iso, x, y) => {
            const b = addBody(Z, N, iso || 0, x == null ? viewW / 2 : x, y == null ? viewH / 2 : y);
            if (b) selectedId = b.id;
            return b ? b.id : null;
        },
        select: (id) => { selectedId = id; },
        list: () => bodies.map(bodySummary),
        info: (Z, N, iso) => {
            const i = getInfo(Z, N, iso || 0);
            return {
                name: i.name, known: i.known, estimated: i.estimated, stable: i.stable, hl: i.hl, halfLife: formatHalfLife(i.hl),
                modes: i.modes.map((m) => ({ code: m.code, p: m.p, sub: m.sub })), summary: modesSummary(i, true),
                me: i.me, chartClass: chartClass(i), positronShare: i.modes.some((m) => m.code === 'e') ? positronShare(i) : null,
                gammas: i.gam,
            };
        },
        // Make a body decay now (optionally by a given mode code: b, z, c, a, f, i, p, n ..., and in a given
        // direction in radians, for pictures)
        forceDecay: (id, code, dir) => {
            const b = bodies.find((o) => o.id === id);
            if (!b || b.info.stable || b.step) return false;
            b.needsClock = false;
            b.forceDir = dir == null ? null : dir;
            beginDecay(b, code);
            return true;
        },
        // Fire a neutron at a body from the left
        fireNeutron: (id, forceFission) => {
            const t = bodies.find((o) => o.id === id);
            if (!t) return false;
            const n = launchNeutron(Math.max(10, t.x - 160), t.y, 0, []);
            n.forceFission = !!forceFission;
            return true;
        },
        // Throw a body (as a flick would) at vx, vy px/s
        fling: (id, vx, vy) => {
            const b = bodies.find((o) => o.id === id);
            if (!b) return false;
            b.vx = vx; b.vy = vy; b.thrown = true; b.ignore = null;
            return true;
        },
        combine: (idA, idB) => {
            const a = bodies.find((o) => o.id === idA), b = bodies.find((o) => o.id === idB);
            return a && b ? combine(a, b) : false;
        },
        setup: (name) => runSetup(name),
        setups: () => Object.keys(SETUPS),
        batch: () => (batch ? { total: batch.total, left: bodies.filter((b) => batch.ids.has(b.id) && b.Z === batch.Z && b.N === batch.N).length, halves: batch.t / batch.hl } : null),
        setSpeed: (v) => { if (ui.speed) { ui.speed.value = v; ui.speed.dispatchEvent(new Event('input')); } else S.speed = v; },
        setShow: (name, on) => {
            const el = { chart: ui.showChart, tags: ui.showTags, neutrinos: ui.showNeutrinos, equations: ui.showEquations, details: ui.showDetails, notation: ui.notation, keep: ui.keepParticles, mirror: ui.mirrorWalls }[name];
            if (el) { el.checked = !!on; el.dispatchEvent(new Event('change')); }
        },
        hideLabels: (v) => { S.hideLabels = !!v; },   // for pictures of the canvas (e.g. the home-page tile)
        nucleonSize: (r) => { rN = r; refreshLooks(); },   // (likewise; the next resize sets it back)
        openChart: (open) => { if (open) openChart(); else chartView.open = false; },
        pickChart: (Z, N) => { chartView.pick = { Z, N }; },
        // Centre the expanded chart on (Z, N) with squares `cell` px across; where (Z, N) is on the canvas.
        setChartView: (Z, N, cell) => { chartView.cZ = Z; chartView.cN = N; chartView.cell = cell; clampChartView(chartRects()); },
        chartPoint: (Z, N) => chartToScreen(chartRects(), Z, N),
        chartButtons: () => { const r = chartRects(); return { add: r.add, close: r.close, fit: r.fit, area: r.area }; },
        // The inset's view now and where it is heading: the chart point at its centre and the square size.
        insetView: () => ({ now: Object.assign({}, insetView), target: layout ? insetTarget(layout.inset) : null, full: layout ? insetFullView(layout.inset) : null }),
        panels: () => panelRects.map((r) => Object.assign({}, r)),
        pause: (v) => { paused = v === undefined ? !paused : !!v; return paused; },
        freeze: (v) => { frozen = !!v; },
        // Run the simulation synchronously (no drawing) for `seconds` of real time.
        advance: (seconds) => {
            for (let t = 0; t < seconds; t += 1 / 30) step(1 / 30);
            return bodies.length;
        },
        // Statistics of the random choices (for tests): branch counts, and decay times in s.
        sampleBranches: (Z, N, iso, n) => {
            const i = getInfo(Z, N, iso || 0), c = {};
            for (let k = 0; k < n; k++) { const code = pickBranch(i).code; c[code] = (c[code] || 0) + 1; }
            return c;
        },
        sampleTimes: (Z, N, iso, n) => {
            const b = { info: getInfo(Z, N, iso || 0) }, out = [];
            for (let k = 0; k < n; k++) { startClock(b); out.push(Math.pow(10, b.clock.logEnd)); }
            return out;
        },
        // Every nuclide in the table with its decay mode codes (for tests).
        allModes: () => {
            const out = [];
            table.forEach((rec) => {
                const i = getInfo(rec.Z, rec.N, rec.iso);
                if (!i.stable) out.push([rec.Z, rec.N, rec.iso, i.modes.map((m) => m.code)]);
            });
            return out;
        },
        // The packing of A nucleons (for tests): radius and the smallest spacing, in nucleon spacings, and
        // which sites hold protons for Z.
        packing: (A, Z) => {
            const a = arrangement(A);
            let dmin = Infinity;
            for (let i = 0; i < a.A; i++) for (let j = i + 1; j < a.A; j++) dmin = Math.min(dmin, Math.hypot(a.x[i] - a.x[j], a.y[i] - a.y[j], a.z[i] - a.z[j]));
            const sites = Array.from(siteTypes(a, Z || 0));
            return { A: a.A, radius: a.radius, dmin, protons: sites.reduce((s, v) => s + v, 0), sites };
        },
        formatDuration: durationText,
        formatHalfLife,
        equations: () => eqLog.map((e) => ({ code: e.eq.code, Q: e.eq.Q, lhs: e.eq.lhs, rhs: e.eq.rhs })),
        sparks: () => sparks.map((s) => s.kind),
        state: () => ({ viewW, viewH, dpr, rN, fontPx, bodies: bodies.length, sparks: sparks.length, selected: selectedId, chartOpen: chartView.open, layout, settings: Object.assign({}, S), simTime, realTime }),
        perf: () => ({ frameMs: perf.frameMs, worstMs: perf.worst }),
        resetPerf: () => { perf.worst = 0; },
        estimate: (Z, N) => estimate(Z, N),
        massExcess: (Z, N) => massExcess(Z, N, 0),
    };

    // ------------------------------------------------------------------
    // Start
    // ------------------------------------------------------------------
    readPalette();
    loadData();
    buildChartList();
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && chartView.open) chartView.open = false; });
    canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !drags.size) canvas.style.cursor = 'default'; });
    bindControls();
    bindTray();
    buildPalette();
    resizeCanvas();
    resetScene(true);
    updateReadouts();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resizeCanvas).observe(canvas);
    window.addEventListener('resize', resizeCanvas);
    new MutationObserver(() => {
        readPalette();
        refreshLooks();
        insetCache = null;
        buildPalette();
        render();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    requestAnimationFrame(frame);
})();
