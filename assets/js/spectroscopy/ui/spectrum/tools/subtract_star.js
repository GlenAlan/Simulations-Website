// Subtract star: for a planet, divides the host star's light out of the spectrum, leaving only the planet's own features.
// Its button is the switch: the star's light is gone while the tool is open, and it stays gone from planet to planet.

import { registerTool } from './index.js';
import { el } from '../../plot2d.js';

function mount(container, api) {
    // Short, so the wavelength buttons below it stay in view: going through a planet's bands is what this is for
    container.append(el('p', { class: 'spectro-tool-text', role: 'status', text: 'The host star\'s light is removed, leaving the dips and rises that belong to the planet.' }));

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
