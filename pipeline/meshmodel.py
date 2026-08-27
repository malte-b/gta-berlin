"""Reader for Berlin's photogrammetric 3D mesh model (OBJ + texture atlases).

The mesh model is what the Business Location Center download portal serves:
one folder per tile containing a Wavefront OBJ and a handful of JPEG atlas
pages. Unlike the LoD2 building models this is a single continuous surface -
ground, buildings, bridges and trees are all one skin - with photographic
texture baked in from the aerial survey.

Relevant properties of the files, confirmed by inspection:
  * vertices are absolute EPSG:25833 easting/northing/height, in metres, so
    they drop straight into the same game world as everything else
  * faces are "f v/vt v/vt v/vt" - no normals are supplied
  * there is exactly one vt per face corner, so nothing can be shared and the
    geometry expands to a triangle soup
  * faces are already grouped by usemtl, which means each atlas page becomes
    one contiguous draw range and no per-vertex material id is needed

Emitted formats (little endian):

  "BTM1" geometry
    f32 minX,minY,minZ  f32 sclX,sclY,sclZ   quantisation of the tile AABB
    u32 vertexCount
    u16 groupCount
    groupCount x { u16 page, u32 start, u32 count }
    u16[V] x, u16[V] y, u16[V] z, u16[V] u, u16[V] v

  "BTH1" heightfield, 1 m cells, used for walking and collision
    f32 minX, minZ   f32 cell   u16 nx, nz   f32 hmin, hscale
    u16[nx*nz] ground     lowest surface in the cell
    u16[nx*nz] top        highest surface in the cell
"""
import os
import re
import struct

from geo import ORIGIN_E, ORIGIN_H, ORIGIN_N

QMAX = 65535
CELL = 1.0
NODATA = 65535


def parse_obj(path):
    """Stream an OBJ into (verts, uvs, groups).

    groups is [(page_index, [(vi, ti), ...]), ...] in file order.
    Indices are already zero-based.
    """
    verts = []
    uvs = []
    groups = []
    cur = None
    page_re = re.compile(r"-(\d+)\s*$")

    with open(path, "r", errors="replace") as fh:
        for line in fh:
            if line.startswith("v "):
                _, x, y, z = line.split()
                verts.append((float(x), float(y), float(z)))
            elif line.startswith("vt "):
                p = line.split()
                uvs.append((float(p[1]), float(p[2])))
            elif line.startswith("f "):
                p = line.split()
                if cur is None:
                    cur = (0, [])
                    groups.append(cur)
                tri = []
                for c in p[1:4]:
                    a, _, b = c.partition("/")
                    tri.append((int(a) - 1, int(b) - 1 if b else -1))
                cur[1].append(tri)
            elif line.startswith("usemtl"):
                m = page_re.search(line.strip())
                page = int(m.group(1)) if m else len(groups)
                cur = (page, [])
                groups.append(cur)
    return verts, uvs, groups


def write_geometry(verts, uvs, groups):
    """Quantise to the tile AABB and serialise. Returns (bytes, stats)."""
    total = sum(len(g[1]) for g in groups) * 3
    if total == 0:
        return None, None

    mnx = mny = mnz = 1e18
    mxx = mxy = mxz = -1e18
    for x, y, z in verts:
        if x < mnx: mnx = x
        if x > mxx: mxx = x
        if y < mny: mny = y
        if y > mxy: mxy = y
        if z < mnz: mnz = z
        if z > mxz: mxz = z

    # OBJ is (E, N, h); the game world is metres from the origin at the
    # Brandenburger Tor, with y up and -z pointing north
    lo = (mnx - ORIGIN_E, mnz - ORIGIN_H, -(mxy - ORIGIN_N))
    hi = (mxx - ORIGIN_E, mxz - ORIGIN_H, -(mny - ORIGIN_N))
    scl = [((hi[i] - lo[i]) / QMAX) if hi[i] - lo[i] > 1e-9 else 1.0 for i in range(3)]
    inv = [1.0 / s for s in scl]

    px = bytearray(total * 2)
    py = bytearray(total * 2)
    pz = bytearray(total * 2)
    pu = bytearray(total * 2)
    pv = bytearray(total * 2)

    def q(val, lo_i, inv_i):
        n = int((val - lo_i) * inv_i + 0.5)
        return 0 if n < 0 else (QMAX if n > QMAX else n)

    out_groups = []
    i = 0
    for page, faces in groups:
        start = i
        for tri in faces:
            # flipping N -> -Z mirrors the winding, so swap two corners back
            for vi, ti in (tri[0], tri[2], tri[1]):
                vx, vy, vz = verts[vi]
                wx = vx - ORIGIN_E
                wy = vz - ORIGIN_H
                wz = -(vy - ORIGIN_N)
                a = q(wx, lo[0], inv[0]); px[i * 2] = a & 255; px[i * 2 + 1] = a >> 8
                a = q(wy, lo[1], inv[1]); py[i * 2] = a & 255; py[i * 2 + 1] = a >> 8
                a = q(wz, lo[2], inv[2]); pz[i * 2] = a & 255; pz[i * 2 + 1] = a >> 8
                if 0 <= ti < len(uvs):
                    u, v = uvs[ti]
                else:
                    u = v = 0.0
                a = q(u, 0.0, QMAX); pu[i * 2] = a & 255; pu[i * 2 + 1] = a >> 8
                # OBJ's texture origin is bottom-left and three's TextureLoader
                # already uploads with flipY, so V is passed through untouched.
                # Flipping it here as well mirrors every atlas patch, which
                # keeps the geometry correct but shreds the imagery across it.
                a = q(v, 0.0, QMAX); pv[i * 2] = a & 255; pv[i * 2 + 1] = a >> 8
                i += 1
        if i > start:
            out_groups.append((page, start, i - start))

    buf = bytearray(b"BTM1")
    buf += struct.pack("<3f", *lo)
    buf += struct.pack("<3f", *scl)
    buf += struct.pack("<I", total)
    buf += struct.pack("<H", len(out_groups))
    for page, start, count in out_groups:
        buf += struct.pack("<HII", page, start, count)
    buf += px + py + pz + pu + pv
    stats = {"v": total, "tri": total // 3, "groups": len(out_groups),
             "bbox": [round(v, 1) for v in (lo + hi)]}
    return bytes(buf), stats


def build_heightfield(verts, groups, cell=CELL):
    """Rasterise the surface into per-cell lowest/highest height.

    Ground level and obstacle height both come out of this: you walk on
    `ground`, and a cell counts as blocked when `top - ground` is more than a
    person is tall. It replaces both the terrain model and the footprint mask
    the LoD2 pipeline needed, because here they are the same surface.
    """
    mnx = mny = 1e18
    mxx = mxy = -1e18
    for x, y, _z in verts:
        if x < mnx: mnx = x
        if x > mxx: mxx = x
        if y < mny: mny = y
        if y > mxy: mxy = y

    min_x = mnx - ORIGIN_E
    min_z = -(mxy - ORIGIN_N)         # world z of the tile's north edge
    nx = max(1, int((mxx - mnx) / cell) + 1)
    nz = max(1, int((mxy - mny) / cell) + 1)
    n = nx * nz
    ground = [None] * n
    top = [None] * n

    for _page, faces in groups:
        for tri in faces:
            xs = []
            zs = []
            hs = []
            for vi, _ti in tri:
                vx, vy, vz = verts[vi]
                xs.append(vx - ORIGIN_E)
                zs.append(-(vy - ORIGIN_N))
                hs.append(vz - ORIGIN_H)
            c0 = int((min(xs) - min_x) / cell)
            c1 = int((max(xs) - min_x) / cell)
            r0 = int((min(zs) - min_z) / cell)
            r1 = int((max(zs) - min_z) / cell)
            lo_h = min(hs)
            hi_h = max(hs)
            if c1 < 0 or r1 < 0 or c0 >= nx or r0 >= nz:
                continue
            for r in range(max(r0, 0), min(r1 + 1, nz)):
                base = r * nx
                for c in range(max(c0, 0), min(c1 + 1, nx)):
                    k = base + c
                    g = ground[k]
                    if g is None or lo_h < g:
                        ground[k] = lo_h
                    t = top[k]
                    if t is None or hi_h > t:
                        top[k] = hi_h

    known = [v for v in ground if v is not None]
    fallback = sum(known) / len(known) if known else 0.0
    for k in range(n):
        if ground[k] is None:
            ground[k] = fallback
        if top[k] is None:
            top[k] = ground[k]

    hmin = min(min(ground), min(top))
    hmax = max(max(ground), max(top))
    span = hmax - hmin
    scale = span / QMAX if span > 1e-9 else 1.0
    inv = 1.0 / scale

    buf = bytearray(b"BTH1")
    buf += struct.pack("<2f", min_x, min_z)
    buf += struct.pack("<f", cell)
    buf += struct.pack("<2H", nx, nz)
    buf += struct.pack("<2f", hmin, scale)
    for arr in (ground, top):
        b = bytearray(n * 2)
        for k, v in enumerate(arr):
            a = int((v - hmin) * inv + 0.5)
            a = 0 if a < 0 else (QMAX if a > QMAX else a)
            b[k * 2] = a & 255
            b[k * 2 + 1] = a >> 8
        buf += b
    return bytes(buf), {"nx": nx, "nz": nz,
                        "hmin": round(hmin, 2), "hmax": round(hmax, 2)}


def tile_key(dirname):
    """'3901_58160_-002' -> '3901_58160' (the LOD suffix is not part of the id)."""
    parts = dirname.split("_")
    return "_".join(parts[:2])


def find_tiles(root):
    out = {}
    for d in sorted(os.listdir(root)):
        p = os.path.join(root, d)
        if not os.path.isdir(p):
            continue
        objs = [f for f in os.listdir(p) if f.lower().endswith(".obj")]
        if objs:
            out[tile_key(d)] = (p, os.path.join(p, objs[0]))
    return out
