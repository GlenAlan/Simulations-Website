// The registry behind the Spectrum tab's "Tools" expander. A tool registers itself when its module loads:
//
//   registerTool({ id, label, appliesTo(resolved), mount(container, panelApi) -> { setEntity(resolved), dispose() } })
//
// mount runs when the student opens the tool, followed by setEntity; dispose runs when they close it, or when the
// next object isn't one the tool applies to. A tool removes its own overlays and resets what it asked of the panel
// (setBodyOpts, setResolution) in dispose. panelApi is described at the top of ../panel.js. setEntity runs once the
// new spectrum is ready; panelApi.getSpectrum() is null only for an object with no spectrum, where the tools are hidden.
//
// To add a tool, write tools/<name>.js, which imports registerTool from here, and import it at the bottom of this file.

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
