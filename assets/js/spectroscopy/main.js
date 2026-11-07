// Starts the simulation. Each piece is started inside its own try/catch, so that one failing piece shows up
// in the console without taking the rest of the page down. Tracks fill in their own files; this list is fixed.

import { app, bus, select } from './core/state.js';
import { generateUniverse } from './data/universe.js';
import { seedFromPage } from './core/seed.js';
import { assignDepths } from './core/depth.js';
import { createEngine } from './render/engine.js';
import { createDrawer } from './ui/drawer.js';

import { createBackgroundLayer } from './render/layers/background.js';
import { createBandSkyLayer } from './render/layers/band_sky.js';
import { createNebulaeLayer } from './render/layers/nebulae.js';
import { createSupernovaeLayer } from './render/layers/supernovae.js';
import { createGalaxiesLayer } from './render/layers/galaxies.js';
import { createClustersLayer } from './render/layers/clusters.js';
import { createStarsLayer } from './render/layers/stars.js';
import { createQuasarsLayer } from './render/layers/quasars.js';
import { createBlackHolesLayer } from './render/layers/black_holes.js';
import { createNeutronStarsLayer } from './render/layers/neutron_stars.js';
import { createCometsLayer } from './render/layers/comets.js';
import { createBinariesLayer } from './render/layers/binaries.js';
import { createRoguePlanetsLayer } from './render/layers/rogue_planets.js';
import { createHomePlanetsLayer } from './render/layers/home_planets.js';
import { createOverlaysLayer } from './render/layers/overlays.js';

import { initSystemView } from './render/system/system_view.js';
import { initShell } from './ui/shell.js';
import { initOverviewTab } from './ui/overview.js';
import { initSpectrumTab } from './ui/spectrum/panel.js';
import { initHRTab } from './ui/hr.js';
import { initHubbleTab } from './ui/hubble.js';
import { initInfoTab } from './ui/info_tab.js';
import { initSkyHints } from './ui/sky_hints.js';
import { initGoto } from './ui/goto.js';
import { initKeyboard } from './ui/keyboard.js';

function attempt(name, fn) {
    try {
        return fn();
    } catch (err) {
        console.error(`[spectroscopy] ${name} failed to start:`, err);
        return null;
    }
}

const FIRST_FRAME_WAIT_MS = 500;

// Lets the browser draw and answer the pointer before more is started, if a bit of this has run on for long enough
const SLICE_MS = 12;
let sliceStart = 0;

function breathe() {
    if (performance.now() - sliceStart < SLICE_MS) return null;
    return new Promise((resolve) => {
        const go = () => {
            sliceStart = performance.now();
            resolve();
        };
        if (document.hidden) setTimeout(go, 0); // A hidden tab has no frames to wait for
        else requestAnimationFrame(() => setTimeout(go, 0));
    });
}

// The sky is drawn and can be dragged before anything else is started. Everything after it joins as it becomes ready.
async function boot() {
    sliceStart = performance.now();
    const canvas = document.getElementById('simulationCanvas');
    app.engine = createEngine(canvas);
    createDrawer();

    const engine = app.engine;
    const addLayer = (name, create) => {
        const layer = attempt(`layer: ${name}`, () => create(engine, app));
        if (layer) engine.addLayer(layer);
    };

    // First the page's own controls, which also give the canvas its final size, so that nothing jumps once the sky is up
    attempt('shell', () => initShell(app));
    engine.resize();
    addLayer('background', createBackgroundLayer);
    engine.start();
    // Building the universe is the one long job here: let the sky appear first
    await Promise.race([engine.firstFrame, new Promise((resolve) => setTimeout(resolve, FIRST_FRAME_WAIT_MS))]);
    sliceStart = 0;
    await breathe();    // And that frame has to reach the screen

    app.universe = generateUniverse(seedFromPage());   // ?seed=... in the address, or the standard sky
    assignDepths(app.universe);
    await breathe();

    const layers = [
        ['band sky', createBandSkyLayer],
        ['nebulae', createNebulaeLayer],
        ['supernovae', createSupernovaeLayer],
        ['galaxies', createGalaxiesLayer],
        ['clusters', createClustersLayer],
        ['stars', createStarsLayer],
        ['quasars', createQuasarsLayer],
        ['black holes', createBlackHolesLayer],
        ['neutron stars', createNeutronStarsLayer],
        ['comets', createCometsLayer],
        ['binaries', createBinariesLayer],
        ['rogue planets', createRoguePlanetsLayer],
        ['home planets', createHomePlanetsLayer],
        ['overlays', createOverlaysLayer]
    ];
    for (const [name, create] of layers) {
        addLayer(name, create);
        await breathe();
    }

    const inits = [
        ['system view', initSystemView],
        ['overview tab', initOverviewTab],
        ['spectrum tab', initSpectrumTab],
        ['H-R tab', initHRTab],
        ['Hubble tab', initHubbleTab],
        ['info tab', initInfoTab],
        ['sky hints', initSkyHints],
        ['go to', initGoto],
        ['keyboard', initKeyboard]
    ];
    for (const [name, init] of inits) {
        attempt(name, () => init(app));
        await breathe();
    }

    // Clicking the sky selects what's under the pointer; clicking empty sky leaves the selection alone
    bus.on('skyclick', ({ code }) => { if (code) select(code); });

    // For tests and the browser console
    window.__spectro = { app, bus, select };

    bus.emit('ready', {});
}

// Modules run before DOMContentLoaded: wait for it, so simulation_ui.js has set the panel and buttons up first
if (document.readyState === 'complete') boot();
else document.addEventListener('DOMContentLoaded', boot, { once: true });
