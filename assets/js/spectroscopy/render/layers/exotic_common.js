// Small helpers shared by the black hole, neutron star, comet and binary layers.

import * as THREE from 'three';
import { azAltToVec3 } from '../../core/sky.js';
import { hashString, Rng } from '../../core/rng.js';
import { PULSE_SHOWN_HZ } from '../../data/deep_sky.js';

export const SKY_RADIUS = 1000; // Sky objects sit on a sphere this far from the observer
export const DEG = Math.PI / 180;

// An object's own random stream: the seed only varies the look, never what the object is
export function bodyRng(body, label = '') {
    return new Rng(hashString(`${body.visual_seed || body.code}/${label}`));
}

// Unit vectors at a sky position: towards it, towards increasing azimuth and towards increasing altitude.
// With the camera aimed there, east is exactly screen right and up is exactly screen up.
export function skyBasis(az, alt) {
    const a = az * DEG;
    const h = alt * DEG;
    return {
        centre: azAltToVec3(az, alt),
        east: [Math.cos(a), 0, Math.sin(a)],
        up: [-Math.sin(h) * Math.sin(a), Math.cos(h), Math.sin(h) * Math.cos(a)]
    };
}

// A unit quad with room for per-instance attributes
export function instancedQuad(count) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.instanceCount = count;
    return geometry;
}

export function smoothstep(lo, hi, x) {
    const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
    return t * t * (3 - 2 * t);
}

// ---------- A pulsar's spin, the same on the sky (neutron_stars.js) and up close (system/remnants.js) ----------
//
// The rule for how fast a pulsar is shown turning, the same in both views, which show the same turn at the same moment:
//   - Each turns at its true rate, between PULSE_SHOWN_HZ.min and .max turns a second (0.1 to 10 Hz, from
//     data/deep_sky.js, which draws every pulsar's rate inside that). On the sky one turn is one pulse, as the beam
//     crosses our line of sight: a small point, which may flash that fast.
//   - Up close a beam sweeps over a large part of the screen, and three flashes a second over a wide area is the most
//     photosensitive viewers can take. The beams are drawn at their full brightness, just as they were, for as long as
//     they're short enough on the screen for that to hold: how long depends on how fast they turn and where they're seen
//     from (closeTurningShare), and most turning up to about 3 times a second arrive at full brightness. Longer than that,
//     as the zoom makes them, the turning beams dim only as much as they have to, and the rest of their light is their
//     sweep blurred into the cones they trace, as the eye sees a fast lighthouse: still turning at the true rate. No
//     faster than SPIN_SHOWN, a beam can be any length.
//   - The sky's beams are as they were while they're small, and at every size for a pulsar turning up to SKY_FLICKER_HZ
//     times a second: each spot of the sky one passes is lit once a turn, which is three flashes a second at most. Turning
//     faster, a beam does that over all it sweeps, and as a zoom makes it bigger, that grows as its size squared, to twice
//     the most allowed at the deepest zoom. So from SKY_SWEEP_PX[0] to [1], its half-size in CSS pixels, the sky's beams
//     go over to the close-up's way, their turning light down to the close-up's share and the rest their blurred sweep,
//     ready for the system view to take over. Bigger than that, as at the deepest zoom or on a big screen, the turning
//     light falls on as the square of the size, so the area it flashes over grows no more. The pulse itself, a small
//     bright point, keeps flashing at the true rate.
//   - With Reduce motion nothing turns: the beam holds still at HELD_ANGLE, seen side-on, and the light is steady.
// The angle at a moment is turns a second x the shared clock (sharedUniforms.uTime) plus the pulsar's own start, so a
// pulse on the sky is the beam pointing at the camera in the system view, and zooming in keeps the phase.
export const SPIN_SHOWN = 0.6;
export const FLICKER_HZ = 1;
export const FAST_SHARE = 0.3;             // The soft beam peaks at 0.284 luminance: 0.3 of that is 0.085
export const HELD_ANGLE = 1.3;
export const PULSAR_BEAM_SLOPE = 0.13;     // A beam's half-width per unit of its length, in both views
export const SWEEP_SAMPLES = 24;           // Beam directions the blurred sweep is the average of
// Measured on the sky at 1024 x 768, at the deepest zoom (a half-size of about 207 px), whole beams flash over 2,700 px
// turning once a second, 6,000 at 2 and 2.5, 8,700 at 2.99, then 46,700 at 3.5 and 40,000-48,000 up to 10. Turning
// faster than 3 a second they flash over 1 to 1.2 times their half-size squared: 7,200 px at 83 px, 16,500 at 127,
// 22,000 at 150 for one turning 10 times a second, 14,800 at 110 for one turning 5.5 times.
export const SKY_FLICKER_HZ = 3;
export const SKY_SWEEP_PX = [80, 170];

// The turns a second a pulsar is shown at, from its true period
export function shownRate(periodS) {
    if (!periodS) return 0;
    return Math.max(PULSE_SHOWN_HZ.min, Math.min(PULSE_SHOWN_HZ.max, 1 / periodS));
}

// How long a beam can be on the screen, up close, and still turn at full brightness, in CSS pixels, from its star to where
// its light ends. Two things set it, both measured on the real picture at 1024 x 768 in radio (the brightest band), forcing
// the rate and the brightness, so that no more than CLOSE_AIM_PX flashes more than 3 times a second in any 10 degree field
// and no more than 2 large-area flashes come in a second:
//   - The beam sweeping over more of the whole screen at a time than is allowed, up and down: BEAM_FLASH_PX, by rate.
//   - The area each spot of which is lit often enough to count as flashing, which goes as the beam's length squared. A spot
//     has to be crossed at least 3.5 / rate times a turn for that: from 3.5 turns a second once is enough, which is everything
//     the beams sweep. Below that it takes twice: spots swept by both beams, or by a beam on its way out and on its way back,
//     which comes down to where the view is from. CLOSE_TWICE gives that area per sin^2(tilt) when the beam is 372 px long, by
//     tan(view angle) / tan(tilt), view angle being from the spin axis to the camera. It's biggest looking along the
//     axis, where both beams sweep the same disc, and vanishes with the beam's tilt and the view the same, where they don't.
//     So a student orbiting to look down the axis, at any zoom, is covered too.
const CLOSE_AIM_PX = 11500;                 // 53% of the 21,824 px allowed, so that the worst tilt and view measured stay near 60%
const BEAM_REF_PX = 372;
const BEAM_FLASH_PX = [[0.75, 1000], [1, 750], [1.25, 650], [1.5, 235], [1.75, 300], [2, 520], [3, 470], [4, 400]];
const CLOSE_TWICE = [[0, 100], [0.35, 75], [0.5, 55], [0.7, 19], [0.9, 3], [1.4, 3], [2, 34], [2.7, 72]];   // Thousands of px
const CLOSE_EDGE_ON = 28;                   // Thousands of px crossed twice a turn seen edge-on, at any tilt
const CLOSE_ONCE = 109;                     // Thousands of px crossed once a turn, at the worst tilt and view measured
const TWICE_BY_RATE = [[1.5, 0], [1.75, 1], [2.5, 1], [3, 1.27]];
export const CLOSE_TURNING_LIGHT = 0.021;   // 0.15 of the radio beam's light, the brightest band's
const RADIO_BEAM_LIGHT = 0.142;

function tableAt(table, x) {
    if (x <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
        if (x <= table[i][0]) return table[i - 1][1] + ((table[i][1] - table[i - 1][1]) * (x - table[i - 1][0])) / (table[i][0] - table[i - 1][0]);
    }
    return table[table.length - 1][1];
}

// The longest the beams can be on the screen and still be whole: light is how bright they are (remnants.js, setBand), tilt
// the beam's from the spin axis and cosView the cosine of the angle from the spin axis to the camera
function closeFullPx(rate, light, tilt, cosView) {
    const sin2 = Math.sin(tilt) ** 2;
    const c = Math.min(Math.abs(cosView), 1);
    const t = Math.sqrt(1 - c * c) / Math.max(c, 1e-3) / Math.tan(tilt);
    // Seen edge-on a beam goes to and fro over the same strip whatever its tilt, so a small tilt doesn't save it there
    const twice = Math.max(sin2 * tableAt(CLOSE_TWICE, t), CLOSE_EDGE_ON * smoothstep(2.5, 5, t));
    const area = 1000 * (twice * tableAt(TWICE_BY_RATE, rate) * (1 - smoothstep(3, 3.5, rate)) + CLOSE_ONCE * smoothstep(3, 3.5, rate))
        * Math.pow(Math.min(1, light / RADIO_BEAM_LIGHT), 1.25);    // A dimmer beam, as in X-rays, flashes over less of the screen
    return Math.min(tableAt(BEAM_FLASH_PX, rate), area > 0 ? BEAM_REF_PX * Math.sqrt(CLOSE_AIM_PX / area) : Infinity);
}

// The share of a close beam's light that turns, with the beams lengthPx long on the screen (CSS pixels), light the luminance
// of their colour times its strength, and tilt and cosView as above. No slower than SPIN_SHOWN turns a second, 1 at any size.
export function closeTurningShare(rate, lengthPx, light, tilt, cosView) {
    if (rate <= SPIN_SHOWN) return 1;
    const full = closeFullPx(rate, light, tilt, cosView);
    if (lengthPx <= full) return 1;
    // Past that it dims as its length grows: as one over its length turning once a turn is enough, which holds the area it
    // flashes over, and faster where spots must be crossed twice, where the two sweeps are wider apart. There's no need to go
    // below CLOSE_TURNING_LIGHT, or SPIN_SHOWN / rate if it turns no faster than FLICKER_HZ: too faint to flash over a wide
    // area at any size. All the rest of its light goes into its blurred sweep.
    const least = rate > FLICKER_HZ ? Math.min(1, CLOSE_TURNING_LIGHT / Math.max(light, 1e-3)) : SPIN_SHOWN / rate;
    return Math.max(least, Math.pow(full / lengthPx, 1.6 - 0.6 * smoothstep(3, 3.5, rate)));
}

// On the sky, the share that turns once the beams are SKY_SWEEP_PX[1] big (and less beyond); 1 for one that never blurs
export function skyTurningShare(rate) {
    return rate > SKY_FLICKER_HZ ? FAST_SHARE : 1;
}
// Everything both views need to draw one pulsar's spin, from its own stream (rng = bodyRng(body, 'pulsar'), read in this
// order, which the sky layer goes on reading after). In the frame of the view at the pulsar: x right, y up, z towards us.
// The spin axis is tilted from our line of sight by the beam's own tilt, so the beam sweeps across us once a turn.
export function pulsarSpin(body, rng) {
    const info = body.neutron_star;
    // Very small tilts are drawn a little larger, or the beam would never be seen side-on
    const tilt = Math.max(24, Math.min(80, info.magnetic_tilt_deg ?? rng.range(30, 62))) * DEG;
    const roll = rng.range(0, Math.PI * 2);
    const rate = info.pulsar ? shownRate(info.pulse_period_s) : 0;
    const phase = rng.range(0, Math.PI * 2);
    const axis = [Math.sin(tilt) * Math.cos(roll), Math.sin(tilt) * Math.sin(roll), Math.cos(tilt)];
    // At angle 0 the beam points straight at us: e1 is the part of the line of sight square to the spin axis
    const e1 = [-axis[0] * Math.cos(tilt) / Math.sin(tilt), -axis[1] * Math.cos(tilt) / Math.sin(tilt), (1 - axis[2] * Math.cos(tilt)) / Math.sin(tilt)];
    const e2 = [axis[1] * e1[2] - axis[2] * e1[1], axis[2] * e1[0] - axis[0] * e1[2], axis[0] * e1[1] - axis[1] * e1[0]];
    return { tilt, roll, rate, depth: info.pulsar ? 1 : 0, phase, axis, e1, e2 };
}

// The beam's angle round the spin axis at a time on the shared clock, as the sky's shader works it out
export function pulsarAngle(spin, timeS, still) {
    return still ? HELD_ANGLE : spin.rate * timeS * Math.PI * 2 + spin.phase;
}

// Where the beam points at that angle, in the same frame as spin.axis
export function pulsarBeam(spin, angle, out = [0, 0, 0]) {
    const c = Math.cos(spin.tilt);
    const s = Math.sin(spin.tilt);
    for (let i = 0; i < 3; i++) out[i] = spin.axis[i] * c + (spin.e1[i] * Math.cos(angle) + spin.e2[i] * Math.sin(angle)) * s;
    return out;
}

// A tiling noise texture, baked once, so the shaders pay one texture read per octave group instead of doing the
// noise sums themselves. Mipmapped, so fine detail fades away cleanly when an object is small on screen.
// R: soft clouds. G: ridged filaments. B: fine grain. A: soft clouds again, unrelated to R.
let noiseTexture = null;

export function exoticNoise() {
    if (noiseTexture) return noiseTexture;
    const size = 256;
    const data = new Uint8Array(size * size * 4);
    const rng = new Rng('exotic-noise');
    const sum = new Float32Array(size * size);
    const channels = [
        { period: 4, octaves: 5, ridged: false },
        { period: 8, octaves: 4, ridged: true },
        { period: 24, octaves: 3, ridged: false },
        { period: 6, octaves: 5, ridged: false }
    ];
    channels.forEach((spec, c) => {
        sum.fill(0);
        let amp = 1;
        let period = spec.period;
        for (let o = 0; o < spec.octaves; o++) {
            const lattice = new Float32Array(period * period);
            for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();
            for (let y = 0; y < size; y++) {
                const fy = (y / size) * period;
                const y0 = Math.floor(fy);
                const y1 = (y0 + 1) % period;
                const ty = fy - y0;
                const sy = ty * ty * (3 - 2 * ty);
                for (let x = 0; x < size; x++) {
                    const fx = (x / size) * period;
                    const x0 = Math.floor(fx);
                    const x1 = (x0 + 1) % period;
                    const tx = fx - x0;
                    const sx = tx * tx * (3 - 2 * tx);
                    const top = lattice[y0 * period + x0] * (1 - sx) + lattice[y0 * period + x1] * sx;
                    const bottom = lattice[y1 * period + x0] * (1 - sx) + lattice[y1 * period + x1] * sx;
                    let v = top * (1 - sy) + bottom * sy;
                    if (spec.ridged) v = 1 - Math.abs(2 * v - 1);
                    sum[y * size + x] += amp * v;
                }
            }
            amp *= 0.55;
            period *= 2;
        }
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < sum.length; i++) {
            if (sum[i] < lo) lo = sum[i];
            if (sum[i] > hi) hi = sum[i];
        }
        for (let i = 0; i < sum.length; i++) data[i * 4 + c] = Math.round((255 * (sum[i] - lo)) / (hi - lo));
    });
    noiseTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    noiseTexture.wrapS = THREE.RepeatWrapping;
    noiseTexture.wrapT = THREE.RepeatWrapping;
    noiseTexture.minFilter = THREE.LinearMipmapLinearFilter;
    noiseTexture.magFilter = THREE.LinearFilter;
    noiseTexture.generateMipmaps = true;
    noiseTexture.needsUpdate = true;
    return noiseTexture;
}
