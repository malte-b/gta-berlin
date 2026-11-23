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

The client is TypeScript on three.js. The city's tiles and 3D objects are
not in this repository: the game streams them from object storage at
`VITE_TILE_BASE`. What only this game
uses - street names and places, data layers, game targets - is built here
(`pipeline/`) and committed under `web/public/data/` (see *The world* below).

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

## The world

The city is hosted as tiles: terrain, buildings, trees, street furniture,
water and bridges, in 1 × 1 km tiles for all of Berlin. The game reads them from
the bucket `VITE_TILE_BASE` names (in `.env` for the dev server and local
builds, and in Vercel's environment variables).

The game's own data is built by the scripts in `pipeline/` (Python, standard
library only) into `web/public/data/`, and committed:

```bash
python3 pipeline/build_layers.py     # layers/
python3 pipeline/build_games.py      # games/
```

Downloads are cached in `cache/`; `--refresh` fetches again.

### Scores

Every finished game is kept in the browser (`web/src/scores.ts`). The 🏆 on
the start screen opens the high scores: a tab per game with today's course on
the shared board, and your own record and games in that mode.

A list ranks each player's best by targets reached - trees, Döner, toilets -
with points only between runs that reached as many, since points mix in
combos and golden targets and say little to someone else. Medals (fixed
target counts per mode) stay in the game as milestones and on the result
screen, not on the lists.

The shared board is a Postgres database on Supabase. It is reached only by a
small API in `api/`, which holds the credentials and does the checks below;
the browser never talks to the database itself:

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

Setup, once: put the transaction pooler string from Supabase's dashboard
("Connect") in `.env` as `DATABASE_URL`, as it is, and the database password
as `DATABASE_PASSWORD` (see `.env.example`), then

```bash
npm run db:schema
```

creates the tables (`db/schema.sql`, schema `berlin_game`). Safe to run
again. Use the pooler, not the direct `db.<ref>.supabase.co` host: that one
has only an IPv6 address, which Vercel and many networks can't reach. The
connection checks Supabase's certificate against its root CA, which is in
`api/_pg.ts`. Supabase's public APIs (`anon`, `authenticated`) have no access
to the schema; only `api/` reaches it.

Set the same two variables in Vercel's environment variables; `npm run dev`
reads them from `.env`. Where the board can't be reached - no network, no `api/` on a
static host, no credentials - the game falls
back to local storage: each course's list shows the best of each name
played in this browser, a name is kept here until the board can take it,
and runs not yet sent go up the next time one is looked at with the board
back.

### Data layers

Other datasets appear in the city as labelled pins. `L` opens the panel, where
each layer can be switched on and off.

Baked by `pipeline/build_layers.py`, from the list in `pipeline/layers.json`.

* **Baked from Berlin's geodata services.** Most open datasets on
  [daten.berlin.de](https://daten.berlin.de) are also published as a WFS on
  gdi.berlin.de. An entry in `pipeline/layers.json` names the service, the
  feature type and which properties make the label and the second line.
  `build_layers.py` fetches the whole city, takes the licence from the service's
  own capabilities, and writes `web/public/data/layers/`, shared by the
  Kreuzberg build and all of Berlin. Public toilets and schools
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

The start screen offers free roam or one of four timed games, each played on
points from open data:

| mode | goal | data |
|---|---|---|
| 🥵 Hitzewelle | survive 90 s of heat: shade under cadastre trees slows it, running speeds it up, fountains, splash pools, cool rooms and bathing spots cool you down | Trinkwasserbrunnen, Zierbrunnen, Kühle Räume, Badestellen (gdi.berlin.de), OSM drinking water, in the spirit of the [Erfrischungskarte](https://erfrischungskarte.odis-berlin.de) |
| 🌱 Gieß den Kiez | 90 s: fill your water bag at street pumps and water young trees; the younger, the thirstier | tree cadastre (trees under 15), OSM street pumps selected as in [Gieß den Kiez](https://www.giessdenkiez.de) |
| 🚻 Klo-Notstand | 5 public toilets in 2 min; a full bladder slows you to a waddle | Öffentliche Toiletten |
| 🥙 Döner-Marathon | as many kebab shops as possible in 60 s; each one is a speed boost and makes you heavier | OSM `cuisine=kebab` |

The points are baked by `pipeline/build_games.py` into
`web/public/data/games/`.

* **Courses make scores comparable.** A game's targets are the ones nearest
  its start, so a start has to be fixed for a score to mean anything. A seed
  picks it: one of the mode's anchor points (a toilet, a kebab shop, a pump)
  with enough targets around it, then 250 m off it in a seeded direction.
  Clicking a mode plays today's course (the date is the seed), so everyone
  playing on the same day gets the same start. That is the only start the
  menu offers, to keep the choice simple. `#play=<mode>:<seed>` in the URL offers a
  course as a challenge, and the result screen copies that link.
* **Points, combos and gold.** Each target is worth 100 points. Reaching the
  next one before the combo bar runs out (10–40 s, by mode) multiplies that,
  up to ×5. About one target in fourteen is golden: triple points and double
  time. Which ones is a hash of where they are, so a course has the same
  golden targets for everyone. Döner and watering runs give seconds
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
  car as it is), since targets lie hundreds of metres
  apart. Movement is stepped in half metres, so the speed cannot carry you
  through a wall on a slow frame.
* **Distances** hang under every game target's pin, rounded to 5 m close
  up, 10 m further out, then 0.1 km.
* **German first.** The whole interface is German by default, with English
  one click away on the start screen (or `?lang=en`); the choice is
  remembered. Strings live in `web/src/i18n.ts`; names from the datasets stay
  as published.

---

## How it works

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
* **Game modes:** Trinkwasserbrunnen, Zierbrunnen, Kühle Räume, Öffentliche Toiletten,
  `dl-de/zero-2.0`; Badestellen (LAGeSo / Geoportal Berlin), CC BY 4.0;
  kebab shops, street pumps and drinking water © OpenStreetMap contributors, ODbL.
* **Orthophotos:** TrueDOP 2024 (DOP20RGBI) — Senatsverwaltung für
  Stadtentwicklung, Bauen und Wohnen Berlin, `dl-de/zero-2.0`.
* **Buildings, streets, green space, places:** © OpenStreetMap contributors,
  ODbL. 3D models generated with OSM2World (LGPL); textures from its standard
  style (CC0, ambientCG).

---

## Street names and places

Street names and places come with the tile base: each tile's `pois.json`,
queried from Overpass **once** per tile when the tiles are built and projected
into world metres. The running game only ever reads those files, so playing
puts no load on the API.

Street names are painted onto the road surface and turned to the local
bearing; places get a billboard label on a stem. Both mount only within a
radius of the camera, and label textures are cached by string.

The *refresh* category (benches, drinking fountains, toilets, shade) mirrors
what the [Berliner Erfrischungskarte](https://erfrischungskarte.odis-berlin.de/)
surfaces.

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
