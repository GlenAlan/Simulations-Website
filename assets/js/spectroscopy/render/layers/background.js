// The sky behind everything in visible light: a procedural Milky Way baked once into a texture, a faint airglow low
// down, and a dark hilly horizon, with the Background stars layer adding a dense field of faint decorative stars. The
// bands track draws the other bands' glow in band_sky.js, so all of this except the horizon fades out with uBandW[2].
// All of it is the dome, at depth 1 (core/depth.js).
//
// Only the upper dome is ever seen, so the bake goes in one square texture using a Lambert equal-area map around
// the zenith (no seams, and none of a cube map's wasted faces). It costs about one texture read a frame.

import * as THREE from 'three';
import { bus } from '../../core/state.js';
import { Rng } from '../../core/rng.js';
import { azAltToVec3, GALACTIC_POLE } from '../../core/sky.js';
import { GALACTIC_CENTRE_AZ } from '../../core/bands.js';
import { blackBodyRGB } from '../../core/phys.js';
import { parallaxFactor } from '../../core/depth.js';
import { skyMaterial, BAND_GLSL, LOOP_ZERO_GLSL, ORDER } from '../shared.js';

const RAD = Math.PI / 180;
const SKY_RADIUS = 1000;

const BAKE_SIZE = { low: 1024, medium: 1536, high: 2048 };
const DENSITY_MAP_SIZE = 512;       // Baked first, at once: shown until the full bake is ready, and read back to place stars
const DETAIL_SIZE = 512;
const TILE_PX = 256;                // The bake is spread over frames, one tile of about this size at a time
const SKY_GAIN = 1.6;               // The texture stores sqrt(colour / SKY_GAIN)
const MILKY_WAY_FADE_S = 0.8;       // How long the Milky Way takes to come up once its first bake is there
const STARS_FADE_S = 0.4;           // How long the Background stars layer takes to come and go
const SMOOTH_DETAIL_BIAS = 2;       // Mip levels to skip in the detail texture without the stars: soft clouds, not grain
const SMOOTH_SKY_BIAS = 1;          // And in the Milky Way itself, whose finest knots would otherwise pass for stars

const FIELD_STARS = { low: 12000, medium: 34000, high: 64000 };
const FIELD_STARS_MAX = FIELD_STARS.high;

// The dome map reaches this far from the zenith (100 degrees, so 10 below the horizon)
const DOME_GLSL = /* glsl */`
const float DOME_R = 1.5320888862;  // 2 sin(50 deg)
vec2 domeUv(vec3 d) {
    float k = sqrt(2.0 / (1.0 + max(d.y, -0.98)));
    return vec2(d.x * k, d.z * k) / (2.0 * DOME_R) + 0.5;
}
vec3 domeDir(vec2 p) {              // From map coordinates, in units where the zenith's scale is 1
    float r2 = dot(p, p);
    float k = sqrt(max(0.0, 1.0 - r2 / 4.0));
    return vec3(p.x * k, 1.0 - r2 / 2.0, p.y * k);
}
`;

// Integer hashes, so that every GPU draws the same sky
const HASH_GLSL = /* glsl */`
uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
}
`;

const BAKE_FRAGMENT = /* glsl */`
    ${DOME_GLSL}
    ${HASH_GLSL}
    ${LOOP_ZERO_GLSL}
    uniform vec3 uPole;
    uniform vec3 uCentre;
    uniform vec3 uEast;
    uniform float uGrain;           // 1 with the Background stars layer. Without it the band is a smooth glow.
    varying vec2 vUv;

    vec3 gradient(ivec3 p) {
        uvec3 h = pcg3d(uvec3(p + 65536));
        return vec3(h >> 8u) / 8388608.0 - 1.0;
    }
    // The eight corners of the cell in a loop rather than written out, for the compiler's sake: see LOOP_ZERO_GLSL
    float gnoise(vec3 p) {
        vec3 fl = floor(p);
        ivec3 i = ivec3(fl);
        vec3 f = p - fl;
        vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        float sum = 0.0;
        for (int c = 0; c < 8 + uLoopZero; c++) {
            ivec3 o = ivec3(c & 1, (c >> 1) & 1, (c >> 2) & 1);
            vec3 fo = vec3(o);
            vec3 w = mix(1.0 - u, u, fo);
            sum += w.x * w.y * w.z * dot(gradient(i + o), f - fo);
        }
        return sum;
    }
    // Turned a little each octave, so the noise lattice doesn't show as lines
    const mat3 TURN = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
    float fbm(vec3 p, int octaves) {
        float sum = 0.0;
        float amp = 0.55;
        for (int i = 0; i < octaves + uLoopZero; i++) {
            sum += amp * gnoise(p);
            p = TURN * p * 2.07 + vec3(1.7, 9.2, 3.1);
            amp *= 0.52;
        }
        return sum;
    }
    // Sharp ridges: where dark lanes and filaments come from
    float ridged(vec3 p, int octaves) {
        float sum = 0.0;
        float amp = 0.55;
        float weight = 1.0;
        for (int i = 0; i < octaves + uLoopZero; i++) {
            float v = 1.0 - abs(gnoise(p) * 1.6);
            v *= v;
            sum += amp * v * weight;
            weight = clamp(v * 1.8, 0.0, 1.0);
            p = TURN * p * 2.11 + vec3(4.3, 1.1, 7.9);
            amp *= 0.55;
        }
        return sum;
    }

    void main() {
        vec2 p = (vUv * 2.0 - 1.0) * DOME_R;
        if (dot(p, p) > DOME_R * DOME_R * 1.05) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            return;
        }
        vec3 d = domeDir(p);
        // Galactic coordinates: g.x points at the bulge, g.z at the pole
        vec3 g = vec3(dot(d, uCentre), dot(d, uEast), dot(d, uPole));
        float l = atan(g.y, g.x);
        float b = asin(clamp(g.z, -1.0, 1.0));
        float absL = abs(l);

        // Everything is stretched along the plane, so that clouds and lanes run with the band
        vec3 gs = vec3(g.xy, g.z * 1.7);
        vec3 warp = vec3(fbm(gs * 2.3 + vec3(3.1, 0.0, 0.0), 4), fbm(gs * 2.3 + vec3(0.0, 17.3, 0.0), 4), fbm(gs * 2.3 + vec3(0.0, 0.0, 29.7), 4));
        vec3 q = gs + warp * 0.30;

        // The plane wanders a little, and the disc swells towards the centre
        float lean = 0.05 * fbm(g * 1.3 + vec3(5.0, 2.0, 11.0), 3);
        float bw = b + lean;
        float centreness = exp(-pow(absL / 1.15, 2.0));
        float thick = mix(0.082, 0.128, centreness);
        float disc = exp(-pow(abs(bw) / thick, 1.25));
        float wide = exp(-abs(bw) / 0.30);

        // Star clouds, large and small, down to a grain about the size of a texel: stars too faint to see singly
        float big = fbm(q * 3.1, 5);
        float middling = fbm(q * 9.5, 5);
        float clouds = smoothstep(-0.34, 0.42, big + middling * 0.45);
        float grain = 0.92;
        if (uGrain > 0.5) grain = clamp(0.92 + 1.05 * fbm(g * 44.0, 4), 0.35, 1.7);

        // The bulge: a squashed, warm swelling, a little peanut-shaped
        float bulgeR = length(vec2(l / 0.36, bw / (0.135 + 0.03 * cos(l * 7.0))));
        float bulge = exp(-pow(bulgeR, 1.3));
        float core = exp(-pow(length(vec2(l / 0.17, bw / 0.07)), 1.5));

        float reach = 0.52 + 0.48 * exp(-pow(absL / 1.55, 2.0));

        // Glow before the dust takes its share. Blue-white young stars along the disc, cream and gold at the centre.
        vec3 cool = vec3(0.34, 0.52, 1.00);
        vec3 pale = vec3(0.72, 0.78, 1.00);
        vec3 cream = vec3(1.00, 0.86, 0.70);
        vec3 gold = vec3(1.00, 0.76, 0.50);
        float tone = smoothstep(-0.35, 0.40, fbm(q * 4.7 + vec3(13.0, 3.0, 8.0), 4));
        vec3 discCol = mix(cool, pale, 0.2 + 0.7 * clouds);
        discCol = mix(discCol, cream, 0.30 * tone + 0.30 * bulge);
        vec3 glow = discCol * disc * reach * (0.050 + 0.46 * clouds * clouds + 0.15 * clouds) * grain;
        glow += mix(cool, pale, 0.3) * wide * reach * (0.014 + 0.026 * smoothstep(-0.3, 0.5, big));
        glow += gold * bulge * (0.14 + 0.24 * clouds) * mix(1.0, grain, 0.8);
        glow += cream * core * 0.30 * mix(1.0, grain, 0.5);

        // Dust: a great rift along the plane, with filaments reaching out of it, and looser patches further off
        float riftWander = 0.042 * fbm(vec3(l * 2.1, 0.0, 3.0), 4);
        float rift = exp(-pow(abs(bw + riftWander) / (thick * mix(0.34, 0.50, centreness)), 1.5));
        float cover = exp(-pow(abs(bw + riftWander) / (thick * 1.45), 2.0));
        float lanes = ridged(q * 4.6 + vec3(9.0, 2.0, 5.0), 6);
        float fineLanes = ridged(q * 12.5 + vec3(1.0, 8.0, 3.0), 5);
        float patchy = smoothstep(-0.25, 0.35, fbm(q * 1.7 + vec3(21.0, 4.0, 13.0), 4));
        float tau = 3.1 * rift * (0.38 + 1.10 * smoothstep(0.42, 0.98, lanes)) * (0.50 + 0.80 * patchy);
        tau += 2.5 * cover * smoothstep(0.52, 1.00, lanes) * patchy;
        tau += 1.3 * cover * smoothstep(0.50, 0.90, fineLanes) * (0.25 + patchy * 0.75);
        // Reddening: dust takes blue first, which warms the edges of the lanes
        vec3 extinction = exp(-tau * vec3(0.93, 1.0, 1.10));
        vec3 col = glow * mix(vec3(0.03), vec3(1.0), extinction);

        // Faint glowing gas here and there along the disc: pink hydrogen and a little teal oxygen
        float gas = smoothstep(0.16, 0.56, fbm(q * 8.0 + vec3(31.0, 7.0, 2.0), 5));
        float gasMask = disc * reach * extinction.g;
        col += vec3(1.0, 0.20, 0.38) * gas * gas * gasMask * (1.0 - 0.5 * centreness) * 0.17;
        col += vec3(0.20, 0.55, 0.85) * gas * (1.0 - gas) * gasMask * 0.06;

        // More colour than the tone curve will leave otherwise
        col = max(mix(vec3(dot(col, vec3(0.3, 0.55, 0.15))), col, 1.35), vec3(0.0));

        // Dithered by one step of the texture: eight bits are too few for such faint gradients, and would show contours
        uvec3 h = pcg3d(uvec3(gl_FragCoord.xy, 11.0));
        vec3 dither = (vec3(h >> 8u) / 16777216.0 - 0.5) / 255.0;
        gl_FragColor = vec4(sqrt(clamp(col / ${SKY_GAIN.toFixed(3)}, 0.0, 1.0)) + dither, exp(-tau));
    }`;

// A small tiling texture of noise (R) and ridges (G), for detail far finer than the bake when zoomed right in
const DETAIL_FRAGMENT = /* glsl */`
    ${HASH_GLSL}
    varying vec2 vUv;
    vec2 gradient2(ivec2 p, int period) {
        ivec2 w = ivec2(mod(vec2(p), float(period)));
        uvec3 h = pcg3d(uvec3(w + 65536, period));
        return vec2(h.xy >> 8u) / 8388608.0 - 1.0;
    }
    float tileNoise(vec2 p, int period) {
        vec2 fl = floor(p);
        ivec2 i = ivec2(fl);
        vec2 f = p - fl;
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        return mix(mix(dot(gradient2(i, period), f), dot(gradient2(i + ivec2(1, 0), period), f - vec2(1, 0)), u.x),
            mix(dot(gradient2(i + ivec2(0, 1), period), f - vec2(0, 1)), dot(gradient2(i + ivec2(1, 1), period), f - vec2(1, 1)), u.x), u.y);
    }
    void main() {
        float noise = 0.0;
        float lanes = 0.0;
        float weight = 1.0;
        float amp = 0.5;
        int period = 6;
        for (int i = 0; i < 6; i++) {
            float n = tileNoise(vUv * float(period), period);
            noise += amp * n;
            float v = 1.0 - abs(n * 1.9);
            v *= v;
            lanes += amp * v * weight;
            weight = clamp(v * 1.9, 0.0, 1.0);
            period *= 2;
            amp *= 0.55;
        }
        gl_FragColor = vec4(clamp(noise * 1.1 + 0.5, 0.0, 1.0), clamp(lanes * 1.05, 0.0, 1.0), 0.0, 1.0);
    }`;

const SKY_FRAGMENT = /* glsl */`
    ${BAND_GLSL}
    ${DOME_GLSL}
    ${HASH_GLSL}
    uniform sampler2D tSky;
    uniform sampler2D tDetail;
    uniform float uMilkyWay;        // Fades the bake in when it first arrives
    uniform float uVisibleAmount;
    uniform vec3 uDeepFade;
    uniform vec3 uDetailFade;       // Coarse detail, fine detail, and how much glow is left
    uniform float uDpr;
    uniform float uDetailBias;
    uniform float uSkyBias;
    varying vec3 vDir;

    // One layer of a star field too fine for points, for the view through a narrow field. Each star keeps to the
    // middle of its grid cell, so a single cell is enough.
    vec3 deepStars(vec2 dome, vec3 d, float cells, float fade, float seed, float shade, float keep) {
        vec2 g = dome * cells;
        vec2 fl = floor(g);
        uvec3 h = pcg3d(uvec3(ivec2(fl) + 131072, int(seed)));
        vec3 r = vec3(h >> 8u) / 16777216.0;
        if (r.z > keep) return vec3(0.0);
        vec3 star = domeDir((fl + 0.28 + r.xy * 0.44) / cells);
        float dist = length(d - star) * uPxPerRad * depthP(1.0);
        float rank = 1.0 - r.z / keep;
        float sigma = (0.62 + 0.55 * rank * rank * rank) * uDpr;
        float amp = 0.035 + 0.42 * rank * rank * rank + 2.4 * pow(rank, 8.0);
        vec3 tint = mix(vec3(1.0, 0.56, 0.28), vec3(0.50, 0.68, 1.0), fract(r.x * 7.0 + r.y * 3.0));
        tint = mix(vec3(1.0, 0.92, 0.82), tint, 0.8);
        return tint * amp * fade * shade * exp(-dist * dist / (2.0 * sigma * sigma));
    }

    void main() {
        vec3 d = normalize(vDir);
        vec2 uv = domeUv(d);
        vec4 tex = texture2D(tSky, uv, uSkyBias);
        tex.rgb *= uMilkyWay;
        vec3 col = tex.rgb * tex.rgb * ${SKY_GAIN.toFixed(3)};
        vec2 dome = (uv - 0.5) * 2.0 * DOME_R;

        if (uDetailFade.x > 0.0) {
            // Mottle the glow, and fray the edges of the dust, more finely than the bake can
            float edge = 4.0 * tex.a * (1.0 - tex.a);
            vec2 d1 = texture2D(tDetail, dome * 3.1, uDetailBias).rg;
            float mottle = mix(1.0, 0.55 + 0.9 * d1.r, uDetailFade.x);
            float fray = mix(1.0, 1.0 - edge * 0.85 * d1.g, uDetailFade.x);
            if (uDetailFade.y > 0.0) {
                vec2 d2 = texture2D(tDetail, dome * 17.3, uDetailBias).rg;
                mottle *= mix(1.0, 0.62 + 0.76 * d2.r, uDetailFade.y);
                fray *= mix(1.0, 1.0 - edge * 0.7 * d2.g, uDetailFade.y);
            }
            col *= mottle * fray;
        }
        col *= uDetailFade.z;

        float up = max(d.y, 0.0);
        // Light gets dimmer through more air low down
        float air = exp(-0.040 / (up + 0.035));
        col *= air;

        if (uDeepFade.x > 0.0) {
            // Dust dims the deep stars, and there are more of them where the band is bright
            float lum = dot(tex.rgb, vec3(0.3, 0.5, 0.2));
            float shade = mix(0.22, 1.0, tex.a) * (0.35 + 2.2 * lum) * air;
            float keep = mix(0.14, 0.5, smoothstep(0.03, 0.32, lum));
            col += deepStars(dome, d, 458.0, uDeepFade.x, 1.0, shade, keep);
            if (uDeepFade.y > 0.0) col += deepStars(dome, d, 1146.0, uDeepFade.y, 2.0, shade * 0.8, keep);
            if (uDeepFade.z > 0.0) col += deepStars(dome, d, 2865.0, uDeepFade.z, 3.0, shade * 0.65, keep);
        }

        // Far from the band the sky is a deep blue, not quite black. Worked out here, not baked: it sits so near the
        // bottom of the texture's range that eight bits would draw it as visible contours.
        col += vec3(0.0052, 0.0076, 0.0165) * (0.92 + 0.16 * d.y);

        // Airglow: a faint green-teal band low down, and a wider blue haze above it
        col += vec3(0.020, 0.052, 0.038) * exp(-up / 0.075);
        col += vec3(0.0065, 0.0105, 0.0190) * exp(-up / 0.30);

        gl_FragColor = vec4(col * uVisibleAmount, 1.0);
    }`;

// The Milky Way bake: a density map first, then the full-size texture over the next frames
function createSkyBake(engine) {
    const { renderer } = engine;
    const pole = azAltToVec3(GALACTIC_POLE.az, GALACTIC_POLE.alt);
    // The bulge sits where the band passes the centre's azimuth, the same frame the other bands' skies use (band_sky.js)
    const centreAlt = Math.atan2(
        -Math.cos(GALACTIC_POLE.alt * RAD) * Math.cos((GALACTIC_CENTRE_AZ - GALACTIC_POLE.az) * RAD),
        Math.sin(GALACTIC_POLE.alt * RAD)
    ) / RAD;
    const centre = azAltToVec3(GALACTIC_CENTRE_AZ, centreAlt);
    const east = [
        pole[1] * centre[2] - pole[2] * centre[1],
        pole[2] * centre[0] - pole[0] * centre[2],
        pole[0] * centre[1] - pole[1] * centre[0]
    ];

    const bakeVertex = 'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    const material = new THREE.ShaderMaterial({
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
        toneMapped: false,
        uniforms: {
            uPole: { value: new THREE.Vector3(...pole) },
            uCentre: { value: new THREE.Vector3(...centre) },
            uEast: { value: new THREE.Vector3(...east) },
            uGrain: { value: 0 }
        },
        vertexShader: bakeVertex,
        fragmentShader: BAKE_FRAGMENT
    });
    const detailMaterial = new THREE.ShaderMaterial({
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
        toneMapped: false,
        vertexShader: bakeVertex,
        fragmentShader: DETAIL_FRAGMENT
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const quad = new THREE.Mesh(geometry, material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const makeTarget = (size, mips) => {
        const target = new THREE.WebGLRenderTarget(size, size, {
            type: THREE.UnsignedByteType,
            format: THREE.RGBAFormat,
            depthBuffer: false,
            stencilBuffer: false,
            generateMipmaps: false,                 // Turned on for the last tile: mips are only made once
            minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
            magFilter: THREE.LinearFilter
        });
        target.texture.colorSpace = THREE.NoColorSpace;
        return target;
    };

    const detail = makeTarget(DETAIL_SIZE, true);
    detail.texture.wrapS = THREE.RepeatWrapping;
    detail.texture.wrapT = THREE.RepeatWrapping;

    let shown = null;       // The target the sky currently draws
    let job = null;         // { target, size, tiles, tile, next, count }
    let doneSize = 0;

    // Compile without blocking: the first bake waits for this, and the sky is up and can be dragged meanwhile
    function compile() {
        const programs = new THREE.Scene();
        [material, detailMaterial].forEach((m) => {
            const mesh = new THREE.Mesh(geometry, m);
            mesh.frustumCulled = false;
            programs.add(mesh);
        });
        return engine.compileInBackground(programs, camera);
    }

    function drawDetail() {
        const previous = renderer.getRenderTarget();
        quad.material = detailMaterial;
        detail.texture.generateMipmaps = true;
        renderer.setRenderTarget(detail);
        renderer.render(scene, camera);
        quad.material = material;
        renderer.setRenderTarget(previous);
    }

    // Shown until the full bake is ready
    function drawDensityMap() {
        const previous = renderer.getRenderTarget();
        const target = makeTarget(DENSITY_MAP_SIZE, false);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(previous);
        if (shown) shown.dispose();
        shown = target;
        doneSize = DENSITY_MAP_SIZE;
    }

    // The band's brightness to place stars by, drawn only when there are stars to place. Reading it back doesn't wait for
    // the GPU: resolves with the pixels.
    function readDensity() {
        const previous = renderer.getRenderTarget();
        const target = makeTarget(DENSITY_MAP_SIZE, false);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(previous);
        const pixels = new Uint8Array(DENSITY_MAP_SIZE * DENSITY_MAP_SIZE * 4);
        return renderer.readRenderTargetPixelsAsync(target, 0, 0, DENSITY_MAP_SIZE, DENSITY_MAP_SIZE, pixels)
            .then(() => pixels, () => null)
            .finally(() => target.dispose());
    }

    // The band with its grain of stars too faint to see singly, or without. The picture on show stays until the new one
    // has been baked, a tile a frame, like any other.
    function setGrain(on) {
        const value = on ? 1 : 0;
        if (material.uniforms.uGrain.value === value) return;
        material.uniforms.uGrain.value = value;
        const size = job ? job.size : doneSize;
        if (job) job.target.dispose();
        job = null;
        doneSize = 0;
        if (size > DENSITY_MAP_SIZE) want(size);
    }

    function want(size) {
        if (size <= doneSize || (job && job.size === size)) return;
        if (job) job.target.dispose();
        const tiles = Math.max(1, Math.round(size / TILE_PX));
        job = { target: makeTarget(size, true), size, tiles, tile: Math.ceil(size / tiles), next: 0, count: tiles * tiles };
        job.target.scissorTest = true;
    }

    // One tile a frame, so the bake never makes a stutter of its own
    function step() {
        if (!job) return;
        const { target, tiles, tile, next, count } = job;
        target.scissor.set((next % tiles) * tile, Math.floor(next / tiles) * tile, tile, tile);
        job.next += 1;
        const last = job.next >= count;
        target.texture.generateMipmaps = last;
        const previous = renderer.getRenderTarget();
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(previous);
        if (last) {
            target.scissorTest = false;
            target.texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
            if (shown) shown.dispose();
            shown = target;
            doneSize = job.size;
            job = null;
        }
    }

    function restart() {
        if (job) job.target.dispose();
        job = null;
        if (shown) shown.dispose();
        shown = null;
        doneSize = 0;
    }

    return {
        compile,
        drawDetail,
        drawDensityMap,
        readDensity,
        setGrain,
        want,
        step,
        restart,
        texture: () => (shown ? shown.texture : null),
        detailTexture: () => detail.texture,
        busy: () => !!job,
        size: () => doneSize,
        dispose() {
            restart();
            detail.dispose();
            material.dispose();
            detailMaterial.dispose();
            geometry.dispose();
        }
    };
}

// Reads the density map back into a lookup: how bright the band is in a direction, and how clear of dust
function densityLookup(pixels) {
    const size = DENSITY_MAP_SIZE;
    const R = 1.5320888862;
    const out = { lum: 0, clear: 1 };
    return (x, y, z) => {
        const k = Math.sqrt(2 / (1 + Math.max(y, -0.98)));
        const u = (x * k) / (2 * R) + 0.5;
        const v = (z * k) / (2 * R) + 0.5;
        const px = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
        const py = Math.min(size - 1, Math.max(0, Math.floor(v * size)));
        const i = (py * size + px) * 4;
        out.lum = (pixels[i] * 0.3 + pixels[i + 1] * 0.5 + pixels[i + 2] * 0.2) / 255;
        out.clear = pixels[i + 3] / 255;
        return out;
    };
}

// The decorative star field: tens of thousands of faint points that can't be selected. They're in random order,
// so a lower graphics level just draws fewer of them. This places them a few milliseconds at a time: placeSome(ms)
// returns the finished field when the last one is in, and null until then.
function fieldStarPlacer(pixels) {
    const rng = new Rng('skycore-field-stars');
    const lookup = densityLookup(pixels);
    const n = FIELD_STARS_MAX;
    const positions = new Float32Array(n * 3);
    const colours = new Uint8Array(n * 3);
    const mags = new Float32Array(n);
    const seeds = new Float32Array(n);

    // A small palette, as computing black-body colours sixty thousand times would be a waste
    const palette = [];
    for (let i = 0; i < 64; i++) {
        const T = 2800 * (20000 / 2800) ** (i / 63);
        const [r, g, b] = blackBodyRGB(T);
        // A little richer than true colour, as faint stars otherwise all read as white, but no channel goes quite
        // to zero, which would turn a cool star into a hard orange speck
        const grey = (r + g + b) / 3;
        palette.push([r, g, b].map((c) => Math.round(Math.min(1, Math.max(0.1, grey + (c - grey) * 1.3)) * 255)));
    }

    let placed = 0;
    return function placeSome(budgetMs) {
        const started = performance.now();
        while (placed < n) {
            if ((placed & 1023) === 0 && performance.now() - started > budgetMs) return null;
            // Even over the dome, down to a little below the horizon
            const y = rng.range(-0.04, 1);
            const a = rng.range(0, Math.PI * 2);
            const r = Math.sqrt(1 - y * y);
            const x = r * Math.cos(a);
            const z = r * Math.sin(a);
            const { lum, clear } = lookup(x, y, z);
            // Density follows the band's light, thinned where dust hides the stars behind it
            const keep = (0.10 + 2.6 * lum * lum + 0.9 * lum) * (0.12 + 0.88 * clear);
            if (rng.next() > keep) continue;
            positions[placed * 3] = x * SKY_RADIUS;
            positions[placed * 3 + 1] = y * SKY_RADIUS;
            positions[placed * 3 + 2] = z * SKY_RADIUS;
            // Many faint, few bright
            mags[placed] = 4.6 + 9.4 * rng.next() ** 0.6;
            seeds[placed] = rng.next();
            // Mostly orange and yellow suns with some blue-white, weighted towards cool as real star counts are
            const tone = Math.floor(63 * rng.next() ** 1.5 * (0.75 + 0.25 * rng.next()));
            const colour = palette[tone];
            colours[placed * 3] = colour[0];
            colours[placed * 3 + 1] = colour[1];
            colours[placed * 3 + 2] = colour[2];
            placed += 1;
        }
        return fieldStars(positions, colours, mags, seeds);
    };
}

function fieldStars(positions, colours, mags, seeds) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColour', new THREE.BufferAttribute(colours, 3, true));
    geometry.setAttribute('aMag', new THREE.BufferAttribute(mags, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    const material = skyMaterial({
        uniforms: { uDpr: { value: 1 }, uFieldAmount: { value: 1 } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            uniform float uDpr;
            uniform float uFieldAmount;
            attribute vec3 aColour;
            attribute float aMag;
            attribute float aSeed;
            varying vec3 vColour;
            varying float vRadius;
            void main() {
                // Most are too faint to notice until a narrower field brightens them. The soft ceiling means
                // they never outshine real objects, and keep their colour instead of burning out to white.
                float level = pow(10.0, -0.33 * (aMag - 4.4 - 0.30 * (uLimitMag - 6.0)));
                level = level / (1.0 + 0.45 * level);
                if (level < 0.004 || uFieldAmount <= 0.0) {
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    gl_PointSize = 0.0;
                    vColour = vec3(0.0);
                    vRadius = 1.0;
                    return;
                }
                float up = max(position.y / ${SKY_RADIUS.toFixed(1)}, 0.0);
                float air = exp(-0.055 / (up + 0.03));
                float wobble = sin(uTime * (1.3 + aSeed * 2.7) + aSeed * 90.0) * sin(uTime * (0.7 + aSeed * 1.9) + aSeed * 37.0);
                float twinkle = 1.0 + uTwinkle * wobble * mix(0.16, 0.5, exp(-up / 0.3));
                float bright = level * air * twinkle * uFieldAmount * uSkyFade;
                vRadius = (0.78 + 0.40 * level) * uDpr;
                gl_PointSize = vRadius * 2.0 + 1.0;
                vColour = aColour * bright;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_Position.xy *= depthP(1.0);
            }`,
        fragmentShader: /* glsl */`
            varying vec3 vColour;
            varying float vRadius;
            void main() {
                vec2 p = (gl_PointCoord - 0.5) * (vRadius * 2.0 + 1.0);
                float r2 = dot(p, p) / (vRadius * vRadius);
                gl_FragColor = vec4(vColour * exp(-r2 * 1.7), 1.0);
            }`
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = ORDER.background + 1;
    return { points, geometry, material };
}

// ---------- The horizon ----------

// A smooth height around the whole circle, from sines of whole numbers of turns, so that it joins up
function ridgeNoise(rng, count, baseFreq, growth, falloff) {
    const waves = [];
    let f = baseFreq;
    let amp = 1;
    for (let i = 0; i < count; i++) {
        waves.push({ f: Math.max(1, Math.round(f)), amp, phase: rng.range(0, Math.PI * 2) });
        f *= growth * rng.range(0.9, 1.1);
        amp *= falloff;
    }
    const total = waves.reduce((sum, w) => sum + w.amp, 0);
    return (azDeg) => {
        let sum = 0;
        const a = azDeg * RAD;
        for (let i = 0; i < count; i++) sum += waves[i].amp * Math.sin(a * waves[i].f + waves[i].phase);
        return sum / total;   // Within -1..1
    };
}

// Conifers with a few round-topped trees, mostly in stands with gaps between them
function plantTrees(rng, columns, stepDeg) {
    const clump = ridgeNoise(rng, 6, 9, 2.1, 0.72);
    const trees = new Float32Array(columns);
    let az = 0;
    while (az < 360) {
        const density = clump(az);
        az += density > -0.2 ? rng.range(0.05, 0.24) : rng.range(0.4, 1.8);
        if (density < -0.42) continue;
        // Stands are tallest in the middle and taper away towards their edges
        const stand = 0.5 + 0.8 * Math.min(1, Math.max(0, density + 0.42));
        const conifer = rng.next() < 0.78;
        const h = (conifer ? rng.range(0.9, 1.8) : rng.range(0.7, 1.15)) * stand;
        const halfW = conifer ? h * rng.range(0.20, 0.30) : h * rng.range(0.46, 0.64);
        const reach = Math.ceil(halfW / stepDeg);
        const mid = Math.round(az / stepDeg);
        const tiers = 4 + Math.floor(rng.next() * 3);
        for (let c = -reach; c <= reach; c++) {
            const i = (((mid + c) % columns) + columns) % columns;
            const x = Math.abs(c * stepDeg) / halfW;
            if (x >= 1) continue;
            let height;
            if (conifer) {
                // Tiers of drooping branches: each stays level for a way, then drops sharply at its tip
                const t = x * tiers;
                const step = Math.floor(t);
                const f = t - step;
                height = h * (1 - (step + f * f * f) / tiers);
            } else {
                height = h * Math.sqrt(1 - x * x) * (1 + 0.1 * Math.sin(x * 11 + az * 3));
            }
            trees[i] = Math.max(trees[i], height);
        }
    }
    return trees;
}

// Three ridges, from hazy far mountains to a near tree line. Everything stays under 5 degrees, where the first bodies
// are, so no object is ever hidden. Heights are in degrees of altitude.
const HORIZON_MAX_DEG = 4.6;

function buildHorizon() {
    const rng = new Rng('skycore-horizon');
    const ridges = [];

    const farNoise = ridgeNoise(rng, 8, 3, 1.85, 0.62);
    const farPeaks = ridgeNoise(rng, 6, 11, 1.9, 0.6);
    ridges.push({
        step: 0.25,
        height: (az) => 2.9 + 1.5 * farNoise(az) + 0.7 * Math.abs(farPeaks(az)),
        colour: [0.0150, 0.0215, 0.0300],
        bottom: -1.5
    });

    const midNoise = ridgeNoise(rng, 8, 4, 1.9, 0.6);
    const midRough = ridgeNoise(rng, 5, 90, 1.7, 0.75);
    ridges.push({
        step: 0.1,
        height: (az) => 1.9 + 1.25 * midNoise(az) + 0.09 * midRough(az),
        colour: [0.0100, 0.0130, 0.0170],
        bottom: -1.5
    });

    const nearNoise = ridgeNoise(rng, 7, 5, 2.0, 0.55);
    const nearStep = 0.04;
    const nearColumns = Math.round(360 / nearStep);
    const trees = plantTrees(rng, nearColumns, nearStep);
    ridges.push({
        step: nearStep,
        height: (az, i) => 1.05 + 1.0 * nearNoise(az) + trees[i % nearColumns],
        colour: [0.0018, 0.0022, 0.0030],
        bottom: -70
    });

    // Each column has three rows: just above the ridge, just below it, and the foot. vBelow is degrees below the
    // ridge line, whose sign the fragment shader turns into a smooth edge at any zoom without multisampling.
    const FEATHER = 1.2;
    let vertexCount = 0;
    let indexCount = 0;
    ridges.forEach((ridge) => {
        ridge.columns = Math.round(360 / ridge.step);
        vertexCount += (ridge.columns + 1) * 3;
        indexCount += ridge.columns * 12;
    });
    const positions = new Float32Array(vertexCount * 3);
    const colours = new Float32Array(vertexCount * 3);
    const belows = new Float32Array(vertexCount);
    const indices = new Uint32Array(indexCount);
    let v = 0;
    let ix = 0;
    const writeVertex = (az, alt, below, colour) => {
        const dir = azAltToVec3(az, alt);
        positions[v * 3] = dir[0] * SKY_RADIUS;
        positions[v * 3 + 1] = dir[1] * SKY_RADIUS;
        positions[v * 3 + 2] = dir[2] * SKY_RADIUS;
        colours[v * 3] = colour[0];
        colours[v * 3 + 1] = colour[1];
        colours[v * 3 + 2] = colour[2];
        belows[v] = below;
        v += 1;
    };
    ridges.forEach((ridge) => {
        const start = v;
        for (let c = 0; c <= ridge.columns; c++) {
            const az = c * ridge.step;
            const h = Math.min(HORIZON_MAX_DEG, ridge.height(az, c));
            writeVertex(az, h + FEATHER, -FEATHER, ridge.colour);
            writeVertex(az, h - FEATHER, FEATHER, ridge.colour);
            writeVertex(az, ridge.bottom, h - ridge.bottom, ridge.colour);
        }
        for (let c = 0; c < ridge.columns; c++) {
            const a = start + c * 3;
            const b = a + 3;
            indices.set([a, a + 1, b, b, a + 1, b + 1, a + 1, a + 2, b + 1, b + 1, a + 2, b + 2], ix);
            ix += 12;
        }
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColour', new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute('aBelow', new THREE.BufferAttribute(belows, 1));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    // Not additive: it covers the sky. It has to count as transparent to draw after everything else in the scene.
    const material = skyMaterial({
        blending: THREE.NormalBlending,
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            attribute vec3 aColour;
            attribute float aBelow;
            varying vec3 vColour;
            varying float vBelow;
            void main() {
                vColour = aColour;
                vBelow = aBelow;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_Position.xy *= depthP(1.0);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            varying vec3 vColour;
            varying float vBelow;
            void main() {
                float edge = clamp(0.5 + vBelow / max(fwidth(vBelow), 1e-5), 0.0, 1.0);
                // Each ridge falls away to darker at its foot. The hills catch only the visible sky's faint airglow,
                // and must stay darker than the blacker skies of the other bands.
                float fall = mix(0.6, 1.0, exp(-max(vBelow, 0.0) / 1.4));
                float lit = mix(0.22, 1.0, uBandW[2]);
                gl_FragColor = vec4(vColour * fall * lit * uSkyFade, edge * uSkyFade);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.horizon;
    return { mesh, geometry, material };
}

export function createBackgroundLayer(engine, app) {
    const { renderer, scene } = engine;
    if (!renderer) return { id: 'background', update() {} };

    const bake = createSkyBake(engine);
    const horizon = buildHorizon();
    scene.add(horizon.mesh);
    let field = null;
    let placer = null;

    // The dome itself: one big triangle whose corners are camera rays
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const material = skyMaterial({
        uniforms: {
            tSky: { value: null },
            tDetail: { value: bake.detailTexture() },
            uMilkyWay: { value: 0 },
            uVisibleAmount: { value: 1 },
            uDeepFade: { value: new THREE.Vector3(0, 0, 0) },
            uDetailFade: { value: new THREE.Vector3(0, 0, 1) },
            uTan: { value: new THREE.Vector2(1, 1) },
            uDpr: { value: 1 },
            uDetailBias: { value: SMOOTH_DETAIL_BIAS },
            uSkyBias: { value: SMOOTH_SKY_BIAS }
        },
        vertexShader: /* glsl */`
            uniform vec2 uTan;
            varying vec3 vDir;
            void main() {
                vDir = transpose(mat3(viewMatrix)) * vec3(position.xy * uTan, -1.0);
                gl_Position = vec4(position.xy, 1.0, 1.0);
            }`,
        fragmentShader: SKY_FRAGMENT
    });
    const dome = new THREE.Mesh(geometry, material);
    dome.frustumCulled = false;
    dome.renderOrder = ORDER.background;
    scene.add(dome);

    // Until the first bake the dome is a dark sky with no Milky Way in it. The bake's program can take a moment to compile.
    let bakeReady = false;
    let bakeRun = 0;
    let starsWanted = !!app.layers.backgroundStars;
    let starsAmount = starsWanted ? 1 : 0;
    bake.setGrain(starsWanted);

    // Nothing is placed or drawn until the Background stars layer is first turned on
    let fieldRequested = false;
    function requestField() {
        if (field || fieldRequested || !bakeReady) return;
        fieldRequested = true;
        bake.readDensity().then((pixels) => {
            fieldRequested = false;
            if (pixels && !field) placer = fieldStarPlacer(pixels);
        });
    }

    function startBake() {
        const run = ++bakeRun;
        bakeReady = false;
        bake.compile().then(() => {
            if (run !== bakeRun) return;
            bake.drawDetail();
            bake.drawDensityMap();
            bakeReady = true;
            bake.want(BAKE_SIZE[app.qualityLevel]);
            if (starsWanted) requestField();
        });
    }
    startBake();

    const unbindLayer = bus.on('layer', ({ name, on }) => {
        if (name !== 'backgroundStars') return;
        starsWanted = on;
        bake.setGrain(on);
        if (on) requestField();
    });

    function applyQuality(level) {
        if (field) field.geometry.setDrawRange(0, FIELD_STARS[level]);
        if (bakeReady) bake.want(BAKE_SIZE[level]);
    }

    const unbindQuality = bus.on('quality', ({ level }) => applyQuality(level));
    const unbindRestored = bus.on('gl-restored', () => {
        bake.restart();
        startBake();
    });

    // A layer of deep stars fades in when its grid cells are big enough on screen to hold a star
    const fadeIn = (cellCssPx) => Math.min(1, Math.max(0, (cellCssPx - 6.5) / 4));
    const smooth = (a, b, x) => {
        const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
    };

    return {
        id: 'background',
        update(frame) {
            if (bake.busy() && engine.bakesAllowed()) bake.step();
            if (placer) {
                field = placer(4);
                if (field) {
                    placer = null;
                    field.geometry.setDrawRange(0, FIELD_STARS[app.qualityLevel]);
                    scene.add(field.points);
                }
            }
            const visible = frame.bandW[2];
            const skyFade = material.uniforms.uSkyFade.value;
            const amount = visible * skyFade;
            const starsGoal = starsWanted ? 1 : 0;
            if (frame.reduceMotion) starsAmount = starsGoal;
            else if (starsAmount !== starsGoal) {
                const step = frame.dt / STARS_FADE_S;
                starsAmount += Math.max(-step, Math.min(step, starsGoal - starsAmount));
            }
            dome.visible = amount > 0.002;
            if (field) field.points.visible = dome.visible && starsAmount > 0;
            horizon.mesh.visible = skyFade > 0.002;
            const u = material.uniforms;
            if (bake.texture()) {
                u.tSky.value = bake.texture();
                u.uMilkyWay.value = frame.reduceMotion ? 1 : Math.min(1, u.uMilkyWay.value + frame.dt / MILKY_WAY_FADE_S);
            } else {
                u.tSky.value = null;
                u.uMilkyWay.value = 0;
            }
            if (!dome.visible) return;
            u.uVisibleAmount.value = amount;
            u.uDpr.value = frame.dpr;
            // The dome lags behind the camera as much as anything can: it's the screen that has to come to it
            const parallax = parallaxFactor(1, frame.fov);
            const tanY = Math.tan(frame.fov * RAD * 0.5) / parallax;
            u.uTan.value.set(tanY * (frame.width / frame.height), tanY);
            const cssPerRad = (frame.pxPerRad * parallax) / frame.dpr;
            const low = frame.quality === 'low';
            // Low draws only the coarsest layer: enough not to feel empty, at almost no cost
            u.uDeepFade.value.set(
                fadeIn(cssPerRad / 458) * starsAmount,
                low ? 0 : fadeIn(cssPerRad / 1146) * starsAmount,
                low ? 0 : fadeIn(cssPerRad / 2865) * starsAmount
            );
            u.uDetailBias.value = SMOOTH_DETAIL_BIAS * (1 - starsAmount);
            u.uSkyBias.value = SMOOTH_SKY_BIAS * (1 - starsAmount);
            // Through a narrow field the glow resolves into stars, so less of it is left as glow. Without the stars,
            // it stays a glow, at every zoom
            const resolvedGlow = 0.42 + 0.58 * smooth(1.5, 25, frame.fov);
            u.uDetailFade.value.set(
                low ? 0 : smooth(36, 14, frame.fov),
                low ? 0 : smooth(9, 3, frame.fov),
                1 + (resolvedGlow - 1) * starsAmount
            );
            if (field) {
                field.material.uniforms.uDpr.value = frame.dpr;
                field.material.uniforms.uFieldAmount.value = visible * starsAmount;
            }
        },
        busy: () => bake.busy(),            // For tests: is the full-size bake still going?
        bakedSize: () => bake.size(),
        dispose() {
            bakeRun += 1;
            unbindQuality();
            unbindRestored();
            unbindLayer();
            [dome, horizon.mesh].forEach((o) => scene.remove(o));
            [geometry, horizon.geometry].forEach((g) => g.dispose());
            [material, horizon.material].forEach((m) => m.dispose());
            if (field) {
                scene.remove(field.points);
                field.geometry.dispose();
                field.material.dispose();
            }
            bake.dispose();
        }
    };
}
