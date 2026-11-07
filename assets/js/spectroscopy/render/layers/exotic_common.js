// Small helpers shared by the black hole, neutron star, comet and binary layers.

import * as THREE from 'three';
import { azAltToVec3 } from '../../core/sky.js';
import { hashString, Rng } from '../../core/rng.js';

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
