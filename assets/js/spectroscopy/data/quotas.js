// The sky's exact head counts (spec 7): seeded shuffles of these quotas, rather than free weighted draws, so the
// tables hold to the last body. Rounded by largest remainder where a share doesn't divide evenly.

import { STAR_TABLE } from './stellar.js';

// Exact counts for the kinds in spec 7.1; the stars' own counts are in data/stellar.js
export const BODY_COUNTS = {
    star: 573, multi: 102, rogue_planet: 117, comet: 10, nebula: 45, cluster: 40, neutron_star: 35, galaxy: 35,
    black_hole: 25, supernova: 15, quasar: 3
};
export const MIX = {
    triples: 20,                                       // Of the 100 random multi-star systems; the rest are binaries
    multiWithPlanets: 45,                              // Likewise
    nebula: { emission: 27, planetary: 11, dark: 4, reflection: 3 },
    cluster: { open: 32, globular: 8 },
    neutron_star: { pulsar: 21, quiet: 14 },
    galaxy: { spiral: 21, elliptical: 10, irregular: 4 },
    starbursts: 5,                                     // Among the spirals and irregulars
    radioLobes: 4,                                     // Among all the galaxies
    activeNuclei: 5,
    supernova: { Ia: 8, II: 7 },
    rogue_planet: { gas_giant: 59, sub_neptune: 35, ice_dwarf: 23 },
    giants: { red_giant: 20, red_supergiant: 3, blue_supergiant: 6 },
    population: { I: 401, II: 143, peculiar: 29 },     // Shares of 573 single stars (spec 8.1)
    peculiar: { carbon: 8, barium: 3, ap: 11, am: 7 }
};

// Comets: of the ten first made, these stay in our own sky. The rest went to other stars as exocomets (data/exocomets.js),
// where more join them.
export const SKY_COMETS = 2;
export const EXOCOMETS = 24;

// How many times the first sky's common kinds there are now. The first set is made exactly as it always was, so every code
// and place in it stays, and a deeper, fainter set is added behind it: SKY_SCALE - 1 times each common kind, in the same mix.
// Rare kinds (supernovae, quasars, black holes, neutron stars, comets, the hard-coded systems) keep their counts, and none of
// the new pairs pass mass across, so interacting binaries keep theirs too.
export const SKY_SCALE = 2;

// Exact largest-remainder counts for a list of shares
export function apportion(shares, total) {
    const exact = shares.map((s) => s * total);
    const out = exact.map((x) => Math.floor(x));
    let left = total - out.reduce((a, b) => a + b, 0);
    const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (let i = 0; left > 0; i++, left--) out[order[i][1]]++;
    return out;
}

// A table of counts scaled by k, keeping its total in proportion and each entry's share
function scaled(table, k) {
    const keys = Object.keys(table);
    const total = keys.reduce((sum, key) => sum + table[key], 0);
    const counts = apportion(keys.map((key) => table[key] / total), Math.round(total * k));
    const out = {};
    keys.forEach((key, i) => { out[key] = counts[i]; });
    return out;
}

function scaledCount(n, k) {
    return Math.round(n * k);
}

// The deeper sky's quotas, in the shape of BODY_COUNTS, MIX and STAR_TABLE
function deepQuotas(k) {
    const classes = scaled(Object.fromEntries(Object.keys(STAR_TABLE).map((c) => [c, STAR_TABLE[c].count])), k);
    const hosts = scaled(Object.fromEntries(Object.keys(STAR_TABLE).map((c) => [c, STAR_TABLE[c].withPlanets])), k);
    const stars = {};
    Object.keys(STAR_TABLE).forEach((c) => { stars[c] = { ...STAR_TABLE[c], count: classes[c], withPlanets: Math.min(classes[c], hosts[c]) }; });
    const random = BODY_COUNTS.multi - 2;               // The hard-coded pair of systems isn't doubled
    const counts = {
        star: Object.values(classes).reduce((a, b) => a + b, 0),
        multi: scaledCount(random, k),
        rogue_planet: scaledCount(BODY_COUNTS.rogue_planet, k),
        nebula: scaledCount(BODY_COUNTS.nebula, k),
        cluster: scaledCount(BODY_COUNTS.cluster, k),
        galaxy: scaledCount(BODY_COUNTS.galaxy, k)
    };
    const mix = {
        triples: scaledCount(MIX.triples, k),
        multiWithPlanets: scaledCount(MIX.multiWithPlanets, k),
        nebula: scaled(MIX.nebula, k),
        cluster: scaled(MIX.cluster, k),
        galaxy: scaled(MIX.galaxy, k),
        starbursts: scaledCount(MIX.starbursts, k),
        radioLobes: scaledCount(MIX.radioLobes, k),
        activeNuclei: scaledCount(MIX.activeNuclei, k),
        rogue_planet: scaled(MIX.rogue_planet, k),
        giants: scaled(MIX.giants, k),
        population: scaled(MIX.population, k),
        peculiar: scaled(MIX.peculiar, k)
    };
    return { counts, mix, stars };
}

export const DEEP = deepQuotas(SKY_SCALE - 1);
