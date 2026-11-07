// The one play/pause/speed control used by everything that changes with time: line shifts, pulsar pulses,
// supernova evolution, orbits. There is no global clock: each control keeps its own time.
//
//   const pb = createPlayback(container, { label, speeds: [...], speed, unit: 'days', onTick(t, dt) });
//   pb.t, pb.speed, pb.playing, pb.setTime(t), pb.play(), pb.pause(), pb.dispose()
//
// `t` advances by (real seconds) * (speed), so speeds are "units per second" in the given unit.
//
// Instead of a list of speeds, opts.range = { min, max } gives a slider running evenly through the ratios between them,
// for a range too wide for a list, and opts.words(speed) says a speed in words. opts.onChange() hears about a new speed
// or play state, and opts.scale(), if there is one, holds the clock back by that factor for the moment.
//
// With opts.clock (a clock shared between views: { t, playing, speed, setTime, play, pause, setSpeed, onTime, onState })
// the control keeps no time of its own: it plays, pauses and shows that clock, along with every other control on it.
// onTick still runs whenever the clock moves.

const STEPS_PER_DOUBLING = 3;   // One press of an arrow key on the slider

export function createPlayback(container, opts) {
    const clock = opts.clock || null;
    const speeds = opts.speeds || [0.25, 1, 4, 16];
    const unit = opts.unit || 'days';
    const singular = unit.endsWith('s') ? unit.slice(0, -1) : unit;
    const el = document.createElement('div');
    el.className = 'spectro-playback';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', opts.label || 'Playback');

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'spectro-play';
    el.append(playBtn);

    let speedNow = clock ? clock.speed : opts.speed ?? speeds[0];
    let speedSelect = null;
    let slider = null;
    let sliderText = null;
    let steps = 1;

    function stepOf(s) {
        const { min, max } = opts.range;
        return Math.round((Math.log(Math.max(s, min) / min) / Math.log(max / min)) * steps);
    }

    function paintSlider() {
        const words = opts.words ? opts.words(speedNow) : `${speedNow} ${unit}/s`;
        sliderText.textContent = words;
        slider.setAttribute('aria-valuetext', words);
    }

    function choose(speed) {
        speedNow = speed;
        if (clock) clock.setSpeed(speed);
        else if (opts.onChange) opts.onChange();
    }

    if (opts.range) {
        const { min, max } = opts.range;
        steps = Math.max(24, Math.round(Math.log2(max / min) * STEPS_PER_DOUBLING));
        slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = String(steps);
        slider.step = '1';
        slider.value = String(stepOf(speedNow));
        slider.setAttribute('aria-label', 'Speed');
        sliderText = document.createElement('span');
        sliderText.className = 'spectro-play-speed';
        slider.addEventListener('input', () => {
            speedNow = min * (max / min) ** (Number(slider.value) / steps);
            paintSlider();
            choose(speedNow);
        });
        const row = document.createElement('div');
        row.className = 'spectro-play-slider';
        row.append(slider, sliderText);
        el.append(row);
        paintSlider();
    } else {
        speedSelect = document.createElement('select');
        speedSelect.setAttribute('aria-label', `Speed in ${unit} per second`);
        speeds.forEach((s) => {
            const o = document.createElement('option');
            o.value = String(s);
            o.textContent = `${s} ${s === 1 ? singular : unit}/s`;
            speedSelect.appendChild(o);
        });
        speedSelect.value = String(speedNow);
        speedSelect.addEventListener('change', () => choose(Number(speedSelect.value)));
        el.append(speedSelect);
    }
    container.appendChild(el);

    let raf = null;
    let last = 0;
    let playing = false;
    const offClock = [];

    const api = {
        t: clock ? clock.t : opts.t0 || 0,
        el,
        button: playBtn,
        get playing() { return clock ? clock.playing : playing; },
        get speed() { return speedNow; },
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
            if (opts.onChange) opts.onChange();
        },
        pause() {
            if (clock) {
                clock.pause();
                return;
            }
            const was = playing;
            playing = false;
            if (raf) cancelAnimationFrame(raf);
            raf = null;
            paint();
            if (was && opts.onChange) opts.onChange();
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
        const dt = Math.min(0.1, (now - last) / 1000) * speedNow * (opts.scale ? opts.scale() : 1);
        last = now;
        api.t += dt;
        if (opts.onTick) opts.onTick(api.t, dt);
    }

    // The clock's speed may have been set by another control, with a list of its own: offer it here as well
    function showClockSpeed() {
        speedNow = clock.speed;
        if (slider) {
            slider.value = String(stepOf(speedNow));
            paintSlider();
            return;
        }
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
        offClock.push(clock.onState(() => {
            paint();
            showClockSpeed();
            if (opts.onChange) opts.onChange();
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
