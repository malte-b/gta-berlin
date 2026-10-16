import * as THREE from 'three';
import { photoRoofs } from './materials';

/**
 * Bridge decks from pipeline/bridges.py.
 *
 * The terrain under a bridge is whatever runs beneath it - the river, the
 * tracks - so the deck is a slab of its own: a strip along the bridge at the
 * height the laser scan measured, the orthophoto on top like on the roofs.
 * Decks are also somewhere to stand: World asks them for the surface under
 * the player, so you can cross the Spree on foot and drive under a viaduct.
 */

export type DeckKind = 'road' | 'path' | 'rail';

interface DeckData {
  k: DeckKind;
  /** Slab thickness, metres. */
  t: number;
  /** Stations along the deck: x, z, deck height, width to the left and to
   *  the right of the line (world metres; left is (-dz, dx)). */
  p: [number, number, number, number, number][];
}

/** A pier from the cadastre: its outline, from y0 up to the deck at y1. */
interface PierData { r: [number, number][]; y0: number; y1: number }
/** A canopy the cadastre has and OSM lacks: outline, roof height, thickness. */
interface RoofData { r: [number, number][]; y: number; t: number }

/** Coplanar decks side by side (a road and its separately mapped pavement)
 *  would flicker where they overlap; these lift them apart. */
const LIFT: Record<DeckKind, number> = { road: 0, rail: 0.015, path: 0.03 };
const CELL = 32;

export interface DeckHit {
  y: number;
  kind: DeckKind;
  /** Unit direction of the deck there. */
  dx: number;
  dz: number;
}

export class Decks {
  private readonly decks: DeckData[];
  private readonly piers: PierData[];
  private readonly roofs: RoofData[];
  /** Segment references (deck, station) by CELL-metre bucket. */
  private readonly buckets = new Map<string, [number, number][]>();

  constructor(data: { decks: DeckData[]; piers?: PierData[]; roofs?: RoofData[] }) {
    this.piers = data.piers ?? [];
    this.roofs = data.roofs ?? [];
    // older files give one half width for both sides
    this.decks = data.decks.filter((d) => d.p.length >= 2).map((d) => ({
      ...d, p: d.p.map((q) => (q.length >= 5 ? q : [q[0], q[1], q[2], q[3], q[3]]) as DeckData['p'][number]),
    }));
    this.decks.forEach((d, di) => {
      for (let i = 0; i + 1 < d.p.length; i++) {
        const [ax, az, , al, ar] = d.p[i];
        const [bx, bz, , bl, br] = d.p[i + 1];
        const w = Math.max(al, ar, bl, br);
        for (let cx = Math.floor((Math.min(ax, bx) - w) / CELL); cx <= Math.floor((Math.max(ax, bx) + w) / CELL); cx++) {
          for (let cz = Math.floor((Math.min(az, bz) - w) / CELL); cz <= Math.floor((Math.max(az, bz) + w) / CELL); cz++) {
            const key = `${cx},${cz}`;
            let list = this.buckets.get(key);
            if (!list) this.buckets.set(key, list = []);
            list.push([di, i]);
          }
        }
      }
    });
  }

  get count(): number { return this.decks.length; }

  /** Every deck over (x, z), at least `inset` metres in from its edges. */
  at(x: number, z: number, inset = 0): DeckHit[] {
    const out: DeckHit[] = [];
    for (const [di, i] of this.buckets.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []) {
      const d = this.decks[di];
      const [ax, az, ay, al, ar] = d.p[i];
      const [bx, bz, by, bl, br] = d.p[i + 1];
      const ex = bx - ax, ez = bz - az;
      const len2 = ex * ex + ez * ez;
      if (len2 < 1e-9) continue;
      const t = ((x - ax) * ex + (z - az) * ez) / len2;
      if (t < 0 || t > 1) continue;
      const l = Math.sqrt(len2);
      // how far to the left of the line, (-ez, ex) being left
      const side = ((x - ax - ex * t) * -ez + (z - az - ez * t) * ex) / l;
      const left = al + (bl - al) * t - inset, right = ar + (br - ar) * t - inset;
      if (side <= left && -side <= right) {
        out.push({ y: ay + (by - ay) * t + LIFT[d.k], kind: d.k, dx: ex / l, dz: ez / l });
      }
    }
    return out;
  }

  /**
   * Where the decks are, as a one-channel mask at 2 m over the w x h metres
   * from (minX, minZ): the orthophoto shows a deck's top, so the ground under
   * it must not wear the photo. Drawn on a canvas, kept as single bytes.
   */
  footprint(minX: number, minZ: number, w: number, h: number):
      { map: THREE.Texture; min: THREE.Vector2; size: THREE.Vector2 } {
    const RES = 2;
    const pw = Math.ceil(w / RES), ph = Math.ceil(h / RES);
    const c = document.createElement('canvas');
    c.width = pw;
    c.height = ph;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.scale(1 / RES, 1 / RES);
    g.fillStyle = '#fff';
    // drawn a metre inside the edges: the mask is coarse and filtered, and
    // where it reached past a deck the ground beside it lost its photo
    const INSET = 1;
    for (const d of this.decks) {
      const n = d.p.length;
      const left: number[][] = [], right: number[][] = [];
      for (let i = 0; i < n; i++) {
        const [px, pz, , l0, r0] = d.p[i];
        const pl = Math.max(0.3, l0 - INSET), pr = Math.max(0.3, r0 - INSET);
        const [ax, az] = d.p[Math.max(0, i - 1)];
        const [bx, bz] = d.p[Math.min(n - 1, i + 1)];
        let dx = bx - ax, dz = bz - az;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        left.push([px - dz * pl - minX, pz + dx * pl - minZ]);
        right.push([px + dz * pr - minX, pz - dx * pr - minZ]);
      }
      g.beginPath();
      [...left, ...right.reverse()].forEach(([x, z], i) => (i ? g.lineTo(x, z) : g.moveTo(x, z)));
      g.closePath();
      g.fill();
    }
    const rgba = g.getImageData(0, 0, pw, ph).data;
    const red = new Uint8Array(pw * ph);
    for (let k = 0; k < red.length; k++) red[k] = rgba[k * 4 + 3];   // coverage, from alpha
    const tex = new THREE.DataTexture(red, pw, ph, THREE.RedFormat, THREE.UnsignedByteType);
    // row 0 is the north edge, minimum z - like the cover mask
    tex.flipY = false;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.NoColorSpace;
    // single bytes per pixel: rows are not padded to 4
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return { map: tex, min: new THREE.Vector2(minX, minZ), size: new THREE.Vector2(pw * RES, ph * RES) };
  }

  /**
   * One mesh for all decks of a tile, positioned relative to (ox, oz): top,
   * underside, both sides and the two ends of each slab. The top takes its
   * colour from the orthophoto where there is one.
   */
  mesh(ox: number, oz: number, photo?: { map: THREE.Texture; min: THREE.Vector2; size: number }): THREE.Mesh {
    const pos: number[] = [];
    const idx: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
      const k = pos.length / 3;
      pos.push(...a, ...b, ...c, ...d);
      idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
    };
    for (const d of this.decks) {
      const n = d.p.length;
      const left: number[][] = [], right: number[][] = [];
      for (let i = 0; i < n; i++) {
        // the edge normal: across the mean direction of the two segments here
        const [px, pz, py, pl, pr] = d.p[i];
        const [ax, az] = d.p[Math.max(0, i - 1)];
        const [bx, bz] = d.p[Math.min(n - 1, i + 1)];
        let dx = bx - ax, dz = bz - az;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        const y = py + LIFT[d.k];
        left.push([px - dz * pl - ox, y, pz + dx * pl - oz]);
        right.push([px + dz * pr - ox, y, pz - dx * pr - oz]);
      }
      const down = (p: number[]) => [p[0], p[1] - d.t, p[2]];
      for (let i = 0; i + 1 < n; i++) {
        const l0 = left[i], l1 = left[i + 1], r0 = right[i], r1 = right[i + 1];
        quad(l0, r0, r1, l1);                               // top
        quad(down(l1), down(r1), down(r0), down(l0));       // underside
        quad(l1, down(l1), down(l0), l0);                   // left side
        quad(r0, down(r0), down(r1), r1);                   // right side
      }
      quad(right[0], down(right[0]), down(left[0]), left[0]);
      quad(left[n - 1], down(left[n - 1]), down(right[n - 1]), right[n - 1]);
    }
    // piers and canopy roofs: outlines raised into prisms, top and bottom
    // triangulated, sides as quads
    const prism = (ring: [number, number][], y0: number, y1: number) => {
      let r = ring.map(([x, z]) => new THREE.Vector2(x - ox, z - oz));
      if (r.length < 3) return;
      // wound so that the top faces up: clockwise in x/z seen from above
      if (THREE.ShapeUtils.isClockWise(r)) r = r.reverse();
      const k = pos.length / 3;
      for (const p of r) pos.push(p.x, y1, p.y);
      for (const p of r) pos.push(p.x, y0, p.y);
      const n = r.length;
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(r, [])) {
        idx.push(k + a, k + c, k + b);              // top
        idx.push(k + n + a, k + n + b, k + n + c);  // bottom
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        quad([r[i].x, y1, r[i].y], [r[j].x, y1, r[j].y], [r[j].x, y0, r[j].y], [r[i].x, y0, r[i].y]);
      }
    };
    for (const p of this.piers) prism(p.r, p.y0, p.y1);
    for (const f of this.roofs) prism(f.r, f.y - f.t, f.y);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    // flat shading per face: a slab's edges are hard
    const flat = geo.toNonIndexed();
    flat.computeVertexNormals();
    geo.dispose();
    const mat = new THREE.MeshStandardMaterial({ color: 0x8f8d88, roughness: 0.92, metalness: 0 });
    // the upward faces take the photo (photoRoofs works in world coordinates)
    if (photo) photoRoofs(mat, photo.map, photo.min, new THREE.Vector2(photo.size, photo.size));
    const mesh = new THREE.Mesh(flat, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = 'bridges';
    return mesh;
  }
}
