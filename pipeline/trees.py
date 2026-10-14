"""Trees from the Berlin tree cadastre (Baumkataster).

Source: Baumbestand Berlin - Strassenbaeume and Anlagenbaeume, WFS
https://gdi.berlin.de/services/wfs/baumbestand  -- dl-de/zero-2.0

Every tree is a surveyed point with its genus, height (baumhoehe, m), crown
diameter (kronedurch, m) and trunk girth at 1 m (stammumfg, cm). Not every
record has all three - crown diameter in particular is often 0 - so missing
sizes are estimated from what is there:

  * height from girth, with a saturating height-diameter curve
    h = 1.3 + d^2 / (1.5 + 0.2 d)^2   (d = trunk diameter in cm),
    which gives ~9 m for a young 10 cm street tree and levels off in the low
    20s for old ones, matching the cadastre's own distribution;
  * crown from height, with a per-genus width-to-height ratio - a plane tree
    spreads, a birch or a pear stays narrow.

Output "BTR1" (little endian):
    u32 count
    f32[count] x, f32[count] z, f32[count] y      world metres, y = ground
    u16[count] height_cm, u16[count] crown_cm, u16[count] trunk_mm (diameter)
    u8[count] form        0 broadleaf, 1 conifer, 2 columnar
    u8[count] genus       index into GENERA, for colour variation
"""
import json
import math
import os
import struct

import fetch

WFS = "https://gdi.berlin.de/services/wfs/baumbestand"
LAYERS = ("baumbestand:strassenbaeume", "baumbestand:anlagenbaeume")
PAGE = 5000

# crown diameter / height, for the genera that make up most of Berlin
CROWN_RATIO = {
    "platanus": 0.75, "quercus": 0.70, "aesculus": 0.70, "gleditsia": 0.70,
    "ulmus": 0.65, "prunus": 0.65, "acer": 0.62, "fraxinus": 0.60,
    "corylus": 0.60, "tilia": 0.55, "robinia": 0.55, "carpinus": 0.55,
    "populus": 0.50, "salix": 0.70, "betula": 0.45, "sorbus": 0.45,
    "pyrus": 0.40, "malus": 0.70, "crataegus": 0.70, "ailanthus": 0.60,
    "pinus": 0.40, "picea": 0.35, "abies": 0.35, "larix": 0.35,
    "taxus": 0.55, "thuja": 0.35,
}
CONIFERS = {"pinus", "picea", "abies", "larix", "taxus", "thuja", "pseudotsuga",
            "chamaecyparis", "juniperus", "metasequoia", "sequoiadendron"}
COLUMNAR = ("fastigiata", "italica", "columnare", "pyramidalis", "erecta")
GENERA = ["other", "tilia", "acer", "quercus", "platanus", "aesculus", "robinia",
          "betula", "fraxinus", "carpinus", "populus", "prunus", "pinus",
          "sorbus", "pyrus", "ulmus", "salix", "gleditsia", "corylus", "malus"]


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return f if f > 0 and f == f else 0.0


def load(e0, n0, e1, n1, cache_dir, refresh=False):
    """All cadastre trees in the box, both layers, as GeoJSON features."""
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, "trees_%d_%d_%d_%d.json" % (e0, n0, e1, n1))
    if not refresh and os.path.exists(path):
        return json.load(open(path))
    feats = []
    for layer in LAYERS:
        start = 0
        while True:
            url = ("%s?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=%s"
                   "&OUTPUTFORMAT=application/json&SRSNAME=EPSG:25833"
                   "&BBOX=%d,%d,%d,%d,urn:ogc:def:crs:EPSG::25833"
                   "&COUNT=%d&STARTINDEX=%d&SORTBY=gisid"
                   % (WFS, layer, e0, n0, e1, n1, PAGE, start))
            page = json.loads(fetch.get(url, timeout=300, retries=3))
            got = page.get("features", [])
            for f in got:
                f["properties"]["_layer"] = layer.split(":")[1]
            feats += got
            if len(got) < PAGE:
                break
            start += PAGE
    with open(path, "w") as fh:
        json.dump(feats, fh)
    return feats


def size(props):
    """(height m, crown diameter m, trunk diameter m, form, genus index)."""
    genus = (props.get("gattung") or "").strip().lower()
    species = (props.get("art_bot") or "").lower()
    girth_cm = _num(props.get("stammumfg"))
    d_cm = girth_cm / math.pi
    h = _num(props.get("baumhoehe"))
    if not h:
        h = 1.3 + d_cm * d_cm / (1.5 + 0.2 * d_cm) ** 2 if d_cm else 10.0
    h = min(max(h, 2.0), 45.0)
    crown = _num(props.get("kronedurch"))
    if not crown:
        crown = h * CROWN_RATIO.get(genus, 0.58)
    crown = min(max(crown, 1.2), 28.0)
    if not d_cm:
        d_cm = max(6.0, h * 2.2)             # ~ 2.2 cm per metre of height
    conifer = genus in CONIFERS or "nadel" in (props.get("art_gruppe") or "").lower()
    form = 1 if conifer else (2 if any(k in species for k in COLUMNAR) else 0)
    if form == 2:
        crown = min(crown, h * 0.32)
    gi = GENERA.index(genus) if genus in GENERA else 0
    return h, crown, d_cm / 100.0, form, gi


def build(feats, to_world, ground, inside, out_path):
    """to_world(e, n) -> (x, z); ground(x, z) -> y; inside(x, z) -> bool."""
    xs, zs, ys, hs, cs, ts, fs, gs = [], [], [], [], [], [], [], []
    estimated = 0
    seen = set()
    for f in feats:
        geom = f.get("geometry") or {}
        if geom.get("type") != "Point":
            continue
        e, n = geom["coordinates"][:2]
        x, z = to_world(e, n)
        key = (round(x, 1), round(z, 1))
        if key in seen or not inside(x, z):
            continue
        seen.add(key)
        p = f["properties"]
        if not _num(p.get("kronedurch")) or not _num(p.get("baumhoehe")):
            estimated += 1
        h, crown, trunk, form, gi = size(p)
        xs.append(x); zs.append(z); ys.append(ground(x, z))
        hs.append(int(h * 100)); cs.append(int(crown * 100)); ts.append(int(trunk * 1000))
        fs.append(form); gs.append(gi)
    n = len(xs)
    with open(out_path, "wb") as fh:
        fh.write(b"BTR1" + struct.pack("<I", n))
        for arr in (xs, zs, ys):
            fh.write(struct.pack("<%df" % n, *arr))
        for arr in (hs, cs, ts):
            fh.write(struct.pack("<%dH" % n, *[min(v, 65535) for v in arr]))
        fh.write(bytes(fs) + bytes(gs))
    trees = list(zip(xs, zs, [h / 100 for h in hs], [c / 100 for c in cs],
                     [t / 1000 for t in ts]))
    return {"file": os.path.basename(out_path), "count": n,
            "estimated": estimated}, trees
