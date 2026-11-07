// Small patches of sky around a centre. Galaxies, clusters and their overlays all use this one mapping, so a
// thing drawn "0.3 degrees right of its parent" is in the same place for everyone. No WebGL, so it loads in Node.
//
// At a centre (az, alt): +x runs along increasing azimuth, which is to the right on screen when looking at it;
// +y runs along increasing altitude, which is up on screen. Offsets are arcs along the sky, in degrees.

import { azAltToVec3, vec3ToAzAlt } from '../../core/sky.js';

const RAD = Math.PI / 180;

export const SKY_RADIUS = 1000; // Sky objects sit on a sphere this far from the observer; only direction matters

// Extended objects come up gently as you zoom in: each magnitude below the limit dims them by this share of what
// it would dim a star. A galaxy or cluster stays a small jewel in the wide sky, and only reaches full brightness close to.
const MAG_SOFTNESS = 0.25;

export function revealGain(mag, limitMag) {
    return Math.min(1, 10 ** (-0.4 * MAG_SOFTNESS * Math.max(0, mag - limitMag)));
}

// The same, for shaders that include BAND_GLSL
export const REVEAL_GLSL = /* glsl */`
float revealGain(float mag) {
    return min(1.0, pow(10.0, -0.4 * ${MAG_SOFTNESS.toFixed(2)} * max(0.0, mag - uLimitMag)));
}
`;

// Unit vectors at a sky position: the direction itself, then east (+x) and up (+y) along the sky
export function tangentBasis(az, alt) {
    const a = az * RAD;
    const h = alt * RAD;
    return {
        centre: azAltToVec3(az, alt),
        east: [Math.cos(a), 0, Math.sin(a)],
        north: [-Math.sin(h) * Math.sin(a), Math.cos(h), Math.sin(h) * Math.cos(a)]
    };
}

// The unit vector an offset of (xDeg, yDeg) away from the basis's centre points along
export function offsetVector(basis, xDeg, yDeg) {
    const r = Math.hypot(xDeg, yDeg);
    if (r === 0) return basis.centre.slice();
    const cos = Math.cos(r * RAD);
    const sinOverR = Math.sin(r * RAD) / r;
    const dir = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        dir[i] = basis.centre[i] * cos + (basis.east[i] * xDeg + basis.north[i] * yDeg) * sinOverR;
    }
    return dir;
}

// The { az, alt } a cluster member, or anything else with offset_deg { x, y }, is seen at
export function memberDirection(body, member) {
    const v = offsetVector(tangentBasis(body.sky.az, body.sky.alt), member.offset_deg.x, member.offset_deg.y);
    return vec3ToAzAlt(v[0], v[1], v[2]);
}

// Two vectors in the sky's tangent plane for a quad at this basis: u along a position angle measured from up
// towards the right, v a quarter turn anticlockwise from it as seen from the observer (so the quad faces inwards).
export function quadAxes(basis, positionAngleDeg, halfLength) {
    const c = Math.cos(positionAngleDeg * RAD);
    const s = Math.sin(positionAngleDeg * RAD);
    const u = [0, 0, 0];
    const v = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        u[i] = (basis.north[i] * c + basis.east[i] * s) * halfLength;
        v[i] = (basis.north[i] * s - basis.east[i] * c) * halfLength;
    }
    return { u, v };
}

// Half a quad's width in world units, for something this many degrees across
export function worldHalfSize(sizeDeg) {
    return Math.tan((sizeDeg * RAD) / 2) * SKY_RADIUS;
}

// Pick candidates scattered over an elliptical patch, so that a click anywhere on a large object finds it without
// its reach swamping a star that sits in front. Appends { code, az, alt, radiusPx: 0 } to out. No more than maxPoints.
export function scatterPicks(out, code, basis, positionAngleDeg, majorDeg, minorDeg, stepDeg, maxPoints = 800) {
    const step = Math.max(stepDeg, Math.sqrt((Math.PI * majorDeg * minorDeg) / maxPoints));
    const c = Math.cos(positionAngleDeg * RAD);
    const s = Math.sin(positionAngleDeg * RAD);
    for (let i = -Math.floor(majorDeg / step); i <= majorDeg / step; i++) {
        for (let j = -Math.floor(minorDeg / step); j <= minorDeg / step; j++) {
            const a = i * step;
            const b = j * step;
            if ((a * a) / (majorDeg * majorDeg) + (b * b) / (minorDeg * minorDeg) > 1) continue;
            // a runs along the position angle, b square to it, as in quadAxes
            const v = offsetVector(basis, a * s - b * c, a * c + b * s);
            const { az, alt } = vec3ToAzAlt(v[0], v[1], v[2]);
            out.push({ code, az, alt, radiusPx: 0 });
        }
    }
}
