// The single drawer: docked to the right of the sky on wide screens, a bottom sheet on narrow ones. It re-uses
// the site's settings panel (#simulationControlsPanel, opened and closed by simulation_ui.js), so there is only
// ever one panel, and opening a new view replaces the old. Foundation version; the shell track polishes it.
//
// Tabs (Overview, Spectrum, H-R, System...) register themselves:
//   app.drawer.registerTab({ id, label, order, appliesTo(resolved), mount(container) })
// mount is called once, the first time the tab is needed, and returns { setEntity(resolved), onShow?(), onHide?() }.
// setEntity is called whenever the selection changes while the tab applies, even if the tab is hidden (cheap
// work only: do the heavy work in onShow, which is called when the tab is shown or its object has changed).

import { app, bus } from '../core/state.js';

export function createDrawer() {
    const panel = document.getElementById('simulationControlsPanel');
    const toggle = document.querySelector('.sim-panel-toggle-button');
    const title = document.getElementById('simulationControlsPanelLabel');
    const tabBar = document.getElementById('spectroDrawerTabs');
    const body = document.getElementById('spectroDrawerBody');

    const tabs = [];
    let view = null;          // 'object', or the id of a page such as 'settings' or 'help'
    let current = null;       // The current tab's id
    let resolved = null;
    let pageEl = null;

    function isOpen() {
        return panel.classList.contains('panel-open');
    }

    function openPanel() {
        if (!isOpen()) {
            // simulation_ui.js owns opening; it moves focus to the close button, so hand focus back when
            // the panel opened from the sky rather than from a key press
            const active = document.activeElement;
            toggle.click();
            if (active && active !== document.body && !panel.contains(active)) active.focus({ preventScroll: true });
        }
    }

    function applicable() {
        return resolved ? tabs.filter((t) => t.appliesTo(resolved)).sort((a, b) => a.order - b.order) : [];
    }

    function hideAll() {
        tabs.forEach((t) => { if (t.el) t.el.hidden = true; });
        if (pageEl) pageEl.hidden = true;
    }

    function renderTabBar() {
        tabBar.replaceChildren();
        tabBar.hidden = view !== 'object';
        if (view !== 'object') return;
        applicable().forEach((t) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'spectro-tab';
            b.id = `spectroTab-${t.id}`;
            b.textContent = t.label;
            b.setAttribute('role', 'tab');
            b.setAttribute('aria-selected', t.id === current ? 'true' : 'false');
            b.setAttribute('aria-controls', `spectroPanel-${t.id}`);
            b.tabIndex = t.id === current ? 0 : -1;
            b.addEventListener('click', () => selectTab(t.id));
            tabBar.appendChild(b);
        });
    }

    function ensureMounted(tab) {
        if (tab.instance) return;
        tab.el = document.createElement('div');
        tab.el.id = `spectroPanel-${tab.id}`;
        tab.el.className = 'spectro-tab-panel';
        tab.el.setAttribute('role', 'tabpanel');
        tab.el.setAttribute('aria-labelledby', `spectroTab-${tab.id}`);
        tab.el.hidden = true;
        body.appendChild(tab.el);
        tab.instance = tab.mount(tab.el);
    }

    function selectTab(id) {
        const list = applicable();
        const tab = list.find((t) => t.id === id) || list[0];
        if (!tab) return;
        const previous = tabs.find((t) => t.id === current);
        if (previous && previous.instance && previous.instance.onHide && previous !== tab) previous.instance.onHide();
        current = tab.id;
        hideAll();
        ensureMounted(tab);
        tab.el.hidden = false;
        if (tab.lastEntity !== resolved) {
            tab.instance.setEntity(resolved);
            tab.lastEntity = resolved;
        }
        renderTabBar();
        if (tab.instance.onShow) tab.instance.onShow();
        bus.emit('drawer', { open: true, view: 'object', tab: tab.id });
    }

    function openObject(next, tabId) {
        resolved = next;
        view = 'object';
        title.textContent = next.entity.name || next.entity.code;
        openPanel();
        selectTab(tabId || current || 'overview');
    }

    // Replace the drawer's contents with a page; render(container) fills it each time it is opened
    function showPage(id, heading, render) {
        const previous = tabs.find((t) => t.id === current);
        if (previous && previous.instance && previous.instance.onHide) previous.instance.onHide();
        view = id;
        title.textContent = heading;
        hideAll();
        if (!pageEl) {
            pageEl = document.createElement('div');
            pageEl.className = 'spectro-page';
            body.appendChild(pageEl);
        }
        pageEl.hidden = false;
        pageEl.replaceChildren();
        render(pageEl);
        renderTabBar();
        openPanel();
        bus.emit('drawer', { open: true, view: id });
    }

    function close() {
        if (isOpen()) toggle.click();
    }

    // The cog opens Settings even when the drawer holds something else; the page is supplied by the shell
    // track through setSettingsPage. Runs before simulation_ui.js's own click handler.
    let settingsPage = null;
    toggle.addEventListener('click', (e) => {
        if (!settingsPage) return;
        if (isOpen() && view === 'settings') return; // Second press closes, as elsewhere on the site
        if (isOpen()) e.stopImmediatePropagation();
        settingsPage();
    }, { capture: true });

    // simulation_ui.js also closes the panel (Esc, its close button), so watch the panel itself
    new MutationObserver(() => {
        if (!isOpen()) {
            const previous = tabs.find((t) => t.id === current);
            if (previous && previous.instance && previous.instance.onHide) previous.instance.onHide();
            view = null;
            bus.emit('drawer', { open: false, view: null });
        }
    }).observe(panel, { attributes: true, attributeFilter: ['class'] });

    bus.on('select', ({ resolved: next }) => openObject(next));

    const api = {
        registerTab(tab) {
            tabs.push(tab);
            return tab;
        },
        openObject,
        showPage,
        selectTab,
        close,
        isOpen,
        currentTab: () => current,
        currentView: () => view,
        setSettingsPage(fn) { settingsPage = fn; }
    };
    app.drawer = api;
    return api;
}
