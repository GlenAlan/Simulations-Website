// The sky by keyboard: arrow keys look, + and - zoom, Enter selects what's at the centre of the view, PageUp, PageDown,
// [ and ] walk from one object to its nearest neighbour, and Esc steps back one thing at a time. Tab reaches every
// control by itself. A reticle marks the centre of the view only while the keyboard is in use (see render/layers/overlays.js).

import { bus, select } from '../core/state.js';
import { angularSeparation } from '../core/sky.js';
import { announce, kindLabelOf } from './drawer.js';

// Also shown on the Help page if its content has no keyboard section
export const KEYBOARD_MAP = [
    { keys: ['←', '↑', '↓', '→'], action: 'Look around' },
    { keys: ['+', '−'], action: 'Zoom in and out' },
    { keys: ['Enter'], action: 'Select what is at the centre of the view' },
    { keys: ['[', ']'], action: 'Move to the next nearest object (or PageUp and PageDown)' },
    { keys: ['/'], action: 'Go to a code' },
    { keys: ['Tab'], action: 'Move through the controls' },
    { keys: ['Esc'], action: 'Close the menu or panel, then leave the system view, then fullscreen' },
    { keys: ['F'], action: 'Show or hide the frame rate' }
];

const LOOK = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
const ZOOM_IN = new Set(['+', '=']);
const ZOOM_OUT = new Set(['-', '_', '−']);
const NEXT = new Set(['PageDown', ']']);
const PREVIOUS = new Set(['PageUp', '[']);

const LOOK_RATE = 0.45;  // Fields of view a second, so a key moves the sky at the same speed at any zoom
const ZOOM_RATE = 1.3;   // Natural-log change of the field of view a second
const NUDGE = 0.02;      // A quick tap moves this many fields of view, even if it lasted under a frame
const CENTRE_PICK_PX = 40;

const FIELD_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week', 'range']);
const FIELD_ROLES = new Set(['slider', 'spinbutton', 'textbox', 'combobox', 'listbox']);
const STEPPED_ROLES = new Set(['tab', 'radio']);

// Every key belongs to these: a caret, a slider or a dropdown
function isField(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if (el.tagName === 'INPUT' && FIELD_INPUT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase())) return true;
    return FIELD_ROLES.has(el.getAttribute('role'));
}

// Arrow keys also belong to these, which move between their own tabs or bands
function takesArrows(el) {
    return isField(el) || (!!el && !!el.getAttribute && STEPPED_ROLES.has(el.getAttribute('role')));
}

export function initKeyboard(app) {
    const engine = app.engine;
    const canvas = engine.canvas || document.getElementById('simulationCanvas');
    const drawerBody = document.getElementById('spectroDrawerBody');
    const held = new Set();
    let reticleOn = null;
    let aim = null;      // The object the walk has reached: see step()

    function setReticle(on, code = null) {
        const key = on ? (code || '') : null;
        if (reticleOn === key) return;
        reticleOn = key;
        bus.emit('reticle', { on, code });
    }

    // Keys steer the sky only from the sky's own part of the page: not while the site menu is open, not while
    // reading the panel or the About section (arrows scroll those), and from the page itself only with the sky in view
    function skyHasKeys(target) {
        if (document.body.classList.contains('is-menu-visible')) return false;
        if (target === canvas) return true;
        if (!target || target === document.body || target === document.documentElement) {
            const r = canvas.getBoundingClientRect();
            return r.top < window.innerHeight * 0.6 && r.bottom > window.innerHeight * 0.4;
        }
        if (drawerBody && drawerBody.contains(target)) return false;
        return !!target.closest('#spectroOverlay, .sim-controls-header, #spectroDrawerTabs');
    }

    function nudge(key) {
        const v = engine.getView();
        const [dx, dy] = LOOK[key] || [0, 0];
        const stretch = 1 / Math.max(0.2, Math.cos(v.alt * Math.PI / 180));
        if (dx || dy) engine.setView({ az: v.az + dx * NUDGE * v.fov * stretch, alt: v.alt + dy * NUDGE * v.fov });
    }

    // Held keys move the sky once a frame
    engine.addLayer({
        id: 'keyboard',
        update(frame) {
            if (!held.size || app.view !== 'sky' || engine.isSlewing()) return;
            const v = engine.getView();
            let dx = 0;
            let dy = 0;
            let dz = 0;
            held.forEach((key) => {
                if (LOOK[key]) {
                    dx += LOOK[key][0];
                    dy += LOOK[key][1];
                } else if (key === 'in') dz -= 1;
                else if (key === 'out') dz += 1;
            });
            const step = v.fov * LOOK_RATE * frame.dt;
            const stretch = 1 / Math.max(0.2, Math.cos(v.alt * Math.PI / 180)); // Azimuth lines bunch up towards the zenith
            engine.setView({ az: v.az + dx * step * stretch, alt: v.alt + dy * step, fov: v.fov * Math.exp(dz * ZOOM_RATE * frame.dt) });
        }
    });

    function announceZoom() {
        const fov = engine.getView().fov;
        const degrees = fov >= 10 ? Math.round(fov) : Number(fov.toFixed(1));
        announce(`Field of view ${degrees} degrees`);
    }

    function selectAtCentre() {
        const frame = engine.currentFrame();
        const code = engine.pick(frame.width / 2, frame.height / 2, CENTRE_PICK_PX);
        if (!code) {
            announce('Nothing at the centre of the view. Press the right square bracket to move to the nearest object.');
            return;
        }
        select(code);
        app.drawer.focusContent();
    }

    // Walk from object to nearest neighbour: the next press goes to the nearest place not yet visited, and the other
    // key steps back along the way already walked. Moving the sky any other way starts a new walk from there.
    function walkable() {
        return app.universe.bodies.filter((body) => engine.bodyShows(body));
    }

    function walkStillValid() {
        if (!aim || engine.isSlewing()) return !!aim;
        const v = engine.getView();
        const here = aim.path[aim.index];
        if (!here) return false;
        return Math.abs(v.fov - aim.fov) < 1e-3 && angularSeparation(v.az, v.alt, here.sky.az, here.sky.alt) < 0.02 * v.fov;
    }

    function step(direction) {
        const view = engine.getView();
        if (!walkStillValid()) aim = { path: [], index: -1, fov: view.fov };
        const bodies = walkable();
        if (!bodies.length) {
            announce('Nothing shows in this band at this zoom.');
            return;
        }
        let target = null;
        if (direction < 0 && aim.index > 0) {
            aim.index -= 1;
            target = aim.path[aim.index];
        } else if (direction > 0 && aim.index < aim.path.length - 1) {
            aim.index += 1;
            target = aim.path[aim.index];
        } else {
            const from = aim.index >= 0 ? aim.path[aim.index].sky : view;
            const seen = new Set(aim.path);
            let best = Infinity;
            bodies.forEach((body) => {
                if (seen.has(body)) return;
                const d = angularSeparation(from.az, from.alt, body.sky.az, body.sky.alt);
                if (d < best) {
                    best = d;
                    target = body;
                }
            });
            if (!target) target = aim.path[0];
            if (direction < 0) {
                aim.path.unshift(target);
                aim.index = 0;
            } else {
                aim.path.push(target);
                aim.index = aim.path.length - 1;
            }
        }
        engine.slewTo({ az: target.sky.az, alt: target.sky.alt }, { duration: 0.35 });
        setReticle(true, target.code);
        const resolved = app.universe.resolve(target.code);
        if (app.drawer.isOpen() && app.drawer.currentView() === 'object') select(target.code);
        else announce(`${kindLabelOf(resolved)} ${target.name || target.code}. Press Enter to select it.`);
    }

    document.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
        const key = e.key;
        const target = e.target;
        if (!skyHasKeys(target)) return;

        if (app.view !== 'sky') return; // The system view steers its own camera; the sky waits where it was left

        if (LOOK[key]) {
            if (takesArrows(target)) return;
            e.preventDefault();
            if (!e.repeat) nudge(key);
            held.add(key);
            setReticle(true);
            return;
        }

        if (isField(target)) return;

        if (NEXT.has(key) || PREVIOUS.has(key)) {
            e.preventDefault();
            if (!e.repeat) step(NEXT.has(key) ? 1 : -1);
            return;
        }

        if (ZOOM_IN.has(key) || ZOOM_OUT.has(key)) {
            e.preventDefault();
            held.add(ZOOM_IN.has(key) ? 'in' : 'out');
            setReticle(true);
            return;
        }

        if (key === 'Enter' && (target === canvas || target === document.body)) {
            e.preventDefault();
            setReticle(true);
            selectAtCentre();
        }
    });

    document.addEventListener('keyup', (e) => {
        if (LOOK[e.key]) held.delete(e.key);
        if (ZOOM_IN.has(e.key) && held.delete('in')) announceZoom();
        if (ZOOM_OUT.has(e.key) && held.delete('out')) announceZoom();
    });
    window.addEventListener('blur', () => held.clear());

    // The reticle stays out of the way of anyone using a pointer
    canvas.addEventListener('pointerdown', () => setReticle(false));
    canvas.addEventListener('focus', () => { if (canvas.matches(':focus-visible')) setReticle(true); });
    canvas.addEventListener('blur', (e) => { if (e.relatedTarget) setReticle(false); });

    // Esc steps back one thing at a time: the Layers menu, then the drawer, then the system view, and then fullscreen,
    // which is left to simulation_ui.js. This runs first, on the way down, so simulation_ui.js can't jump ahead.
    function stepBack(e) {
        let handled = true;
        if (app.shell && app.shell.isOpen()) app.shell.close(true);
        else if (app.drawer.isOpen()) app.drawer.close();
        else if (app.view === 'system' && app.system) app.system.exit();
        else handled = false;
        if (handled) {
            e.stopPropagation();
            e.preventDefault();
        }
    }

    const topLeft = document.getElementById('spectroTopLeft');
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        // An open glossary tip goes first, and it handles that itself
        const tip = document.querySelector('.spectro-term-tip:not([hidden])');
        if (tip) return;
        // The Go to box has first say over Esc while it has focus: see below
        if (topLeft && e.target && e.target.closest && e.target.closest('#spectroTopLeft')) return;
        stepBack(e);
    }, { capture: true });

    // Its text box and prompt keep Esc to themselves. If it gets past them, it's a normal step back.
    if (topLeft) {
        topLeft.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') stepBack(e);
        });
    }
}
