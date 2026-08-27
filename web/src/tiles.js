import * as THREE from 'three';

/* Readers for the binary formats emitted by pipeline/. See tilefmt.py,
   terrain.py and collision.py for the authoritative layouts. */

const HEADER = 32;   // magic + 3f min + 3f scale + u32 count

function magicOf(buf) {
  const b = new Uint8Array(buf, 0, 4);
  return String.fromCharCode(b[0], b[1], b[2], b[3]);
}

/**
 * Turn a "BTB1"/"BTS1" blob into a BufferGeometry.
 *
 * Positions stay as unsigned shorts on the GPU and are expanded in the vertex
 * shader with qmin/qscale, which keeps a tile at ~9 bytes per vertex instead of
 * the 24+ a float layout would need. The u16 planes are read as zero-copy views
 * because the header length keeps every plane two-byte aligned.
 */
export function parseGeometry(buf, extras) {
  const dv = new DataView(buf);
  const qmin = new THREE.Vector3(dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true));
  const qscale = new THREE.Vector3(dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true));
  const count = dv.getUint32(28, true);

  let o = HEADER;
  const xs = new Uint16Array(buf, o, count); o += count * 2;
  const ys = new Uint16Array(buf, o, count); o += count * 2;
  const zs = new Uint16Array(buf, o, count); o += count * 2;
  const kind = new Uint8Array(buf, o, count); o += count;

  const pos = new Uint16Array(count * 3);
  for (let i = 0, j = 0; i < count; i++) {
    pos[j++] = xs[i];
    pos[j++] = ys[i];
    pos[j++] = zs[i];
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Uint16BufferAttribute(pos, 3));
  geo.setAttribute('akind', new THREE.Uint8BufferAttribute(kind.slice(), 1));
  for (const name of extras) {
    const a = new Uint8Array(buf, o, count); o += count;
    geo.setAttribute(name, new THREE.Uint8BufferAttribute(a.slice(), 1));
  }

  // three would otherwise derive bounds from the raw quantised values, so set
  // them from the tile's real world-space box.
  const min = qmin.clone();
  const max = qmin.clone().add(new THREE.Vector3(qscale.x * 65535, qscale.y * 65535, qscale.z * 65535));
  geo.boundingBox = new THREE.Box3(min, max);
  geo.boundingSphere = new THREE.Sphere();
  geo.boundingBox.getBoundingSphere(geo.boundingSphere);

  return { geo, qmin, qscale, count };
}

/** "BTT1" heightfield, with bilinear sampling in world metres. */
export class TerrainField {
  constructor(buf) {
    const dv = new DataView(buf);
    if (magicOf(buf) !== 'BTT1') throw new Error('bad terrain file');
    this.minX = dv.getFloat32(4, true);
    this.minZ = dv.getFloat32(8, true);
    this.cell = dv.getFloat32(12, true);
    this.nx = dv.getUint32(16, true);
    this.nz = dv.getUint32(20, true);
    this.hmin = dv.getFloat32(24, true);
    this.hscale = dv.getFloat32(28, true);
    this.data = new Uint16Array(buf, 32, this.nx * this.nz);
  }
  _at(i, j) {
    i = Math.min(Math.max(i, 0), this.nx - 1);
    j = Math.min(Math.max(j, 0), this.nz - 1);
    return this.hmin + this.data[j * this.nx + i] * this.hscale;
  }
  height(x, z) {
    // cell values sit at cell centres, hence the half-cell shift
    const fx = (x - this.minX) / this.cell - 0.5;
    const fz = (z - this.minZ) / this.cell - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const a = this._at(i, j), b = this._at(i + 1, j);
    const c = this._at(i, j + 1), d = this._at(i + 1, j + 1);
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
}

/** "BTC1" 1 m building-footprint bitmask for one tile. */
export class CollisionMask {
  constructor(buf) {
    const dv = new DataView(buf);
    if (magicOf(buf) !== 'BTC1') throw new Error('bad collision file');
    this.minX = dv.getFloat32(4, true);
    this.minZ = dv.getFloat32(8, true);
    this.n = dv.getUint16(12, true);
    this.res = dv.getFloat32(14, true);
    this.bits = new Uint8Array(buf, 18);
  }
  solid(x, z) {
    const c = Math.floor((x - this.minX) / this.res);
    const r = Math.floor((z - this.minZ) / this.res);
    if (c < 0 || c >= this.n || r < 0 || r >= this.n) return false;
    const i = r * this.n + c;
    return (this.bits[i >> 3] & (1 << (i & 7))) !== 0;
  }
}

/* --- photogrammetric mesh model ------------------------------------------ */

/**
 * Parse a "BTM1" mesh tile into a BufferGeometry with one draw group per
 * atlas page.
 *
 * Positions stay quantised as unsigned shorts and are expanded in the vertex
 * shader. UVs are unsigned shorts too, but flagged normalized, which makes the
 * GPU hand the shader a plain 0..1 float for free - exactly the range texture
 * coordinates need, at half the bandwidth of floats.
 */
export function parseMesh(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== 'BTM1') throw new Error('bad mesh tile: ' + magic);

  const qmin = new THREE.Vector3(dv.getFloat32(4, true), dv.getFloat32(8, true), dv.getFloat32(12, true));
  const qscale = new THREE.Vector3(dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true));
  const count = dv.getUint32(28, true);
  const groupCount = dv.getUint16(32, true);

  let o = 34;
  const groups = [];
  for (let i = 0; i < groupCount; i++) {
    groups.push({
      page: dv.getUint16(o, true),
      start: dv.getUint32(o + 2, true),
      count: dv.getUint32(o + 6, true),
    });
    o += 10;
  }

  const xs = new Uint16Array(buf, o, count); o += count * 2;
  const ys = new Uint16Array(buf, o, count); o += count * 2;
  const zs = new Uint16Array(buf, o, count); o += count * 2;
  const us = new Uint16Array(buf, o, count); o += count * 2;
  const vs = new Uint16Array(buf, o, count); o += count * 2;

  const pos = new Uint16Array(count * 3);
  const uv = new Uint16Array(count * 2);
  for (let i = 0, p = 0, q = 0; i < count; i++) {
    pos[p++] = xs[i]; pos[p++] = ys[i]; pos[p++] = zs[i];
    uv[q++] = us[i]; uv[q++] = vs[i];
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Uint16BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Uint16BufferAttribute(uv, 2, true));

  // one group per atlas page, in the order the pages appear in the file
  const pages = [];
  groups.forEach((g, i) => {
    geo.addGroup(g.start, g.count, i);
    pages.push(g.page);
  });

  const min = qmin.clone();
  const max = qmin.clone().add(new THREE.Vector3(
    qscale.x * 65535, qscale.y * 65535, qscale.z * 65535));
  geo.boundingBox = new THREE.Box3(min, max);
  geo.boundingSphere = new THREE.Sphere();
  geo.boundingBox.getBoundingSphere(geo.boundingSphere);

  return { geo, qmin, qscale, count, pages };
}

/**
 * "BTH1" heightfield: lowest and highest surface per 1 m cell.
 *
 * The mesh model is one continuous skin over ground, buildings and trees, so
 * a single rasterisation gives both what you stand on (`ground`) and what
 * blocks you (`top - ground` taller than a person).
 */
export class HeightField {
  constructor(buf) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
    if (magic !== 'BTH1') throw new Error('bad heightfield: ' + magic);
    this.minX = dv.getFloat32(4, true);
    this.minZ = dv.getFloat32(8, true);
    this.cell = dv.getFloat32(12, true);
    this.nx = dv.getUint16(16, true);
    this.nz = dv.getUint16(18, true);
    this.hmin = dv.getFloat32(20, true);
    this.hscale = dv.getFloat32(24, true);
    const n = this.nx * this.nz;
    this.ground = new Uint16Array(buf, 28, n);
    this.top = new Uint16Array(buf, 28 + n * 2, n);
    this.maxX = this.minX + this.nx * this.cell;
    this.maxZ = this.minZ + this.nz * this.cell;
  }

  contains(x, z) {
    return x >= this.minX && x < this.maxX && z >= this.minZ && z < this.maxZ;
  }

  _idx(x, z) {
    const c = Math.floor((x - this.minX) / this.cell);
    const r = Math.floor((z - this.minZ) / this.cell);
    if (c < 0 || c >= this.nx || r < 0 || r >= this.nz) return -1;
    return r * this.nx + c;
  }

  /** Bilinear ground height, so walking does not step between cells. */
  groundAt(x, z) {
    const fx = (x - this.minX) / this.cell - 0.5;
    const fz = (z - this.minZ) / this.cell - 0.5;
    let i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const at = (ii, jj) => {
      ii = Math.min(Math.max(ii, 0), this.nx - 1);
      jj = Math.min(Math.max(jj, 0), this.nz - 1);
      return this.hmin + this.ground[jj * this.nx + ii] * this.hscale;
    };
    const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  topAt(x, z) {
    const k = this._idx(x, z);
    if (k < 0) return -Infinity;
    return this.hmin + this.top[k] * this.hscale;
  }

  /** Something taller than a person occupies this cell. */
  solid(x, z, clearance = 2.2) {
    const k = this._idx(x, z);
    if (k < 0) return false;
    return (this.top[k] - this.ground[k]) * this.hscale > clearance;
  }
}

/**
 * "BTN1" navigation grid covering the whole world at 1 m.
 *
 * Built by pipeline/build_nav.py, which separates terrain from objects with a
 * morphological opening before deciding anything. Testing movement against the
 * raw mesh surface instead treats every parked car, bollard and tree canopy as
 * a wall, which is what produced invisible barriers on open pavement.
 */
export class NavGrid {
  constructor(buf) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
    if (magic !== 'BTN1') throw new Error('bad nav grid: ' + magic);
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
    this.WALKABLE = 1;
    this.DRIVABLE = 2;
  }

  _idx(x, z) {
    const c = Math.floor((x - this.minX) / this.cell);
    const r = Math.floor((z - this.minZ) / this.cell);
    if (c < 0 || c >= this.nx || r < 0 || r >= this.nz) return -1;
    return r * this.nx + c;
  }

  contains(x, z) {
    return this._idx(x, z) >= 0;
  }

  /** Bilinear terrain height, so slopes are smooth underfoot. */
  height(x, z) {
    const fx = (x - this.minX) / this.cell - 0.5;
    const fz = (z - this.minZ) / this.cell - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const at = (ii, jj) => {
      ii = Math.min(Math.max(ii, 0), this.nx - 1);
      jj = Math.min(Math.max(jj, 0), this.nz - 1);
      return this.hmin + this.terrain[jj * this.nx + ii] * this.hscale;
    };
    const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  passable(x, z, driving) {
    const k = this._idx(x, z);
    if (k < 0) return false;
    return (this.flags[k] & (driving ? this.DRIVABLE : this.WALKABLE)) !== 0;
  }

  /** Nearest passable spot, spiralling outward. */
  nearestPassable(x, z, driving, maxR = 150) {
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
