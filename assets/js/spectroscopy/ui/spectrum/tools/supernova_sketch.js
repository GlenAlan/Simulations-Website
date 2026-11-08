// A sketch of a supernova up close, drawn in a corner of its light curve, at the time the curve is showing. The picture is
// the curve's story, from the same numbers as the spectrum (spectra/supernova.js supernovaStage):
//   - Before first light, a type II's red supergiant. A type Ia's white dwarf is far too small to see: nothing.
//   - Then a fireball, its photosphere's colour its spectrum's temperature, blue-white cooling to orange, as bright as
//     the explosion's own light: a type II holds bright on its hydrogen plateau, then drops; a type Ia fades from the start.
//   - Outside it the ejecta, the gas thrown out, expanding at the speed of its fastest part. As it thins the photosphere
//     goes, and the gas glows in its emission lines: hydrogen red for a type II, iron's blue-green for a type Ia.
//   - What's left: a type II's neutron star at the centre. A type Ia leaves nothing.
// Sizes are true radii (the photosphere's speed, from its absorption lines, times the time since the explosion; the
// fastest gas's likewise) on a scale that compresses them by their logarithm, so that a star a few AU across and gas
// thousands of AU across both fit. Small and tucked in a corner of the plot, it can't flash over a wide area.

import { blackBodyRGB } from '../../../core/phys.js';
import { hashString, Rng } from '../../../core/rng.js';
import { supernovaStage } from '../../../spectra/supernova.js';

const DAY_S = 86400;
const R_SUPERGIANT_CM = 4.2e13;     // A red supergiant about to explode: some 600 times the Sun's radius
const SUPERGIANT_K = 3600;
const R_LO_CM = 9e12;               // The scale: radius as a share of the sketch's half-width is K_LOG x log10(R / R_LO)
const K_LOG = 0.242;
const LARGEST = 0.95;
const SMALLEST_PX = 44;             // Below this the sketch isn't drawn
const LARGEST_PX = 104;
const BALL_LIGHT = 0.42;            // The photosphere at peak, in linear light: under white, so its colour shows
const EJECTA = { Ia: [0.42, 0.85, 0.78], II: [1.0, 0.28, 0.36] };    // The lines the thinned gas glows in, linear RGB

function toCss(rgb, alpha = 1) {
    const enc = (v) => Math.round(255 * Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
    return `rgba(${enc(rgb[0])}, ${enc(rgb[1])}, ${enc(rgb[2])}, ${alpha})`;
}

const scaled = (rgb, k) => [rgb[0] * k, rgb[1] * k, rgb[2] * k];

function shareOf(radiusCm) {
    if (!(radiusCm > R_LO_CM)) return 0;
    return Math.min(LARGEST, K_LOG * Math.log10(radiusCm / R_LO_CM));
}

// A ball of light, brighter to the middle as a star's disc is, with a soft rim
function ball(ctx, x, y, r, rgb, light) {
    if (r <= 0.3 || light <= 0.002) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.12);
    g.addColorStop(0, toCss(scaled(rgb, light)));
    g.addColorStop(0.62, toCss(scaled(rgb, light * 0.78)));
    g.addColorStop(0.88, toCss(scaled(rgb, light * 0.5)));
    g.addColorStop(1, toCss(scaled(rgb, light * 0.5), 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.12, 0, Math.PI * 2);
    ctx.fill();
}

// A soft halo round something bright, as a camera records it
function halo(ctx, x, y, r, rgb, light) {
    if (light <= 0.002) return;
    const g = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 1.9);
    g.addColorStop(0, toCss(scaled(rgb, light), 0.55));
    g.addColorStop(1, toCss(scaled(rgb, light), 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.9, 0, Math.PI * 2);
    ctx.fill();
}

// The gas: brightest towards its edge, where a line of sight passes through the most of a thick shell, with clumps. inner:
// how bright its middle is against its edge, low while a photosphere fills the middle
function shell(ctx, x, y, r, rgb, light, clumps, inner) {
    if (r <= 0.5 || light <= 0.002) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, toCss(scaled(rgb, light * inner)));
    g.addColorStop(0.7, toCss(scaled(rgb, light * (0.3 + inner))));
    g.addColorStop(0.92, toCss(scaled(rgb, light)));
    g.addColorStop(1, toCss(scaled(rgb, light), 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (inner > 0.05) clumps.forEach(({ angle, at, size, k }) => {
        const cx = x + Math.cos(angle) * at * r;
        const cy = y + Math.sin(angle) * at * r;
        const s = size * r;
        const c = ctx.createRadialGradient(cx, cy, 0, cx, cy, s);
        c.addColorStop(0, toCss(scaled(rgb, light * k), 0.6));
        c.addColorStop(1, toCss(scaled(rgb, light * k), 0));
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(cx, cy, s, 0, Math.PI * 2);
        ctx.fill();
    });
}

// Each supernova's own faint stars behind it and clumps in its gas, the same every time it's drawn
function lookOf(code) {
    const rng = new Rng(hashString(`${code}:sketch`));
    const stars = Array.from({ length: 12 }, () => ({ x: rng.next(), y: rng.next(), light: rng.range(0.05, 0.22) }));
    const clumps = Array.from({ length: 9 }, () => ({ angle: rng.range(0, Math.PI * 2), at: rng.range(0.55, 0.9), size: rng.range(0.12, 0.24), k: rng.range(0.2, 0.45) }));
    return { stars, clumps };
}

const looks = new Map();

// Where the sketch goes: the top right corner of the plot, where the curve has long since fallen. Null if there's no room.
export function sketchBox(rect) {
    const size = Math.floor(Math.min(rect.h - 12, rect.w * 0.3, LARGEST_PX));
    if (size < SMALLEST_PX) return null;
    return { x: rect.x + rect.w - size - 6, y: rect.y + 6, size };
}

// Draws the supernova body at time t (days from now, as its spectrum takes it) into box
export function drawSupernovaSketch(ctx, box, body, t, theme) {
    const sn = body.supernova;
    const ia = sn.type === 'Ia';
    const stage = supernovaStage(body, t);
    if (!looks.has(body.code)) looks.set(body.code, lookOf(body.code));
    const look = looks.get(body.code);
    const { x: x0, y: y0, size } = box;
    const half = size / 2;
    const cx = x0 + half;
    const cy = y0 + half;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, size, size);
    ctx.fillStyle = '#04060b';
    ctx.fill();
    ctx.clip();
    look.stars.forEach((s) => {
        ctx.fillStyle = toCss([s.light, s.light, s.light * 1.1]);
        ctx.fillRect(x0 + s.x * size, y0 + s.y * size, 1, 1);
    });
    // Light adds to light: thin gas glows through a fading photosphere
    ctx.globalCompositeOperation = 'lighter';

    if (!stage.exploded) {
        // A type II's red supergiant; a type Ia's white dwarf can't be seen
        if (!ia) {
            const r = shareOf(R_SUPERGIANT_CM) * half;
            const rgb = blackBodyRGB(SUPERGIANT_K);
            halo(ctx, cx, cy, r, rgb, 0.25);
            ball(ctx, cx, cy, r, rgb, 0.85);
        }
    } else {
        const seconds = Math.max(stage.days, 0) * DAY_S;
        const start = ia ? 0 : R_SUPERGIANT_CM;
        const ejecta = shareOf(start + stage.outerSpeed * 1e5 * seconds) * half;
        const photosphere = Math.min(shareOf(start + stage.speed * 1e5 * seconds) * half, ejecta * 0.97);
        // The photosphere's own light: the explosion's, going as the gas thins and its continuum gives way to lines. Held
        // below white, so that its colour shows.
        const light = BALL_LIGHT * Math.sqrt(Math.max(0, stage.light)) * stage.continuum;
        const glowing = stage.nebular * (0.3 - 0.14 * Math.min(1, Math.max(0, (stage.phase - 150) / 350)));
        const lines = EJECTA[ia ? 'Ia' : 'II'];
        // The gas, faint while the photosphere outshines it, then all there is
        shell(ctx, cx, cy, ejecta, lines, 0.05 + glowing, look.clumps, 0.4 * stage.nebular);
        // The supergiant, for the hours before the fireball swallows it
        if (!ia && photosphere < shareOf(R_SUPERGIANT_CM) * half * 1.05) ball(ctx, cx, cy, shareOf(R_SUPERGIANT_CM) * half, blackBodyRGB(SUPERGIANT_K), 0.85);
        const rgb = blackBodyRGB(stage.T);
        halo(ctx, cx, cy, photosphere, rgb, 0.4 * light);
        ball(ctx, cx, cy, photosphere, rgb, light);
        // What's left of a type II: its neutron star, once the gas is thin enough to see in
        if (!ia && stage.nebular > 0.05) {
            const on = Math.min(1, stage.nebular * 1.4);
            halo(ctx, cx, cy, 1.4, [0.75, 0.85, 1], 0.6 * on);
            ctx.fillStyle = toCss([0.85, 0.92, 1], on);
            ctx.beginPath();
            ctx.arc(cx, cy, 1.4, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.restore();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, size - 1, size - 1);
}

// The same moment in words, for a screen reader
export function sketchWords(body, t) {
    const ia = body.supernova.type === 'Ia';
    const s = supernovaStage(body, t);
    if (!s.exploded) return ia ? 'Before the explosion: nothing to see yet.' : 'Before the explosion: a red supergiant.';
    if (s.phase < 0) return 'A hot, blue-white fireball, expanding and brightening.';
    if (s.continuum > 0.6) return ia ? 'The fireball fading and cooling.' : 'The fireball, cooled to orange, holding bright on its plateau.';
    if (s.continuum > 0.12) return 'The fireball fading as its gas thins out.';
    return ia ? 'An expanding shell of glowing gas, with nothing left at the centre.' : 'An expanding shell of glowing gas, with a neutron star left at the centre.';
}
