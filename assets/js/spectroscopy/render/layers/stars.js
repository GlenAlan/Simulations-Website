// FOUNDATION STUB, replaced by the sky-core track: GPU point sprites for everything that looks like a point
// in the sky. Colour from temperature, brightness from magnitude, drawn only down to the zoom's limiting magnitude.

import * as THREE from 'three';
import { azAltToVec3 } from '../../core/sky.js';
import { blackBodyRGB } from '../../core/phys.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';

const POINT_KINDS = ['star', 'binary', 'multiple', 'neutron_star', 'black_hole', 'quasar', 'rogue_planet', 'home_planet', 'supernova'];

function bodyTemperature(body) {
    if (body.star) return body.star.teff_K;
    if (body.stars) return body.stars[0].star.teff_K;
    if (body.black_hole) return body.black_hole.companion.star.teff_K;
    if (body.kind === 'quasar') return 20000;
    if (body.kind === 'neutron_star') return 30000;
    return 6000;
}

export function createStarsLayer(engine, app) {
    const bodies = app.universe.bodies.filter((b) => POINT_KINDS.includes(b.kind));
    const n = bodies.length;
    const positions = new Float32Array(n * 3);
    const colours = new Float32Array(n * 3);
    const mags = new Float32Array(n);
    const bandA = new Float32Array(n * 4);
    const bandB = new Float32Array(n);
    bodies.forEach((body, i) => {
        const v = azAltToVec3(body.sky.az, body.sky.alt);
        positions.set([v[0] * 1000, v[1] * 1000, v[2] * 1000], i * 3);
        colours.set(blackBodyRGB(bodyTemperature(body)), i * 3);
        mags[i] = body.brightness.mag;
        bandA.set([body.bands.radio, body.bands.ir, body.bands.visible, body.bands.uv], i * 4);
        bandB[i] = body.bands.xray;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColour', new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute('aMag', new THREE.BufferAttribute(mags, 1));
    geometry.setAttribute('aBandA', new THREE.BufferAttribute(bandA, 4));
    geometry.setAttribute('aBandB', new THREE.BufferAttribute(bandB, 1));

    const material = skyMaterial({
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            attribute vec3 aColour;
            attribute float aMag;
            attribute vec4 aBandA;
            attribute float aBandB;
            varying vec3 vColour;
            varying float vGlow;
            void main() {
                float visible = uBandW[2];
                // Above the limit: brighter than the sky. In other bands the mag is meaningless, so use the band alone
                float m = clamp(pow(10.0, -0.4 * (aMag - uLimitMag)), 0.0, 400.0);
                float visAmount = aBandA.z * m;
                float other = aBandA.x * uBandW[0] + aBandA.y * uBandW[1] + aBandA.w * uBandW[3] + aBandB * uBandW[4];
                vGlow = visAmount * visible + other * 20.0;
                vColour = bandColour(aColour);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_PointSize = clamp(2.0 + sqrt(vGlow) * 1.6, 0.0, 28.0);
                if (vGlow < 0.05) gl_PointSize = 0.0;
            }`,
        fragmentShader: /* glsl */`
            varying vec3 vColour;
            varying float vGlow;
            void main() {
                float r = length(gl_PointCoord - 0.5) * 2.0;
                float glow = exp(-r * r * 5.0);
                gl_FragColor = vec4(vColour * glow * min(vGlow, 3.0), 1.0);
            }`
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = ORDER.stars;
    engine.scene.add(points);
    return { id: 'stars', update() {} };
}
