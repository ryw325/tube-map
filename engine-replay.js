/* Project Undercurrent: live Tube map engine (shared by every line). Line data comes from lines/<id>.js. */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const API = "https://api.tfl.gov.uk";
  const POLL_MS = (/[?&]debug\b/.test(location.search) && /[?&]poll=(\d+)/.test(location.search)) ? +RegExp.$1 * 1000 : 30000;
  const STATUS_MS = 120000;

  /* ---------- Design constants (from the approved static prototype) ---------- */
  const CORNER = 6;
  const TRAIN_SCALE = 1.3;
  const TRAIN_LEN = 35 * TRAIN_SCALE;
  const TRAIN_HALF_H = 8 * TRAIN_SCALE;
  const LANE = 29;            // train centre from the track centre: clears station circles when passing
  const INNER_R = 60;         // radius of the lane on the inside of a bend, so trains never clip the track
  const LANE_OUTER = LANE + TRAIN_HALF_H;
  const CLEAR = LANE_OUTER + 6;
  const LABEL_GAP = 48;
  const GAP_L = TRAIN_LEN + 8; // minimum nose-to-tail spacing between trains in the same lane
  const DWELL_MS = 15000;      // every train waits this long at a platform

  function trainPath(r) {
    const x = -18 + r;
    return `M${x},-7 H10 L17,0 L10,7 H${x} A${r} ${r} 0 0 1 -18,${7 - r} V${-7 + r} A${r} ${r} 0 0 1 ${x},-7 Z`;
  }
  const CARRIAGE = trainPath(CORNER);
  document.querySelectorAll(".legend-train").forEach(p => p.setAttribute("d", CARRIAGE));

  /* ---------- Stations ---------- */
  const LINE = window.UNDERCURRENT_LINE;
  const S = LINE.stations.map(s => ({ ...s }));
  const VERSION = "2.5-replay";
  const dirLabel = d => LINE.dirs[d].label;
  // "Northbound" / "Eastbound" etc. from the platform name, used where the direction word changes along a line
  const platformWord = name => { const m = /^(\w+bound)\b/i.exec(name || ""); return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : ""; };
  const dirText = t => t.pdir || dirLabel(t.dir);

  /* ---------- Page set-up for this line ---------- */
  (function setUpPage() {
    const name = LINE.name + " line";
    document.title = `${LINE.name} Line Replay`;
    document.querySelector(".eyebrow").textContent = `Replay test · v${VERSION}`;
    document.getElementById("line-name").textContent = `${LINE.name} Line`;
    document.getElementById("stat-stations").textContent = LINE.stations.length;
    document.getElementById("dir-n").textContent = LINE.dirs.N.stat || LINE.dirs.N.label;
    document.getElementById("dir-s").textContent = LINE.dirs.S.stat || LINE.dirs.S.label;
    document.getElementById("map").setAttribute("aria-label", `Live schematic map of the ${name} showing each train`);
    document.getElementById("facts").setAttribute("aria-label", `${name} facts`);
    const st = document.createElement("style");
    st.textContent = `:root { --line: ${LINE.colour.light}; --train: ${LINE.train.light}; }
      @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --line: ${LINE.colour.dark}; --train: ${LINE.train.dark}; } }
      :root[data-theme="dark"] { --line: ${LINE.colour.dark}; --train: ${LINE.train.dark}; }`;
    document.head.appendChild(st);
    // line picker
    const pick = document.getElementById("line-pick");
    const head = document.createElement("option");
    head.value = ""; head.textContent = "Change line"; head.disabled = true; head.selected = true; head.hidden = true;
    pick.appendChild(head);
    (window.UNDERCURRENT_LINES || [{ id: LINE.id, name: LINE.name }]).forEach(l => {
      const o = document.createElement("option"); o.value = l.id;
      o.textContent = (l.id === LINE.id ? "✓ " : "") + `${l.name} line`;
      pick.appendChild(o);
    });
    pick.addEventListener("change", () => {
      if (!pick.value || pick.value === LINE.id) { pick.value = ""; return; }
      try { localStorage.setItem("line", pick.value); } catch (e) {}
      const q = new URLSearchParams(location.search); q.set("line", pick.value);
      location.search = q.toString();
    });
  })();
  const SPACING = LINE.spacing || 1.25;
  S.forEach(s => { s.x *= SPACING; s.y *= SPACING; });
  const LAST = S.length - 1;
  const byNaptan = Object.fromEntries(S.map((s, i) => [s.naptan, i]));

  // Track geometry: cumulative distance from the first station
  const segLen = S.slice(1).map((s, i) => Math.hypot(s.x - S[i].x, s.y - S[i].y));
  const cum = [0];
  segLen.forEach((l, i) => cum.push(cum[i] + l));

  // Typical running time (seconds) for each segment i -> i+1. Refined from live data as it arrives.
  const RUN = segLen.map((l, i) => (LINE.run && LINE.run[i]) || 120);

  const L = {
    bakerloo: ["Bakerloo", "#B36305"], central: ["Central", "#E32017"], circle: ["Circle", "#FFD300"],
    district: ["District", "#00782A"], hammersmith: ["Hammersmith & City", "#F3A9BB"],
    jubilee: ["Jubilee", "#A0A5A9"], metropolitan: ["Metropolitan", "#9B0056"],
    northern: ["Northern", "#000000"], piccadilly: ["Piccadilly", "#003688"],
    weaver: ["Weaver", "#972861", "ring"], suffragette: ["Suffragette", "#39B97A", "ring"],
    mildmay: ["Mildmay", "#437EC1", "ring"], windrush: ["Windrush", "#EF4D5E", "ring"],
    lioness: ["Lioness", "#F1B41C", "ring"], liberty: ["Liberty", "#676767", "ring"],
    elizabeth: ["Elizabeth", "#6950A1", "ring"], dlr: ["DLR", "#00AFAD", "ring"],
    waterloo: ["Waterloo & City", "#95CDBA"], victoria: ["Victoria", "#0098D4"],
    rail: ["National Rail", null, "rail"]
  };
  const IX = LINE.ix || {};

  /* ---------- SVG scaffolding ---------- */
  const svg = document.getElementById("map");
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    (parent || svg).appendChild(n);
    return n;
  };
  const riverG = el("g", { transform: `scale(${SPACING})` });
  if (LINE.river) {
    el("path", { class: "river", d: LINE.river.d }, riverG);
    el("text", { class: "river-label", x: LINE.river.label[0], y: LINE.river.label[1], "text-anchor": "middle" }, riverG).textContent = "Thames";
  }

  const trackD = "M " + S.map(s => s.x + " " + s.y).join(" L ");
  el("path", { class: "track", d: trackD });             // track under the trains
  const trainLayer = el("g", {});
  const content = el("g", {});                           // stations and labels, drawn above trains
  el("path", { class: "track", d: trackD, visibility: "hidden" }, content); // keeps the fitted view anchored to the line
  const stationLayer = el("g", {}, content);
  const labelLayer = el("g", {}, content);
  const stationNodes = [];
  S.forEach((s, i) => {
    const g = el("g", { class: "station-link", tabindex: "0", role: "button", "aria-label": `${s.name}: show departures` }, stationLayer);
    stationNodes[i] = g;
    el("circle", { class: "station-hit", cx: s.x, cy: s.y, r: 24 }, g);
    el("circle", { class: "station", cx: s.x, cy: s.y, r: 11 }, g);
    g.addEventListener("click", () => openBoard(i));
    g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openBoard(i); } });
  });
  const emptyMsg = el("text", { class: "empty-msg", "text-anchor": "middle", x: 520, y: 900 });
  emptyMsg.setAttribute("visibility", "hidden");

  /* ---------- Labels and interchange markers, placed clear of the train lanes ---------- */
  function railIcon(parent, cx, cy) {
    const g = el("g", { transform: `translate(${cx} ${cy})` }, parent);
    el("rect", { class: "ix-rail", x: -7.5, y: -7.5, width: 15, height: 15, rx: 3 }, g);
    el("path", { class: "ix-rail-glyph", d: "M-4.5,-2.5 H4.5 M2,-5 L4.5,-2.5 L2,0 M4.5,2.5 H-4.5 M-2,0 L-4.5,2.5 L-2,5" }, g);
    return g;
  }
  document.querySelectorAll(".legend .rail-icon").forEach(g => railIcon(g, 0, 0));

  // Interchange markers. Hover or focus expands them to show the line's name.
  const LIGHT = new Set(["#FFD300", "#F3A9BB", "#95CDBA"]); // pale tube colours get dark text for legibility
  const PILL_H = 27;
  function tween(from, to, ms, fn) {
    const t0 = __sim.realNow();
    const step = () => {
      const k = reduceMotionPref ? 1 : Math.min(1, (__sim.realNow() - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      fn(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const reduceMotionPref = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Markers in one row make room for each other: an expanded marker pushes its neighbours aside.
  // Each marker also gets an invisible hit area reaching halfway to its neighbours, so there are no dead gaps.
  function layoutRow(row) {
    const pos = row.items.map((it, i) => {
      let shift = 0;
      row.items.forEach((o, j) => {
        if (j === i || !o.extra) return;
        if (o.grow === "right" && i > j) shift += o.extra;
        else if (o.grow === "left" && i < j) shift -= o.extra;
        else if (o.grow === "centre") shift += i < j ? -o.extra / 2 : o.extra / 2;
      });
      const gx = it.x + shift;
      it.g.setAttribute("transform", `translate(${gx.toFixed(2)} ${it.y})`);
      return gx;
    });
    const y1 = Math.min(...row.items.map(it => it.ext.y1)) - 5, y2 = Math.max(...row.items.map(it => it.ext.y2)) + 5;
    row.items.forEach((it, i) => {
      const gx = pos[i];
      const L0 = gx + it.ext.x1, R0 = gx + it.ext.x2;
      const prev = row.items[i - 1], next = row.items[i + 1];
      const L = prev ? (pos[i - 1] + prev.ext.x2 + L0) / 2 : L0 - 5;
      const R = next ? (R0 + pos[i + 1] + next.ext.x1) / 2 : R0 + 5;
      it.hit.setAttribute("x", (L - gx).toFixed(2)); it.hit.setAttribute("width", Math.max(0, R - L).toFixed(2));
      it.hit.setAttribute("y", y1.toFixed(2)); it.hit.setAttribute("height", (y2 - y1).toFixed(2));
    });
  }

  // Only one marker is open at a time, and the dots in the open row grow to pill height
  let openIx = null;
  function setRowHot(row, hot) {
    clearTimeout(row.cool);
    const go = () => {
      if (row.hot === hot) return;
      row.hot = hot;
      tween(row.k, hot ? 1 : 0, 180, v => { row.k = v; row.items.forEach(it => it.render()); layoutRow(row); });
    };
    if (hot) go(); else row.cool = setTimeout(go, 160); // brief grace while moving between neighbours
  }

  function marker(parent, key, cx, cy, align, vert, row) {
    const [name, col, kind] = L[key];
    const grow = align === "end" ? "left" : align === "start" ? "right" : "centre";
    if (row.k === undefined) { row.k = 0; row.hot = false; }
    const g = el("g", { class: "ix", tabindex: "0", role: "img", "aria-label": kind === "rail" ? "National Rail" : `${name} line`, transform: `translate(${cx} ${cy})` }, parent);
    const hit = el("rect", { class: "ix-hit" }, g);
    const item = { g, hit, x: cx, y: cy, extra: 0, k: 0, grow: kind === "rail" && grow === "centre" ? "right" : grow, ext: { x1: -7.5, x2: 7.5, y1: -7.5, y2: 7.5 } };
    row.items.push(item);
    const onHover = on => {
      if (on) {
        if (openIx && openIx !== item) openIx.set(false);
        openIx = item;
        parent.appendChild(g);
        setRowHot(row, true);
      } else {
        if (openIx === item) openIx = null;
        if (!row.items.some(it => it === openIx)) setRowHot(row, false);
      }
      tween(item.k, on ? 1 : 0, 180, v => { item.k = v; item.render(); layoutRow(row); });
    };
    if (kind === "rail") {
      const inner = railIcon(g, 0, 0);
      const left = item.grow === "left";
      const label = el("text", { class: "ix-rail-text", "dominant-baseline": "central", "text-anchor": left ? "end" : "start", opacity: 0 }, g);
      label.textContent = "National Rail";
      item.render = () => {
        const sc = 1 + (PILL_H / 15 - 1) * 0.85 * row.k;     // icon grows with the row
        const w = 15 * sc, grown = w - 15;
        const dx = left ? -grown / 2 : grown / 2;
        const dy = vert === "up" ? -grown / 2 : vert === "down" ? grown / 2 : 0;
        inner.setAttribute("transform", `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) scale(${sc.toFixed(3)})`);
        const edge = left ? 7.5 - w : -7.5 + w;
        const tw = label.getComputedTextLength();
        label.setAttribute("x", (edge + (left ? -7 : 7)).toFixed(2));
        label.setAttribute("y", dy.toFixed(2));
        label.setAttribute("opacity", item.k.toFixed(2));
        const lab = (tw + 10) * item.k;
        item.ext = left ? { x1: 7.5 - w - lab, x2: 7.5, y1: dy - w / 2, y2: dy + w / 2 } : { x1: -7.5, x2: -7.5 + w + lab, y1: dy - w / 2, y2: dy + w / 2 };
        item.extra = grown + lab;
      };
      item.render();
      item.set = hoverable(g, onHover);
      return g;
    }
    const ring = kind === "ring";
    const d0 = ring ? 10 : 13;                  // collapsed diameter
    const shape = el("rect", {
      class: ring ? "ix-ring" : "ix-dot", x: -d0 / 2, y: -d0 / 2, width: d0, height: d0, rx: d0 / 2,
      [ring ? "stroke" : "fill"]: col
    }, g);
    const text = el("text", { class: "ix-text", x: 0, y: 0.5, "text-anchor": "middle", "dominant-baseline": "central", opacity: 0,
      fill: ring ? "var(--ink)" : (LIGHT.has(col) ? "#14213D" : "#FFFFFF") }, g);
    text.textContent = name;
    item.render = () => {
      const k = item.k;
      const dr = d0 + ((ring ? PILL_H - 3 : PILL_H) - d0) * row.k;  // dot grows to pill height while the row is active
      const full = text.getComputedTextLength() + 24;
      const w = dr + (Math.max(full, dr) - dr) * k, h = dr + (PILL_H - dr) * k;
      const x = item.grow === "right" ? -d0 / 2 : item.grow === "left" ? d0 / 2 - w : -w / 2;
      const y = vert === "up" ? d0 / 2 - h : vert === "down" ? -d0 / 2 : -h / 2;
      shape.setAttribute("x", x.toFixed(2)); shape.setAttribute("width", w.toFixed(2));
      shape.setAttribute("y", y.toFixed(2)); shape.setAttribute("height", h.toFixed(2));
      shape.setAttribute("rx", (h / 2).toFixed(2));
      text.setAttribute("x", (x + w / 2).toFixed(2));
      text.setAttribute("y", (y + h / 2 + 0.5).toFixed(2));
      text.setAttribute("opacity", Math.max(0, (k - 0.55) / 0.45).toFixed(2));
      item.ext = { x1: x, x2: x + w, y1: y, y2: y + h };
      item.extra = w - d0;
    };
    item.render();
    item.set = hoverable(g, onHover);
    return g;
  }
  function hoverable(g, fn) {
    let on = false;
    const set = v => { if (v !== on) { on = v; fn(v); } };
    g.addEventListener("mouseenter", () => set(true));
    g.addEventListener("mouseleave", () => set(false));
    g.addEventListener("focus", () => set(true));
    g.addEventListener("blur", () => set(false));
    g.addEventListener("click", () => set(!on));
    return set;
  }

  // geometry
  const segs = S.slice(1).map((s, i) => [S[i], s]);
  const ptSeg = (px, py, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    let k = ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy);
    k = Math.max(0, Math.min(1, k));
    return Math.hypot(px - (a.x + k * dx), py - (a.y + k * dy));
  };
  const ptRect = (px, py, r) => Math.hypot(Math.max(r.x - px, 0, px - r.x2), Math.max(r.y - py, 0, py - r.y2));
  const cross = (p, q, r, s) => {
    const d = (q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x);
    if (d === 0) return false;
    const u = ((r.x - p.x) * (s.y - r.y) - (r.y - p.y) * (s.x - r.x)) / d;
    const v = ((r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x)) / d;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  };
  function segRectDist(a, b, r) {
    if (ptRect(a.x, a.y, r) === 0 || ptRect(b.x, b.y, r) === 0) return 0;
    const c = [{ x: r.x, y: r.y }, { x: r.x2, y: r.y }, { x: r.x2, y: r.y2 }, { x: r.x, y: r.y2 }];
    for (let i = 0; i < 4; i++) if (cross(a, b, c[i], c[(i + 1) % 4])) return 0;
    return Math.min(ptRect(a.x, a.y, r), ptRect(b.x, b.y, r), ...c.map(p => ptSeg(p.x, p.y, a, b)));
  }
  const overlap = (p, q, pad) => !(p.x2 + pad < q.x || q.x2 + pad < p.x || p.y2 + pad < q.y || q.y2 + pad < p.y);

  // text measurement
  const meas = el("text", { class: "label", x: -9999, y: -9999, visibility: "hidden" });
  const width = str => { meas.textContent = str; return meas.getComputedTextLength(); };

  const LH = 23, ASC = 15, FS = 20, MK = 16, MK_GAP = 11;
  const DIRS = ["right", "left", "top", "bottom", "ne", "nw", "se", "sw"];

  // Build geometry for one candidate placement (no drawing)
  function candidate(s, dir, D) {
    const lines = s.lines || [s.name];
    const ws = lines.map(width);
    const W = Math.max(...ws), H = LH * (lines.length - 1) + FS;
    const items = IX[s.id] || [];
    const m = items.length, mW = m ? m * MK - 3 : 0;
    const k = D * 0.72;
    let align, ax, by; // align: start | end | middle, ax = anchor x
    switch (dir) {
      case "right": align = "start";  ax = s.x + D; by = s.y - H / 2; break;
      case "left":  align = "end";    ax = s.x - D; by = s.y - H / 2; break;
      case "top":   align = "middle"; ax = s.x;     by = s.y - D - H; break;
      case "bottom":align = "middle"; ax = s.x;     by = s.y + D; break;
      case "ne":    align = "start";  ax = s.x + k; by = s.y - k - H; break;
      case "se":    align = "start";  ax = s.x + k; by = s.y + k; break;
      case "nw":    align = "end";    ax = s.x - k; by = s.y - k - H; break;
      case "sw":    align = "end";    ax = s.x - k; by = s.y + k; break;
    }
    const tx0 = align === "start" ? ax : align === "end" ? ax - W : ax - W / 2;
    const rect = { x: tx0, y: by, x2: tx0 + W, y2: by + H };
    // markers
    const mks = [];
    if (m) {
      const midFirst = by + FS / 2;
      if (align === "start") {
        const x0 = ax + ws[0] + MK_GAP + 6.5;
        items.forEach((key, i) => mks.push([key, x0 + i * MK, midFirst]));
      } else if (align === "end") {
        const x0 = ax - ws[0] - MK_GAP - 6.5 - (m - 1) * MK;
        items.forEach((key, i) => mks.push([key, x0 + i * MK, midFirst]));
      } else {
        const my = dir === "top" ? by - 13 : by + H + 13;
        const x0 = ax - (m - 1) * MK / 2;
        items.forEach((key, i) => mks.push([key, x0 + i * MK, my]));
      }
      mks.forEach(([, cx, cy]) => {
        rect.x = Math.min(rect.x, cx - 7.5); rect.x2 = Math.max(rect.x2, cx + 7.5);
        rect.y = Math.min(rect.y, cy - 7.5); rect.y2 = Math.max(rect.y2, cy + 7.5);
      });
    }
    return { s, dir, lines, align, ax, by, rect, mks };
  }

  function cost(c, placed) {
    let bad = 0;
    segs.forEach(([a, b]) => {
      const d = segRectDist(a, b, c.rect);
      if (d < CLEAR) bad += (CLEAR - d) * 10;
    });
    placed.forEach(p => { if (overlap(c.rect, p.rect, 8)) bad += 500; });
    return bad;
  }

  function layout() {
    while (labelLayer.firstChild) labelLayer.firstChild.remove();
    const placed = [];
    S.forEach(s => {
      const order = [s.pref, ...DIRS.filter(d => d !== s.pref)];
      let best = null, bestCost = Infinity;
      outer:
      for (const D of [LABEL_GAP, LABEL_GAP + 12]) {
        for (const dir of order) {
          const c = candidate(s, dir, D);
          const k = cost(c, placed);
          if (k === 0) { best = c; bestCost = 0; break outer; }
          if (k < bestCost) { best = c; bestCost = k; }
        }
      }
      placed.push(best);
      s.labelRect = best.rect;
      const text = el("text", { class: "label clickable", "text-anchor": best.align }, labelLayer);
      text.addEventListener("click", () => openBoard(S.indexOf(s)));
      best.lines.forEach((ln, i) => {
        el("tspan", { x: best.ax, y: best.by + ASC + i * LH }, text).textContent = ln;
      });
      const row = { items: [] };
      openIx = null;
      best.mks.forEach(([key, cx, cy]) => marker(labelLayer, key, cx, cy, best.align, best.dir === "top" ? "up" : best.dir === "bottom" ? "down" : "mid", row));
      if (row.items.length) layoutRow(row);
    });
    fitView();
  }

  function fitView() {
    const bb = content.getBBox();
    // include the train lanes, which can sit outside the labels (e.g. below Brixton)
    const xs = S.map(s => s.x), ys = S.map(s => s.y), m = LANE_OUTER + 6;
    const x1 = Math.min(bb.x, Math.min(...xs) - m), y1 = Math.min(bb.y, Math.min(...ys) - m);
    const x2 = Math.max(bb.x + bb.width, Math.max(...xs) + m), y2 = Math.max(bb.y + bb.height, Math.max(...ys) + m);
    const pad = 56; // same clearance top and bottom
    // TfL credit sits inside the same boundary, aligned to the bottom-right of the map content
    let credit = svg.querySelector(".map-credit");
    if (!credit) { credit = el("text", { class: "map-credit", "text-anchor": "end" }); credit.textContent = "Powered by TfL Open Data"; }
    credit.setAttribute("x", x2.toFixed(0)); credit.setAttribute("y", y2.toFixed(0));
    svg.setAttribute("viewBox", `${(x1 - pad).toFixed(0)} ${(y1 - pad).toFixed(0)} ${(x2 - x1 + pad * 2).toFixed(0)} ${(y2 - y1 + pad * 2).toFixed(0)}`);
  }


  layout();
  if (document.fonts) {
    document.fonts.load('500 20px "Outfit"').then(layout).catch(() => {});
    document.fonts.addEventListener && document.fonts.addEventListener("loadingdone", layout);
    document.fonts.ready.then(layout);
  }

  /* ---------- Live state ---------- */
  const trains = new Map();   // vehicleId -> train state
  let lastFetch = 0, lastOk = 0, fetchError = null, everLoaded = false;

  function apiUrl(path) {
    let key = "";
    try { key = localStorage.getItem("tfl-app-key") || ""; } catch (e) {}
    return API + path + (key ? (path.includes("?") ? "&" : "?") + "app_key=" + encodeURIComponent(key) : "");
  }

  // Direction of a prediction: "S" = towards the last station (index increasing), "N" = towards the first
  function directionOf(p, nextIdx) {
    const destIdx = byNaptan[p.destinationNaptanId];
    if (destIdx !== undefined && destIdx !== nextIdx) return destIdx > nextIdx ? "S" : "N";
    if (destIdx === LAST) return "S";
    if (destIdx === 0) return "N";
    const plat = (p.platformName || "").toLowerCase();
    if (LINE.dirs.S.platform.some(w => plat.startsWith(w))) return "S";
    if (LINE.dirs.N.platform.some(w => plat.startsWith(w))) return "N";
    return null;
  }

  function learnRunTimes(preds) {
    // For one vehicle, consecutive stations in its own direction give running time + dwell.
    for (let i = 1; i < preds.length; i++) {
      const a = preds[i - 1], b = preds[i];
      if (a.dir !== b.dir || Math.abs(a.idx - b.idx) !== 1) continue;
      const dt = b.tts - a.tts;
      if (dt < 40 || dt > 400) continue;
      const seg = Math.min(a.idx, b.idx);
      RUN[seg] = RUN[seg] * 0.9 + dt * 0.1;
    }
  }

  const DEBUG = /[?&]debug\b/.test(location.search) ? { departures: [] } : null;
  const sgn = dir => dir === "S" ? 1 : -1;
  const segOf = D => { let i = 0; while (i < segLen.length - 1 && D > cum[i + 1]) i++; return i; };
  const nominalSpeed = seg => segLen[seg] / Math.max(40, RUN[seg] - 15); // track px per second

  /* ---------- Train lanes ----------
     Each direction runs in its own lane on its left of the track. On the outside of a bend the lane
     wraps round the station; on the inside it takes a wider curve so the carriage never clips the track. */
  function buildLane(dir) {
    const side = sgn(dir);
    const u = segLen.map((l, i) => ({ x: (S[i + 1].x - S[i].x) / l, y: (S[i + 1].y - S[i].y) / l }));
    const n = u.map(v => ({ x: side * v.y, y: -side * v.x }));
    const pts = [], anchorsIdx = [];
    const push = (x, y) => pts.push({ x, y });
    push(S[0].x + n[0].x * LANE, S[0].y + n[0].y * LANE); anchorsIdx.push(0);
    const arc = (cx, cy, r, a1, a2) => {
      let da = a2 - a1; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
      const steps = Math.max(6, Math.ceil(Math.abs(da) / (Math.PI / 90)));
      const start = pts.length;
      for (let i = 0; i <= steps; i++) { const a = a1 + da * i / steps; push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
      return start + Math.round(steps / 2);
    };
    for (let k = 1; k < LAST; k++) {
      const V = S[k], u1 = u[k - 1], u2 = u[k], n1 = n[k - 1], n2 = n[k];
      const cross = u1.x * u2.y - u1.y * u2.x;
      if (Math.abs(cross) < 1e-4) { push(V.x + n1.x * LANE, V.y + n1.y * LANE); anchorsIdx.push(pts.length - 1); continue; }
      const inside = n1.x * u2.x + n1.y * u2.y > 0;
      if (!inside) {
        anchorsIdx.push(arc(V.x, V.y, LANE, Math.atan2(n1.y, n1.x), Math.atan2(n2.y, n2.x)));
      } else {
        let bx = n1.x + n2.x, by = n1.y + n2.y; const bl = Math.hypot(bx, by); bx /= bl; by /= bl;
        const c = (LANE + INNER_R) / (bx * n1.x + by * n1.y);
        const Cx = V.x + bx * c, Cy = V.y + by * c;
        anchorsIdx.push(arc(Cx, Cy, INNER_R, Math.atan2(-n1.y, -n1.x), Math.atan2(-n2.y, -n2.x)));
      }
    }
    const nl = n[LAST - 1];
    push(S[LAST].x + nl.x * LANE, S[LAST].y + nl.y * LANE); anchorsIdx.push(pts.length - 1);
    const cl = [0];
    for (let i = 1; i < pts.length; i++) cl.push(cl[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    return { pts, cl, anchors: anchorsIdx.map(i => cl[i]), total: cl[cl.length - 1] };
  }
  const LANES = { S: buildLane("S"), N: buildLane("N") };

  // track distance <-> lane distance (piecewise linear between stations)
  function toL(D, dir) {
    const A = LANES[dir].anchors, i = segOf(D);
    return A[i] + (Math.max(0, Math.min(segLen[i], D - cum[i])) / segLen[i]) * (A[i + 1] - A[i]);
  }
  function fromL(Lv, dir) {
    const A = LANES[dir].anchors;
    let i = 0; while (i < A.length - 2 && Lv > A[i + 1]) i++;
    return cum[i] + Math.max(0, Math.min(1, (Lv - A[i]) / (A[i + 1] - A[i]))) * segLen[i];
  }
  function poseAtL(Lv, dir) {
    const { pts, cl } = LANES[dir];
    let lo = 0, hi = cl.length - 1;
    Lv = Math.max(0, Math.min(cl[hi], Lv));
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cl[mid] <= Lv) lo = mid; else hi = mid; }
    const a = pts[lo], b = pts[hi], f = cl[hi] > cl[lo] ? (Lv - cl[lo]) / (cl[hi] - cl[lo]) : 0;
    let ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    if (dir === "N") ang += 180;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, ang };
  }
  const poseAt = (D, dir) => poseAtL(toL(D, dir), dir);

  const boardData = new Map(); // station index -> predictions at that station
  const orderStrikes = new Map(); // "front>back" -> updates in a row the data has had them the other way round
  function ingest(data) {
    const now = performance.now();
    const groups = new Map();
    boardData.clear();
    data.forEach(p => {
      const idx = byNaptan[p.naptanId];
      if (idx === undefined) return;
      const dir = directionOf(p, idx);
      if (!dir) return;
      const list = boardData.get(idx) || boardData.set(idx, []).get(idx);
      const key = (p.vehicleId || "").trim() || p.id;
      const existing = list.find(x => x.key === key && x.dir === dir);
      if (existing && existing.tts <= p.timeToStation) return;
      if (existing) list.splice(list.indexOf(existing), 1);
      list.push({ key, dir, tts: p.timeToStation, fetchedAt: now,
        dest: byNaptan[p.destinationNaptanId], destName: (p.destinationName || "").replace(/ Underground Station$/, ""),
        pdir: platformWord(p.platformName),
        platform: (p.platformName || "").replace(/^\w+bound\s*-\s*/i, "") });
    });
    data.forEach(p => {
      const v = (p.vehicleId || "").trim();
      const idx = byNaptan[p.naptanId];
      if (!v || v === "000" || idx === undefined) return;
      const dir = directionOf(p, idx);
      if (!dir) return;
      (groups.get(v) || groups.set(v, []).get(v)).push({
        idx, dir, tts: p.timeToStation, loc: p.currentLocation || "", dest: byNaptan[p.destinationNaptanId], pdir: platformWord(p.platformName)
      });
    });

    const seen = new Set();
    const isTerm = k => k === 0 || k === LAST;
    const termAhead = t => t.dir === "S" ? LAST : 0;          // terminus a train is heading for
    const termBehind = dir => dir === "S" ? 0 : LAST;          // terminus a train in `dir` has just left
    const opp = d => d === "S" ? "N" : "S";

    groups.forEach((preds, v) => {
      preds.sort((a, b) => a.tts - b.tts);
      learnRunTimes(preds);
      const next = preds[0];
      const s = sgn(next.dir);
      seen.add(v);

      // this train's own timetable: remaining stops in order, each with an arrival time
      const best = new Map();
      preds.forEach(p => {
        if (p.dir !== next.dir || s * (p.idx - next.idx) < 0) return;
        if (!best.has(p.idx) || best.get(p.idx).tts > p.tts) best.set(p.idx, p);
      });
      const stops = [...best.values()].sort((a, b) => s * (a.idx - b.idx));
      let lastAt = 0;
      stops.forEach(p => { p.at = Math.max(now + p.tts * 1000, lastAt ? lastAt + 15000 : 0); lastAt = p.at; });
      const feedDest = next.dest !== undefined ? next.dest : (next.dir === "S" ? LAST : 0);

      // Has this train just left a terminus? (first stop ahead is the one after Brixton / Walthamstow Central)
      const from = termBehind(next.dir);
      const justLeft = next.idx === from + s || next.idx === from + 2 * s;

      let t = trains.get(v);
      // A new Vehicle ID leaving a terminus takes over a waiting train, but only one that has waited longer
      // than any normal turn-round (otherwise it's a different train and the waiting one keeps its place)
      if (!t && justLeft) {
        const q = waitingAt(from).filter(w => now - w.waitSince >= RENUMBER_MS);
        const front = q[0];
        if (front) { trains.delete(front.v); front.renumberedFrom = front.v; front.v = v; trains.set(v, front); t = front; }
      }
      const isNew = !t;
      if (isNew) {
        t = { v, opacity: 0, x: null, y: null, ang: 0, node: null, D: null, pendingD: null, arrivedAt: null,
              waiting: null, queued: false, dest: feedDest, destCand: null, destCandN: 0, alertUntil: 0 };
        trains.set(v, t);
      }

      // Waiting at a terminus and the feed now shows it leaving: fill in its label and send it on its way
      if (t.waiting !== null && next.dir === opp(t.arrDir) && leavingTerminus(next, t.waiting)) {
        departFrom(t, now);
      }
      if (t.waiting !== null) { t.fetchedAt = now; t.missed = 0; return; }   // still waiting: no data about leaving yet

      // Still running into Brixton / Walthamstow Central on screen, but the feed already shows it heading back out:
      // hurry it in, turn it round quickly and send it on with the new data (only when it is close to the end)
      if (!isNew && !t.loop && t.pendingD === null && t.D !== null && t.dir !== next.dir && termAhead(t) === from) {
        const nearEnd = from === LAST ? segOf(t.D) >= LAST - 2 : segOf(t.D) <= 1;
        if (nearEnd || t.rush) {
          t.rush = true; t.turnAt = from; t.stops = [{ idx: from, at: now }]; t.midWait = null;
          // only carry the new data through if it shows the train actually on its way out; otherwise it just waits there
          t.after = leavingTerminus(next, from) ? { next, stops, feedDest, fetchedAt: now } : null;
          t.fetchedAt = now; t.missed = 0;
          return;
        }
      }
      const heldAt = t.midWait;                                       // was holding at a mid-line terminus
      t.rush = false; t.after = null; t.midWait = null;

      const flipped = !isNew && t.dir !== next.dir;
      const prevDest = t.dest;
      Object.assign(t, { dir: next.dir, next: next.idx, tts: next.tts, loc: next.loc, pdir: next.pdir, stops, fetchedAt: now, missed: 0 });
      t.turnAt = null;

      // Destination: only accept a change once it has held for two updates, then flag it for 30 seconds
      if (isNew || t.freshDepart) { t.dest = feedDest; t.destCand = null; t.destCandN = 0; t.freshDepart = false; }
      else if (feedDest !== prevDest) {
        if (t.destCand === feedDest) t.destCandN++; else { t.destCand = feedDest; t.destCandN = 1; }
        if (t.destCandN >= 2) { t.dest = feedDest; t.destCand = null; t.destCandN = 0; if (!flipped) t.alertUntil = now + 30000; }
      } else { t.destCand = null; t.destCandN = 0; }

      if (isNew) {
        if (justLeft) { t.D = cum[from]; t.arrivedAt = now - DWELL_MS; t.needsPlace = false; t.freshDepart = false; } // brand-new: start at the platform
        else { t.D = modelD(t, now); t.needsPlace = true; }
      } else if (flipped) {
        // turned back where it was holding (e.g. Seven Sisters): swap lanes there; otherwise go where the data puts it
        t.pendingD = heldAt != null && heldAt === next.idx - s ? cum[heldAt] : modelD(t, now);
        t.noDwell = true;                                               // it has already left in real life
      } else {
        const model = modelD(t, now);
        if (s * (model - t.D) > Math.max(220, segLen[segOf(t.D)] * 1.2)) t.pendingD = model; // far behind (missed updates)
      }
    });

    trains.forEach((t, v) => {
      if (seen.has(v)) return;
      if (t.waiting !== null) return;                                    // waiting trains never time out here
      // Vanished while heading into Brixton / Walthamstow Central: it is turning round, so keep it
      if (t.pendingD === null && t.next === termAhead(t)) { t.turnAt = t.next; t.missed = 0; return; }
      // Vanished while terminating mid-line: hold at that platform for a while in case it reappears
      const lastStop = t.stops && t.stops.length ? t.stops[t.stops.length - 1].idx : t.next;
      if (t.pendingD === null && !t.rush && !isTerm(lastStop) && lastStop === t.dest) {
        if (t.midWait == null) { t.midWait = lastStop; t.midSince = now; }
        if (now - t.midSince < MID_GRACE_MS) { t.missed = 0; return; }
      }
      t.missed = (t.missed || 0) + 1;
    });
    // Order check: if the data puts a train ahead of the one in front of it on screen for two updates in a row,
    // swap them (both fade and reappear in each other's place) instead of queueing it forever
    const inOrder = new Set();
    ["N", "S"].forEach(dir => {
      const s = sgn(dir);
      const line = [...trains.values()].filter(t => t.dir === dir && t.fetchedAt === now && t.missed === 0 && t.D !== null &&
        t.pendingD === null && !t.loop && !t.rush && !t.needsPlace && t.midWait == null && (t.waiting === null || t.waiting === undefined) && !t.retiring)
        .sort((a, b) => s * (b.D - a.D));                                   // screen order, front first
      for (let i = 0; i + 1 < line.length; i++) {
        const front = line[i], back = line[i + 1];
        const key = front.v + ">" + back.v;
        const wrong = back.next !== front.next ? s * (back.next - front.next) > 0 : back.tts < front.tts - 10;
        if (!wrong) continue;
        inOrder.add(key);
        orderStrikes.set(key, (orderStrikes.get(key) || 0) + 1);
        if (orderStrikes.get(key) >= 2) {
          const a = front.D, b = back.D;
          front.pendingD = b; back.pendingD = a; front.noDwell = back.noDwell = true;
          orderStrikes.delete(key);
          if (DEBUG) (DEBUG.swaps = DEBUG.swaps || []).push(`${back.v} ahead of ${front.v}`);
        }
      }
    });
    orderStrikes.forEach((n, key) => { if (!inOrder.has(key)) orderStrikes.delete(key); });

    // Late at night: a train left waiting with nothing following it goes out of service
    trains.forEach(t => { if (t.waiting !== null && now - t.waitSince > WAIT_MAX_MS) retire(t); });
  }

  /* ---------- Terminus turn-rounds ---------- */
  function waitingAt(k) {
    return [...trains.values()].filter(t => t.waiting === k && !t.retiring).sort((a, b) => a.waitSince - b.waitSince);
  }
  // Does this prediction show a train actually on its way out of terminus k? (not just a timetabled departure)
  function leavingTerminus(next, k) {
    const adj = k === 0 ? 1 : LAST - 1;
    if (next.idx === adj) return true;                                    // next stop is Stockwell / Blackhorse Road
    const loc = (next.loc || "").trim().toLowerCase();
    if (!loc || loc === "0") return false;                                // placeholder: still sitting at the platform
    const term = S[k].name.toLowerCase().split(" ")[0];
    if (loc.startsWith("at " + term) || loc.startsWith(term)) return false; // "At Brixton", "Brixton Area" with a far-off first stop
    return true;                                                          // somewhere real on the line
  }
  const RENUMBER_MS = 8 * 60000;     // longer than any real turn-round seen (3-7 minutes)
  const WAIT_MAX_MS = 10 * 60000;    // a train left waiting this long has gone out of service
  function retire(t) { t.retiring = true; t.missed = 2; t.waiting = null; t.midWait = null; }
  const MID_GRACE_MS = 8 * 60000;   // how long a train that terminated mid-line is kept if it drops out of the feed
  // Arrived at the platform: turn round into the departing lane (or queue on the arrival platform) and wait
  function arriveAtTerminus(t, k, now) {
    const q = waitingAt(k);
    if (q.length >= 2) retire(q[0]);                       // only two platforms: the oldest has gone out of service
    t.waiting = k; t.waitSince = now; t.arrDir = t.dir; t.turnAt = null; t.stops = []; t.loc = "";
    const others = waitingAt(k).filter(w => w !== t);
    if (others.some(w => !w.queued)) { t.queued = true; return; }   // other platform: stays in the arrival lane for now
    const earlier = others.find(w => w.queued);
    if (earlier) { turnRound(earlier, now); t.queued = true; }       // the train that arrived first leaves first
    else turnRound(t, now);
    if (t.rush && !t.after) t.rush = false;
    if (t.rush && t.after) {
      const a = t.after;
      departFrom(t, now, true);
      Object.assign(t, { dir: a.next.dir, next: a.next.idx, tts: a.next.tts, loc: a.next.loc, stops: a.stops,
        fetchedAt: a.fetchedAt, dest: a.feedDest, freshDepart: false, rush: false, after: null });
    }
  }
  // U-turn: carry the train round the far side of the terminus station, from the arrival lane to the departure lane
  function turnRound(t, now) {
    t.queued = false;
    const k = t.waiting !== null && t.waiting !== undefined ? t.waiting : (t.dir === "S" ? LAST : 0);
    const V = S[k], W = S[k === 0 ? 1 : LAST - 1];
    let ux = V.x - W.x, uy = V.y - W.y; const ul = Math.hypot(ux, uy); ux /= ul; uy /= ul;   // pointing beyond the end of the line
    const pa = poseAt(cum[k], t.dir);                                                     // arrival-lane end
    const a0 = Math.atan2(pa.y - V.y, pa.x - V.x), r = Math.hypot(pa.x - V.x, pa.y - V.y);
    const au = Math.atan2(uy, ux);
    let d = ((au - a0 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;                          // quarter turn towards "beyond"
    const sweep = d >= 0 ? 1 : -1;
    t.loop = { cx: V.x, cy: V.y, r, a0, sweep, p: t.x === null ? 1 : 0, k };
    t.turnFrom = null;
    t.dir = t.dir === "S" ? "N" : "S";
  }
  const LOOP_S = 15;    // seconds to go round (unhurried, like a real turn-round)
  const LOOP_FAST_S = 2; // when the feed already shows it has left
  function loopPose(L) {
    const th = L.a0 + L.sweep * Math.PI * L.p;
    const x = L.cx + Math.cos(th) * L.r, y = L.cy + Math.sin(th) * L.r;
    const hx = -Math.sin(th) * L.sweep, hy = Math.cos(th) * L.sweep;                       // direction of travel
    return { x, y, ang: Math.atan2(hy, hx) * 180 / Math.PI };
  }
  // Is the departure side of this terminus clear of a train that has only just left?
  function departureClear(t, all) {
    const L0 = toL(cum[t.loop.k], t.dir);
    return !all.some(o => o !== t && o.dir === t.dir && o.D !== null && !o.loop && (o.waiting === null || o.waiting === undefined) &&
      !o.retiring && Math.abs(toL(o.D, o.dir) - L0) < GAP_L + 6);
  }
  function departFrom(t, now, late) {
    const k = t.waiting;
    // any train that arrived before this one and is still waiting can't be leaving: it has gone out of service
    // (skipped when this train was running late on screen, since it may really have arrived first)
    // trains leave in any order (two platforms), so nothing else is retired here
    if (t.queued) turnRound(t, now);
    t.waiting = null; t.queued = false; t.freshDepart = true; t.hurry = true;   // already gone: finish the turn quickly
    t.arrivedAt = now - DWELL_MS;                          // it has already left in real life: no extra dwell
    // promote the other waiting train into the departing lane
    const rest = waitingAt(k); if (rest[0] && rest[0].queued) turnRound(rest[0], now);
  }

  // Best estimate of where the data puts a train; used to place new trains and correct big drift
  function modelD(t, now) {
    const s = sgn(t.dir);
    const e = t.tts - (now - t.fetchedAt) / 1000;
    const prev = t.next - s;
    const loc = t.loc.toLowerCase();
    const first = name => name.toLowerCase().split(" ")[0];
    if (prev < 0 || prev > LAST) return cum[t.next];
    if (e <= 20 || (loc.startsWith("at ") && loc.includes(first(S[t.next].name)))) return cum[t.next];
    const run = RUN[Math.min(prev, t.next)];
    if (e >= run) return cum[prev];
    return cum[prev] + (cum[t.next] - cum[prev]) * (1 - e / run);
  }

  // Order two trains by where the data puts them: next station further along first, then sooner arrival.
  // Negative when a is ahead of b. Trains in different directions keep their order.
  function dataAhead(a, b) {
    if (a.dir !== b.dir) return 0;
    const s = sgn(a.dir);
    if (a.next !== b.next) return s * (b.next - a.next);
    return a.tts - b.tts;
  }

  // Put a train where it doesn't overlap another in its lane (queues it behind)
  function clearSpot(t, D, all) {
    const s = sgn(t.dir);
    let Lv = toL(D, t.dir);
    const others = all.filter(o => o !== t && o.dir === t.dir && o.D !== null && o.missed < 2 && o.pendingD === null && !o.needsPlace)
      .map(o => toL(o.D, o.dir)).sort((a, b) => s * (b - a)); // front first
    for (const Lo of others) if (Math.abs(Lo - Lv) < GAP_L) Lv = Lo - s * GAP_L;
    Lv = Math.max(0, Math.min(LANES[t.dir].total, Lv));
    return fromL(Lv, t.dir);
  }

  function stationAt(D) { for (let k = 0; k <= LAST; k++) if (Math.abs(D - cum[k]) < 0.5) return k; return -1; }

  // Advance one train along the track for this frame
  const CATCH = 4;   // top speed, as a multiple of normal, when catching up after a backlog
  function advance(t, now, dt, all) {
    if (t.waiting !== null || t.retiring || t.loop) { t.moving = false; return; }   // never leave a terminus without data
    const s = sgn(t.dir);
    const D = t.D;
    const here = stationAt(D);
    if (t.turnAt !== null && t.turnAt !== undefined && here === t.turnAt) { arriveAtTerminus(t, here, now); t.moving = false; return; }
    if (here >= 0 && t.arrivedAt === null) { t.arrivedAt = (t.noDwell || t.rush) ? now - DWELL_MS : now; t.noDwell = false; }
    if (here < 0) t.arrivedAt = null;

    let target = t.stops.find(st => s * (cum[st.idx] - D) > 0.5);
    let targetD, arriveAt = null;
    if (target) { targetD = cum[target.idx]; arriveAt = target.at; }
    else { t.moving = false; return; }   // no prediction for any station ahead: never head somewhere the data doesn't say

    // every train waits 15 seconds at a platform
    if (here >= 0 && now - t.arrivedAt < DWELL_MS) { t.moving = false; return; }

    const remaining = Math.abs(targetD - D);
    const vNom = nominalSpeed(segOf(D + s));
    const timeLeft = arriveAt === null ? null : (arriveAt - now) / 1000;
    let speed;
    if (timeLeft !== null && timeLeft > 0.5) speed = remaining / timeLeft;
    else if (timeLeft !== null) speed = vNom * (1 + Math.min(CATCH - 1, -timeLeft / 10));   // overdue: speed up the longer it's late
    else speed = vNom;
    if (t.rush) speed = CATCH * vNom;
    speed = Math.max(0.2 * vNom, Math.min(CATCH * vNom, speed));
    let step = Math.min(remaining, speed * dt);

    // wait behind the train in front rather than overlapping it
    const Lme = toL(D, t.dir);
    let room = Infinity;
    all.forEach(o => {
      if (o === t || o.dir !== t.dir || o.D === null || o.missed >= 2 || o.pendingD !== null) return;
      if (o.waiting !== null && o.waiting !== undefined && t.turnAt === o.waiting) return; // a full platform means one has left service
      const ahead = s * (toL(o.D, o.dir) - Lme);
      if (o.midWait != null && ahead > 0 && ahead - GAP_L < 30) { retire(o); return; }   // the next train needs that platform: it has gone to the sidings
      if (ahead > 0) room = Math.min(room, ahead - GAP_L);
    });
    if (room < Infinity) {
      const maxD = fromL(Lme + s * Math.max(0, room), t.dir);
      step = Math.max(0, Math.min(step, s * (maxD - D)));
    }

    if (here >= 0 && step > 0 && DEBUG) DEBUG.departures.push(Math.round((now - t.arrivedAt) / 100) / 10);
    t.D = D + s * step;
    if (Math.abs(t.D - targetD) < 0.5) t.D = targetD;
    t.moving = step > 0;
  }

  /* ---------- Drawing ---------- */
  let mode = "dest";
  const labelFor = t => (t.waiting !== null && t.waiting !== undefined) ? "" : (mode === "dest" ? S[t.dest].code : t.v);

  function ensureNode(t) {
    if (t.node) return;
    const g = el("g", { class: "train", tabindex: "0", role: "img" }, trainLayer);
    el("path", { class: "train-body", d: CARRIAGE }, g);
    t.text = el("text", { class: "train-num", x: 0, y: 0, "text-anchor": "middle", "dominant-baseline": "central" }, g);
    g.addEventListener("mouseenter", () => showTip(t));
    g.addEventListener("mouseleave", hideTip);
    g.addEventListener("focus", () => showTip(t));
    g.addEventListener("blur", hideTip);
    g.addEventListener("click", e => { e.stopPropagation(); hideTip(); openTrain(t); });
    g.addEventListener("keydown", e => { if (e.key === "Enter") { hideTip(); openTrain(t); } });
    t.node = g;
  }

  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let lastFrame = performance.now();

  // Yellow tag beside a train for 30 seconds after its destination changes
  const alertLayer = el("g", {});
  function drawAlert(t, now, dt) {
    const on = now < (t.alertUntil || 0) && (t.waiting === null || t.waiting === undefined) && t.opacity > 0.5;
    if (!on) { if (t.alert) { t.alert.remove(); t.alert = null; } t.alertSlot = null; return; }
    if (!t.alert) {
      t.alert = el("g", { class: "dest-alert", role: "button", tabindex: "0", "aria-label": "Dismiss destination change" }, alertLayer);
      t.alertRect = el("rect", { rx: 6, height: 24, y: -12 }, t.alert);
      t.alertText = el("text", { x: 0, y: 0.5, "text-anchor": "middle", "dominant-baseline": "central" }, t.alert);
      const dismiss = e => { e.stopPropagation(); t.alertUntil = 0; };
      t.alert.addEventListener("click", dismiss);
      t.alert.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") dismiss(e); });
    }
    const txt = `Now to ${S[t.dest].code}`;
    if (t.alertText.textContent !== txt) {
      t.alertText.textContent = txt;
      t.alertW = t.alertText.getComputedTextLength() + 16;
      t.alertRect.setAttribute("x", (-t.alertW / 2).toFixed(1)); t.alertRect.setAttribute("width", t.alertW.toFixed(1));
    }
    // choose a spot that covers no train (each carriage modelled as three circles along its length)
    const bodies = [];
    trains.forEach(o => {
      if (o.x === null || o.opacity < 0.1) return;
      const a = o.ang * Math.PI / 180, cx = Math.cos(a), cy = Math.sin(a);
      [-15, 0, 15].forEach(d => bodies.push([o.x + cx * d, o.y + cy * d]));
    });
    const hw = t.alertW / 2 + 4, hh = 16, R = 13;
    const trainGap = (x, y) => bodies.length ? Math.min(...bodies.map(([bx, by]) =>
      Math.hypot(Math.max(Math.abs(bx - x) - hw, 0), Math.max(Math.abs(by - y) - hh, 0)) - R)) : 99;
    // station names, their interchange dots and the station circles are obstacles too
    const mapGap = (x, y) => {
      let m = 99;
      S.forEach(st => {
        const r = st.labelRect;
        if (r) m = Math.min(m, Math.hypot(Math.max(r.x - (x + hw), (x - hw) - r.x2, 0), Math.max(r.y - (y + hh), (y - hh) - r.y2, 0)) - 2);
        m = Math.min(m, Math.hypot(Math.max(Math.abs(st.x - x) - hw, 0), Math.max(Math.abs(st.y - y) - hh, 0)) - 13);
      });
      return m;
    };
    const a = t.ang * Math.PI / 180, nx = Math.sin(a), ny = -Math.cos(a), ax = Math.cos(a), ay = Math.sin(a);
    const at = c => ({ x: t.x + nx * c.d * c.side + ax * c.along, y: t.y + ny * c.d * c.side + ay * c.along });
    const pick = () => {
      const cands = [];
      for (const d of [38, 54, 72, 92, 116]) for (const side of [1, -1]) for (const along of [0, 40, -40]) {
        const c = { d, side, along }, q = at(c);
        c.map = mapGap(q.x, q.y); c.c = Math.min(c.map, trainGap(q.x, q.y));
        cands.push(c);
      }
      // first choice: clear of everything; then clear of the map at least; otherwise the least bad
      return cands.find(c => c.c >= 0) || cands.find(c => c.map >= 0) || cands.reduce((m, c) => c.c > m.c ? c : m);
    };
    // keep the chosen spot for the full 30 seconds, unless the train carries it over a station name
    if (!t.alertSlot) { t.alertSlot = pick(); const q = at(t.alertSlot); t.alertOff = { x: q.x - t.x, y: q.y - t.y }; }
    else { const q = at(t.alertSlot); if (mapGap(q.x, q.y) < 0) t.alertSlot = pick(); }
    // glide to a new spot rather than jumping
    const q = at(t.alertSlot), tx = q.x - t.x, ty = q.y - t.y, k = Math.min(1, dt * 6);
    t.alertOff.x += (tx - t.alertOff.x) * k; t.alertOff.y += (ty - t.alertOff.y) * k;
    const bx = t.x + t.alertOff.x, by = t.y + t.alertOff.y;
    // fully opaque the whole time; only a short fade as it expires
    const left = Math.max(0, Math.min(1, (t.alertUntil - now) / 600));
    t.alert.setAttribute("transform", `translate(${bx.toFixed(2)} ${by.toFixed(2)})`);
    t.alert.setAttribute("opacity", left.toFixed(2));
  }

  function step(now) {
    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    const fade = reduceMotion ? 1 : Math.min(1, dt * 4);

    const all = [...trains.values()].filter(t => t.fetchedAt !== undefined && t.D !== null);
    // place newly seen trains without overlapping anyone
    all.filter(t => t.needsPlace).sort(dataAhead).forEach(t => { t.D = clearSpot(t, t.D, all); t.needsPlace = false; });
    // move trains front to back so each follower sees where its leader has moved to
    all.sort((a, b) => sgn(b.dir) * b.D - sgn(a.dir) * a.D);
    all.forEach(t => { if (t.pendingD === null) advance(t, now, dt, all); });

    const gone = [];
    all.forEach(t => {
      ensureNode(t);
      // a train that must move a long way (turning round, catching up) fades out and back in
      if (t.pendingD !== null) {
        t.opacity += (0 - t.opacity) * fade;
        if (t.opacity < 0.04 || reduceMotion) {
          t.D = clearSpot(t, t.pendingD, all); t.pendingD = null; t.arrivedAt = null; t.x = null;
        }
      } else {
        const wantOpacity = t.missed >= 2 ? 0 : 1;
        t.opacity += (wantOpacity - t.opacity) * fade;
      }
      if (t.missed >= 2 && t.opacity < 0.02) { gone.push(t); return; }

      let p = poseAt(t.D, t.dir);
      if (t.loop) {
        const L = t.loop;
        const hold = L.p >= 0.5 && L.p < 1 && !departureClear(t, all);        // wait round the back until the platform is clear
        if (!hold) L.p = reduceMotion ? 1 : Math.min(1, L.p + dt / (t.hurry ? LOOP_FAST_S : LOOP_S));
        if (L.p >= 1) { t.loop = null; t.hurry = false; }
        else p = loopPose(L);
        t.x = p.x; t.y = p.y; t.ang = p.ang;
      } else if (t.turnFrom) {                                     // glide across to the departing lane and swing round
        const k = reduceMotion ? 1 : Math.min(1, (now - t.turnFrom.start) / 1400);
        const e = k * k * (3 - 2 * k);
        const f = t.turnFrom;
        if (f.x === null) { t.x = p.x; t.y = p.y; t.ang = p.ang; t.turnFrom = null; }
        else {
          let da = ((p.ang - f.ang + 540) % 360) - 180; if (Math.abs(da) > 170) da = 180;
          t.x = f.x + (p.x - f.x) * e; t.y = f.y + (p.y - f.y) * e; t.ang = f.ang + da * e;
          if (k >= 1) t.turnFrom = null;
        }
      } else if (t.x === null || t.pendingD === null) { t.x = p.x; t.y = p.y; t.ang = p.ang; }
      const a = ((t.ang % 360) + 360) % 360;
      const flip = a > 90 && a < 270;
      t.node.setAttribute("transform", `translate(${t.x.toFixed(1)} ${t.y.toFixed(1)}) rotate(${t.ang.toFixed(1)}) scale(${TRAIN_SCALE})`);
      t.node.setAttribute("opacity", t.opacity.toFixed(2));
      t.text.setAttribute("transform", flip ? "translate(-1 0) rotate(180)" : "translate(-1 0)");
      const label = labelFor(t);
      if (t.text.textContent !== label) t.text.textContent = label;
      t.node.setAttribute("aria-label", t.waiting !== null && t.waiting !== undefined
        ? `Train waiting to depart ${S[t.waiting].name}`
        : `Vehicle ID ${t.v}, ${dirText(t).toLowerCase()} to ${S[t.dest].name}, ${t.loc || "location not reported"}`);
      drawAlert(t, now, dt);
    });
    gone.forEach(t => { t.node && t.node.remove(); t.alert && t.alert.remove(); trains.delete(t.v); if (selected === t.node) closePop(); });
  }
  function frame() { step(performance.now()); requestAnimationFrame(frame); }

  /* ---------- Panel ---------- */
  function updatePanel() {
    let n = 0, nb = 0, sb = 0;
    trains.forEach(t => { if (t.missed < 2) { n++; t.dir === "N" ? nb++ : sb++; } });
    document.getElementById("stat-trains").textContent = everLoaded ? n : "–";
    document.getElementById("stat-nb").textContent = everLoaded ? nb : "–";
    document.getElementById("stat-sb").textContent = everLoaded ? sb : "–";

    const up = document.getElementById("updated");
    if (fetchError) {
      up.dataset.error = "";
      up.textContent = fetchError;
    } else if (lastOk) {
      delete up.dataset.error;
      const s = Math.round((__sim.wall() - lastOk) / 1000);
      up.textContent = s < 5 ? "Updated just now" : `Updated ${s} seconds ago`;
    }
    const empty = everLoaded && n === 0;
    emptyMsg.textContent = "No trains running right now";
    emptyMsg.setAttribute("visibility", empty ? "visible" : "hidden");

    updateClock();
  }

  async function poll() {
    if (__sim.C.replaying) return;
    lastFetch = Date.now();
    try {
      const res = await fetch(apiUrl(`/Line/${LINE.api}/Arrivals`), { cache: "no-store" });
      if (res.status === 429) throw new Error("TfL is limiting requests. Add an API key below, or wait a minute.");
      if (res.status === 401 || res.status === 403) throw new Error("TfL rejected the API key. Check it under TfL API key.");
      if (!res.ok) throw new Error(`TfL returned an error (${res.status}). Retrying in 30 seconds.`);
      const data = await res.json();
      REC.addPoll(Array.isArray(data) ? data : []);
      ingest(Array.isArray(data) ? data : []);
      everLoaded = true; lastOk = Date.now(); fetchError = null;
    } catch (err) {
      fetchError = err && err.message && !/fetch|network/i.test(err.message)
        ? err.message
        : "Can't reach TfL right now. Trains keep moving on the last data; retrying in 30 seconds.";
    }
    updatePanel();
  }

  async function pollStatus() {
    const pill = document.getElementById("status-pill");
    const reason = document.getElementById("status-reason");
    try {
      if (__sim.C.replaying) return;
      const res = await fetch(apiUrl(`/Line/${LINE.api}/Status`), { cache: "no-store" });
      if (!res.ok) throw new Error();
      const data = await res.json();
      REC.addStatus(data);
      applyStatus(data);
    } catch (e) {
      pill.textContent = "Status unavailable"; pill.dataset.level = "unknown"; reason.hidden = true;
    }
  }
  function applyStatus(data) {
    const pill = document.getElementById("status-pill");
    const reason = document.getElementById("status-reason");
    try {
      const st = (data[0] && data[0].lineStatuses && data[0].lineStatuses[0]) || {};
      const sev = st.statusSeverity;
      pill.textContent = st.statusSeverityDescription || "Status unavailable";
      pill.dataset.level = sev === 10 ? "good" : (sev >= 7 ? "minor" : (sev === undefined ? "unknown" : "severe"));
      if (st.reason && sev !== 10) { reason.textContent = st.reason.trim(); reason.hidden = false; }
      else reason.hidden = true;
    } catch (e) {
      pill.textContent = "Status unavailable"; pill.dataset.level = "unknown"; reason.hidden = true;
    }
  }

  /* ---------- Controls ---------- */
  document.getElementById(mode === "dest" ? "lbl-dest" : "lbl-num").checked = true;
  document.querySelectorAll('input[name="lbl"]').forEach(inp =>
    inp.addEventListener("change", () => { mode = inp.value; }));

  const keyInput = document.getElementById("key-input");
  const keyNote = document.getElementById("key-note");
  try { if (localStorage.getItem("tfl-app-key")) { keyInput.value = localStorage.getItem("tfl-app-key"); } } catch (e) {}
  document.getElementById("key-form").addEventListener("submit", e => {
    e.preventDefault();
    const v = keyInput.value.trim();
    try {
      if (v) localStorage.setItem("tfl-app-key", v); else localStorage.removeItem("tfl-app-key");
      keyNote.textContent = v ? "Key saved in this browser. Refreshing data now." : "Key removed. The map will use TfL's anonymous limit.";
    } catch (err) {
      keyNote.textContent = "This browser blocked saving the key, so it will be used for this visit only.";
    }
    poll(); pollStatus();
  });

  /* ---------- Tooltip ---------- */
  const tip = document.getElementById("tip");
  const wrap = document.getElementById("map-wrap");
  let tipFor = null;
  function showTip(t) {
    tipFor = t;
    const eta = Math.max(0, Math.round(t.tts - (performance.now() - t.fetchedAt) / 1000));
    const nextTxt = eta <= 15 ? `At or arriving at ${S[t.next].name}` : `Next: ${S[t.next].name} in ${eta >= 60 ? Math.round(eta / 60) + " min" : eta + " s"}`;
    tip.innerHTML = "";
    const l1 = document.createElement("div");
    l1.innerHTML = `<strong>${dirText(t)}</strong> to `;
    l1.appendChild(document.createTextNode(`${S[t.dest].name} (${S[t.dest].code})`));
    const l2 = document.createElement("div"); l2.textContent = nextTxt;
    const l3 = document.createElement("div"); l3.textContent = t.loc ? `TfL: ${t.loc}` : "";
    const l4 = document.createElement("div"); l4.className = "id"; l4.textContent = `Vehicle ID ${t.v}`;
    tip.append(l1, l2, l3, l4);
    const r = t.node.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    tip.style.left = (r.left + r.width / 2 - w.left) + "px";
    tip.style.top = (r.top - w.top) + "px";
    tip.hidden = false;
  }
  function hideTip() { tip.hidden = true; tipFor = null; }
  document.addEventListener("scroll", hideTip, { passive: true });

  if (/[?&]debug\b/.test(location.search)) window.__undercurrent = { DEBUG, trains, S, LANES, poseAtL, cum, segLen, TRAIN_SCALE };

  /* ---------- Departure board (fixed in the right panel) ---------- */
  const pop = document.getElementById("pop");
  const popTitle = document.getElementById("pop-title");
  const popSections = document.getElementById("pop-sections");
  const popNote = document.getElementById("pop-note");
  let popRender = null, popTimer = null, selected = null;
  const clockFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  function whenText(sec) {
    if (sec < 30) return "due";
    const m = Math.max(1, Math.round(sec / 60));
    return m === 1 ? "1 min" : `${m} mins`;
  }
  function ledRow(cells, cls) {
    const r = document.createElement("div");
    r.className = "led-row" + (cls ? " " + cls : "");
    cells.forEach(([text, c]) => { const s = document.createElement("span"); if (c) s.className = c; s.textContent = text; r.appendChild(s); });
    return r;
  }
  function screen(labelText, rows) {
    const wrapEl = document.createElement("div");
    if (labelText) { const l = document.createElement("p"); l.className = "plat-label"; l.textContent = labelText; wrapEl.appendChild(l); }
    const led = document.createElement("div"); led.className = "led";
    rows.forEach(r => led.appendChild(r));
    wrapEl.appendChild(led);
    popSections.appendChild(wrapEl);
    return led;
  }
  function addClock(led) {
    const c = document.createElement("div"); c.className = "led-clock"; c.textContent = clockFmt.format(new Date(__sim.wall()));
    led.appendChild(c);
  }
  function setSelected(node) {
    if (selected) selected.classList.remove("selected");
    selected = node || null;
    if (selected) selected.classList.add("selected");
  }
  function ledTitle(text) {
    const h = document.createElement("p"); h.className = "led-title"; h.textContent = text;
    popSections.appendChild(h);
  }
  function showPrompt() {
    popSections.innerHTML = "";
    const p = document.createElement("div"); p.className = "led-prompt"; p.textContent = "Tap a station or a train";
    const led = screen("", [p]);
    addClock(led);
    popNote.hidden = true;
  }
  function openPop(title, node, render) {
    popRender = render;
    setSelected(node);
    render();
    clearInterval(popTimer);
    popTimer = setInterval(() => (popRender || showPrompt)(), 1000);
  }
  function closePop() {
    popRender = null; setSelected(null);
    showPrompt();
  }
  // clicking any empty part of the map resets the board
  wrap.addEventListener("click", e => {
    if (openIx && !(e.target.closest && e.target.closest(".ix"))) openIx.set(false);
    if (e.target.closest && e.target.closest(".station-link, .label.clickable, .train, .ix, .dest-alert")) return;
    closePop();
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closePop(); });
  showPrompt();
  popTimer = setInterval(showPrompt, 1000);

  // Station departures: next three each way
  function openBoard(k) {
    openPop(S[k].name, stationNodes[k], () => {
      const now = performance.now();
      const preds = (boardData.get(k) || []).map(p => ({ ...p, left: p.tts - (now - p.fetchedAt) / 1000 })).filter(p => p.left > -20);
      const isTerminus = k === 0 || k === LAST;
      const dirs = k === 0 ? ["S"] : k === LAST ? ["N"] : ["N", "S"];
      popSections.innerHTML = "";
      ledTitle(S[k].name);
      let last = null;
      dirs.forEach(dir => {
        const pool = isTerminus ? preds : preds.filter(p => p.dir === dir);
        const rows = pool.sort((a, b) => a.left - b.left).slice(0, 3);
        const plat = (rows.find(r => r.platform) || {}).platform || "";
        const word = (rows.find(r => r.pdir) || {}).pdir;
        const label = (!isTerminus && word ? word : dirLabel(dir)) + (plat && !isTerminus ? ` · ${plat}` : "");
        const cells = rows.length ? rows.map((p, i) => ledRow([
          [String(i + 1)],
          [isTerminus ? S[dir === "N" ? 0 : LAST].name : (p.dest !== undefined ? S[p.dest].name : p.destName || "Check front of train"), "dest"],
          [whenText(p.left), "when"]
        ])) : [ledRow([[""], [everLoaded ? "No trains listed" : "Loading…", "dest"], ["", "when"]], "led-empty")];
        last = screen(label, cells);
      });
      addClock(last);
      popNote.textContent = isTerminus ? "Terminus: arriving trains turn round to depart" : "";
      popNote.hidden = !isTerminus;
    });
  }

  // Train: its upcoming stops with predicted times
  function openTrain(t) {
    if (t.waiting !== null && t.waiting !== undefined) {
      openPop("", t.node, () => {
        popSections.innerHTML = "";
        if (t.waiting === null) { openTrain(t); return; }
        ledTitle(`Waiting at ${S[t.waiting].name}`);
        const arrived = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false })
          .format(new Date(__sim.wall() - (performance.now() - t.waitSince)));
        const led = screen("", [ledRow([["Arrived", "dest"], [arrived, "when"]], "stop"), ledRow([["Departure", "dest"], ["not yet known", "when"]], "stop")]);
        addClock(led);
        popNote.textContent = `Arrived as Vehicle ID ${t.v}. Times appear once it leaves.`;
        popNote.hidden = false;
      });
      return;
    }
    openPop(`${dirText(t)} to ${S[t.dest].name}`, t.node, () => {
      const now = performance.now(), s = sgn(t.dir);
      popSections.innerHTML = "";
      ledTitle(`${dirText(t)} to ${S[t.dest].name} · Vehicle ID ${t.v}`);
      const stops = (t.stops || []).filter(st => s * (cum[st.idx] - t.D) > -0.5);
      const rows = stops.length
        ? stops.slice(0, 9).map(st => ledRow([[S[st.idx].name, "dest"], [whenText((st.at - now) / 1000), "when"]], "stop"))
        : [ledRow([[t.missed >= 2 ? "Out of service" : "No stops predicted", "dest"], ["", "when"]], "stop led-empty")];
      const led = screen("Calling at", rows);
      addClock(led);
      popNote.textContent = t.loc ? `Now: ${t.loc}` : "";
      popNote.hidden = !t.loc;
      if (t.missed >= 2 || !trains.has(t.v)) { popRender = null; setSelected(null); }
    });
  }

  /* ---------- Clock ---------- */
  const bigTime = document.getElementById("big-time"), bigDate = document.getElementById("big-date");
  const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", year: "numeric" });
  function updateClock() {
    const now = new Date(__sim.wall());
    const p = Object.fromEntries(timeFmt.formatToParts(now).map(x => [x.type, x.value]));
    bigTime.innerHTML = `${p.hour}:${p.minute}<span class="secs">${p.second}</span>`;
    bigDate.textContent = dateFmt.format(now);
  }
  updateClock();
  setInterval(updateClock, 1000);

  /* ---------- Facts carousel ---------- */
  const FACTS = LINE.facts || [];
  const factText = document.getElementById("fact-text"), factTag = document.getElementById("fact-tag");
  const factBar = document.createElement("span");
  document.getElementById("fact-dots").appendChild(factBar);
  const FACT_MS = 18000;
  let factIdx = Math.floor(Math.random() * FACTS.length), factStart = __sim.realNow(), factPaused = false;
  function showFact(i, animate) {
    factIdx = (i + FACTS.length) % FACTS.length;
    const apply = () => {
      factTag.textContent = FACTS[factIdx].tag;
      factText.textContent = FACTS[factIdx].text;
      factText.classList.remove("fading"); factTag.classList.remove("fading");
    };
    factStart = __sim.realNow();
    if (animate && !reduceMotionPref) { factText.classList.add("fading"); factTag.classList.add("fading"); setTimeout(apply, 400); }
    else apply();
  }
  document.getElementById("fact-prev").addEventListener("click", () => showFact(factIdx - 1, true));
  document.getElementById("fact-next").addEventListener("click", () => showFact(factIdx + 1, true));
  const factsEl = document.querySelector(".facts");
  factsEl.addEventListener("mouseenter", () => { factPaused = true; });
  factsEl.addEventListener("mouseleave", () => { factPaused = false; factStart = __sim.realNow() - (parseFloat(factBar.style.width) || 0) / 100 * FACT_MS; });
  (function tickFacts(now) {
    if (factPaused) factStart += 16; // hold while hovered
    const k = Math.min(1, (__sim.realNow() - factStart) / FACT_MS);
    factBar.style.width = (k * 100).toFixed(1) + "%";
    if (k >= 1) showFact(factIdx + 1, true);
    requestAnimationFrame(tickFacts);
  })();
  showFact(factIdx, false);

  // Key and Preferences work as an accordion (one open at a time) so the panel always fits the screen
  const secs = [...document.querySelectorAll("details.sec")];
  try { const v = localStorage.getItem("open-sec"); if (v !== null) secs.forEach(d => { d.open = d.id === v; }); } catch (e) {}
  let secBusy = false;
  function animateBody(d, opening) {
    const body = d.querySelector(".sec-body");
    if (reduceMotionPref || !body.animate) { d.open = opening; return Promise.resolve(); }
    if (opening) d.open = true;
    const h = body.scrollHeight;
    const anim = body.animate(opening ? [{ height: "0px", opacity: 0 }, { height: h + "px", opacity: 1 }]
                                      : [{ height: h + "px", opacity: 1 }, { height: "0px", opacity: 0 }],
                             { duration: 200, easing: "ease-in-out" });
    return anim.finished.then(() => { if (!opening) d.open = false; });
  }
  secs.forEach(d => d.querySelector("summary").addEventListener("click", async e => {
    e.preventDefault();
    if (secBusy) return;
    secBusy = true;
    if (d.open) { await animateBody(d, false); }
    else {
      const other = secs.find(o => o !== d && o.open);
      if (other) await animateBody(other, false);   // close the previous one first
      await animateBody(d, true);
    }
    secBusy = false;
    try { localStorage.setItem("open-sec", (secs.find(o => o.open) || { id: "" }).id); } catch (e) {}
  }));

  /* ---------- Appearance: auto / light / dark ---------- */
  function applyTheme(v) {
    if (v === "light" || v === "dark") document.documentElement.setAttribute("data-theme", v);
    else document.documentElement.removeAttribute("data-theme");
    const r = document.getElementById("th-" + (v === "light" || v === "dark" ? v : "auto")); if (r) r.checked = true;
    if (typeof applyDisplay === "function") applyDisplay();
  }
  let themePref = "auto";
  try { themePref = localStorage.getItem("theme") || "auto"; } catch (e) {}
  document.querySelectorAll('input[name="theme"]').forEach(inp => inp.addEventListener("change", () => {
    try { localStorage.setItem("theme", inp.value); } catch (e) {}
    applyTheme(inp.value);
  }));

  try { localStorage.removeItem("panel-hidden"); } catch (e) {}

  /* ---------- Display: background warmth and brightness (remembered per screen) ---------- */
  const warmth = document.getElementById("warmth"), bright = document.getElementById("brightness");
  const dimmer = document.getElementById("dimmer");
  const TONES = {
    light: { cool: [234, 240, 244], neutral: [241, 242, 239], warm: [247, 238, 222] },
    dark:  { cool: [22, 29, 38],   neutral: [27, 32, 38],   warm: [36, 31, 25] }
  };
  const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const isDark = () => {
    const th = document.documentElement.getAttribute("data-theme");
    return th ? th === "dark" : !!(darkQuery && darkQuery.matches);
  };
  const mixC = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  function applyDisplay() {
    const w = +warmth.value / 100, b = +bright.value / 100;
    const tone = TONES[isDark() ? "dark" : "light"];
    const c = w < 0.5 ? mixC(tone.cool, tone.neutral, w / 0.5) : mixC(tone.neutral, tone.warm, (w - 0.5) / 0.5);
    const rgb = `rgb(${c.join(",")})`;
    const root = document.documentElement.style;
    root.setProperty("--bg", rgb);
    if (isDark()) { root.setProperty("--station-fill", rgb); root.setProperty("--ring-fill", rgb); }
    else { root.removeProperty("--station-fill"); root.removeProperty("--ring-fill"); }
    dimmer.style.opacity = ((1 - b) * 0.9).toFixed(3);
    document.getElementById("warmth-out").textContent = w < 0.4 ? "Cool" : w > 0.6 ? "Warm" : "Neutral";
    document.getElementById("brightness-out").textContent = Math.round(b * 100) + "%";
    try { localStorage.setItem("display", JSON.stringify({ w: warmth.value, b: bright.value })); } catch (e) {}
  }
  try { const d = JSON.parse(localStorage.getItem("display") || "null"); if (d) { warmth.value = d.w; bright.value = d.b; } } catch (e) {}
  warmth.addEventListener("input", applyDisplay);
  bright.addEventListener("input", applyDisplay);
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener("change", applyDisplay);
  applyDisplay();
  applyTheme(themePref);


  /* ---------- Recording and replay (test version only) ---------- */
  const slim = p => ({ vehicleId: p.vehicleId, naptanId: p.naptanId, platformName: p.platformName,
    destinationNaptanId: p.destinationNaptanId, destinationName: p.destinationName,
    timeToStation: p.timeToStation, currentLocation: p.currentLocation, id: p.id, timestamp: p.timestamp });
  const REC = {
    polls: [], status: [], start: Date.now(),
    addPoll(data) { this.polls.push({ w: Date.now(), d: data.map(slim) }); REPLAY.refreshRec(); },
    addStatus(data) { this.status.push({ w: Date.now(), d: data }); },
    save() {
      const blob = new Blob([JSON.stringify({ kind: "undercurrent-recording", version: 1, line: LINE.id, start: this.start, polls: this.polls, status: this.status })], { type: "application/json" });
      const stamp = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
        .format(new Date(this.start)).replace(/[/, :]+/g, "-");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `${LINE.id}-recording-${stamp}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  };

  const REPLAY = {
    rec: null, i: 0, stepping: false, events: [],
    init() {
      const bar = document.createElement("div");
      bar.className = "rbar"; bar.id = "rbar";
      bar.innerHTML = `
        <div class="rb-row rb-live">
          <span class="rb-dot"></span><span class="rb-rec" id="rb-rec">Recording 0 polls</span>
          <button type="button" id="rb-save">Save recording</button>
          <label class="rb-load">Load recording<input type="file" id="rb-file" accept=".json,application/json"></label>
        </div>
        <div class="rb-row rb-play" hidden>
          <button type="button" id="rb-pp" aria-label="Pause">❚❚</button>
          <button type="button" id="rb-step" title="Play to the next feed update, then pause">Step</button>
          <div class="rb-speed" role="group" aria-label="Speed">
            <button type="button" data-s="1">1×</button><button type="button" data-s="5">5×</button><button type="button" data-s="10" class="on">10×</button>
          </div>
          <div class="rb-track" id="rb-track"><div class="rb-marks" id="rb-marks"></div><input type="range" id="rb-seek" min="0" max="1000" value="0" aria-label="Timeline"></div>
          <span class="rb-time" id="rb-time">--:--:--</span>
          <button type="button" id="rb-live" title="Leave the replay and go back to the live feed">Back to live</button>
        </div>
        <div class="rb-ev" id="rb-ev" hidden></div>`;
      document.getElementById("map-wrap").appendChild(bar);
      document.getElementById("rb-save").addEventListener("click", () => REC.save());
      document.getElementById("rb-file").addEventListener("change", e => { const f = e.target.files[0]; if (f) this.load(f); e.target.value = ""; });
      document.getElementById("rb-pp").addEventListener("click", () => this.setPaused(!__sim.C.paused));
      document.getElementById("rb-step").addEventListener("click", () => this.stepOne());
      bar.querySelectorAll(".rb-speed button").forEach(b => b.addEventListener("click", () => {
        bar.querySelectorAll(".rb-speed button").forEach(x => x.classList.toggle("on", x === b));
        __sim.setSpeed(+b.dataset.s);
      }));
      const seek = document.getElementById("rb-seek");
      seek.addEventListener("input", () => { this.scrubbing = true; this.showTime(this.fracWall(seek.value / 1000)); });
      seek.addEventListener("change", () => { this.scrubbing = false; this.jump(this.fracWall(seek.value / 1000)); });
      document.getElementById("rb-live").addEventListener("click", () => location.reload());
      setInterval(() => this.tick(), 100);
    },
    refreshRec() {
      const n = REC.polls.length, mins = n ? Math.round((REC.polls[n - 1].w - REC.polls[0].w) / 60000) : 0;
      const el = document.getElementById("rb-rec");
      if (el) el.textContent = `Recording ${n} poll${n === 1 ? "" : "s"} · ${mins} min`;
    },
    async load(file) {
      let rec;
      try { rec = JSON.parse(await file.text()); } catch (e) { alertBar("That file isn't a recording."); return; }
      if (!rec || rec.kind !== "undercurrent-recording" || !Array.isArray(rec.polls) || !rec.polls.length) { alertBar("That file isn't a recording."); return; }
      if ((rec.line || "victoria") !== LINE.id) { alertBar(`That's a ${rec.line || "victoria"} line recording: switch line first.`); return; }
      this.rec = rec; this.first = rec.polls[0].w; this.last = rec.polls[rec.polls.length - 1].w + POLL_MS;
      this.events = findEvents(rec.polls);
      drawMarks(this);
      __sim.C.replaying = true;
      document.querySelector(".rb-live").hidden = true;
      document.querySelector(".rb-play").hidden = false;
      document.getElementById("rbar").classList.add("playing");
      document.getElementById("updated").textContent = "Replaying a recording";
      __sim.setSpeed(10);
      this.jump(this.first);
    },
    fracWall(f) { return this.first + (this.last - this.first) * f; },
    // Clear the map and rebuild it at wall time w, running the 90 seconds before it at full speed
    jump(w) {
      const polls = this.rec.polls;
      w = Math.max(this.first, Math.min(this.last, w));
      trains.forEach(t => { t.node && t.node.remove(); t.alert && t.alert.remove(); });
      trains.clear(); boardData.clear(); closePop();
      const warm = Math.max(this.first, w - 90000);
      this.i = 0; while (this.i < polls.length - 1 && polls[this.i + 1].w <= warm) this.i++;
      const wasPaused = __sim.C.paused;
      __sim.setPaused(true);
      __sim.jumpWall(polls[this.i].w);
      lastFrame = performance.now();
      this.feed();
      while (__sim.wall() < w) { __sim.advance(200); this.feed(); step(performance.now()); }
      this.applyStatusAt(w);
      __sim.setPaused(wasPaused);
      this.render();
    },
    feed() {
      const polls = this.rec.polls;
      let fed = false;
      while (this.i < polls.length && polls[this.i].w <= __sim.wall()) {
        ingest(polls[this.i].d); everLoaded = true; lastOk = polls[this.i].w; fetchError = null;
        this.i++; fed = true;
      }
      return fed;
    },
    applyStatusAt(w) {
      const st = (this.rec.status || []).filter(x => x.w <= w).pop();
      if (st) applyStatus(st.d);
    },
    tick() {
      if (!this.rec) return;
      if (!__sim.C.paused && this.feed()) { this.applyStatusAt(__sim.wall()); updatePanel(); if (this.stepping) { this.stepping = false; this.setPaused(true); } }
      if (__sim.wall() >= this.last && !__sim.C.paused) this.setPaused(true);
      this.render();
    },
    setPaused(p) {
      __sim.setPaused(p);
      const b = document.getElementById("rb-pp");
      b.textContent = p ? "▶" : "❚❚"; b.setAttribute("aria-label", p ? "Play" : "Pause");
      if (!p) lastFrame = performance.now();
    },
    stepOne() {
      if (this.i >= this.rec.polls.length) return;
      this.stepping = true; this.setPaused(false);
    },
    showTime(w) { document.getElementById("rb-time").textContent = timeFmt.format(new Date(w)); },
    render() {
      const w = __sim.wall();
      if (!this.scrubbing) document.getElementById("rb-seek").value = Math.round(1000 * (w - this.first) / (this.last - this.first));
      this.showTime(w);
      updateClock();
    }
  };
  function alertBar(msg) { const el = document.getElementById("rb-rec"); if (el) { el.textContent = msg; setTimeout(() => REPLAY.refreshRec(), 4000); } }

  // Events worth checking in a recording: trains vanishing, new Vehicle IDs appearing, destination changes
  function findEvents(polls) {
    const ev = [];
    let prev = new Map();
    polls.forEach((p, k) => {
      const cur = new Map();
      p.d.forEach(x => {
        const v = (x.vehicleId || "").trim(); if (!v || v === "000") return;
        const c = cur.get(v);
        if (!c || x.timeToStation < c.tts) cur.set(v, { tts: x.timeToStation, st: byNaptan[x.naptanId], dest: byNaptan[x.destinationNaptanId] });
      });
      if (k > 0) {
        cur.forEach((c, v) => {
          const o = prev.get(v);
          const at = c.st !== undefined ? S[c.st].name : "?";
          if (!o) ev.push({ w: p.w, kind: "new", text: `${v} appears (next: ${at})` });
          else if (c.dest !== o.dest && c.dest !== undefined) ev.push({ w: p.w, kind: "dest", text: `${v} now to ${S[c.dest].name}` });
        });
        prev.forEach((o, v) => { if (!cur.has(v)) ev.push({ w: p.w, kind: "gone", text: `${v} drops out (was heading to ${o.st !== undefined ? S[o.st].name : "?"})` }); });
      }
      prev = cur;
    });
    return ev;
  }
  function drawMarks(R) {
    const box = document.getElementById("rb-marks"), tip = document.getElementById("rb-ev");
    box.innerHTML = "";
    const groups = new Map();
    R.events.forEach(e => { const k = e.w; (groups.get(k) || groups.set(k, []).get(k)).push(e); });
    groups.forEach((list, w) => {
      const m = document.createElement("button");
      m.type = "button";
      const kinds = new Set(list.map(e => e.kind));
      m.className = "rb-mark " + (kinds.has("dest") ? "dest" : kinds.has("gone") ? "gone" : "new");
      m.style.left = (100 * (w - R.first) / (R.last - R.first)) + "%";
      const label = `${timeFmt.format(new Date(w))}\n` + list.map(e => e.text).join("\n");
      m.setAttribute("aria-label", label.replace(/\n/g, ". "));
      m.addEventListener("mouseenter", () => { tip.textContent = label; tip.hidden = false; });
      m.addEventListener("mouseleave", () => { tip.hidden = true; });
      m.addEventListener("click", () => R.jump(w - 20000));                // land 20 seconds before it
      box.appendChild(m);
    });
  }

  /* ---------- Stay up to date: reload when a newer version is published ---------- */
  const ENGINE_FILE = "engine-replay.js";
  async function checkForUpdate() {
    if (location.protocol === "file:") return;
    try {
      const res = await fetch(ENGINE_FILE + "?v=" + Date.now(), { cache: "no-store" });
      const html = await res.text();
      const m = html.match(/const VERSION = "([^"]+)"/);
      if (m && m[1] !== VERSION) location.reload();
    } catch (e) {}
  }
  setInterval(checkForUpdate, 5 * 60 * 1000);

  /* ---------- Start ---------- */
  requestAnimationFrame(frame);
  poll(); pollStatus();
  setInterval(poll, POLL_MS);
  setInterval(pollStatus, STATUS_MS);
  setInterval(updatePanel, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    const now = performance.now();
    trains.forEach(t => {
      if (t.fetchedAt === undefined || t.D === null) return;
      const m = modelD(t, now);
      if (Math.abs(m - t.D) > 40) t.pendingD = m;
    });
    lastFrame = now;
    if (Date.now() - lastFetch > POLL_MS) poll();
  });
  REPLAY.init();
})();
