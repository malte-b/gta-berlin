import * as THREE from 'three';
import { meshMaterial } from './materials';

const DATA = 'data/';

/** mesh_manifest.json, written by pipeline/build_mesh.py. */
interface MeshManifest {
  tiles: Record<string, MeshTileInfo>;
  attribution: string[];
}

interface TexturePage { page: number; hi: string; lo: string }

interface MeshTileInfo {
  geometry: string;
  bbox: [number, number, number, number, number, number];
  triangles: number;
  textures: TexturePage[];
}

interface MeshTile {
  key: string;
  info: MeshTileInfo;
  state: 'pending' | 'queued' | 'loading' | 'ready' | 'error';
  mesh: THREE.Mesh | null;
  /** atlas page of each material in mats */
  pages: number[];
  /** geometry as cleaned by pipeline/clean_mesh.py, and the untouched original */
  variants: Partial<Record<'clean' | 'raw', { geo: THREE.BufferGeometry; pages: number[] }>>;
  mats: THREE.ShaderMaterial[];
  tex: { lo: (THREE.Texture | null)[]; hi: (THREE.Texture | null)[] };
  level: 'lo' | 'hi' | null;
  upgrading: boolean;
}

export interface MeshFog {
  near: number;
  far: number;
  color: THREE.Color;
  exposure: number;
  night: number;
}

/**
 * The 3D-Meshmodell Berlin as a visual layer: one continuous photographic
 * skin over ground, buildings and trees.
 *
 * It is only drawn, never walked on. Where you can go and how high the ground
 * is come from the laser-scan terrain and the OSM navigation grid, which agree
 * with the mesh surface to about +-10 cm on open streets but - unlike the
 * mesh - know the difference between a pavement, a parked car and a tree
 * canopy.
 *
 * Textures load at two levels. A full atlas page costs roughly 85 MB of GPU
 * memory once expanded with mipmaps, so every tile gets its small atlas first
 * and only the few nearest the camera are upgraded; tiles that drop out of
 * that set give their large textures back.
 *
 * Licence: the mesh is not open data. Use is non-commercial, it may not be
 * passed on, and published renderings need written consent from Berlin
 * Partner (terms 2.4). The built files are git-ignored for that reason.
 */
export class MeshLayer {
  readonly group = new THREE.Group();
  hiCount = 3;
  /** Showing the untouched mesh rather than the cleaned one (K). The
   *  original is the default: cleaning removes cranes but leaves holes. */
  raw = true;
  /** whether pipeline/clean_mesh.py has produced a cleaned variant */
  hasClean = true;
  private readonly tiles = new Map<string, MeshTile>();
  private readonly queue: MeshTile[] = [];
  private readonly live: THREE.ShaderMaterial[] = [];
  private readonly loader = new THREE.TextureLoader();
  private loading = 0;
  private readonly maxConcurrent = 2;
  private aniso = 1;
  attribution: string[] = [];

  /** Returns null when no mesh has been built - the layer is optional. */
  static async load(renderer: THREE.WebGLRenderer): Promise<MeshLayer | null> {
    const res = await fetch(DATA + 'mesh_manifest.json');
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const m = await res.json() as MeshManifest;
    const layer = new MeshLayer();
    layer.aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    layer.attribution = m.attribution;
    for (const [key, info] of Object.entries(m.tiles)) {
      layer.tiles.set(key, { key, info, state: 'pending', mesh: null, mats: [],
                             pages: [], variants: {},
                             tex: { lo: [], hi: [] }, level: null, upgrading: false });
    }
    return layer;
  }

  private centre(t: MeshTile): [number, number] {
    const b = t.info.bbox;
    return [(b[0] + b[3]) / 2, (b[2] + b[5]) / 2];
  }

  private contains(t: MeshTile, x: number, z: number): boolean {
    const b = t.info.bbox;
    return x >= b[0] && x < b[3] && z >= b[2] && z < b[5];
  }

  /** Queue geometry nearest-first and move texture detail with the camera. */
  update(x: number, z: number): void {
    const dist = (t: MeshTile) => {
      const [cx, cz] = this.centre(t);
      return (cx - x) ** 2 + (cz - z) ** 2;
    };
    const ranked = [...this.tiles.values()].sort((a, b) => dist(a) - dist(b));
    for (const t of ranked) {
      if (t.state === 'pending') {
        t.state = 'queued';
        this.queue.push(t);
      }
    }
    this.queue.sort((a, b) => dist(a) - dist(b));
    while (this.loading < this.maxConcurrent && this.queue.length) {
      void this.loadTile(this.queue.shift()!);
    }
    // Ranking by centre alone can leave the tile you stand in on the small
    // atlas when you are near its edge, so it is always included.
    const wantHi = new Set(ranked.slice(0, this.hiCount).map((t) => t.key));
    for (const t of ranked) if (this.contains(t, x, z)) wantHi.add(t.key);
    for (const t of ranked) {
      if (t.state !== 'ready') continue;
      if (wantHi.has(t.key) && t.level !== 'hi' && !t.upgrading) void this.upgrade(t);
      else if (!wantHi.has(t.key) && t.level === 'hi') this.downgrade(t);
    }
  }

  private async loadTile(t: MeshTile): Promise<void> {
    t.state = 'loading';
    this.loading++;
    try {
      let variant: 'clean' | 'raw' = this.raw ? 'raw' : 'clean';
      let parsed: ReturnType<typeof parseMesh>;
      try {
        parsed = parseMesh(await fetch(DATA + this.file(t, variant)).then((r) => r.arrayBuffer()));
      } catch {
        // never cleaned: m_*.bin is the original and there is no .raw.bin
        variant = 'clean';
        this.raw = false;
        this.hasClean = false;
        parsed = parseMesh(await fetch(DATA + this.file(t, variant)).then((r) => r.arrayBuffer()));
      }
      const { geo, qmin, qscale, pages } = parsed;
      t.variants[variant] = { geo, pages };
      t.pages = pages;
      // small atlases first: the tile appears quickly, then sharpens
      for (let i = 0; i < pages.length; i++) {
        const m = meshMaterial();
        m.uniforms.qmin.value.copy(qmin);
        m.uniforms.qscale.value.copy(qscale);
        t.mats.push(m);
        this.live.push(m);
        const page = t.info.textures.find((p) => p.page === pages[i]);
        if (page) {
          const tex = await this.texture(page.lo);
          t.tex.lo[i] = tex;
          m.uniforms.map.value = tex;
        }
      }
      t.level = 'lo';
      t.mesh = new THREE.Mesh(geo, this.materialsFor(t, pages));
      t.mesh.name = 'mesh';
      t.state = 'ready';
      this.group.add(t.mesh);
    } catch (err) {
      console.warn('mesh tile', t.key, err);
      t.state = 'error';
    } finally {
      this.loading--;
    }
  }

  private file(t: MeshTile, variant: 'clean' | 'raw'): string {
    return variant === 'raw' ? t.info.geometry.replace(/\.bin$/, '.raw.bin') : t.info.geometry;
  }

  /** One material per draw group, matched by atlas page: the cleaned and the
   *  original geometry share pages, but not necessarily every group. */
  private materialsFor(t: MeshTile, pages: number[]): THREE.ShaderMaterial[] {
    return pages.map((p) => t.mats[t.pages.indexOf(p)] ?? t.mats[0]);
  }

  /**
   * Switch every loaded tile between the cleaned and the untouched mesh.
   * Both share their quantisation, so only geometry and groups change.
   * Resolves false if there is no cleaned mesh to compare against.
   */
  async setRaw(raw: boolean): Promise<boolean> {
    const variant = raw ? 'raw' : 'clean';
    for (const t of this.tiles.values()) {
      if (t.state !== 'ready' || !t.mesh) continue;
      let v = t.variants[variant];
      if (!v) {
        try {
          const buf = await fetch(DATA + this.file(t, variant)).then((r) => r.arrayBuffer());
          const parsed = parseMesh(buf);
          v = { geo: parsed.geo, pages: parsed.pages };
          t.variants[variant] = v;
        } catch {
          return false;               // no m_*.raw.bin: the mesh was never cleaned
        }
      }
      t.mesh.geometry = v.geo;
      t.mesh.material = this.materialsFor(t, v.pages);
    }
    this.raw = raw;
    return true;
  }

  private async texture(file: string): Promise<THREE.Texture> {
    const tex = await this.loader.loadAsync(DATA + file);
    // the shader converts sRGB itself, so keep three out of the colour path
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    // ground at grazing angles is most of the view, so anisotropy matters
    tex.anisotropy = this.aniso;
    return tex;
  }

  private async upgrade(t: MeshTile): Promise<void> {
    t.upgrading = true;
    try {
      for (let i = 0; i < t.mats.length; i++) {
        const page = t.info.textures[i];
        if (!page) continue;
        t.tex.hi[i] ??= await this.texture(page.hi);
        t.mats[i].uniforms.map.value = t.tex.hi[i];
      }
      t.level = 'hi';
    } catch (err) {
      console.warn('hi textures', t.key, err);
    } finally {
      t.upgrading = false;
    }
  }

  private downgrade(t: MeshTile): void {
    for (let i = 0; i < t.mats.length; i++) {
      if (t.tex.lo[i]) t.mats[i].uniforms.map.value = t.tex.lo[i];
      t.tex.hi[i]?.dispose();
      t.tex.hi[i] = null;
    }
    t.level = 'lo';
  }

  setEnv(f: MeshFog): void {
    for (const m of this.live) {
      const u = m.uniforms;
      u.night.value = f.night;
      u.fogNear.value = f.near;
      u.fogFar.value = f.far;
      u.fogColor.value.copy(f.color);
      u.exposure.value = f.exposure;
    }
  }

  get stats(): { ready: number; total: number; hi: number } {
    let ready = 0, hi = 0;
    for (const t of this.tiles.values()) {
      if (t.state === 'ready') ready++;
      if (t.level === 'hi') hi++;
    }
    return { ready, total: this.tiles.size, hi };
  }
}

/**
 * Parse a "BTM1" mesh tile (pipeline/meshmodel.py) into a BufferGeometry with
 * one draw group per atlas page.
 *
 * Positions stay quantised as unsigned shorts and are expanded in the vertex
 * shader. UVs are unsigned shorts flagged normalized, so the GPU hands the
 * shader a plain 0..1 float at half the bandwidth.
 */
function parseMesh(buf: ArrayBuffer): {
  geo: THREE.BufferGeometry; qmin: THREE.Vector3; qscale: THREE.Vector3; pages: number[];
} {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== 'BTM1') throw new Error('bad mesh tile: ' + magic);
  const qmin = new THREE.Vector3(dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true));
  const qscale = new THREE.Vector3(dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true));
  const count = dv.getUint32(28, true);
  const groupCount = dv.getUint16(32, true);

  let o = 34;
  const groups: { page: number; start: number; count: number }[] = [];
  for (let i = 0; i < groupCount; i++) {
    groups.push({ page: dv.getUint16(o, true), start: dv.getUint32(o + 2, true),
                  count: dv.getUint32(o + 6, true) });
    o += 10;
  }
  // 34 + 10 bytes per group is always even, so the planes are 2-byte aligned
  // and can be read as zero-copy views
  const plane = (): Uint16Array => {
    const a = new Uint16Array(buf, o, count);
    o += count * 2;
    return a;
  };
  const xs = plane(), ys = plane(), zs = plane(), us = plane(), vs = plane();

  const pos = new Uint16Array(count * 3);
  const uv = new Uint16Array(count * 2);
  for (let i = 0, p = 0, q = 0; i < count; i++) {
    pos[p++] = xs[i]; pos[p++] = ys[i]; pos[p++] = zs[i];
    uv[q++] = us[i]; uv[q++] = vs[i];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Uint16BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Uint16BufferAttribute(uv, 2, true));
  const pages: number[] = [];
  groups.forEach((g, i) => {
    geo.addGroup(g.start, g.count, i);
    pages.push(g.page);
  });
  // bounds from the tile's real world-space box, not the raw quantised values
  const max = qmin.clone().add(qscale.clone().multiplyScalar(65535));
  geo.boundingBox = new THREE.Box3(qmin.clone(), max);
  geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
  return { geo, qmin, qscale, pages };
}
