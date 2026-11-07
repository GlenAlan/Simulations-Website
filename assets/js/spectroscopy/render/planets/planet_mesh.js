// Builds a planet from its data and its host's temperature. createPlanetMesh returns
// { object3d, update(frame, sunDirWorld), dispose() } with radius 1, so the caller scales it to suit.
// Composition and physics decide the look (appearance.js); the seed only varies the pattern (spec 6.4).
//
// Small or at Low quality, a planet draws from a cube map baked once from its own shader, spread over a few frames.
// Large on screen, it works out its surface per pixel. Both output linear HDR for the engine's tone mapping.
//
// The bake's and the live program's compile can take seconds on Windows, and drawing with an unfinished one would freeze
// the page, so a planet never waits for them on screen. It starts as a flat disc in its average colours, drawn by the
// small baked program; the bake fades in over that once it's done, and the live program takes over once it has compiled.
//
// Also on the returned object: look (the appearanceFrom block) and setOpacity(0..1) for fading in.
// opts: quality (overrides frame.quality), timeScale (of the decorative spin), renderer (found by itself otherwise).
// warmPlanetShaders(renderer) compiles what every planet shares, and warmPlanetBakes(renderer, planets) what these planets
// will need, without blocking.

import * as THREE from 'three';
import { app, bus } from '../../core/state.js';
import { appearanceFrom, ringProfile } from './appearance.js';
import {
    liveBodyFragment, bakeFragment, BAKED_BODY_FRAGMENT, BODY_VERTEX, BAKE_VERTEX,
    SHELL_VERTEX, SHELL_FRAGMENT, RING_VERTEX, RING_FRAGMENT
} from './planet_glsl.js';

const QUALITY = {
    low: { oct: 4, steps: 0, shell: false, liveAbovePx: Infinity, bakeOct: 6 },
    medium: { oct: 5, steps: 6, shell: true, liveAbovePx: 520, bakeOct: 6 },
    high: { oct: 7, steps: 10, shell: true, liveAbovePx: 140, bakeOct: 7 }
};

// One sphere for every planet. The body's is drawn slightly oversize and its true edge is found in the shader.
let bodyGeometry = null;
let shellGeometry = null;
let bakeQuad = null;
let bakeScene = null;
let bakeCamera = null;
let bakeMesh = null;
let blackTexture = null;

function sharedGeometry() {
    if (bodyGeometry) return;
    bodyGeometry = new THREE.SphereGeometry(1, 64, 48);
    shellGeometry = new THREE.SphereGeometry(1, 64, 40);
    bakeQuad = new THREE.PlaneGeometry(2, 2);
    bakeScene = new THREE.Scene();
    bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    bakeMesh = new THREE.Mesh(bakeQuad);
    bakeMesh.frustumCulled = false;
    bakeScene.add(bakeMesh);
    blackTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blackTexture.needsUpdate = true;
}

// How each cube face's (s, t) in -1..1 maps to a direction, as the columns of a matrix (the GL cube map convention)
const FACES = [
    [[0, 0, -1], [0, -1, 0], [1, 0, 0]],
    [[0, 0, 1], [0, -1, 0], [-1, 0, 0]],
    [[1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[1, 0, 0], [0, 0, -1], [0, -1, 0]],
    [[1, 0, 0], [0, -1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, -1, 0], [0, 0, -1]]
].map((c) => new THREE.Matrix3().fromArray([...c[0], ...c[1], ...c[2]]));

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// Bakes share a budget of pixels per frame, so that entering a system does not stall on several at once. It follows
// what the GPU is getting through, and a face that won't fit is drawn a few rows at a time.
let bakeFrame = null;
let bakedPixelsThisFrame = 0;
let budgetResetQueued = false;
const BAKE_PIXELS_MIN = 8192;
const BAKE_PIXELS_MAX = 262144;
let bakePixelsPerFrame = 65536;

const BAKE_FADE_S = 0.4;

const BLENDED_BODY = { transparent: true, premultipliedAlpha: true, depthWrite: true, toneMapped: false };
const BLENDED_SHELL = { side: THREE.BackSide, transparent: true, premultipliedAlpha: true, depthWrite: false, toneMapped: false };
const BLENDED_RING = { side: THREE.DoubleSide, transparent: true, premultipliedAlpha: true, depthWrite: false, toneMapped: false };
const BAKE_FLAGS = { depthTest: false, depthWrite: false, toneMapped: false };

// Which parts of the surface shader this planet can use: the rest are left out of its programs (see planet_glsl.js)
export function planetFeatures(look) {
    const defines = {};
    const on = (name, value) => {
        if (value > 0) defines[name] = 1;
    };
    if (look.solid) {
        const s = look.solid;
        on('P_MARIA', s.maria);
        on('P_RIDGES', s.ridges);
        on('P_CANYONS', s.canyons);
        on('P_DUNES', s.dunes);
        on('P_CRACKS', s.cracks);
        on('P_PLAINS', s.plains);
        on('P_LAVA', s.lava);
        on('P_DAY_MELT', s.dayMelt);
        on('P_CRATERS', s.craters > 0.002 && !(s.lava > 0) ? 1 : 0); // Melt takes every crater with it
        on('P_FROST', s.frost);
        on('P_LIQUID', s.oceanFraction);
        on('P_VEGETATION', s.vegetation);
        on('P_CAP', s.cap);
        on('P_CLOUDS', look.clouds.opacity);
        on('P_VEIL', look.clouds.veil);
    } else {
        on('P_CIRRUS', look.envelope.cirrus);
    }
    return defines;
}

// Compiles a program in the background and holds on to it, with a material that's never drawn. Three.js frees a program
// when the last material using it goes, which would mean compiling it all over again for the next planet of that kind.
// A real material with the same source and flags picks up the same program. Returns { ready }.
const keptPrograms = new Map();

function keepProgram(renderer, key, params) {
    let kept = keptPrograms.get(key);
    if (kept) return kept;
    sharedGeometry();
    kept = { ready: false };
    keptPrograms.set(key, kept);
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(bakeQuad, new THREE.ShaderMaterial(params));
    mesh.frustumCulled = false;
    scene.add(mesh);
    const compiling = app.engine ? app.engine.compileInBackground(scene, bakeCamera) : renderer.compileAsync(scene, bakeCamera);
    compiling.then(() => {
        kept.ready = true;
    }, () => {
        kept.ready = true;  // Let it be found out when it's drawn, where its error will show
    });
    return kept;
}

// They went with the context
bus.on('gl-restored', () => keptPrograms.clear());

function keepBake(renderer, model, defines) {
    return keepProgram(renderer, `bake:${model}:${Object.keys(defines).join()}`, {
        ...BAKE_FLAGS,
        defines,
        vertexShader: BAKE_VERTEX,
        fragmentShader: bakeFragment(model)
    });
}

function keepLive(renderer, model, defines) {
    return keepProgram(renderer, `live:${model}:${Object.keys(defines).join()}`, {
        ...BLENDED_BODY,
        defines,
        vertexShader: BODY_VERTEX,
        fragmentShader: liveBodyFragment(model)
    });
}

function jetIndex(lat, bandN, phase) {
    const warped = lat + 0.05 * Math.sin(lat * 6 + phase) + 0.03 * Math.sin(lat * 11 + phase * 2.3);
    return Math.floor((warped * 0.5 + 0.5) * bandN);
}

function jetRate(i, phase) {
    return (((i % 2) + 2) % 2 < 1 ? 1 : -1) * (0.75 + 0.25 * Math.sin(i * 2.4 + phase));
}

function patternUniforms(look) {
    const u = {
        uSeed: { value: v3(look.seedOffset) },
        uOct: { value: 5 },
        uPhase: { value: look.seedPhase },
        uLocked: { value: look.locked ? 1 : 0 },
        uStormN: { value: look.storms.length },
        uStormA: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 1, 0, 0.1)) },
        uStormB: { value: Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, 0)) }
    };
    look.storms.slice(0, 6).forEach((storm, i) => {
        u.uStormB.value[i].set(storm.spin, storm.strength, 0, 0);
        u.uStormA.value[i].w = storm.radius;
    });
    u.uStormN.value = Math.min(6, look.storms.length);
    if (look.solid) {
        const s = look.solid;
        const c = look.clouds;
        Object.assign(u, {
            uRockA: { value: v3(s.rockMain) },
            uRockB: { value: v3(s.rockDark) },
            uRockC: { value: v3(s.rockBright) },
            uIce: { value: v3(s.iceColour) },
            uLine: { value: v3(s.lineColour) },
            uDeep: { value: v3(s.deepWater) },
            uShallow: { value: v3(s.shallowWater) },
            uLeaf: { value: v3(s.leaf) },
            uLeafDry: { value: v3(s.leafDry) },
            uSea: { value: s.seaLevel },
            uLiquid: { value: s.oceanFraction },
            uVegetation: { value: s.vegetation },
            uCraters: { value: s.craters },
            uRidges: { value: s.ridges },
            uCanyons: { value: s.canyons },
            uMaria: { value: s.maria },
            uDunes: { value: s.dunes },
            uSalt: { value: s.saltFlats },
            uCracks: { value: s.cracks },
            uPlains: { value: s.plains },
            uLava: { value: s.lava },
            uDayMelt: { value: s.dayMelt },
            uMelt: { value: s.melt },
            uCap: { value: s.cap },
            uFrost: { value: s.frost },
            uCloudLevel: { value: c.level },
            uCloudOpacity: { value: c.opacity },
            uCloudSoft: { value: c.soft },
            uCloudSwirl: { value: c.swirl },
            uCloudStreak: { value: c.streak },
            uCloudAlt: { value: c.altitude },
            uCloudVeil: { value: c.veil },
            uFlow: { value: 0 }
        });
    } else {
        const e = look.envelope;
        Object.assign(u, {
            uZone: { value: v3(e.zone) },
            uBelt: { value: v3(e.belt) },
            uAccent: { value: v3(e.accent) },
            uStormCol: { value: v3(e.storm) },
            uBands: { value: e.bands },
            uBandN: { value: e.bandCount },
            uTurb: { value: e.turbulence },
            uStretch: { value: e.stretch },
            uWobble: { value: e.wobble },
            uDetail: { value: e.detail },
            uCirrus: { value: e.cirrus },
            uPolar: { value: e.polar },
            uChevron: { value: e.chevron },
            uJetT: { value: 0 }
        });
    }
    return u;
}

function makeRingTexture(look) {
    const { opacity, tone } = ringProfile(look.seedText);
    const n = opacity.length;
    const data = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
        data[i * 4] = Math.round(opacity[i] * 255);
        data[i * 4 + 1] = Math.round(tone[i] * 255);
        data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, n, 1);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
}

// The small programs every planet uses. Optional: call it when the sim has loaded and nothing else is going on.
export function warmPlanetShaders(renderer) {
    keepProgram(renderer, 'baked', { ...BLENDED_BODY, vertexShader: BODY_VERTEX, fragmentShader: BAKED_BODY_FRAGMENT });
    keepProgram(renderer, 'shell', { ...BLENDED_SHELL, vertexShader: SHELL_VERTEX, fragmentShader: SHELL_FRAGMENT });
    keepProgram(renderer, 'ring', { ...BLENDED_RING, vertexShader: RING_VERTEX, fragmentShader: RING_FRAGMENT });
}

// The bake programs these planets will need, for when one of them is about to be visited
export function warmPlanetBakes(renderer, planets) {
    planets.forEach((planet) => {
        const look = appearanceFrom(planet, planet.host_teff_K);
        keepBake(renderer, look.model, planetFeatures(look));
    });
}

export function createPlanetMesh(planet, hostTeffK, opts = {}) {
    sharedGeometry();
    const look = appearanceFrom(planet, hostTeffK);
    const a = look.atmosphere;
    const r = look.rings;
    const isSolid = look.model === 'solid';
    const timeScale = opts.timeScale ?? 1;
    const defines = planetFeatures(look);

    const pattern = patternUniforms(look);
    const ringTexture = r ? makeRingTexture(look) : null;

    // Shared by reference between the materials, so setting a value once reaches them all
    const shared = {
        uCam: { value: new THREE.Vector3(0, 0, 5) },
        uSun: { value: new THREE.Vector3(1, 0, 0) },
        uSunCol: { value: v3(look.sun) },
        uSpin: { value: look.phase0 },
        uCloudSpin: { value: look.phase0 * 1.7 },
        uOpacity: { value: 1 },
        uH: { value: a.H },
        uTop: { value: a.top },
        uBetaR: { value: v3(a.betaR) },
        uBetaM: { value: v3(a.betaM) },
        uBetaA: { value: v3(a.betaA) },
        uMieG: { value: a.g },
        uAtmGain: { value: a.gain },
        uSunHaze: { value: a.sunHaze },
        uAtmSteps: { value: 6 },
        uHasRings: { value: r ? 1 : 0 },
        tRing: { value: ringTexture || blackTexture },
        uRingIn: { value: r ? r.inner : 2 },
        uRingOut: { value: r ? r.outer : 3 },
        uRingOpacity: { value: r ? r.opacity : 0 }
    };
    const shading = {
        ...shared,
        uInflate: { value: 1.01 },
        uRimCol: { value: v3(a.limb) },
        uHazeGlow: { value: a.hazeGlow },
        uRim: { value: a.rim },
        uRimPower: { value: a.rimPower },
        uRegolith: { value: isSolid ? look.solid.regolith : 0 },
        uWrap: { value: a.wrap },
        uIsEnvelope: { value: isSolid ? 0 : 1 },
        uRelief: { value: isSolid ? look.solid.relief : 0 },
        uLimbDark: { value: isSolid ? 0 : look.envelope.limbDark },
        uCloudCol: { value: v3(look.clouds.colour) },
        uCloudShade: { value: v3(look.clouds.shade) },
        uEmitCool: { value: v3(look.emission.cool) },
        uEmitWarm: { value: v3(look.emission.warm) },
        uEmitHot: { value: v3(look.emission.hot) },
        uHasEmit: { value: look.emission.on ? 1 : 0 }
    };

    const liveMaterial = new THREE.ShaderMaterial({
        ...BLENDED_BODY,
        defines,
        vertexShader: BODY_VERTEX,
        fragmentShader: liveBodyFragment(look.model),
        uniforms: { ...shading, ...pattern }
    });
    // Draws the bake when there is one, and until then a flat disc in the planet's average colours
    const flatAlbedo = isSolid
        ? new THREE.Vector3(...look.solid.rockMain).lerp(new THREE.Vector3(...look.solid.deepWater), look.solid.oceanFraction)
        : new THREE.Vector3(...look.envelope.zone).lerp(new THREE.Vector3(...look.envelope.belt), 0.5);
    const bakedMaterial = new THREE.ShaderMaterial({
        ...BLENDED_BODY,
        vertexShader: BODY_VERTEX,
        fragmentShader: BAKED_BODY_FRAGMENT,
        uniforms: {
            ...shading,
            tSurface: { value: null },
            tExtras: { value: null },
            uBakeTexel: { value: 2 / 128 },
            uBakeMix: { value: 0 },
            uFlatAlbedo: { value: flatAlbedo },
            uFlatCloud: { value: look.clouds.opacity * 0.4 },
            uCloudAlt: { value: look.clouds.altitude },
            uCloudOpacity: { value: look.clouds.opacity }
        }
    });

    const object3d = new THREE.Group();
    const tilt = new THREE.Group();
    tilt.rotation.set(look.tiltDeg * Math.PI / 180, 0, look.tiltDeg * 0.37 * Math.PI / 180);
    object3d.add(tilt);

    const body = new THREE.Mesh(bodyGeometry, bakedMaterial);
    tilt.add(body);

    let shell = null;
    let shellMaterial = null;
    if (a.on) {
        shellMaterial = new THREE.ShaderMaterial({
            ...BLENDED_SHELL,
            vertexShader: SHELL_VERTEX,
            fragmentShader: SHELL_FRAGMENT,
            uniforms: { ...shared, uShellR: { value: a.top } }
        });
        shell = new THREE.Mesh(shellGeometry, shellMaterial);
        shell.scale.setScalar(a.top);
        tilt.add(shell);
    }

    let ring = null;
    let ringMaterial = null;
    let ringGeometry = null;
    if (r) {
        ringGeometry = new THREE.RingGeometry(r.inner * 0.995, r.outer * 1.005, 192, 1);
        ringGeometry.rotateX(-Math.PI / 2);
        ringMaterial = new THREE.ShaderMaterial({
            ...BLENDED_RING,
            vertexShader: RING_VERTEX,
            fragmentShader: RING_FRAGMENT,
            uniforms: {
                ...shared,
                uRingCol: { value: v3(r.colour) },
                uRingDark: { value: v3(r.colourDark) }
            }
        });
        ring = new THREE.Mesh(ringGeometry, ringMaterial);
        tilt.add(ring);
    }

    // Camera-dependent uniforms are set as each part is about to draw: that way they use the camera actually
    // rendering, whichever one the caller draws its system scene with.
    const camLocal = new THREE.Vector3();
    const invTilt = new THREE.Matrix4();
    let renderer = opts.renderer || (app.engine && app.engine.renderer) || null;
    let pixelDiameter = 0;
    let measured = false;      // Once it has been drawn, its size on screen is known for certain
    function syncCamera(glRenderer, camera) {
        renderer = glRenderer;
        measured = true;
        invTilt.copy(tilt.matrixWorld).invert();
        camLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(invTilt);
        shared.uCam.value.copy(camLocal);
        const target = glRenderer.getRenderTarget();
        const heightPx = target ? target.height : glRenderer.domElement.height;
        const dist = camLocal.length();
        const focal = camera.projectionMatrix.elements[5];  // 1 / tan(fov / 2)
        const pxLocal = 2 * dist / (heightPx * focal);      // Size of a pixel at the planet, in planet radii
        shading.uInflate.value = 1.0018 + 3 * pxLocal;
        pixelDiameter = 2 / pxLocal;
    }
    body.onBeforeRender = (gl, scene, camera) => syncCamera(gl, camera);
    if (shell) shell.onBeforeRender = (gl, scene, camera) => syncCamera(gl, camera);
    if (ring) ring.onBeforeRender = (gl, scene, camera) => syncCamera(gl, camera);

    // --- Baking ---
    let bakeMaterial = null;
    let bakeProgram = null;
    let liveProgram = null;
    let baked = null;      // { surface, extras, size } when ready
    let bakeJob = null;    // { surface, extras, size, step, row } while in progress

    function startBake(size) {
        const params = {
            generateMipmaps: false, // Turned on for the last row of each map: its mipmaps only need making once
            minFilter: THREE.LinearMipmapLinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: false
        };
        bakeJob = {
            surface: new THREE.WebGLCubeRenderTarget(size, { ...params, type: THREE.HalfFloatType }),
            extras: new THREE.WebGLCubeRenderTarget(size, { ...params, type: THREE.UnsignedByteType }),
            size,
            step: 0,
            row: 0
        };
    }

    function runBakeStep(glRenderer, quality, frame) {
        if (!bakeProgram) bakeProgram = keepBake(glRenderer, look.model, defines);
        if (!bakeProgram.ready) return;
        const engine = app.engine;
        if (engine && !engine.bakesAllowed()) return;
        if (!bakeMaterial) {
            bakeMaterial = new THREE.ShaderMaterial({
                ...BAKE_FLAGS,
                defines,
                vertexShader: BAKE_VERTEX,
                fragmentShader: bakeFragment(look.model),
                uniforms: {
                    ...pattern,
                    uSun: shared.uSun,
                    uFace: { value: FACES[0] },
                    uLayer: { value: 0 },
                    uBakePx: { value: 0.01 }
                }
            });
        }
        // A new frame resets the budget; so does the browser's next frame, in case a caller reuses one frame object.
        // Going by elapsed time would not do: on a slow machine a single bake outlasts any limit, and nothing would hold.
        if (frame !== bakeFrame) {
            bakeFrame = frame;
            bakedPixelsThisFrame = 0;
            if (engine) bakePixelsPerFrame = engine.bakePace(bakePixelsPerFrame, BAKE_PIXELS_MIN, BAKE_PIXELS_MAX);
        }
        if (!budgetResetQueued) {
            budgetResetQueued = true;
            requestAnimationFrame(() => {
                budgetResetQueued = false;
                bakedPixelsThisFrame = 0;
            });
        }
        const previous = glRenderer.getRenderTarget();
        const previousFace = glRenderer.getActiveCubeFace();
        const previousMip = glRenderer.getActiveMipmapLevel();
        const savedOct = pattern.uOct.value;
        pattern.uOct.value = QUALITY[quality].bakeOct;
        bakeMaterial.uniforms.uBakePx.value = 2.2 / bakeJob.size;
        bakeMesh.material = bakeMaterial;
        const { size } = bakeJob;
        // Always a row or two at least, so that the largest size still gets done
        while (bakeJob.step < 12 && (bakedPixelsThisFrame === 0 || bakedPixelsThisFrame + size * 8 <= bakePixelsPerFrame)) {
            const layer = bakeJob.step < 6 ? 0 : 1;
            const face = bakeJob.step % 6;
            const room = Math.floor((bakePixelsPerFrame - bakedPixelsThisFrame) / size);
            const rows = Math.min(size - bakeJob.row, Math.max(2, room));
            const target = layer === 0 ? bakeJob.surface : bakeJob.extras;
            const lastOfMap = face === 5 && bakeJob.row + rows >= size;
            target.texture.generateMipmaps = lastOfMap;
            target.scissorTest = true;
            target.scissor.set(0, bakeJob.row, size, rows);
            bakeMaterial.uniforms.uFace.value = FACES[face];
            bakeMaterial.uniforms.uLayer.value = layer;
            glRenderer.setRenderTarget(target, face);
            glRenderer.render(bakeScene, bakeCamera);
            target.texture.generateMipmaps = false;
            bakedPixelsThisFrame += size * rows;
            bakeJob.row += rows;
            if (bakeJob.row >= size) {
                bakeJob.row = 0;
                bakeJob.step++;
            }
        }
        glRenderer.setRenderTarget(previous, previousFace, previousMip);
        pattern.uOct.value = savedOct;
        if (bakeJob.step >= 12) finishBake();
    }

    function finishBake() {
        if (baked) {
            baked.surface.dispose();
            baked.extras.dispose();
        }
        baked = bakeJob;
        bakeJob = null;
        baked.surface.scissorTest = false;
        baked.extras.scissorTest = false;
        bakedMaterial.uniforms.tSurface.value = baked.surface.texture;
        bakedMaterial.uniforms.tExtras.value = baked.extras.texture;
        bakedMaterial.uniforms.uBakeTexel.value = 2 / baked.size;
    }

    // Nothing baked survives a lost context: back to the flat disc until it has baked again
    const offRestored = bus.on('gl-restored', () => {
        baked = null;
        bakeJob = null;
        bakeProgram = null;
        liveProgram = null;
        bakeMix = 0;
        bakedMaterial.uniforms.uBakeMix.value = 0;
        bakedMaterial.uniforms.tSurface.value = null;
        bakedMaterial.uniforms.tExtras.value = null;
    });

    function bakeSizeFor(px) {
        if (px < 96) return 128;
        return px < 300 ? 256 : 512;
    }

    // Storms ride their jets, which the clouds of a rocky world do not have
    const stormJets = look.storms.slice(0, 6).map((storm) => (isSolid ? 0 : jetRate(jetIndex(storm.lat, look.envelope.bandCount, look.seedPhase), look.seedPhase)));
    function placeStorms(jetT) {
        for (let i = 0; i < stormJets.length; i++) {
            const storm = look.storms[i];
            const lon = storm.lon - jetT * stormJets[i];
            const cosLat = Math.cos(storm.lat * Math.PI / 2);
            const a4 = pattern.uStormA.value[i];
            a4.x = cosLat * Math.cos(lon);
            a4.y = Math.sin(storm.lat * Math.PI / 2);
            a4.z = cosLat * Math.sin(lon);
        }
    }
    placeStorms(0);

    // --- Time ---
    let clock = 0;
    let useBaked = true;
    let bakeMix = 0;

    let fixedQuality = opts.quality;

    function update(frame, sunDirWorld) {
        const quality = fixedQuality || (frame && frame.quality) || 'medium';
        const q = QUALITY[quality] || QUALITY.medium;
        if (frame && !frame.reduceMotion) clock += (frame.dt || 0) * timeScale;

        // Decorative spin is slow, and stops with Reduce motion
        shared.uSpin.value = look.phase0 + clock * look.spinRate;
        shared.uCloudSpin.value = look.phase0 * 1.7 + clock * (look.spinRate + look.cloudDrift);

        object3d.updateWorldMatrix(true, true);
        invTilt.copy(tilt.matrixWorld).invert();
        if (sunDirWorld) {
            if (Array.isArray(sunDirWorld)) shared.uSun.value.fromArray(sunDirWorld);
            else shared.uSun.value.copy(sunDirWorld);
            shared.uSun.value.transformDirection(invTilt);
            // A locked world turns with its orbit, not with the clock: this keeps +x of its pattern under the star
            if (look.locked) shared.uSpin.value = Math.atan2(shared.uSun.value.z, shared.uSun.value.x);
        }
        if (frame && frame.camera && !measured) {
            // Not drawn yet: this is the first estimate of its size, from the camera the frame names
            camLocal.setFromMatrixPosition(frame.camera.matrixWorld).applyMatrix4(invTilt);
            shared.uCam.value.copy(camLocal);
            const heightPx = (frame.height || 720) * (frame.dpr || 1);
            pixelDiameter = heightPx * frame.camera.projectionMatrix.elements[5] / camLocal.length();
        }

        pattern.uOct.value = q.oct;
        shared.uAtmSteps.value = q.steps;
        if (shell) shell.visible = q.shell;

        // Live or baked, with a margin so that it does not flip back and forth at the threshold. Live has to wait for its
        // program, and the bake stands in until then, however large the planet is.
        const px = pixelDiameter || (quality === 'low' ? 64 : 0);
        const margin = useBaked ? 1.2 : 0.85;
        const wantBaked = px > 0 && px < q.liveAbovePx * margin;
        const wantLive = px > 0 && !wantBaked;
        if (wantLive && !liveProgram && renderer) liveProgram = keepLive(renderer, look.model, defines);
        const liveReady = wantLive && liveProgram && liveProgram.ready;

        if (renderer && (wantBaked || (wantLive && !liveReady))) {
            const size = measured ? bakeSizeFor(px) : Math.min(256, bakeSizeFor(px));
            const have = bakeJob ? bakeJob.size : baked ? baked.size : 0;
            if (have < size) {
                if (bakeJob) {
                    bakeJob.surface.dispose();
                    bakeJob.extras.dispose();
                }
                startBake(size);
            }
        }
        if (renderer && bakeJob) runBakeStep(renderer, quality, frame);

        if (baked && bakeMix < 1) {
            bakeMix = frame && frame.reduceMotion ? 1 : Math.min(1, bakeMix + ((frame && frame.dt) || 0) / BAKE_FADE_S);
            bakedMaterial.uniforms.uBakeMix.value = bakeMix;
        }

        useBaked = !liveReady;
        if (!bakeJob && !useBaked && !isSolid) pattern.uJetT.value = clock * look.spinRate * look.envelope.jetSpeed * 0.12;
        if (isSolid && !bakeJob && !useBaked) pattern.uFlow.value = clock * 0.03;

        if (!isSolid) placeStorms(pattern.uJetT.value);

        body.material = useBaked ? bakedMaterial : liveMaterial;
    }

    function setOpacity(value) {
        shared.uOpacity.value = Math.max(0, Math.min(1, value));
    }

    function dispose() {
        offRestored();
        liveMaterial.dispose();
        bakedMaterial.dispose();
        if (bakeMaterial) bakeMaterial.dispose();
        if (shellMaterial) shellMaterial.dispose();
        if (ringMaterial) ringMaterial.dispose();
        if (ringGeometry) ringGeometry.dispose();
        if (ringTexture) ringTexture.dispose();
        [baked, bakeJob].forEach((b) => {
            if (!b) return;
            b.surface.dispose();
            b.extras.dispose();
        });
        object3d.removeFromParent();
    }

    update({ dt: 0, quality: opts.quality || 'medium', reduceMotion: true }, null);

    // What's already baked stays up: it's only baked again if a different level wants it larger
    function setQuality(level) {
        fixedQuality = level;
    }

    return { object3d, update, dispose, setOpacity, setQuality, look, meanColour: [flatAlbedo.x, flatAlbedo.y, flatAlbedo.z] };
}
