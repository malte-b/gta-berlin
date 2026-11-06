"""Bridge ends carried on to ground you can step off onto.

The game lets you off a deck only onto ground the navigation grid passes,
within a step (1 m) of the deck (World.canStep), and a car only onto ground
it may drive. OpenStreetMap often ends a bridge at the water's edge, and the
terrain under a deck's last metres is lowered below its underside
(bridges.clearer) - so beyond the end there is often a metre or three of
steep bank, closed in the navigation grid, before the street at the deck's
level begins. The deck then ends in a gap: you cannot step off it, and from
the street you cannot step on (scripts/check.ts floods every bridge and
finds them).

This runs on a finished tile - terrain.bin, nav.bin and bridges.json, the
files the game reads - and carries each free end of a road or path deck on
along its line, as a ramp, to the first ground within REACH where the game
lets you off: drivable for a road, walkable for a path or when a road finds
no drivable ground. Ends that already land, and ends with nothing to land on
within reach (a deck at the wrong height, a stair), are left as they are.
It changes nothing on a second run.

First, though, the navigation grid's drivable mask: it is the walkable
mask shrunk by the car's clearance (build_world: 2 m), and under a deck's end
the bank or the water is not walkable - so every road bridge had a band of
street 2 m wide around it where no car may go, just where cars get on and
off. A road deck counts as room for the car here, and the cells it frees are
made drivable (open_drive). No deck lies under the water it crosses
(keep_dry), and the holes between decks are patched over (patch_holes).

    python3 pipeline/landings.py data/berlin_v3                    # every tile
    python3 pipeline/landings.py data/berlin_v3 --tiles 393_5819 --dry-run
    python3 pipeline/landings.py data/berlin_v3 --redo     # undo every ramp, land again

Over an existing build it also rewrites tile.json and the tile's version in
world.json, so the game fetches the new bridges.json past any cache;
build_berlin.py runs it on each tile it builds.
"""
import argparse
import json
import math
import os
import struct
from array import array

STEP_UP = 1.0            # as in web/src/world.ts
CLEARANCE = 2            # cells, as build_world's --car-clearance
WALK, DRIVE, BUILDING = 1, 2, 16
REACH = {"path": 10.0, "road": 12.0}
STRIDE = 0.5             # metres between the places tried
LAND_DY = 0.5            # ground this close to the ramp's end height lands it
MAX_SLOPE = 0.35         # steeper than this is not a ramp but a wall
OVERLAP = 0.5            # the ramp runs on this far over the ground it lands on
CARRIED = 1.0            # a deck at the end's level this far past it: not a free end
DRY = 0.05               # water this far above a ramp shows on it (as WET_DECK in scripts/check.ts)
PROBE = 0.6              # the player's probe reaches 0.4 m round it; this much is open
JOIN = 3.0               # a deck at the end's level this close ahead: carried on into it
JOIN_OVERLAP = 0.75      # ... and this far over it, so square ends leave no sliver
HOLE = 2.0               # no deck between decks this far apart: a hole, patched over


class Grid:
    """terrain.bin (BTT1) or nav.bin (BTN1): a header, then u16 heights, then
    for the nav grid a flag byte per cell."""

    def __init__(self, path, flags=False):
        with open(path, "rb") as fh:
            buf = fh.read()
        self.min_x, self.min_z, self.cell = struct.unpack_from("<3f", buf, 4)
        self.nx, self.nz = struct.unpack_from("<2I", buf, 16)
        self.hmin, self.hscale = struct.unpack_from("<2f", buf, 24)
        n = self.nx * self.nz
        self.h = array("H")
        self.h.frombytes(buf[32:32 + n * 2])
        self.flags = bytearray(buf[32 + n * 2:32 + n * 3]) if flags else None
        self.path, self.head = path, n * 2 + 32

    def at(self, i, j):
        i = min(max(i, 0), self.nx - 1)
        j = min(max(j, 0), self.nz - 1)
        return self.hmin + self.h[j * self.nx + i] * self.hscale

    def height(self, x, z):
        """Bilinear between cell centres, as TerrainField.height."""
        fx = (x - self.min_x) / self.cell - 0.5
        fz = (z - self.min_z) / self.cell - 0.5
        i, j = math.floor(fx), math.floor(fz)
        tx, tz = fx - i, fz - j
        a, b = self.at(i, j), self.at(i + 1, j)
        c, d = self.at(i, j + 1), self.at(i + 1, j + 1)
        return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz

    def flag(self, x, z):
        c = math.floor((x - self.min_x) / self.cell)
        r = math.floor((z - self.min_z) / self.cell)
        if c < 0 or r < 0 or c >= self.nx or r >= self.nz:
            return None
        return self.flags[r * self.nx + c]


class Water:
    """water.json: the water surface's level per cell, None where it is dry."""

    def __init__(self, path, size):
        d = json.load(open(path))
        self.min_x, self.min_z, self.cell = d["minX"], d["minZ"], d["cell"]
        self.n = round(size / d["cell"])
        self.level = {}
        for row, runs in d["rows"]:
            for col, length, ycm in runs:
                for c in range(col, col + length):
                    self.level[row * self.n + c] = ycm / 100

    def at(self, x, z):
        c = math.floor((x - self.min_x) / self.cell)
        r = math.floor((z - self.min_z) / self.cell)
        if c < 0 or r < 0 or c >= self.n or r >= self.n:
            return None
        return self.level.get(r * self.n + c)


def deck_at(p, x, z):
    """The height of a deck's surface at (x, z), or None - as Decks.at."""
    for a, b in zip(p, p[1:]):
        ax, az, ay, al, ar = a
        bx, bz, by, bl, br = b
        ex, ez = bx - ax, bz - az
        l2 = ex * ex + ez * ez
        if l2 < 1e-9:
            continue
        t = ((x - ax) * ex + (z - az) * ez) / l2
        if t < 0 or t > 1:
            continue
        side = ((x - ax - ex * t) * -ez + (z - az - ez * t) * ex) / math.sqrt(l2)
        if side <= al + (bl - al) * t and -side <= ar + (br - ar) * t:
            return ay + (by - ay) * t
    return None


def landing(end, terrain, nav, water, need, square):
    """Where a deck end at (x, z, y), pointing (ux, uz), meets ground the game
    lets you off onto: (distance, ground height), 0 when it lands already, or
    None. `need` is the nav flag the ground must have."""
    x, z, y, ux, uz = end

    def open_at(k):
        # the spot and the cross the player probes around it (Player.step),
        # a little wider: an end cut at an angle to the grid leaves slivers
        px, pz = x + ux * k, z + uz * k
        for ox, oz in ((0, 0), (PROBE, 0), (-PROBE, 0), (0, PROBE), (0, -PROBE)):
            f = nav.flag(px + ox, pz + oz)
            if f is None or not f & need:
                return False
        return True

    def dry(d, g):
        # the ramp from the end down (or up) to the ground at d, not under water
        if water is None:
            return True
        k = STRIDE
        while k <= d + OVERLAP:
            w = water.at(x + ux * k, z + uz * k)
            if w is not None and w > y + (g - y) * min(1, k / d) + DRY:
                return False
            k += STRIDE
        return True

    # lands as it is: open ground from just past the end, the first step
    # off within a step of the deck - on the ground the game asks no more
    ahead = (0.1, 0.5, 1.0, 1.5, 2.5) if need == DRIVE else (0.1, 0.5, 1.0, 1.5)
    if square(x + ux * 2.5, z + uz * 2.5) and all(open_at(k) for k in ahead) and all(
            abs(terrain.height(x + ux * k, z + uz * k) - y) <= STEP_UP - 0.1 for k in (0.1, 0.5)):
        return 0, y

    d = STRIDE
    while d <= REACH["road"]:
        px, pz = x + ux * d, z + uz * d
        if not square(px, pz):
            return None                      # the next tile's to say
        f = nav.flag(px, pz)
        if f is None or f & BUILDING:
            return None                      # a ramp into a house is no way off
        g = terrain.height(px, pz)
        # open from here to a little past the ramp's end: a car needs more room
        open_ = all(open_at(d + k) for k in ((0, 0.5, 1.0, 1.5, 2.5) if need == DRIVE else (0, 0.5, 1.0, 1.5)))
        if open_ and abs(g - y) <= max(LAND_DY, MAX_SLOPE * d) and dry(d, g):
            return d, g
        d += STRIDE
    return None


def open_drive(nav, decks):
    """Make drivable the walkable cells whose clearance square (CLEARANCE
    cells round) is walkable ground or road deck everywhere. Changes
    nav.flags; returns how many cells it opened."""
    nx, nz, cell = nav.nx, nav.nz, nav.cell
    flags = nav.flags
    deck = set()
    for dk in decks:
        if dk["k"] != "road":
            continue
        p = [q if len(q) >= 5 else q[:4] + [q[3]] for q in dk["p"]]
        for a, b in zip(p, p[1:]):
            ex, ez = b[0] - a[0], b[1] - a[1]
            length = math.hypot(ex, ez)
            if length < 1e-6:
                continue
            ux, uz = ex / length, ez / length
            steps = int(length / 0.5) + 1
            for s in range(steps + 1):
                f = s / steps
                x, z = a[0] + ex * f, a[1] + ez * f
                wl, wr = a[3] + (b[3] - a[3]) * f, a[4] + (b[4] - a[4]) * f
                o = -wr
                while o <= wl:
                    c = math.floor((x - uz * o - nav.min_x) / cell)
                    r = math.floor((z + ux * o - nav.min_z) / cell)
                    if 0 <= c < nx and 0 <= r < nz and not flags[r * nx + c] & BUILDING:
                        deck.add(r * nx + c)
                    o += 0.5
    room = lambda c, r: not (0 <= c < nx and 0 <= r < nz) or flags[r * nx + c] & WALK or r * nx + c in deck
    opened = 0
    seen = set()
    for k in deck:
        kc, kr = k % nx, k // nx
        for r in range(kr - CLEARANCE, kr + CLEARANCE + 1):
            for c in range(kc - CLEARANCE, kc + CLEARANCE + 1):
                if not (0 <= c < nx and 0 <= r < nz) or (r * nx + c) in seen:
                    continue
                seen.add(r * nx + c)
                f = flags[r * nx + c]
                if not f & WALK or f & DRIVE:
                    continue
                if all(room(c2, r2) for r2 in range(r - CLEARANCE, r + CLEARANCE + 1)
                       for c2 in range(c - CLEARANCE, c + CLEARANCE + 1)):
                    flags[r * nx + c] = f | DRIVE
                    opened += 1
    return opened


def join_gap(dk, a, ux, uz, near):
    """How far ahead of the end `a` (pointing ux, uz) the other decks at its
    level begin, the furthest across its width: two pieces meeting cut square,
    or at an angle, leave a sliver of river between them - a hole in the
    bridge and, for the player, an invisible wall. None when no deck lies
    ahead within JOIN."""
    lx, lz = -uz, ux                         # left of the line
    worst = None
    o = -a[4] + 0.4
    while o <= a[3] - 0.4:
        d = 0.1
        while d <= JOIN:
            x, z = a[0] + ux * d + lx * o, a[1] + uz * d + lz * o
            if any((h := deck_at(q["p"], x, z)) is not None and abs(h - a[2]) <= 0.5 for q in near):
                worst = d if worst is None else max(worst, d)
                break
            d += 0.2
        o += 0.5
    return worst


def patch_holes(decks, nav, square):
    """Fill the holes between decks: a spot of no deck and no ground you
    may use, with deck on both sides of it within HOLE metres - pieces side
    by side whose outlines do not quite meet, a corner cut off. To the player
    that is an invisible wall in the middle of a bridge. Each hole gets a
    patch of deck at the height round it, wide enough for a car (a road deck
    1 m in from its edge) where it stops cars. Returns how many patches."""
    R = 0.5                                   # raster, metres
    x0, z0 = nav.min_x, nav.min_z
    walk, car, ys = {}, {}, {}

    def mark(x, z, y, o_walk, o_car):
        if not square(x, z):
            return
        k = (math.floor((x - x0) / R), math.floor((z - z0) / R))
        ys.setdefault(k, []).append(y)
        if o_walk:
            walk[k] = True
        if o_car:
            car[k] = True
        walk.setdefault(k, False)
        car.setdefault(k, False)

    for dk in decks:
        if dk["k"] == "rail" or dk.get("patch"):
            continue
        road = dk["k"] == "road"
        p = [q if len(q) >= 5 else q[:4] + [q[3]] for q in dk["p"]]
        for i, (a, b) in enumerate(zip(p, p[1:])):
            ex, ez = b[0] - a[0], b[1] - a[1]
            length = math.hypot(ex, ez)
            if length < 1e-6:
                continue
            ux, uz = ex / length, ez / length
            steps = int(length / 0.25) + 1
            for sidx in range(steps + 1):
                f = sidx / steps
                x, z, y = a[0] + ex * f, a[1] + ez * f, a[2] + (b[2] - a[2]) * f
                wl, wr = a[3] + (b[3] - a[3]) * f, a[4] + (b[4] - a[4]) * f
                o = -wr
                while o <= wl:
                    edge = min(wl - o, o + wr)
                    mark(x - uz * o, z + ux * o, y, edge >= 0.3, road and edge >= 1.0)
                    o += 0.25
            # the outside of the bend at the next station, as Decks.at fills it
            if i + 2 < len(p):
                bx, bz, by, bl, br = b
                rad = min(bl, br)
                ox = -rad
                while ox <= rad:
                    oz = -rad
                    while oz <= rad:
                        dist = math.hypot(ox, oz)
                        if dist <= rad:
                            mark(bx + ox, bz + oz, by, rad - dist >= 0.3, road and rad - dist >= 1.0)
                        oz += 0.25
                    ox += 0.25
    if not ys:
        return 0
    kmin = min(k[0] for k in ys) - 4, min(k[1] for k in ys) - 4
    kmax = max(k[0] for k in ys) + 4, max(k[1] for k in ys) + 4
    holes = {}
    for ok, need, kind in ((walk, WALK, "path"), (car, DRIVE, "road")):
        def side(i, j, di, dj):
            for s in range(1, int(HOLE / R) + 1):
                if ok.get((i + di * s, j + dj * s)):
                    return (i + di * s, j + dj * s)
            return None
        for i in range(kmin[0], kmax[0] + 1):
            for j in range(kmin[1], kmax[1] + 1):
                if ok.get((i, j)):
                    continue
                cx, cz = x0 + (i + 0.5) * R, z0 + (j + 0.5) * R
                f = nav.flag(cx, cz)
                if f is None or f & need or f & BUILDING:
                    continue
                for a, b in (((1, 0), (-1, 0)), ((0, 1), (0, -1))):
                    sa, sb = side(i, j, *a), side(i, j, *b)
                    if sa and sb:
                        h = sorted(ys[sa] + ys[sb])
                        if h[-1] - h[0] <= 0.5:
                            k = holes.setdefault((i, j), [kind, []])
                            if kind == "road":
                                k[0] = "road"
                            k[1].append(h[len(h) // 2])
                        break
    # neighbouring hole cells as one patch
    seen, n = set(), 0
    for start in holes:
        if start in seen:
            continue
        comp, todo = [], [start]
        seen.add(start)
        while todo:
            c = todo.pop()
            comp.append(c)
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    q = (c[0] + di, c[1] + dj)
                    if q in holes and q not in seen:
                        seen.add(q)
                        todo.append(q)
        kind = "road" if any(holes[c][0] == "road" for c in comp) else "path"
        hs = sorted(v for c in comp for v in holes[c][1])
        y = hs[len(hs) // 2]
        m = 1.2 if kind == "road" else 0.5
        ax0 = x0 + min(c[0] for c in comp) * R - m
        ax1 = x0 + (max(c[0] for c in comp) + 1) * R + m
        az0 = z0 + min(c[1] for c in comp) * R - m
        az1 = z0 + (max(c[1] for c in comp) + 1) * R + m
        if ax1 - ax0 >= az1 - az0:
            hw = (az1 - az0) / 2
            line = [[ax0, (az0 + az1) / 2], [ax1, (az0 + az1) / 2]]
        else:
            hw = (ax1 - ax0) / 2
            line = [[(ax0 + ax1) / 2, az0], [(ax0 + ax1) / 2, az1]]
        decks.append({"k": kind, "t": 0.3, "patch": True,
                      "p": [[round(px, 2), round(pz, 2), round(y, 2), round(hw, 2), round(hw, 2)] for px, pz in line]})
        n += 1
    return n


def keep_dry(decks, water):
    """A deck is never under the water it crosses: a station below the water
    there (an end pinned to a bank lower than the ditch it spans) is lifted
    to just above it. Returns how many stations moved."""
    if water is None:
        return 0
    n = 0
    for dk in decks:
        if dk["k"] == "rail":
            continue
        for q in dk["p"]:
            w = water.at(q[0], q[1])
            if w is not None and q[2] < w + DRY:
                q[2] = round(w + DRY + 0.01, 2)
                n += 1
    return n


def unland(decks):
    """Take back what land_decks added: one station at each landed end, and
    the patches over holes."""
    decks[:] = [dk for dk in decks if not dk.get("patch")]
    for dk in decks:
        first, last = dk.pop("landed", [False, False])
        if last:
            dk["p"] = dk["p"][:-1]
        if first:
            dk["p"] = dk["p"][1:]


def land_decks(decks, terrain, nav, water, square):
    """Carry the free ends of the road and path decks on to their landings.
    A deck carried on says so in "landed", [start, end], and is not carried
    on again. Returns how many ends were carried on."""
    n = 0
    boxes = []
    for q in decks:
        pts = q["p"]
        w = max(max(v[3], v[4] if len(v) >= 5 else v[3]) for v in pts)
        boxes.append((min(v[0] for v in pts) - w, max(v[0] for v in pts) + w,
                      min(v[1] for v in pts) - w, max(v[1] for v in pts) + w))
    for dk in decks:
        if dk["k"] == "rail" or len(dk["p"]) < 2:
            continue
        p = [q if len(q) >= 5 else q[:4] + [q[3]] for q in dk["p"]]
        landed = dk.get("landed", [False, False])
        for first in (True, False):
            if landed[0 if first else 1]:
                continue
            a, b = (p[0], p[1]) if first else (p[-1], p[-2])
            l = math.hypot(a[0] - b[0], a[1] - b[1]) or 1
            ux, uz = (a[0] - b[0]) / l, (a[1] - b[1]) / l
            if not square(a[0], a[1]):
                continue                     # a cut at the tile's edge, or the next tile's end
            # another deck just ahead: carried on into it, over the sliver between
            r = JOIN + max(a[3], a[4])
            near = [q for q, (x0, x1, z0, z1) in zip(decks, boxes) if q is not dk and q["k"] != "rail"
                    and x0 - r <= a[0] <= x1 + r and z0 - r <= a[1] <= z1 + r]
            gap = join_gap(dk, a, ux, uz, near)
            if gap is not None and gap > 0.15:
                e = gap + JOIN_OVERLAP
                st = [round(a[0] + ux * e, 2), round(a[1] + uz * e, 2), a[2], a[3], a[4]]
                if first:
                    p.insert(0, st)
                else:
                    p.append(st)
                landed[0 if first else 1] = True
                n += 1
                continue
            # another deck carrying on anywhere across the end: not an end. A
            # road goes on as a road; the pavement beside it does not carry it
            spots = [(a[0] + ux * CARRIED - uz * o, a[1] + uz * CARRIED + ux * o)
                     for o in (-min(1.5, 0.5 * a[4]), 0, min(1.5, 0.5 * a[3]))]
            if any(o is not dk and o["k"] != "rail" and (dk["k"] != "road" or o["k"] == "road")
                   and (h := deck_at(o["p"], cx, cz)) is not None
                   and abs(h - a[2]) <= STEP_UP for o in decks for cx, cz in spots):
                continue
            end = (a[0], a[1], a[2], ux, uz)
            got = None
            if dk["k"] == "road":
                got = landing(end, terrain, nav, water, DRIVE, square)
            if got is None:
                got = landing(end, terrain, nav, water, WALK, square)
            if got is None or got[0] == 0:
                continue
            d, g = got
            e = d + OVERLAP
            st = [round(a[0] + ux * e, 2), round(a[1] + uz * e, 2), round(g, 2), a[3], a[4]]
            if first:
                p.insert(0, st)
            else:
                p.append(st)
            landed[0 if first else 1] = True
            n += 1
        dk["p"] = p
        if any(landed):
            dk["landed"] = landed
    return n


def land_tile(out, manifest, dry_run=False, redo=False):
    """One finished tile in `out`: opens the drivable mask round its road decks
    (nav.bin), then updates bridges.json and manifest["bridges"].
    Returns the number of deck ends carried on."""
    meta = manifest.get("bridges")
    path = os.path.join(out, "bridges.json")
    if not meta or not os.path.exists(path):
        return 0
    data = json.load(open(path))
    terrain = Grid(os.path.join(out, manifest["terrain"]["file"]))
    nav = Grid(os.path.join(out, manifest["nav"]["file"]), flags=True)
    nm = manifest["nav"]
    x0, z0 = nm["minX"], nm["minZ"]
    x1, z1 = x0 + nm["nx"] * nm["cell"], z0 + nm["nz"] * nm["cell"]
    wm = manifest.get("water")
    water = (Water(os.path.join(out, wm["file"]), nm["nx"] * nm["cell"])
             if wm and os.path.exists(os.path.join(out, wm["file"])) else None)

    def square(x, z):
        return x0 <= x < x1 and z0 <= z < z1

    if open_drive(nav, data["decks"]) and not dry_run:
        with open(nav.path, "r+b") as fh:
            fh.seek(nav.head)
            fh.write(nav.flags)
    before = json.dumps(data["decks"])
    if redo:
        unland(data["decks"])
    keep_dry(data["decks"], water)
    n = land_decks(data["decks"], terrain, nav, water, square)
    if not any(dk.get("patch") for dk in data["decks"]):
        n += patch_holes(data["decks"], nav, square)
    if json.dumps(data["decks"]) != before and not dry_run:
        with open(path + ".part", "w") as fh:
            json.dump(data, fh, separators=(",", ":"))
        os.replace(path + ".part", path)
        meta["bytes"] = os.path.getsize(path)
    return n


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("build", help="a build folder with world.json, e.g. data/berlin")
    ap.add_argument("--tiles", nargs="+", metavar="E_N", help="only these tiles")
    ap.add_argument("--dry-run", action="store_true", help="count, change nothing")
    ap.add_argument("--redo", action="store_true",
                    help="take back the ramps of an earlier run and land every end again")
    args = ap.parse_args()
    wpath = os.path.join(args.build, "world.json")
    world = json.load(open(wpath))
    keys = args.tiles or sorted(world["tiles"])
    total = changed = 0
    for i, key in enumerate(keys):
        entry = world["tiles"].get(key)
        if not entry:
            continue
        out = os.path.join(args.build, entry["dir"])
        tj = os.path.join(out, "tile.json")
        manifest = json.load(open(tj))
        files = [os.path.join(out, f) for f in ("bridges.json", "nav.bin")]
        stamp = lambda: [os.path.getmtime(f) if os.path.exists(f) else None for f in files]
        before = stamp()
        n = land_tile(out, manifest, args.dry_run, args.redo)
        changed_file = stamp() != before
        if changed_file and not args.dry_run:
            with open(tj + ".part", "w") as fh:
                json.dump(manifest, fh, indent=1)
            os.replace(tj + ".part", tj)
            # the version the game appends to the tile's URLs, as build_berlin.write_index
            entry["v"] = format(int(os.stat(tj).st_mtime), "x")
        total += n
        changed += changed_file
        if (i + 1) % 100 == 0:
            print("  %d/%d tiles, %d ends carried on" % (i + 1, len(keys), total), flush=True)
    if changed and not args.dry_run:
        with open(wpath + ".part", "w") as fh:
            json.dump(world, fh, indent=1)
        os.replace(wpath + ".part", wpath)
    print("%d deck ends carried on to their landings in %d of %d tiles%s"
          % (total, changed, len(keys), " (dry run)" if args.dry_run else ""))


if __name__ == "__main__":
    main()
