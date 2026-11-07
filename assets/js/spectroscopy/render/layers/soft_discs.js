// A plain placeholder used by each impostor layer until its own track replaces it, and a working example of
// the layer contract: camera-facing quads of a fixed angular size at each body's sky position.

import * as THREE from 'three';
import { azAltToVec3 } from '../../core/sky.js';
import { skyMaterial, BAND_GLSL } from '../shared.js';
import { travelPc } from '../../core/depth.js';

const SKY_RADIUS = 1000; // Sky objects sit on a sphere this far from the observer; only their direction matters

export function createSoftDiscLayer(engine, app, { id, kinds, sizeDeg, colour, order }) {
    const bodies = app.universe.bodies.filter((b) => kinds.includes(b.kind));
    const n = bodies.length;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const centres = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    const bandA = new Float32Array(n * 4);
    const bandB = new Float32Array(n);
    const depths = new Float32Array(n);
    const pcs = new Float32Array(n);
    bodies.forEach((body, i) => {
        const v = azAltToVec3(body.sky.az, body.sky.alt);
        centres.set([v[0] * SKY_RADIUS, v[1] * SKY_RADIUS, v[2] * SKY_RADIUS], i * 3);
        sizes[i] = sizeDeg(body);
        bandA.set([body.bands.radio, body.bands.ir, body.bands.visible, body.bands.uv], i * 4);
        bandB[i] = body.bands.xray;
        depths[i] = body.depth;
        pcs[i] = travelPc(body);
    });
    geometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(centres, 3));
    geometry.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 1));
    geometry.setAttribute('aBandA', new THREE.InstancedBufferAttribute(bandA, 4));
    geometry.setAttribute('aBandB', new THREE.InstancedBufferAttribute(bandB, 1));
    geometry.setAttribute('aDepth', new THREE.InstancedBufferAttribute(depths, 1));
    geometry.setAttribute('aPc', new THREE.InstancedBufferAttribute(pcs, 1));
    geometry.instanceCount = n;

    const material = skyMaterial({
        uniforms: { uColour: { value: new THREE.Color(...colour) } },
        vertexShader: /* glsl */`
            ${BAND_GLSL}
            attribute vec3 aCentre;
            attribute float aSize;
            attribute vec4 aBandA;
            attribute float aBandB;
            attribute float aDepth;
            attribute float aPc;
            varying vec2 vUv;
            varying float vAmount;
            void main() {
                vUv = position.xy;
                vec3 centre = aCentre;
                float near = travel(centre, aPc);
                vAmount = bandAmount(aBandA, aBandB) * travelThrough(near) * min(near * near, 1.0);
                vec4 c = modelViewMatrix * vec4(centre, 1.0);
                // Half the angular size, as a distance at the sky sphere's radius
                float half_ = tan(radians(aSize) * 0.5) * length(c.xyz) * travelSize(near);
                c.xy += position.xy * half_;
                gl_Position = projectionMatrix * c;
                gl_Position.xy *= depthP(aDepth);
            }`,
        fragmentShader: /* glsl */`
            ${BAND_GLSL}
            uniform vec3 uColour;
            varying vec2 vUv;
            varying float vAmount;
            void main() {
                float r = length(vUv);
                float glow = exp(-r * r * 4.0) * smoothstep(1.0, 0.7, r);
                gl_FragColor = vec4(bandColour(uColour) * glow * vAmount * 0.6 * uSkyFade, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    engine.scene.add(mesh);
    return {
        id,
        update() {},
        dispose() {
            engine.scene.remove(mesh);
            geometry.dispose();
            material.dispose();
        }
    };
}
