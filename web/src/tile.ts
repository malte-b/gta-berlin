import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Decks } from './bridges';
import { waterMaterial, waterMesh } from './water';
import { breathe, upload } from './frames';
import { closeOnUpload, freeOnUpload, shareMaterialTextures, sharedTextures } from './memory';
import type { CoverJob, MapJob, Raster } from './mapworker';
import { NavGrid, TerrainField, parseProps, parseTrees, type Tree } from './tiles';
import { crownMaterial, photoRoofs, terrainMaterial, trunkMaterial,
         type GroundKind, type GroundTextures, type OrthoTile } from './materials';

const TERRAIN_CHUNK = 100;          // metres per terrain mesh; one orthophoto each
const COARSE_STEP = 4;              // metres between vertices of a distant tile
const PHOTO_NEAR = 320;             // full-resolution orthophotos within this
const PHOTO_FAR = 480;              // ... and dropped again beyond this
/** The 50 cm photo and 0.5 m cover mask are loaded at a fraction of their
 *  size: decoded, a 2,400 px mask is 30 MB. Distant tiles draw a 4 m mesh,
 *  so 2 m photos and a 4 m mask are plenty. Close by, the photo stays at
 *  50 cm - bridge decks and roofs wear it, and at 1 m they looked pixelated
 *  - and the mask, which only blends materials under the photo, at 1 m.
 *  See docs/performance.md. */
const COARSE_PHOTO = 0.25;
const COARSE_COVER = 0.125;
const FULL_PHOTO = 1;
const FULL_COVER = 0.5;

/** A tile's own manifest: tile.json, or the whole world.json of a
 *  single-area build. Written by pipeline/build_world.py. */
export interface TileManifest {
  world: [number, number, number, number, number, number];
  terrain: { file: string; minX: number; minZ: number; cell: number; nx: number; nz: number };
  cover: { file: string; minX: number; minZ: number; res: number; w: number; h: number };
  /** Absent where there is nothing built: forest, lakes, fields. */
  buildings?: { file: string; chunk: number; count: number; triangles: number;
                 /** Merged per chunk and material already (pipeline/pack_buildings.py). */
                 packed?: boolean };
  trees: { file: string; count: number };
  props?: { file: string; models: string; kinds: string[]; count: number };
  ortho?: {
    chunk: number; res: number; nx: number; nz: number; minX: number; minZ: number;
    tile: string;
    overview: { file: string; res: number; w: number; h: number };
  };
  nav: { file: string };
  pois?: string;
  /** Bridge decks; absent where there are none. */
  bridges?: { file: string; count: number };
  /** Flat water surfaces (pipeline/water.py); absent where there is none. */
  water?: { file: string };
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
  /** Build version, appended to every URL of the tile; see Manifest.tiles. */
  readonly version: string | undefined;
  readonly bounds: [number, number, number, number];   // x0, z0, x1, z1
  readonly box: number[];
  readonly group = new THREE.Group();
  manifest: TileManifest | null;
  level: 'none' | 'coarse' | 'full' = 'none';
  terrain: TerrainField | null = null;
  /** Bridge decks, from the coarse level on: seen from afar, stood on close up. */
  decks: Decks | null = null;
  nav: NavGrid | null = null;
  /** 1 px = 1 m minimap of a full tile. */
  map: ImageBitmap | null = null;
  trees: Tree[] = [];
  buildings = 0;
  /** POI file of a full tile, relative to the data root, if it has one. */
  poiFile: string | null = null;

  readonly animated: Uniforms[] = [];
  readonly windowMats: THREE.MeshStandardMaterial[] = [];

  private ground: GroundTextures | null = null;
  private overview: OrthoTile | null = null;
  /** What the coarse level runs on; ground and overview switch to full-size
   *  copies for full detail and back. */
  private small: { ground: GroundTextures; overview: OrthoTile | null } | null = null;
  private fullTextures: THREE.Texture[] = [];
  private deckMesh: THREE.Mesh | null = null;
  private waterMat: THREE.MeshStandardMaterial | null = null;
  /** Shared facade textures held by this tile's buildings and props. */
  private sharedKeys: string[] = [];
  private coarse: THREE.Mesh | null = null;
  private fine = new THREE.Group();
  private open = new THREE.Group();
  private chunks: { mesh: THREE.Mesh; i: number; j: number; photo: OrthoTile | null;
                    loading: boolean }[] = [];
  private textures = new Set<THREE.Texture>();
  private disposed = false;

  constructor(key: string, base: string, world: number[], manifest: TileManifest | null = null,
              version?: string) {
    this.key = key;
    this.base = base;
    this.version = version;
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

  private url(file: string): string {
    return this.base + file + (this.version ? `?v=${this.version}` : '');
  }

  private async blob(file: string): Promise<Blob> {
    const res = await fetch(this.url(file));
    if (!res.ok) throw new Error(`${this.url(file)} (${res.status})`);
    return res.blob();
  }

  private async texture(file: string, aniso: number, width?: number, data = false): Promise<THREE.Texture> {
    return this.bitmapTexture(await this.blob(file), aniso, width, data);
  }

  /**
   * The cover mask as a texture: decoded byte for byte and scaled in the
   * worker (mapworker.ts), never through the browser's image handling, which
   * does its own thing with the alpha channel - the water class.
   */
  private async coverTexture(png: Blob, scale: number, aniso: number): Promise<THREE.Texture> {
    const r = await tileJob<Raster>({ kind: 'cover', png, scale }, []);
    const tex = new THREE.DataTexture(r.data, r.w, r.h, THREE.RGBAFormat, THREE.UnsignedByteType);
    // row 0 is the north edge, i.e. the minimum z
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = aniso;
    tex.needsUpdate = true;
    // the bytes are on the GPU now; keep the size for measuring
    tex.onUpdate = () => {
      tex.userData.size = [r.w, r.h];
      (tex.image as { data: Uint8Array | null }).data = null;
    };
    this.textures.add(tex);
    return tex;
  }

  /**
   * An image as a texture, decoded off the main thread (createImageBitmap),
   * optionally straight to a smaller width, and freed from CPU memory once
   * it is on the GPU. `data` for masks: no colour management, no
   * premultiplied alpha - the cover mask's alpha is the water class.
   */
  private async bitmapTexture(blob: Blob, aniso: number, width?: number, data = false): Promise<THREE.Texture> {
    const bmp = await createImageBitmap(blob, {
      premultiplyAlpha: 'none', colorSpaceConversion: data ? 'none' : 'default',
      ...(width ? { resizeWidth: Math.max(1, Math.round(width)), resizeQuality: 'high' as const } : {}),
    });
    const tex = new THREE.Texture(bmp);
    // image row 0 is the north edge, i.e. the minimum z
    tex.flipY = false;
    tex.colorSpace = data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = aniso;
    tex.needsUpdate = true;
    closeOnUpload(tex);
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
    const [tbuf, cover, overview, bridges, water] = await Promise.all([
      fetch(this.url(m.terrain.file)).then((r) => r.arrayBuffer()),
      this.blob(m.cover.file).then((png) => this.coverTexture(png, COARSE_COVER, aniso)),
      m.ortho ? this.texture(m.ortho.overview.file, aniso, m.ortho.overview.w * COARSE_PHOTO)
              : Promise.resolve(null),
      m.bridges ? fetch(this.url(m.bridges.file)).then((r) => r.json()) : Promise.resolve(null),
      m.water ? fetch(this.url(m.water.file)).then((r) => r.json()) : Promise.resolve(null),
    ]);
    if (this.disposed) return;
    this.terrain = new TerrainField(tbuf);
    if (bridges) this.decks = new Decks(bridges);
    const t = this.terrain;
    const under = this.decks && this.decks.footprint(t.minX, t.minZ, t.nx, t.nz);
    if (under) this.textures.add(under.map);
    this.ground = {
      ...shared, cover,
      coverMin: new THREE.Vector2(m.cover.minX, m.cover.minZ),
      coverSize: new THREE.Vector2(m.cover.w * m.cover.res, m.cover.h * m.cover.res),
      ...(under ? { under } : {}),
    };
    if (overview && m.ortho) {
      this.overview = { map: overview, min: new THREE.Vector2(m.ortho.minX, m.ortho.minZ),
                        size: m.ortho.overview.w * m.ortho.overview.res };
    }
    this.small = { ground: this.ground, overview: this.overview };
    for (const tex of [cover, overview]) if (tex) await upload(tex);
    if (this.disposed) return;
    this.buildCoarse();
    this.setDecks();
    if (water) {
      const mat = waterMaterial();
      this.animated.push(mat.userData as Uniforms);
      const mesh = waterMesh(water, this.bounds[0], this.bounds[1], mat);
      freeOnUpload(mesh.geometry);
      this.group.add(mesh);
      this.waterMat = mat;
    }
    this.level = 'coarse';
  }

  /** The deck slabs, wearing whichever overview photo the tile has now. */
  private setDecks(): void {
    if (!this.decks) return;
    if (this.deckMesh) {
      this.deckMesh.geometry.dispose();
      (this.deckMesh.material as THREE.Material).dispose();
      this.deckMesh.removeFromParent();
    }
    this.deckMesh = this.decks.mesh(this.bounds[0], this.bounds[1], this.overview ?? undefined);
    freeOnUpload(this.deckMesh.geometry);
    this.group.add(this.deckMesh);
  }

  /**
   * Everything else, on top of loadCoarse(). Built a few milliseconds at a
   * time across frames (see frames.ts), out of sight until complete; given
   * up, and tidied away, if the tile is dropped meanwhile.
   */
  async loadFull(aniso: number): Promise<void> {
    const m = this.manifest!;
    const live = () => !this.disposed && this.level === 'coarse';
    this.fine.visible = this.open.visible = false;
    const [nbuf, tbuf, gltf, props, coverBlob, overview] = await Promise.all([
      fetch(this.url(m.nav.file)).then((r) => r.arrayBuffer()),
      fetch(this.url(m.trees.file)).then((r) => r.arrayBuffer()),
      m.buildings ? new GLTFLoader().loadAsync(this.url(m.buildings.file)) : Promise.resolve(null),
      m.props ? Promise.all([
        new GLTFLoader().loadAsync(this.url(m.props.models)),
        fetch(this.url(m.props.file)).then((r) => r.arrayBuffer()),
      ]) : Promise.resolve(null),
      this.blob(m.cover.file),
      m.ortho ? this.texture(m.ortho.overview.file, aniso, m.ortho.overview.w * FULL_PHOTO)
              : Promise.resolve(null),
    ]);
    if (overview) this.fullTextures.push(overview);
    if (!live()) return this.unloadFull();
    // full-size ground textures in place of the coarse level's small ones
    const cover = await this.coverTexture(coverBlob, FULL_COVER, aniso);
    this.fullTextures.push(cover);
    for (const tex of this.fullTextures) await upload(tex);
    if (!live()) return this.unloadFull();
    this.ground = { ...this.small!.ground, cover };
    if (overview && this.small!.overview) this.overview = { ...this.small!.overview, map: overview };

    this.nav = new NavGrid(nbuf);
    this.trees = parseTrees(tbuf);
    await this.buildFine();
    if (!live()) return this.unloadFull();
    if (gltf) {
      if (m.buildings?.packed) await this.addPackedBuildings(gltf, aniso);
      else await this.buildBuildings(gltf, aniso);
    }
    if (!live()) return this.unloadFull();
    this.buildTrees();
    await breathe();
    if (props && m.props) await this.buildProps(props[0], props[1], m.props.kinds, aniso);
    if (!live()) return this.unloadFull();
    const map = await this.buildMap(coverBlob);
    if (!live()) { map.close(); return this.unloadFull(); }
    this.map = map;
    this.setDecks();
    this.buildings = m.buildings?.count ?? 0;
    this.poiFile = m.pois ? this.url(m.pois) : null;
    if (this.coarse) this.coarse.visible = false;
    this.fine.visible = this.open.visible = true;
    this.level = 'full';
  }

  /** Back to coarse: drop everything loadFull() added. */
  dropFull(): void {
    if (this.level !== 'full') return;
    this.unloadFull();
    if (!this.disposed) this.setDecks();
  }

  /** Whatever full detail has built so far, gone again; the coarse level's
   *  small textures back in place. */
  private unloadFull(): void {
    for (const c of this.chunks) this.releasePhoto(c);
    this.chunks = [];
    for (const g of [this.fine, this.open]) {
      disposeTree(g, this.textures);
      g.clear();
    }
    this.windowMats.length = 0;
    for (const key of this.sharedKeys) sharedTextures.release(key);
    this.sharedKeys = [];
    for (const tex of this.fullTextures) {
      tex.dispose();
      this.textures.delete(tex);
    }
    this.fullTextures = [];
    if (this.small) {
      this.ground = this.small.ground;
      this.overview = this.small.overview;
    }
    // only the coarse level's animated materials are left
    const coarse = this.coarse?.material as THREE.MeshStandardMaterial | undefined;
    this.animated.splice(0, this.animated.length,
      ...[coarse, this.waterMat].filter((x) => x).map((x) => x!.userData as Uniforms));
    this.nav = null;
    this.map?.close();
    this.map = null;
    this.trees = [];
    this.buildings = 0;
    this.poiFile = null;
    if (this.coarse) this.coarse.visible = true;
    if (this.level === 'full') this.level = 'coarse';
  }

  dispose(): void {
    this.disposed = true;
    this.unloadFull();
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
    const geo = this.terrainGeometry(0, 0, nx, nz, COARSE_STEP, gridIndex(nx, nz));
    freeOnUpload(geo);
    const mesh = new THREE.Mesh(geo, this.terrainMat(this.overview));
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    this.coarse = mesh;
    this.group.add(mesh);
  }

  /** 1 m meshes, one per orthophoto chunk, under the overview until close.
   *  All chunks share one index: they are the same grid. */
  private async buildFine(): Promise<void> {
    const t = this.terrain!;
    const n = TERRAIN_CHUNK + 1;
    const index = gridIndex(n, n);
    for (let cz = 0; cz < t.nz - 1; cz += TERRAIN_CHUNK) {
      for (let cx = 0; cx < t.nx - 1; cx += TERRAIN_CHUNK) {
        const geo = this.terrainGeometry(cx, cz, n, n, 1, index);
        // the shared index stays: every chunk's upload needs it
        freeOnUpload(geo, true);
        const mesh = new THREE.Mesh(geo, this.terrainMat(this.overview));
        mesh.receiveShadow = true;
        mesh.name = 'terrain';
        this.fine.add(mesh);
        this.chunks.push({ mesh, i: cx / TERRAIN_CHUNK, j: cz / TERRAIN_CHUNK,
                           photo: null, loading: false });
        await breathe();
        if (this.disposed) return;
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
                          step: number, index: THREE.BufferAttribute): THREE.BufferGeometry {
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
  private async buildBuildings(gltf: { scene: THREE.Group }, aniso: number): Promise<void> {
    gltf.scene.updateMatrixWorld(true);
    const groups = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
    const toTile = new THREE.Matrix4().makeTranslation(-this.bounds[0], 0, -this.bounds[1]);
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    for (const mesh of meshes) {
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
      mesh.geometry.dispose();
      await breathe();
      if (this.disposed) return;
    }
    // the same facade textures come with every tile: keep one copy of each
    this.sharedKeys.push(...shareMaterialTextures(new Set([...groups.values()].map((g) => g.mat))));

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
      await breathe();
      if (!merged) continue;
      merged.computeBoundingSphere();
      freeOnUpload(merged);
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
   * Buildings from a packed file: already one mesh per (chunk, material),
   * tile-relative. Taken over as they are - nothing to clone or merge.
   */
  private async addPackedBuildings(gltf: { scene: THREE.Group }, aniso: number): Promise<void> {
    const meshes: THREE.Mesh[] = [];
    gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    this.sharedKeys.push(...shareMaterialTextures(new Set(meshes.map((m) => m.material as THREE.Material))));
    const done = new Set<THREE.Material>();
    for (const mesh of meshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!done.has(mat)) {
        done.add(mat);
        // upward faces take the orthophoto, as in buildBuildings
        if (this.overview) {
          photoRoofs(mat, this.overview.map, this.overview.min,
                     new THREE.Vector2(this.overview.size, this.overview.size));
        }
        for (const tex of [mat.map, mat.normalMap, mat.roughnessMap, mat.aoMap]) {
          if (tex) tex.anisotropy = aniso;
        }
        // OSM2World's window layer: lit from inside after dark
        if (mat.name?.startsWith('Windows') && mat.map) {
          mat.emissiveMap = mat.map;
          mat.emissive = new THREE.Color(0, 0, 0);
          this.windowMats.push(mat);
        }
      }
      mesh.geometry.computeBoundingSphere();
      freeOnUpload(mesh.geometry);
      mesh.removeFromParent();
      mesh.position.set(0, 0, 0);
      mesh.updateMatrix();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'buildings';
      this.open.add(mesh);
      await breathe();
      if (this.disposed) return;
    }
  }

  /**
   * Street furniture: one OSM2World prototype per kind, copied to every
   * surveyed position. Most kinds have only a handful of copies (a sign
   * combination often just one), so instancing would cost a draw call per
   * kind; instead the copies are baked and merged per material.
   */
  private async buildProps(gltf: { scene: THREE.Group }, buf: ArrayBuffer, kinds: string[],
                           aniso: number): Promise<void> {
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
    this.sharedKeys.push(...shareMaterialTextures(new Set([...groups.values()].map((g) => g.mat))));
    for (const { mat, geos } of groups.values()) {
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      await breathe();
      if (!merged) continue;
      merged.computeBoundingSphere();
      freeOnUpload(merged);
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

  /** 1 px = 1 m top-down map of the tile: ground cover plus building
   *  footprints, drawn by mapworker.ts from the cover mask already loaded. */
  private buildMap(cover: Blob): Promise<ImageBitmap> {
    const n = this.nav!;
    const cv = this.manifest!.cover;
    const job: MapJob = {
      kind: 'map', png: cover, coverMin: [cv.minX, cv.minZ], coverRes: cv.res,
      navMin: [n.minX, n.minZ], navCell: n.cell, nx: n.nx, nz: n.nz,
      terrain: n.terrain.slice(), flags: n.flags.slice(), buildingFlag: NavGrid.BUILDING,
    };
    return tileJob<ImageBitmap>(job, [job.terrain.buffer, job.flags.buffer]);
  }
}

/* --- helpers --------------------------------------------------------------- */

let worker: Worker | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** One job at a time on the shared tile worker (mapworker.ts). */
function tileJob<T>(job: CoverJob | MapJob, transfer: Transferable[]): Promise<T> {
  worker ??= new Worker(new URL('./mapworker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const next = queue.then(() => new Promise<T>((resolve, reject) => {
    w.onmessage = (e: MessageEvent<{ ok?: T; error?: string }>) =>
      (e.data.error !== undefined ? reject(new Error(e.data.error)) : resolve(e.data.ok as T));
    w.onerror = (e) => reject(new Error(e.message));
    w.postMessage(job, transfer);
  }));
  queue = next.catch(() => undefined);
  return next;
}

/** Triangle indices of an nx x nz vertex grid, two triangles a cell. */
function gridIndex(nx: number, nz: number): THREE.BufferAttribute {
  const n = (nx - 1) * (nz - 1) * 6;
  const index = nx * nz > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  let k = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      index[k++] = a; index[k++] = c; index[k++] = b;
      index[k++] = b; index[k++] = c; index[k++] = d;
    }
  }
  return new THREE.BufferAttribute(index, 1);
}

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
        if (tex && !owned.has(tex) && !sharedTextures.has(tex)) tex.dispose();
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
