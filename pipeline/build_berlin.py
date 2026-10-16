#!/usr/bin/env python3
"""Build all of Berlin as 1 x 1 km tiles the game streams in as you move.

Every tile is a complete world of its own, built by build_world.build() with
a 100 m margin so neighbours agree along their edges. The tiles are the laser
scan's own km grid, 1,066 of them, which is exactly the area Berlin surveys.

    python3 pipeline/build_berlin.py                      # everything
    python3 pipeline/build_berlin.py --radius 2           # only within 2 km of the spawn
    python3 pipeline/build_berlin.py --near 52.52 13.40 --radius 1
    python3 pipeline/build_berlin.py --workers 6
    python3 pipeline/build_berlin.py --osm-refresh        # today's OSM, changed tiles only

Tiles are built nearest the spawn first, and world.json is rewritten after
each one, so the game can be played while the build is still running: it
only streams in what exists. A finished tile is skipped on the next run
(--rebuild redoes it), so an interrupted build just carries on where it was.

Output goes to data/berlin/ (git-ignored; the dev server serves it as
/data/berlin/): roughly 10-20 GB.
At full detail the whole city takes the better part of two days, most of it
streaming ~250 GB of laser scan (1 min per km) and ~110,000 orthophoto tiles.
Logs per tile are in cache/berlin_logs/.
"""
import argparse
import functools
import multiprocessing as mp
import contextlib
import json
import math
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import als                                                       # noqa: E402
import build_pois                                                # noqa: E402
import build_world as bw                                         # noqa: E402
import osmlocal                                                  # noqa: E402
import street_furniture                                          # noqa: E402
from geo import ORIGIN_E, ORIGIN_H, ORIGIN_N, utm33, utm33_inv   # noqa: E402

ROOT = bw.ROOT
# not under web/public: every vite build would copy it into dist/. BERLIN_OUT
# builds elsewhere, e.g. a new version next to the one being served
OUT = os.environ.get("BERLIN_OUT") or os.path.join(ROOT, "data", "berlin")
LOGS = os.path.join(bw.CACHE, "berlin_logs")
# tiles whose OSM data changed but which are not rebuilt yet, so that an
# interrupted --osm-refresh still rebuilds them on the next run
PENDING = os.path.join(bw.CACHE, "osm", "pending_tiles.json")
TILE = 1000
MARGIN = 100


def log(m):
    print(m, flush=True)


def tile_dir(key):
    return os.path.join(OUT, "tiles", key)


def tile_area(key):
    te, tn = (int(v) for v in key.split("_"))
    return te * TILE, tn * TILE, (te + 1) * TILE, (tn + 1) * TILE


def osm_caches(keys, refresh=False):
    """Answer every OSM question the tiles will ask from the Berlin extract,
    as the cache files the loaders look for, so none of them goes to Overpass.

    With refresh, a fresh extract is fetched and every tile's answers are
    regenerated; only files whose content changed are rewritten. Returns the
    tiles whose OSM data changed."""
    def write(path, text):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + ".part", "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(path + ".part", path)

    def update(path, text):
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                if fh.read() == text:
                    return False
        write(path, text)
        return True

    osm = os.path.join(bw.CACHE, "osm")
    jobs = []
    for key in keys:
        e0, n0, e1, n1 = tile_area(key)
        box = bw.ll_box(e0 - MARGIN, n0 - MARGIN, e1 + MARGIN, n1 + MARGIN)
        tile_box = bw.ll_box(e0, n0, e1, n1)
        paths = {
            "buildings": os.path.join(osm, "buildings_%.5f_%.5f_%.5f_%.5f.osm" % box),
            "ground": os.path.join(osm, "ground_%.5f_%.5f_%.5f_%.5f.json" % box),
            "bridges": os.path.join(osm, "bridges_%.5f_%.5f_%.5f_%.5f.json" % box),
            "pois": os.path.join(bw.CACHE, "pois", "pois_%s.json" % key),
            "furniture": os.path.join(bw.CACHE, "furniture",
                                      "furniture_%d_%d_%d_%d.json" % (e0, n0, e1, n1)),
        }
        furn = json.load(open(paths["furniture"])) if os.path.exists(paths["furniture"]) else {}
        if (not refresh
                and all(os.path.exists(paths[k]) for k in ("buildings", "ground", "bridges", "pois"))
                and street_furniture.BENCHES in furn):
            continue
        jobs.append((key, box, tile_box, paths, furn))
    if not jobs:
        return set()
    log("OpenStreetMap for %d tiles from the Geofabrik Berlin extract ..." % len(jobs))
    # Geofabrik publishes the extract once a day; under 20 h old is today's
    max_age = 20 / 24 if refresh else 7
    idx = osmlocal.OsmIndex(osmlocal.download(os.path.join(bw.CACHE, "osm"), max_age))
    changed = set()
    for key, box, tile_box, paths, furn in jobs:
        answers = {
            "buildings": lambda: idx.buildings_osm(box),
            "ground": lambda: json.dumps(idx.ground_json(box)),
            "bridges": lambda: json.dumps(idx.bridges_json(box)),
            "pois": lambda: json.dumps(idx.pois_json(tile_box)),
        }
        for k, answer in answers.items():
            if refresh or not os.path.exists(paths[k]):
                if update(paths[k], answer()):
                    changed.add(key)
        if refresh or street_furniture.BENCHES not in furn:
            benches = idx.benches(tile_box)
            if furn.get(street_furniture.BENCHES) != benches:
                furn[street_furniture.BENCHES] = benches
                write(paths["furniture"], json.dumps(furn))
                changed.add(key)
    log("  done, %d tiles changed" % len(changed))
    return changed


def build_tile(key, args):
    """Build one tile in a worker process. Returns (key, seconds, error)."""
    area = tile_area(key)
    out = tile_dir(key)
    os.makedirs(LOGS, exist_ok=True)
    t0 = time.time()
    with open(os.path.join(LOGS, key + ".log"), "w") as fh, contextlib.redirect_stdout(fh):
        try:
            manifest, _nav = bw.build(area, out, args, margin=MARGIN)
            pois = build_pois.build(
                manifest["origin"], manifest["world"],
                os.path.join(bw.CACHE, "pois", "pois_%s.json" % key), args.refresh, margin=0)
            with open(os.path.join(out, "pois.json"), "w") as pf:
                json.dump(pois, pf, separators=(",", ":"))
            manifest["pois"] = "pois.json"
            # written last: its presence marks the tile as done
            with open(os.path.join(out, "tile.json.part"), "w") as mf:
                json.dump(manifest, mf, indent=1)
            os.replace(os.path.join(out, "tile.json.part"), os.path.join(out, "tile.json"))
        except Exception:                                    # noqa: BLE001
            traceback.print_exc(file=sys.stdout)
            return key, time.time() - t0, traceback.format_exc().strip().splitlines()[-1]
    return key, time.time() - t0, None


def write_index(env, ground_tex, spawn):
    """world.json over every finished tile."""
    tiles = {}
    tdir = os.path.join(OUT, "tiles")
    for key in sorted(os.listdir(tdir)) if os.path.isdir(tdir) else []:
        path = os.path.join(tdir, key, "tile.json")
        if not os.path.exists(path):
            continue
        m = json.load(open(path))
        # tile.json is written last, so its time changes with every rebuild;
        # the game appends it to the tile's URLs, which outdates cached copies
        tiles[key] = {"dir": "tiles/%s/" % key, "world": m["world"],
                      "v": format(int(os.stat(path).st_mtime), "x")}
    if not tiles:
        return 0
    ws = [t["world"] for t in tiles.values()]
    world = [min(w[0] for w in ws), min(w[1] for w in ws), min(w[2] for w in ws),
             max(w[3] for w in ws), max(w[4] for w in ws), max(w[5] for w in ws)]
    cx, cz = (world[0] + world[3]) / 2, (world[2] + world[5]) / 2
    lon, lat = utm33_inv(cx + ORIGIN_E, -cz + ORIGIN_N)
    index = {
        "kind": "tiles",
        "origin": {"e": ORIGIN_E, "n": ORIGIN_N, "h": ORIGIN_H},
        "tile": TILE,
        "tiles": tiles,
        "world": world,
        "centre": {"x": cx, "z": cz, "lon": round(lon, 6), "lat": round(lat, 6)},
        "groundTextures": {k: {"color": "ground/%s_color.jpg" % k,
                               "normal": "ground/%s_normal.jpg" % k} for k in ground_tex},
        "environment": env,
        "attribution": bw.ATTRIBUTION,
    }
    if spawn:
        index["spawn"] = spawn
    path = os.path.join(OUT, "world.json")
    # per process: sync_tiles.py may rewrite it while a build is running
    part = "%s.%d.part" % (path, os.getpid())
    with open(part, "w") as fh:
        json.dump(index, fh, indent=1)
    os.replace(part, path)
    return len(tiles)


def save_pending(keys):
    os.makedirs(os.path.dirname(PENDING), exist_ok=True)
    with open(PENDING + ".part", "w") as fh:
        json.dump(sorted(keys), fh)
    os.replace(PENDING + ".part", PENDING)


def reindex():
    """Rewrite world.json from the finished tiles, keeping its shared assets."""
    old = json.load(open(os.path.join(OUT, "world.json")))
    return write_index(old.get("environment"), list(old["groundTextures"]), old.get("spawn"))


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--near", nargs=2, type=float, metavar=("LAT", "LON"),
                    help="centre of the build order and of --radius (default: the spawn)")
    ap.add_argument("--radius", type=float, help="only tiles within this many km")
    ap.add_argument("--tiles", nargs="+", metavar="E_N", help="only these tiles, e.g. 390_5816")
    ap.add_argument("--workers", type=int, default=4,
                    help="tiles built at once; each needs up to ~10 GB of memory")
    ap.add_argument("--rebuild", action="store_true", help="rebuild finished tiles too")
    ap.add_argument("--osm-refresh", action="store_true",
                    help="fetch today's OSM extract and rebuild the tiles whose OSM data changed")
    ap.add_argument("--index", action="store_true",
                    help="only rewrite world.json from the tiles already built")
    bw.add_args(ap)
    args = ap.parse_args()
    if args.index:
        log("world.json: %d tiles" % reindex())
        return 0
    if args.refresh:
        # it would send every tile's OSM questions to Overpass after all
        ap.error("--refresh is for build_world.py; here OSM comes from the weekly "
                 "refreshed extract - use --osm-refresh to fetch today's")

    # the spawn and build centre: the single-area build's pinned spawn
    spawn = None
    small = os.path.join(bw.OUT, "world.json")
    if os.path.exists(small):
        spawn = json.load(open(small)).get("spawn")
    if args.near:
        e, n = utm33(args.near[1], args.near[0])
    elif spawn:
        e, n = spawn["x"] + ORIGIN_E, -spawn["z"] + ORIGIN_N
    else:
        e, n = ORIGIN_E, ORIGIN_N

    idx = als.index(os.path.join(bw.CACHE, "als"))
    keys = list(idx)
    if args.tiles:
        keys = [k for k in args.tiles if k in idx]

    def dist(k):
        te, tn = (int(v) for v in k.split("_"))
        return math.hypot((te + 0.5) * TILE - e, (tn + 0.5) * TILE - n) / 1000

    if args.radius is not None:
        keys = [k for k in keys if dist(k) <= args.radius + 0.71]
    keys.sort(key=dist)
    todo = [k for k in keys if args.rebuild
            or not os.path.exists(os.path.join(tile_dir(k), "tile.json"))]
    pending = set()
    if args.osm_refresh:
        if os.path.exists(PENDING):
            pending = set(json.load(open(PENDING)))
        pending |= osm_caches(keys, refresh=True)
        save_pending(pending)
        todo = [k for k in keys if k in pending or k in todo]
    else:
        osm_caches(todo)
    log("%d tiles selected, %d to build, %d workers -> %s"
        % (len(keys), len(todo), args.workers, os.path.relpath(OUT, ROOT)))

    os.makedirs(OUT, exist_ok=True)
    _java, _jar, ground_tex, env = bw.shared_assets(args, OUT)
    write_index(env, ground_tex, spawn)

    t_all = time.time()
    done = failed = 0
    # Workers are recycled every few tiles to hand fragmented memory back.
    # multiprocessing.Pool, not ProcessPoolExecutor: the latter's
    # max_tasks_per_child hangs for good once every worker has retired.
    with mp.Pool(args.workers, maxtasksperchild=4) as pool:
        for key, secs, err in pool.imap_unordered(
                functools.partial(build_tile, args=args), todo):
            if err:
                failed += 1
                log("  %-9s FAILED after %.0fs: %s (see cache/berlin_logs/%s.log)"
                    % (key, secs, err[:160], key))
            else:
                done += 1
                if key in pending:
                    pending.discard(key)
                    save_pending(pending)
                n_tiles = write_index(env, ground_tex, spawn)
                left = len(todo) - done - failed
                rate = (time.time() - t_all) / (done + failed)
                log("  %-9s %4.0fs   %d/%d built, %d in world, ~%.1f h to go"
                    % (key, secs, done, len(todo), n_tiles, left * rate / 3600))
    log("Done in %.1f h: %d built, %d failed" % ((time.time() - t_all) / 3600, done, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
