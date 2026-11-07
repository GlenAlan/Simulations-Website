// The Info tab: everything there is to read about an object, as a short page with headed sections. The Overview stays
// simple because all of this lives here. It comes last in the tab order, and the true values close the page, shut and
// under a note, so that they don't sit in a student's way.
//
// Any object's code in these words is a link to that object. The click is answered here for the whole drawer, so the
// Overview and the Help page's codes work the same way.

import { app, select } from '../core/state.js';
import { codeHtml, escapeHtml, glossaryHtml } from '../content/glossary.js';
import { safeInfo } from './drawer.js';
import { toWidestSplit } from './spectrum/tools/orbit_clock.js';

// Six capitals and digits on their own. Only those that really name an object in this sky become links.
const CODE_TOKEN = /(?<![\p{L}\p{N}])[A-Z0-9]{6}(?![\p{L}\p{N}])/gu;

function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

// Plain text to HTML with its codes as links. Pass a `seen` set to give technical terms their tips as well, each one
// once per object. Leave it out for values in a table, where a tip on every other word would only be more to Tab past.
export function richHtml(text, seen = null) {
    const source = String(text ?? '');
    const plain = (part) => (seen ? glossaryHtml(part, { seen }) : escapeHtml(part));
    let html = '';
    let last = 0;
    for (const match of source.matchAll(CODE_TOKEN)) {
        if (!app.universe || !app.universe.resolve(match[0])) continue;
        html += plain(source.slice(last, match.index)) + codeHtml(match[0]);
        last = match.index + match[0].length;
    }
    return html + plain(source.slice(last));
}

// The button that does the obvious next thing. next = { label, tab, tool?, split? } from content/info.js. split: a multiple
// star's clock goes to when its lines are furthest apart, and plays, as the tool opens.
export function nextButton(next) {
    const button = element('button', 'spectro-next');
    button.type = 'button';
    const arrow = element('span', 'icon solid fa-arrow-right');
    arrow.setAttribute('aria-hidden', 'true');
    button.append(element('span', '', next.label), arrow);
    button.addEventListener('click', () => {
        const body = app.selected && app.selected.body;
        if (next.split && body && body.stars && body.orbits && body.orbits.length) {
            toWidestSplit(body, !(app.settings && app.settings.reduceMotion));
        }
        // This button is about to be hidden, which would drop keyboard focus on the page itself, so focus moves on with it
        if (next.tool && app.spectrumPanel && app.spectrumPanel.openTool(next.tool, { focus: true })) return;
        app.drawer.selectTab(next.tab);
        const tab = document.getElementById(`spectroTab-${next.tab}`);
        if (tab) tab.focus({ preventScroll: true });
    });
    return button;
}

function factList(rows) {
    const list = element('dl', 'spectro-facts');
    const seen = new Set();
    rows.forEach(({ label, value }) => {
        const row = element('div', 'spectro-fact');
        const dt = element('dt');
        dt.innerHTML = richHtml(label, seen);
        const dd = element('dd');
        dd.innerHTML = richHtml(value);
        row.append(dt, dd);
        list.appendChild(row);
    });
    return list;
}

function mountInfo(container) {
    const page = element('div', 'spectro-info');
    container.appendChild(page);
    let resolved = null;
    let visible = false;
    let stale = false;

    function section(heading, text, seen) {
        const block = element('section', 'spectro-info-section');
        if (heading) block.appendChild(element('h4', '', heading));
        if (text) {
            const words = element('p');
            words.innerHTML = richHtml(text, seen);
            block.appendChild(words);
        }
        return block;
    }

    function render() {
        stale = false;
        const info = safeInfo(resolved);
        const seen = new Set();
        const parts = [];
        if (info.summary) {
            const lead = element('p', 'spectro-info-lead');
            lead.innerHTML = richHtml(info.summary, seen);
            parts.push(lead);
        }
        // A step that goes straight to a tool is worth having here too. Going to a tab is one press in the bar above.
        if (info.next && info.next.tool) parts.push(nextButton(info.next));
        (info.notes || []).forEach((note) => parts.push(section(note.heading, note.text, seen)));
        if (info.rarity) parts.push(section('How rare?', info.rarity, seen));

        // Built afresh for each object, so it always starts closed
        if (info.catalogue && info.catalogue.length) {
            const block = element('section', 'spectro-info-catalogue');
            block.appendChild(element('p', 'spectro-catalogue-hint', 'The true values. Work them out from the light first, then check yourself here.'));
            const details = element('details', 'sim-controls-more spectro-catalogue');
            details.appendChild(element('summary', '', 'Catalogue values'));
            details.appendChild(factList(info.catalogue));
            block.appendChild(details);
            parts.push(block);
        }
        page.replaceChildren(...parts);
    }

    return {
        setEntity(next) {
            resolved = next;
            stale = true;
            if (visible) render();
        },
        onShow() {
            visible = true;
            if (stale) render();
        },
        onHide() {
            visible = false;
        }
    };
}

export function initInfoTab() {
    app.drawer.registerTab({
        id: 'info',
        label: 'Info',
        order: 90,
        appliesTo: () => true,
        mount: mountInfo
    });

    document.getElementById('spectroDrawerBody').addEventListener('click', (e) => {
        const link = e.target.closest ? e.target.closest('[data-code]') : null;
        if (!link) return;
        // Help names objects anywhere in the sky, so those fly there. Elsewhere the code is of something close by.
        if ('fly' in link.dataset && app.goto) app.goto.goto(link.dataset.code);
        else select(link.dataset.code);
    });
}
