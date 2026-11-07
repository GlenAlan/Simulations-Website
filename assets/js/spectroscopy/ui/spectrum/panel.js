// The Spectrum tab: the selected object's spectrum over a reference the student swaps, to identify what they see.
//
// Tools (tools/index.js) attach through panelApi, which is also app.spectrumPanel once the tab has been opened:
//   plot                    the plot, see plot.js
//   resolved                the current selection
//   getSpectrum()           the body spectrum being drawn: full range at overview resolution, unless something narrower was asked for
//   getOverview()           the full-range overview spectrum, whatever is being drawn
//   getReference()          the reference spectrum being drawn, with its shift applied, or null
//   refresh(opts)           recompute; opts { body: bool, ref: bool }, both by default
//   setResolution('overview'|'zoom', { lo_nm, hi_nm })   'zoom' draws at R_ZOOM while the view is narrow, moves the view to that window if one
//                           is given, and lets the plot zoom further; 'overview' goes back
//   getResolution()         'overview' or 'zoom'
//   setBodyOpts(opts)       add t, parts or subtractHost to the body spectrum and refresh; a null value removes an option, no argument clears all
//   getBodyOpts(), onBodyOpts(fn(changed)) -> remove, onReferenceChange(fn) -> remove
//   openTool(id, { from, focus }), hasTool(id)   open a tool by its id, from anywhere: the tab changes, the tool opens and is
//                           brought into view. from names a tab to offer a way back to, focus moves focus onto the tool.
//                           False if this object doesn't have that tool. Ids can be written 'light-curve' or 'light_curve'.
//   cameFrom                the tab that sent the student to a tool, while it still has a way back
//   setMode('stacked'|'overlay')   how the two spectra are arranged, with the buttons that say so
//   picker                  the reference picker, see refs.js
//   toolsEl                 the element the open tools' panels sit in
//
// app.spectrumPanel is there from the start, so anything can send the student to a tool before this tab has been opened.
// A button in any text can do the same with data-spectro-tool="<id>".

import { bus } from '../../core/state.js';
import { spectrumOf, referenceSpectrum, autoRange } from '../../spectra/synth.js';
import { R_OVERVIEW, R_ZOOM, SPECTRUM_LO_NM, SPECTRUM_HI_NM } from '../../core/phys.js';
import { wavelength } from '../../core/format.js';
import { createPlot, WAVELENGTH_PRESETS } from './plot.js';
import { createRefPicker, shiftShort } from './refs.js';
import { linkToolNames, listTools, toolWords } from './tools/index.js';

const FULL_RANGE = { lo: SPECTRUM_LO_NM, hi: SPECTRUM_HI_NM, R: R_OVERVIEW };
const OVERVIEW_MIN_RATIO = 1.002;    // About 1.3 nm at Hα, which is 20 samples at overview resolution
const ZOOM_MIN_RATIO = 1.0001;       // About 0.07 nm at Hα, which is 20 samples at line-zoom resolution
const ZOOM_UPGRADE_RATIO = 1.08;     // Higher resolution only shows on screen once the view is this narrow
const NO_SPECTRUM_NOTE = 'This object gives off too little light to record a spectrum in this range. Its Info tab says what can be seen of it instead.';
const RUNS_OFF_TOP = 'Part of this curve runs off the top';

// The wavelength buttons, in two rows that never move: the wide views, then the views around one line
const PRESET_ORDER = ['uv', 'visible', 'nir', 'full', 'lya', 'halpha', 'cahk', 'nad'];

// A range the student chooses stays when they move to something of the same broad sort, so that one line can be compared
// across stars. Kept apart for each sort, as a star's Hα says nothing about a quasar.
const BROAD_SORT = {
    star: 'star', binary: 'star', multiple: 'star', cluster: 'star', black_hole: 'star', neutron_star: 'star',
    planet: 'planet', home_planet: 'planet', rogue_planet: 'planet',
    galaxy: 'galaxy', quasar: 'galaxy'
};

function make(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key in el) el[key] = value;
        else el.setAttribute(key, value);
    });
    children.forEach((child) => el.appendChild(child));
    return el;
}

function createSpectrumPanel(app, container) {
    let resolved = null;
    let entityDirty = false;
    let visible = false;
    let resolution = 'overview';
    let bodyOpts = {};

    let bodySpectrum = null;   // What is drawn
    let bodyCover = null;      // The { lo, hi, R } it covers
    let overview = null;       // The full-range spectrum, kept so returning to a wide view is instant
    let refBase = null;        // The unshifted reference being drawn
    let refShown = null;
    let refCover = null;
    let refKey = '';
    let refZ = 0;
    const refCache = new Map();
    let shiftBuffer = null;

    // ---------- Layout ----------

    const root = make('div', { class: 'spectro-spectrum' });
    const empty = make('p', { class: 'spectro-empty', hidden: true });
    const instrument = make('div', { class: 'spectro-instrument' });
    root.append(empty, instrument);
    container.appendChild(root);

    // The head: the tools that apply to this object, and the plot. It stays at the top of the drawer while a tool is open.
    const toolBar = make('div', { class: 'spectro-tool-bar', role: 'group', 'aria-label': 'Tools', hidden: true });
    const plotHost = make('div', { class: 'spectro-plot-host' });
    const head = make('div', { class: 'spectro-head' }, [toolBar, plotHost]);
    instrument.appendChild(head);
    const plot = createPlot(plotHost, {
        minRatio: OVERVIEW_MIN_RATIO,
        reduceMotion: () => !!(app.settings && app.settings.reduceMotion),
        ariaLabel: 'Spectrum'
    });

    // The range: presets, and the zoom buttons beside them
    const presetRow = make('div', { class: 'spectro-presets', role: 'group', 'aria-label': 'Wavelength range' });
    const presetButtons = PRESET_ORDER.map((id) => {
        const preset = WAVELENGTH_PRESETS.find((p) => p.id === id);
        const button = make('button', { type: 'button', class: 'spectro-chip', text: preset.label, title: preset.title, 'aria-pressed': 'false' });
        button.addEventListener('click', () => plot.setRange(preset.lo, preset.hi, { animate: true }));
        presetRow.appendChild(button);
        return { preset, button };
    });
    const zoomOut = make('button', { type: 'button', class: 'spectro-square', 'aria-label': 'Zoom out', title: 'Zoom out (minus key)', text: '−' });
    const zoomIn = make('button', { type: 'button', class: 'spectro-square', 'aria-label': 'Zoom in', title: 'Zoom in (plus key)', text: '+' });
    const autoButton = make('button', { type: 'button', class: 'spectro-text-button spectro-auto', text: 'Auto', title: 'Frame this object automatically (or double-click the plot)' });
    const zoomGroup = make('div', { class: 'spectro-plot-zoom', role: 'group', 'aria-label': 'Zoom' }, [autoButton, zoomOut, zoomIn]);

    // Tools open directly under the plot, ahead of everything else, so nothing needs to scroll to bring one into view
    const toolsEl = make('div', { class: 'spectro-tools', hidden: true });
    instrument.append(toolsEl, make('div', { class: 'spectro-range' }, [presetRow, zoomGroup]));
    // Tools with nothing to open, such as a system's orbit strip, sit under the range buttons
    const pinnedHost = make('div', { class: 'spectro-pinned' });
    instrument.appendChild(pinnedHost);

    const note = make('p', { class: 'spectro-note', hidden: true });

    // Stacked or overlay goes with the reference, as that's what it arranges
    const stackedButton = make('button', { type: 'button', class: 'spectro-seg-button', text: 'Stacked', 'aria-pressed': 'true', title: 'Object on top, reference below, on one wavelength axis' });
    const overlayButton = make('button', { type: 'button', class: 'spectro-seg-button', text: 'Overlay', 'aria-pressed': 'false', title: 'Reference drawn over the object, dashed' });
    const seg = make('div', { class: 'spectro-seg', role: 'group', 'aria-label': 'How to show the two spectra' }, [stackedButton, overlayButton]);

    // The reference
    const refHost = make('div', { class: 'spectro-ref-host' });
    instrument.appendChild(refHost);
    let scrollBeforePicking = 0;
    const picker = createRefPicker(refHost, {
        beside: seg,
        onChange() {
            computeReference();
            describeSoon();
            referenceFns.forEach((fn) => fn());
        },
        onLabels(on) {
            plot.showLineLabels(on);
        },
        onOpenChange(open) {
            // While the list is open the tab is only the plot and the list, with as much of the list on screen as fits
            const scroller = scrollerOf();
            if (open && scroller) scrollBeforePicking = scroller.scrollTop;
            root.classList.toggle('is-picking', open);
            if (scroller) scroller.scrollTop = open ? 0 : scrollBeforePicking;
        },
        onFrame(lo, hi) {
            plot.setRange(lo, hi, { animate: true });
        }
    });
    instrument.appendChild(note);

    // The conventions, stated once and out of the way
    const help = make('details', { class: 'sim-controls-more spectro-more spectro-help' }, [
        make('summary', {}, [make('span', { text: 'About these wavelengths' })]),
        make('p', { text: 'Wavelengths above 200 nm are air wavelengths, as in most textbooks: Hα is 656.3 nm. Below 200 nm they are vacuum wavelengths: Lyman-α is 121.6 nm. Spectra and references both follow this, so their lines match.' }),
        make('p', { text: 'Flux is how much light arrives at each wavelength. It is relative here, not in real units, and each scale fits itself to what is in view. In the colour strips, dark lines are absorption and bright lines are emission. UV and IR are hatched because your eye can\'t see them.' }),
        make('p', { text: 'On the plot: drag sideways to pan, and drag up and down or hold Ctrl and scroll to zoom. On a touch screen, drag to pan and pinch to zoom. By keyboard: left and right arrows pan, plus and minus zoom, Shift with an arrow moves the cursor, and 0 resets the view.' })
    ]);
    instrument.appendChild(help);

    // The part of the drawer that scrolls. Only it moves: anything else would take the whole page, and the sky, with it.
    function scrollerOf() {
        let scroller = root.parentElement;
        while (scroller && scroller !== document.body) {
            const overflow = getComputedStyle(scroller).overflowY;
            if (overflow === 'auto' || overflow === 'scroll') return scroller;
            scroller = scroller.parentElement;
        }
        return null;
    }

    // ---------- Stacked or overlay, zoom ----------

    function setMode(mode) {
        plot.setMode(mode);
        stackedButton.setAttribute('aria-pressed', mode === 'stacked' ? 'true' : 'false');
        overlayButton.setAttribute('aria-pressed', mode === 'overlay' ? 'true' : 'false');
    }
    stackedButton.addEventListener('click', () => setMode('stacked'));
    overlayButton.addEventListener('click', () => setMode('overlay'));
    zoomIn.addEventListener('click', () => plot.zoomBy(0.7));
    zoomOut.addEventListener('click', () => plot.zoomBy(1 / 0.7));
    autoButton.addEventListener('click', () => plot.resetRange());

    // ---------- Spectra ----------

    // What needs computing for the view as it stands. The overview array covers everything, so panning and zooming
    // cost nothing; only line zoom, and a spectrum changing with time, work on just the part in view.
    function wantedCover() {
        const { lo, hi } = plot.getRange();
        const margin = (hi / lo) ** 0.5; // Half a view either side, so a small pan doesn't need a recompute
        const around = (R) => ({
            lo: Math.max(SPECTRUM_LO_NM, lo / margin),
            hi: Math.min(SPECTRUM_HI_NM, hi * margin),
            R
        });
        if (resolution === 'zoom' && hi / lo < ZOOM_UPGRADE_RATIO) return around(R_ZOOM);
        if (bodyOpts.t !== undefined && hi / lo < 8) return around(R_OVERVIEW);
        return FULL_RANGE;
    }

    function covers(cover, want, lo, hi) {
        return !!cover && cover.R === want.R && cover.lo <= lo * (1 + 1e-9) && cover.hi >= hi * (1 - 1e-9)
            && (want !== FULL_RANGE || (cover.lo === FULL_RANGE.lo && cover.hi === FULL_RANGE.hi));
    }

    function computeBody(cover) {
        return spectrumOf(resolved.entity, { lo_nm: cover.lo, hi_nm: cover.hi, R: cover.R, ...bodyOpts });
    }

    function bodyName() {
        return resolved ? (resolved.entity.name || resolved.entity.code) : '';
    }

    function refName() {
        const st = picker.state();
        if (!st.item) return '';
        const shift = shiftShort(st.z);
        const name = st.item.kind === 'blackbody' ? `Black body, ${Math.round(st.T).toLocaleString('en-AU')} K` : st.item.label;
        return shift ? `${name}, shifted ${shift}` : name;
    }

    function drawBody() {
        // With the star divided out, the ends of the range, where the star gives little light, climb far above the rest. The
        // planet's bands are what this view is for, so the scale fits those.
        plot.setTopCap(bodyOpts.subtractHost ? RUNS_OFF_TOP : '');
        plot.setSpectrum(bodySpectrum, bodyName());
    }

    function updateBody(force) {
        if (!resolved) return;
        const { lo, hi } = plot.getRange();
        const want = wantedCover();
        if (!force && covers(bodyCover, want, lo, hi)) return;
        if (want === FULL_RANGE && overview && !force) {
            bodySpectrum = overview;
        } else {
            let next;
            try {
                next = computeBody(want);
            } catch (err) {
                console.error(`[spectroscopy] no spectrum for ${resolved.entity.code}:`, err);
                return;
            }
            if (want === FULL_RANGE) overview = next;
            bodySpectrum = next;
        }
        bodyCover = want;
        drawBody();
        updateNote();
    }

    // Shifting moves every wavelength by the same factor, so it needn't recompute the reference: the slider stays
    // smooth however expensive the reference was to make
    function applyShift(base, z) {
        if (!z) return base;
        const n = base.wl.length;
        if (!shiftBuffer || shiftBuffer.length !== n) shiftBuffer = new Float64Array(n);
        const factor = 1 + z;
        for (let i = 0; i < n; i++) shiftBuffer[i] = base.wl[i] * factor;
        return {
            ...base,
            wl: shiftBuffer,
            lines: (base.lines || []).map((line) => ({ ...line, obs_nm: (line.obs_nm ?? line.rest_nm) * factor }))
        };
    }

    function computeReference(force) {
        if (!resolved) return;
        const st = picker.state();
        if (!st.item) {
            refBase = null;
            refShown = null;
            refKey = '';
            plot.setReference(null);
            picker.setNote('');
            return;
        }
        const { lo, hi } = plot.getRange();
        const want = wantedCover();
        const cover = want.R === R_OVERVIEW ? FULL_RANGE : (covers(refCover, want, lo, hi) ? refCover : want);
        const key = [st.id, st.item.kind === 'blackbody' ? st.T : '', cover.lo, cover.hi, cover.R].join('|');
        if (!force && key === refKey && st.z === refZ && refShown) return;
        if (force || key !== refKey) {
            let spectrum = force ? null : refCache.get(key);
            if (!spectrum) {
                try {
                    spectrum = referenceSpectrum(st.id, { lo_nm: cover.lo, hi_nm: cover.hi, R: cover.R, T: st.T });
                } catch (err) {
                    console.error(`[spectroscopy] no reference spectrum for ${st.id}:`, err);
                    refBase = null;
                    refShown = null;
                    refKey = '';
                    plot.setReference(null);
                    return;
                }
                refCache.set(key, spectrum);
                if (refCache.size > 8) refCache.delete(refCache.keys().next().value);
            }
            refBase = spectrum;
            refCover = cover;
            refKey = key;
        }
        refZ = st.z;
        refShown = applyShift(refBase, st.z);
        plot.setReference(refShown, refName());
        picker.setNote(st.item.note || refBase.note || '');
    }

    function updateNote() {
        const text = bodySpectrum && bodySpectrum.note ? bodySpectrum.note : '';
        note.textContent = text;
        note.hidden = !text;
    }

    // The range the student has chosen for each broad sort of object, while it differs from what the object opens on
    const chosenRanges = new Map();
    let framed = null;
    let framing = false;

    function sortOf(entity) {
        return BROAD_SORT[entity.kind] || entity.kind;
    }

    function noteChosenRange(lo, hi) {
        if (framing || !resolved || !framed) return;
        const same = Math.abs(Math.log(lo / framed.lo)) < 0.002 && Math.abs(Math.log(hi / framed.hi)) < 0.002;
        if (same) chosenRanges.delete(sortOf(resolved.entity));
        else chosenRanges.set(sortOf(resolved.entity), { lo, hi });
    }

    let viewQueued = 0;
    function onViewChanged(lo, hi) {
        noteChosenRange(lo, hi);
        syncPresets();
        picker.setView(lo, hi);
        describeSoon();
        if (viewQueued) return;
        viewQueued = requestAnimationFrame(() => {
            viewQueued = 0;
            if (!resolved || !visible || bodySpectrum === null) return;
            updateBody(false);
            computeReference(false);
        });
    }

    let forceQueued = 0;
    let forceBody = false;
    let forceRef = false;
    function refresh(opts = {}) {
        forceBody = forceBody || opts.body !== false;
        forceRef = forceRef || opts.ref !== false;
        if (forceBody) overview = null;
        if (forceQueued) return;
        // Coalesced, so a tool playing through time asks at most once a frame
        forceQueued = requestAnimationFrame(() => {
            forceQueued = 0;
            const doBody = forceBody;
            const doRef = forceRef;
            forceBody = false;
            forceRef = false;
            if (!resolved || !visible || entityDirty) return;
            if (doBody) updateBody(true);
            if (doRef) computeReference(true);
            describeSoon();
        });
    }

    // Quasars and distant galaxies have their lines far from where they were emitted: make sure they are in frame
    function frameFor(entity, spectrum) {
        const range = autoRange(entity) || {};
        let lo = range.lo_nm ?? 380;
        let hi = range.hi_nm ?? 750;
        const z = (entity.quasar && entity.quasar.z) || (entity.galaxy && entity.galaxy.z) || 0;
        const lines = (spectrum.lines || []).filter((l) => l.obs_nm >= SPECTRUM_LO_NM && l.obs_nm <= SPECTRUM_HI_NM);
        if (z >= 0.1 && lines.length) {
            const strong = lines.slice().sort((a, b) => Math.abs(b.depth ?? 0) - Math.abs(a.depth ?? 0)).slice(0, 6);
            lo = Math.min(lo, ...strong.map((l) => l.obs_nm * 0.92));
            hi = Math.max(hi, ...strong.map((l) => l.obs_nm * 1.08));
        }
        return { lo, hi };
    }

    function showEmpty(text) {
        instrument.hidden = true;
        empty.hidden = false;
        empty.textContent = text;
    }

    function applyEntity() {
        entityDirty = false;
        bodyOpts = {};
        resolution = 'overview';
        const kept = chosenRanges.get(sortOf(resolved.entity));
        framing = true;
        plot.setMinRatio(OVERVIEW_MIN_RATIO);
        framing = false;
        overview = null;
        bodySpectrum = null;
        bodyCover = null;
        picker.setEntity(resolved);

        let spectrum;
        try {
            spectrum = computeBody(FULL_RANGE);
        } catch (err) {
            console.error('[spectroscopy] no spectrum for', resolved.entity.code, err);
            showEmpty('This spectrum could not be drawn.');
            plot.setSpectrum(null);
            syncTools();
            return;
        }
        if (!spectrum || spectrum.mode === 'none' || !spectrum.wl || !spectrum.wl.length) {
            showEmpty((spectrum && spectrum.note) || NO_SPECTRUM_NOTE);
            plot.setSpectrum(null);
            syncTools();
            return;
        }
        instrument.hidden = false;
        empty.hidden = true;
        overview = spectrum;
        bodySpectrum = spectrum;
        bodyCover = FULL_RANGE;
        const frame = frameFor(resolved.entity, spectrum);
        framed = frame;
        framing = true;
        plot.setRange(kept ? kept.lo : frame.lo, kept ? kept.hi : frame.hi);
        framing = false;
        plot.setAutoRange(frame.lo, frame.hi);
        drawBody();
        updateNote();
        computeReference(false);
        syncPresets();
        const view = plot.getRange();
        picker.setView(view.lo, view.hi);
        describeSoon();
        syncTools(); // Last, so a tool's setEntity can read the spectrum
    }

    // ---------- Presets and the plot's description ----------

    function syncPresets() {
        const { lo, hi } = plot.getRange();
        presetButtons.forEach(({ preset, button }) => {
            const on = Math.abs(Math.log(lo / preset.lo)) < 0.002 && Math.abs(Math.log(hi / preset.hi)) < 0.002;
            if ((button.getAttribute('aria-pressed') === 'true') !== on) {
                button.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
        });
    }

    let describeTimer = 0;
    function describeSoon() {
        clearTimeout(describeTimer);
        describeTimer = setTimeout(describe, 250);
    }

    function strongestFeatures(spectrum, lo, hi) {
        const inView = (spectrum.lines || [])
            .filter((l) => l.obs_nm >= lo && l.obs_nm <= hi)
            .sort((a, b) => Math.abs(b.depth ?? 0) - Math.abs(a.depth ?? 0))
            .slice(0, 3);
        if (!inView.length) return 'no clear lines';
        const words = inView.map((l) => `${l.type === 'em' ? 'bright' : 'dark'} line near ${wavelength(l.obs_nm)}`);
        return `strongest features: ${words.join(', ')}`;
    }

    // Written for someone who can't see the canvas, and like the sighted view it doesn't name the lines until
    // line labels are on: identifying them is the exercise
    function describe() {
        if (!resolved || !bodySpectrum) return;
        const { lo, hi } = plot.getRange();
        const reference = refName();
        const parts = [
            `Spectrum of ${bodyName()} from ${wavelength(lo)} to ${wavelength(hi)}`,
            strongestFeatures(bodySpectrum, lo, hi),
            reference ? `compared with ${reference}` : 'no reference shown'
        ];
        plot.setAriaLabel(`${parts.join('; ')}. Left and right arrows pan, plus and minus zoom, Shift with an arrow moves the cursor.`);
    }

    // ---------- Tools ----------

    const toolRows = new Map();
    const bodyOptsFns = new Set();
    const referenceFns = new Set();
    let cameFrom = null;

    function openRows() {
        return [...toolRows.values()].filter((row) => row.open);
    }

    // While a tool is open the head stays stuck to the top of the drawer, a little shorter. A tool that only changes what
    // the plot shows leaves it as it was, so that it can be read at full size.
    function syncHead() {
        const any = openRows();
        toolsEl.hidden = any.length === 0;
        instrument.classList.toggle('has-tool', any.some((row) => !row.words.leavesPlot));
        instrument.classList.toggle('has-own-figure', any.some((row) => row.words.ownFigure));
        syncScrollPadding();
    }

    // What stays stuck to the top of the drawer while a tool is open: the head, or just the tool buttons for a tool with a
    // figure of its own, which needs the room more than it needs the plot
    function stuckPart() {
        if (!instrument.classList.contains('has-tool')) return null;
        return instrument.classList.contains('has-own-figure') ? toolBar : head;
    }

    // Whatever takes focus or is scrolled to has to land below what's stuck
    function syncScrollPadding() {
        const scroller = scrollerOf();
        if (!scroller) return;
        const stuck = visible ? stuckPart() : null;
        root.style.setProperty('--spectro-pad-top', `${parseFloat(getComputedStyle(scroller).paddingTop) || 0}px`);
        scroller.style.scrollPaddingTop = stuck ? `${stuck.offsetHeight + 4}px` : '';
    }

    // Brings a tool on screen: its controls and its result together under the plot. Left where it is if it's already whole;
    // otherwise its top goes just under what's stuck, so that nothing is left half hidden behind it.
    function revealTool(row) {
        const reveal = () => {
            const scroller = scrollerOf();
            if (!scroller || !row.open) return;
            const stuck = stuckPart();
            const box = scroller.getBoundingClientRect();
            const top = (stuck ? stuck.getBoundingClientRect().bottom : box.top) + 4;
            const panel = row.panel.getBoundingClientRect();
            if (panel.top >= top && panel.bottom <= box.bottom - 6) return;
            const reduce = !!(app.settings && app.settings.reduceMotion);
            scroller.scrollTo({ top: scroller.scrollTop + panel.top - top, behavior: reduce ? 'auto' : 'smooth' });
        };
        reveal();
        // Again once the plot has settled: the buttons may have just taken a second row, and the plot given way to them
        requestAnimationFrame(reveal);
    }

    function disposeTool(row) {
        if (row.instance) {
            try {
                if (row.instance.dispose) row.instance.dispose();
            } catch (err) {
                console.error(`[spectroscopy] tool ${row.tool.id} failed to close:`, err);
            }
        }
        row.instance = null;
        row.body.replaceChildren();
    }

    function mountTool(row) {
        if (row.instance || !resolved) return;
        try {
            row.instance = row.tool.mount(row.body, panelApi);
            if (row.instance && row.instance.setEntity) row.instance.setEntity(resolved);
        } catch (err) {
            console.error(`[spectroscopy] tool ${row.tool.id} failed to open:`, err);
            row.body.textContent = 'This tool could not start.';
        }
    }

    function setToolOpen(row, open) {
        if (row.open === open) return;
        row.open = open;
        row.chip.setAttribute('aria-pressed', open ? 'true' : 'false');
        row.panel.hidden = !open;
        if (open) {
            // One tool at a time, so the drawer never fills up. Only those that change whose light is shown stay beside it.
            if (!row.words.staysOpen) {
                openRows().forEach((other) => {
                    if (other !== row && !other.words.staysOpen) setToolOpen(other, false);
                });
            }
            mountTool(row);
        } else {
            disposeTool(row);
        }
        syncHead();
    }

    function rowFor(tool) {
        let row = toolRows.get(tool.id);
        if (row && row.tool === tool) return row;
        const words = toolWords(tool);
        const panelId = `spectroTool-${tool.id}`;
        const chip = make('button', { type: 'button', class: 'spectro-tool-chip', title: words.about, 'aria-pressed': 'false', 'aria-controls': panelId, hidden: true }, [
            make('span', { text: words.short }),
            make('span', { class: 'spectro-tool-x', 'aria-hidden': 'true', text: '×' })
        ]);
        const body = make('div', { class: 'spectro-tool-body' });
        const panel = make('div', { id: panelId, class: 'spectro-tool-panel', role: 'region', 'aria-label': tool.label, tabIndex: -1, hidden: true }, [body]);
        row = { tool, words, chip, panel, body, instance: null, open: false, wanted: false };
        const thisRow = row;
        chip.addEventListener('click', () => {
            const next = !thisRow.open;
            thisRow.wanted = next;
            setToolOpen(thisRow, next);
            if (next) revealTool(thisRow);
        });
        toolBar.appendChild(chip);
        toolsEl.appendChild(panel);
        toolRows.set(tool.id, row);
        return row;
    }

    // Tidy rows that fill the width. Up to four sit on one row, at whatever widths their words need, so that none is cut
    // short; more than four go three to a row. The plot makes way for a second row.
    function layoutToolBar() {
        const chips = [...toolBar.children].filter((chip) => !chip.hidden);
        if (!chips.length) return;
        root.style.setProperty('--spectro-tool-basis', chips.length > 4 ? 'calc(33.3% - 0.3em)' : 'auto');
        const rows = Math.round((toolBar.offsetHeight + 5) / (chips[0].offsetHeight + 5));
        root.style.setProperty('--spectro-tool-rows', String(Math.max(1, rows)));
        syncScrollPadding();
    }
    new ResizeObserver(layoutToolBar).observe(toolBar);
    // A pinned tool has no row to open: it is there for every object it applies to
    const pinned = new Map();
    function syncPinned(tool) {
        let applies = false;
        try {
            applies = !!resolved && tool.appliesTo(resolved);
            let instance = pinned.get(tool.id);
            if (applies && !instance) {
                instance = tool.mount(pinnedHost, panelApi);
                pinned.set(tool.id, instance);
            } else if (!applies && instance) {
                pinned.delete(tool.id);
                instance.dispose();
                return;
            }
            if (applies && instance.setEntity) instance.setEntity(resolved);
        } catch (err) {
            console.error(`[spectroscopy] tool ${tool.id}:`, err);
        }
    }

    function syncTools() {
        let any = false;
        listTools().forEach((tool) => {
            if (tool.pinned) {
                syncPinned(tool);
                return;
            }
            const row = rowFor(tool);
            let applies = false;
            try {
                applies = !!resolved && tool.appliesTo(resolved);
            } catch (err) {
                console.error(`[spectroscopy] tool ${tool.id}:`, err);
            }
            row.chip.hidden = !applies;
            if (applies) {
                any = true;
                if (row.open && row.instance && row.instance.setEntity) row.instance.setEntity(resolved);
                // Left on, and now back on something it applies to
                else if (!row.open && row.wanted && row.words.comesBack) setToolOpen(row, true);
            } else if (row.open) {
                setToolOpen(row, false);
                if (!row.words.comesBack) row.wanted = false;
            }
        });
        toolBar.hidden = !any;
        layoutToolBar();
    }

    // ---------- The API tools see ----------

    const panelApi = {
        plot,
        get resolved() {
            return resolved;
        },
        toolsEl,
        getSpectrum: () => bodySpectrum,
        getOverview() {
            if (!resolved) return null;
            if (!overview) overview = computeBody(FULL_RANGE);
            return overview;
        },
        getReference: () => refShown,
        refresh,
        getResolution: () => resolution,
        setResolution(next, span) {
            resolution = next === 'zoom' ? 'zoom' : 'overview';
            plot.setMinRatio(resolution === 'zoom' ? ZOOM_MIN_RATIO : OVERVIEW_MIN_RATIO);
            const lo = span && (span.lo_nm ?? span.lo);
            const hi = span && (span.hi_nm ?? span.hi);
            // A tool framing a line for itself isn't the student choosing a range, unless they're choosing the line
            const zooming = toolRows.get('line-zoom');
            framing = !(zooming && zooming.open);
            if (lo && hi) plot.setRange(lo, hi);
            framing = false;
            if (!resolved || !visible) return;
            updateBody(false);
            computeReference(false);
        },
        setBodyOpts(opts) {
            if (!opts) bodyOpts = {};
            else {
                Object.entries(opts).forEach(([key, value]) => {
                    if (value === null || value === undefined) delete bodyOpts[key];
                    else bodyOpts[key] = value;
                });
            }
            refresh({ body: true, ref: false });
            bodyOptsFns.forEach((fn) => fn(opts || {}));
        },
        getBodyOpts: () => ({ ...bodyOpts }),
        // Called with what changed whenever setBodyOpts is used, so one tool can follow what another asks for
        onBodyOpts(fn) {
            bodyOptsFns.add(fn);
            return () => bodyOptsFns.delete(fn);
        },
        onReferenceChange(fn) {
            referenceFns.add(fn);
            return () => referenceFns.delete(fn);
        },
        // Asked of the selection itself, as the buttons only catch up with it once this tab is showing
        hasTool(id) {
            const tool = listTools().find((t) => t.id === toolId(id));
            return !!tool && !!resolved && tool.appliesTo(resolved);
        },
        get cameFrom() {
            return cameFrom;
        },
        setMode,
        openTool(id, { from = null, focus = false } = {}) {
            app.drawer.selectTab('spectrum');
            const row = toolRows.get(toolId(id));
            if (!row || row.chip.hidden) return false;
            if (from) cameFrom = from;
            row.wanted = true;
            setToolOpen(row, true);
            revealTool(row);
            if (focus) row.panel.focus({ preventScroll: true });
            return true;
        },
        // For tests and for tools that need to change the reference
        picker
    };
    app.spectrumPanel = panelApi;

    plot.onRangeChange(onViewChanged);

    return {
        setEntity(next) {
            resolved = next;
            entityDirty = true;
            if (visible) applyEntity();
        },
        onShow() {
            visible = true;
            if (entityDirty) applyEntity();
            else plot.redraw();
            syncScrollPadding();
            pinned.forEach((instance) => { if (instance.onPanelShow) instance.onPanelShow(); });
            toolRows.forEach((row) => {
                if (row.instance && row.instance.onPanelShow) row.instance.onPanelShow();
            });
        },
        onHide() {
            visible = false;
            syncScrollPadding();
            // A tool playing through time stops when it can't be seen
            pinned.forEach((instance) => { if (instance.onPanelHide) instance.onPanelHide(); });
            toolRows.forEach((row) => {
                if (row.instance && row.instance.onPanelHide) row.instance.onPanelHide();
            });
        }
    };
}

// Ids can be written either way, as these come from other people's text
function toolId(id) {
    return String(id).replace(/_/g, '-');
}

export function initSpectrumTab(app) {
    app.drawer.registerTab({
        id: 'spectrum',
        label: 'Spectrum',
        order: 20,
        appliesTo: () => true,
        mount: (container) => createSpectrumPanel(app, container)
    });

    // The tab opens the first time it's asked for, and the real panel then takes over from this
    const beforeMount = {
        hasTool(id) {
            const tool = listTools().find((t) => t.id === toolId(id));
            return !!tool && !!app.selected && tool.appliesTo(app.selected);
        },
        openTool(id, opts) {
            app.drawer.selectTab('spectrum');
            return app.spectrumPanel !== beforeMount && app.spectrumPanel.openTool(id, opts);
        }
    };
    app.spectrumPanel = beforeMount;

    // A button anywhere in the drawer's text that names a tool or this tab goes there
    document.addEventListener('click', (e) => {
        const link = e.target.closest && e.target.closest('[data-spectro-tool], [data-spectro-tab]');
        if (!link) return;
        e.preventDefault();
        if (link.dataset.spectroTab) app.drawer.selectTab(link.dataset.spectroTab);
        else app.spectrumPanel.openTool(link.dataset.spectroTool, { focus: true, from: link.dataset.spectroFrom || null });
    });

    // Text written elsewhere names tools in words. Those words become buttons, for whichever tools this object has.
    const watched = new Set();
    const LINKED_TABS = ['overview', 'info'];
    const linkIn = (panel) => linkToolNames(panel, (id) => app.spectrumPanel.hasTool(id));
    bus.on('drawer', ({ view, tab }) => {
        if (view !== 'object' || !LINKED_TABS.includes(tab)) return;
        const panel = document.getElementById(`spectroPanel-${tab}`);
        if (!panel) return;
        linkIn(panel);
        if (watched.has(panel)) return;
        watched.add(panel);
        new MutationObserver(() => linkIn(panel)).observe(panel, { childList: true, subtree: true });
    });
}
