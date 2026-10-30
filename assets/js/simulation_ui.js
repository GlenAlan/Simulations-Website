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
    let panelCloseBtnInside; // Internal close button for the panel

    // Convection grid size selector
    const convectionGridSizeSelector = controlsPanel ? controlsPanel.querySelector('#convectionGridSizeSelector') : null;

    const openPanelIcon = '<span class="icon solid fa-cog"><span class="label">Open Settings</span></span>';
    const closePanelIcon = '<span class="icon solid fa-times"><span class="label">Close Settings</span></span>';
    
    const fullscreenIconExpand = '<span class="icon solid fa-expand"><span class="label">Enter Fullscreen</span></span>';
    const fullscreenIconContract = '<span class="icon solid fa-compress"><span class="label">Exit Fullscreen</span></span>';

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
    }    function openSettingsPanel() {
        if (controlsPanel && panelToggleBtn) {
            controlsPanel.classList.add('panel-open');
            body.classList.add('sim-panel-active'); // CSS hides actionButtonsOverlay
            panelToggleBtn.setAttribute('aria-expanded', 'true');
            
            // Adjust main content area in fullscreen mode to make room for panel
            if (body.classList.contains('sim-fullscreen-active')) {
                const simulationMainContent = document.querySelector('.simulation-main-content');
                if (simulationMainContent) {
                    simulationMainContent.style.width = `calc(100% - ${getComputedStyle(document.documentElement).getPropertyValue('--sim-panel-width')})`;
                    simulationMainContent.style.marginRight = getComputedStyle(document.documentElement).getPropertyValue('--sim-panel-width');
                    // Trigger resize event to allow canvas to adapt to new dimensions
                    window.dispatchEvent(new Event('resize'));
                }
            }
        }
    }    function closeSettingsPanel() {
        if (controlsPanel && panelToggleBtn) {
            controlsPanel.classList.remove('panel-open');
            body.classList.remove('sim-panel-active'); // CSS shows actionButtonsOverlay
            panelToggleBtn.setAttribute('aria-expanded', 'false');
            
            const simulationMainContent = document.querySelector('.simulation-main-content');
            if (simulationMainContent) {
                if (body.classList.contains('sim-fullscreen-active')) {
                    // Restore main content area full width in fullscreen mode
                    simulationMainContent.style.width = '100%';
                    simulationMainContent.style.marginRight = '0';
                } else {
                    // Reset any inline styles when not in fullscreen mode
                    // This is crucial to fix the offset issue when exiting fullscreen with panel open
                    simulationMainContent.style.width = '';
                    simulationMainContent.style.marginRight = '';
                }
                // Trigger resize event to allow canvas to adapt to new dimensions
                window.dispatchEvent(new Event('resize'));
            }
            
            updateButtonIcons(); // Update fullscreen icon if its state could have changed indirectly
            updatePositions(); // Ensure positions are updated after panel closes
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
    }    function updatePositions() {
        // Panel positioning logic (remains mostly the same for the panel itself)
        if (controlsPanel) { 
            let panelTopOffset = '0px';
            let panelHeight = '100vh';
            if (siteHeader && !body.classList.contains('sim-fullscreen-active')) {
                panelTopOffset = `${siteHeader.offsetHeight}px`;
                panelHeight = `calc(100vh - ${siteHeader.offsetHeight}px)`;
            }
            controlsPanel.style.top = panelTopOffset;
            controlsPanel.style.height = panelHeight;
        }        // Action Buttons Overlay positioning logic
        // Overlay is hidden by CSS if panel is open (body.sim-panel-active)
        if (actionButtonsOverlay && !body.classList.contains('sim-panel-active')) {
            const simulationAreaWrapper = document.querySelector('.simulation-area-wrapper');
            const displayContainer = document.querySelector('.simulation-display-container');
            const simulationMainContent = document.querySelector('.simulation-main-content');
            
            if (body.classList.contains('sim-fullscreen-active')) {
                const buttonOffset = getComputedStyle(document.documentElement).getPropertyValue('--sim-button-offset').trim();
                actionButtonsOverlay.style.position = 'fixed';
                actionButtonsOverlay.style.top = buttonOffset;
                actionButtonsOverlay.style.right = buttonOffset;
                actionButtonsOverlay.style.left = 'auto';
                actionButtonsOverlay.style.transform = 'none';
                document.documentElement.style.setProperty('--sim-action-buttons-overlay-height', `${actionButtonsOverlay.offsetHeight}px`);
                
                // Adjust canvas display container when in fullscreen based on panel state
                if (simulationMainContent && controlsPanel && controlsPanel.classList.contains('panel-open')) {
                    // Panel is open in fullscreen mode, adjust main content area
                    simulationMainContent.style.width = `calc(100% - ${getComputedStyle(document.documentElement).getPropertyValue('--sim-panel-width')})`;
                    simulationMainContent.style.marginRight = getComputedStyle(document.documentElement).getPropertyValue('--sim-panel-width');
                } else if (simulationMainContent) {
                    // Ensure full width when panel is closed in fullscreen
                    simulationMainContent.style.width = '100%';
                    simulationMainContent.style.marginRight = '0';
                }            } else { // Non-fullscreen mode
                // Reset any inline styles on main content area when not in fullscreen mode
                if (simulationMainContent) {
                    simulationMainContent.style.width = '';
                    simulationMainContent.style.marginRight = '';
                }
                
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
    }    if (fullscreenToggleBtn && simCanvas) {
        fullscreenToggleBtn.addEventListener('click', () => {
            const isEnteringFullscreen = !body.classList.contains('sim-fullscreen-active');
            body.classList.toggle('sim-fullscreen-active');
            
            fullscreenToggleBtn.setAttribute('aria-expanded', isEnteringFullscreen.toString());
            // Toggle a class on simInfoBar for fullscreen-specific styling
            if (simInfoBar) {
                simInfoBar.classList.toggle('fullscreen-style', isEnteringFullscreen);
            }
            
            const simulationMainContent = document.querySelector('.simulation-main-content');
            
            // Update display container to respond to panel state if fullscreen is entered
            if (isEnteringFullscreen && controlsPanel && controlsPanel.classList.contains('panel-open')) {
                // When entering fullscreen with panel open, ensure canvas adapts to avoid overlap
                if (simulationMainContent) {
                    simulationMainContent.style.width = `calc(100% - ${getComputedStyle(document.documentElement).getPropertyValue('--sim-panel-width')})`;
                    simulationMainContent.style.marginRight = getComputedStyle(document.documentElement).getPropertyValue('--sim-panel-width');
                }
            } else if (!isEnteringFullscreen) {
                // When exiting fullscreen, reset inline styles regardless of panel state
                if (simulationMainContent) {
                    simulationMainContent.style.width = '';
                    simulationMainContent.style.marginRight = '';
                }
            }
            
            updateButtonIcons();
            updatePositions(); 
            window.dispatchEvent(new Event('resize')); // Ensure canvas resizes
        });
    }
      // Initial setup
    createInternalCloseButton();
    updateButtonIcons();
    updatePositions();    window.addEventListener('resize', () => {
        updatePositions();
        
        const simulationMainContent = document.querySelector('.simulation-main-content');
        
        // Handle resizing in fullscreen mode with panel open
        if (body.classList.contains('sim-fullscreen-active') && 
            controlsPanel && controlsPanel.classList.contains('panel-open')) {
            if (simulationMainContent) {
                simulationMainContent.style.width = `calc(100% - ${getComputedStyle(document.documentElement).getPropertyValue('--sim-panel-width')})`;
                simulationMainContent.style.marginRight = getComputedStyle(document.documentElement).getPropertyValue('--sim-panel-width');
            }
        } else if (!body.classList.contains('sim-fullscreen-active') && simulationMainContent) {
            // When not in fullscreen mode, ensure margin and width are reset
            simulationMainContent.style.width = '';
            simulationMainContent.style.marginRight = '';
        }
    });document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (body.classList.contains('sim-fullscreen-active')) {
                // Simulate a click on the fullscreen button to exit fullscreen
                if (fullscreenToggleBtn) {
                    fullscreenToggleBtn.click();
                }
                
                // Additionally ensure that inline styles are reset
                const simulationMainContent = document.querySelector('.simulation-main-content');
                if (simulationMainContent) {
                    simulationMainContent.style.width = '';
                    simulationMainContent.style.marginRight = '';
                }
            } else if (controlsPanel && controlsPanel.classList.contains('panel-open')) {
                // If panel is open and not in fullscreen, close the panel
                closeSettingsPanel();
            }
        }
    });

    const fpsDisplay = document.getElementById('fpsDisplay');
    if (fpsDisplay) {
        document.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                if (!(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
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