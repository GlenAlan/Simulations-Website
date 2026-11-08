// Could this system of stars really exist? The rules every multiple-star system keeps to: sky binaries and triples, the
// pairs in clusters, black holes and their companions, and the planets and comets that circle them. Generation keeps to them
// (settleSystem, settleHole) and data/validate.js checks them (systemProblems).
//
//  Kepler       P^2 = a^3 / M (years, AU, solar masses) for every orbit, with all the mass inside it.
//  Hierarchy    Three or more stars must be a close pair with a far companion, or two pairs. The outer orbit is stable when
//               a_out / a_in > 2.8 (1 + q_out)^(2/5) (1 + e_out)^(2/5) (1 - e_out)^(-6/5) (Mardling & Aarseth 2001), taken in its
//               strictest, flat form: no allowance for tilted orbits. The figure-eight is a known stable choreography instead.
//  Roche lobes  Eggleton (1983), at closest approach, a (1 - e). No star fills its lobe unless its pair is marked as passing mass
//               across, and then it is the donor, its lobe just full, and the orbit round. No two stars ever touch.
//  Tides        A pair closer than 10 days goes round in a circle.
//  Planets      Round one part of a wider system (S-type), well inside Holman & Wiegert's (1999) stable zone; round a whole pair
//               (P-type), well outside it. Comets keep to the same, all the way round their stretched orbits.
//  Ages         The stars of a system were born together: one age, and every star's stage fits it. A main-sequence star hasn't
//               outlived its time there; a giant has.
//  Black holes  black_hole.feeding says how each is fed (settleHole): 'roche', 'wind' or 'none', and its orbit fits that.
//  Eclipses     A few detached close pairs are turned edge-on (tiltEclipses), beside the tight pairs that eclipse anyway.

import { stable } from '../core/rng.js';
import { keplerPeriodDays, logG, orbitalSpeedKms, fluxFromLuminosity } from '../core/phys.js';
import { dp, RSUN_AU, msLifetimeMyr, turnoffMass, starFromMass, absoluteVisual, apparentMag, distanceForMag } from './stellar.js';

export const TIDAL_DAYS = 10;           // Pairs closer than this are round
export const DETACHED_FILL = 0.9;       // A pair that isn't passing mass keeps both stars within this share of their lobes
export const P_TYPE_MARGIN = 1.2;       // How far beyond the edge of the unstable zone a circumbinary orbit must be
export const S_TYPE_MARGIN = 0.8;       // How far inside the stable zone an orbit round one part of a system must be
const ROUND = 0.01;                     // An orbit with less eccentricity than this counts as round
const TWIN_ROOM = 1.002;                // Twins passing mass sit this much wider than just filling: each fills 0.998 of its lobe
const AGE_SPREAD = 0.02;                // Stars born together, within this share of their age

// Black holes and how they are fed (black_hole.feeding): 'roche', a companion that fills its Roche lobe and spills gas onto a
// disc round the hole, as in the low-mass X-ray binaries; 'wind', a massive companion whose wind the hole catches, as in the
// high-mass ones; 'none', a quiet pair too far apart to feed it, faint in X-rays
const ROCHE_DONOR_MAX = 3;
const WIND_DONOR_MIN = 10;
const WIND_FILL = [0.6, 0.9];

export function holeFill(bh) {
    const c = bh.companion.star;
    return (c.radius_Rsun * RSUN_AU) / (rocheShare(c.mass_Msun / bh.mass_Msun) * bh.a_AU);
}

// Eggleton's Roche lobe: its radius as a share of the separation, for a star q times the mass of its partner
export function rocheShare(q) {
    const q3 = Math.cbrt(q);
    const q23 = q3 * q3;
    return (0.49 * q23) / (0.6 * q23 + Math.log(1 + q3));
}

// Mardling & Aarseth: the smallest stable a_out / a_in, for an outer body q_out times the mass of the pair it circles
export function stableRatio(qOut, eOut) {
    return 2.8 * (1 + qOut) ** 0.4 * (1 + eOut) ** 0.4 * (1 - eOut) ** -1.2;
}

// Holman & Wiegert: the widest stable orbit round one star of a pair (S-type), and the closest stable orbit round both
// (P-type), as shares of the pair's separation. mu is the share of the pair's mass in the star that disturbs the orbit.
export function sTypeEdge(mu, e) {
    return 0.464 - 0.38 * mu - 0.631 * e + 0.586 * mu * e + 0.15 * e * e - 0.198 * mu * e * e;
}

export function pTypeEdge(mu, e) {
    return 1.6 + 5.1 * e - 2.22 * e * e + 4.12 * mu - 4.27 * e * mu - 5.09 * mu * mu + 4.61 * e * e * mu * mu;
}

const massOf = (stars, group) => group.reduce((sum, i) => sum + stars[i].star.mass_Msun, 0);
const radiusAU = (part) => part.star.radius_Rsun * RSUN_AU;
const within = (group, outer) => group.every((i) => outer.includes(i));

// How full each star of a star-and-star orbit is: its radius over its lobe's, at closest approach
export function lobeFills(stars, orbit) {
    const ma = stars[orbit.a[0]].star.mass_Msun;
    const mb = stars[orbit.b[0]].star.mass_Msun;
    const closest = orbit.a_AU * (1 - (orbit.ecc || 0));
    return [radiusAU(stars[orbit.a[0]]) / (rocheShare(ma / mb) * closest), radiusAU(stars[orbit.b[0]]) / (rocheShare(mb / ma) * closest)];
}

// The separation at which a pair's fuller star just fills its lobe, on a round orbit
export function fillingSeparation(stars, orbit) {
    const ma = stars[orbit.a[0]].star.mass_Msun;
    const mb = stars[orbit.b[0]].star.mass_Msun;
    return Math.max(radiusAU(stars[orbit.a[0]]) / rocheShare(ma / mb), radiusAU(stars[orbit.b[0]]) / rocheShare(mb / ma));
}

// The widest orbit inside a group of stars: the pair the group's own stability rests on
function innerOrbitOf(orbits, group) {
    let best = null;
    orbits.forEach((o) => {
        const all = [...o.a, ...o.b];
        if (all.length > 1 && within(all, group) && (!best || o.a_AU > best.a_AU)) best = o;
    });
    return best;
}

// The largest outer eccentricity a hierarchy can take, by bisection: 0 if even a round orbit isn't stable
export function largestStableEcc(ratio, qOut) {
    if (ratio <= stableRatio(qOut, 0)) return 0;
    let lo = 0;
    let hi = 0.95;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (stableRatio(qOut, mid) < ratio) lo = mid;
        else hi = mid;
    }
    return lo;
}

// The closest a planet or comet may come to a system it circles whole, and the furthest it may go round one part of one
export function circumbinaryFloor(stars, orbit) {
    const ma = massOf(stars, orbit.a);
    const mb = massOf(stars, orbit.b);
    return P_TYPE_MARGIN * pTypeEdge(Math.min(ma, mb) / (ma + mb), orbit.ecc || 0) * orbit.a_AU;
}

function sTypeCeiling(stars, orbit, group) {
    const host = within(group, orbit.a) ? orbit.a : orbit.b;
    const other = host === orbit.a ? orbit.b : orbit.a;
    const mHost = massOf(stars, host);
    const mOther = massOf(stars, other);
    return S_TYPE_MARGIN * sTypeEdge(mOther / (mHost + mOther), orbit.ecc || 0) * orbit.a_AU;
}

// Where a planet or comet round some of a system's stars may go: { floor, ceiling } in AU from the centre it circles
export function stableZone(body, group) {
    const stars = body.stars;
    const all = stars.map((_, i) => i);
    const centre = group && group.length ? group : all;
    let floor = 0;
    let ceiling = Infinity;
    (body.orbits || []).forEach((orbit) => {
        if (orbit.shared_path) return;
        const members = [...orbit.a, ...orbit.b];
        if (within(members, centre)) floor = Math.max(floor, circumbinaryFloor(stars, orbit));
        else if (within(centre, orbit.a) || within(centre, orbit.b)) ceiling = Math.min(ceiling, sTypeCeiling(stars, orbit, centre));
    });
    return { floor, ceiling };
}

// The stage each star should be at for its system's age
function ageProblems(parts, code, problem) {
    const stars = parts.map((p) => p.star);
    const ages = stars.map((s) => s.age_Myr);
    const age = Math.max(...ages);
    if (Math.min(...ages) < age * (1 - AGE_SPREAD)) problem('ages', `${code}'s stars weren't born together: ${ages.join(', ')} million years`);
    stars.forEach((s, i) => {
        const life = msLifetimeMyr(s.mass_Msun);
        if (s.stage === 'main_sequence' && life < age * (1 - AGE_SPREAD)) problem('ages', `${parts[i].code} should have left the main sequence by ${Math.round(age)} million years`);
        if ((s.stage === 'giant' || s.stage === 'supergiant') && life > age * (1 + AGE_SPREAD)) problem('ages', `${parts[i].code} is a giant too young to be one`);
    });
}

// Everything wrong with one system, as { test, message }. A body with stars[] and orbits[] (a sky multiple, or a pair in a
// cluster), or a black hole and its companion. Planets and comets are checked against the stars they circle.
export function systemProblems(body) {
    const out = [];
    const problem = (test, message) => out.push({ test, message });
    if (body.black_hole) {
        const bh = body.black_hole;
        const c = bh.companion;
        const total = bh.mass_Msun + c.star.mass_Msun;
        if (Math.abs(bh.period_days / keplerPeriodDays(bh.a_AU, total) - 1) > 2e-3) problem('kepler', `${body.code}'s orbit breaks Kepler's third law`);
        const speed = (2 * Math.PI * bh.a_AU * 149597870.7) / (bh.period_days * 86400);
        const K = speed * (bh.mass_Msun / total) * Math.sin((bh.inc_deg * Math.PI) / 180);
        if (Math.abs(bh.K_kms / K - 1) > 2e-3) problem('kepler', `${body.code}'s K doesn't follow from its orbit`);
        const fill = holeFill(bh);
        if (bh.feeding === 'roche') {
            if (fill < 0.97 || fill > 1.03) problem('roche', `${body.code}'s companion should just fill its Roche lobe, not ${fill.toFixed(2)} of it`);
            if (c.star.mass_Msun > ROCHE_DONOR_MAX) problem('roche', `${body.code}'s Roche-lobe donor is too heavy to feed it steadily`);
        } else if (bh.feeding === 'wind') {
            if (fill >= 1 || fill < WIND_FILL[0] * 0.99) problem('roche', `${body.code}'s wind-fed companion fills ${fill.toFixed(2)} of its lobe`);
            if (c.star.mass_Msun < WIND_DONOR_MIN) problem('roche', `${body.code}'s companion is too light to blow a strong wind`);
        } else if (bh.feeding === 'none') {
            if (fill > DETACHED_FILL) problem('roche', `${body.code} is marked quiet but its companion fills ${fill.toFixed(2)} of its lobe`);
        } else {
            problem('roche', `${body.code} has feeding ${bh.feeding}`);
        }
        if ((bh.ecc || 0) > ROUND) problem('tides', `${body.code}'s orbit isn't round`);
        return out;
    }
    const stars = body.stars;
    const orbits = body.orbits || [];
    if (body.architecture === 'figure_eight') return out;   // An exact solution, stable in its own right

    orbits.forEach((orbit) => {
        const ma = massOf(stars, orbit.a);
        const mb = massOf(stars, orbit.b);
        if (Math.abs(orbit.period_days / keplerPeriodDays(orbit.a_AU, ma + mb) - 1) > 2e-3) problem('kepler', `${body.code}'s orbit breaks Kepler's third law`);
        const e = orbit.ecc || 0;
        if (!(e >= 0 && e < 0.5)) problem('tides', `${body.code} has eccentricity ${e}`);
        if (orbit.a.length === 1 && orbit.b.length === 1) {
            const [fa, fb] = lobeFills(stars, orbit);
            const closest = orbit.a_AU * (1 - e);
            if (closest <= radiusAU(stars[orbit.a[0]]) + radiusAU(stars[orbit.b[0]])) problem('roche', `${body.code}'s stars touch`);
            const t = body.transfer;
            const here = t && [orbit.a[0], orbit.b[0]].includes(t.donor) && [orbit.a[0], orbit.b[0]].includes(t.accretor);
            if (body.interacting && here) {
                const donorFill = t.donor === orbit.a[0] ? fa : fb;
                const accretorFill = t.donor === orbit.a[0] ? fb : fa;
                if (donorFill < 0.97 || donorFill > 1.03) problem('roche', `${body.code}'s donor doesn't fill its lobe (${donorFill.toFixed(2)})`);
                if (accretorFill >= 1) problem('roche', `${body.code}'s accretor overfills its lobe`);
                if (e > ROUND) problem('tides', `${body.code} passes mass on an eccentric orbit`);
            } else if (fa > 1 || fb > 1) {
                problem('roche', `${body.code} has a star overfilling its Roche lobe (${Math.max(fa, fb).toFixed(2)}) with no mass transfer`);
            }
            if (orbit.period_days < TIDAL_DAYS && e > ROUND) problem('tides', `${body.code}'s ${orbit.period_days.toFixed(1)}-day orbit isn't round (e = ${e})`);
        } else {
            // A star circling a pair still mustn't overfill its lobe, with the pair as one mass
            [[orbit.a, mb], [orbit.b, ma]].forEach(([group, other]) => {
                if (group.length !== 1) return;
                const fill = radiusAU(stars[group[0]]) / (rocheShare(stars[group[0]].star.mass_Msun / other) * orbit.a_AU * (1 - e));
                if (fill > 1) problem('roche', `${stars[group[0]].code} overfills its lobe round its inner pair`);
            });
            [orbit.a, orbit.b].forEach((group) => {
                if (group.length < 2) return;
                const inner = innerOrbitOf(orbits, group);
                if (!inner) return;
                const other = group === orbit.a ? mb : ma;
                const need = stableRatio(other / massOf(stars, group), e);
                if (orbit.a_AU / inner.a_AU <= need) problem('hierarchy', `${body.code} is unstable: a_out / a_in = ${(orbit.a_AU / inner.a_AU).toFixed(2)}, needs ${need.toFixed(2)}`);
            });
        }
    });
    if (stars.length > 2 && orbits.length < stars.length - 1) problem('hierarchy', `${body.code} isn't a hierarchy`);
    if (body.interacting && !body.transfer) problem('roche', `${body.code} is marked as passing mass with no donor`);
    if (body.transfer && !body.interacting) problem('roche', `${body.code} has a donor but isn't marked as passing mass`);

    // Planets and comets: well clear of the stars they circle, well inside the reach of the ones they don't
    const orbiters = [...(body.planets || []), ...(body.comets || [])];
    orbiters.forEach((p) => {
        const { floor, ceiling } = stableZone(body, p.orbit_centre_stars);
        const near = p.orbit_AU * (1 - (p.ecc || 0));
        const far = p.orbit_AU * (1 + (p.ecc || 0));
        if (near < floor) problem('planets', `${p.code} comes within ${near.toFixed(3)} AU, inside the unstable zone round its stars (${floor.toFixed(3)} AU)`);
        if (far > ceiling) problem('planets', `${p.code} goes out to ${far.toFixed(2)} AU, beyond the stable zone (${ceiling.toFixed(2)} AU)`);
    });
    ageProblems(stars, body.code, problem);
    return out;
}

// ---------- Settling a system so that it keeps to the rules ----------
// Each system is drawn first as it always was, and then put right here from a random stream of its own, so that no other
// number in the sky, and no code, moves. Only what breaks a rule changes.

// The widest orbit as first drawn. A pair that settles closer in keeps its planets where they were laid out for it.
const drawnWidest = new WeakMap();

// The closest a planet may be laid out round a whole system: three times its widest orbit, as drawn or as settled, and never
// inside its unstable zone
export function planetFloorAU(body) {
    const widest = body.orbits.reduce((max, o) => Math.max(max, o.a_AU || 0), 0);
    return Math.max(3 * widest, 3 * (drawnWidest.get(body.orbits) || 0), stableZone(body, null).floor);
}

function setPeriods(stars, orbits) {
    orbits.forEach((o) => {
        if (o.shared_path) return;
        o.period_days = stable(keplerPeriodDays(o.a_AU, massOf(stars, o.a) + massOf(stars, o.b)), 6);
    });
}

function makeRound(orbit) {
    orbit.ecc = 0;
    orbit.omega_deg = 0;
}

// One age for the whole system, and stars that fit it. The first star sets the age: a main-sequence star younger than its
// time there, a giant older, so a metal-poor giant is made a little heavier rather than older than the universe. A partner
// takes that age, and one that would have left the main sequence by then is rebuilt lighter.
function settleAges(rng, stars) {
    const first = stars[0].star;
    let age = first.age_Myr;
    const life = msLifetimeMyr(first.mass_Msun);
    if (first.stage === 'main_sequence' && life < age) {
        age = stable(life * rng.range(0.9, 0.98), 4);
        first.age_Myr = age;
    } else if ((first.stage === 'giant' || first.stage === 'supergiant') && life > age) {
        first.mass_Msun = stable(turnoffMass(age) * rng.range(1, 1.03), 4);
        first.logg = dp(logG(first.mass_Msun, first.radius_Rsun), 2);
    }
    stars.slice(1).forEach((part) => {
        const s = part.star;
        if (s.stage !== 'main_sequence') return;
        if (msLifetimeMyr(s.mass_Msun) >= age) {
            s.age_Myr = age;
            return;
        }
        const mass = stable(Math.max(0.09, Math.min(s.mass_Msun, turnoffMass(age) * rng.range(0.8, 0.97))), 4);
        part.star = starFromMass(rng, mass, { population: s.population, composition: s.composition, age, aged: Math.min(1, age / msLifetimeMyr(mass)) });
    });
}

// A star-and-star orbit. A pair passing mass sits where its donor just fills its lobe, on a round orbit. Any other pair keeps
// both stars well inside theirs, widened if need be. Close pairs are round.
function settlePair(rng, stars, orbit, passing) {
    const before = orbit.a_AU;
    if (passing) {
        makeRound(orbit);
        orbit.a_AU = stable(fillingSeparation(stars, orbit), 6);
        // Twins fill their lobes alike, and rounding can leave both a hair over: then they sit just far enough apart that
        // neither overfills, the one that passes mass still all but filling its lobe. No other pair moves.
        if (Math.min(...lobeFills(stars, orbit)) >= 1) orbit.a_AU = stable(fillingSeparation(stars, orbit) * TWIN_ROOM, 6);
    } else {
        const fill = Math.max(...lobeFills(stars, orbit));
        if (fill > DETACHED_FILL) orbit.a_AU = stable(orbit.a_AU * (fill / DETACHED_FILL) * rng.range(1.05, 1.6), 5);
    }
    setPeriods(stars, [orbit]);
    if (orbit.period_days < TIDAL_DAYS && orbit.ecc) makeRound(orbit);
    return orbit.a_AU / before;
}

// The donor of a pair passing mass is the star that fills its lobe
function donorOf(stars, orbit) {
    const ma = stars[orbit.a[0]].star.mass_Msun;
    const mb = stars[orbit.b[0]].star.mass_Msun;
    const a = radiusAU(stars[orbit.a[0]]) / rocheShare(ma / mb);
    const b = radiusAU(stars[orbit.b[0]]) / rocheShare(mb / ma);
    return a >= b ? { donor: orbit.a[0], accretor: orbit.b[0] } : { donor: orbit.b[0], accretor: orbit.a[0] };
}

// An outer orbit: wide enough for its inner pair to be stable and for its own star to stay inside its lobe, and at least ten
// times the inner period. Too eccentric an orbit is made rounder before any is made wider.
function settleOuter(rng, stars, orbits, outer, grownBy) {
    const inner = orbits[0];
    if (grownBy > 1) outer.a_AU = stable(outer.a_AU * grownBy, 5);
    const mIn = massOf(stars, outer.a);
    const mOut = massOf(stars, outer.b);
    const q = mOut / mIn;
    for (let i = 0; i < 8; i++) {
        const ratio = outer.a_AU / inner.a_AU;
        const room = largestStableEcc(ratio / 1.02, q);
        if ((outer.ecc || 0) > room) {
            if (room < 0.03) makeRound(outer);
            else outer.ecc = dp(rng.range(0, room), 3);
        }
        const star = stars[outer.b[0]];
        const fill = radiusAU(star) / (rocheShare(star.star.mass_Msun / mIn) * outer.a_AU * (1 - (outer.ecc || 0)));
        setPeriods(stars, [outer]);
        const tooClose = ratio <= stableRatio(q, outer.ecc || 0) * 1.02 || fill > DETACHED_FILL || outer.period_days < 10.5 * inner.period_days;
        if (!tooClose) break;
        outer.a_AU = stable(outer.a_AU * rng.range(1.2, 1.5), 5);
    }
    setPeriods(stars, [outer]);
}

// A system with planets: no eccentricity that would put the zone its planets avoid beyond three times its widest orbit,
// where they are laid out from
function settleForPlanets(rng, stars, orbits) {
    const widest = orbits[orbits.length - 1];
    if (circumbinaryFloor(stars, widest) <= 3 * widest.a_AU) return;
    const saved = widest.ecc;
    let lo = 0;
    let hi = saved;
    for (let i = 0; i < 30; i++) {
        widest.ecc = (lo + hi) / 2;
        if (circumbinaryFloor(stars, widest) <= 3 * widest.a_AU) lo = widest.ecc;
        else hi = widest.ecc;
    }
    widest.ecc = dp(lo * rng.range(0.6, 0.99), 3);
    if (!widest.ecc) makeRound(widest);
}

// Puts a random binary or hierarchical triple right: { stars, orbits, interacting, transfer } as data/multi.js makes them,
// with the inner pair first. passing says whether its inner pair is one of the sky's few that pass mass across.
export function settleSystem(rng, system, { passing = false, planets = false } = {}) {
    const { stars, orbits } = system;
    drawnWidest.set(orbits, orbits[orbits.length - 1].a_AU);
    settleAges(rng, stars);
    setPeriods(stars, orbits);
    const grownBy = settlePair(rng, stars, orbits[0], passing);
    if (orbits[1]) settleOuter(rng, stars, orbits, orbits[1], grownBy);
    if (planets) settleForPlanets(rng, stars, orbits);
    system.interacting = passing;
    system.transfer = passing ? donorOf(stars, orbits[0]) : null;
    return system;
}

// ---------- Black holes: how each is fed ----------

const HOLE_DISTANCE_PC = [6000, 15000];      // A wind-fed pair's supergiant is seen from across the disc
const WIND_MAG = [6.5, 8.5];

// Sets a black hole's pair up for how it is fed, from a stream of its own. 'roche': its low-mass companion just fills its
// lobe on a round orbit, hours to days long. 'wind': its companion becomes a blue supergiant (make(rng) gives one), within
// its lobe but near filling it, placed far enough off to look as faint as such stars do. 'none': left as drawn, a detached
// pair. The period and the companion's K follow from the orbit either way, so Kepler and the mass function hold.
export function settleHole(rng, body, feeding, make) {
    const bh = body.black_hole;
    const c = bh.companion;
    bh.feeding = feeding;
    if (feeding === 'wind') {
        c.star = make(rng);
        const absV = absoluteVisual(c.star.luminosity_Lsun, c.star.teff_K);
        const d = stable(Math.min(HOLE_DISTANCE_PC[1], Math.max(HOLE_DISTANCE_PC[0], distanceForMag(absV, rng.range(WIND_MAG[0], WIND_MAG[1])))), 5);
        c.distance_pc = d;
        c.brightness = { flux_Wm2: stable(fluxFromLuminosity(c.star.luminosity_Lsun, d), 5), mag: apparentMag(absV, d) };
        body.distance_pc = d;
        body.brightness = { ...c.brightness };
        bh.a_AU = stable((c.star.radius_Rsun * RSUN_AU) / (rocheShare(c.star.mass_Msun / bh.mass_Msun) * rng.range(WIND_FILL[0], WIND_FILL[1])), 4);
    } else if (feeding === 'roche') {
        bh.a_AU = stable((c.star.radius_Rsun * RSUN_AU) / rocheShare(c.star.mass_Msun / bh.mass_Msun), 4);
    } else {
        bh.jets = false;                          // Nothing falls in, so nothing is flung out
    }
    const total = bh.mass_Msun + c.star.mass_Msun;
    bh.period_days = stable(keplerPeriodDays(bh.a_AU, total), 6);
    bh.K_kms = stable(orbitalSpeedKms(bh.a_AU, bh.period_days) * (bh.mass_Msun / total) * Math.sin((bh.inc_deg * Math.PI) / 180), 5);
}

// Which black holes are fed which way: the heaviest companions blow the winds, the lightest fill their lobes, and the rest
// are quiet. counts: { roche, wind, none }. Returns a Map from body to feeding.
export function holeFeedings(holes, counts) {
    const byMass = holes.slice().sort((a, b) => b.black_hole.companion.star.mass_Msun - a.black_hole.companion.star.mass_Msun || (a.code < b.code ? -1 : 1));
    const out = new Map();
    byMass.slice(0, counts.wind).forEach((b) => out.set(b, 'wind'));
    byMass.slice(counts.wind).reverse().forEach((b, i) => out.set(b, i < counts.roche ? 'roche' : 'none'));
    return out;
}

// ---------- Eclipses ----------

// How far from edge-on a pair can be seen and still eclipse, in degrees: 90 - i < arcsin((R1 + R2) / a) on a round orbit
export function eclipseWindowDeg(stars, orbit) {
    const reach = (radiusAU(stars[orbit.a[0]]) + radiusAU(stars[orbit.b[0]])) / orbit.a_AU;
    return (Math.asin(Math.min(1, reach)) * 180) / Math.PI;
}

// Turns n detached close pairs edge-on enough to eclipse, chosen from those whose two stars are alike enough in temperature
// that both eclipses show: the classic light curve with a deep dip and a shallower one. Only the inner orbit's tilt changes,
// and nothing stored depends on it, since speeds along the line of sight are worked out from the orbit (data/orbits.js).
export function tiltEclipses(rng, systems, n) {
    const suits = (b) => {
        const o = b.orbits[0];
        if (b.interacting || o.shared_path || o.ecc || o.period_days < 1 || o.period_days > 15) return false;
        const t = [b.stars[o.a[0]].star.teff_K, b.stars[o.b[0]].star.teff_K];
        return Math.min(...t) / Math.max(...t) >= 0.7 && eclipseWindowDeg(b.stars, o) >= 3 && 90 - o.inc_deg > eclipseWindowDeg(b.stars, o);
    };
    const chosen = rng.shuffle(systems.filter(suits).sort((a, b) => (a.code < b.code ? -1 : 1))).slice(0, n);
    chosen.forEach((b) => {
        const o = b.orbits[0];
        o.inc_deg = dp(90 - eclipseWindowDeg(b.stars, o) * rng.range(0.05, 0.6), 2);
    });
    return chosen;
}
