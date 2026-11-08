// Geometry of the sky dome, shared by generation (data/) and drawing (render/). No DOM or WebGL.
//
// Azimuth runs clockwise from north, altitude up from the horizon, both in degrees.
// World axes: +y is straight up, -z is north (az 0), +x is east (az 90). The observer stands at the origin.

import { GALACTIC_CENTRE_AZ } from './bands.js';

const RAD = Math.PI / 180;

export const MIN_ALT = 5;              // Every body sits above this altitude
export const DEFAULT_VIEW = { az: 200, alt: 32, fov: 80 };
export const MIN_FOV = 0.4;            // Vertical field of view limits (degrees)
export const MAX_FOV = 100;             // Any wider and a flat view smears the sky at the frame's edges

// The galactic plane is the great circle whose pole is here: it rises to 90 - |pole alt| at its highest
export const GALACTIC_POLE = { az: 115, alt: 38 };

export function azAltToVec3(az, alt) {
    const a = az * RAD;
    const h = alt * RAD;
    const cosH = Math.cos(h);
    return [cosH * Math.sin(a), Math.sin(h), -cosH * Math.cos(a)];
}

export function vec3ToAzAlt(x, y, z) {
    const r = Math.hypot(x, y, z) || 1;
    const alt = Math.asin(Math.max(-1, Math.min(1, y / r))) / RAD;
    let az = Math.atan2(x, -z) / RAD;
    if (az < 0) az += 360;
    return { az, alt };
}

// Great-circle separation of two directions, in degrees
export function angularSeparation(az1, alt1, az2, alt2) {
    const a = azAltToVec3(az1, alt1);
    const b = azAltToVec3(az2, alt2);
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return Math.acos(Math.max(-1, Math.min(1, dot))) / RAD;
}

// Galactic latitude of a direction, in degrees: 0 on the band, 90 at its pole
export function galacticLatitude(az, alt) {
    const v = azAltToVec3(az, alt);
    const p = azAltToVec3(GALACTIC_POLE.az, GALACTIC_POLE.alt);
    return Math.asin(Math.max(-1, Math.min(1, v[0] * p[0] + v[1] * p[1] + v[2] * p[2]))) / RAD;
}

// Galactic coordinates on the dome: x towards the bulge, on the band at GALACTIC_CENTRE_AZ (core/bands.js), as the Milky Way
// is drawn (render/layers/background.js); y longitude 90, the way the disc turns; z the pole the Sun's apex leans towards,
// north in our galaxy. This sky is made up, so two signs are free: NORTH_POLE_SIGN 1 puts z at GALACTIC_POLE, and TURN_SIGN 1
// makes the disc turn towards z x x, as ours does. With both -1 the disc turns towards GALACTIC_POLE x x, so GALACTIC_POLE
// plays our north pole, and the Sun's slow drift out of the plane (about 7 km/s, which sets its apex 23 degrees off the band)
// heads the other way, away from it. That is our galaxy with the Sun at the other end of its up-and-down bob through the disc,
// which it reaches every few tens of millions of years: just as real. Of the four ways round, it gives the most redshift
// across this sky (data/motions.js), as the owner asked.
export const NORTH_POLE_SIGN = -1;
export const TURN_SIGN = -1;
let galacticAxes = null;

function axes() {
    if (galacticAxes) return galacticAxes;
    const pole = azAltToVec3(GALACTIC_POLE.az, GALACTIC_POLE.alt);
    const z = pole.map((c) => NORTH_POLE_SIGN * c);
    const centreAlt = Math.atan2(
        -Math.cos(GALACTIC_POLE.alt * RAD) * Math.cos((GALACTIC_CENTRE_AZ - GALACTIC_POLE.az) * RAD),
        Math.sin(GALACTIC_POLE.alt * RAD)
    ) / RAD;
    const x = azAltToVec3(GALACTIC_CENTRE_AZ, centreAlt);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]].map((c) => TURN_SIGN * c);
    galacticAxes = { x, y, z };
    return galacticAxes;
}

// Galactic longitude (0 to 360, from the bulge towards the way the disc turns) and latitude (positive towards the north
// galactic pole) of a direction, in degrees
export function galacticLonLat(az, alt) {
    const v = azAltToVec3(az, alt);
    const { x, y, z } = axes();
    const dot = (a) => v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
    let l = Math.atan2(dot(y), dot(x)) / RAD;
    if (l < 0) l += 360;
    return { l, b: Math.asin(Math.max(-1, Math.min(1, dot(z)))) / RAD };
}

// The direction on the dome at a galactic longitude and latitude, in degrees: galacticLonLat the other way round
export function galacticToAzAlt(l, b) {
    const { x, y, z } = axes();
    const cb = Math.cos(b * RAD);
    const p = [0, 1, 2].map((i) => cb * (Math.cos(l * RAD) * x[i] + Math.sin(l * RAD) * y[i]) + Math.sin(b * RAD) * z[i]);
    return vec3ToAzAlt(p[0], p[1], p[2]);
}

// The faintest apparent magnitude drawn at a given field of view, so faint objects appear as you zoom in.
// Generation keeps every body that shows in visible light brighter than limitingMag(MIN_FOV) (about 17.5).
export function limitingMag(fovDeg) {
    return 6 + 5 * Math.log10(80 / fovDeg);
}
