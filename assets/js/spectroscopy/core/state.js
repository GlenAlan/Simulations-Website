// App-wide state and event bus. No DOM or WebGL here: this module also loads under Node for tests.
// Modules talk to each other through `app` and `bus`, not by importing one another's internals.

const listeners = new Map();

export const bus = {
    on(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
        return () => listeners.get(type).delete(fn);
    },
    off(type, fn) {
        if (listeners.has(type)) listeners.get(type).delete(fn);
    },
    emit(type, detail) {
        const set = listeners.get(type);
        if (!set) return;
        // Copied, so a listener can unsubscribe while the event is being sent
        [...set].forEach((fn) => fn(detail));
    }
};

// Events (detail in brackets):
//   'select'    { code, entity, resolved }  an object has been selected
//   'deselect'  {}                          nothing is selected any more
//   'band'      { band, previous }          the sky band has changed
//   'layer'     { name, on }                a Layers menu switch has changed
//   'settings'  { key, value }              a setting has changed
//   'view'      { view, code }              'sky' or 'system' (code = the system's body)
//   'drawer'    { open, view }              the drawer has opened, closed or changed its contents
//   'goto'      { code }                    the Go to box or a link asked to fly to an object
//   'quality'   { level }                   the graphics level has been applied ('low'|'medium'|'high')

function prefersReducedMotion() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const app = {
    universe: null,   // set by main.js: see data/universe.js
    engine: null,     // set by main.js: see render/engine.js
    drawer: null,     // set by main.js: see ui/drawer.js
    system: null,     // set by render/system/system_view.js: enter(code, opts), exit(opts), focusPlanet(code)
    goto: null,       // set by ui/goto.js: goto(code, opts)
    band: 'visible',  // one of BANDS in core/bands.js
    view: 'sky',      // 'sky' or 'system'
    systemCode: null, // the body whose system is open
    selected: null,   // resolved selection: { entity, body, path } or null
    layers: {
        homePlanets: true, // On by default (spec section 4); every other layer starts off
        galacticBand: false,
        grid: false,
        labels: false,
        shiftTint: false,
        habitableZone: false,
        cmb: false
    },
    settings: {
        quality: 'auto', // 'auto'|'low'|'medium'|'high'
        reduceMotion: prefersReducedMotion()
    },
    qualityLevel: 'medium' // What is actually being rendered
};

export function select(code) {
    if (!code) {
        if (app.selected) {
            app.selected = null;
            bus.emit('deselect', {});
        }
        return null;
    }
    const resolved = app.universe.resolve(code);
    if (!resolved) return null;
    app.selected = resolved;
    bus.emit('select', { code: resolved.entity.code, entity: resolved.entity, resolved });
    return resolved;
}

export function setBand(band) {
    if (band === app.band) return;
    const previous = app.band;
    app.band = band;
    bus.emit('band', { band, previous });
}

export function setLayer(name, on) {
    if (app.layers[name] === on) return;
    app.layers[name] = on;
    bus.emit('layer', { name, on });
}

export function setSetting(key, value) {
    if (app.settings[key] === value) return;
    app.settings[key] = value;
    bus.emit('settings', { key, value });
}
