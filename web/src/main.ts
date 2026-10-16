import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { World } from './world';
import { Player } from './player';
import { HUD } from './hud';
import { Locator } from './locate';
import { PoiLayer } from './pois';
import { LayerPanel } from './layerpanel';
import { skyMaterial } from './materials';
import { makeGame, recordScore, type Game } from './games';
import { Menu, type Choice } from './menu';
import { applyStatic, setLang, t, type Lang } from './i18n';
import { TouchControls, isTouchDevice } from './touch';
import { makeSleigh, poseSleigh } from './sleigh';
import { makeBike, makeHuman, makeScooter, poseCycle, poseDrive,
         poseIdle, poseJump, poseScoot, poseWalk } from './character';


const boot = document.getElementById('boot')!;
const bootMsg = document.getElementById('bootmsg')!;
const bar = document.querySelector<HTMLElement>('#bar div')!;

applyStatic();
for (const b of document.querySelectorAll<HTMLElement>('[data-lang]')) {
  b.addEventListener('click', () => setLang(b.dataset.lang as Lang));
}

const say = (m: string, pct?: number) => {
  bootMsg.textContent = m;
  if (pct !== undefined) bar.style.width = `${Math.round(pct * 100)}%`;
};
// A failed load would otherwise leave the boot screen on its last message
// forever, which looks like a hang rather than an error.
const fail = (err: unknown) => say(t('boot.failed', { e: err instanceof Error ? err.message : String(err) }));
window.addEventListener('error', (e) => fail(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

/* --- renderer ------------------------------------------------------------ */

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// Everything in the city is a standard PBR material now, so three does the
// tone mapping and colour conversion; only the sky still does its own.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.25, 6000);

const FOG_DAY = new THREE.Color(0x9fb2c6);
const FOG_NIGHT = new THREE.Color(0x0d1119);
const fog = new THREE.Fog(FOG_DAY.getHex(), 260, 1100);
const background = FOG_DAY.clone();
scene.fog = fog;
scene.background = background;

const sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 24, 16), skyMaterial());
sky.frustumCulled = false;
scene.add(sky);

const sunDir = new THREE.Vector3(0.42, 0.72, 0.46).normalize();

// A neutral studio environment for reflections and fill. Without one, every
// metallic or glossy surface OSM2World's materials declare - window glass
// above all - renders as flat black.
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}

// The sun. Its shadow camera is a box that follows the player around, since
// one map over the whole square kilometre would be far too coarse to see.
const SHADOW_SPAN = 140;
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = sun.shadow.camera.bottom = -SHADOW_SPAN;
sun.shadow.camera.right = sun.shadow.camera.top = SHADOW_SPAN;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 900;
sun.shadow.camera.updateProjectionMatrix();     // otherwise it stays at three's +-5 m default
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.04;                  // world metres, not texels
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xcfdcf0, 0x4a4840, 0.8);
scene.add(hemi);
// how much of the fill comes from the hemisphere light; the sky HDRI, once
// loaded, takes most of it over
let hemiDay = 0.8;
let envDay = 0.7;

/* --- world --------------------------------------------------------------- */

say(t('boot.manifest'), 0.1);
const world = new World(scene);
await world.init((m) => say(m, 0.5), renderer);

// Image-based lighting from a real (overcast) sky instead of the studio room.
if (world.manifest.environment) {
  say(t('boot.sky'), 0.55);
  try {
    const hdr = await new RGBELoader().loadAsync(world.envUrl(world.manifest.environment.file));
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(hdr).texture;
    pmrem.dispose();
    hdr.dispose();
    envDay = 0.6;
    hemiDay = 0.35;
  } catch (err) {
    console.warn('sky lighting unavailable, keeping the studio environment', err);
  }
}

const player = new Player(world);
const hud = new HUD(world);
const locator = new Locator(world, player, hud);
const pois = new PoiLayer(scene, world);
hud.pois = pois;
world.onFull = (tile) => { if (tile.poiFile) void pois.add(tile.key, tile.poiFile); };
world.onDropFull = (tile) => pois.remove(tile.key);
const layerPanel = await new LayerPanel(pois, world, hud).load();

// Spawn on the pavement picked by the navigation pipeline, not the geometric
// centre - the middle of the area is just as likely to be an enclosed
// courtyard you cannot walk out of.
const sx = world.spawnPoint.x;
const sz = world.spawnPoint.z;
player.pos.set(sx, 0, sz);
player.yaw = Math.PI * 0.25;

if (!await locator.applyHash((m) => say(m, 0.7))) {
  await world.ensure(sx, sz, (m) => say(m, 0.7));
  player.spawn(sx, sz);
  // a pinned spawn can also carry the direction to look in
  if (world.spawnPoint.heading !== undefined) {
    player.yaw = world.spawnPoint.heading;
    player.heading = world.spawnPoint.heading;
  }
}
// shadows are the most expensive thing in the frame; phones start without
const touchDevice = isTouchDevice();
if (touchDevice) {
  // a phone has no room for the full credits; the licences still show
  document.getElementById('credits')!.dataset.i18n = 'credits.short';
  applyStatic();
}
let shadowsWanted = !touchDevice;
function applyShadows(): void {
  sun.castShadow = shadowsWanted;
}
applyShadows();

say(t('boot.ready'), 1);

/* --- input --------------------------------------------------------------- */

// declared before the listeners below: they can fire while the world is
// still streaming behind the top-level await
let night = 0;
const keys = new Set<string>();
let pointerLocked = false;

/* --- game modes ---------------------------------------------------------- */

let game: Game | null = null;
let gameSeed: number | null = null;
let starting = false;

const menu = new Menu((c) => void choose(c));

async function choose(c: Choice): Promise<void> {
  keys.clear();
  lockPointer();
  if (c.id === 'free') {
    hud.hint(t('hint.free'), 3.2);
    return;
  }
  if (starting) return;
  starting = true;
  const seed = 'seed' in c ? c.seed : null;
  try {
    const g = makeGame(c.id, { scene, world, player, hud, camera, setNight: (n) => { night = n; } });
    hud.hint(t('hint.setup'), 8);
    await g.load();
    let ranked = seed;
    if (seed !== null) {
      const at = g.choose(seed);
      if (at) {
        player.setMode('foot');
        await world.ensure(at[0], at[1]);
        player.spawn(at[0], at[1]);
      } else {
        // the committed single area is too small for a fair start
        ranked = null;
        hud.hint(t('hint.noFair'), 5);
      }
    }
    g.prepare();
    document.body.classList.add('gaming');
    pois.quiet = true;
    game = g;
    gameSeed = ranked;
    g.start();
    if (ranked !== null) hud.hint('', 0.01);
  } catch (err) {
    hud.hint(t('hint.cantStart', { e: (err as Error).message }), 6);
  } finally {
    starting = false;
  }
}

function endGame(abandoned: boolean): void {
  if (!game) return;
  const g = game;
  game = null;
  g.stop();
  document.body.classList.remove('gaming');
  pois.quiet = false;
  keys.clear();
  if (abandoned || !g.result) {
    menu.showAbandoned();
    return;
  }
  const best = gameSeed !== null && recordScore(g.info.id, gameSeed, g.result.score);
  menu.showResult(g.info.id, gameSeed, g.result, best);
}

const goInput = document.getElementById('goInput') as HTMLInputElement;
const typing = () => document.activeElement === goInput;

addEventListener('keydown', (e) => {
  if (typing()) {
    // let the search box have the keyboard to itself
    if (e.code === 'Escape') { goInput.blur(); }
    return;
  }
  // the search and the layers panel are hidden during a game
  if (game && (e.code === 'Slash' || e.code === 'KeyL')) return;
  if (e.code === 'Slash') {
    e.preventDefault();
    goInput.focus();
    goInput.select();
    return;
  }
  if (e.code === 'Space') e.preventDefault();
  if (keys.has(e.code)) return;
  if (e.code === 'KeyP') {
    if (game) endGame(true);
    else if (menu.open) menu.hide();
    else menu.show();
    return;
  }
  if (menu.open) return;
  keys.add(e.code);
  switch (e.code) {
    // Modes sit on the number row so R and F are free for looking up and down.
    // F used to be the car, which collided with the new pitch control.
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': {
      const wanted = (['foot', 'bike', 'scooter', 'car'] as const)[Number(e.code.slice(5)) - 1];
      if (player.sleigh) break;
      if (game && !game.allows(wanted)) {
        hud.hint(t('hint.notIn', { game: t(`mode.${game.info.id}.title`) }));
        break;
      }
      const m = player.setMode(wanted);
      hud.hint(t(`hint.${m}`));
      break;
    }
    case 'KeyC':
      player.camMode = (player.camMode + 1) % 3;
      hud.hint(t(`hint.cam${player.camMode}`));
      break;
    case 'KeyN':
      night = night > 0.5 ? 0 : 1;
      hud.hint(t(night ? 'hint.night' : 'hint.day'));
      break;
    case 'KeyH': {
      if (!player.canFly) {
        hud.hint(t(player.sleigh ? 'hint.sleighFlies' : 'hint.noFlying'));
        break;
      }
      const flying = player.toggleFly();
      hud.hint(t(flying ? 'hint.flyOn' : 'hint.flyOff'));
      break;
    }
    // Places and street names share one key; the per-category toggles were more
    // keyboard than the feature was worth.
    case 'KeyT': {
      const on = !(pois.showPois && pois.showStreets);
      pois.showPois = on;
      pois.showStreets = on;
      hud.hint(t(on ? 'hint.labelsOn' : 'hint.labelsOff'));
      break;
    }
    case 'KeyM':
      hud.cycleZoom();
      break;
    case 'KeyL':
      hud.hint(t(layerPanel.toggle() ? 'hint.layersOn' : 'hint.layersOff'));
      break;
    case 'KeyX':
      if (game) { hud.hint(t('hint.pEnds')); break; }
      void world.ensure(sx, sz).then(() => {
        player.setMode('foot');
        player.spawn(sx, sz);
        if (world.spawnPoint.heading !== undefined) {
          player.yaw = world.spawnPoint.heading;
          player.heading = world.spawnPoint.heading;
        }
        hud.hint(t('hint.respawn'));
      });
      break;
    case 'KeyG': {
      // shadows are the single most expensive thing in the frame
      shadowsWanted = !shadowsWanted;
      applyShadows();
      hud.hint(t(shadowsWanted ? 'hint.shadowsOn' : 'hint.shadowsOff'));
      break;
    }
    default:
      break;
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

/** Capture the mouse; refused in some contexts (headless, iframes), which is fine. */
function lockPointer(): void {
  try {
    void (renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {});
  } catch { /* keyboard still works */ }
}
renderer.domElement.addEventListener('click', () => {
  if (!pointerLocked) lockPointer();
});

goInput.addEventListener('keydown', async (e) => {
  e.stopPropagation();
  if (e.key !== 'Enter') return;
  const q = goInput.value.trim();
  if (!q) return;
  hud.hint(t('search.looking', { q }), 6);
  const msg = await locator.goTo(q);
  hud.hint(msg, 4.5);
  goInput.blur();
  keys.clear();
});

document.getElementById('goShare')!.addEventListener('click', async () => {
  const url = locator.shareUrl();
  try {
    await navigator.clipboard.writeText(url);
    hud.hint(t('hint.linkCopied'), 2.6);
  } catch {
    hud.hint(url, 6);
  }
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});
/** Turn the view by pixel deltas: the mouse, or a finger dragging. */
function look(dx: number, dy: number): void {
  player.yaw -= dx * 0.0022;
  if (!player.inCar || player.camMode === 2) {
    player.pitch -= dy * 0.0019;
  } else {
    player.pitch -= dy * 0.0009;
  }
  player.pitch = Math.max(-1.3, Math.min(1.15, player.pitch));
}
addEventListener('mousemove', (e) => {
  if (pointerLocked) look(e.movementX, e.movementY);
});

const MOVES = ['foot', 'bike', 'scooter', 'car'] as const;
const touch = touchDevice ? new TouchControls(look, [
  { label: '⏸', code: 'KeyP' },
  { label: '🎥', code: 'KeyC' },
  // the next way of getting around this game allows
  { label: '🚲', code: () => {
    const allowed = MOVES.filter((m) => !game || game.allows(m));
    const next = allowed[(allowed.indexOf(player.mode as typeof MOVES[number]) + 1) % allowed.length];
    return `Digit${MOVES.indexOf(next) + 1}`;
  } },
  { label: '⤒', code: 'Space' },
]) : null;
let touchShown = true;

/**
 * Keep the drawing buffer matched to the window.
 *
 * A plain resize listener is not enough: if the page loads while the tab or
 * container has no layout yet, innerWidth/innerHeight are 0, the canvas is
 * sized 0x0, and no resize event ever follows - the game then renders nothing,
 * forever, at a perfectly healthy frame rate. So the size is also reconciled
 * from the render loop, which costs a comparison per frame and cannot get
 * stuck.
 */
let viewW = 0;
let viewH = 0;
function fitToWindow(): void {
  const w = Math.max(1, innerWidth);
  const h = Math.max(1, innerHeight);
  if (w === viewW && h === viewH) return;
  viewW = w;
  viewH = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
}
addEventListener('resize', fitToWindow);
fitToWindow();

menu.ready();
void boot;

/* --- avatar and car ------------------------------------------------------ */

// The character and rideables are built from primitives and posed by joint
// rotation, so nothing has to be downloaded and they stay readable at
// third-person distance. See character.ts.
const avatar = makeHuman();
scene.add(avatar);

const bike = makeBike();
const scooter = makeScooter();
bike.visible = scooter.visible = false;
scene.add(bike, scooter);

// lit by the same sun and sky as the city, and casting a shadow into it
for (const o of [avatar, bike, scooter]) {
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) c.castShadow = true; });
}

const car = new THREE.Group();
{
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.85, 0.72, 4.3),
    new THREE.MeshStandardMaterial({ color: 0xd8503c, roughness: 0.35, metalness: 0.3 }),
  );
  body.position.y = 0.62;
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(1.66, 0.62, 2.1),
    new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.15, metalness: 0.6 }),
  );
  roof.position.set(0, 1.26, -0.18);
  car.add(body, roof);
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 10);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.9 });
  for (const [wx, wz] of [[-0.92, 1.42], [0.92, 1.42], [-0.92, -1.42], [0.92, -1.42]]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.36, wz);
    car.add(wheel);
  }
}
car.traverse((c) => { if ((c as THREE.Mesh).isMesh) c.castShadow = true; });
scene.add(car);

const sleigh = makeSleigh();
sleigh.visible = false;
sleigh.rotation.order = 'YXZ';
scene.add(sleigh);

/* --- frame loop ---------------------------------------------------------- */

let nightMix = 0;
let last = performance.now();
let fps = 60;
let acc = 0;
let hashTimer = 1.0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  fps += ((1 / Math.max(dt, 1e-4)) - fps) * 0.08;
  acc += dt;

  world.update(player.pos.x, player.pos.z);
  const wasFlying = player.flying;
  // the menu pauses play, and nobody moves before the countdown says go
  if (!menu.open && game?.state !== 'countdown') player.update(dt, keys);
  if (touch && touchShown === menu.open) {
    touchShown = !menu.open;
    touch.visible = touchShown;
  }
  if (game && !menu.open) {
    game.update(dt);
    if (game.state === 'over') endGame(false);
  }
  if (player.flying !== wasFlying && !player.sleigh) {
    hud.hint(t(player.flying ? 'hint.airborne' : 'hint.landed'));
  }
  pois.update(player.pos.x, player.pos.z);
  const head = player.applyCamera(camera);

  // --- character, vehicle and pose -------------------------------------
  const firstPerson = player.camMode === 2;
  const show = !player.flying && !firstPerson && !player.sleigh;
  avatar.visible = show;
  bike.visible = show && player.mode === 'bike';
  scooter.visible = show && player.mode === 'scooter';
  car.visible = !player.flying && !player.sleigh && player.mode === 'car';
  sleigh.visible = player.sleigh;
  if (player.sleigh) {
    sleigh.position.copy(player.pos);
    sleigh.rotation.set(-player.pitch * 0.6, player.yaw + Math.PI, player.lean);
    poseSleigh(sleigh, acc);
  }

  // meshes are modelled facing +Z; travel is along -Z, hence the half turn
  const facing = player.heading + Math.PI;
  const px = player.pos.x, py = player.pos.y, pz = player.pos.z;
  for (const o of [avatar, bike, scooter, car]) {
    o.position.set(px, py, pz);
    o.rotation.set(0, facing, 0);
  }

  if (show) {
    const phase = player.stridePhase;
    if (player.mode === 'car') {
      poseDrive(avatar);
      avatar.position.y = py + 0.12;
      avatar.position.x = px - Math.cos(facing) * 0.34;
      avatar.position.z = pz + Math.sin(facing) * 0.34;
    } else if (player.mode === 'bike') {
      poseCycle(avatar, phase);
      bike.rotation.z = player.lean;
      avatar.rotation.z = player.lean;
      for (const wl of bike.userData.wheels) wl.rotation.x = phase * 0.9;
    } else if (player.mode === 'scooter') {
      poseScoot(avatar, acc);
      scooter.rotation.z = player.lean * 0.6;
      avatar.rotation.z = player.lean * 0.6;
      for (const wl of scooter.userData.wheels) wl.rotation.x = phase * 2.2;
    } else if (!player.onGround) {
      poseJump(avatar, player.vel.y > 0);
    } else if (player.speedKmh > 0.6) {
      poseWalk(avatar, phase, player.speedKmh / 3.6);
    } else {
      poseIdle(avatar, acc);
    }
  }

  nightMix += (night - nightMix) * Math.min(1, dt * 2.5);
  const fogColor = FOG_DAY.clone().lerp(FOG_NIGHT, nightMix);
  // Haze is tuned for standing in a street canyon; from the air it just erases
  // the city. Push it out with height above the ground so a flyover stays
  // crisp while street level keeps its depth.
  const agl = Math.max(0, player.pos.y - world.height(player.pos.x, player.pos.z));
  const lift = 1 + Math.min(agl, 900) / 90;
  // ... but never past the edge of what has been loaded
  const far = Math.min((player.inCar ? 1300 : 1100) * lift, world.viewLimit);
  const near = Math.min(260 * lift, far * 0.5);
  fog.color.copy(fogColor);
  fog.near = near;
  fog.far = far;
  background.copy(fogColor);
  sky.position.copy(camera.position);
  sky.material.uniforms.night.value = nightMix;
  sky.material.uniforms.sunDir.value.copy(sunDir);

  world.setEnv({ night: nightMix, time: acc });

  // sun and sky light fade together; the shadow box re-centres on the
  // player in whole texels, so shadow edges do not shimmer as you move
  sun.intensity = 2.6 * (1 - nightMix) + 0.08;
  sun.color.setHex(0xfff1dc).lerp(new THREE.Color(0x8aa0d0), nightMix);
  hemi.intensity = hemiDay * (1 - nightMix) + 0.12;
  scene.environmentIntensity = envDay * (1 - nightMix) + 0.1 * nightMix;
  renderer.toneMappingExposure = 1.0 - nightMix * 0.25;
  const texel = (2 * SHADOW_SPAN) / sun.shadow.mapSize.x;
  const fx = Math.round(player.pos.x / texel) * texel;
  const fz = Math.round(player.pos.z / texel) * texel;
  const gy = world.height(fx, fz);
  sun.target.position.set(fx, gy, fz);
  sun.position.set(fx + sunDir.x * 400, gy + sunDir.y * 400, fz + sunDir.z * 400);

  fitToWindow();
  renderer.render(scene, camera);
  hud.draw(player, dt, fps, renderer.info.render);
  hashTimer -= dt;
  if (hashTimer <= 0) { hashTimer = 1.0; locator.syncHash(); }
  void head;
}
requestAnimationFrame(frame);

// expose for quick console poking during development
(window as unknown as { __berlin: object }).__berlin =
  { world, player, camera, renderer, scene, hud, locator, pois, menu, game: () => game };
