// The small legend at the bottom left of the sky: which band this is, whether its colours are false, what glows in it and why,
// and the colour ramp. It collapses to one line, and starts that way on phones so that it doesn't crowd the view.

import { bus } from '../core/state.js';
import { BAND_INFO, bandRampColour } from '../core/bands.js';
import { blackBodyRGB } from '../core/phys.js';
import { termHtml } from '../content/glossary.js';

const NARROW_SCREEN = '(max-width: 640px)';

// Inside a planetary system the same band says what shows up close (render/system/band_look.js, planet_bands.js)
const IN_SYSTEM = {
    radio: 'Giant planets with strong magnetic fields glow at their poles, active stars flare, and jets and pulsar beams shine. Quiet stars are dim.',
    ir: 'Heat glows here. Cool stars and hot planets are bright, the day side brighter than the night. Cold worlds are dim.',
    visible: 'Starlight, and planets lit by their star, in the colours your eyes would see.',
    uv: 'Hot stars blaze. Hazy air reflects this light, and auroras ring the poles of giant planets. Bare rock is dark.',
    xray: 'Gas at millions of degrees: a star\'s corona, flares, and gas falling onto a star or a black hole. Planets show almost nothing.'
};

// The sky's own tone mapping (render/engine.js), so that the ramp shows the colours the sky really has
function toCss(linear) {
    const channel = (x) => {
        const c = Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
        return Math.round(255 * c ** (1 / 2.2));
    };
    return `rgb(${linear.map(channel).join(', ')})`;
}

function rampGradient(band) {
    const stops = BAND_INFO[band].falseColour
        ? [0.02, 0.08, 0.2, 0.42, 0.7, 1].map((i) => toCss(bandRampColour(band, i)))
        : [2800, 3800, 5200, 7000, 11000, 25000].map((T) => toCss(blackBodyRGB(T))); // Visible: true star colours
    return `linear-gradient(to right, ${stops.join(', ')})`;
}

export function initLegend(app) {
    const host = document.getElementById('spectroLegend');
    if (!host) return null;

    const startOpen = !(typeof matchMedia === 'function' && matchMedia(NARROW_SCREEN).matches);
    termHtml('false colour'); // Sets up the shared tip, which the tag below uses: it opens on hover, focus and tap
    host.innerHTML = `
        <div class="spectro-legend-head">
            <button type="button" class="spectro-legend-toggle" aria-expanded="${startOpen}" aria-controls="spectroLegendBody">
                <span class="spectro-legend-hidden">Legend for this band: </span>
                <span class="spectro-legend-name"></span>
                <span class="spectro-legend-chevron" aria-hidden="true"></span>
            </button>
            <span class="spectro-legend-tag spectro-term" tabindex="0" role="note" data-tip="These colours are not what your eyes would see. They stand for light we can't see." aria-label="False colour. These colours are not what your eyes would see. They stand for light we can't see.">False colour</span>
        </div>
        <div class="spectro-legend-body" id="spectroLegendBody" aria-live="polite">
            <p class="spectro-legend-text"></p>
            <div class="spectro-legend-ramp" aria-hidden="true"></div>
            <div class="spectro-legend-scale"><span class="spectro-legend-low"></span><span class="spectro-legend-high"></span></div>
        </div>`;

    const toggle = host.querySelector('.spectro-legend-toggle');
    const body = host.querySelector('.spectro-legend-body');
    const name = host.querySelector('.spectro-legend-name');
    const tag = host.querySelector('.spectro-legend-tag');
    const text = host.querySelector('.spectro-legend-text');
    const ramp = host.querySelector('.spectro-legend-ramp');
    const low = host.querySelector('.spectro-legend-low');
    const high = host.querySelector('.spectro-legend-high');

    function setOpen(open) {
        toggle.setAttribute('aria-expanded', String(open));
        body.hidden = !open;
    }

    function show(band) {
        const info = BAND_INFO[band];
        name.textContent = info.label;
        if (!info.falseColour && document.activeElement === tag) toggle.focus({ preventScroll: true });
        tag.hidden = !info.falseColour;
        text.textContent = app.view === 'system' ? IN_SYSTEM[band] : info.legend;
        ramp.style.background = rampGradient(band);
        low.textContent = info.falseColour ? 'Faint' : 'Cool stars';
        high.textContent = info.falseColour ? 'Bright' : 'Hot stars';
    }

    toggle.addEventListener('click', () => setOpen(body.hidden));
    const offBand = bus.on('band', ({ band }) => show(band));
    const offView = bus.on('view', () => show(app.band));

    setOpen(startOpen);
    show(app.band);

    return {
        setOpen,
        dispose() {
            offBand();
            offView();
            host.innerHTML = '';
        }
    };
}
