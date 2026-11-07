// The renderer, the hemisphere camera, the frame loop, picking, the graphics level and the post-processing chain.
//
// A layer is any object with these members, added with engine.addLayer():
//   id                  a short name
//   update(frame)       called once a frame before drawing; add your Object3Ds to engine.scene when created
//   picks(frame)?       extra pick candidates: [{ code, az, alt, radiusPx }]; see engine.pick
//   dispose()?          free GPU resources
//
// frame = { serial, t, dt, fov, pxPerRad, width, height, dpr, camera, band, bandW, quality, reduceMotion, view }
// The frame passed to update() is reused every frame, so keep what you need rather than keeping the object. To tell one
// frame from the next, serial goes up by one each time.
//
// Each frame: sky scene -> overlay passes -> post effects (all HDR) -> bloom -> tone map, vignette, sRGB, dither.
// If WebGL can't start, the engine still returns this API but draws nothing, and the canvas area says why.
//
// A click on the sky emits bus 'skyclick' { code, x, y } (code null for empty sky), and the second of two quick clicks on
// the same spot 'skydoubleclick' { code, x, y } as well, a tap's as a click's. On a narrow screen, where the panel a click
// opens moves the sky, a click on an object is told a moment late, in case a second one is coming.
//
// If the browser takes the graphics context away the engine emits bus 'gl-lost', and if it later gives it back,
// 'gl-restored'. Whatever a layer baked into a render target is gone by then, so a layer that bakes should listen and
// bake again.
//
// Compiling a shader can take seconds on Windows, and drawing with one that isn't finished freezes the page until it is.
// So anything added to engine.scene waits unseen until its program has compiled, then fades in by its uSkyFade: see
// "Programs" below. A layer needs to do nothing for that. Its own bakes should use compileInBackground, and
// bakesAllowed() to keep from swamping a slow GPU.

import * as THREE from 'three';
import { app, bus } from '../core/state.js';
import { BANDS, bandIndex } from '../core/bands.js';
import { azAltToVec3, DEFAULT_VIEW, MIN_FOV, MAX_FOV, limitingMag } from '../core/sky.js';
import { parallaxLog, drawMag, travelPc } from '../core/depth.js';
import { bandSkyBrightness } from '../data/band_table.js';
import { sharedUniforms, travelPoint } from './shared.js';

// A body is drawn, and can be picked, when its glow is at least this. Glow is 1 at the zoom's limiting magnitude.
export const MIN_GLOW = 0.05;

const RAD = Math.PI / 180;
const BAND_FADE_S = 0.6;
const ALT_MAX = 89.9;
const ALT_SLEW_MIN = -5;        // Slews and code may go this low; dragging stops a little sooner (altFloor)
const INERTIA_RATE = 4.2;       // How fast a flicked sky slows down (1/s)
export const ZOOM_RATE = 11;    // How fast the zoom catches up with the wheel (1/s)
const CLICK_SLOP_MOUSE = 5;     // Pointer travel (px) that turns a click into a drag
const CLICK_SLOP_TOUCH = 12;    // Fingers wobble more
const DOUBLE_MS = { mouse: 500, touch: 350 };   // A second click this soon after the first is a double-click (Windows' own
const DOUBLE_PX = { mouse: 6, touch: 30 };      // time for a mouse, a phone's for a tap), if it lands this near the first
const HOLD_CLICK_MS = 350;      // How long a click waits to see whether it's the first of two, where that's needed (see release)
const PICK_RADIUS_MOUSE = 24;
const PICK_RADIUS_TOUCH = 44;   // As generous as a touch target
const PICK_SEEN_MIN = 0.12;     // Drawn fainter than this (see seenAmount), a point can't be made out, so it can't be clicked
const PICK_FAINT_REACH = 0.25;  // The faintest that can be clicked must be clicked this near, as a share of the usual reach
const ROGUE_SEEN_SOONER = 0.25; // Magnitudes: a rogue planet can be made out this much sooner than a star (see seenAmount)
const CLUSTER_INSIDE = 0.45;    // A cluster's radius, as a share of the view's smaller side, once you are in among its stars
const REDUCED_SLEW_S = 0.3;     // Reduce motion: a quick dip to black in place of a flight
const DRAWER_RESIZE_MS = 700;   // A change of size this soon after the drawer opens or closes is the drawer's doing
const RECENTRE_AFTER_MS = 600;  // The drawer opening this soon after a slew ended moves what the slew centred...
const RECENTRE_S = 0.6;         // ...to the new middle, this gently

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

// smoothstep(0, 1, x)
function smooth01(x) {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
}

// The lowest a user's view can go at a field of view: the bottom edge sits a little below the horizon, by 8 degrees
// at most, so that ground never takes over the picture and a narrow view can still get right down to the hills
function altFloor(fov) {
    return Math.max(fov * 0.25, fov * 0.5 - 8);
}

function supportsHalfFloatTarget(renderer) {
    return renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
}

// What the canvas area says when there's no sky. The advice has to fit the case: once the graphics card has had to be
// reset under a page, Chrome refuses WebGL to that site until the browser is restarted, and reloading only shows the
// same black. So a loss is noted, and a failure to start soon after one is taken for that.
const GL_TEXT = {
    blocked: 'The browser has switched off graphics for this site after a problem with the graphics card. To bring the sky back, close the browser completely (every window) and open it again. The Go to box and the object panels still work.',
    disabled: "Graphics (WebGL) are switched off in this browser, perhaps by your school's settings, so the sky can't be drawn. The Go to box and the object panels still work.",
    old: "This browser can't draw the sky, because it doesn't have WebGL 2. An up-to-date Chrome, Edge, Firefox or Safari can. The Go to box and the object panels still work.",
    failed: "This device can't draw the sky, because WebGL 2 isn't available or is turned off. Try turning on hardware acceleration in your browser's settings, or use another browser. If the sky worked here before, close the browser completely and open it again. The Go to box and the object panels still work.",
    lost: 'The graphics card needed a moment. The sky will come back on its own if it can. The Go to box and the object panels still work.',
    gone: "The browser has stopped this page's graphics after a problem with the graphics card. To bring the sky back, close the browser completely (every window) and open it again. The Go to box and the object panels still work."
};
const LOST_KEY = 'spectro-gl-lost';
const LOST_REMEMBER_MS = 12 * 3600 * 1000;  // A failure this soon after a loss is taken to be the browser's block
const LOST_GIVE_UP_S = 10;                  // A context not back by then isn't coming back

function rememberLoss(on) {
    try {
        if (on) localStorage.setItem(LOST_KEY, String(Date.now()));
        else localStorage.removeItem(LOST_KEY);
    } catch (err) { /* Storage may be off: the message is then a little less sure */ }
}

function lostRecently() {
    try {
        const at = Number(localStorage.getItem(LOST_KEY));
        return at > 0 && Date.now() - at < LOST_REMEMBER_MS;
    } catch (err) {
        return false;
    }
}

function noContextText(status) {
    if (/caused context loss|was blocked/i.test(status)) return GL_TEXT.blocked;
    if (typeof WebGL2RenderingContext === 'undefined') return GL_TEXT.old;
    if (/enterprise policy|commandline switch/i.test(status)) return GL_TEXT.disabled;
    return lostRecently() ? GL_TEXT.blocked : GL_TEXT.failed;
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

// A wheel event as a change in the natural log of the field of view, negative going in
export function wheelZoomStep(e) {
    // Lines and pages are rare, but a wheel in those units should not feel dead
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    // Trackpad pinches arrive as small wheel events with ctrlKey set
    const gain = e.ctrlKey ? 0.008 : 0.0012;
    return Math.max(-0.9, Math.min(0.9, e.deltaY * unit * gain));
}

export function createEngine(canvas) {
    let renderer = null;
    let creationStatus = '';    // The browser's reason, if it gives one
    const onCreationError = (e) => { creationStatus = e.statusMessage || creationStatus; };
    canvas.addEventListener('webglcontextcreationerror', onCreationError);
    try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false, depth: false });
        rememberLoss(false);
    } catch (err) {
        console.warn('[spectroscopy] WebGL is not available:', err);
        showCanvasMessage(canvas, noContextText(creationStatus));
    }
    canvas.removeEventListener('webglcontextcreationerror', onCreationError);
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
    let projectionDirty = true;

    // The sky stays where it is on the page when the drawer opens or closes. The canvas changes size, and a camera kept in
    // the middle of it would shift everything by half the change, so instead the camera's axis stays where it was: it's drawn
    // lens.x, lens.y CSS px from the canvas's centre (down is positive), and lens.zoom keeps the scale when the height changes.
    // So the part of the sky still in view doesn't move. Nothing else changes: a slew still puts its target in the middle of the canvas, and closing the drawer undoes it.
    // A flight into a system eases the offset away by share, and brings it back on the way out.
    const lens = { x: 0, y: 0, zoom: 1, share: 1 };
    let placed = null;          // Where the canvas was on the page at the last resize
    let drawerChangedAt = -Infinity;
    let lastAim = null;         // What the last slew put in the middle, and when: Go to opens the drawer as its flight ends

    // Camera motion
    const velocity = { az: 0, alt: 0 };     // Degrees a second, from a flick
    let zoomGoal = view.fov;
    let zoomAnchor = null;                  // Screen point (CSS px) that stays put while zooming
    let zoomIntake = null;                  // Sees every zoom step first: see setZoomIntake
    let wheelBoost = 1;                     // How much further a wheel's step in goes: see setWheelBoost

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
        // Nothing compiles without a context. Whoever asked compiles again on 'gl-restored', as with jobs the loss cut short
        if (contextLost) return new Promise(() => {});
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

    // keepStill: the drawer has changed the canvas's size, and what's on screen should stay where it is on the page
    function resize(keepStill = false) {
        const rect = canvas.getBoundingClientRect();
        const next = {
            left: rect.left + window.scrollX,
            top: rect.top + window.scrollY,
            w: Math.max(1, Math.round(rect.width)),
            h: Math.max(1, Math.round(rect.height))
        };
        if (placed && (next.w !== width || next.h !== height || next.left !== placed.left || next.top !== placed.top)) {
            if (keepStill) holdStill(next);
            else {
                // The window itself changed: the sky scales with it, and the axis keeps its place in proportion
                lens.x *= next.w / width;
                lens.y *= next.h / height;
            }
        }
        placed = next;
        width = next.w;
        height = next.h;
        camera.aspect = width / height;
        applyProjection();
        // A flight that has only just put something in the middle meant the middle: it glides on to the new one
        // (With Reduce motion, at once: the flight has only just dipped to black, and needn't do it again)
        if (keepStill && lastAim && performance.now() - lastAim.at < RECENTRE_AFTER_MS && !slew && app.view === 'sky') {
            slewTo(lastAim.aim, { duration: app.settings.reduceMotion ? 0 : RECENTRE_S });
        }
        lastAim = null;
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

    // Moves the camera's axis to where it was on the page before the drawer moved the canvas
    function holdStill(next) {
        lens.x += placed.left - next.left + (width - next.w) / 2;
        lens.y += placed.top - next.top + (height - next.h) / 2;
        lens.zoom *= height / next.h;
        // Back to where it started, give or take a rounding error: no need to keep the error
        if (Math.abs(lens.x) < 0.01) lens.x = 0;
        if (Math.abs(lens.y) < 0.01) lens.y = 0;
        if (Math.abs(lens.zoom - 1) < 1e-9) lens.zoom = 1;
    }

    // The camera's projection, with the axis drawn where the lens says
    function applyProjection() {
        camera.zoom = lens.zoom;
        camera.updateProjectionMatrix();
        const e = camera.projectionMatrix.elements;
        e[8] = (-2 * lens.x * lens.share) / width;
        e[9] = (2 * lens.y * lens.share) / height;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        projectionDirty = false;
    }

    // A flight into a system turns the camera onto its star, and the star has to end in the middle of the canvas: so the
    // offset goes as the flight goes (share 0), and comes back as it returns (share 1)
    function setLensShare(k) {
        const share = Math.max(0, Math.min(1, k));
        if (share === lens.share) return;
        lens.share = share;
        projectionDirty = true;
    }

    // A system is drawn as the eye would see it, at a scale it works out from the field of view, so before a flight into one
    // a changed scale becomes the field of view itself. The picture doesn't change.
    function foldLensZoom() {
        if (lens.zoom === 1) return;
        view.fov = (2 * Math.atan(Math.tan(view.fov * RAD * 0.5) / lens.zoom)) / RAD;
        zoomGoal = view.fov;
        lens.zoom = 1;
        projectionDirty = true;
        applyView();
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
        if (view.fov !== lastCameraFov || projectionDirty) {
            lastCameraFov = view.fov;
            camera.fov = view.fov;
            applyProjection();
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

    // For a flight only, which is free to go narrower than a student's zoom can: the system view puts the view back after
    function flyView(az, alt, fov) {
        view.az = ((az % 360) + 360) % 360;
        view.alt = alt;
        view.fov = fov;
        applyView();
        zoomGoal = view.fov;
        zoomAnchor = null;
    }

    // Fly the camera along the shortest way round. opts: { duration (s), pullBack, glide, onDone }. Duration 0 jumps.
    // pullBack widens the view on the way, more for a long flight, so the sky doesn't whip past. glide: a target already on
    // screen slides from where it is to the middle in a straight line as the zoom goes, so a zoom right in on something
    // never swings it off the screen on the way. Reduce motion replaces the flight with a quick dip to black.
    function slewTo(target, opts = {}) {
        velocity.az = 0;
        velocity.alt = 0;
        zoomAnchor = null;
        const duration = renderer && !contextLost ? opts.duration ?? 1.5 : 0; // With no frames to fly through, it only has to get there
        const toFov = target.fov ?? view.fov;
        // The target goes in the middle of the canvas, wherever the lens has the camera's axis, and it's worked out again as
        // the slew goes, as the drawer opening for the same click can move the axis meanwhile. opts.axis: it's the axis's own.
        let aim = null;
        let to = { az: target.az ?? view.az, alt: target.alt ?? view.alt };
        // Near the zenith, an axis off the middle may not be able to bring the target to the middle at all: the camera would
        // have to tip over the top. Then the axis goes back to the middle on the way, which nobody sees while the sky moves.
        let toCentre = null;
        if (!opts.axis) {
            const centre = centreDir();
            aim = { az: target.az ?? centre.az, alt: target.alt ?? centre.alt };
            if (lensOffset() && !middleReaches(aim, toFov)) toCentre = { x: lens.x, y: lens.y, k: 0 };
            to = axisFor(aim, toFov);
        }
        if (duration <= 0) {
            if (toCentre) {
                moveLens(toCentre, 1);
                to = axisFor(aim, toFov);
            }
            placeView(to.az, to.alt, toFov);
            zoomGoal = view.fov;
            slew = null;
            dipToBlack = 1;
            if (opts.onDone) opts.onDone();
            return;
        }
        if (app.settings.reduceMotion) {
            slew = { dip: true, jumped: false, aim, toCentre, toAz: to.az, toAlt: to.alt, toFov, t: 0, duration: REDUCED_SLEW_S, onDone: opts.onDone };
            return;
        }
        const dAz = ((((to.az - view.az + 540) % 360) + 360) % 360) - 180;
        const dAlt = to.alt - view.alt;
        let midFov = null;
        if (opts.pullBack) {
            const across = Math.hypot(dAz * Math.cos(((view.alt + to.alt) / 2) * RAD), dAlt);
            midFov = Math.min(MAX_FOV, Math.max(Math.max(view.fov, toFov) * 1.25, Math.min(70, across * 0.8)));
        }
        let glide = null;
        if (aim && opts.glide) {
            const p = project(aim.az, aim.alt);
            if (p && p.onScreen) glide = { x: p.x - width / 2, y: p.y - height / 2 };
        }
        slew = { from: { ...view }, aim, toCentre, dAz, dAlt, toFov, midFov: glide ? null : midFov, glide, t: 0, duration, onDone: opts.onDone };
    }

    // Can the middle of the canvas be brought onto this direction, with the lens as it is? See rayThrough and solveAxis.
    function middleReaches(aim, fov) {
        const r = rayThrough(width / 2, height / 2, fov);
        if (Math.abs(Math.sin(aim.alt * RAD)) > Math.hypot(r.y, r.f) - 1e-9) return false;
        const axis = axisPutting(aim.az, aim.alt, width / 2, height / 2, fov);
        return axis.alt <= ALT_MAX && axis.alt >= ALT_SLEW_MIN;
    }

    // Takes the lens's offset back towards none, to k of the way: by steps, so that the drawer can still move it meanwhile
    function moveLens(state, k) {
        lens.x -= state.x * (k - state.k);
        lens.y -= state.y * (k - state.k);
        state.k = k;
        if (k >= 1) {
            if (Math.abs(lens.x) < 0.01) lens.x = 0;
            if (Math.abs(lens.y) < 0.01) lens.y = 0;
        }
        projectionDirty = true;
    }

    // A glide's view at k of the way: the zoom eases in log steps as any flight's does, and the target sits on the straight
    // line from where it was to the middle, solved from scratch each frame so that nothing builds up
    function glideView(k) {
        const { from, toFov, glide, aim } = slew;
        if (k >= 1) return { ...axisFor(aim, toFov), fov: toFov };
        const fov = from.fov * (toFov / from.fov) ** k;
        const axis = axisPutting(aim.az, aim.alt, width / 2 + glide.x * (1 - k), height / 2 + glide.y * (1 - k), fov);
        return { az: axis.az, alt: axis.alt, fov };
    }

    // Answers a question about another view without drawing it: the camera looks from there while fn runs, and then every
    // digit of this view comes back. For working out what a zoom would find before it gets there.
    function atView(next, fn) {
        const was = { az: view.az, alt: view.alt, fov: view.fov, goal: zoomGoal, anchor: zoomAnchor };
        try {
            placeView(next.az, next.alt, next.fov);
            return fn();
        } finally {
            view.az = was.az;
            view.alt = was.alt;
            view.fov = was.fov;
            zoomGoal = was.goal;
            zoomAnchor = was.anchor;
            applyView();
        }
    }

    // The camera's axis for a direction that is to be in the middle of the canvas
    function axisFor(aim, fov) {
        return lensOffset() ? axisPutting(aim.az, aim.alt, width / 2, height / 2, fov) : aim;
    }

    function stepSlew(dt) {
        if (!slew) return;
        slew.t = Math.min(1, slew.t + dt / slew.duration);
        if (slew.dip) {
            dipToBlack = Math.abs(1 - slew.t * 2);
            if (slew.t >= 0.5 && !slew.jumped) {
                slew.jumped = true;
                if (slew.toCentre) moveLens(slew.toCentre, 1);
                const to = slew.aim ? axisFor(slew.aim, slew.toFov) : { az: slew.toAz, alt: slew.toAlt };
                placeView(to.az, to.alt, slew.toFov);
                zoomGoal = view.fov;
            }
        } else if (slew.glide) {
            if (slew.toCentre) moveLens(slew.toCentre, easeInOut(slew.t));
            const to = glideView(easeInOut(slew.t));
            placeView(to.az, to.alt, to.fov);
        } else {
            const k = easeInOut(slew.t);
            const { from, midFov, toFov } = slew;
            if (slew.toCentre) moveLens(slew.toCentre, k);
            if (slew.aim) {
                const to = axisFor(slew.aim, toFov);
                slew.dAz = ((((to.az - from.az + 540) % 360) + 360) % 360) - 180;
                slew.dAlt = to.alt - from.alt;
            }
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
            lastAim = slew.aim ? { aim: slew.aim, fov: slew.toFov, at: performance.now() } : null;
            slew = null;
            dipToBlack = 1;
            zoomGoal = view.fov;
            if (done) done();
        }
    }

    // The ray through a screen point, in camera space at a field of view: x right, y up, f forward, length 1
    const ray = { x: 0, y: 0, f: 1 };
    function rayThrough(px, py, fov) {
        const t = Math.tan(fov * RAD * 0.5) / lens.zoom;
        const x = ((px / width) * 2 - 1 - (2 * lens.x * lens.share) / width) * t * (width / height);
        const y = (1 - (py / height) * 2 + (2 * lens.y * lens.share) / height) * t;
        const length = Math.hypot(x, y, 1);
        ray.x = x / length;
        ray.y = y / length;
        ray.f = 1 / length;
        return ray;
    }

    function lensOffset() {
        return lens.share > 0 && (lens.x !== 0 || lens.y !== 0);
    }

    // The camera's axis that puts a direction on the sky (x, y, z as azAltToVec3 has it) under a screen point, solved from
    // scratch so that errors can't build up over the steps of a zoom
    function solveAxis(skyX, skyY, skyZ, px, py, fov, altNow) {
        const r = rayThrough(px, py, fov);
        const tilt = Math.atan2(r.y, r.f);
        const reach = Math.asin(Math.max(-1, Math.min(1, skyY / Math.hypot(r.y, r.f))));
        // Two pitches put the direction at the right height: the one nearer the view, past the zenith or not
        const near = reach - tilt;
        const far = Math.PI - reach - tilt;
        const p = Math.abs(far - altNow * RAD) < Math.abs(near - altNow * RAD) ? far : near;
        const back = r.y * Math.sin(p) - r.f * Math.cos(p);
        return { az: (Math.atan2(skyX, -skyZ) - Math.atan2(r.x, -back)) / RAD, alt: p / RAD };
    }

    // The same for an az and alt: what to slew to so that they end up at that point
    function axisPutting(az, alt, px, py, fov = view.fov) {
        const v = azAltToVec3(az, alt);
        const axis = solveAxis(v[0], v[1], v[2], px, py, fov, alt);
        return { az: ((axis.az % 360) + 360) % 360, alt: axis.alt };
    }

    // The direction in the middle of the canvas, which is where the view looks as far as anyone else is concerned
    function centreDir() {
        if (!lensOffset()) return { az: view.az, alt: view.alt };
        const r = rayThrough(width / 2, height / 2, view.fov);
        const p = view.alt * RAD;
        const a = view.az * RAD;
        const back = r.y * Math.sin(p) - r.f * Math.cos(p);
        const x = r.x * Math.cos(a) - back * Math.sin(a);
        const z = r.x * Math.sin(a) + back * Math.cos(a);
        const up = r.y * Math.cos(p) + r.f * Math.sin(p);
        let az = Math.atan2(x, -z) / RAD;
        if (az < 0) az += 360;
        return { az, alt: Math.asin(Math.max(-1, Math.min(1, up))) / RAD };
    }

    // How far from the axis, in degrees, the canvas reaches: a corner, with the lens's offset
    function reachDeg(fov = view.fov) {
        const offX = Math.abs(lens.x * lens.share);
        const offY = Math.abs(lens.y * lens.share);
        const tanPerPx = Math.tan(fov * RAD * 0.5) / (lens.zoom * height * 0.5);
        return Math.atan(Math.hypot(width / 2 + offX, height / 2 + offY) * tanPerPx) / RAD + 1;
    }

    // The zoom's anchor: a screen point, and the direction in the sky under it when the zoom began. What you point at is
    // what you zoom into.
    function anchorZoomAt(px, py) {
        const r = rayThrough(px, py, view.fov);
        const p = view.alt * RAD;
        const a = view.az * RAD;
        const up = r.y * Math.cos(p) + r.f * Math.sin(p);
        const back = r.y * Math.sin(p) - r.f * Math.cos(p);
        zoomAnchor = {
            x: px,
            y: py,
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
            const a = zoomAnchor;
            ({ az, alt } = solveAxis(a.skyX, a.skyY, a.skyZ, a.x, a.y, next, alt));
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

    // Screen position (CSS pixels from the canvas's top-left) of a sky direction; null when behind the camera. pc, a thing's
    // distance (core/depth.js travelPc), puts it where it's drawn on a flight into a system, and near says how much nearer
    // the flight has brought it. Without one, or at rest, it's where Earth sees it, as the dome is.
    const tmp = new THREE.Vector3();
    function project(az, alt, pc = 0) {
        const v = azAltToVec3(az, alt);
        tmp.set(v[0] * 1000, v[1] * 1000, v[2] * 1000);
        const near = pc ? travelPoint(tmp, pc) : 1;
        tmp.project(camera);
        if (tmp.z > 1 || tmp.z < -1) return null;
        return { x: (tmp.x * 0.5 + 0.5) * width, y: (-tmp.y * 0.5 + 0.5) * height, onScreen: Math.abs(tmp.x) <= 1 && Math.abs(tmp.y) <= 1, near };
    }

    // Where a body is drawn
    function projectBody(body) {
        return project(body.sky.az, body.sky.alt, travelPc(body));
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

    // How well a body can be seen, 0 to 1, as its layer draws it. A point fades in from nothing over its first two magnitudes
    // (stars.js), and dims towards the horizon; a comet in visible light comes in as the zoom reaches its magnitude
    // (comets.js). What can barely be seen still answers a click, but only right on it, and what can't be seen doesn't.
    function seenAmount(body, glow, lim) {
        if (body.comet && app.band === 'visible') return smooth01((lim - drawMag(body) + 0.6) / 1.2);
        const m = 1.0857 * Math.log(Math.max(glow, MIN_GLOW)) + 3.25;
        // A rogue planet's own layer (rogue_planets.js) draws a faint one as a warm haze, plainer to see than stars.js's
        // point of the same glow, and doesn't dim it towards the horizon
        if (body.kind === 'rogue_planet') return smooth01((m + ROGUE_SEEN_SOONER) / 2.2);
        const up = Math.max(Math.sin(body.sky.alt * RAD), 0);
        return smooth01(m / 2.2) * Math.exp(-0.05 / (up + 0.05));
    }

    // The code of the object nearest a screen position (CSS pixels), or null. Bodies must show in the current band
    // at this zoom. Layers can add candidates (cluster members, say) through layer.picks(frame). skip(code, radiusPx)
    // can rule things out, to ask what else is near a thing.
    function pick(x, y, maxPx = PICK_RADIUS_MOUSE, skip = null) {
        if (app.view !== 'sky') return null;
        applyView();
        let best = null;
        let bestScore = Infinity;
        const lim = limitingMag(view.fov);
        const pxPerDeg = (height * 0.5 * RAD * lens.zoom) / Math.tan(view.fov * RAD * 0.5);
        // A click or a hover, as against a question about what's round a thing: only what can be seen
        const byEye = maxPx <= PICK_RADIUS_TOUCH;
        const consider = (code, az, alt, radiusPx, bonusPx, reach = maxPx) => {
            const p = project(az, alt);
            // Something with a size can be on show while its middle is off the edge of the view
            if (!p || (!p.onScreen && !radiusPx)) return;
            const dist = Math.hypot(p.x - x, p.y - y);
            if (dist > reach + radiusPx || (skip && skip(code, radiusPx))) return;
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
                    const radiusPx = extendedRadiusDeg(body) * pxPerDeg;
                    // Inside an open cluster the dark between its stars is just sky: only the stars answer a click
                    if (body.cluster && body.cluster.type === 'open' && radiusPx > CLUSTER_INSIDE * Math.min(width, height)) continue;
                    let reach = maxPx;
                    if (byEye && (radiusPx <= 12 || body.comet)) {
                        const seen = seenAmount(body, bodyGlow(body, app.band) * zoomGain(lim), lim);
                        if (seen < PICK_SEEN_MIN) continue;
                        reach = maxPx * (PICK_FAINT_REACH + (1 - PICK_FAINT_REACH) * smooth01((seen - PICK_SEEN_MIN) * 2));
                    }
                    consider(body.code, body.sky.az, body.sky.alt, radiusPx, brightnessBonusPx(body, lim), reach);
                }
            }
        }
        const frame = currentFrame();
        layers.forEach((layer) => {
            if (!layer.picks) return;
            (layer.picks(frame) || []).forEach((c) => consider(c.code, c.az, c.alt, c.radiusPx || 0, 0));
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
        frame.pxPerRad = (height * dpr * 0.5 * lens.zoom) / Math.tan(view.fov * RAD * 0.5);
        frame.width = width;
        frame.height = height;
        // Where the camera's axis is drawn, in NDC before depth (see the lens), and how much the scale is changed from the
        // field of view's. Only a layer that works out rays from the screen itself needs these.
        frame.shiftX = (2 * lens.x * lens.share) / width;
        frame.shiftY = (-2 * lens.y * lens.share) / height;
        frame.zoom = lens.zoom;
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
        // Before the system view takes the view it will come back to
        if (app.view !== 'sky' && lens.zoom !== 1) foldLensZoom();
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
        // Just after the drawer opens or closes, look every frame: the size changes in one step, and the frame it changes in
        // should already be drawn at the new size, or the old picture shows stretched for a moment. The canvas can also move
        // first and change size a frame later (a closing drawer's column widens before the sky's ratio follows, so for a
        // frame the old width sits in the middle of the new room): that frame is drawn where it now is, too.
        const drawerResize = now - drawerChangedAt < DRAWER_RESIZE_MS;
        if (drawerResize && !resizePending) {
            const rect = canvas.getBoundingClientRect();
            if (Math.round(rect.width) !== width || Math.round(rect.height) !== height) resizePending = true;
            else if (placed && (Math.abs(rect.left + window.scrollX - placed.left) > 0.5 || Math.abs(rect.top + window.scrollY - placed.top) > 0.5)) resizePending = true;
        }
        if (resizePending && (drawerResize || now - lastResizeAt > 120)) {
            // Dragging a window's edge resizes many times over: reallocating every frame of that would thrash the GPU
            resizePending = false;
            lastResizeAt = now;
            resize(drawerResize);
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
    let lastClick = null;           // The click before, which another may make a double-click: { at, x, y, how, code }
    let pinch = null;
    const dragTrail = { x: 0, y: 0, time: 0 };
    const hover = { x: 0, y: 0, dirty: false, lastAt: 0 };

    const inputActive = () => app.view === 'sky' && !slew && !contextLost;

    // Two clicks in quick succession on the same spot are a double-click, and a third starts afresh. The same spot on the
    // page, not on the canvas: the panel the first click opens can move the canvas while the sky holds still.
    function isSecondClick(e, touch) {
        const first = lastClick;
        const how = touch ? 'touch' : 'mouse';
        return !!first && first.how === how && performance.now() - first.at <= DOUBLE_MS[how]
            && Math.hypot(e.clientX - first.x, e.clientY - first.y) <= DOUBLE_PX[how];
    }

    // A click held back for a moment (see release), now told
    let heldClick = null;
    function releaseHeldClick() {
        if (!heldClick) return;
        const { click, timer } = heldClick;
        heldClick = null;
        clearTimeout(timer);
        bus.emit('skyclick', click);
    }

    // The panel a click opens is a sheet under the sky on a narrow screen, which shrinks the sky and scrolls the page
    function clicksMoveTheSky() {
        return !!app.drawer && !app.drawer.isOpen() && document.body.classList.contains('sim-panel-sheet');
    }

    function canvasPoint(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // Degrees of sky per CSS pixel at the centre of the view, so the sky stays under the pointer at any zoom
    function degPerPx() {
        return (2 * Math.tan(view.fov * RAD * 0.5)) / (height * lens.zoom) / RAD;
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
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            // The first click can set the sky moving, to bring what it chose out from under a bar or the panel. That doesn't
            // stop a second click from making it a double-click, though it stops anything else.
            const second = !inputActive() && !dragPointers.size && app.view === 'sky' && !contextLost && isSecondClick(e, e.pointerType !== 'mouse');
            // Anything but the second click of a double-click lets a click held back go at once
            if (heldClick && (dragPointers.size || !isSecondClick(e, e.pointerType !== 'mouse'))) releaseHeldClick();
            if (!inputActive() && !second) return;
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
                press = { x: p.x, y: p.y, moved: 0, touch: e.pointerType !== 'mouse', second };
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
                    const ratio = pinch.dist / now.dist;
                    if (zoomIntake && zoomIntake(Math.log(ratio), now, 'touch')) {
                        if (pinch) pinch = now;
                        return;
                    }
                    zoomGoal = Math.max(MIN_FOV, Math.min(MAX_FOV, zoomGoal * ratio));
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
                releaseHeldClick();
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
            if (press && !cancelled && press.second) {
                // Pressed while the sky was moving: it can only be the second click of a double-click, on what the first found
                const p = canvasPoint(e);
                const first = lastClick;
                const double = isSecondClick(e, press.touch);
                lastClick = null;
                if (double && first.code) bus.emit('skydoubleclick', { code: first.code, x: p.x, y: p.y });
            } else if (press && !cancelled && inputActive()) {
                const p = canvasPoint(e);
                const code = pick(p.x, p.y, press.touch ? PICK_RADIUS_TOUCH : PICK_RADIUS_MOUSE);
                const first = lastClick;
                const double = isSecondClick(e, press.touch);
                const how = press.touch ? 'touch' : 'mouse';
                lastClick = double ? null : { at: performance.now(), x: e.clientX, y: e.clientY, how, code };
                const click = { code, x: p.x, y: p.y };
                if (double) {
                    // A held first click is the one to go with: nothing has moved since it
                    if (heldClick) releaseHeldClick();
                    else bus.emit('skyclick', click);
                    // The first click's find stands: the second can just miss it, or the sky may have moved it from under the pointer
                    if (first.code || code) bus.emit('skydoubleclick', { code: first.code || code, x: p.x, y: p.y });
                } else if (code && clicksMoveTheSky()) {
                    // On a narrow screen the panel this opens comes up under the sky and moves it, so the second click of a
                    // double-click would land somewhere else: it waits a moment to see whether one comes
                    releaseHeldClick();
                    heldClick = { click, timer: setTimeout(releaseHeldClick, HOLD_CLICK_MS) };
                } else {
                    releaseHeldClick();
                    bus.emit('skyclick', click);
                }
            } else {
                lastClick = null;   // A drag or a pinch in between: not a double-click
                releaseHeldClick();
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
            if (slew || contextLost) return;
            const step = wheelZoomStep(e);
            const point = canvasPoint(e);
            if (zoomIntake && zoomIntake(step, point, 'wheel')) return;
            zoomGoal = Math.max(MIN_FOV, Math.min(MAX_FOV, zoomGoal * Math.exp(step * (step < 0 ? wheelBoost : 1))));
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
    bus.on('drawer', () => { drawerChangedAt = performance.now(); });
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
            new ResizeObserver(() => {
                resizePending = true;
                // The drawer's doing: this runs after the frame was drawn and before it's shown, so draw it again at the new
                // size now, or the old picture shows stretched over the new box for a frame
                if (running && chainReady && !contextLost && !document.hidden && performance.now() - drawerChangedAt < DRAWER_RESIZE_MS) {
                    resizePending = false;
                    lastResizeAt = performance.now();
                    resize(true);
                    renderOnce(0);
                }
            }).observe(canvas);
        }

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) sleep();
            else wake();
        });

        // Layers listen for 'gl-restored' to bake again whatever lived only on the GPU. Without frames nothing can fly, so a
        // flight under way lands at once, and 'gl-lost' tells the system view to do the same: Go to and the panels go on
        // working, and the scene they describe is the one that comes back.
        let giveUpTimer = 0;
        canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault(); // Without this the browser never gives the context back
            contextLost = true;
            sleep();
            gpu.fence = null;   // It went with the context
            gpu.behind = 0;
            rememberLoss(true);
            showCanvasMessage(canvas, GL_TEXT.lost);
            clearTimeout(giveUpTimer);
            giveUpTimer = setTimeout(() => { if (contextLost) showCanvasMessage(canvas, GL_TEXT.gone); }, LOST_GIVE_UP_S * 1000);
            if (slew) slewTo({ az: slew.toAz ?? slew.from.az + slew.dAz, alt: slew.toAlt ?? slew.from.alt + slew.dAlt, fov: slew.toFov }, { duration: 0, onDone: slew.onDone });
            zoomGoal = view.fov;
            zoomAnchor = null;
            document.body.classList.add('spectro-no-sky');  // Hides Enter system, which can't work until it's back
            bus.emit('gl-lost', {});
        });
        canvas.addEventListener('webglcontextrestored', () => {
            contextLost = false;
            clearTimeout(giveUpTimer);
            rememberLoss(false);
            document.body.classList.remove('spectro-no-sky');
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
        flyView,
        getView: () => ({ ...view }),
        slewTo,                     // slewTo({ az, alt, fov }, { duration, pullBack, glide, onDone })
        isSlewing: () => !!slew,
        atView,                     // atView({ az, alt, fov }, fn): fn's answer from that view, which is never drawn
        // setZoomIntake(fn): fn(step, point, kind) sees every zoom step before the sky does, and returns true to keep it.
        // step is the change in the natural log of the field of view, negative going in. point is in CSS pixels, or null for
        // the centre of the view. kind is 'wheel', 'touch' or 'key'. The system view uses this to carry a zoom into a star.
        setZoomIntake(fn) { zoomIntake = fn; },
        // With only one thing in play and a long way down to go, a wheel covers the distance in fewer notches
        setWheelBoost(k) { wheelBoost = k; },
        offerZoom: (step, point, kind) => !contextLost && !!(zoomIntake && zoomIntake(step, point, kind)),
        // What's left of the last zoom step, as a change in log field of view, and the sky stops there
        takeZoomLeft() {
            const left = Math.log(zoomGoal / view.fov);
            zoomGoal = view.fov;
            zoomAnchor = null;
            return left;
        },
        zoomIsEasing: () => Math.abs(Math.log(zoomGoal / view.fov)) > 1e-4,
        // Zooms at once by a step (as for the wheel), keeping still what's at a screen point: the middle of the canvas by
        // default
        zoomAt(step, x = width / 2, y = height / 2) {
            if (slew) return;
            anchorZoomAt(x, y);
            setFovAnchored(Math.max(MIN_FOV, Math.min(MAX_FOV, view.fov * Math.exp(step))));
            zoomGoal = view.fov;
            zoomAnchor = null;
        },
        // True while one finger or the mouse is on the sky: a drag, or a click still to come
        isPressed: () => dragPointers.size === 1,
        // Two fingers can go from the sky to a system without lifting: whoever has them hands them on.
        // In and out are { id, x, y } in CSS pixels from the canvas's corner.
        takePointers() {
            const out = [...dragPointers].map(([id, p]) => ({ id, x: p.x, y: p.y }));
            dragPointers.clear();
            pinch = null;
            press = null;
            return out;
        },
        givePointers(list) {
            dragPointers.clear();
            list.forEach((p) => dragPointers.set(p.id, { x: p.x, y: p.y }));
            press = null;
            velocity.az = 0;
            velocity.alt = 0;
            pinch = dragPointers.size === 2 ? pinchState() : null;
        },
        // How a body's glow stands at this zoom: 1 is when it comes in at the limiting magnitude, MIN_GLOW when it first shows
        glowOf: (body) => bodyGlow(body, app.band) * zoomGain(limitingMag(view.fov)),
        project,                    // project(az, alt, pc?): where something is drawn, on a flight too if given its distance
        projectBody,                // projectBody(body): the same, for a body
        // The view's own az and alt are the camera's axis, which the drawer can leave off the middle of the canvas (see the
        // lens). centreDir() is what's in the middle; axisPutting(az, alt, x, y, fov?) is the view that puts a direction at
        // a screen point; reachDeg(fov?) is how far from the axis the canvas reaches.
        centreDir,
        axisPutting,
        reachDeg,
        setLensShare,
        lensState: () => ({ ...lens }),
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
        isContextLost: () => contextLost,   // The browser has taken the graphics away for now: see 'gl-lost' and 'gl-restored'
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
