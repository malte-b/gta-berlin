"""Streaming parser for Berlin's LoD2 CityGML tiles.

The files are CityGML 1.0. Each <bldg:Building> carries semantic boundary
surfaces (WallSurface / RoofSurface / GroundSurface), each of which holds one
or more gml:Polygon with an exterior LinearRing and optional interior rings.
Coordinates are EPSG:25833 easting/northing/height, in metres.

Parsing is done with iterparse so a 27 MB tile never fully materialises as a
tree.
"""
import xml.etree.ElementTree as ET

BLDG = "{http://www.opengis.net/citygml/building/1.0}"
GML = "{http://www.opengis.net/gml}"
GEN = "{http://www.opengis.net/citygml/generics/1.0}"

WALL, ROOF, GROUND = 0, 1, 2
_KIND = {
    BLDG + "WallSurface": WALL,
    BLDG + "RoofSurface": ROOF,
    BLDG + "GroundSurface": GROUND,
    BLDG + "ClosureSurface": WALL,
    BLDG + "OuterCeilingSurface": ROOF,
    BLDG + "OuterFloorSurface": GROUND,
}

# bldg:roofType codes from the AdV catalogue, kept for flavour in the game
ROOF_TYPES = {
    "1000": "flat", "2100": "monopitch", "2200": "dual_pitch",
    "3100": "gabled", "3200": "hipped", "3300": "half_hipped",
    "3400": "pyramidal", "5000": "mansard", "9999": "other",
}


def _poslist(ring_el):
    """gml:LinearRing -> [(e, n, h), ...]"""
    pl = ring_el.find(GML + "posList")
    if pl is None or not pl.text:
        return []
    v = pl.text.split()
    if len(v) < 9:
        return []
    return [(float(v[i]), float(v[i + 1]), float(v[i + 2]))
            for i in range(0, len(v) - 2, 3)]


def _polygons(surface_el):
    """Yield (exterior_ring, [interior_rings]) for every gml:Polygon below."""
    for poly in surface_el.iter(GML + "Polygon"):
        ext = None
        ints = []
        for child in poly:
            if child.tag == GML + "exterior":
                lr = child.find(GML + "LinearRing")
                if lr is not None:
                    ext = _poslist(lr)
            elif child.tag == GML + "interior":
                lr = child.find(GML + "LinearRing")
                if lr is not None:
                    r = _poslist(lr)
                    if r:
                        ints.append(r)
        if ext and len(ext) >= 4:
            yield ext, ints


def _text(el, tag):
    t = el.find(tag)
    return t.text.strip() if t is not None and t.text else None


def buildings(path):
    """Yield dicts describing each building in a CityGML tile.

    Keys: id, height, roof_type, function, surfaces -> [(kind, ext, ints)]
    BuildingParts are merged into their parent building, which is what we want
    for rendering (a courtyard block is one object in the game).
    """
    ctx = ET.iterparse(path, events=("end",))
    for _event, el in ctx:
        if el.tag != BLDG + "Building":
            continue
        surfaces = []
        for bb in el.iter(BLDG + "boundedBy"):
            for child in bb:
                kind = _KIND.get(child.tag)
                if kind is None:
                    continue
                for ext, ints in _polygons(child):
                    surfaces.append((kind, ext, ints))
        if surfaces:
            h = _text(el, BLDG + "measuredHeight")
            rt = _text(el, BLDG + "roofType")
            fn = _text(el, BLDG + "function")
            yield {
                "id": el.get(GML + "id"),
                "height": float(h) if h else None,
                "roof_type": ROOF_TYPES.get(rt, "other"),
                "function": fn,
                "surfaces": surfaces,
            }
        el.clear()
