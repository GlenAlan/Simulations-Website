// The reference picker: one grouped, searchable list (spec 10.3), arrows that step through it, a black-body temperature
// slider, and a slider that Doppler-shifts the reference to line it up with the object. It starts on no reference.
//
//   const picker = createRefPicker(container, { onChange(state), onLabels(on), onOpenChange(open), onFrame(lo, hi) })
//   picker.state() -> { id, item, T, z, shift_kms, labels }   item is null for "No reference"
//   picker.setEntity(resolved)   sets the shift slider's range for this kind of object and zeroes it
//   picker.setView(lo, hi)       the range on show: a reference with a range of its own offers to go there when it's elsewhere
//   picker.setNote(text)         a note under the list, for what the reference's spectrum says about itself
//   picker.choose(id), picker.setTemperature(T), picker.setShiftZ(z), picker.setLabels(on), picker.dispose()
//   picker.parts                 its pieces, which the panel places: the box and arrows go in the reference pane's header,
//                                the list and sliders under the plot
//
// The list is a combobox over a listbox rather than a native select, because a select's rows can't be made 44 px
// tall on a desktop and can't be filtered. It opens under the plot, so the plot stays on screen; arrow keys
// try each reference live and Esc goes back to the one before.

import { REFERENCE_GROUPS } from '../../data/references.js';
import { C_KMS, wienPeakNm } from '../../core/phys.js';
import { CZ_REASON, beyondCz, shiftWords, speedText, withCommas, wavelength, zPlain } from '../../core/format.js';

const NONE = { id: 'none', label: 'No reference', kind: 'none' };
let nextId = 0;

function norm(text) {
    return String(text ?? '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/α/g, 'a')
        .replace(/β/g, 'b')
        .replace(/γ/g, 'g')
        .replace(/δ/g, 'd');
}

function wordsOf(text) {
    return norm(text).split(/[^a-z0-9.+]+/).filter(Boolean);
}

// How well one typed word fits an entry, best first: a word of its name, the start of one, its group, a hidden keyword,
// then anywhere in its name. A hidden keyword has to match from its start, or "si" would find "emission" in everything;
// one or two letters are too few to go on for the last two, so they have to be the whole keyword.
function wordScore(entry, word) {
    const short = word.length < 3;
    if (entry.labelWords.includes(word)) return 0;
    if (entry.labelWords.some((w) => w.startsWith(word))) return 1;
    if (entry.groupWords.some((w) => w.startsWith(word))) return 2;
    if (entry.keyWords.some((w) => (short ? w === word : w.startsWith(word)))) return 3;
    if (!short && entry.labelText.includes(word)) return 4;
    return Infinity;
}

function entryScore(entry, words) {
    return words.reduce((worst, word) => Math.max(worst, wordScore(entry, word)), 0);
}

function make(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key in el && key !== 'list') el[key] = value;
        else el.setAttribute(key, value);
    });
    children.forEach((child) => el.appendChild(child));
    return el;
}

// Temperatures are far apart at the hot end, so the slider is logarithmic and the value is shown to 3 figures
function sliderToT(s, min, max) {
    const T = min * (max / min) ** (s / 1000);
    const step = T < 10000 ? 10 : 100;
    return Math.min(max, Math.round(T / step) * step);
}

function tToSlider(T, min, max) {
    return Math.round((1000 * Math.log(T / min)) / Math.log(max / min));
}

// How far the shift slider reaches: enough for the object's kind, in the unit that suits it. Depends only on the kind,
// so it never hints at a particular object's velocity.
export function shiftSettings(entity) {
    const kind = entity ? entity.kind : '';
    if (kind === 'quasar') return { unit: 'z', min: -0.1, max: 5, step: 0.001 };
    if (kind === 'galaxy' || kind === 'nucleus') return { unit: 'kms', min: -2000, max: 100000, step: 10 };
    if (kind === 'supernova') return { unit: 'kms', min: -30000, max: 30000, step: 10 };
    return { unit: 'kms', min: -500, max: 500, step: 1 };
}

// "→ z = +0.0000600, v = +18 km/s, moving away": z always, and v = cz beside it until that stops applying (spec 8.4), as
// every shift is shown (core/format.js)
export function shiftText(z) {
    if (z === 0) return 'Not shifted';
    const arrow = z > 0 ? '→' : '←';
    const dir = z > 0 ? 'moving away' : 'moving towards us';
    if (beyondCz(z)) return `${arrow} ${shiftWords(z, { reason: false })}, ${dir}. ${CZ_REASON}.`;
    return `${arrow} ${shiftWords(z)}, ${dir}`;
}

// The same, short, for a name: "z = +0.0000600, +18 km/s" or "z = +0.229"
export function shiftShort(z) {
    if (z === 0) return '';
    return beyondCz(z) ? `z = ${zPlain(z)}` : `z = ${zPlain(z)}, ${speedText(z * C_KMS)}`;
}

// A button that repeats while it is held, for fine steps by touch or mouse; a key press gives one step
function repeating(button, step) {
    let timer = 0;
    const stop = () => {
        clearTimeout(timer);
        clearInterval(timer);
        timer = 0;
    };
    button.addEventListener('pointerdown', (e) => {
        if (e.button) return;
        step();
        timer = setTimeout(() => { timer = setInterval(step, 55); }, 350);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach((type) => button.addEventListener(type, stop));
    button.addEventListener('click', (e) => { if (e.detail === 0) step(); });
}

export function createRefPicker(container, { onChange = () => {}, onLabels = () => {}, onOpenChange = () => {}, onFrame = () => {} } = {}) {
    const uid = `spectroRef${++nextId}`;

    const allItems = [];
    REFERENCE_GROUPS.forEach((group) => {
        group.items.forEach((item) => {
            allItems.push({
                item,
                group,
                labelText: norm(item.label),
                labelWords: wordsOf(item.label),
                groupWords: wordsOf(group.label),
                keyWords: wordsOf([item.species, item.id, ...(item.keywords || [])].filter(Boolean).join(' '))
            });
        });
    });
    const blackBody = (allItems.find((entry) => entry.item.kind === 'blackbody') || {}).item || {};
    const T_MIN = blackBody.T_min_K ?? 1000;
    const T_MAX = blackBody.T_max_K ?? 50000;

    const state = {
        id: NONE.id,
        T: blackBody.T_default_K ?? 5800,
        z: 0,
        labels: false
    };

    function itemOf(id) {
        const found = allItems.find((entry) => entry.item.id === id);
        return found ? found.item : null;
    }

    // ---------- Building it ----------

    const label = make('label', { class: 'spectro-ref-label', htmlFor: `${uid}Input`, text: 'Reference spectrum' });
    const prev = make('button', { type: 'button', class: 'spectro-square', title: 'Previous reference', 'aria-label': 'Previous reference' }, [make('span', { class: 'icon solid fa-chevron-left', 'aria-hidden': 'true' })]);
    const next = make('button', { type: 'button', class: 'spectro-square', title: 'Next reference', 'aria-label': 'Next reference' }, [make('span', { class: 'icon solid fa-chevron-right', 'aria-hidden': 'true' })]);
    const input = make('input', {
        type: 'text',
        id: `${uid}Input`,
        class: 'spectro-ref-input',
        role: 'combobox',
        autocomplete: 'off',
        spellcheck: false,
        placeholder: 'Type to search',
        'aria-autocomplete': 'list',
        'aria-expanded': 'false',
        'aria-controls': `${uid}List`
    });
    const opener = make('button', { type: 'button', class: 'spectro-ref-open', tabIndex: -1, 'aria-hidden': 'true', title: 'Show all references' }, [make('span', { class: 'icon solid fa-chevron-down', 'aria-hidden': 'true' })]);
    const box = make('div', { class: 'spectro-ref-box' }, [input, opener]);
    const row = make('div', { class: 'spectro-ref-row' }, [prev, box, next]);
    const list = make('div', { id: `${uid}List`, class: 'spectro-ref-list', role: 'listbox', 'aria-label': 'Reference spectra', hidden: true });
    const status = make('div', { class: 'spectro-sr-only', role: 'status' });

    const tValue = make('span', { class: 'spectro-value' });
    const tLabel = make('label', { htmlFor: `${uid}T` }, [document.createTextNode('Black-body temperature: '), tValue]);
    const tSlider = make('input', { type: 'range', id: `${uid}T`, min: 0, max: 1000, step: 1, value: tToSlider(state.T, T_MIN, T_MAX) });
    const tRow = make('div', { class: 'spectro-ref-slider', hidden: true }, [tLabel, tSlider]);

    const shiftSummaryValue = make('span', { class: 'spectro-summary-value' });
    const shiftSummary = make('summary', {}, [make('span', { text: 'Shift reference' }), shiftSummaryValue]);
    const shiftNote = make('p', { class: 'spectro-hint', text: 'Slide the reference until its lines sit under the object\'s. The shift is the object\'s velocity along your line of sight.' });
    const shiftSlider = make('input', { type: 'range', id: `${uid}Shift` });
    const shiftLabel = make('label', { htmlFor: `${uid}Shift`, class: 'spectro-sr-only', text: 'Shift reference' });
    const minus = make('button', { type: 'button', class: 'spectro-square', 'aria-label': 'Shift a little towards blue', title: 'A little towards blue', text: '−' });
    const plus = make('button', { type: 'button', class: 'spectro-square', 'aria-label': 'Shift a little towards red', title: 'A little towards red', text: '+' });
    const shiftRow = make('div', { class: 'spectro-shift-row' }, [minus, shiftLabel, shiftSlider, plus]);
    const shiftValue = make('output', { class: 'spectro-shift-value', htmlFor: `${uid}Shift` });
    const shiftReset = make('button', { type: 'button', class: 'spectro-text-button', text: 'Reset' });
    const shiftFoot = make('div', { class: 'spectro-shift-foot' }, [shiftValue, shiftReset]);
    const shiftDetails = make('details', { class: 'sim-controls-more spectro-more' }, [shiftSummary, shiftNote, shiftRow, shiftFoot]);

    const frameButton = make('button', { type: 'button', class: 'spectro-text-button spectro-ref-frame', hidden: true });
    const refNote = make('p', { class: 'spectro-hint', hidden: true });

    const root = make('div', { class: 'spectro-ref' }, [label, row, list, status, frameButton, refNote, tRow, shiftDetails]);
    container.appendChild(root);

    // ---------- The list ----------

    let isOpen = false;
    let shown = [];       // The options on show, in order
    let active = -1;      // Index in shown
    let beforeOpen = null;
    let previewTimer = 0;

    function emit() {
        onChange(api.state());
        syncFrame();
    }

    // ---------- A reference with a range of its own offers to go there ----------

    let view = null;
    let frameTarget = null;

    function syncFrame() {
        const item = itemOf(state.id);
        const shown = item && item.lo_nm && item.hi_nm && view;
        const lo = shown ? item.lo_nm * (1 + state.z) : 0;
        const hi = shown ? item.hi_nm * (1 + state.z) : 0;
        const elsewhere = !!shown && (view.hi < lo || view.lo > hi);
        frameTarget = elsewhere ? [lo, hi] : null;
        frameButton.hidden = !elsewhere;
        if (elsewhere) {
            frameButton.textContent = `Show its lines: ${wavelength(lo, 0)} to ${wavelength(hi, 0)}`;
        }
    }

    frameButton.addEventListener('click', () => {
        if (frameTarget) onFrame(frameTarget[0], frameTarget[1]);
    });

    function currentLabel() {
        const item = itemOf(state.id);
        return item ? item.label : NONE.label;
    }

    // A long name is cut short in a narrow row: the whole of it shows on hover, and in the list
    function syncInput() {
        input.value = currentLabel();
        input.title = currentLabel();
    }

    function renderList(query) {
        const tokens = wordsOf(query);
        const scored = allItems
            .map((entry) => ({ entry, score: entryScore(entry, tokens) }))
            .filter(({ score }) => score < Infinity);
        // The best matches come first, in the group that holds them, so that Enter takes what's at the top
        const groupScore = (group) => scored.reduce((best, { entry, score }) => (entry.group === group ? Math.min(best, score) : best), Infinity);
        const groups = REFERENCE_GROUPS
            .map((group, order) => ({ group, order, score: groupScore(group) }))
            .sort((a, b) => a.score - b.score || a.order - b.order);
        list.replaceChildren();
        shown = [];
        const addOption = (item, parent) => {
            const option = make('div', {
                id: `${uid}Opt${shown.length}`,
                class: 'spectro-ref-option',
                role: 'option',
                'aria-selected': item.id === state.id ? 'true' : 'false',
                text: item.label
            });
            option.addEventListener('click', () => commit(item.id));
            parent.appendChild(option);
            shown.push({ item, el: option });
        };
        if (!tokens.length) addOption(NONE, list);
        groups.forEach(({ group, order }) => {
            const inGroup = scored.filter(({ entry }) => entry.group === group).sort((a, b) => a.score - b.score);
            if (!inGroup.length) return;
            const headingId = `${uid}Group${order}`;
            const heading = make('div', { id: headingId, class: 'spectro-ref-heading', role: 'presentation', text: group.label });
            const wrap = make('div', { role: 'group', 'aria-labelledby': headingId }, [heading]);
            inGroup.forEach(({ entry }) => addOption(entry.item, wrap));
            list.appendChild(wrap);
        });
        if (!shown.length) {
            list.appendChild(make('div', { class: 'spectro-ref-empty', text: 'Nothing matches that. Try a symbol such as Fe, or a word such as lamp.' }));
        }
        status.textContent = tokens.length ? `${shown.length} ${shown.length === 1 ? 'match' : 'matches'}` : '';
    }

    function setActive(index, { scroll = true } = {}) {
        if (shown[active]) shown[active].el.classList.remove('is-active');
        active = index;
        if (shown[active]) {
            const el = shown[active].el;
            el.classList.add('is-active');
            input.setAttribute('aria-activedescendant', el.id);
            if (scroll) {
                // Only the list scrolls; moving the whole drawer here would take the plot off screen
                const top = el.offsetTop - list.offsetTop;
                const heading = 28;
                if (top < list.scrollTop + heading) list.scrollTop = top - heading;
                else if (top + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + el.offsetHeight - list.clientHeight;
            }
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }

    function open() {
        if (isOpen) return;
        isOpen = true;
        beforeOpen = state.id;
        renderList('');
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        opener.classList.add('is-open');
        setActive(shown.findIndex((entry) => entry.item.id === state.id));
        onOpenChange(true);
        document.addEventListener('pointerdown', onOutsidePress, true);
        fitList();
    }

    // As many rows as the drawer has room for
    function fitList() {
        let scroller = list.parentElement;
        while (scroller && scroller !== document.body && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
        if (!scroller || scroller === document.body) return;
        const room = scroller.getBoundingClientRect().bottom - list.getBoundingClientRect().top - 10;
        list.style.maxHeight = `${Math.max(132, Math.min(room, 500))}px`;
        if (shown[active]) setActive(active);
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        clearTimeout(previewTimer);
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        opener.classList.remove('is-open');
        active = -1;
        shown = [];
        syncInput();
        onOpenChange(false);
        document.removeEventListener('pointerdown', onOutsidePress, true);
    }

    function setChoice(id) {
        if (state.id === id) return false;
        state.id = id;
        tRow.hidden = !(itemOf(id) && itemOf(id).kind === 'blackbody');
        return true;
    }

    function commit(id) {
        clearTimeout(previewTimer);
        const changed = setChoice(id);
        close();
        if (changed) emit();
    }

    // Arrowing through the list tries each one live; a short wait keeps fast key repeats from doing needless work
    function preview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            if (shown[active] && setChoice(shown[active].item.id)) emit();
        }, 70);
    }

    function move(delta) {
        if (!shown.length) return;
        const at = active < 0 ? (delta > 0 ? 0 : shown.length - 1) : (active + delta + shown.length) % shown.length;
        setActive(at);
        preview();
    }

    input.addEventListener('click', () => {
        if (!isOpen) {
            open();
            input.select();
        }
    });

    input.addEventListener('input', () => {
        if (!isOpen) {
            open();
        }
        const query = input.value;
        renderList(query);
        setActive(shown.length && query.trim() ? 0 : shown.findIndex((entry) => entry.item.id === state.id));
        list.scrollTop = 0;
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            if (!isOpen) {
                open();
                input.select();
                return;
            }
            move(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter') {
            if (!isOpen) {
                open();
                input.select();
            } else if (shown[active]) {
                commit(shown[active].item.id);
            }
            e.preventDefault();
            e.stopPropagation();
        } else if (e.key === 'Escape' && isOpen) {
            e.preventDefault();
            e.stopPropagation();
            const before = beforeOpen;
            clearTimeout(previewTimer);
            const changed = setChoice(before);
            close();
            if (changed) emit();
        } else if (e.key !== 'Escape') {
            // Letters typed here are for the filter, not for the sky's keyboard shortcuts
            e.stopPropagation();
        }
    });

    input.addEventListener('focus', () => input.select());

    // Clicks on the list and its opener mustn't take the focus from the input
    [list, opener].forEach((el) => el.addEventListener('mousedown', (e) => e.preventDefault()));

    opener.addEventListener('click', (e) => {
        if (isOpen) {
            close();
            return;
        }
        // On a touch screen, focusing the input would bring up the keyboard and hide the list
        if (e.pointerType !== 'touch') input.focus();
        open();
        if (e.pointerType !== 'touch') input.select();
    });

    // Leaving keeps whatever is being tried at the time
    function leave() {
        clearTimeout(previewTimer);
        if (shown[active] && setChoice(shown[active].item.id)) emit();
        close();
    }

    function onOutsidePress(e) {
        if (!box.contains(e.target) && !list.contains(e.target)) leave();
    }

    input.addEventListener('focusout', (e) => {
        if (!isOpen) return;
        const to = e.relatedTarget;
        if (to && (box.contains(to) || list.contains(to))) return;
        if (!to) return; // The window lost focus, or a press that onOutsidePress deals with
        leave();
    });

    // No reference is a stop on the way round, before the first, so the arrows can always get back to it
    function step(delta) {
        if (!allItems.length) return;
        const ids = [NONE.id, ...allItems.map((entry) => entry.item.id)];
        const at = Math.max(0, ids.indexOf(state.id));
        close();
        if (setChoice(ids[(at + delta + ids.length) % ids.length])) emit();
        syncInput();
        status.textContent = `Reference: ${currentLabel()}`;
    }

    prev.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));

    // ---------- Black body ----------

    function syncT() {
        const peak = wienPeakNm(state.T);
        tValue.textContent = `${withCommas(state.T)} K`;
        tSlider.setAttribute('aria-valuetext', `${withCommas(state.T)} K, peaks at ${wavelength(peak, 0)}`);
    }

    tSlider.addEventListener('input', () => {
        state.T = sliderToT(Number(tSlider.value), T_MIN, T_MAX);
        syncT();
        emit();
    });

    // ---------- Shift ----------

    let settings = shiftSettings(null);

    function zFromSlider() {
        const v = Number(shiftSlider.value);
        return settings.unit === 'z' ? v : v / C_KMS;
    }

    function sliderFromZ(z) {
        return settings.unit === 'z' ? z : z * C_KMS;
    }

    function syncShift() {
        const text = shiftText(state.z);
        shiftValue.textContent = text;
        shiftSlider.setAttribute('aria-valuetext', text);
        shiftSummaryValue.textContent = shiftShort(state.z);
        shiftReset.hidden = state.z === 0;
    }

    function applySettings() {
        shiftSlider.min = settings.min;
        shiftSlider.max = settings.max;
        shiftSlider.step = settings.step;
        shiftSlider.value = sliderFromZ(state.z);
    }

    function setZ(z) {
        if (z === state.z) return;
        state.z = z;
        syncShift();
        emit();
    }

    function nudge(direction) {
        const v = Math.max(settings.min, Math.min(settings.max, Number(shiftSlider.value) + direction * settings.step));
        // Keep the slider's own rounding out of it: floating point would otherwise walk off the step
        const rounded = Math.round(v / settings.step) * settings.step;
        shiftSlider.value = rounded;
        setZ(zFromSlider());
    }

    shiftSlider.addEventListener('input', () => setZ(zFromSlider()));
    repeating(minus, () => nudge(-1));
    repeating(plus, () => nudge(1));
    shiftReset.addEventListener('click', () => {
        shiftSlider.value = 0;
        setZ(0);
        shiftSlider.focus();
    });

    // ---------- Start ----------

    tRow.hidden = !(itemOf(state.id) && itemOf(state.id).kind === 'blackbody');
    syncInput();
    syncT();
    applySettings();
    syncShift();

    const api = {
        el: root,
        parts: { label, box, prev, next, list, tRow, shiftDetails, frameButton, refNote },
        state() {
            const item = itemOf(state.id);
            return { id: state.id, item, T: state.T, z: state.z, shift_kms: state.z * C_KMS, labels: state.labels };
        },
        setEntity(resolved) {
            settings = shiftSettings(resolved ? resolved.entity : null);
            state.z = 0;
            applySettings();
            syncShift();
        },
        setView(lo, hi) {
            view = { lo, hi };
            syncFrame();
        },
        setNote(text) {
            refNote.textContent = text || '';
            refNote.hidden = !text;
        },
        choose(id) {
            if (id !== NONE.id && !itemOf(id)) return false;
            close();
            if (setChoice(id)) emit();
            syncInput();
            return true;
        },
        setTemperature(T) {
            state.T = Math.min(T_MAX, Math.max(T_MIN, T));
            tSlider.value = tToSlider(state.T, T_MIN, T_MAX);
            syncT();
            emit();
        },
        setShiftZ(z) {
            shiftSlider.value = sliderFromZ(z);
            setZ(z);
        },
        // A copy of Shift as it is when open, with Reset showing and the longest readout its slider can give here, for the
        // panel to measure the room Shift takes. It has no ids, so nothing points at it.
        shiftProbe() {
            const zOf = (value) => (settings.unit === 'z' ? value : value / C_KMS);
            const lo = zOf(settings.min);
            const hi = zOf(settings.max);
            const texts = [lo, hi, Math.max(lo, -0.0999), Math.min(hi, 0.0999)].map(shiftText);
            const longest = texts.reduce((best, text) => (text.length > best.length ? text : best), '');
            const copy = shiftDetails.cloneNode(true);
            copy.open = true;
            copy.querySelectorAll('[id], [for]').forEach((el) => {
                el.removeAttribute('id');
                el.removeAttribute('for');
            });
            copy.querySelector('.spectro-shift-value').textContent = longest;
            copy.querySelector('.spectro-text-button').hidden = false;
            return copy;
        },
        // Line labels: the reference's lines are named, and matching them to the object's is left to the student
        setLabels(on) {
            state.labels = !!on;
            onLabels(state.labels);
        },
        items: () => allItems.map((entry) => entry.item),
        dispose() {
            clearTimeout(previewTimer);
            document.removeEventListener('pointerdown', onOutsidePress, true);
            root.remove();
        }
    };
    return api;
}
