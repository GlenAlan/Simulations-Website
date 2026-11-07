// Two aids for a long search, both off by default in the Layers menu: a tick on each system the student has been into,
// and a pair of small arcs either side of each star with planets. They're thin line marks in the same family as the
// selection ring, so nobody takes one for an object, and they sit at a fixed size in pixels. Marks only go on what can be
// seen at this zoom and band, so they give nothing away that looking wouldn't, and clicks go through them to the sky.
//
// A canvas of its own, drawn only when the view or the list changes, and empty and hidden while both are off.

import { azAltToVec3, limitingMag } from '../../core/sky.js';
import { parallaxFactor } from '../../core/depth.js';
import { memberDirection } from './sky_tangent.js';

const RAD = Math.PI / 180;
const ARC_HALF = 0.72;             // Radians: how far each arc runs either side of level
const MAX_RADIUS_PX = 40;          // A wide pair's marks stop growing once its stars have come apart
const SEEN_MARGIN_MAG = 1;         // Within this of the zoom's limit a thing is drawn but can't be made out: an empty mark

const HOST_STYLE = 'rgba(170, 230, 240, 0.85)';
const VISITED_STYLE = 'rgba(255, 226, 150, 0.95)';
const UNDER_STYLE = 'rgba(0, 0, 0, 0.55)';      // A dark edge keeps a mark readable over the band or a bright nebula

// Wider views have more in them, and smaller marks keep that from getting busy
function baseRadius(fov) {
    return fov > 40 ? 6.5 : fov > 12 ? 8 : 10;
}

export function createSearchMarksLayer(engine, app) {
    const canvas = document.createElement('canvas');
    canvas.className = 'spectro-overlay-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.hidden = true;
    const host = document.getElementById('spectroOverlay');
    if (host) host.prepend(canvas);
    const ctx = canvas.getContext('2d');

    // Once only: which bodies have planets, and where each is, so that most can be skipped without projecting them
    const bodies = app.universe.bodies.map((body) => ({ body, dir: azAltToVec3(body.sky.az, body.sky.alt), hasPlanets: !!(body.planets && body.planets.length) }));
    const hosts = bodies.filter((item) => item.hasPlanets);
    const byCode = new Map(bodies.map((item) => [item.body.code, item]));

    let lastKey = '';
    let counts = { hosts: 0, visited: 0 };
    canvas.addEventListener('contextrestored', () => { lastKey = ''; }); // Given back empty after a graphics restart

    function cosLimitFor(frame) {
        // Wide enough for the furthest things, which are drawn nearer the middle than the camera has them
        const half = Math.atan(Math.tan(frame.fov * RAD / 2) / parallaxFactor(1, frame.fov) * Math.hypot(1, frame.width / frame.height)) / RAD + 1;
        return Math.cos(Math.min(89, half) * RAD);
    }

    function radiusOf(body, frame, base) {
        if (!body.visual_sep_deg) return base;
        const across = body.visual_sep_deg * RAD * (frame.pxPerRad / frame.dpr) * parallaxFactor(body.depth, frame.fov);
        return Math.min(MAX_RADIUS_PX, base + across / 2);
    }

    function traceArcs(x, y, r) {
        ctx.moveTo(x + r * Math.cos(-ARC_HALF), y + r * Math.sin(-ARC_HALF));
        ctx.arc(x, y, r, -ARC_HALF, ARC_HALF);
        ctx.moveTo(x - r * Math.cos(ARC_HALF), y + r * Math.sin(ARC_HALF));
        ctx.arc(x, y, r, Math.PI - ARC_HALF, Math.PI + ARC_HALF);
    }

    // Up and to the right of the thing it marks, clear of the arcs
    function traceTick(x, y, r) {
        const tx = x + r * 0.62 + 2;
        const ty = y - r * 0.82 - 3;
        ctx.moveTo(tx - 3.5, ty);
        ctx.lineTo(tx - 1, ty + 2.75);
        ctx.lineTo(tx + 3.5, ty - 3);
    }

    function strokeMarks(trace, style) {
        ctx.beginPath();
        trace();
        ctx.lineWidth = 3;
        ctx.strokeStyle = UNDER_STYLE;
        ctx.stroke();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = style;
        ctx.stroke();
    }

    function drawHosts(frame, forward, cosLimit, base, seen) {
        let n = 0;
        strokeMarks(() => {
            for (let i = 0; i < hosts.length; i++) {
                const { body, dir } = hosts[i];
                if (dir[0] * forward[0] + dir[1] * forward[1] + dir[2] * forward[2] < cosLimit) continue;
                if (!engine.bodyShows(body, seen)) continue;
                const p = engine.projectBody(body);
                if (!p || !p.onScreen) continue;
                traceArcs(p.x, p.y, radiusOf(body, frame, base));
                n += 1;
            }
        }, HOST_STYLE);
        return n;
    }

    function drawVisited(frame, forward, cosLimit, base, seen) {
        const codes = app.visited.codes();
        let n = 0;
        // A cluster's own stars can be entered too, and only show once the view has come in close enough to tell them apart
        let inClusters = null;
        strokeMarks(() => {
            for (let i = 0; i < codes.length; i++) {
                const item = byCode.get(codes[i]);
                if (item) {
                    if (item.dir[0] * forward[0] + item.dir[1] * forward[1] + item.dir[2] * forward[2] < cosLimit) continue;
                    if (!engine.bodyShows(item.body, seen)) continue;
                    const p = engine.projectBody(item.body);
                    if (!p || !p.onScreen) continue;
                    traceTick(p.x, p.y, radiusOf(item.body, frame, base));
                    n += 1;
                    continue;
                }
                if (!inClusters) {
                    const layer = engine.getLayer('clusters');
                    inClusters = new Set(layer && layer.picks ? (layer.picks(frame) || []).map((c) => c.code) : []);
                }
                if (!inClusters.has(codes[i])) continue;
                const found = app.universe.resolve(codes[i]);
                if (!found || found.path !== 'member') continue;
                const at = memberDirection(found.body, found.entity);
                const p = at && engine.project(at.az, at.alt, found.body.depth);
                if (!p || !p.onScreen) continue;
                traceTick(p.x, p.y, base);
                n += 1;
            }
        }, VISITED_STYLE);
        return n;
    }

    return {
        id: 'searchMarks',
        update(frame) {
            const wanted = frame.view === 'sky' && (app.layers.visited || app.layers.planetHosts);
            if (!wanted) {
                if (!canvas.hidden) {
                    canvas.hidden = true;
                    lastKey = '';
                    counts = { hosts: 0, visited: 0 };
                }
                return;
            }
            const view = engine.getView();
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
            const key = [
                view.az.toFixed(4), view.alt.toFixed(4), view.fov.toFixed(4), frame.width, frame.height, pixelRatio, frame.band,
                app.layers.visited, app.layers.planetHosts, app.visited.count()
            ].join();
            if (key === lastKey) return;
            lastKey = key;

            canvas.hidden = false;
            const w = Math.round(frame.width * pixelRatio);
            const h = Math.round(frame.height * pixelRatio);
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
            ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            ctx.clearRect(0, 0, frame.width, frame.height);
            ctx.setLineDash([]);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            const forward = azAltToVec3(view.az, view.alt);
            const cosLimit = cosLimitFor(frame);
            const base = baseRadius(view.fov);
            const seen = limitingMag(view.fov) - SEEN_MARGIN_MAG;
            counts = {
                hosts: app.layers.planetHosts ? drawHosts(frame, forward, cosLimit, base, seen) : 0,
                visited: app.layers.visited ? drawVisited(frame, forward, cosLimit, base, seen) : 0
            };
        },
        counts: () => counts    // For tests
    };
}
