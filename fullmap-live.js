/* Project Undercurrent: Full Map live layer (v3.65, stage 5). Loaded before fullmap.js, which calls UndercurrentFullMapLive.create(opts).
   Live at every zoom: every line that crosses the screen (and 1.5 km round it) is asked for its trains, from the per-train line feed
   (/Line/a,b/Arrivals, never the station feeds), and each train is drawn on the real track between its stops.
   How a train is placed: the feed lists, for each train, the stops it will call at and when (absolute times). The stops are joined by the shortest route over the
   line's real track (geo/rail_graph.json). The train starts at the stop before its first predicted stop (the neighbour of that stop on the track, using the
   location text when a branch makes it ambiguous), leaves at an estimated time, and keeps to the predicted arrival at each stop, standing a short while at
   each. The drawn position follows that target within speed limits, so a new reply never makes a train jump.
   Lines are asked for in groups of about 2 MB of reply (5 s apart, oldest first), so each line is refreshed about every 15 to 20 s with no big bursts.
   DLR has no train numbers in the feed (no way to tell one train from another), so it stays static for now. */
(function () {
  "use strict";
  const BLUR_HIDE = 0.60, BLUR_SHOW = 0.50;   // trains are hidden when more than this share of the trains on screen overlap another (they would blur into the lines); shown again below the second figure
  const HORIZON_MS = 20 * 60000;           // a train whose first stop is further off than this has not started its trip: not drawn
  const TICK_MS = 5000, MIN_AGE_MS = 12000, GROUP_KB = 2000, PAD_M = 1500, MISS_LIMIT = 3, DWELL_S = 20;
  const NO_FEED = new Set(["dlr", "woolwich-ferry"]);
  const WEIGHT_KB = { elizabeth: 800, windrush: 650, northern: 780, central: 470, piccadilly: 450, jubilee: 350, mildmay: 350, district: 320, "hammersmith-city": 280, weaver: 280, lioness: 210, bakerloo: 200, metropolitan: 190, victoria: 180, circle: 130, tram: 90, suffragette: 90, liberty: 60, "waterloo-city": 10, rb1: 30, rb4: 20, rb6: 40, "london-cable-car": 5 };
  const SPEED = { tube: 11, elizabeth: 18, overground: 14, tram: 8, boat: 5, cable: 4 };
  const OVERGROUND = new Set(["liberty", "lioness", "mildmay", "suffragette", "weaver", "windrush"]);
  const speedOf = lid => lid === "elizabeth" ? SPEED.elizabeth : OVERGROUND.has(lid) ? SPEED.overground : lid === "tram" ? SPEED.tram : /^rb|ferry/.test(lid) ? SPEED.boat : lid === "london-cable-car" ? SPEED.cable : SPEED.tube;
  const norm = s => (s || "").toLowerCase().replace(/\(.*?\)/g, "").replace(/ (underground station|rail station|dlr station|tram stop|station|pier|stop)$/g, "").replace(/^london /, "").replace(/[^a-z0-9]/g, "");
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  function create(o) {
    const { scope, graph, apiUrl, colour, onChange } = o;
    const lines = graph.lines, LIVE = Object.keys(lines).filter(l => !NO_FEED.has(l) && colour(l));
    const A = {}, XY = {}, NAME = {}, IDX = {}, BOX = {};          // per line: track graph, station positions, names, name -> id, bounding box of its track
    for (const lid of LIVE) {
      const adj = new Map(), L = lines[lid]; XY[lid] = {}; NAME[lid] = {}; IDX[lid] = {};
      for (const s of L.stations) { XY[lid][s.id] = [s.x, s.y]; NAME[lid][s.id] = s.name.replace(/ (Underground Station|Rail Station|DLR Station|Tram Stop)$/, ""); IDX[lid][norm(s.name)] = s.id; }
      let x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12;
      for (const sg of L.segments) {
        const p = sg.path; if (!p || p.length < 2) continue;
        let len = 0; for (let i = 1; i < p.length; i++) len += dist(p[i - 1], p[i]);
        const u = sg.u || [], vl = p.map((_, j) => ((u[j - 1] || 0) + (u[j] || 0)) / (j > 0 && j < p.length - 1 ? 2 : 1));      // stripe lane at each point (shared track side by side)
        (adj.get(sg.a) || adj.set(sg.a, []).get(sg.a)).push({ to: sg.b, pts: p, vl, len });
        (adj.get(sg.b) || adj.set(sg.b, []).get(sg.b)).push({ to: sg.a, pts: p.slice().reverse(), vl: vl.map(x => -x).reverse(), len });
        for (const q of p) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
      }
      A[lid] = adj; BOX[lid] = [x0, y0, x1, y1];
    }
    const trains = new Map();
    // v4.04: the shared train brain (trains-core.js) works out where every train is, for every line the route table covers (one instance for the whole
    // map, so a train TfL lists under two lines is drawn once); this layer only lays each train's stops along the real track. ?core=0: the old engine below
    const CoreLib = window.UndercurrentTrainsCore, TABLE = window.UNDERCURRENT_ROUTES;
    const CORE = CoreLib && TABLE && !/[?&]core=0\b/.test(location.search) ? CoreLib.create(TABLE, { lines: LIVE.filter(l => TABLE.lines[l]) }) : null;
    const inCore = l => !!(CORE && CORE.lines[l]);
    const S = { live: false, wanted: [], fetched: {}, inflight: false, ok: 0, err: null, lastKick: 0, parseMs: 0, parseMax: 0, polls: 0, lastNow: 0 };

    const resolve = (lid, nap, name) => (A[lid].has(nap) ? nap : IDX[lid][norm(name)] || null);

    /* ---------- route over the real track ---------- */
    const SP_CACHE = new Map();                                               // v4.04: the track between two stops never changes, so each is worked out once
    function shortest(lid, a, b) {
      const ck = lid + "|" + a + "|" + b;
      if (SP_CACHE.has(ck)) return SP_CACHE.get(ck);
      const r = shortest0(lid, a, b); SP_CACHE.set(ck, r); return r;
    }
    function shortest0(lid, a, b) {
      if (a === b) return [];
      const adj = A[lid], d = new Map([[a, 0]]), prev = new Map(), todo = new Set([a]);
      while (todo.size) {
        let n = null, nd = 1e18; for (const k of todo) if (d.get(k) < nd) { nd = d.get(k); n = k; }
        todo.delete(n); if (n === b) break;
        for (const e of adj.get(n) || []) { const nd2 = nd + e.len; if (!d.has(e.to) || nd2 < d.get(e.to)) { d.set(e.to, nd2); prev.set(e.to, { from: n, e }); todo.add(e.to); } }
      }
      if (!prev.has(b)) return null;
      const out = []; for (let n = b; n !== a;) { const p = prev.get(n); out.push(p.e); n = p.from; }
      return out.reverse();
    }
    function buildRoute(t) {
      const lid = t.line, plan = t.plan, pts = [], lanes = [], stopAt = [];
      const push = (p, l) => { if (!pts.length || dist(pts[pts.length - 1], p) > 0.05) { pts.push(p); lanes.push(l || 0); } };
      const pushE = e => e.pts.forEach((p, j) => push(p, e.vl[j]));
      let prevId = null;
      if (plan.length) {                                              // where the train comes from: the neighbour of its first stop that is not its next one
        const first = plan[0].sid, second = plan[1] && plan[1].sid, ns = (A[lid].get(first) || []).filter(e => e.to !== second);
        if (ns.length === 1) prevId = ns[0].to;
        else if (ns.length > 1) {                                       // a junction: the stop it has just left, else the one it came from before, else the one the location text names
          const loc = norm(t.loc), pick = (t.hint && ns.find(e => e.to === t.hint)) || (t.prevId && t.prevFirst === first && ns.find(e => e.to === t.prevId)) || ns.find(e => loc && loc.includes(norm(NAME[lid][e.to])));
          prevId = (pick || ns[0]).to;
        }
        t.prevId = prevId; t.prevFirst = first;
        if (prevId !== null) { const e = (A[lid].get(first) || []).find(x => x.to === prevId); if (e) { const r = { pts: e.pts.slice().reverse(), vl: e.vl.map(x => -x).reverse() }; pushE(r); } }
      }
      if (!pts.length) push(XY[lid][plan[0].sid]);
      stopAt.push(cum(pts));
      for (let i = 1; i < plan.length; i++) {
        const r = shortest(lid, plan[i - 1].sid, plan[i].sid);
        if (r) r.forEach(pushE); else push(XY[lid][plan[i].sid], 0);
        stopAt.push(cum(pts));
      }
      const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i]));
      t.pts = pts; t.lanes = lanes; t.cum = c; t.stopAt = stopAt.map(x => x);
      t.D = stopAt.map(x => c.length ? Math.min(x, c[c.length - 1]) : 0);
      // timeline: [time, distance] knots
      const v0 = speedOf(lid); let v = v0;
      if (plan.length > 1) { const gap = (plan[1].eta - plan[0].eta) / 1000 - DWELL_S, dd = t.D[1] - t.D[0]; if (gap > 15 && dd > 50) v = Math.max(4, Math.min(25, dd / gap)); }
      t.v = v;
      const k = [];
      if (t.D[0] > 1) k.push([plan[0].eta - 1000 * t.D[0] / v, 0]);
      for (let i = 0; i < plan.length; i++) {
        k.push([plan[i].eta, t.D[i]]);
        if (i < plan.length - 1) k.push([plan[i].eta + 1000 * Math.min(DWELL_S, Math.max(0, (plan[i + 1].eta - plan[i].eta) / 4000)), t.D[i]]);
      }
      t.knots = k;
    }
    const cum = pts => { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; };
    function posAt(t, now) {
      const k = t.knots; if (!k.length) return 0;
      if (now <= k[0][0]) return k[0][1];
      for (let i = 1; i < k.length; i++) if (now <= k[i][0]) { const a = k[i - 1], b = k[i], u = (now - a[0]) / Math.max(1, b[0] - a[0]); return a[1] + (b[1] - a[1]) * u; }
      return k[k.length - 1][1];
    }
    function xyAt(t, d) {
      const c = t.cum, p = t.pts; if (p.length < 2) return [p[0] || [0, 0], 0];
      let lo = 0, hi = c.length - 1; d = Math.max(0, Math.min(c[hi], d));
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= d) lo = m; else hi = m; }
      const u = (d - c[lo]) / Math.max(1e-6, c[hi] - c[lo]), a = p[lo], b = p[hi];
      return [[a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], Math.atan2(b[1] - a[1], b[0] - a[0]), t.lanes[lo] + (t.lanes[hi] - t.lanes[lo]) * u];
    }
    function project(t, xy) {                                         // distance along the route of the point nearest xy (keeps a train where it is when its route is rebuilt)
      let best = 1e18, bd = 0; const p = t.pts;
      for (let i = 1; i < p.length; i++) {
        const ax = p[i - 1][0], ay = p[i - 1][1], bx = p[i][0], by = p[i][1], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((xy[0] - ax) * dx + (xy[1] - ay) * dy) / l2)), qx = ax + dx * u, qy = ay + dy * u, dd = (xy[0] - qx) ** 2 + (xy[1] - qy) ** 2;
        if (dd < best) { best = dd; bd = t.cum[i - 1] + Math.sqrt(l2) * u; }
      }
      return [bd, Math.sqrt(best)];
    }

    /* ---------- feed ---------- */
    function ingest(lid, data, now) {
      const groups = new Map();
      for (const a of data) {
        if (a.lineId !== lid || !a.vehicleId || /^0+$/.test(String(a.vehicleId))) continue;
        const eta = Date.parse(a.expectedArrival); if (!isFinite(eta)) continue;
        const sid = resolve(lid, a.naptanId, a.stationName); if (!sid) continue;
        (groups.get(a.vehicleId) || groups.set(a.vehicleId, []).get(a.vehicleId)).push({ sid, eta, a });
      }
      for (const [vid, preds] of groups) {
        preds.sort((x, y) => x.eta - y.eta);
        const seen = new Set(), plan = [];
        for (const p of preds) { if (seen.has(p.sid)) continue; seen.add(p.sid); plan.push({ sid: p.sid, eta: p.eta }); }
        if (!plan.length) continue;
        const key = lid + "|" + vid, last = preds[0].a;
        let t = trains.get(key);
        const old = t && t.pts && t.pts.length ? xyAt(t, t.disp)[0] : null;
        if (!t) { t = { key, line: lid, vid, born: now, disp: null, alpha: 0 }; trains.set(key, t); }
        const oldFirst = t.plan && t.plan[0] && t.plan[0].sid;
        if (oldFirst && oldFirst !== plan[0].sid && !seen.has(oldFirst)) t.hint = oldFirst;        // the stop it has just passed
        t.plan = plan; t.dest = (last.destinationName || "").replace(/ (Underground Station|Rail Station|DLR Station|Tram Stop)$/, ""); t.destNap = last.destinationNaptanId || ""; t.code = null; t.loc = last.currentLocation || ""; t.seen = now; t.miss = 0; t.dead = 0;
        buildRoute(t);
        if (old) { const [pd, off] = project(t, old); t.disp = off < 150 ? pd : posAt(t, now); } else t.disp = posAt(t, now);       // its route changed (far from where it was): follow the new timeline
        if (old) { const nw = xyAt(t, t.disp)[0], dj = dist(old, nw); if (dj > 60) { S.reproj = (S.reproj || 0) + 1; (S.reprojLog = S.reprojLog || []).push([Math.round(dj), t.key]); } }
      }
      for (const t of trains.values()) if (t.line === lid && t.seen < now) { t.miss++; if (t.miss >= MISS_LIMIT && !t.dead) t.dead = now; }
    }
    /* ---------- v4.04: trains from the core ----------
       After each reply the core's snapshot gives every train's stops with times; each train's stops are joined over the real track (as before) and
       its place is the core's: standing at a stop, or between two stops by time. Display choices made here: a train waiting to start its trip more
       than 20 minutes ahead is not drawn (as before), nor one waiting to start somewhere other than the end of a line until a minute before it leaves
       (as on the line pages), nor the trains of a line not refreshed for 2 minutes (panned away; drawn again with the next reply). */
    const STALE_LINE_MS = 120000;
    function coreApply(now) {
      const snap = CORE.snapshot(), off = CORE.clockOffset, seen = new Set();
      for (const c of snap.trains) {
        const lid = c.line; if (!A[lid]) continue;
        const key = lid + "|" + c.vid; seen.add(key);
        let t = trains.get(key);
        if (!t) { t = { key, line: lid, vid: c.vid, born: now, alpha: 0, core: true, disp: 0 }; trains.set(key, t); }
        if (t.c && c.snapAt !== t.c.snapAt) t.born = now;                       // re-placed by the core: it fades in where it now is
        t.c = c; t.dest = c.destName; t.destNap = c.dest || ""; t.code = null; t.loc = c.loc || ""; t.seen = now; t.miss = 0; t.dead = 0;
        const Lm = CORE.lines[lid], RT = Lm.ROUTES[c.route], nm = x => Lm.S[RT.st[x.k]].name;
        const sids = c.stops.map(x => resolve(lid, x.naptan, nm(x)));
        t.plan = c.stops.map((x, i) => ({ sid: sids[i], eta: (x.at !== null ? x.at : x.dep !== null ? x.dep : now + off) - off })).filter(x => x.sid);
        t.sids = sids;
        const gk = sids.join(">");
        if (gk !== t.gk) { t.gk = gk; coreGeom(t, sids); }
        t.atEnd = st => RT.st[st.k] !== undefined && (st.k === 0 || st.k === RT.LAST);
      }
      for (const [k, t] of trains) if (t.core && !seen.has(k)) trains.delete(k);   // the core has let it go (it has faded out)
    }
    function coreGeom(t, sids) {                                              // its stops joined over the real track; stopAt: distance of each stop
      const lid = t.line, pts = [], lanes = [], stopAt = [];
      const push = (p, l) => { if (!pts.length || dist(pts[pts.length - 1], p) > 0.05) { pts.push(p); lanes.push(l || 0); } };
      let prev = null;
      sids.forEach((sid, i) => {
        if (!sid || !XY[lid][sid]) { stopAt.push(stopAt.length ? stopAt[stopAt.length - 1] : 0); return; }
        if (prev === null) push(XY[lid][sid], 0);
        else { const r = shortest(lid, prev, sid); if (r) r.forEach(e => e.pts.forEach((q, j) => push(q, e.vl[j]))); else push(XY[lid][sid], 0); }
        prev = sid; stopAt.push(cum(pts));
      });
      const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i]));
      t.pts = pts.length ? pts : [[0, 0]]; t.lanes = lanes; t.cum = c; t.stopAt = stopAt; t.v = speedOf(lid);
    }
    function coreAdvance(t, now) {
      const T = now + CORE.clockOffset, c = t.c, pos = CoreLib.positionAt(c, T);
      const from = pos.standing ? pos.i : pos.i - 1, d0 = t.stopAt[from] || 0, d1 = t.stopAt[pos.i] || d0;
      t.disp = d0 + (pos.standing ? 0 : pos.p) * (d1 - d0);
      const here = c.stops[pos.i];
      t.hidden = !t.sids[from] || !t.sids[pos.i] ||                                // beyond the edge of the map (Reading, Shenfield, Watford): no track to draw it on
        (c.state === "waiting" && c.departAt !== null && c.departAt - T > HORIZON_MS) ||
        (pos.standing && here && here.at === null && !t.atEnd(here) && here.dep !== null && here.dep - T > 60000) ||
        now - (S.fetched[t.line] || 0) > STALE_LINE_MS;
      if (c.fadeFrom && T >= c.fadeFrom) { t.alpha = Math.max(0, Math.min(1, (c.fadeTo - T) / Math.max(1, c.fadeTo - c.fadeFrom))); t.dead = t.dead || now; }
      else t.alpha = Math.min(1, (now - t.born) / 600);
    }
    const hiddenT = (t, now) => t.core ? t.hidden : t.plan[0].eta - now > HORIZON_MS;

    async function poll(force) {
      if (!S.live || S.inflight) return;
      const now = Date.now(); if (!force && now - S.lastKick < 1500) return; S.lastKick = now;
      const want = S.wanted.filter(l => now - (S.fetched[l] || 0) >= MIN_AGE_MS).sort((a, b) => (S.fetched[a] || 0) - (S.fetched[b] || 0));
      if (!want.length) return;
      const group = []; let kb = 0;
      for (const l of want) { const w = WEIGHT_KB[l] || 300; if (group.length && kb + w > GROUP_KB) break; group.push(l); kb += w; }
      S.inflight = true;
      try {
        const res = await scope.fetch(apiUrl(`/Line/${group.join(",")}/Arrivals`), { cache: "no-store" });
        if (res.status === 429) throw new Error("TfL is limiting requests. Add an API key in Prefs, or wait a minute.");
        if (res.status === 401 || res.status === 403) throw new Error("TfL rejected the API key. Check it under TfL API key in Prefs.");
        if (!res.ok) throw new Error(`TfL returned an error (${res.status}). Retrying shortly.`);
        const txt = await res.text(); if (scope.dead) return;
        const t0 = performance.now(), data = JSON.parse(txt), t1 = Date.now();
        const cl = group.filter(inCore);
        if (cl.length) { CORE.ingest(Array.isArray(data) ? data : [], res.headers.get("date"), t1, cl); coreApply(t1); }
        for (const l of group) { if (!inCore(l)) ingest(l, Array.isArray(data) ? data : [], t1); S.fetched[l] = t1; }
        const ms = performance.now() - t0; S.parseMs = ms; S.parseMax = Math.max(S.parseMax, ms); S.polls++; S.ok = Date.now(); S.err = null;
      } catch (err) {
        if (scope.dead) return;
        S.err = err && err.message && !/fetch|network|Load failed/i.test(err.message) ? err.message : "Can't reach TfL right now. Trains keep moving on the last data; retrying shortly.";
        for (const l of group) S.fetched[l] = Date.now() - MIN_AGE_MS + 8000;       // try again in about 8 s, not at once
      } finally { S.inflight = false; onChange(); }
    }
    scope.every(() => poll(false), TICK_MS);

    /* ---------- the view decides what is live ---------- */
    function setView(v, widthM) {
      const was = S.live; S.live = true;                                      // live at every zoom: only blurring decides whether trains are drawn
      const x0 = v.x0 - PAD_M, x1 = v.x1 + PAD_M, y0 = v.y0 - PAD_M, y1 = v.y1 + PAD_M;
      const want = LIVE.filter(l => { const b = BOX[l]; return !(b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1); });
      const changed = want.length !== S.wanted.length || want.some((l, i) => l !== S.wanted[i]);
      S.wanted = want;
      if (changed || !was) poll(false);
    }

    /* ---------- drawing ---------- */
    /* ---------- destination shorthand: the line maps' own codes (see tools/geo/make_codes.js) ---------- */
    function destCode(t) {
      const CODES = window.UC_CODES || { lines: {}, names: {} }, L = CODES.lines[t.line], nm = norm(t.dest);
      return (L && ((t.destNap && L.n[t.destNap]) || L.m[nm])) || CODES.names[nm] || (t.dest || "").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "";
    }
    const darkText = hex => { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return (0.299 * r + 0.587 * g + 0.114 * b) > 165; };
    function lineWidthPx(pxPerM) { return Math.max(2, Math.min(6.5, 24 * pxPerM)); }      // the same as the track lines drawn by fullmap.js
    function where(t, pxPerM) {                                      // map position of the train, moved to its own stripe lane on shared track
      const [p, ang, lane] = xyAt(t, t.disp), lw = lineWidthPx(pxPerM), off = (pxPerM >= 0.05 ? lw * 0.92 : 0) * lane / pxPerM;
      return [[p[0] - Math.sin(ang) * off, p[1] + Math.cos(ang) * off], ang];
    }
    function pathFor(boat, L, W) {
      const p = new Path2D(), r = W / 2, rr = r * 0.7, n = r * 1.15;
      if (boat) { p.moveTo(-L / 2, -r * 0.8); p.quadraticCurveTo(-L / 2, -r, -L / 2 + r * 0.6, -r); p.lineTo(L * 0.12, -r); p.quadraticCurveTo(L * 0.42, -r * 0.8, L / 2, 0); p.quadraticCurveTo(L * 0.42, r * 0.8, L * 0.12, r); p.lineTo(-L / 2 + r * 0.6, r); p.quadraticCurveTo(-L / 2, r, -L / 2, r * 0.8); p.closePath(); }
      else {                                                           // a train: square rear, a slightly rounded point at the front
        p.moveTo(-L / 2 + rr, -r); p.lineTo(L / 2 - n, -r); p.quadraticCurveTo(L / 2 - n * 0.15, -r * 0.92, L / 2, 0); p.quadraticCurveTo(L / 2 - n * 0.15, r * 0.92, L / 2 - n, r);
        p.lineTo(-L / 2 + rr, r); p.quadraticCurveTo(-L / 2, r, -L / 2, r - rr); p.lineTo(-L / 2, -r + rr); p.quadraticCurveTo(-L / 2, -r, -L / 2 + rr, -r); p.closePath();
      }
      return p;
    }
    function advance(now) {
      const dt = Math.min(0.25, Math.max(0, (now - (S.lastNow || now)) / 1000)); S.lastNow = now;
      for (const [k, t] of trains) {
        if (t.core) { if (t.pts && t.pts.length >= 2) coreAdvance(t, now); continue; }
        if (!t.pts || t.pts.length < 2) continue;
        const target = posAt(t, now), d = target - t.disp;
        // forward: close the gap within about 25 s, never faster than 40 m/s; behind schedule: wait in place (a train never runs backwards); far out of step: follow the timeline
        if (d >= 0) { if (d > 1500) t.disp = target; else t.disp += Math.min(d, Math.min(40, Math.max(t.v * 1.8, d / 25)) * dt); }
        else if (d < -1200) { t.disp = target; S.snaps = (S.snaps || 0) + 1; }
        else t.disp += Math.max(d, -t.v * 0.5 * dt);
        t.alpha = t.dead ? Math.max(0, 1 - (now - t.dead) / 600) : Math.min(1, (now - t.born) / 600);
        if (t.dead && t.alpha <= 0) trains.delete(k);
        else if (!t.dead && t.knots.length && now - t.knots[t.knots.length - 1][0] > 90000) t.dead = now;     // its last stop was long ago: the trip is over
      }
    }
    const glowSprites = new Map();                                     // v3.71 (Parchment): a soft glow under each train, drawn from cached sprites (v3.80: one per line colour for Night City)
    function glowFor(col, R) {
      const key = col + "|" + R, hit = glowSprites.get(key); if (hit) return hit;
      const cv = document.createElement("canvas"); cv.width = cv.height = Math.ceil(R * 2); const g = cv.getContext("2d"), gr = g.createRadialGradient(R, R, 0, R, R, R);
      gr.addColorStop(0, col); gr.addColorStop(1, col.replace(/[\d.]+\)$/, "0)")); g.fillStyle = gr; g.fillRect(0, 0, cv.width, cv.height);
      glowSprites.set(key, cv); return cv;
    }
    const hexRgba = (h, a) => { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
    function draw(c, toX, toY, view, pxPerM, now, bg, outline, font, glow, tstyle) {
      advance(now); S.px = pxPerM;
      // wider than the track on purpose: even zoomed out a train is an obvious bulge, and on shared track it reaches over its neighbours' stripes
      const W = Math.max(10, lineWidthPx(pxPerM) * 2.6 + 3), L = W * 2.1; let n = 0;
      const shapes = { train: pathFor(false, L, W), boat: pathFor(true, L * 1.05, W * 0.95) };
      const vis = [];
      for (const t of trains.values()) {
        if (!t.pts || t.pts.length < 2 || t.alpha <= 0 || !t.plan.length || hiddenT(t, now)) continue;
        const [p, ang] = where(t, pxPerM);
        if (p[0] < view.x0 || p[0] > view.x1 || p[1] < view.y0 || p[1] > view.y1) continue;
        vis.push({ t, x: toX(p[0]), y: toY(p[1]), ang });
      }
      // blurring: if too many trains sit on top of each other at this zoom the picture turns to mush, so trains are not drawn (data keeps coming in)
      const cell = W * 1.1, grid = new Map(); let overl = 0;
      for (const v of vis) { const k = Math.floor(v.x / cell) + "," + Math.floor(v.y / cell); (grid.get(k) || grid.set(k, []).get(k)).push(v); }
      for (const v of vis) {
        const cx = Math.floor(v.x / cell), cy = Math.floor(v.y / cell); let hit = false;
        for (let i = -1; i <= 1 && !hit; i++) for (let j = -1; j <= 1 && !hit; j++) for (const w of grid.get((cx + i) + "," + (cy + j)) || []) if (w !== v && Math.hypot(w.x - v.x, w.y - v.y) < cell) { hit = true; break; }
        if (hit) overl++;
      }
      const share = vis.length > 8 ? overl / vis.length : 0;
      S.blurShare = share; S.blur = S.blur ? share > BLUR_SHOW : share > BLUR_HIDE;
      if (S.blur) return 0;
      if (glow) { const R = Math.round(W * 1.5), sp = glowFor(glow, R); for (const { t, x, y } of vis) { c.globalAlpha = t.alpha; c.drawImage(sp, x - R, y - R); } c.globalAlpha = 1; }
      if (tstyle && tstyle.glowLine) { const R = Math.round(W * 1.9); for (const { t, x, y } of vis) { c.globalAlpha = t.alpha; c.drawImage(glowFor(hexRgba(tstyle.fill(t.line), 0.6), R), x - R, y - R); } c.globalAlpha = 1; }   // a soft glow in the line colour round each train
      if (tstyle && tstyle.core) shapes.core = pathFor(false, L * 0.8, W * 0.52), shapes.coreBoat = pathFor(true, L * 0.8, W * 0.44);
      for (const { t, x, y, ang } of vis) {
        n++; const boat = /^rb|ferry/.test(t.line);
        c.save(); c.globalAlpha = t.alpha; c.translate(x, y); c.rotate(-ang);
        c.fillStyle = tstyle ? tstyle.fill(t.line) : colour(t.line); c.strokeStyle = outline; c.lineWidth = 2.6; c.lineJoin = "round"; const sh = boat ? shapes.boat : shapes.train; c.stroke(sh); c.fill(sh);
        if (tstyle && tstyle.core) { c.fillStyle = "rgba(255,255,255,.92)"; c.fill(boat ? shapes.coreBoat : shapes.core); }       // the white core: the brightest thing on screen
        c.restore();
      }
      // labels sit inside the train: the destination code (the same shorthand as the line maps) or the last 3 digits of the vehicle number (as on the station pages)
      const mode = S.labelMode || "off", fs = Math.max(8.5, W * 0.56);
      if (mode !== "off" && W >= 15) {
        c.font = `700 ${fs}px ${font || "sans-serif"}`; c.textBaseline = "middle"; c.textAlign = "center";
        for (const { t, x, y, ang } of vis) {
          const txt = mode === "vid" ? String(t.vid).slice(-3) : (t.code || (t.code = destCode(t)));
          if (!txt || /^rb|ferry|cable/.test(t.line) && mode === "vid") continue;
          const flip = Math.cos(ang) < 0;                                   // keep the text the right way up
          c.save(); c.globalAlpha = t.alpha; c.translate(x, y); c.rotate(flip ? -ang + Math.PI : -ang);
          c.fillStyle = tstyle && tstyle.core ? "#0D1014" : darkText(colour(t.line)) ? "#23272B" : "#FFFFFF"; c.fillText(txt, -L * 0.04, 0.5); c.restore();
        }
      }
      return n;
    }
    function hit(x, y, toX, toY, now) {
      let best = null, bd = 18 * 18;
      for (const t of trains.values()) {
        if (!t.pts || t.pts.length < 2 || t.dead || !t.plan.length || hiddenT(t, Date.now())) continue;
        const p = where(t, S.px || 0.1)[0], dx = toX(p[0]) - x, dy = toY(p[1]) - y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = t; }
      }
      if (!best) return null;
      const next = best.plan.find(s => s.eta > now - 5000) || best.plan[best.plan.length - 1], secs = Math.round((next.eta - now) / 1000);
      return { line: best.line, dest: best.dest, next: NAME[best.line][next.sid], secs, x: toX(where(best, S.px || 0.1)[0][0]), y: toY(where(best, S.px || 0.1)[0][1]) };
    }
    return {
      setView, draw, hit, poll: () => poll(true),
      snapshot(now) { const out = []; for (const t of trains.values()) { if (!t.pts || t.pts.length < 2 || t.dead || !t.plan.length || hiddenT(t, now)) continue; const p = xyAt(t, t.disp)[0]; out.push({ key: t.key, line: t.line, x: p[0], y: p[1], plan: t.plan.map(s => ({ sid: s.sid, eta: s.eta, x: (XY[t.line][s.sid] || [0, 0])[0], y: (XY[t.line][s.sid] || [0, 0])[1] })) }); } return out; },
      get live() { return S.live; }, get core() { return CORE; }, get trains() { return trains.size; }, get state() { return S; }, get lines() { return S.wanted.length; },
      count(view) { let n = 0; const now = Date.now(); for (const t of trains.values()) { if (!t.pts || t.dead || !t.plan.length || hiddenT(t, now)) continue; const p = xyAt(t, t.disp)[0]; if (p[0] >= view.x0 && p[0] <= view.x1 && p[1] >= view.y0 && p[1] <= view.y1) n++; } return n; },
      setLabels(m) { S.labelMode = m; },
      get blur() { return !!S.blur; }
    };
  }
  window.UndercurrentFullMapLive = { create };
})();
