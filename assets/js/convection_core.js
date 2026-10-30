// GRID & PHYSICS PARAMETERS
let N    = 64; // Made N mutable
let size = N + 2;
const iter = 4;
const diff   = 0.0001;
let visc   = 0.0001; // Made viscosity variable for dropdown control
const buoyancyCoeff = 1.0,
      ambientTemp   = 0.5;

// TIME MANAGEMENT
const physicsDt = 0.02;
const targetPhysicsRate = 60;
const heatAmpMult = 1.25; // Multiplier for heat amplitude
const coolAmpMult = 1; // Multiplier for cooling rate
let accumulatedTime = 0;
let timeScale = 2.5; 
let lastTimestamp = 0;

// FPS TRACKING
let frameCount = 0;
let lastFpsUpdate = 0;
let currentFps = 0;

// FLUID STATE ARRAYS
let u        = new Float32Array(size*size);
let v        = new Float32Array(size*size);
let u_prev   = new Float32Array(size*size);
let v_prev   = new Float32Array(size*size);
let dens     = new Float32Array(size*size);
let dens_prev= new Float32Array(size*size);
let u0    = new Float32Array(size*size); // Made u0, v0, dens0 mutable for resize
let v0    = new Float32Array(size*size);
let dens0 = new Float32Array(size*size);
for (let i = 0; i < dens.length; i++) dens[i] = ambientTemp;
let avg_density = ambientTemp;
let prev_avg_density = ambientTemp;

// UI STATE
let heatRadius = 5, 
    heatAmp    = 0.5, 
    coolRate   = 0.5, 
    heating    = false,
    cooling    = false, // Added for right-click cooling
    mX = 0, mY = 0;

// MULTI-TOUCH STATE
let touchPoints = new Map(); // Map to store active touch points
let activeTouchCount = 0;

// DOM REFS
const canvas      = document.getElementById('simulationCanvas'); 
let ctx           = canvas ? canvas.getContext('2d') : null;
const timeSlider  = document.getElementById('timeScale');
const timeVal     = document.getElementById('timeScaleVal');
const radiusSlider= document.getElementById('heatSize');
const radiusVal   = document.getElementById('heatSizeVal');
const heatAmpSlider = document.getElementById('heatAmp');
const ampVal      = document.getElementById('heatAmpVal');
const coolSlider  = document.getElementById('coolRate');
const coolVal     = document.getElementById('coolRateVal');
const viscositySelector = document.getElementById('viscositySelector');
const fpsDisplay  = document.getElementById('fpsDisplay'); 
const avgDensityDisplay = document.getElementById('avgDensityVal');
const resetSimButton = document.getElementById('resetSimulationBtn');

// Offscreen canvas
let offscreenCanvas = null;
let offscreenCtx = null;
let offscreenImageData = null;

function updateCanvasResolution() {
    if (!canvas) return;
    if (!ctx && canvas) ctx = canvas.getContext('2d');
    if (!ctx) return;

    const aspectRatioBox = canvas.parentElement; // .sim-aspect-ratio-box
    if (!aspectRatioBox) return;

    const isFullscreen = document.body.classList.contains('sim-fullscreen-active');
    let targetWidth, targetHeight;

    const simStyle = getComputedStyle(aspectRatioBox);
    const simAspectRatioString = simStyle.getPropertyValue('--aspect-ratio').trim();
    let simAspectRatio = 1; 
    if (simAspectRatioString) {
        const parts = simAspectRatioString.split('/');
        if (parts.length === 2 && parseFloat(parts[1]) !== 0) {
            simAspectRatio = parseFloat(parts[0]) / parseFloat(parts[1]);
        } else if (parts.length === 1) {
            simAspectRatio = parseFloat(simAspectRatioString);
        }
    }    if (isNaN(simAspectRatio) || simAspectRatio <= 0) simAspectRatio = 1;
    
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
        // Not fullscreen: .sim-aspect-ratio-box gets its width from .sim-canvas-wrapper,
        // which gets its width from .simulation-display-container (max-width: 750px, centered).
        // Reset inline styles so CSS can take over.
        aspectRatioBox.style.width = ''; 
        aspectRatioBox.style.height = ''; 
        
        // Get the computed size based on CSS layout
        const boxRect = aspectRatioBox.getBoundingClientRect();
        targetWidth = boxRect.width;
        targetHeight = boxRect.height; // Derived from width and padding-bottom
    }

    targetWidth = Math.max(1, Math.round(targetWidth));
    targetHeight = Math.max(1, Math.round(targetHeight));

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
    }
    
    // Ensure offscreen canvas for simulation logic always matches N
    if (!offscreenCanvas || offscreenCanvas.width !== N || offscreenCanvas.height !== N) {
        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = N;
        offscreenCanvas.height = N;
        offscreenCtx = offscreenCanvas.getContext('2d');
        if (offscreenCtx) offscreenImageData = offscreenCtx.createImageData(N, N);
    }
}


if (canvas) {
    // Observe .sim-canvas-wrapper for resizes in normal mode,
    // and .simulation-main-content for fullscreen resizes.
    const normalModeObserverTarget = canvas.closest('.sim-canvas-wrapper');
    const fullscreenModeObserverTarget = canvas.closest('.simulation-main-content');

    if (typeof ResizeObserver !== 'undefined') {
        const generalResizeObserver = new ResizeObserver(entries => {
            // Call with a slight delay to ensure all other layout shifts are done.
            requestAnimationFrame(updateCanvasResolution);
        });

        if (normalModeObserverTarget) generalResizeObserver.observe(normalModeObserverTarget);
        // Observation of fullscreenModeObserverTarget might be redundant if normalMode one covers it,
        // but specific observation for fullscreen area can be more direct.
        if (fullscreenModeObserverTarget && fullscreenModeObserverTarget !== normalModeObserverTarget) {
            // Potentially observe this too, or rely on body class change
        }
        
        const fullscreenClassObserver = new MutationObserver((mutationsList) => {
            for(const mutation of mutationsList) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'class' && mutation.target === document.body) {
                     // If fullscreen state changes, trigger resize after a short delay
                    setTimeout(updateCanvasResolution, 100); // Increased delay for layout settle
                    break; 
                }
            }
        });
        fullscreenClassObserver.observe(document.body, { attributes: true });
    } else {
        window.addEventListener('resize', () => setTimeout(updateCanvasResolution, 100));
    }

    // Fallback initial sizing calls
    window.addEventListener('load', () => setTimeout(updateCanvasResolution, 250));
    if (document.readyState === "complete" || (document.readyState !== "loading" && !document.documentElement.doScroll)) {
       setTimeout(updateCanvasResolution, 200); 
    } else {
        document.addEventListener("DOMContentLoaded", () => setTimeout(updateCanvasResolution, 200));
    }
}


if(timeSlider && timeVal) timeSlider.oninput = () => { timeScale = +timeSlider.value; timeVal.textContent = timeScale.toFixed(1); };
if(radiusSlider && radiusVal) radiusSlider.oninput = () => { heatRadius = +radiusSlider.value; radiusVal.textContent = heatRadius; };
if(heatAmpSlider && ampVal) {
    heatAmpSlider.oninput = () => { heatAmp = +heatAmpSlider.value; ampVal.textContent = heatAmp.toFixed(2); };
}
if(coolSlider && coolVal) coolSlider.oninput = () => { coolRate = +coolSlider.value; coolVal.textContent = coolRate.toFixed(2); };


function updatePosition(e) {
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  let clientX, clientY;
  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  } else if (e.clientX !== undefined) {
    clientX = e.clientX;
    clientY = e.clientY;
  } else { return; }
  mX = clientX - r.left;
  mY = clientY - r.top;

  if (r.width > 0 && r.height > 0) { 
    mX = mX * (canvas.width / r.width);
    mY = mY * (canvas.height / r.height);
  } else {
    mX = 0; mY = 0;
  }
}

// Updated function to handle multiple touch points
function updateTouchPoints(e) {
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  
  if (e.touches) {
    // Clear current touch points
    touchPoints.clear();
    
    // Process all active touches
    for (let i = 0; i < e.touches.length; i++) {
      const touch = e.touches[i];
      let x = touch.clientX - r.left;
      let y = touch.clientY - r.top;
      
      if (r.width > 0 && r.height > 0) { 
        x = x * (canvas.width / r.width);
        y = y * (canvas.height / r.height);
      } else {
        x = 0; y = 0;
      }
      
      touchPoints.set(touch.identifier, {
        x: x,
        y: y,
        heating: true, // Default to heating for touch
        cooling: false
      });
    }
    
    activeTouchCount = e.touches.length;
    
    // Also update the legacy single point for mouse compatibility
    if (e.touches.length > 0) {
      updatePosition(e);
    }
  }
}

if (canvas) {
    canvas.addEventListener('mousedown', (e) => {
        updatePosition(e);
        if (e.button === 0) { // Left click
            heating = true;
            cooling = false;
        } else if (e.button === 2) { // Right click
            cooling = true;
            heating = false;
        }
    });
    canvas.addEventListener('mouseup', (e) => {
        if (e.button === 0) {
            heating = false;
        } else if (e.button === 2) {
            cooling = false;
        }
    });
    canvas.addEventListener('mouseleave', () => {
        heating = false;
        cooling = false;
    });
    canvas.addEventListener('mousemove', (e) => {
        if(heating || cooling) updatePosition(e);
    });    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // Prevent context menu on right click    // Enhanced touch event handling for multiple touches
    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault(); 
        heating = true; 
        updateTouchPoints(e);
    }, { passive: false });
      canvas.addEventListener('touchend', (e) => {
        e.preventDefault();
        updateTouchPoints(e);
        if (e.touches.length === 0) {
            heating = false;
            touchPoints.clear();
            activeTouchCount = 0;
        }
    }, { passive: false });
    
    canvas.addEventListener('touchcancel', (e) => {
        heating = false;
        touchPoints.clear();
        activeTouchCount = 0;
    });
    
    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault(); 
        if (heating) {
            updateTouchPoints(e);
        }
    }, { passive: false });
}

function IX(i,j){ return i + j*size; }
function setBnd(b, x_arr) {
  for (let i = 1; i <= N; i++) {
    // Vertical boundaries (sides: left i=0, right i=N+1)
    // b=1 for reflection (e.g., u velocity against vertical wall)
    x_arr[IX(0, i)]   = (b === 1) ? -x_arr[IX(1, i)] : x_arr[IX(1, i)];
    x_arr[IX(N+1, i)] = (b === 1) ? -x_arr[IX(N, i)] : x_arr[IX(N, i)];

    // Horizontal boundaries (top j=0, bottom j=N+1)
    // b=2 for reflection (e.g., v velocity against horizontal wall)
    x_arr[IX(i, 0)]   = (b === 2) ? -x_arr[IX(i, 1)] : x_arr[IX(i, 1)];
    x_arr[IX(i, N+1)] = (b === 2) ? -x_arr[IX(i, N)] : x_arr[IX(i, N)];
  }
  x_arr[IX(0,   0)]   = 0.5*(x_arr[IX(1,0)]   + x_arr[IX(0,1)]);
  x_arr[IX(0,   N+1)] = 0.5*(x_arr[IX(1,N+1)] + x_arr[IX(0,N)]);
  x_arr[IX(N+1, 0)]   = 0.5*(x_arr[IX(N,0)]   + x_arr[IX(N+1,1)]);
  x_arr[IX(N+1, N+1)] = 0.5*(x_arr[IX(N, N+1)]+ x_arr[IX(N+1,N)]);
}
function linSolve(b, x_arr, x0_arr, a, c) {
  const c_inv = 1.0 / c;
  for (let k_iter = 0; k_iter < iter; k_iter++) { // Renamed k to k_iter to avoid conflict
    for (let j = 1; j <= N; j++) {
      const prev_j_idx = (j - 1) * size;
      const curr_j_idx = j * size;
      const next_j_idx = (j + 1) * size;
      for (let i = 1; i <= N; i++) {
        const idx = curr_j_idx + i;
        x_arr[idx] = (x0_arr[idx] + a*(
          x_arr[idx - 1]     + x_arr[idx + 1] +    // x_arr[IX(i-1,j)] + x_arr[IX(i+1,j)]
          x_arr[prev_j_idx + i] + x_arr[next_j_idx + i] // x_arr[IX(i,j-1)] + x_arr[IX(i,j+1)]
        )) * c_inv;
      }
    }
    setBnd(b, x_arr);
  }
}
function diffuse(b, x_arr, x0_arr, diff_coeff) {
  const a = physicsDt * diff_coeff * N * N;
  linSolve(b, x_arr, x0_arr, a, 1 + 4*a);
}
function advect(b, d_arr, d0_arr, u_vel, v_vel) {
  const dt0 = physicsDt * N;
  for (let j = 1; j <= N; j++) {
    for (let i = 1; i <= N; i++) {
      const current_idx = IX(i,j);
      let x_coord = i - dt0 * u_vel[current_idx];
      let y_coord = j - dt0 * v_vel[current_idx];

      x_coord = Math.max(0.5, Math.min(N + 0.5, x_coord));
      y_coord = Math.max(0.5, Math.min(N + 0.5, y_coord));

      const i0 = x_coord | 0, i1 = i0 + 1; // Use bitwise OR for floor on positive numbers
      const j0 = y_coord | 0, j1 = j0 + 1; // Use bitwise OR for floor on positive numbers

      const s1 = x_coord - i0, s0 = 1 - s1;
      const t1 = y_coord - j0, t0 = 1 - t1;

      const base_idx_i0j0 = IX(i0, j0);
      d_arr[current_idx] =
        s0*(t0*d0_arr[base_idx_i0j0] + t1*d0_arr[base_idx_i0j0 + size]) + 
        s1*(t0*d0_arr[base_idx_i0j0 + 1] + t1*d0_arr[base_idx_i0j0 + 1 + size]); 
    }
  }
  setBnd(b, d_arr);
}
function project(u_vel, v_vel, p_arr, div_arr) {
  const h_inv = 1.0 / N;
  for (let j = 1; j <= N; j++) {
    const prev_j_idx = (j-1) * size;
    const curr_j_idx = j * size;
    const next_j_idx = (j+1) * size;
    for (let i = 1; i <= N; i++) {
      const idx = curr_j_idx + i;
      div_arr[idx] = -0.5 * h_inv * (
        u_vel[idx + 1] - u_vel[idx - 1] +           // u_vel[IX(i+1,j)] - u_vel[IX(i-1,j)]
        v_vel[next_j_idx + i] - v_vel[prev_j_idx + i] // v_vel[IX(i,j+1)] - v_vel[IX(i,j-1)]
      );
      p_arr[idx] = 0;
    }
  }
  setBnd(0, div_arr); setBnd(0, p_arr);
  linSolve(0, p_arr, div_arr, 1, 4);
  
  // const N_half_inv = 0.5 * N; // This variable was unused.
  const N_half = 0.5 * N;

  for (let j = 1; j <= N; j++) {
    const prev_j_idx = (j-1) * size;
    const curr_j_idx = j * size;
    const next_j_idx = (j+1) * size;
    for (let i = 1; i <= N; i++) {
      const idx = curr_j_idx + i;
      u_vel[idx] -= N_half * (p_arr[idx + 1] - p_arr[idx - 1]); // p_arr[IX(i+1,j)] - p_arr[IX(i-1,j)]
      v_vel[idx] -= N_half * (p_arr[next_j_idx + i] - p_arr[prev_j_idx + i]); // p_arr[IX(i,j+1)] - p_arr[IX(i,j-1)]
    }
  }
  setBnd(1, u_vel); setBnd(2, v_vel);
}
function addSource(x_arr, s_arr) {
  for (let i = 0; i < x_arr.length; i++) x_arr[i] += physicsDt * s_arr[i];
}

function renderDensity() {
    if (!ctx) return;
    if (!offscreenCanvas) { 
        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = N;
        offscreenCanvas.height = N;
        offscreenCtx = offscreenCanvas.getContext('2d');
        if (!offscreenCtx) return;
        offscreenImageData = offscreenCtx.createImageData(N, N);
    }
    if (!offscreenCtx || !offscreenImageData) return;

    const data = offscreenImageData.data;
    let data_idx = 0; // Use a single incrementing index for imageData

    for (let y_px = 0; y_px < N; y_px++) {
        const sim_j = N - y_px; // Row in simulation grid (decreases as y_px increases)
        const dens_row_start_idx = sim_j * size; // Precalculate row start for dens array

        for (let x_px = 0; x_px < N; x_px++) {
            const sim_i = x_px + 1; // Column in simulation grid
            const T_val = dens[dens_row_start_idx + sim_i]; // Optimized dens access
            const t = Math.max(0, Math.min(1, T_val));
            
            const hue = (1 - t) * 240;
            const C = 1.0; 
            const X = C * (1 - Math.abs((hue / 60) % 2 - 1));
            
            let r_prime, g_prime, b_prime;
            const h_prime = hue / 60;

            if (h_prime >= 0 && h_prime < 1) { r_prime = C; g_prime = X; b_prime = 0; }
            else if (h_prime >= 1 && h_prime < 2) { r_prime = X; g_prime = C; b_prime = 0; }
            else if (h_prime >= 2 && h_prime < 3) { r_prime = 0; g_prime = C; b_prime = X; }
            else if (h_prime >= 3 && h_prime < 4) { r_prime = 0; g_prime = X; b_prime = C; }
            else if (h_prime >= 4 && h_prime < 5) { r_prime = X; g_prime = 0; b_prime = C; } 
            else { r_prime = C; g_prime = 0; b_prime = X; } 
            
            const R = Math.round(r_prime * 255);
            const G = Math.round(g_prime * 255);
            const B = Math.round(b_prime * 255);

            data[data_idx++] = R;
            data[data_idx++] = G;
            data[data_idx++] = B;
            data[data_idx++] = 255; 
        }
    }
    offscreenCtx.putImageData(offscreenImageData, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(offscreenCanvas, 0, 0, canvas.width, canvas.height);
}
function simulate() {
  u_prev.fill(0); v_prev.fill(0); dens_prev.fill(0);
  
  // Handle multi-touch input
  if (touchPoints.size > 0 && canvas && canvas.width > 0 && canvas.height > 0) {
    const simCellW = canvas.width / N; 
    const simCellH = canvas.height / N;
    
    if (simCellW > 0 && simCellH > 0) {
      const heatRadiusSq = heatRadius*heatRadius;
      const twiceHeatRadiusSq = 2*heatRadiusSq;
      
      // Apply heating/cooling for each active touch point
      touchPoints.forEach((touchPoint) => {
        const ci = Math.floor(touchPoint.x / simCellW) + 1; 
        const cj = N - Math.floor(touchPoint.y / simCellH);
        
        for (let di = -heatRadius; di <= heatRadius; di++) {
          for (let dj = -heatRadius; dj <= heatRadius; dj++) {
            const ii = ci + di, jj = cj + dj;
            if (ii>=1 && ii<=N && jj>=1 && jj<=N) {
              const d2 = di*di + dj*dj;
              if (d2 <= heatRadiusSq) {
                const w = Math.exp(-d2/twiceHeatRadiusSq);
                if (touchPoint.heating) {
                    dens_prev[IX(ii,jj)] += heatAmpMult * heatAmp * w;
                } else if (touchPoint.cooling) {
                    dens_prev[IX(ii,jj)] -= heatAmpMult * heatAmp * w;
                }
              }
            }
          }
        }
      });
    }
  }
  
  // Handle legacy mouse input (for backward compatibility)
  if ((heating || cooling) && canvas && canvas.width > 0 && canvas.height > 0) { 
    const simCellW = canvas.width / N; 
    const simCellH = canvas.height / N;
    if (simCellW > 0 && simCellH > 0) {
        const ci = Math.floor(mX / simCellW) + 1; 
        const cj = N - Math.floor(mY / simCellH);
        
        const heatRadiusSq = heatRadius*heatRadius;
        const twiceHeatRadiusSq = 2*heatRadiusSq; // Or 2 * heatRadius * heatRadius

        for (let di = -heatRadius; di <= heatRadius; di++) {
          for (let dj = -heatRadius; dj <= heatRadius; dj++) {
            const ii = ci + di, jj = cj + dj;
            if (ii>=1 && ii<=N && jj>=1 && jj<=N) {
              const d2 = di*di + dj*dj;
              if (d2 <= heatRadiusSq) {
                const w = Math.exp(-d2/twiceHeatRadiusSq);
                if (heating) {
                    dens_prev[IX(ii,jj)] += heatAmpMult * heatAmp * w;
                } else if (cooling) {
                    dens_prev[IX(ii,jj)] -= heatAmpMult * heatAmp * w; // Corrected typo: was 0.5heatAmpMult, ensuring it uses coolAmpMult
                }
              }
            }
          }
        }
    }
  }
  prev_avg_density = avg_density; avg_density = 0;
  
  // Buoyancy calculation loop
  for (let j = 1; j <= N; j++) {
    const base_j_idx = j * size;
    for (let i = 1; i <= N; i++) {
      const id = base_j_idx + i;
      avg_density += dens[id];
      const anomaly = dens[id] - prev_avg_density;
      v_prev[id] += buoyancyCoeff * anomaly;
    }
  }
  avg_density /= (N*N); // Potential division by zero if N is 0, but N is usually > 0
  if (avgDensityDisplay) { // Update average density display
    avgDensityDisplay.textContent = (avg_density*100).toFixed(1);
  }

  addSource(u, u_prev); addSource(v, v_prev);
  
  u0.set(u); diffuse(1, u, u0, visc);
  v0.set(v); diffuse(2, v, v0, visc);
  
  project(u, v, u0, v0);
  
  u0.set(u); v0.set(v);
  advect(1, u, u0, u0, v0); // u0, v0 are velocity fields for advection of u
  advect(2, v, v0, u0, v0); // u0, v0 are velocity fields for advection of v
  
  project(u, v, u0, v0); // u0, v0 are p_arr, div_arr respectively in this call
  
  addSource(dens, dens_prev);
  // Clamp density after adding source to ensure it's within bounds
  for (let i = 0; i < dens.length; i++) {
    dens[i] = Math.max(0, Math.min(1, dens[i])); // Clamp between 0 and 1 (or other appropriate range)
  }
  dens0.set(dens); diffuse(0, dens, dens0, diff);
  dens0.set(dens); advect(0, dens, dens0, u, v); // u, v are velocity fields for advection of dens

  // Cooling loop
  // const coolGradients = [1.0, 0.5, 1.0/3.0]; // Precompute if k range is fixed and larger
  for (let k = 0; k < 3; k++) { // k is 0, 1, 2
    const j_cool = N - k; 
    const currentGradient = 1.0 / (k + 1); // gradient = 1.0, 0.5, 0.333...
    const base_j_cool_idx = j_cool * size;
    const scaledCoolRateBase = (coolAmpMult * coolRate / 100) * currentGradient;

    for (let i = 1; i <= N; i++) {
        // const rate = (coolRate/100) * currentGradient; // Moved out: scaledCoolRateBase
        const noise = 1 + (Math.random() - 0.5) * 0.2; // 0.9 to 1.1
        const idx = base_j_cool_idx + i;
        dens[idx] *= (1 - scaledCoolRateBase * noise);
        dens[idx] = Math.max(0, dens[idx]);
    }
  }
  setBnd(0, dens);
}
function updateFPS(timestamp) {
  frameCount++;
  if (timestamp - lastFpsUpdate >= 1000) {
    currentFps = Math.round(frameCount * 1000 / (timestamp - lastFpsUpdate));
    if(fpsDisplay) fpsDisplay.textContent = `FPS: ${currentFps}`;
    frameCount = 0; lastFpsUpdate = timestamp;
  }
}
function step(timestamp) {
  if (!ctx && canvas) ctx = canvas.getContext('2d'); // Attempt to get context if lost
  if (!ctx) {
      console.warn("Convection_core: Canvas context not available in step. Retrying animation frame.");
      requestAnimationFrame(step); 
      return;
  }
  if (!lastTimestamp) {
    lastTimestamp = timestamp; lastFpsUpdate = timestamp;
    requestAnimationFrame(step); return;
  }
  const deltaTime = (timestamp - lastTimestamp) / 1000;
  lastTimestamp = timestamp;
  const cappedDeltaTime = Math.min(deltaTime, 0.1);
  accumulatedTime += cappedDeltaTime * timeScale;
  const physicsInterval = 1.0 / targetPhysicsRate;
  while (accumulatedTime >= physicsInterval) {
    simulate();
    accumulatedTime -= physicsInterval;
  }

  if (canvas.width > 0 && canvas.height > 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    renderDensity();
  }
  updateFPS(timestamp);
  requestAnimationFrame(step);
}

// Initialize slider values from HTML defaults if sliders exist
if (timeSlider && timeVal) { timeScale = +timeSlider.value; timeVal.textContent = timeScale.toFixed(1); }
if (radiusSlider && radiusVal) { heatRadius = +radiusSlider.value; radiusVal.textContent = heatRadius; }
if (heatAmpSlider && ampVal) { heatAmp = +heatAmpSlider.value; ampVal.textContent = heatAmp.toFixed(2); }
if (coolSlider && coolVal) { coolRate = +coolSlider.value; coolVal.textContent = coolRate.toFixed(2); }
if (viscositySelector) { visc = +viscositySelector.value; }

function startSimulationWhenReady() {
    if (!canvas) {
        console.error("Convection_core: Canvas element #simulationCanvas not found.");
        return;
    }
    if (!ctx) ctx = canvas.getContext('2d');

    if (ctx) {
        setTimeout(updateCanvasResolution, 150); // A final call after UI setup
        requestAnimationFrame(step);
    } else {
        console.error("Convection_core: Canvas context not found/ready. Aborting simulation start.");
    }
}

// Defer start until DOM is fully ready and UI script has likely run
if (document.readyState === "complete" || (document.readyState !== "loading" && !document.documentElement.doScroll)) {
    setTimeout(startSimulationWhenReady, 50); // Short delay
} else {
    document.addEventListener("DOMContentLoaded", () => setTimeout(startSimulationWhenReady, 50));
}

function reinitializeArrays(newN) {
    N = newN;
    size = N + 2;

    u        = new Float32Array(size*size);
    v        = new Float32Array(size*size);
    u_prev   = new Float32Array(size*size);
    v_prev   = new Float32Array(size*size);
    dens     = new Float32Array(size*size);
    dens_prev= new Float32Array(size*size);
    u0       = new Float32Array(size*size);
    v0       = new Float32Array(size*size);
    dens0    = new Float32Array(size*size);

    for (let i = 0; i < dens.length; i++) dens[i] = ambientTemp;
    avg_density = ambientTemp;
    prev_avg_density = ambientTemp;

    // Reset any other necessary simulation state related to grid size
    if (offscreenCanvas) {
        offscreenCanvas.width = N;
        offscreenCanvas.height = N;
        if (offscreenCtx) offscreenImageData = offscreenCtx.createImageData(N, N);
    }    // Potentially reset mouse interaction states if they depend on cell size
    mX = 0; mY = 0;
    
    // Reset multi-touch state
    touchPoints.clear();
    activeTouchCount = 0;
}

// Expose setSize to be called from simulation_ui.js
window.convectionSimulation = {
    setSize: function(newSize) {
        reinitializeArrays(newSize); // This already resets arrays and some state
        // Call resetSimulation to ensure all relevant states are reset, including UI states like heating/cooling
        resetSimulation(); // Call the new comprehensive reset function
        if (typeof updateCanvasResolution === 'function') {
            requestAnimationFrame(updateCanvasResolution);
        }
    },
    getCurrentGridSize: function() {
        return N; // N is the current grid size
    },
    getAvailableGridSizes: function() {
        return [48, 64, 96, 128]; // Define the available grid sizes
    },
    reset: resetSimulation // Expose the reset function
};

function resetSimulation() {
    // Reinitialize arrays to their default states
    u.fill(0);
    v.fill(0);
    u_prev.fill(0);
    v_prev.fill(0);
    dens.fill(ambientTemp);
    dens_prev.fill(0);
    u0.fill(0);
    v0.fill(0);
    dens0.fill(ambientTemp); // Or new Float32Array(size*size).fill(ambientTemp) if dens0 needs to be pristine

    // Reset other relevant state variables
    avg_density = ambientTemp;
    prev_avg_density = ambientTemp;
    mX = 0;
    mY = 0;
    heating = false;
    cooling = false;
    accumulatedTime = 0;
    
    // Reset multi-touch state
    touchPoints.clear();
    activeTouchCount = 0;
    // lastTimestamp = 0; // Resetting lastTimestamp can cause a jump if animation loop is running, usually not reset here

    // Update UI elements if they exist
    if (avgDensityDisplay) {
        avgDensityDisplay.textContent = (ambientTemp * 100).toFixed(1); // Match formatting if it's a percentage, or ambientTemp.toFixed(2) if direct value
    }

}

if (resetSimButton) {
    resetSimButton.addEventListener('click', resetSimulation);
}

// Add event listener for viscosity dropdown
if (viscositySelector) {
    viscositySelector.addEventListener('change', function() {
        visc = +this.value;
    });
}