// Photometer: the object's measured brightness b and its distance, which give L = 4 pi d^2 b for the H-R diagram.

import * as synth from '../../../spectra/synth.js';
import { registerTool } from './index.js';
import { recordMeasurement, getMeasurement } from '../../../core/measurements.js';
import { LY_PER_PC, luminosityFromFlux } from '../../../core/phys.js';
import { sci, sig } from '../../../core/format.js';
import { actionRow, diagramLink, fill, para, resultLine, statusBox, toolLink } from './common.js';

function reading(entity, t) {
    return synth.photometer(entity, t === undefined ? {} : { t });
}

const AU_PER_PC = 206265;
const LOCAL_PC = 0.01;           // Nearer than this, an object is in our own solar system, and AU is what reads best

function lightYears(ly) {
    return ly >= 1e6 ? `${sig(ly / 1e6, 3)} million light-years` : `${sig(ly, 3)} light-years`;
}

function parsecs(pc) {
    if (pc < LOCAL_PC) return `${sig(pc * AU_PER_PC, 3)} AU (${sig(pc, 3)} pc)`;
    return pc >= 1e6 ? `${sig(pc / 1e6, 3)} Mpc (${sig(pc, 3)} pc)` : `${sig(pc, 3)} pc`;
}

// A planet or a comet shines by reflected sunlight, so L = 4 pi d^2 b wouldn't be what it gives out
function shinesByItself(entity) {
    return !['planet', 'home_planet', 'comet'].includes(entity.kind);
}

function mount(container, api) {
    const result = statusBox();
    container.append(result);
    const offs = [];

    function run() {
        const { entity } = api.resolved;
        const { t } = api.getBodyOpts();
        const r = reading(entity, t);
        const code = entity.code;
        const hasDistance = r.distance_pc > 0;
        const hasFlux = r.flux_Wm2 > 0;
        const values = {};
        if (hasFlux) {
            values.flux_Wm2 = r.flux_Wm2;
            values.flux_err = r.err_Wm2;
        }
        if (hasDistance) values.distance_pc = r.distance_pc;
        const ownLight = hasFlux && hasDistance && shinesByItself(entity);
        if (ownLight) {
            const L = luminosityFromFlux(r.flux_Wm2, r.distance_pc);
            values.L_Lsun = L;
            values.L_err_Lsun = L * (r.err_Wm2 / r.flux_Wm2);
        }
        recordMeasurement(code, values);
        const m = getMeasurement(code) || {};
        const go = diagramLink();
        fill(result,
            hasFlux
                ? resultLine(`b = ${sci(r.flux_Wm2, 3)} ± ${sci(r.err_Wm2, 2)} W/m²`, true)
                : resultLine('Too faint to measure at this moment', true),
            hasDistance
                ? resultLine(`d = ${parsecs(r.distance_pc)}, or ${lightYears(r.distance_ly ?? r.distance_pc * LY_PER_PC)}`)
                : resultLine('No distance is known for this object'),
            ownLight ? para('Luminosity follows from L = 4πd²b, with d in metres. Brightness is how much arrives here; luminosity is how much the object gives out in all directions.') : null,
            hasFlux && !shinesByItself(entity) ? para('This is reflected sunlight, so it says how much light is bounced back this way and not how much the object gives out.') : null,
            actionRow(go, go && !(m.T_K > 0) && go.textContent === 'Add to H-R' ? toolLink(api, 'wien', 'Wien\'s law next') : null)
        );
    }

    // A supernova's brightness changes as its light curve plays. Nothing else's does.
    offs.push(api.onBodyOpts((changed) => {
        if (changed && 't' in changed && api.resolved.entity.kind === 'supernova') run();
    }));

    return {
        setEntity: run,
        dispose() {
            offs.forEach((off) => off());
        }
    };
}

registerTool({
    id: 'photometer',
    label: 'Photometer',
    appliesTo: () => typeof synth.photometer === 'function',
    mount
});
