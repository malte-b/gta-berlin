"""Streets, water and green space from OpenStreetMap via Overpass.

LoD2 gives us buildings but no ground detail, so the space between buildings
comes from OSM: road centrelines widened into ribbons, plus water and park
polygons. Data (c) OpenStreetMap contributors, ODbL.

Everything is written into the same 1x1 km tile grid as the buildings, with
each road *segment* assigned to the tile containing its midpoint. That keeps a
tile self-contained (no way is ever cut in half) at the cost of a little
overhang, which the renderer's per-tile bounding box already allows for.
"""
import json
import math
import os

import fetch
from geo import ORIGIN_E, ORIGIN_H, ORIGIN_N, TILE, utm33, utm33_inv
from tilefmt import TileWriter
from tri import triangulate

OVERPASS = "https://overpass-api.de/api/interpreter"

# kind codes shared with the shader
ROAD, PATH, WATER, GREEN, BASE, RAIL = 0, 1, 2, 3, 4, 5

# carriageway width in metres, by OSM highway class
ROAD_WIDTH = {
    "motorway": 15.0, "motorway_link": 8.0,
    "trunk": 13.0, "trunk_link": 7.0,
    "primary": 12.0, "primary_link": 7.0,
    "secondary": 10.0, "secondary_link": 6.0,
    "tertiary": 8.5, "tertiary_link": 5.5,
    "residential": 7.0, "unclassified": 6.5, "living_street": 5.5,
    "service": 4.0, "pedestrian": 6.0,
    "footway": 2.5, "path": 2.0, "cycleway": 2.5, "steps": 2.0,
}
PATH_KINDS = {"footway", "path", "cycleway", "steps", "pedestrian"}

GREEN_LANDUSE = {"grass", "forest", "meadow", "recreation_ground", "cemetery",
                 "village_green", "allotments", "orchard"}
GREEN_LEISURE = {"park", "garden", "pitch", "playground", "golf_course"}

# small vertical offsets so coplanar layers never z-fight
Y_BASE, Y_GREEN, Y_WATER, Y_ROAD, Y_PATH = -0.08, -0.04, -0.06, 0.02, 0.06


def _query(box):
    lons, lats = [], []
    for e in (box[0], box[2] + 1):
        for n in (box[1], box[3] + 1):
            lon, lat = utm33_inv(e * TILE, n * TILE)
            lons.append(lon)
            lats.append(lat)
    bb = "%.6f,%.6f,%.6f,%.6f" % (min(lats), min(lons), max(lats), max(lons))
    hw = "|".join(ROAD_WIDTH)
    return """[out:json][timeout:300];
(
  way["highway"~"^(%s)$"](%s);
  way["natural"="water"](%s);
  way["waterway"="riverbank"](%s);
  way["landuse"~"^(%s)$"](%s);
  way["leisure"~"^(%s)$"](%s);
  way["railway"~"^(rail|light_rail|tram)$"](%s);
);
out geom;
""" % (hw, bb, bb, bb, "|".join(GREEN_LANDUSE), bb, "|".join(GREEN_LEISURE), bb, bb)


def _load(box, cache_dir):
    os.makedirs(cache_dir, exist_ok=True)
    key = "osm_%d_%d_%d_%d.json" % box
    path = os.path.join(cache_dir, key)
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return json.load(open(path))
    data = fetch.get(OVERPASS, timeout=400, retries=2, post=_query(box))
    obj = json.loads(data)
    with open(path, "w") as fh:
        json.dump(obj, fh)
    return obj


def _to_world(geom):
    """[{lat,lon}] -> [(x, z)] in game-world metres, duplicates removed."""
    pts = []
    for g in geom:
        e, n = utm33(g["lon"], g["lat"])
        p = (e - ORIGIN_E, -(n - ORIGIN_N))
        if not pts or abs(p[0] - pts[-1][0]) > 1e-6 or abs(p[1] - pts[-1][1]) > 1e-6:
            pts.append(p)
    return pts


def _offsets(pts, half):
    """Left/right offset points for a polyline, with clamped miter joins."""
    n = len(pts)
    out = []
    for i in range(n):
        if i == 0:
            dx, dz = pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]
            ln = math.hypot(dx, dz) or 1.0
            nx, nz = -dz / ln, dx / ln
            scale = 1.0
        elif i == n - 1:
            dx, dz = pts[-1][0] - pts[-2][0], pts[-1][1] - pts[-2][1]
            ln = math.hypot(dx, dz) or 1.0
            nx, nz = -dz / ln, dx / ln
            scale = 1.0
        else:
            ax, az = pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]
            bx, bz = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
            la = math.hypot(ax, az) or 1.0
            lb = math.hypot(bx, bz) or 1.0
            n0 = (-az / la, ax / la)
            n1 = (-bz / lb, bx / lb)
            mx, mz = n0[0] + n1[0], n0[1] + n1[1]
            lm = math.hypot(mx, mz)
            if lm < 1e-6:                       # 180 degree hairpin
                nx, nz = n0
                scale = 1.0
            else:
                nx, nz = mx / lm, mz / lm
                dot = nx * n0[0] + nz * n0[1]
                scale = 1.0 / dot if dot > 0.35 else 2.85
        out.append(((pts[i][0] + nx * half * scale, pts[i][1] + nz * half * scale),
                    (pts[i][0] - nx * half * scale, pts[i][1] - nz * half * scale)))
    return out


def _tile_of(x, z):
    return (int(math.floor((x + ORIGIN_E) / TILE)),
            int(math.floor((-z + ORIGIN_N) / TILE)))


def _ribbon(writers, pts, half, kind, y_off, terr, box):
    if len(pts) < 2:
        return
    off = _offsets(pts, half)
    for i in range(len(pts) - 1):
        (l0, r0), (l1, r1) = off[i], off[i + 1]
        mx = (pts[i][0] + pts[i + 1][0]) * 0.5
        mz = (pts[i][1] + pts[i + 1][1]) * 0.5
        t = _tile_of(mx, mz)
        if not (box[0] <= t[0] <= box[2] and box[1] <= t[1] <= box[3]):
            continue
        w = writers.setdefault(t, TileWriter(b"BTS1", ()))

        def v(p):
            return (p[0], terr.height(p[0], p[1]) + y_off, p[1])
        a, b, c, d = v(l0), v(r0), v(r1), v(l1)
        w.add_triangle(a, b, c, kind)
        w.add_triangle(a, c, d, kind)


def _area(writers, pts, kind, y_off, terr, box):
    if len(pts) < 3:
        return
    cx = sum(p[0] for p in pts) / len(pts)
    cz = sum(p[1] for p in pts) / len(pts)
    t = _tile_of(cx, cz)
    if not (box[0] <= t[0] <= box[2] and box[1] <= t[1] <= box[3]):
        return
    ring = [(p[0], 0.0, p[1]) for p in pts]
    tris, _n = triangulate(ring)
    if not tris:
        return
    w = writers.setdefault(t, TileWriter(b"BTS1", ()))
    for p0, p1, p2 in tris:
        def v(p):
            return (p[0], terr.height(p[0], p[2]) + y_off, p[2])
        w.add_triangle(v(p0), v(p2), v(p1), kind)


def build(box, out_dir, terr, cache_dir):
    """Write s_<E>_<N>.bin street tiles. Returns per-tile stats."""
    data = _load(box, cache_dir)
    elements = data.get("elements", [])
    print("  overpass returned %d ways" % len(elements), flush=True)

    writers = {}
    # a flat base quad per tile so there is never a hole in the world
    for e in range(box[0], box[2] + 1):
        for n in range(box[1], box[3] + 1):
            x0 = e * TILE - ORIGIN_E
            z0 = -(n * TILE - ORIGIN_N)
            x1, z1 = x0 + TILE, z0 - TILE
            w = writers.setdefault((e, n), TileWriter(b"BTS1", ()))
            corners = [(x0, z0), (x1, z0), (x1, z1), (x0, z1)]
            step = 8                      # subdivide so the base follows terrain
            for i in range(step):
                for j in range(step):
                    ax = x0 + (x1 - x0) * i / step
                    bx = x0 + (x1 - x0) * (i + 1) / step
                    az = z0 + (z1 - z0) * j / step
                    bz = z0 + (z1 - z0) * (j + 1) / step
                    def v(px, pz):
                        return (px, terr.height(px, pz) + Y_BASE, pz)
                    w.add_triangle(v(ax, az), v(bx, az), v(bx, bz), BASE)
                    w.add_triangle(v(ax, az), v(bx, bz), v(ax, bz), BASE)
            del corners

    nroad = narea = nrail = 0
    for el in elements:
        if el.get("type") != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        pts = _to_world(el["geometry"])
        if len(pts) < 2:
            continue
        # anything underground, or on a level below the street, must not be
        # painted onto the surface - Berlin has a lot of both
        if tags.get("tunnel") not in (None, "no"):
            continue
        if tags.get("covered") == "yes":
            continue
        try:
            if int(tags.get("layer", "0")) < 0:
                continue
        except ValueError:
            pass

        hw = tags.get("highway")
        rw = tags.get("railway")
        closed = (len(pts) > 3 and abs(pts[0][0] - pts[-1][0]) < 0.5
                  and abs(pts[0][1] - pts[-1][1]) < 0.5)

        if hw and closed and tags.get("area") == "yes":
            _area(writers, pts, PATH, Y_PATH, terr, box)
            narea += 1
        elif hw:
            width = ROAD_WIDTH.get(hw, 5.0)
            if tags.get("lanes", "").isdigit():
                width = max(width, 3.1 * int(tags["lanes"]))
            kind = PATH if hw in PATH_KINDS else ROAD
            _ribbon(writers, pts, width * 0.5, kind,
                    Y_PATH if kind == PATH else Y_ROAD, terr, box)
            nroad += 1
        elif rw:
            _ribbon(writers, pts, 3.0, RAIL, Y_ROAD, terr, box)
            nrail += 1
        elif closed:
            if tags.get("natural") == "water" or tags.get("waterway") == "riverbank":
                _area(writers, pts, WATER, Y_WATER, terr, box)
                narea += 1
            elif (tags.get("landuse") in GREEN_LANDUSE
                  or tags.get("leisure") in GREEN_LEISURE):
                _area(writers, pts, GREEN, Y_GREEN, terr, box)
                narea += 1

    print("  %d roads, %d rail, %d areas" % (nroad, nrail, narea), flush=True)
    os.makedirs(out_dir, exist_ok=True)
    stats = {}
    for t, w in sorted(writers.items()):
        blob = w.to_bytes()
        if not blob:
            continue
        with open(os.path.join(out_dir, "s_%d_%d.bin" % t), "wb") as fh:
            fh.write(blob)
        stats["%d_%d" % t] = {"streetTriangles": len(w) // 3}
    return stats
