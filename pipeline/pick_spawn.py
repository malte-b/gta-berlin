#!/usr/bin/env python3
"""Choose where the player starts.

Kept separate from build_nav.py so it can be re-run and re-tuned in a second,
and because it wants the baked places file that build_pois.py writes later.

A good starting spot is a kerb corner at a junction: pavement rather than
carriageway, right at the kerb, with road arms heading off in more than one
direction, real headroom overhead, and something recognisable beside it. Each
of those is a filter below.

    python3 pipeline/pick_spawn.py
    python3 pipeline/pick_spawn.py --near Bank      # sit next to a bench
"""
import argparse
import json
import math
import os
import struct
import sys
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import navgrid as ng                                             # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "public", "data")


def log(m):
    print(m, flush=True)


def read_nav(path):
    raw = open(path, "rb").read()
    assert raw[:4] == b"BTN1", "not a nav grid"
    min_x, min_z = struct.unpack_from("<2f", raw, 4)
    cell, = struct.unpack_from("<f", raw, 12)
    nx, nz = struct.unpack_from("<2I", raw, 16)
    n = nx * nz
    flags = raw[32 + n * 2: 32 + n * 2 + n]
    return dict(minX=min_x, minZ=min_z, cell=cell, nx=nx, nz=nz, flags=flags)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--near", default="Bank",
                    help="place name to sit beside (default Bank, i.e. a bench)")
    ap.add_argument("--junction-radius", type=float, default=16.0)
    ap.add_argument("--clearing", type=int, default=12,
                    help="metres of open sky required all round the spawn")
    ap.add_argument("--sectors", type=int, default=4,
                    help="how many of eight directions must contain road")
    ap.add_argument("--anchor-dist", type=float, default=12.0,
                    help="how close the spawn must be to that place, metres")
    args = ap.parse_args()

    nav = read_nav(os.path.join(OUT, "nav.bin"))
    nx, nz, cell = nav["nx"], nav["nz"], nav["cell"]
    flags = nav["flags"]
    n = nx * nz

    walk = [(f & ng.WALKABLE) != 0 for f in flags]
    drive = [(f & ng.DRIVABLE) != 0 for f in flags]
    # Erode the raw headroom test to the radius we want rather than reusing the
    # 7 m version baked into the grid. The third-person camera sits about 6.4 m
    # behind the player, so a 7 m clearing puts it exactly where the canopy
    # starts - which is what made the last two spawns unusable.
    sky_raw = [(f & ng.SKY_RAW) != 0 for f in flags]
    sky = ng._mask_filter(sky_raw, nx, nz, args.clearing, False)
    log("open sky within %d m: %.1f%% of walkable"
        % (args.clearing,
           100 * sum(1 for k in range(n) if sky[k] and (flags[k] & ng.WALKABLE))
           / max(sum(1 for f in flags if f & ng.WALKABLE), 1)))

    # only the main region: a perfect corner inside a sealed courtyard is useless
    seen, comps = ng.components(walk, nx, nz)
    main_id = comps[0][1]
    log("largest walkable region: %s cells" % f"{comps[0][0]:,}")

    def bfs(sources):
        dist = [None] * n
        q = deque()
        for k in sources:
            dist[k] = 0
            q.append(k)
        while q:
            k = q.popleft()
            d = dist[k] + 1
            c, r = k % nx, k // nx
            for kk, ok in ((k - 1, c > 0), (k + 1, c < nx - 1),
                           (k - nx, r > 0), (k + nx, r < nz - 1)):
                if ok and dist[kk] is None:
                    dist[kk] = d
                    q.append(kk)
        return dist

    to_road = bfs([k for k in range(n) if drive[k]])

    # How far is the nearest thing that sticks up? SKY_RAW marks ground with
    # nothing overhead, so its complement is every tree, wall, canopy and bridge
    # soffit in the city. A distance transform from that set measures, directly
    # and without proxies, how much clear space a spot actually has around it -
    # which is the thing that kept going wrong when it was inferred instead.
    to_obstacle = bfs([k for k in range(n) if not sky_raw[k]])

    # places to sit beside
    anchors = []
    poi_path = os.path.join(OUT, "pois.json")
    if os.path.exists(poi_path):
        data = json.load(open(poi_path))
        anchors = [(p["x"], p["z"]) for p in data["pois"] if p["n"] == args.near]
    log("anchors named %r: %d" % (args.near, len(anchors)))

    MIN_SECTORS = args.sectors
    rad = int(args.junction_radius / cell)
    best = None
    best_score = -1e18
    for k in range(n):
        if not walk[k] or drive[k] or not sky[k]:
            continue
        if seen[k] != main_id:
            continue
        rd = to_road[k]
        if rd is None or rd < 1 or rd > 3:      # standing right at the kerb
            continue
        openness = to_obstacle[k]
        if openness is None or openness < args.clearing:
            continue
        c, r = k % nx, k // nx

        # A junction has carriageway spread around it, not just on one side.
        # Counting which of eight sectors contain road separates a corner from
        # a stretch of pavement halfway down a block.
        sectors = set()
        roadcells = 0
        for dr in range(-rad, rad + 1, 2):
            for dc in range(-rad, rad + 1, 2):
                cc, rr = c + dc, r + dr
                if cc < 0 or cc >= nx or rr < 0 or rr >= nz:
                    continue
                if not drive[rr * nx + cc]:
                    continue
                if dc == 0 and dr == 0:
                    continue
                if dc * dc + dr * dr > rad * rad:
                    continue
                roadcells += 1
                sectors.add(int((math.atan2(dr, dc) + math.pi) / (math.pi / 4)) % 8)
        if len(sectors) < MIN_SECTORS:          # not a corner
            continue

        x = nav["minX"] + (c + 0.5) * cell
        z = nav["minZ"] + (r + 0.5) * cell
        near = min((math.hypot(ax - x, az - z) for ax, az in anchors), default=999)
        if anchors and near > args.anchor_dist:
            continue

        # being beside the anchor matters more than a busier junction
        # open space first, then a proper junction, then the anchor
        score = openness * 8 + len(sectors) * 4 + roadcells * 0.04 - near * 1.5
        if score > best_score:
            best_score = score
            best = (x, z, len(sectors), rd, near, openness)

    if not best:
        log("no corner matched; leaving the existing spawn alone")
        return 1

    x, z, sectors, rd, near, openness = best
    log("spawn x %.0f z %.0f  (%d m of clear space, %d road sectors, "
        "%d m to kerb, %.0f m from a %s)"
        % (x, z, openness, sectors, rd, near, args.near))

    mpath = os.path.join(OUT, "world.json")
    manifest = json.load(open(mpath))
    manifest["spawn"] = {"x": round(x, 1), "z": round(z, 1),
                         "sectors": sectors, "toRoad": rd,
                         "beside": args.near, "besideDist": round(near, 1),
                         "openness": openness}
    with open(mpath, "w") as fh:
        json.dump(manifest, fh, indent=1)
    log("Wrote spawn to world.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
