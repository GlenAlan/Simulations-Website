// Conduction simulation core.
//
// Model: a 2D lattice of atoms (unit mass). Each atom is held near its lattice
// site by a weak on-site spring and is joined to its 8 neighbours (orthogonal
// and diagonal) by Hookean springs. Heating gives atoms random velocity kicks;
// the springs then pass that vibrational energy from atom to atom, which is how
// heat is conducted through a solid. Between heating and cooling the total
// energy is conserved (velocity-Verlet integration).
//
// The physics runs in lattice units (spacing = 1), so the dynamics, colours and
// temperature do not depend on the size of the canvas. Positions are scaled to
// CSS pixels only for drawing and for the heating/cooling brush.
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
    const resetButton = document.getElementById('resetSimulationBtn');
    const gridLayoutSelector = document.getElementById('gridLayoutSelector');
    const aspectRatioBox = canvas.parentElement;                              // .sim-aspect-ratio-box
    const canvasWrapper = aspectRatioBox ? aspectRatioBox.parentElement : null; // .sim-canvas-wrapper

    // --- Layout (CSS pixels) ---
    const MARGIN = 25;                       // gap between the outer atoms and the canvas edge
    const MIN_SPACING = 1;
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
    const MAX_HEAT_ENERGY = 30 * HOT_ENERGY; // heating fades out here (amplitude ~20% of spacing)
    const COLOUR_SMOOTHING_S = 0.2;          // time constant of the colour smoothing
    const COLOUR_LEVELS = 120;               // hue steps from blue (cold) to red (hot)

    const PREDEFINED_GRID_LAYOUTS = {
        "default": { cols: 20, rows: 10 },
        "small": { cols: 10, rows: 5 },
        "large": { cols: 40, rows: 20 },
        "wide": { cols: 30, rows: 5 },
        "square_medium": { cols: 15, rows: 15 },
        "large_square": { cols: 25, rows: 25 }
    };
    let currentGridLayoutName = "default";
    let cols = PREDEFINED_GRID_LAYOUTS.default.cols;
    let rows = PREDEFINED_GRID_LAYOUTS.default.rows;

    // Parameters from the controls
    let timeScale = timeSlider ? parseFloat(timeSlider.value) : 25;
    let heatRadius = radiusSlider ? parseFloat(radiusSlider.value) : 25;   // CSS px
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
        let sX, sY;
        if (cols > 1) {
            sX = width >= 2 * MARGIN + (cols - 1) * MIN_SPACING
                ? (width - 2 * MARGIN) / (cols - 1)
                : width / (cols - 1);
        } else {
            sX = width;
        }
        if (rows > 1) {
            sY = height >= 2 * MARGIN + (rows - 1) * MIN_SPACING
                ? (height - 2 * MARGIN) / (rows - 1)
                : height / (rows - 1);
        } else {
            sY = height;
        }
        const s = Math.max(MIN_SPACING, (cols <= 1 || rows <= 1) ? Math.max(sX, sY) : Math.min(sX, sY));
        const gridWidth = cols > 1 ? (cols - 1) * s : 0;
        const gridHeight = rows > 1 ? (rows - 1) * s : 0;
        return { spacing: s, offsetX: (width - gridWidth) / 2, offsetY: (height - gridHeight) / 2 };
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

    // --- Heating / cooling ---
    let heating = false, cooling = false, mX = 0, mY = 0;

    function applyTool(frameMs) {
        if (!heating && !cooling) return;
        const frameScale = frameMs / REFERENCE_FRAME_MS;
        const inv2R2 = 1 / (2 * heatRadius * heatRadius);
        const reach2 = 16 * heatRadius * heatRadius; // ignore atoms beyond 4 sigma
        if (heating) {
            const kick = HEAT_KICK * heatAmp * Math.sqrt(frameScale); // random walk: energy grows with time
            for (let i = 0; i < count; i++) {
                const dx = sx[i] - mX, dy = sy[i] - mY;
                const r2 = dx * dx + dy * dy;
                if (r2 > reach2) continue;
                const headroom = 1 - energy[i] / MAX_HEAT_ENERGY;
                if (headroom <= 0) continue;
                const dv = kick * Math.exp(-r2 * inv2R2) * headroom;
                vx[i] += (Math.random() * 2 - 1) * dv;
                vy[i] += (Math.random() * 2 - 1) * dv;
            }
        } else {
            for (let i = 0; i < count; i++) {
                const dx = sx[i] - mX, dy = sy[i] - mY;
                const r2 = dx * dx + dy * dy;
                if (r2 > reach2) continue;
                const damping = Math.min(COOL_RATE, heatAmp * COOL_RATE * Math.exp(-r2 * inv2R2));
                const keep = Math.pow(1 - damping, frameScale);
                vx[i] *= keep;
                vy[i] *= keep;
            }
        }
    }

    // Event Listeners for UI
    // Left-click for heating
    canvas.addEventListener('mousedown', (e) => {
        if (e.button === 0) { // Left mouse button
            heating = true;
            cooling = false;
            updateMousePosition(e);
        }
    });
    canvas.addEventListener('mouseup', (e) => {
        if (e.button === 0) { // Left mouse button
            heating = false;
        }
    });

    // Right-click for cooling
    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault(); // Prevent context menu from appearing
        cooling = true;
        heating = false;
        updateMousePosition(e);
        return false;
    });

    canvas.addEventListener('mousedown', (e) => {
        if (e.button === 2) { // Right mouse button
            cooling = true;
            heating = false;
            updateMousePosition(e);
        }
    });

    canvas.addEventListener('mouseup', (e) => {
        if (e.button === 2) { // Right mouse button
            cooling = false;
        }
    });

    canvas.addEventListener('mouseleave', () => {
        heating = false;
        cooling = false;
    });

    canvas.addEventListener('mousemove', (e) => {
        if (heating || cooling) updateMousePosition(e);
    });

    // Touch events for mobile
    canvas.addEventListener('touchstart', (e) => {
        heating = true; // Default to heating for touch events
        cooling = false;
        updateMousePosition(e);
        e.preventDefault(); // Prevent scrolling/default touch actions
    }, { passive: false });

    canvas.addEventListener('touchend', () => {
        heating = false;
        cooling = false;
    });

    canvas.addEventListener('touchcancel', () => {
        heating = false;
        cooling = false;
    });

    canvas.addEventListener('touchmove', (e) => {
        if (heating || cooling) {
            updateMousePosition(e);
            e.preventDefault();
        }
    }, { passive: false });

    function updateMousePosition(e) {
        const r = canvas.getBoundingClientRect();
        let clientX, clientY;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }
        mX = clientX - r.left;
        mY = clientY - r.top;
    }

    // --- Canvas sizing ---
    // Sizes the canvas backing store to its displayed size times devicePixelRatio
    // (crisp on high-DPI screens). In fullscreen the aspect-ratio box is given an
    // explicit size that fits the wrapper; otherwise CSS sizes it.
    function layoutCanvas() {
        layoutDirty = false;
        if (aspectRatioBox && canvasWrapper) {
            if (document.body.classList.contains('sim-fullscreen-active')) {
                const aspect = cols / rows;
                const borderX = aspectRatioBox.offsetWidth - aspectRatioBox.clientWidth;
                const borderY = aspectRatioBox.offsetHeight - aspectRatioBox.clientHeight;
                const availW = canvasWrapper.clientWidth - borderX;
                const availH = canvasWrapper.clientHeight - borderY;
                if (availW > 0 && availH > 0) {
                    let w = availW, h = availW / aspect;
                    if (h > availH) { h = availH; w = availH * aspect; }
                    const boxW = `${Math.floor(w) + borderX}px`;
                    const boxH = `${Math.floor(h) + borderY}px`;
                    if (aspectRatioBox.style.width !== boxW) aspectRatioBox.style.width = boxW;
                    if (aspectRatioBox.style.height !== boxH) aspectRatioBox.style.height = boxH;
                }
            } else if (aspectRatioBox.style.width || aspectRatioBox.style.height) {
                aspectRatioBox.style.width = '';
                aspectRatioBox.style.height = '';
            }
        }

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
        // A plain number (not "a/b") so it can be used as a divisor in CSS calc().
        // Also set on the wrapper, whose fullscreen size is computed from it.
        const value = String(cols / rows);
        if (aspectRatioBox) aspectRatioBox.style.setProperty('--aspect-ratio', value);
        if (canvasWrapper) canvasWrapper.style.setProperty('--aspect-ratio', value);
    }

    const markLayoutDirty = () => { layoutDirty = true; };
    window.addEventListener('resize', markLayoutDirty);
    if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(markLayoutDirty);
        if (canvasWrapper) ro.observe(canvasWrapper);
        if (aspectRatioBox) ro.observe(aspectRatioBox);
    }
    // Fullscreen / panel state is toggled through body classes.
    new MutationObserver(markLayoutDirty).observe(document.body, { attributes: true, attributeFilter: ['class'] });

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

        // Springs, as a single path
        ctx.beginPath();
        for (let s = 0; s < springCount; s++) {
            const a = springA[s], b = springB[s];
            ctx.moveTo(sx[a], sy[a]);
            ctx.lineTo(sx[b], sy[b]);
        }
        ctx.strokeStyle = 'rgba(100, 100, 100, 0.5)';
        ctx.lineWidth = 1;
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
            ctx.fillStyle = `hsl(${(1 - level / COLOUR_LEVELS) * 240}, 100%, 50%)`;
            ctx.fill();
            start = end;
        }
    }

    let lastReadoutText = '';
    let lastReadoutTime = -Infinity;
    function updateReadout(timestamp) {
        if (!temperatureVal || timestamp - lastReadoutTime < 100) return;
        lastReadoutTime = timestamp;
        const text = Math.round(averageTemperatureK()).toString();
        if (text !== lastReadoutText) {
            temperatureVal.textContent = text;
            lastReadoutText = text;
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
            radiusVal.textContent = heatRadius;
        });
        radiusVal.textContent = radiusSlider.value;
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
            const pretty = layoutName.replace(/_/g, ' ');
            option.textContent = `${pretty.charAt(0).toUpperCase() + pretty.slice(1)} (${layout.cols}x${layout.rows})`;
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
