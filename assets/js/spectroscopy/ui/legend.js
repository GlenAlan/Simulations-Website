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

// A system with no planets says only what it has: one star or several, a black hole and what feeds it, a galaxy's centre, or
// a neutron star
const STARS_ONLY = {
    radio: 'Active stars flare here. Quiet stars are dim.',
    ir: 'Heat glows here. Cool stars are bright, and hot stars dimmer than they look to your eye.',
    visible: 'Starlight, in the colours your eyes would see.',
    uv: 'Hot stars blaze, and cool stars are dim.',
    xray: 'Gas at millions of degrees: a star\'s corona and its flares, and any gas falling from one star onto another.'
};

const BLACK_HOLE = {
    radio: 'Jets from near the black hole shine, when it has them. Its companion star is dim.',
    ir: 'Heat glows here: the companion star, and the cooler outside of the disc of gas round the black hole.',
    visible: 'The companion star, and the hot disc of gas it feeds to the black hole, in the colours your eyes would see. The hole itself gives out no light.',
    uv: 'The inner disc of gas round the black hole glows brightly, hotter than almost any star.',
    xray: 'Gas at millions of degrees, falling onto the black hole: the brightest thing here. The hole itself gives out no light.'
};

const NUCLEUS = {
    radio: 'Jets from near the black hole shine, when it has them. The stars are dim.',
    ir: 'Heat glows here: the stars, and dust warmed by the gas falling into the black hole.',
    visible: 'The stars on close orbits, and the gas falling into the black hole, in the colours your eyes would see. The hole itself gives out no light.',
    uv: 'Gas falling into the black hole blazes, when it is feeding. Cool stars are dim.',
    xray: 'Gas at millions of degrees, falling into the black hole. The hole itself gives out no light.'
};

const PULSAR = {
    radio: 'The pulsar\'s beams shine here as they sweep round. The star itself is dark.',
    ir: 'A neutron star gives out almost no infrared: it is tiny, and most of its light is X-rays.',
    visible: 'A neutron star, hot but only a few kilometres across. Its beams are drawn so you can see it turn.',
    uv: 'The neutron star\'s hot surface glows here.',
    xray: 'The neutron star\'s hot surface shines brightest here, and its beams sweep round.'
};

const NEUTRON_STAR = {
    ...PULSAR,
    radio: 'A neutron star with no beams pointing our way is dark here.',
    visible: 'A neutron star, hot but only a few kilometres across, so it gives out very little light.',
    xray: 'The neutron star\'s hot surface shines brightest here.'
};

// The words for what the system view has on show
function systemWords(app, code) {
    const resolved = code && app.universe ? app.universe.resolve(code) : null;
    if (!resolved) return IN_SYSTEM;
    let body = resolved.body;
    try {
        if (app.system && app.system.systemOf) body = app.system.systemOf(resolved) || body;
    } catch (err) { /* The selection's own body will do */ }
    if (!body) return IN_SYSTEM;
    if (body.kind === 'nucleus') return NUCLEUS;
    if (body.black_hole) return BLACK_HOLE;
    if (body.neutron_star) return body.neutron_star.pulsar ? PULSAR : NEUTRON_STAR;
    return body.planets && body.planets.length ? IN_SYSTEM : STARS_ONLY;
}

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

    let systemCode = null;
    function show(band) {
        const info = BAND_INFO[band];
        name.textContent = info.label;
        if (!info.falseColour && document.activeElement === tag) toggle.focus({ preventScroll: true });
        tag.hidden = !info.falseColour;
        const inSystem = systemCode ? true : app.view === 'system';
        text.textContent = inSystem ? systemWords(app, systemCode || app.systemCode)[band] : info.legend;
        ramp.style.background = rampGradient(band);
        low.textContent = info.falseColour ? 'Faint' : 'Cool stars';
        high.textContent = info.falseColour ? 'Bright' : 'Hot stars';
    }

    toggle.addEventListener('click', () => setOpen(body.hidden));
    const offBand = bus.on('band', ({ band }) => show(band));
    const offView = bus.on('view', (e) => {
        systemCode = e && e.view === 'system' ? e.code : null;
        show(app.band);
    });

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
