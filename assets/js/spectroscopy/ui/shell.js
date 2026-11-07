// The frame around the sky: the canvas fit, band switcher, Layers menu, Help, Settings, the context bar and the
// slot for the legend. Everything here is a thin bar at an edge of the sky; only the bars take pointer events.

import { bus, select, setBand, setLayer, setSetting } from '../core/state.js';
import { BANDS, BAND_INFO } from '../core/bands.js';
import { DEFAULT_VIEW } from '../core/sky.js';
import { helpSections } from '../content/help.js';
import { initLegend } from './legend.js';

function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

function button(className, text) {
    const b = element('button', className, text);
    b.type = 'button';
    return b;
}

function iconSpan(icon) {
    const span = element('span', `icon solid ${icon}`);
    span.setAttribute('aria-hidden', 'true');
    return span;
}

// ---------- The sky fills the column ----------
// A hidden probe takes the column's width and the site's tallest canvas height (--sim-canvas-max-h), and the ratio
// of the two becomes the page's --aspect-ratio (simulation_ui.js mirrors it to the elements that use it). The probe
// doesn't depend on the canvas, so resizing the canvas can't set this off again. Fullscreen needs none of it: CSS
// stretches the box over all the room there.
function initSkyFit() {
    const body = document.body;
    const main = document.querySelector('.simulation-main-content');
    const box = document.querySelector('.sim-aspect-ratio-box');
    const area = document.querySelector('.simulation-area-wrapper');
    const panel = document.getElementById('simulationControlsPanel');
    if (!main || !box || !area) return;

    const probe = element('div', 'spectro-fit-probe');
    probe.setAttribute('aria-hidden', 'true');
    main.appendChild(probe);

    let lastW = 0;
    let lastH = 0;
    function fit() {
        if (body.classList.contains('sim-fullscreen-active')) return;
        const w = probe.offsetWidth - 2; // Inside the canvas's 1px border
        let h = probe.offsetHeight;
        if (w <= 0 || h <= 0) return;
        // A bottom sheet covers the lower part of the screen: the whole sky stays in view above it
        if (body.classList.contains('sim-panel-sheet') && panel.classList.contains('panel-open')) {
            h = Math.max(160, Math.min(h, window.innerHeight - panel.offsetHeight - 18));
        }
        if (Math.abs(w - lastW) < 1 && Math.abs(h - lastH) < 1) return;
        lastW = w;
        lastH = h;
        box.style.setProperty('--aspect-ratio', `${w} / ${h}`);
        area.style.setProperty('--spectro-sky-h', `${h + 2}px`);
        // The engine resizes on this. It lands back in fit() below, finds nothing changed, and stops.
        window.dispatchEvent(new Event('resize'));
    }

    fit();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(probe);
    window.addEventListener('resize', fit);
    bus.on('drawer', fit);
}

// ---------- Band switcher ----------
function initBandBar(app) {
    const bar = document.getElementById('spectroBandBar');
    bar.classList.add('spectro-glass');
    bar.setAttribute('role', 'radiogroup');
    bar.setAttribute('aria-label', 'Sky band');

    const buttons = BANDS.map((band) => {
        const b = button('spectro-band-btn', BAND_INFO[band].short);
        b.dataset.band = band;
        b.setAttribute('role', 'radio');
        // The name holds the words on the button, so asking for "IR" by voice still finds it
        const { short, label } = BAND_INFO[band];
        b.setAttribute('aria-label', short === label ? label : `${short}, ${label}`);
        b.addEventListener('click', () => { if (app.view === 'sky') setBand(band); });
        bar.appendChild(b);
        return b;
    });

    // Bands are a way of looking at the sky: a system is always drawn as it would look to the eye
    function paint() {
        const inSky = app.view === 'sky';
        buttons.forEach((b) => {
            const on = b.dataset.band === app.band;
            b.setAttribute('aria-checked', on ? 'true' : 'false');
            b.tabIndex = on ? 0 : -1;
            b.title = inSky ? `Show the sky in ${BAND_INFO[b.dataset.band].label}` : 'Bands show in the sky view';
            if (inSky) b.removeAttribute('aria-disabled');
            else b.setAttribute('aria-disabled', 'true');
        });
    }

    bar.addEventListener('keydown', (e) => {
        if (app.view !== 'sky') return;
        const i = BANDS.indexOf(app.band);
        let next = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % BANDS.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + BANDS.length) % BANDS.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = BANDS.length - 1;
        if (next < 0) return;
        e.preventDefault();
        setBand(BANDS[next]);
        buttons[next].focus();
    });

    bus.on('band', paint);
    bus.on('view', paint);
    paint();
}

// ---------- Layers menu ----------
const LAYER_ROWS = [
    { name: 'homePlanets', label: 'Home planets', tip: 'Mercury, Venus, Mars, Jupiter, Saturn, Uranus and Neptune, as bright points.' },
    { name: 'backgroundStars', label: 'Background stars', tip: 'Thousands of faint stars, as scenery. They can\'t be selected: everything else you see can.' },
    { name: 'galacticBand', label: 'Galactic band highlight', tip: 'Marks the edges of the band of stars and dust that crosses the sky.' },
    { name: 'grid', label: 'Grid', tip: 'Lines of altitude (height above the horizon) and azimuth (bearing around the horizon), in degrees.' },
    { name: 'labels', label: 'Labels', tip: 'Shows each object\'s code. Zoom in to see more of them.' },
    { name: 'shiftTint', label: 'Red/blue shift tint', tip: 'Tints bright objects by how fast they move along your line of sight, with an arrow and the speed.' },
    { name: 'habitableZone', label: 'Habitable zone (system view)', tip: 'A ring around a star where liquid water could exist on a planet. Shows in the system view.' }
];

const HZ_REASON = 'Not available for this system. The zone formula only works for a single main-sequence star: it moves as giants and white dwarfs evolve, and does not apply to several stars.';

// The system view says when the zone makes sense: for the system on show, or else for the one this selection leads to.
// Without a system view there is nobody to say no.
function habitableZoneState(app) {
    const system = app.system;
    if (!system || typeof system.hzAvailable !== 'function') return { available: true, reason: '' };
    const code = app.view === 'system' ? undefined : (systemCodeFor(app, app.selected) || undefined);
    // Nothing chosen yet, so nothing to say no about: it can be set ahead of going in
    if (app.view !== 'system' && !code) return { available: true, reason: '' };
    const status = system.hzAvailable(code);
    if (!status || status.ok) return { available: true, reason: '' };
    return { available: false, reason: status.reason || HZ_REASON };
}

function layerRow(app, group, row) {
    const id = `spectroLayer-${row.name}`;
    const input = element('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = !!app.layers[row.name];
    const label = element('label', '', row.label);
    label.htmlFor = id;
    label.title = row.tip;
    input.addEventListener('change', () => setLayer(row.name, input.checked));
    group.append(input, label);
    return input;
}

function initLayersMenu(app, topRight) {
    const root = element('div', 'spectro-layers');
    const toggle = button('sim-icon-button spectro-layers-btn');
    toggle.append(iconSpan('fa-layer-group'), element('span', 'spectro-layers-word', 'Layers'));
    toggle.setAttribute('aria-label', 'Layers');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'spectroLayersMenu');
    toggle.title = 'Layers: what is drawn over the sky';

    const menu = element('div', 'spectro-layers-menu');
    menu.id = 'spectroLayersMenu';
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', 'Layers');
    menu.hidden = true;

    const group = element('div', 'sim-checkbox-group');
    const inputs = {};
    LAYER_ROWS.forEach((row) => { inputs[row.name] = layerRow(app, group, row); });
    menu.appendChild(group);

    // What the tint means, in words, while it is on
    const shiftKey = element('p', 'spectro-layer-note', '→ Red: moving away from you (redshift). ← Blue: moving towards you (blueshift).');
    const hzNote = element('p', 'spectro-layer-note');
    hzNote.id = 'spectroHzNote';
    menu.append(shiftKey, hzNote);

    const radioHeading = element('p', 'sim-control-group-label', 'Radio band');
    const radioGroup = element('div', 'sim-checkbox-group');
    inputs.cmb = layerRow(app, radioGroup, {
        name: 'cmb',
        label: 'Cosmic microwave background',
        tip: 'The faint, even glow left over from the Big Bang. Shows only in the Radio band.'
    });
    const cmbNote = element('p', 'spectro-layer-note', 'Shows only when the sky is in Radio.');
    menu.append(radioHeading, radioGroup, cmbNote);

    root.append(toggle, menu);
    topRight.prepend(root);

    function paint() {
        Object.keys(inputs).forEach((name) => { inputs[name].checked = !!app.layers[name]; });
        shiftKey.hidden = !app.layers.shiftTint;
        const hz = habitableZoneState(app);
        inputs.habitableZone.disabled = !hz.available;
        // The switch says what's on show: there's no zone here, whatever it's set to for the systems that have one
        if (!hz.available) inputs.habitableZone.checked = false;
        const hzLabel = menu.querySelector(`label[for="${inputs.habitableZone.id}"]`);
        hzLabel.title = hz.available ? LAYER_ROWS.find((row) => row.name === 'habitableZone').tip : hz.reason;
        hzNote.textContent = hz.reason;
        hzNote.hidden = hz.available;
        if (hz.available) inputs.habitableZone.removeAttribute('aria-describedby');
        else inputs.habitableZone.setAttribute('aria-describedby', hzNote.id);
        cmbNote.hidden = app.band === 'radio';
    }

    function isOpen() {
        return !menu.hidden;
    }

    function open() {
        paint();
        menu.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        // The box clips what's inside it, so the menu scrolls rather than running off the bottom of the sky
        const box = document.querySelector('.sim-aspect-ratio-box').getBoundingClientRect();
        const top = toggle.getBoundingClientRect().bottom;
        menu.style.maxHeight = `${Math.max(120, box.bottom - top - 16)}px`;
    }

    function close(returnFocus) {
        if (!isOpen()) return;
        menu.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        if (returnFocus) toggle.focus({ preventScroll: true });
    }

    toggle.addEventListener('click', () => (isOpen() ? close(false) : open()));
    document.addEventListener('pointerdown', (e) => {
        if (isOpen() && !root.contains(e.target)) close(false);
    }, { capture: true });
    root.addEventListener('focusout', (e) => {
        if (isOpen() && e.relatedTarget && !root.contains(e.relatedTarget)) close(false);
    });

    // One panel at a time: anything opening in the drawer closes this
    bus.on('drawer', ({ open: opening }) => { if (opening) close(false); });
    bus.on('layer', paint);
    bus.on('band', paint);
    bus.on('view', paint);
    bus.on('select', paint);

    return { isOpen, close };
}

// ---------- Context bar: the zoom, and the way into or out of a planetary system ----------
const ZOOM_HINT_FROM_AFAR = 'Zoom in on it to visit';
const ZOOM_HINT_ON_THE_WAY = 'Keep zooming to go in';
const ZOOM_WAIT = 'Getting the system ready';
const ZOOM_HINT_MS = 6000;
const ZOOM_HINT_KEY = 'spectroZoomHintSeen';

// A browser that won't store this just shows the hint once a visit
let hintSeenNow = false;
function hintWasSeen() {
    if (hintSeenNow) return true;
    try {
        return localStorage.getItem(ZOOM_HINT_KEY) === '1';
    } catch (err) {
        return false;
    }
}

function markHintSeen() {
    hintSeenNow = true;
    try {
        localStorage.setItem(ZOOM_HINT_KEY, '1');
    } catch (err) { /* Remembered for this visit, as above */ }
}

function zoomWords(fov) {
    const zoom = DEFAULT_VIEW.fov / fov;
    const shown = zoom >= 10 ? String(Math.round(zoom)) : zoom.toFixed(1);
    const degrees = fov >= 10 ? Math.round(fov) : Number(fov.toFixed(fov >= 1 ? 1 : 2));
    return { zoom: `Zoom ${shown}×`, fov: `${degrees}° field of view` };
}

// The code of the system this selection leads to, or null. The system view has the last word on what can be entered.
function systemCodeFor(app, resolved) {
    if (!resolved || !app.system || !app.system.systemOf) return null;
    const system = app.system.systemOf(resolved);
    return system ? system.code : null;
}

function initContextBar(app) {
    const bar = document.getElementById('spectroContextBar');
    bar.classList.add('spectro-glass');

    const readout = element('div', 'spectro-zoom');
    readout.title = 'Field of view: how much of the sky fits from the bottom of the view to the top';
    const zoomText = element('span', 'spectro-zoom-value');
    const fovText = element('span', 'spectro-zoom-fov');
    const hint = element('span', 'spectro-zoom-hint');
    hint.hidden = true;
    readout.append(zoomText, fovText, hint);

    // Zooming is the way in. This is the way for a keyboard or anyone who'd rather press something.
    const enter = button('spectro-bar-button spectro-bar-quiet');
    enter.append(iconSpan('fa-search-plus'), element('span', '', 'Enter system'));
    const back = button('spectro-bar-button');
    back.append(iconSpan('fa-arrow-left'), element('span', '', 'Back to sky'));
    // Zooming in opens no panel, so this says where you are and opens its panel
    const here = button('spectro-bar-button spectro-bar-quiet');
    const hereWords = element('span');
    here.append(iconSpan('fa-info-circle'), hereWords);
    bar.append(readout, enter, back, here);

    enter.addEventListener('click', () => {
        const resolved = app.selected;
        const code = systemCodeFor(app, resolved);
        if (!code || !app.system) return;
        const planet = resolved.path === 'planet' ? resolved.entity.code : null;
        app.system.enter(code, { onDone: planet ? () => app.system.focusPlanet(planet) : undefined });
    });
    back.addEventListener('click', () => { if (app.system) app.system.exit(); });
    here.addEventListener('click', () => { if (app.systemCode) select(app.systemCode); });

    function panelShowsSystem() {
        const shown = app.selected;
        return !!shown && app.drawer.isOpen() && app.drawer.currentView() === 'object'
            && (shown.body.code === app.systemCode || shown.entity.code === app.systemCode);
    }

    function paint() {
        const inSystem = app.view === 'system' && !app.system.isOpening();
        const code = inSystem ? null : systemCodeFor(app, app.selected);
        // Hiding the button that has focus would drop it to the page: pass it to the one taking its place
        const held = [enter, back].find((b) => b === document.activeElement);
        readout.hidden = inSystem;
        back.hidden = !inSystem;
        enter.hidden = !code;
        if (code) enter.setAttribute('aria-label', `Enter system ${code}`);
        here.hidden = !inSystem || panelShowsSystem();
        if (inSystem && app.systemCode) {
            hereWords.textContent = `System ${app.systemCode}`;
            here.setAttribute('aria-label', `Open the panel for system ${app.systemCode}`);
        }
        if (held && held.hidden) {
            const next = !back.hidden ? back : !enter.hidden ? enter : app.engine.canvas;
            next.focus({ preventScroll: true });
        }
    }

    bus.on('select', paint);
    bus.on('deselect', paint);
    bus.on('view', paint);
    bus.on('drawer', paint);
    paint();

    // Once ever, as the student first gets somewhere it would help: choosing a star that can be visited, or zooming on one
    let hintTimer = 0;
    function offerHint(words) {
        if (hintTimer || hintWasSeen()) return;
        markHintSeen();
        hint.textContent = words;
        hint.hidden = false;
        hintTimer = setTimeout(() => { hint.hidden = true; }, ZOOM_HINT_MS);
    }
    bus.on('select', () => { if (app.view === 'sky' && systemCodeFor(app, app.selected)) offerHint(ZOOM_HINT_FROM_AFAR); });
    bus.on('zoomaim', () => offerHint(ZOOM_HINT_ON_THE_WAY));
    // Not a hint but a state of things, for as long as it lasts
    bus.on('zoomwait', ({ waiting }) => {
        hint.textContent = ZOOM_WAIT;
        hint.hidden = !waiting;
    });
    // Going in shows it's understood, so the hint needn't stay or come again
    bus.on('view', ({ view }) => {
        if (view !== 'system') return;
        markHintSeen();
        hint.hidden = true;
    });

    // Written only when the words change, so the bar isn't laid out again every frame
    let lastFov = -1;
    return function updateZoom(fov) {
        if (Math.abs(fov - lastFov) < 0.005) return;
        lastFov = fov;
        const words = zoomWords(fov);
        if (zoomText.textContent !== words.zoom) zoomText.textContent = words.zoom;
        if (fovText.textContent !== words.fov) fovText.textContent = words.fov;
    };
}

// ---------- Settings page ----------
const QUALITY_WORDS = { low: 'Low', medium: 'Medium', high: 'High' };

function initSettingsPage(app) {
    const fpsEl = document.getElementById('fpsDisplay');
    let paintPage = null;

    function fpsShown() {
        return !!fpsEl && fpsEl.style.display === 'block';
    }

    function render(container) {
        const qualityGroup = element('div', 'sim-control-group');
        const label = element('label', '', 'Graphics quality');
        label.htmlFor = 'spectroQuality';
        const select = element('select');
        select.id = 'spectroQuality';
        [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']].forEach(([value, words]) => {
            const o = element('option', '', words);
            o.value = value;
            select.appendChild(o);
        });
        const note = element('p', 'spectro-setting-note');
        note.setAttribute('aria-live', 'polite');
        qualityGroup.append(label, select, note);
        select.addEventListener('change', () => setSetting('quality', select.value));

        const toggles = element('div', 'sim-control-group');
        const checks = element('div', 'sim-checkbox-group');
        const motion = element('input');
        motion.type = 'checkbox';
        motion.id = 'spectroReduceMotion';
        const motionLabel = element('label', '', 'Reduce motion');
        motionLabel.htmlFor = motion.id;
        motion.addEventListener('change', () => setSetting('reduceMotion', motion.checked));
        const fps = element('input');
        fps.type = 'checkbox';
        fps.id = 'spectroShowFps';
        const fpsLabel = element('label', '', 'Show frame rate');
        fpsLabel.htmlFor = fps.id;
        fps.addEventListener('change', () => { if (fpsEl) fpsEl.style.display = fps.checked ? 'block' : 'none'; });
        checks.append(motion, motionLabel, fps, fpsLabel);
        toggles.append(checks, element('p', 'spectro-setting-note', 'Reduce motion stops the twinkle and swaps camera flights for quick fades.'));

        container.append(qualityGroup, toggles);

        paintPage = () => {
            select.value = app.settings.quality;
            const level = QUALITY_WORDS[app.qualityLevel] || app.qualityLevel;
            note.textContent = app.settings.quality === 'auto'
                ? `Now drawing at ${level}, chosen by measuring your frame rate.`
                : `Now drawing at ${level}.`;
            motion.checked = !!app.settings.reduceMotion;
            fps.checked = fpsShown();
        };
        paintPage();
    }

    const open = () => app.drawer.showPage('settings', 'Settings', render);
    app.drawer.setSettingsPage(open);

    const repaint = () => { if (paintPage && app.drawer.currentView() === 'settings') paintPage(); };
    bus.on('settings', repaint);
    bus.on('quality', repaint);
    // The F key also shows and hides the frame rate (simulation_ui.js)
    if (fpsEl) new MutationObserver(repaint).observe(fpsEl, { attributes: true, attributeFilter: ['style'] });
}

// ---------- Help page ----------
// The words come from content/help.js as { heading, html }. Each section folds away; the first starts open.
function helpSection(section, open) {
    const details = element('details', 'sim-controls-more spectro-help-section');
    details.open = open;
    details.appendChild(element('summary', '', section.heading));
    const holder = element('div', 'spectro-help-html');
    holder.innerHTML = section.html; // Our own words, not anything typed in
    details.appendChild(holder);
    return details;
}

function initHelpPage(app, topRight) {
    const help = button('sim-icon-button spectro-help-btn');
    help.appendChild(iconSpan('fa-question-circle'));
    help.setAttribute('aria-label', 'Help');
    help.title = 'Help';
    topRight.insertBefore(help, topRight.querySelector('.sim-action-buttons-overlay'));

    function render(container) {
        container.append(...helpSections().map((section, i) => helpSection(section, i === 0)));
    }

    help.addEventListener('click', () => {
        if (app.drawer.isOpen() && app.drawer.currentView() === 'help') app.drawer.close();
        else app.drawer.showPage('help', 'Help', render);
    });
    bus.on('drawer', () => help.setAttribute('aria-pressed', app.drawer.currentView() === 'help' ? 'true' : 'false'));
    help.setAttribute('aria-pressed', 'false');
}

// ---------- An object shouldn't vanish under the drawer that opened for it, or sit behind a bar ----------
function keepSelectionInView(app) {
    const BARS = ['spectroTopLeft', 'spectroBandBar', 'spectroTopRight', 'spectroContextBar', 'spectroLegend'];
    const CLEARANCE = 16;
    bus.on('select', () => {
        // After the drawer has opened and the canvas has taken its new size
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const engine = app.engine;
            if (!app.selected || app.view !== 'sky' || engine.isSlewing()) return;
            const { az, alt } = app.selected.body.sky;
            const p = engine.projectBody(app.selected.body);
            const frame = engine.currentFrame();
            const onSky = p && p.x > CLEARANCE && p.x < frame.width - CLEARANCE && p.y > CLEARANCE && p.y < frame.height - CLEARANCE;
            if (onSky) {
                const sky = document.getElementById('simulationCanvas').getBoundingClientRect();
                const behindBar = BARS.some((id) => {
                    const r = document.getElementById(id).getBoundingClientRect();
                    return r.width > 0 && p.x > r.left - sky.left - CLEARANCE && p.x < r.right - sky.left + CLEARANCE
                        && p.y > r.top - sky.top - CLEARANCE && p.y < r.bottom - sky.top + CLEARANCE;
                });
                if (!behindBar) return;
            }
            engine.slewTo({ az, alt }, { duration: 0.5 });
        }));
    });
}

// In the browser's own fullscreen Esc would leave at once. Where the browser lets a page keep the key (Chromium, on
// https), Esc steps back through the menu, drawer and system view first, as it does everywhere else.
function initFullscreenEscape() {
    const onChange = () => {
        const keyboard = navigator.keyboard;
        if (!keyboard || !keyboard.lock) return;
        if (document.fullscreenElement) keyboard.lock(['Escape']).catch(() => {});
        else keyboard.unlock();
    };
    document.addEventListener('fullscreenchange', onChange);
}

export function initShell(app) {
    const topRight = document.getElementById('spectroTopRight');
    topRight.classList.add('spectro-glass');

    // simulation_ui.js hangs the fullscreen and settings buttons on the canvas's corner when a page has no info bar.
    // Here they join the row in the top-right corner: Layers, Help, Settings, fullscreen.
    const actions = document.querySelector('.sim-action-buttons-overlay');
    if (actions) {
        actions.classList.remove('sim-actions-floating');
        const fullscreen = actions.querySelector('.sim-fullscreen-toggle');
        if (fullscreen) actions.appendChild(fullscreen);
        topRight.appendChild(actions);
    }

    initSkyFit();
    initBandBar(app);
    initHelpPage(app, topRight);
    app.shell = initLayersMenu(app, topRight);
    initSettingsPage(app);
    keepSelectionInView(app);
    initFullscreenEscape();

    // Reduce motion also reaches the page's own transitions
    const applyMotion = () => document.body.classList.toggle('spectro-reduce-motion', !!app.settings.reduceMotion);
    bus.on('settings', ({ key }) => { if (key === 'reduceMotion') applyMotion(); });
    applyMotion();

    // A layer gets called once a frame, so the zoom readout needs no timer of its own
    const updateZoom = initContextBar(app);
    app.engine.addLayer({ id: 'shell', update(frame) { updateZoom(frame.fov); } });

    initLegend(app);
}
