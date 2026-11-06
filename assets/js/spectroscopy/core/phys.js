// Physical constants and formulas used across the simulation. No DOM or WebGL.

export const C_MS = 2.998e8;            // Speed of light (m/s)
export const C_KMS = 2.998e5;
export const WIEN_B = 2.898e-3;         // Wien's constant (m K)
export const H = 6.62607015e-34;        // Planck's constant (J s)
export const K_B = 1.380649e-23;        // Boltzmann's constant (J/K)
export const SIGMA = 5.670374419e-8;    // Stefan-Boltzmann constant (W m^-2 K^-4)
export const H0 = 70;                   // Hubble's constant (km/s/Mpc)
export const G = 6.6743e-11;            // Gravitational constant (N m^2 kg^-2)
export const L_SUN = 3.828e26;          // W
export const R_SUN = 6.957e8;           // m
export const M_SUN = 1.989e30;          // kg
export const R_EARTH = 6.371e6;         // m
export const M_EARTH = 5.972e24;        // kg
export const AU = 1.495978707e11;       // m
export const PC = 3.0856775814914e16;   // m
export const LY_PER_PC = 3.26156;

// Spectral range of the detailed spectra (nm), spec section 5
export const SPECTRUM_LO_NM = 90;
export const SPECTRUM_HI_NM = 5000;
export const R_OVERVIEW = 5000;
export const R_ZOOM = 100000;

// Spectral radiance per unit wavelength, B_lambda (W m^-2 sr^-1 m^-1), from wavelength in nm
export function planck(wavelengthNm, T) {
    const l = wavelengthNm * 1e-9;
    const x = (H * C_MS) / (l * K_B * T);
    if (x > 700) return 0;
    return (2 * H * C_MS * C_MS) / (l ** 5 * Math.expm1(x));
}

export function wienPeakNm(T) {
    return (WIEN_B / T) * 1e9;
}

export function wienTemperature(peakNm) {
    return WIEN_B / (peakNm * 1e-9);
}

// Habitable zone edges (AU), spec section 13: main-sequence stars only
export function hzEdges(luminosityLsun) {
    return { inner: Math.sqrt(luminosityLsun / 1.1), outer: Math.sqrt(luminosityLsun / 0.53) };
}

// Kepler's third law in solar units: period in days from AU and solar masses
export function keplerPeriodDays(aAU, massMsun) {
    return 365.25 * Math.sqrt((aAU ** 3) / massMsun);
}

// Circular orbital speed (km/s), v = 2 pi r / T
export function orbitalSpeedKms(aAU, periodDays) {
    return (2 * Math.PI * aAU * AU) / (periodDays * 86400) / 1000;
}

// Bolometric flux (W/m^2) from luminosity and distance, b = L / (4 pi d^2)
export function fluxFromLuminosity(luminosityLsun, distancePc) {
    const d = distancePc * PC;
    return (luminosityLsun * L_SUN) / (4 * Math.PI * d * d);
}

export function luminosityFromFlux(fluxWm2, distancePc) {
    const d = distancePc * PC;
    return (4 * Math.PI * d * d * fluxWm2) / L_SUN;
}

// Observed wavelength from a rest wavelength and a velocity (km/s, positive = moving away), for |z| < 0.1
export function shiftByVelocity(restNm, velocityKms) {
    return restNm * (1 + velocityKms / C_KMS);
}

export function shiftByZ(restNm, z) {
    return restNm * (1 + z);
}

export function velocityFromShift(observedNm, restNm) {
    return ((observedNm - restNm) / restNm) * C_KMS;
}

// Surface gravity log10(g in cm/s^2) from solar units, matching the spec's log g column
export function logG(massMsun, radiusRsun) {
    return 4.438 + Math.log10(massMsun) - 2 * Math.log10(radiusRsun);
}

// Approximate colour of a black body as linear RGB in 0..1, for sprites and the temperature-coloured plots.
// Fit to the CIE locus; good from 1,000 K to 40,000 K and clamped outside.
export function blackBodyRGB(T) {
    const t = Math.min(40000, Math.max(1000, T)) / 100;
    let r;
    let g;
    let b;
    if (t <= 66) {
        r = 255;
        g = 99.4708025861 * Math.log(t) - 161.1195681661;
        b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    } else {
        r = 329.698727446 * (t - 60) ** -0.1332047592;
        g = 288.1221695283 * (t - 60) ** -0.0755148492;
        b = 255;
    }
    const toLinear = (v) => {
        const s = Math.min(255, Math.max(0, v)) / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return [toLinear(r), toLinear(g), toLinear(b)];
}
