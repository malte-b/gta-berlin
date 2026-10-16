"""Buildings from OpenStreetMap, modelled by OSM2World.

OSM2World (https://osm2world.org, LGPL) is the reference implementation of
the Simple 3D Buildings tagging scheme - the same tags OSM Buildings and F4
Map read: height / min_height, building:levels / building:min_level,
roof:shape / roof:height / roof:direction / roof:orientation, building:part
outlines replacing their parent, building:colour / roof:colour and
building:material. Rather than re-implement that interpretation, the pipeline
hands OSM2World the raw building data and post-processes its glTF output.

It runs with OSM2World's standard style, so buildings come out textured with
its bundled CC0 PBR materials: plaster, brick, concrete and roof tiles, and a
window layer laid out storey by storey from building:levels. Three things are
then done to that file, in place:

  * Reprojection. OSM2World works in its own local metric projection around
    the centre of the input. Its footprint vertices are matched back to the
    OSM nodes they came from and an affine transform to EPSG:25833 is fitted
    by least squares - which absorbs both its projection and UTM's meridian
    convergence (~1.3 degrees here) without having to know either exactly.

  * Placement. OSM2World is run without terrain, so every building stands on
    y = 0. Each one is lifted onto the laser-scan terrain at the *lowest*
    ground point under its footprint: on a slope the uphill side sinks a
    little into the hill, which is how real buildings sit, and nothing ever
    floats.

  * Colour. Tagged colours and materials are kept exactly as OSM2World
    resolved them. Untagged buildings all share one default plaster tint and
    one roof tint, which would turn the whole city one colour, so they are
    moved onto tinted copies of the same materials - a Berlin facade palette,
    picked per building.

Output is a single standard binary glTF in game-world metres (x east, y up,
-z north, origin at the Brandenburger Tor), one node per building carrying
its OSM id and chunk in `extras`. Any engine that reads glTF can load it.
"""
import json
import math
import os
import shutil
import struct
import subprocess
import xml.etree.ElementTree as ET
import zlib

import fetch
from geo import ORIGIN_E, ORIGIN_N, utm33

OVERPASS = "https://overpass-api.de/api/interpreter"

# OSM2World's untagged defaults, as linear RGB base colour factors
DEFAULT_WALL = (1.0, 0.7913, 0.2623)
DEFAULT_ROOF = (0.6038, 0.0, 0.0)

# Berlin: rendered Gruenderzeit facades in sand, grey, ochre and pale green,
# plus the off-white of post-war blocks. sRGB, multiplied onto the plaster
# texture, so they are on the light side.
FACADES = [(0.93, 0.88, 0.78), (0.82, 0.82, 0.80), (0.92, 0.80, 0.62),
           (0.80, 0.84, 0.76), (0.97, 0.95, 0.91), (0.88, 0.84, 0.76),
           (0.86, 0.74, 0.64), (0.90, 0.86, 0.70)]
# clay tiles in a few weathered shades, and slate grey
ROOFS = [(0.78, 0.42, 0.32), (0.66, 0.36, 0.28), (0.72, 0.50, 0.40),
         (0.46, 0.46, 0.48)]

OSM2WORLD_CONFIG = """\
createTerrain = false
useBuildingColors = true
useBillboards = false
renderUnderground = false
"""


def log(m):
    print(m, flush=True)


# --------------------------------------------------------------------------
# input
def load_osm(bbox_ll, cache_dir, refresh=False):
    """Every building and building part touching the box, with the full
    member ways and nodes OSM2World needs, as OSM XML. Returns the path."""
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, "buildings_%.5f_%.5f_%.5f_%.5f.osm" % bbox_ll)
    if not refresh and os.path.exists(path):
        # an Overpass error is an HTML page; a forest tile is a short OSM file
        with open(path, "rb") as fh:
            if b"<osm" in fh.read(400):
                return path
    bb = "%.6f,%.6f,%.6f,%.6f" % bbox_ll
    q = """[out:xml][timeout:300];
(
  way["building"](%(b)s);
  way["building:part"](%(b)s);
  rel["building"](%(b)s);
  rel["building:part"](%(b)s);
  rel["type"="building"](%(b)s);
);
(._;>;);
out meta;
""" % {"b": bb}
    data = fetch.get(OVERPASS, timeout=400, retries=2, post=q)
    with open(path, "wb") as fh:
        fh.write(data)
    return path


def parse_osm(path):
    """(nodes {id: (lon, lat)}, ways {id: (node ids, tags)},
    relations {id: (members [(type, ref, role)], tags)})."""
    nodes, ways, rels = {}, {}, {}
    for _ev, el in ET.iterparse(path):
        if el.tag == "node":
            nodes[int(el.get("id"))] = (float(el.get("lon")), float(el.get("lat")))
        elif el.tag == "way":
            ways[int(el.get("id"))] = (
                [int(n.get("ref")) for n in el.findall("nd")],
                {t.get("k"): t.get("v") for t in el.findall("tag")})
        elif el.tag == "relation":
            rels[int(el.get("id"))] = (
                [(m.get("type"), int(m.get("ref")), m.get("role") or "")
                 for m in el.findall("member")],
                {t.get("k"): t.get("v") for t in el.findall("tag")})
        if el.tag in ("node", "way", "relation"):
            el.clear()
    return nodes, ways, rels


# --------------------------------------------------------------------------
# OSM2World
def find_osm2world(explicit=None):
    """(java, jar). Looks at --osm2world, $OSM2WORLD, then tools/OSM2World."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cands = [explicit, os.environ.get("OSM2WORLD"),
             os.path.join(root, "tools", "OSM2World", "OSM2World.jar")]
    jar = next((c for c in cands if c and os.path.exists(c)), None)
    java = os.environ.get("JAVA") or shutil.which("java")
    for brew in ("/opt/homebrew/opt/openjdk/bin/java", "/usr/local/opt/openjdk/bin/java"):
        if os.path.exists(brew):
            java = brew          # /usr/bin/java on macOS is a stub without a JDK
            break
    return java, jar


def run_osm2world(osm_path, glb_path, java, jar, lod=2, extra_configs=(), texture_res=512):
    """texture_res: the largest texture edge OSM2World writes into the glb.
    Its own default is 512 px, a quarter of the 2K CC0 textures it ships."""
    if (os.path.exists(glb_path) and os.path.getsize(glb_path) > 0
            and os.path.getmtime(glb_path) >= os.path.getmtime(osm_path)):
        return
    cfg = glb_path + ".properties"
    with open(cfg, "w") as fh:
        fh.write(OSM2WORLD_CONFIG + "maxTextureResolution = %d\n" % texture_res)
    # Run from the jar's folder: the standard style names its textures by
    # relative path. It is passed as its own --config rather than included,
    # because an `include` inside another config resolves against the wrong
    # directory and OSM2World then silently ignores the whole file.
    style = os.path.join(os.path.dirname(jar), "standard.properties")
    # Some of the bundled sign SVGs (315-67) nest deeper than the JDK's
    # default XML depth limit of 100, and one unreadable texture aborts the run.
    p = subprocess.run([java, "-Xmx8g", "-Djdk.xml.maxElementDepth=0", "-jar", jar, "convert",
                        "-i", os.path.abspath(osm_path), "-o", os.path.abspath(glb_path),
                        "--config", style, "--config", os.path.abspath(cfg),
                        *[a for c in extra_configs for a in ("--config", os.path.abspath(c))],
                        "--lod", str(lod)],
                       cwd=os.path.dirname(jar), capture_output=True, text=True)
    errors = [l for l in (p.stdout + p.stderr).splitlines() if l.startswith("ERROR[")]
    if errors:
        # OSM2World skips individual broken objects (contradictory level tags,
        # degenerate roofs) and carries on; report rather than fail
        log("    OSM2World skipped parts of %d objects, e.g. %s"
            % (len(errors), errors[0][:110]))
    if p.returncode != 0 or not os.path.exists(glb_path):
        raise RuntimeError("OSM2World failed:\n" + (p.stderr or p.stdout)[-2000:])


def objects_of(g):
    """[(node index, node, [mesh indices])] for every OSM object in the scene.

    Untextured output puts an object's mesh on its own node; the textured
    style splits it into one child node per material instead. Either way an
    object is a named node with an osmId, and its geometry is every mesh at or
    below it."""
    out = []
    for ni, node in enumerate(g["nodes"]):
        if "osmId" not in node.get("extras", {}):
            continue
        meshes = []
        stack = [ni]
        while stack:
            n = g["nodes"][stack.pop()]
            if "mesh" in n:
                meshes.append(n["mesh"])
            stack += n.get("children", [])
        if meshes:
            out.append((ni, node, meshes))
    return out


_CT = {5126: ("f", 4), 5121: ("B", 1), 5123: ("H", 2), 5125: ("I", 4)}
_NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(path):
    """[(osm id, name, positions, normals, colours, triangles)] per node, plus
    the projection origin. Colours are linear RGB with the material's base
    colour already multiplied in."""
    raw = open(path, "rb").read()
    jl, = struct.unpack_from("<I", raw, 12)
    g = json.loads(raw[20:20 + jl])
    bo = 20 + jl
    bl, = struct.unpack_from("<I", raw, bo)
    blob = raw[bo + 8:bo + 8 + bl]

    def acc(i):
        a = g["accessors"][i]
        bv = g["bufferViews"][a["bufferView"]]
        ch, sz = _CT[a["componentType"]]
        nc = _NC[a["type"]]
        stride = bv.get("byteStride") or sz * nc
        off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        norm = a.get("normalized") and ch != "f"
        scale = 1.0 / ((1 << (8 * sz)) - 1) if norm else 1.0
        out = []
        st = struct.Struct("<" + ch * nc)
        for k in range(a["count"]):
            v = st.unpack_from(blob, off + k * stride)
            out.append(tuple(c * scale for c in v) if norm else v)
        return out

    origin = None
    for node in g["nodes"]:
        if "origin" in node.get("extras", {}):
            origin = node["extras"]["origin"]
            break
    out = []
    for _ni, node, meshes in objects_of(g):
        ex = node.get("extras", {})
        t = node.get("translation", (0.0, 0.0, 0.0))
        pos, nor, col, tris = [], [], [], []
        prims = [p for mi in meshes for p in g["meshes"][mi]["primitives"]]
        for prim in prims:
            if prim.get("mode", 4) != 4:
                continue
            at = prim["attributes"]
            p = acc(at["POSITION"])
            n = acc(at["NORMAL"]) if "NORMAL" in at else [(0.0, 1.0, 0.0)] * len(p)
            mat = g["materials"][prim["material"]] if "material" in prim else {}
            base = mat.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])
            c = acc(at["COLOR_0"]) if "COLOR_0" in at else [(1.0, 1.0, 1.0)] * len(p)
            idx = acc(prim["indices"]) if "indices" in prim else [(k,) for k in range(len(p))]
            k0 = len(pos)
            pos += [(v[0] + t[0], v[1] + t[1], v[2] + t[2]) for v in p]
            nor += n
            col += [(cc[0] * base[0], cc[1] * base[1], cc[2] * base[2]) for cc in c]
            flat = [i[0] for i in idx]
            tris += [(k0 + flat[j], k0 + flat[j + 1], k0 + flat[j + 2])
                     for j in range(0, len(flat) - 2, 3)]
        out.append((ex.get("osmId"), node.get("name", ""), pos, nor, col, tris))
    return out, origin


# --------------------------------------------------------------------------
# projection
def fit_projection(objects, origin, nodes):
    """Affine (x, z) -> (E, N) from OSM2World's local frame to UTM 33.

    A first guess (orthographic about the stated origin) is good to ~0.5 m,
    which is plenty to pair each footprint vertex with the OSM node it came
    from. The pairs then fix the real transform; outliers - vertices OSM2World
    moved, mostly where it cleans up self-touching outlines - are dropped and
    the fit repeated."""
    R = 6378137.0
    lat0 = math.radians(origin["lat"])
    lon0 = math.radians(origin["lon"])
    grid = {}
    for lon, lat in nodes.values():
        la, lo = math.radians(lat), math.radians(lon)
        x = R * math.cos(la) * math.sin(lo - lon0)
        y = R * (math.cos(lat0) * math.sin(la)
                 - math.sin(lat0) * math.cos(la) * math.cos(lo - lon0))
        e, n = utm33(lon, lat)
        grid.setdefault((int(x // 2), int(-y // 2)), []).append((x, -y, e, n))

    pairs = []
    seen = set()
    for _oid, _name, pos, _n, _c, _t in objects:
        for x, y, z in pos:
            if abs(y) > 1e-3:
                continue
            key = (round(x, 2), round(z, 2))
            if key in seen:
                continue
            seen.add(key)
            best = None
            bd = 1.0
            gx, gz = int(x // 2), int(z // 2)
            for dx in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for px, pz, e, n in grid.get((gx + dx, gz + dz), ()):
                        d = math.hypot(px - x, pz - z)
                        if d < bd:
                            bd, best = d, (e, n)
            if best:
                pairs.append((x, z, best[0], best[1]))
    # an affine fit needs three corners; tiles of forest or water may hold a
    # single small building, too few to also weed out outliers (below)
    if len(pairs) < 4:
        raise RuntimeError("could not match OSM2World output to OSM nodes")

    def solve(ps):
        out = []
        for col in (2, 3):
            # normal equations for y = a x + b z + c
            m = [[0.0] * 4 for _ in range(3)]
            for p in ps:
                r = (p[0], p[1], 1.0)
                for i in range(3):
                    for j in range(3):
                        m[i][j] += r[i] * r[j]
                    m[i][3] += r[i] * p[col]
            for c in range(3):
                piv = max(range(c, 3), key=lambda rr: abs(m[rr][c]))
                m[c], m[piv] = m[piv], m[c]
                for rr in range(3):
                    if rr != c:
                        f = m[rr][c] / m[c][c]
                        m[rr] = [a - f * b for a, b in zip(m[rr], m[c])]
            out.append([m[i][3] / m[i][i] for i in range(3)])
        return out

    def resid(ps, ce, cn):
        return [math.hypot(ce[0] * p[0] + ce[1] * p[1] + ce[2] - p[2],
                           cn[0] * p[0] + cn[1] * p[1] + cn[2] - p[3]) for p in ps]

    ce, cn = solve(pairs)
    keep = pairs
    for _ in range(3 if len(pairs) >= 10 else 0):
        r = resid(pairs, ce, cn)
        keep = [p for p, e in zip(pairs, r) if e < 0.15]
        if len(keep) < 10:
            break
        ce, cn = solve(keep)
    r = sorted(resid(keep, ce, cn))
    stats = {"pairs": len(keep), "of": len(pairs),
             "median": r[len(r) // 2], "p99": r[int(len(r) * 0.99)]}
    return (lambda x, z: (ce[0] * x + ce[1] * z + ce[2],
                          cn[0] * x + cn[1] * z + cn[2])), stats


# --------------------------------------------------------------------------
# output
def _linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _near(c, ref, tol=0.02):
    return len(c) >= 3 and all(abs(a - b) < tol for a, b in zip(c, ref))


def _seed(oid):
    return zlib.crc32((oid or "").encode())


# Footprints wider than this follow the terrain instead of sitting on one
# level - see placement() below.
DRAPE_SPAN = 150.0
DRAPE_RADIUS = 20.0


def placement(base_xz, height, in_area):
    """How to lift a building off OSM2World's y = 0 onto the terrain.

    Returns a function (x, z) -> lift in metres.

    An ordinary building gets one lift: the median of the ground at its
    outline's corners, so a corner in a hole cannot sink the whole house; on
    the low side the walls are extended down to the ground. Only outline points
    inside the built area count - beyond its edge the terrain is merely
    clamped, not measured.

    That rule fails for very large buildings. Tempelhof airport is 870 m
    long, its ground varies by ~10 m along the way, and a single pit in one
    courtyard put the whole building 11 m into the ground in front of its
    main entrance. Buildings that wide follow the ground instead: each vertex
    is lifted by the lower quartile of the terrain within 20 m of it. That
    level is robust to a ramp or lightwell beside a wall, and since a wall's
    top and bottom share x and z, walls stay vertical while the building as
    a whole follows the land.
    """
    # each corner appears once per triangle that touches it; count it once
    pts = list({(round(x, 1), round(z, 1)) for x, z in base_xz if in_area(x, z)}) \
        or list({(round(x, 1), round(z, 1)) for x, z in base_xz})
    xs = [p[0] for p in pts]
    zs = [p[1] for p in pts]
    span = max(max(xs) - min(xs), max(zs) - min(zs))
    if span <= DRAPE_SPAN:
        # The median of the corners, not the lowest one. The lowest put a
        # whole house metres into the ground whenever one corner stood over
        # a ramp, a light well or - common in Berlin - the edge of a terrain
        # step with a yard several metres down. The walls are extended down
        # to the ground afterwards (see relocate), so the low side gets a
        # taller wall rather than a gap.
        hs = sorted(height(x, z) for x, z in pts)
        lift = hs[len(hs) // 2]
        return lambda _x, _z: lift

    cache = {}
    step = 8.0
    r = DRAPE_RADIUS
    offsets = [(dx, dz) for dx in range(-int(r), int(r) + 1, 2)
               for dz in range(-int(r), int(r) + 1, 2) if dx * dx + dz * dz <= r * r]

    def node(i, j):
        if (i, j) not in cache:
            kx, kz = i * step, j * step
            hs = sorted(height(kx + dx, kz + dz) for dx, dz in offsets
                        if in_area(kx + dx, kz + dz)) or [height(kx, kz)]
            cache[(i, j)] = hs[len(hs) // 4]
        return cache[(i, j)]

    # Interpolated between grid nodes, not snapped to them: a snapped lift
    # jumps at cell borders, and a window whose corners straddle one comes
    # out sheared. Interpolated, it changes by centimetres across a window.
    def local(x, z):
        fx, fz = x / step, z / step
        i, j = math.floor(fx), math.floor(fz)
        tx, tz = fx - i, fz - j
        return ((node(i, j) * (1 - tx) + node(i + 1, j) * tx) * (1 - tz)
                + (node(i, j + 1) * (1 - tx) + node(i + 1, j + 1) * tx) * tz)
    return local


def relocate(glb_in, glb_out, to_utm, height, chunk_of, in_area):
    """Rewrite OSM2World's glb into game-world coordinates.

    Positions and normals are rewritten inside the binary chunk, so the
    textures, UVs and materials pass through untouched. Nodes that are not
    buildings, or whose centre lies outside the area, are dropped from the
    scene. height(x, z) -> terrain y; chunk_of(x, z) -> (col, row) or None;
    in_area(x, z) -> whether the terrain there is measured."""
    raw = open(glb_in, "rb").read()
    jl, = struct.unpack_from("<I", raw, 12)
    g = json.loads(raw[20:20 + jl])
    bo = 20 + jl
    bl, = struct.unpack_from("<I", raw, bo)
    blob = bytearray(raw[bo + 8:bo + 8 + bl])

    # the linear part of the fitted transform, for normals
    ox, oz = to_utm(0.0, 0.0)
    ax = [a - b for a, b in zip(to_utm(1.0, 0.0), (ox, oz))]
    az = [a - b for a, b in zip(to_utm(0.0, 1.0), (ox, oz))]

    def view(i):
        a = g["accessors"][i]
        bv = g["bufferViews"][a["bufferView"]]
        if a["componentType"] != 5126 or a["type"] != "VEC3":
            raise ValueError("unexpected accessor layout")
        stride = bv.get("byteStride") or 12
        return a, bv.get("byteOffset", 0) + a.get("byteOffset", 0), stride

    def read3(i):
        a, off, stride = view(i)
        return [struct.unpack_from("<3f", blob, off + k * stride) for k in range(a["count"])]

    def write3(i, vals):
        a, off, stride = view(i)
        for k, v in enumerate(vals):
            struct.pack_into("<3f", blob, off + k * stride, *v)
        a["min"] = [min(v[j] for v in vals) for j in range(3)]
        a["max"] = [max(v[j] for v in vals) for j in range(3)]

    variants = {}

    def variant(mi, rgb):
        """A copy of material mi with a different base colour factor."""
        key = (mi, rgb)
        if key not in variants:
            m = json.loads(json.dumps(g["materials"][mi]))
            m.setdefault("pbrMetallicRoughness", {})["baseColorFactor"] = \
                [_linear(c) for c in rgb] + [1.0]
            g["materials"].append(m)
            variants[key] = len(g["materials"]) - 1
        return variants[key]

    def base_factor(mi):
        return tuple(g["materials"][mi].get("pbrMetallicRoughness", {})
                     .get("baseColorFactor", (1.0, 1.0, 1.0, 1.0))[:3])

    done = set()
    keep = []
    stats = {"buildings": 0, "triangles": 0, "dropped": 0, "tinted": 0,
             "tallest": 0.0, "chunks": {}, "draped": [], "sunk": []}
    for n in g["nodes"]:
        if n.get("translation") or n.get("matrix") or n.get("rotation"):
            raise ValueError("node transforms are not expected in OSM2World output")
    for ni, node, meshes in objects_of(g):
        if not node.get("name", "").startswith("Building"):
            stats["dropped"] += 1
            continue
        prims = [p for mi in meshes for p in g["meshes"][mi]["primitives"]
                 if p.get("mode", 4) == 4]
        local = [read3(p["attributes"]["POSITION"]) for p in prims]
        pts = [v for vs in local for v in vs]
        if not pts:
            continue
        world_xz = []
        for x, _y, z in pts:
            e, n = to_utm(x, z)
            world_xz.append((e - ORIGIN_E, -(n - ORIGIN_N)))
        cx = sum(p[0] for p in world_xz) / len(world_xz)
        cz = sum(p[1] for p in world_xz) / len(world_xz)
        chunk = chunk_of(cx, cz)
        if chunk is None:
            continue
        base_y = min(p[1] for p in pts)
        base_xz = [xz for xz, p in zip(world_xz, pts) if p[1] < base_y + 0.5]
        lift = placement(base_xz, height, in_area)
        if lift(cx, cz) != lift(base_xz[0][0], base_xz[0][1]) or len(set(
                lift(*p) for p in base_xz[:50])) > 1:
            stats["draped"].append(node.get("name", ""))
        stats["tallest"] = max(stats["tallest"], max(p[1] for p in pts))

        oid = node.get("extras", {}).get("osmId")
        seed = _seed(oid)
        facade = FACADES[seed % len(FACADES)]
        roof = ROOFS[(seed >> 8) % len(ROOFS)]
        for p, vs in zip(prims, local):
            pa = p["attributes"]["POSITION"]
            is_window = ("material" in p and g["materials"][p["material"]]
                         .get("name", "").startswith("Windows"))
            if pa not in done:
                out = []
                for x, y, z in vs:
                    e, n = to_utm(x, z)
                    wx, wz = e - ORIGIN_E, -(n - ORIGIN_N)
                    wy = y + lift(wx, wz)
                    # wall feet reach down to the ground under them, so a
                    # corner standing over a dip has no gap beneath it. Not
                    # the window layer: stretched, its bottom storey would
                    # turn into one window several metres tall.
                    if y < base_y + 0.01 and not is_window:
                        wy = min(wy, height(wx, wz) - 0.1)
                    out.append((wx, wy, wz))
                write3(pa, out)
                done.add(pa)
            na = p["attributes"].get("NORMAL")
            if na is not None and na not in done:
                out = []
                for nx, ny, nz in read3(na):
                    # (E, N) direction, then N -> -z
                    wx = ax[0] * nx + az[0] * nz
                    wz = -(ax[1] * nx + az[1] * nz)
                    ln = math.sqrt(wx * wx + ny * ny + wz * wz) or 1.0
                    out.append((wx / ln, ny / ln, wz / ln))
                write3(na, out)
                done.add(na)
            if "indices" in p:
                stats["triangles"] += g["accessors"][p["indices"]]["count"] // 3
            mi = p.get("material")
            if mi is not None:
                f = base_factor(mi)
                if _near(f, DEFAULT_WALL):
                    p["material"] = variant(mi, facade)
                    stats["tinted"] += 1
                elif _near(f, DEFAULT_ROOF):
                    p["material"] = variant(mi, roof)
                    stats["tinted"] += 1
        # Quality check: where do the walls start relative to the ground
        # right around the building? Sampled at the outline's own corners;
        # the median ignores the odd ramp beside one wall.
        # Wall feet always reach the ground now, so nothing floats; what is
        # left to check is how deep the high side is buried, which should
        # only be large where the ground really steps under a building.
        corners = {(round(x, 1), round(z, 1)) for x, z in base_xz if in_area(x, z)}
        buried = max((height(x, z) - lift(x, z) for x, z in corners), default=0.0)
        if buried > 2.0:
            stats["sunk"].append((buried, node.get("name", "")))
        node.setdefault("extras", {})["chunk"] = "%d_%d" % chunk
        keep.append(ni)
        stats["buildings"] += 1
        stats["chunks"]["%d_%d" % chunk] = stats["chunks"].get("%d_%d" % chunk, 0) + 1

    stats["sunk"].sort(reverse=True)
    # glTF names the scene roots explicitly; anything not listed is not drawn.
    # The kept building nodes keep their per-material children.
    for s in g["scenes"]:
        s["nodes"] = keep
    g.setdefault("asset", {})["extras"] = {
        "crs": "game world: x = E - %.1f, y = h - ORIGIN_H, z = -(N - %.1f), EPSG:25833"
               % (ORIGIN_E, ORIGIN_N)}

    js = json.dumps(g, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    blob += b"\0" * (-len(blob) % 4)
    out = bytearray(b"glTF" + struct.pack("<II", 2, 12 + 8 + len(js) + 8 + len(blob)))
    out += struct.pack("<I", len(js)) + b"JSON" + js
    out += struct.pack("<I", len(blob)) + b"BIN\0" + blob
    with open(glb_out, "wb") as fh:
        fh.write(out)
    stats["bytes"] = len(out)
    return stats


LEVEL_HEIGHT = 3.3          # metres per storey when estimating levels


def _num(tags, key):
    try:
        return float(tags.get(key, "").split()[0].replace(",", "."))
    except (ValueError, IndexError):
        return None


def _inside(ring, x, z):
    hit = False
    for i in range(len(ring)):
        (x1, z1), (x2, z2) = ring[i], ring[i - 1]
        if (z1 > z) != (z2 > z) and x < (x2 - x1) * (z - z1) / (z2 - z1) + x1:
            hit = not hit
    return hit


def fit_roof(ks, rings, top, ground, nx, x0, z0):
    """Roof shape from the laser scan's surface model, Zurich-style.

    Each building's roof cells (its outline shrunk by a metre, so walls and
    eaves do not count) are fitted with the roof models OSM2World knows -
    flat, gabled with the ridge along or across the building, hipped, and a
    single-pitch (skillion) roof - by least squares in the building's own
    axes. The best pitched fit wins only if it explains the roof clearly
    better than a flat one and is steep enough to be a real pitch; Berlin's
    many flat-roofed blocks stay flat. Returns a dict of tag values or None
    when the scan saw too little of the roof."""
    member = set(ks)
    inner = [k for k in ks if k - 1 in member and k + 1 in member
             and k - nx in member and k + nx in member]
    pts = [(x0 + k % nx + 0.5, z0 + k // nx + 0.5, top[k] - ground[k])
           for k in inner if top[k] == top[k]]
    if len(pts) < 20 or len(pts) < 0.4 * len(inner):
        return None
    pts = [p for p in pts if p[2] > 1.5]        # a few ground hits through skylights
    if len(pts) < 20:
        return None

    # building axes: length-weighted mean direction of the outline's edges
    ring = rings[0]
    sx = sy = 0.0
    for (ax, az), (bx, bz) in zip(ring, ring[1:] + ring[:1]):
        L = math.hypot(bx - ax, bz - az)
        phi = math.atan2(bz - az, bx - ax)
        sx += L * math.cos(2 * phi)
        sy += L * math.sin(2 * phi)
    th = 0.5 * math.atan2(sy, sx)
    ct, st = math.cos(th), math.sin(th)
    cx = sum(p[0] for p in ring) / len(ring)
    cz = sum(p[1] for p in ring) / len(ring)
    uv = [((x - cx) * ct + (z - cz) * st, -(x - cx) * st + (z - cz) * ct) for x, z in ring]
    umin, umax = min(p[0] for p in uv), max(p[0] for p in uv)
    wmin, wmax = min(p[1] for p in uv), max(p[1] for p in uv)
    if wmax - wmin > umax - umin:       # keep u the long axis
        th += math.pi / 2
        ct, st = math.cos(th), math.sin(th)
        uv = [((x - cx) * ct + (z - cz) * st, -(x - cx) * st + (z - cz) * ct) for x, z in ring]
        umin, umax = min(p[0] for p in uv), max(p[0] for p in uv)
        wmin, wmax = min(p[1] for p in uv), max(p[1] for p in uv)
    u0, w0 = (umin + umax) / 2, (wmin + wmax) / 2
    Lu, Lw = umax - umin, wmax - wmin
    U = [(x - cx) * ct + (z - cz) * st for x, z, _ in pts]
    W = [-(x - cx) * st + (z - cz) * ct for x, z, _ in pts]
    V = [v for _x, _z, v in pts]
    n = len(V)
    mv = sum(V) / n

    def regress(F):
        mf = sum(F) / n
        var = sum((f - mf) ** 2 for f in F)
        if var < 1e-6:
            return None
        b = sum((f - mf) * (v - mv) for f, v in zip(F, V)) / var
        a = mv - b * mf
        rmse = math.sqrt(sum((a + b * f - v) ** 2 for f, v in zip(F, V)) / n)
        return a, b, rmse

    flat_rmse = math.sqrt(sum((v - mv) ** 2 for v in V) / n)
    fits = {}
    r = regress([abs(w - w0) for w in W])
    if r and r[1] < 0:
        fits["gabled_along"] = (r, -r[1] * Lw / 2)
    r = regress([abs(u - u0) for u in U])
    if r and r[1] < 0:
        fits["gabled_across"] = (r, -r[1] * Lu / 2)
    r = regress([max(abs(w - w0), abs(u - u0) - (Lu - Lw) / 2) for u, w in zip(U, W)])
    if r and r[1] < 0:
        fits["hipped"] = (r, -r[1] * Lw / 2)
    r = regress(W)
    if r:
        fits["skillion"] = (r, abs(r[1]) * Lw)
    # Perimeter-block buildings are L-, U- and T-shaped, with no single
    # ridge axis. Their roofs still rise with distance from the nearest outer
    # wall - which is how OSM2World builds a hipped roof on an arbitrary
    # outline (a straight skeleton), so a good fit here maps straight onto it.
    edges = [(a, b) for ring_ in rings for a, b in zip(ring_, ring_[1:] + ring_[:1])]

    def to_edge(x, z):
        best = 1e9
        for (ax, az), (bx, bz) in edges:
            dx, dz = bx - ax, bz - az
            L2 = dx * dx + dz * dz or 1e-9
            t = max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / L2))
            best = min(best, math.hypot(x - ax - t * dx, z - az - t * dz))
        return best
    D = [to_edge(x, z) for x, z, _ in pts]
    r = regress(D)
    if r and r[1] > 0:
        fits["skeleton"] = ((r[0] + r[1] * max(D), -r[1], r[2]), r[1] * max(D))

    best = min(fits.items(), key=lambda kv: kv[1][0][2]) if fits else None
    Vs = sorted(V)
    flat = {"shape": "flat", "top": Vs[int(n * 0.9)]}
    if best is None:
        return flat
    name, ((a, b, rmse), roof_h) = best
    slope = abs(b)
    # A real pitched roof fits its laser points to within about a metre
    # (dormers and chimneys included) at a believable pitch. Buildings with
    # wings at different heights can fit a "roof" better than a flat plane
    # too - with metres of error, near-vertical slopes and 12 m roofs - and
    # those must stay flat here; split_by_height deals with them.
    pitched = (rmse < 0.7 * flat_rmse and flat_rmse > 0.6 and rmse < 1.0
               and (0.15 if name == "skillion" else 0.25) < slope < 1.4
               and 1.0 <= roof_h < 10.0)
    if not pitched:
        return flat
    roof_h = min(roof_h, 12.0)
    if name == "skillion":
        top_h = max(a + b * w for w in (wmin, wmax))
    else:
        top_h = a
    if roof_h > 0.8 * top_h:
        return flat
    shape = "gabled" if name.startswith("gabled") else ("hipped" if name == "skeleton" else name)
    out = {"shape": shape, "top": top_h, "roof_height": roof_h,
           "rmse": rmse, "flat_rmse": flat_rmse, "slope": slope, "model": name}
    if name == "gabled_along":
        out["orientation"] = "along"
    elif name == "gabled_across":
        out["orientation"] = "across"
    elif name == "skillion":
        # the roof faces downhill; the w axis in world x/z is (-sin, cos)
        dx, dz = -st, ct
        if b > 0:
            dx, dz = -dx, -dz
        out["direction"] = math.degrees(math.atan2(dx, -dz)) % 360
    return out


def complete_3d_tags(osm_path, out_path, nodes, ways, rels, ground, top, grid):
    """Fill in 3D tags OSM does not have, without overriding any it does.

    Two gaps matter for OSM2World:

      * No height at all. The laser scan records roofs as well as ground:
        for a building or building part with neither `height` nor
        `building:levels`, the median of roof-above-ground over the cells
        inside its outline becomes `height`, storeys are estimated from it,
        and the roof is declared flat - the median is one level, and a
        default pitched roof on top of it would overshoot.
      * A height but no storey count. OSM2World then draws the walls but no
        windows, which is what made parts of Tempelhof a blank wall. Storeys
        are estimated from the mapped wall height.

    Outlines that contain building:parts are left alone entirely: under
    Simple 3D Buildings their geometry *is* the parts, and the outline only
    marks the footprint. Giving such an outline a height made OSM2World build
    a second facade over the parts - two window grids drifting apart storey
    by storey. Tempelhof is mapped exactly like this.

    ground, top: flat 1 m grids (top is NaN where nothing standing was hit);
    grid = (x0, z0, nx, nz). Writes a patched copy of the OSM file and
    returns ({osm id: measured height}, {osm id: estimated levels})."""
    from groundcover import _rings
    from raster import cells
    x0, z0, nx, nz = grid

    def to_world(ids):
        out = []
        for i in ids:
            if i in nodes:
                e, n = utm33(*nodes[i])
                out.append((e - ORIGIN_E, -(n - ORIGIN_N)))
        return out

    def is_3d(tags):
        if "building" not in tags and "building:part" not in tags:
            return False
        return (tags.get("building") not in ("roof", "carport", "no")
                and tags.get("building:part") not in ("roof", "no"))

    shapes = {}
    for wid, (ids, tags) in ways.items():
        if len(ids) >= 4 and ids[0] == ids[-1] and is_3d(tags):
            shapes[("way", wid)] = ([to_world(ids)], tags)
    for rid, (members, tags) in rels.items():
        if tags.get("type") != "multipolygon" or not is_3d(tags):
            continue
        fake = {"type": "relation", "members": [
            {"type": "way", "role": role,
             "geometry": [{"lon": nodes[i][0], "lat": nodes[i][1]}
                          for i in ways[ref][0] if i in nodes]}
            for t, ref, role in members if t == "way" and ref in ways]}
        rings = _rings(fake)
        if rings:
            shapes[("relation", rid)] = (rings, tags)

    # centre of every part, to find the outlines that have parts inside
    part_centres = []
    for (_k, _i), (rings, tags) in shapes.items():
        if "building:part" in tags and rings[0]:
            ring = rings[0]
            part_centres.append((sum(p[0] for p in ring) / len(ring),
                                 sum(p[1] for p in ring) / len(ring)))

    def has_parts(rings):
        xs = [p[0] for p in rings[0]]
        zs = [p[1] for p in rings[0]]
        return any(min(xs) <= cx <= max(xs) and min(zs) <= cz <= max(zs)
                   and sum(_inside(r, cx, cz) for r in rings) % 2 == 1
                   for cx, cz in part_centres)

    import split as splitter
    adds, skipped = {}, 0
    new_parts = []              # (polygon in world x/z, tags) to add as ways
    counts = {"heights": 0, "levels": 0, "roofs": {}, "split": 0, "parts": 0}
    for key, (rings, tags) in shapes.items():
        if "building:part" not in tags and has_parts(rings):
            skipped += 1
            continue
        add = {}
        h_mapped = _num(tags, "height")
        ks = cells(rings, x0, z0, 1.0, nx, nz)
        # Wings of different heights under one outline: split by the scan.
        # Outlines whose height or roof shape someone mapped are trusted.
        if ("building:part" not in tags and h_mapped is None
                and "roof:shape" not in tags and len(ks) >= 100):
            parts = splitter.split(ks, rings, top, ground, nx, x0, z0)
            if parts:
                counts["split"] += 1
                for poly, pcells in parts:
                    pr = fit_roof(pcells, [poly], top, ground, nx, x0, z0)
                    vals = sorted(top[k] - ground[k] for k in pcells if top[k] == top[k])
                    ph = pr["top"] if pr else (vals[int(len(vals) * 0.9)] if vals else None)
                    if ph is None or ph < 2.0:
                        continue
                    pt = {"building:part": "yes", "height": "%.1f" % ph,
                          "source:height": "ALS Berlin, split by gta-berlin"}
                    roof_h = 0.0
                    if pr and pr["shape"] != "flat":
                        roof_h = pr["roof_height"]
                        pt["roof:shape"] = pr["shape"]
                        pt["roof:height"] = "%.1f" % roof_h
                        if "orientation" in pr:
                            pt["roof:orientation"] = pr["orientation"]
                        if "direction" in pr:
                            pt["roof:direction"] = "%.0f" % pr["direction"]
                        counts["roofs"][pr["shape"]] = counts["roofs"].get(pr["shape"], 0) + 1
                    else:
                        pt["roof:shape"] = "flat"
                        counts["roofs"]["flat"] = counts["roofs"].get("flat", 0) + 1
                    pt["building:levels"] = str(max(1, round((ph - roof_h) / LEVEL_HEIGHT)))
                    for k in ("building:colour", "building:material", "roof:colour"):
                        if k in tags:
                            pt[k] = tags[k]
                    new_parts.append((poly, pt))
                    counts["parts"] += 1
                continue
        roof = None
        if "roof:shape" not in tags:
            roof = fit_roof(ks, rings, top, ground, nx, x0, z0)
        if roof:
            add["roof:shape"] = roof["shape"]
            if roof["shape"] != "flat":
                add["roof:height"] = "%.1f" % roof["roof_height"]
                if "orientation" in roof:
                    add["roof:orientation"] = roof["orientation"]
                if "direction" in roof:
                    add["roof:direction"] = "%.0f" % roof["direction"]
            add["source:roof:shape"] = "ALS Berlin, fitted by gta-berlin"
            counts["roofs"][roof["shape"]] = counts["roofs"].get(roof["shape"], 0) + 1
            if h_mapped is None and "building:levels" not in tags:
                add["height"] = "%.1f" % roof["top"]
                add["source:height"] = "ALS Berlin, derived by gta-berlin"
                counts["heights"] += 1
        if "building:levels" not in tags:
            # storeys from the wall height, which is what carries windows
            if h_mapped is not None:
                wall = h_mapped - (_num(tags, "min_height") or 0.0) \
                    - (_num(tags, "roof:height") or (roof or {}).get("roof_height", 0.0))
            elif roof:
                wall = roof["top"] - roof.get("roof_height", 0.0)
            else:
                wall = None
            if wall is not None and wall >= 2.0:
                add["building:levels"] = str(max(1, round(wall / LEVEL_HEIGHT)))
                add["source:building:levels"] = "estimated by gta-berlin"
                counts["levels"] += 1
        # never override what is mapped: a fitted roof brings its own
        # orientation and height, which OSM may already have without a shape
        add = {k: v for k, v in add.items() if k not in tags}
        if add:
            adds[key] = add

    tree = ET.parse(osm_path)
    root = tree.getroot()
    buried = []
    for el in root:
        key = (el.tag, int(el.get("id", "0")))
        for k, v in adds.get(key, {}).items():
            ET.SubElement(el, "tag", k=k, v=v)
        if el.tag in ("way", "relation") and _underground({t.get("k"): t.get("v")
                                                           for t in el.findall("tag")}):
            buried.append(el)
    for el in buried:
        root.remove(el)
    counts["underground"] = len(buried)
    # generated parts: new nodes and ways with negative ids, as editors do
    from geo import utm33_inv
    nid = wid = 0
    for poly, pt in new_parts:
        refs = []
        for x, z in poly:
            nid -= 1
            lon, lat = utm33_inv(x + ORIGIN_E, ORIGIN_N - z)
            ET.SubElement(root, "node", id=str(nid), lat="%.8f" % lat, lon="%.8f" % lon,
                          version="1", visible="true")
            refs.append(nid)
        wid -= 1
        way = ET.SubElement(root, "way", id=str(wid), version="1", visible="true")
        for r in refs + refs[:1]:
            ET.SubElement(way, "nd", ref=str(r))
        for k, v in pt.items():
            ET.SubElement(way, "tag", k=k, v=v)
    tree.write(out_path, encoding="utf-8", xml_declaration=True)
    return counts, skipped


def _underground(tags):
    """A building or part below the street: tagged so, or on a negative layer
    without saying it is at the surface anyway."""
    if "building" not in tags and "building:part" not in tags:
        return False
    loc = tags.get("location", "")
    if loc in ("underground", "underwater"):
        return True
    try:
        layer = int(tags.get("layer", "0"))
    except ValueError:
        return False
    return layer < 0 and loc not in ("surface", "overground", "roof", "rooftop")


def footprints(nodes, ways, rels):
    """Building outlines that block movement, as lists of rings in world x/z.

    Only whole buildings count, not building:part (parts subdivide the same
    outline). Canopies and carports - building=roof - are open underneath, as
    are buildings that start above head height."""
    def blocks(tags):
        if "building" not in tags or tags.get("building") in ("roof", "carport", "no"):
            return False
        if tags.get("location") == "underground":
            return False
        try:
            if float(tags.get("min_height", "0").split()[0]) >= 2.5:
                return False
            if float(tags.get("building:min_level", "0")) >= 1:
                return False
            if int(tags.get("layer", "0")) < 0:
                return False
        except (ValueError, IndexError):
            pass
        return True

    def to_world(ids):
        out = []
        for i in ids:
            if i in nodes:
                e, n = utm33(*nodes[i])
                out.append((e - ORIGIN_E, -(n - ORIGIN_N)))
        return out

    from groundcover import _rings
    shapes = []
    for _wid, (ids, tags) in ways.items():
        if len(ids) >= 4 and ids[0] == ids[-1] and blocks(tags):
            shapes.append([to_world(ids)])
    for _rid, (members, tags) in rels.items():
        if tags.get("type") != "multipolygon" or not blocks(tags):
            continue
        fake = {"type": "relation", "members": [
            {"type": "way", "role": role,
             "geometry": [{"lon": nodes[i][0], "lat": nodes[i][1]}
                          for i in ways[ref][0] if i in nodes]}
            for t, ref, role in members if t == "way" and ref in ways]}
        rings = _rings(fake)
        if rings:
            shapes.append(rings)
    return shapes


def tag_lookup(ways, rels):
    def get(oid):
        if not oid:
            return {}
        try:
            i = int(oid[1:])
        except ValueError:
            return {}
        if oid[0] == "w" and i in ways:
            return ways[i][1]
        if oid[0] == "r" and i in rels:
            return rels[i][1]
        return {}
    return get
