"""Street furniture from Berlin's street survey, modelled by OSM2World.

Sources:
  Strassenbefahrung 2014, WFS                                -- dl-de/zero-2.0
  https://gdi.berlin.de/services/wfs/strassenbefahrung
  Oeffentliche Beleuchtung (street lighting), WFS            -- dl-de/zero-2.0
  https://gdi.berlin.de/services/wfs/beleuchtung
  benches from OpenStreetMap                                  -- ODbL

In 2014/15 survey vehicles drove every public street in Berlin and mapped
what stands in it: traffic signs, bollards, hydrants, bins, benches, bus
shelters, bike stands. Each object is a surveyed 2D point, line or outline
with a type, so the data says *where* things are and *what* they are, not
what they look like.

The look comes from OSM2World, which already builds the buildings. It models
street furniture procedurally from OSM tags - including German traffic signs
from its own sign catalogue - so every kind is described as a tagged OSM node,
OSM2World models one prototype of each, and the game draws a copy of the
prototype at every surveyed position. Nothing is modelled by hand, and the
furniture shares the buildings' materials and style.

  * Prototypes are modelled facing north (direction=0) around their own
    origin, standing on y = 0.
  * Traffic signs face oncoming traffic: along the nearest carriageway edge,
    towards the vehicles that pass them on their right (right-hand traffic).
  * Benches, bus shelters and bike stands are turned to their surveyed
    outline's long axis; benches and shelters open towards the road.
  * Street name signs (437) carry no name in the survey. The name is that of
    the nearest named streets in OpenStreetMap - the mast's own street first -
    painted into an SVG per street and handed to OSM2World as an extra sign
    type. They hang above the other signs, parallel to their street and
    readable from both sides, the way Berlin's are.
  * Street lamps come from the lighting register, one OSM2World street lamp
    per light point; OSM benches fill in the many the survey does not have.
  * Bus shelters are a flat roof over a glass back and side walls, which is
    roughly what OSM2World can model of one, plus the stop's pole.
  * Underground hydrants and retractable bollards are left out - flush with
    the pavement, there is nothing to see. So are signs fixed to house walls,
    and sign codes OSM2World has no texture for.

Output:
    props.glb   the prototypes, plain glTF 2.0; each object's extras.kind
                names the kind it belongs to
    props.bin   "BPR1" (little endian):
                    u32 count
                    f32[count] x, f32[count] z, f32[count] y   world metres, y = ground (+ lift)
                    f32[count] yaw       radians about +y, applied to the prototype
                    u16[count] kind      index into the manifest's kind list
"""
import hashlib
import json
import math
import os
import random
import re
import struct

import fetch
import osm3d
from geo import ORIGIN_E, ORIGIN_N, utm33, utm33_inv

WFS = "https://gdi.berlin.de/services/wfs/strassenbefahrung"
LIGHTS_WFS = "https://gdi.berlin.de/services/wfs/beleuchtung"
PAGE = 5000

# Point layers: (kind, OSM tags, which way it faces, keep(properties))
POINTS = {
    "av_poller": ("bollard", {"barrier": "bollard"}, "random",
                  lambda p: p.get("pot") != "3"),             # 3 = retractable
    "aq_hydrant": ("hydrant", {"emergency": "fire_hydrant",
                               "fire_hydrant:type": "pillar"}, "random",
                   lambda p: p.get("hdt") == "1"),             # 1 = above ground
    "ah_abfallbehaelter_muellbox": ("waste_basket", {"amenity": "waste_basket"},
                                    "random", None),
    "ag_werbesaeule": ("advertising_column", {"advertising": "column"}, "random", None),
    # OSM2World only models post boxes and phones it knows an operator for
    "ak_briefkasten": ("post_box", {"amenity": "post_box", "operator": "Deutsche Post"},
                       "away", None),
    "ba_telefonzelle_telefonstele": ("telephone", {"amenity": "telephone",
                                                   "operator": "Deutsche Telekom"},
                                     "away", None),
    "ay_streugutbehaelter": ("grit_bin", {"amenity": "grit_bin"}, "away", None),
    "am_fahnenmast": ("flagpole", {"man_made": "flagpole"}, "random", None),
}
# Line and outline layers, placed at their centre along their long axis
SHAPES = {
    "bj_sitzbank": ("bench", {"amenity": "bench"}, "road"),
    "br_fahrgastunterstand": ("bus_shelter", None, "road"),
    "bq_fahrradstaender": ("bicycle_stands", {"amenity": "bicycle_parking",
                                              "bicycle_parking": "stands"}, "axis"),
    "bu_recycling_container": ("recycling", {"amenity": "recycling",
                                             "recycling_type": "container"}, "away"),
}
SIGNS = "aa_verkehrszeichen"
ROADWAY = "cm_fahrbahn"
LAYERS = [SIGNS, ROADWAY] + list(POINTS) + list(SHAPES)
LIGHTS = "beleuchtung"
BENCHES = "osm_benches"

# A bus shelter in the prototype's own frame (metres; x east, z south, front
# open to the north): roof, glass back and side walls, and the stop's pole.
SHELTER = [
    ("way", [(-1.8, -0.75), (1.8, -0.75), (1.8, 0.75), (-1.8, 0.75), (-1.8, -0.75)],
     {"building": "roof", "height": "2.6", "roof:shape": "flat",
      "building:colour": "#5a6068", "roof:colour": "#5a6068"}),
    ("way", [(-1.7, -0.55), (-1.7, 0.6), (1.7, 0.6), (1.7, -0.55)],
     {"barrier": "wall", "height": "2.3", "material": "glass"}),
    ("node", (2.2, -0.9), {"highway": "bus_stop"}),
]
# roads whose names go on street name signs
NAMED_ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified",
               "residential", "living_street", "pedestrian", "service", "road",
               "primary_link", "secondary_link", "tertiary_link"}
NAME_REACH = 30.0       # metres from a mast to the streets it can name
NAME_CODE = 100         # first private sign number: DE:437-100, 437-101, ...

# signs whose second number is text on the sign (a speed, a weight), not a
# variant with its own picture: 274-30 is OSM's DE:274[30]
SUBTYPE_TEXT = re.compile(r"%\{traffic_sign\.subtype\}")

SPACING = 30.0          # metres between prototypes in the OSM2World run
LOD = 3                 # below 3 OSM2World leaves most small furniture out


def _wfs(service, layer, e0, n0, e1, n1):
    feats, start = [], 0
    while True:
        url = ("%s?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=%s"
               "&OUTPUTFORMAT=application/json&SRSNAME=EPSG:25833"
               "&BBOX=%d,%d,%d,%d,urn:ogc:def:crs:EPSG::25833"
               "&COUNT=%d&STARTINDEX=%d"
               % (service, layer, e0, n0, e1, n1, PAGE, start))
        got = json.loads(fetch.get(url, timeout=300, retries=3)).get("features", [])
        feats += got
        if len(got) < PAGE:
            return feats
        start += PAGE


def _osm_benches(e0, n0, e1, n1):
    lls = [utm33_inv(e, n) for e in (e0, e1) for n in (n0, n1)]
    q = ('[out:json][timeout:120];node["amenity"="bench"](%.6f,%.6f,%.6f,%.6f);out;'
         % (min(p[1] for p in lls), min(p[0] for p in lls),
            max(p[1] for p in lls), max(p[0] for p in lls)))
    els = json.loads(fetch.get(osm3d.OVERPASS, timeout=180, retries=2, post=q))["elements"]
    return [{"lat": el["lat"], "lon": el["lon"], "tags": el.get("tags", {})} for el in els]


def load(e0, n0, e1, n1, cache_dir, refresh=False):
    """{layer: [features]} for every source used, in the box. A cache written
    before a source was added is topped up rather than refetched."""
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, "furniture_%d_%d_%d_%d.json" % (e0, n0, e1, n1))
    out = {} if refresh or not os.path.exists(path) else json.load(open(path))
    sources = {layer: (lambda l=layer: _wfs(WFS, "strassenbefahrung:" + l, e0, n0, e1, n1))
               for layer in LAYERS}
    sources[LIGHTS] = lambda: _wfs(LIGHTS_WFS, "beleuchtung:beleuchtung", e0, n0, e1, n1)
    sources[BENCHES] = lambda: _osm_benches(e0, n0, e1, n1)
    missing = [k for k in sources if k not in out]
    for k in missing:
        out[k] = sources[k]()
    if missing:
        with open(path, "w") as fh:
            json.dump(out, fh)
    return out


# --------------------------------------------------------------------------
# geometry
def _rings(geom):
    """Every coordinate list in a geometry, as lists of (E, N)."""
    t, c = geom.get("type"), geom.get("coordinates")
    if t == "Point":
        return [[tuple(c[:2])]]
    if t == "MultiPoint":
        return [[tuple(p[:2])] for p in c]
    if t in ("LineString",):
        return [[tuple(p[:2]) for p in c]]
    if t in ("MultiLineString", "Polygon"):
        return [[tuple(p[:2]) for p in r] for r in c]
    if t == "MultiPolygon":
        return [[tuple(p[:2]) for p in r] for poly in c for r in poly]
    return []


def _centre_axis(geom):
    """Centre (E, N) and the direction of the longest edge, as a unit vector."""
    pts = [p for r in _rings(geom) for p in r]
    if not pts:
        return None, None
    ce = sum(p[0] for p in pts) / len(pts)
    cn = sum(p[1] for p in pts) / len(pts)
    best, axis = 0.0, (1.0, 0.0)
    for r in _rings(geom):
        for a, b in zip(r, r[1:]):
            de, dn = b[0] - a[0], b[1] - a[1]
            ln = math.hypot(de, dn)
            if ln > best:
                best, axis = ln, (de / ln, dn / ln)
    return (ce, cn), axis


class Kerbs:
    """Carriageway outline segments, bucketed for nearest-edge lookups."""

    CELL = 20.0

    def __init__(self, feats):
        self.buckets = {}
        for f in feats:
            for r in _rings(f.get("geometry") or {}):
                for a, b in zip(r, r[1:]):
                    for key in self._keys(a, b):
                        self.buckets.setdefault(key, []).append((a, b))

    def _keys(self, a, b):
        c0, c1 = sorted((int(a[0] // self.CELL), int(b[0] // self.CELL)))
        r0, r1 = sorted((int(a[1] // self.CELL), int(b[1] // self.CELL)))
        return [(c, r) for c in range(c0, c1 + 1) for r in range(r0, r1 + 1)]

    def nearest(self, e, n, reach=2):
        """(point on the nearest edge, unit tangent) or (None, None)."""
        c0, r0 = int(e // self.CELL), int(n // self.CELL)
        best = (1e18, None, None)
        for c in range(c0 - reach, c0 + reach + 1):
            for r in range(r0 - reach, r0 + reach + 1):
                for a, b in self.buckets.get((c, r), ()):
                    de, dn = b[0] - a[0], b[1] - a[1]
                    l2 = de * de + dn * dn
                    if l2 < 1e-6:
                        continue
                    t = max(0.0, min(1.0, ((e - a[0]) * de + (n - a[1]) * dn) / l2))
                    q = (a[0] + t * de, a[1] + t * dn)
                    d = (q[0] - e) ** 2 + (q[1] - n) ** 2
                    if d < best[0]:
                        ln = math.sqrt(l2)
                        best = (d, q, (de / ln, dn / ln))
        return best[1], best[2]


class Streets:
    """Named streets from OpenStreetMap, for street name signs."""

    def __init__(self, osm):
        self.segs = []                  # (name, a, b) in E/N
        for el in (osm or {}).get("elements", []):
            t = el.get("tags", {})
            if el.get("type") != "way" or t.get("highway") not in NAMED_ROADS or not t.get("name"):
                continue
            pts = [utm33(g["lon"], g["lat"]) for g in el.get("geometry", []) if g]
            self.segs += [(t["name"], a, b) for a, b in zip(pts, pts[1:])]

    def near(self, e, n, reach=NAME_REACH):
        """[(distance, name, unit tangent)], nearest first, one per name."""
        best = {}
        for name, a, b in self.segs:
            de, dn = b[0] - a[0], b[1] - a[1]
            l2 = de * de + dn * dn
            if l2 < 1e-6:
                continue
            t = max(0.0, min(1.0, ((e - a[0]) * de + (n - a[1]) * dn) / l2))
            d = math.hypot(a[0] + t * de - e, a[1] + t * dn - n)
            if d <= reach and (name not in best or d < best[name][0]):
                ln = math.sqrt(l2)
                best[name] = (d, name, (de / ln, dn / ln))
        return sorted(best.values())


def _yaw(fx, fz):
    """Rotation about +y that turns a north-facing prototype to face (fx, fz)."""
    return math.atan2(-fx, -fz)


# --------------------------------------------------------------------------
# traffic signs
def sign_catalogue(jar):
    """{code: has subtype text} for every German sign OSM2World can draw."""
    path = os.path.join(os.path.dirname(jar), "locales", "DE-trafficSigns.properties")
    cat = {}
    for line in open(path, encoding="utf-8", errors="replace"):
        m = re.match(r"material_SIGN_DE_([0-9][0-9A-Za-z_.]*)_texture(\d)_(\w+)\s*=\s*(.*)", line)
        if not m:
            continue
        code = m.group(1)
        cat.setdefault(code, False)
        if m.group(3) == "text" and SUBTYPE_TEXT.search(m.group(4)):
            cat[code] = True
    return cat


def sign_value(raw, cat):
    """'283-20, 1000-02, 437' -> 'DE:283-20' (codes OSM2World can draw)."""
    out = []
    for c in (raw or "").split(","):
        c = c.strip()
        if not c:
            continue
        base, _, sub = c.partition("-")
        if c.replace("-", "_") in cat:
            out.append(c)
        elif sub and cat.get(base):
            out.append("%s[%s]" % (base, sub))
        elif not sub and base in cat:
            out.append(base)
    return ("DE:" + ",".join(out)) if out else None


# --------------------------------------------------------------------------
def _node(t):
    """A prototype that is a single tagged node."""
    return [("node", (0.0, 0.0), t)]


def place(data, streets, jar, to_world, ground, inside, seed=1):
    """Instances [(kind key, x, z, y, yaw)], the OSM elements that make up
    each kind's prototype, and counts of what was skipped and why."""
    rnd = random.Random(seed)
    kerbs = Kerbs(data.get(ROADWAY, []))
    streets = Streets(streets)
    protos, items = {}, []
    skipped = {}

    def skip(why):
        skipped[why] = skipped.get(why, 0) + 1

    def add(kind, t, e, n, yaw, lift=0.0):
        x, z = to_world(e, n)
        if not inside(x, z):
            return
        protos.setdefault(kind, _node(t) if isinstance(t, dict) else t)
        items.append((kind, x, z, ground(x, z) + lift, yaw))

    def facing(e, n, mode, yaw=None):
        """Yaw for a point item: random, or its front towards / away from the road."""
        if mode in ("road", "away"):
            q, _t = kerbs.nearest(e, n)
            if q is not None and (q[0] - e or q[1] - n):
                fe, fn = q[0] - e, q[1] - n
                if mode == "away":
                    fe, fn = -fe, -fn
                return _yaw(fe, -fn)
        return yaw if yaw is not None else rnd.uniform(0, 2 * math.pi)

    for layer, (kind, t, mode, keep) in POINTS.items():
        for f in data.get(layer, []):
            p = f.get("properties") or {}
            if keep and not keep(p):
                skip(kind + " (flush with the ground)")
                continue
            for r in _rings(f.get("geometry") or {}):
                e, n = r[0]
                add(kind, t, e, n, facing(e, n, mode))

    for layer, (kind, t, mode) in SHAPES.items():
        for f in data.get(layer, []):
            c, axis = _centre_axis(f.get("geometry") or {})
            if c is None:
                continue
            k, proto = kind, SHELTER if kind == "bus_shelter" else _node(t)
            if kind == "bicycle_stands":
                cap = int(_num((f.get("properties") or {}).get("frs_anzahl")) or 4)
                cap = min(max(cap, 2), 10)
                k = "%s:%d" % (kind, cap)
                proto = _node(dict(t, capacity=str(cap)))
            # the prototype's long axis is matched to the outline's in build();
            # here only the outline's own axis and which side is the road
            ae, an = axis
            q, _t = kerbs.nearest(*c)
            road = (q[0] - c[0], q[1] - c[1]) if q is not None else None
            if mode == "away" and road:
                road = (-road[0], -road[1])
            items.append(("@" + k, c, (ae, an), road if mode != "axis" else None))
            protos.setdefault(k, proto)

    # OSM benches, where the survey has none within a few metres
    surveyed = [it[1] for it in items if it[0] == "@bench"]
    for b in data.get(BENCHES, []):
        e, n = utm33(b["lon"], b["lat"])
        if any(math.hypot(e - se, n - sn) < 3.0 for se, sn in surveyed):
            skip("OSM bench already surveyed")
            continue
        d = _compass(b["tags"].get("direction"))
        if d is None:
            yaw = facing(e, n, "road")
        else:                           # the way a sitter looks, clockwise from north
            yaw = _yaw(math.sin(math.radians(d)), -math.cos(math.radians(d)))
        add("bench", {"amenity": "bench"}, e, n, yaw)

    # street lamps from the lighting register
    for f in data.get(LIGHTS, []):
        p = f.get("properties") or {}
        if "Schaltkasten" in (p.get("leuchtentyp") or ""):
            continue                    # a switch cabinet, not a lamp
        for r in _rings(f.get("geometry") or {}):
            e, n = r[0]
            add("street_lamp", {"highway": "street_lamp"}, e, n, rnd.uniform(0, 2 * math.pi))

    cat = sign_catalogue(jar)
    for f in data.get(SIGNS, []):
        p = f.get("properties") or {}
        if p.get("auf") == "Hauswand":
            skip("sign on a house wall")
            continue
        codes = [c.strip() for c in (p.get("vkz_zeiche") or "").split(",")]
        n_names = sum(1 for c in codes if c.split("-")[0] == "437")
        v = sign_value(p.get("vkz_zeiche"), cat)
        e, n = (f.get("geometry") or {}).get("coordinates", [0, 0])[:2]
        if n_names:
            near = streets.near(e, n)
            own = [s for s in near if s[1] == p.get("strasse")]
            chosen = (own + [s for s in near if s not in own])[:n_names]
            if len(chosen) < n_names:
                skip("street name sign without a named street nearby")
            for level, (_d, name, (te, tn)) in enumerate(chosen):
                # parallel to the street, one plate facing each way; each
                # moved 2 cm out so the turned-round one clears the pole. A
                # corner's second street hangs above the first, as in Berlin;
                # the raised copy's pole hides inside the one below.
                for sgn in (1, -1):
                    add("name:" + name, None, e + 0.02 * sgn * tn, n - 0.02 * sgn * te,
                        _yaw(sgn * tn, sgn * te), lift=0.26 * level)
        if not v:
            if not n_names:
                skip("sign without a catalogue texture")
            continue
        q, tan = kerbs.nearest(e, n)
        if q is None:
            yaw = rnd.uniform(0, 2 * math.pi)
        else:
            # traffic t passes with the sign on its right: right(t) . (sign - road) > 0
            # (east/north frame: right of (te, tn) is (tn, -te))
            te, tn = tan
            if tn * (e - q[0]) - te * (n - q[1]) < 0:
                te, tn = -te, -tn
            yaw = _yaw(-te, tn)                 # face against it; north -> -z
        add("sign:" + v[3:], {"traffic_sign": v}, e, n, yaw)

    # street names get a sign type each; the element is filled in by build()
    for k in protos:
        if k.startswith("name:") and protos[k] is None:
            protos[k] = []
    return items, protos, skipped


def _compass(v):
    """OSM direction value -> degrees clockwise from north, or None."""
    pts = {"N": 0, "NNE": 22.5, "NE": 45, "ENE": 67.5, "E": 90, "ESE": 112.5,
           "SE": 135, "SSE": 157.5, "S": 180, "SSW": 202.5, "SW": 225,
           "WSW": 247.5, "W": 270, "WNW": 292.5, "NW": 315, "NNW": 337.5}
    if not v:
        return None
    v = str(v).strip().upper()
    if v in pts:
        return pts[v]
    try:
        return float(v.split(";")[0].split("-")[0])
    except ValueError:
        return None


def _name_svg(name):
    """A Berlin street name sign: black name on white, black border."""
    w = max(0.7, min(1.4, 0.22 + 0.055 * len(name)))
    px = int(w / 0.22 * 220)
    fit = (' textLength="%d" lengthAdjust="spacingAndGlyphs"' % (px - 90)) if len(name) > 9 else ""
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="220" viewBox="0 0 %d 220">'
           '<rect width="%d" height="220" rx="14" fill="#fff"/>'
           '<rect x="14" y="14" width="%d" height="192" rx="8" fill="none" stroke="#111" stroke-width="10"/>'
           '<text x="%d" y="148" font-family="DIN 1451 Mittelschrift, DIN Alternate, Arial Narrow, '
           'Helvetica, sans-serif" font-size="120" text-anchor="middle" fill="#111"%s>%s</text></svg>'
           % (px, px, px, px - 28, px // 2, fit, _xml(name)))
    return svg, w


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# --------------------------------------------------------------------------
def build(data, streets, java, jar, work_dir, to_world, ground, inside, out_dir):
    """Model the prototypes, place the instances, write props.glb/.bin.
    streets: raw Overpass JSON with named highway ways (groundcover.load)."""
    items, protos, skipped = place(data, streets, jar, to_world, ground, inside)
    kinds = sorted(protos)
    os.makedirs(work_dir, exist_ok=True)

    # street name signs: one SVG and one sign type per street
    sign_dir = os.path.join(work_dir, "name_signs")
    os.makedirs(sign_dir, exist_ok=True)
    cfg = []
    names = [k for k in kinds if k.startswith("name:")]
    for i, k in enumerate(names):
        svg, w = _name_svg(k[5:])
        f = os.path.join(sign_dir, "437-%d.svg" % (NAME_CODE + i))
        if not os.path.exists(f) or open(f, encoding="utf-8").read() != svg:
            with open(f, "w", encoding="utf-8") as fh:
                fh.write(svg)
        m = "SIGN_DE_437_%d" % (NAME_CODE + i)
        cfg += ["material_%s_transparency = BINARY" % m,
                "material_%s_texture0_file = %s" % (m, f),
                "material_%s_texture0_width = %.2f" % (m, w),
                "material_%s_texture0_height = 0.22" % m,
                # above the other signs on the mast, as in Berlin
                "trafficSign_%s_defaultHeight = 3.1" % m]
        protos[k] = _node({"traffic_sign": "DE:437-%d" % (NAME_CODE + i)})
    cfg_path = os.path.join(work_dir, "name_signs.properties")
    cfg_text = "\n".join(cfg) + "\n"

    # one OSM2World run, prototypes laid out on a grid facing north
    osm_path = os.path.join(work_dir, "furniture_prototypes.osm")
    glb_path = os.path.join(work_dir, "furniture_prototypes_lod%d.glb" % LOD)
    cols = int(math.ceil(math.sqrt(len(kinds)))) or 1
    e0, n0 = ORIGIN_E, ORIGIN_N
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6">']
    lls = [utm33_inv(e0 + dx, n0 + dz) for dx in (-SPACING, cols * SPACING)
           for dz in (SPACING, -cols * SPACING)]
    lines.append('<bounds minlat="%.7f" minlon="%.7f" maxlat="%.7f" maxlon="%.7f"/>'
                 % (min(p[1] for p in lls), min(p[0] for p in lls),
                    max(p[1] for p in lls), max(p[0] for p in lls)))
    # element ids are (kind index + 1) * 1000 + j, so every OSM2World object
    # can be traced back to its kind
    ways = []
    for i, k in enumerate(kinds):
        ce, cn = e0 + (i % cols) * SPACING, n0 - (i // cols) * SPACING
        nid = (i + 1) * 1000

        def node_at(x, z, t=None):
            nonlocal nid
            nid += 1
            lon, lat = utm33_inv(ce + x, cn - z)
            lines.append('<node id="%d" version="1" lat="%.8f" lon="%.8f">' % (nid, lat, lon))
            for kk, vv in sorted((t or {}).items()):
                lines.append('  <tag k="%s" v="%s"/>' % (_xml(kk), _xml(vv)))
            lines.append('</node>')
            return nid

        for kind_el, geom, t in protos[k]:
            if kind_el == "node":
                node_at(geom[0], geom[1], dict(t, direction="0"))
            else:
                # a ring closes on its own first node, or it is just a line
                closed = len(geom) > 2 and geom[0] == geom[-1]
                refs = [node_at(x, z) for x, z in (geom[:-1] if closed else geom)]
                refs += refs[:1] if closed else []
                nid += 1
                ways.append((nid, refs, t))
    for wid, refs, t in ways:
        lines.append('<way id="%d" version="1">' % wid)
        lines += ['  <nd ref="%d"/>' % r for r in refs]
        lines += ['  <tag k="%s" v="%s"/>' % (_xml(kk), _xml(vv)) for kk, vv in sorted(t.items())]
        lines.append('</way>')
    lines.append('</osm>')
    # the sign config is part of the input: a change to it must rerun OSM2World
    text = "\n".join(lines) + "\n<!-- %s -->\n" % hashlib.sha1(cfg_text.encode()).hexdigest()
    if not os.path.exists(cfg_path) or open(cfg_path, encoding="utf-8").read() != cfg_text:
        with open(cfg_path, "w", encoding="utf-8") as fh:
            fh.write(cfg_text)
    if not os.path.exists(osm_path) or open(osm_path, encoding="utf-8").read() != text:
        with open(osm_path, "w", encoding="utf-8") as fh:
            fh.write(text)
    osm3d.run_osm2world(osm_path, glb_path, java, jar, LOD, extra_configs=[cfg_path])

    proto, axes = _write_prototypes(glb_path, os.path.join(out_dir, "props.glb"), kinds)
    modelled = [k for k in kinds if k in proto]
    missing = [k for k in kinds if k not in proto]

    # resolve outline items now that the prototypes' own axes are known
    placed = []
    for it in items:
        if it[0].startswith("@"):
            k, (ce, cn), (ae, an), road = it[0][1:], it[1], it[2], it[3]
            if k not in proto:
                continue
            x, z = to_world(ce, cn)
            if not inside(x, z):
                continue
            # outline axis in world x/z (north is -z), turned onto the prototype's
            alpha = math.atan2(-an, ae)
            yaw = axes[k] - alpha
            if road is not None:
                fx, fz = -math.sin(yaw), -math.cos(yaw)     # the prototype's front
                if fx * road[0] + fz * -road[1] < 0:
                    yaw += math.pi
            placed.append((k, x, z, ground(x, z), yaw))
        elif it[0] in proto:
            placed.append(it)

    index = {k: i for i, k in enumerate(modelled)}
    n = len(placed)
    with open(os.path.join(out_dir, "props.bin"), "wb") as fh:
        fh.write(b"BPR1" + struct.pack("<I", n))
        for j in (1, 2, 3, 4):
            fh.write(struct.pack("<%df" % n, *[p[j] for p in placed]))
        fh.write(struct.pack("<%dH" % n, *[index[p[0]] for p in placed]))

    counts = {}
    for p in placed:
        group = p[0].split(":")[0]
        counts[group] = counts.get(group, 0) + 1
    return {"file": "props.bin", "models": "props.glb", "kinds": modelled,
            "count": n, "bytes": os.path.getsize(os.path.join(out_dir, "props.glb"))}, \
        counts, missing, skipped


def _xml(s):
    return (str(s).replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))


def _write_prototypes(glb_in, glb_out, kinds):
    """Recentre each OSM2World object on its own origin and name it by kind.

    Returns ({kind: True}, {kind: long-axis angle in x/z}). Positions are
    rewritten inside the binary chunk; materials and textures pass through."""
    raw = open(glb_in, "rb").read()
    jl, = struct.unpack_from("<I", raw, 12)
    g = json.loads(raw[20:20 + jl])
    bo = 20 + jl
    bl, = struct.unpack_from("<I", raw, bo)
    blob = bytearray(raw[bo + 8:bo + 8 + bl])

    def view(i):
        a = g["accessors"][i]
        bv = g["bufferViews"][a["bufferView"]]
        return a, bv.get("byteOffset", 0) + a.get("byteOffset", 0), bv.get("byteStride") or 12

    # a prototype can be several objects (a shelter: roof, walls and pole)
    groups = {}
    for ni, node, meshes in osm3d.objects_of(g):
        oid = node.get("extras", {}).get("osmId", "")
        if oid[:1] in ("n", "w") and oid[1:].isdigit():
            groups.setdefault(kinds[int(oid[1:]) // 1000 - 1], []).append((ni, node, meshes))

    proto, axes, keep, done = {}, {}, [], set()
    for k, objs in groups.items():
        acc = [p["attributes"]["POSITION"] for _ni, _node, meshes in objs
               for mi in meshes for p in g["meshes"][mi]["primitives"]]
        pts = []
        for i in acc:
            a, off, st = view(i)
            pts += [struct.unpack_from("<3f", blob, off + j * st) for j in range(a["count"])]
        if not pts:
            continue
        xs, zs = [p[0] for p in pts], [p[2] for p in pts]
        cx, cz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2
        y0 = min(p[1] for p in pts)
        for i in set(acc):
            if i in done:
                raise ValueError("a vertex buffer is shared between two prototypes")
            done.add(i)
            a, off, st = view(i)
            vals = []
            for j in range(a["count"]):
                x, y, z = struct.unpack_from("<3f", blob, off + j * st)
                vals.append((x - cx, y - y0, z - cz))
                struct.pack_into("<3f", blob, off + j * st, *vals[-1])
            a["min"] = [min(v[c] for v in vals) for c in range(3)]
            a["max"] = [max(v[c] for v in vals) for c in range(3)]
        for ni, node, _meshes in objs:
            node.setdefault("extras", {})["kind"] = k
            keep.append(ni)
        proto[k] = True
        axes[k] = 0.0 if max(xs) - min(xs) >= max(zs) - min(zs) else math.pi / 2
    for s in g["scenes"]:
        s["nodes"] = keep

    js = json.dumps(g, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    blob += b"\0" * (-len(blob) % 4)
    out = bytearray(b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + 8 + len(blob)))
    out += struct.pack("<I", len(js)) + b"JSON" + js
    out += struct.pack("<I", len(blob)) + b"BIN\0" + blob
    with open(glb_out, "wb") as fh:
        fh.write(out)
    return proto, axes
