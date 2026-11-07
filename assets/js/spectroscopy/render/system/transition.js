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

// d0: the star is a speck. dClose: its surface fills the view. dEnd: the whole system fits. arrive: where in p the camera
// arrives on a move that never turns back, as under a student's hand: see below.
export function pathAt(p, { d0, dClose, dEnd, el0, el1, az0, az1, arrive = 0 }, out = {}) {
    const approach = arrive ? handApproach(p, arrive) : smoothstep(0, 0.62, p);
    const pull = smootherstep(0.5, 1, p);
    const logD = lerp(lerp(Math.log(d0), Math.log(dClose), approach), Math.log(dEnd), pull);
    const tilt = smootherstep(0.3, 0.96, p);
    out.dist = Math.exp(logD);
    out.el = lerp(el0, el1, tilt);
    out.az = lerp(az0, az1, tilt);
    return out;
}

// byHand: a student's zoom is moving this. crowded: there the sky's points of light and the real stars don't quite land on
// each other, so one set is gone sooner and the other comes later, to show as few as possible at once.
export function stagesAt(p, byHand = false, crowded = false) {
    return {
        skyCentre: smootherstep(0, 0.48, p),        // The sky camera turns to put the star dead ahead
        skyZoom: smoothstep(0, 0.74, p),            // ... and narrows, so stars stream outward
        skyFade: 1 - (crowded ? smoothstep(0.1, 0.36, p) : smoothstep(0.12, 0.62, p)),
        reveal: crowded ? smoothstep(0.14, 0.38, p) : smoothstep(0.02, 0.24, p),    // The real star takes over from the point in the sky
        minSize: smoothstep(0.78, 1, p),            // Minimum on-screen sizes only matter at the far end
        // Under a hand its size keeps going through the last of the sky's own point of light, which here fills the gap
        pointGlow: byHand ? smoothstep(0.08, 0.32, p) * (1 - smoothstep(0.34, 0.62, p)) : smoothstep(0.02, 0.18, p) * (1 - smoothstep(0.26, 0.42, p)),
        // Under a hand there's no great bright star to look at while the sky goes, so its faint copy comes up sooner
        backdrop: byHand ? smoothstep(0.3, 0.9, p) : smoothstep(0.5, 1, p),
        backdropZoom: 0.62 + 0.38 * (byHand ? smoothstep(0.3, 1, p) : smoothstep(0.48, 1, p)),
        orbits: smootherstep(0.56, 0.86, p),
        planets: smootherstep(0.84, 1, p),          // Once the camera has pulled back: a big half-faded planet looks wrong
        userBlend: smoothstep(0.82, 1, p)           // On the way out: from wherever the student left the camera
    };
}

// ---------- Travel ----------
// The flight really goes to the system (core/depth.js, render/shared.js travel): how far along the line to it the traveller
// has got, in parsecs, at progress p. It runs while the sky is on show, and stops most of the way there, where the system
// has taken over. It goes in tenfold steps of distance, from about the distance to the planets, so that whatever is passed,
// the planets, the nearest stars, the far ones, slides past rather than jumping. The steps are quick at first, where the
// Sun's own system is left behind and there is little else to pass, and ease in to a stop. A pure function of p, so that
// leaving is arriving played backwards, and exactly 0 at p = 0.
const TRAVEL_SHARE = 0.9;           // How much of the way the sky goes
const TRAVEL_FROM_PC = 1e-6;        // Where the steps begin: a fifth of the way to the Sun
const TRAVEL_EASE = 4;              // How much quicker the first steps are than the average
const DOME_GONE_PC = [3e3, 3e4];    // A flight out of the galaxy leaves its glow behind over this stretch

export function travelAt(p, distancePc, crowded = false) {
    const x = Math.min(1, p / (crowded ? 0.36 : 0.62));     // Where the sky has gone: see skyFade in stagesAt
    if (!(x > 0) || !(distancePc > 0)) return 0;
    const most = distancePc * TRAVEL_SHARE;
    const steps = Math.log(most / TRAVEL_FROM_PC);
    if (!(steps > 0)) return most * x;
    const e = 1 - (1 - x) ** TRAVEL_EASE;
    return (most * Math.expm1(steps * e)) / Math.expm1(steps);
}

// How much of the dome is left: it goes only on a flight out of the galaxy, as the galaxy is left behind
export function domeAt(travelledPc, distancePc) {
    return distancePc > DOME_GONE_PC[1] * 3 ? 1 - smoothstep(DOME_GONE_PC[0], DOME_GONE_PC[1], travelledPc) : 1;
}

// ---------- The same move under a student's hand ----------
// Zooming drives t directly, and the look of the timed flight stays except where a hand would feel it. Zooming in always
// makes things bigger and zooming out smaller, so the camera goes straight to the system with no swing in to the surface
// and back, and the student can carry on in to the surface. The sky goes on zooming at the speed the wheel had when the
// move took over, then gathers pace, and the star comes in to the centre in screen terms, never first drifting outwards.

export const HAND_LOG = 0.9;        // Zooming the whole move takes, as a log of the field of view: seven or eight notches of a wheel
export const HAND_ARRIVE = 0.8;     // Where in p the camera arrives
const HAND_SKY_FACTOR = 10;         // How far the sky narrows
const SKY_RUN = 0.66;               // Where in t the sky's zoom has finished. It has faded out by then.
const CENTRE_RUN = 0.55;            // Where in t the star has reached the centre

// The star takes over from its point of light with its size in step with that point, and is then a good size well before
// the sky has gone, so the view is never empty. A share of the way along the log of the camera's distance.
function handApproach(p, arrive) {
    return 1 - (1 - Math.min(1, p / arrive)) ** 2.5;
}

// How far the sky has zoomed by t, as a log of the field of view, of the total it has to go
export function handSkyLog(t, total = Math.log(HAND_SKY_FACTOR)) {
    const steady = Math.min(total, HAND_LOG * Math.min(t, SKY_RUN));
    return steady + Math.max(0, total - HAND_LOG * SKY_RUN) * smoothstep(0, SKY_RUN, t);
}

// How much of the star's distance from the centre of the screen is left at t
export function handOffCentre(t) {
    return 1 - smootherstep(0, CENTRE_RUN, t);
}

// ---------- Every notch shows ----------
// Along t the star does nearly all its growing in the first half, and in the last fifth the camera has arrived and only the
// orbits and planets fade in. A wheel moving t evenly would stick there and rush in the middle. So a hand moves "seen"
// progress instead: part how far the star has grown, part t itself, so that the fading in still takes a notch or so. t is
// read back from it. Only how many notches each part takes changes: every frame of the move looks as it did.
const SEEN_SIZE = 0.6;              // The share of seen progress that is the star's growth
const SEEN_STEPS = 256;
const seenTable = new Float64Array(SEEN_STEPS + 1);
for (let i = 0; i <= SEEN_STEPS; i++) {
    const t = i / SEEN_STEPS;
    seenTable[i] = SEEN_SIZE * handApproach(easeProgress(t), HAND_ARRIVE) + (1 - SEEN_SIZE) * t;
}

// Seen progress at t, 0 to 1
export function handSeen(t) {
    const x = Math.max(0, Math.min(1, t)) * SEEN_STEPS;
    const i = Math.min(SEEN_STEPS - 1, Math.floor(x));
    return seenTable[i] + (seenTable[i + 1] - seenTable[i]) * (x - i);
}

// And back: the t that has this seen progress
export function handTAt(seen) {
    const s = Math.max(0, Math.min(1, seen));
    let lo = 0;
    let hi = SEEN_STEPS;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (seenTable[mid] <= s) lo = mid;
        else hi = mid;
    }
    const span = seenTable[hi] - seenTable[lo];
    return (lo + (span > 0 ? (s - seenTable[lo]) / span : 0)) / SEEN_STEPS;
}
