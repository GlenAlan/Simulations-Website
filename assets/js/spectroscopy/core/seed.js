// Which sky: the standard one, or another made from a seed in the page's address (?seed=...), so that a teacher can share a
// whole sky. A new seed changes where everything is and what the random bodies are like. The page reloads to change it,
// since every layer and panel is built from the sky at the start.

import { DEFAULT_SEED, CODE_ALPHABET } from './rng.js';

export const SEED_MAX_LENGTH = 32;

// A seed as typed or read from a link: no control characters, runs of space made one, trimmed, and not too long. Cleaning
// it again changes nothing, so a link made from a seed opens the same sky: the cut never leaves half of an emoji (a link
// can't carry half of one) or a space at the end (the link's own cleaning would trim it off).
export function cleanSeed(text) {
    return String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SEED_MAX_LENGTH)
        .replace(/[\ud800-\udbff]$/, '').trimEnd();
}

export function isDefaultSeed(seed) {
    return !seed || seed === DEFAULT_SEED;
}

// The seed in the page's address, or the standard one
export function seedFromPage() {
    try {
        return cleanSeed(new URLSearchParams(window.location.search).get('seed')) || DEFAULT_SEED;
    } catch (err) {
        return DEFAULT_SEED;
    }
}

// Puts the seed into a link, unless it is the standard sky's, which needs none
export function withSeed(url, seed) {
    if (isDefaultSeed(seed)) url.searchParams.delete('seed');
    else url.searchParams.set('seed', seed);
    return url;
}

// The page's address for a sky. Nothing else is carried over: an object's code means something else in another sky.
export function pageForSeed(seed) {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    return withSeed(url, cleanSeed(seed) || DEFAULT_SEED).href;
}

// Six letters and numbers after sky-, easy to read out to a class, and not to be taken for an object's code
export function randomSeed() {
    const values = new Uint32Array(6);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(values);
    else for (let i = 0; i < values.length; i++) values[i] = Math.floor(Math.random() * 4294967296);
    return `sky-${[...values].map((v) => CODE_ALPHABET[v % CODE_ALPHABET.length]).join('')}`;
}
