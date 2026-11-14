/* Line view layout (v4.22): one line as a strip, stations at equal gaps, branches as parallel lanes. No DOM; loaded only when the Line view is chosen.
   UndercurrentLineView.build(LINE, orient, T) -> { stations: {id: [x, y]}, pref: {id: side}, paths: {"a>b": [[x, y], ...]}, marks: [...], emptyAt, extent }
     orient "v": stations run top to bottom (phones, portrait); "h": left to right (landscape). The layout is made vertically and turned 90 degrees for "h".
     T is the line's True layout (lines/<id>-true.js) if it has one; it is only used to find where the line crosses the Thames.
   How it is laid out:
     * the longest route is the spine (lane 0); a lane step is LANE_GAP, a row step is GAP
     * any other route is walked along: a run of stations that is not placed yet either leaves a placed station (a branch: rows carry on in the direction
       the route was going) or runs between two placed stations (a parallel path: spread evenly between them, so a diamond keeps both junctions in line)
     * a branch takes the first lane, 1, -1, 2, -2 ... that is free over the rows it covers
     * a line that visits a station twice ("of" in the line file: the Circle) is a ring: a stem, then two columns joined by a U at each end, like the TfL strip map
   Pieces between stations are a short slant (45 degrees where there is room) next to the junction, then straight down the lane; corners are rounded and the
   piece is resampled every STEP units, because the engine builds the train lanes from the points. */
(function () {
  const GAP = { v: 100, h: 140 }, LANE_GAP = 96, WIDE_LANE_GAP = { v: 250, h: 150 }, STEP = 8, FILLET = 22, RING_W = 190, PAIR_DX = 26;
  const hyp = Math.hypot;

  const plen = P => { let l = 0; for (let i = 1; i < P.length; i++) l += hyp(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); return l; };
  function resample(P, step) {
    const cum = [0]; for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hyp(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const total = cum[cum.length - 1], n = Math.max(2, Math.round(total / step) + 1), out = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      const d = total * i / (n - 1);
      while (j < P.length - 2 && cum[j + 1] < d) j++;
      const seg = cum[j + 1] - cum[j] || 1, f = (d - cum[j]) / seg;
      out.push([P[j][0] + (P[j + 1][0] - P[j][0]) * f, P[j][1] + (P[j + 1][1] - P[j][1]) * f]);
    }
    return out;
  }
  function rounded(P, r) {                                  // corners as short curves
    if (P.length < 3) return P;
    const out = [P[0]];
    for (let i = 1; i < P.length - 1; i++) {
      const a = P[i - 1], b = P[i], c = P[i + 1], d1 = hyp(b[0] - a[0], b[1] - a[1]), d2 = hyp(c[0] - b[0], c[1] - b[1]), d = Math.min(r, d1 / 2, d2 / 2);
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (d < 1e-6 || Math.abs(cr) < 1e-6) { out.push(b); continue; }
      const p1 = [b[0] + (a[0] - b[0]) * d / d1, b[1] + (a[1] - b[1]) * d / d1], p2 = [b[0] + (c[0] - b[0]) * d / d2, b[1] + (c[1] - b[1]) * d / d2];
      for (let k = 0; k <= 8; k++) { const t = k / 8, u = 1 - t; out.push([u * u * p1[0] + 2 * u * t * b[0] + t * t * p2[0], u * u * p1[1] + 2 * u * t * b[1] + t * t * p2[1]]); }
    }
    out.push(P[P.length - 1]);
    return out;
  }
  // a piece between two stations: straight if in one lane, else a slant (45 degrees if there is room) beside the station nearer the middle lane
  function connector(A, B, lanes) {
    if (Math.abs(A[0] - B[0]) < 1e-6) return [A, B];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    if (Math.abs(dy) <= Math.abs(dx)) return [A, B];
    const sy = Math.sign(dy), h = Math.abs(dx);
    return Math.abs(lanes[0]) <= Math.abs(lanes[1]) ? [A, [B[0], A[1] + h * sy], B] : [A, [A[0], B[1] - h * sy], B];
  }
  function arc(cx, cy, r, a0, a1, n) {                      // points on a circle, angles in degrees (0 = right, 90 = down)
    const out = [];
    for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
    return out;
  }

  /* ---------- the general layout: spine, branches, parallel paths ---------- */
  function general(LINE, G, orient) {
    const ids = LINE.stations.map(s => s.id), routes = LINE.routes && LINE.routes.length ? LINE.routes : [ids];
    const spine = routes.reduce((b, r) => r.length > b.length ? r : b, routes[0]);
    const P = new Map(), occ = new Map();
    spine.forEach((id, i) => P.set(id, { lane: 0, row: i }));
    occ.set(0, [[0, spine.length - 1]]);
    const free = (lane, lo, hi) => !(occ.get(lane) || []).some(([a, b]) => a < hi - 1e-6 && lo < b - 1e-6);
    // a branch takes the first free lane; one that leaves or rejoins a branch lane goes outward of it (so its pieces do not cross the lanes between)
    const take = (lo, hi, anchors) => {
      const side = anchors.map(a => P.get(a).lane).filter(l => l !== 0), s = side.length ? Math.sign(side[0]) : 0;
      const order = s ? [...Array(8).keys()].map(i => s * (Math.max(...side.map(Math.abs)) + 1 + i)).concat([1, -1, 2, -2, 3, -3, 4, -4]) : [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6];
      for (const l of order) if (free(l, lo, hi)) { if (!occ.has(l)) occ.set(l, []); occ.get(l).push([lo, hi]); return l; }
      return 7;
    };
    const sgn = v => v > 0 ? 1 : v < 0 ? -1 : 0;
    // which way the rows run along route r at index i (looking at the nearest placed stations either side)
    function rowDir(r, i) {
      for (let k = i + 1; k < r.length; k++) if (P.has(r[k]) && P.get(r[k]).row !== P.get(r[i]).row) return sgn(P.get(r[k]).row - P.get(r[i]).row);
      for (let k = i - 1; k >= 0; k--) if (P.has(r[k]) && P.get(r[k]).row !== P.get(r[i]).row) return sgn(P.get(r[i]).row - P.get(r[k]).row);
      return 1;
    }
    for (let guard = 0; guard < 200; guard++) {
      let best = null, bestN = 0;
      routes.forEach(r => { const n = r.filter(id => !P.has(id)).length; if (n > bestN) { best = r; bestN = n; } });
      if (!best) break;
      const r = best;
      for (let i = 0; i < r.length;) {
        if (P.has(r[i])) { i++; continue; }
        let j = i; while (j < r.length && !P.has(r[j])) j++;
        const run = r.slice(i, j), k = run.length, p = i > 0 ? r[i - 1] : null, q = j < r.length ? r[j] : null;
        let rows, lo, hi;
        if (p && q && P.get(p).row !== P.get(q).row) {
          const rp = P.get(p).row, rq = P.get(q).row;
          rows = run.map((_, m) => rp + (rq - rp) * (m + 1) / (k + 1));
          lo = Math.min(rp, rq); hi = Math.max(rp, rq);
        } else if (p) {
          const d = rowDir(r, i - 1), rp = P.get(p).row, o = k <= 2 ? 0.5 : 1;     // a spur of one or two stations sits half a row off, so it does not take the label room of the trunk station beside it
          rows = run.map((_, m) => rp + d * (o + m));
          lo = Math.min(rp, rows[k - 1]); hi = Math.max(rp, rows[k - 1]);
        } else if (q) {
          const d = rowDir(r, j), rq = P.get(q).row, o = k <= 2 ? 0.5 : 1;
          rows = run.map((_, m) => rq - d * (k - m - 1 + o));
          lo = Math.min(rq, rows[0]); hi = Math.max(rq, rows[0]);
        } else { rows = run.map((_, m) => m); lo = 0; hi = k - 1; }
        const lane = take(lo, hi, [p, q].filter(Boolean));
        // a parallel path between two close rows would need a slant shallower than 30 degrees: bring its lane in a little so the slant stays steep
        const gapRows = p && q ? Math.abs(P.get(q).row - P.get(p).row) / (k + 1) : 1, xs = Math.max(0.45, Math.min(1, gapRows * G / (LANE_GAP * 0.95)));
        run.forEach((id, m) => P.set(id, { lane, row: rows[m], xs }));
        i = j;
      }
    }
    ids.forEach(id => { if (!P.has(id)) P.set(id, { lane: 7, row: 0 }); });
    const r0 = Math.min(...[...P.values()].map(v => v.row));
    // three lanes side by side leave the middle one no room for its labels (they would sit on the next lane): then the lanes are spread wide enough for a label between
    let stack = 0;
    for (let row = r0; row <= Math.max(...[...P.values()].map(v => v.row)); row += 0.5) { let n = 0; occ.forEach(iv => { if (iv.some(([a, b]) => a <= row && row <= b)) n++; }); stack = Math.max(stack, n); }
    const LG = stack >= 3 ? WIDE_LANE_GAP[orient] : LANE_GAP;
    const pos = {}, lane = {};
    P.forEach((v, id) => { pos[id] = [v.lane * LG * (v.xs || 1), (v.row - r0) * G]; lane[id] = v.lane; });
    const pieces = [], seen = new Set();
    routes.forEach(r => r.slice(1).forEach((b, i) => { const a = r[i], k = a + ">" + b, k2 = b + ">" + a; if (seen.has(k) || seen.has(k2)) return; seen.add(k); pieces.push([a, b]); }));
    const paths = {};
    pieces.forEach(([a, b]) => { paths[a + ">" + b] = connector(pos[a], pos[b], [lane[a], lane[b]]); });
    return { pos, lane, paths, pieces, ring: false };
  }

  /* ---------- a line that visits stations twice: stem, ring (two columns, a U at each end), and the second visits beside the first ---------- */
  function ring(LINE, G) {
    const r = LINE.routes[0], of = {};
    LINE.stations.forEach(s => { if (s.of) of[s.id] = s.of; });
    const real = r.filter(id => !of[id]), tail = r.filter(id => of[id]);
    const i0 = real.findIndex(id => tail.some(t => of[t] === id));          // the first station visited twice: the ring starts here
    const ringIds = real.slice(i0), n = ringIds.length, m = (n - 1) >> 1, hasBottom = n % 2 === 1;
    const pos = {}, lane = {}, paths = {};
    real.slice(0, i0).forEach((id, i) => { pos[id] = [0, i * G]; lane[id] = 0; });
    ringIds.slice(0, m).forEach((id, i) => { pos[id] = [0, (i0 + i) * G]; lane[id] = 0; });             // right column, going down
    const yBot = (i0 + m - 1) * G, W = RING_W;
    const left = ringIds.slice(hasBottom ? m + 1 : m);
    left.forEach((id, i) => { pos[id] = [-W, yBot - i * G]; lane[id] = -1; });                         // left column, going up
    if (hasBottom) { pos[ringIds[m]] = [-W / 2, yBot + W / 2]; lane[ringIds[m]] = 0; }
    tail.forEach((id, i) => { pos[id] = [-PAIR_DX, (i0 + i) * G]; lane[id] = 0; });                    // second visits: just left of the first, a row each
    // pieces along the route
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1], b = r[i], k = a + ">" + b;
      let pts;
      const ia = ringIds.indexOf(a), ib = ringIds.indexOf(b);
      if (hasBottom && ia === m - 1 && ib === m) pts = arc(-W / 2, yBot, W / 2, 0, 90, 12);                   // right column to the bottom station
      else if (hasBottom && ia === m && ib === m + 1) pts = arc(-W / 2, yBot, W / 2, 90, 180, 12);
      else if (of[b] && ia === ringIds.length - 1 && of[b]) { const x2 = pos[b][0]; pts = arc((-W + x2) / 2, pos[a][1], (x2 + W) / 2, 180, 360, 24); } // over the top into the second visit
      else pts = [pos[a], pos[b]];
      paths[k] = pts;
    }
    const pieces = r.slice(1).map((b, i) => [r[i], b]);
    return { pos, lane, paths, pieces, ring: true };
  }

  /* ---------- where the line crosses the Thames (from its True layout) ---------- */
  function crossings(T, pieces, pos, lane) {
    const marks = [];
    if (!T || !T.river || !T.paths) return marks;
    const R = T.river.pts;
    const inter = (a, b, c, d) => {
      const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
      if (Math.abs(den) < 1e-9) return null;
      const u = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den, v = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
      return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? u : null;
    };
    pieces.forEach(([a, b]) => {
      const tp = T.paths[a + ">" + b] || (T.paths[b + ">" + a] && T.paths[b + ">" + a].slice().reverse());
      if (!tp) return;
      const total = plen(tp); let acc = 0, hit = null;
      for (let i = 1; i < tp.length && hit === null; i++) {
        const l = hyp(tp[i][0] - tp[i - 1][0], tp[i][1] - tp[i - 1][1]);
        for (let j = 1; j < R.length; j++) { const u = inter(tp[i - 1], tp[i], R[j - 1], R[j]); if (u !== null) { hit = (acc + l * u) / total; break; } }
        acc += l;
      }
      if (hit !== null) marks.push({ a, b, f: hit });
    });
    return marks;
  }

  function build(LINE, orient, T) {
    const h = orient === "h", G = GAP[orient === "h" ? "h" : "v"];
    const hasOf = LINE.stations.some(s => s.of);
    const L = hasOf ? ring(LINE, G) : general(LINE, G, orient === 'h' ? 'h' : 'v');
    const pos = L.pos, paths = {};
    // dense, rounded pieces
    Object.keys(L.paths).forEach(k => { paths[k] = resample(rounded(L.paths[k], FILLET), STEP); paths[k][0] = L.paths[k][0].slice(); paths[k][paths[k].length - 1] = L.paths[k][L.paths[k].length - 1].slice(); });
    // the Thames: a band across the piece at the same fraction along it as the real crossing
    const marks = [];
    crossings(T, L.pieces, pos, L.lane).forEach(c => {
      const pp = paths[c.a + ">" + c.b] || (paths[c.b + ">" + c.a] && paths[c.b + ">" + c.a].slice().reverse());
      if (!pp) return;
      const tot = plen(pp); let acc = 0, x = pp[0][0], y = pp[0][1], ang = 90;
      for (let i = 1; i < pp.length; i++) {
        const l = hyp(pp[i][0] - pp[i - 1][0], pp[i][1] - pp[i - 1][1]);
        if (acc + l >= c.f * tot) { const f = (c.f * tot - acc) / (l || 1); x = pp[i - 1][0] + (pp[i][0] - pp[i - 1][0]) * f; y = pp[i - 1][1] + (pp[i][1] - pp[i - 1][1]) * f; ang = Math.atan2(pp[i][1] - pp[i - 1][1], pp[i][0] - pp[i - 1][0]) * 180 / Math.PI; break; }
        acc += l;
      }
      marks.push({ x, y, ang: ang + 90, len: 190, title: (T && T.name) || "The line crosses the Thames here" });
    });
    // label sides: outward from the middle lane (vertical); alternating above and below along a row of stations (horizontal)
    const pref = {};
    const ids = Object.keys(pos);
    ids.forEach((id, i) => {
      const ln = L.lane[id], row = Math.round(pos[id][1] / G);
      if (!h) pref[id] = ln < 0 ? "left" : "right";
      else pref[id] = ln === 0 ? (row % 2 ? "bottom" : "top") : (row % 2 ? (ln > 0 ? "bottom" : "top") : (ln > 0 ? "top" : "bottom"));   // alternate sides so neighbours' labels do not meet
    });
    const xs = ids.map(id => pos[id][0]), ys = ids.map(id => pos[id][1]);
    let ext = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    // turn it for a landscape screen: x and y change places (so the first station is at the left)
    let stations = {}, outPaths = {}, outMarks = marks;
    if (h) {
      ids.forEach(id => { stations[id] = [pos[id][1], pos[id][0]]; });
      Object.keys(paths).forEach(k => { outPaths[k] = paths[k].map(p => [p[1], p[0]]); });
      outMarks = marks.map(m => ({ ...m, x: m.y, y: m.x, ang: 270 - m.ang }));   // x and y swapped: a direction of travel t becomes 90 - t, and the band stays across it
      ext = [ext[1], ext[0], ext[3], ext[2]];
    } else {
      ids.forEach(id => { stations[id] = [pos[id][0], pos[id][1]]; });
      outPaths = paths;
    }
    // the stations are placed from a corner of 0,0 so everything is at a positive x and y
    const dx = 120 - ext[0], dy = 120 - ext[1];
    const sh = p => [p[0] + dx, p[1] + dy];
    Object.keys(stations).forEach(id => { stations[id] = sh(stations[id]); });
    Object.keys(outPaths).forEach(k => { outPaths[k] = outPaths[k].map(sh); });
    outMarks = outMarks.map(m => ({ ...m, x: m.x + dx, y: m.y + dy }));
    ext = [ext[0] + dx, ext[1] + dy, ext[2] + dx, ext[3] + dy];
    return { stations, pref, paths: outPaths, marks: outMarks, emptyAt: [Math.round((ext[0] + ext[2]) / 2), Math.round(ext[3] + (h ? 150 : 190))], extent: ext, orient, ring: L.ring };
  }

  window.UndercurrentLineView = { build, GAP, LANE_GAP };
})();
