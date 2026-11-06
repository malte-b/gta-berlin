import * as THREE from 'three';
import { bridgeMaterial, type GroundTextures, type OrthoTile } from './materials';

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
  /** Complete ALKIS/OSM surface; vertices are x, z, y in world metres. */
  mesh?: { v: [number, number, number][]; i: number[]; r: number[][]; rails?: number[][]; clip?: [number, number, number, number] };
  assembled?: boolean;
  name?: string;
  material?: string;
  structure?: string;
  railing?: string;
  covered?: boolean;
  axis?: [number, number];
}

type Vertex = [number, number, number]; // x, y, z
interface Section { left: Vertex; right: Vertex }
interface Surface { vertices: Vertex[]; indices: number[]; rings: number[][] }
interface Solid { ring: [number, number][]; low: number; high: number }

/** One set of mitred edges for rendering, collision and the ground mask. */
function sections(d: DeckData): Section[] {
  return d.p.map(([x, z, y, left, right], i, p) => {
    const direction = (a: typeof p[number], b: typeof p[number]) => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    };
    const before = direction(p[Math.max(0, i - 1)], p[i === 0 ? 1 : i]);
    const after = direction(p[i === p.length - 1 ? i - 1 : i], p[Math.min(p.length - 1, i + 1)]);
    const length = Math.hypot(before[0] + after[0], before[1] + after[1]);
    const dx = length > 1e-6 ? (before[0] + after[0]) / length : after[0];
    const dz = length > 1e-6 ? (before[1] + after[1]) / length : after[1];
    const miter = 1 / Math.max(0.5, dx * after[0] + dz * after[1]);
    return { left: [x - dz * left * miter, y + LIFT[d.k], z + dx * left * miter],
             right: [x + dz * right * miter, y + LIFT[d.k], z - dx * right * miter] };
  });
}

/** Barycentric height on precisely the triangles used by the visible top. */
function triangleHeight(x: number, z: number, a: Vertex, b: Vertex, c: Vertex): number | null {
  const ex = b[0] - a[0], ez = b[2] - a[2], fx = c[0] - a[0], fz = c[2] - a[2];
  const det = ex * fz - ez * fx;
  if (Math.abs(det) < 1e-9) return null;
  const u = ((x - a[0]) * fz - (z - a[2]) * fx) / det;
  const v = (ex * (z - a[2]) - ez * (x - a[0])) / det;
  return u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8 ? a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]) : null;
}

function edgeDistance2(x: number, z: number, a: Vertex, b: Vertex): number {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const f = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / (dx * dx + dz * dz || 1)));
  return (x - a[0] - f * dx) ** 2 + (z - a[2] - f * dz) ** 2;
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
  private readonly surfaces: Surface[];
  private readonly piers: PierData[];
  private readonly roofs: RoofData[];
  /** Segment references (deck, station) by CELL-metre bucket. */
  private readonly buckets = new Map<string, [number, number][]>();
  private readonly borders = new Map<string, [number, Vertex, Vertex][]>();
  private readonly solids = new Map<string, Solid[]>();

  constructor(data: { decks: DeckData[]; piers?: PierData[]; roofs?: RoofData[] }) {
    this.piers = data.piers ?? [];
    this.roofs = data.roofs ?? [];
    // older files give one half width for both sides
    this.decks = data.decks.map((d) => ({
      ...d, p: d.p.map((q) => (q.length >= 5 ? q : [q[0], q[1], q[2], q[3], q[3]]) as DeckData['p'][number])
        .filter((q, i, p) => q.every(Number.isFinite) && (i === 0 || Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) > 1e-5)),
    })).filter((d) => d.p.length >= 2);
    this.surfaces = this.decks.map((d) => {
      if (d.mesh) return { vertices: d.mesh.v.map(([x, z, y]) => [x, y + LIFT[d.k], z] as Vertex), indices: d.mesh.i, rings: d.mesh.r };
      const es = sections(d), vertices = es.flatMap((s) => [s.left, s.right]);
      const indices: number[] = [];
      for (let i = 0; i + 1 < es.length; i++) {
        const k = i * 2;
        indices.push(k, k + 2, k + 3, k, k + 3, k + 1);
      }
      return { vertices, indices, rings: [es.map((_, i) => i * 2).concat(es.map((_, i) => i * 2 + 1).reverse())] };
    });
    this.decks.forEach((d, di) => {
      const surface = this.surfaces[di];
      for (let i = 0; i + 2 < surface.indices.length; i += 3) {
        const pts = surface.indices.slice(i, i + 3).map((j) => surface.vertices[j]);
        const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
        const z0 = Math.min(...pts.map((p) => p[2])), z1 = Math.max(...pts.map((p) => p[2]));
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
          for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
            const key = `${cx},${cz}`;
            let list = this.buckets.get(key);
            if (!list) this.buckets.set(key, list = []);
              list.push([di, i]);
          }
        }
      }
      for (const ring of surface.rings) {
        for (let i = 0; i < ring.length; i++) {
          const a = surface.vertices[ring[i]], b = surface.vertices[ring[(i + 1) % ring.length]];
          if (this.cutEdge(d, a, b)) continue;
          const edgeLength = Math.hypot(b[0] - a[0], b[2] - a[2]);
          if (!d.mesh) {
            const last = surface.vertices.length - 1;
            const pair = [ring[i], ring[(i + 1) % ring.length]].sort((a, b) => a - b);
            if ((pair[0] === 0 && pair[1] === 1) || (pair[0] === last - 1 && pair[1] === last)) continue;
          } else if (d.axis && edgeLength > 0 && Math.abs((b[0] - a[0]) * d.axis[0] + (b[2] - a[2]) * d.axis[1]) / edgeLength < 0.55) {
            continue; // a landing, not a guardrail: do not inset it into a gap
          }
          for (let x = Math.floor((Math.min(a[0], b[0]) - 1) / CELL); x <= Math.floor((Math.max(a[0], b[0]) + 1) / CELL); x++) {
            for (let z = Math.floor((Math.min(a[2], b[2]) - 1) / CELL); z <= Math.floor((Math.max(a[2], b[2]) + 1) / CELL); z++) {
              const key = `${x},${z}`;
              let list = this.borders.get(key);
              if (!list) this.borders.set(key, list = []);
              list.push([di, a, b]);
            }
          }
        }
      }
    });
    for (const solid of [...this.piers.map((p) => ({ ring: p.r, low: p.y0, high: p.y1 })),
      ...this.roofs.map((r) => ({ ring: r.r, low: r.y - r.t, high: r.y }))]) {
      if (solid.ring.length < 3) continue;
      const xs = solid.ring.map((p) => p[0]), zs = solid.ring.map((p) => p[1]);
      for (let x = Math.floor((Math.min(...xs) - 0.15) / CELL); x <= Math.floor((Math.max(...xs) + 0.15) / CELL); x++) {
        for (let z = Math.floor((Math.min(...zs) - 0.15) / CELL); z <= Math.floor((Math.max(...zs) + 0.15) / CELL); z++) {
          const key = `${x},${z}`;
          let list = this.solids.get(key);
          if (!list) this.solids.set(key, list = []);
          list.push(solid);
        }
      }
    }
  }

  private cutEdge(d: DeckData, a: Vertex, b: Vertex): boolean {
    const clip = d.mesh?.clip;
    return !!clip && ((Math.abs(a[0] - clip[0]) < 0.002 && Math.abs(b[0] - clip[0]) < 0.002)
      || (Math.abs(a[0] - clip[2]) < 0.002 && Math.abs(b[0] - clip[2]) < 0.002)
      || (Math.abs(a[2] - clip[1]) < 0.002 && Math.abs(b[2] - clip[1]) < 0.002)
      || (Math.abs(a[2] - clip[3]) < 0.002 && Math.abs(b[2] - clip[3]) < 0.002));
  }

  get count(): number { return this.decks.length; }

  /** Every deck over (x, z), at least `inset` metres in from its edges. */
  at(x: number, z: number, inset = 0): DeckHit[] {
    const out: DeckHit[] = [];
    const seen = new Set<number>();
    const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    const blocked = new Set<number>();
    if (inset > 0) for (const [di, a, b] of this.borders.get(key) ?? []) {
      if (edgeDistance2(x, z, a, b) < inset * inset) blocked.add(di);
    }
    for (const [di, i] of this.buckets.get(key) ?? []) {
      if (seen.has(di)) continue;
      if (blocked.has(di)) continue;
      const d = this.decks[di];
      const s = this.surfaces[di];
      const y = triangleHeight(x, z, s.vertices[s.indices[i]], s.vertices[s.indices[i + 1]], s.vertices[s.indices[i + 2]]);
      if (y === null) continue;
      const segment = d.mesh ? 0 : Math.floor(i / 6);
      const [ax, az] = d.p[segment];
      const [bx, bz] = d.p[segment + 1];
      const ex = bx - ax, ez = bz - az;
      const l = Math.hypot(ex, ez);
      out.push({ y, kind: d.k, dx: d.axis?.[0] ?? ex / l, dz: d.axis?.[1] ?? ez / l });
      seen.add(di);
    }
    return out;
  }

  /** Slabs, piers and canopies are volumes; space beneath them stays open. */
  blocksCamera(x: number, y: number, z: number): boolean {
    const skin = 0.15;
    const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    for (const [di, i] of this.buckets.get(key) ?? []) {
      const s = this.surfaces[di];
      const top = triangleHeight(x, z, s.vertices[s.indices[i]], s.vertices[s.indices[i + 1]], s.vertices[s.indices[i + 2]]);
      if (top !== null && y >= top - this.decks[di].t - skin && y <= top + skin) return true;
    }
    for (const solid of this.solids.get(key) ?? []) {
      if (y < solid.low - skin || y > solid.high + skin) continue;
      const ring = solid.ring;
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j], b = ring[i];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
        if ((x - a[0] - dx * t) ** 2 + (z - a[1] - dz * t) ** 2 < skin * skin) return true;
        if ((a[1] > z) !== (b[1] > z) && x < a[0] + (z - a[1]) * dx / dz) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
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
    for (const s of this.surfaces) {
      g.beginPath();
      for (const ring of s.rings) {
        ring.forEach((j, i) => { const [x, , z] = s.vertices[j]; if (i) g.lineTo(x - minX, z - minZ); else g.moveTo(x - minX, z - minZ); });
        g.closePath();
      }
      g.fill('evenodd');
      g.save();
      g.globalCompositeOperation = 'destination-out';
      g.lineWidth = INSET * 2;
      g.stroke();
      g.restore();
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
  mesh(ox: number, oz: number, photo?: OrthoTile, ground?: GroundTextures): THREE.Mesh {
    const pos: number[] = [];
    const idx: number[] = [];
    const colors: number[] = [], types: number[] = [], photos: number[] = [];
    let tint = new THREE.Color(0x969184), type = 0, photograph = false;
    const vertex = (p: number[]) => {
      pos.push(...p);
      colors.push(tint.r, tint.g, tint.b);
      types.push(type);
      // An aerial photo shows the uppermost surface. Under an elevated line,
      // the lower road uses its own asphalt/paving instead of painted tracks.
      photos.push(photograph && !this.at(p[0] + ox, p[2] + oz).some((h) => h.y > p[1] + 1) ? 1 : 0);
    };
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
      const k = pos.length / 3;
      for (const p of [a, b, c, d]) vertex(p);
      idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
    };
    const beam = (a: number[], b: number[], width: number, height: number) => {
      const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (length < 0.015) return;
      const nx = -(b[2] - a[2]) / length * width / 2, nz = (b[0] - a[0]) / length * width / 2;
      const l0 = [a[0] + nx, a[1] + height / 2, a[2] + nz], r0 = [a[0] - nx, a[1] + height / 2, a[2] - nz];
      const l1 = [b[0] + nx, b[1] + height / 2, b[2] + nz], r1 = [b[0] - nx, b[1] + height / 2, b[2] - nz];
      const down = (p: number[]) => [p[0], p[1] - height, p[2]];
      quad(l0, l1, r1, r0);
      quad(down(l0), down(r0), down(r1), down(l1));
      quad(l0, down(l0), down(l1), l1);
      quad(r1, down(r1), down(r0), r0);
      quad(l0, r0, down(r0), down(l0));
      quad(r1, l1, down(l1), down(r1));
    };
    for (const [di, d] of this.decks.entries()) {
      const local = ([x, y, z]: Vertex) => [x - ox, y, z - oz];
      const s = this.surfaces[di];
      tint = new THREE.Color(0xffffff);
      type = d.k === 'road' ? 1 : d.k === 'path' ? 2 : 3;
      photograph = true;
      const start = pos.length / 3;
      for (const p of s.vertices) vertex(local(p));
      idx.push(...s.indices.map((i) => start + i));
      tint = new THREE.Color(d.material === 'brick' ? 0x8e6850 : d.material === 'steel' || d.k === 'rail' ? 0x64716f : 0x969184);
      type = d.material === 'steel' || d.k === 'rail' ? 4 : 0;
      photograph = false;
      const down = (p: number[]) => [p[0], p[1] - d.t, p[2]];
      const bottom = pos.length / 3;
      for (const p of s.vertices) vertex(down(local(p)));
      for (let i = 0; i < s.indices.length; i += 3) idx.push(bottom + s.indices[i], bottom + s.indices[i + 2], bottom + s.indices[i + 1]);
      for (const ring of s.rings) {
        // The outer ring is wound clockwise in x/z; holes counterclockwise.
        // Orient by the triangle interior rather than trusting source winding.
        for (let i = 0; i < ring.length; i++) {
          const a = s.vertices[ring[i]], b = s.vertices[ring[(i + 1) % ring.length]];
          if (this.cutEdge(d, a, b)) continue;
          const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
          if (length < 1e-6) continue;
          const mx = (a[0] + b[0]) / 2, mz = (a[2] + b[2]) / 2;
          const nx = -(b[2] - a[2]) / length, nz = (b[0] - a[0]) / length;
          const insideLeft = this.at(mx + nx * 0.02, mz + nz * 0.02).some((h) => Math.abs(h.y - (a[1] + b[1]) / 2) < 0.1);
          const l = local(a), r = local(b);
          if (insideLeft) quad(l, r, down(r), down(l));
          else quad(r, l, down(l), down(r));
        }
      }
      if (!(d.assembled || d.k === 'rail') || d.railing === 'no' || d.covered) continue;
      const first = d.p[0], last = d.p[d.p.length - 1];
      const span = Math.hypot(last[0] - first[0], last[1] - first[1]) || 1;
      const dx = d.axis?.[0] ?? (last[0] - first[0]) / span, dz = d.axis?.[1] ?? (last[1] - first[1]) / span;
      tint = new THREE.Color(d.k === 'rail' ? 0x64716f : 0x788783);
      type = 4;
      // Railings follow the surveyed span, not the extra approach aprons.
      for (const ring of d.mesh?.rails ?? s.rings) {
        let railRun = 0;
        for (let i = 0; i < ring.length; i++) {
          const a = s.vertices[ring[i]], b = s.vertices[ring[(i + 1) % ring.length]];
          if (this.cutEdge(d, a, b)) continue;
          const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
          if (length < 0.015) continue;
          const along = Math.abs(((b[0] - a[0]) * dx + (b[2] - a[2]) * dz) / length);
          // End faces are entries, never fenced across. Clip faces likewise.
          if (along < 0.65) { railRun = 0; continue; }
          const nx = -(b[2] - a[2]) / length, nz = (b[0] - a[0]) / length;
          const mx = (a[0] + b[0]) / 2, mz = (a[2] + b[2]) / 2;
          const insideLeft = this.at(mx + nx * 0.02, mz + nz * 0.02).some((h) => Math.abs(h.y - (a[1] + b[1]) / 2) < 0.1);
          const l = local(a), r = local(b);
          const inward = insideLeft ? 0.12 : -0.12;
          const point = (p: number[], y: number) => [p[0] + nx * inward, p[1] + y, p[2] + nz * inward];
          beam(point(l, 1.08), point(r, 1.08), 0.065, 0.065);
          beam(point(l, 0.52), point(r, 0.52), 0.038, 0.038);
          beam(point(l, 0.08), point(r, 0.08), 0.13, 0.16);
          for (let distance = Math.ceil(railRun / 2.5) * 2.5 - railRun; distance < length; distance += 2.5) {
            const f = distance / length;
            const p = point([l[0] + (r[0] - l[0]) * f, l[1] + (r[1] - l[1]) * f, l[2] + (r[2] - l[2]) * f], 0.54);
            beam([p[0] - 0.035, p[1], p[2]], [p[0] + 0.035, p[1], p[2]], 0.07, 1.08);
          }
          railRun += length;
        }
      }
    }
    // piers and canopy roofs: outlines raised into prisms, top and bottom
    // triangulated, sides as quads
    const prism = (ring: [number, number][], y0: number, y1: number, roof = false) => {
      tint = new THREE.Color(0x969184); type = 0; photograph = false;
      let r = ring.map(([x, z]) => new THREE.Vector2(x - ox, z - oz));
      if (r.length < 3) return;
      // wound so that the top faces up: clockwise in x/z seen from above
      if (THREE.ShapeUtils.isClockWise(r)) r = r.reverse();
      const k = pos.length / 3;
      if (roof) { tint = new THREE.Color(0xffffff); type = 3; photograph = true; }
      for (const p of r) vertex([p.x, y1, p.y]);
      tint = new THREE.Color(0x969184); type = 0; photograph = false;
      for (const p of r) vertex([p.x, y0, p.y]);
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
    for (const f of this.roofs) prism(f.r, f.y - f.t, f.y, true);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('surfaceType', new THREE.Float32BufferAttribute(types, 1));
    geo.setAttribute('photoMix', new THREE.Float32BufferAttribute(photos, 1));
    geo.setIndex(idx);
    // flat shading per face: a slab's edges are hard
    const flat = geo.toNonIndexed();
    flat.computeVertexNormals();
    geo.dispose();
    const mat = bridgeMaterial(ground, photo);
    const mesh = new THREE.Mesh(flat, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = 'bridges';
    return mesh;
  }
}
