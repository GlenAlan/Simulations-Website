// One big galaxy of our own Local Group, as Andromeda is: the classic exception to Hubble's law. At under a megaparsec,
// the pull between it and our galaxy outweighs the expansion of space, so the two are falling together and its light is
// blueshifted, about -300 km/s, where every other galaxy's is redshifted. It is a large spiral seen steeply tilted, about
// 3 by 1 degrees on the sky, and bright enough to see by eye. At its centre is a quiet black hole of about 10^8 solar
// masses, made as every other galaxy's is (data/nuclei.js).
//
// Made last of all, from a stream and codes of its own, so nothing else in the sky changes: no code, place, motion, look
// or depth (core/depth.js keeps it out of the other galaxies' ranking). Its galaxy block is any galaxy's (data/deep_sky.js)
// with local_group: true.

import { stable } from '../core/rng.js';
import { C_KMS, fluxFromLuminosity } from '../core/phys.js';
import { MIN_ALT, azAltToVec3, galacticLatitude } from '../core/sky.js';
import { dp, distanceModulus } from './stellar.js';
import { addQuietNucleus } from './nuclei.js';

export const LOCAL_GROUP_GALAXIES = 1;

const DISTANCE_MPC = [0.75, 0.8];
const VELOCITY_KMS = [-310, -290];
const MAG = [3.3, 3.5];
const SIZE_DEG = [3, 3.2];
const INCLINATION_DEG = [72, 78];            // Steeply tilted: about three times as long as it is wide
const HOLE_MSUN = [0.9e8, 1.5e8];
const LATITUDE_DEG = [18, 35];               // Well away from the galactic band, as Andromeda is at about 22 degrees
const ALTITUDE_DEG = [16, 72];
const RAD = Math.PI / 180;

export function isLocalGroup(body) {
    return !!(body && body.galaxy && body.galaxy.local_group);
}

function makeGalaxy(rng, body) {
    const dMpc = dp(rng.range(DISTANCE_MPC[0], DISTANCE_MPC[1]), 4);
    const distance = stable(dMpc * 1e6, 6);
    const mag = dp(rng.range(MAG[0], MAG[1]), 3);
    const absMag = mag - distanceModulus(distance);
    const luminosity = stable(10 ** (-0.4 * (absMag - 4.74)), 4);
    const velocity = dp(rng.range(VELOCITY_KMS[0], VELOCITY_KMS[1]), 1);
    body.distance_pc = distance;
    body.radial_velocity_kms = velocity;
    body.brightness = { flux_Wm2: stable(fluxFromLuminosity(luminosity, distance), 5), mag };
    body.galaxy = {
        morphology: 'spiral',
        inclination_deg: dp(rng.range(INCLINATION_DEG[0], INCLINATION_DEG[1]), 1),
        position_angle_deg: dp(rng.range(0, 180), 1),
        size_deg: dp(rng.range(SIZE_DEG[0], SIZE_DEG[1]), 3),
        z: Number((velocity / C_KMS).toPrecision(5)),
        radio_lobes: false,
        active_nucleus: false,
        starburst: false,
        distance_Mpc: dMpc,
        abs_mag: dp(absMag, 2),
        luminosity_Lsun: luminosity,
        local_group: true
    };
}

// True if two directions are closer than the given cos, compared after rounding as data/sky_layout.js does
function tooClose(dot, threshold) {
    return dot > threshold - 1e-7 && Math.round(dot * 1e9) > Math.round(threshold * 1e9);
}

// Somewhere away from the band and well up, its whole disc clear of the hard-coded systems and of the space kept round the
// target, none of the other extended objects overlapping it, and the first sky's bodies clear of its middle. The deeper sky's
// faint stars may lie across its disc, as our own galaxy's stars lie in front of Andromeda, but not on its bulge. strict keeps
// everything further off; the fallback only keeps the layout's own spacing, and is there so that every sky has one.
function placeGalaxy(rng, body, layout, avoid) {
    const R = body.galaxy.size_deg / 2;
    const lowest = Math.max(ALTITUDE_DEG[0], MIN_ALT + 0.3 + R);
    const sinLo = Math.sin(lowest * RAD);
    const sinHi = Math.sin(ALTITUDE_DEG[1] * RAD);
    const fits = (v, strict) => {
        const near = (sky, need) => {
            const w = azAltToVec3(sky.az, sky.alt);
            return tooClose(v[0] * w[0] + v[1] * w[1] + v[2] * w[2], Math.cos(need * RAD));
        };
        if (avoid.some((a) => near(a.sky, R + 1 + (a.clear_deg || 0)))) return false;
        return layout.placed.every((other) => {
            // A deeper body keeps the spacing its own brightness asks for (data/sky_layout.js deepSpacingDeg)
            let need = other.deep ? Math.max(strict ? 0.5 : 0.35, (other.spacing || 0) * 1.02) : strict ? 1.2 : 1.02;
            if (other.radius > 0) need = Math.max(need, other.radius + R + (strict ? 0.3 : 0));
            if (other.clear > 0) need = Math.max(need, other.clear + R);
            return !tooClose(v[0] * other.v[0] + v[1] * other.v[1] + v[2] * other.v[2], Math.cos(need * RAD));
        });
    };
    let spot = null;
    for (let tries = 0; tries < 6000 && !spot; tries++) {
        const az = dp(rng.range(0, 360), 3);
        const alt = dp(Math.asin(rng.range(sinLo, sinHi)) / RAD, 3);
        const lat = dp(Math.abs(galacticLatitude(az, alt)), 3);
        if (lat < LATITUDE_DEG[0] || lat > LATITUDE_DEG[1]) continue;
        const v = azAltToVec3(az, alt);
        if (fits(v, tries < 4000)) spot = { az, alt, v };
    }
    if (!spot) return false;                  // Validation would report it; it doesn't happen
    body.sky = { az: spot.az, alt: spot.alt };
    layout.placed.push({ entry: { body, radius_deg: R }, v: spot.v, radius: R, deep: false, spacing: 1, clear: 0 });
    return true;
}

// Makes the Local Group's galaxies, places them and gives each its black hole. base(code) is a new body of kind 'galaxy';
// avoid lists the hard-coded systems' bodies, each with any clear_deg kept round it.
export function makeLocalGroup(rng, nextCode, base, layout, avoid) {
    const out = [];
    for (let i = 0; i < LOCAL_GROUP_GALAXIES; i++) {
        const r = rng.fork(`galaxy:${i}`);
        const body = base(nextCode());
        makeGalaxy(r, body);
        placeGalaxy(r.fork('sky'), body, layout, avoid);
        addQuietNucleus(r.fork('nucleus'), body, nextCode, stable(r.logRange(HOLE_MSUN[0], HOLE_MSUN[1]), 4));
        out.push(body);
    }
    return out;
}

// ---------- Checks, for data/validate.js ----------

export function localGroupProblems(u, fail, avoidCodes) {
    const local = u.bodies.filter(isLocalGroup);
    if (local.length !== LOCAL_GROUP_GALAXIES) fail(`${local.length} Local Group galaxies, expected ${LOCAL_GROUP_GALAXIES}`);
    local.forEach((body) => {
        const g = body.galaxy;
        if (!(body.radial_velocity_kms < 0)) fail(`${body.code} is a Local Group galaxy moving away`);
        if (!(body.distance_pc < 1e6)) fail(`${body.code} is a Local Group galaxy ${body.distance_pc} pc away`);
        if (g.morphology !== 'spiral' || !body.nucleus || body.nucleus.nucleus.active) fail(`${body.code} isn't a spiral with a quiet black hole`);
        const lat = Math.abs(galacticLatitude(body.sky.az, body.sky.alt));
        if (lat < LATITUDE_DEG[0] - 0.01) fail(`${body.code} is ${lat} degrees from the band`);
        const v = azAltToVec3(body.sky.az, body.sky.alt);
        avoidCodes.forEach(({ code, clear }) => {
            const r = u.resolve(code);
            if (!r) return;
            const w = azAltToVec3(r.body.sky.az, r.body.sky.alt);
            const sep = Math.acos(Math.min(1, v[0] * w[0] + v[1] * w[1] + v[2] * w[2])) / RAD;
            if (sep < g.size_deg / 2 + (clear || 0)) fail(`${body.code} covers ${code}`);
        });
    });
}
