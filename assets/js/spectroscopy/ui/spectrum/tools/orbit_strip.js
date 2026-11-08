// What keeps a multi-star system's spectrum in step with its orbit: the strip under the plot, with the system's clock and the
// dial. It has no row in the Tools list, because the spectrum has to follow the clock whether or not a tool is open.
// It is the only thing that passes the clock's time to the spectrum: the stepped reading, so lines never strobe, and paced
// by the view so that nothing is worked out that wouldn't show.

import { registerTool } from './index.js';
import { app } from '../../../core/state.js';
import { createPlayback } from '../../playback.js';
import { el } from '../../plot2d.js';
import { niceSpeeds } from './common.js';
import { clockFor, toWidestSplit } from './orbit_clock.js';
import { createOrbitDial } from './orbit_dial.js';

// How often the spectrum follows, in ms, by how wide a view it is: a shift of a few km/s can only be seen zoomed in on a line,
// and the wider view costs more. The narrowest view follows every frame.
const FOLLOW_MS_WIDE = 200;
const FOLLOW_MS_WHOLE = 1000;
const WIDE_RATIO = 1.3;
const WHOLE_RATIO = 8;           // Matches the panel: at this width it goes back to drawing the whole range
const REDUCED_MOTION_MS = 500;
const DIAL_MS = 50;

function applies(resolved) {
    const { body } = resolved;
    return !!(body && (body.black_hole || body.unstable || (body.stars && body.orbits && body.orbits.length))) && resolved.path !== 'planet';
}

function inThisSystem(clock) {
    return app.view === 'system' && app.systemCode === clock.code;
}

function mount(container, api) {
    const { plot } = api;
    const controls = el('div', { class: 'spectro-orbit-controls' });
    const dialHost = el('div', {});
    const closer = el('button', {
        type: 'button',
        class: 'spectro-tool-next spectro-orbit-closer',
        text: 'See the lines split',
        onclick: () => {
            // Straight to a moment when they are, and running, so there's something to see at once
            if (clock && bound) toWidestSplit(bound, !(app.settings && app.settings.reduceMotion));
            api.openTool('time-series');
        }
    });
    const root = el('div', { class: 'spectro-orbit' }, controls, dialHost);
    container.append(root);

    let clock = null;
    let bound = null;
    let playback = null;
    let dial = null;
    let offState = null;
    let offStep = null;
    let lastFollow = 0;
    let lastDial = 0;
    let shown = true;

    function follow(t, force = false) {
        if (!shown) return;
        const now = performance.now();
        const { lo, hi } = plot.getRange();
        const ratio = hi / lo;
        const reduce = !!(app.settings && app.settings.reduceMotion);
        let gap = ratio < WIDE_RATIO ? 0 : ratio < WHOLE_RATIO ? FOLLOW_MS_WIDE : FOLLOW_MS_WHOLE;
        if (reduce) gap = Math.max(gap, REDUCED_MOTION_MS);
        if (force || now - lastFollow >= gap) {
            lastFollow = now;
            api.setBodyOpts({ t });
        }
        if (force || now - lastDial >= (reduce ? REDUCED_MOTION_MS : DIAL_MS)) {
            lastDial = now;
            dial.set(t);
        }
    }

    function release() {
        if (!clock) return;
        offState();
        offStep();
        playback.dispose();
        dial.dispose();
        closer.remove();
        // Out in the sky nothing else is showing this orbit once its panel has moved on
        if (!inThisSystem(clock)) clock.pause();
        clock = null;
    }

    function bind(body) {
        release();
        clock = clockFor(body);
        bound = body;
        dial = createOrbitDial(dialHost, body);
        const period = clock.fastest;
        const speeds = niceSpeeds([period / 12, period / 6, period / 3, period / 1.5]);
        if (!clock.playing && !speeds.includes(clock.speed)) clock.setSpeed(speeds[Math.min(1, speeds.length - 1)]);
        playback = createPlayback(controls, {
            clock,
            label: 'Orbit time',
            speeds,
            unit: 'days'
        });
        controls.append(closer);
        offStep = clock.onStep((t) => follow(t));
        offState = clock.onState(() => {
            // Paused: show exactly where it stopped
            if (!clock.playing) follow(clock.steppedT(), true);
        });
    }

    return {
        setEntity(next) {
            if (!clock || clock.code !== next.body.code) bind(next.body);
            // The panel starts a new object's options afresh, and at no time: tell it the time unless that's right
            const t = clock.steppedT();
            if (t !== 0) api.setBodyOpts({ t });
            dial.set(t);
        },
        onPanelHide() {
            shown = false;
            if (clock && !inThisSystem(clock)) clock.pause();
        },
        onPanelShow() {
            shown = true;
            if (clock) follow(clock.steppedT(), true);
        },
        dispose() {
            release();
            root.remove();
        }
    };
}

registerTool({
    id: 'orbit-strip',
    label: 'Orbit',
    pinned: true,
    appliesTo: applies,
    mount
});
