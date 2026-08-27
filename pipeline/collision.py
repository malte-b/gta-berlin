"""Per-tile building collision masks.

Testing the player against 2.4 million triangles every frame is not an option,
and it is not needed either: LoD2 buildings are vertical prisms, so a 2D
occupancy grid of their footprints is enough to stop you walking or driving
through a wall. Each tile becomes a 1000x1000 bitmask at 1 m resolution,
packed one pixel per bit: 125 KB raw, and it gzips to a few KB because cities
are mostly empty space at this scale.

Layout:
    char[4] "BTC1"
    f32     minX, minZ      world position of pixel (0,0)
    u16     n               grid size (1000)
    f32     res             metres per pixel
    u8[n*n/8]               row-major, bit 0 = leftmost pixel of a byte
"""
import struct

N = 1000
RES = 1.0


class Mask:
    def __init__(self, min_x, min_z, n=N, res=RES):
        self.min_x = min_x
        self.min_z = min_z
        self.n = n
        self.res = res
        assert n % 8 == 0, "grid size must be a multiple of 8"
        self.bits = bytearray((n * n + 7) // 8)
        self.filled = 0

    def _set(self, col, row):
        if 0 <= col < self.n and 0 <= row < self.n:
            i = row * self.n + col
            b = i >> 3
            m = 1 << (i & 7)
            if not (self.bits[b] & m):
                self.bits[b] |= m
                self.filled += 1

    def fill_triangle(self, p0, p1, p2):
        """Rasterise a world-space XZ triangle (top-left fill rule, no AA)."""
        xs = ((p0[0] - self.min_x) / self.res, (p1[0] - self.min_x) / self.res,
              (p2[0] - self.min_x) / self.res)
        zs = ((p0[1] - self.min_z) / self.res, (p1[1] - self.min_z) / self.res,
              (p2[1] - self.min_z) / self.res)
        r0 = int(min(zs))
        r1 = int(max(zs)) + 1
        if r1 < 0 or r0 > self.n:
            return
        r0 = max(r0, 0)
        r1 = min(r1, self.n)
        pts = list(zip(xs, zs))
        for row in range(r0, r1):
            y = row + 0.5
            hits = []
            for i in range(3):
                ax, az = pts[i]
                bx, bz = pts[(i + 1) % 3]
                if az == bz:
                    continue
                if (az <= y < bz) or (bz <= y < az):
                    hits.append(ax + (y - az) * (bx - ax) / (bz - az))
            if len(hits) < 2:
                continue
            hits.sort()
            for k in range(0, len(hits) - 1, 2):
                c0 = int(hits[k] + 0.5)
                c1 = int(hits[k + 1] + 0.5)
                if c1 < 0 or c0 > self.n:
                    continue
                for col in range(max(c0, 0), min(c1, self.n)):
                    self._set(col, row)

    def dilate(self):
        """Grow by one pixel so the player collides with the wall face rather
        than its interior, and so hairline gaps between adjacent footprints seal.

        Each row is a whole number of bytes (n is a multiple of 8), so a row can
        be treated as a single Python big integer and dilated with shifts. That
        is far quicker than visiting a million pixels in a Python loop.
        """
        n = self.n
        stride = n // 8
        full = (1 << n) - 1
        rows = [int.from_bytes(self.bits[r * stride:(r + 1) * stride], "little")
                for r in range(n)]
        buf = bytearray()
        filled = 0
        for r in range(n):
            cur = rows[r]
            up = rows[r - 1] if r > 0 else 0
            dn = rows[r + 1] if r < n - 1 else 0
            d = (cur | (cur << 1) | (cur >> 1) | up | dn) & full
            buf += d.to_bytes(stride, "little")
            filled += bin(d).count("1")
        self.bits = buf
        self.filled = filled

    def to_bytes(self):
        out = bytearray(b"BTC1")
        out += struct.pack("<2f", self.min_x, self.min_z)
        out += struct.pack("<H", self.n)
        out += struct.pack("<f", self.res)
        out += self.bits
        return bytes(out)
