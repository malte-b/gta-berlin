import { utm33, type Origin } from './geo';

/**
 * Point layers: datasets shown as labelled markers in the city.
 *
 * Two sources, one shape:
 *  - baked by pipeline/build_layers.py from Berlin's WFS services into
 *    data/layers/, already in world metres;
 *  - a GeoJSON or CSV file dropped onto the page. It is read and converted
 *    here, in the browser, and never sent anywhere.
 *
 * GeoJSON may be WGS84 lon/lat (the standard), Berlin's own EPSG:25833 or
 * Web Mercator; the coordinates themselves give away which. CSV needs either
 * lat/lon columns or x/y in EPSG:25833, comma or semicolon separated, with
 * German decimal commas allowed. Lines and areas are placed at their centre.
 */

export interface LayerPoint { x: number; z: number; n: string; d: string }

export interface PointLayer {
  id: string;
  name: string;
  colour: string;
  points: LayerPoint[];
  on: boolean;
  /** Baked layers came with the game; uploads can be removed again. */
  uploaded: boolean;
  attribution?: string;
}

const DATA = 'data/';
const UPLOAD_COLOURS = ['#f687b3', '#9f7aea', '#68d391', '#fc8181', '#63b3ed', '#faf089'];
const LABEL_KEYS = ['name', 'bezeichnung', 'titel', 'title', 'label', 'standort',
                    'schulname', 'einrichtung', 'adresse', 'address'];
const DETAIL_KEYS = ['beschreibung', 'description', 'typ', 'type', 'art', 'kategorie',
                     'category', 'oeffnungszeiten', 'opening_hours'];

/** The layers that came with the build. Empty if there are none. */
export async function loadBaked(): Promise<PointLayer[]> {
  try {
    const res = await fetch(DATA + 'layers/index.json');
    if (!res.ok) return [];
    const index = await res.json() as { layers: { id: string; name: string; colour: string;
                                                  file: string; attribution?: string }[] };
    return await Promise.all(index.layers.map(async (l) => {
      const data = await fetch(DATA + l.file).then((r) => r.json()) as
        { points: [number, number, string, string][] };
      return {
        id: l.id, name: l.name, colour: l.colour, on: true, uploaded: false,
        attribution: l.attribution,
        points: data.points.map(([x, z, n, d]) => ({ x, z, n, d })),
      };
    }));
  } catch {
    return [];
  }
}

let uploads = 0;

/** Points further than this from the world origin cannot be Berlin. */
const REACH = 60_000;

/** A dropped or picked file as a point layer, and how many of its points lay
 *  too far from Berlin to keep. Throws with a readable reason. */
export async function parseUpload(file: File, origin: Origin):
    Promise<{ layer: PointLayer; outside: number }> {
  const text = await file.text();
  const base = file.name.replace(/\.[^.]+$/, '');
  const csv = /\.(csv|tsv|txt)$/i.test(file.name);
  const all = csv ? fromCsv(text, origin, base) : fromGeoJson(text, origin, base);
  if (!all.length) throw new Error('no usable points');
  // a wrong guess about columns or coordinate system lands points far away
  const points = all.filter((p) => Math.hypot(p.x, p.z) < REACH);
  if (!points.length) {
    throw new Error(`none of its ${all.length} points is near Berlin - check the coordinate columns`);
  }
  return {
    layer: {
      id: `upload-${++uploads}`, name: base, colour: UPLOAD_COLOURS[(uploads - 1) % UPLOAD_COLOURS.length],
      points, on: true, uploaded: true,
    },
    outside: all.length - points.length,
  };
}

/* --- coordinates ------------------------------------------------------------ */

type Crs = 'wgs84' | 'utm33' | 'mercator';

/** Which system a coordinate pair is in, judged by where Berlin would be. */
function guessCrs(x: number, y: number): Crs | null {
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return 'wgs84';
  if (x > 200_000 && x < 800_000 && y > 5_000_000 && y < 6_500_000) return 'utm33';
  if (x > 1_000_000 && x < 2_000_000 && y > 6_500_000 && y < 7_500_000) return 'mercator';
  return null;
}

function toWorld(x: number, y: number, crs: Crs, origin: Origin): [number, number] {
  let e = x, n = y;
  if (crs === 'mercator') {
    const lon = (x / 6378137) * (180 / Math.PI);
    const lat = (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * (180 / Math.PI);
    [e, n] = utm33(lon, lat);
  } else if (crs === 'wgs84') {
    [e, n] = utm33(x, y);
  }
  return [e - origin.e, -(n - origin.n)];
}

/* --- GeoJSON ------------------------------------------------------------------- */

type Position = number[];
interface Geometry { type: string; coordinates?: unknown; geometries?: Geometry[] }
interface Feature { geometry: Geometry | null; properties?: Record<string, unknown> | null }

function fromGeoJson(text: string, origin: Origin, fallback: string): LayerPoint[] {
  let doc: { type?: string; features?: Feature[]; crs?: { properties?: { name?: string } } };
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON - expected GeoJSON or a .csv file');
  }
  const feats: Feature[] = doc.type === 'FeatureCollection' ? doc.features ?? []
    : doc.type === 'Feature' ? [doc as Feature] : [];
  if (!feats.length) throw new Error('no features - expected a GeoJSON FeatureCollection');
  const named = doc.crs?.properties?.name ?? '';
  let crs: Crs | null = /25833/.test(named) ? 'utm33' : /3857|900913/.test(named) ? 'mercator' : null;
  const out: LayerPoint[] = [];
  for (const f of feats) {
    const p = centre(f.geometry);
    if (!p) continue;
    crs ??= guessCrs(p[0], p[1]);
    if (!crs) throw new Error(`coordinates like ${p[0]}, ${p[1]} are in no system this reads`
      + ' (WGS84, EPSG:25833, Web Mercator)');
    const [x, z] = toWorld(p[0], p[1], crs, origin);
    const props = f.properties ?? {};
    out.push({ x, z, n: pick(props, LABEL_KEYS, true) || fallback, d: pick(props, DETAIL_KEYS, false) });
  }
  return out;
}

/** A point for any geometry: itself, or the mean of its largest part's vertices. */
function centre(g: Geometry | null): Position | null {
  if (!g) return null;
  const c = g.coordinates as unknown;
  switch (g.type) {
    case 'Point': return c as Position;
    case 'MultiPoint': return (c as Position[])[0] ?? null;
    case 'LineString': return mean(c as Position[]);
    case 'MultiLineString': return mean(largest(c as Position[][]));
    case 'Polygon': return mean((c as Position[][])[0] ?? []);
    case 'MultiPolygon': return mean(largest((c as Position[][][]).map((p) => p[0] ?? [])));
    case 'GeometryCollection': return centre(g.geometries?.[0] ?? null);
    default: return null;
  }
}

function largest(parts: Position[][]): Position[] {
  return parts.reduce((a, b) => (b.length > a.length ? b : a), [] as Position[]);
}

function mean(pts: Position[]): Position | null {
  if (!pts.length) return null;
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}

/** The first property that reads as a label: a known key, else any short text. */
function pick(props: Record<string, unknown>, keys: string[], anyText: boolean): string {
  const lower = new Map(Object.keys(props).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k);
    const v = real !== undefined ? props[real] : undefined;
    if (v !== undefined && v !== null && String(v).trim()) return clean(String(v));
  }
  if (anyText) {
    for (const v of Object.values(props)) {
      if (typeof v === 'string' && v.trim().length >= 2 && v.length <= 60 && !/^https?:/.test(v)) {
        return clean(v);
      }
    }
  }
  return '';
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/* --- CSV --------------------------------------------------------------------- */

const LAT = ['lat', 'latitude', 'breite', 'breitengrad', 'y_wgs84', 'wgs84_lat'];
const LON = ['lon', 'lng', 'long', 'longitude', 'laenge', 'länge', 'laengengrad', 'x_wgs84', 'wgs84_lon'];
const EAST = ['x', 'rechtswert', 'easting', 'utm_x', 'x_25833'];
const NORTH = ['y', 'hochwert', 'northing', 'utm_y', 'y_25833'];

function fromCsv(text: string, origin: Origin, fallback: string): LayerPoint[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('the CSV has no data rows');
  const head = lines[0];
  const sep = [';', '\t', ','].reduce((a, b) => (count(head, b) > count(head, a) ? b : a), ',');
  const cols = splitRow(head, sep).map((c) => c.trim().toLowerCase());
  const find = (names: string[]) => cols.findIndex((c) => names.includes(c));
  let ix = find(LON), iy = find(LAT);
  let crs: Crs = 'wgs84';
  if (ix < 0 || iy < 0) {
    ix = find(EAST);
    iy = find(NORTH);
    crs = 'utm33';
  }
  if (ix < 0 || iy < 0) {
    throw new Error('no coordinate columns: need lat/lon (WGS84) or x/y (EPSG:25833)');
  }
  const num = (s: string) => Number(s.trim().replace(/^"|"$/g, '').replace(',', '.'));
  const out: LayerPoint[] = [];
  for (const line of lines.slice(1)) {
    const row = splitRow(line, sep);
    const x = num(row[ix] ?? ''), y = num(row[iy] ?? '');
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // x/y headed columns sometimes hold lon/lat after all
    const actual = crs === 'utm33' ? guessCrs(x, y) : 'wgs84';
    if (!actual) continue;
    const [wx, wz] = toWorld(x, y, actual, origin);
    const props: Record<string, unknown> = {};
    cols.forEach((c, i) => { if (i !== ix && i !== iy) props[c] = row[i]; });
    out.push({ x: wx, z: wz, n: pick(props, LABEL_KEYS, true) || fallback, d: pick(props, DETAIL_KEYS, false) });
  }
  return out;
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/** One CSV row, honouring double quotes around fields that hold the separator. */
function splitRow(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
