import { makeFromWorld, type XZ } from './geo';
import { MODES, type Player } from './player';
import type { PoiLayer } from './pois';
import type { World } from './world';

export interface RenderInfo {
  calls: number;
  triangles: number;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

/**
 * HUD: minimap, position readout, speed and diagnostics.
 *
 * The minimap is the world's own 1 px-per-metre map - OSM ground cover with
 * building footprints from the navigation grid on top - so it always agrees
 * with where you can actually go.
 */
export class HUD {
  readonly world: World;
  pois: PoiLayer | null = null;
  area = 'Kreuzberg';
  private readonly canvas = el<HTMLCanvasElement>('map');
  private readonly ctx = this.canvas.getContext('2d')!;
  private readonly statsEl = el('stats');
  private readonly placeEl = el('place');
  private readonly speedEl = el('speed');
  private readonly hintEl = el('hint');
  private readonly spans = [180, 420, 1200];
  private zoom = 1;
  private hintTimer = 0;
  private readonly fromWorld: (x: number, z: number) => XZ;

  constructor(world: World) {
    this.world = world;
    this.fromWorld = makeFromWorld(world.origin);
    if (world.tiled) this.area = 'Berlin';
    this.updateLabel();
  }

  private updateLabel(): void {
    el('maplabel').textContent = `M — ${this.spans[this.zoom]} M`;
  }

  cycleZoom(): void {
    this.zoom = (this.zoom + 1) % this.spans.length;
    this.updateLabel();
  }

  hint(text: string, seconds = 2.4): void {
    this.hintEl.textContent = text;
    this.hintEl.classList.add('on');
    this.hintTimer = seconds;
  }

  draw(player: Player, dt: number, fps: number, info: RenderInfo): void {
    const { ctx } = this;
    const size = this.canvas.width;
    const scale = size / this.spans[this.zoom];
    const px = player.pos.x, pz = player.pos.z;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, size, size);
    ctx.clip();
    ctx.fillStyle = '#15181e';
    ctx.fillRect(0, 0, size, size);

    ctx.imageSmoothingEnabled = scale < 1;
    const reach = this.spans[this.zoom];
    for (const tile of this.world.tiles.values()) {
      const nav = tile.nav;
      if (!tile.map || !nav || tile.distance(px, pz) > reach) continue;
      ctx.drawImage(tile.map,
        size / 2 + (nav.minX - px) * scale, size / 2 + (nav.minZ - pz) * scale,
        nav.nx * nav.cell * scale, nav.nz * nav.cell * scale);
    }

    // data layer points, in their colours
    if (this.pois) {
      for (const [layer, x, z] of this.pois.dataNear(px, pz, reach / 2)) {
        ctx.fillStyle = layer.colour;
        ctx.fillRect(size / 2 + (x - px) * scale - 2.5, size / 2 + (z - pz) * scale - 2.5, 5, 5);
      }
    }

    ctx.translate(size / 2, size / 2);
    // the camera looks along (-sin yaw, -cos yaw); north (-z) is up on the map
    ctx.rotate(-player.yaw);
    ctx.fillStyle = '#ffb454';
    ctx.strokeStyle = '#14161c';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5.5, 6.5);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-5.5, 6.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1);

    const [lon, lat] = this.fromWorld(px, pz);
    this.placeEl.innerHTML =
      `${this.area}<small>${lat.toFixed(5)}, ${lon.toFixed(5)}</small>`;
    this.speedEl.innerHTML = `${Math.round(player.speedKmh)}<span> KM/H</span>`;

    const s = this.world.stats;
    const mode = player.flying ? 'flying' : MODES[player.mode].label;
    this.statsEl.innerHTML =
      `<b>${fps.toFixed(0)}</b> fps · <b>${info.calls}</b> draws · `
      + `<b>${(info.triangles / 1e6).toFixed(2)}</b> M tris`
      + `<br><b>${s.buildings}</b> buildings · <b>${s.trees}</b> trees`
      + (this.world.tiled ? ` · <b>${s.full}</b>/<b>${s.tiles}</b> tiles` : '')
      + `<br>x <b>${px.toFixed(0)}</b>  z <b>${pz.toFixed(0)}</b>  alt <b>${player.pos.y.toFixed(1)}</b> m`
      + `<br>${mode}`;

    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.hintEl.classList.remove('on');
    }
  }
}
