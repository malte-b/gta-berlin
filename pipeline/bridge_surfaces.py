"""Complete bridge surfaces from ALKIS/OSM polygons.

GEOS does the polygon unions, clipping and constrained triangulation offline.
The browser receives the same triangles for rendering and collision. This
preserves holes and tile boundaries without overlapping rectangular patches.
"""
import bisect
import math
from statistics import median

from shapely import Polygon, LineString, Point, box, make_valid, unary_union, constrained_delaunay_triangles


def polygons(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    return [p for g in getattr(geom, "geoms", ()) for p in polygons(g)]


def strip(st):
    import bridges
    es = bridges.edges(st)
    return make_valid(Polygon([a[:2] for a, _ in es] + [b[:2] for _, b in reversed(es)]))


class Profile:
    """A common longitudinal profile; road measurements take precedence."""
    def __init__(self, decks):
        roads = [d for d in decks if d["kind"] == "road"]
        reference = max(roads or decks, key=lambda d: len(d["st"]))
        a, b = reference["st"][0], reference["st"][-1]
        length = math.hypot(b[0] - a[0], b[1] - a[1]) or 1
        self.dx, self.dz = (b[0] - a[0]) / length, (b[1] - a[1]) / length
        if (self.dx, self.dz) < (0, 0):
            self.dx, self.dz = -self.dx, -self.dz
        self.x, self.z = a[:2]
        bins = {}
        for d in roads or decks:
            start, end = d["st"][0], d["st"][-1]
            length = math.hypot(end[0] - start[0], end[1] - start[1]) or 1
            alignment = abs((end[0] - start[0]) * self.dx + (end[1] - start[1]) * self.dz) / length
            if alignment < 0.7:
                continue  # transverse approaches do not set a span's height
            for x, z, y, *_ in d["st"]:
                s = self.station(x, z)
                bins.setdefault(math.floor(s / 2), []).append((s, y))
        samples = [(median(s for s, _ in bins[k]), median(y for _, y in bins[k])) for k in sorted(bins)]
        self.s = [s for s, _ in samples]
        self.y = [y for _, y in samples]
        # Local linear fits remove laser-cell noise while reproducing an
        # actual constant grade exactly, including irregular sample spacing.
        smooth = list(self.y)
        for i in range(1, len(samples) - 1):
            window = samples[max(0, i - 2):i + 3]
            sx = sum(s for s, _ in window) / len(window)
            sy = sum(y for _, y in window) / len(window)
            variance = sum((s - sx) ** 2 for s, _ in window)
            slope = sum((s - sx) * (y - sy) for s, y in window) / (variance or 1)
            smooth[i] = sy + slope * (self.s[i] - sx)
        self.y = smooth

    def station(self, x, z):
        return (x - self.x) * self.dx + (z - self.z) * self.dz

    def point(self, s, side=0):
        return self.x + self.dx * s - self.dz * side, self.z + self.dz * s + self.dx * side

    def height(self, x, z):
        s = self.station(x, z)
        i = bisect.bisect_right(self.s, s)
        if i == 0:
            return self.y[0]
        if i == len(self.s):
            return self.y[-1]
        t = (s - self.s[i - 1]) / (self.s[i] - self.s[i - 1])
        return self.y[i - 1] + t * (self.y[i] - self.y[i - 1])

    def band(self, start, end, width=2000):
        return Polygon([self.point(start, -width), self.point(end, -width),
                        self.point(end, width), self.point(start, width)])


def assemble(decks, outlines, ground=None, grid=None):
    """One polygon per physical span and height level, including its landings."""
    used, result = set(), []
    def ground_at(x, z):
        if ground is None or grid is None:
            return None
        X0, Z0, nx, nz = grid
        c, r = math.floor(x - X0), math.floor(z - Z0)
        if not (0 <= c < nx and 0 <= r < nz):
            return None
        y = ground[r * nx + c]
        return y if math.isfinite(y) else None
    for outline in outlines:
        rings = outline["rings"]
        poly = make_valid(Polygon(rings[0], rings[1:]))
        if poly.is_empty or poly.area < 2:
            continue
        groups = {}
        for i, d in enumerate(decks):
            if i in used:
                continue
            st = d["st"]
            line = LineString([p[:2] for p in st])
            share = line.intersection(poly).length / max(1, line.length)
            named = d.get("name") and d.get("name") == outline.get("name")
            if d.get("outline") != outline["id"] and not (named and line.distance(poly) < 8):
                continue
            # A railway crossing the end of a road bridge is a separate span,
            # even when both source ways happen to use layer=1.
            if d["kind"] == "rail" and share < 0.65:
                continue
            if d["kind"] != "rail" and share < 0.3 and not named:
                continue
            groups.setdefault((d.get("layer", 1), d["kind"] == "rail"), []).append((i, d))
        # The same surveyed footprint cannot be widened into both a road and
        # the rail crossing above it. Keep the rail's own measured width there.
        has_road = any(not rail for _layer, rail in groups)
        for (_layer, rail), members in groups.items():
            if rail and has_road:
                continue
            ds = [d for _, d in members]
            carrier = min(ds, key=lambda d: ({"road": 0, "path": 1, "rail": 2}[d["kind"]], -len(d["st"])))
            p = carrier["st"]
            length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(p, p[1:]))
            if math.hypot(p[-1][0] - p[0][0], p[-1][1] - p[0][1]) < max(1, length * 0.25):
                continue  # preserve a looping route as its surveyed curved strip
            profile = Profile(ds)
            coords = [p for part in polygons(poly) for p in part.exterior.coords]
            stations = [profile.station(*p) for p in coords]
            lo, hi = min(stations), max(stations)
            if hi - lo > 450:
                continue
            # Extend the measured end faces onto their approaches, across the
            # complete width. Individual footway strips used to leave holes.
            ramps = []
            for part in polygons(poly):
                ring = list(part.exterior.coords)
                for a, b in zip(ring, ring[1:]):
                    sa, sb = profile.station(*a), profile.station(*b)
                    length = math.hypot(b[0] - a[0], b[1] - a[1])
                    if length < 0.1 or abs(sb - sa) / length > 0.55:
                        continue
                    middle = (sa + sb) / 2
                    if abs(middle - (lo + hi) / 2) < (hi - lo) * 0.2:
                        continue
                    sign = -1 if middle < (lo + hi) / 2 else 1
                    reach = 4
                    if ground is not None:
                        # Under an elevated railway, the scan may miss the
                        # lower approach for several metres. Carry the road at
                        # its measured level until ground at that level resumes.
                        for distance in range(3, 17):
                            good = 0
                            for f in (0.25, 0.5, 0.75):
                                x = a[0] + (b[0] - a[0]) * f + profile.dx * sign * distance
                                z = a[1] + (b[1] - a[1]) * f + profile.dz * sign * distance
                                y = ground_at(x, z)
                                if y is not None and abs(y - profile.height(x, z)) < 0.5:
                                    good += 1
                            if good >= 2:
                                reach = distance + 3
                                break
                    vx, vz = profile.dx * reach * sign, profile.dz * reach * sign
                    ramps.append(Polygon([a, b, (b[0] + vx, b[1] + vz), (a[0] + vx, a[1] + vz)]))
            # End faces can be skewed or crenellated around abutments. Their
            # individual extrusions alone leave narrow notches across a lane.
            # Continue every mapped carriageway/footway at its own full width,
            # from inside the span to measured approach ground.
            for d in ds:
                route = d["st"]
                for a, b in ((route[0], route[1]), (route[-1], route[-2])):
                    length = math.hypot(a[0] - b[0], a[1] - b[1]) or 1
                    ux, uz = (a[0] - b[0]) / length, (a[1] - b[1]) / length
                    if abs(ux * profile.dx + uz * profile.dz) < 0.7:
                        continue
                    ray = LineString([(a[0] - ux * 500, a[1] - uz * 500), (a[0] + ux * 500, a[1] + uz * 500)])
                    cut = poly.intersection(ray)
                    lines = [cut] if cut.geom_type == "LineString" else list(getattr(cut, "geoms", ()))
                    coords = [p for line in lines if line.geom_type == "LineString" for p in line.coords]
                    if not coords:
                        continue
                    distance = max((x - a[0]) * ux + (z - a[1]) * uz for x, z in coords)
                    ex, ez = a[0] + ux * distance, a[1] + uz * distance
                    width = max(a[3], a[4], 1.0)
                    reach = 4
                    if ground is not None:
                        for distance in range(3, 19):
                            good = 0
                            for side in (-min(width * 0.5, 1.5), 0, min(width * 0.5, 1.5)):
                                x, z = ex + ux * distance - uz * side, ez + uz * distance + ux * side
                                y = ground_at(x, z)
                                if y is not None and abs(y - profile.height(x, z)) < 0.45:
                                    good += 1
                            if good >= 2:
                                reach = distance + 3
                                break
                    sx, sz = ex - ux * 4, ez - uz * 4
                    tx, tz = ex + ux * reach, ez + uz * reach
                    ramps.append(Polygon([(sx - uz * width, sz + ux * width), (sx + uz * width, sz - ux * width),
                                          (tx + uz * width, tz - ux * width), (tx - uz * width, tz + ux * width)]))
            shape = unary_union([poly, *ramps])
            # OSM sometimes splits the paved approach into a transverse way
            # just outside ALKIS's span outline (Hallesches Tor). It belongs to
            # this surface, rather than becoming an independently carved pit.
            approaches = [strip(d["st"]).intersection(poly.buffer(8, join_style="mitre"))
                          for d in ds if LineString([p[:2] for p in d["st"]]).distance(poly) > 0.1]
            if approaches:
                shape = unary_union([shape, *approaches])
            # A cross-section centreline is diagnostic/navigation metadata;
            # the exact polygon, rather than its guessed widths, is rendered.
            points = []
            for j in range(max(2, math.ceil(hi - lo) + 7)):
                s = lo - 3 + j * (hi - lo + 6) / max(1, math.ceil(hi - lo) + 6)
                x, z = profile.point(s)
                ray = LineString([profile.point(s, -200), profile.point(s, 200)])
                hits = shape.intersection(ray)
                lines = [hits] if hits.geom_type == "LineString" else list(getattr(hits, "geoms", ()))
                lines = [line for line in lines if line.geom_type == "LineString" and not line.is_empty and line.length > 1e-5]
                if not lines:
                    continue
                hit = min(lines, key=lambda line: line.distance(Point(x, z)))
                offsets = [-(px - x) * profile.dz + (pz - z) * profile.dx for px, pz in hit.coords]
                # The reference may run just outside a strongly skewed end.
                if min(offsets) > 0 or max(offsets) < 0:
                    shift = (min(offsets) + max(offsets)) / 2
                    x, z = profile.point(s, shift)
                    offsets = [o - shift for o in offsets]
                points.append((x, z, profile.height(x, z), max(0.1, max(offsets)), max(0.1, -min(offsets))))
            if len(points) < 2:
                continue
            # Keep the actual OSM carriageway/path as the diagnostic route.
            # A polygon's extreme cross-section can be just a sharp corner,
            # which is not an entrance to the bridge.
            route = []
            for p in carrier["st"]:
                x, z = p[:2]
                if not shape.buffer(0.01).covers(Point(x, z)):
                    continue
                s = profile.station(x, z)
                section = min(points, key=lambda q: abs(profile.station(q[0], q[1]) - s))
                route.append((x, z, profile.height(x, z), section[3], section[4]))
            if len(route) >= 2:
                for first in (True, False):
                    a, b = (route[0], route[1]) if first else (route[-1], route[-2])
                    length = math.hypot(a[0] - b[0], a[1] - b[1]) or 1
                    dx, dz = (a[0] - b[0]) / length, (a[1] - b[1]) / length
                    extension = []
                    for distance in range(1, 25):
                        x, z = a[0] + dx * distance, a[1] + dz * distance
                        if not shape.covers(Point(x, z)):
                            break
                        extension.append((x, z, profile.height(x, z), a[3], a[4]))
                    route = list(reversed(extension)) + route if first else route + extension
                points = route
            dk = {**carrier, "st": points, "outline": outline["id"], "name": outline.get("name") or carrier.get("name", ""),
                  "osm": sorted({oid for d in ds for oid in d.get("osm", [])}),
                  "abut": (True, True), "assembled": True, "axis": [profile.dx, profile.dz], "_shape": shape, "_span": poly, "_profile": profile,
                  "land": [{"st": points[:4]}, {"st": points[-4:]}]}
            for ramp in ramps + approaches:
                dk["land"].append({"st": points[:2], "assembled": True, "_shape": ramp, "_profile": profile})
            result.append(dk)
            used.update(i for i, _ in members)
    result.extend(d for i, d in enumerate(decks) if i not in used)
    return result


def mesh_for(deck, bounds=None, origin_h=0):
    """Constrained, non-overlapping triangles clipped exactly at tile edges."""
    shape, profile = deck["_shape"], deck["_profile"]
    if bounds:
        shape = shape.intersection(box(*bounds))
    if shape.is_empty or shape.area < 0.01:
        return None
    coords = [p for poly in polygons(shape) for p in poly.exterior.coords]
    if not coords:
        return None
    ss = [profile.station(*p) for p in coords]
    vertices, indices, lookup = [], [], {}
    def vertex(x, z):
        y = profile.height(x, z) - origin_h
        key = round(x, 3), round(z, 3), round(y, 3)
        if key not in lookup:
            lookup[key] = len(vertices)
            vertices.append(list(key))
        return lookup[key]
    # Sampling at the profile's breakpoints makes every triangle a plane of
    # that profile. Global coordinates make clipping deterministic at seams.
    cuts = sorted({min(ss), max(ss), *[s for s in profile.s if min(ss) < s < max(ss)]})
    for start, end in zip(cuts, cuts[1:]):
        if end - start < 1e-6:
            continue
        for part in polygons(shape.intersection(profile.band(start, end))):
            for tri in constrained_delaunay_triangles(part).geoms:
                pts = list(tri.exterior.coords)[:3]
                area = (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0])
                if abs(area) < 1e-8:
                    continue
                if area > 0:
                    pts.reverse()  # x/z clockwise = upward in x/y/z
                indices.extend(vertex(*p) for p in pts)
    def rings_for(geometry):
        rings = []
        for part in polygons(geometry):
            for ring in [part.exterior, *part.interiors]:
                points = list(ring.coords)
                run = []
                for a, b in zip(points, points[1:]):
                    sa, sb = profile.station(*a), profile.station(*b)
                    ts = [0.0] + [(s - sa) / (sb - sa) for s in cuts if min(sa, sb) + 1e-6 < s < max(sa, sb) - 1e-6]
                    for t in sorted(ts):
                        run.append(vertex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
                rings.append(run)
        return rings
    boundary = rings_for(shape)
    span = deck.get("_span", shape)
    if bounds:
        span = span.intersection(box(*bounds))
    rails = rings_for(span)
    return {"v": vertices, "i": indices, "r": boundary, "rails": rails, **({"clip": list(bounds)} if bounds else {})}
