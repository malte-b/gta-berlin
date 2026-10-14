import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Origin, XZ } from './geo';
import { NavGrid, TerrainField, parseProps, parseTrees, type Tree } from './tiles';
import { crownMaterial, photoRoofs, terrainMaterial, trunkMaterial,
         type GroundKind, type GroundTextures, type OrthoTile } from './materials';

const DATA = 'data/';
const TERRAIN_CHUNK = 100;          // metres per terrain mesh, for culling

/** world.json, written by pipeline/build_world.py. */
export interface Manifest {
  kind: string;
  origin: Origin;
  world: [number, number, number, number, number, number];
  centre: { x: number; z: number; lon: number; lat: number };
  terrain: { file: string; minX: number; minZ: number; cell: number; nx: number; nz: number };
  cover: { file: string; minX: number; minZ: number; res: number; w: number; h: number };
  groundTextures: Record<GroundKind, { color: string; normal: string }>;
  buildings: { file: string; chunk: number; count: number; triangles: number };
  trees: { file: string; count: number };
  /** Sky HDRI for image-based lighting; absent in older builds. */
  environment?: { file: string; source: string };
  /** Street furniture; absent in builds made before it was added. */
  props?: { file: string; models: string; kinds: string[]; count: number };
  /** True orthophotos; absent in builds made before they were added. */
  ortho?: {
    chunk: number; res: number; nx: number; nz: number; minX: number; minZ: number;
    tile: string;
    overview: { file: string; res: number; w: number; h: number };
  };
  nav: { file: string };
  spawn?: { x: number; z: number; heading?: number; facing?: string };
  attribution: string[];
}

export interface Env {
  night: number;
  time: number;
}

/**
 * The world: laser-scan terrain, OSM2World buildings, cadastre trees and
 * street furniture.
 *
 * The whole area is small enough (about 1.2 km2, ~18 MB) to load at once, so
 * there is no streaming. What matters for frame time is draw calls: the
 * buildings arrive as one glTF node per building with a mesh per material,
 * several thousand meshes in all, and are merged here into one mesh per
 * (chunk, material). Chunks keep frustum culling useful; merging keeps the
 * draw count in the low hundreds.
 */
export class World {
  readonly scene: THREE.Scene;
  manifest!: Manifest;
  origin!: Origin;
  world!: Manifest['world'];
  centre!: Manifest['centre'];
  spawnPoint!: { x: number; z: number; heading?: number };
  terrain!: TerrainField;
  nav!: NavGrid;
  trees: Tree[] = [];
  /** Top-down map image (1 px per metre) for the HUD. */
  map: HTMLCanvasElement | null = null;

  private readonly animated: { uniforms: Record<string, THREE.IUniform> }[] = [];
  private readonly windowMats: THREE.MeshStandardMaterial[] = [];
  private loaded = { buildings: 0, chunks: 0 };

  /** The open-data scene - terrain, OSM2World buildings, cadastre trees -
   *  kept in one group so it can be swapped for the photogrammetric mesh. */
  readonly open = new THREE.Group();
  /** The draped terrain on its own, so the mesh view can use it as an
   *  underlay that shows through holes in the cleaned mesh. */
  readonly ground = new THREE.Group();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    scene.add(this.open, this.ground);
  }

  async init(onProgress: (msg: string) => void, renderer: THREE.WebGLRenderer): Promise<this> {
    this.manifest = await fetch(DATA + 'world.json').then((r) => r.json()) as Manifest;
    const m = this.manifest;
    this.origin = m.origin;
    this.world = m.world;
    this.centre = m.centre;
    this.spawnPoint = m.spawn ?? { x: m.centre.x, z: m.centre.z };
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    onProgress('terrain and navigation');
    const [tbuf, nbuf] = await Promise.all([
      fetch(DATA + m.terrain.file).then((r) => r.arrayBuffer()),
      fetch(DATA + m.nav.file).then((r) => r.arrayBuffer()),
    ]);
    this.terrain = new TerrainField(tbuf);
    this.nav = new NavGrid(nbuf);

    onProgress('ground textures');
    const ground = await this.loadGround(aniso);
    onProgress('orthophotos');
    const photo = await this.loadOrtho(aniso);
    this.buildTerrain(ground, photo?.tiles);

    onProgress('buildings');
    await this.loadBuildings(aniso, (f) => onProgress(`buildings ${Math.round(f * 100)}%`),
                             photo?.roofs);

    onProgress('trees');
    const trees = await fetch(DATA + m.trees.file).then((r) => r.arrayBuffer());
    this.trees = parseTrees(trees);
    this.buildTrees();

    if (m.props) {
      onProgress('street furniture');
      await this.loadProps(m.props, aniso);
    }

    onProgress('map');
    this.map = await this.buildMap();
    return this;
  }

  /* --- loading ---------------------------------------------------------- */

  private async loadGround(aniso: number): Promise<GroundTextures> {
    const loader = new THREE.TextureLoader();
    const load = (file: string, srgb: boolean) => loader.loadAsync(DATA + file).then((t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = aniso;
      return t;
    });
    const kinds = Object.keys(this.manifest.groundTextures) as GroundKind[];
    const color = {} as Record<GroundKind, THREE.Texture>;
    const normal = {} as Record<GroundKind, THREE.Texture>;
    await Promise.all(kinds.flatMap((k) => [
      load(this.manifest.groundTextures[k].color, true).then((t) => { color[k] = t; }),
      load(this.manifest.groundTextures[k].normal, false).then((t) => { normal[k] = t; }),
    ]));
    const c = this.manifest.cover;
    const cover = await loader.loadAsync(DATA + c.file);
    // The mask is data, not colour. Row 0 of the PNG is the north edge, which
    // is the grid's minimum z, so it must not be flipped on upload.
    cover.colorSpace = THREE.NoColorSpace;
    cover.flipY = false;
    cover.wrapS = cover.wrapT = THREE.ClampToEdgeWrapping;
    cover.anisotropy = aniso;
    cover.needsUpdate = true;
    return {
      cover, color, normal,
      coverMin: new THREE.Vector2(c.minX, c.minZ),
      coverSize: new THREE.Vector2(c.w * c.res, c.h * c.res),
    };
  }

  /** One orthophoto tile per terrain chunk, plus the whole-area overview the
   *  roofs are coloured from. Null for builds without orthophotos. */
  private async loadOrtho(aniso: number): Promise<{
    tiles: Map<string, OrthoTile>;
    roofs: { map: THREE.Texture; min: THREE.Vector2; size: THREE.Vector2 };
  } | null> {
    const o = this.manifest.ortho;
    if (!o) return null;
    const loader = new THREE.TextureLoader();
    const load = async (file: string) => {
      const tex = await loader.loadAsync(DATA + file);
      tex.colorSpace = THREE.SRGBColorSpace;
      // image row 0 is the north edge, i.e. the tile's minimum z
      tex.flipY = false;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = aniso;
      tex.needsUpdate = true;
      return tex;
    };
    const tiles = new Map<string, OrthoTile>();
    const jobs: Promise<void>[] = [];
    for (let j = 0; j < o.nz; j++) {
      for (let i = 0; i < o.nx; i++) {
        jobs.push(load(o.tile.replace('{i}', String(i)).replace('{j}', String(j))).then((map) => {
          tiles.set(`${i}_${j}`, { map, size: o.chunk,
            min: new THREE.Vector2(o.minX + i * o.chunk, o.minZ + j * o.chunk) });
        }));
      }
    }
    const [overview] = await Promise.all([load(o.overview.file), ...jobs]);
    return {
      tiles,
      roofs: { map: overview, min: new THREE.Vector2(o.minX, o.minZ),
               size: new THREE.Vector2(o.overview.w * o.overview.res, o.overview.h * o.overview.res) },
    };
  }

  /** Terrain meshes at the laser scan's own 1 m resolution, one per chunk,
   *  each with the orthophoto tile that covers it. */
  private buildTerrain(ground: GroundTextures, photos?: Map<string, OrthoTile>): void {
    const t = this.terrain;
    const plain = terrainMaterial(ground);
    this.animated.push(plain.userData as { uniforms: Record<string, THREE.IUniform> });
    const n = TERRAIN_CHUNK + 1;
    const index: number[] = [];
    for (let j = 0; j < TERRAIN_CHUNK; j++) {
      for (let i = 0; i < TERRAIN_CHUNK; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    const indexAttr = new THREE.Uint16BufferAttribute(index, 1);
    for (let cz = 0; cz < t.nz - 1; cz += TERRAIN_CHUNK) {
      for (let cx = 0; cx < t.nx - 1; cx += TERRAIN_CHUNK) {
        const pos = new Float32Array(n * n * 3);
        const nor = new Float32Array(n * n * 3);
        let p = 0;
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const gi = Math.min(cx + i, t.nx - 1);
            const gj = Math.min(cz + j, t.nz - 1);
            // vertices sit on cell centres, where the samples are
            pos[p] = t.minX + (gi + 0.5) * t.cell;
            pos[p + 1] = t.at(gi, gj);
            pos[p + 2] = t.minZ + (gj + 0.5) * t.cell;
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
        geo.setIndex(indexAttr);
        geo.computeBoundingSphere();
        const tile = photos?.get(`${cx / TERRAIN_CHUNK}_${cz / TERRAIN_CHUNK}`);
        let mat = plain;
        if (tile) {
          mat = terrainMaterial(ground, tile);
          this.animated.push(mat.userData as { uniforms: Record<string, THREE.IUniform> });
        }
        const mesh = new THREE.Mesh(geo, mat);
        mesh.receiveShadow = true;
        mesh.name = 'terrain';
        this.ground.add(mesh);
      }
    }
  }

  private async loadBuildings(
    aniso: number, onProgress: (f: number) => void,
    roofs?: { map: THREE.Texture; min: THREE.Vector2; size: THREE.Vector2 },
  ): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(
      DATA + this.manifest.buildings.file,
      (e) => { if (e.total) onProgress(e.loaded / e.total); });
    gltf.scene.updateMatrixWorld(true);

    const groups = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
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
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      // mergeGeometries needs identical attribute sets
      for (const name of Object.keys(geo.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
      }
      if (!geo.attributes.uv) {
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(
          new Float32Array(geo.attributes.position.count * 2), 2));
      }
      if (!geo.attributes.normal) geo.computeVertexNormals();
      g.geos.push(geo.index ? geo : geo.setIndex(
        [...Array(geo.attributes.position.count).keys()]));
      this.loaded.buildings++;
    });

    // every building material takes its upward faces from the orthophoto
    if (roofs) {
      const seen = new Set<THREE.Material>();
      for (const { mat } of groups.values()) {
        if (seen.has(mat)) continue;
        seen.add(mat);
        photoRoofs(mat, roofs.map, roofs.min, roofs.size);
      }
    }

    for (const { mat, geos } of groups.values()) {
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      for (const g of geos) g.dispose();
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
      this.loaded.chunks++;
    }
  }

  /**
   * Street furniture: one OSM2World prototype per kind, copied to every
   * surveyed position. Most kinds have only a handful of copies (a sign
   * combination often just one), so instancing would cost a draw call per
   * kind; instead the copies are baked and merged per (chunk, material), the
   * same way the buildings are.
   */
  private async loadProps(p: NonNullable<Manifest['props']>, aniso: number): Promise<void> {
    const [gltf, buf] = await Promise.all([
      new GLTFLoader().loadAsync(DATA + p.models),
      fetch(DATA + p.file).then((r) => r.arrayBuffer()),
    ]);
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
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      for (const name of Object.keys(geo.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
      }
      if (!geo.attributes.uv) {
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(
          new Float32Array(geo.attributes.position.count * 2), 2));
      }
      if (!geo.attributes.normal) geo.computeVertexNormals();
      if (!geo.index) geo.setIndex([...Array(geo.attributes.position.count).keys()]);
      const list = parts.get(kind) ?? [];
      list.push({ geo, mat: mesh.material as THREE.Material });
      parts.set(kind, list);
    });

    const chunk = this.manifest.buildings.chunk;
    const groups = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    for (const prop of parseProps(buf)) {
      const list = parts.get(p.kinds[prop.kind]);
      if (!list) continue;
      m.compose(new THREE.Vector3(prop.x, prop.y, prop.z), q.setFromAxisAngle(up, prop.yaw), one);
      const c = `${Math.floor((prop.x - this.world[0]) / chunk)}_${Math.floor((prop.z - this.world[2]) / chunk)}`;
      for (const { geo, mat } of list) {
        const key = `${c}|${mat.uuid}`;
        let g = groups.get(key);
        if (!g) { g = { mat, geos: [] }; groups.set(key, g); }
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
    const broad = this.trees.filter((t) => t.form !== 1);
    const conifer = this.trees.filter((t) => t.form === 1);

    const trunkGeo = new THREE.CylinderGeometry(0.36, 0.5, 1, 7, 1).translate(0, 0.5, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMaterial(), this.trees.length);
    const crowns = new THREE.InstancedMesh(crownGeometry(), crownMaterial(), broad.length);
    const cones = new THREE.InstancedMesh(
      coneGeometry(), crownMaterial(), conifer.length);

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
      q.setFromAxisAngle(up, rnd * Math.PI * 2);
      m.compose(new THREE.Vector3(t.x, t.y - 0.2, t.z), q,
                new THREE.Vector3(d, base + crownH * 0.45, d));
      trunks.setMatrixAt(ti++, m);

      leafColour(col, t, rnd);
      const r = t.crown / 2;
      if (t.form === 1) {
        m.compose(new THREE.Vector3(t.x, t.y + base, t.z), q, new THREE.Vector3(r, crownH, r));
        cones.setMatrixAt(ci, m);
        cones.setColorAt(ci++, col);
      } else {
        m.compose(new THREE.Vector3(t.x, t.y + base + crownH / 2, t.z), q,
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

  /** 1 px = 1 m top-down map: ground cover plus building footprints. */
  private async buildMap(): Promise<HTMLCanvasElement> {
    const n = this.nav;
    const c = document.createElement('canvas');
    c.width = n.nx;
    c.height = n.nz;
    const g = c.getContext('2d')!;
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = DATA + this.manifest.cover.file;
    });
    // read the mask's four channels back as plain bytes
    const tmp = document.createElement('canvas');
    tmp.width = n.nx;
    tmp.height = n.nz;
    const tg = tmp.getContext('2d', { willReadFrequently: true })!;
    tg.drawImage(img, 0, 0, n.nx, n.nz);
    const cover = tg.getImageData(0, 0, n.nx, n.nz).data;
    const out = g.createImageData(n.nx, n.nz);
    const t = this.terrain;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < t.data.length; k += 13) {
      lo = Math.min(lo, t.data[k]); hi = Math.max(hi, t.data[k]);
    }
    for (let k = 0; k < n.nx * n.nz; k++) {
      const o = k * 4;
      const rel = (t.data[k] - lo) / Math.max(1, hi - lo);
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

  /* --- queries ----------------------------------------------------------- */

  /** Bare-earth ground height in world metres. */
  height(x: number, z: number): number {
    return this.terrain.contains(x, z) ? this.terrain.height(x, z) : this.terrain.height(
      Math.min(Math.max(x, this.terrain.minX), this.terrain.minX + this.terrain.nx - 1),
      Math.min(Math.max(z, this.terrain.minZ), this.terrain.minZ + this.terrain.nz - 1));
  }

  /** What things painted on the ground should follow. With a bare-earth
   *  terrain this is the same as height(). */
  surfaceHeight(x: number, z: number): number {
    return this.height(x, z);
  }

  inWorld(x: number, z: number): boolean {
    return this.nav.contains(x, z);
  }

  solid(x: number, z: number, driving = false): boolean {
    return !this.nav.passable(x, z, driving);
  }

  canStep(_fx: number, _fz: number, toX: number, toZ: number, driving = false): boolean {
    return this.nav.passable(toX, toZ, driving);
  }

  freeSpot(x: number, z: number, maxR = 120, driving = false): XZ {
    return this.nav.nearestPassable(x, z, driving, maxR) ?? [x, z];
  }

  /** Is a camera at this point inside something? Used to pull the third-person
   *  boom in rather than let it clip into a wall. */
  blocksCamera(x: number, y: number, z: number): boolean {
    if (y < this.height(x, z) + 0.55) return true;
    return this.nav.has(x, z, NavGrid.BUILDING);
  }

  /* --- per frame --------------------------------------------------------- */

  setEnv({ night, time }: Env): void {
    for (const a of this.animated) {
      if (a.uniforms.uTime) a.uniforms.uTime.value = time;
    }
    // windows warm up after dark; the lit fraction is the texture's own
    // brightness, so frames stay dark and panes glow
    for (const w of this.windowMats) {
      w.emissive.setRGB(1.0, 0.72, 0.42).multiplyScalar(night * 0.9);
    }
  }

  get stats(): { buildings: number; meshes: number; trees: number } {
    return { buildings: this.manifest.buildings.count, meshes: this.loaded.chunks,
             trees: this.trees.length };
  }
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

/**
 * A unit crown (radius 1, centred) built from a cluster of displaced spheres,
 * so the silhouette is lumpy rather than a ball. Vertex colours carry a baked
 * occlusion term: darker underneath and toward the core.
 */
function crownGeometry(): THREE.BufferGeometry {
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
}

/** Unit conifer: base radius 1 at y = 0, tip at y = 1, in three tiers. */
function coneGeometry(): THREE.BufferGeometry {
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
}
