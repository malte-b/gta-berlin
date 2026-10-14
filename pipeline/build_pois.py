#!/usr/bin/env python3
"""Bake street names and points of interest into a local file.

Overpass is queried exactly once, at build time, and the result is projected
into game-world metres and written to web/public/data/pois.json. The running
game never talks to Overpass - it just reads that file - so playing the game
puts no load on the API at all.

    python3 pipeline/build_pois.py            # uses the cached response if present
    python3 pipeline/build_pois.py --refresh  # re-query Overpass

Data (c) OpenStreetMap contributors, ODbL.
"""
import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fetch                                                     # noqa: E402
from geo import utm33, utm33_inv                                 # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "public", "data")
CACHE = os.path.join(ROOT, "cache")
OVERPASS = "https://overpass-api.de/api/interpreter"

# Label a street roughly this often along its length, in metres.
LABEL_SPACING = 90.0

# No two labels for the same street may come closer than this. OSM splits a
# street into a separate way at every junction - Dudenstrasse is seven of them -
# and spacing labels within each way independently drops one near the start of
# each, so they pile up wherever two ways meet. Thinning happens once, across
# all the ways of a given name, after they are merged.
MIN_LABEL_GAP = 120.0

# category -> (matching tags, display group)
# The "refresh" group mirrors what the Berliner Erfrischungskarte surfaces:
# benches, drinking fountains, toilets, shade and water to cool off at.
CATEGORIES = [
    ("refresh", {
        "amenity": {"drinking_water", "bench", "toilets", "fountain",
                    "water_point", "shelter"},
        "leisure": {"swimming_area"},
        "natural": {"spring"},
    }),
    ("food", {
        "amenity": {"cafe", "restaurant", "bar", "pub", "fast_food",
                    "ice_cream", "biergarten"},
    }),
    ("shop", {
        "shop": None,          # any value
    }),
    ("culture", {
        "tourism": {"museum", "gallery", "artwork", "attraction", "viewpoint"},
        "amenity": {"theatre", "cinema", "library", "arts_centre",
                    "place_of_worship", "community_centre"},
        "historic": None,
    }),
    ("transit", {
        "railway": {"station", "subway_entrance", "tram_stop", "halt"},
        "highway": {"bus_stop"},
        "amenity": {"bicycle_rental", "charging_station"},
    }),
    ("green", {
        "leisure": {"park", "playground", "garden", "pitch", "dog_park"},
    }),
]

STREET_TYPES = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "residential",
    "unclassified", "living_street", "pedestrian", "footway", "cycleway",
    "service", "path",
}
MAJOR = {"motorway", "trunk", "primary", "secondary", "tertiary"}


def log(m):
    print(m, flush=True)


def build_query(bbox):
    s, w, n, e = bbox
    bb = "%.6f,%.6f,%.6f,%.6f" % (s, w, n, e)
    return """[out:json][timeout:180];
(
  way["highway"]["name"](%s);
  node["amenity"](%s);
  node["shop"](%s);
  node["tourism"](%s);
  node["historic"](%s);
  node["railway"](%s);
  node["highway"="bus_stop"](%s);
  node["leisure"](%s);
  way["leisure"](%s);
  way["amenity"](%s);
  way["tourism"](%s);
);
out center tags geom;
""" % ((bb,) * 11)


def classify(tags):
    for name, rules in CATEGORIES:
        for key, values in rules.items():
            v = tags.get(key)
            if v is None:
                continue
            if values is None or v in values:
                return name
    return None


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true",
                    help="re-query Overpass instead of using the cached response")
    args = ap.parse_args()

    manifest = json.load(open(os.path.join(OUT, "world.json")))
    origin = manifest["origin"]
    world = manifest["world"]

    def to_world(lon, lat):
        e, n = utm33(lon, lat)
        return (e - origin["e"], -(n - origin["n"]))

    def in_world(x, z, margin=40.0):
        return (world[0] - margin <= x <= world[3] + margin
                and world[2] - margin <= z <= world[5] + margin)

    corners = [(world[0], world[2]), (world[3], world[2]),
               (world[0], world[5]), (world[3], world[5])]
    lls = [utm33_inv(x + origin["e"], -z + origin["n"]) for x, z in corners]
    lons = [a for a, _ in lls]
    lats = [b for _, b in lls]
    bbox = (min(lats), min(lons), max(lats), max(lons))
    log("Coverage bbox %.5f,%.5f .. %.5f,%.5f" % bbox)

    os.makedirs(CACHE, exist_ok=True)
    cache_path = os.path.join(CACHE, "pois_overpass.json")
    if args.refresh or not os.path.exists(cache_path):
        log("Querying Overpass once ...")
        raw = fetch.get(OVERPASS, timeout=300, retries=2, post=build_query(bbox))
        with open(cache_path, "wb") as fh:
            fh.write(raw)
        data = json.loads(raw)
    else:
        log("Using cached Overpass response (--refresh to re-query)")
        data = json.load(open(cache_path))
    elements = data.get("elements", [])
    log("  %d elements" % len(elements))

    # --- street name labels --------------------------------------------------
    merged = {}
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {})
        name = tags.get("name")
        hw = tags.get("highway")
        if not name or hw not in STREET_TYPES:
            continue
        geom = el.get("geometry")
        if not geom or len(geom) < 2:
            continue
        pts = [to_world(g["lon"], g["lat"]) for g in geom]

        # walk the polyline and drop a label every LABEL_SPACING metres, with
        # the local bearing so it can be painted along the road
        acc = LABEL_SPACING * 0.5
        placed = []
        for i in range(len(pts) - 1):
            ax, az = pts[i]
            bx, bz = pts[i + 1]
            seg = math.hypot(bx - ax, bz - az)
            if seg < 1e-6:
                continue
            t = acc
            while t < seg:
                f = t / seg
                px, pz = ax + (bx - ax) * f, az + (bz - az) * f
                if in_world(px, pz, 0):
                    placed.append({
                        "x": round(px, 1), "z": round(pz, 1),
                        "a": round(math.atan2(bx - ax, bz - az), 3),
                    })
                t += LABEL_SPACING
            acc = max(0.0, acc - seg) if acc > seg else (LABEL_SPACING - (seg - acc) % LABEL_SPACING)
        if placed:
            merged.setdefault(name, {"major": False, "at": []})
            merged[name]["major"] |= hw in MAJOR
            merged[name]["at"].extend(placed)

    # Thin each street's labels so they never crowd each other. Greedy from one
    # end: keep a position, then skip everything within MIN_LABEL_GAP of any
    # position already kept.
    streets = []
    dropped = 0
    for name, info in merged.items():
        spots = sorted(info["at"], key=lambda p: (p["x"], p["z"]))
        kept = []
        for sp in spots:
            if any((sp["x"] - k["x"]) ** 2 + (sp["z"] - k["z"]) ** 2
                   < MIN_LABEL_GAP ** 2 for k in kept):
                dropped += 1
                continue
            kept.append(sp)
        streets.append({"name": name, "major": info["major"], "at": kept})
    log("  merged %d way fragments into %d named streets, dropped %d crowded labels"
        % (sum(len(v["at"]) for v in merged.values()), len(streets), dropped))

    # --- points of interest ---------------------------------------------------
    pois = []
    seen = set()
    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name")
        cat = classify(tags)
        if not cat:
            continue
        if el.get("type") == "node":
            lon, lat = el.get("lon"), el.get("lat")
        else:
            c = el.get("center")
            if not c:
                continue
            lon, lat = c["lon"], c["lat"]
        if lon is None:
            continue
        x, z = to_world(lon, lat)
        if not in_world(x, z):
            continue
        # unnamed street furniture is still worth showing, named by its kind
        label = name or {
            "bench": "Bank", "drinking_water": "Trinkbrunnen",
            "toilets": "Toilette", "fountain": "Brunnen",
            "bus_stop": "Bushaltestelle", "subway_entrance": "U-Bahn",
            "bicycle_rental": "Leihrad", "playground": "Spielplatz",
        }.get(tags.get("amenity") or tags.get("highway")
              or tags.get("railway") or tags.get("leisure"))
        if not label:
            continue
        key = (round(x, 1), round(z, 1), label)
        if key in seen:
            continue
        seen.add(key)
        pois.append({
            "x": round(x, 1), "z": round(z, 1),
            "n": label, "c": cat,
            "k": tags.get("amenity") or tags.get("shop") or tags.get("tourism")
                 or tags.get("leisure") or tags.get("railway") or "",
        })

    by_cat = {}
    for p in pois:
        by_cat[p["c"]] = by_cat.get(p["c"], 0) + 1
    log("  %d named streets (%d label positions)"
        % (len(streets), sum(len(s["at"]) for s in streets)))
    log("  %d points of interest: %s"
        % (len(pois), ", ".join("%s %d" % kv for kv in sorted(by_cat.items()))))

    out = {
        "streets": streets,
        "pois": pois,
        "categories": [c for c, _ in CATEGORIES],
        "attribution": "(c) OpenStreetMap contributors, ODbL",
    }
    path = os.path.join(OUT, "pois.json")
    with open(path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    log("Wrote pois.json (%.0f KB)" % (os.path.getsize(path) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
