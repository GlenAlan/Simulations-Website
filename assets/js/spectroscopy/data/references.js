// The reference library behind the Spectrum tab's dropdown (spec 10.3).
//   REFERENCE_GROUPS = [{ id, label, items: [{ id, label, kind, keywords, ... }] }]
//   kind 'lamp'|'ion'|'uv': emission lines. species is a key of LINES; a uv item also has lines (the wavelengths it shows, nm),
//                           lo_nm and hi_nm (a good range to frame) and sometimes note
//   kind 'molecule':        absorption bands. molecule is a key of MOLECULES
//   kind 'standard':        a star. standard is a key of STANDARDS
//   kind 'blackbody':       a Planck curve. T_min_K, T_max_K and T_default_K set the slider
// Ids are stable: 'lamp:H', 'ion:Ca II', 'uv:lyman', 'mol:H2O', 'std:G2', 'bb'.

import { LINES } from './lines.js';
import { MOLECULES } from './molecules.js';
import { STANDARDS, STANDARD_IDS, STANDARD_LABELS } from './standards.js';

const lamp = (symbol, name, keywords = []) => ({
    id: `lamp:${symbol}`,
    label: `${name} (${symbol})`,
    kind: 'lamp',
    species: `${symbol} I`,
    keywords: [name.toLowerCase(), symbol, `${symbol} I`, 'lamp', 'discharge tube', 'emission', ...keywords]
});

const ion = (species, label, keywords = []) => ({
    id: `ion:${species}`,
    label,
    kind: 'ion',
    species,
    keywords: [species, 'ion', 'ionised', ...keywords]
});

const uv = (id, label, species, lines, lo_nm, hi_nm, keywords = [], note) => ({
    id: `uv:${id}`,
    label,
    kind: 'uv',
    species,
    lines,
    lo_nm,
    hi_nm,
    keywords: [species, 'uv', 'ultraviolet', ...keywords],
    ...(note ? { note } : {})
});

const mol = (key, keywords = []) => ({
    id: `mol:${key}`,
    label: `${MOLECULES[key].name} (${MOLECULES[key].label})`,
    kind: 'molecule',
    molecule: key,
    keywords: [MOLECULES[key].name.toLowerCase(), key.replace('_', ' '), 'molecule', 'absorption', 'band', ...keywords]
});

const STANDARD_KEYWORDS = {
    O5: ['hot', 'blue', 'helium', 'he ii'], B0: ['blue', 'helium', 'he i'], B5: ['blue', 'helium', 'he i'],
    A0: ['white', 'balmer', 'hydrogen'], A5: ['white', 'balmer', 'hydrogen'], F0: ['yellow white', 'calcium'], F5: ['yellow white', 'calcium'],
    G2: ['yellow', 'sun', 'solar', 'calcium', 'g band'], G8: ['yellow', 'calcium', 'g band'], K0: ['orange', 'metals', 'mg b'],
    K5: ['orange', 'metals', 'mg b'], M0: ['red', 'tio', 'red dwarf'], M5: ['red', 'tio', 'red dwarf'],
    DA: ['white dwarf', 'wd', 'broad hydrogen', 'pressure broadening'], RG: ['red giant', 'giant', 'k5 iii', 'narrow lines']
};

const DWARF_NOTE = 'A main-sequence star, or dwarf. A giant at the same temperature has narrower lines, so it looks different: try the red giant too.';
const GIANT_NOTE = 'A giant\'s thin outer layers give narrower lines than a dwarf\'s at the same temperature. This one reference stands for cool giants of every class, and it is cooler than a K5 dwarf.';

// Says which sort of star each standard is, as a dwarf and a giant of one class look quite different
const stdName = (id) => (STANDARDS[id].luminosity_class === 'V' ? `${id} dwarf (${id} V)` : STANDARD_LABELS[id]);

const std = (id) => ({
    id: `std:${id}`,
    label: `${stdName(id)}, ${Math.round(STANDARDS[id].teff_K).toLocaleString('en-GB')} K`,
    kind: 'standard',
    standard: id,
    keywords: [id, 'standard star', 'classification', `${STANDARDS[id].class}`, ...STANDARD_KEYWORDS[id]],
    ...(id === 'RG' ? { note: GIANT_NOTE } : STANDARDS[id].luminosity_class === 'V' ? { note: DWARF_NOTE } : {})
});

const lyman = LINES['H I'].filter((l) => l.series === 'Lyman').map((l) => l.w);

export const REFERENCE_GROUPS = [
    {
        id: 'lamp',
        label: 'Element lamps',
        items: [
            lamp('H', 'Hydrogen', ['balmer', 'h alpha', 'lyman', 'paschen']),
            lamp('He', 'Helium', ['d3']),
            lamp('Li', 'Lithium'),
            lamp('C', 'Carbon'),
            lamp('N', 'Nitrogen'),
            lamp('O', 'Oxygen'),
            lamp('Na', 'Sodium', ['na d', 'street lamp', 'yellow']),
            lamp('Mg', 'Magnesium', ['mg b']),
            lamp('Si', 'Silicon'),
            lamp('Ca', 'Calcium'),
            lamp('Ti', 'Titanium'),
            lamp('Fe', 'Iron'),
            lamp('Ne', 'Neon', ['orange', 'red', 'sign']),
            lamp('Hg', 'Mercury', ['fluorescent', '546'])
        ]
    },
    {
        id: 'ion',
        label: 'Ionised elements',
        items: [
            ion('He II', 'He II (helium, once ionised)', ['helium', '468.6', '541.1', 'o star']),
            ion('Ca II', 'Ca II (calcium, once ionised)', ['calcium', 'h and k', 'h & k', '393.4', '396.8', 'triplet']),
            ion('Fe II', 'Fe II (iron, once ionised)', ['iron', '516.9']),
            ion('Si II', 'Si II (silicon, once ionised)', ['silicon', 'supernova', 'type ia', '615', '634.7', '637.1']),
            ion('O III', 'O III (oxygen, twice ionised)', ['oxygen', 'nebula', 'forbidden', '495.9', '500.7']),
            ion('N II', 'N II (nitrogen, once ionised)', ['nitrogen', 'nebula', 'forbidden', '654.8', '658.4'])
        ]
    },
    {
        id: 'uv',
        label: 'UV lines',
        items: [
            uv('lyman', 'H Lyman series (Lyα 121.6, Lyβ 102.6 nm)', 'H I', lyman, 90, 130, ['hydrogen', 'lyman alpha', 'ly alpha', 'lya', 'quasar']),
            uv('N V', 'N V 123.9/124.3 nm', 'N V', [123.88, 124.279], 120, 128, ['nitrogen', 'hot star', 'quasar']),
            uv('Si IV', 'Si IV 139.4/140.3 nm', 'Si IV', [139.375, 140.277], 135, 145, ['silicon', 'hot star', 'quasar']),
            uv('C IV', 'C IV 154.8/155.1 nm', 'C IV', [154.82, 155.078], 150, 160, ['carbon', 'hot star', 'quasar']),
            uv('He II', 'He II 164.0 nm', 'He II', [164.042], 160, 168, ['helium', 'o star']),
            uv('Mg II', 'Mg II 279.6/280.3 nm', 'Mg II', [279.553, 280.271], 275, 285, ['magnesium', 'h and k', 'quasar', '279.8', '280.4'],
                'These are air wavelengths, like every line above 200 nm here. UV astronomers often quote the vacuum values, 279.6 and 280.4 nm.')
        ]
    },
    {
        id: 'molecule',
        label: 'Molecules and compounds',
        items: [
            mol('H2O', ['steam']),
            mol('CO2'),
            mol('CH4', ['gas giant', 'ice giant', 'blue']),
            mol('NH3', ['gas giant']),
            mol('O2', ['a band']),
            mol('O3', ['chappuis', 'hartley', 'huggins']),
            mol('CO'),
            mol('TiO', ['m star', 'red dwarf', 'band head']),
            mol('C2', ['swan', 'carbon star', 'comet', 'band head']),
            mol('CN', ['comet', 'carbon star', 'band head']),
            mol('CH', ['g band', 'carbon star']),
            mol('SO2', ['venus']),
            mol('N2O', ['laughing gas']),
            mol('H2O_ice', ['frost', 'frozen']),
            mol('CH4_ice', ['frost', 'frozen', 'pluto'])
        ]
    },
    {
        id: 'standard',
        label: 'Standard stars',
        items: STANDARD_IDS.map(std)
    },
    {
        id: 'blackbody',
        label: 'Black body',
        items: [{
            id: 'bb',
            label: 'Black body (adjustable)',
            kind: 'blackbody',
            T_min_K: 1000,
            T_max_K: 150000,
            T_default_K: 5800,
            keywords: ['black body', 'blackbody', 'planck', 'wien', 'continuum', 'temperature', 'thermal']
        }]
    }
];

const BY_ID = new Map(REFERENCE_GROUPS.flatMap((group) => group.items).map((item) => [item.id, item]));

export function getReference(id) {
    return BY_ID.get(id) ?? null;
}
