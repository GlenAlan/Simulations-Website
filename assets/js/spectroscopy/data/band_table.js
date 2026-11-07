// How each object shows in each band (spec section 5). Pure functions of a body's fields, with no DOM or WebGL.
//
// bandStrengths(body)             { radio, ir, visible, uv, xray }, each 0..1, relative to the object itself. Stored as
//                                 body.bands; it says which bands an object shows in and how its looks differ between them.
// bandMagnitudes(body)            The same five as apparent magnitudes on the scale of body.brightness.mag: how bright it
//                                 is compared with everything else in that band's sky. 99 means it doesn't show.
// bandSkyBrightness(body, band)   That magnitude as a sprite's glow at default zoom, in the units of stars.js's m.
//
// A strength alone can't draw a sky: every M dwarf has a strength of 1 in infrared, and a distant one must still be far
// fainter than a nearby giant. Stars follow real physics (luminosity, distance and the Planck fraction in the band).
// Exotic objects have no sensible shared flux scale, so theirs is stylised: a few magnitudes of range with distance, set
// so that the radio sky is a few striking beacons, the X-ray sky sparse with black holes the brightest, and so on.

import { H, C_MS, K_B } from '../core/phys.js';
import { bolometricCorrection } from './stellar.js';

export const NOT_SEEN = 99;                // A band magnitude meaning "does not show in this band"
const DEFAULT_LIMIT_MAG = 6;               // limitingMag() at the default field of view (core/sky.js)
const BAND_KEYS = ['radio', 'ir', 'visible', 'uv', 'xray'];

// Band edges (nm). Everything longer than the visible counts as infrared: a star's Rayleigh-Jeans tail in radio is nothing.
const UV_RED_EDGE_NM = 380;
const VISIBLE_RED_EDGE_NM = 750;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (lo, hi, x) => {
    const t = clamp01((x - lo) / (hi - lo));
    return t * t * (3 - 2 * t);
};
const magOf = (ratio) => (ratio > 0 ? -2.5 * Math.log10(ratio) : NOT_SEEN);
const tidy = (out) => ({
    radio: Number(clamp01(out.radio).toFixed(3)),
    ir: Number(clamp01(out.ir).toFixed(3)),
    visible: Number(clamp01(out.visible).toFixed(3)),
    uv: Number(clamp01(out.uv).toFixed(3)),
    xray: Number(clamp01(out.xray).toFixed(3))
});

// ---------- Black bodies ----------

// Fraction of a black body's power at wavelengths below lambdaNm: the series form of the Planck integral
function fractionBelow(lambdaNm, T) {
    const x = (H * C_MS) / (lambdaNm * 1e-9 * K_B * T);
    if (x > 120) return 0;
    let sum = 0;
    for (let n = 1; n <= 400; n++) {
        const term = (Math.exp(-n * x) / n) * (x * x * x + (3 * x * x) / n + (6 * x) / (n * n) + 6 / (n * n * n));
        sum += term;
        if (term < sum * 1e-7) break;
    }
    return clamp01((15 / Math.PI ** 4) * sum);
}

const fractionCache = new Map();

// Share of a black body's power in each band; these sum to 1
export function planckBandFractions(T) {
    const key = Math.round(T / 10);
    let f = fractionCache.get(key);
    if (!f) {
        const uv = fractionBelow(UV_RED_EDGE_NM, T);
        const belowRed = fractionBelow(VISIBLE_RED_EDGE_NM, T);
        f = { uv, visible: Math.max(0, belowRed - uv), ir: Math.max(0, 1 - belowRed) };
        fractionCache.set(key, f);
    }
    return f;
}

// Strengths from the Planck fractions, each relative to the object's strongest band. A linear ratio would leave a hot star
// with a visible strength of 0.03, so these are compressed: a strength is how an object's looks compare between bands, and
// a sprite's real brightness comes from its magnitude. Visible never falls below 0.5, because body.brightness.mag already
// holds the dimming and a sprite that multiplies by this as well shouldn't lose a blue-white O star.
function strengthsFromFractions(f) {
    const peak = Math.max(f.uv, f.visible, f.ir) || 1;
    return {
        uv: (f.uv / peak) ** 0.7,
        visible: 0.5 + 0.5 * Math.sqrt(f.visible / peak),
        ir: Math.sqrt(f.ir / peak)
    };
}

// ---------- Stars ----------

function isDwarfStar(star) {
    return star.stage ? star.stage === 'main_sequence' : star.luminosity_class === 'V';
}

function isWhiteDwarf(star) {
    return star.stage === 'white_dwarf' || star.class === 'D' || star.class === 'WD';
}

// Young or fast-spinning M dwarfs keep strong magnetic fields, and those flare (spec 7.2 ties youth to fast spin)
function isActiveMDwarf(star) {
    if (star.class !== 'M' || !isDwarfStar(star)) return false;
    if (typeof star.active === 'boolean') return star.active;
    return (star.age_Myr ?? 5000) < 800 || (star.vsini_kms ?? 0) > 12;
}

// Coronal and wind X-rays and wind radio, which aren't black-body light. The rest of the star's strengths are.
function stellarExtras(star) {
    const T = star.teff_K;
    if (isWhiteDwarf(star)) return { radio: 0, xray: 0.6 * smooth(35000, 100000, T) };
    if (T >= 10000) return { radio: 0.03, xray: 0.02 + 0.18 * smooth(10000, 40000, T) }; // Winds
    if (!isDwarfStar(star)) return { radio: 0, xray: 0.01 };                             // Cool giants have no hot corona
    if (isActiveMDwarf(star)) return { radio: 0.2, xray: 0.3 };
    if (T < 7000 && (star.age_Myr ?? 5000) < 500) return { radio: 0, xray: 0.15 };       // Young corona
    return { radio: 0, xray: T < 7000 ? 0.02 : 0 };                                      // A stars have no corona
}

function starStrengths(star) {
    const s = { ...strengthsFromFractions(planckBandFractions(star.teff_K)), ...stellarExtras(star) };
    if (isWhiteDwarf(star)) {
        s.ir = Math.min(s.ir, 0.12);             // Faint: there is so little surface to glow
        s.visible = Math.min(s.visible, 0.6);    // Faint white
    }
    if (isActiveMDwarf(star)) s.uv = Math.max(s.uv, 0.3); // Flares
    if (star.peculiar === 'carbon') {
        s.ir = 1;                                // Sooty dust shells
        s.visible *= 0.85;
    }
    return s;
}

// Several stars at one point. Black-body light adds up by luminosity; activity is whichever star has the most.
function combinedStarStrengths(stars) {
    const f = { uv: 0, visible: 0, ir: 0 };
    let total = 0;
    let radio = 0;
    let xray = 0;
    stars.forEach((star) => {
        const L = star.luminosity_Lsun || 1;
        const each = planckBandFractions(star.teff_K);
        f.uv += L * each.uv;
        f.visible += L * each.visible;
        f.ir += L * each.ir;
        total += L;
        const own = starStrengths(star);
        radio = Math.max(radio, own.radio);
        xray = Math.max(xray, own.xray);
    });
    if (total === 0) return { uv: 0, visible: 1, ir: 0, radio: 0, xray: 0 };
    return { ...strengthsFromFractions({ uv: f.uv / total, visible: f.visible / total, ir: f.ir / total }), radio, xray };
}

function multiStarStrengths(body) {
    const s = combinedStarStrengths((body.stars || []).map((c) => c.star));
    if (body.interacting) {
        s.xray = Math.max(s.xray, 0.9);          // Mass transfer: gas falling onto a star heats to millions of degrees
        s.uv = Math.max(s.uv, 0.5);              // Hot spots where the stream lands
    } else {
        s.xray = Math.min(s.xray, 0.3);          // Only an interacting pair is bright here
    }
    return s;
}

// ---------- Everything else ----------

function clusterStrengths(body) {
    const c = body.cluster;
    const members = (c.members || []).map((m) => m.star).filter(Boolean);
    const s = members.length ? combinedStarStrengths(members) : { uv: 0.3, visible: 1, ir: 0.5 };
    s.radio = 0;
    s.visible = Math.max(s.visible, 0.85);
    if (c.type === 'globular') {
        s.uv = Math.min(0.2, Math.max(s.uv, 0.08)); // Old: faint, apart from a few hot stars
        s.ir = Math.max(s.ir, 0.8);                 // Red giants stand out
        s.xray = 0.22;                              // A few X-ray binaries
    } else {
        const age = c.age_Myr ?? 200;
        s.uv = Math.max(s.uv, age < 100 ? 0.95 : age < 300 ? 0.75 : 0.45); // Hot young stars
        s.ir = Math.max(s.ir, 0.45);
        s.xray = 0.05;                              // Young coronae
    }
    return s;
}

const NEBULA_ROWS = {
    emission:   { radio: 0.55, ir: 0.95, visible: 1, uv: 0.45, xray: 0.05 }, // Free-free and 21 cm; dust; ionising stars
    planetary:  { radio: 0.2, ir: 0.5, visible: 1, uv: 0.85, xray: 0.15 },   // Lit by a very hot white dwarf
    reflection: { radio: 0.04, ir: 0.6, visible: 0.8, uv: 0.35, xray: 0 },   // Scattered starlight, with no gas glow
    dark:       { radio: 0.2, ir: 0.85, visible: 0.25, uv: 0, xray: 0 },     // Blocks light, but cold dust glows in infrared
    remnant:    { radio: 1, ir: 0.55, visible: 0.7, uv: 0.6, xray: 0.95 }    // Synchrotron shell and hot gas
};

function nebulaStrengths(body) {
    const type = body.nebula.type;
    const isRemnant = type === 'remnant' || type === 'snr' || type === 'supernova_remnant';
    return NEBULA_ROWS[isRemnant ? 'remnant' : type] || NEBULA_ROWS.emission;
}

function neutronStarStrengths(body) {
    const ns = body.neutron_star;
    const hot = smooth(3e5, 2e6, ns.teff_K ?? 8e5);
    return {
        radio: ns.pulsar ? 1 : 0,                // Pulsing beacons: the main way to find one
        ir: 0,
        visible: 0.02,                           // Very faint or invisible
        uv: 0.1 + 0.15 * hot,                    // Faint thermal glow
        xray: ns.gamma ? 1 : 0.5 + 0.2 * hot     // Thermal, and some gamma pulsars
    };
}

function blackHoleStrengths(body) {
    const bh = body.black_hole;
    const companion = starStrengths(bh.companion.star); // Infrared and visible see only the companion
    return {
        radio: bh.jets ? 0.7 : 0,
        ir: companion.ir,
        visible: companion.visible,
        uv: Math.max(0.55, companion.uv),        // Inner accretion disc
        xray: 1                                  // The accretion disc: the main way to find one
    };
}

function galaxyStrengths(body) {
    const g = body.galaxy;
    const spiral = g.morphology === 'spiral';
    const irregular = g.morphology === 'irregular';
    // A dusty disc seen edge-on has more dust along the line of sight
    const edgeOn = smooth(50, 85, g.inclination_deg ?? 45);
    let ir = spiral ? 0.5 + 0.2 * edgeOn : irregular ? 0.65 : 0.25;
    if (g.starburst) ir = 0.95;
    return {
        radio: g.radio_lobes ? 0.85 : 0.03,
        ir,
        visible: 1,
        uv: spiral ? 0.65 : irregular ? 0.7 : 0.06, // Star-forming arms; ellipticals have only old stars
        xray: g.active_nucleus ? 0.7 : 0.02
    };
}

function quasarStrengths(body) {
    const q = body.quasar;
    return {
        radio: q.radio_loud || q.blazar ? 1 : 0.012,
        ir: 0.6,                                 // Warm dust torus
        visible: 0.35,                           // A faint star-like point
        uv: 1,                                   // Hot accretion disc
        xray: q.blazar ? 1 : 0.85
    };
}

// A galaxy's central black hole (data/nuclei.js). Feeding, its hot disc is brightest in ultraviolet and X-rays, warm dust
// round it glows in infrared, and a radio-loud one's jets shine in radio. Seen through that dust (type 2), the disc's
// visible and ultraviolet light is hidden, the infrared is all the stronger and the hardest X-rays still get out. A quiet one
// shows next to nothing.
function nucleusStrengths(body) {
    const n = body.nucleus;
    const radio = n.radio_loud ? 0.9 : 0.06;
    if (!n.active) return { radio: 0.02, ir: 0, visible: 0, uv: 0, xray: 0.01 };
    if (n.type === 1) return { radio, ir: 0.6, visible: 0.45, uv: 1, xray: 0.9 };
    return { radio, ir: 1, visible: 0.08, uv: 0.05, xray: 0.7 };
}

function rogueStrengths(body) {
    const T = body.rogue_planet.teff_K ?? 100;
    return { radio: 0, ir: 0.25 + 0.5 * smooth(40, 400, T), visible: 0, uv: 0, xray: 0 };
}

function cometStrengths(body) {
    const dust = body.comet.dust_ratio ?? 0.5;
    return {
        radio: 0.12,                             // OH line at 18 cm
        ir: 0.7 + 0.3 * dust,                    // Dust glow
        visible: 1,
        uv: 0.85,                                // Huge hydrogen halo in Lyman-alpha
        xray: 0.06                               // Solar wind meeting the coma
    };
}

// What a supernova looks like t days after peak brightness. Exported for the supernova layer's playback.
export function supernovaBandsAt(sn, t) {
    const coreCollapse = sn.type !== 'Ia';
    const since = Math.max(0, t + 15);           // Days since the outburst, which comes about 15 days before peak
    const remnant = smooth(150, 400, t);         // The filamentary remnant takes over
    const lightCurve = t < 0
        ? 0.35 + 0.65 * Math.exp(t / 5)
        : coreCollapse ? 1 / (1 + (t / 110) ** 3) : Math.exp(-t / 45); // II holds a plateau; Ia fades at once
    return {
        radio: (coreCollapse ? 1 : 0.7) * (1 - Math.exp(-since / 150)),                 // Rising afterglow
        ir: Math.max(0.15, 0.95 * Math.exp(-since / 150) + 0.35 * remnant),             // Bright, then fading
        visible: Math.max(0.22 + 0.2 * remnant, lightCurve),                            // A bright new star, then filaments
        uv: Math.min(1, 1.05 * Math.exp(-since / (coreCollapse ? 14 : 9)) + 0.4 * remnant), // Early flash, fading fast
        xray: Math.min(1, Math.exp(-since / 5) + 0.75 * remnant)                        // Flash at outburst, then hot-gas shell
    };
}

const HOME_PLANETS = {
    Mercury: { radio: 0, ir: 0.55, uv: 0.05, xray: 0 },
    Venus:   { radio: 0, ir: 0.7, uv: 0.08, xray: 0 },
    Mars:    { radio: 0, ir: 0.45, uv: 0.05, xray: 0 },
    Jupiter: { radio: 0.9, ir: 0.75, uv: 0.2, xray: 0.08 },   // Radiation belts; auroras in UV and X-ray
    Saturn:  { radio: 0.08, ir: 0.6, uv: 0.15, xray: 0 },     // UV auroras
    Uranus:  { radio: 0, ir: 0.3, uv: 0.04, xray: 0 },
    Neptune: { radio: 0, ir: 0.25, uv: 0.04, xray: 0 }
};

// An exoplanet: thermal glow from its temperature, reflected light from its albedo, and a radio signal from a giant's field
function planetStrengths(planet) {
    const T = planet.T_eq_K ?? 200;
    const albedo = planet.albedo ?? 0.3;
    const big = (planet.radius_Rearth ?? 1) > 6;
    const thermal = clamp01(Math.log(Math.max(T, 40) / 60) / Math.log(1500 / 60));
    return {
        radio: big ? 0.1 : 0,
        ir: 0.12 + 0.86 * thermal,
        visible: clamp01(0.2 + 1.1 * albedo),
        uv: clamp01(0.02 + 0.1 * albedo + 0.1 * smooth(500, 2000, T) + (big ? 0.04 : 0)),
        xray: 0
    };
}

function homePlanetStrengths(body) {
    const row = HOME_PLANETS[body.name];
    if (row) return { ...row, visible: 1 };      // Reflected sunlight
    return body.planet ? planetStrengths(body.planet) : { radio: 0, ir: 0.5, visible: 1, uv: 0.05, xray: 0 };
}

// ---------- The table ----------

export function bandStrengths(body) {
    switch (body.kind) {
        case 'binary':
        case 'multiple': return tidy(multiStarStrengths(body));
        case 'cluster': return tidy(clusterStrengths(body));
        case 'nebula': return tidy(nebulaStrengths(body));
        case 'neutron_star': return tidy(neutronStarStrengths(body));
        case 'black_hole': return tidy(blackHoleStrengths(body));
        case 'galaxy': return tidy(galaxyStrengths(body));
        case 'quasar': return tidy(quasarStrengths(body));
        case 'nucleus': return tidy(nucleusStrengths(body));
        case 'rogue_planet': return tidy(rogueStrengths(body));
        case 'comet': return tidy(cometStrengths(body));
        case 'supernova': return tidy(supernovaBandsAt(body.supernova, body.supernova.phase0_days ?? 0));
        case 'home_planet': return tidy(homePlanetStrengths(body));
        case 'planet': return tidy(planetStrengths(body));
        default:
            // Stars, components of a multiple system and cluster members all carry a star block
            if (body.star) return tidy(starStrengths(body.star));
            return { radio: 0, ir: 0.3, visible: 1, uv: 0.1, xray: 0 };
    }
}

// ---------- Brightness in each band's sky ----------

// A stylised apparent magnitude: `spread` is the share of the true distance dimming that it keeps
function stylisedMag(body, refPc, spread) {
    const d = body.distance_pc;
    return d > 0 ? spread * 5 * Math.log10(d / refPc) : 0;
}

function bolometricMag(star, distancePc, fallbackMag) {
    if (!(distancePc > 0) || !(star.luminosity_Lsun > 0)) return fallbackMag ?? 20;
    return 4.74 - 2.5 * Math.log10(star.luminosity_Lsun) + 5 * Math.log10(distancePc / 10);
}

// Ultraviolet is for the far UV, where a cool star's Planck curve has already fallen away, so the near UV that counts in its share
// of the light is worth little: a Sun-like star loses three magnitudes more and a red dwarf four. A star hot enough that UV is its
// strongest band (from about 9,600 K: see strengthsFromFractions) is brightest there on the sky too, its UV leading its visible
// light by a little, and by up to 2.5 magnitudes at 30,000 K. A white dwarf's tiny surface is far hotter than its faint visible
// light suggests, so it gains a little.
const UV_STRONGEST_FROM_K = 9600;
const WD_UV_GAIN = -2.5;

function coolUvOffset(T) {
    return 2 + 2 * (1 - smooth(4500, 7500, T));
}

function hotStarUv(mBol, T, share) {
    const cool = mBol + magOf(share) + coolUvOffset(T);
    const hot = mBol - bolometricCorrection(T) - (0.3 + 2.2 * smooth(UV_STRONGEST_FROM_K, 30000, T));
    return cool + (hot - cool) * smooth(8000, UV_STRONGEST_FROM_K, T);
}

// A real star's band magnitudes: its bolometric magnitude plus the share of its light in that band. The offsets decide
// how rich each star field is. Infrared gains a magnitude, so it holds the most stars of any band; ultraviolet is left
// to the hot stars and white dwarfs. Radio and X-rays from an ordinary star are faint however close it is, so they stop at a
// ceiling: stars never compete with the beacons and black holes of those skies.
function starMags(star, distancePc, fallbackMag) {
    const mBol = bolometricMag(star, distancePc, fallbackMag);
    const T = star.teff_K;
    const f = planckBandFractions(T);
    const extras = stellarExtras(star);
    const wd = isWhiteDwarf(star);
    const flares = isActiveMDwarf(star);
    return {
        ir: mBol + magOf(f.ir) - 1,
        uv: flares ? mBol + magOf(0.03) + coolUvOffset(T) : wd ? mBol + magOf(f.uv) + WD_UV_GAIN : hotStarUv(mBol, T, f.uv),
        radio: Math.max(flares ? 5.5 : 6.5, mBol + magOf(extras.radio) + (flares ? -3 : 3)),
        xray: Math.max(wd ? 4.5 : 5.5, mBol + magOf(extras.xray) + (wd ? -5 : 2))
    };
}

// A black hole's X-rays are the gas falling onto it, so they follow how much of its companion it can pull in: most when the star
// nearly fills the space it has and the orbit is close, some from a hot star's wind, and more onto a heavier hole. A magnitude,
// over about four from the most starved to the best fed.
const BH_XRAY_FED = 0.6;           // The best fed: the sky's brightest
const BH_XRAY_RANGE = 4;

function blackHoleXray(bh) {
    const companion = bh.companion.star;
    const fill = (companion.radius_Rsun * 0.00465) / bh.a_AU;
    const wind = 0.5 * smooth(9000, 20000, companion.teff_K);
    const feed = Math.log10(fill) + wind + 0.5 * Math.log10(bh.mass_Msun / 10);
    return BH_XRAY_FED + BH_XRAY_RANGE * (1 - clamp01((feed + 2.1) / 1.5));
}

function addMags(a, b) {
    if (a >= NOT_SEEN) return b;
    if (b >= NOT_SEEN) return a;
    return -2.5 * Math.log10(10 ** (-0.4 * a) + 10 ** (-0.4 * b));
}

// base holds the magnitude in each band of a strength-1 object of this kind, added to ref. Lower is brighter.
function exoticMags(ref, s, base) {
    return {
        radio: ref + base.radio + magOf(s.radio),
        ir: ref + base.ir + magOf(s.ir),
        uv: ref + base.uv + magOf(s.uv),
        xray: ref + base.xray + magOf(s.xray)
    };
}

function skyMags(body, s) {
    const mag = body.brightness?.mag ?? 20;
    switch (body.kind) {
        case 'binary':
        case 'multiple': {
            const m = (body.stars || []).map((c) => starMags(c.star, body.distance_pc, mag))
                .reduce((a, b) => ({ radio: addMags(a.radio, b.radio), ir: addMags(a.ir, b.ir), uv: addMags(a.uv, b.uv), xray: addMags(a.xray, b.xray) }));
            if (body.interacting) {
                const ref = stylisedMag(body, 300, 0.15);
                // The closer the pair, the more gas passes between them
                const shortest = Math.min(...(body.orbits || []).map((o) => o.period_days).filter((p) => p > 0), 3);
                m.xray = Math.min(m.xray, 4.2 + ref + 0.9 * Math.log10(Math.max(0.1, shortest)));
                m.uv = Math.min(m.uv, 7 + ref);
            }
            return m;
        }
        case 'neutron_star':
            return exoticMags(stylisedMag(body, 300, 0.35), s, { radio: 1.4, ir: 0, uv: 5.5, xray: 3.2 });
        case 'black_hole': {
            const companion = starMags(body.black_hole.companion.star, body.distance_pc, mag);
            const m = exoticMags(stylisedMag(body, 1000, 0.3), s, { radio: 3, ir: 0, uv: 5.6, xray: 1.1 });
            m.ir = companion.ir;
            m.xray = stylisedMag(body, 1000, 0.1) + blackHoleXray(body.black_hole);
            return m;
        }
        case 'quasar':
            return exoticMags(0, s, { radio: 1.2, ir: 4.2, uv: 5, xray: 2 });
        case 'supernova':
            return exoticMags(stylisedMag(body, 3000, 0.2), s, { radio: 3.2, ir: 2.6, uv: 2, xray: 1.6 });
        case 'rogue_planet': {
            // A very wide range of true brightness (thermal power goes as R^2 T^4), squeezed to about 7 magnitudes
            const r = body.rogue_planet.radius_Rearth ?? 4;
            const T = body.rogue_planet.teff_K ?? 100;
            const d = body.distance_pc || 15;
            const power = 2 * Math.log10(r / 5) + 4 * Math.log10(T / 150) - 2 * Math.log10(d / 15);
            return { radio: NOT_SEEN, ir: s.ir > 0 ? 8 - 0.85 * power : NOT_SEEN, uv: NOT_SEEN, xray: NOT_SEEN };
        }
        case 'home_planet':
            return exoticMags(mag, s, { radio: 3, ir: 0, uv: 4, xray: 6 });
        case 'comet':
            return exoticMags(mag, s, { radio: 2, ir: -1, uv: 2, xray: 4 });
        case 'nebula':
            // Large objects keep the magnitude they have in visible light, with their strength in the band
            return exoticMags(mag, s, { radio: -1, ir: -1, uv: 1.5, xray: 0 });
        case 'cluster':
            // A cluster's UV and X-rays are spread over its whole width, where a star's are all in one point
            return exoticMags(mag, s, { radio: -1, ir: -1, uv: 3.5, xray: 2 });
        case 'galaxy': {
            // Lobes and active nuclei aren't starlight, so their brightness doesn't follow the galaxy's visible magnitude
            const m = exoticMags(mag, s, { radio: 0, ir: -1, uv: 0, xray: 0 });
            m.radio = 2.4 + magOf(s.radio);
            m.xray = 3 + magOf(s.xray);
            return m;
        }
        case 'nucleus': {
            // Its radio and X-rays are its galaxy's, which a galaxy only has from its nucleus. Infrared and ultraviolet go
            // with its own visible point, by their strengths against it.
            const m = exoticMags(mag - magOf(Math.max(s.visible, 1e-3)), s, { radio: 0, ir: 0, uv: 0, xray: 0 });
            m.radio = 2.4 + magOf(s.radio);
            m.xray = 3 + magOf(s.xray);
            return m;
        }
        default:
            if (body.star) return starMags(body.star, body.distance_pc, mag);
            return exoticMags(mag, s, { radio: 0, ir: 0, uv: 0, xray: 0 });
    }
}

// Apparent magnitudes in all five bands, as drawn. Visible is just body.brightness.mag, except that a supernova's visible
// strength says how far its light curve has fallen from peak. NOT_SEEN wherever the object's strength is zero. Everything
// here is for drawing, so it includes the faintness of being further away (core/depth.js), which body.brightness doesn't.
export function bandMagnitudes(body) {
    const s = bandStrengths(body);
    const out = skyMags(body, s);
    let visible = body.brightness?.mag ?? NOT_SEEN;
    if (body.kind === 'supernova') visible += magOf(s.visible);
    out.visible = s.visible > 0 ? visible : NOT_SEEN;
    const dim = body.depth_dim_mag || 0;
    BAND_KEYS.forEach((band) => {
        if (!(s[band] > 0) || !(out[band] < NOT_SEEN)) out[band] = NOT_SEEN;
        else out[band] += dim;
    });
    return out;
}

export function bandMagnitude(body, band) {
    return bandMagnitudes(body)[band];
}

// A sprite's glow in this band at default zoom, in the units of m in stars.js (1 = at the limiting magnitude).
// At another zoom, multiply by 10^(0.4 * (limitMag - 6)), so faint sources appear as you zoom in, in every band.
export function bandSkyBrightness(body, band) {
    const mag = bandMagnitude(body, band);
    return mag >= NOT_SEEN ? 0 : 10 ** (-0.4 * (mag - DEFAULT_LIMIT_MAG));
}
