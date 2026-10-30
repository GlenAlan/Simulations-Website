// Thermal Radiation Simulation Core Logic
// Based on simulation_template_core.js structure

// --- DOM Element References ---
const canvas = document.getElementById('simulationCanvas');
const ctx = canvas ? canvas.getContext('2d') : null;

// Control elements
const timeSlider = document.getElementById('timeScale');
const timeScaleVal = document.getElementById('timeScaleVal');
const temperatureSlider = document.getElementById('temperature');
const temperatureVal = document.getElementById('temperatureVal');
const intensitySlider = document.getElementById('intensity');
const intensityVal = document.getElementById('intensityVal');
const distanceSlider = document.getElementById('distance');
const distanceVal = document.getElementById('distanceVal');
const coolingRateSlider = document.getElementById('coolingRate');
const coolingRateVal = document.getElementById('coolingRateVal');
const objectTypeSelector = document.getElementById('objectTypeSelector');
const absorbedEnergyDisplay = document.getElementById('absorbedEnergyVal');
const emissionRateDisplay = document.getElementById('emissionRateVal');
const resetButton = document.getElementById('resetSimulationBtn');

// --- Simulation Constants & Parameters ---
let timeScale = timeSlider ? parseFloat(timeSlider.value) : 1.0;
let temperature = temperatureSlider ? parseFloat(temperatureSlider.value) : 3000; // Kelvin - updated default to 3000K
let intensity = intensitySlider ? parseFloat(intensitySlider.value) : 50; // Percentage (0-100)
let objectDistancePercent = distanceSlider ? parseFloat(distanceSlider.value) : 50; // Percentage of canvas width (25-90%)
let objectType = objectTypeSelector ? objectTypeSelector.value : 'metal';

// Object temperature and cooling parameters
let objectTemperature = 293; // Start at room temperature (20°C)
let passiveCoolingRate = coolingRateSlider ? parseFloat(coolingRateSlider.value) : 0.5; // Watts of cooling per second (adjustable)
let ambientTemperature = 293; // Room temperature in Kelvin (20°C)

// Canvas dimensions
let canvasWidth = 800;
let canvasHeight = 400;

// Performance caps
const MAX_PHOTONS = 2500; // Cap total photons for performance
const PHOTON_DENSITY_REDUCTION = 0.001; // Reduce overall photon density

// Physics constants
const STEFAN_BOLTZMANN = 5.67e-8; // Stefan-Boltzmann constant (W⋅m−2⋅K−4)
const WIENS_CONSTANT = 2.898e-3; // Wien's displacement law constant (m⋅K)
const PLANCK_CONSTANT = 6.626e-34; // Planck constant (J⋅s)
const SPEED_OF_LIGHT = 3e8; // Speed of light (m/s)
const BOLTZMANN_CONSTANT = 1.381e-23; // Boltzmann constant (J/K)
const REFERENCE_UPDATES_PER_SECOND = 60.0;
const BASE_DT = 1.0 / REFERENCE_UPDATES_PER_SECOND;

// Base scaling constants (these will be scaled with canvas size)
const BASE_SOURCE_RADIUS = 30;
const BASE_SOURCE_X_RATIO = 0.125; // SOURCE_X as ratio of canvas width (100/800 = 0.125)
const BASE_OBJECT_WIDTH = 40;
const BASE_OBJECT_HEIGHT = 60;
const MIN_SOURCE_RADIUS = 10; // Minimum source radius
const MIN_OBJECT_SIZE = 15; // Minimum object size

// Dynamic scaled properties (updated by calculateRadiationGeometry)
let sourceRadius = BASE_SOURCE_RADIUS;
let sourceX = BASE_SOURCE_X_RATIO * canvasWidth;
let objectWidth = BASE_OBJECT_WIDTH;
let objectHeight = BASE_OBJECT_HEIGHT;

// Material properties with realistic absorption coefficients and thermal properties
const MATERIAL_PROPERTIES = {
    metal: { 
        absorption: 0.9, 
        color: '#888888', 
        name: 'Metal', 
        emissivity: 0.95,
        thermalMass: 500, // J/K (heat capacity)
        thermalConductivity: 0.8 // Thermal conductivity factor
    },
    glass: { 
        absorption: 0.6, 
        color: '#CCE5FF', 
        name: 'Glass', 
        emissivity: 0.85,
        thermalMass: 800, // J/K
        thermalConductivity: 0.3
    },
    plastic: { 
        absorption: 0.3, 
        color: '#FFB366', 
        name: 'Plastic', 
        emissivity: 0.90,
        thermalMass: 200, // J/K  
        thermalConductivity: 0.1
    }
};

// Distance scaling (convert pixels to realistic units for display)
const DISTANCE_SCALE = 0.002; // 1 pixel = 2 mm (for meter display)
const MAX_DISTANCE_CM = 350; // Maximum distance in centimeters

// --- Simulation State Variables ---
let photons = [];
let absorbedEnergy = 0;
let absorbedEnergyRate = 0; // Power (energy per unit time)
let energyAbsorptionHistory = []; // Track recent absorptions for smoothing
let totalPhotonsEmitted = 0;
let theoreticalPhotonsEmitted = 0; // Track what should have been emitted without cap
let photonScalingFactor = 1.0; // Correction factor for capped photons
let lastTimestamp = 0;
let physicsStepAccumulator = 0.0;
let currentFPS = 0;
let frameCount = 0;
let fpsTimer = 0;
let lastFPSUpdate = 0;

// Helper function to calculate radiation geometry based on canvas size
function calculateRadiationGeometry(currentCanvasWidth, currentCanvasHeight) {
    // Calculate scaled source radius based on canvas dimensions
    // Use the smaller dimension to ensure source fits well
    const baseCanvasSize = Math.min(currentCanvasWidth, currentCanvasHeight);
    const scaleFactor = baseCanvasSize / 400; // 400 is the reference height
    
    const calculatedSourceRadius = Math.max(MIN_SOURCE_RADIUS, BASE_SOURCE_RADIUS * scaleFactor);
    
    // Calculate source X position as a ratio of canvas width
    const calculatedSourceX = BASE_SOURCE_X_RATIO * currentCanvasWidth;
    
    // Scale object dimensions proportionally
    const calculatedObjectWidth = Math.max(MIN_OBJECT_SIZE, BASE_OBJECT_WIDTH * scaleFactor);
    const calculatedObjectHeight = Math.max(MIN_OBJECT_SIZE * 1.5, BASE_OBJECT_HEIGHT * scaleFactor);
    
    return {
        sourceRadius: calculatedSourceRadius,
        sourceX: calculatedSourceX,
        objectWidth: calculatedObjectWidth,
        objectHeight: calculatedObjectHeight,
        scaleFactor: scaleFactor
    };
}

// Function to update global radiation geometry variables
function updateRadiationGeometry() {
    const geom = calculateRadiationGeometry(canvasWidth, canvasHeight);
    sourceRadius = geom.sourceRadius;
    sourceX = geom.sourceX;
    objectWidth = geom.objectWidth;
    objectHeight = geom.objectHeight;
}

// Helper function to convert temperature to wavelength using Wien's law
function temperatureToWavelength(temp) {
    return WIENS_CONSTANT / temp; // Returns wavelength in meters
}

// Helper function to convert wavelength to RGB color
function wavelengthToRGB(wavelength) {
    // Convert wavelength from meters to nanometers
    const wavelengthNm = wavelength * 1e9;
    
    let red = 0, green = 0, blue = 0;
    
    // Use continuous mathematical functions instead of discrete ranges
    // This eliminates the discontinuity at 780nm boundary
    
    if (wavelengthNm < 200) {
        // Extreme UV - brilliant white
        red = 1.0;
        green = 1.0;
        blue = 1.0;
    } else if (wavelengthNm < 380) {
        // UV range - transition from white to violet
        const t = (wavelengthNm - 200) / (380 - 200);
        // Smooth transition using cosine interpolation
        const smoothT = 0.5 * (1 - Math.cos(t * Math.PI));
        red = 1.0 - 0.7 * smoothT;      // 1.0 → 0.3
        green = 1.0 - 0.8 * smoothT;    // 1.0 → 0.2  
        blue = 1.0;                     // Constant blue
    } else if (wavelengthNm <= 780) {
        // Visible spectrum - use continuous sine/cosine functions
        // This creates smooth color transitions without discrete boundaries
        
        if (wavelengthNm <= 440) {
            // Violet to blue (380-440nm)
            const t = (wavelengthNm - 380) / (440 - 380);
            red = 0.3 * (1 - t);  // Violet component fades
            green = 0.0;
            blue = 1.0;
        } else if (wavelengthNm <= 490) {
            // Blue to cyan (440-490nm)
            const t = (wavelengthNm - 440) / (490 - 440);
            red = 0.0;
            green = t;              // Green rises
            blue = 1.0;
        } else if (wavelengthNm <= 510) {
            // Cyan to green (490-510nm)
            const t = (wavelengthNm - 490) / (510 - 490);
            red = 0.0;
            green = 1.0;
            blue = 1.0 - t;         // Blue fades
        } else if (wavelengthNm <= 580) {
            // Green to yellow (510-580nm)
            const t = (wavelengthNm - 510) / (580 - 510);
            red = t;                // Red rises
            green = 1.0;
            blue = 0.0;
        } else if (wavelengthNm <= 645) {
            // Yellow to red (580-645nm)
            const t = (wavelengthNm - 580) / (645 - 580);
            red = 1.0;
            green = 1.0 - t;        // Green fades
            blue = 0.0;
        } else {
            // Pure red (645-780nm) - completely smooth
            red = 1.0;
            green = 0.0;
            blue = 0.0;
        }    } else {
        // Infrared - continuous decay from red with enhanced visibility
        // Use slower exponential decay for better visibility
        const irWavelength = wavelengthNm - 780;
        const decayFactor = Math.exp(-irWavelength / 3500); // Slower decay for more visibility
        red = 1.0 * decayFactor + 0.6 * (1 - decayFactor);  // 1.0 → 0.6 (brighter minimum)
        green = 0.1 * decayFactor; // Add slight green component for warmer infrared
        blue = 0.0;
    }
    
    // Apply smooth visibility attenuation at spectrum edges
    let visibilityFactor = 1.0;
    
    if (wavelengthNm < 420) {
        // Smooth UV attenuation
        const t = Math.max(0, (wavelengthNm - 350) / (420 - 350));
        visibilityFactor = 0.1 + 0.9 * (0.5 * (1 - Math.cos(t * Math.PI)));
    } else if (wavelengthNm > 700) {
        // Smooth infrared attenuation - NO DISCONTINUITY at 780nm
        const t = Math.min(1, (wavelengthNm - 700) / (900 - 700));
        visibilityFactor = 1.0 - 0.7 * (0.5 * (1 - Math.cos(t * Math.PI)));
    }
    
    // Apply brightness scaling
    red *= visibilityFactor;
    green *= visibilityFactor;
    blue *= visibilityFactor;
    
    // Convert to 0-255 range with proper clamping
    red = Math.min(255, Math.max(0, Math.round(red * 255)));
    green = Math.min(255, Math.max(0, Math.round(green * 255)));
    blue = Math.min(255, Math.max(0, Math.round(blue * 255)));
    
    return { r: red, g: green, b: blue };
}

// Helper function to get realistic thermal color based on temperature
function getThermalColor(temp) {
    const wavelength = temperatureToWavelength(temp);
    const rgb = wavelengthToRGB(wavelength);
    return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
}

// Convert distance from pixels to meters for display
function pixelsToMeters(pixels) {
    return pixels * DISTANCE_SCALE;
}

// Calculate Planck's blackbody radiation distribution
function planckDistribution(wavelength, temperature) {
    const h = PLANCK_CONSTANT;
    const c = SPEED_OF_LIGHT;
    const k = BOLTZMANN_CONSTANT;
    
    const factor1 = (2 * h * c * c) / Math.pow(wavelength, 5);
    const factor2 = 1 / (Math.exp((h * c) / (wavelength * k * temperature)) - 1);
    
    return factor1 * factor2;
}
// Photon class
class Photon {
    constructor(x, y, vx, vy, energy, wavelength) {
        this.x = x;
        this.y = y;
        this.vx = vx; // Don't apply time scale here - apply in update
        this.vy = vy;
        this.energy = energy;
        this.wavelength = wavelength;
        this.age = 0;
        this.maxAge = 10.0; // Seconds before photon disappears
        this.absorbed = false;
    }
    
    update(deltaTime) {
        // Delta-time based movement with time scaling
        const dt = deltaTime * timeScale;
        this.x += this.vx * dt * 60; // Scale to 60fps equivalent
        this.y += this.vy * dt * 60;
        this.age += dt;
        
        // Check if photon is absorbed by object
        this.checkAbsorption();
        
        // Remove if too old or off screen
        if (this.age > this.maxAge || 
            this.x < 0 || this.x > canvasWidth || 
            this.y < 0 || this.y > canvasHeight ||
            this.absorbed) {
            return false; // Mark for removal
        }
        return true; // Keep photon
    }    checkAbsorption() {
        const objectX = getObjectDistancePixels();
        const objectY = (canvasHeight - objectHeight) / 2;
        
        // Check collision with absorption object
        if (this.x >= objectX && this.x <= objectX + objectWidth &&
            this.y >= objectY && this.y <= objectY + objectHeight) {
            
            const material = MATERIAL_PROPERTIES[objectType];
            if (Math.random() < material.absorption) {
                // Apply scaling factor to correct for photon cap limitation
                const correctedEnergy = this.energy * photonScalingFactor;
                absorbedEnergy += correctedEnergy;
                
                // Track absorption with timestamp for power calculation
                energyAbsorptionHistory.push({
                    energy: correctedEnergy,
                    timestamp: Date.now()
                });
                  // Heat up the object based on absorbed energy
                // Convert absorbed energy to temperature increase using thermal mass
                const tempIncrease = correctedEnergy / material.thermalMass;
                
                // Apply temperature cap to prevent thermodynamic violation
                // Object cannot exceed source temperature (thermal equilibrium principle)
                const newTemperature = objectTemperature + tempIncrease;
                objectTemperature = Math.min(newTemperature, temperature);
                
                this.absorbed = true;
            }
        }
    }render() {
        if (this.absorbed) return;
        
        // Use wavelength-based color for realistic physics
        const rgb = wavelengthToRGB(this.wavelength);
        const alpha = Math.max(0.3, 1 - this.age / this.maxAge);
          // Enhanced brightness based on energy, intensity, and temperature
        const energyFactor = Math.min(this.energy / 100, 1);
        const intensityFactor = intensity / 100;
        const temperatureFactor = Math.min(temperature / 1000, 3.0); // Increased to match source rendering
        const brightness = energyFactor * intensityFactor * temperatureFactor;
        
        // Apply brightness with higher minimum visibility for thermal radiation
        const minBrightness = 0.4; // Increased from 0.1
        const effectiveBrightness = minBrightness + brightness * (1 - minBrightness);
        
        // Additional brightness boost for thermal radiation visibility
        const thermalBoost = 1.5;
        const finalBrightness = Math.min(1.0, effectiveBrightness * thermalBoost);
        
        const r = Math.round(rgb.r * finalBrightness);
        const g = Math.round(rgb.g * finalBrightness);
        const b = Math.round(rgb.b * finalBrightness);
        
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
        ctx.beginPath();
        
        // Larger, more visible photons
        const baseRadius = 1.2; // Increased from 0.8
        const energySize = energyFactor * 1.5; // Increased from 1.2
        const intensitySize = intensityFactor * 1.0; // Increased from 0.8
        const radius = baseRadius + energySize + intensitySize;
        ctx.arc(this.x, this.y, radius, 0, Math.PI * 2);
        ctx.fill();
        
        // Enhanced glow for better visibility
        if (brightness > 0.2) { // Lower threshold for glow
            const glowAlpha = alpha * finalBrightness * 0.25; // Increased glow intensity
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${glowAlpha})`;
            ctx.beginPath();
            ctx.arc(this.x, this.y, radius + 4, 0, Math.PI * 2); // Larger glow
            ctx.fill();
        }
    }
}

// --- Core Simulation Functions ---

function initializeSimulationState() {
    photons.length = 0;
    absorbedEnergy = 0;
    absorbedEnergyRate = 0;
    energyAbsorptionHistory = [];
    totalPhotonsEmitted = 0;
    theoreticalPhotonsEmitted = 0;
    photonScalingFactor = 1.0;
    objectTemperature = ambientTemperature; // Reset object to ambient temperature
}

function adaptSimulationToResize(oldWidth, oldHeight, newWidth, newHeight) {
    if (oldWidth <= 0 || oldHeight <= 0 || newWidth <= 0 || newHeight <= 0) return;
    
    // Calculate old and new geometries
    const oldGeom = calculateRadiationGeometry(oldWidth, oldHeight);
    const newGeom = calculateRadiationGeometry(newWidth, newHeight);
    
    // Scale photon positions proportionally
    const scaleX = newWidth / oldWidth;
    const scaleY = newHeight / oldHeight;
    
    // Scale photon speeds based on geometry scale factor
    const speedScaleFactor = newGeom.scaleFactor / oldGeom.scaleFactor;
    
    photons.forEach(photon => {
        // Scale positions
        photon.x *= scaleX;
        photon.y *= scaleY;
        
        // Scale velocities to maintain proportional movement
        photon.vx *= speedScaleFactor;
        photon.vy *= speedScaleFactor;
    });
    
    // Update global geometry variables
    updateRadiationGeometry();
}

// Comprehensive resize handler for radiation simulation
function handleRadiationResize() {
    if (!canvas) return;
    
    const aspectRatioBox = canvas.parentElement;
    let newWidth, newHeight;
    
    if (aspectRatioBox && aspectRatioBox.classList.contains('sim-aspect-ratio-box')) {
        newWidth = aspectRatioBox.clientWidth;
        newHeight = aspectRatioBox.clientHeight;
    } else {
        newWidth = canvas.clientWidth || 800;
        newHeight = canvas.clientHeight || 400;
    }
    
    // Only resize if dimensions actually changed
    if (newWidth !== canvasWidth || newHeight !== canvasHeight) {
        const oldWidth = canvasWidth;
        const oldHeight = canvasHeight;
        
        canvasWidth = newWidth;
        canvasHeight = newHeight;
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        
        adaptSimulationToResize(oldWidth, oldHeight, canvasWidth, canvasHeight);
    }
}

function emitPhotons() {
    // Calculate emission rate based on Stefan-Boltzmann law
    // Stefan-Boltzmann law: Power ∝ T^4
    const baseEmissionRate = Math.pow(temperature / 300, 4) * (intensity / 100);
    const theoreticalPhotonsPerFrame = baseEmissionRate * 1.2 * PHOTON_DENSITY_REDUCTION;
    
    // Track theoretical total (what should be emitted without performance cap)
    theoreticalPhotonsEmitted += theoreticalPhotonsPerFrame;
    
    // Performance cap: limit actual visual photons
    if (photons.length >= MAX_PHOTONS) {
        // Still track theoretical emissions but don't create visual photons
        return;
    }
    
    // Emit photons from random points on the source surface
    const numPhotonsToEmit = Math.min(
        Math.floor(theoreticalPhotonsPerFrame) + (Math.random() < (theoreticalPhotonsPerFrame % 1) ? 1 : 0),
        MAX_PHOTONS - photons.length // Don't exceed maximum
    );
    
    // Calculate scaling factor for energy correction
    photonScalingFactor = theoreticalPhotonsEmitted / Math.max(totalPhotonsEmitted || 1, 1);
      for (let i = 0; i < numPhotonsToEmit; i++) {
        // Random point on source surface (uniform distribution in circle)
        const sourceRadiusRandom = sourceRadius * Math.sqrt(Math.random());
        const sourceAngle = Math.random() * Math.PI * 2;
        
        const startX = sourceX + Math.cos(sourceAngle) * sourceRadiusRandom;
        const startY = canvasHeight / 2 + Math.sin(sourceAngle) * sourceRadiusRandom;
        
        // Random emission direction (isotropic radiation - all directions equally likely)
        const emissionAngle = Math.random() * Math.PI * 2;
        const speed = 2.0 + Math.random() * 3.0; // Variable photon speed for realism
        const vx = Math.cos(emissionAngle) * speed;
        const vy = Math.sin(emissionAngle) * speed;          // Generate wavelength using Wien's displacement law with TIGHT distribution
        const peakWavelength = temperatureToWavelength(temperature);
          // Much tighter wavelength distribution around peak to reduce rainbow effect
        // Use normal distribution approximation for more coherent colors
        const narrowSpread = 0.08; // Extremely tight spread factor (8% variation)
        
        // Generate two random numbers for Box-Muller transform (normal distribution)
        const u1 = Math.random();
        const u2 = Math.random();
        const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        
        // Apply tight normal distribution around peak wavelength
        const wavelengthVariation = z0 * narrowSpread; // ±15% variation typically
        let wavelength = peakWavelength * (1.0 + wavelengthVariation);
          // Clamp to very tight bounds to prevent extreme outliers
        const minBound = peakWavelength * 0.85; // No less than 85% of peak
        const maxBound = peakWavelength * 1.2; // No more than 120% of peak
        wavelength = Math.max(minBound, Math.min(maxBound, wavelength));
          // Ensure wavelength bounds - extend UV range for high temperatures
        const minWavelength = temperature > 3000 ? 1e-7 : 3e-7; // 100nm for high temps, 300nm for lower
        const clampedWavelength = Math.max(minWavelength, Math.min(wavelength, 1e-5)); // Extended UV to 10μm IR
        
        // Energy based on wavelength (E = hc/λ)
        const energy = (PLANCK_CONSTANT * SPEED_OF_LIGHT) / clampedWavelength;
        // Scale for visualization
        const scaledEnergy = (energy / 1e-19) * (temperature / 500);
        
        photons.push(new Photon(startX, startY, vx, vy, scaledEnergy, clampedWavelength));
        totalPhotonsEmitted++;    }
}

// Update object temperature with passive cooling
function updateObjectTemperature(deltaTime) {
    const material = MATERIAL_PROPERTIES[objectType];
    
    // Calculate cooling effect
    if (objectTemperature > ambientTemperature) {
        // Convective cooling: rate proportional to temperature difference
        const tempDifference = objectTemperature - ambientTemperature;
        const coolingPower = passiveCoolingRate * material.thermalConductivity * (tempDifference / 100); // Scale cooling
        
        // Apply cooling (limit to prevent overcooling)
        const tempDecrease = (coolingPower * deltaTime) / material.thermalMass;
        objectTemperature = Math.max(ambientTemperature, objectTemperature - tempDecrease);
    }
}

function runSinglePhysicsStep(deltaTime) {
    // Emit new photons
    emitPhotons();
    
    // Update existing photons with delta time
    photons = photons.filter(photon => photon.update(deltaTime));
    
    // Apply passive cooling to the object
    updateObjectTemperature(deltaTime);
}

function renderSimulation() {
    if (!ctx) return;    // Clear canvas with dark background
    ctx.fillStyle = '#000011';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    
    // Draw photons first (behind all objects and text)
    photons.forEach(photon => photon.render());
    
    // Draw radiation source on top of photons
    drawRadiationSource();
    
    // Draw absorption object on top of photons and source
    drawAbsorptionObject();
    
    // Draw distance line on top
    drawDistanceLine();
}

function drawRadiationSource() {
    const centerY = canvasHeight / 2;
    
    // Enhanced temperature-based color using Wien's law
    const peakWavelength = temperatureToWavelength(temperature);
    const rgb = wavelengthToRGB(peakWavelength);
    
    // Improved brightness calculation for high temperatures
    const tempFactor = Math.min(temperature / 1000, 3.0); // Increased cap for higher temps
    const intensityFactor = intensity / 100;
    const brightness = tempFactor * intensityFactor;
    const minBrightness = 0.2;
    const effectiveBrightness = minBrightness + brightness * (1 - minBrightness);
    
    // Calculate final color with brightness
    const r = Math.round(rgb.r * effectiveBrightness);
    const g = Math.round(rgb.g * effectiveBrightness);
    const b = Math.round(rgb.b * effectiveBrightness);
    
    // Draw main source with size influenced by intensity
    const sourceRadiusRendered = sourceRadius * (0.7 + 0.3 * intensityFactor);
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.beginPath();
    ctx.arc(sourceX, centerY, sourceRadiusRendered, 0, Math.PI * 2);
    ctx.fill();
    
    // Enhanced glow effect based on temperature and intensity
    const numGlowLayers = Math.ceil(3 + brightness * 2);
    for (let i = 0; i < numGlowLayers; i++) {
        const glowRadius = sourceRadiusRendered + (i + 1) * 8;
        const glowAlpha = (0.15 * brightness) / (i + 1);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${glowAlpha})`;
        ctx.beginPath();
        ctx.arc(sourceX, centerY, glowRadius, 0, Math.PI * 2);
        ctx.fill();
    }
    
    // Temperature label
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '14px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(`${temperature}K`, sourceX, centerY + sourceRadiusRendered + 20);
}

function drawAbsorptionObject() {
    const objectX = getObjectDistancePixels();
    const objectY = (canvasHeight - objectHeight) / 2;
    const material = MATERIAL_PROPERTIES[objectType];
    
    // Calculate absorbed energy rate for visual feedback
    const energyAbsorptionRate = absorbedEnergy / (totalPhotonsEmitted || 1) * 100;
    
    // Calculate temperature-based color modification
    const tempAboveAmbient = objectTemperature - ambientTemperature;
    const maxTempDifference = 200; // Maximum expected temperature rise for color scaling
    const heatIntensity = Math.min(tempAboveAmbient / maxTempDifference, 1);
    
    // Blend material color with heat glow
    let baseColor = material.color;
    if (heatIntensity > 0.1) {
        // Convert hex color to RGB for blending
        const r = parseInt(baseColor.slice(1, 3), 16);
        const g = parseInt(baseColor.slice(3, 5), 16);
        const b = parseInt(baseColor.slice(5, 7), 16);
        
        // Blend with red/orange heat color
        const heatR = Math.min(255, r + heatIntensity * 100);
        const heatG = Math.min(255, g + heatIntensity * 50);
        const heatB = Math.max(0, b - heatIntensity * 50);
        
        baseColor = `rgb(${Math.round(heatR)}, ${Math.round(heatG)}, ${Math.round(heatB)})`;
    }
    
    // Draw object with temperature-based color
    ctx.fillStyle = baseColor;
    ctx.fillRect(objectX, objectY, objectWidth, objectHeight);
    
    // Add heat glow effect based on object temperature
    if (tempAboveAmbient > 10) {
        const glowIntensity = Math.min(heatIntensity, 1);
        const glowAlpha = glowIntensity * 0.6;
        
        for (let i = 1; i <= 4; i++) {
            ctx.fillStyle = `rgba(255, ${100 - i*10}, 0, ${glowAlpha / i})`;
            ctx.fillRect(objectX - i * 2, objectY - i * 2, objectWidth + i * 4, objectHeight + i * 4);
        }
        
        // Redraw the main object
        ctx.fillStyle = baseColor;
        ctx.fillRect(objectX, objectY, objectWidth, objectHeight);
    }
    
    // Draw object outline
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.strokeRect(objectX, objectY, objectWidth, objectHeight);
    
    // Material label
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(material.name, objectX + objectWidth / 2, objectY + objectHeight + 15);
    
    // Temperature display
    ctx.fillStyle = '#FFFF00';
    ctx.font = '10px Arial';
    ctx.fillText(`${objectTemperature.toFixed(0)}K`, objectX + objectWidth / 2, objectY + objectHeight + 30);
    
    // Absorption percentage indicator
    ctx.fillStyle = '#AAAAAA';
    ctx.font = '10px Arial';
    ctx.fillText(`${(material.absorption * 100).toFixed(0)}% abs`, objectX + objectWidth / 2, objectY + objectHeight + 45);
}

function drawDistanceLine() {
    const objectX = getObjectDistancePixels();
    const centerY = canvasHeight / 2;
    
    // Draw distance line
    ctx.strokeStyle = '#666666';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(sourceX + sourceRadius, centerY);
    ctx.lineTo(objectX, centerY);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Convert distance to realistic units for display
    const distanceM = getActualDistanceMeters();
    
    // Distance label with realistic units
    ctx.fillStyle = '#AAAAAA';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(`${distanceM.toFixed(2)} m`, (sourceX + sourceRadius + objectX) / 2, centerY - 10);
}

function computeAndDisplayData() {
    if (!absorbedEnergyDisplay || !emissionRateDisplay) return;
    
    // Calculate theoretical emission rate (what should be emitted without cap)
    const stefanBoltzmannRate = Math.pow(temperature / 300, 4);
    const theoreticalEmissionRate = stefanBoltzmannRate * (intensity / 100) * 60; // Scaled for display
    
    // Calculate inverse square law effect on intensity
    const distanceM = getActualDistanceMeters();
    const inverseSquareFactor = Math.pow(0.5 / Math.max(distanceM, 0.1), 2); // Using meters for realistic calculation
    const effectiveIntensity = inverseSquareFactor * intensity;
    
    // Calculate more reactive absorbed energy rate (power per unit time)
    // Clean old entries from history (keep only last 2 seconds)
    const currentTime = Date.now();
    const timeWindow = 2000; // 2 seconds
    energyAbsorptionHistory = energyAbsorptionHistory.filter(entry => 
        currentTime - entry.timestamp < timeWindow
    );
      // Calculate power (energy per second) from recent absorptions (already corrected)
    const recentEnergySum = energyAbsorptionHistory.reduce((sum, entry) => sum + entry.energy, 0);
    const timeSpan = timeWindow / 1000; // Convert to seconds
    absorbedEnergyRate = recentEnergySum / timeSpan; // J/s (Watts)
    
    // Dynamically choose appropriate units for absorbed power display
    let powerValue, powerUnit;
    if (absorbedEnergyRate >= 1000) {
        // Use kilowatts for values >= 1000W
        powerValue = absorbedEnergyRate / 1000;
        powerUnit = 'kW';
    } else if (absorbedEnergyRate >= 1) {
        // Use watts for values >= 1W
        powerValue = absorbedEnergyRate;
        powerUnit = 'W';
    } else {
        // Use milliwatts for values < 1W
        powerValue = absorbedEnergyRate * 1000;
        powerUnit = 'mW';
    }
    
    // Update displays with appropriate units
    absorbedEnergyDisplay.textContent = powerValue.toFixed(1);
    
    // Update the unit label in the info bar
    const absorbedPowerSpan = document.querySelector('.sim-info-item:first-child');
    if (absorbedPowerSpan) {
        absorbedPowerSpan.innerHTML = `Absorbed Power: <span id="absorbedEnergyVal">${powerValue.toFixed(1)}</span> ${powerUnit}`;
    }
    
    emissionRateDisplay.textContent = theoreticalEmissionRate.toFixed(0); // Show theoretical rate
      // Add distance and intensity info to existing display elements
    const infoBar = document.querySelector('.sim-info-bar');
    if (infoBar && !document.getElementById('distanceInfo')) {
        const distanceInfo = document.createElement('span');
        distanceInfo.id = 'distanceInfo';
        distanceInfo.className = 'sim-info-item';
        infoBar.insertBefore(distanceInfo, infoBar.lastElementChild);
    }
    
    // Add object temperature info
    if (infoBar && !document.getElementById('objectTempInfo')) {
        const objectTempInfo = document.createElement('span');
        objectTempInfo.id = 'objectTempInfo';
        objectTempInfo.className = 'sim-info-item';
        infoBar.insertBefore(objectTempInfo, infoBar.lastElementChild);
    }
      
    const distanceInfoElement = document.getElementById('distanceInfo');
    if (distanceInfoElement) {
        distanceInfoElement.innerHTML = `Distance: ${distanceM.toFixed(2)} m | Intensity: ${effectiveIntensity.toFixed(1)}%`;
    }
    
    const objectTempInfoElement = document.getElementById('objectTempInfo');
    if (objectTempInfoElement) {
        const tempC = objectTemperature - 273.15; // Convert to Celsius
        objectTempInfoElement.innerHTML = `Object: ${objectTemperature.toFixed(0)}K (${tempC.toFixed(1)}°C)`;
    }
}

// Helper function to calculate object distance based on percentage of canvas width
function getObjectDistancePixels() {
    // Convert percentage (25-90%) to actual pixel position
    // Ensure object stays within canvas bounds with some margin
    const minDistance = sourceX + sourceRadius + 50; // Minimum distance from source
    const maxDistance = canvasWidth - objectWidth - 20; // Maximum distance (leave margin for object)
    const availableWidth = maxDistance - minDistance;
    
    // Map percentage (25-90%) to available width
    const normalizedPercent = (objectDistancePercent - 25) / (90 - 25); // Convert to 0-1 range
    const distancePixels = minDistance + (normalizedPercent * availableWidth);
    
    return Math.max(minDistance, Math.min(maxDistance, distancePixels));
}

// Helper function to get the actual distance in meters from source to object
function getActualDistanceMeters() {
    const objectX = getObjectDistancePixels();
    const distancePixels = objectX - sourceX - sourceRadius;
    return pixelsToMeters(distancePixels);
}

// --- Main Animation Loop ---

function animate(timestamp) {
    if (!ctx) {
        console.error("Canvas context not available for animation.");
        return;
    }

    if (lastTimestamp === 0) {
        lastTimestamp = timestamp;
        lastFPSUpdate = timestamp;
    }
    
    let realDeltaTimeMs = timestamp - lastTimestamp;
    lastTimestamp = timestamp;

    // Cap delta time to prevent physics spiral
    if (realDeltaTimeMs > 100) {
        realDeltaTimeMs = 100;
    }    // FPS tracking - update standard fpsDisplay element
    frameCount++;
    if (timestamp - lastFPSUpdate >= 1000) {
        currentFPS = frameCount / ((timestamp - lastFPSUpdate) / 1000);
        const fpsDisplay = document.getElementById('fpsDisplay');
        if (fpsDisplay) {
            fpsDisplay.textContent = `FPS: ${currentFPS.toFixed(0)}`;
        }
        frameCount = 0;
        lastFPSUpdate = timestamp;
    }

    // --- Physics Updates (Fixed Timestep with delta-time) ---
    const deltaTimeSeconds = realDeltaTimeMs / 1000.0;
    const referenceSlotsPassed = realDeltaTimeMs / (1000.0 / REFERENCE_UPDATES_PER_SECOND);
    physicsStepAccumulator += referenceSlotsPassed * timeScale;
    
    let maxStepsPerFrame = 10;
    let stepsTaken = 0;
    
    while (physicsStepAccumulator >= 1.0 && stepsTaken < maxStepsPerFrame) {
        runSinglePhysicsStep(BASE_DT); // Pass proper delta time
        physicsStepAccumulator -= 1.0;
        stepsTaken++;
    }
    
    if (stepsTaken >= maxStepsPerFrame) {
        physicsStepAccumulator = 0.0; // Reset to prevent spiral
    }
      // --- Canvas Resize Handling ---
    handleRadiationResize();
    
    // --- Rendering & Data Display ---
    renderSimulation();
    computeAndDisplayData();
    
    requestAnimationFrame(animate);
}

function startSimulation() {
    if (!canvas || !ctx) {
        console.error("Canvas or context not found. Radiation simulation cannot start.");
        return;
    }

    // Set initial canvas dimensions
    const aspectRatioBox = canvas.parentElement;
    if (aspectRatioBox && aspectRatioBox.classList.contains('sim-aspect-ratio-box')) {
        canvasWidth = aspectRatioBox.clientWidth;
        canvasHeight = aspectRatioBox.clientHeight;
    } else {
        canvasWidth = canvas.clientWidth || 800;
        canvasHeight = canvas.clientHeight || 400;
    }
    
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // Initialize scaled geometry based on canvas size
    updateRadiationGeometry();
    
    initializeSimulationState();
    requestAnimationFrame(animate);
}

// --- UI Event Listeners ---

// Time scale slider
if (timeSlider && timeScaleVal) {
    timeSlider.oninput = () => {
        timeScale = parseFloat(timeSlider.value);
        timeScaleVal.textContent = timeScale.toFixed(1);
    };
    timeScaleVal.textContent = timeScale.toFixed(1);
}

// Temperature slider
if (temperatureSlider && temperatureVal) {
    temperatureSlider.oninput = () => {
        temperature = parseFloat(temperatureSlider.value);
        temperatureVal.textContent = temperature;
    };
    temperatureVal.textContent = temperature;
}

// Intensity slider
if (intensitySlider && intensityVal) {
    intensitySlider.oninput = () => {
        intensity = parseFloat(intensitySlider.value);
        intensityVal.textContent = intensity;
    };
    intensityVal.textContent = intensity;
}

// Distance slider
if (distanceSlider && distanceVal) {
    distanceSlider.oninput = () => {
        objectDistancePercent = parseFloat(distanceSlider.value);
        const distanceM = getActualDistanceMeters();
        distanceVal.textContent = `${distanceM.toFixed(2)}`;
    };
    const initialDistanceM = getActualDistanceMeters();
    distanceVal.textContent = `${initialDistanceM.toFixed(2)}`;
}

// Cooling rate slider
if (coolingRateSlider && coolingRateVal) {
    coolingRateSlider.oninput = () => {
        passiveCoolingRate = parseFloat(coolingRateSlider.value);
        coolingRateVal.textContent = passiveCoolingRate.toFixed(1);
    };
    coolingRateVal.textContent = passiveCoolingRate.toFixed(1);
}

// Object type selector
if (objectTypeSelector) {
    objectTypeSelector.onchange = () => {
        objectType = objectTypeSelector.value;
    };
}

// Reset button
if (resetButton) {
    resetButton.onclick = () => {
        initializeSimulationState();
    };
}

// --- Global Simulation Control Object ---
window.radiationSimulation = {
    reset: () => {
        initializeSimulationState();
    },
};

// --- DOM Ready ---
document.addEventListener('DOMContentLoaded', () => {
    // Small delay to ensure UI is ready
    setTimeout(startSimulation, 100);
});
