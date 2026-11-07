// Subtract star: for a planet, divides the host star's light out of the spectrum, leaving only the planet's own features.
// Its button is the switch: the star's light is gone while the tool is open, and it stays gone from planet to planet.

import { registerTool } from './index.js';
import { el } from '../../plot2d.js';
import { para } from './common.js';

function mount(container, api) {
    const status = el('p', { class: 'spectro-tool-line', role: 'status', text: 'The host star\'s light is removed.' });
    const explain = para('Most of a planet\'s light is reflected starlight, so the star\'s lines are all through it. Removing the star leaves the dips and rises that belong to the planet.');
    container.append(status, explain);

    return {
        setEntity() {
            api.setBodyOpts({ subtractHost: true });
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
