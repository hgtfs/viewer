# HGTFS Viewer

A time-aware, fully client-side viewer for an HGTFS feed. Scrub the year and watch
the railway network open, close, and change operator. Built for `hgtfs.github.io/viewer`.

## What makes it HGTFS (not GTFS)

- **Time axis.** A year slider (1839–1930) + play. At year *t* only stops/edges
  valid at *t* are shown.
- **Uncertainty is honoured.** Historical dates are bucketed, so stations **fade in**
  across their opening window (`open_min`→`open_max`) instead of popping at a fake date.
- **Operator over time.** Edges are coloured by the operator valid in the selected year,
  so the network **recolours at 1885** (Convenzioni) and **1905** (FS nationalisation).
  Unresolved operators (the interleaved 1885–1905 mainland) are shown neutral, not guessed.

## Run / deploy

Pure static — no build step, no backend, no API keys (basemap © CARTO/OSM, libraries
from CDN). Deploy the folder to `/viewer`; open it and **drag the data in** (see below).

```bash
# locally
python3 -m http.server 8099   # then open http://localhost:8099/
```

## Loading data (drag & drop)

Data is **not bundled**. Open the page and drag in **a HGTFS `.zip`** — the viewer
unzips it in-browser (fflate) and parses the feed:

- `stops.txt` → stops (with `date_opened` + uncertainty columns)
- `network_edges.txt` → the graph (joined to stop coordinates)
- `routes.txt` / `agency.txt` → routes & operators
- `route_operators.csv` (extension) → the time-varying edge colouring
- `events.txt` (optional extension) → historical context: it **frames the timeline**
  (its min/max date become the scrubber's start/end) and annotates it (a marker per
  event + a live caption naming the moment you're scrubbing through). Columns:
  `event_id, date, end_date, name, description` (`end_date` optional, for periods).

Loose files also work (drop the individual `.txt`/`.csv`, or the legacy
`stops.geojson`/`edges.geojson`/`agencies.json`). Files are routed by basename and
content, so order doesn't matter. `stops` + `edges` are enough to render; operator
data adds colours and the legend. Operators not in `agency.txt` (e.g. the unresolved
`UNKNOWN_RM_RA`) get a generated colour and a neutral legend entry.

## Structure

```
viewer/
  index.html   markup + CDN libs (MapLibre GL, deck.gl) + fonts + drop zone
  style.css    dark glass UI
  app.js       map, deck.gl layers, time scrubbing, drag&drop loader, legend, tooltips
```

## Getting the data

Build the HGTFS `.zip` with `../pipeline/build_feed_zip.py` → `viewer/data/hgtfs_feed.zip`
(bundles `agency/stops/routes/network_edges` + `route_operators.csv`). Then drag it in.
`../pipeline/build_webmap.py` still emits the legacy GeoJSON if you prefer those.
`viewer/data/` is git-ignored.

## Known limits

- **Edges are schematic** (straight station-to-station). True track geometry exists
  only for Sardinia; national geometry is a later upgrade (digitised maps / OSM).
- **1885–1905 mainland operator is mostly unknown** by design — the Mediterranea and
  Adriatica networks were deliberately interleaved; see the main `data/DICTIONARY.md`.
