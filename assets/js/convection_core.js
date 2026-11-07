// GRID & PHYSICS PARAMETERS
let N    = 64; // Made N mutable
let size = N + 2;
// Reference grid size: the heating brush radius and the cooled surface layer are specified in cells
// of a 64x64 grid and scaled with N, so changing the grid size changes resolution, not the physics.
const referenceN = 64;
const iter = 4; // Gauss-Seidel sweeps per pressure/viscosity solve (both are warm-started, see below)
const diff   = 0.0001; // Heat diffusion coefficient
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

// FLUID STATE ARRAYS (size x size including a one-cell boundary; index with IX(i, j), j increases upwards)
// u, v: velocity. dens: temperature (0 = 0 °C ... 1 = 100 °C), named after the "density" field of
// Stam's stable-fluids method it is advected with. dens_prev: heat added by the brush this step.
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
let heatRadius = 8,    // brush radius as a percentage of the box width (the same area at every grid size)
    heatAmp    = 1,    // brush strength multiplier
    coolRate   = 0.5;  // surface cooling, 0 ... 1
const baseHeatAmp = 0.5; // heat added per step at strength 1x (before heatAmpMult)
let brushMode = 1;       // what a plain press does: +1 = heat, -1 = cool (Heat / Cool switch)
let showBrushGuides = true; // crosshair cursor and brush circle (settings toggle)

// POINTER STATE: every mouse button, finger or pen currently pressed on the canvas.
// pointerId -> { x, y, sign } with x/y as fractions of the canvas size and sign +1 = heat, -1 = cool
const activePointers = new Map();
let hoverPointer = null; // { x, y } fractions: an idle mouse over the canvas, to show the brush outline

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
const modeButtons = Array.from(document.querySelectorAll('.thermal-mode [data-mode]'));
const hintEl = document.getElementById('thermalHint');
const legendBar = document.getElementById('colourLegendBar');
const brushGuidesToggle = document.getElementById('brushGuidesToggle');

// Offscreen canvas
let offscreenCanvas = null;
let offscreenCtx = null;
let offscreenImageData = null;

// The shared layout sizes the canvas (normal and fullscreen); this only matches the drawing buffer to it.
function updateCanvasResolution() {
    if (!canvas) return;
    if (!ctx && canvas) ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Size the drawing buffer to the canvas's on-screen size (inside the box border) in device pixels,
    // so the brush outline and the cell edges are sharp on high-DPI screens. Pixel ratios above 2
    // would only cost fill rate.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const targetWidth = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const targetHeight = Math.max(1, Math.round(canvas.clientHeight * dpr));

    // Ensure offscreen canvas for simulation logic always matches N
    if (!offscreenCanvas || offscreenCanvas.width !== N || offscreenCanvas.height !== N) {
        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = N;
        offscreenCanvas.height = N;
        offscreenCtx = offscreenCanvas.getContext('2d');
        if (offscreenCtx) offscreenImageData = offscreenCtx.createImageData(N, N);
    }

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        // Resizing clears the canvas, and this can run after the frame's step() has drawn it:
        // redraw now so a blank frame isn't shown on every resize (e.g. during panel/fullscreen transitions)
        renderDensity();
    }
}


if (canvas) {
    // Resize the buffer whenever the canvas changes size (window resize, fullscreen, settings panel).
    // The observer runs after layout and before paint, so the redraw shows no blank frame.
    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => updateCanvasResolution()).observe(canvas);
    } else {
        window.addEventListener('resize', () => setTimeout(updateCanvasResolution, 100));
    }

    // Moving the window to a screen with a different pixel density changes devicePixelRatio
    // without resizing anything, so watch for that separately
    const watchPixelRatio = () => {
        if (!window.matchMedia) return;
        const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
        if (!query.addEventListener) return;
        query.addEventListener('change', () => { updateCanvasResolution(); watchPixelRatio(); }, { once: true });
    };
    watchPixelRatio();

    // Fallback initial sizing calls
    window.addEventListener('load', () => setTimeout(updateCanvasResolution, 250));
    if (document.readyState === "complete" || (document.readyState !== "loading" && !document.documentElement.doScroll)) {
       setTimeout(updateCanvasResolution, 200); 
    } else {
        document.addEventListener("DOMContentLoaded", () => setTimeout(updateCanvasResolution, 200));
    }
}


if(timeSlider && timeVal) timeSlider.oninput = () => { timeScale = +timeSlider.value; timeVal.textContent = timeScale.toFixed(1); };
if(radiusSlider && radiusVal) radiusSlider.oninput = () => { heatRadius = +radiusSlider.value; radiusVal.textContent = heatRadius.toFixed(0); };
if(heatAmpSlider && ampVal) {
    heatAmpSlider.oninput = () => { heatAmp = +heatAmpSlider.value; ampVal.textContent = heatAmp.toFixed(1); };
}
if(coolSlider && coolVal) coolSlider.oninput = () => { coolRate = +coolSlider.value / 100; coolVal.textContent = coolSlider.value; };
// Turning the guides off hides the brush circle and gives the canvas the normal cursor (convection_styles.css)
function syncBrushGuides() {
    showBrushGuides = !brushGuidesToggle || brushGuidesToggle.checked;
    if (canvas) canvas.classList.toggle('no-brush-guides', !showBrushGuides);
}
if (brushGuidesToggle) brushGuidesToggle.addEventListener('change', syncBrushGuides);
syncBrushGuides(); // A browser restoring the form state may have left it unchecked


// Pointer position as a fraction of the canvas size (resolution-independent)
function pointerFraction(e) {
  const r = canvas.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

// A plain press (left mouse button, touch, one or more fingers, pen) does what the Heat / Cool switch
// says; the right mouse button or Shift (or Ctrl) + left button does the opposite.
function pointerSign(e, buttons) {
  if (e.pointerType !== 'mouse') return brushMode;
  if (buttons & 1) return (e.shiftKey || e.ctrlKey) ? -brushMode : brushMode;
  if (buttons & 2) return -brushMode;
  return 0;
}

function hideHint() {
  if (hintEl && !hintEl.classList.contains('is-hidden')) hintEl.classList.add('is-hidden');
}

if (canvas) {
    canvas.addEventListener('pointerdown', (e) => {
        // e.button 0 = left (buttons bit 1), 2 = right (buttons bit 2); other buttons are ignored
        const sign = pointerSign(e, e.button === 0 ? 1 : (e.button === 2 ? 2 : 0));
        const pos = pointerFraction(e);
        if (!sign || !pos) return;
        e.preventDefault(); // No text selection or emulated mouse events while drawing
        activePointers.set(e.pointerId, { x: pos.x, y: pos.y, sign: sign });
        hoverPointer = null;
        hideHint();
        // Keep receiving moves (and the release) if the pointer is dragged off the canvas
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    });
    canvas.addEventListener('pointermove', (e) => {
        const pointer = activePointers.get(e.pointerId);
        if (!pointer) {
            if (e.pointerType !== 'touch') hoverPointer = pointerFraction(e); // brush outline under the mouse
            return;
        }
        const pos = pointerFraction(e);
        if (pos) { pointer.x = pos.x; pointer.y = pos.y; }
        if (e.pointerType === 'mouse') {
            // Pressing/releasing a second button (or Shift) mid-drag switches between heating and cooling
            const sign = pointerSign(e, e.buttons);
            if (sign) pointer.sign = sign;
        }
    });
    const endPointer = (e) => {
        if (!activePointers.delete(e.pointerId)) return;
        if (e.type === 'pointerup' && e.pointerType !== 'touch') hoverPointer = pointerFraction(e);
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('lostpointercapture', endPointer);
    canvas.addEventListener('pointerleave', (e) => { if (!activePointers.has(e.pointerId)) hoverPointer = null; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // Right-click is used for cooling
    // Don't keep heating after switching windows
    window.addEventListener('blur', () => { activePointers.clear(); hoverPointer = null; });
}

// Heat / Cool switch (a radio group: arrow keys move between the options)
function setBrushMode(mode) {
    brushMode = mode;
    modeButtons.forEach((button) => {
        const checked = (button.dataset.mode === 'cool' ? -1 : 1) === mode;
        button.setAttribute('aria-checked', String(checked));
        button.tabIndex = checked ? 0 : -1;
    });
}
modeButtons.forEach((button, index) => {
    button.addEventListener('click', () => setBrushMode(button.dataset.mode === 'cool' ? -1 : 1));
    button.addEventListener('keydown', (e) => {
        const step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1
            : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = modeButtons[(index + step + modeButtons.length) % modeButtons.length];
        next.click();
        next.focus();
    });
});
setBrushMode(1);

// The solver functions copy N and size (and the global arrays they use) into locals before their loops:
// the engine can then keep them in registers instead of re-reading the mutable globals on every cell.
function IX(i,j){ return i + j*size; }
function setBnd(b, x_arr) {
  const n = N, sz = size;
  const top = (n + 1) * sz; // IX(0, N+1)
  for (let i = 1; i <= n; i++) {
    const row = i * sz;
    // Vertical boundaries (sides: left i=0, right i=N+1)
    // b=1 for reflection (e.g., u velocity against vertical wall)
    x_arr[row]         = (b === 1) ? -x_arr[row + 1] : x_arr[row + 1];
    x_arr[row + n + 1] = (b === 1) ? -x_arr[row + n] : x_arr[row + n];

    // Horizontal boundaries (bottom j=0, top j=N+1; j increases upwards and is drawn flipped)
    // b=2 for reflection (e.g., v velocity against horizontal wall)
    x_arr[i]       = (b === 2) ? -x_arr[sz + i] : x_arr[sz + i];
    x_arr[top + i] = (b === 2) ? -x_arr[top - sz + i] : x_arr[top - sz + i];
  }
  x_arr[0]           = 0.5*(x_arr[1]       + x_arr[sz]);              // IX(0, 0)
  x_arr[top]         = 0.5*(x_arr[top + 1] + x_arr[top - sz]);        // IX(0, N+1)
  x_arr[n + 1]       = 0.5*(x_arr[n]       + x_arr[sz + n + 1]);      // IX(N+1, 0)
  x_arr[top + n + 1] = 0.5*(x_arr[top + n] + x_arr[top - sz + n + 1]); // IX(N+1, N+1)
}
// One Gauss-Seidel update of the cell at index p
function relaxCell(x_arr, x0_arr, p, sz, a, c_inv) {
  x_arr[p] = (x0_arr[p] + a*(x_arr[p - 1] + x_arr[p + 1] + x_arr[p - sz] + x_arr[p + sz])) * c_inv;
}
// Gauss-Seidel relaxation for c*x - a*(sum of 4 neighbours) = x0, starting from the current contents of x_arr.
// A sweep updates the cells row by row, each from the neighbours already updated (left, below) and the
// ones still to come (right, above). Each cell has to wait for the one just before it, so the sweep goes
// four rows at a time instead, each row one column behind the row below: every cell still sees exactly
// the same neighbour values, and gets exactly the same result, but four cells are in progress at once,
// which is over twice as fast.
function linSolve(b, x_arr, x0_arr, a, c, iterations = iter) {
  const n = N, sz = size;
  const c_inv = 1.0 / c;
  for (let k_iter = 0; k_iter < iterations; k_iter++) {
    let j = 1;
    for (; j + 3 <= n; j += 4) {
      const r0 = j * sz, r1 = r0 + sz, r2 = r1 + sz, r3 = r2 + sz;
      // Start of the staircase: columns 1-3 of the lower rows
      for (let t = 1; t <= 3; t++) {
        for (let r = 0; r < t; r++) relaxCell(x_arr, x0_arr, r0 + r * sz + t - r, sz, a, c_inv);
      }
      for (let i = 4; i <= n; i++) {
        let p = r0 + i;
        x_arr[p] = (x0_arr[p] + a*(x_arr[p - 1] + x_arr[p + 1] + x_arr[p - sz] + x_arr[p + sz])) * c_inv;
        p = r1 + i - 1;
        x_arr[p] = (x0_arr[p] + a*(x_arr[p - 1] + x_arr[p + 1] + x_arr[p - sz] + x_arr[p + sz])) * c_inv;
        p = r2 + i - 2;
        x_arr[p] = (x0_arr[p] + a*(x_arr[p - 1] + x_arr[p + 1] + x_arr[p - sz] + x_arr[p + sz])) * c_inv;
        p = r3 + i - 3;
        x_arr[p] = (x0_arr[p] + a*(x_arr[p - 1] + x_arr[p + 1] + x_arr[p - sz] + x_arr[p + sz])) * c_inv;
      }
      // End of the staircase: the last columns of the upper rows
      for (let t = n + 1; t <= n + 3; t++) {
        for (let r = t - n; r <= 3; r++) relaxCell(x_arr, x0_arr, r0 + r * sz + t - r, sz, a, c_inv);
      }
    }
    // Rows left over when N is not a multiple of 4
    for (; j <= n; j++) {
      const end = j * sz + n + 1;
      for (let p = j * sz + 1; p < end; p++) relaxCell(x_arr, x0_arr, p, sz, a, c_inv);
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
  const n = N, sz = size;
  const a = physicsDt * diff_coeff * n * n;
  const rhs = divergence; // Free scratch space at this point of the step
  setBnd(b, x0_arr);
  for (let j = 1; j <= n; j++) {
    const end = j * sz + n + 1;
    for (let idx = j * sz + 1; idx < end; idx++) {
      rhs[idx] = a * (x0_arr[idx - 1] + x0_arr[idx + 1] + x0_arr[idx - sz] + x0_arr[idx + sz] - 4*x0_arr[idx]);
    }
  }
  linSolve(b, delta_arr, rhs, a, 1 + 4*a, diffusionIterations(a));
  for (let j = 1; j <= n; j++) {
    const end = j * sz + n + 1;
    for (let idx = j * sz + 1; idx < end; idx++) x_arr[idx] = x0_arr[idx] + delta_arr[idx];
  }
  setBnd(b, x_arr);
}
function advect(b, d_arr, d0_arr, u_vel, v_vel) {
  const n = N, sz = size;
  const dt0 = physicsDt * n;
  const maxCoord = n + 0.5;
  for (let j = 1; j <= n; j++) {
    const curr_j_idx = j * sz;
    for (let i = 1; i <= n; i++) {
      const current_idx = curr_j_idx + i;
      let x_coord = i - dt0 * u_vel[current_idx];
      let y_coord = j - dt0 * v_vel[current_idx];

      x_coord = Math.max(0.5, Math.min(maxCoord, x_coord));
      y_coord = Math.max(0.5, Math.min(maxCoord, y_coord));

      const i0 = x_coord | 0; // Use bitwise OR for floor on positive numbers
      const j0 = y_coord | 0;

      const s1 = x_coord - i0, s0 = 1 - s1;
      const t1 = y_coord - j0, t0 = 1 - t1;

      const base_idx_i0j0 = i0 + j0 * sz; // IX(i0, j0)
      d_arr[current_idx] =
        s0*(t0*d0_arr[base_idx_i0j0] + t1*d0_arr[base_idx_i0j0 + sz]) +
        s1*(t0*d0_arr[base_idx_i0j0 + 1] + t1*d0_arr[base_idx_i0j0 + 1 + sz]);
    }
  }
  setBnd(b, d_arr);
}
// Makes the velocity field divergence-free (incompressible) by subtracting a pressure gradient.
// p_arr is not cleared: it still holds this projection's pressure from the previous step, which is
// already close to the answer, so the few Gauss-Seidel sweeps converge at every grid size.
function project(u_vel, v_vel, p_arr, div_arr) {
  const n = N, sz = size;
  const h = 1.0 / n;
  for (let j = 1; j <= n; j++) {
    const end = j * sz + n + 1;
    for (let idx = j * sz + 1; idx < end; idx++) {
      div_arr[idx] = -0.5 * h * (
        u_vel[idx + 1] - u_vel[idx - 1] +  // u_vel[IX(i+1,j)] - u_vel[IX(i-1,j)]
        v_vel[idx + sz] - v_vel[idx - sz]  // v_vel[IX(i,j+1)] - v_vel[IX(i,j-1)]
      );
    }
  }
  setBnd(0, div_arr); setBnd(0, p_arr);
  linSolve(0, p_arr, div_arr, 1, 4);

  const N_half = 0.5 * n;
  let pSum = 0;

  for (let j = 1; j <= n; j++) {
    const end = j * sz + n + 1;
    for (let idx = j * sz + 1; idx < end; idx++) {
      u_vel[idx] -= N_half * (p_arr[idx + 1] - p_arr[idx - 1]);   // p_arr[IX(i+1,j)] - p_arr[IX(i-1,j)]
      v_vel[idx] -= N_half * (p_arr[idx + sz] - p_arr[idx - sz]); // p_arr[IX(i,j+1)] - p_arr[IX(i,j-1)]
      pSum += p_arr[idx];
    }
  }
  // Pressure is only defined up to a constant; keep its mean at zero so the reused field can't drift
  const pMean = pSum / (n*n);
  for (let k = 0, len = p_arr.length; k < len; k++) p_arr[k] -= pMean;
  setBnd(1, u_vel); setBnd(2, v_vel);
}
function sumInterior(x_arr) {
  const n = N, sz = size;
  let sum = 0;
  for (let j = 1; j <= n; j++) {
    const end = j * sz + n + 1;
    for (let idx = j * sz + 1; idx < end; idx++) sum += x_arr[idx];
  }
  return sum;
}
function addSource(x_arr, s_arr) {
  for (let i = 0, len = x_arr.length; i < len; i++) x_arr[i] += physicsDt * s_arr[i];
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
    // The legend under the canvas shows the same scale
    if (legendBar) {
        const stops = [];
        for (let s = 0; s <= 8; s++) {
            const k = Math.round(s / 8 * (COLOR_LEVELS - 1)) * 3;
            stops.push(`rgb(${colorLUT[k]}, ${colorLUT[k + 1]}, ${colorLUT[k + 2]})`);
        }
        legendBar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
    }
})();

// SOLVER: the GPU version of the solver below (convection_gpu.js, WebGL2) when the browser can run it,
// which is fast enough for a 256x256 grid; otherwise the CPU solver below. ?solver=cpu in the address
// forces the CPU solver. The GPU solver's shaders take a moment to build after the page loads; until
// then the fluid stays at rest (drawn by the CPU renderer).
let gpuSolver = null;
(function createGpuSolver() {
    if (typeof window.createConvectionGpuSolver !== 'function') return;
    if (new URLSearchParams(window.location.search).get('solver') === 'cpu') return;
    try {
        gpuSolver = window.createConvectionGpuSolver({
            n: N, dt: physicsDt, diffusion: diff, buoyancy: buoyancyCoeff, ambientTemp, referenceN, colorLUT,
        });
    } catch (err) {
        console.warn('Convection: GPU solver unavailable, using the CPU solver', err);
        gpuSolver = null;
    }
})();
const cpuGridSizes = [48, 64, 96, 128];
const gpuGridSizes = [48, 64, 96, 128, 256];

// The GPU solver's WebGL context can be lost (a driver reset, say): carry on with the CPU solver
function switchToCpuSolver() {
    gpuSolver = null;
    const selector = document.getElementById('convectionGridSizeSelector');
    if (selector) Array.from(selector.options).forEach((option) => { if (!cpuGridSizes.includes(+option.value)) option.remove(); });
    const newN = cpuGridSizes.includes(N) ? N : cpuGridSizes[cpuGridSizes.length - 1];
    window.convectionSimulation.setSize(newN);
    if (selector) selector.value = String(newN);
}

// Outline of the brush: under an idle mouse, and around every pointer that is heating or cooling
function drawBrushOutlines() {
    if (!showBrushGuides || (!hoverPointer && activePointers.size === 0)) return;
    const w = canvas.width, h = canvas.height;
    const radius = heatRadius / 100 * w;
    const dpr = w / Math.max(1, canvas.clientWidth);
    // A light line over a dark one stays visible on every colour of the scale; cooling is dashed.
    const ring = (x, y, sign, alpha) => {
        ctx.setLineDash(sign > 0 ? [] : [6 * dpr, 4 * dpr]);
        ctx.beginPath();
        ctx.arc(x * w, y * h, radius, 0, Math.PI * 2);
        ctx.lineWidth = 3 * dpr;
        ctx.strokeStyle = `rgba(0, 0, 0, ${0.35 * alpha})`;
        ctx.stroke();
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.stroke();
    };
    if (hoverPointer) ring(hoverPointer.x, hoverPointer.y, brushMode, 0.6);
    activePointers.forEach((p) => ring(p.x, p.y, p.sign, 0.85));
    ctx.setLineDash([]);
}

function renderDensity() {
    if (!ctx) return;
    if (gpuSolver && gpuSolver.ready()) {
        // The GPU solver draws the N x N cells into its own canvas, scaled up here like the CPU's image
        gpuSolver.render();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(gpuSolver.canvas, 0, 0, canvas.width, canvas.height);
        drawBrushOutlines();
        return;
    }
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

    // Nearest-neighbour upscaling: each grid cell is drawn as a crisp square block.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(offscreenCanvas, 0, 0, canvas.width, canvas.height);
    drawBrushOutlines();
}
// Adds heat (sign = +1) or removes it (sign = -1) around a point given as a fraction of the canvas
// width/height. The radius is a percentage of the box width, so the brush covers the same area (and
// adds the same heat per second) at every grid size.
function applyHeatBrush(pointer) {
  const r = heatRadius / 100 * N;
  const rSq = r*r, twiceRSq = 2*rSq, reach = Math.floor(r);
  const [ci, cj, amount] = brushSpot(pointer);
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
// A brush's centre cell (i, j) and the heat it adds per step there
function brushSpot(pointer) {
  return [Math.floor(pointer.x * N) + 1, N - Math.floor(pointer.y * N), pointer.sign * heatAmpMult * baseHeatAmp * heatAmp];
}
// Depth of the cooled surface layer: 3 cells on the 64x64 reference grid (the same physical depth at
// every grid size)
function surfaceCoolingRows() {
  return Math.max(1, Math.round(3 * N / referenceN));
}
// The same step on the GPU solver
function simulateGpu() {
  const brushes = [];
  activePointers.forEach((pointer) => brushes.push(brushSpot(pointer)));
  const r = heatRadius / 100 * N;
  gpuSolver.step({
    visc,
    viscSweeps: diffusionIterations(physicsDt * visc * N * N),
    heatSweeps: diffusionIterations(physicsDt * diff * N * N),
    coolBase: coolAmpMult * coolRate / 100,
    coolRows: surfaceCoolingRows(),
    brushes,
    brushRSq: r * r,
  });
}
function simulate() {
  if (gpuSolver) {
    if (gpuSolver.ready()) simulateGpu();
    return;
  }
  const n = N, sz = size;
  dens_prev.fill(0);

  // Heat or cool around every active pointer (mouse, fingers, pen)
  activePointers.forEach(applyHeatBrush);

  prev_avg_density = avg_density;

  // Buoyancy: fluid warmer than average is pushed up (+v), cooler fluid down (Boussinesq approximation)
  const buoyancyStep = physicsDt * buoyancyCoeff;
  const temp = dens, vel_v = v, prevAvg = prev_avg_density;
  let tempSum = 0;
  for (let j = 1; j <= n; j++) {
    const end = j * sz + n + 1;
    for (let id = j * sz + 1; id < end; id++) {
      tempSum += temp[id];
      const anomaly = temp[id] - prevAvg;
      vel_v[id] += buoyancyStep * anomaly;
    }
  }
  avg_density = tempSum / (n*n);

  u0.set(u); diffuseVelocity(1, u, u0, visc, viscousDeltaU);
  v0.set(v); diffuseVelocity(2, v, v0, visc, viscousDeltaV);

  project(u, v, pressure1, divergence);

  u0.set(u); v0.set(v);
  advect(1, u, u0, u0, v0); // u0, v0 are velocity fields for advection of u
  advect(2, v, v0, u0, v0); // u0, v0 are velocity fields for advection of v

  project(u, v, pressure2, divergence);

  addSource(dens, dens_prev);
  // Clamp temperature after adding the heat source: 0 = 0 °C (blue) ... 1 = 100 °C (red)
  for (let i = 0, len = temp.length; i < len; i++) {
    temp[i] = Math.max(0, Math.min(1, temp[i]));
  }
  const heatBefore = sumInterior(dens);
  dens0.set(dens); diffuse(0, dens, dens0, diff);
  dens0.set(dens); advect(0, dens, dens0, u, v); // u, v are velocity fields for advection of dens

  // Diffusion and advection only move heat around, but semi-Lagrangian advection is not exactly
  // conservative (mostly next to the walls). Spread the tiny error evenly over the fluid so the total
  // heat only changes through heating, cooling and the 0-100 °C limits.
  const heatCorrection = (heatBefore - sumInterior(dens)) / (n*n);
  for (let j = 1; j <= n; j++) {
    const end = j * sz + n + 1;
    for (let idx = j * sz + 1; idx < end; idx++) {
      temp[idx] = Math.max(0, Math.min(1, temp[idx] + heatCorrection));
    }
  }

  // Surface cooling: the surface layer loses heat, most strongly right at the surface
  const coolRows = surfaceCoolingRows();
  for (let k = 0; k < coolRows; k++) {
    const j_cool = n - k;
    const currentGradient = 1.0 / (1 + k * referenceN / n); // 1, 1/2, 1/3 on the 64x64 grid
    const base_j_cool_idx = j_cool * sz;
    const scaledCoolRateBase = (coolAmpMult * coolRate / 100) * currentGradient;

    for (let i = 1; i <= n; i++) {
        const noise = 1 + (Math.random() - 0.5) * 0.2; // 0.9 to 1.1
        const idx = base_j_cool_idx + i;
        temp[idx] *= (1 - scaledCoolRateBase * noise);
        temp[idx] = Math.max(0, temp[idx]);
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
// GPU solver: simulate() only queues work, which the GPU does after this frame's script has run, so it
// can't be timed like the CPU solver. Instead each frame checks whether the GPU is keeping up (it has
// finished the work of the frame before last, and this frame came on time): if it is, and the last frame
// wanted more steps than the limit allowed, the limit rises by one; if not, it drops by a quarter.
let gpuStepLimit = 4;
let gpuLimitReached = false;
let refreshMs = 1000 / 60; // the shortest recent time between frames: the display's refresh period
function updateGpuStepLimit(frameMs) {
  if (frameMs > 0) refreshMs = frameMs < refreshMs ? frameMs : refreshMs + 0.01 * (frameMs - refreshMs);
  if (!gpuSolver.caughtUp() || frameMs > 1.25 * refreshMs) gpuStepLimit = Math.max(1, Math.floor(gpuStepLimit * 0.75));
  else if (gpuLimitReached) gpuStepLimit++;
  gpuLimitReached = false;
  return gpuStepLimit;
}
function step(timestamp) {
  if (gpuSolver && gpuSolver.lost) switchToCpuSolver();
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
  const gpuRunning = gpuSolver !== null && gpuSolver.ready();
  // While the GPU solver's shaders are still building the fluid waits at rest
  accumulatedTime = gpuSolver && !gpuRunning ? 0 : accumulatedTime + cappedDeltaTime * timeScale;
  const physicsInterval = 1.0 / targetPhysicsRate;
  const physicsStart = performance.now();
  const stepLimit = gpuRunning ? updateGpuStepLimit(deltaTime * 1000) : Infinity;
  let steps = 0;
  while (accumulatedTime >= physicsInterval) {
    const stepStart = performance.now();
    simulate();
    steps++;
    const stepEnd = performance.now();
    physicsStepMs += 0.1 * ((stepEnd - stepStart) - physicsStepMs);
    accumulatedTime -= physicsInterval;
    if (accumulatedTime >= physicsInterval && (steps >= stepLimit || stepEnd - physicsStart + physicsStepMs > maxPhysicsMsPerFrame)) {
      accumulatedTime = 0; // Can't keep up: drop the backlog rather than spiral into ever longer frames
      gpuLimitReached = steps >= stepLimit;
      break;
    }
  }
  if (gpuRunning) avg_density = gpuSolver.averageTemperature();
  updateAverageDisplay();

  if (canvas.width > 0 && canvas.height > 0) {
    renderDensity();
  }
  if (gpuRunning) gpuSolver.endFrame();
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
if (radiusSlider && radiusVal) { heatRadius = +radiusSlider.value; radiusVal.textContent = heatRadius.toFixed(0); }
if (heatAmpSlider && ampVal) { heatAmp = +heatAmpSlider.value; ampVal.textContent = heatAmp.toFixed(1); }
if (coolSlider && coolVal) { coolRate = +coolSlider.value / 100; coolVal.textContent = coolSlider.value; }
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
    if (gpuSolver) {
        gpuSolver.resize(N);
        gpuStepLimit = 4; // a step's cost changes with the grid size
    }
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
        return gpuSolver ? gpuGridSizes : cpuGridSizes;
    },
    get solver() { return gpuSolver ? 'gpu' : 'cpu'; },
    get gpuSolver() { return gpuSolver; },
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
    if (gpuSolver) gpuSolver.reset();

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