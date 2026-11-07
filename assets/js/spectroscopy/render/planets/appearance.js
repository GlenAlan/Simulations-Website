// Turns a planet's physical data into the numbers its shader draws with. Composition, temperature and mass decide
// colour, haze, clouds and glow; visual_seed only moves patterns about, so two planets of the same make look like
// siblings, not clones (spec 6.4). Nothing here reads planet.type: every look emerges from the physical fields.
// Pure: no three.js, no DOM, no WebGL, so it can be tested in Node. All colours are linear RGB.

import { blackBodyRGB } from '../../core/phys.js';
import { hashString, Rng } from '../../core/rng.js';

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (a, b, x) => {
    const k = clamp((x - a) / (b - a));
    return k * k * (3 - 2 * k);
};
const finite = (x, fallback) => (Number.isFinite(x) ? x : fallback);
const mix3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const mul3 = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const scale3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const zero3 = () => [0, 0, 0];

// 0-255 sRGB, the way a designer picks a colour, to linear RGB
function srgb(r, g, b) {
    const f = (v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return [f(r), f(g), f(b)];
}

// A colour through a list of [x, colour] stops, in order of x
function ramp(stops, x) {
    if (x <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
        if (x <= stops[i][0]) {
            const [x0, c0] = stops[i - 1];
            const [x1, c1] = stops[i];
            return mix3(c0, c1, smooth(x0, x1, x));
        }
    }
    return stops[stops.length - 1][1];
}

// Inverse of the normal distribution (Acklam's rational fit, shortened): a noise field is roughly normal, so this
// turns "this fraction of the area" into the height to cut it at.
function normalQuantile(p) {
    const q = clamp(p, 0.002, 0.998);
    const t = Math.sqrt(-2 * Math.log(q < 0.5 ? q : 1 - q));
    const x = t - (2.515517 + t * (0.802853 + t * 0.010328)) / (1 + t * (1.432788 + t * (0.189269 + t * 0.001308)));
    return q < 0.5 ? -x : x;
}

// Spread of the fields the shader cuts at a level, measured from the shaders in the test harness
const ELEVATION_SIGMA = 0.27;
const CLOUD_SIGMA = 0.2;

// The light of the host, kept near the same brightness whatever the star's colour, so a red dwarf's world is
// tinted rather than dark. K stars give an orange cast, M stars a red one, A and B stars a white-blue one.
export function hostLight(hostTeffK) {
    const bb = blackBodyRGB(finite(hostTeffK, 5800));
    const c = mix3([1, 1, 1], bb, 0.78);
    return scale3(c, 1 / luma(c));
}

// Rock and ice colours: main material, darker, brighter
const ROCKS = {
    basalt: [srgb(74, 70, 68), srgb(40, 39, 42), srgb(120, 112, 104)],
    rust: [srgb(176, 106, 68), srgb(112, 68, 48), srgb(212, 160, 118)],
    sand: [srgb(192, 158, 112), srgb(146, 110, 76), srgb(226, 200, 158)],
    silicate: [srgb(150, 138, 122), srgb(96, 90, 84), srgb(190, 180, 164)],
    iron: [srgb(112, 104, 98), srgb(64, 60, 58), srgb(150, 140, 130)],
    sulphur: [srgb(196, 172, 86), srgb(126, 100, 50), srgb(232, 214, 140)],
    carbon: [srgb(50, 48, 48), srgb(26, 25, 26), srgb(84, 80, 78)],
    waterIce: [srgb(226, 238, 248), srgb(168, 200, 226), srgb(255, 255, 255)],
    tholin: [srgb(206, 164, 132), srgb(134, 80, 60), srgb(242, 226, 210)]
};

function rockColours(rock, ice) {
    const r = String(rock || '').toLowerCase();
    const i = String(ice || '').toLowerCase();
    if (!r && /water|h2o/.test(i)) return ROCKS.waterIce;
    if (!r && i) return ROCKS.tholin;
    if (/basalt|mafic|lava|molten|magma/.test(r)) return ROCKS.basalt;
    if (/oxide|rust|hematite|ferric/.test(r)) return ROCKS.rust;
    if (/sand|desert|dune|arid/.test(r)) return ROCKS.sand;
    if (/sulph|sulf/.test(r)) return ROCKS.sulphur;
    if (/carbon|graphite/.test(r)) return ROCKS.carbon;
    if (/iron|metal/.test(r)) return ROCKS.iron;
    return ROCKS.silicate;
}

function readGases(planet) {
    const pct = planet.atmosphere_pct || {};
    const ppm = planet.atmosphere_ppm || {};
    const amount = (id) => Math.max(0, finite(pct[id], 0)) + Math.max(0, finite(ppm[id], 0)) / 1e4;
    const ids = new Set([...Object.keys(pct), ...Object.keys(ppm)]);
    let total = 0;
    ids.forEach((id) => { total += amount(id); });
    return { amount, total, ids };
}

// Grams per mole, for how puffy an atmosphere is
const MOLAR = { H2: 2, He: 4, CH4: 16, NH3: 17, H2O: 18, N2: 28, CO: 28, O2: 32, Ar: 40, CO2: 44, SO2: 64, Na: 23, K: 39, SiO: 44, TiO: 64 };
// Rayleigh scattering per molecule relative to N2
const RAYLEIGH = { H2: 0.22, He: 0.015, CH4: 2.3, NH3: 1.7, H2O: 0.8, N2: 1, CO: 1.2, O2: 0.85, Ar: 0.85, CO2: 2.5, SO2: 4 };

// Traces of methane barely tint a giant; a percent or two takes out the red and turns it cyan-blue
function methaneEffect(pct) {
    return 1 - Math.exp(-0.6 * pct * pct);
}

function atmosphereFrom(ctx) {
    const { gas, T, mass, radius, pressure, envelope, deck, sun, clouds } = ctx;
    if (!envelope && !deck && gas.total <= 0 && pressure <= 1e-6) {
        return { on: false, H: 0, top: 1, betaR: zero3(), betaM: zero3(), betaA: zero3(), g: 0, gain: 0, limb: zero3(), rim: 0, rimPower: 8, hazeGlow: 0, wrap: 0, sunHaze: 0 };
    }
    const total = gas.total || 1;
    let mu = 0;
    let scatter = 0;
    let known = 0;
    gas.ids.forEach((id) => {
        const f = gas.amount(id) / total;
        if (MOLAR[id]) {
            mu += MOLAR[id] * f;
            known += f;
        }
        scatter += (RAYLEIGH[id] ?? 1) * f;
    });
    mu = known > 0 ? mu / known : 28;
    if (gas.total <= 0) scatter = 1;

    // Scale height over radius goes as T R / (mu M). The real values are hair-thin, so it is drawn wider but keeps
    // its ordering: puffy hot sub-Neptunes, thin heavy CO2 shells.
    const puff = T * radius / (mu * Math.max(0.02, mass));
    const H = clamp(0.0145 * Math.sqrt(puff / 10), 0.008, 0.032);

    // How much gas lies above what we see: the whole column on a rocky world, down to the cloud tops on a giant
    const column = envelope ? 1.15 : deck ? 1.4 : clamp(pressure ** 0.55, 0.02, 2.4);
    const blueTau = (deck ? 0.012 : envelope ? 0.07 : 0.22) * scatter * column;

    const ch4 = gas.amount('CH4');
    const ch4Eff = methaneEffect(ch4);
    // Alkali metals absorb so strongly that a few parts per million are enough to show
    const alkali = smooth(1e-5, 2e-4, gas.amount('Na') + gas.amount('K') + gas.amount('SiO'));
    const so2 = 1 - Math.exp(-gas.amount('SO2') * 6);
    const o3 = gas.amount('O3') > 0 ? 0.02 : 0;

    // Haze: grey-ish droplets and dust that widen and soften the limb
    const kind = clouds.kind;
    let hazeTau = 0.03 * column;
    let hazeColour = [1, 1, 1];
    let g = 0.76;
    if (deck) {
        hazeTau = 0.5;
        hazeColour = srgb(255, 232, 178);
        g = 0.45;
    } else if (kind === 'DUST') {
        hazeTau = 0.03 + 0.12 * clamp(clouds.cover * 2);
        hazeColour = ctx.rockMain ? mix3(ctx.rockMain, [1, 1, 1], 0.45) : srgb(230, 190, 150);
        g = 0.7;
    } else if (envelope) {
        const puffiness = smooth(8, 40, puff);
        hazeTau = lerp(0.1, 0.34, puffiness) + 0.12 * ch4Eff;
        hazeColour = mix3(srgb(255, 240, 214), srgb(206, 236, 255), ch4Eff);
        g = 0.55;
    } else if (kind === 'H2O') {
        hazeTau = 0.018 * column;
        g = 0.8;
    }
    if (alkali > 0.05 && envelope) {
        hazeTau *= 0.6;
        hazeColour = mix3(hazeColour, srgb(214, 104, 150), alkali);
    }

    const rayleigh = [0.15, 0.4, 1];
    const betaR = scale3(rayleigh, blueTau / H);
    const betaM = scale3(hazeColour, hazeTau / H);
    // CH4 eats red and some green; alkali vapour eats yellow-green and leaves a purple-red limb; SO2 eats blue
    const absorb = [
        0.55 * ch4Eff + 0.06 * alkali,
        0.07 * ch4Eff + 0.75 * alkali + 0.03 * so2 + o3,
        0.14 * alkali + 0.22 * so2
    ];
    const betaA = scale3(absorb, 1 / H);

    // In-scattered brightness, a drawing choice. Thin air would otherwise vanish at small sizes.
    const gain = lerp(3.4, 1.5, smooth(0.1, 1.5, column));

    // For Low quality, which skips the shell: the same colour as a Fresnel rim
    const skyColour = add3(mul3(scale3(rayleigh, blueTau), [1, 1, 1]), scale3(hazeColour, hazeTau * 0.8));
    const m = Math.max(skyColour[0], skyColour[1], skyColour[2], 1e-3);
    const limb = mul3(mul3(scale3(skyColour, 1 / m), mix3([1, 1, 1], sun, 0.5)), [Math.exp(-absorb[0] * 2), Math.exp(-absorb[1] * 2), Math.exp(-absorb[2] * 2)]);
    const rim = clamp(0.25 + 0.75 * smooth(0.02, 1.2, column)) * (1 - 0.55 * alkali);
    const rimPower = lerp(6.5, 2.6, smooth(0.01, 0.05, H));

    return {
        on: true,
        H,
        top: 1 + Math.min(0.3, H * 6),
        betaR,
        betaM,
        betaA,
        g,
        gain,
        limb,
        rim,
        rimPower,
        hazeGlow: (deck ? 0.75 : envelope ? lerp(0.32, 0.5, smooth(6, 36, puff)) : lerp(0.3, 0.55, smooth(0.1, 2, column))) * (1 - 0.35 * alkali),
        wrap: deck ? 0.22 : envelope ? 0.1 : lerp(0.0, 0.1, smooth(0.5, 5, pressure)),
        sunHaze: deck ? 0.12 : 0.3            // How much of the haze takes light out of the sunbeam for good
    };
}

// Cloud tops of a hydrogen giant through the temperature sequence: pale ammonia gold when frozen out, cream and tan
// where ammonia clouds form, white water cloud when warmer, clear and blue-grey, then dark where alkali metals absorb.
function envelopeColours(ctx) {
    const { gas, T, mass, deck } = ctx;
    if (deck) {
        const so2 = 1 - Math.exp(-gas.amount('SO2') * 6);
        const zone = mix3(srgb(232, 216, 176), srgb(234, 212, 152), so2);
        return {
            zone,
            belt: mix3(zone, srgb(172, 134, 84), 0.9),
            accent: srgb(212, 180, 124),
            storm: srgb(240, 230, 200),
            ch4Eff: 0
        };
    }
    const zone = ramp([
        [85, srgb(216, 208, 180)],
        [140, srgb(242, 232, 208)],
        [230, srgb(238, 238, 230)],
        [430, srgb(226, 232, 238)],
        [620, srgb(132, 160, 198)],
        [950, srgb(84, 70, 104)],
        [1400, srgb(66, 50, 86)]
    ], T);
    const belt = ramp([
        [85, srgb(170, 150, 112)],
        [140, srgb(118, 70, 44)],
        [230, srgb(134, 116, 100)],
        [430, srgb(126, 142, 160)],
        [620, srgb(52, 76, 124)],
        [950, srgb(30, 20, 40)],
        [1400, srgb(18, 12, 28)]
    ], T);
    const accent = ramp([
        [85, srgb(198, 182, 146)],
        [140, srgb(196, 134, 86)],
        [230, srgb(190, 176, 158)],
        [430, srgb(172, 188, 204)],
        [620, srgb(88, 116, 164)],
        [950, srgb(70, 40, 62)],
        [1400, srgb(58, 30, 50)]
    ], T);
    const storm = ramp([
        [85, srgb(232, 222, 196)],
        [140, srgb(182, 78, 44)],
        [230, srgb(246, 244, 238)],
        [430, srgb(250, 250, 250)],
        [620, srgb(196, 210, 228)],
        [950, srgb(128, 50, 56)],
        [1400, srgb(120, 34, 36)]
    ], T);

    // Methane: a haze whitens the top, then the gas above it takes out red, and more of it the colder and deeper
    const ch4Eff = methaneEffect(gas.amount('CH4'));
    const deep = smooth(80, 42, T) * ch4Eff;
    const absorb = [lerp(1, 0.3, ch4Eff) * lerp(1, 0.5, deep), lerp(1, 0.8, ch4Eff) * lerp(1, 0.56, deep), lerp(1, 1, ch4Eff) * lerp(1, 0.96, deep)];
    const white = [0.86, 0.91, 1];
    const tint = (c) => mul3(mix3(c, white, ch4Eff * 0.82), absorb);
    const out = { zone: tint(zone), belt: tint(belt), accent: tint(accent), storm: tint(storm), ch4Eff };
    if (mass < 25) {
        const dim = lerp(0.72, 1, smooth(8, 25, mass));
        out.zone = scale3(out.zone, dim);
        out.belt = scale3(out.belt, dim * 0.9);
        out.accent = scale3(out.accent, dim);
    }
    if (ch4Eff > 0.5 && mass < 80) out.storm = mul3(mix3(out.belt, srgb(36, 62, 130), 0.75), [1, 1, 1]);
    return out;
}

function envelopeFrom(ctx, rng) {
    const { T, mass, radius, day, deck } = ctx;
    const c = envelopeColours(ctx);
    if (deck) {
        return {
            ...c,
            bands: 0.75,
            bandCount: 5 + rng.int(0, 1),
            turbulence: 0.6,
            stretch: 3.2,
            wobble: 0.4,
            detail: 1.1,
            storms: 0,
            cirrus: 0,
            polar: 0.15,
            jetSpeed: 0.3,
            chevron: 0.8
        };
    }
    const massF = smooth(12, 120, mass);
    const coldMute = 1 - 0.62 * smooth(125, 80, T);
    const hazeHide = 1 - 0.72 * c.ch4Eff * (1 - smooth(50, 100, mass));
    const bands = clamp(lerp(0.34, 1, massF) * coldMute * hazeHide);
    const turbulence = clamp((0.22 + 0.78 * smooth(60, 560, T)) * lerp(0.45, 1, massF));
    // Faster spin and a bigger planet make narrower jets (Rhines scale)
    const jets = 5.5 * Math.sqrt(10 / Math.max(3, day)) * Math.sqrt(radius / 6) * lerp(0.55, 1.5, massF);
    return {
        ...c,
        bands,
        bandCount: Math.round(clamp(jets * 1.4, 3, 20)) + rng.int(0, 1),
        turbulence,
        stretch: lerp(9, 17, massF),
        wobble: lerp(0.08, 0.3, turbulence),
        detail: lerp(0.3, 1, bands) * lerp(0.75, 1, turbulence),
        storms: Math.round(clamp(1 + 8 * turbulence * lerp(0.3, 1, massF), 0, 6)),
        cirrus: c.ch4Eff > 0.5 ? 0.6 : 0,
        polar: 0.55 * massF,
        jetSpeed: lerp(0.5, 1, turbulence),
        chevron: 0
    };
}

function solidFrom(ctx) {
    const { T, mass, radius, pressure, surface, gas, airless } = ctx;
    const ice = String(surface.ice || '').toLowerCase();
    const rock = String(surface.rock || '').toLowerCase();
    const waterIce = /water|h2o/.test(ice);
    const softIce = !!ice && !waterIce;
    const iceWorld = (waterIce && !surface.rock) || (ice && !surface.rock) || waterIce;
    const ocean = clamp(finite(surface.ocean_fraction, 0));
    const shellFrozen = waterIce && (ocean <= 0 || T < 235);
    const liquid = shellFrozen ? 0 : ocean * (1 - smooth(420, 520, T));

    // Molten rock: named outright, or hot enough, or rock vapour in the air above bare ground
    const vapour = gas.amount('Na') + gas.amount('K') + gas.amount('SiO');
    const molten = !!surface && (/lava|molten|magma/.test(rock) || T >= 1100 || (vapour > 0 && liquid <= 0));

    const colours = rockColours(surface.rock, shellFrozen || softIce ? ice : null);
    const dry = liquid <= 0.001;
    const gravity = mass / Math.max(0.05, radius * radius);
    const relief = clamp(0.8 / gravity ** 0.3, 0.45, 1.05);

    let craters = airless ? 1 : pressure < 0.02 ? 0.55 : pressure < 0.2 ? 0.3 : 0.1;
    if (shellFrozen) craters = 0.1;
    if (softIce) craters = 0.45;
    if (molten) craters = 0;
    if (liquid > 0) craters = 0.03;

    const rustGround = colours === ROCKS.rust;
    const sandGround = colours === ROCKS.sand;
    const windy = !airless && pressure >= 0.003 && dry && !molten && !shellFrozen && !softIce;

    // Polar caps where water or CO2 can freeze out
    const water = gas.amount('H2O') > 0 || liquid > 0;
    let cap = 0;
    if (water && !shellFrozen) cap = lerp(0.12, 0.45, smooth(300, 235, T));
    else if (!shellFrozen && !softIce && !airless && gas.amount('CO2') > 10 && T < 250) cap = lerp(0.05, 0.28, smooth(250, 190, T));
    if (molten) cap = 0;

    const redEdge = finite(surface.red_edge_nm, 0);
    const vegetation = redEdge > 0 && liquid > 0 ? 1 : 0;
    // Plants that use more of a dim star's light reflect less of it: the longer the edge, the darker the leaf
    const leafDark = smooth(690, 760, redEdge);

    return {
        rockMain: colours[0],
        rockDark: colours[1],
        rockBright: colours[2],
        iceColour: softIce ? srgb(240, 224, 208) : srgb(232, 240, 250),
        lineColour: waterIce ? srgb(150, 128, 122) : srgb(120, 80, 64),
        deepWater: srgb(5, 17, 48),
        shallowWater: srgb(12, 66, 96),
        leaf: mix3(srgb(86, 72, 34), srgb(68, 46, 24), leafDark),
        leafDry: mix3(srgb(112, 90, 50), srgb(92, 66, 38), leafDark),
        oceanFraction: liquid,
        seaLevel: liquid > 0 ? ELEVATION_SIGMA * normalQuantile(liquid) : -9,
        vegetation,
        craters,
        ridges: molten ? 0.15 : shellFrozen ? 0 : softIce ? 0.2 : liquid > 0 ? 0.8 : windy ? 0.42 : 0.3,
        canyons: rustGround && windy ? 0.75 : 0,
        maria: airless && !molten ? 0.8 : softIce ? 0 : 0,
        dunes: windy ? (sandGround ? 1 : rustGround ? 0.3 : 0.35) : 0,
        saltFlats: windy && sandGround ? 0.8 : 0,
        cracks: shellFrozen ? 1 : 0,
        plains: softIce ? 1 : 0,
        lava: molten ? 1 : 0,
        // Height at which to cut the melt noise: the hotter, the more lies molten
        melt: molten ? lerp(0.36, 0.16, smooth(1000, 2600, T)) : 0,
        cap,
        frost: iceWorld ? 0 : smooth(170, 90, T) * (airless ? 0.15 : 0.65),
        relief,
        regolith: shellFrozen ? 0.25 : airless ? 0.62 : lerp(0.4, 0, smooth(0.001, 0.3, pressure)),
        iceSheen: shellFrozen ? 1 : softIce ? 0.4 : 0
    };
}

function cloudsFrom(ctx) {
    const { kindRaw, coverRaw, solid } = ctx;
    const kind = String(kindRaw || '').toUpperCase();
    const cover = clamp(finite(coverRaw, 0));
    const off = { kind: null, cover: 0, level: 9, colour: zero3(), shade: zero3(), opacity: 0, swirl: 0, streak: 0, soft: 0.1, altitude: 0, veil: 0, storms: 0 };
    if (!kind || cover <= 0 || !solid) return off;
    // Opacity builds up from the level, so the visibly cloudy area starts a little above it
    const level = CLOUD_SIGMA * normalQuantile(1 - cover) - 0.04;
    if (kind === 'H2O') {
        return { kind, cover, level, colour: srgb(252, 252, 250), shade: srgb(128, 142, 170), opacity: 1, swirl: 1, streak: 0.55, soft: 0.2, altitude: 0.012, veil: 0.2, storms: Math.round(2 + cover * 3) };
    }
    if (kind === 'DUST') {
        const dust = mix3(solid.rockBright, srgb(230, 190, 150), 0.4);
        return { kind, cover, level, colour: dust, shade: mix3(dust, solid.rockDark, 0.5), opacity: 0.5, swirl: 0.2, streak: 1, soft: 0.32, altitude: 0.006, veil: 0, storms: 0 };
    }
    if (kind === 'H2SO4') {
        return { kind, cover, level, colour: srgb(238, 222, 170), shade: srgb(190, 164, 112), opacity: 0.92, swirl: 0.35, streak: 1, soft: 0.3, altitude: 0.012, veil: 0, storms: 0 };
    }
    if (kind === 'NH3') {
        return { kind, cover, level, colour: srgb(244, 236, 214), shade: srgb(190, 170, 136), opacity: 0.9, swirl: 0.25, streak: 1.4, soft: 0.16, altitude: 0.012, veil: 0, storms: 1 };
    }
    return { kind, cover, level, colour: srgb(232, 232, 232), shade: srgb(160, 160, 170), opacity: 0.8, swirl: 0.4, streak: 0.8, soft: 0.16, altitude: 0.01, veil: 0, storms: 1 };
}

// Black-body glow from the planet's own heat, at three points along the temperature range of what is glowing
function emissionFrom(ctx, solid) {
    const { T } = ctx;
    const molten = solid && solid.lava > 0;
    const off = { on: false, tempK: 0, cool: zero3(), warm: zero3(), hot: zero3(), night: 0 };
    if (molten) {
        const top = Math.max(1500, T * 1.15);
        const at = (K, gain) => {
            const bb = blackBodyRGB(K);
            const m = Math.max(bb[0], bb[1], bb[2]);
            return scale3(bb, gain / m);
        };
        return { on: true, tempK: top, cool: at(850, 0.35), warm: at(top * 0.8, 1.7), hot: at(top * 1.2, 5), night: 1 };
    }
    if (!solid && T >= 650) {
        const glow = smooth(650, 1700, T);
        const bb = blackBodyRGB(T);
        const m = Math.max(bb[0], bb[1], bb[2]);
        const c = scale3(bb, 1 / m);
        return { on: true, tempK: T, cool: scale3(c, 0.004 * glow), warm: scale3(c, 0.026 * glow), hot: scale3(c, 0.11 * glow), night: glow };
    }
    return off;
}

// Saved as a small table so that ring shadows and rings read the same bands. Pattern only: seed decides the gaps.
export function ringProfile(seedText, size = 1024) {
    const rng = new Rng(`${seedText}:rings`);
    const opacity = new Float32Array(size);
    const tone = new Float32Array(size);
    const layers = [];
    for (let i = 0; i < 6; i++) layers.push({ f: 3 * 2 ** i * rng.range(0.8, 1.2), p: rng.range(0, 6.283), a: 0.5 ** (i * 0.7) });
    const gaps = [];
    const n = rng.int(2, 5);
    for (let i = 0; i < n; i++) gaps.push({ u: rng.range(0.2, 0.9), w: rng.logRange(0.006, 0.035), depth: rng.range(0.5, 0.92) });
    for (let i = 0; i < size; i++) {
        const u = i / (size - 1);
        let v = 0;
        let sum = 0;
        layers.forEach((l) => {
            v += l.a * (0.5 + 0.5 * Math.sin(u * l.f * 6.283 + l.p + 1.7 * Math.sin(u * l.f * 2.1 + l.p)));
            sum += l.a;
        });
        v /= sum;
        let a = 0.3 + 0.85 * v;
        // Dense middle, thin at the rims
        a *= smooth(0, 0.1, u) * (1 - smooth(0.88, 1, u)) * lerp(0.55, 1, smooth(0.08, 0.38, u));
        gaps.forEach((g) => { a *= 1 - g.depth * Math.exp(-(((u - g.u) / g.w) ** 2)); });
        opacity[i] = clamp(a);
        tone[i] = clamp(0.25 + 0.75 * (0.65 * v + 0.35 * (0.5 + 0.5 * Math.sin(u * 19 + layers[0].p))));
    }
    return { opacity, tone };
}

function ringsFrom(planet, T) {
    const r = planet.rings;
    if (!r) return null;
    const inner = Math.max(1.05, finite(r.inner_Rp, 1.3));
    const outer = Math.max(inner + 0.05, finite(r.outer_Rp, 2.2));
    const icy = smooth(280, 130, T);
    return {
        inner,
        outer,
        tiltDeg: finite(r.tilt_deg, 0),
        opacity: clamp(finite(r.opacity, 0.7)),
        colour: mix3(srgb(150, 128, 106), srgb(236, 226, 206), icy),
        colourDark: mix3(srgb(86, 72, 62), srgb(168, 148, 124), icy)
    };
}

// Everything the shader needs, as plain numbers and arrays
export function appearanceFrom(planet, hostTeffK) {
    const seedText = String(planet.visual_seed || planet.code || 'planet');
    const rng = new Rng(seedText);

    const T = Math.max(10, finite(planet.T_eq_K, 250));
    const radius = Math.max(0.05, finite(planet.radius_Rearth, 1));
    const mass = Math.max(0.001, finite(planet.mass_Mearth, 1));
    const pressure = Math.max(0, finite(planet.pressure_bar, 0));
    const day = Math.max(1, finite(planet.day_length_h, 24));
    const surface = planet.surface || {};
    const gas = readGases(planet);
    const cloudsIn = planet.clouds || {};
    const kindRaw = cloudsIn.kind;
    const coverRaw = cloudsIn.cover;
    const kind = String(kindRaw || '').toUpperCase();
    const cover = clamp(finite(coverRaw, 0));

    const envelope = gas.amount('H2') + gas.amount('He') >= 40;
    const deck = !envelope && (kind === 'H2SO4' || (cover >= 0.9 && pressure >= 3) || (pressure >= 15 && gas.amount('CO2') >= 50));
    const airless = !envelope && !deck && gas.total <= 0 && pressure <= 1e-6;
    const sun = hostLight(hostTeffK);
    const ctx = { gas, T, mass, radius, pressure, day, envelope, deck, airless, sun, surface, kindRaw, coverRaw };

    const solid = envelope || deck ? null : solidFrom(ctx);
    ctx.solid = solid;
    ctx.rockMain = solid ? solid.rockMain : null;
    const clouds = cloudsFrom(ctx);
    ctx.clouds = { kind: clouds.kind || kind, cover };
    const atmosphere = atmosphereFrom(ctx);
    const gasBody = solid ? null : envelopeFrom(ctx, rng);

    // Pattern seeds: offsets into the noise and where storms sit. These never touch a colour.
    const seedOffset = [rng.range(-40, 40), rng.range(-40, 40), rng.range(-40, 40)];
    const stormCount = gasBody ? gasBody.storms : clouds.storms;
    const storms = [];
    for (let i = 0; i < stormCount; i++) {
        const lat = gasBody
            ? rng.range(-0.72, 0.72)
            : (rng.chance(0.5) ? 1 : -1) * rng.range(0.14, 0.82);
        storms.push({
            lat,
            lon: rng.range(0, Math.PI * 2),
            radius: gasBody ? lerp(0.05, 0.1 + 0.16 * (1 - i / Math.max(1, stormCount)), rng.next()) : rng.range(0.05, 0.115),
            spin: (lat >= 0 ? 1 : -1) * (gasBody ? rng.range(2.6, 5) : rng.range(1.0, 1.9)),
            strength: gasBody ? (i === 0 ? 1 : rng.range(0.35, 0.8)) : 1
        });
    }
    const tiltDeg = planet.rings && Number.isFinite(planet.rings.tilt_deg) ? planet.rings.tilt_deg : rng.range(-26, 26);

    // A faster day turns the globe faster, but gently: a slow, calm spin, whatever the planet
    const spinRate = clamp(0.055 * Math.sqrt(24 / day), 0.012, 0.11);

    return {
        seedText,
        seedOffset,
        seedPhase: rng.range(0, Math.PI * 2),
        phase0: rng.range(0, Math.PI * 2),
        model: solid ? 'solid' : 'envelope',
        sun,
        atmosphere,
        envelope: gasBody,
        solid,
        clouds,
        emission: emissionFrom(ctx, solid),
        rings: ringsFrom(planet, T),
        storms,
        tiltDeg,
        spinRate,
        cloudDrift: clouds.cover > 0 ? 0.08 * spinRate : 0
    };
}
