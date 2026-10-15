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
| `T` | labels · `M` minimap zoom · `X` respawn |
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
  edge.
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
