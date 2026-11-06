// deck coverage by the game's Decks.at: C car fits (1 m in), w walker (0.3 m in), e edge only, . walkable ground, ~ closed
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { Decks } = await vite.ssrLoadModule('/src/bridges.ts') as any;
const { NavGrid } = await vite.ssrLoadModule('/src/tiles.ts') as any;
const [build, tile, cx, cz, rad, step] = process.argv.slice(2);
const dir = `data/${build}/tiles/${tile}/`;
const b = readFileSync(dir + 'nav.bin');
const nav = new NavGrid(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const d = new Decks(JSON.parse(readFileSync(dir + 'bridges.json', 'utf8')));
const R = +rad, S = +(step ?? 1);
for (let z = +cz - R; z <= +cz + R; z += S) {
  let row = '';
  for (let x = +cx - R; x <= +cx + R; x += S) {
    const c = d.at(x, z, 1.0).filter((h: any) => h.kind !== 'rail' && h.kind !== 'path').length, w = d.at(x, z, 0.3).filter((h: any) => h.kind !== 'rail').length, e = d.at(x, z, 0).filter((h: any) => h.kind !== 'rail').length;
    row += c ? 'C' : w ? 'w' : e ? 'e' : nav.passable(x, z, true) ? '3' : nav.passable(x, z, false) ? '.' : '~';
  }
  console.log(z.toFixed(1).padStart(7), row);
}
await vite.close();
