// The Overview tab that every object opens on: one sentence on what it is, a few facts at most, which bands to look in,
// and the obvious next thing to do. It must fit the drawer without scrolling, for every kind of object. Everything else
// there is to read, including the true values, is in the Info tab (ui/info_tab.js): that's where new words belong.
// The code, kind and copy buttons are in the drawer's title, where they stay in view on every tab.

import { app, bus, setBand } from '../core/state.js';
import { BANDS, BAND_INFO, BAND_HIDDEN_AT } from '../core/bands.js';
import { sig } from '../core/format.js';
import { limitingMag, MIN_FOV } from '../core/sky.js';
import { bandMagnitudes, NOT_SEEN } from '../data/band_table.js';
import { codeHtml, tipHtml } from '../content/glossary.js';
import { MIN_GLOW } from '../render/engine.js';
import { announce, kindLabelOf, safeInfo } from './drawer.js';
import { nextButton, richHtml } from './info_tab.js';

// ---------- Which bands it shines in ----------
// The row is the object's own light, band by band: its band strengths (body.bands), each against its strongest. That is
// what "shines most in" means to a student. A spiral galaxy is mostly starlight, so it shines most in visible light,
// however well its few X-ray sources happen to stand out on a sky that is dark in X-rays.

const MOST_SHARE = 0.75;        // At least three quarters of its strongest band
const SOME_SHARE = 0.35;
const FAINTEST_DRAWN_MAG = limitingMag(MIN_FOV) - 2.5 * Math.log10(MIN_GLOW); // Nothing fainter shows even at full zoom

const BAND_WORDS = ['None', 'A little', 'Some', 'Most'];

// { levels: { band: 0..3 }, most: [bands], best: band or null, seen: { band: bool } }
// seen is whether the sky draws it in that band at all, which is what says it is hidden there.
function bandProfile(resolved) {
    const { entity, body } = resolved;
    const strengths = entity.bands || body.bands || {};
    const mags = bandMagnitudes(entity);
    const strength = (band) => (strengths[band] > BAND_HIDDEN_AT ? strengths[band] : 0);
    const top = Math.max(0, ...BANDS.map(strength));
    const levels = {};
    const seen = {};
    BANDS.forEach((band) => {
        const share = top > 0 ? strength(band) / top : 0;
        levels[band] = share <= 0 ? 0 : share >= MOST_SHARE ? 3 : share >= SOME_SHARE ? 2 : 1;
        seen[band] = levels[band] > 0 && mags[band] < NOT_SEEN && mags[band] <= FAINTEST_DRAWN_MAG;
    });
    let best = null;
    BANDS.forEach((band) => { if (seen[band] && (best === null || strength(band) > strength(best))) best = band; });
    return { levels, best, seen, most: BANDS.filter((band) => levels[band] === 3) };
}

function listWords(words) {
    if (words.length < 2) return words.join('');
    return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// ---------- Whether it can be seen right now ----------
// Says something only when it can't: what is on screen speaks for itself, and words about brightness can only disagree
// with the band and zoom in use.

const STATUS = { NONE: 0, PLANET: 1, LAYER_OFF: 2, HIDDEN: 3, TOO_FAINT: 4 };

function statusOf(resolved, profile) {
    const { body, path } = resolved;
    if (app.view !== 'sky') return STATUS.NONE;
    if (path === 'planet') return STATUS.PLANET;
    if (body.kind === 'home_planet' && !app.layers.homePlanets) return STATUS.LAYER_OFF;
    if (!profile.seen[app.band]) return STATUS.HIDDEN;
    return app.engine.bodyShows(body) ? STATUS.NONE : STATUS.TOO_FAINT;
}

function statusWords(status, profile) {
    switch (status) {
        case STATUS.PLANET: return 'Too faint to see from the sky. Enter its system to find it.';
        case STATUS.LAYER_OFF: return 'Home planets are switched off in Layers.';
        case STATUS.HIDDEN: {
            const hidden = `Hidden in ${BAND_INFO[app.band].short}.`;
            return profile.best ? `${hidden} Try ${BAND_INFO[profile.best].short}.` : hidden;
        }
        case STATUS.TOO_FAINT: return 'Too faint to see at this zoom. Zoom in to find it.';
        default: return '';
    }
}

// ---------- Facts ----------

// A planet's numbers are open: Module 5 needs them. A home planet keeps its in a planet block.
function planetData(resolved) {
    if (resolved.path === 'planet') return resolved.entity;
    return resolved.entity.planet || null;
}

function periodWords(days) {
    if (days >= 700) return `${sig(days / 365.25, 3)} years`;
    return `${sig(days, 3)} days`;
}

function planetFacts(planet) {
    const facts = [];
    if (Number.isFinite(planet.orbit_AU)) facts.push(['Orbit', `${sig(planet.orbit_AU, 3)} AU`, 'Average distance from its star. 1 AU is the distance from Earth to the Sun.']);
    if (Number.isFinite(planet.period_days)) facts.push(['Period', periodWords(planet.period_days), 'Time for one full orbit.']);
    if (Number.isFinite(planet.radius_Rearth)) facts.push(['Radius', `${sig(planet.radius_Rearth, 3)} Earth radii`, '']);
    if (Number.isFinite(planet.mass_Mearth)) facts.push(['Mass', `${sig(planet.mass_Mearth, 3)} Earth masses`, '']);
    return facts;
}

// The code this object leads to, in words: [label, code]. It is the same link as any other code in the drawer. From among
// a cluster's stars the cluster is all round the view, so the way back to it flies out far enough to see it whole: [.., fly].
function relationOf({ entity, body, path }) {
    if (path === 'planet') return ['Orbits', entity.host || body.code];
    if (path === 'component') return ['Part of', entity.parent || body.code];
    if (path === 'member') return ['Member of', entity.parent || body.code, true];
    if (entity.in_cluster) return ['Member of', entity.in_cluster, true];
    if (entity.kind === 'black_hole' && entity.black_hole?.companion?.code) return ['Companion', entity.black_hole.companion.code];
    return null;
}

function planetsHere({ entity }) {
    return Array.isArray(entity.planets) ? entity.planets.length : 0;
}

function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

function factRow(label, html) {
    const row = element('div', 'spectro-fact');
    const dd = element('dd');
    dd.innerHTML = html;
    row.append(element('dt', '', label), dd);
    return row;
}

function planetStat([label, value, tip]) {
    const stat = element('div', 'spectro-ov-stat');
    const dt = element('dt', '', label);
    if (tip) dt.innerHTML = tipHtml(label, tip);
    stat.append(dt, element('dd', '', value));
    return stat;
}

// What a screen reader hears when an object is selected
export function describe(resolved) {
    const { entity, body, path } = resolved;
    const parts = [`${kindLabelOf(resolved)} ${entity.name || entity.code}.`];
    const profile = path === 'planet' ? null : bandProfile(resolved);
    const status = statusWords(statusOf(resolved, profile), profile);
    if (status) parts.push(status);
    if (profile) {
        const others = BANDS.filter((band) => profile.levels[band] === 1 || profile.levels[band] === 2);
        const named = (bands) => listWords(bands.map((band) => BAND_INFO[band].label));
        parts.push(profile.most.length ? `Shines most in ${named(profile.most)}.` : 'Does not show in any band.');
        if (others.length) parts.push(`Also shows in ${named(others)}.`);
    }
    const count = planetsHere(resolved);
    if (count) parts.push(`${count === 1 ? 'One planet orbits' : `${count} planets orbit`} here.`);
    if (path !== 'planet' && app.view === 'sky' && app.system && app.system.hasSystemView && app.system.hasSystemView(body)) {
        parts.push('Its system can be entered, with Enter system.');
    }
    const planet = planetData(resolved);
    if (planet) planetFacts(planet).forEach(([label, value]) => parts.push(`${label} ${value}.`));
    if (path === 'planet') parts.push(`Orbits ${entity.host || body.code}.`);
    return parts.join(' ');
}

function mountOverview(container) {
    const lead = element('p', 'spectro-ov-lead');
    const status = element('p', 'spectro-ov-status');
    const facts = element('dl', 'spectro-facts');
    const stats = element('dl', 'spectro-ov-stats');

    const bandsWrap = element('div', 'spectro-ov-bands');
    const bandsLabel = element('p', 'spectro-ov-label');
    bandsLabel.innerHTML = `${tipHtml('Shines most in', "How its own light is shared between the bands, each against its strongest. Choose a band to switch the sky to it.")} `;
    const bandsMost = element('strong');
    bandsLabel.appendChild(bandsMost);
    const chips = element('div', 'spectro-band-chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'How it shines in each band, compared with itself. Choose one to switch the sky to that band.');
    bandsWrap.append(bandsLabel, chips);

    const nextHolder = element('div', 'spectro-ov-next');
    container.append(lead, status, facts, stats, bandsWrap, nextHolder);

    const chipByBand = {};
    BANDS.forEach((band) => {
        const chip = element('button', 'spectro-band-chip');
        chip.type = 'button';
        chip.title = `Switch the sky to ${BAND_INFO[band].label}`;
        // The band's name, and under it a bar as long as its share: its word is in the button's name and tooltip
        const name = element('span', 'spectro-band-chip-name', BAND_INFO[band].short);
        const meter = element('span', 'spectro-band-chip-meter');
        meter.setAttribute('aria-hidden', 'true');
        chip.append(name, meter);
        chip.addEventListener('click', () => setBand(band));
        chips.appendChild(chip);
        chipByBand[band] = { chip, meter };
    });

    let current = null;
    let profile = null;
    let shownStatus = -1;
    let shownBand = '';
    let onScreen = false;
    let lastFov = 0;

    // Often called, as the zoom changes: the words are only made when they would read differently
    function paintStatus() {
        const next = statusOf(current, profile);
        if (next === shownStatus && app.band === shownBand) return;
        shownStatus = next;
        shownBand = app.band;
        status.textContent = statusWords(next, profile);
        status.hidden = next === STATUS.NONE;
    }

    function paintChips() {
        // A planet can't be picked out from the sky, and the sky's band means nothing inside a system
        bandsWrap.hidden = current.path === 'planet' || app.view !== 'sky';
        if (bandsWrap.hidden) return;
        bandsMost.textContent = profile.most.length ? listWords(profile.most.map((band) => BAND_INFO[band].short)) : 'no band';
        BANDS.forEach((band) => {
            const { chip, meter } = chipByBand[band];
            const word = BAND_WORDS[profile.levels[band]];
            meter.dataset.level = String(profile.levels[band]);
            const { short, label } = BAND_INFO[band];
            chip.setAttribute('aria-label', `${short === label ? label : `${short}, ${label}`}: ${word}`);
            chip.title = `${label}: ${word.toLowerCase()}. Choose to switch the sky to it.`;
            chip.setAttribute('aria-pressed', band === app.band ? 'true' : 'false');
        });
    }

    function paint() {
        if (!current) return;
        shownStatus = -1;
        paintStatus();
        paintChips();
    }

    bus.on('band', paint);
    bus.on('view', paint);
    bus.on('layer', paint);
    // The status follows the zoom. The engine calls this every frame, so it compares one number and goes.
    app.engine.addLayer({
        id: 'overview-status',
        update(frame) {
            if (!onScreen || !current || frame.fov === lastFov) return;
            lastFov = frame.fov;
            paintStatus();
        }
    });

    return {
        setEntity(resolved) {
            current = resolved;
            profile = resolved.path === 'planet' ? { levels: {}, most: [], best: null } : bandProfile(resolved);
            const info = safeInfo(resolved);
            lead.innerHTML = richHtml(info.lead || '');
            const rows = [];
            const relation = relationOf(resolved);
            if (relation) rows.push(factRow(relation[0], codeHtml(relation[1], { fly: !!relation[2] })));
            const count = planetsHere(resolved);
            if (count) rows.push(factRow('Planets', String(count)));
            facts.replaceChildren(...rows);
            facts.hidden = !rows.length;
            const planet = planetData(resolved);
            stats.replaceChildren(...(planet ? planetFacts(planet).map(planetStat) : []));
            stats.hidden = !planet;
            nextHolder.replaceChildren(...(info.next ? [nextButton(info.next)] : []));
            paint();
        },
        onShow() {
            onScreen = true;
            paintStatus();
        },
        onHide() {
            onScreen = false;
        }
    };
}

export function initOverviewTab() {
    app.drawer.registerTab({
        id: 'overview',
        label: 'Overview',
        order: 10,
        appliesTo: () => true,
        mount: mountOverview
    });
    bus.on('select', ({ resolved }) => announce(describe(resolved)));
}
