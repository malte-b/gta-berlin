"""Structures from the Berlin cadastre (ALKIS), where OSM is thin.

ALKIS maps every bridge as the outline of its deck, with the lines where it
rests on the ground (Widerlager) and its piers; OSM has bridge lines and, now
and then, an outline (man_made=bridge). It also maps every canopy
(Ueberdachung) - platform roofs, petrol stations, bus shelters - of which
OSM has about half. Both come from the WFS at gdi.berlin.de as GeoJSON in
EPSG:25833, cached per working window.

    bridges: [{"rings": [[(x, z), ...]], "kind": "bridge" | "elevated", "name"}]
    abutments, piers: lines [(x, z), ...] and pier outlines (rings)
    canopies: [{"rings": [...], "kind": "canopy" | "carport"}]
    buildings, underground: building outlines (rings) at and below the surface

It also maps every building, with whether it lies under the surface (a
garage under a courtyard, a station hall): an OSM building where ALKIS has
only one underground, and the scan no roof, is a phantom (phantoms).

Data: Geoportal Berlin / ALKIS Berlin, dl-de/zero-2.0.
"""
import json
import os

import fetch
from geo import ORIGIN_E, ORIGIN_N

WFS = "https://gdi.berlin.de/services/wfs/alkis"
# Bauwerksfunktion (bwf) codes
BRIDGE = {"1800": "bridge", "1830": "elevated"}       # Bruecke; Hochbahn, Hochstrasse
PIER = "1840"
ABUTMENT = "1845"
CANOPY = {"1610": "canopy", "1611": "carport"}
UNDERGROUND = 1200      # Gebaeude, ofl: unter der Erdoberflaeche


def _get(layer, box, cache_dir, refresh):
    E0, N0, E1, N1 = box
    path = os.path.join(cache_dir, "%s_%d_%d_%d_%d.json" % (layer, E0, N0, E1, N1))
    if not refresh and os.path.exists(path):
        try:
            return json.load(open(path))["features"]
        except (ValueError, KeyError):
            pass
    feats, start = [], 0
    while True:
        url = ("%s?service=WFS&version=2.0.0&request=GetFeature&typeNames=alkis:%s"
               "&bbox=%d,%d,%d,%d,urn:ogc:def:crs:EPSG::25833&outputFormat=application/json"
               "&count=10000&startIndex=%d" % (WFS, layer, E0, N0, E1, N1, start))
        page = json.loads(fetch.get(url, timeout=300, retries=3))["features"]
        feats += page
        if len(page) < 10000:
            break
        start += len(page)
    os.makedirs(cache_dir, exist_ok=True)
    with open(path + ".part", "w") as fh:
        json.dump({"features": feats}, fh)
    os.replace(path + ".part", path)
    return feats


def _w(pt):
    return (pt[0] - ORIGIN_E, -(pt[1] - ORIGIN_N))


def _polygons(geom):
    if not geom:
        return []
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def _lines(geom):
    if not geom:
        return []
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []


def load(box, cache_dir, refresh=False):
    """Structures in box = (E0, N0, E1, N1), EPSG:25833 metres, in world x/z."""
    out = {"bridges": [], "abutments": [], "piers": [], "canopies": [],
           "buildings": [], "underground": []}
    for f in _get("bauwerkeflaechen", box, cache_dir, refresh):
        p = f.get("properties", {})
        bwf = p.get("bwf")
        for poly in _polygons(f.get("geometry")):
            rings = [[_w(pt) for pt in ring[:-1]] for ring in poly if len(ring) >= 4]
            if not rings:
                continue
            if bwf in BRIDGE:
                out["bridges"].append({"rings": rings, "kind": BRIDGE[bwf], "name": p.get("nam") or ""})
            elif bwf == PIER:
                out["piers"].append(rings)
            elif bwf in CANOPY:
                out["canopies"].append({"rings": rings, "kind": CANOPY[bwf]})
    for f in _get("bauwerkelinien", box, cache_dir, refresh):
        if f.get("properties", {}).get("bwf") == ABUTMENT:
            for line in _lines(f.get("geometry")):
                out["abutments"].append([_w(pt) for pt in line])
    for f in _get("gebaeudeflaechen", box, cache_dir, refresh):
        where = "underground" if f.get("properties", {}).get("ofl") == UNDERGROUND else "buildings"
        for poly in _polygons(f.get("geometry")):
            rings = [[_w(pt) for pt in ring[:-1]] for ring in poly if len(ring) >= 4]
            if rings:
                out[where].append(rings)
    return out


ROOF_T = 0.3             # canopy slab thickness, metres
ROOF_MIN = 2.0           # a canopy's roof at least this far over the ground ...
ROOF_MAX = 25.0          # ... and at most this far
OSM_SHARE = 0.5          # canopies this much under an OSM building are OSM2World's


def osm_mask(ways, nodes, grid):
    """1 m mask of every OSM building and building part (osm3d.parse_osm)."""
    from raster import Grid
    from geo import utm33
    X0, Z0, nx, nz = grid
    g = Grid(X0, Z0, 1.0, nx, nz)
    for _wid, (ids, tags) in ways.items():
        if ("building" not in tags and "building:part" not in tags) or len(ids) < 4 or ids[0] != ids[-1]:
            continue
        ring = []
        for i in ids:
            if i in nodes:
                e, n = utm33(*nodes[i])
                ring.append((e - ORIGIN_E, -(n - ORIGIN_N)))
        if len(ring) >= 3:
            g.polygon([ring], 1)
    return g.data


def roofs(cad, ground, top, grid, osm):
    """The canopies OSM lacks, as flat slabs at the height the scan saw their
    roofs: [{"r": outline, "y": top (above sea level), "t": thickness}].
    ground, top: the scan's raw 1 m grids; osm: osm_mask."""
    from raster import cells
    X0, Z0, nx, nz = grid
    out = []
    for c in cad["canopies"]:
        ks = cells(c["rings"], X0, Z0, 1.0, nx, nz)
        if len(ks) < 4:
            continue
        if sum(1 for k in ks if osm[k]) > OSM_SHARE * len(ks):
            continue
        tops = sorted(v for v in (top[k] for k in ks) if v == v and v > -1e8)
        # under a roof the scan sees little ground: around it as well
        xs = [p[0] for p in c["rings"][0]]
        zs = [p[1] for p in c["rings"][0]]
        c0, c1 = max(0, int(min(xs) - X0) - 3), min(nx - 1, int(max(xs) - X0) + 3)
        r0, r1 = max(0, int(min(zs) - Z0) - 3), min(nz - 1, int(max(zs) - Z0) + 3)
        grounds = sorted(v for v in (ground[r * nx + cc] for r in range(r0, r1 + 1)
                                     for cc in range(c0, c1 + 1)) if v == v and v > -1e8)
        if len(tops) < 3 or not grounds:
            continue
        y = tops[len(tops) * 3 // 4]          # the roof, not what shows past its edge
        g = grounds[len(grounds) // 2]
        if ROOF_MIN < y - g < ROOF_MAX:
            out.append({"r": c["rings"][0], "y": y, "t": ROOF_T})
    return out


PHANTOM_UNDER = 0.5      # share of an OSM outline over an underground ALKIS building ...
PHANTOM_OVER = 0.2       # ... and at most this much over one at the surface
PHANTOM_H = 2.0          # ... and the scan's median roof lower than this: nothing stands there


def phantoms(cad, nodes, ways, ground, top, grid):
    """OSM buildings that are not there: mapped over an underground garage or
    hall as if it stood on the street, so OSM2World raised a block where the
    street, the square, the courtyard is. ALKIS has only the underground
    building there and the scan sees no roof. Returns the OSM way ids."""
    from raster import Grid, cells
    from geo import utm33
    X0, Z0, nx, nz = grid
    under, over = Grid(X0, Z0, 1.0, nx, nz), Grid(X0, Z0, 1.0, nx, nz)
    for rings in cad["underground"]:
        under.polygon(rings, 1)
    for rings in cad["buildings"]:
        over.polygon(rings, 1)
    out = set()
    for wid, (ids, tags) in ways.items():
        if "building" not in tags or len(ids) < 4 or ids[0] != ids[-1]:
            continue
        if tags.get("building") in ("roof", "carport", "no") or tags.get("location"):
            continue
        ring = []
        for i in ids:
            if i in nodes:
                e, n = utm33(*nodes[i])
                ring.append((e - ORIGIN_E, -(n - ORIGIN_N)))
        ks = cells([ring], X0, Z0, 1.0, nx, nz) if len(ring) >= 3 else []
        if len(ks) < 4:
            continue
        if sum(1 for k in ks if under.data[k]) < PHANTOM_UNDER * len(ks):
            continue
        if sum(1 for k in ks if over.data[k]) > PHANTOM_OVER * len(ks):
            continue
        # under a roof the scan sees no ground: the ground around it
        xs, zs = [p[0] for p in ring], [p[1] for p in ring]
        c0, c1 = max(0, int(min(xs) - X0) - 3), min(nx - 1, int(max(xs) - X0) + 3)
        r0, r1 = max(0, int(min(zs) - Z0) - 3), min(nz - 1, int(max(zs) - Z0) + 3)
        gs = sorted(v for v in (ground[r * nx + c] for r in range(r0, r1 + 1)
                                for c in range(c0, c1 + 1)) if v == v and v > -1e8)
        if not gs:
            continue
        g = gs[len(gs) // 2]
        hs = sorted(top[k] - g if top[k] == top[k] and top[k] > -1e8 else 0.0 for k in ks)
        if hs[len(hs) // 2] < PHANTOM_H:
            out.add(wid)
    return out
