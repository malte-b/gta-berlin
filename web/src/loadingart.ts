import * as THREE from 'three';
import { crownMaterial, trunkMaterial } from './materials';
import { CROWN_GEO, TRUNK_GEO } from './tile';

/**
 * The loading screen's picture: a small 3D scene per game in the game's own
 * look - faceted shapes, the city's tree crown, standard materials under a
 * sun and sky light, ACES. It draws on its own transparent canvas over the
 * themed background, behind the text, with the subject placed over a spacer
 * in the text column so the two line up at any window size.
 *
 * A second WebGL context, but a small and short-lived one: it only draws
 * while the screen is up, and its scene is built afresh each time and freed
 * on hide.
 */

interface Art {
  scene: THREE.Scene;
  /** How tall the subject is, centred on the origin, and how steeply the
   *  camera looks down on it (radians); the camera backs off to fit it. */
  view: [number, number];
  update(t: number, dt: number): void;
}

/* --- shared bits ----------------------------------------------------------- */

function lit(scene: THREE.Scene, warm = 0xfff1dc): void {
  const sun = new THREE.DirectionalLight(warm, 2.6);
  sun.position.set(3, 6, 4);
  scene.add(sun, new THREE.HemisphereLight(0xcfdcf0, 0x4a4840, 1.1));
}

const std = (color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, flatShading: true, ...extra });

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A soft round dot, for flakes and glows. */
const glowTexture = () => canvasTexture(64, 64, (g) => {
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
});

/* --- Weihnachtsmarkt: snow, nothing else ----------------------------------- */

function snow(): Art {
  const scene = new THREE.Scene();
  const N = 1400;
  const pos = new Float32Array(N * 3);
  const speed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos.set([(Math.random() - 0.5) * 30, (Math.random() - 0.5) * 18, -16 + Math.random() * 20], i * 3);
    speed[i] = 0.6 + Math.random() * 0.9;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const flakes = new THREE.Points(geo, new THREE.PointsMaterial({
    map: glowTexture(), size: 0.22, transparent: true, depthWrite: false, opacity: 0.95,
  }));
  scene.add(flakes);
  return {
    scene, view: [0, 0],
    update(t, dt) {
      for (let i = 0; i < N; i++) {
        const k = i * 3;
        pos[k] += Math.sin(t * 0.8 + i) * dt * 0.35;
        pos[k + 1] -= speed[i] * dt;
        if (pos[k + 1] < -9) pos[k + 1] += 18;
      }
      geo.attributes.position.needsUpdate = true;
    },
  };
}

/* --- Hitzewelle: a blistering sun ------------------------------------------ */

function sun(): Art {
  const scene = new THREE.Scene();
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1),
    std(0xffd34a, { emissive: 0xff9a1a, emissiveIntensity: 1.6 }));
  const rays = new THREE.Group();
  const inner = new THREE.Group();
  const rayMat = std(0xffc531, { emissive: 0xff8a00, emissiveIntensity: 1.3 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const ray = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.75, 5), rayMat);
    ray.position.set(Math.cos(a) * 1.55, Math.sin(a) * 1.55, 0);
    ray.rotation.z = a - Math.PI / 2;
    rays.add(ray);
    const short = ray.clone();
    short.scale.setScalar(0.6);
    short.position.set(Math.cos(a + Math.PI / 12) * 1.32, Math.sin(a + Math.PI / 12) * 1.32, 0);
    short.rotation.z = a + Math.PI / 12 - Math.PI / 2;
    inner.add(short);
  }
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: 0xff9a30, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0.85,
  }));
  halo.scale.setScalar(6);
  scene.add(halo, rays, inner, core);
  lit(scene, 0xffe2b0);
  return {
    scene, view: [4.4, 0],
    update(t) {
      rays.rotation.z = t * 0.25;
      inner.rotation.z = -t * 0.4;
      core.rotation.set(t * 0.3, t * 0.45, 0);
      // it throbs: rays reach out and the glow swells with them
      const throb = 1 + 0.06 * Math.sin(t * 3.1);
      rays.scale.setScalar(throb);
      halo.scale.setScalar(6 * (1 + 0.1 * Math.sin(t * 3.1 + 0.6)));
      (rayMat as THREE.MeshStandardMaterial).emissiveIntensity = 1.2 + 0.4 * Math.sin(t * 6.3);
    },
  };
}

/* --- Gieß den Kiez: a watering can over a street tree ----------------------- */

function watering(): Art {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.position.y = -2.3;
  scene.add(root);

  // a Berlin tree pit: soil in a kerbed square
  const kerb = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 2.6), std(0x9a968c));
  kerb.position.y = -0.09;
  const soil = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.2, 2.2), std(0x4a3420, { roughness: 1 }));
  soil.position.y = -0.07;
  root.add(kerb, soil);

  // the city's own tree: the same trunk and lumpy crown as every street tree
  const trunk = new THREE.Mesh(TRUNK_GEO(), trunkMaterial());
  trunk.scale.set(0.26, 2.7, 0.26);
  const crownMat = crownMaterial();
  crownMat.color.setRGB(0.36, 0.5, 0.2, THREE.SRGBColorSpace);
  const crown = new THREE.Mesh(CROWN_GEO(), crownMat);
  crown.position.y = 3.3;
  crown.scale.set(1.55, 1.35, 1.55);
  root.add(trunk, crown);

  // the can, tipped toward the foot of the tree
  const metal = std(0x3f8fc4, { metalness: 0.35, roughness: 0.45 });
  const can = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.62, 12), metal);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.045, 6, 12, Math.PI), metal);
  handle.position.set(-0.05, 0.3, 0);
  handle.rotation.y = Math.PI / 2;
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.06, 0.8, 7), metal);
  spout.position.set(0.48, 0.12, 0);
  spout.rotation.z = -Math.PI / 3.2;
  const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.04, 0.1, 9), std(0x2f6f9a));
  rose.position.set(0.82, 0.36, 0);
  rose.rotation.z = -Math.PI / 3.2;
  // the rose's mouth, and a point back along the spout: the drops' way out
  const tip = new THREE.Object3D();
  tip.position.set(0.86, 0.4, 0);
  const back = new THREE.Object3D();
  back.position.set(0.48, 0.12, 0);
  can.add(body, handle, spout, rose, tip, back);
  can.scale.setScalar(1.3);
  can.position.set(-1.6, 1.9, 0.3);
  root.add(can);

  // drops on their way down, and the rings where they land
  const N = 46;
  const drops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.035, 0),
    std(0x9fd8ff, { emissive: 0x16496b, roughness: 0.15 }), N);
  const life = Array.from({ length: N }, (_, i) => i / N);
  const start = new THREE.Vector3();
  const vel = new THREE.Vector3();
  const land = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const ripples = Array.from({ length: 3 }, (_, i) => {
    const r = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.09, 16),
      new THREE.MeshBasicMaterial({ color: 0xbfe6ff, transparent: true, side: THREE.DoubleSide }));
    r.rotation.x = -Math.PI / 2;
    r.userData.phase = i / 3;
    root.add(r);
    return r;
  });
  root.add(drops);
  lit(scene);
  return {
    scene, view: [5, 0.16],
    update(t, dt) {
      root.rotation.y = -0.35 + Math.sin(t * 0.35) * 0.25;
      can.rotation.z = -0.95 - 0.08 * Math.sin(t * 2.2);
      crown.scale.set(1.55, 1.35 + 0.035 * Math.sin(t * 2.2), 1.55);
      root.updateMatrixWorld(true);
      root.worldToLocal(tip.getWorldPosition(start));
      root.worldToLocal(back.getWorldPosition(vel));
      vel.subVectors(start, vel).normalize().multiplyScalar(1.4);
      // until they reach the soil
      const flight = (vel.y + Math.sqrt(vel.y * vel.y + 19.6 * (start.y - 0.04))) / 9.8;
      for (let i = 0; i < N; i++) {
        life[i] = (life[i] + dt / flight) % 1;
        const s = life[i] * flight;
        const spread = (i % 5 - 2) * 0.05;
        m.makeTranslation(start.x + vel.x * s, start.y + vel.y * s - 4.9 * s * s, start.z + vel.z * s + spread);
        drops.setMatrixAt(i, m);
      }
      drops.instanceMatrix.needsUpdate = true;
      land.set(start.x + vel.x * flight, 0.04, start.z + vel.z * flight);
      for (const r of ripples) {
        const k = (t * 1.4 + r.userData.phase) % 1;
        r.position.set(land.x + (r.userData.phase - 0.33) * 0.2, 0.04, land.z);
        r.scale.setScalar(1 + k * 4);
        (r.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
      }
    },
  };
}

/* --- Klo-Notstand: a flush, seen from above -------------------------------- */

function toilet(): Art {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.position.y = -0.2;
  scene.add(root);
  const porcelain = std(0xf4f6fa, { roughness: 0.25, flatShading: false });

  // a round patch of bathroom floor, not a whole room
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1.05, 40), std(0xffffff, {
    map: canvasTexture(256, 256, (g) => {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        g.fillStyle = (x + y) % 2 ? '#8ea3c4' : '#a9bbd6';
        g.fillRect(x * 32, y * 32, 32, 32);
      }
      g.strokeStyle = 'rgba(40,50,70,.5)';
      g.lineWidth = 2;
      for (let i = 0; i <= 8; i++) {
        g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, 256); g.stroke();
        g.beginPath(); g.moveTo(0, i * 32); g.lineTo(256, i * 32); g.stroke();
      }
    }), flatShading: false, roughness: 0.4,
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.5;

  // the bowl: a lathed cup stretched into an oval, a seat ring on its rim
  const profile = [[0.02, -0.3], [0.16, -0.28], [0.3, -0.15], [0.42, 0.05], [0.5, 0.2], [0.53, 0.25], [0.5, 0.28]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const bowl = new THREE.Mesh(new THREE.LatheGeometry(profile, 28), porcelain.clone());
  (bowl.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.5, 20), porcelain);
  pedestal.position.y = -0.5;
  const seat = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.07, 8, 32), std(0xffffff, { roughness: 0.3, flatShading: false }));
  seat.rotation.x = -Math.PI / 2;
  seat.position.y = 0.3;
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.05, 32), std(0xffffff, { roughness: 0.3, flatShading: false }));
  lid.rotation.x = -0.25;
  lid.position.set(0, 0.85, -0.68);
  lid.scale.set(1, 1, 1.25);
  const oval = new THREE.Group();
  oval.add(bowl, pedestal, seat);
  oval.scale.set(1, 1, 1.28);
  oval.position.z = 0.25;
  const tank = new THREE.Mesh(new RoundedBox(1.3, 0.8, 0.42), porcelain);
  tank.position.set(0, 0.35, -0.85);
  const button = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.06, 20), std(0xc9d2de, { metalness: 0.6, roughness: 0.3, flatShading: false }));
  button.position.set(0, 0.78, -0.85);
  root.add(floor, oval, tank, button, lid);

  // the water: a spiral that spins down the drain and comes back
  const swirl = canvasTexture(256, 256, (g) => {
    g.fillStyle = '#3d9ad6';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(235,248,255,.85)';
    g.lineCap = 'round';
    for (let arm = 0; arm < 3; arm++) {
      g.lineWidth = 7;
      g.beginPath();
      for (let k = 0; k <= 60; k++) {
        const a = arm * (Math.PI * 2 / 3) + k * 0.12, r = 8 + k * 2;
        g[k ? 'lineTo' : 'moveTo'](128 + Math.cos(a) * r, 128 + Math.sin(a) * r);
      }
      g.stroke();
    }
  });
  const water = new THREE.Mesh(new THREE.CircleGeometry(0.4, 32),
    new THREE.MeshStandardMaterial({ map: swirl, roughness: 0.05, transparent: true }));
  water.rotation.x = -Math.PI / 2;
  const waterHolder = new THREE.Group();
  waterHolder.add(water);
  waterHolder.scale.z = 1.28;
  waterHolder.position.z = 0.25;
  root.add(waterHolder);
  lit(scene);
  const CYCLE = 3.4;
  return {
    scene, view: [2.3, 1.05],
    update(t) {
      root.rotation.y = Math.sin(t * 0.3) * 0.25;
      const k = (t % CYCLE) / CYCLE;
      button.position.y = 0.78 - (k < 0.1 ? Math.sin(k / 0.1 * Math.PI) * 0.04 : 0);
      // spin up, sink and shrink into the drain; then it fills again
      const drain = k < 0.1 ? 0 : k < 0.62 ? (k - 0.1) / 0.52 : k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      water.rotation.z -= 0.02 + drain * 0.35;
      const r = 1 - 0.8 * drain * drain;
      water.scale.set(r, r, 1);
      water.position.y = 0.06 - 0.24 * drain;
      (water.material as THREE.MeshStandardMaterial).opacity = k > 0.62 && k < 0.7 ? 0.2 : 1;
    },
  };
}

/** A box with its edges taken off: the toilet tank. */
class RoundedBox extends THREE.BufferGeometry {
  constructor(w: number, h: number, d: number) {
    super();
    const shape = new THREE.Shape();
    const r = Math.min(w, d) * 0.22, x = w / 2, z = d / 2;
    shape.moveTo(-x + r, -z);
    shape.lineTo(x - r, -z); shape.quadraticCurveTo(x, -z, x, -z + r);
    shape.lineTo(x, z - r); shape.quadraticCurveTo(x, z, x - r, z);
    shape.lineTo(-x + r, z); shape.quadraticCurveTo(-x, z, -x, z - r);
    shape.lineTo(-x, -z + r); shape.quadraticCurveTo(-x, -z, -x + r, -z);
    const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2 });
    g.rotateX(-Math.PI / 2).translate(0, -h / 2, 0);
    this.copy(g);
    g.dispose();
  }
}

/* --- Döner-Marathon: the spit turning before the grill ---------------------- */

function spit(): Art {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  // stacked, pressed meat: browner layers, charred where the grill reaches
  const meat = canvasTexture(256, 256, (g) => {
    for (let y = 0; y < 256; y += 4) {
      const v = 0.75 + Math.random() * 0.35;
      g.fillStyle = `rgb(${Math.round(168 * v)},${Math.round(92 * v)},${Math.round(42 * v)})`;
      g.fillRect(0, y, 256, 4);
    }
    for (let i = 0; i < 260; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(70,30,10,.55)' : 'rgba(215,140,70,.45)';
      g.fillRect(Math.random() * 256, Math.random() * 256, 4 + Math.random() * 14, 2 + Math.random() * 3);
    }
  });
  meat.wrapS = THREE.RepeatWrapping;
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.42, 2, 14, 6),
    std(0xffffff, { map: meat, roughness: 0.6 }));
  // a lumpy, hand-stacked outline rather than a lathe-perfect one
  const p = cone.geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), y = p.getY(i);
    const k = 1 + 0.06 * Math.sin(y * 9 + Math.atan2(z, x) * 3) + 0.04 * Math.sin(y * 23);
    p.setXYZ(i, x * k, y, z * k);
  }
  cone.geometry.computeVertexNormals();
  const steel = std(0xb9bec4, { metalness: 0.8, roughness: 0.3, flatShading: false });
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 3, 8), steel);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.66, 0.05, 20), steel);
  top.position.y = 1.04;
  const bottom = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.06, 20), steel);
  bottom.position.y = -1.04;
  const turning = new THREE.Group();
  turning.add(cone, top);
  root.add(turning, rod, bottom);

  // the grill behind: a dark panel with glowing bars
  const grill = new THREE.Group();
  grill.add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.4, 0.12), std(0x2b2b2e, { metalness: 0.5 })));
  const barMat = std(0x401000, { emissive: 0xff5a10, emissiveIntensity: 2 });
  for (let i = 0; i < 6; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.06), barMat);
    bar.position.set(0, -0.95 + i * 0.38, 0.08);
    grill.add(bar);
  }
  grill.position.set(0, 0, -1.05);
  root.add(grill);
  const glow = new THREE.PointLight(0xff7a2a, 6, 4);
  glow.position.set(0, 0, -0.6);
  root.add(glow);

  // shavings dropping off the side
  const shavings = Array.from({ length: 6 }, (_, i) => {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.06), std(0xa85d29));
    s.userData.phase = i / 6;
    root.add(s);
    return s;
  });
  lit(scene, 0xffe6c8);
  return {
    scene, view: [2.9, 0.15],
    update(t) {
      turning.rotation.y = t * 1.3;
      root.rotation.y = 0.5 + Math.sin(t * 0.3) * 0.2;
      barMat.emissiveIntensity = 1.8 + 0.4 * Math.sin(t * 7) * Math.sin(t * 2.3);
      for (const s of shavings) {
        const k = (t * 0.6 + s.userData.phase) % 1;
        s.position.set(0.62 + k * 0.25, 0.6 - k * 1.6 - k * k, 0.25 + s.userData.phase * 0.2);
        s.rotation.set(k * 6, k * 4, 0);
        s.visible = k < 0.95;
      }
    },
  };
}

const ARTS: Record<string, () => Art> = { markets: snow, heat: sun, giessen: watering, toilets: toilet, doener: spit };

export class LoadingArt {
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  private art: Art | null = null;
  private frame = 0;
  private t0 = 0;
  private last = 0;

  /** canvas: where to draw; anchor: the spacer the subject should sit over. */
  constructor(private readonly canvas: HTMLCanvasElement, private readonly anchor: HTMLElement) {}

  show(id: string): void {
    this.hide();
    this.renderer ??= new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.art = (ARTS[id] ?? snow)();
    this.anchor.classList.toggle('none', id === 'markets');
    this.t0 = this.last = performance.now();
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tick = (now: number) => {
      if (!this.art) return;
      const t = (now - this.t0) / 1000;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.art.update(still ? 1.2 : t, still ? 0 : dt);
      this.draw();
      if (!still) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  hide(): void {
    cancelAnimationFrame(this.frame);
    if (!this.art) return;
    // the city's tree shapes are shared with every tile: leave those be
    const keep = new Set<THREE.BufferGeometry>([TRUNK_GEO(), CROWN_GEO()]);
    this.art.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !keep.has(m.geometry)) m.geometry.dispose();
      for (const mat of [m.material].flat()) {
        if (!mat) continue;
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
        mat.dispose();
      }
    });
    this.art = null;
    this.renderer?.renderLists.dispose();
  }

  private draw(): void {
    const r = this.renderer!, art = this.art!;
    const w = innerWidth, h = innerHeight;
    const size = r.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) r.setSize(w, h, false);
    // the subject at the spacer's centre: shift the view instead of the scene
    const box = this.anchor.getBoundingClientRect();
    const cy = box.height ? box.top + box.height / 2 : h / 2;
    const cam = this.camera;
    cam.aspect = w / h;
    // back off until the subject is as tall as the spacer, whatever the window
    const [tall, down] = art.view;
    const visible = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const dist = tall && box.height ? tall / (visible * (box.height / h)) : 8;
    cam.position.set(0, Math.sin(down) * dist, Math.cos(down) * dist);
    cam.lookAt(0, 0, 0);
    cam.setViewOffset(w, h, 0, h / 2 - cy, w, h);
    cam.updateProjectionMatrix();
    r.render(art.scene, cam);
  }
}
