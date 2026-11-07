// The programs baked into textures by nebula_bake.js. Each one writes four channels, so that the sprite can rebuild
// the object in any band without baking again:
//
//   emission, reflection, planetary   R hydrogen zone, G oxygen zone, B warm dust (all sqrt encoded), A dust opacity
//   dark clouds                       R thin dust catching starlight, G lit edges, B cold dust (sqrt encoded), A opacity
//   supernova remnants                R shock sheet and ejecta, G filaments, B hot gas, A synchrotron (all sqrt encoded)
//
// A nebula is always seen from one side, so what a photograph of one shows can be built where it shows: a few layers
// of gas that overlap as veils, with the finest filaments and the dust in front worked out once per pixel. Layers and
// per-pixel detail are continuous across the image, so they stay crisp at any zoom and leave no grain to blur away.
//
// textureLod keeps the loops free of derivatives, which is what lets ANGLE compile them quickly.

export const BAKE_VERT = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const COMMON = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform sampler3D tNoise;   // Tiling: r, g, b are separate fractal noises, a is cellular
uniform vec4 uRect;         // The window being baked: centre and half-size in sprite units (-1..1)
uniform int uSteps;
uniform int uOctaves;
uniform vec3 uOff;
uniform mat3 uRot;
varying vec2 vUv;

const mat3 OCT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

float sat(float x) { return clamp(x, 0.0, 1.0); }
// Where along its step each ray starts. Integer hashing gives the same grain on every GPU, with no diagonal pattern
float jitter(vec2 p) {
    uvec2 q = uvec2(ivec2(p)) * uvec2(1597334673u, 3812015801u);
    uint h = (q.x ^ q.y) * 1597334673u;
    return float(h) * (1.0 / 4294967295.0);
}
vec4 noiseAt(vec3 p) { return textureLod(tNoise, p, 0.0); }

// Each fetch already holds three octaves, so a large step in frequency still leaves the spectrum continuous
float fbm(vec3 p) {
    float a = 0.5;
    float s = 0.0;
    float t = 0.0;
    for (int i = 0; i < uOctaves; i++) {
        s += a * textureLod(tNoise, p, 0.0).r;
        t += a;
        a *= 0.62;
        p = OCT * p * 2.43 + 0.37;
    }
    return s / t;
}

// Zero-mean fractal detail, finer with each octave. More octaves only add finer detail on top, so that a large image
// and a small one of the same object agree with each other
float detail(vec3 p) {
    float a = 1.0;
    float s = 0.0;
    for (int i = 0; i < uOctaves; i++) {
        s += a * (textureLod(tNoise, p, 0.0).g - 0.5);
        a *= 0.72;
        p = OCT * p * 2.43 + 0.37;
    }
    return s;
}

// 1 where a noise crosses its middle value: thin sheets, and seen edge-on, threads
float ridge(float n) {
    return max(0.0, 1.0 - abs(2.0 * n - 1.0));
}

vec4 packed(float r, float g, float b, float a) {
    return vec4(sqrt(sat(r)), sqrt(sat(g)), sqrt(sat(b)), sat(a));
}
`;

// Reflection nebulae: a ray through a sphere of dusty gas, which scatters the light of a star nearby. Dust surfaces
// that face the star light up as bright rims.
export const CLOUD_FRAG = /* glsl */`
${COMMON}
uniform vec4 uBlob[6];      // Lumps that make up the cloud's overall shape: position, radius
uniform vec4 uStar[4];      // Lighting stars: position, strength
uniform vec4 uLane[2];      // Big dust lanes as warped sheets: normal, offset
uniform vec4 uA;            // Warp, gas threshold, dust amount, dust optical depth
uniform vec4 uB;            // Unused, unused, rim gain, unused
uniform vec4 uC;            // Output gains: hydrogen, oxygen, dust; w = lane width

float envelope(vec3 p) {
    float e = 0.0;
    for (int i = 0; i < 6; i++) {
        vec3 d = p - uBlob[i].xyz;
        e += exp(-dot(d, d) / (uBlob[i].w * uBlob[i].w));
    }
    return e;
}

// How much light reaches p, and the direction to the star that supplies most of it
float ionisation(vec3 p, out vec3 toStar) {
    float u = 0.0;
    float best = -1.0;
    toStar = vec3(0.0, 0.0, 1.0);
    for (int i = 0; i < 4; i++) {
        vec3 d = uStar[i].xyz - p;
        float l2 = dot(d, d);
        float c = uStar[i].w / (l2 + 0.012);
        u += c;
        if (c > best) {
            best = c;
            toStar = d / sqrt(l2 + 1e-5);
        }
    }
    return u;
}

float laneField(vec3 p) {
    float a = dot(p, uLane[0].xyz) - uLane[0].w;
    float b = dot(p, uLane[1].xyz) - uLane[1].w;
    float w2 = uC.w * uC.w;
    return exp(-a * a / w2) + 0.7 * exp(-b * b / (w2 * 0.6));
}

// Dust: thin sheets where a noise crosses its middle value, rounded globules from the cellular channel, and big lanes
float dustField(vec3 pw, vec3 dq, float n) {
    vec4 d = noiseAt(dq);
    if (uOctaves > 3) d.g += (noiseAt(OCT * dq * 3.7 + 0.41).g - 0.5) * 0.34;
    float ridge = 1.0 - abs(2.0 * d.g - 1.0);
    float sheets = smoothstep(0.58, 1.0, ridge);
    float globules = smoothstep(0.60, 0.80, d.a);
    float lanes = laneField(pw) * smoothstep(0.22, 0.56, n + 0.10 * (d.b - 0.5));
    return sheets * 0.65 + globules * 0.85 + lanes * 1.2;
}

void main() {
    vec2 xy = uRect.xy + uRect.zw * (vUv * 2.0 - 1.0);
    float rr = dot(xy, xy);
    if (rr >= 1.0) {
        gl_FragColor = vec4(0.0);
        return;
    }
    float zmax = sqrt(1.0 - rr);
    float ds = 2.0 * zmax / float(uSteps);
    float z = zmax - ds * 0.6 * jitter(gl_FragCoord.xy);
    float T = 1.0;
    float Tir = 1.0;
    float La = 0.0;
    float Lo = 0.0;
    float Ld = 0.0;
    for (int i = 0; i < uSteps; i++) {
        vec3 p = vec3(xy, z);
        z -= ds;
        vec3 q = uRot * p * 0.40 + uOff;
        vec3 w = noiseAt(q * 0.32 + vec3(0.31, 0.17, 0.71)).rgb - 0.5;
        vec3 qw = q + w * uA.x;
        // A smaller, curlier warp on top: this is what draws gas out into wisps
        vec3 w2 = noiseAt(qw * 1.35 + vec3(0.71, 0.37, 0.13)).rgb - 0.5;
        vec3 qc = qw + w2 * 0.085;
        float n = fbm(qc);
        // The outline comes from lumps pushed around by the same warp, so it is never a circle
        float env = envelope(p + w * 1.25);
        float e = 1.0 - exp(-env * 1.35);
        float edge = smoothstep(1.0, 0.72, length(p));
        float f = (n - 0.5) * 3.0 + (e - 0.55) * 1.55 - uA.y;
        float gas = smoothstep(0.0, 0.42, f);
        gas *= gas * edge;
        // Sheets seen edge-on are bright threads: this keeps fine structure alive through the integral along the ray
        float sheetN = noiseAt(qc * 1.45 + vec3(0.19, 0.83, 0.47)).b;
        if (uOctaves > 3) sheetN += (noiseAt(OCT * qc * 5.1 + vec3(0.67, 0.29, 0.53)).b - 0.5) * 0.30;
        float sheet = 1.0 - abs(2.0 * sheetN - 1.0);
        sheet *= sheet;
        sheet *= sheet;
        float faint = smoothstep(-0.5, 0.15, f) * edge * 0.085;

        vec3 pw = p + w * 0.6;
        vec3 dq = qw * 0.95 + vec3(0.53, 0.11, 0.29);
        float dustBase = dustField(pw, dq, n);
        float dust = dustBase * smoothstep(-0.30, 0.18, f) * edge * uA.z;

        vec3 toStar;
        float U = ionisation(p, toStar);

        // Rim: dust just here, less the dust a little way towards the star, is a surface that faces that star
        vec3 dq2 = (qw + uRot * toStar * 0.022) * 0.95 + vec3(0.53, 0.11, 0.29);
        float dust2 = dustField(pw + toStar * 0.07, dq2, n);
        float rim = max(0.0, dustBase - dust2) * smoothstep(-0.25, 0.1, f) * edge;

        float g = gas * (0.38 + 2.9 * sheet);
        float tau = dust * uA.w * ds;
        // Starlight scattered by dust, falling off with distance and picking out the wisps
        float sca = sat(U * 0.085);
        sca *= sqrt(sca);
        float wisp = 1.0 - abs(2.0 * n - 1.0);
        float ha = g * sca * (0.5 + 1.1 * n) + rim * sca * uB.z + faint * sca;
        float o3 = g * sca * wisp * wisp * wisp * 1.5;
        La += T * ha * ds;
        Lo += T * o3 * ds;
        Ld += Tir * (dust * 0.6 + g * 0.5) * (0.35 + sca) * ds;
        Tir *= exp(-tau * 0.08);
        T *= exp(-tau);
    }
    // A soft shoulder rather than a hard clip, so that the brightest gas keeps its structure
    gl_FragColor = packed(1.0 - exp(-La * uC.x), 1.0 - exp(-Lo * uC.y), 1.0 - exp(-Ld * uC.z), 1.0 - T);
}`;

// Emission nebulae. A few layers of gas, cross-sections of one warped noise, overlap as veils; on top of them, once per
// pixel, come the finest threads and the dust in front. Nothing here is ever thresholded into an outline: the gas just
// gets fainter, all the way out. Stars are measured from the unwarped position, so the heart is where the stars are.
export const EMISSION_FRAG = /* glsl */`
${COMMON}
uniform vec4 uBlob[8];      // Lumps that make up the overall shape: position, radius
uniform vec4 uStar[4];      // Ionising stars: position, strength
uniform vec4 uLane[3];      // Dust lanes: normal in the plane of the sky, offset, how far along the line it starts
uniform vec4 uA;            // Flow warp, lump push, dust inside the gas, dust optical depth in front
uniform vec4 uB;            // Cavity radius, [O III] reach, rim gain, lane width
uniform vec4 uC;            // Output gains: hydrogen, oxygen, dust; w = how much of the gas lies in front of the dust
uniform vec4 uD;            // Molecular wall: direction from the main star, its distance, strength

float envelope(vec3 p) {
    float e = 0.0;
    for (int i = 0; i < 8; i++) {
        vec3 d = p - uBlob[i].xyz;
        e += exp(-dot(d, d) / (uBlob[i].w * uBlob[i].w));
    }
    return e;
}

float ionisation(vec3 p) {
    float u = 0.0;
    for (int i = 0; i < 4; i++) {
        vec3 d = uStar[i].xyz - p;
        u += uStar[i].w / (dot(d, d) + 0.012);
    }
    return u;
}

float laneField(vec2 p) {
    float sum = 0.0;
    float w2 = uB.w * uB.w;
    for (int i = 0; i < 3; i++) {
        vec4 l = uLane[i];
        float a = dot(p, l.xy) - l.z;
        float along = dot(p, vec2(-l.y, l.x));
        sum += exp(-a * a / w2) * smoothstep(l.w - 0.16, l.w + 0.22, along);
    }
    return sum;
}

// Positive where there is much dust in front, and a fractal of no particular size either way. The wall is a cloud the
// stars are eating away, sampled almost only by angle around the star, so that what is left of it stands in columns
// pointing back at them.
float dustFront(vec2 p, vec2 pu, float coarse, float fine) {
    float m = laneField(p) * 1.15 - 0.60 + (coarse - 0.5) * 1.1 + fine * 1.05;
    if (uD.w > 0.0) {
        vec2 rel = pu - uStar[0].xy;
        float r = length(rel) + 1e-4;
        vec2 dir = rel / r;
        float side = smoothstep(0.05, 0.85, dot(dir, uD.xy));
        float fingers = noiseAt(vec3(dir * 0.62, r * 0.30) + uOff).r;
        float wall = min(0.5, (r - uD.z - (fingers - 0.5) * 0.95) * 2.6);
        m = max(m, (wall + (coarse - 0.5) * 0.7 + fine * 0.9) * side * uD.w);
    }
    return m;
}

void main() {
    vec2 xy = uRect.xy + uRect.zw * (vUv * 2.0 - 1.0);
    // One slow flow that every layer shares, which is what draws the gas out into streamers
    vec3 flow = noiseAt(vec3(xy * 0.19, 0.31) + uOff).rgb - 0.5;
    vec3 flow2 = noiseAt(vec3(xy * 0.53 + flow.xy * 0.4, 0.67) + uOff.zxy).rgb - 0.5;
    vec2 xw = xy + (flow.xy + flow2.xy * 0.45) * uA.x;

    float ds = 1.7 / float(uSteps);
    float La = 0.0;
    float Lo = 0.0;
    float Ld = 0.0;
    float T = 1.0;
    float Tir = 1.0;
    for (int i = 0; i < uSteps; i++) {
        float layer = float(i);
        float z = 0.85 - (layer + 0.5) * ds;
        vec3 P = vec3(xw, z);
        vec3 q = uRot * P * 0.42 + uOff;
        vec4 a = noiseAt(q * 0.85 + vec3(0.31, 0.17, 0.71));
        vec3 wob = a.rgb - 0.5;
        vec3 qc = q + wob * 0.17;
        float n = noiseAt(qc).r;
        // Each layer has its own veils, so that they cross one another rather than stacking into parallel lines
        float s = noiseAt(qc * 2.37 + vec3(0.19, 0.83, 0.47) + layer * vec3(0.37, 0.11, 0.53)).b;

        float env = envelope(P + wob * uA.y);
        float e = 1.0 - exp(-env * 1.3);
        // The density of turbulent gas is log-normal, and emission goes as its square. With no threshold anywhere there
        // is no outline: bright wisps, and the gas just gets fainter, all the way out.
        float em = e * e * exp((n - 0.5) * 6.5);
        float dens = e * exp((n - 0.5) * 3.2);

        float sheet = ridge(s);
        sheet *= sheet;
        sheet *= sheet;
        sheet *= sheet;

        vec3 Pu = vec3(xy, z);
        float U = ionisation(Pu);
        float lit = U / (U + 6.0);
        lit *= sqrt(lit);
        float heart = sat(U * 0.022);

        // A wind-blown cavity around the brightest star, with a compressed wall
        float wall = 1.0;
        if (uB.x > 0.0) {
            float r0 = length(Pu - uStar[0].xyz) + (n - 0.5) * 0.34;
            float wd = (r0 - uB.x * 1.14) / (uB.x * 0.34);
            wall = mix(0.10, 1.0, smoothstep(uB.x * 0.58, uB.x * 1.02, r0)) * (1.0 + 1.2 * exp(-wd * wd));
        }

        float g = em * wall * (0.42 + 1.9 * sheet) * (0.05 + lit) * (1.0 + 0.7 * heart);
        // Close to the stars oxygen is ionised twice and adds its teal to the hydrogen's rose. Together they read pale.
        float zone = smoothstep(0.25, 1.0, U * uB.y);
        La += T * g * ds;
        Lo += T * g * zone * ds;
        // Dust in the gas: globules, which hide what is behind them, and glow in the infrared with whatever warms them
        float clump = smoothstep(0.60, 0.80, a.a) * min(dens, 1.5);
        float core = smoothstep(0.55, 0.95, e) * smoothstep(0.35, 0.70, n);
        Ld += Tir * (min(dens, 2.0) * (0.14 + 0.55 * lit) + clump * 0.35 + core * 0.22) * ds;
        float tau = clump * uA.z * ds;
        T *= exp(-tau);
        Tir *= exp(-tau * 0.06);
    }

    // Everything finer than the layers, worked out once per pixel. Only half the flow reaches it, or it would all be
    // combed the same way like hair
    vec2 xf = xy + (xw - xy) * 0.45;
    float grain = detail(vec3(xf * 1.7, 0.41) + uOff);
    float grain2 = detail(vec3(xf * 2.3 + grain * 0.09, 0.71) + uOff.zyx);
    float mottle = exp(grain * 1.9);
    float thread = ridge(0.5 + grain2 * 0.7);
    thread *= thread;
    thread *= thread;
    thread *= thread;
    thread *= thread;
    La *= mottle * (1.0 + 1.3 * thread);
    Lo *= mottle * (1.0 + 0.8 * thread);
    Ld *= 0.72 + 0.28 * mottle;

    // Dust in front. Its column density is log-normal too: no edge, just dust that thickens and frays at every scale
    float coarse = noiseAt(vec3(xw * 0.77, 0.13) + uOff.yzx).g;
    float m = dustFront(xw, xy, coarse, grain2);
    // It belongs to the cloud, whose lumps give it an irregular edge. Without this it would dim a disc of the sky
    float within = smoothstep(0.03, 0.55, 1.0 - exp(-envelope(vec3(xw, 0.0)) * 1.6));
    float tauF = uA.w * 0.24 * exp(m * 3.0) * within;
    float Tf = exp(-tauF);

    // Where the dust's surface faces the star it is being ionised: a bright rim, the sharpest thing in the picture
    vec2 toStar = uStar[0].xy - xy;
    toStar /= length(toStar) + 1e-4;
    float coarse2 = noiseAt(vec3((xw + toStar * 0.03) * 0.77, 0.13) + uOff.yzx).g;
    float m2 = dustFront(xw + toStar * 0.03, xy + toStar * 0.03, coarse2, grain2);
    float rim = sat((m - m2) * 5.0) * exp(-abs(m) * 2.6) * within;
    float U0 = ionisation(vec3(xy, 0.0));
    float rimLit = rim * (0.02 + U0 / (U0 + 6.0)) * uB.z * 0.34 * mottle;

    float seen = uC.w + (1.0 - uC.w) * Tf;
    La = La * seen + rimLit;
    Lo = Lo * seen + rimLit * smoothstep(0.25, 1.0, U0 * uB.y) * 0.6;
    // In the infrared the lanes that block visible light are the brightest thing there
    Ld += (1.0 - Tf) * 0.55;

    float v = smoothstep(1.02, 0.72, length(xy + flow.xy * 0.35));
    gl_FragColor = packed((1.0 - exp(-La * uC.x)) * v, (1.0 - exp(-Lo * uC.y)) * v, (1.0 - exp(-Ld * uC.z)) * v, (1.0 - T * Tf) * v);
}`;

// Dark clouds: dust in front of whatever is behind them. Only the opacity is much use on the band; off it, where there
// is little to hide, thin dust shows by the faint brown light it scatters from the whole galaxy.
export const DUST_FRAG = /* glsl */`
${COMMON}
uniform vec4 uBlob[8];      // Lumps strung along the cloud's shape: position, radius
uniform vec4 uA;            // Flow warp, edge roughness, fine fraying, optical depth
uniform vec4 uB;            // Direction of the brightest light nearby, rim gain, wisps
uniform vec4 uC;            // Output gains: thin dust, rim, cold dust

float envelope(vec2 p) {
    float e = 0.0;
    for (int i = 0; i < 8; i++) {
        vec2 d = p - uBlob[i].xy;
        e += exp(-dot(d, d) / (uBlob[i].w * uBlob[i].w));
    }
    return e;
}

float dustField(vec2 p, float coarse, float fine) {
    return (1.0 - exp(-envelope(p) * 1.5)) * 1.08 - 0.56 + (coarse - 0.5) * uA.y + fine * uA.z;
}

void main() {
    vec2 xy = uRect.xy + uRect.zw * (vUv * 2.0 - 1.0);
    vec3 flow = noiseAt(vec3(xy * 0.21, 0.31) + uOff).rgb - 0.5;
    vec3 flow2 = noiseAt(vec3(xy * 0.61 + flow.xy * 0.5, 0.67) + uOff.zxy).rgb - 0.5;
    vec2 xw = xy + (flow.xy + flow2.xy * 0.5) * uA.x;

    float coarse = noiseAt(vec3(xw * 0.66, 0.13) + uOff.yzx).g;
    float fine = detail(vec3(xw * 1.9, 0.71) + uOff.zyx);
    float d = dustField(xw, coarse, fine);
    // Fine threads reaching out from the cloud
    float wn = noiseAt(vec3(xw * 1.15 + flow2.xy * 0.6 + fine * 0.05, 0.57) + uOff).b;
    float wisp = ridge(wn);
    wisp *= wisp;
    wisp *= wisp;
    wisp *= wisp;
    // The column density of dust is log-normal: no edge anywhere, only dust that thickens and frays at every scale
    float tau = 0.55 * exp(d * 3.1) * (1.0 + wisp * uB.w);
    float T = exp(-tau * uA.w);

    // Thin dust shows by the light it scatters; thick dust swallows it, and lets out only enough to show its structure
    float scatter = tau * exp(-tau * 0.8) + 0.16 * (1.0 - exp(-tau));
    float thin = min(scatter, 1.0) * (0.25 + 1.5 * coarse) * exp(fine * 1.3);
    float coarse2 = noiseAt(vec3((xw + uB.xy * 0.03) * 0.66, 0.13) + uOff.yzx).g;
    float rim = sat((d - dustField(xw + uB.xy * 0.03, coarse2, fine)) * 5.0) * exp(-abs(d) * 2.4);
    float cold = (1.0 - exp(-tau * 0.24)) * (0.4 + 0.6 * exp(fine * 1.3));

    float v = smoothstep(1.02, 0.74, length(xy + flow.xy * 0.35));
    gl_FragColor = packed(thin * uC.x * v, rim * uB.z * uC.y * v, cold * uC.z * v, (1.0 - T) * v);
}`;

// Planetary nebulae: an optically thin shell around a white dwarf. Hot [O III] gas sits inside, cooler hydrogen
// and [N II] on the outside edge, and the shape comes from uP.x. Seen through its thickness a thin shell is brightest
// at its limb, so most of the light of these comes from a line around the edge of each shape.
export const PLANETARY_FRAG = /* glsl */`
${COMMON}
uniform vec4 uP;            // Shape (0 ring, 1 bipolar, 2 nested ellipses, 3 helix, 4 crescent), size, knottiness, lopsidedness
uniform vec4 uC;            // Output gains: hydrogen, oxygen, dust; w = [O III] reach

float gaussAbout(float x, float centre, float w) {
    float t = (x - centre) / w;
    return exp(-t * t);
}

void main() {
    vec2 xy = uRect.xy + uRect.zw * (vUv * 2.0 - 1.0);
    float rr = dot(xy, xy);
    if (rr >= 1.0) {
        gl_FragColor = vec4(0.0);
        return;
    }
    float zmax = sqrt(1.0 - rr);
    float ds = 2.0 * zmax / float(uSteps);
    float z = zmax - ds * 0.6 * jitter(gl_FragCoord.xy);
    float La = 0.0;
    float Lo = 0.0;
    float Ld = 0.0;
    float tauSum = 0.0;
    float shape = uP.x;
    float R0 = uP.y;
    float knotty = uP.z;
    for (int i = 0; i < uSteps; i++) {
        vec3 p = vec3(xy, z);
        z -= ds;
        vec3 o = uRot * p;
        float r = length(o) + 1e-4;
        vec3 dir = o / r;
        vec3 wob = noiseAt(o * 0.55 + uOff.zxy).rgb - 0.5;
        vec3 ow = o + wob * (0.07 + 0.09 * knotty);
        float rw = length(ow) + 1e-4;
        // Stretched along the radius, as knots blown outward by the fast wind are
        float spoke = noiseAt(dir * 0.48 + o * 0.30 + uOff).r;
        float cell = noiseAt(o * 0.52 + uOff.yzx).a;
        float knots = mix(1.0, 0.22 + 2.1 * smoothstep(0.36, 0.72, spoke) * (0.5 + 1.1 * cell), knotty);
        float ha = 0.0;
        float o3 = 0.0;
        float dust = 0.0;

        if (shape < 0.5 || (shape > 2.5 && shape < 3.5)) {
            // A thick barrel seen near end-on, with its hole full of faint hot gas. The inner edge is sharp, where the
            // star's light first meets the wall, and the outer edge frays away.
            float rho = length(ow.xy);
            float rise = smoothstep(R0 - 0.13, R0 - 0.03, rho);
            float fall = exp(-pow(max(0.0, rho - R0 + 0.04) / (shape > 2.5 ? 0.11 : 0.17), 2.0));
            float barrel = rise * fall * exp(-pow(ow.z / 0.46, 2.0));
            o3 += barrel * smoothstep(R0 + 0.07, R0 - 0.07, rho) * knots * 1.3;
            ha += barrel * smoothstep(R0 - 0.08, R0 + 0.07, rho) * knots * 1.15;
            float bubble = exp(-pow(rw / (R0 * 0.95), 4.0));
            o3 += bubble * 0.09;
            ha += bubble * 0.012;
            if (shape > 2.5) {
                // A second, tilted ring inside the first, and a broken arc of old gas outside both
                vec3 o2 = vec3(o.x, o.y * 0.82 - o.z * 0.57, o.y * 0.57 + o.z * 0.82);
                float rho2 = length(o2.xy + wob.xy * 0.05);
                float t2 = gaussAbout(rho2, R0 * 0.70, 0.075) * exp(-pow(o2.z / 0.34, 2.0));
                o3 += t2 * knots * 0.75;
                ha += t2 * knots * 0.42;
                float arc = gaussAbout(rw, R0 * 1.55, 0.045) * smoothstep(-0.25, 0.65, dot(dir, vec3(0.66, 0.71, 0.24)));
                ha += arc * (0.35 + spoke) * 0.42;
            }
            dust += barrel * 0.26;
        } else if (shape < 1.5) {
            // Two lobes pinched at a dusty waist; the size of the shell depends on the angle from the axis
            float side = ow.z > 0.0 ? 1.0 : uP.w;
            float c = abs(ow.z) / rw;
            float Rl = R0 * side * (0.16 + 1.12 * pow(c, 2.4));
            float thick = 0.045 + 0.06 * c;
            float wallB = gaussAbout(rw, Rl, thick);
            float inner = smoothstep(Rl + 0.02, Rl - 0.2, rw);
            ha += wallB * (0.28 + 1.0 * c) * knots * 0.62;
            o3 += wallB * (1.2 - 0.9 * c) * knots * 0.32 + inner * 0.042 * (1.0 - 0.4 * c);
            float rho = length(ow.xy);
            float waist = gaussAbout(rho, 0.17, 0.075) * gaussAbout(ow.z, 0.0, 0.06);
            ha += waist * 0.85 * (0.3 + cell);
            dust += waist * 3.0 + wallB * 0.08;
        } else if (shape < 2.5) {
            // Nested ellipsoids, slightly turned against each other, with two knots out along the long axis
            vec3 e1 = ow / vec3(0.66, 0.66, 1.0);
            vec3 o2 = vec3(ow.x * 0.94 - ow.z * 0.34, ow.y, ow.x * 0.34 + ow.z * 0.94);
            vec3 e2 = o2 / vec3(0.60, 0.74, 1.0);
            float s1 = length(e1);
            float s2 = length(e2);
            float inner = gaussAbout(s1, R0 * 0.70, 0.038);
            float inner2 = gaussAbout(s2, R0 * 0.82, 0.038);
            float outer = gaussAbout(s1, R0 * 1.16, 0.055);
            ha += (inner + inner2) * 0.42 * knots;
            o3 += (inner * 0.40 + inner2 * 0.32) * (0.55 + 0.75 * knots);
            ha += outer * knots * 0.42;
            o3 += exp(-pow(s1 / (R0 * 0.70), 4.0)) * 0.055;
            ha += exp(-pow(s1 / (R0 * 1.22), 6.0)) * 0.020;
            vec3 k1 = o - vec3(0.02, 0.0, R0 * 1.34);
            vec3 k2 = o + vec3(0.03, 0.0, R0 * 1.30 * uP.w);
            ha += (exp(-dot(k1, k1) / 0.0022) + exp(-dot(k2, k2) / 0.0022)) * 2.4;
            float jet = exp(-dot(o.xy, o.xy) / 0.0009) * smoothstep(R0 * 0.75, R0 * 1.0, abs(o.z)) * smoothstep(R0 * 1.36, R0 * 1.25, abs(o.z));
            ha += jet * 0.5;
            dust += inner * 0.12;
        } else {
            // An old shell ploughing into the gas around it: a thick bright crescent on one side, almost nothing on the other
            float towards = smoothstep(-0.55, 0.85, dir.x * 0.8 + dir.y * 0.6);
            float shell = gaussAbout(rw, R0 * 1.12, 0.07 + 0.09 * towards);
            ha += shell * towards * towards * knots * 1.05;
            o3 += gaussAbout(rw, R0 * 0.98, 0.06) * towards * knots * 0.26;
            o3 += exp(-pow(rw / (R0 * 1.0), 4.0)) * 0.035;
            dust += shell * towards * 0.1;
        }
        // Every planetary has a very faint, old halo of gas shed earlier in the star's life
        float halo = exp(-pow(rw / 0.72, 4.0));
        ha += halo * 0.026;
        o3 += halo * 0.012;

        // Ionisation stratifies with radius: the hotter the star, the further the oxygen zone reaches
        float reach = smoothstep(R0 * (0.9 + uC.w), R0 * 0.35, r);
        o3 *= 0.30 + 0.70 * reach;
        float edge = smoothstep(1.0, 0.86, length(p));
        La += ha * edge * ds;
        Lo += o3 * edge * ds;
        Ld += dust * edge * ds;
        tauSum += dust * edge * ds;
    }
    // Short radial streaks, the signature of gas blown outward from one point
    float rho2d = length(xy) + 1e-4;
    vec2 dir2d = xy / rho2d;
    float rays = detail(vec3(dir2d * 2.6, rho2d * 1.7) + uOff);
    float streaks = exp(rays * 0.75 * knotty * smoothstep(R0 * 0.45, R0 * 0.85, rho2d));
    La *= streaks;
    Lo *= mix(1.0, streaks, 0.7);
    gl_FragColor = packed(1.0 - exp(-La * uC.x), 1.0 - exp(-Lo * uC.y), 1.0 - exp(-Ld * uC.z), 1.0 - exp(-tauSum * 2.5));
}`;

// Supernova remnants, drawn fully grown: free expansion is self-similar, so the sprite only scales this image with
// time. The hot gas and the synchrotron glow are a ray through a lobed shell; the filaments and the thin shock in
// visible light are worked out once per pixel around the outline, in strands that run along the limb. A shell's light
// is almost all at its limb, so the middle of these is nearly empty.
export const REMNANT_FRAG = /* glsl */`
${COMMON}
uniform vec4 uS;            // Shell radius, shell width, bumpiness, kind (0 Ia, 1 II)
uniform vec4 uAsym;         // Centre offset; w = warp
uniform vec3 uAxis;         // Direction of the bright limbs and any jets
uniform vec4 uC;            // Output gains: sheet, filaments, hot gas, synchrotron
uniform vec4 uL;            // Outline: how lobed, how far the blowout reaches, direction of the blowout
uniform vec4 uF;            // Filaments: web across the middle, reach inward from the limb, how broken the limb is, jets

float sq(float x) { return x * x; }

// How far the shock is from round in this direction, as a share of its radius
float outline(vec3 dir) {
    float lobes = (noiseAt(dir * 0.105 + uOff.zxy).r - 0.5) * 2.0 * uL.x;
    float blow = max(0.0, dot(dir.xy, uL.zw));
    blow *= blow;
    return lobes + uL.y * blow * blow;
}

void main() {
    vec2 xy = uRect.xy + uRect.zw * (vUv * 2.0 - 1.0);
    float rr = dot(xy, xy);
    if (rr >= 1.0) {
        gl_FragColor = vec4(0.0);
        return;
    }
    float zmax = sqrt(1.0 - rr);
    float ds = 2.0 * zmax / float(uSteps);
    float z = zmax - ds * 0.6 * jitter(gl_FragCoord.xy);
    float L0 = 0.0;
    float L2 = 0.0;
    float L3 = 0.0;
    float kind = uS.w;
    float Rs = uS.x;
    for (int i = 0; i < uSteps; i++) {
        vec3 p = vec3(xy, z);
        z -= ds;
        vec3 c = p - uAsym.xyz * (1.0 + 0.5 * p.z);
        vec3 q = uRot * c * 0.42 + uOff;
        vec3 w = noiseAt(q * 0.8 + vec3(0.13, 0.57, 0.41)).rgb - 0.5;
        vec3 qw = q + w * uAsym.w;
        float cell = noiseAt(qw * 1.3).a;
        float n = noiseAt(qw * 1.15).r;
        float r = length(c);
        vec3 dir = c / (r + 1e-4);

        // Rayleigh-Taylor fingers push the shock in and out by a different amount in each direction
        float lobes = kind > 0.5 ? (w.x + w.y - w.z) * 0.20 : 0.0;
        float rp = r - Rs * outline(dir) + (n - 0.5) * uS.z * 1.7 + lobes;
        float d = (rp - Rs) / uS.y;
        float shell = exp(-d * d);

        // Bright limbs lie along the magnetic field's axis, as in barrel-shaped remnants
        float axial = abs(dot(dir, uAxis));
        float barrel = 0.28 + 0.95 * axial * axial;

        float sheet = shell * (0.55 + 0.9 * cell);
        float ejecta = 0.0;
        if (kind > 0.5) {
            // Massive stars leave clumps of oxygen-rich ejecta inside
            ejecta = smoothstep(0.64, 0.86, cell) * smoothstep(Rs * 0.88, Rs * 0.35, r) * 0.42;
        }
        float hot = smoothstep(Rs + 0.03, Rs * 0.45, r) * (0.10 + 0.32 * n) + shell * 0.95 * (0.5 + cell);
        float sync = shell * (0.40 + 0.9 * n) * barrel;

        float edge = smoothstep(1.0, 0.90, length(p));
        L0 += (sheet + ejecta) * edge * ds;
        L2 += hot * edge * ds;
        L3 += sync * edge * ds;
    }

    // Filaments: strands that follow the limb, broken into arcs, frayed on the inside and sharp on the outside
    vec2 d2 = xy - uAsym.xy;
    float rho = length(d2) + 1e-4;
    vec2 dir2 = d2 / rho;
    float u = rho / (Rs * (1.0 + outline(vec3(dir2, 0.0))));
    vec3 w2 = noiseAt(vec3(xy * 0.55, 0.21) + uOff).rgb - 0.5;
    float fineW = detail(vec3(xy * 2.4, 0.33) + uOff.yzx);
    float uw = u + w2.x * 0.17 + w2.y * 0.06 + fineW * 0.014;

    float s1 = ridge(noiseAt(vec3(dir2 * 0.20 + w2.xy * 0.05, uw * 2.4) + uOff).r);
    float s2 = ridge(noiseAt(vec3(dir2 * 0.38 - w2.yz * 0.06, uw * 3.8) + uOff.yzx).g);
    float s3 = ridge(0.5 + fineW * 0.8);
    s1 = pow(s1, 18.0);
    s2 = pow(s2, 24.0);
    s3 = pow(s3, 26.0);
    // Threads come and go along their length, and each is a bundle of finer ones
    float strand = smoothstep(0.30, 0.62, noiseAt(vec3(xy * 1.7, 0.61) + uOff.zxy).b);
    float threads = (s1 + 0.7 * s2) * (0.25 + 0.75 * strand) * (1.0 + 2.2 * max(0.0, fineW)) + 0.55 * s3 * strand;

    float inward = u < 1.0 ? exp(-sq((1.0 - u) / uF.y)) : exp(-sq((u - 1.0) / 0.028));
    float arcs = mix(uF.z, 1.0, smoothstep(0.36, 0.60, noiseAt(vec3(dir2 * 0.19, 0.77) + uOff.yzx).b));
    float limbBar = 0.42 + 0.95 * sq(dot(dir2, uAxis.xy));
    float knots = noiseAt(vec3(xy * 0.9, 0.53) + uOff.zxy).a;
    float fil = threads * inward * arcs * limbBar * (0.55 + 1.1 * knots);

    // A fainter web of threads across the middle, seen through the shell's near and far sides
    float web = pow(ridge(noiseAt(vec3(xy * 0.95 + w2.xy * 0.45 + fineW * 0.03, 0.39) + uOff).g), 20.0);
    web += 0.6 * pow(ridge(noiseAt(vec3(xy * 2.1 - w2.yz * 0.4 - fineW * 0.05, 0.83) + uOff.yzx).b), 24.0);
    fil += web * (0.3 + 0.7 * strand) * (1.0 + 2.0 * max(0.0, fineW)) * smoothstep(1.03, 0.92, u) * uF.x;

    // Jets along the spin axis, in those that have them
    if (uF.w > 0.0) {
        float along = dot(d2, uAxis.xy);
        float off = length(d2 - uAxis.xy * along);
        fil += uF.w * sq(sq(ridge(noiseAt(vec3(xy * 1.4, 0.11) + uOff).r))) * exp(-sq(off / 0.06))
            * smoothstep(Rs * 0.72, Rs * 0.98, abs(along)) * smoothstep(Rs * 1.26, Rs * 1.04, abs(along));
    }

    // The shock itself: the thinnest strands of all, right at the outside edge
    float s4 = pow(ridge(noiseAt(vec3(dir2 * 0.28 + w2.xz * 0.04, uw * 5.2) + uOff.zxy).b), 13.0);
    float shock = s4 * exp(-sq((u - 0.985) / 0.042)) * arcs * limbBar;

    // The filled look of the ray's own shell belongs to a young remnant: older ones show only its limb in visible light
    float hollow = mix(0.32, 1.0, smoothstep(0.55, 0.96, u)) * smoothstep(1.14, 1.0, u) * 0.6 * (0.35 + 1.3 * knots);

    gl_FragColor = packed(1.0 - exp(-(L0 * hollow + shock * 1.1) * uC.x), 1.0 - exp(-fil * uC.y), 1.0 - exp(-L2 * uC.z), 0.0);
    gl_FragColor.a = sqrt(1.0 - exp(-L3 * uC.w));
}`;
