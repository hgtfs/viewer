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
  agencies.filter(a => a.id !== "RA").forEach((a) => {       // RA shares SFMER's slot visually
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

Promise.all([
  fetch("./data/stops.geojson").then(r => r.json()),
  fetch("./data/edges.geojson").then(r => r.json()),
  fetch("./data/agencies.json").then(r => r.json()),
]).then(([s, e, agencies]) => {
  stops = s.features; edges = e.features;
  agencies.forEach((a) => { a._rgb = hexToRgb(a.color); agencyById[a.id] = a; });
  buildLegend(agencies); buildTicks();
  dataReady = true;
  render();
}).catch((err) => {
  $("counts").textContent = "errore nel caricamento dati";
  console.error(err);
});

$("slider").addEventListener("input", (e) => { year = +e.target.value; if (playing) setPlaying(false); render(); });
$("play").addEventListener("click", () => setPlaying(!playing));
