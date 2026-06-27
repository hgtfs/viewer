/* HGTFS Viewer — time-aware rendering of a historical GTFS feed.
   Pure client-side: loads viewer/data/*.{geojson,json}, renders with MapLibre +
   deck.gl, scrubs by year. Stations fade in across their uncertainty window;
   edges are coloured by the operator valid in the selected year. */

const MIN = 1839, MAX = 1930;
const BASEMAP = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const TICKS = [
  { y: 1839 }, { y: 1885, l: "Convenzioni" }, { y: 1905, l: "FS" }, { y: 1930 },
];

let year = 1876, playing = false, timer = null;
let stops = [], edges = [], agencyById = {}, overlay = null, mapReady = false, dataReady = false;

const $ = (id) => document.getElementById(id);

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
    id: "stops", data: stops,
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
  $("counts").textContent = `${ns.toLocaleString("it")} stazioni · ${ne.toLocaleString("it")} tratte`;
  $("year").textContent = year;
  $("slider").value = year;
  $("slider").style.setProperty("--pct", `${((year - MIN) / (MAX - MIN)) * 100}%`);
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
  TICKS.forEach((t) => {
    const el = document.createElement("div");
    el.className = "tick";
    el.style.left = `${((t.y - MIN) / (MAX - MIN)) * 100}%`;
    el.innerHTML = `<div class="bar"></div><div class="lab">${t.l ? t.l + " " : ""}${t.y}</div>`;
    box.appendChild(el);
  });
}
function setPlaying(on) {
  playing = on;
  $("play").classList.toggle("on", on);
  $("play").textContent = on ? "❚❚" : "▶";
  if (timer) { clearInterval(timer); timer = null; }
  if (on) timer = setInterval(() => { year = year >= MAX ? MIN : year + 1; render(); }, 320);
}

/* ---------- boot ---------- */
const map = new maplibregl.Map({
  container: "map", style: BASEMAP, center: [12.4, 42.3], zoom: 5.1,
  attributionControl: false, maxZoom: 12, minZoom: 4,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.on("load", () => {
  overlay = new deck.MapboxOverlay({
    interleaved: false, layers: [],
    getTooltip: ({ object, layer }) => {
      if (!object) return null;
      const p = object.properties;
      if (layer.id === "stops") return { html: `<b>${p.name}</b><br>apertura: ${fmtOpen(p)}` };
      const op = operatorAtYear(p.operators, year);
      return { html: `<b>${p.line || p.route_id}</b><br><span class="t-op">${year} · ${agencyName(op)}</span><br>aperta: ${p.open || "?"}${p.closed ? " · chiusa: " + p.closed : ""}` };
    },
  });
  map.addControl(overlay);
  mapReady = true;
  render();
});

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
  if (/agency/.test(b)) T.agency = rows;
  else if (/stop/.test(b)) T.stops = rows;
  else if (/network_edge|edges?/.test(b)) T.edges = rows;
  else if (/operator/.test(b)) T.routeops = rows;
  else if (/route/.test(b)) T.routes = rows;
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
}

function updateDropStatus() {
  const items = [["stazioni", stops.length], ["tratte", edges.length], ["operatori", Object.keys(agencyById).length]];
  $("dropstatus").innerHTML = items.map(([n, c]) => `<li class="${c ? "ok" : ""}">${c ? "✓" : "○"} ${n}${c ? ` · ${c}` : ""}</li>`).join("");
}
function tryReady() {
  assemble(); updateDropStatus();
  if (stops.length && edges.length) { dataReady = true; document.body.classList.add("loaded"); render(); }
}
async function handleFiles(files) {
  for (const f of files) {
    try {
      if (/\.zip$/i.test(f.name)) {
        const entries = fflate.unzipSync(new Uint8Array(await f.arrayBuffer()));
        for (const path in entries) { const base = path.split("/").pop(); if (base) stash(base, fflate.strFromU8(entries[path])); }
      } else stash(f.name, await f.text());
    } catch (err) { console.error("file non leggibile:", f.name, err); }
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
