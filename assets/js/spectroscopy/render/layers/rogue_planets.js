// Rogue planets show only in the infrared: a faint warm point at wide zoom. Zoomed far in, the point opens into a dark
// sphere, lit only by its own heat around the rim. It blocks the glow behind it, so it isn't purely additive.

import * as THREE from 'three';
import { azAltToVec3 } from '../../core/sky.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';

const SKY_RADIUS = 1000;

export function createRoguePlanetsLayer(engine, app) {
    const bodies = app.universe.bodies.filter((b) => b.kind === 'rogue_planet');
    const n = bodies.length;
    const centres = new Float32Array(n * 3);
    const look = new Float32Array(n * 3);   // Strength, size (0..1), warmth (0..1)
    bodies.forEach((body, i) => {
        const v = azAltToVec3(body.sky.az, body.sky.alt);
        centres.set([v[0] * SKY_RADIUS, v[1] * SKY_RADIUS, v[2] * SKY_RADIUS], i * 3);
        const rogue = body.rogue_planet || {};
        const size = Math.min(1, Math.log10(Math.max(1, rogue.radius_Rearth || 2)) / Math.log10(12));
        const warmth = Math.min(1, Math.max(0, ((rogue.teff_K || 100) - 40) / 360));
        look.set([body.bands.ir, size, warmth], i * 3);
    });

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(centres, 3));
    geometry.setAttribute('aLook', new THREE.InstancedBufferAttribute(look, 3));
    geometry.instanceCount = n;

    const material = skyMaterial({
        // Premultiplied: the colour adds as light does, while alpha lets the dark disc cover what's behind it
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        uniforms: { uDpr: { value: 1 } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            attribute vec3 aCentre;
            attribute vec3 aLook;
            uniform float uDpr;
            varying vec2 vPx;
            varying vec3 vColour;
            varying vec3 vShape;    // Disc radius (device px), glow radius, opening (0 a point, 1 a sphere)
            varying float vAmount;
            varying float vQuad;
            void main() {
                float amount = aLook.x * uBandW[1] * uSkyFade;
                if (amount <= 0.001) {
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    return;
                }
                float open = smoothstep(9.0, 2.2, uFov);
                float radius = mix(0.0, (5.0 + 16.0 * aLook.y) * pow(9.0 / max(uFov, 0.4), 0.42), open) * uDpr;
                float glow = (1.2 + 0.9 * aLook.y) * uDpr;
                vQuad = radius * 1.5 + glow * 5.0;
                vShape = vec3(radius, glow, open);
                vAmount = amount;
                // Warm against the band's false colour: the warmer the world, the more it leans to orange
                vColour = mix(uBandTint[1], vec3(1.0, 0.52, 0.22), 0.35 + 0.5 * aLook.z);
                vPx = position.xy * vQuad;
                vec4 clip = projectionMatrix * modelViewMatrix * vec4(aCentre, 1.0);
                clip.xy += vPx * 2.0 / uViewport * clip.w;
                gl_Position = clip;
            }`,
        fragmentShader: /* glsl */`
            varying vec2 vPx;
            varying vec3 vColour;
            varying vec3 vShape;
            varying float vAmount;
            varying float vQuad;
            void main() {
                float r = length(vPx);
                if (r >= vQuad) discard;
                float radius = vShape.x;
                float outside = max(r - radius, 0.0);
                float u = r / vQuad;
                float window = 1.0 - u * u;
                window *= window;
                float glow = exp(-outside * outside / (2.0 * vShape.y * vShape.y));
                vec3 col = vColour * glow * window * mix(0.95, 0.62, vShape.z) * vAmount;
                float alpha = 0.0;
                if (radius > 0.5) {
                    float inside = clamp(radius - r + 0.5, 0.0, 1.0);
                    // A nearly black disc with its own heat showing as a thin bright limb
                    float x = min(r / radius, 1.0);
                    float rim = pow(x, 7.0);
                    float nightSide = 0.012 + 0.02 * (1.0 - x * x);
                    col = mix(col, vColour * (nightSide + rim * 0.55) * (0.5 + vAmount), inside);
                    alpha = inside * vShape.z;
                }
                gl_FragColor = vec4(col, alpha);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = ORDER.stars + 3;
    mesh.visible = false;
    engine.scene.add(mesh);

    return {
        id: 'rogue_planets',
        update(frame) {
            mesh.visible = frame.bandW[1] > 0.002;
            material.uniforms.uDpr.value = frame.dpr;
        },
        dispose() {
            engine.scene.remove(mesh);
            geometry.dispose();
            material.dispose();
        }
    };
}
