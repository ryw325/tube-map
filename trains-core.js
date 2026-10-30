/* Project Undercurrent: trains-core.js (v4.01), the one "train brain".
   Turns raw TfL /Line/<ids>/Arrivals replies into where every train is, as TIMES. No DOM, no drawing, no window or page code: the same
   file runs in a page, in Node or in a Cloudflare Worker. It works on stop order by naptan from the route table (lines/routes.js, made by
   tools/make_routes.js), never on page geometry.

   Use:
     const core = UndercurrentTrainsCore.create(UNDERCURRENT_ROUTES, { lines: ["victoria"] });
     core.ingest(reply, dateHeader, receivedAt, ["victoria"]);   // reply = the parsed JSON array, dateHeader = the reply's Date header,
                                                                // receivedAt = this machine's clock (ms) when it arrived, then the line ids asked for
     const snap = core.snapshot();                              // plain, JSON-safe data
   Times are TfL's clock in ms: this machine's clock plus snap.clockOffset (worked out from the Date header, so a wrong device clock does
   not matter). Each train in snap.trains:
     { id, line, vid, dir ("S" towards the end of the route, "N" towards its start), route (index into the line's routes),
       dest, destName, destShown, destChangedAt, from, to (naptans), fromK, toK (positions on the route), departAt, arriveAt,
       state ("moving" | "dwell" | "waiting" | "terminus" | "fading"), progress (0 to 1 from "from" to "to", by time),
       stops: [{ naptan, k, at, dep }], snapAt, fadeFrom, fadeTo, towards, loc, platform }
   stops starts with the stop the train has just left or is standing at. A page moves the train on these times alone, with no other rules:
   standing at stop i from its at to its dep, running from stop i to stop i + 1 between dep and the next at, progress linear in time.
   So a page never works out a speed, and a snapshot never goes stale before the next one. A new snapshot always continues the train from
   where the last one put it at that moment (it never jumps or runs backwards); when a train is too far out of place it is re-placed and
   snapAt says when (the page fades it across). A train that is going away has state "fading" and fadeFrom / fadeTo.
   States: moving between stops; dwell at a stop on its way; waiting at a stop before it starts a trip (first seen there, or turned round with
   its next trip known); terminus at the end of what the feed says, with nothing known after it; fading on its way out.

   The rules (agreed 25 Oct 2026; RULES below):
   - Time basis: each stop's expectedArrival (absolute), on TfL's clock. Stops more than 20 s in the past are dropped (the last is kept).
   - Grouping: by line and vehicle ID (blank or all zeros skipped); a vehicle with fewer than half its stops on the line's routes is another
     line's train mixed into the feed (Hammersmith & City) and is left out. The same stop listed twice within 6 s is one stop.
   - Route and direction: the route that best explains the vehicle's whole list of stops (one-way track, "via", repeated stations on the
     Circle); direction from the destination, then the order of the next stops, then the platform words. A turn-round list (the same station
     twice) is cut at the repeat, except on lines whose routes pass a station twice or loop.
   - Dwell: min(20 s, 25% of the gap to the next stop), counted from when the train actually arrives; a late train stops for less (never under
     5 s); an early train stops for longer rather than crawl (a run is never stretched beyond 3 times its scheduled time).
   - Catch-up: a late train runs faster, by up to 1x more for every 10 s late, at most 4 times its scheduled pace.
   - Never backwards: a later time stretches the current run instead. More than 1.2 stops out of place (either way): re-placed (snapAt).
   - First run (unknown departure): the learned running time between the two stops (seeded from the line file, else 120 s).
   - Destination: a change is taken once two replies in a row agree (destChangedAt marks it for the page's 30 s tag).
   - Turn-rounds: a train shown running into the end of its trip while the feed already lists its next trip from there hurries in at the
     catch-up limit, stands at least 15 s (5 s if the next trip is already due), then leaves on the new trip.
   - Missing: a train missing from every reply for 60 s (and at least 2 replies) fades over 3 s, unless it is running in to the end of its
     trip: then it stands there (terminus) for up to 10 min at the end of a route or 8 min mid-line. A train standing mid-line with nothing
     known goes out of service 30 s before the next train the same way is due at that platform (v4.02; fadeFrom can be a future time). A new vehicle ID leaving a station where
     a train has stood with no data for 8 min takes that train over. Two platforms at a route end: a third train in means the oldest goes.
   - Horizon: a vehicle whose first stop is more than 30 minutes off is not tracked yet.
   - Order (v4.03): trains on one track keep their order (a train cannot reach a stop until the one in front has left it, plus 30 s); two replies
     in a row saying otherwise re-place the train in front. One train, one line: a vehicle TfL lists under several lines of one reply is kept once. */
(function (root) {
  "use strict";
  const RULES = {
    STALE_S: 20, HORIZON_S: 1800, SAME_STOP_S: 6, FOREIGN: 0.5,
    DWELL_MAX_S: 20, DWELL_FRAC: 0.25, DWELL_MIN_S: 5, TURN_MIN_S: 15,
    CATCH: 4, LATE_RAMP_S: 10, STRETCH: 3, OUT_STOPS: 1.2, RUN_S: 120, MIN_GAP_S: 10,
    MISS_S: 60, MISS_REPLIES: 2, FADE_S: 3, DEST_REPLIES: 2, DEST_ALERT_S: 30,
    MID_HOLD_S: 480, END_HOLD_S: 600, RENUMBER_S: 480, PLATFORM_CLEAR_S: 30, HEADWAY_S: 30, ORDER_REPLIES: 2
  };
  const sgn = d => d === "S" ? 1 : -1;
  const opp = d => d === "S" ? "N" : "S";
  const fin = x => Number.isFinite(x) ? Math.round(x) : null;
  const viaNorm = txt => (txt || "").replace(/\bCX\b/g, "Charing Cross").trim();
  const viaFromTowards = towards => { const m = /\bvia\s+(.+)$/i.exec(towards || ""); return m ? viaNorm(m[1]) : ""; };
  const platformWord = name => { const m = /^(\w+bound)\b/i.exec(name || ""); return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : ""; };

  /* ---------- One line: stations, routes and the rules that only need stop order ---------- */
  const normName = n => (n || "").toLowerCase().replace(/&/g, " and ").replace(/\(.*?\)/g, "").replace(/-?underground( station)?|\bstation\b/g, "").replace(/[^a-z0-9]/g, "");
  function makeLine(T, rules, NET) {
    const S = T.st.map(([naptan, name, of, alias]) => ({ naptan, name, of, alias: alias || [] }));
    const byNaptan = {};
    S.forEach((s, i) => { if (s.of < 0) byNaptan[s.naptan] = i; });
    S.forEach((s, i) => { if (s.of < 0) s.alias.forEach(n => { if (byNaptan[n] === undefined) byNaptan[n] = i; }); });
    const ALT = {};                                                   // a station a route passes twice: its later visits (Circle)
    S.forEach((s, i) => { if (s.of >= 0) (ALT[s.of] = ALT[s.of] || []).push(i); });
    const HAS_ALT = Object.keys(ALT).length > 0;
    const ROUTES = T.routes.map((st, id) => { const pos = {}; st.forEach((g, k) => { pos[g] = k; }); return { id, st, pos, LAST: st.length - 1 }; });
    const candOn = (R, g) => [g, ...(ALT[g] || [])].filter(x => R.pos[x] !== undefined).sort((a, b) => R.pos[a] - R.pos[b]);
    // the visits a prediction can be: where one visit has the prediction's own naptan (the Circle's two Paddingtons are two TfL stops), only that one
    const candFor = (R, p) => { const cs = candOn(R, p.g), ex = p.nap ? cs.filter(c => S[c].naptan === p.nap) : []; return ex.length ? ex : cs; };
    const runKey = (a, b) => a < b ? a + "-" + b : b + "-" + a;
    const RUNT = new Map(Object.entries(T.run || {}));
    const LOOP_TO = T.loopTo || {};
    const ONEWAY_BAD = new Set((T.oneway || []).map(([a, b]) => b + ">" + a));
    const VIA = T.via || [];
    const W = { S: T.words.S || [], N: T.words.N || [] };
    const CUT_REPEATS = !HAS_ALT && !Object.keys(LOOP_TO).length;
    const isTermG = g => ROUTES.every(R => R.pos[g] === undefined || R.pos[g] === 0 || R.pos[g] === R.LAST) && ROUTES.some(R => R.pos[g] !== undefined);
    const wordDir = plat => { plat = (plat || "").toLowerCase(); if (W.S.some(w => plat.startsWith(w))) return "S"; if (W.N.some(w => plat.startsWith(w))) return "N"; return null; };

    // Direction of a prediction along route R: "S" = towards the route's last station, "N" = towards its first
    function directionOn(R, g, destG, plat, fb, exact) {                          // exact: the destination is already the right visit (remapRaw)
      const k = R.pos[g];
      let d = destG === undefined ? undefined : R.pos[destG];
      if (HAS_ALT && !exact && destG !== undefined && ALT[destG]) d = Math.max(...candOn(R, destG).map(c => R.pos[c]));
      if (k !== undefined && d !== undefined && d !== k) return d > k ? "S" : "N";
      if (d !== undefined && d === R.LAST) return "S";
      if (d !== undefined && d === 0) return "N";
      if (fb) return fb;
      return wordDir(plat);
    }
    // Routes that pass a station twice: give each prediction the visit it belongs to, by matching the vehicle's whole list of stops
    function remapRaw(R, raw, t) {
      if (!raw.some(p => candOn(R, p.g).length > 1 || (p.dest !== undefined && candOn(R, p.dest).length > 1))) return raw;
      const hint = directionOn(R, raw[0].g, raw[0].dest, raw[0].plat);
      let best = null;
      for (const s of [1, -1]) {
        for (const c0 of candFor(R, raw[0])) {
          let prev = R.pos[c0], hits = 1; const m = [c0];
          for (let i = 1; i < raw.length; i++) {
            const cs = candFor(R, raw[i]); let pick = null;
            for (const c of (s > 0 ? cs : cs.slice().reverse())) if (s * (R.pos[c] - prev) > 0) { pick = c; break; }
            if (pick === null) { m.push(null); continue; }
            m.push(pick); prev = R.pos[pick]; hits++;
          }
          let tie;
          if (t && t.R === R && t.x0 != null) { const ahead = s * (R.pos[c0] - t.x0); tie = (s === sgn(t.dir) ? 2e6 : 0) + (ahead >= -0.5 ? -ahead : -1e6); }
          else tie = (hint ? ((hint === "S") === (s > 0) ? 1e3 : 0) : 0) - s * R.pos[c0] * 0.001;
          const key = hits * 1e9 + tie;
          if (!best || key > best.key) best = { key, s, m };
        }
      }
      return raw.map((p, i) => {
        let dest = p.dest;
        if (dest !== undefined) { const cs = candOn(R, dest); if (cs.length > 1) dest = best.s > 0 ? cs[cs.length - 1] : cs[0]; }
        return { ...p, g: best.m[i] !== null ? best.m[i] : p.g, dest };
      });
    }
    // Which way a vehicle is heading along route R from the order of its next stops (up to four stations, stopping at the first repeat)
    function orderDir(R, raw) {
      const seen = new Set(), ks = [];
      for (const p of raw) { if (seen.has(p.g)) break; seen.add(p.g); if (R.pos[p.g] !== undefined) ks.push(R.pos[p.g]); if (ks.length >= 4) break; }
      let sum = 0; for (let i = 1; i < ks.length; i++) sum += Math.sign(ks[i] - ks[i - 1]);
      return sum > 0 ? "S" : sum < 0 ? "N" : null;
    }
    // A direction word on any of the vehicle's predictions (a train terminating mid-line may only name it on a later one)
    function platDirAny(raw) { for (const p of (raw.all || raw)) { const d = wordDir(p.plat); if (d) return d; } return null; }
    function cutAtRepeat(raw) {
      const seen = new Set(), out = [];
      for (const p of raw) { if (seen.has(p.g)) break; seen.add(p.g); out.push(p); }
      out.all = raw;
      return out;
    }
    // Pick the route that best explains a vehicle's predictions
    function chooseRoute(raw0, t) {
      let best = null;
      ROUTES.forEach(R => {
        const raw = HAS_ALT ? remapRaw(R, raw0, t) : raw0;
        const first = raw[0];
        if (R.pos[first.g] === undefined) return;
        const fb = orderDir(R, raw);
        const dir = directionOn(R, first.g, first.dest, first.plat, fb, HAS_ALT) || platDirAny(raw);
        if (!dir) return;
        const s = sgn(dir), k0 = R.pos[first.g];
        let score = 0;
        raw.forEach(p => { const k = R.pos[p.g]; if (k === undefined) { score -= 1; return; } if (s * (k - k0) >= 0) score += 1; });
        if (first.dest !== undefined && R.pos[first.dest] === undefined) score -= 5;     // destination is on another branch
        if (first.shown !== undefined && R.pos[first.shown] === undefined) score -= 5;   // named loop station (Terminal 4) not on this route
        if (ONEWAY_BAD.size) {                                                          // would run one-way track the wrong way
          const kTo = Math.max(...raw.map(p => R.pos[p.g] === undefined ? -Infinity : s * R.pos[p.g])) * s;
          for (let i = k0 - s; s * (kTo - i) > 0; i += s) {
            if (i < 0 || i + s < 0 || i > R.LAST || i + s > R.LAST) continue;
            if (ONEWAY_BAD.has(R.st[i] + ">" + R.st[i + s])) { score -= 20; break; }
          }
        }
        const via = VIA.length ? viaFromTowards(first.towards) : "";
        if (via) { const vi = VIA.find(i => S[i].name.toLowerCase() === via.toLowerCase()); if (vi !== undefined && R.pos[vi] === undefined) score -= 5; }
        if (t && t.R === R) score += 0.5;                                               // stay on the current route if it fits
        if (!best || score > best.score) best = { R, dir, score, raw, fb };
      });
      if (!best) return null;
      const R = best.R;
      const preds = best.raw.filter(p => R.pos[p.g] !== undefined).map(p => ({
        k: R.pos[p.g], dir: directionOn(R, p.g, p.dest, p.plat, best.fb, HAS_ALT) || best.dir, at: p.at, loc: p.loc, dest: p.dest, shown: p.shown, pdir: p.pdir, towards: p.towards
      }));
      return preds.length ? { R, preds } : null;
    }
    // Running time (with the stop) between neighbouring stations, learned from the feed
    function learnRunTimes(R, preds) {
      for (let i = 1; i < preds.length; i++) {
        const a = preds[i - 1], b = preds[i];
        if (a.dir !== b.dir || Math.abs(a.k - b.k) !== 1) continue;
        const dt = (b.at - a.at) / 1000;
        if (dt < 40 || dt > 400) continue;
        const key = runKey(R.st[a.k], R.st[b.k]);
        RUNT.set(key, (RUNT.get(key) || rules.RUN_S) * 0.9 + dt * 0.1);
      }
    }
    // Scheduled running time (ms, with the stop) from route position a to b
    function runMs(R, a, b) {
      const s = Math.sign(b - a); let sum = 0;
      for (let k = a; k !== b; k += s) sum += RUNT.get(runKey(R.st[k], R.st[k + s])) || rules.RUN_S;
      return sum * 1000;
    }
    // Stations a location text names ("At X", "Approaching X", "Between X and Y", ...): route positions, or "off" when it names somewhere not on this line
    const BYNAME = {}; S.forEach((s, i) => { const k = normName(s.name); if (k) (BYNAME[k] = BYNAME[k] || []).push(i); });
    function locStations(loc) {
      let m, names = [];
      loc = (loc || "").trim();
      if ((m = /^between (.+?) and (.+)$/i.exec(loc))) names = [m[1], m[2]];
      else if ((m = /^(?:at|approaching|left|departed|departing|leaving)\s+(.+?)(?:\s+platform\b.*)?$/i.exec(loc))) names = [m[1]];
      else return null;
      // a name that is a station of this line counts; one that is only a station of another built line means "off"; anything else is unknown
      const gs = names.map(n => { const k = normName(n); if (!k || /^platform/.test(k)) return null; return BYNAME[k] || (NET.has(k) ? [] : null); });
      if (gs.every(x => x === null)) return null;
      const on = gs.filter(x => x && x.length).flat();
      return on.length ? on : gs.some(x => x === null) ? null : "off";
    }
    const byName = n => { const k = normName(n); return k && BYNAME[k] ? BYNAME[k].find(i => S[i].of < 0) : undefined; };
    return { T, id: T.api, S, byNaptan, locStations, byName, ROUTES, ALT, candOn, CUT_REPEATS, isTermG, chooseRoute, cutAtRepeat, learnRunTimes, runMs, LOOP_TO,
      replies: 0 };
  }

  /* ---------- The core ---------- */
  function create(TABLE, opts) {
    opts = opts || {};
    const rules = Object.assign({}, RULES, opts.rules || {});
    const LINES = {}, NET = new Set();                                      // NET: every station name on any built line
    Object.values(TABLE.lines).forEach(T => T.st.forEach(s => NET.add(normName(s[1]))));
    Object.keys(TABLE.lines).forEach(api => { if (!opts.lines || opts.lines.includes(api)) LINES[api] = makeLine(TABLE.lines[api], rules, NET); });
    const trains = new Map();                      // "line|vehicle" -> train
    let offset = 0, offsetN = 0, lastAt = 0;
    const S_MS = 1000;

    const dwellFor = gap => Math.min(rules.DWELL_MAX_S * S_MS, rules.DWELL_FRAC * gap);
    // When a run that should take `nominal` ms from `start` arrives, given the feed wants it at `target`
    function arriveBy(start, nominal, target) {
      if (target === undefined) return start + nominal;
      const late = start + nominal - target;
      if (late > 0) { const m = Math.min(rules.CATCH, 1 + late / (rules.LATE_RAMP_S * S_MS)); return Math.max(target, start + nominal / m); }
      return Math.min(target, start + nominal * rules.STRETCH);
    }

    // Where a timeline puts a train at time T. A timeline is [{ k, arr, dep }] in travel order (arr -Infinity: standing there from the start;
    // dep Infinity: nothing known after it). k may turn back on itself (a turn-round).
    function evalTl(tl, T) {
      for (let i = 0; i < tl.length; i++) {
        const st = tl[i];
        if (i > 0 && T < st.arr) {
          const a = tl[i - 1], span = st.arr - a.dep;
          const p = span > 0 ? Math.max(0, Math.min(1, (T - a.dep) / span)) : 1;
          return { i, moving: true, kFrom: a.k, kTo: st.k, p, x: a.k + p * (st.k - a.k) };
        }
        if (T < st.dep) return { i, moving: false, k: st.k, arr: st.arr, x: st.k };
      }
      const L = tl[tl.length - 1];
      return { i: tl.length - 1, moving: false, k: L.k, arr: L.arr, x: L.k };
    }
    const legDir = (a, b) => b > a ? "S" : "N";

    // A trip's stops from the feed: the train's stops in its direction from the first, best (earliest) time per stop, in order, never
    // closer than MIN_GAP_S apart
    function tripStops(preds) {
      const next = preds[0], s = sgn(next.dir), best = new Map();
      preds.forEach(p => { if (p.dir !== next.dir || s * (p.k - next.k) < 0) return; if (!best.has(p.k) || best.get(p.k).at > p.at) best.set(p.k, p); });
      const out = [...best.values()].sort((a, b) => s * (a.k - b.k)).map(p => ({ k: p.k, at: p.at }));
      for (let i = 1; i < out.length; i++) out[i].at = Math.max(out[i].at, out[i - 1].at + rules.MIN_GAP_S * S_MS);
      return out;
    }

    // Build a timeline from a starting point and the trip's stops (the rules for dwell, catch-up and never backwards live here).
    // start: { moving, kFrom, kTo, p } or { k, arr, origin, turn }; dir: the trip's direction
    function build(Lm, R, start, stops, now, dir, hurryTo) {
      const s = sgn(dir), atOf = new Map(stops.map(x => [x.k, x.at]));
      const tl = [];
      let cur;
      if (start.moving) {
        const { kFrom, kTo, p } = start;
        const nominal = runMs(Lm, R, kFrom, kTo, atOf);
        let target = atOf.get(kTo);
        const ld = sgn(legDir(kFrom, kTo));
        // a stop the feed does not list, before its first listed stop: due when the timetable from there says (in the past if it has passed it)
        if (target === undefined && stops.length && ld === s && s * (stops[0].k - kTo) > 0) target = stops[0].at - travelOf(runMs(Lm, R, kTo, stops[0].k));
        if (hurryTo) target = -Infinity;
        // ...but one the feed listed last time and has now dropped, or that the location text says it is at, has been reached: due now
        if (start.reached && atOf.get(kTo) === undefined && start.reached(kTo)) target = now;
        const rem = (1 - p) * travelOf(nominal);
        const arr = arriveBy(now, rem, target);
        const dep = p < 1 ? now - p * (arr - now) / (1 - p) : now;
        tl.push({ k: kFrom, arr: -Infinity, dep });
        cur = { k: kTo, arr };
      } else cur = { k: start.k, arr: start.arr, origin: !!start.origin || start.arr === -Infinity, turn: !!start.turn || start.k === 0 || start.k === R.LAST };
      // hurrying in to a turn-round: the old trip's remaining stops to the turn, at the catch-up limit with the shortest stops
      if (hurryTo) {
        for (const k of hurryTo.via) {
          const dep = Math.max(cur.arr + rules.DWELL_MIN_S * S_MS, now);
          tl.push({ k: cur.k, arr: cur.arr, dep });
          cur = { k, arr: dep + travelOf(runMs(Lm, R, cur.k, k)) / rules.CATCH };
        }
        cur.turn = true;
      }
      for (const nx of stops) {
        if (s * (nx.k - cur.k) <= 0) continue;
        const fa = atOf.get(cur.k), fb = nx.at;
        const gap = fa !== undefined && fb - fa > 20 * S_MS ? fb - fa : runMs(Lm, R, cur.k, nx.k);
        const travel = travelOf(gap), feedDep = fb - travel;
        let dep;
        if (cur.origin) dep = feedDep;                                                    // waiting to start: leave when the times say
        else if (cur.turn) dep = Math.max(cur.arr + (feedDep < cur.arr + rules.TURN_MIN_S * S_MS ? rules.DWELL_MIN_S : rules.TURN_MIN_S) * S_MS, feedDep);
        else {
          const normal = cur.arr + dwellFor(gap);
          dep = feedDep < normal ? Math.max(cur.arr + rules.DWELL_MIN_S * S_MS, feedDep)      // late: a shorter stop
                                 : Math.max(normal, fb - travel * rules.STRETCH);           // early: a longer stop rather than a crawl
        }
        if (!(cur.arr > now)) dep = Math.max(dep, now);                                  // standing there now: it can only leave from now on
        dep = Math.max(dep, cur.arr);
        const arr = arriveBy(dep, travel, fb);
        tl.push({ k: cur.k, arr: cur.arr, dep, wait: cur.origin || cur.turn || undefined });     // wait: standing to start a trip (turned round, or first seen there)
        cur = { k: nx.k, arr };
      }
      tl.push({ k: cur.k, arr: cur.arr, dep: Infinity });
      return tl;
    }
    function travelOf(gap) { return gap - dwellFor(gap); }
    function runMs(Lm, R, a, b) { return a === b ? 0 : Lm.runMs(R, a, b); }

    // Where the feed alone puts the train: back from its first stop's time along the route at the timetable's pace (TfL sometimes lists a
    // trip only from a few stops out); a train that would still be at the start of the route stands there until it is due to leave
    // When the first stop is more than a stop away the times cannot say where the train is: if its location text names a station behind
    // that stop it goes back no further than there; if it names somewhere off this line, it waits just before the first stop (off the map)
    function fromFeed(Lm, R, dir, stops, now, loc, prevK) {
      const s = sgn(dir), first = stops[0];
      if (first.k - s < 0 || first.k - s > R.LAST) return build(Lm, R, { k: first.k, arr: Math.min(first.at, now) }, stops.slice(1), now, dir);
      let floor = null;                                                               // furthest back it may go (route position)
      // v4.04: a train the feed listed last time as reaching a stop is at that stop or beyond it (TfL's cached replies can leave it out again)
      if (prevK != null && s * (first.k - prevK) >= 0) floor = prevK === first.k ? null : prevK;
      const ls = Lm.locStations(loc);
      const nearer = (a, b) => a === null ? b : b === null ? a : s * (b - a) > 0 ? b : a;   // the stricter of two limits (nearer the first stop)
      if (ls === "off") floor = nearer(floor, first.k - s);
      else if (ls) { const ks = ls.map(g => R.pos[g]).filter(k => k !== undefined && s * (first.k - k) > 0); if (ks.length) floor = nearer(floor, ks.reduce((a, b) => s * (b - a) < 0 ? b : a)); }
      let k = first.k, left = first.at - now;
      for (;;) {
        const k0 = k - s, travel = travelOf(runMs(Lm, R, k0, k));
        if (left <= travel) return build(Lm, R, { moving: true, kFrom: k0, kTo: k, p: Math.max(0, Math.min(1, 1 - left / Math.max(1, travel))) }, stops, now, dir);
        if (k0 === floor || k0 - s < 0 || k0 - s > R.LAST || k === first.k && left - travel < dwellFor(runMs(Lm, R, k0, k))) return build(Lm, R, { k: k0, arr: -Infinity, origin: true }, stops, now, dir);
        left -= runMs(Lm, R, k0, k); k = k0;
      }
    }

    // Move a position from one route onto another (a branch becomes known); null if the other route does not have that track
    function mapOnto(Lm, from, R, e) {
      const pick = (g, near) => { const cs = Lm.candOn(R, g); if (!cs.length) return null; return cs.map(c => R.pos[c]).reduce((a, b) => near != null && Math.abs(b - near) < Math.abs(a - near) ? b : a); };
      if (!e.moving) { const k = pick(from.st[e.k]); return k === null ? null : { k, arr: e.arr }; }
      const a = pick(from.st[e.kFrom]), b = a === null ? null : pick(from.st[e.kTo], a);
      if (a === null || b === null || a === b) return null;
      return { moving: true, kFrom: a, kTo: b, p: e.p };
    }

    function trainDir(t, T) {
      const tl = t.tl, e = evalTl(tl, T);
      if (e.moving) return legDir(e.kFrom, e.kTo);
      const nx = tl[e.i + 1], pv = tl[e.i - 1];
      if (nx && nx.k !== e.k) return legDir(e.k, nx.k);
      if (pv && pv.k !== e.k) return legDir(pv.k, e.k);
      return t.dir;
    }

    function ingestLine(Lm, preds, now, skipV) {
      Lm.replies++;
      const prevAhead = orderNow(Lm, now);                                        // the order trains are in before this reply (v4.03)
      const groups = new Map();
      for (const p of preds) {
        const v = String(p.vehicleId || "").trim();
        if (!v || /^0+$/.test(v) || (skipV && skipV.has(v))) continue;              // (listed under another line too: that line has it)
        let at = Date.parse(p.expectedArrival);
        if (!Number.isFinite(at) && Number.isFinite(+p.timeToStation)) {                  // no absolute time (test feeds): the reply's timestamp, else now
          const ts = Date.parse(p.timestamp); at = (Number.isFinite(ts) ? ts : now) + p.timeToStation * S_MS;
        }
        if (!Number.isFinite(at)) continue;
        const g = Lm.byNaptan[p.naptanId];
        const list = groups.get(v) || groups.set(v, []).get(v);
        if (g === undefined) { list.push(null); continue; }
        let dg = Lm.byNaptan[p.destinationNaptanId], shown;
        if (dg === undefined && p.destinationName) dg = Lm.byName(p.destinationName);            // no destination ID: its name, if it is a station on the line
        if (dg !== undefined && Lm.LOOP_TO[dg] !== undefined) { shown = dg; dg = Lm.LOOP_TO[dg]; }
        list.push({ g, nap: p.naptanId, at, loc: p.currentLocation || "", dest: dg, shown, plat: p.platformName || "", pdir: platformWord(p.platformName), towards: p.towards || "",
          destName: (p.destinationName || "").replace(/ (Underground|Rail|DLR) Station$/, "").replace(/ \(London\)$/, "") });
      }
      const seen = new Set();
      groups.forEach((list, v) => {
        let raw = list.filter(Boolean);
        if (!raw.length || raw.length < rules.FOREIGN * list.length) return;             // another line's train mixed into this feed
        raw.sort((a, b) => a.at - b.at);
        raw = raw.filter((p, i, a) => !(i && p.g === a[i - 1].g && Math.abs(p.at - a[i - 1].at) <= rules.SAME_STOP_S * S_MS));
        const live = raw.filter(p => p.at >= now - rules.STALE_S * S_MS); raw = live.length ? live : [raw[raw.length - 1]];
        if (Lm.CUT_REPEATS) raw = Lm.cutAtRepeat(raw);
        const key = Lm.id + "|" + v;
        let t = trains.get(key);
        if (!t && raw[0].at - now > rules.HORIZON_S * S_MS) return;
        if (t) { const e = evalTl(t.tl, now); t.x0 = e.x; }
        const pick = Lm.chooseRoute(raw, t);
        if (!pick) return;
        const { R, preds: pp } = pick;
        Lm.learnRunTimes(R, pp);
        const next = pp[0], dir = next.dir, s = sgn(dir);
        const stops = tripStops(pp);
        const feedDest = next.dest !== undefined ? next.dest : R.st[dir === "S" ? R.LAST : 0];
        const origin = stops[0].k - s;                                              // the stop it leaves from on this trip
        // A new vehicle ID leaving a station where a train has stood with no data for a long time takes that train over
        if (!t && origin >= 0 && origin <= R.LAST) {
          const og = R.st[origin];
          const w = [...trains.values()].filter(o => o.line === Lm.id && !o.fadeFrom && !seen.has(o.key) && o.R.st[evalTl(o.tl, now).k] === og &&
            evalTl(o.tl, now).i === o.tl.length - 1 && !evalTl(o.tl, now).moving && now - o.tl[o.tl.length - 1].arr >= rules.RENUMBER_S * S_MS)
            .sort((a, b) => a.tl[a.tl.length - 1].arr - b.tl[b.tl.length - 1].arr)[0];
          if (w) { trains.delete(w.key); w.renumberedFrom = w.vid; w.key = key; w.vid = v; trains.set(key, w); t = w; t.x0 = evalTl(t.tl, now).x; }
        }
        seen.add(key);
        const isNew = !t;
        let flipped = false;
        if (isNew) {
          t = { key, line: Lm.id, vid: v, R, dir, tl: fromFeed(Lm, R, dir, stops, now, next.loc), born: now, snapAt: null, dest: feedDest, destCand: null, destCandN: 0,
            destChangedAt: null, fadeFrom: null, fadeTo: null };
          trains.set(key, t);
        } else {
          let e = evalTl(t.tl, now);
          const wasDir = trainDir(t, now);
          const prevK = t.listed && t.listed.R === R && t.dir === dir && t.listed.ks.size ? (s > 0 ? Math.min(...t.listed.ks) : Math.max(...t.listed.ks)) : null;
          if (t.fadeFrom) { t.fadeFrom = t.fadeTo = null; }                               // back in the feed before it had gone
          let start = { moving: e.moving, kFrom: e.kFrom, kTo: e.kTo, p: e.p, k: e.k, arr: e.arr }, onR = true;
          if (t.R !== R) { const m = mapOnto(Lm, t.R, R, e); if (m) start = m; else onR = false; }
          const aDir = start.moving ? legDir(start.kFrom, start.kTo) : wasDir;
          // standing where it has already turned round (its last run came the other way): it stands until its departure, never creeps
          if (onR && !start.moving && e.i > 0 && t.R === R && legDir(t.tl[e.i - 1].k, e.k) !== dir) start.turn = true;
          if (onR && !start.moving && t.R === R && t.tl[e.i].wait) start.turn = true;                  // (still) waiting to start a trip
          if (!onR) t.tl = replace(t, fromFeed(Lm, R, dir, stops, now, next.loc, prevK), now);
          else if (aDir !== dir) {
            flipped = true;
            // turned round: where the new trip starts must be where the train stands, or a stop or two ahead of it on its old trip
            // (a trip that lists the turning station itself as its first stop starts there too)
            const ogs = [origin >= 0 && origin <= R.LAST ? R.st[origin] : null, R.st[stops[0].k]].filter(g => g !== null);
            let tl = null;
            // (TfL sometimes lists a waiting train's next trip from a few stops out, with no location: it turns where its old trip ends)
            const tailK = t.tl[t.tl.length - 1].k, endsAt = k => k === tailK && t.R === R && s * (stops[0].k - k) > 0;
            if (!start.moving && (ogs.includes(R.st[start.k]) || endsAt(start.k))) tl = build(Lm, R, { k: start.k, arr: start.arr, turn: true }, stops, now, dir);
            else {
              const rest = t.tl.slice(e.i + (e.moving ? 0 : 1)), old = rest.map(x => t.R.st[x.k]);
              let j = old.findIndex(g => ogs.includes(g));
              if (j < 0 && rest.length && rest.length <= 2 && endsAt(rest[rest.length - 1].k)) j = rest.length - 1;
              if (t.R === R && j >= 0 && j < 2) {
                const via = t.tl.slice(e.i + (e.moving ? 0 : 1), e.i + (e.moving ? 0 : 1) + j + 1).map(x => x.k);
                const head = start.moving ? { moving: true, kFrom: start.kFrom, kTo: start.kTo, p: start.p } : { k: start.k, arr: start.arr };
                if (start.moving) via.shift();
                tl = build(Lm, R, head, stops, now, dir, { via });
              }
            }
            t.tl = tl || replace(t, fromFeed(Lm, R, dir, stops, now, next.loc, prevK), now);
          } else {
            const target = evalTl(fromFeed(Lm, R, dir, stops, now, next.loc, prevK), now);
            const diff = s * (target.x - (start.moving ? start.kFrom + start.p * (start.kTo - start.kFrom) : start.k));
            if (Math.abs(diff) > rules.OUT_STOPS) t.tl = replace(t, fromFeed(Lm, R, dir, stops, now, next.loc, prevK), now);
            else {
              const ls = Lm.locStations(next.loc), atLoc = ls && ls !== "off" && /^(at|approaching)\s/i.test(next.loc) ? new Set(ls.map(g => R.pos[g])) : null;
              start.reached = k => (t.listed && t.listed.R === R && t.listed.ks.has(k)) || (atLoc && atLoc.has(k));
              t.tl = build(Lm, R, start, stops, now, dir);
            }
          }
          t.R = R;
        }
        t.dir = dir;
        t.listed = { R, ks: new Set(stops.map(x => x.k)) };                              // this reply's stops, to tell next time which have been reached
        t.feed = { R, dir, stops, loc: next.loc };                                        // what the feed says now (to re-place it if it overtakes)
        Object.assign(t, { lastSeen: now, missed: 0, loc: next.loc, platform: next.pdir, towards: next.towards || "", destName: raw[0].destName });
        // Destination: a change is taken once two replies in a row agree (straight away after a turn-round or for a new train)
        if (isNew || flipped || t.dest === undefined) { t.dest = feedDest; t.destCand = null; t.destCandN = 0; }
        else if (feedDest !== t.dest) {
          if (t.destCand === feedDest) t.destCandN++; else { t.destCand = feedDest; t.destCandN = 1; }
          if (t.destCandN >= rules.DEST_REPLIES) { t.dest = feedDest; t.destCand = null; t.destCandN = 0; t.destChangedAt = now; }
        } else { t.destCand = null; t.destCandN = 0; }
        t.destShown = t.dest === feedDest ? next.shown : t.destShown;
      });
      // Missing from this reply
      trains.forEach(t => {
        if (t.line !== Lm.id || seen.has(t.key) || t.fadeFrom) return;
        t.missed = (t.missed || 0) + 1;
        if (t.missed < rules.MISS_REPLIES || now - t.lastSeen < rules.MISS_S * S_MS) return;
        if (endHold(Lm, t, now)) return;
        fade(t, now);
      });
      keepOrder(Lm, now, prevAhead);
      platformRules(Lm, now);
    }

    /* ---------- v4.03: trains on one track keep their order ----------
       TfL predicts every train on its own, so two trains close together on one track can swap order between replies (or even within one). Real
       trains cannot pass on one track, so: a train cannot arrive at a stop until the train in front has left it, plus HEADWAY_S, and its times are
       pushed back to fit. Only when ORDER_REPLIES replies in a row put it in front is that taken as real: it is re-placed where the feed puts it
       (snapAt, so pages fade it across rather than draw it passing). The order between two trains is set at the first stop both will reach next, in
       the same direction (where branches join, that is the junction, so whichever gets there first goes first). A train running past stops (a fast
       train, as on the Metropolitan's four tracks) is on another track and is never held. */
    const orderStrikes = new Map();                                                   // "vidA|vidB" (sorted) -> replies in a row the feed has had them swapped
    function futureVisits(t, now) {                                                   // the stops still ahead
      const tl = t.tl, e = evalTl(tl, now), out = [];
      for (let i = Math.max(1, e.moving ? e.i : e.i + 1); i < tl.length; i++) {
        const x = tl[i], pk = tl[i - 1].k;
        if (!(x.arr > now)) continue;
        out.push({ i, g: t.R.st[x.k], arr: x.arr, dep: x.dep, dir: legDir(pk, x.k), fast: Math.abs(x.k - pk) > 1 });
      }
      return out;
    }
    function commonVisits(a, b, now) {                                                // the stops both reach next, same way, in order
      const vb = futureVisits(b, now), byG = new Map(), out = []; vb.forEach(v => { if (!byG.has(v.g)) byG.set(v.g, v); });
      for (const va of futureVisits(a, now)) { const w = byG.get(va.g); if (w && w.dir === va.dir) out.push([va, w]); }
      return out;
    }
    const firstCommon = (a, b, now) => commonVisits(a, b, now)[0] || null;
    // the stops a train leaves from (the one it is leaving or standing at, then those ahead) with the way it leaves them
    function departures(t, now) {
      const tl = t.tl, e = evalTl(tl, now), out = [];
      for (let i = Math.max(0, e.moving ? e.i - 1 : e.i); i < tl.length - 1; i++) {
        const x = tl[i], nx = tl[i + 1];
        if (!Number.isFinite(x.dep) || nx.k === x.k) continue;
        out.push({ i, g: t.R.st[x.k], dep: x.dep, dir: legDir(x.k, nx.k), fast: Math.abs(nx.k - x.k) > 1 });
      }
      return out;
    }
    function commonDeps(a, b, now) {
      const db = departures(b, now), byG = new Map(), out = []; db.forEach(v => { if (!byG.has(v.g)) byG.set(v.g, v); });
      for (const da of departures(a, now)) { const w = byG.get(da.g); if (w && w.dir === da.dir) out.push([da, w]); }
      return out;
    }
    // hold a train at entry i until newDep (it has not left yet), and everything after it moves with it
    function delayDep(t, i, newDep) {
      const tl = t.tl, d = newDep - tl[i].dep; if (!(d > 0)) return;
      tl[i].dep = newDep;
      for (let j = i + 1; j < tl.length; j++) { tl[j].arr += d; if (Number.isFinite(tl[j].dep)) tl[j].dep += d; }
    }
    const pairsOf = (Lm, now) => { const L = [...trains.values()].filter(t => t.line === Lm.id && !(t.fadeFrom && t.fadeFrom <= now)), out = [];
      for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) out.push(L[i].vid < L[j].vid ? [L[i], L[j]] : [L[j], L[i]]);
      return out; };
    // who is in front of whom right now: per pair, the one that reaches their first common stop first (pairs more than 10 minutes apart are left out)
    function orderNow(Lm, now) {
      const m = new Map();
      for (const [a, b] of pairsOf(Lm, now)) {
        const c = firstCommon(a, b, now); if (!c || Math.abs(c[0].arr - c[1].arr) > 600000) continue;
        m.set(a.vid + "|" + b.vid, c[0].arr <= c[1].arr ? a.vid : b.vid);
      }
      return m;
    }
    // push a train's arrival at timeline entry i back to newArr (and everything after it), keeping where it is now (never backwards)
    function delayTo(t, i, newArr, now) {
      const tl = t.tl, d = newArr - tl[i].arr; if (!(d > 0)) return;
      const e = evalTl(tl, now);
      if (e.moving && e.i === i) { const p = e.p; tl[i - 1].dep = p < 1 ? now - p * (newArr - now) / (1 - p) : now; }   // on its way there: it runs slower from here
      else if (tl[i - 1].dep > now) tl[i - 1].dep += d;                                                                 // not left yet: it waits longer
      tl[i].arr = newArr;
      if (Number.isFinite(tl[i].dep)) tl[i].dep += d;
      for (let j = i + 1; j < tl.length; j++) { tl[j].arr += d; if (Number.isFinite(tl[j].dep)) tl[j].dep += d; }
    }
    function keepOrder(Lm, now, prevAhead) {
      const H = rules.HEADWAY_S * S_MS, seen = new Set();
      for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (const [a, b] of pairsOf(Lm, now)) {
          const key = a.vid + "|" + b.vid, c = firstCommon(a, b, now);
          if (!c || Math.abs(c[0].arr - c[1].arr) > 600000) continue;
          const [va, vb] = c, feedAhead = va.arr <= vb.arr ? a : b, prev = prevAhead.get(key);
          let lead = feedAhead;
          if (pass === 0 && prev && prev !== feedAhead.vid) {                                   // the feed has them the other way round to before
            const n = (orderStrikes.get(key) || 0) + 1; orderStrikes.set(key, n);
            if (n >= rules.ORDER_REPLIES && feedAhead.feed) {                                  // twice in a row: real. Both are re-placed where the feed puts them
              orderStrikes.delete(key);                                                        // (the one held back may be drawn further on than its own times say)
              for (const t of [a, b]) if (t.feed) t.tl = replace(t, fromFeed(Lm, t.feed.R, t.feed.dir, t.feed.stops, now, t.feed.loc), now);
              changed = true; continue;
            }
            lead = feedAhead === a ? b : a;                                                     // once: noise, keep the order
          } else if (pass === 0) orderStrikes.delete(key);
          seen.add(key);
          const fol = lead === a ? b : a;
          // at every stop they both reach (the times after a delay move with it, so they are read again each time)
          for (const [xa, xb] of commonVisits(a, b, now)) {
            const vl = lead === a ? xa : xb, vf = lead === a ? xb : xa;
            if (vl.fast || vf.fast) break;                                                     // a fast train: on another track from here
            const ld = lead.tl[vl.i].dep, fa = fol.tl[vf.i].arr;
            if (!Number.isFinite(ld)) break;                                                    // the one in front ends there
            if (fa < ld + H) { delayTo(fol, vf.i, ld + H, now); changed = true; }
          }
          // ...and it cannot leave a stop until the one in front has left it, plus HEADWAY_S (TfL can list two trains leaving together, as out of a depot)
          for (const [da, db] of commonDeps(a, b, now)) {
            const dl = lead === a ? da : db, df = lead === a ? db : da;
            if (dl.fast || df.fast) break;
            const ld = lead.tl[dl.i].dep, fd = fol.tl[df.i].dep;
            if (!(fd < ld + H)) continue;
            if (fd > now) { delayDep(fol, df.i, ld + H); changed = true; }
            else if (fol.born === now && fol.feed && fol.R === fol.feed.R) {                   // first seen too close behind: it waits at that stop instead
              const stops = fol.feed.stops.filter(x => sgn(fol.feed.dir) * (x.k - fol.tl[df.i].k) > 0);
              if (stops.length) { fol.tl = build(Lm, fol.R, { k: fol.tl[df.i].k, arr: -Infinity, origin: true }, stops, now, fol.feed.dir); delayDep(fol, 0, ld + H); changed = true; }
            }
            break;
          }
        }
        if (!changed) break;
      }
      orderStrikes.forEach((n, k) => { if (!seen.has(k) && !prevAhead.has(k)) orderStrikes.delete(k); });
    }
    // A train missing from the feed that is running in to the end of its trip carries on and stands there for a while
    function endHold(Lm, t, now) {
      const e = evalTl(t.tl, now), L = t.tl[t.tl.length - 1];
      if (e.i < t.tl.length - 2) return false;                                         // still more than a stop from the end: gone
      if (!(L.arr <= now)) return true;                                                 // still running in
      const g = t.R.st[L.k], end = L.k === 0 || L.k === t.R.LAST;
      return now - L.arr < (end && Lm.isTermG(g) ? rules.END_HOLD_S : rules.MID_HOLD_S) * S_MS;
    }
    function fade(t, now) { if (!t.fadeFrom || t.fadeFrom > now) { t.fadeFrom = now; t.fadeTo = now + rules.FADE_S * S_MS; } }
    // v4.02: fade out at a given time (a future fadeFrom: the train is still drawn until then)
    function fadeAt(t, when) { if (!t.fadeFrom || when < t.fadeFrom) { t.fadeFrom = when; t.fadeTo = when + rules.FADE_S * S_MS; } }
    function replace(t, tl, now) { t.snapAt = now; return tl; }
    // Standing with no data at a station: two platforms at a route end (a third train in means the oldest has gone out of service);
    // mid-line, a train that terminated there goes to the sidings when the next one comes in behind it
    function platformRules(Lm, now) {
      const standing = new Map();
      trains.forEach(t => {
        if (t.line !== Lm.id || (t.fadeFrom && t.fadeFrom <= now)) return;
        const e = evalTl(t.tl, now);
        if (e.moving) return;
        const g = t.R.st[e.k], atEnd = e.i === t.tl.length - 1;
        (standing.get(g) || standing.set(g, []).get(g)).push({ t, atEnd, since: t.tl[e.i].arr, dir: trainDir(t, now) });
      });
      standing.forEach((list, g) => {
        const idle = list.filter(x => x.atEnd).sort((a, b) => a.since - b.since);
        if (!idle.length) return;
        if (Lm.isTermG(g)) { while (list.length > 2 && idle.length) { fade(idle.shift().t, now); list.length--; } }
        else idle.forEach(x => {
          if (list.some(y => y !== x && !y.atEnd && y.dir === x.dir && y.since > x.since)) { fade(x.t, now); return; }
          // v4.02: the platform must be clear for the next train the same way: it goes out of service PLATFORM_CLEAR_S before that train is due there
          trains.forEach(y => {
            if (y === x.t || y.line !== Lm.id || y.fadeFrom || y.R.st.indexOf(g) < 0) return;
            for (let j = 1; j < y.tl.length; j++) {
              const e = y.tl[j];
              if (y.R.st[e.k] !== g || !(e.arr > x.since) || legDir(y.tl[j - 1].k, e.k) !== x.dir) continue;
              fadeAt(x.t, Math.max(now, e.arr - rules.PLATFORM_CLEAR_S * S_MS)); break;
            }
          });
        });
      });
    }

    function ingest(reply, dateHeader, receivedAt, lineIds) {
      if (receivedAt == null) receivedAt = Date.now();
      const hdr = dateHeader ? Date.parse(dateHeader) : NaN;
      if (Number.isFinite(hdr)) {                                                       // the Date header is whole seconds: take the middle
        const o = hdr + 500 - receivedAt;
        offset = offsetN === 0 || Math.abs(o - offset) > 5000 ? o : offset + (o - offset) * 0.2;
        offsetN++;
      }
      const now = receivedAt + offset;
      const data = Array.isArray(reply) ? reply : [];
      const byLine = new Map(), only = lineIds && lineIds.length === 1 ? lineIds[0] : null;   // (test feeds may leave lineId out)
      data.forEach(p => { const id = p.lineId || only; if (LINES[id]) (byLine.get(id) || byLine.set(id, []).get(id)).push(p); });
      const asked = lineIds || [...byLine.keys()];
      // v4.03: one train, one line. TfL lists a train on shared track under every line using it; with several lines in one reply it is kept
      // once, on the line it is already on, else the line whose stations explain most of its predictions (then its destination)
      const owner = new Map();
      if (asked.length > 1) {
        const fit = new Map();                                                       // vehicle -> line -> [stops on that line, destination on it]
        asked.forEach(id => { const Lm = LINES[id]; if (!Lm) return; (byLine.get(id) || []).forEach(p => {
          const v = String(p.vehicleId || "").trim(); if (!v || /^0+$/.test(v)) return;
          const f = fit.get(v) || fit.set(v, new Map()).get(v), r = f.get(id) || f.set(id, [0, 0, 0]).get(id);
          r[2]++; if (Lm.byNaptan[p.naptanId] !== undefined) r[0]++; if (Lm.byNaptan[p.destinationNaptanId] !== undefined) r[1] = 1; }); });
        fit.forEach((f, v) => {
          if (f.size < 2) {                                                          // listed under one line now: a copy left on another line goes
            const only = [...f.keys()][0];
            asked.forEach(id => { const o = trains.get(id + "|" + v); if (id !== only && o) fade(o, now); });
            return;
          }
          const cur = [...f.keys()].find(id => trains.has(id + "|" + v) && !trains.get(id + "|" + v).fadeFrom);
          const best = cur || [...f.entries()].sort((x, y) => (y[1][0] / y[1][2] - x[1][0] / x[1][2]) || (y[1][1] - x[1][1]) || (y[1][0] - x[1][0]))[0][0];
          owner.set(v, best);
          f.forEach((r, id) => { const o = trains.get(id + "|" + v); if (id !== best && o) fade(o, now); });   // its copy on the other line goes at once
        });
      }
      asked.forEach(id => { if (!LINES[id]) return;
        const skip = new Set(); owner.forEach((o, v) => { if (o !== id) skip.add(v); });
        ingestLine(LINES[id], byLine.get(id) || [], now, skip); });
      lastAt = now;
      return now;
    }

    function describe(t, T) {
      const Lm = LINES[t.line], R = t.R, S = Lm.S, tl = t.tl, e = evalTl(tl, T);
      const nap = k => S[R.st[k]].naptan;
      const i0 = e.moving ? e.i - 1 : e.i, here = tl[i0], nx = tl[i0 + 1];
      let state;
      if (t.fadeFrom && t.fadeFrom <= T) state = "fading";
      else if (e.moving) state = "moving";
      else if (!nx) state = "terminus";
      else if (here.wait || here.arr === -Infinity || (tl[i0 - 1] && legDir(tl[i0 - 1].k, here.k) !== legDir(here.k, nx.k))) state = "waiting";
      else state = "dwell";
      const fromK = e.moving ? e.kFrom : e.k, toK = e.moving ? e.kTo : (nx ? nx.k : e.k);
      return {
        id: t.key, line: t.line, vid: t.vid, dir: trainDir(t, T), route: R.id,
        dest: S[t.dest] ? S[t.dest].naptan : null, destName: S[t.dest] ? S[t.dest].name : t.destName || "",
        destShown: t.destShown !== undefined && S[t.destShown] ? S[t.destShown].naptan : null, destChangedAt: t.destChangedAt,
        from: nap(fromK), to: nap(toK), fromK, toK,
        departAt: fin(here.dep), arriveAt: e.moving ? fin(tl[e.i].arr) : (nx ? fin(nx.arr) : null),
        state, progress: e.moving ? e.p : 0,
        stops: tl.slice(i0).map(x => ({ naptan: nap(x.k), k: x.k, at: fin(x.arr), dep: fin(x.dep) })),
        snapAt: t.snapAt, fadeFrom: t.fadeFrom, fadeTo: t.fadeTo, towards: t.towards || "", loc: t.loc || "", platform: t.platform || ""
      };
    }

    function snapshot(at) {
      if (at == null) at = Date.now() + offset;
      trains.forEach((t, k) => { if (t.fadeTo && at >= t.fadeTo) trains.delete(k); });
      Object.values(LINES).forEach(Lm => platformRules(Lm, at));
      return { at, clockOffset: offset, trains: [...trains.values()].map(t => describe(t, at)) };
    }

    return {
      ingest, snapshot, rules,
      get clockOffset() { return offset; },
      now() { return Date.now() + offset; },
      lines: LINES,
      _trains: trains
    };
  }

  // Where a train in a snapshot is at time T, from its stops alone (the helper every page uses):
  // { fromK, toK, p, standing, i (index into stops of the stop it stands at or runs to), dir (of the run it is on, or the next one, else the
  // last), end (standing at the last stop known: nothing known after it), arrDir (the way it came in, when standing) }
  function positionAt(train, T) {
    const st = train.stops, d = (a, b) => b > a ? "S" : "N";
    let r = null;
    for (let i = 0; i < st.length && !r; i++) {
      const x = st[i], arr = x.at === null ? -Infinity : x.at, dep = x.dep === null ? Infinity : x.dep;
      if (i > 0 && T < arr) {
        const a = st[i - 1], span = arr - a.dep;
        r = { fromK: a.k, toK: x.k, p: span > 0 ? Math.max(0, Math.min(1, (T - a.dep) / span)) : 1, standing: false, i };
      } else if (T < dep) r = { fromK: x.k, toK: st[i + 1] ? st[i + 1].k : x.k, p: 0, standing: true, i };
    }
    if (!r) { const L = st[st.length - 1]; r = { fromK: L.k, toK: L.k, p: 0, standing: true, i: st.length - 1 }; }
    const pv = r.standing && st[r.i - 1] && st[r.i - 1].k !== r.fromK ? d(st[r.i - 1].k, r.fromK) : null;
    r.dir = r.toK !== r.fromK ? d(r.fromK, r.toK) : pv || train.dir;
    r.arrDir = r.standing ? pv || train.dir : r.dir;
    r.end = r.standing && r.i === st.length - 1;
    return r;
  }

  const API = { create, positionAt, RULES };
  if (typeof module === "object" && module.exports) module.exports = API;
  else root.UndercurrentTrainsCore = API;
})(typeof self !== "undefined" ? self : this);
