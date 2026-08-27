import * as THREE from 'three';
import { HeightField, NavGrid, parseMesh } from './tiles.js';
import { meshMaterial } from './materials.js';

const DATA = 'data/';

/**
 * The world, built from Berlin's photogrammetric mesh model.
 *
 * Two things are streamed independently:
 *
 *  - Geometry, one file per tile. There are only nine tiles over about a
 *    square kilometre, so in practice everything ends up resident; the queue
 *    exists to keep the first frames cheap and to stay correct if the covered
 *    area grows.
 *
 *  - Textures, at two levels. A full atlas page is 4096 x 4096 and costs
 *    roughly 85 MB of GPU memory once expanded with mipmaps, so holding all
 *    nine at full size would need about 770 MB. Every tile therefore loads its
 *    small atlas first, and only the handful nearest the camera are upgraded.
 *    Tiles that drop out of that set release their large textures again.
 */
export class MeshWorld {
  constructor(scene) {
    this.scene = scene;
    this.tiles = new Map();
    this.queue = [];
    this.loading = 0;
    this.maxConcurrent = 2;
    this.hiCount = 3;                 // tiles kept at full texture resolution
    this.manifest = null;
    this.fields = [];
    this.nav = null;
    this._live = [];
    this._loader = new THREE.TextureLoader();
    this._maxAniso = 1;
    this.onTileReady = null;
  }

  async init(onProgress, renderer) {
    this.manifest = await fetch(DATA + 'mesh_manifest.json').then((r) => r.json());
    this.origin = this.manifest.origin;
    this.world = this.manifest.world;
    this.centre = this.manifest.centre;
    // pavement beside a street, chosen in pipeline/build_nav.py; the
    // geometric centre is often a courtyard you cannot walk out of
    this.spawnPoint = this.manifest.spawn
      || { x: this.centre.x, z: this.centre.z };
    if (renderer) {
      this._maxAniso = renderer.capabilities.getMaxAnisotropy();
    }

    // heightfields are small and needed for physics everywhere, so take them
    // all up front rather than tying them to geometry streaming
    const keys = Object.keys(this.manifest.tiles);
    let done = 0;
    await Promise.all(keys.map(async (key) => {
      const info = this.manifest.tiles[key];
      const buf = await fetch(DATA + info.height).then((r) => r.arrayBuffer());
      const hf = new HeightField(buf);
      this.tiles.set(key, { key, info, hf, state: 'pending', mesh: null,
                            mats: [], tex: { lo: [], hi: [] }, level: null });
      this.fields.push(hf);
      done++;
      onProgress?.(`terrain ${done}/${keys.length}`);
    }));
    // the navigation grid decides all movement; see pipeline/build_nav.py
    if (this.manifest.nav) {
      onProgress?.('navigation grid');
      const nb = await fetch(DATA + this.manifest.nav.file).then((r) => r.arrayBuffer());
      this.nav = new NavGrid(nb);
    }
    return this;
  }

  /* --- queries ----------------------------------------------------------- */

  _fieldAt(x, z) {
    for (const f of this.fields) if (f.contains(x, z)) return f;
    return null;
  }

  /**
   * Lowest surface across every tile covering this spot.
   *
   * Neighbouring mesh tiles overlap by a few metres, and in that band two
   * tiles disagree about the height - one may include a building edge the
   * other clips. The navigation pipeline resolves this by taking the minimum,
   * so the game has to as well; picking whichever tile happened to be found
   * first left the two disagreeing by up to three metres, which is what put
   * the player underground near tile seams.
   */
  _surfaceAt(x, z) {
    // Whichever tile centre is nearest owns this spot - matching how
    // pipeline/build_nav.py stitches them. A tile's outer edge has truncated
    // geometry, so blending or minimising across an overlap carves a pit into
    // every seam.
    let best = null;
    let bestD = Infinity;
    for (const f of this.fields) {
      if (!f.contains(x, z)) continue;
      const cx = f.minX + (f.nx * f.cell) * 0.5;
      const cz = f.minZ + (f.nz * f.cell) * 0.5;
      const d = (x - cx) ** 2 + (z - cz) ** 2;
      if (d < bestD) { bestD = d; best = f.groundAt(x, z); }
    }
    return best;
  }

  /** Ground height in world metres. Named `height` so the player controller
   *  works unchanged against either world implementation. */
  height(x, z) {
    // Stand on the mesh surface, which is what you can actually see. The nav
    // grid's terrain is a morphological opening used to decide *where* you may
    // walk; using it for height as well put the player up to three metres
    // underground wherever the opening had dug below the real surface.
    // Walkable cells are now guaranteed to have the two within about a metre
    // of each other, so the surface is the honest answer and the grid stays
    // the fallback outside tile coverage.
    const h = this._surfaceAt(x, z);
    if (h !== null) return h;
    if (this.nav && this.nav.contains(x, z)) return this.nav.height(x, z);
    return 0;
  }

  /**
   * Height of the actual mesh surface, as opposed to `height()` which returns
   * the smoothed nav terrain. Anything drawn *onto* the city - street names
   * painted on the road - has to follow the real surface or it sinks into it.
   */
  surfaceHeight(x, z) {
    const h = this._surfaceAt(x, z);
    return h === null ? this.height(x, z) : h;
  }

  solid(x, z, driving = false) {
    if (this.nav) return !this.nav.passable(x, z, driving);
    const f = this._fieldAt(x, z);
    return f ? f.solid(x, z) : false;
  }

  inWorld(x, z) {
    return this._fieldAt(x, z) !== null;
  }

  /**
   * Lowest ground within a radius, i.e. street level.
   *
   * The mesh model is a single skin, so "outdoors at ground level" is not a
   * property any one cell carries - but streets are reliably the low points
   * between blocks, so the minimum of the heightfield finds them.
   */
  streetLevel(x, z, radius = 90, step = 3) {
    let best = null;
    let bestScore = -Infinity;
    for (let dz = -radius; dz <= radius; dz += step) {
      for (let dx = -radius; dx <= radius; dx += step) {
        const px = x + dx, pz = z + dz;
        const f = this._fieldAt(px, pz);
        if (!f) continue;
        const h = f.groundAt(px, pz);
        if (f.topAt(px, pz) - h > 2.0) continue;      // something overhead

        // Score openness: a street keeps going in a straight line, while a
        // courtyard or a gap under a tree is hemmed in within a few metres.
        // Photogrammetry drapes over tree canopies rather than seeing through
        // them, so unless this is checked you spawn inside foliage.
        let open = 0;
        for (let a = 0; a < 8; a++) {
          const th = (a / 8) * Math.PI * 2;
          for (let r = 4; r <= 16; r += 4) {
            const qx = px + Math.cos(th) * r;
            const qz = pz + Math.sin(th) * r;
            const g = this._fieldAt(qx, qz);
            if (!g) break;
            const gh = g.groundAt(qx, qz);
            if (Math.abs(gh - h) > 1.5 || g.topAt(qx, qz) - gh > 2.0) break;
            open++;
          }
        }
        // prefer open and low, openness weighted far more than height
        const score = open * 4 - h;
        if (score > bestScore) {
          bestScore = score;
          best = [px, pz];
        }
      }
    }
    return best || [x, z];
  }

  /**
   * Can you step from one spot to the next?
   *
   * With a continuous mesh there are no separate "building" volumes to test
   * against, so walls are detected by how sharply the surface rises: a kerb or
   * a stair tread is a few centimetres, a facade is metres.
   */
  canStep(fromX, fromZ, toX, toZ, driving = false) {
    if (this.nav) return this.nav.passable(toX, toZ, driving);
    const f = this._fieldAt(toX, toZ);
    if (!f) return false;
    return f.groundAt(toX, toZ) - this.height(fromX, fromZ) <= 0.7;
  }

  freeSpot(x, z, maxR = 120, driving = false) {
    if (this.nav) {
      const p = this.nav.nearestPassable(x, z, driving, maxR);
      if (p) return p;
    }
    if (!this.solid(x, z)) return [x, z];
    for (let r = 2; r <= maxR; r += 2) {
      for (let a = 0; a < 24; a++) {
        const th = (a / 24) * Math.PI * 2;
        const px = x + Math.cos(th) * r;
        const pz = z + Math.sin(th) * r;
        if (this.inWorld(px, pz) && !this.solid(px, pz)) return [px, pz];
      }
    }
    return [x, z];
  }

  /** The tile whose heightfield covers this position. */
  tileAt(x, z) {
    for (const t of this.tiles.values()) {
      if (t.hf && t.hf.contains(x, z)) return t;
    }
    return null;
  }

  _centreOf(t) {
    const b = t.info.bbox;
    return [(b[0] + b[3]) / 2, (b[2] + b[5]) / 2];
  }

  /* --- streaming --------------------------------------------------------- */

  update(x, z) {
    const ranked = [...this.tiles.values()].map((t) => {
      const [cx, cz] = this._centreOf(t);
      return { t, d: (cx - x) ** 2 + (cz - z) ** 2 };
    }).sort((a, b) => a.d - b.d);

    for (const { t } of ranked) {
      if (t.state === 'pending') {
        t.state = 'queued';
        this.queue.push(t);
      }
    }
    this.queue.sort((a, b) => {
      const [ax, az] = this._centreOf(a);
      const [bx, bz] = this._centreOf(b);
      return ((ax - x) ** 2 + (az - z) ** 2) - ((bx - x) ** 2 + (bz - z) ** 2);
    });
    while (this.loading < this.maxConcurrent && this.queue.length) {
      this._load(this.queue.shift());
    }

    // Texture level: the nearest few tiles get the big atlas, the rest give it
    // back. Ranking by tile centre alone can leave the tile you are actually
    // standing in on the small atlas when you are near its edge, so it is
    // always included explicitly.
    const wantHi = new Set(ranked.slice(0, this.hiCount).map((r) => r.t.key));
    const here = this.tileAt(x, z);
    if (here) wantHi.add(here.key);
    for (const { t } of ranked) {
      if (t.state !== 'ready') continue;
      if (wantHi.has(t.key) && t.level !== 'hi' && !t.upgrading) this._upgrade(t);
      else if (!wantHi.has(t.key) && t.level === 'hi') this._downgrade(t);
    }
  }

  async _load(t) {
    t.state = 'loading';
    this.loading++;
    try {
      const buf = await fetch(DATA + t.info.geometry).then((r) => r.arrayBuffer());
      const { geo, qmin, qscale, pages } = parseMesh(buf);

      // small atlases first: the tile becomes visible quickly, then sharpens
      const mats = [];
      for (let i = 0; i < pages.length; i++) {
        const page = t.info.textures.find((p) => p.page === pages[i]);
        const m = meshMaterial();
        m.uniforms.qmin.value.copy(qmin);
        m.uniforms.qscale.value.copy(qscale);
        mats.push(m);
        this._live.push(m);
        if (page) {
          const tex = await this._texture(page.lo);
          t.tex.lo[i] = tex;
          m.uniforms.map.value = tex;
        }
      }
      t.mats = mats;
      t.level = 'lo';
      const mesh = new THREE.Mesh(geo, mats);
      mesh.frustumCulled = true;
      t.mesh = mesh;
      t.state = 'ready';
      this.scene.add(mesh);
      this.onTileReady?.(t);
    } catch (err) {
      console.warn('mesh tile', t.key, err);
      t.state = 'error';
    } finally {
      this.loading--;
    }
  }

  _texture(file) {
    return new Promise((resolve, reject) => {
      this._loader.load(DATA + file, (tex) => {
        // the shader converts sRGB itself, so keep three out of the colour path
        tex.colorSpace = THREE.NoColorSpace;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        // ground seen at grazing angles is the whole view here, so anisotropy
        // is doing more work than any other single setting
        tex.anisotropy = Math.min(8, this._maxAniso);
        tex.needsUpdate = true;
        resolve(tex);
      }, undefined, reject);
    });
  }

  async _upgrade(t) {
    t.upgrading = true;
    try {
      for (let i = 0; i < t.mats.length; i++) {
        const page = t.info.textures[i];
        if (!page) continue;
        if (!t.tex.hi[i]) t.tex.hi[i] = await this._texture(page.hi);
        t.mats[i].uniforms.map.value = t.tex.hi[i];
      }
      t.level = 'hi';
    } catch (err) {
      console.warn('hi textures', t.key, err);
    } finally {
      t.upgrading = false;
    }
  }

  _downgrade(t) {
    for (let i = 0; i < t.mats.length; i++) {
      if (t.tex.lo[i]) t.mats[i].uniforms.map.value = t.tex.lo[i];
      if (t.tex.hi[i]) {
        t.tex.hi[i].dispose();
        t.tex.hi[i] = null;
      }
    }
    t.level = 'lo';
  }

  setEnv({ night, time, fogNear, fogFar, fogColor, sunDir, exposure }) {
    for (const m of this._live) {
      const u = m.uniforms;
      if (night !== undefined) u.night.value = night;
      if (time !== undefined) u.time.value = time;
      if (fogNear !== undefined) u.fogNear.value = fogNear;
      if (fogFar !== undefined) u.fogFar.value = fogFar;
      if (fogColor) u.fogColor.value.copy(fogColor);
      if (sunDir) u.sunDir.value.copy(sunDir);
      if (exposure !== undefined) u.exposure.value = exposure;
    }
  }

  get stats() {
    let ready = 0;
    let hi = 0;
    for (const t of this.tiles.values()) {
      if (t.state === 'ready') ready++;
      if (t.level === 'hi') hi++;
    }
    return { ready, total: this.tiles.size, queued: this.queue.length, hi };
  }
}
