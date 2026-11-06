// FOUNDATION STUB, replaced by its track: comas with dust and ion tails

import { createSoftDiscLayer } from './soft_discs.js';
import { ORDER } from '../shared.js';

export function createCometsLayer(engine, app) {
    return createSoftDiscLayer(engine, app, {
        id: 'comets',
        kinds: ['comet'],
        sizeDeg: (body) => body.comet.tail_deg * 0.3,
        colour: [0.7, 0.9, 1],
        order: ORDER.comets
    });
}
