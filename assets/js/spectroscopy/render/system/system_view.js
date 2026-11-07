// The system view: a star opened out into its planets by a Spore-style flight.
//
// It has its own scene and camera, drawn into the engine's HDR buffer through addOverlayPass, so it shares the tone
// mapping and bloom with the sky. The sky itself is only ever looked at: a move into a system remembers the sky view
// to the digit and puts it back on the way out.
//
//   app.system.enter(code, { onDone, focus })   code: a star, binary, multiple, or one of their planets or members
//   app.system.exit({ onDone })
//   app.system.focusPlanet(code)                fly to a planet or star; null flies back to the whole system
//   app.system.hzAvailable(code?)               { ok, reason } for that system, or else the one that's open
//   app.system.hasSystemView(body)              whether a body is offered a System tab and "Enter system"
//   app.system.setLogScale(on), isLogScale(), logScaleUseful(), getTime(), getModel(), isFocused(), isBusy(),
//   readout(code), onChange(fn); names starting with _ are hooks for tests

import * as THREE from 'three';
import { bus, select } from '../../core/state.js';
import { azAltToVec3 } from '../../core/sky.js';
import { ETA, parallaxFactor } from '../../core/depth.js';
import { sharedUniforms } from '../shared.js';
import { wheelZoomStep } from '../engine.js';
import { createPlanetMesh, warmPlanetShaders, warmPlanetBakes } from '../planets/planet_mesh.js';
import { initSystemTab } from '../../ui/system_tab.js';
import {
    FRAME, buildModel, canDraw, hasSystemView, hzStatus, layout, ringRadius, starRadius, planetRadius,
    planetOrbitPoints, planetPhase, childOrbitPoints, figureEightWorldPoints, compressedSize, keplerReadout
} from './system_model.js';
import { TRANSITION_S, HAND_ARRIVE, easeProgress, pathAt, stagesAt, smoothstep, handSkyLog, handOffCentre } from './transition.js';
import { createZoomInto } from './zoom_into.js';
import { createStar } from './star_surface.js';
import { createOrbitLine } from './orbit_lines.js';
import { createBackdrop } from './backdrop.js';
import { createMassStream } from './mass_stream.js';

const RAD = Math.PI / 180;
const FOV = 36;                     // Vertical field of view of the system camera (degrees)
const TAN_V = Math.tan((FOV * RAD) / 2);
const HOME_EL = 30 * RAD;           // The three-quarter view above the orbital plane
const HOME_SWING = 24 * RAD;        // How far round the camera drifts during the flight
const FADE_S = 0.5;                 // The cross-fade that replaces the flight with Reduce motion
const FLIGHT_S = 1.15;              // A focus flight to a planet
const SKY_END_FOV_FACTOR = 34;      // How far the sky camera narrows as it flies in
const COMPILE_WAIT_MS = 4000;       // The longest a flight waits for its shaders, after which it goes without
const WARM_AFTER_SELECT_MS = 500;
const KEY_ZOOM_RATE = 1.3;          // Zooming with a key held down, as a log of the field of view a second, as on the sky
const VIEW_SHOWN_AT = 0.14;         // A zoom this far in has really gone in, so the rest of the page can hear about it

const HZ_VERTEX = /* glsl */`
varying vec2 vQ;
void main() {
    vQ = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const HZ_FRAGMENT = /* glsl */`
uniform float uInner;
uniform float uOuter;
uniform float uFade;
varying vec2 vQ;
void main() {
    float r = length(vQ);
    float width = max(uOuter - uInner, 1e-4);
    float soft = width * 0.28;
    float a = smoothstep(uInner - soft, uInner + soft, r) * (1.0 - smoothstep(uOuter - soft, uOuter + soft, r));
    gl_FragColor = vec4(vec3(0.16, 0.85, 0.42) * a * 0.11 * uFade, 1.0);
}`;

export function initSystemView(app) {
    const engine = app.engine;
    const canvas = engine.canvas;

    // ---------- Scenes ----------
    const scene = new THREE.Scene();
    const backScene = new THREE.Scene();        // The faint sky: drawn first, with no depth
    const camera = new THREE.PerspectiveCamera(FOV, 2, 0.01, 4000);
    let backdrop = null;

    // Dims the real sky as it fades, in case a sky layer doesn't honour uSkyFade
    const dimScene = new THREE.Scene();
    const dimMaterial = new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        uniforms: { uAlpha: { value: 0 } },
        vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'uniform float uAlpha; void main(){ gl_FragColor = vec4(0.0, 0.0, 0.0, uAlpha); }'
    });
    const dimQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dimMaterial);
    dimQuad.frustumCulled = false;
    dimScene.add(dimQuad);
    const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // The Reduce motion cross-fade: the system is drawn off to the side and blended over the still sky
    let fadeTarget = null;
    const fadeMaterial = new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        uniforms: { tInput: { value: null }, uAlpha: { value: 1 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'uniform sampler2D tInput; uniform float uAlpha; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(tInput, vUv).rgb, uAlpha); }'
    });
    const fadeScene = new THREE.Scene();
    const fadeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), fadeMaterial);
    fadeQuad.frustumCulled = false;
    fadeScene.add(fadeQuad);

    // Labels over the canvas. They take no pointer events, so drags reach the canvas underneath.
    const overlay = document.getElementById('spectroOverlay');
    const labelLayer = document.createElement('div');
    labelLayer.className = 'spectro-system-labels';
    labelLayer.setAttribute('aria-hidden', 'true');
    if (overlay) overlay.appendChild(labelLayer);

    // ---------- State ----------
    let mode = 'sky';           // 'sky' | 'load' | 'enter' | 'system' | 'exit'
    let compiled = false;       // The system's shaders are ready: the flight can start
    let model = null;
    let world = null;
    let savedView = null;       // The sky view to come back to, exactly
    let tNorm = 0;              // Linear progress through the flight (0 sky, 1 system)
    let hold = null;            // Test hook: a fixed tNorm
    let hand = null;            // The student's zoom is moving tNorm: see zoom_into.js. Otherwise the flight is on a clock.
    let keyZoom = 0;            // A zoom key held down during that move: -1 in, +1 out
    let viewShown = true;       // Has the page been told the view changed? A zoom waits to see if it's really going in.
    let useFade = false;        // This transition is the Reduce motion cross-fade
    let path = null;            // The flight's fixed values: see beginFlight
    let doneCallbacks = [];
    let tDays = 0;
    let lastTimeline = null;
    let mix = 0;                // 0 true scale, 1 log scale
    let mixTarget = 0;
    let logChoice = null;       // What the student last chose, kept between systems
    let positions = null;
    let selectedCode = null;
    let hoverCode = null;
    let queuedFocus = null;
    const listeners = new Set(); // The tab, to hear about changes that aren't on the bus

    // What the student controls. Everything except the flight goes through this.
    const cam = {
        az: 0, el: HOME_EL, dist: 40,
        azT: 0, elT: HOME_EL, distT: 40,
        zoom: 1,                // Multiplies the fit distance in the whole-system view
        focus: new THREE.Vector3(),
        target: null,           // null, or { kind: 'planet'|'star'|'node', index|node, code }
        flight: null
    };
    let fitSmooth = null;

    const notify = () => listeners.forEach((fn) => fn());

    // ---------- Building a system ----------
    function bandStrengthOf(s) {
        return s.entity.bands || model.body.bands || null;
    }

    function buildWorld() {
        const quality = app.qualityLevel;
        const group = new THREE.Group();
        const stars = model.stars.map((s) => {
            const star = createStar(s.star, { seed: s.code, quality });
            group.add(star.group);
            return star;
        });
        const brightest = model.stars.reduce((best, s, i) => (s.star.luminosity_Lsun > model.stars[best].star.luminosity_Lsun ? i : best), 0);

        const planets = model.planets.map((entry) => {
            const handle = makePlanet(entry, quality, group);
            const line = createOrbitLine(planetOrbitPoints(entry.planet), { opacity: 0.36, width: 1.4, trail: 0.8, colour: [0.5, 0.66, 0.95] });
            group.add(line.object);
            return { handle, line, entry };
        });

        // One line per star or sub-pair, round the centre of its group
        const starLines = [];
        model.nodes.forEach((node) => {
            if (!node.children || node.flat) return;
            node.children.forEach((child) => {
                const line = createOrbitLine(childOrbitPoints(model, node, child), { opacity: node === model.root && node.a_AU > 10 ? 0.28 : 0.38, width: 1.2, colour: [0.85, 0.78, 0.62], trail: 1.2 });
                group.add(line.object);
                starLines.push({ line, node });
            });
        });

        // The figure-eight: a thin line inside a faint glow
        let eight = null;
        const eightPoints = figureEightWorldPoints(model);
        if (eightPoints) {
            const glow = createOrbitLine(eightPoints, { soft: true, width: 11, opacity: 0.2, colour: [1, 0.74, 0.46] });
            const core = createOrbitLine(eightPoints, { width: 1.4, opacity: 0.6, colour: [1, 0.86, 0.66] });
            group.add(glow.object, core.object);
            eight = { glow, core };
        }

        let hz = null;
        if (model.hz) {
            const material = new THREE.ShaderMaterial({
                toneMapped: false,
                transparent: true,
                depthWrite: false,
                side: THREE.DoubleSide,
                blending: THREE.AdditiveBlending,
                vertexShader: HZ_VERTEX,
                fragmentShader: HZ_FRAGMENT,
                uniforms: { uInner: { value: 0.5 }, uOuter: { value: 0.8 }, uFade: { value: 0 } }
            });
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
            mesh.rotation.x = -Math.PI / 2;
            mesh.frustumCulled = false;
            mesh.renderOrder = 1;
            mesh.visible = false;
            group.add(mesh);
            const label = document.createElement('div');
            label.className = 'spectro-system-label spectro-system-hz-label';
            label.textContent = `Habitable zone, ${formatAU(model.hz.inner)} to ${formatAU(model.hz.outer)} AU`;
            label.hidden = true;
            labelLayer.appendChild(label);
            hz = { mesh, material, label, fade: 0 };
        }

        let stream = null;
        if (model.stream) {
            stream = createMassStream(model);
            group.add(stream.group);
        }

        const starLabels = model.stars.map((s) => makeLabel(s.code));
        const planetLabels = model.planets.map((e) => makeLabel(e.code));

        scene.add(group);
        return { group, stars, planets, starLines, eight, hz, stream, brightest, starLabels, planetLabels };
    }

    function makePlanet(entry, quality, group) {
        const handle = createPlanetMesh(entry.planet, entry.planet.host_teff_K, { quality, renderer: engine.renderer });
        group.add(handle.object3d);
        return handle;
    }

    function makeLabel(text) {
        const el = document.createElement('div');
        el.className = 'spectro-system-label';
        el.textContent = text;
        el.hidden = true;
        labelLayer.appendChild(el);
        return el;
    }

    function disposeWorld() {
        if (!world) return;
        scene.remove(world.group);
        world.stars.forEach((s) => s.dispose());
        world.planets.forEach((p) => {
            p.handle.dispose();
            p.line.dispose();
        });
        world.starLines.forEach((s) => s.line.dispose());
        if (world.eight) {
            world.eight.glow.dispose();
            world.eight.core.dispose();
        }
        if (world.hz) {
            world.hz.material.dispose();
            world.hz.mesh.geometry.dispose();
        }
        if (world.stream) world.stream.dispose();
        labelLayer.replaceChildren();
        world = null;
        positions = null;
    }

    function formatAU(a) {
        return a >= 100 ? a.toFixed(0) : a.toPrecision(2);
    }

    // ---------- Fitting the view ----------
    function fitDistance(aspect, el) {
        const tanH = TAN_V * aspect;
        // Width of the orbit plane on screen, or its height, whichever runs out first. The near edge of the plane is
        // closer than the centre, so it needs d >= R (sin el / tan + cos el) to stay on screen.
        const fill = 0.93;
        const needH = FRAME / (fill * tanH);
        const a = Math.abs(el);
        const needV = FRAME * (Math.sin(a) / (fill * TAN_V) + Math.cos(a));
        return Math.max(needH, needV);
    }

    function pxPerWorldAt(depth, frame) {
        return frame.height / (2 * TAN_V * Math.max(depth, 1e-6));
    }

    // The radius (world units) the camera sits away from when it is closest to the middle of the system.
    // Stars fill much of the view; a pair or a figure-eight has to fit.
    function closestApproach(aspect) {
        const main = model.stars[world.brightest].star;
        const R = starRadius(model, world.brightest, mix);
        const stage = main.stage;
        const fill = stage === 'white_dwarf' ? 0.13 : (stage === 'giant' || stage === 'supergiant') ? 0.36 : 0.27;
        let d = R / (2 * fill * TAN_V);
        if (model.stars.length > 1) {
            // The flight aims at the centre of mass, which may be empty space: keep the widest orbit's stars in shot
            const reach = model.root.flat ? FRAME * 0.8 : ringRadius(model, model.root.a_AU, mix) * 0.85;
            d = Math.max(d, reach / (TAN_V * Math.min(aspect, 1)));
        }
        return d;
    }

    function beginFlight(frame) {
        const star = model.body.sky;
        const dAz = ((star.az - savedView.az + 540) % 360) - 180;
        const fovEnd = Math.min(savedView.fov, Math.max(0.7, savedView.fov / SKY_END_FOV_FACTOR));
        const aspect = frame.width / Math.max(1, frame.height);
        // The flight starts on the true line of sight: edge-on for inclination 90, from above for smaller angles.
        // A lone star has no measured tilt, so it starts low and rises.
        const el0 = model.inclination === null ? 7 * RAD : Math.min(70, Math.max(4, 90 - model.inclination)) * RAD;
        const az0 = model.sightAz;
        const az1 = HOME_SWING;
        const R = starRadius(model, world.brightest, mix);
        const fit = fitDistance(aspect, HOME_EL);
        const dClose = Math.min(closestApproach(aspect), fit * 0.8);
        // A speck at the start: under a pixel for a lone star, a few pixels for a whole group
        const speckPx = model.stars.length > 1 ? 3 : 0.8;
        const speckR = model.stars.length > 1 ? FRAME : R;
        const d0 = Math.max(dClose * 4, (speckR * frame.height) / (2 * speckPx * TAN_V));
        path = { star, dAz, fovEnd, el0, az0, az1, d0, dClose, dir: azAltToVec3(star.az, star.alt), byHand: !!hand, skyLog: undefined, locked: false, roll: 0 };
        if (hand) lockStarsToSky(frame, fit);

        cam.az = az1;
        cam.azT = az1;
        cam.el = HOME_EL;
        cam.elT = HOME_EL;
        cam.zoom = 1;
        cam.focus.set(0, 0, 0);
        cam.target = null;
        cam.flight = null;
        fitSmooth = fit;
        cam.dist = fit;
        cam.distT = fit;

        // Line the faint sky's catalogue up with the line of sight, so what's behind the star is what was behind it
        const skyQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(star.alt * RAD, -star.az * RAD, 0, 'YXZ'));
        const sysPos = new THREE.Vector3(Math.cos(el0) * Math.sin(az0), Math.sin(el0), Math.cos(el0) * Math.cos(az0));
        const look = new THREE.Matrix4().lookAt(sysPos, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
        const sysQ = new THREE.Quaternion().setFromRotationMatrix(look);
        backdrop.setOrientation(sysQ.multiply(skyQ.invert()));
    }

    // Under a hand a multiple's stars start right where the sky has already drawn them apart, and stay on them: the camera
    // starts as far off as puts the two widest parts of its first split that far apart, turned to match, and comes in just
    // as the sky zooms. A pair lands exactly. The sky draws the spacing in a triple or two pairs in its own way, so they land
    // close, each part round its place on the sky.
    function lockStarsToSky(frame, fit) {
        const binaries = engine.getLayer('binaries');
        const onSky = model.stars.length > 1 && binaries && binaries.firstSplit ? binaries.firstSplit(model.code) : null;
        if (!onSky || onSky.length < 2) return;
        let from = null;
        let to = null;
        let widest = -1;
        onSky.forEach((p, i) => onSky.forEach((q, j) => {
            const apart = Math.hypot(q.x - p.x, q.y - p.y);
            if (j > i && apart > widest) {
                widest = apart;
                from = p;
                to = q;
            }
        }));
        if (!(widest > 0)) return;
        // Where those two lie across the view, from the path's starting point
        const { el0, az0 } = path;
        const back = lockBack.set(Math.cos(el0) * Math.sin(az0), Math.sin(el0), Math.cos(el0) * Math.cos(az0));
        const right = lockRight.set(0, 1, 0).cross(back).normalize();
        const up = lockUp.copy(back).cross(right);
        const gap = lockGap.set(0, 0, 0);
        [[to, 1], [from, -1]].forEach(([part, sign]) => {
            let mass = 0;
            part.stars.forEach((i) => { mass += model.stars[i].star.mass_Msun; });
            part.stars.forEach((i) => {
                const share = (sign * model.stars[i].star.mass_Msun) / mass;
                const q = positions.stars[i];
                gap.x += q[0] * share;
                gap.y += q[1] * share;
                gap.z += q[2] * share;
            });
        });
        const across = gap.dot(right);
        const along = gap.dot(up);
        const worldApart = Math.hypot(across, along);
        if (!(worldApart > 1e-6)) return;
        const depth = model.body.depth || 0;
        const skyApart = widest * RAD * parallaxFactor(depth, savedView.fov) / Math.tan(savedView.fov * RAD * 0.5);
        const d0 = worldApart / (TAN_V * skyApart);
        if (d0 < fit * 1.5) return;
        path.d0 = d0;
        path.locked = true;
        path.roll = Math.atan2(to.y - from.y, to.x - from.x) - Math.atan2(along, across);
        // The sky zooms by just enough, as the camera arrives. Its depth holds it back a little: see core/depth.js.
        path.skyLog = Math.log(d0 / fit) / (1 - ETA * depth);
    }

    // ---------- Input: while a system is open the sky's own handlers never see these ----------
    const host = canvas.parentElement || canvas;
    const pointers = new Map();
    let drag = null;
    let pinch = null;
    const inSystem = () => mode !== 'sky';
    const canInteract = () => mode === 'system';

    host.addEventListener('pointerdown', (e) => {
        if (!inSystem() || e.target !== canvas) return;
        e.stopPropagation();
        canvas.focus({ preventScroll: true });
        try {
            canvas.setPointerCapture(e.pointerId);
        } catch (err) { /* Already gone: the drag just ends sooner */ }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
            drag = { x: e.clientX, y: e.clientY, moved: 0 };
        } else if (pointers.size === 2) {
            drag = null;
            const [a, b] = [...pointers.values()];
            pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
        }
    }, true);

    host.addEventListener('pointermove', (e) => {
        if (!inSystem() || e.target !== canvas) return;
        e.stopPropagation();
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (hand) pinchMoved();
        if (!canInteract()) return;
        if (pinchMoved()) return;
        if (drag) {
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            drag.x = e.clientX;
            drag.y = e.clientY;
            drag.moved += Math.abs(dx) + Math.abs(dy);
            cam.azT -= dx * 0.32 * RAD;
            cam.elT = Math.max(-80 * RAD, Math.min(88 * RAD, cam.elT + dy * 0.32 * RAD));
            return;
        }
        if (e.pointerType === 'mouse') {
            const rect = canvas.getBoundingClientRect();
            const hit = pickAt(e.clientX - rect.left, e.clientY - rect.top, 18);
            if ((hit && hit.code) !== hoverCode) {
                hoverCode = hit ? hit.code : null;
                canvas.style.cursor = hoverCode ? 'pointer' : '';
            }
        }
    }, true);

    function pinchMoved() {
        if (!pinch || pointers.size !== 2) return false;
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.d > 0 && d > 0) applyZoom(pinch.d / d);
        pinch.d = d;
        return true;
    }

    function endPointer(e) {
        if (!inSystem() || e.target !== canvas) return;
        e.stopPropagation();
        const wasDrag = drag;
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
        if (pointers.size === 0) drag = null;
        if (e.type === 'pointerup' && wasDrag && wasDrag.moved < 6 && canInteract()) {
            const rect = canvas.getBoundingClientRect();
            const touch = e.pointerType !== 'mouse';
            const hit = pickAt(e.clientX - rect.left, e.clientY - rect.top, touch ? 36 : 24);
            if (hit) {
                select(hit.code);
                focusOn(hit.code);
            }
        }
    }
    host.addEventListener('pointerup', endPointer, true);
    host.addEventListener('pointercancel', endPointer, true);

    host.addEventListener('wheel', (e) => {
        if (!inSystem() || e.target !== canvas) return;
        e.stopPropagation();
        e.preventDefault();
        applyZoom(Math.exp(wheelZoomStep(e)));
    }, { capture: true, passive: false });

    // Arrow keys orbit and +/- zoom, while the sky stays put. Esc belongs to the shell.
    window.addEventListener('keydown', (e) => {
        if (!inSystem() || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && t !== document.body && t !== canvas && (t.closest('input, select, textarea, button, summary, a') || t.closest('#simulationControlsPanel'))) return;
        const step = 6 * RAD;
        let used = true;
        if (e.key === 'ArrowLeft') cam.azT += step;
        else if (e.key === 'ArrowRight') cam.azT -= step;
        else if (e.key === 'ArrowUp') cam.elT = Math.min(88 * RAD, cam.elT + step);
        else if (e.key === 'ArrowDown') cam.elT = Math.max(-80 * RAD, cam.elT - step);
        else if (e.key === '+' || e.key === '=') zoomKey(-1);
        else if (e.key === '-' || e.key === '_') zoomKey(1);
        else used = false;
        if (used) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    // During the move a held key zooms by the frame, as on the sky, not at the rate the keyboard repeats
    function zoomKey(direction) {
        if (hand) keyZoom = direction;
        else applyZoom(direction < 0 ? 0.85 : 1 / 0.85);
    }
    const releaseZoomKey = () => { keyZoom = 0; };
    window.addEventListener('keyup', (e) => {
        if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_' || e.key === '−') releaseZoomKey();
    });
    window.addEventListener('blur', releaseZoomKey);

    function applyZoom(factor) {
        if (hand) {
            hand.push(Math.log(factor));
            return;
        }
        if (!canInteract()) return;
        if (cam.target) {
            cam.distT = Math.max(minDistance(), cam.distT * factor);
            // Pulling far enough back from a planet lets go of it
            if (fitSmooth && cam.distT >= fitSmooth * 0.9) {
                startFocusFlight(null, cam.distT / fitSmooth);
            }
            return;
        }
        // Zooming out from the outermost distance carries on out to the sky
        if (factor > 1 && !cam.flight && cam.zoom >= maxZoom()) {
            zoomInto.zoomedOutPast(Math.log(factor));
            return;
        }
        cam.zoom = Math.max(minDistance() / (fitSmooth || 1), Math.min(maxZoom(), cam.zoom * factor));
    }

    function hzReach() {
        return model && model.hz && app.layers.habitableZone ? ringRadius(model, model.hz.outer, mix) / FRAME : 0;
    }

    function maxZoom() {
        return Math.max(1.8, hzReach() * 1.4);
    }

    function minDistance() {
        const t = cam.target;
        if (t && t.kind === 'planet') return planetRadius(model, model.planets[t.index].planet, mix) * 1.5;
        if (t && t.kind === 'star') return starRadius(model, t.index, mix) * 1.5;
        return Math.max(...model.stars.map((_, i) => starRadius(model, i, mix))) * 1.5;
    }

    // Screen-space picking: planets win over the star behind them, and the radius is generous on purpose
    function pickAt(x, y, radiusPx) {
        if (!positions || !world) return null;
        const frame = engine.currentFrame();
        const v = new THREE.Vector3();
        const onScreen = (pos, r) => {
            v.set(pos[0], pos[1], pos[2]);
            const depth = v.distanceTo(camera.position);
            v.project(camera);
            return {
                ok: v.z <= 1,
                depth,
                x: (v.x * 0.5 + 0.5) * frame.width,
                y: (-v.y * 0.5 + 0.5) * frame.height,
                r: Math.min(frame.height, r * pxPerWorldAt(depth, frame))
            };
        };
        const stars = model.stars.map((s, i) => ({ code: s.code, ...onScreen(positions.stars[i], starDrawnRadius[i] || 0) }));
        let best = null;
        let bestD = radiusPx;
        const consider = (q, code, rank) => {
            if (!q.ok) return;
            const d = Math.max(0, Math.hypot(q.x - x, q.y - y) - q.r) + rank;
            if (d < bestD) {
                bestD = d;
                best = { code };
            }
        };
        model.planets.forEach((entry, i) => {
            const q = onScreen(positions.planets[i], planetDrawnRadius[i] || 0);
            const hidden = stars.some((st) => st.depth < q.depth && Math.hypot(st.x - q.x, st.y - q.y) < st.r);
            if (!hidden) consider(q, entry.code, 0);
        });
        stars.forEach((st) => consider(st, st.code, 6));
        return best;
    }

    // ---------- Focus flights ----------
    function targetOf(code) {
        if (!model || !code) return null;
        const pi = model.planets.findIndex((e) => e.code === code);
        if (pi >= 0) return { kind: 'planet', index: pi, code };
        const si = model.stars.findIndex((s) => s.code === code);
        if (si >= 0) {
            if (model.stars.length === 1) return null;  // The middle of a one-star system: the whole view
            // A star in a tight pair: frame the pair, so its partner is in shot
            const parent = model.nodes.find((n) => n.children && !n.flat && n.children.some((c) => c.index === si));
            if (parent && parent !== model.root) return { kind: 'node', node: parent, code };
            return { kind: 'star', index: si, code };
        }
        return null;
    }

    function targetPosition(t) {
        if (!t || !positions) return [0, 0, 0];
        if (t.kind === 'planet') return positions.planets[t.index];
        if (t.kind === 'star') return positions.stars[t.index];
        return positions.nodes.get(t.node) || [0, 0, 0];
    }

    function targetDistance(t) {
        const frame = engine.currentFrame();
        const aspect = frame.width / Math.max(1, frame.height);
        if (t.kind === 'planet') {
            const planet = model.planets[t.index].planet;
            const reach = planet.rings ? Math.max(1, planet.rings.outer_Rp || 1) * 0.7 + 0.3 : 1;
            return (planetRadius(model, planet, mix) * reach) / (2 * 0.2 * TAN_V * Math.min(1, aspect));
        }
        if (t.kind === 'star') return starRadius(model, t.index, mix) / (2 * 0.24 * TAN_V);
        const sep = ringRadius(model, t.node.a_AU, mix);
        const around = model.planets.filter((e) => e.node === t.node).map((e) => ringRadius(model, e.planet.orbit_AU, mix));
        return (Math.max(sep * 1.1, ...around.map((r) => r * 1.1)) / TAN_V) / Math.min(1, aspect);
    }

    function startFocusFlight(target, zoomAfter = 1) {
        const frame = engine.currentFrame();
        const aspect = frame.width / Math.max(1, frame.height);
        const fit = fitDistance(aspect, cam.elT);
        const toDist = target ? targetDistance(target) : fit * zoomAfter;
        const duration = app.settings.reduceMotion ? 0 : FLIGHT_S;
        if (duration === 0) {
            cam.target = target;
            if (target && target.kind === 'planet') faceLitSide(target);
            cam.zoom = zoomAfter;
            cam.dist = toDist;
            cam.distT = toDist;
            cam.flight = null;
            notify();
            return;
        }
        cam.flight = { t: 0, duration, from: cam.focus.clone(), fromDist: cam.dist, toDist, target, zoomAfter };
        cam.target = target;
        if (target && target.kind === 'planet') faceLitSide(target);
        notify();
    }

    // A planet is the point of the flight, so arrive on its day side, with the star over the viewer's shoulder
    function faceLitSide(target) {
        const p = positions.planets[target.index];
        const sun = positions.stars[world.brightest];
        const towardsSun = Math.atan2(sun[0] - p[0], sun[2] - p[2]);
        cam.azT = cam.az + wrapPi(towardsSun + 0.65 - cam.az);
        cam.elT = Math.max(10 * RAD, Math.min(32 * RAD, cam.elT));
    }

    function focusOn(code) {
        if (mode === 'load' || mode === 'enter') {
            queuedFocus = code;
            return;
        }
        if (mode !== 'system') return;
        const t = targetOf(code);
        if (!t && !cam.target) return;      // Already looking at the whole system
        if (t && cam.target && cam.target.code === t.code) return;
        startFocusFlight(t);
    }

    // ---------- The frame ----------
    const planetDrawnRadius = [];
    const starDrawnRadius = [];
    const tmp = new THREE.Vector3();
    const sunDir = new THREE.Vector3();
    let sysFrame = null;

    function stepCamera(frame, stage) {
        const dt = frame.dt;
        const aspect = frame.width / Math.max(1, frame.height);
        const k = app.settings.reduceMotion ? 1 : 1 - Math.exp(-dt * 12);

        // The fit changes when the drawer opens: ease to it, so the view doesn't jump
        const fitNow = fitDistance(aspect, cam.elT);
        fitSmooth = fitSmooth === null ? fitNow : fitSmooth + (fitNow - fitSmooth) * (1 - Math.exp(-dt * 5));

        if (cam.flight) {
            const f = cam.flight;
            f.t = Math.min(1, f.t + dt / f.duration);
            const e = smoothstep(0, 1, f.t);
            const to = targetPosition(f.target);
            cam.focus.set(f.from.x + (to[0] - f.from.x) * e, f.from.y + (to[1] - f.from.y) * e, f.from.z + (to[2] - f.from.z) * e);
            cam.dist = Math.exp(Math.log(f.fromDist) + (Math.log(f.toDist) - Math.log(f.fromDist)) * e);
            cam.distT = cam.dist;
            if (f.t >= 1) {
                cam.flight = null;
                if (!f.target) cam.zoom = f.zoomAfter;
            }
        } else {
            if (cam.target) {
                const to = targetPosition(cam.target);
                cam.focus.set(to[0], to[1], to[2]);
            } else {
                cam.focus.multiplyScalar(1 - k);
                cam.distT = fitSmooth * cam.zoom;
            }
            cam.dist += (cam.distT - cam.dist) * k;
        }
        cam.az += (cam.azT - cam.az) * k;
        cam.el += (cam.elT - cam.el) * k;

        // Where the camera really is: on the flight's path, easing to the student's camera near the end
        const w = stage.userBlend;
        let az = cam.az;
        let el = cam.el;
        let dist = cam.dist;
        let fx = cam.focus.x;
        let fy = cam.focus.y;
        let fz = cam.focus.z;
        if (w < 1) {
            // Under a hand there is no swing in close: the camera comes straight to where the student's is
            const pose = pathAt(easeProgress(tNorm), {
                d0: path.d0,
                dClose: path.byHand ? cam.dist : path.dClose,
                dEnd: path.byHand ? cam.dist : Math.max(path.dClose * 1.01, fitSmooth),
                arrive: path.byHand ? HAND_ARRIVE : undefined,
                el0: path.el0,
                el1: HOME_EL,
                az0: path.az0,
                az1: path.az1
            });
            if (path.locked) pose.dist = path.d0 * skyScale(engine.view.fov);
            // Take the short way round from wherever the student left it
            const azUser = pose.az + wrapPi(cam.az - pose.az);
            az = pose.az + (azUser - pose.az) * w;
            el = pose.el + (cam.el - pose.el) * w;
            dist = Math.exp(Math.log(pose.dist) + (Math.log(cam.dist) - Math.log(pose.dist)) * w);
            fx *= w;
            fy *= w;
            fz *= w;
        }
        camera.aspect = aspect;
        camera.fov = FOV;
        camera.near = Math.max(1e-3, dist * 0.02);
        camera.far = dist * 6 + FRAME * 12 + hzReach() * FRAME * 4;
        camera.updateProjectionMatrix();
        camera.position.set(
            fx + dist * Math.cos(el) * Math.sin(az),
            fy + dist * Math.sin(el),
            fz + dist * Math.cos(el) * Math.cos(az)
        );
        camera.up.set(0, 1, 0);
        camera.lookAt(fx, fy, fz);
        if (w < 1 && path.roll) camera.rotateZ(-path.roll * (1 - smoothstep(0.3, 0.85, easeProgress(tNorm))));
        camera.updateMatrixWorld();
    }

    function wrapPi(x) {
        const two = Math.PI * 2;
        return (((x + Math.PI) % two) + two) % two - Math.PI;
    }

    // Moves the sky camera along the flight. Returns where the star is on screen, so the system's star can sit on it.
    function stepSky(stage) {
        const from = savedView;
        if (tNorm <= 0) {
            restoreSky();
            return { x: 0, y: 0, seen: 0 };
        }
        if (path.byHand) {
            const fov = from.fov * Math.exp(-handSkyLog(tNorm, path.skyLog));
            // What the star's distance from the centre of the screen comes to as an angle, at this field of view
            const centre = 1 - handOffCentre(tNorm) * skyScale(fov);
            engine.flyView(from.az + path.dAz * centre, from.alt + (path.star.alt - from.alt) * centre, fov);
        } else {
            const alt = from.alt + (path.star.alt - from.alt) * stage.skyCentre;
            const az = from.az + path.dAz * stage.skyCentre;
            const fov = Math.exp(Math.log(from.fov) + (Math.log(path.fovEnd) - Math.log(from.fov)) * stage.skyZoom);
            engine.setView({ az, alt, fov });
        }
        const sky = engine.camera;
        tmp.set(path.dir[0] * 1000, path.dir[1] * 1000, path.dir[2] * 1000).project(sky);
        // tmp.z > 1 means the star is behind the sky camera, which project can't express
        const behind = tmp.z > 1;
        const parallax = parallaxFactor(model.body.depth || 0, engine.getView().fov);
        const x = behind ? 3 : tmp.x * parallax;
        const y = behind ? 3 : tmp.y * parallax;
        // Comes up only as it turns into view
        const edge = Math.max(Math.abs(x), Math.abs(y));
        return { x: Math.max(-2, Math.min(2, x)), y: Math.max(-2, Math.min(2, y)), seen: 1 - smoothstep(1, 1.3, edge) };
    }

    // The size of a patch of sky on screen at a field of view is one over this, as a share of how it was when the move began
    function skyScale(fov) {
        const depth = model.body.depth || 0;
        return (Math.tan(fov * RAD * 0.5) / Math.tan(savedView.fov * RAD * 0.5)) * (parallaxFactor(depth, savedView.fov) / parallaxFactor(depth, fov));
    }

    function restoreSky() {
        engine.setView(savedView);
        // setView normalises the azimuth; keep the digits as they were
        engine.view.az = savedView.az;
        engine.view.alt = savedView.alt;
        engine.view.fov = savedView.fov;
    }

    function shiftProjection(nx, ny) {
        // Moves the principal point: the camera still looks at the star, but it draws where the sky camera has it
        camera.projectionMatrix.elements[8] = -nx;
        camera.projectionMatrix.elements[9] = -ny;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }

    function updateWorld(frame, stage, starNdc) {
        const reduce = app.settings.reduceMotion;
        positions = layout(model, tDays, mix, positions);
        const seen = starNdc ? starNdc.seen : 1;
        const showReveal = stage.reveal * seen;
        const camPos = camera.position;
        const bandW = sharedUniforms.uBandW.value;

        sysFrame = { ...frame, camera, view: 'system' };

        // Stars
        world.stars.forEach((star, i) => {
            const p = positions.stars[i];
            star.group.position.set(p[0], p[1], p[2]);
            const depth = tmp.set(p[0], p[1], p[2]).distanceTo(camPos);
            const pxPerWorld = pxPerWorldAt(depth, frame);
            const R = starRadius(model, i, mix);
            const s = model.stars[i];
            const minPx = Math.max(3.5, Math.min(44, 9 * compressedSize(s.star.radius_Rsun))) * stage.minSize;
            const drawn = Math.max(R, minPx / pxPerWorld);
            starDrawnRadius[i] = drawn;
            star.setRadius(drawn);

            // Tides: this star leans towards its partner
            const tide = model.tides[i];
            if (tide) {
                const q = positions.nodes.get(tide.other);
                tmp.set(q[0] - p[0], q[1] - p[1], q[2] - p[2]).normalize();
                const isDonor = model.stream && model.stream.donor === i;
                star.setTide(tmp.x, tmp.y, tmp.z, Math.max(tide.stretch, isDonor ? 0.07 : 0), isDonor ? 0.3 : 0);
            }

            const bands = bandStrengthOf(s);
            let amount = 1;
            if (bands) {
                amount = (bands.radio || 0) * bandW[0] + (bands.ir || 0) * bandW[1] + bandW[2] + (bands.uv || 0) * bandW[3] + (bands.xray || 0) * bandW[4];
                amount = Math.max(0.12, Math.min(1, amount));
            }
            star.setBandStrength(amount);
            star.update({
                dt: frame.dt,
                camera,
                reveal: showReveal,
                // A star drawn only a few pixels wide still needs to read as a light, not a dot
                pointGlow: stage.pointGlow * seen + stage.minSize * 0.5 * (1 - smoothstep(2.5, 11, drawn * pxPerWorld)),
                glowPx: 26 * frame.dpr * (s.star.stage === 'white_dwarf' ? 1.6 : 1),
                reduceMotion: reduce,
                pxRadius: drawn * pxPerWorld
            });
        });

        // Planets: a minimum size on screen, so a small world far out is still something to click
        const sun = positions.stars[world.brightest];
        world.planets.forEach((item, i) => {
            const p = positions.planets[i];
            const obj = item.handle.object3d;
            obj.visible = stage.planets > 0.001;
            obj.position.set(p[0], p[1], p[2]);
            const depth = tmp.set(p[0], p[1], p[2]).distanceTo(camPos);
            const R = planetRadius(model, item.entry.planet, mix);
            const big = Math.min(1, Math.max(0, ((item.entry.planet.radius_Rearth || 1) - 1) / 10));
            const minPx = 3.4 + 4.2 * Math.sqrt(big);
            const pxPerWorld = pxPerWorldAt(depth, frame);
            const drawn = Math.max(R, minPx / pxPerWorld);
            planetDrawnRadius[i] = drawn;
            // The planets track can fade a planet; without that, it grows in instead
            if (item.handle.setOpacity) item.handle.setOpacity(stage.planets);
            obj.scale.setScalar(item.handle.setOpacity ? drawn : drawn * Math.max(1e-3, stage.planets));

            sunDir.set(sun[0] - p[0], sun[1] - p[1], sun[2] - p[2]).normalize();
            // A few pixels of night side would be a black dot on a dark sky, so a small planet is lit from nearer the
            // viewer. Its true phase comes back as it grows big enough to be seen properly.
            const flat = 1 - smoothstep(16, 70, drawn * pxPerWorld);
            if (flat > 0) {
                tmp.set(camPos.x - p[0], camPos.y - p[1], camPos.z - p[2]).normalize();
                sunDir.lerp(tmp, flat * 0.8).normalize();
            }
            item.handle.update(sysFrame, sunDir);

            const c = positions.centres[i];
            const isSel = item.entry.code === selectedCode;
            item.line.object.position.set(c[0], c[1], c[2]);
            item.line.object.scale.setScalar(ringRadius(model, item.entry.planet.orbit_AU, mix));
            item.line.set({
                draw: stage.orbits,
                head: planetPhase(item.entry.planet, tDays),
                opacity: cam.target && cam.target.code === item.entry.code ? 0.3 : isSel ? 0.7 : 0.36,
                width: (isSel ? 2.2 : 1.4) * frame.dpr
            });
        });

        // Lines of the stars themselves
        world.starLines.forEach(({ line, node }) => {
            const c = positions.nodes.get(node);
            line.object.position.set(c[0], c[1], c[2]);
            line.object.scale.setScalar(ringRadius(model, node.a_AU, mix) / node.a_AU);
            const period = node.orbit ? node.orbit.period_days : 0;
            line.set({ draw: stage.orbits, head: period ? ((tDays / period) % 1 + 1) % 1 : 0, width: 1.2 * frame.dpr });
        });
        if (world.eight) {
            const head = ((tDays / model.pathPeriodDays) % 1 + 1) % 1;
            world.eight.glow.set({ draw: stage.orbits, head, width: 11 * frame.dpr });
            world.eight.core.set({ draw: stage.orbits, head, width: 1.4 * frame.dpr });
        }

        // Mass transfer
        if (world.stream) {
            const st = model.stream;
            const d = positions.stars[st.donor];
            const a = positions.stars[st.accretor];
            world.stream.update({
                d, a,
                rD: starDrawnRadius[st.donor],
                rA: starDrawnRadius[st.accretor],
                dt: frame.dt,
                reduceMotion: reduce,
                opacity: smoothstep(0.35, 0.7, easeProgress(tNorm)),
                pxPerWorld: frame.height / (2 * TAN_V)
            });
        }

        // Habitable zone
        if (world.hz) {
            const want = app.layers.habitableZone && mode !== 'load' ? 1 : 0;
            const hz = world.hz;
            hz.fade += (want - hz.fade) * (reduce ? 1 : 1 - Math.exp(-frame.dt * 6));
            hz.fade = Math.abs(hz.fade - want) < 0.002 ? want : hz.fade;
            hz.mesh.visible = hz.fade > 0;
            if (hz.mesh.visible) {
                const inner = ringRadius(model, model.hz.inner, mix);
                const outer = ringRadius(model, model.hz.outer, mix);
                const extent = outer * 1.3;
                hz.mesh.scale.setScalar(extent);
                hz.material.uniforms.uInner.value = inner / extent;
                hz.material.uniforms.uOuter.value = outer / extent;
                hz.material.uniforms.uFade.value = hz.fade * stage.orbits;
            }
        }

        updateLabels(frame, stage);
    }

    // ---------- Labels ----------
    function placeLabel(el, x, y, frame, cls) {
        const out = x < 0 || y < 0 || x > frame.width || y > frame.height;
        el.hidden = out;
        if (!out) el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
        el.classList.toggle('is-selected', cls === 'selected');
    }

    function projectToCss(pos, frame) {
        tmp.set(pos[0], pos[1], pos[2]).project(camera);
        if (tmp.z > 1) return null;
        return { x: (tmp.x * 0.5 + 0.5) * frame.width, y: (-tmp.y * 0.5 + 0.5) * frame.height };
    }

    function updateLabels(frame, stage) {
        const labelsOn = app.layers.labels && stage.planets > 0.9;
        world.planetLabels.forEach((el, i) => {
            if (!labelsOn) {
                el.hidden = true;
                return;
            }
            const entry = model.planets[i];
            const at = projectToCss(positions.planets[i], frame);
            if (!at) {
                el.hidden = true;
                return;
            }
            const depth = tmp.set(...positions.planets[i]).distanceTo(camera.position);
            const r = planetDrawnRadius[i] * pxPerWorldAt(depth, frame);
            placeLabel(el, at.x, at.y - r - 3, frame, entry.code === selectedCode || entry.code === hoverCode ? 'selected' : '');
        });
        world.starLabels.forEach((el, i) => {
            if (!labelsOn) {
                el.hidden = true;
                return;
            }
            const at = projectToCss(positions.stars[i], frame);
            if (!at) {
                el.hidden = true;
                return;
            }
            const depth = tmp.set(...positions.stars[i]).distanceTo(camera.position);
            const r = starDrawnRadius[i] * pxPerWorldAt(depth, frame);
            placeLabel(el, at.x, at.y - r - 3, frame, model.stars[i].code === selectedCode ? 'selected' : '');
        });
        if (world.hz) {
            const on = world.hz.fade > 0.5 && stage.orbits > 0.9 && !!app.layers.habitableZone;
            if (!on) {
                world.hz.label.hidden = true;
            } else {
                // On the ring, at the side nearest the viewer, so it sits in the open
                const outer = ringRadius(model, model.hz.outer, mix);
                const a = Math.atan2(camera.position.x, camera.position.z);
                const at = projectToCss([Math.sin(a) * outer, 0, Math.cos(a) * outer], frame);
                if (at) {
                    const y = Math.max(90, Math.min(frame.height - 66, at.y + 20));
                    const x = Math.max(110, Math.min(frame.width - 110, at.x));
                    placeLabel(world.hz.label, x, y, frame, '');
                } else {
                    world.hz.label.hidden = true;
                }
            }
        }
    }

    // ---------- Stepping everything ----------
    function step(frame) {
        if (mode === 'sky') return;
        if (mode === 'load') {
            // Selecting a star slews the sky to it. Wait for that: where it lands is the view to come back to.
            if (!compiled || engine.isSlewing()) return;
            savedView = engine.getView();
            beginFlight(frame);
            mode = 'enter';
        }
        const dt = frame.dt;
        const duration = useFade ? FADE_S : TRANSITION_S;
        if (hold !== null) {
            tNorm = hold;
        } else if (hand) {
            stepHand(dt);
        } else if (mode === 'enter') {
            tNorm = Math.min(1, tNorm + dt / duration);
        } else if (mode === 'exit') {
            tNorm = Math.max(0, tNorm - dt / duration);
        }

        // Log scale eases, except with Reduce motion
        if (mix !== mixTarget) {
            mix += (mixTarget - mix) * (app.settings.reduceMotion ? 1 : 1 - Math.exp(-frame.dt * 5));
            if (Math.abs(mix - mixTarget) < 0.002) mix = mixTarget;
        }

        if (useFade) {
            // No flight at all: the sky stays exactly where it is and the system fades up over it
            const stage = stagesAt(1);
            stepCamera(frame, stage);
            updateWorld(frame, stage, null);
            sharedUniforms.uSkyFade.value = 1;
            engine.setSkyVisible(tNorm < 1);
            backdrop.set(1, 1, frame.dpr);
        } else {
            const p = easeProgress(tNorm);
            const stage = stagesAt(p, path.byHand, path.byHand && model.stars.length > 2);
            const ndc = stepSky(stage);
            sharedUniforms.uSkyFade.value = stage.skyFade;
            engine.setSkyVisible(stage.skyFade > 0.001);
            stepCamera(frame, stage);
            shiftProjection(ndc.x, ndc.y);
            updateWorld(frame, stage, ndc);
            backdrop.set(stage.backdrop, stage.backdropZoom, frame.dpr);
        }
        if (hold === null) finishIfDone();
    }

    function stepHand(dt) {
        if (app.settings.reduceMotion) {
            // Switched on part way through: no more flying, just a fade to the nearer end
            hand = null;
            useFade = true;
            restoreSky();
            sharedUniforms.uSkyFade.value = 1;
            engine.setSkyVisible(true);
            mode = tNorm >= 0.5 ? 'enter' : 'exit';
            return;
        }
        if (keyZoom) hand.push(keyZoom * KEY_ZOOM_RATE * dt);
        if (pinch) hand.hold();
        tNorm = hand.advance(tNorm, dt);
        mode = hand.modeAt(tNorm, mode);
        if (!viewShown && tNorm >= VIEW_SHOWN_AT) showView();
    }

    function showView() {
        viewShown = true;
        bus.emit('view', { view: 'system', code: model.code });
    }

    function finishIfDone() {
        if (mode === 'enter' && tNorm >= 1) {
            mode = 'system';
            if (hand) arrivedByHand();
            hand = null;
            keyZoom = 0;
            sharedUniforms.uSkyFade.value = 0;
            announce();
            const queued = queuedFocus;
            queuedFocus = null;
            runDone();
            if (queued) focusOn(queued);
            notify();
        } else if (mode === 'exit' && tNorm <= 0) {
            finishExit();
        }
    }

    function runDone() {
        const list = doneCallbacks;
        doneCallbacks = [];
        list.forEach((fn) => fn());
    }

    // If a panel for something else is open, it moves to where the student has gone. If none is, none opens in their face.
    function arrivedByHand() {
        if (!viewShown) showView();
        const drawer = app.drawer;
        const reading = app.selected ? app.selected.body.code === model.code || app.selected.entity.code === model.code : false;
        if (drawer && drawer.isOpen() && drawer.currentView() === 'object' && !reading) select(model.code);
    }

    function finishExit() {
        restoreSky();
        sharedUniforms.uSkyFade.value = 1;
        engine.setSkyVisible(true);
        const previous = model;
        // Back by zoom, the student may well zoom straight in again: it stays ready for a while, undrawn
        const stayReady = !!hand;
        const heardOfIt = viewShown;
        const fingers = hand && pinch && pointers.size === 2 ? [...pointers] : null;
        hand = null;
        keyZoom = 0;
        viewShown = true;
        if (!stayReady) {
            disposeWorld();
            model = null;
        }
        mode = 'sky';
        canvas.style.cursor = '';
        canvas.setAttribute('aria-label', skyAria);
        app.view = 'sky';
        app.systemCode = null;
        pointers.clear();
        drag = null;
        pinch = null;
        hoverCode = null;
        if (fingers) {
            const rect = canvas.getBoundingClientRect();
            engine.givePointers(fingers.map(([id, q]) => ({ id, x: q.x - rect.left, y: q.y - rect.top })));
        }
        if (heardOfIt) bus.emit('view', { view: 'sky', code: null, from: previous ? previous.code : null });
        runDone();
        notify();
    }

    function announce() {
        const live = document.getElementById('spectroLive');
        if (!live || !model) return;
        const n = model.planets.length;
        const stars = model.stars.length === 1 ? 'a star' : `${model.stars.length} stars`;
        const planets = n === 0 ? 'no planets' : n === 1 ? 'one planet' : `${n} planets`;
        live.textContent = `In system ${model.code}: ${stars} and ${planets}. Press Escape to go back to the sky.`;
    }

    // ---------- Drawing ----------
    function drawSystem(renderer) {
        if (backdrop && backdrop.group.visible) renderer.render(backScene, camera);
        renderer.clearDepth();
        renderer.render(scene, camera);
    }

    engine.addLayer({ id: 'system', update: step });
    engine.addOverlayPass((renderer, frame, target) => {
        if (mode === 'sky' || mode === 'load' || !world) return;
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        if (useFade) {
            const w = Math.round(frame.width * frame.dpr);
            const h = Math.round(frame.height * frame.dpr);
            if (tNorm >= 1) {
                drawSystem(renderer);
            } else if (tNorm > 0) {
                if (!fadeTarget) {
                    fadeTarget = new THREE.WebGLRenderTarget(w, h, { type: target.texture.type, depthBuffer: true });
                } else if (fadeTarget.width !== w || fadeTarget.height !== h) {
                    fadeTarget.setSize(w, h);
                }
                renderer.setRenderTarget(fadeTarget);
                renderer.setClearColor(0x000000, 1);
                renderer.clear();
                drawSystem(renderer);
                renderer.setRenderTarget(target);
                fadeMaterial.uniforms.tInput.value = fadeTarget.texture;
                fadeMaterial.uniforms.uAlpha.value = smoothstep(0, 1, tNorm);
                renderer.render(fadeScene, screenCamera);
            }
        } else {
            const fade = sharedUniforms.uSkyFade.value;
            if (fade < 1) {
                dimMaterial.uniforms.uAlpha.value = 1 - fade;
                renderer.render(dimScene, screenCamera);
            }
            drawSystem(renderer);
        }
        renderer.autoClear = autoClear;
    });

    // ---------- Entering and leaving ----------
    let skyAria = canvas.getAttribute('aria-label') || '';

    function enter(code, opts = {}) {
        const resolved = app.universe.resolve(code);
        if (!resolved || !canDraw(resolved.body)) {
            if (opts.onDone) opts.onDone();
            return false;
        }
        const body = resolved.body;
        const focusCode = opts.focus && opts.focus !== true ? opts.focus
            : (resolved.path === 'planet' && opts.focus !== false ? resolved.entity.code : null);

        if (mode !== 'sky' && model && model.code === body.code) {
            // A zoom under way gives way to the button or a link
            hand = null;
            if (!viewShown) showView();
            // Already here, or on the way out of it: turn round
            if (mode === 'exit') {
                runDone();
                mode = 'enter';
                app.view = 'system';
            }
            if (opts.onDone) doneCallbacks.push(opts.onDone);
            if (mode === 'system') {
                runDone();
                if (focusCode) focusOn(focusCode);
            } else if (focusCode) {
                queuedFocus = focusCode;
            }
            return true;
        }
        if (mode !== 'sky') {
            exit({ onDone: () => enter(code, opts) });
            return true;
        }

        savedView = engine.getView();
        skyAria = canvas.getAttribute('aria-label') || skyAria;
        const alreadyReady = !!model && model.code === body.code;
        if (!alreadyReady) makeReady(body);
        selectedCode = app.selected ? app.selected.entity.code : null;
        queuedFocus = focusCode;
        doneCallbacks = opts.onDone ? [opts.onDone] : [];
        mode = 'load';
        useFade = !!app.settings.reduceMotion;
        tNorm = 0;
        app.view = 'system';
        app.systemCode = body.code;
        canvas.setAttribute('aria-label', `Planetary system ${body.code}. Drag to orbit the camera, scroll to zoom, and select a planet to study it.`);
        viewShown = !opts.hand;
        if (opts.hand) hand = opts.hand;
        else bus.emit('view', { view: 'system', code: body.code });
        notify();
        // A flight on the clock won't wait for ever on its shaders. A zoom doesn't start until they are done.
        if (!compiled) setTimeout(() => { if (model && model.code === body.code) compiled = true; }, COMPILE_WAIT_MS);
        return true;
    }

    // Builds a system and compiles what it needs. Nothing shows for it, and the student may still be in the sky.
    function makeReady(body) {
        if (world) disposeWorld();
        model = buildModel(body);
        mix = (logChoice === null ? model.startLog : logChoice) && model.logUseful ? 1 : 0;
        mixTarget = mix;
        tDays = lastTimeline && lastTimeline.code === body.code ? lastTimeline.t_days : 0;
        ensureBackdrop();
        world = buildWorld();
        positions = layout(model, tDays, mix, positions);
        compiled = false;

        // Compile before the clock starts, so a slow shader doesn't eat the first second of the flight
        const started = model;
        const go = () => {
            if (model === started) compiled = true;
        };
        camera.position.set(0, 0, FRAME * 3);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld();
        Promise.all([engine.compileInBackground(scene, camera), engine.compileInBackground(backScene, camera)]).then(go, go);
    }

    function ensureBackdrop() {
        if (backdrop) return;
        backdrop = createBackdrop(app, app.qualityLevel);
        backScene.add(backdrop.group);
    }

    // What the zoom gesture needs from here
    function bodyFor(code) {
        const resolved = app.universe.resolve(code);
        return resolved && canDraw(resolved.body) ? resolved.body : null;
    }
    const zoomInto = createZoomInto(app, {
        prepare(code) {
            if (mode !== 'sky' || (model && model.code === code)) return;
            const body = bodyFor(code);
            if (!body) return;
            if (body.planets && body.planets.length && engine.renderer) warmPlanetBakes(engine.renderer, body.planets);
            makeReady(body);
        },
        isReady: (code) => mode === 'sky' && !!model && model.code === code && compiled,
        hasReady: () => mode === 'sky' && !!model,
        dropReady() {
            if (mode !== 'sky') return;
            disposeWorld();
            model = null;
            compiled = false;
        },
        beginIn(code, moving, kind) {
            enter(code, { hand: moving, focus: false });
            if (kind === 'touch') adoptFingers();
        },
        beginOut(moving) {
            hand = moving;
            path.byHand = true;
            mode = 'exit';
        },
        enter(code) { enter(code, { focus: false }); },
        exit() { exit(); }
    });

    // A pinch that began on the sky goes on here without the fingers lifting
    function adoptFingers() {
        const rect = canvas.getBoundingClientRect();
        pointers.clear();
        engine.takePointers().forEach((p) => pointers.set(p.id, { x: p.x + rect.left, y: p.y + rect.top }));
        drag = null;
        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
        }
    }

    function exit(opts = {}) {
        if (mode === 'sky') {
            if (opts.onDone) opts.onDone();
            return;
        }
        if (opts.onDone) doneCallbacks.push(opts.onDone);
        // A zoom under way gives way to Esc, the button or a link, and from here it's a flight on the clock
        const wasHand = !!hand;
        hand = null;
        if (mode === 'exit' && !wasHand) return;
        if (mode === 'load') {
            // Never got started: just put everything back
            tNorm = 0;
            finishExit();
            return;
        }
        useFade = !!app.settings.reduceMotion;
        if (useFade) {
            // The sky has to be right before it starts to show
            restoreSky();
            sharedUniforms.uSkyFade.value = 1;
            engine.setSkyVisible(true);
        }
        mode = 'exit';
        notify();
    }

    // ---------- Things other parts of the page react to ----------
    bus.on('timeline', ({ code, t_days }) => {
        lastTimeline = { code, t_days };
        if (model && code === model.code) tDays = t_days;
    });
    bus.on('layer', ({ name, on }) => {
        if (name !== 'habitableZone' || !on || mode === 'sky' || cam.target) return;
        cam.zoom = Math.max(cam.zoom, hzReach() * 1.08);
    });
    bus.on('select', ({ code }) => { selectedCode = code; });
    bus.on('deselect', () => { selectedCode = null; });
    bus.on('quality', ({ level }) => {
        if (backdrop) backdrop.setQuality(level);
        if (!world) return;
        world.stars.forEach((s) => s.setQuality(level));
        world.planets.forEach((item) => item.handle.setQuality(level));
    });

    // Compile the small shaders while nothing is going on, so that the first flight doesn't have to wait for them.
    // The warm star is never freed: while a material uses a program, three.js keeps it for the next star to share.
    // One at every level, as Auto can change the level during a visit.
    let warmStars = [];
    let warmLine = null;
    const lockBack = new THREE.Vector3();
    const lockRight = new THREE.Vector3();
    const lockUp = new THREE.Vector3();
    const lockGap = new THREE.Vector3();
    function warmSmallPrograms() {
        const renderer = engine.renderer;
        if (!renderer) return;
        warmPlanetShaders(renderer);
        ensureBackdrop();
        engine.compileInBackground(backScene, camera);
        warmStars.forEach((star) => star.dispose());
        const warmScene = new THREE.Scene();
        warmStars = ['low', 'medium', 'high'].map((quality) => {
            const star = createStar({ teff_K: 5800, radius_Rsun: 1, stage: 'main_sequence' }, { seed: 'warm', quality });
            warmScene.add(star.group);
            return star;
        });
        if (!warmLine) warmLine = createOrbitLine([[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]], {});
        warmScene.add(warmLine.object);
        engine.compileInBackground(warmScene, camera);
    }
    bus.on('ready', () => {
        if (window.requestIdleCallback) window.requestIdleCallback(warmSmallPrograms, { timeout: 4000 });
        else setTimeout(warmSmallPrograms, 1500);
    });
    bus.on('gl-restored', warmSmallPrograms);

    // A star with planets has been picked, so a visit may be coming: start on the costly programs those planets will
    // need. Not straight away, in case the student is just clicking through the sky.
    let warmTimer = 0;
    bus.on('select', ({ resolved }) => {
        clearTimeout(warmTimer);
        const planets = resolved && resolved.body && resolved.body.planets;
        if (!planets || !planets.length || !engine.renderer) return;
        warmTimer = setTimeout(() => warmPlanetBakes(engine.renderer, planets), WARM_AFTER_SELECT_MS);
    });

    app.system = {
        enter,
        exit,
        focusPlanet(code) { focusOn(code || null); },
        // Whether the habitable zone can be shown. With no argument, for the system that is open.
        hzAvailable(code) {
            if (code) {
                const r = app.universe.resolve(code);
                return hzStatus(r ? r.body : null);
            }
            return hzStatus(model ? model.body : null);
        },
        setLogScale(on) {
            logChoice = !!on;
            mixTarget = on && model && model.logUseful ? 1 : 0;
            notify();
        },
        isLogScale: () => mixTarget > 0.5,
        logScaleUseful: () => !!(model && model.logUseful),
        getTime: () => tDays,
        getModel: () => (mode === 'sky' ? null : model),
        isFocused: () => !!cam.target,
        isBusy: () => mode === 'load' || mode === 'enter' || mode === 'exit',
        isOpening: () => !viewShown,    // A zoom has only just begun, and might yet settle back to the sky
        readout(code) {
            if (!model) return null;
            const entry = model.planets.find((e) => e.code === code);
            return entry ? keplerReadout(model, entry) : null;
        },
        onChange(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        hasSystemView,
        // Test hook: hold the flight at a fraction of its time (null lets go)
        _hold(x) { hold = x; },
        _state: () => ({ mode, tNorm, mix, dist: cam.dist, useFade, target: cam.target ? cam.target.code : null, hand: hand ? { goal: hand.goal, settling: !!hand.settling } : null, compiled, ready: mode === 'sky' && model ? model.code : null }),
        _saved: () => ({ ...savedView }),
        _starPx: () => {
            if (!world || !positions) return 0;
            const depth = tmp.set(...positions.stars[world.brightest]).distanceTo(camera.position);
            return starDrawnRadius[world.brightest] * pxPerWorldAt(depth, engine.currentFrame());
        },
        _planetsShown: () => (world ? world.planets.filter((item) => item.handle.object3d.children[0].visible).length : 0),
        _project(code) {
            const i = model.planets.findIndex((e) => e.code === code);
            return i < 0 ? null : projectToCss(positions.planets[i], engine.currentFrame());
        }
    };

    initSystemTab(app);
}
