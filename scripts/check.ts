/*
 * Checks a built world for the things that broke before, without a browser:
 * the game's own readers (TerrainField, NavGrid, Decks) on the files in a
 * build folder, and the game's rule for what you stand on (World.height).
 *
 *   node scripts/check.ts                                # data/berlin
 *   node scripts/check.ts --dir data/berlin_v2 --out /tmp/check
 *   node scripts/check.ts --tiles 392_5819,393_5818
 *   node scripts/check.ts --no-flood                     # skip the bridge floods
 *   node scripts/check.ts --tiles 384_5828 --debug -4751,-9109   # why a bridge there fails
 *   MAP=x,z node scripts/check.ts ... --debug x,z       # ... and a map of the floods around x,z
 *
 * What it looks for:
 *
 *  - bridges you cannot cross, flooded: around each bridge, everywhere the
 *    game's movement rules (World.canStep, the player's cross probe,
 *    World.height) take you from each of its landings, on foot and for roads
 *    by car. A landing cut off from the others is reported where the flood
 *    from the main side gets closest to it, with a picture (flood/*.png); a
 *    deck end with no ground at its level is a dead end. --debug x,z prints
 *    the ends of the bridges there, with the ground and decks along them.
 *  - each deck also walked along its own line, from a bit
 *    before its start to a bit after its end, the way the player would -
 *    where the walker ends up off the deck (a ramp that does not reach it, a
 *    gap), where the surface jumps, where the navigation grid blocks the way
 *    onto or off it;
 *  - water on decks: a water surface above a deck's top;
 *  - water seams: neighbouring water cells a few centimetres apart in level,
 *    which show as lines on the river. Steps of a metre and more are locks;
 *  - street furniture floating above or sunk into what it stands on, or
 *    standing in the water.
 *
 * Writes report.json and index.html (with links into the game) to --out and
 * prints a summary. Numbers are for comparing builds: run it before and
 * after a change to the pipeline.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const dir = opt('--dir', 'data/berlin');
const out = opt('--out', join(tmpdir(), 'gta-berlin-check'));
const gameUrl = opt('--url', 'http://localhost:5173/');
const only = opt('--tiles', '');
// --debug x,z: print the ends of the bridges near there, and the ground and decks along them
const debugAt = opt('--debug', '') ? opt('--debug', '').split(',').map(Number) : null;

// the game's modules, through vite: they import without file extensions
const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
const { TerrainField, NavGrid, parseProps } = await vite.ssrLoadModule('/src/tiles.ts') as typeof import('../web/src/tiles.ts');
const { Decks } = await vite.ssrLoadModule('/src/bridges.ts') as typeof import('../web/src/bridges.ts');
const { Shorelines } = await vite.ssrLoadModule('/src/shorelines.ts') as typeof import('../web/src/shorelines.ts');
const { makeFromWorld } = await vite.ssrLoadModule('/src/geo.ts') as typeof import('../web/src/geo.ts');
type Decks = InstanceType<typeof Decks>;

/** As in web/src/world.ts. */
const STEP_UP = 1.0;
/** Walking a deck: sample spacing, and how far before and after it to start and stop. */
const STRIDE = 0.5;
const APPROACH = 12;
/** A jump in the surface between two samples worth reporting, metres. */
const JUMP = 0.5;
/** Water this far above a deck's top shows on it. */
const WET_DECK = 0.05;
/** Level differences between neighbouring water cells: seams below LOCK, locks above. */
const SEAM = 0.02;
const LOCK = 1.0;
/** Furniture more than this off the surface under it. */
const FLOAT = 0.4;

interface DeckData { k: 'road' | 'path' | 'rail'; t: number; p: number[][];
  mesh?: { v: [number, number, number][]; i: number[]; r: number[][]; clip?: [number, number, number, number] } }
interface WaterData { cell: number; minX: number; minZ: number; rows: [number, [number, number, number][]][]; mesh?: { v: [number, number, number][]; i: number[]; r: number[][] } }

class Water {
  readonly minX: number;
  readonly minZ: number;
  readonly cell: number;
  readonly n: number;
  readonly level: Float32Array;
  private readonly mesh?: Decks;
  constructor(d: WaterData, size: number) {
    if (d.mesh) this.mesh = new Decks({ decks: [{ k: 'road', t: 0, mesh: d.mesh, p: [[0, 0, 0, 1, 1], [1, 0, 0, 1, 1]] }] });
    this.minX = d.minX;
    this.minZ = d.minZ;
    this.cell = d.cell;
    this.n = Math.round(size / d.cell);
    this.level = new Float32Array(this.n * this.n).fill(NaN);
    for (const [row, runs] of d.rows) {
      for (const [col, len, ycm] of runs) this.level.fill(ycm / 100, row * this.n + col, row * this.n + col + len);
    }
  }
  at(x: number, z: number): number {
    if (this.mesh) return this.mesh.at(x, z)[0]?.y ?? NaN;
    const c = Math.floor((x - this.minX) / this.cell), r = Math.floor((z - this.minZ) / this.cell);
    return c < 0 || r < 0 || c >= this.n || r >= this.n ? NaN : this.level[r * this.n + c];
  }
}

interface Tile {
  key: string;
  dir: string;
  terrain?: InstanceType<typeof TerrainField>;
  nav?: InstanceType<typeof NavGrid>;
  decks?: Decks;
  shorelines?: InstanceType<typeof Shorelines>;
  deckData: DeckData[];
  water?: Water;
}

const world = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
const origin = world.origin as { e: number; n: number; h: number };
const fromWorld = makeFromWorld(origin);
const SIZE = world.tile as number;
const loaded = new Map<string, Tile | null>();

const buf = (p: string): ArrayBuffer => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

function tile(key: string): Tile | null {
  if (loaded.has(key)) return loaded.get(key)!;
  const entry = world.tiles[key];
  let t: Tile | null = null;
  if (entry) {
    const d = join(dir, entry.dir);
    const m = JSON.parse(readFileSync(join(d, 'tile.json'), 'utf8'));
    t = { key, dir: d, deckData: [] };
    if (m.terrain) t.terrain = new TerrainField(buf(join(d, m.terrain.file)));
    if (m.nav) t.nav = new NavGrid(buf(join(d, m.nav.file)));
    if (m.shorelines) t.shorelines = new Shorelines(JSON.parse(readFileSync(join(d, m.shorelines.file), 'utf8')));
    if (m.bridges && existsSync(join(d, m.bridges.file))) {
      const b = JSON.parse(readFileSync(join(d, m.bridges.file), 'utf8'));
      t.deckData = b.decks;
      t.decks = new Decks(b);
    }
    if (m.water && existsSync(join(d, m.water.file))) {
      t.water = new Water(JSON.parse(readFileSync(join(d, m.water.file), 'utf8')), SIZE);
    }
  }
  loaded.set(key, t);
  // keep memory flat over a thousand tiles: only the recent ones
  if (loaded.size > 40) loaded.delete(loaded.keys().next().value!);
  return t;
}

const keyOf = (x: number, z: number) =>
  `${Math.floor((x + origin.e) / SIZE)}_${Math.floor((origin.n - z) / SIZE)}`;
const tileAt = (x: number, z: number) => tile(keyOf(x, z));
const ground = (x: number, z: number) => { const t = tileAt(x, z); return t?.shorelines?.height(x, z) ?? t?.terrain?.height(x, z) ?? NaN; };

/** World.height: the highest surface no more than a step above y. */
function height(x: number, z: number, y: number): number {
  const g = ground(x, z);
  let best = g <= y + STEP_UP ? g : -Infinity;
  for (const d of tileAt(x, z)?.decks?.at(x, z) ?? []) {
    if (d.y <= y + STEP_UP && d.y > best) best = d.y;
  }
  return best === -Infinity ? g : best;
}

const passable = (x: number, z: number, driving: boolean) =>
  tileAt(x, z)?.nav?.passable(x, z, driving) ?? false;

/* --- issues -------------------------------------------------------------- */

type Kind = 'uncrossable' | 'undrivable' | 'deck-hole' | 'dead-end' | 'off-deck' | 'jump' | 'blocked' | 'water-on-deck' | 'water-seam' | 'prop-floating' | 'prop-in-water';
interface Issue { kind: Kind; tile: string; x: number; z: number; what: string; size: number; img?: string }
const issues: Issue[] = [];
const seams = new Map<string, number>();
let decksWalked = 0, propsChecked = 0;

function report(kind: Kind, t: string, x: number, z: number, what: string, size: number): void {
  // one issue per kind within 10 m
  for (let i = issues.length - 1; i >= 0 && i >= issues.length - 50; i--) {
    const o = issues[i];
    if (o.kind === kind && Math.hypot(o.x - x, o.z - z) < 10) {
      if (size > o.size) { o.size = size; o.what = what; }
      return;
    }
  }
  issues.push({ kind, tile: t, x, z, what, size });
}

/** Walk one deck along its line, like the player. */
function walkDeck(t: Tile, d: DeckData): void {
  const p = d.p;
  if (p.length < 2) return;
  const len = p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);
  // pieces of a few metres at tile edges belong to the deck in the next tile
  if (len < 4) return;
  decksWalked++;
  const driving = d.k === 'road';
  const dirAt = (a: number[], b: number[]) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  // the line: approach, the stations, the way off
  const [sx, sz] = dirAt(p[0], p[1]);
  const [ex, ez] = dirAt(p[p.length - 2], p[p.length - 1]);
  const line: [number, number, number | null][] = [
    [p[0][0] - sx * APPROACH, p[0][1] - sz * APPROACH, null],
    ...p.map((q) => [q[0], q[1], q[2]] as [number, number, number]),
    [p[p.length - 1][0] + ex * APPROACH, p[p.length - 1][1] + ez * APPROACH, null],
  ];
  const samples: { x: number; z: number; deck: number | null }[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, az, ay] = line[i], [bx, bz, by] = line[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STRIDE));
    for (let s = 0; s < n; s++) {
      const f = s / n;
      samples.push({ x: ax + (bx - ax) * f, z: az + (bz - az) * f,
                     deck: ay !== null && by !== null ? ay + (by - ay) * f : null });
    }
  }
  const last = line[line.length - 1];
  samples.push({ x: last[0], z: last[1], deck: null });

  // arrive at the deck's level: the highest surface within a step of it
  let y = height(samples[0].x, samples[0].z, p[0][2]);
  let off = false, jumped = false, blocked = false;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    const ny = height(s.x, s.z, y);
    if (!Number.isFinite(ny)) return;          // off the built world
    const dy = ny - y;
    if (!jumped && Math.abs(dy) > JUMP) {
      report('jump', t.key, s.x, s.z, `${d.k}: surface ${dy > 0 ? 'rises' : 'drops'} ${Math.abs(dy).toFixed(1)} m in ${STRIDE} m`, Math.abs(dy));
      jumped = true;
    }
    y = ny;
    if (s.deck !== null) {
      const below = s.deck + 0.03 - y;    // decks are lifted apart by up to 3 cm
      if (!off && below > STEP_UP) {
        report('off-deck', t.key, s.x, s.z, `${d.k}: walker ${below.toFixed(1)} m below the deck`, below);
        off = true;
      }
      const w = tileAt(s.x, s.z)?.water?.at(s.x, s.z) ?? NaN;
      if (w > s.deck + WET_DECK) {
        report('water-on-deck', t.key, s.x, s.z, `${d.k}: water ${(w - s.deck).toFixed(2)} m above the deck`, w - s.deck);
      }
    } else if (!blocked && !passable(s.x, s.z, driving) && Math.abs(y - ground(s.x, s.z)) < 0.1) {
      // on the ground before or after the deck: the navigation grid decides
      report('blocked', t.key, s.x, s.z, `${d.k}: ${driving ? 'not drivable' : 'not walkable'} next to the deck end`, 1);
      blocked = true;
    }
  }
}

/** Neighbouring water cells a little apart in level, inside the tile and over its east and south edges. */
function waterSeams(t: Tile, east: Tile | null, south: Tile | null): void {
  const w = t.water;
  if (!w) return;
  const n = w.n, L = w.level;
  let metres = 0, worst = 0, wx = 0, wz = 0;
  const pair = (a: number, b: number, x: number, z: number) => {
    const d = Math.abs(a - b);
    if (d > SEAM && d < LOCK) {
      metres += w.cell;
      if (d > worst) { worst = d; wx = x; wz = z; }
    }
  };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const raw = L[r * n + c];
      if (Number.isNaN(raw)) continue;
      const x = w.minX + (c + 1) * w.cell, z = w.minZ + (r + 1) * w.cell;
      const rightRaw = c + 1 < n ? L[r * n + c + 1] : east?.water?.level[r * n] ?? NaN;
      const downRaw = r + 1 < n ? L[(r + 1) * n + c] : south?.water?.level[c] ?? NaN;
      // Candidate edges come from the source grid, but compare the actual
      // rendered surface on either side of that edge, not its gentle grade.
      if (Math.abs(raw - rightRaw) > SEAM && Math.abs(raw - rightRaw) < LOCK) {
        const a = w.at(x - 0.001, z - w.cell / 2);
        const b = (c + 1 < n ? w : east?.water)?.at(x + 0.001, z - w.cell / 2) ?? NaN;
        if (Number.isFinite(a) && Number.isFinite(b)) pair(a, b, x, z - w.cell / 2);
      }
      if (Math.abs(raw - downRaw) > SEAM && Math.abs(raw - downRaw) < LOCK) {
        const a = w.at(x - w.cell / 2, z - 0.001);
        const b = (r + 1 < n ? w : south?.water)?.at(x - w.cell / 2, z + 0.001) ?? NaN;
        if (Number.isFinite(a) && Number.isFinite(b)) pair(a, b, x - w.cell / 2, z);
      }
    }
  }
  if (metres) {
    seams.set(t.key, metres);
    report('water-seam', t.key, wx, wz, `${metres} m of seams in the tile, worst step ${(worst * 100).toFixed(0)} cm`, metres);
  }
}

function props(t: Tile): void {
  const p = join(t.dir, 'props.bin');
  if (!existsSync(p)) return;
  for (const q of parseProps(buf(p))) {
    propsChecked++;
    const s = height(q.x, q.z, q.y);
    if (Math.abs(q.y - s) > FLOAT) {
      report('prop-floating', t.key, q.x, q.z, `${q.y > s ? 'floats' : 'sunk'} ${Math.abs(q.y - s).toFixed(1)} m`, Math.abs(q.y - s));
    }
    const w = t.water?.at(q.x, q.z) ?? NaN;
    if (w > q.y + 0.2) report('prop-in-water', t.key, q.x, q.z, `${(w - q.y).toFixed(1)} m under water`, w - q.y);
  }
}

/* --- flood: can each bridge be crossed? ---------------------------------- */

/*
 * Walking a deck along its own line misses what the player does: steps on
 * from the side, takes the separately mapped pavement, goes round a gap. So
 * each bridge is also flooded, by the game's own rules - World.canStep, the
 * player's cross probe, World.height - on a half-metre grid around it.
 *
 * A bridge is the road and path decks that touch at about the same level
 * (pieces at tile edges, a road and its pavement, a ramp). Its free ends -
 * where no deck carries on - are its landings when there is ground to stand
 * on at the deck's level just beyond, and dead ends when there is not. Every
 * landing should reach every other one, on foot and, for roads, driving.
 */

const RES = 0.5;
/** Ground around a bridge that the flood may use, metres. */
const MARGIN = 25;
/** A landing: within this of a point just past the deck end, at its level. */
const LAND_R = 2.5;
const LAND_DY = 1.2;
/** Bridges bigger than this (viaducts across whole districts) are skipped. */
const MAX_AREA = 2e6;
const MAX_HITS = 6;

interface Piece { k: DeckData['k']; p: number[][]; id: number; mesh?: DeckData['mesh']; field: Decks }
const pieces: Piece[] = [];
const pieceBuckets = new Map<string, number[]>();
const PB = 32;

/** The height of piece q at (x, z) with `inset` metres off its edges, or NaN - as Decks.at. */
function pieceAt(q: Piece, x: number, z: number, inset = 0): number {
  return q.field.at(x, z, inset)[0]?.y ?? NaN;
}

function piecesNear(x: number, z: number): number[] {
  return pieceBuckets.get(`${Math.floor(x / PB)},${Math.floor(z / PB)}`) ?? [];
}

function collectPieces(tileKeys: string[]): void {
  for (const key of tileKeys) {
    const entry = world.tiles[key];
    if (!entry) continue;
    const d = join(dir, entry.dir);
    const m = JSON.parse(readFileSync(join(d, 'tile.json'), 'utf8'));
    if (!m.bridges || !existsSync(join(d, m.bridges.file))) continue;
    for (const dd of JSON.parse(readFileSync(join(d, m.bridges.file), 'utf8')).decks as DeckData[]) {
      if (dd.k === 'rail' || dd.p.length < 2) continue;
      const q: Piece = { k: dd.k, p: dd.p, mesh: dd.mesh, id: pieces.length,
        field: new Decks({ decks: [dd as ConstructorParameters<typeof Decks>[0]['decks'][number]] }) };
      pieces.push(q);
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z, , l, r = l] of dd.p) {
        const w = Math.max(l, r);
        x0 = Math.min(x0, x - w); x1 = Math.max(x1, x + w);
        z0 = Math.min(z0, z - w); z1 = Math.max(z1, z + w);
      }
      for (const [x, z] of dd.mesh?.v ?? []) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      for (let cx = Math.floor(x0 / PB); cx <= Math.floor(x1 / PB); cx++) {
        for (let cz = Math.floor(z0 / PB); cz <= Math.floor(z1 / PB); cz++) {
          const k = `${cx},${cz}`;
          let list = pieceBuckets.get(k);
          if (!list) pieceBuckets.set(k, list = []);
          list.push(q.id);
        }
      }
    }
  }
}

interface End { x: number; z: number; y: number; ux: number; uz: number; piece: number }

/** Both ends of a piece, each with the direction out of the deck. */
function endsOf(q: Piece): End[] {
  const p = q.p, n = p.length;
  const out = (a: number[], b: number[]): End => {
    const l = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
    return { x: a[0], z: a[1], y: a[2], ux: (a[0] - b[0]) / l, uz: (a[1] - b[1]) / l, piece: q.id };
  };
  return [out(p[0], p[1]), out(p[n - 1], p[n - 2])];
}

/** Bridges: pieces whose ends lie on each other at about the same level. */
function bridges(): Piece[][] {
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const q of pieces) {
    for (const e of endsOf(q)) {
      for (const o of piecesNear(e.x, e.z)) {
        if (o === q.id) continue;
        const y = pieceAt(pieces[o], e.x + e.ux * 0.5, e.z + e.uz * 0.5);
        const y2 = pieceAt(pieces[o], e.x, e.z);
        if (Math.abs(y - e.y) <= STEP_UP || Math.abs(y2 - e.y) <= STEP_UP) parent[find(q.id)] = find(o);
      }
    }
  }
  const groups = new Map<number, Piece[]>();
  for (const q of pieces) {
    const r = find(q.id);
    let g = groups.get(r);
    if (!g) groups.set(r, g = []);
    g.push(q);
  }
  return [...groups.values()];
}

/** The surfaces of a window around a bridge, cell by cell, for the flood. */
/** The player's cross probe (Player.step): 0.4 m out west, east, north and south. */
const PROBE = [[-0.4, 0], [0.4, 0], [0, -0.4], [0, 0.4]];

/**
 * Surfaces are sampled at each cell's centre - sample c - and at the four
 * points of the player's probe around it - samples n + 4c + k - so a step is
 * decided at the points the game decides it at.
 */
class Window {
  readonly x0: number; readonly z0: number; readonly nx: number; readonly nz: number;
  /** Cells; the samples run on past them with the probes. */
  readonly n: number;
  readonly ground: Float32Array;
  /** bit 0 walkable, bit 1 drivable */
  readonly nav: Uint8Array;
  readonly hits: Uint8Array;
  readonly dy: Float32Array;
  /** bit 0 a path deck, bit 1 still on it 0.3 m in from the edge, bit 2 1.0 m in */
  readonly dflag: Uint8Array;

  constructor(x0: number, z0: number, x1: number, z1: number) {
    this.x0 = x0; this.z0 = z0;
    this.nx = Math.ceil((x1 - x0) / RES); this.nz = Math.ceil((z1 - z0) / RES);
    const n = this.n = this.nx * this.nz;
    const N = n * 5;
    this.ground = new Float32Array(N);
    this.nav = new Uint8Array(N);
    this.hits = new Uint8Array(N);
    this.dy = new Float32Array(N * MAX_HITS);
    this.dflag = new Uint8Array(N * MAX_HITS);
    {
      for (let c = 0; c < N; c++) {
        const [cx, cz] = this.xz(c < n ? c : (c - n) >> 2);
        const [ox, oz] = c < n ? [0, 0] : PROBE[(c - n) & 3];
        const x = cx + ox, z = cz + oz;
        const t = tileAt(x, z);
        this.ground[c] = ground(x, z);
        this.nav[c] = (t?.nav?.passable(x, z, false) ? 1 : 0) | (t?.nav?.passable(x, z, true) ? 2 : 0);
        const decks = t?.decks;
        if (!decks) continue;
        const all = decks.at(x, z), in3 = decks.at(x, z, 0.3), in10 = decks.at(x, z, 1.0);
        const has = (list: typeof all, h: (typeof all)[number]) => list.some((o) => o.y === h.y && o.kind === h.kind);
        let k = 0;
        for (const h of all) {
          if (k === MAX_HITS) break;
          this.dy[c * MAX_HITS + k] = h.y;
          this.dflag[c * MAX_HITS + k] = (h.kind === 'path' ? 1 : 0) | (has(in3, h) ? 2 : 0) | (has(in10, h) ? 4 : 0);
          k++;
        }
        this.hits[c] = k;
      }
    }
  }

  xz(c: number): [number, number] {
    return [this.x0 + (c % this.nx + 0.5) * RES, this.z0 + (Math.floor(c / this.nx) + 0.5) * RES];
  }

  cell(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / RES), j = Math.floor((z - this.z0) / RES);
    return i < 0 || j < 0 || i >= this.nx || j >= this.nz ? -1 : j * this.nx + i;
  }

  /** World.height(x, z, y) at a cell, as the layer it lands on: 0 the ground, k + 1 deck k. */
  land(c: number, y: number): number {
    const g = this.ground[c];
    let best = g <= y + STEP_UP ? g : -Infinity, layer = 0;
    for (let k = 0; k < this.hits[c]; k++) {
      const d = this.dy[c * MAX_HITS + k];
      if (d <= y + STEP_UP && d > best) { best = d; layer = k + 1; }
    }
    return best === -Infinity ? 0 : layer;
  }

  y(c: number, layer: number): number {
    return layer === 0 ? this.ground[c] : this.dy[c * MAX_HITS + layer - 1];
  }

  /** World.deckAt: the first deck within a step of y, `bit` the inset it must
   *  clear; with `road`, the first that is not a path. */
  private deckAt(c: number, y: number, bit: number, road = false): number {
    for (let k = 0; k < this.hits[c]; k++) {
      const f = this.dflag[c * MAX_HITS + k];
      if ((bit === 0 || f & bit) && !(road && f & 1) && Math.abs(this.dy[c * MAX_HITS + k] - y) <= STEP_UP) return k;
    }
    return -1;
  }

  /** World.canStep. */
  canStep(from: number, to: number, y: number, driving: boolean): boolean {
    if (to < 0) return false;
    if (this.deckAt(to, y, driving ? 4 : 2, driving) >= 0) return true;
    if (driving && this.deckAt(to, y, 4) >= 0) return false;
    const pass = (this.nav[to] & (driving ? 2 : 1)) !== 0;
    if (this.deckAt(from, y, 0) >= 0) return pass && Math.abs(this.ground[to] - y) <= STEP_UP;
    return pass;
  }

  /** Player.step: the cell and the cross around it. */
  free(from: number, to: number, y: number, driving: boolean): boolean {
    if (to < 0 || !this.canStep(from, to, y, driving)) return false;
    for (let k = 0; k < 4; k++) if (!this.canStep(from, this.n + to * 4 + k, y, driving)) return false;
    return true;
  }

  /** Why a step from `from` at height y to `to` is refused, or null if it is not. */
  why(from: number, to: number, y: number, driving: boolean): string | null {
    const one = (t: number): string | null => {
      if (t < 0) return 'outside the window';
      if (this.deckAt(t, y, driving ? 4 : 2, driving) >= 0) return null;
      if (driving && this.deckAt(t, y, 4) >= 0) return 'onto a footbridge by car';
      const near = Array.from({ length: this.hits[t] }, (_, k) => this.dy[t * MAX_HITS + k]);
      const tail = near.length ? ` (decks there at ${near.map((v) => v.toFixed(1)).join(', ')}, ` +
        `${near.some((v) => Math.abs(v - y) <= STEP_UP) ? 'too near its edge' : 'more than a step away'})` : '';
      const pass = (this.nav[t] & (driving ? 2 : 1)) !== 0;
      if (this.deckAt(from, y, 0) >= 0) {
        if (!pass) return `off the deck onto ground not ${driving ? 'drivable' : 'walkable'}${tail}`;
        if (Math.abs(this.ground[t] - y) > STEP_UP) return `off the deck, ground ${(this.ground[t] - y).toFixed(1)} m away${tail}`;
        return null;
      }
      return pass ? null : `ground not ${driving ? 'drivable' : 'walkable'}${tail}`;
    };
    const r = one(to);
    if (r) return r;
    for (const [k, side] of ['west', 'east', 'north', 'south'].entries()) {
      const q = one(this.n + to * 4 + k);
      if (q) return `the probe ${side}: ${q}`;
    }
    return null;
  }

  /** Everything reachable from the seeds: one bit per cell and layer. */
  flood(seeds: [number, number][], driving: boolean): Uint8Array {
    const seen = new Uint8Array(this.n);
    const queue: number[] = [];
    for (const [c, l] of seeds) {
      if (seen[c] & (1 << l)) continue;
      seen[c] |= 1 << l;
      queue.push(c, l);
    }
    const nx = this.nx;
    const NB = [-1, 1, -nx, nx, -nx - 1, -nx + 1, nx - 1, nx + 1];
    for (let q = 0; q < queue.length; q += 2) {
      const c = queue[q], y = this.y(c, queue[q + 1]);
      const i = c % nx;
      for (const o of NB) {
        const n = c + o;
        if (n < 0 || n >= this.n) continue;
        const ni = n % nx;
        if (Math.abs(ni - i) > 1) continue;            // wrapped round a row end
        if (!this.free(c, n, y, driving)) continue;
        const l = this.land(n, y);
        if (seen[n] & (1 << l)) continue;
        seen[n] |= 1 << l;
        queue.push(n, l);
      }
    }
    return seen;
  }

  /** States around a deck end at its level, as [cell, layer]. */
  around(e: End, test: (c: number, layer: number) => boolean): [number, number][] {
    const cx = e.x + e.ux * 1.5, cz = e.z + e.uz * 1.5;
    const out: [number, number][] = [];
    for (let z = cz - LAND_R; z <= cz + LAND_R; z += RES) {
      for (let x = cx - LAND_R; x <= cx + LAND_R; x += RES) {
        if (Math.hypot(x - cx, z - cz) > LAND_R) continue;
        // in front of the end: the ground beside a deck is no way off its end
        if ((x - e.x) * e.ux + (z - e.z) * e.uz < 0.25) continue;
        const c = this.cell(x, z);
        if (c < 0) continue;
        for (let l = 0; l <= this.hits[c]; l++) {
          if (Math.abs(this.y(c, l) - e.y) <= LAND_DY && test(c, l)) out.push([c, l]);
        }
      }
    }
    return out;
  }
}

let bridgesFlooded = 0, bridgesSkipped = 0, drawn = 0;

/**
 * Holes in a bridge: a spot neither deck nor ground you may use, with deck on
 * both sides of it - where two pieces meet with a gap, say. A bridge can be
 * crossable round it and still stop you dead in your lane: an invisible
 * wall. For walkers (a deck 0.3 m in from its edge) and, on road decks, for
 * cars (a road deck 1 m in).
 */
function holes(w: Window, roads: boolean): void {
  const nx = w.nx, R = 4;   // deck within 2 m each side
  for (const driving of roads ? [false, true] : [false]) {
    const usable = (c: number) => {
      for (let k = 0; k < w.hits[c]; k++) {
        const f = w.dflag[c * MAX_HITS + k];
        if (driving ? f & 4 && !(f & 1) : f & 2) return true;
      }
      return false;
    };
    for (let c = 0; c < w.n; c++) {
      if (usable(c) || w.nav[c] & (driving ? 2 : 1) || !w.hits[c] && !Number.isFinite(w.ground[c])) continue;
      const i = c % nx, j = Math.floor(c / nx);
      const side = (di: number, dj: number) => {
        for (let k = 1; k <= R; k++) {
          const ii = i + di * k, jj = j + dj * k;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= w.nz) return -1;
          if (usable(jj * nx + ii)) return jj * nx + ii;
        }
        return -1;
      };
      const heights = (cell: number) => Array.from({ length: w.hits[cell] }, (_, k) => {
        const f = w.dflag[cell * MAX_HITS + k];
        return (driving ? f & 4 && !(f & 1) : f & 2) ? w.dy[cell * MAX_HITS + k] : NaN;
      }).filter(Number.isFinite);
      const opposite = (a: number, b: number) => a >= 0 && b >= 0 && heights(a).some((ya) => heights(b).some((yb) => Math.abs(ya - yb) < 0.5));
      if (opposite(side(1, 0), side(-1, 0)) || opposite(side(0, 1), side(0, -1))) {
        const [x, z] = w.xz(c);
        // The inset beside a surveyed outer edge is intentional clearance
        // from a guardrail. It is not a missing piece inside the bridge.
        if (piecesNear(x, z).some((i) => {
          const p = pieces[i];
          return p.mesh && Number.isFinite(pieceAt(p, x, z)) && !Number.isFinite(pieceAt(p, x, z, driving ? 1 : 0.3));
        })) continue;
        report('deck-hole', keyOf(x, z), x, z, `a hole in the deck ${driving ? 'for cars' : 'for walkers'}`, 1);
      }
    }
  }
}

function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
                        chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * A failed bridge as a picture, north up, a pixel per cell: ground grey
 * (lighter where passable), decks orange (roads) and yellow (paths), what the
 * flood from the main side reached green, landings blue when reached and
 * red when not, the break a magenta cross.
 */
function draw(w: Window, seen: Uint8Array, driving: boolean, ends: { e: End; ok: boolean }[], bx: number, bz: number): string {
  const rgb = new Uint8Array(w.n * 3);
  const put = (c: number, r: number, g: number, b: number) => { rgb[c * 3] = r; rgb[c * 3 + 1] = g; rgb[c * 3 + 2] = b; };
  for (let c = 0; c < w.n; c++) {
    const pass = (w.nav[c] & (driving ? 2 : 1)) !== 0;
    let col = pass ? [150, 150, 150] : [60, 60, 66];
    if (w.hits[c]) col = (w.dflag[c * MAX_HITS] & 1) ? [215, 190, 60] : [205, 120, 50];
    if (seen[c] & 1) col = [col[0] * 0.4, col[1] * 0.4 + 120, col[2] * 0.4];
    if (seen[c] & ~1) col = [60, 230, 90];
    put(c, col[0], col[1], col[2]);
  }
  const dot = (x: number, z: number, r: number, col: number[]) => {
    for (let dz = -r; dz <= r; dz += RES) for (let dx = -r; dx <= r; dx += RES) {
      if (Math.hypot(dx, dz) > r) continue;
      const c = w.cell(x + dx, z + dz);
      if (c >= 0) put(c, col[0], col[1], col[2]);
    }
  };
  for (const { e, ok } of ends) dot(e.x + e.ux * 1.5, e.z + e.uz * 1.5, 1.5, ok ? [60, 120, 255] : [255, 40, 40]);
  for (let d = -3; d <= 3; d += RES) {
    for (const [x, z] of [[bx + d, bz + d], [bx + d, bz - d]]) {
      const c = w.cell(x, z);
      if (c >= 0) put(c, 255, 0, 255);
    }
  }
  const file = `flood/${Math.round(bx)}_${Math.round(bz)}_${driving ? 'drive' : 'foot'}.png`;
  mkdirSync(join(out, 'flood'), { recursive: true });
  writeFileSync(join(out, file), png(w.nx, w.nz, rgb));
  drawn++;
  return file;
}

function floodBridge(group: Piece[]): void {
  // free ends: nothing of the bridge carries on just past them; one per spot
  const ends: End[] = [];
  for (const q of group) {
    for (const e of endsOf(q)) {
      const px = e.x + e.ux * 1.0, pz = e.z + e.uz * 1.0;
      const carried = group.some((o) => Math.abs(pieceAt(o, px, pz) - e.y) <= STEP_UP);
      if (!carried && !ends.some((o) => Math.hypot(o.x - e.x, o.z - e.z) < 4)) ends.push(e);
    }
  }
  if (ends.length < 2) return;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const q of group) {
    for (const [x, z] of q.mesh?.v ?? q.p) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
  }
  x0 -= MARGIN; x1 += MARGIN; z0 -= MARGIN; z1 += MARGIN;
  if ((x1 - x0) * (z1 - z0) > MAX_AREA) { bridgesSkipped++; return; }
  const w = new Window(x0, z0, x1, z1);
  if (ends.some((e) => Number.isNaN(w.ground[w.cell(e.x, e.z)]))) return;   // off the built world
  bridgesFlooded++;
  holes(w, group.map((q) => q.k).includes('road'));
  if (debugAt && group.some((q) => q.p.some(([x, z]) => Math.hypot(x - debugAt[0], z - debugAt[1]) < 60))) {
    for (const q of group) console.log(`  piece ${q.id} ${q.k}: ${q.p.map((s) => s.map((v) => v.toFixed(1)).join(' ')).join(' | ')}`);
    for (const e of ends) {
      const line: string[] = [];
      for (let d = -3; d <= 8; d++) {
        const c = w.cell(e.x + e.ux * d, e.z + e.uz * d);
        if (c < 0) continue;
        const decks = Array.from({ length: w.hits[c] }, (_, k) => `${w.dy[c * MAX_HITS + k].toFixed(1)}/${w.dflag[c * MAX_HITS + k]}`);
        line.push(`${d}m g${w.ground[c].toFixed(1)} n${w.nav[c]} [${decks.join(',')}]`);
      }
      console.log(`  end ${e.x.toFixed(1)},${e.z.toFixed(1)} y${e.y.toFixed(1)} piece ${e.piece}: ${line.join('  ')}`);
    }
  }
  const kinds = [...new Set(group.map((q) => q.k))].join('+');

  for (const driving of [false, true]) {
    if (driving && !group.some((q) => q.k === 'road')) continue;
    // ground to stand on just past each end, at the deck's level
    // a car lands only off a road deck: a footbridge's end is no way on for
    // it; and an end that runs into a building (a passage, a doorway) has
    // nothing to land on, whatever lies beside it
    const intoHouse = (e: End) => [0.5, 1.0].some((d) =>
      tileAt(e.x + e.ux * d, e.z + e.uz * d)?.nav?.has(e.x + e.ux * d, e.z + e.uz * d, NavGrid.BUILDING));
    const seeds = ends.map((e) => (driving && pieces[e.piece].k !== 'road' || intoHouse(e) ? [] : w.around(e, (c, l) => {
      if (!(w.nav[c] & (driving ? 2 : 1))) return false;
      return w.land(c, w.ground[c]) === l;
    })));
    const landings = ends.map((e, i) => ({ e, seeds: seeds[i] })).filter((l) => l.seeds.length);
    if (!driving) {
      ends.forEach((e, i) => {
        if (seeds[i].length) return;
        const c = w.cell(e.x + e.ux * 2, e.z + e.uz * 2);
        const g = c >= 0 ? w.ground[c] - e.y : NaN;
        report('dead-end', keyOf(e.x, e.z), e.x, e.z,
          `${kinds}: deck ends ${intoHouse(e) ? 'in a building' : Number.isFinite(g) ? `${g > 0 ? 'below' : 'above'} the ground by ${Math.abs(g).toFixed(1)} m` : 'outside the world'}` +
          `${c >= 0 && !(w.nav[c] & 1) ? ', ground there not walkable' : ''}`, Math.abs(g) || 1);
      });
    }
    if (landings.length < 2) continue;
    // which landings reach which: flood from one not yet reached until all are
    const comp = new Array<number>(landings.length).fill(-1);
    const floods: Uint8Array[] = [];
    for (let a = 0; a < landings.length; a++) {
      if (comp[a] >= 0) continue;
      const seen = w.flood(landings[a].seeds, driving);
      const id = floods.length;
      floods.push(seen);
      landings.forEach((l, b) => {
        if (comp[b] < 0 && w.around(l.e, (c, layer) => (seen[c] & (1 << layer)) !== 0).length) comp[b] = id;
      });
      comp[a] = id;
    }
    if (floods.length < 2) continue;
    // the biggest group of landings is the bridge; every other one is cut off
    const size = floods.map((_, id) => comp.filter((c) => c === id).length);
    const main = size.indexOf(Math.max(...size));
    const seen = floods[main];
    const explained = new Set<string>();
    if (debugAt && landings.some((l) => Math.hypot(l.e.x - debugAt[0], l.e.z - debugAt[1]) < 300)) {
      console.log(`  ${driving ? 'drive' : 'foot'} landings: ` + landings.map((l, k) =>
        `${l.e.x.toFixed(0)},${l.e.z.toFixed(0)} y${l.e.y.toFixed(1)} #${comp[k]}${comp[k] === main ? '*' : ''}`).join('  '));
    }
    landings.forEach((l, b) => {
      if (comp[b] === main) return;
      // where the walk from the main side gets closest: the break
      let best = Infinity, bx = l.e.x, bz = l.e.z;
      for (let c = 0; c < seen.length; c++) {
        if (!seen[c]) continue;
        const [x, z] = w.xz(c);
        const d = Math.hypot(x - l.e.x, z - l.e.z);
        if (d < best) { best = d; bx = x; bz = z; }
      }
      const oneWay = w.around(landings[main].e, (c, layer) => (floods[comp[b]][c] & (1 << layer)) !== 0).length > 0;
      if (debugAt && Math.hypot(bx - debugAt[0], bz - debugAt[1]) < 300 && !explained.has(`${comp[b]}${driving}`)) {
        explained.add(`${comp[b]}${driving}`);
        // where the two floods meet: each refused step from the main side into the other's
        const other = floods[comp[b]];
        const reasons = new Map<string, [number, number, number]>();
        const nx = w.nx;
        for (let c = 0; c < seen.length; c++) {
          if (!seen[c]) continue;
          for (const o of [-1, 1, -nx, nx]) {
            const n = c + o;
            if (n < 0 || n >= seen.length || !((other[n] & ~seen[n] & ~1) || (w.hits[n] && !seen[n]))) continue;   // a deck the main side misses
            for (let l = 0; l < 8; l++) {
              if (!(seen[c] & (1 << l))) continue;
              const y = w.y(c, l);
              const r = w.why(c, n, y, driving) ?? `steps to layer ${w.land(n, y)}, the other side is on ${other[n]}`;
              const [x, z] = w.xz(n);
              const k = `${r} @ y ${y.toFixed(1)}`;
              const e = reasons.get(k);
              reasons.set(k, e ? [e[0] + 1, e[1], e[2]] : [1, x, z]);
            }
          }
        }
        const at = process.env.MAP?.split(',').map(Number);
        if (at) {
          // M main side on a deck, O the other side on one, digits: decks no flood got onto, # closed ground
          for (let z = at[1] - 12; z <= at[1] + 12; z += RES) {
            let row = '';
            for (let x = at[0] - 25; x <= at[0] + 25; x += RES) {
              const c = w.cell(x, z);
              row += c < 0 ? ' ' : seen[c] & ~1 ? 'M' : other[c] & ~1 ? 'O' : w.hits[c] ? String(w.hits[c])
                : (w.nav[c] & (driving ? 2 : 1)) ? '.' : '#';
            }
            console.log('    ' + row);
          }
        }
        console.log(`  ${driving ? 'drive' : 'foot'} break near ${bx.toFixed(0)}, ${bz.toFixed(0)}:`);
        for (const [k, [n, x, z]] of [...reasons].sort((p, q) => q[1][0] - p[1][0]).slice(0, 8)) {
          console.log(`    ${n} x ${k} (e.g. ${x.toFixed(1)}, ${z.toFixed(1)})`);
        }
      }
      report(driving ? 'undrivable' : 'uncrossable', keyOf(bx, bz), bx, bz,
        `${kinds}: the end at ${l.e.x.toFixed(0)}, ${l.e.z.toFixed(0)} is cut off ${best.toFixed(0)} m short` +
        `${oneWay ? ' (one way: from there you get across)' : ''}`, best);
      const last = issues[issues.length - 1];
      if (!last.img && drawn < 400 && Math.hypot(last.x - bx, last.z - bz) < 1) {
        last.img = draw(w, seen, driving, landings.map((o, k) => ({ e: o.e, ok: comp[k] === main })), bx, bz);
      }
    });
  }
}

/* --- run ----------------------------------------------------------------- */

const keys = (only ? only.split(',') : Object.keys(world.tiles)).sort();
const t0 = Date.now();
keys.forEach((key, i) => {
  const t = tile(key);
  if (!t) return;
  const [e, n] = key.split('_').map(Number);
  for (const d of t.deckData) walkDeck(t, d);
  waterSeams(t, tile(`${e + 1}_${n}`), tile(`${e}_${n - 1}`));
  props(t);
  if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${keys.length} tiles`);
});

if (!args.includes('--no-flood')) {
  collectPieces(keys);
  // in tile order, so the tiles each flood needs are mostly still loaded
  const groups = bridges().sort((a, b) => {
    const ka = keyOf(a[0].p[0][0], a[0].p[0][1]), kb = keyOf(b[0].p[0][0], b[0].p[0][1]);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  console.log(`flooding ${groups.length} bridges (${pieces.length} road and path decks)`);
  groups.forEach((g, i) => {
    floodBridge(g);
    if ((i + 1) % 500 === 0) console.log(`  ${i + 1}/${groups.length} bridges`);
  });
}
await vite.close();

const KINDS: Kind[] = ['uncrossable', 'undrivable', 'deck-hole', 'dead-end', 'off-deck', 'jump', 'blocked', 'water-on-deck', 'water-seam', 'prop-in-water', 'prop-floating'];
const count = (k: Kind) => issues.filter((i) => i.kind === k).length;
const seamKm = [...seams.values()].reduce((a, b) => a + b, 0) / 1000;
console.log(`${keys.length} tiles, ${decksWalked} decks walked, ${bridgesFlooded} bridges flooded (${bridgesSkipped} too big), ${propsChecked} props in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const k of KINDS) console.log(`  ${k.padEnd(14)} ${count(k)}`);
console.log(`  water seams    ${seamKm.toFixed(1)} km`);

mkdirSync(out, { recursive: true });
const link = (i: Issue) => {
  const [lon, lat] = fromWorld(i.x, i.z);
  return `${gameUrl}#${lat.toFixed(5)},${lon.toFixed(5)}`;
};
writeFileSync(join(out, 'report.json'), JSON.stringify({
  dir, date: new Date().toISOString(), tiles: keys.length, decksWalked, bridgesFlooded, bridgesSkipped, propsChecked, seamKm,
  counts: Object.fromEntries(KINDS.map((k) => [k, count(k)])),
  issues: issues.map((i) => ({ ...i, link: link(i) })),
}, null, 1));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const html = `<!doctype html><meta charset="utf-8"><title>World check</title>
<style>body{font:14px system-ui;background:#16181d;color:#ddd;margin:16px}a{color:#8cf}
table{border-collapse:collapse}td,th{padding:3px 10px;text-align:left;border-bottom:1px solid #333}</style>
<h1>World check - ${esc(dir)} - ${new Date().toISOString()}</h1>
<p>${keys.length} tiles, ${decksWalked} decks walked, ${bridgesFlooded} bridges flooded, ${propsChecked} props; water seams ${seamKm.toFixed(1)} km</p>
${KINDS.map((k) => {
  const list = issues.filter((i) => i.kind === k).sort((a, b) => b.size - a.size);
  return `<h2>${k} (${list.length})</h2><table>${list.slice(0, 200).map((i) =>
    `<tr><td><a href="${link(i)}">${i.tile}</a></td><td>${i.x.toFixed(0)}, ${i.z.toFixed(0)}</td><td>${esc(i.what)}</td><td>${i.img ? `<a href="${i.img}">map</a>` : ''}</td></tr>`).join('')}</table>`;
}).join('\n')}`;
writeFileSync(join(out, 'index.html'), html);
console.log(`-> ${join(out, 'index.html')}`);
