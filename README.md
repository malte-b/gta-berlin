# Berlin — The Game

DISCLAIMER: THIS APP WAS PURELY VIBECODED

A drivable, walkable 3D Berlin in the browser, built entirely from open data.
Inspired by [sf.thijs.gg](https://sf.thijs.gg/) — but where that project
renders Apple Maps data, this one runs on data Berlin and OpenStreetMap publish
for anyone to use. The goal is an open-world game feel at street level, which
is where aerial datasets are weakest — so each layer comes from the source that
is best at it:

| layer | source | why this one |
|---|---|---|
| terrain | Berlin airborne laser scan (ALS), ground returns only | the only bare-earth surface at 1 m; Kreuzberg has 33 m of relief |
| buildings | OpenStreetMap Simple 3D Buildings, modelled by [OSM2World](https://osm2world.org) | crisp geometry and textures at eye level, correct roof shapes and storeys |
| trees | Baumkataster (Berlin's tree cadastre) | every street and park tree, with surveyed height and crown diameter |
| streets, parks, water | OpenStreetMap | painted onto the terrain |
| street furniture | Straßenbefahrung 2014 (Berlin's street survey), modelled by OSM2World | every surveyed sign, bollard, bin, bench, bus shelter and bike stand, at its measured position |
| ground and roof photos | Berlin true orthophotos 2024 (20 cm) | real markings, crossings, paths and roofs, draped from above |

```bash
npm install
npm run dev          # http://localhost:5173
npm run typecheck
```

The client is TypeScript on three.js. The built open-data world (~32 MB) is
committed under `web/public/data/` so that Vercel can serve it, since the
pipeline can't run there. After changing the area or the pipeline, rebuild it
with the steps below and commit the result.

---

## Controls

| | |
|---|---|
| `W A S D` | move · `Shift` sprint · `Space` jump |
| `Q` `E` | turn · `R` `F` tilt the view (fully playable without a mouse) |
| `1` `2` `3` `4` | on foot · bike · e-scooter · car |
| look up and walk forward | take off; fly into the ground to land · `H` toggles flight |
| `/` | search for an address, Enter to travel there |
| `C` | camera: third person · close · first person |
| `N` | day / night |
| `G` | shadows on / off |
| `T` | labels · `L` data layers · `M` minimap zoom · `X` respawn |
| link | copies a URL pointing at exactly where you are standing |

---

## Building the world

```bash
brew install openjdk          # OSM2World needs Java 17+
python3 pipeline/build_world.py
python3 pipeline/build_pois.py
python3 pipeline/set_spawn.py 52.48475 13.38623 --face "Cafe do Brazil"   # optional
```

`build_world.py` takes `--area E0 N0 E1 N1` (EPSG:25833 metres; the default is
Bergmannkiez and the Kreuzberg, 1.1 × 1.1 km), `--texture-res` (largest
building texture edge, default 1024; OSM2World's own default is 512, its CC0
textures are 2048) and `--refresh` to re-query OSM
and the tree cadastre. OSM2World is downloaded into `tools/` on first run.
Everything else is **standard-library Python** — no numpy, GDAL or PDAL —
and every download is cached under `cache/`, so a rebuild takes seconds.

Output in `web/public/data/`:

| file | what |
|---|---|
| `terrain.bin` | ALS ground, 1 m grid, `BTT1` |
| `buildings.glb` | every building, textured, in game-world metres — plain glTF 2.0 |
| `trees.bin` | cadastre trees with sizes, `BTR1` |
| `props.glb` | one OSM2World model per kind of street furniture, facing north |
| `props.bin` | where each copy stands and which way it faces, `BPR1` |
| `cover.png` | ground cover mask, 0.5 m, one class per channel |
| `ground/` | CC0 PBR textures for asphalt, paving, grass |
| `nav.bin` | where you can walk and drive, `BTN1` |
| `env/` | CC0 sky HDRI from Poly Haven, for image-based lighting |
| `world.json` | manifest: bounds, files, spawn, attribution |

All of it is engine-neutral — a glTF and documented binary grids — so the same
build can feed another client (a Godot port is planned).

### All of Berlin

```bash
uv venv && uv pip install -r pipeline/requirements.txt    # once
.venv/bin/python pipeline/build_berlin.py --radius 3     # everything within 3 km of the spawn
.venv/bin/python pipeline/build_berlin.py                # the whole city, ~1,066 tiles
```

The one package outside the standard library, `inflate64`, is for the laser
scan of south-east Berlin: `Suedost.zip` is Deflate64-compressed, which
Python's zlib cannot read.

This builds the city as 1 × 1 km tiles, matching the laser scan's own km grid,
into `data/berlin/` at the repository root. It is git-ignored: at full detail
the whole city is 10–20 GB, far more than the repository or Vercel can hold,
so it is hosted on object storage instead (see below). `npm run dev` serves it, and when `data/berlin/world.json`
exists the game streams those tiles instead of the committed Kreuzberg area.

* **Tiles are the single-area build, run per km** with a 100 m margin. Hole
  filling, the navigation clean-up and roof heights see past the edge, then
  everything is cropped back. Each building, tree and piece of furniture
  belongs to the one tile its centre is in. The terrain keeps one extra row and
  column, so neighbouring tiles meet without a seam.
* **OpenStreetMap comes from one download**, Geofabrik's daily Berlin extract,
  read by a small PBF reader (`osmpbf.py`, `osmlocal.py`). The pipeline would
  otherwise send the public Overpass API about 4,000 heavy queries. The answers
  are written as the same cache files Overpass responses would be. The extract
  covers Berlin only, so tiles on the boundary have no OSM data on the
  Brandenburg side.
* **Buildings are packed** into one mesh per 275 m chunk and material
  (`pack_buildings.py`), so the game has a few hundred meshes per tile to
  load instead of thousands. New builds do this themselves; for an older
  build run `python3 pipeline/pack_buildings.py data/berlin` (seconds).
* **Resumable and playable while it runs.** Tiles are built nearest the spawn
  first, `world.json` is rewritten after each one, and finished tiles are
  skipped on the next run. `--workers` (default 4) sets parallelism; each
  worker needs up to ~10 GB of memory, mostly OSM2World's Java heap. Logs per
  tile are in `cache/berlin_logs/`.
* **Streaming in the client:** full detail (1 m terrain, buildings, trees,
  furniture, navigation, labels) for tiles within 800 m. Within 2.6 km there
  is coarse terrain (4 m) under each tile's 50 cm orthophoto, for the view from
  the air. 20 cm orthophotos are swapped in per 100 m chunk within ~320 m. Fog
  closes before the edge of what is loaded. Geometry is stored relative to each
  tile, so 40 km of coordinates don't jitter in 32-bit floats.

### Hosting the tiles

The tiles are static files, so any S3-compatible object storage can serve
them: MinIO (e.g. the Datahub Berlin), Hetzner, STACKIT, IONOS, Cloudflare R2.
`sync_tiles.py` uploads them with the AWS CLI (`brew install awscli`), whose
own configuration holds the credentials:

```bash
aws configure --profile tiles                     # once: access key and secret
python3 pipeline/sync_tiles.py s3://gta-berlin --endpoint https://s3.example.berlin --profile tiles
VITE_TILE_BASE=https://s3.example.berlin/gta-berlin/ npm run build
```

* **Only changes go up.** After a rebuild of a few tiles the next sync takes
  minutes. `world.json` goes last, so it never names a tile that isn't
  uploaded yet. `--dry-run` shows what would change, and `--delete` also
  removes remote files that are gone locally.
* **Content types and caching are set per file.** Tile files are cached for a
  year: `world.json` gives every tile a version (the time it was built), which
  the game appends to its URLs, so a rebuilt tile is fetched fresh.
  `world.json` itself is revalidated on every load.
* **The bucket needs** anonymous read access (a public-read bucket policy)
  and, when the game runs on another domain, CORS for GET from that domain.
  MinIO allows every origin by default.
* `VITE_TILE_BASE` is read at build time. Set it in Vercel's environment
  variables to use the bucket in production. Without it, the game uses the
  local `data/berlin/` and falls back to the committed area.

### Data layers

Other datasets appear in the city as labelled pins. `L` opens the panel, where
each layer can be switched on and off.

```bash
python3 pipeline/build_layers.py      # bake the layers listed in pipeline/layers.json
```

* **Baked from Berlin's geodata services.** Most open datasets on
  [daten.berlin.de](https://daten.berlin.de) are also published as a WFS on
  gdi.berlin.de. An entry in `pipeline/layers.json` names the service, the
  feature type and which properties make the label and the second line.
  `build_layers.py` fetches the whole city, takes the licence from the service's
  own capabilities, and writes `web/public/data/layers/`: small, committed, and
  shared by the Kreuzberg build and all of Berlin. Public toilets and schools
  are included as examples. Lines and areas are placed at their centre.
* **Dropped in at runtime.** Drag a GeoJSON or CSV file onto the game, or use
  the panel's button. It is read in the browser and never uploaded. GeoJSON
  may be WGS84, EPSG:25833 or Web Mercator. CSV needs `lat`/`lon` columns
  (or `breite`/`länge`) or `x`/`y` in EPSG:25833, with commas, semicolons and
  German decimal commas all accepted. The label comes from `name`,
  `bezeichnung`, `titel` and the like. Points more than 60 km from Berlin are
  left out, which catches swapped columns.

Only open, non-personal data belongs in a layer.

---

## How it works

### Terrain from 37 GB zip files, without downloading them

Berlin publishes its laser scan as a classified point cloud (~10 points/m²),
one LAS file per km — but only inside nine regional zip archives of 1–50 GB
each. The server answers HTTP range requests, so `pipeline/als.py` never
downloads an archive: it reads the zip's central directory from the end of the
file, then fetches each wanted tile as a single byte range, inflates it as it
streams in, and reduces it to a 1 m grid on the fly. About a minute per km²;
only the grid is cached.

Only class 2 (ground) is kept. Under buildings there are no ground returns, so
those holes are filled from a mean pyramid and relaxed smooth — measured cells
keep their surveyed value.

**Is the terrain worth it?** In this area, yes, clearly: walkable ground spans
33 m (33.8–66.8 m above sea level), half of it lies more than 2 m off a flat
plane, and even a single 100 m block typically has 5.5 m of relief. In flatter
parts of Berlin the case is weaker, and the official DGM1 — a 1 m terrain
model derived from the same scan, in 2 km tiles — would be a lighter source
for very large areas.

### Buildings: let OSM2World interpret the tags

OSM2World is the reference implementation of Simple 3D Buildings — the same
scheme OSM Buildings and F4 Map read: `height`, `building:levels`,
`roof:shape`, `building:part`, `building:colour`, `building:material` and the
rest. The pipeline does not re-implement any of it; it hands OSM2World the raw
buildings and post-processes the glTF it writes, using its standard style:
plaster, brick, concrete and roof-tile PBR textures, and a window layer laid
out storey by storey.

Three things are fixed up in place:

* **Reprojection.** OSM2World works in its own local projection. Its footprint
  vertices are matched to the OSM nodes they came from and an affine transform
  to UTM 33 is fitted by least squares, which absorbs both its projection and
  the 1.3° meridian convergence without knowing either.
* **Placement.** OSM2World runs without terrain, so each building is lifted
  onto the laser-scan ground at the lowest point under its footprint — on a
  slope the uphill side sinks into the hill, and nothing ever floats.
* **Colour.** Tagged colours are kept. Untagged buildings all share one default
  tint, so they are moved onto tinted copies of the same materials, picked per
  building from a Berlin facade palette.

In the browser the ~2,350 per-building meshes are merged into one mesh per
(chunk, material), which keeps the frame at ~150–250 draw calls.

### Filling in what OSM does not map

Most buildings in OSM have an outline but no `height` and no
`building:levels`, and OSM2World then has to guess. Before it runs,
`complete_3d_tags` in `pipeline/osm3d.py` patches a copy of the OSM data:

* **No height at all:** the laser scan records roofs as well as ground, so
  the median of roof-above-ground inside the outline becomes `height`, with
  storeys estimated at 3.3 m and `roof:shape=flat` (the median is a level,
  not a shape). Berlin's scan has no building class - roofs are filed as
  "high vegetation" with the tree crowns - so this uses every non-ground,
  non-noise return.
* **A height but no storeys:** storeys are estimated from the wall height,
  otherwise OSM2World draws the wall without any windows.
* **Outlines that contain `building:part`s are never touched.** Under Simple
  3D Buildings the parts *are* the building; giving the outline a height made
  OSM2World build a second facade over them. Tempelhof airport is mapped
  this way.

Mapped tags are never overwritten, and everything added carries a `source:`
tag. Buildings wider than 150 m (Tempelhof, 870 m) follow the terrain instead
of sitting on one level, since their ground varies by ~10 m.

### Orthophotos

Berlin's true orthophotos are fetched from the WMS (the download feed only
offers multi-GB JPEG2000 zips) as one 100 m tile per terrain chunk at 20 cm,
plus a 0.5 m overview of the whole area. "True" means roofs sit on their
footprints rather than leaning, so the same photo drapes the ground and colours
every upward-facing building surface. The photo already contains the survey
day's light, so it is toned down to albedo range rather than lit as bare
colour; up close the surface-class textures add back grain the 20 cm pixels
lack. Parked cars and tree shadows of the survey day are baked in.

### Trees

Each cadastre record has a genus, height, crown diameter and trunk girth. Not
every record has all of them — crown diameter is often 0 — so missing values
are estimated: height from girth with a saturating height–diameter curve, crown
from height with a per-genus ratio (a plane tree spreads, a pear stays narrow).
Trees are drawn as instanced trunks and lumpy crowns (cones for conifers),
sized from those numbers and coloured by genus.

### Ground

Roads, paths, parks and water from OSM are not modelled — separate geometry
over a 1 m terrain either floats or z-fights. They are rasterised into a 0.5 m
RGBA mask instead, and the terrain shader blends tiling PBR textures by it.
Every texture is sampled twice, at its true scale and a larger rotated one,
mixed by noise, so the tiling does not show.

### Bridges

The terrain is one height per square metre, so it can hold a bridge deck or
what runs underneath, not both. The laser scan does not count most decks as
ground: over a road or tracks the ground beneath is in the deck's shadow, and
hole filling used to smear deck and cutting into a wavy ramp; over water the
river polygon painted whatever was left blue. So bridges are built on their
own (`bridges.py`):

* **Where and how wide:** OSM ways tagged `bridge=*`, for roads, paths and
  railways, including bridges under construction. Ways that continue each
  other are joined first, so a viaduct split into many ways is measured as
  one. Where OSM maps the bridge's outline (`man_made=bridge`, about 1,000 in
  Berlin), the main deck is widened to it on each side and run on to its
  ends; other decks at the same height inside it are covered by it and
  dropped. Elsewhere, decks side by side at one level - a carriageway and
  its separately mapped pavements, parallel tracks - widen to meet halfway.
* **How high:** from the laser scan. The deck level is what the middle of
  the bridge returns along its centreline, which the deck itself covers. The
  ends are pinned to the road carrying on past each abutment, but only if
  that is within 4.5 m of the deck level: OSM often stops a bridge at the
  edges of the street it spans, so just past its end can still be the
  street below. In between, the median of the returns near the line between
  the ends counts, so lamp posts, catenary, lorries and the bracing of a
  truss bridge do not lift it. Under station halls and platform roofs the
  upper returns are the roof, so they are ignored there.
* **Underneath:** returns at deck height are dropped before hole filling, so
  the river or the cutting carries on below. Under the last few metres at
  each abutment the terrain is lifted to the deck, so road and bridge meet
  without a step.
* **Underneath, on the ground:** roads on bridges are not painted onto the
  ground cover, and where nothing is mapped under a deck the cover continues
  from beside it - the river under a river bridge. The orthophoto shows the
  deck's top, so the ground under a deck keeps its own material instead.
* **In the game:** each deck is a slab with the orthophoto on top, like the
  roofs. Street furniture within 2 m of a road or path deck stands on it.
  Height and movement checks take the player's height into account: you can
  walk and drive across the Spree, and still drive under a railway viaduct.

Buildings OSM puts underground (`location=underground`, or a negative
`layer` without `location=surface`) are left out: shops in U-Bahn stations
and underground car parks would otherwise stand on the street above.

### Where you can go

`nav.bin` is a 1 m grid: walkable means not inside a building footprint (from
OSM), not a tree trunk, not water, and not too steep on the laser-scan terrain.
OSM ways tagged `tunnel=building_passage` are cut back out of the footprints,
so the archways into Berlin courtyards stay open. Driving uses the walkable
mask eroded by 2 m.

The spawn is a pavement beside a street, in the largest connected region, with
open sky around it — or the spot pinned with `set_spawn.py`, which survives
rebuilds as long as it is still walkable.

### Rendering

Everything in the city uses three's standard PBR material, so buildings,
terrain and trees share one sun, one set of shadows (a 4096² map that follows
the player), fog and ACES tone mapping. The terrain and trees extend the
standard material through `onBeforeCompile` rather than being raw shaders,
which is what lets them receive shadows. At night the window layer glows.

---

## Known limitations

* **Facades are generic.** Ground and roofs come from real aerial photos, but
  walls use OSM2World's CC0 library textures: a Gründerzeit block reads as
  plaster with the right number of storeys, not as that particular facade.
* **Baked-in moments on the ground.** The orthophoto shows the cars that were
  parked and the shadows that fell on the survey day.
* **Untagged buildings are guesses.** Where OSM has no height or levels,
  OSM2World falls back to defaults, and the roof is flat unless `roof:shape`
  says otherwise.
* **The ground is flat-shaded at kerb scale.** The terrain is 1 m, so kerbs and
  steps are painted, not modelled.
* The covered area is only what was built — walk far enough and you reach the
  edge. With all of Berlin built, the edge is the city boundary; tiles load as
  you approach, and an unloaded tile cannot be entered until it has.
* Driving is arcade-simple: no suspension, no proper collision response.

## Attribution

* **Terrain:** Airborne Laserscanning (ALS) — Senatsverwaltung für
  Stadtentwicklung, Bauen und Wohnen Berlin, `dl-de/zero-2.0`.
* **Trees:** Baumbestand Berlin (Straßen- und Anlagenbäume), `dl-de/zero-2.0`.
* **Orthophotos:** TrueDOP 2024 (DOP20RGBI) — Senatsverwaltung für
  Stadtentwicklung, Bauen und Wohnen Berlin, `dl-de/zero-2.0`.
* **Buildings, streets, green space, places:** © OpenStreetMap contributors,
  ODbL. 3D models generated with OSM2World (LGPL); textures from its standard
  style (CC0, ambientCG).

---

## Street names and places

`pipeline/build_pois.py` queries Overpass **once**, at build time, projects
everything into world metres and writes `web/public/data/pois.json`. The
running game only ever reads that file, so playing puts no load on the API.

Street names are painted onto the road surface and turned to the local
bearing; places get a billboard label on a stem. Both mount only within a
radius of the camera, and label textures are cached by string.

The *refresh* category (benches, drinking fountains, toilets, shade) mirrors
what the [Berliner Erfrischungskarte](https://erfrischungskarte.odis-berlin.de/)
surfaces. Re-run with `--refresh` to re-query Overpass.

## Performance

Measurements and what each optimisation changes are
in [docs/performance.md](docs/performance.md) (`npm run bench`).

Measured on the default area (739 buildings, 2,550 trees), Chrome on an Apple
Silicon Mac:

| | |
|---|---|
| frame rate | 55–80 fps at street level, shadows on |
| draw calls | ~150–250 |
| triangles drawn | ~3.1–3.4 M, including the shadow pass |
| download | ~18 MB |

Shadows are the most expensive single thing in the frame; `G` switches them
off.
## Checking a build

Two checks for the things that broke before, to run after every change to
the pipeline or the renderer:

- `npm run check -- --dir data/berlin` reads a build folder with the game's
  own readers: it walks every bridge deck the way the player would (decks
  you cannot get onto, gaps, jumps, ends blocked by the navigation grid),
  and looks for water on decks, seams between water levels, and street
  furniture floating or standing in the water. It writes a report with links
  into the game (`--out`, `--url`); the counts are for comparing builds.
- `node scripts/views.ts` renders fixed viewpoints, or any spot with
  `--at x,z`, into a page of screenshots.

