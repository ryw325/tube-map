/* Project Undercurrent: in-site recorder (v3.23; stations and carry-on-after-reload v3.28).
   Records, for each chosen line or station, where every train icon is every 3 seconds and every TfL Arrivals reply, into one
   .json.gz file. Each line or station runs in its own hidden copy of the page (an iframe with ?recframe), so what is on screen
   can be changed freely while a recording runs. Nothing leaves the browser.
   v3.28: the recording is saved into the browser's own storage (IndexedDB) as it goes, so if this tab reloads or changes page
   mid-recording it carries straight on. A recording left behind by a closed tab is saved as a file the next time the site opens.
   v4.07: the Full Map can be recorded too. It is read from the page itself (not a hidden copy), every second: the view, and for every train near it where
   the icon is drawn on the map and on screen, whether it is painted, and what the train brain says about it; plus every TfL reply the page gets. While any
   recording runs, a Mark button (or the M key) notes a moment that looks wrong, with an optional note, the train last tapped and a picture of the map. */
(function () {
  "use strict";
  if (/[?&]recframe\b/.test(location.search)) return;           // the hidden copies never record
  const SAMPLE_MS = 3000;
  const ALIVE_MS = 15000;              // a recording another tab touched this recently is still running there: leave it alone
  const RESUME_MS = 10 * 60000;        // a reload in the same tab carries on if the last save is this recent
  const TRAIN_FIELDS = ["v", "route", "x", "y", "D", "dest", "next", "loc", "pdir", "dir", "towards", "eta", "opacity", "waiting", "queued", "moving", "jumping"];
  const STATION_TRAIN_FIELDS = ["v", "line", "dir", "x", "y", "s", "q", "stops", "at", "eta", "dest", "loc", "opacity"];
  const FEED_FIELDS = ["vehicleId", "naptanId", "expectedArrival", "timeToStation", "destinationName", "direction", "platformName", "currentLocation", "timestamp"];
  // v4.07: Full Map replies keep the fields the train brain reads; each reply carries its own list of strings (rows hold indexes into it) to keep the file small
  const FM_FEED_FIELDS = ["lineId", "vehicleId", "naptanId", "stationName", "expectedArrival", "timeToStation", "destinationName", "destinationNaptanId", "direction", "platformName", "towards", "currentLocation", "timestamp"];
  const FM_SAMPLE_MS = 1000;
  const OWNER_KEY = "uc-rec-owner";
  const $ = id => document.getElementById(id);
  const btn = $("rec-btn"), note = $("rec-note"), btnLabel = btn && btn.querySelector(".rec-label");
  if (!btn || !$("sheet-rec")) return;
  const LINES = (window.UNDERCURRENT_LINES || []).map(l => ({ id: l.id, name: l.name, kind: "line" }));
  // v3.40: with every station having a page, the Station row offers only the station on screen (to record another one, open it first). Ids of stations in a
  // recording that is still running are recognised by their prefix.
  const here = new URLSearchParams(location.search).get("station");
  const STATIONS = here ? [{ id: "station-" + here, sid: here, name: (document.getElementById("line-name") || {}).textContent || here, kind: "station" }] : [];
  const FULLMAP = { id: "fullmap", name: "Full Map", kind: "fullmap" }, onFullMap = (window.UNDERCURRENT_LINE || {}).kind === "fullmap";
  const ALL = LINES.concat(STATIONS, onFullMap ? [FULLMAP] : []);
  const itemOf = id => ALL.find(x => x.id === id) || (id === "fullmap" ? FULLMAP : /^station-/.test(id) ? { id, sid: id.slice(8), name: id.slice(8), kind: "station" } : { id, name: id, kind: "line" });
  const nameOf = id => itemOf(id).name;
  const frameSrc = id => { const it = itemOf(id); return it.kind === "station" ? "index.html?station=" + encodeURIComponent(it.sid) + "&recframe=1" : "index.html?line=" + encodeURIComponent(id) + "&recframe=1"; };
  const countText = ids => {
    const nl = ids.filter(id => itemOf(id).kind === "line").length, nm = ids.filter(id => itemOf(id).kind === "fullmap").length, ns = ids.length - nl - nm;
    const parts = [nm ? "the Full Map" : "", nl ? (nl === 1 ? "1 line" : nl + " lines") : "", ns ? (ns === 1 ? "1 station" : ns + " stations") : ""].filter(Boolean);
    return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0] || "0 lines";
  };
  const versionOf = () => { const m = /v([\d.]+)/.exec((document.querySelector(".eyebrow") || {}).textContent || ""); return m ? m[1] : ""; };
  const pad = n => String(n).padStart(2, "0");
  const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600); return (h ? h + ":" + pad(Math.floor(s / 60) % 60) : Math.floor(s / 60)) + ":" + pad(s % 60); };
  const r1 = v => (typeof v === "number" && isFinite(v)) ? Math.round(v * 10) / 10 : null;
  const r2 = v => (typeof v === "number" && isFinite(v)) ? Math.round(v * 100) / 100 : null;
  const nil = v => v === undefined ? null : v;
  const ssGet = k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
  const ssSet = (k, v) => { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} };

  /* ---------- Browser storage: the running recording's details and its samples, saved as they come in ---------- */
  const DB = (() => {
    let opening = null;
    const open = () => opening || (opening = new Promise((res, rej) => {
      try {
        const r = indexedDB.open("undercurrent-recorder", 1);
        r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("run"); d.createObjectStore("chunks", { autoIncrement: true }); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error("blocked"));
      } catch (e) { rej(e); }
    }));
    const tx = (stores, mode, fn) => open().then(d => new Promise((res, rej) => {
      const t = d.transaction(stores, mode), req = fn(t);
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = t.onabort = () => rej(t.error || new Error("storage aborted"));
    }));
    return {
      getRun: () => tx(["run"], "readonly", t => t.objectStore("run").get("cur")),
      save: (meta, chunk) => tx(["run", "chunks"], "readwrite", t => { t.objectStore("run").put(meta, "cur"); if (chunk) t.objectStore("chunks").add(chunk); return null; }),
      readAll: () => tx(["chunks"], "readonly", t => t.objectStore("chunks").getAll()),
      clear: () => tx(["run", "chunks"], "readwrite", t => { t.objectStore("run").clear(); t.objectStore("chunks").clear(); return null; })
    };
  })();

  let rec = null;        // the running recording: { meta, frames, box, pendS, pendF, memS, memF, persist, lastAge, timer, painter }
  let last = null;       // { name, blob, mins, recovered } of the last saved file, for "Download again"
  let wake = null;

  /* ---------- Set-up controls ---------- */
  const lineBox = $("rec-lines"), stationBox = $("rec-stations"), mapBox = $("rec-map");
  if (mapBox) { mapBox.hidden = !onFullMap; $("rec-map-h").hidden = !onFullMap; }
  function onScreen() {
    try { const q = new URLSearchParams(location.search); if (onFullMap) return "fullmap"; if (q.get("station")) return "station-" + q.get("station"); return q.get("line") || localStorage.getItem("line"); }
    catch (e) { return null; }
  }
  function chips(box, items, cur) {
    if (!box) return;
    box.replaceChildren(...items.map(l => {
      const lab = document.createElement("label"); lab.className = "rec-chip";
      const inp = document.createElement("input"); inp.type = "checkbox"; inp.value = l.id; inp.checked = l.id === cur;
      const sp = document.createElement("span"); sp.textContent = l.name;
      inp.addEventListener("change", syncStart);
      lab.append(inp, sp); return lab;
    }));
  }
  function buildChoices() { const cur = onScreen(); chips(lineBox, LINES, cur); chips(stationBox, STATIONS, cur); chips(mapBox, onFullMap ? [FULLMAP] : [], cur); syncStart(); }
  const chosen = () => [lineBox, stationBox, mapBox].filter(Boolean).flatMap(b => [...b.querySelectorAll("input:checked")].map(i => i.value));
  function syncStart() { const ids = chosen(); $("rec-start").disabled = !ids.length; $("rec-start-n").textContent = countText(ids); }
  buildChoices();
  btn.addEventListener("click", () => { if (!rec) buildChoices(); });   // tick what is on screen each time the pop-up opens

  /* ---------- Feed replies arrive from the hidden copies ---------- */
  function feed(id, status, data, date, err, group) {
    if (!rec || !rec.meta.lines.includes(id)) return;
    let rows = null, strs;
    if (id === "fullmap" && Array.isArray(data)) {                        // strings once per reply, rows of indexes; times as milliseconds
      const idx = new Map(); strs = [];
      const str = v => { if (v === undefined || v === null) return null; let i = idx.get(v); if (i === undefined) { i = strs.length; strs.push(v); idx.set(v, i); } return i; };
      rows = data.map(p => FM_FEED_FIELDS.map(k => k === "timeToStation" ? nil(p[k]) : k === "expectedArrival" || k === "timestamp" ? (p[k] ? Date.parse(p[k]) : null) : str(p[k])));
    } else if (Array.isArray(data)) rows = data.map(p => FEED_FIELDS.map(k => nil(p[k])));
    const entry = { t: Date.now(), line: id, status, date: date || null, n: rows ? rows.length : 0, rows, err: err || null };
    if (strs) { entry.strs = strs; entry.lines = group || []; }
    (rec.persist ? rec.pendF : rec.memF).push(entry);
    rec.meta.nFeeds[id] = (rec.meta.nFeeds[id] || 0) + 1; rec.meta.feedsTotal++;
  }
  window.UndercurrentRecorder = { get active() { return !!rec; }, feed };

  /* ---------- Sampling ---------- */
  function sample() {
    if (!rec) return;
    const m = rec.meta, t = Date.now(), lines = {}, age = {};
    m.lines.forEach(id => {
      let L = null;
      try { L = itemOf(id).kind === "fullmap" ? (window.__ucLive && window.__ucLive.kind === "fullmap" ? window.__ucLive : null) : rec.frames[id].contentWindow.__ucLive; } catch (e) {}
      if (!L) { lines[id] = null; age[id] = null; return; }
      if (L.kind === "fullmap") {
        if (!m.fmFields) m.fmFields = L.fields.slice();
        lines[id] = L.sample();
      } else if (L.kind === "station") {
        if (!m.stations[id]) m.stations[id] = L.meta();
        lines[id] = L.sample();
      } else {
        if (!m.stations[id]) m.stations[id] = L.S.map((s, i) => [i, s.id, s.naptan || null, s.name, s.of !== undefined ? s.of : null]);
        const now = L.now(), rows = [];
        L.trains.forEach(tr => {
          if (tr.fetchedAt === undefined || tr.D === null || tr.x === null || tr.x === undefined) return;
          const eta = typeof tr.tts === "number" ? tr.tts - (now - tr.fetchedAt) / 1000 : null;
          rows.push([tr.v, tr.r ? nil(tr.r.id) : null, r1(tr.x), r1(tr.y), r1(tr.D), nil(tr.dest),
            tr.r && tr.next != null ? nil(tr.r.st[tr.next]) : null, tr.loc || "", tr.pdir || "", tr.dir || "", tr.towards || "",
            r1(eta), r2(tr.opacity), nil(tr.waiting), !!tr.queued, !!tr.moving, tr.pendingD !== null && tr.pendingD !== undefined]);
        });
        lines[id] = rows;
      }
      age[id] = Math.round(L.age());
      if (age[id] > 5000) m.stale++;
    });
    const vis = document.visibilityState;
    if (vis !== "visible") m.hidden++;
    (rec.persist ? rec.pendS : rec.memS).push({ t, vis, age, lines });
    m.nSamples++; m.lastT = t; rec.lastAge = age;
    flush();
    if (m.end && t >= m.end) { stop("timer"); return; }
    paint();
  }
  // write what has come in since the last save (one small chunk every 3 seconds)
  function flush() {
    if (!rec || !rec.persist) return Promise.resolve();
    const r = rec, chunk = { s: r.pendS, f: r.pendF, k: r.pendK };
    r.pendS = []; r.pendF = []; r.pendK = [];
    r.meta.lastT = Date.now();
    return r.flushing = DB.save(r.meta, chunk.s.length || chunk.f.length || chunk.k.length ? chunk : null).catch(() => {
      // storage stopped working: keep everything in memory from here on, as before v3.28
      r.memS.push(...chunk.s); r.memF.push(...chunk.f); r.memK.push(...chunk.k); r.persist = false;
    });
  }

  /* ---------- Start, carry on after a reload, and stop ---------- */
  function begin(meta, persist) {
    const box = document.createElement("div"); box.className = "rec-frames"; box.setAttribute("aria-hidden", "true");
    document.body.appendChild(box);
    const frames = {};
    meta.lines.forEach(id => {
      if (itemOf(id).kind === "fullmap") return;                           // the Full Map is read from this page, not a hidden copy
      const f = document.createElement("iframe");
      f.title = "Recording " + nameOf(id); f.tabIndex = -1; f.src = frameSrc(id);
      box.appendChild(f); frames[id] = f;
    });
    rec = { meta, box, frames, pendS: [], pendF: [], pendK: [], memS: [], memF: [], memK: [], persist, lastAge: null, timer: 0, painter: 0 };
    rec.timer = setInterval(sample, meta.sampleMs || SAMPLE_MS);
    showMark(true);
    rec.painter = setInterval(paint, 1000);
    ssSet(OWNER_KEY, meta.id);
    keepAwake();
    paint();
  }
  async function start() {
    const ids = chosen();
    if (!ids.length || rec) return;
    const min = +(document.querySelector('input[name="rec-len"]:checked') || { value: 0 }).value;
    const t0 = Date.now();
    const meta = { id: String(t0), lines: ids, kinds: Object.fromEntries(ids.map(id => [id, itemOf(id).kind])), min, start: t0, end: min ? t0 + min * 60000 : 0,
                   stations: {}, nSamples: 0, nFeeds: {}, feedsTotal: 0, hidden: 0, stale: 0, resumes: [], gaps: [], lastT: t0, siteVersion: versionOf(),
                   sampleMs: ids.includes("fullmap") ? FM_SAMPLE_MS : SAMPLE_MS, nMarks: 0 };
    let persist = true;
    try { await DB.clear(); await DB.save(meta, null); } catch (e) { persist = false; }
    begin(meta, persist);
  }
  async function stop(reason) {
    if (!rec) return;
    const r = rec; rec = null;
    clearInterval(r.timer); clearInterval(r.painter);
    r.box.remove(); showMark(false);
    ssSet(OWNER_KEY, null);
    try { if (wake) await wake.release(); } catch (e) {} wake = null;
    try { await r.flushing; } catch (e) {}                      // let the last save land before reading everything back
    let samples = [], feeds = [], marks = [];
    if (r.persist) { try { (await DB.readAll()).forEach(c => { samples.push(...c.s); feeds.push(...c.f); marks.push(...(c.k || [])); }); } catch (e) {} }
    samples.push(...r.memS, ...r.pendS); feeds.push(...r.memF, ...r.pendF); marks.push(...r.memK, ...r.pendK);
    await save(r.meta, samples, feeds, reason, false, marks);
  }
  async function save(m, samples, feeds, reason, recovered, marks) {
    const t1 = recovered ? (m.lastT || Date.now()) : Date.now();
    feeds.sort((a, b) => a.t - b.t);
    // marks: a note typed after a mark arrives as its own entry; fold it into the mark it belongs to
    const mk = [], byId = {};
    for (const k of (marks || []).sort((a, b) => a.t - b.t)) { if (k.noteFor) { if (byId[k.noteFor]) byId[k.noteFor].note = k.note; } else { byId[k.id] = k; mk.push(k); } }
    const out = {
      meta: { format: "undercurrent-site-recording", formatVersion: 2, siteVersion: m.siteVersion || versionOf(), started: new Date(m.start).toISOString(), ended: new Date(t1).toISOString(),
              stopped: reason, lines: m.lines, kinds: m.kinds || {}, sampleMs: m.sampleMs || SAMPLE_MS, marks: mk.length, samples: samples.length, feeds: feeds.length, hiddenSamples: m.hidden, staleLineSamples: m.stale,
              resumes: (m.resumes || []).map(t => new Date(t).toISOString()), gaps: (m.gaps || []).map(g => ({ from: new Date(g.from).toISOString(), to: new Date(g.to).toISOString() })),
              userAgent: navigator.userAgent, screen: innerWidth + "x" + innerHeight,
              apiKey: (() => { try { return !!localStorage.getItem("tfl-app-key"); } catch (e) { return null; } })(),
              notes: "Each sample's lines object is keyed by line or station id (kinds says which). Line rows follow fields.train: positions are the engine's model position in map units (x, y) and route distance (D), not screen pixels; dest, next and waiting are station indexes into stations[line]; eta is seconds to the next stop as the engine sees it. Station rows follow fields.stationTrain: x, y in map units with the station at 0,0; s is distance along the train's lane (negative before the station); q is stops out (fractional); stops and at are what the feed's location says (stops still to make, standing at a stop); eta is seconds to the station; stations[station id] holds the station's details. A line's age is ms since its hidden copy last drew a frame (over 5000 means it was paused). gaps are times the page was reloading and nothing was sampled; resumes are when the recording carried on after a reload." },
      fields: { train: TRAIN_FIELDS, stationTrain: STATION_TRAIN_FIELDS, station: ["i", "id", "naptan", "name", "of"], feed: FEED_FIELDS, fullmapTrain: m.fmFields || null, fullmapFeed: FM_FEED_FIELDS },
      fullmapNotes: m.lines.includes("fullmap") ? "Full Map samples are { view, trains } (null while the Full Map was not on screen). view: centre cx, cy (British National Grid metres), s (screen px per metre), w, h (CSS px), km across, style, theme, train labels, blur (trains hidden as too crowded). trains rows follow fields.fullmapTrain: mx, my where the icon is drawn on the map (metres, on its stripe lane), sx, sy on screen (CSS px), alpha, drawn (actually painted), hidden (by the display rules), dead (fading out), and the train brain's state, from, to (naptans), progress, snapAt and fadeFrom (TfL clock, ms), next stop and seconds to it. Full Map feeds: rows of fields.fullmapFeed, strings as indexes into that reply's strs, times in ms; lines lists the lines asked for. Marks: t, note, view, the train last tapped within a minute, and a picture of the map (JPEG data URL, null when the browser forbids it)." : undefined,
      marks: mk,
      stations: m.stations, samples, feeds
    };
    const stamp = d => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "-" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + "utc";
    const base = "undercurrent-" + m.lines.join("-") + "-" + stamp(new Date(m.start));
    const json = JSON.stringify(out);
    let blob, name;
    try {
      if (typeof CompressionStream !== "function") throw 0;
      blob = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
      name = base + ".json.gz";
    } catch (e) { blob = new Blob([json], { type: "application/json" }); name = base + ".json"; }
    last = { name, blob, mins: (t1 - m.start) / 60000, recovered };
    try { await DB.clear(); } catch (e) {}
    download();
    paint();
  }
  // On page load: carry on with this tab's recording, or save one a closed tab left behind
  async function recover() {
    let m = null;
    try { m = await DB.getRun(); } catch (e) { return; }
    if (!m || rec) return;
    const now = Date.now(), lastT = m.lastT || m.start, mine = ssGet(OWNER_KEY) === m.id;
    if (!mine && now - lastT < ALIVE_MS) return;                       // still recording in another tab
    if (mine && now - lastT < RESUME_MS && !(m.end && now >= m.end)) {
      m.resumes = (m.resumes || []).concat(now); m.gaps = (m.gaps || []).concat({ from: lastT, to: now });
      begin(m, true);
      flush();
      return;
    }
    let samples = [], feeds = [], marks = [];
    try { (await DB.readAll()).forEach(c => { samples.push(...c.s); feeds.push(...c.f); marks.push(...(c.k || [])); }); } catch (e) {}
    ssSet(OWNER_KEY, null);
    await save(m, samples, feeds, m.end && now >= m.end ? "timer" : "recovered", true, marks);
  }

  function download() {
    if (!last) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(last.blob); a.download = last.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  async function keepAwake() { try { if (navigator.wakeLock && (!wake || wake.released)) wake = await navigator.wakeLock.request("screen"); } catch (e) {} }

  /* ---------- Marks (v4.07): "something looks wrong here" ---------- */
  // A floating Mark button (and the M key) while recording. The mark is saved at once; a note can be typed for 20 s afterwards and is saved as its own entry.
  let markBtn = null, markBox = null, markTimer = 0, markId = null;
  function showMark(on) {
    if (on && !markBtn) {
      markBox = document.createElement("div"); markBox.className = "rec-mark";
      markBtn = document.createElement("button"); markBtn.type = "button"; markBtn.className = "rec-mark-btn"; markBtn.innerHTML = '<span class="rec-dot" aria-hidden="true"></span>Mark <kbd>M</kbd>';
      markBtn.setAttribute("aria-label", "Mark this moment in the recording");
      const form = document.createElement("form"); form.className = "rec-mark-note"; form.hidden = true;
      form.innerHTML = '<input type="text" maxlength="300" placeholder="What looks wrong? (optional)" aria-label="Note for this mark"><button type="submit">Save</button>';
      markBtn.addEventListener("click", e => { e.stopPropagation(); mark(); });
      form.addEventListener("submit", e => { e.preventDefault(); noteDone(form.querySelector("input").value); });
      form.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") noteDone(""); });
      markBox.append(markBtn, form); document.body.appendChild(markBox);
    } else if (!on && markBox) { markBox.remove(); markBox = markBtn = null; clearTimeout(markTimer); }
  }
  function mark() {
    if (!rec) return;
    const t = Date.now(), L = window.__ucLive && window.__ucLive.kind === "fullmap" ? window.__ucLive : null, id = "m" + t;
    const k = { id, t, iso: new Date(t).toISOString(), page: location.search || "/", note: "", view: L ? L.view() : null, tapped: L ? L.lastTap() : null, picture: L ? L.capture(1000) : null };
    (rec.persist ? rec.pendK : rec.memK).push(k); rec.meta.nMarks = (rec.meta.nMarks || 0) + 1; markId = id;
    if (markBox) {
      const form = markBox.querySelector("form"), inp = form.querySelector("input");
      markBtn.classList.add("done"); markBtn.lastChild.previousSibling.textContent = "Marked "; setTimeout(() => { if (markBtn) { markBtn.classList.remove("done"); markBtn.lastChild.previousSibling.textContent = "Mark "; } }, 1500);
      form.hidden = false; inp.value = ""; inp.focus({ preventScroll: true });
      clearTimeout(markTimer); markTimer = setTimeout(() => noteDone(inp.value), 20000);
    }
    flush(); paint();
  }
  function noteDone(text) {
    clearTimeout(markTimer);
    if (rec && markId && text && text.trim()) { (rec.persist ? rec.pendK : rec.memK).push({ noteFor: markId, t: Date.now(), note: text.trim() }); flush(); }
    markId = null;
    if (markBox) { const form = markBox.querySelector("form"); form.hidden = true; if (document.activeElement && form.contains(document.activeElement)) document.activeElement.blur(); }
  }
  document.addEventListener("keydown", e => {
    if (!rec || e.metaKey || e.ctrlKey || e.altKey || (e.key !== "m" && e.key !== "M")) return;
    const tg = e.target; if (tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))) return;
    e.preventDefault(); mark();
  });

  /* ---------- What the panel and the pop-up show ---------- */
  function paint() {
    const on = !!rec;
    btn.classList.toggle("on", on);
    $("rec-setup").hidden = on; $("rec-live").hidden = !on;
    if (on) {
      const m = rec.meta, el = Date.now() - m.start;
      btnLabel.textContent = clock(el);
      note.textContent = "Recording " + (m.lines.length === 1 ? nameOf(m.lines[0]) : countText(m.lines)) + (m.end ? " · " + clock(m.end - Date.now()) + " left" : "");
      $("rec-elapsed").textContent = clock(el);
      $("rec-left").textContent = m.end ? clock(m.end - Date.now()) + " left" : "until you stop";
      $("rec-what").textContent = m.lines.map(nameOf).join(", ");
      $("rec-nsamples").textContent = m.nSamples.toLocaleString("en-GB");
      $("rec-nfeeds").textContent = m.feedsTotal.toLocaleString("en-GB");
      if ($("rec-nmarks")) $("rec-nmarks").textContent = (m.nMarks || 0).toLocaleString("en-GB");
      const warn = [];
      if (m.hidden) warn.push("This tab was in the background for " + clock(m.hidden * SAMPLE_MS) + ". Train positions may pause while it is hidden, so keep it in front.");
      if (rec.lastAge) {
        if (m.lines.includes("fullmap") && rec.lastAge.fullmap === null) warn.push("The Full Map isn't on screen, so it isn't being recorded. Open it again to carry on.");
        const slow = m.lines.filter(id => id !== "fullmap" && (rec.lastAge[id] === null || rec.lastAge[id] > 5000)); if (slow.length) warn.push("Waiting for " + slow.map(nameOf).join(", ") + " to start drawing.");
      }
      const missing = m.lines.filter(id => !m.nFeeds[id] && Date.now() - m.start > 45000);
      if (missing.length) warn.push("No TfL reply yet for " + missing.map(nameOf).join(", ") + ".");
      if (!rec.persist) warn.push("This browser can't save the recording as it goes, so reloading or leaving this page will lose it.");
      $("rec-warn").textContent = warn.join(" "); $("rec-warn").hidden = !warn.length;
    } else {
      btnLabel.textContent = "Record";
      note.textContent = last ? (last.recovered ? "Recovered " : "Saved ") + clock(last.mins * 60000) + " recording" : "Train positions and TfL feed";
      $("rec-last").hidden = !last;
      if (last) $("rec-last-name").textContent = last.name;
    }
  }

  $("rec-start").addEventListener("click", start);
  $("rec-stop").addEventListener("click", () => stop("button"));
  $("rec-again").addEventListener("click", download);
  if ($("rec-mark")) $("rec-mark").addEventListener("click", mark);
  document.addEventListener("visibilitychange", () => {
    if (!rec) return;
    if (document.visibilityState === "visible") keepAwake(); else flush();
  });
  window.addEventListener("pagehide", () => { if (rec) flush(); });
  // only warn before leaving when the recording can't carry on after a reload
  window.addEventListener("beforeunload", e => { if (rec && !rec.persist) { e.preventDefault(); e.returnValue = ""; } });
  paint();
  recover();
})();
