import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NavGrid, TerrainField, parseProps, parseTrees, type Tree } from './tiles';
import { crownMaterial, photoRoofs, terrainMaterial, trunkMaterial,
         type GroundKind, type GroundTextures, type OrthoTile } from './materials';

const TERRAIN_CHUNK = 100;          // metres per terrain mesh; one orthophoto each
const COARSE_STEP = 4;              // metres between vertices of a distant tile
const PHOTO_NEAR = 320;             // full-resolution orthophotos within this
const PHOTO_FAR = 480;              // ... and dropped again beyond this

/** A tile's own manifest: tile.json, or the whole world.json of a
 *  single-area build. Written by pipeline/build_world.py. */
export interface TileManifest {
  world: [number, number, number, number, number, number];
  terrain: { file: string; minX: number; minZ: number; cell: number; nx: number; nz: number };
  cover: { file: string; minX: number; minZ: number; res: number; w: number; h: number };
  /** Absent where there is nothing built: forest, lakes, fields. */
  buildings?: { file: string; chunk: number; count: number; triangles: number };
  trees: { file: string; count: number };
  props?: { file: string; models: string; kinds: string[]; count: number };
  ortho?: {
    chunk: number; res: number; nx: number; nz: number; minX: number; minZ: number;
    tile: string;
    overview: { file: string; res: number; w: number; h: number };
  };
  nav: { file: string };
  pois?: string;
}

/** Ground textures shared by every tile; each adds its own cover mask. */
export type SharedGround = Pick<GroundTextures, 'color' | 'normal'>;

type Uniforms = { uniforms: Record<string, THREE.IUniform> };

/**
 * One piece of the world, loaded at one of two levels:
 *
 *  - coarse: terrain every 4 m under the tile's 50 cm orthophoto. Cheap
 *    enough to keep a few kilometres of them around for the view from the air.
 *  - full: 1 m terrain with 20 cm orthophotos close by, buildings, trees,
 *    street furniture, the navigation grid and the minimap.
 *
 * Geometry is stored relative to the tile's north-west corner and placed
 * with the mesh position: Berlin is 40 km across, and world coordinates that
 * large lose millimetres in 32-bit vertex positions, which shows as jitter.
 */
export class Tile {
  readonly key: string;
  readonly base: string;
  readonly bounds: [number, number, number, number];   // x0, z0, x1, z1
  readonly box: number[];
  readonly group = new THREE.Group();
  manifest: TileManifest | null;
  level: 'none' | 'coarse' | 'full' = 'none';
  terrain: TerrainField | null = null;
  nav: NavGrid | null = null;
  map: HTMLCanvasElement | null = null;
  trees: Tree[] = [];
  buildings = 0;
  /** POI file of a full tile, relative to the data root, if it has one. */
  poiFile: string | null = null;

  readonly animated: Uniforms[] = [];
  readonly windowMats: THREE.MeshStandardMaterial[] = [];

  private ground: GroundTextures | null = null;
  private overview: OrthoTile | null = null;
  private coarse: THREE.Mesh | null = null;
  private fine = new THREE.Group();
  private open = new THREE.Group();
  private chunks: { mesh: THREE.Mesh; i: number; j: number; photo: OrthoTile | null;
                    loading: boolean }[] = [];
  private textures = new Set<THREE.Texture>();
  private disposed = false;

  constructor(key: string, base: string, world: number[], manifest: TileManifest | null = null) {
    this.key = key;
    this.base = base;
    this.box = world;
    this.bounds = [world[0], world[2], world[3], world[5]];
    this.manifest = manifest;
    this.group.name = `tile ${key}`;
    this.group.position.set(this.bounds[0], 0, this.bounds[1]);
    this.group.add(this.fine, this.open);
  }

  /** Shortest distance from (x, z) to the tile, 0 inside it. */
  distance(x: number, z: number): number {
    const [x0, z0, x1, z1] = this.bounds;
    return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1));
  }

  contains(x: number, z: number): boolean {
    const [x0, z0, x1, z1] = this.bounds;
    return x >= x0 && z >= z0 && x < x1 && z < z1;
  }

  /* --- loading ----------------------------------------------------------- */

  private url(file: string): string { return this.base + file; }

  private async texture(file: string, aniso: number): Promise<THREE.Texture> {
    const tex = await new THREE.TextureLoader().loadAsync(this.url(file));
    // image row 0 is the north edge, i.e. the minimum z
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = aniso;
    tex.needsUpdate = true;
    this.textures.add(tex);
    return tex;
  }

  /** What every level needs: manifest, terrain, cover mask, overview photo. */
  async loadCoarse(shared: SharedGround, aniso: number): Promise<void> {
    if (!this.manifest) {
      const res = await fetch(this.url('tile.json'));
      if (!res.ok) throw new Error(`${this.url('tile.json')} (${res.status})`);
      this.manifest = await res.json() as TileManifest;
    }
    const m = this.manifest;
    const [tbuf, cover, overview] = await Promise.all([
      fetch(this.url(m.terrain.file)).then((r) => r.arrayBuffer()),
      this.texture(m.cover.file, aniso),
      m.ortho ? this.texture(m.ortho.overview.file, aniso) : Promise.resolve(null),
    ]);
    if (this.disposed) return;
    this.terrain = new TerrainField(tbuf);
    // the mask is data, not colour
    cover.colorSpace = THREE.NoColorSpace;
    this.ground = {
      ...shared, cover,
      coverMin: new THREE.Vector2(m.cover.minX, m.cover.minZ),
      coverSize: new THREE.Vector2(m.cover.w * m.cover.res, m.cover.h * m.cover.res),
    };
    if (overview && m.ortho) {
      this.overview = { map: overview, min: new THREE.Vector2(m.ortho.minX, m.ortho.minZ),
                        size: m.ortho.overview.w * m.ortho.overview.res };
    }
    this.buildCoarse();
    this.level = 'coarse';
  }

  /** Everything else, on top of loadCoarse(). */
  async loadFull(aniso: number): Promise<void> {
    const m = this.manifest!;
    const [nbuf, tbuf, gltf, props] = await Promise.all([
      fetch(this.url(m.nav.file)).then((r) => r.arrayBuffer()),
      fetch(this.url(m.trees.file)).then((r) => r.arrayBuffer()),
      m.buildings ? new GLTFLoader().loadAsync(this.url(m.buildings.file)) : Promise.resolve(null),
      m.props ? Promise.all([
        new GLTFLoader().loadAsync(this.url(m.props.models)),
        fetch(this.url(m.props.file)).then((r) => r.arrayBuffer()),
      ]) : Promise.resolve(null),
    ]);
    if (this.disposed || this.level !== 'coarse') return;
    this.nav = new NavGrid(nbuf);
    this.trees = parseTrees(tbuf);
    this.buildFine();
    if (gltf) this.buildBuildings(gltf, aniso);
    this.buildings = m.buildings?.count ?? 0;
    this.buildTrees();
    if (props && m.props) this.buildProps(props[0], props[1], m.props.kinds, aniso);
    this.map = await this.buildMap();
    this.poiFile = m.pois ? this.url(m.pois) : null;
    if (this.coarse) this.coarse.visible = false;
    this.fine.visible = this.open.visible = true;
    this.level = 'full';
  }

  /** Back to coarse: drop everything loadFull() added. */
  dropFull(): void {
    if (this.level !== 'full') return;
    for (const c of this.chunks) this.releasePhoto(c);
    this.chunks = [];
    for (const g of [this.fine, this.open]) {
      disposeTree(g, this.textures);
      g.clear();
    }
    this.windowMats.length = 0;
    // only the coarse terrain's material is left
    const coarse = this.coarse?.material as THREE.MeshStandardMaterial | undefined;
    this.animated.splice(0, this.animated.length, ...(coarse ? [coarse.userData as Uniforms] : []));
    this.nav = null;
    this.map = null;
    this.trees = [];
    this.buildings = 0;
    this.poiFile = null;
    if (this.coarse) this.coarse.visible = true;
    this.level = 'coarse';
  }

  dispose(): void {
    this.disposed = true;
    this.dropFull();
    disposeTree(this.group, this.textures);
    for (const t of this.textures) t.dispose();
    this.textures.clear();
    this.group.removeFromParent();
    this.level = 'none';
  }

  /* --- terrain ----------------------------------------------------------- */

  /** One mesh over the whole tile, every COARSE_STEP metres. */
  private buildCoarse(): void {
    const t = this.terrain!;
    const nx = Math.floor((t.nx - 1) / COARSE_STEP) + 1;
    const nz = Math.floor((t.nz - 1) / COARSE_STEP) + 1;
    const mesh = new THREE.Mesh(this.terrainGeometry(0, 0, nx, nz, COARSE_STEP),
                                this.terrainMat(this.overview));
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    this.coarse = mesh;
    this.group.add(mesh);
  }

  /** 1 m meshes, one per orthophoto chunk, under the overview until close. */
  private buildFine(): void {
    const t = this.terrain!;
    const n = TERRAIN_CHUNK + 1;
    for (let cz = 0; cz < t.nz - 1; cz += TERRAIN_CHUNK) {
      for (let cx = 0; cx < t.nx - 1; cx += TERRAIN_CHUNK) {
        const mesh = new THREE.Mesh(this.terrainGeometry(cx, cz, n, n, 1), this.terrainMat(this.overview));
        mesh.receiveShadow = true;
        mesh.name = 'terrain';
        this.fine.add(mesh);
        this.chunks.push({ mesh, i: cx / TERRAIN_CHUNK, j: cz / TERRAIN_CHUNK,
                           photo: null, loading: false });
      }
    }
  }

  private terrainMat(photo: OrthoTile | null): THREE.MeshStandardMaterial {
    const mat = terrainMaterial(this.ground!, photo ?? undefined);
    this.animated.push(mat.userData as Uniforms);
    return mat;
  }

  /** nx x nz vertices from cell (c0, r0), `step` cells apart, tile-relative. */
  private terrainGeometry(c0: number, r0: number, nx: number, nz: number,
                          step: number): THREE.BufferGeometry {
    const t = this.terrain!;
    const ox = this.bounds[0], oz = this.bounds[1];
    const pos = new Float32Array(nx * nz * 3);
    const nor = new Float32Array(nx * nz * 3);
    let p = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const gi = Math.min(c0 + i * step, t.nx - 1);
        const gj = Math.min(r0 + j * step, t.nz - 1);
        // vertices sit on cell centres, where the samples are
        pos[p] = t.minX + (gi + 0.5) * t.cell - ox;
        pos[p + 1] = t.at(gi, gj);
        pos[p + 2] = t.minZ + (gj + 0.5) * t.cell - oz;
        const dx = t.at(gi + 1, gj) - t.at(gi - 1, gj);
        const dz = t.at(gi, gj + 1) - t.at(gi, gj - 1);
        const l = Math.hypot(dx, 2 * t.cell, dz);
        nor[p] = -dx / l;
        nor[p + 1] = (2 * t.cell) / l;
        nor[p + 2] = -dz / l;
        p += 3;
      }
    }
    const index: number[] = [];
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(index);
    geo.computeBoundingSphere();
    return geo;
  }

  /** Swap 20 cm orthophotos in near (x, z) and back out further away. */
  updatePhotos(x: number, z: number, aniso: number): void {
    const o = this.manifest?.ortho;
    if (!o || this.level !== 'full') return;
    for (const c of this.chunks) {
      const cx = o.minX + (c.i + 0.5) * o.chunk;
      const cz = o.minZ + (c.j + 0.5) * o.chunk;
      const d = Math.hypot(cx - x, cz - z) - o.chunk * 0.7;
      if (d < PHOTO_NEAR && !c.photo && !c.loading && c.i < o.nx && c.j < o.nz) {
        c.loading = true;
        const file = o.tile.replace('{i}', String(c.i)).replace('{j}', String(c.j));
        void this.texture(file, aniso).then((map) => {
          c.loading = false;
          if (this.disposed || !this.chunks.includes(c)) { map.dispose(); return; }
          c.photo = { map, size: o.chunk,
                      min: new THREE.Vector2(o.minX + c.i * o.chunk, o.minZ + c.j * o.chunk) };
          this.setChunkMaterial(c, this.terrainMat(c.photo));
        }, () => { c.loading = false; });
      } else if (d > PHOTO_FAR && c.photo) {
        this.releasePhoto(c);
        this.setChunkMaterial(c, this.terrainMat(this.overview));
      }
    }
  }

  private setChunkMaterial(c: Tile['chunks'][number], mat: THREE.MeshStandardMaterial): void {
    const old = c.mesh.material as THREE.MeshStandardMaterial;
    const k = this.animated.indexOf(old.userData as Uniforms);
    if (k >= 0) this.animated.splice(k, 1);
    old.dispose();
    c.mesh.material = mat;
  }

  private releasePhoto(c: Tile['chunks'][number]): void {
    if (!c.photo) return;
    c.photo.map.dispose();
    this.textures.delete(c.photo.map);
    c.photo = null;
  }

  /* --- things standing on it --------------------------------------------- */

  /**
   * Buildings arrive as one glTF node per building with a mesh per material,
   * thousands of meshes per tile, and are merged here into one mesh per
   * (chunk, material). Chunks keep frustum culling useful; merging keeps the
   * draw count in the low hundreds.
   */
  private buildBuildings(gltf: { scene: THREE.Group }, aniso: number): void {
    gltf.scene.updateMatrixWorld(true);
    const groups = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
    const toTile = new THREE.Matrix4().makeTranslation(-this.bounds[0], 0, -this.bounds[1]);
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      let chunk: string | undefined;
      for (let p: THREE.Object3D | null = mesh; p && chunk === undefined; p = p.parent) {
        chunk = p.userData.chunk as string | undefined;
      }
      const mat = mesh.material as THREE.Material;
      const key = `${chunk ?? '-'}|${mat.uuid}`;
      let g = groups.get(key);
      if (!g) { g = { mat, geos: [] }; groups.set(key, g); }
      g.geos.push(cleanGeometry(mesh.geometry.clone()
        .applyMatrix4(mesh.matrixWorld).applyMatrix4(toTile)));
    });

    // every building material takes its upward faces from the orthophoto
    if (this.overview) {
      const seen = new Set<THREE.Material>();
      const size = new THREE.Vector2(this.overview.size, this.overview.size);
      for (const { mat } of groups.values()) {
        if (seen.has(mat)) continue;
        seen.add(mat);
        photoRoofs(mat, this.overview.map, this.overview.min, size);
      }
    }

    for (const { mat, geos } of groups.values()) {
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      const std = mat as THREE.MeshStandardMaterial;
      for (const tex of [std.map, std.normalMap, std.roughnessMap, std.aoMap]) {
        if (tex) tex.anisotropy = aniso;
      }
      // OSM2World's window layer: lit from inside after dark
      if (std.name?.startsWith('Windows') && std.map) {
        std.emissiveMap = std.map;
        std.emissive = new THREE.Color(0, 0, 0);
        this.windowMats.push(std);
      }
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'buildings';
      this.open.add(mesh);
    }
  }

  /**
   * Street furniture: one OSM2World prototype per kind, copied to every
   * surveyed position. Most kinds have only a handful of copies (a sign
   * combination often just one), so instancing would cost a draw call per
   * kind; instead the copies are baked and merged per material.
   */
  private buildProps(gltf: { scene: THREE.Group }, buf: ArrayBuffer, kinds: string[],
                     aniso: number): void {
    gltf.scene.updateMatrixWorld(true);
    const parts = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material }[]>();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      let kind: string | undefined;
      for (let q: THREE.Object3D | null = mesh; q && kind === undefined; q = q.parent) {
        kind = q.userData.kind as string | undefined;
      }
      if (kind === undefined) return;
      const list = parts.get(kind) ?? [];
      list.push({ geo: cleanGeometry(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)),
                  mat: mesh.material as THREE.Material });
      parts.set(kind, list);
    });

    const groups = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    for (const prop of parseProps(buf)) {
      const list = parts.get(kinds[prop.kind]);
      if (!list) continue;
      m.compose(new THREE.Vector3(prop.x - this.bounds[0], prop.y, prop.z - this.bounds[1]),
                q.setFromAxisAngle(up, prop.yaw), one);
      for (const { geo, mat } of list) {
        let g = groups.get(mat.uuid);
        if (!g) { g = { mat, geos: [] }; groups.set(mat.uuid, g); }
        g.geos.push(geo.clone().applyMatrix4(m));
      }
    }
    for (const { mat, geos } of groups.values()) {
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      const std = mat as THREE.MeshStandardMaterial;
      for (const tex of [std.map, std.normalMap, std.roughnessMap, std.aoMap]) {
        if (tex) tex.anisotropy = aniso;
      }
      // bus shelter walls: OSM2World exports its glass opaque
      const glass = std.name === 'GLASS';
      if (glass) {
        std.transparent = true;
        std.opacity = 0.3;
        std.depthWrite = false;
        std.side = THREE.DoubleSide;
      }
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = !glass;
      mesh.receiveShadow = true;
      mesh.name = 'props';
      this.open.add(mesh);
    }
    for (const list of parts.values()) for (const { geo } of list) geo.dispose();
  }

  /**
   * Trees as instanced meshes: one trunk and one crown per cadastre record,
   * scaled from its surveyed height, crown diameter and trunk girth.
   */
  private buildTrees(): void {
    if (!this.trees.length) return;
    const broad = this.trees.filter((t) => t.form !== 1);
    const conifer = this.trees.filter((t) => t.form === 1);
    const ox = this.bounds[0], oz = this.bounds[1];

    const trunks = new THREE.InstancedMesh(TRUNK_GEO(), trunkMaterial(), this.trees.length);
    const crowns = new THREE.InstancedMesh(CROWN_GEO(), crownMaterial(), broad.length);
    const cones = new THREE.InstancedMesh(CONE_GEO(), crownMaterial(), conifer.length);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    let ti = 0, bi = 0, ci = 0;
    for (const t of this.trees) {
      const rnd = fract(Math.sin(t.x * 12.9898 + t.z * 78.233) * 43758.5453);
      // where the crown starts: street trees are limbed up to clear traffic
      const base = t.height * (t.form === 1 ? 0.12 : t.form === 2 ? 0.2 : 0.36);
      const crownH = t.height - base;
      const d = Math.max(0.12, t.trunk);
      const x = t.x - ox, z = t.z - oz;
      q.setFromAxisAngle(up, rnd * Math.PI * 2);
      m.compose(new THREE.Vector3(x, t.y - 0.2, z), q,
                new THREE.Vector3(d, base + crownH * 0.45, d));
      trunks.setMatrixAt(ti++, m);

      leafColour(col, t, rnd);
      const r = t.crown / 2;
      if (t.form === 1) {
        m.compose(new THREE.Vector3(x, t.y + base, z), q, new THREE.Vector3(r, crownH, r));
        cones.setMatrixAt(ci, m);
        cones.setColorAt(ci++, col);
      } else {
        m.compose(new THREE.Vector3(x, t.y + base + crownH / 2, z), q,
                  new THREE.Vector3(r, crownH / 2, r * (0.85 + 0.3 * rnd)));
        crowns.setMatrixAt(bi, m);
        crowns.setColorAt(bi++, col);
      }
    }
    for (const im of [trunks, crowns, cones]) {
      im.castShadow = true;
      im.receiveShadow = true;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.name = 'trees';
      this.open.add(im);
    }
  }

  /** 1 px = 1 m top-down map of the tile: ground cover plus building footprints. */
  private async buildMap(): Promise<HTMLCanvasElement> {
    const n = this.nav!;
    const cv = this.manifest!.cover;
    const c = document.createElement('canvas');
    c.width = n.nx;
    c.height = n.nz;
    const g = c.getContext('2d')!;
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = this.url(cv.file);
    });
    // read the mask's four channels back as plain bytes; it may reach past
    // the tile, so only the part under the navigation grid is taken
    const tmp = document.createElement('canvas');
    tmp.width = n.nx;
    tmp.height = n.nz;
    const tg = tmp.getContext('2d', { willReadFrequently: true })!;
    tg.drawImage(img, (n.minX - cv.minX) / cv.res, (n.minZ - cv.minZ) / cv.res,
                 (n.nx * n.cell) / cv.res, (n.nz * n.cell) / cv.res, 0, 0, n.nx, n.nz);
    const cover = tg.getImageData(0, 0, n.nx, n.nz).data;
    const out = g.createImageData(n.nx, n.nz);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < n.terrain.length; k += 13) {
      lo = Math.min(lo, n.terrain[k]); hi = Math.max(hi, n.terrain[k]);
    }
    for (let k = 0; k < n.nx * n.nz; k++) {
      const o = k * 4;
      const rel = (n.terrain[k] - lo) / Math.max(1, hi - lo);
      let rgb: [number, number, number] = [44 + rel * 30, 46 + rel * 30, 50 + rel * 30];
      if (cover[o + 2] > 110) rgb = [46, 74, 44];
      if (cover[o + 1] > 110) rgb = [92, 90, 84];
      if (cover[o] > 110) rgb = [104, 106, 112];
      if (cover[o + 3] > 110) rgb = [40, 78, 112];
      if (n.flags[k] & NavGrid.BUILDING) rgb = [205, 196, 178];
      out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2];
      out.data[o + 3] = 238;
    }
    g.putImageData(out, 0, 0);
    return c;
  }
}

/* --- helpers --------------------------------------------------------------- */

/** mergeGeometries needs identical attribute sets and indices throughout. */
function cleanGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
  }
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(
      new Float32Array(geo.attributes.position.count * 2), 2));
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.index) geo.setIndex([...Array(geo.attributes.position.count).keys()]);
  return geo;
}

/** Free the GPU side of everything under `root`, sparing shared tree shapes. */
function disposeTree(root: THREE.Object3D, owned: Set<THREE.Texture>): void {
  const shared = new Set([TRUNK_GEO(), CROWN_GEO(), CONE_GEO()]);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!shared.has(mesh.geometry)) mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const std = mat as THREE.MeshStandardMaterial;
      for (const tex of [std.map, std.normalMap, std.roughnessMap, std.aoMap,
                         std.emissiveMap, std.metalnessMap]) {
        if (tex && !owned.has(tex)) tex.dispose();
      }
      mat.dispose();
    }
    if ((mesh as unknown as THREE.InstancedMesh).isInstancedMesh) {
      (mesh as unknown as THREE.InstancedMesh).dispose();
    }
  });
}

function once<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= make());
}

/* --- tree geometry ------------------------------------------------------- */

function fract(v: number): number { return v - Math.floor(v); }

// sRGB leaf greens by genus index (see GENERA in pipeline/trees.py)
const LEAF: Record<number, [number, number, number]> = {
  0: [0.33, 0.45, 0.20], 1: [0.36, 0.48, 0.20], 2: [0.31, 0.45, 0.18],
  3: [0.27, 0.39, 0.16], 4: [0.40, 0.49, 0.23], 5: [0.25, 0.41, 0.17],
  6: [0.42, 0.51, 0.21], 7: [0.45, 0.54, 0.25], 8: [0.34, 0.45, 0.19],
  9: [0.32, 0.46, 0.19], 10: [0.38, 0.49, 0.22], 11: [0.37, 0.41, 0.21],
  12: [0.17, 0.30, 0.17], 13: [0.35, 0.44, 0.20], 14: [0.34, 0.43, 0.20],
  15: [0.30, 0.43, 0.18], 16: [0.44, 0.52, 0.28], 17: [0.47, 0.53, 0.22],
  18: [0.33, 0.44, 0.20], 19: [0.36, 0.45, 0.21],
};

function leafColour(out: THREE.Color, t: Tree, rnd: number): void {
  const base = t.form === 1 ? [0.16, 0.28, 0.16] : (LEAF[t.genus] ?? LEAF[0]);
  const j = 0.88 + rnd * 0.24;
  out.setRGB(base[0] * j, base[1] * j, base[2] * (0.9 + rnd * 0.2), THREE.SRGBColorSpace);
}

const TRUNK_GEO = once(() => new THREE.CylinderGeometry(0.36, 0.5, 1, 7, 1).translate(0, 0.5, 0));

/**
 * A unit crown (radius 1, centred) built from a cluster of displaced spheres,
 * so the silhouette is lumpy rather than a ball. Vertex colours carry a baked
 * occlusion term: darker underneath and toward the core.
 */
const CROWN_GEO = once((): THREE.BufferGeometry => {
  const parts: THREE.BufferGeometry[] = [];
  const blobs: [number, number, number, number][] = [
    [0, 0.1, 0, 0.78], [0.42, -0.1, 0.12, 0.55], [-0.38, -0.05, -0.2, 0.58],
    [0.08, -0.12, -0.45, 0.52], [-0.12, 0.0, 0.44, 0.54], [0.05, 0.48, 0.05, 0.5],
  ];
  for (const [bx, by, bz, br] of blobs) {
    const s = new THREE.IcosahedronGeometry(br, 1);
    const p = s.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      const k = 1 + 0.16 * Math.sin(v.x * 9.1 + v.y * 7.3) * Math.cos(v.z * 8.7 - v.y * 5.1);
      v.multiplyScalar(k).add(new THREE.Vector3(bx, by, bz));
      p.setXYZ(i, v.x, v.y, v.z);
    }
    s.computeVertexNormals();
    parts.push(s.toNonIndexed());
  }
  const geo = mergeGeometries(parts, false)!;
  const p = geo.attributes.position as THREE.BufferAttribute;
  const colours = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const r = Math.hypot(p.getX(i), p.getY(i), p.getZ(i));
    const ao = THREE.MathUtils.clamp(0.45 + 0.35 * (y + 1) + 0.25 * r, 0.35, 1.0);
    colours.set([ao, ao, ao], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geo;
});

/** Unit conifer: base radius 1 at y = 0, tip at y = 1, in three tiers. */
const CONE_GEO = once((): THREE.BufferGeometry => {
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 3; k++) {
    const h = 0.55 - k * 0.08;
    const r = 1 - k * 0.28;
    parts.push(new THREE.ConeGeometry(r, h, 9, 1)
      .translate(0, k * 0.27 + h / 2, 0).toNonIndexed());
  }
  const geo = mergeGeometries(parts, false)!;
  const p = geo.attributes.position as THREE.BufferAttribute;
  const colours = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const ao = 0.5 + 0.5 * Math.min(1, p.getY(i) + 0.3);
    colours.set([ao, ao, ao], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geo;
});

export type { GroundKind };
