/*
 * Checks a built world for the things that broke before, without a browser:
 * the game's own readers (TerrainField, NavGrid, Decks) on the files in a
 * build folder, and the game's rule for what you stand on (World.height).
 *
 *   node scripts/check.ts                                # data/berlin
 *   node scripts/check.ts --dir data/berlin_v2 --out /tmp/check
 *   node scripts/check.ts --tiles 392_5819,393_5818
 *
 * What it looks for:
 *
 *  - bridges you cannot cross: every deck walked along its line, from a bit
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

// the game's modules, through vite: they import without file extensions
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { TerrainField, NavGrid, parseProps } = await vite.ssrLoadModule('/src/tiles.ts') as typeof import('../web/src/tiles.ts');
const { Decks } = await vite.ssrLoadModule('/src/bridges.ts') as typeof import('../web/src/bridges.ts');
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

interface DeckData { k: 'road' | 'path' | 'rail'; t: number; p: number[][] }
interface WaterData { cell: number; minX: number; minZ: number; rows: [number, [number, number, number][]][] }

class Water {
  readonly minX: number;
  readonly minZ: number;
  readonly cell: number;
  readonly n: number;
  readonly level: Float32Array;
  constructor(d: WaterData, size: number) {
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
const ground = (x: number, z: number) => tileAt(x, z)?.terrain?.height(x, z) ?? NaN;

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

type Kind = 'off-deck' | 'jump' | 'blocked' | 'water-on-deck' | 'water-seam' | 'prop-floating' | 'prop-in-water';
interface Issue { kind: Kind; tile: string; x: number; z: number; what: string; size: number }
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
      const a = L[r * n + c];
      if (Number.isNaN(a)) continue;
      const x = w.minX + (c + 1) * w.cell, z = w.minZ + (r + 1) * w.cell;
      const right = c + 1 < n ? L[r * n + c + 1] : east?.water?.level[r * n] ?? NaN;
      const down = r + 1 < n ? L[(r + 1) * n + c] : south?.water?.level[c] ?? NaN;
      if (!Number.isNaN(right)) pair(a, right, x, z - w.cell / 2);
      if (!Number.isNaN(down)) pair(a, down, x - w.cell / 2, z);
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
await vite.close();

const KINDS: Kind[] = ['off-deck', 'jump', 'blocked', 'water-on-deck', 'water-seam', 'prop-in-water', 'prop-floating'];
const count = (k: Kind) => issues.filter((i) => i.kind === k).length;
const seamKm = [...seams.values()].reduce((a, b) => a + b, 0) / 1000;
console.log(`${keys.length} tiles, ${decksWalked} decks walked, ${propsChecked} props in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const k of KINDS) console.log(`  ${k.padEnd(14)} ${count(k)}`);
console.log(`  water seams    ${seamKm.toFixed(1)} km`);

mkdirSync(out, { recursive: true });
const link = (i: Issue) => {
  const [lon, lat] = fromWorld(i.x, i.z);
  return `${gameUrl}#${lat.toFixed(5)},${lon.toFixed(5)}`;
};
writeFileSync(join(out, 'report.json'), JSON.stringify({
  dir, date: new Date().toISOString(), tiles: keys.length, decksWalked, propsChecked, seamKm,
  counts: Object.fromEntries(KINDS.map((k) => [k, count(k)])),
  issues: issues.map((i) => ({ ...i, link: link(i) })),
}, null, 1));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const html = `<!doctype html><meta charset="utf-8"><title>World check</title>
<style>body{font:14px system-ui;background:#16181d;color:#ddd;margin:16px}a{color:#8cf}
table{border-collapse:collapse}td,th{padding:3px 10px;text-align:left;border-bottom:1px solid #333}</style>
<h1>World check - ${esc(dir)} - ${new Date().toISOString()}</h1>
<p>${keys.length} tiles, ${decksWalked} decks walked, ${propsChecked} props; water seams ${seamKm.toFixed(1)} km</p>
${KINDS.map((k) => {
  const list = issues.filter((i) => i.kind === k).sort((a, b) => b.size - a.size);
  return `<h2>${k} (${list.length})</h2><table>${list.slice(0, 200).map((i) =>
    `<tr><td><a href="${link(i)}">${i.tile}</a></td><td>${i.x.toFixed(0)}, ${i.z.toFixed(0)}</td><td>${esc(i.what)}</td></tr>`).join('')}</table>`;
}).join('\n')}`;
writeFileSync(join(out, 'index.html'), html);
console.log(`-> ${join(out, 'index.html')}`);
