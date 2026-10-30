// Original script from conduction.html, adapted for the new page structure

// DOM REFS - Updated to match new HTML structure
const canvas = document.getElementById('simulationCanvas');
const ctx = canvas ? canvas.getContext('2d') : null;

const timeSlider = document.getElementById('timeScale');
const timeVal = document.getElementById('timeScaleVal');
const radiusSlider = document.getElementById('heatSize'); // Renamed from sizeSlider
const radiusVal = document.getElementById('heatSizeVal'); // Renamed from sizeVal
const heatAmpSlider = document.getElementById('heatAmp'); // Renamed from ampSlider
const ampVal = document.getElementById('heatAmpVal');
const energyVal = document.getElementById('energyVal');
const springConstantSlider = document.getElementById('springConstant');
const springConstantVal = document.getElementById('springConstantVal');
// const fpsDisplay  = document.getElementById('fpsDisplay'); // Kept for reference, but not used by this core script

// Simulation constants
const MIN_SPACING = 1.0; // Minimum spacing for particles
const PARTICLE_RADIUS_SCALE_FACTOR = 6.0; // Determines particle size relative to spacing
const MARGIN = 25; // Default margin in pixels

// Initial simulation parameters from HTML (if elements exist)
let timeScale = timeSlider ? parseFloat(timeSlider.value) : 25;
let heatRadius = radiusSlider ? parseFloat(radiusSlider.value) : 25; // Default to 25
let heatAmp = heatAmpSlider ? parseFloat(heatAmpSlider.value) : 1;
let kN = springConstantSlider ? parseFloat(springConstantSlider.value) : 0.2; // Spring constant

// Particle and Grid Setup
let cols = 20, rows = 10; // Default grid size, now 'let'
const PREDEFINED_GRID_LAYOUTS = {
    "default": { cols: 20, rows: 10 },
    "small": { cols: 10, rows: 5 },
    "large": { cols: 40, rows: 20 },
    "wide": { cols: 30, rows: 5 },
    "square_medium": { cols: 15, rows: 15 },
    "large_square": { cols: 25, rows: 25 }
};
let currentGridLayoutName = "default"; // To keep track of the current layout

let spacing = 30; // Default spacing, will be updated
let diag = spacing * Math.SQRT2; // Will be updated with spacing
let canvasWidth = 800, canvasHeight = 400; // Default, will be updated

// Physics constants
const baseDt = 0.005;     // Base physics timestep for one sub-step
const kR = 0.5; // Restoring force constant
// kN is now a let variable, initialized above
const colorSmooth = 0.98; // Smoothing factor for particle color based on amplitude

// Frame-rate independent timing
let lastTimestamp = 0; // Already present, ensure it's used correctly
let physicsStepAccumulator = 0.0;
const REFERENCE_UPDATES_PER_SECOND = 60.0;

// Particle class
class Particle {
    constructor(x0, y0, grid_i, grid_j) { // Added grid_i, grid_j
        this.x0 = x0; this.y0 = y0; // Initial rest position
        this.x = x0; this.y = y0;   // Current position
        this.vx = 0; this.vy = 0;   // Velocity
        this.smAmp = 0;             // Smoothed amplitude for color
        this.neighbors = []; // Stores { index: neighbor_index, rest: rest_length, isDiagonal: boolean }
        this.grid_i = grid_i; // Store grid column index
        this.grid_j = grid_j; // Store grid row index
    }
    addNeighbor(neighbor_index, rest, isDiagonal) { // Added isDiagonal
        this.neighbors.push({ index: neighbor_index, rest, isDiagonal });
    }
    computeAmp() {
        const dx = this.x - this.x0, dy = this.y - this.y0;
        return Math.hypot(dx, dy);
    }
}

const particles = [];
let offsetX, offsetY; // Will be calculated based on canvas size

// Helper function to calculate grid geometry
function calculateGridGeometry(currentCanvasWidth, currentCanvasHeight) {
    // cols and rows are global constants (e.g., 20, 10)
    // MIN_SPACING and MARGIN are global constants

    let sX, sY;

    // Calculate spacing based on X dimension
    // Ensure there's at least (cols - 1) * MIN_SPACING width for the grid itself, plus margins
    if (cols > 1) {
        if (currentCanvasWidth >= (2 * MARGIN) + ((cols - 1) * MIN_SPACING)) {
            sX = (currentCanvasWidth - (2 * MARGIN)) / (cols - 1);
        } else { // Not enough space for margins, calculate spacing based on full width
            sX = currentCanvasWidth / (cols - 1);
        }
    } else { // Single column or invalid cols
        sX = currentCanvasWidth; // Effectively, the "cell" is the full width
    }

    // Calculate spacing based on Y dimension
    if (rows > 1) {
        if (currentCanvasHeight >= (2 * MARGIN) + ((rows - 1) * MIN_SPACING)) {
            sY = (currentCanvasHeight - (2 * MARGIN)) / (rows - 1);
        } else { // Not enough space for margins, calculate spacing based on full height
            sY = currentCanvasHeight / (rows - 1);
        }
    } else { // Single row or invalid rows
        sY = currentCanvasHeight;
    }

    // Determine the limiting spacing, ensuring it's not less than MIN_SPACING
    const calculatedNewSpacing = (cols <= 1 || rows <= 1) ? Math.max(sX, sY) : Math.min(sX, sY); // if 1 col/row, take the larger dim as spacing
    const finalSpacing = Math.max(MIN_SPACING, calculatedNewSpacing);
    
    const finalDiag = finalSpacing * Math.SQRT2;
    
    // Calculate offsets to center the grid
    const gridWidth = (cols > 1) ? (cols - 1) * finalSpacing : 0; // No width if 1 col
    const gridHeight = (rows > 1) ? (rows - 1) * finalSpacing : 0; // No height if 1 row

    const finalOffsetX = (currentCanvasWidth - gridWidth) / 2;
    const finalOffsetY = (currentCanvasHeight - gridHeight) / 2;

    return { spacing: finalSpacing, diag: finalDiag, offsetX: finalOffsetX, offsetY: finalOffsetY };
}

function initializeParticles() {
    particles.length = 0; // Clear existing particles

    // Calculate initial grid geometry using the helper function
    // canvasWidth and canvasHeight should be up-to-date before this call
    const geom = calculateGridGeometry(canvasWidth, canvasHeight);
    spacing = geom.spacing; // Update global spacing
    diag = geom.diag;       // Update global diag
    offsetX = geom.offsetX; // Update global offsetX
    offsetY = geom.offsetY; // Update global offsetY

    for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
            // Pass i and j (grid indices) to Particle constructor
            particles.push(new Particle(offsetX + i * spacing, offsetY + j * spacing, i, j));
        }
    }
    const idx = (i, j) => i * rows + j;
    
    particles.forEach((p) => { // Use p.grid_i and p.grid_j directly
        for (let dy = -1; dy <= 1; dy++) {      // Iterate through y-offsets (-1, 0, 1)
            for (let dx = -1; dx <= 1; dx++) {  // Iterate through x-offsets (-1, 0, 1)
                if (dx === 0 && dy === 0) continue; // Skip self

                const neighbor_col = p.grid_i + dx; // Use p.grid_i
                const neighbor_row = p.grid_j + dy; // Use p.grid_j

                if (neighbor_col >= 0 && neighbor_col < cols && neighbor_row >= 0 && neighbor_row < rows) {
                    const neighbor_actual_index = idx(neighbor_col, neighbor_row);
                    const isDiagonal = (dx !== 0 && dy !== 0);
                    // Determine rest length: 'diag' for diagonal, 'spacing' for orthogonal
                    const rest = isDiagonal ? diag : spacing;
                    p.addNeighbor(neighbor_actual_index, rest, isDiagonal); // Pass isDiagonal
                }
            }
        }
    });
}

// New function to adapt particles to canvas resize
function adaptParticlesToResize(oldSpacing, newSpacing, newDiag, newOffsetX, newOffsetY) {
    if (oldSpacing <= 0 || newSpacing <= 0) return; // Avoid division by zero or invalid scaling

    const scaleFactor = newSpacing / oldSpacing;

    particles.forEach(p => {
        // Calculate displacement from old rest position
        const dx_relative = p.x - p.x0;
        const dy_relative = p.y - p.y0;

        // Update rest position (x0, y0) based on grid indices and new geometry
        p.x0 = newOffsetX + p.grid_i * newSpacing;
        p.y0 = newOffsetY + p.grid_j * newSpacing;

        // Scale the displacement and apply to new rest position
        p.x = p.x0 + dx_relative * scaleFactor;
        p.y = p.y0 + dy_relative * scaleFactor;

        // Scale velocities
        p.vx *= scaleFactor;
        p.vy *= scaleFactor;

        // Update rest lengths for neighbors
        p.neighbors.forEach(neighbor => {
            if (neighbor.isDiagonal) {
                neighbor.rest = newDiag;
            } else {
                neighbor.rest = newSpacing;
            }
        });
    });
}


// Forces
// let forces = []; // This will now be assigned the result of computeForces()
function computeForces() {
    // Create a local F array for computation, as in original
    const F = particles.map(() => ({ fx: 0, fy: 0 })); 
    particles.forEach((p, i) => {
        // On-site restoring force (pulls particle back to its lattice point)
        F[i].fx += -kR * (p.x - p.x0);
        F[i].fy += -kR * (p.y - p.y0);

        // Spring forces from neighbors
        p.neighbors.forEach(({ index: n_index, rest }) => {
            // If the neighbor's index is less than the current particle's index 'i',
            // this spring interaction has already been processed when the neighbor
            // was the primary particle. So, skip to avoid double counting.
            if (n_index < i) {
                return; // Equivalent to 'continue' in a forEach callback
            }

            const n = particles[n_index]; // Get the actual neighbor particle object

            const dx_pn = p.x - n.x; // Displacement from n to p
            const dy_pn = p.y - n.y;
            // Use rest length as fallback if particles overlap to avoid division by zero
            // and ensure force becomes zero if d=0 and effective_d=rest.
            const effective_d = Math.hypot(dx_pn, dy_pn) || rest; 
            
            const forceMagnitudeScalar = -kN * (effective_d - rest); // Hooke's Law scalar part
            
            // Force components on particle 'p' from its spring connection with 'n'
            // If effective_d is 'rest' (due to overlap), and dx_pn/dy_pn are 0, force components are 0.
            // If effective_d is very small (but non-zero hypot), dx_pn/effective_d is unit vector component.
            const fx_component_on_p = forceMagnitudeScalar * (dx_pn / effective_d);
            const fy_component_on_p = forceMagnitudeScalar * (dy_pn / effective_d);

            // Apply force to particle p
            F[i].fx += fx_component_on_p;
            F[i].fy += fy_component_on_p;

            // Apply reaction force (equal and opposite) to particle n
            F[n_index].fx -= fx_component_on_p;
            F[n_index].fy -= fy_component_on_p;
        });
    });
    return F; // Return the computed forces
}

// Energy Calculation
function computeEnergy() {
    let ke = 0, pr = 0, ps = 0; // Kinetic, Potential (restoring), Potential (spring)
    particles.forEach((p, i) => {
        ke += 0.5 * (p.vx * p.vx + p.vy * p.vy);
        const dx_site = p.x - p.x0, dy_site = p.y - p.y0;
        pr += 0.5 * kR * (dx_site * dx_site + dy_site * dy_site);

        p.neighbors.forEach(({ index: n_index, rest }) => {
            if (n_index > i) { // Calculate each spring's potential energy once
                const n = particles[n_index]; // Get neighbor particle object
                const ddx = p.x - n.x, ddy = p.y - n.y;
                const diff = Math.hypot(ddx, ddy) - rest;
                ps += 0.5 * kN * diff * diff;
            }
        });
    });
    return ke + pr + ps;
}

// UI Interaction State (ensure mX, mY are initialized if not already)
let heating = false, cooling = false, mX = 0, mY = 0;

// Event Listeners for UI
if (canvas) {
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
}

function updateMousePosition(e) {
    if (!canvas) return;
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


if (timeSlider && timeVal) {
    timeSlider.oninput = () => {
        timeScale = parseFloat(timeSlider.value);
        timeVal.textContent = timeScale;
    };
    timeVal.textContent = timeSlider.value; // Initialize display
}
if (radiusSlider && radiusVal) {
    radiusSlider.oninput = () => {
        heatRadius = parseFloat(radiusSlider.value);
        radiusVal.textContent = heatRadius;
    };
    radiusVal.textContent = radiusSlider.value; // Initialize display
}
if (heatAmpSlider && ampVal) {
    heatAmpSlider.oninput = () => {
        heatAmp = parseFloat(heatAmpSlider.value);
        ampVal.textContent = heatAmp.toFixed(1);
    };
    ampVal.textContent = parseFloat(heatAmpSlider.value).toFixed(1); // Initialize display
}

if (springConstantSlider && springConstantVal) {
    springConstantSlider.oninput = () => {
        kN = parseFloat(springConstantSlider.value);
        springConstantVal.textContent = kN.toFixed(2);
        forces = computeForces(); // Recompute forces when kN changes
    };
    springConstantVal.textContent = parseFloat(springConstantSlider.value).toFixed(2); // Initialize display
}

// This function performs one discrete step of the physics simulation using baseDt
function runSinglePhysicsStep() { // dt is implicitly baseDt
    const dt = baseDt; 
    const halfDt = 0.5 * dt;

    // Integration (Verlet or similar)
    // Update velocities (first half step) v(t+h/2) = v(t) + F(t)*h/2
    // Assumes 'forces' (module scope) holds F(t)
    particles.forEach((p, i) => {
        p.vx += forces[i].fx * halfDt;
        p.vy += forces[i].fy * halfDt;
    });
    // Update positions x(t+h) = x(t) + v(t+h/2)*h
    particles.forEach(p => {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
    });
    // Recompute forces based on new positions F(t+h)
    forces = computeForces(); // Assign to module-scoped forces
    // Update velocities (second half step) v(t+h) = v(t+h/2) + F(t+h)*h/2
    particles.forEach((p, i) => {
        p.vx += forces[i].fx * halfDt;
        p.vy += forces[i].fy * halfDt;
    });
}

// Rendering
function render() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Draw springs (connections)
    ctx.strokeStyle = 'rgba(100, 100, 100, 0.5)'; // Semi-transparent grey
    ctx.lineWidth = 1;
    particles.forEach(p => {
        p.neighbors.forEach(({ index: n_index }) => { // Use neighbor index
            const n = particles[n_index]; // Get neighbor particle object
            // Draw each connection once, using original condition for visual consistency
            if (n.x > p.x || (n.x === p.x && n.y > p.y)) { 
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(n.x, n.y);
                ctx.stroke();
            }
        });
    });

    // Draw particles
    const particleDrawRadius = Math.max(1.0, spacing / PARTICLE_RADIUS_SCALE_FACTOR); // Dynamic particle radius
    particles.forEach(p => {
        const amp = p.computeAmp();
        p.smAmp = colorSmooth * p.smAmp + (1 - colorSmooth) * amp; // Smooth the amplitude for color
        
        // Map amplitude to color (Blue: cold -> Red: hot)
        // Consistent with original conduction.html: cap smAmp at 1.0 for color scale
        const t = Math.min(p.smAmp, 1.0); 
        const hue = (1 - t) * 240; // 240 (blue) to 0 (red)
        
        ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, particleDrawRadius, 0, Math.PI * 2); // Use dynamic particle radius
        ctx.fill();
    });

    if (energyVal) {
        energyVal.textContent = computeEnergy().toFixed(0);
    }
}

// Main animation loop
// let lastTimestamp = 0; // This is already a global, ensure it's initialized before first animate call
function animate(timestamp) {
    if (!ctx) {
        console.error("Canvas context not available for animation.");
        return;
    }

    if (lastTimestamp === 0) { // Initialize lastTimestamp on the first frame
        lastTimestamp = timestamp;
    }
    let realDeltaTimeMs = timestamp - lastTimestamp;
    lastTimestamp = timestamp;

    // Cap delta time to prevent physics spiral if tab was inactive for a long time
    if (realDeltaTimeMs > 100) { 
        realDeltaTimeMs = 100;
    }    // Apply heating or cooling (once per animation frame)
    if (heating) {
        particles.forEach(p => {
            const dx = p.x - mX, dy = p.y - mY;
            const weight = Math.exp(-(dx * dx + dy * dy) / (2 * heatRadius * heatRadius));
            // Ensure heatAmp usage matches original: dv = heatAmp * weight;
            const dv = heatAmp * weight; 
            p.vx += (Math.random() * 2 - 1) * dv;
            p.vy += (Math.random() * 2 - 1) * dv;
        });
    } else if (cooling) {
        particles.forEach(p => {
            const dx = p.x - mX, dy = p.y - mY;
            const weight = Math.exp(-(dx * dx + dy * dy) / (2 * heatRadius * heatRadius));
            
            // Cooling effect - reduce velocity proportionally to the current velocity and weight
            const dampingFactor = Math.min(0.2, heatAmp * weight * 0.2); // Scale cooling effect
            p.vx *= (1 - dampingFactor);
            p.vy *= (1 - dampingFactor);
        });
    }

    // Calculate how many reference update "slots" have passed
    const referenceSlotsPassed = realDeltaTimeMs / (1000.0 / REFERENCE_UPDATES_PER_SECOND);
    
    // Add to accumulator, scaled by the UI timeScale
    physicsStepAccumulator += referenceSlotsPassed * timeScale;

    // Perform fixed-timestep physics updates
    // Ensure forces are computed before the first step if heating modified velocities
    // The redundant computeForces call if heating is removed.
    // Heating modifies velocities. The existing 'forces' (F(t)) will be used in the first
    // part of runSinglePhysicsStep. Then new forces F(t+h) are computed inside runSinglePhysicsStep.
    // if (heating) { 
    //     computeForces(); // This line is removed
    // }
    
    let maxStepsPerFrame = 100; // Safety break for the while loop
    let stepsTaken = 0;

    while (physicsStepAccumulator >= 1.0 && stepsTaken < maxStepsPerFrame) {
        runSinglePhysicsStep(); // Each call performs one 'baseDt' step
        physicsStepAccumulator -= 1.0;
        stepsTaken++;
    }
    if (stepsTaken >= maxStepsPerFrame) {
        console.warn("Max physics steps per frame reached. Simulation might be running too slow or timeScale is too high.");
        physicsStepAccumulator = 0; // Reset accumulator to prevent further immediate loops
    }
      // Update canvas resolution if it changed
    // Check against the canvas element's actual clientWidth/clientHeight
    handleConductionResize();
    
    render();
    requestAnimationFrame(animate);
}

// Initialization function to be called when DOM is ready
function startSimulationWhenReady() {
    if (!canvas || !ctx) {
        console.error("Canvas or context not found. Simulation cannot start.");
        // Retry or inform user, depending on how critical this is.
        // For now, we'll just log and exit.
        if (!document.getElementById('simulationCanvas')) {
            console.error("Element with ID 'simulationCanvas' not found in the DOM.");
        } else if (!canvas.getContext) {
            console.error("canvas.getContext is not a function. Is 'simulationCanvas' a canvas element?");
        }
        return;
    }

    // Set initial canvas dimensions from its CSS-defined size
    // This ensures the simulation grid is scaled correctly from the start.
    // The simulation_ui.js script should handle the dynamic resizing.
    // We get the initial size here.
    const aspectRatioBox = canvas.parentElement; // .sim-aspect-ratio-box
    if (aspectRatioBox) {
        canvasWidth = aspectRatioBox.clientWidth;
        canvasHeight = aspectRatioBox.clientHeight;
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
    } else {
        // Fallback if structure is not as expected, use default
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
    }


    initializeParticles();
    forces = computeForces(); // Initial force calculation and assignment
    requestAnimationFrame(animate); // Initial call to start the loop
}

// Defer start until DOM is fully ready and UI script has likely run
if (document.readyState === "complete" || (document.readyState !== "loading" && !document.documentElement.doScroll)) {
    startSimulationWhenReady();
} else {
    document.addEventListener("DOMContentLoaded", startSimulationWhenReady);
}

// Expose a resize function if needed by simulation_ui.js, though ideally
// simulation_ui.js handles canvas.width/height changes.
// For this conduction simulation, the particle grid is fixed in terms of cols/rows,
// but it recenters itself if the canvas dimensions change.
window.conductionSimulation = {
    // Example: a function to reset the simulation if needed from outside
    reset: () => {
        initializeParticles(); // This will use the current global cols and rows
        forces = computeForces(); // Update forces on reset
        // Reset smoothed amplitude for all particles to prevent stale visual state
        particles.forEach(p => p.smAmp = 0);
        if (energyVal) energyVal.textContent = computeEnergy().toFixed(0);
    },
    setGridLayout: (layoutName) => {
        const newLayout = PREDEFINED_GRID_LAYOUTS[layoutName];
        if (newLayout) {
            cols = newLayout.cols;
            rows = newLayout.rows;
            currentGridLayoutName = layoutName;
            
            // Update canvas aspect ratio to match grid layout
            const aspectRatioBox = document.querySelector('.sim-aspect-ratio-box');
            if (aspectRatioBox) {
                aspectRatioBox.style.setProperty('--aspect-ratio', `${cols}/${rows}`);
            }
            
            window.conductionSimulation.reset(); // Reset to apply new grid dimensions
            
            // Trigger canvas resize to apply new aspect ratio
            window.dispatchEvent(new Event('resize'));
        } else {
            console.warn(`Grid layout "${layoutName}" not found.`);
        }
    },
    getCurrentGridLayoutName: () => currentGridLayoutName,
    getAvailableGridLayouts: () => PREDEFINED_GRID_LAYOUTS
    // The simulation_ui.js script will handle canvas.width/height changes.
    // This script will pick them up in the animate() loop.
};

// Add event listener for the new reset button
document.addEventListener('DOMContentLoaded', () => {
    const resetButton = document.getElementById('resetSimulationBtn');
    if (resetButton) {
        resetButton.addEventListener('click', () => {
            if (window.conductionSimulation && typeof window.conductionSimulation.reset === 'function') {
                window.conductionSimulation.reset();
            }
        });
    }

    // --- Example: Event listener for a grid layout selector ---
    // Assuming you add a <select id="gridLayoutSelector"> in your HTML:
    // UNCOMMENTED AND ADAPTED THE FOLLOWING BLOCK
    const gridLayoutSelector = document.getElementById('gridLayoutSelector');
    if (gridLayoutSelector) {
        // Populate selector options
        const layouts = window.conductionSimulation.getAvailableGridLayouts();
        for (const layoutName in layouts) {
            const option = document.createElement('option');
            option.value = layoutName;
            // Make the text more readable, e.g., "Default (20x10)"
            let prettyLayoutName = layoutName.replace(/_/g, " ");
            prettyLayoutName = prettyLayoutName.charAt(0).toUpperCase() + prettyLayoutName.slice(1);
            option.textContent = `${prettyLayoutName} (${layouts[layoutName].cols}x${layouts[layoutName].rows})`;
            gridLayoutSelector.appendChild(option);
        }
        // Set initial value based on the current grid layout name from the simulation core
        gridLayoutSelector.value = window.conductionSimulation.getCurrentGridLayoutName(); 

        gridLayoutSelector.addEventListener('change', (event) => {
            if (window.conductionSimulation && typeof window.conductionSimulation.setGridLayout === 'function') {
                window.conductionSimulation.setGridLayout(event.target.value);
            }
        });
    }
    // --- End Example ---
});

function handleConductionResize() {
    if (!canvas) return;
    
    const aspectRatioBox = canvas.parentElement; // .sim-aspect-ratio-box
    if (!aspectRatioBox) return;

    const isFullscreen = document.body.classList.contains('sim-fullscreen-active');
    let targetWidth, targetHeight;

    // Get aspect ratio from CSS custom property  
    const simStyle = getComputedStyle(aspectRatioBox);
    const simAspectRatioString = simStyle.getPropertyValue('--aspect-ratio').trim();
    let simAspectRatio = 1; // Default aspect ratio for conduction
    if (simAspectRatioString) {
        const parts = simAspectRatioString.split('/');
        if (parts.length === 2 && parseFloat(parts[1]) !== 0) {
            simAspectRatio = parseFloat(parts[0]) / parseFloat(parts[1]);
        } else if (parts.length === 1) {
            simAspectRatio = parseFloat(simAspectRatioString);
        }
    }
    if (isNaN(simAspectRatio) || simAspectRatio <= 0) simAspectRatio = 1;    if (isFullscreen) {
        // In fullscreen, calculate maximum size that fits while maintaining aspect ratio
        const canvasWrapper = aspectRatioBox.parentElement; 
        if (!canvasWrapper) return;
        
        // Get available space from the wrapper (accounts for padding from parent)
        const availableWidth = canvasWrapper.clientWidth;
        const availableHeight = canvasWrapper.clientHeight;
        
        // Calculate the largest size that fits the aspect ratio within available space
        if (availableWidth / availableHeight > simAspectRatio) {
            // Height is the limiting factor
            targetHeight = availableHeight;
            targetWidth = targetHeight * simAspectRatio;
        } else {
            // Width is the limiting factor  
            targetWidth = availableWidth;
            targetHeight = targetWidth / simAspectRatio;
        }
        
        // Set explicit dimensions for fullscreen to ensure proper scaling
        aspectRatioBox.style.width = `${targetWidth}px`;
        aspectRatioBox.style.height = `${targetHeight}px`;
    } else {
        // Not fullscreen: reset inline styles so CSS can take over
        aspectRatioBox.style.width = ''; 
        aspectRatioBox.style.height = ''; 
        
        // Get the computed size based on CSS layout
        const boxRect = aspectRatioBox.getBoundingClientRect();
        targetWidth = boxRect.width;
        targetHeight = boxRect.height;
    }

    targetWidth = Math.max(1, Math.round(targetWidth));
    targetHeight = Math.max(1, Math.round(targetHeight));

    if (targetWidth !== canvasWidth || targetHeight !== canvasHeight) {
        const oldSpacing = spacing; // Capture old global spacing

        canvasWidth = targetWidth;   // Update script's tracked width
        canvasHeight = targetHeight; // Update script's tracked height
        canvas.width = canvasWidth;  // Set drawing buffer width to match display
        canvas.height = canvasHeight; // Set drawing buffer height to match display
        
        if (particles.length > 0) {
            // Recalculate new grid geometry using the helper function
            const newGeom = calculateGridGeometry(canvasWidth, canvasHeight);

            // Adapt existing particles to the new geometry.
            adaptParticlesToResize(oldSpacing, newGeom.spacing, newGeom.diag, newGeom.offsetX, newGeom.offsetY);
            
            // Update global simulation parameters
            spacing = newGeom.spacing;
            diag = newGeom.diag;
            offsetX = newGeom.offsetX;
            offsetY = newGeom.offsetY;
            
            forces = computeForces(); // Recompute forces with new positions and rest lengths
        } else {
            // If there are no particles, re-initialize.
            initializeParticles(); // This will use the new canvasWidth/Height.
            forces = computeForces();
        }
    }
}

