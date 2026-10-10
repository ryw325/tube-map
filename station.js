/* Project Undercurrent: station page (v3.24). One station, every arrival and departure.
   Loaded before engine.js; the engine calls UndercurrentStation.mount(STATION, scope, ctx) when the page data has kind "station"
   (lines/station-<id>.js). It uses the same shell as the line pages (left panel, departures board, facts, menu, preferences),
   and everything it starts goes through `scope`, so unmount undoes it all.
   Layout: the station icon sits in the middle; each line is one track that pinches in to run past the station and opens out
   again; every train runs in a lane on its left, so eastbound trains are above their track and westbound trains below.
   v3.33: up to four tracks. Three or four (King's Cross) are stacked straight across the map, each with its own station ring, the rings linked
   like an interchange on the Tube map; the board then shows two tracks at a time and cycles through them. Direction words come from each
   line's data (left is the "W" lane, right the "E" lane; at King's Cross the Northern's northbound runs left and the Victoria's right).
   v3.34: a second layout, Radial. Every track runs straight through one central station ring at its own angle (STN.angles, roughly the real
   direction of the line), the stops-away markers sit on a circle, the fade is round, and each track end is named by its next station. The
   lanes, markers and trains are worked out exactly as for a straight track and then turned by the track's angle, so the train movement is
   the same in both layouts. A switch in the map's top-left corner picks the layout; the choice is remembered on this device. */
(function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const API = "https://api.tfl.gov.uk";
  const POLL_MS = 30000, STATUS_MS = 120000;
  const LANE = 18, SC = 0.78, SPEED = 1.5, TDEC = 8, DWELL = 15;  // lane offset and train size at the default zoom (smaller than the line pages so trains have more track to cover)
  const TRACK_W = 7, MARK_R = 7;                                     // track width and stop-marker radius at the default zoom
  const GAP = 35 * SC + 6;                                           // nose-to-tail spacing in a lane at the default zoom
  const CARRIAGE = "M-12,-7H10L17,0L10,7H-12A6 6 0 0 1 -18,1V-1A6 6 0 0 1 -12,-7Z";
  const STOPS_MIN = 3, STOPS_MAX = 5;   // stops away shown on each side of the station: 3 by default, zooming smoothly out to 5
  const TAU_STOP = 100;       // typical seconds between stops, used only for trains the feed gives no location for
  const TAU_DEP = 60;         // a leaving train crosses the first gap in about this long
  // v3.29: how drawn positions absorb TfL's revisions (in gaps between stops, so they don't depend on the zoom)
  const CATCH_UP = 0.05;      // fastest a train may catch up when TfL brings its arrival forward: a whole gap in 20 s
  const BACK_LIMIT = 1.2;     // a train is never drawn moving backwards unless it is more than this many gaps out of place
  // v3.30: the page reads the per-train line feed (every train's own list of next stops and times), the same source as the line maps
  const SPAWN_S = 1800;       // draw trains up to 30 minutes out, so distant ones come in from the edge rather than appearing mid-screen
  const MISS_POLLS = 4;       // a train missing from this many replies in a row (about 2 minutes) fades out...
  const FADE_MS = 4000;       // ...over this long
  const Q_FWD = 6, Q_BACK = 4;   // drawn-position limits in map units per second, so queuing in a lane is never a jump (zooming is exempt)
  const SHOW_TITLE = false;   // the left panel already carries the station name, as on the line pages

  /* ---------- Geometry ---------- */
  const PINCH = {   // track centre lines, west to east, relative to the station; vertex 3 sits level with the station
    top:    [[-6000,-110],[-70,-110],[-32,-72],[0,-72],[32,-72],[70,-110],[6000,-110]],
    bottom: [[-6000, 110],[-70, 110],[-32, 72],[0, 72],[32, 72],[70, 110],[6000, 110]]
  };
  function offsetPoly(P, d) {
    const n = P.length, segs = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = P[i+1][0] - P[i][0], dy = P[i+1][1] - P[i][1], L = Math.hypot(dx, dy);
      const ux = dx / L, uy = dy / L, nx = uy, ny = -ux;     // left of travel (screen up when heading east)
      segs.push({ p: [P[i][0] + nx * d, P[i][1] + ny * d], u: [ux, uy], n: [nx, ny] });
    }
    const out = [segs[0].p.slice()];
    for (let i = 1; i < n - 1; i++) {
      const a = segs[i-1], b = segs[i], cr = a.u[0] * b.u[1] - a.u[1] * b.u[0];
      if (Math.abs(cr) < 1e-9) { out.push([P[i][0] + a.n[0] * d, P[i][1] + a.n[1] * d]); continue; }
      const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1], t = (dx * b.u[1] - dy * b.u[0]) / cr;
      out.push([a.p[0] + a.u[0] * t, a.p[1] + a.u[1] * t]);
    }
    const l = segs[n-2];
    out.push([P[n-1][0] + l.n[0] * d, P[n-1][1] + l.n[1] * d]);
    return out;
  }
  function mkLane(pts) {
    const cum = [0], ang = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i-1][0], dy = pts[i][1] - pts[i-1][1];
      cum.push(cum[i-1] + Math.hypot(dx, dy)); ang.push(Math.atan2(dy, dx));
    }
    return { pts, cum, ang, total: cum[cum.length-1], s0: cum[3] };
  }
  const wrap = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  function pose(L, s) {
    const d = Math.max(0, Math.min(L.total, s + L.s0));
    let i = 1; while (i < L.cum.length - 1 && L.cum[i] < d) i++;
    const a = L.cum[i-1], b = L.cum[i], u = (d - a) / (b - a), p = L.pts[i-1], q = L.pts[i];
    let ang = L.ang[i-1]; const B = 16, loc = d - a, rem = b - d;
    if (loc < B && i - 1 > 0) ang += wrap(L.ang[i-2] - ang) * 0.5 * (1 - loc / B);
    else if (rem < B && i < L.ang.length) ang += wrap(L.ang[i] - ang) * 0.5 * (1 - rem / B);
    return { x: p[0] + (q[0] - p[0]) * u, y: p[1] + (q[1] - p[1]) * u, ang };
  }
  // distance from the station along the lane (negative before it) for a time to station in seconds: cruise, ease in, dwell, ease out
  function sOf(tts) {
    if (tts >= 0) return -(tts >= TDEC ? SPEED * (tts - TDEC / 2) : SPEED * tts * tts / (2 * TDEC));
    const tau = -tts - DWELL;
    if (tau <= 0) return 0;
    return tau >= TDEC ? SPEED * (tau - TDEC / 2) : SPEED * tau * tau / (2 * TDEC);
  }

  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const clockFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const whenText = sec => sec < 30 ? "due" : (Math.max(1, Math.round(sec / 60)) === 1 ? "1 min" : `${Math.max(1, Math.round(sec / 60))} mins`);

  function mount(STN, scope, ctx) {
    const { svg, panelsApi } = ctx;
    const $ = id => document.getElementById(id);
    const root = document.documentElement;
    const LINES = STN.lines;                                   // { district: { name, short, colour, train }, piccadilly: { ... } }
    const IDS = Object.keys(LINES);
    const CODES = STN.codes || window.UNDERCURRENT_CODES || {};   // v3.32: one shared table (lines/codes.js) for every station
    const reduceMotion = ctx.reduceMotion;
    // v3.33: each line's words for its two directions ("E" = moving right on the page, "W" = moving left) and how its platform names say them
    const DIRS = {};
    IDS.forEach(id => { const d = LINES[id].dirs; DIRS[id] = d ? { E: d.E.label, W: d.W.label, pE: d.E.platform || [], pW: d.W.platform || [] } : { E: "Eastbound", W: "Westbound", pE: ["east"], pW: ["west"] }; });

    /* ---------- Page set-up (same fields as a line page; everything is put back on unmount) ---------- */
    const sw = document.querySelector(".line-title .swatch");
    const dts = document.querySelectorAll(".stats dt");
    const dtOld = [dts[0].textContent, dts[1].textContent];
    document.title = `${STN.name} Station Live`;
    document.querySelector(".eyebrow").textContent = `Live prototype · v${ctx.VERSION}`;
    $("line-name").textContent = STN.name;
    sw.style.background = `linear-gradient(to bottom, ${IDS.map((id, i) => `var(--stn-${i}) ${(i * 100 / IDS.length).toFixed(1)}% ${((i + 1) * 100 / IDS.length).toFixed(1)}%`).join(", ")})`;
    dts[0].textContent = "Trains"; dts[1].textContent = "Lines";
    $("stat-stations").textContent = IDS.length;
    ["stat-trains", "stat-nb", "stat-sb"].forEach(id => { $(id).textContent = "–"; });
    $("dir-n").textContent = "Westbound"; $("dir-s").textContent = "Eastbound";
    const STACKED = (STN.tracks || IDS).length >= 3;          // v3.33: three or more tracks: the last two counts are tracks and platforms
    if (STACKED) { $("dir-n").textContent = "Tracks"; $("dir-s").textContent = "Platforms"; }
    const pill = $("status-pill"), reasonEl = $("status-reason"), upEl = $("updated");
    pill.textContent = "Checking line status"; pill.dataset.level = "unknown"; reasonEl.hidden = true;
    upEl.textContent = "Connecting to TfL…"; delete upEl.dataset.error;
    svg.setAttribute("aria-label", `Live schematic of ${STN.name} station showing each train`);
    $("facts").setAttribute("aria-label", `${STN.name} station facts`);
    root.classList.add("stn-page");
    const vars = t => IDS.map((id, i) => `--stn-${i}: ${LINES[id].colour[t]}; --stn-t${i}: ${LINES[id].train[t]};`).join(" ") + ` --line: ${t === "dark" ? "#E6EAED" : "#23272B"};`;
    ctx.lineStyle.textContent = `:root { ${vars("light")} }
      @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${vars("dark")} } }
      :root[data-theme="dark"] { ${vars("dark")} }`;
    ctx.tickPicker(null);
    scope.later(() => {
      sw.style.background = ""; dts[0].textContent = dtOld[0]; dts[1].textContent = dtOld[1];
      root.classList.remove("stn-page");
    });

    /* ---------- Scene ---------- */
    const el = (tag, attrs, parent) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); (parent || svg).appendChild(n); return n; };
    const defs = el("defs", {});
    const grad = el("linearGradient", { id: "stn-fg", x1: 0, y1: 0, x2: 1, y2: 0 }, defs);
    const fadeStops = [[0, "#000"], [0.2, "#fff"], [0.8, "#fff"], [1, "#000"]].map(([o, c]) => el("stop", { offset: o, "stop-color": c }, grad));
    const rgrad = el("radialGradient", { id: "stn-rg", gradientUnits: "userSpaceOnUse", cx: 0, cy: 0, r: 280 }, defs);   // v3.34: the radial layout's round fade
    const rStops = [[0, "#fff"], [0.8, "#fff"], [1, "#000"]].map(([o, c]) => el("stop", { offset: o, "stop-color": c }, rgrad));
    const mask = el("mask", { id: "stn-fade", maskUnits: "userSpaceOnUse", x: -6000, y: -6000, width: 12000, height: 12000 }, defs);
    const maskRect = el("rect", { fill: "url(#stn-fg)" }, mask);
    const scene = el("g", { class: "stn-scene" });
    const fadeG = el("g", { mask: "url(#stn-fade)" }, scene);
    const poly = a => a.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    /* v3.32: tracks. Lines that share rails share one track, drawn as a ribbon of thin stripes (one per line, as on the TfL map), and their trains
       share its lanes. STN.tracks lists the groups (default: one track per line). Two tracks pinch round the station, one above and one below;
       a single track runs straight through the station and its lanes bow out round the station icon */
    const GROUPS = (STN.tracks || IDS.map(id => [id])).map(g => g.filter(id => LINES[id])).filter(g => g.length).slice(0, 4);
    const GK = GROUPS.map(g => g.join("+")), GROUP_OF = {};
    GROUPS.forEach((g, i) => g.forEach(id => { GROUP_OF[id] = GK[i]; }));
    const NG = GROUPS.length, ONE = NG === 1, STACK = NG >= 3;
    // a track's direction words: its lines' own when they agree, otherwise west and east (Circle says clockwise where H&C says eastbound)
    const GWORDS = GROUPS.map(g => { const a = g.map(id => DIRS[id]); return a.every(x => x.E === a[0].E && x.W === a[0].W) ? { E: a[0].E, W: a[0].W } : { E: "Eastbound", W: "Westbound" }; });
    // v3.34: layout. Radial turns each track by its angle (degrees clockwise from pointing right; the right-hand end is the one "W" trains come from)
    let RADIAL = false;
    try { RADIAL = localStorage.getItem("uc-stn-layout") === "radial"; } catch (e) {}
    const ANG = GROUPS.map((g, i) => { const a = (STN.angles || [])[i]; return (typeof a === "number" ? a : NG === 1 ? -12 : -60 + i * 120 / (NG - 1)) * Math.PI / 180; });
    const ROT = {};                                            // per track: its turn in the layout on screen (0 in Linear)
    const rp = (k, x, y) => { const a = ROT[k]; if (!a) return [x, y]; const c = Math.cos(a), sn = Math.sin(a); return [x * c - y * sn, x * sn + y * c]; };
    const BASE = {};
    let SP = 130, OFF = 0;                                     // stacked tracks: the distance between them and the stack's shift up or down (fitted in layout())
    const stackY = i => OFF + (i - (NG - 1) / 2) * SP;
    function setBase() {
      GK.forEach((k, i) => { ROT[k] = RADIAL ? ANG[i] : 0; });
      if (ONE || RADIAL) GK.forEach(k => { BASE[k] = [[-6000, 0], [6000, 0]]; });
      else if (STACK) GK.forEach((k, i) => { BASE[k] = [[-6000, stackY(i)], [6000, stackY(i)]]; });
      else { BASE[GK[0]] = PINCH.top; BASE[GK[1]] = PINCH.bottom; }
    }
    setBase();
    const LANES = {}, TRACKS = [];
    const laneOf = t => LANES[GROUP_OF[t.line] + t.dir];
    GROUPS.forEach((g, gi) => {
      const n = g.length, w = TRACK_W * (n > 1 ? 1.75 : 1) / n;
      g.forEach((id, j) => TRACKS.push({ el: el("polyline", { class: "stn-track c" + IDS.indexOf(id) }, fadeG), k: GK[gi], off: (j - (n - 1) / 2) * w, w: w + (n > 1 ? 0.3 : 0) }));
    });
    /* zoom: z is how many stops away fit on each side. 3 by default, smoothly out to 5. As z grows the stop markers close up, the next one slides
       in from the fade, and trains, markers, track and lanes all shrink by zf */
    let z = STOPS_MIN, zTarget = STOPS_MIN, zf = 1;
    const zScale = v => Math.pow(STOPS_MIN / v, 0.75);
    function buildLanes() {
      GK.forEach(k => {
        let E, W;
        if (ONE || STACK || RADIAL) {                            // straight track: lanes bow out round the station icon (vertex 3 is level with the station)
          const L = LANE * zf, H = Math.max(0, (RADIAL ? 44 : 36) - L), B = RADIAL ? 34 : 26, y0 = BASE[k][0][1];
          E = [[-6000, -L], [-(B + H), -L], [-B, -L - H], [0, -L - H], [B, -L - H], [B + H, -L], [6000, -L]].map(p => [p[0], p[1] + y0]);
          W = [[6000, L], [B + H, L], [B, L + H], [0, L + H], [-B, L + H], [-(B + H), L], [-6000, L]].map(p => [p[0], p[1] + y0]);
        } else { E = offsetPoly(BASE[k], LANE * zf); W = offsetPoly(BASE[k].slice().reverse(), LANE * zf); }
        LANES[k + "E"] = Object.assign(LANES[k + "E"] || {}, mkLane(E));
        LANES[k + "W"] = Object.assign(LANES[k + "W"] || {}, mkLane(W));
      });
      TRACKS.forEach(t => { t.el.setAttribute("points", poly((t.off ? offsetPoly(BASE[t.k], t.off * zf) : BASE[t.k]).map(p => rp(t.k, p[0], p[1])))); t.el.style.strokeWidth = (t.w * zf).toFixed(2); });
    }
    buildLanes();
    /* stops-away markers: a small station-style circle with the number, on the track, on the side trains approach from (west for eastbound, east for westbound) */
    // stacked tracks: the rings are linked by a bar, as interchanges are on the Tube map (under the trains, so one at a platform stays visible)
    const link = STACK ? [el("line", { class: "stn-link", x1: 0, x2: 0 }, fadeG), el("line", { class: "stn-link-core", x1: 0, x2: 0 }, fadeG)] : [];
    const layerM = el("g", { class: "stn-marks", "aria-hidden": "true" }, fadeG);
    const MARKS = {};
    GK.forEach(id => ["E", "W"].forEach(dir => {
      MARKS[id + dir] = [];
      for (let k = 1; k <= STOPS_MAX; k++) {
        const g = el("g", { class: "stn-mark", "data-line": id, "data-dir": dir, "data-k": k }, layerM);
        el("circle", { r: MARK_R }, g);
        const tx = el("text", {}, g); tx.textContent = String(k);
        MARKS[id + dir].push({ g, tx, k });
      }
    }));
    const layerT = el("g", {}, fadeG);
    const rings = (STACK ? GK : [0]).map(() => el("circle", { class: "stn-station", cx: 0, cy: 0, r: 18 }, scene));
    const radRing = el("circle", { class: "stn-station", cx: 0, cy: 0, r: 26 }, scene);   // v3.34: Radial has one bigger ring where every track meets
    const titleEl = SHOW_TITLE ? el("text", { class: "stn-title", "text-anchor": "middle" }, scene) : null;
    if (titleEl) titleEl.textContent = STN.name;
    const dirEls = [];
    GROUPS.forEach((g, i) => {
      const cls = "stn-dir " + (g.length > 1 ? "cx" : "c" + IDS.indexOf(g[0]));   // a shared track's labels are in ink
      const yW = ONE ? 74 : i === 0 ? -62 : 72, yE = ONE ? -62 : yW;            // one track: eastbound label above it, westbound below
      const w = el("text", { class: cls, y: yW }, scene); w.textContent = "← " + GWORDS[i].W;
      const e = el("text", { class: cls, y: yE, "text-anchor": "end" }, scene); e.textContent = GWORDS[i].E + " →";
      dirEls.push([w, e]);
    });
    // v3.34: Radial names each track end by its next station (from the approach lists; stations a line runs through are skipped)
    const nextStop = (g, d) => {
      for (const id of g) for (const seq of ((LINES[id].approach || {})[d] || [])) {
        const skip = new Set((LINES[id].skip || []).map(x => x.toLowerCase()));
        for (let j = seq.length - 2; j >= 0; j--) if (!skip.has(seq[j].toLowerCase())) return seq[j];
      }
      return "";
    };
    const endEls = GROUPS.map((g, i) => {
      const cls = "stn-dir stn-end " + (g.length > 1 ? "cx" : "c" + IDS.indexOf(g[0]));
      return [nextStop(g, "E"), nextStop(g, "W")].map(name => {
        const t = el("text", { class: cls }, scene);
        if (name.length > 14 && name.includes(" & ")) {          // long names with an "&" go on two lines
          name.split(" & ").forEach((part, j) => { const sp = el("tspan", { dy: j ? "1.15em" : 0 }, t); sp.textContent = j ? part : part + " &"; });
        } else t.textContent = name;
        return t;
      });
    });
    /* v3.34: the layout switch, in the map's top-left corner (the zoom buttons have the bottom right). Station pages only; removed on unmount */
    const layoutCtl = document.createElement("div");
    layoutCtl.className = "stn-layout"; layoutCtl.setAttribute("role", "group"); layoutCtl.setAttribute("aria-label", "Map layout");
    layoutCtl.innerHTML = `<button type="button" data-l="linear" title="Linear layout" aria-label="Linear layout"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/><rect x="9.5" y="3.5" width="5" height="17" rx="2.5" fill="var(--pill-bg)"/></svg><span>Linear</span></button>`
      + `<button type="button" data-l="radial" title="Radial layout" aria-label="Radial layout"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg><span>Radial</span></button>`;
    $("map-wrap").appendChild(layoutCtl);
    scope.later(() => layoutCtl.remove());
    const markCtl = () => layoutCtl.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String((b.dataset.l === "radial") === RADIAL)));
    function setLayout(radial) {
      if (RADIAL === radial) return;
      RADIAL = radial; markCtl();
      try { localStorage.setItem("uc-stn-layout", radial ? "radial" : "linear"); } catch (e) {}
      layout();
    }
    layoutCtl.querySelectorAll("button").forEach(b => scope.on(b, "click", e => { e.stopPropagation(); setLayout(b.dataset.l === "radial"); }));
    markCtl();
    let VW = 800, VH = 480;
    function layout() {
      const r = svg.getBoundingClientRect(), w = r.width || 800, h = r.height || 480, a = w / h;
      VW = Math.max(560, 480 * a); VH = VW / a;
      const cx = VW / 2, cy = VH / 2;
      svg.setAttribute("viewBox", `0 0 ${VW.toFixed(1)} ${VH.toFixed(1)}`);
      scene.setAttribute("transform", `translate(${cx.toFixed(1)},${cy.toFixed(1)})`);
      maskRect.setAttribute("x", -cx); maskRect.setAttribute("y", -cy); maskRect.setAttribute("width", VW); maskRect.setAttribute("height", VH);
      if (titleEl) { titleEl.setAttribute("x", 0); titleEl.setAttribute("y", 54 - cy); }
      setBase();
      if (STACK && !RADIAL) placeStack(); else buildLanes();
      dirEls.forEach(([we, ee]) => { we.setAttribute("x", -cx + 24); ee.setAttribute("x", cx - 24); });
      // what each layout shows
      const show = (n, on) => on ? n.removeAttribute("display") : n.setAttribute("display", "none");
      rings.forEach(r => show(r, !RADIAL)); link.forEach(l => show(l, !RADIAL)); show(radRing, RADIAL);
      dirEls.forEach(pair => pair.forEach(n => show(n, !RADIAL))); endEls.forEach(pair => pair.forEach(n => show(n, RADIAL)));
      maskRect.setAttribute("fill", RADIAL ? "url(#stn-rg)" : "url(#stn-fg)");
      placeMarks(); if (RADIAL) placeEnds(); snapUntil = performance.now() + 250;
    }
    // stacked tracks: spread them over the height of the map (at most 130 apart), then place the rings, the link and each track's labels:
    // "← W" under the track on the left, "E →" above it on the right, clear of the trains (which run above the track on the left, below on the right)
    // The stack stays centred unless that would put the last track's right-hand label under the zoom buttons (phones), when it moves up and closes up
    function placeStack() {
      const r = svg.getBoundingClientRect(), zc = document.querySelector(".zoom-ctl"), k = r.height ? VH / r.height : 1;
      const zr = zc && zc.offsetParent ? zc.getBoundingClientRect() : null;
      const ctlTop = zr && zr.height ? (zr.top - r.top) * k : VH;   // top of the zoom buttons, in map units from the top
      const tg = layoutCtl.getBoundingClientRect(), tgBottom = tg.height ? (tg.bottom - r.top) * k : 0;   // keep clear of the layout switch too
      const top = Math.max(54, tgBottom + 40) - VH / 2, bottom = Math.min(ctlTop - 30, VH - 56) - VH / 2;   // where the first and last tracks may go (from the centre)
      SP = Math.max(70, Math.min(130, (bottom - top) / (NG - 1)));
      const half = (NG - 1) / 2 * SP;
      OFF = 0; if (half > bottom) OFF = bottom - half; if (OFF - half < top) OFF = top + half;
      GK.forEach((k, i) => { BASE[k] = [[-6000, stackY(i)], [6000, stackY(i)]]; });
      buildLanes();
      rings.forEach((r, i) => r.setAttribute("cy", stackY(i).toFixed(1)));
      link.forEach(l => { l.setAttribute("y1", stackY(0).toFixed(1)); l.setAttribute("y2", stackY(NG - 1).toFixed(1)); });
      dirEls.forEach(([we, ee], i) => { we.setAttribute("y", (stackY(i) + 46).toFixed(1)); ee.setAttribute("y", (stackY(i) - 34).toFixed(1)); });
    }
    // marker 1 sits just past the pinch (X1) and marker z at XK, 72% of the way to the screen edge, so zooming out closes the markers up and the next
    // one slides in from the fade (fading in as it arrives). The fade starts just after XK and ends at the edge, whatever the width of the screen.
    // Each lane keeps D[k], its distance along the lane to marker k
    // Radial: the same, measured along each track from the centre, with RAD (half the shorter side of the map) in place of the half-width, so the
    // markers sit on circles and the fade is a ring
    let XK = 200, RAD = 280;
    function placeMarks() {
      const cx = VW / 2, X1 = RADIAL ? 92 : 86;
      RAD = Math.min(VW, VH) / 2; XK = (RADIAL ? RAD : cx) * 0.72;
      const step = (XK - X1) / (z - 1);
      const f0 = Math.max(0.02, Math.min(0.45, (cx - (XK + 14)) / VW));
      fadeStops[1].setAttribute("offset", f0.toFixed(4)); fadeStops[2].setAttribute("offset", (1 - f0).toFixed(4));
      rgrad.setAttribute("r", RAD.toFixed(1)); rStops[1].setAttribute("offset", Math.min(0.95, (XK + 14) / RAD).toFixed(4));
      GK.forEach(id => ["E", "W"].forEach(dir => {
        const L = LANES[id + dir], sign = dir === "E" ? -1 : 1, yT = BASE[id][0][1];
        L.D = [0];
        MARKS[id + dir].forEach(m => {
          const x = X1 + (m.k - 1) * step;
          let lo = -3000, hi = 0;                                // distance along the lane where the lane is level with x
          for (let it = 0; it < 32; it++) { const mid = (lo + hi) / 2; if (Math.abs(pose(L, mid).x) > x) lo = mid; else hi = mid; }
          L.D.push(-(lo + hi) / 2);
          const op = Math.max(0, Math.min(1, z - (m.k - 1)));   // marker k fades in as z goes from k - 1 to k
          if (op <= 0.001) { m.g.setAttribute("display", "none"); return; }
          m.g.removeAttribute("display"); m.g.setAttribute("opacity", op.toFixed(3));
          const [mx, my] = rp(id, sign * x, yT);
          m.g.setAttribute("transform", `translate(${mx.toFixed(1)},${my.toFixed(1)}) scale(${zf.toFixed(3)})`);
        });
      }));
    }
    // Radial end labels: just past the last marker, on whichever side of the track has more room before the next track round, reading away from the
    // track, then nudged back inside the map and off the zoom buttons and the layout switch if they would sit under them
    function placeEnds() {
      const dirs = [];                                         // screen direction of every track end
      GK.forEach((k, i) => { dirs.push(ANG[i], ANG[i] + Math.PI); });
      const norm = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const sr = svg.getBoundingClientRect(), kk = sr.height ? VH / sr.height : 1;
      const avoid = [document.querySelector(".zoom-ctl"), layoutCtl].filter(n => n && n.offsetParent).map(n => n.getBoundingClientRect()).filter(r => r.width);
      endEls.forEach((pair, i) => pair.forEach((t, j) => {
        const sgn = j ? 1 : -1, th = norm(ANG[i] + (j ? 0 : Math.PI));
        let cw = 7, ccw = 7;                                    // gaps (radians) to the nearest other track end, clockwise and anticlockwise
        dirs.forEach(d => { const g = norm(d - th); if (g > 1e-6) cw = Math.min(cw, g); const h = norm(th - d); if (h > 1e-6) ccw = Math.min(ccw, h); });
        // local +y is clockwise of a right-hand end and anticlockwise of a left-hand end
        let side = Math.abs(cw - ccw) < 0.05 ? (j ? -1 : 1) : (cw > ccw ? 1 : -1) * sgn;
        const [x, y] = rp(GK[i], sgn * (XK + 18), side * 24);
        const nx = -Math.sin(ANG[i]) * side;                    // which way the label sits from the track, across the screen
        const anchor = nx > 0.35 ? "start" : nx < -0.35 ? "end" : x < -30 ? "end" : x > 30 ? "start" : "middle";
        const lines = t.querySelectorAll("tspan").length || 1, y0 = y + 5 - (lines - 1) * 8 * (side * Math.cos(ANG[i]) < 0 ? 1 : 0);
        const put = (px, py) => { t.setAttribute("x", px.toFixed(1)); t.setAttribute("y", py.toFixed(1)); t.querySelectorAll("tspan").forEach(sp => sp.setAttribute("x", px.toFixed(1))); };
        t.setAttribute("text-anchor", anchor); put(x, y0);
        let b = null; try { b = t.getBBox(); } catch (e) {}
        if (!b || !b.width) return;
        const lim = VW / 2 - 10, limY = VH / 2 - 8;
        let dx = 0, dy = 0;
        if (b.x + b.width > lim) dx = lim - (b.x + b.width); else if (b.x < -lim) dx = -lim - b.x;
        if (b.y + b.height > limY) dy = limY - (b.y + b.height); else if (b.y < -limY) dy = -limY - b.y;
        if (dx || dy) put(x + dx, y0 + dy);
        const r = t.getBoundingClientRect();
        for (const c of avoid) {
          if (r.right < c.left - 4 || c.right + 4 < r.left || r.bottom < c.top - 4 || c.bottom + 4 < r.top) continue;
          const up = (r.bottom - c.top + 6) * kk, down = (c.bottom - r.top + 6) * kk;   // move the shorter way out of its way
          put(x + dx, y0 + dy + (c.top > sr.top + sr.height / 2 ? -up : down));
        }
      }));
    }
    let snapUntil = 0;                                       // while zooming or resizing, drawn positions jump straight to where they belong
    function applyZoom() { zf = zScale(z); buildLanes(); placeMarks(); snapUntil = performance.now() + 250; }
    const zoomFit = document.getElementById("zoom-fit");
    function zoomTo(v) {
      zTarget = Math.max(STOPS_MIN, Math.min(STOPS_MAX, v));
      if (zoomFit) zoomFit.disabled = zTarget <= STOPS_MIN + 0.01;
      const zo = document.getElementById("zoom-out"), zi = document.getElementById("zoom-in");
      if (zo) zo.disabled = zTarget >= STOPS_MAX - 0.01; if (zi) zi.disabled = zTarget <= STOPS_MIN + 0.01;
      if (reduceMotion) { z = zTarget; applyZoom(); }
    }
    function zoomStep(dz) { zoomTo(Math.round(zTarget) + dz); }
    function zoomTick(dt) {                                    // called every frame: ease z towards its target
      if (z === zTarget) return;
      z += (zTarget - z) * (1 - Math.exp(-dt / 0.16));
      if (Math.abs(zTarget - z) < 0.002) z = zTarget;
      applyZoom();
    }
    scope.on(svg, "wheel", e => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomTo(zTarget * Math.exp(d * (e.ctrlKey ? 0.01 : 0.0015)));   // ctrlKey = trackpad pinch
    });
    scope.on(svg, "dblclick", () => zoomTo(STOPS_MIN));
    zoomTo(STOPS_MIN);
    scope.later(() => { const zo = document.getElementById("zoom-out"), zi = document.getElementById("zoom-in"); if (zo) zo.disabled = false; if (zi) zi.disabled = false; });
    // position along a lane, before the station, for q stops out (q may be fractional, and beyond the last marker it carries on at the same spacing)
    function qToD(L, q) {
      const D = L.D || [0, 60], K = D.length - 1;
      if (q <= 0) return 0;
      if (q >= K) return D[K] + (q - K) * (D[K] - D[K - 1]);
      const k = Math.floor(q); return D[k] + (D[k + 1] - D[k]) * (q - k);
    }
    scope.observe(new ResizeObserver(layout)).observe($("map-wrap"));
    layout();

    /* ---------- Trains ---------- */
    const trains = new Map();
    let board = [];                                            // every prediction for the board: { line, dir, dest, destName, eta, vid, platform }
    let lastOk = 0, fetchError = null, everLoaded = false;
    const lineIdx = id => IDS.indexOf(id);
    const codeOf = name => {
      name = (name || "").replace(/ Underground Station$/, "").trim();
      return CODES[name] || CODES[name.replace(/ \(.*\)$/, "")] || name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "???";
    };
    const nameOf = name => (name || "").replace(/ Underground Station$/, "").replace(/ \([^)]*Line\)$/, "").trim();   // drops a "(Dist&Picc Line)" style suffix
    const WEST = new RegExp(STN.westWords || "$^", "i");
    const LWEST = {}; IDS.forEach(id => { if (LINES[id].westWords) LWEST[id] = new RegExp(LINES[id].westWords, "i"); });
    // fallback for a train the feed lists with this station alone: the platform's direction word, then the destination
    function dirOf(a) {
      const p = (a.platformName || "").toLowerCase(), D = DIRS[a.lineId] || DIRS[IDS[0]];
      if (D.pE.some(w => p.includes(w))) return "E";
      if (D.pW.some(w => p.includes(w))) return "W";
      return (LWEST[a.lineId] || WEST).test(a.destinationName || "") ? "W" : "E";
    }
    function makeTrain(o) {
      const g = el("g", { class: "train stn-t" + lineIdx(o.line), tabindex: "0", role: "button" }, layerT);
      el("path", { class: "train-body", d: CARRIAGE }, g);
      const txt = el("text", { class: "train-num", x: 0, y: 0, "text-anchor": "middle", "dominant-baseline": "central" }, g);
      g.addEventListener("click", e => { e.stopPropagation(); openTrain(t); });
      g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTrain(t); } });
      const t = { key: o.key, line: o.line, dir: o.dir, g, txt, vid: o.vid, dest: o.dest, missed: 0 };
      return t;
    }
    function upsert(o, now) {
      const tts = (o.eta - now) / 1000;
      let t = trains.get(o.key);
      if (!t) {
        if (tts > SPAWN_S || tts < -DWELL - 60) return;
        t = makeTrain(o); t.eta = t.deta = o.eta; t.born = now; trains.set(o.key, t);
      } else {
        const cur = (t.deta - now) / 1000;
        if (cur < 0 && tts > 90) { t.eta = t.deta = o.eta; t.born = now; t.fadeAt = 0; t.qs = undefined; t.gap = null; }      // same vehicle, new trip
        else if (cur >= 0) t.eta = o.eta;
        t.dest = o.dest;
      }
      if (o.plan) firstGap(t, o.plan, o.loc, now);
      t.seen = now; t.loc = o.loc; t.plan = o.plan || null; t.n = o.plan ? o.plan.length : null; if (o.calls) t.calls = o.calls;
      if (t.fadeAt && now - t.fadeAt < FADE_MS) t.fadeAt = 0;          // back in the feed before it had gone: carry on
      const si = stopInfo({ line: o.line, dir: o.dir, loc: o.loc }), g = t.gap;
      if (!si) t.gap = null;
      else if (!g || g.n !== si.n || g.at !== si.at) {
        // a new gap: it runs from marker n to marker n - 1. Entered from its far marker (just left a stop, or passed one) the train starts at
        // the marker; first seen part-way through, it starts in the middle (or near the end when "approaching")
        // (v3.29: first seen part-way through, it starts where its time to Hammersmith puts it, not at a fixed point, so two trains in one
        // gap with very different times don't start on top of each other)
        const fromMarker = !!g && (g.at || g.n > si.n);
        let f0 = 1;
        if (!fromMarker) { f0 = Math.max(0.05, Math.min(1, gF(tts) / TAU_STOP - (si.n - 1))); if (si.approach) f0 = Math.min(f0, 0.35); }
        t.gap = { n: si.n, at: si.at, e0: tts, e1: tts * Math.max(0, si.n - 1) / Math.max(1, si.n), f0 };
      }
    }
    // The feed has no time for the stop a train has just left, so when its first gap changes, work out when it left: just now if it has just
    // passed a stop; at a typical gap's length before its next stop if TfL says it is standing "At" that stop; otherwise (first seen on the
    // move) as if it is 40% of the way through the gap, or a typical gap's length, whichever is longer
    // "At <this station>" or "At Platform": the train is at this station's platform
    function atHere(loc) { const m = /^at\s+(.+)$/i.exec(loc || ""); return !!m && (/^platform/i.test(m[1]) || nrm(m[1]).startsWith(nrm(STN.name))); }
    function firstGap(t, plan, loc, now) {
      const key = plan.length + "|" + plan[0].name;
      if (t.planKey === key) return;
      const prev = t.planKey; t.planKey = key; t.dep0At = false;
      const left = Math.max(0, (plan[0].eta - now) / 1000), gaps = [];
      for (let i = 1; i < plan.length; i++) gaps.push((plan[i].eta - plan[i - 1].eta) / 1000);
      const typ = Math.max(30, Math.min(150, 0.8 * (gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : TAU_STOP)));
      if (prev && +prev.split("|")[0] === plan.length + 1) t.dep0 = now;
      else if (/^at\s/i.test(loc || "") && !atHere(loc)) { t.dep0 = plan[0].eta - Math.min(left, typ) * 1000; t.dep0At = true; }
      else t.dep0 = now - (Math.max(left / 0.6, typ) - left) * 1000;
    }
    function dropTrain(t) { if (sel === t) clearSel(); t.g.remove(); trains.delete(t.key); }
    let lastFrame = performance.now();
    // how many stops out a train is (fractional). The feed's location picks the gap; inside it the train moves steadily from the far marker to
    // the near one over the time it should take (its time to Hammersmith shared evenly over the stops left), easing in to the platform
    const gF = e => e <= 0 ? 0 : e >= TDEC ? e - TDEC / 2 : e * e / (2 * TDEC);
    // v3.30: with the train's own stop list, marker m (m stops out) is due at the predicted time of that stop; the train waits there for a
    // short dwell, then runs to the next marker by that stop's predicted time. Only a train TfL lists with Hammersmith alone falls back to
    // the location text (below)
    function planQ(t, now) {
      const P = t.plan, n = P.length;
      const T = m => P[n - 1 - m].eta;                          // marker m's predicted arrival (marker 0 is Hammersmith)
      const gaps = []; for (let m = 1; m < n; m++) gaps.push((T(m - 1) - T(m)) / 1000);
      const typ = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : TAU_STOP;
      t.atStop = false;
      for (let m = n; m >= 1; m--) {
        const arrNext = T(m - 1);
        if (now >= arrNext) continue;
        const dwell = m < n ? Math.min(20000, 0.25 * (arrNext - T(m))) : 0;
        const dep = m < n ? T(m) + dwell : (t.dep0 || arrNext - Math.max(30, Math.min(150, typ * 0.8)) * 1000);   // first gap: see firstGap()
        if (now <= dep) { t.atStop = m < n ? now >= T(m) : !!t.dep0At; return m; }
        const left = (arrNext - now) / 1000, span = (arrNext - dep) / 1000;
        const f = m === 1 ? gF(left) / Math.max(1, gF(span)) : left / Math.max(1, span);
        return m - 1 + Math.max(0, Math.min(1, f));
      }
      return 0;
    }
    function qOf(t) {
      if (t.plan && (t.plan.length > 1 || !t.gap || t.gap.n <= 1)) return planQ(t, Date.now());
      const g = t.gap, e = t.tts;
      if (!g) return gF(e) / TAU_STOP;                           // no location: time alone
      if (g.n <= 0) return 0;
      if (g.at) return g.n;                                      // standing at a stop
      const span = gF(g.e0) - gF(g.e1);
      const f = span > 0.5 ? g.f0 * (gF(e) - gF(g.e1)) / span : 0;
      return g.n - 1 + Math.max(0, Math.min(1, f));
    }
    // where a train is drawn: its position along its lane, turned by its track's angle (lx is the distance along the track, for the edge checks)
    function screenPose(t) {
      const k = GROUP_OF[t.line], p = pose(laneOf(t), t.s), [x, y] = rp(k, p.x, p.y);
      return { x, y, ang: p.ang + (ROT[k] || 0), lx: p.x };
    }
    function frame(ts) {
      const dt = Math.min(0.25, (ts - lastFrame) / 1000); lastFrame = ts;
      zoomTick(dt);
      const now = Date.now(), half = RADIAL ? Math.hypot(VW, VH) / 2 + 70 : VW / 2 + 70;
      const byLane = {};
      for (const t of trains.values()) {
        t.deta = t.eta;                                          // the drawn position (below) does the smoothing now
        t.tts = (t.deta - now) / 1000;
        const L = laneOf(t);
        // where the train should be, in gaps out from the station (negative once it has left)
        const tq = t.tts < 0 ? -sOf(t.tts) / (SPEED * TAU_DEP) : qOf(t);
        if (t.qs === undefined) t.qs = tq;
        else {
          const d = tq - t.qs;
          if (d < 0) {                                           // forwards: ease towards it, but never faster than CATCH_UP (faster once at or past the platform)
            const cap = (t.tts < 0 ? 4 : 1) * CATCH_UP * dt;
            t.qs -= Math.min(cap, -d * (1 - Math.exp(-dt / 1.5)) + 0.004 * dt);
            if (t.qs < tq) t.qs = tq;
          } else if (d > BACK_LIMIT) t.qs += Math.min(d, CATCH_UP * dt);   // badly out of place: drift back slowly
          // otherwise TfL has pushed the arrival later: hold still until the train's time catches up
        }
        t.s = t.qs >= 0 ? -qToD(L, t.qs) : -t.qs * qToD(L, 1);
        const lk = GROUP_OF[t.line] + t.dir; (byLane[lk] = byLane[lk] || []).push(t);
      }
      for (const k in byLane) {                                // trains in one lane keep their arrival order and queue nose to tail (v3.29: ordered by arrival time, so they never swap)
        const L = byLane[k].sort((a, b) => a.tts - b.tts);
        const gap = GAP * zf;
        for (let i = 1; i < L.length; i++) if (L[i].s > L[i-1].s - gap) L[i].s = L[i-1].s - gap;
        // v3.30: the drawn position follows within speed limits, so a train held up behind another slows to a stop rather than being shoved back,
        // and pulls away smoothly when the one in front moves on or leaves (zooming and resizing move everything at once)
        const snap = performance.now() < snapUntil;
        for (const t of L) {
          if (t.sd === undefined || snap) { t.sd = t.s; continue; }
          const d = t.s - t.sd;
          t.sd += d > 0 ? Math.min(d, Q_FWD * zf * dt) : Math.max(d, -Q_BACK * zf * dt);
          t.s = t.sd;
        }
      }
      const mode = (document.querySelector('input[name="lbl"]:checked') || { value: "dest" }).value;
      for (const t of Array.from(trains.values())) {
        const p = screenPose(t);
        if ((t.tts < 0 && Math.abs(p.lx) > half) || (t.fadeAt && now - t.fadeAt > FADE_MS)) { dropTrain(t); continue; }
        let op = Math.min(1, (now - t.born) / 1000);
        if (t.fadeAt) op = Math.min(op, Math.max(0, 1 - (now - t.fadeAt) / FADE_MS));
        const o = Math.abs(p.lx) < half + 60 ? op.toFixed(2) : "0";
        const deg = p.ang * 180 / Math.PI, a = ((deg % 360) + 360) % 360, flip = a > 90 && a < 270;   // label turns with the train and is never upside down, as on the line pages
        t.g.setAttribute("transform", `translate(${p.x.toFixed(1)},${p.y.toFixed(1)}) rotate(${deg.toFixed(1)}) scale(${(SC * zf).toFixed(3)})`);
        t.g.setAttribute("opacity", o); t.op = +o;
        if (t.flip !== flip) { t.txt.setAttribute("transform", flip ? "translate(-1 0) rotate(180)" : "translate(-1 0)"); t.flip = flip; }
        const lab = mode === "num" ? String(t.vid || "").slice(-3) : codeOf(t.dest);
        if (t.lab !== lab) { t.txt.textContent = lab; t.lab = lab; }
      }
      scope.frame(frame);
    }

    /* ---------- Live data ---------- */
    function apiUrl(path) {
      let key = "";
      try { key = localStorage.getItem("tfl-app-key") || ""; } catch (e) {}
      return API + path + (key ? (path.includes("?") ? "&" : "?") + "app_key=" + encodeURIComponent(key) : "");
    }
    // v3.30: the line feed lists every train's next stops. Group the predictions by train; a train whose list includes Hammersmith is on its
    // way here, and the stops before Hammersmith (in time order) are the stops it still makes. TfL only predicts stops a train calls at, so
    // stations it runs through never count. Its whole list is also its calling points for the board.
    let SIDE = null;                                           // station name -> side of Hammersmith it lies on, per line, from the approach lists (built on first use)
    function buildSide() { SIDE = {}; IDS.forEach(id => { SIDE[id] = {}; ["E", "W"].forEach(d => (APPROACH[id][d] || []).forEach(q => q.forEach(n => { if (n !== nrm(STN.name)) SIDE[id][n] = d; }))); }); }
    const blankVid = v => !v || /^0+$/.test(v);
    function ingest(data) {
      const now = Date.now(), list = [], groups = new Map();
      if (!SIDE) buildSide();
      for (const a of data) {
        if (!LINES[a.lineId]) continue;
        const eta = Date.parse(a.expectedArrival);
        if (!isFinite(eta)) continue;
        const here = a.naptanId === STN.naptan;
        // trains TfL gives no vehicle number can't be grouped safely: each Hammersmith prediction stands alone
        const k = a.lineId + "|" + (blankVid(a.vehicleId) ? (here ? "x" + a.vehicleId + a.destinationName + a.platformName : null) : a.vehicleId);
        if (k.endsWith("|null")) continue;
        (groups.get(k) || groups.set(k, []).get(k)).push({ a, eta, here, name: nameOf(a.stationName), nap: a.naptanId });
      }
      for (const preds of groups.values()) {
        preds.sort((x, y) => x.eta - y.eta);
        const hi = preds.findIndex(p => p.here);
        if (hi < 0) continue;                                    // not on its way to Hammersmith (or already past it)
        const h = preds[hi], a = h.a, line = a.lineId;
        const seen = new Set(), before = [];
        for (const p of preds.slice(0, hi)) if (!seen.has(p.nap)) { seen.add(p.nap); before.push(p); }
        let dir = null;                                          // which side it is coming from, by the stops it calls at first
        for (const p of before) { const sd = SIDE[line][nrm(p.name)]; if (sd) { dir = sd; break; } }
        if (!dir) dir = dirOf(a);
        const plan = before.map(p => ({ name: p.name, eta: p.eta })).concat({ name: STN.name, eta: h.eta });
        const calls = preds.filter((p, i) => i === preds.findIndex(q => q.nap === p.nap)).map(p => ({ name: p.name, at: p.eta }));
        const vid = a.vehicleId;
        list.push({ line, dir, dest: a.destinationName, destName: nameOf(a.destinationName), eta: h.eta, vid, platform: a.platformName, loc: a.currentLocation, n: plan.length });
        upsert({ key: line + dir + (blankVid(vid) ? "x" + vid + a.destinationName : vid), line, dir, dest: a.destinationName, vid, eta: h.eta, loc: a.currentLocation, plan, calls }, now);
      }
      board = list;
      for (const t of trains.values()) {
        if (t.seen < now) { t.missed++; if (t.missed >= MISS_POLLS && (t.deta - now) / 1000 > 5 && !t.fadeAt) t.fadeAt = now; } else t.missed = 0;
      }
    }
    // v3.28: in a recorder's hidden copy, every TfL reply goes to the recorder in the page that owns it
    const RECFRAME = /[?&]recframe\b/.test(location.search);
    const recFeed = (...a) => { try { const R = window.parent.UndercurrentRecorder; if (R && R.feed) R.feed(...a); } catch (e) {} };
    async function poll() {
      try {
        const res = await scope.fetch(apiUrl(`/Line/${IDS.join(",")}/Arrivals`), { cache: "no-store" });
        if (RECFRAME && !res.ok) recFeed(STN.id, res.status, null, res.headers.get("date"), "HTTP " + res.status);
        if (res.status === 429) throw new Error("TfL is limiting requests. Add an API key below, or wait a minute.");
        if (res.status === 401 || res.status === 403) throw new Error("TfL rejected the API key. Check it under TfL API key.");
        if (!res.ok) throw new Error(`TfL returned an error (${res.status}). Retrying in 30 seconds.`);
        const data = await res.json();
        if (scope.dead) return;
        if (RECFRAME) recFeed(STN.id, res.status, data, res.headers.get("date"));
        ingest(Array.isArray(data) ? data : []);
        everLoaded = true; lastOk = Date.now(); fetchError = null;
      } catch (err) {
        if (scope.dead) return;
        if (RECFRAME && !(err && /^TfL /.test(err.message || ""))) recFeed(STN.id, 0, null, null, String((err && err.message) || err));
        fetchError = err && err.message && !/fetch|network/i.test(err.message)
          ? err.message : "Can't reach TfL right now. Trains keep moving on the last data; retrying in 30 seconds.";
      }
      updatePanel();
    }
    async function pollStatus() {
      try {
        const res = await scope.fetch(apiUrl(`/Line/${IDS.join(",")}/Status`), { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (scope.dead) return;
        let worst = null;
        for (const l of data) {
          const st = (l.lineStatuses && l.lineStatuses[0]) || {};
          if (st.statusSeverity === undefined) continue;
          if (!worst || st.statusSeverity < worst.sev) worst = { sev: st.statusSeverity, desc: st.statusSeverityDescription, reason: st.reason, line: (LINES[l.id] || {}).name || l.name };
        }
        if (!worst) throw new Error();
        pill.textContent = worst.sev === 10 ? "Good service" : `${worst.line}: ${worst.desc}`;
        pill.dataset.level = worst.sev === 10 ? "good" : (worst.sev >= 7 ? "minor" : "severe");
        if (worst.reason && worst.sev !== 10) { reasonEl.textContent = worst.reason.trim(); reasonEl.hidden = false; } else reasonEl.hidden = true;
      } catch (e) {
        if (scope.dead) return;
        pill.textContent = "Status unavailable"; pill.dataset.level = "unknown"; reasonEl.hidden = true;
      }
    }
    function updatePanel() {
      let n = 0, w = 0, e = 0;
      trains.forEach(t => { if (t.missed < 2) { n++; t.dir === "W" ? w++ : e++; } });
      $("stat-trains").textContent = everLoaded ? n : "–";
      $("stat-nb").textContent = STACK ? NG : everLoaded ? w : "–";
      $("stat-sb").textContent = STACK ? NG * 2 : everLoaded ? e : "–";
      if (fetchError) { upEl.dataset.error = ""; upEl.textContent = fetchError; }
      else if (lastOk) { delete upEl.dataset.error; const s = Math.round((Date.now() - lastOk) / 1000); upEl.textContent = s < 5 ? "Updated just now" : `Updated ${s} seconds ago`; }
      ctx.updateClock();
    }

    /* ---------- Stops away: read from the feed's location text, hidden whenever it can't be worked out ---------- */
    const STOPS_CAP = 5;                                       // beyond this the label is hidden
    const nrm = s => (s || "").toLowerCase().replace(/\(.*?\)/g, "").replace(/ underground station$/, "").replace(/[^a-z0-9]/g, "");
    const APPROACH = {};                                       // per line and direction: the stations a train passes on its way to Hammersmith (last entry is Hammersmith)
    IDS.forEach(id => { const a = LINES[id].approach || {}; APPROACH[id] = { E: (a.E || []).map(q => q.map(nrm)), W: (a.W || []).map(q => q.map(nrm)) }; });
    const locSeen = new Map();                                 // debug: what the feed said and what we made of it
    function stopsAway(a) { const r = stopInfo(a); return r ? r.n : null; }
    const SKIP = {}; IDS.forEach(id => { SKIP[id] = new Set((LINES[id].skip || []).map(nrm)); });
    function stopInfo(a) {
      const loc = (a.loc || "").trim(); if (!loc) return null;
      let best = null, bestAt = false, bestAp = false;
      for (const seq of (APPROACH[a.line] || {})[a.dir] || []) {
        const h = seq.length - 1, stops = seq.map((n, i) => i === h || !SKIP[a.line].has(n));
        const after = i => { let c = 0; for (let j = i + 1; j <= h; j++) if (stops[j]) c++; return c; };   // stops still to make after position i
        const find = text => { const s = nrm(text); let k = -1, len = 0; seq.forEach((n, i) => { if (n && s.startsWith(n) && n.length > len) { k = i; len = n.length; } }); return k; };
        let n = null, m, at = false, ap = false;
        if ((m = /^at\s+(.+)$/i.exec(loc))) { const i = find(m[1]); if (i >= 0) { n = after(i); at = stops[i]; } }      // "at" a station it runs through = passing
        else if ((m = /^(?:left|departed|leaving)\s+(.+)$/i.exec(loc))) { const i = find(m[1]); if (i >= 0 && i < h) n = after(i); }
        else if ((m = /^between\s+(.+?)\s+and\s+(.+)$/i.exec(loc))) { const i = find(m[1]), j = find(m[2]); if (i >= 0 && j >= 0) n = after(Math.min(i, j)); }
        else if ((m = /^(?:approaching|arriving at|nearing)\s+(.+)$/i.exec(loc))) { const i = find(m[1]); if (i >= 0) { n = after(i) + (stops[i] ? 1 : 0); ap = stops[i]; } }
        if (n !== null && n >= 0 && (best === null || n < best)) { best = n; bestAt = at; bestAp = ap; }
      }
      return best === null ? null : { n: best, at: bestAt, approach: bestAp };
    }
    function stopsText(p) {
      let n = p.n != null && p.n > 1 ? p.n : stopsAway(p);
      if (n === null && p.n === 1) n = 1;
      if (n === 1 && atHere(p.loc)) n = 0;
      if (ctx.debug) locSeen.set(p.line + " | " + p.dir + " | " + p.loc, n);
      return n === null || n > STOPS_CAP ? "" : n === 0 ? "At platform" : n === 1 ? "1 stop away" : n + " stops away";
    }

    /* ---------- Departures board (right panel): the station by default, a train's stops when one is tapped ---------- */
    const popSections = $("pop-sections"), popNote = $("pop-note");
    let sel = null, selNode = null, popRender = null;
    function ledRow(cells, cls) {
      const r = document.createElement("div"); r.className = "led-row" + (cls ? " " + cls : "");
      let sub = null;
      cells.forEach(([text, c, sb]) => {
        const s = document.createElement("span"); if (c) s.className = c;
        if (c === "dest") { const m = document.createElement("span"); m.className = "mq"; m.textContent = text; s.appendChild(m); } else s.textContent = text;
        r.appendChild(s); if (sb) sub = sb;
      });
      if (sub) {                                                // second line under the destination: line name on the left, stops away on the right
        const b = document.createElement("span"); b.className = "sub";
        sub.forEach((t, k) => { if (!t) return; const x = document.createElement("span"); x.className = k ? "sub-r" : "sub-l"; x.textContent = t; b.appendChild(x); });
        r.appendChild(b);
      }
      return r;
    }
    const MQ_EPOCH = performance.now(), MQ_SPEED = 45, MQ_HOLD = 1.6;
    function marquee(rootEl) {
      rootEl.querySelectorAll(".mq").forEach(m => {
        const box = m.parentElement, over = m.scrollWidth - box.clientWidth;
        if (over <= 1) { m.style.animation = ""; return; }
        const move = over / MQ_SPEED, T = 2 * (move + MQ_HOLD), hold = (MQ_HOLD / T) * 100, out = hold + (move / T) * 100;
        const name = "mq" + Math.round(over) + "x" + Math.round(T * 10);
        if (!document.getElementById(name)) {
          const st = document.createElement("style"); st.id = name;
          st.textContent = `@keyframes ${name}{0%,${hold.toFixed(2)}%{transform:translateX(0)}${out.toFixed(2)}%,${(out + hold).toFixed(2)}%{transform:translateX(-${Math.ceil(over)}px)}100%{transform:translateX(0)}}`;
          document.head.appendChild(st);
        }
        m.style.animation = `${name} ${T.toFixed(2)}s linear ${(-(((performance.now() - MQ_EPOCH) / 1000) % T)).toFixed(2)}s infinite`;
      });
    }
    function screen(labelText, rows) {
      const w = document.createElement("div");
      if (labelText) { const l = document.createElement("p"); l.className = "plat-label"; l.textContent = labelText; w.appendChild(l); }
      const led = document.createElement("div"); led.className = "led";
      rows.forEach(r => led.appendChild(r));
      w.appendChild(led); popSections.appendChild(w);
      if (!reduceMotion) marquee(led);
      return led;
    }
    const addClock = led => { const c = document.createElement("div"); c.className = "led-clock"; c.textContent = clockFmt.format(new Date()); led.appendChild(c); };
    const ledTitle = text => { const h = document.createElement("p"); h.className = "led-title"; h.textContent = text; popSections.appendChild(h); };
    const dirWord = d => d === "W" ? "Westbound" : "Eastbound";
    /* v3.33: with three or more tracks the board (one fixed size) shows two sections at a time and moves to the next pair every 8 seconds, or when
       tapped. A track with one line is one section (its trains both ways, the direction on the second line); a shared track is two, westbound and
       eastbound (the line on the second line), and they always share a page */
    const PAGE_MS = 8000, PAGE_EPOCH = Date.now();
    let pageShift = 0;
    const PAGES = [];
    if (STACK) {
      let single = [];
      GROUPS.forEach((g, i) => {
        if (g.length > 1) PAGES.push([{ g: i, dir: "W", label: GWORDS[i].W }, { g: i, dir: "E", label: GWORDS[i].E }]);
        else { single.push({ g: i, label: LINES[g[0]].name }); if (single.length === 2) { PAGES.push(single); single = []; } }
      });
      if (single.length) PAGES.push(single);
      scope.on(popSections, "click", () => { if (!popRender) { pageShift++; renderStation(); } });
    }
    const pageNow = () => (Math.floor((Date.now() - PAGE_EPOCH) / PAGE_MS) + pageShift) % PAGES.length;
    function renderPaged(now, compact) {
      const pi = pageNow(), page = PAGES[pi], per = compact ? 2 : 3;
      let last = null;
      page.forEach(sec => {
        const lines = GROUPS[sec.g], n = page.length === 1 ? per * 2 : per;
        let rows = board.filter(p => lines.includes(p.line) && (!sec.dir || p.dir === sec.dir)).map(p => ({ ...p, left: (p.eta - now) / 1000 })).filter(p => p.left > -20)
          .sort((a, b) => a.left - b.left);
        if (!sec.dir) {                                          // one line, both ways: the next train each way first, then the soonest of the rest
          const firsts = ["W", "E"].map(d => rows.find(p => p.dir === d)).filter(Boolean);
          rows = firsts.concat(rows.filter(p => !firsts.includes(p))).slice(0, n).sort((a, b) => a.left - b.left);
        } else rows = rows.slice(0, n);
        const cells = rows.length ? rows.map((p, i) => ledRow([[String(i + 1)], [p.destName || "Check front of train", "dest", [sec.dir ? LINES[p.line].name : DIRS[p.line][p.dir], stopsText(p)]], [whenText(p.left), "when"]], "stn"))
          : [ledRow([[""], [everLoaded ? "No trains listed" : "Loading…", "dest"], ["", "when"]], "stn led-empty")];
        last = screen(sec.label, cells);
      });
      const c = document.createElement("div"); c.className = "led-clock"; c.textContent = `${clockFmt.format(new Date())} · ${pi + 1} of ${PAGES.length}`; last.appendChild(c);
    }
    function renderStation() {
      const now = Date.now();
      popSections.innerHTML = "";
      // the board keeps one fixed size, so on short and phone screens it shows 2 trains each way and drops its heading (the left panel carries the name)
      const compact = window.matchMedia("(max-height: 800px) and (min-width: 861px), (max-width: 860px)").matches, perDir = compact ? 2 : 3;
      if (!compact) ledTitle(STN.name);
      if (STACK) { renderPaged(now, compact); popNote.hidden = true; return; }
      let last = null;
      ["W", "E"].forEach(dir => {
        const rows = board.filter(p => p.dir === dir).map(p => ({ ...p, left: (p.eta - now) / 1000 })).filter(p => p.left > -20)
          .sort((a, b) => a.left - b.left).slice(0, perDir);
        const cells = rows.length ? rows.map((p, i) => ledRow([[String(i + 1)], [p.destName || "Check front of train", "dest", [LINES[p.line].name, stopsText(p)]], [whenText(p.left), "when"]], "stn"))
          : [ledRow([[""], [everLoaded ? "No trains listed" : "Loading…", "dest"], ["", "when"]], "stn led-empty")];
        last = screen(dirWord(dir), cells);
      });
      addClock(last);
      popNote.hidden = true;
    }
    function setSel(t) {
      if (selNode) selNode.classList.remove("selected");
      sel = t; selNode = t ? t.g : null;
      if (selNode) selNode.classList.add("selected");
    }
    function clearSel() { setSel(null); popRender = null; renderStation(); }
    let vehFetched = 0;
    async function loadStops(t) {
      vehFetched = Date.now();
      try {
        const res = await scope.fetch(apiUrl(`/Vehicle/${encodeURIComponent(t.vid)}/Arrivals`), { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (scope.dead || sel !== t) return;
        t.stops = data.filter(a => a.lineId === t.line).map(a => ({ name: nameOf(a.stationName), at: Date.parse(a.expectedArrival) }))
          .filter(s => isFinite(s.at)).sort((a, b) => a.at - b.at);
      } catch (e) { if (!scope.dead && sel === t) t.stops = t.stops || []; }
    }
    function openTrain(t) {
      panelsApi.openRight();
      setSel(t); t.stops = null;
      if (t.calls && t.calls.length) { t.stops = t.calls; vehFetched = Date.now(); } else loadStops(t);
      popRender = () => {
        if (sel !== t || !trains.has(t.key)) { clearSel(); return; }
        const now = Date.now();
        popSections.innerHTML = "";
        ledTitle(`${LINES[t.line].name} ${DIRS[t.line][t.dir]} to ${nameOf(t.dest) || "check front of train"} · Vehicle ID ${t.vid}`);
        const stops = (t.stops || []).filter(s => s.at - now > -15000);
        const rows = stops.length ? stops.slice(0, 9).map(s => ledRow([[s.name, "dest"], [whenText((s.at - now) / 1000), "when"]], "stop"))
          : [ledRow([[t.stops ? "No stops predicted" : "Loading…", "dest"], ["", "when"]], "stop led-empty")];
        addClock(screen("Calling at", rows));
        popNote.textContent = t.loc ? `Now: ${t.loc}` : ""; popNote.hidden = !t.loc;
        if (t.calls && t.calls.length) t.stops = t.calls; else if (Date.now() - vehFetched > 20000) loadStops(t);
      };
      popRender();
    }
    scope.on($("map-wrap"), "click", e => { if (!(e.target.closest && e.target.closest(".train"))) clearSel(); });
    scope.on(document, "keydown", e => { if (e.key === "Escape" && sel) clearSel(); });
    renderStation();
    scope.every(() => (popRender || renderStation)(), 1000);

    /* ---------- Facts carousel (same behaviour as the line pages) ---------- */
    const FACTS = STN.facts || [];
    const factText = $("fact-text"), factTag = $("fact-tag"), factBar = ctx.factBar, FACT_MS = 18000;
    let factIdx = Math.floor(Math.random() * FACTS.length), factStart = performance.now(), factPaused = false;
    function showFact(i, animate) {
      factIdx = (i + FACTS.length) % FACTS.length;
      const apply = () => {
        if (!FACTS.length) { factTag.textContent = ""; factText.textContent = ""; return; }
        factTag.textContent = FACTS[factIdx].tag; factText.textContent = FACTS[factIdx].text;
        factText.classList.remove("fading"); factTag.classList.remove("fading");
      };
      factStart = performance.now();
      if (animate && !reduceMotion) { factText.classList.add("fading"); factTag.classList.add("fading"); scope.after(apply, 400); } else apply();
    }
    scope.on($("fact-prev"), "click", () => showFact(factIdx - 1, true));
    scope.on($("fact-next"), "click", () => showFact(factIdx + 1, true));
    const factsEl = document.querySelector(".facts");
    scope.on(factsEl, "mouseenter", () => { factPaused = true; });
    scope.on(factsEl, "mouseleave", () => { factPaused = false; factStart = performance.now() - (parseFloat(factBar.style.width) || 0) / 100 * FACT_MS; });
    (function tickFacts() {
      if (factPaused) factStart += 16;
      const k = Math.min(1, (performance.now() - factStart) / FACT_MS);
      factBar.style.width = (k * 100).toFixed(1) + "%";
      if (k >= 1) showFact(factIdx + 1, true);
      scope.frame(tickFacts);
    })();
    showFact(factIdx, false);

    /* ---------- Controls: the key and TfL key form work as on the line pages ---------- */
    const keyInput = $("key-input"), keyNote = $("key-note");
    try { if (localStorage.getItem("tfl-app-key")) keyInput.value = localStorage.getItem("tfl-app-key"); } catch (e) {}
    scope.on($("key-form"), "submit", e => {
      e.preventDefault();
      const v = keyInput.value.trim();
      try {
        if (v) localStorage.setItem("tfl-app-key", v); else localStorage.removeItem("tfl-app-key");
        keyNote.textContent = v ? "Key saved in this browser. Refreshing data now." : "Key removed. The map will use TfL's anonymous limit.";
      } catch (err) { keyNote.textContent = "This browser blocked saving the key, so it will be used for this visit only."; }
      poll(); pollStatus();
    });

    /* ---------- Start ---------- */
    scope.frame(frame);
    poll(); pollStatus();
    scope.every(poll, POLL_MS);
    scope.every(pollStatus, STATUS_MS);
    scope.every(updatePanel, 1000);
    scope.on(document, "visibilitychange", () => { if (!document.hidden) poll(); });
    // v3.28: what the recorder reads from a station's hidden copy
    if (RECFRAME) {
      const n1 = v => (typeof v === "number" && isFinite(v)) ? Math.round(v * 10) / 10 : null, n2 = v => (typeof v === "number" && isFinite(v)) ? Math.round(v * 100) / 100 : null;
      window.__ucLive = {
        kind: "station", id: STN.id, age: () => performance.now() - lastFrame,
        meta: () => ({ id: STN.id, name: STN.name, naptan: STN.naptan, lines: IDS, stopsShown: z,
                       approach: Object.fromEntries(IDS.map(id => [id, LINES[id].approach || null])), skip: Object.fromEntries(IDS.map(id => [id, LINES[id].skip || []])) }),
        sample: () => Array.from(trains.values()).filter(t => typeof t.s === "number").map(t => {
          const p = screenPose(t);
          return [t.vid, t.line, t.dir, n1(p.x), n1(p.y), n1(t.s), n2(t.tts >= 0 ? qOf(t) : 0), t.n != null && (t.n > 1 || !t.gap) ? t.n : t.gap ? t.gap.n : null, t.plan ? !!t.atStop : t.gap ? !!t.gap.at : null, n1(t.tts), nameOf(t.dest), t.loc || "", n2(t.op)];
        })
      };
    }
    if (ctx.debug) window.__stn = { trains, LANES, get layout() { return RADIAL ? "radial" : "linear"; }, setLayout, get board() { return board; }, stopsAway, stopInfo, qToD, qOf, get shown() { return z; }, stopsText, get locs() { return Array.from(locSeen); } };

    return { zoomCentre(f) { zoomStep(f > 1 ? 1 : -1); }, resetView() { zoomTo(STOPS_MIN); } };
  }

  window.UndercurrentStation = { mount };
})();
