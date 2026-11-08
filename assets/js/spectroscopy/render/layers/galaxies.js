// Distant galaxies. Every galaxy has a small picture in a shared atlas, which is all a galaxy needs while it is small on screen,
// as most are most of the time. Those are cheap, and baked a few to a step soon after loading, nearest the view first. A galaxy
// drawn bigger than its small picture can hold gets a full one, in one of a fixed number of places in a second atlas: baked when
// the zoom nears it, nearest the view first, or at take-off for a flight that will arrive at it. The full picture fades in over
// the small one, which is the same picture at a quarter the size, so the change can't be seen. A place whose galaxy has gone
// small or out of view is given to the next galaxy that needs one, so the memory stays fixed. A galaxy that grows beyond its
// full picture is baked again at the size it fills, into one of a few larger textures, and that picture fades in over the
// rest. Each atlas is one draw call. See galaxy_bake.js for how the picture itself is made.
//
// Sky rule: the fainter a galaxy is, the dimmer it starts, and it comes up as the limiting magnitude falls with
// zoom. The rule is softer than the one for stars, since a galaxy is a small jewel in the wide sky, not a point.
//
// A galaxy whose central black hole is feeding (data/nuclei.js) has a point of light at its middle, drawn as a star is.
// Close in, that point is picked for itself and a click further out on the galaxy picks the galaxy, as with a cluster's
// stars; and a zoom on it carries on into the hole (nucleusFov, for render/system/zoom_into.js).

import * as THREE from 'three';
import { bus } from '../../core/state.js';
import { Rng } from '../../core/rng.js';
import { blackBodyRGB } from '../../core/phys.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { limitingMag, MIN_FOV, azAltToVec3 } from '../../core/sky.js';
import { drawMag, depthLight, parallaxFactor, travelPc } from '../../core/depth.js';
import { bandMagnitudes, bandSkyBrightness } from '../../data/band_table.js';
import { IMAGE_R, BAKE_SCALE, FALL_GLSL, galaxyRecipe, createGalaxyBaker, createBakeTarget } from './galaxy_bake.js';
import { SKY_RADIUS, tangentBasis, offsetVector, quadAxes, worldHalfSize, scatterPicks, revealGain, REVEAL_GLSL } from './sky_tangent.js';
import { createRadioLobes } from './radio_lobes.js';
import { createSprites, createSpriteSet } from './stars.js';
import { MIN_GLOW } from '../engine.js';

const RAD = Math.PI / 180;
const TILE = 128;                  // Pixels across a full picture
const SMALL = 32;                  // Pixels across every galaxy's small picture: baked as a full one and kept as its mipmap would be
const SMALL_PER_STEP = 3;          // Small pictures to a step of baking. A full or small picture is a few milliseconds' work even
                                   // on the slowest GPU, so each is baked whole in a step: it's the steps that take the time
const TILE_GRID = 7;               // Full pictures are kept for at most this many squared galaxies at once
const TILE_FROM_PX = 14;           // A galaxy in view gets its full picture once drawn this big (device pixels across)...
const TILE_KEEP_PX = 9;            // ...and keeps it while it stays this big, or until its place is wanted
const IN_VIEW = 1.15;              // In view: its edge within this share of the view's half-diagonal from the middle
const APPEAR_S = 0.4;              // A galaxy's first picture fades in this fast
const MIX_IN_S = 0.35;             // A full picture fades in over the small one this fast...
const MIX_OUT_S = 0.25;            // ...and out again, when its place goes to another galaxy while it is still in view
const STEPS_MOST = 4;              // Steps of baking a frame, at most, on a GPU with room to spare
const HERO_SLOTS = 2;              // At most this many galaxies have their own large picture at once
const HERO_CAP = { low: 640, medium: 1280, high: 2048 };
const HERO_LINGER_S = 15;          // Keep a large picture this long after it goes out of use, in case of a return
const HERO_SETTLE_S = 0.12;        // A large picture comes in once the view has been still this long

// A feeding black hole's point can be picked on its own once its galaxy is this big on screen (radius, CSS pixels)...
const NUCLEUS_OPENS_PX = 150;
const NUCLEUS_OPENS_AT_LIMIT_PX = 30;   // ...or this big, zoomed in as far as the sky goes
const NUCLEUS_LIMIT_SHARE = 1.05;       // That far, as a share of the narrowest view
const NUCLEUS_REACH_PX = 7;             // Within this of the point is a direct hit on it
const CORE_SHOWS = 0.01;                // How strong the point must be in a band to be picked there
const NUCLEUS_ENTER_SHARE = 0.6;        // A zoom carries on into the hole once its galaxy's radius is this share of the view's height
const BAND_INDEX = { radio: 0, ir: 1, visible: 2, uv: 3, xray: 4 };
const CORE_BANDS = ['ir', 'visible', 'uv'];    // A feeding hole's point is drawn as a star is, in these bands
const CORE_BLUE = [0.8, 0.88, 1];       // A hot disc in view
const CORE_DUSTY = [1, 0.72, 0.5];      // Light that has come through dust is reddened
const CORE_LIFT = [25, 4];              // How much brighter the point is drawn than its own light (type 1, type 2)
// The Local Group's spiral (data/local_group.js) is bright enough to see by eye, as a long glow with a star-like middle. While
// it is small on screen its faint light is lifted by up to PRESENCE, and its bright light less, up to about PRESENCE_CAP, so
// that its whole length shows and not only its bulge. The lift goes as it grows from PRESENCE_PX[0] to PRESENCE_PX[1] device
// pixels across. Its middle's pinprick is CORE_PRESENCE times as bright as another galaxy's.
const PRESENCE = 6;
const PRESENCE_CAP = 2;
const PRESENCE_PX = [40, 150];
const CORE_PRESENCE = 2.4;
// Near enough that its brightest stars can be seen one by one, close in: its blue and red supergiants, on its arms and through
// its disc, come up as the zoom's limit passes their magnitudes, as any star does
const RESOLVED = { blue: 2400, red: 400 };
const RESOLVED_ABS_MAG = [-8.6, -6.4];  // The brightest of them, to about where they'd crowd into a haze
const RESOLVED_REACH = 0.85;            // Inside this share of the galaxy's radius, which a click there always finds

const VERT = /* glsl */`
    ${BAND_GLSL}
    ${FALL_GLSL}
    ${REVEAL_GLSL}
    attribute vec3 aCentre;
    attribute vec3 aU;
    attribute vec3 aV;
    attribute vec4 aRect;
    attribute vec4 aBandA;
    attribute float aBandB;
    attribute vec4 aMagA;
    attribute float aMagB;
    attribute float aFade;
    attribute float aDepth;
    attribute float aPc;
    attribute float aPresence;
    varying vec2 vUv;
    varying vec2 vQ;
    varying vec4 vBand;
    varying float vXray;
    varying float vJewel;
    varying float vPresence;
    void main() {
        // A flight that comes nearer one draws it bigger, and as bright across, until it passes right through
        vec3 centre = aCentre;
        float near = travel(centre, aPc);
        float grow = travelSize(near);
        float light = aFade * travelThrough(near) * min(near * near, 1.0);
        vec3 world = centre + position.x * aU * grow + position.y * aV * grow;
        vQ = position.xy;
        vUv = aRect.xy + (position.xy * 0.5 + 0.5) * aRect.zw;
        // Faint things come up with zoom in every band, each with its own magnitude there
        vBand = vec4(aBandA.x * revealGain(aMagA.x), aBandA.y * revealGain(aMagA.y), aBandA.z * revealGain(aMagA.z), aBandA.w * revealGain(aMagA.w)) * light;
        vXray = aBandB * revealGain(aMagB) * light;
        // Size on screen, in device pixels: the smaller it is, the harder it has to work to read as more than a blob
        float px = length(aU) / ${SKY_RADIUS.toFixed(1)} * uPxPerRad * depthP(aDepth) * grow * 2.0;
        vJewel = fall(46.0, 10.0, px);
        vPresence = 1.0 + (aPresence - 1.0) * fall(${PRESENCE_PX[1].toFixed(1)}, ${PRESENCE_PX[0].toFixed(1)}, px);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        gl_Position.xy *= depthP(aDepth);
        if (aFade <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    }`;

const FRAG = /* glsl */`
    ${BAND_GLSL}
    ${FALL_GLSL}
    uniform sampler2D tA;
    uniform sampler2D tB;
    varying vec2 vUv;
    varying vec2 vQ;
    varying vec4 vBand;
    varying float vXray;
    varying float vJewel;
    varying float vPresence;
    void main() {
        // Lean towards the sharper mipmap when small, so a tiny galaxy keeps its shape
        float bias = -1.1 * vJewel;
        vec4 a = texture2D(tA, vUv, bias);
        vec4 b = texture2D(tB, vUv, bias);
        vec3 vis = a.rgb * a.rgb * ${BAKE_SCALE.a.toFixed(1)};
        float ultraviolet = a.a * a.a * ${BAKE_SCALE.a.toFixed(1)};
        vec3 aux = b.rgb * b.rgb * ${BAKE_SCALE.b.toFixed(1)};
        // Keep colour and contrast up in the small sizes, where averaging washes them out
        float luma = dot(vis, vec3(0.3, 0.55, 0.15));
        vis = mix(vis, luma + (vis - luma) * 1.45, vJewel);
        float lift = 1.0 + 2.2 * vJewel;
        vec3 colour = vis * lift * vBand.z * uBandW[2]
            + uBandTint[0] * uBandW[0] * aux.g * vBand.x * lift
            + uBandTint[1] * uBandW[1] * aux.r * vBand.y * lift * 1.4
            + uBandTint[3] * uBandW[3] * ultraviolet * vBand.w * lift * 2.4
            + uBandTint[4] * uBandW[4] * aux.b * vXray * lift;
        float edge = fall(1.0, 0.94, max(abs(vQ.x), abs(vQ.y)));
        // 1 for every galaxy but the Local Group's
        colour *= vPresence / (1.0 + dot(colour, vec3(0.3, 0.55, 0.15)) * (vPresence - 1.0) / ${PRESENCE_CAP.toFixed(1)});
        gl_FragColor = vec4(colour * edge * uSkyFade, 1.0);
    }`;

// Is a feeding hole's point drawn in this band at this zoom? Radio and X-rays: its galaxy's point. Otherwise its own star-like
// sprite, by the stars' rule (render/layers/stars.js skyGlow). One hidden by its dust (type 2) is only a faint knot there,
// but a click on its galaxy's bright middle, close in, still means it.
function coreShows(core, band, lim) {
    if (band === 0) return core.point[0] > CORE_SHOWS;
    if (band === 4) return core.point[1] > CORE_SHOWS;
    return core.hidden || core.glow[band - 1] * 10 ** (0.4 * (lim - 6)) >= MIN_GLOW;
}

function quadGeometry(count) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const add = (name, size) => {
        const attr = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
        geometry.setAttribute(name, attr);
        return attr;
    };
    add('aCentre', 3);
    add('aU', 3);
    add('aV', 3);
    add('aRect', 4);
    add('aBandA', 4);
    add('aBandB', 1);
    add('aMagA', 4);
    add('aMagB', 1);
    add('aFade', 1);
    add('aDepth', 1);
    add('aPc', 1);
    add('aPresence', 1);
    geometry.instanceCount = count;
    return geometry;
}

function writeInstance(geometry, i, g, rect) {
    geometry.attributes.aCentre.array.set(g.centre, i * 3);
    geometry.attributes.aU.array.set(g.u, i * 3);
    geometry.attributes.aV.array.set(g.v, i * 3);
    geometry.attributes.aRect.array.set(rect, i * 4);
    geometry.attributes.aBandA.array.set(g.bandA, i * 4);
    geometry.attributes.aBandB.array[i] = g.bandB;
    geometry.attributes.aMagA.array.set(g.magA, i * 4);
    geometry.attributes.aMagB.array[i] = g.magB;
    geometry.attributes.aDepth.array[i] = g.body.depth;
    geometry.attributes.aPc.array[i] = travelPc(g.body);
    geometry.attributes.aPresence.array[i] = g.local ? PRESENCE : 1;
    ['aCentre', 'aU', 'aV', 'aRect', 'aBandA', 'aBandB', 'aMagA', 'aMagB', 'aDepth', 'aPc', 'aPresence'].forEach((name) => { geometry.attributes[name].needsUpdate = true; });
}

// A feeding black hole whose disc is in view outshines its galaxy's middle many times over, as a point. Once the galaxy is big
// enough on screen for that middle to be a bright blur, the point's diffraction spikes reach out past it, as the telescope's
// optics make them for any point that bright: that is what tells it apart. Two thin quads each, like the stars' spikes
// (render/layers/stars.js), with their length set by how big the galaxy is drawn.
const SPIKE_FROM_PX = [30, 170];    // Galaxy radius on screen (device pixels) over which they grow in
const SPIKE_SHARE = 0.5;            // Their reach, as a share of that radius...
const SPIKE_MOST_PX = 240;          // ...up to this
const SPIKE_LIGHT = { visible: 3.5, uv: 5 };

function createCoreSpikes(cores) {
    const count = cores.length;
    const geometry = new THREE.InstancedBufferGeometry();
    const arms = [];
    [0, 1].forEach((arm) => arms.push(-1, -1, arm, 1, -1, arm, 1, 1, arm, -1, 1, arm));
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arms), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const centres = new Float32Array(count * 3);
    const majors = new Float32Array(count);
    const depths = new Float32Array(count);
    const pcs = new Float32Array(count);
    const light = new Float32Array(count * 2);
    cores.forEach((g, i) => {
        centres.set(g.centre, i * 3);
        majors[i] = g.body.galaxy.size_deg / 2;
        depths[i] = g.body.depth;
        pcs[i] = travelPc(g.body);
        const typeOne = g.body.nucleus.nucleus.type === 1;
        light.set(typeOne ? [SPIKE_LIGHT.visible * g.light, SPIKE_LIGHT.uv * g.light] : [0, 0], i * 2);
    });
    geometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(centres, 3));
    geometry.setAttribute('aMajor', new THREE.InstancedBufferAttribute(majors, 1));
    geometry.setAttribute('aDepth', new THREE.InstancedBufferAttribute(depths, 1));
    geometry.setAttribute('aPc', new THREE.InstancedBufferAttribute(pcs, 1));
    geometry.setAttribute('aLight', new THREE.InstancedBufferAttribute(light, 2));
    geometry.instanceCount = count;
    const material = skyMaterial({
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            attribute vec3 aCentre;
            attribute float aMajor;
            attribute float aDepth;
            attribute float aPc;
            attribute vec2 aLight;
            varying vec2 vUv;
            varying vec3 vColour;
            const float ANGLE = 0.46;   // The stars' spikes' angle: they come from the telescope, not the source
            void main() {
                vec3 centre = aCentre;
                float near = travel(centre, aPc);
                float majorPx = radians(aMajor) * uPxPerRad * depthP(aDepth) * travelSize(near);
                float scale = uViewport.y / 800.0;
                float grow = smoothstep(${SPIKE_FROM_PX[0].toFixed(1)} * scale, ${SPIKE_FROM_PX[1].toFixed(1)} * scale, majorPx);
                float amount = grow * (aLight.x * uBandW[2] + aLight.y * uBandW[3]) * uSkyFade * min(near * near, 1.0) * travelThrough(near);
                if (amount <= 0.002) {
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    return;
                }
                float len = min(${SPIKE_SHARE.toFixed(2)} * majorPx, ${SPIKE_MOST_PX.toFixed(1)} * scale) * grow;
                float width = 3.4 * max(scale, 1.0);
                vColour = bandColour(vec3(0.82, 0.9, 1.0)) * amount;
                vUv = position.xy;
                float angle = ANGLE + position.z * 1.5707963;
                vec2 axis = vec2(cos(angle), sin(angle));
                vec2 side = vec2(-axis.y, axis.x);
                vec4 clip = projectionMatrix * modelViewMatrix * vec4(centre, 1.0);
                clip.xy *= depthP(aDepth);
                clip.xy += (axis * position.x * len + side * position.y * width) * 2.0 / uViewport * clip.w;
                gl_Position = clip;
            }`,
        fragmentShader: /* glsl */`
            varying vec2 vUv;
            varying vec3 vColour;
            void main() {
                float along = abs(vUv.x);
                float across = exp(-vUv.y * vUv.y * 22.0);
                vec3 reach = pow(max(1.0 - along, 0.0) * vec3(1.0), vec3(1.7, 2.4, 3.3));
                float falloff = 1.0 / (1.0 + along * along * 18.0);
                vec3 ripple = 1.0 + 0.22 * cos(along * 26.0 + vec3(0.0, 2.1, 4.2));
                gl_FragColor = vec4(vColour * reach * ripple * across * falloff, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.stars + 1;
    return { mesh, geometry, material };
}

// The Local Group spiral's brightest stars one by one (RESOLVED), as sprite data for createSprites (render/layers/stars.js):
// the blue supergiants on the same arms as its picture's own young stars (galaxy_bake.js onArm), the red ones through the
// disc, each placed on the sky where its picture puts that spot. Each has its own magnitude in each band, so it comes up as
// the zoom's limit reaches it, as a star does. Null if no galaxy is near enough.
function resolvedStarData(list) {
    const stars = [];
    list.forEach((g) => {
        const { body, recipe: r } = g;
        const rng = new Rng(`resolved:${body.visual_seed}`);
        const modulus = 5 * Math.log10(body.distance_pc / 10);
        const half = body.galaxy.size_deg / 2;
        const ci = Math.cos(r.incl);
        const si = Math.sin(r.incl);
        const pa = body.galaxy.position_angle_deg * RAD;
        const r0 = Math.max(r.barLen, 0.09);
        const expRadius = (rd, most) => -rd * Math.log(1 - rng.next() * (1 - Math.exp(-most / rd)));
        const spot = (red) => {
            for (let k = 0; k < 20; k++) {
                let x;
                let y;
                let z;
                if (!red || rng.chance(0.4)) {
                    let rad = r0 * 0.9 + expRadius(r.rdY * 0.42, 0.6) + expRadius(r.rdY * 0.42, 0.6);
                    const th = Math.log(rad / r0) / Math.tan(r.pitch) + (2 * Math.PI * Math.floor(rng.next() * r.arms) - r.phase) / r.arms
                        + (rng.gauss() * 0.4) / r.arms;
                    rad *= 1 + 0.05 * rng.gauss();
                    x = rad * Math.cos(th);
                    y = rad * Math.sin(th);
                    z = rng.gauss() * 0.015;
                } else {
                    const rad = 0.08 + expRadius(r.rd, 0.8);
                    const th = rng.range(0, 2 * Math.PI);
                    x = rad * Math.cos(th);
                    y = rad * Math.sin(th);
                    z = rng.gauss() * 0.03;
                }
                const R = Math.hypot(x, y);
                if (R > RESOLVED_REACH || R < r.bulgeRe * 1.6) continue;
                y *= r.hand;
                // Degrees along the position angle and square to it: the picture's x and y
                const a = x * half;
                const b = (y * ci - z * si) * half;
                return offsetVector(g.basis, a * Math.sin(pa) - b * Math.cos(pa), a * Math.cos(pa) + b * Math.sin(pa));
            }
            return null;
        };
        const glow = (m) => (m >= 90 ? 0 : 10 ** (-0.4 * (m - 6)));
        const add = (red) => {
            const dir = spot(red);
            if (!dir) return;
            // Very many near the faint end, a few bright ones
            const absV = RESOLVED_ABS_MAG[1] - (RESOLVED_ABS_MAG[1] - RESOLVED_ABS_MAG[0]) * rng.next() ** 2.5;
            const T = red ? rng.range(3500, 4200) : rng.logRange(9000, 28000);
            const mV = absV + modulus;
            // A red supergiant is brightest in infrared and shows nothing in ultraviolet; a blue one is brighter there
            const mIr = mV + (red ? -2.6 : 0.4);
            const mUv = red ? 99 : mV - (T > 15000 ? 1.4 : 0.6);
            stars.push({ dir, colour: blackBodyRGB(T), bandA: [0, glow(mIr), glow(mV), glow(mUv)], depth: body.depth, pc: travelPc(body) });
        };
        for (let i = 0; i < RESOLVED.blue; i++) add(false);
        for (let i = 0; i < RESOLVED.red; i++) add(true);
    });
    const n = stars.length;
    if (!n) return null;
    const data = {
        count: n,
        centres: new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3),
        colours: new Float32Array(n * 3),
        bandA: new Float32Array(n * 4),
        bandB: new Float32Array(n),
        seeds: new Float32Array(n),
        soft: new Float32Array(n).fill(1.3),
        depths: new Float32Array(n),
        pcs: new Float32Array(n),
        flux: new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1),
        split: new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2),
        spike: new Float32Array(n)
    };
    stars.forEach((s, i) => {
        data.centres.array.set(s.dir.map((c) => c * SKY_RADIUS), i * 3);
        data.colours.set(s.colour, i * 3);
        data.bandA.set(s.bandA, i * 4);
        data.seeds[i] = (i * 0.618034) % 1;
        data.depths[i] = s.depth;
        data.pcs[i] = s.pc;
    });
    // The brightest of them in any band: until the zoom's limit reaches that, none is drawn, and nothing need be
    data.topGlow = stars.reduce((m, s) => Math.max(m, ...s.bandA), 0);
    return data;
}

export function createGalaxiesLayer(engine, app) {
    const { renderer, scene } = engine;
    const bodies = app.universe.bodies.filter((b) => b.kind === 'galaxy');
    const n = bodies.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const rows = Math.max(1, Math.ceil(n / cols));
    const smallAtlas = createBakeTarget(cols * SMALL, rows * SMALL);
    const tileAtlas = createBakeTarget(TILE_GRID * TILE, TILE_GRID * TILE);
    const baker = createGalaxyBaker(engine);
    let bakerReady = false;
    let compileRun = 0;
    function compileBaker() {
        const run = ++compileRun;
        bakerReady = false;
        baker.compile().then(() => {
            if (run === compileRun) bakerReady = true;
        });
    }
    compileBaker();

    const galaxies = bodies.map((body, i) => {
        const basis = tangentBasis(body.sky.az, body.sky.alt);
        const halfDeg = (body.galaxy.size_deg * IMAGE_R) / 2;
        const mags = bandMagnitudes(body);
        const light = depthLight(body);
        const { u, v } = quadAxes(basis, body.galaxy.position_angle_deg, worldHalfSize(body.galaxy.size_deg * IMAGE_R));
        return {
            body,
            index: i,
            basis,
            unit: basis.centre,
            centre: basis.centre.map((c) => c * SKY_RADIUS),
            u,
            v,
            halfDeg,
            mag: drawMag(body),
            mags,
            magA: [mags.radio, mags.ir, mags.visible, mags.uv],
            magB: mags.xray,
            light,
            bandA: [body.bands.radio * light, body.bands.ir * light, body.bands.visible * light, body.bands.uv * light],
            bandB: body.bands.xray * light,
            recipe: galaxyRecipe(body),
            local: !!body.galaxy.local_group,
            smallRect: { x: (i % cols) * SMALL, y: Math.floor(i / cols) * SMALL, w: SMALL, h: SMALL },
            small: false,       // Its small picture is baked
            slot: null,         // Its place in the full pictures' atlas, if it has one
            releasing: false,   // Fading back to its small picture, before its place goes to another galaxy
            wantTile: false,    // Wants a full picture this frame...
            rank: 0,            // ...this soon: lower first
            off: 180,           // Degrees from the middle of the view
            inView: false,      // In the view as it is...
            goalInView: false,  // ...or as it will be at the end of a flight or a zoom
            appear: 0,          // Its first picture fading in
            mix: 0,             // How much of it is its full picture rather than its small one
            hero: null
        };
    });

    // The small pictures: one instance each, all in one draw
    const atlasRect = (target, r) => [(r.x + 0.5) / target.width, (r.y + 0.5) / target.height, (r.w - 1) / target.width, (r.h - 1) / target.height];
    function atlasMeshOf(target, count) {
        const geometry = quadGeometry(count);
        const material = skyMaterial({
            uniforms: { tA: { value: target.textures[0] }, tB: { value: target.textures[1] } },
            vertexShader: VERT,
            fragmentShader: FRAG
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = ORDER.galaxies;
        scene.add(mesh);
        return { geometry, material, mesh };
    }
    const smalls = atlasMeshOf(smallAtlas, n);
    galaxies.forEach((g, i) => writeInstance(smalls.geometry, i, g, atlasRect(smallAtlas, g.smallRect)));

    // The full pictures: an instance for each place in their atlas, standing for whichever galaxy has it
    const slots = [];
    for (let i = 0; i < TILE_GRID * TILE_GRID; i++) {
        slots.push({ index: i, rect: { x: (i % TILE_GRID) * TILE, y: Math.floor(i / TILE_GRID) * TILE, w: TILE, h: TILE }, galaxy: null, baked: false, lastWanted: -1e9 });
    }
    const tiles = atlasMeshOf(tileAtlas, slots.length);

    // Large pictures: a mesh each, the same shader as the atlas with its own textures
    const heroes = [];
    for (let i = 0; i < HERO_SLOTS; i++) {
        const geometry = quadGeometry(1);
        const material = skyMaterial({
            uniforms: { tA: { value: null }, tB: { value: null } },
            vertexShader: VERT,
            fragmentShader: FRAG
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = ORDER.galaxies;
        mesh.visible = false;
        scene.add(mesh);
        // wanted: by the view as it is, which shows it; forGoal: by the view a flight is going to, which only bakes it
        heroes.push({ geometry, material, mesh, galaxy: null, target: null, res: 0, wantRes: 0, goalRes: 0, fade: 0, lastWanted: 0, wanted: false, forGoal: false, baking: false });
    }

    // Nuclei: a crisp point at each centre. In visible it's a pinprick that keeps a tiny galaxy from being a blob;
    // in X-rays it is all you see of an active nucleus.
    const nucleusPositions = new Float32Array(n * 3);
    const nucleusBandA = new Float32Array(n * 4);
    const nucleusBandB = new Float32Array(n);
    const nucleusMag = new Float32Array(n);
    const nucleusColour = new Float32Array(n * 3);
    const nucleusDepth = new Float32Array(n);
    const nucleusPc = new Float32Array(n);
    galaxies.forEach((g, i) => {
        const { body } = g;
        nucleusDepth[i] = body.depth;
        nucleusPc[i] = travelPc(body);
        const active = !!body.galaxy.active_nucleus;
        const lobed = !!body.galaxy.radio_lobes;
        nucleusPositions.set(g.centre, i * 3);
        nucleusBandA.set([
            lobed ? body.bands.radio * g.light : 0,
            (g.recipe.starburst ? 0.5 : 0.15) * body.bands.ir * g.light,
            body.bands.visible * g.light * (g.local ? CORE_PRESENCE : 1),
            active ? 0.6 * body.bands.uv * g.light : 0
        ], i * 4);
        nucleusBandB[i] = active ? Math.max(0.5, body.bands.xray) * g.light : 0;
        nucleusMag[i] = g.mag;
        nucleusColour.set(g.recipe.kind === 2 ? [0.75, 0.85, 1] : [1, 0.82, 0.58], i * 3);
    });

    // A feeding black hole (data/nuclei.js) is far too small ever to be more than a point, so it is drawn as the stars are,
    // by its own brightness in each band: with its disc in view (type 1) a blazing blue-white point that outshines the
    // bulge's middle, spikes and all, brightest in ultraviolet; with its dust in the way (type 2) a faint knot that glows in
    // infrared. Its X-rays and radio are the galaxy's own point's, above.
    const cores = galaxies.filter((g) => g.body.nucleus && g.body.nucleus.nucleus.active);
    const coreData = {
        count: cores.length,
        centres: new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, cores.length) * 3), 3),
        colours: new Float32Array(Math.max(1, cores.length) * 3),
        bandA: new Float32Array(Math.max(1, cores.length) * 4),
        bandB: new Float32Array(Math.max(1, cores.length)),
        seeds: new Float32Array(Math.max(1, cores.length)),
        soft: new Float32Array(Math.max(1, cores.length)),
        depths: new Float32Array(Math.max(1, cores.length)),
        pcs: new Float32Array(Math.max(1, cores.length)),
        flux: new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, cores.length)).fill(1), 1),
        split: new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, cores.length) * 2), 2),
        spike: new Float32Array(Math.max(1, cores.length))
    };
    cores.forEach((g, i) => {
        const hole = g.body.nucleus;
        const typeOne = hole.nucleus.type === 1;
        coreData.centres.array.set(g.centre, i * 3);
        coreData.colours.set(typeOne ? CORE_BLUE : CORE_DUSTY, i * 3);
        // Drawn brighter than its share of the light alone would make it: it sits on its galaxy's bright middle, and a
        // student must see it there as a point of its own
        const glow = CORE_BANDS.map((band) => bandSkyBrightness(hole, band) * (typeOne ? CORE_LIFT[0] : CORE_LIFT[1]));
        coreData.bandA.set([0, ...glow], i * 4);
        coreData.seeds[i] = (i * 0.618) % 1;
        coreData.soft[i] = 0.8;
        coreData.depths[i] = g.body.depth;
        coreData.pcs[i] = travelPc(g.body);
        coreData.spike[i] = 0;      // Its own spikes, below, go by how big its galaxy is drawn
        // What it shows in each band, for picking what's drawn: X-rays and radio are the galaxy's point's
        g.core = { code: hole.code, glow, point: [nucleusBandA[g.index * 4], nucleusBandB[g.index]], hidden: !typeOne };
    });
    const coreSprites = cores.length ? createSprites(coreData) : null;
    const coreSpikes = cores.length ? createCoreSpikes(cores) : null;
    if (coreSprites) {
        scene.add(coreSprites.mesh);
        scene.add(coreSpikes.mesh);
    }
    const resolvedData = resolvedStarData(galaxies.filter((g) => g.local));
    // Only those in view and bright enough at this zoom are drawn (stars.js createSpriteSet)
    const resolvedSet = resolvedData ? createSpriteSet(resolvedData, false) : null;
    const resolved = resolvedSet ? resolvedSet.sprites : null;
    if (resolved) scene.add(resolved.mesh);
    const applyCoreQuality = (level) => { if (coreSpikes) coreSpikes.mesh.visible = level !== 'low'; };
    applyCoreQuality(app.qualityLevel);
    const offCoreQuality = bus.on('quality', ({ level }) => applyCoreQuality(level));
    const nucleusGeometry = new THREE.BufferGeometry();
    nucleusGeometry.setAttribute('position', new THREE.BufferAttribute(nucleusPositions, 3));
    nucleusGeometry.setAttribute('aBandA', new THREE.BufferAttribute(nucleusBandA, 4));
    nucleusGeometry.setAttribute('aBandB', new THREE.BufferAttribute(nucleusBandB, 1));
    nucleusGeometry.setAttribute('aMag', new THREE.BufferAttribute(nucleusMag, 1));
    nucleusGeometry.setAttribute('aColour', new THREE.BufferAttribute(nucleusColour, 3));
    nucleusGeometry.setAttribute('aDepth', new THREE.BufferAttribute(nucleusDepth, 1));
    nucleusGeometry.setAttribute('aPc', new THREE.BufferAttribute(nucleusPc, 1));
    const nucleusMaterial = skyMaterial({
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            ${FALL_GLSL}
            ${REVEAL_GLSL}
            attribute vec4 aBandA;
            attribute float aBandB;
            attribute float aMag;
            attribute vec3 aColour;
            attribute float aDepth;
            attribute float aPc;
            varying vec3 vColour;
            void main() {
                vec3 centre = position;
                float near = travel(centre, aPc);
                float gain = revealGain(aMag);
                // A pinprick in visible only while the galaxy is too small to show its own nucleus
                float small = fall(4000.0, 1500.0, uPxPerRad * depthP(aDepth) * travelSize(near));
                vec3 c = (aColour * aBandA.z * gain * uBandW[2] * 0.9 * small
                    + uBandTint[0] * uBandW[0] * aBandA.x * 2.0
                    + uBandTint[1] * uBandW[1] * aBandA.y * 1.2
                    + uBandTint[3] * uBandW[3] * aBandA.w * 1.6
                    + uBandTint[4] * uBandW[4] * aBandB * 7.0) * travelLight(near);
                vColour = c;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(centre, 1.0);
                gl_Position.xy *= depthP(aDepth);
                float strongest = max(c.r, max(c.g, c.b));
                float px = uViewport.y / 800.0;
                gl_PointSize = strongest < 0.004 ? 0.0 : (2.0 + 4.5 * min(1.0, sqrt(strongest) * 0.6)) * clamp(px, 1.0, 1.5);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            ${FALL_GLSL}
            varying vec3 vColour;
            void main() {
                vec2 c = (gl_PointCoord - 0.5) * 2.0;
                float d = dot(c, c);
                gl_FragColor = vec4(vColour * exp(-d * 5.0) * fall(1.0, 0.7, d) * uSkyFade, 1.0);
            }`
    });
    const nuclei = new THREE.Points(nucleusGeometry, nucleusMaterial);
    nuclei.frustumCulled = false;
    nuclei.renderOrder = ORDER.galaxies + 1;
    scene.add(nuclei);

    const lobed = galaxies.filter((g) => g.body.galaxy.radio_lobes);
    const lobeSources = lobed.map((g) => ({
        az: g.body.sky.az,
        alt: g.body.sky.alt,
        // The jets leave along the galaxy's spin axis, more or less: square to the disc as we see it
        positionAngleDeg: g.body.galaxy.position_angle_deg + 90 + (g.recipe.off[0] - 45) * 0.3,
        spanDeg: g.body.galaxy.size_deg * (2.2 + (g.recipe.off[1] / 90) * 1.6),
        strength: Math.max(0.35, g.body.bands.radio) * g.light,
        seed: g.body.visual_seed,
        depth: g.body.depth,
        pc: travelPc(g.body)
    }));
    const lobes = createRadioLobes(engine, lobeSources);

    // ---------- Baking ----------
    // One bake runs at a time, in this order: full pictures for the Local Group's spiral and for where a flight is going; the
    // large picture there; full pictures for what is big in view; small pictures for what is in view, nearest the middle first;
    // full pictures an easing zoom will want; the other small pictures; and large pictures for the view, once it is still.
    let job = null;
    let jobDone = null;
    let jobSlot = null;             // A full picture's place being baked into, which can't be given away meanwhile
    let stillFor = 0;               // Seconds since the field of view last changed
    let settledFor = 0;             // ...and since the view last moved at all
    let lastFov = -1;
    const lastForward = new THREE.Vector3();
    let stepsPerFrame = 1;
    const forward = new THREE.Vector3();
    const views = { now: null, goal: null };

    function startJob(generator, onDone, slot = null) {
        job = generator;
        jobDone = onDone;
        jobSlot = slot;
    }

    function stepJob() {
        const result = job.next();
        if (result.done) {
            const done = jobDone;
            job = null;
            jobDone = null;
            jobSlot = null;
            if (done) done();
        }
    }

    // A view as the plans below need it: its middle (a unit vector), how many device pixels a degree is, and how far it reaches
    function viewSpec(dir, fov, frame) {
        const scale = Math.tan(frame.fov * RAD * 0.5) / Math.tan(fov * RAD * 0.5);
        return { dir, fov, pxPerDeg: frame.pxPerRad * RAD * scale, halfView: Math.hypot(fov, (fov * frame.width) / frame.height) * 0.5 };
    }

    function offDeg(g, view) {
        const d = g.unit[0] * view.dir[0] + g.unit[1] * view.dir[1] + g.unit[2] * view.dir[2];
        return Math.acos(Math.max(-1, Math.min(1, d))) / RAD;
    }

    // Device pixels across a galaxy's picture in a view, or 0 if it is out of the view
    function sizeIn(g, view, off = offDeg(g, view)) {
        const parallax = parallaxFactor(g.body.depth, view.fov);
        if ((off - g.halfDeg) * parallax > view.halfView * IN_VIEW) return 0;
        return g.halfDeg * 2 * view.pxPerDeg * parallax;
    }

    function giveSlot(s, g, t) {
        s.galaxy = g;
        s.baked = false;
        s.lastWanted = t;
        g.slot = s;
        g.mix = 0;
        g.releasing = false;
        writeInstance(tiles.geometry, s.index, g, atlasRect(tileAtlas, s.rect));
    }

    function clearSlot(s) {
        const g = s.galaxy;
        if (g) {
            g.slot = null;
            g.mix = 0;
            g.releasing = false;
        }
        s.galaxy = null;
        s.baked = false;
    }

    // Which galaxies want a full picture this frame, and how soon (rank, lower first); and places for them. The Local Group's
    // spiral always has one. A flight's destination comes next, then what is big in view, nearest the middle first, then what an
    // easing zoom will make big.
    function planTiles(frame) {
        const { now, goal } = views;
        for (let i = 0; i < n; i++) {
            const g = galaxies[i];
            g.off = offDeg(g, now);
            const px = sizeIn(g, now, g.off);
            g.inView = px > 0;
            g.wantTile = g.local;
            g.rank = g.local ? -100 : Infinity;
            if (g.inView && px >= (g.slot && g.slot.baked ? TILE_KEEP_PX : TILE_FROM_PX)) {
                g.wantTile = true;
                g.rank = Math.min(g.rank, g.off / now.halfView);
            }
            g.goalInView = false;
            if (goal) {
                const off = offDeg(g, goal);
                const gpx = sizeIn(g, goal, off);
                g.goalInView = gpx > 0;
                if (gpx >= TILE_FROM_PX) {
                    g.wantTile = true;
                    g.rank = Math.min(g.rank, (goal.flight ? -10 : 2) + off / goal.halfView);
                }
            }
        }
        const waiting = [];
        slots.forEach((s) => {
            if (!s.galaxy || !s.galaxy.wantTile) return;
            s.lastWanted = frame.t;
            s.galaxy.releasing = false;
        });
        for (let i = 0; i < n; i++) if (galaxies[i].wantTile && !galaxies[i].slot) waiting.push(galaxies[i]);
        if (!waiting.length) return;
        waiting.sort((a, b) => a.rank - b.rank);
        let w = 0;
        for (let i = 0; i < slots.length && w < waiting.length; i++) if (!slots[i].galaxy) giveSlot(slots[i], waiting[w++], frame.t);
        if (w >= waiting.length) return;
        // Then the places no one wants now, longest unwanted first. One whose galaxy can be seen fades back to its small picture
        // first, and goes once it has; one whose galaxy has no small picture yet stays while it can be seen.
        const spare = slots.filter((s) => s.galaxy && !s.galaxy.wantTile && s !== jobSlot && !(s.galaxy.inView && !s.galaxy.small));
        spare.sort((a, b) => a.lastWanted - b.lastWanted);
        let fading = 0;
        for (let i = 0; i < spare.length && w + fading < waiting.length; i++) {
            const s = spare[i];
            if (s.galaxy.inView && s.galaxy.mix > 0) {
                s.galaxy.releasing = true;
                fading++;
            } else {
                clearSlot(s);
                giveSlot(s, waiting[w++], frame.t);
            }
        }
    }

    function nextTile(belowRank) {
        let best = null;
        for (let i = 0; i < slots.length; i++) {
            const s = slots[i];
            const g = s.galaxy;
            if (!g || s.baked || !g.wantTile || g.rank >= belowRank) continue;
            if (!best || g.rank < best.galaxy.rank) best = s;
        }
        return best;
    }

    // Every pass of a bake at once
    function* whole(bake) {
        while (!bake.next().done) { /* The next pass */ }
    }

    function bakeTile(s, frame) {
        startJob(whole(baker.bake(s.galaxy.recipe, tileAtlas, s.rect, TILE, frame.quality)), () => { s.baked = true; }, s);
    }

    // The next few galaxies without a small picture, nearest the middle of the view first
    function nextSmalls(inViewOnly) {
        const list = [];
        for (let i = 0; i < n; i++) {
            const g = galaxies[i];
            if (g.small || (inViewOnly && !g.inView && !g.goalInView)) continue;
            list.push(g);
        }
        list.sort((a, b) => a.off - b.off);
        return list.slice(0, SMALL_PER_STEP);
    }

    // A few small pictures in one step. Each is baked just as its full picture would be, and kept a quarter the size, each pixel
    // the mean of 4 x 4 as that picture's mipmap has it (galaxy_bake.js): so the full picture, when it comes, looks the same.
    function* smallJob(list, quality) {
        for (const g of list) {
            yield* whole(baker.bake(g.recipe, smallAtlas, g.smallRect, TILE, quality));
            g.small = true;
        }
    }

    function startHeroBake(hero, res, frame) {
        const g = hero.galaxy;
        const target = createBakeTarget(res, res);
        hero.baking = true;
        startJob(baker.bake(g.recipe, target, { x: 0, y: 0, w: res, h: res }, res, frame.quality), () => {
            if (hero.target) hero.target.dispose();
            hero.target = target;
            hero.res = res;
            hero.baking = false;
            hero.material.uniforms.tA.value = target.textures[0];
            hero.material.uniforms.tB.value = target.textures[1];
            hero.mesh.visible = true;
            baker.releaseScratch();
        });
    }

    function releaseHero(hero) {
        if (hero.target) hero.target.dispose();
        hero.target = null;
        hero.res = 0;
        hero.fade = 0;
        hero.mesh.visible = false;
        hero.material.uniforms.tA.value = null;
        hero.material.uniforms.tB.value = null;
        if (hero.galaxy) hero.galaxy.hero = null;
        hero.galaxy = null;
    }

    function assignHero(hero, g) {
        if (hero.galaxy) releaseHero(hero);
        hero.galaxy = g;
        g.hero = hero;
        writeInstance(hero.geometry, 0, g, [0, 0, 1, 1]);
        hero.geometry.attributes.aFade.array[0] = 0;
        hero.geometry.attributes.aFade.needsUpdate = true;
    }

    // A slot for this galaxy: its own, a free one, or the one longest out of use. Null if none can be had just now.
    function slotFor(g) {
        if (g.hero) return g.hero;
        let best = null;
        for (let i = 0; i < HERO_SLOTS; i++) {
            const h = heroes[i];
            if (h.wanted || h.forGoal || h.baking) continue;
            if (!h.galaxy) return h;
            if (!best || h.lastWanted < best.lastWanted) best = h;
        }
        return best;
    }

    // The biggest galaxies on screen in a view, biggest first; there are only ever a couple
    function biggestIn(view) {
        const out = [];
        for (let i = 0; i < n; i++) {
            const g = galaxies[i];
            const parallax = parallaxFactor(g.body.depth, view.fov);
            const px = g.halfDeg * 2 * view.pxPerDeg * parallax;
            if (px <= TILE * 1.25) continue;
            if ((offDeg(g, view) - g.halfDeg) * parallax > view.halfView) continue;
            out.push({ g, px });
        }
        return out.sort((a, b) => b.px - a.px).slice(0, HERO_SLOTS);
    }

    // Large pictures for the view as it is, which show; and for where a flight is going, which are baked at take-off
    function chooseHeroes(frame) {
        const cap = HERO_CAP[frame.quality] || HERO_CAP.medium;
        const resFor = (px) => Math.min(cap, 2 ** Math.ceil(Math.log2(px * 0.85)));
        for (let i = 0; i < HERO_SLOTS; i++) {
            heroes[i].wanted = false;
            heroes[i].forGoal = false;
        }
        const take = (list, mark) => list.forEach(({ g, px }) => {
            const hero = slotFor(g);
            if (!hero) return;
            if (hero.galaxy !== g) assignHero(hero, g);
            hero.lastWanted = frame.t;
            if (mark === 'now') {
                hero.wanted = true;
                hero.wantRes = resFor(px);
            } else {
                hero.forGoal = true;
                hero.goalRes = resFor(px);
            }
        });
        take(biggestIn(views.now), 'now');
        if (views.goal && views.goal.flight) take(biggestIn(views.goal), 'goal');
    }

    function pickWork(frame) {
        const cap = HERO_CAP[frame.quality] || HERO_CAP.medium;
        let s = nextTile(0);
        if (s) return bakeTile(s, frame);
        for (let i = 0; i < HERO_SLOTS; i++) {
            const h = heroes[i];
            if (h.forGoal && !h.baking && (h.goalRes > h.res || h.res > cap)) return startHeroBake(h, h.goalRes, frame);
        }
        s = nextTile(1.5);
        if (s) return bakeTile(s, frame);
        let list = nextSmalls(true);
        if (list.length) return startJob(smallJob(list, frame.quality), null);
        s = nextTile(Infinity);
        if (s) return bakeTile(s, frame);
        list = nextSmalls(false);
        if (list.length) return startJob(smallJob(list, frame.quality), null);
        if (baker.hasScratch()) baker.releaseScratch();
        if (stillFor < 0.12) return null;
        for (let i = 0; i < HERO_SLOTS; i++) {
            const h = heroes[i];
            if (h.wanted && (h.wantRes > h.res || h.res > cap)) return startHeroBake(h, h.wantRes, frame);
        }
        return null;
    }

    // Every bake went with the context, and the programs with them
    const offRestored = bus.on('gl-restored', () => {
        job = null;
        jobDone = null;
        jobSlot = null;
        heroes.forEach((h) => {
            h.baking = false;
            h.wanted = false;
            h.forGoal = false;
            releaseHero(h);
        });
        slots.forEach((s) => {
            clearSlot(s);
            s.lastWanted = -1e9;
        });
        galaxies.forEach((g) => {
            g.small = false;
            g.appear = 0;
        });
        baker.releaseScratch();
        compileBaker();
    });

    const layer = {
        id: 'galaxies',
        update(frame) {
            const dt = frame.dt || 0;
            if (coreSprites) coreSprites.material.uniforms.uDpr.value = frame.dpr;
            if (resolved) {
                resolved.material.uniforms.uDpr.value = frame.dpr;
                // Off in the wide sky, where none of them shows yet, so they cost nothing there. A flight draws them as it nears.
                resolved.mesh.visible = app.view !== 'sky' || resolvedData.topGlow * 10 ** (0.4 * (limitingMag(frame.fov) - 6)) >= MIN_GLOW * 0.5;
                if (resolved.mesh.visible) resolvedSet.update(frame);
            }
            frame.camera.getWorldDirection(forward);
            if (Math.abs(frame.fov - lastFov) > frame.fov * 0.001) stillFor = 0;
            else stillFor += Math.max(dt, 0.008);
            // Settled: neither turning nor zooming by more than a twentieth of a pixel a frame
            const turnedPx = Math.acos(Math.max(-1, Math.min(1, forward.dot(lastForward)))) * frame.pxPerRad;
            const zoomedPx = (Math.abs(frame.fov - lastFov) / frame.fov) * frame.height * frame.dpr;
            settledFor = turnedPx + zoomedPx > 0.05 ? 0 : settledFor + Math.max(dt, 0.008);
            lastForward.copy(forward);
            lastFov = frame.fov;

            if (app.view === 'sky') {
                views.now = viewSpec([forward.x, forward.y, forward.z], frame.fov, frame);
                const goal = engine.viewGoal();
                views.goal = goal ? { ...viewSpec(azAltToVec3(goal.az, goal.alt), goal.fov, frame), flight: goal.flight } : null;
                planTiles(frame);
                if (bakerReady) {
                    chooseHeroes(frame);
                    if (!job) pickWork(frame);
                    if (job && engine.bakesAllowed()) {
                        // One step a frame, and a few more on a GPU with room to spare
                        stepsPerFrame = engine.bakePace(stepsPerFrame, 1, STEPS_MOST);
                        stepJob();
                        for (let k = 1; k < Math.floor(stepsPerFrame) && engine.bakeRoom(); k++) {
                            if (!job) pickWork(frame);
                            if (!job) break;
                            stepJob();
                        }
                    }
                }
            }

            // Fades add up to one, since drawing is additive: a galaxy's first picture comes in, a full one takes over from a
            // small one (and gives way to it again), and then a large picture takes over from both. A large picture baked at a
            // flight's take-off waits for the view to settle before it comes in, as one baked there would: its fine detail
            // swept across the screen by a moving view would flicker.
            for (let i = 0; i < HERO_SLOTS; i++) {
                const h = heroes[i];
                if (!h.galaxy) continue;
                const target = h.wanted && h.target ? 1 : 0;
                if (h.fade !== target && (target < h.fade || settledFor >= HERO_SETTLE_S)) {
                    h.fade = target > h.fade ? Math.min(1, h.fade + dt / 0.35) : Math.max(0, h.fade - dt / 0.25);
                    h.geometry.attributes.aFade.array[0] = h.fade;
                    h.geometry.attributes.aFade.needsUpdate = true;
                }
                if (!h.wanted && !h.forGoal && !h.baking && h.fade <= 0 && frame.t - h.lastWanted > HERO_LINGER_S) releaseHero(h);
            }
            const smallFades = smalls.geometry.attributes.aFade;
            const tileFades = tiles.geometry.attributes.aFade;
            let smallDirty = false;
            let tileDirty = false;
            for (let i = 0; i < n; i++) {
                const g = galaxies[i];
                const full = !!(g.slot && g.slot.baked);
                if (g.small || full) g.appear = Math.min(1, g.appear + dt / APPEAR_S);
                if (!full) g.mix = 0;
                else if (!g.small) g.mix = 1;
                else if (g.releasing) g.mix = Math.max(0, g.mix - dt / MIX_OUT_S);
                else g.mix = Math.min(1, g.mix + dt / MIX_IN_S);
                if (g.releasing && g.mix <= 0) clearSlot(g.slot);
                const shown = g.appear * (g.hero ? 1 - g.hero.fade : 1);
                const small = g.small ? shown * (1 - g.mix) : 0;
                if (smallFades.array[i] !== small) {
                    smallFades.array[i] = small;
                    smallDirty = true;
                }
                if (g.slot && tileFades.array[g.slot.index] !== shown * g.mix) {
                    tileFades.array[g.slot.index] = shown * g.mix;
                    tileDirty = true;
                }
            }
            for (let i = 0; i < slots.length; i++) {
                if (slots[i].galaxy || tileFades.array[i] === 0) continue;
                tileFades.array[i] = 0;
                tileDirty = true;
            }
            if (smallDirty) smallFades.needsUpdate = true;
            if (tileDirty) tileFades.needsUpdate = true;
        },

        picks(frame) {
            const out = [];
            const pxPerDeg = (frame.pxPerRad * RAD) / frame.dpr;
            const lim = limitingMag(frame.fov);
            const band = BAND_INDEX[app.band];
            const atLimit = frame.fov <= MIN_FOV * NUCLEUS_LIMIT_SHARE;
            for (let i = 0; i < n; i++) {
                const g = galaxies[i];
                const { body } = g;
                if ((body.bands[app.band] || 0) <= 0.01) continue;
                if (revealGain(g.mags[app.band], lim) < 0.03) continue;
                const pxPerDegHere = pxPerDeg * parallaxFactor(body.depth, frame.fov);
                const major = body.galaxy.size_deg / 2;
                // Close in on a feeding black hole's galaxy, its point answers for itself, ahead of the galaxy round it. A quiet
                // hole has no point of its own, but is at the middle all the same, so a zoom there carries on into it too.
                const majorPx = major * pxPerDegHere;
                const hole = g.core ? (coreShows(g.core, band, lim) ? g.core.code : null) : body.nucleus ? body.nucleus.code : null;
                if (hole && (majorPx >= NUCLEUS_OPENS_PX || (atLimit && majorPx >= NUCLEUS_OPENS_AT_LIMIT_PX))) {
                    out.push({ code: hole, az: body.sky.az, alt: body.sky.alt, radiusPx: NUCLEUS_REACH_PX, depth: body.depth });
                }
                if (major * pxPerDegHere < 14) {
                    out.push({ code: body.code, az: body.sky.az, alt: body.sky.alt, radiusPx: 0, depth: body.depth });
                    continue;
                }
                const flat = g.recipe.kind === 1 ? 0.85 : Math.max(0.22, Math.cos(g.recipe.incl));
                scatterPicks(out, body.code, g.basis, body.galaxy.position_angle_deg, major, major * flat, 30 / pxPerDegHere, body.depth);
            }
            if (app.band === 'radio') {
                // A click on a lobe finds its galaxy
                lobeSources.forEach((src, i) => {
                    const stepDeg = 30 / (pxPerDeg * parallaxFactor(src.depth, frame.fov));
                    scatterPicks(out, lobed[i].body.code, lobed[i].basis, src.positionAngleDeg, src.spanDeg / 2, src.spanDeg * 0.1, stepDeg, src.depth);
                });
            }
            return out;
        },

        // The field of view at which a zoom on a galaxy's black hole carries on into it (render/system/zoom_into.js): once its
        // galaxy fills the view. A small, far galaxy never does, so for that it's the narrowest view.
        nucleusFov(code) {
            const g = galaxies.find((x) => x.core && x.core.code === code) || galaxies.find((x) => x.body.nucleus && x.body.nucleus.code === code);
            if (!g) return MIN_FOV;
            const major = g.body.galaxy.size_deg / 2;
            // Near enough for a view this narrow: pixels per degree ~ height / fov
            let fov = major / NUCLEUS_ENTER_SHARE;
            for (let k = 0; k < 4; k++) fov = (major * parallaxFactor(g.body.depth, fov)) / NUCLEUS_ENTER_SHARE;
            return Math.max(MIN_FOV, fov);
        },

        // For tests: is everything that's wanted baked? Every small picture, the full ones wanted where there's room for them,
        // and the large ones.
        idle() {
            if (job) return false;
            for (let i = 0; i < n; i++) {
                const g = galaxies[i];
                if (!g.small || g.releasing || (g.wantTile && g.slot && !g.slot.baked)) return false;
            }
            return heroes.every((h) => (!h.wanted || h.wantRes <= h.res) && (!h.forGoal || h.goalRes <= h.res));
        },

        // For tests: bytes of GPU memory the pictures hold now, mipmaps and all (each target is two 8-bit images)
        textureBytes() {
            const bytes = (t) => (t ? (t.width * t.height * 8 * 4) / 3 : 0);
            return { atlases: bytes(smallAtlas) + bytes(tileAtlas), large: heroes.reduce((sum, h) => sum + bytes(h.target), 0) };
        },

        // For tests: how many galaxies have a full picture in place, and how many want one; and what one galaxy has
        tileStats() {
            return {
                held: slots.filter((s) => s.galaxy && s.baked).length,
                wanted: galaxies.filter((g) => g.wantTile).length,
                small: galaxies.filter((g) => g.small).length,
                slots: slots.length
            };
        },
        pictureOf(code) {
            const g = galaxies.find((x) => x.body.code === code);
            if (!g) return null;
            return {
                small: g.small, tile: !!(g.slot && g.slot.baked), mix: g.mix, appear: g.appear,
                large: g.hero ? g.hero.res : 0, largeWanted: g.hero ? Math.max(g.hero.wanted ? g.hero.wantRes : 0, g.hero.forGoal ? g.hero.goalRes : 0) : 0,
                largeFade: g.hero ? g.hero.fade : 0
            };
        },

        dispose() {
            compileRun += 1;
            offRestored();
            heroes.forEach((h) => {
                releaseHero(h);
                scene.remove(h.mesh);
                h.geometry.dispose();
                h.material.dispose();
            });
            [smalls, tiles].forEach((part) => {
                scene.remove(part.mesh);
                part.geometry.dispose();
                part.material.dispose();
            });
            scene.remove(nuclei);
            nucleusGeometry.dispose();
            nucleusMaterial.dispose();
            smallAtlas.dispose();
            tileAtlas.dispose();
            baker.dispose();
            lobes.dispose();
            offCoreQuality();
            [coreSprites, coreSpikes, resolved].forEach((part) => {
                if (!part) return;
                scene.remove(part.mesh);
                part.geometry.dispose();
                part.material.dispose();
            });
        }
    };

    return layer;
}
