// One encoded block holding the hard-coded systems: a casual look through the page's files shouldn't give away what
// the student is meant to find by measuring it (spec 15.1). It stops searching, not a determined reader. The block is
// decoded in the browser at run time and used only by generation; it's the only place these values exist.
//
// A simple XOR stream keyed from the fixed seed, then base64. The key never changes with the sky's seed, so a
// different seed still gets the same hard-coded systems.

import { Rng, hashString, DEFAULT_SEED } from '../core/rng.js';

const BLOCK = [
    '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'
].join('');

// The two showcase systems and their stars keep these codes in every sky: they are meant to be famous
export const SHOWCASE_CODES = ['F8Q3ZN', 'F8Q3ZA', 'F8Q3ZB', 'F8Q3ZC', 'D2W7XK', 'D2W7XA', 'D2W7XB', 'D2W7XC', 'D2W7XD'];

// The hard-coded systems as they are in the sky made from this seed. In the standard sky they keep their own codes. In any
// other, their stars and planets take codes drawn from the seed like everything else's, so that comparing two skies can't
// pick them out: drawn from a stream of their own, clear of every reserved code, so the same seed always gives the same
// ones. codes then holds both sets, as no random code may take either.
export function unseal(seed = DEFAULT_SEED) {
    const bytes = atob(BLOCK);
    const rng = new Rng(hashString(`${DEFAULT_SEED}:sealed`));
    let text = '';
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes.charCodeAt(i) ^ Math.floor(rng.next() * 256));
    const data = JSON.parse(text);
    if (seed === DEFAULT_SEED) return data;
    const taken = new Set([...data.codes, ...SHOWCASE_CODES]);
    const stream = new Rng(seed).fork('codes:sealed');
    const fresh = new Map();
    data.codes.forEach((old) => {
        let code;
        do code = stream.code(); while (taken.has(code));
        taken.add(code);
        fresh.set(old, code);
    });
    const recode = (entity) => { entity.code = fresh.get(entity.code) || entity.code; };
    recode(data.target.host);
    data.target.planets.forEach(recode);
    data.decoys.forEach((decoy) => {
        recode(decoy.host);
        recode(decoy.planet);
    });
    data.codes = [...data.codes, ...fresh.values()];
    return data;
}
