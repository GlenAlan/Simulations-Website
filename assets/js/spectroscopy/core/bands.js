// The five sky bands. Order matters: it is the order of the band switcher, the uBandW uniform and the
// aBandA/aBandB attributes (see render/shared.js). No DOM or WebGL.
//
// tint is a band's main false colour, used for every object in it. ramp runs from its faintest glow to its brightest,
// used by the sky-wide glow and the legend; the visible band has none, as its colours are real. All are linear RGB. Apart from hue, the bands differ in lightness (X-ray
// lightest, then radio, infrared, ultraviolet), so they stay apart under every kind of colour blindness; the band's
// name is always on screen as well, in the switcher and the legend.

export const BANDS = ['radio', 'ir', 'visible', 'uv', 'xray'];

// A band strength at or below this draws nothing a student could make out. The Overview's band row and Go to's
// "Hidden in..." prompt both go by it, so they can't disagree.
export const BAND_HIDDEN_AT = 0.03;

export const BAND_INFO = {
    radio: {
        label: 'Radio', short: 'Radio',
        tint: [1.0, 0.6, 0.05],       // Amber, false colour
        ramp: { low: [0.36, 0.09, 0.004], high: [1.0, 0.78, 0.25] },
        falseColour: true,
        legend: 'Fast electrons and hot gas glow here: pulsars, jets and supernova shells.'
    },
    ir: {
        label: 'Infrared', short: 'IR',
        tint: [1.0, 0.06, 0.3],       // Red-magenta, false colour
        ramp: { low: [0.32, 0.006, 0.11], high: [1.0, 0.26, 0.42] },
        falseColour: true,
        legend: 'Warm dust and cool objects glow here. Look for small orange points: planets with no star.'
    },
    visible: {
        label: 'Visible', short: 'Visible',
        tint: [1, 1, 1],              // Objects keep their real colours
        falseColour: false,
        legend: 'Starlight and glowing gas, in the colours your eyes would see.'
    },
    uv: {
        label: 'Ultraviolet', short: 'UV',
        tint: [0.3, 0.1, 1.0],        // Deep blue-violet, false colour
        ramp: { low: [0.07, 0.015, 0.45], high: [0.52, 0.4, 1.0] },
        falseColour: true,
        legend: 'Hot stars, white dwarfs and young clusters glow here. Flares and nearby cool stars can show too.'
    },
    xray: {
        label: 'X-ray and gamma', short: 'X-ray/γ',
        tint: [0.45, 0.95, 1.0],      // Cyan-white, false colour
        ramp: { low: [0.01, 0.2, 0.3], high: [0.86, 1.0, 1.0] },
        falseColour: true,
        legend: 'Gas at millions of degrees glows here, around black holes and in supernova shells.'
    }
};

export function bandIndex(band) {
    return BANDS.indexOf(band);
}

// The azimuth of the galaxy's bright centre, on the band (core/sky.js). Radio, infrared and gamma all peak here, and the
// default view looks towards it; the visible Milky Way's bulge should sit here too.
export const GALACTIC_CENTRE_AZ = 245;

// A false-colour band's colour at a glow of 0 (none) to 1 (its brightest), in linear RGB. band_sky.js has the same sum in GLSL.
export function bandRampColour(band, i) {
    const { low, high } = BAND_INFO[band].ramp;
    const t = Math.min(1, Math.max(0, i));
    const k = t * t * (3 - 2 * t);
    return low.map((c, n) => (c + (high[n] - c) * k) * i);
}
