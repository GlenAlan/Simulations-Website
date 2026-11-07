// The reference library's spectra (spec 10.3): always noise-free, and on the same lattice as a body's spectrum so the
// two line up pixel for pixel. Lamps give bright lines, molecules dark bands, standard stars their full spectrum.

import { C_KMS } from '../core/phys.js';
import { LINES } from '../data/lines.js';
import { MOLECULES } from '../data/molecules.js';
import { getReference } from '../data/references.js';
import { STANDARDS } from '../data/standards.js';
import { bb, planckPeak, planckPeakInRange, makeProfile, addLine, mulBand } from './kernel.js';
import { renderStars } from './stellar.js';

// The lines a lamp, ion or UV reference shows. A UV item names just the wavelengths it is about.
function emissionListFor(item) {
    const all = LINES[item.species] || [];
    if (!item.lines) return all;
    return item.lines
        .map((w) => all.reduce((best, line) => (Math.abs(line.w - w) < Math.abs(best.w - w) ? line : best), { w: Infinity }))
        .filter((line) => Number.isFinite(line.w));
}

function lampSpectrum(item, grid, factor) {
    const list = emissionListFor(item);
    const flux = new Float64Array(grid.n);
    const prof = makeProfile({ sigma: 2, R: grid.R });
    const lines = [];
    // s is cube-root compressed, so a thin lamp's brightness goes as s cubed
    const strongest = Math.max(1e-9, ...list.map((l) => (l.s ?? 1) ** 3));
    list.forEach((line) => {
        const rel = (line.s ?? 1) ** 3 / strongest;
        const obs = line.w * factor;
        addLine(flux, grid, obs, rel / prof.peak, prof);
        if (obs >= grid.lo && obs <= grid.hi) {
            lines.push({ rest_nm: line.w, obs_nm: obs, species: item.species, label: line.label || `${item.species} ${line.w.toFixed(1)}`, depth: rel, type: 'em' });
        }
    });
    return { flux, continuum: new Float64Array(grid.n), lines, fRef: 1, snr: Infinity, mode: 'emission', note: item.note || '' };
}

function moleculeSpectrum(key, grid, factor) {
    const molecule = MOLECULES[key];
    const flux = new Float64Array(grid.n).fill(1);
    const continuum = new Float64Array(grid.n).fill(1);
    const lines = [];
    if (molecule) {
        molecule.bands.forEach((band) => {
            mulBand(flux, grid, band, 1, factor);
            const obs = band.c * factor;
            if (obs >= grid.lo && obs <= grid.hi) {
                lines.push({ rest_nm: band.c, obs_nm: obs, species: key, label: molecule.label || key, depth: band.d ?? 1, type: 'abs', band: true, width_nm: band.w });
            }
        });
    }
    return { flux, continuum, lines, fRef: 1, snr: Infinity, mode: 'absorption', note: molecule && molecule.note ? molecule.note : '' };
}

function blackBodySpectrum(T, grid, factor) {
    const peak = planckPeak(T);
    const flux = new Float64Array(grid.n);
    for (let i = 0; i < grid.n; i++) flux[i] = bb(grid.wl[i] / factor, T) / peak;
    return { flux, continuum: flux, lines: [], fRef: planckPeakInRange(T) / peak, snr: Infinity, mode: 'thermal', note: '' };
}

function standardSpectrum(id, grid, factor) {
    const out = renderStars([{ star: STANDARDS[id], factor, weight: 1, code: `std:${id}` }], grid);
    return { ...out, snr: Infinity, mode: 'absorption', note: '' };
}

export function buildReference(refId, grid, opts) {
    const factor = 1 + (opts.v_kms ?? 0) / C_KMS;
    const item = getReference(refId);
    const fallbackT = opts.T ?? (item && item.T_default_K) ?? 5800;
    if (!item || item.kind === 'blackbody') return blackBodySpectrum(fallbackT, grid, factor);
    if (item.kind === 'molecule') return moleculeSpectrum(item.molecule, grid, factor);
    if (item.kind === 'standard') return standardSpectrum(item.standard, grid, factor);
    return lampSpectrum(item, grid, factor);
}
