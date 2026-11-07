// Convection simulation: the solver of convection_core.js run on the GPU with WebGL2, which is fast
// enough for a 256x256 grid. convection_core.js uses it when the browser supports it and falls back to
// its own CPU solver otherwise.
//
// A step does what simulate() in convection_core.js does, in the same order and with the same boundary
// rules. Each field is a float texture of the N x N fluid cells; the boundary cells around them are not
// stored but worked out when read, giving the values setBnd() would have put there. What differs:
// - Gauss-Seidel sweeps update the cells in two halves, the "red" and then the "black" squares of a
//   checkerboard, as a GPU updates many cells at once rather than one after another. This converges as
//   fast as the CPU's row-by-row order, but not along the same path, so results differ very slightly.
// - At 256x256, a size the CPU solver doesn't offer, the solves get more sweeps (TUNING below).
// - The random flicker of the surface cooling comes from a hash of the cell and the step number.
// - Sums over the grid (average temperature, heat correction, pressure mean) are added up on the GPU in
//   single precision.
(function () {
    'use strict';

    const MAX_BRUSHES = 16; // pointers heating or cooling at once (more fingers than that are ignored)
    const REDUCE_BLOCK = 8; // a reduction pass adds up blocks of 8 x 8 values

    // Gauss-Seidel sweeps and over-relaxation factor of the iterative solves. Up to 128x128 these are the
    // CPU solver's, which then gives the same flow. At 256x256 they fall well short of converging, which
    // makes the flow up to half as fast again as it should be, so there the pressure solve gets 16
    // over-relaxed sweeps, and the viscous solve of the thick fluids (a > 1, where it converges as slowly
    // as the pressure one) four times the sweeps, over-relaxed by the factor that suits it best. Both then
    // come to within a few per cent of a fully converged solve: the same flow as at the smaller sizes.
    // (With only twice the sweeps honey's flow picks up, within about 1000 steps, a grid-scale roughness
    // along the walls that a converged solve doesn't have.)
    const TUNING = {
        pressure: (n) => (n > 128 ? { sweeps: 16, omega: 1.8 } : { sweeps: 4, omega: 1 }),
        // a: the solve's coupling (dt * viscosity * n^2); cpuSweeps: diffusionIterations(a)
        viscous: (n, a, cpuSweeps) => {
            if (n <= 128 || a <= 1) return { sweeps: cpuSweeps, omega: 1 };
            const r = 4 * a / (1 + 4 * a); // how much of the error a Jacobi sweep leaves
            return { sweeps: 4 * cpuSweeps, omega: Math.min(1.8, 2 / (1 + Math.sqrt(1 - r * r))) };
        },
    };

    const VERTEX_SHADER = `#version 300 es
void main() {
    // One triangle covering the whole target; no vertex buffers needed
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

    const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform int uN;
out vec4 outColor;
// The fluid cell (i, j) this fragment computes: 1..N in both directions, j upwards (IX(i, j) on the CPU)
ivec2 cell() { return ivec2(gl_FragCoord.xy) + 1; }
// A field at cell c, boundary cells (0 and N+1) included. Scalars copy the nearest fluid cell there
// (setBnd with b = 0); velocities do too, except that u changes sign at the side walls and v at the top
// and bottom (b = 1 and 2), which makes both 0 in the corners.
float scalarAt(sampler2D t, ivec2 c) {
    return texelFetch(t, clamp(c, ivec2(1), ivec2(uN)) - 1, 0).r;
}
vec2 velocityAt(sampler2D t, ivec2 c) {
    ivec2 q = clamp(c, ivec2(1), ivec2(uN));
    vec2 w = texelFetch(t, q - 1, 0).rg;
    bvec2 wall = notEqual(c, q);
    if (wall.x && wall.y) return vec2(0.0);
    if (wall.x) w.x = -w.x;
    if (wall.y) w.y = -w.y;
    return w;
}
const ivec2 DX = ivec2(1, 0), DY = ivec2(0, 1);
`;

    // Each program: fragment shader body and its textures, in texture-unit order
    const PROGRAMS = {
        // v += dt * buoyancy * (T - average T of the previous step)
        buoyancy: {
            textures: ['uVel', 'uTemp', 'uStats'],
            source: `
uniform sampler2D uVel, uTemp, uStats;
uniform float uBuoyStep;
void main() {
    ivec2 c = cell();
    vec2 w = texelFetch(uVel, c - 1, 0).rg;
    w.y += uBuoyStep * (texelFetch(uTemp, c - 1, 0).r - texelFetch(uStats, ivec2(0), 0).r);
    outColor = vec4(w, 0.0, 0.0);
}`,
        },
        // One half-sweep (cells with (i + j) % 2 == uParity) of the viscous solve for the velocity change
        // (diffuseVelocity): (1 + 4a) d - a (sum of the neighbours' d) = a * laplacian(vel0), over-relaxed
        // by uOmega
        viscosity: {
            textures: ['uDelta', 'uVel0'],
            source: `
uniform sampler2D uDelta, uVel0;
uniform float uA, uCInv, uOmega;
uniform int uParity;
void main() {
    ivec2 c = cell();
    vec2 d = texelFetch(uDelta, c - 1, 0).rg;
    if (((c.x + c.y) & 1) == uParity) {
        vec2 rhs = uA * (velocityAt(uVel0, c - DX) + velocityAt(uVel0, c + DX)
                       + velocityAt(uVel0, c - DY) + velocityAt(uVel0, c + DY) - 4.0 * velocityAt(uVel0, c));
        vec2 gs = (rhs + uA * (velocityAt(uDelta, c - DX) + velocityAt(uDelta, c + DX)
                             + velocityAt(uDelta, c - DY) + velocityAt(uDelta, c + DY))) * uCInv;
        d += uOmega * (gs - d);
    }
    outColor = vec4(d, 0.0, 0.0);
}`,
        },
        addVelocity: {
            textures: ['uVel0', 'uDelta'],
            source: `
uniform sampler2D uVel0, uDelta;
void main() {
    ivec2 c = cell();
    outColor = vec4(texelFetch(uVel0, c - 1, 0).rg + texelFetch(uDelta, c - 1, 0).rg, 0.0, 0.0);
}`,
        },
        divergence: {
            textures: ['uVel'],
            source: `
uniform sampler2D uVel;
uniform float uH;
void main() {
    ivec2 c = cell();
    float div = -0.5 * uH * (velocityAt(uVel, c + DX).x - velocityAt(uVel, c - DX).x
                           + velocityAt(uVel, c + DY).y - velocityAt(uVel, c - DY).y);
    outColor = vec4(div, 0.0, 0.0, 0.0);
}`,
        },
        // One half-sweep of c x - a (sum of the neighbours' x) = x0 for a scalar (the pressure, and the
        // heat diffusion), over-relaxed by uOmega. uOffset is subtracted from every value written: the
        // pressure's mean, taken off in the first pass of a solve.
        relax: {
            textures: ['uX', 'uX0', 'uStats'],
            source: `
uniform sampler2D uX, uX0, uStats;
uniform float uA, uCInv, uOmega;
uniform vec4 uOffsetMask;
uniform int uParity;
void main() {
    ivec2 c = cell();
    float x = texelFetch(uX, c - 1, 0).r;
    if (((c.x + c.y) & 1) == uParity) {
        float gs = (texelFetch(uX0, c - 1, 0).r + uA * (scalarAt(uX, c - DX) + scalarAt(uX, c + DX)
                                                     + scalarAt(uX, c - DY) + scalarAt(uX, c + DY))) * uCInv;
        x += uOmega * (gs - x);
    }
    outColor = vec4(x - dot(texelFetch(uStats, ivec2(0), 0), uOffsetMask), 0.0, 0.0, 0.0);
}`,
        },
        // Subtract the pressure gradient (the end of project())
        gradient: {
            textures: ['uVel', 'uP'],
            source: `
uniform sampler2D uVel, uP;
uniform float uHalfN;
void main() {
    ivec2 c = cell();
    vec2 w = texelFetch(uVel, c - 1, 0).rg;
    w -= uHalfN * vec2(scalarAt(uP, c + DX) - scalarAt(uP, c - DX), scalarAt(uP, c + DY) - scalarAt(uP, c - DY));
    outColor = vec4(w, 0.0, 0.0);
}`,
        },
        // Semi-Lagrangian advection (advect()): trace back along the velocity and interpolate there.
        // advectVelocity moves the velocity along itself (both components at once), advectScalar the
        // temperature.
        advectVelocity: {
            textures: ['uVel'],
            source: `
uniform sampler2D uVel;
uniform float uDt0;
void main() {
    ivec2 c = cell();
    vec2 pos = clamp(vec2(c) - uDt0 * texelFetch(uVel, c - 1, 0).rg, vec2(0.5), vec2(float(uN) + 0.5));
    ivec2 q = ivec2(pos);
    vec2 s1 = pos - vec2(q), s0 = 1.0 - s1;
    vec2 w = s0.x * (s0.y * velocityAt(uVel, q) + s1.y * velocityAt(uVel, q + DY))
           + s1.x * (s0.y * velocityAt(uVel, q + DX) + s1.y * velocityAt(uVel, q + DX + DY));
    outColor = vec4(w, 0.0, 0.0);
}`,
        },
        advectScalar: {
            textures: ['uVel', 'uField'],
            source: `
uniform sampler2D uVel, uField;
uniform float uDt0;
void main() {
    ivec2 c = cell();
    vec2 pos = clamp(vec2(c) - uDt0 * texelFetch(uVel, c - 1, 0).rg, vec2(0.5), vec2(float(uN) + 0.5));
    ivec2 q = ivec2(pos);
    vec2 s1 = pos - vec2(q), s0 = 1.0 - s1;
    float t = s0.x * (s0.y * scalarAt(uField, q) + s1.y * scalarAt(uField, q + DY))
            + s1.x * (s0.y * scalarAt(uField, q + DX) + s1.y * scalarAt(uField, q + DX + DY));
    outColor = vec4(t, 0.0, 0.0, 0.0);
}`,
        },
        // Heat from the brushes (applyHeatBrush: x, y = centre cell, z = heat per step at the centre),
        // then the 0-100 °C limits
        heatSource: {
            textures: ['uTemp'],
            source: `
uniform sampler2D uTemp;
uniform float uDt, uRSq, uTwiceRSq;
uniform int uBrushCount;
uniform vec3 uBrush[${MAX_BRUSHES}];
void main() {
    ivec2 c = cell();
    float source = 0.0;
    for (int k = 0; k < ${MAX_BRUSHES}; k++) {
        if (k >= uBrushCount) break;
        vec2 d = vec2(c) - uBrush[k].xy;
        float d2 = dot(d, d);
        if (d2 <= uRSq) source += uBrush[k].z * exp(-d2 / uTwiceRSq);
    }
    outColor = vec4(clamp(texelFetch(uTemp, c - 1, 0).r + uDt * source, 0.0, 1.0), 0.0, 0.0, 0.0);
}`,
        },
        // Spread the heat lost or gained by diffusion and advection evenly (uHeat holds it per cell),
        // apply the 0-100 °C limits, then cool the surface layer
        finishHeat: {
            textures: ['uTemp', 'uHeat'],
            source: `
uniform sampler2D uTemp, uHeat;
uniform int uCoolRows;
uniform float uCoolBase, uRefOverN, uNoise;
uniform uint uSeed;
float random(ivec2 c) {
    uint h = uint(c.x) * 0x9E3779B1u ^ uint(c.y) * 0x85EBCA77u ^ uSeed * 0xC2B2AE3Du;
    h ^= h >> 16; h *= 0x7FEB352Du; h ^= h >> 15; h *= 0x846CA68Bu; h ^= h >> 16;
    return float(h >> 8) * (1.0 / 16777216.0);
}
void main() {
    ivec2 c = cell();
    float t = clamp(texelFetch(uTemp, c - 1, 0).r + texelFetch(uHeat, ivec2(0), 0).r, 0.0, 1.0);
    int k = uN - c.y; // depth below the surface in cells
    if (k < uCoolRows) {
        float gradient = 1.0 / (1.0 + float(k) * uRefOverN);
        float noise = 1.0 + (random(c) - 0.5) * uNoise;
        t = max(0.0, t * (1.0 - uCoolBase * gradient * noise));
    }
    outColor = vec4(t, 0.0, 0.0, 0.0);
}`,
        },
        // Adds up blocks of the input. The first pass reads the fields (uMode 0: the heat lost in this
        // step, uA - uB; uMode 1: temperature and the two pressures), later passes the previous pass's
        // sums (uMode 2). uScale turns the last pass's sums into means.
        reduce: {
            textures: ['uA', 'uB', 'uC'],
            source: `
uniform sampler2D uA, uB, uC;
uniform int uMode;
uniform ivec2 uSize;
uniform float uScale;
void main() {
    ivec2 origin = ivec2(gl_FragCoord.xy) * ${REDUCE_BLOCK};
    ivec2 end = min(origin + ${REDUCE_BLOCK}, uSize);
    vec4 sum = vec4(0.0);
    for (int y = origin.y; y < end.y; y++) {
        for (int x = origin.x; x < end.x; x++) {
            ivec2 q = ivec2(x, y);
            if (uMode == 0) sum.r += texelFetch(uA, q, 0).r - texelFetch(uB, q, 0).r;
            else if (uMode == 1) sum.rgb += vec3(texelFetch(uA, q, 0).r, texelFetch(uB, q, 0).r, texelFetch(uC, q, 0).r);
            else sum += texelFetch(uA, q, 0);
        }
    }
    outColor = sum * uScale;
}`,
        },
        // Temperature to colour through the same 256-level table as the CPU renderer
        render: {
            textures: ['uTemp', 'uColors'],
            source: `
uniform sampler2D uTemp, uColors;
void main() {
    float t = clamp(texelFetch(uTemp, ivec2(gl_FragCoord.xy), 0).r, 0.0, 1.0);
    outColor = vec4(texelFetch(uColors, ivec2(int(t * 255.0 + 0.5), 0), 0).rgb, 1.0);
}`,
        },
    };

    // options: n (grid size), dt, diffusion, buoyancy, ambientTemp, referenceN, colorLUT (256 RGB triples)
    function createConvectionGpuSolver(options) {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl2', {
            alpha: false, depth: false, stencil: false, antialias: false,
            premultipliedAlpha: false, preserveDrawingBuffer: false,
        });
        if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;

        // The shaders compile in the background where the browser can do that (ready() below), so
        // building them doesn't hold up the page
        const parallelCompile = gl.getExtension('KHR_parallel_shader_compile');
        const programs = {};
        for (const name in PROGRAMS) programs[name] = startProgram(gl, PROGRAMS[name]);
        let built = false;
        gl.bindVertexArray(gl.createVertexArray());

        const colorTable = new Uint8Array(256 * 4);
        for (let k = 0; k < 256; k++) {
            colorTable.set(options.colorLUT.subarray(k * 3, k * 3 + 3), k * 4);
            colorTable[k * 4 + 3] = 255;
        }
        const colors = createTexture(gl, 256, 1, gl.RGBA8, colorTable);

        const statsValues = new Float32Array(4);

        let n = 0;
        let t = null; // render targets, see allocate()
        let stepCount = 0;
        let average = options.ambientTemp; // last average temperature read back from the GPU
        let statsRead = null; // read-back in progress: { buffer, fence }
        let lastStatsRead = 0;
        const frameFences = [];
        let lost = false;
        let current = null; // program in use

        canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });

        function allocate(newN) {
            if (t) for (const key in t) [].concat(t[key]).forEach((target) => deleteTarget(gl, target));
            n = newN;
            canvas.width = n;
            canvas.height = n;
            const field = (format) => createTarget(gl, n, n, format);
            t = {
                vel: [field(gl.RG32F), field(gl.RG32F), field(gl.RG32F)],
                delta: [field(gl.RG32F), field(gl.RG32F)], // viscous velocity change, kept to warm-start the next step
                temp: field(gl.R32F),
                tempWork: [field(gl.R32F), field(gl.R32F), field(gl.R32F)],
                pressure1: [field(gl.R32F), field(gl.R32F)],
                pressure2: [field(gl.R32F), field(gl.R32F)],
                divergence: field(gl.R32F),
                // Means: x = temperature, y and z = the two pressures. stats[s % 2] is written at the end of
                // step s, so during step s it still holds the temperature from the start of step s - 1,
                // which buoyancy uses, as on the CPU.
                stats: [createTarget(gl, 1, 1, gl.RGBA32F), createTarget(gl, 1, 1, gl.RGBA32F)],
                heat: createTarget(gl, 1, 1, gl.RGBA32F),
                sums: [],
            };
            for (let size = Math.ceil(n / REDUCE_BLOCK); size > 1; size = Math.ceil(size / REDUCE_BLOCK)) {
                t.sums.push(createTarget(gl, size, size, gl.RGBA32F));
            }
            if (built) setGridSize();
            reset();
        }

        function setGridSize() {
            for (const name in programs) {
                gl.useProgram(programs[name].program);
                gl.uniform1i(programs[name].uniforms.uN, n);
            }
            current = null;
        }

        // Whether the shaders have been built, so the solver can run. A shader that fails to build makes
        // the solver unusable, like a lost context.
        function ready() {
            if (built) return true;
            if (lost) return false;
            const done = (name) => gl.getProgramParameter(programs[name].program, parallelCompile.COMPLETION_STATUS_KHR);
            if (parallelCompile && !Object.keys(programs).every(done)) return false;
            for (const name in programs) {
                if (!finishProgram(gl, programs[name], PROGRAMS[name])) {
                    lost = true;
                    return false;
                }
            }
            built = true;
            setGridSize();
            return true;
        }

        function clearTarget(target, value) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
            gl.clearColor(value[0], value[1], value[2], value[3]);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }

        function reset() {
            const ambient = options.ambientTemp;
            [...t.vel, ...t.delta, ...t.pressure1, ...t.pressure2, t.divergence, t.heat].forEach((target) => clearTarget(target, [0, 0, 0, 0]));
            clearTarget(t.temp, [ambient, 0, 0, 0]);
            t.stats.forEach((target) => clearTarget(target, [ambient, 0, 0, 0]));
            stepCount = 0;
            average = ambient;
            dropStatsRead(); // it would show the average from before the reset
        }

        // Runs a program over a target (null = the canvas), with textures bound in the program's order
        function run(name, target, textures, setUniforms) {
            const prog = programs[name];
            if (current !== prog) { gl.useProgram(prog.program); current = prog; }
            gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
            if (target) gl.viewport(0, 0, target.w, target.h);
            else gl.viewport(0, 0, n, n);
            for (let k = 0; k < textures.length; k++) {
                gl.activeTexture(gl.TEXTURE0 + k);
                gl.bindTexture(gl.TEXTURE_2D, textures[k].tex);
            }
            if (setUniforms) setUniforms(prog.uniforms);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }

        // Red-black sweeps of a scalar solve starting from `first`, ping-ponging between pair[0] and
        // pair[1] (a solve starting in pair[0] ends there). Returns the target holding the result.
        function relax(first, pair, rhs, a, c, sweeps, omega, offsetMask) {
            let src = first;
            for (let pass = 0; pass < 2 * sweeps; pass++) {
                const dst = src === pair[0] ? pair[1] : pair[0];
                run('relax', dst, [src, rhs, t.stats[(stepCount + 1) & 1]], (u) => {
                    gl.uniform1f(u.uA, a);
                    gl.uniform1f(u.uCInv, 1 / c);
                    gl.uniform1f(u.uOmega, omega);
                    gl.uniform1i(u.uParity, pass & 1);
                    if (pass === 0 && offsetMask) gl.uniform4fv(u.uOffsetMask, offsetMask);
                    else gl.uniform4f(u.uOffsetMask, 0, 0, 0, 0);
                });
                src = dst;
            }
            return src;
        }

        // project(): makes vel divergence-free; returns the target holding the result
        function project(vel, out, pressure, meanMask) {
            const h = 1 / n;
            run('divergence', t.divergence, [vel], (u) => gl.uniform1f(u.uH, h));
            const solve = solver.tuning.pressure(n);
            const p = relax(pressure[0], pressure, t.divergence, 1, 4, solve.sweeps, solve.omega, meanMask);
            run('gradient', out, [vel, p], (u) => gl.uniform1f(u.uHalfN, 0.5 * n));
            return out;
        }

        // Sums of the input fields over the grid, divided by n^2, into dest (1 x 1)
        function reduce(mode, inputs, dest) {
            let size = n;
            let src = inputs;
            for (let k = 0; k <= t.sums.length; k++) {
                const last = k === t.sums.length;
                const out = last ? dest : t.sums[k];
                const pad = [src[0], src[1] || src[0], src[2] || src[0]];
                run('reduce', out, pad, (u) => {
                    gl.uniform1i(u.uMode, k === 0 ? mode : 2);
                    gl.uniform2i(u.uSize, size, size);
                    gl.uniform1f(u.uScale, last ? 1 / (n * n) : 1);
                });
                size = out.w;
                src = [out];
            }
        }

        // One time step. params: visc, viscSweeps, heatSweeps (Gauss-Seidel sweeps of the two diffusion
        // solves), coolBase (cooling rate at the surface), coolRows, brushes ([ci, cj, amount] each),
        // brushRSq (brush radius in cells, squared)
        function step(params) {
            const dt = options.dt;
            const statsPrev = t.stats[stepCount & 1];
            const [velA, velB, velC] = t.vel;

            // Buoyancy, then the viscous change of the velocity (warm-started from the last step's)
            run('buoyancy', velB, [velA, t.temp, statsPrev], (u) => gl.uniform1f(u.uBuoyStep, dt * options.buoyancy));
            const a = dt * params.visc * n * n;
            const viscous = solver.tuning.viscous(n, a, params.viscSweeps);
            for (let pass = 0; pass < 2 * viscous.sweeps; pass++) {
                run('viscosity', t.delta[(pass + 1) & 1], [t.delta[pass & 1], velB], (u) => {
                    gl.uniform1f(u.uA, a);
                    gl.uniform1f(u.uCInv, 1 / (1 + 4 * a));
                    gl.uniform1f(u.uOmega, viscous.omega);
                    gl.uniform1i(u.uParity, pass & 1);
                });
            }
            run('addVelocity', velA, [velB, t.delta[0]]);

            // Project, advect the velocity along itself, project again
            project(velA, velC, t.pressure1, [0, 1, 0, 0]);
            run('advectVelocity', velA, [velC], (u) => gl.uniform1f(u.uDt0, dt * n));
            project(velA, velB, t.pressure2, [0, 0, 1, 0]);
            const vel = velB;

            // Heat: brushes, diffusion, advection, then the correction that keeps advection from
            // creating or destroying heat, and the surface cooling
            const [heated, workA, workB] = t.tempWork;
            run('heatSource', heated, [t.temp], (u) => {
                gl.uniform1f(u.uDt, dt);
                gl.uniform1f(u.uRSq, params.brushRSq);
                gl.uniform1f(u.uTwiceRSq, 2 * params.brushRSq);
                const count = Math.min(MAX_BRUSHES, params.brushes.length);
                gl.uniform1i(u.uBrushCount, count);
                if (count) gl.uniform3fv(u.uBrush, params.brushes.slice(0, count).flat());
            });
            const ad = dt * options.diffusion * n * n;
            const diffused = relax(heated, [workA, workB], heated, ad, 1 + 4 * ad, params.heatSweeps, 1, null);
            const advected = diffused === workA ? workB : workA;
            run('advectScalar', advected, [vel, diffused], (u) => gl.uniform1f(u.uDt0, dt * n));
            reduce(0, [heated, advected], t.heat);
            run('finishHeat', t.temp, [advected, t.heat], (u) => {
                gl.uniform1i(u.uCoolRows, params.coolRows);
                gl.uniform1f(u.uCoolBase, params.coolBase);
                gl.uniform1f(u.uRefOverN, options.referenceN / n);
                gl.uniform1f(u.uNoise, solver.coolNoise);
                gl.uniform1ui(u.uSeed, stepCount);
            });

            // Means for the next steps: temperature (buoyancy, display) and the pressures (drift)
            reduce(1, [t.temp, t.pressure1[0], t.pressure2[0]], t.stats[stepCount & 1]);

            // The new velocity becomes vel[0]
            t.vel = [vel, velA, velC];
            stepCount++;
        }

        function render() {
            run('render', null, [t.temp, colors]);
        }

        // Average temperature, read back about ten times a second without waiting for the GPU, so it lags
        // the simulation by a frame or two. Each read gets a new buffer: Chrome warns when a buffer it
        // has read back from is written again.
        function averageTemperature() {
            if (statsRead && gl.getSyncParameter(statsRead.fence, gl.SYNC_STATUS) === gl.SIGNALED) {
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, statsRead.buffer);
                gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, statsValues);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                dropStatsRead();
                average = statsValues[0];
            }
            const now = performance.now();
            if (!statsRead && stepCount > 0 && now - lastStatsRead >= 100) {
                lastStatsRead = now;
                const buffer = gl.createBuffer();
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
                gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
                gl.bindFramebuffer(gl.FRAMEBUFFER, t.stats[(stepCount - 1) & 1].fbo);
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
                statsRead = { buffer, fence: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) };
            }
            return average;
        }
        function dropStatsRead() {
            if (!statsRead) return;
            gl.deleteBuffer(statsRead.buffer);
            gl.deleteSync(statsRead.fence);
            statsRead = null;
        }

        // endFrame() marks the end of a frame's work. caughtUp() tells whether the GPU has finished the
        // work of the frame before last: browsers (Chrome at least) report a fence as passed only two
        // frames after it was placed, however quickly the work was done.
        function endFrame() {
            frameFences.push(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0));
        }
        function caughtUp() {
            let done = true;
            while (frameFences.length >= 2) {
                const fence = frameFences.shift();
                done = gl.getSyncParameter(fence, gl.SYNC_STATUS) === gl.SIGNALED;
                gl.deleteSync(fence);
            }
            return done;
        }

        // Reads a field back (blocking; for tests): RGBA per cell, row by row from j = 1 upwards
        function readField(name) {
            const target = name === 'vel' ? t.vel[0] : name === 'pressure1' ? t.pressure1[0]
                : name === 'pressure2' ? t.pressure2[0] : name === 'stats' ? t.stats[(stepCount - 1) & 1] : t.temp;
            const out = new Float32Array(target.w * target.h * 4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
            gl.readPixels(0, 0, target.w, target.h, gl.RGBA, gl.FLOAT, out);
            return out;
        }

        const solver = {
            canvas,
            step,
            render,
            reset,
            resize: allocate,
            averageTemperature,
            endFrame,
            caughtUp,
            readField,
            ready,
            get lost() { return lost || gl.isContextLost(); },
            coolNoise: 0.2, // the cooling varies randomly by +-10% per cell and step, as on the CPU
            tuning: Object.assign({}, TUNING),
        };
        allocate(options.n);
        return solver;
    }

    // Compiles and links a program without waiting for the result (asking for it would)
    function startProgram(gl, spec) {
        const shader = (type, source) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, source);
            gl.compileShader(s);
            return s;
        };
        const program = gl.createProgram();
        const fs = shader(gl.FRAGMENT_SHADER, COMMON + spec.source);
        gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX_SHADER));
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        return { program, fs, uniforms: {} };
    }

    // Once linked: looks up the uniforms and points the samplers at their texture units
    function finishProgram(gl, prog, spec) {
        if (!gl.getProgramParameter(prog.program, gl.LINK_STATUS)) {
            console.warn('Convection GPU solver: shader failed to build', gl.getShaderInfoLog(prog.fs) || gl.getProgramInfoLog(prog.program));
            return false;
        }
        const count = gl.getProgramParameter(prog.program, gl.ACTIVE_UNIFORMS);
        for (let k = 0; k < count; k++) {
            const name = gl.getActiveUniform(prog.program, k).name.replace(/\[0\]$/, '');
            prog.uniforms[name] = gl.getUniformLocation(prog.program, name);
        }
        gl.useProgram(prog.program);
        spec.textures.forEach((name, unit) => { if (prog.uniforms[name]) gl.uniform1i(prog.uniforms[name], unit); });
        return true;
    }

    function createTexture(gl, w, h, format, data) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (data) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return { tex, w, h };
    }

    function createTarget(gl, w, h, format) {
        const target = createTexture(gl, w, h, format, null);
        target.fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Float render target unsupported');
        return target;
    }

    function deleteTarget(gl, target) {
        gl.deleteFramebuffer(target.fbo);
        gl.deleteTexture(target.tex);
    }

    window.createConvectionGpuSolver = createConvectionGpuSolver;
})();
