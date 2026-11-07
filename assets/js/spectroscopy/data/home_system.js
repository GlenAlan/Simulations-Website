// The seven home planets (spec 4): real values, fixed places along an arc of sky, reflected sunlight. The bright ones
// sit where a student looking around first will meet them. Sunlight stands in for a host; the Sun itself isn't a body.

import { stable } from '../core/rng.js';
import { keplerPeriodDays, AU, PC } from '../core/phys.js';
import { fluxFromVisualMag, dp } from './stellar.js';
import { PLANET_TYPES } from './planets.js';

const AU_IN_PC = AU / PC;

const HOME_PLANETS = [
    {
        name: 'Mercury', type: 'rocky_airless', a: 0.387, sky: { az: 98, alt: 9.5 }, mag: 0, radius: 0.383, mass: 0.055, albedo: 0.14,
        pressure: 0, day: 1408, T: 440, pct: {}, ppm: {}, surface: { rock: 'iron' }
    },
    {
        name: 'Venus', type: 'thick_co2', a: 0.723, sky: { az: 108, alt: 24 }, mag: -4, radius: 0.949, mass: 0.815, albedo: 0.76,
        pressure: 92, day: 2802, T: 737, pct: { CO2: 96.5, N2: 3.5 }, ppm: { SO2: 150, H2SO4: 20 }, surface: { rock: 'basalt' },
        clouds: { kind: 'H2SO4', cover: 1 }
    },
    {
        name: 'Mars', type: 'thin_co2', a: 1.524, sky: { az: 131, alt: 46 }, mag: 0.5, radius: 0.532, mass: 0.107, albedo: 0.25,
        pressure: 0.006, day: 24.6, T: 210, pct: { CO2: 95, N2: 2.8, Ar: 2 }, ppm: { O2: 1300 }, surface: { rock: 'iron_oxide' },
        clouds: { kind: 'dust', cover: 0.1 }
    },
    {
        name: 'Jupiter', type: 'gas_giant', a: 5.204, sky: { az: 173, alt: 58 }, mag: -2.2, radius: 11.2, mass: 317.8, albedo: 0.5,
        pressure: 100, day: 9.9, T: null, pct: { H2: 89.8, He: 10.2 }, ppm: { CH4: 3000, NH3: 260 },
        clouds: { kind: 'NH3', cover: 0.9 }
    },
    {
        name: 'Saturn', type: 'gas_giant', a: 9.58, sky: { az: 213, alt: 52 }, mag: 0.5, radius: 9.45, mass: 95.2, albedo: 0.47,
        pressure: 100, day: 10.7, T: null, pct: { H2: 96.3, He: 3.7 }, ppm: { CH4: 4500, NH3: 125 },
        clouds: { kind: 'NH3', cover: 0.9 }, rings: { inner_Rp: 1.24, outer_Rp: 2.27, tilt_deg: 26.7, opacity: 0.8 }
    },
    {
        name: 'Uranus', type: 'ice_giant', a: 19.2, sky: { az: 243, alt: 38 }, mag: 5.7, radius: 4.01, mass: 14.5, albedo: 0.51,
        pressure: 100, day: 17.2, T: null, pct: { H2: 82.5, He: 15.2, CH4: 2.3 }, ppm: {},
        rings: { inner_Rp: 1.64, outer_Rp: 2.0, tilt_deg: 97.8, opacity: 0.2 }
    },
    {
        name: 'Neptune', type: 'ice_giant', a: 30.1, sky: { az: 262, alt: 22 }, mag: 7.8, radius: 3.88, mass: 17.1, albedo: 0.44,
        pressure: 100, day: 16.1, T: null, pct: { H2: 80, He: 18.5, CH4: 1.5 }, ppm: {}
    }
];

export function makeHomePlanets(rng, nextCode) {
    return HOME_PLANETS.map((p) => {
        const code = nextCode();
        const tEq = stable(278.5 * Math.sqrt(Math.sqrt(1 - p.albedo)) / Math.sqrt(p.a), 4);
        const brightness = { flux_Wm2: fluxFromVisualMag(p.mag), mag: p.mag };
        const distance = stable(p.a * AU_IN_PC, 4);
        const planet = {
            code,
            kind: 'planet',
            type: p.type,
            type_label: PLANET_TYPES[p.type].label,
            host: code,
            orbit_centre_stars: null,
            orbit_AU: p.a,
            period_days: stable(keplerPeriodDays(p.a, 1), 6),
            phase0: dp(rng.next(), 5),
            inclination_deg: dp(rng.range(-3, 3), 2),
            radius_Rearth: p.radius,
            mass_Mearth: p.mass,
            gravity_g: stable(p.mass / (p.radius * p.radius), 3),
            albedo: p.albedo,
            in_hz: false,
            T_eq_K: tEq,
            T_surface_K: p.T,
            pressure_bar: p.pressure,
            day_length_h: p.day,
            tidally_locked: false,
            atmosphere_pct: p.pct,
            atmosphere_ppm: p.ppm,
            surface: { ocean_fraction: 0, rock: 'silicate', ice: null, red_edge_nm: null, subsurface_ocean: false, ...p.surface },
            clouds: p.clouds || { kind: null, cover: 0 },
            rings: p.rings || null,
            host_teff_K: 5772,
            host_luminosity_Lsun: 1,
            host_mass_Msun: 1,
            radial_velocity_kms: 0,
            distance_pc: distance,
            brightness,
            bands: null,
            visual_seed: code
        };
        return {
            code,
            kind: 'home_planet',
            name: p.name,
            sky: p.sky,
            distance_pc: distance,
            radial_velocity_kms: 0,
            bands: null,
            brightness,
            visual_seed: code,
            planet
        };
    });
}
