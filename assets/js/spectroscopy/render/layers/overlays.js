// What's drawn over the sky rather than in it: the selection marker, labels, the alt-az grid, the galactic band's edges,
// the red/blue shift tint and the keyboard reticle. All of it goes on one 2D canvas above the WebGL canvas, so it stays
// crisp at any zoom, needs no per-object textures, and costs nothing while the view isn't changing.

import { bus } from '../../core/state.js';
import { GALACTIC_POLE, azAltToVec3, vec3ToAzAlt } from '../../core/sky.js';
import { drawMag, parallaxFactor } from '../../core/depth.js';
import { signed, withCommas } from '../../core/format.js';
import { memberDirection } from './sky_tangent.js';

const RAD = Math.PI / 180;
const BAND_EDGE_DEG = 14;          // How far either side of the galactic plane the highlight's edges sit
const GRID_STEPS = [30, 15, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05];
const LABEL_FONT = '11px "Source Sans Pro", system-ui, sans-serif';
const SHIFT_FONT = '700 11px "Source Sans Pro", system-ui, sans-serif';
const LINE_H = 13;
const LABEL_GAP = 6;               // Spare room kept around a label so they never touch
const AREA_PER_LABEL = 32000;      // CSS pixels of sky for each label: the budget thins them at wide zoom

// Two colours that stay distinct under colour blindness, with light values that read on the night sky
const RED_SHIFT = { text: '#ffab91', rgb: '255, 120, 80' };
const BLUE_SHIFT = { text: '#9fcbff', rgb: '90, 165, 255' };

const COMPASS = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

function gridStep(fov) {
    const wanted = fov / 6;
    for (let i = GRID_STEPS.length - 1; i >= 0; i--) {
        if (GRID_STEPS[i] >= wanted) return GRID_STEPS[i];
    }
    return GRID_STEPS[0];
}

function stepDigits(step) {
    if (step >= 1) return 0;
    return step >= 0.1 ? 1 : 2;
}

// How far an object spreads on the sky, for a ring that goes round it rather than through it
function angularRadiusDeg(entity, body) {
    if (entity !== body) return 0;
    if (body.nebula) return body.nebula.size_deg / 2;
    if (body.galaxy) return body.galaxy.size_deg / 2;
    if (body.cluster) return body.cluster.radius_deg;
    if (body.supernova) return body.supernova.shell_deg || 0;
    if (body.comet) return body.comet.coma_deg || 0;
    return 0;
}

function shiftWords(body) {
    const z = body.quasar ? body.quasar.z : (body.galaxy ? body.galaxy.z : null);
    const v = body.radial_velocity_kms;
    // Above z of about 0.1, v = cz no longer holds, so the shift itself is shown (spec 8.4)
    if (z !== null && z !== undefined && Math.abs(z) >= 0.1) return `z = ${signed(z, 2)}`;
    if (!Number.isFinite(v)) return null;
    const speed = Math.abs(v) >= 1000 ? withCommas(Math.abs(v)) : Math.abs(v).toFixed(0);
    if (speed === '0') return '0 km/s';     // Neither towards us nor away
    return `${v < 0 ? '−' : '+'}${speed} km/s`;
}

// A soft disc, drawn once for each colour and stamped at any size
function makeHalo(rgb) {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, `rgba(${rgb}, 0.65)`);
    grad.addColorStop(0.55, `rgba(${rgb}, 0.28)`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
}

// A soft dark tag to put behind a label, drawn once and stretched to fit. Over dark sky it can't be seen. Over the bright
// band it keeps 11 px text above 4.5:1, which a shadow alone couldn't. Soft all round, so that it never looks like a box.
const BACKING_R = 6;
function makeBacking() {
    const size = BACKING_R * 2 + 2;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    g.filter = 'blur(1.5px)';
    g.fillStyle = 'rgba(3, 5, 12, 0.72)';
    g.beginPath();
    g.roundRect(2, 2, size - 4, size - 4, BACKING_R - 2);
    g.fill();
    return c;
}

export function createOverlaysLayer(engine, app) {
    const canvas = document.createElement('canvas');
    canvas.className = 'spectro-overlay-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const host = document.getElementById('spectroOverlay');
    if (host) host.prepend(canvas);
    const ctx = canvas.getContext('2d');

    const haloRed = makeHalo(RED_SHIFT.rgb);
    const haloBlue = makeHalo(BLUE_SHIFT.rgb);
    const backing = makeBacking();
    const taken = [];       // Where the labels drawn so far this time are, so that none lands on another

    let reticle = { on: false, code: null };
    bus.on('reticle', (next) => { reticle = next; });

    // Direction of every body, worked out once: testing "is it in front of the camera" this way is much cheaper than projecting
    let dirs = null;
    function bodyDirs() {
        if (dirs) return dirs;
        dirs = app.universe.bodies.map((body) => ({ body, dir: azAltToVec3(body.sky.az, body.sky.alt) }));
        return dirs;
    }

    // Brightest first in the band on show, so the labels that survive are the ones worth having; home planets lead
    let rankedBand = null;
    let ranked = [];
    function rankedBodies(band) {
        if (band === rankedBand) return ranked;
        rankedBand = band;
        const score = ({ body }) => {
            if (body.kind === 'home_planet') return 1e6 - drawMag(body);
            if (band === 'visible') return -drawMag(body);
            return (body.bands[band] || 0) * 100 - drawMag(body) * 0.01;
        };
        ranked = bodyDirs().slice().sort((a, b) => score(b) - score(a));
        return ranked;
    }

    function selectedPosition() {
        const sel = app.selected;
        if (!sel) return null;
        const { entity, body, path } = sel;
        if (path === 'member' && entity.offset_deg) return memberDirection(body, entity);
        return body.sky;
    }

    // The grid and the band's edges are drawn on the dome, at depth 1
    function strokeLine(points, style) {
        // Break the line where it goes behind the camera, so it never jumps across the screen
        let drawing = false;
        ctx.beginPath();
        points.forEach(({ az, alt }) => {
            const p = engine.project(az, alt, 1);
            if (!p) {
                drawing = false;
                return;
            }
            if (drawing) ctx.lineTo(p.x, p.y);
            else ctx.moveTo(p.x, p.y);
            drawing = true;
        });
        ctx.strokeStyle = style;
        ctx.stroke();
    }

    // The first spot along a line that's clear of the bars at the edges, for its label
    function labelSpot(points, frame, inset) {
        for (let i = 0; i < points.length; i++) {
            const p = engine.project(points[i].az, points[i].alt, 1);
            if (p && p.x > 8 && p.x < frame.width - 44 && p.y > inset.top + 30 && p.y < frame.height - inset.bottom) return p;
        }
        return null;
    }

    function drawText(text, x, y, style) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.fillText(text, x + 1, y + 1);
        ctx.fillStyle = style;
        ctx.fillText(text, x, y);
    }

    // Behind a box of text. Nine slices, so that the corners stay soft however it's stretched
    function drawBacking(x, y, w, h) {
        const r = BACKING_R;
        const m = backing.width - 2 * r;
        const x0 = x - 4;
        const y0 = y - 3;
        const midW = w + 8;
        const midH = h + 6;
        for (let row = 0; row < 3; row++) {
            const sy = row === 0 ? 0 : row === 1 ? r : r + m;
            const sh = row === 1 ? m : r;
            const dy = row === 0 ? y0 - r : row === 1 ? y0 : y0 + midH;
            const dh = row === 1 ? midH : r;
            ctx.drawImage(backing, 0, sy, r, sh, x0 - r, dy, r, dh);
            ctx.drawImage(backing, r, sy, m, sh, x0, dy, midW, dh);
            ctx.drawImage(backing, r + m, sy, r, sh, x0 + midW, dy, r, dh);
        }
    }

    // A label with no job but to be read: dropped if it would land on one already there. x, y as for left and middle
    function placeLabel(text, x, y, style) {
        const w = ctx.measureText(text).width;
        const rect = { x: x - 3, y: y - LINE_H / 2 - 3, w: w + 6, h: LINE_H + 6 };
        if (!clearOfTaken(rect)) return false;
        taken.push(rect);
        drawBacking(x, y - LINE_H / 2, w, LINE_H);
        drawText(text, x, y, style);
        return true;
    }

    function clearOfTaken(r) {
        for (let i = 0; i < taken.length; i++) {
            const q = taken[i];
            if (!(r.x > q.x + q.w || r.x + r.w < q.x || r.y > q.y + q.h || r.y + r.h < q.y)) return false;
        }
        return true;
    }

    // How much of the dome is on show: more than the field of view says, as it's as far back as anything can be
    function domeFov(fov) {
        return fov / parallaxFactor(1, fov);
    }

    function drawGrid(frame, view, inset) {
        const fov = domeFov(view.fov);
        const step = gridStep(fov);
        const azStep = step * (view.alt > 65 ? 2 : 1);
        const digits = stepDigits(step);
        const reach = Math.min(180, Math.hypot(fov, fov * (frame.width / frame.height)) * 0.62);
        const lineStyle = 'rgba(170, 200, 255, 0.26)';
        const textStyle = 'rgba(205, 222, 255, 0.92)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.font = LABEL_FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        // Altitude: circles round the horizon, labelled near the left edge
        const altLo = Math.max(0, Math.ceil((view.alt - reach) / step) * step);
        const altHi = Math.min(85, view.alt + reach);
        for (let alt = altLo; alt <= altHi + 1e-6; alt += step) {
            const span = Math.min(180, reach / Math.max(0.05, Math.cos(alt * RAD)));
            const points = [];
            for (let i = 0; i <= 64; i++) points.push({ az: view.az - span + (2 * span * i) / 64, alt });
            strokeLine(points, lineStyle);
            const spot = labelSpot(points, frame, inset);
            if (spot) placeLabel(`${alt.toFixed(digits)}°`, spot.x + 3, spot.y - 7, textStyle);
        }

        // Azimuth: lines up from the horizon, labelled near the bottom edge, with the compass points named
        const topAlt = Math.min(85, view.alt + reach);
        const azReach = topAlt >= 80 ? 180 : Math.min(180, reach / Math.max(0.05, Math.cos(topAlt * RAD)));
        const azLo = Math.ceil((view.az - azReach) / azStep) * azStep;
        const altStart = Math.max(0, view.alt - reach);
        for (let az = azLo; az <= view.az + azReach + 1e-6; az += azStep) {
            const points = [];
            for (let i = 0; i <= 40; i++) points.push({ az, alt: altStart + ((topAlt - altStart) * i) / 40 });
            strokeLine(points, lineStyle);
            const spot = labelSpot(points, frame, inset);
            if (spot) {
                const wrapped = ((az % 360) + 360) % 360;
                const name = COMPASS[Math.round(wrapped * 100) / 100];
                placeLabel(`${wrapped.toFixed(digits)}°${name ? ` ${name}` : ''}`, spot.x + 3, spot.y - 7, textStyle);
            }
        }
    }

    function drawGalacticBand(frame, view, inset) {
        // An orthonormal frame on the band's plane, so a point can be named by galactic longitude and latitude
        const p = azAltToVec3(GALACTIC_POLE.az, GALACTIC_POLE.alt);
        const u = [p[1], -p[0], 0];
        const uLen = Math.hypot(u[0], u[1], u[2]);
        u[0] /= uLen;
        u[1] /= uLen;
        const v = [p[1] * u[2] - p[2] * u[1], p[2] * u[0] - p[0] * u[2], p[0] * u[1] - p[1] * u[0]];
        const pointAt = (lonDeg, latDeg) => {
            const cl = Math.cos(latDeg * RAD);
            const sl = Math.sin(latDeg * RAD);
            const co = Math.cos(lonDeg * RAD);
            const so = Math.sin(lonDeg * RAD);
            return vec3ToAzAlt(
                cl * (u[0] * co + v[0] * so) + sl * p[0],
                cl * (u[1] * co + v[1] * so) + sl * p[1],
                cl * (u[2] * co + v[2] * so) + sl * p[2]
            );
        };

        // Sample only the stretch near the view, so the lines stay smooth when zoomed far in
        const c = azAltToVec3(view.az, view.alt);
        const centreLon = Math.atan2(c[0] * v[0] + c[1] * v[1] + c[2] * v[2], c[0] * u[0] + c[1] * u[1] + c[2] * u[2]) / RAD;
        const fov = domeFov(view.fov);
        const span = Math.min(180, Math.hypot(fov, fov * (frame.width / frame.height)) * 0.9 + BAND_EDGE_DEG);

        const lineFor = (latDeg) => {
            const points = [];
            for (let i = 0; i <= 96; i++) points.push(pointAt(centreLon - span + (2 * span * i) / 96, latDeg));
            return points;
        };

        ctx.lineWidth = 1;
        ctx.setLineDash([7, 7]);
        [-BAND_EDGE_DEG, BAND_EDGE_DEG].forEach((lat) => {
            // Only the part above the horizon: the ground hides the rest
            let run = [];
            lineFor(lat).forEach((point) => {
                if (point.alt >= 0) run.push(point);
                else if (run.length) {
                    strokeLine(run, 'rgba(255, 228, 170, 0.5)');
                    run = [];
                }
            });
            if (run.length) strokeLine(run, 'rgba(255, 228, 170, 0.5)');
        });
        ctx.setLineDash([]);

        const middle = lineFor(0).filter((point) => point.alt >= 2);
        const spot = labelSpot(middle, frame, inset);
        if (spot) {
            ctx.font = LABEL_FONT;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            placeLabel('Galactic band', spot.x + 4, spot.y, 'rgba(255, 232, 186, 0.95)');
        }
    }

    // The bodies worth marking, placed brightest first. A label that would touch one already placed is dropped, and
    // because the order is fixed the same ones survive from frame to frame as the view pans.
    function drawObjectMarks(frame, view, inset, showLabels, showShift) {
        const forward = azAltToVec3(view.az, view.alt);
        // Wide enough for the furthest things, which are drawn nearer the middle than the camera has them
        const halfDiagonal = Math.min(89, Math.atan(Math.tan(view.fov * RAD / 2) / parallaxFactor(1, view.fov) * Math.hypot(1, frame.width / frame.height)) / RAD + 1);
        const cosLimit = Math.cos(halfDiagonal * RAD);
        const budget = Math.max(5, Math.round((frame.width * frame.height) / AREA_PER_LABEL));
        const firstOwn = taken.length;

        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.setLineDash([]);

        const list = rankedBodies(frame.band);
        for (let i = 0; i < list.length && taken.length - firstOwn < budget; i++) {
            const { body, dir } = list[i];
            if (dir[0] * forward[0] + dir[1] * forward[1] + dir[2] * forward[2] < cosLimit) continue;
            if (!engine.bodyShows(body)) continue;
            const p = engine.projectBody(body);
            if (!p || !p.onScreen) continue;
            if (p.y < inset.top || p.y > frame.height - inset.bottom) continue;

            const name = showLabels ? (body.name || body.code) : null;
            const shift = showShift && body.kind !== 'home_planet' ? shiftWords(body) : null;
            if (!name && !shift) continue;
            const v = body.radial_velocity_kms;
            const shiftText = shift ? (shift === '0 km/s' ? shift : `${v >= 0 ? '→' : '←'} ${shift}`) : null;

            ctx.font = LABEL_FONT;
            const nameW = name ? ctx.measureText(name).width : 0;
            ctx.font = SHIFT_FONT;
            const shiftW = shiftText ? ctx.measureText(shiftText).width : 0;
            const lines = (name ? 1 : 0) + (shiftText ? 1 : 0);
            const w = Math.max(nameW, shiftW);
            const h = lines * LINE_H;
            const offset = 13;
            let x = p.x + offset;
            if (x + w > frame.width - 6) x = p.x - offset - w; // Flip to the left near the right edge
            const y = p.y - h / 2;
            const rect = { x: x - LABEL_GAP, y: y - LABEL_GAP, w: w + LABEL_GAP * 2, h: h + LABEL_GAP * 2 };
            if (!clearOfTaken(rect)) continue;
            taken.push(rect);

            if (shift) {
                const halo = v >= 0 ? haloRed : haloBlue;
                const strength = Math.min(1, Math.sqrt(Math.abs(v) / 300));
                const r = 10 + 12 * strength;
                ctx.globalAlpha = 0.45 + 0.55 * strength;
                ctx.drawImage(halo, p.x - r, p.y - r, r * 2, r * 2);
                ctx.globalAlpha = 1;
            }
            drawBacking(x, y, w, h);
            let line = y + LINE_H / 2;
            if (name) {
                ctx.font = LABEL_FONT;
                drawText(name, x, line, body.kind === 'home_planet' ? 'rgba(255, 255, 255, 0.98)' : 'rgba(226, 232, 245, 0.9)');
                line += LINE_H;
            }
            if (shiftText) {
                ctx.font = SHIFT_FONT;
                drawText(shiftText, x, line, v >= 0 ? RED_SHIFT.text : BLUE_SHIFT.text);
            }
        }
    }

    function drawSelection(frame) {
        const at = selectedPosition();
        if (!at) return;
        const { entity, body } = app.selected;
        const p = engine.project(at.az, at.alt, body.depth);
        if (!p || !p.onScreen) return;
        const spread = angularRadiusDeg(entity, body) * RAD * (frame.pxPerRad / frame.dpr) * parallaxFactor(body.depth, frame.fov);
        const r = Math.max(13, Math.min(spread * 1.08, Math.min(frame.width, frame.height) * 0.42));
        const tickFrom = r;
        const tickTo = r + 7;
        const co = Math.SQRT1_2;

        const trace = () => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.moveTo(p.x + co * tickFrom, p.y - co * tickFrom);
            ctx.lineTo(p.x + co * tickTo, p.y - co * tickTo);
        };
        ctx.setLineDash([]);
        // A dark edge keeps the ring visible over a bright nebula
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        trace();
        ctx.stroke();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = '#ffffff';
        trace();
        ctx.stroke();
    }

    function drawReticle(frame) {
        const cx = frame.width / 2;
        const cy = frame.height / 2;
        const gap = 9;
        const len = 7;
        const trace = () => {
            ctx.beginPath();
            [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
                ctx.moveTo(cx + dx * gap, cy + dy * gap);
                ctx.lineTo(cx + dx * (gap + len), cy + dy * (gap + len));
            });
        };
        ctx.setLineDash([]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        trace();
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        trace();
        ctx.stroke();
        if (reticle.code) {
            ctx.font = LABEL_FONT;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const w = ctx.measureText(reticle.code).width;
            drawBacking(cx - w / 2, cy + gap + len + 5, w, LINE_H);
            drawText(reticle.code, cx, cy + gap + len + 5, 'rgba(255, 255, 255, 0.95)');
        }
    }

    // Keep out from under the bars. Below this width the band switcher drops to a second row (see the CSS).
    function barInsets(frame) {
        return { top: frame.width < 720 ? 112 : 60, bottom: 60 };
    }

    let lastKey = '';

    return {
        id: 'overlays',
        update(frame) {
            const view = engine.getView();
            const layers = app.layers;
            const inSky = frame.view === 'sky';
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
            const key = [
                view.az.toFixed(4), view.alt.toFixed(4), view.fov.toFixed(4), frame.width, frame.height, pixelRatio, frame.band, inSky,
                layers.grid, layers.labels, layers.galacticBand, layers.shiftTint, layers.homePlanets,
                app.selected ? app.selected.entity.code : '', reticle.on, reticle.code
            ].join();
            if (key === lastKey) return;
            lastKey = key;

            const w = Math.round(frame.width * pixelRatio);
            const h = Math.round(frame.height * pixelRatio);
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
            ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            ctx.clearRect(0, 0, frame.width, frame.height);
            if (!inSky) return; // The system view draws its own marks

            const inset = barInsets(frame);
            taken.length = 0;
            if (layers.galacticBand) drawGalacticBand(frame, view, inset);
            if (layers.grid) drawGrid(frame, view, inset);
            if (layers.labels || layers.shiftTint) drawObjectMarks(frame, view, inset, layers.labels, layers.shiftTint);
            drawSelection(frame);
            if (reticle.on) drawReticle(frame);
        }
    };
}
