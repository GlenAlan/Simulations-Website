// A faint copy of the sky behind a system: the catalogue's own objects at their real directions, some field stars and
// the galactic band, on a sphere that turns as the camera orbits. The real sky is switched off in the system view,
// so it costs almost nothing, and it can't show its horizon. It belongs to the view and never changes the sky.

import * as THREE from 'three';
import { azAltToVec3, GALACTIC_POLE } from '../../core/sky.js';
import { blackBodyRGB } from '../../core/phys.js';
import { Rng } from '../../core/rng.js';
import { sharedUniforms, BAND_GLSL } from '../shared.js';
import { NOISE_GLSL, TRUE_COLOUR, getNoiseTexture } from './star_surface.js';

function bodyTemperature(body) {
    if (body.star) return body.star.teff_K;
    if (body.stars) return body.stars[0].star.teff_K;
    if (body.black_hole) return body.black_hole.companion.star.teff_K;
    if (body.kind === 'quasar' || body.kind === 'neutron_star') return 20000;
    return 6500;
}

const FIELD_COUNT = { low: 1200, medium: 2800, high: 5200 };

const STAR_VERTEX = /* glsl */`
${BAND_GLSL}
attribute vec3 aColour;
attribute float aSize;
attribute float aBright;
attribute vec4 aBandA;
attribute float aBandB;
uniform float uFade;
uniform float uZoom;
uniform float uDpr;
varying vec3 vColour;
varying float vBright;
void main() {
    // Directions only: rotate by the camera but never translate, so these stay infinitely far away
    vec3 v = mat3(viewMatrix) * mat3(modelMatrix) * position;
    vec4 clip = projectionMatrix * vec4(v, 1.0);
    clip.xy *= uZoom;
    clip.z = clip.w * 0.99999;
    gl_Position = clip;
    vColour = bandColour(aColour);
    vBright = aBright * bandAmount(aBandA, aBandB) * uFade;
    gl_PointSize = vBright > 0.004 ? aSize * uDpr : 0.0;
}`;

const STAR_FRAGMENT = /* glsl */`
varying vec3 vColour;
varying float vBright;
void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float g = exp(-r * r * 3.6);
    gl_FragColor = vec4(vColour * g * vBright, 1.0);
}`;

const BAND_VERTEX = /* glsl */`
uniform float uZoom;
varying vec3 vDir;
void main() {
    vDir = position;
    vec3 v = mat3(viewMatrix) * mat3(modelMatrix) * position;
    vec4 clip = projectionMatrix * vec4(v, 1.0);
    clip.xy *= uZoom;
    clip.z = clip.w * 0.99999;
    gl_Position = clip;
}`;

const BAND_FRAGMENT = /* glsl */`
${BAND_GLSL}
${NOISE_GLSL}
uniform vec3 uPole;
uniform float uFade;
varying vec3 vDir;
void main() {
    vec3 d = normalize(vDir);
    float s = dot(d, uPole);    // Sine of galactic latitude
    float a = exp(-s * s * 26.0);
    float dust = fbm3(d * 3.4 + 5.0);
    float lane = smoothstep(0.34, 0.62, dust) * exp(-s * s * 180.0);
    float glow = a * (0.5 + 0.8 * fbm3(d * 6.0 + 21.0)) * (1.0 - lane * 0.8);
    gl_FragColor = vec4(bandColour(vec3(0.72, 0.76, 1.0)) * glow * 0.032 * uFade, 1.0);
}`;

// The same night as the sky's, at half its strength: never a black void, whatever the quality
const FLOOR_FRAGMENT = /* glsl */`
uniform float uFade;
void main() {
    gl_FragColor = vec4(vec3(0.0021, 0.0037, 0.0100) * uFade, 1.0);
}`;
const FLOOR_VERTEX = 'void main(){ gl_Position = vec4(position.xy, 0.99999, 1.0); }';

export function createBackdrop(app, quality = 'medium') {
    const bodies = app.universe.bodies.filter((b) => b.sky && b.bands);
    const fieldCount = FIELD_COUNT[quality] || FIELD_COUNT.medium;
    const n = bodies.length + fieldCount;
    const position = new Float32Array(n * 3);
    const colour = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const bright = new Float32Array(n);
    const bandA = new Float32Array(n * 4);
    const bandB = new Float32Array(n);

    bodies.forEach((body, i) => {
        position.set(azAltToVec3(body.sky.az, body.sky.alt), i * 3);
        colour.set(blackBodyRGB(bodyTemperature(body)), i * 3);
        const mag = body.brightness ? body.brightness.mag : 12;
        const k = Math.min(1, 10 ** (-0.22 * (mag - 2)));
        size[i] = 1.8 + k * 3.2;
        bright[i] = Math.min(1.2, (0.1 + k * 0.85) * 1.5);
        bandA.set([body.bands.radio || 0, body.bands.ir || 0, body.bands.visible || 0, body.bands.uv || 0], i * 4);
        bandB[i] = body.bands.xray || 0;
    });

    // Field stars for depth, more of them along the band
    const rng = new Rng('system-backdrop');
    const pole = azAltToVec3(GALACTIC_POLE.az, GALACTIC_POLE.alt);
    for (let j = 0; j < fieldCount; j++) {
        const i = bodies.length + j;
        let v;
        do {
            const y = rng.range(-1, 1);
            const a = rng.range(0, Math.PI * 2);
            const c = Math.sqrt(1 - y * y);
            v = [c * Math.cos(a), y, c * Math.sin(a)];
        } while (rng.next() > 0.25 + Math.exp(-((v[0] * pole[0] + v[1] * pole[1] + v[2] * pole[2]) ** 2) * 30));
        position.set(v, i * 3);
        colour.set(blackBodyRGB(rng.logRange(3000, 16000)), i * 3);
        size[i] = rng.range(1.1, 2.1);
        bright[i] = rng.range(0.075, 0.6) * rng.next();
        bandA.set([0.02, 0.5, 1, 0.3], i * 4);
        bandB[i] = 0.03;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aColour', new THREE.BufferAttribute(colour, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geometry.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
    geometry.setAttribute('aBandA', new THREE.BufferAttribute(bandA, 4));
    geometry.setAttribute('aBandB', new THREE.BufferAttribute(bandB, 1));

    const shared = {
        uFade: { value: 0 },
        uZoom: { value: 1 },
        uDpr: { value: 1 }
    };
    const material = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: STAR_VERTEX,
        fragmentShader: STAR_FRAGMENT,
        uniforms: { ...sharedUniforms, ...TRUE_COLOUR, ...shared }
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 1;

    // The field stars are scenery, and follow the sky's own switch for scenery. The catalogue's objects always show.
    const showFieldStars = (on) => geometry.setDrawRange(0, on ? n : bodies.length);
    showFieldStars(app.layers.backgroundStars !== false);

    const bandGeometry = new THREE.SphereGeometry(1, 40, 24);
    const bandMaterial = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        vertexShader: BAND_VERTEX,
        fragmentShader: BAND_FRAGMENT,
        uniforms: {
            ...sharedUniforms,
            ...TRUE_COLOUR,
            ...shared,
            tNoise: { value: getNoiseTexture() },
            uPole: { value: new THREE.Vector3(...pole) }
        }
    });
    const band = new THREE.Mesh(bandGeometry, bandMaterial);
    band.frustumCulled = false;
    band.renderOrder = 0;
    band.visible = quality !== 'low';

    const floorGeometry = new THREE.PlaneGeometry(2, 2);
    const floorMaterial = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: FLOOR_VERTEX,
        fragmentShader: FLOOR_FRAGMENT,
        uniforms: { uFade: shared.uFade }
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.frustumCulled = false;
    floor.renderOrder = -1;

    const group = new THREE.Group();
    group.add(floor, band, points);

    return {
        group,
        set(fade, zoom, dpr) {
            shared.uFade.value = fade;
            shared.uZoom.value = zoom;
            shared.uDpr.value = dpr;
            group.visible = fade > 0.002;
        },
        // Which way the catalogue's directions point in the system's world
        setOrientation(q) { group.quaternion.copy(q); },
        setQuality(q) { band.visible = q !== 'low'; },
        showFieldStars,
        dispose() {
            geometry.dispose();
            material.dispose();
            bandGeometry.dispose();
            bandMaterial.dispose();
            floorGeometry.dispose();
            floorMaterial.dispose();
        }
    };
}
