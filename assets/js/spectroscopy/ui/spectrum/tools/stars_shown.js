// Stars shown: picks which stars of a multi-star system make up the spectrum: all of them, one pair, or one star. So the
// four sets of lines of a double-double can be untangled step by step. Stays open beside the other tools.

import { registerTool } from './index.js';
import { el } from '../../plot2d.js';
import { para } from './common.js';

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

function mount(container, api) {
    const name = `spectroStars${++nextId}`;
    const hint = para('See what each star adds. Pick one pair or star, and every other tool here works on just that light.');
    const group = el('fieldset', { class: 'spectro-tool-options' }, el('legend', { text: 'Show the light of' }));
    container.append(hint, group);

    function render(body) {
        const options = [{ label: `All ${body.stars.length} stars`, codes: null }];
        closePairs(body).forEach((p) => options.push(p));
        body.stars.forEach((s) => options.push({ label: `Star ${s.code}`, codes: [s.code] }));
        group.replaceChildren(group.firstChild);
        options.forEach((option, i) => {
            const id = `${name}-${i}`;
            const input = el('input', { type: 'radio', id, name, value: String(i) });
            input.checked = i === 0;
            input.addEventListener('change', () => api.setBodyOpts({ parts: option.codes }));
            group.append(el('div', { class: 'spectro-tool-option' }, input, el('label', { for: id, text: option.label })));
        });
    }

    return {
        setEntity(resolved) {
            render(resolved.body);
        },
        dispose() {
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
