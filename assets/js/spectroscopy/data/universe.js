// Generates the whole sky from a seed, in the browser, on load. Nothing about the bodies ships as a data file; hard-coded
// systems come out of one encoded block (data/sealed.js). The same seed gives the same sky in every browser: integer
// random numbers, a separate stream per concern, and every pow, log or sin rounded before it is stored or compared.
//
// This file is also the top of the schema. Each kind's own block is described where it is built: data/stellar.js (a
// star block), data/planets.js, data/multi.js, data/clusters.js, data/deep_sky.js. Units are in the field names. Sky
// positions are degrees (core/sky.js).
//
// A body: { code, kind, sky: { az, alt }, distance_pc, radial_velocity_kms, bands: { radio, ir, visible, uv, xray },
//           brightness: { flux_Wm2, mag }, visual_seed, deep?, ...its kind's block }
//   brightness.flux_Wm2 is the true bolometric flux; mag is apparent visual magnitude (99 where it can't be seen at all).
//   deep: true marks the further, fainter bodies added behind the first sky (data/quotas.js SKY_SCALE). They rank for
//   depth among their own kind's (core/depth.js); nothing else need treat them differently.
//   A star or multi-star body may also have comets[], comets of its own (data/exocomets.js), which resolve with path 'comet'.
//   A galaxy may have nucleus, its central black hole (data/nuclei.js), which resolves with path 'nucleus'.
//   Radial velocities come from data/motions.js, once the sky is laid out.
//
// generateUniverse(seed) -> { seed, bodies[], cometTailAz, cometSun, counts, resolve(code), allCodes() }

import { Rng, DEFAULT_SEED, stable } from '../core/rng.js';
import { fluxFromLuminosity } from '../core/phys.js';
import { dp, clamp, STAR_TABLE, makeClassStar, makeRedGiant, makeRedSupergiant, makeBlueSupergiant, makeWhiteDwarf,
    fixedStar, absoluteVisual, apparentMag, distanceForMag, distanceModulus } from './stellar.js';
import { PLANET_COUNT_BUCKETS, PLANET_TYPES, hostContext, makeSystemPlanets, planetFromSpec, addToTally } from './planets.js';
import { makeRandomMulti, makeFigureEightSystem, makeDoubleDoubleSystem, systemAbsoluteMag, systemLuminosity, systemMass,
    fillComponentFields } from './multi.js';
import { planetFloorAU, holeFeedings, settleHole, tiltEclipses } from './dynamics.js';
import { makeCluster, makeBinaryMembers, keepMembersAboveHorizon, deepClusterOptions } from './clusters.js';
import { makeNebula, makeNeutronStar, makeGalaxy, makeBlackHole, makeSupernova, makeQuasar, makeComet, makeRogue, pushBack,
    placeSkyComets } from './deep_sky.js';
import { makeExocomet } from './exocomets.js';
import { layOutSky, layOutDeep, removeFromLayout } from './sky_layout.js';
import { makeHomePlanets } from './home_system.js';
import { unseal, SHOWCASE_CODES } from './sealed.js';
import { bandStrengths } from './band_table.js';
import { BODY_COUNTS, MIX, DEEP, SKY_COMETS, EXOCOMETS, apportion } from './quotas.js';
import { assignVelocities } from './motions.js';
import { addNuclei, nucleusEntities } from './nuclei.js';
import { memberDirection } from '../render/layers/sky_tangent.js';

export { validateUniverse } from './validate.js';

// How many of each class are bright enough to see at the default zoom, and how faint the rest may be
const SKY_SHARE = {
    O: [0.85, 12], B: [0.85, 12], A: [0.8, 12], F: [0.7, 12.5], G: [0.5, 13], K: [0.3, 14.5], M: [0.08, 16.9], WD: [0.03, 16.9], GIANT: [0.9, 11]
};
const NAKED_EYE_MAG = 6;
const BRIGHTEST_TARGET_MAG = -0.5;
// The sky's counts rise quickly with faintness: few very bright stars, many near the limit of the eye
const COUNT_SLOPE = 0.35;
const NEAREST_STAR_PC = 2.5;
const FARTHEST_STAR_PC = 6000;

// The deeper sky's stars: all fainter than the first sky's middling ones, and more of them the fainter they are, down to a
// limit for each class that keeps every one findable with the zoom
const DEEP_BRIGHTEST_MAG = 6.5;
const DEEP_SLOPE = 0.05;
const DEEP_FAINTEST = { O: 13, B: 13, A: 13.5, F: 14.5, G: 15, K: 16, M: 17.2, WD: 17.2, GIANT: 13 };
const DEEP_MULTI_FAINTEST = 15;
const DEEP_FARTHEST_PC = 12000;
const TARGET_ALT_MIN = 20;      // In a sky other than the standard one, the target's host still sits well clear of the horizon

function deepTargetMag(rng, faintest) {
    const top = 10 ** (DEEP_SLOPE * (faintest - DEEP_BRIGHTEST_MAG));
    return DEEP_BRIGHTEST_MAG + Math.log10(1 + rng.next() * (top - 1)) / DEEP_SLOPE;
}

function targetMag(rng, brightShare, faintest) {
    if (rng.chance(brightShare)) {
        const span = NAKED_EYE_MAG - BRIGHTEST_TARGET_MAG;
        const low = 10 ** (-COUNT_SLOPE * span);
        return NAKED_EYE_MAG + Math.log10(rng.next() * (1 - low) + low) / COUNT_SLOPE;
    }
    return rng.range(NAKED_EYE_MAG, faintest);
}

// A distance for a target magnitude. One that would be too near is redrawn from the magnitudes this star can actually
// have, and one too far is pulled back, so that stars don't pile up on either limit.
function distanceWithin(rng, absV, mag, faintest, farthest) {
    let d = distanceForMag(absV, mag);
    if (d < NEAREST_STAR_PC) {
        const room = Math.max(1.5, faintest - absV - distanceModulus(NEAREST_STAR_PC));
        d = NEAREST_STAR_PC * 10 ** ((rng.next() * room) / 5);
    } else if (d > farthest) {
        d = farthest * rng.range(0.55, 1);
    }
    return stable(d, 5);
}

function makeBase(kind, code) {
    return {
        code,
        kind,
        sky: { az: 0, alt: 0 },
        distance_pc: 0,
        radial_velocity_kms: 0,
        bands: null,               // Set last of all, because band_table.js reads every other field
        brightness: { flux_Wm2: 0, mag: 99 },
        visual_seed: code
    };
}

function shuffled(rng, list) {
    return rng.shuffle(list.slice());
}

function quotaList(table) {
    const list = [];
    Object.keys(table).forEach((key) => { for (let i = 0; i < table[key]; i++) list.push(key); });
    return list;
}

// Which sort of pulsar each neutron star is (data/deep_sky.js pulsePeriod), each with a stream of its own: the first
// `remnants` are a supernova's, so young. Of the rest, about a fifth are millisecond pulsars and one or two magnetars.
// rng is a fork of its own, so that nothing else in the sky moves.
function pulsarRoles(rng, pulsars, remnants) {
    const older = pulsars.flatMap((pulsar, i) => (pulsar && i >= remnants ? [i] : []));
    const order = shuffled(rng, older);
    const fast = Math.round(older.length * 0.2);
    const slow = older.length ? Math.max(1, Math.round(older.length / 14)) : 0;
    const roles = new Map(order.map((i, k) => [i, k < fast ? 'millisecond' : k < fast + slow ? 'magnetar' : 'normal']));
    return pulsars.map((pulsar, i) => (pulsar
        ? { rng: rng.fork(`spin:${i}`), role: i < remnants ? 'young' : roles.get(i) }
        : null));
}

// Decides every single star before any is built: class, whether it has planets, population. Metal-poor stars are old,
// so only classes that can live that long may be Population II; carbon and barium stars are giants; Ap and Am stars
// are the chemically odd hot dwarfs.
function planSingleStars(rng, fixedClasses, table = STAR_TABLE, mix = MIX) {
    const plans = [];
    Object.keys(table).forEach((cls) => {
        const row = table[cls];
        const fixed = fixedClasses.filter((c) => c === cls).length;
        const count = row.count - fixed;
        const withPlanets = row.withPlanets - fixed;
        const flags = shuffled(rng, Array.from({ length: count }, (_, i) => i < withPlanets));
        const giantKinds = cls === 'GIANT' ? shuffled(rng, quotaList(mix.giants)) : null;
        for (let i = 0; i < count; i++) {
            plans.push({ cls, hasPlanets: flags[i], giantKind: giantKinds ? giantKinds[i] : null, population: 'I', peculiar: null });
        }
    });
    const claim = (pool, n, peculiar) => {
        const picks = shuffled(rng, pool.filter((p) => p.population === 'I')).slice(0, n);
        picks.forEach((p) => {
            p.population = peculiar ? 'peculiar' : 'II';
            p.peculiar = peculiar;
        });
    };
    const redGiants = plans.filter((p) => p.giantKind === 'red_giant');
    claim(redGiants, mix.peculiar.carbon, 'carbon');
    claim(redGiants, mix.peculiar.barium, 'barium');
    claim(plans.filter((p) => p.cls === 'A'), mix.peculiar.am, 'am');
    claim(plans.filter((p) => p.cls === 'A' || p.cls === 'B'), mix.peculiar.ap, 'ap');
    const oldEnough = plans.filter((p) => ['G', 'K', 'M', 'WD'].includes(p.cls) || p.giantKind === 'red_giant');
    claim(oldEnough, mix.population.II, null);
    return shuffled(rng, plans);
}

function buildStar(rng, plan) {
    const options = { population: plan.population, peculiar: plan.peculiar };
    if (plan.cls === 'WD') return makeWhiteDwarf(rng, options);
    if (plan.giantKind === 'red_giant') return makeRedGiant(rng, options);
    if (plan.giantKind === 'red_supergiant') return makeRedSupergiant(rng);
    if (plan.giantKind === 'blue_supergiant') return makeBlueSupergiant(rng);
    // A Population II star must have lasted since the galaxy was young
    if (plan.population === 'II') options.maxMass = 0.92;
    return makeClassStar(rng, plan.cls, options);
}

function radialVelocity(rng, population) {
    const sigma = population === 'II' ? 150 : 45;
    return dp(clamp(rng.gauss(0, sigma), -300, 300), 1);
}

function setStellarBrightness(body, luminosity, absV, distance) {
    body.distance_pc = distance;
    body.brightness = { flux_Wm2: stable(fluxFromLuminosity(luminosity, distance), 6), mag: apparentMag(absV, distance) };
}

function makeSingleStarBody(rng, code, star, plan, deep = false) {
    const body = makeBase('star', code);
    const absV = absoluteVisual(star.luminosity_Lsun, star.teff_K);
    if (deep) {
        const faintest = DEEP_FAINTEST[plan.cls];
        setStellarBrightness(body, star.luminosity_Lsun, absV, distanceWithin(rng, absV, deepTargetMag(rng, faintest), faintest, DEEP_FARTHEST_PC));
    } else {
        const [share, faintest] = SKY_SHARE[plan.cls];
        setStellarBrightness(body, star.luminosity_Lsun, absV, distanceWithin(rng, absV, targetMag(rng, share, faintest), faintest, FARTHEST_STAR_PC));
    }
    body.radial_velocity_kms = radialVelocity(rng, star.population);
    body.star = star;
    body.planets = [];
    return body;
}

function singleStarContext(body) {
    const s = body.star;
    return hostContext(body, {
        luminosity_Lsun: s.luminosity_Lsun,
        mass_Msun: s.mass_Msun,
        teff_K: s.teff_K,
        radius_Rsun: s.radius_Rsun,
        mainSequenceSingle: s.stage === 'main_sequence',
        floorAU: s.stage === 'white_dwarf' ? 0.01 : 0
    });
}

function multiContext(body) {
    const biggest = body.stars.reduce((m, s) => Math.max(m, s.star.radius_Rsun), 0);
    return hostContext(body, {
        luminosity_Lsun: systemLuminosity(body.stars),
        mass_Msun: systemMass(body.stars),
        teff_K: body.stars[0].star.teff_K,
        radius_Rsun: biggest,
        mainSequenceSingle: false,
        floorAU: planetFloorAU(body)                   // Beyond three separations, and the unstable zone (data/dynamics.js)
    });
}

// Sets a multi-star body's distance so its combined light sits at a target magnitude
function setMultiBrightness(body, rng, share, faintest, deep = false) {
    const absV = systemAbsoluteMag(body.stars);
    const target = deep ? deepTargetMag(rng, faintest) : targetMag(rng, share, faintest);
    setStellarBrightness(body, systemLuminosity(body.stars), absV, distanceWithin(rng, absV, target, faintest, deep ? DEEP_FARTHEST_PC : FARTHEST_STAR_PC));
    body.radial_velocity_kms = dp(rng.range(-100, 100), 1);
    fillComponentFields(body, (l, d) => stable(fluxFromLuminosity(l, d), 6));
}

export function generateUniverse(seed = DEFAULT_SEED) {
    const root = new Rng(seed);
    const quota = root.fork('quota');
    const sealed = unseal(seed);

    // Hard-coded codes are reserved first, so a random one can't land on them
    const used = new Set(sealed.codes);
    SHOWCASE_CODES.forEach((c) => used.add(c));
    const coder = (label) => {
        const stream = root.fork(`codes:${label}`);
        return () => {
            let code;
            do code = stream.code(); while (used.has(code));
            used.add(code);
            return code;
        };
    };
    const starCode = coder('stars');
    const planetCode = coder('planets');
    const multiCode = coder('multi');
    const memberCode = coder('members');
    const otherCode = coder('other');

    const bodies = [];
    const entries = [];
    const add = (body, rule, extra = {}) => {
        bodies.push(body);
        const entry = { body, rule, ...extra };
        entries.push(entry);
        return entry;
    };

    // How many planets each system gets, as exact counts across all of them: one slot each for the two systems whose
    // planets are fixed, then every other system takes the next from a shuffled list
    const multiFlags = shuffled(quota, Array.from({ length: BODY_COUNTS.multi - 2 }, (_, i) => i < MIX.multiWithPlanets));
    const tripleFlags = shuffled(quota, Array.from({ length: BODY_COUNTS.multi - 2 }, (_, i) => i < MIX.triples));
    const totalStarSystems = Object.keys(STAR_TABLE).reduce((sum, c) => sum + STAR_TABLE[c].withPlanets, 0);
    const bucketCounts = apportion(PLANET_COUNT_BUCKETS.map((b) => b.share), totalStarSystems + MIX.multiWithPlanets + 1);
    bucketCounts[0] -= 1;
    bucketCounts[2] -= 1;
    const bucketList = shuffled(quota, bucketCounts.flatMap((count, i) => Array(count).fill(i)));
    const nextPlanetCount = (rng) => PLANET_COUNT_BUCKETS[bucketList.pop()].draw(rng);
    const tally = { counts: {}, total: 0 };

    // The hard-coded systems first, in their own streams, so nothing later can disturb them
    const fixedStream = root.fork('fixed');
    const target = sealed.target;
    {
        const r = fixedStream.fork('target');
        const star = fixedStar(target.host.star);
        const body = makeBase('star', target.host.code);
        const absV = absoluteVisual(star.luminosity_Lsun, star.teff_K);
        setStellarBrightness(body, star.luminosity_Lsun, absV, stable(distanceForMag(absV, target.host.apparent_mag), 5));
        body.radial_velocity_kms = target.host.radial_velocity_kms;
        body.star = star;
        const ctx = singleStarContext(body);
        body.planets = target.planets.map((spec) => {
            addToTally(tally, spec.type);
            return planetFromSpec(r, spec, ctx);
        });
        // Its place is chosen for the standard sky. In any other, it is placed like everything else, so that no star sits
        // still while the rest move when the seed is changed: that would give it away.
        const where = seed === DEFAULT_SEED ? { fixed: target.host.sky } : { altMin: TARGET_ALT_MIN };
        add(body, 'even', { ...where, clear_deg: target.host.clear_deg });
    }
    sealed.decoys.forEach((decoy, i) => {
        const r = fixedStream.fork(`decoy:${i}`);
        const star = fixedStar(decoy.host.star);
        const body = makeBase('star', decoy.host.code);
        const absV = absoluteVisual(star.luminosity_Lsun, star.teff_K);
        setStellarBrightness(body, star.luminosity_Lsun, absV, stable(distanceForMag(absV, decoy.host.apparent_mag), 5));
        body.radial_velocity_kms = decoy.host.radial_velocity_kms;
        body.star = star;
        const ctx = singleStarContext(body);
        const fixed = { orbit_AU: decoy.planet.orbit_AU, planet: planetFromSpec(r, decoy.planet, ctx) };
        body.planets = makeSystemPlanets(r, planetCode, ctx, nextPlanetCount(r), tally, fixed);
        add(body, 'stars');
    });
    {
        const r = fixedStream.fork('eight');
        const body = makeBase('multiple', 'F8Q3ZN');
        Object.assign(body, makeFigureEightSystem('F8Q3ZN'));
        setMultiBrightness(body, r, 1, NAKED_EYE_MAG);
        add(body, 'stars');
    }
    {
        const r = fixedStream.fork('double');
        const body = makeBase('multiple', 'D2W7XK');
        Object.assign(body, makeDoubleDoubleSystem('D2W7XK'));
        setMultiBrightness(body, r, 1, NAKED_EYE_MAG);
        const pairA = [0, 1];
        const massA = pairA.reduce((m, i) => m + body.stars[i].star.mass_Msun, 0);
        body.planets = [planetFromSpec(r, {
            code: planetCode(),
            type: 'rocky_airless',
            orbit_AU: 0.5,
            radius_Rearth: 0.92,
            mass_Mearth: 0.74,
            albedo: 0.11,
            pressure_bar: 0,
            day_length_h: 41,
            T_surface_K: 460,
            surface: { rock: 'basalt' }
        }, multiContext(body), { massForPeriod: massA, orbit_centre_stars: pairA })];
        addToTally(tally, 'rocky_airless');
        add(body, 'stars');
    }

    const fixedClasses = [target.host.star.class, ...sealed.decoys.map((d) => d.host.star.class)];
    const starStream = root.fork('stars');
    planSingleStars(quota, fixedClasses).forEach((plan, i) => {
        const r = starStream.fork(`star:${i}`);
        const star = buildStar(r, plan);
        const body = makeSingleStarBody(r, starCode(), star, plan);
        if (plan.hasPlanets) body.planets = makeSystemPlanets(r, planetCode, singleStarContext(body), nextPlanetCount(r), tally);
        add(body, 'stars');
    });

    const multiStream = root.fork('multi');
    for (let i = 0; i < BODY_COUNTS.multi - 2; i++) {
        const r = multiStream.fork(`multi:${i}`);
        const body = makeBase('binary', multiCode());
        Object.assign(body, makeRandomMulti(r, multiCode, body.code, tripleFlags[i], multiFlags[i]));
        setMultiBrightness(body, r, 0.5, 14);
        if (multiFlags[i]) body.planets = makeSystemPlanets(r, planetCode, multiContext(body), nextPlanetCount(r), tally);
        add(body, 'stars');
    }

    const rogues = root.fork('rogues');
    shuffled(quota, quotaList(MIX.rogue_planet)).forEach((type, i) => {
        const body = makeBase('rogue_planet', otherCode());
        makeRogue(rogues.fork(`rogue:${i}`), body, type);
        add(body, 'even');
    });

    // Ten comets were first laid out across the sky. Only SKY_COMETS of them stay in it, re-placed by the Sun below the
    // horizon; the rest are comets of other stars, made below. All ten keep their places in the first layout and their
    // codes, so nothing laid out after them moves.
    const comets = root.fork('comets');
    const cometBodies = [];
    for (let i = 0; i < BODY_COUNTS.comet; i++) {
        const body = makeBase('comet', otherCode());
        makeComet(comets.fork(`comet:${i}`), body);
        add(body, 'even', { group: 'comet', groupSep_deg: 16, altMin: 16 });
        cometBodies.push(body);
    }

    const nebulae = root.fork('nebulae');
    shuffled(quota, quotaList(MIX.nebula)).forEach((type, i) => {
        const body = makeBase('nebula', otherCode());
        makeNebula(nebulae.fork(`nebula:${i}`), body, type);
        add(body, type === 'planetary' ? 'stars' : 'tight', { radius_deg: body.nebula.size_deg / 2 });
    });

    const clusters = root.fork('clusters');
    shuffled(quota, quotaList(MIX.cluster)).forEach((type, i) => {
        const r = clusters.fork(`cluster:${i}`);
        const body = makeBase('cluster', otherCode());
        makeCluster(r, memberCode, body, type);
        body.radial_velocity_kms = dp(type === 'globular' ? r.range(-200, 200) : r.range(-40, 40), 1);
        body.cluster.members.forEach((m) => { m.radial_velocity_kms = dp(body.radial_velocity_kms + r.range(-2, 2), 2); });
        add(body, type === 'globular' ? 'wide' : 'tight', { radius_deg: body.cluster.radius_deg });
    });

    // Supernovae: phases are stratified so that no two start alike. A type II's remnant is one of the neutron stars,
    // at the same distance, just off the centre of its shell
    const supernovae = root.fork('supernovae');
    const phases = shuffled(quota, Array.from({ length: BODY_COUNTS.supernova }, (_, i) => i));
    const supernovaEntries = [];
    shuffled(quota, quotaList(MIX.supernova)).forEach((type, i) => {
        const r = supernovae.fork(`supernova:${i}`);
        const body = makeBase('supernova', otherCode());
        const span = (400 + 15) / BODY_COUNTS.supernova;
        const phase = dp(-15 + span * (phases[i] + r.next()), 2);
        makeSupernova(r, body, type, phase);
        supernovaEntries.push(add(body, 'stars', { radius_deg: body.supernova.shell_deg }));
    });
    const remnantSources = supernovaEntries.filter((e) => e.body.supernova.remnant_kind === 'neutron_star');

    const neutronStars = root.fork('neutron_stars');
    const pulsars = shuffled(quota, quotaList(MIX.neutron_star)).map((k) => k === 'pulsar');
    const spins = pulsarRoles(root.fork('pulsar_spins'), pulsars, remnantSources.length);
    pulsars.forEach((pulsar, i) => {
        const r = neutronStars.fork(`ns:${i}`);
        const source = remnantSources[i] || null;
        const body = makeBase('neutron_star', otherCode());
        makeNeutronStar(r, body, pulsar, source ? source.body : null, spins[i]);
        if (source) {
            source.body.supernova.remnant_code = body.code;
            add(body, 'stars', { near: source, near_deg: [0.35, 0.6] });
        } else {
            add(body, 'stars');
        }
    });

    // Galaxies: distances in even log steps from 10 to 1,000 Mpc, shuffled, so the Hubble plot covers its whole range
    const galaxies = root.fork('galaxies');
    const steps = shuffled(quota, Array.from({ length: BODY_COUNTS.galaxy }, (_, i) => i));
    const radioFlags = shuffled(quota, Array.from({ length: BODY_COUNTS.galaxy }, (_, i) => i < 4));
    const activeFlags = shuffled(quota, Array.from({ length: BODY_COUNTS.galaxy }, (_, i) => i < 5));
    const morphologies = shuffled(quota, quotaList(MIX.galaxy));
    const starForming = morphologies.flatMap((m, i) => (m === 'elliptical' ? [] : [i]));
    const starbursts = new Set(shuffled(quota, starForming).slice(0, MIX.starbursts));
    morphologies.forEach((morphology, i) => {
        const r = galaxies.fork(`galaxy:${i}`);
        const body = makeBase('galaxy', otherCode());
        const dMpc = stable(10 * 100 ** ((steps[i] + r.next()) / BODY_COUNTS.galaxy), 5);
        makeGalaxy(r, body, morphology, dMpc, { radioLobes: radioFlags[i], activeNucleus: activeFlags[i], starburst: starbursts.has(i) });
        add(body, 'avoid', { radius_deg: body.galaxy.size_deg / 2 });
    });

    const holes = root.fork('black_holes');
    const holeBodies = [];
    for (let i = 0; i < BODY_COUNTS.black_hole; i++) {
        const body = makeBase('black_hole', otherCode());
        makeBlackHole(holes.fork(`hole:${i}`), otherCode, body);
        add(body, 'stars');
        holeBodies.push(body);
    }
    // Then how each is fed, from streams of their own, so no other number changes
    const feedings = holeFeedings(holeBodies, MIX.blackHoleFeeding);
    // A wind-fed hole's companion is a compact blue supergiant, as in the high-mass X-ray binaries: the first drawn under 40 solar radii
    const supergiant = (r) => {
        let star = makeBlueSupergiant(r);
        for (let i = 0; i < 20 && star.radius_Rsun > 40; i++) star = makeBlueSupergiant(r);
        return star;
    };
    holeBodies.forEach((body) => settleHole(holes.fork(`feeding:${body.code}`), body, feedings.get(body), supergiant));

    const quasars = root.fork('quasars');
    [[0.5, 1.2], [1.2, 2.5], [2.5, 4]].forEach(([lo, hi], i) => {
        const r = quasars.fork(`quasar:${i}`);
        const body = makeBase('quasar', otherCode());
        makeQuasar(r, body, dp(r.range(lo, hi), 3), i === 0);
        add(body, 'avoid');
    });

    const home = makeHomePlanets(root.fork('home'), otherCode);
    home.forEach((body) => entries.push({ body, rule: 'even', fixed: body.sky }));

    const layout = layOutSky(entries, root.fork('sky'));

    // Clusters' binary members take the last codes of the first sky, so that no other code changes, and need the sky to be
    // laid out
    const pairCode = coder('member pairs');
    bodies.forEach((body) => {
        if (!body.cluster) return;
        keepMembersAboveHorizon(body);
        makeBinaryMembers(body, pairCode);
    });

    const first = root.fork('order').shuffle(bodies);

    // ---------- The deeper sky ----------
    // SKY_SCALE - 1 times each common kind again, further and fainter, behind the first sky. Streams of their own, and
    // codes drawn after every code above, so nothing above changes.
    const deepRoot = root.fork('deep');
    const deep = makeDeepSky(deepRoot, coder, tally);
    layOutDeep(layout, deep.entries, deepRoot.fork('sky'));
    const deepPairCode = coder('deep member pairs');
    deep.bodies.forEach((body) => {
        if (!body.cluster) return;
        keepMembersAboveHorizon(body);
        makeBinaryMembers(body, deepPairCode, { canPass: false });
    });
    const second = deepRoot.fork('order').shuffle(deep.bodies.slice());

    // ---------- Comets ----------
    // SKY_COMETS of our own, low on the side of the sky where the Sun has set; the others go to other stars
    const skyComets = cometBodies.slice(0, SKY_COMETS);
    const leaving = new Set(cometBodies.slice(SKY_COMETS));
    removeFromLayout(layout, cometBodies);
    const cometSun = placeSkyComets(root.fork('sky comets'), skyComets, layout);
    const sky = first.filter((body) => !leaving.has(body)).concat(second);
    makeExocomets(root.fork('exocomets'), sky, [...leaving].map((b) => b.code), coder('exocomets'), sealed);

    // A few detached close pairs turned edge-on, to join the tight pairs that eclipse already
    tiltEclipses(root.fork('eclipses'), sky.filter((b) => b.stars && b.architecture !== 'figure_eight' && b.architecture !== 'double_double'), MIX.eclipsingTilted);

    // ---------- Motions ----------
    // After the layout, since a body's direction sets much of its motion. The hard-coded systems keep theirs.
    const fixedMotion = new Set([target.host.code, ...sealed.decoys.map((d) => d.host.code), 'F8Q3ZN', 'D2W7XK']);
    assignVelocities(sky, root.fork('motions'), fixedMotion);

    // ---------- Black holes at the centres of galaxies ----------
    // A stream and codes of their own, drawn after every other code, and after the motions they copy (data/nuclei.js)
    addNuclei(root.fork('nuclei'), sky, coder('nuclei'));

    const all = sky.concat(home);

    // Last of all, because band strengths read every other field. Band strengths are cached by temperature, so the first
    // sky goes first, in the order it always has, and the deeper sky after it: that way nothing nudges the first sky's.
    const bandsOf = (list) => {
        list.forEach((body) => {
            (body.planets || []).forEach((planet) => { planet.bands = bandStrengths(planet); });
            if (body.planet) body.planet.bands = bandStrengths(body.planet);
            (body.stars || []).forEach((star) => { star.bands = bandStrengths(star); });
            if (body.black_hole) body.black_hole.companion.bands = bandStrengths(body.black_hole.companion);
            body.bands = bandStrengths(body);
        });
        list.forEach((body) => {
            if (!body.cluster) return;
            body.cluster.members.forEach((member) => {
                if (!member.stars) return;
                member.sky = memberDirection(body, member);
                member.stars.forEach((star) => { star.bands = bandStrengths(star); });
                member.bands = bandStrengths(member);
            });
        });
    };
    const firstSet = new Set(first);
    bandsOf(all.filter((body) => firstSet.has(body) || body.kind === 'home_planet'));
    bandsOf(second);
    all.forEach((body) => (body.comets || []).forEach((comet) => { comet.bands = bandStrengths(comet); }));
    // After everything else's, so that nothing they put in the band table's caches can change anyone else's
    all.forEach((body) => nucleusEntities(body).forEach((entity) => { entity.bands = bandStrengths(entity); }));

    const byCode = new Map();
    const register = (entity, body, path) => byCode.set(entity.code, { entity, body, path });
    all.forEach((body) => {
        register(body, body, 'body');
        (body.planets || []).forEach((planet) => register(planet, body, 'planet'));
        (body.comets || []).forEach((comet) => register(comet, body, 'comet'));
        (body.stars || []).forEach((star) => register(star, body, 'component'));
        if (body.black_hole) register(body.black_hole.companion, body, 'component');
        if (body.nucleus) {
            register(body.nucleus, body, 'nucleus');
            body.nucleus.nucleus.stars.forEach((star) => register(star, body, 'component'));
        }
        if (body.cluster) {
            body.cluster.members.forEach((member) => {
                if (member.stars) {
                    // A pair of stars is a system of its own, the same to everything that reads it as any other binary
                    register(member, member, 'body');
                    member.stars.forEach((star) => register(star, member, 'component'));
                } else {
                    register(member, body, 'member');
                }
            });
        }
    });

    return {
        seed,
        bodies: all,               // The sky bodies, the first sky's then the deeper sky's, then the 7 home planets
        cometTailAz: cometSun.az,  // Every comet's tail points away from a Sun below the horizon on this bearing
        cometSun,                  // Where that Sun is: { az, alt }, alt below the horizon
        counts: tallyCounts(all, tally),
        resolve(code) {            // Any code, any case: { entity, body, path } or null
            return byCode.get(String(code).trim().toUpperCase()) || null;
        },
        allCodes() {
            return [...byCode.keys()];
        }
    };
}

// planet_types counts the planets there are: the tally also holds any that were dropped when their systems were settled
// (data/planets.js), as it must go on choosing types as it always has
function tallyCounts(all, tally) {
    const counts = { sky_bodies: 0, deep_bodies: 0, home_planets: 0, planets: 0, exocomets: 0, cluster_members: 0, planet_types: {} };
    Object.keys(tally.counts).forEach((type) => { counts.planet_types[type] = 0; });
    all.forEach((body) => (body.planets || []).forEach((p) => {
        if (PLANET_TYPES[p.type]) counts.planet_types[p.type] = (counts.planet_types[p.type] || 0) + 1;
    }));
    all.forEach((body) => {
        counts[body.kind] = (counts[body.kind] || 0) + 1;
        if (body.kind === 'home_planet') counts.home_planets++;
        else counts.sky_bodies++;
        if (body.deep) counts.deep_bodies++;
        counts.planets += (body.planets || []).length;
        counts.exocomets += (body.comets || []).length;
        if (body.cluster) counts.cluster_members += body.cluster.members.length;
    });
    return counts;
}

// The deeper sky: { bodies, entries } for layOutDeep, every body with deep: true. The same kinds and mixes as the first sky's
// common kinds (data/quotas.js DEEP), but further: stars and systems fainter, extended objects pushed back so that they look
// smaller and dimmer. Planets carry on the first sky's tally, so the types keep their shares across the whole sky.
function makeDeepSky(deepRoot, coder, tally) {
    const quota = deepRoot.fork('quota');
    const code = coder('deep');
    const planetCode = coder('deep planets');
    const memberCode = coder('deep members');
    const bodies = [];
    const entries = [];
    const add = (body, rule, extra = {}) => {
        body.deep = true;
        bodies.push(body);
        entries.push({ body, rule, ...extra });
    };
    const { counts, mix, stars } = DEEP;

    const multiFlags = shuffled(quota, Array.from({ length: counts.multi }, (_, i) => i < mix.multiWithPlanets));
    const tripleFlags = shuffled(quota, Array.from({ length: counts.multi }, (_, i) => i < mix.triples));
    const systems = Object.keys(stars).reduce((sum, c) => sum + stars[c].withPlanets, 0) + mix.multiWithPlanets;
    const bucketCounts = apportion(PLANET_COUNT_BUCKETS.map((b) => b.share), systems);
    const bucketList = shuffled(quota, bucketCounts.flatMap((count, i) => Array(count).fill(i)));
    const nextPlanetCount = (rng) => PLANET_COUNT_BUCKETS[bucketList.pop()].draw(rng);

    const starStream = deepRoot.fork('stars');
    planSingleStars(quota, [], stars, mix).forEach((plan, i) => {
        const r = starStream.fork(`star:${i}`);
        const body = makeSingleStarBody(r, code(), buildStar(r, plan), plan, true);
        if (plan.hasPlanets) body.planets = makeSystemPlanets(r, planetCode, singleStarContext(body), nextPlanetCount(r), tally);
        add(body, 'stars');
    });

    const multiStream = deepRoot.fork('multi');
    for (let i = 0; i < counts.multi; i++) {
        const r = multiStream.fork(`multi:${i}`);
        const body = makeBase('binary', code());
        Object.assign(body, makeRandomMulti(r, code, body.code, tripleFlags[i], multiFlags[i], { canPass: false }));
        setMultiBrightness(body, r, 0, DEEP_MULTI_FAINTEST, true);
        if (multiFlags[i]) body.planets = makeSystemPlanets(r, planetCode, multiContext(body), nextPlanetCount(r), tally);
        add(body, 'stars');
    }

    const rogues = deepRoot.fork('rogues');
    shuffled(quota, quotaList(mix.rogue_planet)).forEach((type, i) => {
        const body = makeBase('rogue_planet', code());
        makeRogue(rogues.fork(`rogue:${i}`), body, type, { distance: [40, 200] });
        add(body, 'even');
    });

    const nebulae = deepRoot.fork('nebulae');
    shuffled(quota, quotaList(mix.nebula)).forEach((type, i) => {
        const r = nebulae.fork(`nebula:${i}`);
        const body = makeBase('nebula', code());
        makeNebula(r, body, type);
        pushBack(body, Math.min(9000, body.distance_pc * r.logRange(2.5, 5)));
        add(body, type === 'planetary' ? 'stars' : 'tight', { radius_deg: body.nebula.size_deg / 2 });
    });

    const clusters = deepRoot.fork('clusters');
    shuffled(quota, quotaList(mix.cluster)).forEach((type, i) => {
        const r = clusters.fork(`cluster:${i}`);
        const body = makeBase('cluster', code());
        makeCluster(r, memberCode, body, type, deepClusterOptions(type));
        body.cluster.members.forEach((m) => { m.radial_velocity_kms = dp(r.range(-2, 2), 2); });
        add(body, type === 'globular' ? 'wide' : 'tight', { radius_deg: body.cluster.radius_deg });
    });

    // Galaxies: most of them further than the first sky's, in steps that thin out towards the near end
    const galaxies = deepRoot.fork('galaxies');
    const steps = shuffled(quota, Array.from({ length: counts.galaxy }, (_, i) => i));
    const radioFlags = shuffled(quota, Array.from({ length: counts.galaxy }, (_, i) => i < mix.radioLobes));
    const activeFlags = shuffled(quota, Array.from({ length: counts.galaxy }, (_, i) => i < mix.activeNuclei));
    const morphologies = shuffled(quota, quotaList(mix.galaxy));
    const starForming = morphologies.flatMap((m, i) => (m === 'elliptical' ? [] : [i]));
    const starbursts = new Set(shuffled(quota, starForming).slice(0, mix.starbursts));
    morphologies.forEach((morphology, i) => {
        const r = galaxies.fork(`galaxy:${i}`);
        const body = makeBase('galaxy', code());
        const dMpc = stable(40 * 25 ** Math.sqrt((steps[i] + r.next()) / counts.galaxy), 5);
        makeGalaxy(r, body, morphology, dMpc, { radioLobes: radioFlags[i], activeNucleus: activeFlags[i], starburst: starbursts.has(i) });
        // Seen smaller the further it is, as the first sky's middling galaxy would be
        body.galaxy.size_deg = dp(body.galaxy.size_deg * Math.max(0.15, Math.min(1, 100 / dMpc)), 3);
        add(body, 'avoid', { radius_deg: body.galaxy.size_deg / 2 });
    });
    return { bodies, entries };
}

// Comets of other stars: a sensible spread of hosts, single stars with and without planets and a couple of pairs, none of
// them the hard-coded systems. The first codes are those of the comets that left our sky; the rest are new.
function makeExocomets(rng, sky, oldCodes, nextCode, sealed) {
    const barred = new Set([sealed.target.host.code, ...sealed.decoys.map((d) => d.host.code), 'F8Q3ZN', 'D2W7XK']);
    const byCode = (list) => list.slice().sort((a, b) => (a.code < b.code ? -1 : 1));
    const suits = (b) => b.kind === 'star' && b.star.stage === 'main_sequence' && 'AFGK'.includes(b.star.class) && !barred.has(b.code);
    const withPlanets = shuffled(rng, byCode(sky.filter((b) => suits(b) && b.planets.length)));
    const without = shuffled(rng, byCode(sky.filter((b) => suits(b) && !b.planets.length)));
    const pairs = shuffled(rng, byCode(sky.filter((b) => b.architecture === 'binary' && !b.interacting && !barred.has(b.code))));
    // Most hosts have planets; some have none, which gives a visit there something to find; and a couple are pairs
    const hosts = [...withPlanets.slice(0, 14), ...without.slice(0, 6), ...pairs.slice(0, 2)];
    hosts.push(hosts[0], hosts[1]);              // Two systems with a second comet
    const spare = [...withPlanets.slice(14), ...without.slice(6)];
    const codes = oldCodes.slice();
    let made = 0;
    for (let i = 0; made < EXOCOMETS && i < hosts.length + spare.length; i++) {
        const host = i < hosts.length ? hosts[i] : spare[i - hosts.length];
        const code = codes.length ? codes[0] : nextCode();
        const comet = makeExocomet(rng.fork(`${code}:${host.code}`), code, host);
        if (!comet) continue;
        if (codes.length) codes.shift();
        host.comets = host.comets || [];
        host.comets.push(comet);
        made++;
    }
}
