// Stars shown: picks which stars of a multi-star system make up the spectrum: all of them, one pair, or one star. So the
// four sets of lines of a double-double can be untangled step by step. Each choice carries its share of the light across the
// wavelengths on screen, which is why a hot star rules the blue and a cool one the red, and why a faint star's lines can't be
// picked out of the sum. Stays open beside the other tools.

import { registerTool } from './index.js';
import { wavelength } from '../../../core/format.js';
import { eclipsingOrbits } from '../../../data/orbits.js';
import { el } from '../../plot2d.js';
import { para } from './common.js';
import { clockFor } from './orbit_clock.js';
import { lightShares } from './star_light.js';

const FAINT_SHARE = 0.01;        // Under this, a star's lines are lost in the sum
const SAME_TEMPERATURE = 1.1;    // Stars this close in temperature share out the light alike at every wavelength

let nextId = 0;

// Pairs that orbit each other closely, from the system's own list of orbits
function closePairs(body) {
    if (body.pairs) return body.pairs.map((p) => ({ label: `Pair ${p.label}: ${p.codes.join(' and ')}`, codes: p.codes }));
    const stars = body.stars;
    return (body.orbits || [])
        .filter((o) => o.a && o.b && o.a.length === 1 && o.b.length === 1 && stars.length > 2)
        .map((o) => {
            const codes = [stars[o.a[0]].code, stars[o.b[0]].code];
            return { label: `Close pair: ${codes.join(' and ')}`, codes };
        });
}

function shareText(share) {
    if (share >= 0.995 && share < 1) return 'over 99%';
    if (share > 0 && share < FAINT_SHARE) return 'under 1%';
    return `${Math.round(share * 100)}%`;
}

function mount(container, api) {
    const { plot } = api;
    const name = `spectroStars${++nextId}`;
    const hint = para('See what each star adds. Pick one pair or star, and every other tool here works on just that light.');
    const group = el('fieldset', { class: 'spectro-tool-options' }, el('legend', { text: 'Show the light of' }));
    const range = para('', 'spectro-tool-text spectro-share-range');
    const why = para('A hotter star gives more of its light in the blue and a cooler one more in the red. Try the UV and Near-IR ranges under the plot and watch the shares change.');
    const faint = para('');
    container.append(hint, group, range, why, faint);

    let body = null;
    let rows = [];
    let offClock = null;

    function render() {
        const options = [{ label: `All ${body.stars.length} stars`, codes: null }];
        closePairs(body).forEach((p) => options.push(p));
        body.stars.forEach((s) => options.push({ label: `Star ${s.code}`, codes: [s.code] }));
        group.replaceChildren(group.firstChild);
        rows = options.map((option, i) => {
            const id = `${name}-${i}`;
            const input = el('input', { type: 'radio', id, name, value: String(i) });
            input.checked = i === 0;
            input.addEventListener('change', () => api.setBodyOpts({ parts: option.codes }));
            const fillBar = el('span', { class: 'spectro-share-fill' });
            const value = el('span', { class: 'spectro-share-value' });
            const label = el('label', { for: id }, el('span', { class: 'spectro-share-name', text: option.label }));
            if (option.codes) label.append(el('span', { class: 'spectro-share', 'aria-hidden': 'true' }, el('span', { class: 'spectro-share-bar' }, fillBar)), value);
            group.append(el('div', { class: 'spectro-tool-option' }, input, label));
            return { codes: option.codes, fillBar, value };
        });
    }

    function paintShares() {
        if (!body) return;
        const { lo, hi } = plot.getRange();
        const shares = lightShares(body, lo, hi, clockFor(body).steppedT());
        rows.forEach(({ codes, fillBar, value }) => {
            if (!codes) return;
            const share = shares.filter((s) => codes.includes(s.code)).reduce((sum, s) => sum + s.share, 0);
            fillBar.style.width = `${(100 * share).toFixed(1)}%`;
            const text = shareText(share);
            if (value.textContent !== text) value.textContent = text;
        });
        range.textContent = `Shares are of the light from ${wavelength(lo)} to ${wavelength(hi)}, the range on the plot.`;
        const lost = shares.filter((s) => s.share < FAINT_SHARE).map((s) => s.code);
        faint.hidden = !lost.length;
        if (lost.length) {
            const names = lost.length < 2 ? `Star ${lost[0]} gives` : `Stars ${lost.join(' and ')} each give`;
            faint.textContent = `${names} under 1% of the light here, so ${lost.length < 2 ? 'its' : 'their'} lines can't be picked out of the combined spectrum. Show ${lost.length < 2 ? 'it' : 'them'} alone to see them.`;
        }
    }

    const offRange = plot.onRangeChange(paintShares);

    return {
        setEntity(resolved) {
            body = resolved.body;
            render();
            const temperatures = body.stars.map((s) => s.star.teff_K);
            why.hidden = Math.max(...temperatures) / Math.min(...temperatures) < SAME_TEMPERATURE;
            if (offClock) offClock();
            // Only an eclipse moves the shares as the clock runs
            offClock = eclipsingOrbits(body).length ? clockFor(body).onStep(paintShares) : null;
            paintShares();
        },
        dispose() {
            offRange();
            if (offClock) offClock();
            api.setBodyOpts({ parts: null });
        }
    };
}

registerTool({
    id: 'stars-shown',
    label: 'Stars shown',
    appliesTo: (resolved) => resolved.path === 'body' && !!resolved.body.stars && resolved.body.stars.length > 1,
    mount
});
