// Orbit lines as screen-space ribbons. The HDR buffer has no multisampling and WebGL lines are one pixel wide, so
// each line is a strip of triangles a fixed number of pixels across, with its edges softened in the shader.
//
//   const line = createOrbitLine(points, { closed, width, colour, opacity, soft, trail });
//   points are [x, y, z] in the line's own space; scale and place line.object as needed.
//   line.set({ draw, head, opacity, width, trail }): draw is how much of the loop shows, measured back from head.

import * as THREE from 'three';
import { sharedUniforms } from '../shared.js';

const VERTEX = /* glsl */`
attribute vec3 aPrev;
attribute vec3 aNext;
attribute float aSide;
attribute float aU;
uniform vec2 uViewport;
uniform float uWidth;       // Device pixels across
varying float vEdge;        // Device pixels from the centre line
varying float vU;
void main() {
    vU = aU;
    mat4 m = projectionMatrix * modelViewMatrix;
    vec4 clip = m * vec4(position, 1.0);
    vec4 p0 = m * vec4(aPrev, 1.0);
    vec4 p1 = m * vec4(aNext, 1.0);
    // A point behind the camera has no screen position, so measure the direction from the side that does
    float w0 = max(p0.w, 1e-4);
    float w1 = max(p1.w, 1e-4);
    float wc = max(clip.w, 1e-4);
    vec2 s = clip.xy / wc * uViewport * 0.5;
    vec2 a = p0.w > 1e-4 ? p0.xy / w0 * uViewport * 0.5 : s;
    vec2 b = p1.w > 1e-4 ? p1.xy / w1 * uViewport * 0.5 : s;
    vec2 dir = b - a;
    float len = length(dir);
    dir = len > 1e-5 ? dir / len : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);
    float half_ = uWidth * 0.5 + 1.0;       // A pixel of room for the soft edge
    vEdge = aSide * half_;
    clip.xy += normal * aSide * half_ / (uViewport * 0.5) * clip.w;
    gl_Position = clip;
}`;

const FRAGMENT = /* glsl */`
uniform vec3 uColour;
uniform float uOpacity;
uniform float uWidth;
uniform float uDraw;
uniform float uHead;
uniform float uTrail;
uniform float uSoft;
varying float vEdge;
varying float vU;
void main() {
    float halfW = uWidth * 0.5;
    float a = uSoft > 0.0
        ? exp(-(vEdge * vEdge) / max(0.2, halfW * halfW * 0.35))
        : 1.0 - smoothstep(halfW - 0.5, halfW + 0.5, abs(vEdge));
    // How far behind the head this point is, as a fraction of the loop
    float back = fract(uHead - vU);
    a *= 1.0 - smoothstep(uDraw - 0.015, uDraw, back);
    float t = uTrail > 0.0 ? mix(1.0, 1.0 + uTrail, pow(1.0 - back, 5.0)) : 1.0;
    gl_FragColor = vec4(uColour * uOpacity * t * a, 1.0);
}`;

export function createOrbitLine(points, opts = {}) {
    const closed = opts.closed !== false;
    const n = points.length;
    const count = closed ? n + 1 : n;
    const position = new Float32Array(count * 2 * 3);
    const prev = new Float32Array(count * 2 * 3);
    const next = new Float32Array(count * 2 * 3);
    const side = new Float32Array(count * 2);
    const u = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
        const k = closed ? i % n : i;
        const a = closed ? points[(k + n - 1) % n] : points[Math.max(0, k - 1)];
        const c = points[k];
        const b = closed ? points[(k + 1) % n] : points[Math.min(n - 1, k + 1)];
        for (let s = 0; s < 2; s++) {
            const j = i * 2 + s;
            position.set(c, j * 3);
            prev.set(a, j * 3);
            next.set(b, j * 3);
            side[j] = s === 0 ? -1 : 1;
            u[j] = closed ? i / n : i / Math.max(1, n - 1);
        }
    }
    const indices = [];
    for (let i = 0; i < count - 1; i++) {
        const j = i * 2;
        indices.push(j, j + 1, j + 2, j + 1, j + 3, j + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aPrev', new THREE.BufferAttribute(prev, 3));
    geometry.setAttribute('aNext', new THREE.BufferAttribute(next, 3));
    geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geometry.setAttribute('aU', new THREE.BufferAttribute(u, 1));
    geometry.setIndex(indices);

    const material = new THREE.ShaderMaterial({
        toneMapped: false,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: {
            uViewport: sharedUniforms.uViewport,
            uColour: { value: new THREE.Color(...(opts.colour || [0.55, 0.72, 1])) },
            uOpacity: { value: opts.opacity ?? 0.55 },
            uWidth: { value: opts.width ?? 1.5 },
            uDraw: { value: 1 },
            uHead: { value: 0 },
            uTrail: { value: opts.trail ?? 0 },
            uSoft: { value: opts.soft ? 1 : 0 }
        }
    });
    const object = new THREE.Mesh(geometry, material);
    object.frustumCulled = false;
    object.renderOrder = opts.renderOrder ?? 3;

    return {
        object,
        set(values) {
            const un = material.uniforms;
            if (values.draw !== undefined) un.uDraw.value = values.draw;
            if (values.head !== undefined) un.uHead.value = values.head;
            if (values.opacity !== undefined) un.uOpacity.value = values.opacity;
            if (values.width !== undefined) un.uWidth.value = values.width;
            if (values.trail !== undefined) un.uTrail.value = values.trail;
        },
        dispose() {
            geometry.dispose();
            material.dispose();
        }
    };
}
