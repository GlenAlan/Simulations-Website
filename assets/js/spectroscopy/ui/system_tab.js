// The System tab: orbit time and scale, the list of planets, and each planet's orbit with Kepler's third law checked
// out loud. The playback is created when a system opens, not when the tab first shows, so the orbits run whether or not
// the drawer is open; the tab just gives it a home.

import { bus, select, setLayer } from '../core/state.js';
import { sig, sci } from '../core/format.js';
import { createPlayback } from './playback.js';
import { hasSystemView, hzStatus, buildModel, keplerReadout, speedsFor } from '../render/system/system_model.js';
import { clockFor } from './spectrum/tools/orbit_clock.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function timeText(days) {
    if (days < 1) return `${sig(days * 24, 3)} hours`;
    if (days < 730) return `${sig(days, 3)} days`;
    return `${sig(days / 365.25, 3)} years`;
}

function row(list, label, value) {
    const dt = el('dt', '', label);
    const dd = el('dd', '', value);
    list.append(dt, dd);
    return dd;
}

export function initSystemTab(app) {
    const view = app.system;

    // Lives as long as the system is open, wherever the tab is
    const timeBox = el('div', 'spectro-system-playback');
    let playback = null;
    let systemClock = null;
    let resolved = null;
    let parts = null;
    let modelCache = null;      // For readouts while still in the sky
    let ownTick = false;

    function modelFor(body) {
        const open = view.getModel();
        if (open && open.body === body) return open;
        if (!modelCache || modelCache.body !== body) modelCache = buildModel(body);
        return modelCache;
    }

    function startPlayback(model) {
        stopPlayback();
        const { speeds, speed } = speedsFor(model);
        // Stars' orbits run on the clock the spectrum shares; a single star's planets need only this control
        const { body } = model;
        systemClock = (body.orbits && body.orbits.length) || body.black_hole ? clockFor(body) : null;
        if (systemClock && !systemClock.playing) systemClock.setSpeed(speed);
        playback = createPlayback(timeBox, {
            label: 'Orbit time',
            speeds,
            speed,
            unit: 'days',
            t0: view.getTime(),
            clock: systemClock,
            onTick(t) {
                ownTick = true;
                if (!systemClock) bus.emit('timeline', { code: model.code, t_days: t });
                ownTick = false;
                paintTime();
            }
        });
        if (systemClock) systemClock.setTime(systemClock.t); // The view takes up this system's time from its clock
        if (!app.settings.reduceMotion) playback.play();
    }

    function stopPlayback() {
        if (playback) playback.dispose();
        playback = null;
        if (systemClock) systemClock.pause();
        systemClock = null;
    }

    let lastPaint = 0;
    function paintTime() {
        if (!parts || !playback) return;
        const now = performance.now();
        if (now - lastPaint < 150) return;
        lastPaint = now;
        parts.time.textContent = `Time passed: ${timeText(Math.max(0, playback.t))}`;
    }

    function selectFromList(code) {
        select(code);
        if (app.view === 'system') view.focusPlanet(code);
        else app.drawer.selectTab('system');
    }

    function buildParts(container) {
        const box = el('div', 'spectro-system-tab');

        const summary = el('p', 'spectro-system-lead');

        const action = el('button', 'spectro-system-btn spectro-system-primary');
        action.type = 'button';
        action.addEventListener('click', () => {
            const code = resolved && resolved.body.code;
            if (app.view === 'system' && code && app.systemCode === code) view.exit();
            else if (code) view.enter(code);
        });

        const whole = el('button', 'spectro-system-btn', 'View the whole system');
        whole.type = 'button';
        whole.addEventListener('click', () => view.focusPlanet(null));

        const timeGroup = el('div', 'sim-control-group');
        timeGroup.append(el('span', 'sim-control-group-label', 'Orbit time'), timeBox);
        const time = el('p', 'spectro-system-time');
        timeGroup.append(time);

        const scaleGroup = el('div', 'sim-checkbox-group');
        const logBox = el('input');
        logBox.type = 'checkbox';
        logBox.id = 'spectroSystemLog';
        logBox.addEventListener('change', () => view.setLogScale(logBox.checked));
        const logLabel = el('label', '', 'Log scale for distances');
        logLabel.htmlFor = 'spectroSystemLog';
        logLabel.title = 'Squeezes wide orbits together so that the inner planets can be seen. Times and speeds stay true, but drawn distances do not.';
        scaleGroup.append(logBox, logLabel);

        const hzBox = el('input');
        hzBox.type = 'checkbox';
        hzBox.id = 'spectroSystemHz';
        hzBox.addEventListener('change', () => setLayer('habitableZone', hzBox.checked));
        const hzLabel = el('label', '', 'Habitable zone');
        hzLabel.htmlFor = 'spectroSystemHz';
        hzLabel.title = 'Where water could stay liquid on a planet\'s surface. Inner edge about √(L/1.1) AU, outer edge about √(L/0.53) AU, with L in solar luminosities.';
        scaleGroup.append(hzBox, hzLabel);
        const hzNote = el('p', 'spectro-system-note');

        const scaleWrap = el('div', 'sim-control-group');
        scaleWrap.append(el('span', 'sim-control-group-label', 'View'), scaleGroup, hzNote);

        const detail = el('div', 'sim-control-group spectro-system-detail');

        const listGroup = el('div', 'sim-control-group');
        const listLabel = el('span', 'sim-control-group-label', 'Planets');
        const list = el('ul', 'spectro-system-list');
        listGroup.append(listLabel, list);

        const starGroup = el('div', 'sim-control-group');
        const starList = el('ul', 'spectro-system-list');
        starGroup.append(el('span', 'sim-control-group-label', 'Stars'), starList);

        const about = el('details', 'sim-controls-more');
        about.append(
            el('summary', '', 'About the scale'),
            el('p', 'spectro-system-note', 'Sizes are not to scale. Real stars and planets would be invisible specks beside these orbits, so every size is compressed the same way (radius to the power 0.3). A giant is still bigger than a dwarf, and a dwarf bigger than a planet.'),
            el('p', 'spectro-system-note', 'Orbit distances are to scale unless you choose the log scale. Orbital speeds always follow Kepler\'s laws, sped up by the time control.')
        );

        box.append(summary, action, whole, timeGroup, scaleWrap, detail, listGroup, starGroup, about);
        container.appendChild(box);
        return { summary, action, whole, timeGroup, time, scaleWrap, logBox, logLabel, hzBox, hzLabel, hzNote, detail, listGroup, list, listLabel, starGroup, starList };
    }

    function renderList(model) {
        parts.list.replaceChildren();
        parts.listGroup.hidden = model.planets.length === 0;
        model.planets.forEach((entry) => {
            const li = el('li');
            const b = el('button', 'spectro-system-planet');
            b.type = 'button';
            b.dataset.code = entry.code;
            const code = el('span', 'spectro-system-code', entry.code);
            const facts = el('span', 'spectro-system-facts', `${sig(entry.planet.orbit_AU, 3)} AU, ${timeText(entry.planet.period_days)}`);
            b.append(code, facts);
            b.setAttribute('aria-label', `Planet ${entry.code}: orbit ${sig(entry.planet.orbit_AU, 3)} astronomical units, period ${timeText(entry.planet.period_days)}`);
            b.addEventListener('click', () => selectFromList(entry.code));
            li.appendChild(b);
            parts.list.appendChild(li);
        });

        // A multi-star system: each star can be selected too, which is how a pair gets untangled
        parts.starList.replaceChildren();
        parts.starGroup.hidden = model.stars.length < 2;
        if (model.stars.length > 1) {
            model.stars.forEach((s) => {
                const li = el('li');
                const b = el('button', 'spectro-system-planet');
                b.type = 'button';
                b.dataset.code = s.code;
                b.append(el('span', 'spectro-system-code', s.code));
                // The double-double's stars come in named pairs
                const pair = (model.body.pairs || []).find((q) => q.codes.includes(s.code));
                if (pair) b.append(el('span', 'spectro-system-facts', `Pair ${pair.label}`));
                b.setAttribute('aria-label', pair ? `Star ${s.code}, pair ${pair.label}` : `Star ${s.code}`);
                b.addEventListener('click', () => selectFromList(s.code));
                li.appendChild(b);
                parts.starList.appendChild(li);
            });
        }
    }

    function renderDetail(model) {
        const d = parts.detail;
        d.replaceChildren();
        const code = resolved && resolved.path === 'planet' ? resolved.entity.code : null;
        const entry = code ? model.planets.find((e) => e.code === code) : null;
        if (!entry) {
            d.hidden = model.planets.length === 0;
            d.append(el('p', 'spectro-system-note', 'Select a planet to see its orbit and test Kepler\'s third law.'));
            return;
        }
        d.hidden = false;
        const r = keplerReadout(model, entry);
        d.append(el('span', 'sim-control-group-label', `Orbit of ${entry.code}`));
        const dl = el('dl', 'spectro-system-readout');
        row(dl, 'Orbit radius, r', `${sig(r.r_AU, 3)} AU (${sci(r.r_m, 3)} m)`);
        row(dl, 'Period, T', `${timeText(r.T_days)} (${sci(r.T_s, 3)} s)`);
        row(dl, 'Speed, v = 2πr/T', `${sig(r.v_kms, 3)} km/s`);
        d.append(dl);

        d.append(el('span', 'sim-control-group-label', 'Kepler\'s third law'));
        const k = el('dl', 'spectro-system-readout');
        row(k, 'r³/T²', `${sci(r.r3OverT2, 3)} m³/s²`);
        row(k, 'GM/4π²', `${sci(r.GMOver4Pi2, 3)} m³/s²`);
        const stars = r.aroundStars === 1 ? 'the star' : `the ${r.aroundStars} stars it circles`;
        row(k, 'with M', `${sig(r.mass_Msun, 3)} solar masses (${stars})`);
        d.append(k);
        const ratio = r.r3OverT2 / r.GMOver4Pi2;
        d.append(el('p', 'spectro-system-note', `The two sides agree to ${Math.abs(ratio - 1) < 0.005 ? 'within 0.5%' : `${sig(Math.abs(ratio - 1) * 100, 2)}%`}: the same value for every planet going round the same mass.`));
    }

    function paint() {
        if (!parts || !resolved) return;
        const body = resolved.body;
        const model = modelFor(body);
        const inThis = app.view === 'system' && app.systemCode === body.code;

        const n = model.planets.length;
        const starText = model.stars.length === 1 ? 'One star' : `${model.stars.length} stars`;
        const planetText = n === 0 ? 'no planets' : n === 1 ? 'one planet' : `${n} planets`;
        parts.summary.textContent = `${starText}, ${planetText}.`;

        parts.action.textContent = inThis ? 'Back to sky' : 'Enter system';
        parts.whole.hidden = !(inThis && view.isFocused());
        parts.timeGroup.hidden = !inThis;
        parts.scaleWrap.hidden = !inThis;

        if (inThis) {
            parts.logBox.checked = view.isLogScale();
            const useful = view.logScaleUseful();
            parts.logBox.disabled = !useful;
            parts.logLabel.title = useful
                ? 'Squeezes wide orbits together so that the inner planets can be seen. Times and speeds stay true, but drawn distances do not.'
                : 'This system has only one distance to show, so a log scale would change nothing.';
            const hz = hzStatus(body);
            parts.hzBox.disabled = !hz.ok;
            parts.hzBox.checked = hz.ok && !!app.layers.habitableZone;
            parts.hzLabel.title = hz.ok ? parts.hzLabel.title : hz.reason;
            parts.hzNote.hidden = hz.ok;
            parts.hzNote.textContent = hz.ok ? '' : hz.reason;
        }

        renderList(model);
        renderDetail(model);
        const selected = resolved.entity.code;
        [parts.list, parts.starList].forEach((l) => l.querySelectorAll('button').forEach((b) => {
            b.setAttribute('aria-current', b.dataset.code === selected ? 'true' : 'false');
        }));
        paintTime();
    }

    bus.on('view', ({ view: v }) => {
        if (v === 'system') {
            startPlayback(view.getModel());
            // Already reading about this system? The System tab is what you came for.
            const open = app.drawer.isOpen() && app.drawer.currentView() === 'object';
            if (open && app.selected && app.selected.body === view.getModel().body) app.drawer.selectTab('system');
        } else {
            stopPlayback();
        }
        paint();
    });
    bus.on('layer', ({ name }) => { if (name === 'habitableZone') paint(); });
    // Another panel's playback moved this system's clock: carry on from there rather than jump back
    bus.on('timeline', ({ code, t_days }) => {
        if (!ownTick && playback && code === app.systemCode) playback.t = t_days;
    });
    view.onChange(paint);

    app.drawer.registerTab({
        id: 'system',
        label: 'System',
        order: 40,
        appliesTo: (r) => !!r && (r.path === 'body' || r.path === 'planet' || r.path === 'component') && hasSystemView(r.body),
        mount(container) {
            parts = buildParts(container);
            return {
                setEntity(next) {
                    resolved = next;
                    paint();
                },
                onShow() { paint(); }
            };
        }
    });
}
