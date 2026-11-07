// The Go to box: type a code and the camera flies to that object and selects it, plus the Recent list and the
// ?goto= links a teacher can share (spec section 14).
//
// Autocomplete only offers what the student can already see (objects on screen in this band) or has already looked
// at (Recent). universe.allCodes() is never listed, so a code can't be fished out by typing its first letters.
//
// app.goto = { goto(code, opts), recent(), focus(), linkFor(code, band) }
//   goto(code, { band }) sets the band if given, then flies. Its promise gives true when the flight is over and the
//   object selected, and false if the code is unknown or the flight was called off or replaced by a newer one.
// Bus events sent: 'goto' { code } as a flight sets off, 'highlight' { code } when a cluster member is reached.

import { bus, select, setBand, setLayer } from '../core/state.js';
import { BANDS, BAND_INFO } from '../core/bands.js';
import { isValidCode } from '../core/rng.js';
import { limitingMag, angularSeparation, MIN_FOV, MAX_FOV } from '../core/sky.js';
import { drawMag, parallaxFactor } from '../core/depth.js';
import { createVisited } from './visited.js';
import { createSearchMarksLayer } from '../render/layers/search_marks.js';

const RECENT_MAX = 30;         // The list scrolls, and a search visits far more than the 10 first planned
const SUGGEST_MAX = 8;
const GUTTER_PX = 8;
const MIN_LIST_PX = 136;       // Three rows, however little canvas is left below the box
const BOX_WIDTH_PX = 216;      // What the full box needs in the top bar
const COMPACT_BELOW_PX = 640;  // A canvas narrower than this always gets the icon, wherever the band switcher sits
const ROW_PX = 44;

const FLIGHT_S = 1.5;
const MEMBER_ZOOM_S = 0.8;
const SYSTEM_STEP_LIMIT_MS = 12000; // A system transition that never reports back mustn't strand the selection

const HIDDEN_AT_OR_BELOW = 0.03;    // A band strength this small draws nothing a student could make out
const FRAME_MARGIN = 1.7;           // An extended object fills about 60% of the view
const POINT_FOV_DEG = 10;
const CLOSE_POINT_FOV_DEG = { binary: 4, multiple: 4, black_hole: 4 }; // Pairs need a tighter view to come apart
const SPLIT_PX = 20;                // Device pixels apart at which the sky draws a multiple's stars separately
const CLOSEST_PAIR_DEG = 0.02;      // About the tightest pair a multiple draws, for reaching one star of it
const MAG_MARGIN = 1;               // Stop a magnitude inside the limit, or the object only just glimmers

// Layers that add their own pick candidates (cluster members, stars of a multiple) once they can be told apart
const PICK_LAYERS = ['clusters', 'binaries', 'black_holes'];

const KIND_WORDS = {
    star: 'Star',
    binary: 'Binary star',
    multiple: 'Multiple star',
    rogue_planet: 'Rogue planet',
    comet: 'Comet',
    nebula: 'Nebula',
    cluster: 'Star cluster',
    neutron_star: 'Neutron star',
    galaxy: 'Galaxy',
    black_hole: 'Black hole',
    supernova: 'Supernova',
    quasar: 'Quasar'
};

const BAND_ALIASES = {
    infrared: 'ir',
    optical: 'visible',
    ultraviolet: 'uv',
    xrays: 'xray',
    gamma: 'xray',
    gammaray: 'xray',
    gammarays: 'xray'
};

// "f8q 3zn " -> "F8Q3ZN"
export function normaliseCode(text) {
    return String(text ?? '').replace(/\s+/g, '').toUpperCase();
}

// A band name from a link, in any of the ways someone might write it; null if it isn't one
export function parseBand(text) {
    const key = String(text ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (BANDS.includes(key)) return key;
    return BAND_ALIASES[key] || null;
}

// A link that opens the simulation on this object, optionally in this band. Only the Copy link button uses it:
// browsing never touches the address bar or the history.
export function linkFor(code, band) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('goto', normaliseCode(code));
    const parsed = parseBand(band);
    if (parsed) url.searchParams.set('band', parsed);
    return url.href;
}

function notFoundMessage(code) {
    if (code.length !== 6 || /[^A-Z0-9]/.test(code)) return 'No object with that code. Codes have 6 letters and numbers.';
    if (!isValidCode(code)) return 'No object with that code. Codes never use 0, O, 1, I or L.';
    return 'No object with that code. Check it and try again.';
}

// Plain words only: never the class or type, which the student is there to work out
function kindInWords({ body, path }) {
    if (path === 'planet') return 'Planet';
    if (path === 'member') return 'Star in a cluster';
    if (path === 'component') return body.black_hole ? 'Black hole companion' : 'Star in a multiple';
    if (body.kind === 'home_planet') return `${body.name}, home planet`;
    if (body.kind === 'binary' && body.architecture && body.architecture !== 'binary') return KIND_WORDS.multiple;
    return KIND_WORDS[body.kind] || 'Object';
}

// How much sky an object spans, in degrees, so it can be framed whole; points have no span
function skySpanDeg(body) {
    if (body.nebula) return body.nebula.size_deg;
    if (body.galaxy) return body.galaxy.size_deg;
    if (body.cluster) return body.cluster.radius_deg * 2;
    if (body.supernova) return body.supernova.shell_deg * 2;
    if (body.comet) return body.comet.tail_deg * 2; // The head sits mid-frame with the tail running out to one side
    return 0;
}

// The widest view that draws this magnitude. Bisected rather than copying limitingMag's formula, so they can't drift apart.
function widestFovShowing(mag) {
    if (limitingMag(MIN_FOV) < mag) return MIN_FOV;
    let narrow = MIN_FOV;
    let wide = MAX_FOV;
    for (let i = 0; i < 24; i++) {
        const mid = Math.sqrt(narrow * wide);
        if (limitingMag(mid) >= mag) narrow = mid;
        else wide = mid;
    }
    return narrow;
}

// Zoom in further if something this faint wouldn't be drawn at the view asked for. Something too faint to be drawn
// at any zoom (a rogue planet in visible light) keeps the view asked for, as zooming wouldn't bring it out.
function fovShowingMag(mag, fov) {
    if (!Number.isFinite(mag) || mag > limitingMag(MIN_FOV)) return fov;
    return Math.min(fov, widestFovShowing(mag + MAG_MARGIN));
}

// A field of view worked out as if the object were at depth 0, made tight enough for one at its real depth, which is drawn
// smaller. The factor itself depends on the zoom, but so gently that a few rounds settle it.
function fovAtDepth(fov, depth) {
    let at = fov;
    for (let i = 0; i < 4; i++) at = fov * parallaxFactor(depth, at);
    return at;
}

function strongestBand(body) {
    return BANDS.reduce((best, band) => (body.bands[band] > body.bands[best] ? band : best), 'visible');
}

function animationFrames(n) {
    return new Promise((resolve) => {
        const step = () => (n-- > 0 ? requestAnimationFrame(step) : resolve());
        step();
    });
}

function isTextEntry(el) {
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    return el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file'].includes(el.type);
}

// The cluster layer places members; imported when needed, so this still works if that export is ever missing
async function memberDirection(body, member) {
    try {
        const { memberSkyDirection } = await import('../render/layers/clusters.js');
        const dir = memberSkyDirection && memberSkyDirection(body, member);
        if (dir && Number.isFinite(dir.az) && Number.isFinite(dir.alt)) return dir;
    } catch (err) {
        console.error('[spectroscopy] go to: no position for a cluster member:', err);
    }
    return body.sky;
}

function untilDone(start) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, SYSTEM_STEP_LIMIT_MS);
        const finish = () => {
            clearTimeout(timer);
            resolve();
        };
        try {
            start(finish);
        } catch (err) {
            console.error('[spectroscopy] go to: the system view failed:', err);
            finish();
        }
    });
}

export function initGoto(app) {
    const { engine, universe } = app;
    const canvas = engine.canvas;
    const region = document.getElementById('spectroTopLeft');

    const root = document.createElement('div');
    root.className = 'spectro-goto';
    root.innerHTML = `
        <button type="button" class="sim-icon-button spectro-goto-toggle" aria-label="Go to an object by its code" title="Go to an object by its code" aria-expanded="false" aria-controls="spectroGotoFly" hidden>
            <span class="icon solid fa-search" aria-hidden="true"></span>
        </button>
        <div class="spectro-goto-fly" id="spectroGotoFly">
            <form class="spectro-goto-form" role="search" aria-label="Go to an object" novalidate>
                <label class="spectro-goto-label" for="spectroGotoInput">Go to</label>
                <input id="spectroGotoInput" class="spectro-goto-input" type="text" placeholder="Code, e.g. F8Q3ZN"
                    title="Go to an object by its code (shortcut: /)" role="combobox" aria-autocomplete="list"
                    aria-expanded="false" aria-controls="spectroGotoList" aria-describedby="spectroGotoMessage"
                    aria-keyshortcuts="/" autocomplete="off" autocapitalize="characters" autocorrect="off"
                    spellcheck="false" enterkeyhint="go">
                <button type="submit" class="sim-icon-button spectro-goto-go" aria-label="Go" title="Go">
                    <span class="icon solid fa-arrow-right" aria-hidden="true"></span>
                </button>
            </form>
            <div class="spectro-goto-pop">
                <ul id="spectroGotoList" class="spectro-goto-list" role="listbox" aria-label="Codes you can go to" hidden></ul>
                <div class="spectro-goto-prompt" role="group" aria-labelledby="spectroGotoPromptText" hidden>
                    <p id="spectroGotoPromptText"></p>
                    <div class="spectro-goto-choices">
                        <button type="button" class="spectro-goto-switch"></button>
                        <button type="button" class="spectro-goto-stay"></button>
                    </div>
                </div>
                <div id="spectroGotoMessage" class="spectro-goto-message" role="status" aria-live="polite"></div>
            </div>
        </div>`;
    region.appendChild(root);

    const toggle = root.querySelector('.spectro-goto-toggle');
    const form = root.querySelector('.spectro-goto-form');
    const input = root.querySelector('.spectro-goto-input');
    const list = root.querySelector('.spectro-goto-list');
    const prompt = root.querySelector('.spectro-goto-prompt');
    const promptText = root.querySelector('#spectroGotoPromptText');
    const switchButton = root.querySelector('.spectro-goto-switch');
    const stayButton = root.querySelector('.spectro-goto-stay');
    const message = root.querySelector('.spectro-goto-message');

    app.visited = createVisited(app);
    engine.addLayer(createSearchMarksLayer(engine, app));

    // With no way to draw, a system could never finish opening: the panels still work, and that's all that's offered
    if (!engine.renderer && app.system) {
        document.body.classList.add('spectro-no-sky');
        app.system.enter = (code, opts = {}) => {
            if (opts.onDone) opts.onDone();
            return false;
        };
    }

    const recents = [];         // Codes, newest first. In memory only: the only thing kept is which systems were visited
    let rows = [];              // What the dropdown is showing: [{ code, kind, recent }]
    let activeRow = -1;
    let flightId = 0;           // Each new flight bumps this, and an older flight's remaining steps then stop
    let answerPrompt = null;    // Set while the band prompt is waiting for an answer
    let compact = false;
    let returnTo = null;        // Where Esc puts the focus back

    // The code the system view opens for this selection, or null if it opens nothing
    function systemCodeOf(resolved) {
        const system = app.system;
        if (!system) return null;
        if (system.systemOf) {
            const opened = system.systemOf(resolved);
            return opened ? opened.code : null;
        }
        return system.hasSystemView(resolved.body) ? resolved.body.code : null;
    }

    // --- Recent and autocomplete ---

    bus.on('select', ({ code }) => {
        const seen = recents.indexOf(code);
        if (seen >= 0) recents.splice(seen, 1);
        recents.unshift(code);
        recents.length = Math.min(recents.length, RECENT_MAX);
    });

    // Codes the student can see right now, nearest the middle of the view first
    function visibleCodes() {
        if (app.view === 'system') {
            const open = app.systemCode && universe.resolve(app.systemCode);
            if (!open) return [];
            const { body } = open;
            const companion = body.black_hole ? [body.black_hole.companion] : [];
            return [body, ...(body.planets || []), ...(body.stars || []), ...companion].map((entity) => entity.code);
        }
        const frame = engine.currentFrame();
        const distances = new Map();
        const consider = (code, az, alt, depth) => {
            const p = engine.project(az, alt, depth);
            if (p && p.onScreen) distances.set(code, Math.hypot(p.x - frame.width / 2, p.y - frame.height / 2));
        };
        universe.bodies.forEach((body) => {
            if (engine.bodyShows(body) && !isFaintInBand(body)) consider(body.code, body.sky.az, body.sky.alt, body.depth);
        });
        PICK_LAYERS.forEach((id) => {
            const layer = engine.getLayer(id);
            if (layer && layer.picks) (layer.picks(frame) || []).forEach((c) => consider(c.code, c.az, c.alt, c.depth));
        });
        return [...distances.keys()].sort((a, b) => distances.get(a) - distances.get(b));
    }

    function matches(resolved, query) {
        if (resolved.entity.code.startsWith(query)) return true;
        return resolved.body.kind === 'home_planet' && resolved.body.name.toUpperCase().startsWith(query);
    }

    function suggestions(text) {
        const query = normaliseCode(text);
        const found = new Map();
        const add = (code, recent) => {
            if (found.has(code)) return;
            const resolved = universe.resolve(code);
            if (resolved && matches(resolved, query)) found.set(code, { code, kind: kindInWords(resolved), recent, visited: app.visited.has(systemCodeOf(resolved)) });
        };
        recents.forEach((code) => add(code, true));
        if (!query) return [...found.values()]; // An empty box offers Recent alone
        visibleCodes().forEach((code) => add(code, false));
        return [...found.values()].slice(0, SUGGEST_MAX);
    }

    function textSpan(className, text) {
        const span = document.createElement('span');
        span.className = className;
        span.textContent = text;
        return span;
    }

    function optionRow(row, i) {
        const li = document.createElement('li');
        li.id = `spectroGotoOption${i}`;
        li.className = 'spectro-goto-option';
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.dataset.code = row.code;
        li.append(textSpan('spectro-goto-code', row.code), textSpan('spectro-goto-kind', row.kind));
        if (row.visited) li.append(textSpan('spectro-goto-recent', '✓ Visited'));
        else if (row.recent) li.append(textSpan('spectro-goto-recent', 'Recent'));
        return li;
    }

    function closeList() {
        rows = [];
        activeRow = -1;
        list.hidden = true;
        list.replaceChildren();
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }

    function refreshList() {
        closeList();
        rows = suggestions(input.value);
        if (!rows.length) return;
        list.replaceChildren(...rows.map(optionRow));
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        // The canvas clips what hangs over its edge, so the list scrolls within what's left
        const room = canvas.getBoundingClientRect().bottom - list.getBoundingClientRect().top - GUTTER_PX;
        list.style.maxHeight = `${Math.max(MIN_LIST_PX, room)}px`;
    }

    function moveActive(step) {
        if (list.hidden) refreshList();
        if (list.hidden) return;
        const n = rows.length;
        activeRow = activeRow < 0 ? (step > 0 ? 0 : n - 1) : (activeRow + step + n) % n;
        [...list.children].forEach((li, i) => {
            li.classList.toggle('is-active', i === activeRow);
            li.setAttribute('aria-selected', i === activeRow ? 'true' : 'false');
        });
        const li = list.children[activeRow];
        input.setAttribute('aria-activedescendant', li.id);
        // By hand: scrollIntoView could scroll the whole page as well
        if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop;
        else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight;
    }

    // --- The box and its messages ---

    function showMessage(text, isError = false) {
        message.textContent = text;
        message.classList.toggle('is-error', isError);
        input.setAttribute('aria-invalid', isError ? 'true' : 'false');
    }

    function clearMessage() {
        showMessage('');
    }

    function setBoxOpen(open) {
        root.classList.toggle('is-open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function focusBox() {
        const active = document.activeElement;
        if (!root.contains(active)) returnTo = active && active !== document.body ? active : null;
        setBoxOpen(true);
        input.focus();
        input.select();
    }

    function leave() {
        cancelPrompt();
        closeList();
        clearMessage();
        input.value = '';
        // Moved before the box closes: a hidden element would drop the focus on the page itself
        const target = returnTo && document.contains(returnTo) ? returnTo : (compact ? toggle : canvas);
        returnTo = null;
        target.focus({ preventScroll: true });
        setBoxOpen(false);
    }

    // A flight has set off: the box is done with, and the sky's keys work again straight away
    function finishWithBox() {
        input.value = '';
        returnTo = null;
        closeList();
        if (root.contains(document.activeElement)) canvas.focus({ preventScroll: true });
        setBoxOpen(false);
    }

    function announce(text) {
        const live = document.getElementById('spectroLive');
        if (live) live.textContent = text;
    }

    // --- The band prompt ---

    function askToSwitch(hiddenIn, strongest) {
        const from = BAND_INFO[hiddenIn].short;
        const to = BAND_INFO[strongest].short;
        promptText.textContent = `Hidden in ${from}. Switch to ${to}?`;
        switchButton.textContent = `Switch to ${to}`;
        stayButton.textContent = `Stay in ${from}`;
        prompt.hidden = false;
        switchButton.focus({ preventScroll: true });
        return new Promise((resolve) => {
            answerPrompt = (choice) => {
                answerPrompt = null;
                resolve(choice);
            };
        });
    }

    // Moves the focus on first, as hiding a focused button would drop it on the page itself
    function answer(choice) {
        if (prompt.contains(document.activeElement)) canvas.focus({ preventScroll: true });
        prompt.hidden = true;
        if (answerPrompt) answerPrompt(choice);
    }

    function cancelPrompt() {
        if (answerPrompt) answer('cancel');
    }

    function isFaintInBand(body) {
        return body.bands[app.band] <= HIDDEN_AT_OR_BELOW;
    }

    function isHidden({ body, path }) {
        if (path === 'planet') return false; // Not drawn on the sky at all: the flight ends in its system, whatever the band
        return isFaintInBand(body) && strongestBand(body) !== app.band;
    }

    // --- Flights ---

    // Resolves when the slew ends, even if something cuts it short without calling onDone, such as a drag or a newer flight
    function slew(target, { duration = FLIGHT_S, pullBack = true } = {}) {
        const view = engine.getView();
        const framed = angularSeparation(view.az, view.alt, target.az, target.alt) < view.fov * 0.02
            && Math.abs(Math.log(view.fov / target.fov)) < 0.05;
        if (framed && !engine.isSlewing()) return Promise.resolve(); // No wobble; but an older flight mustn't carry on

        return new Promise((resolve) => {
            let watch = null;
            let done = false;
            const finish = () => {
                done = true;
                clearInterval(watch);
                resolve();
            };
            engine.slewTo(target, { duration, pullBack, onDone: finish });
            if (!done) watch = setInterval(() => { if (!engine.isSlewing()) finish(); }, 200);
        });
    }

    // A multiple's stars only come apart once they are some pixels apart, so its view depends on the canvas
    function pointFov(body, path) {
        const widest = CLOSE_POINT_FOV_DEG[body.kind] || POINT_FOV_DEG;
        if (!body.visual_sep_deg) return widest;
        const { height, dpr } = engine.currentFrame();
        const sep = path === 'component' ? Math.min(body.visual_sep_deg, CLOSEST_PAIR_DEG) : body.visual_sep_deg;
        return Math.min(widest, fovAtDepth((sep * height * dpr) / SPLIT_PX, body.depth));
    }

    function frameFor({ body, path }) {
        // fov is vertical, so a portrait canvas needs a wider one to fit the object across
        const narrowest = Math.min(1, engine.camera.aspect || 1);
        const span = skySpanDeg(body);
        const framed = span > 0 ? fovAtDepth((span * FRAME_MARGIN) / narrowest, body.depth) : pointFov(body, path);
        const fov = Math.max(MIN_FOV, Math.min(MAX_FOV, framed));
        const shows = engine.bodyShows(body, limitingMag(fov) - MAG_MARGIN);
        return { az: body.sky.az, alt: body.sky.alt, fov: shows ? fov : fovShowingMag(body.brightness && drawMag(body), fov) };
    }

    function memberFov(body, member) {
        const fov = Math.max(MIN_FOV, fovAtDepth(body.cluster.radius_deg * 1.2, body.depth));
        // Only visible light has a brightness limit: see engine.bodyShows
        return app.band === 'visible' ? fovShowingMag(member.brightness && drawMag(member), fov) : fov;
    }

    // The view and the panel are always about the same thing. Selecting something outside the open system, from the H-R
    // list say, leaves for the sky and brings it into view.
    bus.on('select', ({ resolved }) => {
        if (app.view !== 'system' || !app.system || app.systemCode === systemCodeOf(resolved)) return;
        const id = ++flightId;
        app.system.exit({
            onDone() {
                if (id === flightId) slew(frameFor(resolved));
            }
        });
    });

    async function fly(resolved, id) {
        const { entity, body, path } = resolved;
        const stillCurrent = () => id === flightId;
        const systemCode = systemCodeOf(resolved);
        const inItsSystem = () => !!systemCode && app.view === 'system' && app.systemCode === systemCode;
        const leave = () => untilDone((onDone) => app.system.exit({ onDone }));
        const goIn = () => untilDone((onDone) => app.system.enter(systemCode, { onDone, focus: false }));

        if (inItsSystem()) {
            await goIn(); // Nothing to do if it's open, and if it's on the way out this turns it round
            if (!stillCurrent()) return false;
            if (!inItsSystem()) return false;
            // As a row in the System tab does: a star's code goes back to the whole system or on to that star
            app.system.focusPlanet(path === 'planet' || path === 'component' ? entity.code : null);
            select(entity.code);
            return true;
        }
        if (app.view === 'system' && app.system) {
            await leave();
            if (!stillCurrent()) return false;
        }

        await slew(frameFor(resolved));
        if (!stillCurrent()) return false;

        // Enter system pressed on the way, while the panel still showed the object being left: they meant this one
        const pressedEnter = app.view === 'system';
        if (pressedEnter && !inItsSystem()) {
            await leave();
            if (!stillCurrent()) return false;
        }
        if ((path === 'planet' || pressedEnter) && systemCode && engine.renderer) {
            await goIn();
            if (!stillCurrent()) return false;
            if (!inItsSystem()) return false; // Esc on the way in called the whole thing off
            if (path === 'planet') app.system.focusPlanet(entity.code);
        }
        select(entity.code);
        if (path === 'member' && app.view === 'sky') {
            // Selected before the zoom, and the zoom waits a few frames. Just after a selection the shell pulls the
            // selected body back on screen if it has gone, and a member's body is its cluster: selected at the end,
            // the camera would be dragged off the member again.
            await animationFrames(3);
            const dir = await memberDirection(body, entity);
            if (!stillCurrent()) return false;
            await slew({ az: dir.az, alt: dir.alt, fov: memberFov(body, entity) }, { duration: MEMBER_ZOOM_S, pullBack: false });
            if (!stillCurrent()) return false;
            bus.emit('highlight', { code: entity.code });
        }
        return true;
    }

    function findObject(code) {
        const found = code ? universe.resolve(code) : null;
        if (found) return found;
        // Home planets show their real names rather than codes, so a student may well type one
        const home = universe.bodies.find((body) => body.kind === 'home_planet' && body.name.toUpperCase() === code);
        return home ? universe.resolve(home.code) : null;
    }

    async function goto(text, opts = {}) {
        cancelPrompt();
        closeList();
        clearMessage();
        const code = normaliseCode(text);
        const resolved = findObject(code);
        if (!resolved) {
            if (!input.value) input.value = code; // From a link: shows what was asked for, ready to correct
            showMessage(notFoundMessage(code), true);
            return false;
        }
        const id = ++flightId;

        const band = parseBand(opts.band);
        if (band) setBand(band);

        const { entity, body } = resolved;
        let note = '';
        if (body.kind === 'home_planet' && !app.layers.homePlanets) {
            setLayer('homePlanets', true);
            note = 'Home planets were off, so they are on now.';
        }
        const inOpenSystem = app.view === 'system' && app.systemCode === systemCodeOf(resolved);
        if (!inOpenSystem && isHidden(resolved)) {
            const hiddenIn = app.band;
            const strongest = strongestBand(body);
            input.value = entity.code;
            const choice = await askToSwitch(hiddenIn, strongest);
            if (id !== flightId || choice === 'cancel') return false;
            if (choice === 'switch') setBand(strongest);
            else note = `Still hidden in ${BAND_INFO[hiddenIn].short}. Switch to ${BAND_INFO[strongest].short} to see it.`;
        }
        if (note) showMessage(note);
        finishWithBox();
        announce(`Going to ${entity.name || entity.code}.`);
        bus.emit('goto', { code: entity.code });
        return fly(resolved, id);
    }

    function submit() {
        const query = normaliseCode(input.value);
        if (!query) {
            refreshList();
            return;
        }
        // A part-typed code with only one possible match can only mean that one
        goto(!findObject(query) && rows.length === 1 ? rows[0].code : query);
    }

    // --- Events ---

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        submit();
    });

    input.addEventListener('focus', refreshList);

    input.addEventListener('input', () => {
        cancelPrompt();
        clearMessage();
        refreshList();
    });

    input.addEventListener('keydown', (e) => {
        e.stopPropagation(); // While typing, every key belongs to the box: not the sky, the drawer or the page
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            moveActive(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter' && activeRow >= 0) {
            e.preventDefault();
            goto(rows[activeRow].code);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            leave();
        }
    });

    // Holding the press back keeps the focus in the box, so the list doesn't close before the click lands
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => {
        const li = e.target.closest('[role="option"]');
        if (li) goto(li.dataset.code);
    });

    switchButton.addEventListener('click', () => answer('switch'));
    stayButton.addEventListener('click', () => answer('stay'));
    message.addEventListener('click', clearMessage); // On a phone it can sit over the band switcher

    // Esc on the prompt's buttons, Go or the icon: leaves the box, and the drawer stays as it was
    root.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        leave();
    });

    toggle.addEventListener('click', () => {
        if (root.classList.contains('is-open')) leave();
        else focusBox();
    });

    root.addEventListener('focusout', (e) => {
        // relatedTarget is null when a phone taps Go without focusing it, which mustn't close the box under the tap
        if (e.relatedTarget && !root.contains(e.relatedTarget)) {
            closeList();
            setBoxOpen(false);
        }
    });

    document.addEventListener('pointerdown', (e) => {
        if (root.contains(e.target)) return;
        cancelPrompt();
        closeList();
        clearMessage();
        setBoxOpen(false);
    }, true);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            cancelPrompt();
            clearMessage();
        } else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTextEntry(document.activeElement)
            && !document.body.classList.contains('is-menu-visible')) {
            e.preventDefault(); // So the / isn't typed into the box, and Firefox's quick find stays shut
            focusBox();
        }
    });

    // --- Fitting the top bar ---

    // The full box wherever it clears the band switcher, and otherwise the icon. Measured, not guessed from the
    // window, as an open drawer narrows the canvas too.
    function fit() {
        const canvasBox = canvas.getBoundingClientRect();
        const box = root.getBoundingClientRect();
        const toEdge = canvasBox.right - box.left - GUTTER_PX;
        let room = toEdge;
        const bar = document.getElementById('spectroBandBar');
        const barBox = bar && bar.getBoundingClientRect();
        if (barBox && barBox.width > 0 && barBox.height > 0 && barBox.top < box.top + ROW_PX && barBox.bottom > box.top) {
            room = Math.min(room, barBox.left - box.left - GUTTER_PX);
        }
        root.style.setProperty('--spectro-goto-room', `${Math.round(toEdge)}px`);
        const next = canvasBox.width < COMPACT_BELOW_PX || room < BOX_WIDTH_PX;
        if (next === compact) return;
        compact = next;
        root.classList.toggle('is-compact', compact);
        toggle.hidden = !compact;
        // Collapsing mustn't pull the box from under someone typing in it
        setBoxOpen(compact && root.contains(document.activeElement) && document.activeElement !== toggle);
    }

    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    const bandBar = document.getElementById('spectroBandBar');
    if (bandBar) observer.observe(bandBar);
    fit();

    app.goto = { goto, recent: () => [...recents], focus: focusBox, linkFor };

    // --- Links ---

    function openFromLink() {
        const params = new URLSearchParams(location.search);
        const band = parseBand(params.get('band'));
        if (band) setBand(band);
        const code = params.get('goto');
        if (code) goto(code);
    }

    if (window.__spectro) {
        openFromLink(); // main.js sets this just before it sends 'ready'
    } else {
        const off = bus.on('ready', () => {
            off();
            openFromLink();
        });
    }
}
