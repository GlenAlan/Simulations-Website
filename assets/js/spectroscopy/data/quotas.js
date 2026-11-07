// The sky's exact head counts (spec 7): seeded shuffles of these quotas, rather than free weighted draws, so the
// tables hold to the last body. Rounded by largest remainder where a share doesn't divide evenly.

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
    supernova: { Ia: 8, II: 7 },
    rogue_planet: { gas_giant: 59, sub_neptune: 35, ice_dwarf: 23 },
    giants: { red_giant: 20, red_supergiant: 3, blue_supergiant: 6 },
    population: { I: 401, II: 143, peculiar: 29 },     // Shares of 573 single stars (spec 8.1)
    peculiar: { carbon: 8, barium: 3, ap: 11, am: 7 }
};
