// Nebulae of every type: emission clouds, planetary nebulae, dark clouds and reflection nebulae.
//
// Each one is baked into a texture (nebula_bake.js) and drawn as a sprite fixed to the sky. All the sprites go in two
// instanced draws, and the stars inside them in one point draw. The sprite keeps the gas zones and the dust apart, so
// one image can show every band: the same cloud is rebuilt from its hydrogen, oxygen and dust channels with the band
// weights, which also makes the band cross-fade come out right by itself.
//
// The first draw multiplies what is behind by the dust's transmission, red passing best, so dust really does dim and
// redden the Milky Way and any stars behind it. The second adds the light. All the dust goes before all the light, so
// glowing gas is never blacked out by a dark cloud that happens to overlap it.
//
// Forms vary by seed, and in more than a noise offset: each has its own arrangement of lumps, stars, lanes and walls.

import * as THREE from 'three';
import { azAltToVec3, vec3ToAzAlt } from '../../core/sky.js';
import { Rng, hashString } from '../../core/rng.js';
import { blackBodyRGB } from '../../core/phys.js';
import { drawMag, depthLight, parallaxFactor } from '../../core/depth.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { getBaker, SPRITE_FETCH_GLSL, SPRITE_ID_GLSL, zonePalette } from './nebula_bake.js';

const SKY_RADIUS = 1000;
// How much bigger the sprite is than the object. Gas and dust fade out so slowly that they need room to do it in, and
// the size in the data is the body of the thing, not the last of its glow.
const SPRITE_MARGIN = { emission: 1.62, dark: 1.62, reflection: 1.38, planetary: 1.38 };
const DRAW_ORDER = { dark: 0, reflection: 1, emission: 2, planetary: 3 };
const KIND_CODE = { emission: 0, reflection: 1, dark: 2, planetary: 3 };
// How much of the sprite answers a click: as far as any gas or dust shows clearly
const PICK_SHARE = { emission: 0.8, dark: 0.8, reflection: 0.74, planetary: 0.74 };

const RAD = Math.PI / 180;
const TAU = Math.PI * 2;

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

// Rotated, then squeezed along one axis, so that the turbulence runs in one direction across the object
function flowingRotation(rng, squeeze) {
    const rot = randomRotation(rng);
    const stretch = new THREE.Matrix3().set(1, 0, 0, 0, squeeze, 0, 0, 0, 1);
    return stretch.multiply(rot);
}

const farLump = () => new THREE.Vector4(5, 5, 5, 0.01);
const noStar = () => new THREE.Vector4(9, 9, 9, 0);
const noLane = () => new THREE.Vector4(0, 1, 9, 9);

function fill(list, count, make) {
    while (list.length < count) list.push(make());
    return list;
}

// A reflection nebula's shape, as the audit praised it: the lines play no part
function reflectionShape(body) {
    const rng = new Rng(hashString(`${body.visual_seed}:cloud`));
    const blobs = [];
    const lumps = rng.int(4, 6);
    const stretch = [rng.range(0.7, 1.15), rng.range(0.55, 1.0), rng.range(0.7, 1.1)];
    for (let i = 0; i < 6; i++) {
        if (i < lumps) {
            const dir = randomUnit(rng);
            const r = rng.range(0.12, 0.70);
            blobs.push(new THREE.Vector4(dir[0] * r * stretch[0], dir[1] * r * stretch[1], dir[2] * r * stretch[2], rng.range(0.22, 0.46)));
        } else {
            blobs.push(farLump());
        }
    }
    const central = body.nebula.central_star;
    const heat = central ? Math.max(0, Math.min(1, (central.teff_K - 10000) / 30000)) : 0.5;
    const ionisingPower = 0.45 + 0.55 * heat;
    const dustiness = body.nebula.dust ?? 0.5;
    const stars = [];
    const count = rng.int(1, 2);
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
            stars.push(noStar());
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
    params.A = new THREE.Vector4(rng.range(0.18, 0.36), rng.range(-0.02, 0.14), dustiness * 0.75, 2.0);
    params.B = new THREE.Vector4(0, 1, rng.range(0.8, 1.6), 1);
    params.C = new THREE.Vector4(1.6, 1.6, 1.1, 0.1);
    return { program: 'cloud', params };
}

// Emission nebulae come in several real forms. All sit within about 0.62 of the sprite's half-size, the size in the data:
//   blister   the stars have broken out of the side of a dark cloud, whose wall stands in columns facing them
//   bubble    the stars have blown a hole in the gas: a ring, thick on one side
//   lanes     long, with dark lanes crossing it near its heart
//   bay       a broad, faint cloud, with a bay of dust eating into it from one side
//   ribbon    a long thin curving strip of gas, finely combed along its length
function emissionShape(body, palette) {
    const rng = new Rng(hashString(`${body.visual_seed}:emission`));
    const form = rng.weighted([['blister', 3], ['bubble', 2], ['lanes', 3], ['bay', 2], ['ribbon', 2]]);
    const th = rng.range(0, TAU);
    const ax = [Math.cos(th), Math.sin(th)];
    const pe = [-ax[1], ax[0]];
    const at = (u, v, z, r) => new THREE.Vector4(ax[0] * u + pe[0] * v, ax[1] * u + pe[1] * v, z, r);
    const z = () => rng.range(-0.22, 0.22);

    const central = body.nebula.central_star;
    const heat = central ? Math.max(0, Math.min(1, (central.teff_K - 10000) / 30000)) : 0.5;
    const power = 0.45 + 0.55 * heat;
    const dustiness = body.nebula.dust ?? 0.5;

    const blobs = [];
    const stars = [];
    const lanes = [];
    let cavity = 0;
    const wall = new THREE.Vector4(0, 0, 0, 0);
    let squeeze = rng.range(0.74, 1);
    let laneWidth = rng.range(0.08, 0.14);
    let rimGain = rng.range(1.0, 2.0);
    let frontDepth = 0.55 + dustiness * 0.8;
    let gasGain = 1;    // A thin strip of gas has less of itself along the line of sight than a thick cloud has

    if (form === 'blister') {
        // The heart is off centre, away from the wall
        const hu = rng.range(0.10, 0.24);
        stars.push(at(hu, rng.range(-0.08, 0.08), 0.05, power));
        blobs.push(at(hu, 0, 0, rng.range(0.30, 0.38)));
        const lumps = rng.int(3, 5);
        for (let i = 0; i < lumps; i++) {
            const a = rng.range(-1.5, 1.5);
            const d = rng.range(0.14, 0.42);
            blobs.push(at(hu + Math.cos(a) * d, Math.sin(a) * d, z(), rng.range(0.16, 0.30)));
        }
        blobs.push(at(hu - rng.range(0.28, 0.42), rng.range(-0.25, 0.25), z(), rng.range(0.16, 0.24)));
        wall.set(-ax[0], -ax[1], rng.range(0.24, 0.40), 1);
    } else if (form === 'bubble') {
        cavity = rng.range(0.19, 0.31);
        stars.push(new THREE.Vector4(rng.range(-0.06, 0.06), rng.range(-0.06, 0.06), 0, power));
        const lumps = 7;
        const heavy = rng.range(0, TAU);
        for (let i = 0; i < lumps; i++) {
            const a = (i / lumps) * TAU + rng.range(-0.3, 0.3);
            const d = cavity + rng.range(0.14, 0.26);
            const r = rng.range(0.14, 0.22) + 0.07 * Math.max(0, Math.cos(a - heavy));
            blobs.push(new THREE.Vector4(Math.cos(a) * d, Math.sin(a) * d, z(), r));
        }
    } else if (form === 'lanes') {
        const hu = rng.range(-0.22, 0.22);
        stars.push(at(hu, rng.range(-0.06, 0.06), 0.05, power));
        blobs.push(at(hu, 0, 0, rng.range(0.26, 0.34)));
        const lumps = rng.int(4, 6);
        for (let i = 0; i < lumps; i++) {
            const u = -0.55 + (1.1 * i) / Math.max(1, lumps - 1) + rng.range(-0.06, 0.06);
            blobs.push(at(u, rng.range(-0.15, 0.15), z(), rng.range(0.17, 0.27)));
        }
        // Two lanes meeting near the heart, in a V or a long crack
        const spread = rng.range(0.4, 1.1);
        const n1 = [pe[0] * Math.cos(spread) + ax[0] * Math.sin(spread), pe[1] * Math.cos(spread) + ax[1] * Math.sin(spread)];
        const n2 = [pe[0] * Math.cos(-spread) + ax[0] * Math.sin(-spread), pe[1] * Math.cos(-spread) + ax[1] * Math.sin(-spread)];
        const cx = ax[0] * (hu + rng.range(-0.1, 0.1)) + pe[0] * rng.range(0.06, 0.14);
        const cy = ax[1] * (hu + rng.range(-0.1, 0.1)) + pe[1] * rng.range(0.06, 0.14);
        lanes.push(new THREE.Vector4(n1[0], n1[1], n1[0] * cx + n1[1] * cy, -9));
        lanes.push(new THREE.Vector4(n2[0], n2[1], n2[0] * cx + n2[1] * cy, -9));
        frontDepth += 0.2;
    } else if (form === 'bay') {
        // The along direction of a lane with normal (ax.y, -ax.x) is ax, so the dust comes in from +ax
        stars.push(at(rng.range(-0.28, -0.08), rng.range(-0.22, 0.22), 0.05, power * 0.8));
        const lumps = rng.int(6, 7);
        for (let i = 0; i < lumps; i++) {
            const a = rng.range(0, TAU);
            const d = rng.range(0.08, 0.50);
            blobs.push(at(Math.cos(a) * d, Math.sin(a) * d, z(), rng.range(0.20, 0.32)));
        }
        lanes.push(new THREE.Vector4(ax[1], -ax[0], rng.range(-0.08, 0.08), rng.range(-0.02, 0.18)));
        if (rng.chance(0.5)) lanes.push(new THREE.Vector4(pe[1], -pe[0], rng.range(0.1, 0.3), rng.range(0.15, 0.35)));
        laneWidth = rng.range(0.11, 0.17);
    } else {
        // A curving chain of lumps, with the turbulence combed along it
        const bend = rng.range(-0.5, 0.5);
        const lumps = 8;
        for (let i = 0; i < lumps; i++) {
            const t = -1 + (2 * i) / (lumps - 1);
            blobs.push(at(t * 0.62, bend * (t * t - 0.4) * 0.45, z(), rng.range(0.13, 0.21) * (1 - 0.3 * Math.abs(t))));
        }
        gasGain = 2.0;
        const hu = rng.range(-0.3, 0.3);
        stars.push(at(hu, bend * (hu * hu * 2.6 - 0.4) * 0.45 + rng.range(-0.12, 0.12), 0.05, power * 0.85));
        squeeze = rng.range(0.42, 0.6);
        rimGain = rng.range(0.6, 1.2);
    }

    const extra = rng.int(0, 2);
    for (let i = 0; i < extra; i++) {
        const home = stars[0];
        const dir = randomUnit(rng);
        const d = rng.range(0.12, 0.32);
        stars.push(new THREE.Vector4(home.x + dir[0] * d, home.y + dir[1] * d, home.z + dir[2] * 0.2, rng.range(0.12, 0.42)));
    }

    // How strongly the gas is lit depends on where the stars happened to fall. Left alone, some would burn out to white
    // and others barely show, so each one's exposure is set from the same sum the bake makes. Its magnitude still ranks it.
    let litSum = 0;
    let litWeight = 0;
    blobs.forEach((l) => {
        let U = 0;
        stars.forEach((s) => { U += s.w / ((s.x - l.x) ** 2 + (s.y - l.y) ** 2 + (s.z - l.z) ** 2 + 0.012); });
        const w = l.w * l.w;
        litSum += (0.09 + (U / (U + 13)) ** 1.5) * w;
        litWeight += w;
    });
    const exposure = Math.max(0.55, Math.min(1.7, (0.33 / (litSum / litWeight)) ** 0.9));
    // Teal is where the oxygen lines beat hydrogen, so how much of it there is comes from the nebula's own spectrum
    const excitation = Math.min(1, palette.excitation);
    const gasX = 0.95 * gasGain * exposure;
    const gasY = gasX * (0.12 + 1.1 * excitation) * 2.2;
    // How far from the main star the oxygen zone starts, in sprite units: larger round a hotter star and in gas with stronger
    // oxygen lines. The bake's zone is U * reach reaching a quarter, and U falls as w / (d * d + 0.012), which levels off so
    // soon near the star that a much smaller zone would never reach full strength anywhere. How much teal shows is left to
    // gasY, the line ratio. A bubble has no gas near its star, so there the zone has to reach the inner wall.
    const oxygenRadius = (0.12 + 0.1 * excitation) * rng.range(0.8, 1.2) * (0.75 + 0.5 * heat) + cavity * excitation * 1.2;
    const oxygenReach = (0.25 * (oxygenRadius * oxygenRadius + 0.012)) / stars[0].w;

    const off = new THREE.Vector3(rng.next(), rng.next(), rng.next());
    const rot = flowingRotation(rng, squeeze);
    const params = {
        blobs: fill(blobs, 8, farLump),
        stars: fill(stars, 4, noStar),
        lanes: fill(lanes, 3, noLane),
        off,
        rot,
        A: new THREE.Vector4(rng.range(0.2, 0.45), rng.range(0.9, 1.4), 0.3 + dustiness * 1.1, frontDepth),
        B: new THREE.Vector4(cavity, oxygenReach, rimGain, laneWidth),
        C: new THREE.Vector4(gasX, gasY, 0.62, 0.25),
        D: wall
    };
    return { program: 'emission', params };
}

// Dark clouds, also in real forms: strung along a line like a snake; a globule with a tail; a shapeless patch of lumps;
// or a long stem running into a bowl. Most of a cloud's shape comes from these, and its fraying from the noise.
function darkShape(body) {
    const rng = new Rng(hashString(`${body.visual_seed}:dust`));
    const form = rng.weighted([['snake', 3], ['globule', 2], ['patch', 3], ['pipe', 2]]);
    const th = rng.range(0, TAU);
    const ax = [Math.cos(th), Math.sin(th)];
    const pe = [-ax[1], ax[0]];
    const at = (u, v, r) => new THREE.Vector4(ax[0] * u + pe[0] * v, ax[1] * u + pe[1] * v, 0, r);
    const dustiness = body.nebula.dust ?? 0.9;
    const blobs = [];
    if (form === 'snake') {
        const bends = rng.range(1.4, 2.8);
        const swing = rng.range(0.14, 0.30);
        const phase = rng.range(0, TAU);
        for (let i = 0; i < 8; i++) {
            const t = -1 + (2 * i) / 7;
            blobs.push(at(t * 0.62, Math.sin(t * bends + phase) * swing, rng.range(0.085, 0.13) * (1 + 0.5 * (1 - Math.abs(t)))));
        }
    } else if (form === 'globule') {
        const curl = rng.range(-0.25, 0.25);
        blobs.push(at(-0.34, 0, rng.range(0.20, 0.26)));
        for (let i = 1; i < 8; i++) {
            const t = i / 7;
            blobs.push(at(-0.34 + t * 0.95, curl * t * t, 0.17 * (1 - t * 0.8)));
        }
    } else if (form === 'patch') {
        // Shapeless, but no more round than the band's own dust is
        for (let i = 0; i < 8; i++) {
            const u = rng.range(-0.55, 0.55);
            const v = rng.range(-0.24, 0.24) * (1 - 0.5 * Math.abs(u));
            blobs.push(at(u, v, rng.range(0.10, 0.22)));
        }
    } else {
        const curl = rng.range(-0.2, 0.2);
        for (let i = 0; i < 5; i++) {
            const t = i / 4;
            blobs.push(at(-0.62 + t * 0.85, curl * t * t, rng.range(0.07, 0.10)));
        }
        for (let i = 0; i < 3; i++) {
            const a = rng.range(0, TAU);
            blobs.push(at(0.32 + Math.cos(a) * 0.14, curl + Math.sin(a) * 0.14, rng.range(0.15, 0.23)));
        }
    }
    const light = rng.range(0, TAU);
    const params = {
        blobs,
        off: new THREE.Vector3(rng.next(), rng.next(), rng.next()),
        rot: randomRotation(rng),
        A: new THREE.Vector4(rng.range(0.28, 0.52), rng.range(0.95, 1.35), rng.range(0.75, 0.95), 0.5 + dustiness * 0.7),
        B: new THREE.Vector4(Math.cos(light), Math.sin(light), rng.range(3.0, 4.6), rng.range(0.5, 1.0)),
        C: new THREE.Vector4(1.0, 1.0, 0.75, 0)
    };
    return { program: 'dust', params };
}

function planetaryShape(body, palette) {
    const rng = new Rng(hashString(`${body.visual_seed}:shell`));
    const shape = rng.weighted([[0, 3], [1, 3], [2, 2], [3, 2], [4, 1]]);
    // Tilt and turn: the object's axis is what the shape is built around. A ring or a helix is seen near end-on, or it
    // would not read as one; a bipolar nebula lies across the view
    const ringLike = shape === 0 || shape === 3;
    const tilt = ringLike ? rng.range(0.08, 0.62) : shape === 1 ? rng.range(0.95, 1.5) : rng.range(0.25, 1.3);
    const turn = rng.range(0, 6.283);
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(tilt, 0, turn, 'XYZ'));
    const rot = new THREE.Matrix3().setFromMatrix4(m);
    const size = shape === 1 ? rng.range(0.62, 0.74) : rng.range(0.50, 0.62);
    const params = {
        rot,
        off: new THREE.Vector3(rng.next(), rng.next(), rng.next()),
        P: new THREE.Vector4(shape, size, rng.range(0.45, 0.95), rng.range(0.78, 1.0)),
        C: new THREE.Vector4(0.8, 1.3, 0.8 + (body.nebula.dust ?? 0.1) * 6, Math.min(0.5, 0.1 * palette.excitation))
    };
    return { program: 'planetary', params };
}

function setReflectionUniforms(u, params) {
    u.uBlob.value = params.blobs;
    u.uStar.value = params.stars;
    u.uLane.value = params.lanes;
    u.uOff.value = params.off;
    u.uRot.value = params.rot;
    u.uA.value = params.A;
    u.uB.value = params.B;
    u.uC.value = params.C;
}

function setEmissionUniforms(u, params) {
    setReflectionUniforms(u, params);
    u.uD.value = params.D;
}

function setDustUniforms(u, params) {
    u.uBlob.value = params.blobs;
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
        // No lines of its own: only the galaxy's light, reddened, from dust thin enough to let it out again; and the
        // colour of the band's star clouds behind it, for the haze that gives it something to hide
        return { a: [0.085, 0.066, 0.054], b: [0.135, 0.155, 0.225] };
    }
    if (type === 'emission') {
        // Strong [N II] beside H-alpha makes for warmer gas. The oxygen zone's colour is kept at full strength here: the bake
        // holds how bright it is, which comes from the nebula's own line ratio.
        const warmth = Math.max(0, Math.min(1, (palette.nitrogen - 0.15) / 0.35));
        const h = palette.hydrogen;
        const o = palette.oxygen;
        const top = Math.max(o[0], o[1], o[2], 1e-6);
        return {
            a: [h[0], h[1] * (0.9 + 0.32 * warmth), h[2] * (1.2 - 0.55 * warmth)],
            b: [o[0] / top, o[1] / top, o[2] / top]
        };
    }
    return { a: palette.hydrogen, b: palette.oxygen };
}

// Stars inside the nebula. They sit where the bake put the gas, are hidden by its dust in visible light (the
// shader reads the dust from the atlas), and show up in the infrared and ultraviolet as a real cluster would
function embeddedStars(body, shape, frame, half, rect, out, picks) {
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
            depth: body.depth,
            light: depthLight(body)
        });
        // What looks like a star in here has to answer a click, with the nebula it belongs to
        const { az, alt } = vec3ToAzAlt(wx, wy, wz);
        picks.push({
            az,
            alt,
            fadeLo,
            shows: {
                radio: 0,
                ir: ir * body.bands.ir,
                visible: v * body.bands.visible,
                uv: uv * body.bands.uv,
                xray: xr * body.bands.xray
            }
        });
    };
    if (type === 'planetary') {
        // The central white dwarf: tiny and very hot, so stronger in the ultraviolet than in visible light
        const teff = body.nebula.central_star ? body.nebula.central_star.teff_K : rng.range(60000, 120000);
        add(0, 0, 0, Math.min(teff, 40000), 2.4, 1.1, 0.05, 8.0, 2.0, 14, 50);
        return;
    }
    const lit = (shape.params.stars || []).filter((s) => s.w > 0);
    lit.forEach((s, i) => {
        const known = i === 0 && body.nebula.central_star;
        add(s.x, s.y, s.z, known ? known.teff_K : type === 'reflection' ? rng.range(12000, 22000) : rng.range(26000, 42000),
            i === 0 ? 3.6 : 2.8, i === 0 ? 1.5 : 1.0, 0.45, 9.0, 1.5, 22, 90);
    });
    if (type === 'emission') {
        // A young cluster: most about the main star, the rest out in the gas, with a few massive ones among many small
        const young = rng.int(26, 48);
        const lumps = shape.params.blobs.filter((b) => b.w > 0.05);
        const main = lit[0];
        for (let i = 0; i < young; i++) {
            const nearHeart = rng.next() < 0.55;
            const home = nearHeart ? main : lumps[rng.int(0, lumps.length - 1)];
            const spread = nearHeart ? 0.13 : home.w * 0.8;
            const a = rng.range(0, TAU);
            const d = spread * Math.sqrt(-2 * Math.log(Math.max(1e-3, rng.next())));
            let x = home.x + Math.cos(a) * d;
            let y = home.y + Math.sin(a) * d;
            const far = Math.hypot(x, y);
            if (far > 0.8) {
                x *= 0.8 / far;
                y *= 0.8 / far;
            }
            const massive = rng.next() ** 3;
            const teff = 3000 + massive * 12000;
            add(x, y, 0, teff, 1.3 + massive * 1.3, 0.2 + massive * 0.7, 0.55 + (1 - massive) * 0.65, massive * 0.7, 0.2 + rng.next() * 0.35, 100, 340);
        }
        return;
    }
    const r2 = 0.6 ** 2;
    const young = rng.int(type === 'reflection' ? 6 : 5, 12);
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

// Both draws place their sprites the same way, and share how a sprite changes with its size on screen
const SPRITE_VERTEX = /* glsl */`
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
    varying float vGain;
    varying float vDim;
    varying float vBlur;
    varying float vLod;
    varying float vFlatten;
    void main() {
        vQ = position.xy;
        vCell = aRect.xy + (position.xy * 0.5 + 0.5) * aRect.zw;
        vColA = aColA;
        vColB = aColB;
        vReady = aReady;
        float aKind = aPack.w;
        float aMag = aPack.z;
        vKind = aKind;
        SET_HERO(aPack.y)
        // Faint nebulae come up as you zoom in, gently, so they don't pop: surface brightness is unchanged by
        // zoom in reality, but the sky's limiting magnitude is how this sim reveals faint objects
        float over = clamp(pow(10.0, -0.4 * (aMag - uLimitMag)), 0.0, 1.0);
        vStrength = vec4(aBandA.x, aBandA.y, aBandA.z * pow(over, 0.4), aBandA.w);
        vStrengthX = aBandB;

        // Small on screen, a nebula is a soft glow in the Milky Way, as in any wide-field photograph. It only earns its
        // full brightness and contrast as it grows. Planetaries are compact and stay jewels at any size.
        float across = 2.0 * aPack.x * uPxPerRad * depthP(aDepth);
        float small = 1.0 - smoothstep(24.0, 240.0, across);
        float tiny = 1.0 - smoothstep(26.0, 200.0, across);
        vGain = 1.0;
        vDim = 1.0;
        vBlur = 1.0;
        vFlatten = 1.0;
        if (aKind < 0.5) {
            // Brighter nebulae stand out from fainter ones, so that the sky has a hierarchy
            float rank = clamp(pow(10.0, -0.2 * (aMag - 4.5)), 0.62, 1.2);
            vGain = rank * mix(1.0, 0.36, small);
            vDim = mix(1.0, 0.4, small);
            vBlur = mix(1.0, 4.0, small * small);
            vFlatten = mix(1.0, 0.62, small);
        } else if (aKind < 1.5) {
            vGain = mix(1.0, 0.32, tiny);
            vDim = mix(1.0, 0.6, tiny);
            vBlur = mix(1.0, 2.4, tiny);
        } else if (aKind < 2.5) {
            vBlur = mix(1.0, 1.6, tiny);
        }
        // Radio and X-rays come from broad, smooth gas, the more so the smaller it looks
        vLod = mix(3.4, 4.8, small);
        vec3 world = (aCentre + (aR * position.x + aN * position.y) * aPack.x) * ${SKY_RADIUS.toFixed(1)};
        gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
        gl_Position.xy *= depthP(aDepth);
        #ifdef DUST_PASS
        // A planetary's little dust isn't worth a draw of its own: this puts it outside the view
        if (aKind > 2.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        #endif
    }`;

const SPRITE_VARYINGS = /* glsl */`
    varying vec2 vQ;
    varying vec2 vCell;
    varying vec3 vColA;
    varying vec3 vColB;
    varying vec4 vStrength;
    varying float vStrengthX;
    varying float vReady;
    varying float vKind;
    varying float vGain;
    varying float vDim;
    varying float vBlur;
    varying float vLod;
    varying float vFlatten;
`;

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
        let shape;
        let set;
        if (type === 'planetary') {
            shape = planetaryShape(body, palette);
            set = (u) => setPlanetaryUniforms(u, shape.params);
        } else if (type === 'emission') {
            shape = emissionShape(body, palette);
            set = (u) => setEmissionUniforms(u, shape.params);
        } else if (type === 'dark') {
            shape = darkShape(body);
            set = (u) => setDustUniforms(u, shape.params);
        } else {
            shape = reflectionShape(body);
            set = (u) => setReflectionUniforms(u, shape.params);
        }
        const job = baker.addJob({
            program: shape.program,
            dir: frame.c,
            set,
            onReset() { items[i].shown = 0; aReady[i] = 0; readyAttr.needsUpdate = true; }
        });
        const tanHalf = Math.tan((body.nebula.size_deg * 0.5 * SPRITE_MARGIN[type]) * RAD);
        const colours = spriteColours(body, palette);
        aCentre.set(frame.c, i * 3);
        aR.set(frame.r, i * 3);
        aN.set(frame.n, i * 3);
        // A dark cloud shows by what it hides, at any zoom
        aPack.set([tanHalf, job.id, type === 'dark' ? -99 : drawMag(body), KIND_CODE[type]], i * 4);
        aRect.set(job.rect, i * 4);
        aColA.set(colours.a, i * 3);
        aColB.set(colours.b, i * 3);
        const light = depthLight(body);
        aBandA.set([body.bands.radio * light, body.bands.ir * light, body.bands.visible * light, body.bands.uv * light], i * 4);
        aBandB[i] = body.bands.xray * light;
        aDepth[i] = body.depth;
        const stars = [];
        items.push({ body, job, frame, tanHalf, shown: 0, stars, pickTan: tanHalf * PICK_SHARE[type] });
        embeddedStars(body, shape, frame, tanHalf, job.rect, starList, stars);
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

    // What's behind the dust, multiplied by what the dust lets through
    const dustMaterial = skyMaterial({
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.SrcColorFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
        defines: { DUST_PASS: 1 },
        uniforms: { tAtlas: baker.atlasUniform, ...baker.heroUniforms },
        vertexShader: SPRITE_VERTEX,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            ${SPRITE_FETCH_GLSL}
            ${SPRITE_VARYINGS}
            void main() {
                if (dot(vQ, vQ) >= 1.0 || vReady <= 0.0) discard;
                float opacity = fetchBaked(vQ, vCell, vBlur).a;
                // Dust blocks visible and ultraviolet light, but much less of the infrared, and almost no radio
                float blocks = uBandW[2] + uBandW[3] + uBandW[1] * 0.14 + uBandW[4] * 0.25;
                float a = min(opacity * vDim * blocks * vReady, 0.9);
                // Red gets through best. A reflection nebula's dust is thin and already blue with scattered light.
                vec3 by = vKind > 0.5 && vKind < 1.5 ? vec3(1.0) : mix(vec3(1.0), vec3(0.82, 1.0, 1.2), uBandW[2]);
                vec3 through = pow(vec3(1.0 - a), by);
                gl_FragColor = vec4(mix(vec3(1.0), through, uSkyFade), 1.0);
            }`
    });
    const dustMesh = new THREE.Mesh(geometry, dustMaterial);
    dustMesh.frustumCulled = false;
    dustMesh.renderOrder = ORDER.nebulae - 0.25;
    engine.scene.add(dustMesh);

    const material = skyMaterial({
        uniforms: { tAtlas: baker.atlasUniform, ...baker.heroUniforms },
        vertexShader: SPRITE_VERTEX,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            ${SPRITE_FETCH_GLSL}
            ${SPRITE_VARYINGS}

            // False colour from a band's tint, running to white where it is brightest
            vec3 ramp(vec3 tint, float v) {
                return tint * v + vec3(0.9) * v * v * 0.28;
            }

            void main() {
                float r2 = dot(vQ, vQ);
                if (r2 >= 1.0) discard;
                vec4 t = fetchBaked(vQ, vCell, vBlur);
                float hyd = t.r * t.r;
                float oxy = t.g * t.g;
                float dust = t.b * t.b;
                float opacity = t.a;

                vec3 visible;
                if (vKind < 0.5) {
                    // As film and sensors record it: faint gas is a deep red, paling through rose as it brightens.
                    // Small on screen, the range is pressed together: a soft glow, not a hard knot in a faint haze.
                    float hf = pow(hyd, vFlatten);
                    float pale = mix(smoothstep(0.0, 0.6, hf), 1.0, (1.0 - vFlatten) * 1.8);
                    vec3 h = vColA * hf * vec3(1.0, mix(0.55, 1.6, pale), mix(0.55, 1.45, pale));
                    // What the gas is doing, on the scale of the whole cloud, from a soft copy of the same image.
                    // Dense gas is warmer, more of an orange red; beside dust, scattered blue light turns it magenta.
                    vec4 wide = textureLod(tAtlas, vCell, 3.2);
                    float broad = wide.r * wide.r;
                    float nearDust = smoothstep(0.05, 0.45, wide.a);
                    float dense = smoothstep(0.1, 0.45, broad) * (1.0 - nearDust);
                    h.g *= 1.0 + 0.38 * dense - 0.15 * nearDust;
                    h.b *= 1.0 - 0.4 * dense + 0.42 * nearDust;
                    // Where oxygen's lines beat hydrogen's, which is only close to the hottest stars, the heart turns a
                    // pale blue green. The bake's encoding undone gives the real ratio of the two.
                    float gasX = hyd / (1.02 - hyd);
                    float ratio = (oxy / (1.02 - oxy)) / (gasX + 0.015);
                    float close = smoothstep(0.62, 1.0, vFlatten);
                    float teal = smoothstep(0.1, 0.95, ratio) * (0.25 + 0.75 * close) * smoothstep(0.05, 0.3, hf);
                    visible = mix(h, vColB * hf * 0.6, teal * 0.88);
                    // Bright gas is pressed together by the bake's shoulder. Dividing by the soft copy brings its filaments
                    // back, as an astrophotographer's local contrast does, so a nebula's heart has as much in it as its edge
                    float local = pow((gasX + 0.02) / (broad / (1.02 - broad) + 0.02), 0.4);
                    visible *= mix(1.0, clamp(local, 0.55, 1.7), smoothstep(0.15, 0.7, hf) * close);
                    // The faint glow it fades out through, stronger while small
                    visible += vColA * broad * (0.16 + (1.0 - vFlatten) * 1.3);
                    visible *= 1.3;
                    // And a little less colour, to sit with the muted band, which is mostly unresolved starlight
                    visible = mix(vec3(dot(visible, vec3(0.3, 0.55, 0.15))), visible, 1.0 - (1.0 - vFlatten) * 0.75);
                } else if (vKind > 2.5) {
                    vec3 h = vColA * hyd;
                    h.gb *= mix(0.55, 1.45, smoothstep(0.0, 0.5, hyd));
                    // Nitrogen dominates a planetary's outer edge, which warms it. Its faint inner gas is lit hardest of
                    // all, and looks bluer than its bright walls.
                    h.b *= 0.55;
                    h.g *= 1.12;
                    vec3 o = mix(vec3(0.20, 0.46, 1.0) * max(vColB.g, 0.2) * oxy * 1.3, vColB * oxy, smoothstep(0.02, 0.26, oxy));
                    visible = (h + o) * (1.0 + 0.5 * hyd * hyd) * 1.3;
                } else if (vKind < 1.5) {
                    // Where oxygen dominates the eye sees teal, not teal plus the red of whatever lies in front of it
                    float hydSeen = hyd * mix(1.0, 0.3, smoothstep(0.06, 0.42, oxy));
                    visible = (vColA * hydSeen + vColB * oxy) * 1.35;
                } else {
                    visible = vColA * hyd + vColB * oxy;
                }
                vec3 col = visible * vGain * vStrength.z;
                if (vKind < 0.5 || vKind > 2.5) {
                    // Keeps glowing gas under the tone curve's shoulder, by scaling all three colours together, so that the
                    // brightest parts stay coloured and keep their filaments rather than burning out to white
                    float peak = max(col.r, max(col.g, col.b));
                    if (peak > 0.55) col *= (0.55 + 0.6 * (1.0 - exp((0.55 - peak) / 0.6))) / peak;
                }
                col *= uBandW[2];
                // The sky's own faint glow is airglow, in front of any dust: nothing out there can be darker than that
                col += vec3(0.0052, 0.0076, 0.0165) * opacity * vDim * uBandW[2];

                float blendOthers = uBandW[0] + uBandW[4];
                if (blendOthers > 0.001) {
                    vec4 s = textureLod(tAtlas, vCell, vLod);
                    float sh = s.r * s.r;
                    float so = s.g * s.g;
                    float sd = s.b * s.b;
                    float radio = (sh + so * 0.7) * 3.2 + sd * 0.5;
                    col += ramp(uBandTint[0], radio * vStrength.x) * uBandW[0];
                    float xr = (so * 1.1 + sh * 0.25) * 3.6;
                    col += ramp(uBandTint[4], xr * vStrengthX) * uBandW[4];
                }
                // Infrared: the dust that blocks visible light is what glows
                float ir = (vKind > 1.5 && vKind < 2.5 ? dust * 1.1 : dust * (vKind > 0.5 && vKind < 1.5 ? 2.6 : 1.7) + hyd * 0.2);
                col += ramp(uBandTint[1], ir * vStrength.y * vGain) * uBandW[1];
                // Ultraviolet: the hot gas near the stars, heavily dimmed by dust. Reflection nebulae scatter it strongly
                float uvScatter = vKind > 0.5 && vKind < 1.5 ? 1.5 : 0.28;
                float uvLight = (oxy * 1.1 + hyd * uvScatter) * 2.4;
                col += ramp(uBandTint[3], uvLight * vStrength.w * vGain) * uBandW[3];

                // A soft stand-in until the bake arrives, then a quick fade across to it
                float stand = exp(-r2 * 5.0) * smoothstep(1.0, 0.5, sqrt(r2)) * 0.05;
                // An emission nebula's second colour is its oxygen at full strength, which would turn this grey
                vec3 waiting = (vKind < 0.5 ? vColA : vColA + vColB) * stand * vGain * vStrength.z * uBandW[2];
                col = mix(waiting, col, vReady);

                // Tiny grain so faint gradients don't band on an 8-bit screen
                float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
                col *= 1.0 + (grain - 0.5) * 0.05;
                gl_FragColor = vec4(col * uSkyFade, 1.0);
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
        sStrength.set([s.strength.ir * s.light, s.strength.visible * s.light, s.strength.uv * s.light, s.strength.xray * s.light], i * 4);
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

    const forward = new THREE.Vector3();
    return {
        id: 'nebulae',
        update(frame) {
            baker.beginFrame(frame);
            dustMesh.visible = frame.bandW[1] + frame.bandW[2] + frame.bandW[3] + frame.bandW[4] > 0.002;
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
        // A click anywhere on a nebula selects it, once it shows in this band at this zoom. So does a click on anything
        // in it that looks like a star. Zoomed into one, its centre may be off the screen, where a pick can't find it: then
        // the candidate is the biggest circle round the middle of the view that still lies on the nebula.
        picks(frame) {
            const out = [];
            frame.camera.getWorldDirection(forward);
            const pxPerRad = frame.pxPerRad / frame.dpr;
            let viewAt = null;
            for (let i = 0; i < n; i++) {
                const { body, tanHalf, pickTan, stars: inside, frame: f } = items[i];
                const strength = body.bands[frame.band] || 0;
                if (strength <= 0.01) continue;
                const P = parallaxFactor(body.depth, frame.fov);
                out.push({ code: body.code, az: body.sky.az, alt: body.sky.alt, radiusPx: pickTan * pxPerRad * P, depth: body.depth });
                const across = 2 * tanHalf * frame.pxPerRad * P;
                for (let j = 0; j < inside.length; j++) {
                    const s = inside[j];
                    if (across > s.fadeLo && s.shows[frame.band] > 0.01) out.push({ code: body.code, az: s.az, alt: s.alt, radiusPx: 0, depth: body.depth });
                }
                const d = forward.x * f.c[0] + forward.y * f.c[1] + forward.z * f.c[2];
                if (d <= 0) continue;
                const off = Math.tan(Math.acos(Math.min(1, d)));
                if (off < pickTan) {
                    if (!viewAt) viewAt = vec3ToAzAlt(forward.x, forward.y, forward.z);
                    out.push({ code: body.code, az: viewAt.az, alt: viewAt.alt, radiusPx: (pickTan - off) * pxPerRad * P, depth: body.depth });
                }
            }
            return out;
        },
        baker,
        dispose() {
            engine.scene.remove(mesh);
            engine.scene.remove(dustMesh);
            engine.scene.remove(stars);
            geometry.dispose();
            material.dispose();
            dustMaterial.dispose();
            starGeometry.dispose();
            starMaterial.dispose();
            baker.dispose();
        }
    };
}
