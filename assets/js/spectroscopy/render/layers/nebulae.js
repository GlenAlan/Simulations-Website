// Nebulae of every type: emission clouds, planetary nebulae, dark clouds and reflection nebulae.
//
// Each one is a raymarched volume baked into a texture (nebula_bake.js), drawn as a sprite fixed to the sky. All
// the sprites go in one instanced draw, and the stars inside them in one point draw. The sprite keeps the gas
// zones and the dust apart, so one image can show every band: the same cloud is rebuilt from its hydrogen, oxygen
// and dust channels with the band weights, which also makes the band cross-fade come out right by itself.
//
// Blending is "premultiplied over": a sprite adds its light and dims what is behind it by its dust opacity. So one
// blend does for all four types, and a dark cloud (all opacity, almost no light) blots out the stars and the
// Milky Way drawn before it. Dark clouds are drawn first so that glowing gas is never blacked out by one.

import * as THREE from 'three';
import { azAltToVec3 } from '../../core/sky.js';
import { Rng, hashString } from '../../core/rng.js';
import { blackBodyRGB } from '../../core/phys.js';
import { drawMag, parallaxFactor } from '../../core/depth.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { getBaker, SPRITE_FETCH_GLSL, SPRITE_ID_GLSL, zonePalette } from './nebula_bake.js';

const SKY_RADIUS = 1000;
const SPRITE_MARGIN = 1.38;   // The gas fills about two thirds of the sprite, with wisps fading out before its edge
const DRAW_ORDER = { dark: 0, reflection: 1, emission: 2, planetary: 3 };

const RAD = Math.PI / 180;

function tangentFrame(az, alt) {
    const c = azAltToVec3(az, alt);
    // East and north at this point on the sky, seen from inside the sphere. Fixed to the sky, so a nebula never
    // turns against the stars around it as the camera moves.
    let rx = -c[2];
    let rz = c[0];
    const len = Math.hypot(rx, rz);
    if (len < 1e-4) {
        rx = 1;
        rz = 0;
    } else {
        rx /= len;
        rz /= len;
    }
    const r = [rx, 0, rz];
    const n = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]];
    return { c, r, n };
}

function randomRotation(rng) {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rng.range(0, 6.283), rng.range(0, 6.283), rng.range(0, 6.283)));
    return new THREE.Matrix3().setFromMatrix4(m);
}

function randomUnit(rng) {
    const z = rng.range(-1, 1);
    const a = rng.range(0, Math.PI * 2);
    const s = Math.sqrt(1 - z * z);
    return [s * Math.cos(a), s * Math.sin(a), z];
}

// Everything the seed decides about a cloud's shape. The lines decide its colours and its [O III] zone
function cloudShape(body, palette) {
    const rng = new Rng(hashString(`${body.visual_seed}:cloud`));
    const type = body.nebula.type;
    const blobs = [];
    const lumps = rng.int(4, 6);
    const stretch = [rng.range(0.7, 1.15), rng.range(0.55, 1.0), rng.range(0.7, 1.1)];
    for (let i = 0; i < 6; i++) {
        if (i < lumps) {
            const dir = randomUnit(rng);
            const r = rng.range(0.12, 0.70);
            blobs.push(new THREE.Vector4(dir[0] * r * stretch[0], dir[1] * r * stretch[1], dir[2] * r * stretch[2], rng.range(0.22, 0.46)));
        } else {
            blobs.push(new THREE.Vector4(5, 5, 5, 0.01));
        }
    }
    // The hotter the central star, the more of the gas it ionises
    const central = body.nebula.central_star;
    const heat = central ? Math.max(0, Math.min(1, (central.teff_K - 10000) / 30000)) : 0.5;
    const ionisingPower = 0.45 + 0.55 * heat;
    const dustiness = body.nebula.dust ?? 0.5;
    const stars = [];
    const count = type === 'emission' ? rng.int(1, 3) : type === 'reflection' ? rng.int(1, 2) : 0;
    for (let i = 0; i < 4; i++) {
        if (i < count) {
            const home = blobs[rng.int(0, lumps - 1)];
            const spread = i === 0 ? 0.16 : 0.3;
            const dir = randomUnit(rng);
            stars.push(new THREE.Vector4(
                home.x * 0.6 + dir[0] * spread,
                home.y * 0.6 + dir[1] * spread,
                home.z * 0.6 + dir[2] * spread,
                i === 0 ? ionisingPower : rng.range(0.12, 0.45)
            ));
        } else {
            stars.push(new THREE.Vector4(9, 9, 9, 0));
        }
    }
    const n0 = randomUnit(rng);
    const n1 = randomUnit(rng);
    const lanes = [
        new THREE.Vector4(n0[0], n0[1], n0[2] * 0.4, rng.range(-0.3, 0.3)),
        new THREE.Vector4(n1[0], n1[1], n1[2] * 0.4, rng.range(-0.5, 0.5))
    ];
    const off = new THREE.Vector3(rng.next(), rng.next(), rng.next());
    const rot = randomRotation(rng);
    const params = { blobs, stars, lanes, off, rot };
    if (type === 'emission') {
        params.A = new THREE.Vector4(rng.range(0.16, 0.34), rng.range(-0.08, 0.12), 0.35 + dustiness * 1.45, 8.5);
        params.B = new THREE.Vector4(rng.chance(0.45) ? rng.range(0.14, 0.34) : 0, (0.035 + palette.excitation * 0.09) * rng.range(0.6, 1.6), rng.range(2, 4), 0);
        params.C = new THREE.Vector4(1.5, 1.5, 1.3, rng.range(0.07, 0.13));
    } else if (type === 'reflection') {
        params.A = new THREE.Vector4(rng.range(0.18, 0.36), rng.range(-0.02, 0.14), dustiness * 0.75, 2.0);
        params.B = new THREE.Vector4(0, 1, rng.range(0.8, 1.6), 1);
        params.C = new THREE.Vector4(1.6, 1.6, 1.1, 0.1);
    } else {
        params.A = new THREE.Vector4(rng.range(0.2, 0.38), rng.range(0.0, 0.14), 0.3 + dustiness * 1.3, 8.0);
        params.B = new THREE.Vector4(0, 1, 0, 2);
        params.C = new THREE.Vector4(1.0, 1.0, 0.22, 0.12);
    }
    return { program: 'cloud', params };
}

function planetaryShape(body, palette) {
    const rng = new Rng(hashString(`${body.visual_seed}:shell`));
    // Tilt and turn: the object's axis is what the shape is built around
    const tilt = rng.range(0.25, 1.3);
    const turn = rng.range(0, 6.283);
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(tilt, 0, turn, 'XYZ'));
    const rot = new THREE.Matrix3().setFromMatrix4(m);
    const shape = rng.weighted([[0, 3], [1, 3], [2, 3], [3, 1]]);
    const size = shape === 1 ? rng.range(0.62, 0.74) : rng.range(0.50, 0.62);
    const params = {
        rot,
        off: new THREE.Vector3(rng.next(), rng.next(), rng.next()),
        P: new THREE.Vector4(shape, size, rng.range(0.45, 0.95), rng.range(0.78, 1.0)),
        C: new THREE.Vector4(1.7, 1.7, 0.8 + (body.nebula.dust ?? 0.1) * 6, Math.min(0.5, 0.1 * palette.excitation))
    };
    return { program: 'planetary', params };
}

function setCloudUniforms(u, params) {
    u.uBlob.value = params.blobs;
    u.uStar.value = params.stars;
    u.uLane.value = params.lanes;
    u.uOff.value = params.off;
    u.uRot.value = params.rot;
    u.uA.value = params.A;
    u.uB.value = params.B;
    u.uC.value = params.C;
}

function setPlanetaryUniforms(u, params) {
    u.uOff.value = params.off;
    u.uRot.value = params.rot;
    u.uP.value = params.P;
    u.uC.value = params.C;
}

// The sprite's colours in visible light, from the lines
function spriteColours(body, palette) {
    const type = body.nebula.type;
    if (type === 'reflection') {
        // Scattered light from a hot star, bluer than the star because dust scatters blue best
        const star = blackBodyRGB(body.nebula.central_star ? body.nebula.central_star.teff_K : 16000);
        const blue = [star[0] * 0.30, star[1] * 0.55, star[2] * 1.15];
        const pale = [star[0] * 0.55, star[1] * 0.72, star[2] * 1.05];
        return { a: blue, b: pale };
    }
    if (type === 'dark') {
        // No lines of its own: only a little reddened starlight along its thin edges
        return { a: [0.17, 0.115, 0.085], b: [0.10, 0.08, 0.07] };
    }
    return { a: palette.hydrogen, b: palette.oxygen };
}

// Stars inside the nebula. They sit where the bake put the gas, are hidden by its dust in visible light (the
// shader reads the dust from the atlas), and show up in the infrared and ultraviolet as a real cluster would
function embeddedStars(body, shape, frame, half, rect, out) {
    const rng = new Rng(hashString(`${body.visual_seed}:stars`));
    const type = body.nebula.type;
    const add = (x, y, z, teff, size, v, ir, uv, xr, fadeLo, fadeHi) => {
        const wx = frame.c[0] + (frame.r[0] * x + frame.n[0] * y) * half;
        const wy = frame.c[1] + (frame.r[1] * x + frame.n[1] * y) * half;
        const wz = frame.c[2] + (frame.r[2] * x + frame.n[2] * y) * half;
        const col = blackBodyRGB(teff);
        out.push({
            pos: [wx * SKY_RADIUS, wy * SKY_RADIUS, wz * SKY_RADIUS],
            col,
            size,
            bands: [v, ir, uv, xr],
            fade: [fadeLo, fadeHi, half],
            cell: [rect[0] + (x * 0.5 + 0.5) * rect[2], rect[1] + (y * 0.5 + 0.5) * rect[3]],
            strength: body.bands,
            depth: body.depth
        });
    };
    if (type === 'planetary') {
        // The central white dwarf: tiny and very hot, so stronger in the ultraviolet than in visible light
        const teff = body.nebula.central_star ? body.nebula.central_star.teff_K : rng.range(60000, 120000);
        add(0, 0, 0, Math.min(teff, 40000), 2.4, 1.1, 0.05, 8.0, 2.0, 14, 50);
        return;
    }
    const lit = shape.params.stars.filter((s) => s.w > 0);
    lit.forEach((s, i) => {
        const known = i === 0 && body.nebula.central_star;
        add(s.x, s.y, s.z, known ? known.teff_K : type === 'reflection' ? rng.range(12000, 22000) : rng.range(26000, 42000),
            i === 0 ? 3.6 : 2.8, i === 0 ? 1.5 : 1.0, 0.45, 9.0, 1.5, 22, 90);
    });
    const r2 = (body.nebula.star_forming ? 0.72 : 0.6) ** 2;
    const young = body.nebula.star_forming ? rng.int(26, 48) : type === 'reflection' ? rng.int(6, 12) : rng.int(5, 12);
    for (let i = 0; i < young; i++) {
        let x;
        let y;
        do {
            x = rng.range(-1, 1);
            y = rng.range(-1, 1);
        } while (x * x + y * y > r2);
        const massive = rng.next() ** 3;
        const teff = 3000 + massive * 12000;
        const vis = type === 'dark' ? 0.02 : 0.2 + massive * 0.7;
        add(x, y, 0, teff, 1.3 + massive * 1.3, vis, 0.55 + (1 - massive) * 0.65, massive * 0.7, 0.2 + rng.next() * 0.35, 100, 340);
    }
}

export function createNebulaeLayer(engine, app) {
    const baker = getBaker(engine, app);
    const bodies = app.universe.bodies
        .filter((b) => b.kind === 'nebula')
        .sort((a, b) => DRAW_ORDER[a.nebula.type] - DRAW_ORDER[b.nebula.type]);
    const n = bodies.length;

    const stride = (size) => new Float32Array(n * size);
    const aCentre = stride(3);
    const aR = stride(3);
    const aN = stride(3);
    const aPack = stride(4); // Half-size, job id, magnitude, kind: packed, as a program can only have so many attributes
    const aRect = stride(4);
    const aColA = stride(3);
    const aColB = stride(3);
    const aBandA = stride(4);
    const aBandB = stride(1);
    const aReady = stride(1);
    const aDepth = stride(1);

    const items = [];
    const starList = [];
    bodies.forEach((body, i) => {
        const frame = tangentFrame(body.sky.az, body.sky.alt);
        const palette = zonePalette(body.nebula.emission_lines);
        const type = body.nebula.type;
        const shape = type === 'planetary' ? planetaryShape(body, palette) : cloudShape(body, palette);
        const set = type === 'planetary'
            ? (u) => setPlanetaryUniforms(u, shape.params)
            : (u) => setCloudUniforms(u, shape.params);
        const job = baker.addJob({
            program: shape.program,
            dir: frame.c,
            set,
            onReset() { items[i].shown = 0; aReady[i] = 0; readyAttr.needsUpdate = true; }
        });
        const tanHalf = Math.tan((body.nebula.size_deg * 0.5 * SPRITE_MARGIN) * RAD);
        const colours = spriteColours(body, palette);
        aCentre.set(frame.c, i * 3);
        aR.set(frame.r, i * 3);
        aN.set(frame.n, i * 3);
        // A dark cloud shows by what it hides, at any zoom
        aPack.set([tanHalf, job.id, type === 'dark' ? -99 : drawMag(body), type === 'reflection' ? 1 : type === 'dark' ? 2 : 0], i * 4);
        aRect.set(job.rect, i * 4);
        aColA.set(colours.a, i * 3);
        aColB.set(colours.b, i * 3);
        aBandA.set([body.bands.radio, body.bands.ir, body.bands.visible, body.bands.uv], i * 4);
        aBandB[i] = body.bands.xray;
        aDepth[i] = body.depth;
        items.push({ body, job, frame, tanHalf, shown: 0 });
        embeddedStars(body, shape, frame, tanHalf, job.rect, starList);
    });

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const inst = (name, array, size) => geometry.setAttribute(name, new THREE.InstancedBufferAttribute(array, size));
    inst('aCentre', aCentre, 3);
    inst('aR', aR, 3);
    inst('aN', aN, 3);
    inst('aPack', aPack, 4);
    inst('aRect', aRect, 4);
    inst('aColA', aColA, 3);
    inst('aColB', aColB, 3);
    inst('aBandA', aBandA, 4);
    inst('aBandB', aBandB, 1);
    inst('aDepth', aDepth, 1);
    const readyAttr = new THREE.InstancedBufferAttribute(aReady, 1);
    readyAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aReady', readyAttr);
    geometry.instanceCount = n;

    const material = skyMaterial({
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
        uniforms: { tAtlas: baker.atlasUniform, ...baker.heroUniforms },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            ${SPRITE_ID_GLSL}
            attribute vec3 aCentre;
            attribute vec3 aR;
            attribute vec3 aN;
            attribute vec4 aPack;
            attribute vec4 aRect;
            attribute vec3 aColA;
            attribute vec3 aColB;
            attribute vec4 aBandA;
            attribute float aBandB;
            attribute float aReady;
            attribute float aDepth;
            varying vec2 vQ;
            varying vec2 vCell;
            varying vec3 vColA;
            varying vec3 vColB;
            varying vec4 vStrength;
            varying float vStrengthX;
            varying float vReady;
            varying float vKind;
            void main() {
                vQ = position.xy;
                vCell = aRect.xy + (position.xy * 0.5 + 0.5) * aRect.zw;
                vColA = aColA;
                vColB = aColB;
                vReady = aReady;
                vKind = aPack.w;
                SET_HERO(aPack.y)
                // Faint nebulae come up as you zoom in, gently, so they don't pop: surface brightness is unchanged by
                // zoom in reality, but the sky's limiting magnitude is how this sim reveals faint objects
                float over = clamp(pow(10.0, -0.4 * (aPack.z - uLimitMag)), 0.0, 1.0);
                vStrength = vec4(aBandA.x, aBandA.y, aBandA.z * pow(over, 0.4), aBandA.w);
                vStrengthX = aBandB;
                vec3 world = (aCentre + (aR * position.x + aN * position.y) * aPack.x) * ${SKY_RADIUS.toFixed(1)};
                gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
                gl_Position.xy *= depthP(aDepth);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            ${SPRITE_FETCH_GLSL}
            varying vec2 vQ;
            varying vec2 vCell;
            varying vec3 vColA;
            varying vec3 vColB;
            varying vec4 vStrength;
            varying float vStrengthX;
            varying float vReady;
            varying float vKind;

            // False colour from a band's tint, running to white where it is brightest
            vec3 ramp(vec3 tint, float v) {
                return tint * v + vec3(0.9) * v * v * 0.28;
            }

            void main() {
                float r2 = dot(vQ, vQ);
                if (r2 >= 1.0) discard;
                vec4 t = fetchBaked(vQ, vCell);
                float hyd = t.r * t.r;
                float oxy = t.g * t.g;
                float dust = t.b * t.b;
                float opacity = t.a;

                // Where oxygen dominates the eye sees teal, not teal plus the red of whatever lies in front of it
                float hydSeen = hyd * mix(1.0, 0.3, smoothstep(0.06, 0.42, oxy));
                vec3 col = (vColA * hydSeen + vColB * oxy) * 1.35 * vStrength.z * uBandW[2];

                // Radio and X-rays come from broad, smooth gas: a blurred version of the same channels
                float blendOthers = uBandW[0] + uBandW[4];
                if (blendOthers > 0.001) {
                    vec4 s = textureLod(tAtlas, vCell, 3.4);
                    float sh = s.r * s.r;
                    float so = s.g * s.g;
                    float sd = s.b * s.b;
                    float radio = (sh + so * 0.7) * 3.2 + sd * 0.5;
                    col += ramp(uBandTint[0], radio * vStrength.x) * uBandW[0];
                    float xr = (so * 1.1 + sh * 0.25) * 3.6;
                    col += ramp(uBandTint[4], xr * vStrengthX) * uBandW[4];
                }
                // Infrared: the dust that blocks visible light is what glows
                float ir = dust * 2.6 + hyd * 0.2;
                col += ramp(uBandTint[1], ir * vStrength.y) * uBandW[1];
                // Ultraviolet: the hot gas near the stars, heavily dimmed by dust. Reflection nebulae scatter it strongly
                float uvScatter = vKind > 0.5 && vKind < 1.5 ? 1.5 : 0.28;
                float uvLight = (oxy * 1.1 + hyd * uvScatter) * 2.4;
                col += ramp(uBandTint[3], uvLight * vStrength.w) * uBandW[3];

                // Dust blocks visible and ultraviolet light, but much less of the infrared, and almost no radio
                float blocks = uBandW[2] + uBandW[3] + uBandW[1] * 0.14 + uBandW[4] * 0.25;
                float alpha = opacity * blocks;

                // A soft stand-in until the bake arrives, then a quick fade across to it
                float stand = exp(-r2 * 3.5) * smoothstep(1.0, 0.6, sqrt(r2)) * 0.08;
                vec3 waiting = (vColA + vColB) * stand * vStrength.z * uBandW[2];
                col = mix(waiting, col, vReady);
                alpha *= vReady;

                // Tiny grain so faint gradients don't band on an 8-bit screen
                float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
                col *= 1.0 + (grain - 0.5) * 0.05;
                gl_FragColor = vec4(col * uSkyFade, alpha * uSkyFade);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.nebulae;
    engine.scene.add(mesh);

    // The stars inside the nebulae: one draw for all of them
    const starCount = starList.length;
    const sPos = new Float32Array(starCount * 3);
    const sCol = new Float32Array(starCount * 3);
    const sSize = new Float32Array(starCount);
    const sVis = new Float32Array(starCount * 4);
    const sFade = new Float32Array(starCount * 3);
    const sCell = new Float32Array(starCount * 2);
    const sStrength = new Float32Array(starCount * 4);
    const sDepth = new Float32Array(starCount);
    starList.forEach((s, i) => {
        sDepth[i] = s.depth;
        sPos.set(s.pos, i * 3);
        sCol.set(s.col, i * 3);
        sSize[i] = s.size;
        sVis.set(s.bands, i * 4);
        sFade.set(s.fade, i * 3);
        sCell.set(s.cell, i * 2);
        // A nebula with no strength in a band keeps its stars out of it too
        sStrength.set([s.strength.ir, s.strength.visible, s.strength.uv, s.strength.xray], i * 4);
    });
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    starGeometry.setAttribute('aColour', new THREE.BufferAttribute(sCol, 3));
    starGeometry.setAttribute('aSize', new THREE.BufferAttribute(sSize, 1));
    starGeometry.setAttribute('aVis', new THREE.BufferAttribute(sVis, 4));
    starGeometry.setAttribute('aFade', new THREE.BufferAttribute(sFade, 3));
    starGeometry.setAttribute('aCell', new THREE.BufferAttribute(sCell, 2));
    starGeometry.setAttribute('aStrength', new THREE.BufferAttribute(sStrength, 4));
    starGeometry.setAttribute('aDepth', new THREE.BufferAttribute(sDepth, 1));
    const starMaterial = skyMaterial({
        uniforms: { tAtlas: baker.atlasUniform },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            uniform sampler2D tAtlas;
            attribute vec3 aColour;
            attribute float aSize;
            attribute vec4 aVis;
            attribute vec3 aFade;
            attribute vec2 aCell;
            attribute vec4 aStrength;
            attribute float aDepth;
            varying vec3 vColour;
            varying float vGlow;
            void main() {
                // Stars only come out once the parent nebula is large enough on screen for them to read as stars
                float fade = smoothstep(aFade.x, aFade.y, aFade.z * 2.0 * uPxPerRad * depthP(aDepth));
                float opacity = textureLod(tAtlas, aCell, 1.0).a;
                float vis = aVis.x * aStrength.y * uBandW[2] * (1.0 - 0.93 * opacity);
                float ir = aVis.y * aStrength.x * uBandW[1];
                float uv = aVis.z * aStrength.z * uBandW[3] * (1.0 - 0.8 * opacity);
                float xr = aVis.w * aStrength.w * uBandW[4];
                vColour = aColour * mix(vec3(1.0), vec3(1.0, 0.62, 0.42), opacity) * vis
                    + uBandTint[1] * ir + uBandTint[3] * uv + uBandTint[4] * xr;
                vGlow = fade;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_Position.xy *= depthP(aDepth);
                float dprScale = clamp(uViewport.y / 900.0, 0.8, 2.0);
                gl_PointSize = (vis + ir + uv + xr) * fade > 0.01 ? (aSize * 1.5 + sqrt(vis + ir + uv + xr) * aSize) * dprScale : 0.0;
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            varying vec3 vColour;
            varying float vGlow;
            void main() {
                float r = length(gl_PointCoord - 0.5) * 2.0;
                float core = exp(-r * r * 9.0) * 2.2 + exp(-r * r * 3.0) * 0.35;
                float edge = smoothstep(1.0, 0.75, r);
                gl_FragColor = vec4(vColour * core * edge * vGlow * uSkyFade, 1.0);
            }`
    });
    const stars = new THREE.Points(starGeometry, starMaterial);
    stars.frustumCulled = false;
    stars.renderOrder = ORDER.nebulae + 0.5;
    engine.scene.add(stars);

    return {
        id: 'nebulae',
        update(frame) {
            baker.beginFrame(frame);
            let changed = false;
            const step = frame.dt > 0 ? frame.dt / 0.5 : 1;
            for (let i = 0; i < n; i++) {
                const item = items[i];
                if (item.job.ready && item.shown < 1) {
                    item.shown = frame.reduceMotion ? 1 : Math.min(1, item.shown + step);
                    aReady[i] = item.shown;
                    changed = true;
                }
                const f = item.frame;
                item.job.half = item.tanHalf;
                item.job.parallax = parallaxFactor(item.body.depth, frame.fov);
                baker.considerSprite(item.job, f.c, f.r, f.n);
            }
            if (changed) readyAttr.needsUpdate = true;
        },
        // A click anywhere on a nebula selects it, not only on its centre, once it shows in this band at this zoom
        picks(frame) {
            const out = [];
            for (let i = 0; i < n; i++) {
                const { body, tanHalf } = items[i];
                const strength = body.bands[frame.band] || 0;
                if (strength <= 0.01) continue;
                // Out to the furthest of its stars: see embeddedStars
                const radiusPx = (tanHalf * frame.pxPerRad * parallaxFactor(body.depth, frame.fov) * 0.74) / frame.dpr;
                out.push({ code: body.code, az: body.sky.az, alt: body.sky.alt, radiusPx, depth: body.depth });
            }
            return out;
        },
        baker,
        dispose() {
            engine.scene.remove(mesh);
            engine.scene.remove(stars);
            geometry.dispose();
            material.dispose();
            starGeometry.dispose();
            starMaterial.dispose();
            baker.dispose();
        }
    };
}
