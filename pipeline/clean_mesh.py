#!/usr/bin/env python3
"""Clean the photogrammetric mesh against the open reference data.

The mesh is one photographed skin over everything, and two of its artifacts
hurt most in a game: lumps on the street (parked cars, bollards, noise) that
the player walks through, and ghosts - cranes, scaffolding, half-reconstructed
fragments - standing in mid-air. Both can be judged against data that knows
better: the laser-scan terrain, the laser scan's highest returns, and the OSM
building outlines.

  1. Ground flattening. Vertices within a band around the terrain, outside
     buildings, are pressed onto the laser-scan ground. Cars and street
     furniture stay visible as photo texture, the way they are in an
     orthophoto, but the ground underfoot is flat and agrees with the
     terrain the game walks on.
  2. Ghost removal. Triangles standing well above the ground where the laser
     scan saw nothing that high, and that are not inside a mapped building,
     are deleted. Trees survive, since the scan sees their crowns; buildings
     finished after the scan survive if OSM has them.

Run after build_world.py and build_mesh.py. The untouched tiles are kept as
m_<tile>.raw.bin, so this can be re-run with other settings.

    python3 pipeline/clean_mesh.py
    python3 pipeline/clean_mesh.py --band 2.0 --ghost 4.0

The result is derived from the mesh and carries its licence: local,
non-commercial use only unless Berlin Partner agrees otherwise.
"""
import argparse
import json
import os
import shutil
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import als                                                       # noqa: E402
import navgrid as ng                                             # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "public", "data")
CACHE = os.path.join(ROOT, "cache")
QMAX = 65535


def log(m):
    print(m, flush=True)


class Reference:
    """Terrain, building mask and laser top surface on the world grid."""

    def __init__(self, world):
        t = open(os.path.join(OUT, world["terrain"]["file"]), "rb").read()
        self.x0, self.z0, self.cell = struct.unpack_from("<3f", t, 4)
        self.nx, self.nz = struct.unpack_from("<2I", t, 16)
        hmin, hs = struct.unpack_from("<2f", t, 24)
        n = self.nx * self.nz
        self.h = [hmin + v * hs for v in struct.unpack_from("<%dH" % n, t, 32)]
        nav = open(os.path.join(OUT, world["nav"]["file"]), "rb").read()
        flags = nav[32 + n * 2:32 + n * 3]
        # outlines widened by 2 m: wall bases and eaves are not "ground"
        self.building = ng._mask_filter([f & ng.BUILDING != 0 for f in flags],
                                        self.nx, self.nz, 2, True)
        a = world["area"]
        top = als.roofs(a["e0"], a["n0"], a["e1"], a["n1"], os.path.join(CACHE, "als"))
        origin_h = world["origin"]["h"]
        # highest laser return above the (filled) ground, per cell; the scan
        # thins out at crowns' edges, so look at the 3 x 3 neighbourhood
        raw = [(v - origin_h) - self.h[k] if v == v else 0.0 for k, v in enumerate(top)]
        self.seen = ng._filter2d(raw, self.nx, self.nz, 1, True)

    def index(self, x, z):
        c = int(x - self.x0)
        r = int(z - self.z0)
        if 0 <= c < self.nx and 0 <= r < self.nz:
            return r * self.nx + c
        return -1

    def ground(self, x, z):
        fx, fz = x - self.x0 - 0.5, z - self.z0 - 0.5
        i, j = int(fx // 1), int(fz // 1)
        tx, tz = fx - i, fz - j

        def at(a, b):
            a = min(max(a, 0), self.nx - 1)
            b = min(max(b, 0), self.nz - 1)
            return self.h[b * self.nx + a]
        return ((at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - tz)
                + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * tz)


def read_tile(path):
    raw = open(path, "rb").read()
    assert raw[:4] == b"BTM1", path
    qmin = struct.unpack_from("<3f", raw, 4)
    qs = struct.unpack_from("<3f", raw, 16)
    count, = struct.unpack_from("<I", raw, 28)
    ng_, = struct.unpack_from("<H", raw, 32)
    o = 34
    groups = []
    for _ in range(ng_):
        groups.append(struct.unpack_from("<HII", raw, o))
        o += 10
    planes = []
    for _ in range(5):
        planes.append(list(struct.unpack_from("<%dH" % count, raw, o)))
        o += count * 2
    return qmin, qs, groups, planes


def write_tile(path, qmin, qs, groups, planes):
    count = len(planes[0])
    out = bytearray(b"BTM1")
    out += struct.pack("<3f", *qmin) + struct.pack("<3f", *qs)
    out += struct.pack("<I", count) + struct.pack("<H", len(groups))
    for g in groups:
        out += struct.pack("<HII", *g)
    for p in planes:
        out += struct.pack("<%dH" % count, *p)
    with open(path + ".part", "wb") as fh:
        fh.write(out)
    os.replace(path + ".part", path)


def clean_tile(path, ref, band, ghost):
    qmin, qs, groups, (X, Y, Z, U, V) = read_tile(path)
    n = len(X)
    wx = [qmin[0] + q * qs[0] for q in X]
    wy = [qmin[1] + q * qs[1] for q in Y]
    wz = [qmin[2] + q * qs[2] for q in Z]

    # --- 1. ground flattening -----------------------------------------------
    flattened = 0
    for i in range(n):
        k = ref.index(wx[i], wz[i])
        if k < 0 or ref.building[k]:
            continue
        g = ref.ground(wx[i], wz[i])
        # Below ground by up to 1.5 m is reconstruction noise; deeper is a
        # real opening (a stairwell) and stays. Up to `band` above is clutter.
        if g - 1.5 < wy[i] < g + band:
            wy[i] = g + 0.03
            flattened += 1

    # --- 2. ghost removal ----------------------------------------------------
    # A ghost is high up, outside mapped buildings, and more than `ghost`
    # metres above anything the laser scan saw there. That is true of cranes,
    # but also of buildings finished after the scan and not yet in OSM - so
    # only *thin* ghosts go: the ghost cells are closed, then opened by 3 m;
    # whatever survives is wider than ~7 m and therefore a building, and stays.
    tri_cell = []
    ghost_cells = set()
    for t in range(n // 3):
        a, b, c = 3 * t, 3 * t + 1, 3 * t + 2
        cx = (wx[a] + wx[b] + wx[c]) / 3
        cz = (wz[a] + wz[b] + wz[c]) / 3
        k = ref.index(cx, cz)
        is_ghost = False
        if k >= 0 and not ref.building[k]:
            above = (wy[a] + wy[b] + wy[c]) / 3 - ref.ground(cx, cz)
            is_ghost = above > ghost and above > ref.seen[k] + ghost
        if is_ghost:
            ghost_cells.add(k)
        tri_cell.append(k if is_ghost else -1)
    wide = set()
    if ghost_cells:
        # opening of the ghost mask, on a window around it only
        cs = [k % ref.nx for k in ghost_cells]
        rs = [k // ref.nx for k in ghost_cells]
        c0, c1 = max(0, min(cs) - 3), min(ref.nx - 1, max(cs) + 3)
        r0, r1 = max(0, min(rs) - 3), min(ref.nz - 1, max(rs) + 3)
        w, h = c1 - c0 + 1, r1 - r0 + 1
        mask = [((r0 + j) * ref.nx + c0 + i) in ghost_cells for j in range(h) for i in range(w)]
        # close first: a building shell under construction is full of holes
        # (open floors, gaps between slabs) and would erode away otherwise
        closed = ng._mask_filter(ng._mask_filter(mask, w, h, 2, True), w, h, 2, False)
        core = ng._mask_filter(ng._mask_filter(closed, w, h, 3, False), w, h, 3, True)
        wide = {(r0 + j) * ref.nx + c0 + i for j in range(h) for i in range(w) if core[j * w + i]}
    # Cranes usually stand right beside the building they are building, so
    # they merge into its kept area. Within each kept area, whatever rises
    # more than 6 m above the area's typical height is cut as well: a shell
    # is ~20 m, a crane's mast and jib 40 m and more.
    tri_top = {}
    for t, k in enumerate(tri_cell):
        if k >= 0 and k in wide:
            a = 3 * t
            y = max(wy[a], wy[a + 1], wy[a + 2]) - ref.ground(wx[a], wz[a])
            if y > tri_top.get(k, -1e9):
                tri_top[k] = y
    comp = {}
    for start in wide:
        if start in comp:
            continue
        stack, members = [start], []
        comp[start] = start
        while stack:
            k = stack.pop()
            members.append(k)
            for j in (k - 1, k + 1, k - ref.nx, k + ref.nx):
                if j in wide and j not in comp:
                    comp[j] = start
                    stack.append(j)
        tops = sorted(tri_top[k] for k in members if k in tri_top)
        limit = (tops[len(tops) // 2] if tops else 0.0) + 6.0
        for k in members:
            comp[k] = limit
    keep = [True] * (n // 3)
    removed = 0
    for t, k in enumerate(tri_cell):
        if k < 0:
            continue
        if k in wide:
            a = 3 * t
            if (wy[a] + wy[a + 1] + wy[a + 2]) / 3 - ref.ground(wx[a], wz[a]) <= comp[k]:
                continue
        keep[t] = False
        removed += 1

    # --- rewrite, keeping each atlas page's triangles contiguous -------------
    # Same quantisation as the original tile, so the game can swap between
    # the two (K) without new shader uniforms; ground pressed below the
    # original minimum simply clamps to it.
    lo_y, qs_y = qmin[1], qs[1]
    planes = [[], [], [], [], []]
    out_groups = []
    for page, start, count in groups:
        s0 = len(planes[0])
        for t in range(start // 3, (start + count) // 3):
            if not keep[t]:
                continue
            for i in (3 * t, 3 * t + 1, 3 * t + 2):
                planes[0].append(X[i])
                planes[1].append(min(QMAX, max(0, int((wy[i] - lo_y) / qs_y + 0.5))))
                planes[2].append(Z[i])
                planes[3].append(U[i])
                planes[4].append(V[i])
        if len(planes[0]) > s0:
            out_groups.append((page, s0, len(planes[0]) - s0))
    write_tile(path, qmin, qs, out_groups, planes)
    return n, flattened, n // 3, removed


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--band", type=float, default=2.0,
                    help="metres above the ground that count as street clutter")
    ap.add_argument("--ghost", type=float, default=4.0,
                    help="metres above the laser surface before a triangle is a ghost")
    args = ap.parse_args()

    world = json.load(open(os.path.join(OUT, "world.json")))
    mesh = json.load(open(os.path.join(OUT, "mesh_manifest.json")))
    log("Reference: laser terrain, laser top surface, OSM outlines ...")
    ref = Reference(world)
    tv = tf = tt = tr = 0
    for key, info in sorted(mesh["tiles"].items()):
        path = os.path.join(OUT, info["geometry"])
        raw = path.replace(".bin", ".raw.bin")
        if not os.path.exists(raw):
            shutil.copy(path, raw)        # keep the untouched tile
        shutil.copy(raw, path)            # always clean from the original
        n, f, t, r = clean_tile(path, ref, args.band, args.ghost)
        log("  %-12s %8d vertices, %5.1f%% flattened; %7d triangles, %d ghosts removed"
            % (key, n, 100.0 * f / n, t, r))
        tv += n; tf += f; tt += t; tr += r
    log("Done: %.1f%% of vertices flattened onto the ground, %d of %d triangles removed"
        % (100.0 * tf / tv, tr, tt))
    return 0


if __name__ == "__main__":
    sys.exit(main())
