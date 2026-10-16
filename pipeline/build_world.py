#!/usr/bin/env python3
"""Build the game world from Berlin open data and OpenStreetMap.

    terrain    airborne laser scan, ground returns only      (ALS, dl-de/zero-2.0)
    buildings  OSM Simple 3D Buildings, modelled by OSM2World (ODbL)
    trees      Baumkataster: street and park trees, with height and crown
               diameter                                     (dl-de/zero-2.0)
    ground     roads, paths, green space and water from OSM, painted onto the
               terrain                                       (ODbL)
    furniture  signs, bollards, benches, bus shelters, street lamps from the
               street survey and lighting register, by OSM2World (dl-de/zero-2.0)
    bridges    OSM bridge ways as decks at the laser scan's height (ODbL, ALS)

Every download is cached under cache/, so re-running after a tweak takes
seconds. --refresh re-queries OSM and the tree cadastre; the laser scan does
not change and is never re-fetched.

    python3 pipeline/build_world.py
    python3 pipeline/build_world.py --area 389000 5815000 391000 5817000
    python3 pipeline/build_world.py --refresh

Needs a Java 17+ runtime for OSM2World (brew install openjdk). OSM2World
itself is downloaded into tools/ on first run.
"""
import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import als                                                       # noqa: E402
import bridges                                                   # noqa: E402
import fetch                                                     # noqa: E402
import groundcover                                               # noqa: E402
import navgrid as ng                                             # noqa: E402
import ortho                                                     # noqa: E402
import osm3d                                                     # noqa: E402
import pack_buildings                                            # noqa: E402
import street_furniture                                          # noqa: E402
import trees as trees_mod                                        # noqa: E402
import water as water_mod                                        # noqa: E402
from geo import ORIGIN_E, ORIGIN_H, ORIGIN_N, utm33_inv          # noqa: E402
from raster import Grid                                          # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "cache")
TOOLS = os.path.join(ROOT, "tools")
OUT = os.path.join(ROOT, "web", "public", "data")
O2W_URL = "https://osm2world.org/download/files/latest/OSM2World-latest-bin.zip"

# Bergmannkiez and the Kreuzberg, 1.1 x 1.1 km - EPSG:25833 metres
DEFAULT_AREA = (389800, 5815700, 390900, 5816800)
CHUNK = 275.0                       # building chunk edge, metres


def log(m):
    print(m, flush=True)


class Terrain:
    """The ALS ground model, sampled the way the game samples it."""

    def __init__(self, h, nx, nz, x0, z0):
        self.h, self.nx, self.nz, self.x0, self.z0 = h, nx, nz, x0, z0

    def at(self, c, r):
        c = min(max(c, 0), self.nx - 1)
        r = min(max(r, 0), self.nz - 1)
        return self.h[r * self.nx + c]

    def height(self, x, z):
        fx = x - self.x0 - 0.5
        fz = z - self.z0 - 0.5
        i, j = math.floor(fx), math.floor(fz)
        tx, tz = fx - i, fz - j
        a, b = self.at(i, j), self.at(i + 1, j)
        c, d = self.at(i, j + 1), self.at(i + 1, j + 1)
        return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz

    def to_bytes(self):
        hmin, hmax = min(self.h), max(self.h)
        scale = (hmax - hmin) / 65535 or 1.0
        out = bytearray(b"BTT1")
        out += struct.pack("<3f", self.x0, self.z0, 1.0)
        out += struct.pack("<2I", self.nx, self.nz)
        out += struct.pack("<2f", hmin, scale)
        inv = 1.0 / scale
        out += struct.pack("<%dH" % len(self.h),
                           *[min(65535, max(0, int((v - hmin) * inv + 0.5))) for v in self.h])
        return bytes(out), hmin, hmax


def ensure_osm2world(explicit):
    java, jar = osm3d.find_osm2world(explicit)
    if not java or subprocess.run([java, "-version"], capture_output=True).returncode != 0:
        raise SystemExit("No Java runtime found. OSM2World needs Java 17+: "
                         "brew install openjdk")
    if jar:
        return java, jar
    log("  downloading OSM2World into tools/ ...")
    os.makedirs(TOOLS, exist_ok=True)
    zpath = os.path.join(TOOLS, "OSM2World.zip")
    fetch.download(O2W_URL, zpath, timeout=900)
    import zipfile
    with zipfile.ZipFile(zpath) as z:
        z.extractall(os.path.join(TOOLS, "OSM2World"))
    os.remove(zpath)
    return osm3d.find_osm2world(explicit)


# Ground materials, by cover class. These are the textures OSM2World's own
# standard style uses for the same surfaces (all CC0, from ambientCG), so the
# streets match the buildings standing on them.
GROUND_TEXTURES = {
    "asphalt": "Asphalt010",        # carriageway
    "paving": "PavingStones072",    # pavements, plazas
    "grass": "Ground003",           # parks, lawns
    "yard": "PavingStones053",      # courtyards and everything unmapped
}


def ground_textures(jar, out, size=1024):
    """Copy colour and normal maps into <out>/ground/ at `size`."""
    src = os.path.join(os.path.dirname(jar), "textures", "cc0textures")
    dst = os.path.join(out, "ground")
    os.makedirs(dst, exist_ok=True)
    for name, folder in GROUND_TEXTURES.items():
        for kind in ("Color", "Normal"):
            cands = [f for f in os.listdir(os.path.join(src, folder))
                     if f.startswith("%s_%s." % (folder, kind))]
            if not cands:
                raise SystemExit("missing texture %s/%s" % (folder, kind))
            out = os.path.join(dst, "%s_%s.jpg" % (name, kind.lower()))
            if os.path.exists(out):
                continue
            # sips ships with macOS; elsewhere fall back to the full-size file
            r = subprocess.run(["sips", "-Z", str(size), "-s", "format", "jpeg",
                                "-s", "formatOptions", "85",
                                os.path.join(src, folder, cands[0]), "--out", out],
                               capture_output=True)
            if r.returncode != 0:
                shutil.copy(os.path.join(src, folder, cands[0]), out)
    return list(GROUND_TEXTURES)


# Image-based lighting: a CC0 sky from Poly Haven, lighting and reflecting in
# every PBR material. Overcast and without the sun in it, so the game's own
# sun stays the only direct light and its direction is never contradicted.
SKY_HDRI = "kloofendal_overcast_puresky"
SKY_URL = "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/%s_1k.hdr" % SKY_HDRI


def sky_environment(out):
    """Copy the sky HDRI into <out>/env/, downloading it once."""
    name = "%s_1k.hdr" % SKY_HDRI
    src = os.path.join(CACHE, "env", name)
    if not os.path.exists(src):
        os.makedirs(os.path.dirname(src), exist_ok=True)
        fetch.download(SKY_URL, src)
    dst = os.path.join(out, "env", name)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if not os.path.exists(dst):
        shutil.copy(src, dst)
    return {"file": "env/" + name, "source": "Poly Haven, %s (CC0)" % SKY_HDRI}


def bfs_distance(sources, passable, nx, nz):
    """Multi-source BFS distance in cells; None where unreachable."""
    n = nx * nz
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
            if ok and dist[kk] is None and passable[kk]:
                dist[kk] = d
                q.append(kk)
    return dist


ATTRIBUTION = [
    "Terrain: Airborne Laserscanning (ALS), Senatsverwaltung fuer "
    "Stadtentwicklung, Bauen und Wohnen Berlin (dl-de/zero-2.0)",
    "Trees: Baumbestand Berlin, Strassen- und Anlagenbaeume (dl-de/zero-2.0)",
    "Street furniture: Strassenbefahrung 2014 and Oeffentliche Beleuchtung, "
    "Senatsverwaltung fuer Stadtentwicklung, Bauen und Wohnen Berlin (dl-de/zero-2.0); "
    "benches also (c) OpenStreetMap contributors (ODbL); 3D models by OSM2World",
    "Sky lighting: Kloofendal Overcast, Greg Zaal / Poly Haven (CC0)",
    "Orthophotos: TrueDOP 2024, Senatsverwaltung fuer Stadtentwicklung, "
    "Bauen und Wohnen Berlin (dl-de/zero-2.0)",
    "Buildings, streets, green space: (c) OpenStreetMap contributors (ODbL), "
    "3D models by OSM2World",
]


def ll_box(e0, n0, e1, n1):
    """(south, west, north, east) around an EPSG:25833 box - the box the OSM
    queries, and so their cache file names, are keyed by."""
    lls = [utm33_inv(e, n) for e in (e0, e1) for n in (n0, n1)]
    return (min(p[1] for p in lls), min(p[0] for p in lls),
            max(p[1] for p in lls), max(p[0] for p in lls))


def crop(vals, nx, c0, r0, w, h):
    """The w x h window at (c0, r0) of a flat row-major grid nx wide."""
    out = []
    for r in range(r0, r0 + h):
        out += vals[r * nx + c0:r * nx + c0 + w]
    return out


def shared_assets(args, out):
    """OSM2World, the ground textures and the sky, copied into `out` once."""
    java, jar = ensure_osm2world(args.osm2world)
    ground = ground_textures(jar, out)
    env = sky_environment(out)
    return java, jar, ground, env


def build(area, out, args, margin=0, log=log):
    """Build one area into the folder `out`. Returns (manifest, nav layers).

    With a margin, everything is worked out over the area grown by that many
    metres - hole filling under buildings, the navigation clean-up, roof
    heights of buildings straddling the edge - and only then cropped back,
    so neighbouring tiles agree along their shared edge. Each building, tree
    and piece of furniture belongs to the one tile its centre lies in. The
    terrain keeps one extra column east and row south, the first of the
    neighbouring tiles, so terrain meshes and height lookups meet without a gap.
    """
    e0, n0, e1, n1 = area
    x0, z0 = e0 - ORIGIN_E, -(n1 - ORIGIN_N)          # north-west corner
    sx, sz = e1 - e0, n1 - n0
    # the working area, margin included
    E0, N0, E1, N1 = e0 - margin, n0 - margin, e1 + margin, n1 + margin
    X0, Z0 = E0 - ORIGIN_E, -(N1 - ORIGIN_N)
    bbox_ll = ll_box(E0, N0, E1, N1)
    os.makedirs(out, exist_ok=True)

    def in_tile(x, z):
        return x0 <= x < x0 + sx and z0 <= z < z0 + sz

    def to_world(e, n_):
        return e - ORIGIN_E, -(n_ - ORIGIN_N)

    # --- bridges: decks out of the terrain ----------------------------------
    log("Bridges from OpenStreetMap, at the laser scan's deck heights ...")
    acache = os.path.join(CACHE, "als")
    grid = (X0, Z0, int(E1 - E0), int(N1 - N0))
    graw = als._window(E0, N0, E1, N1, acache, "ground")[0]
    traw = als._window(E0, N0, E1, N1, acache, "top")[0]
    # station halls: under their roofs the scan sees the roof, not the tracks
    osm_path = osm3d.load_osm(bbox_ll, os.path.join(CACHE, "osm"), args.refresh)
    nodes, ways, rels = osm3d.parse_osm(osm_path)
    decks = bridges.decks(bridges.load(bbox_ll, os.path.join(CACHE, "osm"), args.refresh),
                          graw, traw, grid, bridges.hall_mask(ways, nodes, grid))
    del traw
    log("  %d decks: %s" % (len(decks), ", ".join(
        "%d %s" % (sum(d["kind"] == k for d in decks), k) for k in ("road", "path", "rail"))))

    # --- terrain: ALS ground returns ---------------------------------------
    log("Terrain from the airborne laser scan ...")
    clear, settle = bridges.clearer(decks, grid)
    h, nx, nz, measured, raised = als.terrain(E0, N0, E1, N1, acache, clear=clear, settle=settle)
    # --- ground cover ------------------------------------------------------
    log("Ground cover from OpenStreetMap ...")
    gdata = groundcover.load(bbox_ll, os.path.join(CACHE, "osm"), args.refresh)
    cover, passages, counts, water = groundcover.build(
        gdata, X0, Z0, nx, nz, os.path.join(out, "cover.png"), bridges.footprint(decks, grid))
    log("  %(road)d roads, %(path)d paths, %(green)d green areas, %(water)d water" % counts
        + "  -> cover.png %d x %d (%.0f KB)" % (cover["w"], cover["h"], cover["bytes"] / 1024))

    # --- water: flat, at its measured level --------------------------------
    log("Water surfaces at the laser scan's level ...")
    n = nx * nz
    wet = [water.get(X0 + (k % nx) + 0.5, Z0 + (k // nx) + 0.5) > 127 for k in range(n)]
    under_deck = bridges.mask(decks, grid)
    wlev, wbx = water_mod.levels(wet, graw, nx, nz, under_deck)
    sunk = water_mod.settle(h, wet, wlev, wbx, nx, nz, under_deck)
    del graw
    measured_w = [v for v in wlev if v is not None]
    log("  %d blocks of water, levels %s; %d terrain cells pushed under the surface"
        % (len(measured_w), "%.1f .. %.1f m" % (min(measured_w), max(measured_w)) if measured_w else "-",
           sunk))

    terr = Terrain([v - ORIGIN_H for v in h], nx, nz, X0, Z0)
    if margin:
        keep = Terrain(crop(terr.h, nx, margin, margin, sx + 1, sz + 1), sx + 1, sz + 1, x0, z0)
    else:
        keep = terr
    blob, hmin, hmax = keep.to_bytes()
    with open(os.path.join(out, "terrain.bin"), "wb") as fh:
        fh.write(blob)
    log("  terrain %d x %d at 1 m, %.0f%% measured, %.1f .. %.1f m above sea level"
        % (keep.nx, keep.nz, measured * 100, hmin + ORIGIN_H, hmax + ORIGIN_H))
    log("  %d cells raised out of stairwells, ramps and light wells" % raised)
    bmeta = bridges.write(decks, x0, z0, sx, sz, out)
    if bmeta:
        log("  -> bridges.json: %d deck pieces (%.0f KB)" % (bmeta["count"], bmeta["bytes"] / 1024))
    elif os.path.exists(os.path.join(out, "bridges.json")):
        os.remove(os.path.join(out, "bridges.json"))
    wmeta = water_mod.write(wet, wlev, wbx, nx, nz, X0, Z0, x0, z0, sx, sz, out)
    if wmeta:
        log("  -> water.json (%.0f KB)" % (wmeta["bytes"] / 1024))
    elif os.path.exists(os.path.join(out, "water.json")):
        os.remove(os.path.join(out, "water.json"))

    # --- orthophotos -------------------------------------------------------
    log("True orthophotos (20 cm) ...")
    ortho_meta = ortho.build(e0, n0, e1, n1, x0, z0, out, os.path.join(CACHE, "dop"))
    log("  %d x %d tiles at %.1f m (%.1f MB) + %d px overview"
        % (ortho_meta["nx"], ortho_meta["nz"], ortho_meta["res"],
           ortho_meta["bytes"] / 1048576, ortho_meta["overview"]["w"]))

    # --- buildings ---------------------------------------------------------
    log("Buildings: OSM Simple 3D Buildings via OSM2World ...")
    java, jar = ensure_osm2world(args.osm2world)
    log("  %d ways, %d relations" % (len(ways), len(rels)))
    # heights OSM lacks, measured from the laser scan's roof returns
    top = als.roofs(E0, N0, E1, N1, os.path.join(CACHE, "als"))
    patched = os.path.splitext(osm_path)[0] + "_als.osm"
    counts, with_parts = osm3d.complete_3d_tags(
        osm_path, patched, nodes, ways, rels, h, top, (X0, Z0, nx, nz))
    log("  roofs fitted to the laser scan: %s" % ", ".join(
        "%d %s" % (v, k) for k, v in sorted(counts["roofs"].items(), key=lambda kv: -kv[1])))
    log("  %d buildings split by measured height into %d parts"
        % (counts["split"], counts["parts"]))
    log("  %d heights measured, %d storey counts estimated; %d outlines left to their parts"
        % (counts["heights"], counts["levels"], with_parts))
    log("  %d underground buildings and parts left out" % counts["underground"])
    glb = os.path.splitext(patched)[0] + "_textured_lod%d_tex%d.glb" % (args.lod, args.texture_res)
    t0 = time.time()
    if ways:
        osm3d.run_osm2world(patched, glb, java, jar, args.lod, texture_res=args.texture_res)
        objects, origin = osm3d.read_glb(glb)
        log("  OSM2World: %d objects (%.0fs)" % (len(objects), time.time() - t0))

    ncx = int(math.ceil(sx / CHUNK))
    ncz = int(math.ceil(sz / CHUNK))

    def chunk_of(x, z):
        c, r = int((x - x0) // CHUNK), int((z - z0) // CHUNK)
        return (c, r) if 0 <= c < ncx and 0 <= r < ncz else None

    bst = None
    if ways:
        to_utm, fit = osm3d.fit_projection(objects, origin, nodes)
        log("  reprojection fitted on %(pairs)d of %(of)d footprint vertices, "
            "residual median %(median).3f m, p99 %(p99).3f m" % fit)
        bst = osm3d.relocate(
            glb, os.path.join(out, "buildings.glb"), to_utm, terr.height, chunk_of, in_tile)
        if bst["buildings"]:
            # one mesh per (chunk, material) instead of thousands: the game
            # parses the file in one go (pipeline/pack_buildings.py)
            packed = pack_buildings.pack(os.path.join(out, "buildings.glb"), x0, z0)
            bst["bytes"] = os.path.getsize(os.path.join(out, "buildings.glb"))
            log("  packed: %d meshes -> %d" % packed)
    if not bst or not bst["buildings"]:
        # forest, lake or field: no buildings to draw
        if os.path.exists(os.path.join(out, "buildings.glb")):
            os.remove(os.path.join(out, "buildings.glb"))
        bst = {"buildings": 0, "triangles": 0, "tallest": 0.0, "bytes": 0,
               "chunks": {}, "tinted": 0, "dropped": 0, "sunk": [], "draped": []}
    log("  %d buildings, %s triangles, tallest %.0f m -> buildings.glb (%.1f MB)"
        % (bst["buildings"], f"{bst['triangles']:,}", bst["tallest"],
           bst["bytes"] / 1048576))
    log("  %d untagged surfaces moved onto palette tints; %d non-building objects dropped"
        % (bst["tinted"], bst["dropped"]))
    sunk = bst["sunk"]
    log("  placement check: %d buildings have a side buried more than 2 m (ground steps under them)%s"
        % (len(sunk), "" if not sunk else ", worst: " + ", ".join(
            "%s %.1f m" % (n.replace("Building ", ""), d) for d, n in sunk[:5])))
    if bst["draped"]:
        log("  %d very large buildings follow the terrain: %s"
            % (len(bst["draped"]), ", ".join(n.replace("Building ", "") for n in bst["draped"])))

    # --- trees -------------------------------------------------------------
    solid = Grid(X0, Z0, 1.0, nx, nz)          # building outlines, reused for nav
    shapes = osm3d.footprints(nodes, ways, rels)
    for rings in shapes:
        solid.polygon(rings, 1)

    log("Trees from the Baumkataster ...")
    feats = trees_mod.load(e0, n0, e1, n1, os.path.join(CACHE, "trees"), args.refresh)
    tmeta, tree_list = trees_mod.build(
        feats, to_world, terr.height, in_tile, os.path.join(out, "trees.bin"))
    log("  %d trees (%d with a size estimated from girth or genus)"
        % (tmeta["count"], tmeta["estimated"]))

    # --- street furniture ----------------------------------------------------
    log("Street furniture from the Strassenbefahrung 2014 ...")
    fcache = os.path.join(CACHE, "furniture")
    fdata = street_furniture.load(e0, n0, e1, n1, fcache, args.refresh)
    pmeta, pcounts, pmissing, pskipped = street_furniture.build(
        fdata, gdata, java, jar, os.path.join(fcache, "work_%d_%d_%d_%d" % area),
        to_world, bridges.surface(decks, grid, terr.height), in_tile, out)
    log("  %d objects: %s -> props.glb (%.1f MB), %d models"
        % (pmeta["count"], ", ".join("%d %s" % (v, k) for k, v in
                                     sorted(pcounts.items(), key=lambda kv: -kv[1])),
           pmeta["bytes"] / 1048576, len(pmeta["kinds"])))
    if pskipped:
        log("  left out: %s" % ", ".join("%d %s" % (v, k) for k, v in sorted(pskipped.items())))
    if pmissing:
        log("  OSM2World modelled nothing for: %s" % ", ".join(pmissing))

    # --- navigation --------------------------------------------------------
    log("Navigation grid ...")
    # courtyard gateways: ways mapped through a building stay open
    for pts in passages:
        solid.polyline(pts, 1.4, 0)
    trunk = bytearray(n)
    canopy = Grid(X0, Z0, 1.0, nx, nz)
    for tx, tz, _th, crown, _d in tree_list:
        c, r = int(tx - X0), int(tz - Z0)
        if 0 <= c < nx and 0 <= r < nz:
            trunk[r * nx + c] = 1
        canopy.disc(tx, tz, crown * 0.5, 1)
    log("  %d building outlines, %d passages cut through them"
        % (len(shapes), len(passages)))

    hgt = terr.h
    steep = [False] * n
    for r in range(nz):
        for c in range(nx):
            k = r * nx + c
            d = 0.0
            if c + 1 < nx:
                d = abs(hgt[k + 1] - hgt[k])
            if r + 1 < nz:
                d = max(d, abs(hgt[k + nx] - hgt[k]))
            steep[k] = d > args.max_slope
    blocked = [solid.data[k] or trunk[k] or wet[k] for k in range(n)]
    walk = [not blocked[k] and not steep[k] for k in range(n)]
    # close pinholes and drop specks, then re-apply the hard obstacles: no
    # tidying may make the inside of a wall walkable
    walk = ng._mask_filter(walk, nx, nz, 1, True)
    walk = ng._mask_filter(walk, nx, nz, 1, False)
    walk = [walk[k] and not blocked[k] for k in range(n)]
    seen, comps = ng.components(walk, nx, nz)
    keep_ids = {cid for cells, cid in comps if cells >= 400} | ({comps[0][1]} if comps else set())
    walk = [walk[k] and seen[k] in keep_ids for k in range(n)]
    nwalk = sum(walk)
    log("  walkable %.1f%% of the area, %d regions kept, largest %.1f%%"
        % (100 * nwalk / n, len(keep_ids), 100 * comps[0][0] / max(nwalk, 1) if comps else 0))
    drive = ng._mask_filter(walk, nx, nz, args.car_clearance, False)
    log("  drivable %.1f%% of walkable" % (100 * sum(drive) / max(nwalk, 1)))

    sky_raw = [not solid.data[k] and not canopy.data[k] for k in range(n)]
    sky_open = ng._mask_filter(sky_raw, nx, nz, 4, False)
    flags = bytearray(n)
    for k in range(n):
        flags[k] = ((ng.WALKABLE if walk[k] else 0) | (ng.DRIVABLE if drive[k] else 0)
                    | (ng.OPEN_SKY if sky_open[k] else 0) | (ng.SKY_RAW if sky_raw[k] else 0)
                    | (ng.BUILDING if solid.data[k] else 0))
    hnav = terr.h
    if margin:
        def cut(v):
            return crop(v, nx, margin, margin, sx, sz)
        flags = bytearray(cut(list(flags)))
        hnav, walk, drive, sky_open = cut(hnav), cut(walk), cut(drive), cut(sky_open)
    nblob, nmeta = ng.to_bytes(x0, z0, 1.0, sx, sz, hnav, flags)
    with open(os.path.join(out, "nav.bin"), "wb") as fh:
        fh.write(nblob)

    # --- manifest ----------------------------------------------------------
    world = [x0, round(hmin, 1), z0, x0 + sx, round(hmax + bst["tallest"], 1), z0 + sz]
    clon, clat = utm33_inv((e0 + e1) / 2, (n0 + n1) / 2)
    manifest = {
        "kind": "osm3d",
        "origin": {"e": ORIGIN_E, "n": ORIGIN_N, "h": ORIGIN_H},
        "area": {"e0": e0, "n0": n0, "e1": e1, "n1": n1},
        "world": world,
        "centre": {"x": x0 + sx / 2, "z": z0 + sz / 2,
                   "lon": round(clon, 6), "lat": round(clat, 6)},
        "terrain": {"file": "terrain.bin", "minX": x0, "minZ": z0, "cell": 1.0,
                    "nx": keep.nx, "nz": keep.nz, "hmin": round(hmin, 2), "hmax": round(hmax, 2)},
        "cover": cover,
        "ortho": ortho_meta,
        "groundTextures": {k: {"color": "ground/%s_color.jpg" % k,
                               "normal": "ground/%s_normal.jpg" % k}
                           for k in GROUND_TEXTURES},
        "trees": tmeta,
        "props": pmeta,
        "nav": {"file": "nav.bin", "cell": 1.0, "nx": sx, "nz": sz,
                "minX": x0, "minZ": z0, **nmeta},
        "attribution": ATTRIBUTION,
    }
    if bmeta:
        manifest["bridges"] = bmeta
    if wmeta:
        manifest["water"] = wmeta
    if bst["buildings"]:
        manifest["buildings"] = {
            "file": "buildings.glb", "chunk": CHUNK, "chunks": bst["chunks"],
            "count": bst["buildings"], "triangles": bst["triangles"], "bytes": bst["bytes"],
            "packed": True}
    nav = {"walk": walk, "drive": drive, "sky_open": sky_open,
           "nx": sx, "nz": sz, "x0": x0, "z0": z0}
    return manifest, nav


def pick_spawn(nav, old):
    """A pinned spawn (pipeline/set_spawn.py) survives a rebuild if it still
    lands on walkable ground; otherwise pick a pavement beside a street."""
    walk, drive, sky_open = nav["walk"], nav["drive"], nav["sky_open"]
    nx, nz, x0, z0 = nav["nx"], nav["nz"], nav["x0"], nav["z0"]
    n = nx * nz
    spawn = old
    if spawn:
        c, r = int(spawn["x"] - x0), int(spawn["z"] - z0)
        if not (0 <= c < nx and 0 <= r < nz and walk[r * nx + c]):
            log("  pinned spawn is no longer walkable; choosing a new one")
            spawn = None
    if not spawn:
        clearance = bfs_distance([k for k in range(n) if not walk[k]], [True] * n, nx, nz)
        to_road = bfs_distance([k for k in range(n) if drive[k]], [True] * n, nx, nz)
        best, best_s = None, -1e18
        cx, cz = (nx - 1) / 2, (nz - 1) / 2
        for k in range(n):
            if not walk[k] or drive[k] or not sky_open[k]:
                continue
            cl, rd = clearance[k], to_road[k]
            if cl is None or rd is None or not 1 <= rd <= 6:
                continue
            s = min(cl, 6) * 3.0 - abs(rd - 3) * 2.0 - math.hypot(k % nx - cx, k // nx - cz) * 0.03
            if s > best_s:
                best, best_s = k, s
        if best is not None:
            spawn = {"x": round(x0 + best % nx + 0.5, 1), "z": round(z0 + best // nx + 0.5, 1)}
    if spawn:
        log("  spawn at x %.0f z %.0f%s" % (spawn["x"], spawn["z"],
                                            " (pinned)" if "facing" in spawn else ""))
    return spawn


def add_args(ap):
    ap.add_argument("--refresh", action="store_true",
                    help="re-query OpenStreetMap and the tree cadastre")
    ap.add_argument("--osm2world", help="path to OSM2World.jar")
    ap.add_argument("--lod", type=int, default=2,
                    help="OSM2World level of detail; 4 models every window "
                         "and costs ~100x the triangles")
    ap.add_argument("--texture-res", type=int, default=1024,
                    help="largest building texture edge in px; OSM2World's CC0 "
                         "textures are 2048, its own export default is 512")
    ap.add_argument("--max-slope", type=float, default=0.55)
    ap.add_argument("--car-clearance", type=int, default=2)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--area", nargs=4, type=int, metavar=("E0", "N0", "E1", "N1"),
                    default=DEFAULT_AREA, help="EPSG:25833 box, metres")
    add_args(ap)
    args = ap.parse_args()

    e0, n0, e1, n1 = args.area
    log("Area E %d..%d  N %d..%d  (%.1f x %.1f km)"
        % (e0, e1, n0, n1, (e1 - e0) / 1000, (n1 - n0) / 1000))
    t_all = time.time()
    _java, jar, ground_tex, env = shared_assets(args, OUT)
    log("Shared: ground materials from OSM2World's CC0 library (%s), sky lighting %s"
        % (", ".join(ground_tex), env["source"]))
    manifest, nav = build(tuple(args.area), OUT, args)
    manifest["environment"] = env

    mpath = os.path.join(OUT, "world.json")
    old = json.load(open(mpath)) if os.path.exists(mpath) else {}
    spawn = pick_spawn(nav, old.get("spawn"))
    if spawn:
        manifest["spawn"] = spawn
    with open(mpath, "w") as fh:
        json.dump(manifest, fh, indent=1)
    log("Wrote world.json - done in %.0fs" % (time.time() - t_all))
    return 0


if __name__ == "__main__":
    sys.exit(main())
