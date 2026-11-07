// The one play/pause/speed control used by everything that changes with time: line shifts, pulsar pulses,
// supernova evolution, orbits. There is no global clock: each control keeps its own time.
//
//   const pb = createPlayback(container, { label, speeds: [...], speed, unit: 'days', onTick(t, dt) });
//   pb.t, pb.setTime(t), pb.play(), pb.pause(), pb.dispose()
//
// `t` advances by (real seconds) * (speed), so speeds are "units per second" in the given unit.
//
// With opts.clock (a multi-star system's clock, ui/spectrum/tools/orbit_clock.js) the control keeps no time of its own: it
// plays, pauses and shows that clock, along with every other control on it. onTick still runs whenever the clock moves.

export function createPlayback(container, opts) {
    const clock = opts.clock || null;
    const speeds = opts.speeds || [0.25, 1, 4, 16];
    const unit = opts.unit || 'days';
    const el = document.createElement('div');
    el.className = 'spectro-playback';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', opts.label || 'Playback');

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'spectro-play';
    const speedSelect = document.createElement('select');
    speedSelect.setAttribute('aria-label', `Speed in ${unit} per second`);
    speeds.forEach((s) => {
        const o = document.createElement('option');
        o.value = String(s);
        o.textContent = `${s} ${unit}/s`;
        speedSelect.appendChild(o);
    });
    speedSelect.value = String(opts.speed ?? speeds[0]);
    el.append(playBtn, speedSelect);
    container.appendChild(el);

    let raf = null;
    let last = 0;
    let playing = false;

    const offClock = [];

    const api = {
        t: clock ? clock.t : opts.t0 || 0,
        el,
        get playing() { return clock ? clock.playing : playing; },
        setTime(t) {
            if (clock) {
                clock.setTime(t);
                return;
            }
            api.t = t;
            if (opts.onTick) opts.onTick(api.t, 0);
        },
        play() {
            if (clock) {
                clock.play();
                return;
            }
            if (playing) return;
            playing = true;
            last = performance.now();
            paint();
            raf = requestAnimationFrame(tick);
        },
        pause() {
            if (clock) {
                clock.pause();
                return;
            }
            playing = false;
            if (raf) cancelAnimationFrame(raf);
            raf = null;
            paint();
        },
        dispose() {
            // A control on a shared clock can go without stopping it
            if (clock) offClock.forEach((off) => off());
            else api.pause();
            el.remove();
        }
    };

    // The word changes with the icon, so the button's name always says what it will do
    const playIcon = document.createElement('span');
    playIcon.setAttribute('aria-hidden', 'true');
    const playWord = document.createElement('span');
    playBtn.append(playIcon, playWord);

    function paint() {
        const on = api.playing;
        playIcon.className = `icon solid ${on ? 'fa-pause' : 'fa-play'}`;
        playWord.textContent = on ? 'Pause' : 'Play';
    }

    function tick(now) {
        if (!playing) return;
        raf = requestAnimationFrame(tick);
        const dt = Math.min(0.1, (now - last) / 1000) * Number(speedSelect.value);
        last = now;
        api.t += dt;
        if (opts.onTick) opts.onTick(api.t, dt);
    }

    // The clock's speed may have been set by another control, with a list of its own: offer it here as well
    function showClockSpeed() {
        const value = String(clock.speed);
        const known = [...speedSelect.options].some((o) => Number(o.value) === clock.speed);
        if (!known) {
            const o = document.createElement('option');
            o.value = value;
            o.textContent = `${Number(clock.speed.toPrecision(3))} ${unit}/s`;
            const after = [...speedSelect.options].find((other) => Number(other.value) > clock.speed);
            speedSelect.insertBefore(o, after || null);
        }
        if (Number(speedSelect.value) !== clock.speed) speedSelect.value = value;
    }

    if (clock) {
        showClockSpeed();
        speedSelect.addEventListener('change', () => clock.setSpeed(Number(speedSelect.value)));
        offClock.push(clock.onState(() => {
            paint();
            showClockSpeed();
        }));
        offClock.push(clock.onTime((t) => {
            api.t = t;
            if (opts.onTick) opts.onTick(t, 0);
        }));
    }

    playBtn.addEventListener('click', () => (api.playing ? api.pause() : api.play()));
    paint();
    if (opts.autoplay) api.play();
    return api;
}
