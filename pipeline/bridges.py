"""Bridge decks: OpenStreetMap bridges at the height the laser scan saw them.

The terrain is one height per square metre, so it holds either a deck or
what runs under it, never both. Over water the scanner tends to class the
deck as ground (water returns nothing), so the terrain carries the deck and
the river polygon paints it blue; over a road or tracks the deck is not
ground, the ground beneath lies in its shadow, and hole filling smears the
two into a ramp. So bridges come out of the terrain and are built on their own:

  - OSM bridge ways - roads, paths, railways - say where and how wide;
  - ways that continue one another are joined into chains, so a viaduct split
    into many ways is measured as one;
  - heights come from the scan along each chain: at the abutments, and on the
    deck wherever enough returns lie near a line between them, so masts,
    catenary and lorries do not lift it;
  - the terrain under a deck loses every return near deck height before its
    holes are filled, so the river or the cutting carries on underneath.

Per tile this writes bridges.json, {"decks": [{"k": kind, "t": thickness,
"p": [[x, z, y, half width], ...]}]} in world metres, which the game turns
into slabs to walk and drive on.

Data (c) OpenStreetMap contributors, ODbL; ALS Berlin, dl-de/zero-2.0.
"""
import json
import math
import os

import fetch
import groundcover
from geo import ORIGIN_E, ORIGIN_H, ORIGIN_N, utm33

RAIL = {"rail", "light_rail", "subway", "tram", "narrow_gauge", "monorail",
        "preserved", "funicular"}
RAIL_HALF = 2.1          # one track with its ballast; neighbours sit ~4.2 m apart
PAVEMENT = 1.5           # each side of a carriageway; OSM often leaves it implicit
THICK = {"road": 1.2, "rail": 1.4, "path": 0.6}
STEP = 1.0               # metres between deck stations
BANDS = (3.0, 1.5)       # returns this close to the deck line count as deck
MAX_SLOPE = {"rail": 0.05, "road": 0.12, "path": 0.25}
CLEAR = 2.0              # ground returns above deck height minus this are the deck
ABUT = 4                 # metres of deck at an abutment the terrain is lifted to
LIFT_BELOW = 0.25        # ... to this far under the deck
LIFT_RANGE = 1.5         # ... if it is within this of the deck already
RAIL_SIDE = 2.0          # furniture this close to a deck's edge stands on it
OVERRUN = 1.5            # metres a deck reaches past its abutments
LEVEL_GAP = 4.5          # clearance under a road or rail bridge: lower than this is not the street below
ABUT_REACH = 20.0        # metres past or short of a way's end its abutment (ALKIS) may lie
ABUT_ANGLE = 0.5         # ... crossing the way at least this steeply (sine)
ABUT_LAND = (1, 6)       # metres behind an abutment where the road rests on the ground
ABUT_RISE = 1.5          # ... at most this far from the deck's level, or the slope allows
ABUT_AGREE = 0.5         # ... and this close to the deck's own surface at that end
LAND_RUN = 3.0           # metres a deck resting on an abutment runs on over the ground


def _query(bb):
    return """[out:json][timeout:300];
(
  way["bridge"]["bridge"!="no"]["highway"](%(b)s);
  way["bridge"]["bridge"!="no"]["railway"](%(b)s);
  way["man_made"="bridge"](%(b)s);
);
out geom;
""" % {"b": bb}


def load(bbox_ll, cache_dir, refresh=False):
    """bbox_ll = (south, west, north, east). Cached raw Overpass JSON."""
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, "bridges_%.5f_%.5f_%.5f_%.5f.json" % bbox_ll)
    if not refresh and os.path.exists(path):
        try:
            obj = json.load(open(path))
            if "elements" in obj:
                return obj
        except ValueError:
            pass
    bb = "%.6f,%.6f,%.6f,%.6f" % bbox_ll
    obj = json.loads(fetch.get(groundcover.OVERPASS, timeout=400, retries=2, post=_query(bb)))
    with open(path, "w") as fh:
        json.dump(obj, fh)
    return obj


def kind_of(tags):
    """road, path or rail for a bridge the game builds, else None."""
    if tags.get("bridge") in (None, "no") or tags.get("tunnel") not in (None, "no"):
        return None
    hw = tags.get("highway")
    if hw == "construction":
        # a bridge being rebuilt still stands in the scan (Muehlendamm)
        hw = tags.get("construction") if tags.get("construction") in groundcover.ROAD_WIDTH else "primary"
    if hw in groundcover.ROAD_WIDTH:
        return "path" if hw in groundcover.PATH_KINDS else "road"
    if tags.get("railway") in RAIL:
        return "rail"
    return None


def half_width(tags, kind):
    if kind == "rail":
        return RAIL_HALF
    hw = tags["highway"]
    if hw == "construction":
        hw = tags.get("construction") if tags.get("construction") in groundcover.ROAD_WIDTH else "primary"
    width = groundcover.ROAD_WIDTH[hw]
    if tags.get("lanes", "").isdigit():
        width = max(width, 3.1 * int(tags["lanes"]))
    try:
        width = float(tags.get("width", "").replace("m", "").strip())
    except ValueError:
        pass
    return width / 2 + (PAVEMENT if kind == "road" else 0.25)


def _layer(tags):
    try:
        return int(tags.get("layer", "1"))
    except ValueError:
        return 1


def _chains(ways):
    """Join ways of one kind and layer that continue each other end to end.
    ways: [(kind, layer, [(x, z, hw), ...])]. Returns [(kind, points, joints)],
    joints telling for head and tail whether another bridge goes on from
    there - a fork in mid-air rather than an abutment on the ground."""
    def key(p):
        return (round(p[0], 1), round(p[1], 1))
    ends, anywhere = {}, {}
    for i, (kind, layer, pts) in enumerate(ways):
        for p in (pts[0], pts[-1]):
            ends.setdefault((kind, layer, key(p)), []).append(i)
            anywhere.setdefault(key(p), set()).add(i)
    used = [False] * len(ways)
    out = []
    for i, (kind, layer, pts) in enumerate(ways):
        if used[i]:
            continue
        used[i] = True
        members = {i}
        chain = list(pts)
        for at_tail in (True, False):
            while True:
                p = chain[-1] if at_tail else chain[0]
                nxt = [j for j in ends.get((kind, layer, key(p)), []) if not used[j]]
                if len(nxt) != 1:
                    break
                j = nxt[0]
                used[j] = True
                members.add(j)
                q = ways[j][2]
                if key(q[0]) != key(p):
                    q = q[::-1]
                if at_tail:
                    chain += q[1:]
                else:
                    chain = q[::-1][:-1] + chain
        joints = tuple(bool(anywhere.get(key(p), set()) - members) for p in (chain[0], chain[-1]))
        out.append((kind, chain, joints, layer))
    return out


def _stations(chain):
    """Points every STEP metres along a chain: (x, z, dx, dz, hw)."""
    out = []
    carry = 0.0
    for (ax, az, aw), (bx, bz, bw) in zip(chain, chain[1:]):
        seg = math.hypot(bx - ax, bz - az)
        if seg < 1e-6:
            continue
        dx, dz = (bx - ax) / seg, (bz - az) / seg
        s = carry
        while s < seg:
            t = s / seg
            out.append((ax + dx * s, az + dz * s, dx, dz, aw + (bw - aw) * t))
            s += STEP
        carry = s - seg
    bx, bz, bw = chain[-1]
    if out:
        out.append((bx, bz, out[-1][2], out[-1][3], bw))
    return out


def _beyond(st, end):
    """Narrow sections over the 2-15 m past one end of a station list."""
    x, z, dx, dz, hw = st[end]
    sign = -1 if end == 0 else 1
    return [(x + sign * dx * d, z + sign * dz * d, dx, dz, hw * 0.5) for d in range(2, 16)]


def _limit_slope(ys, slope):
    """No steeper than a road or railway can be. The ends stay put; in
    between, nothing may lie further from either end than that slope
    reaches. A piece whose ends are out of reach of each other even at twice
    the slope - say a stub between two viaduct sections, its ends measured
    on different things - is no deck at all: None."""
    n = len(ys)
    a, b = ys[0], ys[-1]
    if abs(b - a) > 2 * slope * STEP * (n - 1):
        return None
    out = []
    for i, y in enumerate(ys):
        lo = max(a - slope * STEP * i, b - slope * STEP * (n - 1 - i))
        hi = min(a + slope * STEP * i, b + slope * STEP * (n - 1 - i))
        if lo > hi:
            lo = hi = (lo + hi) / 2
        out.append(min(max(y, lo), hi))
    return out


def _median(vals):
    vals = sorted(vals)
    return vals[len(vals) // 2] if vals else None


def _interp(vals):
    """Fill None by linear interpolation; the ends must be known."""
    known = [i for i, v in enumerate(vals) if v is not None]
    out = list(vals)
    for a, b in zip(known, known[1:]):
        for i in range(a + 1, b):
            out[i] = vals[a] + (vals[b] - vals[a]) * (i - a) / (b - a)
    return out


def _smooth(vals, r=3):
    n = len(vals)
    return [sum(vals[max(0, i - r):i + r + 1]) / (min(n, i + r + 1) - max(0, i - r))
            for i in range(n)]


class _Lines:
    """Segments of lines (the abutments) in a coarse grid, to cross with ways."""
    CELL = 16.0

    def __init__(self, lines):
        self.cells = {}
        for line in lines:
            for a, b in zip(line, line[1:]):
                for cx in range(int(math.floor(min(a[0], b[0]) / self.CELL)),
                                int(math.floor(max(a[0], b[0]) / self.CELL)) + 1):
                    for cz in range(int(math.floor(min(a[1], b[1]) / self.CELL)),
                                    int(math.floor(max(a[1], b[1]) / self.CELL)) + 1):
                        self.cells.setdefault((cx, cz), []).append((a, b))

    def cross(self, ax, az, bx, bz):
        """Where segment a-b crosses a line steeply enough: [t along a-b]."""
        ex, ez = bx - ax, bz - az
        le = math.hypot(ex, ez)
        if le < 1e-9:
            return []
        seen, out = set(), []
        for cx in range(int(math.floor(min(ax, bx) / self.CELL)), int(math.floor(max(ax, bx) / self.CELL)) + 1):
            for cz in range(int(math.floor(min(az, bz) / self.CELL)), int(math.floor(max(az, bz) / self.CELL)) + 1):
                for seg in self.cells.get((cx, cz), ()):
                    if id(seg) in seen:
                        continue
                    seen.add(id(seg))
                    (px, pz), (qx, qz) = seg
                    fx, fz = qx - px, qz - pz
                    den = ex * fz - ez * fx
                    lf = math.hypot(fx, fz)
                    if lf < 1e-9 or abs(den) < ABUT_ANGLE * le * lf:
                        continue
                    t = ((px - ax) * fz - (pz - az) * fx) / den
                    u = ((px - ax) * ez - (pz - az) * ex) / den
                    if 0 <= t <= 1 and 0 <= u <= 1:
                        out.append(t)
        return out


def _to_abutment(st, lines):
    """Move the start of a station list to its abutment, the line where the
    bridge rests on the ground (ALKIS Widerlager): OSM's bridge ways stop at
    the river bank, at the kerb of the street below, or run on onto the
    embankment. The way is cut there, or carried on to it at its own
    direction. Returns the new list, or None if no abutment is near."""
    x, z, dx, dz, hw = st[0]
    best = None
    # short of the start: carried on backwards
    for t in lines.cross(x, z, x - dx * ABUT_REACH, z - dz * ABUT_REACH):
        d = -t * ABUT_REACH
        if best is None or abs(d) < abs(best[0]):
            best = (d, None, t)
    # past the start, onto the bridge's first metres
    run = 0.0
    for i in range(len(st) - 1):
        if run > ABUT_REACH or i > (len(st) - 1) // 2:
            break
        (ax, az), (bx, bz) = st[i][:2], st[i + 1][:2]
        seg = math.hypot(bx - ax, bz - az)
        for t in lines.cross(ax, az, bx, bz):
            d = run + t * seg
            if best is None or abs(d) < abs(best[0]):
                best = (d, i, t)
        run += seg
    if best is None:
        return None
    d, i, t = best
    if i is None:
        k = int(-d // STEP)
        lead = [(x + dx * d, z + dz * d, dx, dz, hw)]
        lead += [(x - dx * s, z - dz * s, dx, dz, hw) for s in range(k, 0, -1) if s < -d - 0.3]
        return lead + st
    a, b = st[i], st[i + 1]
    cut = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2], a[3], a[4] + (b[4] - a[4]) * t)
    rest = st[i + 1:] if t < 0.7 else st[i + 2:]
    if len(rest) < 2:
        return None
    return [cut] + rest


def _flip(st):
    return [(x, z, -dx, -dz, hw) for x, z, dx, dz, hw in reversed(st)]


def decks(data, ground, top, grid, covered=None, cadastre=(), abutments=()):
    """Every bridge in the working area with its deck heights (above sea level).

    ground, top: the scan's raw 1 m grids (NaN where nothing was returned),
    grid = (X0, Z0, nx, nz); covered: 1 m mask of station halls and platform
    roofs (hall_mask), under which the upper returns are the roof, not the
    tracks; cadastre: deck outlines from ALKIS (alkis.load), which has every
    bridge - OSM's own outlines only count where ALKIS has none;
    abutments: the lines where bridges rest on the ground (alkis.load), to
    which the ends of the decks are moved, at the height of the ground
    behind them.
    Returns [{"kind", "abut", "st": [(x, z, y, left, right), ...]}]."""
    X0, Z0, nx, nz = grid

    def cell(x, z):
        c, r = int(math.floor(x - X0)), int(math.floor(z - Z0))
        return r * nx + c if 0 <= c < nx and 0 <= r < nz else -1

    def section(x, z, dx, dz, hw, src):
        """Returns of one kind across the deck at a station."""
        vals = []
        o = -hw
        while o <= hw:
            k = cell(x - dz * o, z + dx * o)
            if k >= 0 and not (src is top and covered and covered[k]):
                v = src[k]
                if v == v and v > -1e8:
                    vals.append(v)
            o += 1.0
        return vals

    ways, outlines = [], []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        if tags.get("man_made") == "bridge" and el.get("type") == "way":
            pts = groundcover._pts(el.get("geometry", []))
            if len(pts) >= 4 and abs(pts[0][0] - pts[-1][0]) + abs(pts[0][1] - pts[-1][1]) < 0.05:
                outlines.append(pts[:-1])
            continue
        kind = kind_of(tags) if el.get("type") == "way" else None
        if not kind:
            continue
        pts = groundcover._pts(el.get("geometry", []))
        if len(pts) < 2:
            continue
        hw = half_width(tags, kind)
        ways.append((kind, _layer(tags), [(x, z, hw) for x, z in pts]))

    lines = _Lines(abutments) if abutments else None
    out = []
    for kind, chain, joints, layer in _chains(ways):
        st = _stations(chain)
        if len(st) < 3:
            continue
        # The deck level: what the middle of the bridge returns along its
        # centreline, which the deck itself covers - so not the street below.
        n = len(st)
        mid = st[n * 15 // 100:max(n * 85 // 100, n * 15 // 100 + 1)]
        level = _median([v for x, z, dx, dz, hw in mid for src in (ground, top)
                         for v in section(x, z, dx, dz, max(1.0, hw * 0.4), src)])

        def centre(part):
            return [v for x, z, dx, dz, hw in part for src in (ground, top)
                    for v in section(x, z, dx, dz, max(1.0, hw * 0.4), src)]

        def land(s0):
            """The ground just behind the start of a station list."""
            x, z, dx, dz, hw = s0[0]
            vals = [v for d in range(ABUT_LAND[0], ABUT_LAND[1] + 1)
                    for v in section(x - dx * d, z - dz * d, dx, dz, max(2.0, hw * 0.6), ground)]
            return _median(vals) if len(vals) >= 8 else None

        # Each free end to its abutment (ALKIS), if the ground behind it is
        # at the deck's level: a viaduct passes over the abutments of the
        # street bridges beneath it, metres lower.
        rests = [None, None]            # the ground an end rests on there
        if lines:
            for end in (0, 1):
                if joints[end]:
                    continue
                moved = _to_abutment(st if end == 0 else _flip(st), lines)
                if not moved or len(moved) < 3:
                    continue
                e = land(moved)
                rise = max(ABUT_RISE, MAX_SLOPE[kind] * STEP * len(moved) / 2)
                if e is None or (level is not None and abs(e - level) > rise):
                    continue
                # and the deck itself there: road and bridge meet level. A
                # pedestal, a railing, a stair behind the abutment does not
                own = _median([v for v in centre(moved[:4])
                               if level is None or abs(v - level) <= LEVEL_GAP])
                if own is not None and abs(e - own) > ABUT_AGREE:
                    continue
                st = moved if end == 0 else _flip(moved)
                rests[end] = e

        # The abutments: the road carrying on past each end, where it rests on
        # the ground. Only a height near the deck level counts - OSM often
        # stops a bridge at the edges of the street it spans, so just past
        # its end may still be that street, several metres below.
        ends = []
        for end, part, joint, beyond in zip((0, -1), (st[:4], st[-4:]), joints, (_beyond(st, 0), _beyond(st, -1))):
            e = None
            if rests[end] is not None:
                e = rests[end]
            elif not joint:
                vals = [v for x, z, dx, dz, hw in beyond for v in section(x, z, dx, dz, hw, ground)]
                e = _median(vals) if len(vals) >= 3 else None
            if level is not None and (e is None or abs(e - level) > LEVEL_GAP):
                # a fork in mid-air, or no believable abutment: the deck
                # itself at this end
                e = _median([v for v in centre(part) if abs(v - level) <= LEVEL_GAP])
                if e is None:
                    e = level
            if e is None:
                vals = [v for x, z, dx, dz, hw in part for v in section(x, z, dx, dz, hw, ground)]
                if len(vals) < 3:
                    vals = [v for x, z, dx, dz, hw in part for v in section(x, z, dx, dz, hw, top)]
                e = _median(vals)
            ends.append(e)
        if ends[0] is None and ends[1] is None:
            continue                            # nothing measured: leave it to the terrain
        za = ends[0] if ends[0] is not None else ends[1]
        zb = ends[1] if ends[1] is not None else ends[0]
        n = len(st)
        line = [za + (zb - za) * i / (n - 1) for i in range(n)]
        both = [section(x, z, dx, dz, hw, ground) + section(x, z, dx, dz, hw, top)
                for x, z, dx, dz, hw in st]
        for band in BANDS:
            got = []
            for i, vals in enumerate(both):
                near = [v for v in vals if abs(v - line[i]) < band]
                got.append(_median(near) if len(near) >= 3 else None)
            # abutments are pinned; forks keep what the deck itself says
            if not joints[0] or got[0] is None:
                got[0] = za
            if not joints[1] or got[-1] is None:
                got[-1] = zb
            line = _smooth(_interp(got))
        line = _limit_slope(line, MAX_SLOPE[kind])
        if line is None:
            continue
        pts = [(x, z, y, hw, hw) for (x, z, _dx, _dz, hw), y in zip(st, line)]
        # run on a little past each abutment, onto the road: the deck's end is
        # cut square, and the corners beside it are often still river or
        # embankment, so without this the way off a bridge can be a gap
        # an end resting on an abutment runs on over the ground behind it,
        # which stays as the scan measured it: the road
        strips = []
        x, z, dx, dz, hw = st[0]
        if not joints[0]:
            run = LAND_RUN if rests[0] is not None else OVERRUN
            pts.insert(0, (x - dx * run, z - dz * run, line[0], hw, hw))
            if rests[0] is not None:
                strips.append({"st": pts[:2]})
        x, z, dx, dz, hw = st[-1]
        if not joints[1]:
            run = LAND_RUN if rests[1] is not None else OVERRUN
            pts.append((x + dx * run, z + dz * run, line[-1], hw, hw))
            if rests[1] is not None:
                strips.append({"st": pts[-2:]})
        out.append({"kind": kind, "layer": layer, "abut": (not joints[0], not joints[1]), "st": pts,
                    "land": strips, "rests": sum(r is not None for r in rests)})
    if cadastre:
        def covered_by_cadastre(poly):
            cx = sum(p[0] for p in poly) / len(poly)
            cz = sum(p[1] for p in poly) / len(poly)
            return any(_inside(c, cx, cz) for c in cadastre)
        outlines = list(cadastre) + [o for o in outlines if not covered_by_cadastre(o)]
    return _close_gaps(_fill_outlines(out, outlines))


KIND_RANK = {"road": 0, "path": 1, "rail": 2}
# how far beyond its own width a deck may be widened to its outline, a side
WIDEN = {"road": 40.0, "path": 4.0, "rail": 40.0}
UNDER_GAP = 0.3          # ground at least this far below a deck's underside
MAX_SIDE = 60.0          # metres a deck may be widened to either side
SAME_LEVEL = 1.5         # decks this close in height share one slab


def _inside(poly, x, z):
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, zi = poly[i]
        xj, zj = poly[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            c = not c
        j = i
    return c


def _ray(poly, x, z, dx, dz):
    """Distance from (x, z) along (dx, dz) to the nearest edge of poly."""
    best = None
    for (ax, az), (bx, bz) in zip(poly, poly[1:] + poly[:1]):
        ex, ez = bx - ax, bz - az
        den = dx * ez - dz * ex
        if abs(den) < 1e-12:
            continue
        t = ((ax - x) * ez - (az - z) * ex) / den
        u = ((ax - x) * dz - (az - z) * dx) / den
        if t > 0 and 0 <= u <= 1 and (best is None or t < best):
            best = t
    return best


def _fill_outlines(dks, outlines):
    """Widen decks to the bridge outlines OSM maps (man_made=bridge).

    A road way plus a guessed width covers the carriageway, not the
    pavements, medians and tram tracks of a wide bridge - the rest stayed
    in the terrain at deck height, painted as river. Inside an outline the
    main deck (road before path before rail) is widened to its edges, each
    side on its own, and the other decks at about its height are cut away
    there, since the slab covers them; decks on another level - the U-Bahn
    over the Oberbaumbruecke - stay."""
    for poly in outlines:
        inside = []
        for dk in dks:
            flags = [_inside(poly, p[0], p[1]) for p in dk["st"]]
            if sum(flags) >= 3:
                inside.append((dk, flags))
        if not inside:
            continue
        carrier, cflags = min(inside, key=lambda c: (KIND_RANK[c[0]["kind"]], -sum(c[1])))
        st = carrier["st"]
        for i, inn in enumerate(cflags):
            if not inn:
                continue
            ax, az = st[max(0, i - 1)][:2]
            bx, bz = st[min(len(st) - 1, i + 1)][:2]
            dx, dz = bx - ax, bz - az
            l = math.hypot(dx, dz) or 1.0
            dx, dz = dx / l, dz / l
            x, z, y, wl, wr = st[i]
            reach = WIDEN[carrier["kind"]]
            left = _ray(poly, x, z, -dz, dx)
            right = _ray(poly, x, z, dz, -dx)
            # an outline much wider than the way is someone else's bridge
            # (a footpath under the Stadtbahn inside the viaduct's outline)
            st[i] = (x, z, y,
                     max(wl, left) if left is not None and left <= wl + reach else wl,
                     max(wr, right) if right is not None and right <= wr + reach else wr)
        # and lengthwise: a road line may stop well short of the bridge's
        # ends; run the slab on to the outline at the same height
        for end in (0, -1):
            if not cflags[end] or carrier["kind"] != "road":
                continue
            x, z, y, wl, wr = st[end]
            ax, az = st[1 if end == 0 else -2][:2]
            dx, dz = x - ax, z - az
            l = math.hypot(dx, dz) or 1.0
            dx, dz = dx / l, dz / l
            reach = _ray(poly, x, z, dx, dz)
            if reach and 0.5 < reach < MAX_SIDE:
                tip = (x + dx * reach, z + dz * reach, y, wl, wr)
                if end == 0:
                    st.insert(0, tip)
                    cflags.insert(0, True)
                else:
                    st.append(tip)
                    cflags.append(True)
        cpts = [(p[0], p[1], p[2]) for p, inn in zip(st, cflags) if inn]
        slab = {"st": st}

        def level(x, z):
            return min(cpts, key=lambda q: (q[0] - x) ** 2 + (q[1] - z) ** 2)[2]

        def on_slab(x, z):
            """Does the widened main deck cover (x, z)?"""
            for (ax, az, _ay, al, ar), (bx, bz, _by, bl, br) in _segments(slab):
                ex, ez = bx - ax, bz - az
                l2 = ex * ex + ez * ez
                if l2 < 1e-9:
                    continue
                t = ((x - ax) * ex + (z - az) * ez) / l2
                if not 0.0 <= t <= 1.0:
                    continue
                side = ((x - ax - ex * t) * -ez + (z - az - ez * t) * ex) / math.sqrt(l2)
                if -(ar + (br - ar) * t) <= side <= al + (bl - al) * t:
                    return True
            return False

        keep = []
        for dk in dks:
            hit = next((f for d, f in inside if d is dk), None)
            if dk is carrier or hit is None:
                keep.append(dk)
                continue
            st2 = dk["st"]
            # the same layer inside one outline is the same deck, whatever
            # its own measurement says (a pavement picked up a railing);
            # another layer is another level - the Stadtbahn over a street
            same = dk.get("layer") == carrier.get("layer")
            # only what the main deck really covers goes; the rest of the
            # same bridge stays, at the main deck's height
            covered = [inn and (same or abs(p[2] - level(p[0], p[1])) < SAME_LEVEL) and on_slab(p[0], p[1])
                       for p, inn in zip(st2, hit)]
            if same:
                st2 = [(p[0], p[1], level(p[0], p[1]), p[3], p[4]) if inn else p
                       for p, inn in zip(st2, hit)]
            # what lies outside (or on another level) stays, as runs; each
            # run keeps one covered station so it meets the slab
            runs, cur = [], []
            for i, cov in enumerate(covered):
                if not cov:
                    if not cur and i > 0:
                        cur.append(i - 1)
                    cur.append(i)
                elif cur:
                    cur.append(i)
                    runs.append(cur)
                    cur = []
            if cur:
                runs.append(cur)
            for run in runs:
                if len(run) >= 2:
                    keep.append({"kind": dk["kind"], "layer": dk.get("layer"),
                                 "st": [st2[i] for i in run],
                                 "abut": (run[0] == 0 and dk["abut"][0],
                                          run[-1] == len(st2) - 1 and dk["abut"][1])})
        dks = keep
    return dks


GAP = 10.0               # decks side by side closer than this are joined
GAP_LEVEL = 1.0          # ... if their heights differ by less than this


def _close_gaps(dks):
    """Decks side by side at one level - a carriageway and its separately
    mapped pavements, parallel tracks on a viaduct - each widen to meet the
    other halfway, so no river shows between them."""
    cell = 8.0
    grid = {}
    for di, dk in enumerate(dks):
        st = dk["st"]
        for i in range(len(st) - 1):
            (ax, az), (bx, bz) = st[i][:2], st[i + 1][:2]
            for cx in range(int(math.floor(min(ax, bx) / cell)), int(math.floor(max(ax, bx) / cell)) + 1):
                for cz in range(int(math.floor(min(az, bz) / cell)), int(math.floor(max(az, bz) / cell)) + 1):
                    grid.setdefault((cx, cz), []).append((di, i))

    def nearest(di, x, z, y, dx, dz, reach):
        """First other deck centreline hit along the ray: (distance, its
        width on the side facing us)."""
        best = None
        cells = set()
        for k in range(int(reach / cell) + 2):
            px, pz = x + dx * k * cell, z + dz * k * cell
            for ox in (-1, 0, 1):
                for oz in (-1, 0, 1):
                    cells.add((int(math.floor(px / cell)) + ox, int(math.floor(pz / cell)) + oz))
        for c in cells:
            for dj, j in grid.get(c, ()):
                if dj == di:
                    continue
                a, b = dks[dj]["st"][j], dks[dj]["st"][j + 1]
                ex, ez = b[0] - a[0], b[1] - a[1]
                den = dx * ez - dz * ex
                if abs(den) < 1e-9:
                    continue
                t = ((a[0] - x) * ez - (a[1] - z) * ex) / den
                u = ((a[0] - x) * dz - (a[1] - z) * dx) / den
                if not (0 < t <= reach and 0 <= u <= 1):
                    continue
                if abs(a[2] + (b[2] - a[2]) * u - y) > GAP_LEVEL:
                    continue
                # which of its sides faces us: its left is (-ez, ex)
                facing_left = (dx * -ez + dz * ex) < 0
                w = (a[3] + (b[3] - a[3]) * u) if facing_left else (a[4] + (b[4] - a[4]) * u)
                if best is None or t < best[0]:
                    best = (t, w)
        return best

    out = []
    for di, dk in enumerate(dks):
        st = dk["st"]
        new = []
        for i, (x, z, y, wl, wr) in enumerate(st):
            ax, az = st[max(0, i - 1)][:2]
            bx, bz = st[min(len(st) - 1, i + 1)][:2]
            dx, dz = bx - ax, bz - az
            l = math.hypot(dx, dz) or 1.0
            dx, dz = dx / l, dz / l
            sides = []
            for w, (rx, rz) in ((wl, (-dz, dx)), (wr, (dz, -dx))):
                hit = nearest(di, x, z, y, rx, rz, w + GAP + 30.0)
                if hit:
                    gap = hit[0] - w - hit[1]
                    if 0 < gap <= GAP:
                        w += gap / 2
                sides.append(w)
            new.append((x, z, y, sides[0], sides[1]))
        out.append({**dk, "st": new})
    return out


def hall_mask(ways, nodes, grid):
    """1 m mask of station halls and platform roofs, from osm3d.parse_osm."""
    from raster import Grid
    X0, Z0, nx, nz = grid
    g = Grid(X0, Z0, 1.0, nx, nz)
    for _wid, (ids, tags) in ways.items():
        # station halls and platform canopies only: a raised building part
        # can be a bridge's own arcade with the U-Bahn on top (Oberbaumbruecke)
        hall = (tags.get("building") in ("train_station", "roof", "transportation")
                or tags.get("building:part") == "roof")
        if not hall or len(ids) < 4 or ids[0] != ids[-1]:
            continue
        ring = []
        for i in ids:
            if i in nodes:
                e, n = utm33(*nodes[i])
                ring.append((e - ORIGIN_E, -(n - ORIGIN_N)))
        if len(ring) >= 3:
            g.polygon([ring], 1)
    return g.data


def _near(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) < 0.01


def _segments(dk):
    st = dk["st"]
    return zip(st, st[1:])


def _rasterise(dks, grid, margin, fn):
    """Call fn(k, deck height) for each cell within a deck (plus margin)."""
    X0, Z0, nx, nz = grid
    for dk in dks:
        for (ax, az, ay, al, ar), (bx, bz, by, bl, br) in _segments(dk):
            seg2 = (bx - ax) ** 2 + (bz - az) ** 2
            if seg2 < 1e-9:
                continue
            seg = math.sqrt(seg2)
            nlx, nlz = -(bz - az) / seg, (bx - ax) / seg      # to the left
            w = max(al, ar, bl, br) + margin
            c0 = max(0, int(math.floor(min(ax, bx) - w - X0)))
            c1 = min(nx - 1, int(math.floor(max(ax, bx) + w - X0)))
            r0 = max(0, int(math.floor(min(az, bz) - w - Z0)))
            r1 = min(nz - 1, int(math.floor(max(az, bz) + w - Z0)))
            for r in range(r0, r1 + 1):
                pz = Z0 + r + 0.5
                for c in range(c0, c1 + 1):
                    px = X0 + c + 0.5
                    t = ((px - ax) * (bx - ax) + (pz - az) * (bz - az)) / seg2
                    if not 0.0 <= t <= 1.0:
                        continue
                    side = ((px - ax - (bx - ax) * t) * nlx + (pz - az - (bz - az) * t) * nlz)
                    if -(ar + (br - ar) * t + margin) <= side <= al + (bl - al) * t + margin:
                        fn(r * nx + c, ay + (by - ay) * t)


def clearer(dks, grid):
    """For als.terrain, a pair (clear, settle).

    clear, before hole filling: drop ground returns at deck height under
    every deck, so the filling continues whatever runs beneath - and lift the
    ground under the last few metres at each abutment to just below the
    deck, so road and bridge meet without a step.

    settle, after it: hole filling and smoothing may still bring the ground
    under a deck up through it (from a high quay beside a river, say), where
    it showed as patches of water on the bridge. Everywhere under a deck but
    those abutment ends, the ground is kept below the deck's underside."""
    ends, land = [], []
    for dk in dks:
        st = dk["st"]
        rest = [any(_near(l["st"][0], st[0]) or _near(l["st"][1], st[0]) for l in dk.get("land", ())),
                any(_near(l["st"][0], st[-1]) or _near(l["st"][1], st[-1]) for l in dk.get("land", ()))]
        land += dk.get("land", [])
        # an end on an ALKIS abutment has its strip of ground behind it
        # (land); others the last few metres of their way
        if dk["abut"][0] and not rest[0]:
            ends.append({"st": st[:ABUT + 1]})
        if dk["abut"][1] and not rest[1]:
            ends.append({"st": st[-ABUT - 1:]})
    ends += land
    on_land = set()
    _rasterise(land, grid, 1.0, lambda k, _y: on_land.add(k))

    def clear(h, nx, nz):
        def drop(k, y):
            v = h[k]
            if v == v and v > y - CLEAR and k not in on_land:
                h[k] = float("nan")

        def lift(k, y):
            # just under the deck, not level with it: at the same height
            # the two would flicker through each other. Only ground already
            # close to the deck - the road at the abutment; lifting the
            # river bank beside it made sawtooth walls along the deck's edge
            v = h[k]
            if v == v and y - LIFT_RANGE < v < y - LIFT_BELOW:
                h[k] = y - LIFT_BELOW
        _rasterise(dks, grid, 1.0, drop)
        _rasterise(ends, grid, 0.5, lift)

    def settle(h, nx, nz):
        exempt = set()
        _rasterise(ends, grid, 0.5, lambda k, _y: exempt.add(k))
        for dk in dks:
            under = THICK[dk["kind"]] + UNDER_GAP

            def cap(k, y):
                if k not in exempt and h[k] > y - under:
                    h[k] = y - under
            _rasterise([dk], grid, 0.0, cap)
    return clear, settle


def mask(dks, grid):
    """1 under any deck, per cell of the 1 m grid."""
    X0, Z0, nx, nz = grid
    out = bytearray(nx * nz)

    def put(k, _y):
        out[k] = 1
    _rasterise(dks, grid, 0.0, put)
    return out


def footprint(dks, grid):
    """footprint(x, z): is any deck overhead? For groundcover.build."""
    X0, Z0, nx, nz = grid
    mask = bytearray(nx * nz)

    def put(k, _y):
        mask[k] = 1
    _rasterise(dks, grid, 0.0, put)

    def over(x, z):
        c, r = int(math.floor(x - X0)), int(math.floor(z - Z0))
        return 0 <= c < nx and 0 <= r < nz and mask[r * nx + c] == 1
    return over


def surface(dks, grid, base, kinds=("road", "path")):
    """base(x, z) with road and path decks on top (world heights), for things
    that stand on bridges: lamps, signs, benches. Rail decks are left out:
    streets under railway viaducts are far more common than lamps on them."""
    X0, Z0, nx, nz = grid
    top = {}

    def put(k, y):
        y -= ORIGIN_H
        if y > top.get(k, -1e9):
            top[k] = y
    _rasterise([d for d in dks if d["kind"] in kinds], grid, RAIL_SIDE, put)

    def height(x, z):
        c, r = int(math.floor(x - X0)), int(math.floor(z - Z0))
        if 0 <= c < nx and 0 <= r < nz:
            y = top.get(r * nx + c)
            if y is not None:
                return y
        return base(x, z)
    return height


def _clip(st, x0, z0, x1, z1):
    """Runs of a station list inside [x0, x1) x [z0, z1), cut at the edges."""
    def inside(p):
        return x0 <= p[0] < x1 and z0 <= p[1] < z1

    def lerp(a, b, t):
        return tuple(a[i] + (b[i] - a[i]) * t for i in range(len(a)))

    runs, cur = [], []
    for a, b in zip(st, st[1:]):
        # Liang-Barsky on the segment a -> b
        t0, t1 = 0.0, 1.0
        dx, dz = b[0] - a[0], b[1] - a[1]
        ok = True
        for p, q in ((-dx, a[0] - x0), (dx, x1 - a[0]), (-dz, a[1] - z0), (dz, z1 - a[1])):
            if abs(p) < 1e-12:
                if q < 0:
                    ok = False
                    break
            else:
                t = q / p
                if p < 0:
                    t0 = max(t0, t)
                else:
                    t1 = min(t1, t)
        if not ok or t0 >= t1:
            if len(cur) >= 2:
                runs.append(cur)
            cur = []
            continue
        pa, pb = lerp(a, b, t0), lerp(a, b, t1)
        if not cur:
            cur = [pa]
        cur.append(pb)
        if t1 < 1.0 or not inside(b):
            if len(cur) >= 2:
                runs.append(cur)
            cur = []
    if len(cur) >= 2:
        runs.append(cur)
    return runs


def piers(rings_list, dks, ground):
    """Piers (ALKIS outlines) from the ground up to the deck they carry: the
    lowest deck over them with room beneath. ground(x, z): absolute height.
    Returns [{"r": ring, "y0", "y1"}], heights above sea level."""
    out = []
    for rings in rings_list:
        ring = rings[0]
        cx = sum(p[0] for p in ring) / len(ring)
        cz = sum(p[1] for p in ring) / len(ring)
        g = ground(cx, cz)
        best = None
        for dk in dks:
            for (ax, az, ay, al, ar), (bx, bz, by, bl, br) in _segments(dk):
                ex, ez = bx - ax, bz - az
                l2 = ex * ex + ez * ez
                if l2 < 1e-9:
                    continue
                t = ((cx - ax) * ex + (cz - az) * ez) / l2
                if not 0.0 <= t <= 1.0:
                    continue
                side = ((cx - ax - ex * t) * -ez + (cz - az - ez * t) * ex) / math.sqrt(l2)
                if not -(ar + (br - ar) * t) - 1.0 <= side <= al + (bl - al) * t + 1.0:
                    continue
                under = ay + (by - ay) * t - THICK[dk["kind"]]
                if under > g + 1.0 and (best is None or under < best):
                    best = under
        if best is not None:
            out.append({"r": ring, "y0": g - 0.5, "y1": best + 0.05})
    return out


def write(dks, x0, z0, sx, sz, out, pier_list=(), roofs=()):
    """bridges.json for the tile [x0, x0+sx) x [z0, z0+sz). None if there is
    nothing in it. Piers and roofs belong to the tile their centre lies in."""
    items = []
    for dk in dks:
        # Cut at the tile's edge plus the deck's width: a wide slab crossing
        # the edge at an angle, cut along its centreline, leaves wedges of
        # river between the two tiles' halves. The overlap is the same
        # surface twice, so it shows no seam.
        m = max(max(p[3], p[4]) for p in dk["st"]) + 1.0
        for run in _clip(dk["st"], x0 - m, z0 - m, x0 + sx + m, z0 + sz + m):
            # every other station is plenty for the mesh; keep the run's ends
            pts = run[::2] if len(run) > 4 else run
            if pts[-1] is not run[-1]:
                pts = pts + [run[-1]]
            items.append({"k": dk["kind"], "t": THICK[dk["kind"]],
                          "p": [[round(x, 2), round(z, 2), round(y - ORIGIN_H, 2),
                                 round(wl, 2), round(wr, 2)] for x, z, y, wl, wr in pts]})
    def mine(ring):
        cx = sum(p[0] for p in ring) / len(ring)
        cz = sum(p[1] for p in ring) / len(ring)
        return x0 <= cx < x0 + sx and z0 <= cz < z0 + sz

    def pts(ring):
        return [[round(x, 2), round(z, 2)] for x, z in ring]
    pout = [{"r": pts(p["r"]), "y0": round(p["y0"] - ORIGIN_H, 2), "y1": round(p["y1"] - ORIGIN_H, 2)}
            for p in pier_list if mine(p["r"])]
    rout = [{"r": pts(r["r"]), "y": round(r["y"] - ORIGIN_H, 2), "t": r["t"]}
            for r in roofs if mine(r["r"])]
    if not (items or pout or rout):
        return None
    path = os.path.join(out, "bridges.json")
    data = {"decks": items}
    if pout:
        data["piers"] = pout
    if rout:
        data["roofs"] = rout
    with open(path, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    return {"file": "bridges.json", "count": len(items), "piers": len(pout), "roofs": len(rout),
            "bytes": os.path.getsize(path)}
