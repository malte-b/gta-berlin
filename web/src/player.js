import * as THREE from 'three';

const GRAVITY = 24.0;
const JUMP = 8.2;
const EYE = 1.72;

/**
 * Movement modes.
 *
 * `nav` picks which mask in the navigation grid a mode is tested against: a
 * car needs the eroded drivable mask, while a person, a bike and a scooter all
 * fit anywhere you can stand. `stride` is how many metres of travel make one
 * full animation cycle, so limbs stay locked to the ground at any speed.
 */
export const MODES = {
  foot:    { label: 'on foot',   cruise: 4.4,  sprint: 9.0,  nav: 'walk',  stride: 1.62, eye: 1.72 },
  bike:    { label: 'on a bike', cruise: 6.8,  sprint: 13.5, nav: 'walk',  stride: 3.10, eye: 1.55 },
  scooter: { label: 'on an e-scooter', cruise: 6.2, sprint: 8.4, nav: 'walk', stride: 2.4, eye: 1.78 },
  car:     { label: 'driving',   cruise: 46.0, sprint: 46.0, nav: 'drive', stride: 4.0,  eye: 1.15 },
};

const CAR_ACCEL = 13.0;
const CAR_BRAKE = 22.0;
const CAR_REVERSE = -11.0;
const CAR_DRAG = 0.42;

// bikes and scooters roll rather than stopping dead
const RIDE_ACCEL = 9.0;
const RIDE_BRAKE = 12.0;
const RIDE_DRAG = 1.4;

export class Player {
  constructor(world) {
    this.world = world;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.16;
    this.onGround = true;
    this.mode = 'foot';
    this.heading = 0;          // facing of a vehicle, independent of the camera
    this.speed = 0;            // scalar speed for vehicle modes
    this.camMode = 0;
    this.flying = false;
    this.strideDist = 0;       // metres travelled, drives the animation phase
    this.lean = 0;
  }

  get cfg() { return MODES[this.mode]; }
  get inCar() { return this.mode === 'car'; }
  get riding() { return this.mode === 'bike' || this.mode === 'scooter'; }
  get vehicle() { return this.mode !== 'foot'; }
  get driving() { return this.cfg.nav === 'drive'; }

  get speedKmh() {
    return this.vehicle
      ? Math.abs(this.speed) * 3.6
      : Math.hypot(this.vel.x, this.vel.z) * 3.6;
  }

  get stridePhase() { return (this.strideDist / this.cfg.stride) * Math.PI * 2; }

  spawn(x, z) {
    const w = this.world;
    const [fx, fz] = w.nav ? w.freeSpot(x, z, 200, this.driving)
                           : (w.streetLevel ? w.streetLevel(x, z) : w.freeSpot(x, z));
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
  setMode(mode) {
    if (!MODES[mode]) return this.mode;
    this.mode = mode;
    this.flying = false;
    const w = this.world;
    if (w.nav) {
      const spot = w.nav.nearestPassable(this.pos.x, this.pos.z, this.driving, 140);
      if (spot) {
        this.pos.x = spot[0];
        this.pos.z = spot[1];
      }
    }
    this.pos.y = w.height(this.pos.x, this.pos.z);
    this.heading = this.yaw;
    this.speed = 0;
    this.vel.set(0, 0, 0);
    return this.mode;
  }

  toggleMode(mode) {
    return this.setMode(this.mode === mode ? 'foot' : mode);
  }

  _passable(x, z) {
    const w = this.world;
    return w.canStep ? w.canStep(this.pos.x, this.pos.z, x, z, this.driving)
                     : !w.solid(x, z);
  }

  /** Move to (nx, nz) if allowed, sliding along whichever axis is free. */
  _move(nx, nz) {
    // The navigation grid already accounts for body clearance, so only a small
    // cross is probed here. Sampling a wide ring would re-introduce exactly the
    // invisible walls the grid exists to remove.
    const r = 0.4;
    const free = (x, z) => this._passable(x, z)
      && this._passable(x + r, z) && this._passable(x - r, z)
      && this._passable(x, z + r) && this._passable(x, z - r);
    if (free(nx, nz)) { this.pos.x = nx; this.pos.z = nz; return false; }
    if (free(nx, this.pos.z)) { this.pos.x = nx; return true; }
    if (free(this.pos.x, nz)) { this.pos.z = nz; return true; }
    return true;
  }

  update(dt, keys) {
    if (this.flying) return this._updateFly(dt, keys);
    if (this.vehicle) return this._updateVehicle(dt, keys);
    return this._updateFoot(dt, keys);
  }

  _updateFoot(dt, keys) {
    const w = this.world;
    const cfg = this.cfg;
    let fx = 0, fz = 0;
    if (keys.has('KeyW')) fz -= 1;
    if (keys.has('KeyS')) fz += 1;
    if (keys.has('KeyA')) fx -= 1;
    if (keys.has('KeyD')) fx += 1;
    const len = Math.hypot(fx, fz);
    const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight'))
      ? cfg.sprint : cfg.cruise;

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
    this._move(this.pos.x + vx * dt, this.pos.z + vz * dt);
    this.strideDist += Math.hypot(this.pos.x - before.x, this.pos.z - before.z);
    this.pos.y += this.vel.y * dt;

    const g = w.height(this.pos.x, this.pos.z);
    if (this.pos.y <= g) {
      this.pos.y = g;
      this.vel.y = 0;
      this.onGround = true;
    }
  }

  _updateVehicle(dt, keys) {
    const w = this.world;
    const cfg = this.cfg;
    const car = this.mode === 'car';
    const accel = car ? CAR_ACCEL : RIDE_ACCEL;
    const brake = car ? CAR_BRAKE : RIDE_BRAKE;
    const drag = car ? CAR_DRAG * 12 : RIDE_DRAG * 3;
    const top = (keys.has('ShiftLeft') || keys.has('ShiftRight'))
      ? cfg.sprint : cfg.cruise;
    const reverse = car ? CAR_REVERSE : -3.0;

    const throttle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    if (throttle > 0) this.speed += accel * dt;
    else if (throttle < 0) this.speed -= (this.speed > 0 ? brake : accel * 0.6) * dt;
    else this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), drag * dt);
    this.speed = Math.max(reverse, Math.min(top, this.speed));

    // steering authority falls off with speed so it stays controllable
    const grip = car ? 1 / (1 + Math.abs(this.speed) * 0.055)
                     : 1 / (1 + Math.abs(this.speed) * 0.030);
    const steer = (keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0);
    const rate = car ? 2.5 : 3.1;
    if (Math.abs(this.speed) > 0.2) {
      this.heading += steer * dt * rate * grip * Math.sign(this.speed);
    }
    // a bike leans into the turn; a car does not
    const wantLean = this.riding ? -steer * Math.min(0.45, Math.abs(this.speed) * 0.04) : 0;
    this.lean += (wantLean - this.lean) * Math.min(1, dt * 6);

    const dx = -Math.sin(this.heading) * this.speed * dt;
    const dz = -Math.cos(this.heading) * this.speed * dt;
    const hit = this._move(this.pos.x + dx, this.pos.z + dz);
    if (hit) this.speed *= car ? -0.22 : -0.12;

    this.strideDist += Math.abs(this.speed) * dt;
    this.pos.y = w.height(this.pos.x, this.pos.z);
    this.yaw = this.heading;
    this.onGround = true;
  }

  _updateFly(dt, keys) {
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
    this.vel.set(0, 0, 0);
  }

  toggleFly() {
    this.flying = !this.flying;
    if (this.flying) {
      this.pos.y = Math.max(this.pos.y, this.world.height(this.pos.x, this.pos.z) + 40);
    } else {
      const w = this.world;
      const spot = w.nav && w.nav.nearestPassable(this.pos.x, this.pos.z, this.driving, 200);
      if (spot) { this.pos.x = spot[0]; this.pos.z = spot[1]; }
      this.pos.y = w.height(this.pos.x, this.pos.z);
    }
    return this.flying;
  }

  applyCamera(cam) {
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
    const far = this.mode === 'car' ? 11.5 : (this.riding ? 7.4 : 6.4);
    const dist = this.camMode === 0 ? far : 3.4;
    const lift = this.camMode === 0 ? (this.mode === 'car' ? 3.9 : 2.6) : 1.5;
    const cp = Math.cos(this.pitch);
    const want = new THREE.Vector3(
      head.x + Math.sin(this.yaw) * dist * cp,
      head.y + lift - Math.sin(this.pitch) * dist,
      head.z + Math.cos(this.yaw) * dist * cp,
    );
    const w = this.world;
    if (w.height(want.x, want.z) > head.y + 0.5) {
      const t = 0.45;
      want.set(head.x + (want.x - head.x) * t, want.y, head.z + (want.z - head.z) * t);
    }
    const floor = w.height(want.x, want.z) + 1.6;
    if (want.y < floor) want.y = floor;
    cam.position.copy(want);
    cam.lookAt(head.x, head.y + 0.3, head.z);
    return head;
  }
}
