import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { Decks } = await vite.ssrLoadModule('/src/bridges.ts') as any;
const { TerrainField } = await vite.ssrLoadModule('/src/tiles.ts') as any;
const [tile, cx, cz, rad] = process.argv.slice(2);
const dir = `data/berlin_v3/tiles/${tile}/`;
const b = readFileSync(dir + 'terrain.bin');
const t = new TerrainField(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const d = new Decks(JSON.parse(readFileSync(dir + 'bridges.json', 'utf8')));
const R = +rad;
console.log('legend: ^ terrain pokes above the deck top, = terrain within 5 cm of it, d deck above terrain, . no deck (terrain only)');
for (let z = +cz - R; z <= +cz + R; z += 1) {
  let row = '';
  for (let x = +cx - R; x <= +cx + R; x += 1) {
    const hits = d.at(x, z, 0).filter((h: any) => h.kind !== 'rail');
    const g = t.height(x, z);
    if (!hits.length) { row += '.'; continue; }
    const top = Math.max(...hits.map((h: any) => h.y));
    row += g > top + 0.05 ? '^' : g > top - 0.05 ? '=' : 'd';
  }
  console.log(z.toFixed(0).padStart(6), row);
}
await vite.close();
