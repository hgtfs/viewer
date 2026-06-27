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

Data is **not bundled** with the viewer. Open the page and drag
`stops.geojson`, `edges.geojson`, and `agencies.json` onto it (or use *sfoglia…*).
Files are detected by content (point/line FeatureCollections; the agencies array),
so order and exact filenames don't matter. `stops` + `edges` are enough to render;
`agencies.json` adds operator colours and the legend.

## Structure

```
viewer/
  index.html   markup + CDN libs (MapLibre GL, deck.gl) + fonts + drop zone
  style.css    dark glass UI
  app.js       map, deck.gl layers, time scrubbing, drag&drop loader, legend, tooltips
```

## Getting the data

Produce the three files with `../pipeline/build_webmap.py` (run after the rest of the
pipeline; it reads `hgtfs/` + `data/processed/` and writes them to `viewer/data/`,
which is git-ignored). Then drag them into the running viewer.

## Known limits

- **Edges are schematic** (straight station-to-station). True track geometry exists
  only for Sardinia; national geometry is a later upgrade (digitised maps / OSM).
- **1885–1905 mainland operator is mostly unknown** by design — the Mediterranea and
  Adriatica networks were deliberately interleaved; see the main `data/DICTIONARY.md`.
