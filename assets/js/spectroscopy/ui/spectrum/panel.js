// FOUNDATION STUB, replaced by the spectrum-panel track: the Spectrum tab.

export function initSpectrumTab(app) {
    app.drawer.registerTab({
        id: 'spectrum',
        label: 'Spectrum',
        order: 20,
        appliesTo: () => true,
        mount(container) {
            return {
                setEntity(resolved) {
                    container.textContent = `Spectrum of ${resolved.entity.code}`;
                }
            };
        }
    });
}
