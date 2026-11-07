// The raymarch programs baked into textures by nebula_bake.js. Each one walks a ray through a unit sphere of
// gas and writes four channels, so that the sprite can rebuild the object in any band without marching again:
//
//   clouds and planetaries   R hydrogen zone, G oxygen zone, B warm dust (all sqrt encoded), A dust opacity
//   supernova remnants       R shock sheet and ejecta, G filaments, B hot gas, A synchrotron (all sqrt encoded)
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
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
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

vec4 packed(float r, float g, float b, float a) {
    return vec4(sqrt(sat(r)), sqrt(sat(g)), sqrt(sat(b)), sat(a));
}
`;

// Emission, reflection and dark clouds. uB.w chooses which: they share their turbulence and differ in how the
// gas is lit. Hot stars ionise what is near them, so [O III] sits close in and hydrogen further out, and dust
// surfaces that face a star light up as bright rims.
export const CLOUD_FRAG = /* glsl */`
${COMMON}
uniform vec4 uBlob[6];      // Lumps that make up the cloud's overall shape: position, radius
uniform vec4 uStar[4];      // Ionising stars: position, strength
uniform vec4 uLane[2];      // Big dust lanes as warped sheets: normal, offset
uniform vec4 uA;            // Warp, gas threshold, dust amount, dust optical depth
uniform vec4 uB;            // Cavity radius, [O III] reach, rim gain, mode (0 emission, 1 reflection, 2 dark)
uniform vec4 uC;            // Output gains: hydrogen, oxygen, dust; w = lane width

float envelope(vec3 p) {
    float e = 0.0;
    for (int i = 0; i < 6; i++) {
        vec3 d = p - uBlob[i].xyz;
        e += exp(-dot(d, d) / (uBlob[i].w * uBlob[i].w));
    }
    return e;
}

// How much ionising light reaches p, and the direction to the star that supplies most of it
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
    float z = zmax - ds * ign(gl_FragCoord.xy);
    float T = 1.0;
    float Tir = 1.0;
    float La = 0.0;
    float Lo = 0.0;
    float Ld = 0.0;
    float mode = uB.w;
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
        // Ionisation fronts are thin sheets, and a sheet seen edge-on is a bright thread: this keeps fine structure
        // alive through the integral along the ray, which would otherwise average it away
        float sheetN = noiseAt(qc * 1.45 + vec3(0.19, 0.83, 0.47)).b;
        float sheet = 1.0 - abs(2.0 * sheetN - 1.0);
        sheet *= sheet;
        sheet *= sheet * sheet;
        float faint = smoothstep(-0.5, 0.15, f) * edge * 0.085;

        vec3 pw = p + w * 0.6;
        vec3 dq = qw * 0.95 + vec3(0.53, 0.11, 0.29);
        float dustBase = dustField(pw, dq, n);
        float dust = dustBase * smoothstep(-0.30, 0.18, f) * edge * uA.z;

        vec3 toStar;
        float U = ionisation(p, toStar);
        if (mode > 1.5) {
            // Dark cloud: dust everywhere the gas would be, thick in the middle, with only a whisper of light
            float thick = smoothstep(0.0, 0.34, f) * edge;
            float solid = thick * (0.55 + 1.1 * n) * uA.z + dust * 0.35;
            float thin = thick * (1.0 - thick);
            La += T * thin * ds;
            Lo += T * thin * n * ds;
            Ld += Tir * solid * (0.5 + 0.7 * thick) * ds;
            float tauD = solid * uA.w * ds;
            Tir *= exp(-tauD * 0.03);
            T *= exp(-tauD);
            continue;
        }

        // Rim: dust just here, less the dust a little way towards the star, is a surface that faces that star
        vec3 dq2 = (qw + uRot * toStar * 0.022) * 0.95 + vec3(0.53, 0.11, 0.29);
        float dust2 = dustField(pw + toStar * 0.07, dq2, n);
        float rim = max(0.0, dustBase - dust2) * smoothstep(-0.25, 0.1, f) * edge;

        float u = sat(U * 0.13);
        // A wind-blown cavity around the brightest star, with a compressed wall
        float wall = 1.0;
        if (uB.x > 0.0) {
            float r0 = length(p - uStar[0].xyz) + (n - 0.5) * 0.30;
            float wd = (r0 - uB.x * 1.12) / (uB.x * 0.30);
            wall = smoothstep(uB.x * 0.62, uB.x * 1.02, r0) * (1.0 + 1.7 * exp(-wd * wd));
        }
        float g = gas * wall * (0.55 + 2.4 * sheet);
        float tau = dust * uA.w * ds;
        if (mode > 0.5) {
            // Reflection: starlight scattered by dust, falling off with distance and picking out the wisps
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
            continue;
        }
        // Close to the stars oxygen is ionised twice and shines teal; further out it is hydrogen that shines red
        float zone = smoothstep(0.18, 1.0, U * uB.y);
        float ha = (g + faint) * (0.09 + u * (0.5 + 1.3 * n)) * (1.0 - 0.8 * zone);
        float o3 = (g + faint * 0.5) * zone * (0.35 + 1.2 * n);
        ha += rim * (0.06 + u) * uB.z * (1.0 - 0.6 * zone);
        o3 += rim * zone * uB.z * 0.55;
        La += T * ha * ds;
        Lo += T * o3 * ds;
        // Warm dust shows in the infrared: hotter by the stars, and with dense cores that visible light can't leave
        float core = smoothstep(0.62, 0.97, e) * smoothstep(0.1, 0.5, f) * edge;
        Ld += Tir * (dust * (0.22 + 0.8 * u) + core * 0.34 + g * 0.08) * ds;
        Tir *= exp(-tau * 0.06);
        T *= exp(-tau);
    }
    // A soft shoulder rather than a hard clip, so that the brightest gas keeps its structure
    gl_FragColor = packed(1.0 - exp(-La * uC.x), 1.0 - exp(-Lo * uC.y), 1.0 - exp(-Ld * uC.z), 1.0 - T);
}`;

// Planetary nebulae: an optically thin shell around a white dwarf. Hot [O III] gas sits inside, cooler hydrogen
// and [N II] on the outside edge, and the shape comes from uP.x.
export const PLANETARY_FRAG = /* glsl */`
${COMMON}
uniform vec4 uP;            // Shape (0 ring, 1 bipolar, 2 elliptical, 3 double ring), size, knottiness, lopsidedness
uniform vec4 uC;            // Output gains: hydrogen, oxygen, dust; w = [O III] reach

void main() {
    vec2 xy = uRect.xy + uRect.zw * (vUv * 2.0 - 1.0);
    float rr = dot(xy, xy);
    if (rr >= 1.0) {
        gl_FragColor = vec4(0.0);
        return;
    }
    float zmax = sqrt(1.0 - rr);
    float ds = 2.0 * zmax / float(uSteps);
    float z = zmax - ds * ign(gl_FragCoord.xy);
    float La = 0.0;
    float Lo = 0.0;
    float Ld = 0.0;
    float tauSum = 0.0;
    float shape = uP.x;
    float R0 = uP.y;
    for (int i = 0; i < uSteps; i++) {
        vec3 p = vec3(xy, z);
        z -= ds;
        vec3 o = uRot * p;
        float r = length(o) + 1e-4;
        vec3 dir = o / r;
        // Stretched along the radius, as knots blown outward by the fast wind are
        float spoke = fbm(dir * 0.48 + o * 0.30 + uOff);
        vec3 wob = noiseAt(o * 0.55 + uOff.zxy).rgb - 0.5;
        vec3 ow = o + wob * 0.10;
        float rw = length(ow) + 1e-4;
        float cell = noiseAt(o * 0.52 + uOff.yzx).a;
        float knots = mix(1.0, 0.16 + 2.3 * smoothstep(0.38, 0.72, spoke) * (0.45 + 1.1 * cell), uP.z);
        float ha = 0.0;
        float o3 = 0.0;
        float dust = 0.0;

        if (shape < 0.5 || shape > 2.5) {
            // A thick torus seen at some tilt, with its hole full of faint hot gas
            float rho = length(ow.xy);
            float zz = ow.z / 0.82;
            float d = length(vec2(rho - R0, zz));
            float torus = exp(-pow(d / 0.135, 2.0));
            o3 += torus * smoothstep(R0 + 0.10, R0 - 0.09, rho) * knots * 1.1;
            ha += torus * smoothstep(R0 - 0.09, R0 + 0.06, rho) * knots * 1.5;
            float bubble = exp(-pow(rw / (R0 * 0.92), 4.0));
            o3 += bubble * 0.07;
            ha += exp(-pow((rw - R0 * 1.42) / 0.06, 2.0)) * 0.06 * (0.5 + spoke);
            if (shape > 2.5) {
                // A second, tilted ring inside the first, as in the double-ringed helix-like nebulae
                vec3 o2 = vec3(o.x, o.y * 0.86 - o.z * 0.51, o.y * 0.51 + o.z * 0.86);
                float rho2 = length(o2.xy);
                float d2 = length(vec2(rho2 - R0 * 0.62, o2.z / 0.7));
                float t2 = exp(-pow(d2 / 0.09, 2.0));
                o3 += t2 * knots * 0.9;
                ha += t2 * knots * 0.25;
            }
            dust += torus * 0.3;
        } else if (shape < 1.5) {
            // Two lobes pinched at a dusty waist; the size of the shell depends on the angle from the axis
            float side = ow.z > 0.0 ? 1.0 : uP.w;
            float c = abs(ow.z) / rw;
            float Rl = R0 * side * (0.16 + 1.12 * pow(c, 2.4));
            float thick = 0.055 + 0.075 * c;
            float wallB = exp(-pow((rw - Rl) / thick, 2.0));
            float inner = smoothstep(Rl + 0.02, Rl - 0.2, rw);
            ha += wallB * (0.25 + 1.0 * c) * knots * 0.8;
            o3 += wallB * (1.25 - 0.9 * c) * knots * 0.42 + inner * 0.05 * (1.0 - 0.4 * c);
            float rho = length(ow.xy);
            float waist = exp(-pow((rho - 0.17) / 0.075, 2.0) - pow(ow.z / 0.06, 2.0));
            ha += waist * 1.1 * (0.3 + cell);
            dust += waist * 3.0 + wallB * 0.1;
        } else {
            // Nested ellipsoids, slightly turned against each other, with two knots out along the long axis
            vec3 e1 = ow / vec3(0.66, 0.66, 1.0);
            vec3 o2 = vec3(ow.x * 0.94 - ow.z * 0.34, ow.y, ow.x * 0.34 + ow.z * 0.94);
            vec3 e2 = o2 / vec3(0.60, 0.74, 1.0);
            float s1 = length(e1);
            float s2 = length(e2);
            float inner = exp(-pow((s1 - R0 * 0.70) / 0.05, 2.0));
            float inner2 = exp(-pow((s2 - R0 * 0.82) / 0.05, 2.0));
            float outer = exp(-pow((s1 - R0 * 1.16) / 0.06, 2.0));
            o3 += (inner * 0.62 + inner2 * 0.48) * (0.55 + 0.75 * knots);
            ha += outer * knots * 0.55 + (inner + inner2) * 0.06;
            o3 += exp(-pow(s1 / (R0 * 0.70), 4.0)) * 0.05;
            ha += exp(-pow(s1 / (R0 * 1.22), 6.0)) * 0.035;
            vec3 k1 = o - vec3(0.02, 0.0, R0 * 1.34);
            vec3 k2 = o + vec3(0.03, 0.0, R0 * 1.30 * uP.w);
            ha += (exp(-dot(k1, k1) / 0.0022) + exp(-dot(k2, k2) / 0.0022)) * 3.2;
            float jet = exp(-dot(o.xy, o.xy) / 0.0009) * smoothstep(R0 * 0.75, R0 * 1.0, abs(o.z)) * smoothstep(R0 * 1.36, R0 * 1.25, abs(o.z));
            ha += jet * 0.7;
            dust += inner * 0.15;
        }
        // Every planetary has a very faint, old halo of gas shed earlier in the star's life
        float halo = exp(-pow(rw / 0.72, 4.0));
        ha += halo * 0.035;
        o3 += halo * 0.02;

        // Ionisation stratifies with radius: the hotter the star, the further the oxygen zone reaches
        float reach = smoothstep(R0 * (0.9 + uC.w), R0 * 0.35, r);
        o3 *= 0.35 + 0.65 * reach;
        float edge = smoothstep(1.0, 0.86, length(p));
        La += ha * edge * ds;
        Lo += o3 * edge * ds;
        Ld += dust * edge * ds;
        tauSum += dust * edge * ds;
    }
    gl_FragColor = packed(1.0 - exp(-La * uC.x), 1.0 - exp(-Lo * uC.y), 1.0 - exp(-Ld * uC.z), 1.0 - exp(-tauSum * 2.5));
}`;

// Supernova remnants, drawn fully grown: free expansion is self-similar, so the sprite only scales this image with
// time. Type Ia is a clean thin sphere; Type II is thick, knotted and lopsided, with ejecta inside.
export const REMNANT_FRAG = /* glsl */`
${COMMON}
uniform vec4 uS;            // Shell radius, shell width, bumpiness, kind (0 Ia, 1 II)
uniform vec4 uAsym;         // Centre offset; w = warp
uniform vec3 uAxis;         // Direction of the bright limbs and any jets
uniform vec4 uC;            // Output gains: sheet, filaments, hot gas, synchrotron

void main() {
    vec2 xy = uRect.xy + uRect.zw * (vUv * 2.0 - 1.0);
    float rr = dot(xy, xy);
    if (rr >= 1.0) {
        gl_FragColor = vec4(0.0);
        return;
    }
    float zmax = sqrt(1.0 - rr);
    float ds = 2.0 * zmax / float(uSteps);
    float z = zmax - ds * ign(gl_FragCoord.xy);
    float L0 = 0.0;
    float L1 = 0.0;
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
        float n = fbm(qw * 1.15);
        float r = length(c);
        vec3 dir = c / (r + 1e-4);

        // Rayleigh-Taylor fingers push the shock in and out by a different amount in each direction
        float lobes = kind > 0.5 ? (w.x + w.y - w.z) * 0.20 : 0.0;
        float rp = r + (cell - 0.5) * uS.z + (n - 0.5) * uS.z * 0.8 + lobes;
        float d = (rp - Rs) / uS.y;
        float shell = exp(-d * d);

        // Filaments: thin sheets where a warped noise crosses its middle value. Seen edge-on they read as threads
        vec3 fq = qw * vec3(2.3) + dir * 0.45;
        float fn = noiseAt(fq).r;
        float fn2 = noiseAt(OCT * fq * 2.7 + 0.21).g;
        float ridge = 1.0 - abs(2.0 * fn - 1.0);
        float ridge2 = 1.0 - abs(2.0 * fn2 - 1.0);
        float threads = pow(ridge, 7.0) + 0.55 * pow(ridge2, 9.0);
        float zone = smoothstep(Rs * (kind > 0.5 ? 0.42 : 0.80), Rs * 0.95, rp) * smoothstep(Rs * 1.12, Rs * 1.0, rp);
        float fil = threads * zone * (0.35 + 1.4 * cell);

        // Bright limbs lie along the magnetic field's axis, as in barrel-shaped remnants
        float axial = abs(dot(dir, uAxis));
        float barrel = 0.28 + 0.95 * axial * axial;

        float sheet = shell * (0.55 + 0.9 * cell);
        float ejecta = 0.0;
        if (kind > 0.5) {
            // Massive stars leave clumps of oxygen-rich ejecta inside, and two faint jets along the spin axis
            ejecta = smoothstep(0.64, 0.86, cell) * smoothstep(Rs * 0.88, Rs * 0.35, r) * 0.42;
            float along = dot(c, uAxis);
            float off = length(c - uAxis * along);
            float jet = exp(-pow(off / 0.05, 2.0)) * smoothstep(Rs * 0.8, Rs, abs(along)) * smoothstep(Rs * 1.3, Rs * 1.05, abs(along));
            fil += jet * threads * 2.5;
            sheet += jet * 0.5;
        }
        float hot = smoothstep(Rs + 0.03, Rs * 0.45, r) * (0.30 + 0.9 * n) + shell * 0.95 * (0.5 + cell);
        float sync = shell * (0.40 + 0.9 * n) * barrel;

        float edge = smoothstep(1.0, 0.90, length(p));
        L0 += (sheet + ejecta) * edge * ds;
        L1 += fil * edge * ds;
        L2 += hot * edge * ds;
        L3 += sync * edge * ds;
    }
    gl_FragColor = packed(1.0 - exp(-L0 * uC.x), 1.0 - exp(-L1 * uC.y), 1.0 - exp(-L2 * uC.z), 0.0);
    gl_FragColor.a = sqrt(1.0 - exp(-L3 * uC.w));
}`;
