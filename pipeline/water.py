"""Water as a surface of its own, flat, at the level the laser scan measured.

Water used to be painted onto the terrain from OSM's water areas, so it lay
at whatever height the terrain had: bumps where hole filling had nothing to
go on, and water on quays and bridges wherever an OSM water area reached
under them. Rivers and lakes are flat; so now:

  - the level is measured per connected water reach over the whole city
    (hydrography.py), split at OSM's weirs and lock gates, so a river is one
    flat surface across blocks and tiles. Water outside a measured reach is
    measured per BLOCK-metre block from the scan's ground returns there -
    the Spree returns a flat 32.3 m in Mitte - and blocks with too few
    returns take their neighbours' level;
  - the terrain under the water is pushed below that level, so nothing of
    the river bed shows through;
  - water.json holds the water as runs of CELL-metre cells at their level,
    reaching REACH metres beyond OSM's outline: the surface runs on under the
    banks, and the shoreline is wherever the real bank rises out of it - a
    quay wall, a sloping beach.

The game draws the surface; the cover mask's water channel is left only for
the navigation grid and the minimap.
"""
import json
import math
import os

from geo import ORIGIN_H

BLOCK = 48           # metres: one level per block of water
CELL = 2             # metres per cell of water.json
REACH = 4            # metres the surface reaches past the outline, under the banks
BELOW = 0.6          # the river bed stays at least this far under the surface
MIN_RETURNS = 12     # ground returns a block needs to measure its own level
SAME = 0.12          # neighbouring blocks this close in level are one body of water
LOCK = 1.0           # a step this large between bodies is real: a lock, a weir
ROUND = 0.05         # body levels rounded to this, so tiles agree at their edges


def levels(wet, ground, nx, nz, under_deck):
    """Water level (absolute) per block, or None for blocks without water.
    wet: per 1 m cell; ground: the scan's raw ground returns (NaN where none);
    under_deck: per cell, 1 under a bridge deck (its returns are the deck)."""
    bx, bz = math.ceil(nx / BLOCK), math.ceil(nz / BLOCK)
    vals = [[] for _ in range(bx * bz)]
    has = [False] * (bx * bz)
    for k in range(nx * nz):
        if not wet[k]:
            continue
        r, c = divmod(k, nx)
        b = (r // BLOCK) * bx + c // BLOCK
        has[b] = True
        if not under_deck[k]:
            v = ground[k]
            if v == v:
                vals[b].append(v)
    lev = [None] * (bx * bz)
    for b in range(bx * bz):
        if has[b] and len(vals[b]) >= MIN_RETURNS:
            v = sorted(vals[b])
            # the water itself, not the odd quay cell inside the outline
            lev[b] = v[len(v) // 5]
    # blocks of water without enough returns: their neighbours' level
    changed = True
    while changed:
        changed = False
        for b in range(bx * bz):
            if not has[b] or lev[b] is not None:
                continue
            r, c = divmod(b, bx)
            near = [lev[rr * bx + cc] for rr in range(r - 1, r + 2) for cc in range(c - 1, c + 2)
                    if 0 <= rr < bz and 0 <= cc < bx and lev[rr * bx + cc] is not None]
            if near:
                lev[b] = sum(near) / len(near)
                changed = True
    return _bodies(lev, bx, bz), bx


def _bodies(lev, bx, bz):
    """One level per body of water. Block by block the measurement wanders a
    few centimetres, and blocks along a quay read high from the returns off
    the bank: every block border was a step, a line on the river. So:
    neighbouring blocks within SAME of each other are one body; a body next
    to a lower, larger one within LOCK of it is the bank's doing and joins it
    (a lock's step is larger); each body takes the median of its blocks,
    rounded to ROUND - neighbouring tiles measure the same river from
    overlapping windows, and so meet at the same level."""
    n = bx * bz
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def near(b):
        r, c = divmod(b, bx)
        for rr in range(r - 1, r + 2):
            for cc in range(c - 1, c + 2):
                o = rr * bx + cc
                if (rr, cc) != (r, c) and 0 <= rr < bz and 0 <= cc < bx and lev[o] is not None:
                    yield o

    blocks = [b for b in range(n) if lev[b] is not None]
    for b in blocks:
        for o in near(b):
            if abs(lev[b] - lev[o]) < SAME:
                parent[find(b)] = find(o)

    def level_of(members):
        v = sorted(lev[b] for b in members)
        return v[len(v) // 2]

    core = {b: find(b) for b in blocks}

    changed = True
    while changed:
        changed = False
        bodies = {}
        for b in blocks:
            bodies.setdefault(find(b), []).append(b)
        level = {k: level_of(m) for k, m in bodies.items()}
        for k, members in sorted(bodies.items(), key=lambda kv: len(kv[1])):
            best = None
            for b in members:
                for o in near(b):
                    ko = find(o)
                    if ko == k or len(bodies.get(ko, ())) < len(members):
                        continue
                    if level[k] - LOCK < level[ko] < level[k] and (best is None or level[ko] < level[best]):
                        best = ko
            if best is not None:
                parent[k] = best
                changed = True
                break       # bodies changed: count again

    out = list(lev)
    bodies = {}
    for b in blocks:
        bodies.setdefault(find(b), []).append(b)
    for members in bodies.values():
        # the level of the body's largest core, not of the bank blocks taken in
        cores = {}
        for b in members:
            cores.setdefault(core[b], []).append(b)
        y = round(level_of(max(cores.values(), key=len)) / ROUND) * ROUND
        for b in members:
            out[b] = y
    return out


def level_at(lev, bx, nx, nz, c, r):
    """The level for cell (c, r): its water reach's (hydrography.apply), else
    its block's, or the nearest block's that has one."""
    exact = getattr(lev, "exact", None)
    if exact:
        y = exact.get(r * nx + c)
        if y is not None:
            return y
    br, bc = r // BLOCK, c // BLOCK
    b = br * bx + bc
    if 0 <= b < len(lev) and lev[b] is not None:
        return lev[b]
    bz = len(lev) // bx
    for ring in range(1, 4):
        best = None
        for rr in range(br - ring, br + ring + 1):
            for cc in range(bc - ring, bc + ring + 1):
                if 0 <= rr < bz and 0 <= cc < bx and lev[rr * bx + cc] is not None:
                    v = lev[rr * bx + cc]
                    best = v if best is None else min(best, v)
        if best is not None:
            return best
    return None


def settle(h, wet, lev, bx, nx, nz, under_deck):
    """Push the river bed below its water level, including beneath bridges."""
    n = 0
    for k in range(nx * nz):
        if not wet[k]:
            continue
        r, c = divmod(k, nx)
        y = level_at(lev, bx, nx, nz, c, r)
        if y is not None and h[k] > y - BELOW:
            h[k] = y - BELOW
            n += 1
    return n


def _dilate(mask, nx, nz, radius):
    """Square dilation, separable: rows, then columns."""
    tmp = bytearray(nx * nz)
    for r in range(nz):
        row = r * nx
        last = -10 ** 9
        for c in range(nx):
            if mask[row + c]:
                last = c
            if c - last <= radius:
                tmp[row + c] = 1
        last = 10 ** 9
        for c in range(nx - 1, -1, -1):
            if mask[row + c]:
                last = c
            if last - c <= radius:
                tmp[row + c] = 1
    out = bytearray(nx * nz)
    for c in range(nx):
        last = -10 ** 9
        for r in range(nz):
            if tmp[r * nx + c]:
                last = r
            if r - last <= radius:
                out[r * nx + c] = 1
        last = 10 ** 9
        for r in range(nz - 1, -1, -1):
            if tmp[r * nx + c]:
                last = r
            if last - r <= radius:
                out[r * nx + c] = 1
    return out


def write(wet, lev, bx, nx, nz, X0, Z0, x0, z0, sx, sz, out, shape=None):
    """water.json for the tile [x0, x0+sx) x [z0, z0+sz). None if it has no water."""
    near = wet if shape is not None else _dilate(wet, nx, nz, REACH)
    cx0, cz0 = int(round(x0 - X0)), int(round(z0 - Z0))
    cols, rows = sx // CELL, sz // CELL
    out_rows = []
    for j in range(rows):
        runs = []
        for i in range(cols):
            c, r = cx0 + i * CELL + CELL // 2, cz0 + j * CELL + CELL // 2
            if not (0 <= c < nx and 0 <= r < nz) or not near[r * nx + c]:
                continue
            y = level_at(lev, bx, nx, nz, c, r)
            if y is None:
                continue
            ycm = int(round((y - ORIGIN_H) * 100))
            if runs and runs[-1][0] + runs[-1][1] == i and runs[-1][2] == ycm:
                runs[-1][1] += 1
            else:
                runs.append([i, 1, ycm])
        if runs:
            out_rows.append([j, runs])
    if not out_rows:
        return None
    path = os.path.join(out, "water.json")
    data = {"cell": CELL, "minX": x0, "minZ": z0, "rows": out_rows}
    if shape is not None:
        from shapely import box, constrained_delaunay_triangles, unary_union
        from bridge_surfaces import polygons
        area = shape.intersection(box(x0, z0, x0 + sx, z0 + sz))
        # A measured reach is one flat surface across blocks and tiles; only
        # water outside every measured reach falls back to the block levels.
        pieces = []
        regions = getattr(lev, "regions", ())
        for region, y in regions:
            pieces.extend((poly, y) for poly in polygons(area.intersection(region)))
        rest = area.difference(unary_union([region for region, _ in regions])) if regions else area
        for r in range(math.ceil(nz / BLOCK)):
            for c in range(bx):
                xx, zz = X0 + c * BLOCK, Z0 + r * BLOCK
                if xx + BLOCK < x0 or xx > x0 + sx or zz + BLOCK < z0 or zz > z0 + sz:
                    continue
                for poly in polygons(rest.intersection(box(xx, zz, xx + BLOCK, zz + BLOCK))):
                    # slivers along a reach take the reach's level, not the block's
                    p = poly.representative_point()
                    y = level_at(lev, bx, nx, nz, min(nx - 1, max(0, int(p.x - X0))), min(nz - 1, max(0, int(p.y - Z0))))
                    if y is not None:
                        pieces.append((poly, y))
        vertices, indices = [], []
        for poly, y in pieces:
            for tri in constrained_delaunay_triangles(poly).geoms:
                pts = list(tri.exterior.coords)[:3]
                cross = (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0])
                if abs(cross) < 1e-8:
                    continue
                if cross > 0:
                    pts.reverse()
                start = len(vertices)
                vertices.extend([[round(x, 3), round(z, 3), round(y - ORIGIN_H, 3)] for x, z in pts])
                indices.extend([start, start + 1, start + 2])
        data["mesh"] = {"v": vertices, "i": indices, "r": []}
        falls(data["mesh"])
    with open(path, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    return {"file": "water.json", "bytes": os.path.getsize(path)}


def falls(mesh):
    """Where water at two levels meets - a weir, a lock gate, the dam at
    Muehlendamm - the step between them is a face of falling water, not a gap
    to look through to the sky. Adds the faces to a water.json mesh, both
    ways round; mesh["falls"] marks where they start, so this can run again
    on a mesh it has been run on."""
    from collections import defaultdict
    from shapely import Polygon, unary_union
    from shapely.strtree import STRtree
    v, idx = mesh["v"], mesh["i"]
    if "falls" in mesh:
        idx = idx[:mesh["falls"][0]]
        v = v[:mesh["falls"][1]]
    by_level = defaultdict(list)
    for t in range(0, len(idx) - 2, 3):
        ys = sorted(v[k][2] for k in idx[t:t + 3])
        # stitch_water may have moved an edge vertex by a few centimetres
        tri = Polygon([v[k][:2] for k in idx[t:t + 3]])
        if tri.area > 1e-9:
            by_level[round(ys[1], 2)].append(tri)
    levels = [(unary_union(ps).buffer(0), y) for y, ps in by_level.items()]
    tree = STRtree([shape for shape, _ in levels])
    v, idx = list(v), list(idx)
    mark = [len(idx), len(v)]
    for i, (shape, y) in enumerate(levels):
        for j in tree.query(shape.buffer(0.05)):
            other, y2 = levels[j]
            if j <= i or abs(y - y2) < 0.02:
                continue
            shared = shape.boundary.intersection(other.buffer(0.02))
            hi, lo = max(y, y2), min(y, y2)
            for line in _lines(shared):
                pts = list(line.coords)
                for a, b in zip(pts, pts[1:]):
                    if abs(a[0] - b[0]) + abs(a[1] - b[1]) < 1e-3:
                        continue
                    k = len(v)
                    v += [[round(a[0], 3), round(a[1], 3), hi], [round(a[0], 3), round(a[1], 3), lo],
                          [round(b[0], 3), round(b[1], 3), lo], [round(b[0], 3), round(b[1], 3), hi]]
                    idx += [k, k + 1, k + 2, k, k + 2, k + 3, k, k + 2, k + 1, k, k + 3, k + 2]
    mesh["v"], mesh["i"] = v, idx
    if "rawY" in mesh:          # stitch_water's own heights, one per vertex
        mesh["rawY"] = mesh["rawY"][:mark[1]] + [p[2] for p in v[mark[1]:]]
    if len(idx) > mark[0]:
        mesh["falls"] = mark
    else:
        mesh.pop("falls", None)
    return (len(idx) - mark[0]) // 12


def _lines(geom):
    if geom.is_empty:
        return []
    if geom.geom_type in ("LineString", "LinearRing"):
        return [geom]
    return [line for g in getattr(geom, "geoms", ()) for line in _lines(g)]
