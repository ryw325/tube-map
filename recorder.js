/* Project Undercurrent: in-site recorder (v3.23).
   Records, for each chosen line, where every train icon is (the engine's model position) every 3 seconds and every
   TfL Arrivals reply, into one .json.gz file. Each line runs in its own hidden copy of the page (an iframe with
   ?recframe), so the line on screen can be changed freely while a recording runs. Nothing leaves the browser. */
(function () {
  "use strict";
  if (/[?&]recframe\b/.test(location.search)) return;           // the hidden copies never record
  const SAMPLE_MS = 3000;
  const DURATIONS = [{ min: 0, label: "Until I stop" }, { min: 30, label: "30 min" }, { min: 60, label: "1 hour" }, { min: 120, label: "2 hours" }];
  const TRAIN_FIELDS = ["v", "route", "x", "y", "D", "dest", "next", "loc", "pdir", "dir", "towards", "eta", "opacity", "waiting", "queued", "moving", "jumping"];
  const FEED_FIELDS = ["vehicleId", "naptanId", "expectedArrival", "timeToStation", "destinationName", "direction", "platformName", "currentLocation", "timestamp"];
  const $ = id => document.getElementById(id);
  const btn = $("rec-btn"), note = $("rec-note"), btnLabel = btn && btn.querySelector(".rec-label");
  if (!btn || !$("sheet-rec")) return;
  const LINES = window.UNDERCURRENT_LINES || [];
  const nameOf = id => (LINES.find(l => l.id === id) || { name: id }).name;
  const versionOf = () => { const m = /v([\d.]+)/.exec((document.querySelector(".eyebrow") || {}).textContent || ""); return m ? m[1] : ""; };
  const pad = n => String(n).padStart(2, "0");
  const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600); return (h ? h + ":" + pad(Math.floor(s / 60) % 60) : Math.floor(s / 60)) + ":" + pad(s % 60); };
  const r1 = v => (typeof v === "number" && isFinite(v)) ? Math.round(v * 10) / 10 : null;
  const r2 = v => (typeof v === "number" && isFinite(v)) ? Math.round(v * 100) / 100 : null;
  const nil = v => v === undefined ? null : v;

  let rec = null;        // the running recording
  let last = null;       // { name, blob } of the last saved file, for "Download again"
  let wake = null;

  /* ---------- Set-up controls ---------- */
  const lineBox = $("rec-lines");
  function currentLine() { try { return new URLSearchParams(location.search).get("line") || localStorage.getItem("line"); } catch (e) { return null; } }
  function buildLineChoices() {
    const cur = currentLine();
    lineBox.replaceChildren(...LINES.map(l => {
      const lab = document.createElement("label"); lab.className = "rec-chip";
      const inp = document.createElement("input"); inp.type = "checkbox"; inp.value = l.id; inp.checked = l.id === cur;
      const sp = document.createElement("span"); sp.textContent = l.name;
      inp.addEventListener("change", syncStart);
      lab.append(inp, sp); return lab;
    }));
    syncStart();
  }
  const chosen = () => [...lineBox.querySelectorAll("input:checked")].map(i => i.value);
  function syncStart() { const n = chosen().length; $("rec-start").disabled = !n; $("rec-start-n").textContent = n === 1 ? "1 line" : n + " lines"; }
  buildLineChoices();
  btn.addEventListener("click", () => { if (!rec) buildLineChoices(); });   // tick the line on screen each time the pop-up opens

  /* ---------- Feed replies arrive from the hidden copies ---------- */
  function feed(line, status, data, date, err) {
    if (!rec || !rec.lines.includes(line)) return;
    const rows = Array.isArray(data) ? data.map(p => FEED_FIELDS.map(k => nil(p[k]))) : null;
    rec.feeds.push({ t: Date.now(), line, status, date: date || null, n: rows ? rows.length : 0, rows, err: err || null });
    rec.nFeeds[line] = (rec.nFeeds[line] || 0) + 1;
  }
  window.UndercurrentRecorder = { get active() { return !!rec; }, feed };

  /* ---------- Sampling ---------- */
  function sample() {
    if (!rec) return;
    const t = Date.now(), lines = {}, age = {};
    rec.lines.forEach(id => {
      let L = null;
      try { L = rec.frames[id].contentWindow.__ucLive; } catch (e) {}
      if (!L) { lines[id] = null; age[id] = null; return; }
      if (!rec.stations[id]) rec.stations[id] = L.S.map((s, i) => [i, s.id, s.naptan || null, s.name, s.of !== undefined ? s.of : null]);
      const now = L.now(), rows = [];
      L.trains.forEach(tr => {
        if (tr.fetchedAt === undefined || tr.D === null || tr.x === null || tr.x === undefined) return;
        const eta = typeof tr.tts === "number" ? tr.tts - (now - tr.fetchedAt) / 1000 : null;
        rows.push([tr.v, tr.r ? nil(tr.r.id) : null, r1(tr.x), r1(tr.y), r1(tr.D), nil(tr.dest),
          tr.r && tr.next != null ? nil(tr.r.st[tr.next]) : null, tr.loc || "", tr.pdir || "", tr.dir || "", tr.towards || "",
          r1(eta), r2(tr.opacity), nil(tr.waiting), !!tr.queued, !!tr.moving, tr.pendingD !== null && tr.pendingD !== undefined]);
      });
      lines[id] = rows; age[id] = Math.round(L.age());
      if (age[id] > 5000) rec.stale++;
    });
    const vis = document.visibilityState;
    if (vis !== "visible") rec.hidden++;
    rec.samples.push({ t, vis, age, lines });
    if (rec.end && t >= rec.end) { stop("timer"); return; }
    paint();
  }

  /* ---------- Start and stop ---------- */
  async function start() {
    const lines = chosen();
    if (!lines.length || rec) return;
    const min = +(document.querySelector('input[name="rec-len"]:checked') || { value: 0 }).value;
    const box = document.createElement("div"); box.className = "rec-frames"; box.setAttribute("aria-hidden", "true");
    document.body.appendChild(box);
    const frames = {};
    lines.forEach(id => {
      const f = document.createElement("iframe");
      f.title = "Recording " + nameOf(id); f.tabIndex = -1;
      f.src = "index.html?line=" + encodeURIComponent(id) + "&recframe=1";
      box.appendChild(f); frames[id] = f;
    });
    const t0 = Date.now();
    rec = { lines, min, start: t0, end: min ? t0 + min * 60000 : 0, box, frames, samples: [], feeds: [], stations: {}, nFeeds: {}, hidden: 0, stale: 0, timer: 0, painter: 0 };
    rec.timer = setInterval(sample, SAMPLE_MS);
    rec.painter = setInterval(paint, 1000);
    try { if (navigator.wakeLock) wake = await navigator.wakeLock.request("screen"); } catch (e) {}
    paint();
  }

  async function stop(reason) {
    if (!rec) return;
    const r = rec; rec = null;
    clearInterval(r.timer); clearInterval(r.painter);
    r.box.remove();
    try { if (wake) await wake.release(); } catch (e) {} wake = null;
    const t1 = Date.now();
    const out = {
      meta: { format: "undercurrent-site-recording", formatVersion: 1, siteVersion: versionOf(), started: new Date(r.start).toISOString(), ended: new Date(t1).toISOString(),
              stopped: reason, lines: r.lines, sampleMs: SAMPLE_MS, samples: r.samples.length, feeds: r.feeds.length, hiddenSamples: r.hidden, staleLineSamples: r.stale,
              userAgent: navigator.userAgent, screen: innerWidth + "x" + innerHeight,
              apiKey: (() => { try { return !!localStorage.getItem("tfl-app-key"); } catch (e) { return null; } })(),
              notes: "Positions are the engine's model position in map units (x, y) and route distance (D), not screen pixels. dest, next and waiting are station indexes into stations[line]. eta is seconds to the next stop as the engine sees it. A line's age is ms since its hidden copy last drew a frame (over 5000 means it was paused)." },
      fields: { train: TRAIN_FIELDS, station: ["i", "id", "naptan", "name", "of"], feed: FEED_FIELDS },
      stations: r.stations, samples: r.samples, feeds: r.feeds
    };
    const stamp = d => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "-" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + "utc";
    const base = "undercurrent-" + r.lines.join("-") + "-" + stamp(new Date(r.start));
    const json = JSON.stringify(out);
    let blob, name;
    try {
      if (typeof CompressionStream !== "function") throw 0;
      blob = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
      name = base + ".json.gz";
    } catch (e) { blob = new Blob([json], { type: "application/json" }); name = base + ".json"; }
    last = { name, blob, mins: (t1 - r.start) / 60000, lines: r.lines.length };
    download();
    paint();
  }

  function download() {
    if (!last) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(last.blob); a.download = last.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  /* ---------- What the panel and the pop-up show ---------- */
  function paint() {
    const on = !!rec;
    btn.classList.toggle("on", on);
    $("rec-setup").hidden = on; $("rec-live").hidden = !on;
    if (on) {
      const el = Date.now() - rec.start;
      btnLabel.textContent = clock(el);
      note.textContent = "Recording " + (rec.lines.length === 1 ? nameOf(rec.lines[0]) : rec.lines.length + " lines") + (rec.end ? " · " + clock(rec.end - Date.now()) + " left" : "");
      $("rec-elapsed").textContent = clock(el);
      $("rec-left").textContent = rec.end ? clock(rec.end - Date.now()) + " left" : "until you stop";
      $("rec-what").textContent = rec.lines.map(nameOf).join(", ");
      $("rec-nsamples").textContent = rec.samples.length.toLocaleString("en-GB");
      $("rec-nfeeds").textContent = rec.feeds.length.toLocaleString("en-GB");
      const warn = [];
      if (rec.hidden) warn.push("This tab was in the background for " + clock(rec.hidden * SAMPLE_MS) + ". Train positions may pause while it is hidden, so keep it in front.");
      const lastS = rec.samples[rec.samples.length - 1];
      if (lastS) { const slow = rec.lines.filter(id => lastS.age[id] === null || lastS.age[id] > 5000); if (slow.length) warn.push("Waiting for " + slow.map(nameOf).join(", ") + " to start drawing."); }
      const missing = rec.lines.filter(id => !rec.nFeeds[id] && Date.now() - rec.start > 45000);
      if (missing.length) warn.push("No TfL reply yet for " + missing.map(nameOf).join(", ") + ".");
      $("rec-warn").textContent = warn.join(" "); $("rec-warn").hidden = !warn.length;
    } else {
      btnLabel.textContent = "Record";
      note.textContent = last ? "Saved " + clock(last.mins * 60000) + " recording" : "Train positions and TfL feed";
      $("rec-last").hidden = !last;
      if (last) $("rec-last-name").textContent = last.name;
    }
  }

  $("rec-start").addEventListener("click", start);
  $("rec-stop").addEventListener("click", () => stop("button"));
  $("rec-again").addEventListener("click", download);
  document.addEventListener("visibilitychange", async () => {
    if (rec && document.visibilityState === "visible" && navigator.wakeLock && (!wake || wake.released)) { try { wake = await navigator.wakeLock.request("screen"); } catch (e) {} }
  });
  window.addEventListener("beforeunload", e => { if (rec) { e.preventDefault(); e.returnValue = ""; } });
  paint();
})();
