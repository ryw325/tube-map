/* Project Undercurrent: lines/parttime.js (v4.16). Which stops a line serves only at certain times, and which gaps in a train's list mean
   "this train runs through". Read by trains-core.js (as UC_PART_TIME when it is on the page, or passed in as opts.policy) and by the line
   and station pages (the dashed ring). No DOM here, so Node tests can require it.

   Finding (16 Oct 2026 recording, Friday 14:27): TfL lists Turnham Green for EVERY Piccadilly train (205 of 205 vehicles that list Acton Town
   and Hammersmith), whether or not it calls there. So the feed cannot say; the hours below can (TfL's Piccadilly line engagement report,
   Jan 2014, and Wikipedia: trains call from the start of traffic until 06:50 Monday to Saturday (07:45 Sunday) and from 22:30 until the close
   of traffic). Check them against TfL's current timetable before publishing.

   calls(line, naptan, ms): true (calls), false (runs through) or undefined (the policy has no rule: use the feed).
   feedSkips(line, naptan): true where a stop missing from the middle of a train's list is taken to be a skip. Only the Metropolitan, and not
   Baker Street to Aldgate, where TfL leaves Metropolitan trains' predictions out for the stations shared with the Circle and Hammersmith &
   City (every Aldgate-bound train in the Monday-evening recording lacks Farringdon to Liverpool Street). Other lines' lists have gaps
   that are feed noise (Central Bond Street, District Dagenham East to Upminster Bridge), so they are not read as skips. */
(function (root) {
  "use strict";
  const LIST = [
    { naptan: "940GZZLUTNG", name: "Turnham Green", lines: ["piccadilly"], note: "Piccadilly line trains call here from the start of traffic until 06:50 (07:45 on Sundays) and from 22:30 until the end of traffic." },
    { naptan: "940GZZLUKOY", name: "Kensington (Olympia)", lines: ["district"], note: "District line trains call here at weekends and for events at the exhibition centre." }
  ];
  const nrm = s => String(s || "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "");
  const byName = {}, byNaptan = {};
  LIST.forEach(e => { byName[nrm(e.name)] = e; byNaptan[e.naptan] = e; });
  // The entry when `line` serves this station (given by name or naptan) only part of the time, else null
  function partTime(line, station) {
    const e = byNaptan[station] || byName[nrm(station)];
    return e && e.lines.indexOf(line) >= 0 ? e : null;
  }
  // True when every line in `lines` serves the station only part of the time (a shared station that one line serves all day is drawn solid)
  function allPartTime(lines, station) { return !!lines.length && lines.every(l => !!partTime(l, station)); }

  function london(ms) {                       // minutes since midnight and weekday (0 = Sunday) in London at this moment
    const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)), g = t => (f.find(p => p.type === t) || {}).value;
    return { min: (+g("hour")) * 60 + (+g("minute")), day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday")) };
  }
  function calls(line, naptan, ms) {
    if (line === "piccadilly" && naptan === "940GZZLUTNG" && Number.isFinite(ms)) {
      const L = london(ms);
      return L.min < (L.day === 0 ? 7 * 60 + 45 : 6 * 60 + 50) || L.min >= 22 * 60 + 30;
    }
    return undefined;
  }
  const SHARED_MET = new Set(["ALD", "LVT", "MGT", "BBN", "FCN", "KSX", "ESQ", "GPS", "BST"].map(c => "940GZZLU" + c));
  function feedSkips(line, naptan) { return line === "metropolitan" && !SHARED_MET.has(naptan); }

  const API = { list: LIST, partTime, allPartTime, calls, feedSkips };
  if (typeof module === "object" && module.exports) module.exports = API;
  else root.UC_PART_TIME = API;
})(typeof self !== "undefined" ? self : this);
