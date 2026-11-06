// FOUNDATION STUB, replaced by the system-view track: sets app.system and registers the System tab.

export function initSystemView(app) {
    app.system = {
        enter(code, opts = {}) { if (opts.onDone) opts.onDone(); },
        exit(opts = {}) { if (opts.onDone) opts.onDone(); },
        focusPlanet(code) {}
    };
}
