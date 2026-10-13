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
   the same in both layouts. A switch in the map's top-left corner picks the layout; the choice is remembered on this device.
   v3.35: Linear 2. No station rings. Each track runs flat at its outer level, ramps in at 34 degrees to a short straight section (about two
   trains long) at the middle, and ramps out again. Grey pill separators (as on the Tube map) mark the middle: one beyond the first track, one
   beyond the last, and one between each pair of tracks, so stations with more than two tracks get a separator between each. Direction words
   sit at the two line ends on the outer side of their track.
   v3.36: in a stack only the first and last track ramp (the middle ones stay flat); lanes are 16 from the track; the separators stay 9 beyond the
   lane when zooming out (end ones move in, the I's stem lengthens); Westbound and Southbound words are always on the left.
   v3.37: the gap from a train to a separator equals the gap from a train to its track (at every zoom, so the spacing between tracks is 92); a
   train stays at the platform for at least DWELL (15) seconds counted from when it is drawn there, not from its predicted time.
   v3.38: Radial has two dashed rings (5 and 10 minutes) instead of numbered markers; they sit at the 2nd and 3rd stop distances, so the times are
   approximate, and each fades in the widest gap between track ends, where its label sits. */
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
  // v3.35 Linear 2: a track is flat at its outer level, ramps in at RAMP to a short straight section of 2 * HALF at the middle, and ramps out;
  // corners are rounded by cutting CUT off each side. SPC is the distance between the straight sections, RISE how far a track ramps outwards
  const HALF = 28, RAMP = 34 * Math.PI / 180, CUT = 9, LIN_LANE = 16, TRAIN_HALF = 5.5, TRACK_HALF = 3.5, SEP_LINE = 1;   // lane, half a train's width, half a track's width, half a separator's outline (at the default zoom)
  const SEP_END = "M6,7 H10.57 A7 7 0 0 1 17.5,1 H18.5 A7 7 0 0 1 25.43,7 H30 A5 5 0 0 1 35,12 A5 5 0 0 1 30,17 H6 A5 5 0 0 1 1,12 A5 5 0 0 1 6,7 Z";   // 36 x 18, bump at the top
  // the middle separator (an I: a pill at each end joined by a stem), drawn at scale k from y0 downwards and H tall, so the stem can be any length
  const midPath = (k, y0, H) => {
    const w = 17 * k, t = 10 * k, r = 5 * k, sw = 7.5 * k, f = n => n.toFixed(2), a = (x, y) => `A${f(r)} ${f(r)} 0 0 1 ${f(x)},${f(y)}`;
    return `M${f(-w + r)},${f(y0)} H${f(w - r)} ${a(w, y0 + r)} ${a(w - r, y0 + t)} H${f(sw)} V${f(y0 + H - t)} H${f(w - r)} ${a(w, y0 + H - t + r)} ${a(w - r, y0 + H)} H${f(-w + r)} ${a(-w, y0 + H - r)} ${a(-w + r, y0 + H - t)} H${f(-sw)} V${f(y0 + t)} H${f(-w + r)} ${a(-w, y0 + r)} ${a(-w + r, y0)} Z`;
  };
  // a rounded polyline through V (a vertex marked with a third entry is where the station is: its index comes back as idx)
  function roundPoly(V, R) {
    const out = []; let idx = 0;
    V.forEach((P, i) => {
      if (i === 0 || i === V.length - 1) { out.push([P[0], P[1]]); if (P[2]) idx = out.length - 1; return; }
      const a = V[i - 1], c = V[i + 1], l1 = Math.hypot(P[0] - a[0], P[1] - a[1]), l2 = Math.hypot(c[0] - P[0], c[1] - P[1]);
      const d1 = [(P[0] - a[0]) / l1, (P[1] - a[1]) / l1], d2 = [(c[0] - P[0]) / l2, (c[1] - P[1]) / l2];
      if (Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) < 1e-6) { out.push([P[0], P[1]]); if (P[2]) idx = out.length - 1; return; }
      const r = Math.min(R, 0.45 * l1, 0.45 * l2), p1 = [P[0] - d1[0] * r, P[1] - d1[1] * r], p2 = [P[0] + d2[0] * r, P[1] + d2[1] * r];
      for (let k = 0; k <= 12; k++) { const t = k / 12, q0 = (1 - t) * (1 - t), q1 = 2 * (1 - t) * t, q2 = t * t; out.push([q0 * p1[0] + q1 * P[0] + q2 * p2[0], q0 * p1[1] + q1 * P[1] + q2 * p2[1]]); }
    });
    return { pts: out, idx };
  }
  // v3.40: deadL / deadR: the track ends at the platform on that side (END units from the station) instead of running on and ramping out
  const END = 24;
  function trackVerts(yc, yo, deadL, deadR) {
    const rise = Math.abs(yo - yc), X = 6000;
    const left = deadL ? [[-END, yc]] : rise < 0.5 ? [[-X, yc]] : [[-X, yo], [-(HALF + rise / Math.tan(RAMP)), yo], [-HALF, yc]];
    const right = deadR ? [[END, yc]] : rise < 0.5 ? [[X, yc]] : [[HALF, yc], [HALF + rise / Math.tan(RAMP), yo], [X, yo]];
    return { left, right, yc };
  }
  // v3.42: paths. mainY(V, x) is the track's height at x (negative x on the left). A path on one side of a station is the main track shifted up or down by a
  // vertical offset that changes at forks. segVerts lists the corners of a stretch of such a path, from distance xa to xb from the station, near to far: the
  // main track's own corners, the start and end of each fork ({ xf, dw, r0, r1 }: it starts at xf, takes dw sideways to go from offset r0 to r1), and both ends.
  const mainY = (V, x) => {
    const P = V.left.concat([[0, V.yc]], V.right); let i = 1; while (i < P.length - 1 && P[i][0] < x) i++;
    const a = P[i - 1], b = P[i], u = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * Math.max(0, Math.min(1, u));
  };
  const plainTrack = V => roundPoly(V.left.concat([[0, V.yc, 1]], V.right), CUT);
  function segVerts(V, side, xa, xb, forks, base) {
    const ro = x => {
      if (!forks.length) return base;
      for (const f of forks) { if (x <= f.xf) return f.r0; if (x < f.xf + f.dw) return f.r0 + (f.r1 - f.r0) * (x - f.xf) / f.dw; }
      return forks[forks.length - 1].r1;
    };
    const xs = [xa, xb];
    (side < 0 ? V.left : V.right).forEach(p => { const x = Math.abs(p[0]); if (x > xa && x < xb) xs.push(x); });
    forks.forEach(f => [f.xf, f.xf + f.dw].forEach(x => { if (x > xa && x < xb) xs.push(x); }));
    xs.sort((p, q) => p - q);
    return xs.filter((x, i) => !i || x - xs[i - 1] > 1e-6).map(x => [side * x, mainY(V, side * x) + ro(x)]);
  }
  const yAtX = (P, x) => { let i = 1; while (i < P.length - 1 && P[i][0] < x) i++; const a = P[i - 1], b = P[i], u = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * Math.max(0, Math.min(1, u)); };
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
  function mkLane(pts, idx) {
    const cum = [0], ang = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i-1][0], dy = pts[i][1] - pts[i-1][1];
      cum.push(cum[i-1] + Math.hypot(dx, dy)); ang.push(Math.atan2(dy, dx));
    }
    return { pts, cum, ang, total: cum[cum.length-1], s0: cum[idx === undefined ? 3 : idx] };
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
    const sepG = el("g", { "aria-hidden": "true" }, scene);
    const ringG = el("g", { "aria-hidden": "true" }, scene);   // v3.38: Radial's 5 and 10 minute rings
    const fadeG = el("g", { mask: "url(#stn-fade)" }, scene);
    const poly = a => a.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    /* v3.32: tracks. Lines that share rails share one track, drawn as a ribbon of thin stripes (one per line, as on the TfL map), and their trains
       share its lanes. STN.tracks lists the groups (default: one track per line). In Linear the tracks are stacked and each ramps in to the middle (v3.35);
       in Radial every track runs straight through the one ring */
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
    // v3.40: a terminus. A track with nothing coming in from one side (the lines on it have no stops on that side) is drawn only on the side its
    // trains use, so every train comes in from one direction, and it ends at the platform. DEAD[i].E: nothing arrives from the left (moving right).
    const apOf = (id, d) => (LINES[id].approach || {})[d] || [];
    const DEAD = GROUPS.map(g => { const e = g.every(id => !apOf(id, "E").length), w = g.every(id => !apOf(id, "W").length); return { E: e && !w, W: w && !e }; });
    // v3.42: paths. The stops 1 to 5 out on each side of a track, nearest first, form a tree: stops that follow the same stops are one path, and where they
    // differ the path forks (a fork can fork again). TREE[i].E is the left side (trains moving right arrive from it), TREE[i].W the right; each is
    // { root, nodes, leaves, maxRow } or null where nothing comes in (a terminus). A node is { name, depth, kids, lines, end, row, origin, parent }: its stop,
    // how many stops out, the lines that call there, whether the line ends there, its row (0 is the main track, a row is a path's place below it; a spur
    // takes a short row), and the depth of the fork that made its row (0 if it never left the main row).
    const nrmN = s => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const RSV0 = 66, SPUR = 0.86;
    let RSV = RSV0;                                            // the distance between rows (shrinks on a short screen)
    function buildTree(gi, dir) {
      const group = GROUPS[gi], all = [];
      for (const id of group) {
        const skip = new Set((LINES[id].skip || []).map(nrmN));
        for (const seq of apOf(id, dir)) all.push({ id, st: seq.slice(0, -1).filter(n => !skip.has(nrmN(n))).reverse() });
      }
      all.forEach(a => { a.st = a.st; });
      if (!all.some(a => a.st.length)) return null;
      // a route that is another with one stop left out (Euston: via Mornington Crescent or direct) is the same path: the longer one is drawn
      const minusOne = (t, q) => t.slice(0, STOPS_MAX).some((_, i) => { const u = t.filter((__, j) => j !== i), n = Math.min(u.length, q.length, STOPS_MAX); return n > i && Array.from({ length: n }).every((__, j) => nrmN(u[j]) === nrmN(q[j])); });
      const keep = all.filter(a => a.st.length && !all.some(o => o !== a && o.id === a.id && minusOne(o.st, a.st)));
      const root = { name: "", depth: 0, kids: [], lines: new Set(group), end: false, parent: null, row: 0, origin: 0 };
      for (const { id, st } of keep) {
        let node = root;
        st.slice(0, STOPS_MAX).forEach((name, i) => {
          let c = node.kids.find(k => nrmN(k.name) === nrmN(name));
          if (!c) { c = { name, depth: i + 1, kids: [], lines: new Set(), end: false, parent: node }; node.kids.push(c); }
          c.lines.add(id); node = c;
          if (i === st.length - 1 && st.length < STOPS_MAX) c.end = true;
        });
      }
      // a branch of one or two stops that ends where there are other branches (Kensington Olympia) is a spur: it goes last, on a short row
      const spurOf = (n, sibs) => !n.kids.length && n.end && n.depth <= 2 && sibs.length > 2;
      const prep = n => { n.kids.forEach(k => { k.spur = spurOf(k, n.kids); }); n.kids.sort((a, b) => (a.spur ? 1 : 0) - (b.spur ? 1 : 0)); n.kids.forEach(prep); };
      prep(root);
      let r = 0; const leaves = [], nodes = [];
      const assign = n => {
        if (n.parent) nodes.push(n);
        if (!n.kids.length) { if (n.spur) { n.row = r - 1 + SPUR; r = n.row + 1; } else { n.row = r; r += 1; } n.leafIdx = leaves.length; leaves.push(n); return; }
        n.kids.forEach(assign); n.row = n.kids[0].row;
      };
      assign(root);
      nodes.forEach(n => { n.origin = n.row !== n.parent.row ? n.depth : n.parent.origin; });   // nodes are in depth-first order, so a parent comes first
      return { root, nodes, leaves, maxRow: Math.max(0, ...leaves.map(l => l.row)) };
    }
    const TREE = GROUPS.map((g, gi) => ({ E: buildTree(gi, "E"), W: buildTree(gi, "W") }));
    const bdir = gi => NG > 1 && gi === NG - 1 ? -1 : 1;     // rows go down, except under the last track, where they go up (towards the inside of the stack)
    const ROT = {};                                            // per track: its turn in the layout on screen (0 in Linear)
    const rp = (k, x, y) => { const a = ROT[k]; if (!a) return [x, y]; const c = Math.cos(a), sn = Math.sin(a); return [x * c - y * sn, x * sn + y * c]; };
    const BASE = {}, IDX0 = {}, VERTS = {}, TRK = {}, LSET = {};
    let SEPS = null;
    let VW = 800, VH = 480;                                    // the map's size in its own units (set in layout())
    let SPC = 92, RISE = 52, OFF = 0;                          // Linear: the distance between the straight sections, how far a track ramps outwards, and the stack's shift (fitted in layout())
    // v3.43: a track with branches needs room for its rows, but only for the rows that are showing: visRows(i, side) is how many rows (a path counts as far as it
    // has faded in) hang under a side of track i (above the last track). The gap between two tracks is the most that is needed on either side of the station,
    // where the rows going down from the upper track and the rows going up from the lower one meet, so a gap follows the zoom and the stack drifts a little as you zoom
    const visRows = (gi, sd) => { const T = TREE[gi][sd]; return T ? Math.max(0, ...T.leaves.map(l => l.row * pathOp(l))) : 0; };
    // rows are drawn at RSV * zf apart and hang from a track's outer level, which the first and last track's ramps have moved RISE away from the stack, so a
    // gap only has to find the rest; the standard spacing between tracks also eases in a little as everything shrinks
    const kz = () => 0.6 + 0.4 * zf;
    const rampOf = i => NG > 1 && (i === 0 || i === NG - 1) ? RISE * Math.min(1, (86 - HALF) / (RISE / Math.tan(RAMP) || 1)) : 0;   // the first stop (86 out) is part way up the ramp
    const sideNeed = (i, sd) => {
      const down = i < NG - 1 && bdir(i) === 1 ? Math.max(0, visRows(i, sd) * RSV * zf - rampOf(i)) : 0;
      const up = i + 1 === NG - 1 && NG > 1 ? Math.max(0, visRows(NG - 1, sd) * RSV * zf - rampOf(NG - 1)) : 0;
      return down + up;
    };
    const gapAfter = i => Math.max(sideNeed(i, "E"), sideNeed(i, "W"));
    const sumGap = () => { let q = 0; for (let i = 0; i < NG - 1; i++) q += gapAfter(i); return q; };
    const botExt = () => NG === 1 ? Math.max(visRows(0, "E"), visRows(0, "W")) * RSV * zf : 0;           // a single track's rows hang below it
    const stackY = i => { let y = 0; for (let j = 0; j < i; j++) y += SPC * kz() + gapAfter(j); return OFF + y - ((NG - 1) * SPC * kz() + sumGap() + botExt()) / 2; };
    const outward = i => NG > 1 && i === 0 ? -1 : NG > 1 && i === NG - 1 ? 1 : 0;   // which way a track opens out: only the outer two do (up for the first, down for the last); the middle ones stay flat
    const sideOf = i => outward(i) || (i < (NG - 1) / 2 ? -1 : i > (NG - 1) / 2 ? 1 : 0);   // which side of its track its words sit: the outer side (0 = the single middle track)
    let z = STOPS_MIN, zTarget = STOPS_MIN, zf = 1;
    const clamp01 = v => Math.max(0, Math.min(1, v));
    // how visible a path is: one that forks further out than the stops shown fades in as you zoom out
    const pathOp = n => n.origin ? clamp01(z - (n.origin - 1)) : 1;
    function setBase() {
      GK.forEach((k, i) => {
        ROT[k] = RADIAL ? ANG[i] : 0;
        if (RADIAL) { BASE[k] = [[DEAD[i].E ? 0 : -6000, 0], [DEAD[i].W ? 0 : 6000, 0]]; IDX0[k] = 0; return; }
        VERTS[k] = trackVerts(stackY(i), stackY(i) + outward(i) * RISE, DEAD[i].E, DEAD[i].W);
        const T = plainTrack(VERTS[k]);
        BASE[k] = T.pts; IDX0[k] = T.idx;
      });
    }
    setBase();
    const LANES = {}, TRACKS = [], ESTR = [];
    const laneKey = (k, dir, l, r) => k + dir + (l || r ? "-" + (l || 0) + "_" + (r || 0) : "");   // v3.42: a train on a branch has its own lane (left leaf, right leaf)
    const laneOf = t => LANES[laneKey(GROUP_OF[t.line], t.dir, t.pl, t.pr)] || LANES[GROUP_OF[t.line] + t.dir];
    GROUPS.forEach((g, gi) => {
      const n = g.length, w = TRACK_W * (n > 1 ? 1.75 : 1) / n;
      g.forEach((id, j) => TRACKS.push({ el: el("polyline", { class: "stn-track c" + IDS.indexOf(id) }, fadeG), k: GK[gi], off: (j - (n - 1) / 2) * w, w: w + (n > 1 ? 0.3 : 0) }));   // Radial's straight track
      // v3.42: Linear draws each stretch of track on its own, so a ribbon of lines can split into the stripes of the lines on each path: the stub through the
      // station, then for every stop the stretch up to it (stripes of the lines that call there), and on from each path's last stop out to the fade
      ["E", "W"].forEach(sd => {
        const T = TREE[gi][sd], side = sd === "E" ? -1 : 1;
        const mk = (kind, node, id, j, m) => ESTR.push({ el: el("polyline", { class: "stn-track c" + IDS.indexOf(id) + (kind === "root" || kind === "base" ? " stn-root" : " stn-edge") }, fadeG), k: GK[gi], gi, side, kind, node, off: (j - (m - 1) / 2) * w, w: w + (n > 1 ? 0.3 : 0) });
        if (!T) { g.forEach((id, j) => mk("base", null, id, j, n)); return; }
        g.forEach((id, j) => mk("root", T.root, id, j, n));
        T.nodes.forEach(nd => { const ls = g.filter(id => nd.lines.has(id)); ls.forEach((id, j) => { mk("edge", nd, id, j, ls.length); if (!nd.kids.length) mk("ext", nd, id, j, ls.length); }); });
      });
    });
    /* zoom: z is how many stops away fit on each side. 3 by default, smoothly out to 5. As z grows the stop markers close up, the next one slides
       in from the fade, and trains, markers, track and lanes all shrink by zf */
    const zScale = v => Math.pow(STOPS_MIN / v, 0.75);
    // where the stops are: stop k is X1 + (k - 1) * step from the station (see placeMarks)
    const stopGeom = () => { const rad = Math.min(VW, VH) / 2, xk = (RADIAL ? rad : VW / 2) * 0.72, x1 = RADIAL ? 92 : 86; return { x1, step: (xk - x1) / (z - 1) }; };
    const rowUnit = gi => bdir(gi) * RSV * zf;
    // v3.42: where the path to node c leaves its parent's row: just after the parent's icon (just past the platform for a first stop), at 45 degrees unless the
    // stops are close together; null when c stays on its parent's row
    function forkRec(gi, c) {
      const p = c.parent; if (c.row === p.row) return null;
      const { x1, step } = stopGeom(), ru = rowUnit(gi), r0 = p.row * ru, r1 = c.row * ru;
      const xf = p.depth === 0 ? HALF + 4 : x1 + (p.depth - 1) * step + 9 * zf;
      return { xf, dw: Math.max(12, Math.min(Math.abs(r1 - r0), x1 + (c.depth - 1) * step - 7 * zf - xf)), r0, r1 };
    }
    function buildLanes() {
      GK.forEach((k, gi) => {
        const sets = [];
        if (RADIAL) {                                            // straight track: lanes bow out round the station ring (vertex 3 is level with the station)
          let E, W, iE = 3, iW = 3;
          const L = LANE * zf, H = Math.max(0, 44 - L), B = 34, y0 = BASE[k][0][1];
          E = [[-6000, -L], [-(B + H), -L], [-B, -L - H], [0, -L - H], [B, -L - H], [B + H, -L], [6000, -L]].map(p => [p[0], p[1] + y0]);
          W = [[6000, L], [B + H, L], [B, L + H], [0, L + H], [-B, L + H], [-(B + H), L], [-6000, L]].map(p => [p[0], p[1] + y0]);
          if (DEAD[gi].E) { E = E.slice(2); iE = 1; W = W.slice(0, 5); }      // v3.40: a terminus has one arm: its lanes stop at the ring
          if (DEAD[gi].W) { W = W.slice(2); iW = 1; E = E.slice(0, 5); }
          sets.push({ l: 0, r: 0, E, W, iE, iW, trk: BASE[k] });
        } else {                                                 // Linear: lanes run alongside the track, eastbound above it and westbound below
          const V = VERTS[k], ru = rowUnit(gi), sidePaths = {};
          ["E", "W"].forEach(sd => {
            const T = TREE[gi][sd], side = sd === "E" ? -1 : 1;
            if (!T) return;
            T.nodes.forEach(nd => { nd.fk = forkRec(gi, nd); });
            sidePaths[sd] = T.leaves.map(leaf => {
              const forks = []; for (let q = leaf; q.parent; q = q.parent) if (q.fk) forks.unshift(q.fk);
              return segVerts(V, side, HALF, leaf.end ? stopX(leaf.depth) : 6000, forks, 0);   // v3.44: a path that ends stops at the icon
            });
          });
          const nl = sidePaths.E ? sidePaths.E.length : 1, nr = sidePaths.W ? sidePaths.W.length : 1;
          for (let l = 0; l < nl; l++) for (let r = 0; r < nr; r++) {
            const left = sidePaths.E ? sidePaths.E[l].slice().reverse() : V.left, right = sidePaths.W ? sidePaths.W[r] : V.right;
            const T = roundPoly(left.concat([[0, V.yc, 1]], right), CUT);
            sets.push({ l, r, E: offsetPoly(T.pts, LIN_LANE * zf), W: offsetPoly(T.pts.slice().reverse(), LIN_LANE * zf), iE: T.idx, iW: T.pts.length - 1 - T.idx, trk: T.pts });
          }
        }
        TRK[k] = {}; LSET[k] = LSET[k] || [];
        sets.forEach(S => {
          TRK[k][S.l + "_" + S.r] = S.trk;
          const ke = laneKey(k, "E", S.l, S.r), kw = laneKey(k, "W", S.l, S.r);
          if (!LSET[k].some(x => x.key === ke)) LSET[k].push({ key: ke, dir: "E" }, { key: kw, dir: "W" });
          LANES[ke] = Object.assign(LANES[ke] || {}, mkLane(S.E, S.iE), { deadBefore: DEAD[gi].E, deadAfter: DEAD[gi].W, trk: S.trk });   // v3.40: trains wait at the platform before leaving / stop there for good
          LANES[kw] = Object.assign(LANES[kw] || {}, mkLane(S.W, S.iW), { deadBefore: DEAD[gi].W, deadAfter: DEAD[gi].E, trk: S.trk });
        });
      });
      if (!RADIAL && SEPS) placeSeps();
      TRACKS.forEach(t => {
        if (!RADIAL) { t.el.setAttribute("display", "none"); return; }
        t.el.removeAttribute("display"); t.el.setAttribute("points", poly((t.off ? offsetPoly(BASE[t.k], t.off * zf) : BASE[t.k]).map(p => rp(t.k, p[0], p[1])))); t.el.style.strokeWidth = (t.w * zf).toFixed(2);
      });
      ESTR.forEach(t => {
        if (RADIAL) { t.el.setAttribute("display", "none"); return; }
        const V = VERTS[t.k], ru = rowUnit(t.gi), nd = t.node;
        let verts;
        if (t.kind === "base") verts = [[0, V.yc]].concat(t.side < 0 ? V.left.slice().reverse() : V.right);   // a side with no stops (a terminus): from the station to the end of the track
        else if (t.kind === "root") verts = segVerts(V, t.side, 0, HALF + 4, [], 0);
        else if (t.kind === "edge") verts = segVerts(V, t.side, nd.parent.depth === 0 ? HALF + 4 : stopX(nd.parent.depth), stopX(nd.depth), nd.fk ? [nd.fk] : [], nd.parent.row * ru);
        else if (nd.end) { t.el.setAttribute("display", "none"); return; }                 // v3.44: nothing beyond the icon where a path ends
        else verts = segVerts(V, t.side, stopX(nd.depth), 6000, [], nd.row * ru);
        const pts = roundPoly(verts, CUT).pts;
        t.el.removeAttribute("display"); t.el.setAttribute("points", poly(t.off ? offsetPoly(pts, (t.side < 0 ? -t.off : t.off) * zf) : pts)); t.el.style.strokeWidth = (t.w * zf).toFixed(2);   // v3.43: left-hand stretches run the other way, so their offset is turned round: a line keeps its place in the ribbon
        t.el.setAttribute("opacity", (nd && t.kind !== "root" ? pathOp(nd) : 1).toFixed(3));
      });
    }
    const stopX = k => { const { x1, step } = stopGeom(); return x1 + (k - 1) * step; };
    buildLanes();
    /* v3.42: stops. Each stop on the side trains approach from (west for eastbound, east for westbound) is a station icon on the track with its name beside it,
       away from the track as on the line maps (two short lines at most). Every path within the stops shown has its own icons and names. A side with branches
       puts its names under each row (above, under the last track); a side without puts them opposite the direction word. A stop that has a branch leaving it
       has its name moved towards the station, clear of the fork. Nothing shows on a side with no stops (a terminus). */
    const layerM = el("g", { class: "stn-marks", "aria-hidden": "true" }, fadeG);
    const MARKS = {};
    const LONG = { "heathrow terminals 2 & 3": "Heathrow 2 & 3", "heathrow terminal 4": "Heathrow T4", "heathrow terminal 5": "Heathrow T5", "king's cross st pancras": "King's Cross", "king's cross st. pancras": "King's Cross",
      "totteridge & whetstone": "Totteridge", "harrow & wealdstone": "Harrow", "chalfont & latimer": "Chalfont", "elephant & castle": "Elephant", "highbury & islington": "Highbury", "high street kensington": "High St Ken", "tottenham court road": "Tottenham Ct Rd", "shepherd's bush market": "Shepherd's Bush Mkt" };
    const shortName = n => LONG[n.toLowerCase()] || n;
    // wrap to at most two lines of about 12 characters; a name whose longest line is still too wide gets the usual abbreviations first
    const ABBR = [[/\bStreet\b/, "St"], [/\bRoad\b/, "Rd"], [/\bSquare\b/, "Sq"], [/\bGardens\b/, "Gdns"], [/\bAvenue\b/, "Ave"], [/\bGreat\b/, "Gt"], [/\bTerminals?\b/, "T"]];
    const split2 = n => {
      if (n.length <= 12) return { m: n.length, l: [n] };
      const w = n.split(" "); let best = { m: n.length, l: [n] };
      for (let i = 1; i < w.length; i++) { const a = w.slice(0, i).join(" "), b = w.slice(i).join(" "), m = Math.max(a.length, b.length); if (m < best.m) best = { m, l: [a, b] }; }
      return best;
    };
    const wrap2 = n => {
      n = shortName(n); let r = split2(n);
      for (const [re, to] of ABBR) { if (r.m <= 12) break; n = n.replace(re, to); r = split2(n); }
      return r.l;
    };
    const LBL = 21, LBL_LH = 9.4, LBL_CW = 4.4;               // distance from the track to the first line of a name, line height, and an average character width (8.5px text)
    // which side of the track names sit on (up -1, down +1)
    const nameSide = (gi, dir) => {
      const T = TREE[gi][dir];
      if (T && T.maxRow > 0.01) return bdir(gi);
      const o = sideOf(gi); return (dir === "E" ? (o || 1) < 0 : (o || -1) < 0) ? 1 : -1;
    };
    GK.forEach((id, gi) => ["E", "W"].forEach(dir => {
      MARKS[id + dir] = [];
      const T = TREE[gi][dir]; if (!T) return;
      const side = nameSide(gi, dir);
      T.nodes.forEach(nd => {
        const g = el("g", { class: "stn-mark", "data-line": id, "data-dir": dir, "data-k": nd.depth, "data-row": nd.row.toFixed(2) }, layerM);
        el("circle", { r: MARK_R }, g);
        const lines = wrap2(nd.name), tx = el("text", {}, g), fork = nd.depth === 1 && nd.kids.some(k => k.row !== nd.row);
        const y0 = side > 0 ? LBL + 8 : -(LBL + 2) - (lines.length - 1) * LBL_LH;
        if (fork) { tx.style.textAnchor = dir === "E" ? "start" : "end"; }
        lines.forEach((l, j) => { const sp = el("tspan", { x: fork ? (dir === "E" ? 4 : -4) : 0, y: (y0 + j * LBL_LH).toFixed(1) }, tx); sp.textContent = l; });
        MARKS[id + dir].push({ g, gi, k: nd.depth, node: nd, w: Math.max(...lines.map(l => l.length)) * LBL_CW + 4 });
      });
    }));
    const layerT = el("g", {}, fadeG);
    const radRing = el("circle", { class: "stn-station", cx: 0, cy: 0, r: 13 }, scene);   // v3.34: Radial has one ring where every track meets (v3.40: half the size)
    const titleEl = SHOW_TITLE ? el("text", { class: "stn-title", "text-anchor": "middle" }, scene) : null;
    if (titleEl) titleEl.textContent = STN.name;
    // v3.38: Radial has no numbered markers: two dashed rings, 5 and 10 minutes out, take their place. Each ring fades in the widest gap between track
    // ends (where there is room) and its label sits in that fade. Drawn as short dashes in four opacity steps (one path per step) so it can fade
    const RING_MINS = [5, 10], RING_STOP = [2, 3];               // a ring sits where that stop's marker would: the 2nd and 3rd stop out
    const RINGS = RING_MINS.map(m => ({ mins: m, paths: [0, 1, 2, 3].map(k => el("path", { class: "stn-ring", opacity: ((k + 1) / 4 * 0.6).toFixed(2) }, ringG)), txt: el("text", { class: "stn-ring-label", "text-anchor": "middle", "dominant-baseline": "central" }, ringG) }));
    RINGS.forEach(r => { r.txt.textContent = r.mins + " min"; });
    const dirEls = [];
    GROUPS.forEach((g, i) => {
      const cls = "stn-dir " + (g.length > 1 ? "cx" : "c" + IDS.indexOf(g[0]));   // a shared track's labels are in ink
      const w = el("text", { class: cls }, scene); w.textContent = "← " + GWORDS[i].W;
      const e = el("text", { class: cls, "text-anchor": "end" }, scene); e.textContent = GWORDS[i].E + " →";
      dirEls.push([w, e]);
    });
    // v3.35: the separators: an end separator beyond the first and the last track, and one between each pair of tracks
    const mkSep = d => el("path", { class: "stn-sep", d }, sepG);
    SEPS = { top: mkSep(SEP_END), bottom: mkSep(SEP_END), mid: Array.from({ length: NG - 1 }, () => mkSep("")) };
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
      // v3.44: a Radial end says which way trains heading out that end are going (the left end is where westbound trains go, as in Linear), not the next station,
      // which means nothing when a line branches
      return [nextStop(g, "E") ? GWORDS[i].W : "", nextStop(g, "W") ? GWORDS[i].E : ""].map(name => {
        const t = el("text", { class: cls }, scene);
        if (name.length > 14 && name.includes(" & ") && name.split(" & ").every(x => x.length > 3)) {          // long names with an "&" go on two lines
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
    function layout() {
      const r = svg.getBoundingClientRect(), w = r.width || 800, h = r.height || 480, a = w / h;
      VW = Math.max(560, 480 * a); VH = VW / a;
      const cx = VW / 2, cy = VH / 2;
      svg.setAttribute("viewBox", `0 0 ${VW.toFixed(1)} ${VH.toFixed(1)}`);
      scene.setAttribute("transform", `translate(${cx.toFixed(1)},${cy.toFixed(1)})`);
      maskRect.setAttribute("x", -cx); maskRect.setAttribute("y", -cy); maskRect.setAttribute("width", VW); maskRect.setAttribute("height", VH);
      if (titleEl) { titleEl.setAttribute("x", 0); titleEl.setAttribute("y", 54 - cy); }
      if (!RADIAL) fitLinear();
      setBase(); buildLanes();
      dirEls.forEach(([we, ee], i) => {
        const L = -cx + 18, R = cx - 18;
        we.setAttribute("x", DEAD[i].E ? R : L); we.setAttribute("text-anchor", DEAD[i].E ? "end" : "start");   // v3.40: a terminus keeps both words at its live end
        ee.setAttribute("x", DEAD[i].W ? L : R); ee.setAttribute("text-anchor", DEAD[i].W ? "start" : "end");
      });
      if (!RADIAL) placeLabels();
      // what each layout shows
      const show = (n, on) => on ? n.removeAttribute("display") : n.setAttribute("display", "none");
      show(sepG, !RADIAL); show(radRing, RADIAL); show(ringG, RADIAL);
      dirEls.forEach(pair => pair.forEach(n => show(n, !RADIAL))); endEls.forEach(pair => pair.forEach(n => show(n, RADIAL)));
      maskRect.setAttribute("fill", RADIAL ? "url(#stn-rg)" : "url(#stn-fg)");
      placeMarks(); if (RADIAL) placeEnds(); snapUntil = performance.now() + 250;
    }
    // Linear: fit the stack to the height of the map. Normally the straight sections are 78 apart and each outer track ramps 52 outwards; if the
    // map is short both close up (ramps to 20, then the spacing to 72). The stack stays centred unless that would put the outer tracks' labels
    // under the layout switch (top left) or the zoom buttons (bottom right), when it moves clear of them
    let FIT = { ctlTop: 0, tgBottom: 0 };
    function fitLinear() {
      const r = svg.getBoundingClientRect(), zc = document.querySelector(".zoom-ctl"), k = r.height ? VH / r.height : 1;
      const zr = zc && zc.offsetParent ? zc.getBoundingClientRect() : null;
      FIT.ctlTop = zr && zr.height ? (zr.top - r.top) * k : VH;   // top of the zoom buttons, in map units from the top
      const tg = layoutCtl.getBoundingClientRect(); FIT.tgBottom = tg.height ? (tg.bottom - r.top) * k : 0;
      refit();
    }
    // v3.43: the stack is fitted again whenever the zoom moves, because the rows showing (and so the gaps) change with it
    function refit() {
      const w0 = wordPos(0), w1 = wordPos(NG - 1);                  // v3.41: words pushed out past station names need more room
      const upExtra = Math.max(0, -Math.min(w0.we, w0.ee) - 25), downExtra = Math.max(0, Math.max(w1.we, w1.ee) - 37);
      const top = Math.max(60, FIT.tgBottom + 41 + upExtra) - VH / 2, bottom = Math.min(FIT.ctlTop - 46 - downExtra, VH - 52 - downExtra) - VH / 2;   // where the outer levels may be (labels sit 30 beyond them)
      const avail = bottom - top;
      SPC = 92; RISE = NG === 1 ? 0 : 52;
      RSV = RSV0;
      const need = () => (NG - 1) * SPC * kz() + sumGap() + botExt() + 2 * RISE;
      if (NG > 1 && need() > avail) RISE = Math.max(14, (avail - (NG - 1) * SPC * kz() - sumGap() - botExt()) / 2);
      if (NG > 1 && need() > avail) SPC = Math.max(72, (avail - 2 * RISE - sumGap() - botExt()) / ((NG - 1) * kz()));
      if (need() > avail) {                                       // v3.42: still too tall (many rows): the rows close up, down to 46 apart
        const rows = (sumGap() + botExt()) / RSV;
        if (rows > 0) RSV = Math.max(46, Math.min(RSV0, (avail - (NG - 1) * SPC * kz() - 2 * RISE) / rows));
      }
      const ext = need() / 2;
      OFF = need() <= avail ? Math.max(top + ext, Math.min(bottom - ext, 0)) : (top + bottom) / 2;
    }
    // Linear: each track's words sit 30 beyond its outer level, on the outer side ("← W" under the middle track on the left, "E →" above it on the right)
    function placeLabels() {
      dirEls.forEach(([we, ee], i) => {
        const yo = stackY(i) + outward(i) * RISE, W = wordPos(i);
        we.setAttribute("y", (yo + W.we).toFixed(1)); ee.setAttribute("y", (yo + W.ee).toFixed(1));
      });
    }
    // where a track's two direction words sit, as offsets from the track's outer level: 25 above or 37 below, or further out where the station names at that end
    // are on the same side (v3.41; v3.42 past all the rows of a branching side), and both at the live end of a terminus (v3.40)
    function wordPos(i) {
      const o = sideOf(i);
      let ws = (o || 1) < 0 ? -1 : 1, es = (o || -1) < 0 ? -1 : 1;           // which side of the track each word sits (up -1, down +1)
      if (DEAD[i].E) ws = -es; else if (DEAD[i].W) es = -ws;
      const off = (side, dir0) => {
        const dir = DEAD[i].E ? "W" : DEAD[i].W ? "E" : dir0, T = TREE[i][dir];
        if (!T || side !== nameSide(i, dir)) return side < 0 ? -25 : 37;
        const ext = visRows(i, dir) * RSV * zf;               // v3.42: past the station names, and (v3.43) past the rows showing on a branching side
        return side < 0 ? -(56 + ext) : 52 + ext;
      };
      return { we: off(ws, "E"), ee: off(es, "W") };
    }
    // Linear (v3.37): the gap from a train to a separator equals the gap from a train to its track line, at every zoom. The end separators move
    // with it, and the middle one (the I) keeps its pills there and lengthens its stem to fill the rest of the gap
    function placeSeps() {
      const gapT = LIN_LANE - TRACK_HALF - TRAIN_HALF;          // train to track line
      let e = (LIN_LANE + TRAIN_HALF + gapT + SEP_LINE) * zf;   // from a track to the nearest edge of a separator
      if (NG > 1) e = Math.min(e, (SPC * kz() - 20 * zf - 6) / 2);   // on a short screen the stem stays at least 6 long
      const put = (n, cy, flip) => { n.setAttribute("transform", `translate(0,${cy.toFixed(1)}) scale(${zf.toFixed(3)},${(flip ? -zf : zf).toFixed(3)}) translate(-18,-9)`); };
      put(SEPS.top, stackY(0) - e - 8 * zf, false); put(SEPS.bottom, stackY(NG - 1) + e + 8 * zf, true);
      SEPS.mid.forEach((n, j) => {
        const y0 = stackY(j) + e, H = stackY(j + 1) - e - y0;
        n.setAttribute("d", midPath(zf, y0, H)); n.style.strokeWidth = (2 * zf).toFixed(2);
      });
    }
    // marker 1 sits just past the pinch (X1) and marker z at XK, 72% of the way to the screen edge, so zooming out closes the markers up and the next
    // one slides in from the fade (fading in as it arrives). The fade starts just after XK and ends at the edge, whatever the width of the screen.
    // Each lane keeps D[k], its distance along the lane to marker k
    // Radial: the same, measured along each track from the centre, with RAD (half the shorter side of the map) in place of the half-width, so the
    // markers sit on circles and the fade is a ring
    let XK = 200, RAD = 280;
    function placeMarks() {
      const cx = VW / 2, X1 = RADIAL ? 92 : 86;   // Linear: X1 is just past the ramp's foot
      RAD = Math.min(VW, VH) / 2; XK = (RADIAL ? RAD : cx) * 0.72;
      const step = (XK - X1) / (z - 1);
      const f0 = Math.max(0.02, Math.min(0.45, (cx - (XK + 14)) / VW));
      fadeStops[1].setAttribute("offset", f0.toFixed(4)); fadeStops[2].setAttribute("offset", (1 - f0).toFixed(4));
      rgrad.setAttribute("r", RAD.toFixed(1)); rStops[1].setAttribute("offset", Math.min(0.95, (XK + 14) / RAD).toFixed(4));
      GK.forEach(id => {
        LSET[id].forEach(({ key, dir }) => {                     // each lane keeps D[k], its distance to marker k, measured on its own track (a branch's lane on the branch)
          const L = LANES[key], sign = dir === "E" ? -1 : 1;
          L.D = [0];
          for (let k = 1; k <= STOPS_MAX; k++) {
            const x = X1 + (k - 1) * step, my0 = RADIAL ? BASE[id][0][1] : yAtX(L.trk, sign * x);
            let lo = -3000, hi = 0;
            if (RADIAL) {                                        // distance along the lane where the lane is level with x
              for (let it = 0; it < 32; it++) { const mid = (lo + hi) / 2; if (Math.abs(pose(L, mid).x) > x) lo = mid; else hi = mid; }
            } else {                                             // Linear: where the lane is level with the marker, square across the track
              for (let it = 0; it < 32; it++) { const mid = (lo + hi) / 2, p = pose(L, mid); if ((p.x - sign * x) * Math.cos(p.ang) + (p.y - my0) * Math.sin(p.ang) < 0) lo = mid; else hi = mid; }
            }
            L.D.push(-(lo + hi) / 2);
          }
        });
        ["E", "W"].forEach(dir => {
          const sign = dir === "E" ? -1 : 1;
          MARKS[id + dir].forEach(m => {
            if (RADIAL) { m.g.setAttribute("display", "none"); return; }   // v3.38: Radial shows rings instead of markers
            const x = X1 + (m.k - 1) * step;
            // v3.41: a name needs room: when the stops are closer than the name is wide (zoomed out) it fades out with its icon
            const room = Math.max(0, Math.min(1, (step / (m.w * zf) - 0.8) / 0.2));
            const op = Math.max(0, Math.min(1, z - (m.k - 1))) * (m.k === 1 ? 1 : room) * pathOp(m.node);   // marker k fades in as z goes from k - 1 to k
            if (op <= 0.001) { m.g.setAttribute("display", "none"); return; }
            const my0 = mainY(VERTS[id], sign * x) + m.node.row * rowUnit(m.gi);
            m.g.removeAttribute("display"); m.g.setAttribute("opacity", op.toFixed(3));
            const [mx, my] = rp(id, sign * x, my0);
            m.g.setAttribute("transform", `translate(${mx.toFixed(1)},${my.toFixed(1)}) scale(${zf.toFixed(3)})`);
          });
        });
      });
      if (RADIAL) placeRings(X1, step);
    }
    // v3.38: Radial rings. The widest gap between track ends (the upward one if two are equal) is where the rings fade and the labels sit; gaps
    // under 60 degrees do not fade
    function placeRings(X1, step) {
      const norm = a => ((a % 360) + 360) % 360, rays = [...new Set(GK.flatMap((k, i) => [DEAD[i].W ? null : ANG[i], DEAD[i].E ? null : ANG[i] + Math.PI].filter(a => a !== null)).map(a => Math.round(norm(a * 180 / Math.PI) * 10) / 10))].sort((a, b) => a - b);
      const gaps = rays.map((a, i) => { const n = i + 1 < rays.length ? rays[i + 1] : rays[0] + 360; return { from: a, size: n - a, c: norm(a + (n - a) / 2) }; });
      const up = g => -Math.sin(g.c * Math.PI / 180), best = gaps.slice().sort((p, q) => q.size - p.size || up(q) - up(p))[0];
      const alphaAt = th => {
        th = norm(th); const g = gaps.find(g => norm(th - g.from) <= g.size);
        if (!g || g.size < 60) return 1;
        const dc = Math.abs(norm(th - g.c + 180) - 180);
        return Math.max(0, Math.min(1, (dc - 0.12 * g.size) / (0.30 * g.size)));
      };
      RINGS.forEach((R, i) => {
        const r = X1 + (RING_STOP[i] - 1) * step, n = Math.max(24, Math.round(2 * Math.PI * r / 8)), d = ["", "", "", ""];
        for (let j = 0; j < n; j++) {
          const t0 = j / n * 360, t1 = (j + 0.38) / n * 360, a = alphaAt((t0 + t1) / 2), b = Math.round(a * 4) - 1;
          if (b < 0) continue;
          const c = t => [r * Math.cos(t * Math.PI / 180), r * Math.sin(t * Math.PI / 180)], p0 = c(t0), p1 = c(t1);
          d[b] += `M${p0[0].toFixed(1)},${p0[1].toFixed(1)}A${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${p1[0].toFixed(1)},${p1[1].toFixed(1)}`;
        }
        R.paths.forEach((pa, k) => pa.setAttribute("d", d[k]));
        R.txt.setAttribute("x", (r * Math.cos(best.c * Math.PI / 180)).toFixed(1)); R.txt.setAttribute("y", (r * Math.sin(best.c * Math.PI / 180)).toFixed(1));
      });
    }
    // Radial end labels: just past the last marker, on whichever side of the track has more room before the next track round, reading away from the
    // track, then nudged back inside the map and off the zoom buttons and the layout switch if they would sit under them
    function placeEnds() {
      const dirs = [];                                         // screen direction of every track end
      GK.forEach((k, i) => { if (!DEAD[i].W) dirs.push(ANG[i]); if (!DEAD[i].E) dirs.push(ANG[i] + Math.PI); });
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
    function applyZoom() { zf = zScale(z); if (!RADIAL) { refit(); setBase(); } buildLanes(); if (!RADIAL) placeLabels(); placeMarks(); snapUntil = performance.now() + 250; }
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
        if (cur < 0 && tts > 90) { t.eta = t.deta = o.eta; t.born = now; t.fadeAt = 0; t.qs = undefined; t.arrAt = undefined; t.gap = null; }      // same vehicle, new trip
        else if (cur >= 0) t.eta = o.eta;
        t.dest = o.dest;
      }
      if (o.pa >= 0 || t.pa === undefined) { t.pa = o.pa; }          // v3.41: a branch is only changed when the stops name one
      if (o.pd >= 0 || t.pd === undefined) { t.pd = o.pd; }
      const arr = Math.max(0, t.pa), dep = Math.max(0, t.pd);
      t.pl = o.dir === "E" ? arr : dep; t.pr = o.dir === "E" ? dep : arr;   // left and right path of the lane
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
        // v3.37: a train stays at the platform for at least DWELL seconds from when it is actually drawn there (not from its predicted time, which
        // a train still catching up may have passed), and one first seen after its time is taken to have arrived at it
        if (t.qs === undefined && t.tts < 0 && t.arrAt === undefined) t.arrAt = t.deta;
        let tq;
        if (t.tts >= 0) tq = qOf(t);
        else if (t.arrAt === undefined) tq = 0;                  // past its time but not at the platform yet: carry on to it
        else tq = -sOf(-(Math.max(0, Math.min(-t.tts - DWELL, (now - t.arrAt) / 1000 - DWELL)) + DWELL)) / (SPEED * TAU_DEP);
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
        if (t.arrAt === undefined && t.qs <= 0.01) t.arrAt = now;   // it has reached the platform
        t.s = t.qs >= 0 ? -qToD(L, t.qs) : -t.qs * qToD(L, 1);
        if (L.deadAfter && t.s > 0) t.s = 0;                     // v3.40: a train that has come in to the end of the line stays at the platform
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
        let o = Math.abs(p.lx) < half + 60 ? op.toFixed(2) : "0";
        if (laneOf(t).deadBefore && t.tts > 90) o = "0";          // v3.40: a train that will leave from a terminus is not drawn until it is nearly due
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
    // the path (index of its last stop among the tree's leaves) a train is on, from the stops it calls at on that side, nearest first: each stop it calls at
    // that is a stop of the node it has reached takes it on to that stop; where it has not been named, it takes the first path. -1 if none of its stops is on the tree
    function pathIn(gi, side, names) {
      const T = gi >= 0 && TREE[gi][side]; if (!T) return -1;
      let node = T.root, hit = false;
      for (const n of names) { const c = node.kids.find(k => nrmN(k.name) === nrmN(n)); if (c) { node = c; hit = true; } }
      if (!hit) return -1;
      while (node.kids.length) node = node.kids[0];
      return node.leafIdx;
    }
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
        // v3.41: which branch it comes in on and goes out on, from the names of the stops before and after this one (-1 = cannot tell)
        const gi = GROUPS.findIndex(g => g.includes(line)), opp = dir === "E" ? "W" : "E";
        const pa = pathIn(gi, dir, before.map(p => p.name).reverse()), pd = pathIn(gi, opp, preds.slice(hi + 1).filter(p => !p.here).map(p => p.name));
        upsert({ key: line + dir + (blankVid(vid) ? "x" + vid + a.destinationName : vid), line, dir, dest: a.destinationName, vid, eta: h.eta, loc: a.currentLocation, plan, calls, pa, pd }, now);
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
    if (ctx.debug) window.__stn = { trains, LANES, TRK, TREE, ESTR, stackYs: () => GK.map((k, i) => stackY(i)), fit: () => ({ SPC, RISE, RSV, OFF, zf, kz: kz(), rows: GK.map((k, i) => [visRows(i, 'E'), visRows(i, 'W')]) }), get layout() { return RADIAL ? "radial" : "linear"; }, setLayout, get board() { return board; }, stopsAway, stopInfo, qToD, qOf, get shown() { return z; }, stopsText, get locs() { return Array.from(locSeen); } };

    return { zoomCentre(f) { zoomStep(f > 1 ? 1 : -1); }, resetView() { zoomTo(STOPS_MIN); } };
  }

  window.UndercurrentStation = { mount };
})();
