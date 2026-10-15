"""True orthophotos for the ground and the roofs.

Source: Digitale farbige TrueOrthophotos 2024 (DOP20RGBI), Senatsverwaltung
fuer Stadtentwicklung, Bauen und Wohnen Berlin, via WMS
https://gdi.berlin.de/services/wms/truedop_2024  -- dl-de/zero-2.0

"True" means every pixel is projected straight down, buildings included:
roofs sit exactly on their footprints (+-0.4 m) instead of leaning away from
the camera, so the photo can be draped on the terrain and on roofs alike.

The download feed only offers multi-GB zips of JPEG2000, which the standard
library cannot decode; the WMS hands out georeferenced JPEGs for any box, so
the area is fetched in pieces that match the game's terrain chunks:

    ortho/o_<i>_<j>.jpg    100 m at 0.2 m (500 px), i east, j south from the
                           north-west corner - one per terrain mesh
    ortho/overview.jpg     the whole area at 0.5 m, for roofs and the map
"""
import concurrent.futures as cf
import os
import time

import fetch

WMS = "https://gdi.berlin.de/services/wms/truedop_2024"
LAYER = "truedop_2024"
CHUNK = 100                 # metres, matches TERRAIN_CHUNK in web/src/world.ts
RES = 0.2                   # the survey's own ground resolution
OVERVIEW_RES = 0.5


def _getmap(e0, n0, e1, n1, w, h):
    url = ("%s?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=%s&STYLES="
           "&CRS=EPSG:25833&BBOX=%.2f,%.2f,%.2f,%.2f&WIDTH=%d&HEIGHT=%d"
           "&FORMAT=image/jpeg" % (WMS, LAYER, e0, n0, e1, n1, w, h))
    for attempt in range(5):
        data = fetch.get(url, timeout=300, retries=3)
        if data[:2] == b"\xff\xd8":
            return data
        # WMS errors come back as XML with a 200 status; under load the
        # server refuses now and then and serves the same box moments later
        time.sleep(10 * (attempt + 1))
    raise fetch.FetchError("not a JPEG: %r" % data[-600:])


def build(e0, n0, e1, n1, x0, z0, out_dir, cache_dir):
    """Fetch (or reuse) every tile. Returns manifest metadata."""
    os.makedirs(os.path.join(out_dir, "ortho"), exist_ok=True)
    os.makedirs(cache_dir, exist_ok=True)
    ni = int((e1 - e0 + CHUNK - 1) // CHUNK)
    nj = int((n1 - n0 + CHUNK - 1) // CHUNK)
    px = int(round(CHUNK / RES))

    def tile(ij):
        i, j = ij
        key = "dop_%d_%d_%d.jpg" % (e0 + i * CHUNK, n1 - (j + 1) * CHUNK, px)
        cached = os.path.join(cache_dir, key)
        if not os.path.exists(cached):
            data = _getmap(e0 + i * CHUNK, n1 - (j + 1) * CHUNK,
                           e0 + (i + 1) * CHUNK, n1 - j * CHUNK, px, px)
            with open(cached + ".part", "wb") as fh:
                fh.write(data)
            os.replace(cached + ".part", cached)
        out = os.path.join(out_dir, "ortho", "o_%d_%d.jpg" % (i, j))
        with open(cached, "rb") as src, open(out, "wb") as dst:
            dst.write(src.read())
        return os.path.getsize(out)

    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        total = sum(ex.map(tile, [(i, j) for j in range(nj) for i in range(ni)]))

    ow = int(round((e1 - e0) / OVERVIEW_RES))
    oh = int(round((n1 - n0) / OVERVIEW_RES))
    ov_cache = os.path.join(cache_dir, "dop_overview_%d_%d_%d_%d_%d.jpg" % (e0, n0, e1, n1, ow))
    if not os.path.exists(ov_cache):
        with open(ov_cache, "wb") as fh:
            fh.write(_getmap(e0, n0, e1, n1, ow, oh))
    with open(ov_cache, "rb") as src, open(os.path.join(out_dir, "ortho", "overview.jpg"), "wb") as dst:
        dst.write(src.read())

    return {
        "chunk": CHUNK, "res": RES, "nx": ni, "nz": nj,
        "minX": x0, "minZ": z0, "tile": "ortho/o_{i}_{j}.jpg",
        "overview": {"file": "ortho/overview.jpg", "res": OVERVIEW_RES, "w": ow, "h": oh},
        "bytes": total,
    }
