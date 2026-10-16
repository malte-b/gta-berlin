# Performance

Goal: the game should run on phones the way it runs on a desktop - opened from
a link, no install. This file records what the game costs today, what the
changes do to it, and why.

## How it is measured

`npm run bench` (`scripts/bench.ts`) drives the game in headless Chrome against
a running dev server and measures three scenes:

| Scene | What it shows |
|---|---|
| **street** | standing at the spawn in Kreuzberg for 15 s: the everyday cost |
| **fly** | 1.5 km east over Kreuzberg and Mitte at 35 m, 38 m/s, for 40 s: streaming while moving |
| **air** | looking over the city from 300 m: everything in range loaded |

`--phone` emulates a phone screen (390 × 844 at 3× pixel density) and a CPU 4×
slower than the Mac's - roughly a mid-range phone. The GPU stays the Mac's,
so a real phone will be slower than the phone column here; a test on a real
device should confirm the numbers.

Frame pacing is uncapped (no vsync), so fps shows headroom, not the display
rate. *Stutter* counts frames over 50 ms - the ones a player notices as a
hitch. Raw results are in `docs/bench/`. Never measure while a world build
runs: it competes for the CPU.

## Baseline (2026-10-16)

`data/berlin`, before any of the changes below, measured with the world build
paused.

| | street | fly | air |
|---|---|---|---|
| **Desktop** fps (p95 frame) | 148 (12.5 ms) | 117 (15.7 ms) | 70 (24.9 ms) |
| **Desktop** stutter (worst frame) | 0 | 9 (175 ms) | 0 |
| **Phone** fps (p95 frame) | 103 (11.7 ms) | 62 (23.1 ms) | 62 (19.6 ms) |
| **Phone** stutter (worst frame) | 0 | **18 (483 ms)** | 0 |
| Draw calls, desktop / phone | 667 / 301 | 984 / 464 | 1,659 / 709 |
| Triangles, desktop / phone | 7.3 M / 3.9 M | 9.8 M / 6.1 M | 15.3 M / 7.2 M |
| Texture memory | 597 MB* | 784 MB* | 808 MB* |
| Geometry memory | 324 MB | 355 MB | 396 MB |
| JavaScript heap | 452 MB | 697 MB | 689 MB |
| Downloaded in the scene | - | 62 MB in 40 s (desktop), 108 MB (phone) | - |

Start: 0.9 s and 33 MB on desktop, 2.4 s and 35 MB on phone.

\* Lower bound: this run did not count the textures the terrain shader holds
as uniforms (cover masks, 50 cm overview photos). The corrected script counts
them; the baseline will be re-measured with it.

### What a tile weighs

Average over all 1,066 tiles, as stored:

| File | Size | Share | Loaded |
|---|---|---|---|
| `buildings.glb` | 6.95 MB | 40 % | full detail (within ~800 m) |
| `ortho/o_*.jpg` (20 cm photos) | 3.55 MB | 21 % | per 100 m chunk, within ~320 m |
| `nav.bin` | 2.86 MB | 17 % | full detail; half of it repeats the terrain heights |
| `terrain.bin` | 1.91 MB | 11 % | every tile in view, even 2.6 km away, where only every 4th metre is drawn |
| `props.glb` | 1.07 MB | 6 % | full detail |
| `ortho/overview.jpg` (50 cm) | 0.66 MB | 4 % | every tile in view |
| `cover.png` | 0.14 MB | 1 % | every tile in view |
| the rest | 0.05 MB | | |
| **Total** | **17.2 MB** | | a distant tile needs ~2.7 MB of it |

## What stands between the game and a phone

1. **Memory - critical.** About 1.2 GB on the graphics side plus 0.7 GB of
   JavaScript. A browser tab on an iPhone or a mid-range Android phone gets
   about 1-1.5 GB in all, so the game would be closed. The main cause: every
   tile in view keeps its full 50 cm photo (2,000 px square) and 0.5 m cover
   mask (2,400 px square) decoded in memory, even 2.6 km away where a few
   hundred pixels would do; and three.js keeps a CPU copy of every texture
   and mesh after it has gone to the GPU.
2. **Stutter while streaming.** Each tile that comes into full detail is
   built in one go on the main thread - terrain meshes, merged buildings,
   trees, props, the minimap - and its images are decoded there too. On a
   phone-speed CPU that is up to half a second without a frame.
3. **Too many triangles in the distance.** Buildings keep full detail, down
   to modelled windows, as far as 1.1 km away. Phones are comfortable with
   1-3 M triangles, not 7-15 M.
4. **Download.** 1.5-2.5 MB/s while flying, 90-160 MB a minute: a lot on
   mobile data, and it adds up on the Datahub.
5. **Draw calls.** Up to 1,660 from the air; phones want under ~300-500. Most
   of them are terrain: each full-detail tile is drawn as 100 pieces, one per
   100 m photo chunk, so 6-7 tiles make 600-700 calls for the ground alone.

## Changes

### 1. Memory

*Implemented; results below.*

* **Textures at the size each level needs** (`COARSE_*`, `FULL_*` in
  `tile.ts`), decoded straight to that size: distant tiles get the photo at
  2 m and the cover mask at 4 m (their mesh is 4 m), ~1.5 instead of ~50 MB
  per tile for the ~35 tiles of the coarse ring; full detail gets both at
  1 m and drops them again when the tile falls back to coarse.
* **Facade textures are shared between tiles** (`memory.ts`). Every
  `buildings.glb` brings its own copies of the same OSM2World textures -
  20-28 per tile, mostly 1,024 px square, 18 of them identical across three
  tiles checked. One copy each now, counted by the tiles using it.
* **No CPU copies after upload.** Images are decoded with
  `createImageBitmap` and closed once on the GPU; static meshes (terrain,
  merged buildings and furniture, bridge decks) drop their vertex arrays
  likewise.
* **Terrain chunks share one index buffer.** All 100 chunks of a tile are
  the same grid; they had 100 copies of the same 240 KB of indices.
* Next, in the pipeline: GPU-compressed textures (KTX2/Basis), 4-8× smaller
  in graphics memory than decoded JPEGs.

### 2. Stutter

*Implemented; results below.*

* **Tile building is spread over frames** (`frames.ts`): terrain chunks,
  each building and furniture merge, and the trees are built a few
  milliseconds at a time, and the tile stays hidden until it is complete. A
  tile dropped meanwhile is tidied away half-built.
* **Images are decoded off the main thread** (`createImageBitmap`), and big
  textures are sent to the GPU one per frame ahead of use, instead of all in
  the frame where they are first drawn.
* **The minimap is drawn in a Web Worker** (`mapworker.ts`) from the cover
  mask already downloaded - it used to download `cover.png` a second time
  and walk its million pixels on the main thread.

* **Buildings are merged in the pipeline, not in the browser**
  (`pipeline/pack_buildings.py`): see the results.

## Results after 1 and 2 (2026-10-16)

`data/berlin_bridges` with packed buildings, measured with nothing else
running. Raw results: `docs/bench/1-memory-stutter-*.json`.

| | Before | After |
|---|---|---|
| **Texture memory**, material textures (the first baseline's count) | 597-808 MB | **179-216 MB** |
| **Texture memory**, everything incl. terrain masks and photos | not counted (well over 2 GB by the sizes involved) | **422-493 MB** |
| Geometry memory | 324-396 MB | 336-428 MB (the bridges are new) |
| **JavaScript heap** | 452-697 MB | **252-413 MB** |
| **Phone, flying: worst frame** | **483 ms** | **102 ms** |
| Phone, flying: frames over 50 ms | 18 | 13 |
| Desktop, flying: worst frame / frames over 50 ms | 175 ms / 9 | 103 ms / 3 |
| Download at start | 33-35 MB | 29 MB |
| Phone, flying: downloaded in 40 s | 108 MB | 82 MB |
| Frame rate (street, fly, air), desktop | 148 / 117 / 70 | 158 / 123 / 68 |
| Frame rate (street, fly, air), phone | 103 / 62 / 62 | 98 / 67 / 54 |

Draw calls and triangles are unchanged (points 3 and 5). The phone's
"standing" scene now downloads 21 MB while the last tiles of the start come
in - loading is spread out, so it is still going when the measurement begins.

What made the difference, beyond the changes listed above:

* **Distant tiles' textures** (photo at 2 m, cover mask at 4 m), and full-detail
  tiles' cover mask and overview photo at 1 m instead of 0.5 m - close by, the
  20 cm photo chunks carry the detail, and street level and roofs from the air
  look the same.
* **The bridge mask** (from the bridge work the same day) was a full-colour
  canvas at 1 m in every tile with a bridge: 153 MB. One channel at 2 m now.
* **Buildings are packed in the pipeline** (`pipeline/pack_buildings.py`, also
  run by `build_world.py`): one mesh per 275 m chunk and material, written
  tile-relative. The trace showed the longest stalls (150-175 ms on the phone
  profile) were three.js parsing 4,000-6,000 meshes and 17,000 buffer views
  per `buildings.glb` in one go. Packed: ~170 meshes per tile (2.28 M -> 167 k
  over all tiles), nothing to clone or merge in the browser, files ~10 % smaller.

What remains of the stutter: frames of 50-100 ms on the phone profile where
a large texture goes to the GPU, and native browser work. GPU-compressed
textures (KTX2, next for point 1) upload close to a plain copy.

## Research: points 3-5

### 3. Simpler buildings in the distance

*Feasible, ~2-3 days.* Options, best first:

* **Own simple buildings**: the pipeline already has every footprint and its
  height (measured or tagged). Extruded prisms with the photo on the roof and
  a plain facade colour cost a few hundred triangles per block and one draw
  call per tile. Used beyond ~300 m within the full-detail ring, and - new -
  in the 2.6 km coarse ring, which today shows no buildings at all. That
  would make the view from the air look like a city out to the fog.
* **Simplify OSM2World's meshes** with meshoptimizer (`gltfpack -si`): no new
  geometry code, but window geometry simplifies poorly.
* **A second OSM2World run at low detail**: least code, but doubles the
  slowest part of the build.

Client side: per building chunk (275 m), show the detailed or the simple
mesh by distance. Expected: 7-15 M triangles down to ~2-4 M.

### 4. Smaller downloads

*Feasible, ~2 days; a re-pack of existing tiles, not a full rebuild.*

| Change | Saves |
|---|---|
| `nav.bin` without its copy of the terrain heights (the game has them from `terrain.bin`) | ~2 MB per full tile |
| A separate 4 m terrain for distant tiles (126 KB instead of 1.9 MB) | ~1.8 MB per distant tile, ~70 MB for the coarse ring |
| `buildings.glb` and `props.glb` meshopt-compressed (`gltfpack -cc`; the game needs three.js's `MeshoptDecoder`) | typically 3-5×: ~7 MB to ~2 MB |
| Gzip for `.bin`, `.json`, `.glb`, stored pre-compressed on the Datahub with `Content-Encoding: gzip` (MinIO does not compress on the fly) | 20-80 % per file; best on `nav.bin` and JSON |
| Terrain heights delta-encoded before gzip | ~50 % of `terrain.bin` |

Expected: a full tile from 17 MB to ~6-7 MB, a distant one from 2.7 MB to
~0.9 MB; flying from 90-160 MB a minute to ~30-50 MB. KTX2 photos (point 1)
are about as small as JPEGs to download, so they do not change this much.

### 5. Fewer draw calls

*Feasible, ~1-2 days.*

* **Terrain**: only chunks near the player (where 20 cm photos are swapped
  in) stay separate; the rest of a full-detail tile becomes one mesh with
  the 50 cm photo. Saves ~400-500 calls.
* **Buildings**: today one call per chunk and OSM2World material. Merging the
  materials into one with a texture atlas, or vertex colours for the plain
  ones, brings that to 1-2 per chunk.
* The simple distant buildings from point 3 are one call per tile.

Expected: 670-1,660 calls down to ~150-400.
