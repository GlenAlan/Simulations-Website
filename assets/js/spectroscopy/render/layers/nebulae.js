// FOUNDATION STUB, replaced by its track: nebulae of every type

import { createSoftDiscLayer } from './soft_discs.js';
import { ORDER } from '../shared.js';

export function createNebulaeLayer(engine, app) {
    return createSoftDiscLayer(engine, app, {
        id: 'nebulae',
        kinds: ['nebula'],
        sizeDeg: (body) => body.nebula.size_deg,
        colour: [1, 0.3, 0.45],
        order: ORDER.nebulae
    });
}
