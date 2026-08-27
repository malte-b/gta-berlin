"""Coordinate handling for the Berlin game world.

Berlin's open geodata is published in EPSG:25833 (ETRS89 / UTM zone 33N),
which is already metric, so the game world is just a translation of it:

    world.x =  (E - ORIGIN_E)
    world.z = -(N - ORIGIN_N)     # flip so -Z is north, matching three.js
    world.y =  (h - ORIGIN_H)     # metres above sea level

That means no reprojection is needed for the building data at all. Only
OpenStreetMap (WGS84 lon/lat) has to be projected, which is what utm33()
below is for.
"""
import math

# --- EPSG:25833 constants (ETRS89 ~ WGS84 at this precision) --------------
_A = 6378137.0
_F = 1.0 / 298.257223563
_K0 = 0.9996
_LON0 = math.radians(15.0)   # central meridian of UTM zone 33
_FE = 500000.0
_FN = 0.0
_E2 = _F * (2 - _F)
_EP2 = _E2 / (1 - _E2)

# World origin: Brandenburger Tor. Everything in the game is metres from here.
ORIGIN_E = 389_500.0
ORIGIN_N = 5_819_500.0
ORIGIN_H = 34.0          # ~ground level in Mitte, so streets sit near y=0

TILE = 1000.0            # LoD2 tiles are 1x1 km, and so are our game tiles


def utm33(lon, lat):
    """WGS84 lon/lat (degrees) -> EPSG:25833 easting/northing (metres)."""
    lat = math.radians(lat)
    dlon = math.radians(lon) - _LON0
    sn, cs = math.sin(lat), math.cos(lat)
    t = math.tan(lat)
    n = _A / math.sqrt(1 - _E2 * sn * sn)
    tt = t * t
    cc = _EP2 * cs * cs
    a = cs * dlon
    a2, a3, a4, a5, a6 = a * a, a**3, a**4, a**5, a**6
    # meridian arc
    m = _A * ((1 - _E2 / 4 - 3 * _E2**2 / 64 - 5 * _E2**3 / 256) * lat
              - (3 * _E2 / 8 + 3 * _E2**2 / 32 + 45 * _E2**3 / 1024) * math.sin(2 * lat)
              + (15 * _E2**2 / 256 + 45 * _E2**3 / 1024) * math.sin(4 * lat)
              - (35 * _E2**3 / 3072) * math.sin(6 * lat))
    e = _FE + _K0 * n * (a + (1 - tt + cc) * a3 / 6
                         + (5 - 18 * tt + tt * tt + 72 * cc - 58 * _EP2) * a5 / 120)
    nn = _FN + _K0 * (m + n * t * (a2 / 2 + (5 - tt + 9 * cc + 4 * cc * cc) * a4 / 24
                      + (61 - 58 * tt + tt * tt + 600 * cc - 330 * _EP2) * a6 / 720))
    return e, nn


def utm33_inv(e, n):
    """EPSG:25833 -> WGS84 lon/lat (degrees). Used for the minimap / HUD."""
    x = e - _FE
    y = n - _FN
    e1 = (1 - math.sqrt(1 - _E2)) / (1 + math.sqrt(1 - _E2))
    m = y / _K0
    mu = m / (_A * (1 - _E2 / 4 - 3 * _E2**2 / 64 - 5 * _E2**3 / 256))
    p = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
         + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
         + (151 * e1**3 / 96) * math.sin(6 * mu))
    sp, cp = math.sin(p), math.cos(p)
    tp = math.tan(p)
    c1 = _EP2 * cp * cp
    t1 = tp * tp
    n1 = _A / math.sqrt(1 - _E2 * sp * sp)
    r1 = _A * (1 - _E2) / (1 - _E2 * sp * sp) ** 1.5
    d = x / (n1 * _K0)
    d2, d3, d4, d5, d6 = d * d, d**3, d**4, d**5, d**6
    lat = p - (n1 * tp / r1) * (d2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * _EP2) * d4 / 24
                                + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * _EP2 - 3 * c1 * c1) * d6 / 720)
    lon = _LON0 + (d - (1 + 2 * t1 + c1) * d3 / 6
                   + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * _EP2 + 24 * t1 * t1) * d5 / 120) / cp
    return math.degrees(lon), math.degrees(lat)


def to_world(e, n, h=0.0):
    return (e - ORIGIN_E, h - ORIGIN_H, -(n - ORIGIN_N))


def tile_of_world(x, z):
    """Game tile index (matches the LoD2 km grid) for a world position."""
    e = x + ORIGIN_E
    n = -z + ORIGIN_N
    return int(math.floor(e / TILE)), int(math.floor(n / TILE))
