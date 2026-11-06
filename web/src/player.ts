import * as THREE from 'three';
import { DRIVE_INSET, WALK_INSET, type World } from './world';

const GRAVITY = 24.0;
const JUMP = 8.2;
/** On foot with a touch joystick: a walk at the least push, the jog of
 *  cruise when pushed this far, from STICK_WALK up. */
const WALK = 1.5;
const STICK_WALK = 0.3;
const STICK_JOG = 0.8;

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
 * fit anywhere you can stand. A boat needs neither: it floats on the water
 * (World.navigable). `stride` is how many metres of travel make one
 * full animation cycle, so limbs stay locked to the ground at any speed. On
 * foot that is the stride of a walk: a run's is longer, so the steps do not
 * turn into a blur (see updateFoot).
 */
export type Mode = 'foot' | 'bike' | 'scooter' | 'car' | 'boat';

export interface ModeConfig {
  label: string;
  cruise: number;
  sprint: number;
  nav: 'walk' | 'drive' | 'water';
  stride: number;
  eye: number;
}

export const MODES: Record<Mode, ModeConfig> = {
  foot:    { label: 'on foot',   cruise: 4.4,  sprint: 9.0,  nav: 'walk',  stride: 1.62, eye: 1.72 },
  bike:    { label: 'on a bike', cruise: 6.8,  sprint: 13.5, nav: 'walk',  stride: 3.10, eye: 1.55 },
  scooter: { label: 'on an e-scooter', cruise: 6.2, sprint: 8.4, nav: 'walk', stride: 2.4, eye: 1.78 },
  car:     { label: 'driving',   cruise: 46.0, sprint: 46.0, nav: 'drive', stride: 4.0,  eye: 1.15 },
  boat:    { label: 'by boat',   cruise: 9.0,  sprint: 15.0, nav: 'water', stride: 4.0,  eye: 1.4 },
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

// a motorboat: slow to get going, it keeps sliding through a turn and steers
// by its rudder, so hardly at all at rest
const BOAT_ACCEL = 3.2;
const BOAT_BRAKE = 4.5;
const BOAT_REVERSE = -3.0;
const BOAT_DRAG = 1.1;
const BOAT_TURN = 1.15;         // radians per second, at full rudder authority
const BOAT_GRIP = 2.2;          // how fast the motion follows the bow, per second
/** Where boarding looks for water, metres. */
const BOAT_REACH = 250;
/** Points of the hull, metres [ahead, to the right]: all of them on water. */
const HULL: [number, number][] = [[2.5, 0], [1.4, -0.7], [1.4, 0.7], [0, -0.95], [0, 0.95],
                                  [-2.3, -0.85], [-2.3, 0.85]];

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
  private footPhase = 0; // on foot, the phase itself: the stride grows with speed
  private boomDistance: number | null = null;
  /**
   * How far a touch joystick is pushed, 0 to 1, or null with keys. On foot
   * it sets the pace: a little walks, more jogs, the edge (which also holds
   * Shift) sprints.
   */
  stick: number | null = null;
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
  get boating() { return this.mode === 'boat'; }
  get driving() { return this.cfg.nav === 'drive'; }

  get speedKmh() {
    if (this.sleigh) return this.sleighSpeed * 3.6;
    return this.vehicle
      ? Math.abs(this.speed) * 3.6
      : Math.hypot(this.vel.x, this.vel.z) * 3.6;
  }

  get stridePhase() {
    return this.mode === 'foot' ? this.footPhase : (this.strideDist / this.cfg.stride) * Math.PI * 2;
  }

  spawn(x: number, z: number): void {
    const w = this.world;
    if (this.boating) {
      this.pos.set(x, w.height(x, z), z);
      this.vel.set(0, 0, 0);
      this.speed = 0;
      this.settle(BOAT_REACH);
      return;
    }
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
    // a boat needs water to float on: none near, no boat
    if (mode === 'boat' && !this.canBoat()) return this.mode;
    this.mode = mode as Mode;
    this.flying = false;
    this.heading = this.yaw;
    this.settle(this.boating ? BOAT_REACH : 140);
    this.speed = 0;
    this.vel.set(0, 0, 0);
    return this.mode;
  }

  /** Is there water near enough to take a boat out on? */
  canBoat(): boolean {
    return this.boatSpot(BOAT_REACH) !== null;
  }

  /** The nearest water within maxR the hull fits on, and a heading it fits
   *  at: across a narrow canal, along it. */
  private boatSpot(maxR: number): [number, number, number] | null {
    let heading = this.heading;
    const fits = (x: number, z: number) => {
      for (let i = 0; i < 8; i++) {
        heading = this.heading + i * Math.PI / 4;
        if (this.afloat(x, z, heading)) return true;
      }
      return false;
    };
    const at = this.world.nearestWater(this.pos.x, this.pos.z, maxR, fits);
    return at && [at[0], at[1], heading];
  }

  toggleMode(mode: Mode): Mode {
    return this.setMode(this.mode === mode ? 'foot' : mode);
  }

  private passable(x: number, z: number): boolean {
    return this.world.canStep(this.pos.x, this.pos.z, x, z, this.driving, this.pos.y);
  }

  /** Move to (nx, nz) if allowed, sliding along whichever axis is free. */
  private move(nx: number, nz: number): boolean {
    // In half-metre steps: fast in a game, on a slow phone frame, one jump
    // could clear a thin wall of the 1 m grid.
    const dx = nx - this.pos.x, dz = nz - this.pos.z;
    const n = Math.ceil(Math.hypot(dx, dz) / 0.5);
    if (n <= 1) return this.step(nx, nz);
    let hit = false;
    for (let i = 0; i < n; i++) hit = this.step(this.pos.x + dx / n, this.pos.z + dz / n) || hit;
    return hit;
  }

  private step(nx: number, nz: number): boolean {
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
    if (this.boating) return this.updateBoat(dt, keys);
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
    const sprinting = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const pace = sprinting ? cfg.sprint
      : this.stick === null ? cfg.cruise
      : WALK + (cfg.cruise - WALK) * Math.min(1, Math.max(0, (this.stick - STICK_WALK) / (STICK_JOG - STICK_WALK)));
    const speed = pace * this.speedScale;

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
    const moved = Math.hypot(this.pos.x - before.x, this.pos.z - before.z);
    this.strideDist += moved;
    // people lengthen their stride as they speed up: 1.6 m a cycle walking,
    // about 2.9 m at a jog (cruise), 4.8 m flat out - two to three steps a
    // second instead of five to eleven on one fixed stride
    this.footPhase += moved / (cfg.stride * (0.62 + 0.26 * Math.hypot(vx, vz))) * Math.PI * 2;
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

  /** Does the whole hull float on the same water, the bow pointing along heading? */
  private afloat(x: number, z: number, heading = this.heading, level?: number): boolean {
    const w = this.world;
    const y = level ?? w.waterAt(x, z);
    if (y === null) return false;
    // forward is (-sin, -cos), right is (cos, -sin)
    const s = Math.sin(heading), c = Math.cos(heading);
    return HULL.every(([f, r]) => w.navigable(x - s * f + c * r, z - c * f - s * r, y));
  }

  private updateBoat(dt: number, keys: Set<string>): void {
    const w = this.world;
    const cfg = this.cfg;
    const level = w.waterAt(this.pos.x, this.pos.z) ?? this.pos.y;
    const top = ((keys.has('ShiftLeft') || keys.has('ShiftRight')) ? cfg.sprint : cfg.cruise) * this.speedScale;
    const throttle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    if (throttle > 0) this.speed += BOAT_ACCEL * dt;
    else if (throttle < 0) this.speed -= (this.speed > 0 ? BOAT_BRAKE : BOAT_ACCEL * 0.5) * dt;
    else this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), BOAT_DRAG * dt);
    this.speed = Math.max(BOAT_REVERSE, Math.min(top, this.speed));

    const steer = Math.max(-1, Math.min(1,
      (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0) + this.turnInput(keys)));
    const v = Math.abs(this.speed);
    const authority = Math.min(1, 0.2 + v / 3) / (1 + v * 0.04);
    const heading = this.heading + steer * dt * BOAT_TURN * authority * (this.speed < -0.1 ? -1 : 1);
    // a turn into the bank does not happen; pinned against it, the boat backs
    // off a few centimetres as it comes round, so the rudder frees it
    if (heading !== this.heading) {
      const s = Math.sin(heading), c = Math.cos(heading);
      for (const back of [0, 0.04, 0.1, 0.2]) {
        const x = this.pos.x + s * back, z = this.pos.z + c * back;
        if (this.afloat(x, z, heading, level)) {
          this.heading = heading;
          this.pos.x = x;
          this.pos.z = z;
          break;
        }
      }
    }
    this.lean += (-steer * Math.min(0.12, v * 0.012) - this.lean) * Math.min(1, dt * 3);

    // the hull's motion follows its bow only gradually: it drifts
    const k = 1 - Math.exp(-BOAT_GRIP * dt);
    this.vel.x += (-Math.sin(this.heading) * this.speed - this.vel.x) * k;
    this.vel.z += (-Math.cos(this.heading) * this.speed - this.vel.z) * k;
    this.vel.y = 0;

    // half-metre steps, sliding along a bank like everything else does
    const dx = this.vel.x * dt, dz = this.vel.z * dt;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.5));
    let hit = false;
    for (let i = 0; i < n; i++) {
      const nx = this.pos.x + dx / n, nz = this.pos.z + dz / n;
      if (this.afloat(nx, nz, this.heading, level)) { this.pos.x = nx; this.pos.z = nz; continue; }
      hit = true;
      if (this.afloat(nx, this.pos.z, this.heading, level)) { this.pos.x = nx; this.vel.z = 0; continue; }
      if (this.afloat(this.pos.x, nz, this.heading, level)) { this.pos.z = nz; this.vel.x = 0; continue; }
      // head on into the bank: a bump back
      this.vel.set(0, 0, 0);
      this.speed *= -0.25;
      break;
    }
    if (hit) this.speed *= Math.pow(0.15, dt * 4);

    this.strideDist += v * dt;
    this.pos.y = w.waterAt(this.pos.x, this.pos.z) ?? level;
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
    const want = (boost ? SLEIGH_BOOST : keys.has('KeyW') ? SLEIGH_FAST
      : keys.has('KeyS') ? SLEIGH_SLOW : SLEIGH_CRUISE) * this.speedScale;
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
    this.settle(60, false);
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
   * current mode can use, up to maxR metres away. Unless `open` is false -
   * a landing, aimed by the player - that ground has to lead out of the
   * block: switching vehicles must not leave you walled into a courtyard.
   */
  private settle(maxR: number, open = true): void {
    const w = this.world;
    if (this.boating) {
      const at = this.boatSpot(maxR);
      if (at) {
        this.pos.set(at[0], w.waterAt(at[0], at[1])!, at[1]);
        this.heading = this.yaw = at[2];
        this.vel.set(0, 0, 0);
        return;
      }
      // come down away from the water: on foot again
      this.mode = 'foot';
    }
    const y = w.height(this.pos.x, this.pos.z, this.pos.y);
    if (w.deckAt(this.pos.x, this.pos.z, y, this.driving ? DRIVE_INSET : WALK_INSET, this.driving)) {
      this.pos.y = y;
      return;
    }
    const spot = open ? w.freeSpot(this.pos.x, this.pos.z, maxR, this.driving)
      : w.nav.nearestPassable(this.pos.x, this.pos.z, this.driving, maxR);
    if (spot) { this.pos.x = spot[0]; this.pos.z = spot[1]; }
    this.pos.y = w.height(this.pos.x, this.pos.z);
  }

  applyCamera(cam: THREE.PerspectiveCamera, dt = 1 / 60): THREE.Vector3 {
    if (this.sleigh) {
      this.boomDistance = null;
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
      this.boomDistance = null;
      cam.position.set(this.pos.x, this.pos.y, this.pos.z);
      cam.rotation.set(0, 0, 0);
      cam.rotateY(this.yaw);
      cam.rotateX(this.pitch);
      return cam.position.clone();
    }
    const eye = this.cfg.eye;
    const head = new THREE.Vector3(this.pos.x, this.pos.y + eye, this.pos.z);

    if (this.camMode === 2) {
      this.boomDistance = null;
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
      ? (this.mode === 'car' ? 11.5 : this.boating ? 10.5 : (this.riding ? 7.4 : 6.4))
      : 3.4;
    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * cp,
      -Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    );

    // Sweep the whole boom: testing only its endpoint lets it pass through
    // an elevated deck and emerge above it while the player stays below.
    let r = radius;
    const probe = new THREE.Vector3();
    for (let distance = 0.4; distance <= radius + 0.35; distance += 0.35) {
      const d = Math.min(distance, radius);
      probe.copy(head).addScaledVector(dir, d);
      if (w.blocksCamera(probe.x, probe.y, probe.z)) {
        r = Math.max(0.35, d - 0.3);
        break;
      }
      if (d === radius) break;
    }
    // Pull in immediately for clearance; ease back out after leaving a span.
    const previous = this.boomDistance ?? r;
    r = r <= previous ? r : previous + (r - previous) * (1 - Math.exp(-12 * dt));
    this.boomDistance = r;

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
