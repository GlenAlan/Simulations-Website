// The single drawer: docked to the right of the sky on wide screens, a bottom sheet on narrow ones. It re-uses
// the site's settings panel (#simulationControlsPanel, opened and closed by simulation_ui.js), so there is only
// ever one panel, and opening a new view replaces the old.
//
// Tabs (Overview, Spectrum, H-R, System...) register themselves:
//   app.drawer.registerTab({ id, label, order, appliesTo(resolved), mount(container) })
// mount is called once, the first time the tab is needed, and returns { setEntity(resolved), onShow?(), onHide?() }.
// setEntity is called whenever the selection changes while the tab applies, even if the tab is hidden (cheap
// work only: do the heavy work in onShow, which is called when the tab is shown or its object has changed).

import { app, bus } from '../core/state.js';
import { infoFor } from '../content/info.js';

// Tell screen readers something through the page's one live region. Cleared first, so a repeat is read out again.
let announceTimer = 0;
export function announce(text) {
    const live = document.getElementById('spectroLive');
    if (!live) return;
    clearTimeout(announceTimer);
    live.textContent = '';
    announceTimer = setTimeout(() => { live.textContent = text; }, 40);
}

// The notes for an object. A fault in one object's notes must not stop its panel opening.
export function safeInfo(resolved) {
    try {
        return infoFor(resolved) || {};
    } catch (err) {
        console.error('[spectroscopy] notes failed for', resolved.entity.code, err);
        return {};
    }
}

export function kindLabelOf(resolved) {
    const text = String(safeInfo(resolved).kindLabel || resolved.entity.kind || 'Object').replace(/_/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// The link a teacher sends to bring a student straight to this object (spec 14.3)
export function objectLink(code) {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('goto', code);
    if (app.band !== 'visible') url.searchParams.set('band', app.band);
    return url.href;
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) { /* Not allowed on this page: fall through to the older way */ }
    const active = document.activeElement;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'spectro-copy-buffer';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch (err) { /* Reported to the student below */ }
    area.remove();
    if (active && active.focus) active.focus({ preventScroll: true });
    return ok;
}

function makeIconButton(icon, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sim-icon-button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = `<span class="icon solid ${icon}" aria-hidden="true"></span>`;
    return b;
}

export function createDrawer() {
    const panel = document.getElementById('simulationControlsPanel');
    const toggle = document.querySelector('.sim-panel-toggle-button');
    const title = document.getElementById('simulationControlsPanelLabel');
    const tabBar = document.getElementById('spectroDrawerTabs');
    const body = document.getElementById('spectroDrawerBody');
    const header = panel.querySelector('.sim-controls-header');
    const closeBtn = panel.querySelector('.sim-panel-close-button-insIDE');

    const tabs = [];
    let view = null;          // 'object', or the id of a page such as 'settings' or 'help'
    let current = null;       // The current tab's id
    let shown = null;         // The tab whose panel is on screen
    let resolved = null;
    let pageEl = null;
    let tabBarKey = '';
    let opener = null;        // Where focus goes back to when the drawer closes

    // simulation_ui.js names its close button for a settings panel; this one holds more than settings
    if (closeBtn) {
        closeBtn.setAttribute('aria-label', 'Close panel');
        closeBtn.title = 'Close panel (Esc)';
        const hiddenLabel = closeBtn.querySelector('.label');
        if (hiddenLabel) hiddenLabel.textContent = 'Close panel';
    }

    // The title: the object's code (or a home planet's name) and its kind, with the two copy buttons beside it
    const titleMain = document.createElement('span');
    titleMain.className = 'spectro-title-main';
    const titleSub = document.createElement('span');
    titleSub.className = 'spectro-title-sub';
    title.replaceChildren(titleMain, titleSub);
    const actions = document.createElement('div');
    actions.className = 'spectro-title-actions';
    actions.hidden = true;
    const copyCodeBtn = makeIconButton('fa-copy', 'Copy code');
    const copyLinkBtn = makeIconButton('fa-link', 'Copy link');
    actions.append(copyCodeBtn, copyLinkBtn);
    header.insertBefore(actions, closeBtn || null);

    let subText = '';
    let flashTimer = 0;
    function flashCopied(button, message) {
        const iconEl = button.querySelector('.icon');
        iconEl.classList.remove('fa-copy', 'fa-link', 'fa-check', 'fa-times');
        iconEl.classList.add(message.ok ? 'fa-check' : 'fa-times');
        titleSub.textContent = message.text;
        announce(message.text);
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
            [[copyCodeBtn, 'fa-copy'], [copyLinkBtn, 'fa-link']].forEach(([b, name]) => {
                const el = b.querySelector('.icon');
                el.classList.remove('fa-check', 'fa-times');
                el.classList.add(name);
            });
            titleSub.textContent = subText;
        }, 1600);
    }

    copyCodeBtn.addEventListener('click', async () => {
        if (!resolved) return;
        const code = resolved.entity.code;
        const ok = await copyText(code);
        flashCopied(copyCodeBtn, { ok, text: ok ? `Copied ${code}` : `Could not copy. The code is ${code}` });
    });
    copyLinkBtn.addEventListener('click', async () => {
        if (!resolved) return;
        const ok = await copyText(objectLink(resolved.entity.code));
        flashCopied(copyLinkBtn, { ok, text: ok ? 'Link copied' : 'Could not copy the link' });
    });

    function isOpen() {
        return panel.classList.contains('panel-open');
    }

    function noteOpener() {
        const active = document.activeElement;
        if (active && active !== document.body && !panel.contains(active)) opener = active;
    }

    // simulation_ui.js owns opening and closing, through its click handler on the cog. This click comes from
    // here, so the cog's own handler below must let it through.
    let ownClick = false;
    function clickToggle() {
        ownClick = true;
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        ownClick = false;
    }

    function openPanel(keepFocus) {
        if (isOpen()) return;
        clickToggle();
        // simulation_ui.js moves focus to the close button: right for a page opened with a button, but
        // picking an object from the sky must not pull focus off the sky
        if (!keepFocus) return;
        if (opener) opener.focus({ preventScroll: true });
        else if (closeBtn) closeBtn.blur();
    }

    function applicable() {
        return resolved ? tabs.filter((t) => t.appliesTo(resolved)).sort((a, b) => a.order - b.order) : [];
    }

    function hideShown() {
        if (shown && shown.instance && shown.instance.onHide) shown.instance.onHide();
        shown = null;
    }

    function hideAll() {
        tabs.forEach((t) => { if (t.el) t.el.hidden = true; });
        if (pageEl) pageEl.hidden = true;
    }

    // Rebuilt only when the set of tabs changes, so a tab keeps keyboard focus when it is chosen
    function renderTabBar() {
        tabBar.hidden = view !== 'object';
        if (view !== 'object') return;
        const list = applicable();
        const key = list.map((t) => t.id).join('|');
        if (key !== tabBarKey) {
            tabBarKey = key;
            tabBar.replaceChildren(...list.map((t) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'spectro-tab';
                b.id = `spectroTab-${t.id}`;
                b.textContent = t.label;
                b.setAttribute('role', 'tab');
                if (t.el) b.setAttribute('aria-controls', t.el.id); // Only once it exists: panels mount when first needed
                b.addEventListener('click', () => selectTab(t.id));
                return b;
            }));
            // A hidden panel must not name a tab this object doesn't have
            tabs.forEach((t) => {
                if (!t.el) return;
                if (list.includes(t)) t.el.setAttribute('aria-labelledby', `spectroTab-${t.id}`);
                else t.el.removeAttribute('aria-labelledby');
            });
        }
        [...tabBar.children].forEach((b) => {
            const on = b.id === `spectroTab-${current}`;
            b.setAttribute('aria-selected', on ? 'true' : 'false');
            b.tabIndex = on ? 0 : -1;
        });
    }

    // Left and right move between tabs (and choose them), Home and End go to the ends
    tabBar.addEventListener('keydown', (e) => {
        const list = applicable();
        const i = list.findIndex((t) => t.id === current);
        if (i < 0) return;
        let next = -1;
        if (e.key === 'ArrowRight') next = (i + 1) % list.length;
        else if (e.key === 'ArrowLeft') next = (i - 1 + list.length) % list.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = list.length - 1;
        if (next < 0) return;
        e.preventDefault();
        selectTab(list[next].id);
        const b = document.getElementById(`spectroTab-${list[next].id}`);
        if (b) b.focus();
    });

    function ensureMounted(tab) {
        if (tab.instance) return;
        tab.el = document.createElement('div');
        tab.el.id = `spectroPanel-${tab.id}`;
        tab.el.className = 'spectro-tab-panel';
        tab.el.setAttribute('role', 'tabpanel');
        tab.el.setAttribute('aria-labelledby', `spectroTab-${tab.id}`);
        tab.el.hidden = true;
        body.appendChild(tab.el);
        const button = document.getElementById(`spectroTab-${tab.id}`);
        if (button) button.setAttribute('aria-controls', tab.el.id);
        tab.instance = tab.mount(tab.el);
    }

    function selectTab(id) {
        const list = applicable();
        const tab = list.find((t) => t.id === id) || list[0];
        if (!tab) return;
        if (shown !== tab) hideShown();
        const changed = current !== tab.id;
        current = tab.id;
        // A link in one tab that leads to another hides itself, and the focus would fall to the page: it goes to the new tab
        const active = document.activeElement;
        const focusLeaves = !!active && active !== document.body && body.contains(active) && !(tab.el && tab.el.contains(active));
        hideAll();
        ensureMounted(tab);
        tab.el.hidden = false;
        shown = tab;
        if (tab.lastEntity !== resolved) {
            tab.instance.setEntity(resolved);
            tab.lastEntity = resolved;
        }
        renderTabBar();
        if (changed) body.scrollTop = 0;
        if (tab.instance.onShow) tab.instance.onShow();
        if (focusLeaves && changed && !tab.el.contains(document.activeElement)) {
            const button = document.getElementById(`spectroTab-${tab.id}`);
            if (button) button.focus({ preventScroll: true });
        }
        bus.emit('drawer', { open: true, view: 'object', tab: tab.id });
    }

    function showObjectTitle(next) {
        const entity = next.entity;
        title.classList.add('is-object');
        titleMain.textContent = entity.name || entity.code;
        subText = entity.name ? `${kindLabelOf(next)} · ${entity.code}` : kindLabelOf(next);
        titleSub.textContent = subText;
        titleSub.hidden = false;
        actions.hidden = false;
        copyCodeBtn.setAttribute('aria-label', `Copy code ${entity.code}`);
        copyCodeBtn.title = `Copy code ${entity.code}`;
    }

    function openObject(next, tabId) {
        // Comparing objects: stay on the tab in use while the drawer is open; otherwise open on the Overview
        const keepTab = isOpen() && view === 'object';
        noteOpener();
        resolved = next;
        view = 'object';
        showObjectTitle(next);
        // Hidden tabs that are already mounted hear about the new object too
        tabs.forEach((t) => {
            if (t.instance && t.appliesTo(next) && t.lastEntity !== next) {
                t.instance.setEntity(next);
                t.lastEntity = next;
            }
        });
        openPanel(true);
        body.scrollTop = 0;
        selectTab(tabId || (keepTab ? current : null) || 'overview');
    }

    // Replace the drawer's contents with a page; render(container) fills it each time it is opened
    function showPage(id, heading, render) {
        hideShown();
        noteOpener();
        const wasOpen = isOpen();
        view = id;
        title.classList.remove('is-object');
        titleMain.textContent = heading;
        titleSub.textContent = '';
        titleSub.hidden = true;
        actions.hidden = true;
        hideAll();
        if (!pageEl) {
            pageEl = document.createElement('div');
            pageEl.className = 'spectro-page';
            body.appendChild(pageEl);
        }
        pageEl.hidden = false;
        pageEl.replaceChildren();
        render(pageEl);
        body.scrollTop = 0;
        renderTabBar();
        openPanel(false);
        if (wasOpen && closeBtn) closeBtn.focus({ preventScroll: true });
        bus.emit('drawer', { open: true, view: id });
    }

    function close() {
        if (isOpen()) clickToggle();
    }

    // Put keyboard focus inside the drawer: used when an object is picked with the keyboard
    function focusContent() {
        const target = (view === 'object' && tabBar.querySelector('[aria-selected="true"]')) || closeBtn;
        if (target) target.focus({ preventScroll: true });
    }

    // The cog opens Settings even when the drawer holds something else; the page is supplied by the shell
    // through setSettingsPage. Runs before simulation_ui.js's own click handler.
    let settingsPage = null;
    toggle.addEventListener('click', (e) => {
        if (ownClick || !settingsPage) return;
        if (isOpen() && view === 'settings') return; // Second press closes, as elsewhere on the site
        e.stopImmediatePropagation();
        settingsPage();
    }, { capture: true });

    // simulation_ui.js also closes the panel (Esc, its close button), so watch the panel itself
    let wasOpenBefore = false;
    new MutationObserver(() => {
        const open = isOpen();
        if (open === wasOpenBefore) return;
        wasOpenBefore = open;
        if (open) return;
        hideShown();
        view = null;
        // simulation_ui.js hands focus to the cog when it was inside the panel. Send it back where it came from.
        const active = document.activeElement;
        const stranded = !active || active === document.body || active === toggle || panel.contains(active);
        if (stranded && opener && opener !== toggle && opener.isConnected) opener.focus({ preventScroll: true });
        opener = null;
        bus.emit('drawer', { open: false, view: null });
    }).observe(panel, { attributes: true, attributeFilter: ['class'] });

    // The cog's "on" look means Settings is showing, not just that the drawer is open
    bus.on('drawer', () => toggle.setAttribute('aria-expanded', view === 'settings' ? 'true' : 'false'));

    bus.on('select', ({ resolved: next }) => openObject(next));
    bus.on('deselect', () => {
        if (view === 'object') close();
        resolved = null;
    });

    const api = {
        registerTab(tab) {
            tabs.push(tab);
            if (view === 'object') renderTabBar();
            return tab;
        },
        openObject,
        showPage,
        selectTab,
        close,
        isOpen,
        focusContent,
        currentTab: () => current,
        currentView: () => view,
        setSettingsPage(fn) { settingsPage = fn; }
    };
    app.drawer = api;
    return api;
}
