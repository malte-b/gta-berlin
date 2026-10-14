/* Readers for the binary formats emitted by pipeline/build_world.py. The
   Python side documents the authoritative layouts; these mirror them. */

import type { XZ } from './geo';

function magicOf(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf, 0, 4);
  return String.fromCharCode(b[0], b[1], b[2], b[3]);
}

/**
 * "BTT1" bare-earth terrain from the airborne laser scan, 1 m cells.
 *
 * Cell values sit at cell centres, so sampling shifts by half a cell before
 * interpolating bilinearly. Row 0 is the north edge.
 */
export class TerrainField {
  readonly minX: number;
  readonly minZ: number;
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  readonly hmin: number;
  readonly hscale: number;
  readonly data: Uint16Array;

  constructor(buf: ArrayBuffer) {
    if (magicOf(buf) !== 'BTT1') throw new Error('bad terrain file');
    const dv = new DataView(buf);
    this.minX = dv.getFloat32(4, true);
    this.minZ = dv.getFloat32(8, true);
    this.cell = dv.getFloat32(12, true);
    this.nx = dv.getUint32(16, true);
    this.nz = dv.getUint32(20, true);
    this.hmin = dv.getFloat32(24, true);
    this.hscale = dv.getFloat32(28, true);
    this.data = new Uint16Array(buf, 32, this.nx * this.nz);
  }

  /** Height at a cell, clamped to the grid. */
  at(i: number, j: number): number {
    i = Math.min(Math.max(i, 0), this.nx - 1);
    j = Math.min(Math.max(j, 0), this.nz - 1);
    return this.hmin + this.data[j * this.nx + i] * this.hscale;
  }

  contains(x: number, z: number): boolean {
    return x >= this.minX && z >= this.minZ
      && x < this.minX + this.nx * this.cell && z < this.minZ + this.nz * this.cell;
  }

  height(x: number, z: number): number {
    const fx = (x - this.minX) / this.cell - 0.5;
    const fz = (z - this.minZ) / this.cell - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const a = this.at(i, j), b = this.at(i + 1, j);
    const c = this.at(i, j + 1), d = this.at(i + 1, j + 1);
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
}

/**
 * "BTN1" navigation grid covering the whole world at 1 m.
 *
 * Walkable means: not inside a building footprint, a tree trunk or water, and
 * not too steep on the laser-scan terrain. Drivable is walkable eroded by the
 * clearance a car needs.
 */
export class NavGrid {
  static readonly WALKABLE = 1;
  static readonly DRIVABLE = 2;
  static readonly OPEN_SKY = 4;
  static readonly SKY_RAW = 8;
  static readonly BUILDING = 16;

  readonly minX: number;
  readonly minZ: number;
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  readonly hmin: number;
  readonly hscale: number;
  readonly terrain: Uint16Array;
  readonly flags: Uint8Array;

  constructor(buf: ArrayBuffer) {
    if (magicOf(buf) !== 'BTN1') throw new Error('bad nav grid: ' + magicOf(buf));
    const dv = new DataView(buf);
    this.minX = dv.getFloat32(4, true);
    this.minZ = dv.getFloat32(8, true);
    this.cell = dv.getFloat32(12, true);
    this.nx = dv.getUint32(16, true);
    this.nz = dv.getUint32(20, true);
    this.hmin = dv.getFloat32(24, true);
    this.hscale = dv.getFloat32(28, true);
    const n = this.nx * this.nz;
    this.terrain = new Uint16Array(buf, 32, n);
    this.flags = new Uint8Array(buf, 32 + n * 2, n);
  }

  index(x: number, z: number): number {
    const c = Math.floor((x - this.minX) / this.cell);
    const r = Math.floor((z - this.minZ) / this.cell);
    if (c < 0 || c >= this.nx || r < 0 || r >= this.nz) return -1;
    return r * this.nx + c;
  }

  contains(x: number, z: number): boolean {
    return this.index(x, z) >= 0;
  }

  has(x: number, z: number, flag: number): boolean {
    const k = this.index(x, z);
    return k >= 0 && (this.flags[k] & flag) !== 0;
  }

  passable(x: number, z: number, driving: boolean): boolean {
    return this.has(x, z, driving ? NavGrid.DRIVABLE : NavGrid.WALKABLE);
  }

  /** Nearest passable spot, spiralling outward. */
  nearestPassable(x: number, z: number, driving: boolean, maxR = 150): XZ | null {
    if (this.passable(x, z, driving)) return [x, z];
    for (let r = this.cell; r <= maxR; r += this.cell) {
      const steps = Math.max(8, Math.round((2 * Math.PI * r) / this.cell));
      for (let a = 0; a < steps; a++) {
        const th = (a / steps) * Math.PI * 2;
        const px = x + Math.cos(th) * r;
        const pz = z + Math.sin(th) * r;
        if (this.passable(px, pz, driving)) return [px, pz];
      }
    }
    return null;
  }
}

/** One tree from the Berlin cadastre, sizes in metres. */
export interface Tree {
  x: number;
  z: number;
  y: number;
  height: number;
  crown: number;
  trunk: number;
  form: number;         // 0 broadleaf, 1 conifer, 2 columnar
  genus: number;
}

/** "BTR1" tree list - see pipeline/trees.py. */
/** One placed copy of a street furniture prototype (pipeline/street_furniture.py). */
export interface Prop { x: number; z: number; y: number; yaw: number; kind: number }

export function parseProps(buf: ArrayBuffer): Prop[] {
  if (magicOf(buf) !== 'BPR1') throw new Error('bad props file');
  const n = new DataView(buf).getUint32(4, true);
  let o = 8;
  const f32 = () => { const a = new Float32Array(buf, o, n); o += n * 4; return a; };
  const xs = f32(), zs = f32(), ys = f32(), yaws = f32();
  const kinds = new Uint16Array(buf, o, n);
  const out: Prop[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ x: xs[i], z: zs[i], y: ys[i], yaw: yaws[i], kind: kinds[i] });
  }
  return out;
}

export function parseTrees(buf: ArrayBuffer): Tree[] {
  if (magicOf(buf) !== 'BTR1') throw new Error('bad tree file');
  const n = new DataView(buf).getUint32(4, true);
  let o = 8;
  const f32 = () => { const a = new Float32Array(buf, o, n); o += n * 4; return a; };
  const u16 = () => { const a = new Uint16Array(buf, o, n); o += n * 2; return a; };
  const u8 = () => { const a = new Uint8Array(buf, o, n); o += n; return a; };
  const xs = f32(), zs = f32(), ys = f32();
  const hs = u16(), cs = u16(), ts = u16();
  const fs = u8(), gs = u8();
  const out: Tree[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ x: xs[i], z: zs[i], y: ys[i], height: hs[i] / 100,
               crown: cs[i] / 100, trunk: ts[i] / 1000, form: fs[i], genus: gs[i] });
  }
  return out;
}
