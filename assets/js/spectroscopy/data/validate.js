// Checks a generated sky against the spec's rules (sections 7, 8.3, 9, 12, 14, 19), and that every system of stars could
// really exist (data/dynamics.js). Returns a list of failures in plain words; an empty list means the sky is sound. Too slow
// to be worth running on every load: tests call it instead.

import { isValidCode } from '../core/rng.js';
import { hzEdges, keplerPeriodDays, fluxFromLuminosity, H0, C_KMS } from '../core/phys.js';
import { MIN_ALT, MIN_FOV, azAltToVec3, limitingMag, galacticLatitude, angularSeparation } from '../core/sky.js';
import { STAR_TABLE, RSUN_AU, luminosityFromRT, msLifetimeMyr } from './stellar.js';
import { PLANET_TYPES, MIN_STELLAR_RADII } from './planets.js';
import { spacingBetween } from './sky_layout.js';
import { BODY_COUNTS, MIX, DEEP, SKY_COMETS, EXOCOMETS } from './quotas.js';
import { componentStates, cometTailAU, eclipsingOrbits } from './orbits.js';
import { systemProblems } from './dynamics.js';
import { crossesPlanet, MAX_ECC } from './exocomets.js';
import { unseal } from './sealed.js';
import { nucleusEntities, nucleusProblems } from './nuclei.js';

const RAD = Math.PI / 180;
const DEFAULT_FOV = 80;
const DEFAULT_ZOOM_RANGE = [250, 450];
const FAST_STAR_KMS = 300;          // Spec 12: stars stay within this, but for a rare few
const FAST_STAR_SHARE = 0.02;
const FASTEST_STAR_KMS = 450;
const PECULIAR_GALAXY_KMS = 550;    // The most a galaxy strays from Hubble's law (data/motions.js)
const MIN_ECLIPSING = 12;           // Sky systems that eclipse: the tight pairs, and those turned edge-on (data/dynamics.js)

// The whole sky's quotas: the first sky's and the deeper sky's together
const sum = (a, b) => {
    const out = { ...a };
    Object.keys(b).forEach((k) => { out[k] = (out[k] || 0) + b[k]; });
    return out;
};
const TOTAL = {
    counts: { ...sum(BODY_COUNTS, DEEP.counts), comet: SKY_COMETS },
    triples: MIX.triples + DEEP.mix.triples,
    multiWithPlanets: MIX.multiWithPlanets + DEEP.mix.multiWithPlanets,
    nebula: sum(MIX.nebula, DEEP.mix.nebula),
    cluster: sum(MIX.cluster, DEEP.mix.cluster),
    galaxy: sum(MIX.galaxy, DEEP.mix.galaxy),
    rogue_planet: sum(MIX.rogue_planet, DEEP.mix.rogue_planet),
    starbursts: MIX.starbursts + DEEP.mix.starbursts,
    population: sum(MIX.population, DEEP.mix.population),
    stars: Object.fromEntries(Object.keys(STAR_TABLE).map((c) => [c, {
        count: STAR_TABLE[c].count + DEEP.stars[c].count, withPlanets: STAR_TABLE[c].withPlanets + DEEP.stars[c].withPlanets
    }]))
};

function hasWater(planet) {
    const pct = planet.atmosphere_pct || {};
    const ppm = planet.atmosphere_ppm || {};
    const surface = planet.surface || {};
    return (pct.H2O || 0) > 0 || (ppm.H2O || 0) > 0 || (surface.ocean_fraction || 0) > 0 || surface.ice === 'water'
        || !!surface.subsurface_ocean || (planet.clouds && planet.clouds.kind === 'H2O');
}

function hostLuminosity(body) {
    if (body.star) return body.star.luminosity_Lsun;
    return body.stars.reduce((sum, s) => sum + s.star.luminosity_Lsun, 0);
}

function hostMass(body) {
    if (body.star) return body.star.mass_Msun;
    return body.stars.reduce((sum, s) => sum + s.star.mass_Msun, 0);
}

function hostRadiusAU(body) {
    if (body.star) return body.star.radius_Rsun * RSUN_AU;
    return body.stars.reduce((max, s) => Math.max(max, s.star.radius_Rsun), 0) * RSUN_AU;
}

function isSingleMainSequence(body) {
    return !!body.star && body.star.stage === 'main_sequence';
}

function within(x, lo, hi, tolerance = 0) {
    return x >= lo * (1 - tolerance) && x <= hi * (1 + tolerance);
}

function countBy(list, keyOf) {
    const out = {};
    list.forEach((item) => {
        const key = keyOf(item);
        out[key] = (out[key] || 0) + 1;
    });
    return out;
}

function classKey(star) {
    if (star.stage === 'white_dwarf') return 'WD';
    if (star.stage === 'giant' || star.stage === 'supergiant') return 'GIANT';
    return star.class;
}

function everyCode(u) {
    const codes = [];
    u.bodies.forEach((body) => {
        codes.push(body.code);
        (body.planets || []).forEach((p) => codes.push(p.code));
        (body.comets || []).forEach((c) => codes.push(c.code));
        (body.stars || []).forEach((s) => codes.push(s.code));
        if (body.black_hole) codes.push(body.black_hole.companion.code);
        nucleusEntities(body).forEach((e) => codes.push(e.code));
        if (body.cluster) {
            body.cluster.members.forEach((m) => {
                codes.push(m.code);
                (m.stars || []).forEach((s) => codes.push(s.code));
            });
        }
    });
    return codes;
}

function checkCodes(u, fail) {
    const seen = new Set();
    everyCode(u).forEach((code) => {
        if (!isValidCode(code)) fail(`bad code ${code}`);
        if (seen.has(code)) fail(`duplicate code ${code}`);
        seen.add(code);
        if (!u.resolve(code)) fail(`code ${code} does not resolve`);
    });
    if (u.allCodes().length !== seen.size) fail(`allCodes has ${u.allCodes().length} codes, the sky ${seen.size}`);
}

function checkCounts(u, fail) {
    const sky = u.bodies.filter((b) => b.kind !== 'home_planet');
    const home = u.bodies.filter((b) => b.kind === 'home_planet');
    const expected = Object.values(TOTAL.counts).reduce((a, b) => a + b, 0);
    if (sky.length !== expected) fail(`${sky.length} sky bodies, expected ${expected}`);
    if (home.length !== 7) fail(`${home.length} home planets`);
    const kinds = countBy(sky, (b) => b.kind);
    Object.keys(TOTAL.counts).forEach((kind) => {
        if (kind === 'multi') return;
        if (kinds[kind] !== TOTAL.counts[kind]) fail(`${kinds[kind]} of ${kind}, expected ${TOTAL.counts[kind]}`);
    });
    // The rare kinds are only ever in the first sky
    sky.filter((b) => b.deep).forEach((b) => {
        if (!DEEP.counts[b.kind === 'binary' || b.kind === 'multiple' ? 'multi' : b.kind]) fail(`${b.code} is a ${b.kind} in the deeper sky`);
    });
    const multis = sky.filter((b) => b.stars);
    if (multis.length !== TOTAL.counts.multi) fail(`${multis.length} multi-star systems`);
    const arch = countBy(multis, (b) => b.architecture);
    const random = TOTAL.counts.multi - 2;
    if (arch.binary !== random - TOTAL.triples || arch.hierarchical_triple !== TOTAL.triples || arch.figure_eight !== 1 || arch.double_double !== 1) {
        fail(`multi-star mix ${JSON.stringify(arch)}`);
    }
    const randoms = multis.filter((b) => b.architecture === 'binary' || b.architecture === 'hierarchical_triple');
    const withPlanets = randoms.filter((b) => b.planets.length > 0).length;
    if (withPlanets !== TOTAL.multiWithPlanets) fail(`${withPlanets} random multi-star systems with planets`);

    const stars = sky.filter((b) => b.kind === 'star');
    const byClass = countBy(stars, (b) => classKey(b.star));
    const planetsByClass = countBy(stars.filter((b) => b.planets.length), (b) => classKey(b.star));
    Object.keys(STAR_TABLE).forEach((cls) => {
        const row = TOTAL.stars[cls];
        if (byClass[cls] !== row.count) fail(`${byClass[cls]} stars of class ${cls}, expected ${row.count}`);
        if (planetsByClass[cls] !== row.withPlanets) fail(`${planetsByClass[cls]} planet hosts of class ${cls}`);
    });
    const pops = countBy(stars, (b) => b.star.population);
    Object.keys(TOTAL.population).forEach((p) => {
        if (pops[p] !== TOTAL.population[p]) fail(`${pops[p]} stars of population ${p}`);
    });
    const hosts = Object.values(TOTAL.stars).reduce((n, row) => n + row.withPlanets, 0) + TOTAL.multiWithPlanets + 1;
    const hostCount = sky.filter((b) => b.planets && b.planets.length).length;
    if (hostCount !== hosts) fail(`${hostCount} planetary systems, expected ${hosts}`);
    const exocomets = sky.reduce((n, b) => n + (b.comets || []).length, 0);
    if (exocomets !== EXOCOMETS) fail(`${exocomets} comets of other stars, expected ${EXOCOMETS}`);

    const expectMix = (list, keyOf, table, name) => {
        const got = countBy(list, keyOf);
        Object.keys(table).forEach((key) => {
            if (got[key] !== table[key]) fail(`${got[key]} ${name} of type ${key}, expected ${table[key]}`);
        });
    };
    expectMix(sky.filter((b) => b.nebula), (b) => b.nebula.type, TOTAL.nebula, 'nebulae');
    expectMix(sky.filter((b) => b.cluster), (b) => b.cluster.type, TOTAL.cluster, 'clusters');
    expectMix(sky.filter((b) => b.neutron_star), (b) => (b.neutron_star.pulsar ? 'pulsar' : 'quiet'), MIX.neutron_star, 'neutron stars');
    expectMix(sky.filter((b) => b.galaxy), (b) => b.galaxy.morphology, TOTAL.galaxy, 'galaxies');
    expectMix(sky.filter((b) => b.supernova), (b) => b.supernova.type, MIX.supernova, 'supernovae');
    expectMix(sky.filter((b) => b.rogue_planet), (b) => b.rogue_planet.type, TOTAL.rogue_planet, 'rogue planets');
    const bursts = sky.filter((b) => b.galaxy && b.galaxy.starburst);
    if (bursts.length !== TOTAL.starbursts || bursts.some((b) => b.galaxy.morphology === 'elliptical')) fail(`${bursts.length} starburst galaxies`);
    const radioLoud = sky.filter((b) => b.quasar && b.quasar.radio_loud).length;
    if (radioLoud !== 1) fail(`${radioLoud} radio-loud quasars`);
}

// Every entity that stores band strengths has them, and they're 0..1
function checkBands(u, fail) {
    const check = (entity) => {
        const b = entity.bands;
        if (!b || !['radio', 'ir', 'visible', 'uv', 'xray'].every((k) => b[k] >= 0 && b[k] <= 1)) fail(`${entity.code} has bad bands`);
    };
    u.bodies.forEach((body) => {
        check(body);
        (body.planets || []).forEach(check);
        (body.comets || []).forEach(check);
        (body.stars || []).forEach(check);
        if (body.planet) check(body.planet);
        if (body.black_hole) check(body.black_hole.companion);
        nucleusEntities(body).forEach(check);
    });
}

function checkPlacement(u, fail) {
    const lim = limitingMag(MIN_FOV);
    const linked = new Map();
    u.bodies.forEach((b) => {
        if (b.neutron_star && b.neutron_star.remnant_of) linked.set(b.code, b.neutron_star.remnant_of);
    });
    const vecs = u.bodies.map((b) => azAltToVec3(b.sky.az, b.sky.alt));
    // No pair is ever further apart than this and still too close, so only pairs inside it need the full rule
    const widest = Math.cos(1.0001 * RAD);
    u.bodies.forEach((body, i) => {
        if (!(body.sky.alt > MIN_ALT)) fail(`${body.code} (${body.kind}) is at altitude ${body.sky.alt}`);
        if (body.sky.az < 0 || body.sky.az >= 360) fail(`${body.code} has azimuth ${body.sky.az}`);
        for (let j = i + 1; j < u.bodies.length; j++) {
            const a = vecs[i];
            const b = vecs[j];
            const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
            if (dot <= widest) continue;
            const other = u.bodies[j];
            const need = spacingBetween(body, other);
            if (dot > Math.cos(need * RAD) + 1e-12) {
                if (linked.get(body.code) === other.code || linked.get(other.code) === body.code) continue;
                fail(`${body.code} and ${other.code} are closer than ${need.toFixed(3)} degrees`);
            }
        }
        if (body.bands.visible > 0.01 && body.brightness.mag > lim) fail(`${body.code} (${body.kind}) shows in visible light but has magnitude ${body.brightness.mag}`);
    });

    // The target's host keeps the sky round it clear, so it isn't lost among landmarks (spec 9)
    const host = unseal().target.host;
    const hostBody = u.resolve(host.code).body;
    u.bodies.forEach((b) => {
        if (b !== hostBody && angularSeparation(b.sky.az, b.sky.alt, hostBody.sky.az, hostBody.sky.alt) < host.clear_deg - 0.2) fail(`${b.code} crowds the target's host`);
    });

    const showing = u.bodies.filter((b) => b.bands.visible > 0.01 && b.brightness.mag <= limitingMag(DEFAULT_FOV)).length;
    if (showing < DEFAULT_ZOOM_RANGE[0] || showing > DEFAULT_ZOOM_RANGE[1]) fail(`${showing} bodies show at the default zoom`);

    // Concentrated to the band, or away from it
    const share = (list) => list.filter((b) => Math.abs(galacticLatitude(b.sky.az, b.sky.alt)) < 20).length / list.length;
    const stars = u.bodies.filter((b) => b.kind === 'star');
    const distant = u.bodies.filter((b) => b.kind === 'galaxy' || b.kind === 'quasar');
    if (share(stars) < 0.42) fail(`only ${share(stars)} of stars lie near the band`);
    if (distant.some((b) => Math.abs(galacticLatitude(b.sky.az, b.sky.alt)) < 11.5)) fail('a galaxy or quasar is in the zone of avoidance');
}

function checkStar(star, cls, code, fail) {
    const row = STAR_TABLE[cls];
    if (!row) return;
    if (!within(star.teff_K, row.T[0], row.T[1], 0.001)) fail(`${code} ${cls} has temperature ${star.teff_K}`);
    // A metal-poor giant is as old as the galaxy, so it can only be as heavy as the stars leaving the main sequence now, about
    // 0.8 to 1 solar masses: below the table's giant row, which is drawn from younger giants
    const lightest = cls === 'GIANT' && star.population === 'II' ? 0.8 : row.M[0];
    if (!within(star.mass_Msun, lightest, row.M[1], 0.01)) fail(`${code} ${cls} has mass ${star.mass_Msun}`);
    if (!within(star.radius_Rsun, row.R[0], row.R[1], cls === 'WD' ? 2 : 0.1)) fail(`${code} ${cls} has radius ${star.radius_Rsun}`);
    // White dwarfs break the table's luminosity column on purpose: at 0.01 solar radii, Stefan-Boltzmann takes the
    // hottest to several solar luminosities, and the physics matters more than the column
    if (cls !== 'WD' && !within(star.luminosity_Lsun, row.L[0], row.L[1], 0.3)) fail(`${code} ${cls} has luminosity ${star.luminosity_Lsun}`);
    if (star.vsini_kms < 0) fail(`${code} has negative v sin i`);
    const expected = luminosityFromRT(star.radius_Rsun, star.teff_K);
    if (Math.abs(star.luminosity_Lsun / expected - 1) > 0.12) fail(`${code} breaks L = R^2 T^4: ${star.luminosity_Lsun} against ${expected}`);
    if (star.population === 'II' && star.composition.Z > 0.0011) fail(`${code} is population II with Z = ${star.composition.Z}`);
    if (star.population === 'II' && star.stage === 'main_sequence' && msLifetimeMyr(star.mass_Msun) < 8000) fail(`${code} is too massive to be population II`);
    if (!star.spectral_type) fail(`${code} has no spectral type`);
}

// Stars inside other things keep to the same physics, though not to one class's row of the table
function checkInnerStar(star, code, fail) {
    const expected = luminosityFromRT(star.radius_Rsun, star.teff_K);
    if (Math.abs(star.luminosity_Lsun / expected - 1) > 0.12) fail(`${code} breaks L = R^2 T^4`);
    if (!star.spectral_type || !star.composition) fail(`${code} has an incomplete star block`);
}

function checkStars(u, fail) {
    u.bodies.forEach((body) => {
        if (body.star) checkStar(body.star, classKey(body.star), body.code, fail);
        (body.stars || []).forEach((s) => checkInnerStar(s.star, s.code, fail));
        if (body.black_hole) checkInnerStar(body.black_hole.companion.star, body.black_hole.companion.code, fail);
        if (body.nucleus) body.nucleus.nucleus.stars.forEach((s) => checkInnerStar(s.star, s.code, fail));
        if (body.cluster) {
            body.cluster.members.forEach((m) => {
                checkInnerStar(m.star, m.code, fail);
                (m.stars || []).forEach((s) => checkInnerStar(s.star, s.code, fail));
            });
        }
        if (body.nebula && body.nebula.central_star) checkInnerStar(body.nebula.central_star, body.code, fail);
        if (body.kind === 'star') {
            const f = fluxFromLuminosity(body.star.luminosity_Lsun, body.distance_pc);
            if (Math.abs(body.brightness.flux_Wm2 / f - 1) > 1e-3) fail(`${body.code}'s flux doesn't match its luminosity and distance`);
            if (Math.abs(body.radial_velocity_kms) > FASTEST_STAR_KMS) fail(`${body.code} moves at ${body.radial_velocity_kms} km/s`);
        }
    });
    // Spec 12: stars within 300 km/s, but for a rare few fast halo stars
    const stars = u.bodies.filter((b) => b.kind === 'star');
    const fast = stars.filter((b) => Math.abs(b.radial_velocity_kms) > FAST_STAR_KMS).length;
    if (fast > FAST_STAR_SHARE * stars.length) fail(`${fast} stars move faster than ${FAST_STAR_KMS} km/s`);
}

function checkPlanets(u, fail) {
    const sealed = unseal();
    const exempt = new Set([sealed.target.host.code, ...sealed.decoys.map((d) => d.host.code)]);
    const wet = [];
    u.bodies.forEach((body) => {
        if (body.kind === 'home_planet') {
            if (hasWater(body.planet)) fail(`home planet ${body.name} has water`);
            if (body.planet.in_hz) fail(`home planet ${body.name} is marked in a habitable zone`);
            return;
        }
        checkComets(body, fail);
        if (!body.planets || !body.planets.length) return;
        // Worked out from luminosity for every host, even those the panel's formula doesn't suit
        const L = hostLuminosity(body);
        const hz = hzEdges(L);
        const rStar = hostRadiusAU(body);
        const single = isSingleMainSequence(body);
        let last = null;
        body.planets.forEach((planet) => {
            const a = planet.orbit_AU;
            const inZone = a >= hz.inner && a <= hz.outer;
            if (planet.host !== body.code) fail(`${planet.code} names the wrong host`);
            if (a < (MIN_STELLAR_RADII - 0.01) * rStar) fail(`${planet.code} at ${a} AU is inside ${MIN_STELLAR_RADII} radii of its star`);
            if (planet.in_hz && !single) fail(`${planet.code} is marked in_hz around a host the formula doesn't suit`);
            if (planet.in_hz !== (single && inZone)) fail(`${planet.code}'s in_hz flag is wrong`);
            if (hasWater(planet) && inZone) wet.push(planet.code);
            const hot = planet.type === 'hot_jupiter' || planet.type === 'lava_world';
            if (hot && !(a < 0.1 || a < 0.3 * hz.inner)) fail(`${planet.code} (${planet.type}) is too far out at ${a} AU`);
            if (hot && inZone) fail(`${planet.code} (${planet.type}) is in the zone`);
            if ((planet.type === 'ice_giant' || planet.type === 'ice_dwarf' || planet.type === 'frozen_ocean') && a <= hz.outer) {
                fail(`${planet.code} (${planet.type}) is inside the zone's outer edge`);
            }
            const mass = planet.orbit_centre_stars
                ? planet.orbit_centre_stars.reduce((m, i) => m + body.stars[i].star.mass_Msun, 0)
                : hostMass(body);
            const period = keplerPeriodDays(a, mass);
            if (Math.abs(planet.period_days / period - 1) > 1e-3) fail(`${planet.code}'s period breaks Kepler's third law`);
            if (Math.abs(planet.radial_velocity_kms - body.radial_velocity_kms) > 1e-9) fail(`${planet.code} doesn't inherit its star's velocity`);
            if (!exempt.has(body.code) && last !== null) {
                const ratio = a / last;
                if (ratio < 1.399 || ratio > 2.001) fail(`${planet.code} is spaced ${ratio} from the planet inside it`);
            }
            if (!exempt.has(body.code) && planet.type && !PLANET_TYPES[planet.type]) fail(`${planet.code} has unknown type ${planet.type}`);
            last = a;
        });
        if (body.stars && body.orbits.length && body.architecture !== 'double_double') {
            const widest = body.orbits[body.orbits.length - 1].a_AU;
            if (body.planets[0].orbit_AU < 2.99 * widest) fail(`${body.code}'s first planet is too near its stars`);
        }
    });
    if (wet.length !== 1 || wet[0] !== sealed.target.planets[sealed.target_index].code) {
        fail(`${wet.length} planets have water in a habitable zone`);
    }
    const flagged = [];
    u.bodies.forEach((b) => (b.planets || []).forEach((p) => { if (p.in_hz && hasWater(p)) flagged.push(p.code); }));
    if (flagged.length !== 1) fail(`${flagged.length} planets are marked in_hz with water`);
    // The decoys must be there and must fail in the way they're meant to
    sealed.decoys.forEach((decoy, i) => {
        const found = u.resolve(decoy.planet.code);
        if (!found) return fail(`decoy ${i} is missing`);
        const zone = hzEdges(found.body.star.luminosity_Lsun);
        const a = found.entity.orbit_AU;
        if (decoy.beyond_zone ? a <= zone.outer : !(a >= zone.inner && a <= zone.outer)) fail(`decoy ${i} is in the wrong place`);
        return null;
    });
}

// Comets of other stars: clear of their stars and of every planet's path, and growing tails only where it's warm enough.
// Round a multiple system, data/dynamics.js checks them against its stars as it does planets.
function checkComets(body, fail) {
    (body.comets || []).forEach((c) => {
        if (c.host !== body.code) fail(`${c.code} names the wrong host`);
        if (c.kind !== 'comet' || !c.comet || !c.comet.emission_lines.length) fail(`${c.code} is an incomplete comet`);
        const mass = body.star ? body.star.mass_Msun : body.stars.reduce((m, s) => m + s.star.mass_Msun, 0);
        if (Math.abs(c.period_days / keplerPeriodDays(c.orbit_AU, mass) - 1) > 1e-3) fail(`${c.code}'s period breaks Kepler's third law`);
        if (!(c.ecc > 0 && c.ecc < 1)) fail(`${c.code} has eccentricity ${c.ecc}`);
        if (body.star && c.orbit_AU * (1 - c.ecc) < 2 * MIN_STELLAR_RADII * body.star.radius_Rsun * RSUN_AU) fail(`${c.code} grazes its star`);
        if (crossesPlanet(c, body.planets || [])) fail(`${c.code}'s path crosses a planet's`);
        const L = hostLuminosity(body);
        if (c.comet.tail_onset_AU > 3.01 * Math.sqrt(L)) fail(`${c.code} grows a tail too far from its star`);
        if (!(c.comet.tail_AU > 0) || cometTailAU(c, c.comet.tail_onset_AU * 1.001) !== 0) fail(`${c.code}'s tail doesn't grow and fade with warmth`);
        if (c.ecc > MAX_ECC) fail(`${c.code} is more stretched than the system view draws`);
        if (Math.abs(c.radial_velocity_kms - body.radial_velocity_kms) > 1e-9) fail(`${c.code} doesn't share its star's velocity`);
    });
}

// Every system of stars could really exist: Kepler, a stable hierarchy, Roche lobes, round close orbits, planets in stable
// zones, stars born together (data/dynamics.js). Sky systems, pairs in clusters, and black holes with their companions.
// The deeper sky adds none of the few pairs that pass mass across.
function checkDynamics(u, fail) {
    const systems = [];
    u.bodies.forEach((body) => {
        if (body.stars || body.black_hole) systems.push(body);
        if (body.cluster) body.cluster.members.forEach((m) => { if (m.stars) systems.push(m); });
    });
    systems.forEach((system) => systemProblems(system).forEach((p) => fail(`${p.test}: ${p.message}`)));
    u.bodies.filter((b) => b.deep).forEach((body) => {
        if (body.interacting) fail(`${body.code} is a deeper-sky pair passing mass across`);
        if (body.cluster && body.cluster.members.some((m) => m.interacting)) fail(`${body.code} is a deeper-sky cluster with a pair passing mass across`);
    });
    // Black holes fed in the usual mix of ways, and enough eclipsing pairs for the light curve to find
    const feeding = countBy(u.bodies.filter((b) => b.black_hole), (b) => b.black_hole.feeding);
    Object.keys(MIX.blackHoleFeeding).forEach((k) => {
        if (feeding[k] !== MIX.blackHoleFeeding[k]) fail(`${feeding[k]} black holes fed by ${k}, expected ${MIX.blackHoleFeeding[k]}`);
    });
    const eclipsing = u.bodies.filter((b) => b.stars && eclipsingOrbits(b).length).length;
    if (eclipsing < MIN_ECLIPSING) fail(`only ${eclipsing} multi-star systems eclipse`);
}

function checkMulti(u, fail) {
    u.bodies.filter((b) => b.stars).forEach((body) => {
        if (body.stars.length !== { binary: 2, hierarchical_triple: 3, figure_eight: 3, double_double: 4 }[body.architecture]) {
            fail(`${body.code} has ${body.stars.length} stars for ${body.architecture}`);
        }
        if (body.kind !== (body.architecture === 'binary' ? 'binary' : 'multiple')) fail(`${body.code} has kind ${body.kind}`);
        if (body.architecture === 'hierarchical_triple' && body.orbits[1].period_days < 10 * body.orbits[0].period_days) {
            fail(`${body.code}'s outer period is under ten times its inner`);
        }
        body.orbits.filter((o) => !o.shared_path).forEach((orbit) => {
            const members = [...orbit.a, ...orbit.b];
            const mass = members.reduce((m, i) => m + body.stars[i].star.mass_Msun, 0);
            const period = keplerPeriodDays(orbit.a_AU, mass);
            if (Math.abs(orbit.period_days / period - 1) > 2e-3) fail(`${body.code}'s orbit breaks Kepler's third law`);
        });
        const states = componentStates(body, 12.34);
        if (states.length !== body.stars.length) fail(`${body.code} gives ${states.length} component states`);
        let weighted = 0;
        states.forEach((s, i) => { weighted += s.vlos_kms * body.stars[i].star.mass_Msun; });
        if (Math.abs(weighted) > 1e-6) fail(`${body.code}'s centre of mass is moving: ${weighted}`);
    });
    const eight = u.resolve('F8Q3ZN');
    if (!eight || eight.body.architecture !== 'figure_eight' || eight.body.planets.length) fail('figure-eight is wrong');
    const dd = u.resolve('D2W7XK');
    if (!dd || dd.body.architecture !== 'double_double' || dd.body.planets.length !== 1) fail('double-double is wrong');
    ['F8Q3ZA', 'F8Q3ZB', 'F8Q3ZC', 'D2W7XA', 'D2W7XB', 'D2W7XC', 'D2W7XD'].forEach((code) => {
        const r = u.resolve(code);
        if (!r || r.path !== 'component') fail(`${code} doesn't resolve to a component`);
    });
}

function checkDeepSky(u, fail) {
    u.bodies.forEach((body) => {
        if (body.black_hole) {
            const bh = body.black_hole;
            if (!within(bh.mass_Msun, 3, 30)) fail(`${body.code} has mass ${bh.mass_Msun}`);
            const amplitude = Math.max(...Array.from({ length: 64 }, (_, i) => Math.abs(componentStates(body, (i / 64) * bh.period_days)[1].vlos_kms)));
            if (Math.abs(amplitude / bh.K_kms - 1) > 0.01) fail(`${body.code}'s K doesn't match its orbit`);
        }
        if (body.cluster) {
            const c = body.cluster;
            const n = c.members.length;
            if (n < 30 || n > 150) fail(`${body.code} has ${n} members`);
            c.members.forEach((m) => {
                if (c.type === 'globular' && m.star.population !== 'II') fail(`${m.code} isn't metal-poor`);
                if (m.star.stage === 'main_sequence') {
                    if (m.star.mass_Msun > c.turnoff_Msun * 1.001) fail(`${m.code} should have left the main sequence`);
                    if (m.brightness.mag > limitingMag(MIN_FOV)) fail(`${m.code} is too faint to find`);
                }
                // A companion was born with its star, so it's as old and made of the same, and still below the turn-off
                (m.stars || []).forEach((s) => {
                    if (s.star === m.star) return;
                    if (s.star.stage !== 'main_sequence') fail(`${s.code} should be on the main sequence`);
                    if (s.star.mass_Msun > c.turnoff_Msun * 1.001) fail(`${s.code} should have left the main sequence`);
                    if (s.star.mass_Msun > m.star.mass_Msun * 1.001) fail(`${s.code} is heavier than its partner`);
                    if (s.star.composition !== c.composition) fail(`${s.code} isn't made of what its cluster is`);
                    if (c.type === 'globular' && s.star.population !== 'II') fail(`${s.code} isn't metal-poor`);
                });
                if (m.stars && Math.abs(m.orbits[0].period_days) <= 0) fail(`${m.code} has no orbit`);
            });
            const counted = c.members.reduce((sum, m) => sum + (m.stars ? 2 : 1), 0);
            if (c.n_stars !== counted) fail(`${body.code} counts ${c.n_stars} stars, not ${counted}`);
            if (Math.abs(msLifetimeMyr(c.turnoff_Msun) / c.age_Myr - 1) > 0.02) fail(`${body.code}'s turn-off doesn't match its age`);
        }
        if (body.neutron_star && body.neutron_star.pulsar) {
            if (!within(body.neutron_star.pulse_period_s, 0.001, 5)) fail(`${body.code} has period ${body.neutron_star.pulse_period_s}`);
        }
        if (body.galaxy) {
            const expected = H0 * body.galaxy.distance_Mpc;
            if (Math.abs(body.radial_velocity_kms - expected) > PECULIAR_GALAXY_KMS + 0.5) fail(`${body.code} strays from Hubble's law`);
            if (Math.abs(body.galaxy.z - body.radial_velocity_kms / C_KMS) > 1e-3) fail(`${body.code}'s z is wrong`);
        }
        if (body.quasar && !within(body.quasar.z, 0.5, 4)) fail(`${body.code} has z = ${body.quasar.z}`);
        if (body.supernova && body.supernova.remnant_code) {
            const r = u.resolve(body.supernova.remnant_code);
            if (!r || r.body.neutron_star.remnant_of !== body.code) fail(`${body.code}'s remnant link is broken`);
            if (r && r.body.distance_pc !== body.distance_pc) fail(`${body.code} and its remnant are at different distances`);
        }
        if (body.nebula && body.nebula.type === 'planetary' && (!body.nebula.central_star || body.nebula.central_star.stage !== 'white_dwarf')) {
            fail(`${body.code} has no central white dwarf`);
        }
    });
    const phases = u.bodies.filter((b) => b.supernova).map((b) => b.supernova.phase0_days);
    if (new Set(phases).size !== phases.length) fail('two supernovae share a phase');
}

export function validateUniverse(u) {
    const failures = [];
    const fail = (message) => { failures.push(message); return null; };
    checkCounts(u, fail);
    checkCodes(u, fail);
    checkBands(u, fail);
    checkPlacement(u, fail);
    checkStars(u, fail);
    checkPlanets(u, fail);
    checkMulti(u, fail);
    checkDynamics(u, fail);
    checkDeepSky(u, fail);
    nucleusProblems(u, fail);
    return failures;
}
