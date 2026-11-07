// What the hands-on tools share: things on the plot that can be dragged, the grip drawn on them, a row of modes, buttons that
// repeat while held, and borrowing the plot's reference while a tool draws its own.

import { el } from '../../plot2d.js';
import { overlayTheme } from './common.js';

// ---------- Dragging something on the plot ----------

// A drag that starts on the thing wins over the plot's own pan and zoom; one that starts anywhere else is left to the plot.
// It listens in front of the plot's own listeners, on the same canvas, so the plot needn't know about it.
//
//   plotGrab(plot, { hit(x, y, e) -> truthy when on it, start(hit, x, y, e), move(x, y, e), end(x, y, e, moved), hover(on) })
//   x and y are CSS pixels of the canvas. e.pointerType says how generous hit should be: fingers are wide.
// Returns a function that stops listening.
export function plotGrab(plot, handlers) {
    const canvas = plot.canvas;
    let active = null;
    let hovering = false;

    function local(e) {
        const r = canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    function setHover(on) {
        if (on === hovering) return;
        hovering = on;
        canvas.style.cursor = on ? 'ew-resize' : '';
        if (handlers.hover) handlers.hover(on);
    }

    function down(e) {
        if (active) {
            // A second finger doesn't start a pinch under a drag
            e.stopImmediatePropagation();
            return;
        }
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const [x, y] = local(e);
        const what = handlers.hit(x, y, e);
        if (!what) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        active = { id: e.pointerId, x0: x, moved: false };
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* Older browsers */ }
        canvas.classList.add('is-dragging');
        canvas.style.cursor = 'ew-resize';
        // The plot's own cursor would stay behind where the drag began
        plot.setCursor(null);
        handlers.start(what, x, y, e);
    }

    function move(e) {
        if (active && e.pointerId === active.id) {
            e.stopImmediatePropagation();
            const [x, y] = local(e);
            if (!active.moved && Math.abs(x - active.x0) < 2) return;
            active.moved = true;
            handlers.move(x, y, e);
            return;
        }
        if (!active && e.pointerType === 'mouse' && !e.buttons) {
            const [x, y] = local(e);
            setHover(!!handlers.hit(x, y, e));
        }
    }

    function finish(e, cancelled) {
        if (!active || e.pointerId !== active.id) return;
        e.stopImmediatePropagation();
        const { moved } = active;
        active = null;
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* Already released */ }
        canvas.classList.remove('is-dragging');
        const [x, y] = local(e);
        canvas.style.cursor = e.pointerType === 'mouse' && handlers.hit(x, y, e) ? 'ew-resize' : '';
        handlers.end(x, y, e, moved, cancelled);
    }

    const up = (e) => finish(e, false);
    const cancel = (e) => finish(e, true);
    const leave = () => { if (!active) setHover(false); };
    // Once a drag has started on the thing, the finger mustn't also scroll the drawer
    const touchHold = (e) => { if (active) e.preventDefault(); };
    const dbl = (e) => {
        const [x, y] = local(e);
        if (handlers.hit(x, y, e)) e.stopImmediatePropagation();
    };

    canvas.addEventListener('pointerdown', down, true);
    canvas.addEventListener('pointermove', move, true);
    canvas.addEventListener('pointerup', up, true);
    canvas.addEventListener('pointercancel', cancel, true);
    canvas.addEventListener('pointerleave', leave, true);
    canvas.addEventListener('touchstart', touchHold, { capture: true, passive: false });
    canvas.addEventListener('touchmove', touchHold, { capture: true, passive: false });
    canvas.addEventListener('dblclick', dbl, true);
    return () => {
        canvas.removeEventListener('pointerdown', down, true);
        canvas.removeEventListener('pointermove', move, true);
        canvas.removeEventListener('pointerup', up, true);
        canvas.removeEventListener('pointercancel', cancel, true);
        canvas.removeEventListener('pointerleave', leave, true);
        canvas.removeEventListener('touchstart', touchHold, true);
        canvas.removeEventListener('touchmove', touchHold, true);
        canvas.removeEventListener('dblclick', dbl, true);
        canvas.classList.remove('is-dragging');
        canvas.style.cursor = '';
    };
}

// How near the thing a press has to be, in CSS pixels: a finger covers far more than a mouse pointer
export function reachOf(e) {
    return e && e.pointerType && e.pointerType !== 'mouse' ? 22 : 11;
}

// ---------- Drawing ----------

// The overlay theme, with the reference's colour: what a student lays over the spectrum is drawn as the reference is, dashed
export function handTheme(plot) {
    const theme = overlayTheme(plot);
    const cs = getComputedStyle(plot.el);
    theme.ref = cs.getPropertyValue('--spectro-plot-ref').trim() || '#0b6bab';
    theme.focus = cs.getPropertyValue('--spectro-on').trim() || theme.mark;
    return theme;
}

export const HAND_DASH = [6, 4];

// A round grip with arrows either way: the sign that this can be dragged sideways. Drawn hollow when the thing isn't set yet.
export function drawGrip(ctx, theme, x, y, { colour = theme.ref, focused = false, size = 9 } = {}) {
    ctx.save();
    ctx.setLineDash([]);
    if (focused) {
        ctx.beginPath();
        ctx.arc(x, y, size + 4, 0, Math.PI * 2);
        ctx.strokeStyle = theme.focus;
        ctx.lineWidth = 2;
        ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fillStyle = theme.well;
    ctx.fill();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = colour;
    const a = size * 0.62;
    const h = size * 0.38;
    ctx.beginPath();
    ctx.moveTo(x - a, y);
    ctx.lineTo(x - a + h * 1.1, y - h);
    ctx.lineTo(x - a + h * 1.1, y + h);
    ctx.closePath();
    ctx.moveTo(x + a, y);
    ctx.lineTo(x + a - h * 1.1, y - h);
    ctx.lineTo(x + a - h * 1.1, y + h);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

// ---------- Controls ----------

// A row of modes, one pressed at a time: [{ id, label }]. Returns { el, set(id) }.
export function modeRow(label, modes, onPick) {
    const buttons = modes.map((mode) => el('button', {
        type: 'button',
        class: 'spectro-hands-mode',
        'aria-pressed': 'false',
        text: mode.label,
        onclick: () => onPick(mode.id)
    }));
    const row = el('div', { class: 'spectro-hands-modes', role: 'group', 'aria-label': label }, ...buttons);
    return {
        el: row,
        set(id) {
            modes.forEach((mode, i) => buttons[i].setAttribute('aria-pressed', mode.id === id ? 'true' : 'false'));
        }
    };
}

// A button that steps once when pressed and keeps stepping while held, faster the longer it's held. A key press gives one step.
export function holdToRepeat(button, step) {
    let timer = 0;
    let started = 0;
    const stop = () => {
        clearTimeout(timer);
        timer = 0;
    };
    const tick = () => {
        const held = performance.now() - started;
        step(held > 2400 ? 25 : held > 1200 ? 5 : 1);
        timer = setTimeout(tick, 55);
    };
    button.addEventListener('pointerdown', (e) => {
        if (e.button) return;
        started = performance.now();
        step(1);
        stop();
        timer = setTimeout(tick, 380);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach((type) => button.addEventListener(type, stop));
    button.addEventListener('click', (e) => { if (e.detail === 0) step(1); });
    return stop;
}

// ---------- Borrowing the plot ----------

// A tool that draws its own curve or lines over the spectrum hides the reference while it does, so the plot is one pane at
// full height, and gives it back as it was. The student can still choose a reference while the tool is open, and keeps it.
export function borrowReference(api) {
    let saved = null;
    let chosenSince = false;
    let quiet = false;
    let shown = null;
    // A change of shift or temperature isn't a change of reference: only a different one counts
    const off = api.onReferenceChange(() => {
        if (!quiet && saved && api.picker.state().id !== shown) chosenSince = true;
    });
    function apply(id, mode) {
        quiet = true;
        shown = id;
        try {
            api.picker.choose(id);
            if (mode) api.setMode(mode);
        } finally {
            quiet = false;
        }
    }
    return {
        // Shows id (or none), in mode, keeping what was there before to give back
        show(id = 'none', mode = null) {
            if (!saved) {
                saved = { id: api.picker.state().id, mode: api.plot.getMode() };
                chosenSince = false;
            }
            if (chosenSince) return;
            apply(id, mode);
        },
        give() {
            if (saved && !chosenSince) apply(saved.id, saved.mode);
            saved = null;
            chosenSince = false;
        },
        // The student chose a reference of their own while this was borrowed
        chosen: () => chosenSince,
        dispose() {
            this.give();
            off();
        }
    };
}

// Moves the view, and gives back the one it was when it's done with it
export function borrowView(plot) {
    let saved = null;
    let set = null;
    return {
        go(lo, hi) {
            if (!saved) saved = plot.getRange();
            set = { lo, hi };
            plot.setRange(lo, hi, { animate: true });
        },
        give() {
            // Only if the view is still the one this set; a student's own zoom since then is theirs
            const now = plot.getRange();
            if (saved && set && Math.abs(Math.log(now.lo / set.lo)) < 0.01 && Math.abs(Math.log(now.hi / set.hi)) < 0.01) {
                plot.setRange(saved.lo, saved.hi, { animate: true });
            }
            saved = null;
            set = null;
        }
    };
}
