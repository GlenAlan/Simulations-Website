// The sky-wide look of the four invisible bands, and the cosmic microwave background. The visible Milky Way is background.js's.
//
//   Radio    smooth synchrotron glow: a thick disc, a bright centre, and faint loops arching off the plane
//   Infrared a thin warm band with clumps and dark lanes, and wisps of cirrus dust at every latitude
//   UV       dark sky; the band traced in patches of hot young stars, its midplane blocked by dust
//   X-ray/γ  almost black; a thin gamma ridge, a bright centre and two very faint lobes above and below it
//
// All four are baked once, one per channel, into a single texture indexed by galactic longitude and latitude. Each frame is
// then a texture read on one sphere, skipped entirely in the visible band. Latitudes are squeezed so that the band gets most of
// the texture's rows. The bake is spread over many frames, sized to the GPU, so it can't stall the page. All of it is the
// dome, at depth 1 (core/depth.js).

import * as THREE from 'three';
import { bus } from '../../core/state.js';
import { Rng } from '../../core/rng.js';
import { azAltToVec3, GALACTIC_POLE } from '../../core/sky.js';
import { BAND_INFO, GALACTIC_CENTRE_AZ } from '../../core/bands.js';
import { skyMaterial, BAND_GLSL, LOOP_ZERO_GLSL, ORDER } from '../shared.js';
import { PLANE_GLSL } from './background.js';

const RAD = Math.PI / 180;
const LAT_SCALE_DEG = 18;           // Latitudes well inside this get most of the texture's rows
const STRIP_ROWS_MIN = 2;           // The bake's strips are sized to suit the GPU, between these. A slow GPU gets the smallest
const STRIP_ROWS_MAX = 128;
const BAKE_START_DELAY_S = 4;       // How long after loading the bake waits, unless these bands are asked for first
const GLOW_FADE_S = 0.5;
const CMB_FADE_S = 0.6;
const CMB_GLOW = 0.022;             // Faint: enough to lift the whole radio sky, not enough to wash it out

// Overall brightness of each band's glow. The sky stays a backdrop: sources must stand out against it.
const GAIN = { radio: 0.42, ir: 0.44, uv: 0.85, xray: 0.5 };
const GLOW_BANDS = ['radio', 'ir', 'uv', 'xray'];

// Unit vectors of the galactic frame: x to the centre, z to the north galactic pole
function galacticBasis() {
    const z = azAltToVec3(GALACTIC_POLE.az, GALACTIC_POLE.alt);
    // The band's altitude at the centre's azimuth, from the band being at right angles to the pole
    const altC = Math.atan2(
        -Math.cos(GALACTIC_POLE.alt * RAD) * Math.cos((GALACTIC_CENTRE_AZ - GALACTIC_POLE.az) * RAD),
        Math.sin(GALACTIC_POLE.alt * RAD)
    ) / RAD;
    const x = azAltToVec3(GALACTIC_CENTRE_AZ, altC);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return { x, y, z };
}

const LAT_GLSL = /* glsl */`
const float PI = 3.14159265359;
const float RAD = PI / 180.0;
const float LAT_SCALE = ${LAT_SCALE_DEG.toFixed(1)};
float latToV(float bDeg) { return 0.5 + atan(bDeg / LAT_SCALE) / (2.0 * atan(90.0 / LAT_SCALE)); }
float vToLat(float v) { return LAT_SCALE * tan((v - 0.5) * 2.0 * atan(90.0 / LAT_SCALE)); }
`;

// r, g, b, a = radio, infrared, UV, X-ray. Noise is evaluated on the sphere, so there is no seam and no pinching at the poles.
const BAKE_FRAGMENT = /* glsl */`
precision highp float;
varying vec2 vUv;
${LAT_GLSL}
${LOOP_ZERO_GLSL}
${PLANE_GLSL}

// Hash without sine, so every GPU draws the same sky
vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
}

// The eight corners of the cell in a loop rather than written out, for the compiler's sake: see LOOP_ZERO_GLSL
float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float sum = 0.0;
    for (int c = 0; c < 8 + uLoopZero; c++) {
        vec3 o = vec3(float(c & 1), float((c >> 1) & 1), float((c >> 2) & 1));
        vec3 w = mix(1.0 - u, u, o);
        sum += w.x * w.y * w.z * dot(hash33(i + o), f - o);
    }
    return sum * 1.6;
}

float fbm(vec3 p, int octaves) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < octaves + uLoopZero; i++) {
        sum += amp * noise(p);
        p = p * 2.03 + vec3(11.7, 3.1, 7.9);
        amp *= 0.5;
    }
    return sum;
}

float gauss(float x, float sigma) { return exp(-(x * x) / (2.0 * sigma * sigma)); }

// Noise stretched along the plane, the way dust and gas are sheared by the galaxy's rotation
float sheared(vec3 g, float scale, float shear, int octaves) {
    return fbm(vec3(g.xy * scale, g.z * scale * shear), octaves);
}

// A faint arc of a small circle on the sky, centred on (lc, bc) in degrees
float arc(vec3 g, float lc, float bc, float radius, float width) {
    vec3 c = vec3(cos(bc * RAD) * cos(lc * RAD), cos(bc * RAD) * sin(lc * RAD), sin(bc * RAD));
    float angle = acos(clamp(dot(g, c), -1.0, 1.0)) / RAD;
    return gauss(angle - radius, width);
}

// Radio: synchrotron from electrons in the galaxy's magnetic field. Smooth and broad, brightest towards the centre and along
// the arms seen end-on, with a few great loops of field rising from the plane.
float radioSky(vec3 g, float l, float b) {
    vec3 warped = normalize(g + 0.22 * vec3(fbm(g * 2.1 + 1.0, 3), fbm(g * 2.3 + 7.0, 3), fbm(g * 2.7 + 13.0, 3)));
    float bent = b + 6.0 * fbm(g * 2.6 + 5.0, 3);
    float along = 0.26 + 0.62 * gauss(l, 42.0) + 0.3 * gauss(abs(l) - 38.0, 7.0) + 0.16 * gauss(abs(l) - 78.0, 8.0);
    float disc = (0.52 * exp(-abs(bent) / 11.0) + 0.5 * gauss(bent, 2.4)) * along;
    float centre = 0.5 * gauss(l, 5.5) * gauss(b, 3.6);
    float mottled = 0.78 + 0.5 * fbm(warped * 3.4, 4);
    float breaks = smoothstep(-0.22, 0.28, fbm(warped * 2.4 + 33.0, 3));
    float loops = breaks * (
        0.3 * arc(warped, -38.0, 34.0, 27.0, 2.3)
        + 0.22 * arc(warped, 46.0, -30.0, 21.0, 2.0)
        + 0.2 * arc(warped, 118.0, 26.0, 19.0, 2.6)
        + 0.16 * arc(warped, -125.0, -22.0, 24.0, 2.4));
    float halo = 0.055 * exp(-abs(b) / 40.0) + 0.012;
    return disc * mottled + centre + loops + halo;
}

// Infrared: dust warmed by starlight. A thin bright plane and a fat stellar bulge, with knots of star formation, dark lanes
// where the dust is coldest and thickest, and wisps of cirrus all the way to the poles.
float infraredSky(vec3 g, float l, float b) {
    vec3 warped = g + 0.07 * vec3(fbm(g * 6.0 + 2.0, 3), fbm(g * 6.0 + 9.0, 3), fbm(g * 6.0 + 17.0, 3));
    float bent = b + 2.6 * fbm(g * 5.0 + 3.0, 4);
    float along = 0.42 + 0.58 * gauss(l, 48.0);
    float plane = (0.82 * gauss(bent, 2.9) + 0.27 * exp(-abs(bent) / 7.0)) * along;
    float clumps = smoothstep(-0.34, 0.46, sheared(warped, 9.0, 2.4, 5) + 0.3 * fbm(g * 30.0, 2));
    float lanes = smoothstep(0.02, 0.34, sheared(warped + 3.0, 6.5, 3.2, 5)) * gauss(bent, 5.5);
    float dust = 1.0 - 0.8 * lanes;
    float knots = pow(smoothstep(0.1, 0.56, fbm(g * 22.0 + 60.0, 3)), 2.0) * gauss(bent, 3.4) * (0.5 + 0.5 * along);
    float bulge = 0.8 * gauss(l, 11.0) * gauss(b, 6.5);
    float wisps = pow(smoothstep(0.0, 0.5, sheared(warped + 9.0, 4.2, 2.6, 5)), 1.6);
    float cirrus = wisps * (0.02 + 0.2 * exp(-abs(b) / 17.0));
    float haze = 0.02 * exp(-abs(b) / 30.0);
    return (plane * (0.42 + 0.9 * clumps) + bulge) * dust + 1.1 * knots * dust + cirrus + haze;
}

// Ultraviolet: light from hot young stars, which dust swallows. Dark sky; bright patches beside a nearly opaque midplane,
// and the tilted ring of nearby young stars that crosses the band.
float ultravioletSky(vec3 g, float l, float b) {
    vec3 warped = g + 0.05 * vec3(fbm(g * 9.0 + 4.0, 3), fbm(g * 9.0 + 14.0, 3), fbm(g * 9.0 + 24.0, 3));
    float associations = pow(smoothstep(-0.16, 0.5, fbm(warped * 8.5 + 30.0, 4)), 1.8);
    float young = gauss(b, 6.0);
    float tilt = 19.0 * RAD;                                   // A ring tilted against the band, as in the real sky
    float ringLat = asin(clamp(g.z * cos(tilt) + g.x * sin(tilt), -1.0, 1.0)) / RAD;
    float ring = 0.35 * gauss(ringLat, 5.5);
    float dustPatches = smoothstep(-0.3, 0.26, sheared(warped + 70.0, 7.0, 2.4, 5));
    float blocked = gauss(b + 1.5 * fbm(g * 7.0, 3), 3.1) * (0.35 + 0.65 * dustPatches);
    float light = young * (0.15 + 1.0 * associations) + ring * (0.01 + 0.8 * associations);
    return light * (1.0 - 0.97 * clamp(blocked * 1.2, 0.0, 1.0)) + 0.004;
}

// X-ray and gamma: cosmic rays striking gas give a glow along the plane, as clumped and as uneven as the gas is, on the
// same wandering line as the visible band. Elsewhere, almost nothing: a faint teal haze from far beyond the galaxy.
float gammaSky(vec3 g, float l, float b) {
    float bent = b + planeLean(g) / RAD + 1.2 * fbm(g * 4.0 + 21.0, 3);
    float along = 0.3 + 0.7 * gauss(l, 38.0);
    float clouds = smoothstep(-0.3, 0.4, sheared(g + 40.0, 6.0, 2.4, 5));
    float ridge = 0.5 * gauss(bent, 2.4) * along * (0.25 + 1.1 * clouds);
    float broad = 0.2 * exp(-abs(bent) / 6.5) * along * (0.45 + 0.7 * clouds);
    float centre = 0.9 * gauss(l, 5.0) * gauss(b, 3.0);
    // Two very faint lobes above and below the centre
    float side = b > 0.0 ? 1.0 : -1.0;
    float r = length(vec2(l / 19.0, (b - side * 25.0) / 24.0));
    float lobes = smoothstep(1.12, 0.82, r) * (0.012 + 0.024 * r * r) * (0.8 + 0.5 * fbm(g * 5.0 + 3.0, 3));
    float mottle = 0.85 + 0.5 * fbm(g * 9.0 + 50.0, 3);
    float beyond = 0.012 * (0.7 + 0.8 * fbm(g * 2.5 + 90.0, 3));
    return (ridge + broad) * mottle + centre + lobes + beyond;
}

void main() {
    float l = (vUv.x - 0.5) * 2.0 * PI;
    float b = vToLat(vUv.y);
    float cosB = cos(b * RAD);
    vec3 g = vec3(cosB * cos(l), cosB * sin(l), sin(b * RAD));
    float lDeg = l / RAD;
    gl_FragColor = vec4(radioSky(g, lDeg, b), infraredSky(g, lDeg, b), ultravioletSky(g, lDeg, b), gammaSky(g, lDeg, b));
}`;

function createGlowTarget(size) {
    return new THREE.WebGLRenderTarget(size, size / 2, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        generateMipmaps: false
    });
}

// Faint, unresolved sources: crisp points that give each band's glow a grain of its own when zoomed in. They are scenery, like the
// decorative star field in visible light, and belong to the Background stars layer: they aren't even made until it is first on.
// Each band's come from where its real sources are.
function createUnresolvedSources(basis, order) {
    const rng = new Rng('band-sky-sources');
    const positions = [];
    const weights = [];
    const sizes = [];
    const place = (l, b, radio, ir, uv, xray, size) => {
        const cosB = Math.cos(b);
        const dir = [0, 1, 2].map((k) => cosB * Math.cos(l) * basis.x[k] + cosB * Math.sin(l) * basis.y[k] + Math.sin(b) * basis.z[k]);
        if (dir[1] < -0.02) return;
        positions.push(dir[0] * 1000, dir[1] * 1000, dir[2] * 1000);
        weights.push(radio, ir, uv, xray);
        sizes.push(size);
    };
    const anywhere = () => [rng.range(-Math.PI, Math.PI), Math.asin(rng.range(-1, 1))];

    // Infrared: thousands of cool stars packed along the plane, many of them hidden from visible light
    for (let i = 0; i < 2600; i++) {
        const b = (rng.chance(0.75) ? rng.gauss(0, 5.5) : rng.gauss(0, 24)) * RAD;
        place(rng.range(-Math.PI, Math.PI), b, 0, rng.logRange(0.05, 0.5), 0, 0, rng.range(1.2, 2.2));
    }
    // Ultraviolet: hot young stars born together in loose groups along the plane, and very few elsewhere
    for (let g = 0; g < 46; g++) {
        const cl = rng.range(-Math.PI, Math.PI);
        const cb = rng.gauss(0, 5.5) * RAD;
        const n = rng.int(4, 16);
        for (let i = 0; i < n; i++) place(cl + rng.gauss(0, 2) * RAD, cb + rng.gauss(0, 1.5) * RAD, 0, 0, rng.logRange(0.1, 0.8), 0, rng.range(1.3, 2.4));
    }
    for (let i = 0; i < 60; i++) {
        const [l, b] = anywhere();
        place(l, b, 0, 0, rng.logRange(0.04, 0.2), 0, 1.3);
    }
    // Radio and X-ray: distant active galaxies, spread evenly over the whole sky
    for (let i = 0; i < 170; i++) {
        const [l, b] = anywhere();
        place(l, b, rng.logRange(0.05, 0.3), 0, 0, 0, rng.range(1.3, 1.9));
    }
    for (let i = 0; i < 150; i++) {
        const [l, b] = anywhere();
        place(l, b, 0, 0, 0, rng.logRange(0.05, 0.3), rng.range(1.3, 1.9));
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('aWeight', new THREE.BufferAttribute(new Float32Array(weights), 4));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(sizes), 1));
    const material = skyMaterial({
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            attribute vec4 aWeight;
            attribute float aSize;
            varying vec3 vColour;
            void main() {
                vec3 w = vec3(0.0);
                w += uBandTint[0] * aWeight.x * uBandW[0];
                w += uBandTint[1] * aWeight.y * uBandW[1];
                w += uBandTint[3] * aWeight.z * uBandW[3];
                w += uBandTint[4] * aWeight.w * uBandW[4];
                vColour = w * uSkyFade;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_Position.xy *= depthP(1.0);
                gl_PointSize = dot(w, w) > 0.00001 ? aSize * clamp(uViewport.y / 720.0, 1.0, 2.0) : 0.0;
            }`,
        fragmentShader: /* glsl */`
            varying vec3 vColour;
            void main() {
                float r = length(gl_PointCoord - 0.5) * 2.0;
                gl_FragColor = vec4(vColour * smoothstep(1.0, 0.2, r), 1.0);
            }`
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = order;
    return points;
}

export function createBandSkyLayer(engine, app) {
    const renderer = engine.renderer;
    const basis = galacticBasis();
    const size = app.settings.quality === 'low' ? 1024 : 2048;
    const glow = createGlowTarget(size);

    // The bake: a full-screen quad into the texture, a strip at a time. Nothing here shows in the visible band, which is
    // where every student starts, so all of it waits until the sky has settled, or until it's first needed.
    const bakeMaterial = new THREE.ShaderMaterial({
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
        toneMapped: false,
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: BAKE_FRAGMENT
    });
    const bakeScene = new THREE.Scene();
    const bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    bakeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMaterial));
    let bakeState = 'waiting';      // 'waiting', then 'compiling', 'baking' and 'done'
    let rowsDone = 0;
    let rowsPerStep = STRIP_ROWS_MIN;
    let wokenAt = performance.now() + BAKE_START_DELAY_S * 1000;
    let glowFade = 0;

    function startCompiling() {
        bakeState = 'compiling';
        engine.compileInBackground(bakeScene, bakeCamera).then(() => {
            if (bakeState === 'compiling') bakeState = 'baking';
        });
    }

    function bakeNextStrip() {
        rowsPerStep = engine.bakePace(rowsPerStep, STRIP_ROWS_MIN, STRIP_ROWS_MAX);
        const rows = Math.min(Math.round(rowsPerStep), glow.height - rowsDone);
        const previousTarget = renderer.getRenderTarget();
        glow.scissorTest = true;
        glow.scissor.set(0, rowsDone, glow.width, rows);
        renderer.setRenderTarget(glow);
        renderer.render(bakeScene, bakeCamera);
        renderer.setRenderTarget(previousTarget);
        rowsDone += rows;
        if (rowsDone >= glow.height) {
            bakeState = 'done';
            disposeBake();  // Only frees the program: after a lost context it's simply compiled again
        }
    }

    function disposeBake() {
        bakeMaterial.dispose();
        bakeScene.children[0].geometry.dispose();
    }

    const offRestored = bus.on('gl-restored', () => {
        bakeState = 'waiting';
        rowsDone = 0;
        glowFade = 0;
        skyMesh.material.uniforms.uGlowFade.value = 0;
        wokenAt = performance.now();
    });

    const toGalactic = new THREE.Matrix3().set(
        basis.x[0], basis.x[1], basis.x[2],
        basis.y[0], basis.y[1], basis.y[2],
        basis.z[0], basis.z[1], basis.z[2]
    );
    const uCmb = { value: app.layers.cmb ? 1 : 0 };
    const gainGlsl = GLOW_BANDS.map((b) => GAIN[b].toFixed(3)).join(', ');

    const skyGeometry = new THREE.SphereGeometry(900, 32, 16);
    const skyMesh = new THREE.Mesh(skyGeometry, skyMaterial({
        side: THREE.BackSide,
        uniforms: {
            tGlow: { value: glow.texture },
            uGlowFade: { value: 0 },
            uToGalactic: { value: toGalactic },
            uCmb,
            uSoften: { value: app.layers.backgroundStars ? 0 : 1 },
            uLow: { value: GLOW_BANDS.map((b) => new THREE.Vector3(...BAND_INFO[b].ramp.low)) },
            uHigh: { value: GLOW_BANDS.map((b) => new THREE.Vector3(...BAND_INFO[b].ramp.high)) }
        },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            varying vec3 vDir;
            void main() {
                vDir = position;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_Position.xy *= depthP(1.0);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            ${LAT_GLSL}
            uniform sampler2D tGlow;
            uniform float uGlowFade;
            uniform mat3 uToGalactic;
            uniform float uCmb;
            uniform float uSoften;
            uniform vec3 uLow[4];
            uniform vec3 uHigh[4];
            varying vec3 vDir;
            const vec4 GAIN = vec4(${gainGlsl});
            const vec2 TEXELS = vec2(${size}.0, ${size / 2}.0);

            vec3 ramp(float i, vec3 low, vec3 high) {
                float t = clamp(i, 0.0, 1.0);
                return mix(low, high, t * t * (3.0 - 2.0 * t)) * i;
            }

            void main() {
                vec3 d = normalize(vDir);
                vec3 g = uToGalactic * d;
                vec2 uv = vec2(atan(g.y, g.x) / (2.0 * PI) + 0.5, latToV(asin(clamp(g.z, -1.0, 1.0)) / RAD));
                vec4 glow;
                float magnified = smoothstep(14.0, 6.0, uFov);
                if (uSoften > 0.5 || magnified > 0.0) {
                    // Without the background stars, the glow's smallest knots mustn't pass for them: spread over a couple
                    // of pixels of the screen, which only shows at wide zoom. Held to a small reach for the seam's sake.
                    // In a narrow view it's spread over a texel, or more across the band, where the rows are closer: blown up
                    // as they are, those show as streaks
                    vec2 w = max(min(fwidth(uv), vec2(0.002)) * 1.5 * uSoften, vec2(0.5, 1.75) / TEXELS * magnified);
                    glow = (texture2D(tGlow, uv + w) + texture2D(tGlow, uv - w)
                        + texture2D(tGlow, uv + vec2(w.x, -w.y)) + texture2D(tGlow, uv - vec2(w.x, -w.y))) * 0.25;
                } else {
                    glow = texture2D(tGlow, uv);
                }
                // The sources are what a narrow view is for: a whole frame of glow would only be a wash of one colour
                glow *= GAIN * uGlowFade * mix(0.3, 1.0, smoothstep(3.0, 25.0, uFov));
                vec3 c = ramp(glow.r, uLow[0], uHigh[0]) * uBandW[0];
                c += ramp(glow.g, uLow[1], uHigh[1]) * uBandW[1];
                c += ramp(glow.b, uLow[2], uHigh[2]) * uBandW[3];     // uBandW[2] is the visible band, background.js's
                c += ramp(glow.a, uLow[3], uHigh[3]) * uBandW[4];
                c += uBandTint[0] * ${CMB_GLOW.toFixed(3)} * uCmb * uBandW[0];
                // Dither by under one 8-bit step of the final image (near enough a square root of this), so a smooth
                // dark gradient doesn't show bands
                float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
                vec3 root = max(sqrt(max(c, vec3(0.0))) + (n - 0.5) * 0.008, vec3(0.0));
                gl_FragColor = vec4(root * root * smoothstep(-0.03, 0.05, d.y) * uSkyFade, 1.0);
            }`
    }));
    skyMesh.frustumCulled = false;
    skyMesh.renderOrder = ORDER.bandSky;
    engine.scene.add(skyMesh);

    let sources = null;

    return {
        id: 'band_sky',
        bakeProgress: () => rowsDone / glow.height,
        update(frame) {
            const showing = frame.bandW[2] < 0.999;
            if (bakeState === 'waiting' && (showing || performance.now() >= wokenAt)) startCompiling();
            if (bakeState === 'baking' && engine.bakesAllowed(!showing)) bakeNextStrip();
            if (bakeState === 'done' && glowFade < 1) {
                glowFade = frame.reduceMotion ? 1 : Math.min(1, glowFade + frame.dt / GLOW_FADE_S);
                skyMesh.material.uniforms.uGlowFade.value = glowFade;
            }
            skyMesh.visible = showing;
            skyMesh.material.uniforms.uSoften.value = app.layers.backgroundStars ? 0 : 1;
            if (!sources && showing && app.layers.backgroundStars) {
                sources = createUnresolvedSources(basis, ORDER.bandSky + 1);
                engine.scene.add(sources);
            }
            if (sources) sources.visible = showing && app.layers.backgroundStars;
            const target = app.layers.cmb ? 1 : 0;
            if (frame.reduceMotion) {
                uCmb.value = target;
            } else {
                const step = frame.dt / CMB_FADE_S;
                uCmb.value += Math.max(-step, Math.min(step, target - uCmb.value));
            }
        },
        dispose() {
            offRestored();
            engine.scene.remove(skyMesh);
            skyGeometry.dispose();
            skyMesh.material.dispose();
            if (sources) {
                engine.scene.remove(sources);
                sources.geometry.dispose();
                sources.material.dispose();
            }
            disposeBake();
            glow.dispose();
        }
    };
}
