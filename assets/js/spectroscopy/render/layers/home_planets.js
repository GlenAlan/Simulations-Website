// The seven home planets: bright steady points that don't twinkle, as real planets don't, each with its own colour.
// They grow into small discs as you zoom in, with bands on the giants and a ring on Saturn. This layer alone draws
// them (stars.js leaves them out) and it honours the Home planets switch in the Layers menu.

import * as THREE from 'three';
import { bus } from '../../core/state.js';
import { BANDS } from '../../core/bands.js';
import { azAltToVec3 } from '../../core/sky.js';
import { bandSkyBrightness } from '../../data/band_table.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { MIN_GLOW } from '../engine.js';

const SKY_RADIUS = 1000;

// Linear colours. Relative disc size is stylised (true sizes would all be invisible).
const LOOKS = {
    Mercury: { colour: [0.72, 0.62, 0.52], disc: 0.42, band: 0, ring: 0 },
    Venus: { colour: [1.00, 0.90, 0.68], disc: 0.72, band: 0, ring: 0 },
    Mars: { colour: [1.00, 0.42, 0.20], disc: 0.52, band: 0, ring: 0 },
    Jupiter: { colour: [1.00, 0.84, 0.66], disc: 1.00, band: 1, ring: 0 },
    Saturn: { colour: [1.00, 0.86, 0.56], disc: 0.84, band: 0.6, ring: 1 },
    Uranus: { colour: [0.56, 0.90, 0.95], disc: 0.52, band: 0, ring: 0 },
    Neptune: { colour: [0.32, 0.50, 1.00], disc: 0.48, band: 0.15, ring: 0 }
};

export function createHomePlanetsLayer(engine, app) {
    const bodies = app.universe.bodies.filter((b) => b.kind === 'home_planet');
    const n = bodies.length;
    const centres = new Float32Array(n * 3);
    const colours = new Float32Array(n * 3);
    const shape = new Float32Array(n * 3);      // Disc scale, banding, ring
    const bandA = new Float32Array(n * 4);
    const bandB = new Float32Array(n);
    bodies.forEach((body, i) => {
        const v = azAltToVec3(body.sky.az, body.sky.alt);
        const look = LOOKS[body.name] || { colour: [1, 1, 1], disc: 0.5, band: 0, ring: 0 };
        centres.set([v[0] * SKY_RADIUS, v[1] * SKY_RADIUS, v[2] * SKY_RADIUS], i * 3);
        colours.set(look.colour, i * 3);
        shape.set([look.disc, look.band, look.ring], i * 3);
        const glow = BANDS.map((band) => bandSkyBrightness(body, band));
        bandA.set(glow.slice(0, 4), i * 4);
        bandB[i] = glow[4];
    });

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(centres, 3));
    geometry.setAttribute('aColour', new THREE.InstancedBufferAttribute(colours, 3));
    geometry.setAttribute('aShape', new THREE.InstancedBufferAttribute(shape, 3));
    geometry.setAttribute('aBandA', new THREE.InstancedBufferAttribute(bandA, 4));
    geometry.setAttribute('aBandB', new THREE.InstancedBufferAttribute(bandB, 1));
    geometry.instanceCount = n;

    const material = skyMaterial({
        uniforms: { uDpr: { value: 1 } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            attribute vec3 aCentre;
            attribute vec3 aColour;
            attribute vec3 aShape;
            attribute vec4 aBandA;
            attribute float aBandB;
            uniform float uDpr;
            varying vec2 vPx;
            varying vec3 vColour;
            varying vec4 vLook;     // Disc radius (device px), banding, ring, glow strength
            varying float vFill;    // Brightness of the disc itself
            varying float vQuad;
            void main() {
                float glow = clamp(bandAmount(aBandA, aBandB) * pow(10.0, 0.4 * (uLimitMag - 6.0)), 0.0, 400.0);
                if (glow < ${MIN_GLOW.toFixed(3)} || uSkyFade <= 0.0) {
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    return;
                }
                // Magnitudes above where it starts to be drawn: 0 up to about 9.75
                float m = max(1.0857 * log(glow) + 3.25, 0.0);
                float shown = smoothstep(0.0, 2.2, m) * uSkyFade;
                // A small steady disc at any zoom, growing as a telescope would show it
                float grow = clamp(pow(80.0 / uFov, 0.52), 1.0, 22.0);
                float radius = (0.72 + 0.085 * m) * mix(1.0, aShape.x, 0.75) * grow * uDpr;
                vFill = (0.5 + 0.34 * pow(10.0, 0.11 * m)) * shown / (1.0 + 0.06 * grow * grow);
                vLook = vec4(radius, aShape.y, aShape.z, (0.02 + 0.0065 * m * m) * shown);
                vColour = bandColour(aColour);
                vQuad = radius * (aShape.z > 0.5 ? 2.5 : 1.2) + (4.0 + 2.2 * m) * uDpr;
                vPx = position.xy * vQuad;
                vec4 clip = projectionMatrix * modelViewMatrix * vec4(aCentre, 1.0);
                clip.xy += vPx * 2.0 / uViewport * clip.w;
                gl_Position = clip;
            }`,
        fragmentShader: /* glsl */`
            varying vec2 vPx;
            varying vec3 vColour;
            varying vec4 vLook;
            varying float vFill;
            varying float vQuad;
            void main() {
                float radius = vLook.x;
                float r = length(vPx);
                if (r >= vQuad) discard;
                float inside = clamp(radius - r + 0.5, 0.0, 1.0);
                vec3 surface = vColour;
                if (radius > 3.0) {
                    float x = r / radius;
                    // Darker at the edge, like any lit globe seen whole, with bands across the giants
                    float limb = sqrt(max(1.0 - x * x * 0.82, 0.0));
                    float y = vPx.y * 0.97 + vPx.x * 0.12;
                    float bands = 1.0 + vLook.y * 0.22 * sin(y / radius * 9.0) * smoothstep(3.0, 8.0, radius);
                    surface *= limb * bands;
                }
                vec3 col = surface * vFill * inside;
                if (vLook.z > 0.5 && radius > 2.2) {
                    // Saturn's ring, tilted towards us
                    float tilt = dot(vPx, vec2(0.9553, 0.2955));
                    float across = dot(vPx, vec2(-0.2955, 0.9553));
                    float e = length(vec2(tilt, across * 3.1)) / radius;
                    float ring = smoothstep(1.32, 1.38, e) * smoothstep(2.32, 2.22, e);
                    ring *= 0.72 + 0.28 * sin(e * 30.0);
                    float infront = across < 0.0 || r > radius ? 1.0 : 0.0;
                    col += vColour * ring * vFill * 0.62 * infront * smoothstep(2.2, 4.0, radius);
                }
                float u = r / vQuad;
                float window = (1.0 - u * u);
                window *= window;
                float halo = vLook.w / pow(1.0 + r * r / (radius * radius * 3.5 + 1.0), 1.5) * window;
                gl_FragColor = vec4(col + vColour * halo, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.stars + 2;
    mesh.visible = app.layers.homePlanets;
    engine.scene.add(mesh);

    const unbind = bus.on('layer', ({ name, on }) => {
        if (name === 'homePlanets') mesh.visible = on;
    });

    return {
        id: 'home_planets',
        update(frame) {
            material.uniforms.uDpr.value = frame.dpr;
        },
        dispose() {
            unbind();
            engine.scene.remove(mesh);
            geometry.dispose();
            material.dispose();
        }
    };
}
