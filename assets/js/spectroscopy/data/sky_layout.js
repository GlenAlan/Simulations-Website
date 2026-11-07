// Where everything sits on the dome: above the horizon, lightly spaced, and concentrated towards the galactic band or
// away from it by kind (spec 4). Rejection sampling from a seeded stream, largest objects first, then a small seeded
// jitter per body. All comparisons use rounded values, so a last-digit difference in sin or cos can't change the sky.

import { MIN_ALT, azAltToVec3, vec3ToAzAlt, galacticLatitude } from '../core/sky.js';
import { dp } from './stellar.js';

export const MIN_SPACING_DEG = 1;     // Points this far apart stay distinct at the default zoom
const MARGIN_DEG = 0.2;               // Room for the jitter
const JITTER_DEG = 0.09;
const RAD = Math.PI / 180;

const KEEP_RULES = {
    stars: (lat) => Math.exp(-(lat * lat) / 900) + 0.08,
    tight: (lat) => Math.exp(-(lat * lat) / 160) + 0.01,
    wide: (lat) => Math.exp(-(lat * lat) / 2500) + 0.12,
    avoid: (lat) => (lat < 12 ? 0 : Math.min(1, (lat - 12) / 22)),
    even: () => 1
};

// True if two directions are closer than the given cos. Compared after rounding, in case of a last-digit difference.
function tooClose(dot, threshold) {
    return dot > threshold - 1e-7 && Math.round(dot * 1e9) > Math.round(threshold * 1e9);
}

// entries: { body, rule, radius_deg, clear_deg?, group?, groupSep_deg?, altMin?, fixed?: { az, alt }, near?: entry }
export function layOutSky(entries, rng) {
    // Plain points live in flat arrays, because most checks are point against point and there are half a million of them
    const px = new Float64Array(entries.length);
    const py = new Float64Array(entries.length);
    const pz = new Float64Array(entries.length);
    let plainCount = 0;
    const special = [];
    const pointThreshold = Math.cos((MIN_SPACING_DEG + MARGIN_DEG) * RAD);

    const isSpecial = (entry) => !!(entry.radius_deg || entry.clear_deg || entry.group);

    function neededSeparation(entry, other) {
        const a = entry.radius_deg || 0;
        const b = other.radius_deg || 0;
        const reach = a > 0 && b > 0 ? a + b : 0.5 * Math.max(a, b);
        const group = entry.group && entry.group === other.group ? entry.groupSep_deg || 0 : 0;
        return Math.max(MIN_SPACING_DEG + MARGIN_DEG, reach, entry.clear_deg || 0, other.clear_deg || 0, group);
    }

    function fits(v, entry, skip) {
        const x = v[0];
        const y = v[1];
        const z = v[2];
        const threshold = isSpecial(entry) ? Math.cos(neededSeparation(entry, {}) * RAD) : pointThreshold;
        for (let i = 0; i < plainCount; i++) {
            if (tooClose(x * px[i] + y * py[i] + z * pz[i], threshold)) return false;
        }
        for (let i = 0; i < special.length; i++) {
            const other = special[i];
            if (other.entry === skip) continue;
            const dot = x * other.v[0] + y * other.v[1] + z * other.v[2];
            if (tooClose(dot, Math.cos(neededSeparation(entry, other.entry) * RAD))) return false;
        }
        return true;
    }

    function place(entry, az, alt, v) {
        entry.body.sky = { az, alt };
        if (isSpecial(entry)) {
            special.push({ entry, v });
        } else {
            px[plainCount] = v[0];
            py[plainCount] = v[1];
            pz[plainCount] = v[2];
            plainCount++;
        }
    }

    function drawFor(entry, stream) {
        const lowest = Math.max(MIN_ALT + 0.3, entry.altMin || 0, MIN_ALT + 0.3 + (entry.radius_deg || 0));
        const keep = KEEP_RULES[entry.rule] || KEEP_RULES.even;
        for (let tries = 0; ; tries++) {
            const az = dp(stream.range(0, 360), 4);
            const alt = dp(Math.asin(stream.next()) / RAD, 4); // Even coverage of the dome
            if (alt < lowest) continue;
            const lat = dp(Math.abs(galacticLatitude(az, alt)), 3);
            const keepIt = tries > 600 ? true : stream.next() < keep(lat);
            if (!keepIt) continue;
            const v = azAltToVec3(az, alt);
            if (fits(v, entry)) return place(entry, az, alt, v);
            if (tries > 3000) return place(entry, az, alt, v); // Validation would report it; it can't happen at these counts
        }
    }

    // A linked body placed just off its partner, such as a neutron star inside its own supernova's shell
    function placeNear(entry, stream) {
        const anchor = entry.near.body.sky;
        const a = azAltToVec3(anchor.az, anchor.alt);
        const ref = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const e1 = normalise(cross(a, ref));
        const e2 = cross(a, e1);
        for (let tries = 0; tries < 64; tries++) {
            const sep = stream.range(entry.near_deg[0], entry.near_deg[1]) * RAD;
            const angle = stream.range(0, 2 * Math.PI);
            const s = Math.sin(sep);
            const c = Math.cos(sep);
            const ca = Math.cos(angle);
            const sa = Math.sin(angle);
            const pos = vec3ToAzAlt(
                c * a[0] + s * (ca * e1[0] + sa * e2[0]),
                c * a[1] + s * (ca * e1[1] + sa * e2[1]),
                c * a[2] + s * (ca * e1[2] + sa * e2[2])
            );
            const az = dp(pos.az, 4);
            const alt = dp(pos.alt, 4);
            if (alt < MIN_ALT + 0.3) continue;
            const v = azAltToVec3(az, alt);
            if (fits(v, entry, entry.near) || tries === 63) return place(entry, az, alt, v);
        }
        return place(entry, anchor.az, Math.max(anchor.alt, MIN_ALT + 0.3), a);
    }

    entries.filter((e) => e.fixed).forEach((e) => place(e, e.fixed.az, e.fixed.alt, azAltToVec3(e.fixed.az, e.fixed.alt)));
    const free = entries.filter((e) => !e.fixed && !e.near);
    const large = free.filter((e) => e.radius_deg > 0).sort((a, b) => b.radius_deg - a.radius_deg || (a.body.code < b.body.code ? -1 : 1));
    const small = free.filter((e) => !(e.radius_deg > 0));
    const stream = rng.fork('positions');
    large.forEach((e) => drawFor(e, stream));
    const linked = rng.fork('linked');
    entries.filter((e) => e.near).forEach((e) => placeNear(e, linked));
    small.forEach((e) => drawFor(e, stream));

    // The jitter gets its own stream per body, so it never disturbs the layout above
    entries.forEach((entry) => {
        if (entry.fixed || entry.near) return;
        const j = rng.fork(`jitter:${entry.body.code}`);
        const r = JITTER_DEG * j.next();
        const angle = j.range(0, 2 * Math.PI);
        const sky = entry.body.sky;
        const alt = Math.max(MIN_ALT + 0.05, sky.alt + r * Math.sin(angle));
        const az = sky.az + (r * Math.cos(angle)) / Math.max(0.05, Math.cos(sky.alt * RAD));
        sky.az = dp(az - 360 * Math.floor(az / 360), 3);
        sky.alt = dp(alt, 3);
    });
}

function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalise(a) {
    const r = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / r, a[1] / r, a[2] / r];
}
