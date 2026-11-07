// Distant galaxies. Every galaxy is baked once into a tile of a shared atlas, nearest first, so the whole sky costs
// one draw call. A galaxy that grows beyond its tile is baked again at the size it fills, into one of a few larger
// textures, and that picture fades in over the tile. See galaxy_bake.js for how the picture itself is made.
//
// Sky rule: the fainter a galaxy is, the dimmer it starts, and it comes up as the limiting magnitude falls with
// zoom. The rule is softer than the one for stars, since a galaxy is a small jewel in the wide sky, not a point.

import * as THREE from 'three';
import { bus } from '../../core/state.js';
import { skyMaterial, BAND_GLSL, ORDER, sharedUniforms } from '../shared.js';
import { limitingMag } from '../../core/sky.js';
import { IMAGE_R, BAKE_SCALE, FALL_GLSL, galaxyRecipe, createGalaxyBaker, createBakeTarget } from './galaxy_bake.js';
import { SKY_RADIUS, tangentBasis, quadAxes, worldHalfSize, scatterPicks, revealGain, REVEAL_GLSL } from './sky_tangent.js';
import { createRadioLobes } from './radio_lobes.js';

const RAD = Math.PI / 180;
const TILE = 128;                  // Pixels per galaxy in the atlas
const HERO_SLOTS = 2;              // At most this many galaxies have their own large picture at once
const HERO_CAP = { low: 640, medium: 1280, high: 2048 };
const HERO_LINGER_S = 15;          // Keep a large picture this long after it goes out of use, in case of a return

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
    attribute float aMag;
    attribute float aFade;
    varying vec2 vUv;
    varying vec2 vQ;
    varying vec4 vBand;
    varying float vXray;
    varying float vJewel;
    void main() {
        vec3 world = aCentre + position.x * aU + position.y * aV;
        vQ = position.xy;
        vUv = aRect.xy + (position.xy * 0.5 + 0.5) * aRect.zw;
        float gain = revealGain(aMag);
        vBand = vec4(aBandA.x, aBandA.y, aBandA.z * gain, aBandA.w) * aFade;
        vXray = aBandB * aFade;
        // Size on screen, in device pixels: the smaller it is, the harder it has to work to read as more than a blob
        float px = length(aU) / ${SKY_RADIUS.toFixed(1)} * uPxPerRad * 2.0;
        vJewel = fall(46.0, 10.0, px);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
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
        gl_FragColor = vec4(colour * edge * uSkyFade, 1.0);
    }`;

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
    add('aMag', 1);
    add('aFade', 1);
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
    geometry.attributes.aMag.array[i] = g.mag;
    ['aCentre', 'aU', 'aV', 'aRect', 'aBandA', 'aBandB', 'aMag'].forEach((name) => { geometry.attributes[name].needsUpdate = true; });
}

export function createGalaxiesLayer(engine, app) {
    const { renderer, scene } = engine;
    const bodies = app.universe.bodies.filter((b) => b.kind === 'galaxy');
    const n = bodies.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const rows = Math.max(1, Math.ceil(n / cols));
    const atlas = createBakeTarget(cols * TILE, rows * TILE);
    const baker = createGalaxyBaker(renderer);

    const galaxies = bodies.map((body, i) => {
        const basis = tangentBasis(body.sky.az, body.sky.alt);
        const halfDeg = (body.galaxy.size_deg * IMAGE_R) / 2;
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
            mag: body.brightness.mag,
            bandA: [body.bands.radio, body.bands.ir, body.bands.visible, body.bands.uv],
            bandB: body.bands.xray,
            recipe: galaxyRecipe(body),
            tileX: (i % cols) * TILE,
            tileY: Math.floor(i / cols) * TILE,
            baked: false,
            tileFade: 0,
            hero: null
        };
    });

    // The atlas mesh
    const atlasGeometry = quadGeometry(n);
    galaxies.forEach((g, i) => {
        writeInstance(atlasGeometry, i, g, [(g.tileX + 0.5) / atlas.width, (g.tileY + 0.5) / atlas.height, (TILE - 1) / atlas.width, (TILE - 1) / atlas.height]);
    });
    const atlasMaterial = skyMaterial({
        uniforms: { tA: { value: atlas.textures[0] }, tB: { value: atlas.textures[1] } },
        vertexShader: VERT,
        fragmentShader: FRAG
    });
    const atlasMesh = new THREE.Mesh(atlasGeometry, atlasMaterial);
    atlasMesh.frustumCulled = false;
    atlasMesh.renderOrder = ORDER.galaxies;
    scene.add(atlasMesh);

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
        heroes.push({ geometry, material, mesh, galaxy: null, target: null, res: 0, wantRes: 0, fade: 0, lastWanted: 0, wanted: false, baking: false });
    }

    // Nuclei: a crisp point at each centre. In visible it's a pinprick that keeps a tiny galaxy from being a blob;
    // in X-rays it is all you see of an active nucleus.
    const nucleusPositions = new Float32Array(n * 3);
    const nucleusBandA = new Float32Array(n * 4);
    const nucleusBandB = new Float32Array(n);
    const nucleusMag = new Float32Array(n);
    const nucleusColour = new Float32Array(n * 3);
    galaxies.forEach((g, i) => {
        const { body } = g;
        const active = !!body.galaxy.active_nucleus;
        const lobed = !!body.galaxy.radio_lobes;
        nucleusPositions.set(g.centre, i * 3);
        nucleusBandA.set([
            lobed ? body.bands.radio : 0,
            (g.recipe.starburst ? 0.5 : 0.15) * body.bands.ir,
            body.bands.visible,
            active ? 0.6 * body.bands.uv : 0
        ], i * 4);
        nucleusBandB[i] = active ? Math.max(0.5, body.bands.xray) : 0;
        nucleusMag[i] = g.mag;
        nucleusColour.set(g.recipe.kind === 2 ? [0.75, 0.85, 1] : [1, 0.82, 0.58], i * 3);
    });
    const nucleusGeometry = new THREE.BufferGeometry();
    nucleusGeometry.setAttribute('position', new THREE.BufferAttribute(nucleusPositions, 3));
    nucleusGeometry.setAttribute('aBandA', new THREE.BufferAttribute(nucleusBandA, 4));
    nucleusGeometry.setAttribute('aBandB', new THREE.BufferAttribute(nucleusBandB, 1));
    nucleusGeometry.setAttribute('aMag', new THREE.BufferAttribute(nucleusMag, 1));
    nucleusGeometry.setAttribute('aColour', new THREE.BufferAttribute(nucleusColour, 3));
    const nucleusMaterial = skyMaterial({
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            ${FALL_GLSL}
            ${REVEAL_GLSL}
            attribute vec4 aBandA;
            attribute float aBandB;
            attribute float aMag;
            attribute vec3 aColour;
            varying vec3 vColour;
            void main() {
                float gain = revealGain(aMag);
                // A pinprick in visible only while the galaxy is too small to show its own nucleus
                float small = fall(4000.0, 1500.0, uPxPerRad);
                vec3 c = aColour * aBandA.z * gain * uBandW[2] * 0.9 * small
                    + uBandTint[0] * uBandW[0] * aBandA.x * 2.0
                    + uBandTint[1] * uBandW[1] * aBandA.y * 1.2
                    + uBandTint[3] * uBandW[3] * aBandA.w * 1.6
                    + uBandTint[4] * uBandW[4] * aBandB * 7.0;
                vColour = c;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
        strength: Math.max(0.35, g.body.bands.radio),
        seed: g.body.visual_seed
    }));
    const lobes = createRadioLobes(engine, lobeSources);

    // One bake runs at a time. Atlas tiles come first, nearest the view first; then large pictures on request.
    let job = null;
    let jobDone = null;
    let stillFor = 0;
    let lastFov = -1;
    const forward = new THREE.Vector3();

    function startJob(generator, onDone) {
        job = generator;
        jobDone = onDone;
    }

    function angularDot(g) {
        return g.unit[0] * forward.x + g.unit[1] * forward.y + g.unit[2] * forward.z;
    }

    function nextTile() {
        let best = null;
        let bestDot = -2;
        for (let i = 0; i < n; i++) {
            const g = galaxies[i];
            if (g.baked) continue;
            const d = angularDot(g);
            if (d > bestDot) {
                bestDot = d;
                best = g;
            }
        }
        return best;
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
            if (h.wanted || h.baking) continue;
            if (!h.galaxy) return h;
            if (!best || h.lastWanted < best.lastWanted) best = h;
        }
        return best;
    }

    function chooseHeroes(frame) {
        const pxPerDeg = frame.pxPerRad * RAD;
        const halfView = Math.hypot(frame.fov, (frame.fov * frame.width) / frame.height) * 0.5;
        const cap = HERO_CAP[frame.quality] || HERO_CAP.medium;
        for (let i = 0; i < HERO_SLOTS; i++) heroes[i].wanted = false;
        // The biggest galaxies on screen, in order; there are only ever a couple
        for (let rank = 0; rank < HERO_SLOTS; rank++) {
            let best = null;
            let bestPx = TILE * 1.25;
            for (let i = 0; i < n; i++) {
                const g = galaxies[i];
                if (!g.baked || (g.hero && g.hero.wanted)) continue;
                const px = g.halfDeg * 2 * pxPerDeg;
                if (px <= bestPx) continue;
                const off = Math.acos(Math.max(-1, Math.min(1, angularDot(g)))) / RAD;
                if (off > halfView + g.halfDeg) continue;
                best = g;
                bestPx = px;
            }
            if (!best) break;
            const hero = slotFor(best);
            if (!hero) break;
            if (hero.galaxy !== best) assignHero(hero, best);
            hero.wanted = true;
            hero.lastWanted = frame.t;
            hero.wantRes = Math.min(cap, 2 ** Math.ceil(Math.log2(bestPx * 0.85)));
        }
    }

    function stepJob() {
        const result = job.next();
        if (result.done) {
            const done = jobDone;
            job = null;
            jobDone = null;
            if (done) done();
        }
    }

    function pickWork(frame) {
        const tile = nextTile();
        if (tile) {
            const rect = { x: tile.tileX, y: tile.tileY, w: TILE, h: TILE };
            startJob(baker.bake(tile.recipe, atlas, rect, TILE, frame.quality), () => { tile.baked = true; });
            return;
        }
        if (baker.scratchIsLarge()) baker.releaseScratch();
        if (stillFor < 0.12) return;
        for (let i = 0; i < HERO_SLOTS; i++) {
            const h = heroes[i];
            const cap = HERO_CAP[frame.quality] || HERO_CAP.medium;
            if (h.wanted && (h.wantRes > h.res || h.res > cap)) {
                startHeroBake(h, h.wantRes, frame);
                return;
            }
        }
    }

    const layer = {
        id: 'galaxies',
        update(frame) {
            const dt = frame.dt || 0;
            frame.camera.getWorldDirection(forward);
            if (Math.abs(frame.fov - lastFov) > frame.fov * 0.001) stillFor = 0;
            else stillFor += Math.max(dt, 0.008);
            lastFov = frame.fov;

            if (app.view === 'sky') {
                chooseHeroes(frame);
                if (!job) pickWork(frame);
                if (job) stepJob();
            }

            // Fades add up to one, since drawing is additive: first a baked tile comes in, then a large picture takes over
            for (let i = 0; i < HERO_SLOTS; i++) {
                const h = heroes[i];
                if (!h.galaxy) continue;
                const target = h.wanted && h.target ? 1 : 0;
                if (h.fade !== target) {
                    h.fade = target > h.fade ? Math.min(1, h.fade + dt / 0.35) : Math.max(0, h.fade - dt / 0.25);
                    h.geometry.attributes.aFade.array[0] = h.fade;
                    h.geometry.attributes.aFade.needsUpdate = true;
                }
                if (!h.wanted && !h.baking && h.fade <= 0 && frame.t - h.lastWanted > HERO_LINGER_S) releaseHero(h);
            }
            const fades = atlasGeometry.attributes.aFade;
            let dirty = false;
            for (let i = 0; i < n; i++) {
                const g = galaxies[i];
                if (g.baked && g.tileFade < 1) g.tileFade = Math.min(1, g.tileFade + dt / 0.4);
                const value = g.tileFade * (g.hero ? 1 - g.hero.fade : 1);
                if (fades.array[i] !== value) {
                    fades.array[i] = value;
                    dirty = true;
                }
            }
            if (dirty) fades.needsUpdate = true;
        },

        picks(frame) {
            const out = [];
            const pxPerDeg = (frame.pxPerRad * RAD) / frame.dpr;
            const lim = limitingMag(frame.fov);
            const stepDeg = 30 / pxPerDeg;
            for (let i = 0; i < n; i++) {
                const g = galaxies[i];
                const { body } = g;
                if ((body.bands[app.band] || 0) <= 0.01) continue;
                if (app.band === 'visible' && revealGain(g.mag, lim) < 0.03) continue;
                const major = body.galaxy.size_deg / 2;
                if (major * pxPerDeg < 14) {
                    out.push({ code: body.code, az: body.sky.az, alt: body.sky.alt, radiusPx: 0 });
                    continue;
                }
                const flat = g.recipe.kind === 1 ? 0.85 : Math.max(0.22, Math.cos(g.recipe.incl));
                scatterPicks(out, body.code, g.basis, body.galaxy.position_angle_deg, major, major * flat, stepDeg);
            }
            if (app.band === 'radio') {
                // A click on a lobe finds its galaxy
                lobeSources.forEach((src, i) => {
                    scatterPicks(out, lobed[i].body.code, lobed[i].basis, src.positionAngleDeg, src.spanDeg / 2, src.spanDeg * 0.1, stepDeg);
                });
            }
            return out;
        },

        // For tests: is everything that's wanted baked?
        idle() {
            return !job && galaxies.every((g) => g.baked) && heroes.every((h) => !h.wanted || h.wantRes <= h.res);
        },

        dispose() {
            heroes.forEach((h) => {
                releaseHero(h);
                scene.remove(h.mesh);
                h.geometry.dispose();
                h.material.dispose();
            });
            scene.remove(atlasMesh);
            scene.remove(nuclei);
            atlasGeometry.dispose();
            atlasMaterial.dispose();
            nucleusGeometry.dispose();
            nucleusMaterial.dispose();
            atlas.dispose();
            baker.dispose();
            lobes.dispose();
        }
    };

    return layer;
}
