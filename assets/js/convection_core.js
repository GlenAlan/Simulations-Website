// GRID & PHYSICS PARAMETERS
let N    = 64; // Made N mutable
let size = N + 2;
// Reference grid size: the heating brush radius and the cooled surface layer are specified in cells
// of a 64x64 grid and scaled with N, so changing the grid size changes resolution, not the physics.
const referenceN = 64;
const iter = 4;
const diff   = 0.0001;
let visc   = 0.0001; // Made viscosity variable for dropdown control
const buoyancyCoeff = 1.0,
      ambientTemp   = 0.5;

// TIME MANAGEMENT
const physicsDt = 0.02;
const targetPhysicsRate = 60;
// Wall-clock budget for physics steps in one animation frame. If the requested speed needs more
// steps than fit (large grid, high speed, slow device) the backlog is dropped and the simulation
// runs slower than requested instead of piling up work and freezing the page.
const maxPhysicsMsPerFrame = 6;
const heatAmpMult = 1.25; // Multiplier for heat amplitude
const coolAmpMult = 1; // Multiplier for cooling rate
let accumulatedTime = 0;
let physicsStepMs = 0; // Running estimate of the wall-clock cost of one simulate() call
let timeScale = 2.5;
let lastTimestamp = 0;

// FPS TRACKING
let frameCount = 0;
let lastFpsUpdate = 0;
let currentFps = 0;

// FLUID STATE ARRAYS
let u        = new Float32Array(size*size);
let v        = new Float32Array(size*size);
let dens     = new Float32Array(size*size);
let dens_prev= new Float32Array(size*size);
let u0    = new Float32Array(size*size); // Made u0, v0, dens0 mutable for resize
let v0    = new Float32Array(size*size);
let dens0 = new Float32Array(size*size);
// Pressure of the two projections and the viscous velocity change in each step, kept between steps
// to warm-start the iterative solvers
let pressure1  = new Float32Array(size*size);
let pressure2  = new Float32Array(size*size);
let viscousDeltaU = new Float32Array(size*size);
let viscousDeltaV = new Float32Array(size*size);
let divergence = new Float32Array(size*size);
for (let i = 0; i < dens.length; i++) dens[i] = ambientTemp;
let avg_density = ambientTemp;
let prev_avg_density = ambientTemp;

// UI STATE
let heatRadius = 5, 
    heatAmp    = 0.5, 
    coolRate   = 0.5;

// POINTER STATE: every mouse button, finger or pen currently pressed on the canvas.
// pointerId -> { x, y, sign } with x/y as fractions of the canvas size and sign +1 = heat, -1 = cool
const activePointers = new Map();

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
    }
    if (isNaN(simAspectRatio) || simAspectRatio <= 0) simAspectRatio = 1;
    
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


// Pointer position as a fraction of the canvas size (resolution-independent)
function pointerFraction(e) {
  const r = canvas.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

// Left mouse button, touch and pen heat; right mouse button (or Shift + left button) cools
function pointerSign(e, buttons) {
  if (e.pointerType !== 'mouse') return 1;
  if (buttons & 1) return e.shiftKey ? -1 : 1;
  if (buttons & 2) return -1;
  return 0;
}

if (canvas) {
    canvas.addEventListener('pointerdown', (e) => {
        // e.button 0 = left (buttons bit 1), 2 = right (buttons bit 2); other buttons are ignored
        const sign = pointerSign(e, e.button === 0 ? 1 : (e.button === 2 ? 2 : 0));
        const pos = pointerFraction(e);
        if (!sign || !pos) return;
        e.preventDefault(); // No text selection or emulated mouse events while drawing
        activePointers.set(e.pointerId, { x: pos.x, y: pos.y, sign: sign });
        // Keep receiving moves (and the release) if the pointer is dragged off the canvas
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    });
    canvas.addEventListener('pointermove', (e) => {
        const pointer = activePointers.get(e.pointerId);
        if (!pointer) return;
        const pos = pointerFraction(e);
        if (pos) { pointer.x = pos.x; pointer.y = pos.y; }
        if (e.pointerType === 'mouse') {
            // Pressing/releasing a second button (or Shift) mid-drag switches between heating and cooling
            const sign = pointerSign(e, e.buttons);
            if (sign) pointer.sign = sign;
        }
    });
    const endPointer = (e) => { activePointers.delete(e.pointerId); };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('lostpointercapture', endPointer);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // Right-click is used for cooling
    window.addEventListener('blur', () => activePointers.clear()); // Don't keep heating after switching windows
}

function IX(i,j){ return i + j*size; }
function setBnd(b, x_arr) {
  for (let i = 1; i <= N; i++) {
    // Vertical boundaries (sides: left i=0, right i=N+1)
    // b=1 for reflection (e.g., u velocity against vertical wall)
    x_arr[IX(0, i)]   = (b === 1) ? -x_arr[IX(1, i)] : x_arr[IX(1, i)];
    x_arr[IX(N+1, i)] = (b === 1) ? -x_arr[IX(N, i)] : x_arr[IX(N, i)];

    // Horizontal boundaries (bottom j=0, top j=N+1; j increases upwards and is drawn flipped)
    // b=2 for reflection (e.g., v velocity against horizontal wall)
    x_arr[IX(i, 0)]   = (b === 2) ? -x_arr[IX(i, 1)] : x_arr[IX(i, 1)];
    x_arr[IX(i, N+1)] = (b === 2) ? -x_arr[IX(i, N)] : x_arr[IX(i, N)];
  }
  x_arr[IX(0,   0)]   = 0.5*(x_arr[IX(1,0)]   + x_arr[IX(0,1)]);
  x_arr[IX(0,   N+1)] = 0.5*(x_arr[IX(1,N+1)] + x_arr[IX(0,N)]);
  x_arr[IX(N+1, 0)]   = 0.5*(x_arr[IX(N,0)]   + x_arr[IX(N+1,1)]);
  x_arr[IX(N+1, N+1)] = 0.5*(x_arr[IX(N, N+1)]+ x_arr[IX(N+1,N)]);
}
// Gauss-Seidel relaxation for c*x - a*(sum of 4 neighbours) = x0, starting from the current contents of x_arr
function linSolve(b, x_arr, x0_arr, a, c, iterations = iter) {
  const c_inv = 1.0 / c;
  for (let k_iter = 0; k_iter < iterations; k_iter++) {
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
// Gauss-Seidel sweeps needed for an implicit diffusion solve. Starting from the old field, the
// error is roughly r = 4a/(1+4a) of the field and shrinks by about r per sweep, so weakly diffusive
// solves (heat, water, acetone) converge in 1-2 sweeps; viscous fluids still get the full `iter`.
function diffusionIterations(a) {
  const r = 4*a / (1 + 4*a);
  if (r <= 0) return 0;
  return Math.max(1, Math.min(iter, Math.ceil(Math.log(0.01) / Math.log(r)) - 1));
}
function diffuse(b, x_arr, x0_arr, diff_coeff) {
  const a = physicsDt * diff_coeff * N * N;
  linSolve(b, x_arr, x0_arr, a, 1 + 4*a, diffusionIterations(a));
}
// Viscous diffusion of a velocity component. The implicit solve is done for the change
// delta = x - x0 and starts from the change made in the previous step, which barely varies in slow
// viscous flow. Without this warm start a few sweeps are far from converged for viscous fluids such as
// honey (more so on larger grids), which made them flow several times too freely.
function diffuseVelocity(b, x_arr, x0_arr, diff_coeff, delta_arr) {
  const a = physicsDt * diff_coeff * N * N;
  const rhs = divergence; // Free scratch space at this point of the step
  setBnd(b, x0_arr);
  for (let j = 1; j <= N; j++) {
    const curr_j_idx = j * size;
    for (let i = 1; i <= N; i++) {
      const idx = curr_j_idx + i;
      rhs[idx] = a * (x0_arr[idx - 1] + x0_arr[idx + 1] + x0_arr[idx - size] + x0_arr[idx + size] - 4*x0_arr[idx]);
    }
  }
  linSolve(b, delta_arr, rhs, a, 1 + 4*a, diffusionIterations(a));
  for (let j = 1; j <= N; j++) {
    const curr_j_idx = j * size;
    for (let i = 1; i <= N; i++) {
      const idx = curr_j_idx + i;
      x_arr[idx] = x0_arr[idx] + delta_arr[idx];
    }
  }
  setBnd(b, x_arr);
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
// Makes the velocity field divergence-free (incompressible) by subtracting a pressure gradient.
// p_arr is not cleared: it still holds this projection's pressure from the previous step, which is
// already close to the answer, so the few Gauss-Seidel sweeps converge at every grid size.
function project(u_vel, v_vel, p_arr, div_arr) {
  const h = 1.0 / N;
  for (let j = 1; j <= N; j++) {
    const prev_j_idx = (j-1) * size;
    const curr_j_idx = j * size;
    const next_j_idx = (j+1) * size;
    for (let i = 1; i <= N; i++) {
      const idx = curr_j_idx + i;
      div_arr[idx] = -0.5 * h * (
        u_vel[idx + 1] - u_vel[idx - 1] +           // u_vel[IX(i+1,j)] - u_vel[IX(i-1,j)]
        v_vel[next_j_idx + i] - v_vel[prev_j_idx + i] // v_vel[IX(i,j+1)] - v_vel[IX(i,j-1)]
      );
    }
  }
  setBnd(0, div_arr); setBnd(0, p_arr);
  linSolve(0, p_arr, div_arr, 1, 4);

  const N_half = 0.5 * N;
  let pSum = 0;

  for (let j = 1; j <= N; j++) {
    const prev_j_idx = (j-1) * size;
    const curr_j_idx = j * size;
    const next_j_idx = (j+1) * size;
    for (let i = 1; i <= N; i++) {
      const idx = curr_j_idx + i;
      u_vel[idx] -= N_half * (p_arr[idx + 1] - p_arr[idx - 1]); // p_arr[IX(i+1,j)] - p_arr[IX(i-1,j)]
      v_vel[idx] -= N_half * (p_arr[next_j_idx + i] - p_arr[prev_j_idx + i]); // p_arr[IX(i,j+1)] - p_arr[IX(i,j-1)]
      pSum += p_arr[idx];
    }
  }
  // Pressure is only defined up to a constant; keep its mean at zero so the reused field can't drift
  const pMean = pSum / (N*N);
  for (let k = 0; k < p_arr.length; k++) p_arr[k] -= pMean;
  setBnd(1, u_vel); setBnd(2, v_vel);
}
function sumInterior(x_arr) {
  let sum = 0;
  for (let j = 1; j <= N; j++) {
    const base_j_idx = j * size;
    for (let i = 1; i <= N; i++) sum += x_arr[base_j_idx + i];
  }
  return sum;
}
function addSource(x_arr, s_arr) {
  for (let i = 0; i < x_arr.length; i++) x_arr[i] += physicsDt * s_arr[i];
}

// Temperature colour map (0 = blue, 0.5 = green, 1 = red), precomputed so rendering is a table lookup.
const COLOR_LEVELS = 256;
const colorLUT = new Uint8Array(COLOR_LEVELS * 3);
(function buildColorLUT() {
    for (let k = 0; k < COLOR_LEVELS; k++) {
        const t = k / (COLOR_LEVELS - 1);
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

        colorLUT[k*3]     = Math.round(r_prime * 255);
        colorLUT[k*3 + 1] = Math.round(g_prime * 255);
        colorLUT[k*3 + 2] = Math.round(b_prime * 255);
    }
})();

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
    const maxLevel = COLOR_LEVELS - 1;

    for (let y_px = 0; y_px < N; y_px++) {
        const sim_j = N - y_px; // Row in simulation grid (decreases as y_px increases)
        const dens_row_start_idx = sim_j * size; // Precalculate row start for dens array

        for (let x_px = 0; x_px < N; x_px++) {
            const sim_i = x_px + 1; // Column in simulation grid
            const T_val = dens[dens_row_start_idx + sim_i]; // Optimized dens access
            const t = T_val > 0 ? (T_val < 1 ? T_val : 1) : 0;
            const lut_idx = ((t * maxLevel + 0.5) | 0) * 3;

            data[data_idx++] = colorLUT[lut_idx];
            data[data_idx++] = colorLUT[lut_idx + 1];
            data[data_idx++] = colorLUT[lut_idx + 2];
            data[data_idx++] = 255;
        }
    }
    offscreenCtx.putImageData(offscreenImageData, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(offscreenCanvas, 0, 0, canvas.width, canvas.height);
}
// Adds heat (sign = +1) or removes it (sign = -1) around a point given as a fraction of the canvas
// width/height. The radius is measured in cells of the 64x64 reference grid, so the brush covers the
// same area (and adds the same heat per second) at every grid size.
function applyHeatBrush(xFrac, yFrac, sign) {
  const r = heatRadius * N / referenceN;
  const rSq = r*r, twiceRSq = 2*rSq, reach = Math.floor(r);
  const ci = Math.floor(xFrac * N) + 1;
  const cj = N - Math.floor(yFrac * N);
  const amount = sign * heatAmpMult * heatAmp;
  for (let dj = -reach; dj <= reach; dj++) {
    const jj = cj + dj;
    if (jj < 1 || jj > N) continue;
    for (let di = -reach; di <= reach; di++) {
      const ii = ci + di;
      if (ii < 1 || ii > N) continue;
      const d2 = di*di + dj*dj;
      if (d2 <= rSq) dens_prev[IX(ii,jj)] += amount * Math.exp(-d2/twiceRSq);
    }
  }
}
function simulate() {
  dens_prev.fill(0);

  // Heat or cool around every active pointer (mouse, fingers, pen)
  activePointers.forEach((pointer) => applyHeatBrush(pointer.x, pointer.y, pointer.sign));

  prev_avg_density = avg_density; avg_density = 0;

  // Buoyancy: fluid warmer than average is pushed up (+v), cooler fluid down (Boussinesq approximation)
  const buoyancyStep = physicsDt * buoyancyCoeff;
  for (let j = 1; j <= N; j++) {
    const base_j_idx = j * size;
    for (let i = 1; i <= N; i++) {
      const id = base_j_idx + i;
      avg_density += dens[id];
      const anomaly = dens[id] - prev_avg_density;
      v[id] += buoyancyStep * anomaly;
    }
  }
  avg_density /= (N*N);

  u0.set(u); diffuseVelocity(1, u, u0, visc, viscousDeltaU);
  v0.set(v); diffuseVelocity(2, v, v0, visc, viscousDeltaV);

  project(u, v, pressure1, divergence);

  u0.set(u); v0.set(v);
  advect(1, u, u0, u0, v0); // u0, v0 are velocity fields for advection of u
  advect(2, v, v0, u0, v0); // u0, v0 are velocity fields for advection of v

  project(u, v, pressure2, divergence);

  addSource(dens, dens_prev);
  // Clamp temperature after adding the heat source: 0 = 0 °C (blue) ... 1 = 100 °C (red)
  for (let i = 0; i < dens.length; i++) {
    dens[i] = Math.max(0, Math.min(1, dens[i]));
  }
  const heatBefore = sumInterior(dens);
  dens0.set(dens); diffuse(0, dens, dens0, diff);
  dens0.set(dens); advect(0, dens, dens0, u, v); // u, v are velocity fields for advection of dens

  // Diffusion and advection only move heat around, but semi-Lagrangian advection is not exactly
  // conservative (mostly next to the walls). Spread the tiny error evenly over the fluid so the total
  // heat only changes through heating, cooling and the 0-100 °C limits.
  const heatCorrection = (heatBefore - sumInterior(dens)) / (N*N);
  for (let j = 1; j <= N; j++) {
    const base_j_idx = j * size;
    for (let i = 1; i <= N; i++) {
      const idx = base_j_idx + i;
      dens[idx] = Math.max(0, Math.min(1, dens[idx] + heatCorrection));
    }
  }

  // Surface cooling: a layer 3 cells deep on the 64x64 reference grid (the same physical depth at
  // every grid size) loses heat, most strongly right at the surface
  const coolRows = Math.max(1, Math.round(3 * N / referenceN));
  for (let k = 0; k < coolRows; k++) {
    const j_cool = N - k;
    const currentGradient = 1.0 / (1 + k * referenceN / N); // 1, 1/2, 1/3 on the 64x64 grid
    const base_j_cool_idx = j_cool * size;
    const scaledCoolRateBase = (coolAmpMult * coolRate / 100) * currentGradient;

    for (let i = 1; i <= N; i++) {
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
  const physicsStart = performance.now();
  while (accumulatedTime >= physicsInterval) {
    const stepStart = performance.now();
    simulate();
    const stepEnd = performance.now();
    physicsStepMs += 0.1 * ((stepEnd - stepStart) - physicsStepMs);
    accumulatedTime -= physicsInterval;
    if (accumulatedTime >= physicsInterval && stepEnd - physicsStart + physicsStepMs > maxPhysicsMsPerFrame) {
      accumulatedTime = 0; // Can't keep up: drop the backlog rather than spiral into ever longer frames
      break;
    }
  }
  updateAverageDisplay();

  if (canvas.width > 0 && canvas.height > 0) {
    renderDensity();
  }
  updateFPS(timestamp);
  requestAnimationFrame(step);
}

let lastAvgText = '';
function updateAverageDisplay() {
  if (!avgDensityDisplay) return;
  const text = (avg_density * 100).toFixed(1);
  if (text !== lastAvgText) {
    avgDensityDisplay.textContent = text;
    lastAvgText = text;
  }
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
    dens     = new Float32Array(size*size);
    dens_prev= new Float32Array(size*size);
    u0       = new Float32Array(size*size);
    v0       = new Float32Array(size*size);
    dens0    = new Float32Array(size*size);
    pressure1  = new Float32Array(size*size);
    pressure2  = new Float32Array(size*size);
    viscousDeltaU = new Float32Array(size*size);
    viscousDeltaV = new Float32Array(size*size);
    divergence = new Float32Array(size*size);

    for (let i = 0; i < dens.length; i++) dens[i] = ambientTemp;
    avg_density = ambientTemp;
    prev_avg_density = ambientTemp;

    // Reset any other necessary simulation state related to grid size
    if (offscreenCanvas) {
        offscreenCanvas.width = N;
        offscreenCanvas.height = N;
        if (offscreenCtx) offscreenImageData = offscreenCtx.createImageData(N, N);
    }
    // Pointer positions are stored as fractions of the canvas, so they stay valid at the new size
}

// Expose setSize to be called from simulation_ui.js
window.convectionSimulation = {
    setSize: function(newSize) {
        reinitializeArrays(newSize); // Reallocates the arrays for the new grid
        resetSimulation(); // Resets the fluid and time state
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
    dens.fill(ambientTemp);
    dens_prev.fill(0);
    u0.fill(0);
    v0.fill(0);
    pressure1.fill(0);
    pressure2.fill(0);
    viscousDeltaU.fill(0);
    viscousDeltaV.fill(0);
    divergence.fill(0);
    dens0.fill(ambientTemp);

    // Reset other relevant state variables. Pressed pointers are kept: they reflect what the user is
    // physically holding down, and are released by their own pointerup/pointercancel events.
    avg_density = ambientTemp;
    prev_avg_density = ambientTemp;
    accumulatedTime = 0;

    // Update UI elements if they exist
    updateAverageDisplay();
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