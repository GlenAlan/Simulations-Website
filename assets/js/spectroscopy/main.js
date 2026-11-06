// Starts the simulation. Each piece is started inside its own try/catch, so that one failing piece shows up
// in the console without taking the rest of the page down. Tracks fill in their own files; this list is fixed.

import { app, bus, select } from './core/state.js';
import { generateUniverse } from './data/universe.js';
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

function boot() {
    const canvas = document.getElementById('simulationCanvas');
    app.universe = generateUniverse();
    app.engine = createEngine(canvas);
    createDrawer();

    const engine = app.engine;
    [
        ['background', createBackgroundLayer],
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
    ].forEach(([name, create]) => {
        const layer = attempt(`layer: ${name}`, () => create(engine, app));
        if (layer) engine.addLayer(layer);
    });

    attempt('system view', () => initSystemView(app));
    attempt('shell', () => initShell(app));
    attempt('overview tab', () => initOverviewTab(app));
    attempt('spectrum tab', () => initSpectrumTab(app));
    attempt('H-R tab', () => initHRTab(app));
    attempt('Hubble tab', () => initHubbleTab(app));
    attempt('go to', () => initGoto(app));
    attempt('keyboard', () => initKeyboard(app));

    // Clicking the sky selects what's under the pointer; clicking empty sky leaves the selection alone
    bus.on('skyclick', ({ code }) => { if (code) select(code); });

    // For tests and the browser console
    window.__spectro = { app, bus, select };

    engine.start();
    bus.emit('ready', {});
}

// Modules run before DOMContentLoaded: wait for it, so simulation_ui.js has set the panel and buttons up first
if (document.readyState === 'complete') boot();
else document.addEventListener('DOMContentLoaded', boot, { once: true });
