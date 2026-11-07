// How everything moves along our line of sight (spec 12), as in the real sky. Positive is away from us: redshift.
//
//  Galaxies     The Hubble flow, v = H0 d, plus a peculiar velocity of a couple of hundred km/s: all redshifted, more so
//               the further they are.
//  Quasars      Their z, as made.
//  Our galaxy   Three parts, added up:
//               - Differential rotation of the disc, Oort's v = A d sin 2l cos^2 b, with A = 15 km/s/kpc: the pattern grows
//                 with distance, red and blue in turn every 90 degrees of galactic longitude round the band.
//               - The Sun's own motion, 20 km/s towards an apex: everything ahead of us blue, everything behind red.
//               - Each object's own scatter, small for young stars and gas, larger for old stars, and largest for the halo,
//                 which hardly turns with the disc: we sweep past it at about 220 km/s.
//               Nearby stars are a mix of red and blue; far ones show the pattern.
//  Further out  Satellites and neighbours of our galaxy (beyond 20 kpc) don't share its spin, so they show our 220 km/s
//               and a scatter of their own.
//
// A system's planets, stars, members and companion all share its velocity; a cluster's members keep their own small
// spread about it. Radial velocities follow body.radial_velocity_kms everywhere, so every spectrum shifts with them.

import { H0, C_KMS } from '../core/phys.js';
import { galacticLonLat } from '../core/sky.js';
import { dp, clamp } from './stellar.js';

const RAD = Math.PI / 180;
const OORT_A = 15;              // km/s per kpc
const SUN_SPEED = 20;           // km/s, towards the apex
const APEX = { l: 56, b: 23 };
const ROTATION_SPEED = 220;     // How fast the disc carries us round, which the halo doesn't share
const GALAXY_EDGE_KPC = 20;     // Beyond this, objects don't turn with the disc
const PECULIAR_GALAXY = 200;    // km/s, one-dimensional
const PECULIAR_LIMIT = 550;
const STAR_LIMIT = 450;         // The fastest halo stars; nearly all stars stay well within 300 km/s

// { sigma, lag }: an object's own scatter, and how far its kind lags behind the disc's turning (asymmetric drift)
const YOUNG = { sigma: 8, lag: 0 };
const GAS = { sigma: 6, lag: 0 };
const DISC = { sigma: 25, lag: 10 };
const OLD_DISC = { sigma: 32, lag: 15 };
const THICK = { sigma: 50, lag: 50 };
const HALO = { sigma: 110, lag: ROTATION_SPEED };
const HALO_SHARE = 0.15;        // Of the metal-poor stars, the share that are true halo stars; the rest are thick disc
const RUNAWAY_SHARE = 0.04;     // Of the O and B stars, flung out of their birth clusters

function starKinematics(star, rng) {
    if (star.population === 'II') return rng.chance(HALO_SHARE) ? HALO : THICK;
    if (star.stage === 'white_dwarf') return OLD_DISC;
    if (star.stage === 'supergiant') return YOUNG;
    if (star.stage === 'giant') return { sigma: 22, lag: 8 };
    if (star.class === 'O' || star.class === 'B') return YOUNG;
    if (star.class === 'A') return { sigma: 12, lag: 2 };
    if (star.class === 'F') return { sigma: 18, lag: 5 };
    return DISC;
}

function unit(l, b) {
    return [Math.cos(b * RAD) * Math.cos(l * RAD), Math.cos(b * RAD) * Math.sin(l * RAD), Math.sin(b * RAD)];
}

const APEX_VEC = unit(APEX.l, APEX.b);
const TURN_VEC = unit(90, 0);

// The part of a radial velocity that comes from where an object is: the disc's spin, the Sun's motion, and the lag of its kind
export function galacticFlow(body, kinematics) {
    const { l, b } = galacticLonLat(body.sky.az, body.sky.alt);
    const n = unit(l, b);
    const dKpc = body.distance_pc / 1000;
    const reflex = -SUN_SPEED * (n[0] * APEX_VEC[0] + n[1] * APEX_VEC[1] + n[2] * APEX_VEC[2]);
    const towardsTurn = n[0] * TURN_VEC[0] + n[1] * TURN_VEC[1] + n[2] * TURN_VEC[2];
    if (dKpc > GALAXY_EDGE_KPC) return reflex - ROTATION_SPEED * towardsTurn;
    const cosB = Math.cos(b * RAD);
    // The halo doesn't share the disc's spin, so only the disc's own kinds follow Oort's pattern
    const spin = kinematics.lag >= ROTATION_SPEED ? 0 : OORT_A * dKpc * Math.sin(2 * l * RAD) * cosB * cosB;
    return spin + reflex - kinematics.lag * towardsTurn;
}

function inGalaxy(body, kinematics, rng, limit) {
    return dp(clamp(galacticFlow(body, kinematics) + rng.gauss(0, kinematics.sigma), -limit, limit), 1);
}

function hubble(distancePc, rng) {
    return dp(H0 * (distancePc / 1e6) + clamp(rng.gauss(0, PECULIAR_GALAXY), -PECULIAR_LIMIT, PECULIAR_LIMIT), 1);
}

// The radial velocity of one sky body, from a stream of its own. null leaves it as made.
function velocityOf(body, rng) {
    switch (body.kind) {
    case 'star': {
        let v = inGalaxy(body, starKinematics(body.star, rng), rng, STAR_LIMIT);
        const s = body.star;
        if (s.stage === 'main_sequence' && (s.class === 'O' || s.class === 'B') && rng.chance(RUNAWAY_SHARE)) {
            v = dp(v + (rng.chance(0.5) ? 1 : -1) * rng.range(40, 90), 1);
        }
        return v;
    }
    case 'binary':
    case 'multiple':
        return inGalaxy(body, starKinematics(body.stars[0].star, rng), rng, STAR_LIMIT);
    case 'cluster':
        return inGalaxy(body, body.cluster.type === 'globular' ? HALO : YOUNG, rng, STAR_LIMIT);
    case 'nebula':
        return inGalaxy(body, body.nebula.type === 'planetary' ? DISC : GAS, rng, 300);
    case 'neutron_star':
        return inGalaxy(body, { sigma: 150, lag: 0 }, rng, 500);       // Born with a kick
    case 'black_hole':
        return inGalaxy(body, { sigma: 40, lag: 0 }, rng, 300);
    case 'rogue_planet':
        return inGalaxy(body, DISC, rng, 300);
    case 'supernova':
        // The supernovae in this sky are in our galaxy's halo and its neighbours, beyond the disc
        return body.distance_pc > 1.5e6 ? hubble(body.distance_pc, rng) : inGalaxy(body, { sigma: 80, lag: 0 }, rng, 500);
    case 'galaxy':
        return hubble(body.distance_pc, rng);
    default:
        return null;            // Quasars keep their z, comets their own motion round the Sun, home planets theirs
    }
}

// Hands a body's velocity on to everything inside it
function passDown(body) {
    const v = body.radial_velocity_kms;
    (body.planets || []).forEach((p) => { p.radial_velocity_kms = v; });
    (body.comets || []).forEach((c) => { c.radial_velocity_kms = v; });
    (body.stars || []).forEach((s) => { s.radial_velocity_kms = v; });
    if (body.black_hole) body.black_hole.companion.radial_velocity_kms = v;
    if (body.galaxy) body.galaxy.z = stableZ(v);
}

function stableZ(v) {
    return Number((v / C_KMS).toPrecision(5));
}

// Sets every sky body's radial velocity. keep: codes whose velocity is fixed (the hard-coded systems). Run once the sky
// is laid out, since direction matters; each body draws from a stream of its own, keyed by its code.
export function assignVelocities(bodies, rng, keep) {
    bodies.forEach((body) => {
        if (keep.has(body.code)) return;
        const own = rng.fork(body.code);
        const v = velocityOf(body, own);
        if (v === null) return;
        const before = body.radial_velocity_kms;
        body.radial_velocity_kms = v;
        passDown(body);
        if (body.cluster) {
            // Members keep their small spread about the cluster
            body.cluster.members.forEach((m) => {
                m.radial_velocity_kms = dp(v + (m.radial_velocity_kms - before), 2);
                (m.stars || []).forEach((s) => { s.radial_velocity_kms = m.radial_velocity_kms; });
            });
        }
    });
}
