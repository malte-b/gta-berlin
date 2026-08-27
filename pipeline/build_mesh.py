#!/usr/bin/env python3
"""Build the game world from Berlin's photogrammetric 3D mesh model.

Input is whatever tile folders have been downloaded from the Berlin 3D
download portal into data/ - each one an OBJ plus its JPEG atlas pages.
Source: Berlin 3D Downloadportal / Business Location Center, aerial survey
2025, published as open data by the Senatsverwaltung fuer Wirtschaft.

Textures are emitted at two levels. The full-resolution atlas page is 8192 x
8192, which costs about 270 MB of GPU memory once expanded to RGBA - times
nine tiles that is far past what a browser will give us. So each page is
written both as a high level (used for the tiles nearest the camera) and a low
level (everything else), and the renderer swaps between them as you move.

Usage:
    python3 pipeline/build_mesh.py
    python3 pipeline/build_mesh.py --hi 8192 --lo 2048     # keep full detail
    python3 pipeline/build_mesh.py --skip-textures
"""
import argparse
import concurrent.futures as cf
import json
import os
import struct
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import meshmodel as mm                                           # noqa: E402
from geo import ORIGIN_E, ORIGIN_H, ORIGIN_N, utm33_inv          # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "web", "public", "data")

# page 0 carries ~86% of the faces, so it is the one that matters
HI_MAX = 4096
LO_MAX = 1024
HI_MAX_OTHER = 2048
LO_MAX_OTHER = 512
QUALITY = 82


def log(m):
    print(m, flush=True)


def jpeg_size(path):
    with open(path, "rb") as f:
        f.read(2)
        while True:
            b = f.read(1)
            if not b:
                return None
            if b != b"\xff":
                continue
            m = f.read(1)
            while m == b"\xff":
                m = f.read(1)
            if m in (b"\xc0", b"\xc1", b"\xc2", b"\xc3", b"\xc5", b"\xc6",
                     b"\xc7", b"\xc9", b"\xca", b"\xcb", b"\xcd", b"\xce", b"\xcf"):
                f.read(3)
                h, w = struct.unpack(">HH", f.read(4))
                return w, h
            ln = struct.unpack(">H", f.read(2))[0]
            f.seek(ln - 2, 1)


def resize(src, dst, max_dim, quality=QUALITY):
    if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
        return os.path.getsize(dst)
    subprocess.run(
        ["sips", "-Z", str(max_dim), "-s", "format", "jpeg",
         "-s", "formatOptions", str(quality), src, "--out", dst],
        check=True, capture_output=True)
    return os.path.getsize(dst)


def build_textures(key, folder, pages, hi_max, lo_max):
    """Write t_<key>_<page>_{hi,lo}.jpg. Returns page metadata."""
    meta = []
    jobs = []
    for page in sorted(pages):
        src = pages[page]
        size = jpeg_size(src) or (0, 0)
        big = max(size)
        h_cap = hi_max if page == 0 else min(hi_max, HI_MAX_OTHER)
        l_cap = lo_max if page == 0 else min(lo_max, LO_MAX_OTHER)
        h_cap = min(h_cap, big) or 1
        l_cap = min(l_cap, big) or 1
        hi_name = "t_%s_%d_hi.jpg" % (key, page)
        lo_name = "t_%s_%d_lo.jpg" % (key, page)
        jobs.append((src, os.path.join(OUT, hi_name), h_cap))
        jobs.append((src, os.path.join(OUT, lo_name), l_cap))
        meta.append({"page": page, "hi": hi_name, "lo": lo_name,
                     "src": list(size), "hiMax": h_cap, "loMax": l_cap})
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        list(ex.map(lambda j: resize(*j), jobs))
    for m in meta:
        for lvl in ("hi", "lo"):
            p = os.path.join(OUT, m[lvl])
            m[lvl + "Bytes"] = os.path.getsize(p) if os.path.exists(p) else 0
    return meta


def build_tile(key, folder, obj_path, args):
    t0 = time.time()
    verts, uvs, groups = mm.parse_obj(obj_path)
    geo, gstats = mm.write_geometry(verts, uvs, groups)
    if geo is None:
        return None
    with open(os.path.join(OUT, "m_%s.bin" % key), "wb") as fh:
        fh.write(geo)
    hf, hstats = mm.build_heightfield(verts, groups)
    with open(os.path.join(OUT, "h_%s.bin" % key), "wb") as fh:
        fh.write(hf)

    pages = {}
    for f in os.listdir(folder):
        if f.lower().endswith(".jpg"):
            stem = os.path.splitext(f)[0]
            try:
                pages[int(stem.rsplit("-", 1)[-1])] = os.path.join(folder, f)
            except ValueError:
                pass
    tex = [] if args.skip_textures else build_textures(key, folder, pages,
                                                       args.hi, args.lo)
    bb = gstats["bbox"]
    info = {
        "geometry": "m_%s.bin" % key,
        "height": "h_%s.bin" % key,
        "triangles": gstats["tri"],
        "vertices": gstats["v"],
        "bbox": bb,
        "grid": [hstats["nx"], hstats["nz"]],
        "textures": tex,
    }
    log("  %-12s %7d tri  geo %5.1f MB  hf %4.0f KB  %d pages  %.0fs"
        % (key, gstats["tri"], len(geo) / 1048576, len(hf) / 1024,
           len(tex), time.time() - t0))
    return info


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hi", type=int, default=HI_MAX,
                    help="max edge for the near-field atlas (default 4096)")
    ap.add_argument("--lo", type=int, default=LO_MAX,
                    help="max edge for the far-field atlas (default 1024)")
    ap.add_argument("--skip-textures", action="store_true")
    ap.add_argument("--src", default=SRC)
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    tiles = mm.find_tiles(args.src)
    if not tiles:
        log("No tile folders with an .obj found under %s" % args.src)
        return 1
    log("Found %d mesh tiles in %s" % (len(tiles), args.src))
    log("Textures: page 0 at %d px (near) / %d px (far)" % (args.hi, args.lo))

    out = {}
    for key, (folder, obj) in sorted(tiles.items()):
        info = build_tile(key, folder, obj, args)
        if info:
            out[key] = info

    xs = [t["bbox"][0] for t in out.values()] + [t["bbox"][3] for t in out.values()]
    ys = [t["bbox"][1] for t in out.values()] + [t["bbox"][4] for t in out.values()]
    zs = [t["bbox"][2] for t in out.values()] + [t["bbox"][5] for t in out.values()]
    world = [min(xs), min(ys), min(zs), max(xs), max(ys), max(zs)]
    cx = (world[0] + world[3]) / 2
    cz = (world[2] + world[5]) / 2
    lon, lat = utm33_inv(cx + ORIGIN_E, -cz + ORIGIN_N)

    manifest = {
        "kind": "mesh",
        "origin": {"e": ORIGIN_E, "n": ORIGIN_N, "h": ORIGIN_H},
        "world": world,
        "centre": {"x": cx, "z": cz, "lon": round(lon, 6), "lat": round(lat, 6)},
        "tiles": out,
        "attribution": [
            "3D-Meshmodell Berlin, Senatsverwaltung fuer Wirtschaft, Energie und "
            "Betriebe / Business Location Center, Befliegung 2025 (Open Data)",
        ],
    }
    with open(os.path.join(OUT, "mesh_manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)

    tri = sum(t["triangles"] for t in out.values())
    log("")
    log("World %.0f x %.0f m, %d tiles, %s triangles"
        % (world[3] - world[0], world[5] - world[2], len(out), f"{tri:,}"))
    log("Centre lon/lat %.5f, %.5f" % (lon, lat))
    return 0


if __name__ == "__main__":
    sys.exit(main())
