// FOUNDATION STUB, upgraded by the data track: where the members of a multi-star system are at a given time.
// Used by the spectra (line shifts) and the system view (drawing), so both always agree.
//
// componentStates(body, tDays) -> [{ code, x_AU, y_AU, z_AU, vlos_kms }]
//   One entry per star in the system (for a black hole: the hole, then its companion). x and y are in the orbital
//   plane, z is out of it, around the system's centre of mass. vlos_kms is the speed along the line of sight, positive
//   away from us, and excludes the system's own radial_velocity_kms. Positions are exact functions of time, so
//   nothing can drift. The data track adds hierarchical triples, the double-double and the figure-eight's stored path.

import { AU } from '../core/phys.js';

function twoBody(orbit, m1, m2, tDays) {
    const angle = 2 * Math.PI * (orbit.phase0 + tDays / orbit.period_days);
    const total = m1 + m2;
    const r1 = orbit.a_AU * (m2 / total);
    const r2 = orbit.a_AU * (m1 / total);
    const speed = (2 * Math.PI * orbit.a_AU * AU) / (orbit.period_days * 86400) / 1000; // Relative speed, km/s
    const sinI = Math.sin((orbit.inc_deg * Math.PI) / 180);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [
        { x_AU: r1 * c, y_AU: r1 * s, z_AU: 0, vlos_kms: speed * (m2 / total) * sinI * c },
        { x_AU: -r2 * c, y_AU: -r2 * s, z_AU: 0, vlos_kms: -speed * (m1 / total) * sinI * c }
    ];
}

export function componentStates(body, tDays = 0) {
    if (body.stars && body.orbits && body.orbits.length) {
        const orbit = body.orbits[0];
        const [a, b] = twoBody(orbit, body.stars[0].star.mass_Msun, body.stars[1].star.mass_Msun, tDays);
        return [{ code: body.stars[0].code, ...a }, { code: body.stars[1].code, ...b }];
    }
    if (body.black_hole) {
        const bh = body.black_hole;
        const m2 = bh.companion.star.mass_Msun;
        const aAU = Math.cbrt((bh.mass_Msun + m2) * (bh.period_days / 365.25) ** 2);
        const orbit = { a_AU: aAU, period_days: bh.period_days, inc_deg: bh.inc_deg, phase0: bh.phase0 };
        const [hole, companion] = twoBody(orbit, bh.mass_Msun, m2, tDays);
        return [{ code: body.code, ...hole }, { code: bh.companion.code, ...companion }];
    }
    return [];
}
