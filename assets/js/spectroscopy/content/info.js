// The plain-language notes for every object. Pure: no DOM.
//   infoFor(resolved) -> { title, kindLabel, lead, next: { label, tab, tool? }, summary, notes: [{ heading, text }], rarity,
//                          catalogue: [{ label, value }] }
//
// lead and next are what the Overview shows: one short sentence and the obvious thing to do. Everything else is for the
// Info tab, which is where any new words belong.
//
// title, kindLabel, lead, summary, notes and rarity are on show, so they must not give away what the student is meant
// to work out. They say what kind of thing this is, what to look for and which tool answers it, and stay the same
// whatever the object's class, temperature or composition. The one exception is a rogue planet's note on bands, which
// goes by temperature, because a cold one has none to show and its spectrum says so at a glance. The true values live
// only in `catalogue`, behind its expander. A planet's type and make-up always come from the data, never from words
// kept here.
//
// The real data may add fields or lack them, so every value is checked and a row with no value is left out.

import { CZ_REASON, beyondCz, shiftWords, withCommas, sig, signed, wavelength, distance } from '../core/format.js';
import { AU, C_KMS, PC, LY_PER_PC, wienPeakNm, orbitalSpeedKms } from '../core/phys.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const row = (label, value) => ({ label, value });
const clean = (rows) => rows.flat(Infinity).filter((r) => r && r.value !== null && r.value !== undefined && r.value !== '');
const present = (...parts) => parts.filter(Boolean);

const num = (x, unit = '', n = 3) => (isNum(x) ? `${sig(x, n).replace('-', '−')}${unit}` : null);
const words = (text) => (text ? String(text).replace(/_/g, ' ') : null);
const capital = (text) => (text ? text[0].toUpperCase() + text.slice(1) : null);
const yesNo = (x) => (typeof x === 'boolean' ? (x ? 'Yes' : 'No') : null);

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
const chem = (formula) => String(formula).replace(/\d/g, (d) => SUBSCRIPT[d]);

const tempText = (T) => (isNum(T) ? `${T >= 1e5 ? sig(T, 3) : withCommas(T)} K` : null);

// A shift as it is shown everywhere (core/format.js): z always, and v = cz beside it while that applies. z is the object's own
// where it has one (a galaxy, a quasar), and v ÷ c otherwise.
function velocityText(v, z) {
    if (!isNum(v) && !isNum(z)) return null;
    const shift = isNum(z) ? z : v / C_KMS;
    if (shift === 0) return 'z = 0, v = 0 km/s';
    const dir = `moving ${shift > 0 ? 'away' : 'towards us'}`;
    if (beyondCz(shift)) return `${shiftWords(shift, { reason: false })}, ${dir} (${CZ_REASON})`;
    return `${shiftWords(shift, { v: isNum(v) ? v : undefined })} (${dir})`;
}

function distanceText(pc) {
    if (!isNum(pc)) return null;
    if (pc < 0.01) return `${sig(pc * (PC / AU), 3)} AU`;
    return `${distance(pc)} (${sig(pc * LY_PER_PC, 3)} light-years)`;
}

function periodText(days) {
    if (!isNum(days)) return null;
    if (days < 1) return `${sig(days * 24, 3)} hours`;
    if (days < 1000) return `${sig(days, 3)} days`;
    return `${sig(days / 365.25, 3)} years`;
}

function ageText(myr) {
    if (!isNum(myr)) return null;
    return myr >= 1000 ? `${sig(myr / 1000, 2)} billion years` : `${sig(myr, 2)} million years`;
}

function pulseText(seconds) {
    if (!isNum(seconds)) return null;
    return seconds < 1 ? `${sig(seconds * 1000, 3)} ms` : `${sig(seconds, 3)} s`;
}

function typeLabel(block) {
    return capital(block?.type_label || words(block?.type))?.replace('Sub neptune', 'Sub-Neptune') ?? null;
}

// What was measured from here, shared by nearly every object
function observedRows(entity, body, velocityLabel = 'Radial velocity') {
    const brightness = entity.brightness; // A system's total is not one star's own, so no fallback to the body
    const mag = brightness?.mag;
    return [
        row(velocityLabel, velocityText(entity.radial_velocity_kms ?? body?.radial_velocity_kms)),
        row('Distance', distanceText(entity.distance_pc ?? body?.distance_pc)),
        row('Measured brightness', isNum(brightness?.flux_Wm2) ? `${sig(brightness.flux_Wm2, 3)} W/m²` : null),
        row('Apparent magnitude', isNum(mag) && mag < 90 ? num(mag) : null) // 99 marks "not seen in visible light"
    ];
}

// ---------- Stars ----------

const STAGE_LABEL = { main_sequence: 'Main sequence', giant: 'Giant', supergiant: 'Supergiant', white_dwarf: 'White dwarf' };

function isWhiteDwarf(star) {
    return star.stage === 'white_dwarf' || star.class === 'D';
}

function spectralType(star) {
    if (isWhiteDwarf(star)) return star.wd_type ? `${star.wd_type} white dwarf` : 'White dwarf';
    // The data's own text where it has one: a carbon star's C and a barium star's Ba aren't in its class letter
    if (star.spectral_type) return star.spectral_type;
    if (!star.class) return null;
    return `${star.class}${isNum(star.subclass) ? star.subclass : ''}${star.luminosity_class ? ` ${star.luminosity_class}` : ''}`;
}

function peakText(T) {
    if (!isNum(T)) return null;
    const peak = wienPeakNm(T);
    return `${wavelength(peak, 0)}${peak < 90 ? ' (below the 90 nm edge of the spectrum)' : ''}`;
}

function rotationText(vsini) {
    if (!isNum(vsini)) return null;
    return `${sig(vsini, 3)} km/s${vsini < 5 ? '; tools read this as unresolved (< 5 km/s)' : ''}`;
}

const POPULATION = { I: 'Population I (metal-rich)', II: 'Population II (metal-poor)', peculiar: 'Peculiar' };

function compositionText(c) {
    if (!c) return null;
    const pct = (x) => `${sig(x * 100, 2)}%`;
    return present(isNum(c.X) && `H ${pct(c.X)}`, isNum(c.Y) && `He ${pct(c.Y)}`, isNum(c.Z) && `metals ${pct(c.Z)}`).join(', ') || null;
}

function metalsText(dex) {
    if (!dex) return null;
    return Object.entries(dex).filter(([, x]) => isNum(x)).map(([el, x]) => `${el} ${signed(x, 2)}`).join(', ') || null;
}

// The p-p chain and CNO cycle cross over at about 1.3 to 1.5 solar masses
function energySource(star) {
    const m = star.mass_Msun;
    if (isWhiteDwarf(star)) return 'None: no fusion, it is slowly cooling';
    if (star.stage === 'main_sequence') {
        if (!isNum(m)) return 'Hydrogen fusion in the core';
        if (m < 1.3) return 'Hydrogen fusion, mostly by the p-p chain';
        if (m < 1.5) return 'Hydrogen fusion, by both the p-p chain and the CNO cycle';
        return 'Hydrogen fusion, mostly by the CNO cycle';
    }
    if (star.stage === 'giant' || star.stage === 'supergiant') {
        return isNum(m) && m >= 8
            ? 'Helium fusion, then heavier elements up to iron'
            : 'Hydrogen fusion in a shell, and helium fusion in the core';
    }
    return null;
}

function starRows(star) {
    if (!star) return [];
    return [
        row('Spectral type', spectralType(star)),
        row('Stage', STAGE_LABEL[star.stage] || capital(words(star.stage))),
        row('Peculiarity', star.peculiar ? `${capital(words(star.peculiar))} star` : null),
        row('Surface temperature', tempText(star.teff_K)),
        row('Black-body peak', peakText(star.teff_K)),
        row('Mass', num(star.mass_Msun, ' M☉')),
        row('Radius', num(star.radius_Rsun, ' R☉')),
        row('Luminosity', num(star.luminosity_Lsun, ' L☉')),
        row('Surface gravity, log g', isNum(star.logg) ? star.logg.toFixed(2) : null),
        row('Rotation, v sin i', rotationText(star.vsini_kms))
    ];
}

function starMakeupRows(star) {
    if (!star) return [];
    return [
        row('Population', POPULATION[star.population] || capital(words(star.population))),
        row('Composition by mass', compositionText(star.composition)),
        row('Metals compared with the Sun (dex)', metalsText(star.composition?.metals_dex)),
        row('Age', ageText(star.age_Myr)),
        row('Energy source', energySource(star))
    ];
}

function planetCountRow(body) {
    return Array.isArray(body?.planets) && body.planets.length ? row('Planets', String(body.planets.length)) : null;
}

const STAR_NOTES = [
    {
        heading: 'Temperature',
        text: "A star's continuum is close to a black body curve, so its peak gives the temperature: T = b/λmax (Wien's law). Use the Temperature tool: fit a black-body curve, compare standard stars, or mark the peak. If the peak falls off the chart, below 90 nm (hotter than about 32,000 K), fit the curve instead."
    },
    {
        heading: 'Dark lines',
        text: "The hot, dense surface gives a continuous spectrum. Cooler gas above it absorbs certain wavelengths, leaving dark lines (Kirchhoff's rules). Compare with the standard stars to find the class, and swap the element references to see which atoms made each line."
    },
    {
        heading: 'Motion',
        text: 'If every line is shifted by the same amount, the whole star is moving along your line of sight: z = Δλ/λ₀ and v = cz. Positive means moving away. Use the Velocity tool, by the Doppler shift.'
    },
    {
        heading: 'Line width',
        text: 'Dense atmospheres widen every line (pressure broadening), so broad lines mean a dense dwarf or white dwarf, and narrow lines a giant. Spin widens lines evenly too (rotational broadening): v ≈ c·Δλ/λ₀ from the half-width gives v sin i, the part of the spin along your line of sight.'
    },
    {
        heading: 'Slow spinners',
        text: 'Fast spins show in the full spectrum; slow ones need the Spin tool, which zooms in on one line. Below about 5 km/s it reads "under 5 km/s". That means too slow for this instrument to measure, not that the star has stopped spinning.'
    }
];

const NUCLEOSYNTHESIS_NOTE = {
    heading: 'Nucleosynthesis',
    text: 'What a star fuses depends on its mass and stage, so find it on the H-R diagram. Lower main sequence: the p-p chain. Upper main sequence: the CNO cycle. Giants: hydrogen in a shell, then helium into carbon and oxygen, and massive stars go on to build elements up to iron. White dwarfs: no fusion at all.'
};

const ENERGY_NOTE = {
    heading: 'Energy from mass',
    text: 'Stars like this shine by fusing hydrogen into helium in the core. Four protons have about 0.7% more mass than the helium nucleus they become, and that lost mass leaves as energy: E = mc². Find its luminosity and you can work out how much mass it loses each second: Δm/Δt = L/c².'
};

function starNotes(star) {
    const notes = [...STAR_NOTES];
    if (star?.stage === 'main_sequence') notes.push(ENERGY_NOTE);
    notes.push(NUCLEOSYNTHESIS_NOTE);
    return notes;
}

function planetsNote(body) {
    const count = Array.isArray(body?.planets) ? body.planets.length : 0;
    if (!count) return null;
    return {
        heading: 'Planets',
        text: `${count === 1 ? 'One planet orbits' : `${count} planets orbit`} here. Zoom in on the star to go and see them. The periods and radii of the orbits follow Kepler's third law, r³/T² = GM/4π².`
    };
}

const STAR_RARITY = 'About 3 in 4 nearby stars are small red dwarfs, while only about 1 star in 3 million is a massive O star. This sky has far more of the rare kinds, so that you can find them.';

function starInfo({ entity }) {
    const star = entity.star;
    return {
        kindLabel: 'Star',
        lead: 'A star: its light tells you how hot it is, what it is made of and how it is moving.',
        summary: 'A star. Its light tells you how hot it is, what it is made of and how it is moving. Open the Spectrum tab to start.',
        notes: present(planetsNote(entity), ...starNotes(star)),
        rarity: STAR_RARITY,
        catalogue: clean([starRows(star), observedRows(entity), starMakeupRows(star), planetCountRow(entity)])
    };
}

function clusterMemberInfo({ entity, body }) {
    const star = entity.star;
    const parent = entity.parent || body?.code;
    const clusterType = body?.cluster?.type;
    const ofCluster = parent ? `the cluster ${parent}` : 'its cluster';
    return {
        kindLabel: clusterType ? `Star in ${clusterType === 'open' ? 'an open' : `a ${words(clusterType)}`} cluster` : 'Star in a cluster',
        lead: 'One star of a cluster, born at about the same time as the others.',
        summary: `One star of ${ofCluster}. It has its own spectrum, and it was born at about the same time as the others there.`,
        notes: [
            { heading: 'Its cluster', text: 'Every star in a cluster is about the same age and distance, so differences between them come mostly from mass. Use the cluster H-R diagram to see where this one sits.' },
            ...starNotes(star)
        ],
        rarity: STAR_RARITY,
        catalogue: clean([row('Cluster', parent), starRows(star), observedRows(entity, body), starMakeupRows(star)])
    };
}

function componentInfo({ entity, body }) {
    const star = entity.star;
    const parent = entity.parent || body?.code;
    const code = parent ? ` ${parent}` : '';
    if (body?.kind === 'galaxy') return closeStarInfo(entity, body, parent);
    if (body?.kind === 'black_hole') {
        return {
            kindLabel: 'Companion star',
            lead: 'The star you can see in a black hole system.',
            summary: `The star you can see in the black hole system${code}. Its lines swing back and forth as it orbits something massive and dark.`,
            notes: [
                { heading: 'Why it matters', text: 'This star is the only way to weigh its unseen partner. Use the Period tool to follow its lines, read the period and the speed, then go to Kepler\'s third law.' },
                ...starNotes(star)
            ],
            rarity: BLACK_HOLE_RARITY,
            catalogue: clean([row('Black hole system', parent), starRows(star), observedRows(entity, body, "System's radial velocity"), starMakeupRows(star)])
        };
    }
    return {
        kindLabel: 'Star in a multiple system',
        lead: 'One star of a multiple system, taken on its own.',
        summary: `One star of the system${code}, seen on its own. Its lines shift back and forth as it orbits.`,
        notes: [
            { heading: 'Its system', text: 'From far off it is seen as one point with its companions. Taken alone, this star\'s lines are much easier to follow than in the combined spectrum. Use the Period tool to read how they swing, then compare with the other stars.' },
            ...starNotes(star)
        ],
        rarity: MULTIPLE_RARITY,
        catalogue: clean([row('System', parent), starRows(star), observedRows(entity, body, "System's radial velocity"), starMakeupRows(star)])
    };
}

// ---------- Binaries and multiples ----------

const MULTIPLE_RARITY = 'Common. About 1 Sun-like star in 3 is in a binary, and about 1 in 10 is in a triple or larger system. Red dwarfs are more often alone.';

const ARCHITECTURE = {
    binary: 'Binary: two stars',
    hierarchical_triple: 'Hierarchical triple: a close pair with a third star on a wide orbit',
    figure_eight: 'Figure-eight: three stars sharing one path',
    double_double: 'Double-double: two close pairs, far apart'
};

function orbitRows(body) {
    const orbits = Array.isArray(body.orbits) ? body.orbits : [];
    const starCount = Array.isArray(body.stars) ? body.stars.length : 0;
    return orbits.map((o, i) => {
        const value = present(isNum(o.a_AU) && `${sig(o.a_AU, 3)} AU apart`, isNum(o.period_days) && `period ${periodText(o.period_days)}`).join(', ');
        const members = (o.a?.length || 0) + (o.b?.length || 0);
        let label = orbits.length > 1 ? `Orbit ${i + 1}` : 'Orbit';
        if (members > 2) label = 'Outer orbit';
        else if (starCount > 2 && members === 2) label = orbits.length > 2 ? `Close pair ${i + 1}` : 'Close pair';
        return row(label, value);
    });
}

function systemRows(body) {
    const stars = Array.isArray(body.stars) ? body.stars : [];
    const members = stars.map((s) => present(s.code, s.star && spectralType(s.star), s.star && tempText(s.star.teff_K)).join(', ')).filter(Boolean);
    const masses = stars.map((s) => s.star?.mass_Msun);
    return [
        row('Arrangement', ARCHITECTURE[body.architecture] || capital(words(body.architecture))),
        row(`Stars (${members.length})`, members.length ? members.join('; ') : null),
        orbitRows(body),
        row('Total mass', masses.length && masses.every(isNum) ? num(masses.reduce((a, b) => a + b, 0), ' M☉') : null),
        row('Mass transfer between stars', yesNo(body.interacting))
    ];
}

function figureEightInfo(entity) {
    return {
        kindLabel: 'Figure-eight triple star',
        lead: 'Three equal stars chasing one another round a single figure-eight path.',
        summary: 'Three equal stars chasing one another round a single figure-eight path. None of them is "the outer one": they share the orbit equally.',
        notes: [
            { heading: 'A perfect solution', text: 'Most real triples are hierarchical: a close pair with a third star far out. This is something else: an exact solution of the three-body problem, found by computer by Cris Moore in 1993 and proved by Chenciner and Montgomery in 2000.' },
            { heading: 'So rare it may not exist', text: 'It only works if the three masses are almost exactly equal, and the stars would have to fall into this path just so. It is extremely unlikely in nature. Here the orbit is played back from a stored path, so it never drifts.' },
            { heading: 'What to look for', text: 'Three sets of lines whose Doppler shifts weave over and under one another in a repeating 3-way pattern, unlike any binary. Compare them with an ordinary binary using the Period tool.' },
            { heading: 'No planets', text: 'With three stars swapping places on one path, no planet could keep a stable orbit here.' }
        ],
        rarity: 'One estimate puts systems like this at somewhere between one per galaxy and one per Universe.',
        catalogue: clean([systemRows(entity), observedRows(entity, entity, "System's radial velocity")])
    };
}

function doubleDoubleInfo(entity) {
    return {
        kindLabel: 'Double-double star',
        lead: 'Two close pairs of stars, with the pairs orbiting each other far apart.',
        summary: 'Two close pairs of stars, with the pairs orbiting each other at a great distance. It looks like one point at first. Zoom in and it becomes two, and each of those is itself a binary.',
        notes: [
            { heading: 'Like Epsilon Lyrae', text: 'The real "Double Double", about 160 light-years away in Lyra, is a pair of stars in binoculars, and a small telescope splits each of them again. Its pairs take centuries to orbit. These are much closer together, so their lines change over days.' },
            { heading: 'Untangling it', text: 'The combined spectrum holds four sets of lines. Pick one pair with the Stars tool, work out that pair with the Period tool, then do the other. Each pair has its own period.' },
            { heading: 'The outer orbit', text: 'The two pairs take so long to go round each other that they hardly move while you watch. Wide orbits like this keep a four-star system stable.' }
        ],
        rarity: 'About 3% of Sun-like stars belong to a system of four or more.',
        catalogue: clean([systemRows(entity), observedRows(entity, entity, "System's radial velocity"), planetCountRow(entity)])
    };
}

// How many stars, said in the system's name on the sky and in its panel, so a binary and a triple can be told apart at a glance
const COUNT_WORDS = { 2: ['Binary star', 'Two stars'], 3: ['Triple star', 'Three stars'] };
// A multiple star's next step: its clock set to when the lines are furthest apart and playing, with the Period tool open on a
// line that shows them split
const SEE_SPLIT = { label: 'See the lines split', tab: 'spectrum', tool: 'time-series', split: true };

function multipleInfo({ entity }) {
    if (entity.architecture === 'figure_eight') return { ...figureEightInfo(entity), next: SEE_SPLIT };
    if (entity.architecture === 'double_double') return { ...doubleDoubleInfo(entity), next: SEE_SPLIT };
    const count = Array.isArray(entity.stars) ? entity.stars.length : 0;
    const [kindLabel, many] = COUNT_WORDS[count] || ['Multiple star', 'Several stars'];
    return {
        kindLabel,
        lead: `${many} bound by gravity, too close together to split by eye.`,
        summary: `${many} bound by gravity, too close together to split by eye. The spectrum can split them: watch how the lines move.`,
        next: SEE_SPLIT,
        notes: present(
            planetsNote(entity),
            { heading: 'What to look for', text: 'As two stars orbit, one comes towards you while the other moves away, so their lines separate, merge and separate again. This is a spectroscopic binary. Use the Period tool to follow a line and read the period.' },
            { heading: 'Weighing the stars', text: 'The period and the speeds give the size of the orbit, and Kepler\'s third law then gives the total mass: r³/T² = G(M₁ + M₂)/4π².' },
            { heading: 'A blend of spectra', text: 'The light is a blend, so you are seeing more than one temperature at once. Each star has its own code, so you can also study one alone.' },
            count >= 3 && { heading: 'The third star', text: 'Most real triples are hierarchical: a close pair with a third star on a much wider orbit, at least ten times the period. That keeps them stable. In the lines, look for a slow drift on top of a fast swing, or a third set of lines.' }
        ),
        rarity: MULTIPLE_RARITY,
        catalogue: clean([systemRows(entity), observedRows(entity, entity, "System's radial velocity"), planetCountRow(entity)])
    };
}

// ---------- Planets ----------

function atmosphereText(block) {
    const pct = Object.entries(block.atmosphere_pct || {}).filter(([, x]) => isNum(x) && x > 0).sort((a, b) => b[1] - a[1]);
    const ppm = Object.entries(block.atmosphere_ppm || {}).filter(([, x]) => isNum(x) && x > 0).sort((a, b) => b[1] - a[1]);
    if (!block.atmosphere_pct && !block.atmosphere_ppm) return null;
    const parts = [...pct.map(([gas, x]) => `${chem(gas)} ${sig(x, 3)}%`), ...ppm.map(([gas, x]) => `${chem(gas)} ${sig(x, 2)} ppm`)];
    return parts.length ? parts.join(', ') : 'None';
}

function hasEnvelope(block) {
    return isNum(block.atmosphere_pct?.H2) && block.atmosphere_pct.H2 > 50;
}

function habitableText(block, body) {
    if (typeof block.in_hz !== 'boolean') return null;
    const singleMainSequence = body?.kind === 'home_planet' || (body?.kind === 'star' && body.star?.stage === 'main_sequence');
    if (!singleMainSequence) return 'Not defined: the formula only works for single main-sequence stars';
    return yesNo(block.in_hz);
}

function planetRows(block, body) {
    const clouds = block.clouds;
    const surface = block.surface;
    const solid = !hasEnvelope(block); // Gas-rich planets have no surface to speak of
    const gravity = solid && isNum(block.mass_Mearth) && isNum(block.radius_Rearth) && block.radius_Rearth > 0
        ? block.mass_Mearth / block.radius_Rearth ** 2 : null;
    const ring = block.rings ? 'Yes' : null;
    return [
        row('Type', typeLabel(block)),
        row('Atmosphere', atmosphereText(block)),
        row('Surface pressure', solid && isNum(block.pressure_bar) && block.pressure_bar > 0 ? num(block.pressure_bar, ' bar') : null),
        row('Clouds', clouds?.kind ? present(chem(clouds.kind), isNum(clouds.cover) && `${sig(clouds.cover * 100, 2)}% cover`).join(', ') : null),
        row('Ocean cover', isNum(surface?.ocean_fraction) && surface.ocean_fraction > 0 ? `${sig(surface.ocean_fraction * 100, 2)}%` : null),
        row('Surface rock', solid ? capital(words(surface?.rock)) : null),
        row('Surface ice', capital(words(surface?.ice))),
        row('Red edge', isNum(surface?.red_edge_nm) ? `${sig(surface.red_edge_nm, 3)} nm` : null),
        row('Albedo', num(block.albedo, '', 2)),
        row('Equilibrium temperature', tempText(block.T_eq_K)),
        row('Mean surface temperature', tempText(block.T_surface_K)),
        row('In the habitable zone', habitableText(block, body)),
        row('Orbit radius', num(block.orbit_AU, ' AU')),
        row('Orbital period', periodText(block.period_days)),
        row('Orbital speed, v = 2πr/T', isNum(block.orbit_AU) && isNum(block.period_days) && block.period_days > 0 ? `${sig(orbitalSpeedKms(block.orbit_AU, block.period_days), 3)} km/s` : null),
        row('Radius', num(block.radius_Rearth, ' Earth radii')),
        row('Mass', num(block.mass_Mearth, ' Earth masses')),
        row('Surface gravity', gravity !== null ? `${sig(gravity, 3)} g` : null),
        row('Day length', num(block.day_length_h, ' hours')),
        row('Rings', ring)
    ];
}

// Orbit, period, radius and mass are open: Module 5 needs them
function orbitAndSizeNote(block, hostText) {
    const orbit = present(
        isNum(block.orbit_AU) && `at ${sig(block.orbit_AU, 3)} AU`,
        isNum(block.period_days) && `once every ${periodText(block.period_days)}`
    ).join(', ');
    const size = present(
        isNum(block.radius_Rearth) && `Radius ${sig(block.radius_Rearth, 3)} Earth radii`,
        isNum(block.mass_Mearth) && `mass ${sig(block.mass_Mearth, 3)} Earth masses`
    ).join(', ');
    if (!orbit && !size) return null;
    return {
        heading: 'Orbit and size',
        text: present(orbit && `Orbits ${hostText || 'its star'} ${orbit}.`, size && `${size}.`).join(' ')
    };
}

const REFLECTED_NOTE = {
    heading: 'Reflected light',
    text: "A planet shines mainly by reflecting its star's light, so its spectrum is the star's, dimmed by its albedo, with bites taken out by any gases in its air. Use the Planet light tool to take the star's light away, then compare what is left with the molecule references. A surface can leave its mark too, as plants do on Earth with the red edge."
};

function planetInfo({ entity, body }) {
    const host = entity.host || body?.code;
    return {
        kindLabel: 'Exoplanet',
        lead: 'A planet in another star system.',
        summary: `A planet${host ? ` orbiting ${host}` : ''}. Make a first guess from how it looks, then test that guess with its spectrum.`,
        notes: present(
            orbitAndSizeNote(entity, host),
            { heading: "Kepler's third law", text: "Every planet here obeys r³/T² = GM/4π². Put in this planet's orbit and period and you have the mass of what it orbits. You can also find its speed: v = 2πr/T." },
            REFLECTED_NOTE,
            { heading: 'Reading the bands', text: 'Bands can overlap: water vapour shares 2.7 µm with carbon dioxide, and 1.4 µm with methane, so its band at 1.9 µm is the clean test for it. Nitrogen, argon, hydrogen and helium leave almost no bands in this range. A thick hydrogen atmosphere shows instead in the planet\'s size: a large radius for its mass.' },
            { heading: 'Habitable zone', text: "The zone where a planet's surface could hold liquid water runs from about √(L/1.1) to √(L/0.53) AU, with L in L☉. Turn on Habitable zone in Layers to see it round a main-sequence star. Being in the zone does not prove there is water: only the spectrum can show that." }
        ),
        rarity: 'More than 6,000 exoplanets have been confirmed, and most stars probably have at least one planet.',
        catalogue: clean([row('Orbits', host), planetRows(entity, body), observedRows(entity, body, 'Radial velocity (same as its star)')])
    };
}

const HOME_NOTES = {
    Mercury: 'The smallest planet and the closest to the Sun. Does its reflected light show any gas bands at all?',
    Venus: 'The brightest planet, because its cloud tops reflect about three-quarters of the sunlight that reaches them. Use the molecule references to find out what is in its air.',
    Mars: 'The Red Planet. Watch how its reflected light climbs towards the red end, then use the references to find the gas in its thin air.',
    Jupiter: 'The largest planet, with more mass than all the others put together. It is bright in radio, as fast electrons spiral in its strong magnetic field.',
    Saturn: 'Its rings are mostly ice, and the planet itself is less dense than water. Its auroras glow in the ultraviolet.',
    Uranus: 'Its blue-green colour is a clue: something in its air absorbs red light. Find out what from the spectrum. It also spins tipped right over on its side.',
    Neptune: 'The farthest planet, and the first found by mathematics: in 1846 its position was predicted from its tug on Uranus. Is it blue for the same reason as Uranus?'
};

function homePlanetInfo({ entity }) {
    const block = entity.planet || {};
    const name = entity.name || 'This planet';
    return {
        kindLabel: 'Home planet',
        lead: 'A planet of our own Solar System.',
        summary: `${name}, a planet of our own Solar System, shining by reflected sunlight. It keeps its real name, but its place in this sky is made up.`,
        notes: present(
            orbitAndSizeNote(block, 'the Sun (never shown in this sky)'),
            HOME_NOTES[entity.name] && { heading: `About ${entity.name}`, text: HOME_NOTES[entity.name] },
            { heading: 'Reflected light', text: 'Its spectrum is sunlight, dimmed by its albedo, with bites taken out by any gases in its air. Use the Planet light tool to take the sunlight away, then compare what is left with the molecule references.' }
        ),
        rarity: 'Our Solar System has eight planets. Seven are in this sky; Earth is not.',
        catalogue: clean([planetRows(block, entity), observedRows(entity, entity, 'Radial velocity')])
    };
}

// Above about 200 K every rogue planet shows molecular bands before the 5 µm edge of the spectrum. Below that hardly any do.
const ROGUE_BANDS_FROM_K = 200;

function rogueBandsNote(block) {
    if (isNum(block.teff_K) && block.teff_K < ROGUE_BANDS_FROM_K) {
        return { heading: 'Clues in the infrared', text: 'This one is so cold that almost all of its glow lies beyond the 5 µm edge of the spectrum, so it may have no bands to show you. Warmer rogue planets show dark bands from the gases in their air, and those can be compared with the molecule references to find out what kind of planet each one is.' };
    }
    return { heading: 'Clues in the infrared', text: 'Dark bands in the glow come from gases in its air. Compare them with the molecule references to find out what kind of planet it is.' };
}

function roguePlanetInfo({ entity }) {
    const block = entity.rogue_planet || {};
    return {
        kindLabel: 'Rogue planet',
        lead: 'A planet with no star, showing only in infrared from its own faint warmth.',
        summary: 'A planet with no star. With nothing to reflect, it shows only in infrared, from its own faint warmth. Switch to IR to find it.',
        notes: [
            { heading: 'Thermal glow', text: 'All you can see is the heat left over from its formation, close to a black body curve. It is so cold that the peak lies far into the infrared, beyond the 5 µm edge of the spectrum.' },
            rogueBandsNote(block),
            { heading: 'How it got loose', text: 'Rogue planets are thought to be thrown out of young planetary systems by close passes with bigger planets. Some may have formed alone.' }
        ],
        rarity: 'Nobody knows how many there are. Estimates, from brief microlensing events, range from about one to about 20 per star.',
        catalogue: clean([
            row('Type', typeLabel(block)),
            row('Temperature', tempText(block.teff_K)),
            row('Atmosphere', atmosphereText(block)),
            row('Radius', num(block.radius_Rearth, ' Earth radii')),
            row('Mass', num(block.mass_Mearth, ' Earth masses')),
            observedRows(entity, entity)
        ])
    };
}

// ---------- Everything else ----------

function cometInfo({ entity }) {
    const block = entity.comet || {};
    const lines = Array.isArray(block.emission_lines) ? block.emission_lines : [];
    // A comet of another star (one with a host) is warmed, lit and blown back by that star, not the Sun
    const own = !!entity.host;
    const star = own ? 'its star' : 'the Sun';
    return {
        kindLabel: 'Comet',
        lead: `A lump of ice and dust, warmed by ${star} until it grows a glowing head and two tails.`,
        summary: own
            ? 'A lump of ice and dust on a long, stretched orbit round another star. Near its star it warms, and grows a glowing head and two tails that point away from the star; far out it is bare ice. Far too small to see from Earth, it is found by visiting its system.'
            : 'A lump of ice and dust, warmed by the Sun until it grows a glowing head and two tails. Every comet here points the same way, away from a Sun that is below the horizon and never shown.',
        notes: [
            { heading: 'Two kinds of light', text: `Its spectrum mixes light from ${star} reflected off dust, with ${own ? 'that star' : 'the Sun'}'s dark lines, and bright emission from gas in the coma. This is a chance to see reflection and emission side by side.` },
            { heading: "What's in the coma", text: 'Look for bright features near 388 nm, 470 to 563 nm and 589 nm. Compare them with the molecule and element references to name the gases.' },
            { heading: 'Two tails', text: `The dust tail is curved and yellow-white, because dust shines by reflected light and lags behind the comet. The ion tail is straight and blue, as charged gas is blown directly away from ${star}.` },
            { heading: 'Other bands', text: 'In the ultraviolet a huge halo of hydrogen glows in Lyman-α. In the infrared the dust itself glows.' }
        ],
        rarity: own
            ? 'Comets have been found round a few dozen other stars, from the gas and dust they carry across the face of their star.'
            : 'Thousands are known, but a comet bright enough for the naked eye turns up only every few years, and a "great" comet about once a decade.',
        catalogue: clean([
            row('Emission lines', lines.map((l) => present(l.label, isNum(l.w) && `${sig(l.w, 4)} nm`).join(' ')).filter(Boolean).join(', ')),
            row('Dust fraction', num(block.dust_ratio, '', 2)),
            observedRows(entity, entity)
        ])
    };
}

const NEBULA_TYPE = {
    emission: 'Emission nebula, lit by hot young stars inside it',
    planetary: 'Planetary nebula, gas shed by a dying star',
    dark: 'Dark nebula, a cold cloud of dust and gas',
    reflection: 'Reflection nebula, dust scattering nearby starlight'
};

function nebulaCatalogue(entity, block) {
    const lines = Array.isArray(block.emission_lines) ? block.emission_lines : [];
    return clean([
        row('Type', NEBULA_TYPE[block.type] || capital(words(block.type))),
        row('Emission lines', lines.map((l) => present(l.label, isNum(l.w) && `${sig(l.w, 4)} nm`).join(' ')).filter(Boolean).join(', ')),
        row('Central star', block.central_star ? spectralType(block.central_star) : null),
        row('Central star temperature', tempText(block.central_star?.teff_K)),
        observedRows(entity, entity)
    ]);
}

function nebulaInfo({ entity }) {
    const block = entity.nebula || {};
    const catalogue = nebulaCatalogue(entity, block);
    if (block.type === 'planetary') {
        return {
            kindLabel: 'Planetary nebula',
            lead: 'A glowing shell of gas puffed off by a dying star.',
            summary: 'A glowing shell of gas puffed off by a dying star. It has nothing to do with planets: the name stuck because these round discs looked like planets through early telescopes.',
            notes: [
                { heading: 'An emission spectrum', text: "Thin gas, lit by the hot star at the centre, gives bright lines on a dark background, not a continuum (Kirchhoff's rules). Compare it with the element and ionised references to find out what the gas is." },
                { heading: 'Lines in square brackets', text: 'Some of the strongest lines here are forbidden lines, such as [O III], which only appear in extremely thin gas.' },
                { heading: 'The end of a star', text: 'Stars up to about 8 times the mass of the Sun end this way. The core left at the centre is a white dwarf, with no fusion left, slowly cooling.' }
            ],
            rarity: 'Only about 3,000 are known in the Milky Way, out of perhaps 20,000, because each one fades within some tens of thousands of years.',
            catalogue
        };
    }
    if (block.type === 'dark') {
        return {
            kindLabel: 'Dark nebula',
            lead: 'A cold, dense cloud of dust and gas that blocks the light behind it.',
            summary: 'A cold, dense cloud of dust and gas. You see it only because it blocks the light of what lies behind it. Switch to infrared to see into it.',
            notes: [
                { heading: 'Why it is dark', text: 'Dust grains absorb and scatter visible light, blue more than red, so what gets through is dimmed and reddened.' },
                { heading: 'Try infrared', text: 'Longer wavelengths pass through dust far more easily, and the dust itself glows in the infrared. Young stars still forming inside the cloud come into view.' },
                { heading: 'Where stars begin', text: 'Clouds like this collapse under their own gravity to form new stars. Compare it with a glowing nebula, where newborn stars have lit the gas up.' }
            ],
            rarity: "Common along the Milky Way's plane, where dark lanes hide the stars behind them.",
            catalogue
        };
    }
    // Emission and reflection nebulae read the same: telling them apart is the student's job
    return {
        kindLabel: 'Nebula',
        lead: 'A huge cloud of gas and dust.',
        summary: "A huge cloud of gas and dust. Is it making its own light or scattering someone else's? Open the Spectrum tab to find out.",
        notes: [
            { heading: 'Bright lines or borrowed light?', text: "Bright lines on a dark background mean hot, thin gas making its own light: an emission spectrum (Kirchhoff's rules). A continuum with dark lines, copied from a nearby star, means dust is scattering starlight." },
            { heading: 'Naming the lines', text: 'If there are bright lines, compare them with the element and ionised references. Line up each one, then ask which atoms are in the gas. The same atoms make the same wavelengths in a star, a nebula and a lab.' },
            { heading: 'Other bands', text: 'Infrared shows the dust and the young stars hidden inside it. Radio shows the glow of hot ionised gas and cold hydrogen.' }
        ],
        rarity: 'Common. The Milky Way holds thousands of these clouds, strung along its spiral arms.',
        catalogue
    };
}

function clusterInfo({ entity }) {
    const block = entity.cluster || {};
    const memberCount = block.n_stars ?? (Array.isArray(block.members) ? block.members.length : null);
    const notes = [
        { heading: 'Reading its age', text: 'Massive stars use their fuel fastest, so they leave the main sequence first. Plot every member at once on the cluster H-R diagram: the turn-off shows the age, and the lower it sits, the older the cluster.' },
        { heading: 'Why clusters are so useful', text: 'All the stars formed together from one cloud, so they share an age, a distance and a starting mix. Differences between them come mostly from mass.' },
        { heading: 'Each star on its own', text: 'Every member has its own code and spectrum. Zoom in, select one and analyse it like any other star.' }
    ];
    const common = {
        next: { label: 'Open the H-R tab to start', tab: 'hr' },
        notes,
        catalogue: clean([
            row('Type', block.type ? `${capital(words(block.type))} cluster` : null),
            row('Age', ageText(block.age_Myr)),
            row('Member stars', memberCount !== null ? String(memberCount) : null),
            observedRows(entity, entity)
        ])
    };
    if (block.type === 'globular') {
        return {
            ...common,
            kindLabel: 'Globular cluster',
            lead: 'A dense ball of stars held together by gravity, all born at about the same time.',
            summary: 'A dense ball of stars held together by gravity, all born at about the same time. Compare its H-R diagram with an open cluster\'s.',
            rarity: 'The Milky Way has only about 150 to 200 of these.'
        };
    }
    if (block.type === 'open') {
        return {
            ...common,
            kindLabel: 'Open cluster',
            lead: 'A loose group of stars, all born at about the same time from one cloud. Zoom in to go among them and pick one out.',
            summary: 'A loose group of stars, all born at about the same time from one cloud. Compare its H-R diagram with a globular cluster\'s.',
            rarity: 'Thousands are known in the Milky Way. Most drift apart within a few hundred million years.'
        };
    }
    return {
        ...common,
        kindLabel: 'Star cluster',
        lead: 'A group of stars, all born at about the same time from one cloud.',
        summary: 'A group of stars, all born at about the same time from one cloud.',
        rarity: 'Thousands of star clusters are known in the Milky Way.'
    };
}

function neutronStarInfo({ entity }) {
    const block = entity.neutron_star || {};
    const pulsar = block.pulsar === true;
    const notes = [
        { heading: 'What it is', text: 'When a massive star explodes as a supernova, its core can collapse until protons and electrons are squeezed into neutrons. A teaspoon of it would have about the mass of a mountain.' },
        pulsar
            ? { heading: 'The lighthouse model', text: 'Beams of radio waves stream from its magnetic poles. As it spins, they sweep past us once per turn, so the pulse period is its spin period. Switch to Radio to see it pulse.' }
            : { heading: 'A quiet one', text: 'Not every neutron star pulses for us: the beams may miss us, or may have faded with age. Switch to X-ray to see the heat of its surface.' },
        { heading: 'A faint spectrum', text: 'In visible light there is almost nothing to see: a faint, nearly featureless thermal glow. It is so hot that its peak lies far off the chart, in the X-rays.' }
    ];
    return {
        kindLabel: pulsar ? 'Pulsar' : 'Neutron star',
        lead: `The collapsed core left by a supernova, ${pulsar ? 'flashing like a lighthouse' : 'about 20 km across'}.`,
        summary: `The collapsed core left by a supernova: more mass than the Sun, in a ball about 20 km across.${pulsar ? ' This one flashes like a lighthouse.' : ''}`,
        notes,
        rarity: 'The Milky Way may hold several hundred million to a billion. Only a few thousand are known, nearly all as pulsars.',
        catalogue: clean([
            row('Pulsar', yesNo(block.pulsar)),
            row('Pulse period', pulseText(block.pulse_period_s)),
            row('Gamma-ray pulses', block.gamma === true ? 'Yes' : null),
            row('Surface temperature', tempText(block.teff_K)),
            row('Supernova remnant', block.remnant_of || null),
            observedRows(entity, entity)
        ])
    };
}

const MORPHOLOGY_NOTE = {
    spiral: { heading: 'A spiral', text: 'Spiral arms are full of young stars and glowing gas, so look for Hα emission mixed in with the dark lines from the starlight.' },
    elliptical: { heading: 'An elliptical', text: 'Ellipticals are mostly old stars with little gas left to make new ones, so expect the dark lines of starlight and little else.' },
    irregular: { heading: 'An irregular', text: 'Irregulars have no tidy shape, often after a close pass by another galaxy. Clumps of young stars are common.' }
};

// "about 300 million", "about 2.4 billion": a hole's mass in words, in solar masses
function massWords(m) {
    if (!isNum(m)) return null;
    if (m >= 1e9) return `${sig(m / 1e9, 2)} billion`;
    if (m >= 1e6) return `${sig(m / 1e6, 2)} million`;
    return withCommas(Number(m.toPrecision(2)));   // Not Number(sig()): sig puts commas in from 1,000 up
}

// What a galaxy's own page says of the black hole at its middle
function centreNote(nucleus) {
    if (!nucleus || !nucleus.nucleus) return null;
    const n = nucleus.nucleus;
    if (n.active) {
        return { heading: 'Its black hole', text: `At its centre is a black hole of about ${massWords(n.mass_Msun)} times the Sun's mass, ${nucleus.code}, and it is feeding: gas falling in makes the bright point at the core. Zoom in on the core and click that point to study it.` };
    }
    return { heading: 'Its black hole', text: `Like nearly every big galaxy, it has a black hole at its centre, ${nucleus.code}, of about ${massWords(n.mass_Msun)} times the Sun's mass. Hardly any gas is falling in, so it is quiet and nothing of it shows.` };
}

function galaxyInfo({ entity }) {
    const block = entity.galaxy || {};
    const shape = MORPHOLOGY_NOTE[block.morphology] ? capital(block.morphology) : null;
    return {
        kindLabel: shape ? `${shape} galaxy` : 'Galaxy',
        lead: 'Billions of stars, too far away to pick out one by one.',
        summary: 'Billions of stars, too far away to pick out one by one. Their light adds up to a single spectrum, and its redshift tells you how fast the galaxy is moving away.',
        notes: present(
            { heading: 'Measuring the redshift', text: "Find the dark lines of starlight (Ca II H and K, Mg b, Na D) and see how far they have moved to longer wavelengths. Then z = Δλ/λ₀, and v = cz while z is 0.1 or less. Use the Velocity tool. A far galaxy's lines move a long way, so a dip near Hα's rest place may be another line moved there: check the pattern of several lines. Above z = 0.1, v = cz no longer applies, so quote z." },
            { heading: "Hubble's law", text: "In 1929 Edwin Hubble showed that the further away a galaxy is, the faster it recedes: v = H₀d. That is the evidence that the Universe is expanding. Read d with the Brightness tool, add the galaxy to the Hubble plot, and the gradient gives H₀." },
            MORPHOLOGY_NOTE[block.morphology],
            centreNote(entity.nucleus),
            { heading: 'Faint means noisy', text: 'Distant galaxies give noisy spectra. Measure several lines, and take note of the uncertainty the tool reports.' }
        ),
        rarity: 'Common: the observable Universe holds hundreds of billions. Among bright nearby ones, spirals lead, while the faint dwarfs that outnumber them all are too dim to see at these distances.',
        catalogue: clean([
            row('Shape', capital(words(block.morphology))),
            row('Redshift and recession velocity', velocityText(entity.radial_velocity_kms, block.z)),
            row('Distance', distanceText(entity.distance_pc)),
            row('Tilt', isNum(block.inclination_deg) ? `${Math.round(block.inclination_deg)}°` : null),
            row('Radio lobes', yesNo(block.radio_lobes)),
            row('Active nucleus', yesNo(block.active_nucleus)),
            row('Central black hole', entity.nucleus ? entity.nucleus.code : null),
            row('Measured brightness', isNum(entity.brightness?.flux_Wm2) ? `${sig(entity.brightness.flux_Wm2, 3)} W/m²` : null),
            row('Apparent magnitude', num(entity.brightness?.mag))
        ])
    };
}

const BLACK_HOLE_RARITY = 'The Milky Way may hold about 100 million stellar-mass black holes. Only a few dozen are known, nearly all found through a companion star.';

function blackHoleInfo({ entity }) {
    const block = entity.black_hole || {};
    const companion = block.companion;
    return {
        kindLabel: 'Black hole',
        lead: 'Something so massive and compact that not even light can escape it.',
        summary: 'You cannot see the hole itself. What you can see is a companion star swinging round something massive and dark, and gas glowing in X-rays as it falls in.',
        notes: present(
            { heading: 'Weighing the unseen', text: `Select the companion${companion?.code ? `, ${companion.code},` : ''} and use the Period tool to read its period T and its speed v. If the companion is much the lighter of the two, M ≈ v³T/(2πG). You don't know the tilt of the orbit, so this is a minimum mass.` },
            { heading: 'Why a black hole?', text: 'A neutron star cannot be heavier than about 3 M☉. Anything heavier that gives out no light of its own must be a black hole.' },
            { heading: 'Other bands', text: 'Gas falling in forms an accretion disc, hot enough to shine brightly in X-rays, which is the main way to find one. Some black holes also drive jets, seen in radio.' },
            { heading: 'Look closely', text: 'Zoom in: its gravity bends the light of stars behind it, and the side of the disc spinning towards you looks brighter.' }
        ),
        rarity: BLACK_HOLE_RARITY,
        catalogue: clean([
            row('Mass', num(block.mass_Msun, ' M☉')),
            row('Companion', companion?.code),
            row('Companion type', companion?.star ? spectralType(companion.star) : null),
            row('Companion mass', num(companion?.star?.mass_Msun, ' M☉')),
            row('Orbital period', periodText(block.period_days)),
            row("Companion's speed along the line of sight", num(block.K_kms, ' km/s')),
            row('Orbit tilt', isNum(block.inc_deg) ? `${Math.round(block.inc_deg)}°` : null),
            row('Jets', yesNo(block.jets)),
            observedRows(entity, entity, "System's radial velocity")
        ])
    };
}

// ---------- Black holes at the centres of galaxies ----------

const NUCLEUS_RARITY = 'Nearly every big galaxy has a black hole at its centre. Only about 1 nearby galaxy in 10 has one feeding brightly enough to see; this sky has a few more, so that you can find them.';

const BROAD_NOTE = {
    heading: 'How broad lines reveal a black hole',
    text: 'Gas close to the hole whirls round it at thousands of km/s. Some is coming towards you and some going away, so the Doppler effect spreads each line out: the wider the line, the faster the gas. Measure the width of Hα with Line zoom to find the speed v. How far out the gas is, R, comes from timing: when the disc brightens, the broad lines brighten a few days later, and that delay times the speed of light is R. Gravity holding gas that fast that close needs a mass M ≈ v²R/G: millions of Suns, in a space smaller than a few light-weeks. Only a black hole fits.'
};

function nucleusInfo({ entity, body }) {
    const n = entity.nucleus || {};
    const galaxy = entity.parent || body?.code;
    const mass = massWords(n.mass_Msun);
    const where = 'the centre of its galaxy';       // The Overview names the galaxy just below
    const typeText = n.type === 1 ? 'Type 1: seen down the dust ring\'s axis, broad lines show'
        : n.type === 2 ? 'Type 2: seen through the dust ring, broad lines hidden' : null;
    const catalogue = clean([
        row('Mass', isNum(n.mass_Msun) ? `${num(n.mass_Msun, ' M☉', 2)} (about ${mass})` : null),
        row('Galaxy', galaxy),
        row('Feeding', yesNo(n.active)),
        row('Kind', typeText),
        row('Radio jets', yesNo(n.jets)),
        row('Power given out', num(n.luminosity_Lsun, ' L☉', 2)),
        row('Share of its greatest possible power (Eddington ratio)', isNum(n.eddington_ratio) ? sig(n.eddington_ratio, 2) : null),
        row('X-ray power', num(n.xray_Lsun, ' L☉', 2)),
        row('Broad-line gas, distance from the hole', isNum(n.blr_light_days) ? `${sig(n.blr_light_days, 2)} light-days` : null),
        row('Broad lines, full width at half height', n.active && isNum(n.broad_fwhm_kms) ? `${withCommas(n.broad_fwhm_kms)} km/s` : null),
        row('Narrow lines, full width at half height', n.active && isNum(n.narrow_fwhm_kms) ? `${withCommas(n.narrow_fwhm_kms)} km/s` : null),
        row("Stars' speeds in the bulge (σ)", num(n.sigma_kms, ' km/s')),
        row('Redshift and recession velocity', velocityText(entity.radial_velocity_kms, n.z)),
        row('Distance', distanceText(entity.distance_pc))
    ]);
    if (!n.active) {
        return {
            kindLabel: 'Central black hole',
            lead: `A black hole of about ${mass} times the Sun's mass at ${where}. It is quiet: almost nothing is falling in.`,
            summary: `Nearly every big galaxy has a black hole at its centre, and the bigger the galaxy's bulge, the heavier it is. This one is quiet: so little gas falls in that it gives out almost no light, and what you see here is the light of the stars round it.`,
            notes: [
                { heading: 'Weighing a quiet one', text: "The stars near a galaxy's centre move faster round a heavier hole, so their lines are wider. Measure a line's width with Line zoom: the heavier the hole, the wider." },
                { heading: 'Our own Galaxy\'s', text: 'The Milky Way has one too, Sagittarius A*, about 4 million times the Sun\'s mass. Astronomers followed stars orbiting it for over 25 years, and Kepler\'s third law gave its mass. That work won the 2020 Nobel Prize in Physics. Zoom in on this one to see stars like those.' }
            ],
            rarity: NUCLEUS_RARITY,
            catalogue
        };
    }
    const notes = [BROAD_NOTE];
    if (n.type === 2) notes.push({ heading: 'Hidden by dust', text: 'A thick ring of dust surrounds the disc. From this side it blocks the disc and the fast gas, so the broad lines are hidden and only the narrow lines of slower gas further out show. The dust, warmed by the disc, glows in infrared, and X-rays get through it.' });
    else notes.push({ heading: 'Broad and narrow', text: 'Hα and Hβ are broad here, from gas close in. [O III] stays narrow: it only shines in thin gas far out, where things move far more slowly.' });
    notes.push(
        { heading: 'Measuring its redshift', text: "Its lines are shifted by its galaxy's redshift. Slide the reference lines onto them with the Doppler tool, as you would for the galaxy." },
        { heading: 'Other bands', text: `The hot disc shines most in ultraviolet and X-rays, and warm dust round it in infrared.${n.jets ? ' This one also drives jets, which glow in radio and blow up the giant lobes either side of its galaxy.' : ''}` }
    );
    return {
        kindLabel: 'Active galactic nucleus',
        lead: `A black hole of about ${mass} times the Sun's mass at ${where}, feeding on gas that glows as it falls in.`,
        summary: 'Gas spiralling into a giant black hole heats up and shines, and can outshine the galaxy\'s billions of stars from a space smaller than a few light-weeks.',
        notes,
        rarity: NUCLEUS_RARITY,
        catalogue
    };
}

// One of the few stars on close orbits round a galaxy's central black hole
function closeStarInfo(entity, body, parent) {
    const star = entity.star;
    const hole = parent ? nucleusOf(body, parent) : null;
    const i = hole ? hole.nucleus.stars.indexOf(entity) : -1;
    const orbit = i >= 0 ? hole.nucleus.orbits[i] : null;
    return {
        kindLabel: 'Star near a giant black hole',
        lead: 'A star on a tight, fast orbit round the black hole at the centre of its galaxy.',
        summary: `One of a few stars on tight, fast orbits round the black hole${parent ? ` ${parent}` : ''}. From this far away it is lost in the light of its galaxy, so its spectrum is mostly noise.`,
        notes: [
            { heading: 'Weighing a black hole with stars', text: 'At the centre of our own Galaxy, astronomers followed stars like this round Sagittarius A* for over 25 years. Their orbits, with Kepler\'s third law, r³/T² = GM/4π², gave its mass: about 4 million times the Sun\'s.' }
        ],
        rarity: 'Only round our own Galaxy\'s black hole are stars like this close enough to follow.',
        catalogue: clean([
            row('Black hole', parent),
            row('Orbit, average distance', orbit ? `${withCommas(Math.round(orbit.a_AU))} AU` : null),
            row('Orbital period', orbit ? periodText(orbit.period_days) : null),
            starRows(star),
            observedRows(entity, body)
        ])
    };
}

// The nucleus a close star belongs to, from its galaxy: no lookup through the app, so this stays pure
function nucleusOf(body, code) {
    return body && body.nucleus && body.nucleus.code === code ? body.nucleus : null;
}

const SUPERNOVA_TYPE = {
    Ia: 'Type Ia: a white dwarf that took on too much mass and blew apart',
    II: 'Type II: a massive star whose core collapsed'
};

function supernovaInfo({ entity }) {
    const block = entity.supernova || {};
    const phase = block.phase0_days;
    return {
        kindLabel: 'Supernova',
        lead: 'A star exploding, for a few weeks about as bright as a whole galaxy.',
        next: { label: 'Play its light curve', tab: 'spectrum', tool: 'light-curve' },
        summary: 'A star exploding. For a few weeks it can shine about as brightly as a whole galaxy. Watch its light and spectrum change, then decide which type it is.',
        notes: [
            { heading: 'Which type?', text: 'Type Ia: no hydrogen lines, and a strong Si II line near 615 nm. Type II: strong hydrogen Balmer lines with P Cygni profiles. Compare the spectrum with the H and Si II references.' },
            { heading: 'P Cygni profiles', text: 'An expanding shell makes a bright emission peak with a blueshifted dark dip beside it. The dip comes from the gas in front, rushing towards you. The peak comes from the gas round the sides.' },
            { heading: 'What it leaves behind', text: 'Each kind scatters heavy elements into space, ready for new stars and planets. The iron in your blood was made in stars and spread by explosions like this. Play on to watch the expanding shell become a remnant.' }
        ],
        rarity: 'In a galaxy like the Milky Way, roughly 1 to 3 per century. The last one seen in our galaxy was in 1604, just before the telescope. Seeing several at once, as you can here, would never happen.',
        catalogue: clean([
            row('Type', SUPERNOVA_TYPE[block.type] || (block.type ? `Type ${block.type}` : null)),
            row('Starts at', isNum(phase) ? `${sig(Math.abs(phase), 3)} days ${phase < 0 ? 'before' : 'after'} its peak` : null),
            row('Peak apparent magnitude', num(block.peak_mag)),
            row('Remnant', block.remnant_code || null),
            row('Radial velocity', velocityText(entity.radial_velocity_kms)),
            row('Distance', distanceText(entity.distance_pc))
        ])
    };
}

function quasarInfo({ entity }) {
    const block = entity.quasar || {};
    return {
        kindLabel: 'Quasar',
        lead: 'The blazing core of a very distant galaxy, looking like a faint star.',
        summary: 'It looks like a faint star, but it is the blazing core of a very distant galaxy, powered by gas falling into a supermassive black hole.',
        notes: [
            { heading: 'A huge redshift', text: 'The bright lines (Hα, Hβ, Mg II and Lyman-α) have moved so far that they are hard to recognise at first: λ = (1 + z)λ₀. Lyman-α sits at 121.6 nm in the lab, deep in the ultraviolet, but here it can land in visible light. Try matching the pattern of spacings.' },
            { heading: 'Where v = cz fails', text: 'v = cz only works for small redshifts. It fails badly at a redshift this large, and above z = 1 it would even give a speed faster than light. The light has been stretched by the expansion of space on its way here, so quote z itself.' },
            { heading: 'Broad bright lines', text: 'Gas close to the black hole moves at thousands of km/s, so Doppler shifts spread its emission lines very wide. Compare them with the narrow lines of a nebula.' }
        ],
        rarity: 'Very rare: very roughly 1 in 100,000 galaxies hosts one today. That is only a rough figure, and it depends on how bright counts as a quasar. They were far more common about 10 billion years ago.',
        catalogue: clean([
            row('Redshift', isNum(block.z) ? velocityText(null, block.z) : null),
            row('Distance', isNum(block.z) || isNum(entity.distance_pc) ? "Too far for Hubble's straight line, v = H₀d, to apply" : null),
            row('Radio-loud', yesNo(block.radio_loud)),
            row('Blazar', block.blazar === true ? 'Yes' : null),
            row('Measured brightness', isNum(entity.brightness?.flux_Wm2) ? `${sig(entity.brightness.flux_Wm2, 3)} W/m²` : null),
            row('Apparent magnitude', num(entity.brightness?.mag))
        ])
    };
}

function unknownInfo({ entity }) {
    return {
        kindLabel: capital(words(entity.kind)) || 'Object',
        lead: 'An object in this sky.',
        summary: 'An object in this sky. Open the Spectrum tab to see what its light can tell you.',
        notes: [],
        rarity: '',
        catalogue: clean([observedRows(entity, entity)])
    };
}

const BUILDERS = {
    star: starInfo,
    binary: multipleInfo,
    multiple: multipleInfo,
    star_component: componentInfo,
    cluster_member: clusterMemberInfo,
    planet: planetInfo,
    home_planet: homePlanetInfo,
    rogue_planet: roguePlanetInfo,
    comet: cometInfo,
    nebula: nebulaInfo,
    cluster: clusterInfo,
    neutron_star: neutronStarInfo,
    galaxy: galaxyInfo,
    black_hole: blackHoleInfo,
    nucleus: nucleusInfo,
    supernova: supernovaInfo,
    quasar: quasarInfo
};

// The first thing a student needs telling, for nearly everything in the sky
const START_WITH_SPECTRUM = { label: 'Open the Spectrum tab to start', tab: 'spectrum' };


export function infoFor(resolved) {
    const entity = resolved?.entity || {};
    const build = BUILDERS[entity.kind] || unknownInfo;
    return { title: entity.name || entity.code || 'Unknown object', next: START_WITH_SPECTRUM, ...build({ ...resolved, entity }) };
}
