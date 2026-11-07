// Builds a planet from its data and its host's temperature. createPlanetMesh returns
// { object3d, update(frame, sunDirWorld), dispose() } with radius 1, so the caller scales it to suit.
// Composition and physics decide the look (appearance.js); the seed only varies the pattern (spec 6.4).
//
// Small or at Low quality, a planet draws from a cube map baked once from its own shader, spread over a few frames.
// Large on screen, it works out its surface per pixel. Both output linear HDR for the engine's tone mapping.
//
// Also on the returned object: look (the appearanceFrom block) and setOpacity(0..1) for fading in.

import * as THREE from 'three';
import { appearanceFrom, ringProfile } from './appearance.js';
import {
    liveBodyFragment, bakeFragment, BAKED_BODY_FRAGMENT, BODY_VERTEX, BAKE_VERTEX,
    SHELL_VERTEX, SHELL_FRAGMENT, RING_VERTEX, RING_FRAGMENT
} from './planet_glsl.js';

const QUALITY = {
    low: { oct: 4, steps: 0, shell: false, liveAbovePx: Infinity, bakeOct: 6 },
    medium: { oct: 5, steps: 6, shell: true, liveAbovePx: 260, bakeOct: 6 },
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

// Bakes share a budget so that entering a system does not stall on several at once
let bakeFrame = -1;
let bakesThisFrame = 0;
const BAKE_FACES_PER_FRAME = 2;

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

export function createPlanetMesh(planet, hostTeffK, opts = {}) {
    sharedGeometry();
    const look = appearanceFrom(planet, hostTeffK);
    const a = look.atmosphere;
    const r = look.rings;
    const isSolid = look.model === 'solid';
    const timeScale = opts.timeScale ?? 1;

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
        uCloudCol: { value: v3(look.clouds.colour) },
        uCloudShade: { value: v3(look.clouds.shade) },
        uEmitCool: { value: v3(look.emission.cool) },
        uEmitWarm: { value: v3(look.emission.warm) },
        uEmitHot: { value: v3(look.emission.hot) },
        uHasEmit: { value: look.emission.on ? 1 : 0 }
    };

    const blendedBody = {
        vertexShader: BODY_VERTEX,
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: true,
        toneMapped: false
    };
    const liveMaterial = new THREE.ShaderMaterial({
        ...blendedBody,
        fragmentShader: liveBodyFragment(look.model),
        uniforms: { ...shading, ...pattern }
    });
    let bakedMaterial = null;   // Made when first needed

    const object3d = new THREE.Group();
    const tilt = new THREE.Group();
    tilt.rotation.set(look.tiltDeg * Math.PI / 180, 0, look.tiltDeg * 0.37 * Math.PI / 180);
    object3d.add(tilt);

    const body = new THREE.Mesh(bodyGeometry, liveMaterial);
    tilt.add(body);

    let shell = null;
    let shellMaterial = null;
    if (a.on) {
        shellMaterial = new THREE.ShaderMaterial({
            vertexShader: SHELL_VERTEX,
            fragmentShader: SHELL_FRAGMENT,
            uniforms: { ...shared, uShellR: { value: a.top } },
            side: THREE.BackSide,
            transparent: true,
            premultipliedAlpha: true,
            depthWrite: false,
            toneMapped: false
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
            vertexShader: RING_VERTEX,
            fragmentShader: RING_FRAGMENT,
            uniforms: {
                ...shared,
                uRingCol: { value: v3(r.colour) },
                uRingDark: { value: v3(r.colourDark) }
            },
            side: THREE.DoubleSide,
            transparent: true,
            premultipliedAlpha: true,
            depthWrite: false,
            toneMapped: false
        });
        ring = new THREE.Mesh(ringGeometry, ringMaterial);
        tilt.add(ring);
    }

    // Camera-dependent uniforms are set as each part is about to draw: that way they use the camera actually
    // rendering, whichever one the caller draws its system scene with.
    const camLocal = new THREE.Vector3();
    const invTilt = new THREE.Matrix4();
    let renderer = opts.renderer || null;
    let pixelDiameter = 0;
    function syncCamera(glRenderer, camera) {
        renderer = glRenderer;
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
    let baked = null;      // { surface, extras, size } when ready
    let bakeJob = null;    // { surface, extras, size, step } while in progress

    function startBake(size) {
        const params = {
            generateMipmaps: true,
            minFilter: THREE.LinearMipmapLinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: false
        };
        bakeJob = {
            surface: new THREE.WebGLCubeRenderTarget(size, { ...params, type: THREE.HalfFloatType }),
            extras: new THREE.WebGLCubeRenderTarget(size, { ...params, type: THREE.UnsignedByteType }),
            size,
            step: 0
        };
    }

    function runBakeStep(glRenderer, quality) {
        const frameNo = glRenderer.info.render.frame;
        if (frameNo !== bakeFrame) {
            bakeFrame = frameNo;
            bakesThisFrame = 0;
        }
        if (bakesThisFrame >= BAKE_FACES_PER_FRAME) return;
        bakesThisFrame++;
        if (!bakeMaterial) {
            bakeMaterial = new THREE.ShaderMaterial({
                vertexShader: BAKE_VERTEX,
                fragmentShader: bakeFragment(look.model),
                uniforms: {
                    ...pattern,
                    uSun: shared.uSun,
                    uFace: { value: FACES[0] },
                    uLayer: { value: 0 },
                    uBakePx: { value: 0.01 }
                },
                depthTest: false,
                depthWrite: false,
                toneMapped: false
            });
        }
        const layer = bakeJob.step < 6 ? 0 : 1;
        const face = bakeJob.step % 6;
        const target = layer === 0 ? bakeJob.surface : bakeJob.extras;
        const previous = glRenderer.getRenderTarget();
        const previousFace = glRenderer.getActiveCubeFace();
        const previousMip = glRenderer.getActiveMipmapLevel();
        const savedOct = pattern.uOct.value;
        pattern.uOct.value = QUALITY[quality].bakeOct;
        bakeMaterial.uniforms.uFace.value = FACES[face];
        bakeMaterial.uniforms.uLayer.value = layer;
        bakeMaterial.uniforms.uBakePx.value = 2.2 / bakeJob.size;
        bakeMesh.material = bakeMaterial;
        glRenderer.setRenderTarget(target, face);
        glRenderer.render(bakeScene, bakeCamera);
        glRenderer.setRenderTarget(previous, previousFace, previousMip);
        pattern.uOct.value = savedOct;
        bakeJob.step++;
        if (bakeJob.step >= 12) finishBake();
    }

    function finishBake() {
        if (baked) {
            baked.surface.dispose();
            baked.extras.dispose();
        }
        baked = bakeJob;
        bakeJob = null;
        if (!bakedMaterial) {
            bakedMaterial = new THREE.ShaderMaterial({
                ...blendedBody,
                fragmentShader: BAKED_BODY_FRAGMENT,
                uniforms: {
                    ...shading,
                    tSurface: { value: baked.surface.texture },
                    tExtras: { value: baked.extras.texture },
                    uBakeTexel: { value: 2 / baked.size },
                    uCloudAlt: { value: look.clouds.altitude },
                    uCloudOpacity: { value: look.clouds.opacity }
                }
            });
        } else {
            bakedMaterial.uniforms.tSurface.value = baked.surface.texture;
            bakedMaterial.uniforms.tExtras.value = baked.extras.texture;
            bakedMaterial.uniforms.uBakeTexel.value = 2 / baked.size;
        }
    }

    function bakeSizeFor(px, quality) {
        if (px < 96) return 128;
        if (px < 300 || quality !== 'low') return 256;
        return 512;
    }

    // --- Time ---
    let clock = 0;
    let useBaked = false;

    function update(frame, sunDirWorld) {
        const quality = opts.quality || (frame && frame.quality) || 'medium';
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
        }
        if (frame && frame.camera && !renderer) {
            camLocal.setFromMatrixPosition(frame.camera.matrixWorld).applyMatrix4(invTilt);
            shared.uCam.value.copy(camLocal);
        }

        pattern.uOct.value = q.oct;
        shared.uAtmSteps.value = q.steps;
        if (shell) shell.visible = q.shell;

        // Live or baked, with a margin so that it does not flip back and forth at the threshold
        const px = pixelDiameter;
        const margin = useBaked ? 1.2 : 0.85;
        const wantBaked = px > 0 && px < q.liveAbovePx * margin;

        if (renderer && wantBaked) {
            const size = bakeSizeFor(px, quality);
            const have = bakeJob ? bakeJob.size : baked ? baked.size : 0;
            if (have < size) {
                if (bakeJob) {
                    bakeJob.surface.dispose();
                    bakeJob.extras.dispose();
                }
                startBake(size);
            }
        }
        if (renderer && bakeJob) runBakeStep(renderer, quality);

        useBaked = wantBaked && !!baked;
        if (!bakeJob && !useBaked && !isSolid) pattern.uJetT.value = clock * look.spinRate * look.envelope.jetSpeed * 0.12;
        if (isSolid && !bakeJob && !useBaked) pattern.uFlow.value = clock * 0.03;

        // Storms ride their jet
        if (!isSolid) {
            look.storms.slice(0, 6).forEach((storm, i) => {
                const lat = storm.lat;
                const jet = jetIndex(lat, look.envelope.bandCount, look.seedPhase);
                const lon = storm.lon + pattern.uJetT.value * -jetRate(jet, look.seedPhase);
                const cosLat = Math.cos(lat * Math.PI / 2);
                pattern.uStormA.value[i].x = cosLat * Math.cos(lon);
                pattern.uStormA.value[i].y = Math.sin(lat * Math.PI / 2);
                pattern.uStormA.value[i].z = cosLat * Math.sin(lon);
            });
        } else {
            look.storms.slice(0, 6).forEach((storm, i) => {
                const cosLat = Math.cos(storm.lat * Math.PI / 2);
                pattern.uStormA.value[i].x = cosLat * Math.cos(storm.lon);
                pattern.uStormA.value[i].y = Math.sin(storm.lat * Math.PI / 2);
                pattern.uStormA.value[i].z = cosLat * Math.sin(storm.lon);
            });
        }

        body.material = useBaked ? bakedMaterial : liveMaterial;
    }

    function setOpacity(value) {
        shared.uOpacity.value = Math.max(0, Math.min(1, value));
    }

    function dispose() {
        liveMaterial.dispose();
        if (bakedMaterial) bakedMaterial.dispose();
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

    return { object3d, update, dispose, setOpacity, look };
}
