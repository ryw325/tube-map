/* Project Undercurrent: Full Map live layer (v3.65, stage 5). Loaded before fullmap.js, which calls UndercurrentFullMapLive.create(opts).
   Inside the live range (the view is no wider than MAX_WIDTH_M) every line that crosses the screen is asked for its trains, from the per-train line feed
   (/Line/a,b/Arrivals, never the station feeds), and each train is drawn on the real track between its stops.
   How a train is placed: the feed lists, for each train, the stops it will call at and when (absolute times). The stops are joined by the shortest route over the
   line's real track (geo/rail_graph.json). The train starts at the stop before its first predicted stop (the neighbour of that stop on the track, using the
   location text when a branch makes it ambiguous), leaves at an estimated time, and keeps to the predicted arrival at each stop, standing a short while at
   each. The drawn position follows that target within speed limits, so a new reply never makes a train jump.
   Lines are asked for in groups of about 2 MB of reply (5 s apart, oldest first), so each line is refreshed about every 15 to 20 s with no big bursts.
   DLR has no train numbers in the feed (no way to tell one train from another), so it stays static for now. */
(function () {
  "use strict";
  const MAX_WIDTH_M = 8000;               // live only when the view is no wider than this (metres); tuned in testing
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
        (adj.get(sg.a) || adj.set(sg.a, []).get(sg.a)).push({ to: sg.b, pts: p, len });
        (adj.get(sg.b) || adj.set(sg.b, []).get(sg.b)).push({ to: sg.a, pts: p.slice().reverse(), len });
        for (const q of p) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
      }
      A[lid] = adj; BOX[lid] = [x0, y0, x1, y1];
    }
    const trains = new Map();
    const S = { live: false, wanted: [], fetched: {}, inflight: false, ok: 0, err: null, lastKick: 0, parseMs: 0, parseMax: 0, polls: 0, lastNow: 0 };

    const resolve = (lid, nap, name) => (A[lid].has(nap) ? nap : IDX[lid][norm(name)] || null);

    /* ---------- route over the real track ---------- */
    function shortest(lid, a, b) {
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
      const lid = t.line, plan = t.plan, pts = [], stopAt = [];
      const push = p => { if (!pts.length || dist(pts[pts.length - 1], p) > 0.05) pts.push(p); };
      let prevId = null;
      if (plan.length) {                                              // where the train comes from: the neighbour of its first stop that is not its next one
        const first = plan[0].sid, second = plan[1] && plan[1].sid, ns = (A[lid].get(first) || []).filter(e => e.to !== second);
        if (ns.length === 1) prevId = ns[0].to;
        else if (ns.length > 1) {                                       // a junction: the stop it has just left, else the one it came from before, else the one the location text names
          const loc = norm(t.loc), pick = (t.hint && ns.find(e => e.to === t.hint)) || (t.prevId && t.prevFirst === first && ns.find(e => e.to === t.prevId)) || ns.find(e => loc && loc.includes(norm(NAME[lid][e.to])));
          prevId = (pick || ns[0]).to;
        }
        t.prevId = prevId; t.prevFirst = first;
        if (prevId !== null) { const e = (A[lid].get(first) || []).find(x => x.to === prevId); if (e) e.pts.slice().reverse().forEach(push); }
      }
      if (!pts.length) push(XY[lid][plan[0].sid]);
      stopAt.push(cum(pts));
      for (let i = 1; i < plan.length; i++) {
        const r = shortest(lid, plan[i - 1].sid, plan[i].sid);
        if (r) r.forEach(e => e.pts.forEach(push)); else push(XY[lid][plan[i].sid]);
        stopAt.push(cum(pts));
      }
      const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i]));
      t.pts = pts; t.cum = c; t.stopAt = stopAt.map(x => x);
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
      return [[a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], Math.atan2(b[1] - a[1], b[0] - a[0])];
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
        t.plan = plan; t.dest = (last.destinationName || "").replace(/ (Underground Station|Rail Station|DLR Station|Tram Stop)$/, ""); t.loc = last.currentLocation || ""; t.seen = now; t.miss = 0; t.dead = 0;
        buildRoute(t);
        if (old) { const [pd, off] = project(t, old); t.disp = off < 150 ? pd : posAt(t, now); } else t.disp = posAt(t, now);       // its route changed (far from where it was): follow the new timeline
        if (old) { const nw = xyAt(t, t.disp)[0], dj = dist(old, nw); if (dj > 60) { S.reproj = (S.reproj || 0) + 1; (S.reprojLog = S.reprojLog || []).push([Math.round(dj), t.key]); } }
      }
      for (const t of trains.values()) if (t.line === lid && t.seen < now) { t.miss++; if (t.miss >= MISS_LIMIT && !t.dead) t.dead = now; }
    }
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
        for (const l of group) { ingest(l, Array.isArray(data) ? data : [], t1); S.fetched[l] = t1; }
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
      const live = widthM <= MAX_WIDTH_M;
      const was = S.live; S.live = live;
      if (!live) { if (was) { trains.clear(); S.wanted = []; } return; }
      const x0 = v.x0 - PAD_M, x1 = v.x1 + PAD_M, y0 = v.y0 - PAD_M, y1 = v.y1 + PAD_M;
      const want = LIVE.filter(l => { const b = BOX[l]; return !(b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1); });
      const changed = want.length !== S.wanted.length || want.some((l, i) => l !== S.wanted[i]);
      S.wanted = want;
      if (changed || !was) poll(false);
    }

    /* ---------- drawing ---------- */
    const BODY = new Path2D("M-12,-7 H10 L17,0 L10,7 H-12 A6 6 0 0 1 -18,1 V-1 A6 6 0 0 1 -12,-7 Z");
    function advance(now) {
      const dt = Math.min(0.25, Math.max(0, (now - (S.lastNow || now)) / 1000)); S.lastNow = now;
      for (const [k, t] of trains) {
        if (!t.pts || t.pts.length < 2) continue;
        const target = posAt(t, now), d = target - t.disp;
        // forward: close the gap within about 25 s, never faster than 40 m/s; behind schedule: wait in place (a train never runs backwards); far out of step: follow the timeline
        if (d >= 0) { if (d > 1500) t.disp = target; else t.disp += Math.min(d, Math.min(40, Math.max(t.v * 1.8, d / 25)) * dt); }
        else if (d < -1200) { t.disp = target; S.snaps = (S.snaps || 0) + 1; }
        t.alpha = t.dead ? Math.max(0, 1 - (now - t.dead) / 600) : Math.min(1, (now - t.born) / 600);
        if (t.dead && t.alpha <= 0) trains.delete(k);
        else if (!t.dead && t.knots.length && now - t.knots[t.knots.length - 1][0] > 90000) t.dead = now;     // its last stop was long ago: the trip is over
      }
    }
    function draw(c, toX, toY, view, pxPerM, now, bg, outline) {
      advance(now);
      const size = Math.max(0.46, Math.min(0.9, 0.4 + pxPerM * 1.1)); let n = 0;
      for (const t of trains.values()) {
        if (!t.pts || t.pts.length < 2 || t.alpha <= 0 || t.plan[0].eta - now > HORIZON_MS) continue;
        const [p, ang] = xyAt(t, t.disp);
        if (p[0] < view.x0 || p[0] > view.x1 || p[1] < view.y0 || p[1] > view.y1) continue;
        n++;
        c.save(); c.globalAlpha = t.alpha; c.translate(toX(p[0]), toY(p[1])); c.rotate(-ang); c.scale(size, size);
        c.fillStyle = colour(t.line); c.strokeStyle = outline; c.lineWidth = 3.4; c.lineJoin = "round"; c.stroke(BODY); c.fill(BODY);
        c.restore();
      }
      return n;
    }
    function hit(x, y, toX, toY, now) {
      let best = null, bd = 18 * 18;
      for (const t of trains.values()) {
        if (!t.pts || t.pts.length < 2 || t.dead || t.plan[0].eta - Date.now() > HORIZON_MS) continue;
        const p = xyAt(t, t.disp)[0], dx = toX(p[0]) - x, dy = toY(p[1]) - y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = t; }
      }
      if (!best) return null;
      const next = best.plan.find(s => s.eta > now - 5000) || best.plan[best.plan.length - 1], secs = Math.round((next.eta - now) / 1000);
      return { line: best.line, dest: best.dest, next: NAME[best.line][next.sid], secs, x: toX(xyAt(best, best.disp)[0][0]), y: toY(xyAt(best, best.disp)[0][1]) };
    }
    return {
      setView, draw, hit, poll: () => poll(true),
      snapshot(now) { const out = []; for (const t of trains.values()) { if (!t.pts || t.pts.length < 2 || t.dead || t.plan[0].eta - now > HORIZON_MS) continue; const p = xyAt(t, t.disp)[0]; out.push({ key: t.key, line: t.line, x: p[0], y: p[1], plan: t.plan.map(s => ({ sid: s.sid, eta: s.eta, x: (XY[t.line][s.sid] || [0, 0])[0], y: (XY[t.line][s.sid] || [0, 0])[1] })) }); } return out; },
      get live() { return S.live; }, get trains() { return trains.size; }, get state() { return S; }, get lines() { return S.wanted.length; },
      count(view) { let n = 0; const now = Date.now(); for (const t of trains.values()) { if (!t.pts || t.dead || t.plan[0].eta - now > HORIZON_MS) continue; const p = xyAt(t, t.disp)[0]; if (p[0] >= view.x0 && p[0] <= view.x1 && p[1] >= view.y0 && p[1] <= view.y1) n++; } return n; },
      maxWidth: MAX_WIDTH_M
    };
  }
  window.UndercurrentFullMapLive = { create, MAX_WIDTH_M };
})();
