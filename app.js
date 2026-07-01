/* HGTFS Viewer — time-aware rendering of a historical GTFS feed.
   Pure client-side: loads viewer/data/*.{geojson,json}, renders with MapLibre +
   deck.gl, scrubs by year. Stations fade in across their uncertainty window;
   edges are coloured by the operator valid in the selected year. */

let MIN = 1839, MAX = 1930;   // contextual window; overridden by events.txt if present
const BASEMAP = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const TICKS = [   // fallback timeline marks when no events.txt is loaded
  { y: 1839 }, { y: 1885, l: "Convenzioni" }, { y: 1905, l: "FS" }, { y: 1930 },
];

let year = 1876, playing = false, timer = null;
let stops = [], edges = [], events = [], agencyById = {}, overlay = null, mapReady = false, dataReady = false;
let currentRepo = null;   // repo spec kept in the shareable hash, when loaded from GitHub
let showStops = true;     // stations layer visibility (toggle in the legend)

const $ = (id) => document.getElementById(id);

/* ---------- i18n: follow the browser language (it / en, en fallback) ------- */
const LANG = (navigator.languages && navigator.languages[0] || navigator.language || "en")
  .toLowerCase().startsWith("it") ? "it" : "en";
const STR = {
  it: {
    title: "HGTFS Viewer — la rete ferroviaria nel tempo",
    desc: "Visualizzatore time-aware per feed HGTFS: scorri gli anni e guarda una rete ferroviaria storica aprirsi, chiudersi e cambiare operatore.",
    dataset: "Rete ferroviaria storica",
    op: "Operatore", uncert: "Incertezza",
    uncertOpen: "apertura<br>incerta", uncertConf: "confermata",
    note: "Le stazioni sfumano lungo la loro finestra di apertura: i dati storici sono datati per intervalli, non per giorno.",
    dropH: "Trascina qui un feed HGTFS",
    dropP: "uno <b>.zip</b> HGTFS — oppure i singoli file (stops, routes, network_edges, agency)",
    browse: "sfoglia…",
    dropGh: "o carica da GitHub: <code>?repo=org/repo</code> · <code>/org/repo/</code>",
    credit: "dati: feed HGTFS caricato · mappa base: © CARTO, © OpenStreetMap",
    dataLabel: "dati", basemap: "mappa base",
    stations: "stazioni", segments: "tratte", operators: "operatori",
    stopsToggle: "Stazioni",
    opened: "apertura", closed: "chiusura",
    incomplete: "feed incompleto — servono stops e network_edges",
    ghReading: "lettura struttura {repo}…",
    ghLoading: "caricamento {repo} ({n} file)…",
    ghNone: "nessun feed HGTFS in {repo}",
  },
  en: {
    title: "HGTFS Viewer — the railway network through time",
    desc: "Time-aware viewer for HGTFS feeds: scrub the years and watch a historical railway network open, close and change operator.",
    dataset: "Historical railway network",
    op: "Operator", uncert: "Uncertainty",
    uncertOpen: "uncertain<br>opening", uncertConf: "confirmed",
    note: "Stations fade in across their opening window: historical data is dated by interval, not by day.",
    dropH: "Drop an HGTFS feed here",
    dropP: "an HGTFS <b>.zip</b> — or the individual files (stops, routes, network_edges, agency)",
    browse: "browse…",
    dropGh: "or load from GitHub: <code>?repo=org/repo</code> · <code>/org/repo/</code>",
    credit: "data: loaded HGTFS feed · base map: © CARTO, © OpenStreetMap",
    dataLabel: "data", basemap: "base map",
    stations: "stations", segments: "segments", operators: "operators",
    stopsToggle: "Stations",
    opened: "opened", closed: "closed",
    incomplete: "incomplete feed — needs stops and network_edges",
    ghReading: "reading structure of {repo}…",
    ghLoading: "loading {repo} ({n} files)…",
    ghNone: "no HGTFS feed in {repo}",
  },
};
function t(k, vars) {
  let s = (STR[LANG] && STR[LANG][k] != null) ? STR[LANG][k] : (STR.en[k] != null ? STR.en[k] : k);
  if (vars) for (const p in vars) s = s.split("{" + p + "}").join(vars[p]);
  return s;
}
const NUM = (n) => n.toLocaleString(LANG);
function setDatasetLabel() {
  const el = $("dataset");
  if (el) el.textContent = dataReady ? `${t("dataset")} · ${MIN}–${MAX}` : t("dataset");
}
function applyStaticI18n() {
  document.documentElement.lang = LANG;
  document.title = t("title");
  const md = document.querySelector('meta[name="description"]');
  if (md) md.setAttribute("content", t("desc"));
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  setDatasetLabel();
}

/* ---------- helpers ---------- */
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function colorFor(id) {
  const a = agencyById[id];
  return a ? a._rgb : [120, 128, 140];
}
function agencyName(id) {
  return (agencyById[id] && agencyById[id].name) || id || "—";
}
function operatorAtYear(ops, y) {
  if (!ops) return null;
  for (const o of ops) if ((o.from == null || o.from <= y) && (o.to == null || y < o.to)) return o.agency;
  return null;
}
/* opacity 0→1 across [open_min, open_max]; fade out a few years after closure */
function stopAlpha(p, y) {
  const omin = p.open_min, omax = p.open_max;
  if (omax == null) return 0;
  let a;
  if (omin != null && omax > omin) a = y < omin ? 0 : (y >= omax ? 1 : (y - omin) / (omax - omin));
  else a = y >= omax ? 1 : 0;
  if (p.closed != null && y >= p.closed) a *= Math.max(0, 1 - (y - p.closed) / 3);
  return a;
}
function edgeAlpha(p, y) {
  if (p.open == null || p.open > y) return 0;
  if (p.closed != null && y >= p.closed) return Math.max(0, 1 - (y - p.closed) / 3);
  return p.open > y - 2 ? 0.45 + 0.55 * (y - p.open) / 2 : 1;   // brief fade-in
}
function fmtOpen(p) {
  if (p.open_min != null && p.open_max != null && p.open_min !== p.open_max) return `${p.open_min}–${p.open_max}`;
  return p.open_max != null ? `${p.open_max}` : "?";
}

/* ---------- layers ---------- */
function makeLayers() {
  const edgeLayer = new deck.PathLayer({
    id: "edges", data: edges,
    getPath: (f) => f.geometry.coordinates,
    getColor: (f) => { const a = edgeAlpha(f.properties, year); return a <= 0 ? [0, 0, 0, 0] : [...colorFor(operatorAtYear(f.properties.operators, year)), Math.round(a * 235)]; },
    getWidth: 2.2, widthUnits: "pixels", widthMinPixels: 1.2,
    capRounded: true, jointRounded: true, pickable: true,
    updateTriggers: { getColor: year },
  });
  const stopLayer = new deck.ScatterplotLayer({
    id: "stops", data: stops, visible: showStops,
    getPosition: (f) => f.geometry.coordinates,
    getFillColor: (f) => { const a = stopAlpha(f.properties, year); return a <= 0 ? [0, 0, 0, 0] : [245, 225, 196, Math.round(a * 230)]; },
    getRadius: 2.6, radiusUnits: "pixels", radiusMinPixels: 1.6, radiusMaxPixels: 5,
    stroked: false, pickable: true,
    updateTriggers: { getFillColor: year },
  });
  return [edgeLayer, stopLayer];
}

function render() {
  if (!mapReady || !dataReady) return;
  overlay.setProps({ layers: makeLayers() });
  let ns = 0, ne = 0;
  for (const f of stops) if (stopAlpha(f.properties, year) > 0.05) ns++;
  for (const f of edges) if (edgeAlpha(f.properties, year) > 0.05) ne++;
  $("counts").textContent = `${NUM(ns)} ${t("stations")} · ${NUM(ne)} ${t("segments")}`;
  $("year").textContent = year;
  $("slider").value = year;
  $("slider").style.setProperty("--pct", `${((year - MIN) / (MAX - MIN)) * 100}%`);
  const ev = eventAt(year);
  $("era").innerHTML = ev
    ? (ev.uri ? `<a href="${ev.uri}" target="_blank" rel="noopener">${ev.name} ↗</a>` : ev.name)
    : "";
  writeHash();
}

/* ---------- ui ---------- */
function buildLegend(agencies) {
  const ul = $("ops");
  ul.innerHTML = "";
  agencies.forEach((a) => {
    const li = document.createElement("li");
    if (a.pseudo) li.className = "pseudo";
    const era = a.from ? `${a.from}–${a.to || ""}` : "";
    li.innerHTML = `<span class="sw" style="background:${a.color};color:${a.color}"></span>${a.name.split("(")[0].trim()}<span class="era">${era}</span>`;
    ul.appendChild(li);
  });
}
function buildTicks() {
  const box = $("ticks");
  box.innerHTML = "";
  const marks = events.length
    ? events.map((e) => ({ y: e.date, l: String(e.date), title: e.name }))
    : TICKS.map((t) => ({ y: t.y, l: (t.l ? t.l + " " : "") + t.y, title: t.l || "" }));
  marks.forEach((m) => {
    if (m.y < MIN || m.y > MAX) return;
    const el = document.createElement("div");
    el.className = "tick";
    el.style.left = `${((m.y - MIN) / (MAX - MIN)) * 100}%`;
    el.title = m.title || "";
    el.innerHTML = `<div class="bar"></div><div class="lab">${m.l}</div>`;
    box.appendChild(el);
  });
}
/* the event providing context at a given year: a spanning event wins, else the
   most recent past milestone */
function eventAt(y) {
  let span = null, last = null;
  for (const e of events) {
    if (e.end && e.date <= y && y <= e.end) span = e;
    if (e.date <= y) last = e;
  }
  return span || last;
}
/* The timeline must reach every dated entity. events.txt frames the contextual
   start/end, but the bounds are widened so no stop or edge ever falls past the
   slider's max (otherwise the last cohort — e.g. 1870 — is unreachable). */
function applyBounds() {
  let lo = Infinity, hi = -Infinity;
  if (events.length) {
    lo = Math.min(...events.map((e) => e.date));
    hi = Math.max(...events.map((e) => e.end || e.date));
  }
  const see = (v) => { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } };
  for (const f of stops) { const p = f.properties; see(p.open_min); see(p.open_max); see(p.closed); }
  for (const e of edges) { const p = e.properties; see(p.open); see(p.closed); }
  if (!isFinite(lo) || !isFinite(hi)) { lo = 1839; hi = 1930; }
  MIN = lo; MAX = hi;
  const sl = $("slider"); sl.min = MIN; sl.max = MAX;
  year = Math.max(MIN, Math.min(MAX, year));
  setDatasetLabel();
}
function setPlaying(on) {
  playing = on;
  $("play").classList.toggle("on", on);
  $("play").textContent = on ? "❚❚" : "▶";
  if (timer) { clearInterval(timer); timer = null; }
  if (on) timer = setInterval(() => { year = year >= MAX ? MIN : year + 1; render(); }, 320);
}

/* ---------- boot ---------- */
/* shareable state lives in the hash: #repo=org/repo&y=1861&map=zoom/lat/lng
   (legacy #org/repo still works). Restore it before creating the map. */
const HS = parseHash();
if (HS.y != null) year = HS.y;
const map = new maplibregl.Map({
  container: "map", style: BASEMAP,
  center: HS.map ? [HS.map.lng, HS.map.lat] : [12.4, 42.3],
  zoom: HS.map ? HS.map.z : 5.1,
  attributionControl: false, maxZoom: 12, minZoom: 2,
});
map.on("moveend", writeHash);
/* the viewer is dataset-agnostic — frame whatever feed gets loaded, once.
   A shared map view (in the hash) takes precedence over auto-fit. */
let fitted = !!HS.map;
function fitToData() {
  if (fitted || !mapReady || !stops.length) return;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const f of stops) {
    const c = f.geometry.coordinates;
    if (c[0] < minx) minx = c[0]; if (c[1] < miny) miny = c[1];
    if (c[0] > maxx) maxx = c[0]; if (c[1] > maxy) maxy = c[1];
  }
  if (!isFinite(minx)) return;
  fitted = true;
  map.fitBounds([[minx, miny], [maxx, maxy]], { padding: 64, duration: 700, maxZoom: 9 });
}
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.on("load", () => {
  overlay = new deck.MapboxOverlay({
    interleaved: false, layers: [],
    getTooltip: ({ object, layer }) => {
      if (!object) return null;
      const p = object.properties;
      if (layer.id === "stops") return { html: `<b>${p.name}</b><br>${t("opened")}: ${fmtOpen(p)}` };
      const op = operatorAtYear(p.operators, year);
      return { html: `<b>${p.line || p.route_id}</b><br><span class="t-op">${year} · ${agencyName(op)}</span><br>${t("opened")}: ${p.open || "?"}${p.closed ? " · " + t("closed") + ": " + p.closed : ""}` };
    },
  });
  map.addControl(overlay);
  mapReady = true;
  fitToData();
  render();
});

applyStaticI18n();
buildTicks();

/* ---------- data loading: drag & drop a HGTFS .zip (or loose files) ---------- */
const PAL = {
  FS: "#2ec4b6", RM: "#4e79a7", RA: "#e15759", RS: "#b07aa1", SFAI: "#59a14f",
  SFR: "#edc948", SFMER: "#ff9da7", CRFS: "#9c6644", SFSS: "#c9a227",
  UNKNOWN_RM_RA: "#6b7280", UNKNOWN_PRE1885: "#4b5563", SARD_OP: "#8d6e63",
};
const PSEUDO_NAME = {
  UNKNOWN_RM_RA: "Rete Mediterranea / Adriatica (non distinte)",
  UNKNOWN_PRE1885: "Operatore pre-1885 (non risolto)",
  SARD_OP: "Operatore sardo (CRFS/SFSS)",
};
function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
function colorOf(id) {
  if (PAL[id]) return PAL[id];
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return hslHex(h % 360, 42, 56);
}
function yr(s) { return s && /^\d{4}/.test(String(s)) ? parseInt(String(s).slice(0, 4)) : null; }

function parseCSV(text) {
  const rows = []; let f = "", row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  if (!rows.length) return [];
  const h = rows.shift().map((x) => x.trim());
  return rows.filter((r) => r.some((v) => v !== "")).map((r) => {
    const o = {}; h.forEach((k, j) => o[k] = (r[j] ?? "").trim()); return o;
  });
}

const T = {};  // accumulated source tables, keyed by kind
let loadErr = "";
/* route a CSV by its COLUMNS first (robust against junk like macOS ._ files,
   which lack these headers), filename only as a fallback */
function classify(base, rows) {
  if (!rows.length) return null;
  const cols = new Set(Object.keys(rows[0]));
  const has = (...k) => k.every((x) => cols.has(x));
  if (cols.has("feed_publisher_name")) return "feedinfo";
  if (has("source_id", "source_name")) return "sources";
  if (has("agency_id", "agency_name")) return "agency";
  if (cols.has("stop_id") && (cols.has("stop_lat") || cols.has("stop_lon"))) return "stops";
  if (has("from_stop_id", "to_stop_id")) return "edges";
  if (cols.has("valid_from") || cols.has("valid_to")) return "routeops";
  if (cols.has("name") && (cols.has("date") || cols.has("year")) && !cols.has("route_id") && !cols.has("stop_id")) return "events";
  if (cols.has("route_id") && (cols.has("route_type") || cols.has("route_long_name") || cols.has("agency_id"))) return "routes";
  if (/feed_info/.test(base)) return "feedinfo";
  if (/historical_sources|sources/.test(base)) return "sources";
  if (/agency/.test(base)) return "agency";
  if (/event/.test(base)) return "events";
  if (/stop/.test(base)) return "stops";
  if (/edge/.test(base)) return "edges";
  if (/operator/.test(base)) return "routeops";
  if (/route/.test(base)) return "routes";
  return null;
}
function stash(base, text) {
  const b = base.toLowerCase();
  if (/\.geojson$|\.json$/.test(b)) {
    let j; try { j = JSON.parse(text); } catch { return; }
    if (Array.isArray(j)) T.geoAgencies = j;
    else if (j.type === "FeatureCollection" && j.features[0]) {
      const g = (j.features[0].geometry || {}).type;
      if (g === "Point") T.geoStops = j.features; else if (g === "LineString") T.geoEdges = j.features;
    }
    return;
  }
  const rows = parseCSV(text);
  const kind = classify(b, rows);
  if (kind) T[kind] = rows;
}

function assemble() {
  let ags = [];
  if (T.geoAgencies) ags = T.geoAgencies.map((a) => ({ ...a }));
  else if (T.agency) ags = T.agency.map((a) => ({ id: a.agency_id, name: a.agency_name, from: yr(a.date_opened), to: yr(a.date_closed), pseudo: false }));

  if (T.geoStops) stops = T.geoStops;
  else if (T.stops) stops = T.stops.filter((s) => s.stop_lat && s.stop_lon).map((s) => ({
    type: "Feature", geometry: { type: "Point", coordinates: [+s.stop_lon, +s.stop_lat] },
    properties: { id: s.stop_id, name: s.stop_name, open: yr(s.date_opened), open_min: yr(s.date_opened_min), open_max: yr(s.date_opened_max), closed: yr(s.date_closed), precision: s.date_precision },
  }));
  else stops = [];

  const coords = {}; stops.forEach((f) => coords[f.properties.id] = f.geometry.coordinates);
  const spans = {};
  if (T.routeops) T.routeops.forEach((r) => (spans[r.route_id] = spans[r.route_id] || []).push({ agency: r.agency_id, from: yr(r.valid_from), to: yr(r.valid_to) }));
  const rAg = {}; if (T.routes) T.routes.forEach((r) => rAg[r.route_id] = { agency: r.agency_id, open: yr(r.date_opened), closed: yr(r.date_closed) });

  if (T.geoEdges) edges = T.geoEdges;
  else if (T.edges) edges = T.edges.map((e) => {
    const a = coords[e.from_stop_id], b = coords[e.to_stop_id]; if (!a || !b) return null;
    let ops = spans[e.route_id];
    if (!ops) { const ra = rAg[e.route_id]; ops = ra && ra.agency ? [{ agency: ra.agency, from: ra.open, to: ra.closed }] : []; }
    return { type: "Feature", geometry: { type: "LineString", coordinates: [a, b] },
      properties: { route_id: e.route_id, line: e.line_name, open: yr(e.date_opened), closed: yr(e.date_closed), operators: ops } };
  }).filter(Boolean);
  else edges = [];

  const have = new Set(ags.map((a) => a.id));
  Object.values(spans).flat().forEach((o) => {
    if (o.agency && !have.has(o.agency)) { have.add(o.agency); ags.push({ id: o.agency, name: PSEUDO_NAME[o.agency] || o.agency, from: null, to: null, pseudo: /^UNKNOWN|^SARD_OP/.test(o.agency) }); }
  });
  agencyById = {};
  ags.forEach((a) => { a.color = a.color || colorOf(a.id); a._rgb = hexToRgb(a.color); agencyById[a.id] = a; });
  if (ags.length) buildLegend(ags);

  // optional historical context: events frame the timeline and annotate it
  events = T.events
    ? T.events.map((e) => ({ date: yr(e.date || e.year), end: yr(e.end_date), name: e.name || e.event_id || "", desc: e.description || "", uri: e.period_uri || e.periodo || "" }))
        .filter((e) => e.date).sort((a, b) => a.date - b.date)
    : [];
  applyBounds();
  buildTicks();
  setCredit();
}

/* Attribution comes from the feed itself (HGTFS feed_info.txt publisher +
   historical_sources.txt), so the viewer stays dataset-agnostic. Falls back to
   the generic base-map credit when the feed carries no provenance. */
function feedCredit() {
  const fi = (T.feedinfo && T.feedinfo[0]) || null;
  const pub = fi ? (fi.feed_publisher_name || "").trim() : "";
  const seen = new Set(), srcs = [];
  (T.sources || []).forEach((s) => {
    const n = (s.source_name || "").trim();
    if (n && !seen.has(n)) { seen.add(n); srcs.push(n); }
  });
  const bits = [];
  if (pub) bits.push(pub);
  bits.push(...srcs);
  if (!bits.length) return null;
  return `${t("dataLabel")}: ${bits.join(" · ")} · ${t("basemap")}: © CARTO, © OpenStreetMap`;
}
function setCredit() {
  const el = document.querySelector(".credit");
  if (!el) return;
  el.textContent = feedCredit() || t("credit");
  el.title = el.textContent;
}

function updateDropStatus() {
  const items = [[t("stations"), stops.length], [t("segments"), edges.length], [t("operators"), Object.keys(agencyById).length]];
  let html = items.map(([n, c]) => `<li class="${c ? "ok" : ""}">${c ? "✓" : "○"} ${n}${c ? ` · ${c}` : ""}</li>`).join("");
  if (loadErr) html += `<li class="err">⚠ ${loadErr}</li>`;
  else if (Object.keys(T).length && (!stops.length || !edges.length))
    html += `<li class="err">⚠ ${t("incomplete")}</li>`;
  $("dropstatus").innerHTML = html;
}
function tryReady() {
  assemble(); updateDropStatus();
  if (stops.length && edges.length) {
    dataReady = true; document.body.classList.add("loaded");
    setDatasetLabel(); fitToData(); render();
  }
}
function skip(path) {       // directories, macOS metadata, dotfiles / AppleDouble
  if (path.endsWith("/") || /(^|\/)__MACOSX\//.test(path)) return true;
  const base = path.split("/").pop();
  return !base || base.startsWith(".");
}
async function handleFiles(files) {
  loadErr = "";
  for (const f of files) {
    try {
      if (/\.zip$/i.test(f.name)) {
        const entries = fflate.unzipSync(new Uint8Array(await f.arrayBuffer()));
        for (const path in entries) {
          if (skip(path)) continue;
          stash(path.split("/").pop(), fflate.strFromU8(entries[path]));
        }
      } else if (!skip(f.name)) {
        stash(f.name.split("/").pop(), await f.text());
      }
    } catch (err) { loadErr = `${f.name}: ${err && err.message || err}`; console.error(err); }
  }
  tryReady();
}

const drop = $("drop");
["dragenter", "dragover"].forEach((ev) =>
  document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
document.addEventListener("dragleave", (e) => { if (e.relatedTarget === null) drop.classList.remove("over"); });
document.addEventListener("drop", (e) => {
  e.preventDefault(); drop.classList.remove("over");
  if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});
$("browse").addEventListener("change", (e) => handleFiles(e.target.files));
updateDropStatus();

$("slider").addEventListener("input", (e) => { year = +e.target.value; if (playing) setPlaying(false); render(); });
$("play").addEventListener("click", () => setPlaying(!playing));
$("toggle-stops").addEventListener("change", (e) => {
  showStops = e.target.checked;
  $("stops-toggle").classList.toggle("off", !showStops);
  render();
});

/* ---------- optional: launch a feed straight from a GitHub repo via jsDelivr ----------
   URL forms:  ?repo=org/repo[@ref]   |   #org/repo[@ref]   |   /org/repo/ (via 404.html)
   The repo's file structure is read from the jsDelivr data API, the HGTFS files are
   picked by name, and fetched from the jsDelivr CDN. */
const FEED_RE = /(?:^|\/)(agency|stops|routes|network_edges|events|route_operators|agencies|feed_info|historical_sources)\.(txt|csv|json)$|\.geojson$/i;
function setMsg(t) { $("dropstatus").innerHTML = `<li>${t}</li>`; }

async function loadFromGh(spec) {
  const at = spec.indexOf("@");
  const repoPath = (at >= 0 ? spec.slice(0, at) : spec).replace(/\/+$/, "");
  const ref0 = at >= 0 ? spec.slice(at + 1) : null;
  const [org, repo] = repoPath.split("/");
  if (!org || !repo) return;
  for (const ref of (ref0 ? [ref0] : ["main", "master"])) {
    try {
      setMsg(t("ghReading", { repo: `${org}/${repo}@${ref}` }));
      const meta = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${org}/${repo}@${ref}?structure=flat`).then((r) => r.ok ? r.json() : null);
      const wanted = (meta && meta.files || []).map((f) => f.name).filter((n) => FEED_RE.test(n));
      if (!wanted.length) continue;
      setMsg(t("ghLoading", { repo: `${org}/${repo}@${ref}`, n: wanted.length }));
      loadErr = "";
      for (const n of wanted) {
        try { stash(n.split("/").pop(), await fetch(`https://cdn.jsdelivr.net/gh/${org}/${repo}@${ref}${n}`).then((r) => r.text())); }
        catch (e) { console.error(e); }
      }
      tryReady();
      if (stops.length && edges.length) return;
    } catch (e) { console.error(e); }
  }
  loadErr = t("ghNone", { repo: `${org}/${repo}` }); updateDropStatus();
}
/* ---------- shareable URL state (hash): repo + map view (xyz) + year ----------
   #repo=org/repo[@ref]&y=1861&map=<zoom>/<lat>/<lng>
   The legacy bare form (#org/repo) is still accepted for loading a feed. */
function parseHash() {
  let h = location.hash.replace(/^#\/?/, "");
  if (!h) return {};
  try { h = decodeURIComponent(h); } catch (e) { /* keep raw */ }
  const out = {};
  if (h.includes("=")) {
    for (const kv of h.split("&")) {
      const i = kv.indexOf("="); if (i < 0) continue;
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (k === "repo") out.repo = v;
      else if (k === "y") { const n = parseInt(v, 10); if (!isNaN(n)) out.y = n; }
      else if (k === "map") {
        const m = v.split("/").map(Number);
        if (m.length === 3 && m.every(isFinite)) out.map = { z: m[0], lat: m[1], lng: m[2] };
      }
    }
  } else if (/[^/]+\/[^/]+/.test(h)) out.repo = h;   // legacy #org/repo[@ref]
  return out;
}
let _hashT = null;
function writeHash() {
  if (!mapReady) return;
  clearTimeout(_hashT);
  _hashT = setTimeout(() => {
    const c = map.getCenter(), parts = [];
    if (currentRepo) parts.push("repo=" + currentRepo);
    parts.push("y=" + year);
    parts.push(`map=${map.getZoom().toFixed(2)}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`);
    history.replaceState(null, "", "#" + parts.join("&"));
  }, 250);
}
function targetFromUrl() {
  const q = new URLSearchParams(location.search).get("repo") || new URLSearchParams(location.search).get("gh");
  const s = q || HS.repo || "";
  return /[^/]+\/[^/]+/.test(s) ? s : null;
}

const ghTarget = targetFromUrl();
currentRepo = ghTarget || null;
if (ghTarget) loadFromGh(ghTarget);
