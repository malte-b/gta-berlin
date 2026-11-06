/*
 * Game-mode benchmark: plays each game in headless Chrome as a phone and
 * measures what it costs while it runs.
 *
 *   npm run dev                                   # in another terminal
 *   npm run bench:games                           # 390x844 @3x, touch, CPU 4x slower
 *   npm run bench:games -- --landscape            # 844x390
 *   npm run bench:games -- --desktop              # 1280x720, mouse and keyboard
 *   npm run bench:games -- --only doener,heat --seconds 30
 *   npm run bench:games -- --shots out/           # a screenshot of each game
 *
 * An autopilot holds "forward + sprint" through the same key events the
 * touch joystick sends and steers at the compass target, so the game's own
 * movement, streaming, collision and rules all run; when it is stuck against
 * a wall it hops 25 m on. Each game is played on a fixed course, so runs
 * compare. Besides frame times it reads Chrome's own counters for script,
 * style and layout time - the HUD is DOM, and a phone pays for every
 * relayout. The GPU is the machine's own; see docs/performance.md.
 *
 * Plain Node runs it (TypeScript is stripped, Node 23.6+). Do not run it
 * while a world build is going: the build competes for the CPU.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const desktop = args.includes('--desktop');
const landscape = args.includes('--landscape');
const url = opt('--url', 'http://localhost:5173/?lang=de');
const seconds = Number(opt('--seconds', '40'));
const only = opt('--only', 'markets,heat,giessen,toilets,doener').split(',');
const shots = opt('--shots', '');
const profileName = desktop ? 'desktop' : landscape ? 'phone-landscape' : 'phone';
const out = opt('--out', `games-${profileName}.json`);
const chromePath = process.env.CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9335;
/** One course per mode, the same every run. */
const SEED = 20261029;

const chrome = spawn(chromePath, [
  '--headless=new', `--user-data-dir=${join(tmpdir(), 'gta-berlin-games-bench')}`,
  `--remote-debugging-port=${PORT}`, '--window-size=1280,720', '--use-angle=metal',
  '--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-precise-memory-info',
  '--autoplay-policy=no-user-gesture-required', '--js-flags=--expose-gc', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Target { type: string; webSocketDebuggerUrl: string }
interface Reply { id?: number; method?: string; params?: { encodedDataLength: number };
                  result?: { result?: { value?: unknown }; metrics?: { name: string; value: number }[];
                             data?: string } }
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
const ev = async <T = unknown>(expression: string): Promise<T> =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value as T;
const metrics = async (): Promise<Record<string, number>> =>
  Object.fromEntries((await send('Performance.getMetrics')).result!.metrics!.map((m) => [m.name, m.value]));

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Performance.enable', { timeDomain: 'threadTicks' });
if (!desktop) {
  const [width, height] = landscape ? [844, 390] : [390, 844];
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true });
  // a finger: (pointer: coarse) matches, so the game shows its touch controls
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setCPUThrottlingRate', { rate: 4 });
}

await send('Page.navigate', { url });
for (let i = 0; i < 400; i++) {
  if (await ev("!!(window.__berlin && document.getElementById('boot')?.classList.contains('ready'))")) break;
  await sleep(200);
}
const touchUi = await ev<boolean>("document.body.classList.contains('touch')");

// time every render, and the game's own update
await ev(`(() => {
  const b = window.__berlin, r = b.renderer;
  window.__frames = [];
  window.__gameMs = 0;
  const render = r.render.bind(r);
  r.render = (s, c) => { render(s, c); window.__frames.push([performance.now(), r.info.render.calls, r.info.render.triangles]); };
  return 1;
})()`);

// The autopilot: forward and sprint held, steered at the compass target.
await ev(`(() => {
  const key = (type, code) => dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
  let last = null, stuckFor = 0;
  window.__pilot = { on: false, hops: 0 };
  const tick = () => {
    requestAnimationFrame(tick);
    const b = window.__berlin, g = b.game(), p = b.player;
    if (!window.__pilot.on || !g || g.state !== 'play') return;
    const s = g.next();
    if (!s) return;
    const dx = s.x - p.pos.x, dz = s.z - p.pos.z, d = Math.hypot(dx, dz);
    const yaw = Math.atan2(-dx, -dz);
    if (p.sleigh) {
      p.yaw = yaw;
      const agl = p.pos.y - b.world.height(p.pos.x, p.pos.z);
      p.pitch = Math.max(-0.5, Math.min(0.5, (Math.min(120, d * 0.3) - agl) * 0.01));
    } else if (p.vehicle) {
      p.heading = yaw;
    } else {
      p.yaw = yaw;
    }
    // stand still on a target that takes time (a pump, a tree)
    const there = d < 3;
    for (const code of ['KeyW', 'ShiftLeft']) key(there ? 'keyup' : 'keydown', code);
    const now = performance.now();
    if (!last || now - last.t > 2000) {
      if (last && !there && Math.hypot(p.pos.x - last.x, p.pos.z - last.z) < 2) {
        // walled in by a building between here and there: hop on
        const k = Math.min(25, d - 2) / d;
        p.pos.x += dx * k; p.pos.z += dz * k;
        window.__pilot.hops++;
      }
      last = { t: now, x: p.pos.x, z: p.pos.z };
    }
  };
  requestAnimationFrame(tick);
  return 1;
})()`);

// What the page holds on the graphics side, by walking the scene: texture
// and geometry bytes (as scripts/bench.ts counts them), and the JS heap.
// iOS reloads a tab that grows past roughly 1-1.5 GB in all, so this is the
// number that decides whether a game can be finished on an iPhone.
const memory = `(() => {
  const b = window.__berlin, textures = new Set(), geometries = new Set();
  let tex = 0, geo = 0;
  const addTex = (v) => {
    if (!v || !v.isTexture || textures.has(v)) return;
    textures.add(v);
    const im = v.image, w = v.userData?.size?.[0] || im?.width || 0, h = v.userData?.size?.[1] || im?.height || 0;
    tex += w * h * (v.isCompressedTexture || v.format === 1028 ? 1 : 4) * (v.generateMipmaps === false && !v.mipmaps?.length ? 1 : 1.33);
  };
  b.scene.traverse((o) => {
    if (o.geometry && !geometries.has(o.geometry)) {
      geometries.add(o.geometry);
      for (const a of Object.values(o.geometry.attributes)) geo += a.array?.byteLength ?? a.count * a.itemSize * 4;
      if (o.geometry.index) geo += o.geometry.index.array?.byteLength ?? o.geometry.index.count * 4;
    }
    for (const m of [].concat(o.material || [])) {
      for (const v of Object.values(m)) addTex(v);
      for (const u of Object.values(m.userData?.uniforms ?? {})) addTex(u?.value);
    }
  });
  const info = b.renderer.info.memory;
  return { textureMB: Math.round(tex / 1048576), geometryMB: Math.round(geo / 1048576),
           heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
           glTextures: info.textures, glGeometries: info.geometries, tiles: b.world.stats };
})()`;
interface Memory { textureMB: number; geometryMB: number; heapMB: number; glTextures: number; glGeometries: number }

interface Run {
  mode: string; frames: number; fps: number; p50ms: number; p95ms: number; worstMs: number;
  framesOver50ms: number; drawCalls: number; trianglesM: number;
  gameMsPerFrame: number; scriptMs: number; styleMs: number; layoutMs: number; layouts: number;
  heapMB: number; downloadedMB: number; reached: number; score: number; hops: number; metres: number;
  /** The highest total seen while playing: textures + geometry + heap. */
  peakMB: number; peak: Memory;
  /** The heap after a forced collection at the end: what is really held,
   *  as against garbage the collector had not got round to. */
  liveHeapMB: number;
}
const runs: Run[] = [];

for (const mode of only) {
  await ev(`(() => { const b = window.__berlin; b.game() && b.game().state !== 'over' && b.game().end?.(false); return 1; })()`);
  // pick from the menu as a player would, on a fixed course
  await ev(`(() => { const m = window.__berlin.menu; m.show(); m.pick({ id: '${mode}', seed: ${SEED} }); return 1; })()`);
  for (let i = 0; i < 300; i++) {
    if (await ev<boolean>("!!window.__berlin.game() && window.__berlin.game().state === 'play'")) break;
    await sleep(200);
  }
  // time the game's own update from here on
  await ev(`(() => {
    const g = window.__berlin.game(), u = g.update.bind(g);
    g.update = (dt) => { const t = performance.now(); u(dt); window.__gameMs += performance.now() - t; };
    window.__gameMs = 0; window.__frames.length = 0; window.__pilot.on = true; window.__pilot.hops = 0;
    window.__startPos = [window.__berlin.player.pos.x, window.__berlin.player.pos.z]; window.__metres = 0;
    window.__lastPos = window.__startPos.slice();
    window.__odo = setInterval(() => {
      const p = window.__berlin.player.pos;
      window.__metres += Math.hypot(p.x - window.__lastPos[0], p.z - window.__lastPos[1]);
      window.__lastPos = [p.x, p.z];
    }, 250);
    return 1;
  })()`);
  const m0 = await metrics();
  const b0 = bytes;
  const start = Date.now();
  let shot = false;
  let peak: Memory | null = null, peakMB = 0, lastMem = 0;
  while (Date.now() - start < seconds * 1000) {
    await sleep(500);
    if (Date.now() - lastMem > 4000) {
      lastMem = Date.now();
      const mm = await ev<Memory>(memory);
      const total = mm.textureMB + mm.geometryMB + mm.heapMB;
      if (total > peakMB) { peakMB = total; peak = mm; }
    }
    if (await ev<boolean>("window.__berlin.game()?.state !== 'play'")) break;
    if (shots && !shot && Date.now() - start > 8000) {
      shot = true;
      const img = (await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 })).result!.data!;
      mkdirSync(shots, { recursive: true });
      writeFileSync(join(shots, `${mode}-${profileName}.jpg`), Buffer.from(img, 'base64'));
    }
  }
  const m1 = await metrics();
  const liveHeapMB = await ev<number>('(() => { window.gc(); return Math.round(performance.memory.usedJSHeapSize / 1048576); })()');
  const f = await ev<[number, number, number][]>('window.__frames.slice()');
  const state = await ev<{ score: number; count: number; gameMs: number; hops: number; heap: number; metres: number }>(`(() => {
    const g = window.__berlin.game(); window.__pilot.on = false; clearInterval(window.__odo);
    for (const code of ['KeyW', 'ShiftLeft']) dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    return { score: g?.score ?? 0, count: g?.count ?? 0, gameMs: window.__gameMs, hops: window.__pilot.hops,
             heap: performance.memory.usedJSHeapSize, metres: window.__metres };
  })()`);
  const dt = f.slice(1).map((x, i) => x[0] - f[i][0]).sort((a, b) => a - b);
  const q = (p: number) => dt[Math.min(dt.length - 1, Math.floor(dt.length * p))] ?? 0;
  const median = (k: number) => f.map((x) => x[k]).sort((a, b) => a - b)[Math.floor(f.length / 2)] ?? 0;
  // thread time, seconds, over the run; per frame in ms
  const per = (k: string) => +(((m1[k] - m0[k]) * 1000) / Math.max(1, f.length)).toFixed(2);
  runs.push({
    mode, frames: f.length,
    fps: Math.round(1000 / (dt.reduce((a, b) => a + b, 0) / Math.max(1, dt.length))),
    p50ms: +q(0.5).toFixed(1), p95ms: +q(0.95).toFixed(1), worstMs: Math.round(dt[dt.length - 1] ?? 0),
    framesOver50ms: dt.filter((d) => d > 50).length,
    drawCalls: median(1), trianglesM: +(median(2) / 1e6).toFixed(2),
    gameMsPerFrame: +(state.gameMs / Math.max(1, f.length)).toFixed(2),
    scriptMs: per('ScriptDuration'), styleMs: per('RecalcStyleDuration'), layoutMs: per('LayoutDuration'),
    layouts: Math.round((m1.LayoutCount - m0.LayoutCount) / Math.max(1, f.length) * 10) / 10,
    heapMB: Math.round(state.heap / 1048576), downloadedMB: +((bytes - b0) / 1048576).toFixed(1),
    reached: state.count, score: state.score, hops: state.hops, metres: Math.round(state.metres),
    peakMB, peak: peak!, liveHeapMB,
  });
  const r = runs[runs.length - 1];
  console.log(`${mode.padEnd(8)} ${String(r.fps).padStart(4)} fps  p95 ${r.p95ms} ms  worst ${r.worstMs} ms  >50ms ${r.framesOver50ms}  ` +
    `calls ${r.drawCalls}  tris ${r.trianglesM}M  game ${r.gameMsPerFrame} ms  ` +
    `script ${r.scriptMs} style ${r.styleMs} layout ${r.layoutMs} ms/frame (${r.layouts} layouts)  ` +
    `dl ${r.downloadedMB} MB  ${r.reached} reached, ${r.metres} m, ${r.hops} hops  ` +
    `PEAK ${r.peakMB} MB (tex ${r.peak.textureMB} geo ${r.peak.geometryMB} heap ${r.peak.heapMB}), live heap ${r.liveHeapMB} MB`);
}

// --snapshot: what the heap holds after the last game, by constructor
if (args.includes('--snapshot')) {
  await ev('(() => { window.gc(); return 1; })()');
  let chunks = '';
  const onChunk = (e: MessageEvent) => {
    const m = JSON.parse(String(e.data));
    if (m.method === 'HeapProfiler.addHeapSnapshotChunk') chunks += m.params.chunk;
  };
  ws.addEventListener('message', onChunk);
  await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  ws.removeEventListener('message', onChunk);
  const snap = JSON.parse(chunks) as { snapshot: { meta: { node_fields: string[]; node_types: string[][] } };
                                        nodes: number[]; strings: string[] };
  const f = snap.snapshot.meta.node_fields, nf = f.length;
  const iType = f.indexOf('type'), iName = f.indexOf('name'), iSize = f.indexOf('self_size');
  const types = snap.snapshot.meta.node_types[iType];
  const by = new Map<string, [number, number]>();
  for (let i = 0; i < snap.nodes.length; i += nf) {
    const type = types[snap.nodes[i + iType]];
    const name = type === 'object' || type === 'native' ? snap.strings[snap.nodes[i + iName]] : `(${type})`;
    const e = by.get(name) ?? [0, 0];
    e[0] += snap.nodes[i + iSize]; e[1]++;
    by.set(name, e);
  }
  const top = [...by].sort((a, b) => b[1][0] - a[1][0]).slice(0, 25);
  for (const [name, [size, n]] of top) console.log(`${(size / 1048576).toFixed(1).padStart(8)} MB ${String(n).padStart(9)}  ${name.slice(0, 70)}`);
}

writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), url, profile: profileName, touchUi, seconds, runs }, null, 1));
console.log(`touch UI ${touchUi ? 'on' : 'off'} -> ${out}`);
ws.close();
chrome.kill();
