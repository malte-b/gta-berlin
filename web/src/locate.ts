import { makeFromWorld, utm33, type XZ } from './geo';
import type { HUD } from './hud';
import { t } from './i18n';
import type { Player } from './player';
import type { World } from './world';

interface Hit { name: string; lon: number; lat: number }

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
  readonly world: World;
  readonly player: Player;
  readonly hud: HUD;
  private readonly fromWorld: (x: number, z: number) => XZ;
  private readonly cache = new Map<string, Hit[]>();
  private busy = false;
  private lastHash = '';

  constructor(world: World, player: Player, hud: HUD) {
    this.world = world;
    this.player = player;
    this.hud = hud;
    this.fromWorld = makeFromWorld(world.origin);
  }

  /** World metres for a lon/lat. */
  toWorld(lon: number, lat: number): XZ {
    const [e, n] = utm33(lon, lat);
    const x = e - this.world.origin.e;
    const z = -(n - this.world.origin.n);
    return [x, z];
  }

  inCoverage(x: number, z: number): boolean {
    return this.world.covers(x, z);
  }

  shareUrl(): string {
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
  syncHash(): void {
    const p = this.player;
    const [lon, lat] = this.fromWorld(p.pos.x, p.pos.z);
    const h = `${lat.toFixed(5)},${lon.toFixed(5)}&h=${p.yaw.toFixed(2)}&m=${p.mode}`;
    if (h === this.lastHash) return;
    this.lastHash = h;
    history.replaceState(null, '', `#${h}`);
  }

  /** Apply a #lat,lon&h=..&m=.. hash if one is present, once the ground
   *  there has loaded. Resolves true if it was used. */
  async applyHash(onProgress?: (msg: string) => void): Promise<boolean> {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return false;
    const parts: Record<string, string> = Object.create(null);
    let coords: number[] | null = null;
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
    await this.world.ensure(x, z, onProgress);
    const p = this.player;
    if (parts.m) p.setMode(parts.m);
    p.spawn(x, z);
    if (parts.h) p.yaw = p.heading = Number(parts.h) || 0;
    return true;
  }

  async geocode(query: string): Promise<Hit[] | null> {
    const key = query.trim().toLowerCase();
    if (!key) return null;
    const known = this.cache.get(key);
    if (known) return known;
    if (this.busy) return null;
    this.busy = true;
    try {
      // bias to Berlin, where the tiles are
      const url = 'https://nominatim.openstreetmap.org/search'
        + `?format=jsonv2&limit=5&countrycodes=de&q=${encodeURIComponent(query + ', Berlin')}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'de' } });
      if (!res.ok) throw new Error('geocoder ' + res.status);
      const list = await res.json() as { display_name: string; lon: string; lat: string }[];
      const hits: Hit[] = list.map((r) => ({
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
  async goTo(query: string): Promise<string> {
    let hits: Hit[] | null;
    try {
      hits = await this.geocode(query);
    } catch (err) {
      return t('search.failed', { e: (err as Error).message });
    }
    if (!hits) return t('search.busy');
    if (!hits.length) return t('search.none', { q: query });

    for (const hit of hits) {
      const [x, z] = this.toWorld(hit.lon, hit.lat);
      if (this.inCoverage(x, z)) {
        await this.world.ensure(x, z);
        this.player.spawn(x, z);
        const short = hit.name.split(',').slice(0, 2).join(',');
        return `→ ${short}`;
      }
    }
    const first = hits[0];
    const [x, z] = this.toWorld(first.lon, first.lat);
    const d = Math.hypot(x - this.player.pos.x, z - this.player.pos.z);
    return t('search.outside', { name: first.name.split(',')[0], d: Math.round(d) });
  }
}
