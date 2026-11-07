// A supernova's visible light curve: its apparent magnitude any number of days after t = 0, a pure function of its
// data so that the sky, the panel and the spectra agree. Simple textbook shapes, not fits: a type Ia rises fast then
// fades steadily on radioactive decay; a type II holds a long plateau, drops, then fades slowly.

const RISE_DAYS = 18;
const FADED_BELOW_PEAK = 12;     // By then it has faded into its remnant, which holds at about this level

export function supernovaMag(supernova, tDays = 0) {
    const phase = supernova.phase0_days + tDays;
    const peak = supernova.peak_mag;
    let below;
    if (phase <= 0) {
        const r = Math.min(1, -phase / RISE_DAYS);
        below = 7 * r * r;
    } else if (supernova.type === 'Ia') {
        below = phase < 30 ? 0.1 * phase : 3 + 0.015 * (phase - 30);
    } else if (phase < 90) {
        below = 0.012 * phase;
    } else if (phase < 115) {
        below = 1.08 + 0.09 * (phase - 90);
    } else {
        below = 3.33 + 0.01 * (phase - 115);
    }
    return peak + Math.min(FADED_BELOW_PEAK, below);
}
