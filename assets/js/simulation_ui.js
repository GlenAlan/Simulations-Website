document.addEventListener('DOMContentLoaded', () => {
    const body = document.body;
    const siteHeader = document.getElementById('header');

    const simPageInner = document.querySelector('#main > .inner');
    if (!simPageInner) return;

    const controlsPanel = simPageInner.querySelector('#simulationControlsPanel');
    const fullscreenToggleBtn = simPageInner.querySelector('.sim-fullscreen-toggle');
    const panelToggleBtn = simPageInner.querySelector('.sim-panel-toggle-button'); // External settings button (cog)
    const simCanvas = simPageInner.querySelector('#simulationCanvas');
    const actionButtonsOverlay = document.querySelector('.sim-action-buttons-overlay');
    const simControlsHeader = controlsPanel ? controlsPanel.querySelector('.sim-controls-header') : null;
    const simInfoBar = simPageInner.querySelector('.sim-info-bar'); // Get the info bar
    const aspectRatioBox = simPageInner.querySelector('.sim-aspect-ratio-box');
    const canvasWrapper = aspectRatioBox ? aspectRatioBox.parentElement : null; // .sim-canvas-wrapper
    let panelCloseBtnInside; // Internal close button for the panel
    let scrollBeforeFullscreen = 0;

    // Convection grid size selector
    const convectionGridSizeSelector = controlsPanel ? controlsPanel.querySelector('#convectionGridSizeSelector') : null;

    const openPanelIcon = '<span class="icon solid fa-cog"><span class="label">Open Settings</span></span>';
    const closePanelIcon = '<span class="icon solid fa-times"><span class="label">Close Settings</span></span>';

    const fullscreenIconExpand = '<span class="icon solid fa-expand"><span class="label">Enter Fullscreen</span></span>';
    const fullscreenIconContract = '<span class="icon solid fa-compress"><span class="label">Exit Fullscreen</span></span>';

    // The fullscreen layout (simulation_styles.css) works out the size of .sim-canvas-wrapper
    // from --aspect-ratio. Pages set it on .sim-aspect-ratio-box (and may change it at run time),
    // so mirror it onto the wrapper; otherwise the wrapper always assumes 2:1.
    function syncAspectRatio() {
        if (!aspectRatioBox || !canvasWrapper) return;
        const ratio = aspectRatioBox.style.getPropertyValue('--aspect-ratio').trim();
        if (ratio && canvasWrapper.style.getPropertyValue('--aspect-ratio').trim() !== ratio) {
            canvasWrapper.style.setProperty('--aspect-ratio', ratio);
        }
    }

    // Tell the simulation its display area has changed (simulation cores listen for 'resize').
    function notifyLayoutChange() {
        window.dispatchEvent(new Event('resize'));
    }

    function createInternalCloseButton() {
        if (controlsPanel && simControlsHeader && !simControlsHeader.querySelector('.sim-panel-close-button-insIDE')) {
            panelCloseBtnInside = document.createElement('button');
            panelCloseBtnInside.innerHTML = closePanelIcon;
            panelCloseBtnInside.className = 'sim-panel-close-button-insIDE'; // Will be styled by CSS to match others
            panelCloseBtnInside.setAttribute('aria-label', 'Close Settings');
            simControlsHeader.appendChild(panelCloseBtnInside);

            panelCloseBtnInside.addEventListener('click', (event) => {
                event.stopPropagation();
                closeSettingsPanel();
            });
        }
    }

    // In fullscreen, simulation_styles.css narrows .simulation-main-content while the panel is open
    // (body.sim-fullscreen-active.sim-panel-active), so no inline sizing is needed here.
    function openSettingsPanel() {
        if (controlsPanel && panelToggleBtn) {
            controlsPanel.classList.add('panel-open');
            body.classList.add('sim-panel-active'); // CSS hides actionButtonsOverlay
            panelToggleBtn.setAttribute('aria-expanded', 'true');
            updatePositions();
            // The cog button is now hidden; move keyboard focus into the panel.
            if (panelCloseBtnInside) panelCloseBtnInside.focus({ preventScroll: true });
            if (body.classList.contains('sim-fullscreen-active')) {
                notifyLayoutChange(); // Canvas area shrinks to make room for the panel
            }
        }
    }

    function closeSettingsPanel() {
        if (controlsPanel && panelToggleBtn) {
            const focusWasInPanel = controlsPanel.contains(document.activeElement);
            controlsPanel.classList.remove('panel-open');
            body.classList.remove('sim-panel-active'); // CSS shows actionButtonsOverlay
            panelToggleBtn.setAttribute('aria-expanded', 'false');

            updateButtonIcons(); // Update fullscreen icon if its state could have changed indirectly
            updatePositions(); // Ensure positions are updated after panel closes
            if (focusWasInPanel) panelToggleBtn.focus({ preventScroll: true });
            notifyLayoutChange();
        }
    }

    function updateButtonIcons() {
        if (fullscreenToggleBtn) {
             fullscreenToggleBtn.innerHTML = body.classList.contains('sim-fullscreen-active') ? fullscreenIconContract : fullscreenIconExpand;
        }
        if (panelToggleBtn) { // Ensure the button exists
            panelToggleBtn.innerHTML = openPanelIcon; // Always set the cog icon for the external button
        }
        // The internal panelCloseBtnInside's icon is set upon its creation and doesn't need updating here.
    }

    function updatePositions() {
        const isFullscreen = body.classList.contains('sim-fullscreen-active');

        // Panel positioning: below the site header normally; full height (above the info bar) in fullscreen
        if (controlsPanel) {
            let panelTopOffset = '0px';
            let panelHeight = '100vh';
            if (siteHeader && !isFullscreen) {
                panelTopOffset = `${siteHeader.offsetHeight}px`;
                panelHeight = `calc(100vh - ${siteHeader.offsetHeight}px)`;
            }
            controlsPanel.style.top = panelTopOffset;
            controlsPanel.style.height = panelHeight;
        }

        // In fullscreen the info bar is fixed to the bottom of the screen and can wrap onto
        // several lines on narrow screens; the panel's height in CSS uses this to stop above it.
        if (isFullscreen && simInfoBar) {
            document.documentElement.style.setProperty('--sim-fullscreen-info-bar-height', `${simInfoBar.offsetHeight}px`);
        } else {
            document.documentElement.style.removeProperty('--sim-fullscreen-info-bar-height');
        }

        // Action Buttons Overlay positioning logic
        // Overlay is hidden by CSS if panel is open (body.sim-panel-active)
        if (actionButtonsOverlay && !body.classList.contains('sim-panel-active')) {
            const simulationAreaWrapper = document.querySelector('.simulation-area-wrapper');
            const displayContainer = document.querySelector('.simulation-display-container');

            if (isFullscreen) {
                const buttonOffset = getComputedStyle(document.documentElement).getPropertyValue('--sim-button-offset').trim();
                actionButtonsOverlay.style.position = 'fixed';
                actionButtonsOverlay.style.top = buttonOffset;
                actionButtonsOverlay.style.right = buttonOffset;
                actionButtonsOverlay.style.left = 'auto';
                actionButtonsOverlay.style.transform = 'none';
                document.documentElement.style.setProperty('--sim-action-buttons-overlay-height', `${actionButtonsOverlay.offsetHeight}px`);
            } else { // Non-fullscreen mode
                actionButtonsOverlay.style.position = 'absolute';
                const currentButtonOffsetString = getComputedStyle(document.documentElement).getPropertyValue('--sim-button-offset').trim(); // e.g., "5px"
                const buttonOffsetNumeric = parseFloat(currentButtonOffsetString) || 0; // e.g., 5

                actionButtonsOverlay.style.transform = 'none'; // Reset any transform from CSS

                if (displayContainer && simulationAreaWrapper) {
                    const displayRect = displayContainer.getBoundingClientRect();
                    const areaWrapperRect = simulationAreaWrapper.getBoundingClientRect();

                    if (window.matchMedia("(max-width: 768px)").matches) {
                        // Small screens: inside displayContainer (canvas area), top right edge
                        actionButtonsOverlay.style.top = `${(displayRect.top - areaWrapperRect.top) + buttonOffsetNumeric}px`;
                        actionButtonsOverlay.style.left = 'auto';
                        // Calculate right relative to simulationAreaWrapper to place it buttonOffsetNumeric from displayContainer's right edge
                        actionButtonsOverlay.style.right = `${(areaWrapperRect.right - displayRect.right) + buttonOffsetNumeric}px`;
                    } else {
                        // Large screens: right of simulation, vertically aligned with its top
                        actionButtonsOverlay.style.top = `${(displayRect.top - areaWrapperRect.top)}px`; // Align top with displayContainer top
                        actionButtonsOverlay.style.left = `${(displayRect.right - areaWrapperRect.left) + buttonOffsetNumeric}px`; // Position to the right of displayContainer with offset
                        actionButtonsOverlay.style.right = 'auto';
                    }
                } else {
                    // Fallback positioning if containers not found
                    actionButtonsOverlay.style.top = currentButtonOffsetString;
                    actionButtonsOverlay.style.right = currentButtonOffsetString;
                    actionButtonsOverlay.style.left = 'auto';
                }
                document.documentElement.style.removeProperty('--sim-action-buttons-overlay-height');
            }
        }
    }

    if (panelToggleBtn && controlsPanel) {
        panelToggleBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!controlsPanel.classList.contains('panel-open')) {
                openSettingsPanel();
            }
        });
    }

    if (fullscreenToggleBtn && simCanvas) {
        fullscreenToggleBtn.addEventListener('click', () => {
            const isEnteringFullscreen = !body.classList.contains('sim-fullscreen-active');
            if (isEnteringFullscreen) scrollBeforeFullscreen = window.scrollY || window.pageYOffset || 0;
            body.classList.toggle('sim-fullscreen-active', isEnteringFullscreen);

            fullscreenToggleBtn.setAttribute('aria-expanded', isEnteringFullscreen.toString());
            // Toggle a class on simInfoBar for fullscreen-specific styling
            if (simInfoBar) {
                simInfoBar.classList.toggle('fullscreen-style', isEnteringFullscreen);
            }

            updateButtonIcons();
            updatePositions();
            notifyLayoutChange(); // Ensure canvas resizes
            if (!isEnteringFullscreen) {
                // Return to where the page was before entering fullscreen
                window.scrollTo(0, scrollBeforeFullscreen);
                updatePositions();
            }
        });
    }

    // Initial setup
    syncAspectRatio();
    createInternalCloseButton();
    updateButtonIcons();
    updatePositions();

    window.addEventListener('resize', updatePositions);

    // Keep the overlay buttons attached to the simulation when its layout changes without a
    // window resize (e.g. a scrollbar appearing, fonts loading, a simulation resizing its canvas).
    if (typeof ResizeObserver !== 'undefined') {
        const layoutObserver = new ResizeObserver(() => updatePositions());
        const displayContainer = simPageInner.querySelector('.simulation-display-container');
        const simulationAreaWrapper = simPageInner.querySelector('.simulation-area-wrapper');
        if (displayContainer) layoutObserver.observe(displayContainer);
        if (simulationAreaWrapper) layoutObserver.observe(simulationAreaWrapper);
        if (simInfoBar) layoutObserver.observe(simInfoBar);
    }

    if (aspectRatioBox && typeof MutationObserver !== 'undefined') {
        new MutationObserver(syncAspectRatio).observe(aspectRatioBox, { attributes: true, attributeFilter: ['style'] });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (body.classList.contains('sim-fullscreen-active')) {
                // Exit fullscreen (the panel, if open, stays open; a second Escape closes it)
                if (fullscreenToggleBtn) {
                    fullscreenToggleBtn.click();
                }
            } else if (controlsPanel && controlsPanel.classList.contains('panel-open')) {
                // If panel is open and not in fullscreen, close the panel
                closeSettingsPanel();
            }
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