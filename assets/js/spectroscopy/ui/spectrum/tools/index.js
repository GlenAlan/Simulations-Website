// The registry behind the Spectrum tab's row of tool buttons. A tool registers itself when its module loads:
//
//   registerTool({ id, label, draws, appliesTo(resolved), mount(container, panelApi) -> { setEntity(resolved), dispose() } })
//
// mount runs when the student opens the tool, followed by setEntity; dispose runs when they close it, or when the
// next object isn't one the tool applies to. A tool removes its own overlays and resets what it asked of the panel
// (setBodyOpts, setResolution) in dispose. panelApi is described at the top of ../panel.js. setEntity runs once the
// new spectrum is ready; panelApi.getSpectrum() is null only for an object with no spectrum, where the tools are hidden.
//
// Only one tool is open at a time, so opening one closes the last and its dispose hands back the plot. draws: true marks a
// tool that draws on the plot or takes over its view. A tool may also return onPanelHide(), called when the Spectrum tab
// goes out of view, to pause what it's playing.
//
// To add a tool, write tools/<name>.js, which imports registerTool from here, import it at the bottom of this file, and
// give it words in WORDS.

// Kept on a hoisted function rather than in a const: a tool imported below runs before the body of this module
function registry() {
    if (!registry.tools) registry.tools = [];
    return registry.tools;
}

export function registerTool(tool) {
    const tools = registry();
    const at = tools.findIndex((t) => t.id === tool.id);
    if (at >= 0) tools[at] = tool;
    else tools.push(tool);
    return tool;
}

export function listTools() {
    return registry().slice();
}

// What each tool's button says, short enough to sit in a row, and what it's for.
//   staysOpen   it changes whose light is shown, so it can stay open beside another tool
//   leavesPlot  it needs no room of its own, so the plot stays at full size while it's open
//   ownFigure   it has a figure of its own, and needs the room for that more than it needs the plot beside it
//   comesBack   left on, it comes back on the next object it applies to
function words(id) {
    switch (id) {
    case 'wien': return { short: 'Wien\'s law', about: 'Find the temperature from where the curve peaks' };
    case 'doppler': return { short: 'Doppler', about: 'Find the speed from how far a line has shifted' };
    case 'line-zoom': return { short: 'Line zoom', about: 'Look closely at one line and measure its width' };
    case 'photometer': return { short: 'Photometer', about: 'Read the brightness and the distance' };
    case 'time-series': return { short: 'Time series', about: 'Follow the lines over time to find the period', ownFigure: true };
    case 'stars-shown': return { short: 'Stars shown', about: 'Choose which stars\' light makes up the spectrum', staysOpen: true };
    case 'light-curve': return { short: 'Light curve', about: 'Brightness against time, with Play', ownFigure: true };
    case 'pulse-timing': return { short: 'Pulse timing', about: 'Time the pulses to find how fast it spins', ownFigure: true };
    case 'subtract-star': return { short: 'Subtract star', about: 'Remove the host star\'s light', staysOpen: true, leavesPlot: true, comesBack: true };
    default: return {};
    }
}

export function toolWords(tool) {
    return { short: tool.label, about: tool.label, ...words(tool.id) };
}

// ---------- Words in text that name a tool, as buttons that go there ----------

const NAMED = [
    { phrase: 'the Wien tool', tool: 'wien' },
    { phrase: 'Wien tool', tool: 'wien' },
    { phrase: 'the Doppler tool', tool: 'doppler' },
    { phrase: 'Doppler tool', tool: 'doppler' },
    { phrase: 'Line zoom', tool: 'line-zoom' },
    { phrase: 'the Photometer', tool: 'photometer' },
    { phrase: 'Photometer', tool: 'photometer' },
    { phrase: 'Time series', tool: 'time-series' },
    { phrase: 'Stars shown', tool: 'stars-shown' },
    { phrase: 'Light curve', tool: 'light-curve' },
    { phrase: 'Press play in its panel', tool: 'light-curve' },
    { phrase: 'Pulse timing', tool: 'pulse-timing' },
    { phrase: 'Subtract star', tool: 'subtract-star' },
    { phrase: 'Open the Spectrum tab', tab: 'spectrum' }
];
const NAMED_PATTERN = new RegExp(`\\b(${NAMED.map((n) => n.phrase).join('|')})\\b`, 'g');

// Turns every name of a tool this object has, in the text under root, into a button. Safe to run again: what's already a
// button is left alone. Clicks are picked up by the listener in ../panel.js.
export function linkToolNames(root, hasTool) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const found = [];
    while (walker.nextNode()) {
        const node = walker.currentNode;
        NAMED_PATTERN.lastIndex = 0;
        if (NAMED_PATTERN.test(node.nodeValue) && !node.parentElement.closest('button, a, abbr, summary, label')) found.push(node);
    }
    found.forEach((node) => {
        const text = node.nodeValue;
        const parts = document.createDocumentFragment();
        let last = 0;
        let changed = false;
        NAMED_PATTERN.lastIndex = 0;
        for (const match of text.matchAll(NAMED_PATTERN)) {
            const named = NAMED.find((n) => n.phrase === match[1]);
            if (named.tool && !hasTool(named.tool)) continue;
            parts.append(text.slice(last, match.index));
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'spectro-tool-link';
            button.textContent = match[1];
            if (named.tool) button.dataset.spectroTool = named.tool;
            else button.dataset.spectroTab = named.tab;
            parts.append(button);
            last = match.index + match[1].length;
            changed = true;
        }
        if (!changed) return;
        parts.append(text.slice(last));
        node.replaceWith(parts);
    });
}

// In the order their buttons come in
import './wien.js';
import './doppler.js';
import './line_zoom.js';
import './photometer.js';
import './time_series.js';
import './stars_shown.js';
import './light_curve.js';
import './pulse_timing.js';
import './subtract_star.js';
