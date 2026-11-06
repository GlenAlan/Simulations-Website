// FOUNDATION ENGINE, owned by the sky-core track, which may rewrite the inside but keeps this API.
// The renderer, the hemisphere camera, the frame loop, picking and the post-processing chain.
//
// A layer is any object with these members, added with engine.addLayer():
//   id                  a short name
//   update(frame)       called once a frame before drawing; add your Object3Ds to engine.scene when created
//   picks(frame)?       extra pick candidates: [{ code, az, alt, radiusPx }]; see engine.pick
//   dispose()?          free GPU resources
//
// frame = { t, dt, fov, pxPerRad, width, height, dpr, camera, band, bandW, quality, reduceMotion, view }

import * as THREE from 'three';
import { app, bus } from '../core/state.js';
import { BANDS, bandIndex } from '../core/bands.js';
import { azAltToVec3, DEFAULT_VIEW, MIN_FOV, MAX_FOV, limitingMag } from '../core/sky.js';
import { sharedUniforms } from './shared.js';

const RAD = Math.PI / 180;
const BAND_FADE_S = 0.6;

function easeInOut(x) {
    return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

export function createEngine(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
    renderer.setClearColor(0x000000, 1);
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // The final pass converts to sRGB itself

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
    let lastNow = performance.now();
    let elapsed = 0;
    let bandFrom = bandIndex(app.band);
    let bandTo = bandFrom;
    let bandFade = 1;
    let running = false;
    let skipSkyDraw = false;

    const makeTarget = () => new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        depthBuffer: true,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter
    });
    let targetA = makeTarget();
    let targetB = makeTarget();

    // Final pass: tone map the HDR buffer to the screen (ACES-like curve, then sRGB)
    const blitScene = new THREE.Scene();
    const blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const blitMaterial = new THREE.ShaderMaterial({
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        uniforms: { tInput: { value: null }, uExposure: { value: 1 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: /* glsl */`
            uniform sampler2D tInput;
            uniform float uExposure;
            varying vec2 vUv;
            vec3 aces(vec3 x) {
                return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
            }
            void main() {
                vec3 c = aces(texture2D(tInput, vUv).rgb * uExposure);
                gl_FragColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
            }`
    });
    blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMaterial));

    function resize() {
        const rect = canvas.getBoundingClientRect();
        width = Math.max(1, Math.round(rect.width));
        height = Math.max(1, Math.round(rect.height));
        dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        renderer.setPixelRatio(dpr);
        renderer.setSize(width, height, false);
        targetA.setSize(Math.round(width * dpr), Math.round(height * dpr));
        targetB.setSize(Math.round(width * dpr), Math.round(height * dpr));
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }

    function applyView() {
        camera.rotation.y = -view.az * RAD;
        camera.rotation.x = view.alt * RAD;
        camera.fov = view.fov;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
    }

    function setView(next) {
        if (next.az !== undefined) view.az = ((next.az % 360) + 360) % 360;
        if (next.alt !== undefined) view.alt = Math.max(-5, Math.min(89.9, next.alt));
        if (next.fov !== undefined) view.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, next.fov));
        applyView();
    }

    // Fly the camera along the shortest path. opts: { duration (s), onDone }. Reduce motion jumps instead.
    function slewTo(target, opts = {}) {
        const duration = app.settings.reduceMotion ? 0 : (opts.duration ?? 1.5);
        if (duration <= 0) {
            setView(target);
            slew = null;
            if (opts.onDone) opts.onDone();
            return;
        }
        const dAz = ((((target.az ?? view.az) - view.az + 540) % 360) - 180);
        slew = {
            from: { ...view },
            dAz,
            toAlt: target.alt ?? view.alt,
            toFov: target.fov ?? view.fov,
            midFov: opts.pullBack ? Math.min(MAX_FOV, Math.max(view.fov, target.fov ?? view.fov) * 1.25) : null,
            t: 0,
            duration,
            onDone: opts.onDone
        };
    }

    function stepSlew(dt) {
        if (!slew) return;
        slew.t = Math.min(1, slew.t + dt / slew.duration);
        const k = easeInOut(slew.t);
        const fov = slew.midFov
            ? (slew.t < 0.5 ? slew.from.fov + (slew.midFov - slew.from.fov) * easeInOut(slew.t * 2)
                : slew.midFov + (slew.toFov - slew.midFov) * easeInOut(slew.t * 2 - 1))
            : slew.from.fov + (slew.toFov - slew.from.fov) * k;
        setView({ az: slew.from.az + slew.dAz * k, alt: slew.from.alt + (slew.toAlt - slew.from.alt) * k, fov });
        if (slew.t >= 1) {
            const done = slew.onDone;
            slew = null;
            if (done) done();
        }
    }

    // Screen position (CSS pixels from the canvas's top-left) of a sky direction; null when behind the camera.
    const tmp = new THREE.Vector3();
    function project(az, alt) {
        const v = azAltToVec3(az, alt);
        tmp.set(v[0] * 1000, v[1] * 1000, v[2] * 1000).project(camera);
        if (tmp.z > 1 || tmp.z < -1) return null;
        return { x: (tmp.x * 0.5 + 0.5) * width, y: (-tmp.y * 0.5 + 0.5) * height, onScreen: Math.abs(tmp.x) <= 1 && Math.abs(tmp.y) <= 1 };
    }

    // The code of the object nearest a screen position (CSS pixels), or null. Bodies must show in the
    // current band at this zoom. Layers can add candidates (cluster members, say) through layer.picks(frame).
    function pick(x, y, maxPx = 24) {
        const frame = currentFrame();
        let best = null;
        let bestD = maxPx;
        const lim = limitingMag(view.fov);
        const consider = (code, az, alt, radiusPx) => {
            const p = project(az, alt);
            if (!p || !p.onScreen) return;
            const d = Math.hypot(p.x - x, p.y - y) - radiusPx;
            if (d < bestD) {
                bestD = d;
                best = code;
            }
        };
        if (app.universe) {
            app.universe.bodies.forEach((body) => {
                if (!bodyShows(body, lim)) return;
                consider(body.code, body.sky.az, body.sky.alt, 0);
            });
        }
        layers.forEach((layer) => {
            if (!layer.picks) return;
            (layer.picks(frame) || []).forEach((c) => consider(c.code, c.az, c.alt, c.radiusPx || 0));
        });
        return best;
    }

    // Is this body drawn at all right now? Used for picking; the layers apply the same rules in their shaders.
    function bodyShows(body, lim = limitingMag(view.fov)) {
        if (body.kind === 'home_planet' && !app.layers.homePlanets) return false;
        const strength = body.bands[app.band] || 0;
        if (strength <= 0.01) return false;
        if (app.band !== 'visible') return true;
        return body.brightness.mag <= lim;
    }

    function setBandTarget(band) {
        const weights = currentBandWeights();
        bandFrom = weights.indexOf(Math.max(...weights));
        bandTo = bandIndex(band);
        bandFade = app.settings.reduceMotion ? 1 : 0;
    }

    function currentBandWeights() {
        const k = easeInOut(Math.min(1, bandFade));
        return BANDS.map((_, i) => (i === bandTo ? k : 0) + (i === bandFrom ? 1 - k : 0));
    }

    function currentFrame() {
        return {
            t: elapsed,
            dt: 0,
            fov: view.fov,
            pxPerRad: (height * dpr * 0.5) / Math.tan(view.fov * RAD * 0.5),
            width,
            height,
            dpr,
            camera,
            band: app.band,
            bandW: currentBandWeights(),
            quality: app.qualityLevel,
            reduceMotion: app.settings.reduceMotion,
            view: app.view
        };
    }

    function renderOnce(dt) {
        stepSlew(dt);
        if (bandFade < 1) bandFade = Math.min(1, bandFade + dt / BAND_FADE_S);
        applyView();
        const frame = currentFrame();
        frame.dt = dt;
        sharedUniforms.uTime.value = elapsed;
        sharedUniforms.uTwinkle.value = app.settings.reduceMotion ? 0 : 1;
        sharedUniforms.uBandW.value = frame.bandW;
        sharedUniforms.uFov.value = view.fov;
        sharedUniforms.uPxPerRad.value = frame.pxPerRad;
        sharedUniforms.uLimitMag.value = limitingMag(view.fov);
        sharedUniforms.uViewport.value.set(width * dpr, height * dpr);

        layers.forEach((layer) => { if (layer.update) layer.update(frame); });

        renderer.setRenderTarget(targetA);
        renderer.clear();
        if (!skipSkyDraw) renderer.render(scene, camera);
        overlayPasses.forEach((pass) => pass(renderer, frame, targetA));

        let input = targetA;
        let output = targetB;
        postEffects.forEach((effect) => {
            if (effect.isActive && !effect.isActive(frame)) return;
            effect.render(renderer, input.texture, output, frame);
            [input, output] = [output, input];
        });

        renderer.setRenderTarget(null);
        blitMaterial.uniforms.tInput.value = input.texture;
        renderer.render(blitScene, blitCamera);
    }

    function loop(now) {
        if (!running) return;
        requestAnimationFrame(loop);
        const dt = Math.min(0.1, (now - lastNow) / 1000);
        lastNow = now;
        elapsed += dt;
        renderOnce(dt);
    }

    // Basic drag and zoom; the sky-core track adds inertia, pinch and keyboard
    let dragging = null;
    canvas.addEventListener('pointerdown', (e) => {
        dragging = { x: e.clientX, y: e.clientY, moved: 0 };
        canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - dragging.x;
        const dy = e.clientY - dragging.y;
        dragging.x = e.clientX;
        dragging.y = e.clientY;
        dragging.moved += Math.abs(dx) + Math.abs(dy);
        const degPerPx = view.fov / height;
        setView({ az: view.az - dx * degPerPx, alt: view.alt + dy * degPerPx });
    });
    canvas.addEventListener('pointerup', (e) => {
        if (dragging && dragging.moved < 6) {
            const rect = canvas.getBoundingClientRect();
            const code = pick(e.clientX - rect.left, e.clientY - rect.top);
            bus.emit('skyclick', { code });
        }
        dragging = null;
    });
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        setView({ fov: view.fov * Math.exp(e.deltaY * 0.001) });
    }, { passive: false });

    bus.on('band', ({ band }) => setBandTarget(band));
    window.addEventListener('resize', resize);
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
        project,
        pick,
        bodyShows,
        addLayer(layer) { layers.push(layer); return layer; },
        getLayer: (id) => layers.find((l) => l.id === id),
        // effect = { isActive(frame)?, render(renderer, inputTexture, outputTarget, frame) }: a full-screen pass
        // run in order on the HDR buffer before tone mapping. It must fill outputTarget. (Lensing uses this.)
        addPostEffect(effect) { postEffects.push(effect); return effect; },
        // fn(renderer, frame, target): draw extra scenes into the HDR buffer after the sky (depth is still valid)
        addOverlayPass(fn) { overlayPasses.push(fn); return fn; },
        setSkyVisible(on) { skipSkyDraw = !on; },
        currentFrame,
        resize,
        renderOnce: () => renderOnce(0.016), // For tests: draw one frame now
        start() {
            if (running) return;
            running = true;
            lastNow = performance.now();
            requestAnimationFrame(loop);
        },
        stop() { running = false; }
    };
}
