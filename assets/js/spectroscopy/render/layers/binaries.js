// Binary and multiple stars. Far away, stars.js draws each system as one point. Zoomed in, this layer takes over: the
// point comes apart into its members, level by level, so the double-double D2W7XK is one point, then two, then four.
//
// Separations are stylised, tied to the orbital period: real ones would be far too small to see, and would span too
// wide a range. Directions on the sky come from where the stars really are in their orbits (data/orbits.js).

import * as THREE from 'three';
import { bus } from '../../core/state.js';
import { BANDS } from '../../core/bands.js';
import { hashString } from '../../core/rng.js';
import { blackBodyRGB } from '../../core/phys.js';
import { limitingMag, vec3ToAzAlt } from '../../core/sky.js';
import { drawMag, parallaxFactor } from '../../core/depth.js';
import { componentStates } from '../../data/orbits.js';
import { bandSkyBrightness, bandMagnitude } from '../../data/band_table.js';
import { skyMaterial, BAND_GLSL, ORDER } from '../shared.js';
import { DEG, SKY_RADIUS, bodyRng, skyBasis, instancedQuad, smoothstep } from './exotic_common.js';
import { createSprites, createSpikes, bodySoftness, SPLIT_LO, SPLIT_HI } from './stars.js';

// Stylised on-sky separation in degrees: slow, wide orbits show first. Three days gives about 0.03 deg (seen apart at
// a field of view near 2 deg), a thousand years about 0.25 deg (seen apart near 15 deg).
function separationDeg(periodDays) {
    return 0.025 * Math.max(0.2, periodDays) ** 0.18;
}

const sameSet = (list, set) => list.length === set.length && list.every((i) => set.includes(i));

// The system as a tree. A node is either one star or a group that splits in two when its separation resolves.
function systemTree(body) {
    // The figure-eight's one entry has an empty side: it pairs nothing
    const orbits = (body.orbits || []).filter((o) => o.a && o.b && o.a.length && o.b.length);
    const all = body.stars.map((_, i) => i);
    const build = (group) => {
        if (group.length === 1) return { stars: group, orbit: null, children: [] };
        const orbit = orbits.find((o) => sameSet([...o.a, ...o.b], group));
        if (orbit) return { stars: group, orbit, children: [build(orbit.a), build(orbit.b)] };
        // No pairing given (the figure-eight has no outer and inner): every star is its own child
        return { stars: group, orbit: null, children: group.map((i) => build([i])) };
    };
    return build(all);
}

function massOf(body, group) {
    return group.reduce((sum, i) => sum + body.stars[i].star.mass_Msun, 0);
}

function centreOfMass(body, group, states) {
    const out = [0, 0, 0];
    const total = massOf(body, group);
    group.forEach((i) => {
        const s = states[i];
        const m = body.stars[i].star.mass_Msun / total;
        out[0] += s.x_AU * m;
        out[1] += s.y_AU * m;
        out[2] += s.z_AU * m;
    });
    return out;
}

// From the plane of the widest orbit, which is what componentStates reports in, to the sky. Its +y runs away from us,
// so it shows as cos(i) of its length. rho turns the whole system on the sky.
function toSky(v, ctx) {
    const i = ctx.inc * DEG;
    const sx = v[0];
    const sy = v[1] * Math.cos(i) + v[2] * Math.sin(i);
    const c = Math.cos(ctx.rho);
    const s = Math.sin(ctx.rho);
    return [sx * c - sy * s, sx * s + sy * c];
}

// Writes each node's offset from the system's centre (degrees on the sky) and its own and its parent's separations.
// ctx = { body, states, rho, inc }
function layOut(node, x, y, parentSep, ctx, out) {
    const { body, states } = ctx;
    node.x = x;
    node.y = y;
    node.sepParent = parentSep;
    node.sepSelf = 0;
    if (!node.children.length) {
        out.push(node);
        return;
    }
    const complete = states.length === body.stars.length;
    if (node.orbit) {
        const orbit = node.orbit;
        const [a, b] = node.children;
        const pairOffset = (child) => {
            const code = body.stars[child.stars[0]].code;
            const pair = (body.pairs || []).find((p) => p.codes.includes(code));
            return pair && node.stars.length === body.stars.length ? pair.offset_deg : null;
        };
        const oa = pairOffset(a);
        const ob = pairOffset(b);
        if (oa && ob) {
            // The double-double's two pairs have places of their own in the data
            node.sepSelf = Math.hypot(ob.x - oa.x, ob.y - oa.y);
            layOut(a, x + oa.x, y + oa.y, node.sepSelf, ctx, out);
            layOut(b, x + ob.x, y + ob.y, node.sepSelf, ctx, out);
        } else {
            // From a's centre of mass to b's: from the true states where they exist, otherwise from the orbit's phase
            let d;
            if (complete) {
                const ca = centreOfMass(body, a.stars, states);
                const cb = centreOfMass(body, b.stars, states);
                d = [cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]];
            } else {
                const angle = 2 * Math.PI * orbit.phase0;
                d = [-Math.cos(angle), -Math.sin(angle), 0];
            }
            const length3 = Math.hypot(d[0], d[1], d[2]) || 1;
            const sky = toSky(d, ctx);
            const lengthSky = Math.hypot(sky[0], sky[1]) || 1;
            // Foreshortened near conjunction, but never so much that a pair can't be told apart
            const sep = separationDeg(orbit.period_days) * Math.max(0.6, lengthSky / length3);
            const ma = massOf(body, a.stars);
            const mb = massOf(body, b.stars);
            const ux = sky[0] / lengthSky;
            const uy = sky[1] / lengthSky;
            node.sepSelf = sep;
            layOut(a, x - ux * sep * (mb / (ma + mb)), y - uy * sep * (mb / (ma + mb)), sep, ctx, out);
            layOut(b, x + ux * sep * (ma / (ma + mb)), y + uy * sep * (ma / (ma + mb)), sep, ctx, out);
        }
    } else {
        // Flat: scale the true positions so the widest star sits at a stylised distance
        const period = body.orbits && body.orbits[0] ? body.orbits[0].period_days : 365;
        const reach = (body.visual_sep_deg || separationDeg(period)) * 0.8;
        const placed = node.children.map((child, k) => {
            if (complete) {
                const s = states[child.stars[0]];
                return toSky([s.x_AU, s.y_AU, s.z_AU || 0], ctx);
            }
            const angle = (2 * Math.PI * k) / node.children.length;
            return [Math.cos(angle), Math.sin(angle)];
        });
        const widest = Math.max(...placed.map((p) => Math.hypot(p[0], p[1])), 1e-6);
        node.sepSelf = reach;
        node.children.forEach((child, k) => {
            layOut(child, x + (placed[k][0] / widest) * reach, y + (placed[k][1] / widest) * reach, reach, ctx, out);
        });
    }
    out.push(node);
}

export function createBinariesLayer(engine, app) {
    let systems = [];
    let flat = [];          // Every drawn node of every system, in instance order
    let points = null;      // The members, drawn just as stars.js draws any star, and their diffraction spikes
    let spikes = null;
    let bridges = null;
    let aura = null;
    let pairs = [];         // Interacting pairs, in instance order of the bridges and auras
    const byCode = new Map();
    const pickList = [];

    function worldOf(system, x, y) {
        const { centre, east, up } = system.basis;
        return [
            (centre[0] + (east[0] * x + up[0] * y) * DEG) * SKY_RADIUS,
            (centre[1] + (east[1] * x + up[1] * y) * DEG) * SKY_RADIUS,
            (centre[2] + (east[2] * x + up[2] * y) * DEG) * SKY_RADIUS
        ];
    }

    function makeSystem(body) {
        const rng = bodyRng(body, 'binary');
        const system = { body, basis: skyBasis(body.sky.az, body.sky.alt), rho: rng.range(0, Math.PI * 2), tree: systemTree(body), nodes: [], first: 0 };
        layOutSystem(system, 0);
        return system;
    }

    function layOutSystem(system, tDays) {
        const { body } = system;
        const widest = body.orbits && body.orbits.length ? body.orbits[body.orbits.length - 1] : null;
        const ctx = { body, states: componentStates(body, tDays), rho: system.rho, inc: widest ? widest.inc_deg ?? 60 : 60 };
        const out = [];
        layOut(system.tree, 0, 0, 0, ctx, out);
        // The root is the sprite that stars.js draws, so it isn't drawn here
        system.nodes = out.filter((node) => node !== system.tree);
    }

    // How much of the system's light this point has
    function nodeShare(system, node) {
        const lum = (group) => group.reduce((sum, i) => sum + system.body.stars[i].star.luminosity_Lsun, 0);
        return lum(node.stars) / lum(system.tree.stars);
    }

    function nodeColour(system, node) {
        // Light-weighted temperature, for groups that show as one point
        const stars = node.stars.map((i) => system.body.stars[i].star);
        const total = stars.reduce((sum, s) => sum + s.luminosity_Lsun, 0);
        const t = stars.reduce((sum, s) => sum + s.teff_K * s.luminosity_Lsun, 0) / total;
        return blackBodyRGB(t);
    }

    // What clicking a point selects. A point that is still a group stands for its brightest star: there is no entity for
    // a pair as such, so that star is the nearest thing that can be opened
    function nodeCode(system, node) {
        const { stars } = system.body;
        if (node.orbit && node.orbit.code) return node.orbit.code;
        const brightest = node.stars.reduce((best, i) => (stars[i].star.luminosity_Lsun > stars[best].star.luminosity_Lsun ? i : best), node.stars[0]);
        return stars[brightest].code;
    }

    // Hot spots and X-rays belong to the gas between the stars of an interacting pair, whichever pair that is
    function interactingPairs(system) {
        const out = [];
        const walk = (node) => {
            if (node.orbit && node.children.every((c) => !c.children.length)) out.push(node);
            node.children.forEach(walk);
        };
        if (system.body.interacting) walk(system.tree);
        return out;
    }

    function build() {
        systems = app.universe.bodies
            .filter((b) => (b.kind === 'binary' || b.kind === 'multiple') && Array.isArray(b.stars) && b.stars.length > 1)
            .map(makeSystem);
        byCode.clear();
        flat = [];
        systems.forEach((system) => {
            byCode.set(system.body.code, system);
            system.first = flat.length;
            system.nodes.forEach((node) => flat.push({ system, node }));
        });
        const n = flat.length;
        const data = {
            count: n,
            centres: new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3),
            colours: new Float32Array(n * 3),
            bandA: new Float32Array(n * 4),
            bandB: new Float32Array(n),
            seeds: new Float32Array(n),
            soft: new Float32Array(n),
            depths: new Float32Array(n),
            flux: new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1),
            split: new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2),
            spike: new Float32Array(n).fill(1)
        };
        data.centres.setUsage(THREE.DynamicDrawUsage);
        data.split.setUsage(THREE.DynamicDrawUsage);
        flat.forEach(({ system, node }, i) => {
            const share = nodeShare(system, node);
            node.code = nodeCode(system, node);
            data.centres.array.set(worldOf(system, node.x, node.y), i * 3);
            data.split.array.set([node.sepParent, node.sepSelf], i * 2);
            data.colours.set(nodeColour(system, node), i * 3);
            // In BANDS order: radio, infrared, visible, ultraviolet here, and X-ray in bandB
            const glow = BANDS.map((band) => bandSkyBrightness(system.body, band) * share);
            data.bandA.set(glow.slice(0, 4), i * 4);
            data.bandB[i] = glow[4];
            data.seeds[i] = hashString(node.code || system.body.code) / 4294967296;
            data.soft[i] = node.stars.length === 1 ? bodySoftness(system.body.stars[node.stars[0]]) : 1;
            data.depths[i] = system.body.depth;
        });
        points = createSprites(data);
        spikes = createSpikes(data);
        points.mesh.renderOrder = ORDER.exotic;
        spikes.mesh.renderOrder = ORDER.exotic + 1;
        spikes.mesh.visible = app.qualityLevel !== 'low';
        engine.scene.add(points.mesh, spikes.mesh);
        sendSplits();

        buildInteracting();
    }

    // stars.js draws the system's single point, at its centre. It goes out as the members come apart
    function sendSplits(only) {
        const stars = engine.getLayer('stars');
        if (!stars || !stars.setSpriteSplit) return;
        (only ? [only] : systems).forEach((system) => stars.setSpriteSplit(system.body.code, system.tree.sepSelf));
    }

    function buildInteracting() {
        pairs = [];
        systems.forEach((system) => interactingPairs(system).forEach((node) => pairs.push({ system, node })));
        const n = pairs.length;
        if (!n) return;

        // The gas stream between the two stars of an interacting pair, once they are seen apart
        const bridgeGeometry = instancedQuad(n);
        const from = new Float32Array(n * 3);
        const to = new Float32Array(n * 3);
        const info = new Float32Array(n * 4);
        const bandA = new Float32Array(n * 4);
        const bandB = new Float32Array(n);
        const pairDepths = new Float32Array(n);
        pairs.forEach(({ system, node }, i) => {
            pairDepths[i] = system.body.depth;
            const [donor, gainer] = bridgeEnds(system, node);
            from.set(worldOf(system, donor.x, donor.y), i * 3);
            to.set(worldOf(system, gainer.x, gainer.y), i * 3);
            info.set([node.sepSelf, bodyRng(system.body, 'stream').next(), 0, 0], i * 4);
            const bands = system.body.bands;
            bandA.set([0, 0, bands.visible, bands.uv], i * 4);
            bandB[i] = bands.xray;
        });
        bridgeGeometry.setAttribute('aFrom', new THREE.InstancedBufferAttribute(from, 3));
        bridgeGeometry.setAttribute('aTo', new THREE.InstancedBufferAttribute(to, 3));
        bridgeGeometry.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
        bridgeGeometry.setAttribute('aBandA', new THREE.InstancedBufferAttribute(bandA, 4));
        bridgeGeometry.setAttribute('aBandB', new THREE.InstancedBufferAttribute(bandB, 1));
        bridgeGeometry.setAttribute('aDepth', new THREE.InstancedBufferAttribute(pairDepths, 1));
        const bridgeMaterial = skyMaterial({
            vertexShader: /* glsl */`
                ${BAND_GLSL}
                attribute vec3 aFrom;
                attribute vec3 aTo;
                attribute vec4 aInfo;
                attribute vec4 aBandA;
                attribute float aBandB;
                attribute float aDepth;
                varying vec2 vP;
                varying vec4 vWeights;
                varying float vSeed;
                void main() {
                    float shows = smoothstep(${SPLIT_LO.toFixed(1)}, ${SPLIT_HI.toFixed(1)}, radians(aInfo.x) * uPxPerRad * depthP(aDepth));
                    vWeights = vec4(aBandA.z * uBandW[2] * 0.5, aBandA.w * uBandW[3], aBandB * uBandW[4], shows) * uSkyFade;
                    vSeed = aInfo.y;
                    vP = position.xy;
                    vec4 a = modelViewMatrix * vec4(aFrom, 1.0);
                    vec4 b = modelViewMatrix * vec4(aTo, 1.0);
                    a.xy *= depthP(aDepth);
                    b.xy *= depthP(aDepth);
                    vec2 along = b.xy - a.xy;
                    float len = max(length(along), 0.0001);
                    vec2 axis = along / len;
                    float pxWorld = length(a.xyz) / uPxPerRad;
                    float halfWidth = max(len * 0.16, 5.0 * pxWorld);
                    vec4 c = a;
                    float reach = shows > 0.002 ? 1.0 : 0.0;
                    c.xy = 0.5 * (a.xy + b.xy) + (axis * position.x * len * 0.62 + vec2(-axis.y, axis.x) * position.y * halfWidth) * reach;
                    gl_Position = projectionMatrix * c;
                }`,
            fragmentShader: /* glsl */`
                ${BAND_GLSL}
                varying vec2 vP;
                varying vec4 vWeights;
                varying float vSeed;
                void main() {
                    float s = clamp(vP.x / 0.62 * 0.5 + 0.5, 0.0, 1.0);   // 0 at the star losing gas, 1 at the one gaining
                    // Curved by the orbit, so the gas misses the gaining star's centre and swirls in
                    float y = vP.y + 0.4 * sin(s * 3.1416) * (vSeed > 0.5 ? 1.0 : -1.0);
                    float line = exp(-y * y * 200.0);
                    float glow = exp(-y * y * 9.0) * 0.5;
                    // The hot spot, where the stream strikes
                    float ds = (s - 0.86) / 0.13;
                    float spot = exp(-ds * ds - vP.y * vP.y * 9.0);
                    float ends = smoothstep(1.0, 0.75, abs(vP.x)) * smoothstep(1.0, 0.7, abs(vP.y));
                    float gas = (line * (0.25 + 0.75 * s) + 0.15 * glow) * ends;
                    vec3 light = vec3(1.0, 0.85, 0.7) * gas * vWeights.x
                        + uBandTint[3] * ((gas * 0.6 + spot * 2.4) * vWeights.y)
                        + uBandTint[4] * ((gas * 1.1 + spot * 1.8) * vWeights.z);
                    gl_FragColor = vec4(light * vWeights.w, 1.0);
                }`
        });
        bridges = new THREE.Mesh(bridgeGeometry, bridgeMaterial);
        bridges.frustumCulled = false;
        bridges.renderOrder = ORDER.exotic - 1;
        engine.scene.add(bridges);

        // Before they come apart: the pair as a whole glows in X-rays and UV
        const auraGeometry = instancedQuad(n);
        const centres = new Float32Array(n * 3);
        const auraBandA = new Float32Array(n * 4);
        const auraBandB = new Float32Array(n);
        const sep = new Float32Array(n);
        pairs.forEach(({ system, node }, i) => {
            centres.set(worldOf(system, node.x, node.y), i * 3);
            auraBandA.set([0, 0, 0, system.body.bands.uv], i * 4);
            // A brighter source has the bigger glow, so that the sky has a few great beacons and many small ones
            auraBandB[i] = system.body.bands.xray * Math.min(1, 10 ** (-0.2 * (bandMagnitude(system.body, 'xray') - 1.5)));
            sep[i] = node.sepSelf;
        });
        auraGeometry.setAttribute('aCentre', new THREE.InstancedBufferAttribute(centres, 3));
        auraGeometry.setAttribute('aBandA', new THREE.InstancedBufferAttribute(auraBandA, 4));
        auraGeometry.setAttribute('aBandB', new THREE.InstancedBufferAttribute(auraBandB, 1));
        auraGeometry.setAttribute('aSepDeg', new THREE.InstancedBufferAttribute(sep, 1));
        auraGeometry.setAttribute('aDepth', new THREE.InstancedBufferAttribute(pairDepths, 1));
        const auraMaterial = skyMaterial({
            vertexShader: /* glsl */`
                ${BAND_GLSL}
                attribute vec3 aCentre;
                attribute vec4 aBandA;
                attribute float aBandB;
                attribute float aSepDeg;
                attribute float aDepth;
                varying vec2 vP;
                varying float vAmount;
                void main() {
                    vP = position.xy;
                    float apart = smoothstep(${SPLIT_LO.toFixed(1)}, ${SPLIT_HI.toFixed(1)}, radians(aSepDeg) * uPxPerRad * depthP(aDepth));
                    vAmount = (aBandA.w * uBandW[3] * 0.4 + aBandB * uBandW[4]) * (1.0 - 0.7 * apart) * uSkyFade;
                    vec4 c = modelViewMatrix * vec4(aCentre, 1.0);
                    c.xy *= depthP(aDepth);
                    float halfPx = uViewport.y * (0.012 + 0.024 * vAmount) * (vAmount > 0.002 ? 1.0 : 0.0);
                    c.xy += position.xy * halfPx * length(c.xyz) / uPxPerRad;
                    gl_Position = projectionMatrix * c;
                }`,
            fragmentShader: /* glsl */`
                ${BAND_GLSL}
                varying vec2 vP;
                varying float vAmount;
                void main() {
                    float r = length(vP);
                    float glow = exp(-r * r * 12.0) * mix(0.5, 0.28, uBandW[4]) + 0.1 / (1.0 + r * r * 25.0);
                    gl_FragColor = vec4(bandColour(vec3(1.0)) * glow * smoothstep(1.0, 0.55, r) * vAmount, 1.0);
                }`
        });
        aura = new THREE.Mesh(auraGeometry, auraMaterial);
        aura.frustumCulled = false;
        aura.renderOrder = ORDER.exotic - 1;
        engine.scene.add(aura);
    }

    // [the star losing gas, the star gaining it]
    function bridgeEnds(system, node) {
        const [a, b] = node.children;
        const { transfer } = system.body;
        const aGains = transfer ? a.stars.includes(transfer.accretor) : massOf(system.body, a.stars) >= massOf(system.body, b.stars);
        return aGains ? [b, a] : [a, b];
    }

    function teardown() {
        [points, spikes].forEach((part) => {
            if (!part) return;
            engine.scene.remove(part.mesh);
            part.geometry.dispose();
            part.material.dispose();
        });
        [bridges, aura].forEach((m) => {
            if (!m) return;
            engine.scene.remove(m);
            m.geometry.dispose();
            m.material.dispose();
        });
        points = null;
        spikes = null;
        bridges = null;
        aura = null;
    }

    build();

    // A panel's playback moves a system along its orbits
    const unsubscribe = bus.on('timeline', ({ code, t_days, stepped_t_days }) => {
        const resolved = app.universe.resolve(code);
        const system = resolved && byCode.get(resolved.body.code);
        if (!system || !points) return;
        const previous = system.nodes;
        layOutSystem(system, stepped_t_days ?? t_days); // Points of light: above the speed limit they step rather than strobe
        sendSplits(system);
        // The same tree in the same order, so nodes keep their instance slots
        const position = points.geometry.getAttribute('aCentre');
        const seps = points.geometry.getAttribute('aSplit');
        previous.forEach((node, k) => {
            const i = system.first + k;
            const p = worldOf(system, node.x, node.y);
            position.setXYZ(i, p[0], p[1], p[2]);
            seps.setXY(i, node.sepParent, node.sepSelf);
        });
        position.needsUpdate = true;
        seps.needsUpdate = true;
        pairs.forEach(({ system: owner, node }, i) => {
            if (owner !== system) return;
            const [donor, gainer] = bridgeEnds(system, node);
            const from = worldOf(system, donor.x, donor.y);
            const to = worldOf(system, gainer.x, gainer.y);
            const centre = worldOf(system, node.x, node.y);
            const fromAttr = bridges.geometry.getAttribute('aFrom');
            const toAttr = bridges.geometry.getAttribute('aTo');
            const centreAttr = aura.geometry.getAttribute('aCentre');
            fromAttr.setXYZ(i, from[0], from[1], from[2]);
            toAttr.setXYZ(i, to[0], to[1], to[2]);
            centreAttr.setXYZ(i, centre[0], centre[1], centre[2]);
            fromAttr.needsUpdate = true;
            toAttr.needsUpdate = true;
            centreAttr.needsUpdate = true;
        });
    });

    const unbindQuality = bus.on('quality', ({ level }) => { if (spikes) spikes.mesh.visible = level !== 'low'; });

    return {
        id: 'binaries',
        update(frame) {
            if (!points) return;
            points.material.uniforms.uDpr.value = frame.dpr;
            spikes.material.uniforms.uDpr.value = frame.dpr;
        },
        // The first split of this system: where each part is drawn just now, in degrees from its centre (east, up), and
        // which stars it is, as indices into body.stars
        firstSplit(code) {
            const system = byCode.get(code);
            return system ? system.tree.children.map((node) => ({ x: node.x, y: node.y, stars: node.stars })) : null;
        },
        // The field of view that shows this system's closest stars apart, or 0 for one the layer doesn't draw
        fovApart(code, frame) {
            const system = byCode.get(code);
            if (!system) return 0;
            let tightest = Infinity;
            const walk = (node) => {
                if (node.sepSelf > 0) tightest = Math.min(tightest, node.sepSelf);
                node.children.forEach(walk);
            };
            walk(system.tree);
            if (tightest === Infinity) return 0;
            const fov = (tightest * frame.height * frame.dpr) / SPLIT_HI;
            return fov * parallaxFactor(system.body.depth, fov);
        },
        // Where one star of a system is drawn at this zoom: the point it's part of, for as long as it hasn't come apart
        componentSky(code, frame) {
            const resolved = app.universe.resolve(code);
            const system = resolved && byCode.get(resolved.body.code);
            const index = system ? system.body.stars.findIndex((star) => star.code === code) : -1;
            if (index < 0) return null;
            const { depth } = system.body;
            const pxPerRad = frame.pxPerRad * parallaxFactor(depth, frame.fov);
            let node = system.tree;
            while (node.children.length && node.sepSelf * DEG * pxPerRad >= (SPLIT_LO + SPLIT_HI) / 2) {
                node = node.children.find((child) => child.stars.includes(index));
            }
            const world = worldOf(system, node.x, node.y);
            const { az, alt } = vec3ToAzAlt(world[0], world[1], world[2]);
            return { az, alt, depth };
        },
        // Resolved members can be selected. Only called on a click, so it may build a list
        picks(frame) {
            pickList.length = 0;
            if (frame.view !== 'sky') return pickList;
            const lim = limitingMag(frame.fov);
            for (let i = 0; i < flat.length; i++) {
                const { system, node } = flat[i];
                const { depth } = system.body;
                const pxPerRad = frame.pxPerRad * parallaxFactor(depth, frame.fov);
                const parentPx = node.sepParent * DEG * pxPerRad;
                if (parentPx < SPLIT_LO + 2) continue;
                const shown = smoothstep(SPLIT_LO, SPLIT_HI, parentPx) * (1 - smoothstep(SPLIT_LO, SPLIT_HI, node.sepSelf * DEG * pxPerRad));
                if (shown < 0.5 || !node.code) continue;
                if (frame.band === 'visible' && drawMag(system.body) > lim) continue;
                if ((system.body.bands[frame.band] || 0) <= 0.01) continue;
                const world = worldOf(system, node.x, node.y);
                const sky = vec3ToAzAlt(world[0], world[1], world[2]);
                pickList.push({ code: node.code, az: sky.az, alt: sky.alt, radiusPx: 7, depth });
            }
            return pickList;
        },
        dispose() {
            unsubscribe();
            unbindQuality();
            teardown();
        }
    };
}
