/*
 * Performance benchmark: drives the game in headless Chrome and measures
 * frame times, draw calls, triangles, memory and download in three scenes.
 * Results are discussed in docs/performance.md.
 *
 *   npm run dev                                  # in another terminal
 *   npm run bench                                # desktop, http://localhost:5173/
 *   npm run bench -- --phone                     # 390x844 @3x, CPU 4x slower
 *   npm run bench -- --phone --profile           # also writes a .cpuprofile
 *   npm run bench -- --url http://... --out results.json
 *
 * Plain Node runs it (TypeScript is stripped, Node 23.6+). Do not run it
 * while a world build is going: the build competes for the CPU.
 *
 * Frame pacing is uncapped (no vsync), so fps shows headroom rather than the
 * display rate. The GPU is the machine's own; --phone emulates the screen and
 * a slower CPU, not a phone GPU. Anything else running on the machine (a
 * world build, say) skews the numbers.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const phone = args.includes('--phone');
const profile = args.includes('--profile');
const url = opt('--url', 'http://localhost:5173/');
const out = opt('--out', `bench-${phone ? 'phone' : 'desktop'}.json`);
const chromePath = process.env.CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;

const chrome = spawn(chromePath, [
  '--headless=new', `--user-data-dir=${join(tmpdir(), 'gta-berlin-bench')}`,
  `--remote-debugging-port=${PORT}`, '--window-size=1280,720', '--use-angle=metal',
  '--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-precise-memory-info',
  'about:blank'], { stdio: 'ignore' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Target { type: string; webSocketDebuggerUrl: string }
interface Reply { id?: number; method?: string; params?: { encodedDataLength: number };
                  result?: { result?: { value?: unknown }; profile?: unknown } }
let targets: Target[] | undefined;
for (let i = 0; i < 50 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(200); }
}
const ws = new WebSocket(targets!.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map<number, (m: Reply) => void>();
let bytes = 0;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data)) as Reply;
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  if (m.method === 'Network.loadingFinished') bytes += m.params!.encodedDataLength;
});
const send = (method: string, params: object = {}) => new Promise<Reply>((r) => {
  const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
});
// evaluate in the page; the result comes back as JSON
const ev = async <T = unknown>(expression: string): Promise<T> =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value as T;

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
if (phone) {
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setCPUThrottlingRate', { rate: 4 });
}

const t0 = Date.now();
await send('Page.navigate', { url });
for (let i = 0; i < 300; i++) {
  if (await ev("!!(window.__berlin && !document.getElementById('play')?.disabled)")) break;
  await sleep(200);
}
interface Memory { textureMB: number; textureSlotsMB: number; geometryMB: number; heapMB: number; world: unknown }
interface Scene {
  name: string; frames: number; fps: number; p50ms: number; p95ms: number; worstMs: number;
  framesOver50ms: number; drawCalls: number; trianglesM: number; downloadedMB: number;
  seconds: number; memory: Memory;
}
const results: Record<string, unknown> & { street?: Scene; fly?: Scene; air?: Scene } = {
  date: new Date().toISOString(), url, profile: phone ? 'phone' : 'desktop',
  loadSeconds: +((Date.now() - t0) / 1000).toFixed(1), loadMB: +(bytes / 1048576).toFixed(1),
};

// time every render and keep its draw calls and triangles
await ev(`(() => {
  document.getElementById('play').click();
  const b = window.__berlin, r = b.renderer;
  window.__frames = [];
  const render = r.render.bind(r);
  r.render = (s, c) => { render(s, c); window.__frames.push([performance.now(), r.info.render.calls, r.info.render.triangles]); };
  b.player.land = () => {};        // the camera stays where the scenario puts it
  return 1;
})()`);
await sleep(6000);

// what the scene holds: texture and geometry bytes, JS heap
const memory = `(() => {
  const b = window.__berlin, textures = new Set(), geometries = new Set();
  let tex = 0, geo = 0, slots = 0;
  b.scene.traverse((o) => {
    if (o.geometry && !geometries.has(o.geometry)) {
      geometries.add(o.geometry);
      for (const a of Object.values(o.geometry.attributes)) geo += a.array?.byteLength ?? a.count * a.itemSize * 4;
      if (o.geometry.index) geo += o.geometry.index.array?.byteLength ?? o.geometry.index.count * 4;
    }
    for (const m of [].concat(o.material || [])) {
      for (const v of Object.values(m)) {
        if (v && v.isTexture && !textures.has(v)) {
          textures.add(v);
          const im = v.image, w = v.userData?.size?.[0] || im?.width || 0, h = v.userData?.size?.[1] || im?.height || 0;
          // RedFormat (1028): one byte a pixel; compressed: about one
          const bpp = v.isCompressedTexture || v.format === 1028 ? 1 : 4;
          const bytes = w * h * bpp * (v.generateMipmaps === false && !v.mipmaps?.length ? 1 : 1.33);
          tex += bytes;
          slots += bytes;
        }
      }
      for (const u of Object.values(m.userData?.uniforms ?? {})) {
        const v = u?.value;
        if (v && v.isTexture && !textures.has(v)) {
          textures.add(v);
          const im = v.image, w = v.userData?.size?.[0] || im?.width || 0, h = v.userData?.size?.[1] || im?.height || 0;
          tex += w * h * (v.isCompressedTexture || v.format === 1028 ? 1 : 4) * 1.33;
        }
      }
    }
  });
  // textureSlotsMB counts material slots only, the way the first baseline did
  return { textureMB: Math.round(tex / 1048576), textureSlotsMB: Math.round(slots / 1048576),
           geometryMB: Math.round(geo / 1048576),
           heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), world: b.world.stats };
})()`;

async function scenario(name: string, setup: string, seconds: number, step?: string): Promise<Scene> {
  await ev(setup);
  await sleep(4000);
  const b0 = bytes;
  await ev('window.__frames.length = 0');
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) { if (step) await ev(step); await sleep(250); }
  const f = await ev<[number, number, number][]>('window.__frames.slice()');
  const dt = f.slice(1).map((x, i) => x[0] - f[i][0]).sort((a, b) => a - b);
  const q = (p: number) => dt[Math.min(dt.length - 1, Math.floor(dt.length * p))];
  const median = (k: number) => f.map((x) => x[k]).sort((a, b) => a - b)[Math.floor(f.length / 2)];
  return {
    name, frames: f.length,
    fps: Math.round(1000 / (dt.reduce((a, b) => a + b, 0) / dt.length)),
    p50ms: +q(0.5).toFixed(1), p95ms: +q(0.95).toFixed(1), worstMs: Math.round(dt[dt.length - 1]),
    framesOver50ms: dt.filter((d) => d > 50).length,
    drawCalls: median(1), trianglesM: +(median(2) / 1e6).toFixed(2),
    downloadedMB: +((bytes - b0) / 1048576).toFixed(1), seconds,
    memory: await ev<Memory>(memory),
  };
}
const camera = (x: number, y: number, z: number, tx: number, tz: number, pitch: number) => `(() => {
  const p = window.__berlin.player; p.flying = true; p.launched = false; p.pos.set(${x}, ${y}, ${z});
  p.yaw = Math.atan2(-(${tx} - ${x}), -(${tz} - ${z})); p.pitch = ${pitch}; return 1; })()`;

// the default spawn in Kreuzberg, standing
results.street = await scenario('street level, standing',
  '(() => { window.__berlin.player.flying = false; return 1; })()', 15);
// 1.5 km east over Kreuzberg and Mitte at rooftop height, 38 m/s
if (profile) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 }); await send('Profiler.start'); }
results.fly = await scenario('flying 1.5 km at 35 m', camera(-200, 35, 2600, 1300, 2600, -0.15), 40,
  '(() => { window.__berlin.player.pos.x += 38 * 0.25; return 1; })()');
if (profile) {
  const p = await send('Profiler.stop');
  writeFileSync(out.replace(/\.json$/, '') + '.cpuprofile', JSON.stringify(p.result?.profile));
}
// looking out over the city from 300 m: everything in range is loaded
results.air = await scenario('overview from 300 m', camera(500, 300, 3500, 1500, 1500, -0.5), 15);

writeFileSync(out, JSON.stringify(results, null, 1));
for (const k of ['street', 'fly', 'air'] as const) {
  const r = results[k]!, m = r.memory;
  console.log(`${r.name.padEnd(24)} ${String(r.fps).padStart(4)} fps  p95 ${r.p95ms} ms  worst ${r.worstMs} ms  ` +
    `>50ms ${r.framesOver50ms}  calls ${r.drawCalls}  tris ${r.trianglesM}M  ` +
    `dl ${r.downloadedMB} MB  tex ${m.textureMB} MB  geo ${m.geometryMB} MB  heap ${m.heapMB} MB`);
}
console.log(`load ${results.loadSeconds}s, ${results.loadMB} MB -> ${out}`);
ws.close();
chrome.kill();
