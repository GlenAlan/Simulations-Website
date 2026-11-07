// The Help page: helpSections() -> [{ heading, html }]. Pure strings, so it also loads under Node.
// The final task is stated as the student's mission, and says nothing about where the answer is or what it is called.

import { codeHtml, termHtml as term } from './glossary.js';

const key = (k) => `<kbd>${k}</kbd>`;

function list(items) {
    return `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

function definitions(pairs, className = 'spectro-help-list') {
    return `<dl class="${className}">${pairs.map(([dt, dd]) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`).join('')}</dl>`;
}

const USING_THE_SKY = `<ol>
    <li><strong>Look.</strong> Drag to look around. Scroll or pinch to zoom, and fainter objects appear as you go in.</li>
    <li><strong>Select.</strong> Click or tap an object, or type its 6-character code into Go to. Its panel opens at the side.</li>
    <li><strong>Analyse.</strong> The Spectrum tab sets its light beside a reference you can swap. The H-R tab puts stars on the diagram. The Info tab has the notes on what to look for.</li>
    <li><strong>Switch bands.</strong> Some objects can't be seen in visible light at all, only in radio, infrared, ultraviolet or X-rays.</li>
    <li><strong>Go in.</strong> Keep zooming in on a star to go into its system, and zoom back out to return. Enter system does the same. Click a planet to open it.</li>
</ol>
<p>At the bottom of each Info tab are the <strong>Catalogue values</strong>, the true numbers for checking yourself. Work it out first, then look.</p>
<p>Labels, the grid and the other extras are in <strong>Layers</strong>. Two of them help a long search: <strong>Visited systems</strong> ticks the systems you have been in, and <strong>Stars with planets</strong> marks the stars known to have them. Everything has its own code, and <strong>Copy link</strong> makes a link that opens that object, so a teacher can send you straight there.</p>`;

const FINDING = `<p>Nothing lists a star's class, because working it out is the exercise. Start from its colour, which follows its temperature. On a bright star, look at the glow around it, as the centre washes out to white.</p>
${definitions([
    ['Blue-white', 'About O or B'],
    ['White', 'About A or F'],
    ['Pale yellow', 'About G'],
    ['Orange', 'About K, or M when it is a deep orange or red']
])}
<p>Then measure it with the Temperature tool: fit a black-body curve, or use ${term("Wien's law")}, for how hot it is, and compare standard stars for its class.</p>
<p>To tell a giant from a dwarf, look among the orange and red stars, where most giants are. Of two stars the same colour, the much brighter one is probably the giant and the fainter one the dwarf. Distance dims a star too, so that is only a first guess: test it with ${term('pressure broadening', 'line widths')} and the ${term('H-R diagram')}.</p>`;

const KEYBOARD = definitions([
    [`${key('←')} ${key('→')} ${key('↑')} ${key('↓')}`, 'Look around'],
    [`${key('+')} ${key('−')}`, 'Zoom in or out'],
    [`${key('Tab')}`, 'Move between controls'],
    [`${key('Enter')}`, 'On the sky: select what is at the centre of the view. In a system: select the star or planet you have stepped to'],
    [`${key(']')} ${key('Page Down')}`, 'Move to the next nearest object, or in a system the next star or planet. Press Enter to select it'],
    [`${key('[')} ${key('Page Up')}`, 'Go back to the object before'],
    [`${key('/')}`, 'Jump to the Go to box'],
    [`${key('Enter')}`, 'After Go to, with the object at the centre of the view: move straight into its panel. Esc brings you back'],
    [`${key('Esc')}`, 'Step back: close a menu or panel, then leave a system, then clear the selection, then leave fullscreen'],
    [`${key('F')}`, 'Show or hide the frame rate'],
    ['Settings', 'Single-key shortcuts everywhere: turn it off, and these single keys work only while the sky itself has the focus']
], 'spectro-help-list spectro-help-keys');

const BANDS = `${definitions([
    ['Radio', 'Pulsars, jets and radio lobes, with a glow along the galactic band.'],
    ['Infrared', 'Warm dust and cool objects. The only band where rogue planets show.'],
    ['Visible', 'What your eyes would see: starlight and glowing gas, in true colour.'],
    ['Ultraviolet', 'The hottest stars, whose light peaks here.'],
    ['X-ray/γ', 'Gas at millions of degrees: discs round black holes and supernova shells.']
])}
<p>All but Visible are in ${term('false colour')}, and the legend says what glows and why. Detailed spectra run from 90 nm to 5 µm. Radio and X-ray views show where things are and how bright, not a full spectrum.</p>`;

const READING = list([
    `<strong>Layout.</strong> Choose a reference in the row under the object's spectrum, or step through them with the arrows, and it is drawn over the object, dashed. Stacked gives it its own plot underneath; Overlay puts it back. The colour strip shows lines as they would look.`,
    `<strong>The shape.</strong> The smooth ${term('continuum')} gives the temperature, through its peak. A hot solid gives one too, close to a ${term('black body')}: the white-hot filament of an incandescent lamp is the everyday example. A gas discharge tube gives bright lines instead, which is what the element lamps show.`,
    `<strong>The lines.</strong> Dark ${term('absorption line', 'absorption lines')} mean cooler gas in front of a hot source. Bright ${term('emission line', 'emission lines')} mean hot, thin gas. Their pattern tells you which atoms and molecules are there.`,
    `<strong>The shift.</strong> If every line has moved by the same fraction, the object is moving: z = Δλ/λ₀ and v = cz, with positive meaning away. For z above about 0.1, quote z instead.`,
    `<strong>The width.</strong> Broad lines mean a dense star or a fast spin. The full spectrum shows detail down to about 60 km/s, and the Spin tool, zoomed in on one line, down to about 5 km/s.`,
    `<strong>Planets.</strong> Starlight bounced off a planet, with bites taken out by the gases in its air. A surface can leave its mark too, as plants do on Earth with the ${term('red edge')}.`,
    `<strong>The noise.</strong> Faint objects give noisy spectra, with a low ${term('S/N')}. References have no noise, and tools report a ± ${term('uncertainty')}.`,
    `<strong>Wavelengths.</strong> Lines above 200 nm are ${term('air wavelength', 'air wavelengths')} (Hα 656.3 nm), and lines below 200 nm are ${term('vacuum wavelength', 'vacuum wavelengths')} (Lyman-α 121.6 nm), as in most textbooks. Observed and reference spectra match.`
]);

const TOOLS = `<p>Along the bottom of the Spectrum tab, named for what they measure. Each one shows only on objects it works for.</p>
${definitions([
    ['Reference', 'Swap in element lamps, ionised elements, UV lines, molecules, standard stars or a black body. Shift slides it along the wavelength axis.'],
    ['Temperature', `Fit a black-body curve, compare standard stars, or mark the peak, ${term('λmax')}, for ${term("Wien's law")}: T = b/λmax.`],
    ['Velocity', `By the Doppler shift: line up a reference line with a dip, or click a line and name it, and read ${term('Δλ')}, ${term('z')} and v from ${term('v = cz')}.`],
    ['Spin', `Zooms in on one line and lays the same line, not spinning, over it. Widen it until the two match to find ${term('v sin i')}.`],
    ['Brightness', 'Reads the measured brightness b and the distance d, so you can find L = 4πd²b.'],
    ['Period', 'Follows lines over time for binaries, multiples and black-hole companions, giving the period and the speeds.'],
    ['Stars', "Chooses whose light makes up a multiple star's spectrum: all of it, one pair, or one star."],
    ['Light curve', 'For a supernova or an eclipsing pair: its brightness against time.'],
    ['Pulses', 'For a pulsar: time its pulses to find how fast it spins.'],
    ['Planet light', "For planets: takes the star's light away to leave the planet's own features."],
    ['H-R tab', `Puts stars on the ${term('H-R diagram')}, or a whole cluster at once.`],
    ['Hubble plot', `Plots v against d for the galaxies you have measured, for ${term("Hubble's law")}.`]
])}`;

function taskGroup(heading, start, tasks) {
    return `<h5>${heading}</h5><ol start="${start}" class="spectro-help-tasks">${tasks.map(([name, text]) => `<li><strong>${name}</strong> ${text}</li>`).join('')}</ol>`;
}

const TASKS = [
    taskGroup('Module 5: Advanced Mechanics', 1, [
        ['Unseen mass.', `Pick a black hole. Use the Period tool on its companion to read the period and speed, then Kepler's third law to find the hole's mass. Is it over about 3 ${term('M☉')}?`],
        ["Three's a crowd.", `Compare the line patterns of a normal binary, a ${term('hierarchical triple')} and the figure-eight ${codeHtml('F8Q3ZN', { fly: true })}. Then untangle the four stars of the double-double ${codeHtml('D2W7XK', { fly: true })}, one pair at a time.`]
    ]),
    taskGroup('Module 7: The Nature of Light', 3, [
        ['Find the elements.', 'Swap element references to identify the lines in a G star, then in an emission nebula.'],
        ["Who's moving?", 'Measure the shifts of 3 stars and find their speeds. Then find the fastest rotator from its line widths.'],
        ['Too hot to see.', "Find an O or B star's black-body peak in the ultraviolet and calculate its temperature with Wien's law."],
        ['Hidden sky.', "Find objects that can't be seen in visible light, say which bands they do show in, and explain why."]
    ]),
    taskGroup('Module 8: From the Universe to the Atom', 7, [
        ['Classify 5 stars.', "Compare each with the standard-star references, then confirm its temperature with Wien's law."],
        ['Giant or dwarf?', 'Compare the line widths of two stars of the same class, then place both on the H-R diagram.'],
        ['Cluster age.', `Plot the H-R diagram of a cluster and find the ${term('turn-off')}. What does it tell you?`],
        ['Catch a supernova.', 'Identify its type from the spectrum. Then, on its Overview, play its light curve and see how the lines change.'],
        ["Hubble's law.", `Measure at least 8 galaxies, plot v against d, and estimate ${term('H₀')} from the gradient.`]
    ]),
    taskGroup('The mission', 12, [
        ['The search.', `One planet in the sky has liquid water in a ${term('habitable zone')}. Find it, and show from its spectrum why it is the one. Other planets will look promising at first: for each one, say what evidence rules it out.`]
    ])
].join('');

export function helpSections() {
    return [
        { heading: 'How to use the sky', html: USING_THE_SKY },
        { heading: 'Finding a kind of star', html: FINDING },
        { heading: 'Keyboard', html: KEYBOARD },
        { heading: 'The five bands', html: BANDS },
        { heading: 'Reading a spectrum', html: READING },
        { heading: 'Tools', html: TOOLS },
        { heading: 'Suggested tasks', html: TASKS }
    ];
}
