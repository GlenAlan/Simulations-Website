// Paints one galaxy into a texture on the GPU, in steps small enough to spread over frames.
//
//   1. Map: the disc seen from straight above, as four maps of young stars, dust, old stars and glowing hydrogen.
//      Spiral arms follow the density-wave pattern: the logarithmic spiral th = ln(r / r0) / tan(pitch), m-fold.
//   2. View: a ray through the tilted disc for each pixel, so that light and dust add up properly along the line
//      of sight. That is what gives an edge-on spiral its dust lane, and lets the near side cross in front of the bulge.
//   3. Particles: star clouds, glowing knots and individual bright stars on top, along the same arms and dimmed by
//      whatever dust lies in front of them.
//   4. Resolve: square-root encoded into 8 bits per channel, which costs half the memory of half floats and shows no bands.
//
// The result is two images: A = visible RGB and ultraviolet; B = infrared, radio, X-ray. The particles are made from
// nothing but their index in the vertex shader, so no CPU time or memory goes on them, and the same seed gives the
// same particles at every size.

import * as THREE from 'three';
import { Rng } from '../../core/rng.js';
import { LOOP_ZERO_GLSL } from '../shared.js';

export const IMAGE_R = 1.2;                   // The bake covers this far from the centre; the galaxy's edge is at 1
export const BAKE_SCALE = { a: 8, b: 6 };      // Brightest linear values image A and image B hold

const RAD = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;

// Everything about how one galaxy looks. The physical fields decide what it is; the seed varies only the pattern.
export function galaxyRecipe(body) {
    const g = body.galaxy;
    const rng = new Rng(`galaxy:${body.visual_seed}`);
    const kind = g.morphology === 'elliptical' ? 1 : g.morphology === 'irregular' ? 2 : 0;
    const r = {
        kind,
        seed: rng.int(1, 2 ** 30),
        off: [rng.range(0, 90), rng.range(0, 90), rng.range(0, 90), rng.range(0, 90)],
        hand: rng.chance(0.5) ? 1 : -1,
        incl: Math.min(g.inclination_deg, 88) * RAD,
        // A little redder the further away: redshift moves the blue light out of the visible band
        redden: Math.max(0, Math.min(0.5, g.z || 0)),
        starburst: !!g.starburst,
        arms: 2, pitch: 0.3, phase: rng.range(0, Math.PI * 2), armK: 1, barLen: 0, flocc: 0,
        rd: 0.24, rdY: 0.34, young: 1, dust: 0.8, warp: rng.range(-0.05, 0.05),
        hOld: 0.05, hYoung: 0.014, hDust: 0.02,
        bulgeRe: 0.1, bulgeL: 0.6, bulgeN: 2.5, bulgeQ: 0.8,
        boxy: 2, shells: 0, laneDust: 0
    };
    if (kind === 0) {
        // t runs from an early type, all bulge and tight arms, to a late type, all disc and open arms
        const t = rng.next();
        const style = rng.weighted([['grand', 4], ['barred', 3], ['multi', 3], ['flocculent', 2]]);
        r.arms = style === 'multi' ? rng.int(3, 4) : 2;
        r.pitch = lerp(14, 28, t) * RAD * rng.range(0.92, 1.08);
        r.armK = style === 'grand' ? 1 : style === 'barred' ? 0.95 : style === 'multi' ? 0.75 : 0.45;
        r.flocc = style === 'flocculent' ? 0.75 : 0.12;
        r.barLen = style === 'barred' ? rng.range(0.17, 0.3) : 0;
        r.rd = lerp(0.2, 0.27, t);
        r.rdY = lerp(0.3, 0.42, t);
        r.young = lerp(0.45, 1.25, t);
        r.dust = lerp(1.0, 0.75, t) * rng.range(0.85, 1.2);
        r.bulgeRe = lerp(0.14, 0.05, t) * rng.range(0.9, 1.15);
        r.bulgeL = lerp(0.7, 0.42, t);
        r.bulgeN = lerp(3.4, 1.7, t);
        r.bulgeQ = rng.range(0.7, 0.9);
    } else if (kind === 1) {
        r.bulgeRe = rng.range(0.2, 0.34);
        r.bulgeL = rng.range(0.2, 0.3);
        r.bulgeN = rng.range(2.4, 4);
        // How round it really is, then how round it looks from this direction
        r.bulgeQ = rng.range(0.5, 0.95);
        r.boxy = rng.range(1.85, 2.2);
        r.shells = rng.chance(0.18) ? rng.range(0.5, 1) : 0;
        r.laneDust = rng.chance(0.14) ? rng.range(0.5, 1.1) : 0;
    } else {
        r.incl *= 0.65;
        r.young = rng.range(0.28, 0.4);
        r.dust = rng.range(0.5, 0.9);
        r.hOld = 0.07;
        r.hYoung = 0.026;
        r.hDust = 0.035;
        r.bulgeRe = 0.0;
        r.bulgeL = 0.0;
    }
    return r;
}

// 1 at or below b, 0 at or above a. (smoothstep with its edges reversed is undefined in GLSL.)
export const FALL_GLSL = /* glsl */`
float fall(float a, float b, float x) {
    return 1.0 - smoothstep(b, a, x);
}
`;

const NOISE_GLSL = /* glsl */`
${FALL_GLSL}
${LOOP_ZERO_GLSL}
float h21(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}
float h31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}
// The corners of the cell in loops rather than written out, for the compiler's sake: see LOOP_ZERO_GLSL
float vn2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float sum = 0.0;
    for (int c = 0; c < 4 + uLoopZero; c++) {
        vec2 o = vec2(float(c & 1), float((c >> 1) & 1));
        vec2 w = mix(1.0 - f, f, o);
        sum += w.x * w.y * h21(i + o);
    }
    return sum;
}
float vn3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float sum = 0.0;
    for (int c = 0; c < 8 + uLoopZero; c++) {
        vec3 o = vec3(float(c & 1), float((c >> 1) & 1), float((c >> 2) & 1));
        vec3 w = mix(1.0 - f, f, o);
        sum += w.x * w.y * w.z * h31(i + o);
    }
    return sum;
}
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
float fbm2(vec2 p, int oct) {
    float a = 0.5, s = 0.0, n = 0.0;
    for (int i = 0; i < oct + uLoopZero; i++) {
        s += a * vn2(p);
        n += a;
        a *= 0.5;
        p = ROT * p * 2.03 + 11.7;
    }
    return s / n;
}
float fbm3(vec3 p, int oct) {
    float a = 0.5, s = 0.0, n = 0.0;
    for (int i = 0; i < oct + uLoopZero; i++) {
        s += a * vn3(p);
        n += a;
        a *= 0.5;
        p = vec3(ROT * p.xy, p.z).yzx * 2.03 + 7.3;
    }
    return s / n;
}
`;

const PCG_GLSL = /* glsl */`
uint pcg(uint v) {
    uint s = v * 747796405u + 2891336453u;
    uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}
float rnd(inout uint st) {
    st = pcg(st);
    return float(st) * (1.0 / 4294967296.0);
}
float gaussian(inout uint st) {
    float u = 1.0 - rnd(st);
    float v = rnd(st);
    return sqrt(-2.0 * log(u)) * cos(6.2831853 * v);
}
// A radius drawn from an exponential disc of scale rd, cut off at rMax
float expRadius(inout uint st, float rd, float rMax) {
    float c = 1.0 - exp(-rMax / rd);
    return -rd * log(1.0 - rnd(st) * c);
}
`;

const QUAD_VERT = /* glsl */`
out vec2 vP;
void main() {
    vP = position.xy;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// The disc as seen from straight above. Output: young stars, dust column, old stars, glowing hydrogen.
const MAP_FRAG = /* glsl */`
precision highp float;
in vec2 vP;
uniform vec4 uOff;
uniform float uKind, uArms, uPitch, uPhase, uArmK, uBarLen, uRd, uRdY, uDust, uFlocc, uYoung, uMapR, uHand;
uniform int uOct;
out vec4 outMap;
${NOISE_GLSL}

vec4 spiral(vec2 p) {
    float R = length(p);
    // Warps at two scales, so no arm is a perfect curve or a tidy ribbon
    vec2 w = vec2(fbm2(p * 2.4 + uOff.xy, 3), fbm2(p * 2.4 + uOff.zw, 3)) - 0.5;
    vec2 w2 = vec2(fbm2(p * 8.0 + uOff.yz, 3), fbm2(p * 8.0 + uOff.wx, 3)) - 0.5;
    vec2 q = p + w * 0.15 + w2 * 0.035;
    float r = length(q) + 1e-3;
    float th = atan(q.y, q.x);
    float r0 = max(uBarLen, 0.09);
    float u = log(max(r, r0 * 0.5) / r0);
    float phi = th - u / tan(uPitch);       // Constant along a spiral arm
    float psi = uArms * phi + uPhase;       // An arm's crest is where this is a multiple of 2 pi
    float cphi = cos(phi);
    float sphi = sin(phi);

    // Noise in (angle round the pattern, ln radius) streaks along the arms; cos and sin keep it seamless
    float streak = fbm3(vec3(cphi * 6.0, sphi * 6.0, u * 1.2) + uOff.xyz, uOct);
    float life = fbm3(vec3(cphi * 1.5, sphi * 1.5, u * 1.3) + uOff.yzw, 3);
    float girth = fbm3(vec3(cphi * 2.0, sphi * 2.0, u * 2.1) + uOff.wzy, 3);
    float patches = smoothstep(0.42, 0.72, fbm3(vec3(cphi * 8.0, sphi * 8.0, u * 3.2) + uOff.zxy, 4));

    float arm = 0.5 + 0.5 * cos(psi);
    float sharp = mix(mix(1.8, 3.8, uArmK), mix(3.0, 8.5, uArmK), smoothstep(0.32, 0.68, girth));
    float crest = pow(arm, sharp);
    crest *= mix(0.3, 1.35, smoothstep(0.3, 0.66, life));
    // A weaker extra arm that comes and goes, as real spirals have
    float extra = pow(0.5 + 0.5 * cos((uArms + 1.0) * phi + uOff.x), 7.0) * smoothstep(0.5, 0.75, life + 0.3 * patches);
    crest += 0.32 * extra * uArmK;
    crest = mix(crest, patches * 1.1, uFlocc);

    // Feathers: short spurs that leave the arms at a steeper angle
    float phiSpur = th - u / tan(min(uPitch * 2.6, 1.2));
    float spur = pow(0.5 + 0.5 * cos(phiSpur * 13.0 + 4.0 * w.x), 3.0);
    float spurPatch = smoothstep(0.42, 0.7, fbm2(q * 5.0 + uOff.xw, 3));

    float env = smoothstep(r0 * 0.6, r0 * 2.6, r) * (0.35 + 0.65 * smoothstep(0.08, 0.5, r)) * exp(-r / uRdY) * fall(1.06, 0.62, r);
    float complexes = fbm2(q * 13.0 + uOff.wx, uOct);
    float fine = fbm2(q * 44.0 + uOff.zw, uOct);
    float young = env * (crest * (0.12 + 2.3 * streak * streak + 5.0 * pow(complexes, 3.0))
        + 0.03 + 0.2 * (1.0 - uArmK) * complexes
        + 0.22 * spur * spurPatch * (0.3 + crest));
    young *= 0.55 + 0.9 * fine;

    // Dust lanes hug the inner edge of each arm, where gas piles up as it runs into the wave
    float lane = pow(0.5 + 0.5 * cos(psi - 0.55), mix(2.5, 6.0, uArmK));
    float ridge = 1.0 - abs(2.0 * fbm3(vec3(cphi * 11.0, sphi * 11.0, u * 2.6) + uOff.xzw, uOct) - 1.0);
    ridge = ridge * ridge * ridge;
    float wisps = fbm2(q * 8.0 + uOff.yw, uOct);
    float web = 1.0 - abs(2.0 * fbm2(q * 17.0 + uOff.xy + w2 * 3.0, uOct) - 1.0);
    web = web * web * web * web;
    float dust = exp(-r / 0.72) * smoothstep(0.012, r0 * 0.75, r) * fall(1.06, 0.72, r)
        * (lane * (0.8 + 6.5 * ridge) * mix(0.5, 1.2, life)
            + (0.45 + 0.8 * uFlocc) * wisps * wisps * 3.5
            + 2.2 * web * (0.25 + lane)
            + 0.9 * spur * spurPatch * ridge);

    // Dust breaks up at the finest scales too
    float grain = fbm2(q * 46.0 + w2 * 5.0 + uOff.yx, uOct);
    dust *= 0.35 + 2.6 * grain * grain;

    float mottle = fbm2(q * 28.0 + uOff.zy, uOct);
    float rim = fall(1.0, 0.45, R + 0.28 * (w.x + w.y));
    float old = exp(-R / uRd) * rim * (0.95 + 0.5 * arm * arm * uArmK + 0.5 * (mottle - 0.5));

    if (uBarLen > 0.0) {
        float a = -uPhase / uArms;
        vec2 b = mat2(cos(a), -sin(a), sin(a), cos(a)) * q;
        float along = exp(-pow(abs(b.x) / uBarLen, 3.0));
        old += 1.7 * along * exp(-pow(abs(b.y) / (uBarLen * 0.26), 2.0));
        // A straight dust lane along each leading edge of the bar
        dust += 1.4 * along * exp(-pow((abs(b.y) - uBarLen * 0.2) / (uBarLen * 0.045), 2.0)) * (0.3 + wisps);
        // Young stars have been swept out of the bar, and gather in a ring round its ends
        young *= smoothstep(0.0, 1.0, r / uBarLen);
        young += 0.5 * exp(-pow((r - uBarLen * 1.02) / 0.022, 2.0)) * (0.3 + 2.0 * complexes * complexes);
    }

    float hii = env * crest * smoothstep(0.62, 0.8, complexes) * 0.9;
    // Dust sits among the stars: dim what's behind it here, and let the ray do the rest
    float veil = exp(-dust * 0.3);
    return vec4(young * uYoung * veil, dust * uDust, old * veil, hii * uYoung * veil);
}

vec4 irregular(vec2 p) {
    // No arms: a lopsided bar of old stars and clumps of new ones wherever the noise piles up
    vec2 w = vec2(fbm2(p * 1.6 + uOff.xy, 3), fbm2(p * 1.6 + uOff.zw, 3)) - 0.5;
    vec2 q = p + w * 0.6;
    vec2 k = q * vec2(1.25, 2.0);
    float e = exp(-dot(k, k) * 2.0);
    float n = fbm2(q * 4.6 + uOff.yx, uOct);
    float m = fbm2(q * 12.0 + uOff.wz, uOct);
    float clump = smoothstep(0.4, 0.72, n);
    float young = e * (0.14 + 3.0 * clump * clump * (0.35 + m));
    float hii = e * smoothstep(0.6, 0.82, n * 0.7 + m * 0.45) * 2.8;
    float dust = e * pow(1.0 - n, 3.0) * 2.0 * (0.4 + m);
    float old = e * (0.42 + 0.5 * n);
    return vec4(young * uYoung, dust * uDust, old * 0.32, hii * uYoung);
}

void main() {
    vec2 p = vP * uMapR;
    p.y *= uHand;
    outMap = uKind > 1.5 ? irregular(p) : spiral(p);
}`;

// Light and dust along a ray through the tilted galaxy
const VIEW_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
in vec2 vP;
uniform sampler2D tMap;
uniform float uKind, uCi, uSi, uImageR, uMapR, uMapLod, uDs, uHOld, uHYoung, uHDust, uRedden, uWarp, uBurst, uHand;
uniform float uBulgeRe, uBulgeL, uBulgeN, uBulgeQ, uBoxy, uShells, uLane;
uniform vec4 uOff;
layout(location = 0) out vec4 gA;
layout(location = 1) out vec4 gB;
${NOISE_GLSL}

// Dust dims blue more than red, ultraviolet most, infrared hardly at all
const vec3 KVIS = vec3(0.86, 1.0, 1.16);
const float KUV = 1.7;
const float KIR = 0.22;
const vec3 COL_OLD = vec3(1.0, 0.8, 0.58);
const vec3 COL_YOUNG = vec3(0.24, 0.48, 1.4);
const vec3 COL_HII = vec3(1.45, 0.32, 0.5);
const vec3 COL_BULGE = vec3(1.0, 0.74, 0.44);

// What fraction of a soft-cored bulge's light along the ray lies in front of depth s
float bulgeBefore(float s, float a) {
    float u = s / a;
    return 0.5 + (atan(u) + u / (1.0 + u * u)) / 3.14159265;
}

// A Sersic profile, gentled at the very centre so that it doesn't reduce to one blazing pixel
float sersic(float r, float re, float n) {
    float b = 2.0 * n - 0.33;
    float x = sqrt(r * r + 0.00002) / max(re, 1e-3);
    return exp(-b * (pow(x, 1.0 / n) - 1.0));
}

float softCap(float x, float cap) {
    return x / (1.0 + x / cap);
}

vec3 reddened(vec3 c) {
    return c * vec3(1.0, 1.0 - 0.45 * uRedden, 1.0 - 0.9 * uRedden);
}

void disc(vec2 p, out vec3 vis, out float uvLight, out float ir, out float radio, out vec3 tBulge) {
    vis = vec3(0.0);
    uvLight = 0.0;
    ir = 0.0;
    radio = 0.0;
    const float ZMAX = 0.26;
    const float BOUND = 1.22;
    float b2 = dot(p, p);
    float s0 = -sqrt(max(BOUND * BOUND - b2, 0.0));
    float s1 = -s0;
    float z0 = -p.y * uSi;
    s0 = max(s0, (-ZMAX - z0) / max(uCi, 1e-3));
    s1 = min(s1, (ZMAX - z0) / max(uCi, 1e-3));
    if (s1 <= s0) {
        tBulge = vec3(1.0);
        return;
    }
    float a = sqrt(uBulgeRe * uBulgeRe * 1.3 + b2);
    float len = s1 - s0;
    int n = int(clamp(ceil(len / uDs), 6.0, 150.0));
    float ds = len / float(n);
    float s = s0 + ds * h21(gl_FragCoord.xy + uOff.xy);
    float tau = 0.0;
    float before = bulgeBefore(s0, a);
    tBulge = vec3(before);
    for (int i = 0; i < n; i++) {
        vec3 pos = vec3(p.x, p.y * uCi + s * uSi, z0 + s * uCi);
        float R = length(pos.xy);
        // A slight warp at the rim, as most big discs have
        float z = pos.z - uWarp * R * R * pos.x;
        vec4 m = textureLod(tMap, pos.xy / (2.0 * uMapR) + 0.5, uMapLod);
        float hOld = uHOld * (1.0 + 0.8 * R);
        float sech = 1.0 / cosh(z / hOld);
        float eOld = m.b * sech * sech / (2.0 * hOld);
        float hY = uHYoung * (1.0 + 0.6 * R);
        float prof = exp(-0.5 * z * z / (hY * hY)) / (2.5066 * hY);
        float hD = uHDust * (1.0 + 1.3 * R);
        float dz = exp(-0.5 * z * z / (hD * hD)) / (2.5066 * hD);
        // Seen nearly edge-on, the dust gathers into the dark lane along the disc
        float dTau = m.g * dz * ds * (1.0 + 0.9 * smoothstep(0.82, 0.97, uSi));
        float mid = tau + 0.5 * dTau;
        vec3 T = exp(-mid * KVIS);
        vis += T * (eOld * COL_OLD * 0.34 + prof * (m.r * COL_YOUNG * 0.2 + m.a * COL_HII * 0.2)) * ds;
        uvLight += exp(-mid * KUV) * prof * (m.r + 0.35 * m.a) * ds;
        // Infrared: old stars, plus dust warmed by the young stars around it
        ir += exp(-mid * KIR) * (eOld * 0.2 + m.g * dz * (0.05 + uBurst * (0.1 + 0.9 * m.r))) * ds;
        radio += prof * (m.r + m.a) * ds;
        float next = bulgeBefore(s + 0.5 * ds, a);
        tBulge += (next - before) * T;
        before = next;
        tau += dTau;
        s += ds;
    }
    tBulge += (1.0 - before) * exp(-tau * KVIS);
}

void main() {
    vec2 p = vP * uImageR;
    vec3 vis = vec3(0.0);
    float uvLight = 0.0;
    float ir = 0.0;
    float radio = 0.0;
    float xray = 0.0;
    if (uKind > 0.5 && uKind < 1.5) {
        // Elliptical: a smooth Sersic gradient, redder and richer in the middle
        float qApp = sqrt(uBulgeQ * uBulgeQ * uSi * uSi + uCi * uCi);
        vec2 e = abs(vec2(p.x, p.y / qApp));
        float r = pow(pow(e.x, uBoxy) + pow(e.y, uBoxy), 1.0 / uBoxy);
        float I = sersic(r, uBulgeRe, uBulgeN) * uBulgeL * fall(1.12, 0.62, r);
        float t = smoothstep(0.0, 0.7, r);
        vec3 col = mix(vec3(1.0, 0.72, 0.42), vec3(0.98, 0.84, 0.68), t);
        // Faint outer shells, left by a smaller galaxy it swallowed long ago
        if (uShells > 0.0) {
            float ang = atan(p.y / qApp, p.x) + 0.6 * sin(uOff.x);
            float phase = log(r + 0.02) * 15.0 + uOff.y;
            float wave = pow(0.5 + 0.5 * cos(phase), 8.0);
            // Each shell is an arc, on its own side of the galaxy, or the rings would look like a lens's ghost
            float arc = pow(0.5 + 0.5 * cos(ang + 2.4 * floor(phase / 6.2831853 + 0.5)), 3.0);
            I += uShells * 0.02 * wave * smoothstep(0.18, 0.4, r) * fall(1.1, 0.6, r) * arc;
        }
        float T = 1.0;
        float irDust = 0.0;
        if (uLane > 0.0) {
            // A dust lane across the waist, for the few that have recently taken in a gassy neighbour
            float y = p.y + 0.05 * sin(p.x * 5.0 + uOff.z) + 0.12 * (fbm2(p * 5.0 + uOff.xy, 4) - 0.5);
            float tau = uLane * 3.0 * exp(-pow(y / 0.035, 2.0)) * fall(0.62, 0.18, abs(p.x)) * (0.4 + 1.2 * fbm2(p * 22.0 + uOff.zw, 4));
            T = exp(-tau);
            irDust = tau * 0.14;
        }
        vis = softCap(I * T, 4.5) * col;
        uvLight = softCap(I, 3.0) * 0.015;
        ir = softCap(I, 3.5) * 0.75 + irDust;
        xray = 0.012 * sqrt(sersic(r, uBulgeRe * 2.2, 1.5)) * fall(1.12, 0.5, r);   // Hot gas filling the galaxy
    } else {
        vec3 tB = vec3(1.0);
        disc(p, vis, uvLight, ir, radio, tB);
        if (uBulgeL > 0.0) {
            float qApp = sqrt(uBulgeQ * uBulgeQ * uSi * uSi + uCi * uCi);
            float r = length(vec2(p.x, p.y / qApp));
            float I = softCap(sersic(r, uBulgeRe, uBulgeN) * uBulgeL, 5.0) * fall(1.05, 0.4, r);
            vis += I * COL_BULGE * tB;
            uvLight += I * 0.012 * tB.b;
            ir += I * 0.65;
        }
        // A faint round halo of old stars, so the disc doesn't end against nothing
        float h = 0.008 * exp(-length(vec2(p.x, p.y / max(uCi, 0.55))) / 0.3);
        vis += h * COL_OLD;
        ir += h * 0.8;
        // Starbursts glow in infrared from the dust-wrapped middle
        ir += uBurst * 1.3 * exp(-dot(p, p) / 0.012);
    }
    vis = reddened(vis);
    gA = vec4(vis, uvLight);
    gB = vec4(ir, radio * 0.25, xray, 1.0);
}`;

// Particles seen through the tilted galaxy, each made from its index alone. uClouds picks the population:
// 1 = star clouds and glowing knots, which together hold about as much light as the smooth arms under them;
// 0 = individual stars, drawn crisp at the size of the bake.
const PARTICLE_VERT = /* glsl */`
precision highp sampler2D;
${FALL_GLSL}
uniform sampler2D tMap;
uniform float uKind, uArms, uPitch, uPhase, uBarLen, uRdY, uRd, uMapR, uImageR, uHand, uRes, uCi, uSi, uBulgeQ, uAmp, uClouds, uFluxK, uLCap, uHDust, uMapLod, uWideLod;
uniform uint uSeedU;
out vec3 vVis;
out vec2 vBands;
out float vHard;
${PCG_GLSL}

// A place on a spiral arm: spread is how far from the crest, in radians of the pattern
vec3 onArm(inout uint st, float spread, float thick) {
    float r0 = max(uBarLen, 0.09);
    // Two exponentials added: few in the very middle, a peak part way out, a long tail
    float r = r0 * 0.9 + expRadius(st, uRdY * 0.42, 0.6) + expRadius(st, uRdY * 0.42, 0.6);
    float arm = floor(rnd(st) * uArms);
    float th = log(r / r0) / tan(uPitch) + (6.2831853 * arm - uPhase) / uArms + gaussian(st) * spread / uArms;
    r *= 1.0 + 0.05 * gaussian(st);
    return vec3(r * vec2(cos(th), sin(th)), gaussian(st) * thick);
}

// A place in an irregular's clumps: gathered round a few random centres
vec3 inClump(inout uint st, float thick) {
    float k = floor(rnd(st) * 7.0);
    uint cs = pcg(uint(k) + uSeedU * 5u);
    vec2 c = vec2((rnd(cs) - 0.5) * 1.1, (rnd(cs) - 0.5) * 0.6);
    return vec3(c + vec2(gaussian(st), gaussian(st)) * (0.04 + 0.13 * rnd(st)), gaussian(st) * thick);
}

void main() {
    uint st = pcg(uint(gl_VertexID) * (uClouds > 0.5 ? 3u : 7u) + uSeedU + (uClouds > 0.5 ? 0u : 91u));
    float pop = rnd(st);
    vec3 pos;
    vec3 col;
    float uvShare;
    float irShare;
    float radiusWorld = 0.0;
    float amp = 1.0;
    float elliptical = uKind > 0.5 && uKind < 1.5 ? 1.0 : 0.0;

    if (uClouds > 0.5) {
        // A luminosity function, as for real star-forming regions: very many faint clouds, a few giants
        float L = min(uLCap, 0.02 / max(1.0 - rnd(st), 1e-5));
        float spread = pop < 0.05 ? 0.14 : pop < 0.75 ? 0.34 : 1.2;
        pos = uKind > 1.5 ? inClump(st, 0.03) : onArm(st, spread, 0.012);
        if (pop < 0.05) {
            // Glowing clouds of hydrogen round the youngest clusters
            radiusWorld = 0.002 + 0.0016 * sqrt(L);
            col = vec3(1.45, 0.32, 0.5) * 0.2;
            amp = L * 1.1;
            uvShare = 0.35;
        } else if (pop < 0.75) {
            // Clouds of blue stars
            radiusWorld = 0.0015 + 0.0017 * sqrt(L);
            col = vec3(0.24, 0.48, 1.4) * 0.2;
            amp = L;
            uvShare = 1.0;
        } else {
            // Fainter clouds between the arms
            radiusWorld = 0.002;
            col = vec3(0.24, 0.48, 1.4) * 0.2;
            amp = 0.3 * min(L, 1.5);
            uvShare = 0.8;
        }
        irShare = 0.05;
    } else {
        // Very many faint stars and very few bright ones: a true power law
        float lum = min(1.0, 0.0012 / max(1.0 - rnd(st), 1e-5));
        if (elliptical > 0.5) {
            // Old stars and globular clusters scattered through the halo
            float r = expRadius(st, 0.2, 1.1) + 0.02;
            vec3 d = normalize(vec3(gaussian(st), gaussian(st), gaussian(st)));
            pos = d * r * vec3(1.0, uBulgeQ, 1.0);
            col = mix(vec3(1.0, 0.72, 0.42), vec3(1.0, 0.9, 0.72), rnd(st));
            uvShare = 0.0;
        } else if (uKind > 1.5) {
            pos = inClump(st, 0.05);
            float hot = rnd(st);
            col = mix(vec3(1.0, 0.88, 0.75), vec3(0.62, 0.78, 1.25), hot);
            uvShare = hot * 1.6;
        } else if (pop < 0.6) {
            // Young stars on the arms: mostly blue, a few red supergiants
            pos = onArm(st, 0.42, 0.018);
            float red = rnd(st);
            col = red < 0.12 ? vec3(1.0, 0.55, 0.32) : mix(vec3(0.7, 0.82, 1.2), vec3(0.5, 0.7, 1.35), rnd(st));
            uvShare = red < 0.12 ? 0.0 : 1.6;
        } else {
            // Older stars everywhere in the disc
            float r = expRadius(st, uRd, 1.1);
            float th = 6.2831853 * rnd(st);
            pos = vec3(r * vec2(cos(th), sin(th)), gaussian(st) * 0.05);
            lum *= 0.4;
            col = mix(vec3(1.0, 0.78, 0.55), vec3(1.0, 0.92, 0.8), rnd(st));
            uvShare = 0.16;
        }
        amp = lum;
        irShare = 0.8 * (1.0 - min(uvShare, 1.0));
    }

    pos.y *= uHand;
    vec2 img = vec2(pos.x, pos.y * uCi - pos.z * uSi);

    // What dust lies between this particle and us. Above the midplane on our side there's none; behind it there's the
    // whole column here. Towards edge-on the ray runs along the disc, so the far side of the galaxy lies behind far more.
    float tau = 0.0;
    if (elliptical < 0.5) {
        vec2 mapUv = pos.xy / (2.0 * uMapR) + 0.5;
        float column = max(textureLod(tMap, mapUv, uMapLod).g, textureLod(tMap, mapUv, uWideLod).g);
        float behind = smoothstep(-uHDust, uHDust, pos.z);
        float slant = min(1.0 / max(uCi, 0.01), 6.0);
        tau = column * (behind * (1.0 + (slant - 1.0) * smoothstep(-0.2, 0.4, pos.y * uSi))
            + 0.5 * (slant - 1.0) * smoothstep(-0.75, 0.0, pos.y * uSi));
    }
    vec3 T = exp(-tau * vec3(0.86, 1.0, 1.16));
    float dimUv = exp(-tau * 1.7);

    float brightness;
    if (uClouds > 0.5) {
        // Each cloud's total light stays the same at any resolution or particle count
        float pxPerUnit = uRes / (2.0 * uImageR);
        float rPx = max(radiusWorld * pxPerUnit, 0.75);
        float rWorld = rPx / pxPerUnit;
        // Clouds thin out towards the rim as the smooth light does
        brightness = amp * uFluxK / (6.2831853 * rWorld * rWorld) * fall(1.1, 0.55, length(pos.xy));
        gl_PointSize = rPx * 4.0;
        vHard = 4.0;
        vVis = col * T * brightness;
        vBands = vec2(uvShare * dimUv * brightness, irShare * brightness);
    } else {
        float rim = fall(1.08, 0.55, length(pos.xy));
        brightness = uAmp * (0.008 + 1.5 * sqrt(amp)) * rim * rim;
        float px = uRes / 1024.0;
        gl_PointSize = clamp((1.15 + 2.2 * sqrt(amp)) * clamp(px, 0.6, 2.0), 1.0, 8.0);
        vHard = 2.0;
        vVis = col * T * brightness;
        vBands = vec2(uvShare * dimUv * brightness, irShare * brightness);
    }
    gl_Position = vec4(img / uImageR, 0.0, 1.0);
}`;

const PARTICLE_FRAG = /* glsl */`
precision highp float;
in vec3 vVis;
in vec2 vBands;
in float vHard;
layout(location = 0) out vec4 gA;
layout(location = 1) out vec4 gB;
void main() {
    // A Gaussian: the point's edge is vHard/2 of its radii out
    vec2 c = (gl_PointCoord - 0.5) * vHard;
    float g = exp(-0.5 * dot(c, c) * (vHard < 3.0 ? 3.2 : 1.0));
    gA = vec4(vVis * g, vBands.x * g);
    gB = vec4(vBands.y * g, 0.0, 0.0, 0.0);
}`;

// HDR to 8 bits. Square roots hold the faint end, dithering removes what banding is left, and a soft edge means no quad ever shows.
const RESOLVE_FRAG = /* glsl */`
precision highp float;
in vec2 vP;
uniform sampler2D tA, tB;
uniform vec2 uScale;
layout(location = 0) out vec4 gA;
layout(location = 1) out vec4 gB;
${FALL_GLSL}
float dither(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return (fract((q.x + q.y) * q.z) - 0.5) / 255.0;
}
void main() {
    vec2 uv = vP * 0.5 + 0.5;
    float edge = fall(1.0, 0.86, length(vP));
    vec4 a = max(texture(tA, uv), 0.0) * edge / uScale.x;
    vec4 b = max(texture(tB, uv), 0.0) * edge / uScale.y;
    float d = dither(gl_FragCoord.xy);
    gA = clamp(sqrt(a) + d, 0.0, 1.0);
    gB = vec4(clamp(sqrt(b.rgb) + d, 0.0, 1.0), 1.0);
}`;

function hdrTarget(width, height, count, mipmaps) {
    return new THREE.WebGLRenderTarget(width, height, {
        count,
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        generateMipmaps: mipmaps
    });
}

// How much work a bake of this many pixels across does, by graphics level
function bakeSettings(res, quality) {
    const k = quality === 'low' ? 0.6 : quality === 'high' ? 1.4 : 1;
    const area = (res * res) / (1024 * 1024);
    return {
        mapRes: quality === 'low' ? Math.max(res, 128) : Math.min(res * 2, Math.max(res, 256)),
        oct: res <= 128 ? 4 : res <= 512 ? 5 : 7,
        ds: res <= 128 ? 0.05 : res <= 512 ? 0.034 : 0.024,
        clouds: Math.round(Math.min(420000, Math.max(5000, 130000 * area * k))),
        stars: res <= 128 ? 0 : Math.round(Math.min(320000, 110000 * area * k)),
        tiles: res <= 256 ? 1 : res <= 512 ? 2 : res <= 1024 ? 4 : 6,
        pointChunk: 90000
    };
}

export function createGalaxyBaker(engine) {
    const { renderer } = engine;
    const quadGeometry = new THREE.BufferGeometry();
    quadGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const shared = {
        uKind: { value: 0 }, uArms: { value: 2 }, uPitch: { value: 0.3 }, uPhase: { value: 0 }, uArmK: { value: 1 },
        uBarLen: { value: 0 }, uRd: { value: 0.24 }, uRdY: { value: 0.34 }, uDust: { value: 1 }, uFlocc: { value: 0 },
        uYoung: { value: 1 }, uMapR: { value: IMAGE_R }, uHand: { value: 1 }, uImageR: { value: IMAGE_R },
        uOff: { value: new THREE.Vector4() }, uSeedU: { value: 1 }, uCi: { value: 1 }, uSi: { value: 0 },
        uBulgeRe: { value: 0.1 }, uBulgeL: { value: 0.6 }, uBulgeN: { value: 2 }, uBulgeQ: { value: 0.8 },
        uBoxy: { value: 2 }, uShells: { value: 0 }, uLane: { value: 0 }, uHOld: { value: 0.05 }, uHYoung: { value: 0.02 },
        uHDust: { value: 0.014 }, uRedden: { value: 0 }, uWarp: { value: 0 }, uBurst: { value: 0 },
        uOct: { value: 4 }, uDs: { value: 0.05 }, uRes: { value: 128 }, uFluxK: { value: 1 }, uLCap: { value: 30 }, uAmp: { value: 1 },
        uClouds: { value: 0 }, uMapLod: { value: 0 }, uWideLod: { value: 0 }, tMap: { value: null }
    };
    const base = { glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false, toneMapped: false };
    const additive = {
        transparent: true,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneFactor
    };
    const mapMaterial = new THREE.ShaderMaterial({ ...base, uniforms: shared, vertexShader: QUAD_VERT, fragmentShader: MAP_FRAG });
    const viewMaterial = new THREE.ShaderMaterial({ ...base, uniforms: shared, vertexShader: QUAD_VERT, fragmentShader: VIEW_FRAG });
    const particleMaterial = new THREE.ShaderMaterial({ ...base, ...additive, uniforms: shared, vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG });
    const resolveUniforms = { tA: { value: null }, tB: { value: null }, uScale: { value: new THREE.Vector2(BAKE_SCALE.a, BAKE_SCALE.b) } };
    const resolveMaterial = new THREE.ShaderMaterial({ ...base, uniforms: resolveUniforms, vertexShader: QUAD_VERT, fragmentShader: RESOLVE_FRAG });

    const quad = new THREE.Mesh(quadGeometry, mapMaterial);
    quad.frustumCulled = false;
    const quadScene = new THREE.Scene();
    quadScene.add(quad);
    let pointGeometry = null;
    let pointCapacity = 0;
    let points = null;
    const pointScene = new THREE.Scene();

    let scratchMap = null;
    let scratchView = null;

    function pointsFor(count) {
        if (count > pointCapacity) {
            if (pointGeometry) pointGeometry.dispose();
            pointCapacity = count;
            pointGeometry = new THREE.BufferGeometry();
            // Only their indices matter, but drawing needs an attribute to count
            pointGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count), 1));
            pointGeometry.boundingSphere = new THREE.Sphere();
            if (points) pointScene.remove(points);
            points = new THREE.Points(pointGeometry, particleMaterial);
            points.frustumCulled = false;
            pointScene.add(points);
        }
        return points;
    }

    function withTarget(target, fn) {
        const previous = renderer.getRenderTarget();
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.setRenderTarget(target);
        fn();
        renderer.autoClear = autoClear;
        renderer.setRenderTarget(previous);
    }

    function clear(target) {
        const colour = new THREE.Color();
        renderer.getClearColor(colour);
        const alpha = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 0);
        target.scissorTest = false;
        withTarget(target, () => renderer.clear(true, false, false));
        renderer.setClearColor(colour, alpha);
    }

    function scratch(mapRes, res) {
        if (!scratchMap || scratchMap.width !== mapRes) {
            if (scratchMap) scratchMap.dispose();
            scratchMap = hdrTarget(mapRes, mapRes, 1, true);
        }
        if (!scratchView || scratchView.width !== res) {
            if (scratchView) scratchView.dispose();
            scratchView = hdrTarget(res, res, 2, false);
        }
    }

    function setRecipe(r) {
        shared.uKind.value = r.kind;
        shared.uArms.value = r.arms;
        shared.uPitch.value = r.pitch;
        shared.uPhase.value = r.phase;
        shared.uArmK.value = r.armK;
        shared.uBarLen.value = r.barLen;
        shared.uRd.value = r.rd;
        shared.uRdY.value = r.rdY;
        shared.uDust.value = r.dust;
        shared.uFlocc.value = r.flocc;
        shared.uYoung.value = r.young;
        shared.uHand.value = r.hand;
        shared.uOff.value.set(r.off[0], r.off[1], r.off[2], r.off[3]);
        shared.uSeedU.value = r.seed;
        shared.uCi.value = Math.cos(r.incl);
        shared.uSi.value = Math.sin(r.incl);
        shared.uBulgeRe.value = r.bulgeRe;
        shared.uBulgeL.value = r.bulgeL;
        shared.uBulgeN.value = r.bulgeN;
        shared.uBulgeQ.value = r.bulgeQ;
        shared.uBoxy.value = r.boxy;
        shared.uShells.value = r.shells;
        shared.uLane.value = r.laneDust;
        shared.uHOld.value = r.hOld;
        shared.uHYoung.value = r.hYoung;
        shared.uHDust.value = r.hDust;
        shared.uRedden.value = r.redden;
        shared.uWarp.value = r.warp;
        shared.uBurst.value = r.starburst ? 1 : 0.12;
    }

    // Draw a full-target quad, either at once or a block of it per step
    function* tiledPass(target, material, tiles) {
        const w = target.width;
        const h = target.height;
        quad.material = material;
        for (let j = 0; j < tiles; j++) {
            for (let i = 0; i < tiles; i++) {
                const x0 = Math.floor((i * w) / tiles);
                const y0 = Math.floor((j * h) / tiles);
                const x1 = Math.floor(((i + 1) * w) / tiles);
                const y1 = Math.floor(((j + 1) * h) / tiles);
                target.scissorTest = true;
                target.scissor.set(x0, y0, x1 - x0, y1 - y0);
                withTarget(target, () => renderer.render(quadScene, camera));
                target.scissorTest = false;
                yield;
            }
        }
    }

    function* pointPass(target, count, chunk) {
        if (count <= 0) return;
        const p = pointsFor(count);
        for (let start = 0; start < count; start += chunk) {
            p.geometry.setDrawRange(start, Math.min(chunk, count - start));
            setUniforms();
            withTarget(target, () => renderer.render(pointScene, camera));
            yield;
        }
    }

    let currentRecipe = null;
    let currentSettings = null;
    function setUniforms() {
        // The uniforms are shared by every bake, and another bake can't begin before this one ends, but the recipe
        // is set again at each step so that stepping two jobs in turn would still be safe.
        setRecipe(currentRecipe);
        shared.uOct.value = currentSettings.oct;
        shared.uDs.value = currentSettings.ds;
        // Blur the map for rays that run along the disc, by the same width at any resolution
        const tilt = Math.cos(currentRecipe.incl);
        const blur = 0.03 * (1 - Math.min(1, Math.max(0, (tilt - 0.08) / 0.75)));
        const pxPerUnit = currentSettings.mapRes / (2 * IMAGE_R);
        shared.uMapLod.value = Math.max(0, Math.log2(Math.max(1e-4, blur * pxPerUnit)));
        shared.uWideLod.value = Math.max(0, Math.log2(0.14 * pxPerUnit));
    }

    // A job is a generator: each next() does one small piece of GPU work. rect is { x, y, w, h } in the output target.
    function* bake(recipe, output, rect, res, quality = 'medium') {
        const s = bakeSettings(res, quality);
        currentRecipe = recipe;
        currentSettings = s;
        scratch(s.mapRes, res);
        setUniforms();
        const usesMap = recipe.kind !== 1;
        if (usesMap) {
            clear(scratchMap);
            yield* tiledPass(scratchMap, mapMaterial, s.tiles);
        }
        clear(scratchView);
        shared.tMap.value = usesMap ? scratchMap.texture : null;
        shared.uRes.value = res;
        yield* tiledPass(scratchView, viewMaterial, s.tiles);
        if (usesMap) {
            // 0.15 is the mean of the luminosity function. With fewer clouds, no single one may dominate.
            shared.uFluxK.value = ((recipe.kind === 2 ? 1.1 : 0.5) * recipe.young) / (0.15 * Math.max(1, s.clouds));
            shared.uLCap.value = 9 * Math.min(1, Math.sqrt(s.clouds / 130000));
            shared.uClouds.value = 1;
            yield* pointPass(scratchView, s.clouds, s.pointChunk);
        }
        shared.uClouds.value = 0;
        shared.uAmp.value = recipe.kind === 1 ? 0.3 : 0.7;
        yield* pointPass(scratchView, s.stars, s.pointChunk);

        resolveUniforms.tA.value = scratchView.textures[0];
        resolveUniforms.tB.value = scratchView.textures[1];
        output.viewport.set(rect.x, rect.y, rect.w, rect.h);
        output.scissor.set(rect.x, rect.y, rect.w, rect.h);
        output.scissorTest = true;
        quad.material = resolveMaterial;
        withTarget(output, () => renderer.render(quadScene, camera));
        output.scissorTest = false;
        shared.tMap.value = null;
        resolveUniforms.tA.value = null;
        resolveUniforms.tB.value = null;
    }

    // Compile the four programs without blocking. Nothing may bake until this has resolved.
    function compile() {
        const programs = new THREE.Scene();
        [mapMaterial, viewMaterial, resolveMaterial].forEach((material) => {
            const mesh = new THREE.Mesh(quadGeometry, material);
            mesh.frustumCulled = false;
            programs.add(mesh);
        });
        const dots = new THREE.Points(quadGeometry, particleMaterial);
        dots.frustumCulled = false;
        programs.add(dots);
        return engine.compileInBackground(programs, camera);
    }

    return {
        compile,
        bake,
        // Free the working textures. The small ones are worth keeping while the atlas fills, the rest of the time none are.
        releaseScratch() {
            if (scratchMap) scratchMap.dispose();
            if (scratchView) scratchView.dispose();
            scratchMap = null;
            scratchView = null;
            if (pointGeometry) pointGeometry.dispose();
            if (points) pointScene.remove(points);
            pointGeometry = null;
            points = null;
            pointCapacity = 0;
        },
        hasScratch: () => !!scratchView,
        dispose() {
            this.releaseScratch();
            quadGeometry.dispose();
            [mapMaterial, viewMaterial, particleMaterial, resolveMaterial].forEach((m) => m.dispose());
        }
    };
}

// An 8-bit pair of images, the same shape as a bake's output. Mipmaps are remade whenever it is drawn into.
export function createBakeTarget(width, height) {
    return new THREE.WebGLRenderTarget(width, height, {
        count: 2,
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        generateMipmaps: true
    });
}
