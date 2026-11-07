// Stars as numbers: turns a spectral class, or a mass and an age, into one self-consistent block of physical values.
// Luminosity always follows from radius and temperature (L = R^2 T^4 in solar units), so a student who measures two
// of them gets the third. Stored values are rounded because pow and log can differ in the last digit between browsers.
//
// A star block:
//   class        'O'..'M' by temperature, or 'D' for a white dwarf
//   subclass     0-9
//   luminosity_class  'V', 'IV', 'III', 'I', or 'D' for a white dwarf
//   spectral_type     plain text such as 'G2 V'
//   stage        'main_sequence'|'giant'|'supergiant'|'white_dwarf'
//   population   'I'|'II'|'peculiar'
//   peculiar     null|'carbon'|'ap'|'am'|'barium'
//   wd_type      null|'DA'|'DB'|'DZ'|'DQ'
//   active       flaring star (M dwarfs, and the young G and K stars)
//   metallicity_dex   overall metals against the Sun's, in dex
//   composition  { X, Y, Z, metals_dex: { Fe, Ca, Na, Mg, Si, Ti, C, N, O } }; cluster members share one object

import { stable } from '../core/rng.js';
import { SIGMA, planck, logG } from '../core/phys.js';

export const T_SUN_K = 5772;
export const RSUN_AU = 0.00465047;
const MBOL_SUN = 4.74;
const BC_SUN = -0.07;

const POW10 = [1, 10, 100, 1000, 10000, 100000, 1000000];

// Rounds to a fixed number of decimal places. Far quicker than stable(), so it suits the many cluster members.
export function dp(x, places = 3) {
    const k = POW10[places];
    return Math.round(x * k) / k;
}

export function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
}

// Exact quotas for the star types (spec 7.2). withPlanets rounds each class's chance so that the total is 338.
export const STAR_TABLE = {
    O: { count: 11, T: [30000, 50000], M: [16, 60], R: [7, 15], L: [30000, 800000], vsini: [100, 300], withPlanets: 1 },
    B: { count: 23, T: [10000, 30000], M: [2.5, 16], R: [2, 7], L: [25, 30000], vsini: [100, 250], withPlanets: 3 },
    A: { count: 40, T: [7500, 10000], M: [1.6, 2.5], R: [1.5, 2.5], L: [5, 50], vsini: [80, 200], withPlanets: 14 },
    F: { count: 52, T: [6000, 7500], M: [1.1, 1.6], R: [1.1, 1.5], L: [1.5, 5], vsini: [20, 100], withPlanets: 29 },
    G: { count: 74, T: [5200, 6000], M: [0.8, 1.1], R: [0.85, 1.15], L: [0.6, 1.5], vsini: [1, 20], withPlanets: 48 },
    K: { count: 92, T: [3700, 5200], M: [0.45, 0.8], R: [0.6, 0.9], L: [0.08, 0.6], vsini: [1, 10], withPlanets: 64 },
    M: { count: 218, T: [2400, 3700], M: [0.08, 0.45], R: [0.1, 0.6], L: [0.0001, 0.08], vsini: [1, 10], withPlanets: 163 },
    WD: { count: 34, T: [5000, 100000], M: [0.5, 1.2], R: [0.01, 0.01], L: [0.0001, 0.1], vsini: [1, 50], withPlanets: 7 },
    GIANT: { count: 29, T: [3500, 30000], M: [1, 40], R: [10, 1000], L: [50, 1000000], vsini: [1, 20], withPlanets: 9 }
};

// The main sequence as one curve, joined from the edges of the spec's class table: mass, temperature, radius.
// Log-log interpolation keeps a cluster's sequence on the same line as the field stars.
const MS_TRACK = [
    [0.08, 2400, 0.115],
    [0.45, 3700, 0.6],
    [0.8, 5200, 0.88],
    [1.1, 6000, 1.12],
    [1.6, 7500, 1.4],
    [2.5, 10000, 2.25],
    [16, 30000, 6.6],
    [60, 50000, 11.9]
];

export function mainSequenceAt(mass) {
    const last = MS_TRACK.length - 2;
    let i = 0;
    while (i < last && mass > MS_TRACK[i + 1][0]) i++;
    const lo = MS_TRACK[i];
    const hi = MS_TRACK[i + 1];
    const f = Math.log(mass / lo[0]) / Math.log(hi[0] / lo[0]);
    return { T: stable(lo[1] * (hi[1] / lo[1]) ** f, 7), R: stable(lo[2] * (hi[2] / lo[2]) ** f, 7) };
}

export function luminosityFromRT(radius, T) {
    const x = T / T_SUN_K;
    const x2 = x * x;
    return radius * radius * x2 * x2;
}

function radiusFromLT(luminosity, T) {
    const x = T / T_SUN_K;
    return Math.sqrt(luminosity) / (x * x);
}

// Main-sequence lifetime t = 10 Gyr x M^-2.5, the rule a cluster's turn-off is read with
export function msLifetimeMyr(mass) {
    return stable(10000 * mass ** -2.5, 5);
}

export function turnoffMass(ageMyr) {
    return stable((ageMyr / 10000) ** -0.4, 5);
}

export function classFromT(T) {
    if (T >= 30000) return 'O';
    if (T >= 10000) return 'B';
    if (T >= 7500) return 'A';
    if (T >= 6000) return 'F';
    if (T >= 5200) return 'G';
    if (T >= 3700) return 'K';
    return 'M';
}

function subclassOf(cls, T) {
    const [lo, hi] = STAR_TABLE[cls].T;
    const frac = clamp(stable(Math.log(hi / T) / Math.log(hi / lo)), 0, 1);
    // Real O stars start around O3
    return cls === 'O' ? 3 + Math.round(6 * frac) : Math.round(9 * frac);
}

const METALS = ['Fe', 'Ca', 'Na', 'Mg', 'Si', 'Ti', 'C', 'N', 'O'];

export function makeComposition(rng, population, peculiar = null) {
    let X;
    let Z;
    if (population === 'II') {
        X = rng.range(0.75, 0.755);
        Z = stable(rng.logRange(0.0001, 0.001), 3);
    } else if (population === 'peculiar') {
        X = rng.range(0.68, 0.73);
        Z = stable(rng.logRange(0.006, 0.04), 3);
    } else {
        X = rng.range(0.7, 0.73);
        const Y = rng.range(Math.max(0.25, 0.97 - X), Math.min(0.28, 0.99 - X));
        Z = 1 - X - Y;
    }
    X = dp(X, 4);
    Z = dp(Z, 6);
    const base = dp(Math.log10(Z / 0.02), 2);
    const metals_dex = {};
    METALS.forEach((el) => { metals_dex[el] = dp(base + rng.range(-0.3, 0.3), 2); });
    if (peculiar === 'carbon') {
        // Carbon outweighs oxygen, so the molecules form C2 and CN rather than TiO
        metals_dex.C = dp(base + rng.range(0.6, 1), 2);
        metals_dex.N = dp(base + rng.range(0.2, 0.5), 2);
        metals_dex.O = dp(base + rng.range(-0.15, 0), 2);
    } else if (peculiar === 'ap') {
        metals_dex.Si = dp(base + rng.range(0.6, 1.2), 2);
        metals_dex.Ti = dp(base + rng.range(0.4, 0.8), 2);
        metals_dex.Ca = dp(base + rng.range(-0.6, -0.3), 2);
    } else if (peculiar === 'am') {
        metals_dex.Fe = dp(base + rng.range(0.4, 0.7), 2);
        metals_dex.Ca = dp(base + rng.range(-0.7, -0.4), 2);
    } else if (peculiar === 'barium') {
        metals_dex.C = dp(base + rng.range(0.25, 0.5), 2);
    }
    return { X, Y: dp(1 - X - Z, 6), Z, metallicity_dex: base, metals_dex };
}

function makeBlock(f) {
    const radius = stable(f.R, 4);
    const T = Math.round(f.T);
    const mass = stable(f.M, 4);
    const luminosity = f.L === undefined ? stable(luminosityFromRT(radius, T), 4) : f.L;
    const population = f.population || 'I';
    const composition = f.composition;
    return {
        class: f.cls,
        subclass: f.subclass,
        luminosity_class: f.lumClass,
        spectral_type: f.spectralType,
        stage: f.stage,
        teff_K: T,
        mass_Msun: mass,
        radius_Rsun: radius,
        luminosity_Lsun: luminosity,
        logg: dp(logG(mass, radius), 2),
        vsini_kms: dp(f.vsini, 1),
        population,
        peculiar: f.peculiar || null,
        wd_type: f.wd_type || null,
        active: !!f.active,
        age_Myr: stable(f.age, 4),
        metallicity_dex: composition.metallicity_dex,
        composition
    };
}

function suffixFor(peculiar) {
    return peculiar === 'ap' ? 'p' : peculiar === 'am' ? 'm' : '';
}

function typeText(cls, subclass, lumClass, peculiar) {
    if (peculiar === 'carbon') return `C${subclass} ${lumClass}`;
    if (peculiar === 'barium') return `${cls}${subclass} ${lumClass} Ba`;
    return `${cls}${subclass}${suffixFor(peculiar)} ${lumClass}`;
}

function ageOfMainSequence(rng, mass, population) {
    if (population === 'II') return rng.range(9000, 13000);
    const life = Math.min(msLifetimeMyr(mass), 12000);
    return Math.max(1, rng.range(0.02, 0.9) * life);
}

// A main-sequence star inside one class's row of the table. opts: population, peculiar, composition, maxMass.
export function makeClassStar(rng, cls, opts = {}) {
    const row = STAR_TABLE[cls];
    const population = opts.population || 'I';
    const hi = opts.maxMass ? Math.min(row.M[1], opts.maxMass) : row.M[1];
    const mass = stable(rng.logRange(row.M[0], hi), 4);
    const track = mainSequenceAt(mass);
    // A metal-poor star is a little hotter than a metal-rich one of the same mass
    const T = clamp(track.T * rng.range(0.985, 1.015) * (population === 'II' ? 1.02 : 1), row.T[0], row.T[1]);
    let R = clamp(track.R * rng.range(0.96, 1.04), row.R[0] * 0.95, row.R[1]);
    // Keep the corner where the table's own ranges disagree (hot, large O stars) inside its luminosity limit
    if (luminosityFromRT(R, T) > row.L[1]) R = radiusFromLT(row.L[1], T);
    const peculiar = opts.peculiar || null;
    const age = ageOfMainSequence(rng, mass, population);
    const young = age < 800;
    let vsini = rng.range(row.vsini[0], row.vsini[1]);
    let active = false;
    if (cls === 'M') {
        active = young || rng.chance(0.25);
        if (young) vsini = rng.range(8, 40); // Young red dwarfs spin fast until magnetic braking slows them
    } else if ((cls === 'G' || cls === 'K') && age < 300) {
        active = true;
    }
    if (peculiar === 'ap') vsini = rng.range(10, 60); // Chemically odd stars are the slow rotators of their class
    const subclass = subclassOf(cls, T);
    return makeBlock({
        cls, subclass, lumClass: 'V', spectralType: typeText(cls, subclass, 'V', peculiar), stage: 'main_sequence',
        T, M: mass, R, vsini, population, peculiar, active, age,
        composition: opts.composition || makeComposition(rng, population, peculiar)
    });
}

// A main-sequence star of a given mass, of whatever class that makes it: binary partners and cluster members.
// aged = 0..1 is the fraction of its lifetime used up, which moves it away from the zero-age line.
export function starFromMass(rng, mass, opts = {}) {
    const population = opts.population || 'I';
    const track = mainSequenceAt(mass);
    const aged = opts.aged || 0;
    const scatter = opts.tight ? 0.004 : 0.015;
    const T = track.T * (1 - 0.04 * aged * aged) * (population === 'II' ? 1.02 : 1) * rng.range(1 - scatter, 1 + scatter);
    const L = luminosityFromRT(track.R, track.T) * (1 + 0.7 * aged * aged) * rng.range(0.97, 1.03);
    const R = radiusFromLT(L, T);
    const cls = classFromT(T);
    const row = STAR_TABLE[cls];
    const age = opts.age ?? ageOfMainSequence(rng, mass, population);
    const subclass = subclassOf(cls, T);
    return makeBlock({
        cls, subclass, lumClass: 'V', spectralType: typeText(cls, subclass, 'V', null), stage: 'main_sequence',
        T, M: mass, R, vsini: rng.range(row.vsini[0], row.vsini[1]), population,
        active: cls === 'M' && rng.chance(0.3), age,
        composition: opts.composition || makeComposition(rng, population)
    });
}

// A red giant, burning helium or a hydrogen shell. opts: population, peculiar, composition, maxMass.
export function makeRedGiant(rng, opts = {}) {
    const population = opts.population || 'I';
    const peculiar = opts.peculiar || null;
    const mass = stable(rng.logRange(population === 'II' ? 0.8 : 1, opts.maxMass || 5), 4);
    const T = peculiar === 'carbon' ? rng.range(3500, 4500) : rng.range(3600, 5200);
    // Big enough to reach the giant column's luminosity floor at this temperature
    const R = stable(rng.logRange(Math.max(10, 1.03 * radiusFromLT(50, T)), 100), 4);
    const cls = classFromT(T);
    const subclass = subclassOf(cls, T);
    const giantAge = population === 'II' ? rng.range(9000, 13000) : msLifetimeMyr(mass) * rng.range(1.02, 1.12);
    return makeBlock({
        cls, subclass, lumClass: 'III', spectralType: typeText(cls, subclass, 'III', peculiar), stage: 'giant',
        T, M: mass, R, vsini: rng.range(1, 12), population, peculiar, age: giantAge,
        composition: opts.composition || makeComposition(rng, population, peculiar)
    });
}

export function makeRedSupergiant(rng, opts = {}) {
    const mass = stable(rng.logRange(10, 25), 4);
    const T = rng.range(3500, 4300);
    const R = stable(rng.logRange(300, 1000), 4);
    const cls = classFromT(T);
    const subclass = subclassOf(cls, T);
    return makeBlock({
        cls, subclass, lumClass: 'I', spectralType: typeText(cls, subclass, 'I', null), stage: 'supergiant',
        T, M: mass, R, vsini: rng.range(1, 15), age: msLifetimeMyr(mass) * rng.range(1.02, 1.1),
        composition: opts.composition || makeComposition(rng, 'I')
    });
}

export function makeBlueSupergiant(rng, opts = {}) {
    const mass = stable(rng.logRange(15, 40), 4);
    const T = stable(rng.logRange(10000, 30000), 4);
    // log g must stay below 3, which sets the smallest radius; the luminosity limit sets the largest
    const rLow = Math.sqrt(27.4 * mass) * 1.03;
    const rHigh = Math.max(rLow * 1.02, Math.min(200, radiusFromLT(1000000, T)));
    const R = stable(rng.logRange(rLow, rHigh), 4);
    const cls = classFromT(T);
    const subclass = subclassOf(cls, T);
    return makeBlock({
        cls, subclass, lumClass: 'I', spectralType: typeText(cls, subclass, 'I', null), stage: 'supergiant',
        T, M: mass, R, vsini: rng.range(5, 20), age: msLifetimeMyr(mass) * rng.range(1.02, 1.1),
        composition: opts.composition || makeComposition(rng, 'I')
    });
}

const WD_TEMPERATURES = { DB: [12000, 30000], DZ: [5000, 12000], DQ: [5000, 12000] };

export function whiteDwarfRadius(mass) {
    return stable(0.0112 * Math.cbrt(0.6 / mass), 4);
}

// A white dwarf. opts: wd_type, population, composition, T (fixed temperature), R, age.
export function makeWhiteDwarf(rng, opts = {}) {
    const wd_type = opts.wd_type || rng.weighted([['DA', 80], ['DB', 10], ['DZ', 5], ['DQ', 5]]);
    const u = rng.next();
    const mass = dp(0.5 + 0.7 * u * u, 3); // Most sit near 0.6 solar masses
    const span = WD_TEMPERATURES[wd_type] || [5000, 100000];
    // Most have cooled long ago, so skew towards the cool end
    const v = rng.next();
    const T = opts.T ?? stable(span[0] * (span[1] / span[0]) ** (v * Math.sqrt(v)), 4);
    const index = clamp(Math.round(50400 / T), 1, 9);
    return makeBlock({
        cls: 'D', subclass: index, lumClass: 'D', spectralType: `${wd_type}${index}`, stage: 'white_dwarf',
        T, M: mass, R: opts.R ?? whiteDwarfRadius(mass), vsini: rng.range(1, 49.9), population: opts.population || 'I',
        wd_type, age: opts.age ?? rng.logRange(500, 12000),
        composition: opts.composition || makeComposition(rng, opts.population || 'I')
    });
}

// A star block from fixed values: the hard-coded systems. v: { class, subclass, luminosity_class, teff_K, mass_Msun,
// radius_Rsun, luminosity_Lsun, vsini_kms, age_Myr, composition }
export function fixedStar(v) {
    return makeBlock({
        cls: v.class, subclass: v.subclass, lumClass: v.luminosity_class,
        spectralType: `${v.class}${v.subclass} ${v.luminosity_class}`, stage: 'main_sequence',
        T: v.teff_K, M: v.mass_Msun, R: v.radius_Rsun, L: v.luminosity_Lsun, vsini: v.vsini_kms, active: v.active,
        population: 'I', age: v.age_Myr, composition: v.composition
    });
}

// How a star block looks in a cluster: an evolved star just past the turn-off of a coeval group
export function clusterGiant(rng, turnoff, progress, opts) {
    const massive = turnoff.mass > 8;
    const population = opts.population;
    if (massive) {
        const T = rng.range(3700, 4600);
        const L = turnoff.L * rng.range(1.1, 2);
        const cls = classFromT(T);
        const subclass = subclassOf(cls, T);
        return makeBlock({
            cls, subclass, lumClass: 'I', spectralType: typeText(cls, subclass, 'I', null), stage: 'supergiant',
            T, M: turnoff.mass * rng.range(1, 1.05), R: radiusFromLT(L, T), vsini: rng.range(1, 15), population,
            age: opts.age, composition: opts.composition
        });
    }
    // Up the giant branch: cooler and more luminous as it climbs. Metal-poor giants stay warmer
    const cool = population === 'II' ? 4300 : 3900;
    const T = cool + (turnoff.T * 0.9 - cool) * (1 - progress) ** 2 * rng.range(0.97, 1.03);
    const L = Math.min(turnoff.L * 2 * 10 ** (2.4 * progress), Math.max(2500, 8 * turnoff.L));
    const cls = classFromT(T);
    const subclass = subclassOf(cls, T);
    const lumClass = progress < 0.2 ? 'IV' : 'III';
    return makeBlock({
        cls, subclass, lumClass, spectralType: typeText(cls, subclass, lumClass, null), stage: 'giant',
        T, M: turnoff.mass * rng.range(1, 1.06), R: radiusFromLT(L, T), vsini: rng.range(1, 8), population,
        age: opts.age, composition: opts.composition
    });
}

// Bolometric correction: how much of a star's total light falls in the visible, from the Planck curve between 500 and
// 600 nm against the Sun's. It keeps O stars and hot white dwarfs from looking absurdly bright by eye, since most of
// their light is ultraviolet. Tabulated once; a lookup replaces ten Planck calls per star.
let bcTemps = null;
let bcValues = null;

function visibleFraction(T) {
    const steps = 8;
    const hNm = 100 / steps;
    let sum = 0;
    for (let i = 0; i <= steps; i++) {
        const w = i === 0 || i === steps ? 1 : i % 2 ? 4 : 2;
        sum += w * planck(500 + i * hNm, T);
    }
    const band = (sum * hNm * 1e-9) / 3;
    return (band * Math.PI) / (SIGMA * T * T * T * T);
}

function buildBcTable() {
    const n = 96;
    bcTemps = new Float64Array(n);
    bcValues = new Float64Array(n);
    const ratio = (250000 / 1000) ** (1 / (n - 1));
    const sun = visibleFraction(T_SUN_K);
    for (let i = 0; i < n; i++) {
        const T = stable(1000 * ratio ** i, 8);
        bcTemps[i] = T;
        bcValues[i] = stable(BC_SUN + 2.5 * Math.log10(visibleFraction(T) / sun), 7);
    }
}

export function bolometricCorrection(T) {
    if (!bcTemps) buildBcTable();
    const n = bcTemps.length;
    if (T <= bcTemps[0]) return bcValues[0];
    if (T >= bcTemps[n - 1]) return bcValues[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (T < bcTemps[mid]) hi = mid;
        else lo = mid;
    }
    const f = (T - bcTemps[lo]) / (bcTemps[hi] - bcTemps[lo]);
    return bcValues[lo] + (bcValues[hi] - bcValues[lo]) * f;
}

// Absolute visual magnitude of a star
export function absoluteVisual(luminosity, T) {
    return stable(MBOL_SUN - 2.5 * Math.log10(luminosity) - bolometricCorrection(T), 6);
}

export function distanceModulus(distancePc) {
    return 5 * Math.log10(distancePc / 10);
}

export function apparentMag(absMag, distancePc) {
    return dp(absMag + distanceModulus(distancePc), 3);
}

export function distanceForMag(absMag, mag) {
    return stable(10 * 10 ** ((mag - absMag) / 5), 5);
}

// The magnitude of several sources seen as one
export function combineMags(mags) {
    let flux = 0;
    mags.forEach((m) => { flux += 10 ** (-0.4 * m); });
    return dp(-2.5 * Math.log10(flux), 3);
}

// Bolometric flux of a source known only by its visual magnitude (W/m^2): magnitude 0 is 2.5e-8 W/m^2
export function fluxFromVisualMag(mag) {
    return stable(2.5e-8 * 10 ** (-0.4 * mag), 5);
}
