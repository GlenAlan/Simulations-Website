// Trails behind the stars of a young multiple in no stable orbit (data/unstable.js), in place of the orbit rings other systems
// have: each is where its star has been over the last crossing time, fading out behind it. Screen-space ribbons a fixed
// number of pixels wide, as render/system/orbit_lines.js draws orbits, with their own fade.
//
//   const trails = createDanceTrails(model);   group.add(trails.group)
//   trails.update({ tDays, draw, dpr, selected })   draw: 0..1, how far the view has come in; selected: a star's code or null
//
// The points are read on a fixed grid of times, so a trail doesn't shimmer as the clock moves, and kept between frames, so
// each frame works out only the few new ones.

import * as THREE from 'three';
import { sharedUniforms } from '../shared.js';
import { surfaceColour } from './star_surface.js';
import { danceWorld, danceCentreWorld, trailDays } from './dance_model.js';

const POINTS = 160;               // Points along each trail
const WIDTH_PX = 1.5;
const OPACITY = 0.55;

const VERTEX = /* glsl */`
attribute vec3 aPrev;
attribute vec3 aNext;
attribute float aSide;
attribute float aU;
uniform vec2 uViewport;
uniform float uWidth;
varying float vEdge;
varying float vU;
void main() {
    vU = aU;
    mat4 m = projectionMatrix * modelViewMatrix;
    vec4 clip = m * vec4(position, 1.0);
    vec4 p0 = m * vec4(aPrev, 1.0);
    vec4 p1 = m * vec4(aNext, 1.0);
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
    float half_ = uWidth * 0.5 + 1.0;
    vEdge = aSide * half_;
    clip.xy += normal * aSide * half_ / (uViewport * 0.5) * clip.w;
    gl_Position = clip;
}`;

const FRAGMENT = /* glsl */`
uniform vec3 uColour;
uniform float uOpacity;
uniform float uWidth;
varying float vEdge;
varying float vU;
void main() {
    float halfW = uWidth * 0.5;
    float a = 1.0 - smoothstep(halfW - 0.5, halfW + 0.5, abs(vEdge));
    // Fading out behind the star: the oldest end is gone
    float fade = vU * vU;
    gl_FragColor = vec4(uColour * uOpacity * fade * a, 1.0);
}`;

function makeLine(colour) {
    const count = POINTS + 1;
    const position = new Float32Array(count * 2 * 3);
    const prev = new Float32Array(count * 2 * 3);
    const next = new Float32Array(count * 2 * 3);
    const side = new Float32Array(count * 2);
    const u = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
        for (let s = 0; s < 2; s++) {
            side[i * 2 + s] = s === 0 ? -1 : 1;
            u[i * 2 + s] = i / (count - 1);
        }
    }
    const indices = [];
    for (let i = 0; i < count - 1; i++) {
        const j = i * 2;
        indices.push(j, j + 1, j + 2, j + 1, j + 3, j + 2);
    }
    const geometry = new THREE.BufferGeometry();
    const attr = (array, size) => {
        const a = new THREE.BufferAttribute(array, size);
        a.setUsage(THREE.DynamicDrawUsage);
        return a;
    };
    geometry.setAttribute('position', attr(position, 3));
    geometry.setAttribute('aPrev', attr(prev, 3));
    geometry.setAttribute('aNext', attr(next, 3));
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
            uColour: { value: new THREE.Color(...colour) },
            uOpacity: { value: 0 },
            uWidth: { value: WIDTH_PX }
        }
    });
    const object = new THREE.Mesh(geometry, material);
    object.frustumCulled = false;
    object.renderOrder = 3;
    const set = (pts) => {
        for (let i = 0; i < count; i++) {
            const c = pts[i];
            const a = pts[Math.max(0, i - 1)];
            const b = pts[Math.min(count - 1, i + 1)];
            for (let s = 0; s < 2; s++) {
                const j = (i * 2 + s) * 3;
                position[j] = c[0]; position[j + 1] = c[1]; position[j + 2] = c[2];
                prev[j] = a[0]; prev[j + 1] = a[1]; prev[j + 2] = a[2];
                next[j] = b[0]; next[j + 1] = b[1]; next[j + 2] = b[2];
            }
        }
        ['position', 'aPrev', 'aNext'].forEach((name) => { geometry.getAttribute(name).needsUpdate = true; });
    };
    return {
        object,
        material,
        set,
        dispose() {
            geometry.dispose();
            material.dispose();
        }
    };
}

export function createDanceTrails(model) {
    const group = new THREE.Group();
    const n = model.stars.length;
    const lines = model.stars.map((s) => {
        const c = surfaceColour(s.star.teff_K);
        // A little paler than the star, so a trail reads as a path and not as light from it
        const line = makeLine([0.35 + 0.55 * c[0], 0.35 + 0.55 * c[1], 0.35 + 0.55 * c[2]]);
        group.add(line.object);
        return line;
    });
    const step = trailDays(model) / POINTS;
    // Back to the start of the integration at most: before it, the stars would need running backwards
    const earliest = -model.body.chaos.today_days;
    const cache = new Map();
    const at = (k) => {
        let p = cache.get(k);
        if (!p) {
            p = danceWorld(model, Math.max(earliest, k * step));
            cache.set(k, p);
        }
        return p;
    };
    const pts = model.stars.map(() => Array.from({ length: POINTS + 1 }, () => [0, 0, 0]));
    let lastKey = null;

    function update({ tDays, draw, dpr, selected }) {
        const visible = draw > 0.001;
        lines.forEach((line, i) => {
            line.object.visible = visible;
            line.material.uniforms.uOpacity.value = OPACITY * draw * (model.stars[i].code === selected ? 1.6 : 1);
            line.material.uniforms.uWidth.value = WIDTH_PX * dpr * (model.stars[i].code === selected ? 1.4 : 1);
        });
        if (!visible) return;
        const key = tDays;
        if (key === lastKey) return;
        lastKey = key;
        const kNow = Math.floor(tDays / step);
        const now = danceWorld(model, tDays);
        // The trails stay where the stars went; the view's middle moves with the stars that stay
        const centre = danceCentreWorld(model, tDays);
        group.position.set(-centre[0], -centre[1], -centre[2]);
        // POINTS - 1 grid points behind the star, then where it is just now
        for (let j = 0; j < POINTS; j++) {
            const p = at(kNow - (POINTS - 1) + j);
            for (let i = 0; i < n; i++) {
                pts[i][j][0] = p[i][0];
                pts[i][j][1] = p[i][1];
                pts[i][j][2] = p[i][2];
            }
        }
        for (let i = 0; i < n; i++) {
            pts[i][POINTS][0] = now[i][0];
            pts[i][POINTS][1] = now[i][1];
            pts[i][POINTS][2] = now[i][2];
            lines[i].set(pts[i]);
        }
        // Only what's on show is kept
        if (cache.size > 4 * POINTS) {
            for (const k of cache.keys()) if (k < kNow - POINTS || k > kNow + 1) cache.delete(k);
        }
    }

    return {
        group,
        update,
        dispose() {
            lines.forEach((line) => line.dispose());
            cache.clear();
        }
    };
}
