// The one play/pause/speed control used by everything that changes with time: line shifts, pulsar pulses,
// supernova evolution, orbits. There is no global clock: each control keeps its own time.
//
//   const pb = createPlayback(container, { label, speeds: [...], speed, unit: 'days', onTick(t, dt) });
//   pb.t, pb.setTime(t), pb.play(), pb.pause(), pb.dispose()
//
// `t` advances by (real seconds) * (speed), so speeds are "units per second" in the given unit.

export function createPlayback(container, opts) {
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

    const api = {
        t: opts.t0 || 0,
        el,
        get playing() { return playing; },
        setTime(t) {
            api.t = t;
            if (opts.onTick) opts.onTick(api.t, 0);
        },
        play() {
            if (playing) return;
            playing = true;
            last = performance.now();
            paint();
            raf = requestAnimationFrame(tick);
        },
        pause() {
            playing = false;
            if (raf) cancelAnimationFrame(raf);
            raf = null;
            paint();
        },
        dispose() {
            api.pause();
            el.remove();
        }
    };

    // The word changes with the icon, so the button's name always says what it will do
    const playIcon = document.createElement('span');
    playIcon.setAttribute('aria-hidden', 'true');
    const playWord = document.createElement('span');
    playBtn.append(playIcon, playWord);

    function paint() {
        playIcon.className = `icon solid ${playing ? 'fa-pause' : 'fa-play'}`;
        playWord.textContent = playing ? 'Pause' : 'Play';
    }

    function tick(now) {
        if (!playing) return;
        raf = requestAnimationFrame(tick);
        const dt = Math.min(0.1, (now - last) / 1000) * Number(speedSelect.value);
        last = now;
        api.t += dt;
        if (opts.onTick) opts.onTick(api.t, dt);
    }

    playBtn.addEventListener('click', () => (playing ? api.pause() : api.play()));
    paint();
    if (opts.autoplay) api.play();
    return api;
}
