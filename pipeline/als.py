"""Bare-earth terrain from Berlin's airborne laser scan (ALS).

Source: Airborne Laserscanning (ALS) - Primaere 3D Laserscan-Daten,
Senatsverwaltung fuer Stadtentwicklung, Bauen und Wohnen Berlin,
https://gdi.berlin.de/data/a_als/atom  -- dl-de/zero-2.0

The scan is a classified point cloud, ~10 points/m2, published as one LAS
file per 1 x 1 km tile. The awkward part is the packaging: the tiles are only
offered inside nine regional zip archives of 1-50 GB each. The server answers
HTTP range requests, though, so nothing here downloads an archive. The zip's
central directory is read from the end of the file, and then each wanted tile
is fetched as a single byte range, inflated as it streams in, and reduced to a
1 m grid on the fly. Only that grid is cached; the raw points never touch
disk.

Only class 2 (ground) is used. Everything standing on the ground - buildings,
trees, cars - comes from other sources, so the terrain must be bare earth.
Under buildings there are no ground returns at all; those holes are filled
afterwards from the surrounding ground (see fill_holes).
"""
import io
import json
import math
import os
import struct
import subprocess
import time
import zipfile
import zlib

ATOM = "https://gdi.berlin.de/data/a_als/atom/"
REGIONS = ("Mitte", "Nord", "Nordost", "Nordwest", "Ost",
           "Sued", "Suedost", "Suedwest", "West")
GROUND = 2
# Berlin's scan has no building class. Besides ground (2) and noise (7, 18)
# it only sorts points into "vegetation" 3/4/5 by height above ground, so
# roofs land in 5 alongside tree crowns. The top grid is therefore simply the
# highest non-ground, non-noise return per cell; over a building outline its
# median is the roof, with the odd overhanging crown too few to move it.
NOT_BUILT = {GROUND, 7, 18}
CELL = 1.0
TILE = 1000                     # ALS tiles are 1 x 1 km, named by km
NODATA = float("nan")


def log(m):
    print(m, flush=True)


def _curl(args, timeout=60):
    # curl rather than urllib - see fetch.py for why
    return subprocess.run(["curl", "-sS", "--fail", "--max-time", str(timeout),
                           "-A", "gta-berlin/0.1 (open data pipeline)"] + args,
                          capture_output=True, check=True).stdout


class _RangeFile(io.RawIOBase):
    """Just enough of a seekable file over HTTP for zipfile to read the
    central directory. Each read is one range request, which is fine for the
    handful zipfile makes there, and hopeless for member data - that is
    streamed separately by fetch_tile()."""

    def __init__(self, url):
        self.url = url
        self.pos = 0
        head = subprocess.run(["curl", "-sSIL", "--max-time", "60", url],
                              capture_output=True, text=True).stdout
        sizes = [int(l.split(":", 1)[1]) for l in head.lower().splitlines()
                 if l.startswith("content-length")]
        if not sizes:
            raise IOError("no content-length for " + url)
        self.size = sizes[-1]

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else (self.pos + off if whence == 1 else self.size + off)
        return self.pos

    def read(self, n=-1):
        # An inverted range is not an error to the server: it answers with the
        # whole archive, which here is tens of gigabytes. Never send one.
        if n is None or n < 0:
            n = self.size - self.pos
        if n <= 0 or self.pos >= self.size:
            return b""
        end = min(self.size, self.pos + n) - 1
        data = _curl(["-r", "%d-%d" % (self.pos, end), self.url], timeout=600)
        self.pos += len(data)
        return data

    def readinto(self, b):
        d = self.read(len(b))
        b[:len(d)] = d
        return len(d)


def index(cache_dir):
    """{tile "E_N": {region, offset, csize, usize, method}} for all of Berlin.

    Reading nine central directories takes a few minutes, so the result is
    cached; it only changes when the survey is republished."""
    path = os.path.join(cache_dir, "als_index.json")
    if os.path.exists(path):
        return json.load(open(path))
    out = {}
    for region in REGIONS:
        url = ATOM + region + ".zip"
        z = zipfile.ZipFile(io.BufferedReader(_RangeFile(url), buffer_size=1 << 16))
        for zi in z.infolist():
            # 3dm_33_389_5816_1_be.las  ->  389_5816
            parts = zi.filename.split("_")
            if len(parts) < 4 or not zi.filename.lower().endswith((".las", ".laz")):
                continue
            out["%s_%s" % (parts[2], parts[3])] = {
                "region": region, "name": zi.filename, "offset": zi.header_offset,
                "csize": zi.compress_size, "usize": zi.file_size,
                "method": zi.compress_type}
        log("    %-9s %4d tiles" % (region, len(z.infolist())))
    os.makedirs(cache_dir, exist_ok=True)
    with open(path, "w") as fh:
        json.dump(out, fh)
    return out


class _Deflate64:
    """zlib-like face for inflate64, which has no flush()."""

    def __init__(self):
        import inflate64
        self._inf = inflate64.Inflater()

    def decompress(self, data):
        return self._inf.inflate(data)

    def flush(self):
        return b""


def _decompressor(entry):
    """For a zip member's compression method: Deflate (8) for most regions,
    Deflate64 (9) for Suedost.zip, which the standard library cannot read."""
    method = entry["method"]
    if method == 8:
        return zlib.decompressobj(-15)
    if method == 9:
        try:
            return _Deflate64()
        except ImportError:
            raise IOError("%s is Deflate64-compressed; it needs the inflate64 package "
                          "(uv venv && uv pip install -r pipeline/requirements.txt, "
                          "then run with .venv/bin/python)" % entry["name"]) from None
    if method == 0:
        return None
    raise IOError("unsupported zip compression %d for %s" % (method, entry["name"]))


def _member_stream(entry):
    """Yield the decompressed bytes of one zip member, streamed via curl."""
    url = ATOM + entry["region"] + ".zip"
    off = entry["offset"]
    # the local header's extra field can differ from the central directory's,
    # so read it rather than assume
    lh = _curl(["-r", "%d-%d" % (off, off + 29), url])
    if lh[:4] != b"PK\x03\x04":
        raise IOError("bad local header for " + entry["name"])
    nlen, xlen = struct.unpack_from("<HH", lh, 26)
    start = off + 30 + nlen + xlen
    end = start + entry["csize"] - 1
    # The server now and then stops sending on a long transfer without
    # closing it; --speed-limit turns that silence into an error to retry.
    p = subprocess.Popen(["curl", "-sS", "--fail", "--max-time", "3600",
                          "--speed-limit", "10000", "--speed-time", "60",
                          "-r", "%d-%d" % (start, end), url],
                         stdout=subprocess.PIPE)
    inflate = _decompressor(entry)
    try:
        while True:
            chunk = p.stdout.read(1 << 22)
            if not chunk:
                break
            yield inflate.decompress(chunk) if inflate else chunk
        if inflate:
            yield inflate.flush()
    finally:
        p.stdout.close()
        if p.wait() != 0:
            raise IOError("download failed for " + entry["name"])


def _grids(stream, e0, n0):
    """Per 1 m cell over one km tile: the mean height of ground returns, and
    the highest return from anything standing on it (see NOT_BUILT).

    Returns (sum, count, top) as flat lists, row 0 at the *north* edge so the
    grids read like the game world (z grows southward)."""
    n = TILE * TILE
    acc = [0.0] * n
    cnt = [0] * n
    top = [-1e9] * n
    buf = b""
    hdr = None
    rec = fmt = None
    remaining = 0
    to_skip = 0
    for chunk in stream:
        buf += chunk
        if hdr is None:
            if len(buf) < 375:
                continue
            if buf[:4] != b"LASF":
                raise IOError("not a LAS file")
            data_off, = struct.unpack_from("<I", buf, 96)
            pfmt = buf[104] & 0x3F
            rec, = struct.unpack_from("<H", buf, 105)
            legacy, = struct.unpack_from("<I", buf, 107)
            sx, sy, sz = struct.unpack_from("<3d", buf, 131)
            ox, oy, oz = struct.unpack_from("<3d", buf, 155)
            count = legacy
            if not count and len(buf) >= 255:
                count, = struct.unpack_from("<Q", buf, 247)
            # LAS 1.4 point formats 6-10 carry a whole byte of class at 16;
            # the legacy formats pack it into the low five bits of byte 15
            cls_at = 16 if pfmt >= 6 else 15
            fmt = struct.Struct("<iii%dxB%dx" % (cls_at - 12, rec - cls_at - 1))
            hdr = (sx, sy, sz, ox, oy, oz, pfmt)
            remaining = count
            to_skip = data_off
        if to_skip:
            k = min(to_skip, len(buf))
            buf = buf[k:]
            to_skip -= k
            if to_skip:
                continue
        usable = (len(buf) // rec) * rec
        if usable == 0:
            continue
        usable = min(usable, remaining * rec)
        sx, sy, sz, ox, oy, oz, pfmt = hdr
        legacy_cls = pfmt < 6
        # fold the scale/offset into the cell lookup, so the hot loop is
        # integer arithmetic plus one float for z
        for x, y, z, c in fmt.iter_unpack(buf[:usable]):
            if legacy_cls:
                c &= 31
            ground = c == GROUND
            if not ground and c in NOT_BUILT:
                continue
            col = int(x * sx + ox - e0)
            row = TILE - 1 - int(y * sy + oy - n0)
            if 0 <= col < TILE and 0 <= row < TILE:
                k = row * TILE + col
                h = z * sz + oz
                if ground:
                    acc[k] += h
                    cnt[k] += 1
                elif h > top[k]:
                    top[k] = h
        remaining -= usable // rec
        buf = buf[usable:]
        if remaining <= 0:
            break
    return acc, cnt, top


def _cache_path(cache_dir, kind, key):
    return os.path.join(cache_dir, "als_%s_%s.bin" % (kind, key))


def tile_grid(key, entry, cache_dir, kind="ground"):
    """Cached 1 m grid for one ALS tile, north-up rows, NaN where the scan
    has no return of that kind. kind "ground" is the bare earth, "top" the
    highest surface above it (roofs, crowns). One streaming pass caches both."""
    path = _cache_path(cache_dir, kind, key)
    if not os.path.exists(path):
        # parallel tile builds share neighbouring km tiles: stream each once
        import fetch
        with fetch.file_lock(path + ".lock"):
            # a 250 MB download now and then drops its connection: try again
            for attempt in range(4):
                if os.path.exists(path):
                    break
                try:
                    _stream_tile(key, entry, cache_dir)
                except IOError as err:
                    if attempt == 3:
                        raise
                    log("    ALS %s: %s, retrying" % (key, err))
                    time.sleep(30 * (attempt + 1))
    raw = open(path, "rb").read()
    return list(struct.unpack("<%df" % (TILE * TILE), raw))


def _stream_tile(key, entry, cache_dir):
    e0 = int(key.split("_")[0]) * TILE
    n0 = int(key.split("_")[1]) * TILE
    acc, cnt, top = _grids(_member_stream(entry), e0, n0)
    grids = {
        "ground": [acc[k] / cnt[k] if cnt[k] else NODATA for k in range(TILE * TILE)],
        "top": [t if t > -1e8 else NODATA for t in top],
    }
    os.makedirs(cache_dir, exist_ok=True)
    for name, g in grids.items():
        out = _cache_path(cache_dir, name, key)
        with open(out + ".part", "wb") as fh:
            fh.write(struct.pack("<%df" % len(g), *g))
        os.replace(out + ".part", out)


def fill_holes(h, nx, nz):
    """Fill NaN cells (building footprints, water) from surrounding ground.

    A mean pyramid: halve the grid repeatedly, averaging only known cells,
    until nothing is missing, then walk back up filling each level's holes
    from the coarser one. Unlike flooding a cell at a time this is linear in
    the grid size, and it degrades gracefully - a courtyard gets the height of
    its own walls' feet, a large block the average of the streets around it.
    """
    levels = [(h[:], nx, nz)]
    while True:
        g, w, d = levels[-1]
        if not any(v != v for v in g) or (w == 1 and d == 1):
            break
        w2, d2 = (w + 1) // 2, (d + 1) // 2
        g2 = [NODATA] * (w2 * d2)
        for r in range(d2):
            for c in range(w2):
                s = 0.0
                k = 0
                for rr in (2 * r, 2 * r + 1):
                    if rr >= d:
                        continue
                    for cc in (2 * c, 2 * c + 1):
                        if cc >= w:
                            continue
                        v = g[rr * w + cc]
                        if v == v:
                            s += v
                            k += 1
                if k:
                    g2[r * w2 + c] = s / k
        levels.append((g2, w2, d2))
    for i in range(len(levels) - 2, -1, -1):
        g, w, d = levels[i]
        up, w2, _d2 = levels[i + 1]
        for r in range(d):
            base = r * w
            for c in range(w):
                if g[base + c] != g[base + c]:
                    g[base + c] = up[(r // 2) * w2 + (c // 2)]
    out = levels[0][0]
    # whole-grid fallback if the area had no ground returns at all
    return [0.0 if v != v else v for v in out]


def smooth_filled(h, known, nx, nz, passes=6):
    """Relax only the filled cells toward their neighbours, so the pyramid's
    blockiness under large buildings becomes a smooth surface while every
    measured cell keeps its surveyed value."""
    for _ in range(passes):
        out = h[:]
        for r in range(nz):
            for c in range(nx):
                k = r * nx + c
                if known[k]:
                    continue
                s = 0.0
                m = 0
                if c > 0: s += h[k - 1]; m += 1
                if c < nx - 1: s += h[k + 1]; m += 1
                if r > 0: s += h[k - nx]; m += 1
                if r < nz - 1: s += h[k + nx]; m += 1
                out[k] = s / m
        h = out
    return h


def _window(e0, n0, e1, n1, cache_dir, kind):
    """One grid kind over [e0,e1) x [n0,n1) at 1 m, north-up rows, NaN gaps."""
    idx = index(cache_dir)
    nx = int(e1 - e0)
    nz = int(n1 - n0)
    h = [NODATA] * (nx * nz)
    for te in range(int(math.floor(e0 / TILE)), int(math.ceil(e1 / TILE))):
        for tn in range(int(math.floor(n0 / TILE)), int(math.ceil(n1 / TILE))):
            key = "%d_%d" % (te, tn)
            entry = idx.get(key)
            if entry is None:
                log("    ALS %s: not in any archive" % key)
                continue
            cached = os.path.exists(_cache_path(cache_dir, kind, key))
            if not cached:
                log("    ALS %s: streaming %.0f MB from %s.zip ..."
                    % (key, entry["csize"] / 1048576, entry["region"]))
            g = tile_grid(key, entry, cache_dir, kind)
            got = sum(1 for v in g if v == v)
            log("    ALS %s: %.0f%% of cells have %s returns%s"
                % (key, 100.0 * got / len(g), kind, " (cached)" if cached else ""))
            # copy the overlap of this km tile into the output window
            te0, tn1 = te * TILE, (tn + 1) * TILE
            for r in range(nz):
                n = n1 - 1 - r                      # northing of this output row
                tr = tn1 - 1 - n
                if not 0 <= tr < TILE:
                    continue
                for c in range(nx):
                    tc = int(e0 + c - te0)
                    if 0 <= tc < TILE:
                        h[r * nx + c] = g[tr * TILE + tc]
    return h, nx, nz


PIT_RADIUS = 8      # metres; depressions narrower than ~2x this are filled - U-Bahn entrances need ~16 m


def close_pits(h, nx, nz, radius=PIT_RADIUS):
    """Fill narrow depressions in the measured ground.

    The scan is right that the ground drops into U-Bahn stairwells, garage
    ramps and basement light wells - it measures them as ground. For a game
    they are holes: and worse, they are usually next to a building, so the
    hole filling under that building averages them in and a 4 m stair opening
    becomes a 20 m crater with the building sunk at its bottom.

    A grey-scale closing (max filter, then min filter) raises every cell to
    the lowest level that a window of 2 * radius + 1 metres can rest on, which
    fills any depression narrower than that and leaves wider real dips - a
    sunken square, a cutting - alone. Cells without ground returns are
    ignored and stay unknown. Returns (heights, cells raised)."""
    from navgrid import _filter2d
    LOW, HIGH = -1e9, 1e9
    dil = _filter2d([v if v == v else LOW for v in h], nx, nz, radius, True)
    clo = _filter2d([v if v > LOW / 2 else HIGH for v in dil], nx, nz, radius, False)
    out = h[:]
    raised = 0
    for k, v in enumerate(h):
        if v == v and clo[k] < HIGH / 2 and clo[k] > v + 0.3:
            out[k] = clo[k]
            raised += 1
    return out, raised


def terrain(e0, n0, e1, n1, cache_dir, clear=None, settle=None):
    """Bare-earth heights over [e0,e1) x [n0,n1) at 1 m, north-up rows.
    clear(h, nx, nz), if given, may blank returns before holes are filled
    (bridges.clearer: decks the scanner took for ground); settle(h, nx, nz)
    may adjust the filled result (keep it under the decks).

    Returns (heights, nx, nz, known_fraction, cells raised by close_pits)."""
    h, nx, nz = _window(e0, n0, e1, n1, cache_dir, "ground")
    h, raised = close_pits(h, nx, nz)
    if clear:
        clear(h, nx, nz)
    known = [v == v for v in h]
    frac = sum(known) / len(known)
    h = fill_holes(h, nx, nz)
    h = smooth_filled(h, known, nx, nz)
    if settle:
        settle(h, nx, nz)
    return h, nx, nz, frac, raised


def roofs(e0, n0, e1, n1, cache_dir):
    """Highest non-ground return per 1 m cell (NaN where there was none),
    same window and row order as terrain(). Subtracting the terrain gives the
    height of whatever stands there - which OSM often does not record."""
    h, _nx, _nz = _window(e0, n0, e1, n1, cache_dir, "top")
    return h
