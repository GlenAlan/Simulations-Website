// Geometry of the sky dome, shared by generation (data/) and drawing (render/). No DOM or WebGL.
//
// Azimuth runs clockwise from north, altitude up from the horizon, both in degrees.
// World axes: +y is straight up, -z is north (az 0), +x is east (az 90). The observer stands at the origin.

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

// The faintest apparent magnitude drawn at a given field of view, so faint objects appear as you zoom in.
// Generation keeps every body that shows in visible light brighter than limitingMag(MIN_FOV) (about 17.5).
export function limitingMag(fovDeg) {
    return 6 + 5 * Math.log10(80 / fovDeg);
}
