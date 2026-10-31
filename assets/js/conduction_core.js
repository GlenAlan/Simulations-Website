// Conduction simulation core.
//
// Model: a 2D lattice of atoms (unit mass). Each atom is held near its lattice
// site by a weak on-site spring and is joined to its 8 neighbours (orthogonal
// and diagonal) by Hookean springs. Heating gives atoms random velocity kicks;
// the springs then pass that vibrational energy from atom to atom, which is how
// heat is conducted through a solid. Between heating and cooling the total
// energy is conserved (velocity-Verlet integration).
//
// The physics runs in lattice units (spacing = 1), so the dynamics, colours,
// temperature and brush size do not depend on the size of the canvas. Positions
// are scaled to CSS pixels only for drawing and for locating the brush.
(function () {
    'use strict';

    const canvas = document.getElementById('simulationCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (!canvas || !ctx) {
        console.error('Conduction simulation: #simulationCanvas (2D canvas) not found.');
        return;
    }

    // DOM refs
    const timeSlider = document.getElementById('timeScale');
    const timeVal = document.getElementById('timeScaleVal');
    const radiusSlider = document.getElementById('heatSize');
    const radiusVal = document.getElementById('heatSizeVal');
    const heatAmpSlider = document.getElementById('heatAmp');
    const ampVal = document.getElementById('heatAmpVal');
    const springConstantSlider = document.getElementById('springConstant');
    const springConstantVal = document.getElementById('springConstantVal');
    const temperatureVal = document.getElementById('energyVal');
    const fpsDisplay = document.getElementById('fpsDisplay');
    const resetButton = document.getElementById('resetSimulationBtn');
    const gridLayoutSelector = document.getElementById('gridLayoutSelector');
    const aspectRatioBox = canvas.parentElement; // .sim-aspect-ratio-box
    const modeButtons = Array.from(document.querySelectorAll('.thermal-mode [data-mode]'));
    const hintEl = document.getElementById('thermalHint');
    const legendBar = document.getElementById('colourLegendBar');

    // --- Layout ---
    // Each atom sits in the middle of a square cell one spacing wide, and the
    // canvas has the lattice's shape (cols:rows), so the outer atoms are half a
    // spacing from the edge at every canvas size.
    const PARTICLE_RADIUS_SCALE_FACTOR = 6;  // atom radius = spacing / 6

    // --- Physics (lattice units: spacing = 1, mass = 1) ---
    const K_SITE = 0.5;                // on-site restoring spring constant
    const BASE_DT = 0.005;             // simulated time per 1/60 s at speed 1x
    const MAX_SUBSTEP_DT = 0.02;       // largest integration step (omega_max * dt < 0.06 even at k = 1)
    const MAX_SUBSTEPS_PER_FRAME = 60; // speed 100x needs 25 at 60 fps; extra time is dropped, not queued
    const REFERENCE_FRAME_MS = 1000 / 60;
    const MAX_FRAME_MS = 100;          // clamp after tab switches or stalls

    // --- Heating / cooling tool (strength per 1/60 s, scaled to the real frame time) ---
    const HEAT_KICK = 0.0275;          // random velocity kick at intensity 1 at the brush centre
    const COOL_RATE = 0.2;             // largest fraction of velocity removed per 1/60 s

    // --- Temperature ---
    // In 2D each atom has two kinetic and two potential quadratic degrees of
    // freedom, so by equipartition its mean vibrational energy is 2 k_B T:
    // temperature is proportional to energy per atom. The kelvin scale is
    // illustrative: an atom with HOT_ENERGY (vibration amplitude about 4% of the
    // spacing) is drawn fully red and counts as HOT_TEMPERATURE_K.
    const HOT_ENERGY = 1.4e-3;
    const HOT_TEMPERATURE_K = 1000;
    const MAX_HEAT_ENERGY = 30 * HOT_ENERGY; // heating fades out here (amplitude roughly 20% of spacing)
    const COLOUR_SMOOTHING_S = 0.2;          // time constant of the colour smoothing
    const COLOUR_LEVELS = 120;               // hue steps from blue (cold) to red (hot)

    const PREDEFINED_GRID_LAYOUTS = {
        "small": { cols: 10, rows: 5 },
        "default": { cols: 20, rows: 10 },
        "large": { cols: 40, rows: 20 },
        "wide": { cols: 30, rows: 5 },
        "square_medium": { cols: 15, rows: 15 },
        "large_square": { cols: 25, rows: 25 }
    };
    // Portrait phones are too narrow for a 2:1 lattice to be comfortable to touch,
    // so they start with the square one.
    const narrowPortrait = !!(window.matchMedia && window.matchMedia('(max-width: 600px) and (orientation: portrait)').matches);
    let currentGridLayoutName = narrowPortrait ? "square_medium" : "default";
    let cols = PREDEFINED_GRID_LAYOUTS[currentGridLayoutName].cols;
    let rows = PREDEFINED_GRID_LAYOUTS[currentGridLayoutName].rows;

    // Parameters from the controls
    let timeScale = timeSlider ? parseFloat(timeSlider.value) : 25;
    let heatRadius = radiusSlider ? parseFloat(radiusSlider.value) : 1.5;  // brush radius in atom spacings
    let heatAmp = heatAmpSlider ? parseFloat(heatAmpSlider.value) : 1;
    let kN = springConstantSlider ? parseFloat(springConstantSlider.value) : 0.2; // neighbour spring constant

    // --- Lattice state (structure of arrays) ---
    let count = 0;
    let gx, gy;          // lattice site of each atom (column, row)
    let ux, uy, vx, vy;  // displacement from the site and velocity
    let fx, fy;          // force
    let energy;          // per-atom vibrational energy (kinetic + on-site + half of each spring)
    let smoothEnergy;    // smoothed energy used for the colour
    let sx, sy;          // screen position (CSS px), refreshed each frame
    let colourLevel, drawOrder, levelCounts;
    let springCount = 0;
    let springA, springB;     // atom indices
    let springOx, springOy;   // rest vector from B to A
    let springRest;           // rest length (1 or sqrt 2)
    let forcesValid = false;
    let totalEnergy = 0;

    // --- View geometry ---
    let viewW = 0, viewH = 0;           // canvas size in CSS px
    let pixelRatio = 1;
    let spacing = 30, offsetX = 0, offsetY = 0;
    let layoutDirty = true;

    function buildLattice() {
        count = cols * rows;
        gx = new Float64Array(count); gy = new Float64Array(count);
        ux = new Float64Array(count); uy = new Float64Array(count);
        vx = new Float64Array(count); vy = new Float64Array(count);
        fx = new Float64Array(count); fy = new Float64Array(count);
        energy = new Float64Array(count); smoothEnergy = new Float64Array(count);
        sx = new Float64Array(count); sy = new Float64Array(count);
        colourLevel = new Uint8Array(count); drawOrder = new Uint16Array(count);
        levelCounts = new Uint16Array(COLOUR_LEVELS + 2);

        const idx = (i, j) => i * rows + j;
        for (let i = 0; i < cols; i++) {
            for (let j = 0; j < rows; j++) {
                gx[idx(i, j)] = i;
                gy[idx(i, j)] = j;
            }
        }

        // Each spring once: right, down, down-right and up-right neighbours.
        const links = [];
        const offsets = [[1, 0], [0, 1], [1, 1], [1, -1]];
        for (let i = 0; i < cols; i++) {
            for (let j = 0; j < rows; j++) {
                for (const [di, dj] of offsets) {
                    const ni = i + di, nj = j + dj;
                    if (ni < cols && nj >= 0 && nj < rows) links.push([idx(i, j), idx(ni, nj)]);
                }
            }
        }
        springCount = links.length;
        springA = new Uint16Array(springCount); springB = new Uint16Array(springCount);
        springOx = new Float64Array(springCount); springOy = new Float64Array(springCount);
        springRest = new Float64Array(springCount);
        links.forEach(([a, b], s) => {
            springA[s] = a;
            springB[s] = b;
            springOx[s] = gx[a] - gx[b];
            springOy[s] = gy[a] - gy[b];
            springRest[s] = Math.hypot(springOx[s], springOy[s]);
        });
        forcesValid = false;
        totalEnergy = 0;
    }

    function resetLattice() {
        ux.fill(0); uy.fill(0); vx.fill(0); vy.fill(0);
        fx.fill(0); fy.fill(0);
        energy.fill(0); smoothEnergy.fill(0);
        totalEnergy = 0;
        forcesValid = true; // all forces are zero at rest
    }

    // Grid spacing and centring offsets for a canvas of the given CSS size.
    function calculateGridGeometry(width, height) {
        const s = Math.max(0.5, Math.min(width / cols, height / rows));
        return {
            spacing: s,
            offsetX: (width - (cols - 1) * s) / 2,
            offsetY: (height - (rows - 1) * s) / 2
        };
    }

    // --- Physics ---
    function computeForces() {
        const k = kN;
        for (let i = 0; i < count; i++) {
            fx[i] = -K_SITE * ux[i];
            fy[i] = -K_SITE * uy[i];
        }
        for (let s = 0; s < springCount; s++) {
            const a = springA[s], b = springB[s];
            const dx = springOx[s] + ux[a] - ux[b];
            const dy = springOy[s] + uy[a] - uy[b];
            const d2 = dx * dx + dy * dy;
            if (d2 < 1e-12) continue; // coincident atoms: direction undefined
            const d = Math.sqrt(d2);
            const f = k * (springRest[s] - d) / d; // Hooke's law along the spring
            const ex = f * dx, ey = f * dy;
            fx[a] += ex; fy[a] += ey;
            fx[b] -= ex; fy[b] -= ey;
        }
        forcesValid = true;
    }

    // One velocity-Verlet step of length h.
    function verletStep(h) {
        const halfH = 0.5 * h;
        for (let i = 0; i < count; i++) {
            vx[i] += fx[i] * halfH;
            vy[i] += fy[i] * halfH;
            ux[i] += vx[i] * h;
            uy[i] += vy[i] * h;
        }
        computeForces();
        for (let i = 0; i < count; i++) {
            vx[i] += fx[i] * halfH;
            vy[i] += fy[i] * halfH;
        }
    }

    // Advance the lattice by the simulated time that corresponds to frameMs.
    function advancePhysics(frameMs) {
        let simTime = (frameMs / REFERENCE_FRAME_MS) * timeScale * BASE_DT;
        if (simTime <= 0) return;
        let steps = Math.ceil(simTime / MAX_SUBSTEP_DT);
        if (steps > MAX_SUBSTEPS_PER_FRAME) {
            steps = MAX_SUBSTEPS_PER_FRAME;
            simTime = steps * MAX_SUBSTEP_DT;
        }
        const h = simTime / steps;
        if (!forcesValid) computeForces();
        for (let n = 0; n < steps; n++) verletStep(h);
    }

    // Per-atom energy: kinetic + on-site potential + half of each attached spring.
    function computeEnergies() {
        const k = kN;
        for (let i = 0; i < count; i++) {
            energy[i] = 0.5 * (vx[i] * vx[i] + vy[i] * vy[i]) + 0.5 * K_SITE * (ux[i] * ux[i] + uy[i] * uy[i]);
        }
        for (let s = 0; s < springCount; s++) {
            const a = springA[s], b = springB[s];
            const dx = springOx[s] + ux[a] - ux[b];
            const dy = springOy[s] + uy[a] - uy[b];
            const stretch = Math.sqrt(dx * dx + dy * dy) - springRest[s];
            const half = 0.25 * k * stretch * stretch;
            energy[a] += half;
            energy[b] += half;
        }
        let total = 0;
        for (let i = 0; i < count; i++) total += energy[i];
        totalEnergy = total;
    }

    function updateColours(frameMs) {
        const alpha = 1 - Math.exp(-frameMs / (1000 * COLOUR_SMOOTHING_S));
        for (let i = 0; i < count; i++) {
            smoothEnergy[i] += alpha * (energy[i] - smoothEnergy[i]);
            // sqrt: hue follows vibration amplitude, as the description says
            const t = Math.sqrt(smoothEnergy[i] / HOT_ENERGY);
            colourLevel[i] = t >= 1 ? COLOUR_LEVELS : Math.round(t * COLOUR_LEVELS);
        }
    }

    function averageTemperatureK() {
        return count > 0 ? (totalEnergy / count) / HOT_ENERGY * HOT_TEMPERATURE_K : 0;
    }

    // --- Heating / cooling tool ---
    // The Heat / Cool switch sets what a plain press does (left mouse button, pen
    // or one finger). The shortcuts do the opposite: right button, pen eraser,
    // Ctrl or Shift + click, or two or more fingers (acting under each finger).
    const TOOL_NONE = 0, TOOL_HEAT = 1, TOOL_COOL = -1;
    let toolMode = TOOL_HEAT;
    const touchPoints = new Map();     // pointerId -> {x, y} (CSS px, canvas-relative)
    let mouseTool = TOOL_NONE;
    let mousePoint = { x: 0, y: 0 };
    let hoverPoint = null;             // mouse/pen position while no button is pressed
    const brushPoints = [];            // where the tool acts this frame
    let activeTool = TOOL_NONE;

    function updateBrush() {
        brushPoints.length = 0;
        if (touchPoints.size > 0) {
            touchPoints.forEach((p) => brushPoints.push(p));
            activeTool = touchPoints.size >= 2 ? -toolMode : toolMode;
        } else if (mouseTool !== TOOL_NONE) {
            brushPoints.push(mousePoint);
            activeTool = mouseTool;
        } else {
            activeTool = TOOL_NONE;
        }
    }

    // The brush is a Gaussian whose visible edge (2 sigma) is heatRadius atom
    // spacings from its centre, so it covers the same atoms at every canvas size.
    function brushSigmaPx() {
        return 0.5 * heatRadius * spacing;
    }

    function applyTool(frameMs) {
        updateBrush();
        if (activeTool === TOOL_NONE) return;
        const frameScale = frameMs / REFERENCE_FRAME_MS;
        const sigma = brushSigmaPx();
        const inv2R2 = 1 / (2 * sigma * sigma);
        const reach2 = 16 * sigma * sigma; // ignore atoms beyond 4 sigma
        const kick = HEAT_KICK * heatAmp * Math.sqrt(frameScale); // random walk: energy grows linearly in time
        for (const p of brushPoints) {
            for (let i = 0; i < count; i++) {
                const dx = sx[i] - p.x, dy = sy[i] - p.y;
                const r2 = dx * dx + dy * dy;
                if (r2 > reach2) continue;
                const weight = Math.exp(-r2 * inv2R2);
                if (activeTool === TOOL_HEAT) {
                    // The smoothed energy damps the atom-to-atom fluctuations that
                    // would otherwise let the cap leak.
                    const headroom = 1 - Math.max(energy[i], smoothEnergy[i]) / MAX_HEAT_ENERGY;
                    if (headroom <= 0) continue;
                    const dv = kick * weight * headroom;
                    vx[i] += (Math.random() * 2 - 1) * dv;
                    vy[i] += (Math.random() * 2 - 1) * dv;
                } else {
                    const damping = Math.min(COOL_RATE, heatAmp * COOL_RATE * weight);
                    const keep = Math.pow(1 - damping, frameScale);
                    vx[i] *= keep;
                    vy[i] *= keep;
                }
            }
        }
    }

    function canvasPoint(e) {
        const r = canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function toolForButtons(buttons, modifier) {
        if (buttons & (2 | 32)) return -toolMode;     // right button or pen eraser
        if (buttons & 1) return modifier ? -toolMode : toolMode; // Ctrl/Shift+click: one-button shortcut
        return TOOL_NONE;
    }

    function releaseAllTools() {
        touchPoints.clear();
        mouseTool = TOOL_NONE;
        hoverPoint = null;
    }

    function hideHint() {
        if (hintEl && !hintEl.classList.contains('is-hidden')) hintEl.classList.add('is-hidden');
    }

    // Pointer capture keeps the tool working while a drag strays past the edge
    // and guarantees the matching pointerup.
    canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch') {
            touchPoints.set(e.pointerId, canvasPoint(e));
        } else {
            mouseTool = toolForButtons(e.buttons, e.ctrlKey || e.shiftKey);
            if (mouseTool === TOOL_NONE) return;
            mousePoint = canvasPoint(e);
            hoverPoint = null;
        }
        hideHint();
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* pointer already released */ }
    });
    canvas.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') {
            if (touchPoints.has(e.pointerId)) touchPoints.set(e.pointerId, canvasPoint(e));
        } else if (mouseTool !== TOOL_NONE) {
            // Buttons can be pressed or released mid-drag (chorded buttons, Ctrl, Shift).
            mouseTool = toolForButtons(e.buttons, e.ctrlKey || e.shiftKey);
            mousePoint = canvasPoint(e);
        } else {
            hoverPoint = canvasPoint(e); // shows the brush outline under the mouse
        }
    });
    const endPointer = (e) => {
        if (e.pointerType === 'touch') {
            touchPoints.delete(e.pointerId);
        } else if (mouseTool !== TOOL_NONE) {
            mouseTool = TOOL_NONE;
            if (e.type === 'pointerup') hoverPoint = canvasPoint(e);
        }
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('lostpointercapture', endPointer);
    canvas.addEventListener('pointerleave', (e) => {
        if (e.pointerType !== 'touch' && mouseTool === TOOL_NONE) hoverPoint = null;
    });
    window.addEventListener('blur', releaseAllTools);
    // Only suppress the menu: Windows fires contextmenu after the right button
    // is released, so it must not switch cooling on.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Heat / Cool switch (a radio group: arrow keys move between the options)
    function setToolMode(mode) {
        toolMode = mode;
        modeButtons.forEach((button) => {
            const checked = (button.dataset.mode === 'cool' ? TOOL_COOL : TOOL_HEAT) === mode;
            button.setAttribute('aria-checked', String(checked));
            button.tabIndex = checked ? 0 : -1;
        });
    }
    modeButtons.forEach((button, index) => {
        button.addEventListener('click', () => setToolMode(button.dataset.mode === 'cool' ? TOOL_COOL : TOOL_HEAT));
        button.addEventListener('keydown', (e) => {
            const step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1
                : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            const next = modeButtons[(index + step + modeButtons.length) % modeButtons.length];
            next.click();
            next.focus();
        });
    });
    setToolMode(TOOL_HEAT);

    // --- Canvas sizing ---
    // The shared layout sizes the aspect-ratio box (normal and fullscreen); this
    // only sizes the canvas backing store to its displayed size times
    // devicePixelRatio, so it is crisp on high-DPI screens.
    function layoutCanvas() {
        layoutDirty = false;
        const rect = canvas.getBoundingClientRect();
        const cssW = Math.max(1, rect.width), cssH = Math.max(1, rect.height);
        const dpr = window.devicePixelRatio || 1;
        const bufferW = Math.max(1, Math.round(cssW * dpr));
        const bufferH = Math.max(1, Math.round(cssH * dpr));
        if (canvas.width !== bufferW) canvas.width = bufferW;
        if (canvas.height !== bufferH) canvas.height = bufferH;
        viewW = cssW;
        viewH = cssH;
        pixelRatio = dpr;

        const geom = calculateGridGeometry(viewW, viewH);
        spacing = geom.spacing;
        offsetX = geom.offsetX;
        offsetY = geom.offsetY;
    }

    function setAspectRatioProperty() {
        // The lattice's shape; simulation_ui.js copies it to wherever the shared
        // layout needs it. A plain number so it also works as a CSS calc() divisor.
        if (aspectRatioBox) aspectRatioBox.style.setProperty('--aspect-ratio', String(cols / rows));
    }

    const markLayoutDirty = () => { layoutDirty = true; };
    window.addEventListener('resize', markLayoutDirty);
    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(markLayoutDirty).observe(canvas);
    }
    // Fullscreen / panel state is toggled through body classes.
    new MutationObserver(markLayoutDirty).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // --- Theme-dependent palette (refreshed when the light/dark theme changes) ---
    // Atoms go from blue (cold) through green and yellow to red (hot). On the
    // dark theme the original fully saturated hues are kept; on the light theme
    // greens, yellows and cyans are darkened until they contrast with white.
    const palette = { atoms: [], spring: '', heatGlow: [], coolGlow: [], heatRing: '', coolRing: '' };

    function hslToLuminance(h, s, l) {
        const a = s * Math.min(l, 1 - l);
        const channel = (n) => {
            const k = (n + h / 30) % 12;
            const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
            return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4);
    }

    function buildPalette() {
        const light = !document.documentElement.classList.contains('dark-mode');
        palette.atoms = [];
        for (let level = 0; level <= COLOUR_LEVELS; level++) {
            const hue = (1 - level / COLOUR_LEVELS) * 240;
            let lightness = 50;
            if (light) {
                while (lightness > 30 && hslToLuminance(hue, 1, lightness / 100) > 0.42) lightness -= 1;
            }
            palette.atoms.push(`hsl(${hue.toFixed(1)}, 100%, ${lightness}%)`);
        }
        palette.spring = 'rgba(100, 100, 100, 0.5)';
        palette.heatGlow = ['rgba(255, 70, 40, 0.3)', 'rgba(255, 70, 40, 0)'];
        palette.coolGlow = ['rgba(40, 140, 255, 0.3)', 'rgba(40, 140, 255, 0)'];
        palette.heatRing = light ? 'rgba(210, 60, 20, 0.6)' : 'rgba(255, 120, 80, 0.6)';
        palette.coolRing = light ? 'rgba(20, 100, 210, 0.6)' : 'rgba(90, 170, 255, 0.6)';

        // The legend under the canvas shows the same colour scale as the atoms.
        if (legendBar) {
            const stops = [];
            for (let k = 0; k <= 6; k++) stops.push(palette.atoms[Math.round(k / 6 * COLOUR_LEVELS)]);
            legendBar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
        }
    }
    buildPalette();
    new MutationObserver(buildPalette).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // --- Rendering ---
    function updateScreenPositions() {
        for (let i = 0; i < count; i++) {
            sx[i] = offsetX + (gx[i] + ux[i]) * spacing;
            sy[i] = offsetY + (gy[i] + uy[i]) * spacing;
        }
    }

    function render() {
        const scaleX = canvas.width / viewW, scaleY = canvas.height / viewH;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

        // Soft glow showing where the heating/cooling brush acts (Gaussian; it
        // fades out at 2 sigma, the brush radius)
        const reach = 2 * brushSigmaPx();
        if (activeTool !== TOOL_NONE) {
            const glow = activeTool === TOOL_HEAT ? palette.heatGlow : palette.coolGlow;
            for (const p of brushPoints) {
                const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, reach);
                gradient.addColorStop(0, glow[0]);
                gradient.addColorStop(1, glow[1]);
                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.arc(p.x, p.y, reach, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Springs, as a single path (a little thicker on big canvases)
        ctx.beginPath();
        for (let s = 0; s < springCount; s++) {
            const a = springA[s], b = springB[s];
            ctx.moveTo(sx[a], sy[a]);
            ctx.lineTo(sx[b], sy[b]);
        }
        ctx.strokeStyle = palette.spring;
        ctx.lineWidth = Math.min(1.5, Math.max(1, spacing / 50));
        ctx.stroke();

        // Atoms, batched by colour (counting sort on colour level)
        levelCounts.fill(0);
        for (let i = 0; i < count; i++) levelCounts[colourLevel[i] + 1]++;
        for (let l = 1; l < levelCounts.length; l++) levelCounts[l] += levelCounts[l - 1];
        for (let i = 0; i < count; i++) drawOrder[levelCounts[colourLevel[i]]++] = i;

        const r = Math.max(1, spacing / PARTICLE_RADIUS_SCALE_FACTOR);
        let start = 0;
        while (start < count) {
            const level = colourLevel[drawOrder[start]];
            let end = start;
            ctx.beginPath();
            while (end < count && colourLevel[drawOrder[end]] === level) {
                const i = drawOrder[end];
                ctx.moveTo(sx[i] + r, sy[i]);
                ctx.arc(sx[i], sy[i], r, 0, Math.PI * 2);
                end++;
            }
            ctx.fillStyle = palette.atoms[level];
            ctx.fill();
            start = end;
        }

        // Outline of the brush under an idle mouse, in the colour of the current mode
        if (hoverPoint && activeTool === TOOL_NONE) {
            ctx.beginPath();
            ctx.arc(hoverPoint.x, hoverPoint.y, reach, 0, Math.PI * 2);
            ctx.strokeStyle = toolMode === TOOL_COOL ? palette.coolRing : palette.heatRing;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
    }

    let lastReadoutText = '';
    let lastReadoutTime = -Infinity;
    function updateReadout(timestamp) {
        if (!temperatureVal || timestamp - lastReadoutTime < 100) return;
        lastReadoutTime = timestamp;
        // Whole kelvin: the readout reserves 4 digits, which covers everything short of
        // heating the whole lattice for a long time
        const text = Math.round(averageTemperatureK()).toString();
        if (text !== lastReadoutText) {
            temperatureVal.textContent = text;
            lastReadoutText = text;
        }
    }

    // FPS counter (shown with the 'F' key by simulation_ui.js)
    let fpsFrames = 0;
    let fpsWindowStart = null;
    function updateFps(timestamp) {
        if (!fpsDisplay) return;
        if (fpsWindowStart === null) fpsWindowStart = timestamp;
        fpsFrames++;
        const elapsed = timestamp - fpsWindowStart;
        if (elapsed >= 500) {
            fpsDisplay.textContent = `FPS: ${Math.round(fpsFrames * 1000 / elapsed)}`;
            fpsFrames = 0;
            fpsWindowStart = timestamp;
        }
    }

    // --- Main loop ---
    let lastTimestamp = null;
    function animate(timestamp) {
        if ((window.devicePixelRatio || 1) !== pixelRatio) layoutDirty = true;
        if (layoutDirty) layoutCanvas();

        let frameMs = lastTimestamp === null ? REFERENCE_FRAME_MS : timestamp - lastTimestamp;
        lastTimestamp = timestamp;
        frameMs = Math.min(Math.max(frameMs, 0), MAX_FRAME_MS);

        updateScreenPositions();
        applyTool(frameMs);
        advancePhysics(frameMs);
        computeEnergies();
        updateColours(frameMs);
        updateScreenPositions();
        render();
        updateReadout(timestamp);
        updateFps(timestamp);

        requestAnimationFrame(animate);
    }

    // --- Controls ---
    if (timeSlider && timeVal) {
        timeSlider.addEventListener('input', () => {
            timeScale = parseFloat(timeSlider.value);
            timeVal.textContent = timeScale;
        });
        timeVal.textContent = timeSlider.value;
    }
    if (radiusSlider && radiusVal) {
        radiusSlider.addEventListener('input', () => {
            heatRadius = parseFloat(radiusSlider.value);
            radiusVal.textContent = heatRadius.toFixed(1);
        });
        heatRadius = parseFloat(radiusSlider.value);
        radiusVal.textContent = heatRadius.toFixed(1);
    }
    if (heatAmpSlider && ampVal) {
        heatAmpSlider.addEventListener('input', () => {
            heatAmp = parseFloat(heatAmpSlider.value);
            ampVal.textContent = heatAmp.toFixed(1);
        });
        ampVal.textContent = parseFloat(heatAmpSlider.value).toFixed(1);
    }
    if (springConstantSlider && springConstantVal) {
        springConstantSlider.addEventListener('input', () => {
            kN = parseFloat(springConstantSlider.value);
            springConstantVal.textContent = kN.toFixed(2);
            forcesValid = false;
        });
        springConstantVal.textContent = parseFloat(springConstantSlider.value).toFixed(2);
    }

    function reset() {
        resetLattice();
        lastReadoutTime = -Infinity;
        if (temperatureVal) {
            lastReadoutText = '0';
            temperatureVal.textContent = '0';
        }
    }

    function setGridLayout(layoutName) {
        const layout = PREDEFINED_GRID_LAYOUTS[layoutName];
        if (!layout) {
            console.warn(`Grid layout "${layoutName}" not found.`);
            return;
        }
        cols = layout.cols;
        rows = layout.rows;
        currentGridLayoutName = layoutName;
        setAspectRatioProperty();
        buildLattice();
        reset();
        layoutDirty = true;
        // Let simulation_ui.js reposition its buttons for the new canvas height.
        window.dispatchEvent(new Event('resize'));
    }

    window.conductionSimulation = {
        reset,
        setGridLayout,
        getCurrentGridLayoutName: () => currentGridLayoutName,
        getAvailableGridLayouts: () => PREDEFINED_GRID_LAYOUTS
    };

    if (resetButton) resetButton.addEventListener('click', reset);

    if (gridLayoutSelector) {
        for (const layoutName in PREDEFINED_GRID_LAYOUTS) {
            const layout = PREDEFINED_GRID_LAYOUTS[layoutName];
            const option = document.createElement('option');
            option.value = layoutName;
            option.textContent = `${layout.cols} × ${layout.rows}`;
            gridLayoutSelector.appendChild(option);
        }
        gridLayoutSelector.value = currentGridLayoutName;
        gridLayoutSelector.addEventListener('change', (event) => setGridLayout(event.target.value));
    }

    // --- Start ---
    setAspectRatioProperty();
    buildLattice();
    reset();
    layoutCanvas();
    updateScreenPositions();
    requestAnimationFrame(animate);
})();
