// FOUNDATION STUB, replaced by the shell track: the Overview tab that every object opens on.

export function initOverviewTab(app) {
    app.drawer.registerTab({
        id: 'overview',
        label: 'Overview',
        order: 10,
        appliesTo: () => true,
        mount(container) {
            return {
                setEntity(resolved) {
                    container.textContent = `${resolved.entity.code}: ${resolved.entity.kind}`;
                }
            };
        }
    });
}
