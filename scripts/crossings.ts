/** Traverse real built bridges using World and Player's actual movement probe. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import * as THREE from 'three';

const dir = process.argv[2] ?? 'data/berlin_refined';
// Only the browser preference reads are stubbed; geometry and movement are real.
Object.defineProperty(globalThis, 'location', { value: { search: '' }, configurable: true });
Object.defineProperty(globalThis, 'matchMedia', { value: () => ({ matches: false }), configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null }, configurable: true });
const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
try {
  const { World } = await vite.ssrLoadModule('/src/world.ts') as typeof import('../web/src/world.ts');
  const { Tile } = await vite.ssrLoadModule('/src/tile.ts') as typeof import('../web/src/tile.ts');
  const { TerrainField, NavGrid } = await vite.ssrLoadModule('/src/tiles.ts') as typeof import('../web/src/tiles.ts');
  const { Decks } = await vite.ssrLoadModule('/src/bridges.ts') as typeof import('../web/src/bridges.ts');
  const { Shorelines } = await vite.ssrLoadModule('/src/shorelines.ts') as typeof import('../web/src/shorelines.ts');
  const { Player } = await vite.ssrLoadModule('/src/player.ts') as typeof import('../web/src/player.ts');
  const manifest = JSON.parse(readFileSync(join(dir, 'world.json'), 'utf8'));
  const world = new World(new THREE.Scene());
  world.manifest = manifest;
  world.origin = manifest.origin;
  world.world = manifest.world;
  world.centre = manifest.centre;
  type Deck = ConstructorParameters<typeof Decks>[0]['decks'][number];
  const candidates: Deck[] = [];
  const names = new Set(['Mehringbrücke', 'Hallesche-Tor-Brücke', 'Zossener Brücke', 'Wildenbruchbrücke', 'Oberbaumbrücke', 'Jannowitzbrücke', 'Schillingbrücke']);
  const keys = ['390_5817', '391_5817', '394_5816', '394_5817', '394_5818', '393_5818', '393_5819', '392_5819'];
  const read = (file: string) => { const b = readFileSync(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
  for (const key of keys) {
    const entry = manifest.tiles[key];
    assert.ok(entry, `missing acceptance tile ${key}`);
    const base = join(dir, entry.dir);
    const m = JSON.parse(readFileSync(join(base, 'tile.json'), 'utf8'));
    const tile = new Tile(key, base, m.world, m);
    tile.terrain = new TerrainField(read(join(base, m.terrain.file)));
    tile.nav = new NavGrid(read(join(base, m.nav.file)));
    tile.level = 'full';
    if (m.shorelines) tile.shorelines = new Shorelines(JSON.parse(readFileSync(join(base, m.shorelines.file), 'utf8')));
    if (m.bridges && existsSync(join(base, m.bridges.file))) {
      const data = JSON.parse(readFileSync(join(base, m.bridges.file), 'utf8'));
      tile.decks = new Decks(data);
      for (const deck of data.decks as Deck[]) {
        if (deck.k !== 'rail' && deck.name && names.has(deck.name) && !candidates.some((d) => d.name === deck.name)) candidates.push(deck);
      }
    }
    world.tiles.set(key, tile);
  }
  assert.equal(candidates.length, names.size, 'all named acceptance bridges must be present');
  let passed = 0;
  const failures: string[] = [];
  for (const deck of candidates) {
    const modes = deck.k === 'road' ? ['foot', 'bike', 'scooter', 'car'] as const : ['foot', 'bike', 'scooter'] as const;
    for (const mode of modes) for (const reverse of [false, true]) {
      try {
        const p = reverse ? [...deck.p].reverse() : deck.p;
        const driving = mode === 'car';
        const landing = (a: number[], b: number[]) => {
          const length = Math.hypot(a[0] - b[0], a[1] - b[1]);
          const dx = (a[0] - b[0]) / length, dz = (a[1] - b[1]) / length;
          for (let distance = 2; distance <= 16; distance += 0.5) {
            const x = a[0] + dx * distance, z = a[1] + dz * distance;
            const y = world.height(x, z);
            if (!world.deckAt(x, z, a[2]) && world.nav.passable(x, z, driving) && Math.abs(y - a[2]) < 0.9) return [x, z, y];
          }
          throw new Error('no level ground approach');
        };
        const start = landing(p[0], p[1]), finish = landing(p[p.length - 1], p[p.length - 2]);
        const player = new Player(world);
        player.mode = mode;
        player.pos.set(start[0], start[2], start[1]);
        const probe = player as unknown as { step(x: number, z: number): boolean };
        const route = [start, ...p, finish];
        let maxJump = 0;
        let jumpAt = '';
        for (let i = 0; i + 1 < route.length; i++) {
          const a = route[i], b = route[i + 1];
          const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25));
          for (let j = 1; j <= steps; j++) {
            const x = a[0] + (b[0] - a[0]) * j / steps, z = a[1] + (b[1] - a[1]) * j / steps;
            probe.step(x, z);
            if (process.argv.includes('--debug') && (mode === 'foot' || mode === 'car') && Math.hypot(player.pos.x - x, player.pos.z - z) >= 0.05) {
              console.log('BLOCK', deck.name, mode, { from: player.pos.toArray(), to: [x, z], probes: [[0, 0], [-0.4, 0], [0.4, 0], [0, -0.4], [0, 0.4]].map(([dx, dz]) => {
                const px = x + dx, pz = z + dz;
                return { x: px, z: pz, ground: world.height(px, pz), pass: world.nav.passable(px, pz, driving),
                  canStep: world.canStep(player.pos.x, player.pos.z, px, pz, driving, player.pos.y),
                  decks: world.tileAt(px, pz)?.decks?.at(px, pz, driving ? 1 : 0.3) };
              }) });
            }
            assert.ok(Math.hypot(player.pos.x - x, player.pos.z - z) < 0.05, `blocked at ${x.toFixed(2)}, ${z.toFixed(2)}`);
            const y = world.height(x, z, player.pos.y);
            if (Math.abs(y - player.pos.y) > maxJump) jumpAt = `${x.toFixed(2)}, ${z.toFixed(2)} (${player.pos.y.toFixed(3)} to ${y.toFixed(3)})`;
            maxJump = Math.max(maxJump, Math.abs(y - player.pos.y));
            player.pos.y = y;
          }
        }
        assert.ok(maxJump < 0.35, `surface jumps ${maxJump.toFixed(2)} m at ${jumpAt}`);
        passed++;
        console.log(`PASS ${deck.name} ${mode} ${reverse ? 'return' : 'outward'}; largest step ${(maxJump * 100).toFixed(1)} cm`);
      } catch (error) {
        failures.push(`${deck.name} ${mode} ${reverse ? 'return' : 'outward'}: ${(error as Error).message}`);
      }
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
  console.log(`${passed} real-player crossings passed across ${candidates.length} bridges.`);
} finally {
  await vite.close();
}
