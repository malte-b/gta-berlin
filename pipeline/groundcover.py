"""What the ground is made of, from OpenStreetMap - painted, not modelled.

Separate road and park geometry laid over a 1 m laser-scan terrain either
floats or z-fights, depending on which way the surface curves under it. So
nothing is modelled: roads, paths, green space and water are rasterised into a
0.5 m RGBA mask (one class per channel), and the terrain shader blends
materials by it. Everything drapes perfectly by construction, and the linear
texture filter turns the 0.5 m cells into soft edges for free.

    R  carriageway (and parking)
    G  footway, cycleway, plaza
    B  vegetation: parks, lawns, cemeteries, woodland
    A  water

Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import os

import fetch
from geo import ORIGIN_E, ORIGIN_N, utm33
from raster import Grid, write_png

OVERPASS = "https://overpass-api.de/api/interpreter"
RES = 0.5

# carriageway width in metres, by OSM highway class
ROAD_WIDTH = {
    "motorway": 15.0, "motorway_link": 8.0,
    "trunk": 13.0, "trunk_link": 7.0,
    "primary": 12.0, "primary_link": 7.0,
    "secondary": 10.0, "secondary_link": 6.0,
    "tertiary": 8.5, "tertiary_link": 5.5,
    "residential": 7.0, "unclassified": 6.5, "living_street": 5.5,
    "service": 4.0, "pedestrian": 6.0, "track": 3.0,
    "footway": 2.5, "path": 2.0, "cycleway": 2.5, "steps": 2.0, "bridleway": 2.5,
}
PATH_KINDS = {"footway", "path", "cycleway", "steps", "pedestrian", "bridleway", "track"}

GREEN_LANDUSE = {"grass", "forest", "meadow", "recreation_ground", "cemetery",
                 "village_green", "allotments", "orchard", "flowerbed"}
GREEN_LEISURE = {"park", "garden", "playground", "golf_course", "dog_park"}
GREEN_NATURAL = {"wood", "scrub", "grassland", "heath"}


def _query(bb):
    return """[out:json][timeout:300];
(
  way["highway"](%(b)s);
  way["natural"~"^(water|%(nat)s)$"](%(b)s);
  rel["natural"~"^(water|%(nat)s)$"](%(b)s);
  way["waterway"="riverbank"](%(b)s);
  way["landuse"~"^(%(lu)s)$"](%(b)s);
  rel["landuse"~"^(%(lu)s)$"](%(b)s);
  way["leisure"~"^(%(le)s|pitch)$"](%(b)s);
  rel["leisure"~"^(%(le)s)$"](%(b)s);
  way["amenity"="parking"](%(b)s);
  way["area:highway"](%(b)s);
);
out geom;
""" % {"b": bb, "nat": "|".join(GREEN_NATURAL), "lu": "|".join(GREEN_LANDUSE),
       "le": "|".join(GREEN_LEISURE)}


def load(bbox_ll, cache_dir, refresh=False):
    """bbox_ll = (south, west, north, east). Cached raw Overpass JSON."""
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, "ground_%.5f_%.5f_%.5f_%.5f.json" % bbox_ll)
    if not refresh and os.path.exists(path) and os.path.getsize(path) > 1000:
        return json.load(open(path))
    bb = "%.6f,%.6f,%.6f,%.6f" % bbox_ll
    obj = json.loads(fetch.get(OVERPASS, timeout=400, retries=2, post=_query(bb)))
    with open(path, "w") as fh:
        json.dump(obj, fh)
    return obj


def _pts(geom):
    out = []
    for g in geom:
        if g is None:
            continue
        e, n = utm33(g["lon"], g["lat"])
        out.append((e - ORIGIN_E, -(n - ORIGIN_N)))
    return out


def _rings(el):
    """Rings of a closed way or a multipolygon relation (outer and inner both;
    the even-odd fill makes the inners holes). Member ways of a relation are
    stitched end to end, since OSM splits long boundaries across many ways."""
    if el["type"] == "way":
        p = _pts(el.get("geometry", []))
        return [p] if len(p) >= 3 else []
    parts = [_pts(m.get("geometry", [])) for m in el.get("members", [])
             if m.get("type") == "way" and m.get("role") in ("outer", "inner", "")]
    parts = [p for p in parts if len(p) >= 2]
    rings = []
    while parts:
        ring = parts.pop()
        changed = True
        while changed and _dist(ring[0], ring[-1]) > 0.05:
            changed = False
            for i, p in enumerate(parts):
                if _dist(ring[-1], p[0]) < 0.05:
                    ring += p[1:]
                elif _dist(ring[-1], p[-1]) < 0.05:
                    ring += p[-2::-1]
                elif _dist(ring[0], p[-1]) < 0.05:
                    ring = p[:-1] + ring
                elif _dist(ring[0], p[0]) < 0.05:
                    ring = p[:0:-1] + ring
                else:
                    continue
                parts.pop(i)
                changed = True
                break
        if len(ring) >= 3:
            rings.append(ring)
    return rings


def _dist(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def _underground(tags):
    if tags.get("tunnel") not in (None, "no") and tags.get("tunnel") != "building_passage":
        return True
    try:
        return int(tags.get("layer", "0")) < 0
    except ValueError:
        return False


def build(data, x0, z0, size_x, size_z, out_path):
    """Rasterise into an RGBA PNG. Returns (meta, passages) where passages are
    polylines of ways running *through* buildings (tunnel=building_passage),
    which the navigation grid has to cut out of the building footprints."""
    w = int(round(size_x / RES))
    h = int(round(size_z / RES))
    road, path, green, water = (Grid(x0, z0, RES, w, h) for _ in range(4))
    passages = []
    counts = {"road": 0, "path": 0, "green": 0, "water": 0}

    for el in data.get("elements", []):
        tags = el.get("tags", {})
        if _underground(tags):
            continue
        hw = tags.get("highway")
        if el["type"] == "way" and hw:
            pts = _pts(el.get("geometry", []))
            if len(pts) < 2:
                continue
            if tags.get("tunnel") == "building_passage" or tags.get("covered") == "yes":
                passages.append(pts)
            closed = _dist(pts[0], pts[-1]) < 0.05 and len(pts) > 3
            if closed and tags.get("area") == "yes":
                path.polygon([pts])
                counts["path"] += 1
                continue
            width = ROAD_WIDTH.get(hw)
            if width is None:
                continue
            if tags.get("lanes", "").isdigit():
                width = max(width, 3.1 * int(tags["lanes"]))
            try:
                width = float(tags.get("width", "").replace("m", "").strip())
            except ValueError:
                pass
            if hw in PATH_KINDS:
                path.polyline(pts, width * 0.5)
                counts["path"] += 1
            else:
                road.polyline(pts, width * 0.5)
                counts["road"] += 1
            continue
        if tags.get("area:highway"):
            target = path if tags["area:highway"] in PATH_KINDS else road
            for r in _rings(el):
                target.polygon([r])
            continue
        rings = _rings(el)
        if not rings:
            continue
        if tags.get("natural") == "water" or tags.get("waterway") == "riverbank":
            water.polygon(rings)
            counts["water"] += 1
        elif tags.get("amenity") == "parking":
            road.polygon(rings)
            counts["road"] += 1
        elif tags.get("leisure") == "pitch":
            # sports pitches: grass unless the surface says otherwise
            if tags.get("surface", "grass") in ("grass", "artificial_turf"):
                green.polygon(rings)
            else:
                path.polygon(rings)
        elif (tags.get("landuse") in GREEN_LANDUSE or tags.get("leisure") in GREEN_LEISURE
              or tags.get("natural") in GREEN_NATURAL):
            green.polygon(rings)
            counts["green"] += 1

    size = write_png(out_path, w, h, [road.data, path.data, green.data, water.data])
    meta = {"file": os.path.basename(out_path), "minX": x0, "minZ": z0,
            "res": RES, "w": w, "h": h, "bytes": size}
    return meta, passages, counts, water
