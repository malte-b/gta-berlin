"""One measured level per connected water reach, split at mapped controls.

Local 48 m samples confused bridge/quay returns with water and invented metre-
high steps in the Spree. This fits reaches over the whole cached Berlin scan.
OSM weirs/lock gates separate levels; robust surface modes reject bank returns.
"""
import json
import math
import os
from collections import Counter

import numpy as np
from shapely import LineString, Point, Polygon, box, contains_xy, make_valid, unary_union

import als
import groundcover
import osmlocal
from bridge_surfaces import polygons
from geo import ORIGIN_E, ORIGIN_N
from raster import cells
from shorelines import water_polygons

VERSION = 2
STEP = 4
BIN = 0.05
# samples (one per STEP x STEP metres) a reach needs to be measured as a
# whole: on a small basin the dominant band can be its paved edges, not the
# water (Potsdamer Platz). Smaller ones keep water.py's per-block levels.
MIN_SAMPLES = 400
_loaded = {}


def rings(poly):
    return [list(poly.exterior.coords)[:-1]] + [list(r.coords)[:-1] for r in poly.interiors]


def extend(line, distance=5):
    points = list(line.coords)
    a, b = points[0], points[1]
    length = math.hypot(a[0] - b[0], a[1] - b[1]) or 1
    points[0] = (a[0] + (a[0] - b[0]) / length * distance, a[1] + (a[1] - b[1]) / length * distance)
    a, b = points[-1], points[-2]
    length = math.hypot(a[0] - b[0], a[1] - b[1]) or 1
    points[-1] = (a[0] + (a[0] - b[0]) / length * distance, a[1] + (a[1] - b[1]) / length * distance)
    return LineString(points)


def measured_level(histogram):
    """The dominant narrow return band, not the lowest bank/bed sample."""
    if sum(histogram.values()) < MIN_SAMPLES:
        return None
    peak = max(histogram, key=lambda b: sum(histogram.get(b + d, 0) for d in (-1, 0, 1)))
    band = sorted((b, n) for b, n in histogram.items() if abs(b - peak) <= 2)
    total = sum(n for _, n in band)
    seen = 0
    for b, n in band:
        seen += n
        if seen >= total / 2:
            return round(b * BIN, 2)
    return None


def prepare(cache_root, refresh=False):
    path = os.path.join(cache_root, "hydrography.json")
    pbf = os.path.join(cache_root, "osm", "berlin-latest.osm.pbf")
    if not os.path.exists(pbf):
        pbf = osmlocal.download(os.path.join(cache_root, "osm"))
    stamp = os.stat(pbf).st_mtime_ns
    if not refresh and os.path.exists(path):
        with open(path) as fh:
            old = json.load(fh)
        if old.get("version") == VERSION and old.get("source") == stamp:
            return path
    print("Water reaches from OSM and the full Berlin laser scan ...", flush=True)
    idx = osmlocal.OsmIndex(pbf)
    elements, excluded, controls, waterways = [], [], [], []
    for wid, (tags, refs) in idx.ways.items():
        geometry = idx._geom(refs)
        if tags.get("natural") == "water" or tags.get("waterway") == "riverbank":
            elements.append({"type": "way", "id": wid, "tags": tags, "geometry": geometry})
        points = None
        if tags.get("waterway") in ("river", "canal", "stream", "weir", "lock_gate") or tags.get("man_made") == "bridge" or tags.get("bridge") not in (None, "no"):
            points = groundcover._pts(geometry)
        if not points or len(points) < 2:
            continue
        if tags.get("waterway") in ("river", "canal", "stream"):
            waterways.append(LineString(points))
        if tags.get("waterway") in ("weir", "lock_gate"):
            controls.append({"id": wid, "kind": tags["waterway"], "line": extend(LineString(points))})
        if tags.get("man_made") == "bridge" and len(points) >= 4:
            excluded.extend(polygons(make_valid(Polygon(points))))
        elif tags.get("bridge") not in (None, "no"):
            width = groundcover.ROAD_WIDTH.get(tags.get("highway"), 4.2)
            excluded.append(LineString(points).buffer(width / 2 + 1, cap_style="flat"))
    for rid, (tags, members) in idx.rels.items():
        if tags.get("natural") == "water":
            elements.append({"type": "relation", "id": rid, "tags": tags, "members": [idx._member(m) for m in members]})
    for nid, tags in idx.node_tags.items():
        if tags.get("waterway") not in ("weir", "lock_gate"):
            continue
        x, z = groundcover._pts([{"lon": idx.nodes[nid][0], "lat": idx.nodes[nid][1]}])[0]
        point = Point(x, z)
        near = min(waterways, key=lambda line: line.distance(point), default=None)
        if near is None or near.distance(point) > 20:
            continue
        s = near.project(point)
        a, b = near.interpolate(max(0, s - 2)), near.interpolate(min(near.length, s + 2))
        length = math.hypot(b.x - a.x, b.y - a.y) or 1
        nx, nz = -(b.y - a.y) / length, (b.x - a.x) / length
        controls.append({"id": nid, "kind": tags["waterway"], "line": LineString([(x - nx * 70, z - nz * 70), (x + nx * 70, z + nz * 70)])})
    survey = als.index(os.path.join(cache_root, "als"))
    keys = [tuple(map(int, key.split("_"))) for key in survey]
    bounds = (min(e for e, _ in keys) * 1000 - ORIGIN_E, ORIGIN_N - (max(n for _, n in keys) + 1) * 1000,
              (max(e for e, _ in keys) + 1) * 1000 - ORIGIN_E, ORIGIN_N - min(n for _, n in keys) * 1000)
    water = water_polygons({"elements": elements}, bounds)
    cuts = unary_union([c["line"].buffer(0.25, cap_style="flat") for c in controls])
    reaches = [p for p in polygons(water.difference(cuts)) if p.area >= 4]
    bridge_mask = unary_union(excluded)
    sampling, histograms, boxes = [], [], []
    for reach in reaches:
        sample = reach.buffer(-4)
        if sample.is_empty:
            sample = reach.buffer(-0.5)
        if sample.is_empty:
            sample = reach
        sample = sample.difference(bridge_mask)
        sampling.append(sample)
        boxes.append(sample.bounds if not sample.is_empty else (0, 0, 0, 0))
        histograms.append(Counter())
    for e, n in keys:
        x0, z0 = e * 1000 - ORIGIN_E, ORIGIN_N - (n + 1) * 1000
        candidates = [i for i, (a, b, c, d) in enumerate(boxes) if a < x0 + 1000 and c > x0 and b < z0 + 1000 and d > z0]
        if not candidates:
            continue
        filename = als._cache_path(os.path.join(cache_root, "als"), "ground", f"{e}_{n}")
        if not os.path.exists(filename):
            continue
        raw = np.fromfile(filename, dtype="<f4").reshape(1000, 1000)[2::STEP, 2::STEP]
        for i in candidates:
            a, b, c, d = boxes[i]
            c0, c1 = max(0, math.floor((a - x0 - 2.5) / STEP)), min(raw.shape[1], math.ceil((c - x0 - 2.5) / STEP) + 1)
            r0, r1 = max(0, math.floor((b - z0 - 2.5) / STEP)), min(raw.shape[0], math.ceil((d - z0 - 2.5) / STEP) + 1)
            if c0 >= c1 or r0 >= r1:
                continue
            X, Z = np.meshgrid(x0 + 2.5 + np.arange(c0, c1) * STEP, z0 + 2.5 + np.arange(r0, r1) * STEP)
            values = raw[r0:r1, c0:c1]
            mask = contains_xy(sampling[i], X, Z) & np.isfinite(values) & (values > 0) & (values < 200)
            bins, counts = np.unique(np.rint(values[mask] / BIN).astype(np.int32), return_counts=True)
            histograms[i].update({int(b): int(count) for b, count in zip(bins, counts)})
    bodies = [{"r": rings(p), "y": measured_level(hist), "samples": sum(hist.values())} for p, hist in zip(reaches, histograms)]
    gate_data = []
    for control in controls:
        line = control["line"].intersection(water)
        parts = [line] if line.geom_type == "LineString" else list(getattr(line, "geoms", ()))
        for part in parts:
            if part.geom_type == "LineString" and part.length > 0.5:
                gate_data.append({"id": control["id"], "kind": control["kind"], "p": list(part.coords)})
    payload = {"version": VERSION, "source": stamp, "water": [rings(p) for p in polygons(water)], "bodies": bodies, "controls": gate_data}
    with open(path + ".part", "w") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    os.replace(path + ".part", path)
    print("  %d water reaches, %d measured; %d mapped controls" % (len(bodies), sum(b["y"] is not None for b in bodies), len(gate_data)), flush=True)
    return path


class Levels(list):
    def __init__(self, base, regions, exact, shape, controls):
        super().__init__(base)
        self.regions, self.exact, self.shape, self.controls = regions, exact, shape, controls


def apply(base, grid, cache_root):
    path = os.path.join(cache_root, "hydrography.json")
    if not os.path.exists(path):
        return base
    stamp = os.stat(path).st_mtime_ns
    if _loaded.get("stamp") != stamp:
        with open(path) as fh:
            data = json.load(fh)
        _loaded.clear()
        _loaded.update(stamp=stamp, data=data,
                       regions=[(Polygon(b["r"][0], b["r"][1:]), b["y"]) for b in data["bodies"]],
                       water=[Polygon(r[0], r[1:]) for r in data["water"]])
    X0, Z0, nx, nz = grid
    area = box(X0, Z0, X0 + nx, Z0 + nz)
    regions, exact = [], {}
    for shape, level in _loaded["regions"]:
        if level is None or not shape.intersects(area):
            continue
        clipped = shape.intersection(area)
        regions.append((clipped, level))
        # a little past the outline: shoreline points sample the cell they are in
        for poly in polygons(clipped.buffer(2)):
            for k in cells(rings(poly), X0, Z0, 1, nx, nz):
                exact[k] = min(level, exact.get(k, level))
    shape = unary_union([p.intersection(area) for p in _loaded["water"] if p.intersects(area)])
    controls = [c for c in _loaded["data"]["controls"] if LineString(c["p"]).intersects(area)]
    return Levels(base, regions, exact, shape, controls)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", default="cache")
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    prepare(args.cache, args.refresh)
