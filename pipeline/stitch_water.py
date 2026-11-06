"""Weld small water-height disagreements at tile edges, preserving lock steps.

Only edge vertices move. Interior survey levels and original heights are kept,
so rivers retain their grade and this pass is repeatable after partial builds.
"""
import bisect
import json
import os
import sys

EPS = 0.002
TOLERANCE = 0.12


def _read(path):
    with open(path) as fh:
        return json.load(fh)


def _write(path, data, indent=None):
    with open(path + ".part", "w") as fh:
        json.dump(data, fh, indent=indent, separators=(",", ":") if indent is None else None)
    os.replace(path + ".part", path)


def stitch(build):
    wpath = os.path.join(build, "world.json")
    world = _read(wpath)
    records = {}
    for key, entry in world["tiles"].items():
        folder = os.path.join(build, entry["dir"])
        manifest = _read(os.path.join(folder, "tile.json"))
        if not manifest.get("water"):
            continue
        path = os.path.join(folder, manifest["water"]["file"])
        data = _read(path)
        mesh = data.get("mesh")
        if not mesh or not mesh["i"]:
            continue
        base = mesh.get("rawY") or [p[2] for p in mesh["v"]]
        x0, _, z0, x1, _, z1 = manifest["world"]
        edges = {}
        for axis, boundary, label in ((0, x0, "w"), (0, x1, "e"), (1, z0, "n"), (1, z1, "s")):
            intervals = set()
            for i in range(0, len(mesh["i"]), 3):
                triangle = mesh["i"][i:i + 3]
                for a, b in zip(triangle, triangle[1:] + triangle[:1]):
                    pa, pb = mesh["v"][a], mesh["v"][b]
                    if abs(pa[axis] - boundary) > EPS or abs(pb[axis] - boundary) > EPS:
                        continue
                    va, vb = pa[1 - axis], pb[1 - axis]
                    ya, yb = base[a], base[b]
                    if vb < va:
                        va, vb, ya, yb = vb, va, yb, ya
                    if vb - va > EPS:
                        intervals.add((va, vb, ya, yb))
            intervals = sorted(intervals)
            edges[label] = ([p[0] for p in intervals], intervals)
        records[key] = {"data": data, "base": base, "bounds": (x0, z0, x1, z1), "edges": edges,
                        "manifest": manifest, "folder": folder, "path": path}

    def levels_at(record, x, z):
        x0, z0, x1, z1 = record["bounds"]
        for coordinate, edge, label, along in ((x, x0, "w", z), (x, x1, "e", z), (z, z0, "n", x), (z, z1, "s", x)):
            if abs(coordinate - edge) > EPS:
                continue
            starts, intervals = record["edges"][label]
            last = bisect.bisect_right(starts, along + EPS)
            for a, b, ya, yb in intervals[max(0, last - 4):last]:
                if a - EPS <= along <= b + EPS:
                    t = min(1, max(0, (along - a) / (b - a)))
                    yield round(ya + (yb - ya) * t, 5)

    cache = {}
    changed = 0
    for key, record in records.items():
        e, n = map(int, key.split("_"))
        neighbours = [(k, records[k]) for ee in range(e - 1, e + 2) for nn in range(n - 1, n + 2)
                      for k in [f"{ee}_{nn}"] if k in records]
        mesh = record["data"]["mesh"]
        x0, z0, x1, z1 = record["bounds"]
        dirty = False
        for i, p in enumerate(mesh["v"]):
            x, z = p[:2]
            y = record["base"][i]
            if min(abs(x - x0), abs(x - x1), abs(z - z0), abs(z - z1)) <= EPS:
                point = (x, z)
                if point not in cache:
                    samples = sorted({(k, v) for k, neighbour in neighbours for v in levels_at(neighbour, x, z)}, key=lambda q: q[1])
                    groups = []
                    for sample in samples:
                        if not groups or sample[1] - groups[-1][0][1] > TOLERANCE:
                            groups.append([])
                        groups[-1].append(sample)
                    cache[point] = groups
                for group in cache[point]:
                    if any(k == key and abs(v - y) < EPS for k, v in group) and len({k for k, _ in group}) > 1:
                        y = round(sum(v for _, v in group) / len(group), 4)
                        break
            if abs(p[2] - y) > 0.00001:
                p[2] = y
                dirty = True
        if dirty:
            mesh["rawY"] = record["base"]
            _write(record["path"], record["data"])
            record["manifest"]["water"]["bytes"] = os.path.getsize(record["path"])
            tpath = os.path.join(record["folder"], "tile.json")
            _write(tpath, record["manifest"], 1)
            world["tiles"][key]["v"] = format(os.stat(tpath).st_mtime_ns, "x")
            changed += 1
    if changed:
        _write(wpath, world, 1)
    return changed


if __name__ == "__main__":
    print("Water seams welded in %d tiles" % stitch(sys.argv[1] if len(sys.argv) > 1 else "data/berlin"))
