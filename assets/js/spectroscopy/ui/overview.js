// The Overview tab that every object opens on. It leads with what can be observed; the true values sit behind the
// "Catalogue values" expander, so a student can check themselves without having the answer in front of them.
// The code, kind and copy buttons are in the drawer's title, where they stay in view on every tab.

import { app, bus, select, setBand } from '../core/state.js';
import { BANDS, BAND_INFO } from '../core/bands.js';
import { sig } from '../core/format.js';
import { glossaryHtml } from '../content/glossary.js';
import { announce, kindLabelOf, safeInfo } from './drawer.js';

// Apparent magnitude in plain words. The limits line up with what shows at each zoom: see limitingMag in core/sky.js.
const BRIGHTNESS_WORDS = [
    [0, 'Dazzling: one of the brightest things in the sky'],
    [2, 'Very bright: it stands out straight away'],
    [4, 'Bright: easy to spot'],
    [6, 'Faint, but you can see it without zooming'],
    [10, 'Faint: zoom in to see it'],
    [14, 'Very faint: zoom in a long way'],
    [Infinity, 'Extremely faint: it only shows at the highest zoom']
];

export function brightnessWords(resolved) {
    const { entity, body, path } = resolved;
    if (path === 'planet') return 'Too faint to see from here: enter its system to find it';
    const own = entity.brightness || body.brightness;
    const visible = (entity.bands || body.bands || {}).visible;
    if (!own || own.mag >= 90 || visible <= 0.01) return 'Cannot be seen in visible light';
    const words = BRIGHTNESS_WORDS.find(([limit]) => own.mag <= limit)[1];
    return path === 'component' ? `Seen as one point with its companions. ${words}` : words;
}

function bandWord(strength) {
    if (!(strength > 0.01)) return 'None';
    if (strength < 0.15) return 'Faint';
    if (strength < 0.55) return 'Medium';
    return 'Bright';
}

function bandLevel(strength) {
    if (!(strength > 0.01)) return 0;
    if (strength < 0.15) return 1;
    if (strength < 0.55) return 2;
    return 3;
}

function bandsOf(resolved) {
    return resolved.entity.bands || resolved.body.bands || {};
}

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

function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

// Technical terms in the notes get a tooltip from the glossary, each one once per object. glossaryHtml escapes the text.
function fillWords(el, text, seen) {
    el.innerHTML = glossaryHtml(text, { seen });
    return el;
}

// A code that takes you to its object, as in "orbits 7KX2QM"
function codeLink(code) {
    const b = element('button', 'spectro-link', code);
    b.type = 'button';
    b.setAttribute('aria-label', `Select ${code}`);
    b.addEventListener('click', () => select(code));
    return b;
}

function relationLine(resolved) {
    const { entity, body, path } = resolved;
    let words = null;
    let code = null;
    if (path === 'planet') {
        words = 'Orbits';
        code = entity.host || body.code;
    } else if (path === 'component') {
        words = 'Part of';
        code = entity.parent || body.code;
    } else if (path === 'member') {
        words = 'Member of';
        code = entity.parent || body.code;
    }
    if (!code) return null;
    const line = element('p', 'spectro-relation', `${words} `);
    line.appendChild(codeLink(code));
    return line;
}

function factList(rows, seen) {
    const list = element('dl', 'spectro-facts');
    rows.forEach(([label, value, tip]) => {
        const row = element('div', 'spectro-fact');
        const dt = seen ? fillWords(element('dt'), label, seen) : element('dt', '', label);
        if (tip) dt.title = tip;
        row.append(dt, element('dd', '', value));
        list.appendChild(row);
    });
    return list;
}

// What a screen reader hears when an object is selected
export function describe(resolved) {
    const { entity } = resolved;
    const parts = [`${kindLabelOf(resolved)} ${entity.name || entity.code}.`, `${brightnessWords(resolved)}.`];
    const bands = bandsOf(resolved);
    const shows = BANDS.filter((b) => bands[b] > 0.01).map((b) => BAND_INFO[b].label);
    parts.push(shows.length ? `Shows in ${shows.join(', ')}.` : 'Does not show in any band.');
    const planet = planetData(resolved);
    if (planet) planetFacts(planet).forEach(([label, value]) => parts.push(`${label} ${value}.`));
    if (resolved.path === 'planet') parts.push(`Orbits ${entity.host || resolved.body.code}.`);
    return parts.join(' ');
}

function mountOverview(container) {
    const top = element('div', 'spectro-ov-top');
    const chipsWrap = element('div', 'spectro-ov-bands');
    const chipsLabel = element('p', 'spectro-ov-label', 'How it shows in each band');
    const chips = element('div', 'spectro-band-chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'How it shows in each band. Choose one to switch the sky to that band.');
    chipsWrap.append(chipsLabel, chips);
    const words = element('div', 'spectro-ov-words');
    container.append(top, chipsWrap, words);

    const chipByBand = {};
    BANDS.forEach((band) => {
        const chip = element('button', 'spectro-band-chip');
        chip.type = 'button';
        chip.title = `Switch the sky to ${BAND_INFO[band].label}`;
        const name = element('span', 'spectro-band-chip-name', BAND_INFO[band].short);
        const meter = element('span', 'spectro-band-chip-meter');
        meter.setAttribute('aria-hidden', 'true');
        const value = element('span', 'spectro-band-chip-value');
        chip.append(name, meter, value);
        chip.addEventListener('click', () => setBand(band));
        chips.appendChild(chip);
        chipByBand[band] = { chip, meter, value };
    });

    function paintChips(resolved) {
        const bands = bandsOf(resolved);
        BANDS.forEach((band) => {
            const { chip, meter, value } = chipByBand[band];
            const word = bandWord(bands[band]);
            value.textContent = word;
            meter.dataset.level = String(bandLevel(bands[band]));
            const { short, label } = BAND_INFO[band];
            chip.setAttribute('aria-label', `${short === label ? label : `${short}, ${label}`}: ${word}`);
        });
    }

    function paintCurrentBand(band) {
        BANDS.forEach((b) => chipByBand[b].chip.setAttribute('aria-pressed', b === band ? 'true' : 'false'));
    }

    bus.on('band', ({ band }) => paintCurrentBand(band));

    return {
        setEntity(resolved) {
            const info = safeInfo(resolved);
            paintCurrentBand(app.band);

            const relation = relationLine(resolved);
            const rows = [['Brightness', brightnessWords(resolved), 'How bright it looks from here, which depends on how much light it gives out and how far away it is.']];
            const planet = planetData(resolved);
            if (planet) rows.push(...planetFacts(planet));
            top.replaceChildren(...(relation ? [relation] : []), factList(rows));
            paintChips(resolved);

            const seen = new Set();
            words.replaceChildren();
            if (info.summary) words.appendChild(fillWords(element('p', 'spectro-ov-summary'), info.summary, seen));
            (info.notes || []).forEach((note) => {
                const block = element('section', 'spectro-ov-note');
                if (note.heading) block.appendChild(element('h4', '', note.heading));
                if (note.text) block.appendChild(fillWords(element('p'), note.text, seen));
                words.appendChild(block);
            });
            if (info.rarity) {
                const rarity = element('p', 'spectro-ov-rarity');
                const text = element('span');
                rarity.append(element('strong', '', 'How rare? '), fillWords(text, info.rarity, seen));
                words.appendChild(rarity);
            }

            // Built afresh for each object, so it always starts closed
            if (info.catalogue && info.catalogue.length) {
                const details = element('details', 'sim-controls-more spectro-catalogue');
                details.appendChild(element('summary', '', 'Catalogue values'));
                details.appendChild(element('p', 'spectro-catalogue-hint', 'The true values. Work them out from the light first, then check yourself here.'));
                details.appendChild(factList(info.catalogue.map((row) => [row.label, row.value]), seen));
                words.appendChild(details);
            }
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
