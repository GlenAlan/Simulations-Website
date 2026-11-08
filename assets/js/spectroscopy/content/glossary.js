// Plain definitions of the technical terms, for tooltips (spec 3.3). The words are pure data; the one tooltip
// element is only made in a browser, the first time a term is wrapped, so this module also loads under Node.
//
//   GLOSSARY[term]              one sentence
//   termHtml(term, label?)      one wrapped term, as an HTML string
//   tipHtml(label, definition)  the same tip for words that aren't in the glossary, such as a row's label
//   codeHtml(code, { fly })     an object's code as a button. ui/info_tab.js answers its click, for the whole drawer.
//   glossaryHtml(text, opts?)   plain text to HTML, with known terms wrapped. Each term is wrapped once only;
//                               pass the same { seen: new Set() } to several calls to keep that true across a panel.

export const GLOSSARY = {
    // Reading a spectrum
    'continuum': 'The smooth background of a spectrum, ignoring the lines.',
    'emission line': 'A bright line at a wavelength where hot, thin gas gives out light.',
    'absorption line': 'A dark line at a wavelength where cooler gas has taken light out of a continuum.',
    'P Cygni profile': 'A bright emission peak with a blueshifted dark dip beside it, the sign of gas rushing outwards.',
    'forbidden line': 'A line, written in square brackets like [O III], that atoms only give out in extremely thin gas, because collisions in denser gas get in first.',
    "Kirchhoff's rules": 'Hot dense matter gives a continuum, hot thin gas gives emission lines, and cooler gas in front of a continuum gives absorption lines.',
    'spectral resolution': 'How fine a detail the instrument can show, written R = λ/Δλ, so a higher R shows narrower features.',
    'unresolved': 'Too small for this instrument to measure, which sets an upper limit rather than meaning zero.',
    'S/N': 'Signal-to-noise ratio: how far the signal stands above random noise, so a higher number means a cleaner spectrum.',
    'uncertainty': 'The ± range a measurement could reasonably be out by.',
    'air wavelength': 'A wavelength as measured in air, the usual convention for lines above 200 nm.',
    'vacuum wavelength': 'A wavelength as measured in a vacuum, the usual convention for lines below 200 nm.',
    'false colour': "Colours chosen to show light your eyes can't see, not what the object would look like.",

    // Temperature and light
    'black body': 'An ideal object that absorbs all light and glows with a spectrum set only by its temperature.',
    "Wien's law": 'A hotter black body peaks at a shorter wavelength: λmax = b/T, with b = 2.898 × 10⁻³ m K.',
    'λmax': "The wavelength where a black body's curve is at its highest. Wien's law turns it into a temperature: T = b/λmax.",

    // Motion
    'Doppler shift': "A change in a wave's wavelength caused by motion along your line of sight.",
    'redshift': 'A shift of lines to longer wavelengths, measured as z = Δλ/λ₀, as the source moves away or space stretches.',
    'blueshift': 'A shift of lines to shorter wavelengths, showing the source is moving towards you.',
    'radial velocity': 'Speed along your line of sight, positive when moving away.',
    'Δλ': 'How far a line has moved from where it sits in the lab: Δλ = λ − λ₀. Positive means towards the red.',
    'z': 'Redshift: how far a line has moved, as a fraction of its lab wavelength, z = Δλ/λ₀. It is negative for a blueshift.',
    'v = cz': 'Speed from redshift, where c is the speed of light. Beyond about 30,000 km/s it is only rough. A quasar\'s light is stretched so far that it would give more than the speed of light, so for quasars the sim uses a formula that stays below it.',
    'v sin i': "The part of a star's spin that you can measure. v is the true speed of its equator, and i is the tilt of its spin axis from your line of sight: 90° means you see it side-on, and 0° pole-on. Only motion towards or away from you shifts light, so you measure v × sin i, which is never more than v.",
    'rotational broadening': 'Even, symmetric widening of every line, because one side of a spinning star comes towards you as the other moves away.',
    'pressure broadening': 'Widening of lines because atoms in dense gas are constantly jostled by their neighbours.',

    // Stars
    'spectral class': "A star's place in the sequence O, B, A, F, G, K, M, from hottest to coolest, read from its lines.",
    'luminosity class': "A Roman numeral for a star's size and stage: V for main sequence, III for giants, I for supergiants.",
    'log g': 'Surface gravity as a logarithm, which tells you density: a higher number means a denser star and broader lines.',
    'metallicity': 'How much of a star is made of elements heavier than helium, compared with the Sun.',
    'dex': 'Powers of ten: +1 dex is ten times as much, and +0.1 dex is about 26% more.',
    'Population I': 'Younger, metal-rich stars, made from gas already enriched by earlier generations.',
    'Population II': 'Old, metal-poor stars, formed when the galaxy had made few heavy elements.',
    'luminosity': 'The total power an object gives out, in watts or in L☉.',
    'L☉': "The Sun's luminosity, 3.83 × 10²⁶ W, used as a unit.",
    'M☉': "The Sun's mass, 1.99 × 10³⁰ kg, used as a unit.",
    'R☉': "The Sun's radius, 6.96 × 10⁸ m, used as a unit.",
    'apparent brightness': 'The power per square metre arriving here, b = L/(4πd²).',
    'apparent magnitude': 'A scale of how bright something looks, where smaller numbers are brighter and 5 magnitudes is a factor of 100.',

    // The H-R diagram and how stars work
    'H-R diagram': "A plot of stars' luminosity against surface temperature, hottest on the left, which sorts them by size and stage.",
    'main sequence': 'The long band on an H-R diagram where stars spend most of their lives, fusing hydrogen in their cores.',
    'turn-off': "The point on a cluster's H-R diagram where stars are leaving the main sequence, which shows the cluster's age.",
    'red giant': 'A swollen, cool, very luminous star that has used up the hydrogen in its core.',
    'supergiant': 'A massive star near the end of its life, among the most luminous stars there are.',
    'white dwarf': 'The hot, Earth-sized core left behind by a Sun-like star, with no fusion left, slowly cooling.',
    'nucleosynthesis': 'The making of new atomic nuclei, mostly by fusion inside stars.',
    'fusion': 'Light nuclei joining to make a heavier one, releasing energy because a little mass disappears.',
    'p-p chain': 'The route from hydrogen to helium in which protons fuse directly, the main one in lower-mass stars.',
    'CNO cycle': 'The route from hydrogen to helium that uses carbon, nitrogen and oxygen as catalysts, the main one in higher-mass stars.',
    'helium burning': 'Fusion of helium into carbon and oxygen in the cores of giants, at around 100 million K.',

    // Systems
    'spectroscopic binary': 'Two stars too close to separate by eye, known from lines that split and shift as they orbit.',
    'hierarchical triple': 'A close pair of stars with a third on a much wider orbit, the usual stable way for three stars to live.',
    'circumbinary': 'Going round both stars of a pair, rather than just one.',
    'X-ray binary': 'A star feeding gas to a black hole or neutron star, so hot that it shines in X-rays.',
    'accretion disc': 'A flat, spinning disc of gas spiralling into a compact object, heated by friction until it glows.',
    'pulsar': 'A spinning neutron star whose beams sweep past us, giving a pulse each turn.',
    'neutron star': 'The collapsed core of a massive star, heavier than the Sun and only about 20 km across.',

    // Nebulae, galaxies and the Universe
    'Balmer series': 'The visible lines of hydrogen, including Hα at 656.3 nm and Hβ at 486.1 nm.',
    'Lyman-α': 'The strongest ultraviolet line of hydrogen, at 121.6 nm.',
    'Hα': 'The red line of hydrogen at 656.3 nm, which gives many nebulae their colour.',
    'Ca II H and K': 'A close pair of calcium lines at 396.8 and 393.4 nm, strong in cooler stars and in galaxies.',
    'Na D': 'A close pair of yellow sodium lines at 589.0 and 589.6 nm.',
    'Mg b': 'A group of magnesium lines near 517 nm, strong in cooler stars.',
    '21 cm line': 'A radio line given out by cold neutral hydrogen.',
    'synchrotron': 'Radio glow from fast electrons spiralling in a magnetic field.',
    "Hubble's law": 'The further away a galaxy is, the faster it recedes: v = H₀d.',
    'H₀': "The Hubble constant, the gradient of Hubble's law, in km/s/Mpc.",
    'zone of avoidance': "The part of the sky where the Milky Way's dust and stars hide the galaxies beyond.",
    'cosmic microwave background': 'The faint, even glow left over from the hot early Universe, now mostly seen in microwaves.',
    'light curve': 'A graph of brightness against time.',

    // Distances
    'AU': 'Astronomical unit, the distance from the Earth to the Sun: 1.5 × 10¹¹ m.',
    'parsec': 'A unit of distance equal to 3.26 light-years; 1 Mpc is a million parsecs.',
    'light-year': 'The distance light travels in a year: 9.46 × 10¹⁵ m.',

    // Planets
    'albedo': 'The fraction of starlight a planet reflects, from 0 for none to 1 for all.',
    'equilibrium temperature': 'How warm a planet would be if it simply balanced the starlight it absorbs against the heat it radiates, with no greenhouse warming.',
    'habitable zone': "The range of distances from a star where a planet's surface could be warm enough for liquid water.",
    'biosignature': "A gas or mix of gases in a planet's air that is hard to explain without life.",
    'red edge': "A sharp rise in reflected light just past the red end of the visible, at about 700 to 750 nm. Earth's plants absorb visible light for photosynthesis but reflect near-infrared strongly, so a planet with something similar on its surface could show the same step.",

    // Comets
    'coma': 'The cloud of gas and dust round the nucleus of a comet.',
    'ion tail': "A comet's straight tail of charged gas, blown directly away from the Sun.",
    'dust tail': "A comet's curved tail of dust, shining by reflected sunlight."
};

// Other spellings of a term in running text
const ALIASES = {
    'black-body': 'black body',
    'P Cygni': 'P Cygni profile',
    "Wien's Law": "Wien's law",
    'H-R plot': 'H-R diagram',
    'spectral type': 'spectral class',
    'Kirchhoff': "Kirchhoff's rules",
    'CNO': 'CNO cycle',
    'Lyα': 'Lyman-α',
    'light year': 'light-year',
    'Mpc': 'parsec',
    'pc': 'parsec',
    'Ca H and K': 'Ca II H and K',
    'Ca II H & K': 'Ca II H and K',
    'turnoff': 'turn-off',
    'turn off': 'turn-off',
    'solar luminosity': 'L☉',
    'solar mass': 'M☉'
};

export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Surface form -> term. A lower-case word also matches with a capital, at the start of a sentence.
const LOOKUP = new Map();
function addForm(form, term) {
    LOOKUP.set(form, term);
    // A single letter stays as it is: a capital Z means something else
    if (form.length > 1 && form[0] !== form[0].toUpperCase()) LOOKUP.set(form[0].toUpperCase() + form.slice(1), term);
}
Object.keys(GLOSSARY).forEach((term) => addForm(term, term));
Object.entries(ALIASES).forEach(([form, term]) => addForm(form, term));

// Longest first, so "P Cygni profile" wins over "P Cygni". \b can't see Greek letters or ☉, hence the lookarounds.
const PATTERN = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${[...LOOKUP.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join('|')})s?(?![\\p{L}\\p{N}])`,
    'gu'
);

// The one tooltip. It is fixed to the window, because the drawer's scrolling body would clip anything inside it.
const TIP_ID = 'spectroTermTip';
let tip = null;
let hideTimer = 0;

function positionTip(target) {
    const box = target.getBoundingClientRect();
    const size = tip.getBoundingClientRect();
    const gap = 8;
    const left = Math.max(gap, Math.min(innerWidth - size.width - gap, box.left + box.width / 2 - size.width / 2));
    const above = box.top - size.height - gap;
    tip.style.left = `${left}px`;
    tip.style.top = `${above >= gap ? above : box.bottom + gap}px`;
}

function showTip(target) {
    clearTimeout(hideTimer);
    // In fullscreen only the fullscreen element's own contents are drawn
    const home = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if (tip.parentNode !== home) home.appendChild(tip);
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    positionTip(target);
}

function hideTip() {
    clearTimeout(hideTimer);
    if (tip) tip.hidden = true;
}

function ensureTip() {
    if (tip || typeof document === 'undefined') return;
    tip = document.createElement('div');
    tip.id = TIP_ID;
    tip.className = 'spectro-term-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);

    const termOf = (e) => (e.target.closest ? e.target.closest('.spectro-term') : null);
    document.addEventListener('focusin', (e) => { const term = termOf(e); if (term) showTip(term); });
    document.addEventListener('focusout', (e) => { if (termOf(e)) hideTip(); });
    document.addEventListener('mouseover', (e) => {
        const term = termOf(e);
        if (term) showTip(term);
        else if (e.target === tip) clearTimeout(hideTimer); // The pointer may move onto the tip to read it
    });
    document.addEventListener('mouseout', (e) => {
        if (!termOf(e) && e.target !== tip) return;
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideTip, 150);
    });
    // Esc dismisses the tip first, without also closing the drawer
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !tip.hidden) {
            hideTip();
            e.stopPropagation();
            return;
        }
        // A term is announced as a button, so Enter and Space bring its tip back after Esc has dismissed it
        const term = termOf(e);
        if (term && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            if (tip.hidden) showTip(term);
            else hideTip();
        }
    }, true);
    // Tabbing to a term can scroll the drawer, in which case the tip follows it
    document.addEventListener('scroll', () => {
        if (tip.hidden) return;
        const active = document.activeElement;
        if (active && active.classList && active.classList.contains('spectro-term')) positionTip(active);
        else hideTip();
    }, true);
}

// role="button" gives the term a role and takes its name from the words: an abbr that can be focused has neither
export function tipHtml(label, definition) {
    ensureTip();
    return `<abbr class="spectro-term" role="button" tabindex="0" data-tip="${escapeHtml(definition)}" aria-describedby="${TIP_ID}">${escapeHtml(label)}</abbr>`;
}

export function termHtml(term, label = term) {
    const definition = GLOSSARY[term] ?? GLOSSARY[ALIASES[term]];
    if (!definition) return escapeHtml(label);
    return tipHtml(label, definition);
}

export function codeHtml(code, { fly = false } = {}) {
    const safe = escapeHtml(code);
    return `<button type="button" class="spectro-code" data-code="${safe}"${fly ? ' data-fly' : ''} aria-label="${fly ? 'Go to' : 'Select'} ${safe}">${safe}</button>`;
}

export function glossaryHtml(text, { seen = new Set() } = {}) {
    const source = String(text ?? '');
    let html = '';
    let last = 0;
    for (const match of source.matchAll(PATTERN)) {
        const found = match[0];
        const term = LOOKUP.get(found) ?? LOOKUP.get(found.slice(0, -1));
        if (!term || seen.has(term)) continue;
        seen.add(term);
        html += escapeHtml(source.slice(last, match.index)) + termHtml(term, found);
        last = match.index + found.length;
    }
    return html + escapeHtml(source.slice(last));
}
