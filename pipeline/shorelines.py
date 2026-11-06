"""Mapped shorelines replace the stair-step edge of a regular height grid.

Only 4 m terrain cells touching a shore are replaced. Their land triangles
are clipped to OSM's water polygons, including islands; steep surveyed banks
get a continuous quay face. Natural shores meet the water as slopes. The
replacement tops are also the ground-height field used by the player.
"""
import json
import math
import os

from shapely import Polygon, Point, LineString, box, make_valid, unary_union, constrained_delaunay_triangles

import groundcover
import water
from bridge_surfaces import polygons
from geo import ORIGIN_H
from raster import cells

STEP = 4
BLEND = 2.0
QUAY = 4.0          # metres behind a quay wall where the ground never dips below its top


def _lines(geom):
    if geom.is_empty:
        return []
    if geom.geom_type in ("LineString", "LinearRing"):
        return [geom]
    return [line for g in getattr(geom, "geoms", ()) for line in _lines(g)]


def water_polygons(data, bounds):
    areas = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        if tags.get("natural") != "water" and tags.get("waterway") != "riverbank":
            continue
        # OSM multipolygons can have several outer rings as well as islands.
        # Even/odd composition is independent of the order returned by OSM.
        shape = Polygon()
        for ring in groundcover._rings(el):
            if len(ring) >= 3:
                shape = shape.symmetric_difference(make_valid(Polygon(ring)))
        areas.extend(polygons(shape.intersection(box(*bounds))))
    return unary_union(areas)


class BankProfile:
    CELL = 16

    def __init__(self, segments):
        self.segments, self.buckets = segments, {}
        for seg in segments:
            a, b = seg[:2]
            for c in range(math.floor((min(a[0], b[0]) - QUAY - 1) / self.CELL), math.floor((max(a[0], b[0]) + QUAY + 1) / self.CELL) + 1):
                for r in range(math.floor((min(a[1], b[1]) - QUAY - 1) / self.CELL), math.floor((max(a[1], b[1]) + QUAY + 1) / self.CELL) + 1):
                    self.buckets.setdefault((c, r), []).append(seg)

    def near(self, x, z):
        best, distance = None, (QUAY + 1) ** 2
        for a, b, ya, yb, wa, wb, _left in self.buckets.get((math.floor(x / self.CELL), math.floor(z / self.CELL)), ()):
            dx, dz = b[0] - a[0], b[1] - a[1]
            t = min(1, max(0, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz or 1)))
            d = (x - a[0] - dx * t) ** 2 + (z - a[1] - dz * t) ** 2
            if d < distance:
                distance = d
                best = math.sqrt(d), ya + (yb - ya) * t, wa + (wb - wa) * t
        return best


def build(data, h, grid, levels, blocks, tile_bounds, out, deck_cap=None):
    """Write shorelines.json and adjust h at its shared land vertices in place."""
    X0, Z0, nx, nz = grid
    x0, z0, x1, z1 = tile_bounds
    shore = water_polygons(data, (X0, Z0, X0 + nx, Z0 + nz))
    if shore.is_empty:
        return None
    tile = box(x0 + 0.5, z0 + 0.5, x1 + 0.5, z1 + 0.5)
    boundary = shore.boundary.intersection(tile.buffer(12))
    if boundary.is_empty:
        return None

    def terrain(x, z):
        fx, fz = x - X0 - 0.5, z - Z0 - 0.5
        c, r = math.floor(fx), math.floor(fz)
        tx, tz = fx - c, fz - r
        def at(i, j):
            return h[min(nz - 1, max(0, j)) * nx + min(nx - 1, max(0, i))]
        return (at(c, r) * (1 - tx) + at(c + 1, r) * tx) * (1 - tz) + (at(c, r + 1) * (1 - tx) + at(c + 1, r + 1) * tx) * tz

    def wet_level(x, z):
        return water.level_at(levels, blocks, nx, nz, min(nx - 1, max(0, int(x - X0))), min(nz - 1, max(0, int(z - Z0))))

    segments = []
    for line in _lines(boundary):
        pts = list(line.segmentize(2).coords)
        tops, waters, sides = [], [], []
        for i, (x, z) in enumerate(pts):
            a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
            dx, dz = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dz) or 1
            lx, lz = -dz / length, dx / length
            left = shore.contains(Point(x + lx * 0.3, z + lz * 0.3))
            sign = -1 if left else 1
            w = wet_level(x, z)
            waters.append(w)
            sides.append(left)
            land = sorted(terrain(x + lx * d * sign, z + lz * d * sign) for d in (2, 3, 4))[1]
            # Steep surveyed riverbanks are engineered quays. Low banks meet
            # the water as a beach/slope rather than an invented concrete wall.
            tops.append(max(w, land) if w is not None and land > w + 0.8 else w)
        clean = list(tops)
        for i, y in enumerate(tops):
            vals = sorted(v for v in tops[max(0, i - 2):i + 3] if v is not None)
            if y is not None and vals:
                clean[i] = vals[len(vals) // 2]
        for i, (a, b) in enumerate(zip(pts, pts[1:])):
            if any(v is None for v in (clean[i], clean[i + 1], waters[i], waters[i + 1])):
                continue
            segments.append((a, b, clean[i], clean[i + 1], waters[i], waters[i + 1], sides[i]))
    if not segments:
        return None
    profile = BankProfile(segments)
    cols, rows = math.ceil((x1 - x0) / STEP), math.ceil((z1 - z0) / STEP)
    patch_cells = set()
    for poly in polygons(boundary.buffer(5).intersection(tile)):
        rings = [list(poly.exterior.coords)] + [list(r.coords) for r in poly.interiors]
        patch_cells.update(cells(rings, x0 + 0.5, z0 + 0.5, STEP, cols, rows))

    def bank_height(x, z, original):
        near = profile.near(x, z)
        if near is None or near[0] >= QUAY:
            return original
        d, top, w = near
        if top > w + 0.5:
            # A quay's ground runs level to its wall. Lower ground here is the
            # 1 m raster's wet cells, sunk under the water past the mapped
            # shore, or the scan's pits at the wall's edge: left in, they made
            # a ridge along the wall, cut into teeth by the grid.
            original = max(original, top)
        if d >= BLEND:
            return original
        t = min(1, d / BLEND)
        t = t * t * (3 - 2 * t)
        return max(w + 0.05 * d, top * (1 - t) + original * t)

    # Update shared terrain vertices first, including the patch perimeter;
    # this is also the source of nav heights and tree/furniture placement.
    touched = set()
    for k in patch_cells:
        c0, r0 = (k % cols) * STEP, (k // cols) * STEP
        for j in range(STEP + 1):
            for i in range(STEP + 1):
                x, z = x0 + c0 + i + 0.5, z0 + r0 + j + 0.5
                c, r = int(x - X0), int(z - Z0)
                if not (0 <= c < nx and 0 <= r < nz) or (c, r) in touched:
                    continue
                touched.add((c, r))
                if not shore.contains(Point(x, z)):
                    h[r * nx + c] = bank_height(x, z, h[r * nx + c])

    vertices, indices, lookup = [], [], {}
    def vertex(x, z):
        # Interior grid vertices retain the already adjusted height. Newly
        # clipped shoreline vertices get the continuous measured bank profile.
        y = terrain(x, z)
        near = profile.near(x, z)
        if near is not None and near[0] < 0.002:
            y = near[1]
        if deck_cap:
            cap = deck_cap(x, z)
            if cap is not None:
                y = min(y, cap - 0.08)
        key = round(x, 3), round(z, 3), round(y - ORIGIN_H, 3)
        if key not in lookup:
            lookup[key] = len(vertices)
            vertices.append(list(key))
        return lookup[key]

    for k in sorted(patch_cells):
        c0, r0 = (k % cols) * STEP, (k // cols) * STEP
        for j in range(STEP):
            for i in range(STEP):
                x, z = x0 + c0 + i + 0.5, z0 + r0 + j + 0.5
                # Same diagonals as the terrain mesh, cut to the real shore.
                for points in (((x, z), (x, z + 1), (x + 1, z)), ((x + 1, z), (x, z + 1), (x + 1, z + 1))):
                    land = Polygon(points).difference(shore)
                    for poly in polygons(land):
                        for tri in constrained_delaunay_triangles(poly).geoms:
                            pts = list(tri.exterior.coords)[:3]
                            cross = (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0])
                            if abs(cross) < 1e-8:
                                continue
                            if cross > 0:
                                pts.reverse()
                            indices.extend(vertex(*p) for p in pts)

    wall_v, wall_i = [], []
    for a, b, ya, yb, wa, wb, left in segments:
        if max(ya - wa, yb - wb) < 0.5:
            continue
        clipped = LineString([a, b]).intersection(tile)
        for line in _lines(clipped):
            p, q = list(line.coords)[0], list(line.coords)[-1]
            length = math.hypot(b[0] - a[0], b[1] - a[1]) or 1
            def heights(pt):
                t = min(1, max(0, math.hypot(pt[0] - a[0], pt[1] - a[1]) / length))
                top = ya + (yb - ya) * t
                cap = deck_cap(*pt) if deck_cap else None
                if cap is not None:
                    top = min(top, cap - 0.08)
                return top - ORIGIN_H, wa + (wb - wa) * t - ORIGIN_H - 0.5
            py, pw = heights(p)
            qy, qw = heights(q)
            start = len(wall_v)
            wall_v += [[p[0], p[1], py], [p[0], p[1], pw], [q[0], q[1], qw], [q[0], q[1], qy]]
            face = [0, 1, 2, 0, 2, 3] if left else [0, 2, 1, 0, 3, 2]
            wall_i.extend(start + k for k in face)
    path = os.path.join(out, "shorelines.json")
    payload = {"step": STEP, "cols": cols, "cells": sorted(patch_cells),
               "top": {"v": vertices, "i": indices, "r": []},
               "walls": {"v": wall_v, "i": wall_i},
               "source": "OpenStreetMap water polygons; ALS Berlin bank heights"}
    with open(path, "w") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    return {"file": "shorelines.json", "cells": len(patch_cells), "triangles": len(indices) // 3 + len(wall_i) // 3,
            "bytes": os.path.getsize(path)}
