// What the student has measured this session, so one tool's result can feed another: the Wien tool's temperature
// and the photometer's reading fill in the H-R diagram, the Doppler tool's speed fills in the Hubble plot.
// Kept in memory only: the simulation saves no progress (spec section 18).
//
// Keys in use: T_K, T_err_K, T_source ('wien'|'fit'|'standard'|'reference'|'typed'), flux_Wm2, flux_err, distance_pc, L_Lsun,
// L_err_Lsun, v_kms, v_err_kms, z, v_source ('slide'|'line')

import { bus } from './state.js';

const store = new Map();

export function recordMeasurement(code, values) {
    const next = { ...(store.get(code) || {}), ...values };
    store.set(code, next);
    bus.emit('measurement', { code, values: next });
    return next;
}

export function getMeasurement(code) {
    return store.get(code) || null;
}

export function allMeasurements() {
    return [...store.entries()].map(([code, values]) => ({ code, ...values }));
}
