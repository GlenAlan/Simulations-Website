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

// ---------- A shift along the line of sight, said the same way everywhere ----------
// z always. While |z| is 0.1 or less, the speed v = cz beside it. Above 0.1, v = cz no longer applies (spec 8.4), so z alone,
// with that reason where there's room for it.

export const CZ_LIMIT = 0.1;
export const CZ_REASON = 'v = cz no longer applies above z = 0.1';

export function beyondCz(z) {
    return Math.abs(z) > CZ_LIMIT;
}

// "+0.0234", "+0.0000600": z as a plain decimal to n significant figures, signed
export function zPlain(z, n = 3) {
    if (!Number.isFinite(z)) return String(z);
    if (z === 0) return '0';
    const size = Math.abs(z);
    const places = Math.min(7, Math.max(1, n - 1 - Math.floor(Math.log10(size))));
    return `${z < 0 ? '−' : '+'}${size.toFixed(places)}`;
}

// "+18 km/s", "+7,020 km/s", "−2.4 km/s"
export function speedText(v) {
    if (!Number.isFinite(v)) return String(v);
    if (v === 0) return '0 km/s';
    const size = Math.abs(v);
    return `${v < 0 ? '−' : '+'}${size >= 1000 ? withCommas(size) : size.toFixed(size < 10 ? 1 : 0)} km/s`;
}

// "z = +0.0234, v = +7,020 km/s", or "z = +0.229 (v = cz no longer applies above z = 0.1)". v defaults to cz.
export function shiftWords(z, { v = z * C_KMS, n = 3, reason = true } = {}) {
    if (beyondCz(z)) return reason ? `z = ${zPlain(z, n)} (${CZ_REASON})` : `z = ${zPlain(z, n)}`;
    return `z = ${zPlain(z, n)}, v = ${speedText(v)}`;
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
