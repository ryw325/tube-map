/* Project Undercurrent: Full Map page (v3.58 stage 3; v3.59 stage 4: filters, landmarks, airports; v3.65 stage 5: live trains from fullmap-live.js). A pannable, zoomable map of Greater London on pre-rendered tiles (geo/tiles).
   Loaded before engine.js; the engine calls UndercurrentFullMap.mount(LINE, scope, ctx) when the page data has kind "fullmap" (index.html?map=full).
   The map is static for now: the live layer (stage 5) and the filters (stage 4) come later. Everything this file starts goes through `scope`, so unmount undoes it all.
   Projection: British National Grid (EPSG:27700), metres. The view is a centre (x, y in metres) and a scale (CSS pixels per metre).
   Tiles: 512 px WebP, four zoom levels (geo/tiles/meta.json), light and dark, no stations or labels in them; stations and names are drawn here on top.
   v3.73: style categories, Geographical | Artistic, with each category's styles listed underneath in the Layers pop-up.
   v3.71: map styles (Geographic, Fantasy Parchment; more can be added to STYLES) and a separate road tile layer per style, so "Cut roads at lines" can
   erase the roads along every drawn line. Tile sets: geo/tiles/{set}/{base|roads}/{z}/{i}/{j}.webp (set = light, dark or parchment). */
(function () {
  "use strict";
  const TILE_URL = (set, layer, z, i, j) => `geo/tiles/${set}/${layer}/${z}/${i}/${j}.webp`;
  // map styles: the tile set for light and dark pages (Parchment has one look), listed in the Layers pop-up in this order
  // v3.73: two categories. Geographical keeps the master map's detail (and follows light and dark); Artistic styles share simplified green space and water
  // (tools/geo/artistic_geom.py), keep every transport feature exactly, and have one look each.
  const CATS = [{ id: "geographical", name: "Geographical" }, { id: "artistic", name: "Artistic" }];
  const STYLES = [{ id: "geographic", cat: "geographical", name: "Geographic", light: "light", dark: "dark" }, { id: "parchment", cat: "artistic", name: "Fantasy Parchment", light: "parchment", dark: "parchment" }, { id: "poster", cat: "artistic", name: "1930s Poster", light: "poster", dark: "poster" }];
  const LS_STYLE = "uc-fm-style", LS_CUT = "uc-fm-roadcut";
  const CUT_GAP = 3;                     // "Cut roads at lines": roads stop this many screen px short of each side of a drawn line
  const PAPER = "#EAD8AD", INK = "#3B2A1A";
  // each line's official colour (the page draws the lines; Artistic styles adjust them in LOOKS below)
  const LINE_COL = { bakerloo: "#B36305", central: "#E32017", circle: "#FFD300", district: "#00782A", "hammersmith-city": "#F3A9BB", jubilee: "#8D9296", metropolitan: "#9B0056", northern: "#000000", piccadilly: "#003688",
      victoria: "#20A4E0", "waterloo-city": "#95CDBA", elizabeth: "#6950A1", liberty: "#676767", lioness: "#F1B41C", mildmay: "#437EC1", suffragette: "#39B97A", weaver: "#972861", windrush: "#EF4D5E", dlr: "#00AFAD", tram: "#84B817", "london-cable-car": "#E21836", rb1: "#0019A8", rb4: "#0019A8", rb6: "#0019A8" };
  const mixHex = (a, b, t) => { const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)), A = p(a), B = p(b); return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join(""); };
  // v3.74: how each Artistic style draws what the page draws over its tiles (lines, stations, labels, zones, trains). One entry per style; Geographic has none.
  const POSTER = { paper: "#EFE3C4", ink: "#2A2624", red: "#B5442F" };
  const POSTER_LINE = { central: "#D0352B", victoria: "#1F8FC6", jubilee: "#8D9399", district: "#2F7D45", northern: "#2A2624" };   // flat poster tones; the others are deepened a little
  const lum = h => { const n = parseInt(h.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); };
  const posterLine = id => { const b = LINE_COL[id] || "#888888"; return POSTER_LINE[id] || mixHex(b, POSTER.ink, lum(b) > 170 ? 0.3 : 0.12); };
  // best-known parks: named first when the map is zoomed out (with the biggest)
  const FAMOUS = new Set(["hyde park", "kensington gardens", "the regent's park", "regent's park", "the green park", "green park", "st james's park", "greenwich park", "richmond park", "bushy park",
    "hampstead heath", "victoria park", "battersea park", "clapham common", "wimbledon common", "epping forest", "queen elizabeth olympic park", "royal botanic gardens, kew", "kew gardens",
    "primrose hill", "holland park", "crystal palace park", "alexandra park", "finsbury park", "hackney marshes", "wanstead flats", "blackheath", "dulwich park", "brockwell park", "osterley park"]);
  const LOOKS = {
    parchment: {
      cols: { bg: PAPER, ink: INK, muted: "#6B5A44", fill: "#F1E4C1", lmFill: "#F1E4C1", stW: 1.4, sans: '"IM Fell English SC", Georgia, serif', wt: 400, fs: 1.5, sw: "", ls: 0, upper: false },
      lineColour: id => mixHex(LINE_COL[id] || "#888888", PAPER, 0.15), casing: INK, casingW: lw => lw + Math.max(1.8, lw * 0.6),
      fonts: ['14px "IM Fell English SC"', 'italic 14px "IM Fell English"'],
      fare: ["rgba(255,248,225,.4)", "rgba(120,90,50,.13)"], fareLine: "rgba(59,42,26,.45)", fareText: "#5B4630", ulez: "#4E6B2C", cc: "#9B2D20",
      boroughs: ["196,120,90", "100,150,140", "150,170,90", "210,165,85"], boroughA: 0.24, boroughLine: "rgba(59,42,26,.5)", boroughText: "rgba(59,42,26,.72)",
      trainOutline: INK, trainFont: "Outfit, sans-serif", glow: "rgba(255,190,80,.5)",
      area: { family: '"IM Fell English", Georgia, serif', italic: true, wt: "", ls: 0, upper: false, riverS: 0.035, fit: 0,
        park: { fill: "#2F3C18", halo: "rgba(200,215,160,.8)" }, water: { fill: "#24433F", halo: "rgba(190,222,215,.75)" } }
    },
    poster: {
      cols: { bg: POSTER.paper, ink: POSTER.ink, muted: POSTER.ink, fill: "#FFFFFF", lmFill: POSTER.paper, stW: 2, stW2: 1.6, sans: '"Josefin Sans", "Outfit", sans-serif', wt: 700, fs: 0, sw: "700 ", ls: 3.5, upper: true },
      lineColour: posterLine, casing: POSTER.paper, casingW: lw => lw + Math.max(2.6, lw * 0.75),
      fonts: ['700 14px "Josefin Sans"'],
      fare: ["rgba(255,255,255,.35)", "rgba(42,38,36,.08)"], fareLine: "rgba(42,38,36,.45)", fareText: POSTER.ink, ulez: "#2F7D45", cc: POSTER.red,
      boroughs: ["181,68,47", "47,108,120", "93,139,110", "200,160,70"], boroughA: 0.2, boroughLine: "rgba(42,38,36,.5)", boroughText: "rgba(42,38,36,.75)",
      trainOutline: POSTER.paper, trainFont: "Outfit, sans-serif", glow: null,
      frame: true,                                       // v3.76: the sunburst rays are gone (Ryan: distracting); the paper is one flat cream
      area: { family: '"Josefin Sans", sans-serif', italic: false, wt: "700 ", ls: 2.5, upper: true, riverS: 0.07, fit: 1.5,
        park: { fill: POSTER.paper, halo: null }, water: { fill: POSTER.paper, halo: null } }
    }
  };
  const MAX_SCALE = 1.1;                 // CSS px per metre at the closest zoom (the finest tiles are 1.1 px per metre)
  const CACHE_MAX = 640, MAX_INFLIGHT = 8;              // v3.71: two layers per view (base and roads)
  const BOUNDS = { x0: 503000, y0: 155000, x1: 562000, y1: 201000 };   // Greater London (boroughs), from geo/boroughs.json
  const PAD = 4000;                      // the centre may drift this far past the edge
  const LS_CTL = "uc-fm-controls";
  const LINE_NAMES = { bakerloo: "Bakerloo", central: "Central", circle: "Circle", district: "District", "hammersmith-city": "Hammersmith & City", jubilee: "Jubilee", metropolitan: "Metropolitan", northern: "Northern", piccadilly: "Piccadilly", victoria: "Victoria", "waterloo-city": "Waterloo & City", elizabeth: "Elizabeth", liberty: "Liberty", lioness: "Lioness", mildmay: "Mildmay", suffragette: "Suffragette", weaver: "Weaver", windrush: "Windrush", dlr: "DLR", tram: "Tram" };

  function mount(MAP, scope, ctx) {
    const { svg, panelsApi } = ctx;
    const $ = id => document.getElementById(id);
    const root = document.documentElement, wrapEl = $("map-wrap");
    const reduceMotion = ctx.reduceMotion;

    /* ---------- Page set-up (everything is put back on unmount) ---------- */
    const dts = document.querySelectorAll(".stats dt"), dtOld = Array.from(dts, d => d.textContent);
    const popTitle = $("pop-title"), popTitleOld = popTitle.textContent, factsEl = $("facts");
    document.title = "Full Map Live";
    document.querySelector(".eyebrow").textContent = `Live prototype · v${ctx.VERSION}`;
    $("line-name").textContent = "Full Map";
    const sw = document.querySelector(".line-title .swatch"); sw.style.background = "var(--ink)";
    ["Mode", "Trains", "Width", "Zoom"].forEach((t, i) => { dts[i].textContent = t; });
    $("dir-n").textContent = "Width"; $("dir-s").textContent = "Zoom";
    const statMode = $("stat-trains"), statStations = $("stat-stations"), statW = $("stat-nb"), statZ = $("stat-sb");
    statMode.textContent = "Static";
    const pill = $("status-pill"), reasonEl = $("status-reason"), upEl = $("updated");
    pill.textContent = "Static map"; pill.dataset.level = "unknown"; reasonEl.hidden = true;
    upEl.textContent = "Live trains arrive in a later version"; delete upEl.dataset.error;
    popTitle.textContent = "Live trains"; $("pop-note").hidden = false; $("pop-note").textContent = "Live trains, the cable car and boats will appear here when you zoom in.";
    factsEl.hidden = true;
    svg.style.display = "none";
    svg.setAttribute("aria-label", "");
    root.classList.add("fm-page");
    ctx.lineStyle.textContent = ":root { --line: #23272B; } @media (prefers-color-scheme: dark) { :root:not([data-theme=\"light\"]) { --line: #E6EAED; } } :root[data-theme=\"dark\"] { --line: #E6EAED; }";
    ctx.tickPicker(null);
    scope.later(() => {
      sw.style.background = ""; dts.forEach((d, i) => { d.textContent = dtOld[i]; });
      popTitle.textContent = popTitleOld; $("pop-note").hidden = true; $("pop-note").textContent = ""; factsEl.hidden = false;
      svg.style.display = ""; root.classList.remove("fm-page"); for (const k in LOOKS) root.classList.remove("fm-style-" + k); statMode.textContent = "–"; if (window.__fm) delete window.__fm;
    });

    /* ---------- Scene: one canvas for tiles and overlay, controls, attribution ---------- */
    const box = document.createElement("div");
    box.className = "fm"; box.tabIndex = 0; box.setAttribute("role", "application");
    box.setAttribute("aria-label", "Map of Greater London. Drag to move, scroll or pinch to zoom; or use the arrow keys and the plus and minus keys.");
    const canvas = document.createElement("canvas"); canvas.className = "fm-canvas";
    const liveCanvas = document.createElement("canvas"); liveCanvas.className = "fm-canvas fm-live"; liveCanvas.setAttribute("aria-hidden", "true");
    const tipEl = document.createElement("div"); tipEl.className = "fm-tip"; tipEl.hidden = true;
    const attr = document.createElement("p"); attr.className = "fm-attr";
    attr.textContent = "© OpenStreetMap contributors · Contains OS data © Crown copyright and database right 2026 · Powered by TfL Open Data";
    const pad = document.createElement("div"); pad.className = "fm-pad"; pad.setAttribute("role", "group"); pad.setAttribute("aria-label", "Move the map");
    const arrow = d => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
    pad.innerHTML = `<button type="button" data-d="up" aria-label="Move up">${arrow("M6 15l6-6 6 6")}</button><button type="button" data-d="left" aria-label="Move left">${arrow("M15 6l-6 6 6 6")}</button><button type="button" data-d="right" aria-label="Move right">${arrow("M9 6l6 6-6 6")}</button><button type="button" data-d="down" aria-label="Move down">${arrow("M6 9l6 6 6-6")}</button>`;
    const ctl = document.createElement("div"); ctl.className = "fm-ctl"; ctl.setAttribute("role", "group"); ctl.setAttribute("aria-label", "How to move the map");
    ctl.innerHTML = `<button type="button" data-m="drag" title="Drag the map">${arrow("M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4M17 8l4 4-4 4")}<span>Drag</span></button><button type="button" data-m="buttons" title="Move with buttons">${arrow("M5 5h14v14H5zM9 12h6M12 9v6")}<span>Buttons</span></button>`;
    // the Poster's title plate and tag (CSS shows them only in that style; they never take clicks)
    const plate = document.createElement("div"); plate.className = "fm-plate"; plate.setAttribute("aria-hidden", "true"); plate.innerHTML = "<b>LONDON</b><span>EVERY TRAIN · LIVE</span>";
    const tag = document.createElement("div"); tag.className = "fm-tag"; tag.setAttribute("aria-hidden", "true"); tag.textContent = "UNDERCURRENT";
    box.append(canvas, liveCanvas, plate, tag, attr, tipEl);
    wrapEl.append(box, ctl, pad);
    scope.later(() => { box.remove(); ctl.remove(); pad.remove(); });
    const ctx2 = canvas.getContext("2d", { alpha: false }), ctxL = liveCanvas.getContext("2d");
    // data comes in by script tag (not fetch) so the page also works opened straight from a file
    const loadJS = (url, v, cb, fail) => {
      const tag = document.createElement("script"); tag.src = url + "?v=" + ctx.VERSION;
      tag.onload = () => { tag.remove(); if (!scope.dead && window[v]) cb(window[v]); }; tag.onerror = () => { tag.remove(); if (fail) fail(); };
      document.head.appendChild(tag);
    };

    /* ---------- What is shown (v3.59 filters; v3.60: Layers pop-up with icon, line and label switches) ---------- */
    const on = { fare: false, cc: false, ulez: false, boroughs: false };      // zones and boundaries: off to start with
    const TYPES = [["bridge", "Bridges"], ["worship", "Places of worship"], ["palace", "Palaces and castles"], ["monument", "Monuments"], ["tower", "Towers"], ["museum", "Museums"], ["theatre", "Theatres and halls"], ["civic", "Civic buildings"], ["stadium", "Stadiums"], ["attraction", "Attractions"], ["airport", "Airports"]];
    const show = { lines: true, labels: true, icons: true, cut: false, train: "dest", types: Object.fromEntries(TYPES.map(([k]) => [k, true])) };
    let style = "geographic";
    try { const v = localStorage.getItem(LS_STYLE); if (STYLES.some(t => t.id === v)) style = v; show.cut = localStorage.getItem(LS_CUT) === "1"; } catch (e) {}
    const T = t => cols && cols.upper ? t.toUpperCase() : t;     // names in capitals where the style asks (the Poster)
    const look = () => LOOKS[style] || null;          // null for Geographic
    const art = () => !!look();                       // an Artistic style: one look, shared simplified geometry
    let LB = null, lbLoading = false;          // park and water names (Parchment only), from geo/labels.js
    const typeOn = k => show.icons && show.types[k];
    let F = null, fLoading = false, LM = null, RG = null, edgeHits = [], LIVE = null, liveRunning = false, liveLast = 0;

    /* ---------- State ---------- */
    let W = 800, H = 500, dpr = 1;
    const view = { cx: (BOUNDS.x0 + BOUNDS.x1) / 2, cy: (BOUNDS.y0 + BOUNDS.y1) / 2, s: 0.02 };
    let user = false;                       // the view has been moved by the user (enables the fit button)
    let meta = null, stations = [], have = null, emptyRoads = {}, theme = "light", set = "light", cols = null;
    const roadCanvas = document.createElement("canvas"), ctxR = roadCanvas.getContext("2d");   // the road layer, cut along the lines when "Cut roads at lines" is on
    let mode = "drag";
    try { const m = localStorage.getItem(LS_CTL); if (m === "drag" || m === "buttons") mode = m; else if (lowPower()) mode = "buttons"; } catch (e) { if (lowPower()) mode = "buttons"; }
    function lowPower() { return (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2); }
    const isDark = () => root.dataset.theme === "dark" || (root.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);

    const fitScale = () => Math.min(W / (BOUNDS.x1 - BOUNDS.x0 + 4000), H / (BOUNDS.y1 - BOUNDS.y0 + 4000));
    const minScale = () => fitScale() * 0.9;
    const clampView = () => {
      view.s = Math.max(minScale(), Math.min(MAX_SCALE, view.s));
      view.cx = Math.max(BOUNDS.x0 - PAD, Math.min(BOUNDS.x1 + PAD, view.cx)); view.cy = Math.max(BOUNDS.y0 - PAD, Math.min(BOUNDS.y1 + PAD, view.cy));
    };
    const toScreenX = x => (x - view.cx) * view.s + W / 2, toScreenY = y => (view.cy - y) * view.s + H / 2;

    /* ---------- Tiles: load only what is on screen, keep a small cache ---------- */
    const cache = new Map();                // key -> { img, state: "loading" | "ok" | "missing", used }
    let inflight = 0, frameNo = 0, wanted = [];
    const keyOf = (layer, z, i, j) => `${set}/${layer}/${z}/${i}/${j}`;
    function exists(layer, z, i, j) { const k = i * 100000 + j; return (!have || have[z].has(k)) && !(layer === "roads" && emptyRoads[set] && emptyRoads[set][z].has(k)); }
    function request(layer, z, i, j) {
      const k = keyOf(layer, z, i, j); let e = cache.get(k);
      if (e) { e.used = frameNo; return e; }
      e = { img: null, state: "queued", used: frameNo, set, layer, z, i, j }; cache.set(k, e); return e;
    }
    function pump() {
      while (inflight < MAX_INFLIGHT && wanted.length) {
        const e = wanted.shift();
        if (e.state !== "queued" || e.used !== frameNo) continue;      // no longer on screen: drop it
        e.state = "loading"; inflight++;
        const img = new Image(); e.img = img; img.decoding = "async";
        img.onload = () => { inflight--; e.state = "ok"; dirty(); pump(); };
        img.onerror = () => { inflight--; e.state = "missing"; pump(); };
        img.src = TILE_URL(e.set, e.layer, e.z, e.i, e.j);
      }
    }
    function evict() {
      if (cache.size <= CACHE_MAX) return;
      const old = [...cache.entries()].filter(([, e]) => e.state !== "loading" && e.used < frameNo - 2).sort((a, b) => a[1].used - b[1].used);
      for (const [k, e] of old.slice(0, cache.size - CACHE_MAX + 60)) { if (e.img) { e.img.onload = e.img.onerror = null; e.img.src = ""; } cache.delete(k); }
    }

    /* ---------- Overlay shapes: zones, boroughs, landmarks, airports (v3.59) ---------- */
    const ringsBox = polys => { let a = 1e12, b = 1e12, c = -1e12, d = -1e12; for (const p of polys) for (const q of p[0]) { if (q[0] < a) a = q[0]; if (q[0] > c) c = q[0]; if (q[1] < b) b = q[1]; if (q[1] > d) d = q[1]; } return [a, b, c, d]; };
    function anchors(polys) {            // top of the largest outline (zone labels) and the middle of it (borough names)
      let best = null, area = -1; for (const p of polys) { const r = p[0]; let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; if (Math.abs(a) > area) { area = Math.abs(a); best = r; } }
      let top = best[0], sx = 0, sy = 0; for (const q of best) { if (q[1] > top[1]) top = q; sx += q[0]; sy += q[1]; }
      return { top, mid: [sx / best.length, sy / best.length] };
    }
    function prepFilters(d) {
      const o = { fare: Object.keys(d.fare).sort().map(k => ({ n: k, g: d.fare[k] })), cc: [{ g: d.zones.congestion_charge }], ulez: [{ g: d.zones.ulez }], boroughs: d.boroughs };
      for (const k in o) o[k] = o[k].filter(f => f.g && f.g.length);
      for (const k in o) for (const f of o[k]) { f.box = ringsBox(f.g); f.an = anchors(f.g); }
      return o;
    }
    function tracePolys(c, polys) {
      c.beginPath();
      for (const poly of polys) for (const r of poly) { r.forEach((p, i) => i ? c.lineTo(toScreenX(p[0]), toScreenY(p[1])) : c.moveTo(toScreenX(p[0]), toScreenY(p[1]))); c.closePath(); }
    }
    const onScreen = f => { const a = toScreenX(f.box[0]), b = toScreenY(f.box[3]), e = toScreenX(f.box[2]), d = toScreenY(f.box[1]); return !(e < -10 || a > W + 10 || d < -10 || b > H + 10); };
    function drawFilters() {
      if (!F) return;
      const c = ctx2, LK = look(), pa = !!LK, dark = theme === "dark" && !pa, labels = [];
      c.lineJoin = "round";
      if (on.fare) F.fare.forEach((f, i) => {            // rings: white, grey, white, grey ... (Parchment: cream and a brown wash)
        if (!onScreen(f)) return;
        tracePolys(c, f.g); c.fillStyle = pa ? LK.fare[i % 2] : i % 2 === 0 ? (dark ? "rgba(255,255,255,.11)" : "rgba(255,255,255,.75)") : (dark ? "rgba(0,0,0,.26)" : "rgba(95,108,120,.17)"); c.fill("evenodd");
        c.strokeStyle = pa ? LK.fareLine : dark ? "rgba(185,199,210,.5)" : "rgba(78,101,118,.45)"; c.lineWidth = 1.1; c.stroke();
        labels.push(["Zone " + f.n + (f.n === "7" ? " +" : ""), f.an.top, pa ? LK.fareText : dark ? "#B9C7D2" : "#4E6576"]);
      });
      if (on.boroughs) {                                    // a light tint per borough, four colours so that neighbours differ
        const T4 = pa ? LK.boroughs : ["244,160,160", "150,196,240", "160,214,150", "246,214,120"];
        for (const f of F.boroughs) if (onScreen(f)) { tracePolys(c, f.g); c.fillStyle = `rgba(${T4[f.ci % 4]},${pa ? LK.boroughA : dark ? 0.2 : 0.32})`; c.fill("evenodd"); }
      }
      const zone = (k, col, name, dash) => {
        if (!on[k]) return; const f = F[k][0]; if (!onScreen(f)) return;
        tracePolys(c, f.g); c.fillStyle = col + (dark ? "26" : "1A"); c.fill("evenodd");
        c.strokeStyle = col; c.lineWidth = 1.8; c.setLineDash(dash); c.stroke(); c.setLineDash([]);
        labels.push([name, k === "cc" ? f.an.top : f.an.top, col]);
      };
      zone("ulez", pa ? LK.ulez : dark ? "#3DBB7A" : "#1E9E5A", "ULEZ zone", [7, 5]);
      zone("cc", pa ? LK.cc : dark ? "#E0473B" : "#D52B1E", "Congestion Charge", []);
      if (on.boroughs) {
        c.strokeStyle = pa ? LK.boroughLine : dark ? "rgba(230,234,237,.4)" : "rgba(35,39,43,.38)"; c.lineWidth = 1; c.setLineDash([2, 3]);
        for (const f of F.boroughs) if (onScreen(f)) { tracePolys(c, f.g); c.stroke(); }
        c.setLineDash([]);
        if (view.s < 0.3) { c.font = `${cols.wt} ${(view.s < 0.05 ? 9 : 11) + cols.fs}px ${cols.sans}`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = pa ? LK.boroughText : dark ? "rgba(230,234,237,.62)" : "rgba(35,39,43,.6)";
          for (const f of F.boroughs) if (onScreen(f)) { const x = toScreenX(f.an.mid[0]), y = toScreenY(f.an.mid[1]); if (x > 20 && x < W - 20 && y > 10 && y < H - 10) c.fillText(pa && !cols.upper ? f.n : f.n.toUpperCase(), x, y); } c.textAlign = "left"; }
      }
      c.font = `${cols.wt} ${12 + cols.fs}px ${cols.sans}`; c.textAlign = "center"; c.textBaseline = "middle";
      for (const [t, p, col] of labels) {
        const x = toScreenX(p[0]), y = toScreenY(p[1]) + 12; if (x < 0 || x > W || y < 0 || y > H) continue;
        c.lineWidth = 3.5; c.strokeStyle = cols.bg; c.globalAlpha = 0.85; c.strokeText(T(t), x, y); c.globalAlpha = 1; c.fillStyle = col; c.fillText(T(t), x, y);
      }
      c.textAlign = "left";
    }
    // our own glyphs, drawn on a 24 x 24 grid
    const GLYPH = {
      bridge: "M3 16H21M5 16Q12 5 19 16M9 16v-3M12 16v-5M15 16v-3", worship: "M12 3v4M10 5h4M7 21V12l5-4 5 4v9M4 21h16", palace: "M4 20h16M6 20V10h12v10M6 10l6-6 6 6M10 20v-5h4v5",
      monument: "M12 3l3 4h-6zM10.5 7v11M13.5 7v11M8 18h8M7 21h10", tower: "M12 3v4M9 21l2-14h2l2 14M8 21h8M10 12h4", museum: "M3 9l9-5 9 5M5 9v9M9 9v9M15 9v9M19 9v9M3 20h18",
      theatre: "M5 5h14v4a7 7 0 0 1-14 0zM9 11h.01M15 11h.01M9 15q3 2 6 0", civic: "M6 20V8h12v12M9 11h2M13 11h2M9 15h2M13 15h2M12 8V4M12 4l4 1.5-4 1.5M4 20h16",
      stadium: "M3 11a9 4 0 1 0 18 0a9 4 0 1 0-18 0M3 11v4a9 4 0 0 0 18 0v-4", attraction: "M5 12a7 7 0 1 0 14 0a7 7 0 1 0-14 0M12 5v14M5 12h14M7 7l10 10M17 7L7 17M10 21l2-9 2 9"
    };
    const PLANE = "M12 2.5c1 0 1.6 1 1.6 2.2v4.2l7.4 4.3v2.3l-7.4-2.3v4.2l2 1.9v1.7L12 20l-3.6 1v-1.7l2-1.9v-4.2L3 14.5v-2.3l7.4-4.3V4.7C10.4 3.5 11 2.5 12 2.5z";
    const glyphs = {}; for (const k in GLYPH) glyphs[k] = new Path2D(GLYPH[k]); const planePath = new Path2D(PLANE);
    function badge(x, y, r, kind) {             // Geographic: a dark disc with a light glyph; Parchment: a cream disc with the glyph in ink
      const c = ctx2, pa = art(), disc = pa ? cols.lmFill : cols.ink, mark = pa ? cols.ink : cols.bg;
      c.beginPath(); c.arc(x, y, r, 0, 6.2832); c.fillStyle = disc; c.fill(); c.lineWidth = pa ? (cols.stW || 1.4) : 1.6; c.strokeStyle = pa ? cols.ink : cols.bg; c.stroke();
      c.save(); c.translate(x, y); const k = r * 1.5 / 24; c.scale(k, k); c.translate(-12, -12);
      if (kind === "plane") { c.fillStyle = mark; c.fill(planePath); } else { c.strokeStyle = mark; c.lineWidth = 1.9; c.lineCap = "round"; c.lineJoin = "round"; c.stroke(glyphs[kind] || glyphs.attraction); }
      c.restore();
    }
    function labelBox(c, text, x, y, placed, font) {   // returns false when it would sit on something already placed
      c.font = font; const w = c.measureText(text).width, bx = x, by = y - 7;
      if (placed.some(q => bx < q[0] + q[2] + 2 && bx + w + 2 > q[0] && by < q[1] + 14 && by + 14 > q[1])) return null;
      placed.push([bx, by, w]); return w;
    }
    // landmarks are laid out first (so their names win over station names for space), painted after the stations
    function layoutLandmarks(placed) {
      const items = [];
      if (!LM) return items;
      const c = ctx2, s = view.s, r = s < 0.1 ? 9 : 11.5, font = `${cols.wt} ${12 + cols.fs}px ${cols.sans}`;
      if (s < 0.028) return items;
      const vis = LM.landmarks.filter(l => typeOn(l.c) && !(l.t === 2 && s < 0.1)).map(l => ({ l, x: toScreenX(l.x), y: toScreenY(l.y) })).filter(o => o.x > -20 && o.y > -20 && o.x < W + 20 && o.y < H + 20);
      vis.sort((p, q) => p.l.t - q.l.t);
      for (const o of vis) {
        placed.push([o.x - r, o.y - 7, 2 * r]);
        let w = null;
        if (s >= 0.06 && (o.l.t === 1 || s >= 0.25)) w = labelBox(c, T(o.l.n), o.x + r + 5, o.y, placed, font);
        items.push({ x: o.x, y: o.y, r, kind: o.l.c, name: w !== null ? T(o.l.n) : null, font });
      }
      return items;
    }
    function drawLandmarks(items) {
      if (!LM) return;
      const c = ctx2; c.textBaseline = "middle"; c.textAlign = "left";
      for (const it of items) {
        badge(it.x, it.y, it.r, it.kind);
        if (it.name) { c.font = it.font; c.lineWidth = 3.5; c.strokeStyle = cols.bg; c.globalAlpha = 0.9; c.strokeText(it.name, it.x + it.r + 5, it.y); c.globalAlpha = 1; c.fillStyle = cols.ink; c.fillText(it.name, it.x + it.r + 5, it.y); }
      }
      // airports: a plane badge when on screen, otherwise an arrow pill at the edge pointing at it with the distance
      edgeHits = [];
      const all = typeOn("airport") ? LM.airports.concat(LM.edge) : [];
      for (const a of all) {
        const x = toScreenX(a.x), y = toScreenY(a.y), near = LM.airports.includes(a);
        if (x > 18 && x < W - 18 && y > 18 && y < H - 18) {
          badge(x, y, 12.5, "plane");
          const font = `${art() ? cols.wt : 700} ${12 + cols.fs}px ${cols.sans}`; c.font = font; c.lineWidth = 3.5; c.strokeStyle = cols.bg; c.globalAlpha = 0.9; c.strokeText(T(a.n), x + 18, y); c.globalAlpha = 1; c.fillStyle = cols.ink; c.fillText(T(a.n), x + 18, y);
          continue;
        }
        const km = Math.hypot(a.x - view.cx, a.y - view.cy) / 1000, text = T(`${a.n} · ${Math.round(km)} km`);
        c.font = `${cols.wt} ${12 + cols.fs}px ${cols.sans}`; const tw = c.measureText(text).width, pw = tw + 38, ph = 26;
        const fr = look() && look().frame ? 26 : 10;                                   // the Poster's frame takes more of the edge
        const dx = x - W / 2, dy = y - H / 2, ex = W / 2 - pw / 2 - fr, ey = H / 2 - ph / 2 - fr, k = Math.min(dx ? ex / Math.abs(dx) : 1e9, dy ? ey / Math.abs(dy) : 1e9);
        let px = W / 2 + dx * k, py = H / 2 + dy * k;
        py = Math.max(look() && look().frame ? 68 : 58, Math.min(H - 36, py)); if (py < 80) px = Math.max(px, 190 + pw / 2);   // keep clear of the Drag / Buttons switch and the attribution line
        if (plate.offsetWidth && getComputedStyle(plate).display !== "none") { const pr = plate.offsetLeft + plate.offsetWidth + 10, pb = plate.offsetTop + plate.offsetHeight + 6; if (py - ph / 2 < pb && px - pw / 2 < pr) px = pr + pw / 2; }   // and the Poster's title plate
        px = Math.min(px, W - pw / 2 - fr);
        for (let g = 0; g < 6 && edgeHits.some(q => px - pw / 2 < q[0] + q[2] + 6 && px + pw / 2 + 6 > q[0] && py - ph / 2 < q[1] + q[3] + 4 && py + ph / 2 + 4 > q[1]); g++) py += py < H / 2 ? ph + 6 : -(ph + 6);   // never on top of another airport's pill
        c.beginPath(); c.roundRect(px - pw / 2, py - ph / 2, pw, ph, 13); c.fillStyle = cols.ink; c.globalAlpha = 0.92; c.fill(); c.globalAlpha = 1;
        c.save(); c.translate(px - pw / 2 + 15, py); c.rotate(Math.atan2(dx, -dy)); const g = 15 / 24; c.scale(g, g); c.translate(-12, -12); c.fillStyle = cols.bg; c.fill(planePath); c.restore();
        c.fillStyle = cols.bg; c.fillText(text, px - pw / 2 + 28, py + 0.5);
        edgeHits.push([px - pw / 2, py - ph / 2, pw, ph, a.x, a.y]);
      }
    }

    /* ---------- Stations (overlay) ---------- */
    function levelFor() {
      const need = view.s * dpr * 0.8;
      for (let z = 0; z < meta.scales.length; z++) if (meta.scales[z] >= need) return z;
      return meta.scales.length - 1;
    }
    function readColours() {               // the drawing colours and type for the current style (Geographic follows the page's light or dark theme)
      const LK = look();
      if (LK) { cols = Object.assign({}, LK.cols); return; }
      const cs = getComputedStyle(root), v = n => cs.getPropertyValue(n).trim();
      cols = { bg: v("--bg") || "#F1F2EF", ink: v("--ink") || "#23272B", muted: v("--muted") || "#697177", fill: v("--station-fill") || "#fff", sans: v("--sans") || "Outfit, sans-serif", wt: 600, fs: 0, sw: "", ls: 0, upper: false };
    }
    const lineColour = lid => look() ? look().lineColour(lid) : LINE_COL[lid];
    // park, lake and river names (Artistic styles): placed after the stations so they never push a station name off
    function drawAreaLabels(placed) {
      const LK = look(); if (!LB || !LK || !show.labels) return;
      const A = LK.area, c = ctx2, s = view.s; c.textBaseline = "middle"; c.textAlign = "center"; c.lineJoin = "round";
      let n = 0, na = 0; const wide = isWide(), got = []; labelStats.areas = 0;
      if (!LB.ranked) LB.ranked = LB.labels.slice().sort((p, q) => q.a * (FAMOUS.has(q.n.toLowerCase()) ? 4 : 1) - p.a * (FAMOUS.has(p.n.toLowerCase()) ? 4 : 1));
      for (const l of LB.ranked) {
        if (n > 60) break;
        const river = l.k === "river";
        if (wide && !river && na >= CAP_AREA) continue;
        if (river ? s < A.riverS : l.a * s * s < 2600 || l.a * s * s > W * H * 0.8) continue;
        const x = toScreenX(l.x), y = toScreenY(l.y); if (x < 30 || y < 14 || x > W - 30 || y > H - 14) continue;
        const fsz = river ? Math.min(20, 13 + s * 14) : Math.min(16, 11.5 + Math.log10(l.a * s * s / 2600 + 1) * 3.2);
        c.font = `${A.italic ? "italic " : ""}${A.wt}${fsz.toFixed(1)}px ${A.family}`; const txt = A.upper ? l.n.toUpperCase() : l.n, w = c.measureText(txt).width;
        if (A.fit && !river && w > Math.sqrt(l.a * s * s) * A.fit) continue;            // cream names only where the park or lake is big enough to hold them
        let ang = river ? -l.r * Math.PI / 180 : 0; if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
        const bw = Math.abs(Math.cos(ang)) * w + Math.abs(Math.sin(ang)) * fsz, bh = Math.abs(Math.sin(ang)) * w + Math.abs(Math.cos(ang)) * fsz, bx = x - bw / 2, by = y - bh / 2;
        if (bx < 6 || by < 6 || bx + bw > W - 6 || by + bh > H - 6) continue;          // whole name on the map
        if (placed.some(q => bx < q[0] + q[2] + 2 && bx + bw + 2 > q[0] && by < q[1] + 14 && by + bh > q[1])) continue;
        if (wide && !river && got.some(g => Math.hypot(g[0] - x, g[1] - y) < SPACE_AREA)) continue;
        placed.push([bx, by, bw]); n++; if (!river) { na++; labelStats.areas++; got.push([x, y]); }
        const K = l.k === "park" ? A.park : A.water;
        c.save(); c.translate(x, y); c.rotate(ang);
        if (K.halo) { c.lineWidth = 3.5; c.strokeStyle = K.halo; c.strokeText(txt, 0, 0); }
        c.fillStyle = K.fill; c.fillText(txt, 0, 0); c.restore();
      }
      c.textAlign = "left";
    }
    // v3.78: label hierarchy. Wide or more (maps 11 km across or wider): at most 25 station names and 8 park or lake names, busiest (or biggest and best known) first,
    // spaced out so each area shows its most important name. Closer in there is no cap; overlap is the only rule, and busier stations claim space first.
    const WIDE_KM = 11, CAP_STN = 25, CAP_AREA = 8, SPACE_STN = 70, SPACE_AREA = 120;
    const isWide = () => W / view.s / 1000 >= WIDE_KM;
    const labelStats = { stations: 0, areas: 0 };                // the last frame's name counts (debug: window.__fm.labels)
    function drawStations(dprv, placed) {
      const s = view.s, lvl = s < 0.05 ? 0 : s < 0.5 ? 1 : 2, wide = isWide();
      const c = ctx2, labels = [], cand = [];
      let shown = 0;
      const dot = (st, x, y, r, live) => {
        const pier = st.modes.includes("river-bus") || st.modes.includes("ferry");
        c.beginPath();
        if (pier) { c.moveTo(x, y - r - 1); c.lineTo(x + r + 1, y); c.lineTo(x, y + r + 1); c.lineTo(x - r - 1, y); c.closePath(); }
        else c.arc(x, y, r, 0, 6.2832);
        c.fillStyle = cols.fill; c.fill(); c.lineWidth = live ? (art() ? (cols.stW || 1.4) : 1.6) : (cols.stW2 || 1.1); c.strokeStyle = live ? cols.ink : cols.muted; c.stroke();
      };
      for (const st of stations) {
        const live = st.lines.length > 0, hub = st.lines.length > 1;
        const x = toScreenX(st.x), y = toScreenY(st.y);
        if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
        const r = lvl === 0 ? 2 : lvl === 1 ? (live ? 3.2 : 2.4) : (live ? 5 : 3.6);
        const drawn = !(lvl === 0 && (!hub || st.modes.includes("river-bus") && st.modes.length === 1)) && !(lvl === 1 && !live && s < 0.12);
        if (wide && live && !(st.modes.includes("river-bus") && st.modes.length === 1)) cand.push([st, x, y, r, drawn]);
        if (!drawn) continue;
        shown++; dot(st, x, y, r, live);
        if (!wide && lvl > 0 && (live || lvl === 2)) labels.push([st, x, y, r, hub ? 0 : live ? 1 : 2]);
      }
      statStations.textContent = shown; labelStats.stations = 0;
      if (!show.labels) return;
      c.font = `${cols.sw}${(lvl === 2 ? 13 : 11) + cols.fs}px ${cols.sans}`; c.textBaseline = "middle"; c.textAlign = "left"; c.lineJoin = "round";
      const put = (st, x, y, r) => {
        const nm = T(st.name), w = c.measureText(nm).width, bx = x + r + 4, by = y - 7;
        if (bx > W || bx + w < 0) return false;
        if (placed.some(q => bx < q[0] + q[2] + 2 && bx + w + 2 > q[0] && by < q[1] + 14 && by + 14 > q[1])) return false;
        placed.push([bx, by, w]);
        c.lineWidth = 3; c.strokeStyle = cols.bg; c.globalAlpha = 0.9; c.strokeText(nm, bx, y); c.globalAlpha = 1;
        c.fillStyle = cols.ink; c.fillText(nm, bx, y); labelStats.stations++; return true;
      };
      if (wide) {
        cand.sort((a, b) => b[0].rank - a[0].rank);
        const got = [];
        for (const [st, x, y, r, drawn] of cand) {
          if (got.length >= CAP_STN) break;
          if (got.some(g => Math.hypot(g[0] - x, g[1] - y) < SPACE_STN)) continue;      // one name per area: a busier station nearby already has it
          if (!drawn) dot(st, x, y, r, true);
          if (put(st, x, y, r)) got.push([x, y]);
        }
        return;
      }
      labels.sort((a, b) => a[4] - b[4] || b[0].rank - a[0].rank);
      for (const [st, x, y, r] of labels) put(st, x, y, r);
    }

    /* ---------- Rail lines (v3.60): drawn here, not in the tiles, so they can be thick, smooth, side by side on shared track, and switched off ---------- */
    function prepRG(d) {
      const ids = Object.keys(d.lines).filter(l => LINE_COL[l]).sort((a, b) => (a === "circle" || a === "hammersmith-city") - (b === "circle" || b === "hammersmith-city"));
      for (const lid of ids) {
        const ends = {};
        for (const sg of d.lines[lid].segments) {
          let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12; for (const p of sg.path) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
          sg._b = [x0, y0, x1, y1];
          sg._u = sg.u || sg.path.slice(1).map(() => 0);      // stripe lanes per edge, worked out when the data is built (conflate.py)
          (ends[sg.a] = ends[sg.a] || []).push(sg.path[0]); (ends[sg.b] = ends[sg.b] || []).push(sg.path[sg.path.length - 1]);
        }
        d.lines[lid]._joins = Object.values(ends).filter(a => a.length > 1);
      }
      return { d, ids };
    }
    function offsetPts(P, off) {          // each vertex moves sideways by the average of its two edges' offsets, so a stripe eases out or in instead of jumping
      const n = P.length, N = [], out = [];
      for (let i = 0; i < n - 1; i++) { const dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1], L = Math.hypot(dx, dy) || 1; N.push([-dy / L, dx / L]); }
      for (let j = 0; j < n; j++) {
        let nx, ny, o, d = 1;
        if (j === 0) { nx = N[0][0]; ny = N[0][1]; o = off[0]; }
        else if (j === n - 1) { nx = N[n - 2][0]; ny = N[n - 2][1]; o = off[n - 2]; }
        else {
          const a = N[j - 1], b = N[j]; nx = a[0] + b[0]; ny = a[1] + b[1]; const ml = Math.hypot(nx, ny);
          if (ml < 1e-6) { nx = a[0]; ny = a[1]; } else { nx /= ml; ny /= ml; d = Math.max(0.55, nx * a[0] + ny * a[1]); }
          o = (off[j - 1] + off[j]) / 2;
        }
        out.push([P[j][0] + nx * o / d, P[j][1] + ny * o / d]);
      }
      return out;
    }
    function smoothTo(c, Q) {            // a curve through the middle of each corner: smooth, and it never strays far from the track
      if (Q.length < 2) return; c.moveTo(Q[0][0], Q[0][1]);
      for (let i = 1; i < Q.length - 1; i++) c.quadraticCurveTo(Q[i][0], Q[i][1], (Q[i][0] + Q[i + 1][0]) / 2, (Q[i][1] + Q[i + 1][1]) / 2);
      c.lineTo(Q[Q.length - 1][0], Q[Q.length - 1][1]);
    }
    const lineW = () => Math.max(2, Math.min(6.5, 24 * view.s));
    const casingW = lw => { const L = look(); return L ? L.casingW(lw) : lw; };        // Artistic: the casing round each line (Parchment brown ink, Poster cream)
    function traceLine(c, L, stripe, bx) {        // one line's track, smoothed, moved onto its stripe lane on shared track
      const [x0, y0, x1, y1] = bx;
      for (const sg of L.segments) {
        const b = sg._b; if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
        const P = sg.path.map(p => [toScreenX(p[0]), toScreenY(p[1])]);
        smoothTo(c, stripe && sg._u.some(u => u) ? offsetPts(P, sg._u.map(u => u * stripe)) : P);
      }
      for (const pts of L._joins) for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {   // close the little gaps where neighbouring pairs met the track at slightly different points
        const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
        if (d > 0.3 && d < 150 && pts[i][0] > x0 && pts[i][0] < x1 && pts[i][1] > y0 && pts[i][1] < y1) { c.moveTo(toScreenX(pts[i][0]), toScreenY(pts[i][1])); c.lineTo(toScreenX(pts[j][0]), toScreenY(pts[j][1])); }
      }
    }
    function lineBox() { const s = view.s, pad = 60 / s; return [view.cx - W / 2 / s - pad, view.cy - H / 2 / s - pad, view.cx + W / 2 / s + pad, view.cy + H / 2 / s + pad]; }
    function drawLines() {
      if (!RG || !show.lines) return;
      const c = ctx2, s = view.s, lw = lineW(), stripe = s < 0.05 ? 0 : lw * 0.92, bx = lineBox(), pa = art();
      c.lineCap = "round"; c.lineJoin = "round";
      if (pa) {                                    // all the casings first, so side-by-side stripes keep their colours
        c.strokeStyle = look().casing; c.lineWidth = casingW(lw); c.beginPath();
        for (const lid of RG.ids) if (!/^rb/.test(lid)) traceLine(c, RG.d.lines[lid], stripe, bx);
        c.stroke();
      }
      for (const lid of RG.ids) {
        const L = RG.d.lines[lid];
        for (const pass of (theme === "dark" && !pa && lid === "northern") ? [0, 1] : [1]) {
          const boat = /^rb/.test(lid); c.strokeStyle = pass === 0 ? "#69737C" : lineColour(lid); c.lineWidth = pass === 0 ? lw + 2 : boat ? Math.max(1.4, lw * 0.5) : lw; c.setLineDash(boat ? [6, 5] : []); c.beginPath();
          traceLine(c, L, stripe, bx);
          c.stroke(); c.setLineDash([]);
        }
      }
    }
    // "Cut roads at lines": the road tiles are drawn onto their own canvas and erased along every drawn line (not the boats, which pass under the bridges),
    // so the lines sit clear of the roads like an overpass. Only redrawn with the map (pan, zoom, style, switches), never per train frame.
    function cutRoads() {
      if (!RG || !show.lines) return;
      const c = ctxR, lw = lineW(), stripe = view.s < 0.05 ? 0 : lw * 0.92, bx = lineBox(), pa = art();
      c.save(); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.globalCompositeOperation = "destination-out"; c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = "#000";
      c.lineWidth = (pa ? casingW(lw) : lw) + 2 * CUT_GAP; c.beginPath();
      for (const lid of RG.ids) if (!/^rb/.test(lid) && !(theme === "dark" && !pa && lid === "northern")) traceLine(c, RG.d.lines[lid], stripe, bx);
      c.stroke();
      if (theme === "dark" && !pa && RG.d.lines.northern) { c.lineWidth = lw + 2 + 2 * CUT_GAP; c.beginPath(); traceLine(c, RG.d.lines.northern, stripe, bx); c.stroke(); }
      c.restore();
    }
    /* ---------- Live trains (v3.65): fullmap-live.js does the feed and the motion; this draws them on their own canvas so the map is not redrawn every frame ---------- */
    function apiUrl(path) {
      let key = ""; try { key = localStorage.getItem("tfl-app-key") || ""; } catch (e) {}
      return "https://api.tfl.gov.uk" + path + (key ? (path.includes("?") ? "&" : "?") + "app_key=" + encodeURIComponent(key) : "");
    }
    const viewRect = () => ({ x0: view.cx - W / 2 / view.s, x1: view.cx + W / 2 / view.s, y0: view.cy - H / 2 / view.s, y1: view.cy + H / 2 / view.s });
    function liveSync() {
      if (!LIVE) return;
      LIVE.setView(viewRect(), W / view.s);
      if (LIVE.live && !liveRunning) { liveRunning = true; scope.frame(liveFrame); }
      if (!LIVE.live) { ctxL.setTransform(1, 0, 0, 1, 0, 0); ctxL.clearRect(0, 0, liveCanvas.width, liveCanvas.height); }
    }
    function liveFrame(now) {
      if (!LIVE || !LIVE.live) { liveRunning = false; ctxL.setTransform(1, 0, 0, 1, 0, 0); ctxL.clearRect(0, 0, liveCanvas.width, liveCanvas.height); return; }
      if (now - liveLast >= 30) {
        liveLast = now;
        ctxL.setTransform(1, 0, 0, 1, 0, 0); ctxL.clearRect(0, 0, liveCanvas.width, liveCanvas.height); ctxL.setTransform(dpr, 0, 0, dpr, 0, 0);
        LIVE.draw(ctxL, toScreenX, toScreenY, viewRect(), view.s, Date.now(), cols ? cols.bg : "#F1F2EF", look() ? look().trainOutline : theme === "dark" ? "#E6EAED" : "#FFFFFF", look() ? look().trainFont : cols ? cols.sans : "Outfit", look() ? look().glow : null);
      }
      scope.frame(liveFrame);
    }
    function livePanel() {
      if (!LIVE) return;
      const S = LIVE.state, live = LIVE.live, n = LIVE.count(viewRect());
      statMode.textContent = live ? "Live" : "Static";
      statStations.textContent = LIVE.blur ? "–" : n;
      if (S.err) { upEl.dataset.error = ""; upEl.textContent = S.err; }
      else if (S.ok) { delete upEl.dataset.error; const a = Math.round((Date.now() - S.ok) / 1000); upEl.textContent = a < 5 ? "Updated just now" : `Updated ${a} seconds ago`; }
      else { delete upEl.dataset.error; upEl.textContent = "Connecting to TfL…"; }
      pill.textContent = S.err ? "Live data trouble" : S.ok ? "Live" : "Connecting"; pill.dataset.level = S.err ? "minor" : S.ok ? "good" : "unknown"; reasonEl.hidden = true;
      $("pop-note").textContent = LIVE.blur ? "Live data is flowing for the whole map. Zoom in a little further to see individual trains." : `${n} train${n === 1 ? "" : "s"} on screen, ${LIVE.lines} line${LIVE.lines === 1 ? "" : "s"} asked for. Tap a train for its next stop.`;
    }
    scope.every(livePanel, 1000);
    if (ctx.debug) window.__fmLive = { get live() { return LIVE; } };

    /* ---------- Map style (v3.71): swaps the tile set and the drawing colours in place, keeping the view ---------- */
    function setStyle(id) {
      if (!STYLES.some(t => t.id === id)) return;
      style = id; try { localStorage.setItem(LS_STYLE, id); } catch (e) {}
      cols = null; prepStyle(); dirty();
    }
    function prepStyle() {                     // an Artistic style needs its fonts and the park and water names
      if (!art()) return;
      if (document.fonts && document.fonts.load) Promise.all(look().fonts.map(f => document.fonts.load(f))).then(() => { if (!scope.dead) { cols = null; dirty(); } }, () => {});
      if (!LB && !lbLoading) { lbLoading = true; loadJS("geo/labels.js", "UC_LABELS", d => { LB = d; dirty(); }, () => { lbLoading = false; }); }
    }
    if (ctx.debug) window.__fm = { get style() { return style; }, get cut() { return show.cut; }, setStyle, setCut(v) { show.cut = !!v; dirty(); }, get view() { return view; }, redraw() { draw(); }, get labels() { return Object.assign({}, labelStats); } };

    /* ---------- Layers pop-up (left panel button) ---------- */
    function setupLayers() {
      const scrim = $("sheet-scrim"), btnBox = document.querySelector(".panel-btns");
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "menu-btn fm-layers-btn"; btn.setAttribute("aria-haspopup", "dialog");
      btn.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 17l9 5 9-5"/></svg>Layers';
      btnBox.insertBefore(btn, $("menu-open").nextSibling);
      const sw = (attr, k, label, col) => `<button type="button" class="fm-sw" role="switch" aria-checked="false" data-${attr}="${k}">${col ? `<i style="--c:${col}"></i>` : "<i></i>"}<span><b>${label}</b></span><em aria-hidden="true"></em></button>`;
      const sheet = document.createElement("section"); sheet.className = "sheet fm-sheet"; sheet.hidden = true; sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-labelledby", "sheet-map-h");
      sheet.innerHTML = `<div class="sheet-head"><h2 id="sheet-map-h">Layers</h2><button type="button" class="sheet-x" data-close aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
        <div class="sheet-body"><p class="sub-label">Map style</p><div class="seg fm-cat" role="radiogroup" aria-label="Map category">${CATS.map(c => `<input type="radio" name="fm-cat" id="fm-cat-${c.id}" value="${c.id}"><label for="fm-cat-${c.id}">${c.name}</label>`).join("")}</div>
        <div class="fm-styles" role="radiogroup" aria-label="Map style"></div>
        <p class="sub-label">Zones and boundaries</p><div class="fm-sws">${sw("f", "fare", "Fare zones", "#4E6576")}${sw("f", "cc", "Congestion Charge", "#D52B1E")}${sw("f", "ulez", "ULEZ zone", "#1E9E5A")}${sw("f", "boroughs", "Boroughs", "#97AEBC")}</div>
        <p class="sub-label">Icons</p><div class="fm-sws">${sw("s", "icons", "All icons")}</div>
        <div class="fm-chips">${TYPES.map(([k, n]) => `<button type="button" class="fm-chip" aria-pressed="true" data-t="${k}"><svg width="20" height="20" viewBox="0 0 24 24" fill="${k === "airport" ? "currentColor" : "none"}" stroke="${k === "airport" ? "none" : "currentColor"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${k === "airport" ? PLANE : GLYPH[k]}"/></svg>${n}</button>`).join("")}</div>
        <p class="sub-label">Rail</p><div class="fm-sws">${sw("s", "lines", "Tube lines")}${sw("s", "labels", "Tube labels")}${sw("s", "cut", "Cut roads at lines")}</div>
        <p class="sub-label">Train labels</p><div class="seg seg3" role="radiogroup" aria-label="Train labels"><input type="radio" name="fm-tl" id="fm-tl-dest" value="dest"><label for="fm-tl-dest">Destination</label><input type="radio" name="fm-tl" id="fm-tl-vid" value="vid"><label for="fm-tl-vid">Vehicle ID</label><input type="radio" name="fm-tl" id="fm-tl-off" value="off"><label for="fm-tl-off">Off</label></div></div>`;
      document.body.appendChild(sheet);
      let isOpen = false;
      const paint = () => {
        sheet.querySelectorAll("[data-f]").forEach(b => b.setAttribute("aria-checked", String(on[b.dataset.f])));
        sheet.querySelectorAll("[data-s]").forEach(b => b.setAttribute("aria-checked", String(show[b.dataset.s])));
        sheet.querySelectorAll('input[name="fm-tl"]').forEach(r => { r.checked = r.value === show.train; });
        const cat = (STYLES.find(t => t.id === style) || STYLES[0]).cat;
        sheet.querySelectorAll('input[name="fm-cat"]').forEach(r => { r.checked = r.value === cat; });
        sheet.querySelector(".fm-styles").innerHTML = STYLES.filter(t => t.cat === cat).map(t => `<label class="fm-style-opt"><input type="radio" name="fm-style" value="${t.id}"${t.id === style ? " checked" : ""}><span>${t.name}</span></label>`).join("");
        sheet.querySelectorAll("[data-t]").forEach(b => { b.setAttribute("aria-pressed", String(show.types[b.dataset.t])); b.disabled = !show.icons; });
      };
      const open = () => { if (isOpen) return; isOpen = true; paint(); scrim.hidden = false; sheet.hidden = false; void sheet.offsetWidth; scrim.classList.add("in"); sheet.classList.add("in"); sheet.querySelector(".sheet-x").focus({ preventScroll: true }); };
      const close = () => {
        if (!isOpen) return; isOpen = false; sheet.classList.remove("in"); scrim.classList.remove("in");
        scope.after(() => { if (!isOpen) { sheet.hidden = true; scrim.hidden = true; } }, reduceMotion ? 0 : 220); btn.focus({ preventScroll: true });
      };
      scope.on(btn, "click", open); scope.on(sheet.querySelector("[data-close]"), "click", close); scope.on(scrim, "click", close);
      scope.on(document, "keydown", e => { if (isOpen && e.key === "Escape") close(); });
      scope.on(sheet, "change", e => { const r = e.target; if (r && r.name === "fm-style") { setStyle(r.value); paint(); return; }
        if (r && r.name === "fm-cat") { const cur = STYLES.find(t => t.id === style); if (!cur || cur.cat !== r.value) setStyle(STYLES.find(t => t.cat === r.value).id); paint(); return; } if (r && r.name === "fm-tl") { show.train = r.value; if (LIVE) LIVE.setLabels(show.train); try { const p = document.getElementById(r.value === "vid" ? "lbl-num" : "lbl-dest"); if (p && r.value !== "off") p.checked = true; } catch (x) {} dirty(); } });
      scope.on(sheet, "click", e => {
        const b = e.target.closest("button"); if (!b || b.disabled) return;
        if (b.dataset.f) { const k = b.dataset.f; on[k] = !on[k]; if (on[k] && !F && !fLoading) { fLoading = true; loadJS("geo/filters.js", "UC_FILTERS", d => { F = prepFilters(d); dirty(); }, () => { fLoading = false; }); } }
        else if (b.dataset.s) { show[b.dataset.s] = !show[b.dataset.s]; if (b.dataset.s === "cut") { try { localStorage.setItem(LS_CUT, show.cut ? "1" : "0"); } catch (x) {} } }
        else if (b.dataset.t) show.types[b.dataset.t] = !show.types[b.dataset.t];
        else return;
        paint(); dirty();
      });
      scope.later(() => { btn.remove(); sheet.remove(); if (isOpen) { scrim.classList.remove("in"); scrim.hidden = true; } });
    }

    /* ---------- Drawing (only when something changed) ---------- */
    let pending = 0, anim = null, isDirty = true;
    function dirty() { isDirty = true; if (!pending) pending = scope.frame(tick); }
    function tick(now) {
      pending = 0;
      if (anim) {
        const u = reduceMotion ? 1 : Math.min(1, (now - anim.t0) / anim.ms), e = 1 - Math.pow(1 - u, 3);
        view.s = anim.s0 * Math.pow(anim.s1 / anim.s0, e);
        const k = anim.keep;                                   // the map point under `keep` stays under it while zooming
        if (k) { view.cx = k.mx - (k.px - W / 2) / view.s; view.cy = k.my + (k.py - H / 2) / view.s; }
        else { view.cx = anim.x0 + (anim.x1 - anim.x0) * e; view.cy = anim.y0 + (anim.y1 - anim.y0) * e; }
        clampView();
        if (u >= 1) anim = null; else isDirty = true;
      }
      if (isDirty) { isDirty = false; draw(); }
      if (anim || isDirty) pending = scope.frame(tick);
    }
    function draw() {
      if (!meta) return;
      frameNo++;
      const t = isDark() ? "dark" : "light", st = STYLES.find(q => q.id === style) || STYLES[0], ns = st[t];
      if (t !== theme || ns !== set || !cols) { theme = t; set = ns; readColours(); for (const k in LOOKS) { box.classList.toggle("fm-" + k, style === k); root.classList.toggle("fm-style-" + k, style === k); } box.classList.toggle("fm-art", art()); }
      const c = ctx2, z = levelFor(), M = meta.tile / meta.scales[z], ox = meta.origin[0], oy = meta.origin[1];
      c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = cols.bg; c.fillRect(0, 0, canvas.width, canvas.height);
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
      if ("letterSpacing" in c) c.letterSpacing = (cols.ls || 0) + "px";           // wide-spaced capitals in the Poster
      const x0 = view.cx - W / 2 / view.s, x1 = view.cx + W / 2 / view.s, y0 = view.cy - H / 2 / view.s, y1 = view.cy + H / 2 / view.s;
      // two layers per style: the base, then the roads on top (on their own canvas when they are cut at the lines)
      const cut = show.cut && show.lines && !!RG;
      // finer tiles that are not here yet fall back to the coarser ones already loaded
      let missing = false;
      const want = [];
      const span = lv => { const m = meta.tile / meta.scales[lv]; return [Math.floor((x0 - ox) / m), Math.floor((x1 - ox) / m), Math.floor((oy - y1) / m), Math.floor((oy - y0) / m), m]; };
      { const [i0, i1, j0, j1] = span(z);
        for (const layer of ["base", "roads"]) for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { if (!exists(layer, z, i, j)) continue; const e = request(layer, z, i, j); if (e.state === "queued" || e.state === "loading") missing = true; if (e.state === "queued") want.push([e, Math.hypot((ox + (i + .5) * M) - view.cx, (oy - (j + .5) * M) - view.cy) + (layer === "roads" ? 1 : 0)]); } }
      want.sort((a, b) => a[1] - b[1]); wanted = want.map(a => a[0]);
      const drawLevel = (lv, layer, g) => {
        const [i0, i1, j0, j1, m] = span(lv);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          if (!exists(layer, lv, i, j)) continue;
          const e = cache.get(keyOf(layer, lv, i, j)); if (!e || e.state !== "ok") continue; e.used = frameNo;
          const ax = Math.floor(toScreenX(ox + i * m) * dpr), ay = Math.floor(toScreenY(oy - j * m) * dpr);
          const bx = Math.ceil(toScreenX(ox + (i + 1) * m) * dpr), by = Math.ceil(toScreenY(oy - (j + 1) * m) * dpr);
          g.drawImage(e.img, ax, ay, bx - ax, by - ay);
        }
      };
      const lvs = []; if (missing) for (let lv = Math.max(0, z - 2); lv < z; lv++) lvs.push(lv); lvs.push(z);
      if (missing) for (const lv of lvs.slice(0, -1)) { const [i0, i1, j0, j1] = span(lv); for (const layer of ["base", "roads"]) for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (exists(layer, lv, i, j)) request(layer, lv, i, j); }
      for (const lv of lvs) drawLevel(lv, "base", c);
      let g = c;
      if (cut) { if (roadCanvas.width !== canvas.width || roadCanvas.height !== canvas.height) { roadCanvas.width = canvas.width; roadCanvas.height = canvas.height; } g = ctxR; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, roadCanvas.width, roadCanvas.height); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; }
      for (const lv of lvs) drawLevel(lv, "roads", g);
      if (cut) { cutRoads(); c.drawImage(roadCanvas, 0, 0); }
      if (missing) for (const lv of lvs.slice(0, -1)) { const [i0, i1, j0, j1] = span(lv); const q = []; for (const layer of ["base", "roads"]) for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (exists(layer, lv, i, j)) { const e = cache.get(keyOf(layer, lv, i, j)); if (e && e.state === "queued") q.push(e); } wanted = q.concat(wanted); }
      pump(); evict();
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawFilters();
      drawLines();
      const placed = [], lmItems = layoutLandmarks(placed);
      if (stations.length) drawStations(dpr, placed);
      drawAreaLabels(placed);
      drawLandmarks(lmItems);
      // panel read-outs
      const km = W / view.s / 1000;
      statW.textContent = km >= 10 ? Math.round(km) + " km" : km.toFixed(1) + " km";
      statZ.textContent = Math.round(view.s / fitScale() * 100) + "%";
      const fit = $("zoom-fit"); if (fit) fit.disabled = !user;
      liveSync();
    }

    /* ---------- Moving the view ---------- */
    function resize() {
      const r = wrapEl.getBoundingClientRect(), cs = getComputedStyle(wrapEl);
      const w = Math.max(200, Math.round(r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))), h = Math.max(160, Math.round(r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)));
      const first = !user && !anim;
      W = w; H = h; dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = liveCanvas.width = Math.round(W * dpr); canvas.height = liveCanvas.height = Math.round(H * dpr);
      if (first) resetView(true); else { clampView(); dirty(); }
    }
    function resetView(instant) {
      user = false;
      const s = fitScale() * 0.97, x = (BOUNDS.x0 + BOUNDS.x1) / 2, y = (BOUNDS.y0 + BOUNDS.y1) / 2;
      if (instant || reduceMotion) { view.s = s; view.cx = x; view.cy = y; clampView(); dirty(); }
      else { anim = { t0: performance.now(), ms: 380, s0: view.s, s1: s, x0: view.cx, y0: view.cy, x1: x, y1: y }; dirty(); }
      const fit = $("zoom-fit"); if (fit) fit.disabled = true;
    }
    function zoomAt(f, px, py, ms) {                   // f > 1 zooms in
      const s1 = Math.max(minScale(), Math.min(MAX_SCALE, view.s * f));
      user = true;
      if (px === undefined) { px = W / 2; py = H / 2; }
      const mx = view.cx + (px - W / 2) / view.s, my = view.cy - (py - H / 2) / view.s;
      if (!ms || reduceMotion) { view.s = s1; view.cx = mx - (px - W / 2) / s1; view.cy = my + (py - H / 2) / s1; clampView(); anim = null; dirty(); }
      else { anim = { t0: performance.now(), ms, s0: view.s, s1, keep: { mx, my, px, py } }; dirty(); }
    }
    function panBy(dxPx, dyPx, ms) {                    // dxPx > 0 moves the view right
      user = true;
      const nx = view.cx + dxPx / view.s, ny = view.cy - dyPx / view.s;
      if (!ms || reduceMotion) { view.cx = nx; view.cy = ny; clampView(); anim = null; dirty(); }
      else { anim = { t0: performance.now(), ms, s0: view.s, s1: view.s, x0: view.cx, y0: view.cy, x1: nx, y1: ny }; dirty(); }
    }

    /* ---------- Controls ---------- */
    function setMode(m) {
      mode = m; box.dataset.mode = m; pad.hidden = m !== "buttons";
      ctl.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.m === m)));
      try { localStorage.setItem(LS_CTL, m); } catch (e) {}
    }
    ctl.querySelectorAll("button").forEach(b => scope.on(b, "click", e => { e.stopPropagation(); setMode(b.dataset.m); }));
    const STEP = 0.3;
    pad.querySelectorAll("button").forEach(b => scope.on(b, "click", e => {
      e.stopPropagation(); const d = b.dataset.d;
      panBy(d === "left" ? -W * STEP : d === "right" ? W * STEP : 0, d === "up" ? -H * STEP : d === "down" ? H * STEP : 0, 240);
    }));
    // drag and pinch
    const ptrs = new Map(); let drag = null, pinch = null, dragDist = 0;
    scope.on(box, "pointerdown", e => {
      if (mode !== "drag" || (e.pointerType === "mouse" && e.button !== 0)) return;
      box.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); anim = null; dragDist = 0;
      if (ptrs.size === 1) drag = { x: e.clientX, y: e.clientY }; else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; drag = null; }
      box.classList.add("grabbing");
    });
    scope.on(box, "pointermove", e => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && ptrs.size === 2) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), r = box.getBoundingClientRect();
        if (pinch.d > 0 && d > 0) zoomAt(d / pinch.d, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top); pinch.d = d;
      } else if (drag) { dragDist += Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y); panBy(-(e.clientX - drag.x), -(e.clientY - drag.y)); drag.x = e.clientX; drag.y = e.clientY; }
    });
    const up = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (ptrs.size === 1) { const [p] = [...ptrs.values()]; drag = { x: p[0], y: p[1] }; } else if (!ptrs.size) { drag = null; box.classList.remove("grabbing"); } };
    scope.on(box, "pointerup", up); scope.on(box, "pointercancel", up);
    scope.on(box, "wheel", e => {
      e.preventDefault();
      const r = box.getBoundingClientRect(), k = e.deltaMode === 1 ? 18 : 1, dy = e.deltaY * k;
      zoomAt(Math.exp(-Math.max(-120, Math.min(120, dy)) * (e.ctrlKey ? 0.012 : 0.0022)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    scope.on(box, "click", e => {          // an arrow at the edge: take the map towards that airport
      if (dragDist > 5) return; const r = box.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      tipEl.hidden = true;
      const h = edgeHits.find(q => x >= q[0] && x <= q[0] + q[2] && y >= q[1] && y <= q[1] + q[3]);
      if (!h) {
        const t = LIVE && LIVE.live && LIVE.hit(x, y, toScreenX, toScreenY, Date.now());
        if (t) { const nm = (LINE_NAMES[t.line] || t.line) + (/^rb|cable/.test(t.line) ? "" : " line"), m = t.secs <= 15 ? "now" : t.secs < 90 ? `${t.secs} s` : `${Math.round(t.secs / 60)} min`;
          tipEl.innerHTML = ""; const a = document.createElement("div"), b = document.createElement("div"); a.textContent = `${nm} to ${t.dest || "terminus"}`; b.textContent = `Next: ${t.next} (${m})`; a.style.fontWeight = "600"; tipEl.append(a, b);
          tipEl.style.left = t.x + "px"; tipEl.style.top = t.y + "px"; tipEl.hidden = false; scope.after(() => { tipEl.hidden = true; }, 7000); }
        return;
      }
      user = true; anim = { t0: performance.now(), ms: 600, s0: view.s, s1: view.s, x0: view.cx, y0: view.cy, x1: h[4], y1: h[5] }; dirty();
    });
    scope.on(box, "dblclick", e => { if (mode !== "drag") return; const r = box.getBoundingClientRect(); zoomAt(2, e.clientX - r.left, e.clientY - r.top, 260); });
    scope.on(box, "keydown", e => {
      const big = e.shiftKey ? 0.6 : 0.2, k = e.key;
      if (k === "ArrowLeft") panBy(-W * big, 0, 160); else if (k === "ArrowRight") panBy(W * big, 0, 160); else if (k === "ArrowUp") panBy(0, -H * big, 160); else if (k === "ArrowDown") panBy(0, H * big, 160); else return;
      e.preventDefault();
    });
    scope.on(window, "resize", resize);
    const ro = scope.observe(new ResizeObserver(resize)); ro.observe(wrapEl);
    // follow the page's light or dark theme
    const themeChange = () => { cols = null; dirty(); };          // v3.71: always re-read the drawing colours (a stale light --bg could stay on a dark page)
    const mq = matchMedia("(prefers-color-scheme: dark)"); scope.on(mq, "change", themeChange);
    scope.observe(new MutationObserver(themeChange)).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    setMode(mode);

    // the TfL key form in Prefs works here as on the line pages
    const keyInput = $("key-input"), keyNote = $("key-note");
    try { if (localStorage.getItem("tfl-app-key")) keyInput.value = localStorage.getItem("tfl-app-key"); } catch (e) {}
    scope.on($("key-form"), "submit", e => {
      e.preventDefault(); const v = keyInput.value.trim();
      try { if (v) localStorage.setItem("tfl-app-key", v); else localStorage.removeItem("tfl-app-key"); keyNote.textContent = v ? "Key saved in this browser. Refreshing data now." : "Key removed. The map will use TfL's anonymous limit."; }
      catch (err) { keyNote.textContent = "This browser blocked saving the key, so it will be used for this visit only."; }
      if (LIVE) LIVE.poll();
    });

    /* ---------- Data ---------- */
    loadJS("geo/tiles/meta.js", "UC_TILE_META", m => {
      meta = m; have = m.scales.map((_, z) => new Set((m.tiles[z] || []).map(t => t[0] * 100000 + t[1])));
      for (const k in (m.emptyRoads || {})) emptyRoads[k] = m.scales.map((_, z) => new Set(((m.emptyRoads[k] || {})[z] || []).map(t => t[0] * 100000 + t[1])));
      resize(); dirty();
    }, () => { upEl.textContent = "The map tiles could not be loaded"; upEl.dataset.error = "1"; });
    loadJS("geo/codes.js", "UC_CODES", () => {});
    loadJS("geo/landmarks.js", "UC_LANDMARKS", d => { LM = d; dirty(); });
    loadJS("geo/rail_graph.js", "UC_RAILGRAPH", d => {
      RG = prepRG(d);
      if (window.UndercurrentFullMapLive) { LIVE = window.UndercurrentFullMapLive.create({ scope, graph: d, apiUrl, colour: lineColour, onChange: livePanel }); try { const c = document.querySelector('input[name="lbl"]:checked'); if (c && c.value === "num") show.train = "vid"; } catch (x) {} LIVE.setLabels(show.train); }
      dirty();
    });
    setupLayers(); prepStyle();
    loadJS("geo/stations.js", "UC_STATIONS", d => {
      stations = d.stations.map(s => { const lines = s.lines || [];      // rank: annual entries and exits (millions), more for each extra line; stations with no figure rank by their lines
        return { name: s.name, x: s.x, y: s.y, lines, modes: s.modes || [], rank: (s.u || 0) * (1 + 0.15 * Math.max(0, lines.length - 1)) + lines.length * 0.5 }; }); dirty();
    });

    return {
      zoomCentre(f) { zoomAt(1 / f, undefined, undefined, 220); },   // the shared zoom buttons: f < 1 zooms in
      resetView() { resetView(false); },
      get view() { return view; }
    };
  }

  window.UndercurrentFullMap = { mount };
})();
