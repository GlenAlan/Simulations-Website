// GLSL for the planet ubershader, as chunks that planet_mesh.js puts together. The pattern is worked out per pixel on the
// unit sphere; everything that can differ between planets is a uniform, so one program serves all planets of a model.
//
// Three kinds of program use these chunks:
//   live    works the surface out per pixel, for a planet that is large on screen
//   bake    writes the same surface into a cube map, for a small planet or at Low quality
//   baked   reads the cube map; much cheaper, and its mipmaps stop small planets shimmering
// The frame of all the shading is the planet's own, tilted but not spinning, with radius 1: see uCam and uSun.
//
// Each planet's programs are also built with only the features it has (see planetFeatures in planet_mesh.js): the P_ defines
// below take the rest out altogether. A feature it lacks would never run, but the compiler has to get through it all the
// same, and on Windows the whole solid surface takes it several seconds.

import { LOOP_ZERO_GLSL } from '../shared.js';
import { PLANET_BAND_GLSL } from './planet_bands.js';

const ROT_Y_GLSL = /* glsl */`
vec3 rotY(vec3 v, float a) {
    float c = cos(a);
    float s = sin(a);
    return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}
`;

export const NOISE_GLSL = /* glsl */`
${LOOP_ZERO_GLSL}
vec3 mod289(vec3 x) { return x - floor(x / 289.0) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x / 289.0) * 289.0; }
vec4 permute(vec4 x) { return mod289((x * 34.0 + 10.0) * x); }

// Simplex noise with its gradient. Ian McEwan, Ashima Arts, and Stefan Gustavson; MIT licence (github.com/stegu/webgl-noise)
float snoiseG(vec3 v, out vec3 gradient) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = 1.79284291400159 - 0.85373472095314 * vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;
    vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    vec4 m2 = m * m;
    vec4 m4 = m2 * m2;
    vec4 pdotx = vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
    vec4 temp = m2 * m * pdotx;
    gradient = -8.0 * (temp.x * x0 + temp.y * x1 + temp.z * x2 + temp.w * x3);
    gradient += m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
    gradient *= 105.0;
    return 105.0 * dot(m4, pdotx);
}

float snoise(vec3 v) {
    vec3 g;
    return snoiseG(v, g);
}

// An octave fades out as it gets finer than a pixel, so detail never aliases and small planets cost less.
// px is the size of a pixel in the units of p.
float octaveFade(float f, float px) {
    return 1.0 - smoothstep(0.3, 0.62, f * px);
}

float fbm(vec3 p, int oct, float px) {
    float sum = 0.0;
    float a = 0.5;
    float f = 1.0;
    for (int i = 0; i < oct + uLoopZero; i++) {
        float fade = octaveFade(f, px);
        if (fade <= 0.0) break;
        sum += a * fade * snoise(p * f);
        p += 7.13;
        a *= 0.5;
        f *= 2.03;
    }
    return sum;
}

// As fbm with more energy in the fine octaves: frayed, wispy edges once it is cut at a level
float fbmWispy(vec3 p, int oct, float px) {
    float sum = 0.0;
    float a = 0.5;
    float f = 1.0;
    for (int i = 0; i < oct + uLoopZero; i++) {
        float fade = octaveFade(f, px);
        if (fade <= 0.0) break;
        sum += a * fade * snoise(p * f);
        p += 7.13;
        a *= 0.58;
        f *= 2.07;
    }
    return sum;
}

// Streaks along the x-z plane that get rounder as they get finer, for flowing bands
float fbmFlow(vec3 p, int oct, float px) {
    float sum = 0.0;
    float a = 0.5;
    float f = 1.0;
    float fx = 1.0;
    for (int i = 0; i < oct + uLoopZero; i++) {
        float fade = octaveFade(f, px);
        if (fade <= 0.0) break;
        sum += a * fade * snoise(vec3(p.x * fx, p.y * f, p.z * fx));
        p += 7.13;
        a *= 0.56;
        f *= 2.03;
        fx *= 2.75;
    }
    return sum;
}

// As fbm, and also its gradient with respect to p, for shading relief without extra samples
float fbmD(vec3 p, int oct, float px, out vec3 grad) {
    float sum = 0.0;
    float a = 0.5;
    float f = 1.0;
    float slope = 1.0;
    grad = vec3(0.0);
    for (int i = 0; i < oct + uLoopZero; i++) {
        float fade = octaveFade(f, px);
        if (fade <= 0.0) break;
        vec3 g;
        sum += a * fade * snoiseG(p * f, g);
        grad += a * fade * f * g * slope;
        slope *= 0.74;      // Fine octaves are less steep than raw fractal noise, as in real terrain
        p += 7.13;
        a *= 0.5;
        f *= 2.03;
    }
    return sum;
}

// Sharp ridge lines, where each octave rides on the ridges of the one before
float ridgedD(vec3 p, int oct, float px, out vec3 grad) {
    float sum = 0.0;
    float a = 0.55;
    float f = 1.0;
    float weight = 1.0;
    float slope = 1.0;
    grad = vec3(0.0);
    for (int i = 0; i < oct + uLoopZero; i++) {
        float fade = octaveFade(f, px);
        if (fade <= 0.0) break;
        vec3 g;
        float n = snoiseG(p * f, g);
        float r = 1.0 - abs(n);
        r *= r;
        float k = a * fade * weight;
        sum += k * r;
        grad += k * f * 2.0 * (1.0 - abs(n)) * (n > 0.0 ? -g : g) * slope;
        slope *= 0.78;
        weight = clamp(r * 1.8, 0.0, 1.0);
        p += 5.31;
        a *= 0.5;
        f *= 2.09;
    }
    return sum;
}

vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
}

// Distances to the nearest and second nearest of a jittered lattice of points; y - x is near 0 along cell walls
vec2 voronoi(vec3 x) {
    vec3 n = floor(x);
    vec3 f = x - n;
    float d1 = 8.0;
    float d2 = 8.0;
    for (int k = -1; k <= 1 + uLoopZero; k++) {
        for (int j = -1; j <= 1 + uLoopZero; j++) {
            for (int i = -1; i <= 1 + uLoopZero; i++) {
                vec3 c = vec3(float(i), float(j), float(k));
                vec3 r = c + hash33(n + c) - f;
                float d = dot(r, r);
                if (d < d1) {
                    d2 = d1;
                    d1 = d;
                } else if (d < d2) {
                    d2 = d;
                }
            }
        }
    }
    return sqrt(vec2(d1, d2));
}

${ROT_Y_GLSL}

// Turns p about the axis c by an angle that falls away with distance from c: stirs bands and clouds into a vortex
vec3 swirl(vec3 p, vec3 c, float r, float amount) {
    float x = (1.0 - dot(p, c)) / (r * r * 0.5);
    if (x > 7.0) return p;
    float a = amount * exp(-x);
    float ca = cos(a);
    float sa = sin(a);
    return p * ca + cross(c, p) * sa + c * dot(c, p) * (1.0 - ca);
}
`;

export const STORMS_GLSL = /* glsl */`
#define MAX_STORMS 6
uniform int uStormN;
uniform vec4 uStormA[MAX_STORMS]; // Direction on the sphere and radius
uniform vec4 uStormB[MAX_STORMS]; // Swirl (radians), strength
`;

// What a surface generator hands to the shading: same fields whether computed live or read from the bake
export const SURF_GLSL = /* glsl */`
struct Surf {
    vec3 albedo;
    vec3 grad;       // Gradient of height, in the spinning frame
    float height;
    float water;     // 1 on open liquid
    float sheen;     // 1 on smooth ice
    float heat;      // 0 to 1, along the black-body glow of what is hot
    float cloud;     // Opacity of cloud
    float cloudTop;  // How sunlit the cloud top is
    float shadow;    // How much cloud blocks the sun at the ground
};

Surf newSurf() {
    Surf s;
    s.albedo = vec3(0.5);
    s.grad = vec3(0.0);
    s.height = 0.0;
    s.water = 0.0;
    s.sheen = 0.0;
    s.heat = 0.0;
    s.cloud = 0.0;
    s.cloudTop = 1.0;
    s.shadow = 0.0;
    return s;
}
`;

export const PATTERN_UNIFORMS = /* glsl */`
uniform vec3 uSeed;
uniform int uOct;
uniform float uPhase;
uniform float uLocked;   // 1 on a tidally locked world: then +x in the pattern's frame always points at the star
`;

// Thin features are drawn no thinner than a pixel, and fade to keep their weight, so they stay put at any size
const THIN_LINE_GLSL = /* glsl */`
float thinLine(float dist, float width, float px) {
    float w = max(width, px);
    return (1.0 - smoothstep(0.0, w, dist)) * min(1.0, width / w * 1.4);
}
`;

const CRATERS_GLSL = /* glsl */`
// One size of crater: every cell of a lattice may hold one. The nearest eight cells are all that can reach this point.
void craterScale(vec3 q, float scale, float amount, float depthK, inout float height, inout vec3 grad, inout vec3 albedo, float rays) {
    vec3 c = q * scale;
    vec3 base = floor(c - 0.5);
    for (int k = 0; k < 8 + uLoopZero; k++) {
        vec3 cell = base + vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
        vec3 r = hash33(cell + 19.1);
        if (r.x > amount) continue;
        vec3 centre = cell + hash33(cell);
        float rad = mix(0.12, 0.36, r.y * r.y);
        vec3 dv = c - centre;
        float d = length(dv);
        float x = d / rad;
        if (x > 1.45 && rays <= 0.0) continue;
        float fresh = r.z;
        float depth = rad / scale * depthK * mix(0.35, 1.0, fresh);
        // Bowl and raised rim
        float bowl = x < 1.0 ? x * x - 1.0 : 0.0;
        float dBowl = x < 1.0 ? 2.0 * x : 0.0;
        float rimWidth = 0.22;
        float rimX = (x - 1.0) / rimWidth;
        float rim = 0.32 * exp(-rimX * rimX);
        float dRim = rim * (-2.0 * rimX / rimWidth);
        height += depth * (bowl + rim);
        if (d > 1e-4) grad += scale * depth * (dBowl + dRim) / rad * (dv / d);
        // New craters have bright floors and ejecta, old ones have weathered away
        float glow = exp(-x * x * 0.55) * smoothstep(0.5, 1.0, fresh);
        albedo *= 1.0 + 0.55 * glow;
        albedo *= mix(1.0, 0.8, (1.0 - smoothstep(0.86, 1.0, x)) * mix(0.5, 1.0, fresh));
        if (rays > 0.0 && fresh > 0.72 && x < 7.0) {
            // Bright splash lines radiating from the youngest
            vec3 dirn = dv / max(d, 1e-4);
            float spokes = snoise(dirn * 7.0 + cell);
            float line = smoothstep(0.34, 0.8, spokes) * exp(-x * 0.55) * smoothstep(0.9, 1.3, x);
            albedo *= 1.0 + rays * line * 0.75;
        }
    }
}
`;

export const SOLID_GLSL = /* glsl */`
uniform vec3 uRockA;
uniform vec3 uRockB;
uniform vec3 uRockC;
uniform vec3 uIce;
uniform vec3 uLine;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uLeaf;
uniform vec3 uLeafDry;
uniform float uSea;
uniform float uLiquid;
uniform float uVegetation;
uniform float uCraters;
uniform float uRidges;
uniform float uCanyons;
uniform float uMaria;
uniform float uDunes;
uniform float uSalt;
uniform float uCracks;
uniform float uPlains;
uniform float uLava;
uniform float uDayMelt;
uniform float uMelt;
uniform float uCap;
uniform float uFrost;
${THIN_LINE_GLSL}
${CRATERS_GLSL}
const float CRATER_SCALE[5] = float[5](2.1, 4.9, 10.3, 22.0, 47.0);
const float CRATER_SHIFT[5] = float[5](0.0, 5.0, 11.0, 17.0, 29.0);
const float CRATER_AMOUNT[5] = float[5](0.8, 0.85, 1.0, 1.0, 1.0);
const float CRATER_DEPTH[5] = float[5](1.05, 0.95, 0.7, 0.65, 0.6);
const float CRATER_PX[5] = float[5](1e9, 0.05, 0.022, 0.011, 0.005);    // Each size only where a pixel is small enough to show it
const int CRATER_OCT[5] = int[5](0, 0, 0, 5, 6);                        // And the finest only at the higher levels

// Long arcs that cross one another, as tides crack a shell: circles on the sphere, each shown along part of its length
float arcLines(vec3 p, float px, float width, out float wide) {
    float best = 0.0;
    wide = 0.0;
    for (int i = 0; i < 12 + uLoopZero; i++) {
        vec3 h = hash33(uSeed + float(i) * 7.3);
        vec3 axis = normalize(h - 0.5);
        float offset = (fract(h.x * 17.0 + h.y * 31.0) - 0.5) * 1.1;
        float d = abs(dot(p, axis) - offset);
        if (d > 0.12) continue;
        float mask = smoothstep(-0.3, 0.05, snoise(p * 1.1 + h * 40.0));
        float w = width * mix(0.55, 1.4, h.z);
        best = max(best, thinLine(d, w, px) * mask);
        wide = max(wide, thinLine(d, w * 3.2, px) * mask);
    }
    return best;
}

void solidSurface(vec3 p, float px, inout Surf s) {
    vec3 q = p + uSeed;
    // Everything large is warped by the same field, so features curve together and do not look like raw noise
    vec3 wv = vec3(snoise(q * 1.3), snoise(q * 1.3 + 31.7), snoise(q * 1.3 - 17.3));

    // Only the large octaves are warped: warping the fine ones would draw them out into streaks
    vec3 grad;
    float elev = fbmD(q * 0.95 + wv * 0.32, 3, px * 0.95, grad);
    float elevSmooth = elev;
    grad *= 0.95;
    if (uOct > 3) {
        vec3 gh;
        float eh = fbmD(q * 6.5 + wv * 0.25 + 13.0, uOct - 3, px * 6.5, gh);
        elev += eh * 0.22;
        grad += gh * 6.5 * 0.22 * 0.3;
    }
    float e = elev - uSea;
    float height = elev;

    float tone = fbm(q * 1.7 + wv * 0.16 + 5.0, min(uOct, 5), px * 1.7);
    float fine = fbm(q * 8.0 + 3.0, min(uOct, 4), px * 8.0);

    vec3 rock = mix(uRockA, uRockB, smoothstep(-0.05, 0.42, tone + 0.22 * fine) * 0.85);
    rock = mix(rock, uRockC, smoothstep(0.02, 0.36, -tone + 0.3 * fine) * 0.5);
    rock *= 1.0 + 0.16 * fine;
    float craterAmount = uCraters;

#ifdef P_MARIA
    if (uMaria > 0.0) {
        // Old dark lava plains in the low ground, with fewer craters on them
        float plain = smoothstep(-0.02, 0.12, -elev - 0.06 + fine * 0.08) * uMaria;
        rock = mix(rock, uRockB * 0.68, plain);
        rock = mix(rock, uRockC, smoothstep(0.1, 0.4, elev) * 0.35);
        craterAmount *= 1.0 - 0.55 * plain;
        grad *= 1.0 - 0.7 * plain;
    }
#endif

#ifdef P_RIDGES
    if (uRidges > 0.0) {
        vec3 gr;
        float r = ridgedD(q * 3.1 + wv * 0.15, min(uOct, 6), px * 3.1, gr);
        float inland = uLiquid > 0.0 ? smoothstep(0.015, 0.14, e) : smoothstep(-0.2, 0.28, elev + fine * 0.2);
        float k = uRidges * inland * 0.5;
        height += k * r;
        grad += k * gr * 3.1;
        rock = mix(rock, mix(uRockB, uRockC, smoothstep(0.32, 0.62, r)), k * 1.1);
    }
#endif

#ifdef P_CANYONS
    if (uCanyons > 0.0) {
        // A rift system: fractal ridged lines, narrow and only in one long region
        vec3 gc;
        float where = smoothstep(0.26, 0.52, snoise(vec3(q.x * 0.55, q.y * 1.5, q.z * 0.55) - 13.0));
        if (where > 0.0) {
            float r = ridgedD(vec3(q.x * 0.9, q.y * 3.0, q.z * 0.9) + wv * 0.2 + 41.0, 4, px * 3.0, gc);
            float rift = smoothstep(0.54, 0.74, r) * where * uCanyons;
            rock = mix(rock, uRockB * 0.7, rift * 0.8);
            height -= 0.16 * rift;
            grad -= 0.12 * rift * vec3(gc.x * 0.9, gc.y * 3.0, gc.z * 0.9);
        }
    }
#endif

#ifdef P_DUNES
    if (uDunes > 0.0) {
        // Dune seas: stripes along a wind that wanders, kept to the low basins
        vec3 z = q + wv * 0.75;
        z = vec3(z.x * 7.0, z.y * 46.0, z.z * 7.0);
        vec3 gd;
        float ripple = snoiseG(z, gd);
        float fade = octaveFade(46.0, px);
        float basin = smoothstep(0.14, -0.08, elev + tone * 0.25);
        float k = uDunes * basin * fade;
        rock = mix(rock, mix(uRockB, uRockC, 0.5 + 0.5 * ripple), k * 0.16);
        grad += 0.006 * k * vec3(gd.x * 7.0, gd.y * 46.0, gd.z * 7.0);
        rock = mix(rock, uRockC, uSalt * smoothstep(0.05, 0.14, -elev - 0.16 + fine * 0.12) * 0.75);
    }
#endif

#ifdef P_CRACKS
    if (uCracks > 0.0) {
        // A bright cracked shell: blue-white mottling, long ridged lines over it, and plates split by fractures
        rock = mix(uRockA, uRockB, smoothstep(0.02, 0.42, tone + 0.2 * fine) * 0.8);
        rock = mix(rock, uRockC, smoothstep(0.05, 0.36, -tone) * 0.7);
        vec3 ql = q + wv * 0.14;
        vec3 g2;
        vec3 g3;
        float n2 = snoiseG(ql * 2.7 + 7.0, g2);
        float n3 = snoiseG(ql * 7.3 - 3.0, g3);
        vec3 pw = normalize(p + wv * 0.018);
        float band;
        float l1 = arcLines(pw, px, 0.0065, band);
        float l2 = thinLine(abs(n2), 0.02, px * 2.7) * smoothstep(-0.25, 0.2, tone);
        float l3 = thinLine(abs(n3), 0.035, px * 7.3) * smoothstep(0.0, 0.45, tone);
        float lines = max(l1, max(l2 * 0.5, l3 * 0.32));
        rock = mix(rock, uLine, lines * 0.85 * uCracks);
        // Each crack has a stained band either side of it
        rock = mix(rock, mix(uRockB, uLine, 0.25), band * 0.5 * (1.0 - l1) * uCracks);
        vec2 v = voronoi(ql * 3.1 + 9.0);
        float plates = thinLine(v.y - v.x, 0.028, px * 3.1) * 0.55 * uCracks;
        rock = mix(rock, uRockB * 0.55, plates);
        height *= 0.1;
        grad = grad * 0.1 + (n2 > 0.0 ? -g2 : g2) * 2.7 * l2 * 0.02;
        s.sheen = 1.0 - lines;
    }
#endif

#ifdef P_PLAINS
    if (uPlains > 0.0) {
        // A wide smooth basin of bright nitrogen ice, cut into slow convection cells, among dark red tholin uplands
        float lobes = snoise(q * 0.72 + wv * 0.35 + 3.0) + 0.14 * fine;
        float basin = smoothstep(0.1, 0.17, lobes);
        vec2 v = voronoi(q * 11.0 + wv * 0.8);
        float wall = thinLine(v.y - v.x, 0.09, px * 11.0);
        vec3 ice = uIce * mix(1.0, 0.86, wall);
        // Bright frost on the highlands, dark tholin stain in a belt around the equator
        float belt = smoothstep(0.55, 0.15, abs(p.y) + tone * 0.35);
        rock = mix(rock, uRockB * 0.9, belt * 0.7);
        rock = mix(rock, uRockC, smoothstep(0.03, 0.3, elev + fine * 0.2 - belt * 0.2) * 0.75);
        rock = mix(rock, ice, basin);
        craterAmount *= 1.0 - basin;
        grad *= 1.0 - 0.92 * basin;
        height = mix(height, elevSmooth, 0.92 * basin);
        s.sheen = basin * 0.5;
    }
#endif

    float heat = 0.0;
#ifdef P_LAVA
    if (uLava > 0.0) {
        // Dark plates of crust, floating on melt that shows in the cracks and in pools
        vec3 pl = q * 2.3 + wv * 0.5;
        vec2 v1 = voronoi(pl);
        vec2 v2 = voronoi(pl * 2.9 + 4.0);
        float edge1 = v1.y - v1.x;
        float edge2 = v2.y - v2.x;
        float crack1 = thinLine(edge1, 0.075, px * 2.3);
        float crack2 = thinLine(edge2, 0.075, px * 6.7);
        float core1 = thinLine(edge1, 0.026, px * 2.3);
        float poolField = fbm(q * 1.25 + wv * 0.5 + 2.0, 4, px * 1.25) + 0.12 * fine;
        // Facing the star the melt spreads into an ocean; the far side is mostly solid crust
        float facing = uLocked * (smoothstep(0.35, 1.0, p.x) * 0.26 - smoothstep(-0.05, -0.7, p.x) * 0.12);
        float pool = smoothstep(uMelt, uMelt + 0.1, poolField + facing);
        float churn = 0.5 + 0.5 * fbm(q * 5.5 + wv * 1.3, min(uOct, 4), px * 5.5);
        // Crust cools darker towards the middle of each plate
        float plateAge = smoothstep(0.0, 0.45, edge1);
        rock = mix(uRockA * 1.4, uRockB * 0.5, plateAge);
        rock = mix(rock, uRockB, smoothstep(-0.1, 0.4, fine));
        heat = max(crack1 * 0.4, max(core1 * 0.7, crack2 * 0.28 * smoothstep(0.1, 0.75, churn)));
        heat *= mix(1.0, mix(0.68, 1.0, smoothstep(-0.7, 0.3, p.x)), uLocked);
        heat = max(heat, pool * mix(0.34, 0.8, churn * churn));
        rock *= 1.0 - pool * 0.9;
        grad = grad * 0.5 * (1.0 - pool);
        height += 0.08 * plateAge;
        craterAmount = 0.0;
    }
#endif

#ifdef P_DAY_MELT
    if (uDayMelt > 0.0) {
        float reach = mix(0.985, 0.87, uDayMelt);    // Cosine of how far from the point under the star it has melted
        float towards = p.x + 0.05 * fine + 0.05 * tone;
        float pond = smoothstep(reach, reach + 0.025, towards);
        float margin = smoothstep(reach - 0.2, reach, towards);
        vec2 v = voronoi(q * 5.0 + wv * 0.4);
        float crack = thinLine(v.y - v.x, 0.07, px * 5.0) * margin;
        heat = max(heat, max(pond * (0.36 + 0.34 * smoothstep(-0.3, 0.4, fine)), crack * 0.34));
        rock = mix(rock, uRockB * 0.6, margin * 0.7);
        rock *= 1.0 - 0.92 * pond;
        craterAmount *= 1.0 - margin;
        grad *= 1.0 - 0.8 * margin;
    }
#endif

#ifdef P_CRATERS
    if (craterAmount > 0.002) {
        float big = smoothstep(0.0, 0.2, craterAmount);
        float amt = clamp(craterAmount * 1.15, 0.0, 0.95);
        vec3 qc = q + wv * 0.02;
        float h = 0.0;
        vec3 g = vec3(0.0);
        vec3 tint = vec3(1.0);
        // Five sizes in a loop and not five calls, because each call is compiled in full
        float rays = uMaria > 0.0 || uCraters > 0.8 ? 1.0 : 0.25;
        for (int i = 0; i < 5 + uLoopZero; i++) {
            if (px >= CRATER_PX[i] || uOct < CRATER_OCT[i]) continue;
            craterScale(qc + CRATER_SHIFT[i], CRATER_SCALE[i], amt * CRATER_AMOUNT[i], CRATER_DEPTH[i], h, g, tint, i == 0 ? rays : 0.0);
        }
        height += h * big;
        grad += g * big;
        rock = mix(rock, rock * tint, big);
    }
#endif

#ifdef P_FROST
    if (uFrost > 0.0) {
        float f = smoothstep(0.42, -0.1, fine + elev * 0.8);
        rock = mix(rock, uIce, uFrost * f);
    }
#endif

    s.heat = heat;

    float water = 0.0;
    vec3 ground = rock;
#ifdef P_LIQUID
    if (uLiquid > 0.0) {
        float aa = max(px * 0.6, 0.0025);
        // Dark rock with life on it: leafy land wet near coasts and in storm tracks, thinner in the dry belts
#ifdef P_VEGETATION
        if (uVegetation > 0.0) {
            float lat = abs(p.y);
            float climate = 0.32 * cos(lat * 9.0) + 0.1;
            float moisture = fbm(q * 3.3 - 11.0 + wv * 0.5, min(uOct, 5), px * 3.3);
            float coast = smoothstep(0.34, 0.02, e);
            float wet = moisture * 1.1 + climate + coast * 0.3;
            float growth = smoothstep(-0.2, 0.25, wet) * smoothstep(0.48, 0.22, e) * smoothstep(0.92, 0.74, lat);
            vec3 leaf = mix(uLeafDry, uLeaf, smoothstep(-0.05, 0.42, wet + fine * 0.3));
            ground = mix(ground, leaf, uVegetation * growth * 0.95);
        }
#endif
        float land = smoothstep(-aa, aa, e + 0.018 * fine);
        float shelf = smoothstep(-0.05, -0.001, e + 0.01 * fine);
        vec3 sea = mix(uDeep, uShallow, shelf * shelf * shelf * 0.8);
        sea *= 0.86 + 0.28 * smoothstep(-0.4, 0.4, tone);
        ground = mix(sea, ground, land);
        water = 1.0 - land;
        grad *= land;
        height = mix(0.0, max(height - uSea, 0.0), land);
    }
#endif

#ifdef P_CAP
    if (uCap > 0.0) {
        float cap = smoothstep(0.0, 0.05, abs(p.y) - (1.0 - uCap) + 0.09 * tone + 0.04 * fine);
        ground = mix(ground, uIce * (0.9 + 0.12 * fine), cap);
        water *= 1.0 - cap;
        grad *= 1.0 - 0.75 * cap;
        s.sheen = max(s.sheen, cap * 0.35);
    }
#endif

    s.albedo = ground;
    s.grad = grad;
    s.height = height;
    s.water = water;
}
`;

export const CLOUD_GLSL = /* glsl */`
uniform float uCloudLevel;
uniform float uCloudOpacity;
uniform float uCloudSoft;
uniform float uCloudSwirl;
uniform float uCloudStreak;
uniform float uCloudAlt;
uniform float uCloudVeil;
uniform float uFlow;

// Everything about the cloud at a point: x is the height field, y a fine texture, z the thin high veil's opacity
vec3 cloudSample(vec3 p, int oct, float px) {
    vec3 sp = p;
    for (int i = 0; i < uStormN; i++) sp = swirl(sp, uStormA[i].xyz, uStormA[i].w, uStormB[i].x * uCloudSwirl);
    float stretch = 1.0 + uCloudStreak;
    vec3 q = vec3(sp.x, sp.y * stretch, sp.z) * 1.8 + uSeed * 1.37 + vec3(uFlow * 0.12, 0.0, -uFlow * 0.08);
    // Slow, wide warping draws the big masses out into fronts; the fine detail is left unsmeared
    vec3 warp = vec3(snoise(q * 0.7 + 11.0), snoise(q * 0.7 + 23.0), snoise(q * 0.7 - 7.0));
    float f = fbm(q + warp * 0.6, min(oct, 3), px * 1.8 * stretch);
    float grain = 0.0;
    float veil = 0.0;
    if (oct > 3) {
        vec3 d = vec3(sp.x, sp.y * mix(stretch, 1.0, 0.6), sp.z) * 10.0 + uSeed * 2.1 + warp * 0.7;
        float detail = fbmWispy(d, oct - 2, px * 10.0);
        // Detail bites hardest near the edge of a cloud mass, so edges fray while cores stay solid
        float nearEdge = 1.0 - smoothstep(0.0, 0.3, abs(f - uCloudLevel));
        f += detail * mix(0.13, 0.34, nearEdge);
        grain = detail;
    }
    // Wet tropics and storm tracks, dry subtropics, in proportion to how much the air stirs
    f += 0.1 * uCloudSwirl * cos(p.y * 9.4);
#ifdef P_VEIL
    if (uCloudVeil > 0.0 && oct > 3) {
        vec3 c = vec3(sp.x * 3.4, sp.y * 13.0, sp.z * 3.4) + uSeed * 0.9 + warp * 0.9;
        float where = smoothstep(0.0, 0.5, snoise(q * 0.45 - 31.0));
        veil = smoothstep(-0.08, 0.5, fbmFlow(c, min(oct, 6), px * 13.0)) * where * uCloudVeil;
    }
#endif
    return vec3(f, grain, veil);
}

// Optical depth grows from nothing at the level, slowly at first: thin frayed edges, building to an opaque core
float cloudOpacity(float f) {
    float t = max(f - uCloudLevel, 0.0) / uCloudSoft;
    return 1.0 - exp(-t * t * 1.3 - t * 0.5);
}

void cloudLayer(vec3 pc, vec3 sunC, float px, inout Surf s) {
    vec3 c = cloudSample(pc, uOct, px);
    float thick = cloudOpacity(c.x);
    s.cloud = (1.0 - (1.0 - thick * uCloudOpacity) * (1.0 - c.z));
    // One look towards the sun gives both the shading of the cloud tops and the shadow on the ground
    vec3 towards = normalize(pc + (sunC - pc * dot(pc, sunC)) * uCloudAlt * 3.0);
    vec3 c2 = cloudSample(towards, min(uOct, 3), max(px, 0.008));
    float rise = c.x - c2.x;
    s.cloudTop = clamp(0.8 + 1.0 * rise + 0.42 * c.y, 0.25, 1.0);
    s.shadow = cloudOpacity(c2.x) * uCloudOpacity;
}
`;

export const ENVELOPE_GLSL = /* glsl */`
uniform vec3 uZone;
uniform vec3 uBelt;
uniform vec3 uAccent;
uniform vec3 uStormCol;
uniform float uBands;
uniform float uBandN;
uniform float uTurb;
uniform float uStretch;
uniform float uWobble;
uniform float uDetail;
uniform float uCirrus;
uniform float uPolar;
uniform float uChevron;
uniform float uJetT;

float bandHash(float i) {
    return fract(sin(i * 12.9898 + uPhase) * 43758.5453);
}

// Each jet turns as a rigid ring at its own speed, so nothing shears out of shape however long you watch.
// Rings cross-fade where they meet, at the band edges where the colour is changing anyway.
float jetRate(float i) {
    return (mod(i, 2.0) < 1.0 ? 1.0 : -1.0) * (0.75 + 0.25 * sin(i * 2.4 + uPhase));
}

vec2 bandLayer(vec3 p, float i, float px) {
    vec3 r = rotY(p, uJetT * jetRate(i) + i * 1.7);
    vec3 z = vec3(r.x * 2.4, r.y * uStretch, r.z * 2.4) + uSeed + i * vec3(3.1, 0.0, 1.7);
    float pxz = px * uStretch;
    // Eddies, large then small, fold the streaks inside them. The warmer the giant, the more they curl.
    vec2 w = vec2(snoise(z * 0.8), snoise(z * 0.8 + 41.0));
    vec3 zw = z + vec3(w.x, w.y * 0.5, w.y) * uTurb * 1.5;
    if (uOct >= 5) {
        vec2 w2 = vec2(snoise(zw * 2.6 + 3.0), snoise(zw * 2.6 - 17.0));
        zw += vec3(w2.x, w2.y * 0.6, w2.y) * uTurb * 0.55;
    }
    float n = fbmFlow(zw, uOct, pxz);
    // Small round storms ride in the bands: the rare peaks of a noise with round features
    float spot = snoise(vec3(r.x * 6.5, r.y * 15.0, r.z * 6.5) + i * vec3(5.1, 0.0, 2.3) + uSeed * 1.3);
    return vec2(n, spot);
}

float bandValue(float i) {
    return mod(i, 2.0) < 1.0 ? 0.12 + 0.34 * bandHash(i) : 0.62 + 0.38 * bandHash(i);
}

void envelopeSurface(vec3 p, float px, inout Surf s) {
    vec3 sp = p;
    float stormMask = 0.0;
    float stormEdge = 0.0;
    for (int i = 0; i < uStormN; i++) {
        vec3 c = uStormA[i].xyz;
        float r = uStormA[i].w;
        float ang2 = 2.0 * (1.0 - dot(p, c));
        // An oval, stretched along the jets
        vec3 dv = p - c;
        float ovalD = dv.y * dv.y / (r * r * 0.34) + (ang2 - dv.y * dv.y) / (r * r);
        float m = uStormB[i].y * (1.0 - smoothstep(0.5, 1.05, ovalD));
        stormEdge = max(stormEdge, uStormB[i].y * exp(-(ovalD - 1.0) * (ovalD - 1.0) * 1.6));
        stormMask = max(stormMask, m);
        sp = swirl(sp, c, r * 1.3, uStormB[i].x);
    }

    float lat = asin(clamp(sp.y, -1.0, 1.0)) / 1.5708;
    float warped = lat + 0.05 * sin(lat * 6.0 + uPhase) + 0.03 * sin(lat * 11.0 + uPhase * 2.3);

    vec3 wq = vec3(sp.x * 3.0, sp.y * 8.0, sp.z * 3.0) + uSeed * 0.7;
    float wob = fbm(wq, min(uOct, 4), px * 8.0);
    float xb = (warped * 0.5 + 0.5) * uBandN + wob * uWobble * 1.7;
    if (uChevron > 0.0) {
        // Upper-level winds sweep the deck into broad sideways Vs, pointing the way the planet turns
        float sinLon = sp.z / max(length(sp.xz), 0.001);
        xb += uChevron * abs(lat) * (0.9 + 0.5 * sinLon) * sign(lat);
    }

    float xe = xb - 0.5;
    float i0 = floor(xe);
    float fr = xe - i0;
    float k = smoothstep(0.36, 0.64, fr);
    vec2 a = bandLayer(sp, i0, px);
    vec2 b = (k > 0.002 && k < 0.998) ? bandLayer(sp, i0 + 1.0, px) : a;
    float n = mix(a.x, b.x, k);

    float v = mix(bandValue(i0), bandValue(i0 + 1.0), k);
    // Fine stripes inside each band
    float sub = snoise(vec3(wob * 0.8, xb * 3.1, uPhase)) * 0.6 + snoise(vec3(wob * 1.3, xb * 7.3, uPhase + 3.0)) * 0.3;
    float subFade = octaveFade(uBandN * 3.0, px);
    // Belts are the rougher, zones calmer
    float rough = mix(1.2, 0.72, v);
    float tone = clamp(mix(0.55, v, uBands) + uDetail * (n * 0.46 * rough + 0.14 * sub * subFade), 0.0, 1.0);
    vec3 col = tone < 0.5 ? mix(uBelt, uAccent, tone * 2.0) : mix(uAccent, uZone, tone * 2.0 - 1.0);

    // Tints that belong to a band, like the rust of Jupiter's equatorial belt
    float acc = mix(bandHash(i0 + 9.0), bandHash(i0 + 10.0), k);
    col = mix(col, uStormCol, smoothstep(0.72, 1.0, acc) * 0.22 * uBands * smoothstep(-0.2, 0.3, n));

    // Bright ovals with dark collars
    float spot = mix(a.y, b.y, k);
    float ovals = uChevron > 0.0 ? 0.0 : uTurb;
    float oval = smoothstep(0.8, 0.87, spot) * ovals * 1.3;
    float collar = (smoothstep(0.66, 0.8, spot) - smoothstep(0.8, 0.87, spot)) * ovals * 0.3;
    col = mix(col, uBelt, clamp(collar, 0.0, 1.0) * octaveFade(15.0, px) * uBands);
    col = mix(col, uZone, clamp(oval, 0.0, 1.0) * octaveFade(15.0, px) * uBands);

    // Dim, mottled polar hoods
    float polar = uPolar * smoothstep(0.55, 0.95, abs(lat) + n * 0.12);
    col = mix(col, mix(uBelt, uAccent, 0.5) * 0.82, polar * 0.75);

    if (uStormN > 0) {
        col = mix(col, uStormCol, stormMask * (0.72 + 0.5 * n));
        col = mix(col, uZone, stormEdge * 0.35 * (1.0 - stormMask));
    }

#ifdef P_CIRRUS
    if (uCirrus > 0.0) {
        // Sparse bright methane cirrus, high above the haze
        vec3 cq = vec3(sp.x * 1.7, sp.y * 12.0, sp.z * 1.7) + uSeed * 1.9;
        float belt = smoothstep(0.05, 0.45, snoise(vec3(lat * 4.5, uPhase, 3.0)));
        float clump = smoothstep(-0.25, 0.4, snoise(cq * 0.3));
        float c = smoothstep(-0.05, 0.42, fbm(cq, min(uOct, 5), px * 12.0));
        col = mix(col, vec3(0.92, 0.96, 1.0), uCirrus * belt * clump * c * 0.6);
    }
#endif

    s.albedo = col;
    float heat = clamp(0.34 + 0.55 * v + 0.28 * n, 0.0, 1.0);
    if (uLocked > 0.0) heat *= mix(0.62, 1.22, smoothstep(-0.55, 0.9, dot(p, vec3(0.906, 0.0, 0.423))));
    s.heat = clamp(heat, 0.0, 1.0);
}
`;

export const ATMOSPHERE_GLSL = /* glsl */`
uniform float uH;
uniform float uTop;
uniform vec3 uBetaR;
uniform vec3 uBetaM;
uniform vec3 uBetaA;
uniform float uMieG;
uniform float uAtmGain;
uniform float uSunHaze;
uniform int uAtmSteps;

// Gas column towards the sun from a height, in scale heights: Christian Schueler's fit to the Chapman function.
// The second branch is the far side of the planet: it runs huge and puts the point in the planet's shadow.
float chapman(float X, float h, float cosChi) {
    float c = sqrt(X + h);
    if (cosChi >= 0.0) return c / (c * cosChi + 1.0) * exp(-h);
    float x0 = sqrt(max(1.0 - cosChi * cosChi, 0.0)) * (X + h);
    float c0 = sqrt(x0);
    return 2.0 * c0 * exp(min(X - x0, 30.0)) - c / (1.0 - c * cosChi) * exp(-h);
}

// Single scattering from t0 to t1 along a ray. Returns the light added and the fraction of light from behind let through.
vec3 scatterAlong(vec3 ro, vec3 rd, float t0, float t1, vec3 sun, vec3 sunCol, out vec3 through, out float column) {
    float X = 1.0 / uH;
    float dt = (t1 - t0) / float(uAtmSteps);
    float mu = dot(rd, sun);
    float mu2 = mu * mu;
    float pR = 0.0597 * (1.0 + mu2);
    float g2 = uMieG * uMieG;
    float pM = 0.1194 * (1.0 - g2) * (1.0 + mu2) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * uMieG * mu, 1e-3), 1.5));
    vec3 ext = uBetaR + uBetaM + uBetaA;
    vec3 sumR = vec3(0.0);
    vec3 sumM = vec3(0.0);
    column = 0.0;
    for (int i = 0; i < uAtmSteps; i++) {
        vec3 p = ro + rd * (t0 + (float(i) + 0.5) * dt);
        float r = length(p);
        float h = max(r - 1.0, 0.0) / uH;
        float rho = exp(-h) * dt;
        column += 0.5 * rho;
        float toSun = uH * chapman(X, h, dot(p, sun) / r);
        vec3 att = exp(-ext * (column * 0.45 + toSun * 0.4));
        sumR += att * rho;
        sumM += att * rho;
        column += 0.5 * rho;
    }
    through = exp(-ext * column);
    return sunCol * uAtmGain * (sumR * uBetaR * pR + sumM * uBetaM * pM);
}
`;

const RING_SHADOW_GLSL = /* glsl */`
uniform sampler2D tRing;
uniform float uRingIn;
uniform float uRingOut;
uniform float uRingOpacity;
`;

// What the planet draws: shared by live and baked, after they have filled in a Surf.
export const SHADE_GLSL = /* glsl */`
uniform vec3 uSunCol;
uniform vec3 uRimCol;
uniform float uHazeGlow;
uniform float uRim;
uniform float uRimPower;
uniform float uRegolith;
uniform float uWrap;
uniform float uIsEnvelope;
uniform float uRelief;
uniform float uLimbDark;
uniform vec3 uCloudCol;
uniform vec3 uCloudShade;
uniform vec3 uEmitCool;
uniform vec3 uEmitWarm;
uniform vec3 uEmitHot;
uniform float uHasEmit;
uniform float uSpin;
uniform float uOpacity;
uniform float uHasRings;
${RING_SHADOW_GLSL}
${PLANET_BAND_GLSL}

vec3 glowOf(float heat) {
    vec3 c = mix(uEmitCool, uEmitWarm, smoothstep(0.0, 0.55, heat));
    c = mix(c, uEmitHot, smoothstep(0.55, 1.0, heat));
    return c * smoothstep(0.0, 0.12, heat);
}

vec4 shadePlanet(Surf s, vec3 P, vec3 ro, vec3 rd, float tHit, float coverage, vec3 extraGrad) {
    vec3 L = uSun;
    vec3 gradB = rotY(s.grad, -uSpin) + extraGrad;
    gradB -= P * dot(gradB, P);
    // Relief fades out at the limb, where tilted normals would go dark in bites out of a clean round edge
    float facing = max(dot(P, -rd), 0.0);
    vec3 N = normalize(P - gradB * uRelief * 0.12 * smoothstep(0.0, 0.3, facing));
    float muS = dot(P, L);
    float NL = max(dot(N, L), 0.0);
    float NV = max(dot(N, -rd), 0.015);

    // Sunlight at the ground, reddened by the air it came through
    vec3 sunAt = uSunCol;
    if (uH > 0.0) {
        // Scattering only takes out part of the beam: most of the light still arrives, from all over the sky
        vec3 ext = uBetaR * 0.5 + uBetaM * uSunHaze + uBetaA;
        sunAt *= exp(-ext * uH * chapman(1.0 / uH, 0.0, muS));
    }
    sunAt *= smoothstep(-0.015, 0.01, muS + uWrap * 0.5);

    if (uHasRings > 0.0 && L.y * P.y < 0.0) {
        // Shadow of the rings on the planet
        vec3 q = P + L * (-P.y / L.y);
        float r = length(q.xz);
        float u = (r - uRingIn) / (uRingOut - uRingIn);
        if (u > 0.0 && u < 1.0) sunAt *= 1.0 - 0.88 * uRingOpacity * textureLod(tRing, vec2(u, 0.5), 2.0).r;
    }

    float diffuse;
    if (uIsEnvelope > 0.0) {
        // A thick cloud top: soft-edged terminator and limb darkening (Minnaert)
        float wrapped = max((dot(N, L) + uWrap) / (1.0 + uWrap), 0.0);
        diffuse = pow(wrapped, 0.95) * pow(max(NV, 0.04), uLimbDark);
    } else {
        // Bare regolith barely darkens towards the limb, as on the Moon (Lommel-Seeliger); air and ground, like Lambert
        float ls = 2.0 * NL / (NL + NV + 0.02);
        diffuse = mix(NL, ls * 0.62, uRegolith);
    }

    vec3 col = s.albedo * sunAt * diffuse * (1.0 - s.shadow * 0.72);

    // Starlight from the rest of the sky, so that a night side is never a hole, and a thin edge to keep its outline by
    float nightSide = 1.0 - smoothstep(-0.1, 0.25, muS);
    col += s.albedo * uSunCol * 0.035;
    col += uSunCol * pow(1.0 - facing, 7.0) * 0.07 * nightSide;

    if (s.water > 0.002 || s.sheen > 0.002) {
        // Sun glint on open water: a tight core with a wide warm sheen round it. Smooth ice gets a weak broad gleam.
        vec3 H = normalize(L - rd);
        float NH = max(dot(N, H), 0.0);
        float VH = max(dot(-rd, H), 0.0);
        float F = 0.022 + 0.978 * pow(1.0 - VH, 5.0);
        float core = pow(NH, 1100.0) * 80.0;
        float wide = pow(NH, 150.0) * 7.0;
        float faint = pow(NH, 22.0) * 0.2;
        float glint = (core + wide + faint) * F * s.water;
        float gleam = (pow(NH, 60.0) * 0.5 + pow(NH, 8.0) * 0.07) * s.sheen;
        col += sunAt * (glint + gleam) * step(0.0, muS) * (1.0 - s.shadow * 0.85);
    }

    if (s.cloud > 0.001) {
        float wrapC = max((dot(P, L) + 0.08) / 1.08, 0.0);
        float lit = pow(wrapC, 0.8) * mix(1.0, pow(NV, 0.08), 0.5);
        vec3 c = mix(uCloudShade, uCloudCol, s.cloudTop) * lit * 1.12;
        col = mix(col, c * sunAt, s.cloud);
    }

    if (uHasEmit > 0.0) col += glowOf(s.heat) * (1.0 - s.cloud);

    // Air between us and the ground
    vec3 added = vec3(0.0);
    if (uAtmSteps > 0 && uH > 0.0) {
        float bb = dot(ro, rd);
        float cc = dot(ro, ro) - uTop * uTop;
        float disc = bb * bb - cc;
        if (disc > 0.0) {
            float t0 = max(-bb - sqrt(disc), 0.0);
            vec3 through;
            float column;
            added = scatterAlong(ro, rd, t0, max(tHit, t0 + 1e-4), L, uSunCol, through, column);
            // A bright haze near the limb stands in for light scattered more than once
            vec3 lost = 1.0 - exp(-(uBetaR + uBetaM) * column);
            added *= mix(0.45, 1.0, lost.g);
            // Thin air gets a lot of gain so as to show at the limb. Over the middle of the disc that only tints the ground.
            added *= 1.0 - 0.65 * smoothstep(2.1, 2.7, uAtmGain) * smoothstep(0.25, 0.85, facing);
            added += lost * lost * uRimCol * uHazeGlow * smoothstep(-0.06, 0.45, muS);
            col = col * mix(through, vec3(1.0), 0.45) + added;
        }
    } else if (uRim > 0.0) {
        // Low quality: a Fresnel rim instead of the shell
        float rim = pow(1.0 - max(dot(P, -rd), 0.0), uRimPower) * uRim;
        col += uRimCol * (rim * 0.75 + 0.03 * uRim) * smoothstep(-0.12, 0.45, muS);
    }

    // In the sky's band: planet_bands.js
    col = bandShade(col, s.albedo, s.heat * uHasEmit * (1.0 - s.cloud), P, L, facing);

    // Partly covered edge pixels are drawn here: the far half of the atmosphere shows through them
    return vec4(col * coverage + bandReflect(added, uBandReflect) * (1.0 - coverage), coverage) * uOpacity;
}
`;

export const BODY_VERTEX = /* glsl */`
uniform float uInflate;
varying vec3 vLocal;
void main() {
    vLocal = position * uInflate;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BODY_HEAD = /* glsl */`
uniform vec3 uCam;
uniform vec3 uSun;
varying vec3 vLocal;
`;

// The sphere is worked out exactly, not from its polygons: the mesh only says where to draw, a little oversize,
// and the true edge is anti-aliased here. Small planets stay round and steady without any MSAA.
const RAY_SPHERE_GLSL = /* glsl */`
    vec3 ro = uCam;
    vec3 rd = normalize(vLocal - uCam);
    float b = dot(ro, rd);
    float dist = sqrt(max(dot(ro, ro) - b * b, 0.0));
    float fw = max(fwidth(dist), 1e-6);
    float coverage = clamp((1.0 - dist) / fw + 0.5, 0.0, 1.0);
    if (coverage <= 0.0) discard;
    float disc = b * b - dot(ro, ro) + 1.0;
    float tHit = disc > 0.0 ? -b - sqrt(disc) : -b;
    vec3 P = normalize(ro + rd * tHit);
    float px = clamp(length(fwidth(P)) * 0.75, 1e-4, 1.0);
`;

export function liveBodyFragment(model) {
    const solid = model === 'solid';
    return /* glsl */`
${BODY_HEAD}
${PATTERN_UNIFORMS}
${NOISE_GLSL}
${STORMS_GLSL}
${SURF_GLSL}
${solid ? SOLID_GLSL : ENVELOPE_GLSL}
${solid ? CLOUD_GLSL : ''}
uniform float uCloudSpin;
${ATMOSPHERE_GLSL}
${SHADE_GLSL}

void main() {
${RAY_SPHERE_GLSL}
    Surf s = newSurf();
    vec3 pB = rotY(P, uSpin);
    vec3 extra = vec3(0.0);
    ${solid ? /* glsl */`
    solidSurface(pB, px, s);
#ifdef P_LIQUID
    if (s.water > 0.002 && px < 0.03) {
        // Ripples break up the glint, more strongly where the wind blows
        vec3 g1;
        vec3 g2;
        snoiseG(pB * 90.0 + uSeed, g1);
        snoiseG(pB * 31.0 - uSeed, g2);
        float gust = 0.6 + 0.4 * snoise(pB * 4.0 + uSeed);
        extra = rotY(g1 * 0.0009 + g2 * 0.0026, -uSpin) * gust * s.water * (1.0 - smoothstep(0.004, 0.03, px));
        extra /= max(uRelief * 0.12, 1e-3);
    }
#endif
#ifdef P_CLOUDS
    if (uCloudOpacity > 0.0) cloudLayer(rotY(P, uCloudSpin), rotY(uSun, uCloudSpin), px, s);
#endif
    ` : /* glsl */`
    envelopeSurface(pB, px, s);
    `}
    gl_FragColor = shadePlanet(s, P, ro, rd, tHit, coverage, extra);
}
`;
}

export const BAKED_BODY_FRAGMENT = /* glsl */`
${BODY_HEAD}
uniform samplerCube tSurface;
uniform samplerCube tExtras;
uniform float uBakeTexel;
uniform float uBakeMix;      // 0 until the planet's bake is done: a flat disc in its average colours, so an orbit is never empty
uniform vec3 uFlatAlbedo;
uniform float uFlatCloud;
uniform float uCloudSpin;
uniform float uCloudAlt;
uniform float uCloudOpacity;
${ROT_Y_GLSL}
${SURF_GLSL}
${ATMOSPHERE_GLSL}
${SHADE_GLSL}

void main() {
${RAY_SPHERE_GLSL}
    Surf s = newSurf();
    vec3 pB = rotY(P, uSpin);
    vec4 a = textureCube(tSurface, pB);
    vec4 e = textureCube(tExtras, pB);
    s.albedo = mix(uFlatAlbedo, a.rgb, uBakeMix);
    s.heat = e.b * uBakeMix;
    s.water = clamp((e.a - 0.52) / 0.48, 0.0, 1.0) * uBakeMix;
    s.sheen = clamp(e.a / 0.48, 0.0, 1.0) * (1.0 - step(0.5, e.a)) * uBakeMix;
    // Relief from the stored height, by finite differences: smooth even when texels are magnified
    vec3 t1 = normalize(cross(abs(pB.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), pB));
    vec3 t2 = cross(pB, t1);
    float reach = max(uBakeTexel * 1.5, px);
    float lod = log2(reach / uBakeTexel);
    float hx = textureLod(tSurface, pB + t1 * reach, lod).a - textureLod(tSurface, pB - t1 * reach, lod).a;
    float hy = textureLod(tSurface, pB + t2 * reach, lod).a - textureLod(tSurface, pB - t2 * reach, lod).a;
    s.grad = (t1 * hx + t2 * hy) / (2.0 * reach) * 0.45 * uBakeMix;
    vec3 extra = vec3(0.0);
    if (uCloudOpacity > 0.0) {
        vec3 pC = rotY(P, uCloudSpin);
        vec3 sunC = rotY(uSun, uCloudSpin);
        vec4 ec = textureCube(tExtras, pC);
        vec3 towards = normalize(pC + (sunC - pC * dot(pC, sunC)) * uCloudAlt * 3.0);
        float d2 = textureCube(tExtras, towards).r;
        s.cloud = mix(uFlatCloud, ec.r, uBakeMix);
        s.cloudTop = mix(1.0, clamp(ec.g * 1.0, 0.35, 1.0), uBakeMix);
        s.shadow = d2 * uBakeMix;
    }
    gl_FragColor = shadePlanet(s, P, ro, rd, tHit, coverage, extra);
}
`;

// Writes the pattern into one face of a cube map. uLayer 0: colour and height, in half floats.
// uLayer 1: cloud opacity, cloud-top shading, heat, and water or sheen sharing the last channel.
export function bakeFragment(model) {
    const solid = model === 'solid';
    return /* glsl */`
uniform mat3 uFace;
uniform int uLayer;
uniform float uBakePx;
uniform vec3 uSun;
varying vec2 vFace;
${PATTERN_UNIFORMS}
${NOISE_GLSL}
${STORMS_GLSL}
${SURF_GLSL}
${solid ? SOLID_GLSL : ENVELOPE_GLSL}
${solid ? CLOUD_GLSL : ''}

void main() {
    vec3 P = normalize(uFace * vec3(vFace, 1.0));
    Surf s = newSurf();
    ${solid ? /* glsl */`
    solidSurface(P, uBakePx, s);
#ifdef P_CLOUDS
    if (uLayer != 0 && uCloudOpacity > 0.0) {
        // Lit from straight above: the sun's real angle is applied when it is drawn
        vec3 c = cloudSample(P, uOct, uBakePx);
        s.cloud = 1.0 - (1.0 - cloudOpacity(c.x) * uCloudOpacity) * (1.0 - c.z);
        s.cloudTop = clamp(0.8 + 0.5 * (c.x - uCloudLevel) + 0.42 * c.y, 0.25, 1.0);
    }
#endif
    ` : /* glsl */`
    envelopeSurface(P, uBakePx, s);
    `}
    if (uLayer == 0) {
        gl_FragColor = vec4(max(s.albedo, vec3(0.0)), s.height);
    } else {
        float last = s.water > 0.002 ? 0.52 + 0.48 * s.water : 0.48 * s.sheen;
        gl_FragColor = vec4(s.cloud, s.cloudTop, s.heat, last);
    }
}
`;
}

export const BAKE_VERTEX = /* glsl */`
varying vec2 vFace;
void main() {
    vFace = position.xy;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// The glow beyond the planet's edge. Inside the disc the body draws its own atmosphere, and its depth hides this.
export const SHELL_VERTEX = /* glsl */`
uniform float uShellR;
varying vec3 vLocal;
void main() {
    vLocal = position * uShellR;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const SHELL_FRAGMENT = /* glsl */`
uniform vec3 uCam;
uniform vec3 uSun;
uniform vec3 uSunCol;
uniform float uOpacity;
varying vec3 vLocal;
${ATMOSPHERE_GLSL}
${PLANET_BAND_GLSL}

void main() {
    vec3 ro = uCam;
    vec3 rd = normalize(vLocal - uCam);
    float b = dot(ro, rd);
    float c = dot(ro, ro) - uTop * uTop;
    float disc = b * b - c;
    if (disc <= 0.0) discard;
    float s = sqrt(disc);
    float t0 = max(-b - s, 0.0);
    float t1 = -b + s;
    float d2 = b * b - dot(ro, ro) + 1.0;
    if (d2 > 0.0) t1 = min(t1, -b - sqrt(d2));
    if (t1 <= t0) discard;
    vec3 through;
    float column;
    vec3 added = scatterAlong(ro, rd, t0, t1, uSun, uSunCol, through, column);
    float a = 1.0 - dot(through, vec3(0.3333));
    gl_FragColor = vec4(bandReflect(added, uBandReflect), a) * uOpacity;
}
`;

export const RING_VERTEX = /* glsl */`
varying vec3 vLocal;
void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const RING_FRAGMENT = /* glsl */`
uniform vec3 uCam;
uniform vec3 uSun;
uniform vec3 uSunCol;
uniform vec3 uRingCol;
uniform vec3 uRingDark;
uniform float uOpacity;
${RING_SHADOW_GLSL}
${PLANET_BAND_GLSL}
varying vec3 vLocal;

void main() {
    float r = length(vLocal.xz);
    float u = (r - uRingIn) / (uRingOut - uRingIn);
    if (u <= 0.0 || u >= 1.0) discard;
    vec4 t = texture2D(tRing, vec2(u, 0.5));
    float op = t.r * uRingOpacity;

    // In the planet's shadow?
    float along = dot(vLocal, uSun);
    float off = length(vLocal - uSun * along);
    float shadow = along < 0.0 ? smoothstep(0.985, 1.02, off) : 1.0;

    // From the unlit face, thick parts go dark and thin parts glow with light passing through
    vec3 V = normalize(uCam - vLocal);
    float sameSide = uSun.y * V.y >= 0.0 ? 1.0 : 0.0;
    float incidence = pow(abs(uSun.y), 0.35);
    float lit = mix((1.0 - op) * 1.3 + 0.08, 0.28 + 0.92 * incidence, sameSide);
    float phase = 0.85 + 0.35 * pow(max(dot(uSun, V), 0.0), 3.0);
    vec3 col = mix(uRingDark, uRingCol, t.g) * uSunCol * shadow * lit * phase;
    gl_FragColor = vec4(bandReflect(col, uBandReflect) * op, op) * uOpacity;
}
`;
