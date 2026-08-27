"""Compact binary tile format for the browser.

One file per 1x1 km tile per layer. Geometry is a plain triangle soup with
quantised positions - no index buffer, because LoD2 faces are flat-shaded and
share no vertices anyway. Normals are not stored at all: the fragment shader
reconstructs exact flat normals from screen-space derivatives, which saves
three bytes per vertex and looks sharper than anything averaged.

Layout (little endian), buildings:

    char[4] "BTB1"
    f32     minX, minY, minZ        world-space AABB minimum, metres
    f32     sclX, sclY, sclZ        metres per quantisation step
    u32     vertexCount             always a multiple of 3
    u16[V]  x, then u16[V] y, then u16[V] z      (planar, gzips well)
    u8[V]   kind                    0 wall, 1 roof, 2 ground
    u8[V]   bheight                 height of the parent building, metres
    u8[V]   bbase                   parent building base, metres + BASE_OFFSET

Streets use "BTS1" with the same header and u8 kind, no bheight/bbase.
"""
import struct

BASE_OFFSET = 40          # lets bbase cover -40 m .. +215 m in a byte
QMAX = 65535


class TileWriter:
    """Accumulates triangles, then serialises them."""

    def __init__(self, magic=b"BTB1", extra_bytes=("bheight", "bbase")):
        self.magic = magic
        self.extra_names = list(extra_bytes)
        self.px, self.py, self.pz = [], [], []
        self.kind = []
        self.extra = {n: [] for n in self.extra_names}

    def __len__(self):
        return len(self.px)

    def add_triangle(self, p0, p1, p2, kind, **extra):
        for p in (p0, p1, p2):
            self.px.append(p[0])
            self.py.append(p[1])
            self.pz.append(p[2])
            self.kind.append(kind)
            for n in self.extra_names:
                self.extra[n].append(extra.get(n, 0))

    def bounds(self):
        return ((min(self.px), min(self.py), min(self.pz)),
                (max(self.px), max(self.py), max(self.pz)))

    def to_bytes(self):
        v = len(self.px)
        if v == 0:
            return None
        lo, hi = self.bounds()
        scl = []
        for i in range(3):
            span = hi[i] - lo[i]
            scl.append(span / QMAX if span > 1e-9 else 1.0)

        out = bytearray()
        out += self.magic
        out += struct.pack("<3f", *lo)
        out += struct.pack("<3f", *scl)
        out += struct.pack("<I", v)

        for arr, lo_i, scl_i in ((self.px, lo[0], scl[0]),
                                 (self.py, lo[1], scl[1]),
                                 (self.pz, lo[2], scl[2])):
            buf = bytearray(v * 2)
            inv = 1.0 / scl_i
            for i, value in enumerate(arr):
                q = int((value - lo_i) * inv + 0.5)
                if q < 0:
                    q = 0
                elif q > QMAX:
                    q = QMAX
                buf[i * 2] = q & 0xFF
                buf[i * 2 + 1] = (q >> 8) & 0xFF
            out += buf

        out += bytes(self.kind)
        for n in self.extra_names:
            out += bytes(self.extra[n])
        return bytes(out)


def clamp_byte(x):
    x = int(x + 0.5)
    return 0 if x < 0 else (255 if x > 255 else x)
