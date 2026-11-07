// A star up close: animated granulation, limb darkening, starspots and a corona. Temperature and stage decide the
// look; the code's seed only moves the pattern. All of it is HDR, so the engine's tone mapping and bloom apply.
//
//   const star = createStar(starData, { seed, quality });
//   star.group is added to the scene; star.setRadius(r); star.update(state); star.dispose();

import * as THREE from 'three';
import { blackBodyRGB } from '../../core/phys.js';
import { hashString, Rng } from '../../core/rng.js';
import { sharedUniforms, BAND_GLSL } from '../shared.js';

// IQ's fast value noise needs a texture whose green channel is its red channel shifted by (37, 17)
let noiseTexture = null;
export function getNoiseTexture() {
    if (noiseTexture) return noiseTexture;
    const n = 256;
    const rng = new Rng('system-noise');
    const r = new Uint8Array(n * n);
    const data = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) r[i] = Math.floor(rng.next() * 256);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const i = (y * n + x) * 4;
            data[i] = r[y * n + x];
            data[i + 1] = r[((y - 17 + n) % n) * n + ((x - 37 + n) % n)];
            data[i + 2] = Math.floor(rng.next() * 256);
            data[i + 3] = Math.floor(rng.next() * 256);
        }
    }
    noiseTexture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    noiseTexture.wrapS = THREE.RepeatWrapping;
    noiseTexture.wrapT = THREE.RepeatWrapping;
    noiseTexture.minFilter = THREE.LinearFilter;
    noiseTexture.magFilter = THREE.LinearFilter;
    noiseTexture.needsUpdate = true;
    return noiseTexture;
}

export const NOISE_GLSL = /* glsl */`
uniform sampler2D tNoise;
float vnoise(vec3 x) {
    vec3 p = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    vec2 uv = p.xy + vec2(37.0, 17.0) * p.z + f.xy;
    vec2 rg = texture2D(tNoise, (uv + 0.5) / 256.0).yx;
    return mix(rg.x, rg.y, f.z);
}
float fbm3(vec3 p) {
    return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.2 * vnoise(p * 4.01 + 3.7);
}
`;

const SURFACE_VERTEX = /* glsl */`
uniform vec3 uTideAxis;     // Unit vector towards the partner
uniform float uTide;        // How far the star is stretched along it
uniform float uCusp;        // The point a Roche-lobe-filling star draws out towards its partner
uniform float uLumps;       // Giants aren't quite round
uniform sampler2D tNoise;
uniform vec3 uSeed;
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vWorldN;
void main() {
    vec3 n = normalize(position);
    float c = dot(n, uTideAxis);
    float r = 1.0 + uTide * (1.5 * c * c - 0.5) + uCusp * pow(max(c, 0.0), 7.0);
    if (uLumps > 0.0) {
        // A few texels across the whole star, so the bilinear filter makes broad swells rather than a jagged edge
        vec2 uv = n.xz * 2.2 + n.y * vec2(2.6, 1.7) + floor(uSeed.xy);
        r += uLumps * (texture2D(tNoise, uv / 256.0).r - 0.5);
    }
    vN = n;
    vec4 world = modelMatrix * vec4(n * r, 1.0);
    vWorld = world.xyz;
    // The stretch barely turns the normal away from the sphere's, except near the cusp where nobody can tell
    vWorldN = normalize(n + uTideAxis * (uTide * 1.5 * c + 0.0) * -0.8);
    gl_Position = projectionMatrix * viewMatrix * world;
}`;

const SURFACE_FRAGMENT = /* glsl */`
${BAND_GLSL}
${NOISE_GLSL}
uniform vec3 uColour;
uniform vec3 uLimbColour;
uniform vec3 uSpotColour;
uniform vec3 uSeed;
uniform float uAnim;        // Seconds of surface motion; stands still with Reduce motion
uniform float uRot;         // Rotation angle at the equator (radians)
uniform float uBoil;
uniform float uCellScale;
uniform float uCellSoft;
uniform float uContrast;
uniform float uSuper;       // Large-scale mottling
uniform float uGrainBody;   // 0: bright cells with dark lanes between. 1: soft swells with no lanes
uniform float uSpots;       // 0 to 1: the share of grid cells holding a spot
uniform float uSpotFreq;    // Spots per star radius, roughly
uniform float uSpotLat;     // How far from the equator spots can sit
uniform float uLimbU;
uniform float uLimbV;
uniform float uIntensity;
uniform float uBandStrength;
uniform float uReveal;
uniform float uDetail;      // Surface patterns fade out when too small on screen to do anything but shimmer
uniform float uSpotDetail;
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vWorldN;

#if QUALITY >= 1
// The nearest of a jittered grid: f1, f2 to the two closest points. Each point wanders, so the cells boil.
vec2 cells(vec3 p, float boil) {
    vec3 ip = floor(p - 0.5);
    vec3 fp = p - ip;
    float f1 = 9.0;
    float f2 = 9.0;
    for (int k = 0; k < 2; k++) {
        for (int j = 0; j < 2; j++) {
            for (int i = 0; i < 2; i++) {
                vec3 o = vec3(float(i), float(j), float(k));
                vec3 c = ip + o;
                vec4 h = texture2D(tNoise, (c.xy + c.z * vec2(37.0, 17.0) + 0.5) / 256.0);
                vec3 d = o + 0.5 + 0.42 * sin(boil + 6.2831 * h.rba) - fp;
                float q = dot(d, d);
                if (q < f1) {
                    f2 = f1;
                    f1 = q;
                } else if (q < f2) {
                    f2 = q;
                }
            }
        }
    }
    return sqrt(vec2(f1, f2));
}
#endif

// Round spots on a sparse jittered grid: positive inside a spot, 1 at its centre, 0 at its rim, negative beyond
float spotField(vec3 p, float amount) {
    vec3 ip = floor(p - 0.5);
    vec3 fp = p - ip;
    float best = -1.0;
    for (int k = 0; k < 2; k++) {
        for (int j = 0; j < 2; j++) {
            for (int i = 0; i < 2; i++) {
                vec3 o = vec3(float(i), float(j), float(k));
                vec3 c = ip + o + 31.0;
                vec4 h = texture2D(tNoise, (c.xy + c.z * vec2(37.0, 17.0) + 0.5) / 256.0);
                float size = (h.b - (1.0 - amount)) / max(amount, 0.01);
                if (size <= 0.0) continue;
                vec3 d = o + 0.5 + 0.8 * (h.rag - 0.5) - fp;
                best = max(best, 1.0 - length(d) / (0.09 + 0.2 * size));
            }
        }
    }
    return best;
}

void main() {
    vec3 N = normalize(vN);
    vec3 V = normalize(cameraPosition - vWorld);
    float mu = clamp(dot(normalize(vWorldN), V), 0.0, 1.0);

    // The equator turns a little faster than the poles, as the Sun's does
    float a = uRot * (1.0 - 0.2 * N.y * N.y);
    float ca = cos(a);
    float sa = sin(a);
    vec3 P = vec3(ca * N.x + sa * N.z, N.y, -sa * N.x + ca * N.z) + uSeed;

    vec3 q = P * uCellScale;
    float slow = uAnim * uBoil;
    q += (vec3(vnoise(q * 0.6 + 11.0), vnoise(q * 0.6 + 23.0), vnoise(q * 0.6 + 37.0)) - 0.5) * 0.9;

#if QUALITY >= 1
    vec2 f = cells(q, slow);
    float lanes = smoothstep(0.0, uCellSoft, f.y - f.x);
    float body = smoothstep(0.95, 0.05, f.x);
    float grain = mix(lanes * 0.72 + body * 0.28, body, uGrainBody);
#else
    // Low quality: ridged noise instead of true cells
    float n0 = vnoise(q * 1.4 + vec3(0.0, 0.0, slow * 0.4));
    float grain = 1.0 - abs(2.0 * n0 - 1.0);
    grain = smoothstep(0.1, 0.95, grain);
#endif

    float mott = fbm3(P * uCellScale * 0.23 + vec3(0.0, slow * 0.08, 0.0));
    float bright = 1.0 + uDetail * uContrast * (grain - 0.55) + mix(0.3, 1.0, uDetail) * uSuper * (mott - 0.5);

#if QUALITY >= 2
    bright += uDetail * uContrast * 0.22 * (vnoise(q * 3.7 + slow * 0.3) - 0.5);
#endif

    vec3 colour = uColour;

    // Starspots: dark centres inside a less dark edge, in bands either side of the equator
    if (uSpots > 0.0 && uSpotDetail > 0.0) {
        float band = uSpotDetail * (1.0 - smoothstep(uSpotLat * 0.7, uSpotLat, abs(N.y)));
        vec3 sp = P * uSpotFreq + (vec3(vnoise(P * 19.0), vnoise(P * 19.0 + 9.0), vnoise(P * 19.0 + 17.0)) - 0.5) * 0.16;
        float s = spotField(sp, uSpots);
        float penumbra = smoothstep(0.0, 0.22, s) * band;
        float umbra = smoothstep(0.3, 0.55, s) * band;
        colour = mix(colour, uSpotColour, penumbra * 0.6);
        bright *= 1.0 - penumbra * 0.38 - umbra * 0.5;
        bright *= 1.0 + 0.16 * smoothstep(-0.55, -0.02, s) * (1.0 - penumbra) * band; // Bright faculae round them
    }

    // Limb darkening: the edge is seen higher up, where the gas is cooler and dimmer
    float m1 = 1.0 - mu;
    float limb = 1.0 - uLimbU * m1 - uLimbV * m1 * m1;
    colour = mix(uLimbColour, colour, smoothstep(0.0, 0.75, mu));

    vec3 c = bandColour(colour) * uBandStrength;
    gl_FragColor = vec4(c * max(bright, 0.05) * limb * uIntensity * uReveal, 1.0);
}`;

const CORONA_VERTEX = /* glsl */`
varying vec3 vWorld;
varying vec2 vQ;
void main() {
    vQ = position.xy;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
}`;

const CORONA_FRAGMENT = /* glsl */`
${BAND_GLSL}
${NOISE_GLSL}
uniform vec3 uCentre;
uniform float uRadius;
uniform float uRmax;
uniform vec3 uColour;
uniform vec3 uLimbColour;
uniform float uQuad;        // Half the quad's width, in star radii
uniform float uAnim;
uniform float uA1;
uniform float uH1;
uniform float uA2;
uniform float uH2;
uniform float uTurb;
uniform float uFlow;
uniform float uFreq;
uniform float uSpike;
uniform float uBandStrength;
uniform float uReveal;
uniform vec3 uSeed;
varying vec3 vWorld;
varying vec2 vQ;
void main() {
    // Closest approach of this pixel's ray to the star's centre, in star radii. A plane through the centre would
    // misjudge the star's edge when the camera is close.
    vec3 D = normalize(vWorld - cameraPosition);
    float r = length(cross(uCentre - cameraPosition, D)) / uRadius;
    float x = max(r - 1.0, 0.0);
    float ang = atan(vQ.y, vQ.x);
    vec3 ring = vec3(cos(ang), sin(ang), 0.0);

    // Streamers: noise round the limb that drifts outward. The ring makes it wrap with no seam
    vec3 sp = ring * uFreq + vec3(uSeed.xy, x * 0.9 - uAnim * uFlow);
    float n = fbm3(sp);
    float n2 = vnoise(ring * uFreq * 3.1 + vec3(uSeed.yz, x * 2.4 - uAnim * uFlow * 1.7));
    float broad = vnoise(ring * 1.3 + vec3(uSeed.zx, uAnim * uFlow * 0.25));
    float streak = n * 0.62 + n2 * 0.18 + broad * 0.2;
    float shape = mix(1.0, smoothstep(0.26, 0.74, streak) * 2.2, uTurb);

    float glow = uA1 * exp(-x / uH1) + uA2 * exp(-x / uH2) * shape;

    // White dwarfs: a thin, hard cross of diffraction on top of the glow
    if (uSpike > 0.0) {
        vec2 q = abs(vQ) * uQuad;
        glow += uSpike * (exp(-q.x * 7.0) * exp(-q.y * 1.1) + exp(-q.y * 7.0) * exp(-q.x * 1.1));
    }

    glow *= 1.0 - smoothstep(uRmax * 0.55, uRmax * 0.98, r);
    vec3 tint = mix(uLimbColour, uColour, smoothstep(0.0, 0.6, x));
    gl_FragColor = vec4(bandColour(tint) * glow * uBandStrength * uReveal, 1.0);
}`;

// A bright dot of constant size on screen: the star as the sky shows it, before it has any surface to see
const GLOW_VERTEX = /* glsl */`
uniform float uPx;
void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    gl_PointSize = uPx;
}`;
const GLOW_FRAGMENT = /* glsl */`
${BAND_GLSL}
uniform vec3 uColour;
uniform float uGlow;
uniform float uSharp;
void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float g = exp(-r * r * uSharp) + 0.25 * exp(-r * r * uSharp * 0.25);
    g *= 1.0 - smoothstep(0.75, 1.0, r);
    gl_FragColor = vec4(bandColour(uColour) * g * uGlow, 1.0);
}`;

// How bright the disc is before tone mapping. Any brighter and the colour and the granulation both wash out to white;
// the corona and the engine's bloom carry the glare instead.
function surfaceBrightness(T) {
    if (T < 5800) return 0.72 + (0.12 * (Math.max(T, 2400) - 2400)) / 3400;
    return 0.84 + (1.4 * (Math.min(T, 50000) - 5800)) / 44200;
}

// Extra saturation, for the same reason: the tone curve pales whatever it compresses. A true G star's black-body colour
// is nearly white, so cool stars need the most help to read as yellow, orange and red.
function surfaceColour(T) {
    const k = 2.7 - 1.4 * Math.min(1, Math.max(0, (T - 6000) / 2000));
    return blackBodyRGB(T).map((c) => c ** k);
}

// What a star of this temperature and stage looks like. Everything else about the shader is fixed.
export function starLook(star) {
    const T = star.teff_K;
    const stage = star.stage || 'main_sequence';
    const hot = Math.min(1, Math.max(0, (T - 7500) / 22500));   // 0 at A/F, 1 at the hottest O stars
    const warm = Math.min(1, Math.max(0, (6800 - T) / 3000));   // 0 at F, 1 at mid-M
    const giant = stage === 'giant' || stage === 'supergiant';
    const look = {
        cellScale: 30 - warm * 9,
        cellSoft: 0.5,
        grainBody: 0,
        contrast: 0.44 - hot * 0.2,
        super: 0.3,
        boil: 0.45 + hot * 0.7,
        spots: warm > 0.08 ? 0.12 + warm * 0.5 : 0,
        spotFreq: 4.8 - warm * 1.6,
        spotLat: 0.42 + warm * 0.4,
        limbU: 0.5 - hot * 0.18,
        limbV: 0.12 - hot * 0.05,
        lumps: 0,
        intensity: surfaceBrightness(T),
        spin: 0.05,
        corona: {
            a1: 0.42, h1: 0.05 + hot * 0.06,
            a2: 0.16 + hot * 0.62, h2: 0.3 + hot * 0.3,
            turb: 0.35 + hot * 0.6,
            flow: 0.05 + hot * 0.16,
            freq: 3 + hot * 3,
            rmax: 3.4 + hot * 1.8,
            spike: 0
        },
        glowSharp: 7
    };
    if (giant) {
        const big = stage === 'supergiant' ? 1 : 0.6;
        const red = T < 5500;
        look.cellScale = 4.6 - big * 2;
        look.cellSoft = 0.8;
        look.grainBody = red ? 0.7 : 0.4;
        look.contrast = red ? 0.62 : 0.3;
        look.super = red ? 0.42 : 0.2;
        look.boil = red ? 0.14 : 0.5;
        look.spots = 0;
        look.limbU = red ? 0.42 : 0.36;
        look.limbV = red ? 0.14 : 0.1;
        look.lumps = red ? 0.05 : 0;
        look.spin = 0.012;
        // A red giant's edge just thins out: the first glow outside matches the dim limb inside
        look.corona.a1 = red ? 0.46 : 0.5;
        look.corona.h1 = red ? 0.2 : 0.09;
        look.corona.a2 = red ? 0.1 : 0.55;
        look.corona.h2 = red ? 0.6 : 0.55;
        look.corona.turb = red ? 0.25 : 0.9;
        look.corona.flow = red ? 0.02 : 0.14;
        look.corona.rmax = red ? 3.0 : 4.2;
        look.intensity = surfaceBrightness(T);
    }
    if (stage === 'white_dwarf') {
        look.cellScale = 90;
        look.contrast = 0.05;
        look.super = 0.04;
        look.boil = 0;
        look.spots = 0;
        look.limbU = 0.25;
        look.limbV = 0;
        look.intensity = 7 + Math.min(1, T / 40000) * 11;
        look.spin = 0;
        look.corona = { a1: 2.6, h1: 0.14, a2: 0.34, h2: 0.42, turb: 0, flow: 0, freq: 3, rmax: 4.4, spike: 0.9 };
        look.glowSharp = 22;
    }
    return look;
}

// Shared across every star, so entering a second system doesn't recompile anything
const sphereGeometries = new Map();
function sphereFor(quality) {
    const key = quality === 'low' ? 'low' : 'hi';
    if (!sphereGeometries.has(key)) {
        sphereGeometries.set(key, key === 'low' ? new THREE.SphereGeometry(1, 40, 28) : new THREE.SphereGeometry(1, 72, 52));
    }
    return sphereGeometries.get(key);
}
const quadGeometry = new THREE.PlaneGeometry(2, 2);
const qualityDefine = (q) => (q === 'low' ? 0 : q === 'high' ? 2 : 1);

export function createStar(starData, opts = {}) {
    const look = starLook(starData);
    const rng = new Rng(hashString(opts.seed || 'star'));
    const seed = new THREE.Vector3(rng.range(0, 100), rng.range(0, 100), rng.range(0, 100));
    const colour = new THREE.Color(...surfaceColour(starData.teff_K));
    const limbColour = new THREE.Color(...surfaceColour(starData.teff_K * 0.8));
    const spotColour = new THREE.Color(...surfaceColour(starData.teff_K * 0.68));
    const noise = { value: getNoiseTexture() };
    const bandStrength = { value: 1 };
    const reveal = { value: 1 };
    const anim = { value: 0 };

    const surfaceMaterial = new THREE.ShaderMaterial({
        toneMapped: false,
        defines: { QUALITY: qualityDefine(opts.quality) },
        vertexShader: SURFACE_VERTEX,
        fragmentShader: SURFACE_FRAGMENT,
        uniforms: {
            ...sharedUniforms,
            tNoise: noise,
            uTideAxis: { value: new THREE.Vector3(1, 0, 0) },
            uTide: { value: 0 },
            uCusp: { value: 0 },
            uLumps: { value: look.lumps },
            uSeed: { value: seed },
            uColour: { value: colour },
            uLimbColour: { value: limbColour },
            uSpotColour: { value: spotColour },
            uAnim: anim,
            uRot: { value: 0 },
            uBoil: { value: look.boil },
            uCellScale: { value: look.cellScale },
            uCellSoft: { value: look.cellSoft },
            uGrainBody: { value: look.grainBody },
            uContrast: { value: look.contrast },
            uSuper: { value: look.super },
            uSpots: { value: look.spots },
            uSpotFreq: { value: look.spotFreq },
            uSpotLat: { value: look.spotLat },
            uLimbU: { value: look.limbU },
            uLimbV: { value: look.limbV },
            uIntensity: { value: look.intensity },
            uBandStrength: bandStrength,
            uReveal: reveal,
            uDetail: { value: 1 },
            uSpotDetail: { value: 1 }
        }
    });
    const surface = new THREE.Mesh(sphereFor(opts.quality), surfaceMaterial);
    surface.frustumCulled = false;

    const c = look.corona;
    const coronaMaterial = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: CORONA_VERTEX,
        fragmentShader: CORONA_FRAGMENT,
        uniforms: {
            ...sharedUniforms,
            tNoise: noise,
            uCentre: { value: new THREE.Vector3() },
            uRadius: { value: 1 },
            uRmax: { value: c.rmax },
            uQuad: { value: c.rmax },
            uColour: { value: colour },
            uLimbColour: { value: limbColour },
            uAnim: anim,
            uA1: { value: c.a1 },
            uH1: { value: c.h1 },
            uA2: { value: c.a2 },
            uH2: { value: c.h2 },
            uTurb: { value: c.turb },
            uFlow: { value: c.flow },
            uFreq: { value: c.freq },
            uSpike: { value: c.spike },
            uSeed: { value: seed },
            uBandStrength: bandStrength,
            uReveal: reveal
        }
    });
    const corona = new THREE.Mesh(quadGeometry, coronaMaterial);
    corona.frustumCulled = false;
    corona.renderOrder = 2;

    const glowGeometry = new THREE.BufferGeometry();
    glowGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const glowMaterial = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: GLOW_VERTEX,
        fragmentShader: GLOW_FRAGMENT,
        uniforms: {
            ...sharedUniforms,
            uPx: { value: 30 },
            uColour: { value: colour },
            uGlow: { value: 0 },
            uSharp: { value: look.glowSharp }
        }
    });
    const glow = new THREE.Points(glowGeometry, glowMaterial);
    glow.frustumCulled = false;
    glow.renderOrder = 4;

    const group = new THREE.Group();
    group.add(surface, corona, glow);

    const qCam = new THREE.Quaternion();
    let rot = rng.range(0, 6.28);
    const api = {
        group,
        look,
        radius: 1,
        setRadius(r) {
            api.radius = r;
            surface.scale.setScalar(r);
            coronaMaterial.uniforms.uRadius.value = r;
        },
        // How far this star leans towards its partner
        setTide(axisX, axisY, axisZ, stretch, cusp) {
            const u = surfaceMaterial.uniforms;
            u.uTideAxis.value.set(axisX, axisY, axisZ);
            u.uTide.value = stretch;
            u.uCusp.value = cusp;
        },
        setBandStrength(k) { bandStrength.value = k; },
        setQuality(q) {
            surfaceMaterial.defines.QUALITY = qualityDefine(q);
            surfaceMaterial.needsUpdate = true;
        },
        update(s) {
            // s = { dt, camera, reveal, pointGlow, glowPx, reduceMotion, pxRadius }
            if (!s.reduceMotion) {
                anim.value += s.dt;
                rot += s.dt * look.spin * (1 + Math.min(4, (starData.vsini_kms || 0) / 40));
            }
            surfaceMaterial.uniforms.uRot.value = rot;
            // A small star is mostly glare: fade its fine detail and lift its brightness
            const cellPx = s.pxRadius / look.cellScale;
            surfaceMaterial.uniforms.uDetail.value = THREE.MathUtils.smoothstep(cellPx, 1.6, 4);
            surfaceMaterial.uniforms.uSpotDetail.value = THREE.MathUtils.smoothstep(s.pxRadius, 22, 70);
            surfaceMaterial.uniforms.uIntensity.value = look.intensity * (1 + 0.15 * (1 - THREE.MathUtils.smoothstep(s.pxRadius, 12, 70)));
            reveal.value = s.reveal;
            corona.quaternion.copy(s.camera.getWorldQuaternion(qCam));
            coronaMaterial.uniforms.uCentre.value.copy(group.position);
            // The glow ends at a set distance from the star's centre measured along the ray, and seen from close by
            // that means a wider quad. Any wider than this and the camera is inside the glow anyway.
            const reach = api.radius * c.rmax;
            const d = group.position.distanceTo(s.camera.position);
            const half = reach / Math.sqrt(Math.max(0.03, 1 - (reach / Math.max(d, 1e-6)) ** 2));
            corona.scale.setScalar(half);
            coronaMaterial.uniforms.uQuad.value = half / api.radius;
            glowMaterial.uniforms.uGlow.value = s.pointGlow * Math.min(6, look.intensity + 1) * bandStrength.value;
            glowMaterial.uniforms.uPx.value = s.glowPx;
        },
        dispose() {
            surfaceMaterial.dispose();
            coronaMaterial.dispose();
            glowMaterial.dispose();
            glowGeometry.dispose();
        }
    };
    return api;
}
