# Berlin — The Game

DISCLAIMER: THIS APP WAS PURELY VIBECODED

A drivable, walkable 3D Berlin in the browser, built entirely from the city's
own open geodata. Inspired by [sf.thijs.gg](https://sf.thijs.gg/) — but where
that project renders Apple Maps data, this one runs on data Berlin publishes
for anyone to use.

```bash
npm install
npm run dev          # http://localhost:5173
```

The repo ships without the heavy files. See **Building the world** below.

---

## Controls

| | |
|---|---|
| `W A S D` | move · `Shift` sprint · `Space` jump |
| `F` | car · `B` bike · `V` e-scooter |
| `H` | free flight (`Shift` boost, `Space` / `Ctrl` up-down) |
| `/` | search for an address, Enter to travel there |
| `C` | camera: third person · close · first person |
| `N` | day / night |
| `G` | texture detail: near-field only ↔ every tile |
| `M` | minimap zoom · `R` respawn |
| link | copies a URL pointing at exactly where you are standing |
| mouse | look (click the canvas to capture the pointer) |

---

## The data

The game renders the **3D-Meshmodell Berlin** — a photogrammetric mesh derived
from the June 2025 aerial survey, published as open data by the
Senatsverwaltung für Wirtschaft, Energie und Betriebe via the
[Berlin 3D download portal](https://www.businesslocationcenter.de/en/economic-atlas/download-portal/).

It is a single continuous skin: ground, buildings, bridges and trees are all
one surface, with photography baked into the texture. Each downloaded tile is
a folder holding a Wavefront OBJ and up to seven JPEG atlas pages.

Currently loaded: **9 tiles, ~1.1 × 1.1 km over Kreuzberg** (Bergmannkiez,
centred on 52.4853 N, 13.3853 E), **3,013,055 triangles**.

Two properties of the files make the whole pipeline simple:

* vertices are absolute **EPSG:25833** (ETRS89 / UTM 33N) in metres, which is
  already a metric grid — so the game world is a plain translation of it, with
  no reprojection anywhere;
* faces arrive pre-sorted by `usemtl`, so each atlas page becomes one
  contiguous draw range and no per-vertex material id is needed.

The world origin is the Brandenburger Tor, so in-game `x` / `z` are just metres
from there.

### Also in the repo, not currently used by the game

`pipeline/build.py` builds a much larger world (6 × 5 km of central Berlin,
26,705 buildings) from **LoD2 CityGML** plus OpenStreetMap. It is untextured
but covers far more ground, and it downloads directly from
`https://gdi.berlin.de/data/a_lod2/atom/` with no portal in the way. Kept
because the two are complementary: the mesh looks real, the LoD2 world is
large. Both are `dl-de/zero-2.0`.

The airborne laser scan (ALS point cloud) is **not** used. LoD2 and the mesh
already carry the geometry, and it is very large — nothing here downloads it.

---

## Building the world

Download tile folders from the portal into `data/`, one folder per tile, then:

```bash
python3 pipeline/build_mesh.py
```

Flags: `--hi 8192 --lo 2048` to keep full detail, `--skip-textures` for
geometry only. The pipeline is **pure standard-library Python** — no numpy, no
pyproj, no GDAL. Texture resizing uses `sips`, which ships with macOS.

Output lands in `web/public/data/`:

| file | what |
|---|---|
| `m_<tile>.bin` | geometry, `BTM1` |
| `h_<tile>.bin` | heightfield, `BTH1` |
| `t_<tile>_<page>_{hi,lo}.jpg` | atlas pages at two levels |
| `mesh_manifest.json` | tile index, bounds, attribution |

---

## How it works

### Geometry: 10 bytes per vertex

Positions are quantised to unsigned shorts against each tile's bounding box
and expanded in the vertex shader from a `qmin` / `qscale` uniform pair — 5.8 mm
precision over a 380 m tile. UVs are unsigned shorts too, but flagged
`normalized`, so the GPU hands the shader a plain 0..1 float for free.

Normals are not stored at all. The mesh has none, and the fragment shader
reconstructs exact flat normals from screen-space derivatives, which costs
nothing in the vertex buffer.

### Textures: the memory problem

A full atlas page is 8192 × 8192. Expanded to RGBA with mipmaps that is roughly
340 MB on the GPU, and there are nine tiles. Holding them all at full size is
not an option in a browser.

So every page is written at two levels. Every tile loads its small atlas
immediately, and only the handful nearest the camera are upgraded — including,
always, the tile the player is standing in. Tiles that drop out release their
large textures. `G` switches between near-field-only and everything.

### Where you can go

The first attempt tested movement against the mesh surface directly, comparing
the height ahead with the height underfoot. That produced invisible walls all
over open pavement, and measuring showed why: **19.4% of all cells** have a
neighbour step above a walkable threshold. Only 8% of those are real walls. The
rest are parked cars, kiosks, bollards, tree canopies and photogrammetric noise
— because a surface model makes no distinction between the ground and the
things standing on it.

`pipeline/build_nav.py` separates the two with a grey-scale morphological
opening. An opening erases any raised feature narrower than its structuring
element and leaves wider ones untouched, so at a 21 m element cars and trees
vanish while building blocks survive. What remains is terrain; what was removed
is what blocks you.

The resulting mask is cleaned up, flood filled, and reported:

```
walkable  751,606 cells, 28 regions, largest 93.5% (70.3 ha)
drivable  571,317 cells, 315 regions, largest 91.3% (52.2 ha)
```

The same pipeline also picks where you start. "Nearest walkable cell" is a bad
default — courtyards and lightwells are walkable but enclosed, so you can spawn
boxed in behind a building with nowhere to go. The spawn is instead chosen as
ground that is walkable but *not* drivable (which is what a pavement is), one
to six metres from a street, in the largest connected region, and with seven
metres of open sky around it. That last condition matters more than it sounds:
photogrammetry drapes over tree canopies rather than seeing through them, so
without it you start in a spot that is technically clear while the camera sits
inside a tree. Only 27% of walkable ground passes it.

Cars are tested against the walkable mask eroded by 2 m, since they need more
room than a person. That erosion is also a trap: the spawn point is walkable but
sits inside the margin, so getting into a car used to strand you in a single
square metre. Changing mode now snaps to ground the new mode can actually use.

### Walking on a continuous mesh

There are no separate building volumes to collide with, so the pipeline
rasterises the surface into a 1 m heightfield storing the **lowest** and
**highest** point in each cell. That single structure does three jobs:

* **ground** — what you stand on, sampled bilinearly so there is no stepping;
* **collision** — a move is blocked when the surface ahead rises more than
  0.7 m, which lets you climb kerbs and stairs but not walls;
* **the minimap** — drawn straight from the heightfield, so it always agrees
  with where you can actually go.

Spawning needed one more trick. Aerial photogrammetry drapes over tree canopies
rather than seeing through them, so "lowest point nearby" reliably lands you
inside a tree. The spawn search instead scores candidates on how far the ground
stays flat and unobstructed around them — which is exactly what distinguishes a
street from a courtyard.

### Two flips make a right

OBJ texture coordinates use a bottom-left origin, and three's `TextureLoader`
uploads with `flipY` set, which already accounts for that. Flipping V a second
time in the pipeline left the geometry perfectly correct while every atlas
patch sampled from its mirror — the city rendered as a coherent shape covered
in incoherent photography. Worth knowing about if you ever wire up an OBJ
atlas by hand: verify the *texture*, not just the vertices.

### The character

`character.js` builds the figure, bike and scooter from primitives and animates
them by driving joint rotations — no skinned glTF, so the page still downloads
no external assets. The walk cycle is keyed to **distance travelled** rather
than to elapsed time, which is what keeps the feet planted instead of skating
when speed changes.

### Rendering

The survey already baked sun, sky and shadow into the texture, so relighting it
properly would double up. The photo is used almost as-is, with the
reconstructed normal adding only a slight lift.

Colour management is manual throughout: three re-encodes the framebuffer to
sRGB on output but does not inject its tone mapping or colour conversion into
raw `ShaderMaterial`s. So the shaders linearise their own inputs and apply ACES
themselves — without that, everything comes out milky.

---

## Known limitations

* **Street level is softer than the air.** The survey photographs the city from
  above, so facades and street canyons are the least-sampled part of the model.
  Flyovers look photographic; eye level is noticeably blurrier. That one is the
  data, not the renderer.
* **Foliage is rough.** Photogrammetry cannot see through canopies, so trees
  reconstruct as blobs and there is no ground beneath them — which is why the
  spawn search scores openness instead of just picking the lowest point.
* The covered area is only what has been downloaded — walk far enough and you
  reach the edge.
* Driving is arcade-simple: no suspension, no proper collision response.

## Attribution

* **3D-Meshmodell Berlin**, Befliegung 2025 — Senatsverwaltung für Wirtschaft,
  Energie und Betriebe / Business Location Center. Open Data.
* LoD2 building models (optional pipeline) — Geoportal Berlin,
  `dl-de/zero-2.0`.
* OpenStreetMap contributors, ODbL (optional pipeline).

---

## Street names and places

`pipeline/build_pois.py` queries Overpass **once**, at build time, projects
everything into world metres and writes `web/public/data/pois.json`. The
running game only ever reads that file, so playing puts no load on the API.

```
115 named streets (150 label positions)
555 points of interest: culture 78, food 100, green 3,
                        refresh 182, shop 159, transit 33
```

Street names are painted flat onto the road surface and turned to the local
bearing; places get a billboard label on a stem. Both mount only within a
radius of the camera, and label textures are cached by string — with roughly
115 distinct street names in the covered area the cache converges almost
immediately.

`P` toggles places, `L` street names, `1`–`6` the individual categories. The
*refresh* category (benches, drinking fountains, toilets, shade) mirrors what
the [Berliner Erfrischungskarte](https://erfrischungskarte.odis-berlin.de/)
surfaces. Re-run with `--refresh` to re-query Overpass.

## Performance

Measured on the nine Kreuzberg tiles, all resident:

| | |
|---|---|
| frame rate | 70–500 fps depending on altitude |
| draw calls | 49–81 |
| triangles drawn | 1.0–2.1 M of 3.0 M (frustum culled) |

Rendering is not the constraint. **Loading is**: about 178 MB, dominated by
geometry (86 MB) and the full-resolution atlases (76 MB).

Where the remaining wins are, roughly in order of value:

1. **Serve compressed.** The dev server sends everything uncompressed. Geometry
   gzips 1.35x and the nav grid 16x — worth switching on in production, and
   free.
2. **Compress geometry properly.** 10 bytes/vertex raw is already lean, but
   Draco or meshopt typically manage 5–10x on this kind of mesh. This is the
   single biggest lever.
3. **Transcode the atlases.** JPEG has to be decoded and expanded to RGBA;
   KTX2/Basis would cut both download and GPU memory several-fold. Needs
   `toktx` or `basisu`, which are not installed here.
4. **Drop the per-tile heightfields.** 5 MB that `nav.bin` now supersedes for
   everything except a fallback path.
