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
SAG = 0.3                # a deck on two abutments dips at most this far below the lower one
CLIFF = 1.0              # a rise steeper than this between two stations splits the deck
# bridge:structure values with the structure standing above the deck: the
# scan's returns along the bridge are the arch or the truss, metres up
THROUGH = {"arch", "truss", "suspension", "cable-stayed", "tied-arch", "bowstring"}


def _through(tags):
    return bool(THROUGH & set(tags.get("bridge:structure", "").replace(" ", "").split(";")))


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
    if tags.get("bridge") in (None, "no") or tags.get("tunnel") not in (None, "no", "building_passage"):
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
        width = max(3.0, 3.1 * int(tags["lanes"]))
        for side in ("left", "right"):
            if tags.get("cycleway:" + side) == "lane":
                try:
                    width += float(tags.get("cycleway:%s:width" % side, "1.5"))
                except ValueError:
                    pass
    try:
        width = float(tags.get("width", "").replace("m", "").strip())
    except ValueError:
        pass
    sidewalk = tags.get("sidewalk") not in ("no", "none", "separate")
    if tags.get("sidewalk:left") == "no" and tags.get("sidewalk:right") == "separate":
        sidewalk = False
    return width / 2 + (PAVEMENT if kind == "road" and sidewalk else 0.25)


def _layer(tags):
    try:
        return int(tags.get("layer", "1"))
    except ValueError:
        return 1


HAIRPIN = -0.5         # cosine of the sharpest turn one deck makes, about 120 degrees


def _chains(ways):
    """Join ways of one kind and layer that continue each other end to end.
    ways: [(kind, layer, [(x, z, hw), ...], through)]. Returns [(kind, points,
    joints, layer, through)], joints telling for head and tail whether another
    bridge goes on from there - a fork in mid-air rather than an abutment on
    the ground - and through whether any of its ways has its structure above
    the deck."""
    def key(p):
        return (round(p[0], 1), round(p[1], 1))

    def straight_on(a, p, c):
        """Whether a -> p -> c carries on rather than turning back: two
        carriageways meeting end to end (Lutherbruecke) are two decks, not
        one folded back over itself."""
        ux, uz, vx, vz = p[0] - a[0], p[1] - a[1], c[0] - p[0], c[1] - p[1]
        lu, lv = math.hypot(ux, uz), math.hypot(vx, vz)
        return lu == 0 or lv == 0 or (ux * vx + uz * vz) / (lu * lv) > HAIRPIN
    ends, anywhere = {}, {}
    for i, (kind, layer, pts, _t, _meta) in enumerate(ways):
        for p in (pts[0], pts[-1]):
            ends.setdefault((kind, layer, key(p)), []).append(i)
            anywhere.setdefault(key(p), set()).add(i)
    used = [False] * len(ways)
    out = []
    for i, (kind, layer, pts, _t, _meta) in enumerate(ways):
        if used[i]:
            continue
        used[i] = True
        members = {i}
        chain = list(pts)
        for at_tail in (True, False):
            while True:
                p = chain[-1] if at_tail else chain[0]
                before = chain[-2] if at_tail else chain[1]

                def onward(j):
                    q = ways[j][2]
                    return q if key(q[0]) == key(p) else q[::-1]
                nxt = [j for j in ends.get((kind, layer, key(p)), []) if not used[j]
                       and straight_on(before, p, onward(j)[1])]
                if len(nxt) != 1:
                    break
                j = nxt[0]
                used[j] = True
                members.add(j)
                q = onward(j)
                if at_tail:
                    chain += q[1:]
                else:
                    chain = q[::-1][:-1] + chain
        joints = tuple(bool(anywhere.get(key(p), set()) - members) for p in (chain[0], chain[-1]))
        meta = {}
        for m in sorted(members):
            meta.update({k: v for k, v in ways[m][4].items() if v not in (None, "")})
        meta["osm"] = sorted({w for m in members for w in ways[m][4]["osm"]})
        out.append((kind, chain, joints, layer, any(ways[m][3] for m in members), meta))
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


def _limit_slope(ys, slope, distances=None):
    """No steeper than a road or railway can be. The ends stay put; in
    between, nothing may lie further from either end than that slope
    reaches. A piece whose ends are out of reach of each other even at twice
    the slope - say a stub between two viaduct sections, its ends measured
    on different things - is no deck at all: None."""
    n = len(ys)
    a, b = ys[0], ys[-1]
    ds = distances or [STEP] * (n - 1)
    run = [0.0]
    for d in ds:
        run.append(run[-1] + d)
    # Reject contradictory measurements rather than make an impassable stub.
    if abs(b - a) > slope * run[-1] + 1e-6:
        return None
    out = []
    for i, y in enumerate(ys):
        lo = max(a - slope * run[i], b - slope * (run[-1] - run[i]))
        hi = min(a + slope * run[i], b + slope * (run[-1] - run[i]))
        if lo > hi:
            lo = hi = (lo + hi) / 2
        out.append(min(max(y, lo), hi))
    for i in range(1, n):
        out[i] = min(max(out[i], out[i - 1] - slope * ds[i - 1]), out[i - 1] + slope * ds[i - 1])
    for i in range(n - 2, -1, -1):
        out[i] = min(max(out[i], out[i + 1] - slope * ds[i]), out[i + 1] + slope * ds[i])
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
        """Returns of one kind across the deck at a station, for the deck on
        `layer`, the one the loop below is measuring."""
        vals = []
        o = -hw
        while o <= hw:
            k = cell(x - dz * o, z + dx * o)
            if k >= 0 and not (src is top and under_hall(covered, k, layer)):
                v = src[k]
                if v == v and v > -1e8:
                    vals.append(v)
            o += 1.0
        return vals

    ways, outlines, through = [], [], []
    elements = data.get("elements", [])
    # Overpass/PBF order is not meaningful: outlines often follow their roads.
    # Read them first so structure and material tags actually reach every way.
    for el in elements:
        tags = el.get("tags", {})
        if tags.get("man_made") == "bridge" and el.get("type") == "way":
            pts = groundcover._pts(el.get("geometry", []))
            if len(pts) >= 4 and abs(pts[0][0] - pts[-1][0]) + abs(pts[0][1] - pts[-1][1]) < 0.05:
                outlines.append({"id": "osm:%s" % el["id"], "rings": [pts[:-1]], "tags": tags,
                                 "name": tags.get("name", "")})
                if _through(tags):
                    through.append(pts[:-1])
    for el in elements:
        tags = el.get("tags", {})
        kind = kind_of(tags) if el.get("type") == "way" else None
        if not kind:
            continue
        pts = groundcover._pts(el.get("geometry", []))
        if len(pts) < 2:
            continue
        hw = half_width(tags, kind)
        # an arch or truss bridge says so on its way or on its outline
        mx, mz = pts[len(pts) // 2] if len(pts) > 2 else ((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2)
        outline_tags = next((o["tags"] for o in outlines if _inside(o["rings"][0], mx, mz)
                             and _layer(o["tags"]) == _layer(tags)), {})
        merged = {**outline_tags, **tags}
        meta = {"osm": [el["id"]], "name": merged.get("bridge:name") or merged.get("name", ""),
                "structure": merged.get("bridge:structure", ""),
                "material": merged.get("bridge:material") or merged.get("material", ""),
                "surface": tags.get("surface", ""),
                "railing": merged.get("railing") or merged.get("handrail", ""),
                "covered": tags.get("tunnel") == "building_passage"}
        ways.append((kind, _layer(tags), [(x, z, hw) for x, z in pts],
                     _through(tags) or any(_inside(o, mx, mz) for o in through), meta))

    lines = _Lines(abutments) if abutments else None
    out = []
    for kind, chain, joints, layer, over, meta in _chains(ways):
        st = _stations(chain)
        if len(st) < 3:
            continue
        # The deck level: what the middle of the bridge returns along its
        # centreline, which the deck itself covers - so not the street below.
        n = len(st)
        mid = st[n * 15 // 100:max(n * 85 // 100, n * 15 // 100 + 1)]
        level = _median([v for x, z, dx, dz, hw in mid for src in (ground, top)
                         for v in section(x, z, dx, dz, max(1.0, hw * 0.4), src)])
        if over and level is not None:
            # An arch or a truss: what the bridge returns along its middle is
            # the structure, metres above the road (Eiswerderbruecke). Where
            # the streets at its ends lie that far below, the deck runs
            # between them, and the scan only refines it near that line.
            streets = []
            for end in (0, -1):
                vals = [v for x, z, dx, dz, hw in _beyond(st, end) for v in section(x, z, dx, dz, hw, ground)]
                streets.append(_median(vals) if len(vals) >= 3 else None)
            # one end may lie past the working area's edge: the other says enough
            known = [v for v in streets if v is not None]
            if known and level - max(known) > LEVEL_GAP:
                level = None

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
            # smoothing must not carry the pinned ends off their abutments:
            # averaged with the low returns beside them, a footbridge's ends
            # came out a metre under the banks it rests on
            line[0], line[-1] = got[0], got[-1]
        if not joints[0] and not joints[1]:
            # resting on the ground at both ends, a deck runs straight or
            # arches up; a dip below both ends is the water or the bank under it
            floor = min(line[0], line[-1]) - SAG
            line = [max(v, floor) for v in line]
        line = _limit_slope(line, MAX_SLOPE[kind], [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(st, st[1:])])
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
        out.append({**meta, "kind": kind, "layer": layer, "abut": (not joints[0], not joints[1]), "st": pts,
                     "land": strips, "rests": sum(r is not None for r in rests)})
    if cadastre:
        cadastre = [c if isinstance(c, dict) else {"id": "alkis:%d" % i, "rings": [c], "name": ""}
                    for i, c in enumerate(cadastre)]
        def covered_by_cadastre(poly):
            cx = sum(p[0] for p in poly) / len(poly)
            cz = sum(p[1] for p in poly) / len(poly)
            return any(_inside(c["rings"][0], cx, cz) for c in cadastre)
        outlines = list(cadastre) + [o for o in outlines if not covered_by_cadastre(o["rings"][0])]
    for dk in out:
        scores = [(sum(_inside(o["rings"][0], p[0], p[1]) for p in dk["st"]), o) for o in outlines]
        if scores:
            score, outline = max(scores, key=lambda pair: pair[0])
            if score >= 3:
                dk["outline"] = outline["id"]
                if outline.get("name"):
                    dk["name"] = outline["name"]
    # Fit before carving terrain, placing furniture or clipping into tiles.
    # Those outputs must all be derived from the same finished surface.
    fit_upper_levels(out, ground, top, grid, covered)
    fit_surfaces(out)
    import bridge_surfaces
    assembled = bridge_surfaces.assemble(out, outlines, ground, grid)
    full = [d for d in assembled if d.get("assembled")]
    for dk in full:
        dk["mesh"] = bridge_surfaces.mesh_for(dk)
    return full + _split_cliffs(_close_gaps([d for d in assembled if not d.get("assembled")]))


def fit_surfaces(dks):
    import bridgefit
    data = [{**dk, "k": dk["kind"], "p": [list(p) for p in dk["st"]]} for dk in dks]
    bridgefit.fit_decks(data)
    for dk, fitted in zip(dks, data):
        dk["st"] = [tuple(p) for p in fitted["p"]]
        dk["fit"] = True
        # Preserve the exact ground-contact strips after fitting, too.
        dk["land"] = [{"st": [min(dk["st"], key=lambda q: math.hypot(q[0] - p[0], q[1] - p[1]))
                              for p in strip["st"]]} for strip in dk.get("land", [])]


def fit_upper_levels(dks, ground, top, grid, covered=None):
    """Remeasure a mapped upper span above a known lower road/path span.

    Mixed ground/top medians can select the road beneath one track. Use the
    lower span to reject those returns, then select the upper deck's dense
    return band. Heights still come from ALS, never from a guessed lift.
    """
    X0, Z0, nx, nz = grid
    groups = {}
    for dk in dks:
        if dk.get("outline"):
            groups.setdefault((dk["outline"], dk.get("layer", 1)), []).append(dk)
    from bridge_surfaces import strip
    shapes = {}
    def footprint(d):
        if id(d) not in shapes:
            shapes[id(d)] = strip(d["st"])
        return shapes[id(d)]
    for (outline, layer), rails in groups.items():
        candidates = [d for d in dks if d["kind"] != "rail" and d.get("layer", 1) < layer]
        lower = []
        for d in candidates:
            if d.get("outline") == outline:
                lower.append(d)
                continue
            # The two storeys of a bridge can have separate cadastral IDs
            # (Kanzleramtssteg). A real planar overlap plus mapped ordering
            # identifies them; mere proximity does not.
            a = footprint(d)
            if any(a.intersection(footprint(r)).area > min(a.area, footprint(r).area) * 0.1 for r in rails):
                lower.append(d)
        if not lower:
            continue
        roads = [d for d in lower if d["kind"] == "road"] or lower
        floor = _median([p[2] for d in roads for p in d["st"]]) + 3.5
        xs = [p[0] for d in roads for p in d["st"]]
        zs = [p[1] for d in roads for p in d["st"]]
        bounds = min(xs) - 15, min(zs) - 15, max(xs) + 15, max(zs) + 15

        def returns(st):
            result = []
            for i, p in enumerate(st):
                a, b = st[max(0, i - 1)], st[min(len(st) - 1, i + 1)]
                length = math.hypot(b[0] - a[0], b[1] - a[1]) or 1
                dx, dz = (b[0] - a[0]) / length, (b[1] - a[1]) / length
                vals = []
                for side in (-1, 0, 1):
                    c, r = math.floor(p[0] - dz * side - X0), math.floor(p[1] + dx * side - Z0)
                    if not (0 <= c < nx and 0 <= r < nz):
                        continue
                    k = r * nx + c
                    for src in (ground, top):
                        if src is top and under_hall(covered, k, layer):
                            continue
                        v = src[k]
                        if math.isfinite(v) and floor < v < floor + 12:
                            vals.append(v)
                result.append(vals)
            return result

        measured = [returns(d["st"]) for d in rails]
        pool = [v for d, scan in zip(rails, measured) for p, vals in zip(d["st"], scan)
                if bounds[0] <= p[0] <= bounds[2] and bounds[1] <= p[1] <= bounds[3] for v in vals]
        if len(pool) < 12:
            continue
        bins = {}
        for y in pool:
            bins.setdefault(round(y * 2), []).append(y)
        mode = _median(max(bins.values(), key=len))
        for dk, scan in zip(rails, measured):
            ys = [_median([v for v in vals if abs(v - mode) < 1.5]) for vals in scan]
            known = [i for i, y in enumerate(ys) if y is not None]
            if len(known) < 3:
                continue
            ys[0], ys[-1] = ys[known[0]], ys[known[-1]]
            ys = _smooth(_interp(ys), 6)
            ds = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(dk["st"], dk["st"][1:])]
            fitted = _limit_slope(ys, MAX_SLOPE[dk["kind"]], ds)
            if fitted:
                dk["st"] = [(p[0], p[1], y, p[3], p[4]) for p, y in zip(dk["st"], fitted)]
                dk["height_source"] = "ALS upper-deck returns, constrained by mapped levels"
        trusted = [d for d in rails if d.get("height_source")]
        if trusted:
            ref = max(trusted, key=lambda d: len(d["st"]))["st"]
            length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(ref, ref[1:]))
            if math.hypot(ref[-1][0] - ref[0][0], ref[-1][1] - ref[0][1]) < max(1, length * 0.25):
                continue
            from bridge_surfaces import Profile
            shared = Profile(trusted)
            for dk in rails:
                dk["st"] = [(x, z, shared.height(x, z), wl, wr) for x, z, _y, wl, wr in dk["st"]]
                dk["height_source"] = "ALS shared upper-deck profile, constrained by mapped levels"


def _split_cliffs(dks):
    """No deck has a wall in it: where two neighbouring stations differ in
    height by more than CLIFF times their distance (and more than a step), the
    piece is two decks at their own levels - a stub left between a street and
    the bridge above it would otherwise join them with a 5 m step."""
    out = []
    for dk in dks:
        st = dk["st"]
        runs, start = [], 0
        for i in range(len(st) - 1):
            rise = abs(st[i + 1][2] - st[i][2])
            if rise > 1.0 and rise > CLIFF * math.hypot(st[i + 1][0] - st[i][0], st[i + 1][1] - st[i][1]):
                runs.append((start, i))
                start = i + 1
        runs.append((start, len(st) - 1))
        if len(runs) == 1:
            out.append(dk)
            continue
        for a, b in runs:
            if b > a:
                abut = (dk["abut"][0] and a == 0, dk["abut"][1] and b == len(st) - 1)
                out.append({**dk, "st": st[a:b + 1], "abut": abut})
    return out


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
    for outline in outlines:
        poly = outline["rings"][0]
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
                     max(0.1, left) if left is not None and left <= wl + reach else wl,
                     max(0.1, right) if right is not None and right <= wr + reach else wr)
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
            # OSM layer is local ordering, not a city-wide height. A railway
            # and a road can both say layer=1 while crossing on different
            # structures (Hallesches Tor / Mehringbruecke).
            if (dk["kind"] == "rail") != (carrier["kind"] == "rail"):
                same = same and abs(_median([p[2] for p, inn in zip(st2, hit) if inn]) - _median([p[2] for p in cpts])) < SAME_LEVEL
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
                    keep.append({**dk,
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
                if dks[di].get("layer") != dks[dj].get("layer"):
                    continue
                oi, oj = dks[di].get("outline"), dks[dj].get("outline")
                if oi and oj and oi != oj:
                    continue
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


HALL_OVER_ALL = 255    # hall_mask value of a hall over every deck
HALL_CLEAR = 9.0       # metres: a hall mapped lower cannot span an elevated track


def hall_mask(ways, nodes, grid):
    """1 m mask of station halls and platform roofs, from osm3d.parse_osm:
    per cell 0 where there is no hall, else 128 + the highest layer of deck a
    hall there is over (see under_hall). A hall mapped lower than HALL_CLEAR
    is over the decks on its own layer and below - no layer is layer 0 - and
    one taller, or without a height, is over every deck."""
    from raster import Grid
    X0, Z0, nx, nz = grid
    g = Grid(X0, Z0, 1.0, nx, nz)
    halls = []
    for _wid, (ids, tags) in ways.items():
        # station halls and platform canopies only: a raised building part
        # can be a bridge's own arcade with the U-Bahn on top (Oberbaumbruecke)
        hall = (tags.get("building") in ("train_station", "roof", "transportation")
                or tags.get("building:part") == "roof")
        if not hall or len(ids) < 4 or ids[0] != ids[-1]:
            continue
        try:
            top = float((tags.get("height") or tags["min_height"]).split()[0])
            layer = int(tags.get("layer", "0"))
        except (KeyError, ValueError, IndexError):
            top = layer = None
        if top is None or top >= HALL_CLEAR:
            value = HALL_OVER_ALL
        else:
            value = 128 + max(-127, min(126, layer))
        ring = []
        for i in ids:
            if i in nodes:
                e, n = utm33(*nodes[i])
                ring.append((e - ORIGIN_E, -(n - ORIGIN_N)))
        if len(ring) >= 3:
            halls.append((value, ring))
    # the highest last: it is the one that decides
    for value, ring in sorted(halls, key=lambda h: h[0]):
        g.polygon([ring], value)
    return g.data


def under_hall(covered, k, layer):
    """Whether the hall_mask cell k is a roof over a deck on this layer, so
    the scan's upper returns there are the roof, not the deck. A low hall on
    a lower layer is the structure beneath the deck: OSM draws the U1
    viaduct along Skalitzer Strasse as building=roof, layer 1, min_height 6,
    under its tracks on layer 2, and the hall before Warschauer Strasse as a
    6 m building without a layer with the tracks on its roof. Ignoring their
    returns put the U-Bahn on the street. Zoo's hall, 20 m tall on layer 1,
    still spans its tracks on layer 2."""
    return covered is not None and covered[k] >= 128 + layer


def _near(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) < 0.01


def _segments(dk):
    st = dk["st"]
    return zip(st, st[1:])


def edges(st):
    """Mitred strip sections, (left, right) in x/z/y order; as Decks.sections."""
    out = []
    def direction(a, b):
        d = math.hypot(b[0] - a[0], b[1] - a[1]) or 1
        return (b[0] - a[0]) / d, (b[1] - a[1]) / d
    for i, (x, z, y, wl, wr) in enumerate(st):
        a = direction(st[max(0, i - 1)], st[1 if i == 0 else i])
        b = direction(st[i - 1 if i == len(st) - 1 else i], st[min(len(st) - 1, i + 1)])
        length = math.hypot(a[0] + b[0], a[1] + b[1])
        dx, dz = ((a[0] + b[0]) / length, (a[1] + b[1]) / length) if length > 1e-6 else b
        m = 1 / max(0.5, dx * b[0] + dz * b[1])
        out.append(((x - dz * wl * m, z + dx * wl * m, y), (x + dz * wr * m, z - dx * wr * m, y)))
    return out


def triangle_height(x, z, a, b, c):
    ex, ez, fx, fz = b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]
    det = ex * fz - ez * fx
    if abs(det) < 1e-9:
        return None
    u = ((x - a[0]) * fz - (z - a[1]) * fx) / det
    v = (ex * (z - a[1]) - ez * (x - a[0])) / det
    if u >= -1e-8 and v >= -1e-8 and u + v <= 1 + 1e-8:
        return a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2])
    return None


class SurfaceIndex:
    """Spatial lookup of the actual deck triangles, for terrain and props."""
    CELL = 32

    def __init__(self, dks):
        self.buckets = {}
        for dk in dks:
            mesh = dk.get("mesh")
            if mesh:
                vs, ix = mesh["v"], mesh["i"]
                quads = [(vs[ix[i]], vs[ix[i + 1]], vs[ix[i + 2]], vs[ix[i]]) for i in range(0, len(ix), 3)]
            else:
                es = edges(dk["st"])
                quads = [(al, bl, br, ar) for (al, ar), (bl, br) in zip(es, es[1:])]
            for q in quads:
                for c in range(math.floor(min(v[0] for v in q) / self.CELL), math.floor(max(v[0] for v in q) / self.CELL) + 1):
                    for r in range(math.floor(min(v[1] for v in q) / self.CELL), math.floor(max(v[1] for v in q) / self.CELL) + 1):
                        self.buckets.setdefault((c, r), []).append(q)

    def height(self, x, z):
        best = None
        for a, b, c, d in self.buckets.get((math.floor(x / self.CELL), math.floor(z / self.CELL)), ()):
            y = triangle_height(x, z, a, b, c)
            if y is None:
                y = triangle_height(x, z, a, c, d)
            if y is not None and (best is None or y > best):
                best = y
        return best


def _rasterise(dks, grid, margin, fn):
    """Call fn(k, deck height) for each cell within a deck (plus margin)."""
    X0, Z0, nx, nz = grid
    for dk in dks:
        if dk.get("assembled") and "_shape" in dk:
            from bridge_surfaces import polygons
            from raster import cells
            shape = dk["_shape"].buffer(margin, join_style="mitre") if margin else dk["_shape"]
            for part in polygons(shape):
                rings = [list(part.exterior.coords)] + [list(r.coords) for r in part.interiors]
                for k in cells(rings, X0, Z0, 1, nx, nz):
                    fn(k, dk["_profile"].height(X0 + k % nx + 0.5, Z0 + k // nx + 0.5))
            continue
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
                ceiling = y - (0.06 if k in exempt else under)
                if h[k] > ceiling:
                    h[k] = ceiling
            _rasterise([dk], grid, 0.0, cap)
    return clear, settle


def blend_landings(dks, h, wet, grid):
    """Blend the last metres of surveyed approaches into the surrounding road.
    A local terrain pit/kerb must not become a step at a slab's square end."""
    from shapely import Point, unary_union
    from bridge_surfaces import polygons
    from raster import cells
    X0, Z0, nx, nz = grid
    for dk in dks:
        contacts = [s["_shape"] for s in dk.get("land", []) if "_shape" in s]
        if not contacts:
            continue
        contact = unary_union(contacts)
        for part in polygons(contact.buffer(3, join_style="mitre")):
            rings = [list(part.exterior.coords)] + [list(r.coords) for r in part.interiors]
            for k in cells(rings, X0, Z0, 1, nx, nz):
                if wet[k]:
                    continue
                x, z = X0 + k % nx + 0.5, Z0 + k // nx + 0.5
                y = dk["_profile"].height(x, z) - 0.06
                if abs(h[k] - y) > 1.5:
                    continue
                t = min(1, contact.distance(Point(x, z)) / 3)
                t = t * t * (3 - 2 * t)
                h[k] = y * (1 - t) + h[k] * t


def split_carried(dks, wet):
    """Split decks into (slabs, carried). A road or path deck whose middle lies
    over water - wet(x, z) - is carried by the ground itself: the terrain is
    raised to its height (stamp) and painted like any street, so there is no
    slab, no pit cut round it and no cliff where slab meets bank. Everything
    else - rail, and decks over streets and tracks, where the terrain cannot
    hold the deck - stays a slab."""
    slabs, carried = [], []
    for dk in dks:
        st = dk["st"][1:-1]
        if dk["kind"] == "rail" or len(st) < 3:
            slabs.append(dk)
            continue
        over = sum(1 for q in st if wet(q[0], q[1]))
        (carried if over >= 0.5 * len(st) else slabs).append(dk)
    return slabs, carried


def fit_carried(dks):
    """bridgefit.py on carried decks (their stations are tuples here)."""
    import bridgefit
    as_json = [{"k": dk["kind"], "p": [list(q) for q in dk["st"]]} for dk in dks]
    bridgefit.fit_decks(as_json)
    for dk, fj in zip(dks, as_json):
        dk["st"] = [tuple(q) for q in fj["p"]]


def stamp(dks, h, grid):
    """Set the terrain h (a 1 m grid, row-major) under the decks to their height.
    Returns {cell: is_road} for the cells set."""
    best, road = {}, {}

    def put_for(is_road):
        def put(k, y):
            if y > best.get(k, -1e9):
                best[k] = y
            if is_road:
                road[k] = True
        return put
    for dk in dks:
        _rasterise([dk], grid, 0.0, put_for(dk["kind"] == "road"))
    for k, y in best.items():
        h[k] = y
    return {k: road.get(k, False) for k in best}


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
    index = SurfaceIndex([d for d in dks if d["kind"] in kinds])

    def height(x, z):
        y = index.height(x, z)
        if y is not None:
            return y - ORIGIN_H
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
        meta = {k: dk[k] for k in ("osm", "outline", "name", "layer", "structure", "material", "surface", "railing", "covered", "fit", "assembled", "axis", "height_source") if k in dk}
        if dk.get("assembled"):
            from bridge_surfaces import mesh_for
            mesh = mesh_for(dk, (x0, z0, x0 + sx, z0 + sz), ORIGIN_H)
            if mesh is not None:
                items.append({**meta, "k": dk["kind"], "t": THICK[dk["kind"]], "mesh": mesh,
                              "p": [[round(x, 3), round(z, 3), round(y - ORIGIN_H, 3), round(wl, 3), round(wr, 3)]
                                    for x, z, y, wl, wr in dk["st"]]})
            continue
        # Cut at the tile's edge plus the deck's width: a wide slab crossing
        # the edge at an angle, cut along its centreline, leaves wedges of
        # river between the two tiles' halves. The overlap is the same
        # surface twice, so it shows no seam.
        m = max(max(p[3], p[4]) for p in dk["st"]) + 1.0
        for run in _clip(dk["st"], x0 - m, z0 - m, x0 + sx + m, z0 + sz + m):
            # every other station is plenty for the mesh; keep the run's ends
            pts = run
            items.append({**meta,
                          "k": dk["kind"], "t": THICK[dk["kind"]],
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
