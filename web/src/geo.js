/* WGS84 -> EPSG:25833 (ETRS89 / UTM 33N), mirroring pipeline/geo.py so the
   client can place known landmarks without another round trip. */

const A = 6378137.0;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const LON0 = (15 * Math.PI) / 180;
const FE = 500000;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);

export function utm33(lon, lat) {
  const p = (lat * Math.PI) / 180;
  const dl = (lon * Math.PI) / 180 - LON0;
  const sn = Math.sin(p), cs = Math.cos(p), t = Math.tan(p);
  const n = A / Math.sqrt(1 - E2 * sn * sn);
  const tt = t * t;
  const cc = EP2 * cs * cs;
  const a = cs * dl;
  const a2 = a * a, a3 = a2 * a, a4 = a3 * a, a5 = a4 * a, a6 = a5 * a;
  const m = A * ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * p
    - (3 * E2 / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * p)
    + ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * p)
    - ((35 * E2 ** 3) / 3072) * Math.sin(6 * p));
  const e = FE + K0 * n * (a + ((1 - tt + cc) * a3) / 6
    + ((5 - 18 * tt + tt * tt + 72 * cc - 58 * EP2) * a5) / 120);
  const nn = K0 * (m + n * t * (a2 / 2 + ((5 - tt + 9 * cc + 4 * cc * cc) * a4) / 24
    + ((61 - 58 * tt + tt * tt + 600 * cc - 330 * EP2) * a6) / 720));
  return [e, nn];
}

export function makeToWorld(origin) {
  return (lon, lat) => {
    const [e, n] = utm33(lon, lat);
    return [e - origin.e, -(n - origin.n)];
  };
}

export function utm33inv(e, n) {
  const x = e - FE;
  const y = n;
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const m = y / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const p = mu + (3 * e1 / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);
  const sp = Math.sin(p), cp = Math.cos(p), tp = Math.tan(p);
  const c1 = EP2 * cp * cp;
  const t1 = tp * tp;
  const n1 = A / Math.sqrt(1 - E2 * sp * sp);
  const r1 = (A * (1 - E2)) / (1 - E2 * sp * sp) ** 1.5;
  const d = x / (n1 * K0);
  const d2 = d * d, d3 = d2 * d, d4 = d3 * d, d5 = d4 * d, d6 = d5 * d;
  const lat = p - ((n1 * tp) / r1) * (d2 / 2
    - ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d4) / 24
    + ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d6) / 720);
  const lon = LON0 + (d - ((1 + 2 * t1 + c1) * d3) / 6
    + ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d5) / 120) / cp;
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

/** World metres -> WGS84 lon/lat, for the on-screen position readout. */
export function makeFromWorld(origin) {
  return (x, z) => utm33inv(x + origin.e, -z + origin.n);
}
