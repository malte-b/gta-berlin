import { makeFromWorld } from './geo.js';
import { MODES } from './player.js';

const MAP_TEX = 256;

/**
 * HUD: minimap, position readout, speed and diagnostics.
 *
 * The minimap is drawn from the same heightfields the physics uses, so it
 * costs no extra download and always agrees with what you can walk through.
 * Ground elevation gives the base shading and anything standing more than a
 * couple of metres above it - buildings, trees, the elevated railway - is
 * picked out on top.
 */
export class HUD {
  constructor(world) {
    this.world = world;
    this.canvas = document.getElementById('map');
    this.ctx = this.canvas.getContext('2d');
    this.statsEl = document.getElementById('stats');
    this.placeEl = document.getElementById('place');
    this.speedEl = document.getElementById('speed');
    this.hintEl = document.getElementById('hint');
    this.cache = new Map();
    this.zoom = 1;
    this.spans = [180, 420, 1200];
    this.fromWorld = makeFromWorld(world.origin);
    this._hintTimer = 0;
    this.area = 'Kreuzberg';
    document.getElementById('maplabel').textContent = `M — ${this.spans[this.zoom]} M`;
  }

  _tileTexture(t) {
    if (this.cache.has(t.key)) return this.cache.get(t.key);
    const hf = t.hf;
    if (!hf) return null;
    const c = document.createElement('canvas');
    c.width = c.height = MAP_TEX;
    const g = c.getContext('2d');
    const img = g.createImageData(MAP_TEX, MAP_TEX);

    // elevation range across this tile, for contrast
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < hf.ground.length; i += 7) {
      const v = hf.ground[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = Math.max(1, hi - lo);

    for (let r = 0; r < MAP_TEX; r++) {
      const sr = Math.min(hf.nz - 1, Math.floor((r / MAP_TEX) * hf.nz));
      for (let cc = 0; cc < MAP_TEX; cc++) {
        const sc = Math.min(hf.nx - 1, Math.floor((cc / MAP_TEX) * hf.nx));
        const k = sr * hf.nx + sc;
        const rel = (hf.ground[k] - lo) / span;
        const rise = (hf.top[k] - hf.ground[k]) * hf.hscale;
        const o = (r * MAP_TEX + cc) * 4;
        let rr, gg, bb;
        if (rise > 2.2) {
          const t2 = Math.min(1, rise / 26);
          rr = 190 + t2 * 55; gg = 184 + t2 * 50; bb = 170 + t2 * 40;
        } else {
          rr = 34 + rel * 26; gg = 37 + rel * 28; bb = 44 + rel * 30;
        }
        img.data[o] = rr; img.data[o + 1] = gg; img.data[o + 2] = bb; img.data[o + 3] = 235;
      }
    }
    g.putImageData(img, 0, 0);
    this.cache.set(t.key, c);
    return c;
  }

  cycleZoom() {
    this.zoom = (this.zoom + 1) % this.spans.length;
    document.getElementById('maplabel').textContent = `M — ${this.spans[this.zoom]} M`;
  }

  hint(text, seconds = 2.4) {
    this.hintEl.textContent = text;
    this.hintEl.classList.add('on');
    this._hintTimer = seconds;
  }

  draw(player, dt, fps) {
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

    for (const t of this.world.tiles.values()) {
      const tex = this._tileTexture(t);
      if (!tex) continue;
      const b = t.info.bbox;                 // [minX,minY,minZ, maxX,maxY,maxZ]
      const sx = size / 2 + (b[0] - px) * scale;
      const sy = size / 2 + (b[2] - pz) * scale;
      ctx.drawImage(tex, sx, sy, (b[3] - b[0]) * scale, (b[5] - b[2]) * scale);
    }

    ctx.translate(size / 2, size / 2);
    ctx.rotate(-player.yaw + Math.PI);
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
      `<b>${fps.toFixed(0)}</b> fps · <b>${s.ready}</b>/${s.total} tiles`
      + (s.queued ? ` · ${s.queued} loading` : '')
      + `<br><b>${s.hi}</b> at full texture res`
      + `<br>x <b>${px.toFixed(0)}</b>  z <b>${pz.toFixed(0)}</b>  alt <b>${player.pos.y.toFixed(1)}</b> m`
      + `<br>${mode}`;

    if (this._hintTimer > 0) {
      this._hintTimer -= dt;
      if (this._hintTimer <= 0) this.hintEl.classList.remove('on');
    }
  }
}
