import * as THREE from 'three';

/**
 * Procedural articulated characters and rideables.
 *
 * Everything here is built from primitives and animated by driving joint
 * rotations directly. No skinned glTF: the page loads no external assets, and
 * a jointed figure at third-person distance reads perfectly well while costing
 * a few hundred triangles and no download.
 *
 * Joint angles follow a normal walk cycle - opposing arm and leg, knee flexing
 * only on the swing phase, slight torso counter-rotation - with the cycle
 * driven by distance travelled rather than by time, so the feet keep pace with
 * the ground instead of sliding.
 */

const SKIN = 0xd8a07a;
const JACKET = 0xe0673c;

export interface Rig {
  body: THREE.Group;
  hips: THREE.Group;
  torso: THREE.Mesh;
  head: THREE.Group;
  armL: THREE.Group; armR: THREE.Group;
  foreL: THREE.Group; foreR: THREE.Group;
  legL: THREE.Group; legR: THREE.Group;
  shinL: THREE.Group; shinR: THREE.Group;
  footL: THREE.Mesh; footR: THREE.Mesh;
}

export interface Palette { skin?: number; top?: number; legs?: number; hair?: number }

function mat(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color });
}

function rig(root: THREE.Object3D): Rig {
  return root.userData.rig as Rig;
}

function box(w: number, h: number, d: number, color: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
}

/** A limb that pivots from its top end, like a real joint. */
function limb(w: number, h: number, d: number, color: number): THREE.Group {
  const pivot = new THREE.Group();
  const m = box(w, h, d, color);
  m.position.y = -h / 2;
  pivot.add(m);
  pivot.userData.length = h;
  return pivot;
}

export function makeHuman(palette: Palette = {}): THREE.Group {
  const skin = palette.skin ?? SKIN;
  const top = palette.top ?? JACKET;
  const legs = palette.legs ?? 0x36405a;
  const hair = palette.hair ?? 0x2a2118;

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const hips = new THREE.Group();
  hips.position.y = 0.92;
  body.add(hips);

  const torso = box(0.42, 0.58, 0.24, top);
  torso.position.y = 0.29;
  hips.add(torso);

  const neck = box(0.12, 0.08, 0.12, skin);
  neck.position.y = 0.62;
  hips.add(neck);

  const head = new THREE.Group();
  head.position.y = 0.70;
  hips.add(head);
  const skull = box(0.23, 0.26, 0.23, skin);
  head.add(skull);
  const cap = box(0.245, 0.09, 0.245, hair);
  cap.position.y = 0.10;
  head.add(cap);

  const armL = limb(0.12, 0.30, 0.13, top);
  const armR = limb(0.12, 0.30, 0.13, top);
  armL.position.set(-0.27, 0.55, 0);
  armR.position.set(0.27, 0.55, 0);
  hips.add(armL, armR);

  const foreL = limb(0.10, 0.28, 0.11, skin);
  const foreR = limb(0.10, 0.28, 0.11, skin);
  foreL.position.y = -0.30;
  foreR.position.y = -0.30;
  armL.add(foreL);
  armR.add(foreR);

  const legL = limb(0.155, 0.46, 0.16, legs);
  const legR = limb(0.155, 0.46, 0.16, legs);
  legL.position.set(-0.11, 0, 0);
  legR.position.set(0.11, 0, 0);
  hips.add(legL, legR);

  const shinL = limb(0.13, 0.44, 0.14, legs);
  const shinR = limb(0.13, 0.44, 0.14, legs);
  shinL.position.y = -0.46;
  shinR.position.y = -0.46;
  legL.add(shinL);
  legR.add(shinR);

  const footL = box(0.15, 0.09, 0.28, 0x1d1f26);
  const footR = box(0.15, 0.09, 0.28, 0x1d1f26);
  footL.position.set(0, -0.46, 0.05);
  footR.position.set(0, -0.46, 0.05);
  shinL.add(footL);
  shinR.add(footR);

  const r: Rig = { body, hips, torso, head, armL, armR, foreL, foreR,
                   legL, legR, shinL, shinR, footL, footR };
  root.userData.rig = r;
  return root;
}

/** Reset every joint; each pose function starts from a known state. */
function rest(r: Rig): void {
  for (const k of ['armL', 'armR', 'foreL', 'foreR', 'legL', 'legR', 'shinL', 'shinR'] as const) {
    r[k].rotation.set(0, 0, 0);
  }
  r.hips.rotation.set(0, 0, 0);
  r.hips.position.y = 0.92;
  r.torso.rotation.set(0, 0, 0);
  r.head.rotation.set(0, 0, 0);
}

export function poseWalk(root: THREE.Object3D, phase: number, speed: number): void {
  const r = rig(root);
  rest(r);
  // blend amplitude with speed so a slow walk is not a march
  const amp = Math.min(1, speed / 5.5);
  const s = Math.sin(phase);
  const c = Math.cos(phase);

  r.legL.rotation.x = s * 0.72 * amp;
  r.legR.rotation.x = -s * 0.72 * amp;
  // knees only bend on the backswing, which is what stops the "skating" look
  r.shinL.rotation.x = Math.max(0, -s) * 1.15 * amp;
  r.shinR.rotation.x = Math.max(0, s) * 1.15 * amp;

  r.armL.rotation.x = -s * 0.62 * amp;
  r.armR.rotation.x = s * 0.62 * amp;
  r.foreL.rotation.x = (0.25 + Math.max(0, s) * 0.5) * amp;
  r.foreR.rotation.x = (0.25 + Math.max(0, -s) * 0.5) * amp;
  r.armL.rotation.z = 0.09;
  r.armR.rotation.z = -0.09;

  r.hips.position.y = 0.92 + Math.abs(c) * 0.045 * amp;
  r.hips.rotation.y = s * 0.10 * amp;
  r.torso.rotation.y = -s * 0.13 * amp;
  r.torso.rotation.x = 0.06 + Math.min(0.22, speed * 0.022);
  r.head.rotation.x = -Math.min(0.18, speed * 0.018);
}

export function poseIdle(root: THREE.Object3D, t: number): void {
  const r = rig(root);
  rest(r);
  const breathe = Math.sin(t * 1.6);
  r.hips.position.y = 0.92 + breathe * 0.012;
  r.armL.rotation.x = 0.06;
  r.armR.rotation.x = 0.06;
  r.armL.rotation.z = 0.10;
  r.armR.rotation.z = -0.10;
  r.foreL.rotation.x = 0.18;
  r.foreR.rotation.x = 0.18;
  r.head.rotation.y = Math.sin(t * 0.4) * 0.18;
}

export function poseJump(root: THREE.Object3D, rising: boolean): void {
  const r = rig(root);
  rest(r);
  r.armL.rotation.x = rising ? -2.2 : -1.5;
  r.armR.rotation.x = rising ? -2.2 : -1.5;
  r.legL.rotation.x = rising ? -0.35 : 0.30;
  r.legR.rotation.x = rising ? 0.25 : 0.30;
  r.shinL.rotation.x = rising ? 0.9 : 0.35;
  r.shinR.rotation.x = 0.5;
  r.torso.rotation.x = rising ? -0.12 : 0.10;
}

/** Seated, hands forward on a wheel. */
export function poseDrive(root: THREE.Object3D): void {
  const r = rig(root);
  rest(r);
  r.hips.position.y = 0.62;
  r.legL.rotation.x = -1.45;
  r.legR.rotation.x = -1.45;
  r.shinL.rotation.x = 1.35;
  r.shinR.rotation.x = 1.35;
  r.armL.rotation.x = -1.15;
  r.armR.rotation.x = -1.15;
  r.armL.rotation.z = 0.22;
  r.armR.rotation.z = -0.22;
  r.foreL.rotation.x = -0.30;
  r.foreR.rotation.x = -0.30;
  r.torso.rotation.x = 0.10;
}

/** Leaning over the bars, legs turning the cranks. */
export function poseCycle(root: THREE.Object3D, phase: number, lean = 0.42): void {
  const r = rig(root);
  rest(r);
  r.hips.position.y = 0.72;
  r.torso.rotation.x = lean;
  r.head.rotation.x = -lean * 0.8;

  const s = Math.sin(phase);
  const c = Math.cos(phase);
  // thigh sweeps, shin follows a quarter turn behind: a pedalling circle
  r.legL.rotation.x = -0.55 + s * 0.55;
  r.legR.rotation.x = -0.55 - s * 0.55;
  r.shinL.rotation.x = 0.95 + c * 0.5;
  r.shinR.rotation.x = 0.95 - c * 0.5;

  r.armL.rotation.x = -1.05 - lean * 0.35;
  r.armR.rotation.x = -1.05 - lean * 0.35;
  r.armL.rotation.z = 0.20;
  r.armR.rotation.z = -0.20;
  r.foreL.rotation.x = 0.12;
  r.foreR.rotation.x = 0.12;
}

/** Standing on a deck, one foot forward. */
export function poseScoot(root: THREE.Object3D, t: number): void {
  const r = rig(root);
  rest(r);
  r.hips.position.y = 0.90;
  r.torso.rotation.x = 0.20;
  r.legL.rotation.x = -0.22;
  r.legR.rotation.x = 0.30;
  r.shinL.rotation.x = 0.18;
  r.shinR.rotation.x = 0.12;
  r.hips.rotation.y = -0.30;
  r.armL.rotation.x = -1.30;
  r.armR.rotation.x = -1.30;
  r.armL.rotation.z = 0.16;
  r.armR.rotation.z = -0.16;
  r.head.rotation.y = 0.28;
  r.hips.position.y += Math.sin(t * 9) * 0.006;   // deck buzz
}

/* --- rideables ----------------------------------------------------------- */

function wheel(radius: number, width: number, color = 0x14161c): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, width, 16), mat(color));
  m.rotation.z = Math.PI / 2;
  return m;
}

export function makeBike(): THREE.Group {
  const g = new THREE.Group();
  const frame = mat(0x2e6f7d);
  const tube = (len: number, thick = 0.045) =>
    new THREE.Mesh(new THREE.BoxGeometry(thick, len, thick), frame);

  // Everything here points its front at +Z, matching makeHuman(), so a single
  // yaw drives rider and machine together. Building the bike facing -Z instead
  // left it rotated 180 degrees from the rider - handlebars trailing behind.
  const wf = wheel(0.34, 0.05);
  const wr = wheel(0.34, 0.05);
  wf.position.set(0, 0.34, 0.52);      // front
  wr.position.set(0, 0.34, -0.52);
  g.add(wf, wr);
  g.userData.wheels = [wf, wr];

  const down = tube(0.85);
  down.position.set(0, 0.58, -0.05);
  down.rotation.x = -0.62;
  const seatTube = tube(0.52);
  seatTube.position.set(0, 0.62, -0.36);
  seatTube.rotation.x = 0.25;
  const topTube = tube(0.62);
  topTube.position.set(0, 0.80, -0.10);
  topTube.rotation.x = -(Math.PI / 2 - 0.10);
  const fork = tube(0.62);
  fork.position.set(0, 0.60, 0.46);
  fork.rotation.x = 0.16;
  g.add(down, seatTube, topTube, fork);

  const bars = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.04, 0.04), frame);
  bars.position.set(0, 0.94, 0.42);    // out front, under the rider's hands
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.05, 0.26), mat(0x1d1f26));
  saddle.position.set(0, 0.90, -0.40);
  g.add(bars, saddle);
  return g;
}

export function makeScooter(): THREE.Group {
  const g = new THREE.Group();
  const body = mat(0x3d4450);
  const accent = mat(0xd9d9dc);

  const wf = wheel(0.13, 0.05);
  const wr = wheel(0.13, 0.05);
  wf.position.set(0, 0.13, 0.44);      // front
  wr.position.set(0, 0.13, -0.44);
  g.add(wf, wr);
  g.userData.wheels = [wf, wr];

  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.06, 0.86), body);
  deck.position.set(0, 0.15, -0.02);
  const stem = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.98, 0.06), accent);
  stem.position.set(0, 0.62, 0.42);    // steering column ahead of the rider
  stem.rotation.x = 0.10;
  const bars = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.05, 0.05), accent);
  bars.position.set(0, 1.06, 0.47);
  g.add(deck, stem, bars);
  return g;
}
