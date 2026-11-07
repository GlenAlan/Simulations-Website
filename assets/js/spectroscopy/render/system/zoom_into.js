// Zooming on a star carries on into its system, and zooming back out comes home again: one gesture, with no button.
//
// The engine shows this every zoom step before the sky gets it (setZoomIntake). While a star is what's being zoomed into,
// this works out which star that is, gets its system ready in the background, and takes over when the time comes. From
// then on the gesture moves the flight (see "under a student's hand" in transition.js). A short pause holds it, and a long
// one finishes it the way it was going (see createHand). The sky keeps zooming until the system is ready, so a slow machine
// waits but never freezes.
//
// When the move begins:
//   What's being zoomed into has to be the only thing in play. A star qualifies at a field of view of CAPTURE_FOV or less,
//   once nothing else star-like is within CLEAR_SHARE of the view's height of it. Until then the sky goes on zooming as usual.
//   So a lone star hands over early, and one in a crowded field or among a cluster's members only once it stands apart.
//   Whatever the sky still has to show comes first: a multiple's stars have to come apart, a black hole shows its lens, and a
//   faint star has to be showing properly. With only that one thing in play, a wheel covers the way down in fewer notches.
//   At the sky's zoom limit, whatever is left and being pointed at can be entered.
// Which star: the one under the pointer, or else the selected one if it's on show, or else one near the centre of the view.
// Pointing at something that isn't a system, such as a galaxy, means no capture at all. A galaxy's own black hole is one,
// once the galaxy is big enough for its point to be picked: it hands over once the galaxy fills the view.
//
// Zooming in on one takes no panel with it: a panel already open on something else moves to it on arrival, and otherwise the
// context bar names the system and opens its panel in one click.

import { MIN_FOV } from '../../core/sky.js';
import { bus } from '../../core/state.js';
import { ZOOM_RATE } from '../engine.js';
import { HAND_LOG, smootherstep, handSeen, handTAt } from './transition.js';

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
const HOLD_S = 0.9;             // A pause this short holds the move where it is, so that slow notches add up
const COMMIT = 0.06;            // A pause with less of the move done than this goes back to where it began: a nudge, not a choice
const SETTLE_MIN_S = 0.3;       // The move's rest takes this long...
const SETTLE_PER_T_S = 1.5;     // ... and this much more for the whole of it
const REDUCED_THRESHOLD = 0.3;  // Reduce motion: a zoom this much past the point (log of the field of view), then a fade
const REDUCED_FORGET_S = 0.6;
const SAY_WAITING_S = 0.6;      // A wait as long as this gets a word in the context bar
const ENTRY_SCAN_STEP = 0.6;    // entryFov: the steps it looks down in...
const ENTRY_SPLITS = 3;         // ...and how many times the last of them is halved, to within about half a wheel's notch
const ENTRY_BUDGET_MS = 60;     // ...in about this long, as it holds up the frame a double-click is in

// Where the gesture has got to. It moves seen progress (see transition.js), so that every notch shows, and eases to it at the
// speed the sky's own zoom eases to the wheel's goal. A short pause holds it there, so a slow, deliberate student still gets
// in a notch at a time. Stopped for longer half way, where neither the sky nor the system is properly on show, it finishes
// the move the way the student was going, unless they had barely started it.
function createHand(t) {
    const hand = {
        seenGoal: handSeen(t),
        heading: t >= 1 ? -1 : 1,   // +1 inwards, -1 outwards: away from the end it starts at, until a step says otherwise
        quiet: 0,                   // Seconds since the last step
        settling: null,
        get goal() { return handTAt(hand.seenGoal); },
        push(log) {
            hand.seenGoal = Math.max(0, Math.min(1, hand.seenGoal - log / HAND_LOG));
            if (log) hand.heading = log < 0 ? 1 : -1;
            hand.quiet = 0;
            hand.settling = null;
        },
        // A finger still down holds the move where it is
        hold() { hand.quiet = 0; },
        advance(now, dt) {
            hand.quiet += dt;
            const seen = handSeen(now);
            if (hand.settling) {
                const s = hand.settling;
                s.time += dt;
                const k = smootherstep(0, s.duration, s.time);
                hand.seenGoal = s.time >= s.duration ? s.to : s.from + (s.to - s.from) * k;
                return handTAt(hand.seenGoal);
            }
            if (hand.quiet >= HOLD_S && now > 0 && now < 1 && Math.abs(hand.seenGoal - seen) < 0.004) {
                const done = hand.heading < 0 ? 1 - seen : seen;
                const forward = done >= COMMIT ? hand.heading : -hand.heading;
                const to = forward > 0 ? 1 : 0;
                hand.settling = { from: seen, to, time: 0, duration: SETTLE_MIN_S + SETTLE_PER_T_S * Math.abs(to - seen) };
                hand.heading = forward;
                return now;
            }
            const most = MOST_PER_S * dt;
            const next = seen + Math.max(-most, Math.min(most, (hand.seenGoal - seen) * (1 - Math.exp(-dt * ZOOM_RATE))));
            return handTAt(Math.abs(hand.seenGoal - next) < 1e-3 ? hand.seenGoal : next);
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
    const drawn = { az: 0, alt: 0, fov: 0, ok: false }; // The view the sky was last drawn at

    const reduced = () => !!app.settings.reduceMotion;

    function systemOf(resolved) {
        return resolved ? app.system.systemOf(resolved) : null;
    }

    // The field of view at which the sky has shown all it has of this system
    function handOverFov(system, frame) {
        if (system.black_hole) return LENS_FOV;
        // A pulsar's beams turn on the sky first, so that the student sees the same turn carry on up close
        if (system.neutron_star && system.neutron_star.pulsar) {
            const pulsars = engine.getLayer('neutron_stars');
            const fov = pulsars && pulsars.beamsFov ? pulsars.beamsFov(system.code, frame) : 0;
            if (fov) return Math.max(LIMIT_FOV, Math.min(CAPTURE_FOV, fov));
        }
        // A galaxy's black hole: once the galaxy fills the view (render/layers/galaxies.js)
        if (system.kind === 'nucleus') {
            const galaxies = engine.getLayer('galaxies');
            const fov = galaxies && galaxies.nucleusFov ? galaxies.nucleusFov(system.code) : LIMIT_FOV;
            return Math.max(LIMIT_FOV, Math.min(CAPTURE_FOV, fov));
        }
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

    // The system a zoom pointing here goes into: what the pointer is on, or null if that isn't one; undefined if it's on
    // nothing. Something big and soft round the selection can win the pick at its middle (deep in a globular, its glow does
    // at the middle of a pair that has come apart), so the selection counts too, if it's drawn right at the pointer.
    function systemAt(at, reach) {
        const code = engine.pick(at.x, at.y, reach);
        if (!code) return undefined;
        const system = systemOf(app.universe.resolve(code));
        if (system) return system;
        const selected = systemOf(app.selected);
        const p = selected && engine.projectBody(selected);
        return p && Math.hypot(p.x - at.x, p.y - at.y) <= reach ? selected : null;
    }

    function findSystem(frame) {
        const at = point || { x: frame.width / 2, y: frame.height / 2 };
        const found = systemAt(at, POINT_PX[kind] || POINT_PX.wheel);
        // Whatever is being pointed at decides, and if it isn't a system there is nothing to enter
        if (found !== undefined) return found;
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
            // A galaxy's black hole is only offered once its point is on show, so it's seen already
            seen: system.kind === 'nucleus' || engine.glowOf(system) >= SEEN_GLOW,
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

    // A notch's easing has already moved the sky this frame by the time this sees the point has been passed. The move starts
    // from where the sky was last drawn instead, as that is the view the student saw and the one that must come back to
    // every digit, and the step the easing took goes into the move with the rest of the zoom.
    function beginInFromDrawn() {
        const left = engine.takeZoomLeft();
        let taken = 0;
        if (drawn.ok) {
            taken = Math.log(engine.view.fov / drawn.fov);
            engine.flyView(drawn.az, drawn.alt, drawn.fov);
            // flyView tidies the azimuth into 0 to 360, which can change its last digit: keep the digits as they were drawn
            engine.view.az = drawn.az;
            engine.view.alt = drawn.alt;
            engine.view.fov = drawn.fov;
        }
        beginIn(left + taken);
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

    // Would a zoom at this field of view, pointing at the system, carry on into it? As look() and atThePoint() would judge it
    // there, from a view centred on it that is never drawn.
    function wouldEnter(system, fov) {
        const { width, height } = engine.currentFrame();
        const centre = engine.axisPutting(system.sky.az, system.sky.alt, width / 2, height / 2, fov);
        return engine.atView({ az: centre.az, alt: centre.alt, fov }, () => {
            const frame = engine.currentFrame();
            const at = engine.projectBody(system);
            if (!at || !at.onScreen || engine.view.fov > handOverFov(system, frame)) return false;
            // The cheap questions first: each pick is a sweep through everything in the sky
            if (engine.view.fov > LIMIT_FOV) {
                const seen = system.kind === 'nucleus' || engine.glowOf(system) >= SEEN_GLOW;
                if (!seen || engine.view.fov > CAPTURE_FOV || !isClear(system, frame)) return false;
            }
            const found = systemAt(at, POINT_PX.wheel);
            return !!found && found.code === system.code;
        });
    }

    // The widest field of view, no wider than `widest`, at which a zoom pointing at this object carries on into its system,
    // or null if none would: a double-click's flight stops a little short of it (ui/goto.js). The way down is scanned from
    // the widest it could be, then the last step is split a few times.
    function entryFov(code, widest = Infinity) {
        const system = systemOf(app.universe.resolve(code));
        if (!system || app.view !== 'sky') return null;
        const frame = engine.currentFrame();
        let fov = Math.max(LIMIT_FOV, Math.min(handOverFov(system, frame), CAPTURE_FOV, widest));
        // A faint star isn't offered until it shows well enough, and its glow goes as the square of the zoom
        if (system.kind !== 'nucleus') {
            const glow = engine.glowOf(system);
            if (glow > 0) fov = Math.max(LIMIT_FOV, Math.min(fov, engine.view.fov * Math.sqrt(glow / SEEN_GLOW) * 0.999));
        }
        let wider = null;
        const started = performance.now();
        while (!wouldEnter(system, fov)) {
            if (fov <= LIMIT_FOV) return null;
            wider = fov;
            fov = Math.max(LIMIT_FOV, fov * ENTRY_SCAN_STEP);
            // Deep in a globular every look is a sweep through thousands of stars: past the budget, only the deepest zoom is
            // asked about, where whatever is pointed at goes in
            if (performance.now() - started > ENTRY_BUDGET_MS && fov > LIMIT_FOV) {
                return wouldEnter(system, LIMIT_FOV) ? LIMIT_FOV : null;
            }
        }
        for (let i = 0; wider && i < ENTRY_SPLITS && performance.now() - started <= ENTRY_BUDGET_MS; i++) {
            const mid = Math.sqrt(fov * wider);
            if (wouldEnter(system, mid)) fov = mid;
            else wider = mid;
        }
        return fov;
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
                drawn.ok = false;
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
                if (!reduced() && engine.zoomIsEasing() && canBegin()) beginInFromDrawn();
            } else if (view.hasReady()) {
                readyIdle += frame.dt;
                if (readyIdle > KEEP_READY_S) {
                    view.dropReady();
                    readyIdle = 0;
                }
            }
            // The view this frame is drawn at, for the next one to start a move from
            const v = engine.view;
            drawn.az = v.az;
            drawn.alt = v.alt;
            drawn.fov = v.fov;
            drawn.ok = app.view === 'sky';
        }
    });

    return { zoomedOutPast, entryFov };
}
