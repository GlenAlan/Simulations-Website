// Standard stars for the reference library (spec 10.3): each is a star block in the schema of data/universe.js, so the
// stellar model can render them like any other star.
// Main sequence: Teff, luminosity, radius and mass from Pecaut and Mamajek 2013 (ApJS 208, 9), table version 2022.04.16.
// v sin i: typical values for the class, kept at the low end so that lines stay readable.
// A few real standards sit just outside the sim's class ranges (B0 at 31,400 K, K0 at 5,270 K, M0 at 3,850 K). That is the table's value and is
// a fair teaching point: spectral classes don't have hard temperature edges.
// White dwarf: a typical DA at log g = 8 (Bergeron et al. 1992). Red giant: a typical K5 III, close to Aldebaran (Heiter et al. 2015).

import { logG } from '../core/phys.js';

const SOLAR_MIX = { Fe: 0, Ca: 0, Na: 0, Mg: 0, Ti: 0, C: 0, N: 0, O: 0, Si: 0 };

function dwarf(cls, subclass, teff_K, logL, radius_Rsun, mass_Msun, vsini_kms, age_Myr) {
    return {
        class: cls,
        subclass,
        luminosity_class: 'V',
        stage: 'main_sequence',
        teff_K,
        mass_Msun,
        radius_Rsun,
        luminosity_Lsun: 10 ** logL,
        logg: logG(mass_Msun, radius_Rsun),
        vsini_kms,
        population: 'I',
        peculiar: null,
        wd_type: null,
        age_Myr,
        composition: { X: 0.71, Y: 0.27, Z: 0.02, metals_dex: { ...SOLAR_MIX } }
    };
}

export const STANDARDS = {
    O5: dwarf('O', 5, 41400, 5.54, 11.45, 43, 150, 2),
    B0: dwarf('B', 0, 31400, 4.65, 7.16, 17.7, 120, 8),
    B5: dwarf('B', 5, 15700, 2.77, 3.36, 4.7, 120, 60),
    A0: dwarf('A', 0, 9700, 1.58, 2.193, 2.18, 100, 200),
    A5: dwarf('A', 5, 8100, 1.09, 1.785, 1.88, 100, 500),
    F0: dwarf('F', 0, 7220, 0.86, 1.728, 1.61, 60, 1000),
    F5: dwarf('F', 5, 6550, 0.56, 1.473, 1.33, 25, 2000),
    G2: dwarf('G', 2, 5770, 0.01, 1.012, 1.0, 2, 4600),
    G8: dwarf('G', 8, 5480, -0.17, 0.914, 0.94, 2, 6000),
    K0: dwarf('K', 0, 5270, -0.34, 0.813, 0.88, 2, 7000),
    K5: dwarf('K', 5, 4440, -0.76, 0.701, 0.7, 2, 8000),
    M0: dwarf('M', 0, 3850, -1.16, 0.588, 0.57, 2, 9000),
    M5: dwarf('M', 5, 3060, -2.52, 0.196, 0.162, 3, 9000),
    DA: {
        class: 'D',
        subclass: 3,
        luminosity_class: 'D',
        stage: 'white_dwarf',
        teff_K: 15000,
        mass_Msun: 0.6,
        radius_Rsun: 0.0125,
        luminosity_Lsun: 0.0071,
        logg: logG(0.6, 0.0125),
        vsini_kms: 10,
        population: 'I',
        peculiar: null,
        wd_type: 'DA',
        age_Myr: 2000,
        // A DA's atmosphere is almost pure hydrogen: everything heavier has sunk out of sight in the strong gravity
        composition: { X: 1, Y: 0, Z: 0, metals_dex: { Fe: -5, Ca: -5, Na: -5, Mg: -5, Ti: -5, C: -5, N: -5, O: -5, Si: -5 } }
    },
    RG: {
        class: 'K',
        subclass: 5,
        luminosity_class: 'III',
        stage: 'giant',
        teff_K: 3950,
        mass_Msun: 1.2,
        radius_Rsun: 42,
        luminosity_Lsun: 390,
        logg: logG(1.2, 42),
        vsini_kms: 3,
        population: 'I',
        peculiar: null,
        wd_type: null,
        age_Myr: 6000,
        composition: { X: 0.71, Y: 0.27, Z: 0.02, metals_dex: { ...SOLAR_MIX } }
    }
};

export const STANDARD_IDS = Object.keys(STANDARDS);

// What to call each one in the dropdown
export const STANDARD_LABELS = {
    O5: 'O5 star', B0: 'B0 star', B5: 'B5 star', A0: 'A0 star', A5: 'A5 star', F0: 'F0 star', F5: 'F5 star', G2: 'G2 star',
    G8: 'G8 star', K0: 'K0 star', K5: 'K5 star', M0: 'M0 star', M5: 'M5 star', DA: 'White dwarf (DA)', RG: 'Red giant (K5 III)'
};
