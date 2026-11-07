// Two small helps over the sky. Neither is a tour, and neither takes a pointer event or the keyboard.
//   A one-line hint on a first visit, which goes for good once anything has been selected.
//   A tag by the pointer naming the kind of thing under it, as the panel's title would. Pointer only: a finger has no
//   hover, and a screen reader hears the same words when moving through objects with the square brackets.

import { app, bus } from '../core/state.js';
import { kindLabelOf } from './drawer.js';

const HINT_SEEN_KEY = 'spectroscopy.firstHintSeen';
const HINT_DELAY_MS = 1200;     // Time to take in the sky, and for a ?goto= link's selection to arrive first
const TAG_GAP_PX = 14;          // From the pointer, so that the tag doesn't sit under it
const TAG_PICK_PX = 12;         // The same reach as the pointing-hand cursor (render/engine.js), so the two agree
const TAG_LOOK_EVERY_S = 0.1;   // How often to look under the pointer while it or the sky is moving

// Storage can be blocked, in which case the hint is only remembered for this visit
function hintSeen() {
    try {
        return localStorage.getItem(HINT_SEEN_KEY) === '1';
    } catch (err) {
        return false;
    }
}

function rememberHint() {
    try {
        localStorage.setItem(HINT_SEEN_KEY, '1');
    } catch (err) { /* Nothing more to do */ }
}

function initFirstHint(overlay) {
    if (hintSeen()) return;
    const hint = document.createElement('p');
    hint.className = 'spectro-first-hint spectro-glass';
    hint.textContent = 'Click or tap any object to study its light.';
    hint.hidden = true;
    overlay.appendChild(hint);

    // Only on the sky, and not while "Nothing here" has the same spot: one message at a time
    let due = false;
    let nothingShown = false;
    const paint = () => { hint.hidden = !due || app.view !== 'sky' || nothingShown; };
    // Someone following a link is about to be given an object, so they don't need telling how to choose one
    const timer = new URLSearchParams(window.location.search).has('goto')
        ? 0
        : setTimeout(() => {
            due = true;
            paint();
        }, HINT_DELAY_MS);
    const offView = bus.on('view', paint);
    const offNothing = bus.on('nothinghere', ({ shown }) => {
        nothingShown = shown;
        paint();
    });
    const offSelect = bus.on('select', () => {
        offSelect();
        offView();
        offNothing();
        clearTimeout(timer);
        hint.remove();
        rememberHint();
    });
}

function initHoverTag(overlay) {
    const engine = app.engine;
    const canvas = engine.canvas;
    const tag = document.createElement('div');
    tag.className = 'spectro-hover-tag';
    tag.setAttribute('aria-hidden', 'true');
    tag.hidden = true;
    overlay.appendChild(tag);

    let inside = false;
    let pressed = false;
    let moved = false;      // The pointer has moved since the tag was last placed
    let stale = false;      // The pointer or the sky has moved since the last look under the pointer
    let lastLook = -Infinity;
    let x = 0;
    let y = 0;
    let shownCode = null;
    let tagWidth = 0;
    const lastView = { az: 0, alt: 0, fov: 0 };

    function hide() {
        if (shownCode === null) return;
        shownCode = null;
        tag.hidden = true;
    }

    // To the right of the pointer, or to its left near the edge of the sky
    function place(skyWidth) {
        if (shownCode === null) return;
        const left = x + TAG_GAP_PX + tagWidth > skyWidth ? x - TAG_GAP_PX - tagWidth : x + TAG_GAP_PX;
        tag.style.transform = `translate(${Math.round(left)}px, ${Math.round(y + TAG_GAP_PX)}px)`;
    }

    canvas.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse') return;
        inside = true;
        moved = true;
        x = e.offsetX;
        y = e.offsetY;
    });
    canvas.addEventListener('pointerleave', () => {
        inside = false;
        hide();
    });
    canvas.addEventListener('pointerdown', () => {
        pressed = true;
        hide();
    });
    const release = () => {
        pressed = false;
        moved = true;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    // A layer is called once a frame. Keeping up with the pointer costs next to nothing, but a pick walks every body in
    // the sky, which is several times a whole frame's work, so that waits for its turn. Nothing runs while all is still.
    engine.addLayer({
        id: 'hover-tag',
        update(frame) {
            if (!inside || pressed) return;
            const view = engine.view;
            if (view.az !== lastView.az || view.alt !== lastView.alt || view.fov !== lastView.fov) {
                lastView.az = view.az;
                lastView.alt = view.alt;
                lastView.fov = view.fov;
                stale = true;
            }
            if (moved) {
                moved = false;
                stale = true;
                place(frame.width);
            }
            if (!stale || frame.t - lastLook < TAG_LOOK_EVERY_S) return;
            stale = false;
            lastLook = frame.t;
            const code = engine.isSlewing() ? null : engine.pick(x, y, TAG_PICK_PX);
            const resolved = code && code !== shownCode ? app.universe.resolve(code) : null;
            if (!code || (code !== shownCode && !resolved)) {
                hide();
            } else if (resolved) {
                shownCode = code;
                tag.textContent = kindLabelOf(resolved);
                tag.hidden = false;
                tagWidth = tag.offsetWidth;
                place(frame.width);
            }
        }
    });
}

export function initSkyHints() {
    const overlay = document.getElementById('spectroOverlay');
    initFirstHint(overlay);
    initHoverTag(overlay);
}
