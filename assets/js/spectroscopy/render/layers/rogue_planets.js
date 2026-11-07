// Rogue planets show only in the infrared: a faint warm point at wide zoom. Zoomed far in, the point opens into a dark
// sphere, lit only by its own heat around the rim. It blocks the glow behind it, so it isn't purely additive.

import * as THREE from 'three';
import { azAltToVec3 } from '../../core/sky.js';
import { bandSkyBrightness } from '../../data/band_table.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { MIN_GLOW } from '../engine.js';
import { travelPc } from '../../core/depth.js';

const SKY_RADIUS = 1000;

export function createRoguePlanetsLayer(engine, app) {
    const bodies = app.universe.bodies.filter((b) => b.kind === 'rogue_planet');
    const n = bodies.length;
    const centres = new Float32Array(n * 3);
    const look = new Float32Array(n * 3);   // Infrared glow, size (0..1), warmth (0..1)
    const depths = new Float32Array(n);
    const pcs = new Float32Array(n);
    bodies.forEach((body, i) => {
        depths[i] = body.depth;
        pcs[i] = travelPc(body);
        const v = azAltToVec3(body.sky.az, body.sky.alt);
        centres.set([v[0] * SKY_RADIUS, v[1] * SKY_RADIUS, v[2] * SKY_RADIUS], i * 3);
        const rogue = body.rogue_planet || {};
        const size = Math.min(1, Math.log10(Math.max(1, rogue.radius_Rearth || 2)) / Math.log10(12));
        const warmth = Math.min(1, Math.max(0, ((rogue.teff_K || 100) - 40) / 360));
        look.set([bandSkyBrightness(body, 'ir'), size, warmth], i * 3);
    });

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(centres, 3));
    geometry.setAttribute('aLook', new THREE.InstancedBufferAttribute(look, 3));
    geometry.setAttribute('aDepth', new THREE.InstancedBufferAttribute(depths, 1));
    geometry.setAttribute('aPc', new THREE.InstancedBufferAttribute(pcs, 1));
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
            attribute float aDepth;
            attribute float aPc;
            uniform float uDpr;
            varying vec2 vPx;
            varying vec3 vColour;
            varying vec3 vShape;    // Disc radius (device px), glow radius, opening (0 a point, 1 a sphere)
            varying float vAmount;
            varying float vQuad;
            void main() {
                vec3 centre = aCentre;
                float near = travel(centre, aPc);
                float glow = clamp(aLook.x * pow(10.0, 0.4 * (uLimitMag - 6.0)) * travelLight(near), 0.0, 400.0);
                if (glow < ${MIN_GLOW.toFixed(3)} || uBandW[1] <= 0.001 || uSkyFade <= 0.0) {
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    return;
                }
                // Magnitudes above where it starts to be drawn: 0 up to about 9.75
                float m = max(1.0857 * log(glow) + 3.25, 0.0);
                float amount = smoothstep(0.0, 2.2, m) * (0.25 + 0.12 * m) * uBandW[1] * uSkyFade;
                float open = smoothstep(9.0, 2.2, uFov);
                float radius = mix(0.0, (5.0 + 16.0 * aLook.y) * pow(9.0 / max(uFov, 0.4), 0.42), open) * uDpr;
                // The glow around the point widens with the disc, as heat haze rather than a hard outline
                float halo = (1.0 + 0.9 * aLook.y) * (0.8 + 0.07 * m) * uDpr + radius * 0.22;
                vQuad = radius * 1.5 + halo * 5.0;
                vShape = vec3(radius, halo, open);
                vAmount = amount;
                // Warm against the band's false colour: the warmer the world, the more it leans to orange
                vColour = mix(uBandTint[1], vec3(1.0, 0.52, 0.22), 0.15 + 0.25 * aLook.z);
                vPx = position.xy * vQuad;
                vec4 clip = projectionMatrix * modelViewMatrix * vec4(centre, 1.0);
                clip.xy *= depthP(aDepth);
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
                vec3 col = vColour * glow * window * mix(0.95, 0.22, vShape.z) * vAmount;
                float alpha = 0.0;
                if (radius > 0.5) {
                    float inside = clamp(radius - r + 0.5, 0.0, 1.0);
                    // A dark globe, shaded as a sphere: its own heat barely shows across the face, and builds up
                    // towards the limb, where the line of sight passes through the most warm atmosphere
                    float x = min(r / radius, 1.0);
                    float x2 = x * x;
                    float limb = x2 * x2 * x2;
                    // Stronger on one side: a dark globe, not a ring of light
                    float side = 0.5 + 0.5 * dot(vPx / max(r, 0.001), vec2(-0.6, 0.8));
                    float face = 0.03 + 0.05 * (1.0 - x2) + 0.16 * limb * mix(0.25, 1.0, side);
                    col = mix(col, vColour * face * (0.6 + vAmount), inside);
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
