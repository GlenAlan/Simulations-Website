// The star systems the student has been into, kept through a reload so that a long search can pick up where it stopped.
// A private window or a blocked store simply forgets at the end of the visit: the list then lives in memory alone.
//
// app.visited = { has(code), count(), codes(), clear() }. Bus event sent: 'visited' { count }.

import { bus } from '../core/state.js';

const STORE_KEY = 'spectroscopy.visitedSystems';

function load(universe) {
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
        return Array.isArray(saved) ? saved.filter((code) => typeof code === 'string' && universe.resolve(code)) : [];
    } catch (err) {
        return [];
    }
}

function save(codes) {
    try {
        if (codes.size) localStorage.setItem(STORE_KEY, JSON.stringify([...codes]));
        else localStorage.removeItem(STORE_KEY);
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
