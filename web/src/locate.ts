import { makeFromWorld, utm33 } from './geo.js';

/**
 * Deep links and address search.
 *
 * The URL hash carries a real geographic position (lon/lat plus heading and
 * mode) rather than internal world metres, so a shared link keeps working if
 * the covered area is ever rebuilt against a different origin.
 *
 * Geocoding goes to Nominatim, which is fine at this volume but is a public
 * service with a usage policy - it is rate limited here to one request at a
 * time and results are cached per query.
 */
export class Locator {
  constructor(world, player, hud) {
    this.world = world;
    this.player = player;
    this.hud = hud;
    this.fromWorld = makeFromWorld(world.origin);
    this.cache = new Map();
    this.busy = false;
    this._lastHash = '';
  }

  /** World metres for a lon/lat, or null if it falls outside the mesh. */
  toWorld(lon, lat) {
    const [e, n] = utm33(lon, lat);
    const x = e - this.world.origin.e;
    const z = -(n - this.world.origin.n);
    return [x, z];
  }

  inCoverage(x, z) {
    return this.world.nav ? this.world.nav.contains(x, z) : false;
  }

  shareUrl() {
    const p = this.player;
    const [lon, lat] = this.fromWorld(p.pos.x, p.pos.z);
    const params = [
      `${lat.toFixed(6)},${lon.toFixed(6)}`,
      `h=${p.yaw.toFixed(2)}`,
      `m=${p.mode}`,
    ];
    return `${location.origin}${location.pathname}#${params.join('&')}`;
  }

  /** Push the current spot into the address bar, throttled by the caller. */
  syncHash() {
    const p = this.player;
    const [lon, lat] = this.fromWorld(p.pos.x, p.pos.z);
    const h = `${lat.toFixed(5)},${lon.toFixed(5)}&h=${p.yaw.toFixed(2)}&m=${p.mode}`;
    if (h === this._lastHash) return;
    this._lastHash = h;
    history.replaceState(null, '', `#${h}`);
  }

  /** Apply a #lat,lon&h=..&m=.. hash if one is present. Returns true if used. */
  applyHash() {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return false;
    const parts = Object.create(null);
    let coords = null;
    for (const seg of raw.split('&')) {
      if (seg.includes('=')) {
        const [k, v] = seg.split('=');
        parts[k] = v;
      } else if (seg.includes(',')) {
        coords = seg.split(',').map(Number);
      }
    }
    if (!coords || coords.some(Number.isNaN)) return false;
    const [x, z] = this.toWorld(coords[1], coords[0]);
    if (!this.inCoverage(x, z)) return false;
    const p = this.player;
    if (parts.m) p.setMode(parts.m);
    p.spawn(x, z);
    if (parts.h) p.yaw = p.heading = Number(parts.h) || 0;
    return true;
  }

  async geocode(query) {
    const key = query.trim().toLowerCase();
    if (!key) return null;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.busy) return null;
    this.busy = true;
    try {
      // bias to Berlin and to the area actually covered by the mesh
      const url = 'https://nominatim.openstreetmap.org/search'
        + `?format=jsonv2&limit=5&countrycodes=de&q=${encodeURIComponent(query + ', Berlin')}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'de' } });
      if (!res.ok) throw new Error('geocoder ' + res.status);
      const list = await res.json();
      const hits = list.map((r) => ({
        name: r.display_name,
        lon: Number(r.lon),
        lat: Number(r.lat),
      }));
      this.cache.set(key, hits);
      return hits;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Teleport to an address. Returns a short status string for the HUD.
   * Only places inside the downloaded tiles can be entered - everywhere else
   * has no ground to stand on.
   */
  async goTo(query) {
    let hits;
    try {
      hits = await this.geocode(query);
    } catch (err) {
      return `lookup failed: ${err.message}`;
    }
    if (!hits) return 'still looking up the last one';
    if (!hits.length) return `no match for "${query}"`;

    for (const hit of hits) {
      const [x, z] = this.toWorld(hit.lon, hit.lat);
      if (this.inCoverage(x, z)) {
        this.player.spawn(x, z);
        const short = hit.name.split(',').slice(0, 2).join(',');
        return `→ ${short}`;
      }
    }
    const first = hits[0];
    const [x, z] = this.toWorld(first.lon, first.lat);
    const d = Math.hypot(x - this.player.pos.x, z - this.player.pos.z);
    return `${first.name.split(',')[0]} is outside the downloaded tiles (~${Math.round(d)} m away)`;
  }
}
