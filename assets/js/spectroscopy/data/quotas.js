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
    // How each black hole is fed (data/dynamics.js settleHole): most by a low-mass companion filling its Roche lobe, some by
    // a massive companion's wind, a few not at all, as among the stellar black holes known in our galaxy
    blackHoleFeeding: { roche: 14, wind: 6, none: 5 },
    eclipsingTilted: 5,                                // Detached close pairs turned edge-on (data/dynamics.js tiltEclipses)
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

// ---------- The sky's proportions (round 4, the owner's, 8 November 2026) ----------
// Everything in this block came in together and can be adjusted, or taken out, on its own. data/universe.js applies it once
// the sky above has been made and laid out exactly as before, from streams and codes of its own, so a number here moves only
// what it names. To go back to the sky before: SUPERNOVAE.near { Ia: 8, II: 7 } and far { Ia: 0, II: 0 } with the 15 the first
// sky makes, ROGUE_PLANETS_KEPT { first: 117, deep: 117 }, and every count in EXTRA 0.

// Supernovae. The first sky still makes BODY_COUNTS.supernova of them, as it always did, so that nothing laid out after them
// moves. Of those, the nearest `near` of each type stay as they were: bright, in our galaxy or just beyond it. `far` more are
// seen as nearly every real supernova is, in another galaxy: on one of the sky's galaxies, at its distance and redshift, a
// faint point that only shows zoomed in on it, and too far off for its remnant to be seen. They take the codes of the near
// ones that went, a type's own first; any left over go. A neutron star that a supernova which went had left behind stays
// where it is, as a neutron star of our own galaxy's.
export const SUPERNOVAE = {
    near: { Ia: 1, II: 2 },
    far: { Ia: 5, II: 2 },
    farPeakMag: [12.5, 15],          // How bright a far one is at its peak: its host is a galaxy at the distance that gives this
    farPhaseDays: [-8, 25],          // Days from its peak at the start, spread evenly: caught near its peak, as real ones are
    farFaintestNow: 16.6,            // The faintest one may be drawn at the start, so it can be found zoomed in (the limit is 17.5)
    farOffset: [0.15, 0.55]          // How far out on its galaxy, as a share of the way from the middle to the edge as drawn
};

// Rogue planets: of those each sky makes (BODY_COUNTS.rogue_planet in the first, as many again in the deeper), how many stay.
// The first made stay; the rest go once everything is laid out, so that nothing else moves. Each set has 117 to keep.
export const ROGUE_PLANETS_KEPT = { first: 117, deep: 0 };

// The added sky: more single stars of every class with many more giants among them, many more multi-star systems, and many
// more distant galaxies, among and behind the rest. Most are faint, for the zoom to find; brightGiants and brightMultis of
// them can be seen by eye, at the widest view.
export const EXTRA = {
    stars: { O: 3, B: 5, A: 10, F: 12, G: 18, K: 22, M: 52, WD: 8, GIANT: 100 },  // Single stars; planets in STAR_TABLE's shares
    giants: { red_giant: 69, red_supergiant: 10, blue_supergiant: 21 },             // Must add up to stars.GIANT; the first sky's mix
    brightGiants: 40,                // Of those giants, as bright as the first sky's stars (magnitude 6 or brighter)
    peculiar: { carbon: 4, barium: 2, ap: 4, am: 3 },                               // Carbon and barium from the red giants
    populationII: 57,                // Old, metal-poor stars among the rest: a quarter, as in the first sky
    multi: 257,                      // Multi-star systems: with the first and deeper skies', a quarter of all star systems
    triples: 51,                     // Of those, hierarchical triples; the rest are pairs
    withPlanets: 64,                 // Of those, with planets round the whole system
    interacting: 16,                 // Of those, close pairs passing mass across: the rarer, livelier kind, like the first sky's
    giantPrimaries: 12,              // Of those, systems led by a giant, besides any drawn that way by chance
    brightMultis: 12,                // Of those, as bright as the first sky's
    widestPairAU: 30,                // The widest a plain pair's orbit is drawn, for wide pairs as well as close ones (else 3 AU)
    eclipsingTilted: 5,              // More detached close pairs turned edge-on, so that they eclipse
    galaxy: { spiral: 81, elliptical: 39, irregular: 15 },
    starbursts: 19,                  // Among the spirals and irregulars
    radioLobes: 10,
    activeNuclei: 14,
    galaxyMpc: [100, 1600],          // Distances, in steps that crowd towards the far end: v = H0 d, so z up to about 0.37
    galaxyFaintest: [16.4, 17.2]     // The faintest each may look; one further than that is lifted to a magnitude drawn in here,
                                     // so that they come into view over a range of zooms, as near the limit of any survey
};

// The added sky's single stars in STAR_TABLE's shape, and their mix in MIX's, for data/universe.js planSingleStars
function extraQuotas() {
    const stars = {};
    Object.keys(STAR_TABLE).forEach((c) => {
        const row = STAR_TABLE[c];
        const count = EXTRA.stars[c] || 0;
        stars[c] = { ...row, count, withPlanets: Math.round((count * row.withPlanets) / row.count) };
    });
    const total = Object.values(stars).reduce((sum, row) => sum + row.count, 0);
    const peculiar = Object.values(EXTRA.peculiar).reduce((a, b) => a + b, 0);
    const mix = {
        giants: EXTRA.giants,
        peculiar: EXTRA.peculiar,
        population: { I: total - EXTRA.populationII - peculiar, II: EXTRA.populationII, peculiar }
    };
    return { stars, mix, total };
}

export const EXTRA_STARS = extraQuotas();
