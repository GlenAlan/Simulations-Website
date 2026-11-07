// The system view: a star opened out into its planets by a Spore-style flight.
//
// It has its own scene and camera, drawn into the engine's HDR buffer through addOverlayPass, so it shares the tone
// mapping and bloom with the sky. The sky itself is only ever looked at: a move into a system remembers the sky view
// to the digit and puts it back on the way out.
//
//   app.system.enter(code, { onDone, focus })   code: anything that shines, or one of its planets or stars
//   app.system.exit({ onDone })
//   app.system.focusPlanet(code)                fly to a planet or star; null flies back to the whole system
//   app.system.hzAvailable(code?)               { ok, reason } for that system, or else the one that's open
//   app.system.hasSystemView(body)              whether a body can be visited
//   app.system.systemOf(resolved)               what a selection would open: its body, or a cluster member as a body
//   app.system.setClock({ speed, playing, read }) what the System tab's playback is doing, in days per second. read() gives
//                                               the time every frame, for a clock whose 'timeline' events come in steps
//   app.system.timeScale()                      how much the clock is slowed just now, while a planet is in close-up
//   app.system.isOpening(), skyShows()          a zoom has only just begun; a flight is under way, with the sky on show behind it
//   app.system.setLogScale(on), isLogScale(), logScaleUseful(), getTime(), getModel(), isFocused(), isBusy(),
//   readout(code), onChange(fn); names starting with _ are hooks for tests

import * as THREE from 'three';
import { bus, select } from '../../core/state.js';
import { azAltToVec3 } from '../../core/sky.js';
import { ETA, parallaxFactor, travelPc } from '../../core/depth.js';
import { sharedUniforms } from '../shared.js';
import { wheelZoomStep } from '../engine.js';
import { createPlanetMesh, warmPlanetShaders, warmPlanetBakes } from '../planets/planet_mesh.js';
import { initSystemTab } from '../../ui/system_tab.js';
import { announce as say } from '../../ui/drawer.js';
import {
    FRAME, ORBITS_PER_SECOND, ORBITS_PER_SECOND_REDUCED, buildModel, createSizes, createSmear, drawnSizes, hasSystemView,
    hzStatus, layout, ringRadius, starRadius, planetRadius, planetOrbitPoints, planetPhase, childOrbitPoints,
    figureEightWorldPoints, keplerReadout, smearWeights, systemBodyOf, sightDirection
} from './system_model.js';
import { TRANSITION_S, HAND_ARRIVE, easeProgress, pathAt, stagesAt, smoothstep, handSkyLog, handOffCentre, travelAt, domeAt } from './transition.js';
import { createZoomInto } from './zoom_into.js';
import { createStar, surfaceColour } from './star_surface.js';
import { createHole, createPulsarBeams } from './remnants.js';
import { holeLook, createDustRing } from './nucleus_view.js';
import { createOrbitLine, createOrbitGlow } from './orbit_lines.js';
import { createBackdrop } from './backdrop.js';
import { createMassStream } from './mass_stream.js';
import { starBandLook, createFlares, FLARE_GAIN, bandRgb } from './band_look.js';
import { createComets } from './comets.js';
import { hashString } from '../../core/rng.js';

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
const VIEW_SHOWN_AT = 0.4;          // A zoom this far in would settle in, not back, so the rest of the page can hear about it
const CARRIED_PAUSE_MS = 450;       // A pause this long ends the zoom that carried the student in (see applyZoom)
const HOLE_APPROACH = 1.5;          // How far off a zoom into a black hole's system starts, as a share of where it ends
const HOLE_SKY_ZOOM = 1.25;         // How far the sky narrows meanwhile
const HOLE_NEAR_FOV = 1;            // The sky draws a black hole about as big as this view does at a field of view like this
const DAY_SIDE = 0.65;              // How far round from the star a close-up looks at a planet (radians)
const CLOSE_UP_ORBITS_PER_S = 0.02; // A planet in close-up goes round no faster than this: it's there to be looked at
const CLOSE_UP_SLOWDOWN = 0.1;      // ... and the clock runs at least this much slower

// The soft halo round a planet that's only a few pixels across, in its own colour
const HALO_VERTEX = /* glsl */`
attribute vec3 aColour;
attribute float aSize;
attribute float aAlpha;
varying vec3 vColour;
varying float vAlpha;
void main() {
    vColour = aColour;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aAlpha > 0.003 ? aSize : 0.0;
}`;
const HALO_FRAGMENT = /* glsl */`
varying vec3 vColour;
varying float vAlpha;
void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float g = exp(-r * r * 5.0) * (1.0 - smoothstep(0.8, 1.0, r));
    gl_FragColor = vec4(vColour * g * vAlpha, 1.0);
}`;

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
    let carriedIn = false;      // A zoom carried the student in, and is still going: see applyZoom
    let settleAfterCarry = false; // ... and once it stops, the camera settles where the button's flight leaves it
    let lastZoomAt = -Infinity; // performance.now of the last zoom step in the system
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
    let aimCode = null;         // Where [ and ] have got to, with the drawer closed. Enter selects it.
    const listeners = new Set(); // The tab, to hear about changes that aren't on the bus

    // What the clock is doing, for the smears. Its speed comes from the tab's playback; any other panel moving this
    // system's clock is measured as it happens. A clock shared with other views may send its time in steps, so read gives
    // the time as it really is, every frame.
    const clock = { speed: 0, playing: false, read: null, lastRead: 0, otherDays: 0, otherRate: 0, shown: 0 };

    // What the student controls. Everything except the flight goes through this.
    const cam = {
        az: 0, el: HOME_EL, dist: 40,
        azT: 0, elT: HOME_EL, distT: 40,
        zoom: 1,                // Multiplies the fit distance in the whole-system view
        focus: new THREE.Vector3(),
        target: null,           // null, or { kind: 'planet'|'star'|'node', index|node, code }
        flight: null,
        swung: false            // The student has turned the camera since this close-up began, so it stops turning itself
    };
    let fitSmooth = null;

    const notify = () => listeners.forEach((fn) => fn());

    // ---------- Building a system ----------
    function colourOfChild(child) {
        const list = child.members.map((i) => surfaceColour(model.stars[i].star.teff_K));
        return [0, 1, 2].map((c) => list.reduce((sum, rgb) => sum + rgb[c], 0) / list.length);
    }

    function buildWorld() {
        const quality = app.qualityLevel;
        const group = new THREE.Group();
        const hole = model.body.black_hole;
        const giant = holeLook(model.body);     // A galaxy's own black hole (nucleus_view.js)
        const stars = model.stars.map((s) => {
            const isHole = s.star.stage === 'black_hole';
            const make = isHole ? createHole : createStar;
            const star = make(s.star, { seed: s.code, quality, jets: isHole && !!(hole && hole.jets), ...(isHole && giant ? giant : {}) });
            group.add(star.group);
            return star;
        });
        const dust = giant ? createDustRing(model.body, stars[0], quality) : null;
        if (dust) group.add(dust.object);
        // How each star shows in each band, and the flares of an active M dwarf
        const accretor = model.stream && !model.stream.ontoHole ? model.stream.accretor : -1;
        const bandLooks = model.stars.map((s, i) => (s.star.stage === 'black_hole' ? null : starBandLook(s, i === accretor)));
        const flares = bandLooks.map((look, i) => (look && look.flares ? createFlares(hashString(model.stars[i].code)) : null));
        const brightest = model.stars.reduce((best, s, i) => (s.star.luminosity_Lsun > model.stars[best].star.luminosity_Lsun ? i : best), 0);

        let beams = null;
        if (model.body.neutron_star && model.body.neutron_star.pulsar) {
            beams = createPulsarBeams(model.body, sightDirection(model));   // Turning as the sky shows it
            group.add(beams.object);
        }

        const planets = model.planets.map((entry) => {
            const handle = makePlanet(entry, quality, group);
            const points = planetOrbitPoints(entry.planet);
            const line = createOrbitLine(points, { opacity: 0.25, width: 1.4, trail: 0.8, colour: [0.5, 0.66, 0.95] });
            const smear = line.withGeometry({ soft: true, opacity: 0, width: 6, colour: handle.meanColour });
            smear.object.visible = false;
            group.add(line.object, smear.object);
            return { handle, line, smear, points, entry };
        });

        // One line per star or sub-pair, round the centre of its group
        const starLines = [];
        model.nodes.forEach((node) => {
            if (!node.children || node.flat) return;
            node.children.forEach((child) => {
                const points = childOrbitPoints(model, node, child);
                const line = createOrbitLine(points, { opacity: node === model.root && node.a_AU > 10 ? 0.28 : 0.38, width: 1.2, colour: [0.85, 0.78, 0.62], trail: 1.2 });
                const colour = colourOfChild(child);
                const smear = line.withGeometry({ soft: true, opacity: 0, width: 8, colour });
                smear.object.visible = false;
                const glow = createOrbitGlow(points, colour);
                group.add(line.object, smear.object, glow.object);
                const reachAU = Math.max(...points.map((q) => Math.hypot(q[0], q[1], q[2])));
                starLines.push({ line, smear, glow, points, node, child, reachAU });
            });
        });

        // The halos are one object: they change every frame, and there are only a few of them
        let halo = null;
        if (model.planets.length) {
            const n = model.planets.length;
            const geometry = new THREE.BufferGeometry();
            const place = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
            const size = new THREE.BufferAttribute(new Float32Array(n), 1);
            const alpha = new THREE.BufferAttribute(new Float32Array(n), 1);
            place.setUsage(THREE.DynamicDrawUsage);
            size.setUsage(THREE.DynamicDrawUsage);
            alpha.setUsage(THREE.DynamicDrawUsage);
            const colours = new Float32Array(n * 3);
            planets.forEach((item, j) => colours.set(item.handle.meanColour, j * 3));
            geometry.setAttribute('position', place);
            geometry.setAttribute('aSize', size);
            geometry.setAttribute('aAlpha', alpha);
            const colour = new THREE.BufferAttribute(colours, 3);
            geometry.setAttribute('aColour', colour);
            const material = new THREE.ShaderMaterial({
                toneMapped: false,
                transparent: true,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
                vertexShader: HALO_VERTEX,
                fragmentShader: HALO_FRAGMENT
            });
            const object = new THREE.Points(geometry, material);
            object.frustumCulled = false;
            object.renderOrder = 4;
            group.add(object);
            halo = { object, geometry, material, place, size, alpha, colour };
        }

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
            // Before the planets, which then cover it: drawn after them it would slice through any planet it crosses
            mesh.renderOrder = -1;
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

        const comets = model.comets.length ? createComets(model, mix) : null;
        if (comets) group.add(comets.group);
        const cometLabels = model.comets.map((e) => makeLabel(e.code));

        scene.add(group);
        const steady = new Map(model.nodes.map((n) => [n, [0, 0, 0]]));
        return {
            group, stars, planets, starLines, eight, hz, stream, brightest, starLabels, planetLabels, beams, halo, steady,
            bandLooks, flares, bandSeen: null, comets, cometLabels, dust,
            starsAt: model.stars.map((_, i) => steady.get(model.nodes.find((n) => n.index === i))),
            lastStars: new Float64Array(model.stars.length * 3),
            lastPlanets: new Float64Array(model.planets.length * 3),
            sizes: createSizes(model),
            smear: createSmear(model),
            parents: new Map(model.nodes.flatMap((n) => (n.children || []).map((c) => [c, n])))
        };
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
            p.smear.dispose();
            p.line.dispose();
        });
        world.starLines.forEach((s) => {
            s.glow.dispose();
            s.smear.dispose();
            s.line.dispose();
        });
        if (world.beams) world.beams.dispose();
        if (world.dust) world.dust.dispose();
        if (world.halo) {
            world.halo.geometry.dispose();
            world.halo.material.dispose();
        }
        if (world.eight) {
            world.eight.glow.dispose();
            world.eight.core.dispose();
        }
        if (world.hz) {
            world.hz.material.dispose();
            world.hz.mesh.geometry.dispose();
        }
        if (world.stream) world.stream.dispose();
        if (world.comets) world.comets.dispose();
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
        // closer than the centre, so it needs d >= R (sin el / tan + cos el) to stay on screen. Sideways, whatever's a
        // little nearer the camera than the middle reaches furthest out: that's the square root.
        const fill = 0.93;
        const a = Math.abs(el);
        const needH = Math.hypot(FRAME / (fill * tanH), FRAME * Math.cos(a));
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
        const fill = stage === 'white_dwarf' || stage === 'neutron_star' ? 0.13 : (stage === 'giant' || stage === 'supergiant') ? 0.36 : 0.27;
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
        path = { star, dAz, fovEnd, el0, az0, az1, d0, dClose, dir: azAltToVec3(star.az, star.alt), pc: travelPc(model.body), byHand: !!hand, skyLog: undefined, locked: false, roll: 0 };
        if (hand) lockStarsToSky(frame, fit);

        cam.az = az1;
        cam.azT = az1;
        cam.el = HOME_EL;
        cam.elT = HOME_EL;
        cam.zoom = path.endZoom || 1;
        cam.focus.set(0, 0, 0);
        cam.target = null;
        cam.flight = null;
        fitSmooth = fit;
        cam.dist = fit * cam.zoom;
        cam.distT = cam.dist;

        // Line the faint sky's catalogue up with the line of sight, so what's behind the star is what was behind it
        const skyQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(star.alt * RAD, -star.az * RAD, 0, 'YXZ'));
        const sysPos = new THREE.Vector3(Math.cos(el0) * Math.sin(az0), Math.sin(el0), Math.cos(el0) * Math.cos(az0));
        const look = new THREE.Matrix4().lookAt(sysPos, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
        const sysQ = new THREE.Quaternion().setFromRotationMatrix(look);
        backdrop.setOrientation(sysQ.multiply(skyQ.invert()));
    }

    const lockBack = new THREE.Vector3();
    const lockRight = new THREE.Vector3();
    const lockUp = new THREE.Vector3();
    const lockGap = new THREE.Vector3();

    // Under a hand a multiple's stars start right where the sky has already drawn them apart, and stay on them: the camera
    // starts as far off as puts the two widest parts of its first split that far apart, turned to match, and comes in just
    // as the sky zooms. A pair lands exactly. The sky draws the spacing in a triple or two pairs in its own way, so they land
    // close, each part round its place on the sky.
    function lockStarsToSky(frame, fit) {
        if (model.body.black_hole) {
            lockHoleToSky(fit);
            return;
        }
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
        const { across, along } = seenFromPathStart(gap);
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

    // The sky has already drawn a black hole close up by the time a zoom gets here, about as near as the system's own view:
    // so there's next to no flying, just one coming up through the other, with its companion on the same side.
    function lockHoleToSky(fit) {
        if (savedView.fov > HOLE_NEAR_FOV) return;
        const holes = engine.getLayer('black_holes');
        const angle = holes && holes.companionAngle ? holes.companionAngle(model.code) : null;
        path.d0 = fit * HOLE_APPROACH;
        path.skyLog = Math.log(HOLE_SKY_ZOOM);
        // Better still, from the sky's own size: the hole starts exactly as big as the sky draws its disc, and on the way in
        // it's never drawn smaller than that, so zooming in can't shrink it. Its companion may then be off to the side on
        // arrival; zooming out brings it in.
        const discDeg = holes && holes.discDeg ? holes.discDeg(model.code) : 0;
        if (discDeg > 0) {
            const frame = engine.currentFrame();
            const skyPx = (discDeg * 0.5 * RAD * frame.height * 0.5 * parallaxFactor(model.body.depth || 0, savedView.fov)) / Math.tan(savedView.fov * RAD * 0.5);
            path.d0 = (starRadius(model, 0, mix) * frame.height) / (2 * TAN_V * skyPx);
            path.endZoom = Math.max(minDistance() / fit, Math.min(1, path.d0 / (HOLE_SKY_ZOOM * fit)));
        }
        if (angle === null) return;
        const [hole, star] = positions.stars;
        const { across, along } = seenFromPathStart(lockGap.set(star[0] - hole[0], star[1] - hole[1], star[2] - hole[2]));
        path.roll = angle - Math.atan2(along, across);
    }

    // A distance in the system, as it lies across the view from where the path begins
    function seenFromPathStart(gap) {
        const { el0, az0 } = path;
        lockBack.set(Math.cos(el0) * Math.sin(az0), Math.sin(el0), Math.cos(el0) * Math.cos(az0));
        lockRight.set(0, 1, 0).cross(lockBack).normalize();
        lockUp.copy(lockBack).cross(lockRight);
        return { across: gap.dot(lockRight), along: gap.dot(lockUp) };
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
        aimCode = null;
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
            if (drag.moved >= 6) cam.swung = true;
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

    // Arrow keys orbit and +/- zoom, while the sky stays put. [ and ] step through what's in the system, and Enter
    // selects where they've got to, as on the sky. Esc belongs to the shell.
    window.addEventListener('keydown', (e) => {
        if (!inSystem() || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && t !== document.body && t !== canvas && (t.closest('input, select, textarea, button, summary, a') || t.closest('#simulationControlsPanel'))) return;
        const step = 6 * RAD;
        let used = true;
        if (e.key === 'ArrowLeft') {
            cam.azT += step;
            cam.swung = true;
        } else if (e.key === 'ArrowRight') {
            cam.azT -= step;
            cam.swung = true;
        } else if (e.key === 'ArrowUp') {
            cam.elT = Math.min(88 * RAD, cam.elT + step);
            cam.swung = true;
        } else if (e.key === 'ArrowDown') {
            cam.elT = Math.max(-80 * RAD, cam.elT - step);
            cam.swung = true;
        } else if (e.key === '+' || e.key === '=') zoomKey(-1);
        else if (e.key === '-' || e.key === '_') zoomKey(1);
        else if (e.key === ']' || e.key === 'PageDown') {
            if (!e.repeat) walk(1);
        } else if (e.key === '[' || e.key === 'PageUp') {
            if (!e.repeat) walk(-1);
        } else if (e.key === 'Enter' && canInteract()) chooseAim();
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

    function nameOf(code) {
        if (model.planets.some((p) => p.code === code)) return 'Planet';
        if (model.comets.some((p) => p.code === code)) return 'Comet';
        const star = model.stars.find((s) => s.code === code);
        return star && star.star.stage === 'black_hole' ? 'Black hole' : star && star.star.stage === 'neutron_star' ? 'Neutron star' : 'Star';
    }

    function walk(direction) {
        if (!canInteract()) return;
        const list = [...model.stars.map((s) => s.code), ...model.planets.map((p) => p.code), ...model.comets.map((p) => p.code)];
        const here = list.indexOf(aimCode || selectedCode);
        const next = here < 0 ? (direction > 0 ? list[0] : list[list.length - 1]) : list[(here + direction + list.length) % list.length];
        aimCode = next;
        if (app.drawer.isOpen() && app.drawer.currentView() === 'object') {
            select(next);
            focusOn(next);
        } else {
            say(`${nameOf(next)} ${next}. Press Enter to select it.`);
        }
    }

    function chooseAim() {
        const code = aimCode || selectedCode || model.stars[world.brightest].code;
        aimCode = null;
        select(code);
        focusOn(code);
        app.drawer.focusContent();
    }

    function applyZoom(factor) {
        if (hand) {
            hand.push(Math.log(factor));
            return;
        }
        if (!canInteract()) return;
        // The zoom that carried the student in stops at the system's own framing, as the button's flight does: the rest of
        // that gesture's steps in go no further. A pause, or a step out, and zooming works as usual.
        const now = performance.now();
        if (carriedIn && (now - lastZoomAt > CARRIED_PAUSE_MS || factor > 1)) carriedIn = false;
        lastZoomAt = now;
        if (carriedIn) return;
        settleAfterCarry = false;
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
        if (t && t.kind === 'comet') return FRAME * 0.02;
        return Math.max(...model.stars.map((_, i) => starRadius(model, i, mix))) * 1.5;
    }

    // Screen-space picking: planets win over the star behind them, and the radius is generous on purpose.
    // Something merged into its smear is picked by its smear: there's no telling where on it the body is just now.
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
        const fromRing = (object, points) => {
            let d = Infinity;
            for (let k = 0; k < points.length; k += 3) {
                v.set(points[k][0], points[k][1], points[k][2]).applyMatrix4(object.matrixWorld).project(camera);
                if (v.z > 1) continue;
                d = Math.min(d, Math.hypot((v.x * 0.5 + 0.5) * frame.width - x, (-v.y * 0.5 + 0.5) * frame.height - y));
            }
            return d;
        };
        const sizes = world.sizes;
        const stars = model.stars.map((s, i) => ({ code: s.code, ...onScreen(positions.stars[i], sizes.stars[i]) }));
        let best = null;
        let bestD = radiusPx;
        const offer = (d, code) => {
            if (d < bestD) {
                bestD = d;
                best = { code };
            }
        };
        const consider = (q, code, rank) => {
            if (q.ok) offer(Math.max(0, Math.hypot(q.x - x, q.y - y) - q.r) + rank, code);
        };
        model.planets.forEach((entry, i) => {
            if (Math.max(world.smear.planets[i], world.smear.planetAbove[i]) > 0.5) {
                offer(fromRing(world.planets[i].line.object, world.planets[i].points), entry.code);
                return;
            }
            const q = onScreen(positions.planets[i], sizes.planets[i]);
            const hidden = stars.some((st) => st.depth < q.depth && Math.hypot(st.x - q.x, st.y - q.y) < st.r);
            if (!hidden) consider(q, entry.code, 0);
        });
        const comet = world.comets ? world.comets.pick(x, y, radiusPx) : null;
        if (comet) offer(comet.d, comet.code);
        stars.forEach((st, i) => {
            if (world.smear.stars[i] <= 0.5) {
                consider(st, st.code, 6);
                return;
            }
            const line = world.starLines.find((l) => l.child.index === i);
            if (line) offer(fromRing(line.line.object, line.points) + 6, st.code);
        });
        return best;
    }

    // ---------- Focus flights ----------
    function targetOf(code) {
        if (!model || !code) return null;
        const pi = model.planets.findIndex((e) => e.code === code);
        if (pi >= 0) return { kind: 'planet', index: pi, code };
        const ci = model.comets.findIndex((e) => e.code === code);
        if (ci >= 0) return { kind: 'comet', index: ci, code };
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

    // How far each orbit has merged into its smear, from how fast the clock is going. Then where each part of the tree can
    // be said to be: where it is, unless its orbit has merged, when it's no one place and counts as being at what it goes
    // round. The camera holds on that, and sizes are worked out from it, as neither must jump about after a blur.
    function settleOrbits(frame) {
        const cap = app.settings.reduceMotion ? ORBITS_PER_SECOND_REDUCED : ORBITS_PER_SECOND;
        clock.otherRate = Math.max(frame.dt > 0 ? clock.otherDays / frame.dt : 0, clock.otherRate * Math.exp(-frame.dt * 6));
        clock.otherDays = 0;
        const rate = Math.max(clock.playing ? clock.speed * timeScale() : 0, clock.otherRate);
        clock.shown = app.settings.reduceMotion ? rate : Math.max(rate, clock.shown * Math.exp(-frame.dt * 8));
        smearWeights(model, clock.shown, cap, world.smear);
        // Parents come before their children in this list
        model.nodes.forEach((node) => {
            const out = world.steady.get(node);
            const here = positions.nodes.get(node);
            const parent = world.parents.get(node);
            const entry = parent ? world.smear.nodes.get(parent) : null;
            const w = entry ? Math.max(entry.own, entry.above) : 0;
            const there = parent ? world.steady.get(parent) : here;
            for (let k = 0; k < 3; k++) out[k] = here[k] + (there[k] - here[k]) * w;
        });
    }

    function targetPosition(t) {
        if (!t || !positions) return [0, 0, 0];
        if (t.kind === 'planet') return positions.planets[t.index];
        if (t.kind === 'comet') return world.comets.items[t.index].world;
        if (t.kind === 'star') return world.starsAt[t.index];
        return world.steady.get(t.node);
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
        // A comet: its tail across most of the view, or a close look at its head if it has none just now
        if (t.kind === 'comet') return Math.max(world.comets.items[t.index].tailWorld, FRAME * 0.06) / (1.05 * TAN_V * Math.min(1, aspect));
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
        cam.swung = false;
        if (duration === 0) {
            cam.target = target;
            if (target && target.kind === 'planet') {
                faceLitSide(target);
                cam.elT = Math.max(10 * RAD, Math.min(32 * RAD, cam.elT));
            }
            if (target && target.kind === 'comet') faceTail(target);
            cam.zoom = zoomAfter;
            cam.dist = toDist;
            cam.distT = toDist;
            cam.flight = null;
            notify();
            return;
        }
        const leaving = cam.target && cam.target.kind === 'planet' ? cam.target.index : -1;
        cam.flight = { t: 0, duration, from: cam.focus.clone(), fromDist: cam.dist, toDist, target, zoomAfter, leaving };
        cam.target = target;
        if (target && target.kind === 'planet') {
            faceLitSide(target);
            cam.elT = Math.max(10 * RAD, Math.min(32 * RAD, cam.elT));
        }
        if (target && target.kind === 'comet') faceTail(target);
        notify();
    }

    // A planet is the point of a close-up, so look at its day side, with the star over the viewer's shoulder. Near a star
    // that's big beside its orbit, look from further round, so that the star isn't in the way.
    function faceLitSide(target) {
        const p = positions.planets[target.index];
        const sun = world.starsAt[world.brightest];
        const towardsSun = Math.atan2(sun[0] - p[0], sun[2] - p[2]);
        const gap = Math.hypot(sun[0] - p[0], sun[2] - p[2]);
        const clear = Math.asin(Math.min(0.95, (1.25 * starRadius(model, world.brightest, mix)) / Math.max(gap, 1e-6)));
        cam.azT = cam.az + wrapPi(towardsSun + Math.max(DAY_SIDE, clear) - cam.az);
    }

    // A comet is looked at side-on to its tails, which point straight away from the star, so they show at their full length
    function faceTail(target) {
        const d = world.comets.items[target.index].dir;
        // Of the two side-on views, the one nearer where the camera is
        const turn = wrapPi(Math.atan2(-d[2], d[0]) - cam.az);
        cam.azT = cam.az + (Math.abs(turn) <= Math.PI / 2 ? turn : wrapPi(turn + Math.PI));
        cam.elT = 18 * RAD;
    }

    // The planet that sizes are being worked out around: the one in focus, or the one a flight is just leaving
    function focusIndex() {
        if (cam.target && cam.target.kind === 'planet') return cam.target.index;
        return cam.flight && cam.flight.leaving >= 0 ? cam.flight.leaving : -1;
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

    // Fits the whole-system view to the habitable zone's edge, when that's on and would be out of shot, or lost in it
    function frameZone() {
        if (!model || !model.hz || !app.layers.habitableZone || cam.target || !fitSmooth) return;
        const want = (ringRadius(model, model.hz.outer, mixTarget) / FRAME) * 1.08;
        if (want > cam.zoom || want < cam.zoom * 0.2) cam.zoom = Math.max(minDistance() / fitSmooth, want);
    }

    // ---------- The frame ----------
    const tmp = new THREE.Vector3();
    const tmp2 = new THREE.Vector3();
    const sunDir = new THREE.Vector3();
    const sizeView = { cam: [0, 0, 0], fwd: [0, 0, -1], f: 1, minSize: 1, planets: 1, focus: -1 };
    let sysFrame = null;

    const poseAsk = { d0: 1, dClose: 1, dEnd: 1, el0: 0, el1: HOME_EL, az0: 0, az1: 0, arrive: 0 };
    const poseOut = { dist: 1, el: 0, az: 0 };

    function stepCamera(frame, stage) {
        const dt = frame.dt;
        const aspect = frame.width / Math.max(1, frame.height);
        const k = app.settings.reduceMotion ? 1 : 1 - Math.exp(-dt * 12);

        // A close-up keeps to the day side, whatever the orbit does, until the student takes the camera round
        if (cam.target && cam.target.kind === 'planet' && !cam.swung) faceLitSide(cam.target);

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
            poseAsk.d0 = path.d0;
            poseAsk.dClose = path.byHand ? cam.dist : path.dClose;
            poseAsk.dEnd = path.byHand ? cam.dist : Math.max(path.dClose * 1.01, fitSmooth);
            poseAsk.arrive = path.byHand ? HAND_ARRIVE : 0;
            poseAsk.el0 = path.el0;
            poseAsk.az0 = path.az0;
            poseAsk.az1 = path.az1;
            const pose = pathAt(easeProgress(tNorm), poseAsk, poseOut);
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
            if (engine.setLensShare) engine.setLensShare(handOffCentre(tNorm));
            engine.flyView(from.az + path.dAz * centre, from.alt + (path.star.alt - from.alt) * centre, fov);
        } else {
            const alt = from.alt + (path.star.alt - from.alt) * stage.skyCentre;
            const az = from.az + path.dAz * stage.skyCentre;
            const fov = Math.exp(Math.log(from.fov) + (Math.log(path.fovEnd) - Math.log(from.fov)) * stage.skyZoom);
            // The star comes to the middle of the canvas, wherever the drawer had left the sky's axis
            if (engine.setLensShare) engine.setLensShare(1 - stage.skyCentre);
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

    // The sky's own travel towards the system, as the flight has got to p (see travelAt), or none at all
    function setTravel(p, crowded) {
        const s = p > 0 ? travelAt(p, path.pc, crowded) : 0;
        sharedUniforms.uTravel.value.set(path.dir[0] * s, path.dir[1] * s, path.dir[2] * s, s > 0 ? path.pc : 0);
        sharedUniforms.uDomeFade.value = domeAt(s, path.pc);
    }

    function stopTravel() {
        sharedUniforms.uTravel.value.set(0, 0, 0, 0);
        sharedUniforms.uDomeFade.value = 1;
    }

    function restoreSky() {
        stopTravel();
        if (engine.setLensShare) engine.setLensShare(1);
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

    // How fast something is going across the screen because of its orbit, not because the student is turning the camera.
    // Whatever the camera is following isn't going anywhere.
    function orbitPxPerSecond(last, i, p, f, z, dt) {
        const k = i * 3;
        const x = p[0] - cam.focus.x;
        const y = p[1] - cam.focus.y;
        const w = p[2] - cam.focus.z;
        const moved = Math.hypot(x - last[k], y - last[k + 1], w - last[k + 2]);
        last[k] = x;
        last[k + 1] = y;
        last[k + 2] = w;
        return dt > 0 && !cam.flight ? (moved * f) / (z * dt) : 0;
    }

    // A disc big enough to fill the screen, swept across its own width several times a second, is a flash over a wide area,
    // however few orbits it's doing. It gets out of the way until it's slower or further off.
    function sweeping(pxPerSecond, pxRadius) {
        return smoothstep(1.5, 3, pxPerSecond / (2 * Math.max(pxRadius, 1))) * smoothstep(40, 80, pxRadius);
    }

    // ---------- Bands ----------
    const HOLE_LIGHT = [0.05, 0.5, 1, 0.6, 1.5];   // A black hole merged into its smear: its disc's light, roughly
    const bandTmp = [0, 0, 0];

    function childBandColour(child, w) {
        const out = [0, 0, 0];
        child.members.forEach((i) => {
            const look = world.bandLooks[i];
            const rgb = bandRgb(w, surfaceColour(model.stars[i].star.teff_K), look ? look.surface : HOLE_LIGHT, bandTmp);
            for (let c = 0; c < 3; c++) out[c] += rgb[c] / child.members.length;
        });
        return out;
    }

    // Everything in the system in the sky's band, cross-fading as the sky does (band_look.js). Strengths every frame, for
    // the flares; colours set once only when the band changes.
    function updateBands(frame) {
        const w = sharedUniforms.uBandW.value;
        const reduce = app.settings.reduceMotion;
        world.stars.forEach((star, i) => {
            const look = world.bandLooks[i];
            if (!look) {
                star.setBand(w);
                return;
            }
            const flare = world.flares[i] ? world.flares[i].step(frame.dt, reduce) : 0;
            let surface = 0;
            let corona = 0;
            for (let b = 0; b < 5; b++) {
                surface += w[b] * look.surface[b] * (1 + flare * FLARE_GAIN.surface[b]);
                corona += w[b] * look.corona[b] * (1 + flare * FLARE_GAIN.corona[b]);
            }
            star.setBandStrength(surface, corona);
        });
        if (world.beams) world.beams.setBand(w);
        const seen = world.bandSeen;
        let same = !!seen;
        for (let b = 0; b < 5 && same; b++) same = seen[b] === w[b];
        if (same) return;
        world.bandSeen = w.slice();
        world.planets.forEach((item, j) => {
            const rgb = bandRgb(w, item.handle.meanColour, item.handle.bandValues, bandTmp);
            if (world.halo) world.halo.colour.setXYZ(j, rgb[0], rgb[1], rgb[2]);
            item.smear.setColour(rgb);
        });
        if (world.halo) world.halo.colour.needsUpdate = true;
        world.starLines.forEach((line) => {
            const rgb = childBandColour(line.child, w);
            line.smear.setColour(rgb);
            line.glow.setColour(rgb);
        });
    }

    function updateWorld(frame, stage, starNdc) {
        const reduce = app.settings.reduceMotion;
        updateBands(frame);
        const seen = starNdc ? starNdc.seen : 1;
        const showReveal = stage.reveal * seen;
        const camPos = camera.position;
        const f = frame.height / (2 * TAN_V);
        const { sizes, smear } = world;

        sysFrame = { ...frame, camera, view: 'system' };

        // Where the camera is decides how big everything is drawn
        const e = camera.matrixWorld.elements;
        sizeView.cam[0] = camPos.x;
        sizeView.cam[1] = camPos.y;
        sizeView.cam[2] = camPos.z;
        sizeView.fwd[0] = -e[8];
        sizeView.fwd[1] = -e[9];
        sizeView.fwd[2] = -e[10];
        sizeView.f = f;
        sizeView.corner = Math.atan(TAN_V * Math.hypot(1, frame.width / Math.max(1, frame.height)));
        sizeView.minSize = stage.minSize;
        sizeView.planets = stage.planets;
        sizeView.focus = focusIndex();
        sizeView.starsAt = world.starsAt;
        sizeView.gone = smear.planets;
        drawnSizes(model, positions, mix, sizeView, sizes);

        // Stars
        world.stars.forEach((star, i) => {
            const p = positions.stars[i];
            star.group.position.set(p[0], p[1], p[2]);
            const s = model.stars[i];
            const drawn = sizes.stars[i];
            const pxRadius = (drawn * f) / Math.max(sizes.starZ[i], drawn, 1e-6);
            star.setRadius(drawn);
            const pxPerSecond = orbitPxPerSecond(world.lastStars, i, p, f, Math.max(sizes.starZ[i], drawn, 1e-6), frame.dt);
            const disc = (1 - smear.stars[i]) * (1 - sweeping(pxPerSecond, pxRadius));

            // Tides: this star leans towards its partner
            const tide = model.tides[i];
            if (tide) {
                const q = positions.nodes.get(tide.other);
                tmp.set(q[0] - p[0], q[1] - p[1], q[2] - p[2]).normalize();
                const isDonor = model.stream && !model.stream.wind && model.stream.donor === i;   // A wind's star keeps its shape
                star.setTide(tmp.x, tmp.y, tmp.z, Math.max(tide.stretch, isDonor ? 0.07 : 0), isDonor ? 0.3 : 0);
            }
            if (star.setCompanion && model.stream) {
                const q = positions.stars[model.stream.donor];
                star.setCompanion(q[0], q[1], q[2]);
            }

            const sharp = s.star.stage === 'white_dwarf' || s.star.stage === 'neutron_star';
            star.update({
                dt: frame.dt,
                camera,
                reveal: showReveal * disc,
                // A star drawn only a few pixels wide still needs to read as a light, not a dot
                pointGlow: (stage.pointGlow * seen + stage.minSize * 0.5 * (1 - smoothstep(2.5, 11, pxRadius))) * disc,
                glowPx: 26 * frame.dpr * (sharp ? 1.6 : 1),
                reduceMotion: reduce,
                pxRadius,
                blur: smear.starBlur[i],
                pxPerSecond,
                dpr: frame.dpr
            });
        });
        if (world.beams) {
            world.beams.update({ dt: frame.dt, reveal: showReveal, reduceMotion: reduce, radius: sizes.stars[0] });
        }
        if (world.dust) world.dust.update({ reveal: showReveal * (1 - smear.stars[0]), radius: sizes.stars[0], position: positions.stars[0] });

        // Planets. While one is in focus, any others in front of it or beside it stand back.
        const focus = sizeView.focus;
        let focusX = 0;
        let focusY = 0;
        let focusPx = 0;
        if (focus >= 0) {
            const q = positions.planets[focus];
            tmp.set(q[0], q[1], q[2]).project(camera);
            focusX = (tmp.x * 0.5 + 0.5) * frame.width;
            focusY = (-tmp.y * 0.5 + 0.5) * frame.height;
            focusPx = (sizes.planets[focus] * f) / Math.max(sizes.planetZ[focus], 1e-6);
        }
        const sun = world.starsAt[world.brightest];
        world.planets.forEach((item, i) => {
            const p = positions.planets[i];
            const obj = item.handle.object3d;
            const drawn = sizes.planets[i];
            const z = Math.max(sizes.planetZ[i], 1e-6);
            const pxRadius = (drawn * f) / z;
            const own = smear.planets[i];
            const above = smear.planetAbove[i];
            const passing = sweeping(orbitPxPerSecond(world.lastPlanets, i, p, f, z, frame.dt), pxRadius);

            let standBack = 1;
            if (focus >= 0 && i !== focus) {
                tmp.set(p[0], p[1], p[2]).project(camera);
                const apart = Math.hypot((tmp.x * 0.5 + 0.5) * frame.width - focusX, (-tmp.y * 0.5 + 0.5) * frame.height - focusY);
                standBack = 0.12 + 0.88 * smoothstep(1.1, 3.2, apart / Math.max(focusPx + pxRadius, 1));
            }

            const opacity = stage.planets * (1 - Math.max(own, above, passing)) * standBack;
            obj.visible = opacity > 0.001;
            obj.position.set(p[0], p[1], p[2]);
            item.handle.setOpacity(opacity);
            obj.scale.setScalar(drawn);

            sunDir.set(sun[0] - p[0], sun[1] - p[1], sun[2] - p[2]).normalize();
            // A few pixels of night side would be a black dot on a dark sky, so a small planet is lit from nearer the
            // viewer. Its true phase comes back as it grows big enough to be seen properly.
            const flat = 1 - smoothstep(16, 70, pxRadius);
            if (flat > 0) {
                tmp.set(camPos.x - p[0], camPos.y - p[1], camPos.z - p[2]).normalize();
                sunDir.lerp(tmp, flat * 0.8).normalize();
            }
            item.handle.update(sysFrame, sunDir);

            if (world.halo) {
                world.halo.place.setXYZ(i, p[0], p[1], p[2]);
                world.halo.size.setX(i, (pxRadius * 2 + 7) * 2 * frame.dpr);
                world.halo.alpha.setX(i, opacity * 0.5 * (1 - smoothstep(10, 26, pxRadius)));
            }

            const c = positions.centres[i];
            const isSel = item.entry.code === selectedCode;
            const ring = ringRadius(model, item.entry.planet.orbit_AU, mix);
            item.line.object.position.set(c[0], c[1], c[2]);
            item.line.object.scale.setScalar(ring);
            // A line carried on a blur would jump about with it, so it goes too
            item.line.object.visible = above < 0.999;
            item.line.set({
                draw: stage.orbits,
                // No bright trail on a blur: it would race round the ring
                head: own > 0 ? 0 : planetPhase(item.entry.planet, tDays),
                trail: 0.8 * (1 - own),
                opacity: (1 - above) * (focus >= 0 ? 0.6 : 1) * (cam.target && cam.target.code === item.entry.code ? 0.3 : isSel ? 0.7 : 0.25),
                width: (isSel ? 2.2 : 1.4) * frame.dpr
            });
            const smearOpacity = own * (1 - above) * stage.orbits * standBack * 0.42;
            item.smear.object.visible = smearOpacity > 0.002;
            if (item.smear.object.visible) {
                item.smear.object.position.copy(item.line.object.position);
                item.smear.object.scale.setScalar(ring);
                // Its width goes by the middle of the orbit, not by where on it the planet happens to be this frame
                const zMiddle = Math.max(tmp2.set(c[0], c[1], c[2]).sub(camPos).dot(tmp.set(sizeView.fwd[0], sizeView.fwd[1], sizeView.fwd[2])), 1e-6);
                const across = Math.max((planetRadius(model, item.entry.planet, mix) * f) / zMiddle, model.planetFloorPx[i]);
                item.smear.set({ opacity: smearOpacity, width: Math.min(80, across * 2.4) * frame.dpr });
            }
        });
        if (world.comets) {
            world.comets.update({
                camera,
                star: world.starsAt[world.brightest],
                stage,
                rate: clock.shown,
                cap: reduce ? ORBITS_PER_SECOND_REDUCED : ORBITS_PER_SECOND,
                tDays,
                dpr: frame.dpr,
                selected: selectedCode,
                hover: hoverCode || aimCode,
                focused: cam.target ? cam.target.code : null,
                focusIndex: cam.target && cam.target.kind === 'comet' ? cam.target.index : -1
            });
        }
        if (world.halo) {
            world.halo.place.needsUpdate = true;
            world.halo.size.needsUpdate = true;
            world.halo.alpha.needsUpdate = true;
        }

        // Lines of the stars themselves. A pair that goes too fast to watch is its smear: the stars' light averaged over
        // their orbits. That's a ribbon when a star is small beside its orbit, and many soft discs when it isn't.
        world.starLines.forEach(({ line, smear: ribbon, glow, node, child, reachAU }) => {
            const c = positions.nodes.get(node);
            const scale = ringRadius(model, node.a_AU, mix) / node.a_AU;
            line.object.position.set(c[0], c[1], c[2]);
            line.object.scale.setScalar(scale);
            const period = node.orbit ? node.orbit.period_days : 0;
            const { own, above } = smear.nodes.get(node);
            line.object.visible = above < 0.999;
            line.set({
                draw: stage.orbits,
                head: period && own <= 0 ? ((tDays / period) % 1 + 1) % 1 : 0,
                trail: 1.2 * (1 - own),
                opacity: (1 - above) * (node === model.root && node.a_AU > 10 ? 0.28 : 0.38),
                width: 1.2 * frame.dpr
            });
            const amount = own * (1 - above) * stage.orbits;
            ribbon.object.visible = false;
            glow.object.visible = false;
            if (amount <= 0.002) return;
            tmp2.set(c[0], c[1], c[2]);
            const z = Math.max(tmp2.sub(camPos).dot(tmp.set(sizeView.fwd[0], sizeView.fwd[1], sizeView.fwd[2])), 1e-6);
            let widest = 0;
            for (let h = 0; h < child.members.length; h++) widest = Math.max(widest, sizes.stars[child.members[h]]);
            const reach = reachAU * scale;
            // A ribbon's half-width mustn't pass the tightest bend of the orbit as seen from a low angle, or it fans out there
            const ratio = widest / Math.max(reach, 1e-9);
            const wide = smoothstep(0.1, 0.22, ratio);
            if (wide < 1) {
                ribbon.object.visible = true;
                ribbon.object.position.copy(line.object.position);
                ribbon.object.scale.setScalar(scale);
                ribbon.set({ opacity: amount * (1 - wide) * 0.55, width: Math.max(5, Math.min(220, ((widest * f) / z) * 2.4)) * frame.dpr });
            }
            if (wide > 0) {
                // Enough discs that no one of them shows, sharing out enough light to keep a thin ring from fading away
                const count = Math.min(96, Math.max(10, Math.ceil((2 * Math.PI) / (0.7 * ratio))));
                glow.object.visible = true;
                glow.object.position.copy(line.object.position);
                glow.object.scale.setScalar(scale);
                glow.set({ radius: widest, amount: (amount * wide * Math.max(1.5, 1.86 / ratio)) / count, count });
            }
        });
        if (world.eight) {
            const { own } = smear.nodes.get(model.root);
            const head = own > 0 ? 0 : ((tDays / model.pathPeriodDays) % 1 + 1) % 1;
            world.eight.glow.set({ draw: stage.orbits, head, opacity: 0.2 + 0.5 * own, width: 11 * frame.dpr });
            world.eight.core.set({ draw: stage.orbits, head, width: 1.4 * frame.dpr });
        }

        // Mass transfer
        if (world.stream) {
            const st = model.stream;
            const d = positions.stars[st.donor];
            const a = positions.stars[st.accretor];
            world.stream.update({
                d, a,
                rD: sizes.stars[st.donor],
                rA: sizes.stars[st.accretor],
                dt: frame.dt,
                reduceMotion: reduce,
                opacity: smoothstep(0.35, 0.7, easeProgress(tNorm)) * (1 - Math.max(smear.stars[st.donor], smear.stars[st.accretor])),
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
    const LABEL_W = 58;         // The size of a label, roughly: six characters. Measuring every frame would cost layout
    const LABEL_H = 18;
    const placedX = [];
    const placedY = [];
    let placedCount = 0;

    // Takes turns: whoever comes first keeps its place, and a label that would land on it waits until there's room
    function placeLabel(el, x, y, frame, cls) {
        const out = x < 0 || y < 0 || x > frame.width || y > frame.height;
        let crowded = false;
        for (let k = 0; k < placedCount && !crowded && !out; k++) {
            crowded = Math.abs(placedX[k] - x) < LABEL_W && Math.abs(placedY[k] - y) < LABEL_H;
        }
        el.hidden = out || crowded;
        el.classList.toggle('is-selected', cls === 'selected');
        if (el.hidden) return;
        el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
        placedX[placedCount] = x;
        placedY[placedCount] = y;
        placedCount++;
    }

    function projectToCss(pos, frame) {
        tmp.set(pos[0], pos[1], pos[2]).project(camera);
        if (tmp.z > 1) return null;
        return { x: (tmp.x * 0.5 + 0.5) * frame.width, y: (-tmp.y * 0.5 + 0.5) * frame.height };
    }

    function placePlanetLabel(i, frame, cls) {
        const el = world.planetLabels[i];
        const item = world.planets[i];
        const merged = Math.max(world.smear.planets[i], world.smear.planetAbove[i]) > 0.5;
        // A label can't chase a blur round its orbit: it waits at one place on the ring
        let at;
        if (merged) {
            const k = item.points[(i * 53) % item.points.length];
            const ring = item.line.object.scale.x;
            const c = positions.centres[i];
            at = projectToCss([c[0] + k[0] * ring, c[1] + k[1] * ring, c[2] + k[2] * ring], frame);
        } else {
            at = projectToCss(positions.planets[i], frame);
        }
        if (!at) {
            el.hidden = true;
            return;
        }
        const r = merged ? 4 : (world.sizes.planets[i] * frame.height) / (2 * TAN_V * Math.max(world.sizes.planetZ[i], 1e-6));
        placeLabel(el, at.x, at.y - r - 3, frame, cls);
    }

    function placeCometLabel(i, frame, cls) {
        const el = world.cometLabels[i];
        const item = world.comets.items[i];
        if (!item.screen.ok || item.own > 0.5) {
            el.hidden = true;
            return;
        }
        placeLabel(el, item.screen.x, item.screen.y - item.screen.coma - 6, frame, cls);
    }

    function placeStarLabel(i, frame, cls) {
        const el = world.starLabels[i];
        const merged = world.smear.stars[i] > 0.5;
        if (merged && cls !== 'selected') {
            el.hidden = true;
            return;
        }
        const pos = merged ? targetPosition({ kind: 'star', index: i }) : positions.stars[i];
        const at = projectToCss(pos, frame);
        if (!at) {
            el.hidden = true;
            return;
        }
        const r = (world.sizes.stars[i] * frame.height) / (2 * TAN_V * Math.max(world.sizes.starZ[i], world.sizes.stars[i], 1e-6));
        // Clear of the bright glow round its edge, which reaches furthest past a small star
        placeLabel(el, at.x, at.y - r - Math.max(Math.min(0.6 * r, 16), 11) - 3, frame, cls);
    }

    function updateLabels(frame, stage) {
        const shown = stage.planets > 0.9;
        const labelsOn = app.layers.labels && shown;
        placedCount = 0;
        const isMarked = (code) => code === selectedCode || code === hoverCode || code === aimCode;
        // What the student is pointing at goes first, as it must always show, then stars, then planets
        world.starLabels.forEach((el, i) => { if (shown && isMarked(model.stars[i].code)) placeStarLabel(i, frame, 'selected'); });
        world.planetLabels.forEach((el, i) => { if (shown && isMarked(model.planets[i].code)) placePlanetLabel(i, frame, 'selected'); });
        world.starLabels.forEach((el, i) => {
            if (isMarked(model.stars[i].code) && shown) return;
            // A star alone with no planets gets its name up, as it's all there is
            if (labelsOn || (shown && model.lone)) placeStarLabel(i, frame, '');
            else el.hidden = true;
        });
        world.planetLabels.forEach((el, i) => {
            if (isMarked(model.planets[i].code) && shown) return;
            if (labelsOn) placePlanetLabel(i, frame, '');
            else el.hidden = true;
        });
        world.cometLabels.forEach((el, i) => {
            if (shown && (labelsOn || isMarked(model.comets[i].code))) placeCometLabel(i, frame, isMarked(model.comets[i].code) ? 'selected' : '');
            else el.hidden = true;
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

        // A clock shared with other views can't be slowed for one planet's close-up, so here the view falls behind it, and
        // catches up when the close-up ends
        if (clock.read) {
            const t = clock.read();
            const scale = timeScale();
            tDays = scale < 1 ? tDays + (t - clock.lastRead) * scale : t;
            clock.lastRead = t;
        }

        // Before the camera moves, so that what it's following can't be a frame behind
        positions = layout(model, tDays, mix, positions);
        if (world.comets) world.comets.place(tDays, mix);
        settleOrbits(frame);

        if (useFade) {
            // No flight at all: the sky stays exactly where it is and the system fades up over it
            const stage = stagesAt(1);
            stepCamera(frame, stage);
            updateWorld(frame, stage, null);
            sharedUniforms.uSkyFade.value = 1;
            stopTravel();
            engine.setSkyVisible(tNorm < 1);
            backdrop.set(1, 1, frame.dpr);
        } else {
            const p = easeProgress(tNorm);
            const crowded = path.byHand && (model.stars.length > 2 || !!model.body.black_hole);
            const stage = stagesAt(p, path.byHand, crowded);
            const ndc = stepSky(stage);
            setTravel(p, crowded);
            sharedUniforms.uSkyFade.value = stage.skyFade;
            engine.setSkyVisible(stage.skyFade > 0.001);
            stepCamera(frame, stage);
            shiftProjection(ndc.x, ndc.y);
            updateWorld(frame, stage, ndc);
            backdrop.set(stage.backdrop, stage.backdropZoom, frame.dpr);
        }
        if (hold === null) finishIfDone();
        settleIfCarried();
    }

    // The zoom that carried the student in has stopped: the camera settles where the button's flight leaves it. Only a black
    // hole's flight by hand ends closer in than that (lockHoleToSky, so that zooming in never shrinks the hole), and this
    // brings its companion into view.
    function settleIfCarried() {
        if (!settleAfterCarry || mode !== 'system' || performance.now() - lastZoomAt <= CARRIED_PAUSE_MS) return;
        settleAfterCarry = false;
        carriedIn = false;
        if (!cam.flight && !cam.target && cam.zoom < 1) startFocusFlight(null, 1);
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
            frameZone();
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
        carriedIn = true;
        settleAfterCarry = true;
        lastZoomAt = performance.now();
        if (!viewShown) showView();
        const drawer = app.drawer;
        const reading = app.selected ? app.selected.body.code === model.code || app.selected.entity.code === model.code : false;
        if (drawer && drawer.isOpen() && drawer.currentView() === 'object' && !reading) select(model.code);
    }

    function finishExit() {
        restoreSky();
        sharedUniforms.uSkyFade.value = 1;
        engine.setSkyVisible(true);
        carriedIn = false;
        settleAfterCarry = false;
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
        aimCode = null;
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
        const main = model.stars[0].star.stage;
        const stars = model.body.kind === 'nucleus' ? `a giant black hole and ${model.stars.length - 1} stars close round it`
            : main === 'black_hole' ? 'a black hole and a star'
            : main === 'neutron_star' ? 'a neutron star'
                : model.stars.length === 1 ? 'a star' : `${model.stars.length} stars`;
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
        const body = systemBodyOf(resolved);
        // With the graphics gone for now, a flight could never finish: the panels still work, and the sky is where it was
        if (!body || engine.isContextLost()) {
            if (opts.onDone) opts.onDone();
            return false;
        }
        const focusCode = opts.focus && opts.focus !== true ? opts.focus
            : ((resolved.path === 'planet' || resolved.path === 'comet') && opts.focus !== false ? resolved.entity.code : null);

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
        aimCode = null;
        clock.otherDays = 0;
        clock.otherRate = 0;
        clock.shown = 0;
        app.view = 'system';
        app.systemCode = body.code;
        const things = model.lone ? 'the star' : 'the stars and planets';
        canvas.setAttribute('aria-label', `System ${body.code}. Arrow keys or a drag orbit the camera, plus and minus or scrolling zoom. Square brackets step through ${things}, and Enter selects.`);
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
        positions = layout(model, tDays, mix);
        if (world.comets) world.comets.place(tDays, mix);
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
    const zoomInto = createZoomInto(app, {
        prepare(code) {
            if (mode !== 'sky' || (model && model.code === code)) return;
            const body = systemBodyOf(app.universe.resolve(code));
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
            if (kind === 'key') keyZoom = -1;
        },
        beginOut(moving) {
            hand = moving;
            // At this end the timed path and this one are the same, so nothing jumps as it changes to this
            path.byHand = true;
            lockStarsToSky(engine.currentFrame(), cam.dist);
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
        if (mode === 'exit' && !wasHand && !engine.isContextLost()) return;
        if (mode === 'load' || engine.isContextLost()) {
            // Never got started, or there are no frames to fly with: just put everything back
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

    // How much the clock is held back. A planet in close-up is there to be looked at, not to race round its star.
    function timeScale() {
        const t = cam.target;
        if (!model || mode !== 'system' || !t || (t.kind !== 'planet' && t.kind !== 'comet') || !(clock.speed > 0)) return 1;
        const period = t.kind === 'planet' ? model.planets[t.index].planet.period_days : model.comets[t.index].orbit.period_days;
        return Math.min(CLOSE_UP_SLOWDOWN, (CLOSE_UP_ORBITS_PER_S * period) / clock.speed);
    }

    // ---------- Things other parts of the page react to ----------
    bus.on('timeline', ({ code, t_days, own }) => {
        lastTimeline = { code, t_days };
        if (!model || code !== model.code || clock.read) return;
        // Another panel's clock: followed while it runs. When it goes back to the start it's letting go, and this one carries on.
        if (!own) {
            if (!t_days) return;
            clock.otherDays += Math.abs(t_days - tDays);
        }
        tDays = t_days;
    });
    bus.on('layer', ({ name, on }) => {
        if (name === 'backgroundStars' && backdrop) backdrop.showFieldStars(on);
        if (name !== 'habitableZone' || mode === 'sky') return;
        if (on) frameZone();
        else cam.zoom = Math.min(cam.zoom, maxZoom());
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
    let warmGlow = null;
    function warmSmallPrograms() {
        const renderer = engine.renderer;
        if (!renderer) return;
        warmPlanetShaders(renderer);
        ensureBackdrop();
        engine.compileInBackground(backScene, camera);
        warmStars.forEach((star) => star.dispose());
        if (warmGlow) warmGlow.dispose();
        const warmScene = new THREE.Scene();
        warmStars = ['low', 'medium', 'high'].map((quality) => {
            const star = createStar({ teff_K: 5800, radius_Rsun: 1, stage: 'main_sequence' }, { seed: 'warm', quality });
            warmScene.add(star.group);
            return star;
        });
        if (!warmLine) warmLine = createOrbitLine([[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]], {});
        warmScene.add(warmLine.object);
        // The smears start hidden, so a system's own compile won't get to them
        warmGlow = createOrbitGlow([[1, 0, 0], [0, 0, 1]], [1, 1, 1]);
        warmGlow.object.visible = true;
        warmScene.add(warmGlow.object);
        engine.compileInBackground(warmScene, camera);
    }
    bus.on('ready', () => {
        if (window.requestIdleCallback) window.requestIdleCallback(warmSmallPrograms, { timeout: 4000 });
        else setTimeout(warmSmallPrograms, 1500);
    });
    bus.on('gl-restored', warmSmallPrograms);
    // A flight in or out can't go on without frames: back to the sky, so the panel and the scene agree while it's dark
    bus.on('gl-lost', () => {
        if (mode === 'load' || mode === 'enter' || mode === 'exit') exit();
    });
    // A system kept ready has lost what it compiled
    bus.on('gl-restored', () => {
        if (mode !== 'sky' || !model) return;
        disposeWorld();
        model = null;
        compiled = false;
    });

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
            if (code) return hzStatus(systemBodyOf(app.universe.resolve(code)));
            return hzStatus(model ? model.body : null);
        },
        setLogScale(on) {
            logChoice = !!on;
            mixTarget = on && model && model.logUseful ? 1 : 0;
            frameZone();
            notify();
        },
        systemOf: systemBodyOf,
        setClock({ speed, playing, read }) {
            if (speed !== undefined) clock.speed = speed;
            if (playing !== undefined) clock.playing = playing;
            if (read !== undefined) {
                clock.read = read;
                if (read) clock.lastRead = read();
            }
        },
        timeScale,
        // Has any orbit merged into its smear just now?
        isBlurred() {
            if (!world) return false;
            return world.smear.planets.some((w) => w > 0.5) || world.smear.stars.some((w) => w > 0.5);
        },
        isLogScale: () => mixTarget > 0.5,
        logScaleUseful: () => !!(model && model.logUseful),
        getTime: () => tDays,
        getModel: () => (mode === 'sky' ? null : model),
        isFocused: () => !!cam.target,
        isBusy: () => mode === 'load' || mode === 'enter' || mode === 'exit',
        isOpening: () => !viewShown,    // A zoom has only just begun, and might yet settle back to the sky
        skyShows: () => (mode === 'enter' || mode === 'exit') && !useFade,  // A flight is under way, so the sky is on show behind it
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
        _state: () => ({ mode, tNorm, mix, dist: cam.dist, useFade, target: cam.target ? cam.target.code : null, zoom: cam.zoom, rate: clock.shown, hand: hand ? { goal: hand.goal, settling: !!hand.settling } : null, compiled, ready: mode === 'sky' && model ? model.code : null }),
        _saved: () => ({ ...savedView }),
        _starPx: () => {
            if (!world || !positions) return 0;
            const depth = tmp.set(...positions.stars[world.brightest]).distanceTo(camera.position);
            return world.sizes.stars[world.brightest] * pxPerWorldAt(depth, engine.currentFrame());
        },
        _planetsShown: () => (world ? world.planets.filter((item) => item.handle.object3d.children[0].visible).length : 0),
        _project(code) {
            const i = model.planets.findIndex((e) => e.code === code);
            return i < 0 ? null : projectToCss(positions.planets[i], engine.currentFrame());
        },
        _cometScreen(code) {
            const item = world && world.comets ? world.comets.items.find((c) => c.entry.code === code) : null;
            return item && item.screen.ok ? { x: item.screen.x, y: item.screen.y, coma: item.screen.coma } : null;
        },
        _camera: () => camera,
        // What's really in the scene this frame: for checking the size rule against the picture, not against the sums
        _drawn() {
            if (!world) return null;
            return {
                stars: world.stars.map((s) => ({ p: s.group.position.toArray(), r: s.radius, shown: s.group.visible })),
                planets: world.planets.map((item) => ({ p: item.handle.object3d.position.toArray(), r: item.handle.object3d.scale.x, shown: item.handle.object3d.visible })),
                smear: { stars: [...world.smear.stars], planets: [...world.smear.planets] }
            };
        },
        // Moves the camera straight to where it would end up, for the same checks: az and el in radians, zoom as for the wheel
        _aim({ az, el, zoom, dist }) {
            if (az !== undefined) {
                cam.az = az;
                cam.azT = az;
                cam.swung = true;
            }
            if (el !== undefined) {
                cam.el = el;
                cam.elT = el;
            }
            if (zoom !== undefined) cam.zoom = zoom;
            if (dist !== undefined) {
                cam.dist = dist;
                cam.distT = dist;
            }
        }
    };

    initSystemTab(app);
}
