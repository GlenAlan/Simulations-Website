// What a time series' results say, as DOM: each star's period and speed swing, then the sums that turn those into masses,
// set out in visible steps. An unseen companion's minimum mass and the "more than about 3 solar masses" conclusion for a
// black hole; a pair's masses through Kepler's third law where both of its stars can be followed.

import { G, M_SUN } from '../../../core/phys.js';
import { sci, sig } from '../../../core/format.js';
import { massFunction, minimumUnseenMass, pairMasses } from '../../../spectra/measure.js';
import { el, markerIcon } from '../../plot2d.js';
import { para, resultLine, steps } from './common.js';

const NEUTRON_STAR_LIMIT = 3;    // Solar masses: the most a neutron star can be
const LOPSIDED_ECC = 0.1;        // Less oval than this, the swing still looks even and the sums are within a couple of per cent

function valueErr(value, err, unit) {
    const step = 10 ** Math.floor(Math.log10(Math.max(err, 1e-9)));
    const digits = Math.max(0, -Math.floor(Math.log10(step)));
    const round = (x) => (Math.round(x / step) * step).toFixed(digits);
    return `${round(value)} ± ${round(Math.max(err, step))} ${unit}`;
}

function periodTable(stars) {
    const blank = (star) => (star.tooFast ? 'Too fast here' : 'Not yet');
    const rows = stars.map((star) => el('tr', {},
        el('td', {}, markerIcon(star.shape, { hollow: true }), ` ${star.code}`),
        el('td', { text: star.fit ? valueErr(star.fit.period_days, star.fit.err_period_days, 'days') : blank(star) }),
        el('td', { text: star.fit ? valueErr(star.fit.K_kms, star.fit.err_K_kms, 'km/s') : blank(star) })));
    return el('table', { class: 'spectro-tool-table' },
        el('thead', {}, el('tr', {},
            el('th', { scope: 'col', text: 'Star' }),
            el('th', { scope: 'col', text: 'Period' }),
            el('th', { scope: 'col', text: 'Speed swing, K' }))),
        el('tbody', {}, ...rows));
}

function blackHoleSums(star, companionMass) {
    const { period_days: P, err_period_days: errP, K_kms: K, err_K_kms: errK } = star.fit;
    const seconds = P * 86400;
    const metres = K * 1000;
    const mf = massFunction(P, errP, K, errK);
    const M = minimumUnseenMass(mf.f_Msun, companionMass);
    const hi = minimumUnseenMass(mf.f_Msun + mf.err_Msun, companionMass);
    const lo = minimumUnseenMass(Math.max(1e-6, mf.f_Msun - mf.err_Msun), companionMass);
    const errM = Math.max(hi - M, M - lo, 0.05 * M);
    const inKg = mf.f_Msun * M_SUN;
    const heavy = M - errM > NEUTRON_STAR_LIMIT;
    return [
        el('h4', { class: 'spectro-tool-heading', text: 'What the unseen partner weighs' }),
        steps([
            `Period: P = ${valueErr(P, errP, 'days')} = ${sci(seconds, 3)} s`,
            `The visible star's speed swing: K = ${valueErr(K, errK, 'km/s')} = ${sci(metres, 3)} m/s`,
            `Mass function: f = PK³ ÷ 2πG = (${sci(seconds, 3)} s) × (${sci(metres, 3)} m/s)³ ÷ (2π × ${sci(G, 3)} N·m²/kg²) = ${sci(inKg, 3)} kg = ${valueErr(mf.f_Msun, mf.err_Msun, 'M☉')}. The unseen mass can't be less than this.`,
            `The visible star's mass, from its spectral class: m = ${sig(companionMass, 2)} M☉`,
            `Taking the orbit as edge on, which gives the least it can be: M³ ÷ (M + m)² = f gives M = ${valueErr(M, errM, 'M☉')}`
        ]),
        resultLine(`At least ${valueErr(M, errM, 'M☉')}`, true),
        para(heavy
            ? `That is above about ${NEUTRON_STAR_LIMIT} M☉, the most a neutron star can be, and nothing here shines with the light of a star that heavy. It must be a black hole.`
            : `That is not clearly above about ${NEUTRON_STAR_LIMIT} M☉, so this alone doesn't prove a black hole. The true mass is larger if the orbit is tilted towards us, which it almost always is.`)
    ];
}

// A star's mass goes as P (K1 + K2)^2 times the other star's K, so its uncertainty follows from theirs
function massError(mass, P, errP, sum, otherK, errOtherK, errOwnK) {
    return mass * Math.hypot(errP / P, (2 / sum) * errOwnK, (2 / sum + 1 / otherK) * errOtherK);
}

function pairSums(a, b, oval) {
    const P = 0.5 * (a.fit.period_days + b.fit.period_days);
    const errP = 0.5 * Math.hypot(a.fit.err_period_days, b.fit.err_period_days);
    const seconds = P * 86400;
    const K1 = a.fit.K_kms;
    const K2 = b.fit.K_kms;
    const m = pairMasses(P, K1, K2);
    const err1 = massError(m.m1_Msun, P, errP, K1 + K2, K2, b.fit.err_K_kms, a.fit.err_K_kms);
    const err2 = massError(m.m2_Msun, P, errP, K1 + K2, K1, a.fit.err_K_kms, b.fit.err_K_kms);
    return [
        el('h4', { class: 'spectro-tool-heading', text: `Masses of ${a.code} and ${b.code}` }),
        steps([
            `Their shared period: T = ${sig(P, 3)} days = ${sci(seconds, 3)} s`,
            `They swing in opposite senses, and the sum of their swings is their speed around each other: v = ${sig(K1, 3)} + ${sig(K2, 3)} = ${sig(K1 + K2, 3)} km/s`,
            `Their separation from v = 2πr ÷ T: r = vT ÷ 2π = ${sig(m.separation_AU, 3)} AU, or ${sci(m.separation_AU * 1.495978707e11, 3)} m`,
            `Kepler's third law: r³ ÷ T² = GM ÷ 4π², so M = 4π²r³ ÷ GT² = ${sig(m.total_Msun, 3)} M☉ together`,
            `The heavier star moves less: mass ratio = ${sig(K2, 3)} ÷ ${sig(K1, 3)} = ${sig(m.ratio, 3)}`
        ]),
        resultLine(`${a.code}: ${valueErr(m.m1_Msun, err1, 'M☉')}, ${b.code}: ${valueErr(m.m2_Msun, err2, 'M☉')}`, true),
        para('These are minimum masses, for a circular orbit seen edge on. Only motion along your line of sight shows, so if the orbit is tilted the true masses are larger: speeds look smaller by sin i, and masses by sin³ i.'),
        oval ? para('This swing is lopsided, because the orbit is oval and not a circle. These sums take no account of that, so here they come out somewhat too high.') : null
    ].filter(Boolean);
}

// Pairs in which both stars are followed and share a period
function followedPairs(body, stars) {
    if (!body.orbits) return [];
    const byCode = new Map(stars.map((s) => [s.code, s]));
    const out = [];
    body.orbits.forEach((orbit) => {
        if (!orbit.a || !orbit.b || orbit.a.length !== 1 || orbit.b.length !== 1) return;
        const a = byCode.get(body.stars[orbit.a[0]].code);
        const b = byCode.get(body.stars[orbit.b[0]].code);
        if (a && b && a.fit && b.fit && Math.abs(a.fit.period_days / b.fit.period_days - 1) < 0.05) out.push([a, b, orbit]);
    });
    return out;
}

function namesOf(stars) {
    const codes = stars.map((s) => s.code);
    return codes.length < 2 ? codes.join('') : `${codes.slice(0, -1).join(', ')} and ${codes[codes.length - 1]}`;
}

// Stars in no stable orbit (data/unstable.js): a period only where the readings really repeat, and never the two-body sums.
// A line too broad to find the middle of gives no readings at all, and then that is what it says.
const FEW_READINGS = 12;
function danceResults(stars, covered) {
    if (stars.some((s) => s.fit)) {
        return [
            periodTable(stars),
            para('For now, two of these stars swing round each other as a pair. It won\'t last: these stars aren\'t in stable orbits.')
        ];
    }
    if (covered && stars.every((s) => s.points.length < FEW_READINGS)) {
        return [para('This line is too broad to follow here: hot stars that spin fast have broad lines. Try another line.')];
    }
    return [para(covered
        ? 'No period. The lines shift to and fro, but no swing repeats: these stars aren\'t in stable orbits, so there is no period to find.'
        : 'The lines wander. A period would show once a swing had repeated.')];
}

export function orbitResults({ resolved, stars, covered, span, line, sampleGap }) {
    const { body } = resolved;
    if (body.unstable) return danceResults(stars, covered);
    const any = stars.some((s) => s.fit);
    const tooFast = stars.filter((s) => s.tooFast);
    const items = [];
    if (!any && !tooFast.length) {
        const slow = stars.every((s) => s.tooSlow);
        items.push(para(!covered
            ? 'The period appears once a swing and a half has gone by.'
            : slow
                ? `No regular swing shows in ${sig(span, 3)} days. An orbit slower than this looks like a slow drift, so try a longer time.`
                : 'No regular swing can be measured here. These lines are too broad or too faint for it to stand out from their width.'));
        return items;
    }
    items.push(periodTable(stars));
    // Readings a line apart in time can't follow a swing faster than that, and would fit a false, slower one. So there is no reading.
    if (tooFast.length) {
        const verb = tooFast.length > 1 ? 'go round too fast' : 'goes round too fast';
        items.push(para(`${namesOf(tooFast)} ${verb} to follow at this time scale. Readings here are ${sig(sampleGap, 2)} days apart, so any period read from them would be false. Choose a shorter time to measure ${tooFast.length > 1 ? 'them' : 'it'}.`));
    }
    const waiting = stars.filter((s) => !s.fit && !s.tooFast);
    if (waiting.length && covered) {
        const slow = waiting.filter((s) => s.tooSlow);
        const hard = waiting.filter((s) => !s.tooSlow);
        if (slow.length) items.push(para(`${namesOf(slow)} ${slow.length > 1 ? 'are' : 'is'} moving too slowly to show a full swing in this time. Try a longer time, if the list offers one.`));
        if (hard.length) items.push(para(`The lines of ${namesOf(hard)} are too broad or too faint for ${hard.length > 1 ? 'their swings' : 'its swing'} to stand out from their width.`));
    }
    const elsewhere = line ? stars.filter((s) => s.fit && s.line !== line) : [];
    if (elsewhere.length) {
        items.push(para(`${namesOf(elsewhere)} ${elsewhere.length > 1 ? 'do' : 'does'} not show this line clearly, so ${elsewhere.length > 1 ? 'their figures come from other lines' : `its figures come from another line, at ${elsewhere[0].line.rest_nm.toFixed(1)} nm`}.`));
    }

    if (body.black_hole) {
        const star = stars[0];
        if (star.fit) items.push(...blackHoleSums(star, body.black_hole.companion.star.mass_Msun));
        return items;
    }
    if (body.figure_eight) {
        items.push(para('Three stars share one path, so the two-body sums for masses don\'t apply here. All three take the same time around it, and because they are identical, the pattern of lines repeats three times as often as any one star goes round. Compare it with a normal binary\'s two lines, or a triple\'s two lines and a slow third.'));
        return items;
    }
    const pairs = followedPairs(body, stars);
    pairs.forEach(([a, b, orbit]) => items.push(...pairSums(a, b, orbit.ecc >= LOPSIDED_ECC)));
    if (!pairs.length && stars.length === 1) {
        items.push(para('Show both stars of the pair, and masses can be worked out from their two swings.'));
    }
    if (body.pairs && stars.length === 4) {
        items.push(para('Four sets of lines, with two different periods: these are two close pairs. Use the Stars tool to look at one pair at a time.'));
    }
    return items;
}
