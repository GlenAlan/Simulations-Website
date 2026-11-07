// Comets of other stars. A comet is a few kilometres of ice: round another star, far too small and faint to see from here, so
// these aren't on the sky. They are found by going into their systems, some of which have no planets at all. Each runs a
// long, stretched orbit, and grows a tail only where its star warms it enough: within about three times the square root of
// the star's luminosity, in AU, which is a few AU for a star like the Sun.
//
// body.comets[]: like body.planets[], each
//   { code, kind: 'comet', host, orbit_centre_stars, orbit_AU (semi-major axis), ecc, perihelion_AU, aphelion_AU,
//     period_days, phase0, inclination_deg, omega_deg, node_deg, radial_velocity_kms, distance_pc, host_teff_K,
//     host_luminosity_Lsun, host_mass_Msun, brightness, bands, visual_seed,
//     comet: { emission_lines[], dust_ratio, nucleus_km, coma_km, tail_onset_AU, tail_AU, heliocentric_AU } }
//   inclination_deg is against the plane of the system's planets. tail_AU is the tail at its longest, at perihelion; there is
//   none beyond tail_onset_AU. heliocentric_AU is the distance from its own star at t = 0. cometState(comet, t) in
//   data/orbits.js gives its place and its tail's length at any time.
//   Eccentricity stays at or under MAX_ECC, the most the system view draws.
// A sky comet (kind 'comet' in universe.bodies) is one of our own Sun's; it has none of the orbit fields.

import { stable } from '../core/rng.js';
import { keplerPeriodDays, fluxFromLuminosity } from '../core/phys.js';
import { dp, RSUN_AU, absoluteVisual, distanceModulus } from './stellar.js';
import { MIN_STELLAR_RADII } from './planets.js';
import { stableZone } from './dynamics.js';
import { cometState } from './orbits.js';

const ONSET = 3;                // Tails form inside ONSET * sqrt(L) AU
const MOID_SHARE = 0.12;        // A comet's path keeps this share of each planet's orbit clear of it
export const MAX_ECC = 0.98;
const KM_AU = 1 / 1.495978707e8;

export function cometLines(rng) {
    const line = (w, rel, label) => ({ w, rel: dp(rel, 3), label });
    return [
        line(388.3, 1, 'CN'),
        line(473.7, rng.range(0.3, 0.5), 'C₂'),
        line(516.5, rng.range(0.6, 0.9), 'C₂'),
        line(563.6, rng.range(0.25, 0.45), 'C₂'),
        line(589.0, rng.range(0.2, 0.5), 'Na D'),
        line(589.6, rng.range(0.1, 0.25), 'Na D')
    ];
}

// A comet's path as distance from the star's axis and height above the planets' plane, evenly in the eccentric anomaly, which
// crowds the points where the path bends tightest. The node's longitude doesn't change either, so a circle in that plane
// is as near to it whichever way it faces.
function pathOf(comet, steps = 1440) {
    const e = comet.ecc;
    const a = comet.orbit_AU;
    const b = a * Math.sqrt(1 - e * e);
    const w = (comet.omega_deg * Math.PI) / 180;
    const inc = (comet.inclination_deg * Math.PI) / 180;
    const ci = Math.cos(inc);
    const si = Math.sin(inc);
    const rho = new Float64Array(steps);
    const z = new Float64Array(steps);
    for (let k = 0; k < steps; k++) {
        const E = (2 * Math.PI * k) / steps;
        const xp = a * (Math.cos(E) - e);
        const yp = b * Math.sin(E);
        const r = Math.hypot(xp, yp);
        const u = Math.atan2(yp, xp) + w;
        const cu = Math.cos(u);
        const su = Math.sin(u);
        rho[k] = r * Math.sqrt(cu * cu + su * su * ci * ci);
        z[k] = r * su * si;
    }
    return { rho, z };
}

// The closest a comet's path comes to a planet's orbit, taken as a circle in the planets' plane
export function closestApproachAU(comet, planet, path = pathOf(comet)) {
    let best = Infinity;
    for (let k = 0; k < path.rho.length; k++) best = Math.min(best, Math.hypot(path.rho[k] - planet.orbit_AU, path.z[k]));
    return best;
}

export function crossesPlanet(comet, planets) {
    if (!planets.length) return false;
    const path = pathOf(comet);
    return planets.some((p) => closestApproachAU(comet, p, path) < MOID_SHARE * p.orbit_AU);
}

// Where a comet round this host may come in to and go out to
function reachOf(host) {
    const L = host.star ? host.star.luminosity_Lsun : host.stars.reduce((sum, s) => sum + s.star.luminosity_Lsun, 0);
    const R = host.star ? host.star.radius_Rsun : host.stars.reduce((m, s) => Math.max(m, s.star.radius_Rsun), 0);
    const zone = host.stars ? stableZone(host, null) : { floor: 0, ceiling: Infinity };
    const sqrtL = Math.sqrt(L);
    return { L, sqrtL, floor: Math.max(MIN_STELLAR_RADII * R * RSUN_AU * 2, 0.15 * sqrtL, zone.floor), ceiling: zone.ceiling };
}

function hostMass(host) {
    return host.star ? host.star.mass_Msun : host.stars.reduce((sum, s) => sum + s.star.mass_Msun, 0);
}

// One comet round a host, redrawn until its path is clear of the host's planets and other comets
export function makeExocomet(rng, code, host) {
    const { L, sqrtL, floor, ceiling } = reachOf(host);
    const mass = hostMass(host);
    const lines = cometLines(rng);
    const dust = dp(rng.next(), 3);
    const nucleus = dp(rng.logRange(0.8, 25), 2);
    const others = [...(host.planets || [])];
    let comet = null;
    for (let tries = 0; tries < 60; tries++) {
        // Most come in close enough for a tail, from the cold outer reaches of their system, which are out there however
        // faint the star; a few turn round before they grow a tail
        const q = Math.max(floor * 1.05, sqrtL * rng.logRange(0.2, tries < 40 ? 2.5 : 6));
        const Q = Math.min(ceiling * 0.95, Math.max(1, Math.sqrt(sqrtL)) * rng.logRange(5, 60), q * ((1 + MAX_ECC) / (1 - MAX_ECC)) * 0.999);
        if (!(Q > q * 2)) continue;
        const a = stable((q + Q) / 2, 5);
        const e = dp((Q - q) / (Q + q), 4);
        comet = {
            code,
            kind: 'comet',
            host: host.code,
            orbit_centre_stars: null,
            orbit_AU: a,
            ecc: e,
            perihelion_AU: stable(a * (1 - e), 4),
            aphelion_AU: stable(a * (1 + e), 4),
            period_days: stable(keplerPeriodDays(a, mass), 6),
            phase0: dp(rng.next(), 5),
            inclination_deg: dp(rng.range(6, 50) * (rng.chance(0.15) ? -1 : 1), 2),
            omega_deg: dp(rng.range(0, 360), 1),
            node_deg: dp(rng.range(0, 360), 1)
        };
        if (!crossesPlanet(comet, others)) break;
        comet = null;
    }
    if (!comet) return null;
    const tailOnset = stable(ONSET * sqrtL, 4);
    // Half of those that ever grow a tail are caught with one, somewhere on the warm part of their orbit
    if (comet.perihelion_AU < tailOnset && rng.chance(0.5)) {
        const cosE = Math.min(1, (1 - tailOnset / comet.orbit_AU) / comet.ecc);
        const E = Math.acos(Math.max(-1, cosE));
        const reach = E - comet.ecc * Math.sin(E);
        comet.phase0 = dp((rng.range(-reach, reach) / (2 * Math.PI) + 1) % 1, 5);
    }
    const longest = stable(sqrtL * rng.logRange(0.08, 0.8) * Math.cbrt(nucleus / 5), 3);
    Object.assign(comet, {
        radial_velocity_kms: host.radial_velocity_kms,
        distance_pc: host.distance_pc,
        host_teff_K: host.star ? host.star.teff_K : host.stars[0].star.teff_K,
        host_luminosity_Lsun: stable(L, 5),
        host_mass_Msun: stable(mass, 5),
        brightness: null,
        bands: null,
        visual_seed: code,
        comet: {
            emission_lines: lines,
            dust_ratio: dust,
            nucleus_km: nucleus,
            coma_km: Math.round(nucleus * rng.range(3000, 9000)),
            tail_onset_AU: tailOnset,
            tail_AU: longest,
            heliocentric_AU: 0
        }
    });
    const now = cometState(comet, 0);
    comet.comet.heliocentric_AU = stable(now.r_AU, 4);
    // Starlight off the dust round it, at its closest: far too faint to see from here, as a planet is
    const reflect = 0.04 * ((comet.comet.coma_km * 0.05 * KM_AU) / (2 * comet.perihelion_AU)) ** 2;
    const starFlux = fluxFromLuminosity(L, host.distance_pc);
    const absV = absoluteVisual(L, comet.host_teff_K);
    comet.brightness = { flux_Wm2: stable(starFlux * reflect, 4), mag: dp(absV + distanceModulus(host.distance_pc) - 2.5 * Math.log10(reflect), 2) };
    return comet;
}
