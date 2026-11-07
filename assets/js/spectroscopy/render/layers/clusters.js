// Star clusters. Every member is a real point at its own place in the sky, coloured by its own temperature, so a
// cluster's H-R diagram and its look agree: red giants stand out in a globular, blue stars in a young open cluster.
// Members can be picked once zoom has spread them out. What can't be picked is decoration that makes a cluster
// read as a cluster: the unresolved glow, the thousands of fainter stars in a globular, and leftover nebula haze.

import * as THREE from 'three';
import { bus } from '../../core/state.js';
import { Rng, hashString } from '../../core/rng.js';
import { blackBodyRGB, planck, SIGMA } from '../../core/phys.js';
import { limitingMag } from '../../core/sky.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { SKY_RADIUS, tangentBasis, offsetVector, quadAxes, worldHalfSize, memberDirection, scatterPicks, revealGain, REVEAL_GLSL } from './sky_tangent.js';

const RAD = Math.PI / 180;
const HAZE_TILE = 128;
const GLOW_REACH = 1.35;            // The glow's quad reaches this many cluster radii from the centre
const DECOR_STARS = { low: 1500, medium: 3500, high: 7000 };
const DECOR_MAX = DECOR_STARS.high;
const MIN_PICK_SEPARATION_PX = 9;   // Members can be picked when typically this far apart on screen
const RING_RADIUS_PX = 20;

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

function medianNeighbourDeg(members) {
    const gaps = members.map((a) => {
        let best = Infinity;
        members.forEach((b) => {
            if (a === b) return;
            const d = Math.hypot(a.offset_deg.x - b.offset_deg.x, a.offset_deg.y - b.offset_deg.y);
            if (d < best) best = d;
        });
        return best;
    }).sort((x, y) => x - y);
    return gaps[Math.floor(gaps.length / 2)] || 1;
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
    const clusterInfo = new Float32Array(memberCount * 2); // The cluster's magnitude, and its sky area per member
    let w = 0;
    clusters.forEach((c) => {
        const { body } = c;
        const { members, radius_deg: radius } = body.cluster;
        const brightest = members.reduce((m, s) => Math.min(m, s.brightness.mag), Infinity);
        const areaPerMember = (Math.PI * radius * radius) / Math.max(1, members.length) / (c.globular ? 5 : 1);
        members.forEach((member) => {
            const v = offsetVector(c.basis, member.offset_deg.x, member.offset_deg.y);
            positions.set([v[0] * SKY_RADIUS, v[1] * SKY_RADIUS, v[2] * SKY_RADIUS], w * 3);
            const T = member.star.teff_K;
            colours.set(blackBodyRGB(T), w * 3);
            const L = member.star.luminosity_Lsun;
            const shares = bandShares(T);
            // Visible follows magnitude, relative to the cluster's brightest, gently compressed so all of them show
            const visible = Math.max(0.1, 10 ** (-0.4 * 0.3 * (member.brightness.mag - brightest)));
            const isXray = c.xray.has(member.code);
            const youngCorona = !c.globular && T < 6500 && body.cluster.age_Myr < 150;
            bandA.set([
                body.bands.radio * 0.2,
                squeeze(L * shares.ir, REF_IR) * body.bands.ir,
                visible * body.bands.visible,
                squeeze(L * shares.uv, REF_UV) * body.bands.uv
            ], w * 4);
            bandB[w] = isXray ? Math.max(0.5, body.bands.xray) : (youngCorona ? 0.25 : 0.03) * body.bands.xray;
            clusterInfo.set([body.brightness.mag, areaPerMember], w * 2);
            w++;
        });
    });
    const memberGeometry = new THREE.BufferGeometry();
    memberGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    memberGeometry.setAttribute('aColour', new THREE.BufferAttribute(colours, 3));
    memberGeometry.setAttribute('aBandA', new THREE.BufferAttribute(bandA, 4));
    memberGeometry.setAttribute('aBandB', new THREE.BufferAttribute(bandB, 1));
    memberGeometry.setAttribute('aInfo', new THREE.BufferAttribute(clusterInfo, 2));
    const memberMaterial = skyMaterial({
        uniforms: { uDpr },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            ${REVEAL_GLSL}
            uniform float uDpr;
            attribute vec3 aColour;
            attribute vec4 aBandA;
            attribute float aBandB;
            attribute vec2 aInfo;
            varying vec3 vColour;
            void main() {
                float pxPerDeg = uPxPerRad * 0.0174533;
                float gain = revealGain(aInfo.x);
                // Stars crowded on screen share their light, so a tiny globular glows gold instead of burning white
                float crowd = clamp(aInfo.y * pxPerDeg * pxPerDeg / (10.0 * uDpr * uDpr), 0.12, 1.0);
                float zoom = clamp(pow(pxPerDeg / 8.0, 0.3), 1.0, 3.2);
                // Crowded stars also lean on their brightest few, which keeps a small cluster from reading as noise
                float visible = pow(aBandA.z, mix(2.2, 1.0, crowd)) * gain * uBandW[2];
                float strong = visible * mix(0.5, 1.9, crowd);
                float grey = dot(aColour, vec3(0.3, 0.55, 0.15));
                vec3 c = max(mix(vec3(grey), aColour, 1.3), 0.0) * strong
                    + uBandTint[0] * uBandW[0] * aBandA.x
                    + uBandTint[1] * uBandW[1] * aBandA.y * mix(0.5, 1.0, crowd) * 2.2
                    + uBandTint[3] * uBandW[3] * aBandA.w * mix(0.5, 1.0, crowd) * 2.2
                    + uBandTint[4] * uBandW[4] * aBandB * 3.0;
                float peak = max(c.r, max(c.g, c.b));
                vColour = c;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                // Size rises with brightness; points fainter than a pixel dim instead of shrinking, so they don't shimmer
                float size = (1.3 + 2.6 * sqrt(min(peak, 2.0))) * zoom * uDpr;
                gl_PointSize = peak < 0.004 ? 0.0 : size;
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
                for (int i = 0; i < 6; i++) {
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
    const hazeStep = { next: 0 };

    function bakeNextHaze() {
        if (hazeStep.next >= hazy.length) return false;
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
        aHazeAmount: new Float32Array(n)
    };
    clusters.forEach((c, i) => {
        const { body } = c;
        const { u, v } = quadAxes(c.basis, 0, worldHalfSize(body.cluster.radius_deg * 2 * GLOW_REACH));
        glowData.aCentre.set(c.unit.map((x) => x * SKY_RADIUS), i * 3);
        glowData.aU.set(u, i * 3);
        glowData.aV.set(v, i * 3);
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
        glowData.aBandA.set([body.bands.radio, body.bands.ir, body.bands.visible, body.bands.uv], i * 4);
        glowData.aBandB[i] = body.bands.xray;
        glowData.aKind.set([c.globular ? 1 : 0, body.brightness.mag], i * 2);
        if (c.hazeIndex >= 0) {
            const x = (c.hazeIndex % hazeCols) * HAZE_TILE;
            const y = Math.floor(c.hazeIndex / hazeCols) * HAZE_TILE;
            glowData.aRect.set([(x + 1) / hazeAtlas.width, (y + 1) / hazeAtlas.height, (HAZE_TILE - 2) / hazeAtlas.width, (HAZE_TILE - 2) / hazeAtlas.height], i * 4);
        }
    });
    Object.entries({ aCentre: 3, aU: 3, aV: 3, aColour: 3, aBandA: 4, aBandB: 1, aKind: 2, aRect: 4, aHazeAmount: 1 }).forEach(([name, size]) => {
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
                vHaze = aHazeAmount;
                // Once the stars can be told apart they carry the cluster, and the glow eases back
                float px = length(aU) / ${SKY_RADIUS.toFixed(1)} * uPxPerRad;
                vResolved = 1.0 - 0.45 * smoothstep(60.0, 400.0, px);
                // While tiny, a broader glow is what makes it read as a ball and not a dot
                vSpread = 1.0 + 3.5 * (1.0 - smoothstep(8.0, 40.0, px));
                gl_Position = projectionMatrix * modelViewMatrix * vec4(aCentre + position.x * aU + position.y * aV, 1.0);
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
                float light;
                if (vGlobular > 0.5) {
                    // A King profile: a dense core falling to nothing at the cluster's edge
                    const float rc = 0.16;
                    float a = 1.0 / sqrt(1.0 + r * r / (rc * rc)) - 1.0 / sqrt(1.0 + 1.8 / (rc * rc));
                    light = max(a, 0.0);
                    light = light * light * 0.95 * vResolved + light * 0.1 * vResolved * vSpread;
                } else {
                    light = 0.004 * exp(-r * r * 2.2);
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
        uniforms: { uFade: { value: 0 }, uDpr },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            uniform float uFade;
            uniform float uDpr;
            attribute vec3 aColour;
            attribute float aLum;
            varying vec3 vColour;
            void main() {
                vec3 c = aColour * uBandW[2] + uBandTint[1] * uBandW[1] * aColour.r * 0.5 * (1.0 - aColour.b);
                vColour = c * aLum * uFade;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = (1.1 + 1.6 * sqrt(aLum)) * uDpr * clamp(pow(uPxPerRad / 8000.0, 0.25), 1.0, 1.8);
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
        const pos = new Float32Array(DECOR_MAX * 3);
        const col = new Float32Array(DECOR_MAX * 3);
        const lum = new Float32Array(DECOR_MAX);
        const rc = 0.17;
        for (let i = 0; i < DECOR_MAX; i++) {
            // A Plummer sphere, seen from outside and cut at the cluster's edge
            let r;
            do {
                const u = rng.next();
                r = rc * Math.sqrt(1 / (u ** (-2 / 3) - 1 + 1e-6));
            } while (r > 1);
            const proj = r * Math.sqrt(1 - rng.next() ** 2);
            const ang = rng.range(0, Math.PI * 2);
            const v = offsetVector(c.basis, proj * radius * Math.cos(ang), proj * radius * Math.sin(ang));
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
        material.uniforms = { ...decorMaterial.uniforms, uFade: { value: 0 }, uDpr };
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
        uniforms: { uDpr, uRadius: { value: RING_RADIUS_PX } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            uniform float uDpr;
            uniform float uRadius;
            void main() {
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
        ring.visible = true;
        ringCode = resolved.entity.code;
    }

    const unsubscribe = [
        bus.on('highlight', ({ code }) => setRing(code)),
        bus.on('deselect', () => setRing(null)),
        bus.on('select', ({ code }) => { if (code !== ringCode) setRing(null); })
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
                const radiusPx = c.body.cluster.radius_deg * pxPerDeg;
                const near = radiusPx > 34;
                if (!near) {
                    if (c.decor) c.decor.points.visible = false;
                    continue;
                }
                const dot = c.unit[0] * forward.x + c.unit[1] * forward.y + c.unit[2] * forward.z;
                const off = Math.acos(Math.max(-1, Math.min(1, dot))) / RAD;
                if (off > halfView + c.body.cluster.radius_deg) {
                    if (c.decor) c.decor.points.visible = false;
                    continue;
                }
                if (!c.decor) c.decor = buildDecor(c);
                c.decor.points.visible = true;
                c.decor.geometry.setDrawRange(0, count);
                c.decor.material.uniforms.uFade.value = Math.min(1, (radiusPx - 34) / 120);
            }
        },

        // Members only when they're far enough apart to tell one from another; otherwise the cluster as a whole
        picks(frame) {
            const out = [];
            const pxPerDeg = (frame.pxPerRad * RAD) / frame.dpr;
            const lim = limitingMag(frame.fov);
            const step = 30 / pxPerDeg;
            clusters.forEach((c) => {
                const { body } = c;
                const strength = body.bands[app.band] || 0;
                if (strength <= 0.01) return;
                if (app.band === 'visible' && revealGain(body.brightness.mag, lim) < 0.03) return;
                const radius = body.cluster.radius_deg;
                if (!c.separationDeg) c.separationDeg = medianNeighbourDeg(body.cluster.members);
                if (c.separationDeg * pxPerDeg >= MIN_PICK_SEPARATION_PX) {
                    body.cluster.members.forEach((member) => {
                        const { az, alt } = memberSkyDirection(body, member);
                        out.push({ code: member.code, az, alt, radiusPx: 6 });
                    });
                } else if (radius * pxPerDeg > 14) {
                    scatterPicks(out, body.code, c.basis, 0, radius, radius, step);
                } else {
                    // Drawn even where a star this faint wouldn't be, so it must be clickable too
                    out.push({ code: body.code, az: body.sky.az, alt: body.sky.alt, radiusPx: 0 });
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
