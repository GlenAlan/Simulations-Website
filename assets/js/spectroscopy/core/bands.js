// The five sky bands. Order matters: it is the order of the band switcher, the uBandW uniform and the
// aBandA/aBandB attributes (see render/shared.js). No DOM or WebGL.

export const BANDS = ['radio', 'ir', 'visible', 'uv', 'xray'];

export const BAND_INFO = {
    radio: {
        label: 'Radio', short: 'Radio',
        tint: [1.0, 0.62, 0.18],      // Amber, false colour
        falseColour: true,
        legend: 'False colour. Glows here: hot gas, pulsars and jets.'
    },
    ir: {
        label: 'Infrared', short: 'IR',
        tint: [1.0, 0.22, 0.55],      // Red-magenta, false colour
        falseColour: true,
        legend: 'False colour. Glows here: warm dust and cool objects, even dark planets.'
    },
    visible: {
        label: 'Visible', short: 'Visible',
        tint: [1, 1, 1],              // Objects keep their real colours
        falseColour: false,
        legend: 'True colour. Starlight and glowing gas, as your eyes would see them.'
    },
    uv: {
        label: 'Ultraviolet', short: 'UV',
        tint: [0.42, 0.34, 1.0],      // Deep blue-violet, false colour
        falseColour: true,
        legend: 'False colour. Glows here: the hottest stars, whose light peaks in the ultraviolet.'
    },
    xray: {
        label: 'X-ray and gamma', short: 'X-ray/γ',
        tint: [0.45, 0.95, 1.0],      // Cyan-white, false colour
        falseColour: true,
        legend: 'False colour. Glows here: gas at millions of degrees, around black holes and in supernova shells.'
    }
};

export function bandIndex(band) {
    return BANDS.indexOf(band);
}
