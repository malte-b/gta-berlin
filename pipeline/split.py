"""Split building outlines into parts by measured roof height.

OSM often maps a Berlin perimeter-block house - front building, side wings,
rear building - as one outline with one height. The laser scan sees the
truth: terraces at different levels, a pitched front and a lower flat wing.

  1. the outline's roof cells are grown into connected regions of similar
     height (a step of more than STEP metres between neighbours starts a new
     region), and tiny regions are merged into their neighbours;
  2. every region is traced to a polygon on the 1 m grid, simplified, and
     snapped onto the OSM outline where it runs along it;
  3. each becomes a building:part with its own measured height, so OSM2World
     builds the parts and - as Simple 3D Buildings prescribes - no longer
     draws the outline itself.

"""
import math

STEP = 1.5          # metres between neighbouring cells that starts a new part
MIN_PART = 25       # m2; smaller regions are merged into a neighbour
MIN_SPREAD = 3.0    # only buildings whose roof varies this much are split
SIMPLIFY = 0.8      # Douglas-Peucker tolerance, metres
SNAP = 1.2          # vertices this close to the outline are moved onto it


def _median3(vals):
    vals = sorted(vals)
    return vals[len(vals) // 2]


def regions(ks, height, nx):
    """Connected regions of similar roof height among cells ks.

    height[k] is metres above ground (NaN where the scan saw nothing; those
    cells take the value of a measured neighbour). Returns a list of cell
    lists, largest first, or None when the roof is all one level."""
    member = set(ks)
    v = {}
    for k in ks:
        h = height[k]
        if h == h:
            v[k] = h
    if len(v) < 0.4 * len(ks) or len(v) < 30:
        return None
    # fill gaps from neighbours, a few rounds
    for _ in range(4):
        missing = [k for k in ks if k not in v]
        if not missing:
            break
        for k in missing:
            nb = [v[j] for j in (k - 1, k + 1, k - nx, k + nx) if j in v]
            if nb:
                v[k] = sum(nb) / len(nb)
    ks = [k for k in ks if k in v]
    # 3 x 3 median: chimneys, antennas and single noisy returns go away
    sm = {}
    for k in ks:
        sm[k] = _median3([v[j] for j in (k, k - 1, k + 1, k - nx, k + nx,
                                          k - nx - 1, k - nx + 1, k + nx - 1, k + nx + 1)
                          if j in v])
    vals = sorted(sm.values())
    if vals[int(len(vals) * 0.95)] - vals[int(len(vals) * 0.05)] < MIN_SPREAD:
        return None

    # region growing with a step tolerance
    label = {}
    regs = []
    for seed in sorted(ks, key=lambda k: -sm[k]):
        if seed in label:
            continue
        rid = len(regs)
        label[seed] = rid
        cells = [seed]
        stack = [seed]
        while stack:
            k = stack.pop()
            for j in (k - 1, k + 1, k - nx, k + nx):
                if j in sm and j not in label and j in member \
                        and abs(sm[j] - sm[k]) < STEP:
                    label[j] = rid
                    cells.append(j)
                    stack.append(j)
        regs.append(cells)

    # merge small regions into the neighbour they share most border with
    changed = True
    while changed:
        changed = False
        for rid, cells in enumerate(regs):
            if not cells or len(cells) >= MIN_PART:
                continue
            border = {}
            for k in cells:
                for j in (k - 1, k + 1, k - nx, k + nx):
                    o = label.get(j)
                    if o is not None and o != rid and regs[o]:
                        border[o] = border.get(o, 0) + 1
            if not border:
                continue
            target = max(border, key=border.get)
            for k in cells:
                label[k] = target
            regs[target].extend(cells)
            regs[rid] = []
            changed = True
    regs = sorted((r for r in regs if r), key=len, reverse=True)
    if len(regs) < 2:
        return None
    return [(r, sm) for r in regs]


def trace(cells, nx, x0, z0):
    """Outer boundary of a set of grid cells as a polygon of world x/z."""
    cs = set(cells)
    edges = {}
    for k in cs:
        c, r = k % nx, k // nx
        # counter-clockwise around each cell in (x right, z down) terms; an
        # edge is kept only where the neighbour across it is outside the set
        if k - nx not in cs:
            edges[(c + 1, r)] = (c, r)
        if k + nx not in cs:
            edges[(c, r + 1)] = (c + 1, r + 1)
        if k - 1 not in cs or c == 0:
            edges[(c, r)] = (c, r + 1)
        if k + 1 not in cs or c == nx - 1:
            edges[(c + 1, r + 1)] = (c + 1, r)
    loops = []
    while edges:
        start, nxt = edges.popitem()
        loop = [start]
        cur = nxt
        guard = 0
        while cur != start and cur in edges and guard < 100000:
            loop.append(cur)
            cur = edges.pop(cur)
            guard += 1
        if len(loop) >= 4:
            loops.append(loop)
    if not loops:
        return None
    best = max(loops, key=lambda lp: abs(_area(lp)))
    return [(x0 + c, z0 + r) for c, r in best]


def _area(pts):
    return sum(pts[i][0] * pts[i - 1][1] - pts[i - 1][0] * pts[i][1]
               for i in range(len(pts))) / 2.0


def _dp(pts, tol):
    if len(pts) < 3:
        return pts
    (ax, az), (bx, bz) = pts[0], pts[-1]
    dx, dz = bx - ax, bz - az
    L = math.hypot(dx, dz) or 1e-9
    far, idx = 0.0, 0
    for i in range(1, len(pts) - 1):
        d = abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / L
        if d > far:
            far, idx = d, i
    if far <= tol:
        return [pts[0], pts[-1]]
    return _dp(pts[:idx + 1], tol)[:-1] + _dp(pts[idx:], tol)


def simplify(poly, tol=SIMPLIFY):
    """Douglas-Peucker on a closed ring, split at its two farthest points."""
    n = len(poly)
    i0 = 0
    i1 = max(range(n), key=lambda i: (poly[i][0] - poly[0][0]) ** 2
             + (poly[i][1] - poly[0][1]) ** 2)
    a = poly[i0:i1 + 1]
    b = poly[i1:] + poly[:1]
    out = _dp(a, tol)[:-1] + _dp(b, tol)[:-1]
    return out if len(out) >= 3 else None


def snap(poly, outline):
    """Move vertices that lie along the OSM outline onto it, and nudge every
    vertex a few centimetres toward the part's centre, so the part sits
    inside the outline as OSM2World expects rather than on its edge."""
    edges = [(a, b) for ring in outline for a, b in zip(ring, ring[1:] + ring[:1])]
    cx = sum(p[0] for p in poly) / len(poly)
    cz = sum(p[1] for p in poly) / len(poly)
    out = []
    for x, z in poly:
        best, bp = SNAP, None
        for (ax, az), (bx, bz) in edges:
            dx, dz = bx - ax, bz - az
            L2 = dx * dx + dz * dz or 1e-9
            t = max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / L2))
            px, pz = ax + t * dx, az + t * dz
            d = math.hypot(x - px, z - pz)
            if d < best:
                best, bp = d, (px, pz)
        if bp:
            x, z = bp
        L = math.hypot(cx - x, cz - z) or 1.0
        out.append((x + (cx - x) / L * 0.05, z + (cz - z) / L * 0.05))
    # drop consecutive duplicates that snapping can create
    clean = []
    for p in out:
        if not clean or math.hypot(p[0] - clean[-1][0], p[1] - clean[-1][1]) > 0.3:
            clean.append(p)
    if len(clean) >= 3 and math.hypot(clean[0][0] - clean[-1][0],
                                      clean[0][1] - clean[-1][1]) < 0.3:
        clean.pop()
    return clean if len(clean) >= 3 and abs(_area(clean)) > MIN_PART * 0.5 else None


def split(ks, rings, top, ground, nx, x0, z0):
    """[(polygon, cells)] parts of one building outline, or None."""
    height = {k: top[k] - ground[k] for k in ks}
    regs = regions(ks, height, nx)
    if not regs:
        return None
    parts = []
    for cells, _sm in regs:
        poly = trace(cells, nx, x0, z0)
        if not poly:
            continue
        poly = simplify(poly)
        if not poly:
            continue
        poly = snap(poly, rings)
        if poly:
            parts.append((poly, cells))
    return parts if len(parts) >= 2 else None
