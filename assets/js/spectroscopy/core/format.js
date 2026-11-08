// Number formatting shared by the panels. Values keep their units in plain text: "5,100 K", not "5100".

import { C_KMS } from './phys.js';

export function withCommas(x) {
    return Math.round(x).toLocaleString('en-AU');
}

// x to n significant figures, plain or in scientific notation for very large or small values
export function sig(x, n = 3) {
    if (x === 0 || !Number.isFinite(x)) return String(x);
    const abs = Math.abs(x);
    if (abs >= 1e6 || abs < 1e-3) return sci(x, n);
    const text = Number(x.toPrecision(n));
    return abs >= 1000 ? text.toLocaleString('en-AU') : String(text);
}

// "3.2 × 10⁻⁹"
export function sci(x, n = 2) {
    if (x === 0 || !Number.isFinite(x)) return String(x);
    const exp = Math.floor(Math.log10(Math.abs(x)));
    const mant = x / 10 ** exp;
    return `${Number(mant.toPrecision(n))} × 10${superscript(exp)}`;
}

const SUPER = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

export function superscript(n) {
    return [...String(n)].map((c) => SUPER[c]).join('');
}

// "5,100 ± 150" with the value rounded to the uncertainty's precision
export function plusMinus(value, err) {
    if (!(err > 0)) return sig(value, 4);
    const step = 10 ** Math.floor(Math.log10(err));
    const round = (x) => Math.round(x / step) * step;
    const digits = Math.max(0, -Math.floor(Math.log10(err)));
    const show = (x) => (digits > 0 ? x.toFixed(digits) : withCommas(x));
    return `${show(round(value))} ± ${show(Math.max(step, round(err)))}`;
}

// "+18 km/s" with its sign always shown, so a shift never relies on colour alone
export function signed(x, digits = 0) {
    const text = Math.abs(x).toFixed(digits);
    return `${x < 0 ? '−' : '+'}${text}`;
}

// ---------- A shift along the line of sight, said the same way everywhere: as a speed in km/s ----------
// Up to a shift z = Δλ/λ₀ of 0.1, about 30,000 km/s, the speed is v = cz. Beyond that v = cz no longer holds (spec 8.4), and for
// a quasar it would pass the speed of light, so the speed is the relativistic Doppler one, which stays below c, to 3 figures.
// Only what is shown changes: measurements, and the Hubble plot's speeds, stay cz.

export const CZ_LIMIT = 0.1;

export function beyondCz(z) {
    return Math.abs(z) > CZ_LIMIT;
}

// The speed a shift gives: cz up to the limit, and past it c((1+z)² − 1)/((1+z)² + 1)
export function speedOfShift(z) {
    if (!beyondCz(z)) return z * C_KMS;
    const s = (1 + z) ** 2;
    return (C_KMS * (s - 1)) / (s + 1);
}

// "+18 km/s", "+7,020 km/s", "−2.4 km/s"
export function speedText(v) {
    if (!Number.isFinite(v)) return String(v);
    if (v === 0) return '0 km/s';
    const size = Math.abs(v);
    return `${v < 0 ? '−' : '+'}${size >= 1000 ? withCommas(size) : size.toFixed(size < 10 ? 1 : 0)} km/s`;
}

// "+91,400 km/s": a speed to 3 significant figures
export function roundSpeedText(v) {
    if (!Number.isFinite(v)) return String(v);
    if (v === 0) return '0 km/s';
    return `${v < 0 ? '−' : '+'}${Number(Math.abs(v).toPrecision(3)).toLocaleString('en-AU')} km/s`;
}

// A shift as its speed: "+7,020 km/s" while v = cz holds, from v if given (an object's own catalogue speed) and cz if not, and
// "+91,400 km/s", to 3 figures, beyond it
export function shiftSpeed(z, v) {
    if (beyondCz(z)) return roundSpeedText(speedOfShift(z));
    return speedText(Number.isFinite(v) ? v : z * C_KMS);
}

// Which way: "moving away", "moving towards us"
export function shiftDirection(z) {
    if (z === 0) return 'neither towards nor away';
    return z > 0 ? 'moving away' : 'moving towards us';
}

// A wavelength in the unit that reads best: nm below 1 µm, µm above
export function wavelength(nm, digits = 1) {
    return nm >= 1000 ? `${(nm / 1000).toFixed(digits + 1)} µm` : `${nm.toFixed(digits)} nm`;
}

export function distance(pc) {
    if (pc >= 1e6) return `${sig(pc / 1e6, 3)} Mpc`;
    if (pc >= 1e3) return `${sig(pc / 1e3, 3)} kpc`;
    return `${sig(pc, 3)} pc`;
}

export function degrees(x, digits = 1) {
    return `${x.toFixed(digits)}°`;
}
