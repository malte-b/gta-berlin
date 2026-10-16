#!/usr/bin/env python3
"""Merge a tile's buildings.glb into one mesh per (chunk, material).

OSM2World writes one node per building and one mesh per material of it:
4,000-6,000 meshes and some 17,000 buffer views per tile. The game merged
them into a few hundred meshes on load - but three.js parses the file first,
all of it in one go, which was the longest stall when a tile came into full
detail (docs/performance.md). This does the merge once, here: the game then
parses a few hundred meshes and has nothing left to merge.

Merged meshes keep the chunk they belong to (node extras "chunk") and are
stored relative to the tile's north-west corner, which also keeps the
coordinates small for 32-bit floats. Materials, textures and images pass
through unchanged. The asset is marked {"extras": {"packed": {...}}} and
tile.json's "buildings" gets "packed": true, so the game knows.

    python3 pipeline/pack_buildings.py data/berlin              # every tile
    python3 pipeline/pack_buildings.py data/berlin --workers 6
    python3 pipeline/pack_buildings.py data/berlin --tiles 390_5816

Packing an already packed file does nothing. Standard library only.
"""
import argparse
import json
import multiprocessing as mp
import os
import struct
import sys
import time
from array import array

_CT = {5126: "f", 5121: "B", 5123: "H", 5125: "I"}
_NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(path):
    raw = open(path, "rb").read()
    jl, = struct.unpack_from("<I", raw, 12)
    g = json.loads(raw[20:20 + jl])
    bo = 20 + jl
    bl, = struct.unpack_from("<I", raw, bo)
    return g, raw[bo + 8:bo + 8 + bl]


def write_glb(path, g, blob):
    js = json.dumps(g, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    blob = bytes(blob) + b"\0" * (-len(blob) % 4)
    out = bytearray(b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + 8 + len(blob)))
    out += struct.pack("<I", len(js)) + b"JSON" + js
    out += struct.pack("<I", len(blob)) + b"BIN\0" + blob
    with open(path + ".part", "wb") as fh:
        fh.write(out)
    os.replace(path + ".part", path)
    return len(out)


def _accessor(g, blob, i):
    """An accessor's values as a flat array (tightly packed views only)."""
    a = g["accessors"][i]
    bv = g["bufferViews"][a["bufferView"]]
    n = _NC[a["type"]]
    width = array(_CT[a["componentType"]]).itemsize * n
    if bv.get("byteStride") not in (None, width):
        raise ValueError("strided accessor %d" % i)
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    out = array(_CT[a["componentType"]])
    out.frombytes(blob[off:off + a["count"] * width])
    if sys.byteorder != "little":
        out.byteswap()
    return out


def pack(path, x0, z0):
    """Merge path in place. Returns (meshes before, meshes after) or None if
    it was packed already."""
    g, blob = read_glb(path)
    if g.get("asset", {}).get("extras", {}).get("packed"):
        return None

    groups = {}
    for root in g["scenes"][0]["nodes"]:
        chunk = g["nodes"][root].get("extras", {}).get("chunk", "-")
        stack, meshes = [root], []
        while stack:
            n = g["nodes"][stack.pop()]
            if "mesh" in n:
                meshes.append(n["mesh"])
            stack += n.get("children", [])
        for mi in meshes:
            for p in g["meshes"][mi]["primitives"]:
                if p.get("mode", 4) != 4:
                    continue
                key = (chunk, p.get("material", -1))
                grp = groups.get(key)
                if grp is None:
                    grp = groups[key] = {"pos": array("f"), "nor": array("f"), "uv": array("f"),
                                         "idx": array("I"), "n": 0}
                at = p["attributes"]
                pos = _accessor(g, blob, at["POSITION"])
                count = len(pos) // 3
                # tile-relative: small numbers stay precise in 32-bit floats
                for k in range(0, len(pos), 3):
                    pos[k] -= x0
                    pos[k + 2] -= z0
                nor = _accessor(g, blob, at["NORMAL"]) if "NORMAL" in at else array("f", (0.0, 1.0, 0.0) * count)
                uv = _accessor(g, blob, at["TEXCOORD_0"]) if "TEXCOORD_0" in at else array("f", bytes(8 * count))
                idx = _accessor(g, blob, p["indices"]) if "indices" in p else range(count)
                base = grp["n"]
                grp["pos"].extend(pos)
                grp["nor"].extend(nor)
                grp["uv"].extend(uv)
                grp["idx"].extend(i + base for i in idx)
                grp["n"] += count
    before = len(g["meshes"])

    out = bytearray()
    views, accessors = [], []

    def add_view(data, target=None):
        out.extend(b"\0" * (-len(out) % 4))
        v = {"buffer": 0, "byteOffset": len(out), "byteLength": len(data)}
        if target:
            v["target"] = target
        views.append(v)
        out.extend(data)
        return len(views) - 1

    def add_accessor(arr, ctype, kind, count, target, bounds=False):
        a = {"bufferView": add_view(arr.tobytes(), target), "componentType": ctype,
             "count": count, "type": kind}
        if bounds:
            a["min"] = [min(arr[k::3]) for k in range(3)]
            a["max"] = [max(arr[k::3]) for k in range(3)]
        accessors.append(a)
        return len(accessors) - 1

    # images first, as they were
    images = []
    for im in g.get("images", []):
        im = dict(im)
        if "bufferView" in im:
            bv = g["bufferViews"][im["bufferView"]]
            off = bv.get("byteOffset", 0)
            im["bufferView"] = add_view(blob[off:off + bv["byteLength"]])
        images.append(im)

    meshes, nodes = [], []
    for (chunk, mat), grp in groups.items():
        n = grp["n"]
        if n == 0:
            continue
        idx = grp["idx"] if n > 65535 else array("H", grp["idx"])
        prim = {
            "attributes": {
                "POSITION": add_accessor(grp["pos"], 5126, "VEC3", n, 34962, bounds=True),
                "NORMAL": add_accessor(grp["nor"], 5126, "VEC3", n, 34962),
                "TEXCOORD_0": add_accessor(grp["uv"], 5126, "VEC2", n, 34962),
            },
            "indices": add_accessor(idx, 5125 if n > 65535 else 5123, "SCALAR", len(idx), 34963),
            "mode": 4,
        }
        if mat >= 0:
            prim["material"] = mat
        meshes.append({"primitives": [prim]})
        nodes.append({"name": "%s|%s" % (chunk, mat), "mesh": len(meshes) - 1,
                      "extras": {"chunk": chunk}})

    packed = {k: v for k, v in g.items()
              if k not in ("nodes", "meshes", "accessors", "bufferViews", "buffers", "scenes",
                           "scene", "images")}
    if images:
        packed["images"] = images
    packed["asset"] = dict(g.get("asset", {}))
    packed["asset"]["extras"] = dict(packed["asset"].get("extras", {}),
                                     packed={"origin": [x0, z0], "meshesBefore": before})
    packed.update({"nodes": nodes, "meshes": meshes, "accessors": accessors,
                   "bufferViews": views, "buffers": [{"byteLength": len(out) + (-len(out) % 4)}],
                   "scenes": [{"nodes": list(range(len(nodes)))}], "scene": 0})
    write_glb(path, packed, out)
    return before, len(meshes)


def pack_tile(tdir):
    """Pack one tile folder; tile.json learns that its buildings are packed."""
    tj = os.path.join(tdir, "tile.json")
    glb = os.path.join(tdir, "buildings.glb")
    if not (os.path.exists(tj) and os.path.exists(glb)):
        return os.path.basename(tdir), None, 0.0
    m = json.load(open(tj))
    if m.get("buildings", {}).get("packed"):
        return os.path.basename(tdir), None, 0.0
    t0 = time.time()
    # the tile's north-west corner, where the game puts the tile's group
    x0, z0 = m["world"][0], m["world"][2]
    res = pack(glb, x0, z0)
    if "buildings" in m:
        m["buildings"]["packed"] = True
        m["buildings"]["bytes"] = os.path.getsize(glb)
        with open(tj + ".part", "w") as fh:
            json.dump(m, fh, indent=1)
        os.replace(tj + ".part", tj)
    return os.path.basename(tdir), res, time.time() - t0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", help="a build folder: data/berlin, or one with tiles/ inside")
    ap.add_argument("--tiles", nargs="+", metavar="E_N")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    tdir = os.path.join(args.out, "tiles")
    keys = args.tiles or sorted(os.listdir(tdir))
    dirs = [os.path.join(tdir, k) for k in keys]
    t0 = time.time()
    done = before = after = 0
    with mp.Pool(args.workers) as pool:
        for key, res, secs in pool.imap_unordered(pack_tile, dirs):
            if res:
                done += 1
                before += res[0]
                after += res[1]
                if done % 50 == 0:
                    print("  %d packed (%.0f s)" % (done, time.time() - t0), flush=True)
    print("Packed %d tiles in %.0f s: %d meshes -> %d" % (done, time.time() - t0, before, after))
    if done:
        # tile.json changed: new versions in world.json, so browsers fetch anew
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import build_berlin
        build_berlin.OUT = os.path.abspath(args.out)
        print("world.json: %d tiles" % build_berlin.reindex())
    return 0


if __name__ == "__main__":
    sys.exit(main())
