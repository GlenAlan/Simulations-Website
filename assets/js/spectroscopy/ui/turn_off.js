// A cluster's turn-off, placed by the student. Plotting a cluster puts nothing where the answer is: the turn-off waits low on the
// main sequence, and the student drags it up to where the stars leave the main sequence and bend away towards the giants. The
// age then follows from where they put it, worked out in steps. Nothing says whether it is right; the catalogue age is the check.
//
// ui/hr.js keeps the cluster's state and its draggable handle, and calls these:
//   newTurnOff()                                   -> { turnOffLogL, placed: false }, spread into the cluster's state
//   turnOffWords(cluster, age, ageText, errorPercent) -> { age, status, working: [lines] | null, notes: [lines] }
//                                                     age is turnOffAge(cluster.turnOffLogL); age and status are '' until placed
//   drawTurnOff(ctx, rect, sx, sy, theme, cluster) draws the line across the diagram
//   turnOffGrip(rect, sx, sy, cluster, msTemperature) -> { x, y } where the handle goes: on the main sequence, at the line
//   turnOffValueText(cluster, age, ageText)        -> what the handle says to a screen reader

import { sig } from '../core/format.js';
import { fontOf, haloText } from './plot2d.js';

// Down among the red dwarfs, below where any cluster in this sky turns off
export const PARKED_LOG_L = -2.5;

export function newTurnOff() {
    return { turnOffLogL: PARKED_LOG_L, placed: false };
}

export function turnOffWords(cluster, age, ageText, errorPercent) {
    const notes = [
        'A star about to leave the main sequence is roughly twice as bright as when it formed, hence L ÷ 2. The cluster is about as old as the lifetime of these stars.',
        `Read the age as ± ${errorPercent}%. These are rough rules: with the line at the bend, this sky's clusters come out between about 0.8 and 1.4 times their catalogue age.`,
        cluster.type === 'globular'
            ? 'Globular clusters have lost their hot, bright stars, so the main sequence stops low down and red giants stand out.'
            : 'Open clusters are usually young enough to keep hot, bright stars high on the main sequence.',
        'Luminosities come from each star\'s brightness and the cluster\'s distance. Temperatures are catalogue values with a little noise, as nobody measures every star by hand.'
    ];
    if (!cluster.placed) {
        return { age: '', status: 'Drag the turn-off up the main sequence to where its stars bend away.', working: null, notes };
    }
    const L = 10 ** cluster.turnOffLogL;
    return {
        age: `Age ≈ ${ageText(age.ageGyr)} ± ${errorPercent}%`,
        status: age.ageGyr > 15
            ? 'That is longer than the Universe has existed (about 13.8 billion years), so the turn-off is probably higher.'
            : `Turn-off near ${sig(age.T, 2)} K, ${sig(L, 2)} L☉.`,
        working: [
            `Mass: M ≈ (L ÷ 2)^(1/3.5) = (${sig(L, 2)} ÷ 2)^(1/3.5) = ${sig(age.massMsun, 2)} M☉`,
            `Age: t ≈ 10 billion years × M^−2.5 ≈ ${ageText(age.ageGyr)}`
        ],
        notes
    };
}

export function drawTurnOff(ctx, rect, sx, sy, theme, cluster) {
    const y = sy(cluster.turnOffLogL);
    ctx.save();
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = cluster.placed ? 1 : 0.7;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(rect.x, y);
    ctx.lineTo(rect.x + rect.w, y);
    ctx.stroke();
    ctx.restore();
    haloText(ctx, cluster.placed ? 'Turn-off' : 'Turn-off: drag up to the bend', rect.x + 6, y - 9, theme, { font: fontOf(theme, 12, 600) });
}

export function turnOffGrip(rect, sx, sy, cluster, msTemperature) {
    const x = Math.max(rect.x + 10, Math.min(rect.x + rect.w - 10, sx(msTemperature(cluster.turnOffLogL))));
    return { x, y: sy(cluster.turnOffLogL) };
}

export function turnOffValueText(cluster, age, ageText) {
    return cluster.placed
        ? `${sig(10 ** cluster.turnOffLogL, 2)} solar luminosities, age estimate ${ageText(age.ageGyr)}`
        : 'Not placed yet. Move it up to where the main sequence bends.';
}
