// What a time series' results say, as DOM: each star's period and speed swing, then the sums that turn those into masses,
// set out in visible steps. An unseen companion's minimum mass and the "more than about 3 solar masses" conclusion for a
// black hole; a pair's masses through Kepler's third law where both of its stars can be followed.

import { G, M_SUN } from '../../../core/phys.js';
import { sci, sig } from '../../../core/format.js';
import { massFunction, minimumUnseenMass, pairMasses } from '../../../spectra/measure.js';
import { el, markerIcon } from '../../plot2d.js';
import { para, resultLine, steps } from './common.js';

const NEUTRON_STAR_LIMIT = 3;    // Solar masses: the most a neutron star can be

function valueErr(value, err, unit) {
    const step = 10 ** Math.floor(Math.log10(Math.max(err, 1e-9)));
    const digits = Math.max(0, -Math.floor(Math.log10(step)));
    const round = (x) => (Math.round(x / step) * step).toFixed(digits);
    return `${round(value)} ± ${round(Math.max(err, step))} ${unit}`;
}

function periodTable(stars, shapes) {
    const rows = stars.map((star, s) => el('tr', {},
        el('td', {}, markerIcon(shapes[s % shapes.length], { hollow: true }), ` ${star.code}`),
        el('td', { text: star.fit ? valueErr(star.fit.period_days, star.fit.err_period_days, 'days') : 'Not yet' }),
        el('td', { text: star.fit ? valueErr(star.fit.K_kms, star.fit.err_K_kms, 'km/s') : 'Not yet' })));
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

function pairSums(a, b) {
    const P = 0.5 * (a.fit.period_days + b.fit.period_days);
    const seconds = P * 86400;
    const K1 = a.fit.K_kms;
    const K2 = b.fit.K_kms;
    const m = pairMasses(P, K1, K2);
    return [
        el('h4', { class: 'spectro-tool-heading', text: `Masses of ${a.code} and ${b.code}` }),
        steps([
            `Their shared period: T = ${sig(P, 3)} days = ${sci(seconds, 3)} s`,
            `They swing in opposite senses, and the sum of their swings is their speed around each other: v = ${sig(K1, 3)} + ${sig(K2, 3)} = ${sig(K1 + K2, 3)} km/s`,
            `Their separation from v = 2πr ÷ T: r = vT ÷ 2π = ${sig(m.separation_AU, 3)} AU, or ${sci(m.separation_AU * 1.495978707e11, 3)} m`,
            `Kepler's third law: r³ ÷ T² = GM ÷ 4π², so M = 4π²r³ ÷ GT² = ${sig(m.total_Msun, 3)} M☉ together`,
            `The heavier star moves less: mass ratio = ${sig(K2, 3)} ÷ ${sig(K1, 3)} = ${sig(m.ratio, 3)}`
        ]),
        resultLine(`${a.code}: ${sig(m.m1_Msun, 2)} M☉, ${b.code}: ${sig(m.m2_Msun, 2)} M☉`, true),
        para('These are minimum masses, for a circular orbit seen edge on. Only motion along your line of sight shows, so if the orbit is tilted the true masses are larger: speeds look smaller by sin i, and masses by sin³ i.')
    ];
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
        if (a && b && a.fit && b.fit && Math.abs(a.fit.period_days / b.fit.period_days - 1) < 0.05) out.push([a, b]);
    });
    return out;
}

export function orbitResults({ resolved, stars, shapes, covered, span }) {
    const { body } = resolved;
    const any = stars.some((s) => s.fit);
    const items = [];
    if (!any) {
        items.push(para(covered
            ? `No regular swing shows in ${sig(span, 3)} days. An orbit slower than this looks like a slow drift, so try a longer time.`
            : 'The period appears once more than one full swing has gone by.'));
        return items;
    }
    items.push(periodTable(stars, shapes));
    const waiting = stars.some((s) => !s.fit);
    if (waiting && covered) {
        items.push(para('A star marked Not yet is moving too slowly to show a full swing in this time. Try a longer time, if the list offers one.'));
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
    pairs.forEach(([a, b]) => items.push(...pairSums(a, b)));
    if (!pairs.length && stars.length === 1) {
        items.push(para('Show both stars of the pair, and masses can be worked out from their two swings.'));
    }
    if (body.pairs && stars.length === 4) {
        items.push(para('Four sets of lines, with two different periods: these are two close pairs. Use Stars shown to look at one pair at a time.'));
    }
    return items;
}
