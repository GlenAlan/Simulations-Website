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
//   openTool(id), hasTool(id)   open a tool by its id, unfolding the Tools list; false if this object doesn't have it
//   picker                  the reference picker, see refs.js
//   toolsEl                 the element the tools are listed in

import { spectrumOf, referenceSpectrum, autoRange } from '../../spectra/synth.js';
import { R_OVERVIEW, R_ZOOM, SPECTRUM_LO_NM, SPECTRUM_HI_NM } from '../../core/phys.js';
import { wavelength } from '../../core/format.js';
import { createPlot, WAVELENGTH_PRESETS } from './plot.js';
import { createRefPicker, shiftShort } from './refs.js';
import { listTools } from './tools/index.js';

const FULL_RANGE = { lo: SPECTRUM_LO_NM, hi: SPECTRUM_HI_NM, R: R_OVERVIEW };
const OVERVIEW_MIN_RATIO = 1.002;    // About 1.3 nm at Hα, which is 20 samples at overview resolution
const ZOOM_MIN_RATIO = 1.0001;       // About 0.07 nm at Hα, which is 20 samples at line-zoom resolution
const ZOOM_UPGRADE_RATIO = 1.08;     // Higher resolution only shows on screen once the view is this narrow
const NO_SPECTRUM_NOTE = 'This object gives off too little light to record a spectrum in this range. Its Overview tab says what can be seen of it instead.';

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

    // Stacked or overlay, and the zoom buttons
    const stackedButton = make('button', { type: 'button', class: 'spectro-seg-button', text: 'Stacked', 'aria-pressed': 'true', title: 'Object on top, reference below, on one wavelength axis' });
    const overlayButton = make('button', { type: 'button', class: 'spectro-seg-button', text: 'Overlay', 'aria-pressed': 'false', title: 'Reference drawn over the object' });
    const seg = make('div', { class: 'spectro-seg', role: 'group', 'aria-label': 'How to show the two spectra' }, [stackedButton, overlayButton]);
    const zoomOut = make('button', { type: 'button', class: 'spectro-square', 'aria-label': 'Zoom out', title: 'Zoom out (minus key)', text: '−' });
    const zoomIn = make('button', { type: 'button', class: 'spectro-square', 'aria-label': 'Zoom in', title: 'Zoom in (plus key)', text: '+' });
    const autoButton = make('button', { type: 'button', class: 'spectro-text-button spectro-auto', text: 'Auto', title: 'Frame this object automatically (or double-click the plot)' });
    const zoomGroup = make('div', { class: 'spectro-zoom', role: 'group', 'aria-label': 'Zoom' }, [zoomOut, zoomIn, autoButton]);
    const toolbar = make('div', { class: 'spectro-toolbar' }, [seg, zoomGroup]);
    instrument.appendChild(toolbar);

    const plotHost = make('div', { class: 'spectro-plot-host' });
    instrument.appendChild(plotHost);
    const plot = createPlot(plotHost, {
        minRatio: OVERVIEW_MIN_RATIO,
        reduceMotion: () => !!(app.settings && app.settings.reduceMotion),
        ariaLabel: 'Spectrum'
    });

    // Presets
    const presetRow = make('div', { class: 'spectro-presets', role: 'group', 'aria-label': 'Wavelength range' });
    const presetButtons = WAVELENGTH_PRESETS.map((preset) => {
        const button = make('button', { type: 'button', class: 'spectro-chip', text: preset.label, title: preset.title, 'aria-pressed': 'false' });
        button.addEventListener('click', () => plot.setRange(preset.lo, preset.hi, { animate: true }));
        presetRow.appendChild(button);
        return { preset, button };
    });
    instrument.appendChild(presetRow);
    const pinnedHost = make('div', { class: 'spectro-pinned' });
    instrument.appendChild(pinnedHost);
    // A mouse wheel has no sideways: let it scroll the row
    presetRow.addEventListener('wheel', (e) => {
        if (presetRow.scrollWidth <= presetRow.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        presetRow.scrollLeft += e.deltaY;
        e.preventDefault();
    }, { passive: false });
    function syncPresetEdges() {
        presetRow.classList.toggle('at-start', presetRow.scrollLeft < 2);
        presetRow.classList.toggle('at-end', presetRow.scrollLeft + presetRow.clientWidth > presetRow.scrollWidth - 2);
    }
    presetRow.addEventListener('scroll', syncPresetEdges, { passive: true });

    const note = make('p', { class: 'spectro-note', hidden: true });

    // The reference
    const refHost = make('div', { class: 'spectro-ref-host' });
    instrument.appendChild(refHost);
    const picker = createRefPicker(refHost, {
        onChange() {
            computeReference();
            describeSoon();
            referenceFns.forEach((fn) => fn());
        },
        onLabels(on) {
            plot.showLineLabels(on);
        },
        onOpenChange(open) {
            root.classList.toggle('is-picking', open);
        },
        onFrame(lo, hi) {
            plot.setRange(lo, hi, { animate: true });
        }
    });
    instrument.appendChild(note);

    // Tools
    const toolsEl = make('div', { class: 'spectro-tools' });
    const toolsDetails = make('details', { class: 'sim-controls-more spectro-more', hidden: true }, [make('summary', { text: 'Tools' }), toolsEl]);
    instrument.appendChild(toolsDetails);

    // The conventions, stated once and out of the way
    const help = make('details', { class: 'sim-controls-more spectro-more spectro-help' }, [
        make('summary', {}, [make('span', { text: 'About these wavelengths' })]),
        make('p', { text: 'Wavelengths above 200 nm are air wavelengths, as in most textbooks: Hα is 656.3 nm. Below 200 nm they are vacuum wavelengths: Lyman-α is 121.6 nm. Spectra and references both follow this, so their lines match.' }),
        make('p', { text: 'Flux is how much light arrives at each wavelength. It is relative here, not in real units, and each scale fits itself to what is in view. In the colour strips, dark lines are absorption and bright lines are emission. UV and IR are hatched because your eye can\'t see them.' }),
        make('p', { text: 'Keys on the plot: left and right arrows pan, plus and minus zoom, Shift with an arrow moves the cursor, and 0 resets the view.' })
    ]);
    instrument.appendChild(help);

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

    let viewQueued = 0;
    function onViewChanged(lo, hi) {
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
        plot.setMinRatio(OVERVIEW_MIN_RATIO);
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
        plot.setRange(frame.lo, frame.hi);
        plot.setAutoRange(frame.lo, frame.hi);
        drawBody();
        updateNote();
        computeReference(false);
        syncPresets();
        picker.setView(frame.lo, frame.hi);
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
        syncPresetEdges();
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

    // Brings an opened tool up under the plot, which stays stuck to the top of the drawer while a tool is open
    function revealTool(row) {
        // Only the drawer scrolls: scrollIntoView would move the whole page, and the sky with it
        let scroller = row.details.parentElement;
        while (scroller && scroller !== document.body) {
            const overflow = getComputedStyle(scroller).overflowY;
            if ((overflow === 'auto' || overflow === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break;
            scroller = scroller.parentElement;
        }
        if (!scroller || scroller === document.body) return;
        const inside = row.details.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        const reduce = !!(app.settings && app.settings.reduceMotion);
        scroller.scrollTo({ top: scroller.scrollTop + inside - plotHost.offsetHeight - 6, behavior: reduce ? 'auto' : 'smooth' });
    }

    function closeTool(row) {
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

    function openTool(row) {
        if (row.instance || !resolved) return;
        try {
            row.instance = row.tool.mount(row.body, panelApi);
            if (row.instance && row.instance.setEntity) row.instance.setEntity(resolved);
        } catch (err) {
            console.error(`[spectroscopy] tool ${row.tool.id} failed to open:`, err);
            row.body.textContent = 'This tool could not start.';
        }
    }

    function rowFor(tool) {
        let row = toolRows.get(tool.id);
        if (row && row.tool === tool) return row;
        const body = make('div', { class: 'spectro-tool-body' });
        const details = make('details', { class: 'spectro-tool' }, [make('summary', { text: tool.label }), body]);
        row = { tool, details, body, instance: null };
        details.addEventListener('toggle', () => {
            if (details.open) {
                // Only one tool at a time draws: opening one closes the other, and its dispose hands back the plot
                if (tool.draws) {
                    toolRows.forEach((other) => {
                        if (other !== row && other.tool.draws && other.details.open) {
                            other.details.open = false;
                            closeTool(other);
                        }
                    });
                }
                openTool(row);
                revealTool(row);
            } else {
                closeTool(row);
            }
        });
        toolsEl.appendChild(details);
        toolRows.set(tool.id, row);
        return row;
    }

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
            row.details.hidden = !applies;
            if (applies) {
                any = true;
                if (row.instance && row.instance.setEntity) row.instance.setEntity(resolved);
            } else if (row.instance || row.details.open) {
                row.details.open = false;
                closeTool(row);
            }
        });
        toolsDetails.hidden = !any;
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
            if (lo && hi) plot.setRange(lo, hi);
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
        hasTool(id) {
            const row = toolRows.get(id);
            return !!row && !row.details.hidden;
        },
        // Opens a tool by id, unfolding the Tools list if need be. False if this object doesn't have that tool.
        openTool(id) {
            const row = toolRows.get(id);
            if (!row || row.details.hidden) return false;
            toolsDetails.open = true;
            if (row.details.open) revealTool(row);
            else row.details.open = true;
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
            pinned.forEach((instance) => { if (instance.onPanelShow) instance.onPanelShow(); });
            toolRows.forEach((row) => {
                if (row.instance && row.instance.onPanelShow) row.instance.onPanelShow();
            });
        },
        onHide() {
            visible = false;
            // A tool playing through time stops when it can't be seen
            pinned.forEach((instance) => { if (instance.onPanelHide) instance.onPanelHide(); });
            toolRows.forEach((row) => {
                if (row.instance && row.instance.onPanelHide) row.instance.onPanelHide();
            });
        }
    };
}

export function initSpectrumTab(app) {
    app.drawer.registerTab({
        id: 'spectrum',
        label: 'Spectrum',
        order: 20,
        appliesTo: () => true,
        mount: (container) => createSpectrumPanel(app, container)
    });
}
