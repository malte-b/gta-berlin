"""One surface per bridge: the road and path decks of a bridge share a height.

bridges.py builds a deck per OpenStreetMap way - each carriageway, each
separately mapped pavement, every piece cut at a tile edge - and measures the
height of each on its own from the laser scan. Side by side on one bridge they
disagree by centimetres to a metre, which shows as steps and walls running
along the bridge, and where the scan saw water or the bank under a deck's
middle they sag below both ends: a bridge on the water.

This takes the complete decks that belong together, before tile clipping - overlapping or within
CLUSTER_GAP metres of each other, at about one height - as one bridge, finds
the way it runs, and gives every station the height of one profile along it:
the median of what the decks measured at that point, smoothed, never steeper
than a road allows, and never more than SAG below the straight line between
its two ends (an arch is above that line, a sag below it is the scan seeing
the water). The decks stay as they are in every other respect.

Run by bridges.py, before terrain and furniture are built. A deck that has
been fitted says so ("fit") and is not fitted again.
"""
import math

RES = 1.0                # metres between profile samples
CLUSTER_GAP = 9.0        # decks this close (edge to edge) are one bridge: two carriageways with a median between
SAME_LEVEL = 1.6         # ... if their heights differ by no more than this
MAX_LENGTH = 450.0       # a longer cluster is a viaduct or a street, not a bridge
OUTLIER = 1.0            # a station this far off the profile is another level: left alone
SAG = 0.2                # a profile runs at most this far below the line between its ends
SLOPE = {"road": 0.12, "path": 0.25}
SMOOTH = 3               # profile samples averaged either side


def _footprint(dk, step=1.0):
    """Cells (at `step` metres) a deck covers, with the deck's height there."""
    p = [q if len(q) >= 5 else q[:4] + [q[3]] for q in dk["p"]]
    cells = {}
    for a, b in zip(p, p[1:]):
        ex, ez = b[0] - a[0], b[1] - a[1]
        length = math.hypot(ex, ez)
        if length < 1e-6:
            continue
        ux, uz = ex / length, ez / length
        n = int(length / (step * 0.5)) + 1
        for s in range(n + 1):
            f = s / n
            x, z, y = a[0] + ex * f, a[1] + ez * f, a[2] + (b[2] - a[2]) * f
            wl, wr = a[3] + (b[3] - a[3]) * f, a[4] + (b[4] - a[4]) * f
            o = -wr - CLUSTER_GAP / 2
            while o <= wl + CLUSTER_GAP / 2:
                k = (math.floor((x - uz * o) / step), math.floor((z + ux * o) / step))
                cells.setdefault(k, y)
                o += step * 0.5
    return cells


def _clusters(decks):
    """Indices of the decks that make one bridge each (union-find over their footprints)."""
    parent = list(range(len(decks)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    owner = {}
    def compatible(a, b, ya, yb):
        if a.get("layer") != b.get("layer"):
            return False
        oa, ob = a.get("outline"), b.get("outline")
        if oa and ob:
            return oa == ob and abs(ya - yb) <= 4.5
        # Proximity alone must not join two unrelated bridges, or a crossing
        # road to the raised path beside it. Cadastre identity is stronger.
        def direction(d):
            p, q = d["p"][0], d["p"][-1]
            l = math.hypot(q[0] - p[0], q[1] - p[1]) or 1
            return ((q[0] - p[0]) / l, (q[1] - p[1]) / l)
        ax, az = direction(a)
        bx, bz = direction(b)
        return abs(ya - yb) <= SAME_LEVEL and abs(ax * bx + az * bz) >= 0.9

    for i, dk in enumerate(decks):
        for k, y in _footprint(dk).items():
            for j, yj in owner.get(k, ()):
                if compatible(dk, decks[j], y, yj):
                    parent[find(i)] = find(j)
            owner.setdefault(k, []).append((i, y))
    groups = {}
    for i in range(len(decks)):
        groups.setdefault(find(i), []).append(i)
    return [g for g in groups.values() if len(g) > 1 or len(decks[g[0]]["p"]) >= 4]


def _smooth(vals, r):
    n = len(vals)
    return [sum(vals[max(0, i - r):i + r + 1]) / (min(n, i + r + 1) - max(0, i - r)) for i in range(n)]


def _limit(ys, slope, step):
    """No steeper than `slope`, the ends staying where they are: from both ends in."""
    n = len(ys)
    a, b = ys[0], ys[-1]
    if abs(b - a) > slope * step * (n - 1):
        # Contradictory endpoints are not repaired by moving a landing.
        return [a + (b - a) * i / (n - 1) for i in range(n)]
    out = [min(max(y, a - slope * step * i, b - slope * step * (n - 1 - i)),
               a + slope * step * i, b + slope * step * (n - 1 - i)) for i, y in enumerate(ys)]
    for i in range(1, n):
        out[i] = min(max(out[i], out[i - 1] - slope * step), out[i - 1] + slope * step)
    for i in range(n - 2, -1, -1):
        out[i] = min(max(out[i], out[i + 1] - slope * step), out[i + 1] + slope * step)
    return out


def fit_cluster(decks, ids):
    """Give the stations of decks[i] for i in ids one profile. Returns stations changed."""
    for di in ids:
        p = decks[di]["p"]
        length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(p, p[1:]))
        if length > 8 and math.hypot(p[-1][0] - p[0][0], p[-1][1] - p[0][1]) < length * 0.25:
            return 0  # a roundabout/loop has no single longitudinal height axis
    pts = [(q[0], q[1], q[2], dk["k"], di, qi) for di in ids for dk in [decks[di]]
           for qi, q in enumerate(dk["p"])]
    if len(pts) < 4:
        return 0
    mx = sum(p[0] for p in pts) / len(pts)
    mz = sum(p[1] for p in pts) / len(pts)
    # the way it runs: the roads' own direction, longest decks counting most
    # (angles doubled, so a deck and its reverse agree); paths if no road
    for want in ("road", "path"):
        cx = cz = 0.0
        for di in ids:
            if decks[di]["k"] != want:
                continue
            p = decks[di]["p"]
            for a, b in zip(p, p[1:]):
                ex, ez = b[0] - a[0], b[1] - a[1]
                l = math.hypot(ex, ez)
                if l > 1e-6:
                    cx += (ex * ex - ez * ez) / l
                    cz += 2 * ex * ez / l
        if math.hypot(cx, cz) > 1e-6:
            break
    else:
        return 0
    ang = 0.5 * math.atan2(cz, cx)
    ax, az = math.cos(ang), math.sin(ang)
    s_of = lambda x, z: (x - mx) * ax + (z - mz) * az           # along the bridge
    ss = [s_of(p[0], p[1]) for p in pts]
    length = max(ss) - min(ss)
    if length > MAX_LENGTH or length < 8.0:
        return 0
    s0 = min(ss)
    n = int(length / RES) + 1
    bins = [[] for _ in range(n)]
    for p, s in zip(pts, ss):
        w = 3 if p[3] == "road" else 1                           # the carriageway tells most
        bins[min(n - 1, int((s - s0) / RES))].extend([p[2]] * w)
    ys = [sorted(b)[len(b) // 2] if b else None for b in bins]
    known = [i for i, v in enumerate(ys) if v is not None]
    if len(known) < 2:
        return 0
    for i in range(n):                                           # fill the gaps linearly
        if ys[i] is None:
            lo = max((k for k in known if k < i), default=None)
            hi = min((k for k in known if k > i), default=None)
            ys[i] = (ys[hi] if lo is None else ys[lo] if hi is None
                     else ys[lo] + (ys[hi] - ys[lo]) * (i - lo) / (hi - lo))
    end0 = sum(ys[:3]) / len(ys[:3])
    end1 = sum(ys[-3:]) / len(ys[-3:])
    # A deck has a continuous grade, not one bump per laser cell. Suppress
    # isolated returns before low-pass filtering, keeping measured landings.
    clean = [sorted(ys[max(0, i - 3):i + 4])[len(ys[max(0, i - 3):i + 4]) // 2] for i in range(n)]
    prof = _smooth(_smooth(clean, SMOOTH), SMOOTH)
    prof[0], prof[-1] = ys[0], ys[-1]
    kinds = {p[3] for p in pts}
    # no dip below the line between the ends: the water or the bank under a
    # deck the scan barely saw
    for i in range(n):
        line = end0 + (end1 - end0) * i / max(1, n - 1)
        prof[i] = max(prof[i], line - SAG)
    prof[0], prof[-1] = ys[0], ys[-1]
    prof = _limit(prof, SLOPE["road"] if "road" in kinds else SLOPE["path"], RES)
    outlines = {decks[i].get("outline") for i in ids}
    same_bridge = len(outlines) == 1 and None not in outlines
    changed = 0
    for x, z, y, _k, di, qi in pts:
        f = (s_of(x, z) - s0) / RES
        i = min(n - 2, max(0, int(f)))
        t = min(1.0, max(0.0, f - i))
        h = prof[i] + (prof[i + 1] - prof[i]) * t
        if not same_bridge and abs(y - h) > OUTLIER:
            continue                                             # another level beside the bridge
        if abs(y - h) > 0.0005:
            decks[di]["p"][qi][2] = round(h, 3)
            changed += 1
    return changed


def fit_decks(decks):
    """Fit every bridge among a tile's road and path decks. Returns stations changed."""
    todo = [i for i, dk in enumerate(decks)
            if dk["k"] != "rail" and not dk.get("patch") and not dk.get("fit") and len(dk["p"]) >= 2]
    sub = [decks[i] for i in todo]
    total = 0
    for group in _clusters(sub):
        total += fit_cluster(sub, group)
    for dk in sub:
        dk["fit"] = True
    return total
