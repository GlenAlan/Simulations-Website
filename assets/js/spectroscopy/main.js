// Loads the simulation (boot.js and everything it imports) and starts it. Everything comes in through the one dynamic
// import below, so that if any file fails to load (a dropped connection, a blocked file, or a browser holding an old copy
// of one file beside new ones after an update) the student is told to reload, rather than left with a black box. A
// failure in a static import can't be caught; this can. The page shows the same message if this file itself fails.

// The message is in the page, hidden (#spectroLoadFailed). An older copy of the page may not have it, so it can be made here.
const FAILED_TEXT = "The simulation didn't load properly. Please reload the page: press Ctrl+Shift+R (Cmd+Shift+R on a Mac).";
const FAILED_STYLE = 'position:absolute;inset:0;z-index:5;padding:2em 1.5em;background:#05070d;color:#e6e9f2;text-align:center;';

function showLoadFailure(err) {
    console.error('[spectroscopy] The simulation could not load:', err);
    let box = document.getElementById('spectroLoadFailed');
    if (!box) {
        const canvas = document.getElementById('simulationCanvas');
        if (!canvas || !canvas.parentElement) return;
        box = document.createElement('div');
        box.id = 'spectroLoadFailed';
        box.className = 'spectro-load-failed';
        box.setAttribute('role', 'alert');
        box.style.cssText = FAILED_STYLE;
        const words = document.createElement('p');
        words.textContent = FAILED_TEXT;
        const again = document.createElement('button');
        again.type = 'button';
        again.textContent = 'Reload';
        again.style.cssText = 'color:#e6e9f2 !important;box-shadow:inset 0 0 0 2px #e6e9f2;';
        again.addEventListener('click', () => location.reload());
        box.append(words, again);
        canvas.parentElement.appendChild(box);
    }
    box.hidden = false;
}

// Modules run before DOMContentLoaded: wait for it, so simulation_ui.js has set the panel and buttons up first
const pageReady = new Promise((resolve) => {
    if (document.readyState === 'complete') resolve();
    else document.addEventListener('DOMContentLoaded', resolve, { once: true });
});

import('./boot.js').then((loaded) => {
    if (typeof loaded.boot !== 'function') {
        showLoadFailure(new Error('boot.js has no boot()'));
        return null;
    }
    return pageReady.then(() => loaded.boot());
}, showLoadFailure);
