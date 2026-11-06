// FOUNDATION STUB, replaced by its track: spiral, elliptical and irregular galaxies

import { createSoftDiscLayer } from './soft_discs.js';
import { ORDER } from '../shared.js';

export function createGalaxiesLayer(engine, app) {
    return createSoftDiscLayer(engine, app, {
        id: 'galaxies',
        kinds: ['galaxy'],
        sizeDeg: (body) => body.galaxy.size_deg,
        colour: [0.8, 0.8, 1],
        order: ORDER.galaxies
    });
}
