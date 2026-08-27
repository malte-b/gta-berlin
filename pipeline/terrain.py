"""Approximate terrain from LoD2 building bases.

Berlin publishes a proper DGM, but we get a usable ground surface for free:
every LoD2 building records the height of its footprint where it meets the
ground. Scattering those samples into a coarse grid and filling the gaps gives
a smooth terrain that is guaranteed to agree with the buildings standing on it
- which matters more for a game than absolute accuracy, because it means no
building ever floats or sinks into the street.

Output (little endian):
    char[4] "BTT1"
    f32     minX, minZ        world position of cell (0,0), metres
    f32     cell              cell size, metres
    u32     nx, nz
    f32     hmin, hscale      height = hmin + u16 * hscale
    u16[nx*nz]
"""
import struct

CELL = 50.0


class Terrain:
    def __init__(self, min_x, min_z, max_x, max_z, cell=CELL):
        self.cell = cell
        self.min_x = min_x
        self.min_z = min_z
        self.nx = max(1, int((max_x - min_x) / cell) + 1)
        self.nz = max(1, int((max_z - min_z) / cell) + 1)
        n = self.nx * self.nz
        self._sum = [0.0] * n
        self._cnt = [0] * n
        self.h = None

    def add(self, x, z, y):
        i = int((x - self.min_x) / self.cell)
        j = int((z - self.min_z) / self.cell)
        if 0 <= i < self.nx and 0 <= j < self.nz:
            k = j * self.nx + i
            self._sum[k] += y
            self._cnt[k] += 1

    def solve(self, fill_passes=64, smooth_passes=3):
        nx, nz = self.nx, self.nz
        h = [None] * (nx * nz)
        for k in range(nx * nz):
            if self._cnt[k]:
                h[k] = self._sum[k] / self._cnt[k]

        known = sum(1 for v in h if v is not None)
        if known == 0:
            self.h = [0.0] * (nx * nz)
            return self
        # flood the gaps outward from known cells
        for _ in range(fill_passes):
            missing = [k for k, v in enumerate(h) if v is None]
            if not missing:
                break
            new = {}
            for k in missing:
                i, j = k % nx, k // nx
                acc = 0.0
                c = 0
                for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1),
                               (1, 1), (1, -1), (-1, 1), (-1, -1)):
                    ii, jj = i + di, j + dj
                    if 0 <= ii < nx and 0 <= jj < nz:
                        v = h[jj * nx + ii]
                        if v is not None:
                            acc += v
                            c += 1
                if c:
                    new[k] = acc / c
            if not new:
                break
            for k, v in new.items():
                h[k] = v
        mean = sum(v for v in h if v is not None) / max(1, sum(1 for v in h if v is not None))
        h = [mean if v is None else v for v in h]

        # gentle box blur so streets do not step between cells
        for _ in range(smooth_passes):
            out = h[:]
            for j in range(nz):
                for i in range(nx):
                    acc = 0.0
                    c = 0
                    for dj in (-1, 0, 1):
                        for di in (-1, 0, 1):
                            ii, jj = i + di, j + dj
                            if 0 <= ii < nx and 0 <= jj < nz:
                                acc += h[jj * nx + ii]
                                c += 1
                    out[j * nx + i] = acc / c
            h = out
        self.h = h
        return self

    def height(self, x, z):
        """Bilinear sample, in world metres."""
        if self.h is None:
            return 0.0
        # samples were binned per cell, so a cell's value belongs at its
        # centre; shift by half a cell before interpolating
        fx = (x - self.min_x) / self.cell - 0.5
        fz = (z - self.min_z) / self.cell - 0.5
        i = int(fx) if fx >= 0 else -1
        j = int(fz) if fz >= 0 else -1
        tx = fx - i
        tz = fz - j
        i = min(max(i, 0), self.nx - 1)
        j = min(max(j, 0), self.nz - 1)
        i1 = min(i + 1, self.nx - 1)
        j1 = min(j + 1, self.nz - 1)
        h = self.h
        a = h[j * self.nx + i]
        b = h[j * self.nx + i1]
        c = h[j1 * self.nx + i]
        d = h[j1 * self.nx + i1]
        return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz

    def to_bytes(self):
        hmin = min(self.h)
        hmax = max(self.h)
        span = hmax - hmin
        scale = span / 65535 if span > 1e-9 else 1.0
        out = bytearray(b"BTT1")
        out += struct.pack("<3f", self.min_x, self.min_z, self.cell)
        out += struct.pack("<2I", self.nx, self.nz)
        out += struct.pack("<2f", hmin, scale)
        inv = 1.0 / scale
        buf = bytearray(len(self.h) * 2)
        for k, v in enumerate(self.h):
            q = int((v - hmin) * inv + 0.5)
            q = 0 if q < 0 else (65535 if q > 65535 else q)
            buf[k * 2] = q & 0xFF
            buf[k * 2 + 1] = (q >> 8) & 0xFF
        out += buf
        return bytes(out), {"minX": self.min_x, "minZ": self.min_z, "cell": self.cell,
                            "nx": self.nx, "nz": self.nz,
                            "hmin": round(hmin, 3), "hmax": round(hmax, 3)}


def load(path):
    """Read a terrain.bin back into an object exposing .height(x, z)."""
    import struct as _s
    raw = open(path, "rb").read()
    if raw[:4] != b"BTT1":
        raise ValueError("not a terrain file: %s" % path)
    min_x, min_z, cell = _s.unpack_from("<3f", raw, 4)
    nx, nz = _s.unpack_from("<2I", raw, 16)
    hmin, scale = _s.unpack_from("<2f", raw, 24)
    t = Terrain.__new__(Terrain)
    t.cell, t.min_x, t.min_z, t.nx, t.nz = cell, min_x, min_z, nx, nz
    vals = _s.unpack_from("<%dH" % (nx * nz), raw, 32)
    t.h = [hmin + v * scale for v in vals]
    return t
