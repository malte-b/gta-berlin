#!/usr/bin/env python3
"""Pin the spawn to an explicit lon/lat, optionally facing a named place.

    python3 pipeline/set_spawn.py 52.48475 13.38623 --face "Cafe do Brazil"

Heading follows the game's camera convention: the camera sits at
head + (sin yaw, cos yaw) * distance and looks back at the player, so the view
direction is (-sin yaw, -cos yaw) and yaw = atan2(-dx, -dz).
"""
import argparse
import json
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import navgrid as ng                                             # noqa: E402
from geo import utm33                                            # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "web", "public", "data")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lat", type=float)
    ap.add_argument("lon", type=float)
    ap.add_argument("--face", default=None, help="name of a place to look at")
    args = ap.parse_args()

    mpath = os.path.join(OUT, "mesh_manifest.json")
    man = json.load(open(mpath))
    o = man["origin"]

    e, n = utm33(args.lon, args.lat)
    x, z = e - o["e"], -(n - o["n"])

    raw = open(os.path.join(OUT, "nav.bin"), "rb").read()
    minX, minZ = struct.unpack_from("<2f", raw, 4)
    cell, = struct.unpack_from("<f", raw, 12)
    nx, nz = struct.unpack_from("<2I", raw, 16)
    N = nx * nz
    flags = raw[32 + N * 2: 32 + N * 2 + N]

    def passable(px, pz):
        c = int((px - minX) / cell)
        r = int((pz - minZ) / cell)
        if c < 0 or c >= nx or r < 0 or r >= nz:
            return False
        return (flags[r * nx + c] & ng.WALKABLE) != 0

    # nudge onto walkable ground if the exact point is not, keeping it close
    sx, sz = x, z
    if not passable(sx, sz):
        found = None
        for rad in range(1, 25):
            for a in range(0, 360, 10):
                th = math.radians(a)
                px = x + math.cos(th) * rad
                pz = z + math.sin(th) * rad
                if passable(px, pz):
                    found = (px, pz)
                    break
            if found:
                break
        if found:
            sx, sz = found
            print("exact point not walkable; nudged %.1f m to the nearest that is"
                  % math.hypot(sx - x, sz - z))
        else:
            print("warning: no walkable ground near that point")

    spawn = {"x": round(sx, 1), "z": round(sz, 1),
             "lat": args.lat, "lon": args.lon}

    if args.face:
        pois = json.load(open(os.path.join(OUT, "pois.json")))["pois"]
        target = next((p for p in pois
                       if p["n"].lower() == args.face.lower()), None)
        if target is None:
            cand = [p for p in pois if args.face.lower() in p["n"].lower()]
            target = cand[0] if cand else None
        if target is None:
            print("no place named %r; leaving the heading alone" % args.face)
        else:
            dx = target["x"] - sx
            dz = target["z"] - sz
            spawn["heading"] = round(math.atan2(-dx, -dz), 4)
            spawn["facing"] = target["n"]
            spawn["facingDist"] = round(math.hypot(dx, dz), 1)
            print("facing %r, %.0f m away, heading %.3f rad"
                  % (target["n"], spawn["facingDist"], spawn["heading"]))

    man["spawn"] = spawn
    with open(mpath, "w") as fh:
        json.dump(man, fh, indent=1)
    print("spawn set to x %.1f z %.1f (%.5f, %.5f)"
          % (spawn["x"], spawn["z"], args.lat, args.lon))
    return 0


if __name__ == "__main__":
    sys.exit(main())
