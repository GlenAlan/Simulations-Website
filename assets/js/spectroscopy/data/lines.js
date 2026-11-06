// FOUNDATION STUB, replaced by the lines track. Air wavelengths above 200 nm, vacuum below.
//   LINES['H I'] = [{ w: 656.28, s: 1, label: 'Hα' }, ...]    w in nm, s = relative strength within the species
//   LINE_SPECIES = ['H I', 'He I', ...]

export const LINES = {
    'H I': [
        { w: 656.28, s: 1, label: 'Hα' }, { w: 486.13, s: 0.36, label: 'Hβ' },
        { w: 434.05, s: 0.17, label: 'Hγ' }, { w: 410.17, s: 0.09, label: 'Hδ' },
        { w: 121.57, s: 1, label: 'Lyα' }, { w: 102.57, s: 0.3, label: 'Lyβ' }
    ]
};

export const LINE_SPECIES = Object.keys(LINES);
