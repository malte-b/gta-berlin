"""Water as a surface of its own, flat, at the level the laser scan measured.

Water used to be painted onto the terrain from OSM's water areas, so it lay
at whatever height the terrain had: bumps where hole filling had nothing to
go on, and water on quays and bridges wherever an OSM water area reached
under them. Rivers and lakes are flat; so now:

  - the level is measured per BLOCK-metre block of water from the scan's
    ground returns there - the Spree returns a flat 32.3 m in Mitte - and
    blocks with too few returns take their neighbours' level. A lock is a
    step between blocks;
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
    return lev, bx


def level_at(lev, bx, nx, nz, c, r):
    """The level for cell (c, r): its block's, or the nearest block's that has one."""
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
    """Push the terrain (absolute heights, in place) under the water below
    its level. Under decks the bridges have their own rules."""
    n = 0
    for k in range(nx * nz):
        if not wet[k] or under_deck[k]:
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


def write(wet, lev, bx, nx, nz, X0, Z0, x0, z0, sx, sz, out):
    """water.json for the tile [x0, x0+sx) x [z0, z0+sz). None if it has no water."""
    near = _dilate(wet, nx, nz, REACH)
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
    with open(path, "w") as fh:
        json.dump({"cell": CELL, "minX": x0, "minZ": z0, "rows": out_rows}, fh, separators=(",", ":"))
    return {"file": "water.json", "bytes": os.path.getsize(path)}
