"""Retaining walls from the laser scan, cut into the terrain as straight lines.

A wall running at an angle to the 1 m terrain grid comes out as a staircase:
each cell is either up or down, and the mesh between their centres draws a
jagged slope (the bank behind the DDR-Museum, railway cuttings). OSM maps few
of Berlin's retaining walls, so they are found in the scan instead: cells a
step of STEP or more above their neighbour, the upper side outlined as a
polygon and simplified, so the staircase becomes the straight line the wall
follows. Where that line has a real step across it, the 4 m terrain cells
along it are replaced like the shorelines' (shorelines.py): triangles cut to
the line, the upper side at the upper level, the lower at the lower, and a
vertical face between them. The pieces are added to shorelines.json, which
the game already reads as the ground and draws, walls and all.
"""
import json
import math
import os

import numpy as np
from shapely import LineString, Point, Polygon, box, constrained_delaunay_triangles, prepare, unary_union
from shapely.strtree import STRtree

from bridge_surfaces import polygons
from geo import ORIGIN_H
from shorelines import _lines

STEP = 1.2          # metres between neighbouring cells that make a wall
SIDE = 0.4          # metres the next cell on either side may differ: a wall, not a slope
ZONE = 3            # cells either side of a step searched for its two levels
SIMPLIFY = 0.8      # metres: a 1 m staircase is a straight line within this
SAMPLE = 1.6        # metres either side of the line where its levels are read
MIN_LENGTH = 4.0    # metres: shorter steps are kerbs, stairs and noise
BAND = 1.6          # metres from the line where the ground takes its level
PATCH = 4           # terrain cells replaced, as shorelines.STEP


def _levels(H, ok):
    """Per cell of the step zone the level between its two sides, else NaN."""
    nz, nx = H.shape
    mid = np.full(H.shape, np.nan)
    # a step between cells k and k+1 along an axis, with cells k-1 and k+2
    # level with their sides: a wall, not a steep slope - an embankment or a
    # park hill drops over several cells
    for axis in (0, 1):
        T = H if axis == 0 else H.T
        O = ok if axis == 0 else ok.T
        a, b = T[1:-2], T[2:-1]
        before, after = T[:-3], T[3:]
        step = ((np.abs(a - b) >= STEP) & (np.abs(before - a) <= SIDE) & (np.abs(after - b) <= SIDE)
                & O[1:-2] & O[2:-1] & O[:-3] & O[3:])
        rows, cols = np.nonzero(step)
        rows = rows + 1
        if axis == 1:
            rows, cols = cols, rows
        a, b = H[:-1, :] if axis == 0 else H[:, :-1], H[1:, :] if axis == 0 else H[:, 1:]
        m = (a[rows, cols] + b[rows, cols]) / 2
        for dr in range(-ZONE, ZONE + 1 + (axis == 0)):
            for dc in range(-ZONE, ZONE + 1 + (axis == 1)):
                r, c = rows + dr, cols + dc
                keep = (r >= 0) & (r < nz) & (c >= 0) & (c < nx)
                # the nearest step decides; first come is near enough here
                cur = mid[r[keep], c[keep]]
                mid[r[keep], c[keep]] = np.where(np.isnan(cur), m[keep], cur)
    return mid


def find(h, grid, skip=None):
    """Wall lines in the 1 m terrain h (absolute heights, row-major from the
    grid's corner, samples at cell centres). skip: cells not to look at -
    water, decks. Returns (upper polygon, [(a, b, hi_a, lo_a, hi_b, lo_b)])."""
    X0, Z0, nx, nz = grid
    H = np.asarray(h, dtype=float).reshape(nz, nx)
    ok = np.ones(H.shape, bool) if skip is None else ~np.asarray(skip, bool).reshape(nz, nx)
    mid = _levels(H, ok)
    upper = (H > mid) & ok
    rows, cols = np.nonzero(upper)
    if not len(rows):
        return None, []
    up = unary_union([box(X0 + c, Z0 + r, X0 + c + 1, Z0 + r + 1) for r, c in zip(rows, cols)])
    up = up.simplify(SIMPLIFY, preserve_topology=True)

    def at(x, z):
        c = min(nx - 1, max(0, int(math.floor(x - X0))))
        r = min(nz - 1, max(0, int(math.floor(z - Z0))))
        return H[r, c] if ok[r, c] else np.nan

    def level(x, z, nx_, nz_, sign):
        vals = [at(x + nx_ * d * sign, z + nz_ * d * sign) for d in (SAMPLE - 0.5, SAMPLE, SAMPLE + 0.5)]
        vals = [v for v in vals if v == v]
        return sorted(vals)[len(vals) // 2] if vals else None

    segments = []
    for poly in polygons(up):
        for ring in [poly.exterior] + list(poly.interiors):
            pts = list(ring.coords)
            # which way is out of the upper side
            for a, b in zip(pts, pts[1:]):
                dx, dz = b[0] - a[0], b[1] - a[1]
                length = math.hypot(dx, dz)
                if length < 1e-6:
                    continue
                nx_, nz_ = -dz / length, dx / length
                mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
                if poly.contains(Point(mx + nx_ * 0.3, mz + nz_ * 0.3)):
                    nx_, nz_ = -nx_, -nz_

                def step(x, z):
                    hi, lo = level(x, z, nx_, nz_, -1), level(x, z, nx_, nz_, 1)
                    return (hi, lo) if hi is not None and lo is not None and hi - lo >= STEP else None
                # in metre pieces, judged at their middles: the corners of
                # the simplified outline read the ground round the corner
                n = max(1, math.ceil(length))
                for i in range(n):
                    p = (a[0] + dx * i / n, a[1] + dz * i / n)
                    q = (a[0] + dx * (i + 1) / n, a[1] + dz * (i + 1) / n)
                    m = step((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
                    if m is None:
                        continue
                    sp, sq = step(*p) or m, step(*q) or m
                    segments.append((p, q, sp[0], sp[1], sq[0], sq[1]))
    # join, and drop the short ones: a kerb, a step, a car on the scan
    lines = unary_union([LineString([s[0], s[1]]) for s in segments])
    lines = [l for l in getattr(lines, "geoms", [lines]) if not l.is_empty]
    merged = unary_union(lines)
    from shapely import line_merge
    merged = line_merge(merged)
    keep = [l for l in getattr(merged, "geoms", [merged]) if l.length >= MIN_LENGTH]
    tree = STRtree(keep) if keep else None
    out = []
    for s in segments:
        mid_pt = Point((s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2)
        if tree is not None and any(keep[i].distance(mid_pt) < 1e-6 for i in tree.query(mid_pt.buffer(1e-3))):
            out.append(s)
    return up, out


def _tri(points):
    """A triangle's corners, counter-clockwise as the terrain mesh has them."""
    pts = list(points)[:3]
    cross = (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0])
    if abs(cross) < 1e-8:
        return None
    return pts[::-1] if cross > 0 else pts


def build(h, grid, tile_bounds, out, skip=None):
    """Find the walls in h, cut them into the terrain and add them to the
    tile's shorelines.json. h is adjusted in place along them, but not in
    the cells the shorelines replaced, nor at their corners. Returns the
    manifest entry for shorelines.json, or None if nothing was added."""
    X0, Z0, nx, nz = grid
    x0, z0, x1, z1 = tile_bounds
    up, segs = find(h, grid, skip)
    if not segs:
        return None
    prepare(up)
    path = os.path.join(out, "shorelines.json")
    cols, rows = math.ceil((x1 - x0) / PATCH), math.ceil((z1 - z0) / PATCH)
    if os.path.exists(path):
        with open(path) as fh:
            data = json.load(fh)
    else:
        data = {"step": PATCH, "cols": cols, "cells": [], "top": {"v": [], "i": [], "r": []},
                "walls": {"v": [], "i": []}}
    data["source"] = "OpenStreetMap water polygons; ALS Berlin bank heights and retaining walls"
    shore = set(data["cells"])
    tile = box(x0 + 0.5, z0 + 0.5, x1 + 0.5, z1 + 0.5)

    lines = [LineString([s[0], s[1]]) for s in segs]
    # the cells a wall runs through: only there do triangles straddle it
    patch = set()
    for a, b, *_ in segs:
        dx, dz = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dz)
        for i in range(int(length / 0.25) + 1):
            t = min(1, i * 0.25 / length)
            c = math.floor((a[0] + dx * t - x0 - 0.5) / PATCH)
            r = math.floor((a[1] + dz * t - z0 - 0.5) / PATCH)
            if 0 <= c < cols and 0 <= r < rows:
                patch.add(r * cols + c)
    patch -= shore
    if not patch:
        return None
    area = unary_union([box(x0 + 0.5 + (k % cols) * PATCH, z0 + 0.5 + (k // cols) * PATCH,
                            x0 + 0.5 + (k % cols + 1) * PATCH, z0 + 0.5 + (k // cols + 1) * PATCH) for k in patch])
    tree = STRtree(lines)

    def wall_near(x, z, reach):
        """The nearest wall within reach: (distance, hi, lo) there."""
        best = None
        for i in tree.query(Point(x, z).buffer(reach)):
            a, b, hia, loa, hib, lob = segs[i]
            dx, dz = b[0] - a[0], b[1] - a[1]
            t = min(1, max(0, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz or 1)))
            d = math.hypot(x - a[0] - dx * t, z - a[1] - dz * t)
            if d < reach and (best is None or d < best[0]):
                best = (d, hia + (hib - hia) * t, loa + (lob - loa) * t)
        return best

    def shore_corner(c, r):
        """Is terrain vertex (c, r) on a cell the shorelines replaced, edges included?"""
        fc, fr = (X0 + c - x0) / PATCH, (Z0 + r - z0) / PATCH
        return any(0 <= ci < cols and 0 <= ri < rows and ri * cols + ci in shore
                   for ci in {math.floor(fc), math.ceil(fc) - 1} for ri in {math.floor(fr), math.ceil(fr) - 1})

    # the ground beside the wall takes its side's level: the raster's mixed
    # cells were the staircase. Away from the cut cells the terrain mesh
    # draws it, flat on either side.
    moved = 0
    near_line = set()
    for a, b, *_ in segs:
        for c in range(math.floor(min(a[0], b[0]) - X0 - 0.5 - BAND), math.ceil(max(a[0], b[0]) - X0 - 0.5 + BAND) + 1):
            for r in range(math.floor(min(a[1], b[1]) - Z0 - 0.5 - BAND), math.ceil(max(a[1], b[1]) - Z0 - 0.5 + BAND) + 1):
                near_line.add((c, r))
    for c, r in near_line:
        if not (0 <= c < nx and 0 <= r < nz) or shore_corner(c, r):
            continue
        x, z = X0 + c + 0.5, Z0 + r + 0.5
        near = wall_near(x, z, BAND)
        if near is None:
            continue
        y = h[r * nx + c]
        y2 = max(y, near[1]) if up.contains(Point(x, z)) else min(y, near[2])
        if y2 != y:
            h[r * nx + c] = y2
            moved += 1

    def terrain(x, z):
        fx, fz = x - X0 - 0.5, z - Z0 - 0.5
        c, r = math.floor(fx), math.floor(fz)
        tx, tz = fx - c, fz - r

        def at(i, j):
            return h[min(nz - 1, max(0, j)) * nx + min(nx - 1, max(0, i))]
        return (at(c, r) * (1 - tx) + at(c + 1, r) * tx) * (1 - tz) + (at(c, r + 1) * (1 - tx) + at(c + 1, r + 1) * tx) * tz

    top = data["top"]
    lookup = {}

    def vertex(x, z, upper):
        y = terrain(x, z)
        near = wall_near(x, z, 0.01)
        if near is not None:
            y = near[1] if upper else near[2]
        key = round(x, 2), round(z, 2), round(y - ORIGIN_H, 2)     # centimetres are plenty
        if key not in lookup:
            lookup[key] = len(top["v"])
            top["v"].append(list(key))
        return lookup[key]

    added = 0
    for k in sorted(patch):
        c0, r0 = (k % cols) * PATCH, (k // cols) * PATCH
        for j in range(PATCH):
            for i in range(PATCH):
                x, z = x0 + c0 + i + 0.5, z0 + r0 + j + 0.5
                # the terrain mesh's own diagonals, cut along the wall
                for points in (((x, z), (x, z + 1), (x + 1, z)), ((x + 1, z), (x, z + 1), (x + 1, z + 1))):
                    tri = Polygon(points)
                    for part, upper in ((tri.intersection(up), True), (tri.difference(up), False)):
                        for poly in polygons(part):
                            for t in constrained_delaunay_triangles(poly).geoms:
                                pts = _tri(t.exterior.coords)
                                if pts:
                                    top["i"].extend(vertex(px, pz, upper) for px, pz in pts)
                                    added += 1
    data["cells"] = sorted(shore | patch)

    walls = data["walls"]
    faces = 0
    for (a, b, hia, loa, hib, lob), line in zip(segs, lines):
        dx, dz = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dz)
        # out of the upper side, the way the face looks
        mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        nx_, nz_ = -dz / length, dx / length
        if up.contains(Point(mx + nx_ * 0.3, mz + nz_ * 0.3)):
            nx_, nz_ = -nx_, -nz_
        for seg in _lines(line.intersection(area)):
            if seg.length < 0.05:
                continue
            p, q = seg.coords[0], seg.coords[-1]

            def levels(pt):
                t = min(1, max(0, math.hypot(pt[0] - a[0], pt[1] - a[1]) / length))
                return hia + (hib - hia) * t - ORIGIN_H, loa + (lob - loa) * t - ORIGIN_H - 0.1
            (pt_, pb), (qt, qb) = levels(p), levels(q)
            p, q = (round(p[0], 2), round(p[1], 2)), (round(q[0], 2), round(q[1], 2))
            pt_, pb, qt, qb = (round(v, 2) for v in (pt_, pb, qt, qb))
            start = len(walls["v"])
            walls["v"] += [[p[0], p[1], pt_], [p[0], p[1], pb], [q[0], q[1], qb], [q[0], q[1], qt]]
            # (q - p) x down faces (-dz, dx): keep the winding if that is outward
            face = [0, 1, 2, 0, 2, 3] if (-(q[1] - p[1]) * nx_ + (q[0] - p[0]) * nz_) > 0 else [0, 2, 1, 0, 3, 2]
            walls["i"].extend(start + f for f in face)
            faces += 1
    with open(path + ".part", "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    os.replace(path + ".part", path)
    return {"file": "shorelines.json", "cells": len(data["cells"]),
            "triangles": len(top["i"]) // 3 + len(walls["i"]) // 3, "bytes": os.path.getsize(path),
            "retaining": {"segments": len(segs), "cells": len(patch), "faces": faces, "moved": moved}}
