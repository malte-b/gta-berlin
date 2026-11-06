import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { WATER_ORDER } from './water';

/**
 * Procedural articulated characters and rideables.
 *
 * Everything here is built from primitives and animated by driving joint
 * rotations directly. No skinned glTF: the page loads no external assets, and
 * a jointed figure at third-person distance reads perfectly well while costing
 * a few thousand triangles and no download.
 *
 * The look is soft toy rather than bare boxes: rounded blocks, capsule limbs,
 * a face, hands and sneakers, a hoodie and a backpack - the back is what the
 * chase camera sees most. Geometry and materials are shared through small
 * caches, so a second figure (Santa) costs next to nothing.
 *
 * On foot the gait blends from a walk into a run with speed (poseWalk), and
 * the hips stand on whichever foot is lower, so feet meet the ground. The
 * cycle is driven by distance travelled rather than by time, so the feet keep
 * pace with the ground instead of sliding. On a bike or scooter the hands and
 * feet are put on the grips and pedals by two-joint IK (reachFor).
 */

const SKIN = 0xd8a07a;
const JACKET = 0xe0673c;

export interface Rig {
  body: THREE.Group;
  hips: THREE.Group;
  /** Everything above the waist: a lean or twist here carries the arms and head. */
  torso: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group; armR: THREE.Group;
  foreL: THREE.Group; foreR: THREE.Group;
  legL: THREE.Group; legR: THREE.Group;
  shinL: THREE.Group; shinR: THREE.Group;
  /** Ankles: a foot's rotation.x, positive tips the toes down. */
  footL: THREE.Object3D; footR: THREE.Object3D;
}

export interface Palette {
  skin?: number; top?: number; legs?: number; hair?: number; shoes?: number;
  /** A backpack in this colour; null for none. */
  pack?: number | null;
  /** The hoodie's hood, lying at the back of the neck. */
  hood?: boolean;
}

const mats = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: number, roughness = 0.8, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${JSON.stringify(extra)}`;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, ...extra });
    mats.set(key, m);
  }
  return m;
}

const geos = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geos.get(key);
  if (!g) { g = make(); geos.set(key, g); }
  return g;
}

/** A block with rounded edges: the basic shape of everything here. */
function block(w: number, h: number, d: number, r: number, m: THREE.Material): THREE.Mesh {
  const rr = Math.min(r, w / 2, h / 2, d / 2) * 0.999;
  return new THREE.Mesh(geo(`b${w},${h},${d},${rr}`, () => new RoundedBoxGeometry(w, h, d, 2, rr)), m);
}

/**
 * The trunk: one rounded block, h tall, w by d at the shoulders and
 * narrowing to `waist` of that at the bottom - a single body, not a chest
 * stacked on a belly.
 */
function trunk(w: number, h: number, d: number, r: number, waist: number, m: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(geo(`t${w},${h},${d},${r},${waist}`, () => {
    const g = new RoundedBoxGeometry(w, h, d, 3, r);
    const pos = g.attributes.position, nor = g.attributes.normal;
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const f = waist + (1 - waist) * (pos.getY(i) / h + 0.5), fz = 0.5 + 0.5 * f;
      pos.setX(i, pos.getX(i) * f);
      pos.setZ(i, pos.getZ(i) * fz);
      // the box's own smooth normals, carried through the squeeze
      n.set(nor.getX(i) / f, nor.getY(i), nor.getZ(i) / fz).normalize();
      nor.setXYZ(i, n.x, n.y, n.z);
    }
    return g;
  }), m);
}

function ball(r: number, m: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(geo(`s${r}`, () => new THREE.SphereGeometry(r, 12, 8)), m);
}

/** A cylinder from a to b. */
function rod(a: THREE.Vector3Like, b: THREE.Vector3Like, r: number, m: THREE.Material): THREE.Mesh {
  const from = new THREE.Vector3().copy(a), to = new THREE.Vector3().copy(b);
  const len = from.distanceTo(to);
  const mesh = new THREE.Mesh(geo(`c${r},${len.toFixed(3)}`, () => new THREE.CylinderGeometry(r, r, len, 8)), m);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.sub(from).normalize());
  return mesh;
}

function rig(root: THREE.Object3D): Rig {
  return root.userData.rig as Rig;
}

/** A limb that pivots from its top end, like a real joint: h long, r0 thick there and r1 at its other end. */
function limb(r0: number, r1: number, h: number, m: THREE.Material): THREE.Group {
  const pivot = new THREE.Group();
  // tapering from the joint it hangs from to the next, a ball centred on
  // each: a bent knee or elbow stays round and closed, where two capsules
  // ending at the joint met in a notch
  const shaft = new THREE.Mesh(geo(`l${r0},${r1},${h}`, () => new THREE.CylinderGeometry(r0, r1, h, 12, 1, true)), m);
  shaft.position.y = -h / 2;
  const end = ball(r1, m);
  end.position.y = -h;
  pivot.add(shaft, ball(r0, m), end);
  pivot.userData.length = h;
  return pivot;
}

/** Hip joint height when standing, and the leg it stands on. */
const HIP = 0.92;
const LEG_Y = -0.02;          // the thighs hang from just below the hip pivot
const THIGH = 0.43;
const SHIN = 0.40;
/** The sole's underside below the ankle, and the heel and toe either side of it. */
const SOLE = 0.0675;
const HEEL = -0.11;
const TOE = 0.18;
/** Shoulder above the waist joint; upper arm, and elbow to the middle of the hand. */
const SHOULDER = 0.4;
const UPPER_ARM = 0.30;
const FOREARM = 0.30;

function shade(c: number, f: number): number {
  return new THREE.Color(c).multiplyScalar(f).getHex();
}

/** A sneaker hung from the ankle: a white sole and a coloured upper, toe forward (+Z). */
function sneaker(colour: number): THREE.Group {
  const g = new THREE.Group();
  const sole = block(0.13, 0.035, 0.29, 0.016, mat(0xf2f0ea, 0.6));
  sole.position.set(0, -SOLE + 0.0175, (HEEL + TOE) / 2);
  const upper = block(0.12, 0.075, 0.25, 0.035, mat(colour, 0.6));
  upper.position.set(0, -0.02, (HEEL + TOE) / 2 - 0.015);
  g.add(sole, upper);
  return g;
}

/** Part of a sphere: theta from the top down, phi round from -X. */
function dome(r: number, phi0: number, phiLen: number, thetaLen: number, m: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(geo(`d${r},${phi0},${phiLen},${thetaLen}`, () =>
    new THREE.SphereGeometry(r, 16, 10, phi0, phiLen, 0, thetaLen)), m);
}

export function makeHuman(palette: Palette = {}): THREE.Group {
  const top = palette.top ?? JACKET;
  const skinM = mat(palette.skin ?? SKIN, 0.7);
  const topM = mat(top, 0.85);
  const topShade = mat(shade(top, 0.8), 0.85);
  const legsM = mat(palette.legs ?? 0x3a4a6b, 0.9);
  const hairM = mat(palette.hair ?? 0x2a2118, 0.9);
  const dark = mat(0x1b1d22, 0.4);
  const white = mat(0xffffff, 0.4);

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const hips = new THREE.Group();
  hips.position.y = HIP;
  body.add(hips);
  const pelvis = block(0.33, 0.2, 0.21, 0.08, legsM);
  pelvis.position.y = 0.0;
  hips.add(pelvis);

  // Everything above the waist hangs from one joint, so a lean or a twist
  // carries the shoulders, arms and head along instead of shearing past them.
  const torso = new THREE.Group();
  torso.position.y = 0.08;
  hips.add(torso);
  // one body from the shoulders down to the hem over the belt
  const jacket = trunk(0.4, 0.5, 0.24, 0.085, 0.84, topM);
  jacket.position.y = 0.22;
  const pocket = block(0.22, 0.09, 0.02, 0.01, topShade);
  pocket.position.set(0, 0.06, 0.107);
  torso.add(jacket, pocket);
  if (palette.hood ?? true) {
    const hood = block(0.24, 0.08, 0.1, 0.04, topShade);
    hood.position.set(0, 0.465, -0.075);
    hood.rotation.x = 0.3;
    torso.add(hood);
  }
  if (palette.pack !== null) {
    const packC = palette.pack ?? 0x2f6f62;
    const pack = block(0.27, 0.31, 0.12, 0.055, mat(packC, 0.85));
    pack.position.set(0, 0.28, -0.17);
    const flap = block(0.27, 0.08, 0.13, 0.035, mat(shade(packC, 0.75), 0.85));
    flap.position.set(0, 0.41, -0.17);
    torso.add(pack, flap);
    // straps over the shoulders and down the front
    const strapM = mat(shade(packC, 0.6), 0.85);
    for (const s of [-1, 1]) {
      const over = block(0.045, 0.025, 0.25, 0.01, strapM);
      over.position.set(s * 0.1, 0.475, -0.005);
      const front = block(0.045, 0.24, 0.02, 0.01, strapM);
      front.position.set(s * 0.1, 0.34, 0.121);
      torso.add(over, front);
    }
  }

  const neck = new THREE.Mesh(geo('neck', () => new THREE.CylinderGeometry(0.054, 0.06, 0.09, 10)), skinM);
  neck.position.y = 0.49;
  torso.add(neck);

  // a round head: the skull a sphere, the hair a cap over its top and back
  const head = new THREE.Group();
  head.position.y = 0.515;
  torso.add(head);
  const skull = ball(0.12, skinM);
  skull.scale.set(0.95, 1.08, 1);
  skull.position.y = 0.115;
  const cap = dome(0.127, 0, Math.PI * 2, 1.15, hairM);
  const back = dome(0.127, Math.PI, Math.PI, 2.05, hairM);
  for (const h of [cap, back]) {
    h.scale.set(0.95, 1.08, 1);
    h.position.y = 0.118;
    h.position.z = -0.004;
  }
  head.add(skull, cap, back);
  // the face, sized for the skull above; the whole head a little larger than life
  const face = new THREE.Group();
  head.add(face);
  for (const s of [-1, 1]) {
    const eye = ball(0.017, dark);
    eye.scale.set(0.85, 1.2, 0.5);
    eye.position.set(s * 0.043, 0.122, 0.108);
    const glint = ball(0.005, white);
    glint.position.set(s * 0.043 + 0.005, 0.129, 0.116);
    const brow = block(0.042, 0.012, 0.014, 0.005, hairM);
    brow.position.set(s * 0.046, 0.158, 0.101);
    brow.rotation.z = -s * 0.12;
    const ear = ball(0.032, skinM);
    ear.scale.set(0.5, 1, 0.8);
    ear.position.set(s * 0.113, 0.11, -0.005);
    face.add(eye, glint, brow, ear);
  }
  const nose = ball(0.019, skinM);
  nose.scale.set(0.9, 1, 1.1);
  nose.position.set(0, 0.098, 0.12);
  const mouth = block(0.046, 0.01, 0.01, 0.004, mat(0x8a4b3c, 0.7));
  mouth.position.set(0, 0.06, 0.106);
  face.add(nose, mouth);
  for (const o of [...head.children]) {
    o.position.multiplyScalar(1.08);
    o.scale.multiplyScalar(1.08);
  }

  // the shoulders round the body's top corners, sunk into it, so an arm
  // swings out of the body rather than off a ball beside it
  const armL = limb(0.066, 0.055, UPPER_ARM, topM);
  const armR = limb(0.066, 0.055, UPPER_ARM, topM);
  armL.position.set(-0.205, SHOULDER, 0);
  armR.position.set(0.205, SHOULDER, 0);
  for (const s of [-1, 1]) {
    const shoulder = ball(0.078, topM);
    shoulder.scale.set(1, 0.92, 1.1);
    shoulder.position.set(s * 0.188, SHOULDER + 0.008, 0);
    torso.add(shoulder);
  }
  torso.add(armL, armR);

  const foreL = limb(0.055, 0.043, 0.27, topM);
  const foreR = limb(0.055, 0.043, 0.27, topM);
  foreL.position.y = -UPPER_ARM;
  foreR.position.y = -UPPER_ARM;
  armL.add(foreL);
  armR.add(foreR);
  for (const f of [foreL, foreR]) {
    const cuff = new THREE.Mesh(geo('cuff', () => new THREE.CylinderGeometry(0.058, 0.058, 0.04, 10)), topShade);
    cuff.position.y = -0.245;
    const hand = ball(0.05, skinM);
    hand.scale.set(0.8, 1.05, 0.95);
    hand.position.y = -FOREARM;
    f.add(cuff, hand);
  }

  const legL = limb(0.094, 0.075, THIGH, legsM);
  const legR = limb(0.094, 0.075, THIGH, legsM);
  legL.position.set(-0.095, LEG_Y, 0);
  legR.position.set(0.095, LEG_Y, 0);
  hips.add(legL, legR);

  const shinL = limb(0.073, 0.048, SHIN, legsM);
  const shinR = limb(0.073, 0.048, SHIN, legsM);
  shinL.position.y = -THIGH;
  shinR.position.y = -THIGH;
  legL.add(shinL);
  legR.add(shinR);

  const footL = sneaker(palette.shoes ?? 0x2b2f3a);
  const footR = sneaker(palette.shoes ?? 0x2b2f3a);
  footL.position.y = -SHIN;
  footR.position.y = -SHIN;
  shinL.add(footL);
  shinR.add(footR);

  const r: Rig = { body, hips, torso, head, armL, armR, foreL, foreR,
                   legL, legR, shinL, shinR, footL, footR };
  root.userData.rig = r;
  return root;
}

/** Reset every joint; each pose function starts from a known state. */
function rest(r: Rig): void {
  for (const k of ['armL', 'armR', 'foreL', 'foreR', 'legL', 'legR', 'shinL', 'shinR', 'footL', 'footR'] as const) {
    r[k].rotation.set(0, 0, 0);
  }
  r.hips.rotation.set(0, 0, 0);
  r.hips.position.set(0, HIP, 0);
  r.torso.rotation.set(0, 0, 0);
  r.head.rotation.set(0, 0, 0);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * How far below the hip joint a leg reaches with these joint angles: the
 * lower of heel and toe. Rotations are about X, positive swinging back.
 */
function reach(thigh: number, knee: number, ankle: number): number {
  const ay = -THIGH * Math.cos(thigh) - SHIN * Math.cos(thigh + knee);
  const f = thigh + knee + ankle;
  const c = Math.cos(f), s = Math.sin(f);
  return -Math.min(ay - SOLE * c - HEEL * s, ay - SOLE * c - TOE * s);
}

/** Stand the hips on whichever foot is lower, so the feet meet the ground. */
function plant(r: Rig, lift = 0): void {
  const down = Math.max(reach(r.legL.rotation.x, r.shinL.rotation.x, r.footL.rotation.x),
                        reach(r.legR.rotation.x, r.shinR.rotation.x, r.footR.rotation.x));
  r.hips.position.y = down - LEG_Y + lift;
}

/** Keys of a periodic curve over a gait cycle: [phase 0..1, value]. */
type Keys = readonly (readonly [number, number])[];

/** A periodic curve through its keys, Catmull-Rom: smooth through every one. */
function cycle(keys: Keys, u: number): number {
  u -= Math.floor(u);
  const n = keys.length;
  let i = n - 1;
  for (let k = 1; k < n; k++) if (keys[k][0] > u) { i = k - 1; break; }
  const at = (k: number): readonly [number, number] => {
    const m = ((k % n) + n) % n;
    return [keys[m][0] + Math.floor(k / n), keys[m][1]];
  };
  const [u0, p0] = at(i - 1), [u1, p1] = at(i), [u2, p2] = at(i + 1), [u3, p3] = at(i + 2);
  const h = u2 - u1, t = (u - u1) / h;
  const m1 = ((p2 - p0) / (u2 - u0)) * h, m2 = ((p3 - p1) / (u3 - u1)) * h;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2;
}

/**
 * One leg through a gait cycle, phase 0 its foot touching down: the thigh
 * (negative forward), the knee (bent positive) and the foot's own angle to
 * the ground (toes down positive), the ankle making up the rest.
 */
interface Gait { thigh: Keys; knee: Keys; foot: Keys }

/**
 * Walking: the heel strikes with the leg nearly straight and well forward,
 * the foot rolls flat and stays down for 60% of the cycle - both feet down at
 * once twice - pushes off from the toes, and swings through with a modest
 * bend at the knee.
 */
const WALK: Gait = {
  thigh: [[0, -0.36], [0.15, -0.18], [0.35, 0.06], [0.55, 0.3], [0.65, 0.18], [0.8, -0.2], [0.93, -0.4]],
  knee: [[0, 0.06], [0.12, 0.22], [0.3, 0.1], [0.5, 0.18], [0.62, 0.55], [0.72, 0.95], [0.85, 0.5], [0.95, 0.08]],
  foot: [[0, -0.28], [0.08, 0], [0.45, 0], [0.6, 0.5], [0.7, 0.25], [0.85, 0], [0.95, -0.2]],
};

/**
 * Running: the foot lands nearly under the body, knee already bent, and is
 * down for a third of the cycle, bending deeper as it takes the weight; then
 * a moment in the air with both feet up. The heel kicks up behind, the knee
 * drives forward still folded, and only reaches down again at the end - the
 * thigh already sweeping back - so there is no straight-legged reach, which
 * is what makes a run look like a power walk.
 */
const RUN: Gait = {
  thigh: [[0, -0.32], [0.14, 0.04], [0.32, 0.36], [0.45, 0.28], [0.6, -0.25], [0.76, -0.72], [0.9, -0.5]],
  knee: [[0, 0.3], [0.13, 0.62], [0.32, 0.3], [0.45, 1.25], [0.58, 1.9], [0.7, 1.55], [0.82, 0.9], [0.94, 0.38]],
  foot: [[0, -0.05], [0.12, 0.02], [0.32, 0.7], [0.45, 0.55], [0.65, 0.15], [0.85, -0.1], [0.95, -0.1]],
};

/** Sprinting: the same, all of it bigger - a high knee, the heel to the seat. */
const SPRINT: Gait = {
  thigh: [[0, -0.36], [0.12, 0.06], [0.3, 0.42], [0.42, 0.34], [0.58, -0.4], [0.74, -1.15], [0.88, -0.72]],
  knee: [[0, 0.32], [0.11, 0.6], [0.3, 0.3], [0.42, 1.5], [0.55, 2.3], [0.68, 1.85], [0.8, 1.05], [0.93, 0.42]],
  foot: [[0, 0.05], [0.1, 0.05], [0.3, 0.75], [0.42, 0.55], [0.65, 0.2], [0.85, 0], [0.95, 0]],
};

/**
 * Walking blending into running and sprinting, by speed. The phase is the
 * left foot's (0 its touch-down); the right foot is half a cycle on.
 *
 * Each leg follows the gait curves above. The arms swing with the opposite
 * thigh, elbows bent to a right angle when running and pumping harder as the
 * hand comes forward; the hips and shoulders twist against each other, and
 * the head turns back against the shoulders and tilts back against the lean,
 * so it keeps looking where it goes. The hips stand on the lower foot, and
 * when running both feet are off the ground in between, the body a little
 * higher; how far it rises and falls is kept to a runner's few centimetres.
 */
export function poseWalk(root: THREE.Object3D, phase: number, speed: number): void {
  const r = rig(root);
  rest(r);
  const run = smooth(2.3, 3.8, speed);
  const sprint = smooth(5, 8.5, speed);
  const u = phase / (2 * Math.PI);
  const gait = (k: keyof Gait, at: number) =>
    mix(cycle(WALK[k], at), mix(cycle(RUN[k], at), cycle(SPRINT[k], at), sprint), run);
  const leg = (at: number): [number, number, number] => {
    const t = gait('thigh', at), k = gait('knee', at);
    return [t, k, Math.min(0.9, Math.max(-0.5, gait('foot', at) - t - k))];
  };
  // up in the air between the steps of a run: a short arc after each push-off
  const flight = (at: number) => {
    const f = (at - Math.floor(at) - mix(0.32, 0.3, sprint)) / mix(0.18, 0.2, sprint);
    return f > 0 && f < 1 ? Math.sin(Math.PI * f) : 0;
  };
  const lift = run * mix(0.025, 0.03, sprint);
  // the hips on the lower foot, and in the air between the steps of a run
  const hips = (at: number) => Math.max(reach(...leg(at)), reach(...leg(at + 0.5))) - LEG_Y
    + lift * (flight(at) + flight(at + 0.5));

  const thighs: number[] = [];
  for (const [side, at] of [[0, u], [1, u + 0.5]] as const) {
    const [t, k, a] = leg(at);
    const legs = [[r.legL, r.shinL, r.footL], [r.legR, r.shinR, r.footR]] as const;
    const [thigh, shin, foot] = legs[side];
    thigh.rotation.x = t;
    shin.rotation.x = k;
    foot.rotation.x = a;
    thighs.push(t);
  }
  const [tl, tr] = thighs;

  // each arm with the other leg's thigh, a little behind the body
  const gain = mix(0.75, mix(0.85, 1.05, sprint), run);
  const back = mix(0.04, 0.12, run);
  const elbow = mix(0.22, mix(1.35, 1.5, sprint), run);
  const pump = mix(0.15, mix(0.35, 0.5, sprint), run);
  for (const [arm, fore, t, s] of [[r.armL, r.foreL, tr, -1], [r.armR, r.foreR, tl, 1]] as const) {
    arm.rotation.x = gain * t + back;
    arm.rotation.z = s * mix(0.08, 0.12, run);
    fore.rotation.x = -(elbow + pump * Math.max(0, -t) / 0.6);
    // running, the forearms swing in across the body a little
    fore.rotation.z = -s * 0.22 * run;
  }

  // hips turn with the leg going forward, shoulders against them
  const hipYaw = mix(0.2, 0.16, run) * (tr - tl) / 2;
  const shoulders = mix(0.5, 0.75, run);
  r.hips.rotation.y = hipYaw;
  r.torso.rotation.y = -(1 + shoulders) * hipYaw;
  r.head.rotation.y = shoulders * hipYaw;
  const lean = mix(0.04, mix(0.13, 0.24, sprint), run);
  r.torso.rotation.x = lean;
  r.head.rotation.x = -lean * 0.85;

  // How far the body rises and falls: a runner's few centimetres. Where the
  // leg behind is too short to hold the hips up as it pushes off, the foot
  // leaves the ground a moment early rather than the body sinking.
  let top = -Infinity;
  for (let i = 0; i < 24; i++) top = Math.max(top, hips(i / 24));
  r.hips.position.y = Math.max(hips(u), top - mix(0.035, mix(0.045, 0.055, sprint), run));
}

export function poseIdle(root: THREE.Object3D, t: number): void {
  const r = rig(root);
  rest(r);
  const breathe = Math.sin(t * 1.6);
  r.torso.rotation.x = 0.02 + breathe * 0.012;
  r.armL.rotation.x = 0.04 - breathe * 0.01;
  r.armR.rotation.x = 0.04 - breathe * 0.01;
  r.armL.rotation.z = -0.1;
  r.armR.rotation.z = 0.1;
  r.foreL.rotation.x = -0.18;
  r.foreR.rotation.x = -0.18;
  // weight a little on one leg
  r.hips.rotation.z = 0.03;
  r.legL.rotation.z = -0.03;
  r.legR.rotation.z = -0.03;
  r.legR.rotation.x = -0.04;
  r.shinR.rotation.x = 0.08;
  r.footR.rotation.x = -0.04;
  r.head.rotation.y = Math.sin(t * 0.4) * 0.22;
  r.head.rotation.x = Math.sin(t * 0.27) * 0.04;
  plant(r);
}

export function poseJump(root: THREE.Object3D, rising: boolean): void {
  const r = rig(root);
  rest(r);
  r.armL.rotation.x = rising ? -2.3 : -1.4;
  r.armR.rotation.x = rising ? -2.3 : -1.4;
  r.armL.rotation.z = -0.25;
  r.armR.rotation.z = 0.25;
  r.foreL.rotation.x = rising ? -0.2 : -0.5;
  r.foreR.rotation.x = rising ? -0.2 : -0.5;
  r.legL.rotation.x = rising ? -0.55 : -0.3;
  r.legR.rotation.x = rising ? 0.2 : -0.15;
  r.shinL.rotation.x = rising ? 1.0 : 0.55;
  r.shinR.rotation.x = rising ? 0.55 : 0.45;
  r.footL.rotation.x = 0.3;
  r.footR.rotation.x = 0.3;
  r.torso.rotation.x = rising ? -0.08 : 0.12;
  r.head.rotation.x = rising ? 0.05 : -0.1;
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
  r.footL.rotation.x = 0.1;
  r.footR.rotation.x = 0.1;
  r.torso.rotation.x = -0.1;
  r.armL.rotation.x = -1.05;
  r.armR.rotation.x = -1.05;
  r.armL.rotation.z = 0.22;
  r.armR.rotation.z = -0.22;
  r.foreL.rotation.x = -0.45;
  r.foreR.rotation.x = -0.45;
}

/**
 * Two joints in the side plane: the rotations that put the end of a limb
 * hung at (py, pz) on (ty, tz) - the middle joint bending forward like a
 * knee, or back like an elbow. Out of reach, the limb points straight at it.
 */
function reachFor(py: number, pz: number, ty: number, tz: number, l1: number, l2: number,
                  knee: boolean): [number, number] {
  const dy = ty - py, dz = tz - pz;
  const d = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, Math.hypot(dy, dz)));
  const line = Math.atan2(-dz, -dy);
  const off = Math.acos((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d));
  const bend = Math.PI - Math.acos((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2));
  return knee ? [line - off, bend] : [line + off, -bend];
}

/** Both hands on grips at (y, z), past a torso leaning `lean` forward. */
function gripBars(r: Rig, lean: number, y: number, z: number): void {
  const sy = r.hips.position.y + r.torso.position.y + SHOULDER * Math.cos(lean);
  const sz = r.hips.position.z + SHOULDER * Math.sin(lean);
  const [upper, fore] = reachFor(sy, sz, y, z, UPPER_ARM, FOREARM, false);
  for (const [a, f] of [[r.armL, r.foreL], [r.armR, r.foreR]]) {
    a.rotation.x = upper - lean;       // the arm hangs from the leaning torso
    f.rotation.x = fore;
  }
}

/** Where a bike's parts are, for the rider: see makeBike. */
const BIKE = { crankY: 0.32, crankZ: -0.06, crankR: 0.17, hipY: 0.97, hipZ: -0.27, gripY: 1.0, gripZ: 0.36 };
/** The ball of the foot, on the pedal, ahead of the ankle. */
const BALL = 0.12;

/** On the saddle, hands on the grips, each foot on its pedal round the crank. */
export function poseCycle(root: THREE.Object3D, phase: number, lean = 0.62): void {
  const r = rig(root);
  rest(r);
  r.hips.position.set(0, BIKE.hipY, BIKE.hipZ);
  r.torso.rotation.x = lean;
  r.head.rotation.x = -lean * 0.85;

  for (const [a, thigh, shin, foot] of [[phase, r.legL, r.shinL, r.footL],
                                        [phase + Math.PI, r.legR, r.shinR, r.footR]] as const) {
    // the pedal: top at a = 0, coming round forward
    const py = BIKE.crankY + BIKE.crankR * Math.cos(a) + 0.012;
    const pz = BIKE.crankZ + BIKE.crankR * Math.sin(a);
    // toes down a little, more as the pedal comes up behind
    const f = 0.18 - 0.22 * Math.sin(a);
    const ay = py + SOLE * Math.cos(f) + BALL * Math.sin(f);
    const az = pz + SOLE * Math.sin(f) - BALL * Math.cos(f);
    const [t, k] = reachFor(BIKE.hipY + LEG_Y, BIKE.hipZ, ay, az, THIGH, SHIN, true);
    thigh.rotation.x = t;
    shin.rotation.x = k;
    foot.rotation.x = f - t - k;
  }
  gripBars(r, lean, BIKE.gripY, BIKE.gripZ);
}

/** Deck height and grips of the e-scooter: see makeScooter. */
const SCOOTER = { deck: 0.19, gripY: 1.12, gripZ: 0.47 };

/** Standing on a deck, one foot forward, hands on the bars. */
export function poseScoot(root: THREE.Object3D, t: number): void {
  const r = rig(root);
  rest(r);
  const lean = 0.22;
  r.torso.rotation.x = lean;
  r.head.rotation.x = -lean * 0.7;
  r.legL.rotation.x = -0.2;
  r.legR.rotation.x = 0.24;
  r.shinL.rotation.x = 0.22;
  r.shinR.rotation.x = 0.18;
  r.footL.rotation.x = -0.02;
  r.footR.rotation.x = -0.42;
  r.hips.rotation.y = -0.22;
  r.torso.rotation.y = 0.16;
  r.head.rotation.y = 0.06;
  plant(r, SCOOTER.deck + Math.sin(t * 9) * 0.004);   // deck buzz
  gripBars(r, lean, SCOOTER.gripY, SCOOTER.gripZ);
}

/* --- rideables ----------------------------------------------------------- */

/**
 * A wheel that spins about X: a tyre, a rim and spokes in a group, so
 * turning the group's rotation.x rolls it. Its axle is the group's origin.
 */
function wheel(radius: number, tyre: number, spokes = 0): THREE.Group {
  const spin = new THREE.Group();
  const t = new THREE.Mesh(geo(`t${radius},${tyre}`, () =>
    new THREE.TorusGeometry(radius - tyre, tyre, 8, 28).rotateY(Math.PI / 2)), mat(0x16181d, 0.95));
  const rim = new THREE.Mesh(geo(`r${radius},${tyre}`, () =>
    new THREE.TorusGeometry(radius - tyre * 2.1, tyre * 0.35, 6, 28).rotateY(Math.PI / 2)), mat(0xc9ccd2, 0.35, { metalness: 0.8 }));
  const hub = new THREE.Mesh(geo(`h${radius}`, () =>
    new THREE.CylinderGeometry(radius * 0.16, radius * 0.16, tyre * 2.2, 10).rotateZ(Math.PI / 2)), mat(0x8d9199, 0.4, { metalness: 0.7 }));
  spin.add(t, rim, hub);
  const steel = mat(0xb9bdc4, 0.4, { metalness: 0.8 });
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI;
    const sp = rod({ x: 0, y: Math.cos(a) * (radius - tyre * 2), z: Math.sin(a) * (radius - tyre * 2) },
                   { x: 0, y: -Math.cos(a) * (radius - tyre * 2), z: -Math.sin(a) * (radius - tyre * 2) },
                   0.006, steel);
    spin.add(sp);
  }
  return spin;
}

export function makeBike(): THREE.Group {
  const g = new THREE.Group();
  const frame = mat(0x2e6f7d, 0.35, { metalness: 0.4 });
  const black = mat(0x1d1f26, 0.7);

  // Everything here points its front at +Z, matching makeHuman(), so a single
  // yaw drives rider and machine together. Building the bike facing -Z instead
  // left it rotated 180 degrees from the rider - handlebars trailing behind.
  const wf = wheel(0.34, 0.035, 8);
  const wr = wheel(0.34, 0.035, 8);
  wf.position.set(0, 0.34, 0.52);      // front
  wr.position.set(0, 0.34, -0.52);
  g.add(wf, wr);
  g.userData.wheels = [wf, wr];

  const rear = { x: 0, y: 0.34, z: -0.52 }, front = { x: 0, y: 0.34, z: 0.52 };
  const crank = { x: 0, y: BIKE.crankY, z: BIKE.crankZ };
  const seat = { x: 0, y: 0.82, z: -0.3 };
  const headTop = { x: 0, y: 0.88, z: 0.38 }, headLow = { x: 0, y: 0.68, z: 0.43 };
  const r = 0.022;
  g.add(
    rod(crank, seat, r, frame),                 // seat tube
    rod(crank, headLow, r * 1.15, frame),       // down tube
    rod(seat, headTop, r, frame),               // top tube
    rod(headLow, headTop, r * 1.3, frame),      // head tube
    rod(seat, { x: 0.05, y: rear.y, z: rear.z }, r * 0.7, frame),     // seat stays
    rod(seat, { x: -0.05, y: rear.y, z: rear.z }, r * 0.7, frame),
    rod(crank, { x: 0.05, y: rear.y, z: rear.z }, r * 0.7, frame),     // chain stays
    rod(crank, { x: -0.05, y: rear.y, z: rear.z }, r * 0.7, frame),
    rod(headLow, { x: 0.04, y: front.y, z: front.z }, r * 0.8, frame), // fork
    rod(headLow, { x: -0.04, y: front.y, z: front.z }, r * 0.8, frame),
    rod(headTop, { x: 0, y: BIKE.gripY, z: BIKE.gripZ }, r, black),   // stem, a city bike's riser
  );
  const chainring = new THREE.Mesh(geo('ring', () => new THREE.CylinderGeometry(0.09, 0.09, 0.02, 16).rotateZ(Math.PI / 2)),
                                   mat(0x9aa0a8, 0.35, { metalness: 0.8 }));
  chainring.position.set(0.05, crank.y, crank.z);
  g.add(chainring);
  // the cranks turn about X with the pedalling phase: the left arm up at 0
  const cranks = new THREE.Group();
  cranks.position.set(0, crank.y, crank.z);
  const steel = mat(0x9aa0a8, 0.35, { metalness: 0.8 });
  const pedal = mat(0x2a2c31, 0.7);
  for (const s of [-1, 1]) {
    const up = -s * BIKE.crankR;         // left (-X) up, right down
    cranks.add(rod({ x: s * 0.075, y: 0, z: 0 }, { x: s * 0.075, y: up, z: 0 }, 0.012, steel));
    const p = block(0.09, 0.022, 0.06, 0.008, pedal);
    p.position.set(s * 0.12, up, 0);
    cranks.add(p);
  }
  g.add(cranks);
  g.userData.crank = cranks;

  // out front, under the rider's hands
  const bars = rod({ x: -0.23, y: BIKE.gripY, z: BIKE.gripZ }, { x: 0.23, y: BIKE.gripY, z: BIKE.gripZ }, 0.016, black);
  g.add(bars);
  for (const s of [-1, 1]) {
    const grip = rod({ x: s * 0.17, y: BIKE.gripY, z: BIKE.gripZ }, { x: s * 0.25, y: BIKE.gripY, z: BIKE.gripZ },
                     0.024, mat(0x6b3d24, 0.9));
    g.add(grip);
  }
  const saddle = block(0.15, 0.06, 0.27, 0.03, mat(0x4a2e1f, 0.6));
  saddle.position.set(0, 0.88, -0.32);
  // a front lamp and a rear reflector
  const lamp = block(0.06, 0.06, 0.05, 0.02, mat(0xfff6d8, 0.3, { emissive: 0xfff2c0, emissiveIntensity: 0.6 }));
  lamp.position.set(0, 0.86, 0.47);
  const reflector = block(0.06, 0.04, 0.02, 0.01, mat(0xd8261c, 0.3, { emissive: 0x9a1208, emissiveIntensity: 0.5 }));
  reflector.position.set(0, 0.72, -0.48);
  g.add(saddle, lamp, reflector);
  return g;
}

export function makeScooter(): THREE.Group {
  const g = new THREE.Group();
  const body = mat(0x2a9d8f, 0.45, { metalness: 0.2 });
  const black = mat(0x1d1f26, 0.7);
  const alu = mat(0xc9ccd2, 0.35, { metalness: 0.8 });

  const wf = wheel(0.13, 0.04);
  const wr = wheel(0.13, 0.04);
  wf.position.set(0, 0.13, 0.44);      // front
  wr.position.set(0, 0.13, -0.44);
  g.add(wf, wr);
  g.userData.wheels = [wf, wr];

  const deck = block(0.2, 0.07, 0.84, 0.03, body);
  deck.position.set(0, 0.15, -0.02);
  const grip = block(0.17, 0.01, 0.7, 0.004, black);
  grip.position.set(0, 0.19, -0.04);
  const fender = block(0.1, 0.03, 0.22, 0.015, body);
  fender.position.set(0, 0.28, -0.46);
  fender.rotation.x = -0.25;
  // steering column ahead of the rider
  const gy = SCOOTER.gripY, gz = SCOOTER.gripZ;
  const neck = { x: 0, y: 0.2, z: 0.41 }, top = { x: 0, y: gy, z: gz };
  g.add(deck, grip, fender, rod(neck, top, 0.026, alu), rod({ x: 0, y: 0.13, z: 0.44 }, neck, 0.02, alu));
  g.add(rod({ x: -0.25, y: gy, z: gz }, { x: 0.25, y: gy, z: gz }, 0.017, alu));
  for (const s of [-1, 1]) {
    g.add(rod({ x: s * 0.18, y: gy, z: gz }, { x: s * 0.26, y: gy, z: gz }, 0.024, black));
  }
  const display = block(0.1, 0.03, 0.07, 0.01, black);
  display.position.set(0, gy + 0.02, gz - 0.01);
  const lamp = block(0.07, 0.05, 0.03, 0.015, mat(0xfff6d8, 0.3, { emissive: 0xfff2c0, emissiveIntensity: 0.7 }));
  lamp.position.set(0, gy - 0.11, gz + 0.03);
  const tail = block(0.07, 0.025, 0.02, 0.01, mat(0xd8261c, 0.3, { emissive: 0xc0180c, emissiveIntensity: 0.6 }));
  tail.position.set(0, 0.3, -0.56);
  g.add(display, lamp, tail);
  return g;
}

/** The cockpit's floor and the driver's bench, metres above the waterline. */
export const BOAT = { sole: 0.12, seatY: 0.78, seatZ: -0.7 };

/**
 * An open motorboat, bow at +Z, the waterline at y 0: a pointed hull, open
 * cockpit, windscreen, wheel, a bench and the outboard motor at the stern -
 * the boats hired out on the Spree. The hull is its plan extruded upward,
 * the cockpit a hole in the upper half.
 */
export function makeBoat(): THREE.Group {
  const g = new THREE.Group();
  const white = mat(0xf1efe8, 0.45);
  const blue = mat(0x1f4e79, 0.5);
  const teak = mat(0x9a6a3e, 0.7);
  const dark = mat(0x26292f, 0.5);
  const glass = mat(0x2b3a48, 0.08, { metalness: 0.6, transparent: true, opacity: 0.55 });

  // the plan, as THREE.Shape x and y, y towards the bow: turned a quarter
  // about X, y runs to +Z and the extrusion downwards from the top
  const plan = (inset: number) => {
    const w = 0.98 - inset, stern = -2.35 + inset, bow = 2.55 - inset * 1.6, shoulder = 0.7;
    const sh = new THREE.Shape();
    sh.moveTo(-w, stern);
    sh.lineTo(w, stern);
    sh.lineTo(w, shoulder);
    sh.quadraticCurveTo(w, bow - 0.6, 0, bow);
    sh.quadraticCurveTo(-w, bow - 0.6, -w, shoulder);
    sh.closePath();
    return sh;
  };
  const hull = (shape: THREE.Shape, y0: number, y1: number, m: THREE.Material, key: string) => {
    const mesh = new THREE.Mesh(geo(key, () => new THREE.ExtrudeGeometry(shape, {
      depth: y1 - y0, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2, curveSegments: 10,
    }).rotateX(Math.PI / 2).translate(0, y1, 0)), m);
    return mesh;
  };
  // below the rub rail: the painted bottom, narrower at the keel
  const bottom = hull(plan(0.08), -0.32, 0.06, blue, 'boat-bottom');
  // above it the topsides, open over the cockpit
  const top = plan(0);
  const cockpit = new THREE.Path();
  cockpit.moveTo(-0.8, -2.15);
  cockpit.lineTo(0.8, -2.15);
  cockpit.lineTo(0.8, 0.85);
  cockpit.quadraticCurveTo(0.8, 1.15, 0.5, 1.15);
  cockpit.lineTo(-0.5, 1.15);
  cockpit.quadraticCurveTo(-0.8, 1.15, -0.8, 0.85);
  cockpit.closePath();
  top.holes.push(cockpit);
  const sides = hull(top, 0.06, 0.52, white, 'boat-sides');
  // A lid over the cockpit that only writes depth, drawn after the boat and
  // before the water (WATER_ORDER): the river shows nowhere inside the hull,
  // however the boat pitches and rolls on it.
  const mask = new THREE.Mesh(geo('boat-mask', () => new THREE.ShapeGeometry(new THREE.Shape(cockpit.getPoints()))
    .rotateX(Math.PI / 2).translate(0, 0.55, 0)), new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
  mask.name = 'boat-mask';
  mask.renderOrder = WATER_ORDER - 1;
  const floor = block(1.6, 0.04, 3.25, 0.02, teak);
  floor.position.set(0, BOAT.sole, -0.5);
  g.add(bottom, sides, floor, mask);

  // the driver's bench, a console with the wheel ahead of it, the windscreen
  const bench = block(1.5, BOAT.seatY - BOAT.sole, 0.5, 0.05, teak);
  bench.position.set(0, (BOAT.seatY + BOAT.sole) / 2, BOAT.seatZ - 0.05);
  const console_ = block(0.55, 0.62, 0.42, 0.06, white);
  console_.position.set(0, BOAT.sole + 0.31, 0.12);
  const wheelRing = new THREE.Mesh(geo('boat-wheel', () => new THREE.TorusGeometry(0.17, 0.018, 6, 20)), dark);
  wheelRing.position.set(0, 0.88, -0.02);
  wheelRing.rotation.x = -0.5;
  const screen = block(1.5, 0.36, 0.03, 0.015, glass);
  screen.position.set(0, 0.7, 1.05);
  screen.rotation.x = -0.45;
  g.add(bench, console_, wheelRing, screen);

  // the outboard motor hung on the transom, its leg in the water
  const cowl = block(0.36, 0.42, 0.46, 0.1, dark);
  cowl.position.set(0, 0.72, -2.55);
  const cap = block(0.3, 0.06, 0.38, 0.03, white);
  cap.position.set(0, 0.95, -2.55);
  g.add(cowl, cap, rod({ x: 0, y: 0.52, z: -2.52 }, { x: 0, y: -0.45, z: -2.52 }, 0.05, dark));

  // navigation lights: red to port, green to starboard
  for (const [x, c] of [[0.62, 0xd8261c], [-0.62, 0x2fbf4a]] as const) {
    const lamp = block(0.06, 0.05, 0.1, 0.02, mat(c, 0.3, { emissive: c, emissiveIntensity: 0.9 }));
    lamp.position.set(x, 0.56, 1.5);
    g.add(lamp);
  }
  return g;
}

/** A small hatchback, nose at +Z: body, glass cabin, lights, bumpers. */
export function makeCar(): THREE.Group {
  const g = new THREE.Group();
  const paint = mat(0xd8503c, 0.3, { metalness: 0.35 });
  const glass = mat(0x1d2a3a, 0.08, { metalness: 0.7 });
  const trim = mat(0x22252c, 0.6);

  const lower = block(1.84, 0.62, 4.2, 0.2, paint);
  lower.position.y = 0.6;
  const cabin = block(1.62, 0.6, 2.25, 0.22, glass);
  cabin.position.set(0, 1.16, -0.25);
  const roof = block(1.36, 0.06, 1.7, 0.03, paint);
  roof.position.set(0, 1.44, -0.3);
  g.add(lower, cabin, roof);
  for (const z of [2.08, -2.08]) {
    const bumper = block(1.86, 0.2, 0.14, 0.07, trim);
    bumper.position.set(0, 0.38, z);
    g.add(bumper);
  }
  const head = mat(0xfff6e0, 0.2, { emissive: 0xfff0c8, emissiveIntensity: 0.8 });
  const tail = mat(0xc8201a, 0.3, { emissive: 0xa0100a, emissiveIntensity: 0.7 });
  for (const s of [-1, 1]) {
    const h = block(0.36, 0.13, 0.06, 0.04, head);
    h.position.set(s * 0.62, 0.74, 2.1);
    const tl = block(0.3, 0.12, 0.06, 0.04, tail);
    tl.position.set(s * 0.66, 0.78, -2.1);
    const mirror = block(0.16, 0.1, 0.08, 0.03, paint);
    mirror.position.set(s * 0.98, 1.0, 0.75);
    g.add(h, tl, mirror);
  }
  const plate = block(0.5, 0.12, 0.02, 0.01, mat(0xf2f2ee, 0.5));
  plate.position.set(0, 0.5, 2.16);
  const grille = block(0.8, 0.14, 0.04, 0.03, trim);
  grille.position.set(0, 0.62, 2.1);
  g.add(plate, grille);

  const wheels: THREE.Group[] = [];
  for (const [wx, wz] of [[-0.86, 1.4], [0.86, 1.4], [-0.86, -1.4], [0.86, -1.4]]) {
    const w = wheel(0.36, 0.11);
    w.position.set(wx, 0.36, wz);
    w.scale.set(2.2, 1, 1);         // a car tyre is wide
    wheels.push(w);
    g.add(w);
  }
  g.userData.wheels = wheels;
  return g;
}
