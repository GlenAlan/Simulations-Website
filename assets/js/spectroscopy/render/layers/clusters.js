// Star clusters. Every member is a real point at its own place in the sky, coloured by its own temperature, so a
// cluster's H-R diagram and its look agree: red giants stand out in a globular, blue stars in a young open cluster.
// Like any star a member shows once the zoom's limit reaches its magnitude, so a cluster is a few bright stars at first and
// more come out as you go in. Clicking a member selects it once it stands apart on screen, and until then the cluster, so
// nothing drawn is a dead end. What has no code of its own is what makes a cluster read as one (a globular's glow and its
// thousands of fainter stars, and any leftover haze), and clicking those selects the cluster.

import * as THREE from 'three';
import { bus } from '../../core/state.js';
import { Rng, hashString } from '../../core/rng.js';
import { blackBodyRGB, planck, SIGMA } from '../../core/phys.js';
import { limitingMag, MIN_FOV } from '../../core/sky.js';
import { drawMag, depthLight, parallaxFactor } from '../../core/depth.js';
import { skyMaterial, BAND_GLSL, LOOP_ZERO_GLSL, ORDER } from '../shared.js';
import { SKY_RADIUS, tangentBasis, offsetVector, quadAxes, worldHalfSize, memberDirection, revealGain, REVEAL_GLSL } from './sky_tangent.js';

const RAD = Math.PI / 180;
const HAZE_TILE = 128;
const GLOW_REACH = 1.35;            // The glow's quad reaches this many cluster radii from the centre
const DECOR_STARS = { low: 1500, medium: 3500, high: 7000 };
const DECOR_MAX = DECOR_STARS.high;
const DECOR_REACH = 2.4;            // A globular's fainter stars thin out to nothing by this many radii
const RING_RADIUS_PX = 20;

// Picking, in CSS pixels
const OPENS_PX = 55;                // A cluster's radius on screen before its members can be picked one by one...
const APART_PX = 6;                 // ...and how far a member must then be from its nearest neighbour
const APART_DEEP_PX = 4;            // The same at the deepest zoom, where every member should be open to a click
const MEMBER_REACH_PX = 3;          // Within this of a member it's a direct hit. Small, so that the nearer of two wins

// A member's light, from how many magnitudes it is above the zoom's limit. Shader and picking share these.
const SHOW_FROM = -0.6;             // Starts to show this far below the limit...
const SHOW_BY = 0.8;                // ...and is fully there this far above it
const LIGHT_AT_START = 0.15;        // What light it has when it starts to show...
const LIGHT_RATE = 0.08;            // ...and each magnitude above that multiplies it by 10 to this power, for a few bright stars among many faint
const LIGHT_MOST = 3;
const GLOBULAR_GIANTS = 1.5;        // A globular's stars have its glow to stand out from
const FAR_OFF_LIGHT = 0.4;          // A cluster's stars are held back to this share while it's small, so they don't catch the eye first...
const FAR_OFF_PX = [20, 170];       // ...until this many CSS pixels per degree
const SMUDGE_LIGHT = 0.03;          // Too faint to see one by one, an open cluster's stars still add up to a smudge...
const SMUDGE_FROM_PX2 = 4;          // ...while each has less than this much of the screen to itself (square CSS pixels)...
const SMUDGE_TO_PX2 = 30;           // ...and none by this much
const SMUDGE_STACKED_PX2 = 2;       // With less than this each, their points land on each other, so each gives less
const DRAWN_PEAK = 0.004;           // Dimmer than this a member isn't drawn at all
const SEEN_PEAK = 0.03;             // Dimmer than this it can hardly be seen, so a click on it shouldn't find it
// Every member can be found: at the deepest zoom the limit reaches even the faintest, whatever its true magnitude
const FAINTEST_DRAWN = limitingMag(MIN_FOV) - SHOW_BY;

// Where a member is seen in the sky, as { az, alt }. Overlays and Go to use this too: offsets lie in the sky's
// tangent plane at the cluster, x along increasing azimuth and y along increasing altitude (see sky_tangent.js).
export function memberSkyDirection(body, member) {
    return memberDirection(body, member);
}

// The share of a black body's light in each band, from a few samples of the Planck curve. Cached by temperature.
const BAND_SAMPLES_NM = {
    uv: [120, 160, 200, 250, 300],
    visible: [420, 500, 580, 660],
    ir: [900, 1300, 1900, 2800, 4200]
};
const shareCache = new Map();
function bandShares(teffK) {
    const key = Math.round(teffK / 100);
    let shares = shareCache.get(key);
    if (shares) return shares;
    const T = key * 100;
    const total = (SIGMA * T ** 4) / Math.PI;
    shares = {};
    Object.entries(BAND_SAMPLES_NM).forEach(([band, samples]) => {
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
            const lo = i ? (samples[i] + samples[i - 1]) / 2 : samples[i] * 0.85;
            const hi = i < samples.length - 1 ? (samples[i] + samples[i + 1]) / 2 : samples[i] * 1.15;
            sum += planck(samples[i], T) * (hi - lo) * 1e-9;
        }
        shares[band] = sum / total;
    });
    shareCache.set(key, shares);
    return shares;
}

// A flux across the sky's clusters squeezed into 0..1. These references are about a bright giant in each band.
const REF_IR = 40;
const REF_UV = 15;
const squeeze = (flux, ref) => Math.min(1, (flux / ref) ** 0.4);

// A few members of each globular are X-ray binaries. Which ones comes from their codes, so it never changes.
function xrayBinaries(body) {
    if (body.cluster.type !== 'globular') return new Set();
    const ranked = body.cluster.members.slice().sort((a, b) => hashString(a.code) - hashString(b.code));
    return new Set(ranked.slice(0, 2 + (hashString(body.code) % 4)).map((m) => m.code));
}

const smoothstep = (lo, hi, x) => {
    const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
    return t * t * (3 - 2 * t);
};

// The shader's memberLight, for picking
function memberLight(above) {
    return smoothstep(SHOW_FROM, SHOW_BY, above) * Math.min(LIGHT_MOST, LIGHT_AT_START * 10 ** (LIGHT_RATE * Math.max(above - SHOW_FROM, 0)));
}

// What picking needs to know about each member. Built the first time a click comes near the cluster.
function pickTable(body, bandA, bandB, memberBoost, first) {
    return body.cluster.members.map((member, k) => {
        let nearest = Infinity;
        body.cluster.members.forEach((other) => {
            if (other === member) return;
            const d = Math.hypot(member.offset_deg.x - other.offset_deg.x, member.offset_deg.y - other.offset_deg.y);
            if (d < nearest) nearest = d;
        });
        const { az, alt } = memberDirection(body, member);
        const i = first + k;
        return {
            code: member.code,
            az,
            alt,
            depth: member.depth,
            nearestDeg: nearest,
            mag: Math.min(drawMag(member), FAINTEST_DRAWN),
            starLight: memberBoost[i],
            visible: bandA[i * 4 + 2],
            radio: bandA[i * 4],
            ir: bandA[i * 4 + 1],
            uv: bandA[i * 4 + 3],
            xray: bandB[i]
        };
    });
}

export function createClustersLayer(engine, app) {
    const { scene, renderer } = engine;
    const bodies = app.universe.bodies.filter((b) => b.kind === 'cluster');

    const clusters = bodies.map((body) => {
        const rng = new Rng(`cluster:${body.visual_seed}`);
        const age = body.cluster.age_Myr;
        const youth = age < 60 ? 0.7 : age < 200 ? 0.2 : 0;
        return {
            body,
            basis: tangentBasis(body.sky.az, body.sky.alt),
            unit: null,
            globular: body.cluster.type === 'globular',
            haze: body.cluster.type === 'open' && rng.next() < youth,
            hazeSeed: [rng.range(0, 80), rng.range(0, 80)],
            hazeBaked: false,
            hazeIndex: -1,
            decor: null,
            separationDeg: 0,
            xray: xrayBinaries(body)
        };
    });
    clusters.forEach((c) => { c.unit = c.basis.centre; });

    const uDpr = { value: 1 };

    // Members: one draw call for every star in every cluster
    const memberCount = clusters.reduce((sum, c) => sum + c.body.cluster.members.length, 0);
    const positions = new Float32Array(memberCount * 3);
    const colours = new Float32Array(memberCount * 3);
    const bandA = new Float32Array(memberCount * 4);
    const bandB = new Float32Array(memberCount);
    const memberInfo = new Float32Array(memberCount * 3); // Its magnitude as drawn, its cluster's sky area per member, and its cluster's magnitude
    const memberBoost = new Float32Array(memberCount);
    const memberDepth = new Float32Array(memberCount);
    let w = 0;
    clusters.forEach((c) => {
        const { body } = c;
        const { members, radius_deg: radius } = body.cluster;
        const areaPerMember = (Math.PI * radius * radius) / Math.max(1, members.length) / (c.globular ? 5 : 1);
        c.firstMember = w;
        c.areaPerMember = areaPerMember;
        members.forEach((member) => {
            const v = offsetVector(c.basis, member.offset_deg.x, member.offset_deg.y);
            positions.set([v[0] * SKY_RADIUS, v[1] * SKY_RADIUS, v[2] * SKY_RADIUS], w * 3);
            const T = member.star.teff_K;
            colours.set(blackBodyRGB(T), w * 3);
            const L = member.star.luminosity_Lsun;
            const shares = bandShares(T);
            const isXray = c.xray.has(member.code);
            const youngCorona = !c.globular && T < 6500 && body.cluster.age_Myr < 150;
            const light = depthLight(body);
            bandA.set([
                body.bands.radio * 0.2 * light,
                squeeze(L * shares.ir, REF_IR) * body.bands.ir * light,
                // Its magnitude already says how much distance has dimmed it, so depth takes only a little more off here
                body.bands.visible * Math.sqrt(light),
                squeeze(L * shares.uv, REF_UV) * body.bands.uv * light
            ], w * 4);
            memberBoost[w] = c.globular ? GLOBULAR_GIANTS : 1;
            bandB[w] = (isXray ? Math.max(0.5, body.bands.xray) : (youngCorona ? 0.25 : 0.03) * body.bands.xray) * light;
            memberInfo.set([Math.min(drawMag(member), FAINTEST_DRAWN), areaPerMember, drawMag(body)], w * 3);
            memberDepth[w] = member.depth;
            w++;
        });
    });
    const memberGeometry = new THREE.BufferGeometry();
    memberGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    memberGeometry.setAttribute('aColour', new THREE.BufferAttribute(colours, 3));
    memberGeometry.setAttribute('aBandA', new THREE.BufferAttribute(bandA, 4));
    memberGeometry.setAttribute('aBandB', new THREE.BufferAttribute(bandB, 1));
    memberGeometry.setAttribute('aInfo', new THREE.BufferAttribute(memberInfo, 3));
    memberGeometry.setAttribute('aBoost', new THREE.BufferAttribute(memberBoost, 1));
    memberGeometry.setAttribute('aDepth', new THREE.BufferAttribute(memberDepth, 1));
    const memberMaterial = skyMaterial({
        uniforms: { uDpr },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            ${REVEAL_GLSL}
            uniform float uDpr;
            attribute vec3 aColour;
            attribute vec4 aBandA;
            attribute float aBandB;
            attribute vec3 aInfo;
            attribute float aBoost;
            attribute float aDepth;
            varying vec3 vColour;
            float memberLight(float above) {
                return smoothstep(${SHOW_FROM.toFixed(2)}, ${SHOW_BY.toFixed(2)}, above)
                    * min(${LIGHT_MOST.toFixed(1)}, ${LIGHT_AT_START.toFixed(3)} * pow(10.0, ${LIGHT_RATE.toFixed(3)} * max(above - ${SHOW_FROM.toFixed(2)}, 0.0)));
            }
            void main() {
                float pxPerDeg = uPxPerRad * depthP(aDepth) * 0.0174533;
                // The screen each member has to itself, in square CSS pixels
                float room = aInfo.y * pxPerDeg * pxPerDeg / (uDpr * uDpr);
                float spread = clamp(room / 10.0, 0.12, 1.0);
                // A globular has its glow for this. The revealGain keeps a far cluster's smudge fainter than a near one's
                float smudge = aBoost > 1.0 ? 0.0 : (1.0 - smoothstep(${SMUDGE_FROM_PX2.toFixed(1)}, ${SMUDGE_TO_PX2.toFixed(1)}, room))
                    * clamp(room / ${SMUDGE_STACKED_PX2.toFixed(1)}, 0.2, 1.0) * ${SMUDGE_LIGHT.toFixed(3)} * revealGain(aInfo.z);
                float farOff = mix(${FAR_OFF_LIGHT.toFixed(2)}, 1.0, smoothstep(${FAR_OFF_PX[0].toFixed(1)}, ${FAR_OFF_PX[1].toFixed(1)}, pxPerDeg / uDpr));
                float strong = max(memberLight(uLimitMag - aInfo.x) * aBoost * farOff, smudge) * aBandA.z * uBandW[2];
                float grey = dot(aColour, vec3(0.3, 0.55, 0.15));
                vec3 c = max(mix(vec3(grey), aColour, 1.3), 0.0) * strong
                    + uBandTint[0] * uBandW[0] * aBandA.x
                    + uBandTint[1] * uBandW[1] * aBandA.y * mix(0.5, 1.0, spread) * 2.2
                    + uBandTint[3] * uBandW[3] * aBandA.w * mix(0.5, 1.0, spread) * 2.2
                    + uBandTint[4] * uBandW[4] * aBandB * 3.0;
                float peak = max(c.r, max(c.g, c.b));
                vColour = c;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_Position.xy *= depthP(aDepth);
                // A few bright stars and many faint ones. Going in they swell a little, as if you were getting closer
                float zoom = clamp(pow(pxPerDeg / (8.0 * uDpr), 0.25), 1.0, 2.4);
                float size = (1.2 + 4.2 * pow(min(peak, 3.0), 0.8)) * zoom * uDpr;
                gl_PointSize = peak < ${DRAWN_PEAK.toFixed(3)} ? 0.0 : size;
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            varying vec3 vColour;
            void main() {
                vec2 c = (gl_PointCoord - 0.5) * 2.0;
                float d = dot(c, c);
                if (d > 1.0) discard;
                // A hard little core inside a soft halo
                float glow = exp(-d * 8.0) + 0.2 * (1.0 - d) * (1.0 - d);
                gl_FragColor = vec4(vColour * glow * uSkyFade, 1.0);
            }`
    });
    const members = new THREE.Points(memberGeometry, memberMaterial);
    members.frustumCulled = false;
    members.renderOrder = ORDER.clusters + 1;
    scene.add(members);

    // Haze: small baked clouds, in an atlas. Only young open clusters have any.
    const hazy = clusters.filter((c) => c.haze);
    const hazeCols = Math.max(1, Math.ceil(Math.sqrt(hazy.length)));
    const hazeRows = Math.max(1, Math.ceil(hazy.length / hazeCols));
    hazy.forEach((c, i) => { c.hazeIndex = i; });
    const hazeAtlas = new THREE.WebGLRenderTarget(hazeCols * HAZE_TILE, hazeRows * HAZE_TILE, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        generateMipmaps: true
    });
    const hazeBakeMaterial = new THREE.ShaderMaterial({
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        uniforms: { uSeed: { value: new THREE.Vector2() } },
        vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: /* glsl */`
            varying vec2 vP;
            uniform vec2 uSeed;
            ${LOOP_ZERO_GLSL}
            float h21(vec2 p) {
                vec3 q = fract(vec3(p.xyx) * 0.1031);
                q += dot(q, q.yzx + 33.33);
                return fract((q.x + q.y) * q.z);
            }
            float vn(vec2 p) {
                vec2 i = floor(p);
                vec2 f = fract(p);
                f = f * f * (3.0 - 2.0 * f);
                return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
            }
            float fbm(vec2 p) {
                float a = 0.5, s = 0.0;
                for (int i = 0; i < 6 + uLoopZero; i++) {
                    s += a * vn(p);
                    a *= 0.5;
                    p = mat2(0.8, 0.6, -0.6, 0.8) * p * 2.05 + 7.1;
                }
                return s;
            }
            void main() {
                vec2 p = vP;
                vec2 w = vec2(fbm(p * 2.2 + uSeed), fbm(p * 2.2 + uSeed.yx + 9.0)) - 0.5;
                float d = fbm(p * 2.8 + w * 2.2 + uSeed * 1.3);
                float wisps = fbm(p * 7.0 + w * 3.0 + uSeed.yx);
                float env = 1.0 - smoothstep(0.25, 1.0, length(p + w * 0.4));
                float cloud = smoothstep(0.44, 0.86, d) * env;
                // Blue where it scatters starlight, a little pink where the hottest stars still make it glow
                vec3 col = mix(vec3(0.2, 0.42, 1.0), vec3(1.0, 0.3, 0.46), smoothstep(0.54, 0.74, wisps) * 0.5);
                vec3 rgb = col * cloud * cloud * (0.45 + wisps);
                gl_FragColor = vec4(sqrt(clamp(rgb, 0.0, 1.0)), sqrt(clamp(cloud, 0.0, 1.0)));
            }`
    });
    const bakeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), hazeBakeMaterial);
    bakeQuad.frustumCulled = false;
    const bakeScene = new THREE.Scene();
    bakeScene.add(bakeQuad);
    const bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const hazeStep = { next: 0, ready: false, run: 0 };

    function compileHaze() {
        const run = ++hazeStep.run;
        hazeStep.ready = false;
        engine.compileInBackground(bakeScene, bakeCamera).then(() => {
            if (run === hazeStep.run) hazeStep.ready = true;
        });
    }
    if (hazy.length) compileHaze();

    function bakeNextHaze() {
        if (!hazeStep.ready || hazeStep.next >= hazy.length || !engine.bakesAllowed()) return false;
        const c = hazy[hazeStep.next++];
        const x = (c.hazeIndex % hazeCols) * HAZE_TILE;
        const y = Math.floor(c.hazeIndex / hazeCols) * HAZE_TILE;
        hazeAtlas.viewport.set(x, y, HAZE_TILE, HAZE_TILE);
        hazeAtlas.scissor.set(x, y, HAZE_TILE, HAZE_TILE);
        hazeAtlas.scissorTest = true;
        hazeBakeMaterial.uniforms.uSeed.value.set(c.hazeSeed[0], c.hazeSeed[1]);
        const previous = renderer.getRenderTarget();
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.setRenderTarget(hazeAtlas);
        renderer.render(bakeScene, bakeCamera);
        renderer.autoClear = autoClear;
        renderer.setRenderTarget(previous);
        const amounts = glowGeometry.attributes.aHazeAmount;
        amounts.array[clusters.indexOf(c)] = 0.28;
        amounts.needsUpdate = true;
        c.hazeBaked = true;
        return true;
    }

    // Glow: the light of the stars too faint to see one by one, plus any haze
    const n = clusters.length;
    const glowGeometry = new THREE.InstancedBufferGeometry();
    glowGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    glowGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    const glowData = {
        aCentre: new Float32Array(n * 3),
        aU: new Float32Array(n * 3),
        aV: new Float32Array(n * 3),
        aColour: new Float32Array(n * 3),
        aBandA: new Float32Array(n * 4),
        aBandB: new Float32Array(n),
        aKind: new Float32Array(n * 2),
        aRect: new Float32Array(n * 4),
        aHazeAmount: new Float32Array(n),
        aDepth: new Float32Array(n)
    };
    clusters.forEach((c, i) => {
        const { body } = c;
        // A real ball of stars is never quite round, and the glow follows the stars
        const { axis_ratio: ratio, pa_deg: pa } = body.cluster.shape;
        const { u, v } = quadAxes(c.basis, pa, worldHalfSize(body.cluster.radius_deg * 2 * GLOW_REACH));
        glowData.aCentre.set(c.unit.map((x) => x * SKY_RADIUS), i * 3);
        glowData.aU.set(u, i * 3);
        glowData.aV.set(c.globular ? v.map((x) => x * ratio) : v, i * 3);
        // The glow's colour is the light-weighted mean of the stars
        const mean = [0, 0, 0];
        let total = 0;
        body.cluster.members.forEach((m) => {
            const rgb = blackBodyRGB(m.star.teff_K);
            const L = Math.max(1e-3, m.star.luminosity_Lsun) ** 0.5;
            mean[0] += rgb[0] * L;
            mean[1] += rgb[1] * L;
            mean[2] += rgb[2] * L;
            total += L;
        });
        const peak = Math.max(...mean) || 1;
        // Globulars lean golden whatever their few members add up to: their unresolved stars are old
        const golden = c.globular ? [1, 0.74, 0.42] : [mean[0] / peak, mean[1] / peak, mean[2] / peak];
        glowData.aColour.set(golden, i * 3);
        const light = depthLight(body);
        glowData.aBandA.set([body.bands.radio * light, body.bands.ir * light, body.bands.visible * light, body.bands.uv * light], i * 4);
        glowData.aBandB[i] = body.bands.xray * light;
        glowData.aKind.set([c.globular ? 1 : 0, drawMag(body)], i * 2);
        glowData.aDepth[i] = body.depth;
        if (c.hazeIndex >= 0) {
            const x = (c.hazeIndex % hazeCols) * HAZE_TILE;
            const y = Math.floor(c.hazeIndex / hazeCols) * HAZE_TILE;
            glowData.aRect.set([(x + 1) / hazeAtlas.width, (y + 1) / hazeAtlas.height, (HAZE_TILE - 2) / hazeAtlas.width, (HAZE_TILE - 2) / hazeAtlas.height], i * 4);
        }
    });
    Object.entries({ aCentre: 3, aU: 3, aV: 3, aColour: 3, aBandA: 4, aBandB: 1, aKind: 2, aRect: 4, aHazeAmount: 1, aDepth: 1 }).forEach(([name, size]) => {
        glowGeometry.setAttribute(name, new THREE.InstancedBufferAttribute(glowData[name], size));
    });
    glowGeometry.instanceCount = n;
    const glowMaterial = skyMaterial({
        uniforms: { tHaze: { value: hazeAtlas.texture } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            ${REVEAL_GLSL}
            attribute vec3 aCentre;
            attribute vec3 aU;
            attribute vec3 aV;
            attribute vec3 aColour;
            attribute vec4 aBandA;
            attribute float aBandB;
            attribute vec2 aKind;
            attribute vec4 aRect;
            attribute float aHazeAmount;
            attribute float aDepth;
            varying vec2 vP;
            varying vec2 vUv;
            varying vec3 vColour;
            varying vec4 vBand;
            varying float vGlobular;
            varying float vHaze;
            varying float vResolved;
            varying float vSpread;
            void main() {
                vP = position.xy * ${GLOW_REACH.toFixed(2)};   // 1 at the cluster's radius
                vUv = aRect.xy + (position.xy * 0.5 + 0.5) * aRect.zw;
                vColour = aColour;
                vBand = vec4(aBandA.x, aBandA.y, aBandA.z * revealGain(aKind.y), aBandA.w);
                vGlobular = aKind.x;
                // Once the stars can be told apart they carry the cluster, and the glow eases back
                float px = length(aU) / ${SKY_RADIUS.toFixed(1)} * uPxPerRad * depthP(aDepth);
                vResolved = 1.0 - 0.45 * smoothstep(60.0, 400.0, px);
                // A little leftover gas, seen from afar. It's only ever a small cloud, and close to it would be a blur
                vHaze = aHazeAmount * (1.0 - smoothstep(70.0, 240.0, px));
                // While tiny, a broader glow is what makes it read as a ball and not a dot
                vSpread = 1.0 + 3.5 * (1.0 - smoothstep(8.0, 40.0, px));
                gl_Position = projectionMatrix * modelViewMatrix * vec4(aCentre + position.x * aU + position.y * aV, 1.0);
                gl_Position.xy *= depthP(aDepth);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            uniform sampler2D tHaze;
            varying vec2 vP;
            varying vec2 vUv;
            varying vec3 vColour;
            varying vec4 vBand;
            varying float vGlobular;
            varying float vHaze;
            varying float vResolved;
            varying float vSpread;
            void main() {
                float r = length(vP);
                float edge = 1.0 - smoothstep(0.72, ${GLOW_REACH.toFixed(2)}, r);
                // Open clusters are just their stars. Only a globular has so many that their light runs together:
                // a King profile, a dense core falling to nothing
                float light = 0.0;
                if (vGlobular > 0.5) {
                    const float rc = 0.16;
                    float a = 1.0 / sqrt(1.0 + r * r / (rc * rc)) - 1.0 / sqrt(1.0 + 1.8 / (rc * rc));
                    light = max(a, 0.0);
                    light = light * light * 0.95 * vResolved + light * 0.1 * vResolved * vSpread;
                }
                light *= edge;
                vec3 colour = vColour * light * vBand.z * uBandW[2]
                    + uBandTint[1] * uBandW[1] * light * vBand.y * 0.9
                    + uBandTint[3] * uBandW[3] * light * vBand.w * (vGlobular > 0.5 ? 0.12 : 1.4);
                if (vHaze > 0.0) {
                    vec4 t = texture2D(tHaze, vUv);
                    vec3 rgb = t.rgb * t.rgb;
                    float cloud = t.a * t.a;
                    colour += vHaze * (rgb * vBand.z * uBandW[2] * 0.42
                        + uBandTint[0] * uBandW[0] * cloud * vBand.x * 0.7
                        + uBandTint[1] * uBandW[1] * cloud * vBand.y * 0.55
                        + uBandTint[3] * uBandW[3] * rgb.b * vBand.w * 0.7);
                }
                gl_FragColor = vec4(colour * uSkyFade, 1.0);
            }`
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    glow.frustumCulled = false;
    glow.renderOrder = ORDER.clusters;
    scene.add(glow);

    // The unresolved stars of a globular, resolved at last when you zoom right in. Built the first time they're needed.
    const decorMaterial = skyMaterial({
        uniforms: { uFade: { value: 0 }, uDpr, uDepth: { value: 0 } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            uniform float uFade;
            uniform float uDpr;
            uniform float uDepth;
            attribute vec3 aColour;
            attribute float aLum;
            varying vec3 vColour;
            void main() {
                vec3 c = aColour * uBandW[2] + uBandTint[1] * uBandW[1] * aColour.r * 0.5 * (1.0 - aColour.b);
                vColour = c * aLum * uFade;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_Position.xy *= depthP(uDepth);
                gl_PointSize = (1.1 + 1.6 * sqrt(aLum)) * uDpr * clamp(pow(uPxPerRad * depthP(uDepth) / 8000.0, 0.25), 1.0, 1.8);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            varying vec3 vColour;
            void main() {
                vec2 c = (gl_PointCoord - 0.5) * 2.0;
                float d = dot(c, c);
                gl_FragColor = vec4(vColour * exp(-d * 3.5) * uSkyFade, 1.0);
            }`
    });

    function buildDecor(c) {
        const rng = new Rng(`globular:${c.body.visual_seed}`);
        const radius = c.body.cluster.radius_deg;
        const { axis_ratio: ratio, pa_deg: pa, core } = c.body.cluster.shape;
        const cosPa = Math.cos(pa * RAD);
        const sinPa = Math.sin(pa * RAD);
        const pos = new Float32Array(DECOR_MAX * 3);
        const col = new Float32Array(DECOR_MAX * 3);
        const lum = new Float32Array(DECOR_MAX);
        const rc = 0.17 * (core / 0.25);
        for (let i = 0; i < DECOR_MAX; i++) {
            // A Plummer sphere, seen from outside: it just thins out, with no edge to stop at
            let r;
            do {
                const u = rng.next();
                r = rc * Math.sqrt(1 / (u ** (-2 / 3) - 1 + 1e-6));
            } while (r > DECOR_REACH);
            const proj = r * Math.sqrt(1 - rng.next() ** 2);
            const ang = rng.range(0, Math.PI * 2);
            const a = proj * radius * Math.cos(ang);
            const b = proj * radius * Math.sin(ang) * ratio;
            const v = offsetVector(c.basis, a * cosPa - b * sinPa, a * sinPa + b * cosPa);
            pos.set([v[0] * SKY_RADIUS, v[1] * SKY_RADIUS, v[2] * SKY_RADIUS], i * 3);
            const kind = rng.next();
            const tint = kind < 0.72 ? [1, 0.8, 0.52] : kind < 0.9 ? [1, 0.92, 0.75] : [1, 0.55, 0.28];
            col.set(tint, i * 3);
            lum[i] = 0.1 + 0.9 * rng.next() ** 6;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geometry.setAttribute('aColour', new THREE.BufferAttribute(col, 3));
        geometry.setAttribute('aLum', new THREE.BufferAttribute(lum, 1));
        const material = decorMaterial.clone();
        material.uniforms = { ...decorMaterial.uniforms, uFade: { value: 0 }, uDpr, uDepth: { value: c.body.depth } };
        const points = new THREE.Points(geometry, material);
        points.frustumCulled = false;
        points.renderOrder = ORDER.clusters;
        scene.add(points);
        return { points, geometry, material };
    }

    // The highlight ring, for Go to: bus 'highlight' { code }
    const ringPosition = new Float32Array(3);
    const ringGeometry = new THREE.BufferGeometry();
    ringGeometry.setAttribute('position', new THREE.BufferAttribute(ringPosition, 3));
    const ringMaterial = skyMaterial({
        uniforms: { uDpr, uRadius: { value: RING_RADIUS_PX }, uDepth: { value: 0 } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            uniform float uDpr;
            uniform float uRadius;
            uniform float uDepth;
            void main() {
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_Position.xy *= depthP(uDepth);
                gl_PointSize = (uRadius * 2.0 + 6.0) * uDpr;
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            uniform float uDpr;
            uniform float uRadius;
            void main() {
                vec2 c = (gl_PointCoord - 0.5) * (uRadius * 2.0 + 6.0);
                float r = length(c);
                float pulse = 1.0 + 0.5 * uTwinkle * sin(uTime * 2.6);
                float wid = 1.1 + 0.25 * pulse;
                float ring = exp(-pow((r - uRadius) / wid, 2.0));
                // Four short ticks point in, so the mark doesn't depend on colour or on seeing a thin line
                float tickA = step(abs(c.x), 0.9) + step(abs(c.y), 0.9);
                float ticks = clamp(tickA, 0.0, 1.0) * step(uRadius - 6.0, r) * step(r, uRadius);
                gl_FragColor = vec4(vec3(0.9, 1.0, 0.95) * (ring + ticks) * 1.4 * uSkyFade, 1.0);
            }`
    });
    const ring = new THREE.Points(ringGeometry, ringMaterial);
    ring.frustumCulled = false;
    ring.renderOrder = ORDER.overlays - 1;
    ring.visible = false;
    scene.add(ring);
    let ringCode = null;

    function setRing(code) {
        const resolved = code ? app.universe.resolve(code) : null;
        if (!resolved || resolved.path !== 'member') {
            ring.visible = false;
            ringCode = null;
            return;
        }
        const basis = tangentBasis(resolved.body.sky.az, resolved.body.sky.alt);
        const v = offsetVector(basis, resolved.entity.offset_deg.x, resolved.entity.offset_deg.y);
        ringPosition[0] = v[0] * SKY_RADIUS;
        ringPosition[1] = v[1] * SKY_RADIUS;
        ringPosition[2] = v[2] * SKY_RADIUS;
        ringGeometry.attributes.position.needsUpdate = true;
        ringMaterial.uniforms.uDepth.value = resolved.entity.depth;
        ring.visible = true;
        ringCode = resolved.entity.code;
    }

    const unsubscribe = [
        bus.on('highlight', ({ code }) => setRing(code)),
        bus.on('deselect', () => setRing(null)),
        bus.on('select', ({ code }) => { if (code !== ringCode) setRing(null); }),
        // The haze went with the context: back to none, until it has baked again
        bus.on('gl-restored', () => {
            const amounts = glowGeometry.attributes.aHazeAmount;
            hazy.forEach((c) => {
                c.hazeBaked = false;
                amounts.array[clusters.indexOf(c)] = 0;
            });
            amounts.needsUpdate = true;
            hazeStep.next = 0;
            if (hazy.length) compileHaze();
        })
    ];

    const forward = new THREE.Vector3();
    const layer = {
        id: 'clusters',
        update(frame) {
            uDpr.value = frame.dpr;
            if (app.view === 'sky') bakeNextHaze();
            frame.camera.getWorldDirection(forward);
            const pxPerDeg = frame.pxPerRad * RAD;
            const count = DECOR_STARS[frame.quality] || DECOR_STARS.medium;
            const halfView = Math.hypot(frame.fov, (frame.fov * frame.width) / frame.height) * 0.5;
            for (let i = 0; i < n; i++) {
                const c = clusters[i];
                if (!c.globular) continue;
                const radiusPx = c.body.cluster.radius_deg * pxPerDeg * parallaxFactor(c.body.depth, frame.fov);
                const near = radiusPx > 34;
                if (!near) {
                    if (c.decor) c.decor.points.visible = false;
                    continue;
                }
                const dot = c.unit[0] * forward.x + c.unit[1] * forward.y + c.unit[2] * forward.z;
                const off = Math.acos(Math.max(-1, Math.min(1, dot))) / RAD;
                if ((off - c.body.cluster.radius_deg * DECOR_REACH) * parallaxFactor(c.body.depth, frame.fov) > halfView) {
                    if (c.decor) c.decor.points.visible = false;
                    continue;
                }
                if (!c.decor) c.decor = buildDecor(c);
                c.decor.points.visible = true;
                c.decor.geometry.setDrawRange(0, count);
                c.decor.material.uniforms.uFade.value = Math.min(1, (radiusPx - 34) / 120);
            }
        },

        // Every point drawn answers a click. A member stands for itself once the cluster has opened out and it's clear of
        // its neighbours, and until then for the cluster, so the cluster's own reach is as far as its strays.
        picks(frame) {
            const out = [];
            const { band } = app;
            const lim = limitingMag(frame.fov);
            frame.camera.getWorldDirection(forward);
            const halfView = Math.hypot(frame.fov, (frame.fov * frame.width) / frame.height) * 0.5;
            // How far apart two members must be: a good aim at the deepest zoom, a little more room before that
            const apart = APART_DEEP_PX + (APART_PX - APART_DEEP_PX) * smoothstep(MIN_FOV * 1.5, MIN_FOV * 6, frame.fov);
            clusters.forEach((c) => {
                const { body } = c;
                const { depth } = body;
                const radius = body.cluster.radius_deg;
                const scale = parallaxFactor(depth, frame.fov);
                const dot = c.unit[0] * forward.x + c.unit[1] * forward.y + c.unit[2] * forward.z;
                const off = Math.acos(Math.max(-1, Math.min(1, dot))) / RAD;
                if ((off - radius * 3.5) * scale > halfView) return;

                const pxPerDeg = (frame.pxPerRad * RAD * scale) / frame.dpr;
                const radiusPx = radius * pxPerDeg;
                const opened = radiusPx >= OPENS_PX;
                const room = c.areaPerMember * pxPerDeg * pxPerDeg;
                const spread = Math.max(0.12, Math.min(1, room / 10));
                const smudge = c.globular ? 0 : (1 - smoothstep(SMUDGE_FROM_PX2, SMUDGE_TO_PX2, room))
                    * Math.max(0.2, Math.min(1, room / SMUDGE_STACKED_PX2)) * SMUDGE_LIGHT * revealGain(drawMag(body), lim);
                const farOff = FAR_OFF_LIGHT + (1 - FAR_OFF_LIGHT) * smoothstep(FAR_OFF_PX[0], FAR_OFF_PX[1], pxPerDeg);
                if (!c.table) c.table = pickTable(body, bandA, bandB, memberBoost, c.firstMember);
                let any = false;
                c.table.forEach((m) => {
                    let light;
                    if (band === 'visible') light = Math.max(memberLight(lim - m.mag) * m.starLight * farOff, smudge) * m.visible;
                    else if (band === 'ir' || band === 'uv') light = m[band] * (0.5 + 0.5 * spread) * 2.2;
                    else light = m[band] * (band === 'xray' ? 3 : 1);
                    if (light < DRAWN_PEAK) return;
                    any = true;
                    const own = opened && light >= SEEN_PEAK && m.nearestDeg * pxPerDeg >= apart;
                    out.push(own
                        ? { code: m.code, az: m.az, alt: m.alt, radiusPx: MEMBER_REACH_PX, depth: m.depth }
                        : { code: body.code, az: m.az, alt: m.alt, radiusPx: 0, depth: m.depth });
                });
                if (any && !opened) out.push({ code: body.code, az: body.sky.az, alt: body.sky.alt, radiusPx: 0, depth });
                // A globular's fainter stars have no codes of their own, and run out past its radius
                if (c.decor && c.decor.points.visible) {
                    out.push({ code: body.code, az: body.sky.az, alt: body.sky.alt, radiusPx: radiusPx * DECOR_REACH, depth });
                }
            });
            return out;
        },

        idle() {
            return hazeStep.next >= hazy.length;
        },

        dispose() {
            unsubscribe.forEach((off) => off());
            clusters.forEach((c) => {
                if (!c.decor) return;
                scene.remove(c.decor.points);
                c.decor.geometry.dispose();
                c.decor.material.dispose();
            });
            [members, glow, ring].forEach((m) => {
                scene.remove(m);
                m.geometry.dispose();
                m.material.dispose();
            });
            bakeQuad.geometry.dispose();
            hazeBakeMaterial.dispose();
            decorMaterial.dispose();
            hazeAtlas.dispose();
        }
    };
    return layer;
}
