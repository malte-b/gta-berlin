"""Triangulation of the planar 3D polygons that CityGML is made of.

LoD2 surfaces are planar rings (one exterior, optionally interior holes).
Standard approach: Newell's normal -> drop the dominant axis to get a 2D
polygon -> bridge holes into the exterior ring -> ear clip.

Everything works on *indices* into a shared vertex array rather than on point
values, because bridging deliberately duplicates vertices and value-keyed
lookups cannot tell the copies apart. Pure stdlib, no numpy.
"""

EPS = 1e-12


def newell(ring):
    """Area-weighted normal of a 3D ring; robust for non-convex polygons."""
    nx = ny = nz = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1, z1 = ring[i]
        x2, y2, z2 = ring[(i + 1) % n]
        nx += (y1 - y2) * (z1 + z2)
        ny += (z1 - z2) * (x1 + x2)
        nz += (x1 - x2) * (y1 + y2)
    ln = (nx * nx + ny * ny + nz * nz) ** 0.5
    if ln < 1e-12:
        return None
    return (nx / ln, ny / ln, nz / ln)


def _project_axes(normal):
    """Pick the two axes to keep when flattening to 2D (drop the dominant one)."""
    ax, ay, az = abs(normal[0]), abs(normal[1]), abs(normal[2])
    if ax >= ay and ax >= az:
        return 1, 2
    if ay >= az:
        return 2, 0
    return 0, 1


def _signed_area(pts2, idx):
    a = 0.0
    n = len(idx)
    for i in range(n):
        x1, y1 = pts2[idx[i]]
        x2, y2 = pts2[idx[(i + 1) % n]]
        a += x1 * y2 - x2 * y1
    return a * 0.5


def _close_ring(ring):
    """CityGML repeats the first point at the end; drop it."""
    if len(ring) > 1 and ring[0] == ring[-1]:
        return ring[:-1]
    return ring


def triangulate(exterior, interiors=()):
    """Rings of (x,y,z) -> ([(p0,p1,p2), ...], normal).

    Returns ([], None) for degenerate input.
    """
    exterior = _close_ring(list(exterior))
    if len(exterior) < 3:
        return [], None
    normal = newell(exterior)
    if normal is None:
        return [], None

    u, v = _project_axes(normal)

    pts3 = list(exterior)
    pts2 = [(p[u], p[v]) for p in exterior]
    outer = list(range(len(exterior)))

    holes = []
    for h in interiors:
        h = _close_ring(list(h))
        if len(h) < 3:
            continue
        start = len(pts3)
        pts3.extend(h)
        pts2.extend((p[u], p[v]) for p in h)
        holes.append(list(range(start, start + len(h))))

    if holes:
        # exterior CCW, holes CW
        if _signed_area(pts2, outer) < 0:
            outer.reverse()
        holes = [h if _signed_area(pts2, h) < 0 else h[::-1] for h in holes]
        poly = _bridge_holes(pts2, outer, holes)
    else:
        poly = outer

    if _signed_area(pts2, poly) < 0:
        poly.reverse()

    tris = []
    for i0, i1, i2 in _earclip(pts2, poly):
        tris.append((pts3[i0], pts3[i1], pts3[i2]))
    return tris, normal


def _bridge_holes(pts2, outer, holes):
    """Cut each hole into the outer ring with a zero-width bridge edge."""
    outer = list(outer)
    # right-to-left, so earlier bridges do not sit in the way of later ones
    holes = sorted(holes, key=lambda h: -max(pts2[i][0] for i in h))
    for hole in holes:
        hk = max(range(len(hole)), key=lambda k: pts2[hole[k]][0])
        hx, hy = pts2[hole[hk]]
        best, bestd = None, None
        for k, oi in enumerate(outer):
            ox, oy = pts2[oi]
            if ox < hx - 1e-9:
                continue
            d = (ox - hx) ** 2 + (oy - hy) ** 2
            if bestd is None or d < bestd:
                bestd, best = d, k
        if best is None:
            best = min(range(len(outer)),
                       key=lambda k: (pts2[outer[k]][0] - hx) ** 2
                       + (pts2[outer[k]][1] - hy) ** 2)
        rot = hole[hk:] + hole[:hk]
        # walk into the hole, back out, then continue along the outer ring
        outer = outer[:best + 1] + rot + [rot[0]] + outer[best:]
    return outer


def _point_in_tri(px, py, ax, ay, bx, by, cx, cy):
    d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
    d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
    d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
    neg = (d1 < -EPS) or (d2 < -EPS) or (d3 < -EPS)
    pos = (d1 > EPS) or (d2 > EPS) or (d3 > EPS)
    return not (neg and pos)


def _earclip(pts2, poly):
    idx = list(poly)
    n = len(idx)
    if n < 3:
        return []
    tris = []
    guard = 0
    limit = 4 * n + 64
    while len(idx) > 3 and guard < limit:
        guard += 1
        m = len(idx)
        clipped = False
        for k in range(m):
            i0, i1, i2 = idx[(k - 1) % m], idx[k], idx[(k + 1) % m]
            ax, ay = pts2[i0]
            bx, by = pts2[i1]
            cx, cy = pts2[i2]
            if (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) <= EPS:
                continue                      # reflex or collinear: not an ear
            corners = ((ax, ay), (bx, by), (cx, cy))
            bad = False
            for j in idx:
                if j in (i0, i1, i2):
                    continue
                px, py = pts2[j]
                # a bridge duplicate sits exactly on a corner; it is the same
                # point, not a blocker
                if (px, py) in corners:
                    continue
                if _point_in_tri(px, py, ax, ay, bx, by, cx, cy):
                    bad = True
                    break
            if bad:
                continue
            tris.append((i0, i1, i2))
            idx.pop(k)
            clipped = True
            guard = 0
            break
        if not clipped:
            break                             # self-intersecting: keep what we have
    if len(idx) == 3:
        tris.append((idx[0], idx[1], idx[2]))
    return tris
