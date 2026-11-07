// The reference library's spectra (spec 10.3): always noise-free, and on the same lattice as a body's spectrum so the
// two line up pixel for pixel. Lamps give bright lines, molecules dark bands, standard stars their full spectrum.

import { C_KMS } from '../core/phys.js';
import { LINES } from '../data/lines.js';
import { MOLECULES } from '../data/molecules.js';
import { REFERENCE_GROUPS } from '../data/references.js';
import { STANDARDS } from '../data/standards.js';
import { bb, planckPeak, planckPeakInRange, makeProfile, addLine, mulBand } from './kernel.js';
import { renderStars } from './stellar.js';

function findItem(refId) {
    for (const group of REFERENCE_GROUPS) {
        const item = group.items.find((candidate) => candidate.id === refId);
        if (item) return item;
    }
    return null;
}

// The lines a lamp or ion reference shows: from its item in the library, or from the id's own species
function emissionListFor(refId, item) {
    if (item && item.lines) return item.lines.map((l) => ({ species: item.species || refId, ...l }));
    const tail = refId.slice(refId.indexOf(':') + 1);
    const names = item && item.species ? [].concat(item.species)
        : refId.startsWith('lamp:') ? [`${tail} I`, tail] : refId.startsWith('uv:') && tail === 'lyman' ? ['H I'] : [tail];
    const out = [];
    names.forEach((species) => {
        (LINES[species] || []).forEach((line) => out.push({ species, ...line }));
    });
    if (refId.startsWith('uv:')) return out.filter((l) => l.w < 300);
    return out;
}

function lampSpectrum(refId, item, grid, factor) {
    const list = emissionListFor(refId, item);
    const flux = new Float64Array(grid.n);
    const prof = makeProfile({ sigma: 2, R: grid.R });
    const lines = [];
    // Heights match the library's relative strengths when the instrument leaves them unresolved; the strongest line in view is 1
    const strongest = Math.max(1e-9, ...list.map((l) => l.s ?? 1));
    list.forEach((line) => {
        const rel = (line.s ?? 1) / strongest;
        const obs = line.w * factor;
        addLine(flux, grid, obs, rel / prof.peak, prof);
        if (obs >= grid.lo && obs <= grid.hi) {
            lines.push({ rest_nm: line.w, obs_nm: obs, species: line.species, label: line.label || line.species, depth: rel, type: 'em' });
        }
    });
    return { flux, continuum: new Float64Array(grid.n), lines, fRef: 1, snr: Infinity, mode: 'emission', note: '' };
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
    return { flux, continuum, lines, fRef: 1, snr: Infinity, mode: 'absorption', note: molecule ? '' : 'This molecule has no bands in the range.' };
}

function blackBodySpectrum(T, grid, factor) {
    const peak = planckPeak(T);
    const flux = new Float64Array(grid.n);
    for (let i = 0; i < grid.n; i++) flux[i] = bb(grid.wl[i] / factor, T) / peak;
    return { flux, continuum: flux, lines: [], fRef: planckPeakInRange(T) / peak, snr: Infinity, mode: 'thermal', note: '' };
}

function standardSpectrum(id, grid, factor) {
    const star = STANDARDS[id];
    if (!star) return null;
    const out = renderStars([{ star, factor, weight: 1, code: `std:${id}` }], grid);
    return { ...out, snr: Infinity, mode: 'absorption', note: '' };
}

export function buildReference(refId, grid, opts) {
    const factor = 1 + (opts.v_kms ?? 0) / C_KMS;
    const item = findItem(refId);
    if (refId === 'bb' || (item && item.kind === 'blackbody')) return blackBodySpectrum(opts.T ?? 5800, grid, factor);
    if (refId.startsWith('mol:')) return moleculeSpectrum(refId.slice(4), grid, factor);
    if (refId.startsWith('std:')) {
        return standardSpectrum(refId.slice(4), grid, factor) || blackBodySpectrum(opts.T ?? 5800, grid, factor);
    }
    return lampSpectrum(refId, item, grid, factor);
}
