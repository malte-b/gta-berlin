import * as THREE from 'three';
import type { World } from './world';

const GRAVITY = 24.0;
const JUMP = 8.2;

// Turning on the keyboard, so the whole game is playable with one hand.
const TURN_RATE = 1.9;          // radians per second
const TURN_RATE_AIR = 1.5;
const PITCH_RATE = 1.4;         // R / F, so the mouse is optional entirely
const PITCH_MIN = -1.3;
const PITCH_MAX = 1.15;

// Look up past this and push forward, and you lift off. Landing happens on
// contact with the ground, which makes walking and flying one continuous
// thing rather than two modes behind a toggle.
const TAKEOFF_PITCH = 0.42;     // about 24 degrees above the horizon
const TAKEOFF_LIFT = 7.5;
const LAND_COOLDOWN = 0.5;      // stops an immediate re-launch on touchdown

/**
 * Movement modes.
 *
 * `nav` picks which mask in the navigation grid a mode is tested against: a
 * car needs the eroded drivable mask, while a person, a bike and a scooter all
 * fit anywhere you can stand. `stride` is how many metres of travel make one
 * full animation cycle, so limbs stay locked to the ground at any speed.
 */
export type Mode = 'foot' | 'bike' | 'scooter' | 'car';

export interface ModeConfig {
  label: string;
  cruise: number;
  sprint: number;
  nav: 'walk' | 'drive';
  stride: number;
  eye: number;
}

export const MODES: Record<Mode, ModeConfig> = {
  foot:    { label: 'on foot',   cruise: 4.4,  sprint: 9.0,  nav: 'walk',  stride: 1.62, eye: 1.72 },
  bike:    { label: 'on a bike', cruise: 6.8,  sprint: 13.5, nav: 'walk',  stride: 3.10, eye: 1.55 },
  scooter: { label: 'on an e-scooter', cruise: 6.2, sprint: 8.4, nav: 'walk', stride: 2.4, eye: 1.78 },
  car:     { label: 'driving',   cruise: 46.0, sprint: 46.0, nav: 'drive', stride: 4.0,  eye: 1.15 },
};

// the sleigh, metres per second and metres above the ground
const SLEIGH_SLOW = 22;
const SLEIGH_CRUISE = 40;
const SLEIGH_FAST = 65;
const SLEIGH_BOOST = 110;
const SLEIGH_FLOOR = 6;
const SLEIGH_CEILING = 450;

const CAR_ACCEL = 13.0;
const CAR_BRAKE = 22.0;
const CAR_REVERSE = -11.0;
const CAR_DRAG = 0.42;

// bikes and scooters roll rather than stopping dead
const RIDE_ACCEL = 9.0;
const RIDE_BRAKE = 12.0;
const RIDE_DRAG = 1.4;

export class Player {
  readonly world: World;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  pitch = -0.16;
  onGround = true;
  mode: Mode = 'foot';
  heading = 0;          // facing of a vehicle, independent of the camera
  speed = 0;            // scalar speed for vehicle modes
  camMode = 0;
  flying = false;
  launched = false;
  strideDist = 0;       // metres travelled, drives the animation phase
  lean = 0;
  takeoffCooldown = 0;
  justLanded = 0;
  /** Game modes: scales every top speed (Döner power, a full bladder). */
  speedScale = 1;
  /** Game modes that are played on the ground switch flight off. */
  canFly = true;
  /** Santa's sleigh: always airborne, always moving forward. */
  sleigh = false;
  sleighSpeed = 0;

  constructor(world: World) {
    this.world = world;
  }

  get cfg() { return MODES[this.mode]; }
  get inCar() { return this.mode === 'car'; }
  get riding() { return this.mode === 'bike' || this.mode === 'scooter'; }
  get vehicle() { return this.mode !== 'foot'; }
  get driving() { return this.cfg.nav === 'drive'; }

  get speedKmh() {
    if (this.sleigh) return this.sleighSpeed * 3.6;
    return this.vehicle
      ? Math.abs(this.speed) * 3.6
      : Math.hypot(this.vel.x, this.vel.z) * 3.6;
  }

  get stridePhase() { return (this.strideDist / this.cfg.stride) * Math.PI * 2; }

  spawn(x: number, z: number): void {
    const w = this.world;
    const [fx, fz] = w.freeSpot(x, z, 200, this.driving);
    this.pos.set(fx, w.height(fx, fz), fz);
    this.vel.set(0, 0, 0);
    this.speed = 0;
  }

  /**
   * Switch mode, relocating to ground the new mode can actually use.
   * A car needs the eroded drivable mask, so plenty of pavement you can stand
   * on is off limits to it - without the snap you change mode and find
   * yourself walled into a single square metre.
   */
  setMode(mode: string): Mode {
    if (!(mode in MODES)) return this.mode;
    this.mode = mode as Mode;
    this.flying = false;
    this.settle(140);
    this.heading = this.yaw;
    this.speed = 0;
    this.vel.set(0, 0, 0);
    return this.mode;
  }

  toggleMode(mode: Mode): Mode {
    return this.setMode(this.mode === mode ? 'foot' : mode);
  }

  private passable(x: number, z: number): boolean {
    return this.world.canStep(this.pos.x, this.pos.z, x, z, this.driving, this.pos.y);
  }

  /** Move to (nx, nz) if allowed, sliding along whichever axis is free. */
  private move(nx: number, nz: number): boolean {
    // The navigation grid already accounts for body clearance, so only a small
    // cross is probed here. Sampling a wide ring would re-introduce exactly the
    // invisible walls the grid exists to remove.
    const r = 0.4;
    const free = (x: number, z: number) => this.passable(x, z)
      && this.passable(x + r, z) && this.passable(x - r, z)
      && this.passable(x, z + r) && this.passable(x, z - r);
    if (free(nx, nz)) { this.pos.x = nx; this.pos.z = nz; return false; }
    if (free(nx, this.pos.z)) { this.pos.x = nx; return true; }
    if (free(this.pos.x, nz)) { this.pos.z = nz; return true; }
    return true;
  }

  /** Q and E turn left and right, in every mode. */
  private turnInput(keys: Set<string>): number {
    return (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);
  }

  /**
   * R and F tilt the view up and down.
   *
   * Together with Q/E this removes the mouse from the critical path: taking
   * off needs the view pitched at the sky, so without a keyboard equivalent
   * the one-handed scheme could turn and walk but never actually fly.
   * Clamped to the same limits the mouse look uses.
   */
  private pitchInput(keys: Set<string>, dt: number): void {
    const d = (keys.has('KeyR') ? 1 : 0) - (keys.has('KeyF') ? 1 : 0);
    if (!d) return;
    this.pitch = Math.max(PITCH_MIN,
      Math.min(PITCH_MAX, this.pitch + d * PITCH_RATE * dt));
  }

  update(dt: number, keys: Set<string>): void {
    if (this.takeoffCooldown > 0) this.takeoffCooldown -= dt;
    if (this.justLanded > 0) this.justLanded -= dt;
    this.pitchInput(keys, dt);
    if (this.sleigh) return this.updateSleigh(dt, keys);
    if (this.flying) return this.updateFly(dt, keys);
    if (this.vehicle) return this.updateVehicle(dt, keys);
    return this.updateFoot(dt, keys);
  }

  private updateFoot(dt: number, keys: Set<string>): void {
    const w = this.world;
    const cfg = this.cfg;
    this.yaw += this.turnInput(keys) * TURN_RATE * dt;

    // look to the sky and lean into it: take off
    if (this.canFly && this.pitch > TAKEOFF_PITCH && keys.has('KeyW') && this.takeoffCooldown <= 0) {
      this.flying = true;
      this.launched = true;
      this.vel.set(0, TAKEOFF_LIFT, 0);
      this.pos.y += 0.15;
      return;
    }

    let fx = 0, fz = 0;
    if (keys.has('KeyW')) fz -= 1;
    if (keys.has('KeyS')) fz += 1;
    if (keys.has('KeyA')) fx -= 1;
    if (keys.has('KeyD')) fx += 1;
    const len = Math.hypot(fx, fz);
    const speed = ((keys.has('ShiftLeft') || keys.has('ShiftRight'))
      ? cfg.sprint : cfg.cruise) * this.speedScale;

    let vx = 0, vz = 0;
    if (len > 0) {
      fx /= len; fz /= len;
      const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
      // camera sits at head + (sin, cos)*dist looking back, so forward is
      // (-sin, -cos) and right is (cos, -sin)
      vx = (fx * c + fz * s) * speed;
      vz = (fz * c - fx * s) * speed;
      this.heading = Math.atan2(-vx, -vz);
    }
    this.vel.x = vx;
    this.vel.z = vz;

    if (this.onGround && keys.has('Space')) {
      this.vel.y = JUMP;
      this.onGround = false;
    }
    this.vel.y -= GRAVITY * dt;

    const before = { x: this.pos.x, z: this.pos.z };
    this.move(this.pos.x + vx * dt, this.pos.z + vz * dt);
    this.strideDist += Math.hypot(this.pos.x - before.x, this.pos.z - before.z);
    this.pos.y += this.vel.y * dt;

    const g = w.height(this.pos.x, this.pos.z, this.pos.y);
    if (this.pos.y <= g) {
      this.pos.y = g;
      this.vel.y = 0;
      this.onGround = true;
    }
  }

  private updateVehicle(dt: number, keys: Set<string>): void {
    const w = this.world;
    const cfg = this.cfg;
    const car = this.mode === 'car';
    const accel = car ? CAR_ACCEL : RIDE_ACCEL;
    const brake = car ? CAR_BRAKE : RIDE_BRAKE;
    const drag = car ? CAR_DRAG * 12 : RIDE_DRAG * 3;
    const top = ((keys.has('ShiftLeft') || keys.has('ShiftRight'))
      ? cfg.sprint : cfg.cruise) * this.speedScale;
    const reverse = car ? CAR_REVERSE : -3.0;

    const throttle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    if (throttle > 0) this.speed += accel * dt;
    else if (throttle < 0) this.speed -= (this.speed > 0 ? brake : accel * 0.6) * dt;
    else this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), drag * dt);
    this.speed = Math.max(reverse, Math.min(top, this.speed));

    // steering authority falls off with speed so it stays controllable
    const grip = car ? 1 / (1 + Math.abs(this.speed) * 0.055)
                     : 1 / (1 + Math.abs(this.speed) * 0.030);
    const steer = Math.max(-1, Math.min(1,
      (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0) + this.turnInput(keys)));
    const rate = car ? 2.5 : 3.1;
    if (Math.abs(this.speed) > 0.2) {
      this.heading += steer * dt * rate * grip * Math.sign(this.speed);
    }
    // a bike leans into the turn; a car does not
    const wantLean = this.riding ? -steer * Math.min(0.45, Math.abs(this.speed) * 0.04) : 0;
    this.lean += (wantLean - this.lean) * Math.min(1, dt * 6);

    const dx = -Math.sin(this.heading) * this.speed * dt;
    const dz = -Math.cos(this.heading) * this.speed * dt;
    const hit = this.move(this.pos.x + dx, this.pos.z + dz);
    if (hit) this.speed *= car ? -0.22 : -0.12;

    this.strideDist += Math.abs(this.speed) * dt;
    this.pos.y = w.height(this.pos.x, this.pos.z, this.pos.y);
    this.yaw = this.heading;
    this.onGround = true;
  }

  private updateFly(dt: number, keys: Set<string>): void {
    this.yaw += this.turnInput(keys) * TURN_RATE_AIR * dt;
    const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const speed = fast ? 160 : 38;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const fwd = [-s * cp, sp, -c * cp];
    const right = [c, 0, -s];
    let dx = 0, dy = 0, dz = 0;
    if (keys.has('KeyW')) { dx += fwd[0]; dy += fwd[1]; dz += fwd[2]; }
    if (keys.has('KeyS')) { dx -= fwd[0]; dy -= fwd[1]; dz -= fwd[2]; }
    if (keys.has('KeyD')) { dx += right[0]; dz += right[2]; }
    if (keys.has('KeyA')) { dx -= right[0]; dz -= right[2]; }
    if (keys.has('Space')) dy += 1;
    if (keys.has('ControlLeft')) dy -= 1;
    const len = Math.hypot(dx, dy, dz);
    if (len > 0) {
      this.pos.x += (dx / len) * speed * dt;
      this.pos.y += (dy / len) * speed * dt;
      this.pos.z += (dz / len) * speed * dt;
    }

    // a short arc up out of the launch, so leaving the ground has some weight
    if (this.launched) {
      this.pos.y += this.vel.y * dt;
      this.vel.y -= GRAVITY * 0.35 * dt;
      if (this.vel.y <= 0) this.launched = false;
    }

    // touching the ground ends the flight; no toggle needed
    const g = this.world.height(this.pos.x, this.pos.z, this.pos.y);
    if (this.pos.y <= g + 0.05) {
      this.land();
    }
  }

  /**
   * The sleigh flies like a plane: it never stops, W and S trim the speed,
   * A/D (or Q/E, or the mouse) bank it round and the view's pitch is its
   * climb. It skims over the ground rather than landing.
   */
  private updateSleigh(dt: number, keys: Set<string>): void {
    const boost = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const want = boost ? SLEIGH_BOOST : keys.has('KeyW') ? SLEIGH_FAST
      : keys.has('KeyS') ? SLEIGH_SLOW : SLEIGH_CRUISE;
    this.sleighSpeed += (want - this.sleighSpeed) * Math.min(1, dt * 1.6);
    const steer = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0) + this.turnInput(keys);
    this.yaw += Math.max(-1, Math.min(1, steer)) * 1.25 * dt;
    this.lean += (-steer * 0.45 - this.lean) * Math.min(1, dt * 4);
    if (keys.has('Space')) this.pitch = Math.min(0.7, this.pitch + 0.9 * dt);
    if (keys.has('ControlLeft')) this.pitch = Math.max(-0.7, this.pitch - 0.9 * dt);
    this.pitch = Math.max(-0.7, Math.min(0.7, this.pitch));
    const cp = Math.cos(this.pitch);
    const v = this.sleighSpeed * dt;
    this.pos.x += -Math.sin(this.yaw) * cp * v;
    this.pos.z += -Math.cos(this.yaw) * cp * v;
    this.pos.y += Math.sin(this.pitch) * v;
    const g = this.world.height(this.pos.x, this.pos.z);
    if (this.pos.y < g + SLEIGH_FLOOR) {
      // skim off the ground and nose up a little
      this.pos.y = g + SLEIGH_FLOOR;
      if (this.pitch < 0.05) this.pitch += (0.05 - this.pitch) * Math.min(1, dt * 3);
    }
    this.pos.y = Math.min(this.pos.y, g + SLEIGH_CEILING);
    this.heading = this.yaw;
    this.strideDist += v;
    this.vel.set(0, 0, 0);
  }

  /** Board the sleigh at a safe height, or step off it. */
  setSleigh(on: boolean): void {
    this.sleigh = on;
    this.flying = false;
    if (on) {
      this.mode = 'foot';
      this.sleighSpeed = SLEIGH_CRUISE;
      this.pitch = 0.05;
      this.pos.y = Math.max(this.pos.y, this.world.height(this.pos.x, this.pos.z) + 60);
    } else {
      this.lean = 0;
      this.settle(200);
    }
  }

  /** Put the player back on their feet wherever they came down. */
  land(): void {
    this.flying = false;
    this.launched = false;
    this.takeoffCooldown = LAND_COOLDOWN;
    this.justLanded = 0.9;
    this.settle(60);
    this.vel.set(0, 0, 0);
    this.onGround = true;
    // level the view off so you are not left staring at the sky
    if (this.pitch > 0.1) this.pitch = 0.1;
  }

  toggleFly(): boolean {
    if (!this.canFly && !this.flying) return false;
    this.flying = !this.flying;
    if (this.flying) {
      this.launched = false;
      this.pos.y = Math.max(this.pos.y, this.world.height(this.pos.x, this.pos.z) + 40);
    } else {
      this.settle(200);
    }
    return this.flying;
  }

  /**
   * Come to rest on whatever is below: a bridge deck where you are over one
   * (one a car can use, when driving), otherwise the nearest ground the
   * current mode can use, up to maxR metres away.
   */
  private settle(maxR: number): void {
    const w = this.world;
    const y = w.height(this.pos.x, this.pos.z, this.pos.y);
    const deck = w.deckAt(this.pos.x, this.pos.z, y, this.driving ? 1.0 : 0.3);
    if (deck && (!this.driving || deck.kind !== 'path')) {
      this.pos.y = y;
      return;
    }
    const spot = w.nav.nearestPassable(this.pos.x, this.pos.z, this.driving, maxR);
    if (spot) { this.pos.x = spot[0]; this.pos.z = spot[1]; }
    this.pos.y = w.height(this.pos.x, this.pos.z);
  }

  applyCamera(cam: THREE.PerspectiveCamera): THREE.Vector3 {
    if (this.sleigh) {
      // a chase camera behind and above the reindeer
      const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
      const at = new THREE.Vector3(this.pos.x - s * 6, this.pos.y + 2, this.pos.z - c * 6);
      const back = this.camMode === 1 ? 11 : 17;
      cam.position.set(this.pos.x + s * back, this.pos.y + 5.5 - Math.sin(this.pitch) * back,
                       this.pos.z + c * back);
      cam.lookAt(at);
      return at;
    }
    if (this.flying) {
      cam.position.set(this.pos.x, this.pos.y, this.pos.z);
      cam.rotation.set(0, 0, 0);
      cam.rotateY(this.yaw);
      cam.rotateX(this.pitch);
      return cam.position.clone();
    }
    const eye = this.cfg.eye;
    const head = new THREE.Vector3(this.pos.x, this.pos.y + eye, this.pos.z);

    if (this.camMode === 2) {
      cam.position.copy(head);
      cam.rotation.set(0, 0, 0);
      cam.rotateY(this.yaw);
      cam.rotateX(this.pitch);
      return head;
    }
    // A true orbit: the camera sits on a sphere of fixed radius around the
    // player, and pitch only moves it along that sphere. The previous version
    // added a constant `lift` on top of a spherical offset, which is not a
    // sphere at all - the distance to the player swung by 137% between looking
    // up and looking down, so tilting felt like zooming. There is no separate
    // lift now; the camera sitting above the shoulder simply falls out of the
    // slightly downward resting pitch.
    const w = this.world;
    const radius = this.camMode === 0
      ? (this.mode === 'car' ? 11.5 : (this.riding ? 7.4 : 6.4))
      : 3.4;
    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * cp,
      -Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    );

    // Camera collision shortens the boom instead of lifting the camera.
    // Raising it would change the view angle, which is exactly the coupling
    // this rewrite is removing.
    let r = radius;
    const probe = new THREE.Vector3();
    for (let i = 0; i < 10; i++) {
      probe.copy(head).addScaledVector(dir, r);
      if (!w.blocksCamera(probe.x, probe.y, probe.z)) break;
      r *= 0.78;
      if (r < 1.4) { r = 1.4; break; }
    }

    // Orientation is never set directly - it is always derived from lookAt, the
    // same way a real spring-arm camera works. Whatever the collision loop did
    // to the radius, the camera still ends up pointed exactly at the player;
    // position and orientation can never disagree, which is what setting
    // rotation from raw pitch independently of position broke last time.
    cam.position.copy(head).addScaledVector(dir, r);
    cam.lookAt(head);
    return head;
  }
}
