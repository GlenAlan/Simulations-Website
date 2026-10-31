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
 * Nothing warns of a decay in advance: it is random and memoryless, as in a real nucleus.
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
        toolbar: byId('nucToolbar'), palette: byId('nucPalette'),
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
    const START_SCENE = [
        { Z: 92, N: 146, fx: 0.24, fy: 0.42, tx: 0.3, ty: 0.2, select: true },
        { Z: 6, N: 8, fx: 0.47, fy: 0.3, tx: 0.76, ty: 0.12 },
        { Z: 43, N: 56, iso: 1, fx: 0.5, fy: 0.68, tx: 0.72, ty: 0.4 },
        { Z: 27, N: 33, fx: 0.7, fy: 0.62, tx: 0.26, ty: 0.52 },
        { Z: 26, N: 30, fx: 0.12, fy: 0.75, tx: 0.22, ty: 0.8 },
    ];

    // Neutron capture on these (Z, N) targets usually splits the nucleus (thermal fission / (fission + capture)).
    const FISSILE = { '92,141': 0.92, '92,143': 0.85, '94,145': 0.73, '94,147': 0.74, '95,147': 0.85, '96,149': 0.87, '98,153': 0.83 };

    // ------------------------------------------------------------------
    // Settings & state
    // ------------------------------------------------------------------
    const S = {
        speed: 1, showChart: true, showTags: true, showNeutrinos: true, showEquations: false, showDetails: false,
        notation: false, keepParticles: false, mirrorWalls: false,
    };
    let viewW = 0, viewH = 0, dpr = 1;
    let rN = 4;                     // nucleon radius (CSS px)
    let fontPx = 13;
    let realTime = 0;               // s since start (animations)
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

    // Three significant figures in a fixed width of 4 characters ("1.23", "12.3", " 123").
    function sig3(v) {
        if (v < 9.995) return v.toFixed(2);
        if (v < 99.95) return v.toFixed(1);
        return v.toFixed(0);
    }
    const TIME_UNITS = [
        [1e-12, 'ps'], [1e-9, 'ns'], [1e-6, 'µs'], [1e-3, 'ms'], [1, 's'], [60, 'min'], [3600, 'hours'], [86400, 'days'],
        [YEAR, 'years'], [1e3 * YEAR, 'thousand years'], [1e6 * YEAR, 'million years'], [1e9 * YEAR, 'billion years'],
    ];
    const UNIT_LIMIT = [1000, 1000, 1000, 1000, 60, 60, 24, 365.25, 1000, 1000, 1000, 1000];
    // A running timer: { num, unit } with a 4-character number, so the digits never shift.
    function formatDuration(s) {
        if (!(s > 0)) return { num: '0', unit: 's' };
        if (s < 1e-12) {
            const e = Math.floor(Math.log10(s));
            return { num: (s / Math.pow(10, e)).toFixed(1), unit: '× 10' + sup(e) + ' s' };
        }
        for (let i = TIME_UNITS.length - 1; i >= 0; i--) {
            if (s >= TIME_UNITS[i][0]) {
                let v = s / TIME_UNITS[i][0];
                if (i === TIME_UNITS.length - 1 && v >= 999.5) {
                    const yr = s / YEAR;
                    const e = Math.floor(Math.log10(yr));
                    return { num: (yr / Math.pow(10, e)).toFixed(1), unit: '× 10' + sup(e) + ' years' };
                }
                if (+sig3(v) >= UNIT_LIMIT[i] && i < TIME_UNITS.length - 1) { v = s / TIME_UNITS[i + 1][0]; return { num: sig3(v), unit: TIME_UNITS[i + 1][1] }; }
                return { num: sig3(v), unit: TIME_UNITS[i][1] };
            }
        }
        return { num: sig3(s * 1e12), unit: 'ps' };
    }
    const durationText = (s) => { const d = formatDuration(s); return d.num.trim() + ' ' + d.unit; };

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
            proton: dark ? '#f2849e' : '#ec6f8d',
            neutron: dark ? '#aeb8c6' : '#93a0b2',
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
    // Nucleon packing: an FCC lattice ball. The first A points (sorted by distance, ties broken by a hash so
    // partly filled shells stay round) are the nucleons of a nucleus with A nucleons.
    // ------------------------------------------------------------------
    const LAT = [];
    (function buildLattice() {
        const pts = [];
        const L = 7;
        for (let i = -L; i <= L; i++) for (let j = -L; j <= L; j++) for (let k = -L; k <= L; k++) {
            if ((i + j + k) & 1) continue;
            const h = Math.sin(i * 12.9898 + j * 78.233 + k * 37.719) * 43758.5453;
            pts.push({ i, j, k, d: i * i + j * j + k * k + (h - Math.floor(h)) * 0.5 });
        }
        pts.sort((a, b) => a.d - b.d);
        // A fixed tilt so no lattice rows line up on screen; nearest neighbours are sqrt(2) apart.
        const ax = 0.62, ay = 0.41, az = 0.27;
        const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
        for (let n = 0; n < MAX_A + 10 && n < pts.length; n++) {
            let { i: x, j: y, k: z } = pts[n];
            let t = y * cx - z * sx; z = y * sx + z * cx; y = t;
            t = x * cy + z * sy; z = -x * sy + z * cy; x = t;
            t = x * cz - y * sz; y = x * sz + y * cz; x = t;
            LAT.push([x / Math.SQRT2, y / Math.SQRT2, z / Math.SQRT2]);   // in nucleon diameters
        }
    })();
    const centroids = [];
    function centroid(A) {
        if (centroids[A]) return centroids[A];
        let x = 0, y = 0, z = 0;
        for (let i = 0; i < A; i++) { x += LAT[i][0]; y += LAT[i][1]; z += LAT[i][2]; }
        return (centroids[A] = [x / A, y / A, z / A]);
    }

    // Shaded nucleon sprites: [type][shade] canvases at the current size.
    let nucleonSprites = null;
    const SHADES = 6;
    function buildNucleonSprites() {
        const r = rN * dpr;
        const size = Math.ceil(r * 2 + 2);
        nucleonSprites = [0, 1].map((type) => {
            const base = type ? C.proton : C.neutron;
            const list = [];
            for (let s = 0; s < SHADES; s++) {
                const c = document.createElement('canvas');
                c.width = c.height = size;
                const g = c.getContext('2d');
                const k = 0.5 + 0.5 * s / (SHADES - 1);     // back nucleons darker
                const grad = g.createRadialGradient(size / 2 - r * 0.35, size / 2 - r * 0.4, r * 0.1, size / 2, size / 2, r);
                grad.addColorStop(0, shadeColor(base, 1.0 + 0.35 * k));
                grad.addColorStop(0.55, shadeColor(base, k));
                grad.addColorStop(1, shadeColor(base, k * 0.62));
                g.fillStyle = grad;
                g.beginPath();
                g.arc(size / 2, size / 2, r * 0.97, 0, TAU);
                g.fill();
                if (!C.dark) {
                    g.strokeStyle = 'rgba(0,0,0,0.18)';
                    g.lineWidth = Math.max(0.6, dpr * 0.6);
                    g.stroke();
                }
                list.push(c);
            }
            return list;
        });
    }
    function shadeColor(hex, k) {
        const n = parseInt(hex.slice(1), 16);
        let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        if (k > 1) { const t = k - 1; r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t; } else { r *= k; g *= k; b *= k; }
        return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
    }

    // ------------------------------------------------------------------
    // Bodies (nuclei and nucleons on the canvas)
    // ------------------------------------------------------------------
    function randomTypes(Z, N) {
        const t = [];
        for (let i = 0; i < Z; i++) t.push(1);
        for (let i = 0; i < N; i++) t.push(0);
        for (let i = t.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const s = t[i]; t[i] = t[j]; t[j] = s; }
        return t;
    }

    function makeBody(Z, N, iso, x, y) {
        const b = {
            id: nextId++, Z, N, iso: iso ? 1 : 0, info: null, types: randomTypes(Z, N), x, y, vx: 0, vy: 0,
            R: 4, spin: Math.random() * TAU, bob: Math.random() * TAU, sprite: null, sw: 0, px: null, py: null, pz: null,
            clock: null, steps: [], step: null, transient: false, projectileUntil: 0, held: false, excited: 0,
            born: realTime, chain: [], glow: null, pulse: 0, recoil: 0,
        };
        setComposition(b, Z, N, iso, null, false);
        return b;
    }

    // Change what a body is made of (the nucleon arrangement is updated by the caller), refresh its info and
    // sprite, and record the step in its decay chain.
    function setComposition(b, Z, N, iso, code, keepTypes) {
        b.Z = Z; b.N = N; b.iso = iso && table.has(key(Z, N, 1)) ? 1 : 0;
        if (!keepTypes) b.types = randomTypes(Z, N);
        b.info = getInfo(Z, N, b.iso);
        b.chain.push({ Z, N, iso: b.iso, code });
        if (b.chain.length > 40) b.chain.splice(1, b.chain.length - 40);
        buildSprite(b);
        b.clock = null;
    }

    // Draw the nucleons into the body's own canvas (rebuilt only when its make-up or the scale changes).
    function buildSprite(b) {
        const A = b.types.length;
        const c0 = centroid(Math.max(1, A));
        const s = rN * 2;                       // px per nucleon diameter
        const cs = Math.cos(b.spin), sn = Math.sin(b.spin);
        const px = new Float32Array(A), py = new Float32Array(A), pz = new Float32Array(A);
        let maxR = 0, zMin = 1e9, zMax = -1e9;
        for (let i = 0; i < A; i++) {
            const p = LAT[i];
            const x = (p[0] - c0[0]) * s, y = (p[1] - c0[1]) * s;
            px[i] = x * cs - y * sn;
            py[i] = x * sn + y * cs;
            pz[i] = (p[2] - c0[2]) * s;
            maxR = Math.max(maxR, Math.hypot(px[i], py[i]));
            zMin = Math.min(zMin, pz[i]); zMax = Math.max(zMax, pz[i]);
        }
        b.px = px; b.py = py; b.pz = pz;
        b.R = maxR + rN;
        const half = Math.ceil(b.R + 2);
        const size = Math.ceil(half * 2 * dpr);
        if (!b.sprite) b.sprite = document.createElement('canvas');
        b.sprite.width = b.sprite.height = size;
        b.sw = size / dpr;
        const g = b.sprite.getContext('2d');
        g.clearRect(0, 0, size, size);
        const order = Array.from({ length: A }, (_, i) => i).sort((i, j) => pz[i] - pz[j]);
        const ns = nucleonSprites[0][0].width;
        for (const i of order) {
            const shade = zMax > zMin ? Math.round((pz[i] - zMin) / (zMax - zMin) * (SHADES - 1)) : SHADES - 1;
            g.drawImage(nucleonSprites[b.types[i]][shade], (half + px[i]) * dpr - ns / 2, (half + py[i]) * dpr - ns / 2);
        }
    }

    function frontIndex(b, type) {
        // A nucleon of this type near the front, so the change can be seen.
        let best = -1, bz = -1e9;
        for (let i = 0; i < b.types.length; i++) {
            if (b.types[i] !== type) continue;
            const z = b.pz[i] - 0.15 * Math.hypot(b.px[i], b.py[i]) + Math.random() * rN;
            if (z > bz) { bz = z; best = i; }
        }
        return best;
    }

    // Remove `count` nucleons of each type from the side facing `dir` (outer lattice points refill the holes,
    // so the rest of the nucleus keeps its look).
    function removeNucleons(b, nP, nN, dir) {
        const dx = Math.cos(dir), dy = Math.sin(dir);
        const idx = b.types.map((t, i) => i).sort((i, j) => (b.px[j] * dx + b.py[j] * dy) - (b.px[i] * dx + b.py[i] * dy));
        const remove = [];
        let p = nP, n = nN;
        for (const i of idx) {
            if (p > 0 && b.types[i] === 1) { remove.push(i); p--; } else if (n > 0 && b.types[i] === 0) { remove.push(i); n--; }
            if (p === 0 && n === 0) break;
        }
        remove.sort((a, c) => c - a);
        const types = b.types.slice();
        for (const i of remove) {
            const last = types.length - 1;
            if (i !== last) types[i] = types[last];
            types.pop();
        }
        // If the side ran short of one type (only for odd cases), take any.
        while (p-- > 0) { const i = types.lastIndexOf(1); if (i >= 0) types.splice(i, 1); }
        while (n-- > 0) { const i = types.lastIndexOf(0); if (i >= 0) types.splice(i, 1); }
        b.types = types;
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
        const hl = info.hl;
        const t = -hl / LN2 * Math.log(1 - Math.random());       // 1 - U is in (0, 1]
        const logHalf = Math.log10(hl);
        const logStart = Math.min(-9, logHalf - 2.5);
        b.clock = { logT: logStart, logStart, logHalf, logEnd: Math.log10(Math.max(t, 1e-30)), branch: null };
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

    const STEP_DUR = { beta: 0.75, ec: 1.0, emit: 0.55, fission: 1.1, gamma: 0.55, capture: 0.45 };
    function nextStep(b) {
        const st = b.steps.shift();
        if (!st) { b.step = null; afterFormed(b, 0.15); return; }
        st.t = 0;
        st.dur = STEP_DUR[st.kind];
        st.fired = false;
        st.dir = b.forceDir != null ? b.forceDir : Math.random() * TAU;
        if (st.kind === 'beta' || st.kind === 'ec') {
            st.idx = [];
            for (let i = 0; i < st.count; i++) {
                const want = st.kind === 'beta' && st.sign < 0 ? 0 : 1;   // beta-: a neutron changes; beta+/EC: a proton
                let j = frontIndex(b, want);
                if (st.idx.indexOf(j) >= 0) j = b.types.indexOf(want, j + 1);
                st.idx.push(j);
            }
        }
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
        eqLog.push({ eq: b.pendingEq, color: modeColor(b.pendingCode), t: realTime, w: 0, fs: 0 });
        if (eqLog.length > 30) eqLog.shift();
        if (S.showTags) addTag(b.x, b.y - b.R - 10, b.pendingTag, b.pendingCode === 'capture' ? C.accent : modeColor(b.pendingCode), b);
        b.pendingEq = null;
    }

    function updateStep(b, dt) {
        const st = b.step;
        st.t += dt;
        const u = st.t / st.dur;
        const fireAt = { beta: 0.35, ec: 0.55, emit: 0.15, fission: 0.5, gamma: 0.35, capture: 0.3 }[st.kind];
        if (!st.fired && u >= fireAt) {
            st.fired = true;
            fireStep(b, st);
        }
        if (u >= 1) nextStep(b);
    }

    function fireStep(b, st) {
        const cx = b.x, cy = b.y;
        logEquation(b);
        if (st.kind === 'beta') {
            const k = st.count;
            for (let i = 0; i < k; i++) {
                const j = st.idx[i];
                const ox = j >= 0 ? b.px[j] : 0, oy = j >= 0 ? b.py[j] : 0;
                if (j >= 0) b.types[j] = st.sign < 0 ? 1 : 0;
                const a = st.dir + i * 2.4;
                spawnSpark(st.sign < 0 ? 'e-' : 'e+', cx + ox, cy + oy, a, 1);
                spawnSpark(st.sign < 0 ? 'nubar' : 'nu', cx + ox, cy + oy, a + 2.2 + Math.random() * 1.6, 1);
                addFlash(cx + ox, cy + oy, rN * 3.2, st.sign < 0 ? C.electron : C.positron);
                b.glow = { x: ox, y: oy, t: realTime, color: st.sign < 0 ? C.electron : C.positron };
            }
            const to = st.to;
            setComposition(b, to[0], to[1], to[2], to[3], true);
            b.pulse = 1;
        } else if (st.kind === 'ec') {
            for (let i = 0; i < st.count; i++) {
                const j = st.idx[i];
                if (j >= 0) b.types[j] = 0;
                const ox = j >= 0 ? b.px[j] : 0, oy = j >= 0 ? b.py[j] : 0;
                spawnSpark('nu', cx + ox, cy + oy, st.dir + Math.PI + i, 1);
                addFlash(cx + ox, cy + oy, rN * 3, C.positron);
                b.glow = { x: ox, y: oy, t: realTime, color: C.modes.e };
            }
            const to = st.to;
            setComposition(b, to[0], to[1], to[2], to[3], true);
            b.pulse = 1;
        } else if (st.kind === 'emit') {
            const dir = st.dir;
            removeNucleons(b, st.cz, st.cn, dir);
            const ex = cx + Math.cos(dir) * b.R, ey = cy + Math.sin(dir) * b.R;
            const p = makeBody(st.cz, st.cn, 0, ex, ey);
            p.transient = true;
            p.emitted = true;
            const sp = Math.max(viewW, viewH) * (st.cz + st.cn > 1 ? 0.55 : 0.75);
            p.vx = Math.cos(dir) * sp; p.vy = Math.sin(dir) * sp;
            p.projectileUntil = realTime + 3;
            p.ignore = [b.id];
            bodies.push(p);
            const m = st.cz + st.cn, M = b.types.length;
            b.vx -= p.vx * m / Math.max(1, M) * 0.6; b.vy -= p.vy * m / Math.max(1, M) * 0.6;
            const col = st.cz === 2 && st.cn === 2 ? C.modes.a : (st.cn === 0 ? C.modes.p : (st.cz === 0 ? C.modes.n : C.modes.a));
            p.trail = { color: col, text: st.cz === 2 && st.cn === 2 ? 'α' : (st.cz + st.cn === 1 ? (st.cz ? 'p' : 'n') : shortName(st.cz, st.cn, 0)) };
            addFlash(ex, ey, rN * 4, col);
            const to = st.to;
            setComposition(b, to[0], to[1], to[2], to[3], true);
            b.pulse = 1;
        } else if (st.kind === 'gamma') {
            st.energies.forEach((E, i) => spawnSpark('g', cx, cy, st.dir + i * 2.3, 1, E));
            if (b.iso !== st.iso) setComposition(b, b.Z, b.N, st.iso, 'i', true);
            addFlash(cx, cy, b.R * 1.6, C.gamma);
            b.excited = 0;
        } else if (st.kind === 'fission') {
            fissionSplit(b, st);
        } else if (st.kind === 'capture') {
            // de-excitation gamma of a freshly combined nucleus
            if (st.energy > 0) spawnSpark('g', cx, cy, st.dir, 1, st.energy);
            b.excited = 0;
        }
    }

    function fissionSplit(b, st) {
        const dir = st.dir;
        const [ZH, NH] = st.H, [ZL, NL] = st.L;
        const cx = b.x, cy = b.y;
        const light = makeBody(ZL, NL, 0, cx, cy);
        light.chain = b.chain.slice();
        light.chain.push({ Z: ZL, N: NL, iso: 0, code: 'f' });
        setComposition(b, ZH, NH, 0, 'f', false);
        const sep = (b.R + light.R) * 0.55;
        b.x = cx - Math.cos(dir) * sep; b.y = cy - Math.sin(dir) * sep;
        light.x = cx + Math.cos(dir) * sep; light.y = cy + Math.sin(dir) * sep;
        const v = Math.min(viewW, viewH) * 1.1;
        const AH = ZH + NH, AL = ZL + NL;
        b.vx = -Math.cos(dir) * v * AL / (AH + AL) * 2; b.vy = -Math.sin(dir) * v * AL / (AH + AL) * 2;
        light.vx = Math.cos(dir) * v * AH / (AH + AL) * 2; light.vy = Math.sin(dir) * v * AH / (AH + AL) * 2;
        light.pulse = b.pulse = 1;
        bodies.push(light);
        afterFormed(light, 0.5);
        for (let i = 0; i < st.nu; i++) {
            const a = dir + Math.PI / 2 + (i - (st.nu - 1) / 2) * 0.9 + (Math.random() - 0.5) * 0.5 + (i % 2 ? Math.PI : 0);
            const n = makeBody(0, 1, 0, cx, cy);
            n.transient = true;
            n.emitted = true;
            const sp = Math.max(viewW, viewH) * 0.7;
            n.vx = Math.cos(a) * sp; n.vy = Math.sin(a) * sp;
            n.projectileUntil = realTime + 3;
            n.ignore = [b.id, light.id];
            n.trail = { color: C.modes.n, text: 'n' };
            bodies.push(n);
        }
        addFlash(cx, cy, (b.R + light.R) * 2.2, C.modes.f);
        for (let i = 0; i < 2; i++) spawnSpark('g', cx, cy, Math.random() * TAU, 1, 0);
    }

    // ------------------------------------------------------------------
    // Combining (drop one thing onto another, or a collision)
    // ------------------------------------------------------------------
    function combine(target, other) {
        const Z = target.Z + other.Z, N = target.N + other.N;
        if (Z + N > MAX_A || Z > MAX_Z) { showToast('Too big to build: the limit here is ' + MAX_A + ' nucleons'); return false; }
        if (target.step || target.steps.length) return false;
        const meBefore = massExcess(target.Z, target.N, target.iso) + massExcess(other.Z, other.N, other.iso);
        const lhs = [nucTok(other.Z, other.N, other.iso), nucTok(target.Z, target.N, target.iso)];
        const isNeutron = other.Z === 0 && other.N === 1;
        const fissile = isNeutron && FISSILE[target.Z + ',' + target.N];
        // the combined nucleus: centre of mass, momentum conserved
        const mT = target.types.length, mO = other.types.length;
        const x = (target.x * mT + other.x * mO) / (mT + mO), y = (target.y * mT + other.y * mO) / (mT + mO);
        const vx = (target.vx * mT + other.vx * mO) / (mT + mO), vy = (target.vy * mT + other.vy * mO) / (mT + mO);
        removeBody(other);
        target.types = target.types.concat(other.types);
        target.x = x; target.y = y; target.vx = vx; target.vy = vy;
        target.clock = null;
        target.needsClock = false;
        setComposition(target, Z, N, 0, 'capture', true);
        target.pulse = 1;
        const Q = meBefore - target.info.me;
        addFlash(target.x, target.y, target.R * 1.8, isNeutron ? C.modes.n : C.accent);
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
            target.steps = [{ kind: 'fission', H: fr.H, L: fr.L, nu: fr.nu, from: [Z, N] }];
            target.step = { kind: 'capture', t: 0, dur: 0.35, fired: true, dir: 0 };
            return true;
        }
        const eq = { lhs, rhs: [nucTok(Z, N, 0)], code: 'capture', Q };
        if (Q > 0 && !unbound) eq.rhs.push({ t: 'g', k: 1 });
        target.pendingEq = eq;
        target.pendingTag = isNeutron ? 'neutron capture' : (other.Z === 1 && other.N === 0 ? 'proton capture' : 'fusion');
        target.pendingCode = isNeutron ? 'n' : 'capture';
        logEquation(target);
        if (Q > 0 && !unbound) {
            target.excited = 1;
            target.step = { kind: 'capture', t: 0, dur: STEP_DUR.capture, fired: false, dir: Math.random() * TAU, energy: Q };
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
    function spawnSpark(kind, x, y, angle, speedK, energy) {
        if (sparks.length >= MAX_SPARKS) sparks.shift();
        const base = Math.max(viewW, viewH);
        const sp = base * (kind === 'g' ? 0.8 : (kind === 'nu' || kind === 'nubar' ? 0.62 : 0.42)) * speedK;
        const s = { kind, x, y, vx: Math.cos(angle) * sp, vy: Math.sin(angle) * sp, age: 0, energy: energy || 0, trail: [] };
        if (kind === 'e+') s.annihilateAt = 0.3 + Math.random() * 0.25;    // s: a positron soon meets an electron
        sparks.push(s);
    }
    function addFlash(x, y, r, color) { effects.push({ kind: 'flash', x, y, r, color, age: 0, life: 0.45 }); }
    // A short label over a nucleus that has just decayed ("alpha decay"); it rises, fades and follows the nucleus.
    function addTag(x, y, text, color, body) {
        let stack = 0;
        for (const e of effects) if (e.kind === 'tag' && e.age < 1 && (body ? e.body === body : Math.hypot(e.x - x, e.y - y) < 40)) stack += 1;
        effects.push({ kind: 'tag', x, y, text, color, body: body || null, stack, rise: 0, age: 0, life: 1.9 });
    }
    function showToast(text) { toast = { text, age: 0, life: 2.8 }; }

    function updateSparks(dt) {
        for (let i = sparks.length - 1; i >= 0; i--) {
            const s = sparks[i];
            s.age += dt;
            s.x += s.vx * dt; s.y += s.vy * dt;
            if (s.kind === 'e-' || s.kind === 'e+') {
                s.trail.push(s.x, s.y);
                if (s.trail.length > 16) s.trail.splice(0, 2);
            }
            if (s.annihilateAt && s.age >= s.annihilateAt) {
                // e+ + e- -> two 511 keV photons, back to back
                const a = Math.random() * TAU;
                spawnSpark('g', s.x, s.y, a, 1, M_E);
                spawnSpark('g', s.x, s.y, a + Math.PI, 1, M_E);
                addFlash(s.x, s.y, rN * 3, C.positron);
                sparks.splice(i, 1);
                continue;
            }
            const m = 60;
            if (s.x < -m || s.y < -m || s.x > viewW + m || s.y > viewH + m || s.age > 4) sparks.splice(i, 1);
        }
        for (let i = effects.length - 1; i >= 0; i--) {
            const e = effects[i];
            e.age += dt;
            if (e.kind === 'tag') {
                e.rise += 9 * dt;
                if (e.body && bodies.indexOf(e.body) >= 0) { e.x = e.body.x; e.y = e.body.y - e.body.R - 10; }
            }
            if (e.age >= e.life) effects.splice(i, 1);
        }
        if (toast) { toast.age += dt; if (toast.age > toast.life) toast = null; }
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
        const lines = b.info.stable || b.clock || b.needsClock ? 2 : 1;
        return {
            hw: Math.max(b.R + 6, lw / 2 + 9),
            top: b.R + 7,
            bottom: b.R + 8 + fontPx * (1.25 * lines + (b.id === selectedId ? 1.2 : 0)),
        };
    }

    function updateBodies(dt, clockDt) {
        const wr = workRect();
        const obstacles = [];
        if (S.showChart && layout) obstacles.push(layout.inset);
        panelRects.forEach((r) => obstacles.push(r));
        for (let i = bodies.length - 1; i >= 0; i--) {
            const b = bodies[i];
            if (b.pulse > 0) b.pulse = Math.max(0, b.pulse - dt * 3);
            if (b.step) updateStep(b, dt);
            else if (b.needsClock) {
                b.clockDelay -= dt;
                if (b.clockDelay <= 0) { b.needsClock = false; startClock(b); }
            } else if (b.clock && !paused) {
                b.clock.logT += clockDt;
                if (b.clock.logT >= b.clock.logEnd) { b.clock.logT = b.clock.logEnd; beginDecay(b); }
            }
            if (b.held) continue;
            b.x += b.vx * dt; b.y += b.vy * dt;
            const speed = Math.hypot(b.vx, b.vy);
            if (b.transient && !S.keepParticles) {
                // emitted particles fly straight off the canvas (or bounce off neutron mirrors)
                if (S.mirrorWalls && b.Z === 0) bounceWalls(b, wr, 1);
                const m = b.R + 4;
                if (b.x < -m || b.y < -m || b.x > viewW + m || b.y > viewH + m || realTime - b.born > 6) { removeBody(b); continue; }
            } else {
                const damp = Math.exp(-dt / (b.transient ? 0.35 : 0.55));
                b.vx *= damp; b.vy *= damp;
                // a kept particle comes to rest and joins the rest (a free neutron starts its clock)
                if (b.transient && speed < 40) { b.transient = false; b.emitted = false; afterFormed(b, 0); }
                bounceWalls(b, wr, 0.45);
            }
        }
        // Resting bodies keep their nuclei and labels apart: overlapping boxes are pushed apart along the
        // shorter overlap.
        const boxes = bodies.map((b) => (b.transient ? null : bodyBox(b)));
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
        // Fast things hit what is in their way: neutrons are captured by any nucleus (no charge, no barrier); a
        // thrown nucleus fuses with what it hits.
        for (const p of bodies) {
            if (p.held || p.projectileUntil < realTime) continue;
            if (p.emitted && !(p.Z === 0 && p.N === 1)) continue;
            if (Math.hypot(p.vx, p.vy) < 120) continue;
            for (const t of bodies) {
                if (t === p || t.transient || t.held || t.step || t.steps.length || (p.ignore && p.ignore.indexOf(t.id) >= 0)) continue;
                const d = Math.hypot(t.x - p.x, t.y - p.y);
                if (d < t.R + p.R * 0.6) {
                    if (combine(t, p)) break;
                }
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
        let w = tall ? Math.min(viewW * 0.46, 230) : Math.max(150, Math.min(viewW * 0.27, 300));
        if (viewW < 520 && !tall) w = Math.max(130, viewW * 0.3);
        const cw = chartNMax + 3, ch = chartZMax + 3;
        const h = w * ch / cw;
        const inset = tall ? { x: viewW - w - pad, y: viewH - h - pad, w, h } : { x: viewW - w - pad, y: pad, w, h };
        layout = { tall, pad, inset };
        insetCache = null;
    }

    // ------------------------------------------------------------------
    // Segre chart (N horizontal, Z vertical)
    // ------------------------------------------------------------------
    let insetCache = null;
    const chartList = [];            // [N, Z] of every ground state in the table
    function buildChartList() {
        chartList.length = 0;
        table.forEach((rec) => {
            if (rec.iso) return;
            chartList.push([rec.N, rec.Z]);
        });
    }
    function chartColorOf(Z, N) {
        return C.modes[chartClass(getInfo(Z, N, 0))];
    }

    function renderChartCells(g, x0, y0, cell, nFrom, nTo, zFrom, zTo) {
        // (x0, y0): screen position of the cell (N = nFrom, Z = zTo)'s top-left corner
        const gap = cell >= 6 ? Math.min(1.5, cell * 0.08) : 0;
        for (const it of chartList) {
            const N = it[0], Z = it[1];
            if (N < nFrom || N > nTo || Z < zFrom || Z > zTo) continue;
            g.fillStyle = chartColorOf(Z, N);
            g.fillRect(x0 + (N - nFrom) * cell, y0 + (zTo - Z) * cell, cell - gap, cell - gap);
        }
    }

    function drawInsetChart() {
        const r = layout.inset;
        const nMax = chartNMax + 2, zMax = chartZMax + 2;
        const inner = 6;
        const cell = Math.min((r.w - inner * 2) / (nMax + 1), (r.h - inner * 2) / (zMax + 1));
        const cw = cell * (nMax + 1), chh = cell * (zMax + 1);
        const ox = r.x + (r.w - cw) / 2, oy = r.y + (r.h - chh) / 2;
        if (!insetCache || insetCache.theme !== C.dark || insetCache.w !== r.w || insetCache.dpr !== dpr) {
            const c = document.createElement('canvas');
            c.width = Math.ceil(r.w * dpr); c.height = Math.ceil(r.h * dpr);
            const g = c.getContext('2d');
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            roundRect(g, 0.5, 0.5, r.w - 1, r.h - 1, 6);
            g.fillStyle = C.panel; g.fill();
            g.strokeStyle = C.border; g.lineWidth = 1; g.stroke();
            const lx = ox - r.x, ly = oy - r.y;
            // magic numbers: faint lines, N = Z dashed
            g.strokeStyle = C.faint; g.lineWidth = 1;
            MAGIC.forEach((m) => {
                if (m <= nMax) { g.beginPath(); g.moveTo(lx + (m + 0.5) * cell, ly); g.lineTo(lx + (m + 0.5) * cell, ly + chh); g.stroke(); }
                if (m <= zMax) { g.beginPath(); g.moveTo(lx, ly + (zMax - m + 0.5) * cell); g.lineTo(lx + cw, ly + (zMax - m + 0.5) * cell); g.stroke(); }
            });
            renderChartCells(g, lx, ly, cell, 0, nMax, 0, zMax);
            g.setLineDash([3, 3]);
            g.strokeStyle = C.muted; g.globalAlpha = 0.6;
            g.beginPath(); g.moveTo(lx + 0.5 * cell, ly + (zMax + 0.5) * cell); g.lineTo(lx + (zMax + 0.5) * cell, ly + 0.5 * cell); g.stroke();
            g.setLineDash([]); g.globalAlpha = 1;
            // axis captions
            const fs = Math.max(9, Math.min(11, r.w / 22));
            g.font = `700 ${fs}px "Source Sans Pro", Helvetica, sans-serif`;
            g.fillStyle = C.muted;
            g.textBaseline = 'bottom'; g.textAlign = 'right';
            g.fillText('N →', r.w - inner, r.h - inner + 1);
            g.textBaseline = 'top'; g.textAlign = 'left';
            g.fillText('Z \u2191', inner, inner - 1);
            g.font = `300 ${fs}px "Source Sans Pro", Helvetica, sans-serif`;
            g.fillText('tap to enlarge', inner + fs * 2, inner - 1);
            insetCache = { canvas: c, theme: C.dark, w: r.w, dpr, cell, ox, oy, nMax, zMax };
        }
        ctx.drawImage(insetCache.canvas, r.x, r.y, r.w, r.h);
        const sel = selectedBody();
        if (sel) {
            const toX = (N) => ox + (N + 0.5) * cell, toY = (Z) => oy + (zMax - Z + 0.5) * cell;
            drawChainPath(sel, toX, toY, Math.max(1.2, cell * 0.7), Math.max(3, cell * 2.2));
            const x = toX(sel.N), y = toY(sel.Z);
            ctx.strokeStyle = C.text; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(x, y, Math.max(3.5, cell * 2.4), 0, TAU); ctx.stroke();
        }
    }

    // The decay path of a body on a chart: one arrow per step, in the colour of the decay, with a dark (or
    // light) outline so a yellow alpha arrow still shows over the yellow alpha squares.
    function drawChainPath(b, toX, toY, lw, head) {
        const ch = b.chain;
        if (ch.length < 2) return;
        const halo = C.dark ? 'rgba(10,11,14,0.85)' : 'rgba(255,255,255,0.9)';
        const ow = Math.max(1.5, lw * 0.9);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (let pass = 0; pass < 2; pass++) {
            for (let i = 1; i < ch.length; i++) {
                const a = ch[i - 1], c = ch[i];
                if (a.Z === c.Z && a.N === c.N) continue;
                const x0 = toX(a.N), y0 = toY(a.Z), x1 = toX(c.N), y1 = toY(c.Z);
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

    // Expanded chart: most of the canvas, with zoom, pan, a legend and a nuclide picker.
    const chartView = { open: false, cN: 60, cZ: 40, cell: 4, pick: null, pointers: new Map(), pinch: null, moved: false };
    function chartRects() {
        const m = Math.max(6, layout.pad);
        const panel = { x: m, y: m, w: viewW - 2 * m, h: viewH - 2 * m };
        const fs = Math.max(11, Math.min(14, viewW / 70));
        const head = Math.round(fs * 2.6);
        const legendH = Math.round(fs * 1.9) * (viewW < 560 ? 2 : 1);
        const pickH = chartView.pick ? Math.round(fs * 2.9) : 0;
        // outer: the chart with its axes; area: the cells (tick numbers and captions go in the margins)
        const outer = { x: panel.x + 8, y: panel.y + head, w: panel.w - 16, h: panel.h - head - legendH - pickH - 8 };
        const L = Math.round(fs * 3.0), B = Math.round(fs * 1.7);
        const area = { x: outer.x + L, y: outer.y, w: outer.w - L, h: outer.h - B };
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
    function chartFitCell(rr) { return Math.min(rr.area.w / (chartNMax + 4), rr.area.h / (chartZMax + 4)); }
    function openChart() {
        chartView.pick = null;
        const rr = chartRects();
        chartView.open = true;
        const sel = selectedBody();
        if (sel) {
            let n0 = sel.N, n1 = sel.N, z0 = sel.Z, z1 = sel.Z;
            sel.chain.forEach((c) => { n0 = Math.min(n0, c.N); n1 = Math.max(n1, c.N); z0 = Math.min(z0, c.Z); z1 = Math.max(z1, c.Z); });
            const spanN = Math.max(22, n1 - n0 + 10), spanZ = Math.max(14, z1 - z0 + 8);
            chartView.cell = Math.max(chartFitCell(rr), Math.min(rr.area.w / spanN, rr.area.h / spanZ, 40));
            chartView.cN = (n0 + n1) / 2; chartView.cZ = (z0 + z1) / 2;
        } else {
            chartView.cell = chartFitCell(rr);
            chartView.cN = chartNMax / 2; chartView.cZ = chartZMax / 2;
        }
        clampChartView(rr);
    }
    function clampChartView(rr) {
        const fitC = chartFitCell(rr);
        chartView.cell = Math.max(fitC, Math.min(48, chartView.cell));
        const halfN = rr.area.w / 2 / chartView.cell, halfZ = rr.area.h / 2 / chartView.cell;
        const nMid = (chartNMax + 1) / 2, zMid = (chartZMax + 1) / 2;
        chartView.cN = halfN * 2 >= chartNMax + 4 ? nMid : Math.max(halfN - 2, Math.min(chartNMax + 2 - halfN, chartView.cN));
        chartView.cZ = halfZ * 2 >= chartZMax + 4 ? zMid : Math.max(halfZ - 2, Math.min(chartZMax + 2 - halfZ, chartView.cZ));
    }
    function chartToScreen(rr, N, Z) {
        return [rr.area.x + rr.area.w / 2 + (N - chartView.cN) * chartView.cell, rr.area.y + rr.area.h / 2 - (Z - chartView.cZ) * chartView.cell];
    }
    function screenToChart(rr, x, y) {
        return [chartView.cN + (x - rr.area.x - rr.area.w / 2) / chartView.cell, chartView.cZ - (y - rr.area.y - rr.area.h / 2) / chartView.cell];
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
        const [nA, zB] = screenToChart(rr, A.x, A.y + A.h), [nB, zA] = screenToChart(rr, A.x + A.w, A.y);
        const n0 = Math.floor(nA) - 1, n1 = Math.ceil(nB) + 1, z0 = Math.floor(zB) - 1, z1 = Math.ceil(zA) + 1;
        // magic numbers
        ctx.strokeStyle = C.faint; ctx.lineWidth = Math.max(1, cell * 0.12);
        MAGIC.forEach((m) => {
            const [x] = chartToScreen(rr, m, 0);
            const [, y] = chartToScreen(rr, 0, m);
            ctx.beginPath(); ctx.moveTo(x, A.y); ctx.lineTo(x, A.y + A.h); ctx.stroke();
            if (m < 126) { ctx.beginPath(); ctx.moveTo(A.x, y); ctx.lineTo(A.x + A.w, y); ctx.stroke(); }
        });
        const [tlx, tly] = chartToScreen(rr, n0 - 0.5, z1 + 0.5);
        renderChartCells(ctx, tlx, tly, cell, n0, n1, z0, z1);
        // N = Z
        ctx.setLineDash([4, 4]); ctx.strokeStyle = C.muted; ctx.lineWidth = 1; ctx.globalAlpha = 0.7;
        const [ax, ay] = chartToScreen(rr, -1, -1), [bx, by] = chartToScreen(rr, 130, 130);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        // labels inside the cells when zoomed in: the symbol, and the mass number under it if there is room
        if (cell >= 18) {
            const two = cell >= 28;
            const f1 = Math.min(cell * (two ? 0.32 : 0.45), 15);
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            for (const it of chartList) {
                const N = it[0], Z = it[1];
                if (N < n0 || N > n1 || Z < z0 || Z > z1) continue;
                const [x, y] = chartToScreen(rr, N, Z);
                const cls = chartClass(getInfo(Z, N, 0));
                ctx.fillStyle = (cls === 'stable' && C.dark) || cls === 'a' || cls === 'e' || (cls === 'unknown' && !C.dark) ? '#1d1f24' : '#ffffff';
                ctx.font = font(700, f1);
                if (two) {
                    ctx.fillText(elementSymbol(Z), x, y - f1 * 0.5);
                    ctx.font = font(300, f1 * 0.9);
                    ctx.fillText(String(Z + N), x, y + f1 * 0.6);
                } else {
                    ctx.fillText(elementSymbol(Z), x, y);
                }
            }
        }
        // magic-number captions along the edges
        ctx.font = `700 ${fs * 0.8}px "Source Sans Pro", Helvetica, sans-serif`;
        ctx.fillStyle = C.muted;
        MAGIC.forEach((m) => {
            const [x] = chartToScreen(rr, m, 0);
            const [, y] = chartToScreen(rr, 0, m);
            if (x > A.x + 10 && x < A.x + A.w - 10) { ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText('N=' + m, x, A.y + 2); }
            if (m < 126 && y > A.y + 10 && y < A.y + A.h - 10) { ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText('Z=' + m, A.x + 3, y - 1); }
        });
        // chain of the selected nucleus
        const sel = selectedBody();
        const toX = (N) => chartToScreen(rr, N, 0)[0], toY = (Z) => chartToScreen(rr, 0, Z)[1];
        if (sel) {
            drawChainPath(sel, toX, toY, Math.max(2, Math.min(4, cell * 0.18)), Math.max(7, Math.min(12, cell * 0.5)));
            ctx.strokeStyle = C.text; ctx.lineWidth = 2;
            const [x, y] = chartToScreen(rr, sel.N, sel.Z);
            ctx.beginPath(); ctx.arc(x, y, Math.max(6, cell * 0.85), 0, TAU); ctx.stroke();
        }
        if (chartView.pick) {
            const [x, y] = chartToScreen(rr, chartView.pick.N, chartView.pick.Z);
            ctx.strokeStyle = C.accent; ctx.lineWidth = 2.5;
            ctx.strokeRect(x - cell / 2 - 1.5, y - cell / 2 - 1.5, cell + 3, cell + 3);
        }
        ctx.restore();
        // axes: tick numbers along the bottom and the left, captions at the ends
        const step = [1, 2, 5, 10, 20, 50].find((v) => v * cell >= fs * 2.4) || 50;
        ctx.fillStyle = C.muted;
        ctx.font = font(700, fs * 0.85);
        const capN = 'Neutrons N \u2192', capZ = 'Protons Z \u2192';
        const capNW = ctx.measureText(capN).width, capZW = ctx.measureText(capZ).width;
        ctx.textAlign = 'right'; ctx.textBaseline = 'top';
        ctx.fillText(capN, A.x + A.w, A.y + A.h + 4);
        ctx.save();
        ctx.translate(rr.outer.x, A.y + A.h); ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(capZ, 0, 0);
        ctx.restore();
        ctx.font = font(300, fs * 0.8);
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (let n = Math.max(0, Math.ceil(nA / step) * step); n <= nB; n += step) {
            const [x] = chartToScreen(rr, n, 0);
            if (x > A.x + 6 && x < A.x + A.w - capNW - fs) ctx.fillText(String(n), x, A.y + A.h + 4);
        }
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        for (let z = Math.max(0, Math.ceil(zB / step) * step); z <= zA; z += step) {
            const [, y] = chartToScreen(rr, 0, z);
            if (y > A.y + 6 && y < A.y + A.h - capZW - fs * 0.5) ctx.fillText(String(z), A.x - 4, y);
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
        drawBin();
        drawBodies();
        drawSparks();
        drawEffects();
        drawPanels();
        drawGhost();
        drawToast();
        if (chartView.open) drawExpandedChart();
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
        const t = realTime;
        // order: transient particles on top
        const list = bodies.slice().sort((a, b) => (a.transient - b.transient) || (a.held - b.held));
        for (const b of list) {
            let x = b.x, y = b.y;
            if (!b.transient && !b.held) y += Math.sin(t * 1.3 + b.bob) * 0.8;
            const st = b.step;
            const scale = 1 + 0.08 * b.pulse;
            // excited nucleus: a soft halo
            if (b.excited > 0 || b.iso) {
                const k = b.iso ? 0.55 + 0.15 * Math.sin(t * 3 + b.bob) : 1;
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
            // electron capture: an inner-shell electron spirals in
            if (st && st.kind === 'ec' && !st.fired) {
                const u = Math.min(1, st.t / (st.dur * 0.55));
                const shellR = b.R + 16 + rN * 2;
                ctx.strokeStyle = hexA(C.electron, 0.45 * (1 - u * 0.5)); ctx.lineWidth = 1;
                ctx.setLineDash([3, 4]);
                ctx.beginPath(); ctx.arc(x, y, shellR, 0, TAU); ctx.stroke();
                ctx.setLineDash([]);
                const rr = shellR * (1 - u) + b.R * 0.3 * u;
                const ang = st.dir + u * 5;
                const ex = x + Math.cos(ang) * rr, ey = y + Math.sin(ang) * rr;
                drawDot(ex, ey, Math.max(2.4, rN * 0.62), C.electron);
                ctx.font = font(700, Math.max(10, fontPx * 0.85)); ctx.fillStyle = ink(C.electron);
                ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                ctx.fillText('e\u207b', ex + 5, ey - 8);
            }
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
            }
            // the nucleon that changed in a beta decay or electron capture lights up
            if (b.glow) {
                const age = t - b.glow.t;
                if (age > 0.7) b.glow = null;
                else {
                    const a = 1 - age / 0.7;
                    const g = ctx.createRadialGradient(x + b.glow.x, y + b.glow.y, 0, x + b.glow.x, y + b.glow.y, rN * 3);
                    g.addColorStop(0, hexA('#ffffff', 0.9 * a));
                    g.addColorStop(0.4, hexA(b.glow.color, 0.6 * a));
                    g.addColorStop(1, hexA(b.glow.color, 0));
                    ctx.fillStyle = g;
                    ctx.beginPath(); ctx.arc(x + b.glow.x, y + b.glow.y, rN * 3, 0, TAU); ctx.fill();
                }
            }
            if (b.transient) {
                if (b.trail && !b.held) drawTrail(b, x, y);
                continue;
            }
            drawClockRing(b, x, y);
            if (!S.hideLabels) drawLabel(b, x, y, sel === b);
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
            ctx.font = font(700, fontPx);
            ctx.textAlign = 'center';
            ctx.fillText(info.name, x, ly);
            b.labelW = ctx.measureText(info.name).width;
        }
        const y2 = ly + fontPx * 1.2;
        ctx.font = font(300, Math.max(11, fontPx * 0.92));
        ctx.fillStyle = C.muted;
        if (b.step || b.needsClock && !info.stable) return;
        if (info.stable) {
            ctx.textAlign = 'center';
            ctx.fillText('Stable', x, y2);
        } else if (b.clock) {
            const d = formatDuration(Math.pow(10, b.clock.logT));
            // a stopwatch, then the number right-aligned at a fixed point so its digits stay put
            const icon = fontPx * 0.95;
            const wNum = ctx.measureText('0.00').width, wUnit = ctx.measureText(' ' + d.unit).width;
            const x0 = x - (icon + wNum + wUnit) / 2 + icon;
            drawStopwatch(x0 - icon * 0.55, y2 - fontPx * 0.3, icon * 0.34);
            ctx.textAlign = 'right';
            ctx.fillStyle = C.text;
            ctx.fillText(d.num, x0 + wNum, y2);
            ctx.textAlign = 'left';
            ctx.fillStyle = C.muted;
            ctx.fillText(' ' + d.unit, x0 + wNum, y2);
            b.labelW = Math.max(b.labelW, icon + wNum + wUnit);
            if (selected) {
                ctx.textAlign = 'center';
                ctx.font = font(300, Math.max(10.5, fontPx * 0.85));
                const t = 'half-life ' + formatHalfLife(info.hl);
                ctx.fillText(t, x, y2 + fontPx * 1.15);
                b.labelW = Math.max(b.labelW, ctx.measureText(t).width);
            }
        }
    }

    // A flying alpha, proton or neutron: a fading streak behind it and its symbol.
    function drawTrail(b, x, y) {
        const sp = Math.hypot(b.vx, b.vy);
        if (sp < 30) return;
        const ux = b.vx / sp, uy = b.vy / sp;
        const len = Math.min(70, sp * 0.08 + 16);
        const g = ctx.createLinearGradient(x, y, x - ux * len, y - uy * len);
        g.addColorStop(0, hexA(b.trail.color, 0.7));
        g.addColorStop(1, hexA(b.trail.color, 0));
        ctx.strokeStyle = g; ctx.lineWidth = Math.max(2, b.R * 0.8); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(x - ux * b.R * 0.5, y - uy * b.R * 0.5); ctx.lineTo(x - ux * len, y - uy * len); ctx.stroke();
        ctx.lineCap = 'butt';
        if (S.hideLabels) return;
        ctx.font = font(700, Math.max(11, fontPx * 0.95)); ctx.fillStyle = ink(b.trail.color);
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(b.trail.text, x + b.R + 4, y - b.R - 4);
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
        const lw = Math.max(1.5, rN * 0.45);
        const fsSmall = Math.max(10, fontPx * 0.85);
        for (const s of sparks) {
            if ((s.kind === 'nu' || s.kind === 'nubar') && !S.showNeutrinos) continue;
            const sp = Math.hypot(s.vx, s.vy) || 1;
            const ux = s.vx / sp, uy = s.vy / sp;
            if (s.kind === 'g') {
                // a wave packet travelling along its path
                const len = Math.max(26, rN * 7), amp = Math.max(3, rN * 0.9), k = TAU / Math.max(7, rN * 2);
                ctx.strokeStyle = C.gamma; ctx.lineWidth = lw;
                ctx.beginPath();
                for (let i = 0; i <= 24; i++) {
                    const d = -len * i / 24;
                    const env = Math.sin(Math.PI * i / 24);
                    const o = Math.sin(d * k + s.age * 40) * amp * env;
                    const px = s.x + ux * d - uy * o, py = s.y + uy * d + ux * o;
                    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
                }
                ctx.stroke();
                if (S.showDetails && s.energy > 0 && s.age < 0.9) {
                    ctx.font = font(700, fsSmall); ctx.fillStyle = ink(C.gamma); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                    ctx.fillText(formatEnergy(s.energy), s.x + 6, s.y - 10);
                }
                continue;
            }
            if (s.kind === 'nu' || s.kind === 'nubar') {
                ctx.strokeStyle = C.neutrino; ctx.lineWidth = 1;
                ctx.setLineDash([2, 4]);
                ctx.beginPath(); ctx.moveTo(s.x - ux * 30, s.y - uy * 30); ctx.lineTo(s.x, s.y); ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = C.neutrino;
                ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(2, rN * 0.45), 0, TAU); ctx.fill();
                if (s.age > 0.12 && s.age < 0.9 && !S.hideLabels) {
                    ctx.font = font(700, fsSmall); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                    ctx.fillText(s.kind === 'nu' ? 'ν' : 'ν̄', s.x + 5, s.y - 8);
                }
                continue;
            }
            const col = s.kind === 'e-' ? C.electron : C.positron;
            if (s.trail.length >= 4) {
                ctx.strokeStyle = hexA(col, 0.45); ctx.lineWidth = Math.max(1.5, rN * 0.4);
                ctx.beginPath(); ctx.moveTo(s.trail[0], s.trail[1]);
                for (let i = 2; i < s.trail.length; i += 2) ctx.lineTo(s.trail[i], s.trail[i + 1]);
                ctx.stroke();
            }
            drawDot(s.x, s.y, Math.max(2.4, rN * 0.62), col);
            if (s.age > 0.12 && s.age < 0.9 && !S.hideLabels) {   // once clear of the nucleus's own label
                ctx.font = font(700, fsSmall); ctx.fillStyle = ink(col); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                ctx.fillText(s.kind === 'e-' ? 'e⁻' : 'e⁺', s.x + 6, s.y - 9);
            }
        }
    }

    function drawEffects() {
        for (const e of effects) {
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
                const w = ctx.measureText(e.text).width;
                const x = Math.max(w / 2 + 4, Math.min(viewW - w / 2 - 4, e.x));
                const y = Math.max(fontPx + 4, e.y - e.rise - e.stack * fontPx * 1.3);
                ctx.lineWidth = 3; ctx.strokeStyle = C.bg; ctx.lineJoin = 'round';
                ctx.strokeText(e.text, x, y);
                ctx.fillStyle = ink(e.color);
                ctx.fillText(e.text, x, y);
                ctx.globalAlpha = 1;
            }
        }
    }

    // Top-left: the decay equations (newest first) and the selected nucleus's details.
    function drawPanels() {
        const pad = layout.pad;
        let y = pad;
        panelRects = [];
        const maxW = (layout.tall || !S.showChart ? viewW : layout.inset.x) - pad * 2 - 4;
        if (S.showEquations) {
            const fs = Math.max(12, Math.min(16, viewW / 70));
            const lineH = fs * 1.75;
            const items = eqLog.slice(-4).reverse();
            const showQ = S.showDetails;
            const widths = items.map((it) => drawEquation(ctx, it.eq, 0, 0, fs, false) + (showQ ? qWidth(it.eq, fs) : 0));
            const w = Math.min(maxW, Math.max(fs * 10, ...widths) + fs * 1.4);
            const h = items.length ? items.length * lineH + fs * 0.6 : lineH + fs * 0.4;
            roundRect(ctx, pad, y, w, h, 6);
            ctx.fillStyle = C.panel; ctx.fill();
            ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
            panelRects.push({ x: pad, y, w, h });
            ctx.save();
            ctx.beginPath(); ctx.rect(pad, y, w, h); ctx.clip();
            if (!items.length) {
                ctx.font = font(300, fs * 0.9); ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                ctx.fillText('Decay equations appear here', pad + fs * 0.7, y + h / 2);
            }
            items.forEach((it, i) => {
                const ly = y + fs * 0.3 + lineH * (i + 0.5) + fs * 0.32;
                ctx.globalAlpha = i === 0 ? 1 : Math.max(0.35, 0.8 - i * 0.15);
                ctx.fillStyle = it.color;
                ctx.fillRect(pad + fs * 0.3, ly - fs * 0.75, 3, fs * 1.05);
                ctx.fillStyle = C.text;
                const ew = drawEquation(ctx, it.eq, pad + fs * 0.75, ly, fs, true);
                if (showQ) {
                    ctx.font = font(300, fs * 0.8); ctx.fillStyle = C.muted; ctx.textAlign = 'left';
                    ctx.fillText(qText(it.eq), pad + fs * 0.75 + ew + fs * 0.8, ly);
                }
            });
            ctx.restore();
            ctx.globalAlpha = 1;
            y += h + pad * 0.7;
        }
        const sel = selectedBody();
        if (S.showDetails && sel && !sel.transient) drawDetails(sel, pad, y, maxW);
    }
    function qText(eq) { return 'Q = ' + formatEnergy(eq.Q); }
    function qWidth(eq, fs) { ctx.font = font(300, fs * 0.8); return ctx.measureText(qText(eq)).width + fs * 0.8; }

    function drawDetails(b, x, y, maxW) {
        const info = b.info;
        const fs = Math.max(11, Math.min(14, viewW / 85));
        const lines = [];
        lines.push([b.Z + ' protons, ' + b.N + ' neutrons' + (b.Z > 0 ? '  (N/Z = ' + (b.N / b.Z).toFixed(2) + ')' : ''), C.text]);
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
        ctx.font = font(300, fs);
        let w = 0;
        lines.forEach(([t]) => { w = Math.max(w, ctx.measureText(t).width); });
        ctx.font = font(700, titleFs);
        w = Math.min(maxW, Math.max(w, ctx.measureText(info.name).width + titleFs * 3.2) + fs * 1.6);
        const h = titleFs * 1.7 + lines.length * lineH + fs * 0.4;
        roundRect(ctx, x, y, w, h, 6);
        ctx.fillStyle = C.panel; ctx.fill();
        ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
        panelRects.push({ x, y, w, h });
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
        lines.forEach(([t, col], i) => {
            ctx.fillStyle = col;
            ctx.textAlign = 'left';
            ctx.fillText(t, x + fs * 0.8, ty + titleFs * 0.45 + lineH * (i + 1));
        });
        ctx.restore();
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
        const w = Math.min(viewW - 20, ctx.measureText(toast.text).width + fontPx * 2);
        const h = fontPx * 2.2;
        const x = (viewW - w) / 2, y = viewH - h - layout.pad;
        roundRect(ctx, x, y, w, h, h / 2);
        ctx.fillStyle = C.panelSolid; ctx.fill();
        ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(fitText(toast.text, w - fontPx), viewW / 2, y + h / 2 + 0.5);
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
        throwBody(b, d.samples);
    }

    function throwBody(b, samples) {
        if (samples.length < 2) return;
        const now = performance.now();
        const recent = samples.filter((s) => now - s[0] < 120);
        if (recent.length < 2) return;
        const a = recent[0], c = recent[recent.length - 1];
        const dt = Math.max(0.016, (c[0] - a[0]) / 1000);
        let vx = (c[1] - a[1]) / dt, vy = (c[2] - a[2]) / dt;
        const sp = Math.hypot(vx, vy);
        const max = Math.max(viewW, viewH) * 2.5;
        if (sp > max) { vx *= max / sp; vy *= max / sp; }
        b.vx = vx; b.vy = vy;
        if (sp > 250) b.projectileUntil = realTime + 1.5;
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
            chartView.cN -= dx / chartView.cell;
            chartView.cZ += dy / chartView.cell;
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
            const [n, z] = screenToChart(rr, p.x, p.y);
            const N = Math.round(n), Z = Math.round(z);
            chartView.pick = table.has(key(Z, N, 0)) ? { Z, N } : null;
        }
    }
    function zoomChartAt(rr, x, y, factor) {
        const [n, z] = screenToChart(rr, x, y);
        chartView.cell *= factor;
        clampChartView(rr);
        // keep the point under the fingers / cursor in place
        const [n2, z2] = screenToChart(rr, x, y);
        chartView.cN += n - n2; chartView.cZ += z - z2;
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
        const inset = S.showChart ? layout.inset : null;
        let best = { x: viewW * 0.4, y: viewH * 0.45 }, bd = -1;
        for (let i = 0; i < 40; i++) {
            const x = wr.x0 + 40 + Math.random() * (wr.x1 - wr.x0 - 80);
            const y = wr.y0 + 40 + Math.random() * (wr.y1 - wr.y0 - 100);
            if (inset && x > inset.x - 40 && x < inset.x + inset.w + 40 && y > inset.y - 50 && y < inset.y + inset.h + 40) continue;
            let d = 1e9;
            for (const b of bodies) d = Math.min(d, Math.hypot(b.x - x, b.y - y) - b.R);
            if (d > bd) { bd = d; best = { x, y }; }
        }
        return best;
    }

    // --- the tray (palette strip) ---
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
            btn.title = (particle ? info.name : info.name + ': ' + desc) + (pr.note && !particle ? ' (' + pr.note + ')' : '') + '. Drag onto the canvas, or tap to add.';
            btn.setAttribute('aria-label', 'Add ' + info.name);
            const cls = chartClass(info);
            if (particle) {
                btn.innerHTML = '<span class="nuc-ball nuc-ball-' + (pr.Z ? 'p' : 'n') + '" aria-hidden="true"></span><span class="nuc-item-text">' + (pr.Z ? 'p' : 'n') + '</span>';
            } else {
                btn.innerHTML = '<span class="nuc-item-text"><sup>' + (pr.Z + pr.N) + (pr.iso ? 'm' : '') + '</sup>' + elementSymbol(pr.Z) + '</span>' +
                    '<span class="nuc-mode nuc-mode-' + cls + '" aria-hidden="true"></span>';
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
            e.preventDefault();
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

    // ------------------------------------------------------------------
    // Settings panel and readouts
    // ------------------------------------------------------------------
    function bindControls() {
        if (ui.speed) {
            const upd = () => {
                S.speed = parseFloat(ui.speed.value) || 1;
                if (ui.speedVal) ui.speedVal.textContent = S.speed.toFixed(2);
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
            });
        });
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
        bodies = []; sparks = []; effects = []; eqLog = []; toast = null;
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
        rN = Math.max(2.6, Math.min(5.2, Math.min(viewW, viewH * 2) / 180));
        fontPx = Math.max(12, Math.min(14, viewW / 85));
        computeLayout();
        buildNucleonSprites();
        if (oldW > 0) {
            bodies.forEach((b) => { b.x *= viewW / oldW; b.y *= viewH / oldH; buildSprite(b); });
            sparks.forEach((s) => { s.x *= viewW / oldW; s.y *= viewH / oldH; });
            // a phone turned between portrait and landscape: once the layout has settled, spread out again
            if (wasTall !== null && wasTall !== layout.tall) {
                clearTimeout(spreadTimer);
                spreadTimer = setTimeout(spreadOut, 250);
            }
        }
        render();
        return true;
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
    function frame(ts) {
        requestAnimationFrame(frame);   // first, so the loop keeps going whatever happens below
        const dt = lastTs && !frozen ? Math.min(MAX_FRAME_DT, (ts - lastTs) / 1000) : 0;
        lastTs = ts;
        const t0 = performance.now();
        realTime += dt;
        updateBodies(dt, dt * DECADES_PER_S * S.speed);
        updateSparks(dt);
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
            id: b.id, Z: b.Z, N: b.N, iso: b.iso, name: b.info.name, x: b.x, y: b.y, R: b.R, stable: b.info.stable,
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
        // Throw a neutron at a body from the left
        fireNeutron: (id, forceFission) => {
            const t = bodies.find((o) => o.id === id);
            if (!t) return false;
            const n = addBody(0, 1, 0, Math.max(10, t.x - 160), t.y);
            if (!n) return false;
            n.vx = 900; n.vy = 0; n.projectileUntil = realTime + 2;
            n.forceFission = !!forceFission;
            return true;
        },
        combine: (idA, idB) => {
            const a = bodies.find((o) => o.id === idA), b = bodies.find((o) => o.id === idB);
            return a && b ? combine(a, b) : false;
        },
        setSpeed: (v) => { if (ui.speed) { ui.speed.value = v; ui.speed.dispatchEvent(new Event('input')); } else S.speed = v; },
        setShow: (name, on) => {
            const el = { chart: ui.showChart, tags: ui.showTags, neutrinos: ui.showNeutrinos, equations: ui.showEquations, details: ui.showDetails, notation: ui.notation, keep: ui.keepParticles, mirror: ui.mirrorWalls }[name];
            if (el) { el.checked = !!on; el.dispatchEvent(new Event('change')); }
        },
        hideLabels: (v) => { S.hideLabels = !!v; },   // for pictures of the canvas (e.g. the home-page tile)
        openChart: (open) => { if (open) openChart(); else chartView.open = false; },
        pickChart: (Z, N) => { chartView.pick = { Z, N }; },
        pause: (v) => { paused = v === undefined ? !paused : !!v; return paused; },
        freeze: (v) => { frozen = !!v; },
        // Run the simulation synchronously (no drawing) for `seconds` of real time.
        advance: (seconds) => {
            for (let t = 0; t < seconds; t += 1 / 30) {
                realTime += 1 / 30;
                updateBodies(1 / 30, DECADES_PER_S * S.speed / 30);
                updateSparks(1 / 30);
            }
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
        formatDuration: durationText,
        formatHalfLife,
        equations: () => eqLog.map((e) => ({ code: e.eq.code, Q: e.eq.Q, lhs: e.eq.lhs, rhs: e.eq.rhs })),
        sparks: () => sparks.map((s) => s.kind),
        state: () => ({ viewW, viewH, dpr, rN, fontPx, bodies: bodies.length, sparks: sparks.length, selected: selectedId, chartOpen: chartView.open, layout, settings: Object.assign({}, S) }),
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
    buildPalette();
    resizeCanvas();
    resetScene(true);
    updateReadouts();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resizeCanvas).observe(canvas);
    window.addEventListener('resize', resizeCanvas);
    new MutationObserver(() => {
        readPalette();
        buildNucleonSprites();
        bodies.forEach(buildSprite);
        insetCache = null;
        buildPalette();
        render();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    requestAnimationFrame(frame);
})();
