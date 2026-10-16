import * as THREE from 'three';
import type { PointLayer } from './layers';
import type { World } from './world';

/**
 * Street names and points of interest, read from a file baked at build time.
 *
 * pipeline/build_pois.py queries Overpass once and writes pois.json with
 * everything already projected into world metres, so the running game never
 * touches the API and needs no runtime reprojection.
 *
 * Labels are canvas textures, created lazily the first time a given string is
 * needed and then cached - there are only about 115 distinct street names in
 * the covered area, so the cache converges almost immediately. Only labels
 * within a radius of the camera are mounted, which keeps a few hundred POIs
 * from becoming a few hundred draw calls.
 */

type Category = 'refresh' | 'food' | 'shop' | 'culture' | 'transit' | 'green';

interface Poi { x: number; z: number; n: string; c: Category }
interface StreetSpot { x: number; z: number; a: number }
interface Street { name: string; major: boolean; at: StreetSpot[] }
interface PoiData { streets: Street[]; pois: Poi[] }
interface Label { tex: THREE.CanvasTexture; w: number; h: number }

const CATEGORY_STYLE: Record<Category, { colour: string; dot: number; label: string }> = {
  refresh: { colour: '#5ec8e5', dot: 0x5ec8e5, label: 'refreshment' },
  food:    { colour: '#ffb454', dot: 0xffb454, label: 'food & drink' },
  shop:    { colour: '#e58fd0', dot: 0xe58fd0, label: 'shops' },
  culture: { colour: '#b39ddf', dot: 0xb39ddf, label: 'culture' },
  transit: { colour: '#8fd694', dot: 0x8fd694, label: 'transit' },
  green:   { colour: '#7fc47f', dot: 0x7fc47f, label: 'parks' },
};

const POI_RADIUS = 130;
const STREET_RADIUS = 170;
const MAX_POI_SPRITES = 70;
// Data layers are looked for rather than stumbled upon: they reach further,
// and stand taller, than the OSM places.
const DATA_RADIUS = 320;
const MAX_DATA_SPRITES = 45;

function labelTexture(text: string, colour: string, scale = 1, sub = ''): Label {
  const pad = 12;
  const font = `600 ${Math.round(30 * scale)}px ui-monospace, Menlo, monospace`;
  const small = `400 ${Math.round(22 * scale)}px ui-monospace, Menlo, monospace`;
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = font;
  let tw = probe.measureText(text).width;
  if (sub) {
    probe.font = small;
    tw = Math.max(tw, probe.measureText(sub).width);
  }
  const w = Math.ceil(tw) + pad * 2;
  const h = Math.round((sub ? 76 : 46) * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.font = font;
  g.textBaseline = 'middle';
  // dark plate keeps the text legible over any photograph underneath
  g.fillStyle = 'rgba(14,16,21,.78)';
  g.beginPath();
  const r = 8;
  g.moveTo(r, 0); g.arcTo(w, 0, w, h, r); g.arcTo(w, h, 0, h, r);
  g.arcTo(0, h, 0, 0, r); g.arcTo(0, 0, w, 0, r); g.closePath();
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,.16)';
  g.lineWidth = 1.5;
  g.stroke();
  g.fillStyle = colour;
  if (sub) {
    g.fillText(text, pad, 25 * scale);
    g.font = small;
    g.fillStyle = 'rgba(232,230,225,.75)';
    g.fillText(sub, pad, 55 * scale);
  } else {
    g.fillText(text, pad, h / 2 + 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, w, h };
}

function streetTexture(text: string): Label {
  const font = '700 40px ui-monospace, Menlo, monospace';
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = font;
  const w = Math.ceil(probe.measureText(text).width) + 40;
  const h = 64;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // painted onto the road surface, so it needs an outline rather than a plate
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(12,14,18,.85)';
  g.strokeText(text, w / 2, h / 2);
  g.fillStyle = '#f2efe8';
  g.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return { tex, w, h };
}

export class PoiLayer {
  readonly scene: THREE.Scene;
  readonly world: World;
  private readonly sets = new Map<string, PoiData>();
  showPois = true;
  showStreets = true;
  readonly enabled = new Set<string>(Object.keys(CATEGORY_STYLE));
  readonly group = new THREE.Group();
  readonly streetGroup = new THREE.Group();
  private readonly texCache = new Map<string, Label>();
  private readonly streetCache = new Map<string, Label>();
  private readonly mounted = new Map<string, THREE.Object3D>();
  private readonly streetMounted = new Map<string, THREE.Mesh | null>();
  /** Point layers from data/layers/ and uploads, by id, in display order. */
  readonly layers = new Map<string, PointLayer>();
  readonly dataGroup = new THREE.Group();
  private readonly dataMounted = new Map<string, THREE.Object3D>();

  constructor(scene: THREE.Scene, world: World) {
    this.scene = scene;
    this.world = world;
    scene.add(this.group, this.streetGroup, this.dataGroup);
  }

  addLayer(layer: PointLayer): void {
    this.layers.set(layer.id, layer);
  }

  removeLayer(id: string): void {
    this.layers.delete(id);
  }

  /** Visible data points within r of (x, z), for the minimap. */
  *dataNear(x: number, z: number, r: number): Generator<[PointLayer, number, number]> {
    for (const l of this.layers.values()) {
      if (!l.on) continue;
      for (const p of l.points) {
        if (Math.abs(p.x - x) < r && Math.abs(p.z - z) < r) yield [l, p.x, p.z];
      }
    }
  }

  /** Labels for one tile; a single-area build has just one set. */
  async add(key: string, url: string): Promise<void> {
    try {
      const data = await fetch(url).then((r) => r.json()) as PoiData;
      this.sets.set(key, data);
    } catch {
      // a tile without labels is still a tile
    }
  }

  remove(key: string): void {
    this.sets.delete(key);
  }

  get categories() {
    return Object.entries(CATEGORY_STYLE).map(([k, v]) => ({
      key: k, label: v.label, colour: v.colour, on: this.enabled.has(k),
    }));
  }

  toggleCategory(key: string): void {
    if (this.enabled.has(key)) this.enabled.delete(key);
    else this.enabled.add(key);
    this.clearPois();
  }

  private poiSprite(p: Poi): THREE.Group {
    const style = CATEGORY_STYLE[p.c] ?? CATEGORY_STYLE.shop;
    const cacheKey = `${p.n}|${p.c}`;
    let entry = this.texCache.get(cacheKey);
    if (!entry) {
      entry = labelTexture(p.n, style.colour);
      this.texCache.set(cacheKey, entry);
    }
    const g = new THREE.Group();
    // Depth-tested text gets sliced in half by whatever building happens to be
    // in front of it. Map labels are drawn over the scene instead; the dot and
    // stem below keep their depth test, so the marker still reads as being at a
    // place in space rather than floating free.
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: entry.tex, depthTest: false, depthWrite: false,
      transparent: true, sizeAttenuation: true,
    }));
    spr.renderOrder = 20;
    const scale = 0.028;
    spr.scale.set(entry.w * scale, entry.h * scale, 1);
    spr.position.y = 2.5;
    g.add(spr);

    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 8, 6),
      new THREE.MeshBasicMaterial({ color: style.dot }),
    );
    dot.position.y = 1.5;
    g.add(dot);

    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 1.5, 5),
      new THREE.MeshBasicMaterial({ color: style.dot, transparent: true, opacity: 0.55 }),
    );
    stem.position.y = 0.75;
    g.add(stem);
    return g;
  }

  /** A data point: a tall pin in the layer's colour, its label above. */
  private dataSprite(layer: PointLayer, n: string, d: string): THREE.Group {
    const cacheKey = `data|${layer.colour}|${n}|${d}`;
    let entry = this.texCache.get(cacheKey);
    if (!entry) {
      entry = labelTexture(n, layer.colour, 1, d);
      this.texCache.set(cacheKey, entry);
    }
    const g = new THREE.Group();
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: entry.tex, depthTest: false, depthWrite: false,
      transparent: true, sizeAttenuation: true,
    }));
    spr.renderOrder = 21;
    const scale = 0.034;
    spr.scale.set(entry.w * scale, entry.h * scale, 1);
    spr.position.y = 5.2;
    g.add(spr);
    const colour = new THREE.Color(layer.colour);
    const head = new THREE.Mesh(new THREE.OctahedronGeometry(0.42, 0),
                                new THREE.MeshBasicMaterial({ color: colour }));
    head.position.y = 3.6;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.4, 6),
                                new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.6 }));
    stem.position.y = 1.7;
    g.add(head, stem);
    return g;
  }

  private updateData(x: number, z: number): void {
    const near: [number, PointLayer, { x: number; z: number; n: string; d: string }][] = [];
    for (const l of this.layers.values()) {
      if (!l.on) continue;
      for (const p of l.points) {
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < DATA_RADIUS * DATA_RADIUS) near.push([d, l, p]);
      }
    }
    near.sort((a, b) => a[0] - b[0]);
    const wanted = new Set<string>();
    for (const [, l, p] of near.slice(0, MAX_DATA_SPRITES)) {
      const key = `${l.id}|${p.x},${p.z},${p.n}`;
      wanted.add(key);
      if (this.dataMounted.has(key)) continue;
      const obj = this.dataSprite(l, p.n, p.d);
      obj.position.set(p.x, this.world.height(p.x, p.z), p.z);
      this.dataMounted.set(key, obj);
      this.dataGroup.add(obj);
    }
    for (const [key, obj] of [...this.dataMounted]) {
      if (wanted.has(key)) continue;
      this.dataGroup.remove(obj);
      // the label texture stays cached; the pin's own parts go
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (m.material as THREE.Material).dispose();
      });
      this.dataMounted.delete(key);
    }
  }

  /**
   * A street name painted onto the road.
   *
   * A single flat quad does not work: the road has camber, kerbs and slope, and
   * the surface varies by a median of 0.36 m across the width of a label (much
   * more on a hill), so a rigid plane cuts straight through the tarmac and the
   * text comes out sliced. The quad is therefore subdivided and every vertex
   * lifted to the mesh surface beneath it, so the label drapes over the road.
   *
   * Returns null where the ground under the label is too broken to sit on -
   * against a wall, or across a flight of steps.
   */
  /**
   * A street name painted onto the road.
   *
   * The quad is built directly in world-relative coordinates instead of being
   * rotated into place: `spot.a` is the street bearing from atan2(dx, dz), so
   * the street runs along (sin a, cos a) and the text has to be laid out along
   * *that*, with the letter height across it. Composing an X and a Z Euler
   * rotation instead put the text across the carriageway, where a 26 m label
   * on a 20 m street ran into the buildings on both sides - which is what made
   * the names look chopped up.
   *
   * Vertices are then dropped onto the mesh surface individually so the label
   * drapes over camber, kerbs and slope rather than slicing through them.
   * Returns null only where the ground underneath is genuinely broken.
   */
  private streetMesh(name: string, spot: StreetSpot, major: boolean): THREE.Mesh | null {
    let entry = this.streetCache.get(name);
    if (!entry) {
      entry = streetTexture(name);
      this.streetCache.set(name, entry);
    }
    const aspect = entry.h / entry.w;
    // keep the label inside the carriageway it belongs to
    const len = Math.min(major ? 34 : 24, entry.w * (major ? 0.085 : 0.065));
    const wide = len * aspect;

    const sin = Math.sin(spot.a);
    const cos = Math.cos(spot.a);
    const along: [number, number] = [sin, cos];        // down the street
    const across: [number, number] = [cos, -sin];      // letter height, perpendicular

    // on the bridge or under it: decided once, for the whole label
    const level = this.world.streetLevel(spot.x, spot.z, along) + 0.5;
    const segs = Math.max(4, Math.min(28, Math.round(len / 1.2)));
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    let lo = Infinity;
    let hi = -Infinity;

    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const u = (t - 0.5) * len;
      for (let j = 0; j < 2; j++) {
        const v = (j - 0.5) * wide;
        const dx = along[0] * u + across[0] * v;
        const dz = along[1] * u + across[1] * v;
        const y = this.world.surfaceHeight(spot.x + dx, spot.z + dz, level);
        if (y < lo) lo = y;
        if (y > hi) hi = y;
        pos.push(dx, y + 0.14, dz);
        uv.push(t, j);
      }
    }
    if (hi - lo > 6.0) return null;

    for (let i = 0; i < segs; i++) {
      const k = i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();

    const mat = new THREE.MeshBasicMaterial({
      map: entry.tex, transparent: true, depthWrite: false,
      opacity: 0.95, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    return mesh;
  }

  private clearPois(): void {
    for (const [, obj] of this.mounted) this.group.remove(obj);
    this.mounted.clear();
  }

  /** Mount what is near, unmount what is not. Called every frame; cheap. */
  update(x: number, z: number): void {
    this.updateData(x, z);
    this.group.visible = this.showPois;
    this.streetGroup.visible = this.showStreets;

    if (this.showPois) {
      const near: [number, Poi][] = [];
      for (const set of this.sets.values()) for (const p of set.pois) {
        if (!this.enabled.has(p.c)) continue;
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < POI_RADIUS * POI_RADIUS) near.push([d, p]);
      }
      near.sort((a, b) => a[0] - b[0]);
      const keep = near.slice(0, MAX_POI_SPRITES);
      const wanted = new Set<string>();
      for (const [, p] of keep) {
        const key = `${p.x},${p.z},${p.n}`;
        wanted.add(key);
        if (this.mounted.has(key)) continue;
        const obj = this.poiSprite(p);
        obj.position.set(p.x, this.world.height(p.x, p.z), p.z);
        this.mounted.set(key, obj);
        this.group.add(obj);
      }
      for (const [key, obj] of [...this.mounted]) {
        if (!wanted.has(key)) {
          this.group.remove(obj);
          this.mounted.delete(key);
        }
      }
    } else if (this.mounted.size) {
      this.clearPois();
    }

    if (this.showStreets) {
      const wanted = new Set<string>();
      for (const set of this.sets.values()) for (const st of set.streets) {
        for (const spot of st.at) {
          const d = (spot.x - x) ** 2 + (spot.z - z) ** 2;
          if (d > STREET_RADIUS * STREET_RADIUS) continue;
          const key = `${st.name}|${spot.x},${spot.z}`;
          wanted.add(key);
          if (this.streetMounted.has(key)) continue;
          const mesh = this.streetMesh(st.name, spot, st.major);
          if (!mesh) { this.streetMounted.set(key, null); continue; }
          // vertex heights are already absolute, so only the small lift off the
          // road surface is applied here
          mesh.position.set(spot.x, 0, spot.z);
          this.streetMounted.set(key, mesh);
          this.streetGroup.add(mesh);
        }
      }
      for (const [key, obj] of [...this.streetMounted]) {
        if (!wanted.has(key)) {
          if (obj) this.streetGroup.remove(obj);
          this.streetMounted.delete(key);
        }
      }
    } else if (this.streetMounted.size) {
      for (const [, obj] of this.streetMounted) if (obj) this.streetGroup.remove(obj);
      this.streetMounted.clear();
    }
  }

  get stats() {
    return { pois: this.mounted.size, streets: this.streetMounted.size,
             data: this.dataMounted.size };
  }
}

export { CATEGORY_STYLE };
