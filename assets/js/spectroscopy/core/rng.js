// Seeded random numbers and object codes. Integer maths only, so every browser gets the same sequence.

export const DEFAULT_SEED = 'celestial-v1';

// A-Z and 2-9 without the easily confused 0, O, 1, I and L
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function isValidCode(code) {
    return typeof code === 'string' && code.length === 6 && [...code].every((c) => CODE_ALPHABET.includes(c));
}

// FNV-1a: turns a label such as a seed or object code into a 32-bit integer
export function hashString(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export class Rng {
    constructor(seed) {
        this.state = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0;
    }

    // mulberry32: uniform in [0, 1)
    next() {
        this.state = (this.state + 0x6d2b79f5) | 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    range(lo, hi) {
        return lo + (hi - lo) * this.next();
    }

    // Uniform in log space, for quantities that span orders of magnitude
    logRange(lo, hi) {
        return lo * (hi / lo) ** this.next();
    }

    int(lo, hi) { // Inclusive of both ends
        return lo + Math.floor(this.next() * (hi - lo + 1));
    }

    chance(p) {
        return this.next() < p;
    }

    pick(list) {
        return list[Math.floor(this.next() * list.length)];
    }

    // entries: [[value, weight], ...]
    weighted(entries) {
        const total = entries.reduce((sum, e) => sum + e[1], 0);
        let x = this.next() * total;
        for (const [value, weight] of entries) {
            x -= weight;
            if (x < 0) return value;
        }
        return entries[entries.length - 1][0];
    }

    gauss(mean = 0, sd = 1) {
        const u = 1 - this.next();
        const v = this.next();
        return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    shuffle(list) {
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(this.next() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
        return list;
    }

    // An independent stream, so that adding draws to one part of generation can't disturb another
    fork(label) {
        return new Rng(hashString(`${this.state}:${label}`));
    }

    code() {
        let out = '';
        for (let i = 0; i < 6; i++) out += CODE_ALPHABET[Math.floor(this.next() * CODE_ALPHABET.length)];
        return out;
    }
}

// Rounds a value from a transcendental function (pow, sin, log...) so a last-digit difference between
// browsers can't change a later comparison. Use it before comparing or storing such values in generation.
export function stable(x, digits = 6) {
    if (x === 0 || !Number.isFinite(x)) return x;
    return Number(x.toPrecision(digits));
}
