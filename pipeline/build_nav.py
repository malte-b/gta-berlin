#!/usr/bin/env python3
"""Build the navigation grid from the already-built tile heightfields.

Separate from build_mesh.py so it can be re-run and re-tuned in seconds without
re-parsing any OBJ files.

    python3 pipeline/build_nav.py
    python3 pipeline/build_nav.py --object-height 1.0 --element 11
"""
import argparse
import json
import math
import os
import struct
import sys
import time
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import navgrid as ng                                             # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "public", "data")
CELL = 1.0


def log(m):
    print(m, flush=True)


def read_heightfield(path):
    raw = open(path, "rb").read()
    assert raw[:4] == b"BTH1", path
    min_x, min_z = struct.unpack_from("<2f", raw, 4)
    cell, = struct.unpack_from("<f", raw, 12)
    nx, nz = struct.unpack_from("<2H", raw, 16)
    hmin, hs = struct.unpack_from("<2f", raw, 20)
    n = nx * nz
    ground = struct.unpack_from("<%dH" % n, raw, 28)
    top = struct.unpack_from("<%dH" % n, raw, 28 + n * 2)
    return dict(minX=min_x, minZ=min_z, cell=cell, nx=nx, nz=nz,
                hmin=hmin, hs=hs, ground=ground, top=top)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--element", type=int, default=10,
                    help="opening radius in metres; features narrower than "
                         "twice this are treated as objects, not terrain")
    ap.add_argument("--object-height", type=float, default=1.1,
                    help="metres above terrain before something blocks you")
    ap.add_argument("--max-slope", type=float, default=0.55,
                    help="max terrain rise per metre that stays walkable")
    ap.add_argument("--car-clearance", type=float, default=2.0,
                    help="metres a car must keep from anything solid")
    args = ap.parse_args()

    manifest = json.load(open(os.path.join(OUT, "mesh_manifest.json")))
    world = manifest["world"]
    min_x, min_z = world[0], world[2]
    nx = int((world[3] - world[0]) / CELL) + 1
    nz = int((world[5] - world[2]) / CELL) + 1
    n = nx * nz
    log("World grid %d x %d at %.1f m (%s cells)" % (nx, nz, CELL, f"{n:,}"))

    # --- stitch every tile heightfield into one global surface --------------
    # Tiles overlap by a few metres, and a tile's own edge is the least
    # reliable part of it - geometry gets truncated there. Taking the minimum
    # across overlapping tiles therefore digs artificial pits along every seam,
    # which is exactly where the player kept ending up underground. Each cell
    # is instead owned by whichever tile centre is nearest, so only tile
    # interiors are ever used.
    surface = [None] * n
    top = [None] * n
    owner_d = [None] * n
    for key, info in manifest["tiles"].items():
        hf = read_heightfield(os.path.join(OUT, info["height"]))
        hcx = hf["minX"] + hf["nx"] * hf["cell"] * 0.5
        hcz = hf["minZ"] + hf["nz"] * hf["cell"] * 0.5
        for r in range(hf["nz"]):
            wz = hf["minZ"] + (r + 0.5) * hf["cell"]
            gr = int((wz - min_z) / CELL)
            if gr < 0 or gr >= nz:
                continue
            base = r * hf["nx"]
            for c in range(hf["nx"]):
                wx = hf["minX"] + (c + 0.5) * hf["cell"]
                gc = int((wx - min_x) / CELL)
                if gc < 0 or gc >= nx:
                    continue
                k = gr * nx + gc
                g = hf["hmin"] + hf["ground"][base + c] * hf["hs"]
                t = hf["hmin"] + hf["top"][base + c] * hf["hs"]
                d = (wx - hcx) ** 2 + (wz - hcz) ** 2
                if owner_d[k] is None or d < owner_d[k]:
                    owner_d[k] = d
                    surface[k] = g
                    top[k] = t
    covered = [s is not None for s in surface]
    ncov = sum(covered)
    log("  covered by mesh: %s cells (%.0f%%)" % (f"{ncov:,}", 100 * ncov / n))

    known = [s for s in surface if s is not None]
    fill = sum(known) / len(known)
    surface = [fill if s is None else s for s in surface]
    top = [surface[i] if top[i] is None else top[i] for i in range(n)]

    # --- terrain vs objects -------------------------------------------------
    t0 = time.time()
    terrain = ng.opening(surface, nx, nz, args.element)
    log("  morphological opening (%d m element) in %.0fs" % (args.element, time.time() - t0))

    obstacle = [0] * n
    for k in range(n):
        if surface[k] - terrain[k] > args.object_height:
            obstacle[k] = 1
    log("  objects above terrain: %.1f%% of covered ground"
        % (100 * sum(obstacle) / max(ncov, 1)))

    # --- slope on the cleaned terrain ---------------------------------------
    steep = [0] * n
    for r in range(nz):
        for c in range(nx):
            k = r * nx + c
            h = terrain[k]
            d = 0.0
            if c + 1 < nx: d = max(d, abs(terrain[k + 1] - h))
            if r + 1 < nz: d = max(d, abs(terrain[k + nx] - h))
            if d > args.max_slope:
                steep[k] = 1
    log("  terrain too steep: %.1f%%" % (100 * sum(steep) / n))

    walk = [covered[k] and not obstacle[k] and not steep[k] for k in range(n)]
    log("  raw walkable: %.1f%% of covered" % (100 * sum(walk) / max(ncov, 1)))

    # Close pinholes left by noise, then drop specks. The closing dilates the
    # mask outward before shrinking it back, which on a concave footprint - a
    # courtyard entrance, a notch between two blocks - leaves cells sitting
    # inside the building. Nothing put them back, so the obstacle test is
    # re-applied afterwards: no amount of tidying may make the inside of a wall
    # walkable, which is what let the player clip through buildings and stand
    # metres below the visible ground.
    walk = ng._mask_filter(walk, nx, nz, 1, True)
    walk = ng._mask_filter(walk, nx, nz, 1, False)
    walk = [walk[k] and covered[k] and not obstacle[k] for k in range(n)]

    # --- connectivity: this is the check the whole thing exists for ---------
    seen, comps = ng.components(walk, nx, nz)
    log("  connected regions: %d" % len(comps))
    if comps:
        biggest = comps[0]
        log("    largest %s cells (%.1f%% of walkable)"
            % (f"{biggest[0]:,}", 100 * biggest[0] / max(sum(walk), 1)))
        stranded = sum(c for c, _ in comps[1:])
        log("    %d smaller regions, %s cells total, largest of them %s"
            % (len(comps) - 1, f"{stranded:,}",
               f"{comps[1][0]:,}" if len(comps) > 1 else "-"))
        main_id = biggest[1]
        # keep sizeable courtyards reachable-looking, but never the noise specks
        keep = {main_id}
        for cells, cid in comps[1:]:
            if cells >= 400:
                keep.add(cid)
        walk = [walk[k] and seen[k] in keep for k in range(n)]
        log("    kept %d regions (dropped %d specks under 400 m2)"
            % (len(keep), len(comps) - len(keep)))

    # --- cars need room ------------------------------------------------------
    drive = ng._mask_filter(walk, nx, nz, int(args.car_clearance), False)
    log("  drivable after %.1f m erosion: %.1f%% of walkable"
        % (args.car_clearance, 100 * sum(drive) / max(sum(walk), 1)))

    # --- choose a spawn -----------------------------------------------------
    # "Nearest walkable cell" is a bad default: courtyards and lightwells are
    # walkable but enclosed, so you can end up boxed in behind a building. A
    # good spawn is in the largest connected region, has room around it, and
    # sits a few metres off a drivable street - which is exactly what a
    # pavement is.
    def bfs_distance(sources, passable):
        """Multi-source BFS distance in cells; None where unreachable."""
        dist = [None] * n
        q = deque()
        for k in sources:
            dist[k] = 0
            q.append(k)
        while q:
            k = q.popleft()
            d = dist[k] + 1
            c, r = k % nx, k // nx
            if c > 0 and dist[k - 1] is None and passable[k - 1]:
                dist[k - 1] = d; q.append(k - 1)
            if c < nx - 1 and dist[k + 1] is None and passable[k + 1]:
                dist[k + 1] = d; q.append(k + 1)
            if r > 0 and dist[k - nx] is None and passable[k - nx]:
                dist[k - nx] = d; q.append(k - nx)
            if r < nz - 1 and dist[k + nx] is None and passable[k + nx]:
                dist[k + nx] = d; q.append(k + nx)
        return dist

    # Open sky matters as much as open ground. A pavement cell can be perfectly
    # walkable while every cell around it is under a tree - photogrammetry
    # drapes over canopies rather than seeing through them, so the camera ends
    # up buried in foliage even though the player is standing in the clear.
    # `open_sky`, eroded, finds ground with real headroom all around it.
    open_sky = [surface[k] - terrain[k] < 1.0 for k in range(n)]
    open_wide = ng._mask_filter(open_sky, nx, nz, 7, False)
    log("  ground with 7 m of open sky around it: %.1f%%"
        % (100 * sum(1 for k in range(n) if open_wide[k] and walk[k])
           / max(sum(walk), 1)))

    everywhere = [True] * n
    # how far each cell is from anything you cannot walk on
    clearance = bfs_distance([k for k in range(n) if not walk[k]], everywhere)
    # how far each cell is from a street a car could use
    to_road = bfs_distance([k for k in range(n) if drive[k]], everywhere)

    cx = (nx - 1) / 2.0
    cz = (nz - 1) / 2.0
    best_k = None
    best_score = -1e18
    for k in range(n):
        # A pavement is walkable, *not* drivable, and right beside a street.
        # Without excluding drivable cells the search happily picks the middle
        # of the carriageway, which has the most room of anywhere.
        if not walk[k] or drive[k]:
            continue
        cl = clearance[k]
        rd = to_road[k]
        if cl is None or rd is None:
            continue
        if rd < 1 or rd > 6:            # too far from any street to be a pavement
            continue
        if not open_wide[k]:            # under a tree, or in an archway
            continue
        c, r = k % nx, k // nx
        score = (min(cl, 6) * 3.0
                 - abs(rd - 3) * 2.0
                 - math.hypot(c - cx, r - cz) * 0.03)
        if score > best_score:
            best_score = score
            best_k = k

    spawn = None
    if best_k is not None:
        sc, sr = best_k % nx, best_k // nx
        spawn = {
            "x": round(min_x + (sc + 0.5) * CELL, 1),
            "z": round(min_z + (sr + 0.5) * CELL, 1),
            "clearance": clearance[best_k],
            "toRoad": to_road[best_k],
        }
        log("  spawn at x %.0f z %.0f (%d m of room, %d m from a street)"
            % (spawn["x"], spawn["z"], spawn["clearance"], spawn["toRoad"]))

    flags = bytearray(n)
    for k in range(n):
        v = 0
        if walk[k]:
            v |= ng.WALKABLE
        if drive[k]:
            v |= ng.DRIVABLE
        if open_wide[k]:
            v |= ng.OPEN_SKY
        if open_sky[k]:
            v |= ng.SKY_RAW
        flags[k] = v

    blob, meta = ng.to_bytes(min_x, min_z, CELL, nx, nz, terrain, flags)
    with open(os.path.join(OUT, "nav.bin"), "wb") as fh:
        fh.write(blob)
    manifest["nav"] = {"file": "nav.bin", "cell": CELL, "nx": nx, "nz": nz,
                       "minX": min_x, "minZ": min_z, **meta}
    if spawn:
        manifest["spawn"] = spawn
    with open(os.path.join(OUT, "mesh_manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    log("Wrote nav.bin (%.1f MB)" % (len(blob) / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
