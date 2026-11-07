// The renderer, the hemisphere camera, the frame loop, picking, the graphics level and the post-processing chain.
//
// A layer is any object with these members, added with engine.addLayer():
//   id                  a short name
//   update(frame)       called once a frame before drawing; add your Object3Ds to engine.scene when created
//   picks(frame)?       extra pick candidates: [{ code, az, alt, radiusPx, depth }]; see engine.pick and core/depth.js
//   dispose()?          free GPU resources
//
// frame = { serial, t, dt, fov, pxPerRad, width, height, dpr, camera, band, bandW, quality, reduceMotion, view }
// The frame passed to update() is reused every frame, so keep what you need rather than keeping the object. To tell one
// frame from the next, serial goes up by one each time.
//
// Each frame: sky scene -> overlay passes -> post effects (all HDR) -> bloom -> tone map, vignette, sRGB, dither.
// If WebGL can't start, the engine still returns this API but draws nothing, and the canvas area says why.
//
// If the browser takes the graphics context away and later gives it back, the engine emits bus 'gl-restored'. Whatever
// a layer baked into a render target is gone by then, so a layer that bakes should listen and bake again.
//
// Compiling a shader can take seconds on Windows, and drawing with one that isn't finished freezes the page until it is.
// So anything added to engine.scene waits unseen until its program has compiled, then fades in by its uSkyFade: see
// "Programs" below. A layer needs to do nothing for that. Its own bakes should use compileInBackground, and
// bakesAllowed() to keep from swamping a slow GPU.

import * as THREE from 'three';
import { app, bus } from '../core/state.js';
import { BANDS, bandIndex } from '../core/bands.js';
import { azAltToVec3, DEFAULT_VIEW, MIN_FOV, MAX_FOV, limitingMag } from '../core/sky.js';
import { parallaxFactor, parallaxLog } from '../core/depth.js';
import { bandSkyBrightness } from '../data/band_table.js';
import { sharedUniforms } from './shared.js';

// A body is drawn, and can be picked, when its glow is at least this. Glow is 1 at the zoom's limiting magnitude.
export const MIN_GLOW = 0.05;

const RAD = Math.PI / 180;
const BAND_FADE_S = 0.6;
const ALT_MAX = 89.9;
const ALT_SLEW_MIN = -5;        // Slews and code may go this low; dragging stops a little sooner (altFloor)
const INERTIA_RATE = 4.2;       // How fast a flicked sky slows down (1/s)
const ZOOM_RATE = 11;           // How fast the zoom catches up with the wheel (1/s)
const CLICK_SLOP_MOUSE = 5;     // Pointer travel (px) that turns a click into a drag
const CLICK_SLOP_TOUCH = 12;    // Fingers wobble more
const PICK_RADIUS_MOUSE = 24;
const PICK_RADIUS_TOUCH = 44;   // As generous as a touch target
const REDUCED_SLEW_S = 0.3;     // Reduce motion: a quick dip to black in place of a flight
const ANCHOR_HOLD_PX = 8;       // A zoom keeps the depth it found under the pointer until the pointer moves this far...
const ANCHOR_HOLD_MS = 300;     // ...or the wheel has been still this long

// What each graphics level spends. dpr caps the pixel ratio; bloom levels are halvings of the screen.
const LEVELS = ['low', 'medium', 'high'];
const QUALITY = {
    low: { dpr: 1, bloomLevels: 0 },
    medium: { dpr: 1.5, bloomLevels: 4 },
    high: { dpr: 2, bloomLevels: 6 }
};
// Auto: step down below these rates (frames a second), step up only from a steady rate of QUALITY_UP_FPS
const QUALITY_DOWN_FPS = { high: 42, medium: 27 };
const QUALITY_UP_FPS = 55;
const QUALITY_WINDOW_S = 2;
const QUALITY_MAX_BAKE_SHARE = 0.25;    // A window with bakes in more of its frames than this says little about the machine...
const QUALITY_BAKE_FLOOR = 0.7;         // ...unless its rate is below this share of the floor: paced bakes alone don't do that
const QUALITY_BAKE_FLOOR_LOADING = 0.4; // Lower still while the page is loading
const QUALITY_LOAD_GRACE_S = 12;

const PROGRAM_QUESTIONS_PER_FRAME = 6;  // How many programs may be asked whether they have compiled yet, each frame
const JOIN_FADE_S = 0.5;                // How long something takes to fade in once its program is ready
const WAITING_LAYER = 31;               // The three.js layer things wait in: the camera doesn't look at it
const GPU_MAX_BEHIND = 3;               // Draw nothing new while the GPU has this many frames still to finish...
const GPU_GIVE_UP_WAITING = 120;        // ...unless it has gone this many frames without an answer: the fence must be lost
const GPU_BEHIND_FLAT_OUT = 3;          // A GPU this many frames behind has nothing to spare
const BAKE_FLAT_OUT_EVERY = 3;          // So it bakes only every this many frames
const BAKE_ONE_ONLY_ABOVE_S = 0.03;     // Frames slower than this have room for only one bake

const BLOOM = {
    threshold: 0.75,            // HDR level where glow starts; the Milky Way sits below it and stays clean
    knee: 0.5,                  // Softness of that start
    strength: 0.5,              // Bloom added to the picture
    spread: 0.72                // Each wider level's weight relative to the one above: higher is a wider glow
};

const FULLSCREEN_VERT = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }`;

function easeInOut(x) {
    return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

// The lowest a user's view can go at a field of view: the bottom edge sits a little below the horizon, by 8 degrees
// at most, so that ground never takes over the picture and a narrow view can still get right down to the hills
function altFloor(fov) {
    return Math.max(fov * 0.25, fov * 0.5 - 8);
}

function supportsHalfFloatTarget(renderer) {
    return renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
}

// A message in the canvas area, for when the sky can't be drawn at all
function showCanvasMessage(canvas, text) {
    const host = canvas.parentElement;
    if (!host) return null;
    let box = host.querySelector('.spectro-gl-message');
    if (!box) {
        box = document.createElement('div');
        box.className = 'spectro-gl-message';
        box.setAttribute('role', 'alert');
        host.appendChild(box);
    }
    box.textContent = text;
    box.hidden = false;
    return box;
}

function hideCanvasMessage(canvas) {
    const box = canvas.parentElement && canvas.parentElement.querySelector('.spectro-gl-message');
    if (box) box.hidden = true;
}

export function createEngine(canvas) {
    let renderer = null;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false, depth: false });
    } catch (err) {
        console.warn('[spectroscopy] WebGL is not available:', err);
        showCanvasMessage(canvas, "This device can't draw the sky, because WebGL 2 isn't available or is turned off. Try turning on hardware acceleration in your browser's settings, or use another browser. The Go to box and the object panels still work.");
    }
    if (renderer) {
        renderer.setClearColor(0x000000, 1);
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // The final pass converts to sRGB itself
        renderer.autoClear = false;                             // Overlay passes draw on top of the sky
        renderer.info.autoReset = false;                        // Count the whole frame, not its last pass
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(DEFAULT_VIEW.fov, 2, 0.1, 5000);
    camera.rotation.order = 'YXZ';

    const view = { ...DEFAULT_VIEW };
    const layers = [];
    const postEffects = [];
    const overlayPasses = []; // Drawn into the HDR buffer after the sky: see addOverlayPass (the system view uses it)
    let slew = null;
    let width = 1;
    let height = 1;
    let dpr = 1;
    let bufferW = 1;
    let bufferH = 1;
    let lastNow = performance.now();
    let elapsed = 0;
    let bandFrom = bandIndex(app.band);
    let bandTo = bandFrom;
    let bandFade = 1;
    let running = false;
    let rafId = 0;
    let contextLost = false;
    let skipSkyDraw = false;
    let dipToBlack = 1;       // 1 is the full picture; Reduce motion's slews dip this to 0 and back
    let lastCameraFov = 0;

    // Camera motion
    const velocity = { az: 0, alt: 0 };     // Degrees a second, from a flick
    let zoomGoal = view.fov;
    let zoomAnchor = null;                  // Screen point (CSS px) that stays put while zooming

    // ---------- Render targets ----------

    const hdrType = renderer && !supportsHalfFloatTarget(renderer) ? THREE.UnsignedByteType : THREE.HalfFloatType;
    const makeTarget = (depthBuffer) => new THREE.WebGLRenderTarget(1, 1, {
        type: hdrType,
        depthBuffer,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false
    });
    let targetA = renderer ? makeTarget(true) : null;
    let targetB = null;                     // Made the first time a post effect runs, as most frames need none
    let bloomTargets = [];

    // ---------- Full-screen passes ----------

    const fsGeometry = new THREE.BufferGeometry();
    fsGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const fsMesh = new THREE.Mesh(fsGeometry);
    fsMesh.frustumCulled = false;
    const fsScene = new THREE.Scene();
    fsScene.add(fsMesh);
    const fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const fsMaterial = (params) => new THREE.ShaderMaterial({
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        vertexShader: FULLSCREEN_VERT,
        ...params
    });

    function drawFullscreen(material, target) {
        fsMesh.material = material;
        renderer.setRenderTarget(target);
        renderer.render(fsScene, fsCamera);
    }

    // Bloom: a dual-filter chain. Each step down halves the picture with 5 taps; each step up adds the wider
    // level back with 8. No separate targets for the way up, as the levels are added to in place.
    const bloomDown = fsMaterial({
        blending: THREE.NoBlending,
        uniforms: {
            tInput: { value: null },
            uHalfTexel: { value: new THREE.Vector2() },
            uThreshold: { value: 0 },
            uKnee: { value: BLOOM.knee }
        },
        fragmentShader: /* glsl */`
            uniform sampler2D tInput;
            uniform vec2 uHalfTexel;
            uniform float uThreshold;
            uniform float uKnee;
            varying vec2 vUv;
            vec3 bright(vec3 c) {
                // A very bright star must not outweigh everything once averaged
                c = min(c, vec3(64.0));
                if (uThreshold <= 0.0) return c;
                float b = max(c.r, max(c.g, c.b));
                float soft = clamp(b - uThreshold + uKnee, 0.0, 2.0 * uKnee);
                soft = soft * soft / (4.0 * uKnee + 1e-4);
                return c * max(b - uThreshold, soft) / max(b, 1e-4);
            }
            void main() {
                vec3 sum = bright(texture2D(tInput, vUv).rgb) * 4.0;
                sum += bright(texture2D(tInput, vUv - uHalfTexel).rgb);
                sum += bright(texture2D(tInput, vUv + uHalfTexel).rgb);
                sum += bright(texture2D(tInput, vUv + vec2(uHalfTexel.x, -uHalfTexel.y)).rgb);
                sum += bright(texture2D(tInput, vUv - vec2(uHalfTexel.x, -uHalfTexel.y)).rgb);
                gl_FragColor = vec4(sum / 8.0, 1.0);
            }`
    });
    const bloomUp = fsMaterial({
        transparent: true,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        uniforms: {
            tInput: { value: null },
            uHalfTexel: { value: new THREE.Vector2() },
            uWeight: { value: 1 }
        },
        fragmentShader: /* glsl */`
            uniform sampler2D tInput;
            uniform vec2 uHalfTexel;
            uniform float uWeight;
            varying vec2 vUv;
            void main() {
                vec2 h = uHalfTexel;
                vec3 sum = texture2D(tInput, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
                sum += texture2D(tInput, vUv + vec2(-h.x, h.y)).rgb * 2.0;
                sum += texture2D(tInput, vUv + vec2(0.0, h.y * 2.0)).rgb;
                sum += texture2D(tInput, vUv + vec2(h.x, h.y)).rgb * 2.0;
                sum += texture2D(tInput, vUv + vec2(h.x * 2.0, 0.0)).rgb;
                sum += texture2D(tInput, vUv + vec2(h.x, -h.y)).rgb * 2.0;
                sum += texture2D(tInput, vUv + vec2(0.0, -h.y * 2.0)).rgb;
                sum += texture2D(tInput, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
                gl_FragColor = vec4(sum / 12.0 * uWeight, 1.0);
            }`
    });

    // Final pass: HDR plus bloom, a subtle vignette, an ACES-like curve, sRGB, and a little dither so that the
    // long faint gradients of the Milky Way don't band in eight bits.
    const composite = fsMaterial({
        blending: THREE.NoBlending,
        uniforms: {
            tInput: { value: null },
            tBloom: { value: null },
            uBloom: { value: 0 },
            uExposure: { value: 1 },
            uDip: { value: 1 },
            uAspect: { value: 1 }
        },
        fragmentShader: /* glsl */`
            uniform sampler2D tInput;
            uniform sampler2D tBloom;
            uniform float uBloom;
            uniform float uExposure;
            uniform float uDip;
            uniform float uAspect;
            varying vec2 vUv;
            vec3 aces(vec3 x) {
                return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
            }
            vec3 toSRGB(vec3 c) {
                return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
            }
            void main() {
                vec3 hdr = texture2D(tInput, vUv).rgb;
                if (uBloom > 0.0) hdr += texture2D(tBloom, vUv).rgb * uBloom;
                vec2 q = (vUv - 0.5) * vec2(min(uAspect, 1.6) / 1.6, 1.0) * 2.0;
                float vignette = 1.0 - 0.22 * smoothstep(0.25, 1.6, dot(q, q));
                vec3 c = toSRGB(aces(hdr * uExposure * vignette * uDip));
                float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
                gl_FragColor = vec4(c + (dither - 0.5) / 255.0, 1.0);
            }`
    });

    function disposeBloom() {
        bloomTargets.forEach((t) => t.dispose());
        bloomTargets = [];
    }

    function buildBloom() {
        disposeBloom();
        const levels = QUALITY[app.qualityLevel].bloomLevels;
        let w = bufferW;
        let h = bufferH;
        for (let i = 0; i < levels; i++) {
            w = Math.max(2, w >> 1);
            h = Math.max(2, h >> 1);
            const target = makeTarget(false);
            target.setSize(w, h);
            bloomTargets.push(target);
        }
    }

    function renderBloom(input) {
        const n = bloomTargets.length;
        if (!n) return null;
        let source = input;
        for (let i = 0; i < n; i++) {
            const target = bloomTargets[i];
            bloomDown.uniforms.tInput.value = source;
            bloomDown.uniforms.uHalfTexel.value.set(0.5 / target.width, 0.5 / target.height);
            bloomDown.uniforms.uThreshold.value = i === 0 ? BLOOM.threshold : 0;
            drawFullscreen(bloomDown, target);
            source = target.texture;
        }
        for (let i = n - 2; i >= 0; i--) {
            const target = bloomTargets[i];
            bloomUp.uniforms.tInput.value = bloomTargets[i + 1].texture;
            bloomUp.uniforms.uHalfTexel.value.set(0.5 / target.width, 0.5 / target.height);
            bloomUp.uniforms.uWeight.value = BLOOM.spread;
            drawFullscreen(bloomUp, target);
        }
        return bloomTargets[0].texture;
    }

    // ---------- Programs ----------

    // Compiles everything in a scene or object without blocking, and resolves when it's all ready to draw with. As three's
    // compileAsync, but asking after a few programs a frame, not after every one of them every 10 ms: each question is a
    // round trip to the GPU process, which has to get through whatever is queued there before it can answer.
    const compileJobs = [];

    function compileInBackground(target, targetCamera = camera) {
        if (!renderer) return Promise.resolve();
        return new Promise((resolve) => {
            compileJobs.push({ materials: [...renderer.compile(target, targetCamera)], resolve });
        });
    }

    function stepCompileJobs() {
        let questions = PROGRAM_QUESTIONS_PER_FRAME;
        for (let i = compileJobs.length - 1; i >= 0; i--) {
            const job = compileJobs[i];
            job.materials = job.materials.filter((material) => {
                if (questions <= 0) return true;
                const { currentProgram } = renderer.properties.get(material);
                if (!currentProgram) return false;
                questions -= 1;
                return !currentProgram.isReady();
            });
            if (!job.materials.length) {
                compileJobs.splice(i, 1);
                job.resolve();
            }
        }
    }

    // The picture can't be finished without these, so nothing is drawn until they have compiled. They're small.
    let chainReady = false;

    function compileChain() {
        chainReady = false;
        if (!renderer) return;
        const chain = new THREE.Scene();
        [composite, bloomDown, bloomUp].forEach((material) => {
            const mesh = new THREE.Mesh(fsGeometry, material);
            mesh.frustumCulled = false;
            chain.add(mesh);
        });
        compileInBackground(chain, fsCamera).then(() => { chainReady = true; });
    }

    // Nothing new in the scene draws until its program has compiled, because drawing it sooner blocks the page until the
    // driver has finished, and that can be seconds. Waiting is done with three.js layers, not .visible, which is the
    // layers' own to set. Then it fades in, by way of its own copy of uSkyFade, which every sky shader already obeys.
    const joining = new Map();      // material -> { objects, fade, proxy, shown }
    const admitted = new WeakSet();
    let lastSeenChild = null;
    let lastSeenCount = -1;

    function admitObject(object) {
        const { material } = object;
        if (!material || Array.isArray(material) || admitted.has(object)) return;
        admitted.add(object);
        if (!material.isShaderMaterial) return;
        const props = renderer.properties.get(material);
        const entry = joining.get(material);
        if (entry) {
            if (!entry.shown) object.layers.set(WAITING_LAYER);
            entry.objects.push(object);
            return;
        }
        if (props.currentProgram && props.currentProgram.isReady()) return;
        object.layers.set(WAITING_LAYER);
        joining.set(material, { objects: [object], fade: 0, proxy: null, shown: false });
    }

    function admitNewObjects() {
        const { children } = scene;
        const last = children[children.length - 1] || null;
        if (children.length === lastSeenCount && last === lastSeenChild) return;
        lastSeenCount = children.length;
        lastSeenChild = last;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (admitted.has(child) && !child.children.length) continue;
            child.traverse(admitObject);
            renderer.compile(child, camera, scene);
        }
    }

    function stepJoining(dt) {
        if (!joining.size) return;
        const reduce = app.settings.reduceMotion;
        let questions = PROGRAM_QUESTIONS_PER_FRAME;
        joining.forEach((entry, material) => {
            if (!entry.shown) {
                if (questions <= 0) return;
                questions -= 1;
                const { currentProgram } = renderer.properties.get(material);
                if (currentProgram && !currentProgram.isReady()) return;
                // Its first use asks the driver a few things, which waits for the GPU's queue: better now, at the top of
                // the frame, than later on with this frame's bakes in front of it
                if (currentProgram) currentProgram.getUniforms();
                entry.shown = true;
                entry.objects.forEach((object) => object.layers.set(0));
                if (material.uniforms && material.uniforms.uSkyFade === sharedUniforms.uSkyFade) {
                    entry.proxy = { value: 0 };
                    material.uniforms.uSkyFade = entry.proxy;
                }
            }
            entry.fade = reduce || !entry.proxy ? 1 : Math.min(1, entry.fade + dt / JOIN_FADE_S);
            if (entry.proxy) entry.proxy.value = sharedUniforms.uSkyFade.value * entry.fade;
            if (entry.fade >= 1) {
                if (entry.proxy) material.uniforms.uSkyFade = sharedUniforms.uSkyFade;
                joining.delete(material);
            }
        });
    }

    // After a lost context every program is gone, so everything has to wait and join again
    function readmitAll() {
        compileJobs.length = 0;
        joining.forEach((entry, material) => {
            if (entry.proxy) material.uniforms.uSkyFade = sharedUniforms.uSkyFade;
        });
        joining.clear();
        scene.traverse((object) => {
            if (object.material) admitted.delete(object);
        });
        lastSeenCount = -1;
    }

    // ---------- How far behind the GPU is ----------

    // Requesting a frame doesn't wait for the GPU to finish the last one, so a slow GPU can fall a second or more behind
    // while the loop runs on at full speed, and then everything the student does shows up that much later. One fence
    // at a time says how many frames it took to come back. The loop draws nothing new while the GPU is too far behind.
    const gpu = { fence: null, waited: 0, behind: 0 };

    function pollGpu() {
        if (!gpu.fence) return;
        const gl = renderer.getContext();
        gpu.waited += 1;
        if (gl.getSyncParameter(gpu.fence, gl.SYNC_STATUS) === gl.SIGNALED) {
            gl.deleteSync(gpu.fence);
            gpu.fence = null;
            gpu.behind = gpu.waited;
        } else if (gpu.waited > gpu.behind) {
            gpu.behind = gpu.waited;
        }
    }

    function fenceFrame() {
        if (gpu.fence) return;
        const gl = renderer.getContext();
        gpu.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gpu.waited = 0;
    }

    // ---------- Bakes ----------

    // A layer asks before each piece of baking, and that marks the frame as one with baking in it, so that Auto doesn't
    // count the bake's cost against the machine. A GPU with room to spare says yes to everyone. A slow one takes one bake
    // a frame, with the layers taking turns, and one that is flat out only every few frames. lowPriority: only when no
    // one else wants a turn, for something that doesn't show yet.
    let bakedThisFrame = false;
    let lastRealDt = 0;
    const bakeTurns = { asked: 0, askedBefore: 0, turn: 0, granted: false, frame: 0 };

    function nextBakeFrame() {
        bakedThisFrame = false;
        bakeTurns.askedBefore = bakeTurns.asked;
        bakeTurns.asked = 0;
        if (bakeTurns.granted) bakeTurns.turn += 1;
        bakeTurns.granted = false;
        bakeTurns.frame += 1;
    }

    function bakesAllowed(lowPriority = false) {
        bakedThisFrame = true;
        if (lowPriority && bakeTurns.askedBefore > 0) return false;
        const index = lowPriority ? 0 : bakeTurns.asked++;
        if (gpu.behind < 2 && lastRealDt <= BAKE_ONE_ONLY_ABOVE_S) return true;
        if (gpu.behind >= GPU_BEHIND_FLAT_OUT && bakeTurns.frame % BAKE_FLAT_OUT_EVERY !== 0) return false;
        if (index !== bakeTurns.turn % Math.max(1, bakeTurns.askedBefore)) return false;
        bakeTurns.granted = true;
        return true;
    }

    // Sizes a piece of baking to what the GPU is getting through: returns the next size, up a little or down a lot
    function bakePace(size, min, max) {
        if (gpu.behind >= 2) return Math.max(min, size * 0.7);
        return Math.min(max, size * 1.08);
    }

    // ---------- Size and graphics level ----------

    function resize() {
        const rect = canvas.getBoundingClientRect();
        width = Math.max(1, Math.round(rect.width));
        height = Math.max(1, Math.round(rect.height));
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        if (!renderer) return;
        const cap = QUALITY[app.qualityLevel].dpr;
        dpr = Math.min(window.devicePixelRatio || 1, cap);
        renderer.setPixelRatio(dpr);
        renderer.setSize(width, height, false);
        const unchanged = canvas.width === bufferW && canvas.height === bufferH
            && bloomTargets.length === QUALITY[app.qualityLevel].bloomLevels;
        composite.uniforms.uAspect.value = camera.aspect;
        if (unchanged) return;
        bufferW = canvas.width;
        bufferH = canvas.height;
        targetA.setSize(bufferW, bufferH);
        if (targetB) targetB.setSize(bufferW, bufferH);
        buildBloom();
    }

    function setLevel(level) {
        if (level === app.qualityLevel) return;
        app.qualityLevel = level;
        resize();
        bus.emit('quality', { level });
    }

    // Weak-looking machines start low and earn their way up, rather than stuttering for the first few seconds
    function guessStartLevel() {
        const memory = navigator.deviceMemory || 8;
        const cores = navigator.hardwareConcurrency || 8;
        return memory <= 4 && cores <= 4 ? 'low' : 'medium';
    }

    // Auto: measures in windows. It steps down when a window stays low, and only ever climbs to a level that
    // hasn't failed: a level it had to leave becomes the ceiling, which is what stops it oscillating.
    const engineStartedAt = performance.now();
    const auto = { time: 0, frames: 0, bakeFrames: 0, flatOutFrames: 0, skip: 1, lowWindows: 0, goodWindows: 0, stalls: 0, ceiling: 2 };

    function resetAuto(skip = 1) {
        auto.time = 0;
        auto.frames = 0;
        auto.bakeFrames = 0;
        auto.flatOutFrames = 0;
        auto.skip = skip;
        auto.lowWindows = 0;
        auto.goodWindows = 0;
        auto.stalls = 0;
    }

    function measureAuto(realDt) {
        if (app.settings.quality !== 'auto') return;
        if (realDt > 1) {
            // A single long frame is a stall, not a rate. A run of them is a very slow machine, unless they're bakes.
            if (bakedThisFrame) return;
            auto.stalls += 1;
            if (auto.stalls >= 4) stepDown();
            return;
        }
        auto.time += realDt;
        auto.frames += 1;
        if (bakedThisFrame) auto.bakeFrames += 1;
        if (gpu.behind >= GPU_BEHIND_FLAT_OUT) auto.flatOutFrames += 1;
        if (auto.time < QUALITY_WINDOW_S) return;
        const fps = auto.frames / auto.time;
        const bakeShare = auto.bakeFrames / auto.frames;
        const flatOut = auto.flatOutFrames / auto.frames > 0.8;
        auto.time = 0;
        auto.frames = 0;
        auto.bakeFrames = 0;
        auto.flatOutFrames = 0;
        auto.stalls = 0;
        if (auto.skip > 0) {
            auto.skip -= 1;
            return;
        }
        const index = LEVELS.indexOf(app.qualityLevel);
        const floor = QUALITY_DOWN_FPS[app.qualityLevel];
        // Loading bakes for some seconds, and a new view for a moment. Neither says how the machine will do afterwards, and
        // a level lost to one would stay lost. Bakes are paced to what the GPU can spare, though, so a GPU still flat out,
        // or a rate too low for them to explain, is the machine's own. All the more once loading should be over: a machine
        // still baking by then is a slow one, and needs the lower level the sooner.
        if (bakeShare > QUALITY_MAX_BAKE_SHARE) {
            const loading = performance.now() - engineStartedAt < QUALITY_LOAD_GRACE_S * 1000;
            if (floor && (flatOut || fps < floor * (loading ? QUALITY_BAKE_FLOOR_LOADING : QUALITY_BAKE_FLOOR))) {
                auto.lowWindows += 1;
                auto.goodWindows = 0;
                if (auto.lowWindows >= 2) stepDown();
            } else {
                auto.lowWindows = 0;
            }
            return;
        }
        if (floor && fps < floor) {
            auto.lowWindows += 1;
            auto.goodWindows = 0;
            if (auto.lowWindows >= 2 || fps < floor * 0.66) stepDown();
            return;
        }
        auto.lowWindows = 0;
        auto.goodWindows = fps >= QUALITY_UP_FPS ? auto.goodWindows + 1 : 0;
        if (auto.goodWindows >= 2 && index < auto.ceiling) {
            setLevel(LEVELS[index + 1]);
            resetAuto();
        }
    }

    function stepDown() {
        const index = LEVELS.indexOf(app.qualityLevel);
        if (index > 0) {
            auto.ceiling = index - 1;
            setLevel(LEVELS[index - 1]);
        }
        resetAuto();
    }

    function applyQualitySetting() {
        const wanted = app.settings.quality;
        if (wanted === 'auto') {
            auto.ceiling = 2;
            resetAuto();
        } else if (QUALITY[wanted]) {
            setLevel(wanted);
        }
    }

    // ---------- Camera ----------

    function applyView() {
        camera.rotation.y = -view.az * RAD;
        camera.rotation.x = view.alt * RAD;
        if (view.fov !== lastCameraFov) {
            lastCameraFov = view.fov;
            camera.fov = view.fov;
            camera.updateProjectionMatrix();
        }
        camera.updateMatrixWorld();
    }

    function placeView(az, alt, fov) {
        view.az = ((az % 360) + 360) % 360;
        view.alt = Math.max(ALT_SLEW_MIN, Math.min(ALT_MAX, alt));
        view.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, fov));
        applyView();
    }

    // Jumps straight there. In the sky, the horizon rule applies: widening the view lifts it clear of the ground, while
    // a view a flight left below the rule can stay, but not go lower. The system view's own flights aren't held to it.
    function setView(next) {
        const fov = next.fov !== undefined ? Math.max(MIN_FOV, Math.min(MAX_FOV, next.fov)) : view.fov;
        let alt = next.alt !== undefined ? next.alt : view.alt;
        if (app.view === 'sky') {
            const floor = altFloor(fov);
            alt = fov > view.fov ? Math.max(alt, floor) : Math.max(alt, Math.min(view.alt, floor));
        }
        placeView(next.az !== undefined ? next.az : view.az, alt, fov);
        zoomGoal = view.fov;
        zoomAnchor = null;
        velocity.az = 0;
        velocity.alt = 0;
    }

    // Fly the camera along the shortest way round. opts: { duration (s), pullBack, onDone }. Duration 0 jumps.
    // pullBack widens the view on the way, more for a long flight, so the sky doesn't whip past. Reduce motion
    // replaces the flight with a quick dip to black.
    function slewTo(target, opts = {}) {
        velocity.az = 0;
        velocity.alt = 0;
        zoomAnchor = null;
        const duration = renderer ? opts.duration ?? 1.5 : 0; // With no frames to fly through, it only has to get there
        const toAz = target.az ?? view.az;
        const toAlt = target.alt ?? view.alt;
        const toFov = target.fov ?? view.fov;
        if (duration <= 0) {
            placeView(toAz, toAlt, toFov);
            zoomGoal = view.fov;
            slew = null;
            dipToBlack = 1;
            if (opts.onDone) opts.onDone();
            return;
        }
        if (app.settings.reduceMotion) {
            slew = { dip: true, jumped: false, toAz, toAlt, toFov, t: 0, duration: REDUCED_SLEW_S, onDone: opts.onDone };
            return;
        }
        const dAz = ((((toAz - view.az + 540) % 360) + 360) % 360) - 180;
        const dAlt = toAlt - view.alt;
        let midFov = null;
        if (opts.pullBack) {
            const across = Math.hypot(dAz * Math.cos(((view.alt + toAlt) / 2) * RAD), dAlt);
            midFov = Math.min(MAX_FOV, Math.max(Math.max(view.fov, toFov) * 1.25, Math.min(70, across * 0.8)));
        }
        slew = { from: { ...view }, dAz, dAlt, toFov, midFov, t: 0, duration, onDone: opts.onDone };
    }

    function stepSlew(dt) {
        if (!slew) return;
        slew.t = Math.min(1, slew.t + dt / slew.duration);
        if (slew.dip) {
            dipToBlack = Math.abs(1 - slew.t * 2);
            if (slew.t >= 0.5 && !slew.jumped) {
                slew.jumped = true;
                placeView(slew.toAz, slew.toAlt, slew.toFov);
                zoomGoal = view.fov;
            }
        } else {
            const k = easeInOut(slew.t);
            const { from, midFov, toFov } = slew;
            let fov;
            // In log steps, as a zoom feels even when each step is the same ratio
            if (midFov) {
                fov = slew.t < 0.5
                    ? from.fov * (midFov / from.fov) ** easeInOut(slew.t * 2)
                    : midFov * (toFov / midFov) ** easeInOut(slew.t * 2 - 1);
            } else {
                fov = from.fov * (toFov / from.fov) ** k;
            }
            placeView(from.az + slew.dAz * k, from.alt + slew.dAlt * k, fov);
        }
        if (slew.t >= 1) {
            const done = slew.onDone;
            slew = null;
            dipToBlack = 1;
            zoomGoal = view.fov;
            if (done) done();
        }
    }

    // The ray through a screen point for a thing at this depth, in camera space at a field of view: x right, y up, f
    // forward, length 1. Further things are drawn nearer the centre than the camera alone puts them (core/depth.js).
    const ray = { x: 0, y: 0, f: 1 };
    function rayThrough(px, py, fov, depth = 0) {
        const t = Math.tan(fov * RAD * 0.5) / parallaxFactor(depth, fov);
        const x = ((px / width) * 2 - 1) * t * (width / height);
        const y = (1 - (py / height) * 2) * t;
        const length = Math.hypot(x, y, 1);
        ray.x = x / length;
        ray.y = y / length;
        ray.f = 1 / length;
        return ray;
    }

    // The depth of whatever is under a screen point, or the dome's over empty sky. Asking is a sweep through every layer's
    // picks, too much for each event of a wheel, so one gesture asks once. And it stays with the thing it found first.
    const anchorHeld = { x: 0, y: 0, at: -Infinity, depth: 1 };
    function depthUnder(px, py) {
        const now = performance.now();
        const held = now - anchorHeld.at < ANCHOR_HOLD_MS && Math.hypot(px - anchorHeld.x, py - anchorHeld.y) < ANCHOR_HOLD_PX;
        anchorHeld.at = now;
        if (held) return anchorHeld.depth;
        const code = pick(px, py, 12);
        const found = code ? app.universe.resolve(code) : null;
        anchorHeld.x = px;
        anchorHeld.y = py;
        anchorHeld.depth = found ? found.body.depth || 0 : 1;
        return anchorHeld.depth;
    }

    // The zoom's anchor: a screen point, and the direction in the sky under it when the zoom began. What you point at is
    // what you zoom into: it's the depth of the thing under the pointer that stays still.
    function anchorZoomAt(px, py) {
        const depth = depthUnder(px, py);
        const r = rayThrough(px, py, view.fov, depth);
        const p = view.alt * RAD;
        const a = view.az * RAD;
        const up = r.y * Math.cos(p) + r.f * Math.sin(p);
        const back = r.y * Math.sin(p) - r.f * Math.cos(p);
        zoomAnchor = {
            x: px,
            y: py,
            depth,
            skyX: r.x * Math.cos(a) - back * Math.sin(a),
            skyY: up,
            skyZ: r.x * Math.sin(a) + back * Math.cos(a)
        };
    }

    // Keeps the sky under the anchor still, so what you point at is what you zoom into. Solves for the view that puts
    // the anchor's direction back under its screen point, so errors can't build up over the steps of a zoom.
    function setFovAnchored(next) {
        let { az, alt } = view;
        if (zoomAnchor) {
            const r = rayThrough(zoomAnchor.x, zoomAnchor.y, next, zoomAnchor.depth);
            const tilt = Math.atan2(r.y, r.f);
            const reach = Math.asin(Math.max(-1, Math.min(1, zoomAnchor.skyY / Math.hypot(r.y, r.f))));
            // Two pitches put the anchor at the right height: the one nearer the view, past the zenith or not
            const near = reach - tilt;
            const far = Math.PI - reach - tilt;
            const p = Math.abs(far - alt * RAD) < Math.abs(near - alt * RAD) ? far : near;
            const back = r.y * Math.sin(p) - r.f * Math.cos(p);
            alt = p / RAD;
            az = (Math.atan2(zoomAnchor.skyX, -zoomAnchor.skyZ) - Math.atan2(r.x, -back)) / RAD;
        }
        placeView(az, Math.max(alt, altFloor(next)), next);
    }

    function stepCameraMotion(dt) {
        if (slew) return;
        const reduce = app.settings.reduceMotion;
        if (Math.abs(Math.log(zoomGoal / view.fov)) > 1e-4) {
            const k = reduce ? 1 : 1 - Math.exp(-dt * ZOOM_RATE);
            setFovAnchored(view.fov * (zoomGoal / view.fov) ** k);
        } else if (view.fov !== zoomGoal) {
            setFovAnchored(zoomGoal);
        }
        if (dragPointers.size || (velocity.az === 0 && velocity.alt === 0)) return;
        if (reduce) {
            velocity.az = 0;
            velocity.alt = 0;
            return;
        }
        const decay = Math.exp(-dt * INERTIA_RATE);
        const alt = Math.max(Math.min(view.alt, altFloor(view.fov)), view.alt + velocity.alt * dt);
        placeView(view.az + velocity.az * dt, alt, view.fov);
        velocity.az *= decay;
        velocity.alt *= decay;
        // Stop once it no longer moves a pixel a second or so
        const minSpeed = (view.fov / height) * 0.5;
        if (Math.abs(velocity.az) < minSpeed && Math.abs(velocity.alt) < minSpeed) {
            velocity.az = 0;
            velocity.alt = 0;
        }
    }

    // Screen position (CSS pixels from the canvas's top-left) of a sky direction at a depth; null when behind the camera.
    // Without a depth this is where a thing as near as can be is drawn: see core/depth.js.
    const tmp = new THREE.Vector3();
    function project(az, alt, depth = 0) {
        const v = azAltToVec3(az, alt);
        tmp.set(v[0] * 1000, v[1] * 1000, v[2] * 1000).project(camera);
        if (tmp.z > 1 || tmp.z < -1) return null;
        const p = parallaxFactor(depth, view.fov);
        const x = tmp.x * p;
        const y = tmp.y * p;
        return { x: (x * 0.5 + 0.5) * width, y: (-y * 0.5 + 0.5) * height, onScreen: Math.abs(x) <= 1 && Math.abs(y) <= 1 };
    }

    // Where a body is drawn
    function projectBody(body) {
        return project(body.sky.az, body.sky.alt, body.depth || 0);
    }

    // ---------- Picking ----------

    // Extended bodies can be clicked anywhere on them, using the size in their data. Layers may add better shapes.
    function extendedRadiusDeg(body) {
        if (body.nebula) return body.nebula.size_deg * 0.4;
        if (body.galaxy) return body.galaxy.size_deg * 0.45;
        if (body.cluster) return body.cluster.radius_deg;
        if (body.comet) return body.comet.coma_deg;
        if (body.supernova) return body.supernova.shell_deg;
        return 0;
    }

    // Lower is a better match. A point-like thing near the pointer beats a big thing it lies inside, and of two
    // things about as close, the brighter one wins.
    function pickScore(dist, radiusPx, bonusPx) {
        if (radiusPx > 12) {
            return dist <= radiusPx ? 6 + 8 * (dist / radiusPx) : dist - radiusPx + 14;
        }
        return Math.max(0, dist - radiusPx) - bonusPx;
    }

    // Up to 10 px of head start for the brighter of two neighbours: 1.25 px for each magnitude above the zoom's limit
    function brightnessBonusPx(body, lim) {
        const margin = 2.5 * Math.log10(Math.max(bodyGlow(body, app.band) * zoomGain(lim), 1e-6));
        return Math.min(10, Math.max(0, margin) * 1.25);
    }

    function zoomGain(lim) {
        return 10 ** (0.4 * (lim - 6));
    }

    // Worked out once per body and band. The sum behind it is cheap, but picking asks for a thousand at a time.
    const glowCache = new WeakMap();
    function bodyGlow(body, band) {
        let row = glowCache.get(body);
        if (!row) {
            row = {};
            glowCache.set(body, row);
        }
        if (row[band] === undefined) row[band] = bandSkyBrightness(body, band);
        return row[band];
    }

    // The code of the object nearest a screen position (CSS pixels), or null. Bodies must show in the current band
    // at this zoom. Layers can add candidates (cluster members, say) through layer.picks(frame).
    function pick(x, y, maxPx = PICK_RADIUS_MOUSE) {
        if (app.view !== 'sky') return null;
        applyView();
        let best = null;
        let bestScore = Infinity;
        const lim = limitingMag(view.fov);
        const pxPerDeg = (height * 0.5 * RAD) / Math.tan(view.fov * RAD * 0.5);
        const consider = (code, az, alt, radiusPx, bonusPx, depth) => {
            const p = project(az, alt, depth);
            // Something with a size can be on show while its middle is off the edge of the view
            if (!p || (!p.onScreen && !radiusPx)) return;
            const dist = Math.hypot(p.x - x, p.y - y);
            if (dist > maxPx + radiusPx) return;
            const score = pickScore(dist, radiusPx, bonusPx);
            if (score < bestScore) {
                bestScore = score;
                best = code;
            }
        };
        if (app.universe) {
            const { bodies } = app.universe;
            for (let i = 0; i < bodies.length; i++) {
                const body = bodies[i];
                if (bodyShows(body, lim)) {
                    const depth = body.depth || 0;
                    const radiusPx = extendedRadiusDeg(body) * pxPerDeg * parallaxFactor(depth, view.fov);
                    consider(body.code, body.sky.az, body.sky.alt, radiusPx, brightnessBonusPx(body, lim), depth);
                }
            }
        }
        const frame = currentFrame();
        layers.forEach((layer) => {
            if (!layer.picks) return;
            (layer.picks(frame) || []).forEach((c) => consider(c.code, c.az, c.alt, c.radiusPx || 0, 0, c.depth || 0));
        });
        return best;
    }

    // Is this body drawn at all right now? Used for picking; the layers apply the same rule in their shaders, so what
    // can be picked matches what is drawn in every band.
    function bodyShows(body, lim = limitingMag(view.fov)) {
        if (body.kind === 'home_planet' && !app.layers.homePlanets) return false;
        return bodyGlow(body, app.band) * zoomGain(lim) >= MIN_GLOW;
    }

    // ---------- Bands ----------

    const bandWeights = BANDS.map((_, i) => (i === bandTo ? 1 : 0));

    function setBandTarget(band) {
        let top = 0;
        for (let i = 1; i < bandWeights.length; i++) if (bandWeights[i] > bandWeights[top]) top = i;
        bandFrom = top;
        bandTo = bandIndex(band);
        bandFade = app.settings.reduceMotion ? 1 : 0;
        updateBandWeights();
    }

    function updateBandWeights() {
        const k = easeInOut(Math.min(1, bandFade));
        for (let i = 0; i < bandWeights.length; i++) {
            bandWeights[i] = (i === bandTo ? k : 0) + (i === bandFrom ? 1 - k : 0);
        }
    }

    // ---------- The frame ----------

    let frameSerial = 0;

    function fillFrame(frame, dt) {
        frame.serial = frameSerial;
        frame.t = elapsed;
        frame.dt = dt;
        frame.fov = view.fov;
        frame.pxPerRad = (height * dpr * 0.5) / Math.tan(view.fov * RAD * 0.5);
        frame.width = width;
        frame.height = height;
        frame.dpr = dpr;
        frame.camera = camera;
        frame.band = app.band;
        frame.bandW = bandWeights;
        frame.quality = app.qualityLevel;
        frame.reduceMotion = app.settings.reduceMotion;
        frame.view = app.view;
        return frame;
    }

    function currentFrame() {
        return fillFrame({}, 0);
    }

    const liveFrame = {};
    const stats = { calls: 0, triangles: 0, points: 0, jsMs: 0, fps: 0 };

    function renderOnce(dt) {
        const started = performance.now();
        frameSerial += 1;
        stepSlew(dt);
        stepCameraMotion(dt);
        if (bandFade < 1) {
            bandFade = Math.min(1, bandFade + dt / BAND_FADE_S);
            updateBandWeights();
        }
        applyView();
        const frame = fillFrame(liveFrame, dt);
        sharedUniforms.uTime.value = elapsed;
        sharedUniforms.uTwinkle.value = app.settings.reduceMotion ? 0 : 1;
        sharedUniforms.uBandW.value = bandWeights;
        sharedUniforms.uFov.value = view.fov;
        sharedUniforms.uPxPerRad.value = frame.pxPerRad;
        sharedUniforms.uLimitMag.value = limitingMag(view.fov);
        sharedUniforms.uParallaxLog.value = parallaxLog(view.fov);
        sharedUniforms.uViewport.value.set(bufferW, bufferH);

        renderer.info.reset();
        stepJoining(dt);
        for (let i = 0; i < layers.length; i++) {
            if (layers[i].update) layers[i].update(frame);
        }
        admitNewObjects();

        renderer.setRenderTarget(targetA);
        renderer.clear();
        if (!skipSkyDraw) renderer.render(scene, camera);
        for (let i = 0; i < overlayPasses.length; i++) overlayPasses[i](renderer, frame, targetA);

        let input = targetA;
        for (let i = 0; i < postEffects.length; i++) {
            const effect = postEffects[i];
            if (effect.isActive && !effect.isActive(frame)) continue;
            if (!targetB) {
                targetB = makeTarget(false);    // Post effects are full-screen, so this needs no depth
                targetB.setSize(bufferW, bufferH);
            }
            const output = input === targetA ? targetB : targetA;
            effect.render(renderer, input.texture, output, frame);
            input = output;
        }

        const bloom = renderBloom(input.texture);
        composite.uniforms.tInput.value = input.texture;
        composite.uniforms.tBloom.value = bloom;
        composite.uniforms.uBloom.value = bloom ? BLOOM.strength * (1 - BLOOM.spread * 0.5) : 0;
        composite.uniforms.uDip.value = dipToBlack;
        drawFullscreen(composite, null);

        stats.calls = renderer.info.render.calls;
        stats.triangles = renderer.info.render.triangles;
        stats.points = renderer.info.render.points;
        stats.jsMs = performance.now() - started;
    }

    // ---------- The loop ----------

    const fpsDisplay = document.getElementById('fpsDisplay');
    const fpsMeter = { time: 0, frames: 0, shown: -1 };

    function meterFps(realDt) {
        fpsMeter.time += realDt;
        fpsMeter.frames += 1;
        if (fpsMeter.time < 0.5) return;
        stats.fps = fpsMeter.frames / fpsMeter.time;
        fpsMeter.time = 0;
        fpsMeter.frames = 0;
        const shown = Math.round(stats.fps);
        if (fpsDisplay && shown !== fpsMeter.shown) {
            fpsMeter.shown = shown;
            fpsDisplay.textContent = `FPS: ${shown}`;
        }
    }

    let firstFrameDrawn = null;
    const firstFrame = new Promise((resolve) => { firstFrameDrawn = resolve; });

    function loop(now) {
        rafId = 0;
        if (!running || contextLost || document.hidden) return;
        rafId = requestAnimationFrame(loop);
        stepCompileJobs();
        pollGpu();
        if (gpu.fence && gpu.waited >= GPU_MAX_BEHIND && gpu.waited < GPU_GIVE_UP_WAITING) return;
        const realDt = Math.max(0, (now - lastNow) / 1000);
        const dt = Math.min(0.1, realDt);
        lastNow = now;
        elapsed += dt;
        if (resizePending && now - lastResizeAt > 120) {
            // The drawer animates the canvas's size: reallocating every frame of that would thrash the GPU.
            resizePending = false;
            lastResizeAt = now;
            resize();
        }
        if (!chainReady) return;
        nextBakeFrame();
        lastRealDt = realDt;
        renderOnce(dt);
        if (firstFrameDrawn) {
            firstFrameDrawn();
            firstFrameDrawn = null;
        }
        fenceFrame();
        meterFps(realDt);
        measureAuto(realDt);
        checkHover(now);
    }

    function wake() {
        if (!running || contextLost || document.hidden || rafId) return;
        lastNow = performance.now();
        resetAuto();
        rafId = requestAnimationFrame(loop);
    }

    function sleep() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
    }

    // ---------- Pointer input ----------

    const dragPointers = new Map(); // pointerId -> { x, y }
    let press = null;               // The press that may yet turn out to be a click
    let pinch = null;
    const dragTrail = { x: 0, y: 0, time: 0 };
    const hover = { x: 0, y: 0, dirty: false, lastAt: 0 };

    const inputActive = () => app.view === 'sky' && !slew && !contextLost;

    function canvasPoint(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // Degrees of sky per CSS pixel at the centre of the view, so the sky stays under the pointer at any zoom
    function degPerPx() {
        return (2 * Math.tan(view.fov * RAD * 0.5)) / height / RAD;
    }

    function moveByPixels(dx, dy) {
        const deg = degPerPx();
        const stretch = 1 / Math.max(Math.cos(view.alt * RAD), 0.2); // Near the zenith, azimuth covers less sky
        const alt = Math.max(Math.min(view.alt, altFloor(view.fov)), view.alt + dy * deg);
        placeView(view.az - dx * deg * stretch, alt, view.fov);
        return { az: -dx * deg * stretch, alt: dy * deg };
    }

    function pinchState() {
        const [a, b] = [...dragPointers.values()];
        return { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    if (renderer) {
        canvas.addEventListener('pointerdown', (e) => {
            if (!inputActive() || (e.pointerType === 'mouse' && e.button !== 0)) return;
            const p = canvasPoint(e);
            dragPointers.set(e.pointerId, p);
            try {
                canvas.setPointerCapture(e.pointerId);
            } catch (err) { /* The pointer has already gone */ }
            velocity.az = 0;
            velocity.alt = 0;
            zoomAnchor = null;
            zoomGoal = view.fov;
            if (dragPointers.size === 1) {
                press = { x: p.x, y: p.y, moved: 0, touch: e.pointerType !== 'mouse' };
                dragTrail.time = performance.now();
            } else if (dragPointers.size === 2) {
                press = null; // Two fingers are never a click
                pinch = pinchState();
            }
        });

        canvas.addEventListener('pointermove', (e) => {
            const pointer = dragPointers.get(e.pointerId);
            if (!pointer) {
                if (e.pointerType === 'mouse') {
                    const p = canvasPoint(e);
                    hover.x = p.x;
                    hover.y = p.y;
                    hover.dirty = true;
                }
                return;
            }
            const p = canvasPoint(e);
            const dx = p.x - pointer.x;
            const dy = p.y - pointer.y;
            pointer.x = p.x;
            pointer.y = p.y;
            if (!inputActive()) return;
            if (dragPointers.size === 2 && pinch) {
                const now = pinchState();
                if (pinch.dist > 0 && now.dist > 0) {
                    zoomGoal = Math.max(MIN_FOV, Math.min(MAX_FOV, zoomGoal * (pinch.dist / now.dist)));
                }
                moveByPixels(now.x - pinch.x, now.y - pinch.y);
                anchorZoomAt(now.x, now.y);
                pinch = now;
                return;
            }
            if (dragPointers.size !== 1) return;
            if (press) {
                press.moved += Math.abs(dx) + Math.abs(dy);
                const slop = press.touch ? CLICK_SLOP_TOUCH : CLICK_SLOP_MOUSE;
                if (press.moved <= slop) return; // Still might be a click: hold the sky still
                press = null;
            }
            const moved = moveByPixels(dx, dy);
            // The flick's speed: an average over the last moments of the drag
            const t = performance.now();
            const gap = Math.max(1, t - dragTrail.time) / 1000;
            dragTrail.time = t;
            const mix = Math.min(1, gap / 0.05);
            velocity.az += (moved.az / gap - velocity.az) * mix;
            velocity.alt += (moved.alt / gap - velocity.alt) * mix;
        });

        const release = (e, cancelled) => {
            if (!dragPointers.has(e.pointerId)) return;
            dragPointers.delete(e.pointerId);
            if (dragPointers.size < 2) pinch = null;
            if (dragPointers.size) return;
            const held = performance.now() - dragTrail.time;
            if (held > 90 || app.settings.reduceMotion || cancelled) {
                // A pause before letting go means no flick
                velocity.az = 0;
                velocity.alt = 0;
            }
            if (press && !cancelled && inputActive()) {
                const p = canvasPoint(e);
                const code = pick(p.x, p.y, press.touch ? PICK_RADIUS_TOUCH : PICK_RADIUS_MOUSE);
                bus.emit('skyclick', { code, x: p.x, y: p.y });
            }
            press = null;
        };
        canvas.addEventListener('pointerup', (e) => release(e, false));
        canvas.addEventListener('pointercancel', (e) => release(e, true));
        canvas.addEventListener('lostpointercapture', (e) => release(e, true));

        canvas.addEventListener('pointerleave', () => { hover.dirty = false; });

        canvas.addEventListener('wheel', (e) => {
            if (app.view !== 'sky') return;
            e.preventDefault();
            if (slew) return;
            // Lines and pages are rare, but a wheel in those units should not feel dead
            const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
            // Trackpad pinches arrive as small wheel events with ctrlKey set
            const gain = e.ctrlKey ? 0.008 : 0.0012;
            const step = Math.max(-0.9, Math.min(0.9, e.deltaY * unit * gain));
            zoomGoal = Math.max(MIN_FOV, Math.min(MAX_FOV, zoomGoal * Math.exp(step)));
            const point = canvasPoint(e);
            anchorZoomAt(point.x, point.y);
            velocity.az = 0;
            velocity.alt = 0;
        }, { passive: false });
    }

    // A pointing hand over anything that can be selected, checked a few times a second at most
    function checkHover(now) {
        if (!hover.dirty || dragPointers.size || now - hover.lastAt < 120) return;
        hover.dirty = false;
        hover.lastAt = now;
        const over = inputActive() && pick(hover.x, hover.y, 12);
        canvas.style.cursor = over ? 'pointer' : '';
    }

    // ---------- Events ----------

    bus.on('band', ({ band }) => setBandTarget(band));
    bus.on('settings', ({ key }) => {
        if (key === 'quality') applyQualitySetting();
    });

    let resizePending = false;
    let lastResizeAt = 0;

    if (renderer) {
        app.qualityLevel = app.settings.quality !== 'auto' && QUALITY[app.settings.quality]
            ? app.settings.quality
            : guessStartLevel();

        window.addEventListener('resize', () => { resizePending = true; });
        if (typeof ResizeObserver === 'function') {
            new ResizeObserver(() => { resizePending = true; }).observe(canvas);
        }

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) sleep();
            else wake();
        });

        // Layers listen for 'gl-restored' to bake again whatever lived only on the GPU
        canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault(); // Without this the browser never gives the context back
            contextLost = true;
            sleep();
            gpu.fence = null;   // It went with the context
            gpu.behind = 0;
            showCanvasMessage(canvas, 'The graphics card needed a moment. The sky will come back on its own if it can; if it stays dark, reload the page.');
        });
        canvas.addEventListener('webglcontextrestored', () => {
            contextLost = false;
            hideCanvasMessage(canvas);
            readmitAll();
            compileChain();
            resize();
            bus.emit('gl-restored', {});
            wake();
        });
    }

    compileChain();
    resize();
    applyView();

    return {
        renderer,
        scene,
        camera,
        view,
        canvas,
        setView,                    // setView({ az, alt, fov }) jumps straight there
        getView: () => ({ ...view }),
        slewTo,                     // slewTo({ az, alt, fov }, { duration, pullBack, onDone })
        isSlewing: () => !!slew,
        project,                    // project(az, alt, depth = 0): where something at that depth is drawn. See core/depth.js
        projectBody,                // projectBody(body): the same, for a body at its own depth
        pick,
        bodyShows,
        addLayer(layer) { layers.push(layer); return layer; },
        getLayer: (id) => layers.find((l) => l.id === id),
        // effect = { isActive(frame)?, render(renderer, inputTexture, outputTarget, frame) }: a full-screen pass
        // run in order on the HDR buffer before bloom and tone mapping. It must fill outputTarget. (Lensing uses this.)
        addPostEffect(effect) { postEffects.push(effect); return effect; },
        // fn(renderer, frame, target): draw extra scenes into the HDR buffer after the sky (depth is still valid)
        addOverlayPass(fn) { overlayPasses.push(fn); return fn; },
        setSkyVisible(on) { skipSkyDraw = !on; },
        currentFrame,
        resize,
        renderOnce: () => { if (renderer && !contextLost) renderOnce(0.016); }, // For tests: draw one frame now
        firstFrame,                 // A promise: the sky has been drawn once. Never settles if it can't be drawn at all.
        compileInBackground,        // compileInBackground(sceneOrObject, camera?): see "Programs" above. Resolves when ready.
        // Should a layer's bake go ahead this frame? See "Bakes" above
        bakesAllowed,
        bakePace,
        stats: () => ({ ...stats, bloomLevels: bloomTargets.length, dpr, bufferW, bufferH, level: app.qualityLevel, gpuBehind: gpu.behind, joining: joining.size }),
        start() {
            if (running || !renderer) return;
            running = true;
            wake();
        },
        stop() {
            running = false;
            sleep();
        }
    };
}
