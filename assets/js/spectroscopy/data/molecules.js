// Molecular bands within the 90 nm to 5 um axis: real band positions, simplified widths and depths (spec 8.4).
//   MOLECULES['CO2'] = { label, name, phase, bands: [{ c, w, d, shape, head?, dir? }], note? }
//   c = band centre in nm, w = full width in nm, d = relative depth 0..1 within the molecule
//   shape: 'gauss'  a smooth dip, w is the full width at half depth
//          'rot'    a resolved-looking band: an R branch on the short side and a P branch on the long side, with a gap between
//          'edge'   a band head: sharp at `head` (nm), fading over w in direction `dir`. dir = 1 fades to the red (TiO, red CN, CO
//                   overtones), dir = -1 fades to the blue (C2 Swan, violet CN, MgH, CaH). c = head + dir * w / 2.
//   note = bands that lie off the axis, for the info text
//
// Sources for positions: HITRAN2020 (Gordon et al. 2022) for H2O, CO2, CH4, NH3, O2, O3, CO, SO2, N2O in the infrared;
// Karkoschka 1994 (Icarus 111) for CH4 and NH3 in the visible, with CH4's relative depths taken as the cube root of his coefficients;
// Pearse and Gaydon, The Identification of Molecular Spectra, for band heads of TiO, C2, CN, CH, MgH, CaH, with Valenti et al. 1998 for
// TiO; Burrows et al. 1999 for the O3 Hartley, Huggins and Chappuis bands; Manatt and Lane 1993 for SO2 in the UV;
// Warren and Brandt 2008 and Clark 1981 for water ice; Grundy et al. 2002 for methane ice; Quirico and Schmitt 1997 for N2 and CO ices.
// Depths outside CH4's visible bands are judged by eye from those sources, to look right rather than to be a fit.

const gauss = (c, w, d) => ({ c, w, d, shape: 'gauss' });
const rot = (c, w, d) => ({ c, w, d, shape: 'rot' });
const edge = (head, w, d, dir = 1) => ({ c: head + (dir * w) / 2, w, d, shape: 'edge', head, dir });

export const MOLECULES = {
    H2O: {
        label: 'H₂O', name: 'Water vapour', phase: 'gas',
        note: 'Its strongest band, near 6.3 µm, lies beyond this 5 µm axis.',
        bands: [
            gauss(592, 12, 0.03), gauss(651, 14, 0.05), gauss(720, 25, 0.12), gauss(820, 30, 0.18), rot(940, 80, 0.4),
            rot(1130, 100, 0.55), rot(1380, 170, 0.85), rot(1870, 200, 0.9), rot(2700, 400, 1)
        ]
    },
    CO2: {
        label: 'CO₂', name: 'Carbon dioxide', phase: 'gas',
        note: 'Its other main band, at 15 µm, lies beyond this 5 µm axis.',
        bands: [
            gauss(1050, 12, 0.05), gauss(1210, 15, 0.08), gauss(1430, 25, 0.15), rot(1600, 70, 0.3), rot(2010, 110, 0.6),
            rot(2700, 130, 0.8), rot(4260, 190, 1)
        ]
    },
    CH4: {
        label: 'CH₄', name: 'Methane', phase: 'gas',
        note: 'It also has a band at 7.7 µm, beyond this 5 µm axis.',
        bands: [
            gauss(543, 5, 0.09), gauss(619, 10, 0.16), gauss(665, 6, 0.12), gauss(702, 9, 0.13), gauss(727, 10, 0.29),
            gauss(790, 28, 0.17), gauss(842, 9, 0.17), gauss(864, 10, 0.3), gauss(890, 22, 0.6), gauss(990, 30, 0.45),
            gauss(1160, 90, 0.7), gauss(1380, 130, 0.8), rot(1700, 130, 0.85), rot(2300, 180, 0.95), rot(3300, 230, 1)
        ]
    },
    NH3: {
        label: 'NH₃', name: 'Ammonia', phase: 'gas',
        note: 'Its strongest band, near 10.5 µm, lies beyond this 5 µm axis.',
        bands: [
            gauss(552, 6, 0.05), gauss(645, 8, 0.25), gauss(790, 20, 0.3), gauss(930, 30, 0.3), gauss(1030, 40, 0.5),
            gauss(1270, 60, 0.5), gauss(1510, 110, 0.75), rot(2000, 100, 0.8), rot(2300, 110, 0.7), rot(3000, 300, 1)
        ]
    },
    O2: {
        label: 'O₂', name: 'Oxygen', phase: 'gas',
        bands: [
            gauss(150, 40, 1), gauss(190, 30, 0.6), gauss(225, 40, 0.1), rot(628, 8, 0.1), rot(688, 10, 0.35),
            rot(762, 14, 0.9), gauss(1067, 30, 0.08), rot(1270, 30, 0.4)
        ]
    },
    O3: {
        label: 'O₃', name: 'Ozone', phase: 'gas',
        note: 'Its best-known band, at 9.6 µm, lies beyond this 5 µm axis. The Hartley and Huggins bands (200 to 340 nm) and the Chappuis band (450 to 750 nm) are the ones you can see here.',
        bands: [
            gauss(255, 60, 1), gauss(325, 40, 0.25), gauss(602, 150, 0.15), rot(3270, 60, 0.08), rot(3590, 60, 0.06),
            rot(4750, 100, 0.2)
        ]
    },
    CO: {
        label: 'CO', name: 'Carbon monoxide', phase: 'gas',
        bands: [gauss(150, 20, 0.5), edge(1558, 60, 0.1), edge(2293.5, 160, 0.5), rot(4670, 300, 1)]
    },
    TiO: {
        label: 'TiO', name: 'Titanium oxide', phase: 'gas',
        bands: [
            edge(476.1, 18, 0.4), edge(495.4, 20, 0.5), edge(516.7, 25, 0.65), edge(544.8, 25, 0.55), edge(559.7, 22, 0.5),
            edge(615.9, 35, 0.75), edge(665.1, 30, 0.7), edge(705.4, 45, 1), edge(758.9, 45, 0.7), edge(843.2, 20, 0.4),
            edge(885.9, 30, 0.45), edge(1103.5, 40, 0.3), edge(1250, 30, 0.2)
        ]
    },
    C2: {
        label: 'C₂', name: 'Diatomic carbon', phase: 'gas',
        bands: [
            edge(438.2, 12, 0.3, -1), edge(473.7, 14, 0.7, -1), edge(516.5, 16, 1, -1), edge(563.5, 16, 0.75, -1),
            edge(612.2, 14, 0.35, -1), edge(1207, 40, 0.2), edge(1770, 60, 0.2)
        ]
    },
    CN: {
        label: 'CN', name: 'Cyanogen radical', phase: 'gas',
        bands: [
            edge(359, 8, 0.5, -1), edge(388.3, 8, 1, -1), edge(421.6, 8, 0.6, -1), edge(787.3, 25, 0.25), edge(914.1, 30, 0.35),
            edge(1087.5, 40, 0.4), edge(1460.6, 50, 0.3), rot(4900, 200, 0.3)
        ]
    },
    CH: {
        label: 'CH', name: 'Methylidyne radical', phase: 'gas',
        bands: [gauss(314.4, 3, 0.4), gauss(388, 4, 0.5), gauss(430.5, 3.5, 1), rot(3400, 300, 0.25)]
    },
    SO2: {
        label: 'SO₂', name: 'Sulfur dioxide', phase: 'gas',
        note: 'Its main infrared bands, at 7.3 and 8.7 µm, lie beyond this 5 µm axis. The UV bands (190 to 330 nm) and the weaker 4 µm band are the ones you can see here.',
        bands: [gauss(205, 30, 1), gauss(290, 50, 0.6), gauss(370, 30, 0.03), rot(3990, 60, 0.3)]
    },
    N2O: {
        label: 'N₂O', name: 'Nitrous oxide', phase: 'gas',
        note: 'It also has bands at 7.8 and 17 µm, beyond this 5 µm axis.',
        bands: [gauss(182, 30, 0.5), rot(2110, 15, 0.1), rot(2265, 20, 0.12), rot(2870, 30, 0.3), rot(3900, 40, 0.25), rot(4060, 30, 0.1), rot(4500, 90, 1)]
    },
    H2O_ice: {
        label: 'H₂O ice', name: 'Water ice', phase: 'ice',
        bands: [
            gauss(1040, 50, 0.15), gauss(1250, 80, 0.25), gauss(1500, 200, 0.7), gauss(1650, 30, 0.3), gauss(2020, 280, 0.9),
            gauss(3050, 500, 1), gauss(4500, 300, 0.15)
        ]
    },
    CH4_ice: {
        label: 'CH₄ ice', name: 'Methane ice', phase: 'ice',
        bands: [
            gauss(730, 15, 0.05), gauss(890, 15, 0.12), gauss(1000, 20, 0.15), gauss(1160, 25, 0.25), gauss(1380, 40, 0.35),
            gauss(1670, 30, 0.5), gauss(1720, 30, 0.6), gauss(2200, 50, 0.7), gauss(2320, 90, 1), gauss(2380, 40, 0.7),
            gauss(3300, 150, 1), gauss(3850, 60, 0.3)
        ]
    },
    N2_ice: {
        label: 'N₂ ice', name: 'Nitrogen ice', phase: 'ice',
        bands: [gauss(2150, 20, 1)]
    },
    CO_ice: {
        label: 'CO ice', name: 'Carbon monoxide ice', phase: 'ice',
        bands: [gauss(1579, 6, 0.2), gauss(2352, 8, 0.6), gauss(4674, 20, 1)]
    },
    MgH: {
        label: 'MgH', name: 'Magnesium hydride', phase: 'gas',
        bands: [edge(478, 25, 0.6, -1), edge(521.1, 40, 1, -1), edge(562.1, 25, 0.3, -1)]
    },
    CaH: {
        label: 'CaH', name: 'Calcium hydride', phase: 'gas',
        bands: [edge(638.9, 12, 0.5, -1), edge(694.6, 70, 1, -1)]
    },
    SiO: {
        label: 'SiO', name: 'Silicon monoxide', phase: 'gas',
        note: 'Its main infrared band, near 8 µm, lies beyond this 5 µm axis.',
        bands: [gauss(245, 40, 0.8), edge(4004, 300, 1)]
    }
};

// How much of a band's depth applies at wavelength wlNm, 0..1. Defines what each shape means, so the plots and the synthesis agree.
export function bandShape(band, wlNm) {
    if (band.shape === 'edge') {
        const t = ((wlNm - band.head) * band.dir) / band.w;
        if (t < 0 || t > 1) return 0;
        return (1 - t) ** 1.5;
    }
    const x = (wlNm - band.c) / band.w;
    if (band.shape === 'rot') {
        // Two lobes a quarter-width either side of centre, with a ripple standing in for individual rotational lines
        const lobes = Math.exp(-(((Math.abs(x) - 0.25) / 0.17) ** 2));
        return lobes * (0.8 + 0.2 * Math.cos(2 * Math.PI * 14 * x));
    }
    return Math.exp(-4 * Math.LN2 * x * x);
}

// The range a band shape affects, so a synthesis loop can skip the rest of the grid
export function bandRange(band) {
    if (band.shape === 'edge') {
        return band.dir > 0 ? [band.head, band.head + band.w] : [band.head - band.w, band.head];
    }
    return band.shape === 'rot' ? [band.c - band.w, band.c + band.w] : [band.c - 1.5 * band.w, band.c + 1.5 * band.w];
}
