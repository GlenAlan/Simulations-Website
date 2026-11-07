// The black holes at the centres of galaxies. Nearly every big galaxy has one, of millions to billions of solar masses,
// heavier the bigger the galaxy's bulge. Most are quiet. A few are feeding: gas spiralling in on a hot disc shines in
// ultraviolet and X-rays, clouds of gas close in move at thousands of km/s and give broad emission lines, and some drive
// radio jets. Seen through the dusty doughnut round the disc (type 2) the broad lines are hidden; seen down its axis
// (type 1) they show.
//
// Made after everything else, from streams and codes of their own, so nothing else in the sky changes.
//
// A galaxy with a hole has body.nucleus, an entity of kind 'nucleus' that resolves with path 'nucleus':
//   { code, kind: 'nucleus', parent: the galaxy's code, distance_pc, radial_velocity_kms, brightness, bands, visual_seed,
//     nucleus: { mass_Msun, active, type: 1 | 2 | 0 (quiet), radio_loud, jets, eddington_ratio, luminosity_Lsun,
//                xray_Lsun, blr_light_days, broad_fwhm_kms, narrow_fwhm_kms, oiii_hbeta, sigma_kms, bulge_mass_Msun,
//                inclination_deg, disc_T_K, z, stars[], orbits[] } }
//   luminosity_Lsun is bolometric. blr_light_days is how far out the broad-line gas is, as reverberation measures it, and
//   broad_fwhm_kms its lines' width: M = f R v^2 / G with f = FWHM_F. Null where there's no broad-line gas to speak of.
//   inclination_deg is the disc's axis against the line of sight: small for type 1, large for type 2.
//   stars[] are a few stars on close orbits round the hole, as round the one at our own Galaxy's centre: each is
//   { code, kind: 'star_component', parent: the nucleus's code, star, ... }, resolving with path 'component'. orbits[]
//   pairs them with the hole by index, the hole being 0, nested as data/orbits.js reads them.
// brightness.mag is the nucleus's own point of light in visible light; brightness.flux_Wm2 its bolometric flux.

import { stable } from '../core/rng.js';
import { fluxFromLuminosity, keplerPeriodDays, G, M_SUN, AU, C_MS, L_SUN } from '../core/phys.js';
import { dp, makeClassStar, absoluteVisual, apparentMag } from './stellar.js';

const EDDINGTON_LSUN_PER_MSUN = 3.29e4;     // L_Edd = 1.26e31 W for each solar mass
const BULGE_SHARE = 0.0049;                 // A hole is about half a per cent of its bulge's mass (Kormendy and Ho 2013)
const BULGE_SCATTER_DEX = 0.28;
const FWHM_F = 1.1;                         // The virial factor for a line's full width at half maximum
const TYPE_1_SHARE = 0.4;                   // Of active nuclei: more are seen through their dust than down its axis
const TYPE_1_BRIGHT_SHARE = 0.7;            // ...and of those seen down it, this share in the brighter half of the galaxies
const STARS_EACH = 3;
const LIGHT_DAY_M = C_MS * 86400;
const ERG_PER_LSUN = L_SUN * 1e7;

// Gravitational radius GM/c^2 in AU, for a mass in solar masses
const rgAU = (mass) => (G * M_SUN * mass) / (C_MS * C_MS) / AU;

// The stars' speeds in the bulge, from the M-sigma relation (Kormendy and Ho 2013): M = 3.09e8 (sigma / 200)^4.38
function sigmaFor(mass) {
    return 200 * (mass / 3.09e8) ** (1 / 4.38);
}

// How much of the galaxy is bulge: all of an elliptical, some of a spiral
function bulgeShare(rng, morphology) {
    if (morphology === 'elliptical') return 1;
    return rng.logRange(0.08, 0.5);
}

// { bulge, mass } in solar masses: the bulge's stars from their light and a mass-to-light ratio for old stars
function holeMass(rng, galaxy) {
    if (galaxy.morphology === 'irregular') return { bulge: 0, mass: rng.logRange(1e5, 1e6) };   // No bulge to speak of: a small hole, as in NGC 4395
    const bulge = bulgeShare(rng, galaxy.morphology) * galaxy.luminosity_Lsun * rng.range(2.5, 5);
    const scatter = Math.max(-2, Math.min(2, rng.gauss())) * BULGE_SCATTER_DEX;
    return { bulge, mass: Math.min(2e10, Math.max(1e6, BULGE_SHARE * bulge * 10 ** scatter)) };
}

// The broad-line region's radius in light-days, from the light at 510 nm (Bentz et al. 2013)
function blrLightDays(luminosityLsun) {
    const l5100 = (luminosityLsun * ERG_PER_LSUN) / 9;
    return 33.65 * (l5100 / 1e44) ** 0.533;
}

function broadFwhm(mass, lightDays) {
    return Math.sqrt((G * mass * M_SUN) / (FWHM_F * lightDays * LIGHT_DAY_M)) / 1000;
}

// A few hot young stars on close, stretched orbits, as round the Milky Way's own black hole. Distances are in units of
// the hole's gravitational radius, so a heavier hole's are wider and slower.
function makeCloseStars(rng, nextCode, nucleusCode, mass, galaxyBody, inclination) {
    const stars = [];
    const orbits = [];
    let a = rng.range(700, 1200);
    let inside = mass;
    for (let i = 0; i < STARS_EACH; i++) {
        const star = makeClassStar(rng, 'B');
        const code = nextCode();
        const absV = absoluteVisual(star.luminosity_Lsun, star.teff_K);
        stars.push({
            code,
            kind: 'star_component',
            parent: nucleusCode,
            star,
            distance_pc: galaxyBody.distance_pc,
            radial_velocity_kms: galaxyBody.radial_velocity_kms,
            brightness: { flux_Wm2: stable(fluxFromLuminosity(star.luminosity_Lsun, galaxyBody.distance_pc), 5), mag: apparentMag(absV, galaxyBody.distance_pc) },
            visual_seed: code
        });
        const aAU = stable(a * rgAU(mass), 5);
        const total = inside + star.mass_Msun;
        // The widest orbit sets the line of sight the view opens on; the others lie every which way, as they do
        const last = i === STARS_EACH - 1;
        orbits.push({
            a: Array.from({ length: i + 1 }, (_, k) => k),
            b: [i + 1],
            a_AU: aAU,
            period_days: stable(keplerPeriodDays(aAU, total), 6),
            ecc: dp(rng.range(0.15, 0.45), 3),
            inc_deg: last ? inclination : dp(rng.range(5, 175), 1),
            omega_deg: dp(rng.range(0, 360), 1),
            phase0: dp(rng.next(), 4)
        });
        inside = total;
        a *= rng.range(1.6, 2.1);
    }
    return { stars, orbits };
}

function makeNucleus(rng, nextCode, body, flags) {
    const g = body.galaxy;
    const code = nextCode();
    const drawn = holeMass(rng, g);
    const mass = stable(drawn.mass, 4);
    const bulge = stable(drawn.bulge, 4);
    const { active, type, radioLoud } = flags;

    // Feeding: a few per cent of what it could take, held below a few times the galaxy's own light, as a Seyfert's is.
    // Quiet: next to nothing, like the hole at our own Galaxy's centre.
    const eddington = EDDINGTON_LSUN_PER_MSUN * mass;
    let lambda = active ? rng.logRange(0.005, 0.3) : rng.logRange(1e-7, 1e-5);
    if (active) lambda = Math.min(lambda, (3 * g.luminosity_Lsun) / eddington);
    const luminosity = stable(lambda * eddington, 4);
    const inclination = dp(type === 1 ? rng.range(12, 40) : type === 2 ? rng.range(60, 85) : rng.range(20, 80), 1);
    const sigma = sigmaFor(mass);

    // Visible light from the point itself: a tenth of the total from a bare disc, a few in a thousand scattered round the dust
    let visible = luminosity / rng.range(8, 14);
    if (type === 2) visible *= rng.range(0.003, 0.02);
    if (!active) visible *= 0.1;          // Most of a starved hole's little light comes out in radio and X-rays
    const mag = dp(body.brightness.mag - 2.5 * Math.log10(visible / g.luminosity_Lsun), 3);

    const blr = active ? blrLightDays(luminosity) : null;
    const close = makeCloseStars(rng.fork('stars'), nextCode, code, mass, body, inclination);
    return {
        code,
        kind: 'nucleus',
        parent: body.code,
        distance_pc: body.distance_pc,
        radial_velocity_kms: body.radial_velocity_kms,
        brightness: { flux_Wm2: stable(fluxFromLuminosity(luminosity, body.distance_pc), 5), mag },
        bands: null,
        visual_seed: code,
        nucleus: {
            mass_Msun: mass,
            active,
            type,
            radio_loud: radioLoud,
            jets: radioLoud,
            eddington_ratio: stable(lambda, 3),
            luminosity_Lsun: luminosity,
            xray_Lsun: stable(luminosity / (active ? rng.range(12, 30) : rng.range(2, 6)), 3),
            blr_light_days: blr === null ? null : stable(blr, 3),
            broad_fwhm_kms: blr === null ? null : Math.round(broadFwhm(mass, blr)),
            narrow_fwhm_kms: Math.round(Math.min(900, Math.max(250, 2.355 * sigma * rng.range(0.8, 1.1)))),
            oiii_hbeta: dp(active ? rng.range(4, 12) : rng.range(0.5, 2), 2),
            sigma_kms: Math.round(sigma),
            bulge_mass_Msun: bulge,
            inclination_deg: inclination,
            // The thin disc's hottest, near its inner edge; a starved hole has no thin disc at all
            disc_T_K: active ? stable(5e5 * lambda ** 0.25 * (mass / 1e8) ** -0.25, 3) : null,
            z: body.galaxy.z,
            stars: close.stars,
            orbits: close.orbits
        }
    };
}

// Gives every spiral and elliptical a hole, and any other galaxy flagged as active. The galaxies already marked active,
// or with radio lobes, are the ones feeding: lobes are blown by jets from a feeding hole.
export function addNuclei(rng, bodies, nextCode) {
    const galaxies = bodies.filter((b) => b.kind === 'galaxy');
    const hosts = galaxies.filter((b) => b.galaxy.morphology !== 'irregular' || b.galaxy.active_nucleus || b.galaxy.radio_lobes);
    const active = hosts.filter((b) => b.galaxy.active_nucleus || b.galaxy.radio_lobes);
    // Which are seen down the dust's axis is chance, but the broad lines are easiest to find in the brighter galaxies, as
    // astronomers find them: so most of them are among the brighter half
    const quota = rng.fork('types');
    const byBrightness = active.slice().sort((a, b) => a.brightness.mag - b.brightness.mag || (a.code < b.code ? -1 : 1)).map((b) => b.code);
    const half = Math.ceil(byBrightness.length / 2);
    const ones = Math.round(TYPE_1_SHARE * active.length);
    const fromBright = Math.min(half, Math.ceil(ones * TYPE_1_BRIGHT_SHARE));
    const typeOne = new Set([
        ...quota.shuffle(byBrightness.slice(0, half)).slice(0, fromBright),
        ...quota.shuffle(byBrightness.slice(half)).slice(0, ones - fromBright)
    ]);
    hosts.forEach((body) => {
        const feeding = !!(body.galaxy.active_nucleus || body.galaxy.radio_lobes);
        body.galaxy.active_nucleus = feeding;
        body.nucleus = makeNucleus(rng.fork(`nucleus:${body.code}`), nextCode, body, {
            active: feeding,
            type: feeding ? (typeOne.has(body.code) ? 1 : 2) : 0,
            radioLoud: !!body.galaxy.radio_lobes
        });
    });
}

// The nucleus and its close stars, for anything that walks every entity
export function nucleusEntities(body) {
    return body.nucleus ? [body.nucleus, ...body.nucleus.nucleus.stars] : [];
}

// ---------- Checks, for data/validate.js ----------

export function nucleusProblems(u, fail) {
    const galaxies = u.bodies.filter((b) => b.kind === 'galaxy');
    const holes = galaxies.filter((b) => b.nucleus);
    galaxies.forEach((body) => {
        const m = body.galaxy.morphology;
        if ((m === 'spiral' || m === 'elliptical') && !body.nucleus) fail(`${body.code} (${m}) has no central black hole`);
        if ((body.galaxy.radio_lobes || body.galaxy.active_nucleus) && !(body.nucleus && body.nucleus.nucleus.active)) fail(`${body.code} has lobes or an active flag but no feeding hole`);
    });
    const active = holes.filter((b) => b.nucleus.nucleus.active);
    const share = active.length / Math.max(1, holes.length);
    if (share < 0.12 || share > 0.3) fail(`${active.length} of ${holes.length} central black holes are feeding`);
    const typeOne = active.filter((b) => b.nucleus.nucleus.type === 1).length;
    if (!typeOne || typeOne === active.length) fail(`${typeOne} of ${active.length} feeding holes are type 1: both types should be there`);
    holes.forEach((body) => {
        const n = body.nucleus;
        const k = n.nucleus;
        const r = u.resolve(n.code);
        if (!r || r.path !== 'nucleus' || r.body !== body) fail(`${n.code} doesn't resolve to its galaxy's nucleus`);
        if (!(k.mass_Msun >= 1e5 && k.mass_Msun <= 2e10)) fail(`${n.code} has mass ${k.mass_Msun}`);
        if (body.galaxy.morphology === 'elliptical' && k.mass_Msun < 1e7) fail(`${n.code} is too light for an elliptical`);
        if (n.radial_velocity_kms !== body.radial_velocity_kms || n.distance_pc !== body.distance_pc) fail(`${n.code} isn't where its galaxy is`);
        if (k.radio_loud !== !!body.galaxy.radio_lobes) fail(`${n.code}'s radio doesn't match its galaxy's lobes`);
        if (k.active !== (k.type > 0)) fail(`${n.code} has type ${k.type}`);
        const lambda = k.luminosity_Lsun / (EDDINGTON_LSUN_PER_MSUN * k.mass_Msun);
        if (Math.abs(lambda / k.eddington_ratio - 1) > 0.01) fail(`${n.code}'s luminosity doesn't match its feeding rate`);
        if (k.active && !(lambda > 2e-4 && lambda <= 0.31)) fail(`${n.code} feeds at ${lambda} of its limit`);
        if (!k.active && lambda > 1e-4) fail(`${n.code} is quiet but feeds at ${lambda} of its limit`);
        if (k.active) {
            // The width and radius of the broad-line region must weigh the hole
            const weighed = (FWHM_F * k.blr_light_days * LIGHT_DAY_M * (k.broad_fwhm_kms * 1000) ** 2) / G / M_SUN;
            if (Math.abs(weighed / k.mass_Msun - 1) > 0.01) fail(`${n.code}'s broad lines don't weigh its hole`);
            if (!(k.broad_fwhm_kms > 1000 && k.broad_fwhm_kms < 20000)) fail(`${n.code}'s broad lines are ${k.broad_fwhm_kms} km/s wide`);
        } else if (k.broad_fwhm_kms !== null) fail(`${n.code} is quiet but has broad lines`);
        if (k.stars.length !== STARS_EACH || k.orbits.length !== STARS_EACH) fail(`${n.code} has ${k.stars.length} close stars`);
        let inside = k.mass_Msun;
        k.orbits.forEach((orbit, i) => {
            const star = k.stars[i];
            inside += star.star.mass_Msun;
            if (Math.abs(orbit.period_days / keplerPeriodDays(orbit.a_AU, inside) - 1) > 2e-3) fail(`${star.code}'s orbit breaks Kepler's third law`);
            if (i > 0 && orbit.a_AU * (1 - orbit.ecc) < k.orbits[i - 1].a_AU * (1 + k.orbits[i - 1].ecc) * 0.5) fail(`${star.code} comes too close to the star inside it`);
            if (orbit.a_AU * (1 - orbit.ecc) < 200 * rgAU(k.mass_Msun)) fail(`${star.code} would be torn apart by the hole`);
            const sr = u.resolve(star.code);
            if (!sr || sr.path !== 'component' || sr.entity !== star) fail(`${star.code} doesn't resolve`);
        });
    });
}
