// Two quiet helps by the zoom readout: Reset view, only while zoomed in, and a line that says so when there's nothing in
// the frame, with a button to the nearest object. With the scenery stars off, a narrow view in a band with little in it is
// plain black, and that shouldn't look like a fault or a dead end.

import { DEFAULT_VIEW, azAltToVec3, vec3ToAzAlt, angularSeparation, limitingMag } from '../core/sky.js';
import { parallaxFactor } from '../core/depth.js';
import { announce } from './drawer.js';
import { bus } from '../core/state.js';

const RAD = Math.PI / 180;
const RESET_BELOW_FOV = DEFAULT_VIEW.fov * 0.8;   // A zoom of 1.25×: a nudge of the wheel doesn't bring the button up
const RESET_S = 0.9;
const NEAREST_S = 1.1;
const CHECK_EVERY_S = 0.12;     // Often enough for the line to go as soon as something comes into view
const EMPTY_PAUSE_S = 0.5;      // The frame has to stay empty this long, so a pan across a gap doesn't set it off
const ARROW_STEP_DEG = 4;
// In magnitudes inside the zoom's limit, measured on screen. Within 0.5 a thing is drawn but can't be made out, so the frame
// can still be called empty. At 1 it can be made out, so it's somewhere worth flying to.
const IN_VIEW_MARGIN = 0.5;
const WORTH_FLYING_MARGIN = 1;

const SUN_ALT = -70;            // Where the comets' tails point away from: see render/layers/comets.js
const TAIL_STEPS = 6;
const TAIL_SPREAD = 0.15;       // How far a tail fans out either side, as a fraction of how far along it is

// How far an object reaches from its middle, in degrees, erring towards "something's in view". Sizes are read after
// assignDepths has scaled them. A comet is its head here, and its tail is tested on its own.
function reachDeg(body) {
    if (body.nebula) return body.nebula.size_deg / 2;
    if (body.galaxy) return body.galaxy.size_deg / 2;
    if (body.cluster) return body.cluster.radius_deg;
    if (body.supernova) return body.supernova.shell_deg;
    if (body.comet) return body.comet.coma_deg;
    return body.visual_sep_deg || 0;
}

// Points along a comet's tail, on the sky: the part of "directly away from the Sun" that lies along the sky at its head
function tailPoints(body, tailAz) {
    const c = azAltToVec3(body.sky.az, body.sky.alt);
    const sun = azAltToVec3(tailAz, SUN_ALT);
    const dot = c[0] * sun[0] + c[1] * sun[1] + c[2] * sun[2];
    const t = [c[0] * dot - sun[0], c[1] * dot - sun[1], c[2] * dot - sun[2]];
    const len = Math.hypot(t[0], t[1], t[2]) || 1;
    const points = [];
    for (let i = 1; i <= TAIL_STEPS; i++) {
        const along = (body.comet.tail_deg * i) / TAIL_STEPS;
        const k = Math.tan(along * RAD) / len;
        const at = vec3ToAzAlt(c[0] + t[0] * k, c[1] + t[1] * k, c[2] + t[2] * k);
        points.push({ az: at.az, alt: at.alt, spread: along * TAIL_SPREAD });
    }
    return points;
}

export function initViewAids(app) {
    const engine = app.engine;
    const canvas = engine.canvas;
    const bar = document.getElementById('spectroContextBar');
    const readout = bar.querySelector('.spectro-zoom');

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'spectro-reset-view';
    reset.innerHTML = 'Reset<span class="spectro-reset-word"> view</span>';
    reset.title = 'Zoom back out to the full view, facing the same way';
    reset.hidden = true;
    readout.appendChild(reset);

    const nothing = document.createElement('button');
    nothing.type = 'button';
    nothing.className = 'spectro-nothing';
    nothing.hidden = true;
    nothing.innerHTML = `
        <span class="spectro-nothing-line">Nothing here. <span class="spectro-nothing-go">Nearest object</span>
        <svg class="spectro-nothing-arrow" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
    nothing.title = 'Fly to the nearest object at this zoom';
    bar.parentElement.appendChild(nothing); // Placed against the sky, as the bar's width and the legend's vary
    const arrow = nothing.querySelector('.spectro-nothing-arrow');

    // Hiding the button that has the focus would drop it on the page itself
    function hide(button) {
        if (button.hidden) return;
        if (document.activeElement === button) canvas.focus({ preventScroll: true });
        button.hidden = true;
        if (button === nothing) bus.emit('nothinghere', { shown: false });
    }

    function resetView() {
        const view = engine.getView();
        // A narrow view can sit lower than a wide one is allowed to, so it's lifted to the height the opening view has
        engine.slewTo({ fov: DEFAULT_VIEW.fov, alt: Math.max(view.alt, DEFAULT_VIEW.alt) }, { duration: RESET_S });
        announce(`Field of view ${DEFAULT_VIEW.fov} degrees`);
    }
    // At the start of a zoom into a system the button is still there, as the sky is: it goes back out first
    reset.addEventListener('click', () => {
        if (app.view !== 'sky' && app.system) app.system.exit({ onDone: resetView });
        else resetView();
    });

    const opening = () => !!app.system && app.system.isOpening();

    // Without a sky there's no zoom to read and no frame to be empty: leave nothing behind, not even an empty pill
    if (!engine.renderer) {
        bar.hidden = true;
        return { update() {} };
    }

    let list = null;
    function bodies() {
        if (!list && app.universe) {
            list = app.universe.bodies.map((body) => ({
                body,
                dir: azAltToVec3(body.sky.az, body.sky.alt),
                reach: reachDeg(body),
                tail: body.comet ? tailPoints(body, app.universe.cometTailAz) : null
            }));
        }
        return list;
    }

    function somethingInFrame(items, frame, view) {
        const forward = azAltToVec3(view.az, view.alt);
        // Wide enough for the furthest things, which are drawn nearer the middle than the camera has them
        const half = engine.reachDeg(view.fov);
        const cosHalf = Math.cos(Math.min(89, half) * RAD);
        const pxPerDeg = RAD * (frame.pxPerRad / frame.dpr);
        const seen = limitingMag(view.fov) - IN_VIEW_MARGIN;
        // Whatever the student has picked counts, however faint: the selection ring is round it
        if (app.selected && engine.bodyShows(app.selected.body)) {
            const p = engine.projectBody(app.selected.body);
            if (p && p.onScreen) return true;
        }
        const touches = (p, r) => !!p && p.x + r >= 0 && p.x - r <= frame.width && p.y + r >= 0 && p.y - r <= frame.height;
        for (let i = 0; i < items.length; i++) {
            const { body, dir, reach, tail } = items[i];
            const dot = dir[0] * forward[0] + dir[1] * forward[1] + dir[2] * forward[2];
            const far = tail ? body.comet.tail_deg * (1 + TAIL_SPREAD) : reach;
            if (dot < cosHalf && (!far || dot < Math.cos(Math.min(89, half + far) * RAD))) continue;
            if (!engine.bodyShows(body, seen)) continue;
            const scale = pxPerDeg * parallaxFactor(body.depth || 0, view.fov);
            if (touches(engine.projectBody(body), reach * scale)) return true;
            if (tail && tail.some((q) => touches(engine.project(q.az, q.alt, body.depth || 0), q.spread * scale))) return true;
        }
        return false;
    }

    // Measured as drawn: of two things at the same angle, the further is drawn nearer the middle
    function nearestBody(items, view) {
        let best = null;
        let bestDistance = Infinity;
        const seen = limitingMag(view.fov) - WORTH_FLYING_MARGIN;
        const centre = engine.centreDir();
        for (let i = 0; i < items.length; i++) {
            const { body } = items[i];
            if (!engine.bodyShows(body, seen)) continue;
            const d = angularSeparation(centre.az, centre.alt, body.sky.az, body.sky.alt) * parallaxFactor(body.depth || 0, view.fov);
            if (d < bestDistance) {
                bestDistance = d;
                best = body;
            }
        }
        return best;
    }

    let target = null;
    let lastAngle = null;
    function aim(body, frame, view) {
        const p = engine.projectBody(body);
        const across = p ? p.x - frame.width / 2 : (((body.sky.az - view.az + 540) % 360) - 180) * Math.cos(view.alt * RAD);
        const down = p ? p.y - frame.height / 2 : view.alt - body.sky.alt;
        const angle = Math.round((Math.atan2(down, across) / RAD) / ARROW_STEP_DEG) * ARROW_STEP_DEG;
        if (angle !== lastAngle) {
            lastAngle = angle;
            arrow.style.transform = `rotate(${angle}deg)`;
        }
    }

    nothing.addEventListener('click', () => {
        if (!target) return;
        engine.slewTo({ az: target.sky.az, alt: target.sky.alt }, { duration: NEAREST_S, pullBack: true });
    });

    let sinceCheck = 0;
    let emptyFor = 0;
    let lastKey = '';
    let wasEmpty = false;

    function check(frame, dt) {
        const view = engine.getView();
        const items = bodies();
        if (!items || frame.view !== 'sky' || app.layers.backgroundStars || engine.isSlewing()) {
            emptyFor = 0;
            hide(nothing);
            return;
        }
        const key = `${view.az.toFixed(3)},${view.alt.toFixed(3)},${view.fov.toFixed(3)},${frame.width},${frame.height},${frame.band},${app.layers.homePlanets}`;
        if (key !== lastKey) {
            lastKey = key;
            wasEmpty = !somethingInFrame(items, frame, view);
            if (wasEmpty) target = nearestBody(items, view);
        }
        if (!wasEmpty || !target) {
            emptyFor = 0;
            hide(nothing);
            return;
        }
        emptyFor += dt;
        if (emptyFor < EMPTY_PAUSE_S) return;
        aim(target, frame, view);
        if (nothing.hidden) {
            nothing.hidden = false;
            bus.emit('nothinghere', { shown: true });
            announce('Nothing in view here. There is a button to fly to the nearest object.');
        }
    }

    return {
        update(frame) {
            // Not during the start of a zoom into a system either, so the bar doesn't change width under the pointer
            const showReset = (frame.view === 'sky' || opening()) && frame.fov < RESET_BELOW_FOV;
            if (showReset) reset.hidden = false;
            else hide(reset);

            sinceCheck += frame.dt;
            if (sinceCheck < CHECK_EVERY_S) return;
            check(frame, sinceCheck);
            sinceCheck = 0;
        }
    };
}
