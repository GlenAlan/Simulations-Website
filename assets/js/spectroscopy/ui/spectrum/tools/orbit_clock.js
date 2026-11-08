// The one clock of a multi-star system. The orbit in the system view, the same system in the sky, its spectrum and the
// tools all read this, so they can't disagree: pressing Play in any of them runs them all, and opening or closing a tool
// leaves it alone. Everything else hears the time through the bus's 'timeline' event, which only a clock sends for these
// systems. A control is createPlayback(container, { clock, speeds, ... }).
//
// Time itself is always continuous, at any speed: a slow outer orbit has to move smoothly even while a close pair goes round
// far too fast to draw. What would strobe if it moved that fast (a spectrum's lines, the dial, a readout) uses the stepped
// reading, which is the same time up to MAX_TURNS_PER_S of the shortest orbit, and above that changes 2.5 times a second.
//
//   const clock = clockFor(body);
//   clock.t (continuous), clock.steppedT(), clock.playing, clock.speed (days per second), clock.fastest (the shortest
//   period in the system, days), clock.smoothMax (the speed at MAX_TURNS_PER_S)
//   clock.setTime(t), clock.play(), clock.pause(), clock.setSpeed(s)
//   clock.onTime(fn(t)) -> remove     every change of the continuous time
//   clock.onStep(fn(t)) -> remove     every change of the stepped reading
//   clock.onState(fn()) -> remove     playing or paused, and speed
//   toWidestSplit(body, play)         the clock moved on to when the lines are furthest apart, and started

import { bus } from '../../../core/state.js';
import { widestSplit } from './split_lines.js';
import { danceTimescale } from '../../../data/unstable.js';

// The limit on showing an orbit as it happens. Lines cross twice a turn, so this is two crossings a second: under the
// rule of no more than three changes a second.
export const MAX_TURNS_PER_S = 1;
const STEP_MS = 400;             // 2.5 changes a second
const FALLBACK_PERIOD_DAYS = 10; // A system with no period to go on, which shouldn't happen

function fastestPeriod(body) {
    if (body.unstable) return danceTimescale(body);      // No period: its lines swing on its crossing time
    const periods = [];
    if (body.black_hole) periods.push(body.black_hole.period_days);
    if (body.figure_eight) periods.push(body.figure_eight.period_days);
    (body.orbits || []).forEach((orbit) => { if (orbit.period_days > 0) periods.push(orbit.period_days); });
    return periods.length ? Math.min(...periods) : FALLBACK_PERIOD_DAYS;
}

function makeClock(body) {
    const { code } = body;
    const fastest = fastestPeriod(body);
    const timeFns = new Set();
    const stepFns = new Set();
    const stateFns = new Set();
    let raf = 0;
    let last = 0;
    let reading = 0;
    let lastStep = 0;

    function step(now) {
        reading = clock.t;
        lastStep = now;
        stepFns.forEach((fn) => fn(reading));
    }

    function send(now, exact) {
        const stepping = exact || clock.speed <= clock.smoothMax || now - lastStep >= STEP_MS;
        // The bus carries both, for a listener that draws a close pair too small to smooth out: a point of light can't be averaged
        bus.emit('timeline', { code, t_days: clock.t, stepped_t_days: stepping ? clock.t : reading });
        timeFns.forEach((fn) => fn(clock.t));
        if (stepping) step(now);
    }

    function sayState() {
        stateFns.forEach((fn) => fn());
    }

    function tick(now) {
        raf = requestAnimationFrame(tick);
        clock.t += (Math.min(100, now - last) / 1000) * clock.speed * clock.governor;
        last = now;
        send(now, false);
    }

    const clock = {
        code,
        t: 0,
        playing: false,
        speed: fastest / 6,
        // Below 1 while the system view holds the clock back, for stars in no stable orbit (render/system/dance_model.js)
        governor: 1,
        fastest,
        smoothMax: fastest * MAX_TURNS_PER_S,
        steppedT: () => reading,
        setTime(t) {
            clock.t = t;
            send(performance.now(), true);
        },
        play() {
            if (clock.playing) return;
            clock.playing = true;
            last = performance.now();
            raf = requestAnimationFrame(tick);
            sayState();
        },
        pause() {
            if (!clock.playing) return;
            clock.playing = false;
            cancelAnimationFrame(raf);
            raf = 0;
            // Stepping, it may have run on past what was last shown
            step(performance.now());
            sayState();
        },
        setSpeed(speed) {
            if (!(speed > 0) || speed === clock.speed) return;
            clock.speed = speed;
            sayState();
        },
        onTime(fn) {
            timeFns.add(fn);
            return () => timeFns.delete(fn);
        },
        onStep(fn) {
            stepFns.add(fn);
            return () => stepFns.delete(fn);
        },
        onState(fn) {
            stateFns.add(fn);
            return () => stateFns.delete(fn);
        }
    };
    return clock;
}

const clocks = new Map();

export function clockFor(body) {
    let clock = clocks.get(body.code);
    if (!clock) {
        clock = makeClock(body);
        clocks.set(body.code, clock);
    }
    return clock;
}

// See the lines split: the clock set to the next moment its stars' lines are furthest apart, and playing unless asked not to
export function toWidestSplit(body, play = true) {
    const clock = clockFor(body);
    clock.setTime(widestSplit(body, clock.t, clock.fastest));
    if (play) clock.play();
    return clock;
}
