// Where our galaxy's neutron stars are (round 4): at the distances and heights off the galactic plane real ones have, so
// that the sky holds them in the Milky Way's band, as radio surveys find pulsars, with only the nearest of them well off it.
//   - Distance: log-normal round FIELD_NEUTRON_STARS.medianPc, as the pulsars with measured distances are spread: most
//     between about one and seven thousand parsecs, a few nearer.
//   - Height off the plane: exponential, with the scale height radio surveys find for ordinary pulsars, about 330 pc (Lorimer
//     et al. 2006). A supernova's kick carries them further out of the plane than the stars they came from.
//   - Galactic longitude: even all round.
// Their galactic latitude is then the angle that height makes at that distance: a few degrees for most, more for a near one.
// A neutron star in its own supernova's shell stays where its supernova is.
//
// Last of all in generateUniverse, from a stream of its own, placed round everything else, so nothing else moves. Each keeps
// its code, its look and its magnitude; its true flux follows its new distance.

import { stable } from '../core/rng.js';
import { fluxFromLuminosity } from '../core/phys.js';
import { galacticToAzAlt } from '../core/sky.js';
import { placeOne, removeFromLayout } from './sky_layout.js';

export const FIELD_NEUTRON_STARS = {
    medianPc: 2500,
    dex: 0.35,
    pc: [100, 10000],           // Drawn again outside this
    scaleHeightPc: 330,
    mostHeightPc: 1650,         // Five scale heights: drawn again beyond this
    tries: 600                  // Spots round the galaxy at its latitude, the first clear of everything else taken
};
const RAD = Math.PI / 180;

function fieldDistance(rng) {
    const f = FIELD_NEUTRON_STARS;
    for (let tries = 0; tries < 60; tries++) {
        const d = f.medianPc * 10 ** rng.gauss(0, f.dex);
        if (d >= f.pc[0] && d <= f.pc[1]) return stable(d, 5);
    }
    return f.medianPc;
}

function heightOffPlane(rng) {
    const f = FIELD_NEUTRON_STARS;
    for (let tries = 0; tries < 60; tries++) {
        const z = -f.scaleHeightPc * Math.log(1 - rng.next());
        if (z <= f.mostHeightPc) return z;
    }
    return f.scaleHeightPc;
}

// bodies: the sky's bodies; layout: its layout (data/sky_layout.js), which each neutron star leaves and joins again.
// Returns the neutron stars moved, to be set moving as they would be there (data/motions.js assignVelocities).
export function placeFieldNeutronStars(rng, bodies, layout) {
    const field = bodies.filter((b) => b.kind === 'neutron_star' && b.neutron_star && !b.neutron_star.remnant_of)
        .sort((a, b) => (a.code < b.code ? -1 : 1));
    const moved = [];
    field.forEach((body) => {
        const r = rng.fork(body.code);
        const d = fieldDistance(r);
        const b = Math.atan2(heightOffPlane(r), d) / RAD;
        const candidates = Array.from({ length: FIELD_NEUTRON_STARS.tries }, () => {
            const l = r.range(0, 360);
            const at = galacticToAzAlt(l, r.chance(0.5) ? b : -b);
            return at.az >= 359.9995 ? { az: 0, alt: at.alt } : at;   // So that rounding never makes it 360
        });
        const was = layout.placed.find((p) => p.entry.body === body);
        removeFromLayout(layout, [body]);
        const entry = { body, radius_deg: 0 };
        if (!placeOne(layout, entry, candidates)) {
            if (was) layout.placed.push(was);   // Nowhere clear at its latitude (never so far): it stays where it was
            return;
        }
        body.distance_pc = d;
        body.brightness = { flux_Wm2: stable(fluxFromLuminosity(body.neutron_star.luminosity_Lsun, d), 5), mag: body.brightness.mag };
        moved.push(body);
    });
    return moved;
}
