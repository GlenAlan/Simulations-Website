// How light bends around a black hole, baked into tables. No DOM or WebGL.
//
// Around a non-spinning hole every ray stays in one plane, and its path depends only on its impact parameter b (how
// far off centre it arrives). With u = 1/r, in units where the hole's mass M = 1, the path obeys Binet's equation:
//     d2u/dpsi2 = 3 u^2 - u
// where psi is the angle swept around the hole since the ray left the observer. So one table of u(b, psi) describes
// every ray around every hole, and a pixel can find where its ray meets the accretion disc with a single texture
// read, instead of tracing the ray step by step. That is what makes this cheap enough for a school laptop.

export const B_CRIT = 3 * Math.sqrt(3);  // Rays passing closer than this are captured: the edge of the shadow
export const PSI_CAP = 10;               // Enough to reach the disc plane three times (3 pi)
export const TABLE = {
    nB: 512,                             // Columns: impact parameter, crowded around B_CRIT where rays change fastest
    nY: 192,                             // Rows: psi as a fraction of the angle at which that ray ends
    width: 0.03,
    bMax: 100
};
const T0 = Math.asinh(-B_CRIT / TABLE.width);
const T1 = Math.asinh((TABLE.bMax - B_CRIT) / TABLE.width);
export const TABLE_T0 = T0;
export const TABLE_T1 = T1;

export function columnToB(x) {
    return B_CRIT + TABLE.width * Math.sinh(T0 + x * (T1 - T0));
}

// One ray: writes u at each step into `path`, returns the swept angle at which it ended and how many steps it took
function traceRay(b, path) {
    const h = Math.min(0.01, 0.02 * b);
    const maxSteps = Math.min(path.length - 1, Math.ceil(PSI_CAP / h));
    let u = 0;
    let v = 1 / b;
    let n = 0;
    path[0] = 0;
    while (n < maxSteps) {
        // Classic fourth-order Runge-Kutta for u' = v, v' = 3u^2 - u
        const k1u = v;
        const k1v = 3 * u * u - u;
        let uu = u + 0.5 * h * k1u;
        const k2u = v + 0.5 * h * k1v;
        const k2v = 3 * uu * uu - uu;
        uu = u + 0.5 * h * k2u;
        const k3u = v + 0.5 * h * k2v;
        const k3v = 3 * uu * uu - uu;
        uu = u + h * k3u;
        const k4u = v + h * k3v;
        const k4v = 3 * uu * uu - uu;
        const nextU = u + (h / 6) * (k1u + 2 * k2u + 2 * k3u + k4u);
        const nextV = v + (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
        if (nextU <= 0) {          // Back out to infinity: it escaped
            const f = u / (u - nextU);
            path[++n] = 0;
            return { psiEnd: (n - 1 + f) * h, steps: n, h };
        }
        if (nextU >= 0.5) {        // Through the horizon: captured
            const f = (0.5 - u) / (nextU - u);
            path[++n] = 0.5;
            return { psiEnd: (n - 1 + f) * h, steps: n, h };
        }
        u = nextU;
        v = nextV;
        path[++n] = u;
    }
    return { psiEnd: n * h, steps: n, h }; // Still circling at the cap
}

// ray[y * nB + x] = u; psiEnd[x] = angle where that ray ends; deflection[x] = how far an escaping ray has been bent
export function bendingTables() {
    const { nB, nY } = TABLE;
    const ray = new Float32Array(nB * nY);
    const psiEnd = new Float32Array(nB);
    const deflection = new Float32Array(nB);
    const path = new Float32Array(1200);
    for (let ix = 0; ix < nB; ix++) {
        const b = Math.max(1e-3, columnToB(ix / (nB - 1)));
        const end = traceRay(b, path);
        psiEnd[ix] = end.psiEnd;
        deflection[ix] = b > B_CRIT ? Math.max(0, end.psiEnd - Math.PI) : 0;
        for (let iy = 0; iy < nY; iy++) {
            const psi = (iy / (nY - 1)) * end.psiEnd;
            const s = Math.min(end.steps, psi / end.h);
            const i = Math.min(end.steps - 1, Math.floor(s));
            const f = s - i;
            ray[iy * nB + ix] = path[i] * (1 - f) + path[i + 1] * f;
        }
    }
    return { ray, psiEnd, deflection };
}

// Bending of a ray at impact parameter b, in radians, for code that needs it outside the shader
export function deflectionAt(b, tables) {
    if (b >= 60) return 4 / b + 11.78 / (b * b);
    if (b <= B_CRIT) return tables.deflection[0];
    const t = Math.asinh((b - B_CRIT) / TABLE.width);
    const x = ((t - T0) / (T1 - T0)) * (TABLE.nB - 1);
    const i = Math.min(TABLE.nB - 2, Math.floor(x));
    return tables.deflection[i] + (x - i) * (tables.deflection[i + 1] - tables.deflection[i]);
}
