// The star systems the student has been into, kept through a reload so that a long search can pick up where it stopped.
// A private window or a blocked store simply forgets at the end of the visit: the list then lives in memory alone.
//
// app.visited = { has(code), count(), codes(), clear() }. Bus event sent: 'visited' { count }.

import { bus } from '../core/state.js';
import { isDefaultSeed } from '../core/seed.js';

const STORE_KEY = 'spectroscopy.visitedSystems';
let storeKey = STORE_KEY;          // Each sky keeps its own list (core/seed.js); the standard sky's keeps the old key

function load(universe) {
    storeKey = isDefaultSeed(universe.seed) ? STORE_KEY : `${STORE_KEY}.${universe.seed}`;
    try {
        const saved = JSON.parse(localStorage.getItem(storeKey) || '[]');
        return Array.isArray(saved) ? saved.filter((code) => typeof code === 'string' && universe.resolve(code)) : [];
    } catch (err) {
        return [];
    }
}

function save(codes) {
    try {
        if (codes.size) localStorage.setItem(storeKey, JSON.stringify([...codes]));
        else localStorage.removeItem(storeKey);
    } catch (err) { /* Blocked or full: it still works until the page closes */ }
}

export function createVisited(app) {
    const codes = new Set(load(app.universe));

    bus.on('view', ({ view, code }) => {
        if (view !== 'system' || !code || codes.has(code)) return;
        codes.add(code);
        save(codes);
        bus.emit('visited', { count: codes.size });
    });

    return {
        has: (code) => codes.has(code),
        count: () => codes.size,
        codes: () => [...codes],
        clear() {
            if (!codes.size) return;
            codes.clear();
            save(codes);
            bus.emit('visited', { count: 0 });
        }
    };
}
