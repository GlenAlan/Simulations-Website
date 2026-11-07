// Zooming on a star carries on into its system, and zooming back out comes home again: one gesture, with no button.
//
// The engine shows this every zoom step before the sky gets it (setZoomIntake). While a star is what's being zoomed into,
// this works out which star that is, gets its system ready in the background, and takes over when the time comes. From
// then on the gesture moves the flight (see "under a student's hand" in transition.js), and a pause lets it settle at
// whichever end is nearer. The sky keeps zooming until the system is ready, so a slow machine waits but never freezes.
//
// When the move begins:
//   What's being zoomed into has to be the only thing in play. A star qualifies at a field of view of CAPTURE_FOV or less,
//   once nothing else star-like is within CLEAR_SHARE of the view's height of it. Until then the sky goes on zooming as usual.
//   So a lone star hands over early, and one in a crowded field or among a cluster's members only once it stands apart.
//   Whatever the sky still has to show comes first: a multiple's stars have to come apart, a black hole shows its lens, and a
//   faint star has to be showing properly. With only that one thing in play, a wheel covers the way down in fewer notches.
//   At the sky's zoom limit, whatever is left and being pointed at can be entered.
// Which star: the one under the pointer, or else the selected one if it's on show, or else one near the centre of the view.
// Pointing at something that isn't a system, such as a galaxy, means no capture at all.
//
// Zooming in on one takes no panel with it: a panel already open on something else moves to it on arrival, and otherwise the
// context bar names the system and opens its panel in one click.

import { MIN_FOV } from '../../core/sky.js';
import { bus } from '../../core/state.js';
import { ZOOM_RATE } from '../engine.js';
import { HAND_LOG, smootherstep } from './transition.js';

const CAPTURE_FOV = 12;         // No star takes over a wider view than this (degrees)
const CLEAR_SHARE = 0.15;       // How clear of other stars it has to be, as a share of the view's height
const SEEN_GLOW = 0.3;          // How well a faint star has to be showing (see engine.glowOf) before it goes further
const APART_MARGIN = 0.95;      // A multiple's stars have split by this share of the field of view at which they come apart
const RUN_UP_BOOST = 2;         // On the way down to that, or to a faint star showing, a wheel's notch goes this much further
const LENS_FOV = 0.46;          // A black hole's lens shows by about 0.5 degrees
const LIMIT_FOV = MIN_FOV * 1.03;
const READY_AHEAD = 2;          // Start getting a system ready this many times the hand-over field of view away
const LOOK_EVERY_MS = 120;      // How often to look for what's being zoomed into: a sweep through every layer's picks
const POINT_MOVED_PX = 8;
const POINT_PX = { wheel: 24, touch: 44, key: 40 };
const NEAR_CENTRE_SHARE = 0.12; // How near the centre, as a share of the view's height
const POINTER_NEAR_CENTRE_SHARE = 0.25;
const GESTURE_GONE_MS = 450;    // A zoom this long ago isn't going on any more
const KEEP_READY_S = 8;         // How long a system stays ready for a student who has stopped zooming at it

const MOST_PER_S = 1.5;         // The fastest the move goes, of its whole length a second. A big bright star fills much of the
                                // screen by the end of it, and rocking the wheel must not be able to flash that over 3 times a second.
const PAUSE_S = 0.5;            // A gesture has stopped after this long: long enough to span slow, single notches
const SETTLE_MIN_S = 0.3;       // The move's rest takes this long...
const SETTLE_PER_T_S = 1.5;     // ... and this much more for the whole of it
const NEAR_END_LEAN = 0.1;      // Which end is nearer leans this much of the way along towards where the gesture was going
const REDUCED_THRESHOLD = 0.3;  // Reduce motion: a zoom this much past the point (log of the field of view), then a fade
const REDUCED_FORGET_S = 0.6;
const SAY_WAITING_S = 0.6;      // A wait as long as this gets a word in the context bar

// Where the gesture has got to, as a goal that t eases to at the speed the sky's own zoom eases to the wheel's goal
function createHand(t) {
    const hand = {
        goal: t,
        heading: 0,         // +1 inwards, -1 outwards
        quiet: 0,           // Seconds since the last step
        settling: null,
        push(log) {
            hand.goal = Math.max(0, Math.min(1, hand.goal - log / HAND_LOG));
            hand.heading = log < 0 ? 1 : -1;
            hand.quiet = 0;
            hand.settling = null;
        },
        // A finger still down holds the move where it is
        hold() { hand.quiet = 0; },
        advance(now, dt) {
            hand.quiet += dt;
            if (hand.settling) {
                const s = hand.settling;
                s.time += dt;
                const k = smootherstep(0, s.duration, s.time);
                const next = s.from + (s.to - s.from) * k;
                hand.goal = s.time >= s.duration ? s.to : next;
                return hand.goal;
            }
            if (hand.quiet >= PAUSE_S && now > 0 && now < 1 && Math.abs(hand.goal - now) < 0.004) {
                const to = now + hand.heading * NEAR_END_LEAN >= 0.5 ? 1 : 0;
                hand.settling = { from: now, to, time: 0, duration: SETTLE_MIN_S + SETTLE_PER_T_S * Math.abs(to - now) };
                hand.heading = to ? 1 : -1;
                return now;
            }
            const most = MOST_PER_S * dt;
            const next = now + Math.max(-most, Math.min(most, (hand.goal - now) * (1 - Math.exp(-dt * ZOOM_RATE))));
            return Math.abs(hand.goal - next) < 1e-3 ? hand.goal : next;
        },
        // Which way it's going, as the view's modes name it
        modeAt(now, mode) {
            const to = hand.settling ? hand.settling.to : hand.goal;
            if (to > now) return 'enter';
            if (to < now) return 'exit';
            return now >= 1 ? 'enter' : now <= 0 ? 'exit' : mode;
        }
    };
    return hand;
}

// view: what the system view lends this. prepare(code), isReady(code), dropReady(), beginIn(code, hand, kind),
// beginOut(hand), hasReady(), enter(code), exit()
export function createZoomInto(app, view) {
    const engine = app.engine;
    let aim = null;             // { code, fov, seen, alone }: the star a zoom is headed for, and how it stands
    let lookedAt = -Infinity;
    let lastIn = -Infinity;     // performance.now of the last step inwards
    let point = null;
    let kind = 'wheel';
    let readyIdle = 0;          // Seconds a system has been kept ready with no zoom going on
    let pressure = 0;           // Reduce motion: how far past the point the zoom has gone
    let pressureQuiet = 0;
    let waited = 0;             // Seconds at the point of going in, with the system not ready yet
    let saidWaiting = false;

    const reduced = () => !!app.settings.reduceMotion;

    function systemOf(resolved) {
        return resolved ? app.system.systemOf(resolved) : null;
    }

    // The field of view at which the sky has shown all it has of this system
    function handOverFov(system, frame) {
        if (system.black_hole) return LENS_FOV;
        const binaries = engine.getLayer('binaries');
        const apart = binaries && binaries.fovApart ? binaries.fovApart(system.code, frame) : 0;
        return apart ? Math.max(LIMIT_FOV, Math.min(CAPTURE_FOV, apart * APART_MARGIN)) : CAPTURE_FOV;
    }

    function pointsAtAnother(system, code, radiusPx) {
        if (radiusPx > 12) return true;     // Big and soft: stars are seen against it, not lost in it
        const found = app.universe.resolve(code);
        if (!found) return true;
        if (found.body.code === system.code || found.entity.code === system.code) return true;
        // A big thing is offered as a scatter of points so that a click anywhere finds it
        return found.path === 'body' && !(found.body.star || found.body.stars || found.body.black_hole || found.body.neutron_star);
    }

    function isClear(system, frame) {
        const at = engine.projectBody(system);
        if (!at) return false;
        const other = engine.pick(at.x, at.y, frame.height * CLEAR_SHARE, (code, radiusPx) => pointsAtAnother(system, code, radiusPx));
        return !other;
    }

    function findSystem(frame) {
        const at = point || { x: frame.width / 2, y: frame.height / 2 };
        const code = engine.pick(at.x, at.y, POINT_PX[kind] || POINT_PX.wheel);
        // Whatever is being pointed at decides, and if it isn't a system there is nothing to enter
        if (code) return systemOf(app.universe.resolve(code));
        const selected = systemOf(app.selected);
        if (selected) {
            const p = engine.projectBody(selected);
            if (p && p.onScreen) return selected;
        }
        // A pointer well off to one side is aiming there, at empty sky, and that's where the zoom is going
        if (Math.hypot(at.x - frame.width / 2, at.y - frame.height / 2) > frame.height * POINTER_NEAR_CENTRE_SHARE) return null;
        const near = engine.pick(frame.width / 2, frame.height / 2, frame.height * NEAR_CENTRE_SHARE);
        return near ? systemOf(app.universe.resolve(near)) : null;
    }

    function look(now) {
        if (now - lookedAt < LOOK_EVERY_MS) return;
        lookedAt = now;
        // Too wide for anything to be getting ready: don't sweep at all
        if (engine.view.fov > CAPTURE_FOV * READY_AHEAD) {
            aim = null;
            return;
        }
        const frame = engine.currentFrame();
        const system = findSystem(frame);
        if (!system) {
            aim = null;
            return;
        }
        const fov = handOverFov(system, frame);
        aim = {
            code: system.code,
            fov,
            seen: engine.glowOf(system) >= SEEN_GLOW,
            alone: engine.view.fov <= CAPTURE_FOV && isClear(system, frame)
        };
    }

    function atThePoint() {
        if (!aim || engine.isSlewing() || engine.isPressed()) return false;
        const { fov } = engine.view;
        return fov <= aim.fov && ((aim.alone && aim.seen) || fov <= LIMIT_FOV);
    }

    function canBegin() {
        return atThePoint() && view.isReady(aim.code);
    }

    // A slow machine: the sky has zoomed as far as it can, or as far as it should, while shaders compile
    function sayIfWaiting(going, dt) {
        waited = going && atThePoint() && !view.isReady(aim.code) ? waited + dt : 0;
        const say = waited >= SAY_WAITING_S;
        if (say !== saidWaiting) {
            saidWaiting = say;
            bus.emit('zoomwait', { waiting: say });
        }
    }

    function beginIn(extraLog) {
        const hand = createHand(0);
        hand.push(engine.takeZoomLeft() + extraLog);
        view.beginIn(aim.code, hand, kind);
        aim = null;
    }

    function intake(step, at, stepKind) {
        if (app.view !== 'sky') return false;
        const now = performance.now();
        if (step >= 0) {
            lastIn = -Infinity;
            aim = null;
            pressure = 0;
            return false;
        }
        if ((!at !== !point) || (at && Math.hypot(at.x - point.x, at.y - point.y) > POINT_MOVED_PX)) lookedAt = -Infinity;
        point = at;
        kind = stepKind;
        lastIn = now;
        look(now);
        engine.setWheelBoost(aim && aim.alone && stepKind === 'wheel' ? RUN_UP_BOOST : 1);
        if (!canBegin()) return false;
        if (reduced()) {
            // No flight to scrub: a little more zoom, then a fade, with the sky holding still until then
            pressure -= step;
            pressureQuiet = 0;
            if (pressure >= REDUCED_THRESHOLD) {
                pressure = 0;
                engine.takeZoomLeft();
                view.enter(aim.code);
                aim = null;
            }
            return true;
        }
        beginIn(step);
        return true;
    }

    // Zooming out past the system's outermost distance
    function zoomedOutPast(log) {
        if (reduced()) {
            pressure += log;
            pressureQuiet = 0;
            if (pressure >= REDUCED_THRESHOLD) {
                pressure = 0;
                view.exit();
            }
            return;
        }
        const hand = createHand(1);
        hand.push(log);
        view.beginOut(hand);
    }

    engine.setZoomIntake(intake);
    engine.addLayer({
        id: 'zoom-into',
        update(frame) {
            pressureQuiet += frame.dt;
            if (pressureQuiet > REDUCED_FORGET_S) pressure = 0;
            const now = performance.now();
            const going = app.view === 'sky' && now - lastIn < GESTURE_GONE_MS;
            sayIfWaiting(going, frame.dt);
            if (app.view !== 'sky') {
                readyIdle = 0;
                return;
            }
            if (going) {
                look(now);
                readyIdle = 0;
                if (aim && engine.view.fov <= aim.fov * READY_AHEAD) {
                    view.prepare(aim.code);
                    bus.emit('zoomaim', { code: aim.code });
                }
                // A notch's own easing can carry the view past the point, with no new step to notice it
                if (!reduced() && engine.zoomIsEasing() && canBegin()) beginIn(0);
            } else if (view.hasReady()) {
                readyIdle += frame.dt;
                if (readyIdle > KEEP_READY_S) {
                    view.dropReady();
                    readyIdle = 0;
                }
            }
        }
    });

    return { zoomedOutPast };
}
