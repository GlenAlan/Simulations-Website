// --- DOM Element References ---
const canvas = document.getElementById('simulationCanvas');
const ctx = canvas ? canvas.getContext('2d') : null;

// Maxwell's Demon specific controls
const particleCountSlider = document.getElementById('particleCount');
const countVal = document.getElementById('countVal');
const speedSlider = document.getElementById('speedSlider');
const speedValEl = document.getElementById('speedVal');
const gateSizeSlider = document.getElementById('gateSizeSlider');
const gateSizeValEl = document.getElementById('gateSizeVal');
// const autoModeCheckbox = document.getElementById('autoMode'); // Replaced by demonModeSelector
const demonModeSelector = document.getElementById('demonModeSelector');
const showChartsCheckbox = document.getElementById('showCharts');
const chartsContainer = document.getElementById('charts-container');

// Stats elements
const leftRedEl = document.getElementById('leftRed');
const leftBlueEl = document.getElementById('leftBlue');
const rightRedEl = document.getElementById('rightRed');
const rightBlueEl = document.getElementById('rightBlue');

const resetButton = document.getElementById('resetSimulationBtn');
const fpsDisplay = document.getElementById('fpsDisplay'); // Added FPS display element


// --- Simulation Constants & Parameters ---
let nPerColor = particleCountSlider ? +particleCountSlider.value : 100;
let speedMultiplier = speedSlider ? +speedSlider.value : 50; // Renamed from ticksPerFrame for clarity with new timing
let gateSizePercent = gateSizeSlider ? +gateSizeSlider.value : 25; // Gate size as percentage (10-90%)
// let autoMode = autoModeCheckbox ? autoModeCheckbox.checked : true; // Replaced by demonMode
let demonMode = demonModeSelector ? demonModeSelector.value : 'automatic'; // 'automatic' or 'manual'

const radius = 5;
const BASE_DT = 1.0 / 60.0; // Target time step for each physics update (approx 60 FPS)
const initialSpeed = 1.5; // Initial speed for particles

// Canvas dimensions (will be updated by handleSimulationResize)
let canvasWidth = 0; // Initialize to 0, will be set by handleSimulationResize
let canvasHeight = 0;
let centerX = 0;

// --- Simulation State Variables ---
let particles = [];
let gateOpen = false;
let mouseDown = false;
let lastTimestamp = 0;
let physicsTimeAccumulator = 0.0; // Accumulator for frame-rate independent physics steps
let currentSimulationTime = 0.0; // Total elapsed simulation time for charts
let physicsStepCounter = 0; // Counter for physics steps to control chart sampling
let lastChartUpdateStep = 0; // Track the last physics step when charts were updated

// FPS calculation
let frameCount = 0;
let lastFpsUpdate = 0;

// Chart.js instances and data
let leftChart, rightChart;
const maxDataPoints = 10000;
let chartTextColor = 'var(--color-text-secondary)'; // Default, will be updated
let chartGridColor = 'var(--color-border)';
let chartTitleColor = 'var(--color-text-primary)'; // Changed to use --color-text-primary

// Function to update chart colors based on current theme
function updateChartColors() {
    const rootStyle = getComputedStyle(document.documentElement);
    chartTextColor = rootStyle.getPropertyValue('--color-text-secondary').trim() || '#aaa';
    chartGridColor = rootStyle.getPropertyValue('--color-border').trim() || 'rgba(255,255,255,0.1)';
    // Ensure chartTitleColor uses the theme's primary text color.
    chartTitleColor = rootStyle.getPropertyValue('--color-text-primary').trim() || (document.documentElement.classList.contains('dark-mode') ? '#fff' : '#333');

    [leftChart, rightChart].forEach(chart => {
        if (chart && chart.options) { // Ensure chart and options exist
            // Update scales colors (axes, ticks, grid lines)
            if (chart.options.scales) {
                if (chart.options.scales.x) {
                    if (chart.options.scales.x.title) chart.options.scales.x.title.color = chartTextColor;
                    if (chart.options.scales.x.ticks) chart.options.scales.x.ticks.color = chartTextColor;
                    if (chart.options.scales.x.grid) chart.options.scales.x.grid.color = chartGridColor;
                }
                if (chart.options.scales.y) {
                    if (chart.options.scales.y.title) chart.options.scales.y.title.color = chartTextColor;
                    if (chart.options.scales.y.ticks) chart.options.scales.y.ticks.color = chartTextColor;
                    if (chart.options.scales.y.grid) chart.options.scales.y.grid.color = chartGridColor;
                }
            }

            // Update plugins colors (title, legend)
            if (chart.options.plugins) {
                if (chart.options.plugins.title) {
                    chart.options.plugins.title.color = chartTitleColor; // Apply theme-based color to title
                }
                if (chart.options.plugins.legend && chart.options.plugins.legend.labels) {
                    chart.options.plugins.legend.labels.color = chartTitleColor; // Legend labels also use this color
                }
            }
            chart.update('none'); // Update chart without animation
        }
    });
}

const chartData = {
    left: { timestamps: [], red: [], blue: [] },
    right: { timestamps: [], red: [], blue: [] },
    startTime: 0, 
    lastUpdateSimTime: 0 // Changed from lastUpdateTime to use simulation time
};

// --- Core Simulation Classes and Functions ---
class Particle {
    constructor(x, y, vx, vy, color) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.color = color;
    }
      
    get energy() {
        return 0.5 * (this.vx * this.vx + this.vy * this.vy);
    }

    get speed() {
        return Math.hypot(this.vx, this.vy);
    }

    setSpeed(newSpeed) {
        if (this.speed === 0) {
            // If speed is zero, give it a small random velocity before setting speed
            const angle = Math.random() * 2 * Math.PI;
            this.vx = Math.cos(angle) * 0.01;
            this.vy = Math.sin(angle) * 0.01;
        }
        const factor = newSpeed / this.speed;
        this.vx *= factor;
        this.vy *= factor;
    }
}

// Helper function to calculate gate size in pixels from percentage
function getGateSizePixels() {
    return (gateSizePercent / 100) * canvasHeight;
}

function initializeSimulationState() {
    if (canvasWidth === 0 || canvasHeight === 0) {
        console.warn("Canvas dimensions not set before init. Attempting resize call.");
        handleSimulationResize(); // Ensure dimensions are set
        if (canvasWidth === 0 || canvasHeight === 0) {
            console.error("Canvas dimensions still zero after resize call. Aborting init.");
            return; // Critical error, cannot proceed
        }
    }
    centerX = canvasWidth / 2;

    particles = [];
    for (let i = 0; i < 2 * nPerColor; i++) {
        const color = i < nPerColor ? 'red' : 'blue';
        
        let x, y, validPosition = false;
        while (!validPosition) {
            x = Math.random() * (canvasWidth - 2 * radius) + radius;
            y = Math.random() * (canvasHeight - 2 * radius) + radius;
            // Ensure not too close to the barrier center line, and not on the exact line
            if (Math.abs(x - centerX) > radius * 2.5) { 
                validPosition = true;
            }
        }
            
        const angle = Math.random() * Math.PI * 2;
        const vx = Math.cos(angle) * initialSpeed;
        const vy = Math.sin(angle) * initialSpeed;
        
        particles.push(new Particle(x, y, vx, vy, color));
    }
  
    chartData.left.timestamps = [];    chartData.left.red = [];
    chartData.left.blue = [];
    chartData.right.timestamps = [];
    chartData.right.red = [];
    chartData.right.blue = [];    chartData.startTime = performance.now();    currentSimulationTime = 0.0; 
    chartData.lastUpdateSimTime = 0.0; // Reset simulation time tracker for chart updates
    physicsStepCounter = 0; // Reset physics step counter
    lastChartUpdateStep = 0; // Reset chart update step tracker
    // Don't force initial zero data points - let the simulation naturally populate the charts
}

function handleWallCollision(p, dtArg) {
    let bounced = false;
    const minSpeed = 0.5;
    const maxSpeed = 5.0; // Increased max speed

    if (p.y - radius < 0) {
        p.y = radius;
        p.vy = -p.vy;
        bounced = true;
    } else if (p.y + radius > canvasHeight) {
        p.y = canvasHeight - radius;
        p.vy = -p.vy;
        bounced = true;
    }

    if (p.x - radius < 0) {
        p.x = radius;
        p.vx = -p.vx;
        bounced = true;
    } else if (p.x + radius > canvasWidth) {
        p.x = canvasWidth - radius;
        p.vx = -p.vx;
        bounced = true;
    }

    if (bounced) {
        const currentSpeed = p.speed;
        const currentAngle = Math.atan2(p.vy, p.vx);
        const perturbation = (Math.random() - 0.5) * 0.2; // Small angle change
        const newAngle = currentAngle + perturbation;
        
        p.vx = Math.cos(newAngle) * currentSpeed;
        p.vy = Math.sin(newAngle) * currentSpeed;
        
        const newSpeedClamped = Math.max(minSpeed, Math.min(p.speed, maxSpeed));
        if (p.speed > 0) p.setSpeed(newSpeedClamped);
    }
    return bounced;
}

function handleBarrierInteraction(p, dtArg) {
    const gateSize = getGateSizePixels();
    const gateY1 = canvasHeight / 2 - gateSize / 2;
    const gateY2 = canvasHeight / 2 + gateSize / 2;

    const nextX = p.x + p.vx * dtArg;
    const crossesBarrier = (p.x < centerX && nextX >= centerX) || (p.x > centerX && nextX <= centerX);

    if (crossesBarrier) {
        // Calculate time to hit the barrier plane
        const tToBarrier = (centerX - p.x) / p.vx;
        const yAtBarrier = p.y + p.vy * tToBarrier;

        const inGateArea = yAtBarrier >= gateY1 && yAtBarrier <= gateY2;

        if (gateOpen && inGateArea) {
            // Allowed to pass
            return false; // No collision
        } else {
            // Hits the closed gate or barrier wall
            p.x = (p.vx > 0) ? centerX - radius - 0.01 : centerX + radius + 0.01;
            p.vx *= -0.98; // Reflect with slight energy loss
            
            // Add perturbation to avoid getting stuck
            const currentSpeed = p.speed;
            if (currentSpeed > 0.1) {
                const angle = Math.atan2(p.vy, p.vx) + (Math.random() - 0.5) * 0.3;
                p.vx = Math.cos(angle) * currentSpeed;
                p.vy = Math.sin(angle) * currentSpeed;
                // Ensure it can escape
                if (Math.abs(p.vx) < 0.2 * currentSpeed) {
                    p.vx = (p.x < centerX ? -1 : 1) * 0.2 * currentSpeed;
                    p.setSpeed(currentSpeed);
                }
            }
            return true; // Collision occurred
        }
    }
    return false; // No collision with barrier this step
}


function runSinglePhysicsStep(dtArgument) { 
    const gateSize = getGateSizePixels();
    const gateY1 = canvasHeight / 2 - gateSize / 2;
    const gateY2 = canvasHeight / 2 + gateSize / 2;

    // if (autoMode) { // Replaced by demonMode check
    if (demonMode === 'automatic') {
        let soonest = null;
        let tMin = Infinity;

        for (const p of particles) {
            if (Math.abs(p.vx) < 0.01) continue; 

            const movingTowardsGate = (p.x < centerX && p.vx > 0) || (p.x > centerX && p.vx < 0);
            if (!movingTowardsGate) continue;

            const t = (centerX - p.x) / p.vx; 
            if (t > 0 && t < tMin) { // Only consider future collisions
                const yAtGate = p.y + p.vy * t; 
                if (yAtGate >= gateY1 && yAtGate <= gateY2) {
                    soonest = p;
                    tMin = t;
                }
            }
        }
        gateOpen = soonest ? 
            (soonest.color === 'red' && soonest.vx > 0 && soonest.x < centerX) || 
            (soonest.color === 'blue' && soonest.vx < 0 && soonest.x > centerX)  
            : false;
    } else { // Manual mode
        gateOpen = mouseDown;
    }

    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        
        // Store previous position for collision detection (not strictly needed with current barrier logic but good practice)
        // const prevX = p.x;
        // const prevY = p.y;
        
        p.x += p.vx * dtArgument;
        p.y += p.vy * dtArgument;
        
        handleWallCollision(p, dtArgument);
        handleBarrierInteraction(p, dtArgument);
        
        const currentSpeed = p.speed;
        const minSpeed = 0.5;
        const maxSpeed = 5.0; 
        if (currentSpeed < minSpeed && minSpeed > 0) p.setSpeed(minSpeed);
        else if (currentSpeed > maxSpeed) p.setSpeed(maxSpeed);    }

    currentSimulationTime += dtArgument; 
    physicsStepCounter++; // Increment physics step counter for chart sampling
}

function updateCharts(leftRed, leftBlue, rightRed, rightBlue, realTimestamp, forceUpdate = false) {
    // Ensure essential chart-related elements exist before proceeding.
    if (!leftChart || !rightChart || !showChartsCheckbox) {
        return;
    }
    const simTimeSeconds = currentSimulationTime;

    const updateIntervalSteps = 1000; // Update every 1000 physics steps
    if (forceUpdate || chartData.left.timestamps.length === 0 ||
        physicsStepCounter - lastChartUpdateStep >= updateIntervalSteps) {

        lastChartUpdateStep = physicsStepCounter; // Track when we last updated
        chartData.lastUpdateSimTime = simTimeSeconds;

        chartData.left.timestamps.push(simTimeSeconds);
        chartData.right.timestamps.push(simTimeSeconds);
        chartData.left.red.push(leftRed);
        chartData.left.blue.push(leftBlue);
        chartData.right.red.push(rightRed);
        chartData.right.blue.push(rightBlue);

        if (chartData.left.timestamps.length > maxDataPoints) {
            chartData.left.timestamps.shift();
            chartData.left.red.shift();
            chartData.left.blue.shift();
            chartData.right.timestamps.shift();
            chartData.right.red.shift();
            chartData.right.blue.shift();
        }

        // Conditional rendering: only update Chart.js instances if charts are visible or update is forced.
        if (showChartsCheckbox.checked || forceUpdate) { 
            const timeRange = {
                min: 0,
                max: Math.max(10, simTimeSeconds) 
            };

            [leftChart, rightChart].forEach(chart => {
                if (chart && chart.options && chart.options.scales && chart.options.scales.x) {
                    chart.options.scales.x.min = timeRange.min;
                    chart.options.scales.x.max = timeRange.max;
                }
            });

            if (leftChart && leftChart.data) {
                leftChart.data.labels = chartData.left.timestamps;
                leftChart.data.datasets[0].data = chartData.left.red;
                leftChart.data.datasets[1].data = chartData.left.blue;
                leftChart.update('none'); 
            }
            
            if (rightChart && rightChart.data) {
                rightChart.data.labels = chartData.right.timestamps;
                rightChart.data.datasets[0].data = chartData.right.red;
                rightChart.data.datasets[1].data = chartData.right.blue;
                rightChart.update('none');
            }
        }
    }
}

function renderSimulation() { 
    if (!ctx) return;

    const gateSize = getGateSizePixels();
    const gateY1 = canvasHeight / 2 - gateSize / 2;
    const gateY2 = canvasHeight / 2 + gateSize / 2;

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const barrierColor = getComputedStyle(document.documentElement).getPropertyValue('--color-border-dark').trim() || '#444';
    ctx.strokeStyle = barrierColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, gateY1);
    ctx.moveTo(centerX, gateY2);
    ctx.lineTo(centerX, canvasHeight);    ctx.stroke();

    if (!gateOpen) {
        ctx.strokeStyle = 'purple'; // Changed to purple
        ctx.beginPath();
        ctx.moveTo(centerX, gateY1);
        ctx.lineTo(centerX, gateY2);
        ctx.stroke(); 
    } //else {
      //  ctx.strokeStyle = 'purple'; // Changed to purple
      //  ctx.setLineDash([2, 2]);
      //  ctx.beginPath();
      //  ctx.moveTo(centerX, gateY1);
      //  ctx.lineTo(centerX, gateY2);
      //  ctx.stroke();
      //  ctx.setLineDash([]); 
    //}

    let leftRed = 0, leftBlue = 0, rightRed = 0, rightBlue = 0;

    particles.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        if (p.color === 'red') {
            ctx.fillStyle = 'rgba(255, 0, 0, 0.85)'; // Brighter red
        } else if (p.color === 'blue') {
            ctx.fillStyle = 'rgba(0, 100, 255, 0.85)'; // Brighter blue
        } else {
            ctx.fillStyle = 'grey'; 
        }
        ctx.fill();

        if (p.x < centerX) {
            if (p.color === 'red') leftRed++; else leftBlue++;
        } else {
            if (p.color === 'red') rightRed++; else rightBlue++;
        }
    });

    if (leftRedEl) leftRedEl.textContent = leftRed;
    if (leftBlueEl) leftBlueEl.textContent = leftBlue;
    if (rightRedEl) rightRedEl.textContent = rightRed;
    if (rightBlueEl) rightBlueEl.textContent = rightBlue;

    // Always call updateCharts to accumulate data.
    // The updateCharts function itself will decide whether to render based on visibility.
    updateCharts(leftRed, leftBlue, rightRed, rightBlue, performance.now());
}

// --- Main Animation Loop & Setup ---
const MAX_PHYSICS_STEPS_PER_FRAME = 1000; // Max physics updates per animation frame

function animate(timestamp) {
    if (!ctx || !canvas) return; 

    const elapsedRealSeconds = (timestamp - (lastTimestamp || timestamp)) / 1000.0;
    lastTimestamp = timestamp;

    // FPS Calculation
    frameCount++;
    if (timestamp - lastFpsUpdate > 1000) { // Update FPS display every second
        const fps = frameCount / ((timestamp - lastFpsUpdate) / 1000);
        if (fpsDisplay) fpsDisplay.textContent = `FPS: ${fps.toFixed(0)}`;
        frameCount = 0;
        lastFpsUpdate = timestamp;
    }

    // Accumulate time scaled by the speed multiplier.
    physicsTimeAccumulator += elapsedRealSeconds * speedMultiplier;

    let physicsStepsTakenThisFrame = 0;

    while (physicsTimeAccumulator >= BASE_DT && physicsStepsTakenThisFrame < MAX_PHYSICS_STEPS_PER_FRAME) {
        runSinglePhysicsStep(BASE_DT); 
        physicsTimeAccumulator -= BASE_DT;
        physicsStepsTakenThisFrame++;
    }
    if (physicsStepsTakenThisFrame >= MAX_PHYSICS_STEPS_PER_FRAME) {
        physicsTimeAccumulator = 0; // Avoid runaway loop if lagging badly
    }

    renderSimulation();
    requestAnimationFrame(animate);
}


function setupCharts() {
    const leftChartCanvas = document.getElementById('leftChart');
    const rightChartCanvas = document.getElementById('rightChart');
    if (!leftChartCanvas || !rightChartCanvas) return;

    updateChartColors(); // Initial color setup

    const commonChartOptions = (titleText) => ({
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            title: {
                display: true,
                text: titleText,
                color: chartTitleColor // Set by updateChartColors
            },
            legend: {
                labels: {
                    color: chartTitleColor // Set by updateChartColors
                }
            }
        },
        scales: {
            x: {
                type: 'linear',
                position: 'bottom',
                title: {
                    display: true,
                    text: 'Simulation Time (s)',
                    color: chartTextColor // Set by updateChartColors
                },
                min: 0,
                max: 10, 
                ticks: { 
                    color: chartTextColor, // Set by updateChartColors
                    maxTicksLimit: 10,
                    callback: function(value) {
                        return (value).toFixed(0);
                    }
                },
                grid: { color: chartGridColor } // Set by updateChartColors
            },
            y: {
                beginAtZero: true,
                title: { // Added Y-axis title for completeness, can be removed if not needed
                    display: true,
                    text: 'Particle Count',
                    color: chartTextColor
                },
                ticks: { color: chartTextColor }, // Set by updateChartColors
                grid: { color: chartGridColor } // Set by updateChartColors
            }
        },
    });
    
    const datasetDefaults = (label, borderColor, bgColor) => ({
        label: label,
        data: [],
        borderColor: borderColor,
        backgroundColor: bgColor,
        fill: true,
        tension: 0.2
    });

    if (leftChart) leftChart.destroy();
    leftChart = new Chart(leftChartCanvas, {
        type: 'line',
        data: {
            labels: [], // Timestamps
            datasets: [
                datasetDefaults('Red Particles', 'rgba(255, 0, 0, 0.8)', 'rgba(255, 0, 0, 0.2)'),
                datasetDefaults('Blue Particles', 'rgba(0, 100, 255, 0.8)', 'rgba(0, 100, 255, 0.2)')
            ]
        },
        options: commonChartOptions('Left Chamber')
    });

    if (rightChart) rightChart.destroy();
    rightChart = new Chart(rightChartCanvas, {
        type: 'line',
        data: {
            labels: [], // Timestamps
            datasets: [
                datasetDefaults('Red Particles', 'rgba(255, 0, 0, 0.8)', 'rgba(255, 0, 0, 0.2)'),
                datasetDefaults('Blue Particles', 'rgba(0, 100, 255, 0.8)', 'rgba(0, 100, 255, 0.2)')
            ]
        },
        options: commonChartOptions('Right Chamber')
    });
}

function handleSimulationResize() {
    if (!canvas) return;
    const oldWidth = canvasWidth;
    const oldHeight = canvasHeight;

    const aspectRatioBox = canvas.parentElement; // .sim-aspect-ratio-box
    if (!aspectRatioBox) return;

    const isFullscreen = document.body.classList.contains('sim-fullscreen-active');
    let targetWidth, targetHeight;

    // Get aspect ratio from CSS custom property
    const simStyle = getComputedStyle(aspectRatioBox);
    const simAspectRatioString = simStyle.getPropertyValue('--aspect-ratio').trim();
    let simAspectRatio = 2; // Default for Maxwell's Demon (2/1)
    if (simAspectRatioString) {
        const parts = simAspectRatioString.split('/');
        if (parts.length === 2 && parseFloat(parts[1]) !== 0) {
            simAspectRatio = parseFloat(parts[0]) / parseFloat(parts[1]);
        } else if (parts.length === 1) {
            simAspectRatio = parseFloat(simAspectRatioString);
        }
    }    if (isNaN(simAspectRatio) || simAspectRatio <= 0) simAspectRatio = 2;
    
    if (isFullscreen) {
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

    const dpr = window.devicePixelRatio || 1;

    canvasWidth = targetWidth;
    canvasHeight = targetHeight;

    canvas.width = Math.round(canvasWidth * dpr);
    canvas.height = Math.round(canvasHeight * dpr);

    ctx.scale(dpr, dpr); // Scale context to account for high DPI

    centerX = canvasWidth / 2; // Update centerX based on new logical width

    // If simulation has started and dimensions changed, adapt particles
    if (particles.length > 0 && (oldWidth !== canvasWidth || oldHeight !== canvasHeight)) {
        // Simple rescaling of particle positions. More complex logic might be needed.
        const scaleX = canvasWidth / oldWidth;
        const scaleY = canvasHeight / oldHeight;
        if (oldWidth > 0 && oldHeight > 0) { // Avoid division by zero if initialized hidden
             particles.forEach(p => {
                p.x *= scaleX;
                p.y *= scaleY;
                // Clamp particles to new bounds if they somehow end up outside
                p.x = Math.max(radius, Math.min(p.x, canvasWidth - radius));
                p.y = Math.max(radius, Math.min(p.y, canvasHeight - radius));
            });
        }
    }
    // No need to re-initialize if particles exist, just adapt.
    // If it's the very first call and particles are not yet initialized, 
    // initializeSimulationState will handle it after this.
}

function fullResetAndRestart() {
    // Reset timing variables
    lastTimestamp = 0;
    physicsTimeAccumulator = 0.0;
    currentSimulationTime = 0.0;
    frameCount = 0;
    lastFpsUpdate = performance.now(); // Reset FPS counter start time

    // Re-initialize simulation state (which also handles canvas dimensions)
    initializeSimulationState();    // Charts are re-initialized by setupCharts if needed, or updated.
    if (showChartsCheckbox && showChartsCheckbox.checked) {
        setupCharts(); // Re-setup charts to clear data and apply new colors if theme changed
        // Don't force initial zero data points - let the simulation naturally populate the charts
    } else if (chartsContainer) {
        chartsContainer.style.display = 'none';
    }
}

// --- Event Listeners & Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    if (!canvas || !ctx) {
        console.error("Canvas or context not found. Maxwell's Demon simulation cannot start.");
        return;
    }

    // Initial resize and setup
    handleSimulationResize(); // Set initial canvas size based on CSS/container
    setupCharts(); // Setup charts initially
    initializeSimulationState(); // Initialize particles and other sim state
    
    // Event Listeners for controls
    if (particleCountSlider) {
        particleCountSlider.oninput = () => {
            nPerColor = +particleCountSlider.value; 
            if(countVal) countVal.textContent = nPerColor; 
            fullResetAndRestart();
        };
        if(countVal) countVal.textContent = nPerColor; // Initial display
    }
    
    // if (autoModeCheckbox) { // Replaced by demonModeSelector logic
    //     autoModeCheckbox.onchange = () => {
    //         autoMode = autoModeCheckbox.checked;
    //         // No need to reset, mode changes dynamically
    //     };
    // }
    if (demonModeSelector) {
        demonModeSelector.onchange = () => {
            demonMode = demonModeSelector.value;
            // No need to reset, mode changes dynamically
        };
        demonMode = demonModeSelector.value; // Initialize with current selection
    }
    
    if (speedSlider) {
        speedSlider.oninput = () => {
            speedMultiplier = +speedSlider.value;
            if(speedValEl) speedValEl.textContent = speedMultiplier;
            // No need to reset, speed changes dynamically
        };
        if(speedValEl) speedValEl.textContent = speedMultiplier; // Initial display
    }
      if (gateSizeSlider) {
        gateSizeSlider.oninput = () => {
            gateSizePercent = +gateSizeSlider.value;
            if(gateSizeValEl) gateSizeValEl.textContent = gateSizePercent;
            // No need to reset, gate size changes dynamically
        };
        if(gateSizeValEl) gateSizeValEl.textContent = gateSizePercent; // Initial display
    }if (showChartsCheckbox && chartsContainer) {
        showChartsCheckbox.onchange = () => {
            chartsContainer.style.display = showChartsCheckbox.checked ? 'block' : 'none'; // Or 'flex' if that's the desired display type
            
            // Add/remove charts-visible class for CSS styling
            if (showChartsCheckbox.checked) {
                document.body.classList.add('charts-visible');
                setupCharts(); // Re-setup charts to ensure they are fresh and colors are correct
                // Force an update with current counts if available
                const lRed = parseInt(leftRedEl.textContent) || 0;
                const lBlue = parseInt(leftBlueEl.textContent) || 0;
                const rRed = parseInt(rightRedEl.textContent) || 0;
                const rBlue = parseInt(rightBlueEl.textContent) || 0;
                updateCharts(lRed, lBlue, rRed, rBlue, performance.now(), true);
            } else {
                document.body.classList.remove('charts-visible');
            }
            
            // Trigger canvas resize to adjust simulation size when charts are toggled in fullscreen
            const isFullscreen = document.body.classList.contains('sim-fullscreen-active');
            if (isFullscreen) {
                // Use setTimeout to allow charts container to render before resize calculation
                setTimeout(() => {
                    handleSimulationResize();
                }, 50);
            }        };
        chartsContainer.style.display = showChartsCheckbox.checked ? 'block' : 'none'; // Initial state
        
        // Set initial charts-visible class state
        if (showChartsCheckbox.checked) {
            document.body.classList.add('charts-visible');
        } else {
            document.body.classList.remove('charts-visible');
        }
    }

    if (resetButton) {
        resetButton.addEventListener('click', fullResetAndRestart);
    }

    // Mouse interaction for manual gate control
    if (canvas) {
        canvas.addEventListener('mousedown', (e) => { 
            if (e.button === 0) mouseDown = true; 
        });
        canvas.addEventListener('mouseup', (e) => { 
            if (e.button === 0) mouseDown = false; 
        });
        canvas.addEventListener('mouseleave', () => { 
            mouseDown = false; // Also close gate if mouse leaves canvas while pressed
        });
    }

    // Resize listener
    window.addEventListener('resize', () => {
        handleSimulationResize();
        // Charts might need redrawing if their container size changed, 
        // Chart.js responsive option should handle this, but colors might need update.
        if (showChartsCheckbox && showChartsCheckbox.checked) {
            updateChartColors(); // Ensure colors are correct after resize/theme change
            // Charts will be updated in the next animation frame or by updateCharts call
        }
    });

    // Theme change listener (from main.js or simulation_ui.js)
    document.addEventListener('themeChanged', () => {
        if (showChartsCheckbox && showChartsCheckbox.checked) {
            updateChartColors();
        }
        // The renderSimulation function already picks up theme colors for canvas elements dynamically.
    });

    // Start the animation loop
    lastTimestamp = performance.now(); // Initialize lastTimestamp before first animate call
    lastFpsUpdate = lastTimestamp; // Initialize FPS update time
    requestAnimationFrame(animate);
});
