"""Scanline rasterisation onto flat bytearray grids, plus a minimal PNG writer.

Used for both the 1 m navigation masks and the 0.5 m ground-cover texture.
Grids are row-major with row 0 at the grid's minimum z (the north edge, since
-z is north in the game world); cell (c, r) covers
[x0 + c*res, x0 + (c+1)*res) x [z0 + r*res, z0 + (r+1)*res).
"""
import math
import struct
import zlib


class Grid:
    def __init__(self, x0, z0, res, w, h, init=0):
        self.x0, self.z0, self.res, self.w, self.h = x0, z0, res, w, h
        self.data = bytearray([init]) * (w * h)

    def polygon(self, rings, value=255):
        """Fill the even-odd interior of one or more rings of (x, z).

        Holes need no special handling: an inner ring simply adds a second
        pair of crossings on every scanline through it."""
        edges = []
        zmin = math.inf
        zmax = -math.inf
        for ring in rings:
            n = len(ring)
            if n < 3:
                continue
            for i in range(n):
                xa, za = ring[i]
                xb, zb = ring[(i + 1) % n]
                if za == zb:
                    continue
                edges.append((xa, za, xb, zb))
                zmin = min(zmin, za, zb)
                zmax = max(zmax, za, zb)
        if not edges:
            return
        res, x0, z0, w = self.res, self.x0, self.z0, self.w
        r0 = max(0, int(math.floor((zmin - z0) / res - 0.5)))
        r1 = min(self.h - 1, int(math.ceil((zmax - z0) / res - 0.5)))
        fill = bytes([value])
        data = self.data
        for r in range(r0, r1 + 1):
            zc = z0 + (r + 0.5) * res
            xs = []
            for xa, za, xb, zb in edges:
                if (za <= zc < zb) or (zb <= zc < za):
                    xs.append(xa + (zc - za) * (xb - xa) / (zb - za))
            if len(xs) < 2:
                continue
            xs.sort()
            base = r * w
            for i in range(0, len(xs) - 1, 2):
                c0 = max(0, int(math.ceil((xs[i] - x0) / res - 0.5)))
                c1 = min(w - 1, int(math.floor((xs[i + 1] - x0) / res - 0.5)))
                if c1 >= c0:
                    data[base + c0:base + c1 + 1] = fill * (c1 - c0 + 1)

    def polyline(self, pts, half, value=255):
        """A thick line: one quad per segment and a disc at every vertex, so
        corners and junctions come out round instead of notched."""
        for i in range(len(pts) - 1):
            (ax, az), (bx, bz) = pts[i], pts[i + 1]
            dx, dz = bx - ax, bz - az
            ln = math.hypot(dx, dz)
            if ln < 1e-6:
                continue
            nx, nz = -dz / ln * half, dx / ln * half
            self.polygon([[(ax + nx, az + nz), (bx + nx, bz + nz),
                           (bx - nx, bz - nz), (ax - nx, az - nz)]], value)
        for x, z in pts:
            self.disc(x, z, half, value)

    def disc(self, x, z, radius, value=255, sides=10):
        self.polygon([[(x + math.cos(a) * radius, z + math.sin(a) * radius)
                       for a in (2 * math.pi * k / sides for k in range(sides))]],
                     value)

    def get(self, x, z):
        c = int((x - self.x0) / self.res)
        r = int((z - self.z0) / self.res)
        if 0 <= c < self.w and 0 <= r < self.h:
            return self.data[r * self.w + c]
        return 0


def write_png(path, w, h, channels):
    """8-bit PNG from a list of 1 (grey) or 4 (RGBA) equal-sized planes."""
    if len(channels) == 1:
        ctype, rows = 0, [bytes(channels[0][r * w:(r + 1) * w]) for r in range(h)]
    else:
        ctype = 6
        inter = bytearray(w * h * 4)
        for i, ch in enumerate(channels):
            inter[i::4] = ch
        rows = [bytes(inter[r * w * 4:(r + 1) * w * 4]) for r in range(h)]
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, body):
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, ctype, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


def cells(rings, x0, z0, res, w, h):
    """Indices (r * w + c) of the grid cells whose centres fall inside the
    rings, rasterised over just their bounding box rather than the whole grid."""
    xs = [p[0] for ring in rings for p in ring]
    zs = [p[1] for ring in rings for p in ring]
    if not xs:
        return []
    c0 = max(0, int(math.floor((min(xs) - x0) / res)))
    r0 = max(0, int(math.floor((min(zs) - z0) / res)))
    c1 = min(w - 1, int(math.ceil((max(xs) - x0) / res)))
    r1 = min(h - 1, int(math.ceil((max(zs) - z0) / res)))
    if c1 < c0 or r1 < r0:
        return []
    sub = Grid(x0 + c0 * res, z0 + r0 * res, res, c1 - c0 + 1, r1 - r0 + 1)
    sub.polygon(rings, 1)
    out = []
    for k, v in enumerate(sub.data):
        if v:
            out.append((r0 + k // sub.w) * w + c0 + k % sub.w)
    return out
