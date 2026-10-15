#!/usr/bin/env python3
"""Bake point datasets from Berlin's geodata services into the game.

Every layer in pipeline/layers.json is one WFS feature type - most of the
city's open datasets are published that way on gdi.berlin.de - fetched for
all of Berlin, projected into world metres and written as a small file:

    web/public/data/layers/index.json     which layers there are
    web/public/data/layers/<id>.json      [x, z, label, detail] per point

The files are city-wide and small (tens of KB), so they are committed and
work with the single-area build and with all of Berlin alike. Points stand
where the data says; non-point features (a monument's outline, a park) are
placed at their centre. The licence is read from the service's own
capabilities document rather than typed in by hand.

    python3 pipeline/build_layers.py              # cached responses if present
    python3 pipeline/build_layers.py --refresh    # fetch again

To add a dataset, find its WFS on daten.berlin.de (the "WFS" resource of a
dataset), look up the feature type with ?SERVICE=WFS&REQUEST=GetCapabilities
and the property names with one GetFeature, and add an entry to layers.json.
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fetch                                                     # noqa: E402
from geo import ORIGIN_E, ORIGIN_N                               # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "web", "public", "data", "layers")
CACHE = os.path.join(ROOT, "cache", "layers")
PAGE = 5000


def log(m):
    print(m, flush=True)


def features(layer, refresh):
    """Every feature of the layer as GeoJSON in EPSG:25833, cached."""
    path = os.path.join(CACHE, layer["id"] + ".json")
    if not refresh and os.path.exists(path):
        return json.load(open(path))
    feats, start = [], 0
    while True:
        url = ("%s?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=%s"
               "&OUTPUTFORMAT=application/json&SRSNAME=EPSG:25833"
               "&COUNT=%d&STARTINDEX=%d" % (layer["wfs"], layer["type"], PAGE, start))
        got = json.loads(fetch.get(url, timeout=300, retries=3)).get("features", [])
        feats += got
        if len(got) < PAGE:
            break
        start += PAGE
    os.makedirs(CACHE, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(feats, fh)
    return feats


def licence(layer):
    """Title and licence text from the service's capabilities."""
    xml = fetch.get(layer["wfs"] + "?SERVICE=WFS&REQUEST=GetCapabilities",
                    timeout=120).decode("utf-8", "replace")

    def first(tag):
        m = re.search(r"<ows:%s>([^<]*)" % tag, xml)
        return m.group(1).strip() if m else ""
    fees = first("Fees")
    lic = re.search(r"(Datenlizenz Deutschland[^.]*?Version \d\.\d|dl-de/[\w-]+)", fees)
    return first("Title"), (lic.group(1) if lic else fees[:120])


def point(geom):
    """Easting/northing of a feature: the point itself, or the centre of
    the coordinates of a line or polygon (its largest part)."""
    if not geom:
        return None
    t, c = geom.get("type"), geom.get("coordinates")
    if t == "Point":
        return c[:2]
    if t == "MultiPoint":
        return c[0][:2] if c else None
    if t == "LineString":
        pts = c
    elif t == "MultiLineString":
        pts = max(c, key=len) if c else []
    elif t == "Polygon":
        pts = c[0] if c else []
    elif t == "MultiPolygon":
        pts = max((p[0] for p in c if p), key=len) if c else []
    else:
        return None
    if not pts:
        return None
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def text(props, keys):
    for k in keys:
        v = props.get(k)
        if v not in (None, ""):
            return " ".join(str(v).split())[:80]
    return ""


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="fetch every layer again")
    args = ap.parse_args()

    cfg = json.load(open(os.path.join(HERE, "layers.json")))
    os.makedirs(OUT, exist_ok=True)
    index = []
    for layer in cfg["layers"]:
        feats = features(layer, args.refresh)
        title, lic = licence(layer)
        pts = []
        for f in feats:
            p = point(f.get("geometry"))
            if not p:
                continue
            props = f.get("properties") or {}
            pts.append([round(p[0] - ORIGIN_E, 1), round(-(p[1] - ORIGIN_N), 1),
                        text(props, layer.get("label", [])) or layer["name"],
                        text(props, layer.get("detail", []))])
        with open(os.path.join(OUT, layer["id"] + ".json"), "w") as fh:
            json.dump({"points": pts}, fh, separators=(",", ":"), ensure_ascii=False)
        index.append({"id": layer["id"], "name": layer["name"], "colour": layer["colour"],
                      "file": "layers/%s.json" % layer["id"], "count": len(pts),
                      "attribution": "%s, Berlin (%s)" % (title or layer["name"], lic)})
        log("%-12s %5d points  %s" % (layer["id"], len(pts), index[-1]["attribution"]))
    with open(os.path.join(OUT, "index.json"), "w") as fh:
        json.dump({"layers": index}, fh, indent=1, ensure_ascii=False)
    log("Wrote %s" % os.path.relpath(os.path.join(OUT, "index.json"), ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
