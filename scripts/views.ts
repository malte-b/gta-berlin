/*
 * Visual check: renders the game from a fixed list of viewpoints - the
 * places that broke before - into PNGs and an index.html to look through.
 * Run it for every change to the world pipeline or the renderer, before
 * anyone else has to find what broke.
 *
 *   npm run dev                                   # in another terminal
 *   node scripts/views.ts --out /tmp/views        # http://localhost:5173/
 *   node scripts/views.ts --url http://localhost:5174/ --out /tmp/views-new
 *   node scripts/views.ts --only jannowitz,mall
 *   node scripts/views.ts --at 5300,1000 --at 3004,-260   # any spot, from above
 *   node scripts/views.ts --close --at 5300,1000              # ... from 15 m away
 *
 * Views missing from a build (tiles not there) come out empty.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface View {
  name: string;
  /** What to look for. */
  note: string;
  x: number; z: number;
  /** Metres above the highest surface (deck, roof... no: ground or deck) there. */
  above: number;
  tx: number; tz: number;
  pitch: number;
}

const VIEWS: View[] = [
  { name: 'spawn', note: 'Kreuzberg spawn at street level: no water on the square', x: 918, z: 3320, above: 2, tx: 1000, tz: 3200, pitch: -0.05 },
  { name: 'park', note: 'Görlitzer Park: lawn, paths, no water', x: 4428, z: 2140, above: 3, tx: 4428, tz: 2060, pitch: -0.1 },
  { name: 'schilling-deck', note: 'Schillingbrücke: one deck, no water on it', x: 3870, z: 712, above: 12, tx: 3920, tz: 620, pitch: -0.45 },
  { name: 'spree-low', note: 'Spree from 8 m up, along the river: one flat level, no lines across the water', x: 2560, z: 60, above: 8, tx: 2900, tz: 160, pitch: -0.12 },
  { name: 'schilling-water', note: 'Schillingbrücke from the river: flat water, deck over it', x: 3830, z: 640, above: 2.5, tx: 3900, tz: 662, pitch: 0.05 },
  { name: 'jannowitz', note: 'Jannowitzbrücke: deck full width, no water on it', x: 3131, z: 130, above: 12, tx: 3131, tz: 50, pitch: -0.45 },
  { name: 'jannowitz-air', note: 'Jannowitzbrücke from above: no building over the river', x: 3244, z: 150, above: 60, tx: 3150, tz: 60, pitch: -0.75 },
  { name: 'michael', note: 'Michaelbrücke: no step, lamps on the deck', x: 3470, z: 345, above: 12, tx: 3505, tz: 265, pitch: -0.45 },
  { name: 'oberbaum', note: 'Oberbaumbrücke: arched road deck under the U-Bahn', x: 5030, z: 1440, above: 12, tx: 4950, tz: 1570, pitch: -0.45 },
  { name: 'weidendamm', note: 'Weidendammer Brücke (Friedrichstraße over the Spree): full deck, no water on it', x: 1180, z: -900, above: 30, tx: 1128, tz: -835, pitch: -0.5 },
  { name: 'oberbaum-air', note: 'Oberbaumbrücke from above: road deck and U-Bahn on top', x: 5080, z: 1560, above: 45, tx: 4995, tz: 1515, pitch: -0.6 },
  { name: 'stadtbahn', note: 'Stadtbahn over the Spree at Friedrichstraße', x: 997, z: -719, above: 25, tx: 1000, tz: -650, pitch: -0.3 },
  { name: 'mall', note: 'Mall of Berlin: roofs and arcade as before', x: 607, z: 560, above: 55, tx: 607, tz: 437, pitch: -0.45 },
  { name: 'tempelhof', note: 'Tempelhofer Damm under the Ringbahn and A100', x: 843, z: 4840, above: 3, tx: 843, tz: 4990, pitch: 0.06 },
  { name: 'schoeneberg-rail', note: 'Ringbahn bridge over a street in Schöneberg: no smeared tracks', x: -870, z: 3790, above: 15, tx: -865, tz: 3900, pitch: -0.35 },
];

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const url = opt('--url', 'http://localhost:5173/');
const out = opt('--out', join(tmpdir(), 'gta-berlin-views'));
const only = opt('--only', '');
const close = args.includes('--close');
// --at x,z: a look down at that spot from 40 m south, e.g. from scripts/check.ts
const at: View[] = args.flatMap((a, i) => (args[i - 1] === '--at' ? [a] : [])).map((a) => {
  const [x, z] = a.split(',').map(Number);
  return close
    ? { name: `at_${Math.round(x)}_${Math.round(z)}`, note: `x ${x}, z ${z}`, x, z: z + 14, above: 9, tx: x, tz: z, pitch: -0.55 }
    : { name: `at_${Math.round(x)}_${Math.round(z)}`, note: `x ${x}, z ${z}`, x, z: z + 40, above: 35, tx: x, tz: z, pitch: -0.75 };
});
const views = at.length ? at : only ? VIEWS.filter((v) => only.split(',').includes(v.name)) : VIEWS;
mkdirSync(out, { recursive: true });

const PORT = 9336;
const chrome = spawn(process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--user-data-dir=${join(tmpdir(), 'gta-berlin-views-profile')}`,
  `--remote-debugging-port=${PORT}`, '--window-size=1280,720', '--use-angle=metal', 'about:blank'],
  { stdio: 'ignore' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Target { type: string; webSocketDebuggerUrl: string }
interface Reply { id?: number; result?: { result?: { value?: unknown }; data?: string } }
let targets: Target[] | undefined;
for (let i = 0; i < 50 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(200); }
}
const ws = new WebSocket(targets!.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map<number, (m: Reply) => void>();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data)) as Reply;
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
});
const send = (method: string, params: object = {}) => new Promise<Reply>((r) => {
  const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async <T = unknown>(expression: string): Promise<T> =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value as T;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });
for (let i = 0; i < 300; i++) {
  if (await ev("!!(window.__berlin && document.getElementById('boot')?.classList.contains('ready'))")) break;
  await sleep(200);
}
await ev("(() => { document.querySelector('#modes .mode.free').click(); window.__berlin.player.land = () => {}; return 1; })()");

const done: { v: View; file: string }[] = [];
for (const v of views) {
  // fly there first, so the tiles around load, then take the exact spot
  await ev(`(() => { const p = window.__berlin.player; p.flying = true; p.launched = false;
    p.pos.set(${v.x}, 80, ${v.z}); return 1; })()`);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await ev(`(() => { const t = window.__berlin.world.tileAt(${v.x}, ${v.z}); return !!t && t.level === 'full'; })()`)) break;
  }
  await sleep(1500);
  await ev(`(() => { const b = window.__berlin, p = b.player, w = b.world;
    const y = w.height(${v.x}, ${v.z}, 1000) + ${v.above};
    p.flying = true; p.pos.set(${v.x}, y, ${v.z});
    p.yaw = Math.atan2(-(${v.tx} - ${v.x}), -(${v.tz} - ${v.z})); p.pitch = ${v.pitch}; return 1; })()`);
  await sleep(2500);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = `${v.name}.png`;
  writeFileSync(join(out, file), Buffer.from(shot.result!.data!, 'base64'));
  done.push({ v, file });
  console.log(`${v.name}: ${file}`);
}

const html = `<!doctype html><meta charset="utf-8"><title>Views</title>
<style>body{font:14px system-ui;background:#16181d;color:#ddd;margin:16px}
figure{margin:0 0 24px}img{max-width:100%;border-radius:6px}figcaption{margin:6px 0}</style>
<h1>Views - ${new Date().toISOString()} - ${url}</h1>
${done.map(({ v, file }) => `<figure><figcaption><b>${v.name}</b> - ${v.note}</figcaption><img src="${file}"></figure>`).join('\n')}`;
writeFileSync(join(out, 'index.html'), html);
console.log(`-> ${join(out, 'index.html')}`);
ws.close();
chrome.kill();
