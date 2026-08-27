#!/usr/bin/env python3
"""Build the Berlin game world from open geodata.

Sources:
  * 3D-Gebaeudemodelle LoD2 (CityGML, 1x1 km tiles), Geoportal Berlin,
    https://gdi.berlin.de/data/a_lod2/atom/  -- dl-de/zero-2.0
  * OpenStreetMap via Overpass, for streets/water/green -- ODbL

Usage:
    python3 pipeline/build.py --preset mitte
    python3 pipeline/build.py --tiles 384,5815 394,5823
    python3 pipeline/build.py --preset core --skip-osm
"""
import argparse
import concurrent.futures as cf
import json
import os
import sys
import time
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fetch                                                     # noqa: E402
import collision                                                 # noqa: E402
import terrain as terrain_mod                                    # noqa: E402
from citygml import GROUND, ROOF, buildings as parse_buildings   # noqa: E402
from geo import ORIGIN_E, ORIGIN_H, ORIGIN_N, TILE, utm33_inv    # noqa: E402
from tilefmt import BASE_OFFSET, TileWriter, clamp_byte          # noqa: E402
from tri import triangulate                                      # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "cache")
LOD2_CACHE = os.path.join(CACHE, "lod2")
OUT = os.path.join(ROOT, "web", "public", "data")
ATOM = "https://gdi.berlin.de/data/a_lod2/atom/"

PRESETS = {
    "mitte":  (387, 5817, 392, 5821),    # Tiergarten .. Alexanderplatz
    "core":   (384, 5815, 394, 5823),    # + Kreuzberg, Prenzlauer Berg, City West
    "inner":  (381, 5812, 397, 5826),    # most of the inner city
}


def log(m):
    print(m, flush=True)


def tile_list(box):
    e0, n0, e1, n1 = box
    return [(e, n) for e in range(e0, e1 + 1) for n in range(n0, n1 + 1)]


def world_bounds(box):
    x0 = box[0] * TILE - ORIGIN_E
    x1 = (box[2] + 1) * TILE - ORIGIN_E
    z1 = -(box[1] * TILE - ORIGIN_N)
    z0 = -((box[3] + 1) * TILE - ORIGIN_N)
    return x0, z0, x1, z1


# --------------------------------------------------------------------------
def fetch_tile(tile):
    name = "LoD2_%d_%d.zip" % tile
    dest = os.path.join(LOD2_CACHE, name)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return tile, dest, "cached"
    try:
        size = fetch.download(ATOM + name, dest)
    except fetch.FetchError:
        return tile, None, "no data"      # not every km of the grid has buildings
    return tile, dest, "%.1f MB" % (size / 1048576)


def download_all(tiles, workers=6):
    os.makedirs(LOD2_CACHE, exist_ok=True)
    got = {}
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        for tile, path, note in ex.map(fetch_tile, tiles):
            if path:
                got[tile] = path
            else:
                log("    %d_%d: %s" % (tile[0], tile[1], note))
    log("  %d of %d tiles available" % (len(got), len(tiles)))
    return got


# --------------------------------------------------------------------------
def build_tile(tile, zip_path):
    """CityGML zip -> (bytes, stats, terrain samples)."""
    with zipfile.ZipFile(zip_path) as z:
        names = [n for n in z.namelist() if n.lower().endswith((".xml", ".gml"))]
        if not names:
            return None, None, [], None
        tmp = os.path.join(LOD2_CACHE, "_x_%d_%d.xml" % tile)
        with z.open(names[0]) as src, open(tmp, "wb") as dst:
            dst.write(src.read())

    w = TileWriter(b"BTB1", ("bheight", "bbase", "tint"))
    mask = collision.Mask(tile[0] * TILE - ORIGIN_E,
                          ORIGIN_N - (tile[1] + 1) * TILE)
    samples = []
    nb = 0
    tallest = 0.0
    try:
        for b in parse_buildings(tmp):
            gz = [p[2] for k, ext, _ in b["surfaces"] if k == GROUND for p in ext]
            rz = [p[2] for k, ext, _ in b["surfaces"] if k == ROOF for p in ext]
            allz = [p[2] for _k, ext, _ in b["surfaces"] for p in ext]
            base = min(gz) if gz else min(allz)
            top = max(rz) if rz else max(allz)
            height = max(0.0, top - base)
            tallest = max(tallest, height)
            bh = clamp_byte(height)
            bb = clamp_byte(base - ORIGIN_H + BASE_OFFSET)
            # stable per-building random byte, so each block gets its
            # own facade colour instead of the city being one flat tone
            tint = (hash(b["id"] or "") ^ (nb * 2654435761)) & 0xFF

            xs = [p[0] for _k, ext, _ in b["surfaces"] for p in ext]
            ys = [p[1] for _k, ext, _ in b["surfaces"] for p in ext]
            samples.append((sum(xs) / len(xs) - ORIGIN_E,
                            -(sum(ys) / len(ys) - ORIGIN_N),
                            base - ORIGIN_H))
            nb += 1
            # footprint for the collision mask: ground surfaces if present,
            # otherwise the roof outline, which covers the same plan area
            foot = [s_ for s_ in b["surfaces"] if s_[0] == GROUND]
            if not foot:
                foot = [s_ for s_ in b["surfaces"] if s_[0] == ROOF]
            if height >= 2.0:          # ignore sheds, canopies and kerb boxes
                for _k, ext, ints in foot:
                    ftris, _fn = triangulate(ext, ints)
                    for q0, q1, q2 in ftris:
                        mask.fill_triangle(
                            (q0[0] - ORIGIN_E, -(q0[1] - ORIGIN_N)),
                            (q1[0] - ORIGIN_E, -(q1[1] - ORIGIN_N)),
                            (q2[0] - ORIGIN_E, -(q2[1] - ORIGIN_N)))
            for kind, ext, ints in b["surfaces"]:
                tris, _n = triangulate(ext, ints)
                for p0, p1, p2 in tris:
                    # EPSG:25833 (E,N,h) -> world (x, y up, -z north).
                    # Flipping N reverses winding, so swap two corners back.
                    a = (p0[0] - ORIGIN_E, p0[2] - ORIGIN_H, -(p0[1] - ORIGIN_N))
                    c = (p1[0] - ORIGIN_E, p1[2] - ORIGIN_H, -(p1[1] - ORIGIN_N))
                    d = (p2[0] - ORIGIN_E, p2[2] - ORIGIN_H, -(p2[1] - ORIGIN_N))
                    w.add_triangle(a, d, c, kind, bheight=bh, bbase=bb, tint=tint)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

    data = w.to_bytes()
    if data is None:
        return None, None, samples, None
    mask.dilate()
    st = {"b": nb, "bt": len(w) // 3, "tall": round(tallest, 1),
          "solid": round(100.0 * mask.filled / (mask.n * mask.n), 1)}
    return data, st, samples, mask.to_bytes()


def build_buildings(tiles, paths):
    os.makedirs(OUT, exist_ok=True)
    stats = {}
    samples = []
    tris = nb = 0
    t0 = time.time()
    for i, tile in enumerate(tiles, 1):
        p = paths.get(tile)
        if not p:
            continue
        data, st, sm, cmask = build_tile(tile, p)
        samples.extend(sm)
        if not data:
            continue
        with open(os.path.join(OUT, "b_%d_%d.bin" % tile), "wb") as fh:
            fh.write(data)
        if cmask:
            with open(os.path.join(OUT, "c_%d_%d.bin" % tile), "wb") as fh:
                fh.write(cmask)
        stats["%d_%d" % tile] = st
        tris += st["bt"]
        nb += st["b"]
        log("  [%3d/%3d] %d_%d  %5d bldg %7d tri %5.1f MB  tall %3.0fm  solid %4.1f%%"
            % (i, len(tiles), tile[0], tile[1], st["b"], st["bt"],
               len(data) / 1048576, st["tall"], st["solid"]))
    log("  => %d buildings, %d triangles, %.0fs" % (nb, tris, time.time() - t0))
    return stats, samples


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--preset", choices=sorted(PRESETS), default="mitte")
    ap.add_argument("--tiles", nargs=2, metavar=("E,N", "E,N"))
    ap.add_argument("--skip-osm", action="store_true")
    ap.add_argument("--skip-buildings", action="store_true")
    args = ap.parse_args()

    if args.tiles:
        a = [int(v) for v in args.tiles[0].split(",")]
        b = [int(v) for v in args.tiles[1].split(",")]
        box = (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
    else:
        box = PRESETS[args.preset]

    tiles = tile_list(box)
    lon0, lat0 = utm33_inv(box[0] * TILE, box[1] * TILE)
    lon1, lat1 = utm33_inv((box[2] + 1) * TILE, (box[3] + 1) * TILE)
    log("Area %s -> %d tiles, %d x %d km" % (box, len(tiles),
                                             box[2] - box[0] + 1, box[3] - box[1] + 1))
    log("  bbox lon/lat  %.4f,%.4f .. %.4f,%.4f" % (lon0, lat0, lon1, lat1))
    os.makedirs(OUT, exist_ok=True)

    manifest = {"origin": {"e": ORIGIN_E, "n": ORIGIN_N, "h": ORIGIN_H},
                "tileSize": TILE, "box": list(box), "tiles": {},
                "attribution": [
                    "Buildings: Geoportal Berlin / 3D-Gebaeudemodelle LoD2 (dl-de/zero-2.0)",
                    "Streets, water, green space: (c) OpenStreetMap contributors (ODbL)",
                ]}

    terr = None
    if not args.skip_buildings:
        log("Downloading LoD2 CityGML ...")
        paths = download_all(tiles)
        log("Building geometry ...")
        st, samples = build_buildings(tiles, paths)
        for k, v in st.items():
            manifest["tiles"].setdefault(k, {}).update(v)

        log("Deriving terrain from %d building footprints ..." % len(samples))
        x0, z0, x1, z1 = world_bounds(box)
        terr = terrain_mod.Terrain(x0, z0, x1, z1)
        for x, z, y in samples:
            terr.add(x, z, y)
        terr.solve()
        blob, meta = terr.to_bytes()
        with open(os.path.join(OUT, "terrain.bin"), "wb") as fh:
            fh.write(blob)
        manifest["terrain"] = meta
        log("  terrain %dx%d cells, %.1f..%.1f m" % (meta["nx"], meta["nz"],
                                                     meta["hmin"], meta["hmax"]))

    if not args.skip_osm:
        import osm
        if terr is None:
            tp = os.path.join(OUT, "terrain.bin")
            if not os.path.exists(tp):
                log("No terrain.bin yet - run without --skip-buildings first.")
                return 1
            terr = terrain_mod.load(tp)
        log("Fetching OpenStreetMap (Overpass) ...")
        st = osm.build(box, OUT, terr, CACHE)
        for k, v in st.items():
            manifest["tiles"].setdefault(k, {}).update(v)

    mpath = os.path.join(OUT, "manifest.json")
    if os.path.exists(mpath):
        try:
            old = json.load(open(mpath))
            merged = old.get("tiles", {})
            for k, v in manifest["tiles"].items():
                merged.setdefault(k, {}).update(v)
            manifest["tiles"] = merged
            if "terrain" not in manifest and "terrain" in old:
                manifest["terrain"] = old["terrain"]
        except Exception:                                        # noqa: BLE001
            pass
    with open(mpath, "w") as fh:
        json.dump(manifest, fh, indent=1)
    log("Wrote manifest.json (%d tiles)" % len(manifest["tiles"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
