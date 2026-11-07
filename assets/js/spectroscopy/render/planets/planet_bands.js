// How a planet looks in each band, up close (spec section 5), from its own data as the sky's band table does. Visible is
// reflected starlight, as it always was. Infrared is the planet's own heat: hot Jupiters and lava worlds blaze, cold worlds are
// dim, and the day side outshines the night where nothing carries the heat round. Ultraviolet is reflected by air and haze
// (Rayleigh scattering grows as 1/wavelength^4) and dark on bare rock; auroras ring the poles of a giant with a strong field,
// which is also what radio sees. X-rays: almost nothing, a little of the star's own scattered back.
// Plain maths and GLSL text, no three.js, so it loads under Node.

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
};

// The uniforms and functions the planet's shaders use. uBandW and uBandTint are the sky's own (render/shared.js).
export const PLANET_BAND_GLSL = /* glsl */`
uniform float uBandW[5];
uniform vec3 uBandTint[5];
uniform vec4 uBandReflect;  // Reflected light in radio, infrared, ultraviolet and X-rays, against visible light
uniform vec2 uBandHeat;     // Infrared: the planet's own heat, and how much brighter its day side is than its night
uniform vec3 uBandAurora;   // Auroras round the magnetic poles, in radio, ultraviolet and X-rays

vec3 bandReflect(vec3 c, vec4 k) {
    if (uBandW[2] > 0.999) return c;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return c * uBandW[2] + lum * (uBandTint[0] * (k.x * uBandW[0]) + uBandTint[1] * (k.y * uBandW[1])
        + uBandTint[3] * (k.z * uBandW[3]) + uBandTint[4] * (k.w * uBandW[4]));
}

vec3 bandShade(vec3 c, vec3 albedo, float heat, vec3 P, vec3 L, float facing) {
    if (uBandW[2] > 0.999) return c;
    float day = smoothstep(-0.3, 0.8, dot(P, L));
    // Bright cloud tops are high and cold, darker gaps let out heat from below
    float tops = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    float ir = uBandHeat.x * mix(1.0, day, uBandHeat.y) * (0.6 + 0.4 * facing) * (1.2 - 0.4 * tops) + heat * 1.4;
    float oval = exp(-pow((abs(P.y) - 0.93) * 26.0, 2.0));
    return bandReflect(c, uBandReflect) + uBandTint[1] * (ir * uBandW[1])
        + uBandTint[0] * (uBandAurora.x * (oval + 0.04 * facing) * uBandW[0])
        + oval * (uBandTint[3] * (uBandAurora.y * uBandW[3]) + uBandTint[4] * (uBandAurora.z * uBandW[4]));
}
`;

// The values behind those uniforms, from the planet's data and its look (appearance.js)
export function planetBandLook(planet, look) {
    const giant = look.model !== 'solid';
    const p = planet.pressure_bar ?? 0;
    const thick = giant || p > 5;
    // What the heat comes from: cloud tops under a thick sky, the ground under a thin one
    const T = (thick ? planet.T_eq_K : planet.T_surface_K ?? planet.T_eq_K) ?? 200;
    const airless = !giant && p < 0.01;
    // A locked world's night side never sees its star; air and winds carry heat round, a thick sky most
    const dayNight = planet.tidally_locked ? (thick ? (T > 1000 ? 0.75 : 0.35) : 0.9) : airless ? 0.7 : thick ? 0.1 : 0.35;
    const uv = giant ? 0.55 : airless ? 0.18 : 0.25 + 0.4 * smooth(0.05, 3, p);
    const field = clamp(((planet.bands && planet.bands.radio) || 0) / 0.1, 0, 1);
    return {
        reflect: [0, 0.25, uv, 0.015],
        // Up to a glow as bright as a cool star's for the hottest, with a steep fall to the coldest, as T^4 would give
        heat: [Math.min(2.2, 0.03 + 1.6 * (T / 1500) ** 2), dayNight],
        aurora: [1.6 * field, 1.4 * field, 0.5 * field]
    };
}

// A planet only a few pixels across, as one colour in the current mix of bands (a speck's glow, or the smear of a fast orbit)
export function planetBandValues(bl, meanRgb) {
    const lum = (0.2126 * meanRgb[0] + 0.7152 * meanRgb[1] + 0.0722 * meanRgb[2]) * 0.6;
    return [
        0.2 * bl.aurora[0],
        bl.heat[0] * (1 - 0.4 * bl.heat[1]) + lum * bl.reflect[1],
        1,
        lum * bl.reflect[2] + 0.15 * bl.aurora[1],
        lum * bl.reflect[3] + 0.08 * bl.aurora[2]
    ];
}
