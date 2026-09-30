/* Project Undercurrent: live Tube map engine (shared by every line). Line data comes from lines/<id>.js.
   v3.02: the page loads once. The shell (clock, preferences, side panels, zoom buttons) is wired once; each line is
   mounted into it and fully unmounted before the next, so switching lines never reloads the page. */
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

  const VERSION = "3.02";
  const DEBUG_ON = /[?&]debug\b/.test(location.search);
  const reduceMotionPref = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = document.documentElement;
  const svg = document.getElementById("map");
  let txBusy = false;                                      // true while a line hand-over is running (spans both lines)
  let cur = null;                                          // the mounted line: { id, LINE, scope, api }

  /* ---------- Leak guard (v3.01) ----------
     Every timer and animation frame callback is stamped with the line mount that created it (0 = the shell).
     If a callback from a line that has been unmounted ever runs, something escaped the clean-up: the guard
     counts it and the page reloads itself cleanly rather than carrying the leak forward. Live repeating
     timers are counted too, so each mount can be checked against the first. */
  const guard = { gen: 0, dead: new Set(), strays: 0, intervals: new Set(), mounts: 0, baseIntervals: null, problems: [] };
  (function stampTimers() {
    const stamp = (fn, g) => function () {
      if (guard.dead.has(g)) guard.strays++;
      const prev = guard.gen; guard.gen = g;
      try { return fn.apply(this, arguments); } finally { guard.gen = prev; }
    };
    const sT = window.setTimeout, sI = window.setInterval, cI = window.clearInterval, rAF = window.requestAnimationFrame;
    window.setTimeout = function (fn, ...a) { return sT.call(window, typeof fn === "function" ? stamp(fn, guard.gen) : fn, ...a); };
    window.setInterval = function (fn, ...a) { const id = sI.call(window, typeof fn === "function" ? stamp(fn, guard.gen) : fn, ...a); guard.intervals.add(id); return id; };
    window.clearInterval = function (id) { guard.intervals.delete(id); return cI.call(window, id); };
    window.requestAnimationFrame = function (fn) { return rAF.call(window, stamp(fn, guard.gen)); };
  })();

  /* ---------- Scope: everything a mounted line starts goes through here, so unmount can undo all of it ---------- */
  function makeScope(gen) {
    const undo = new Set(), timeouts = new Set(), intervals = new Set(), frames = new Set();
    const ac = window.AbortController ? new AbortController() : null;
    let dead = false;
    const as = f => { const prev = guard.gen; guard.gen = gen; try { return f(); } finally { guard.gen = prev; } };   // stamp timers with this line, whoever calls
    const s = {
      gen,
      get dead() { return dead; },
      // listeners on anything that outlives the line (the map element, the page, the side panels)
      on(target, type, fn, opt) {
        if (!target) return;
        target.addEventListener(type, fn, opt);
        undo.add(() => target.removeEventListener(type, fn, opt));
      },
      every(fn, ms) { const id = as(() => setInterval(() => { if (!dead) fn(); }, ms)); intervals.add(id); return id; },
      stopEvery(id) { if (intervals.delete(id)) clearInterval(id); },
      after(fn, ms) { const id = as(() => setTimeout(() => { timeouts.delete(id); if (!dead) fn(); }, ms)); timeouts.add(id); return id; },
      stopAfter(id) { if (timeouts.delete(id)) clearTimeout(id); },
      frame(fn) { const id = as(() => requestAnimationFrame(t => { frames.delete(id); if (!dead) fn(t); })); frames.add(id); return id; },
      observe(obs) { undo.add(() => obs.disconnect()); return obs; },
      fetch(url, opts) { return fetch(url, Object.assign({}, opts, ac ? { signal: ac.signal } : {})); },
      later(fn) { undo.add(fn); },                           // any other clean-up step
      count() { return undo.size + timeouts.size + intervals.size + frames.size; },
      dispose() {
        dead = true;
        if (ac) ac.abort();                                  // in-flight TfL requests: a late reply can never reach the next line
        timeouts.forEach(id => clearTimeout(id)); intervals.forEach(id => clearInterval(id)); frames.forEach(id => cancelAnimationFrame(id));
        undo.forEach(f => { try { f(); } catch (e) {} });
        timeouts.clear(); intervals.clear(); frames.clear(); undo.clear();
      }
    };
    return s;
  }

  /* ---------- Clock ---------- */
  const bigTime = document.getElementById("big-time"), bigDate = document.getElementById("big-date");
  const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", year: "numeric" });
  function updateClock() {
    const now = new Date();
    const p = Object.fromEntries(timeFmt.formatToParts(now).map(x => [x.type, x.value]));
    bigTime.innerHTML = `${p.hour}:${p.minute}<span class="secs">${p.second}</span>`;
    bigDate.textContent = dateFmt.format(now);
  }
  updateClock();
  setInterval(updateClock, 1000);

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

  /* ---------- Stay up to date: reload when a newer version is published ---------- */
  const ENGINE_FILE = "engine.js";
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

  /* ---------- Collapsible side panels (remembered on this screen) ---------- */
  (function panels() {
    const wrap = document.querySelector(".wrap"), mw = document.getElementById("map-wrap");
    let state = { left: true, right: true };
    try { state = Object.assign(state, JSON.parse(localStorage.getItem("panels") || "{}")); } catch (e) {}
    const make = side => {
      const b = document.createElement("button");
      b.type = "button"; b.className = `edge-toggle ${side}`;
      b.innerHTML = '<svg viewBox="0 0 10 16" width="8" height="14" aria-hidden="true"><path d="M7 2 L2 8 L7 14"/></svg>';
      b.addEventListener("click", () => { state[side] = !state[side]; apply(); try { localStorage.setItem("panels", JSON.stringify(state)); } catch (e) {} });
      mw.appendChild(b); return b;
    };
    const btn = { left: make("left"), right: make("right") };
    function apply() {
      wrap.classList.toggle("left-closed", !state.left);
      wrap.classList.toggle("right-closed", !state.right);
      btn.left.setAttribute("aria-label", state.left ? "Hide the left panel" : "Show the left panel");
      btn.right.setAttribute("aria-label", state.right ? "Hide the right panel" : "Show the right panel");
      btn.left.setAttribute("aria-expanded", state.left); btn.right.setAttribute("aria-expanded", state.right);
    }
    apply();
  })();

  /* ---------- Line picker: built once, the tick follows the mounted line ---------- */
  const pick = document.getElementById("line-pick");
  (function picker() {
    const head = document.createElement("option");
    head.value = ""; head.textContent = "Change line"; head.disabled = true; head.selected = true; head.hidden = true;
    pick.appendChild(head);
    (window.UNDERCURRENT_LINES || [{ id: window.UNDERCURRENT_LINE.id, name: window.UNDERCURRENT_LINE.name }]).forEach(l => {
      const o = document.createElement("option"); o.value = l.id; o.dataset.name = `${l.name} line`; o.textContent = o.dataset.name;
      pick.appendChild(o);
    });
    pick.addEventListener("change", () => {
      const id = pick.value; pick.value = "";
      if (id && cur && id !== cur.id) plainSwitch(id);
    });
  })();
  function tickPicker(id) {
    pick.querySelectorAll("option[data-name]").forEach(o => { o.textContent = (o.value === id ? "✓ " : "") + o.dataset.name; });
    pick.value = "";
  }

  // The line's colours, one style element reused by every line
  const lineStyle = document.createElement("style");
  document.head.appendChild(lineStyle);

  // Facts progress bar (one element, reused by every line)
  const factBar = document.createElement("span");
  document.getElementById("fact-dots").appendChild(factBar);

  /* ---------- Zoom buttons and keys: wired once, they act on whichever line is mounted ---------- */
  (function zoomControls() {
    const box = document.createElement("div");
    box.className = "zoom-ctl";
    box.innerHTML = '<button type="button" id="zoom-in" aria-label="Zoom in">+</button><button type="button" id="zoom-out" aria-label="Zoom out">−</button><button type="button" id="zoom-fit" aria-label="Fit the whole line" disabled><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg></button>';
    document.getElementById("map-wrap").appendChild(box);
    const act = fn => () => { if (cur && !txBusy) fn(cur.api); };
    document.getElementById("zoom-in").addEventListener("click", act(a => a.zoomCentre(1 / 1.4)));
    document.getElementById("zoom-out").addEventListener("click", act(a => a.zoomCentre(1.4)));
    document.getElementById("zoom-fit").addEventListener("click", act(a => a.resetView()));
    document.addEventListener("keydown", e => {
      if (e.target.closest && e.target.closest("input, select, textarea")) return;
      if (!cur || txBusy) return;
      if (e.key === "+" || e.key === "=") cur.api.zoomCentre(1 / 1.4);
      else if (e.key === "-" || e.key === "_") cur.api.zoomCentre(1.4);
      else if (e.key === "0") cur.api.resetView();
    });
  })();

  /* ---------- Safety net for always-on screens: a quiet reload once a day, around 4am London time ---------- */
  const PAGE_START = Date.now();
  const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false });
  setInterval(() => {
    if (txBusy || Date.now() - PAGE_START < 2 * 3600e3) return;
    if (+hourFmt.format(new Date()) === 4) location.reload();
  }, 60000);

  /* ---------- One line, mounted into the shell ----------
     Everything below belongs to a single line. Anything it starts that outlives its own map (timers, animation
     frames, TfL requests, listeners on the page or the side panels) goes through `scope`, so unmount undoes it all.
     Listeners on the map's own contents need no tracking: they go when the map is emptied. */
  function mountLine(LINE, scope, arrival) {
    /* ---------- Stations ---------- */
    const S = LINE.stations.map(s => ({ ...s }));
    const dirLabel = d => LINE.dirs[d].label;
    // "Northbound" / "Eastbound" etc. from the platform name, used where the direction word changes along a line
    const platformWord = name => { const m = /^(\w+bound)\b/i.exec(name || ""); return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : ""; };
    const dirText = t => t.pdir || dirLabel(t.dir);

    /* ---------- Page set-up for this line (every panel field is reset, so nothing carries over from the last line) ---------- */
    (function setUpPage() {
      const name = LINE.name + " line";
      document.title = `${LINE.name} Line Live`;
      document.querySelector(".eyebrow").textContent = `Live prototype · v${VERSION}`;
      document.getElementById("line-name").textContent = `${LINE.name} Line`;
      document.getElementById("stat-stations").textContent = LINE.stations.length;
      ["stat-trains", "stat-nb", "stat-sb"].forEach(id => { document.getElementById(id).textContent = "–"; });
      document.getElementById("dir-n").textContent = LINE.dirs.N.stat || LINE.dirs.N.label;
      document.getElementById("dir-s").textContent = LINE.dirs.S.stat || LINE.dirs.S.label;
      const pill = document.getElementById("status-pill");
      pill.textContent = "Checking line status"; pill.dataset.level = "unknown";
      document.getElementById("status-reason").hidden = true;
      const up = document.getElementById("updated"); up.textContent = "Connecting to TfL…"; delete up.dataset.error;
      svg.setAttribute("aria-label", `Live schematic map of the ${name} showing each train`);
      document.getElementById("facts").setAttribute("aria-label", `${name} facts`);
      lineStyle.textContent = `:root { --line: ${LINE.colour.light}; --train: ${LINE.train.light}; }
        @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --line: ${LINE.colour.dark}; --train: ${LINE.train.dark}; } }
        :root[data-theme="dark"] { --line: ${LINE.colour.dark}; --train: ${LINE.train.dark}; }`;
      tickPicker(LINE.id);
    })();
    const SPACING = LINE.spacing || 1.25;
    S.forEach(s => { s.x *= SPACING; s.y *= SPACING; });
    const byNaptan = Object.fromEntries(S.map((s, i) => [s.naptan, i]));
    const byId = Object.fromEntries(S.map((s, i) => [s.id, i]));

    // Routes: each is one unbranched run of stations, all written in the same direction (first station = the "N" end).
    // A simple line has one route; a branching line lists every end-to-end combination. Trains follow one route at a time.
    const ROUTE_LISTS = (LINE.routes || [S.map(s => s.id)]).map(r => r.map(id => {
      if (byId[id] === undefined) throw new Error("Unknown station in route: " + id);
      return byId[id];
    }));
    // every piece of track once (for drawing and label placement)
    const TRACK_SEGS = [];
    ROUTE_LISTS.forEach(r => r.slice(1).forEach((b, i) => {
      const a = r[i];
      if (!TRACK_SEGS.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) TRACK_SEGS.push([a, b]);
    }));

    // Typical running time (seconds) between neighbouring stations, keyed by the pair. Refined from live data.
    const runKey = (a, b) => a < b ? a + "-" + b : b + "-" + a;
    const RUNT = new Map();
    ROUTE_LISTS[0].slice(1).forEach((b, i) => RUNT.set(runKey(ROUTE_LISTS[0][i], b), (LINE.run && LINE.run[i]) || 120));
    const runTime = (a, b) => RUNT.get(runKey(a, b)) || 120;

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
    // interchange markers for lines that have their own map become shortcuts to that line (v2.8)
    const GO_LINES = new Set((window.UNDERCURRENT_LINES || []).map(l => l.id).filter(id => id !== LINE.id));

    /* ---------- SVG scaffolding ---------- */
    const el = (tag, attrs, parent) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      (parent || svg).appendChild(n);
      return n;
    };
    // The Thames: the same master shape on every line, only moved and resized to suit this map
    const RIVER = window.UNDERCURRENT_RIVER, RP = LINE.river;
    const riverG = el("g", { transform: `scale(${SPACING})` });
    if (RIVER && RP) {
      const k = RP.scale || 1;
      const g = el("g", { transform: `translate(${RP.x || 0} ${RP.y || 0}) scale(${k})` }, riverG);
      el("path", { class: "river", d: RIVER.d, style: `stroke-width: ${((RP.width || RIVER.width) / k).toFixed(1)}px` }, g);
      if (RP.label) {
        const lx = (RP.x || 0) + RP.label[0] * k, ly = (RP.y || 0) + RP.label[1] * k;   // label stays the same size on every map
        el("text", { class: "river-label", x: lx, y: ly, "text-anchor": "middle" }, riverG).textContent = "Thames";
      }
    }

    const trackD = ROUTE_LISTS.map(r => "M " + r.map(i => S[i].x + " " + S[i].y).join(" L ")).join(" ");
    const trackPath = el("path", { class: "track", d: trackD });   // track under the trains
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
    document.querySelectorAll(".legend .rail-icon").forEach(g => { g.replaceChildren(); railIcon(g, 0, 0); });

    // Interchange markers. Hover or focus expands them to show the line's name.
    const LIGHT = new Set(["#FFD300", "#F3A9BB", "#95CDBA"]); // pale tube colours get dark text for legibility
    const PILL_H = 27;
    function tween(from, to, ms, fn) {
      const t0 = performance.now();
      const step = now => {
        const k = reduceMotionPref ? 1 : Math.min(1, (now - t0) / ms);
        const e = 1 - Math.pow(1 - k, 3);
        fn(from + (to - from) * e);
        if (k < 1) scope.frame(step);
      };
      scope.frame(step);
    }

    // Markers in one row make room for each other: an expanded marker pushes its neighbours aside.
    // Each marker also gets an invisible hit area reaching halfway to its neighbours, so there are no dead gaps.
    // The icon under the pointer stays under it: if the row reflows (a long name collapsing beside it), the whole row
    // shifts just enough to keep the pointer on that icon, and no more. When the pointer leaves, the row eases back.
    let ixPtr = null;                                        // pointer position across the map, in map units
    let pinRow = null;                                       // the row whose hovered icon is pinned under the pointer
    const trackPtr = e => { ixPtr = toMap(e.clientX, e.clientY).x; if (pinRow && pinRow.pin) layoutRow(pinRow, true); };
    scope.on(svg, "pointermove", trackPtr); scope.on(svg, "pointerdown", trackPtr);
    const ROW_LIMIT = 120;                                   // map units a row may sit from home before it eases back
    function layoutRow(row, byPointer) {
      const pos = row.items.map((it, i) => {
        let shift = 0;
        row.items.forEach((o, j) => {
          if (j === i || !o.extra) return;
          if (o.grow === "right" && i > j) shift += o.extra;
          else if (o.grow === "left" && i < j) shift -= o.extra;
          else if (o.grow === "centre") shift += i < j ? -o.extra / 2 : o.extra / 2;
        });
        return it.x + shift;
      });
      // each icon's hover area reaches halfway to its neighbours, so there are no dead gaps
      const spans = row.items.map((it, i) => {
        const L0 = pos[i] + it.ext.x1, R0 = pos[i] + it.ext.x2, prev = row.items[i - 1], next = row.items[i + 1];
        return [prev ? (pos[i - 1] + prev.ext.x2 + L0) / 2 : L0 - 5, next ? (R0 + pos[i + 1] + next.ext.x1) / 2 : R0 + 5];
      });
      // Home is offset 0. While the pointer is on a middle icon the row stays put, moving only if that icon would
      // otherwise slip out from under the pointer. On the two outer icons it eases back towards home (never further than
      // keeps the pointer on the icon). Safety limit: if it has wandered more than ROW_LIMIT from home, it eases back
      // from any icon, so drift can't build up however long you glide.
      let off = row.off || 0;
      const pi = row.pin && ixPtr !== null ? row.items.indexOf(row.pin.item) : -1;
      if (pi >= 0) {
        const [L, R] = spans[pi], m = Math.min(4, (R - L) / 2);
        const lo = ixPtr - R + m, hi = ixPtr - L - m;          // offsets that keep the pointer on this icon
        const outer = pi === 0 || pi === row.items.length - 1;
        if (byPointer) {
          // The pointer moved: never chase it (that would drag the row along and stop you reaching the next icon).
          // Only ease towards home, and only while the pointer is still on this icon.
          if (off >= lo && off <= hi && (outer || Math.abs(off) > ROW_LIMIT)) off = Math.max(lo, Math.min(hi, off * 0.8));
        } else {
          // The icons changed size (a name opening or closing): shift just enough to keep the pointer on this icon.
          off = Math.max(lo, Math.min(hi, off));
        }
        row.off = off;
      }
      const y1 = Math.min(...row.items.map(it => it.ext.y1)) - 5, y2 = Math.max(...row.items.map(it => it.ext.y2)) + 5;
      row.items.forEach((it, i) => {
        const gx = pos[i] + off, [L, R] = spans[i];
        it.g.setAttribute("transform", `translate(${gx.toFixed(2)} ${it.y})`);
        it.hit.setAttribute("x", (L - pos[i]).toFixed(2)); it.hit.setAttribute("width", Math.max(0, R - L).toFixed(2));
        it.hit.setAttribute("y", y1.toFixed(2)); it.hit.setAttribute("height", (y2 - y1).toFixed(2));
      });
    }

    // Only one marker is open at a time, and the dots in the open row grow to pill height
    let openIx = null;
    function setRowHot(row, hot) {
      scope.stopAfter(row.cool);
      const go = () => {
        if (row.hot === hot) return;
        row.hot = hot;
        if (!hot) {                                          // however the row was left, it always eases back to its home beside the station name
          row.pin = null; if (pinRow === row) pinRow = null;
          if (row.off) tween(row.off, 0, 220, v => { if (!row.pin) { row.off = v; layoutRow(row); } });
        }
        tween(row.k, hot ? 1 : 0, 180, v => { row.k = v; row.items.forEach(it => it.render()); layoutRow(row); });
      };
      if (hot) go(); else row.cool = scope.after(go, 160); // brief grace while moving between neighbours
    }

    function marker(parent, key, cx, cy, align, vert, row, si) {
      const [name, col, kind] = L[key];
      const grow = align === "end" ? "left" : align === "start" ? "right" : "centre";
      if (row.k === undefined) { row.k = 0; row.hot = false; }
      const g = el("g", { class: "ix", tabindex: "0", role: "img", "aria-label": kind === "rail" ? "National Rail" : `${name} line`, transform: `translate(${cx} ${cy})` }, parent);
      const hit = el("rect", { class: "ix-hit" }, g);
      if (si !== undefined) g.setAttribute("data-st", S[si].id);
      if (GO_LINES.has(key) && si !== undefined) {           // tap to switch to that line from this station
        g.classList.add("ix-go"); g.setAttribute("role", "button"); g.setAttribute("aria-label", `${name} line: switch to this line`);
        let tapOpen = null;                                  // touch: was this icon already open when the finger went down?
        g.addEventListener("pointerdown", e => { tapOpen = e.pointerType === "mouse" ? null : openIx === item; });
        g.addEventListener("click", e => { e.stopPropagation(); if (tapOpen === false) return; switchLine(key, si); });
        g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchLine(key, si); } });
      }
      const item = { g, hit, x: cx, y: cy, extra: 0, k: 0, grow: kind === "rail" && grow === "centre" ? "right" : grow, ext: { x1: -7.5, x2: 7.5, y1: -7.5, y2: 7.5 } };
      row.items.push(item);
      const onHover = on => {
        if (on) {
          if (openIx && openIx !== item) openIx.set(false);
          openIx = item;
          row.pin = ixPtr !== null ? { item } : null;         // keyboard focus doesn't pin
          pinRow = row.pin ? row : pinRow;
          parent.appendChild(g);
          setRowHot(row, true);
        } else {
          if (openIx === item) openIx = null;
          if (row.pin && row.pin.item === item) row.pin = null;
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
          const dy = (vert === "up" ? -7 : vert === "down" ? 7 : 0) * row.k;   // same centre line as the round icons, which grow 7 units towards the label side
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
        const w = Math.max(0, dr + (Math.max(full, dr) - dr) * k), h = Math.max(0, dr + (PILL_H - dr) * k);   // never negative, even if a tween overshoots
        const x = item.grow === "right" ? -d0 / 2 : item.grow === "left" ? d0 / 2 - w : -w / 2;
        const y = (vert === "up" ? -7 : vert === "down" ? 7 : 0) * row.k - h / 2;   // every icon in the row shares one centre line
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
      let on = false, touch = false;
      const set = v => { if (v !== on) { on = v; fn(v); } };
      const kind = e => { touch = e.pointerType !== "mouse"; };
      g.addEventListener("pointerenter", kind); g.addEventListener("pointerdown", kind);
      g.addEventListener("mouseenter", () => set(true));
      g.addEventListener("mouseleave", () => { if (!touch) set(false); });   // on touch, tapping elsewhere (blur) closes it
      g.addEventListener("focus", () => set(true));
      g.addEventListener("blur", () => set(false));
      g.addEventListener("click", () => set(touch ? true : !on));   // a tap opens it; tapping elsewhere closes it
      return set;
    }

    // geometry
    const segs = TRACK_SEGS.map(([a, b]) => [S[a], S[b]]);
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
        best.mks.forEach(([key, cx, cy]) => marker(labelLayer, key, cx, cy, best.align, best.dir === "top" ? "up" : best.dir === "bottom" ? "down" : "mid", row, S.indexOf(s)));
        if (row.items.length) layoutRow(row);
      });
      fitView();
    }

    /* ---------- View: fit to the line, plus zoom and pan ---------- */
    const view = { base: null, x: 0, y: 0, w: 1, h: 1, user: false };
    const narrow = window.matchMedia("(max-width: 860px)");
    function fitView() {
      const bb = content.getBBox();
      // include the train lanes, which can sit outside the labels (e.g. below Brixton)
      const xs = S.map(s => s.x), ys = S.map(s => s.y), m = LANE_OUTER + 6;
      const x1 = Math.min(bb.x, Math.min(...xs) - m), y1 = Math.min(bb.y, Math.min(...ys) - m);
      const x2 = Math.max(bb.x + bb.width, Math.max(...xs) + m), y2 = Math.max(bb.y + bb.height, Math.max(...ys) + m);
      const pad = 56; // same clearance on every side
      view.base = { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
      if (txBusy) return;                                    // the hand-over animation owns the view
      if (view.user) applyView(); else resetView();
    }
    // screen shape of the map area (on phones the map takes the line's own shape and the page scrolls)
    function aspect() {
      if (narrow.matches || !view.base) return view.base ? view.base.w / view.base.h : 1;
      const r = svg.getBoundingClientRect();
      return r.width > 10 && r.height > 10 ? r.width / r.height : view.base.w / view.base.h;
    }
    function fitSize() {
      const b = view.base, a = aspect();
      return b.w / b.h > a ? { w: b.w, h: b.w / a } : { w: b.h * a, h: b.h };
    }
    function resetView() {
      if (!view.base) return;
      const f = fitSize(), b = view.base;
      view.w = f.w; view.h = f.h; view.x = b.x + b.w / 2 - f.w / 2; view.y = b.y + b.h / 2 - f.h / 2;
      view.user = false;
      applyView();
    }
    function applyView() {
      const b = view.base, f = fitSize(), a = aspect();
      // keep the zoom level (units per screen pixel) when the map area changes shape
      let cx = view.x + view.w / 2, cy = view.y + view.h / 2;
      let w = Math.max(f.w / ZOOM_MAX, Math.min(f.w * ZOOM_OUT, view.w));
      view.w = w; view.h = w / a;
      // don't let the line wander off screen
      cx = Math.max(b.x, Math.min(b.x + b.w, cx)); cy = Math.max(b.y, Math.min(b.y + b.h, cy));
      view.x = cx - view.w / 2; view.y = cy - view.h / 2;
      svg.setAttribute("viewBox", `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`);
      svg.classList.toggle("zoomed", view.user);
      const z = document.getElementById("zoom-fit"); if (z) z.disabled = !view.user;
    }
    const ZOOM_MAX = 8, ZOOM_OUT = 1.6;
    function toMap(clientX, clientY) {
      const r = svg.getBoundingClientRect();
      return { x: view.x + (clientX - r.left) / r.width * view.w, y: view.y + (clientY - r.top) / r.height * view.h, r };
    }
    function zoomAt(clientX, clientY, f) {
      if (!view.base) return;
      const p = toMap(clientX, clientY), fs = fitSize();
      const w = Math.max(fs.w / ZOOM_MAX, Math.min(fs.w * ZOOM_OUT, view.w * f)); f = w / view.w;
      view.x = p.x - (p.x - view.x) * f; view.y = p.y - (p.y - view.y) * f; view.w = w; view.h = view.h * f;
      view.user = true; applyView();
    }
    function zoomCentre(f) { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); }
    scope.on(svg, "wheel", e => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;          // lines -> pixels
      zoomAt(e.clientX, e.clientY, Math.exp(d * (e.ctrlKey ? 0.01 : 0.0015)));  // ctrlKey = trackpad pinch
    }, { passive: false });
    // drag to pan, two fingers to pinch; a drag never counts as a click
    const pts = new Map(); let drag = null, dragged = false;
    scope.on(svg, "pointerdown", e => {
      if (e.button !== 0) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      drag = { sx: e.clientX, sy: e.clientY }; dragged = false;
    });
    scope.on(svg, "pointermove", e => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId); const cur = { x: e.clientX, y: e.clientY };
      if (!dragged && Math.hypot(cur.x - drag.sx, cur.y - drag.sy) < 5 && pts.size < 2) return;
      if (!dragged) { dragged = true; try { svg.setPointerCapture(e.pointerId); } catch (x) {} hideTip && hideTip(); }
      const r = svg.getBoundingClientRect();
      if (pts.size >= 2) {
        const [a, b] = [...pts.entries()].map(([id, v]) => id === e.pointerId ? cur : v);
        const [pa, pb] = [...pts.values()];
        const d0 = Math.hypot(pa.x - pb.x, pa.y - pb.y), d1 = Math.hypot(a.x - b.x, a.y - b.y);
        if (d0 > 0 && d1 > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d0 / d1);
        view.x -= ((cur.x - prev.x) / 2) / r.width * view.w; view.y -= ((cur.y - prev.y) / 2) / r.height * view.h;
      } else {
        view.x -= (cur.x - prev.x) / r.width * view.w; view.y -= (cur.y - prev.y) / r.height * view.h;
      }
      pts.set(e.pointerId, cur); view.user = true; applyView();
    });
    const endPointer = e => { pts.delete(e.pointerId); if (!pts.size) drag = null; };
    scope.on(svg, "pointerup", endPointer); scope.on(svg, "pointercancel", endPointer);
    scope.on(svg, "click", e => { if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; } }, true);
    scope.on(svg, "dblclick", e => { if (!e.target.closest(".station-link, .train, .ix, .dest-alert")) resetView(); });
    if (window.ResizeObserver) scope.observe(new ResizeObserver(() => { if (view.base && !txBusy && !scope.dead) (view.user ? applyView : resetView)(); })).observe(svg);

    layout();
    if (document.fonts) {
      const relayout = () => { if (!scope.dead) layout(); };
      document.fonts.load('500 20px "Outfit"').then(relayout).catch(() => {});
      if (document.fonts.addEventListener) scope.on(document.fonts, "loadingdone", relayout);
      document.fonts.ready.then(relayout);
    }

    /* ---------- Live state ---------- */
    const trains = new Map();   // vehicleId -> train state
    let lastFetch = 0, lastOk = 0, fetchError = null, everLoaded = false;

    function apiUrl(path) {
      let key = "";
      try { key = localStorage.getItem("tfl-app-key") || ""; } catch (e) {}
      return API + path + (key ? (path.includes("?") ? "&" : "?") + "app_key=" + encodeURIComponent(key) : "");
    }

    const DEBUG = DEBUG_ON ? { departures: [] } : null;
    const sgn = dir => dir === "S" ? 1 : -1;

    /* ---------- Routes: track geometry and train lanes for each run of stations ----------
       Each direction runs in its own lane on its left of the track. On the outside of a bend the lane
       wraps round the station; on the inside it takes a wider curve so the carriage never clips the track. */
    function makeRoute(st, id) {
      const P = st.map(i => S[i]);
      const R = { id, st, LAST: st.length - 1, pos: {} };
      st.forEach((g, k) => { R.pos[g] = k; });
      R.segLen = P.slice(1).map((s, i) => Math.hypot(s.x - P[i].x, s.y - P[i].y));
      R.cum = [0]; R.segLen.forEach((l, i) => R.cum.push(R.cum[i] + l));
      R.segOf = D => { let i = 0; while (i < R.segLen.length - 1 && D > R.cum[i + 1]) i++; return i; };
      R.stationAt = D => { for (let k = 0; k <= R.LAST; k++) if (Math.abs(D - R.cum[k]) < 0.5) return k; return -1; };
      R.run = seg => runTime(st[seg], st[seg + 1]);
      R.nominalSpeed = seg => R.segLen[seg] / Math.max(40, R.run(seg) - 15); // track px per second
      function buildLane(dir) {
        const side = sgn(dir), LAST = R.LAST;
        const u = R.segLen.map((l, i) => ({ x: (P[i + 1].x - P[i].x) / l, y: (P[i + 1].y - P[i].y) / l }));
        const n = u.map(v => ({ x: side * v.y, y: -side * v.x }));
        const pts = [], anchorsIdx = [];
        const push = (x, y) => pts.push({ x, y });
        push(P[0].x + n[0].x * LANE, P[0].y + n[0].y * LANE); anchorsIdx.push(0);
        const arc = (cx, cy, r, a1, a2) => {
          let da = a2 - a1; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
          const steps = Math.max(6, Math.ceil(Math.abs(da) / (Math.PI / 90)));
          const start = pts.length;
          for (let i = 0; i <= steps; i++) { const a = a1 + da * i / steps; push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
          return start + Math.round(steps / 2);
        };
        for (let k = 1; k < LAST; k++) {
          const V = P[k], u1 = u[k - 1], u2 = u[k], n1 = n[k - 1], n2 = n[k];
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
        push(P[LAST].x + nl.x * LANE, P[LAST].y + nl.y * LANE); anchorsIdx.push(pts.length - 1);
        const cl = [0];
        for (let i = 1; i < pts.length; i++) cl.push(cl[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
        return { pts, cl, anchors: anchorsIdx.map(i => cl[i]), total: cl[cl.length - 1] };
      }
      R.LANES = { S: buildLane("S"), N: buildLane("N") };
      // track distance <-> lane distance (piecewise linear between stations)
      R.toL = (D, dir) => {
        const A = R.LANES[dir].anchors, i = R.segOf(D);
        return A[i] + (Math.max(0, Math.min(R.segLen[i], D - R.cum[i])) / R.segLen[i]) * (A[i + 1] - A[i]);
      };
      R.fromL = (Lv, dir) => {
        const A = R.LANES[dir].anchors;
        let i = 0; while (i < A.length - 2 && Lv > A[i + 1]) i++;
        return R.cum[i] + Math.max(0, Math.min(1, (Lv - A[i]) / (A[i + 1] - A[i]))) * R.segLen[i];
      };
      R.poseAtL = (Lv, dir) => {
        const { pts, cl } = R.LANES[dir];
        let lo = 0, hi = cl.length - 1;
        Lv = Math.max(0, Math.min(cl[hi], Lv));
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cl[mid] <= Lv) lo = mid; else hi = mid; }
        const a = pts[lo], b = pts[hi], f = cl[hi] > cl[lo] ? (Lv - cl[lo]) / (cl[hi] - cl[lo]) : 0;
        let ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
        if (dir === "N") ang += 180;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, ang };
      };
      R.poseAt = (D, dir) => R.poseAtL(R.toL(D, dir), dir);
      return R;
    }
    const ROUTES = ROUTE_LISTS.map((st, i) => makeRoute(st, i));
    const R0 = ROUTES[0];
    // a station is a terminus if it is an end of every route that uses it
    // One-way track (e.g. the Heathrow loop): pairs listed [from, to] may only be run in that order
    const ONEWAY_BAD = new Set((LINE.oneway || []).map(([a, b]) => byId[b] + ">" + byId[a]));
    // Loop destinations: a train shown as going to one station actually carries on round to another before turning
    const LOOP_END = new Set(Object.values(LINE.loopTo || {}).map(id => byId[id]));
    const LOOP_TO = Object.fromEntries(Object.entries(LINE.loopTo || {}).map(([a, b]) => [byId[a], byId[b]]));
    // Branch names for "via" text (e.g. Northern line "via Bank" / "via Charing Cross")
    const VIA_IDX = (LINE.via || []).map(id => byId[id]).filter(i => i !== undefined);
    const viaNorm = txt => (txt || "").replace(/\bCX\b/g, "Charing Cross").trim();
    function viaFromTowards(towards) {
      const m = /\bvia\s+(.+)$/i.exec(towards || "");
      return m ? viaNorm(m[1]) : "";
    }
    // Which branch station lies ahead of index k (towards destination g) on route R, if any
    function viaOnRoute(R, k, dir, g) {
      if (!VIA_IDX.length || k == null) return "";
      const s = dir === "S" ? 1 : -1, end = g !== undefined && R.pos[g] !== undefined ? R.pos[g] : (dir === "S" ? R.LAST : 0);
      for (let i = k; s * (end - i) > 0; i += s) {
        const st = R.st[i + s];
        if (VIA_IDX.includes(st) && st !== g) return S[st].name;
      }
      return "";
    }
    const shownDest = t => S[t.destShow !== undefined && t.destShow !== null ? t.destShow : t.dest];
    function viaText(t) {
      let v = viaFromTowards(t.towards);
      if (!v) {                                   // no TfL wording: only say "via" once the predictions pin the branch down
        const guess = viaOnRoute(t.r, t.next != null ? t.next - sgn(t.dir) : null, t.dir, t.dest);
        const gi = VIA_IDX.find(i => S[i].name === guess);
        const pinned = gi !== undefined && (t.stops || []).some(st => {
          const g = t.r.st[st.idx];
          return ROUTES.every(R => R.pos[g] === undefined || R.pos[gi] !== undefined);
        });
        if (pinned) v = guess;
      }
      return v ? ` via ${v}` : "";
    }
    const destFull = t => shownDest(t).name + viaText(t);
    const isTermG = g => ROUTES.every(R => R.pos[g] === undefined || R.pos[g] === 0 || R.pos[g] === R.LAST) && ROUTES.some(R => R.pos[g] !== undefined);

    // Where train o is, expressed as a distance along route R (null if o isn't on track that R shares)
    function projectD(o, R, D) {
      if (D === undefined) D = o.D;
      if (o.r === R) return D;
      const Q = o.r, i = Q.segOf(D), f = Q.segLen[i] ? (D - Q.cum[i]) / Q.segLen[i] : 0;
      const a = Q.st[i], b = Q.st[i + 1];
      if (f <= 0.001 && R.pos[a] !== undefined) return R.cum[R.pos[a]];
      if (f >= 0.999 && R.pos[b] !== undefined) return R.cum[R.pos[b]];
      const ja = R.pos[a], jb = R.pos[b];
      if (ja === undefined || jb === undefined || Math.abs(ja - jb) !== 1) return null;
      return ja < jb ? R.cum[ja] + f * R.segLen[ja] : R.cum[jb] + (1 - f) * R.segLen[jb];
    }

    // Which way train o is heading, in route R's terms (routes can run the same track in opposite orders, e.g. round a loop)
    function projDir(o, R) {
      if (o.r === R) return o.dir;
      const Q = o.r, i = Q.segOf(o.D), ja = R.pos[Q.st[i]], jb = R.pos[Q.st[i + 1]];
      if (ja === undefined || jb === undefined) return o.dir;
      return jb > ja ? o.dir : (o.dir === "S" ? "N" : "S");
    }

    // Direction of a prediction along route R: "S" = towards the route's last station, "N" = towards its first
    function directionOn(R, g, destG, platform) {
      const k = R.pos[g], d = destG === undefined ? undefined : R.pos[destG];
      if (k !== undefined && d !== undefined && d !== k) return d > k ? "S" : "N";
      if (d !== undefined && d === R.LAST) return "S";
      if (d !== undefined && d === 0) return "N";
      const plat = (platform || "").toLowerCase();
      if (LINE.dirs.S.platform.some(w => plat.startsWith(w))) return "S";
      if (LINE.dirs.N.platform.some(w => plat.startsWith(w))) return "N";
      return null;
    }
    // Direction for a station board row: from the first route that has both the station and the destination
    function directionAny(g, destG, platform) {
      const R = ROUTES.find(R => R.pos[g] !== undefined && destG !== undefined && R.pos[destG] !== undefined && destG !== g) ||
                ROUTES.find(R => R.pos[g] !== undefined);
      return R ? directionOn(R, g, destG, platform) : null;
    }

    // Pick the route that best explains a vehicle's predictions (and, if given, starts from station mustG)
    function chooseRoute(raw, t, mustG) {
      let best = null;
      ROUTES.forEach(R => {
        if (mustG != null && R.pos[mustG] === undefined) return;
        const first = raw[0];
        if (R.pos[first.g] === undefined) return;
        const dir = directionOn(R, first.g, first.dest, first.plat);
        if (!dir) return;
        const s = sgn(dir), k0 = R.pos[first.g];
        let score = 0;
        raw.forEach(p => {
          const k = R.pos[p.g];
          if (k === undefined) { score -= 1; return; }
          if (s * (k - k0) >= 0) score += 1;
        });
        if (first.dest !== undefined && R.pos[first.dest] === undefined) score -= 5;   // destination is on another branch
        if (first.shown !== undefined && R.pos[first.shown] === undefined) score -= 5; // named loop station (e.g. Terminal 4) not on this route
        if (ONEWAY_BAD.size) {                                                        // would run one-way track the wrong way
          const kFrom = mustG != null ? R.pos[mustG] : k0 - s;
          const kTo = Math.max(...raw.map(p => R.pos[p.g] === undefined ? -Infinity : s * R.pos[p.g])) * s;
          for (let i = kFrom; s * (kTo - i) > 0; i += s) {
            if (i < 0 || i + s < 0 || i > R.LAST || i + s > R.LAST) continue;
            if (ONEWAY_BAD.has(R.st[i] + ">" + R.st[i + s])) { score -= 20; break; }
          }
        }
        const via = VIA_IDX.length ? viaFromTowards(first.towards) : "";
        if (via) {                                                                    // "via Bank": the route must pass that branch ahead
          const vi = VIA_IDX.find(i => S[i].name.toLowerCase() === via.toLowerCase());
          if (vi !== undefined && R.pos[vi] === undefined) score -= 5;
        }
        if (t && t.r === R) score += 0.5;                                               // stay on the current route if it fits
        if (mustG != null) {                                                          // leaving a terminus: must lead away from it
          const km = R.pos[mustG];
          if (s * (k0 - km) <= 0) score -= 10;
        }
        if (!best || score > best.score) best = { R, dir, score };
      });
      if (!best) return null;
      const R = best.R;
      const preds = raw.filter(p => R.pos[p.g] !== undefined).map(p => ({
        idx: R.pos[p.g], dir: directionOn(R, p.g, p.dest, p.plat) || best.dir, tts: p.tts, loc: p.loc, dest: p.dest, pdir: p.pdir, towards: p.towards, shown: p.shown
      }));
      return { R, preds };
    }

    function learnRunTimes(R, preds) {
      // For one vehicle, consecutive stations in its own direction give running time + dwell.
      for (let i = 1; i < preds.length; i++) {
        const a = preds[i - 1], b = preds[i];
        if (a.dir !== b.dir || Math.abs(a.idx - b.idx) !== 1) continue;
        const dt = b.tts - a.tts;
        if (dt < 40 || dt > 400) continue;
        const key = runKey(R.st[a.idx], R.st[b.idx]);
        RUNT.set(key, (RUNT.get(key) || 120) * 0.9 + dt * 0.1);
      }
    }

    const boardData = new Map(); // station index -> predictions at that station
    const orderStrikes = new Map(); // "front>back" -> updates in a row the data has had them the other way round
    const opp = d => d === "S" ? "N" : "S";
    function ingest(data) {
      const now = performance.now();
      const groups = new Map();
      boardData.clear();
      data.forEach(p => {
        const idx = byNaptan[p.naptanId];
        if (idx === undefined) return;
        const destG = byNaptan[p.destinationNaptanId];
        const dir = directionAny(idx, destG, p.platformName);
        if (!dir) return;
        const list = boardData.get(idx) || boardData.set(idx, []).get(idx);
        const key = (p.vehicleId || "").trim() || p.id;
        const existing = list.find(x => x.key === key && x.dir === dir);
        if (existing && existing.tts <= p.timeToStation) return;
        if (existing) list.splice(list.indexOf(existing), 1);
        list.push({ key, dir, tts: p.timeToStation, fetchedAt: now,
          dest: destG, destName: (p.destinationName || "").replace(/ Underground Station$/, ""),
          pdir: platformWord(p.platformName), towards: p.towards || "",
          platform: (p.platformName || "").replace(/^\w+bound\s*-\s*/i, "") });
      });
      data.forEach(p => {
        const v = (p.vehicleId || "").trim();
        const g = byNaptan[p.naptanId];
        if (!v || v === "000" || g === undefined) return;
        let dg = byNaptan[p.destinationNaptanId], shown;
        if (dg !== undefined && LOOP_TO[dg] !== undefined) { shown = dg; dg = LOOP_TO[dg]; }
        (groups.get(v) || groups.set(v, []).get(v)).push({
          g, tts: p.timeToStation, loc: p.currentLocation || "", dest: dg, shown,
          plat: p.platformName || "", pdir: platformWord(p.platformName), towards: p.towards || ""
        });
      });

      const seen = new Set();
      const termAhead = t => t.dir === "S" ? t.r.LAST : 0;       // end of the route a train is heading for
      const termBehind = (R, dir) => dir === "S" ? 0 : R.LAST;    // end of the route a train in `dir` has just left

      groups.forEach((raw, v) => {
        raw.sort((a, b) => a.tts - b.tts);
        let t = trains.get(v);
        if (t) seen.add(v);
        const waitingG = t && t.waiting !== null && t.waiting !== undefined ? t.waiting : null;
        const pick = chooseRoute(raw, t, null);
        if (!pick || !pick.preds.length) return;
        let R = pick.R, preds = pick.preds;
        learnRunTimes(R, preds);
        let next = preds[0];
        let s = sgn(next.dir);
        seen.add(v);

        // Has this train just left the end of its route? (first stop ahead is one or two stations out)
        let from = termBehind(R, next.dir);
        const justLeft = next.idx === from + s || next.idx === from + 2 * s;

        // A new Vehicle ID leaving a terminus takes over a waiting train, but only one that has waited longer
        // than any normal turn-round (otherwise it's a different train and the waiting one keeps its place)
        if (!t && justLeft) {
          const q = waitingAt(R.st[from]).filter(w => now - w.waitSince >= RENUMBER_MS);
          const front = q[0];
          if (front) { trains.delete(front.v); front.renumberedFrom = front.v; front.v = v; trains.set(v, front); t = front; }
        }
        const isNew = !t;
        if (isNew) {
          t = { v, r: R, opacity: 0, x: null, y: null, ang: 0, node: null, D: null, pendingD: null, arrivedAt: null,
                waiting: null, queued: false, dest: undefined, destCand: null, destCandN: 0, alertUntil: 0 };
          trains.set(v, t);
        }
        let feedDest = next.dest !== undefined ? next.dest : R.st[next.dir === "S" ? R.LAST : 0];

        // Waiting at a terminus and the feed now shows it leaving: fill in its label and send it on its way
        if (t.waiting !== null && t.waiting !== undefined) {
          const W = chooseRoute(raw, t, t.waiting);               // the route it leaves on must start from this station
          if (W && W.preds.length) {
            const wn = W.preds[0], wk = W.R.pos[t.waiting];
            const wdir = wn.dir;
            if (wdir === (wk === 0 ? "S" : wk === W.R.LAST ? "N" : opp(t.arrDir)) && leavingTerminus(W.R, wn, wk)) {
              departFrom(t, now);
              t.r = W.R; t.D = W.R.cum[wk];
              R = W.R; preds = W.preds; next = wn; s = sgn(next.dir); from = wk;
              feedDest = next.dest !== undefined ? next.dest : R.st[next.dir === "S" ? R.LAST : 0];
            }
          }
        }
        if (t.waiting !== null && t.waiting !== undefined) { t.fetchedAt = now; t.missed = 0; return; }   // still waiting: no data about leaving yet

        // Still running into the end of its route on screen, but the feed already shows it heading back out:
        // hurry it in, turn it round quickly and send it on with the new data (only when it is close to the end)
        if (!isNew && !t.loop && t.pendingD === null && t.D !== null && t.dir !== next.dir && t.r.st[termAhead(t)] === R.st[from]) {
          const Q = t.r, endK = termAhead(t);
          const nearEnd = endK === Q.LAST ? Q.segOf(t.D) >= Q.LAST - 2 : Q.segOf(t.D) <= 1;
          if (nearEnd || t.rush) {
            t.rush = true; t.turnAt = endK; t.stops = [{ idx: endK, at: now }]; t.midWait = null;
            // only carry the new data through if it shows the train actually on its way out; otherwise it just waits there
            t.after = leavingTerminus(R, next, from) ? { R, next, stops: stopsFrom(preds, next, now), feedDest, fetchedAt: now } : null;
            t.fetchedAt = now; t.missed = 0;
            return;
          }
        }
        const heldAtG = t.midWait != null ? t.r.st[t.midWait] : null;   // was holding at a mid-line terminus
        t.rush = false; t.after = null; t.midWait = null;

        // Switching route (e.g. the feed now shows which branch it takes): carry its position across
        let moved = false;
        if (!isNew && t.r !== R) {
          const pd = t.D !== null ? projectD(t, R) : null;
          const pp = t.pendingD !== null ? projectD(t, R, t.pendingD) : null;
          t.r = R;
          if (pd !== null) { t.D = pd; if (t.pendingD !== null) t.pendingD = pp !== null ? pp : null; }
          else { moved = true; }
          t.loop = null; t.turnAt = null;
        }

        const flipped = !isNew && t.dir !== next.dir;
        const prevDest = t.dest;
        Object.assign(t, { dir: next.dir, next: next.idx, tts: next.tts, loc: next.loc, pdir: next.pdir, stops: stopsFrom(preds, next, now), fetchedAt: now, missed: 0 });
        t.turnAt = null;

        // Destination: only accept a change once it has held for two updates, then flag it for 30 seconds
        if (isNew || t.freshDepart || prevDest === undefined) { t.dest = feedDest; t.destCand = null; t.destCandN = 0; t.freshDepart = false; }
        else if (feedDest !== prevDest) {
          if (t.destCand === feedDest) t.destCandN++; else { t.destCand = feedDest; t.destCandN = 1; }
          if (t.destCandN >= 2) { t.dest = feedDest; t.destCand = null; t.destCandN = 0; if (!flipped) t.alertUntil = now + 30000; }
        } else { t.destCand = null; t.destCandN = 0; }
        t.destShow = t.dest === feedDest ? next.shown : t.destShow;
        t.towards = next.towards || "";

        if (isNew) {
          if (justLeft) { t.D = R.cum[from]; t.arrivedAt = now - DWELL_MS; t.needsPlace = false; t.freshDepart = false; } // brand-new: start at the platform
          else { t.D = modelD(t, now); t.needsPlace = true; }
        } else if (moved) {
          t.pendingD = modelD(t, now); t.noDwell = true;                 // on a branch it couldn't reach: fade across
          if (t.D === null || projectD(t, R) === null) t.D = t.pendingD;
        } else if (flipped) {
          // turned back where it was holding (e.g. Seven Sisters): swap lanes there; otherwise go where the data puts it
          const hk = heldAtG != null ? R.pos[heldAtG] : undefined;
          t.pendingD = hk !== undefined && hk === next.idx - s ? R.cum[hk] : modelD(t, now);
          t.noDwell = true;                                               // it has already left in real life
        } else {
          const model = modelD(t, now);
          if (s * (model - t.D) > Math.max(220, R.segLen[R.segOf(t.D)] * 1.2)) t.pendingD = model; // far behind (missed updates)
        }
      });

      trains.forEach((t, v) => {
        if (seen.has(v)) return;
        if (t.waiting !== null && t.waiting !== undefined) return;         // waiting trains never time out here
        const R = t.r, isTerm = k => k === 0 || k === R.LAST;
        // Vanished while heading into the end of its route: it is turning round, so keep it
        if (t.pendingD === null && t.next === termAhead(t) && (isTermG(R.st[t.next]) || LOOP_END.has(R.st[t.next]))) { t.turnAt = t.next; t.missed = 0; return; }
        // Vanished while terminating mid-line: hold at that platform for a while in case it reappears
        const lastStop = t.stops && t.stops.length ? t.stops[t.stops.length - 1].idx : t.next;
        if (t.pendingD === null && !t.rush && !(isTerm(lastStop) && isTermG(R.st[lastStop])) && R.st[lastStop] === t.dest) {
          if (t.midWait == null) { t.midWait = lastStop; t.midSince = now; }
          if (now - t.midSince < MID_GRACE_MS) { t.missed = 0; return; }
        }
        t.missed = (t.missed || 0) + 1;
      });
      // Order check: if the data puts a train ahead of the one in front of it on screen for two updates in a row,
      // swap them (both fade and reappear in each other's place) instead of queueing it forever
      const inOrder = new Set();
      const live = [...trains.values()].filter(t => t.fetchedAt === now && t.missed === 0 && t.D !== null &&
        t.pendingD === null && !t.loop && !t.rush && !t.needsPlace && t.midWait == null && (t.waiting === null || t.waiting === undefined) && !t.retiring);
      ROUTES.forEach(R => ["N", "S"].forEach(dir => {
        const s = sgn(dir);
        const line = live.filter(t => projDir(t, R) === dir).map(t => ({ t, d: projectD(t, R), nk: R.pos[t.r.st[t.next]] }))
          .filter(x => x.d !== null && x.nk !== undefined)
          .sort((a, b) => s * (b.d - a.d));                                  // screen order, front first
        for (let i = 0; i + 1 < line.length; i++) {
          const front = line[i], back = line[i + 1];
          const key = front.t.v + ">" + back.t.v;
          if (inOrder.has(key)) continue;
          const wrong = back.nk !== front.nk ? s * (back.nk - front.nk) > 0 : back.t.tts < front.t.tts - 10;
          if (!wrong) continue;
          const fOnB = projectD(front.t, back.t.r), bOnF = projectD(back.t, front.t.r);
          if (fOnB === null || bOnF === null) continue;
          inOrder.add(key);
          orderStrikes.set(key, (orderStrikes.get(key) || 0) + 1);
          if (orderStrikes.get(key) >= 2) {
            front.t.pendingD = bOnF; back.t.pendingD = fOnB; front.t.noDwell = back.t.noDwell = true;
            orderStrikes.delete(key);
            if (DEBUG) (DEBUG.swaps = DEBUG.swaps || []).push(`${back.t.v} ahead of ${front.t.v}`);
          }
        }
      }));
      orderStrikes.forEach((n, key) => { if (!inOrder.has(key)) orderStrikes.delete(key); });

      // Late at night: a train left waiting with nothing following it goes out of service
      trains.forEach(t => { if (t.waiting !== null && t.waiting !== undefined && now - t.waitSince > WAIT_MAX_MS) retire(t); });
    }

    // This train's own timetable: remaining stops in order, each with an arrival time
    function stopsFrom(preds, next, now) {
      const s = sgn(next.dir), best = new Map();
      preds.forEach(p => {
        if (p.dir !== next.dir || s * (p.idx - next.idx) < 0) return;
        if (!best.has(p.idx) || best.get(p.idx).tts > p.tts) best.set(p.idx, p);
      });
      const stops = [...best.values()].sort((a, b) => s * (a.idx - b.idx)).map(p => ({ ...p }));
      let lastAt = 0;
      stops.forEach(p => { p.at = Math.max(now + p.tts * 1000, lastAt ? lastAt + 15000 : 0); lastAt = p.at; });
      return stops;
    }

    /* ---------- Terminus turn-rounds ---------- */
    function waitingAt(g) {
      return [...trains.values()].filter(t => t.waiting === g && !t.retiring).sort((a, b) => a.waitSince - b.waitSince);
    }
    // Does this prediction show a train actually on its way out of the end of route R (station k)? (not just a timetabled departure)
    function leavingTerminus(R, next, k) {
      const adj = k === 0 ? 1 : R.LAST - 1;
      if (next.idx === adj) return true;                                    // next stop is the first one out
      const loc = (next.loc || "").trim().toLowerCase();
      if (!loc || loc === "0") return false;                                // placeholder: still sitting at the platform
      const term = S[R.st[k]].name.toLowerCase().split(" ")[0];
      if (loc.startsWith("at " + term) || loc.startsWith(term)) return false; // "At Brixton", "Brixton Area" with a far-off first stop
      return true;                                                          // somewhere real on the line
    }
    const RENUMBER_MS = 8 * 60000;     // longer than any real turn-round seen (3-7 minutes)
    const WAIT_MAX_MS = 10 * 60000;    // a train left waiting this long has gone out of service
    function retire(t) { t.retiring = true; t.missed = 2; t.waiting = null; t.midWait = null; }
    const MID_GRACE_MS = 8 * 60000;   // how long a train that terminated mid-line is kept if it drops out of the feed
    // Arrived at the platform: turn round into the departing lane (or queue on the arrival platform) and wait
    function arriveAtTerminus(t, k, now) {
      const g = t.r.st[k];
      const q = waitingAt(g);
      if (q.length >= 2) retire(q[0]);                       // only two platforms: the oldest has gone out of service
      t.waiting = g; t.waitK = k; t.waitSince = now; t.arrDir = t.dir; t.turnAt = null; t.stops = []; t.loc = "";
      const others = waitingAt(g).filter(w => w !== t);
      if (others.some(w => !w.queued)) { t.queued = true; return; }   // other platform: stays in the arrival lane for now
      const earlier = others.find(w => w.queued);
      if (earlier) { turnRound(earlier, now); t.queued = true; }       // the train that arrived first leaves first
      else turnRound(t, now);
      if (t.rush && !t.after) t.rush = false;
      if (t.rush && t.after) {
        const a = t.after;
        departFrom(t, now, true);
        if (a.R !== t.r) { t.r = a.R; t.D = a.R.cum[a.R.pos[g]]; }
        Object.assign(t, { dir: a.next.dir, next: a.next.idx, tts: a.next.tts, loc: a.next.loc, stops: a.stops,
          fetchedAt: a.fetchedAt, dest: a.feedDest, freshDepart: false, rush: false, after: null });
      }
    }
    // U-turn: carry the train round the far side of the terminus station, from the arrival lane to the departure lane
    function turnRound(t, now) {
      t.queued = false;
      const R = t.r;
      const k = t.waitK !== undefined && t.waiting !== null && t.waiting !== undefined ? R.pos[t.waiting] : (t.dir === "S" ? R.LAST : 0);
      const V = S[R.st[k]], W = S[R.st[k === 0 ? 1 : R.LAST - 1]];
      let ux = V.x - W.x, uy = V.y - W.y; const ul = Math.hypot(ux, uy); ux /= ul; uy /= ul;   // pointing beyond the end of the line
      const pa = R.poseAt(R.cum[k], t.dir);                                                 // arrival-lane end
      const a0 = Math.atan2(pa.y - V.y, pa.x - V.x), r = Math.hypot(pa.x - V.x, pa.y - V.y);
      const au = Math.atan2(uy, ux);
      let d = ((au - a0 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;                          // quarter turn towards "beyond"
      const sweep = d >= 0 ? 1 : -1;
      t.loop = { cx: V.x, cy: V.y, r, a0, sweep, p: t.x === null ? 1 : 0, g: R.st[k] };
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
      const R = t.r, k = R.pos[t.loop.g];
      if (k === undefined) return true;
      const L0 = R.toL(R.cum[k], t.dir);
      return !all.some(o => {
        if (o === t || o.D === null || o.loop || (o.waiting !== null && o.waiting !== undefined) || o.retiring) return false;
        const d = projectD(o, R);
        return d !== null && projDir(o, R) === t.dir && Math.abs(R.toL(d, t.dir) - L0) < GAP_L + 6;
      });
    }
    function departFrom(t, now, late) {
      const g = t.waiting;
      // trains leave in any order (two platforms), so nothing else is retired here
      if (t.queued) turnRound(t, now);
      t.waiting = null; t.queued = false; t.freshDepart = true; t.hurry = true;   // already gone: finish the turn quickly
      t.arrivedAt = now - DWELL_MS;                          // it has already left in real life: no extra dwell
      // promote the other waiting train into the departing lane
      const rest = waitingAt(g); if (rest[0] && rest[0].queued) turnRound(rest[0], now);
    }

    // Best estimate of where the data puts a train; used to place new trains and correct big drift
    function modelD(t, now) {
      const R = t.r, s = sgn(t.dir);
      const e = t.tts - (now - t.fetchedAt) / 1000;
      const prev = t.next - s;
      const loc = t.loc.toLowerCase();
      const first = name => name.toLowerCase().split(" ")[0];
      if (prev < 0 || prev > R.LAST) return R.cum[t.next];
      if (e <= 20 || (loc.startsWith("at ") && loc.includes(first(S[R.st[t.next]].name)))) return R.cum[t.next];
      const run = R.run(Math.min(prev, t.next));
      if (e >= run) return R.cum[prev];
      return R.cum[prev] + (R.cum[t.next] - R.cum[prev]) * (1 - e / run);
    }

    // Order two trains by where the data puts them: next station further along first, then sooner arrival.
    // Negative when a is ahead of b. Trains in different directions (or on different branches) keep their order.
    function dataAhead(a, b) {
      if (a.dir !== b.dir) return 0;
      const s = sgn(a.dir), bn = a.r.pos[b.r.st[b.next]];
      if (bn === undefined) return 0;
      if (a.next !== bn) return s * (bn - a.next);
      return a.tts - b.tts;
    }

    // Put a train where it doesn't overlap another in its lane (queues it behind)
    function clearSpot(t, D, all) {
      const R = t.r, s = sgn(t.dir);
      let Lv = R.toL(D, t.dir);
      const others = all.filter(o => o !== t && o.D !== null && o.missed < 2 && o.pendingD === null && !o.needsPlace && projDir(o, R) === t.dir)
        .map(o => projectD(o, R)).filter(d => d !== null).map(d => R.toL(d, t.dir)).sort((a, b) => s * (b - a)); // front first
      for (const Lo of others) if (Math.abs(Lo - Lv) < GAP_L) Lv = Lo - s * GAP_L;
      Lv = Math.max(0, Math.min(R.LANES[t.dir].total, Lv));
      return R.fromL(Lv, t.dir);
    }

    // Advance one train along the track for this frame
    const CATCH = 4;   // top speed, as a multiple of normal, when catching up after a backlog
    function advance(t, now, dt, all) {
      if ((t.waiting !== null && t.waiting !== undefined) || t.retiring || t.loop) { t.moving = false; return; }   // never leave a terminus without data
      const R = t.r, s = sgn(t.dir);
      const D = t.D;
      const here = R.stationAt(D);
      if (t.turnAt !== null && t.turnAt !== undefined && here === t.turnAt) { arriveAtTerminus(t, here, now); t.moving = false; return; }
      if (here >= 0 && t.arrivedAt === null) { t.arrivedAt = (t.noDwell || t.rush) ? now - DWELL_MS : now; t.noDwell = false; }
      if (here < 0) t.arrivedAt = null;

      let target = t.stops.find(st => s * (R.cum[st.idx] - D) > 0.5);
      let targetD, arriveAt = null;
      if (target) { targetD = R.cum[target.idx]; arriveAt = target.at; }
      else { t.moving = false; return; }   // no prediction for any station ahead: never head somewhere the data doesn't say

      // every train waits 15 seconds at a platform
      if (here >= 0 && now - t.arrivedAt < DWELL_MS) { t.moving = false; return; }

      const remaining = Math.abs(targetD - D);
      const vNom = R.nominalSpeed(R.segOf(D + s));
      const timeLeft = arriveAt === null ? null : (arriveAt - now) / 1000;
      let speed;
      if (timeLeft !== null && timeLeft > 0.5) speed = remaining / timeLeft;
      else if (timeLeft !== null) speed = vNom * (1 + Math.min(CATCH - 1, -timeLeft / 10));   // overdue: speed up the longer it's late
      else speed = vNom;
      if (t.rush) speed = CATCH * vNom;
      speed = Math.max(0.2 * vNom, Math.min(CATCH * vNom, speed));
      let step = Math.min(remaining, speed * dt);

      // wait behind the train in front rather than overlapping it (on shared track, whichever branch it's from)
      const Lme = R.toL(D, t.dir);
      let room = Infinity;
      all.forEach(o => {
        if (o === t || o.D === null || o.missed >= 2 || o.pendingD !== null) return;
        if (o.waiting !== null && o.waiting !== undefined && t.turnAt !== null && t.turnAt !== undefined && R.st[t.turnAt] === o.waiting) return; // a full platform means one has left service
        const od = projectD(o, R);
        if (od === null || projDir(o, R) !== t.dir) return;
        const ahead = s * (R.toL(od, t.dir) - Lme);
        if (o.midWait != null && ahead > 0 && ahead - GAP_L < 30) { retire(o); return; }   // the next train needs that platform: it has gone to the sidings
        if (ahead > 0) room = Math.min(room, ahead - GAP_L);
      });
      if (room < Infinity) {
        const maxD = R.fromL(Lme + s * Math.max(0, room), t.dir);
        step = Math.max(0, Math.min(step, s * (maxD - D)));
      }

      if (here >= 0 && step > 0 && DEBUG) DEBUG.departures.push(Math.round((now - t.arrivedAt) / 100) / 10);
      t.D = D + s * step;
      if (Math.abs(t.D - targetD) < 0.5) t.D = targetD;
      t.moving = step > 0;
    }

    /* ---------- Drawing ---------- */
    let mode = (document.querySelector('input[name="lbl"]:checked') || { value: "dest" }).value;   // kept across lines
    const labelFor = t => (t.waiting !== null && t.waiting !== undefined) ? "" : (mode === "dest" ? shownDest(t).code : t.v);

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
      const txt = `Now to ${shownDest(t).code}`;
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

    function frame(now) {
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

        let p = t.r.poseAt(t.D, t.dir);
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
          : `Vehicle ID ${t.v}, ${dirText(t).toLowerCase()} to ${destFull(t)}, ${t.loc || "location not reported"}`);
        drawAlert(t, now, dt);
      });
      gone.forEach(t => { t.node && t.node.remove(); t.alert && t.alert.remove(); trains.delete(t.v); if (selected === t.node) closePop(); });

      scope.frame(frame);
    }

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
        const s = Math.round((Date.now() - lastOk) / 1000);
        up.textContent = s < 5 ? "Updated just now" : `Updated ${s} seconds ago`;
      }
      const empty = everLoaded && n === 0;
      emptyMsg.textContent = "No trains running right now";
      emptyMsg.setAttribute("visibility", empty ? "visible" : "hidden");

      updateClock();
    }

    // Where this line's live data comes from. Only TfL for now; other feeds (e.g. National Rail for Thameslink) plug in here.
    const SOURCE = LINE.source || "tfl";
    const NO_FEED = "Live train data for this line isn't connected yet.";
    async function poll() {
      lastFetch = Date.now();
      if (SOURCE !== "tfl") { fetchError = NO_FEED; updatePanel(); return; }
      try {
        const res = await scope.fetch(apiUrl(`/Line/${LINE.api}/Arrivals`), { cache: "no-store" });
        if (res.status === 429) throw new Error("TfL is limiting requests. Add an API key below, or wait a minute.");
        if (res.status === 401 || res.status === 403) throw new Error("TfL rejected the API key. Check it under TfL API key.");
        if (!res.ok) throw new Error(`TfL returned an error (${res.status}). Retrying in 30 seconds.`);
        const data = await res.json();
        if (scope.dead) return;                              // the line was switched while this reply was on its way
        ingest(Array.isArray(data) ? data : []);
        everLoaded = true; lastOk = Date.now(); fetchError = null;
      } catch (err) {
        if (scope.dead) return;
        fetchError = err && err.message && !/fetch|network/i.test(err.message)
          ? err.message
          : "Can't reach TfL right now. Trains keep moving on the last data; retrying in 30 seconds.";
      }
      updatePanel();
    }

    async function pollStatus() {
      const pill = document.getElementById("status-pill");
      const reason = document.getElementById("status-reason");
      if (SOURCE !== "tfl") { pill.textContent = "Status unavailable"; pill.dataset.level = "unknown"; reason.hidden = true; return; }
      try {
        const res = await scope.fetch(apiUrl(`/Line/${LINE.api}/Status`), { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (scope.dead) return;
        const st = (data[0] && data[0].lineStatuses && data[0].lineStatuses[0]) || {};
        const sev = st.statusSeverity;
        pill.textContent = st.statusSeverityDescription || "Status unavailable";
        pill.dataset.level = sev === 10 ? "good" : (sev >= 7 ? "minor" : (sev === undefined ? "unknown" : "severe"));
        if (st.reason && sev !== 10) { reason.textContent = st.reason.trim(); reason.hidden = false; }
        else reason.hidden = true;
      } catch (e) {
        if (scope.dead) return;
        pill.textContent = "Status unavailable"; pill.dataset.level = "unknown"; reason.hidden = true;
      }
    }

    /* ---------- Controls ---------- */
    document.getElementById(mode === "dest" ? "lbl-dest" : "lbl-num").checked = true;
    document.querySelectorAll('input[name="lbl"]').forEach(inp =>
      scope.on(inp, "change", () => { mode = inp.value; }));

    const keyInput = document.getElementById("key-input");
    const keyNote = document.getElementById("key-note");
    try { if (localStorage.getItem("tfl-app-key")) { keyInput.value = localStorage.getItem("tfl-app-key"); } } catch (e) {}
    scope.on(document.getElementById("key-form"), "submit", e => {
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
      const nx = S[t.r.st[t.next]];
      const nextTxt = eta <= 15 ? `At or arriving at ${nx.name}` : `Next: ${nx.name} in ${eta >= 60 ? Math.round(eta / 60) + " min" : eta + " s"}`;
      tip.innerHTML = "";
      const l1 = document.createElement("div");
      l1.innerHTML = `<strong>${dirText(t)}</strong> to `;
      l1.appendChild(document.createTextNode(`${destFull(t)} (${shownDest(t).code})`));
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
    scope.on(document, "scroll", hideTip, { passive: true });

    if (DEBUG_ON) window.__undercurrent = { DEBUG, trains, S, ROUTES, LANES: R0.LANES, poseAtL: R0.poseAtL, cum: R0.cum, segLen: R0.segLen, TRAIN_SCALE };

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
      cells.forEach(([text, c]) => {
        const s = document.createElement("span"); if (c) s.className = c;
        if (c === "dest") { const m = document.createElement("span"); m.className = "mq"; m.textContent = text; s.appendChild(m); }
        else s.textContent = text;
        r.appendChild(s);
      });
      return r;
    }
    // Text too long for its space on the board glides across and back, like a dot-matrix display.
    // Timed from one shared clock, so the once-a-second board refresh never makes it jump.
    const reduceMotionBoard = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const MQ_EPOCH = performance.now(), MQ_SPEED = 45, MQ_HOLD = 1.6;
    function marquee(root) {
      root.querySelectorAll(".mq").forEach(m => {
        const box = m.parentElement, over = m.scrollWidth - box.clientWidth;
        if (over <= 1) { m.style.animation = ""; return; }
        const move = over / MQ_SPEED, T = 2 * (move + MQ_HOLD);
        const hold = (MQ_HOLD / T) * 100, out = hold + (move / T) * 100;
        const name = "mq" + Math.round(over) + "x" + Math.round(T * 10);
        if (!document.getElementById(name)) {
          const st = document.createElement("style"); st.id = name;
          st.textContent = `@keyframes ${name}{0%,${hold.toFixed(2)}%{transform:translateX(0)}${out.toFixed(2)}%,${(out + hold).toFixed(2)}%{transform:translateX(-${Math.ceil(over)}px)}100%{transform:translateX(0)}}`;
          document.head.appendChild(st);
        }
        const delay = -(((performance.now() - MQ_EPOCH) / 1000) % T);
        m.style.animation = `${name} ${T.toFixed(2)}s linear ${delay.toFixed(2)}s infinite`;
      });
    }
    function screen(labelText, rows) {
      const wrapEl = document.createElement("div");
      if (labelText) { const l = document.createElement("p"); l.className = "plat-label"; l.textContent = labelText; wrapEl.appendChild(l); }
      const led = document.createElement("div"); led.className = "led";
      rows.forEach(r => led.appendChild(r));
      wrapEl.appendChild(led);
      popSections.appendChild(wrapEl);
      if (!reduceMotionBoard) marquee(led);
      return led;
    }
    function addClock(led) {
      const c = document.createElement("div"); c.className = "led-clock"; c.textContent = clockFmt.format(new Date());
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
      scope.stopEvery(popTimer);
      popTimer = scope.every(() => (popRender || showPrompt)(), 1000);
    }
    function closePop() {
      popRender = null; setSelected(null);
      showPrompt();
    }
    // clicking any empty part of the map resets the board
    scope.on(wrap, "click", e => {
      if (openIx && !(e.target.closest && e.target.closest(".ix"))) openIx.set(false);
      if (e.target.closest && e.target.closest(".station-link, .label.clickable, .train, .ix, .dest-alert")) return;
      closePop();
    });
    scope.on(document, "keydown", e => { if (e.key === "Escape") closePop(); });
    showPrompt();
    popTimer = scope.every(showPrompt, 1000);

    // "via" for a departures row: from TfL's own text, else only when every route between here and there agrees
    function boardVia(k, p) {
      if (!VIA_IDX.length) return "";
      const t = viaFromTowards(p.towards);
      if (t) return ` via ${t}`;
      if (p.dest === undefined) return "";
      const opts = new Set(ROUTES.filter(R => R.pos[k] !== undefined && R.pos[p.dest] !== undefined)
        .map(R => viaOnRoute(R, R.pos[k], R.pos[p.dest] > R.pos[k] ? "S" : "N", p.dest)));
      return opts.size === 1 && [...opts][0] ? ` via ${[...opts][0]}` : "";
    }
    // Station departures: next three each way
    function openBoard(k) {
      openPop(S[k].name, stationNodes[k], () => {
        const now = performance.now();
        const preds = (boardData.get(k) || []).map(p => ({ ...p, left: p.tts - (now - p.fetchedAt) / 1000 })).filter(p => p.left > -20);
        const isTerminus = isTermG(k);
        const atStart = ROUTES.some(R => R.pos[k] === 0);
        const dirs = isTerminus ? [atStart ? "S" : "N"] : ["N", "S"];
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
            [(p.dest !== undefined && p.dest !== k ? S[p.dest].name : p.destName || "Check front of train") + boardVia(k, p), "dest"],
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
            .format(new Date(Date.now() - (performance.now() - t.waitSince)));
          const led = screen("", [ledRow([["Arrived", "dest"], [arrived, "when"]], "stop"), ledRow([["Departure", "dest"], ["not yet known", "when"]], "stop")]);
          addClock(led);
          popNote.textContent = `Arrived as Vehicle ID ${t.v}. Times appear once it leaves.`;
          popNote.hidden = false;
        });
        return;
      }
      openPop(`${dirText(t)} to ${destFull(t)}`, t.node, () => {
        const now = performance.now(), s = sgn(t.dir);
        popSections.innerHTML = "";
        ledTitle(`${dirText(t)} to ${destFull(t)} · Vehicle ID ${t.v}`);
        const stops = (t.stops || []).filter(st => s * (t.r.cum[st.idx] - t.D) > -0.5);
        const rows = stops.length
          ? stops.slice(0, 9).map(st => ledRow([[S[t.r.st[st.idx]].name, "dest"], [whenText((st.at - now) / 1000), "when"]], "stop"))
          : [ledRow([[t.missed >= 2 ? "Out of service" : "No stops predicted", "dest"], ["", "when"]], "stop led-empty")];
        const led = screen("Calling at", rows);
        addClock(led);
        popNote.textContent = t.loc ? `Now: ${t.loc}` : "";
        popNote.hidden = !t.loc;
        if (t.missed >= 2 || !trains.has(t.v)) { popRender = null; setSelected(null); }
      });
    }

    /* ---------- Facts carousel ---------- */
    const FACTS = LINE.facts || [];
    const factText = document.getElementById("fact-text"), factTag = document.getElementById("fact-tag");
    const FACT_MS = 18000;
    let factIdx = Math.floor(Math.random() * FACTS.length), factStart = performance.now(), factPaused = false;
    function showFact(i, animate) {
      factIdx = (i + FACTS.length) % FACTS.length;
      const apply = () => {
        if (!FACTS.length) { factTag.textContent = ""; factText.textContent = ""; return; }
        factTag.textContent = FACTS[factIdx].tag;
        factText.textContent = FACTS[factIdx].text;
        factText.classList.remove("fading"); factTag.classList.remove("fading");
      };
      factStart = performance.now();
      if (animate && !reduceMotionPref) { factText.classList.add("fading"); factTag.classList.add("fading"); scope.after(apply, 400); }
      else apply();
    }
    scope.on(document.getElementById("fact-prev"), "click", () => showFact(factIdx - 1, true));
    scope.on(document.getElementById("fact-next"), "click", () => showFact(factIdx + 1, true));
    const factsEl = document.querySelector(".facts");
    scope.on(factsEl, "mouseenter", () => { factPaused = true; });
    scope.on(factsEl, "mouseleave", () => { factPaused = false; factStart = performance.now() - (parseFloat(factBar.style.width) || 0) / 100 * FACT_MS; });
    (function tickFacts(now) {
      if (factPaused) factStart += 16; // hold while hovered
      const k = Math.min(1, (performance.now() - factStart) / FACT_MS);
      factBar.style.width = (k * 100).toFixed(1) + "%";
      if (k >= 1) showFact(factIdx + 1, true);
      scope.frame(tickFacts);
    })();
    showFact(factIdx, false);

    /* ---------- Line switch hand-over (v2.8, same page since v3.01) ----------
       Out: tap a line's interchange marker, zoom right in on the station, fade everything else and pull the track
       back into the station, slide the side panels away, then hand over to the new line in this same page.
       In: the new line opens zoomed in on the same station at the same scale, grows its track out from behind the
       station, fades the rest in and eases out to the whole line. Reduced motion cross-fades instead. */
    const TX_SCALE = 0.3;                                    // map units per screen pixel when zoomed in on the station
    const txNow = () => (window.__sim && __sim.realNow ? __sim.realNow() : performance.now());
    const easeIO = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const clamp01 = v => Math.max(0, Math.min(1, v));
    const txFaders = si => [riverG, trainLayer, labelLayer, alertLayer, emptyMsg, ...stationNodes.filter((n, i) => i !== si),
      ...document.querySelectorAll(".line-title, .status, .status-reason, .updated, .stats, #pop-sections, #pop-note, #facts")];
    const setOpacity = (nodes, o) => nodes.forEach(n => { n.style.opacity = o === "" ? "" : o.toFixed(3); });
    function txTimeline(ms, fn) {
      return new Promise(done => {
        const t0 = txNow();
        const step = () => { const t = Math.min(ms, txNow() - t0); fn(t); if (t < ms) scope.frame(step); else done(); };
        scope.frame(step);
      });
    }
    // Where the station sits on screen: the middle of the map's visible part with the page scrolled to the top
    // (on phones the map can be taller than the screen). Passed to the new line so the station doesn't jump.
    function stationSpot() {
      const r = svg.getBoundingClientRect(), top = r.top + window.scrollY;
      return { px: r.width / 2, py: Math.max(20, Math.min(r.height, window.innerHeight - top)) / 2 };
    }
    // The view zoomed in on a station, at the same scale on every line so the station looks identical across the hand-over
    function stationView(si, spot) {
      const r = svg.getBoundingClientRect(), w = Math.max(r.width, 10) * TX_SCALE, h = Math.max(r.height, 10) * TX_SCALE;
      const v = { x: S[si].x - spot.px * TX_SCALE, y: S[si].y - spot.py * TX_SCALE, w, h };
      v.reach = Math.hypot(Math.max(spot.px, r.width - spot.px), Math.max(spot.py, r.height - spot.py)) * TX_SCALE + 20;  // track beyond this is off screen
      return v;
    }
    function fitTarget() { const f = fitSize(), b = view.base; return { x: b.x + b.w / 2 - f.w / 2, y: b.y + b.h / 2 - f.h / 2, w: f.w, h: f.h }; }
    function lerpView(a, b, e) {                             // zoom geometrically, pan in a straight line
      const w = a.w * Math.pow(b.w / a.w, e), h = a.h * Math.pow(b.h / a.h, e);
      const cx = a.x + a.w / 2 + (b.x + b.w / 2 - a.x - a.w / 2) * e, cy = a.y + a.h / 2 + (b.y + b.h / 2 - a.y - a.h / 2) * e;
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    }
    function setView(v) {
      Object.assign(view, v); view.user = true;
      svg.setAttribute("viewBox", `${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.w.toFixed(1)} ${v.h.toFixed(1)}`);
    }
    // A copy of the track that can be drawn only up to a set distance (along the track) from one station.
    // Each piece is drawn from both ends, so loops and rejoining branches retract and grow correctly.
    function trackReach(si) {
      const dist = S.map(() => Infinity), adj = S.map(() => []); dist[si] = 0;
      TRACK_SEGS.forEach(([a, b]) => { const l = Math.hypot(S[a].x - S[b].x, S[a].y - S[b].y); adj[a].push([b, l]); adj[b].push([a, l]); });
      const todo = new Set(S.keys());
      while (todo.size) {
        let u = -1; todo.forEach(i => { if (u < 0 || dist[i] < dist[u]) u = i; });
        todo.delete(u); if (dist[u] === Infinity) break;
        adj[u].forEach(([v, l]) => { if (dist[u] + l < dist[v]) dist[v] = dist[u] + l; });
      }
      const g = el("g", { "aria-hidden": "true" }); svg.insertBefore(g, trackPath.nextSibling);
      const parts = [];
      TRACK_SEGS.forEach(([a, b]) => [[a, b], [b, a]].forEach(([p, q]) => {
        if (dist[p] === Infinity) return;
        const len = Math.hypot(S[p].x - S[q].x, S[p].y - S[q].y);
        const path = el("path", { class: "track", d: `M ${S[p].x} ${S[p].y} L ${S[q].x} ${S[q].y}`, "stroke-dasharray": `${len.toFixed(1)} ${(len + 60).toFixed(1)}` }, g);
        parts.push({ path, d0: dist[p], len });
      }));
      trackPath.style.opacity = 0;
      return {
        set(R) {
          parts.forEach(p => {
            const v = Math.max(0, Math.min(p.len, R - p.d0));
            p.path.setAttribute("stroke-dashoffset", (p.len - v).toFixed(1));
            p.path.style.visibility = v < 0.5 ? "hidden" : "";
          });
        },
        done() { g.remove(); trackPath.style.opacity = ""; }
      };
    }
    function switchLine(id, si) {
      if (txBusy) return;
      if (reduceMotionPref) { plainSwitch(id); return; }
      const loading = loadLine(id);                          // load the next line while this one plays its outro
      loading.catch(() => {});
      const spot = stationSpot();
      txBusy = true;
      hideTip(); if (openIx) openIx.set(false);
      root.classList.add("tx-busy");                         // no taps, drags or hovers mid-animation
      if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "smooth" });
      const from = { x: view.x, y: view.y, w: view.w, h: view.h }, to = stationView(si, spot);
      const fade = txFaders(si), Rv = to.reach;
      let reach = null, slideAt = null;
      const edge = Math.min(spot.px, svg.getBoundingClientRect().width - spot.px) * TX_SCALE;   // the track must retract inside this before the side panels leave, or it shows cut off at the map's edge
      const slideOut = t => { slideAt = t; root.classList.add("tx-go", "tx-away"); };
      // 0-0.7s zoom in on the station; 0.4-0.85s fade the rest; 0.85-1.7s track retreats into the station;
      // the side panels slide off once the track has pulled clear of the map's edges
      txTimeline(1700, t => {
        setView(lerpView(from, to, easeIO(clamp01(t / 700))));
        setOpacity(fade, 1 - clamp01((t - 400) / 450));
        if (t >= 850) {
          if (!reach) reach = trackReach(si);
          const R = Rv * (1 - easeIO(clamp01((t - 850) / 850)));
          reach.set(R);
          if (slideAt === null && R <= edge * 0.85) slideOut(t);
        }
      }).then(() => {
        if (slideAt === null) slideOut(1700);
        // once the panels are fully off screen, hand over to the next line in this same page
        scope.after(() => handOver(id, loading, { naptan: S[si].naptan, px: spot.px, py: spot.py }), Math.max(0, slideAt + 450 - 1700));
      });
    }
    (function arrive() {
      if (!arrival) return;
      const si = byNaptan[arrival.naptan];
      if (si === undefined || reduceMotionPref || !view.base) { txEnd(); resetView(); return; }
      txBusy = true; root.classList.add("tx-busy"); root.classList.remove("tx-go");
      const fade = txFaders(si);
      setOpacity(fade, 0); root.classList.remove("tx-in");
      const r = svg.getBoundingClientRect(), own = stationSpot();
      const spot = isFinite(arrival.px) && isFinite(arrival.py) ? { px: Math.max(0, Math.min(r.width, arrival.px)), py: Math.max(0, Math.min(r.height, arrival.py)) } : own;
      const start = stationView(si, spot), Rv = start.reach;
      setView(start);
      const reach = trackReach(si); reach.set(0);
      let grown = false, slidIn = false;
      // 0-0.3s the page settles with the side panels still away; 0.3-1.1s the panels slide back in; 0.75-1.65s track grows out of the station
      // (it only reaches the map's edges once the panels are back); 1.65-2.15s the rest fades in; 2.05-2.75s ease out to the whole line
      txTimeline(2750, t => {
        if (!slidIn && t >= 300) { slidIn = true; root.classList.add("tx-back"); void document.body.offsetWidth; root.classList.remove("tx-away"); }
        if (t < 1650) reach.set(Rv * easeIO(clamp01((t - 750) / 900)));
        else if (!grown) { grown = true; reach.done(); }
        setOpacity(fade, clamp01((t - 1650) / 500));
        if (t >= 2050) setView(lerpView(start, fitTarget(), easeIO(clamp01((t - 2050) / 700))));
      }).then(() => { setOpacity(fade, ""); resetView(); txEnd(); });
    })();

    /* ---------- Start ---------- */
    scope.frame(frame);
    poll(); pollStatus();
    scope.every(poll, POLL_MS);
    scope.every(pollStatus, STATUS_MS);
    scope.every(updatePanel, 1000);
    scope.on(document, "visibilitychange", () => {
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

    return { zoomCentre, resetView };
  }

  /* ---------- Loading lines (v3.01) ----------
     Each line file is loaded once with a script tag (which, unlike fetch, also works when the page is opened as a
     file) and kept for the rest of the visit. Every line file sets the same global, so it is captured on load. */
  const knownLine = id => (window.UNDERCURRENT_LINES || []).some(l => l.id === id);
  const lineCache = new Map();                             // id -> Promise of the line's data
  const bust = "?b=" + Date.now();
  if (window.UNDERCURRENT_LINE) lineCache.set(window.UNDERCURRENT_LINE.id, Promise.resolve(window.UNDERCURRENT_LINE));
  function loadLine(id) {
    if (!lineCache.has(id)) {
      lineCache.set(id, new Promise((resolve, reject) => {
        const tag = document.createElement("script");
        let timer = null;
        const fail = why => { clearTimeout(timer); tag.remove(); lineCache.delete(id); reject(new Error(`Line ${id}: ${why}`)); };
        timer = setTimeout(() => fail("timed out"), 8000);
        tag.onload = () => {
          clearTimeout(timer); tag.remove();
          const L = window.UNDERCURRENT_LINE;
          if (L && L.id === id) resolve(L); else fail("unexpected data");
        };
        tag.onerror = () => fail("could not load");
        tag.src = `lines/${id}.js${bust}`;
        document.head.appendChild(tag);
      }));
    }
    return lineCache.get(id);
  }

  /* ---------- Mount and unmount ---------- */
  const FADE_SEL = ".line-title, .status, .status-reason, .updated, .stats, #pop-sections, #pop-note, #facts";
  const popSections = document.getElementById("pop-sections");
  function mount(LINE, arrival) {
    const gen = ++guard.mounts, scope = makeScope(gen);
    const prev = guard.gen; guard.gen = gen;                // timers started while building are stamped with this line
    try { cur = { id: LINE.id, LINE, scope, api: null }; cur.api = mountLine(LINE, scope, arrival); }
    finally { guard.gen = prev; }
    // self-check: every line runs the same number of repeating timers as the first one did
    const n = guard.intervals.size;
    if (guard.baseIntervals === null) guard.baseIntervals = n;
    else if (n !== guard.baseIntervals) guard.problems.push(`${n} repeating timers after mount ${gen} (the first line had ${guard.baseIntervals})`);
  }
  function unmount() {
    if (!cur) return true;
    const { scope } = cur;
    scope.dispose();
    guard.dead.add(scope.gen);
    svg.replaceChildren(); svg.classList.remove("zoomed");
    popSections.replaceChildren();
    document.getElementById("pop-note").hidden = true;
    document.getElementById("tip").hidden = true;
    ["fact-text", "fact-tag"].forEach(id => document.getElementById(id).classList.remove("fading"));
    factBar.style.width = "0%";
    document.querySelectorAll(FADE_SEL).forEach(n => { n.style.opacity = ""; });
    if (DEBUG_ON) window.__undercurrent = null;
    cur = null;
    // self-check: nothing of the old line may still be running or drawn
    const left = scope.count() + svg.childElementCount + popSections.childElementCount;
    if (left) guard.problems.push(`unmount left ${left} item(s) behind`);
    return !left;
  }

  /* ---------- Switching lines without reloading ---------- */
  function lineURL(id, arrival) {
    const q = new URLSearchParams(location.search); q.set("line", id); q.delete("from");
    if (arrival) q.set("from", `${arrival.naptan}~${Math.round(arrival.px)}~${Math.round(arrival.py)}`);
    return location.pathname + "?" + q + location.hash;
  }
  // Last resort: the old full page load (the new page then plays the arrival from ?from=)
  function navigateTo(id, arrival) { try { localStorage.setItem("line", id); } catch (e) {} location.assign(lineURL(id, arrival)); }
  function swapTo(LINE, arrival, push) {
    try {
      if (!unmount()) return false;
      try { localStorage.setItem("line", LINE.id); } catch (e) {}
      if (push) { try { history.pushState({ line: LINE.id }, "", lineURL(LINE.id)); } catch (e) {} }
      mount(LINE, arrival);
      return true;
    } catch (e) {
      console.error("Undercurrent: line switch failed", e);
      return false;
    }
  }
  // Called by the outgoing line once its outro has finished and the side panels are off screen
  function handOver(id, loading, arrival) {
    const prev = guard.gen; guard.gen = 0;                  // from here on this is the shell's work, not the old line's
    // if back or forward was pressed mid-animation, don't add a history entry: the arrival finishes, then follows the address
    try { loading.then(LINE => { if (!swapTo(LINE, arrival, !pendingURL)) navigateTo(id, arrival); }, () => navigateTo(id, arrival)); }
    finally { guard.gen = prev; }
  }
  function txEnd() {
    txBusy = false;
    root.classList.remove("tx-busy", "tx-back", "tx-away", "tx-in", "tx-go");
    if (pendingURL) { pendingURL = false; followURL(); }
  }
  // Switching from the picker, or with back/forward: no station to zoom into, so the map and panel text cross-fade
  function plainSwitch(id, push = true) {
    if (txBusy || !cur || !knownLine(id) || id === cur.id) return;
    txBusy = true; root.classList.add("tx-busy");
    const loading = loadLine(id);
    const els = () => [svg, ...document.querySelectorAll(FADE_SEL)];
    const fadeTo = (o, ms, ease) => els().forEach(n => { n.style.transition = ms ? `opacity ${ms}ms ${ease}` : "none"; n.style.opacity = o; });
    const OUT = reduceMotionPref ? 0 : 250, IN = reduceMotionPref ? 0 : 450;
    fadeTo("0", OUT, "ease-in");
    Promise.all([loading, new Promise(r => setTimeout(r, OUT))]).then(([LINE]) => {
      if (!swapTo(LINE, null, push)) { navigateTo(id); return; }
      cur.api.resetView();
      fadeTo("0", 0); void svg.getBoundingClientRect();
      fadeTo("1", IN, "ease-out");
      setTimeout(() => { els().forEach(n => { n.style.transition = ""; n.style.opacity = ""; }); txEnd(); }, IN + 30);
    }, () => navigateTo(id));
  }
  let pendingURL = false;
  function followURL() {
    const id = new URLSearchParams(location.search).get("line");
    if (knownLine(id) && cur && id !== cur.id) plainSwitch(id, false);
  }
  window.addEventListener("popstate", () => { if (txBusy) pendingURL = true; else followURL(); });

  /* ---------- Self-healing: if a check ever fails, reload this line cleanly rather than run on with a leak ---------- */
  setInterval(() => {
    if (txBusy || !(guard.strays || guard.problems.length)) return;
    const why = guard.problems[0] || `${guard.strays} timer callback(s) from a closed line`;
    if (DEBUG_ON) { if (!guard.reported) { guard.reported = true; console.warn("Undercurrent leak check:", why); } return; }
    console.warn("Undercurrent: reloading cleanly:", why);
    location.replace(lineURL(cur ? cur.id : new URLSearchParams(location.search).get("line") || ""));
  }, 5000);

  /* ---------- Debug readout (?debug) ---------- */
  if (DEBUG_ON) {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99;font:11px/1.4 monospace;background:rgba(0,0,0,.72);color:#fff;padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre";
    document.body.appendChild(box);
    setInterval(() => {
      const mem = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + " MB" : "n/a";
      box.textContent = `mount ${guard.mounts} · ${cur ? cur.id : "-"}\nline items ${cur ? cur.scope.count() : 0} · repeating timers ${guard.intervals.size}\n` +
        `strays ${guard.strays} · problems ${guard.problems.length}\npage elements ${document.getElementsByTagName("*").length} · heap ${mem}`;
    }, 1000);
    window.__uc = { guard, loadLine, plainSwitch, get cur() { return cur; } };
  }

  /* ---------- Start: mount the line the page was opened on ---------- */
  (function start() {
    const LINE = window.UNDERCURRENT_LINE;
    const q = new URLSearchParams(location.search), from = q.get("from");
    let arrival = null;
    if (from) {                                            // arrived by a full page load (the fallback path)
      q.delete("from");
      const [naptan, px, py] = from.split("~");
      arrival = { naptan, px: px ? +px : NaN, py: py ? +py : NaN };
    }
    try { history.replaceState({ line: LINE.id }, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash); } catch (e) {}
    mount(LINE, arrival);
  })();
})();
