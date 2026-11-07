// Star clusters: every member was born together, so a cluster's H-R diagram shows a real main-sequence turn-off.
// Members heavier than turnoff_Msun have left the main sequence; msLifetimeMyr() links that mass to age_Myr, the same
// rule a student uses to read the age back off the diagram. Globular members are always metal-poor (spec 8.1).
//
// body.cluster: { type: 'open'|'globular', age_Myr, radius_deg, members[], population, composition,
//                 turnoff_Msun, turnoff_teff_K, n_stars, shape: { axis_ratio, pa_deg, core } }
// A member: { code, kind: 'cluster_member', parent, offset_deg: { x, y }, depth_offset, star, brightness, distance_pc,
//             radial_velocity_kms }. Its star's composition is the object held at cluster.composition.

import { Rng, stable } from '../core/rng.js';
import { fluxFromLuminosity } from '../core/phys.js';
import { limitingMag, MIN_ALT, MIN_FOV } from '../core/sky.js';
import { dp, luminosityFromRT, mainSequenceAt, msLifetimeMyr, turnoffMass, starFromMass, clusterGiant, makeWhiteDwarf,
    makeComposition, absoluteVisual, distanceModulus, combineMags } from './stellar.js';

const MEMBER_LIMIT_MAG = limitingMag(MIN_FOV) - 0.5;
const LOWEST_MEMBER_MASS = 0.25;
// The listed members of a globular stand for a far larger crowd, which sets how bright it looks as a whole
const GLOBULAR_CROWD = 25;

// The lightest main-sequence star still visible at this distance, walking up a small grid of masses
function faintestVisibleMass(distancePc) {
    const budget = MEMBER_LIMIT_MAG - distanceModulus(distancePc);
    let mass = LOWEST_MEMBER_MASS;
    for (let i = 0; i < 80; i++) {
        const track = mainSequenceAt(mass);
        if (absoluteVisual(luminosityFromRT(track.R, track.T), track.T) <= budget) return mass;
        mass = stable(mass * 1.05, 5);
    }
    return mass;
}

// ---------- Where the members sit ----------
// A real cluster has no edge: its stars thin out into the field, in a shape of its own. So radius_deg is only how big a
// cluster looks, which is what framing and the sky's layout go by, and members may lie well past it. Heavy stars sink to
// the middle over time, so the bright ones keep in and the faint ones wander. All of this is look, not physics, and has
// its own random stream, so that the numbers everything else draws never change.

const TAU = 2 * Math.PI;
const REACH = { open: 3.2, globular: 2.6 };     // No member further out than this many radii. Few get near it
const CLOSEST = { open: 0.024, globular: 0.008 };   // Members keep this many radii apart, so that they can be told apart
const DEPTH_SPREAD = 0.06;                      // How far either side of its cluster's depth an open cluster's member may be

// A Plummer profile, seen in projection: half the stars lie within scale, and a long thin tail runs out from there. One
// too far out is drawn again, as clamping it would pile members up in a ring.
function plummerRadius(rng, scale, reach) {
    for (let i = 0; i < 30; i++) {
        const u = rng.next();
        const r = scale * Math.sqrt(u / (1 - u));
        if (r <= reach) return r;
    }
    return reach * rng.next();
}

// One or a few lumps with a loose crowd around them, the whole lot stretched and bent: no two alike, and none of them round
function openRecipe(rng) {
    const count = rng.chance(0.25) ? 1 : rng.chance(0.3) ? 2 : rng.int(3, 6);
    const lumps = [];
    for (let i = 0; i < count; i++) {
        const at = rng.range(0, TAU);
        const from = count === 1 ? rng.range(0, 0.15) : rng.range(0.2, 0.85);
        const along = rng.logRange(0.1, 0.34);
        const turn = rng.range(0, TAU);
        lumps.push({
            x: from * Math.cos(at),
            y: from * Math.sin(at),
            along,
            across: along * rng.range(0.5, 1),
            c: Math.cos(turn),
            s: Math.sin(turn),
            weight: rng.range(0.35, 1)
        });
    }
    return {
        lumps,
        total: lumps.reduce((sum, lump) => sum + lump.weight, 0),
        loose: rng.range(0.25, 0.5),                // The share of members in the loose crowd
        core: rng.range(0.6, 1),
        axis_ratio: rng.range(0.6, 1),
        pa: rng.range(0, Math.PI),
        bend: rng.range(0.05, 0.25),
        bendRate: rng.range(1.2, 3.2),
        bendPhase: rng.range(0, TAU)
    };
}

// A spot in radii from the middle, for a star whose rank in brightness is faint: 0 the brightest, 1 the faintest
function openSpot(rng, recipe, faint) {
    let x;
    let y;
    if (rng.chance(recipe.loose * (0.4 + 1.2 * faint))) {
        const r = plummerRadius(rng, recipe.core * (0.8 + 0.4 * faint), REACH.open);
        const angle = rng.range(0, TAU);
        x = r * Math.cos(angle);
        y = r * Math.sin(angle);
    } else {
        let pick = rng.next() * recipe.total;
        const lump = recipe.lumps.find((l) => (pick -= l.weight) < 0) || recipe.lumps[0];
        const r = plummerRadius(rng, 1 + 0.3 * faint, 8);
        const angle = rng.range(0, TAU);
        const u = r * lump.along * Math.cos(angle);
        const v = r * lump.across * Math.sin(angle);
        x = lump.x + u * lump.c - v * lump.s;
        y = lump.y + u * lump.s + v * lump.c;
    }
    const c = Math.cos(recipe.pa);
    const s = Math.sin(recipe.pa);
    const along = x * c + y * s;
    const across = (y * c - x * s) * recipe.axis_ratio;
    const sx = along * c - across * s + recipe.bend * Math.sin(recipe.bendRate * y + recipe.bendPhase);
    const sy = along * s + across * c + recipe.bend * Math.sin(recipe.bendRate * x + recipe.bendPhase * 1.7);
    return { x: sx, y: sy };
}

function globularRecipe(rng) {
    return { core: rng.range(0.2, 0.3), axis_ratio: rng.range(0.86, 1), pa: rng.range(0, Math.PI) };
}

function globularSpot(rng, recipe, faint) {
    const r = plummerRadius(rng, recipe.core * (0.8 + 0.4 * faint), REACH.globular);
    const angle = rng.range(0, TAU);
    const u = r * Math.cos(angle);
    const v = r * Math.sin(angle) * recipe.axis_ratio;
    const c = Math.cos(recipe.pa);
    const s = Math.sin(recipe.pa);
    return { x: u * c - v * s, y: u * s + v * c };
}

const medianOf = (list) => list.slice().sort((a, b) => a - b)[Math.floor(list.length / 2)];

// Sets each member's offset_deg and depth_offset, and returns the shape the layer needs for what it draws around them
function placeMembers(code, type, radius, members) {
    const rng = new Rng(`cluster-shape:${code}`);
    const globular = type === 'globular';
    const recipe = globular ? globularRecipe(rng) : openRecipe(rng);
    const spot = globular ? globularSpot : openSpot;
    // Brightest first, so that a faint star fits in around the bright ones and not the other way about
    const ranked = members.slice().sort((a, b) => a.brightness.mag - b.brightness.mag || (a.code < b.code ? -1 : 1));
    const closest2 = CLOSEST[type] ** 2;
    const spots = [];
    ranked.forEach((member, i) => {
        const faint = i / Math.max(1, ranked.length - 1);
        let at = spot(rng, recipe, faint);
        for (let tries = 0; tries < 12 && spots.some((s) => (s.x - at.x) ** 2 + (s.y - at.y) ** 2 < closest2); tries++) {
            at = spot(rng, recipe, faint);
        }
        spots.push(at);
    });
    // An open cluster's lumps can fall anywhere, so bring its middle back to the middle and give it the usual size
    if (!globular) {
        const mx = medianOf(spots.map((s) => s.x));
        const my = medianOf(spots.map((s) => s.y));
        const half = medianOf(spots.map((s) => Math.hypot(s.x - mx, s.y - my)));
        const scale = rng.range(0.5, 0.62) / Math.max(half, 0.1);
        spots.forEach((s) => {
            s.x = (s.x - mx) * scale;
            s.y = (s.y - my) * scale;
        });
    }
    ranked.forEach((member, i) => {
        let { x, y } = spots[i];
        // Rescaling can carry the odd one a long way: back into the tail, at a place of its own
        const r = Math.hypot(x, y);
        if (r > REACH[type]) {
            const to = REACH[type] * rng.range(0.6, 1) / r;
            x *= to;
            y *= to;
        }
        member.offset_deg = { x: dp(x * radius, 4), y: dp(y * radius, 4) };
        member.depth_offset = globular ? 0 : dp(rng.range(-DEPTH_SPREAD, DEPTH_SPREAD), 3);
    });
    return { axis_ratio: dp(recipe.axis_ratio, 3), pa_deg: dp((recipe.pa * 180) / Math.PI, 1), core: dp(recipe.core, 3) };
}

// Run once the sky is laid out. A cluster keeps clear of the horizon by its radius, and a stray could go further, so a
// low cluster's strays go up instead of down.
export function keepMembersAboveHorizon(body) {
    body.cluster.members.forEach((member) => {
        if (body.sky.alt + member.offset_deg.y < MIN_ALT + 0.3) member.offset_deg.y = -member.offset_deg.y;
    });
}

// Fills in body.cluster, the body's distance and its integrated brightness. nextCode gives member codes.
export function makeCluster(rng, nextCode, body, type) {
    const globular = type === 'globular';
    const age = stable(globular ? rng.range(9000, 13000) : rng.logRange(5, 800), 4);
    const distance = stable(globular ? rng.logRange(800, 1500) : rng.logRange(150, 2500), 5);
    const population = globular ? 'II' : 'I';
    const composition = makeComposition(rng, population);
    const total = globular ? rng.int(100, 150) : rng.int(30, 150);
    const mTurn = turnoffMass(age);
    const turnTrack = mainSequenceAt(mTurn);
    const turnoff = { mass: mTurn, T: turnTrack.T, L: luminosityFromRT(turnTrack.R, turnTrack.T) };
    const options = { population, composition, age };

    const nEvolved = globular ? Math.round(total * rng.range(0.12, 0.18)) : rng.int(1, 4);
    const allowRemnants = mTurn < 7 && age >= 100;
    const nRemnants = allowRemnants ? (globular ? Math.round(total * 0.04) : rng.int(0, 3)) : 0;
    const nMain = total - nEvolved - nRemnants;

    const stars = [];
    // Even steps in log mass with jitter, so the sequence is well filled right up to the turn-off
    const mLow = Math.min(faintestVisibleMass(distance), mTurn / 1.3);
    for (let i = 0; i < nMain; i++) {
        const f = (i + rng.next()) / nMain;
        const mass = stable(mLow * (mTurn / mLow) ** f, 4);
        const life = msLifetimeMyr(mass);
        stars.push(starFromMass(rng, mass, { ...options, aged: Math.min(1, age / life), tight: true }));
    }
    // A globular has enough giants to trace the whole branch; an open cluster's few are caught in the long red giant phase
    for (let i = 0; i < nEvolved; i++) {
        const progress = globular ? (i + rng.next()) / nEvolved : rng.range(0.55, 1);
        stars.push(clusterGiant(rng, turnoff, progress, options));
    }
    for (let i = 0; i < nRemnants; i++) {
        const cooled = Math.max(10, age - msLifetimeMyr(mTurn * rng.range(1.1, 2.2)));
        // A rough cooling law: 25,000 K at 50 million years, falling slowly after
        const T = stable(Math.min(60000, Math.max(6000, 25000 * (cooled / 50) ** -0.35)), 4);
        const dwarf = makeWhiteDwarf(rng, { wd_type: 'DA', population, composition, T, age });
        stars.push(dwarf);
    }

    const radius = dp(globular ? rng.range(0.2, 0.6) : rng.range(0.4, 1.6), 3);
    const members = stars.map((star) => {
        const absV = absoluteVisual(star.luminosity_Lsun, star.teff_K);
        // Members used to take their places from this stream. placeMembers has its own, so these two draws are thrown away,
        // which keeps every later number from it, and so every code and speed, the same.
        rng.next();
        rng.next();
        return {
            code: nextCode(),
            kind: 'cluster_member',
            parent: body.code,
            offset_deg: { x: 0, y: 0 },
            depth_offset: 0,
            star,
            distance_pc: distance,
            radial_velocity_kms: 0, // Set by the caller, once the cluster's own velocity is known
            brightness: {
                flux_Wm2: stable(fluxFromLuminosity(star.luminosity_Lsun, distance), 5),
                mag: dp(absV + distanceModulus(distance), 3)
            },
            visual_seed: ''
        };
    });
    members.forEach((m) => { m.visual_seed = m.code; });
    const shape = placeMembers(body.code, type, radius, members);

    // The hottest star still on the main sequence: what a student reads off the diagram
    const hottest = members.reduce((max, m) => (m.star.stage === 'main_sequence' ? Math.max(max, m.star.teff_K) : max), 0);
    const crowd = globular ? GLOBULAR_CROWD : 1;
    const totalFlux = members.reduce((sum, m) => sum + m.brightness.flux_Wm2, 0) * crowd;
    const crowdMags = -2.5 * Math.log10(crowd);
    const brightest = combineMags(members.map((m) => m.brightness.mag));

    body.distance_pc = distance;
    body.brightness = { flux_Wm2: stable(totalFlux, 5), mag: dp(brightest + crowdMags, 3) };
    body.cluster = {
        type,
        age_Myr: age,
        radius_deg: radius,
        members,
        population,
        composition,
        turnoff_Msun: mTurn,
        turnoff_teff_K: hottest,
        n_stars: members.length,
        shape
    };
    return body;
}
