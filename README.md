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
| `1` `2` `3` `4` `5` | on foot · bike · e-scooter · car · motorboat (on water only, near a river, canal or lake) |
| look up and walk forward | take off; fly into the ground to land · `H` toggles flight |
| `/` | search for an address, Enter to travel there |
| `C` | camera: third person · close · first person |
| `N` | day / night |
| `G` | shadows on / off |
| `T` | labels · `L` data layers · `M` minimap zoom · `X` respawn |
| link | copies a URL pointing at exactly where you are standing |
| `P` | game modes; during a game `P` or `Esc` pauses, with resume, restart and quit |

On a phone or tablet (a coarse pointer) the keyboard help gives way to touch
controls: a virtual joystick on the left half ([nipplejs](https://github.com/yoannmoinet/nipplejs);
push it to the edge to sprint), drag on the right half to look, and buttons
for the menu, camera, vehicle and jump (only those that do something right
now). Shadows start off there, and a phone runs a lower quality tier
(`web/src/quality.ts`; `?quality=low|high` to choose): full detail close by
only, half-size textures and nearer fog, so that the tab stays within what
iOS allows it before reloading. `npm run bench:games` measures each game as
a phone; see `docs/performance.md`.

---

## Building the world

```bash
brew install openjdk          # OSM2World needs Java 17+
uv venv && uv pip install -r pipeline/requirements.txt
.venv/bin/python pipeline/build_world.py
.venv/bin/python pipeline/build_pois.py
.venv/bin/python pipeline/set_spawn.py 52.48475 13.38623 --face "Cafe do Brazil"   # optional
```

`build_world.py` takes `--area E0 N0 E1 N1` (EPSG:25833 metres; the default is
Bergmannkiez and the Kreuzberg, 1.1 × 1.1 km), `--texture-res` (largest
building texture edge, default 1024; OSM2World's own default is 512, its CC0
textures are 2048) and `--refresh` to re-query OSM
and the tree cadastre. OSM2World is downloaded into `tools/` on first run.
Shapely/GEOS handles the offline polygon clipping and triangulation for bridges
and shores; `inflate64` reads the south-east Berlin laser-scan archive. Every
download is cached under `cache/`. Neither dependency runs in the browser.

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

The `inflate64` package is for the laser
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

### Scores

Every finished game is kept in the browser (`web/src/scores.ts`). The 🏆 on
the start screen opens the high scores: a tab per game with today's course on
the shared board, and your own record and games in that mode.

A list ranks each player's best by targets reached - markets, trees, Döner -
with points only between runs that reached as many, since points mix in
combos and golden targets and say little to someone else. Medals (fixed
target counts per mode) stay in the game as milestones and on the result
screen, not on the lists.

The shared board is a Postgres database on the Datahub. It is reached only
through the Datahub's Hasura GraphQL API (`https://backend-api.data-hub.berlin`),
and only by a small API in `api/`, which holds the credentials and does the
checks below; the browser never talks to Hasura or Postgres itself:

| route | |
|---|---|
| `GET /api/runs?mode=&seed=&limit=&name=` | a course's top list (each player's best: targets, then points), and where `name` stands |
| `POST /api/runs` `{ token, name, run }` | keep a finished run; answers with the board |
| `POST /api/player` `{ token, name }` | take a nickname, or change yours |

* **Joining is a nickname, nothing more.** Without one, runs stay in the
  browser. Once a player picks a name, every ranked run goes up, and so does
  today's best in each mode from before. No accounts, no e-mail, no IP
  addresses are stored.
* **A name belongs to one browser.** It holds a random token whose hash the
  server keeps with the name, so nobody else can post under it. Each name
  has its own token, so friends taking turns on one device each keep their
  place: picking another name switches player, it does not rename. Names are
  unique regardless of case. Clearing the browser's storage loses the names.
* **Checks on the server:** names are 2-20 letters, digits, spaces, `- _ .`;
  a run must be plausible for its mode (no more targets than a round allows,
  no more points than those targets can bring); at most 30 writes a minute
  from one address per instance. Anyone can still send a made-up score that
  passes, so for a public launch add a rate limit in Vercel's firewall too.
* **Moderation:** `update berlin_game.players set hidden = true where name_key = lower('…');`
  takes a name off the board.

Setup, once, by whoever holds the Hasura admin secret (the Datahub team):
with `HASURA_ADMIN_SECRET` in `.env` (see `.env.example`),

```bash
npm run db:schema
```

creates the tables (`db/schema.sql`, schema `berlin_game`), has Hasura track
them, links each run to its player, and gives the role `berlin_game` what
the API needs: insert and read players and runs, update a player's name,
never `hidden` or the token hash. Safe to run again. Without the script, the
same can be done by hand in the Hasura console.

The API then signs in as that role: `HASURA_TOKEN`, a JWT for it (Hasura
checks JWTs against the key in its `HASURA_GRAPHQL_JWT_SECRET` but issues
none; with that key as `HASURA_JWT_KEY` in `.env`, `npm run db:token` signs
one and writes it into `.env`), or else `HASURA_ADMIN_SECRET` with `HASURA_ROLE=berlin_game`, which
Hasura holds to the role's permissions but which would open everything if it
leaked. Set them in Vercel's environment variables and, for `npm run dev`,
in `.env`. Where the board can't be reached - no network, no `api/` on a
static host, no credentials - the game falls
back to local storage: each course's list shows the best of each name
played in this browser, a name is kept here until the board can take it,
and runs not yet sent go up the next time one is looked at with the board
back.

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

### Game modes

The start screen offers free roam or one of five timed games, each played on
points from open data:

| mode | goal | data |
|---|---|---|
| 🎅 Weihnachtsmarkt-Sause | fly Santa's sleigh over as many Christmas markets as possible in 90 s | Weihnachtsmärkte 2025 (SenWEB), as curated by ODIS for [weihnachtsmaerkte.odis-berlin.de](https://weihnachtsmaerkte.odis-berlin.de) |
| 🥵 Hitzewelle | survive 90 s of heat: shade under cadastre trees slows it, running speeds it up, fountains, splash pools, cool rooms and bathing spots cool you down | Trinkwasserbrunnen, Zierbrunnen, Kühle Räume, Badestellen (gdi.berlin.de), OSM drinking water, in the spirit of the [Erfrischungskarte](https://erfrischungskarte.odis-berlin.de) |
| 🌱 Gieß den Kiez | 90 s: fill your water bag at street pumps and water young trees; the younger, the thirstier | tree cadastre (trees under 15), OSM street pumps selected as in [Gieß den Kiez](https://www.giessdenkiez.de) |
| 🚻 Klo-Notstand | 5 public toilets in 2 min; a full bladder slows you to a waddle | Öffentliche Toiletten |
| 🥙 Döner-Marathon | as many kebab shops as possible in 60 s; each one is a speed boost and makes you heavier | OSM `cuisine=kebab` |

```bash
python3 pipeline/build_games.py      # writes web/public/data/games/ (needs build_layers.py and the tree cache)
```

* **Courses make scores comparable.** A game's targets are the ones nearest
  its start, so a start has to be fixed for a score to mean anything. A seed
  picks it: one of the mode's anchor points (a toilet, a kebab shop, a pump)
  with enough targets around it, then 250 m off it in a seeded direction.
  Clicking a mode plays today's course (the date is the seed), so everyone
  playing on the same day gets the same start; 🎲 rolls a new course, and 📍
  plays where you stand, unranked. `#play=<mode>:<seed>` in the URL offers a
  course as a challenge, and the result screen copies that link.
* **Points, combos and gold.** Each target is worth 100 points. Reaching the
  next one before the combo bar runs out (10–40 s, by mode) multiplies that,
  up to ×5. About one target in fourteen is golden: triple points and double
  time. Which ones is a hash of where they are, so a course has the same
  golden targets for everyone. Market, Döner and watering runs give seconds
  back per target (fewer as the run goes on); Hitzewelle pays 1,000 points
  for surviving, Klo-Notstand 25 per second to spare.
* **Medals** 🥉 🥈 🥇 mark how far a run got: by targets reached in most
  modes, by time to spare for the toilets, by cool-offs on top of surviving
  for the heat. The panel shows what the next one needs.
* **Best scores are per course** and kept in the browser's local storage, as
  points (`berlin.points.*`; the earlier target counts are not compared). A
  ranked run shows the course record to beat and announces passing it.
* **My high scores** on the start screen: record, today's best, games and
  medals per mode, and the latest games. Every finished game is kept as a
  run in `berlin.runs` (the newest 300), by `web/src/scores.ts`.
* **Pause:** `Esc`, `P` or the ⏸ button pause a game, with resume, restart
  and quit; so does switching tabs or apps.
* **Faster than free roam:** walking and riding run at 1.6× in a game (the
  sleigh at 1.3×, the car as it is), since targets lie hundreds of metres
  apart. Movement is stepped in half metres, so the speed cannot carry you
  through a wall on a slow frame.
* **Distances** hang under every game target's pin, rounded to 5 m close
  up, 10 m further out, then 0.1 km.
* **German first.** The whole interface is German by default, with English
  one click away on the start screen (or `?lang=en`); the choice is
  remembered. Strings live in `web/src/i18n.ts`; names from the datasets stay
  as published.
* **Needs the tiled build.** The committed Kreuzberg area is too small for a
  fair start in most modes; there the game says so and plays unranked where
  you stand.

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

### Bridges and riverbanks

Bridges are separate, open spans. Their footprints come from
[ALKIS Berlin](https://gdi.berlin.de/services/wfs/alkis) and OSM
`man_made=bridge` polygons; their ways, structure/material tags and surface
types come from OpenStreetMap. Heights come from Berlin's airborne laser scan.

* **One surface per physical span and level.** `bridgefit.py` fits the road
  and its separately mapped pavements before terrain, furniture or tile
  clipping. `bridge_surfaces.py` unions complete surveyed polygons with their
  approaches and performs constrained triangulation. Concave outlines and
  genuine polygon holes survive. An elevated railway keeps its own footprint
  and height even when its local OSM `layer` number matches the road below.
  Ways are joined into one deck only where they carry straight on: two
  carriageways meeting end to end (Lutherbrücke) stay two decks rather than
  one folded back over itself.
* **Measured approaches.** The fit uses returns near the deck level and
  ground at its ends, rejecting roofs, trusses and overhead tracks. Each
  segment's grade is constrained; transverse footpaths do not set the span's
  height. Beneath elevated lines, approaches continue to surveyed ground at
  the road's level. The entire end face joins the street, across its width.
  Station halls and platform roofs hide the deck under them, so their returns
  are ignored - except a hall mapped under 9 m on a lower layer than the
  deck, which is the deck's own structure: OSM draws the U1 viaduct as
  `building=roof`, `layer=1`, `min_height=6` under its tracks, and before
  Warschauer Straße as a 6 m building carrying them.
* **Matching rendering and movement.** `bridges.json` carries the actual
  top triangles and perimeter, clipped at tile boundaries. `Decks.at` samples
  those triangles, including bends. Tops face upward, undersides downward;
  slab sides are emitted only around the perimeter. Older centreline-strip
  files remain readable. A tile cut is neither a side wall nor a movement
  barrier, and nor is a seam where another deck of the same kind carries on
  at the same level. On foot you keep 0.15 m off a deck's edge, by car 1 m,
  so footbridges from 1.1 m wide are walkable (Ernststeg is 1.6 m). The third-person camera sweeps its whole boom against decks,
  piers and canopies, then eases back out after clearing an obstruction.
* **Ground and objects agree.** Deck returns are removed before terrain hole
  filling. River beds remain below the water, with proper ground contact at
  approaches. Surface rebuilds also rebuild navigation and reposition trees
  and surveyed furniture; road decks count toward vehicle clearance.
* **Surface detail.** Bridge tops reuse Berlin's orthophotos, including the
  already-streamed 20 cm image near the player. Under an upper deck, the
  lower road uses asphalt/paving rather than a photograph of the tracks above.
  Material tags tint the structure; lightweight railings follow exposed
  side edges, with entrances kept open. Untagged railing dimensions are
  visual estimates. Geometry is retained when texture detail changes.
* **Vector shorelines.** `shorelines.py` replaces only the terrain cells
  touching mapped water boundaries. Land and water triangles follow those
  polygons exactly, including islands. Steep surveyed banks receive continuous
  quay faces; low natural banks slope to the water. The replacement top
  triangles are also the player's ground-height field. Canal walls no longer
  inherit the saw-tooth boundary of the 1 m terrain raster.
* **One level per reach.** `hydrography.py` fits every connected water body
  in OSM against the whole city's laser scan, split at mapped weirs and lock
  gates, and takes the dominant return band as its level (the lower Spree
  30.75 m, the upper Spree and Dahme 32.35 m). Tiles take the reach's level,
  so a river is one flat surface across 48 m blocks and tile edges; only
  water outside a measured reach, such as a lock chamber, keeps the per-block
  level. Behind a quay wall the ground never dips below the wall's top.
  A body with fewer than 400 samples takes the low fifth of its returns
  instead, since on a small basin the dominant band can be its paved edges.
  Where two levels meet - a weir, a lock gate, the Mühlendamm - a face of
  falling water closes the step, so there is no gap to see the sky through.
* **Retaining walls.** OSM maps few, so `retaining.py` finds them in the
  scan: neighbouring cells 1.2 m or more apart, away from water, decks and
  buildings. The upper side is outlined and simplified, so a wall at an
  angle to the 1 m grid becomes the straight line it is rather than a
  staircase. The 4 m terrain cells it runs through are cut along it, each
  side at its own level with a stone face between, and added to
  `shorelines.json`; the ground beside it takes its side's level.
* **Water joins at tile edges.** `stitch_water.py` welds small survey-level
  disagreements at shared edge vertices. Interior measurements are retained,
  larger steps remain intact, and original heights make the pass repeatable
  after a partial rebuild.

For an existing tile build:

```bash
# Rebuild surface data using cached surveys and OSM, then serve that build.
BERLIN_OUT=data/berlin_refined .venv/bin/python pipeline/build_berlin.py \
  --surfaces-only --tiles 390_5817 391_5817 394_5816 --workers 3
BERLIN_DIR=berlin_refined npm run dev -- --host 127.0.0.1

npm run test:bridges
npm run check:crossings                  # actual Player/World probes, both directions
.venv/bin/python -m unittest discover -s pipeline -p 'test_*.py'
node scripts/check.ts --dir data/berlin_refined
node scripts/views.ts --url http://127.0.0.1:5173/ \
  --only mehring,mehring-under,hallesches-tor,zossener,wildenbruch,oberbaum
```

`--surfaces-only` requires existing tile manifests; `--water-only` remains an
alias. Build without that flag for a new output directory. Tile versions in
`world.json` change after rebuilding, so browsers fetch the new surface files.
The checks exercise the game's triangle readers and movement probes, and the
fixed views include the road underneath Mehringbrücke's elevated U-Bahn.
The dev server prefers `data/berlin_refined` when that build exists;
`BERLIN_DIR` explicitly selects another build. Decorative floodlights and
wall-mounted fixtures in the lighting register are not rendered as streetlamp
masts. Furniture falling into mapped water is aligned to a supporting surface
within 2 m; placements with no such support are omitted. These adjustments are
counted in the tile's props metadata. Original source records remain in the cache.

Buildings OSM puts underground (`location=underground`, or a negative
`layer` without `location=surface`) are left out: shops in U-Bahn stations
and underground car parks would otherwise stand on the street above.
Structures mapped as buildings that have no storeys - the stelae of the
Memorial to the Murdered Jews of Europe (`man_made=stele`), chimneys, silos -
get no estimated `building:levels`, so OSM2World draws them without windows.

### Where you can go

`nav.bin` is a 1 m grid: walkable means not inside a building footprint (from
OSM), not a tree trunk, not water, and not too steep on the laser-scan terrain.
OSM ways tagged `tunnel=building_passage` are cut back out of the footprints,
so the archways into Berlin courtyards stay open. Driving uses the walkable
mask eroded by 2 m.

The spawn is a pavement beside a street, in the largest connected region, with
open sky around it — or the spot pinned with `set_spawn.py`, which survives
rebuilds as long as it is still walkable.

Everywhere else the game puts you down - an address, a shared link, a game's
start, a change of vehicle - it looks for ground that leads somewhere: the
nearest walkable cell is flood-filled, and only taken if its region reaches
160 m away (or the edge of what is loaded). The pipeline keeps every region
over 400 m², so the nearest ground to an address point inside a block is
often a walled-in Hinterhof; such regions are skipped and the search moves
outward to the street.

### Rendering

Everything in the city uses three's standard PBR material, so buildings,
terrain and trees share one sun, one set of shadows (a 4096² map that follows
the player), fog and ACES tone mapping. The terrain and trees extend the
standard material through `onBeforeCompile` rather than being raw shaders,
which is what lets them receive shadows. At night the window layer glows,
one window at a time: a hash per window decides which are lit, and in what
light.

The haze and the sky are one model (`web/src/atmosphere.ts`, which replaces
three's fog chunks): a fogged roof fades into exactly the sky behind it,
warmer towards the sun, and the haze thins above eye level so the skyline
stands out of the streets. The water mirrors the same sky, by Fresnel.

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
* **Game modes:** Weihnachtsmärkte (SenWEB, curated by ODIS), CC BY;
  Trinkwasserbrunnen, Zierbrunnen, Kühle Räume, Öffentliche Toiletten,
  `dl-de/zero-2.0`; Badestellen (LAGeSo / Geoportal Berlin), CC BY 4.0;
  kebab shops, street pumps and drinking water © OpenStreetMap contributors, ODbL.
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
