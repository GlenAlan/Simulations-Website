// Subtract star: for a planet, divides the host star's light out of the spectrum, leaving only the planet's own features.

import { registerTool } from './index.js';
import { el } from '../../plot2d.js';
import { para } from './common.js';

let nextId = 0;

function mount(container, api) {
    const id = `spectroSubtract${++nextId}`;
    const input = el('input', { type: 'checkbox', id });
    const label = el('label', { for: id, text: 'Remove the host star\'s light' });
    const explain = para('Most of a planet\'s light is reflected starlight, so the star\'s lines are all through it. Removing the star leaves the dips and rises that belong to the planet.');
    container.append(el('div', { class: 'sim-checkbox-group spectro-tool-check' }, input, label), explain);

    input.addEventListener('change', () => {
        api.setBodyOpts({ subtractHost: input.checked ? true : null });
    });

    return {
        setEntity() {
            input.checked = false;
        },
        dispose() {
            api.setBodyOpts({ subtractHost: null });
        }
    };
}

registerTool({
    id: 'subtract-star',
    label: 'Subtract star',
    appliesTo: (resolved) => resolved.path === 'planet' || resolved.entity.kind === 'planet' || resolved.entity.kind === 'home_planet',
    mount
});
