// The marker for where a system is in its orbit: each orbit seen from above, with you at the bottom, so a star on the upper
// side is further away. An arrow on each star shows it coming towards you or going away, which is what moves its spectral
// lines. Beside it, the same in words. Shapes match the Time series marks, so colour is never the only thing telling stars apart.

import { componentStates, visibleShares } from '../../../data/orbits.js';
import { danceTimescale, danceReachAU, danceCentreAU, danceInfo } from '../../../data/unstable.js';
import { blackBodyCss, createFigure, drawMarker, fontOf } from '../../plot2d.js';

export const STAR_SHAPES = ['circle', 'square', 'triangle', 'diamond'];

const RAD = Math.PI / 180;
const TRACE_POINTS = 72;
const HEIGHT = 112;
const LEGEND_WIDTH = 190;
const STAR_R = 4.2;
const ACROSS_SHARE = 0.25;       // Below this share of its top speed, a star is moving across your view
const FAR_APART_SHARE = 0.75;

// Red for going away and blue for coming towards you, the way lines move. Arrows carry the same meaning by direction.
const AWAY = '#d1495b';
const TOWARDS = '#2f7ed8';

function massOf(body, group) {
    return group.reduce((sum, i) => sum + body.stars[i].star.mass_Msun, 0);
}

function centre(body, states, group) {
    const mass = massOf(body, group);
    const c = { x: 0, y: 0, z: 0, v: 0 };
    group.forEach((i) => {
        const m = body.stars[i].star.mass_Msun / mass;
        c.x += states[i].x_AU * m;
        c.y += states[i].y_AU * m;
        c.z += states[i].z_AU * m;
        c.v += states[i].vlos_kms * m;
    });
    return c;
}

// What each dial shows. place(t) gives each of its members' { x, y, v } around the orbit's centre: x across your view, y away
// from you, v along the line of sight.
function dialsOf(body) {
    if (body.black_hole) {
        const { companion, period_days: period } = body.black_hole;
        return [{
            period,
            members: [{ hole: true }, { code: companion.code, T: companion.star.teff_K, shape: STAR_SHAPES[0] }],
            place(t) {
                return componentStates(body, t).map((s) => ({ x: s.x_AU, y: s.y_AU, v: s.vlos_kms }));
            }
        }];
    }
    const starMember = (i) => ({ code: body.stars[i].code, T: body.stars[i].star.teff_K, shape: STAR_SHAPES[i % STAR_SHAPES.length] });
    if (body.unstable) {
        // No orbit to draw: where each star has been over the last crossing time, seen from above the line of sight
        const inc = body.chaos.inc_deg * RAD;
        const s = Math.sin(inc);
        const c = Math.cos(inc);
        return [{
            period: danceTimescale(body),
            trail: true,
            fits: danceReachAU(body),
            span: [-Math.min(danceInfo(body).today_days, danceTimescale(body)), danceInfo(body).eject_days],
            members: body.stars.map((st, i) => starMember(i)),
            // About the stars that stay, as the system view is (data/unstable.js danceCentreAU)
            place(t) {
                const m = danceCentreAU(body, t);
                return componentStates(body, t).map((q) => ({ x: q.x_AU - m[0], y: (q.y_AU - m[1]) * s - (q.z_AU - m[2]) * c, v: q.vlos_kms }));
            }
        }];
    }
    if (body.figure_eight) {
        return [{
            period: body.figure_eight.period_days,
            members: body.stars.map((s, i) => starMember(i)),
            // Its line of sight runs along the path's long axis, so that axis is drawn upright
            place(t) {
                return componentStates(body, t).map((s) => ({ x: -s.y_AU, y: s.x_AU, v: s.vlos_kms }));
            }
        }];
    }
    const widest = body.orbits[body.orbits.length - 1];
    // A double-double's orbit of pair around pair takes a thousand years: it would only ever show two still dots
    const orbits = body.pairs ? body.orbits.slice(0, -1) : body.orbits;
    return orbits.map((orbit) => {
        const tilt = (orbit.inc_deg - widest.inc_deg) * RAD;
        const massA = massOf(body, orbit.a);
        const massB = massOf(body, orbit.b);
        const side = (group) => (group.length === 1 ? starMember(group[0]) : { pair: true, group });
        return {
            period: orbit.period_days,
            members: [side(orbit.a), side(orbit.b)],
            place(t) {
                const states = componentStates(body, t);
                const a = centre(body, states, orbit.a);
                const b = centre(body, states, orbit.b);
                const shareA = massB / (massA + massB);
                const shareB = massA / (massA + massB);
                const dx = a.x - b.x;
                // Brought back into the orbit's own plane, so that a tilted inner orbit still shows as the circle it is
                const dy = (a.y - b.y) * Math.cos(tilt) + (a.z - b.z) * Math.sin(tilt);
                const dv = a.v - b.v;
                return [
                    { x: dx * shareA, y: dy * shareA, v: dv * shareA },
                    { x: -dx * shareB, y: -dy * shareB, v: -dv * shareB }
                ];
            }
        };
    });
}

// One orbit's paths, its reach and each member's top speed, sampled once. Stars in no stable orbit have trails instead, drawn
// afresh as time goes on (trailFrom), within the reach and at the speeds they have while they dance.
function traced(dial) {
    const paths = dial.members.map(() => new Float32Array(TRACE_POINTS * 2));
    const tops = dial.members.map(() => 0);
    let reach = 0;
    if (dial.trail) {
        const [from, to] = dial.span;
        for (let k = 0; k <= 4 * TRACE_POINTS; k++) {
            dial.place(from + (k / (4 * TRACE_POINTS)) * (to - from)).forEach((p, m) => {
                reach = Math.max(reach, Math.hypot(p.x, p.y));
                tops[m] = Math.max(tops[m], Math.abs(p.v));
            });
        }
        return { ...dial, paths, reach: dial.fits || reach || 1, tops: tops.map((top) => top || 1) };
    }
    for (let k = 0; k < TRACE_POINTS; k++) {
        dial.place((k / TRACE_POINTS) * dial.period).forEach((p, m) => {
            paths[m][2 * k] = p.x;
            paths[m][2 * k + 1] = p.y;
            reach = Math.max(reach, Math.hypot(p.x, p.y));
            tops[m] = Math.max(tops[m], Math.abs(p.v));
        });
    }
    return { ...dial, paths, reach: reach || 1, tops: tops.map((top) => top || 1) };
}

// A point no further out than the dial reaches: a star flung out waits at its edge
function inside(p, reach) {
    const r = Math.hypot(p.x, p.y);
    const k = r > reach ? reach / r : 1;
    return { x: p.x * k, y: p.y * k, v: p.v };
}

// Where each star has been over the last dial.period, up to time
function trailFrom(dial, time) {
    for (let k = 0; k < TRACE_POINTS; k++) {
        dial.place(Math.max(dial.span[0], time - dial.period * (1 - k / (TRACE_POINTS - 1)))).forEach((p, m) => {
            const q = inside(p, dial.reach);
            dial.paths[m][2 * k] = q.x;
            dial.paths[m][2 * k + 1] = q.y;
        });
    }
}

function motionWord(v, top) {
    if (Math.abs(v) < ACROSS_SHARE * top) return 'moving across';
    return v > 0 ? 'going away' : 'coming towards you';
}

// What the lines are doing, from the star that says it best
function linesWord(dial, t) {
    const now = dial.place(t);
    const shown = dial.members.findIndex((m) => !m.hole);
    const share = Math.abs(now[shown].v) / dial.tops[shown];
    if (dial.members.some((m) => m.hole)) {
        if (share < ACROSS_SHARE) return 'Lines mid-swing';
        return now[shown].v > 0 ? 'Lines shifted to the red' : 'Lines shifted to the blue';
    }
    if (share >= FAR_APART_SHARE) return 'Lines far apart';
    if (share < ACROSS_SHARE) return 'Lines crossing';
    const soon = Math.abs(dial.place(t + dial.period / 100)[shown].v) / dial.tops[shown];
    return soon > share ? 'Lines moving apart' : 'Lines closing up';
}

function arrow(ctx, x, y, length, colour) {
    const tip = y - length;
    const barb = Math.sign(length) * Math.min(3.2, Math.abs(length) * 0.6);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, tip);
    ctx.moveTo(x - 2.6, tip + barb);
    ctx.lineTo(x, tip);
    ctx.lineTo(x + 2.6, tip + barb);
    ctx.stroke();
}

function drawMember(ctx, member, x, y, theme) {
    if (member.hole) {
        drawMarker(ctx, 'circle', x, y, 3.6, { fill: '#000000', stroke: theme.strong, width: 1.4 });
    } else if (member.pair) {
        // A close pair seen from out here: two dots nearly touching
        drawMarker(ctx, 'circle', x - 2.6, y, 2.6, { fill: theme.paper, stroke: theme.strong, width: 1.2 });
        drawMarker(ctx, 'circle', x + 2.6, y, 2.6, { fill: theme.paper, stroke: theme.strong, width: 1.2 });
    } else {
        drawMarker(ctx, member.shape, x, y, STAR_R, { fill: blackBodyCss(member.T), stroke: theme.strong, width: 1.2 });
    }
}

export function createOrbitDial(parent, body) {
    const dials = dialsOf(body).map(traced);
    const eclipses = !!visibleShares(body, 0);
    let time = 0;
    let spoken = '';

    const figure = createFigure(parent, {
        label: 'Where the stars are in their orbit',
        height: () => HEIGHT,
        draw(ctx, { width, height, theme }) {
            const count = dials.length;
            const room = Math.max(60 * count, width - LEGEND_WIDTH);
            const radius = Math.max(24, Math.min(42, Math.floor((room - 12 * (count - 1) - 8) / (2 * count))));
            const centreY = 6 + radius;
            const words = [];

            dials.forEach((dial, n) => {
                const cx = 4 + radius + n * (2 * radius + 12);
                const s = (radius - 5) / dial.reach;
                // Line of sight down to you
                ctx.strokeStyle = theme.border;
                ctx.lineWidth = 1;
                ctx.setLineDash([2, 3]);
                ctx.beginPath();
                ctx.moveTo(cx, centreY - radius);
                ctx.lineTo(cx, height - 16);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.font = fontOf(theme, 11);
                ctx.fillStyle = theme.text;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'alphabetic';
                ctx.fillText('you', cx, height - 4);
                // Paths, or the trails of stars in no stable orbit, kept inside the dial
                if (dial.trail) trailFrom(dial, time);
                ctx.strokeStyle = theme.border;
                ctx.lineWidth = 1.2;
                dial.paths.forEach((path) => {
                    ctx.beginPath();
                    for (let k = 0; k < TRACE_POINTS; k++) {
                        const x = cx + path[2 * k] * s;
                        const y = centreY - path[2 * k + 1] * s;
                        if (k === 0) ctx.moveTo(x, y);
                        else ctx.lineTo(x, y);
                    }
                    if (!dial.trail) ctx.closePath();
                    ctx.stroke();
                });
                // Stars
                const now = dial.place(time).map((p) => (dial.trail ? inside(p, dial.reach) : p));
                dial.members.forEach((member, m) => {
                    const p = now[m];
                    const x = cx + p.x * s;
                    const y = centreY - p.y * s;
                    const share = p.v / dial.tops[m];
                    if (Math.abs(share) > 0.12) arrow(ctx, x, y, share * 16, p.v > 0 ? AWAY : TOWARDS);
                    drawMember(ctx, member, x, y, theme);
                    if (member.code) words.push({ member, text: `${member.code}: ${motionWord(p.v, dial.tops[m])}` });
                });
            });

            // The words beside it. Several orbits at once have no one thing to say about the lines.
            const left = 4 + count * (2 * radius + 12) + 4;
            let lines = count > 1 || dials[0].members.length > 2 ? '' : linesWord(dials[0], time);
            if (eclipses) {
                const seen = visibleShares(body, time);
                const hidden = seen.findIndex((share) => share < 0.999);
                if (hidden >= 0) lines = `${body.stars[hidden].code} in eclipse`;
            }
            let y = 14;
            if (lines) {
                ctx.font = fontOf(theme, 12.5, 700);
                ctx.fillStyle = theme.strong;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(lines, left, y, width - left);
                y += 19;
            }
            ctx.font = fontOf(theme, 12);
            words.forEach(({ member, text }) => {
                drawMember(ctx, member, left + 5, y, theme);
                ctx.fillStyle = theme.text;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                // The given width squeezes the words to fit a narrow panel rather than losing their end
                ctx.fillText(text, left + 15, y + 0.5, width - left - 15);
                y += 17;
            });
            const speech = `Where the stars are in their orbit. ${lines ? `${lines}. ` : ''}${words.map((w) => w.text).join('; ')}.`;
            if (speech !== spoken) {
                spoken = speech;
                figure.setLabel(speech);
            }
        }
    });
    figure.wrap.classList.add('spectro-orbit-dial');

    return {
        set(t) {
            time = t;
            figure.redraw();
        },
        dispose() {
            figure.wrap.remove();
        }
    };
}
