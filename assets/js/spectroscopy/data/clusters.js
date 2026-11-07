// Star clusters: every member was born together, so a cluster's H-R diagram shows a real main-sequence turn-off.
// Members heavier than turnoff_Msun have left the main sequence; msLifetimeMyr() links that mass to age_Myr, the same
// rule a student uses to read the age back off the diagram. Globular members are always metal-poor (spec 8.1).
//
// body.cluster: { type: 'open'|'globular', age_Myr, radius_deg, members[], population, composition,
//                 turnoff_Msun, turnoff_teff_K, n_stars }
// A member: { code, kind: 'cluster_member', parent, offset_deg: { x, y }, star, brightness, distance_pc,
//             radial_velocity_kms }. Its star's composition is the object held at cluster.composition.

import { stable } from '../core/rng.js';
import { fluxFromLuminosity } from '../core/phys.js';
import { limitingMag, MIN_FOV } from '../core/sky.js';
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

function memberOffset(rng, type, radius) {
    const angle = rng.range(0, 2 * Math.PI);
    const u = rng.next();
    // Globulars crowd to the centre (a rough King profile); open clusters are loose
    const r = type === 'globular' ? radius * Math.min(1, 0.25 * Math.sqrt(u / (1.0001 - u))) : radius * Math.sqrt(u);
    return { x: dp(r * Math.cos(angle), 4), y: dp(r * Math.sin(angle), 4) };
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
        return {
            code: nextCode(),
            kind: 'cluster_member',
            parent: body.code,
            offset_deg: memberOffset(rng, type, radius),
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
        n_stars: members.length
    };
    return body;
}
