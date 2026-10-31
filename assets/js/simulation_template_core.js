// Simulation core template: copy to assets/js/<name>_core.js, rename window.simulationTemplate and fill in the TODOs.
// It runs as a placeholder (particles bouncing in a box) so the page works straight away.
//
// Conventions (layout details are at the top of assets/css/simulation_styles.css):
// - CSS sizes the canvas: anything from ~320 to ~1900 CSS px wide, with the page's --aspect-ratio, in normal and
//   fullscreen mode alike. Don't set the canvas or its box size here; size the drawing buffer from the canvas's
//   CSS size x devicePixelRatio and redraw when it changes (ResizeObserver).
// - Draw in CSS pixels (ctx.setTransform(dpr, ...)) and keep text and line widths in CSS px with clamps, so they stay
//   readable at every canvas size instead of growing with it.
// - Readouts: <span class="sim-value" style="--chars: N"> in the HTML, fixed-width formatting here (toFixed), so
//   changing numbers never move anything. Numbers drawn on the canvas: anchor them (e.g. right-align at a fixed x).
// - Exactly one requestAnimationFrame loop; reset changes state, it doesn't start another loop.
// - Canvas input through pointer events (mouse, pen and touch alike).
(function () {
    'use strict';

    const canvas = document.getElementById('simulationCanvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (!canvas || !ctx) {
        console.error('Simulation canvas not found.');
        return;
    }

    // --- Controls (ids from simulation_template.html) ---
    const $ = (id) => document.getElementById(id);
    const speedSlider = $('speedSlider');
    const speedVal = $('speedVal');
    const param1Slider = $('param1Slider');
    const param1Val = $('param1Val');
    const param2Slider = $('param2Slider');
    const param2Val = $('param2Val');
    const modeSelector = $('modeSelector');
    const showLabelsToggle = $('showLabelsToggle');
    const resetButton = $('resetSimulationBtn');
    const showChartsToggle = $('showCharts');
    const chartsContainer = $('charts-container');
    const fpsDisplay = $('fpsDisplay');
    const stat1El = $('stat1');
    const stat2El = $('stat2');

    // --- Settings ---
    const settings = {
        speed: speedSlider ? parseFloat(speedSlider.value) : 1,
        count: param1Slider ? parseInt(param1Slider.value, 10) : 40,
        radius: param2Slider ? parseFloat(param2Slider.value) : 6, // CSS px
        mode: modeSelector ? modeSelector.value : 'mode1',
        showLabels: showLabelsToggle ? showLabelsToggle.checked : false,
    };

    // --- State ---
    // Positions are stored as fractions of the canvas size, so a resize needs no special handling.
    let particles = [];
    let viewW = 0; // Canvas size in CSS px
    let viewH = 0;
    let dpr = 1;
    let simTime = 0; // Simulated seconds

    function randomParticle() {
        const angle = Math.random() * Math.PI * 2;
        const speed = 0.08 + Math.random() * 0.12; // Canvas widths per second
        return { x: Math.random(), y: Math.random(), vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
    }

    // TODO: set up the simulation's initial state (called on start and reset).
    function initializeSimulationState() {
        particles = [];
        for (let i = 0; i < settings.count; i++) particles.push(randomParticle());
        simTime = 0;
        resetCharts();
    }

    // TODO: advance the simulation by dt seconds.
    function step(dt) {
        const aspect = viewW > 0 && viewH > 0 ? viewW / viewH : 2;
        for (const p of particles) {
            p.x += p.vx * dt;
            p.y += p.vy * dt * aspect; // Same speed in px horizontally and vertically
            if (p.x < 0) { p.x = -p.x; p.vx = Math.abs(p.vx); }
            if (p.x > 1) { p.x = 2 - p.x; p.vx = -Math.abs(p.vx); }
            if (p.y < 0) { p.y = -p.y; p.vy = Math.abs(p.vy); }
            if (p.y > 1) { p.y = 2 - p.y; p.vy = -Math.abs(p.vy); }
        }
        simTime += dt;
    }

    // --- Theme ---
    function isDarkMode() {
        return document.documentElement.classList.contains('dark-mode');
    }

    // --- Rendering (in CSS px) ---
    // TODO: draw the simulation.
    function render() {
        if (viewW === 0 || viewH === 0) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const dark = isDarkMode();
        ctx.fillStyle = dark ? '#16181c' : '#f4f6f8';
        ctx.fillRect(0, 0, viewW, viewH);

        ctx.fillStyle = settings.mode === 'mode1' ? '#f2849e' : '#7ecaf6';
        for (const p of particles) {
            ctx.beginPath();
            ctx.arc(p.x * viewW, p.y * viewH, settings.radius, 0, Math.PI * 2);
            ctx.fill();
        }

        if (settings.showLabels) {
            // Text size in CSS px with a clamp: readable on phones, not huge on large screens.
            const fontPx = Math.max(11, Math.min(15, viewW / 60));
            ctx.font = `${fontPx}px "Source Sans Pro", Helvetica, sans-serif`;
            ctx.fillStyle = dark ? '#e0e0e0' : '#585858';
            ctx.textBaseline = 'top';
            ctx.textAlign = 'right'; // Right-aligned at a fixed x: changing digits don't shift the label
            ctx.fillText(`t = ${simTime.toFixed(1)} s`, viewW - 10, 10);
            ctx.textAlign = 'left';
        }
    }

    // --- Readouts (fixed-width formatting to match --chars in the HTML) ---
    function averageSpeedPx() {
        if (particles.length === 0) return 0;
        let sum = 0;
        for (const p of particles) sum += Math.hypot(p.vx * viewW, p.vy * viewW);
        return sum / particles.length;
    }

    function updateReadouts() {
        if (stat1El) stat1El.textContent = Math.min(999.9, averageSpeedPx()).toFixed(1);
        if (stat2El) stat2El.textContent = String(particles.length);
    }

    // --- Canvas sizing: drawing buffer = CSS size x devicePixelRatio ---
    function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        const w = Math.max(1, Math.round(rect.width));
        const h = Math.max(1, Math.round(rect.height));
        const newDpr = Math.min(2, window.devicePixelRatio || 1); // Capped at 2 to limit fill cost
        if (w === viewW && h === viewH && newDpr === dpr) return;
        viewW = w;
        viewH = h;
        dpr = newDpr;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        render(); // Resizing clears the canvas: redraw at once rather than waiting for the next frame
    }

    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(resizeCanvas).observe(canvas);
    }
    window.addEventListener('resize', resizeCanvas);

    // --- Pointer input (mouse, pen and touch) ---
    // TODO: replace with the simulation's interaction. The canvas has touch-action: none (shared CSS), so drags
    // don't scroll the page; set touch-action: auto on the canvas in page CSS if it takes no drags.
    canvas.addEventListener('pointerdown', (e) => {
        const rect = canvas.getBoundingClientRect();
        const p = randomParticle();
        p.x = (e.clientX - rect.left) / rect.width;
        p.y = (e.clientY - rect.top) / rect.height;
        if (particles.length < 300) particles.push(p);
        updateReadouts();
    });

    // --- Charts (optional; needs Chart.js in the head) ---
    let charts = null;
    let lastChartSample = 0;

    function chartColors() {
        const dark = isDarkMode();
        return { text: dark ? '#e0e0e0' : '#585858', grid: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' };
    }

    function makeChart(canvasId, label, color) {
        const el = $(canvasId);
        if (!el || typeof Chart === 'undefined') return null;
        const c = chartColors();
        return new Chart(el, {
            type: 'line',
            data: { labels: [], datasets: [{ label, data: [], borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.2 }] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: { legend: { labels: { color: c.text } } },
                scales: {
                    x: { ticks: { color: c.text, maxTicksLimit: 6 }, grid: { color: c.grid }, title: { display: true, text: 'Time (s)', color: c.text } },
                    y: { ticks: { color: c.text }, grid: { color: c.grid } },
                },
            },
        });
    }

    function setChartsVisible(visible) {
        if (!chartsContainer) return;
        chartsContainer.style.display = visible ? 'block' : 'none';
        document.body.classList.toggle('charts-visible', visible);
        if (visible && !charts) {
            charts = [makeChart('chart1', 'Avg. speed (px/s)', '#f2849e'), makeChart('chart2', 'Particles', '#7ecaf6')];
        }
    }

    function resetCharts() {
        lastChartSample = 0;
        if (!charts) return;
        charts.forEach((chart) => {
            if (!chart) return;
            chart.data.labels = [];
            chart.data.datasets[0].data = [];
            chart.update('none');
        });
    }

    function sampleCharts() {
        if (!charts || !chartsContainer || chartsContainer.style.display === 'none') return;
        if (simTime - lastChartSample < 0.5) return;
        lastChartSample = simTime;
        const values = [averageSpeedPx(), particles.length];
        charts.forEach((chart, i) => {
            if (!chart) return;
            chart.data.labels.push(simTime.toFixed(1));
            chart.data.datasets[0].data.push(values[i]);
            if (chart.data.labels.length > 120) {
                chart.data.labels.shift();
                chart.data.datasets[0].data.shift();
            }
            chart.update('none');
        });
    }

    // Recolour the charts when the light/dark theme changes.
    new MutationObserver(() => {
        if (!charts) return;
        const c = chartColors();
        charts.forEach((chart) => {
            if (!chart) return;
            chart.options.plugins.legend.labels.color = c.text;
            ['x', 'y'].forEach((axis) => {
                chart.options.scales[axis].ticks.color = c.text;
                chart.options.scales[axis].grid.color = c.grid;
                if (chart.options.scales[axis].title) chart.options.scales[axis].title.color = c.text;
            });
            chart.update('none');
        });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // --- Control wiring ---
    function bindSlider(slider, output, apply, format) {
        if (!slider) return;
        const update = () => {
            const value = parseFloat(slider.value);
            apply(value);
            if (output) output.textContent = format(value);
        };
        slider.addEventListener('input', update);
        update();
    }

    bindSlider(speedSlider, speedVal, (v) => { settings.speed = v; }, (v) => v.toFixed(1));
    bindSlider(param1Slider, param1Val, (v) => {
        settings.count = Math.round(v);
        while (particles.length < settings.count) particles.push(randomParticle());
        particles.length = settings.count;
    }, (v) => String(Math.round(v)));
    bindSlider(param2Slider, param2Val, (v) => { settings.radius = v; }, (v) => String(Math.round(v)));

    if (modeSelector) modeSelector.addEventListener('change', () => { settings.mode = modeSelector.value; });
    if (showLabelsToggle) showLabelsToggle.addEventListener('change', () => { settings.showLabels = showLabelsToggle.checked; });
    if (showChartsToggle) {
        showChartsToggle.addEventListener('change', () => setChartsVisible(showChartsToggle.checked));
        setChartsVisible(showChartsToggle.checked);
    }

    // --- Main loop (exactly one) ---
    const MAX_FRAME_DT = 0.1; // s; avoids a huge step after the tab was hidden
    let lastTimestamp = 0;
    let fpsFrames = 0;
    let fpsTime = 0;

    function frame(timestamp) {
        const dt = lastTimestamp ? Math.min(MAX_FRAME_DT, (timestamp - lastTimestamp) / 1000) : 0;
        lastTimestamp = timestamp;

        step(dt * settings.speed);
        render();
        updateReadouts();
        sampleCharts();

        if (fpsDisplay) {
            fpsFrames++;
            fpsTime += dt;
            if (fpsTime >= 0.5) {
                fpsDisplay.textContent = `FPS: ${Math.round(fpsFrames / fpsTime)}`;
                fpsFrames = 0;
                fpsTime = 0;
            }
        }
        requestAnimationFrame(frame);
    }

    // --- Public API (used by the reset button; handy for testing) ---
    window.simulationTemplate = {
        reset() {
            initializeSimulationState();
            lastTimestamp = 0;
            render();
            updateReadouts();
        },
    };

    if (resetButton) resetButton.addEventListener('click', () => window.simulationTemplate.reset());

    // --- Start ---
    resizeCanvas();
    initializeSimulationState();
    updateReadouts();
    requestAnimationFrame(frame);
})();
