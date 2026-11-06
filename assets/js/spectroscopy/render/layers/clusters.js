// FOUNDATION STUB, replaced by its track: open and globular clusters, with members to pick when zoomed in

import { createSoftDiscLayer } from './soft_discs.js';
import { ORDER } from '../shared.js';

export function createClustersLayer(engine, app) {
    return createSoftDiscLayer(engine, app, {
        id: 'clusters',
        kinds: ['cluster'],
        sizeDeg: (body) => body.cluster.radius_deg * 2,
        colour: [1, 0.9, 0.7],
        order: ORDER.clusters
    });
}
