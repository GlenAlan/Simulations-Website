// Bakes the expensive looks of nebulae and supernova remnants into textures, a little each frame, so neither
// loading nor zooming ever stalls. There are two kinds of bake:
//
//   the atlas   one small image of every object, for the sky scale; nearest to the view first
//   the hero    one large image of whatever fills the screen, of just the part in view, so that detail keeps
//               coming as you zoom. Two targets, so the old image stays up until the new one has finished.
//
// Both layers share one baker (getBaker), and so share one atlas and one hero.

import * as THREE from 'three';
import { Rng } from '../../core/rng.js';
import { bus } from '../../core/state.js';
import { BAKE_VERT, CLOUD_FRAG, PLANETARY_FRAG, REMNANT_FRAG } from './nebula_shaders.js';

const CELL_PX = { low: 128, medium: 256, high: 256 };
const ATLAS_STEPS = { low: 18, medium: 36, high: 44 };
const ATLAS_OCTAVES = { low: 2, medium: 3, high: 3 };
const HERO_MAX_PX = { low: 512, medium: 1280, high: 1920 };
const HERO_STEPS = { low: 28, medium: 56, high: 84 };

const NOISE_SIZE = 64;
const HERO_FADE_S = 0.35;
const FETCHES_PER_STEP = { cloud: 9, planetary: 7, remnant: 8 }; // Roughly, so strips can be sized by cost

// Tiling noise: three fractal channels and one cellular. Built on the CPU from a fixed seed, so it is the same
// on every load and every GPU, and sampled as a 3D texture because one fetch is far cheaper than computing noise
// in the shader. Runs in slices, a few milliseconds a frame.
function createNoiseBuilder() {
    const size = NOISE_SIZE;
    const data = new Uint8Array(size * size * size * 4);
    const rng = new Rng('nebula-noise-v1');
    const PERIODS = [4, 8, 16];
    const AMPS = [0.56, 0.3, 0.16];
    const channels = [];
    for (let c = 0; c < 3; c++) {
        channels.push(PERIODS.map((p) => {
            const grads = new Float32Array(p * p * p * 3);
            for (let i = 0; i < p * p * p; i++) {
                const a = rng.range(0, Math.PI * 2);
                const zz = rng.range(-1, 1);
                const s = Math.sqrt(1 - zz * zz);
                grads[i * 3] = s * Math.cos(a);
                grads[i * 3 + 1] = s * Math.sin(a);
                grads[i * 3 + 2] = zz;
            }
            return { p, grads };
        }));
    }
    const makeCells = (p) => {
        const pts = new Float32Array(p * p * p * 3);
        for (let i = 0; i < pts.length; i++) pts[i] = rng.next();
        return { p, pts };
    };
    const cells = [makeCells(5), makeCells(11)];
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

    function perlin(octave, x, y, z) {
        const { p, grads } = octave;
        const fx = (x * p) / size;
        const fy = (y * p) / size;
        const fz = (z * p) / size;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const iz = Math.floor(fz);
        const tx = fx - ix;
        const ty = fy - iy;
        const tz = fz - iz;
        const u = fade(tx);
        const v = fade(ty);
        const w = fade(tz);
        let result = 0;
        for (let k = 0; k < 2; k++) {
            const wz = k ? w : 1 - w;
            for (let j = 0; j < 2; j++) {
                const wy = j ? v : 1 - v;
                for (let i = 0; i < 2; i++) {
                    const wx = i ? u : 1 - u;
                    const g = (((ix + i) % p) + (((iy + j) % p) + ((iz + k) % p) * p) * p) * 3;
                    result += wx * wy * wz * (grads[g] * (tx - i) + grads[g + 1] * (ty - j) + grads[g + 2] * (tz - k));
                }
            }
        }
        return result;
    }

    function cellular(cell, x, y, z) {
        const { p, pts } = cell;
        const fx = (x * p) / size;
        const fy = (y * p) / size;
        const fz = (z * p) / size;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const iz = Math.floor(fz);
        let best = 9;
        for (let k = -1; k <= 1; k++) {
            for (let j = -1; j <= 1; j++) {
                for (let i = -1; i <= 1; i++) {
                    const cx = ix + i;
                    const cy = iy + j;
                    const cz = iz + k;
                    const g = (((cx + p) % p) + (((cy + p) % p) + ((cz + p) % p) * p) * p) * 3;
                    const dx = cx + pts[g] - fx;
                    const dy = cy + pts[g + 1] - fy;
                    const dz = cz + pts[g + 2] - fz;
                    const d = dx * dx + dy * dy + dz * dz;
                    if (d < best) best = d;
                }
            }
        }
        return Math.sqrt(best);
    }

    let z = 0;
    return {
        data,
        size,
        get done() { return z >= size; },
        run(budgetMs) {
            const t0 = performance.now();
            do {
                let o = z * size * size * 4;
                for (let y = 0; y < size; y++) {
                    for (let x = 0; x < size; x++) {
                        for (let c = 0; c < 3; c++) {
                            let s = 0;
                            for (let i = 0; i < 3; i++) s += AMPS[i] * perlin(channels[c][i], x, y, z);
                            data[o++] = Math.max(0, Math.min(255, (0.5 + s * 1.5) * 255));
                        }
                        const a = 1 - cellular(cells[0], x, y, z);
                        const b = 1 - cellular(cells[1], x, y, z);
                        data[o++] = Math.max(0, Math.min(255, (a * 0.68 + b * 0.32) * 255));
                    }
                }
                z++;
            } while (z < size && performance.now() - t0 < budgetMs);
        }
    };
}

function makeProgram(fragmentShader, extraUniforms) {
    return new THREE.ShaderMaterial({
        vertexShader: BAKE_VERT,
        fragmentShader,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
        toneMapped: false,
        uniforms: {
            tNoise: { value: null },
            uRect: { value: new THREE.Vector4(0, 0, 1, 1) },
            uSteps: { value: 32 },
            uOctaves: { value: 2 },
            uOff: { value: new THREE.Vector3() },
            uRot: { value: new THREE.Matrix3() },
            ...extraUniforms
        }
    });
}

function createBaker(engine, app) {
    const { renderer } = engine;
    const noise = createNoiseBuilder();
    let noiseTexture = null;
    let programsReady = false;

    const v4s = (n) => Array.from({ length: n }, () => new THREE.Vector4());
    const programs = {
        cloud: makeProgram(CLOUD_FRAG, {
            uBlob: { value: v4s(6) }, uStar: { value: v4s(4) }, uLane: { value: v4s(2) },
            uA: { value: new THREE.Vector4() }, uB: { value: new THREE.Vector4() }, uC: { value: new THREE.Vector4() }
        }),
        planetary: makeProgram(PLANETARY_FRAG, {
            uP: { value: new THREE.Vector4() }, uC: { value: new THREE.Vector4() }
        }),
        remnant: makeProgram(REMNANT_FRAG, {
            uS: { value: new THREE.Vector4() }, uAsym: { value: new THREE.Vector4() },
            uAxis: { value: new THREE.Vector3() }, uC: { value: new THREE.Vector4() }
        })
    };

    const bakeScene = new THREE.Scene();
    const bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), programs.cloud);
    quad.frustumCulled = false;
    bakeScene.add(quad);
    const emptyScene = new THREE.Scene();

    // Atlas: one square cell per object, for both layers. Its size in cells is known from the universe
    const jobCount = app.universe.bodies.filter((b) => b.kind === 'nebula' || b.kind === 'supernova').length;
    const grid = Math.max(1, Math.ceil(Math.sqrt(jobCount)));
    let cellPx = CELL_PX[app.qualityLevel] || 256;
    const atlasUniform = { value: null };
    let atlas = null;

    function createAtlas() {
        if (atlas) atlas.dispose();
        atlas = new THREE.WebGLRenderTarget(grid * cellPx, grid * cellPx, {
            type: THREE.UnsignedByteType,
            depthBuffer: false,
            minFilter: THREE.LinearMipmapLinearFilter,
            magFilter: THREE.LinearFilter,
            generateMipmaps: true
        });
        atlas.texture.colorSpace = THREE.NoColorSpace;
        // Three would regenerate the whole mip chain after every strip: left off here, and done once per finished cell
        atlas.texture.generateMipmaps = true;
        renderer.setRenderTarget(atlas);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.setClearColor(0x000000, 1);
        renderer.setRenderTarget(null);
        atlas.texture.generateMipmaps = false;
        atlasUniform.value = atlas.texture;
        heroUniforms.uAtlasPx.value = atlas.width;
    }

    const jobs = [];
    let nextId = 1;

    // spec = { program: 'cloud'|'planetary'|'remnant', dir: [x, y, z], set(uniforms) }; returns the job, whose rect
    // [u, v, du, dv] is its cell in the atlas and whose .ready becomes true when the sprite can use it.
    function addJob(spec) {
        const index = jobs.length;
        const job = {
            ...spec,
            id: nextId++,
            index,
            rect: [(index % grid) / grid, Math.floor(index / grid) / grid, 1 / grid, 1 / grid],
            ready: false,
            row: 0
        };
        jobs.push(job);
        return job;
    }

    // Hero images. Heroes are allocated the first time one is wanted, so an unzoomed sky costs nothing for them
    const heroUniforms = {
        uHeroA: { value: null }, uHeroARect: { value: new THREE.Vector4(0, 0, 1, 1) }, uHeroAK: { value: 0 }, uHeroAId: { value: -1 },
        uHeroB: { value: null }, uHeroBRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uHeroBK: { value: 0 }, uHeroBId: { value: -1 },
        uAtlasPx: { value: 1 }
    };
    let heroPx = 0;
    let heroTargets = null;
    const newest = { target: null, job: null, cx: 0, cy: 0, h: 1, k: 0 };
    const older = { target: null, job: null, cx: 0, cy: 0, h: 1, k: 0 };
    let heroWork = null; // { job, cx, cy, h, row, target }
    let stableFor = 0;
    let lastFov = 0;
    const lastDir = new THREE.Vector3();

    function ensureHeroTargets() {
        const res = Math.min(HERO_MAX_PX[app.qualityLevel] || 1280, Math.ceil(Math.max(renderer.domElement.width, renderer.domElement.height)));
        const px = Math.max(256, res);
        if (heroTargets && px <= heroPx) return;
        if (heroTargets) heroTargets.forEach((t) => t.dispose());
        heroPx = px;
        heroTargets = [0, 1].map(() => {
            const t = new THREE.WebGLRenderTarget(px, px, {
                type: THREE.UnsignedByteType,
                depthBuffer: false,
                minFilter: THREE.LinearFilter,
                magFilter: THREE.LinearFilter,
                generateMipmaps: false
            });
            t.texture.colorSpace = THREE.NoColorSpace;
            return t;
        });
        newest.target = heroTargets[0];
        newest.job = null;
        newest.k = 0;
        older.target = heroTargets[1];
        older.job = null;
        older.k = 0;
        heroWork = null;
    }

    function syncHeroUniforms() {
        heroUniforms.uHeroA.value = newest.job ? newest.target.texture : null;
        heroUniforms.uHeroARect.value.set(newest.cx, newest.cy, newest.h, newest.h);
        heroUniforms.uHeroAK.value = newest.job ? newest.k : 0;
        heroUniforms.uHeroAId.value = newest.job ? newest.job.id : -1;
        heroUniforms.uHeroB.value = older.job ? older.target.texture : null;
        heroUniforms.uHeroBRect.value.set(older.cx, older.cy, older.h, older.h);
        heroUniforms.uHeroBK.value = older.job ? older.k : 0;
        heroUniforms.uHeroBId.value = older.job ? older.job.id : -1;
    }

    // The sprite that most fills the screen this frame, written by considerSprite and read next frame
    const cand = { job: null, score: 0, vx: 0, vy: 0, hv: 0, hh: 0, across: 0 };
    const prev = { job: null, score: 0, vx: 0, vy: 0, hv: 0, hh: 0, across: 0 };
    const forward = new THREE.Vector3();
    let frameTanFov = 1;
    let frameAspect = 1;
    let framePxPerRad = 1;

    let lastFrame = null;
    let budget = 4e6;   // Noise fetches per frame; tuned by frame time
    let flushing = false;

    // A layer calls this once per sprite per frame. (cx..nz) is the sprite's tangent frame, tanHalf its half-size
    function considerSprite(job, cx, cy, cz, rx, ry, rz, nx, ny, nz, tanHalf) {
        const d = forward.x * cx + forward.y * cy + forward.z * cz;
        if (d < 0.5) return;
        const hv = frameTanFov / tanHalf;
        const hh = hv * frameAspect;
        const vx = (forward.x * rx + forward.y * ry + forward.z * rz) / d / tanHalf;
        const vy = (forward.x * nx + forward.y * ny + forward.z * nz) / d / tanHalf;
        if (Math.abs(vx) > 1 + hh || Math.abs(vy) > 1 + hv) return;
        const across = 2 * framePxPerRad * tanHalf;
        const startPx = Math.max(cellPx * 1.5, 340);
        const heldPx = newest.job === job ? startPx * 0.75 : startPx;
        if (across < heldPx) return;
        const ox = Math.min(1, vx + hh) - Math.max(-1, vx - hh);
        const oy = Math.min(1, vy + hv) - Math.max(-1, vy - hv);
        const score = ox * oy * across * across;
        if (score <= cand.score) return;
        cand.job = job;
        cand.score = score;
        cand.vx = vx;
        cand.vy = vy;
        cand.hv = hv;
        cand.hh = hh;
        cand.across = across;
    }

    // Which part of the sprite the hero should cover for this view, as a square in sprite units. Only the part of
    // the view that lies on the sprite counts. It is never so small that the image would be minified more than
    // twofold, as heroes have no mipmaps.
    const want = { cx: 0, cy: 0, h: 1 };
    function heroWindow(c) {
        const x0 = Math.max(-1, c.vx - c.hh);
        const x1 = Math.min(1, c.vx + c.hh);
        const y0 = Math.max(-1, c.vy - c.hv);
        const y1 = Math.min(1, c.vy + c.hv);
        let h = Math.max(Math.max(x1 - x0, y1 - y0) * 0.5 * 1.14, heroPx / (2 * c.across));
        if (h > 0.72) {
            want.cx = 0;
            want.cy = 0;
            want.h = 1;
            return;
        }
        h = Math.max(0.012, h);
        want.h = h;
        want.cx = Math.max(-1 + h, Math.min(1 - h, (x0 + x1) * 0.5));
        want.cy = Math.max(-1 + h, Math.min(1 - h, (y0 + y1) * 0.5));
    }

    function windowCoversView(slot, c) {
        if (slot.h >= 1) return true;
        const m = slot.h * 1.02;
        return Math.max(-1, c.vx - c.hh) >= slot.cx - m && Math.min(1, c.vx + c.hh) <= slot.cx + m
            && Math.max(-1, c.vy - c.hv) >= slot.cy - m && Math.min(1, c.vy + c.hv) <= slot.cy + m;
    }

    // Would baking the wanted window give much the same image as this slot already holds?
    function sameWindow(slot) {
        return Math.abs(slot.h - want.h) < want.h * 0.1 && Math.abs(slot.cx - want.cx) < want.h * 0.1 && Math.abs(slot.cy - want.cy) < want.h * 0.1;
    }

    function heroSatisfied(slot, c) {
        if (slot.job !== c.job) return false;
        if (sameWindow(slot)) return true; // Without this, a view that can't be improved would rebake for ever
        const texelsPerPx = heroPx / (slot.h * c.across);
        const sharpEnough = texelsPerPx >= Math.min(0.7, (heroPx / (want.h * c.across)) * 0.72);
        const notTooFine = slot.h >= 1 || texelsPerPx <= 2.4;
        return sharpEnough && notTooFine && windowCoversView(slot, c);
    }

    function updateHero(frame) {
        // Fades, whatever else is happening
        const fadeStep = frame.reduceMotion ? 1 : frame.dt / HERO_FADE_S;
        if (newest.job && newest.k < 1) newest.k = Math.min(1, newest.k + fadeStep);
        if (older.job && newest.k >= 1) {
            older.job = null;
            older.k = 0;
        }

        const moved = Math.abs(frame.fov - lastFov) / frame.fov + forward.distanceTo(lastDir) * (57.3 / frame.fov);
        lastFov = frame.fov;
        lastDir.copy(forward);
        stableFor = moved > 0.004 ? 0 : stableFor + Math.max(frame.dt, 0.001);

        const c = prev;
        if (!c.job) {
            // Nothing is big enough on screen: let any hero go
            heroWork = null;
            if (newest.job) {
                newest.k -= fadeStep;
                if (newest.k <= 0) {
                    newest.job = null;
                    newest.k = 0;
                }
            }
            if (older.job && !newest.job) {
                older.job = null;
                older.k = 0;
            }
            syncHeroUniforms();
            return;
        }
        ensureHeroTargets();
        heroWindow(c);
        const happy = newest.job && newest.k > 0 && heroSatisfied(newest, c);
        if (happy) {
            if (heroWork) heroWork = null;
        } else if (stableFor > 0.12 || flushing) {
            const sameWork = heroWork && heroWork.job === c.job && Math.abs(heroWork.h - want.h) < want.h * 0.3
                && Math.abs(heroWork.cx - want.cx) < want.h * 0.15 && Math.abs(heroWork.cy - want.cy) < want.h * 0.15;
            if (!sameWork && c.job.ready) {
                // The older slot is about to be written to, so it must stop showing
                older.job = null;
                older.k = 0;
                const steps = HERO_STEPS[app.qualityLevel] || 56;
                const zoomOctaves = Math.round(Math.log2(1 / want.h) * 0.6);
                heroWork = {
                    job: c.job, cx: want.cx, cy: want.cy, h: want.h, row: 0, target: older.target,
                    steps, octaves: Math.min(6, 3 + zoomOctaves)
                };
            }
        }
        syncHeroUniforms();
    }

    function renderStrip(program, job, target, x, y, res, row, rows, cx, cy, h, steps, octaves) {
        const material = programs[program];
        const u = material.uniforms;
        u.tNoise.value = noiseTexture;
        u.uRect.value.set(cx, cy, h, h);
        u.uSteps.value = steps;
        u.uOctaves.value = octaves;
        job.set(u);
        quad.material = material;
        target.viewport.set(x, y, res, res);
        target.scissor.set(x, y + row, res, rows);
        target.scissorTest = true;
        renderer.setRenderTarget(target);
        renderer.render(bakeScene, bakeCamera);
    }

    function finishCell(job) {
        job.ready = true;
        // An empty render with mipmaps switched on: three regenerates them once at its end
        atlas.texture.generateMipmaps = true;
        atlas.scissorTest = false;
        renderer.setRenderTarget(atlas);
        renderer.render(emptyScene, bakeCamera);
        atlas.texture.generateMipmaps = false;
    }

    function nextAtlasJob() {
        const hero = prev.job;
        if (hero && !hero.ready) return hero;
        let best = null;
        let bestD = -2;
        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i];
            if (job.ready) continue;
            const d = forward.x * job.dir[0] + forward.y * job.dir[1] + forward.z * job.dir[2];
            if (d > bestD) {
                bestD = d;
                best = job;
            }
        }
        return best;
    }

    // Does one frame's work and returns true while any is left
    function doWork(frame) {
        let left = budget;
        const q = app.qualityLevel;
        const wasAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        let any = false;
        while (left > 0) {
            // The image of what's filling the screen comes first; then whatever hero is due; then the rest of the sky
            let job = prev.job && !prev.job.ready ? prev.job : null;
            if (!job && heroWork) {
                const w = heroWork;
                const cost = heroPx * w.steps * (FETCHES_PER_STEP[w.job.program] + w.octaves - 2);
                const rows = Math.max(2, Math.min(heroPx - w.row, Math.floor(left / cost)));
                renderStrip(w.job.program, w.job, w.target, 0, 0, heroPx, w.row, rows, w.cx, w.cy, w.h, w.steps, w.octaves);
                w.row += rows;
                left -= rows * cost;
                any = true;
                if (w.row >= heroPx) {
                    // Swap: the slot just baked becomes the newest; the one it replaces fades out underneath
                    const t = newest.target;
                    const oldJob = newest.job;
                    older.job = oldJob;
                    older.cx = newest.cx;
                    older.cy = newest.cy;
                    older.h = newest.h;
                    older.k = 1;
                    older.target = t;
                    newest.target = w.target;
                    newest.job = w.job;
                    newest.cx = w.cx;
                    newest.cy = w.cy;
                    newest.h = w.h;
                    newest.k = flushing ? 1 : 0;
                    heroWork = null;
                    syncHeroUniforms();
                }
                continue;
            }
            if (!job) job = nextAtlasJob();
            if (!job) break;
            const steps = ATLAS_STEPS[q] || 36;
            const octaves = ATLAS_OCTAVES[q] || 2;
            const cost = cellPx * steps * FETCHES_PER_STEP[job.program];
            const rows = Math.max(4, Math.min(cellPx - job.row, Math.floor(left / cost)));
            const x = (job.index % grid) * cellPx;
            const y = Math.floor(job.index / grid) * cellPx;
            renderStrip(job.program, job, atlas, x, y, cellPx, job.row, rows, 0, 0, 1, steps, octaves);
            job.row += rows;
            left -= rows * cost;
            any = true;
            if (job.row >= cellPx) finishCell(job);
        }
        renderer.autoClear = wasAutoClear;
        if (any) renderer.setRenderTarget(null);
        return any;
    }

    function tuneBudget(dt) {
        if (dt <= 0) return;
        if (dt < 0.019) budget = Math.min(32e6, budget * 1.1);
        else if (dt > 0.027) budget = Math.max(1e6, budget * 0.72);
    }

    function compilePrograms() {
        const compileScene = new THREE.Scene();
        Object.values(programs).forEach((m) => {
            m.uniforms.tNoise.value = noiseTexture;
            const mesh = new THREE.Mesh(quad.geometry, m);
            mesh.frustumCulled = false;
            compileScene.add(mesh);
        });
        renderer.compileAsync(compileScene, bakeCamera).then(() => { programsReady = true; });
    }

    function buildNoise(budgetMs) {
        if (noiseTexture) return true;
        noise.run(budgetMs);
        if (!noise.done) return false;
        noiseTexture = new THREE.Data3DTexture(noise.data, noise.size, noise.size, noise.size);
        noiseTexture.format = THREE.RGBAFormat;
        noiseTexture.type = THREE.UnsignedByteType;
        noiseTexture.minFilter = THREE.LinearFilter;
        noiseTexture.magFilter = THREE.LinearFilter;
        noiseTexture.wrapS = THREE.RepeatWrapping;
        noiseTexture.wrapT = THREE.RepeatWrapping;
        noiseTexture.wrapR = THREE.RepeatWrapping;
        noiseTexture.unpackAlignment = 1;
        noiseTexture.needsUpdate = true;
        compilePrograms();
        return true;
    }

    function promoteCandidates() {
        prev.job = cand.job;
        prev.score = cand.score;
        prev.vx = cand.vx;
        prev.vy = cand.vy;
        prev.hv = cand.hv;
        prev.hh = cand.hh;
        prev.across = cand.across;
        cand.job = null;
        cand.score = 0;
    }

    function readFrame(frame) {
        frame.camera.getWorldDirection(forward);
        frameTanFov = Math.tan((frame.fov * Math.PI) / 360);
        frameAspect = frame.width / frame.height;
        framePxPerRad = frame.pxPerRad;
    }

    // Called at the top of every layer's update; it does its work once per frame
    function beginFrame(frame) {
        if (frame === lastFrame) return;
        lastFrame = frame;
        readFrame(frame);
        promoteCandidates();
        if (!atlas) createAtlas();
        if (!buildNoise(5)) return;
        if (!programsReady) return;
        tuneBudget(frame.dt);
        updateHero(frame);
        doWork(frame);
    }

    const offQuality = bus.on('quality', ({ level }) => {
        // A smaller bake is kept when the level falls, as it's already paid for. Rising from Low bakes larger
        const px = CELL_PX[level] || 256;
        if (px > cellPx) {
            cellPx = px;
            createAtlas();
            jobs.forEach((job) => {
                job.ready = false;
                job.row = 0;
                if (job.onReset) job.onReset();
            });
        }
    });

    return {
        atlasUniform,
        heroUniforms,
        beginFrame,
        addJob,
        considerSprite,
        // For tests and screenshots: finish everything queued, right now. Pass the current frame
        flush(frame) {
            flushing = true;
            readFrame(frame);
            if (!atlas) createAtlas();
            buildNoise(1e9);
            programsReady = true;
            promoteCandidates();
            const keep = budget;
            budget = 1e12;
            updateHero(frame);
            for (let i = 0; i < 16 && doWork(frame); i++) updateHero(frame);
            budget = keep;
            syncHeroUniforms();
            flushing = false;
        },
        stats() {
            return {
                atlasPx: atlas ? atlas.width : 0,
                heroPx,
                baked: jobs.filter((j) => j.ready).length,
                jobs: jobs.length,
                hero: newest.job ? { job: newest.job.id, cx: newest.cx, cy: newest.cy, h: newest.h, k: newest.k } : null,
                heroWorking: !!heroWork,
                budget
            };
        },
        dispose() {
            offQuality();
            if (atlas) atlas.dispose();
            if (heroTargets) heroTargets.forEach((t) => t.dispose());
            if (noiseTexture) noiseTexture.dispose();
            Object.values(programs).forEach((m) => m.dispose());
            quad.geometry.dispose();
        }
    };
}

const bakers = new WeakMap();

// Every layer that bakes shares the one baker, so they share one atlas and one hero
export function getBaker(engine, app) {
    if (!bakers.has(engine)) bakers.set(engine, createBaker(engine, app));
    return bakers.get(engine);
}

// GLSL for a sprite that uses a job's atlas cell and the hero images. Needs vHeroA, vHeroB as varyings.
export const SPRITE_FETCH_GLSL = /* glsl */`
uniform sampler2D tAtlas;
uniform sampler2D uHeroA;
uniform sampler2D uHeroB;
uniform vec4 uHeroARect;
uniform vec4 uHeroBRect;
uniform float uHeroAK;
uniform float uHeroBK;
uniform float uAtlasPx;
varying float vHeroA;
varying float vHeroB;

// A small bake blown up with plain bilinear filtering shows its grid. While it is magnified this is a B-spline filter
// instead, made from four bilinear fetches
vec4 atlasSmooth(vec2 uv) {
    vec2 st = uv * uAtlasPx - 0.5;
    vec2 f = fract(st);
    vec2 i = st - f;
    vec2 f2 = f * f;
    vec2 f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;
    vec2 g0 = w0 + w1;
    vec2 g1 = w2 + w3;
    vec2 h0 = (i - 0.5 + w1 / g0) / uAtlasPx;
    vec2 h1 = (i + 1.5 + w3 / g1) / uAtlasPx;
    return g0.y * (g0.x * textureLod(tAtlas, vec2(h0.x, h0.y), 0.0) + g1.x * textureLod(tAtlas, vec2(h1.x, h0.y), 0.0))
        + g1.y * (g0.x * textureLod(tAtlas, vec2(h0.x, h1.y), 0.0) + g1.x * textureLod(tAtlas, vec2(h1.x, h1.y), 0.0));
}

float windowMask(vec2 w) {
    vec2 e = smoothstep(vec2(0.0), vec2(0.025), w) * smoothstep(vec2(0.0), vec2(0.025), 1.0 - w);
    return e.x * e.y;
}

// q is the position in the sprite (-1..1), cellUv the same position in the atlas
vec4 fetchBaked(vec2 q, vec2 cellUv) {
    vec2 dx = dFdx(cellUv);
    vec2 dy = dFdy(cellUv);
    vec4 t;
    if (max(dot(dx, dx), dot(dy, dy)) * uAtlasPx * uAtlasPx < 0.5) {
        t = atlasSmooth(cellUv);
    } else {
        t = textureGrad(tAtlas, cellUv, dx, dy);
    }
    if (vHeroB > 0.5) {
        vec2 w = (q - uHeroBRect.xy) / (2.0 * uHeroBRect.zw) + 0.5;
        t = mix(t, texture2D(uHeroB, w), windowMask(w) * uHeroBK);
    }
    if (vHeroA > 0.5) {
        vec2 w = (q - uHeroARect.xy) / (2.0 * uHeroARect.zw) + 0.5;
        t = mix(t, texture2D(uHeroA, w), windowMask(w) * uHeroAK);
    }
    return t;
}
`;

// For the vertex shader: sets vHeroA and vHeroB from the instance's job id
export const SPRITE_ID_GLSL = /* glsl */`
uniform float uHeroAId;
uniform float uHeroBId;
varying float vHeroA;
varying float vHeroB;
#define SET_HERO(id) vHeroA = abs((id) - uHeroAId) < 0.5 ? 1.0 : 0.0; vHeroB = abs((id) - uHeroBId) < 0.5 ? 1.0 : 0.0;
`;

// The colour of a spectral line as linear RGB, largest component 1. CIE 1931 fit (Wyman, Sloan and Shirley 2013);
// out-of-gamut colours are brought in by adding white, which keeps the hue, so 500.7 nm comes out teal.
export function lineRGB(nm) {
    const g = (x, mu, s1, s2) => {
        const t = (x - mu) * (x < mu ? s1 : s2);
        return Math.exp(-0.5 * t * t);
    };
    const X = 1.056 * g(nm, 599.8, 0.0264, 0.0323) + 0.362 * g(nm, 442.0, 0.0624, 0.0374) - 0.065 * g(nm, 501.1, 0.049, 0.0382);
    const Y = 0.821 * g(nm, 568.8, 0.0213, 0.0247) + 0.286 * g(nm, 530.9, 0.0613, 0.0322);
    const Z = 1.217 * g(nm, 437.0, 0.0845, 0.0278) + 0.681 * g(nm, 459.0, 0.0385, 0.0725);
    let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
    let gr = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
    let b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
    const low = Math.min(r, gr, b);
    if (low < 0) {
        r -= low;
        gr -= low;
        b -= low;
    }
    const m = Math.max(r, gr, b, 1e-6);
    return [r / m, gr / m, b / m];
}

// Splits an object's emission lines into the two zones the bake keeps apart, and gives each zone its colour. The
// hydrogen zone holds the Balmer lines and the low-ionisation lines beside them; the oxygen zone holds the lines
// that need hotter gas. Returns { hydrogen, oxygen } as linear RGB scaled by each zone's share of the light,
// plus the ratio of oxygen to hydrogen light, which sets how far the oxygen zone reaches.
export function zonePalette(lines) {
    const zones = { hydrogen: [0, 0, 0], oxygen: [0, 0, 0] };
    let sumH = 0;
    let sumO = 0;
    (lines || []).forEach((line) => {
        const label = line.label || '';
        const hot = /III|He|IV|V\b/.test(label) || (!label.includes('H') && line.w < 520);
        const c = lineRGB(line.w);
        // Blue-green H-beta shines from the same gas as H-alpha, but it reads better shared with the inner, bluer zone
        const shared = !hot && line.w < 520 ? 0.6 : 0;
        const toOxygen = hot ? line.rel : line.rel * shared;
        const toHydrogen = hot ? 0 : line.rel * (1 - shared);
        for (let i = 0; i < 3; i++) {
            zones.oxygen[i] += c[i] * toOxygen;
            zones.hydrogen[i] += c[i] * toHydrogen;
        }
        sumO += toOxygen;
        sumH += toHydrogen;
    });
    const peak = Math.max(sumH, sumO, 1e-6);
    const scale = (zone, sum) => {
        const m = Math.max(zone[0], zone[1], zone[2], 1e-6);
        return zone.map((v) => (v / m) * (sum / peak));
    };
    return { hydrogen: scale(zones.hydrogen, sumH), oxygen: scale(zones.oxygen, sumO), excitation: sumO / Math.max(sumH, 1e-6) };
}
