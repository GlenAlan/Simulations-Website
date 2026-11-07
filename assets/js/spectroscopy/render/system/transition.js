// The Spore-style move into a system as one eased progress value p, 0 in the sky and 1 in the system.
// Everything is a pure function of p, so leaving is exactly entering played backwards.

export const TRANSITION_S = 2.1;

export function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

export function smootherstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * t * (t * (t * 6 - 15) + 10);
}

// From time fraction to progress: a gentle start and landing, so the whole thing reads as one flight
export function easeProgress(t) {
    return t * t * (3 - 2 * t) * 0.55 + t * 0.45;
}

const lerp = (a, b, k) => a + (b - a) * k;

// d0: the star is a speck. dClose: its surface fills the view. dEnd: the whole system fits.
export function pathAt(p, { d0, dClose, dEnd, el0, el1, az0, az1 }) {
    const approach = smoothstep(0, 0.62, p);
    const pull = smootherstep(0.5, 1, p);
    const logD = lerp(lerp(Math.log(d0), Math.log(dClose), approach), Math.log(dEnd), pull);
    const tilt = smootherstep(0.3, 0.96, p);
    return { dist: Math.exp(logD), el: lerp(el0, el1, tilt), az: lerp(az0, az1, tilt) };
}

export function stagesAt(p) {
    return {
        skyCentre: smootherstep(0, 0.48, p),        // The sky camera turns to put the star dead ahead
        skyZoom: smoothstep(0, 0.74, p),            // ... and narrows, so stars stream outward
        skyFade: 1 - smoothstep(0.12, 0.62, p),
        reveal: smoothstep(0.02, 0.24, p),          // The real star takes over from the point in the sky
        minSize: smoothstep(0.78, 1, p),            // Minimum on-screen sizes only matter at the far end
        pointGlow: smoothstep(0.02, 0.18, p) * (1 - smoothstep(0.26, 0.42, p)),
        backdrop: smoothstep(0.5, 1, p),
        backdropZoom: 0.62 + 0.38 * smoothstep(0.48, 1, p),
        orbits: smootherstep(0.56, 0.86, p),
        planets: smootherstep(0.84, 1, p),          // Once the camera has pulled back: a big half-faded planet looks wrong
        userBlend: smoothstep(0.82, 1, p)           // On the way out: from wherever the student left the camera
    };
}
