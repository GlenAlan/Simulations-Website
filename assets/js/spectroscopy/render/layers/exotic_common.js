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
//   - Each turns at its true rate, kept between PULSE_SHOWN_HZ.min and .max turns a second (0.1 to 10 Hz, from
//     data/deep_sky.js). Most real pulsars are inside that. A young or millisecond one turns faster, and is shown at 10 a
//     second; the Pulse timing tool and the Info tab give its true period, and say so. On the sky one turn is one pulse, as
//     the beam crosses our line of sight: a small point, which may flash that fast.
//   - Up close a beam sweeps over a large part of the screen, and three changes a second over a wide area is the most
//     photosensitive viewers can take. Zoomed in, the soft beam in system/remnants.js does that 1.5 times a second at
//     0.6 turns a second, but 4 times at 0.75 and 8 at 1. So up to SPIN_SHOWN turns a second the close beams are drawn
//     just as they were. Above it the turning beams fade, to SPIN_SHOWN / rate of their light, and the rest of it is their
//     sweep blurred into the cones they trace, as the eye sees a fast lighthouse: still turning at the true rate, but
//     changing the screen from one frame to the next no more than at SPIN_SHOWN.
//   - Each spot a close beam passes also brightens and dims about 2.8 times a turn, so above FLICKER_HZ turns a second
//     those spots would flash more than three times a second. There the turning light is FAST_SHARE of it, too faint to
//     count as a flash anywhere (under a tenth of full brightness), and still enough to be seen turning.
//   - The sky's beams, small, are as they were at every rate.
//   - With Reduce motion nothing turns: the beam holds still at HELD_ANGLE, seen side-on, and the light is steady.
// The angle at a moment is turns a second x the shared clock (sharedUniforms.uTime) plus the pulsar's own start, so a
// pulse on the sky is the beam pointing at the camera in the system view, and zooming in keeps the phase.
export const SPIN_SHOWN = 0.6;
export const FLICKER_HZ = 1;
export const FAST_SHARE = 0.3;             // The soft beam peaks at 0.284 luminance: 0.3 of that is 0.085
export const HELD_ANGLE = 1.3;
export const PULSAR_BEAM_SLOPE = 0.13;     // A beam's half-width per unit of its length, in both views
export const SWEEP_SAMPLES = 24;           // Beam directions the blurred sweep is the average of

// The turns a second a pulsar is shown at, from its true period
export function shownRate(periodS) {
    if (!periodS) return 0;
    return Math.max(PULSE_SHOWN_HZ.min, Math.min(PULSE_SHOWN_HZ.max, 1 / periodS));
}

// Up close, the share of the beams' light that turns at that rate; the rest is their blurred sweep
export function turningShare(rate) {
    if (rate <= SPIN_SHOWN) return 1;
    return rate <= FLICKER_HZ ? SPIN_SHOWN / rate : FAST_SHARE;
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
    return { tilt, roll, rate, depth: info.pulsar ? 1 : 0, spin: turningShare(rate), phase, axis, e1, e2 };
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
