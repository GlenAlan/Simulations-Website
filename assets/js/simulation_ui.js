// Shared UI for the simulation pages: settings panel, fullscreen, layout measurements, FPS counter.
// Layout conventions are described at the top of assets/css/simulation_styles.css.

// The canvas size in simulation_styles.css depends on the page's --aspect-ratio (set on .sim-aspect-ratio-box).
// Copy it up to .simulation-main-content straight away (this script runs at the end of <body>, before the
// deferred simulation scripts), so the canvas has its final size before a simulation first measures it.
(function () {
    const box = document.querySelector('#main > .inner .sim-aspect-ratio-box');
    const mainContent = document.querySelector('#main > .inner .simulation-main-content');
    if (!box || !mainContent) return;
    const ratio = getComputedStyle(box).getPropertyValue('--aspect-ratio').trim();
    if (ratio) mainContent.style.setProperty('--aspect-ratio', ratio);
})();

document.addEventListener('DOMContentLoaded', () => {
    const body = document.body;
    const root = document.documentElement;

    const simPageInner = document.querySelector('#main > .inner');
    if (!simPageInner) return;

    const controlsPanel = simPageInner.querySelector('#simulationControlsPanel');
    const fullscreenToggleBtn = simPageInner.querySelector('.sim-fullscreen-toggle');
    const panelToggleBtn = simPageInner.querySelector('.sim-panel-toggle-button'); // Settings (cog) button
    const simCanvas = simPageInner.querySelector('#simulationCanvas');
    const actionButtonsOverlay = document.querySelector('.sim-action-buttons-overlay');
    const simControlsHeader = controlsPanel ? controlsPanel.querySelector('.sim-controls-header') : null;
    const simInfoBar = simPageInner.querySelector('.sim-info-bar');
    const simAreaWrapper = simPageInner.querySelector('.simulation-area-wrapper');
    const simMainContent = simPageInner.querySelector('.simulation-main-content');
    const displayContainer = simPageInner.querySelector('.simulation-display-container');
    const aspectRatioBox = simPageInner.querySelector('.sim-aspect-ratio-box');
    const canvasWrapper = aspectRatioBox ? aspectRatioBox.parentElement : null; // .sim-canvas-wrapper
    let panelCloseBtnInside; // Close button inside the panel header
    let scrollBeforeFullscreen = 0;

    // Convection grid size selector
    const convectionGridSizeSelector = controlsPanel ? controlsPanel.querySelector('#convectionGridSizeSelector') : null;

    const openPanelIcon = '<span class="icon solid fa-cog"><span class="label">Settings</span></span>';
    const closePanelIcon = '<span class="icon solid fa-times"><span class="label">Close settings</span></span>';

    const fullscreenIconExpand = '<span class="icon solid fa-expand"><span class="label">Enter fullscreen</span></span>';
    const fullscreenIconContract = '<span class="icon solid fa-compress"><span class="label">Exit fullscreen</span></span>';

    // Mirror the page's --aspect-ratio (set on .sim-aspect-ratio-box, possibly changed at run time, or
    // replaced by --aspect-ratio-portrait on phones in portrait) onto the canvas wrapper and
    // .simulation-main-content, which size the canvas area from it.
    function syncAspectRatio() {
        if (!aspectRatioBox) return;
        const ratio = getComputedStyle(aspectRatioBox).getPropertyValue('--aspect-ratio').trim();
        if (!ratio) return;
        [canvasWrapper, simMainContent].forEach((el) => {
            if (el && el.style.getPropertyValue('--aspect-ratio').trim() !== ratio) {
                el.style.setProperty('--aspect-ratio', ratio);
            }
        });
    }

    // Tell the simulation its display area has changed (simulation cores listen for 'resize').
    function notifyLayoutChange() {
        window.dispatchEvent(new Event('resize'));
    }

    // The settings panel docks beside the simulation when there is room for both (wide screens and
    // phones in landscape); otherwise it is a sheet that slides up from the bottom of the screen.
    function panelFitsBeside() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        return w >= 1000 || (w >= 600 && w > h && h <= 600);
    }

    function updatePanelMode() {
        const side = panelFitsBeside();
        body.classList.toggle('sim-panel-side', side);
        body.classList.toggle('sim-panel-sheet', !side);
    }

    // The fullscreen and settings buttons go at the end of the info bar, next to the page's own actions,
    // so they never cover the simulation. Pages without an info bar get them over the canvas's corner.
    function placeActionButtons() {
        if (!actionButtonsOverlay) return;
        if (simInfoBar) {
            let actions = simInfoBar.querySelector('.sim-info-actions');
            if (!actions) {
                actions = document.createElement('div');
                actions.className = 'sim-info-actions';
                Array.from(simInfoBar.children).forEach((el) => {
                    if (el.matches('.sim-reset-button, .sim-show-charts-label, .sim-icon-button')) actions.appendChild(el);
                });
                simInfoBar.appendChild(actions);
            }
            actions.appendChild(actionButtonsOverlay);
        } else if (canvasWrapper) {
            canvasWrapper.appendChild(actionButtonsOverlay);
            actionButtonsOverlay.classList.add('sim-actions-floating');
        }
    }

    function createInternalCloseButton() {
        if (controlsPanel && simControlsHeader && !simControlsHeader.querySelector('.sim-panel-close-button-insIDE')) {
            panelCloseBtnInside = document.createElement('button');
            panelCloseBtnInside.type = 'button';
            panelCloseBtnInside.innerHTML = closePanelIcon;
            panelCloseBtnInside.className = 'sim-panel-close-button-insIDE';
            panelCloseBtnInside.setAttribute('aria-label', 'Close settings');
            panelCloseBtnInside.title = 'Close settings (Esc)';
            simControlsHeader.appendChild(panelCloseBtnInside);

            panelCloseBtnInside.addEventListener('click', (event) => {
                event.stopPropagation();
                closeSettingsPanel();
            });
        }
    }

    // Scroll the page so the simulation (and a docked panel's top) is in view. On narrow screens the
    // sheet covers the lower part of the screen, so the simulation goes in the space above it.
    function revealSimulation() {
        const sheet = body.classList.contains('sim-panel-sheet');
        // Under a sheet only the canvas needs to show; beside a docked panel, the info bar too.
        const target = sheet ? (canvasWrapper || displayContainer) : (displayContainer || canvasWrapper);
        if (!target || !controlsPanel) return;
        const targetRect = target.getBoundingClientRect();
        const rect = { top: targetRect.top, bottom: targetRect.bottom };
        if (!sheet) {
            // Docked: bring the panel into view too.
            const panelRect = controlsPanel.getBoundingClientRect();
            rect.top = Math.min(rect.top, panelRect.top);
            rect.bottom = Math.max(rect.bottom, panelRect.bottom);
        }
        const sheetTop = sheet ? window.innerHeight - controlsPanel.offsetHeight : window.innerHeight;
        const margin = 8;
        let delta = 0;
        if (rect.top < margin) {
            delta = rect.top - margin;
        } else if (rect.bottom > sheetTop - margin) {
            delta = Math.min(rect.bottom - (sheetTop - margin), rect.top - margin);
        }
        if (Math.abs(delta) > 2) window.scrollBy({ top: delta, behavior: 'smooth' });
    }

    function openSettingsPanel() {
        if (!controlsPanel) return;
        updatePanelMode();
        controlsPanel.classList.add('panel-open');
        body.classList.add('sim-panel-active');
        if (panelToggleBtn) panelToggleBtn.setAttribute('aria-expanded', 'true');
        updatePositions();
        // Move keyboard focus into the panel.
        if (panelCloseBtnInside) panelCloseBtnInside.focus({ preventScroll: true });
        if (!body.classList.contains('sim-fullscreen-active')) revealSimulation();
        notifyLayoutChange(); // The canvas area shrinks to make room for a docked panel
    }

    function closeSettingsPanel() {
        if (!controlsPanel) return;
        const focusWasInPanel = controlsPanel.contains(document.activeElement);
        controlsPanel.classList.remove('panel-open');
        body.classList.remove('sim-panel-active');
        if (panelToggleBtn) panelToggleBtn.setAttribute('aria-expanded', 'false');
        root.style.removeProperty('--sim-sheet-h');
        updatePositions();
        if (focusWasInPanel && panelToggleBtn) panelToggleBtn.focus({ preventScroll: true });
        notifyLayoutChange();
        // A docked panel fades out before giving its width back to the simulation.
        window.setTimeout(notifyLayoutChange, 260);
    }

    function updateButtonIcons() {
        const isFullscreen = body.classList.contains('sim-fullscreen-active');
        if (fullscreenToggleBtn) {
            fullscreenToggleBtn.innerHTML = isFullscreen ? fullscreenIconContract : fullscreenIconExpand;
            fullscreenToggleBtn.title = isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen';
            fullscreenToggleBtn.setAttribute('aria-pressed', isFullscreen ? 'true' : 'false');
        }
        if (panelToggleBtn) {
            panelToggleBtn.innerHTML = openPanelIcon;
            panelToggleBtn.title = 'Settings';
        }
    }

    // Measure the space above the simulation and under its canvas (simulation_styles.css caps the
    // canvas height so all of it fits on screen). Only changes of 2px or more are applied, so the
    // canvas can't creep by a pixel per frame.
    let fitAbove = -1;
    let fitBelow = -1;
    function measureFit() {
        if (!displayContainer || !canvasWrapper) return;
        const displayRect = displayContainer.getBoundingClientRect();
        const wrapperRect = canvasWrapper.getBoundingClientRect();
        const above = Math.max(0, Math.round(displayRect.top + (window.scrollY || window.pageYOffset || 0)));
        const below = Math.max(0, Math.ceil(displayRect.bottom - wrapperRect.bottom));
        if (Math.abs(above - fitAbove) > 1) {
            fitAbove = above;
            root.style.setProperty('--sim-above-h', `${above}px`);
        }
        if (Math.abs(below - fitBelow) > 1) {
            fitBelow = below;
            root.style.setProperty('--sim-below-h', `${below}px`);
        }
    }

    function updatePositions() {
        syncAspectRatio();
        updatePanelMode();
        const isFullscreen = body.classList.contains('sim-fullscreen-active');

        // In fullscreen the info bar is fixed to the bottom of the screen and can wrap onto
        // several lines on narrow screens; the layout above it uses its height.
        if (isFullscreen && simInfoBar) {
            root.style.setProperty('--sim-fullscreen-info-bar-height', `${simInfoBar.offsetHeight}px`);
        } else {
            root.style.removeProperty('--sim-fullscreen-info-bar-height');
            measureFit();
        }

        if (controlsPanel && controlsPanel.classList.contains('panel-open') && body.classList.contains('sim-panel-sheet')) {
            root.style.setProperty('--sim-sheet-h', `${controlsPanel.offsetHeight}px`);
        }

        // Lets a simulation keep the canvas corner under the buttons clear (only when they are over it).
        const overCanvas = !!(actionButtonsOverlay && actionButtonsOverlay.classList.contains('sim-actions-floating'));
        if (body.classList.contains('sim-buttons-over-canvas') !== overCanvas) {
            body.classList.toggle('sim-buttons-over-canvas', overCanvas);
        }
    }

    let updateQueued = false;
    function queueUpdate() {
        if (updateQueued) return;
        updateQueued = true;
        requestAnimationFrame(() => {
            updateQueued = false;
            updatePositions();
        });
    }

    // Fullscreen fills the browser window; where the browser allows it, the window also goes fullscreen
    // (hiding the browser's own toolbars, which matters most on phones).
    function browserFullscreenElement() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
    }

    function requestBrowserFullscreen() {
        const el = document.documentElement;
        const request = el.requestFullscreen || el.webkitRequestFullscreen;
        if (!request || browserFullscreenElement()) return;
        // Browsers only allow this from a click or key press (not e.g. from a script).
        if (navigator.userActivation && !navigator.userActivation.isActive) return;
        try {
            const result = request.call(el, { navigationUI: 'hide' });
            if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (e) { /* Not allowed here: the in-page fullscreen still works */ }
    }

    function exitBrowserFullscreen() {
        if (!browserFullscreenElement()) return;
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (!exit) return;
        try {
            const result = exit.call(document);
            if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (e) { /* Ignore */ }
    }

    function setFullscreen(enter) {
        if (enter === body.classList.contains('sim-fullscreen-active')) return;
        if (enter) scrollBeforeFullscreen = window.scrollY || window.pageYOffset || 0;
        body.classList.toggle('sim-fullscreen-active', enter);
        // Toggle a class on simInfoBar for fullscreen-specific styling
        if (simInfoBar) simInfoBar.classList.toggle('fullscreen-style', enter);
        updateButtonIcons();
        if (enter) requestBrowserFullscreen(); else exitBrowserFullscreen();
        updatePositions();
        notifyLayoutChange(); // Ensure canvas resizes
        if (!enter) {
            // Return to where the page was before entering fullscreen
            window.scrollTo(0, scrollBeforeFullscreen);
            updatePositions();
        }
    }

    function onBrowserFullscreenChange() {
        // Leaving the browser's fullscreen (e.g. with its own Esc handling) leaves ours too.
        if (!browserFullscreenElement() && body.classList.contains('sim-fullscreen-active')) setFullscreen(false);
    }

    if (panelToggleBtn && controlsPanel) {
        panelToggleBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            if (controlsPanel.classList.contains('panel-open')) closeSettingsPanel();
            else openSettingsPanel();
        });
    }

    if (fullscreenToggleBtn && simCanvas) {
        fullscreenToggleBtn.addEventListener('click', () => {
            setFullscreen(!body.classList.contains('sim-fullscreen-active'));
        });
        document.addEventListener('fullscreenchange', onBrowserFullscreenChange);
        document.addEventListener('webkitfullscreenchange', onBrowserFullscreenChange);
    }

    // Initial setup
    syncAspectRatio();
    placeActionButtons();
    createInternalCloseButton();
    updateButtonIcons();
    updatePositions();

    window.addEventListener('resize', updatePositions);
    window.addEventListener('load', queueUpdate);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueUpdate).catch(() => {});

    // Re-measure when the layout changes without a window resize (e.g. a scrollbar appearing, fonts
    // loading, the info bar wrapping, a simulation changing its aspect ratio).
    if (typeof ResizeObserver !== 'undefined') {
        const layoutObserver = new ResizeObserver(queueUpdate);
        [displayContainer, simAreaWrapper, simInfoBar, simPageInner.querySelector('h1'), document.getElementById('header')]
            .forEach((el) => { if (el) layoutObserver.observe(el); });
    }

    if (aspectRatioBox && typeof MutationObserver !== 'undefined') {
        new MutationObserver(syncAspectRatio).observe(aspectRatioBox, { attributes: true, attributeFilter: ['style'] });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (controlsPanel && controlsPanel.classList.contains('panel-open')) {
            // Close the settings first; a second Escape leaves fullscreen
            closeSettingsPanel();
        } else if (body.classList.contains('sim-fullscreen-active')) {
            setFullscreen(false);
        }
    });

    const fpsDisplay = document.getElementById('fpsDisplay');
    if (fpsDisplay) {
        // Typing targets where 'F' must not toggle the FPS counter (sliders, checkboxes and buttons are fine)
        const isTextEntry = (el) => {
            if (!el) return false;
            if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
            if (el.tagName !== 'INPUT') return false;
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            return ['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week'].includes(type);
        };
        document.addEventListener('keydown', (e) => {
            if (typeof e.key === 'string' && e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
                if (!isTextEntry(e.target)) {
                    fpsDisplay.style.display = fpsDisplay.style.display === 'block' ? 'none' : 'block';
                    e.preventDefault();
                }
            }
        });
    }

    // Event listener and population for convectionGridSizeSelector
    if (convectionGridSizeSelector && window.convectionSimulation) {
        const availableSizes = window.convectionSimulation.getAvailableGridSizes ? window.convectionSimulation.getAvailableGridSizes() : [48, 64, 96]; // Fallback if function not yet on core
        const currentSize = window.convectionSimulation.getCurrentGridSize ? window.convectionSimulation.getCurrentGridSize() : availableSizes[0];

        availableSizes.forEach(size => {
            const option = document.createElement('option');
            option.value = size;
            option.textContent = `${size}x${size}`;
            if (size === currentSize) {
                option.selected = true;
            }
            convectionGridSizeSelector.appendChild(option);
        });

        convectionGridSizeSelector.addEventListener('change', function() {
            const newSize = parseInt(this.value);
            if (window.convectionSimulation && typeof window.convectionSimulation.setSize === 'function') {
                window.convectionSimulation.setSize(newSize);
                updatePositions(); 
            } else {
                console.warn('window.convectionSimulation.setSize() function not found.');
            }
        });
    }
});