// The System tab: orbit time and scale, the list of planets, and each planet's orbit with Kepler's third law checked
// out loud. The playback is created when a system opens, not when the tab first shows, so the orbits run whether or not
// the drawer is open; the tab just gives it a home.

import { bus, select, setLayer } from '../core/state.js';
import { sig, sci } from '../core/format.js';
import { createPlayback } from './playback.js';
import { hzStatus, buildModel, keplerReadout, cometReadout, speedsFor } from '../render/system/system_model.js';
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

function speedWords(days) {
    if (days >= 730) return `${sig(days / 365.25, 2)} years/s`;
    const n = sig(days, 2);
    return `${n} ${n === '1' ? 'day' : 'days'}/s`;
}

function row(list, label, value) {
    const dt = el('dt', '', label);
    const dd = el('dd', '', value);
    list.append(dt, dd);
    return dd;
}

// A sentence on what's here. With nothing going round it, that includes what there is to do, if this device can show it.
function summaryOf(model, canView) {
    const { body } = model;
    if (body.kind === 'nucleus') {
        return body.nucleus.active
            ? 'The giant black hole at the centre of its galaxy, feeding: gas spirals in on a blazing disc. A few stars orbit close by.'
            : 'The giant black hole at the centre of its galaxy. It is quiet, with almost no gas falling in. A few stars orbit close by.';
    }
    if (body.black_hole) return 'A black hole and the star going round it. Gas from the star falls onto the disc.';
    if (body.neutron_star) {
        return body.neutron_star.pulsar
            ? 'A neutron star, with its beams slowed right down. Really it turns far too fast to draw.'
            : `A neutron star, on its own.${canView ? ' Drag to look round it.' : ''}`;
    }
    const n = model.planets.length;
    if (model.lone) return canView ? 'One star, no planets. Nothing goes round it, so this is the star up close: drag to look round it, or zoom in on its surface.' : 'One star, no planets.';
    const starText = model.stars.length === 1 ? 'One star' : `${model.stars.length} stars`;
    const planetText = n === 0 ? 'no planets' : n === 1 ? 'one planet' : `${n} planets`;
    const nc = model.comets.length;
    const cometText = nc === 0 ? '' : nc === 1 ? ' and a comet' : ` and ${nc} comets`;
    return `${starText}, ${planetText}${cometText}.`;
}

// What the student last chose for each system's clock, kept between visits
const keptClocks = new Map();

export function initSystemTab(app) {
    const view = app.system;

    // Lives as long as the system is open, wherever the tab is
    const timeBox = el('div', 'spectro-system-playback');
    let playback = null;
    let systemClock = null;
    let resolved = null;
    let parts = null;
    let modelCache = null;      // For readouts while still in the sky
    let listed = null;          // The model the rows were made for: rows that stay put keep their keyboard focus
    let ownTick = false;

    function modelFor(body) {
        const open = view.getModel();
        if (open && open.body === body) return open;
        if (!modelCache || modelCache.body !== body) modelCache = buildModel(body);
        return modelCache;
    }

    let quiet = false;          // Starting or stopping the control itself: not the student's choice, so not kept

    function tellClock() {
        if (playback) {
            view.setClock({ speed: playback.speed, playing: playback.playing });
            const model = view.getModel();
            if (!quiet && model) keptClocks.set(model.code, { speed: playback.speed, playing: playback.playing });
        } else {
            view.setClock({ speed: 0, playing: false, read: null });
        }
    }

    function startPlayback(model) {
        stopPlayback();
        const reduced = !!app.settings.reduceMotion;
        const range = speedsFor(model, reduced, view.isLogScale() ? 1 : 0);
        if (!range) return;    // Nothing here goes round anything
        // Back again: as the student left it, within what this speed range allows
        const kept = keptClocks.get(model.code);
        const speed = kept ? Math.min(range.max, Math.max(range.min, kept.speed)) : range.speed;
        quiet = true;
        // Stars' orbits run on the clock the spectrum shares; a single star's planets need only this control
        const { body } = model;
        systemClock = (body.orbits && body.orbits.length) || body.black_hole || body.unstable ? clockFor(body) : null;
        if (systemClock && !systemClock.playing) systemClock.setSpeed(speed);
        playback = createPlayback(timeBox, {
            label: 'Orbit time',
            range,
            speed,
            words: speedWords,
            unit: 'days',
            t0: view.getTime(),
            clock: systemClock,
            scale: () => view.timeScale(),
            onChange: tellClock,
            onTick(t) {
                ownTick = true;
                if (!systemClock) bus.emit('timeline', { code: model.code, t_days: t, own: true });
                ownTick = false;
                paintTime();
            }
        });
        // The view reads this system's time from its clock, every frame
        if (systemClock) view.setClock({ read: () => systemClock.t });
        tellClock();
        if (!reduced && !(kept && !kept.playing)) playback.play();
        quiet = false;
    }

    function stopPlayback() {
        quiet = true;
        if (playback) playback.dispose();
        playback = null;
        if (systemClock) systemClock.pause();
        systemClock = null;
        tellClock();
        quiet = false;
    }

    let lastPaint = 0;
    function paintTime() {
        if (!parts || !playback) return;
        const now = performance.now();
        if (now - lastPaint < 150) return;
        lastPaint = now;
        const slowed = playback.playing && view.timeScale() < 1 ? ', running slowly for this close-up'
            : playback.playing && view.danceSlowed() ? ', slowed for a fast pass' : '';
        const blurred = view.isBlurred() ? '. The fastest orbits are a blur at this speed.' : '';
        parts.time.textContent = `Time passed: ${timeText(Math.max(0, playback.t))}${slowed}${blurred}`;
    }

    function selectFromList(code) {
        select(code);
        if (app.view === 'system') view.focusPlanet(code);
        else app.drawer.selectTab('system');
    }

    // The button that was just pressed has gone: on to the next thing there is to do here
    function focusIntoTab() {
        const next = (playback && playback.button) || parts.list.querySelector('button') || parts.starList.querySelector('button');
        if (next) next.focus({ preventScroll: true });
        else app.engine.canvas.focus({ preventScroll: true });
    }

    function buildParts(container) {
        const box = el('div', 'spectro-system-tab');

        const summary = el('p', 'spectro-system-lead');

        // Zooming in on the sky is the way in; this is the same thing for a keyboard, or a click, so it's words, not a big button
        const action = el('button', 'spectro-system-btn spectro-system-primary', 'Enter system');
        action.type = 'button';
        const arrow = el('span', 'icon solid fa-arrow-right');
        arrow.setAttribute('aria-hidden', 'true');
        action.appendChild(arrow);
        action.addEventListener('click', () => {
            if (!resolved) return;
            // Selected a planet? Then that's what the flight is for.
            view.enter(resolved.path === 'planet' || resolved.path === 'comet' ? resolved.entity.code : view.systemOf(resolved).code);
            if (action.hidden) focusIntoTab();
        });

        const whole = el('button', 'spectro-system-btn', 'View the whole system');
        whole.type = 'button';
        whole.addEventListener('click', () => {
            view.focusPlanet(null);
            const current = [parts.list, parts.cometList, parts.starList].map((l) => l.querySelector('[aria-current="true"]')).find(Boolean);
            if (current) current.focus({ preventScroll: true });
            else focusIntoTab();
        });

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
        const hzTip = 'Where water could stay liquid on a planet\'s surface. Inner edge about √(L/1.1) AU, outer edge about √(L/0.53) AU, with L in solar luminosities.';
        hzLabel.title = hzTip;
        scaleGroup.append(hzBox, hzLabel);
        const hzNote = el('p', 'spectro-system-note');

        const scaleWrap = el('div', 'sim-control-group');
        scaleWrap.append(el('span', 'sim-control-group-label', 'View'), scaleGroup, hzNote);

        const detail = el('div', 'sim-control-group spectro-system-detail');

        const listGroup = el('div', 'sim-control-group');
        const listLabel = el('span', 'sim-control-group-label', 'Planets');
        const list = el('ul', 'spectro-system-list');
        listGroup.append(listLabel, list);

        const cometGroup = el('div', 'sim-control-group');
        const cometList = el('ul', 'spectro-system-list');
        cometGroup.append(el('span', 'sim-control-group-label', 'Comets'), cometList);

        const starGroup = el('div', 'sim-control-group');
        const starList = el('ul', 'spectro-system-list');
        starGroup.append(el('span', 'sim-control-group-label', 'Stars'), starList);

        const about = el('details', 'sim-controls-more');
        about.append(
            el('summary', '', 'About the scale'),
            el('p', 'spectro-system-note', 'Sizes are not to scale. Real stars and planets would be invisible specks beside these orbits, so every size is compressed the same way (radius to the power 0.3). A giant is still bigger than a dwarf, and a planet is always drawn smaller than its star.'),
            el('p', 'spectro-system-note', 'Orbit distances are to scale unless you choose the log scale. Orbital speeds always follow Kepler\'s laws, sped up by the time control. An orbit too fast to follow turns into a steady ring of light, so that the slower ones can still be watched.')
        );

        box.append(summary, action, whole, timeGroup, scaleWrap, detail, listGroup, cometGroup, starGroup, about);
        container.appendChild(box);
        return { summary, action, whole, timeGroup, time, scaleWrap, logBox, logLabel, hzBox, hzLabel, hzTip, hzNote, detail, listGroup, list, listLabel, cometGroup, cometList, starGroup, starList };
    }

    function renderList(model) {
        if (listed === model) return;
        listed = model;
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

        parts.cometList.replaceChildren();
        parts.cometGroup.hidden = model.comets.length === 0;
        model.comets.forEach((entry) => {
            const li = el('li');
            const b = el('button', 'spectro-system-planet');
            b.type = 'button';
            b.dataset.code = entry.code;
            const { q_AU: q, Q_AU: Q, period_days: T } = entry.orbit;
            b.append(el('span', 'spectro-system-code', entry.code), el('span', 'spectro-system-facts', `${sig(q, 2)} to ${sig(Q, 2)} AU, ${timeText(T)}`));
            b.setAttribute('aria-label', `Comet ${entry.code}: from ${sig(q, 2)} to ${sig(Q, 2)} astronomical units from its star, period ${timeText(T)}`);
            b.addEventListener('click', () => selectFromList(entry.code));
            li.appendChild(b);
            parts.cometList.appendChild(li);
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
                const hole = s.star.stage === 'black_hole';
                if (pair) b.append(el('span', 'spectro-system-facts', `Pair ${pair.label}`));
                if (hole) b.append(el('span', 'spectro-system-facts', 'Black hole'));
                b.setAttribute('aria-label', hole ? `Black hole ${s.code}` : pair ? `Star ${s.code}, pair ${pair.label}` : `Star ${s.code}`);
                b.addEventListener('click', () => selectFromList(s.code));
                li.appendChild(b);
                parts.starList.appendChild(li);
            });
        }
    }

    function renderDetail(model) {
        const d = parts.detail;
        d.replaceChildren();
        const code = resolved ? resolved.entity.code : null;
        const entry = code ? model.planets.find((e) => e.code === code) : null;
        const comet = code && !entry ? model.comets.find((e) => e.code === code) : null;
        if (comet) {
            renderCometDetail(model, comet);
            return;
        }
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

    // A comet's orbit is an ellipse, so Kepler's third law takes its semi-major axis: halfway between nearest and furthest
    function renderCometDetail(model, entry) {
        const d = parts.detail;
        d.hidden = false;
        const r = cometReadout(model, entry);
        d.append(el('span', 'sim-control-group-label', `Orbit of ${entry.code}`));
        const dl = el('dl', 'spectro-system-readout');
        row(dl, 'Nearest the star', `${sig(r.q_AU, 3)} AU`);
        row(dl, 'Furthest out', `${sig(r.Q_AU, 3)} AU`);
        row(dl, 'Semi-major axis, a', `${sig(r.a_AU, 3)} AU (${sci(r.a_AU * 1.495978707e11, 3)} m)`);
        row(dl, 'Period, T', `${timeText(r.T_days)} (${sci(r.T_s, 3)} s)`);
        d.append(dl);
        d.append(el('span', 'sim-control-group-label', 'Kepler\'s third law'));
        const k = el('dl', 'spectro-system-readout');
        row(k, 'a³/T²', `${sci(r.a3OverT2, 3)} m³/s²`);
        row(k, 'GM/4π²', `${sci(r.GMOver4Pi2, 3)} m³/s²`);
        row(k, 'with M', `${sig(r.mass_Msun, 3)} solar masses`);
        d.append(k);
        const ratio = r.a3OverT2 / r.GMOver4Pi2;
        d.append(el('p', 'spectro-system-note', `The two sides agree to ${Math.abs(ratio - 1) < 0.005 ? 'within 0.5%' : `${sig(Math.abs(ratio - 1) * 100, 2)}%`}. Its tails grow as it nears the star, where the heat turns its ice to gas, and always point away from the star.`));
    }

    function paint() {
        if (!parts || !resolved) return;
        const body = view.systemOf(resolved);
        if (!body) return;
        const model = modelFor(body);
        const inThis = app.view === 'system' && app.systemCode === body.code;

        parts.summary.textContent = summaryOf(model, !!(app.engine && app.engine.renderer));

        // The way back to the sky is on the context bar, always in the same place. Without graphics there's no going in.
        parts.action.hidden = inThis || !(app.engine && app.engine.renderer);
        parts.whole.hidden = !(inThis && view.isFocused());
        parts.timeGroup.hidden = !inThis || !playback;

        const remnant = !!(body.black_hole || body.neutron_star);
        parts.scaleWrap.hidden = !inThis || remnant;
        if (inThis) {
            parts.logBox.checked = view.isLogScale();
            const useful = view.logScaleUseful();
            parts.logBox.disabled = !useful;
            parts.logBox.hidden = model.lone;
            parts.logLabel.hidden = model.lone;
            parts.logLabel.title = useful
                ? 'Squeezes wide orbits together so that the inner planets can be seen. Times and speeds stay true, but drawn distances do not.'
                : 'This system has only one distance to show, so a log scale would change nothing.';
            const hz = hzStatus(body);
            parts.hzBox.disabled = !hz.ok;
            parts.hzBox.checked = hz.ok && !!app.layers.habitableZone;
            parts.hzLabel.title = hz.ok ? parts.hzTip : hz.reason;
            parts.hzNote.hidden = hz.ok;
            parts.hzNote.textContent = hz.ok ? '' : hz.reason;
        }

        renderList(model);
        renderDetail(model);
        const selected = resolved.entity.code;
        [parts.list, parts.cometList, parts.starList].forEach((l) => l.querySelectorAll('button').forEach((b) => {
            b.setAttribute('aria-current', b.dataset.code === selected ? 'true' : 'false');
        }));
        paintTime();
    }

    bus.on('view', ({ view: v }) => {
        if (v === 'system') {
            startPlayback(view.getModel());
            // Already reading about this system? The System tab is what you came for.
            const open = app.drawer.isOpen() && app.drawer.currentView() === 'object';
            if (open && app.selected && view.systemOf(app.selected) === view.getModel().body) app.drawer.selectTab('system');
        } else {
            stopPlayback();
        }
        listed = null;
        paint();
    });
    bus.on('layer', ({ name }) => { if (name === 'habitableZone') paint(); });
    // Another panel's playback moved this system's clock: carry on from there rather than jump back. When it goes back to
    // the start it has let go, and this clock just carries on.
    bus.on('timeline', ({ code, t_days }) => {
        if (!ownTick && playback && code === app.systemCode && t_days) playback.t = t_days;
    });
    // Reduce motion stops the orbits where they are, and takes the top off the speeds
    bus.on('settings', ({ key }) => {
        if (key !== 'reduceMotion' || !playback) return;
        startPlayback(view.getModel());
        paint();
    });
    view.onChange(paint);

    app.drawer.registerTab({
        id: 'system',
        label: 'System',
        order: 40,
        appliesTo: (r) => !!view.systemOf(r),
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
