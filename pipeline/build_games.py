#!/usr/bin/env python3
"""Bake the points the game modes are played on, from open data only.

    web/public/data/games/markets.json    Christmas markets (sleigh run)
    web/public/data/games/cool.json       fountains, splash pools, bathing spots,
                                          cool rooms (heat wave)
    web/public/data/games/toilets.json    public toilets (toilet emergency)
    web/public/data/games/doener.json     kebab shops (Döner marathon)
    web/public/data/games/giessen.json    young street trees and street pumps
                                          (Gieß den Kiez)

Sources:
  * Christmas markets: the Senate's yearly dataset as curated by ODIS for
    weihnachtsmaerkte.odis-berlin.de (github.com/technologiestiftung/
    weihnachtsmarktkarte), which adds exact coordinates (CC BY).
  * Drinking fountains, ornamental and splash fountains, cool rooms and
    bathing spots: gdi.berlin.de WFS (dl-de/zero-2.0; bathing spots CC BY 4.0).
    OSM amenity=drinking_water fills in fountains the city does not list.
  * Toilets: the toilet layer of build_layers.py (dl-de/zero-2.0).
  * Kebab shops and street pumps: OpenStreetMap (ODbL), read from the same
    Geofabrik extract the tiled build uses. Pumps are selected the way
    Gieß den Kiez does: man_made=water_well with a pump, minus those tagged
    broken or locked.
  * Young trees: the tree cadastre already cached by the world build
    (cache/trees, dl-de/zero-2.0). Gieß den Kiez's rule of thumb is that
    trees under 15 years need watering most; their age decides how thirsty
    a tree is in the game.

Every file is city-wide and in world metres, so it serves the single-area
build and all of Berlin alike.

    python3 pipeline/build_games.py              # cached downloads if present
    python3 pipeline/build_games.py --refresh    # fetch again
"""
import argparse
import csv
import glob
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fetch                                                     # noqa: E402
import osmlocal                                                  # noqa: E402
import osmpbf                                                    # noqa: E402
from geo import ORIGIN_E, ORIGIN_N, utm33                         # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "web", "public", "data", "games")
CACHE = os.path.join(ROOT, "cache", "games")

MARKETS = ("https://raw.githubusercontent.com/technologiestiftung/"
           "weihnachtsmarktkarte/main/public/markets_2025.csv")
WFS = "https://gdi.berlin.de/services/wfs/"
YOUNG = 15            # years; Gieß den Kiez's "young tree"


def log(m):
    print(m, flush=True)


def cached(name, url, refresh):
    path = os.path.join(CACHE, name)
    if refresh or not os.path.exists(path):
        os.makedirs(CACHE, exist_ok=True)
        data = fetch.get(url, timeout=300, retries=3)
        with open(path, "wb") as fh:
            fh.write(data)
    return open(path, "rb").read()


def wfs(service, typename, refresh):
    url = ("%s%s?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=%s"
           "&OUTPUTFORMAT=application/json&SRSNAME=EPSG:25833"
           % (WFS, service, typename))
    return json.loads(cached(service + ".json", url, refresh)).get("features", [])


def world(e, n):
    return round(e - ORIGIN_E, 1), round(-(n - ORIGIN_N), 1)


def lonlat(lon, lat):
    return world(*utm33(lon, lat))


def short(s, n=70):
    return " ".join(str(s or "").split())[:n]


def write(name, doc):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, name), "w") as fh:
        json.dump(doc, fh, separators=(",", ":"), ensure_ascii=False)


def dedupe(points, radius):
    """Drop points within radius of one kept earlier (sources overlap)."""
    kept, grid = [], {}
    for p in points:
        cx, cz = int(p[0] // radius), int(p[1] // radius)
        near = any(
            (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < radius * radius
            for dx in (-1, 0, 1) for dz in (-1, 0, 1)
            for q in grid.get((cx + dx, cz + dz), ()))
        if near:
            continue
        kept.append(p)
        grid.setdefault((cx, cz), []).append(p)
    return kept


# --- OpenStreetMap ----------------------------------------------------------

def is_kebab(t):
    cuisine = t.get("cuisine", "").lower()
    name = t.get("name", "").lower()
    return (t.get("amenity") in ("fast_food", "restaurant", "cafe")
            and ("kebab" in cuisine or "döner" in name or "doner" in name
                 or "döner" in cuisine or "kebab" in name))


def is_pump(t):
    status = t.get("pump:status", "").lower()
    return (t.get("man_made") == "water_well" and "pump" in t
            and t.get("pump") != "no" and status not in ("broken", "locked", "defect"))


def is_drinking(t):
    return (t.get("amenity") == "drinking_water"
            or (t.get("amenity") == "fountain" and t.get("drinking_water") == "yes"))


def osm(refresh):
    """Kebab shops, pumps and drinking water from the Berlin extract, as
    (lon, lat, tags). Ways (a shop mapped as a building) are placed at the
    mean of their nodes."""
    path = os.path.join(CACHE, "osm.json")
    if not refresh and os.path.exists(path):
        return json.load(open(path))
    pbf = osmlocal.download(os.path.join(ROOT, "cache", "osm"))
    want = lambda t: is_kebab(t) or is_pump(t) or is_drinking(t)     # noqa: E731
    ways, need = [], set()
    for _k, els in osmpbf.blocks(pbf, want={"way"}):
        for _wid, tags, refs in els:
            if want(tags):
                ways.append((tags, refs))
                need.update(refs)
    out, coords = [], {}
    for _k, els in osmpbf.blocks(pbf, want={"node"}):
        for nid, tags, ll in els:
            if nid in need:
                coords[nid] = ll
            if tags and want(tags):
                out.append([ll[0], ll[1], tags])
    for tags, refs in ways:
        pts = [coords[r] for r in refs if r in coords]
        if pts:
            out.append([sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), tags])
    os.makedirs(CACHE, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(out, fh, ensure_ascii=False)
    return out


# --- the modes --------------------------------------------------------------

def markets(refresh):
    rows = csv.DictReader(io.StringIO(cached("markets_2025.csv", MARKETS, refresh)
                                      .decode("utf-8-sig")))
    pts = []
    for r in rows:
        if r.get("ignore") == "1" or r.get("inaktiv") == "1":
            continue
        try:
            lat, lon = float(r["lat"]), float(r["lng"])
        except (KeyError, ValueError):
            continue
        dates = "%s – %s" % (r.get("von", ""), r.get("bis", "")) if r.get("von") else ""
        pts.append([*lonlat(lon, lat), short(r.get("shortname") or r.get("name"), 60),
                    short(dates or r.get("strasse"))])
    write("markets.json", {
        "attribution": "Weihnachtsmärkte 2025, SenWEB Berlin / ODIS (CC BY)",
        "points": pts})
    return len(pts)


def cool(refresh, osm_els):
    pts = []
    for f in wfs("badegewaesser", "badegewaesser:aa_badestellen", refresh):
        e, n = f["geometry"]["coordinates"][:2]
        p = f["properties"]
        pts.append([*world(e, n), short(p.get("badegewaes"), 50), "bathing spot", "swim"])
    for f in wfs("kuehle_raeume", "kuehle_raeume:kuehle_raeume", refresh):
        e, n = f["geometry"]["coordinates"][:2]
        p = f["properties"]
        pts.append([*world(e, n), short(p.get("kuehle_raeume"), 50),
                    short("cool room · " + (p.get("oeffnungszeiten") or "")), "indoor"])
    for f in wfs("zierbrunnen", "zierbrunnen:bez_zierbrunnen", refresh):
        e, n = f["geometry"]["coordinates"][:2]
        p = f["properties"]
        kind = (p.get("kategorie") or "fountain")
        pts.append([*world(e, n), short(p.get("standort"), 50), short(kind.lower()), "splash"])
    city = []
    for f in wfs("trinkwasserbrunnen", "trinkwasserbrunnen:trinkwasserbrunnen", refresh):
        e, n = f["geometry"]["coordinates"][:2]
        p = f["properties"]
        if "außer betrieb" in (p.get("einschraenkungen") or "").lower():
            continue
        city.append([*world(e, n), short(p.get("standort"), 50), "drinking fountain", "drink"])
    extra = [[*lonlat(lon, lat), short(t.get("name") or "Trinkwasser", 50),
              "drinking water (OSM)", "drink"]
             for lon, lat, t in osm_els if is_drinking(t)]
    pts += dedupe(city + extra, 15)
    write("cool.json", {
        "attribution": "Trinkwasserbrunnen, Zierbrunnen, Kühle Räume, Berlin (dl-de/zero-2.0) · "
                       "Badestellen, LAGeSo / Geoportal Berlin (CC BY 4.0) · "
                       "© OpenStreetMap (ODbL)",
        "points": pts})
    return len(pts)


def toilets():
    src = os.path.join(ROOT, "web", "public", "data", "layers", "toiletten.json")
    if not os.path.exists(src):
        raise SystemExit("run pipeline/build_layers.py first (it bakes the toilet layer)")
    pts = json.load(open(src))["points"]
    write("toilets.json", {
        "attribution": "Öffentliche Toiletten, Berlin (dl-de/zero-2.0)", "points": pts})
    return len(pts)


def doener(osm_els):
    pts = [[*lonlat(lon, lat), short(t.get("name") or "Döner", 50),
            short(t.get("addr:street", "") + " " + t.get("addr:housenumber", ""))]
           for lon, lat, t in osm_els if is_kebab(t)]
    pts = dedupe(pts, 6)
    write("doener.json", {
        "attribution": "© OpenStreetMap (ODbL)", "points": pts})
    return len(pts)


def giessen(osm_els):
    pumps = dedupe([[*lonlat(lon, lat), short(t.get("name") or "Straßenbrunnen", 40),
                     short(t.get("pump:style") or t.get("pump") or "")]
                    for lon, lat, t in osm_els if is_pump(t)], 4)
    # the cadastre cache is per km tile with a margin, so trees repeat
    seen, trees = set(), []
    for path in glob.glob(os.path.join(ROOT, "cache", "trees", "trees_*.json")):
        for f in json.load(open(path)):
            p = f.get("properties") or {}
            age = p.get("standalter")
            gid = p.get("gisid")
            if not isinstance(age, (int, float)) or age >= YOUNG or age < 0 or gid in seen:
                continue
            seen.add(gid)
            e, n = f["geometry"]["coordinates"][:2]
            x, z = world(e, n)
            trees += [x, z, int(age)]
    write("giessen.json", {
        "attribution": "Baumbestand Berlin (dl-de/zero-2.0) · © OpenStreetMap (ODbL)",
        "pumps": pumps, "trees": trees})
    return len(pumps), len(trees) // 3


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="download every source again")
    args = ap.parse_args()
    osm_els = osm(args.refresh)
    log("markets   %5d" % markets(args.refresh))
    log("cool      %5d" % cool(args.refresh, osm_els))
    log("toilets   %5d" % toilets())
    log("doener    %5d" % doener(osm_els))
    log("giessen   %5d pumps, %d young trees" % giessen(osm_els))
    log("Wrote %s" % os.path.relpath(OUT, ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
